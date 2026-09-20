import type { HistoryAttachment } from "../../store/history.js";
import type { TelegramChat, TelegramMessage, TelegramMessageEntity, TelegramUpdate } from "./types.js";
import { formatThread } from "./threads.js";
import { chatLabel } from "./text.js";

export type TelegramUpdateType = "message" | "edited_message" | "channel_post" | "edited_channel_post" | "callback_query";

export interface TelegramAuthor {
	id: string;
	name: string;
	username?: string;
}

export interface NormalizedInbound {
	updateId: number;
	updateType: TelegramUpdateType;
	chat: TelegramChat;
	chatId: string;
	/** Human label of the chat, e.g. "Alive team" or "Alice (@alice)". */
	chatLabel: string;
	messageId: string;
	topicId?: string;
	thread: string;
	ts: number;
	isEdit: boolean;
	isChannel: boolean;
	expectsReply: boolean;
	author?: TelegramAuthor;
	/** What the human actually wrote (or a synthesized description of the media). */
	text: string;
	/** The body handed to the agent: reply quote, text, attachment summary. */
	promptText: string;
	attachments: HistoryAttachment[];
	replyToMessageId?: string;
	replyToPreview?: string;
	historyId: string;
	dedupeKey: string;
	eventTitle: string;
	payload: Record<string, unknown>;
}

export interface NormalizeOptions {
	botId?: number;
	botUsername?: string;
	ingestEdits: boolean;
}

/**
 * Turn one Telegram update into the module's normalized inbound shape.
 *
 * Pure and synchronous on purpose: it is the part most worth testing without a
 * network, and the module only has to decide what to do with the result.
 *
 * Returns `undefined` for updates the agent should not see at all: our own
 * messages, other bots, and edits when `ingestEdits` is off.
 */
export function normalizeUpdate(update: TelegramUpdate, options: NormalizeOptions): NormalizedInbound | undefined {
	if (update.callback_query) return normalizeCallback(update);
	const [message, updateType] = pickMessage(update);
	if (!message) return undefined;
	const isEdit = updateType === "edited_message" || updateType === "edited_channel_post";
	if (isEdit && !options.ingestEdits) return undefined;
	// Never let a bot (including ourselves, via another path) drive the agent.
	if (message.from?.is_bot) return undefined;
	if (message.via_bot) return undefined;

	const chat = message.chat;
	const chatId = String(chat.id);
	const isChannel = chat.type === "channel";
	const topicId = message.message_thread_id !== undefined ? String(message.message_thread_id) : undefined;
	const thread = formatThread(chatId, topicId);
	const author = authorOf(message);
	const attachments = attachmentsOf(message);
	const text = textOf(message, attachments);
	const replyToMessageId = message.reply_to_message ? String(message.reply_to_message.message_id) : undefined;
	const replyToPreview = message.reply_to_message ? previewOf(message.reply_to_message) : undefined;
	const editSuffix = isEdit && message.edit_date ? `:edit:${message.edit_date}` : "";
	const messageId = String(message.message_id);
	const historyId = `telegram:${chatId}:${messageId}${editSuffix}`;

	const promptLines: string[] = [];
	if (message.forward_origin) promptLines.push(`↪ forwarded: ${forwardLabel(message)}`);
	if (replyToPreview !== undefined) {
		const replyAuthor = message.reply_to_message ? authorOf(message.reply_to_message) : undefined;
		promptLines.push(`↩ replying to ${replyAuthor?.name ?? "someone"}: ${singleLine(replyToPreview, 240)}`);
	}
	promptLines.push(text);
	if (attachments.length > 0) promptLines.push(`attachments: ${attachments.map(describeAttachment).join(", ")}`);
	if (isEdit) promptLines.push("(this message was edited after it was first sent)");

	return {
		updateId: update.update_id,
		updateType,
		chat,
		chatId,
		chatLabel: chatLabel(chat),
		messageId,
		topicId,
		thread,
		ts: (message.edit_date ?? message.date) * 1000,
		isEdit,
		isChannel,
		expectsReply: expectsReply(message, isChannel, options),
		author,
		text,
		promptText: promptLines.join("\n"),
		attachments,
		replyToMessageId,
		replyToPreview,
		historyId,
		dedupeKey: `telegram:msg:${chatId}:${messageId}${editSuffix}`,
		eventTitle: isChannel
			? `channel post in ${chatLabel(chat)}`
			: `message from ${author?.name ?? "unknown"} in ${chatLabel(chat)}`,
		payload: {
			module: "telegram",
			updateId: update.update_id,
			updateType,
			chat: { id: chat.id, type: chat.type, title: chat.title, username: chat.username },
			messageId,
			topicId,
			date: message.date,
			edited: isEdit,
			author,
			replyTo: replyToMessageId,
			attachments,
			forward: message.forward_origin ? forwardLabel(message) : undefined,
		},
	};
}

