/**
 * Settings for the MCP-aware proxy between an agent VM and the host's Telegram
 * account (#264, step B).
 *
 * The proxy never holds a Telegram session itself: it spawns `telegram mcp`
 * (better-tg-cli) on the host, one child per profile, and gives the sandbox a
 * narrow HTTP channel. Consequently this block contains no secret fields at
 * all; bearer tokens live under `<stateDir>/telegram-mcp/tokens.json` and are
 * issued with `alive telegram-mcp token <profile>`.
 */
export type TelegramMcpMode = "read" | "write:ask" | "write:auto";

/**
 * Operator-confirmation card for `write:ask` profiles (#264, step B2).
 *
 * The proxy and the Telegram runtime are different host processes. They share
 * one directory of ticket files: the proxy writes a pending ticket, the module
 * of the same profile shows the card in Telegram and writes the decision, and
 * the proxy performs the write only after an approval.
 */
export interface TelegramMcpConfirmationConfig {
	/**
	 * Directory of ticket/decision files. A relative path is resolved against
	 * `paths.stateDir`; an absolute path is used as-is. The runtime option
	 * `modules.telegram.mcpConfirmation.ticketDir` must name the same directory.
	 */
	ticketDir: string;
	/** How long the proxy waits for the operator. Default 5 min, maximum 1 hour. */
	ttlMs: number;
}

/** Runtime side of the confirmation card: enabled only when this block exists. */
export interface TelegramMcpConfirmationRuntimeConfig {
	/** Root directory shared with the proxy profile `confirmation.ticketDir`. */
	ticketDir: string;
	/** The only thread a confirmation card is sent to, and the only chat a press is accepted from. */
	chatId: number;
	/** Non-empty list of Telegram user ids allowed to press the card's buttons. */
	operatorUserIds: number[];
	/** How often the module scans ticketDir for new cards. Default 2000 ms. */
	pollMs: number;
}

export interface TelegramMcpProfileConfig {
	/** Profile name, also the selector for `alive telegram-mcp token <profile>`. */
	name: string;
	/** What the profile may do. Default: `write:ask`. */
	mode: TelegramMcpMode;
	/**
	 * When set on a `write:ask` profile, an ask creates a ticket and blocks until
	 * the runtime module writes a decision (or the ticket expires). Without this
	 * block the old ticket-id-only ask answer is kept.
	 */
	confirmation?: TelegramMcpConfirmationConfig;
	/** Chats `telegram_read` may read. Empty means none. Exact string match. */
	allowChats: string[];
	/** How long a write window stays open after it was opened. */
	writeTtlMs: number;
	/** Maximum `telegram_write` calls in one rolling hour. */
	writeLimitPerHour: number;
	/** Upstream binary. Default: `telegram`. */
	command: string;
	/** Upstream arguments. Default: `["mcp"]`. */
	args: string[];
	/**
	 * Extra environment variables for the upstream child (#264 guards).
	 *
	 * This is the only way to add a variable beyond the fixed exact-name
	 * allowlist in `child.ts` (see `UPSTREAM_ENV_ALLOWLIST`: process, locale,
	 * XDG, temp and proxy variables; no Telegram credentials). There are no prefix
	 * or wildcard rules. Values are plain strings: no nesting and no
	 * interpolation.
	 */
	env?: Record<string, string>;
}

export interface TelegramMcpConfig {
	/** Master switch. Off by default: no listener and no upstream child without it. */
	enabled: boolean;
	/** Listener host. Default: 127.0.0.1. */
	host: string;
	/** Listener port. Default: 8787. */
	port: number;
	/** One HTTP bearer token and one upstream child per profile. */
	profiles: TelegramMcpProfileConfig[];
}

export const DEFAULT_TELEGRAM_MCP_WRITE_TTL_MS = 15 * 60_000;
export const DEFAULT_TELEGRAM_MCP_WRITE_LIMIT_PER_HOUR = 20;
export const DEFAULT_TELEGRAM_MCP_CONFIRMATION_TTL_MS = 5 * 60_000;
export const MAX_TELEGRAM_MCP_CONFIRMATION_TTL_MS = 60 * 60_000;
export const DEFAULT_TELEGRAM_MCP_CONFIRMATION_POLL_MS = 2_000;

export const DEFAULT_TELEGRAM_MCP_CONFIG: TelegramMcpConfig = {
	enabled: false,
	host: "127.0.0.1",
	port: 8787,
	profiles: [],
};

