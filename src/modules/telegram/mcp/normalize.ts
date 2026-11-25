/**
 * Pure normalisation of a Telegram MCP tool call into one argv command
 * (#274).
 *
 * The real `better-tg-cli` MCP server declares `telegram_read {args: string[]}`
 * and `telegram_write {args: string[], stdin?: string}`: `args[0]` is the CLI
 * command and the rest is its argv. The proxy used to look for flat
 * chat/text/to fields, so every real call was either denied or forwarded in a
 * shape the upstream refuses. This module reads the argv shape and keeps the
 * old flat shape working as a compatibility path.
 *
 * It has no I/O and no clock: the policy and the HTTP server use the returned
 * view, and every denial carries a human-readable reason. Anything that is not
 * understood is denied (fail closed): a mistyped or unknown flag would shift
 * the positional arguments and could send a message to the wrong chat.
 */

/** A call as the policy sees it: one command, its argv, one chat and its text. */
export interface TelegramToolCallView {
	/** Canonical command name used for the allowlist lookup (kebab-case). */
	command: string;
	/**
	 * The argv exactly as received for the argv shape. The flat shape has no
	 * argv, so a representative one is built for the confirmation card
	 * (`command`, then chat and text when present).
	 */
	argv: string[];
	/** The one chat the call targets, when the command takes a chat. */
	chat?: string;
	/** Write text for send/reply/edit, from positionals or stdin. */
	text?: string;
	/** True for commands that change the account. */
	write: boolean;
}

export type TelegramToolCallNormalization =
	| { ok: true; view: TelegramToolCallView }
	| { ok: false; reason: string };

interface CommandSpec {
	/** Commands that change the account need a write profile. */
	write: boolean;
	/** 1-based positional index of the chat argument; 0 when there is none. */
	chatIndex: number;
	/** 1-based positional index where the write text starts; 0 when none. */
	textIndex?: number;
	/** send/reply/edit cannot run without text. */
	textRequired?: boolean;
	/** edit takes its text on stdin only; its text positional must be `-`. */
	stdinOnly?: boolean;
	/** The chat comes only from this value flag (`search --chat`). */
	chatFlag?: string;
	/** 1-based positional index that is a query, never a chat (`search`). */
	queryIndex?: number;
	/** Exact positional count the command accepts (flags are not counted). */
	positionals: { min: number; max: number };
}

/**
 * Read commands: the chat argument and the exact number of positionals
 * (flags are removed by the parser before counting).
 */
const READ_COMMANDS: Record<string, CommandSpec> = {
	read: { write: false, chatIndex: 1, positionals: { min: 1, max: 1 } },
	get: { write: false, chatIndex: 1, positionals: { min: 2, max: Number.POSITIVE_INFINITY } },
	topics: { write: false, chatIndex: 1, positionals: { min: 1, max: 1 } },
	buttons: { write: false, chatIndex: 1, positionals: { min: 1, max: 1 } },
	info: { write: false, chatIndex: 1, positionals: { min: 1, max: 1 } },
	members: { write: false, chatIndex: 1, positionals: { min: 1, max: 1 } },
	permissions: { write: false, chatIndex: 1, positionals: { min: 1, max: 1 } },
	stats: { write: false, chatIndex: 1, positionals: { min: 1, max: 1 } },
	scheduled: { write: false, chatIndex: 1, positionals: { min: 1, max: 1 } },
	"profile-photos": { write: false, chatIndex: 1, positionals: { min: 1, max: 1 } },
	"admin-log": { write: false, chatIndex: 1, positionals: { min: 1, max: 1 } },
	invites: { write: false, chatIndex: 1, positionals: { min: 1, max: 1 } },
	whoami: { write: false, chatIndex: 0, positionals: { min: 0, max: 0 } },
	check: { write: false, chatIndex: 0, positionals: { min: 0, max: 0 } },
	help: { write: false, chatIndex: 0, positionals: { min: 0, max: 0 } },
	"help-all": { write: false, chatIndex: 0, positionals: { min: 0, max: 0 } },
	"write-access": { write: false, chatIndex: 0, positionals: { min: 0, max: 0 } },
	// Search only takes its chat from `--chat`; the one positional is the query.
	search: { write: false, chatIndex: 0, chatFlag: "--chat", queryIndex: 1, positionals: { min: 1, max: 1 } },
};