function normalizeCallback(update: TelegramUpdate): NormalizedInbound | undefined {
	const query = update.callback_query;
	if (!query) return undefined;
	const message = query.message;
	if (!message) return undefined;
	const chat = message.chat;
	const chatId = String(chat.id);
	const topicId = message.message_thread_id !== undefined ? String(message.message_thread_id) : undefined;
	const thread = formatThread(chatId, topicId);
	const messageId = String(message.message_id);
	const data = query.data ?? "(no data)";
	const text = `[button pressed] ${data}`;
	return {
		updateId: update.update_id,
		updateType: "callback_query",
		chat,
		chatId,
		chatLabel: chatLabel(chat),
		messageId,
		topicId,
		thread,
		ts: Date.now(),
		isEdit: false,
		isChannel: chat.type === "channel",
		expectsReply: true,
		author: { id: String(query.from.id), name: displayName(query.from), username: query.from.username },
		text,
		promptText: `${text}\n(inline button on message ${messageId}; callback id ${query.id})`,
		attachments: [],
		historyId: `telegram:${chatId}:cb:${query.id}`,
		dedupeKey: `telegram:cb:${query.id}`,
		eventTitle: `button pressed by ${displayName(query.from)} in ${chatLabel(chat)}`,
		payload: {
			module: "telegram",
			updateId: update.update_id,
			updateType: "callback_query",
			chat: { id: chat.id, type: chat.type, title: chat.title, username: chat.username },
			messageId,
			callbackQueryId: query.id,
			data: query.data,
			author: { id: String(query.from.id), name: displayName(query.from), username: query.from.username },
		},
	};
}

function pickMessage(update: TelegramUpdate): [TelegramMessage | undefined, TelegramUpdateType] {
	if (update.message) return [update.message, "message"];
	if (update.edited_message) return [update.edited_message, "edited_message"];
	if (update.channel_post) return [update.channel_post, "channel_post"];
	if (update.edited_channel_post) return [update.edited_channel_post, "edited_channel_post"];
	return [undefined, "message"];
}

function authorOf(message: TelegramMessage): TelegramAuthor | undefined {
	const user = message.from;
	if (user) return { id: String(user.id), name: displayName(user), username: user.username };
	const chat = message.sender_chat;
	if (chat) return { id: String(chat.id), name: chat.title ?? chatLabel(chat), username: chat.username };
	return undefined;
}

function displayName(user: { first_name: string; last_name?: string; username?: string }): string {
	const name = [user.first_name, user.last_name].filter(Boolean).join(" ");
	if (name) return name;
	return user.username ? `@${user.username}` : "unknown";
}

function expectsReply(message: TelegramMessage, isChannel: boolean, options: NormalizeOptions): boolean {
	if (isChannel) return false;
	if (message.chat.type === "private") return true;
	const source = message.text ?? message.caption ?? "";
	if (source.startsWith("/")) return true;
	if (message.reply_to_message?.from?.id !== undefined && message.reply_to_message.from.id === options.botId) return true;
	const entities = message.entities ?? message.caption_entities ?? [];
	for (const entity of entities) {
		if (entity.type === "mention") {
			const mentioned = sliceEntity(source, entity);
			if (options.botUsername && mentioned.toLowerCase() === `@${options.botUsername.toLowerCase()}`) return true;
		}
		if (entity.type === "text_mention" && entity.user?.id !== undefined && entity.user.id === options.botId) return true;
	}
	return false;
}

function sliceEntity(source: string, entity: TelegramMessageEntity): string {
	return source.slice(entity.offset, entity.offset + entity.length);
}

