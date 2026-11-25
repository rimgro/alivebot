/**
 * Button-driven choices (#266, slice 2).
 *
 * `send_message` can attach structured choices instead of raw buttons. An inline
 * choice renders an inline keyboard whose callback payloads are short internal
 * ids (`alive:ch:<setId>:<optionId>`); the option set is persisted on disk so a
 * press can be turned back into a structured event even after a restart.
 *
 * A reply keyboard (`keyboard`) is the same idea above the composer: Telegram
 * sends a normal text message with the button label, so the stored set maps the
 * labels back to option ids.
 */
import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import type { OutgoingChoiceList, OutgoingChoiceOption, OutgoingKeyboard } from "../../store/outbox.js";
import { TELEGRAM_BUTTONS_PER_ROW_MAX, TELEGRAM_CALLBACK_DATA_MAX_BYTES } from "./buttons.js";

/** Internal callback namespace; everything under it is intercepted before the model. */
export const TELEGRAM_CHOICE_CALLBACK_PREFIX = "alive:ch:";

/** One set carries this many options at most. */
export const TELEGRAM_CHOICE_MAX_OPTIONS = 10;
/** Option ids are short slugs so the callback payload stays tiny. */
export const TELEGRAM_CHOICE_ID_PATTERN = /^[a-z0-9_-]{1,20}$/;
/** Labels are user-visible text. */
export const TELEGRAM_CHOICE_LABEL_MAX = 64;
/** `setId` is exactly eight base36 characters. */
export const TELEGRAM_CHOICE_SET_ID_LENGTH = 8;
export const TELEGRAM_CHOICE_SET_ID_PATTERN = /^[0-9a-z]{8}$/;
/** Inline choices use the same comfortable width as ordinary buttons. */
export const TELEGRAM_CHOICES_PER_ROW_MAX = TELEGRAM_BUTTONS_PER_ROW_MAX;

/** Reply keyboards: Telegram's practical limits for a compact menu. */
export const TELEGRAM_REPLY_KEYBOARD_MAX_ROWS = 5;
export const TELEGRAM_REPLY_KEYBOARD_MAX_BUTTONS_PER_ROW = 4;
export const TELEGRAM_REPLY_KEYBOARD_LABEL_MAX = 64;

/** A set older than this is gone: the buttons under the message are stale. */
export const TELEGRAM_CHOICE_SET_TTL_MS = 7 * 24 * 60 * 60 * 1000;
/** Bound for the state directory; the oldest sets are removed first. */
export const TELEGRAM_CHOICE_SET_LIMIT = 200;

/** Answers shown on a press that cannot be attributed to a live set. */
export const CHOICE_STALE_ANSWER = "кнопка устарела";
export const CHOICE_ALREADY_ANSWER = "уже выбрано";
/** Short hint appended to the structured event; the press itself is the action. */
export const CHOICE_PROMPT_HINT = "(выбор из кнопок под сообщением; отвечать не нужно, если действие уже выполнено)";
/** Text of the one-off message that removes an answered reply keyboard. */
export const CHOICE_REPLY_KEYBOARD_REMOVED_TEXT = "Клавиатура убрана.";

export type ChoiceSource = "inline" | "reply_keyboard";

export interface ChoiceChosen {
	id: string;
	label: string;
	at: number;
	by: string;
}

/** Durable shape of `<stateDir>/telegram-choices/<setId>.json`. */
export interface ChoiceSet {
	setId: string;
	chatId: string;
	thread: string;
	/** Appears after the message is accepted by Telegram. */
	messageId?: number;
	/** Text of the exact message chunk the keyboard is attached to. */
	text: string;
	/** Parse mode that chunk was sent with; omitted/old files mean plain text. */
	parseMode?: string;
	options: OutgoingChoiceOption[];
	chosen: ChoiceChosen | null;
	createdAt: number;
	source: ChoiceSource;
}

export interface ChoicePress {
	set: string;
	optionId: string;
	label: string;
	messageId: number;
	thread: string;
	source: ChoiceSource;
}

export interface ChoiceValidationInput {
	choices?: OutgoingChoiceList;
	buttons?: unknown;
	keyboard?: OutgoingKeyboard;
}

/**
 * Validate the structured surfaces of one `send_message`.
 *
 * `buttons`, `choices` and `keyboard` are alternative reply surfaces: Telegram
 * accepts only one `reply_markup` per message, so combining them must fail as a
 * tool error instead of silently dropping one.
 */
