/**
 * Thin MTProto wrapper around GramJS for the personal Telegram account
 * (#248, step B).
 *
 * Everything the CLI needs is behind {@link TelegramUserClient}, so the login
 * flow can be tested without a network, a phone number or GramJS itself.
 *
 * Secrets (the session string, the login code, the 2FA password and
 * `api_hash`) are the account. They must never reach a log line, an error
 * message, `toString()` or `JSON.stringify()`, so:
 *
 *  - the implementation keeps them in ECMAScript private fields (`#`), which
 *    are invisible to `JSON.stringify`, `Object.keys` and property access,
 *  - `toString()`/`toJSON()`/`util.inspect` are overridden to show only the
 *    `api_id` and whether a session exists,
 *  - every error leaving this module is a {@link TelegramUserError} with a
 *    human text; raw GramJS/network messages are classified and scrubbed of
 *    any known secret with {@link redactSecrets}.
 *
 * The GramJS module itself is imported statically (it only defines classes, it
 * makes no network call on import); connections happen exclusively in
 * `connect()`/`signIn()` and are always paired with `disconnect()` by the
 * caller.
 */
import { Api, TelegramClient } from "telegram";
import { computeCheck } from "telegram/Password.js";
import { StringSession } from "telegram/sessions/index.js";
import { LogLevel, Logger } from "telegram/extensions/Logger.js";

/**
 * GramJS session codec, re-exported so callers persist a login through this
 * module instead of reaching into the library (step C reads sessions too).
 */
export { StringSession } from "telegram/sessions/index.js";

/** Default `connect()` budget: a hung MTProto handshake must not hang the CLI. */
export const DEFAULT_CONNECT_TIMEOUT_MS = 30_000;

/** Identity of the logged-in account; no secrets, safe for logs and the sidecar. */
export interface TelegramUserIdentity {
	id: string;
	username?: string;
	firstName?: string;
}

/**
 * `phoneCode` and `password` may be plain strings or callbacks. Callbacks are
 * the interactive path: GramJS asks for the code only after Telegram sent it,
 * and for the password only when the account has 2FA (`SESSION_PASSWORD_NEEDED`).
 */
export interface TelegramUserSignInParams {
	phoneNumber: string;
	phoneCode: string | ((isCodeViaApp?: boolean) => string | Promise<string>);
	/** 2FA password; omit it and a password-protected account fails with `password-needed`. */
	password?: string | ((hint?: string) => string | Promise<string>);
}

/** Everything the login/logout/status commands need from an MTProto client. */
export interface TelegramUserClient {
	/** Open the connection. Bounded by a timeout, throws {@link TelegramUserConnectionError}. */
	connect(): Promise<void>;
	/** Whether the session is already a valid login. */
	isAuthorized(): Promise<boolean>;
	/** Log in step by step: phone number → code → 2FA password (only if Telegram asks). */
	signIn(params: TelegramUserSignInParams): Promise<TelegramUserIdentity>;
	/** The account behind the current session. */
	me(): Promise<TelegramUserIdentity>;
	/** Revoke this session on the server. */
	logOut(): Promise<void>;
	/** Close the connection; safe to call twice and never throws. */
	disconnect(): Promise<void>;
	/** The session string to persist (`StringSession.save()`). */
	exportSessionString(): Promise<string>;
}

/** Factory seam: tests inject a fake, the CLI uses {@link createGramJsClient}. */
export type TelegramUserClientFactory = (options: { apiId: number; apiHash: string; session: string }) => TelegramUserClient;

export type TelegramUserErrorCode =
	| "api-credentials"
	| "connection"
	| "phone-required"
	| "phone-rejected"
	| "phone-not-registered"
	| "code-invalid"
	| "code-expired"
	| "password-needed"
	| "password-invalid"
	| "session-invalid"
	| "flood-wait"
	| "unexpected";

/**
 * The only error type this module throws. `code` is machine-readable, the
 * message is short, human and already scrubbed of secrets.
 */
export class TelegramUserError extends Error {
	readonly code: TelegramUserErrorCode;

	constructor(code: TelegramUserErrorCode, message: string) {
		super(message);
		this.name = "TelegramUserError";
		this.code = code;
	}

	/** Same view as the message: a thrown error serialised by a logger stays clean. */
	toJSON(): { name: string; code: TelegramUserErrorCode; message: string } {
		return { name: this.name, code: this.code, message: this.message };
	}
}

export class TelegramUserCredentialsError extends TelegramUserError {
	constructor(message: string) {
		super("api-credentials", message);
		this.name = "TelegramUserCredentialsError";
	}
}

export class TelegramUserConnectionError extends TelegramUserError {
	constructor(message: string) {
		super("connection", message);
		this.name = "TelegramUserConnectionError";
	}
}