/** Write commands: chat index, text start and the exact positional count. */
const WRITE_COMMANDS: Record<string, CommandSpec> = {
	send: { write: true, chatIndex: 1, textIndex: 2, textRequired: true, positionals: { min: 2, max: 2 } },
	reply: { write: true, chatIndex: 1, textIndex: 3, textRequired: true, positionals: { min: 3, max: 3 } },
	edit: { write: true, chatIndex: 1, textIndex: 3, textRequired: true, stdinOnly: true, positionals: { min: 3, max: 3 } },
	"mark-read": { write: true, chatIndex: 1, positionals: { min: 1, max: 1 } },
	"mark-unread": { write: true, chatIndex: 1, positionals: { min: 1, max: 1 } },
	react: { write: true, chatIndex: 1, positionals: { min: 3, max: 3 } },
	pin: { write: true, chatIndex: 1, positionals: { min: 2, max: 2 } },
	unpin: { write: true, chatIndex: 1, positionals: { min: 1, max: 2 } },
	vote: { write: true, chatIndex: 1, positionals: { min: 3, max: 3 } },
};

/**
 * Commands that are refused as a whole, even though the CLI supports them.
 * Most are destructive or broadcast-shaped; `write-access` is special because
 * only the operator changes the write mode (the status query is a read).
 */
const DENIED_COMMANDS: Record<string, string> = {
	delete: "deleting messages is not allowed",
	"delete-dialog": "deleting or leaving a dialog is not allowed",
	forward: "forwarding messages is not allowed",
	"send-file": "sending files is not allowed",
	click: "pressing buttons is not allowed: the button was written by the bot owner",
	poll: "creating polls is not allowed",
	kick: "kicking members is not allowed",
	ban: "banning members is not allowed",
	promote: "promoting members is not allowed",
	"edit-permissions": "editing chat permissions is not allowed",
	topic: "forum topic management is not allowed",
	plugin: "plugins are not allowed",
	api: "the raw Telegram API is not allowed",
	download: "downloading files is not allowed",
	sync: "exporting or syncing a chat is not allowed",
	watch: "watching a chat is not allowed",
	login: "logging in is not allowed",
	logout: "logging out is not allowed",
	mute: "muting chats is not allowed",
	"pin-chat": "pinning chats is not allowed",
	archive: "archiving chats is not allowed",
};

/** Flags that take one value; the value is removed from the positionals. */
const VALUED_FLAGS = new Set([
	"-n",
	"-q",
	"-g",
	"-c",
	"--chat",
	"--topic",
	"--thread",
	"--reply-to",
	"--schedule",
	"--max-text",
	"--preview",
	"--since",
	"--until",
	"--before",
	"--after",
	"--from",
	"--type",
	"--correct",
	"--message",
	"--grep",
	"--for",
]);

/** Boolean flags (presence only); anything outside both tables is unknown. */
const BOOLEAN_FLAGS = new Set([
	"--json",
	"--html",
	"--markdown",
	"--silent",
	"--unread",
	"--asc",
	"--just-me",
	"--full",
	"--stats",
	"--multiple",
	"--quiz",
	"--drop-author",
	"--revoke",
	"--notify",
	"--requests",
	"--include-archived",
	"--unmuted",
	"--no-bots",
	"--help",
]);

