/**
 * Settings for running the agent as a personal Telegram account (MTProto),
 * next to the bot module (#248).
 *
 * A user session is not a bot token: it is a full login to somebody's account.
 * The `api_hash` is a secret and lives ONLY in the environment (`apiHashEnv`):
 * `alive.config.json` is committed, so a plaintext hash there is a leaked secret.
 * The session file is a credential too and therefore lives under the state
 * directory with restrictive permissions, never next to the code.
 */
import * as path from "node:path";

export interface TelegramUserConfig {
	/** Master switch. Off by default: a user login is never implied by a bot config. */
	enabled: boolean;
	/** `api_id` of the application from my.telegram.org. */
	apiId?: number;
	/** Environment variable holding `api_hash`. The only place the secret may live. */
	apiHashEnv?: string;
	/**
	 * Session file, relative to the state directory (default
	 * `<stateDir>/telegram-user/session`). Absolute paths and `..` are rejected:
	 * the session must never land outside the private state directory.
	 */
	sessionFile?: string;
	/**
	 * Chat allowlist (numeric chat ids or `@username`, as strings). Omitted means
	 * `[]`: nobody. Deliberately optional, because an instance config overrides
	 * the whole block and `{ enabled: true, apiId: 123 }` must stay valid.
	 */
	allowedChatIds?: string[];
}

/** Default sub-path of the session file inside the state directory. */
export const DEFAULT_USER_SESSION_SUBPATH = path.join("telegram-user", "session");

export const DEFAULT_TELEGRAM_USER_CONFIG: TelegramUserConfig = {
	enabled: false,
	apiHashEnv: "TELEGRAM_API_HASH",
	// Spelled out even though it is optional: the default block and the
	// normalised result always carry an array, never `undefined`.
	allowedChatIds: [],
};

/**
 * Validate `modules.telegram.user` the way `validateTelegramConfig` validates the
 * bot block: a bad value fails loudly at load time instead of at login time.
 *
 * `path` only changes the message prefix so the block can be validated on its own.
 */
