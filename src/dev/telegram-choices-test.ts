/**
 * Structured choices and reply keyboards for Telegram (#266, slice 2).
 *
 *   npm run test:choices
 *
 * Pure validation/markup/store tests plus a module pass with a fake Bot API:
 * inline callbacks, stale/expired/foreign sets, edit failures, repeat presses
 * across a process restart, reply-keyboard label mapping and the backwards
 * compatible `[button pressed]` path.
 */
import * as assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { DEFAULT_CONFIG, loadConfig } from "../config.js";
import { createAliveTools, type RunHandle, type ToolDeps } from "../runtime/tools.js";
import { ModuleHost } from "../events/host.js";
import { Logger } from "../log.js";
import { EventStore, type AliveEvent } from "../store/events.js";
import { HistoryStore } from "../store/history.js";
import { Outbox, type OutgoingMessage } from "../store/outbox.js";
import { TelegramModule } from "../modules/telegram/module.js";
import {
	CHOICE_ALREADY_ANSWER,
	CHOICE_PROMPT_HINT,
	CHOICE_REPLY_KEYBOARD_REMOVED_TEXT,
	CHOICE_STALE_ANSWER,
	ChoiceStore,
	TELEGRAM_CHOICE_CALLBACK_PREFIX,
	TELEGRAM_CHOICE_ID_PATTERN,
	TELEGRAM_CHOICE_LABEL_MAX,
	TELEGRAM_CHOICE_MAX_OPTIONS,
	TELEGRAM_CHOICE_SET_ID_PATTERN,
	TELEGRAM_CHOICE_SET_LIMIT,
	TELEGRAM_CHOICE_SET_TTL_MS,
	choiceCallbackData,
	choiceEventText,
	choicesToReplyMarkup,
	newChoiceSetId,
	parseChoiceCallbackData,
	replyKeyboardOptions,
	replyKeyboardToReplyMarkup,
	validateChoiceInputs,
	validateChoices,
	validateReplyKeyboard,
	type ChoicePress,
	type ChoiceSet,
} from "../modules/telegram/choices.js";
import { TELEGRAM_CALLBACK_DATA_MAX_BYTES } from "../modules/telegram/buttons.js";
import { normalizeChoicePress, normalizeUpdate } from "../modules/telegram/update.js";
import { splitMessage } from "../modules/telegram/text.js";
import { htmlToPlainText } from "../modules/telegram/markdown.js";
import type { TelegramChat, TelegramUpdate } from "../modules/telegram/types.js";
import { readJsonl } from "../util.js";

let failures = 0;

function check(name: string, condition: boolean, detail?: unknown): void {
	if (condition) {
		process.stdout.write(`  ok    ${name}\n`);
		return;
	}
	failures += 1;
	process.stdout.write(`  FAIL  ${name}${detail === undefined ? "" : ` — ${JSON.stringify(detail)}`}\n`);
}

function section(name: string): void {
	process.stdout.write(`\n${name}\n`);
}

async function expectError(name: string, operation: () => unknown | Promise<unknown>, pattern: RegExp): Promise<void> {
	try {
		await operation();
		check(name, false, "expected an error");
	} catch (error) {
		const text = error instanceof Error ? error.message : String(error);
		check(name, pattern.test(text), text);
	}
}

function mode(file: string): number {
	return fs.statSync(file).mode & 0o777;
}

const option = (id: string, label: string) => ({ id, label });
const tenOptions = Array.from({ length: TELEGRAM_CHOICE_MAX_OPTIONS }, (_, index) => option(`o${index + 1}`, `Option ${index + 1}`));

// ---------------------------------------------------------------------------
section("choices: validation");
{
	validateChoices([option("yes", "Yes")]);
	validateChoices(tenOptions);
	check("1 and 10 choices validate", true);

	assert.throws(() => validateChoices([]), /1–10/);
	check("an empty choices list is rejected", true);
	assert.throws(() => validateChoices([...tenOptions, option("extra", "Extra")]), /at most 10/);
	check("more than 10 choices are rejected", true);
	for (const id of ["", "Bad", "with space", "a".repeat(21), "кириллица"]) {
		assert.throws(() => validateChoices([option(id, `Label ${id}`)]), /id must be a short slug/);
	}
	check("ids must be a-z0-9_- and 1–20 chars", true);
	assert.throws(() => validateChoices([option("ok", "   ")]), /non-empty/);
	assert.throws(() => validateChoices([option("ok", "x".repeat(TELEGRAM_CHOICE_LABEL_MAX + 1))]), /at most 64/);
	check("labels are 1–64 non-empty chars", true);
	assert.throws(() => validateChoices([option("dup", "One"), option("dup", "Two")]), /duplicated/);
	assert.throws(() => validateChoices([option("one", "Same"), option("two", "Same")]), /duplicated/);
	check("duplicate option ids and labels are rejected", true);
	assert.throws(() => validateChoiceInputs({ choices: [option("yes", "Yes")], buttons: [[{ text: "x", data: "x" }]] }), /either `choices` or `buttons`/);
	check("choices and buttons are mutually exclusive", true);
	assert.throws(() => validateChoiceInputs({ keyboard: { rows: [["Yes"]] }, buttons: [[{ text: "x", data: "x" }]] }), /either `keyboard` or `buttons`/);
	check("keyboard and buttons are mutually exclusive", true);
	assert.throws(() => validateChoiceInputs({ choices: [option("yes", "Yes")], keyboard: { rows: [["Yes"]] } }), /either `choices` or `keyboard`/);
	check("choices and keyboard are mutually exclusive", true);
	assert.throws(
		() => validateChoices([{ id: "yes", label: "Yes", url: "https://example.com" }] as never),
		/not a button/,
	);
	check("choices cannot smuggle url or callback buttons", true);
}

// ---------------------------------------------------------------------------
section("reply keyboard: validation");
{
	validateReplyKeyboard({ rows: [["Yes"], ["No", "Maybe"]] });
	check("a normal reply keyboard validates", true);
	assert.throws(() => validateReplyKeyboard({ rows: [] }), /1–5 rows/);
	assert.throws(() => validateReplyKeyboard({ rows: [["1"], ["2"], ["3"], ["4"], ["5"], ["6"]] }), /1–5 rows/);
	check("row count is 1–5", true);
	assert.throws(() => validateReplyKeyboard({ rows: [[]] }), /1–4 buttons/);
	assert.throws(() => validateReplyKeyboard({ rows: [["1", "2", "3", "4", "5"]] }), /1–4 buttons/);
	check("buttons per row are 1–4", true);
	assert.throws(() => validateReplyKeyboard({ rows: [[""]] }), /non-empty/);
	assert.throws(() => validateReplyKeyboard({ rows: [["x".repeat(TELEGRAM_CHOICE_LABEL_MAX + 1)]] }), /at most 64/);
	assert.throws(() => validateReplyKeyboard({ rows: [["Yes", "Yes"]] }), /duplicated/);
	check("keyboard labels are non-empty, at most 64 and unique", true);
}

