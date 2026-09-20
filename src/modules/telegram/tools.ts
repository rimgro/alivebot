import * as fs from "node:fs";
import * as path from "node:path";
import { Type } from "typebox";
import { defineTool, type AgentToolResult, type ToolDefinition } from "@earendil-works/pi-coding-agent";
import type { HistoryStore } from "../../store/history.js";
import { ensureDir, iso, parseTimeSpec, truncate } from "../../util.js";
import type { TelegramApi } from "./client.js";
import type { TelegramChat, TelegramChatMember, TelegramSentMessage } from "./types.js";
import { formatThread, parseThread, resolveChatTarget } from "./threads.js";
import { describeAttachment } from "./update.js";

export interface TelegramToolHost {
	readonly api: TelegramApi;
	readonly history: HistoryStore;
	readonly workspaceDir: string;
	readonly defaultParseMode: string;
	readonly maxMessageChars: number;
	sendText(input: { thread: string; text: string; replyTo?: number }): Promise<TelegramSentMessage[]>;
	sendFile(input: { thread: string; filePath: string; caption?: string; as?: "document" | "photo" | "audio" | "video"; replyTo?: number }): Promise<TelegramSentMessage>;
	upsertChat(chat: TelegramChat): void;
	typing(thread: string): void;
	botIdentity(): { id?: number; username?: string; name?: string };
	snapshot(): Record<string, unknown>;
}

type ToolResult = AgentToolResult<Record<string, unknown>>;

function ok(text: string, details: Record<string, unknown> = {}): ToolResult {
	return { content: [{ type: "text", text }], details };
}

const ACTION = Type.Union([
	Type.Literal("me"),
	Type.Literal("list_chats"),
	Type.Literal("chat_info"),
	Type.Literal("resolve_chat"),
	Type.Literal("history"),
	Type.Literal("search"),
	Type.Literal("members"),
	Type.Literal("member"),
	Type.Literal("send"),
	Type.Literal("send_file"),
	Type.Literal("edit"),
	Type.Literal("delete"),
	Type.Literal("forward"),
	Type.Literal("react"),
	Type.Literal("typing"),
	Type.Literal("pin"),
	Type.Literal("unpin"),
	Type.Literal("download_file"),
	Type.Literal("set_commands"),
]);

/**
 * The Telegram tool.
 *
 * `send_message` already delivers the agent's replies to Telegram threads; this
 * tool is for everything around that: reading the durable chat history that the
 * module records, introspecting chats and members, and the Telegram-only actions
 * (reactions, pins, file downloads, proactive sends to a new chat).
 */
