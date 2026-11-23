/**
 * Telegram user-account CLI test (#248, step B):
 *
 *   npx tsx src/dev/telegram-cli-test.ts
 *
 * No network, no MTProto, no phone number: `login` / `logout` / `user-status`
 * take a client factory and a prompter as parameters, so the whole flow runs
 * against a fake GramJS client. Covers the happy path (session → store,
 * identity → sidecar), every refusal (disabled / no api_id / no api_hash / no
 * TTY), redaction of the code, the password, the session string and the
 * `api_hash`, idempotent logout that cleans up after a network failure, and an
 * offline status that shows presence/size without the session content.
 */
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { PassThrough } from "node:stream";
import { DEFAULT_CONFIG, type AliveConfig, type LoadedConfig, type Paths } from "../config.js";
import {
	createTerminalPrompter,
	telegramUserLogin,
	telegramUserLogout,
	telegramUserStatus,
	type TelegramUserCliOptions,
	type TelegramUserPrompter,
} from "../modules/telegram/user/cli.js";
import {
	TelegramUserPasswordNeededError,
	redactSecrets,
	type TelegramUserClient,
	type TelegramUserClientFactory,
	type TelegramUserIdentity,
	type TelegramUserSignInParams,
} from "../modules/telegram/user/client.js";
import { validateTelegramUserConfig, type TelegramUserConfig } from "../modules/telegram/user/config.js";
import { TelegramUserIdentityStore, identityFileForSession, type TelegramUserIdentityRecord } from "../modules/telegram/user/identity.js";
import { UserSessionStore } from "../modules/telegram/user/session-store.js";

let failures = 0;

function check(name: string, condition: boolean, detail?: unknown): void {
	if (condition) {
		process.stdout.write(`  ok    ${name}\n`);
		return;
	}
	failures += 1;
	process.stdout.write(`  FAIL  ${name}${detail === undefined ? "" : ` — ${JSON.stringify(detail)}`}\n`);
}

function section(name: string): void {
	process.stdout.write(`\n${name}\n`);
}

/** The whole command output has to stay free of these values. */
const SESSION_VALUE = "1BVtsOK4fake-session-string-for-tests-abc123def456";
const LOGIN_CODE = "424242";
const PASSWORD = "s3cr3t-2fa-pass";
const API_HASH = "0123456789abcdef0123456789abcdef";
const IDENTITY: TelegramUserIdentity = { id: "123456789", username: "alice", firstName: "Alice" };
const LOGGED_IN_AT = "2026-01-02T03:04:05.000Z";

const root = fs.mkdtempSync(path.join(os.tmpdir(), "alive-telegram-cli-test-"));

/** A `LoadedConfig` with a real Telegram block; only `stateDir` matters here. */
function makeConfig(user: TelegramUserConfig | undefined, stateDir: string): LoadedConfig {
	const config = JSON.parse(JSON.stringify(DEFAULT_CONFIG)) as AliveConfig;
	if (user === undefined) delete config.modules.telegram.user;
	else config.modules.telegram.user = user;
	return { config, paths: { stateDir } as unknown as Paths };
}

function userConfig(overrides: Partial<TelegramUserConfig> = {}): TelegramUserConfig {
	return validateTelegramUserConfig({
		enabled: true,
		apiId: 123456,
		apiHashEnv: "USER_API_HASH",
		allowedChatIds: [],
		...overrides,
	});
}

const ENV = { USER_API_HASH: API_HASH };

interface FakeBehavior {
	/** `isAuthorized()` result; `false` means a fresh login is needed. */
	authorized?: boolean;
	/** Mimics SESSION_PASSWORD_NEEDED: only then does the real client ask for the 2FA password. */
	passwordNeeded?: boolean;
	connectError?: unknown;
	/** Thrown before the code/password callbacks are asked (or built from their values). */
	signInError?: Error | ((values: { code?: string; password?: string }) => unknown);
	logoutError?: unknown;
	meError?: unknown;
	identity?: TelegramUserIdentity;
}

/** In-memory {@link TelegramUserClient}: records calls, never touches a socket. */
class FakeClient implements TelegramUserClient {
	readonly calls: string[] = [];
	readonly options: { apiId: number; apiHash: string; session: string };
	receivedCode?: string;
	receivedPassword?: string;
	connected = false;
	disconnected = false;
	authorized: boolean;
	loggedOut = false;
	disconnectError?: unknown;
	exported = SESSION_VALUE;
	private readonly behavior: FakeBehavior;