// ---------------------------------------------------------------------------
section("choices: callback data and markup");
{
	const setId = newChoiceSetId();
	check("set ids are eight base36 chars", TELEGRAM_CHOICE_SET_ID_PATTERN.test(setId) && setId.length === 8, setId);
	check(
		"callback data uses the internal namespace and both ids",
		choiceCallbackData(setId, "yes") === `${TELEGRAM_CHOICE_CALLBACK_PREFIX}${setId}:yes`,
	);
	const parsed = parseChoiceCallbackData(choiceCallbackData(setId, "yes"));
	check("callback data parses back", parsed?.setId === setId && parsed?.optionId === "yes", parsed);
	check(
		"unrelated, malformed and foreign callbacks are not parsed as choices",
		parseChoiceCallbackData("plain") === undefined &&
			parseChoiceCallbackData(`alive:ch:${setId}`) === undefined &&
			parseChoiceCallbackData(`alive:ch:${setId}:Bad`) === undefined &&
			parseChoiceCallbackData(`alive:ch:${setId}:yes:extra`) === undefined,
	);

	const markup = choicesToReplyMarkup(setId, tenOptions);
	check(
		"inline markup groups at most three choices per row",
		markup.inline_keyboard.length === 4 &&
			markup.inline_keyboard.slice(0, 3).every((row) => row.length === 3) &&
			markup.inline_keyboard[3]?.length === 1,
		markup.inline_keyboard.map((row) => row.length),
	);
	check(
		"every inline callback carries the set and option ids",
		markup.inline_keyboard.flat().every((button) => {
			const value = button as { text: string; callback_data: string };
			return value.callback_data.startsWith(`${TELEGRAM_CHOICE_CALLBACK_PREFIX}${setId}:`);
		}),
	);

	const overlong = "x".repeat(TELEGRAM_CALLBACK_DATA_MAX_BYTES);
	await expectError(
		"an over-64-byte callback is a hard error, never truncated",
		() => choiceCallbackData(overlong, "yes"),
		/at most 64 bytes/,
	);

	const reply = replyKeyboardToReplyMarkup({ rows: [["Yes", "No"]] });
	check(
		"reply keyboard markup nests text buttons and resizes the keyboard",
		reply.resize_keyboard === true &&
			reply.keyboard.length === 1 &&
			reply.keyboard[0]?.length === 2 &&
			reply.keyboard[0]?.[0]?.text === "Yes",
		reply,
	);
	const mapped = replyKeyboardOptions({ rows: [["Yes", "No"], ["Да", "Нет"]] });
	check(
		"reply labels map to short, unique option ids (Cyrillic transliterated)",
		mapped.length === 4 &&
			mapped.every((entry) => TELEGRAM_CHOICE_ID_PATTERN.test(entry.id)) &&
			mapped[2]?.id === "da" &&
			new Set(mapped.map((entry) => entry.id)).size === 4,
		mapped,
	);
	const duplicateLabels = replyKeyboardOptions({ rows: [["Go", "Go 2"], ["go", "Go"]] });
	check("colliding slugs still produce unique ids", new Set(duplicateLabels.map((entry) => entry.id)).size === 4, duplicateLabels);
}

// ---------------------------------------------------------------------------
section("choices: structured event text");
{
	const press: ChoicePress = {
		set: "abcd1234",
		optionId: "yes",
		label: "Yes",
		messageId: 42,
		thread: "telegram:123",
		source: "inline",
	};
	const body = choiceEventText(press);
	check("event body starts with [choice]", body.startsWith("[choice] "), body);
	const parsed = JSON.parse(body.slice("[choice] ".length)) as Record<string, unknown>;
	check(
		"event JSON has the contract keys in order",
		JSON.stringify(Object.keys(parsed)) === JSON.stringify(["set", "option_id", "label", "message_id", "thread", "source"]),
		Object.keys(parsed),
	);
	check(
		"event JSON values keep message_id numeric and thread/source strings",
		parsed.set === "abcd1234" &&
			parsed.option_id === "yes" &&
			parsed.label === "Yes" &&
			parsed.message_id === 42 &&
			parsed.thread === "telegram:123" &&
			parsed.source === "inline",
		parsed,
	);
	const prompt = normalizeChoicePress({
		updateId: 1,
		chat: { id: 123, type: "private", first_name: "Alice" },
		thread: "telegram:123",
		messageId: 42,
		from: { id: 7, is_bot: false, first_name: "Alice" },
		set: "abcd1234",
		optionId: "yes",
		label: "Yes",
		source: "inline",
		callbackQueryId: "cb",
	});
	check("the normalized text is the one-line body", prompt.text === body, prompt.text);
	check("promptText adds the short hint", prompt.promptText === `${body}\n${CHOICE_PROMPT_HINT}`, prompt.promptText);
	check(
		"payload carries the structured choice",
		JSON.stringify(prompt.payload.choice) ===
			JSON.stringify({ set: "abcd1234", optionId: "yes", label: "Yes", messageId: 42, source: "inline" }),
		prompt.payload.choice,
	);
}

// ---------------------------------------------------------------------------
section("choice store: disk shape, modes, TTL and limit");
{
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "alive-choices-store-"));
	const store = new ChoiceStore(root);
	const created = store.create({
		chatId: "42",
		thread: "telegram:42",
		text: "Pick one",
		options: [option("yes", "Yes"), option("no", "No")],
		source: "inline",
	});
	const file = store.file(created.setId);
	check("the choices directory is private (0700)", mode(store.dir) === 0o700, mode(store.dir).toString(8));
	check("the set file is private (0600)", fs.existsSync(file) && mode(file) === 0o600, fs.existsSync(file) ? mode(file).toString(8) : "missing");
	const raw = JSON.parse(fs.readFileSync(file, "utf8")) as ChoiceSet;
	check(
		"the set file has every contract field",
		raw.setId === created.setId &&
			raw.chatId === "42" &&
			raw.thread === "telegram:42" &&
			raw.text === "Pick one" &&
			raw.options.length === 2 &&
			raw.chosen === null &&
			raw.createdAt === created.createdAt &&
			raw.source === "inline" &&
			raw.messageId === undefined,
		raw,
	);
	check(
		"a plain set omits parseMode, so old JSON without it still loads",
		raw.parseMode === undefined && store.get(created.setId) !== undefined,
		raw.parseMode,
	);
	const known = store.setMessageId(created.setId, 77);
	check("messageId is filled after the send", known?.messageId === 77);
	const chosen = store.choose(created.setId, option("yes", "Yes"), "7");
	check(
		"chosen is persisted with id, label, time and presser",
		chosen?.chosen?.id === "yes" && chosen?.chosen?.label === "Yes" && chosen.chosen.by === "7" && typeof chosen.chosen.at === "number",
		chosen?.chosen,
	);
	const reloaded = new ChoiceStore(root).get(created.setId);
	check("a fresh store reads the chosen state back (restart)", reloaded?.chosen?.id === "yes" && reloaded.messageId === 77, reloaded);

	const stale = store.create({ chatId: "42", thread: "telegram:42", text: "Old", options: [option("a", "A")], source: "inline" });
	const staleRaw = JSON.parse(fs.readFileSync(store.file(stale.setId), "utf8")) as ChoiceSet;
	staleRaw.createdAt = Date.now() - TELEGRAM_CHOICE_SET_TTL_MS - 1;
	fs.writeFileSync(store.file(stale.setId), JSON.stringify(staleRaw));
	check("an expired set no longer resolves", store.get(stale.setId) === undefined && !fs.existsSync(store.file(stale.setId)));

	const corruptId = newChoiceSetId();
	fs.writeFileSync(path.join(store.dir, `${corruptId}.json`), "{not json");
	check("a corrupt set is treated as expired, not an exception", store.get(corruptId) === undefined);
	store.prune();
	check("prune removes the corrupt file", !fs.existsSync(path.join(store.dir, `${corruptId}.json`)));

	const reply = store.create({
		chatId: "42",
		thread: "telegram:42",
		text: "Reply menu",
		options: replyKeyboardOptions({ rows: [["Yes", "No"]] }),
		source: "reply_keyboard",
	});
	check("an exact reply label finds its active set", store.findReplySet("42", "Yes")?.setId === reply.setId);
	check("a non-matching label does not", store.findReplySet("42", "Yess") === undefined && store.findReplySet("99", "Yes") === undefined);
	store.choose(reply.setId, reply.options[0]!, "7");
	check("an answered reply set is no longer active", store.findReplySet("42", "Yes") === undefined);
	const oldReply = store.create({
		chatId: "42",
		thread: "telegram:42",
		text: "Old menu",
		options: [option("old", "Old")],
		source: "reply_keyboard",
	});
	const oldReplyRaw = JSON.parse(fs.readFileSync(store.file(oldReply.setId), "utf8")) as ChoiceSet;
	oldReplyRaw.createdAt = Date.now() - 10_000;
	fs.writeFileSync(store.file(oldReply.setId), JSON.stringify(oldReplyRaw));
	const newReply = store.create({
		chatId: "42",
		thread: "telegram:42",
		text: "New menu",
		options: [option("new", "New")],
		source: "reply_keyboard",
	});
	check(
		"only the newest reply keyboard in the chat is active",
		store.findReplySet("42", "New")?.setId === newReply.setId && store.findReplySet("42", "Old") === undefined,
	);

	// #279: a reply keyboard belongs to one thread, and expiry is decided by the
	// store clock, not by the caller.
	const threadRoot = fs.mkdtempSync(path.join(os.tmpdir(), "alive-choices-thread-"));
	let clock = Date.now();
	const threadStore = new ChoiceStore(threadRoot, () => clock);
	const topicReply = threadStore.create({
		chatId: "42",
		thread: "telegram:42/7",
		text: "Topic menu",
		options: [option("yes", "Yes")],
		source: "reply_keyboard",
	});
	check(
		"a reply set matches only in its own thread",
		threadStore.findReplySet("42", "Yes", "telegram:42/7")?.setId === topicReply.setId &&
			threadStore.findReplySet("42", "Yes", "telegram:42") === undefined &&
			threadStore.findReplySet("42", "Yes", "telegram:42/8") === undefined,
	);
	check("omitting the thread keeps the chat-wide lookup", threadStore.findReplySet("42", "Yes")?.setId === topicReply.setId);
	check("a near-miss label stays unmatched in a thread", threadStore.findReplySet("42", "Yess", "telegram:42/7") === undefined);
	clock += TELEGRAM_CHOICE_SET_TTL_MS + 1;
	check("an expired reply set is not found in its thread", threadStore.findReplySet("42", "Yes", "telegram:42/7") === undefined);

	const limitRoot = fs.mkdtempSync(path.join(os.tmpdir(), "alive-choices-limit-"));
	const limitStore = new ChoiceStore(limitRoot);
	for (let index = 0; index < TELEGRAM_CHOICE_SET_LIMIT + 5; index += 1) {
		limitStore.create({
			setId: index.toString(36).padStart(8, "0"),
			chatId: "42",
			thread: "telegram:42",
			text: `Set ${index}`,
			options: [option("a", "A")],
			source: "inline",
		});
	}
	const files = fs.readdirSync(limitStore.dir).filter((name) => name.endsWith(".json"));
	check(`the store keeps at most ${TELEGRAM_CHOICE_SET_LIMIT} sets`, files.length === TELEGRAM_CHOICE_SET_LIMIT, files.length);
}