export function createTelegramTools(host: TelegramToolHost): ToolDefinition[] {
	const api = host.api;

	const telegram = defineTool({
		name: "telegram",
		label: "Telegram",
		description:
			"Telegram integration: read chat history, inspect chats and members, and use Telegram-only actions.\n" +
			"Threads look like `telegram:<chatId>` (or `telegram:<chatId>/<topicId>` for forum topics).\n" +
			"`history` reads the local durable log of everything this bot saw and sent, newest first by default. " +
			"Use `action:\"list_chats\"` first to discover conversations, then `history` with a chat or thread.\n" +
			"`send_file` uploads a file from the workspace as a document/photo/audio/video with an optional caption. " +
			"To answer a human, prefer `send_message` (it routes to Telegram automatically); `send`/`send_file` are for reaching a chat you were not addressed in.",
		parameters: Type.Object({
			action: ACTION,
			/** Chat: full thread (`telegram:-100…`), bare id, or `@username`. */
			chat: Type.Optional(Type.String({ description: "Chat target: thread id, chat id, or @username." })),
			text: Type.Optional(Type.String({ description: "Message body for send/edit." })),
			message_id: Type.Optional(Type.Number({ description: "Telegram message id for edit/delete/react/pin/unpin." })),
			reply_to: Type.Optional(Type.Number({ description: "Telegram message id to reply to when sending." })),
			topic: Type.Optional(Type.Number({ description: "Forum topic id (message_thread_id) for send/forward." })),
			path: Type.Optional(Type.String({ description: "Local file path inside the workspace for `send_file`." })),
			caption: Type.Optional(Type.String({ description: "Caption for `send_file`." })),
			as: Type.Optional(
				Type.Union([Type.Literal("document"), Type.Literal("photo"), Type.Literal("audio"), Type.Literal("video")], {
					description: "How Telegram should treat the file. Defaults from the extension.",
				}),
			),
			query: Type.Optional(Type.String({ description: "Substring to search for in history." })),
			limit: Type.Optional(Type.Number({ description: "Max results (default 30, max 200)." })),
			before: Type.Optional(Type.Number({ description: "Only messages older than this Telegram message id." })),
			after: Type.Optional(Type.Number({ description: "Only messages newer than this Telegram message id." })),
			since: Type.Optional(Type.String({ description: "Lower time bound: ISO timestamp or relative like 2h, 1d." })),
			until: Type.Optional(Type.String({ description: "Upper time bound: ISO timestamp or relative like 30m." })),
			user_id: Type.Optional(Type.Number({ description: "Telegram user id for `member`." })),
			emoji: Type.Optional(Type.String({ description: "Reaction emoji for `react`." })),
			file_id: Type.Optional(Type.String({ description: "Telegram file_id for `download_file`." })),
			name: Type.Optional(Type.String({ description: "File name hint for `download_file`." })),
			direction: Type.Optional(Type.Union([Type.Literal("inbound"), Type.Literal("outbound")], { description: "Filter history by direction." })),
			order: Type.Optional(Type.Union([Type.Literal("asc"), Type.Literal("desc")], { description: "History order, default desc." })),
			from_chat: Type.Optional(Type.String({ description: "Source chat for `forward`." })),
			to_chat: Type.Optional(Type.String({ description: "Destination chat for `forward`." })),
			commands: Type.Optional(
				Type.Array(Type.Object({ command: Type.String(), description: Type.String() }), {
					description: "Bot commands for `set_commands`.",
				}),
			),
		}),
		execute: async (_toolCallId, params): Promise<ToolResult> => {
			switch (params.action) {
				case "me": {
					const identity = host.botIdentity();
					return ok(
						`Telegram bot ${identity.name ?? ""}${identity.username ? ` (@${identity.username})` : ""} id=${identity.id ?? "?"}\n` +
							JSON.stringify(host.snapshot(), null, 2),
						{ bot: identity, status: host.snapshot() },
					);
				}
				case "list_chats": {
					const limit = clamp(params.limit ?? 30, 1, 200);
					const threads = host.history.threads({ module: "telegram" }).slice(0, limit);
					if (threads.length === 0) return ok("No Telegram chats recorded yet.", { count: 0 });
					const lines = threads.map((thread) => {
						const meta = thread.meta ?? {};
						const title = thread.title || String(meta.chatTitle ?? thread.thread);
						return `- ${thread.thread} — ${title} [${String(meta.chatType ?? "?")}] · ${thread.messageCount} msgs · last ${iso(thread.lastMessageAt)}`;
					});
					return ok(lines.join("\n"), { count: threads.length, threads });
				}
				case "chat_info":
				case "resolve_chat": {
					const chat = await api.getChat({ chat_id: chatTarget(params.chat) });
					host.upsertChat(chat);
					const known = host.history.thread(threadOf(chat, params.topic));
					let count: number | undefined;
					try {
						count = await api.getChatMemberCount({ chat_id: chat.id });
					} catch {
						count = undefined;
					}
					const details = {
						chat: {
							id: chat.id,
							type: chat.type,
							title: chat.title,
							username: chat.username,
							firstName: chat.first_name,
							lastName: chat.last_name,
							description: chat.description,
							isForum: chat.is_forum,
							members: count,
						},
						thread: known
							? { id: known.thread, messages: known.messageCount, lastMessageAt: known.lastMessageAt }
							: null,
					};
					const label = chat.title ?? [chat.first_name, chat.last_name].filter(Boolean).join(" ") ?? `@${chat.username ?? chat.id}`;
					return ok(
						`${label} [${chat.type}] id=${chat.id}${chat.username ? ` @${chat.username}` : ""}` +
							`${count === undefined ? "" : ` · ${count} members`}` +
							`\nthread: ${threadOf(chat, params.topic)}` +
							(known ? `\nlocal history: ${known.messageCount} messages, last ${iso(known.lastMessageAt)}` : "\nlocal history: none"),
						details,
					);
				}
				case "history": {
					const records = host.history.query({
						thread: params.chat ? threadTarget(params.chat, params.topic) : undefined,
						module: params.chat ? undefined : "telegram",
						direction: params.direction,
						search: params.query,
						before: params.before !== undefined ? String(params.before) : undefined,
						after: params.after !== undefined ? String(params.after) : undefined,
						since: params.since ? parseTimeSpec(params.since) : undefined,
						until: params.until ? parseTimeSpec(params.until) : undefined,
						limit: clamp(params.limit ?? 30, 1, 200),
						order: params.order ?? "desc",
					});
					if (records.length === 0) return ok("No messages matched.", { count: 0, messages: [] });
					return ok(formatTranscript(records), { count: records.length, messages: records });
				}
				case "search": {
					if (!params.query) throw new Error("`query` is required for search");
					const records = host.history.query({
						module: "telegram",
						search: params.query,
						limit: clamp(params.limit ?? 30, 1, 200),
						order: "desc",
					});
					if (records.length === 0) return ok(`No messages match "${params.query}".`, { count: 0 });
					return ok(`${records.length} match(es) for "${params.query}":\n\n${formatTranscript(records)}`, {
						count: records.length,
						messages: records,
					});
				}
				case "members": {
					const chatId = chatTarget(params.chat);
					const [admins, count] = await Promise.all([
						api.getChatAdministrators({ chat_id: chatId }),
						api.getChatMemberCount({ chat_id: chatId }).catch(() => undefined),
					]);
					const lines = admins.slice(0, clamp(params.limit ?? 50, 1, 200)).map((member) => `- ${memberName(member)} id=${member.user.id} [${member.status}]${member.custom_title ? ` "${member.custom_title}"` : ""}`);
					return ok(
						`${count === undefined ? "" : `${count} members total. `}Administrators (${admins.length}):\n${lines.join("\n") || "- none"}`,
						{ count, administrators: admins.map((m) => ({ id: m.user.id, name: memberName(m), status: m.status })) },
					);
				}
				case "member": {
					if (params.user_id === undefined) throw new Error("`user_id` is required for member");
					const member = await api.getChatMember({ chat_id: chatTarget(params.chat), user_id: params.user_id });
					return ok(`${memberName(member)} id=${member.user.id} [${member.status}]`, { member });
				}
				case "send": {
					if (!params.text?.trim()) throw new Error("`text` is required for send");
					if (!params.chat) throw new Error("`chat` is required for send");
					const thread = threadTarget(params.chat, params.topic);
					const sent = await host.sendText({ thread, text: params.text, replyTo: params.reply_to });
					return ok(`Sent ${sent.length} message(s) to ${thread}.`, {
						thread,
						messageIds: sent.map((m) => m.message_id),
					});
				}
				case "send_file": {
					if (!params.path?.trim()) throw new Error("`path` is required for send_file");
					if (!params.chat) throw new Error("`chat` is required for send_file");
					const thread = threadTarget(params.chat, params.topic);
					const sent = await host.sendFile({
						thread,
						filePath: params.path,
						caption: params.caption,
						as: params.as,
						replyTo: params.reply_to,
					});
					return ok(`Sent file to ${thread} (message ${sent.message_id}).`, {
						thread,
						messageId: sent.message_id,
					});
				}
				case "edit": {
					if (params.message_id === undefined) throw new Error("`message_id` is required for edit");
					if (!params.text?.trim()) throw new Error("`text` is required for edit");
					const result = await api.editMessageText({
						chat_id: chatTarget(params.chat),
						message_id: params.message_id,
						text: params.text,
						parse_mode: host.defaultParseMode || undefined,
					});
					return ok(`Edited message ${params.message_id}.`, { result });
				}
				case "delete": {
					if (params.message_id === undefined) throw new Error("`message_id` is required for delete");
					const deleted = await api.deleteMessage({ chat_id: chatTarget(params.chat), message_id: params.message_id });
					return ok(deleted ? `Deleted message ${params.message_id}.` : "Message was not deleted.", { deleted });
				}
				case "forward": {
					if (params.message_id === undefined) throw new Error("`message_id` is required for forward");
					const from = params.from_chat ?? params.chat;
					const to = params.to_chat ?? params.chat;
					if (!from || !to) throw new Error("`from_chat` and `to_chat` are required for forward");
					const forwarded = await api.forwardMessage({
						chat_id: chatTarget(to),
						from_chat_id: chatTarget(from),
						message_id: params.message_id,
						message_thread_id: params.topic,
					});
					return ok(`Forwarded message ${params.message_id} to ${to} (new id ${forwarded.message_id}).`, {
						messageId: forwarded.message_id,
					});
				}
				case "react": {
					if (params.message_id === undefined) throw new Error("`message_id` is required for react");
					if (!params.emoji) throw new Error("`emoji` is required for react");
					const done = await api.setMessageReaction({
						chat_id: chatTarget(params.chat),
						message_id: params.message_id,
						reaction: [{ type: "emoji", emoji: params.emoji }],
					});
					return ok(done ? `Reacted with ${params.emoji}.` : "Reaction was not applied.", { emoji: params.emoji });
				}
				case "typing": {
					const thread = threadTarget(params.chat, params.topic);
					host.typing(thread);
					return ok(`Typing indicator started for ${thread}.`, { thread });
				}
				case "pin":
				case "unpin": {
					if (params.message_id === undefined) throw new Error("`message_id` is required for pin/unpin");
					const chatId = chatTarget(params.chat);
					const done =
						params.action === "pin"
							? await api.pinChatMessage({ chat_id: chatId, message_id: params.message_id })
							: await api.unpinChatMessage({ chat_id: chatId, message_id: params.message_id });
					return ok(done ? `${params.action === "pin" ? "Pinned" : "Unpinned"} message ${params.message_id}.` : "No change.", { done });
				}
				case "download_file": {
					if (!params.file_id) throw new Error("`file_id` is required for download_file");
					const file = await api.getFile({ file_id: params.file_id });
					if (!file.file_path) throw new Error("Telegram returned no file_path for this file");
					const maxBytes = 25 * 1024 * 1024;
					if (file.file_size !== undefined && file.file_size > maxBytes) {
						throw new Error(`file is ${file.file_size} bytes, over the ${maxBytes} byte download limit`);
					}
					const buffer = await api.downloadFile(file.file_path, { maxBytes });
					const dir = path.join(host.workspaceDir, "telegram-files");
					ensureDir(dir);
					const target = path.join(dir, safeFileName(params.name ?? path.basename(file.file_path)));
					fs.writeFileSync(target, buffer);
					return ok(`Downloaded ${buffer.length} bytes to ${target}`, {
						path: target,
						bytes: buffer.length,
						filePath: file.file_path,
					});
				}
				case "set_commands": {
					const commands = (params.commands ?? []).map((entry) => ({
						command: entry.command.replace(/^\//, "").toLowerCase(),
						description: entry.description,
					}));
					if (commands.length === 0) throw new Error("`commands` is required for set_commands");
					for (const command of commands) {
						if (!/^[a-z0-9_]{1,32}$/.test(command.command)) {
							throw new Error(`invalid command name "${command.command}" (use a-z, 0-9, _, max 32 chars)`);
						}
					}
					const done = await api.setMyCommands({ commands });
					return ok(`Registered ${commands.length} command(s).`, { commands, done });
				}
				default:
					throw new Error(`Unknown action ${String(params.action)}`);
			}
		},
	});

	return [telegram] as ToolDefinition[];
}

function chatTarget(chat: string | undefined): string | number {
	if (!chat) throw new Error("`chat` is required for this action");
	return resolveChatTarget(chat);
}

function threadTarget(chat: string | undefined, topic?: number): string {
	if (!chat) throw new Error("`chat` is required for this action");
	const ref = parseThread(chat);
	if (ref) return topic !== undefined ? formatThread(ref.chatId, topic) : ref.raw;
	return formatThread(resolveChatTarget(chat), topic);
}

function threadOf(chat: TelegramChat, topic?: number): string {
	return formatThread(chat.id, topic);
}

function memberName(member: TelegramChatMember): string {
	const user = member.user;
	return [user.first_name, user.last_name].filter(Boolean).join(" ") || (user.username ? `@${user.username}` : String(user.id));
}

function clamp(value: number, min: number, max: number): number {
	if (!Number.isFinite(value)) return min;
	return Math.min(Math.max(Math.floor(value), min), max);
}

function safeFileName(name: string): string {
	const base = path.basename(name).replace(/[^a-zA-Z0-9._-]+/g, "_");
	return base.length > 0 ? base : "file";
}

function formatTranscript(records: Array<{ ts: number; direction: string; author?: string; text: string; messageId?: string; attachments?: unknown[] }>): string {
	return records
		.map((record) => {
			const who = record.direction === "outbound" ? "agent" : record.author ?? "unknown";
			const arrow = record.direction === "outbound" ? "→" : "←";
			const id = record.messageId ? ` #${record.messageId}` : "";
			const media =
				record.attachments && record.attachments.length > 0
					? ` [${record.attachments.map((a) => describeAttachment(a as never)).join(", ")}]`
					: "";
			return `${iso(record.ts)} ${arrow} ${who}${id}: ${truncate(record.text.replace(/\n/g, " ⏎ "), 700)}${media}`;
		})
		.join("\n");
}