const MODES: readonly TelegramMcpMode[] = ["read", "write:ask", "write:auto"];
const PROFILE_NAME = /^[A-Za-z0-9_-]+$/;

/**
 * Validate `modules.telegram.mcp` next to `validateTelegramConfig`: a bad value
 * fails at load time, not when the first sandboxed agent tries to write.
 */
export function validateTelegramMcpConfig(
	value: unknown,
	path = "modules.telegram.mcp",
): TelegramMcpConfig {
	if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${path} must be an object`);
	const raw = value as Record<string, unknown>;
	if (typeof raw.enabled !== "boolean") {
		throw new Error(`${path}.enabled must be true or false, got "${String(raw.enabled)}"`);
	}
	const host = raw.host === undefined ? DEFAULT_TELEGRAM_MCP_CONFIG.host : requireNonEmptyString(raw.host, `${path}.host`);
	const port = raw.port === undefined ? DEFAULT_TELEGRAM_MCP_CONFIG.port : raw.port;
	if (!Number.isSafeInteger(port) || (port as number) < 1 || (port as number) > 65535) {
		throw new Error(`${path}.port must be an integer between 1 and 65535, got "${String(raw.port)}"`);
	}
	if (raw.profiles === undefined) {
		throw new Error(`${path}.profiles must be an array of profile objects`);
	}
	if (!Array.isArray(raw.profiles)) throw new Error(`${path}.profiles must be an array of profile objects`);
	const profiles: TelegramMcpProfileConfig[] = [];
	const seen = new Set<string>();
	for (const [index, entry] of raw.profiles.entries()) {
		const profilePath = `${path}.profiles[${index}]`;
		if (!entry || typeof entry !== "object" || Array.isArray(entry)) throw new Error(`${profilePath} must be an object`);
		const profile = validateProfile(entry as Record<string, unknown>, profilePath);
		if (seen.has(profile.name)) throw new Error(`${path}.profiles must not contain duplicate profile names ("${profile.name}")`);
		seen.add(profile.name);
		profiles.push(profile);
	}
	return { enabled: raw.enabled, host, port: port as number, profiles };
}

function validateProfile(raw: Record<string, unknown>, path: string): TelegramMcpProfileConfig {
	const name = requireNonEmptyString(raw.name, `${path}.name`);
	if (!PROFILE_NAME.test(name)) {
		throw new Error(`${path}.name must contain only letters, digits, "_" and "-", got "${name}"`);
	}
	const mode = raw.mode === undefined ? "write:ask" : raw.mode;
	if (typeof mode !== "string" || !MODES.includes(mode as TelegramMcpMode)) {
		throw new Error(`${path}.mode must be "read", "write:ask" or "write:auto", got "${String(raw.mode)}"`);
	}
	const allowChats: string[] = [];
	if (raw.allowChats !== undefined) {
		if (!Array.isArray(raw.allowChats)) {
			throw new Error(`${path}.allowChats must be an array of non-empty chat ids or @usernames`);
		}
		const chats = new Set<string>();
		for (const chat of raw.allowChats) {
			if (typeof chat !== "string" || !chat.trim()) {
				throw new Error(`${path}.allowChats must contain only non-empty chat ids or @usernames, as strings`);
			}
			const value = chat.trim();
			if (chats.has(value)) throw new Error(`${path}.allowChats must not contain duplicates ("${value}")`);
			chats.add(value);
			allowChats.push(value);
		}
	}
	const confirmation = validateConfirmation(raw.confirmation, `${path}.confirmation`);
	const writeTtlMs = positiveInteger(raw.writeTtlMs, `${path}.writeTtlMs`, DEFAULT_TELEGRAM_MCP_WRITE_TTL_MS);
	const writeLimitPerHour = positiveInteger(
		raw.writeLimitPerHour,
		`${path}.writeLimitPerHour`,
		DEFAULT_TELEGRAM_MCP_WRITE_LIMIT_PER_HOUR,
	);
	const command = raw.command === undefined ? "telegram" : requireNonEmptyString(raw.command, `${path}.command`);
	const env = validateProfileEnv(raw.env, `${path}.env`);
	let args = ["mcp"];
	if (raw.args !== undefined) {
		if (!Array.isArray(raw.args) || !raw.args.every((arg) => typeof arg === "string")) {
			throw new Error(`${path}.args must be an array of strings`);
		}
		args = [...(raw.args as string[])];
	}
	return {
		name,
		mode: mode as TelegramMcpMode,
		...(confirmation === undefined ? {} : { confirmation }),
		allowChats,
		writeTtlMs,
		writeLimitPerHour,
		command,
		args,
		...(env === undefined ? {} : { env }),
	};
}

function validateConfirmation(value: unknown, path: string): TelegramMcpConfirmationConfig | undefined {
	if (value === undefined) return undefined;
	if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${path} must be an object`);
	const raw = value as Record<string, unknown>;
	const ticketDir = requireNonEmptyString(raw.ticketDir, `${path}.ticketDir`);
	const ttlMs = raw.ttlMs === undefined ? DEFAULT_TELEGRAM_MCP_CONFIRMATION_TTL_MS : raw.ttlMs;
	if (!Number.isSafeInteger(ttlMs) || (ttlMs as number) <= 0 || (ttlMs as number) > MAX_TELEGRAM_MCP_CONFIRMATION_TTL_MS) {
		throw new Error(
			`${path}.ttlMs must be an integer between 1 and ${MAX_TELEGRAM_MCP_CONFIRMATION_TTL_MS} ms (1 hour), got "${String(raw.ttlMs)}"`,
		);
	}
	return { ticketDir, ttlMs: ttlMs as number };
}