// ---------------------------------------------------------------------------
section("module: inline choices, presses and stale sets");
{
	const moduleRoot = fs.mkdtempSync(path.join(os.tmpdir(), "alive-telegram-choices-test-"));
	fs.writeFileSync(path.join(moduleRoot, "SOUL.md"), "choices test soul\n");
	fs.writeFileSync(path.join(moduleRoot, "CONTRACT.md"), "choices test contract\n");
	const logFile = path.join(moduleRoot, "test-log.jsonl");
	const log = new Logger({ console: false, level: "warn", file: logFile, scope: "telegram-choices-test" });
	const store = EventStore.open(moduleRoot);
	const history = HistoryStore.open(moduleRoot);
	const outbox = new Outbox(moduleRoot);
	const calls: Array<{ method: string; params: Record<string, unknown> }> = [];
	let nextMessageId = 500;
	let lastMessageId = 0;
	let failEditFor: number | undefined;
	let failEditParseModeFor: number | undefined;

	const jsonResponse = (body: unknown, status = 200): Response =>
		new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
	const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
		const url = String(input);
		const method = url.slice(url.lastIndexOf("/") + 1);
		const params = init?.body && !(init.body instanceof FormData) ? (JSON.parse(String(init.body)) as Record<string, unknown>) : {};
		calls.push({ method, params });
		if (method === "getMe") return jsonResponse({ ok: true, result: { id: 999, is_bot: true, first_name: "Alive", username: "alive_bot" } });
		if (method === "deleteWebhook") return jsonResponse({ ok: true, result: true });
		if (method === "getUpdates") {
			return new Promise<Response>((resolve) => {
				const timer = setTimeout(() => resolve(jsonResponse({ ok: true, result: [] })), 10);
				init?.signal?.addEventListener(
					"abort",
					() => {
						clearTimeout(timer);
						resolve(jsonResponse({ ok: true, result: [] }));
					},
					{ once: true },
				);
			});
		}
		if (method === "sendMessage") {
			nextMessageId += 1;
			lastMessageId = nextMessageId;
			return jsonResponse({ ok: true, result: { message_id: nextMessageId, date: 1, chat: { id: Number(params.chat_id), type: "private" } } });
		}
		if (method === "editMessageText") {
			if (
				failEditParseModeFor !== undefined &&
				Number(params.message_id) === failEditParseModeFor &&
				params.parse_mode === "HTML"
			) {
				return jsonResponse(
					{ ok: false, error_code: 400, description: "Bad Request: can't parse entities: unexpected end tag" },
					400,
				);
			}
			if (failEditFor !== undefined && Number(params.message_id) === failEditFor) {
				return jsonResponse({ ok: false, error_code: 400, description: "Bad Request: message to edit not found" }, 400);
			}
			return jsonResponse({ ok: true, result: true });
		}
		if (method === "answerCallbackQuery") return jsonResponse({ ok: true, result: true });
		return jsonResponse({ ok: true, result: true });
	}) as unknown as typeof fetch;

	const config = loadConfig({
		cwd: moduleRoot,
		overrides: {
			chat: { console: false, http: { enabled: false, host: "127.0.0.1", port: 0, token: "" } },
			modules: {
				telegram: {
					...DEFAULT_CONFIG.modules.telegram,
					enabled: true,
					token: "choices-test-token",
					tokenEnv: "ALIVE_CHOICES_TEST_TOKEN_UNSET",
					apiBase: "https://telegram.invalid",
					allowedChatIds: ["42"],
					allowedUserIds: ["7"],
					pollTimeoutSec: 0,
					parseMode: "",
				},
				grafana: { ...DEFAULT_CONFIG.modules.grafana, enabled: false },
				external: [],
			},
		},
	});
	const privateChat: TelegramChat = { id: 42, type: "private", first_name: "Alice", username: "alice" };
	const workspace = config.paths.workspaceDir;
	fs.mkdirSync(workspace, { recursive: true });

	const realFetch = globalThis.fetch;
	globalThis.fetch = fetchImpl;
	let host: ModuleHost | undefined;
	let telegram = new TelegramModule(config.config.modules.telegram);
	const boot = async (): Promise<void> => {
		telegram = new TelegramModule(config.config.modules.telegram);
		host = new ModuleHost({
			config,
			log,
			transports: [],
			modules: [telegram],
			ingest: (event) => store.append(event),
			outbox: (limit) => outbox.list(limit),
			history,
			runtimeStatus: () => ({}),
		});
		await host.init();
		await new Promise((resolve) => setTimeout(resolve, 30));
	};
	const dispatch = (update: TelegramUpdate) =>
		(telegram as unknown as { handleUpdate(update: TelegramUpdate): Promise<void> }).handleUpdate(update);

	const event: AliveEvent = {
		seq: 1,
		id: "evt_choices_1",
		ts: Date.now(),
		kind: "user_message",
		source: "test",
		priority: "normal",
		title: "event",
		text: "event",
		thread: "telegram:42",
		expectsReply: true,
	};
	const run = { id: "run_choices", events: [event], outbound: [], currentThreads: ["telegram:42"] } as unknown as RunHandle;
	const deps = {
		config,
		history,
		outbox,
		threads: { recordOutbound: () => undefined },
		moduleTools: [],
		deliver: (message: OutgoingMessage) => host!.deliver(message),
		getRun: () => run,
		runtimeStatus: () => ({}),
		isStopping: () => false,
		log: log.child("tools"),
	} as unknown as ToolDeps;
	const sendMessage = createAliveTools(deps).find((tool) => tool.name === "send_message")!;
	const send = (params: Record<string, unknown>) =>
		sendMessage.execute("call", params as never, undefined, undefined, {} as never) as Promise<{
			content: Array<{ text: string }>;
			details: Record<string, unknown>;
		}>;
	const sentCalls = () => calls.filter((call) => call.method === "sendMessage");
	const lastSent = () => sentCalls().at(-1);
	const answers = () => calls.filter((call) => call.method === "answerCallbackQuery").map((call) => call.params);
	const edits = () => calls.filter((call) => call.method === "editMessageText").map((call) => call.params);
	const choiceEvents = () => store.all().filter((item) => item.kind === "user_message" && item.text.startsWith("[choice] "));
	let nextUpdateId = 1;
	let nextUserMessageId = 900;
	const callbackUpdate = (id: string, data: string, messageId: number, chatId = 42, userId = 7): TelegramUpdate => ({
		update_id: nextUpdateId++,
		callback_query: {
			id,
			from: { id: userId, is_bot: false, first_name: "Alice", username: "alice" },
			chat_instance: "instance",
			data,
			message: { message_id: messageId, date: 1, chat: chatId === 42 ? privateChat : { id: chatId, type: "private", first_name: "Bob" }, text: "Pick one" },
		},
	});
	const textUpdate = (text: string): TelegramUpdate => ({
		update_id: nextUpdateId++,
		message: {
			message_id: nextUserMessageId++,
			date: 1,
			chat: privateChat,
			from: { id: 7, is_bot: false, first_name: "Alice", username: "alice" },
			text,
		},
	});
	const storedSet = (setId: string): ChoiceSet => JSON.parse(fs.readFileSync(path.join(config.paths.stateDir, "telegram-choices", `${setId}.json`), "utf8")) as ChoiceSet;

	try {
		await boot();
		calls.length = 0;

		await expectError(
			"choices + buttons is a tool error",
			() => send({ thread: "telegram:42", text: "x", choices: [option("yes", "Yes")], buttons: [[{ text: "x", data: "x" }]] }),
			/either `choices` or `buttons`/,
		);
		await expectError(
			"an invalid option id is rejected before any send",
			() => send({ thread: "telegram:42", text: "x", choices: [option("Bad Id", "Yes")] }),
			/id must be a short slug/,
		);
		await expectError(
			"an invalid reply keyboard is rejected before any send",
			() => send({ thread: "telegram:42", text: "x", keyboard: { rows: [["1", "2", "3", "4", "5"]] } }),
			/1–4 buttons/,
		);
		check("no message was sent by the rejected forms", sentCalls().length === 0, sentCalls().length);

		await send({
			thread: "telegram:42",
			text: "Pick one",
			choices: [option("yes", "Yes"), option("no", "No"), option("later", "Later"), option("never", "Never")],
		});
		const choiceSend = lastSent();
		const keyboard = (choiceSend?.params.reply_markup as { inline_keyboard: Array<Array<{ text: string; callback_data: string }>> } | undefined)
			?.inline_keyboard;
		check(
			"choices render an inline keyboard with three buttons in the first row",
			keyboard?.length === 2 && keyboard[0]?.length === 3 && keyboard[1]?.length === 1,
			keyboard,
		);
		const firstData = keyboard?.[0]?.[0]?.callback_data ?? "";
		const parsed = parseChoiceCallbackData(firstData);
		check("inline callback data is the internal alive:ch payload", parsed !== undefined && firstData.startsWith("alive:ch:"), firstData);
		const setId = parsed!.setId;
		const choiceMessageId = lastMessageId;
		const stored = storedSet(setId);
		check(
			"the set is persisted with chat, thread, message id, text, options and source",
			stored.chatId === "42" &&
				stored.thread === "telegram:42" &&
				stored.messageId === choiceMessageId &&
				stored.text === "Pick one" &&
				stored.options.length === 4 &&
				stored.chosen === null &&
				stored.source === "inline",
			stored,
		);
		check("the set file is 0600", mode(path.join(config.paths.stateDir, "telegram-choices", `${setId}.json`)) === 0o600);

		// First press: answer, edit with the suffix and an empty keyboard, one event.
		const eventsBefore = choiceEvents().length;
		const editsBefore = edits().length;
		await dispatch(callbackUpdate("cb-first", firstData, choiceMessageId));
		check(
			"the first press is answered with the chosen label",
			answers().some((params) => params.callback_query_id === "cb-first" && params.text === "выбрано: Yes"),
			answers().at(-1),
		);
		const edit = edits().at(-1) as { text?: string; reply_markup?: { inline_keyboard?: unknown[] }; message_id?: number } | undefined;
		check(
			"the message is edited to the original text plus the check line",
			edit?.message_id === choiceMessageId && edit?.text === "Pick one\n\n✅ Yes",
			edit,
		);
		check(
			"the edit removes the inline keyboard",
			Array.isArray(edit?.reply_markup?.inline_keyboard) && edit?.reply_markup?.inline_keyboard?.length === 0,
			edit?.reply_markup,
		);
		check("the first press persists chosen", storedSet(setId).chosen?.id === "yes" && storedSet(setId).chosen?.by === "7", storedSet(setId).chosen);
		check("the first press emits exactly one choice event", choiceEvents().length === eventsBefore + 1);
		const eventText = choiceEvents().at(-1)!.text;
		const eventBody = eventText.split("\n")[0]!;
		const eventJson = JSON.parse(eventBody.slice("[choice] ".length)) as Record<string, unknown>;
		check(
			"the event body is the compact [choice] JSON",
			JSON.stringify(Object.keys(eventJson)) === JSON.stringify(["set", "option_id", "label", "message_id", "thread", "source"]) &&
				eventJson.set === setId &&
				eventJson.option_id === "yes" &&
				eventJson.label === "Yes" &&
				eventJson.message_id === choiceMessageId &&
				eventJson.thread === "telegram:42" &&
				eventJson.source === "inline",
			eventJson,
		);
		check("the event text also carries the short hint", eventText.includes(CHOICE_PROMPT_HINT), eventText);
		const payload = choiceEvents().at(-1)!.payload as { choice?: Record<string, unknown> };
		check(
			"the inbound payload carries choice {set, optionId, label, messageId, source}",
			JSON.stringify(payload.choice) ===
				JSON.stringify({ set: setId, optionId: "yes", label: "Yes", messageId: choiceMessageId, source: "inline" }),
			payload.choice,
		);

		// Repeat press: an answer, no edit, no event.
		const eventsAfterFirst = choiceEvents().length;
		const editsAfterFirst = edits().length;
		await dispatch(callbackUpdate("cb-repeat", firstData, choiceMessageId));
		check(
			"a repeated press answers that the choice is already made",
			answers().some((params) => params.callback_query_id === "cb-repeat" && params.text === CHOICE_ALREADY_ANSWER),
			answers().at(-1),
		);
		check("a repeated press does not edit the message", edits().length === editsAfterFirst);
		check("a repeated press emits no event", choiceEvents().length === eventsAfterFirst);

		// Stale / foreign / corrupt / expired sets.
		const staleAnswers = () => answers().filter((params) => params.text === CHOICE_STALE_ANSWER).length;
		let staleBefore = staleAnswers();
		const editsBeforeStale = edits().length;
		await dispatch(callbackUpdate("cb-unknown", `${TELEGRAM_CHOICE_CALLBACK_PREFIX}zzzzzzzz:yes`, choiceMessageId));
		check("an unknown set answers stale without an edit", staleAnswers() === staleBefore + 1 && edits().length === editsBeforeStale);
		check("an unknown set emits no event", choiceEvents().length === eventsAfterFirst);

		staleBefore = staleAnswers();
		await dispatch(callbackUpdate("cb-foreign", firstData, choiceMessageId, 99));
		check("a press from another chat answers stale", staleAnswers() === staleBefore + 1);

		// A user outside the allowlist is different from a foreign chat: no event,
		// no edit and the set stays unanswered.
		await send({ thread: "telegram:42", text: "Allowlist guard", choices: [option("yes", "Yes")] });
		const allowData = ((lastSent()?.params.reply_markup as { inline_keyboard: Array<Array<{ callback_data: string }>> }).inline_keyboard[0]![0]!
			.callback_data);
		const allowId = parseChoiceCallbackData(allowData)!.setId;
		const allowMessageId = lastMessageId;
		staleBefore = staleAnswers();
		const editsBeforeAllow = edits().length;
		const eventsBeforeAllow = choiceEvents().length;
		await dispatch(callbackUpdate("cb-not-allowed", allowData, allowMessageId, 42, 8));
		check(
			"a press by a non-allowlisted user answers stale",
			staleAnswers() === staleBefore + 1,
			answers().at(-1),
		);
		check(
			"a press by a non-allowlisted user emits no event and leaves chosen null",
			choiceEvents().length === eventsBeforeAllow && edits().length === editsBeforeAllow && storedSet(allowId).chosen === null,
			{ events: choiceEvents().length - eventsBeforeAllow, edits: edits().length - editsBeforeAllow, chosen: storedSet(allowId).chosen },
		);

		await send({ thread: "telegram:42", text: "Corrupt me", choices: [option("a", "A")] });
		const corruptData = ((lastSent()?.params.reply_markup as { inline_keyboard: Array<Array<{ callback_data: string }>> }).inline_keyboard[0]![0]!
			.callback_data);
		const corruptId = parseChoiceCallbackData(corruptData)!.setId;
		fs.writeFileSync(path.join(config.paths.stateDir, "telegram-choices", `${corruptId}.json`), "{broken");
		staleBefore = staleAnswers();
		const eventsBeforeCorrupt = choiceEvents().length;
		await dispatch(callbackUpdate("cb-corrupt", corruptData, lastMessageId));
		check(
			"a corrupt set answers stale and does not crash the module",
			staleAnswers() === staleBefore + 1 && choiceEvents().length === eventsBeforeCorrupt,
		);

		await send({ thread: "telegram:42", text: "Expire me", choices: [option("a", "A")] });
		const expireData = ((lastSent()?.params.reply_markup as { inline_keyboard: Array<Array<{ callback_data: string }>> }).inline_keyboard[0]![0]!
			.callback_data);
		const expireId = parseChoiceCallbackData(expireData)!.setId;
		const expireFile = path.join(config.paths.stateDir, "telegram-choices", `${expireId}.json`);
		const expireSet = JSON.parse(fs.readFileSync(expireFile, "utf8")) as ChoiceSet;
		expireSet.createdAt = Date.now() - TELEGRAM_CHOICE_SET_TTL_MS - 1;
		fs.writeFileSync(expireFile, JSON.stringify(expireSet));
		staleBefore = staleAnswers();
		const eventsBeforeExpired = choiceEvents().length;
		await dispatch(callbackUpdate("cb-expired", expireData, lastMessageId));
		check(
			"an expired set answers stale without an event",
			staleAnswers() === staleBefore + 1 && choiceEvents().length === eventsBeforeExpired,
		);

		// Edit failure: chosen is still saved, the press is still delivered and warned about.
		await send({ thread: "telegram:42", text: "Edit will fail", choices: [option("ok", "OK")] });
		const failData = ((lastSent()?.params.reply_markup as { inline_keyboard: Array<Array<{ callback_data: string }>> }).inline_keyboard[0]![0]!
			.callback_data);
		const failId = parseChoiceCallbackData(failData)!.setId;
		const failMessageId = lastMessageId;
		failEditFor = failMessageId;
		const eventsBeforeFail = choiceEvents().length;
		await dispatch(callbackUpdate("cb-edit-fail", failData, failMessageId));
		failEditFor = undefined;
		check("an edit failure still marks the set chosen", storedSet(failId).chosen?.id === "ok", storedSet(failId).chosen);
		check("an edit failure still delivers the choice event", choiceEvents().length === eventsBeforeFail + 1);
		const warnings = readJsonl<{ level?: string; msg?: string; data?: { setId?: string } }>(logFile).filter(
			(record) => record.level === "warn" && String(record.msg ?? "").includes("choice message edit failed"),
		);
		check("an edit failure is logged as a warn", warnings.some((record) => record.data?.setId === failId), warnings.at(-1));

		// Long messages: the keyboard is on the last chunk, so the set must store
		// that chunk (and the edit must use it), never the whole original text.
		const longText = "word ".repeat(1_000).trim();
		const longChunks = splitMessage(longText, config.config.modules.telegram.maxMessageChars);
		check("the long fixture really produces several chunks", longChunks.length > 1, longChunks.map((chunk) => chunk.length));
		await send({ thread: "telegram:42", text: longText, choices: [option("yes", "Yes")] });
		const longData = ((lastSent()?.params.reply_markup as { inline_keyboard: Array<Array<{ callback_data: string }>> }).inline_keyboard[0]![0]!
			.callback_data);
		const longId = parseChoiceCallbackData(longData)!.setId;
		const longMessageId = lastMessageId;
		const lastChunk = longChunks.at(-1)!;
		check(
			"choices on a long message store the keyboard-carrying last chunk",
			storedSet(longId).text === lastChunk && storedSet(longId).text !== longText,
			{ stored: storedSet(longId).text.length, lastChunk: lastChunk.length, whole: longText.length },
		);
		const eventsBeforeLong = choiceEvents().length;
		const editsBeforeLong = edits().length;
		await dispatch(callbackUpdate("cb-long", longData, longMessageId));
		const longEdit = edits().slice(editsBeforeLong).at(-1) as { text?: string } | undefined;
		check(
			"a press edits the last chunk plus the check line, not the whole message",
			longEdit?.text === `${lastChunk}\n\n✅ Yes`,
			{ editLength: longEdit?.text?.length, expectedLength: lastChunk.length + 6 },
		);
		check("the long-message press still emits one event", choiceEvents().length === eventsBeforeLong + 1);

		// Markdown/HTML: the edit must keep the parse mode, and a rejected markup
		// must get one plain-text retry without losing the event.
		await send({ thread: "telegram:42", text: "**Pick** one", format: "markdown", choices: [option("yes", "Yes")] });
		const markdownData = ((lastSent()?.params.reply_markup as { inline_keyboard: Array<Array<{ callback_data: string }>> }).inline_keyboard[0]![0]!
			.callback_data);
		const markdownId = parseChoiceCallbackData(markdownData)!.setId;
		const markdownMessageId = lastMessageId;
		check(
			"a markdown choice set stores the rendered chunk and its parse mode",
			storedSet(markdownId).text === "<b>Pick</b> one" && storedSet(markdownId).parseMode === "HTML",
			{ text: storedSet(markdownId).text, parseMode: storedSet(markdownId).parseMode },
		);
		const editsBeforeMarkdown = edits().length;
		await dispatch(callbackUpdate("cb-markdown", markdownData, markdownMessageId));
		const markdownEdit = edits().slice(editsBeforeMarkdown).at(-1) as { text?: string; parse_mode?: string } | undefined;
		check(
			"a markdown press edits with the same parse mode",
			markdownEdit?.parse_mode === "HTML" && markdownEdit?.text === "<b>Pick</b> one\n\n✅ Yes",
			markdownEdit,
		);

		await send({ thread: "telegram:42", text: "<b>Pick</b> two", format: "html", choices: [option("yes", "Yes")] });
		const htmlData = ((lastSent()?.params.reply_markup as { inline_keyboard: Array<Array<{ callback_data: string }>> }).inline_keyboard[0]![0]!
			.callback_data);
		const htmlId = parseChoiceCallbackData(htmlData)!.setId;
		const htmlMessageId = lastMessageId;
		failEditParseModeFor = htmlMessageId;
		const editsBeforeHtml = edits().length;
		const eventsBeforeHtml = choiceEvents().length;
		await dispatch(callbackUpdate("cb-html-fallback", htmlData, htmlMessageId));
		failEditParseModeFor = undefined;
		const htmlEdits = edits().slice(editsBeforeHtml) as Array<{ text?: string; parse_mode?: string }>;
		check(
			"a rejected choice markup is retried exactly once as plain text",
			htmlEdits.length === 2 &&
				htmlEdits[0]?.parse_mode === "HTML" &&
				htmlEdits[0]?.text === "<b>Pick</b> two\n\n✅ Yes" &&
				htmlEdits[1]?.parse_mode === undefined &&
				htmlEdits[1]?.text === htmlToPlainText("<b>Pick</b> two\n\n✅ Yes"),
			htmlEdits,
		);
		check(
			"the plain-text fallback still marks the choice and delivers the event",
			storedSet(htmlId).chosen?.id === "yes" && choiceEvents().length === eventsBeforeHtml + 1,
			{ chosen: storedSet(htmlId).chosen, events: choiceEvents().length - eventsBeforeHtml },
		);

		// Plain buttons keep the old callback path and old event text.
		await send({ thread: "telegram:42", text: "Old style", buttons: [[{ text: "Legacy", data: "legacy:action" }]] });
		const legacyCall = lastSent();
		const legacyData = (legacyCall?.params.reply_markup as { inline_keyboard: Array<Array<{ callback_data: string }>> }).inline_keyboard[0]![0]!
			.callback_data;
		check("plain buttons still send their raw callback data", legacyData === "legacy:action", legacyData);
		const legacyAnswersBefore = answers().length;
		const legacyEventsBefore = choiceEvents().length;
		const legacyAllBefore = store.all().filter((item) => item.kind === "user_message").length;
		await dispatch(callbackUpdate("cb-legacy", legacyData, lastMessageId));
		check(
			"a plain button answers the callback without text",
			answers().length === legacyAnswersBefore + 1 && answers().at(-1)?.text === undefined,
			answers().at(-1),
		);
		const legacyEvent = store
			.all()
			.filter((item) => item.kind === "user_message")
			.slice(legacyAllBefore)
			.find((item) => item.text.startsWith("[button pressed]"));
		check(
			"a plain button still arrives as [button pressed] <data>",
			legacyEvent?.text.startsWith("[button pressed] legacy:action") === true,
			legacyEvent?.text,
		);
		check("a plain button is not a choice event", choiceEvents().length === legacyEventsBefore);

		// Reply keyboard: labels map back to ids, one remove_keyboard message, a normal repeat.
		await send({ thread: "telegram:42", text: "Choose a day", keyboard: { rows: [["Yes", "No"]] } });
		const replyCall = lastSent();
		const replyMarkup = replyCall?.params.reply_markup as
			| { keyboard?: Array<Array<{ text: string }>>; resize_keyboard?: boolean }
			| undefined;
		check(
			"a reply keyboard is sent under the composer with resize_keyboard",
			replyMarkup?.resize_keyboard === true &&
				replyMarkup.keyboard?.[0]?.length === 2 &&
				replyMarkup.keyboard?.[0]?.[1]?.text === "No",
			replyMarkup,
		);
		const replySets = new ChoiceStore(config.paths.stateDir).list().filter((entry) => entry.source === "reply_keyboard");
		const replySet = replySets.at(-1)!;
		check(
			"the reply set stores labels mapped to generated option ids",
			replySet.options.length === 2 &&
				replySet.options[0]?.label === "Yes" &&
				replySet.options[1]?.label === "No" &&
				TELEGRAM_CHOICE_ID_PATTERN.test(replySet.options[0]!.id),
			replySet.options,
		);
		const replyKeyboardMessageId = lastMessageId;

		const sendsBeforePress = sentCalls().length;
		const eventsBeforeReply = choiceEvents().length;
		const allBeforeReply = store.all().filter((item) => item.kind === "user_message").length;
		const pressMessageId = nextUserMessageId;
		await dispatch(textUpdate("Yes"));
		const replyEvents = store
			.all()
			.filter((item) => item.kind === "user_message")
			.slice(allBeforeReply)
			.filter((item) => item.text.startsWith("[choice] "));
		check("an exact reply label emits one choice event", choiceEvents().length === eventsBeforeReply + 1 && replyEvents.length === 1, replyEvents.length);
		const replyJson = JSON.parse(replyEvents[0]!.text.split("\n")[0]!.slice("[choice] ".length)) as Record<string, unknown>;
		check(
			"the reply choice carries source reply_keyboard and the generated option id",
			replyJson.source === "reply_keyboard" &&
				replyJson.option_id === replySet.options[0]!.id &&
				replyJson.label === "Yes" &&
				replyJson.message_id === pressMessageId &&
				replyJson.thread === "telegram:42",
			replyJson,
		);
		check("the reply press marks the set chosen", storedSet(replySet.setId).chosen?.label === "Yes", storedSet(replySet.setId).chosen);
		const removal = sentCalls()
			.slice(sendsBeforePress)
			.find((call) => (call.params.reply_markup as { remove_keyboard?: boolean } | undefined)?.remove_keyboard === true);
		check(
			"the reply press sends one remove_keyboard message and it is not an event",
			removal !== undefined &&
				sentCalls().filter((call) => (call.params.reply_markup as { remove_keyboard?: boolean } | undefined)?.remove_keyboard === true).length === 1 &&
				removal?.params.text === CHOICE_REPLY_KEYBOARD_REMOVED_TEXT &&
				choiceEvents().length === eventsBeforeReply + 1,
			removal?.params,
		);
		check(
			"the reply keyboard belongs to the bot message, not the press",
			storedSet(replySet.setId).messageId === replyKeyboardMessageId,
			storedSet(replySet.setId).messageId,
		);

		const allBeforeRepeat = store.all().filter((item) => item.kind === "user_message").length;
		const eventsBeforeRepeat = choiceEvents().length;
		await dispatch(textUpdate("Yes"));
		const repeatEvents = store
			.all()
			.filter((item) => item.kind === "user_message")
			.slice(allBeforeRepeat);
		check(
			"a repeated reply label arrives as an ordinary message, not a choice",
			choiceEvents().length === eventsBeforeRepeat &&
				repeatEvents.length === 1 &&
				repeatEvents[0]?.text === "Yes",
			repeatEvents.map((item) => item.text),
		);
		check(
			"a message that only partially matches a label is ordinary",
			(await (async () => {
				const before = choiceEvents().length;
				await dispatch(textUpdate("Yes please"));
				return choiceEvents().length === before;
			})()),
		);

		// Repeat after a real process restart: the chosen state comes from disk.
		const repeatSetId = setId;
		await host?.stop();
		host = undefined;
		await boot();
		calls.length = 0;
		const eventsBeforeRestart = choiceEvents().length;
		await dispatch(callbackUpdate("cb-after-restart", firstData, choiceMessageId));
		check(
			"after a restart a repeat press still answers already chosen",
			answers().some((params) => params.callback_query_id === "cb-after-restart" && params.text === CHOICE_ALREADY_ANSWER),
			answers().at(-1),
		);
		check(
			"after a restart a repeat press does not edit or emit an event",
			edits().length === 0 && choiceEvents().length === eventsBeforeRestart && storedSet(repeatSetId).chosen?.id === "yes",
			{ edits: edits().length, events: choiceEvents().length },
		);
	} finally {
		await host?.stop().catch(() => undefined);
		globalThis.fetch = realFetch;
	}
}