const CHAT_KEYS = ["chat", "chatId", "chat_id", "peer", "to", "recipient", "username", "dialog"] as const;
const RECIPIENT_LIST_KEYS = [
	"recipients",
	"recipient",
	"to",
	"chats",
	"chatIds",
	"chat_ids",
	"targets",
	"users",
	"userIds",
	"contacts",
] as const;
const ACTION_KEYS = ["action", "operation", "op", "method", "type"] as const;
const TEXT_KEYS = ["text", "message", "caption", "content"] as const;

/** Every allowlisted command, for error messages. */
export const TELEGRAM_ALLOWED_COMMANDS: readonly string[] = [
	...Object.keys(READ_COMMANDS),
	...Object.keys(WRITE_COMMANDS),
].sort();

/**
 * True when a command needs a chat (a positional chat, or `search --chat`).
 * `whoami`, `check`, `help`, `help-all` and the `write-access` status query do
 * not, so the policy must not demand a chat for them.
 */
export function commandRequiresChat(command: string): boolean {
	const spec = READ_COMMANDS[command] ?? WRITE_COMMANDS[command];
	return spec !== undefined && (spec.chatIndex > 0 || spec.chatFlag !== undefined);
}

/**
 * Arguments to send to the upstream child.
 *
 * The real 0.41.2 tools take `{args: string[], stdin?}` only, so a legacy flat
 * call is rewritten into that shape: the command, the chat, and `-` with the
 * text on stdin for a write. Everything the normaliser accepted is kept exactly
 * as approved, and the argv shape itself passes through untouched (the policy
 * has already checked any extra flat fields against it).
 */
export function upstreamToolArguments(tool: string, args: Record<string, unknown>): Record<string, unknown> {
	if (tool !== "telegram_read" && tool !== "telegram_write") return args;
	if (args.args !== undefined) return args;
	const normalized = normalizeToolCall(tool, args);
	// A denied call is never forwarded; hand the original back untouched.
	if (!normalized.ok) return args;
	const { view } = normalized;
	const argv = [view.command, ...(view.chat === undefined ? [] : [view.chat])];
	if (view.text === undefined) return { args: argv };
	argv.push("-");
	return { args: argv, stdin: view.text };
}

/**
 * Normalise one `telegram_read` / `telegram_write` call.
 *
 * `telegram_help` and `tools/list` never reach this function: the policy allows
 * them before it looks at a command.
 */
export function normalizeToolCall(tool: string, args: Record<string, unknown>): TelegramToolCallNormalization {
	const argvShape = args.args !== undefined;
	if (argvShape) return normalizeArgvCall(tool, args);
	return normalizeFlatCall(tool, args);
}

function normalizeArgvCall(tool: string, args: Record<string, unknown>): TelegramToolCallNormalization {
	const raw = args.args;
	if (!Array.isArray(raw)) {
		return deny('"args" must be a non-empty array of strings (the CLI argv, starting with the command)');
	}
	if (raw.length === 0) {
		return deny('"args" must be a non-empty array of strings (the CLI argv, starting with the command)');
	}
	for (const entry of raw) {
		if (typeof entry !== "string" || entry.length === 0) {
			return deny('"args" must contain only non-empty strings');
		}
	}
	const argv = raw as string[];
	const command = canonicalCommand(argv[0]!);
	if (!command) return deny('argv[0] must name a telegram command');

	const blacklist = blacklistReason(argv) ?? blacklistReasonFlat(args, command);
	if (blacklist) return deny(blacklist);
	const denied = DENIED_COMMANDS[command];
	if (denied) return deny(`telegram command "${command}" is denied: ${denied}`);
	const spec = READ_COMMANDS[command] ?? WRITE_COMMANDS[command];
	if (!spec) {
		return deny(`unknown telegram command "${command}"; allowed commands: ${TELEGRAM_ALLOWED_COMMANDS.join(", ")}`);
	}
	const toolMismatch = checkToolMatchesCommand(tool, command, spec);
	if (toolMismatch) return deny(toolMismatch);

	const parsed = parseArgv(argv);
	if (!parsed.ok) return deny(parsed.reason);
	const { positionals, flags } = parsed.parsed;

	const positionalCount = checkPositionalCount(command, spec, positionals);
	if (positionalCount) return deny(positionalCount);
	if (command === "write-access" && flags.has("--for")) {
		return deny('telegram command "write-access" is read-only here: changing the write mode is not allowed');
	}
	if (spec.stdinOnly) {
		const textToken = positionals[spec.textIndex! - 1];
		if (textToken !== "-") {
			return deny(`telegram command "${command}" takes its text on stdin: the text argument must be "-"`);
		}
	}

	const chatResult = resolveArgvChat(positionals, flags, spec);
	if (!chatResult.ok) return deny(chatResult.reason);
	const chat = chatResult.chat;

	const textResult = resolveArgvText(positionals, spec, args.stdin);
	if (!textResult.ok) return deny(textResult.reason);

	const mixed = checkMixedShapes(args, command, chat, textResult.text);
	if (mixed) return deny(mixed);

	const view: TelegramToolCallView = {
		command,
		argv: [...argv],
		write: spec.write,
		...(chat === undefined ? {} : { chat }),
		...(textResult.text === undefined ? {} : { text: textResult.text }),
	};
	return { ok: true, view };
}