export function validateChoiceInputs(input: ChoiceValidationInput): void {
	const choices = input.choices;
	const keyboard = input.keyboard;
	if (choices !== undefined && input.buttons !== undefined) {
		throw new Error("send_message accepts either `choices` or `buttons`, not both");
	}
	if (keyboard !== undefined && input.buttons !== undefined) {
		throw new Error("send_message accepts either `keyboard` or `buttons`, not both");
	}
	if (choices !== undefined && keyboard !== undefined) {
		throw new Error("send_message accepts either `choices` or `keyboard`, not both");
	}
	if (choices !== undefined) validateChoices(choices);
	if (keyboard !== undefined) validateReplyKeyboard(keyboard);
}

export function validateChoices(choices: OutgoingChoiceList | undefined): void {
	if (choices === undefined) return;
	if (!Array.isArray(choices)) throw new Error("choices must be an array of {id,label} options");
	if (choices.length === 0) throw new Error("choices must contain 1–10 options");
	if (choices.length > TELEGRAM_CHOICE_MAX_OPTIONS) {
		throw new Error(`choices has ${choices.length} options; at most ${TELEGRAM_CHOICE_MAX_OPTIONS} are allowed`);
	}
	const ids = new Set<string>();
	const labels = new Set<string>();
	for (const [index, option] of choices.entries()) {
		const label = `choices[${index}]`;
		if (!option || typeof option !== "object") throw new Error(`${label} must be an object with id and label`);
		if (typeof option.id !== "string" || !TELEGRAM_CHOICE_ID_PATTERN.test(option.id)) {
			throw new Error(`${label}.id must be a short slug matching ${TELEGRAM_CHOICE_ID_PATTERN}: a-z, 0-9, _ or -, 1–20 chars`);
		}
		if ("url" in option || "data" in option) {
			throw new Error(`${label} is a choice, not a button: url/data callback buttons are not possible here`);
		}
		if (typeof option.label !== "string" || option.label.trim().length === 0) {
			throw new Error(`${label}.label must be non-empty text`);
		}
		if (option.label.length > TELEGRAM_CHOICE_LABEL_MAX) {
			throw new Error(`${label}.label is ${option.label.length} chars; at most ${TELEGRAM_CHOICE_LABEL_MAX} are allowed`);
		}
		if (ids.has(option.id)) throw new Error(`${label}.id "${option.id}" is duplicated; option ids must be unique`);
		if (labels.has(option.label)) throw new Error(`${label}.label "${option.label}" is duplicated; labels must be unique`);
		ids.add(option.id);
		labels.add(option.label);
		// The callback payload is checked here, before the outbox record or any API call.
		choiceCallbackData("00000000", option.id);
	}
}

export function validateReplyKeyboard(keyboard: OutgoingKeyboard | undefined): void {
	if (keyboard === undefined) return;
	if (!keyboard || typeof keyboard !== "object" || !Array.isArray(keyboard.rows)) {
		throw new Error("keyboard must be an object with a rows array of button labels");
	}
	const rows = keyboard.rows;
	if (rows.length === 0 || rows.length > TELEGRAM_REPLY_KEYBOARD_MAX_ROWS) {
		throw new Error(`keyboard.rows must contain 1–${TELEGRAM_REPLY_KEYBOARD_MAX_ROWS} rows`);
	}
	const labels = new Set<string>();
	for (const [rowIndex, row] of rows.entries()) {
		const label = `keyboard.rows[${rowIndex}]`;
		if (!Array.isArray(row) || row.length === 0 || row.length > TELEGRAM_REPLY_KEYBOARD_MAX_BUTTONS_PER_ROW) {
			throw new Error(`${label} must contain 1–${TELEGRAM_REPLY_KEYBOARD_MAX_BUTTONS_PER_ROW} buttons`);
		}
		for (const [buttonIndex, text] of row.entries()) {
			if (typeof text !== "string" || text.trim().length === 0) {
				throw new Error(`${label}[${buttonIndex}] must be non-empty text`);
			}
			if (text.length > TELEGRAM_REPLY_KEYBOARD_LABEL_MAX) {
				throw new Error(`${label}[${buttonIndex}] is ${text.length} chars; at most ${TELEGRAM_REPLY_KEYBOARD_LABEL_MAX} are allowed`);
			}
			if (labels.has(text)) throw new Error(`${label}[${buttonIndex}] "${text}" is duplicated; keyboard labels must be unique`);
			labels.add(text);
		}
	}
}