export class TelegramUserPasswordNeededError extends TelegramUserError {
	constructor(message: string) {
		super("password-needed", message);
		this.name = "TelegramUserPasswordNeededError";
	}
}

export function isTelegramUserError(value: unknown): value is TelegramUserError {
	return value instanceof TelegramUserError;
}

/**
 * Replace every known secret inside `text` with `[redacted]`.
 *
 * A second line of defence: the code above never builds messages from inputs,
 * but a raw library or socket message can echo them. Values shorter than three
 * characters are skipped, otherwise ordinary words would be shredded.
 */
export function redactSecrets(text: string, secrets: readonly (string | undefined)[]): string {
	let out = text;
	for (const secret of secrets) {
		const value = (secret ?? "").trim();
		if (value.length < 3) continue;
		out = out.split(value).join("[redacted]");
	}
	return out;
}

/** One-line, length-limited text for error messages. */
function oneLine(text: string, limit = 200): string {
	const flat = text.replace(/\s+/g, " ").trim();
	return flat.length > limit ? `${flat.slice(0, limit - 1)}…` : flat;
}

/** Telegram's `errorMessage` code, when the error carries one. */
function telegramErrorCode(error: unknown): string | undefined {
	const value = (error as { errorMessage?: unknown } | undefined)?.errorMessage;
	return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

const RPC_ERROR_MESSAGES: Record<string, { code: TelegramUserErrorCode; text: string }> = {
	PHONE_NUMBER_INVALID: { code: "phone-rejected", text: "номер не принят Telegram: проверь формат, например +79991234567" },
	PHONE_NUMBER_BANNED: { code: "phone-rejected", text: "номер заблокирован Telegram" },
	PHONE_NUMBER_FLOOD: { code: "flood-wait", text: "слишком много попыток входа с этим номером, попробуй позже" },
	PHONE_CODE_INVALID: { code: "code-invalid", text: "код неверный" },
	PHONE_CODE_EMPTY: { code: "code-invalid", text: "код пустой" },
	PHONE_CODE_HASH_EMPTY: { code: "code-invalid", text: "код неверный: Telegram не узнал запрос, войди заново" },
	PHONE_CODE_EXPIRED: { code: "code-expired", text: "код истёк: запроси новый и войди заново" },
	SESSION_PASSWORD_NEEDED: { code: "password-needed", text: "2FA пароль нужен: у аккаунта включена двухфакторная защита" },
	PASSWORD_HASH_INVALID: { code: "password-invalid", text: "2FA пароль неверный" },
	AUTH_KEY_UNREGISTERED: { code: "session-invalid", text: "сессия недействительна: войди заново" },
	AUTH_KEY_INVALID: { code: "session-invalid", text: "сессия недействительна: войди заново" },
	SESSION_REVOKED: { code: "session-invalid", text: "сессия отозвана в Telegram: войди заново" },
	USER_DEACTIVATED_BAN: { code: "session-invalid", text: "аккаунт заблокирован Telegram" },
	API_ID_INVALID: { code: "api-credentials", text: "api_id/api_hash не приняты Telegram (проверь приложение на my.telegram.org)" },
	API_ID_PUBLISHED_FLOOD: { code: "api-credentials", text: "api_id/api_hash не приняты Telegram (проверь приложение на my.telegram.org)" },
};

const CONNECTION_PATTERN = /ECONN|ETIMEDOUT|ENOTFOUND|EHOSTUNREACH|ECONNRESET|socket|network|connection|closed|reset|timed? ?out/i;

/** Turn any thrown value into a typed, secret-free {@link TelegramUserError}. */
export function asTelegramUserError(error: unknown, secrets: readonly (string | undefined)[] = []): TelegramUserError {
	if (error instanceof TelegramUserError) return error;
	const code = telegramErrorCode(error);
	if (code) {
		const known = RPC_ERROR_MESSAGES[code];
		if (known) return new TelegramUserError(known.code, known.text);
		const flood = /^FLOOD_WAIT_(\d+)$/.exec(code);
		if (flood) {
			return new TelegramUserError("flood-wait", `Telegram просит подождать ${flood[1]} с перед новой попыткой`);
		}
		return new TelegramUserError("unexpected", `Telegram вернул ошибку ${code}`);
	}
	const raw = oneLine(redactSecrets(error instanceof Error ? error.message : String(error), secrets));
	if (!raw) return new TelegramUserError("unexpected", "неизвестная ошибка Telegram");
	if (CONNECTION_PATTERN.test(raw)) {
		return new TelegramUserConnectionError(`нет соединения с Telegram: ${raw}`);
	}
	return new TelegramUserError("unexpected", raw);
}

/** Digits with an optional leading `+`; spaces, dashes and brackets are cosmetic. */
function normalizePhoneNumber(value: string): string {
	return (value ?? "").replace(/[\s()\-.]/g, "").trim();
}

function toIdentity(user: Api.TypeUser): TelegramUserIdentity {
	const typed = user as Api.User;
	const identity: TelegramUserIdentity = { id: String(typed.id) };
	if (typed.username) identity.username = typed.username;
	if (typed.firstName) identity.firstName = typed.firstName;
	return identity;
}

/** Options for {@link createGramJsClient}. */
export interface GramJsClientOptions {
	/** `api_id` from my.telegram.org. */
	apiId: number;
	/** `api_hash` from my.telegram.org, read from the environment by the caller. */
	apiHash: string;
	/** Stored session string, or `""` for a fresh login. */
	session: string;
	/** Connect budget in milliseconds, default {@link DEFAULT_CONNECT_TIMEOUT_MS}. */
	connectTimeoutMs?: number;
}

/**
 * Real GramJS-backed client. Refuses to be built without `api_id`/`api_hash`
 * (the message names the settings, never a value) and rejects a stored session
 * that GramJS cannot parse with a hint to log in again.
 */
export function createGramJsClient(options: GramJsClientOptions): TelegramUserClient {
	const apiId = options.apiId;
	const apiHash = (options.apiHash ?? "").trim();
	if (!Number.isSafeInteger(apiId) || apiId <= 0 || !apiHash) {
		throw new TelegramUserCredentialsError(
			"api_id/api_hash не заданы: укажи modules.telegram.user.apiId и api_hash в переменной окружения",
		);
	}
	const connectTimeoutMs =
		Number.isFinite(options.connectTimeoutMs) && (options.connectTimeoutMs as number) > 0
			? Math.floor(options.connectTimeoutMs as number)
			: DEFAULT_CONNECT_TIMEOUT_MS;
	return new GramJsUserClient({ apiId, apiHash, session: options.session ?? "", connectTimeoutMs });
}

class GramJsUserClient implements TelegramUserClient {
	#apiId: number;
	#apiHash: string;
	#session: StringSession;
	#client: TelegramClient;
	#connectTimeoutMs: number;

	constructor(options: { apiId: number; apiHash: string; session: string; connectTimeoutMs: number }) {
		this.#apiId = options.apiId;
		this.#apiHash = options.apiHash;
		this.#connectTimeoutMs = options.connectTimeoutMs;
		try {
			this.#session = new StringSession(options.session);
		} catch {
			// The value itself is never part of the message: it is the account.
			throw new TelegramUserError(
				"session-invalid",
				"сохранённая сессия Telegram не читается: выполни alive telegram logout и войди заново",
			);
		}
		this.#client = new TelegramClient(this.#session, options.apiId, options.apiHash, {
			connectionRetries: 1,
			requestRetries: 1,
			autoReconnect: false,
			retryDelay: 1_000,
			deviceModel: "alive",
			systemVersion: "alive",
			appVersion: "alive",
			// GramJS prints "Running gramJS version ..." from the constructor and
			// logs connection chatter by default; the CLI owns the output, and a log
			// line is one more place a credential could surface.
			baseLogger: new Logger(LogLevel.NONE),
		});
		this.#client.setLogLevel(LogLevel.NONE);
		this.#client.onError = async () => undefined;
	}

	/** Known secrets, for scrubbing library/network messages. */
	#secrets(): string[] {
		return [this.#apiHash, this.#sessionValue()];
	}

	/** The session string, or `""` before the auth key exists. Never logged. */
	#sessionValue(): string {
		try {
			return this.#session.save();
		} catch {
			return "";
		}
	}

	async #invoke<R extends Api.AnyRequest>(request: R): Promise<R["__response"]> {
		try {
			return await this.#client.invoke(request);
		} catch (error) {
			throw asTelegramUserError(error, this.#secrets());
		}
	}

	async connect(): Promise<void> {
		if (this.#client.connected) return;
		let timer: NodeJS.Timeout | undefined;
		try {
			const timeout = new Promise<never>((_resolve, reject) => {
				timer = setTimeout(
					() => reject(new TelegramUserConnectionError(`не удалось подключиться к Telegram за ${Math.round(this.#connectTimeoutMs / 1000)} с`)),
					this.#connectTimeoutMs,
				);
				// Do not keep the process alive just for the timeout.
				timer.unref?.();
			});
			const connected = await Promise.race([this.#client.connect(), timeout]);
			if (!connected) {
				throw new TelegramUserConnectionError("не удалось подключиться к Telegram: соединение не установлено");
			}
		} catch (error) {
			throw asTelegramUserError(error, this.#secrets());
		} finally {
			if (timer) clearTimeout(timer);
		}
	}

	async isAuthorized(): Promise<boolean> {
		try {
			return await this.#client.checkAuthorization();
		} catch (error) {
			throw asTelegramUserError(error, this.#secrets());
		}
	}

	async signIn(params: TelegramUserSignInParams): Promise<TelegramUserIdentity> {
		const phoneNumber = normalizePhoneNumber(params.phoneNumber);
		if (!phoneNumber) throw new TelegramUserError("phone-required", "номер телефона не задан");

		// Step 1: ask Telegram to send the code. The api_hash goes straight into
		// the request and is never echoed.
		const sent = await this.#invoke(
			new Api.auth.SendCode({
				phoneNumber,
				apiId: this.#apiId,
				apiHash: this.#apiHash,
				settings: new Api.CodeSettings({}),
			}),
		);
		if (sent instanceof Api.auth.SentCodeSuccess) {
			// Telegram decided the account is already logged in.
			return this.me();
		}
		const isCodeViaApp = sent.type instanceof Api.auth.SentCodeTypeApp;
		const phoneCodeHash = sent.phoneCodeHash;
		if (!phoneCodeHash) {
			throw new TelegramUserError("unexpected", "Telegram не вернул идентификатор запроса кода: попробуй войти заново");
		}

		// Step 2: submit the code the user reads in Telegram.
		const code =
			typeof params.phoneCode === "function"
				? String(await params.phoneCode(isCodeViaApp)).trim()
				: String(params.phoneCode ?? "").trim();
		if (!code) throw new TelegramUserError("code-invalid", "код не введён");
		let authorization: Api.auth.TypeAuthorization;
		try {
			authorization = await this.#invoke(new Api.auth.SignIn({ phoneNumber, phoneCodeHash, phoneCode: code }));
		} catch (error) {
			const typed = asTelegramUserError(error, [...this.#secrets(), code]);
			if (typed.code !== "password-needed") throw typed;
			// Step 3: the account has 2FA — ask for the password only now.
			return this.#signInWithPassword(params);
		}
		if (authorization instanceof Api.auth.AuthorizationSignUpRequired) {
			throw new TelegramUserError(
				"phone-not-registered",
				"этот номер не зарегистрирован в Telegram: войти можно только в существующий аккаунт",
			);
		}
		return toIdentity(authorization.user);
	}

	async #signInWithPassword(params: TelegramUserSignInParams): Promise<TelegramUserIdentity> {
		if (params.password === undefined) {
			throw new TelegramUserPasswordNeededError(
				"2FA пароль нужен: у аккаунта включена двухфакторная защита, повтори вход и введи пароль",
			);
		}
		const stored = await this.#invoke(new Api.account.GetPassword());
		const hint = stored.hint ?? undefined;
		const supplied =
			typeof params.password === "function" ? String(await params.password(hint)).trim() : String(params.password ?? "").trim();
		if (!supplied) throw new TelegramUserError("password-invalid", "2FA пароль не введён");
		const check = await computeCheck(stored, supplied);
		let authorization: Api.auth.TypeAuthorization;
		try {
			authorization = await this.#invoke(new Api.auth.CheckPassword({ password: check }));
		} catch (error) {
			throw asTelegramUserError(error, [...this.#secrets(), supplied]);
		}
		if (!(authorization instanceof Api.auth.Authorization)) {
			throw new TelegramUserError("unexpected", "Telegram не подтвердил вход: попробуй войти заново");
		}
		return toIdentity(authorization.user);
	}

	async me(): Promise<TelegramUserIdentity> {
		try {
			return toIdentity(await this.#client.getMe());
		} catch (error) {
			throw asTelegramUserError(error, this.#secrets());
		}
	}

	async logOut(): Promise<void> {
		await this.#invoke(new Api.auth.LogOut());
	}

	async disconnect(): Promise<void> {
		try {
			await this.#client.disconnect();
		} catch {
			// Cleanup must never mask the login error that is already travelling up.
		}
	}

	async exportSessionString(): Promise<string> {
		const value = this.#sessionValue();
		if (!value) {
			throw new TelegramUserError("session-invalid", "Telegram не вернул строку сессии: войди заново");
		}
		return value;
	}

	/** Log-safe: `api_id` and whether a session exists, never the session or hash. */
	toString(): string {
		return `GramJsUserClient(apiId=${this.#apiId}, session=${this.#sessionValue() ? "present" : "absent"})`;
	}

	toJSON(): { client: "gramjs"; apiId: number; hasSession: boolean } {
		return { client: "gramjs", apiId: this.#apiId, hasSession: Boolean(this.#sessionValue()) };
	}

	[Symbol.for("nodejs.util.inspect.custom")](): string {
		return this.toString();
	}
}