function normalizeFlatCall(tool: string, args: Record<string, unknown>): TelegramToolCallNormalization {
	if (args.stdin !== undefined) {
		return deny("mixed argument shapes: stdin is only valid together with the argv shape (`args`)");
	}

	const action = firstFlatString(args, ACTION_KEYS);
	if (action !== undefined && !action.ok) return deny(action.reason);
	const command = action?.value === undefined ? defaultFlatCommand(tool) : canonicalCommand(action.value);
	if (!command) {
		return deny(`cannot infer a telegram command from the flat arguments; use "args" or one of ${ACTION_KEYS.join(", ")}`);
	}

	const blacklist = blacklistReasonFlat(args, command);
	if (blacklist) return deny(blacklist);
	const denied = DENIED_COMMANDS[command];
	if (denied) return deny(`telegram command "${command}" is denied: ${denied}`);
	const spec = READ_COMMANDS[command] ?? WRITE_COMMANDS[command];
	if (!spec) {
		return deny(`unknown telegram command "${command}"; allowed commands: ${TELEGRAM_ALLOWED_COMMANDS.join(", ")}`);
	}
	const toolMismatch = checkToolMatchesCommand(tool, command, spec);
	if (toolMismatch) return deny(toolMismatch);

	const chatResult = resolveFlatChat(args);
	if (!chatResult.ok) return deny(chatResult.reason);
	const chat = chatResult.chat;

	let text: string | undefined;
	if (spec.textIndex !== undefined) {
		const flatText = resolveFlatText(args);
		if (!flatText.ok) return deny(flatText.reason);
		text = flatText.text;
		// The flat shape must satisfy the same requirement as the argv shape:
		// the upstream stores the text on stdin and rejects a write without it,
		// so an empty send would burn a write slot for nothing.
		if (spec.textRequired && (text === undefined || text.trim().length === 0)) {
			return deny(
				`telegram command "${command}" requires non-empty text; got ${text === undefined ? "none" : "an empty string"}`,
			);
		}
	}

	// The flat shape has no original argv. Build the command that will be shown
	// on the confirmation card.
	const displayArgv = [command, ...(chat === undefined ? [] : [chat]), ...(text === undefined ? [] : [text])];
	const view: TelegramToolCallView = {
		command,
		argv: displayArgv,
		write: spec.write,
		...(chat === undefined ? {} : { chat }),
		...(text === undefined ? {} : { text }),
	};
	return { ok: true, view };
}