/** Build and size-check one internal callback payload; never truncate. */
export function choiceCallbackData(setId: string, optionId: string): string {
	const data = `${TELEGRAM_CHOICE_CALLBACK_PREFIX}${setId}:${optionId}`;
	const bytes = Buffer.byteLength(data, "utf8");
	if (bytes > TELEGRAM_CALLBACK_DATA_MAX_BYTES) {
		throw new Error(
			`choice callback_data is ${bytes} bytes; Telegram allows at most ${TELEGRAM_CALLBACK_DATA_MAX_BYTES} bytes. ` +
				"No truncation: shorten the set id or option id.",
		);
	}
	return data;
}

export function parseChoiceCallbackData(data: string | undefined): { setId: string; optionId: string } | undefined {
	if (!data?.startsWith(TELEGRAM_CHOICE_CALLBACK_PREFIX)) return undefined;
	const match = /^alive:ch:([0-9a-z]{8}):([a-z0-9_-]{1,20})$/.exec(data);
	if (!match?.[1] || !match[2]) return undefined;
	return { setId: match[1], optionId: match[2] };
}

/** Eight base36 characters, generated once per sent message. */
export function newChoiceSetId(): string {
	const alphabet = "0123456789abcdefghijklmnopqrstuvwxyz";
	const bytes = crypto.randomBytes(TELEGRAM_CHOICE_SET_ID_LENGTH);
	let id = "";
	for (let index = 0; index < TELEGRAM_CHOICE_SET_ID_LENGTH; index += 1) id += alphabet[bytes[index]! % alphabet.length];
	return id;
}

/** Inline keyboard for a choice set: at most three options per row. */
export function choicesToReplyMarkup(setId: string, choices: OutgoingChoiceList): { inline_keyboard: unknown[][] } {
	const rows: unknown[][] = [];
	for (let index = 0; index < choices.length; index += TELEGRAM_CHOICES_PER_ROW_MAX) {
		rows.push(
			choices.slice(index, index + TELEGRAM_CHOICES_PER_ROW_MAX).map((option) => ({
				text: option.label,
				callback_data: choiceCallbackData(setId, option.id),
			})),
		);
	}
	return { inline_keyboard: rows };
}

/** Reply keyboard under the composer; labels are echoed back as ordinary text. */
export function replyKeyboardToReplyMarkup(keyboard: OutgoingKeyboard): {
	keyboard: Array<Array<{ text: string }>>;
	resize_keyboard: true;
} {
	return {
		keyboard: keyboard.rows.map((row) => row.map((text) => ({ text }))),
		resize_keyboard: true,
	};
}

export function replyKeyboardRemoval(): { remove_keyboard: true } {
	return { remove_keyboard: true };
}

/**
 * Map reply-keyboard labels to option ids. The labels are what Telegram sends
 * back, so the stored set has to be able to translate them after a restart.
 */
export function replyKeyboardOptions(keyboard: OutgoingKeyboard): OutgoingChoiceOption[] {
	const used = new Set<string>();
	return keyboard.rows.flatMap((row) =>
		row.map((label) => {
			const id = uniqueReplyOptionId(replyOptionIdBase(label), used);
			used.add(id);
			return { id, label };
		}),
	);
}

function replyOptionIdBase(label: string): string {
	const transliterated = transliterate(label.toLowerCase())
		.replace(/[^a-z0-9]+/g, "-")
		.replace(/^-+|-+$/g, "")
		.slice(0, 20)
		.replace(/-+$/g, "");
	return transliterated.length > 0 ? transliterated : "opt";
}

function uniqueReplyOptionId(base: string, used: Set<string>): string {
	if (!used.has(base)) return base;
	for (let suffix = 2; suffix < 1_000; suffix += 1) {
		const tail = `-${suffix}`;
		const candidate = `${base.slice(0, 20 - tail.length)}${tail}`;
		if (!used.has(candidate)) return candidate;
	}
	return `opt-${used.size + 1}`.slice(0, 20);
}

const TRANSLITERATION: Record<string, string> = {
	а: "a",
	б: "b",
	в: "v",
	г: "g",
	д: "d",
	е: "e",
	ё: "e",
	ж: "zh",
	з: "z",
	и: "i",
	й: "y",
	к: "k",
	л: "l",
	м: "m",
	н: "n",
	о: "o",
	п: "p",
	р: "r",
	с: "s",
	т: "t",
	у: "u",
	ф: "f",
	х: "h",
	ц: "ts",
	ч: "ch",
	ш: "sh",
	щ: "sch",
	ъ: "",
	ы: "y",
	ь: "",
	э: "e",
	ю: "yu",
	я: "ya",
};

