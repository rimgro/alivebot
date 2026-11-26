/**
 * `alive telegram login | logout | user-status` — the human side of the
 * personal Telegram account (#248, step B).
 *
 * The commands are plain functions taking a {@link TelegramUserCliOptions}
 * object: the config, the environment, the output writers, a prompter and — most
 * importantly — a client factory. Tests inject a fake factory and a fake
 * prompter, so the whole flow runs without a network, a phone number or GramJS;
 * the CLI passes nothing and gets the real {@link createGramJsClient}.
 *
 * Rules that hold for every command here:
 *
 *  - the login code, the 2FA password and the `api_hash` never appear in the
 *    output, in arguments or in a saved file — the code and password are read
 *    without echo, and every printed error is scrubbed with `redactSecrets`,
 *  - `login` refuses to run without a TTY instead of reading stdin from a pipe
 *    or a script,
 *  - `user-status` never touches the network and never reads the session
 *    content: `present`/`bytes`/`mtime` come from `UserSessionStore.describe()`,
 *  - `logout` always removes the local session and identity, even when the
 *    server-side logOut fails, and says so.
 */
import * as readline from "node:readline";
import type { LoadedConfig } from "../../../config.js";
import { resolveUserApiHash, resolveUserSessionFile, telegramUserReadiness, type TelegramUserConfig } from "./config.js";
import {
	createGramJsClient,
	isTelegramUserError,
	redactSecrets,
	type TelegramUserClientFactory,
	type TelegramUserIdentity,
} from "./client.js";
import { TelegramUserIdentityStore, identityFileForSession, type TelegramUserIdentityRecord } from "./identity.js";
import { UserSessionStore } from "./session-store.js";

/** Interactive input used by `login`; injectable so tests never touch a TTY. */
export interface TelegramUserPrompter {
	askPhoneNumber(): Promise<string>;
	askCode(isCodeViaApp?: boolean): Promise<string>;
	askPassword(hint?: string): Promise<string>;
}

export interface TelegramUserCliOptions {
	config: LoadedConfig;
	/** Environment holding `api_hash`; defaults to `process.env`. */
	env?: NodeJS.ProcessEnv;
	/** Line writers; default to `process.stdout`/`process.stderr`. */
	out?: (line: string) => void;
	err?: (line: string) => void;
	/** Whether a human terminal is attached; defaults to `process.stdin.isTTY`. */
	interactive?: boolean;
	/** Prompt source; defaults to the real terminal. */
	prompt?: TelegramUserPrompter;
	/** Client factory; defaults to {@link createGramJsClient}. */
	createClient?: TelegramUserClientFactory;
	/** Clock for `loggedInAt`; defaults to `new Date()`. */
	now?: () => Date;
	/** `user-status --json`: machine-readable output. */
	json?: boolean;
}

/** The real factory, named so the CLI reads like the tests. */
export const defaultTelegramUserClientFactory: TelegramUserClientFactory = (options) => createGramJsClient(options);

/** Fallback block when `modules.telegram.user` is absent: only the paths matter. */
const DISABLED_USER_CONFIG: TelegramUserConfig = { enabled: false, allowedChatIds: [] };

function writer(stream: NodeJS.WriteStream): (line: string) => void {
	return (line) => stream.write(`${line}\n`);
}

function identityLabel(identity: TelegramUserIdentity): string {
	if (identity.username) return `@${identity.username}`;
	if (identity.firstName) return `${identity.firstName} (id ${identity.id})`;
	return `id ${identity.id}`;
}

/** One line, bounded, and with every known secret replaced. */
function describeFailure(error: unknown, secrets: readonly (string | undefined)[]): string {
	if (isTelegramUserError(error)) return error.message;
	const raw = redactSecrets(error instanceof Error ? error.message : String(error), secrets).replace(/\s+/g, " ").trim();
	if (!raw) return "неизвестная ошибка";
	return raw.length > 200 ? `${raw.slice(0, 199)}…` : raw;
}