function checkToolMatchesCommand(tool: string, command: string, spec: CommandSpec): string | undefined {
	if (tool === "telegram_read" && spec.write) {
		return `command "${command}" is a write; call it through telegram_write`;
	}
	if (tool === "telegram_write" && !spec.write) {
		return `command "${command}" is not a write; call it through telegram_read`;
	}
	return undefined;
}

/**
 * Strict positional count: flags are already removed, so a leftover token is
 * either an argument the command does not take or a multi-word text that the
 * caller should have passed on stdin. Guessing would shift the chat/text.
 */
function checkPositionalCount(command: string, spec: CommandSpec, positionals: string[]): string | undefined {
	const got = positionals.length;
	const { min, max } = spec.positionals;
	if (got >= min && got <= max) return undefined;
	if (command === "write-access") {
		return 'telegram command "write-access" is read-only here: changing the write mode is not allowed';
	}
	const expected =
		min === max ? `exactly ${min}` : max === Number.POSITIVE_INFINITY ? `at least ${min}` : `${min} to ${max}`;
	let hint = "";
	if (got < min && spec.chatIndex > 0 && got < spec.chatIndex) {
		hint = " (the chat argument is missing)";
	} else if (got < min && spec.textIndex !== undefined && got < spec.textIndex) {
		hint = " (the text argument is missing)";
	} else if (got > max) {
		hint =
			spec.textIndex !== undefined
				? ' (multi-word text must go on stdin with "-")'
				: " (unexpected extra positional arguments)";
	}
	return `telegram command "${command}" expects ${expected} positional argument(s), got ${got}${hint}`;
}

function defaultFlatCommand(tool: string): string | undefined {
	if (tool === "telegram_read") return "read";
	if (tool === "telegram_write") return "send";
	return undefined;
}

interface ParsedArgv {
	positionals: string[];
	flags: Map<string, string[]>;
}

type ParseArgvResult = { ok: true; parsed: ParsedArgv } | { ok: false; reason: string };

/**
 * Split argv into positionals and flags. A value flag removes its value from
 * the positionals but both stay in the original argv used for the audit.
 *
 * `-1004001` is a chat id, not a flag; only tokens that start with `-`, are not
 * a negative number and are not the literal `-` are treated as flags.
 */
function parseArgv(argv: string[]): ParseArgvResult {
	const positionals: string[] = [];
	const flags = new Map<string, string[]>();
	for (let index = 1; index < argv.length; index += 1) {
		const token = argv[index]!;
		if (!isFlagToken(token)) {
			positionals.push(token);
			continue;
		}
		let name = token;
		let inlineValue: string | undefined;
		if (token.startsWith("--")) {
			const equals = token.indexOf("=");
			if (equals > 2) {
				name = token.slice(0, equals);
				inlineValue = token.slice(equals + 1);
			}
		}
		if (VALUED_FLAGS.has(name)) {
			let value = inlineValue;
			if (value === undefined) {
				const next = argv[index + 1];
				if (next === undefined || next === "-" || isFlagToken(next)) {
					return { ok: false, reason: `flag "${name}" requires a value` };
				}
				value = next;
				index += 1;
			}
			if (value.length === 0) return { ok: false, reason: `flag "${name}" requires a non-empty value` };
			pushFlag(flags, name, value);
			continue;
		}
		if (BOOLEAN_FLAGS.has(name)) {
			if (inlineValue !== undefined) return { ok: false, reason: `flag "${name}" does not take a value` };
			pushFlag(flags, name, "");
			continue;
		}
		return { ok: false, reason: `unknown flag "${name}"; refusing to guess whether it takes a value` };
	}
	return { ok: true, parsed: { positionals, flags } };
}

function isFlagToken(token: string): boolean {
	if (token.length <= 1 || !token.startsWith("-")) return false;
	if (token === "-") return false;
	// Chat ids are negative numbers (`-1004001`); they are positionals.
	if (/^-\d+$/.test(token)) return false;
	return true;
}