/**
 * Validate `modules.telegram.mcpConfirmation`: absent is the disabled default,
 * and no timer or directory read happens in that case.
 */
export function validateTelegramMcpConfirmationRuntimeConfig(
	value: unknown,
	path = "modules.telegram.mcpConfirmation",
): TelegramMcpConfirmationRuntimeConfig {
	if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${path} must be an object`);
	const raw = value as Record<string, unknown>;
	const ticketDir = requireNonEmptyString(raw.ticketDir, `${path}.ticketDir`);
	const chatId = raw.chatId;
	if (!Number.isSafeInteger(chatId) || (chatId as number) === 0) {
		throw new Error(`${path}.chatId must be a non-zero integer Telegram chat id, got "${String(raw.chatId)}"`);
	}
	if (!Array.isArray(raw.operatorUserIds) || raw.operatorUserIds.length === 0) {
		throw new Error(`${path}.operatorUserIds must be a non-empty array of Telegram user ids`);
	}
	const operatorUserIds: number[] = [];
	const seenOperators = new Set<number>();
	for (const entry of raw.operatorUserIds) {
		if (!Number.isSafeInteger(entry) || (entry as number) <= 0) {
			throw new Error(`${path}.operatorUserIds must contain positive integer user ids, got "${String(entry)}"`);
		}
		const userId = entry as number;
		if (seenOperators.has(userId)) throw new Error(`${path}.operatorUserIds must not contain duplicates (${userId})`);
		seenOperators.add(userId);
		operatorUserIds.push(userId);
	}
	const pollMs = raw.pollMs === undefined ? DEFAULT_TELEGRAM_MCP_CONFIRMATION_POLL_MS : raw.pollMs;
	if (!Number.isSafeInteger(pollMs) || (pollMs as number) <= 0) {
		throw new Error(`${path}.pollMs must be a positive integer, got "${String(raw.pollMs)}"`);
	}
	return { ticketDir, chatId: chatId as number, operatorUserIds, pollMs: pollMs as number };
}

/** Profile env is a flat string map; values are never coerced or nested. */
function validateProfileEnv(value: unknown, path: string): Record<string, string> | undefined {
	if (value === undefined) return undefined;
	if (!value || typeof value !== "object" || Array.isArray(value)) {
		throw new Error(`${path} must be an object mapping variable names to strings`);
	}
	const env: Record<string, string> = {};
	for (const [key, entry] of Object.entries(value)) {
		if (!key.trim()) throw new Error(`${path} must not contain an empty variable name`);
		if (typeof entry !== "string") {
			throw new Error(`${path}.${key} must be a string, got "${typeof entry}"`);
		}
		env[key] = entry;
	}
	return env;
}

function positiveInteger(value: unknown, path: string, fallback: number): number {
	if (value === undefined) return fallback;
	if (!Number.isSafeInteger(value) || (value as number) <= 0) {
		throw new Error(`${path} must be a positive integer, got "${String(value)}"`);
	}
	return value as number;
}

function requireNonEmptyString(value: unknown, path: string): string {
	if (typeof value !== "string" || !value.trim()) throw new Error(`${path} must be a non-empty string`);
	return value.trim();
}
