/**
 * Pure allow/deny/ask policy for the Telegram MCP proxy (#264, step B).
 *
 * No I/O and no clock of its own: the caller passes the profile, the tool call
 * and a snapshot of the write window/limit counters. That keeps every rule
 * testable without files or a spawned upstream.
 */
import type { TelegramMcpProfileConfig } from "./config.js";

export type TelegramMcpDecisionKind = "allow" | "deny" | "ask";

export interface TelegramMcpLimitsSnapshot {
	/** A write window is open at `now`. */
	windowActive: boolean;
	/** Epoch milliseconds when the window expires, if one was ever opened. */
	windowExpiresAt?: number;
	/** Writes already counted in the current hour. */
	writesThisHour: number;
}

export interface TelegramMcpPolicyInput {
	profile: TelegramMcpProfileConfig;
	/** Tool name as sent to `tools/call`. */
	tool: string;
	args: Record<string, unknown>;
	now: number;
	limits: TelegramMcpLimitsSnapshot;
}

export interface TelegramMcpPolicyDecision {
	decision: TelegramMcpDecisionKind;
	reason: string;
	/** Chat the call targets, as the client passed it (when one was found). */
	chat?: string;
}

export const ALWAYS_ALLOWED_TOOLS = ["tools/list", "telegram_help"] as const;
export const TELEGRAM_MCP_TOOLS = ["telegram_help", "telegram_read", "telegram_write"] as const;

const CHAT_KEYS = ["chat", "chatId", "chat_id", "peer", "to", "recipient", "username", "dialog"] as const;
const RECIPIENT_LIST_KEYS = ["recipients", "recipient", "to", "chats", "chatIds", "chat_ids", "targets", "users", "userIds", "contacts"] as const;
const ACTION_KEYS = ["action", "operation", "op", "method", "type"] as const;

/**
 * Decide one `tools/call`. `tools/list` is accepted here too because the server
 * routes every method through the same entry point; it is always allowed.
 */
export function decideTelegramMcpCall(input: TelegramMcpPolicyInput): TelegramMcpPolicyDecision {
	const { profile, tool, args, now, limits } = input;
	if (tool === "tools/list" || tool === "telegram_help") {
		return { decision: "allow", reason: `${tool} is always allowed` };
	}
	if (tool === "telegram_read") {
		const chat = extractChat(args);
		if (chat === undefined) {
			return {
				decision: "deny",
				reason: `telegram_read needs a chat argument (one of ${CHAT_KEYS.join(", ")}); allowed chats: ${formatAllowChats(profile)}`,
			};
		}
		if (!profile.allowChats.includes(chat)) {
			return {
				decision: "deny",
				chat,
				reason: `chat "${chat}" is not in allowChats for profile "${profile.name}"; allowed chats: ${formatAllowChats(profile)}`,
			};
		}
		return { decision: "allow", chat, reason: `chat "${chat}" is in allowChats` };
	}
	if (tool === "telegram_write") {
		const chat = extractChat(args);
		const blacklist = blacklistReason(args);
		if (blacklist) return { decision: "deny", ...(chat === undefined ? {} : { chat }), reason: blacklist };
		if (profile.mode === "read") {
			return {
				decision: "deny",
				...(chat === undefined ? {} : { chat }),
				reason: `profile "${profile.name}" is read-only (mode "read"): telegram_write and all other writes are disabled`,
			};
		}
		if (chat !== undefined && !profile.allowChats.includes(chat)) {
			return {
				decision: "deny",
				chat,
				reason: `chat "${chat}" is not in allowChats for profile "${profile.name}"; allowed chats: ${formatAllowChats(profile)}`,
			};
		}
		if (profile.mode === "write:ask") {
			return {
				decision: "ask",
				...(chat === undefined ? {} : { chat }),
				reason: `telegram_write needs operator confirmation in mode "write:ask"; nothing was sent`,
			};
		}
		// write:auto
		if (!limits.windowActive) {
			const expired = limits.windowExpiresAt !== undefined && limits.windowExpiresAt <= now;
			return {
				decision: "deny",
				...(chat === undefined ? {} : { chat }),
				reason:
					`no active write window for profile "${profile.name}"` +
					(expired ? ` (the previous window expired at ${new Date(limits.windowExpiresAt!).toISOString()})` : "") +
					`; write:auto sends only inside an open TTL window`,
			};
		}
		if (limits.writesThisHour >= profile.writeLimitPerHour) {
			return {
				decision: "deny",
				...(chat === undefined ? {} : { chat }),
				reason:
					`write limit reached for profile "${profile.name}": ` +
					`${limits.writesThisHour}/${profile.writeLimitPerHour} writes this hour; retry in the next hour`,
			};
		}
		return {
			decision: "allow",
			...(chat === undefined ? {} : { chat }),
			reason: `within the open write window (${limits.writesThisHour}/${profile.writeLimitPerHour} this hour)`,
		};
	}
	return {
		decision: "deny",
		reason:
			`tool "${tool}" is not allowed by the Telegram MCP proxy; allowed tools: ` +
			`${[...TELEGRAM_MCP_TOOLS].join(", ")} (and the always-allowed ${ALWAYS_ALLOWED_TOOLS.join(", ")})`,
	};
}