/** Disconnect without letting cleanup mask the error already being reported. */
async function safeDisconnect(client: { disconnect(): Promise<void> }): Promise<void> {
	try {
		await client.disconnect();
	} catch {
		// The login/logout error is the one worth reporting.
	}
}

/**
 * `alive telegram login`.
 *
 * Refuses loudly (exit 1, no values echoed) when the module is disabled, when
 * `apiId` is missing, when the `api_hash` variable is empty, or when stdin is
 * not a TTY. On success: session string → `UserSessionStore`, identity →
 * `identity.json` next to the session, one short "залогинен как @…" line.
 */
export async function telegramUserLogin(options: TelegramUserCliOptions): Promise<number> {
	const out = options.out ?? writer(process.stdout);
	const err = options.err ?? writer(process.stderr);
	const env = options.env ?? process.env;
	const settings = options.config.config.modules.telegram.user;
	if (!settings) {
		err("telegram user login недоступен: в конфиге нет блока modules.telegram.user");
		return 1;
	}
	const readiness = telegramUserReadiness(settings, env);
	if (!readiness.ok) {
		err(`telegram user login недоступен: ${readiness.reason}`);
		return 1;
	}
	const interactive = options.interactive ?? process.stdin.isTTY === true;
	if (!interactive) {
		err(
			"telegram user login требует интерактивный терминал (TTY): номер, код и 2FA пароль нельзя передавать аргументами или читать из пайпа",
		);
		return 1;
	}

	const sessionFile = resolveUserSessionFile(settings, options.config.paths.stateDir);
	const sessions = new UserSessionStore(sessionFile);
	const identities = new TelegramUserIdentityStore(identityFileForSession(sessionFile));
	const prompter = options.prompt ?? createTerminalPrompter();
	const createClient = options.createClient ?? defaultTelegramUserClientFactory;
	const now = options.now ?? (() => new Date());
	const apiHash = resolveUserApiHash(settings, env); // never printed

	const stored = await sessions.read();
	// Everything the user or the environment supplied on this run: a raw library
	// or socket message must not be able to echo any of it back to the terminal.
	const secrets: (string | undefined)[] = [apiHash, stored ?? ""];
	let client: ReturnType<TelegramUserClientFactory>;
	try {
		client = createClient({ apiId: settings.apiId as number, apiHash, session: stored ?? "" });
	} catch (error) {
		err(`telegram user login не удался: ${describeFailure(error, secrets)}`);
		return 1;
	}

	try {
		await client.connect();
		let identity: TelegramUserIdentity;
		let fresh = false;
		if (await client.isAuthorized()) {
			identity = await client.me();
		} else {
			identity = await client.signIn({
				phoneNumber: await prompter.askPhoneNumber(),
				phoneCode: async (isCodeViaApp?: boolean) => {
					const value = await prompter.askCode(isCodeViaApp);
					secrets.push(value);
					return value;
				},
				password: async (hint?: string) => {
					const value = await prompter.askPassword(hint);
					secrets.push(value);
					return value;
				},
			});
			// StringSession.save() → UserSessionStore.save(): the only copy of the
			// credential, written atomically with mode 0600.
			await sessions.save(await client.exportSessionString());
			fresh = true;
		}
		await identities.save({ ...identity, loggedInAt: now().toISOString() });
		out(`${fresh ? "залогинен" : "уже залогинен"} как ${identityLabel(identity)}`);
		return 0;
	} catch (error) {
		err(`telegram user login не удался: ${describeFailure(error, secrets)}`);
		return 1;
	} finally {
		await safeDisconnect(client);
	}
}

/**
 * `alive telegram logout`.
 *
 * Tries a server-side logOut when a session and working credentials exist, then
 * removes the local session and the identity sidecar whatever happened. Always
 * exit 0 when the local state ends up clean; a failed server logout only adds a
 * warning that the session may still be listed in Telegram.
 */