	constructor(options: { apiId: number; apiHash: string; session: string }, behavior: FakeBehavior = {}) {
		this.options = options;
		this.behavior = behavior;
		this.authorized = behavior.authorized === true;
	}

	async connect(): Promise<void> {
		this.calls.push("connect");
		if (this.behavior.connectError) throw this.behavior.connectError;
		this.connected = true;
	}

	async isAuthorized(): Promise<boolean> {
		this.calls.push("isAuthorized");
		return this.authorized;
	}

	async signIn(params: TelegramUserSignInParams): Promise<TelegramUserIdentity> {
		this.calls.push("signIn");
		this.receivedCode = String(typeof params.phoneCode === "function" ? await params.phoneCode(true) : params.phoneCode);
		if (params.password !== undefined && this.behavior.passwordNeeded === true) {
			this.receivedPassword = String(
				typeof params.password === "function" ? await params.password("подсказка") : params.password,
			);
		}
		if (typeof this.behavior.signInError === "function") {
			throw this.behavior.signInError({ code: this.receivedCode, password: this.receivedPassword });
		}
		if (this.behavior.signInError) throw this.behavior.signInError;
		this.authorized = true;
		return this.behavior.identity ?? IDENTITY;
	}

	async me(): Promise<TelegramUserIdentity> {
		this.calls.push("me");
		if (this.behavior.meError) throw this.behavior.meError;
		return this.behavior.identity ?? IDENTITY;
	}

	async logOut(): Promise<void> {
		this.calls.push("logOut");
		if (this.behavior.logoutError) throw this.behavior.logoutError;
		this.loggedOut = true;
		this.authorized = false;
	}

	async disconnect(): Promise<void> {
		this.calls.push("disconnect");
		this.disconnected = true;
		this.connected = false;
		if (this.disconnectError) throw this.disconnectError;
	}

	async exportSessionString(): Promise<string> {
		this.calls.push("exportSessionString");
		return this.exported;
	}
}

interface Harness {
	options: TelegramUserCliOptions;
	clients: FakeClient[];
	out: string[];
	err: string[];
	asked: string[];
}

/** Build command options with captured output and an injected fake client. */
function harness(options: {
	user?: TelegramUserConfig;
	stateDir: string;
	env?: NodeJS.ProcessEnv;
	interactive?: boolean;
	behavior?: FakeBehavior;
	phone?: string;
	code?: string;
	password?: string;
	json?: boolean;
	createClient?: TelegramUserClientFactory;
	prompt?: TelegramUserPrompter;
}): Harness {
	const clients: FakeClient[] = [];
	const out: string[] = [];
	const err: string[] = [];
	const asked: string[] = [];
	const prompter: TelegramUserPrompter = options.prompt ?? {
		askPhoneNumber: async () => {
			asked.push("phone");
			return options.phone ?? "+79991234567";
		},
		askCode: async () => {
			asked.push("code");
			return options.code ?? LOGIN_CODE;
		},
		askPassword: async () => {
			asked.push("password");
			return options.password ?? PASSWORD;
		},
	};
	const createClient: TelegramUserClientFactory =
		options.createClient ??
		((createOptions) => {
			const client = new FakeClient(createOptions, options.behavior);
			clients.push(client);
			return client;
		});
	return {
		clients,
		out,
		err,
		asked,
		options: {
			config: makeConfig(options.user === undefined ? userConfig() : options.user, options.stateDir),
			env: options.env ?? ENV,
			out: (line) => out.push(line),
			err: (line) => err.push(line),
			interactive: options.interactive ?? true,
			prompt: prompter,
			createClient,
			now: () => new Date(LOGGED_IN_AT),
			json: options.json,
		},
	};
}

/** Factory that fails the test if a command builds a client at all. */
const forbiddenFactory: TelegramUserClientFactory = () => {
	throw new Error("the test expected no client to be created");
};

function freshDir(name: string): string {
	const dir = path.join(root, name);
	fs.mkdirSync(dir, { recursive: true });
	return dir;
}

function sessionPath(stateDir: string, user: TelegramUserConfig = userConfig()): string {
	return path.join(stateDir, user.sessionFile ?? path.join("telegram-user", "session"));
}