function attachmentsOf(message: TelegramMessage): HistoryAttachment[] {
	const out: HistoryAttachment[] = [];
	if (message.photo && message.photo.length > 0) {
		const best = message.photo[message.photo.length - 1]!;
		out.push({
			kind: "photo",
			fileId: best.file_id,
			fileUniqueId: best.file_unique_id,
			size: best.file_size,
			meta: { width: best.width, height: best.height },
		});
	}
	if (message.document) {
		out.push({
			kind: "document",
			fileId: message.document.file_id,
			fileUniqueId: message.document.file_unique_id,
			name: message.document.file_name,
			mime: message.document.mime_type,
			size: message.document.file_size,
		});
	}
	if (message.audio) {
		out.push({
			kind: "audio",
			fileId: message.audio.file_id,
			fileUniqueId: message.audio.file_unique_id,
			name: message.audio.file_name ?? message.audio.title,
			mime: message.audio.mime_type,
			size: message.audio.file_size,
			durationSec: message.audio.duration,
		});
	}
	if (message.voice) {
		out.push({
			kind: "voice",
			fileId: message.voice.file_id,
			fileUniqueId: message.voice.file_unique_id,
			mime: message.voice.mime_type,
			size: message.voice.file_size,
			durationSec: message.voice.duration,
		});
	}
	if (message.video) {
		out.push({
			kind: "video",
			fileId: message.video.file_id,
			fileUniqueId: message.video.file_unique_id,
			name: message.video.file_name,
			mime: message.video.mime_type,
			size: message.video.file_size,
			durationSec: message.video.duration,
		});
	}
	if (message.sticker) {
		out.push({
			kind: "sticker",
			fileId: message.sticker.file_id,
			fileUniqueId: message.sticker.file_unique_id,
			size: message.sticker.file_size,
			meta: { emoji: message.sticker.emoji, setName: message.sticker.set_name, animated: message.sticker.is_animated },
		});
	}
	if (message.location) {
		out.push({
			kind: "location",
			meta: { longitude: message.location.longitude, latitude: message.location.latitude },
		});
	}
	if (message.contact) {
		out.push({
			kind: "contact",
			name: [message.contact.first_name, message.contact.last_name].filter(Boolean).join(" "),
			meta: { phone: message.contact.phone_number, userId: message.contact.user_id },
		});
	}
	if (message.poll) {
		out.push({
			kind: "poll",
			meta: {
				question: message.poll.question,
				options: message.poll.options.map((option) => option.text),
				closed: message.poll.is_closed,
			},
		});
	}
	if (message.web_app_data) {
		out.push({ kind: "web_app", meta: { buttonText: message.web_app_data.button_text } });
	}
	return out;
}

function textOf(message: TelegramMessage, attachments: HistoryAttachment[]): string {
	const body = (message.text ?? message.caption ?? "").trim();
	const service = serviceText(message);
	if (service) return body ? `${service}\n${body}` : service;
	if (body) return body;
	if (attachments.length > 0) return `(${attachments.map(describeAttachment).join(", ")})`;
	return "(empty message)";
}

function serviceText(message: TelegramMessage): string {
	const parts: string[] = [];
	if (message.new_chat_members && message.new_chat_members.length > 0) {
		parts.push(`[${message.new_chat_members.map(displayName).join(", ")} joined]`);
	}
	if (message.left_chat_member) parts.push(`[${displayName(message.left_chat_member)} left]`);
	if (message.new_chat_title) parts.push(`[chat renamed to "${message.new_chat_title}"]`);
	if (message.pinned_message) parts.push(`[pinned a message]`);
	return parts.join(" ");
}

function previewOf(message: TelegramMessage): string {
	const body = message.text ?? message.caption;
	if (body) return body;
	if (message.photo) return "(photo)";
	if (message.document) return `(document${message.document.file_name ? `: ${message.document.file_name}` : ""})`;
	if (message.voice) return "(voice)";
	if (message.video) return "(video)";
	if (message.sticker) return `(sticker${message.sticker.emoji ? ` ${message.sticker.emoji}` : ""})`;
	if (message.location) return "(location)";
	if (message.contact) return "(contact)";
	if (message.poll) return `(poll: ${message.poll.question})`;
	return "(message)";
}

function forwardLabel(message: TelegramMessage): string {
	const origin = message.forward_origin;
	if (!origin) return "unknown";
	if (origin.sender_user) return displayName(origin.sender_user);
	if (origin.sender_user_name) return origin.sender_user_name;
	if (origin.sender_chat) return origin.sender_chat.title ?? chatLabel(origin.sender_chat);
	if (origin.chat) return origin.chat.title ?? chatLabel(origin.chat);
	return origin.type;
}

export function describeAttachment(attachment: HistoryAttachment): string {
	const extras: string[] = [];
	if (attachment.name) extras.push(attachment.name);
	if (attachment.mime) extras.push(attachment.mime);
	if (attachment.size !== undefined) extras.push(formatBytes(attachment.size));
	if (attachment.durationSec !== undefined) extras.push(`${attachment.durationSec}s`);
	const emoji = (attachment.meta?.emoji as string | undefined) ?? undefined;
	if (attachment.kind === "sticker" && emoji) extras.unshift(emoji);
	if (attachment.kind === "location") {
		return `location (${attachment.meta?.latitude}, ${attachment.meta?.longitude})`;
	}
	if (attachment.kind === "contact") {
		return `contact ${attachment.name ?? ""} ${attachment.meta?.phone ?? ""}`.trim();
	}
	if (attachment.kind === "poll") return `poll "${attachment.meta?.question ?? ""}"`;
	return extras.length > 0 ? `${attachment.kind} (${extras.join(", ")})` : attachment.kind;
}

function formatBytes(bytes: number): string {
	if (bytes < 1024) return `${bytes} B`;
	if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
	return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function singleLine(text: string, max: number): string {
	const flat = text.replace(/\s+/g, " ").trim();
	return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}