function transliterate(text: string): string {
	return [...text]
		.map((char) => TRANSLITERATION[char] ?? char)
		.join("");
}

/** The exact one-line body the model sees for a press. */
export function choiceEventText(press: ChoicePress): string {
	// Key order is part of the contract: set, option_id, label, message_id, thread, source.
	return `[choice] ${JSON.stringify({
		set: press.set,
		option_id: press.optionId,
		label: press.label,
		message_id: press.messageId,
		thread: press.thread,
		source: press.source,
	})}`;
}

export function choicePromptText(press: ChoicePress): string {
	return `${choiceEventText(press)}\n${CHOICE_PROMPT_HINT}`;
}

/**
 * Disk-backed registry of choice sets.
 *
 * The directory is private (0700) and every set file is 0600: labels are user
 * text and a set id is effectively a capability to resolve a press. Corrupt or
 * unreadable files are treated as expired, never as a module error.
 */
export class ChoiceStore {
	readonly dir: string;

	constructor(stateDir: string, private readonly now: () => number = () => Date.now()) {
		this.dir = path.join(stateDir, "telegram-choices");
		ensurePrivateDir(this.dir);
	}

	/**
	 * Remove expired, corrupt and surplus sets. Called at start, before and after
	 * every create; `keep` protects the just-written set when timestamps tie.
	 */
	prune(keep?: string): void {
		const now = this.now();
		const entries = this.readEntries();
		const live: Array<{ setId: string; createdAt: number }> = [];
		for (const entry of entries) {
			if (entry.set && now - entry.set.createdAt <= TELEGRAM_CHOICE_SET_TTL_MS) {
				live.push({ setId: entry.set.setId, createdAt: entry.set.createdAt });
				continue;
			}
			removeFile(entry.file);
		}
		live.sort((a, b) => a.createdAt - b.createdAt);
		while (live.length > TELEGRAM_CHOICE_SET_LIMIT) {
			const index = keep === undefined ? 0 : Math.max(0, live.findIndex((entry) => entry.setId !== keep));
			const oldest = live.splice(index, 1)[0];
			if (!oldest) break;
			removeFile(this.file(oldest.setId));
		}
	}

	create(input: {
		chatId: string;
		thread: string;
		text: string;
		parseMode?: string;
		options: OutgoingChoiceOption[];
		source: ChoiceSource;
		messageId?: number;
		/** Test/fixture seam; production always generates a fresh id. */
		setId?: string;
	}): ChoiceSet {
		this.prune();
		let setId = input.setId ?? newChoiceSetId();
		if (!input.setId) {
			let attempts = 0;
			while (fs.existsSync(this.file(setId)) && attempts < 10) {
				setId = newChoiceSetId();
				attempts += 1;
			}
		}
		if (!TELEGRAM_CHOICE_SET_ID_PATTERN.test(setId)) throw new Error(`invalid choice set id: ${setId}`);
		const set: ChoiceSet = {
			setId,
			chatId: String(input.chatId),
			thread: input.thread,
			...(input.messageId !== undefined ? { messageId: input.messageId } : {}),
			text: input.text,
			...(input.parseMode ? { parseMode: input.parseMode } : {}),
			options: input.options.map((option) => ({ id: option.id, label: option.label })),
			chosen: null,
			createdAt: this.now(),
			source: input.source,
		};
		this.write(set);
		// The pre-create prune saw one file fewer; enforce the cap including this one.
		this.prune(setId);
		return set;
	}

	/** Read a live set. Expired, corrupt and unknown ids return undefined. */
	get(setId: string): ChoiceSet | undefined {
		if (!TELEGRAM_CHOICE_SET_ID_PATTERN.test(setId)) return undefined;
		const set = readChoiceSet(this.file(setId));
		if (!set || set.setId !== setId) return undefined;
		if (this.now() - set.createdAt > TELEGRAM_CHOICE_SET_TTL_MS) {
			removeFile(this.file(setId));
			return undefined;
		}
		return set;
	}

	setMessageId(setId: string, messageId: number): ChoiceSet | undefined {
		const set = this.get(setId);
		if (!set) return undefined;
		const next: ChoiceSet = { ...set, messageId };
		this.write(next);
		return next;
	}

