/**
 * Text handling for Telegram: the hard 4096-character limit and HTML escaping.
 *
 * Telegram has no notion of "message runs", so a long answer has to be split
 * into several messages. We split on the nicest boundary available (paragraph,
 * then line, then sentence, then space) so the result still reads like writing.
 */

export const TELEGRAM_MAX_CHARS = 4096;

/** Split `text` into chunks of at most `max` characters. Never drops characters. */
export function splitMessage(text: string, max = TELEGRAM_MAX_CHARS): string[] {
	const limit = Math.max(1, Math.floor(max));
	if (text.length <= limit) return text.length > 0 ? [text] : [];
	const chunks: string[] = [];
	let rest = text;
	while (rest.length > limit) {
		const window = rest.slice(0, limit);
		const cut = bestBreak(window, limit);
		chunks.push(rest.slice(0, cut).trimEnd());
		rest = rest.slice(cut).replace(/^\s+/, "");
	}
	if (rest.length > 0) chunks.push(rest);
	return chunks;
}

function bestBreak(window: string, limit: number): number {
	// Prefer a paragraph break, then a line break, then a sentence end, then a space.
	const paragraph = window.lastIndexOf("\n\n");
	if (paragraph > limit * 0.5) return paragraph + 2;
	const line = window.lastIndexOf("\n");
	if (line > limit * 0.5) return line + 1;
	const sentence = sentenceEnd(window);
	if (sentence > limit * 0.5) return sentence;
	const space = window.lastIndexOf(" ");
	if (space > limit * 0.5) return space + 1;
	return limit;
}

/** Index just past the whitespace that ends a sentence (i.e. the start of the next one). */
function sentenceEnd(window: string): number {
	const match = /[.!?…]["»)]?\s+/g;
	let last = -1;
	let hit: RegExpExecArray | null;
	while ((hit = match.exec(window)) !== null) last = hit.index + hit[0].length;
	return last;
}

/** Escape text for `parse_mode: "HTML"`. */
export function escapeHtml(text: string): string {
	return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

/**
 * True when a Telegram 400 means "your markup is broken", in which case the
 * safe move is to resend the text as plain text instead of losing the message.
 */
export function isParseModeError(error: unknown): boolean {
	const description = error instanceof Error ? error.message.toLowerCase() : String(error).toLowerCase();
	return (
		description.includes("can't parse entities") ||
		description.includes("can't find end") ||
		description.includes("unsupported start tag") ||
		description.includes("parse_mode")
	);
}

/** Compact human label for a chat, used in event titles and tool output. */
export function chatLabel(chat: { id: number; title?: string; username?: string; first_name?: string; last_name?: string; type: string }): string {
	if (chat.title) return chat.title;
	const name = [chat.first_name, chat.last_name].filter(Boolean).join(" ");
	if (name && chat.username) return `${name} (@${chat.username})`;
	if (name) return name;
	if (chat.username) return `@${chat.username}`;
	return `${chat.type}:${chat.id}`;
}