export function validateTelegramUserConfig(value: unknown, path = "modules.telegram.user"): TelegramUserConfig {
	if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${path} must be an object`);
	const raw = value as Record<string, unknown>;
	if (typeof raw.enabled !== "boolean") {
		throw new Error(`${path}.enabled must be true or false, got "${String(raw.enabled)}"`);
	}
	const out: TelegramUserConfig = { enabled: raw.enabled, allowedChatIds: [] };
	if (raw.apiId !== undefined) {
		if (!Number.isSafeInteger(raw.apiId) || (raw.apiId as number) <= 0) {
			throw new Error(`${path}.apiId must be a positive integer, got "${String(raw.apiId)}"`);
		}
		out.apiId = raw.apiId as number;
	}
	if (raw.apiHashEnv !== undefined) out.apiHashEnv = requireNonEmptyString(raw.apiHashEnv, `${path}.apiHashEnv`);
	if (raw.apiHash !== undefined) throw new Error(apiHashNotSupported(path, out.apiHashEnv));
	if (raw.sessionFile !== undefined) out.sessionFile = validateSessionFile(raw.sessionFile, `${path}.sessionFile`);

	if (raw.allowedChatIds === undefined) return out;
	if (!Array.isArray(raw.allowedChatIds)) {
		throw new Error(`${path}.allowedChatIds must be an array of non-empty chat ids or @usernames`);
	}
	const chatIds: string[] = [];
	const seen = new Set<string>();
	for (const chatId of raw.allowedChatIds) {
		if (typeof chatId !== "string" || !chatId.trim()) {
			throw new Error(`${path}.allowedChatIds must contain only non-empty chat ids or @usernames, as strings`);
		}
		const trimmed = chatId.trim();
		if (seen.has(trimmed)) throw new Error(`${path}.allowedChatIds must not contain duplicates ("${trimmed}")`);
		seen.add(trimmed);
		chatIds.push(trimmed);
	}
	out.allowedChatIds = chatIds;
	return out;
}

function requireNonEmptyString(value: unknown, label: string): string {
	if (typeof value !== "string" || !value.trim()) throw new Error(`${label} must be a non-empty string`);
	return value.trim();
}

/** Environment variable that actually holds `api_hash` for this block. */
function apiHashEnvName(config: Pick<TelegramUserConfig, "apiHashEnv">): string {
	return config.apiHashEnv || DEFAULT_TELEGRAM_USER_CONFIG.apiHashEnv || "TELEGRAM_API_HASH";
}

/**
 * `apiHash` used to be a config field. `alive.config.json` is committed, so a
 * plaintext hash there is a leaked account; refuse the key loudly instead of
 * ignoring it and letting an old config "silently not work". The value itself is
 * never read into the message.
 */
function apiHashNotSupported(prefix: string, apiHashEnv: string | undefined): string {
	const name = apiHashEnvName({ apiHashEnv });
	return `${prefix}.apiHash is not supported: keep api_hash in the environment variable ${name} and remove the key from the config`;
}

/**
 * A session file must stay inside the state directory. Absolute paths would let a
 * typo (or a copied config) put an account credential in the repo or in `/tmp`,
 * and `..` would do the same relative to a writable state dir.
 */
function validateSessionFile(value: unknown, label: string): string {
	if (typeof value !== "string" || !value.trim()) throw new Error(`${label} must be a non-empty string`);
	const trimmed = value.trim();
	if (path.isAbsolute(trimmed)) {
		throw new Error(`${label} must be relative to the state directory, got an absolute path`);
	}
	const normalized = path.normalize(trimmed);
	if (normalized === ".." || normalized.startsWith(`..${path.sep}`) || path.isAbsolute(normalized)) {
		throw new Error(`${label} must stay inside the state directory, ".." is not allowed`);
	}
	return normalized;
}

/**
 * `api_hash` resolution, modelled on `resolveToken` in the bot module: read the
 * environment variable named by `apiHashEnv` and trim it. There is deliberately
 * no config fallback — the secret must not live in a committed file. An empty
 * variable resolves to an empty string. Never logs the value.
 */
export function resolveUserApiHash(config: TelegramUserConfig, env: NodeJS.ProcessEnv = process.env): string {
	const name = apiHashEnvName(config);
	return (env[name] ?? "").trim();
}

/**
 * Absolute path of the session file. The configured path is relative to
 * `stateDir`; the default is `<stateDir>/telegram-user/session`. Anything that
 * resolves outside `stateDir` is refused instead of silently written elsewhere.
 */
export function resolveUserSessionFile(config: TelegramUserConfig, stateDir: string): string {
	const base = path.resolve(stateDir);
	const configured = (config.sessionFile ?? "").trim();
	const target = path.resolve(base, configured || DEFAULT_USER_SESSION_SUBPATH);
	if (target === base || !target.startsWith(base + path.sep)) {
		throw new Error(`telegram user session file must stay inside the state directory ${base}`);
	}
	return target;
}

/**
 * What still blocks a user login. The reasons name the setting, never the
 * `api_hash` or the session path: this string ends up in logs and the dashboard.
 */
export function telegramUserReadiness(
	config: TelegramUserConfig,
	env: NodeJS.ProcessEnv = process.env,
): { ok: boolean; reason?: string } {
	if (!config.enabled) return { ok: false, reason: "modules.telegram.user is disabled" };
	if (!Number.isSafeInteger(config.apiId) || (config.apiId as number) <= 0) {
		return { ok: false, reason: "modules.telegram.user.apiId is not set (api_id from my.telegram.org)" };
	}
	if (!resolveUserApiHash(config, env)) {
		return {
			ok: false,
			reason: `modules.telegram.user has no api_hash: set the environment variable ${apiHashEnvName(config)}`,
		};
	}
	return { ok: true };
}
