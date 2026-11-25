/**
 * Pure allow/deny/ask policy for the Telegram MCP proxy (#264, step B; argv
 * shape #274).
 *
 * No I/O and no clock of its own: the caller passes the profile, the tool call
 * and a snapshot of the write window/limit counters. That keeps every rule
 * testable without files or a spawned upstream.
 *
 * The call is first normalised by `normalize.ts`; the policy then decides by
 * the resulting command/chat/write view. A normalisation failure is a deny:
 * nothing is forwarded upstream.
 */
import type { TelegramMcpProfileConfig } from "./config.js";
import { commandRequiresChat, normalizeToolCall, type TelegramToolCallView } from "./normalize.js";

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
	/** Chat the normalised call targets. */
	chat?: string;
	/** Write text the normalised call carries. */
	text?: string;
	/** The normalised command, when normalisation succeeded. */
	view?: TelegramToolCallView;
}

export const ALWAYS_ALLOWED_TOOLS = ["tools/list", "telegram_help"] as const;
export const TELEGRAM_MCP_TOOLS = ["telegram_help", "telegram_read", "telegram_write"] as const;

const CHAT_KEYS = ["chat", "chatId", "chat_id", "peer", "to", "recipient", "username", "dialog"] as const;

/**
 * Decide one `tools/call`. `tools/list` is accepted here too because the server
 * routes every method through the same entry point; it is always allowed.
 */
export function decideTelegramMcpCall(input: TelegramMcpPolicyInput): TelegramMcpPolicyDecision {
	const { profile, tool, args, now, limits } = input;
	if (tool === "tools/list" || tool === "telegram_help") {
		return { decision: "allow", reason: `${tool} is always allowed` };
	}
	if (tool !== "telegram_read" && tool !== "telegram_write") {
		return {
			decision: "deny",
			reason:
				`tool "${tool}" is not allowed by the Telegram MCP proxy; allowed tools: ` +
				`${[...TELEGRAM_MCP_TOOLS].join(", ")} (and the always-allowed ${ALWAYS_ALLOWED_TOOLS.join(", ")})`,
		};
	}

	const normalized = normalizeToolCall(tool, args);
	if (!normalized.ok) {
		return { decision: "deny", reason: normalized.reason };
	}
	const view = normalized.view;
	const chat = view.chat;
	const withView = {
		...(chat === undefined ? {} : { chat }),
		...(view.text === undefined ? {} : { text: view.text }),
		view,
	};

	if (tool === "telegram_read") {
		if (chat === undefined) {
			if (!commandRequiresChat(view.command)) {
				return { decision: "allow", ...withView, reason: `telegram command "${view.command}" does not need a chat` };
			}
			return {
				decision: "deny",
				...withView,
				reason: `telegram_read needs a chat argument (one of ${CHAT_KEYS.join(", ")}); allowed chats: ${formatAllowChats(profile)}`,
			};
		}
		if (!profile.allowChats.includes(chat)) {
			return {
				decision: "deny",
				...withView,
				reason: `chat "${chat}" is not in allowChats for profile "${profile.name}"; allowed chats: ${formatAllowChats(profile)}`,
			};
		}
		return { decision: "allow", ...withView, reason: `chat "${chat}" is in allowChats` };
	}

	// telegram_write
	if (profile.allowChats.length > 0 && chat === undefined) {
		return {
			decision: "deny",
			...withView,
			reason:
				`cannot resolve target chat: expected one of ${CHAT_KEYS.join(", ")} ` +
				`to be a string or number; allowed chats: ${formatAllowChats(profile)}`,
		};
	}
	if (profile.mode === "read") {
		return {
			decision: "deny",
			...withView,
			reason: `profile "${profile.name}" is read-only (mode "read"): telegram_write and all other writes are disabled`,
		};
	}
	if (chat !== undefined && !profile.allowChats.includes(chat)) {
		return {
			decision: "deny",
			...withView,
			reason: `chat "${chat}" is not in allowChats for profile "${profile.name}"; allowed chats: ${formatAllowChats(profile)}`,
		};
	}
	if (profile.mode === "write:ask") {
		return {
			decision: "ask",
			...withView,
			reason: `telegram_write needs operator confirmation in mode "write:ask"; nothing was sent`,
		};
	}
	// write:auto
	if (!limits.windowActive) {
		const expired = limits.windowExpiresAt !== undefined && limits.windowExpiresAt <= now;
		return {
			decision: "deny",
			...withView,
			reason:
				`no active write window for profile "${profile.name}"` +
				(expired ? ` (the previous window expired at ${new Date(limits.windowExpiresAt!).toISOString()})` : "") +
				`; write:auto sends only inside an open TTL window`,
		};
	}
	if (limits.writesThisHour >= profile.writeLimitPerHour) {
		return {
			decision: "deny",
			...withView,
			reason:
				`write limit reached for profile "${profile.name}": ` +
				`${limits.writesThisHour}/${profile.writeLimitPerHour} writes this hour; retry in the next hour`,
		};
	}
	return {
		decision: "allow",
		...withView,
		reason: `within the open write window (${limits.writesThisHour}/${profile.writeLimitPerHour} this hour)`,
	};
}

function formatAllowChats(profile: TelegramMcpProfileConfig): string {
	return profile.allowChats.length > 0 ? profile.allowChats.map((chat) => `"${chat}"`).join(", ") : "none";
}
