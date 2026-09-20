/**
 * Thread id conventions for the Telegram module.
 *
 * A thread is the runtime's canonical conversation key (it drives the reply
 * enforcement in `threads.json`, notification policy rules and outbound
 * routing). The module must be able to turn a thread back into a Telegram
 * destination with no extra state, so the id is self-describing:
 *
 *   telegram:<chatId>              → a chat (private, group, supergroup, channel)
 *   telegram:<chatId>/<topicId>    → a forum topic inside a chat
 *
 * Chat ids are negative for groups/channels (`-100…`), so the topic separator is
 * `/` and never `:`.
 */

export const TELEGRAM_THREAD_PREFIX = "telegram:";

export interface TelegramThreadRef {
	/** The canonical thread id as stored everywhere. */
	raw: string;
	/** Chat id as a string, possibly negative. */
	chatId: string;
	/** Forum topic id, when the thread points at one. */
	topicId?: string;
}

export function formatThread(chatId: string | number, topicId?: string | number): string {
	const chat = `${TELEGRAM_THREAD_PREFIX}${chatId}`;
	return topicId === undefined ? chat : `${chat}/${topicId}`;
}

export function parseThread(thread: string): TelegramThreadRef | undefined {
	if (!thread.startsWith(TELEGRAM_THREAD_PREFIX)) return undefined;
	const rest = thread.slice(TELEGRAM_THREAD_PREFIX.length);
	if (!rest) return undefined;
	const slash = rest.indexOf("/");
	if (slash < 0) return { raw: thread, chatId: rest };
	const chatId = rest.slice(0, slash);
	const topicId = rest.slice(slash + 1);
	if (!chatId) return undefined;
	return { raw: thread, chatId, topicId: topicId || undefined };
}

export function isTelegramThread(thread: string | undefined): boolean {
	return thread !== undefined && thread.startsWith(TELEGRAM_THREAD_PREFIX);
}

/**
 * Accept anything a human or the model might pass as "a chat": a full thread id,
 * a bare chat id, or an `@username`. Returns a Bot API `chat_id` value.
 */
export function resolveChatTarget(input: string): string | number {
	const trimmed = input.trim();
	if (!trimmed) throw new Error("chat is required");
	const parsed = parseThread(trimmed);
	if (parsed) return parsed.chatId;
	if (trimmed.startsWith("@")) return trimmed;
	if (/^-?\d+$/.test(trimmed)) return trimmed;
	return trimmed.startsWith("https://t.me/") ? `@${trimmed.replace(/^https:\/\/t\.me\//, "")}` : trimmed;
}

/** Topic id from a thread or an explicit value. */
export function resolveTopicTarget(thread: string | undefined, explicit?: number): number | undefined {
	if (explicit !== undefined) return explicit;
	if (!thread) return undefined;
	const parsed = parseThread(thread);
	if (!parsed?.topicId) return undefined;
	const value = Number(parsed.topicId);
	return Number.isFinite(value) ? value : undefined;
}