function pushFlag(flags: Map<string, string[]>, name: string, value: string): void {
	const list = flags.get(name);
	if (list) list.push(value);
	else flags.set(name, [value]);
}

type ChatResolution = { ok: true; chat?: string } | { ok: false; reason: string };

function resolveArgvChat(positionals: string[], flags: Map<string, string[]>, spec: CommandSpec): ChatResolution {
	let chat: string | undefined;
	if (spec.chatIndex > 0) {
		chat = positionals[spec.chatIndex - 1];
	}
	const flagValues = flags.get("--chat") ?? [];
	if (spec.chatFlag !== undefined) {
		if (flagValues.length > 1 && new Set(flagValues).size > 1) {
			return { ok: false, reason: massSendReason(flagValues) };
		}
		chat = flagValues[0];
	} else if (flagValues.length > 0) {
		// `--chat` belongs to search; elsewhere it may only repeat the positional.
		const values = new Set(flagValues);
		if (values.size > 1 || (chat !== undefined && !values.has(chat))) {
			return { ok: false, reason: massSendReason(flagValues) };
		}
		if (chat === undefined && spec.chatIndex === 0) {
			return { ok: false, reason: '"--chat" is only supported by "search"; this command takes no chat flag' };
		}
	}

	if (chat !== undefined) {
		if (chat.trim().length === 0) return { ok: false, reason: "the chat argument is empty" };
		if (isChatList(chat)) return { ok: false, reason: massSendReason([chat]) };
	}

	// A second chat-like positional (another @name or negative id) means a list.
	const chatIndex = spec.chatIndex > 0 ? spec.chatIndex - 1 : -1;
	const queryIndex = spec.queryIndex !== undefined ? spec.queryIndex - 1 : -1;
	for (const [index, token] of positionals.entries()) {
		if (index === chatIndex || index === queryIndex) continue;
		if (!isChatLike(token)) continue;
		if (chat !== undefined && token === chat) continue;
		return { ok: false, reason: massSendReason([...(chat === undefined ? [] : [chat]), token]) };
	}
	return { ok: true, ...(chat === undefined ? {} : { chat }) };
}

type TextResolution = { ok: true; text?: string } | { ok: false; reason: string };

function resolveArgvText(positionals: string[], spec: CommandSpec, stdin: unknown): TextResolution {
	const hasStdin = stdin !== undefined;
	if (typeof stdin !== "undefined" && typeof stdin !== "string") {
		return { ok: false, reason: '"stdin" must be a string when present' };
	}
	if (spec.textIndex === undefined) {
		if (hasStdin) {
			return { ok: false, reason: "mixed argument shapes: stdin is only valid for send, reply and edit with a \"-\" text argument" };
		}
		return { ok: true };
	}

	const start = spec.textIndex - 1;
	const tokens = positionals.slice(start);
	const positionalText = tokens.length === 0 ? undefined : tokens.join(" ");
	let text: string | undefined;
	if (positionalText === undefined) {
		if (hasStdin) {
			return { ok: false, reason: "mixed argument shapes: stdin is only valid when the text argument is \"-\"" };
		}
		text = undefined;
	} else if (positionalText === "-") {
		if (!hasStdin) {
			return { ok: false, reason: 'the text argument is "-" but no stdin was provided' };
		}
		text = stdin as string;
	} else {
		if (hasStdin) {
			return { ok: false, reason: "mixed argument shapes: stdin is only valid when the text argument is \"-\"" };
		}
		text = positionalText;
	}

	if (spec.textRequired && (text === undefined || text.trim().length === 0)) {
		return { ok: false, reason: `telegram command requires non-empty text (positionals or stdin); got ${text === undefined ? "none" : "an empty string"}` };
	}
	return { ok: true, ...(text === undefined ? {} : { text }) };
}

type FlatChatResolution = { ok: true; chat?: string } | { ok: false; reason: string };