export async function telegramUserLogout(options: TelegramUserCliOptions): Promise<number> {
	const out = options.out ?? writer(process.stdout);
	const err = options.err ?? writer(process.stderr);
	const env = options.env ?? process.env;
	const settings = options.config.config.modules.telegram.user;
	const sessionFile = resolveUserSessionFile(settings ?? DISABLED_USER_CONFIG, options.config.paths.stateDir);
	const sessions = new UserSessionStore(sessionFile);
	const identities = new TelegramUserIdentityStore(identityFileForSession(sessionFile));
	const createClient = options.createClient ?? defaultTelegramUserClientFactory;

	let stored: string | undefined;
	try {
		stored = await sessions.read();
	} catch (error) {
		err(`telegram user logout: ${describeFailure(error, [])}`);
		stored = undefined;
	}

	let serverFailure: string | undefined;
	if (stored) {
		const readiness = settings
			? telegramUserReadiness(settings, env)
			: { ok: false, reason: "modules.telegram.user is not configured" };
		if (!readiness.ok || !settings) {
			serverFailure = `серверный logOut пропущен: ${readiness.reason}`;
		} else {
			const apiHash = resolveUserApiHash(settings, env);
			let client: ReturnType<TelegramUserClientFactory> | undefined;
			try {
				client = createClient({ apiId: settings.apiId as number, apiHash, session: stored });
				await client.connect();
				if (await client.isAuthorized()) await client.logOut();
			} catch (error) {
				serverFailure = `серверный logOut не удался: ${describeFailure(error, [apiHash, stored])}`;
			} finally {
				if (client) await safeDisconnect(client);
			}
		}
	}

	try {
		await sessions.remove();
		await identities.remove();
	} catch (error) {
		err(`telegram user logout: не удалось удалить локальные файлы: ${describeFailure(error, [stored])}`);
		return 1;
	}

	if (serverFailure) {
		err(serverFailure);
		err("локальная сессия и identity удалены; серверная сессия могла остаться — заверши её в Telegram: Настройки → Устройства");
		return 0;
	}
	out(stored ? "выход выполнен: локальная сессия и identity удалены" : "сессия не найдена: локальное состояние уже чистое");
	return 0;
}

interface SessionStatus {
	present: boolean;
	bytes: number;
	mtime?: string;
	path: string;
}

/**
 * `alive telegram user-status`.
 *
 * Offline and secret-free: readiness comes from the config/environment, the
 * session from `describe()` (presence, size, mtime — never the content), the
 * identity from the sidecar. Runs without `api_hash` or a phone number.
 */
export async function telegramUserStatus(options: TelegramUserCliOptions): Promise<number> {
	const out = options.out ?? writer(process.stdout);
	const env = options.env ?? process.env;
	const settings = options.config.config.modules.telegram.user;
	const readiness = settings
		? telegramUserReadiness(settings, env)
		: { ok: false, reason: "modules.telegram.user is not configured" };
	const sessionFile = resolveUserSessionFile(settings ?? DISABLED_USER_CONFIG, options.config.paths.stateDir);
	const described = await new UserSessionStore(sessionFile).describe();
	const session: SessionStatus = { ...described, path: sessionFile };
	// A broken sidecar must not hide the session state: report it and keep going.
	let identity: TelegramUserIdentityRecord | undefined;
	let identityError: string | undefined;
	try {
		identity = await new TelegramUserIdentityStore(identityFileForSession(sessionFile)).read();
	} catch (error) {
		identityError = describeFailure(error, []);
	}

	if (options.json) {
		out(
			JSON.stringify(
				{
					enabled: settings?.enabled === true,
					readiness: { ok: readiness.ok, ...(readiness.reason ? { reason: readiness.reason } : {}) },
					session,
					identity: identity ?? null,
					...(identityError ? { identityError } : {}),
				},
				null,
				2,
			),
		);
		return 0;
	}

	out(`modules.telegram.user: ${settings ? (settings.enabled ? "включён" : "выключен") : "не настроен"}`);
	out(`readiness: ${readiness.ok ? "готов" : readiness.reason}`);
	out(
		session.present
			? `session: есть, ${session.bytes} байт, mtime ${session.mtime} — ${session.path}`
			: `session: нет — ${session.path}`,
	);
	out(
		identityError
			? `identity: ошибка — ${identityError}`
			: identity
				? `identity: ${formatIdentityRecord(identity)}`
				: "identity: нет (никто не входил)",
	);
	return 0;
}