/**
 * Always-deny operations: mass sends, invites/joins/leaves, and deleting chats.
 * Checked before the profile mode so a write:auto profile cannot be talked into
 * them either.
 */
export function blacklistReason(args: Record<string, unknown>): string | undefined {
	for (const key of RECIPIENT_LIST_KEYS) {
		const value = args[key];
		if (Array.isArray(value) && value.length > 1) {
			return `mass send denied: "${key}" lists ${value.length} recipients; only one recipient per call is allowed`;
		}
		if (typeof value === "string" && value.includes(",") && value.split(",").filter((part) => part.trim()).length > 1) {
			return `mass send denied: "${key}" lists multiple recipients; only one recipient per call is allowed`;
		}
	}
	if (args.broadcast === true || args.mass === true || args.sendToMany === true || args.send_to_many === true) {
		return "mass send denied: broadcast/mass sending is not allowed";
	}
	const action = ACTION_KEYS.map((key) => args[key]).find((value): value is string => typeof value === "string");
	if (action) {
		const normalized = action
			.replace(/([a-z0-9])([A-Z])/g, "$1_$2")
			.toLowerCase()
			.replace(/[\s-]+/g, "_");
		if (/(^|_)invite(_|$)/.test(normalized) || /(^|_)join(_|$)/.test(normalized)) {
			return `"${action}" is denied: inviting or joining chats is not allowed`;
		}
		if (/(^|_)(leave|kick|ban)(_|$)/.test(normalized)) {
			return `"${action}" is denied: leaving, kicking or banning is not allowed`;
		}
		if (/(delete|remove)_(chat|dialog|conversation)/.test(normalized)) {
			return `"${action}" is denied: deleting chats is not allowed`;
		}
	}
	return undefined;
}

/** Chat as the client sent it, from the first known chat field. */
export function extractChat(args: Record<string, unknown>): string | undefined {
	for (const key of CHAT_KEYS) {
		const value = args[key];
		if (typeof value === "string") return value;
		if (typeof value === "number" && Number.isFinite(value)) return String(value);
	}
	return undefined;
}

/** Text a write carries, for the audit preview and byte count. */
export function extractWriteText(args: Record<string, unknown>): string | undefined {
	for (const key of ["text", "message", "caption", "content"]) {
		const value = args[key];
		if (typeof value === "string") return value;
	}
	return undefined;
}

function formatAllowChats(profile: TelegramMcpProfileConfig): string {
	return profile.allowChats.length > 0 ? profile.allowChats.map((chat) => `"${chat}"`).join(", ") : "none";
}