function resolveFlatChat(args: Record<string, unknown>): FlatChatResolution {
	const found: string[] = [];
	for (const key of CHAT_KEYS) {
		if (!Object.prototype.hasOwnProperty.call(args, key)) continue;
		const value = args[key];
		if (Array.isArray(value)) return { ok: false, reason: massSendReason([key]) };
		if (typeof value === "string") {
			found.push(value);
			continue;
		}
		if (typeof value === "number" && Number.isFinite(value)) {
			found.push(String(value));
			continue;
		}
		return {
			ok: false,
			reason: `cannot resolve target chat: expected one of ${CHAT_KEYS.join(", ")} to be a string or number`,
		};
	}
	const distinct = [...new Set(found)];
	if (distinct.length > 1) return { ok: false, reason: massSendReason(distinct) };
	const chat = distinct[0];
	if (chat !== undefined && isChatList(chat)) return { ok: false, reason: massSendReason([chat]) };
	return { ok: true, ...(chat === undefined ? {} : { chat }) };
}

type FlatTextResult = { ok: true; text?: string } | { ok: false; reason: string };

/** Flat text is optional: old callers used `send` with a chat only. */
function resolveFlatText(args: Record<string, unknown>): FlatTextResult {
	const found: string[] = [];
	for (const key of TEXT_KEYS) {
		if (!Object.prototype.hasOwnProperty.call(args, key)) continue;
		const value = args[key];
		if (value === undefined) continue;
		if (typeof value !== "string") {
			return { ok: false, reason: `"${key}" must be a string` };
		}
		found.push(value);
	}
	const distinct = [...new Set(found)];
	if (distinct.length > 1) return { ok: false, reason: "conflicting text fields in the flat arguments" };
	return { ok: true, ...(distinct[0] === undefined ? {} : { text: distinct[0] }) };
}

/**
 * `args.args` plus legacy flat fields: matching values are harmless, differing
 * values are ambiguous and must not be guessed.
 */
function checkMixedShapes(
	args: Record<string, unknown>,
	command: string,
	chat: string | undefined,
	text: string | undefined,
): string | undefined {
	const action = firstFlatString(args, ACTION_KEYS);
	if (action !== undefined && !action.ok) return action.reason;
	if (action?.value !== undefined) {
		const flatCommand = canonicalCommand(action.value);
		if (flatCommand !== command) {
			return `mixed argument shapes: action "${action.value}" does not match argv[0] "${command}"`;
		}
	}

	const flatChat = collectFlatValues(args, CHAT_KEYS);
	if (!flatChat.ok) return flatChat.reason;
	if (flatChat.values.length > 1) return massSendReason(flatChat.values);
	if (flatChat.values.length === 1) {
		const value = flatChat.values[0]!;
		if (isChatList(value)) return massSendReason([value]);
		if (chat === undefined || value !== chat) {
			return `mixed argument shapes: flat chat "${value}" does not match the argv chat "${chat ?? ""}"`;
		}
	}

	const flatText = collectFlatValues(args, TEXT_KEYS);
	if (!flatText.ok) return flatText.reason;
	if (flatText.values.length > 1) return "mixed argument shapes: conflicting flat text fields";
	if (flatText.values.length === 1) {
		const value = flatText.values[0]!;
		if (text === undefined || value !== text) {
			return "mixed argument shapes: flat text does not match the argv text";
		}
	}
	return undefined;
}

function collectFlatValues(
	args: Record<string, unknown>,
	keys: readonly string[],
): { ok: true; values: string[] } | { ok: false; reason: string } {
	const values: string[] = [];
	for (const key of keys) {
		if (!Object.prototype.hasOwnProperty.call(args, key)) continue;
		const value = args[key];
		if (value === undefined) continue;
		if (Array.isArray(value)) return { ok: false, reason: massSendReason([key]) };
		if (typeof value === "string") {
			values.push(value);
			continue;
		}
		if (typeof value === "number" && Number.isFinite(value)) {
			values.push(String(value));
			continue;
		}
		return { ok: false, reason: `"${key}" must be a string or number` };
	}
	return { ok: true, values };
}