	/** Persist the first (and only) choice. A repeat returns the existing record. */
	choose(setId: string, option: OutgoingChoiceOption, by: string): ChoiceSet | undefined {
		const set = this.get(setId);
		if (!set) return undefined;
		if (set.chosen) return set;
		const next: ChoiceSet = {
			...set,
			chosen: { id: option.id, label: option.label, at: this.now(), by: String(by) },
		};
		this.write(next);
		return next;
	}

	/**
	 * The reply keyboard that is actually on screen in this chat: the newest
	 * unanswered reply set. Only an exact label of that set matches; once it is
	 * answered the keyboard is gone, so a repeat press is an ordinary message
	 * even if an older set in the same chat happens to carry the same label.
	 */
	findReplySet(chatId: string, text: string): ChoiceSet | undefined {
		const wanted = String(chatId);
		const active = this.readEntries()
			.flatMap((entry) => (entry.set ? [entry.set] : []))
			.filter(
				(set) =>
					set.source === "reply_keyboard" &&
					set.chatId === wanted &&
					this.now() - set.createdAt <= TELEGRAM_CHOICE_SET_TTL_MS,
			)
			.sort((a, b) => b.createdAt - a.createdAt)[0];
		if (!active || active.chosen) return undefined;
		return active.options.some((option) => option.label === text) ? active : undefined;
	}

	list(): ChoiceSet[] {
		return this.readEntries()
			.flatMap((entry) => (entry.set ? [entry.set] : []))
			.sort((a, b) => a.createdAt - b.createdAt);
	}

	file(setId: string): string {
		return path.join(this.dir, `${setId}.json`);
	}

	private write(set: ChoiceSet): void {
		ensurePrivateDir(this.dir);
		const target = this.file(set.setId);
		const tmp = `${target}.${process.pid}.${Date.now()}.tmp`;
		fs.writeFileSync(tmp, `${JSON.stringify(set, null, 2)}\n`, { mode: 0o600 });
		fs.chmodSync(tmp, 0o600);
		fs.renameSync(tmp, target);
		fs.chmodSync(target, 0o600);
	}

	private readEntries(): Array<{ file: string; set?: ChoiceSet }> {
		let names: string[];
		try {
			names = fs.readdirSync(this.dir);
		} catch {
			return [];
		}
		return names
			.filter((name) => /^[0-9a-z]{8}\.json$/.test(name))
			.map((name) => {
				const file = path.join(this.dir, name);
				return { file, set: readChoiceSet(file) };
			});
	}
}

function readChoiceSet(file: string): ChoiceSet | undefined {
	try {
		const raw = fs.readFileSync(file, "utf8");
		const value = JSON.parse(raw) as unknown;
		if (!isChoiceSet(value)) return undefined;
		return value;
	} catch {
		return undefined;
	}
}

function isChoiceSet(value: unknown): value is ChoiceSet {
	if (!value || typeof value !== "object") return false;
	const set = value as Partial<ChoiceSet>;
	if (typeof set.setId !== "string" || !TELEGRAM_CHOICE_SET_ID_PATTERN.test(set.setId)) return false;
	if (typeof set.chatId !== "string" || typeof set.thread !== "string" || typeof set.text !== "string") return false;
	if (set.parseMode !== undefined && typeof set.parseMode !== "string") return false;
	if (typeof set.createdAt !== "number" || !Number.isFinite(set.createdAt)) return false;
	if (set.source !== "inline" && set.source !== "reply_keyboard") return false;
	if (!Array.isArray(set.options) || set.options.length === 0) return false;
	for (const option of set.options) {
		if (!option || typeof option !== "object") return false;
		if (typeof option.id !== "string" || typeof option.label !== "string") return false;
	}
	if (set.chosen !== null && set.chosen !== undefined) {
		const chosen = set.chosen as Partial<ChoiceChosen>;
		if (typeof chosen.id !== "string" || typeof chosen.label !== "string") return false;
		if (typeof chosen.at !== "number" || typeof chosen.by !== "string") return false;
	}
	if (set.messageId !== undefined && (typeof set.messageId !== "number" || !Number.isFinite(set.messageId))) return false;
	return true;
}

function ensurePrivateDir(dir: string): void {
	fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
	try {
		fs.chmodSync(dir, 0o700);
	} catch {
		// Best effort: a filesystem without POSIX modes is not a reason to fail.
	}
}

function removeFile(file: string): void {
	try {
		fs.unlinkSync(file);
	} catch {
		// Already gone or unreadable: prune is best effort.
	}
}