async function seedLogin(stateDir: string, user: TelegramUserConfig = userConfig()): Promise<void> {
	const sessionFile = sessionPath(stateDir, user);
	await new UserSessionStore(sessionFile).save(SESSION_VALUE);
	await new TelegramUserIdentityStore(identityFileForSession(sessionFile)).save({ ...IDENTITY, loggedInAt: LOGGED_IN_AT });
}

function readIdentity(stateDir: string, user: TelegramUserConfig = userConfig()): TelegramUserIdentityRecord | undefined {
	const file = identityFileForSession(sessionPath(stateDir, user));
	if (!fs.existsSync(file)) return undefined;
	return JSON.parse(fs.readFileSync(file, "utf8")) as TelegramUserIdentityRecord;
}

function leaks(text: string): string[] {
	const found: string[] = [];
	for (const [label, value] of [
		["session", SESSION_VALUE],
		["code", LOGIN_CODE],
		["password", PASSWORD],
		["api_hash", API_HASH],
	] as const) {
		if (text.includes(value)) found.push(label);
	}
	return found;
}

try {
	section("login: успешный вход кладёт сессию в store и identity рядом");
	{
		const stateDir = freshDir("login-ok");
		const user = userConfig();
		const h = harness({ stateDir });
		const code = await telegramUserLogin(h.options);
		check("login exits 0", code === 0, { code, err: h.err });
		check("stdout says who is logged in", h.out.join("\n").includes("залогинен как @alice"), h.out);
		check("stderr is empty", h.err.length === 0, h.err);
		check("the client was connected and disconnected", h.clients.length === 1 && h.clients[0]!.connected === false && h.clients[0]!.disconnected, h.clients[0]?.calls);

		const sessionFile = sessionPath(stateDir);
		check("the session file is written", fs.existsSync(sessionFile));
		check("the session file holds the StringSession value", fs.readFileSync(sessionFile, "utf8") === SESSION_VALUE);
		check("the session file is 0600", (fs.statSync(sessionFile).mode & 0o777) === 0o600, (fs.statSync(sessionFile).mode & 0o777).toString(8));
		check("the store reads the session back", (await new UserSessionStore(sessionFile).read()) === SESSION_VALUE);

		const identity = readIdentity(stateDir);
		check("identity.json is next to the session", fs.existsSync(path.join(stateDir, "telegram-user", "identity.json")));
		check("the identity carries id, username and firstName", identity?.id === IDENTITY.id && identity?.username === "alice" && identity?.firstName === "Alice", identity);
		check("the identity carries the login time", identity?.loggedInAt === LOGGED_IN_AT, identity);
		check(
			"the identity file is 0600",
			(fs.statSync(path.join(stateDir, "telegram-user", "identity.json")).mode & 0o777) === 0o600,
			(fs.statSync(path.join(stateDir, "telegram-user", "identity.json")).mode & 0o777).toString(8),
		);

		const client = h.clients[0]!;
		check("the factory received the configured api_id", client.options.apiId === 123456, client.options.apiId);
		check("the factory received the api_hash from the environment", client.options.apiHash === API_HASH);
		check("the factory started without a session", client.options.session === "");
		check("the code reached the client", client.receivedCode === LOGIN_CODE);
		check("the 2FA password is not requested for a 1-step login", client.receivedPassword === undefined, client.receivedPassword);
		check("only the phone number and the code were asked", h.asked.join(",") === "phone,code", h.asked);

		const allOutput = [...h.out, ...h.err].join("\n");
		check("the output carries no code, password, api_hash or session", leaks(allOutput).length === 0, leaks(allOutput));
		const identityText = fs.readFileSync(path.join(stateDir, "telegram-user", "identity.json"), "utf8");
		check("the identity file carries no code, password, api_hash or session", leaks(identityText).length === 0, leaks(identityText));
	}

	section("login: 2FA — пароль спрашивается только когда Telegram его требует");
	{
		const stateDir = freshDir("login-2fa");
		const h = harness({ stateDir, behavior: { authorized: false, passwordNeeded: true } });
		const code = await telegramUserLogin(h.options);
		check("the 2FA login exits 0", code === 0, { code, err: h.err });
		check("the code and the password were both requested", h.asked.join(",") === "phone,code,password", h.asked);
		check("the client received the password", h.clients[0]?.receivedPassword === PASSWORD);
		check("the session is stored", fs.readFileSync(sessionPath(stateDir), "utf8") === SESSION_VALUE);
		const allOutput = [...h.out, ...h.err].join("\n");
		check("the 2FA output carries no secrets", leaks(allOutput).length === 0, leaks(allOutput));
	}

	section("login: уже авторизованная сессия не спрашивает код");
	{
		const stateDir = freshDir("login-existing");
		await seedLogin(stateDir);
		const h = harness({ stateDir, behavior: { authorized: true } });
		const code = await telegramUserLogin(h.options);
		check("exits 0", code === 0, { code, err: h.err });
		check("reports the existing login", h.out.join("\n").includes("уже залогинен как @alice"), h.out);
		check("no prompt was shown", h.asked.length === 0, h.asked);
		check("signIn was not called", h.clients[0]?.calls.includes("signIn") === false, h.clients[0]?.calls);
		check("the stored session is left untouched", fs.readFileSync(sessionPath(stateDir), "utf8") === SESSION_VALUE);
	}

	section("login: отказы до сети, без значений в тексте");
	{
		const cases: Array<[string, TelegramUserConfig, NodeJS.ProcessEnv, string]> = [
			["disabled", userConfig({ enabled: false }), ENV, "modules.telegram.user is disabled"],
			["no api_id", userConfig({ apiId: undefined }), ENV, "apiId"],
			["no api_hash", userConfig(), {}, "USER_API_HASH"],
			["no api_hash value but whitespace", userConfig(), { USER_API_HASH: "   " }, "USER_API_HASH"],
		];
		for (const [label, user, env, expected] of cases) {
			const stateDir = freshDir(`login-refuse-${label.replace(/\s+/g, "-")}`);
			const h = harness({ stateDir, user, env, createClient: forbiddenFactory });
			const code = await telegramUserLogin(h.options);
			const text = h.err.join("\n");
			check(`${label}: exit 1`, code === 1, { code, out: h.out });
			check(`${label}: the reason is shown`, text.includes(expected), text);
			check(`${label}: no client was created`, h.clients.length === 0);
			check(`${label}: nothing was asked`, h.asked.length === 0, h.asked);
			check(`${label}: no session file appeared`, !fs.existsSync(sessionPath(stateDir, user)));
			check(`${label}: the text carries no secrets`, leaks(`${text}\n${h.out.join("\n")}`).length === 0, leaks(text));
		}
		const stateDir = freshDir("login-refuse-missing-block");
		const h = harness({ stateDir, createClient: forbiddenFactory });
		h.options.config = makeConfig(undefined, stateDir);
		const code = await telegramUserLogin(h.options);
		check("an absent user block is refused", code === 1 && h.err.join("\n").includes("modules.telegram.user"), h.err);
		check("an absent user block creates no client", h.clients.length === 0);
	}

	section("login: без TTY отказ, stdin не читается");
	{
		const stateDir = freshDir("login-not-tty");
		const h = harness({ stateDir, interactive: false, createClient: forbiddenFactory });
		const code = await telegramUserLogin(h.options);
		check("exit 1", code === 1, { code, out: h.out });
		check("the message asks for a TTY", h.err.join("\n").includes("TTY"), h.err);
		check("the prompter was never called", h.asked.length === 0, h.asked);
		check("no client was created", h.clients.length === 0);
		check("no session file appeared", !fs.existsSync(sessionPath(stateDir)));
	}

	section("login: 2FA без пароля — понятная ошибка, файлов нет");
	{
		const stateDir = freshDir("login-password-needed");
		const h = harness({
			stateDir,
			behavior: { signInError: new TelegramUserPasswordNeededError("2FA пароль нужен: у аккаунта включена двухфакторная защита") },
		});
		const code = await telegramUserLogin(h.options);
		check("exit 1", code === 1, { code, out: h.out });
		check("the message names 2FA", h.err.join("\n").includes("2FA пароль нужен"), h.err);
		check("no session was stored", !fs.existsSync(sessionPath(stateDir)));
		check("no identity was stored", readIdentity(stateDir) === undefined);
		check("the client was still disconnected", h.clients[0]?.disconnected === true, h.clients[0]?.calls);
		check("the output carries no secrets", leaks([...h.out, ...h.err].join("\n")).length === 0, leaks([...h.out, ...h.err].join("\n")));
	}

	section("login: ошибка сети/клиента не печатает session string и api_hash");
	{
		// A stored session exists, so the CLI knows the string and must scrub it
		// even when a raw library message echoes it back.
		const stateDir = freshDir("login-redaction");
		await seedLogin(stateDir);
		const h = harness({
			stateDir,
			behavior: { connectError: new Error(`socket hang up ${SESSION_VALUE} ${API_HASH}`) },
		});
		const code = await telegramUserLogin(h.options);
		const text = [...h.out, ...h.err].join("\n");
		check("exit 1", code === 1, { code, out: h.out });
		check("the error is shown", text.includes("не удался"), text);
		check("the raw secret values are redacted", leaks(text).length === 0, leaks(text));
	}

	section("login: введённые код и пароль не утекают через ошибку клиента");
	{
		const stateDir = freshDir("login-input-redaction");
		const h = harness({
			stateDir,
			behavior: {
				signInError: ({ code, password }) => new Error(`rejected ${code} / ${password} / ${API_HASH}`),
			},
		});
		const exitCode = await telegramUserLogin(h.options);
		const text = [...h.out, ...h.err].join("\n");
		check("exit 1", exitCode === 1, { exitCode, out: h.out });
		check("the error is reported", text.includes("не удался"), text);
		check("the code, the password and the api_hash are redacted", leaks(text).length === 0, leaks(text));
		check("no session file appeared", !fs.existsSync(sessionPath(stateDir)));
	}

	section("logout: идемпотентен и не требует сети без сессии");
	{
		const stateDir = freshDir("logout-empty");
		const first = harness({ stateDir, createClient: forbiddenFactory });
		const firstCode = await telegramUserLogout(first.options);
		check("exit 0 with no session", firstCode === 0, { firstCode, err: first.err });
		check("the message says the local state is clean", first.out.join("\n").includes("сессия не найдена"), first.out);
		check("no client was created", first.clients.length === 0);
		const second = harness({ stateDir, createClient: forbiddenFactory });
		const secondCode = await telegramUserLogout(second.options);
		check("a second logout still exits 0", secondCode === 0, { secondCode, err: second.err });
		const localDir = path.join(stateDir, "telegram-user");
		check("no files appeared", !fs.existsSync(localDir) || fs.readdirSync(localDir).length === 0, fs.existsSync(localDir) ? fs.readdirSync(localDir) : "absent");
	}

	section("logout: серверный logOut выполняется и чистит локальные файлы");
	{
		const stateDir = freshDir("logout-server-ok");
		await seedLogin(stateDir);
		const h = harness({ stateDir, behavior: { authorized: true } });
		const code = await telegramUserLogout(h.options);
		check("exit 0", code === 0, { code, err: h.err });
		check("the server logOut ran", h.clients[0]?.loggedOut === true, h.clients[0]?.calls);
		check("the client was disconnected", h.clients[0]?.disconnected === true, h.clients[0]?.calls);
		check("the client reused the stored session", h.clients[0]?.options.session === SESSION_VALUE);
		check("the session file is gone", !fs.existsSync(sessionPath(stateDir)));
		check("identity.json is gone", readIdentity(stateDir) === undefined);
		check("the message confirms the logout", h.out.join("\n").includes("выход выполнен"), h.out);
		check("no warning was printed", h.err.length === 0, h.err);
		check("the output carries no secrets", leaks([...h.out, ...h.err].join("\n")).length === 0, leaks([...h.out, ...h.err].join("\n")));
	}

	section("logout: сетевая ошибка — локальные файлы всё равно удаляются");
	{
		const stateDir = freshDir("logout-network-error");
		await seedLogin(stateDir);
		const h = harness({
			stateDir,
			behavior: { connectError: new Error(`network unreachable ${SESSION_VALUE} ${API_HASH}`) },
		});
		const code = await telegramUserLogout(h.options);
		const text = [...h.out, ...h.err].join("\n");
		check("exit 0: locally clean is what matters", code === 0, { code, err: h.err });
		check("the network failure is reported", text.includes("серверный logOut не удался"), text);
		check("the warning says the server session may remain", text.includes("серверная сессия могла остаться"), text);
		check("the session file is removed anyway", !fs.existsSync(sessionPath(stateDir)));
		check("identity.json is removed anyway", readIdentity(stateDir) === undefined);
		check("the warning carries no session string or api_hash", leaks(text).length === 0, leaks(text));
		check("the client was disconnected", h.clients[0]?.disconnected === true, h.clients[0]?.calls);
	}

	section("logout: без api_hash серверный шаг пропускается, локально чисто");
	{
		const stateDir = freshDir("logout-no-hash");
		await seedLogin(stateDir);
		const h = harness({ stateDir, env: {}, createClient: forbiddenFactory });
		const code = await telegramUserLogout(h.options);
		const text = [...h.out, ...h.err].join("\n");
		check("exit 0", code === 0, { code, err: h.err });
		check("the missing api_hash is reported", text.includes("USER_API_HASH"), text);
		check("the warning says the server session may remain", text.includes("серверная сессия могла остаться"), text);
		check("no client was created", h.clients.length === 0);
		check("the session file is removed", !fs.existsSync(sessionPath(stateDir)));
		check("identity.json is removed", readIdentity(stateDir) === undefined);
	}

	section("user-status: офлайн, без api_hash, без сети и без содержимого сессии");
	{
		const stateDir = freshDir("status-present");
		await seedLogin(stateDir);
		const h = harness({ stateDir, env: {}, createClient: forbiddenFactory });
		const code = await telegramUserStatus(h.options);
		const text = h.out.join("\n");
		check("exit 0 without a network or api_hash", code === 0, { code, err: h.err });
		check("no client was created", h.clients.length === 0);
		check("it shows the readiness reason", text.includes("USER_API_HASH"), text);
		check("it shows the session as present", text.includes("session: есть"), text);
		check("it shows the session byte size", text.includes(`${Buffer.byteLength(SESSION_VALUE)} байт`), text);
		check("it shows the session mtime", /mtime \d{4}-\d{2}-\d{2}T/.test(text), text);
		check("it shows the identity username", text.includes("@alice"), text);
		check("it shows the identity id", text.includes(`id ${IDENTITY.id}`), text);
		check("it shows when the login happened", text.includes(LOGGED_IN_AT), text);
		check("it never shows the session content", !text.includes(SESSION_VALUE), text);
		check("it never shows the api_hash", !text.includes(API_HASH), text);

		const jsonHarness = harness({ stateDir, env: {}, json: true, createClient: forbiddenFactory });
		const jsonCode = await telegramUserStatus(jsonHarness.options);
		const raw = jsonHarness.out.join("\n");
		const parsed = JSON.parse(raw) as {
			enabled: boolean;
			readiness: { ok: boolean; reason?: string };
			session: { present: boolean; bytes: number; mtime?: string; path: string };
			identity: { username?: string; id: string } | null;
		};
		check("--json exits 0", jsonCode === 0, jsonCode);
		check("--json reports enabled", parsed.enabled === true, parsed.enabled);
		check("--json reports the readiness reason", parsed.readiness.ok === false && (parsed.readiness.reason ?? "").includes("USER_API_HASH"), parsed.readiness);
		check("--json reports presence and bytes", parsed.session.present === true && parsed.session.bytes === Buffer.byteLength(SESSION_VALUE), parsed.session);
		check("--json reports the identity", parsed.identity?.username === "alice" && parsed.identity?.id === IDENTITY.id, parsed.identity);
		check("--json has no session content", !raw.includes(SESSION_VALUE), raw);
		check("--json has no api_hash", !raw.includes(API_HASH));
	}

	section("user-status: повреждённый identity.json не прячет состояние сессии");
	{
		const stateDir = freshDir("status-broken-identity");
		await new UserSessionStore(sessionPath(stateDir)).save(SESSION_VALUE);
		fs.mkdirSync(path.dirname(identityFileForSession(sessionPath(stateDir))), { recursive: true });
		fs.writeFileSync(identityFileForSession(sessionPath(stateDir)), "{broken");
		const h = harness({ stateDir, env: {}, createClient: forbiddenFactory });
		const code = await telegramUserStatus(h.options);
		const text = h.out.join("\n");
		check("status still exits 0", code === 0, { code, err: h.err });
		check("the session is still reported", text.includes("session: есть"), text);
		check("the broken identity is reported as an error", text.includes("identity: ошибка"), text);
		check("the status carries no session content", !text.includes(SESSION_VALUE), text);
	}

	section("user-status: выключенный модуль и пустое состояние");
	{
		const stateDir = freshDir("status-empty");
		const h = harness({ stateDir, user: userConfig({ enabled: false }), env: {}, createClient: forbiddenFactory });
		const code = await telegramUserStatus(h.options);
		const text = h.out.join("\n");
		check("exit 0", code === 0, { code, err: h.err });
		check("it says the module is off", text.includes("выключен"), text);
		check("it names the disabled reason", text.includes("disabled"), text);
		check("it reports no session", text.includes("session: нет"), text);
		check("it reports no identity", text.includes("identity: нет"), text);
		check("no client was created", h.clients.length === 0);
	}

	section("identity sidecar: строгий парс и идемпотентное удаление");
	{
		const stateDir = freshDir("identity-store");
		const file = path.join(stateDir, "telegram-user", "identity.json");
		const store = new TelegramUserIdentityStore(file);
		check("a missing identity reads as undefined", (await store.read()) === undefined);
		fs.mkdirSync(path.dirname(file), { recursive: true });
		fs.writeFileSync(file, "{not json");
		let message = "";
		try {
			await store.read();
		} catch (error) {
			message = error instanceof Error ? error.message : String(error);
		}
		check("broken JSON fails loudly with the path", message.includes(file) && message.includes("not valid JSON"), message);
		check("the broken file content is not echoed", !message.includes("not json"), message);
		await store.remove();
		await store.remove();
		check("remove is idempotent", !fs.existsSync(file));
	}

	section("терминал: код и пароль вводятся без эха");
	{
		const input = new PassThrough() as unknown as NodeJS.ReadStream;
		input.isTTY = true;
		input.isRaw = false;
		input.setRawMode = (mode: boolean) => {
			input.isRaw = mode;
			return input;
		};
		const chunks: string[] = [];
		const output = {
			write: (chunk: string) => {
				chunks.push(chunk);
				return true;
			},
		} as unknown as NodeJS.WriteStream;
		const prompter = createTerminalPrompter(input, output);

		const codePromise = prompter.askCode(true);
		input.write("424");
		input.write("242\r");
		const code = await codePromise;
		const printed = chunks.join("");
		check("the hidden prompt returns the typed code", code === LOGIN_CODE, code);
		check("the code itself is not echoed", !printed.includes(LOGIN_CODE), printed);
		check("only the label is written", printed.trim().startsWith("Код"), printed);
		check("raw mode was restored", input.isRaw === false, input.isRaw);

		chunks.length = 0;
		const passwordPromise = prompter.askPassword("подсказка");
		input.write("wrong");
		input.write("\u007f\u007f\u007f\u007f\u007f");
		input.write(PASSWORD);
		input.write("\r");
		const password = await passwordPromise;
		const passwordOutput = chunks.join("");
		check("backspace edits the hidden input", password === PASSWORD, password);
		check("the password itself is not echoed", !passwordOutput.includes(PASSWORD), passwordOutput);
		check("the hint is shown without the value", passwordOutput.includes("подсказка") && !passwordOutput.includes("wrong"), passwordOutput);

		chunks.length = 0;
		const cancelled = prompter.askCode(false).then(
			() => "",
			(error: unknown) => (error instanceof Error ? error.message : String(error)),
		);
		input.write("\u0003");
		const message = await cancelled;
		check("Ctrl-C cancels the prompt", message.includes("ввод отменён"), message);
		check("Ctrl-C does not echo the typed value", !chunks.join("").includes(LOGIN_CODE), chunks.join(""));
	}

	section("redactSecrets: секреты вычищаются из любого текста");
	{
		const scrubbed = redactSecrets(`session=${SESSION_VALUE} hash=${API_HASH}`, [SESSION_VALUE, API_HASH]);
		check("both secrets are removed", !scrubbed.includes(SESSION_VALUE) && !scrubbed.includes(API_HASH), scrubbed);
		check("the marker is left behind", scrubbed.split("[redacted]").length === 3, scrubbed);
	}
} finally {
	fs.rmSync(root, { recursive: true, force: true });
}

process.stdout.write(failures === 0 ? "\nALL TELEGRAM CLI TESTS PASSED\n" : `\n${failures} TELEGRAM CLI TEST(S) FAILED\n`);
process.exitCode = failures === 0 ? 0 : 1;