function firstFlatString(
	args: Record<string, unknown>,
	keys: readonly string[],
): { ok: true; value?: string } | { ok: false; reason: string } {
	const found: string[] = [];
	for (const key of keys) {
		if (!Object.prototype.hasOwnProperty.call(args, key)) continue;
		const value = args[key];
		if (value === undefined) continue;
		if (typeof value !== "string") return { ok: false, reason: `"${key}" must be a string` };
		found.push(value);
	}
	const distinct = [...new Set(found)];
	if (distinct.length > 1) return { ok: false, reason: "conflicting action fields in the flat arguments" };
	return { ok: true, ...(distinct[0] === undefined ? {} : { value: distinct[0] }) };
}

/** camelCase, snake_case and spaced action names all map to the CLI spelling. */
function canonicalCommand(value: string): string {
	return value
		.trim()
		.replace(/([a-z0-9])([A-Z])/g, "$1-$2")
		.replace(/[\s_]+/g, "-")
		.toLowerCase();
}

function isChatList(chat: string): boolean {
	return chat.split(",").filter((part) => part.trim().length > 0).length > 1;
}

function isChatLike(token: string): boolean {
	if (token.startsWith("@") && token.length > 1) return true;
	// Telegram chat ids are negative; four digits keeps `-5` (a number/text) out.
	return /^-\d{4,}$/.test(token);
}

function massSendReason(chats: string[]): string {
	return `mass send denied: the call names more than one chat (${chats.map((chat) => `"${chat}"`).join(", ")}); one chat per call is allowed`;
}

/** Tokens checked for broadcast/invite/join/leave/delete patterns. */
export function blacklistReason(tokens: readonly string[]): string | undefined {
	for (const token of tokens) {
		const normalized = token
			.replace(/^-+/, "")
			.replace(/([a-z0-9])([A-Z])/g, "$1_$2")
			.toLowerCase()
			.replace(/[\s-]+/g, "_");
		if (/(^|_)(broadcast|mass_send|send_to_all|send_to_many|sendtoall)(_|$)/.test(normalized)) {
			return "mass send denied: broadcast/mass sending is not allowed";
		}
		if (/(^|_)(invite|join)(_|$)/.test(normalized)) {
			return `"${token}" is denied: inviting or joining chats is not allowed`;
		}
		if (/(^|_)(leave|kick|ban)(_|$)/.test(normalized)) {
			return `"${token}" is denied: leaving, kicking or banning is not allowed`;
		}
		if (/(delete|remove)_(chat|dialog|conversation)/.test(normalized)) {
			return `"${token}" is denied: deleting chats is not allowed`;
		}
	}
	return undefined;
}

function blacklistReasonFlat(args: Record<string, unknown>, command: string): string | undefined {
	for (const key of RECIPIENT_LIST_KEYS) {
		const value = args[key];
		if (Array.isArray(value) && value.length > 1) {
			return `mass send denied: "${key}" lists ${value.length} recipients; only one recipient per call is allowed`;
		}
		if (typeof value === "string" && isChatList(value)) {
			return `mass send denied: "${key}" lists multiple recipients; only one recipient per call is allowed`;
		}
	}
	if (args.broadcast === true || args.mass === true || args.sendToMany === true || args.send_to_many === true) {
		return "mass send denied: broadcast/mass sending is not allowed";
	}
	const tokens: string[] = [command];
	for (const key of [...CHAT_KEYS, ...TEXT_KEYS]) {
		const value = args[key];
		if (typeof value === "string") tokens.push(value);
	}
	return blacklistReason(tokens);
}

function deny(reason: string): TelegramToolCallNormalization {
	return { ok: false, reason };
}