function formatIdentityRecord(record: TelegramUserIdentityRecord): string {
	const who = record.username ? `@${record.username}` : record.firstName ?? "без username";
	return `${who}, id ${record.id}, вход ${record.loggedInAt}`;
}

/** Real terminal prompter: phone number echoes, the code and password do not. */
export function createTerminalPrompter(
	input: NodeJS.ReadStream = process.stdin,
	output: NodeJS.WriteStream = process.stdout,
): TelegramUserPrompter {
	if (!input.isTTY) throw new Error("telegram user login требует интерактивный терминал (TTY)");
	return {
		askPhoneNumber: () => askVisible(input, output, "Номер телефона (например +79991234567): "),
		askCode: (isCodeViaApp?: boolean) =>
			askHidden(
				input,
				output,
				isCodeViaApp ? "Код из приложения Telegram (ввод скрыт): " : "Код из Telegram (ввод скрыт): ",
			),
		askPassword: (hint?: string) =>
			askHidden(input, output, hint ? `2FA пароль, подсказка «${hint}» (ввод скрыт): ` : "2FA пароль (ввод скрыт): "),
	};
}

/** Visible question through readline; the phone number is not a secret. */
function askVisible(input: NodeJS.ReadStream, output: NodeJS.WriteStream, label: string): Promise<string> {
	const rl = readline.createInterface({ input, output, terminal: true });
	return new Promise<string>((resolve) => {
		rl.question(label, (answer) => {
			rl.close();
			resolve(answer.trim());
		});
	});
}

/**
 * No-echo question for the login code and the 2FA password: raw mode, no
 * readline history, no echo, nothing written to the terminal except the label.
 * Ctrl-C rejects without echoing what was typed so far.
 */
function askHidden(input: NodeJS.ReadStream, output: NodeJS.WriteStream, label: string): Promise<string> {
	return new Promise<string>((resolve, reject) => {
		output.write(label);
		const wasRaw = input.isRaw === true;
		input.setRawMode(true);
		input.resume();
		let value = "";
		let settled = false;
		const cleanup = (): void => {
			input.off("data", onData);
			input.setRawMode(wasRaw);
			input.pause();
			output.write("\n");
		};
		const finish = (result: string): void => {
			if (settled) return;
			settled = true;
			cleanup();
			resolve(result.trim());
		};
		const fail = (error: Error): void => {
			if (settled) return;
			settled = true;
			cleanup();
			reject(error);
		};
		const onData = (chunk: Buffer | string): void => {
			const text = typeof chunk === "string" ? chunk : chunk.toString("utf8");
			for (const char of text) {
				if (char === "\r" || char === "\n") {
					finish(value);
					return;
				}
				if (char === "\u0003") {
					// Ctrl-C: raw mode suppresses SIGINT, so it arrives as a byte.
					fail(new Error("ввод отменён (Ctrl-C)"));
					return;
				}
				if (char === "\u0008" || char === "\u007f") {
					value = value.slice(0, -1);
					continue;
				}
				// Escape sequences (arrows, paste markers) and other control bytes
				// carry nothing useful for a numeric code or a password.
				if (char < " " || char === "\u001b") continue;
				value += char;
			}
		};
		input.on("data", onData);
	});
}
