import type { OutgoingButton, OutgoingButtonRows } from "../../store/outbox.js";
import { parseThread } from "./threads.js";

/** Telegram Bot API hard limit for `InlineKeyboardButton.callback_data`. */
export const TELEGRAM_CALLBACK_DATA_MAX_BYTES = 64;

/** Telegram renders at most three inline buttons comfortably in one row. */
export const TELEGRAM_BUTTONS_PER_ROW_MAX = 3;

export interface ButtonValidationOptions {
	/** Canonical thread the message is going to, when known. */
	thread?: string;
	/** Chat type from local history, when known (`private`, `group`, …). */
	chatType?: string;
	/** `modules.telegram.allowUrlButtonsInGroups`; default false. */
	allowUrlButtonsInGroups?: boolean;
}

/** A compact, log-safe description of the buttons attached to one message. */
export interface ButtonHistorySummary {
	rows: number;
	buttons: Array<{
		text: string;
		kind: "callback" | "link";
		/** Callback payload size only: the value itself is not recorded here. */
		dataBytes?: number;
		url?: string;
	}>;
}

/**
 * Validate the agent-supplied buttons before they reach the Bot API.
 *
 * Inline keyboards cannot stick above the composer, which is why they are the
 * only quick-reply surface `send_message` exposes. Validation is deliberately
 * strict and runs before the outbox record/API call: a bad button must fail as
 * a tool error, not silently truncate its callback payload or spam a group with
 * an arbitrary link.
 */
export function validateOutgoingButtons(buttons: OutgoingButtonRows | undefined, options: ButtonValidationOptions = {}): void {
	if (buttons === undefined) return;
	if (!Array.isArray(buttons) || buttons.length === 0) {
		throw new Error("buttons must contain at least one row");
	}
	const group = isGroupTelegramDestination(options.thread, options.chatType);
	for (const [rowIndex, row] of buttons.entries()) {
		if (!Array.isArray(row) || row.length === 0) {
			throw new Error(`buttons[${rowIndex}] must contain 1–${TELEGRAM_BUTTONS_PER_ROW_MAX} buttons`);
		}
		if (row.length > TELEGRAM_BUTTONS_PER_ROW_MAX) {
			throw new Error(
				`buttons[${rowIndex}] has ${row.length} buttons; Telegram allows at most ${TELEGRAM_BUTTONS_PER_ROW_MAX} per row`,
			);
		}
		for (const [buttonIndex, button] of row.entries()) {
			validateButton(button, rowIndex, buttonIndex, group, options.allowUrlButtonsInGroups === true);
		}
	}
}

function validateButton(
	button: OutgoingButton,
	rowIndex: number,
	buttonIndex: number,
	group: boolean,
	allowUrlButtonsInGroups: boolean,
): void {
	const label = buttonName(rowIndex, buttonIndex, button);
	if (!button || typeof button !== "object") throw new Error(`${label} must be an object with text and data or url`);
	if (typeof button.text !== "string" || button.text.trim().length === 0) {
		throw new Error(`${label} needs non-empty text`);
	}
	const hasData = button.data !== undefined;
	const hasUrl = button.url !== undefined;
	if (hasData === hasUrl) {
		throw new Error(`${label} must have exactly one of data (callback action) or url (link)`);
	}
	if (hasData) {
		if (typeof button.data !== "string" || button.data.length === 0) {
			throw new Error(`${label} needs non-empty data`);
		}
		const bytes = Buffer.byteLength(button.data, "utf8");
		if (bytes > TELEGRAM_CALLBACK_DATA_MAX_BYTES) {
			throw new Error(
				`${label} callback_data is ${bytes} bytes; Telegram allows at most ${TELEGRAM_CALLBACK_DATA_MAX_BYTES} bytes. ` +
					"Shorten it (use the same short code the handler understands, not the whole payload).",
			);
		}
		return;
	}
	if (typeof button.url !== "string" || button.url.length === 0) {
		throw new Error(`${label} needs non-empty url`);
	}
	let parsed: URL;
	try {
		parsed = new URL(button.url);
	} catch {
		throw new Error(`${label} url is not a valid absolute URL: ${button.url}`);
	}
	if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
		throw new Error(`${label} url must start with http:// or https://`);
	}
	if (group && !allowUrlButtonsInGroups) {
		throw new Error(
			`${label} is a url button in a group thread; refusing to let the agent post arbitrary links. ` +
				"Set modules.telegram.allowUrlButtonsInGroups=true only for trusted groups.",
		);
	}
}

function buttonName(rowIndex: number, buttonIndex: number, button: OutgoingButton | undefined): string {
	const text = typeof button?.text === "string" && button.text.trim() ? ` "${button.text.trim().slice(0, 40)}"` : "";
	return `buttons[${rowIndex}][${buttonIndex}]${text}`;
}

/**
 * True when the destination is a group/supergroup/channel.
 *
 * Telegram chat ids are negative for groups and channels. Local history can
 * also say the type explicitly, which covers `@username` destinations.
 */
export function isGroupTelegramDestination(thread: string | undefined, chatType?: string): boolean {
	if (chatType === "group" || chatType === "supergroup" || chatType === "channel") return true;
	if (!thread) return false;
	const trimmed = thread.trim();
	const parsed = parseThread(trimmed);
	const chatId = parsed?.chatId ?? (/^-?\d+$/.test(trimmed) ? trimmed : undefined);
	return chatId !== undefined && /^-\d+$/.test(chatId);
}

/** Build the Bot API inline keyboard for a validated button list. */
export function buttonsToReplyMarkup(buttons: OutgoingButtonRows | undefined): { inline_keyboard: unknown[][] } | undefined {
	if (!buttons || buttons.length === 0) return undefined;
	return {
		inline_keyboard: buttons.map((row) =>
			row.map((button) =>
				button.data !== undefined
					? { text: button.text, callback_data: button.data }
					: { text: button.text, url: button.url },
			),
		),
	};
}

/**
 * History gets the shape of what was sent (labels/kind/size/url), never the
 * callback payload. The payload stays in the outbox record needed for delivery.
 */
export function buttonHistorySummary(buttons: OutgoingButtonRows | undefined): ButtonHistorySummary | undefined {
	if (!buttons || buttons.length === 0) return undefined;
	return {
		rows: buttons.length,
		buttons: buttons.flatMap((row) =>
			row.map((button) =>
				button.data !== undefined
					? { text: button.text, kind: "callback" as const, dataBytes: Buffer.byteLength(button.data, "utf8") }
					: { text: button.text, kind: "link" as const, url: button.url },
			),
		),
	};
}