// ---------------------------------------------------------------------------
section("module: reply keyboard presses in groups with requireMentionInGroups (#279)");
{
	const moduleRoot = fs.mkdtempSync(path.join(os.tmpdir(), "alive-telegram-group-choices-test-"));
	fs.writeFileSync(path.join(moduleRoot, "SOUL.md"), "group choices test soul\n");
	fs.writeFileSync(path.join(moduleRoot, "CONTRACT.md"), "group choices test contract\n");
	const logFile = path.join(moduleRoot, "test-log.jsonl");
	const log = new Logger({ console: false, level: "warn", file: logFile, scope: "telegram-group-choices-test" });
	const store = EventStore.open(moduleRoot);
	const history = HistoryStore.open(moduleRoot);
	const outbox = new Outbox(moduleRoot);
	const calls: Array<{ method: string; params: Record<string, unknown> }> = [];
	let nextMessageId = 700;

	const jsonResponse = (body: unknown, status = 200): Response =>
		new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
	const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
		const url = String(input);
		const method = url.slice(url.lastIndexOf("/") + 1);
		const params = init?.body && !(init.body instanceof FormData) ? (JSON.parse(String(init.body)) as Record<string, unknown>) : {};
		calls.push({ method, params });
		if (method === "getMe") return jsonResponse({ ok: true, result: { id: 999, is_bot: true, first_name: "Alive", username: "alive_bot" } });
		if (method === "deleteWebhook") return jsonResponse({ ok: true, result: true });
		if (method === "getUpdates") {
			return new Promise<Response>((resolve) => {
				const timer = setTimeout(() => resolve(jsonResponse({ ok: true, result: [] })), 10);
				init?.signal?.addEventListener(
					"abort",
					() => {
						clearTimeout(timer);
						resolve(jsonResponse({ ok: true, result: [] }));
					},
					{ once: true },
				);
			});
		}
		if (method === "sendMessage") {
			nextMessageId += 1;
			return jsonResponse({
				ok: true,
				result: { message_id: nextMessageId, date: 1, chat: { id: Number(params.chat_id), type: "supergroup" } },
			});
		}
		return jsonResponse({ ok: true, result: true });
	}) as unknown as typeof fetch;

	const config = loadConfig({
		cwd: moduleRoot,
		overrides: {
			chat: { console: false, http: { enabled: false, host: "127.0.0.1", port: 0, token: "" } },
			modules: {
				telegram: {
					...DEFAULT_CONFIG.modules.telegram,
					enabled: true,
					token: "choices-group-test-token",
					tokenEnv: "ALIVE_CHOICES_GROUP_TEST_TOKEN_UNSET",
					apiBase: "https://telegram.invalid",
					allowedChatIds: ["-1001"],
					allowedUserIds: ["7"],
					pollTimeoutSec: 0,
					parseMode: "",
					requireMentionInGroups: true,
				},
				grafana: { ...DEFAULT_CONFIG.modules.grafana, enabled: false },
				external: [],
			},
		},
	});
	const stateDir = config.paths.stateDir;
	const choiceStore = new ChoiceStore(stateDir);
	const groupChat: TelegramChat = { id: -1001, type: "supergroup", title: "Alive team" };

	const realFetch = globalThis.fetch;
	globalThis.fetch = fetchImpl;
	let host: ModuleHost | undefined;
	let telegram: TelegramModule | undefined;
	const boot = async (requireMentionInGroups: boolean): Promise<void> => {
		telegram = new TelegramModule({ ...config.config.modules.telegram, requireMentionInGroups });
		host = new ModuleHost({
			config,
			log,
			transports: [],
			modules: [telegram],
			ingest: (event) => store.append(event),
			outbox: (limit) => outbox.list(limit),
			history,
			runtimeStatus: () => ({}),
		});
		await host.init();
		await new Promise((resolve) => setTimeout(resolve, 30));
	};
	const dispatch = (update: TelegramUpdate) =>
		(telegram as unknown as { handleUpdate(update: TelegramUpdate): Promise<void> }).handleUpdate(update);

	let nextUpdateId = 1;
	let nextGroupMessageId = 900;
	const groupUpdate = (text: string, topicId?: number): TelegramUpdate => ({
		update_id: nextUpdateId++,
		message: {
			message_id: nextGroupMessageId++,
			date: 1,
			chat: groupChat,
			from: { id: 7, is_bot: false, first_name: "Alice", username: "alice" },
			text,
			...(topicId !== undefined ? { message_thread_id: topicId } : {}),
		},
	});
	const userEvents = () => store.all().filter((item) => item.kind === "user_message");
	const choiceEvents = () => userEvents().filter((item) => item.text.startsWith("[choice] "));
	const removals = () =>
		calls.filter(
			(call) =>
				call.method === "sendMessage" &&
				(call.params.reply_markup as { remove_keyboard?: boolean } | undefined)?.remove_keyboard === true,
		);
	const storedSet = (setId: string): ChoiceSet =>
		JSON.parse(fs.readFileSync(path.join(stateDir, "telegram-choices", `${setId}.json`), "utf8")) as ChoiceSet;
	// Mirrors the module's own `isReplyKeyboardPress`: only a live, exact label of
	// this chat and thread lets an unaddressed group message through.
	const groupOptions = () => ({
		botId: 999,
		botUsername: "alive_bot",
		ingestEdits: true,
		requireMentionInGroups: true,
		isReplyKeyboardPress: ({ chatId, thread, text }: { chatId: string; thread: string; text: string | undefined }) =>
			text !== undefined && choiceStore.findReplySet(chatId, text, thread) !== undefined,
	});
	const parsedChoice = (text: string): Record<string, unknown> =>
		JSON.parse(text.split("\n")[0]!.slice("[choice] ".length)) as Record<string, unknown>;

	try {
		await boot(true);
		calls.length = 0;

		const primary = choiceStore.create({
			chatId: "-1001",
			thread: "telegram:-1001",
			text: "Choose a day",
			options: replyKeyboardOptions({ rows: [["Yes", "No"]] }),
			source: "reply_keyboard",
		});

		// Exact label only: a prefix or a longer text with the label in front is
		// not a press, so the group filter must still drop it.
		const beforeNearMiss = userEvents().length;
		const removalsBeforeNearMiss = removals().length;
		await dispatch(groupUpdate("Y"));
		await dispatch(groupUpdate("Yes, please"));
		check(
			"near-miss labels are not keyboard presses in a group",
			userEvents().length === beforeNearMiss && removals().length === removalsBeforeNearMiss,
			{ events: userEvents().length - beforeNearMiss, removals: removals().length - removalsBeforeNearMiss },
		);
		check(
			"normalizeUpdate does not accept a prefix or a longer text as a keyboard press",
			normalizeUpdate(groupUpdate("Y"), groupOptions()) === undefined &&
				normalizeUpdate(groupUpdate("Yes, please"), groupOptions()) === undefined &&
				normalizeUpdate(groupUpdate("Yes"), groupOptions()) !== undefined,
			{
				prefix: normalizeUpdate(groupUpdate("Y"), groupOptions())?.text,
				longer: normalizeUpdate(groupUpdate("Yes, please"), groupOptions())?.text,
				exact: normalizeUpdate(groupUpdate("Yes"), groupOptions())?.text,
			},
		);

		const pressMessageId = nextGroupMessageId;
		const beforePress = userEvents().length;
		await dispatch(groupUpdate("Yes"));
		const pressEvent = choiceEvents().at(-1);
		check(
			"a reply keyboard press in a group with requireMentionInGroups is not dropped",
			userEvents().length === beforePress + 1 && choiceEvents().length === 1,
			userEvents().slice(beforePress).map((item) => item.text),
		);
		const pressJson = pressEvent ? parsedChoice(pressEvent.text) : {};
		check(
			"the group press is a [choice] event with source=reply_keyboard in this thread",
			pressEvent !== undefined &&
				pressJson.set === primary.setId &&
				pressJson.option_id === primary.options[0]!.id &&
				pressJson.label === "Yes" &&
				pressJson.message_id === pressMessageId &&
				pressJson.thread === "telegram:-1001" &&
				pressJson.source === "reply_keyboard",
			pressJson,
		);
		check(
			"the group press removes the keyboard exactly once",
			removals().length === 1 &&
				removals()[0]?.params.text === CHOICE_REPLY_KEYBOARD_REMOVED_TEXT &&
				removals()[0]?.params.chat_id === "-1001",
			removals().map((call) => call.params),
		);
		check("the group press marks the set chosen", storedSet(primary.setId).chosen?.label === "Yes", storedSet(primary.setId).chosen);

		// No live set: the same text must fall back to the ordinary filter and stay invisible.
		const afterChosen = userEvents().length;
		const removalsAfterChosen = removals().length;
		await dispatch(groupUpdate("Yes"));
		check(
			"the same label without an active set stays invisible in the group",
			userEvents().length === afterChosen && removals().length === removalsAfterChosen,
			{ events: userEvents().length - afterChosen, removals: removals().length - removalsAfterChosen },
		);
		check(
			"normalizeUpdate returns undefined for an unaddressed group text without a live set",
			normalizeUpdate(groupUpdate("Yes"), groupOptions()) === undefined,
		);

		// Expired set: a press is not recognized, so the ordinary filter drops it.
		const expired = choiceStore.create({
			chatId: "-1001",
			thread: "telegram:-1001",
			text: "Expired menu",
			options: replyKeyboardOptions({ rows: [["Sure"]] }),
			source: "reply_keyboard",
		});
		const expiredFile = choiceStore.file(expired.setId);
		const expiredRaw = JSON.parse(fs.readFileSync(expiredFile, "utf8")) as ChoiceSet;
		expiredRaw.createdAt = Date.now() - TELEGRAM_CHOICE_SET_TTL_MS - 1;
		fs.writeFileSync(expiredFile, JSON.stringify(expiredRaw));
		check(
			"a clock-shifted store does not resolve the aged reply set",
			new ChoiceStore(stateDir, () => Date.now() + TELEGRAM_CHOICE_SET_TTL_MS + 1).findReplySet("-1001", "Sure", "telegram:-1001") ===
				undefined,
		);
		const beforeExpired = userEvents().length;
		const removalsBeforeExpired = removals().length;
		await dispatch(groupUpdate("Sure"));
		check(
			"an expired reply set emits no event and no keyboard removal in a group",
			userEvents().length === beforeExpired && removals().length === removalsBeforeExpired,
			{ events: userEvents().length - beforeExpired, removals: removals().length - removalsBeforeExpired },
		);
		check("normalizeUpdate drops an expired reply set", normalizeUpdate(groupUpdate("Sure"), groupOptions()) === undefined);

		// Another thread (forum topic): its keyboard is not this thread's keyboard.
		const topicSet = choiceStore.create({
			chatId: "-1001",
			thread: "telegram:-1001/7",
			text: "Topic menu",
			options: replyKeyboardOptions({ rows: [["Yes", "No"]] }),
			source: "reply_keyboard",
		});
		const beforeWrongThread = userEvents().length;
		const removalsBeforeWrongThread = removals().length;
		await dispatch(groupUpdate("Yes"));
		check(
			"a set in another topic does not turn a main-thread press into an event",
			userEvents().length === beforeWrongThread && removals().length === removalsBeforeWrongThread,
			{ events: userEvents().length - beforeWrongThread, removals: removals().length - removalsBeforeWrongThread },
		);
		check(
			"normalizeUpdate drops a main-thread text that only matches another topic's set",
			normalizeUpdate(groupUpdate("Yes"), groupOptions()) === undefined,
		);
		const beforeTopicPress = userEvents().length;
		const choicesBeforeTopic = choiceEvents().length;
		await dispatch(groupUpdate("Yes", 7));
		const topicEvent = choiceEvents().at(-1);
		const topicJson = topicEvent ? parsedChoice(topicEvent.text) : {};
		check(
			"a press in its own topic is a reply_keyboard choice event",
			topicEvent !== undefined &&
				choiceEvents().length === choicesBeforeTopic + 1 &&
				userEvents().length === beforeTopicPress + 1 &&
				topicJson.set === topicSet.setId &&
				topicJson.thread === "telegram:-1001/7" &&
				topicJson.source === "reply_keyboard",
			topicJson,
		);
		check(
			"the topic press removes the keyboard in that topic only",
			removals().length === removalsBeforeWrongThread + 1 && removals().at(-1)?.params.message_thread_id === 7,
			removals().at(-1)?.params,
		);
		check("the topic set is chosen", storedSet(topicSet.setId).chosen?.label === "Yes", storedSet(topicSet.setId).chosen);

		// Regression: with the default `requireMentionInGroups: false` the same
		// group press works exactly as before.
		await host?.stop();
		host = undefined;
		await boot(false);
		calls.length = 0;
		const relaxed = choiceStore.create({
			chatId: "-1001",
			thread: "telegram:-1001",
			text: "Relaxed menu",
			options: replyKeyboardOptions({ rows: [["Yes", "No"]] }),
			source: "reply_keyboard",
		});
		const beforeRelaxed = userEvents().length;
		const choicesBeforeRelaxed = choiceEvents().length;
		await dispatch(groupUpdate("Yes"));
		const relaxedChoice = choiceEvents().at(-1);
		const relaxedJson = relaxedChoice ? parsedChoice(relaxedChoice.text) : {};
		check(
			"without requireMentionInGroups a group keyboard press still works as before",
			relaxedChoice !== undefined &&
				choiceEvents().length === choicesBeforeRelaxed + 1 &&
				userEvents().length === beforeRelaxed + 1 &&
				relaxedJson.set === relaxed.setId &&
				relaxedJson.source === "reply_keyboard",
			choiceEvents().map((item) => item.text),
		);
		check("the relaxed press still removes the keyboard", removals().length === 1);
		check("the relaxed set is chosen", storedSet(relaxed.setId).chosen?.label === "Yes", storedSet(relaxed.setId).chosen);

		// And plain group chatter is still an ordinary (non-choice) event there.
		const beforeChatter = userEvents().length;
		await dispatch(groupUpdate("just talking"));
		const chatter = userEvents().slice(beforeChatter);
		check(
			"ordinary group chatter without a keyboard is still a normal event",
			chatter.length === 1 && chatter[0]?.text === "just talking" && chatter[0]?.expectsReply === false,
			chatter.map((item) => ({ text: item.text, expectsReply: item.expectsReply })),
		);
		const defaults = normalizeUpdate(groupUpdate("hello"), { botId: 999, botUsername: "alive_bot", ingestEdits: true });
		check(
			"the default normalizeUpdate (no keyboard, no requireMentionInGroups) is unchanged",
			defaults?.text === "hello" && defaults.expectsReply === false && defaults.addressedToBot === false,
			defaults && { text: defaults.text, expectsReply: defaults.expectsReply, addressedToBot: defaults.addressedToBot },
		);
	} finally {
		await host?.stop().catch(() => undefined);
		globalThis.fetch = realFetch;
	}
}

process.stdout.write(failures === 0 ? "\nALL CHOICES TESTS PASSED\n" : `\n${failures} CHOICES TEST(S) FAILED\n`);
process.exitCode = failures === 0 ? 0 : 1;
