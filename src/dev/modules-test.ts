/**
 * Tests for the Events API: the shared history store, module hosting/routing,
 * the Telegram update → event mapping, the Telegram module end-to-end against a
 * fake Bot API, and the client's error handling.
 *
 *   npm run test:modules
 *
 * No model and no network: these are the parts where a bug silently loses a
 * message or routes it to the wrong place.
 */
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import { loadConfig } from "../config.js";
import { ModuleHost } from "../events/host.js";
import { describeModules, loadModules } from "../events/loader.js";
import type { AliveModule, ModuleContext } from "../events/api.js";
import { Logger } from "../log.js";
import { EventStore } from "../store/events.js";
import { HistoryStore } from "../store/history.js";
import { Outbox, type OutgoingMessage } from "../store/outbox.js";
import type { ChatTransport } from "../transports/types.js";
import { GrafanaModule } from "../modules/grafana/module.js";
import { TelegramApi, TelegramApiError } from "../modules/telegram/client.js";
import { resolveToken, TelegramModule } from "../modules/telegram/module.js";
import { escapeHtml, isParseModeError, splitMessage } from "../modules/telegram/text.js";
import { formatThread, parseThread, resolveChatTarget } from "../modules/telegram/threads.js";
import { normalizeUpdate } from "../modules/telegram/update.js";
import type { TelegramUpdate } from "../modules/telegram/types.js";

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

function jsonResponse(value: unknown, status = 200): Response {
	return new Response(JSON.stringify(value), { status, headers: { "content-type": "application/json" } });
}

const root = fs.mkdtempSync(path.join(os.tmpdir(), "alive-modules-test-"));
const stateDir = path.join(root, ".alive");

// ---------------------------------------------------------------------------
section("history store: append, dedupe, query, search, threads, prune");
{
	const history = HistoryStore.open(stateDir);
	const base = { thread: "telegram:1", module: "telegram" } as const;
	const first = history.append({ id: "telegram:1:10", ...base, direction: "inbound", ts: 1_000, author: "Alice", authorId: "u1", text: "hello world", messageId: "10" });
	const dup = history.append({ id: "telegram:1:10", ...base, direction: "inbound", ts: 9_999, text: "SHOULD NOT WIN", messageId: "10" });
	history.append({ id: "telegram:1:11", ...base, direction: "outbound", ts: 2_000, text: "hi Alice", messageId: "11", replyTo: "10" });
	history.append({ id: "telegram:1:12", ...base, direction: "inbound", ts: 3_000, author: "Bob", authorId: "u2", text: "status?", messageId: "12" });
	history.append({ id: "console:0", thread: "console", module: "console", direction: "inbound", ts: 4_000, text: "from console" });

	check("append returns the stored record", first.messageId === "10");
	check("same id is not duplicated and does not overwrite", dup.ts === 1_000 && history.stats().messages === 4, history.stats());
	check("query by thread is chronological", history.query({ thread: "telegram:1" }).map((r) => r.messageId).join(",") === "10,11,12");
	check("desc order reverses", history.query({ thread: "telegram:1", order: "desc" }).map((r) => r.messageId).join(",") === "12,11,10");
	check("direction filter works", history.query({ thread: "telegram:1", direction: "outbound" }).length === 1);
	check("search is case-insensitive", history.query({ search: "ALICE" }).length === 2, history.query({ search: "ALICE" }).map((r) => r.id));
	check("search can be scoped to a module", history.query({ search: "console", module: "console" }).length === 1);
	check("time bounds work", history.query({ since: 2_000, until: 2_500 }).map((r) => r.messageId).join(",") === "11");
	check("before anchor excludes the anchor", history.query({ thread: "telegram:1", before: "12" }).map((r) => r.messageId).join(",") === "10,11");
	check("after anchor excludes the anchor", history.query({ thread: "telegram:1", after: "10", order: "asc" }).map((r) => r.messageId).join(",") === "11,12");
	check("limit is applied", history.query({ thread: "telegram:1", limit: 2 }).length === 2);
	check("findByMessageId finds the record", history.findByMessageId("telegram:1", "11")?.direction === "outbound");

	history.upsertThread({ thread: "telegram:1", module: "telegram", title: "Team", participants: ["Alice"] });
	history.upsertThread({ thread: "telegram:1", module: "telegram", title: "Team", participants: ["Bob"] });
	const thread = history.thread("telegram:1");
	check("thread mirrors the records", thread?.messageCount === 3 && thread?.inboundCount === 2 && thread?.outboundCount === 1, thread);
	check("thread participants merge", thread?.participants.sort().join(",") === "Alice,Bob", thread?.participants);
	check("threads lists activity newest first", history.threads()[0]?.thread === "console", history.threads().map((t) => t.thread));
	check("threads can be filtered by module", history.threads({ module: "telegram" }).length === 1);

	const dropped = history.prune("telegram:1", 2);
	check("prune keeps the newest messages", dropped === 1 && history.query({ thread: "telegram:1" }).map((r) => r.messageId).join(",") === "11,12", {
		dropped,
		left: history.query({ thread: "telegram:1" }).map((r) => r.messageId),
	});
}

// ---------------------------------------------------------------------------
section("history store: a second process picks up appends");
{
	const file = path.join(stateDir, "history", "messages.jsonl");
	const before = HistoryStore.open(stateDir).stats().messages;
	fs.appendFileSync(file, `${JSON.stringify({ id: "external:1", thread: "external", module: "external", direction: "inbound", ts: Date.now(), text: "from elsewhere" })}\n`);
	const reopened = HistoryStore.open(stateDir);
	check("external append is visible", reopened.stats().messages === before + 1, reopened.stats());
	check("unknown thread is discoverable", reopened.thread("external")?.messageCount === 1);
}

// ---------------------------------------------------------------------------
section("module host: claimers, listeners, taps and delivery failures");
{
	const log = new Logger({ console: false, level: "error", scope: "host-test" });
	const store = EventStore.open(stateDir);
	const history = HistoryStore.open(stateDir);
	const calls: string[] = [];
	const tap: ChatTransport = {
		name: "tap",
		async start() {},
		async send(message) {
			calls.push(`tap:${message.thread}`);
		},
		async stop() {},
	};
	const claimer: AliveModule = {
		name: "claimer",
		handles: (message) => message.thread.startsWith("claim:"),
		async start(ctx) {
			ctx.onOutbound(async (message) => {
				calls.push(`claimer:${message.thread}`);
			});
		},
		async stop() {},
	};
	const listener: AliveModule = {
		name: "listener",
		async start(ctx) {
			ctx.onOutbound((message) => {
				calls.push(`listener:${message.thread}`);
			});
		},
		async stop() {},
	};
	const failing: AliveModule = {
		name: "failing",
		handles: (message) => message.thread.startsWith("fail:"),
		async start(ctx) {
			ctx.onOutbound(() => {
				throw new Error("boom");
			});
		},
		async stop() {},
	};
	const toolModule: AliveModule = {
		name: "tools",
		async start() {},
		async stop() {},
		tools(): ToolDefinition[] {
			return [
				{
					name: "from_module",
					label: "x",
					description: "x",
					parameters: { type: "object", properties: {} },
					execute: async () => ({ content: [], details: {} }),
				} as unknown as ToolDefinition,
			];
		},
	};

	const host = new ModuleHost({
		config: loadConfig({ cwd: root }),
		log,
		transports: [tap],
		modules: [claimer, listener, failing, toolModule],
		ingest: (event) => store.append(event),
		outbox: () => [],
		history,
		runtimeStatus: () => ({ ok: true }),
	});
	await host.init();

	const message = (thread: string): OutgoingMessage => ({ id: `msg_${thread}`, runId: "run", thread, text: "hi", ts: Date.now() });

	await host.deliver(message("claim:1"));
	check("claimer receives claimed messages", calls.includes("claimer:claim:1"), calls);
	check("listener receives every message", calls.includes("listener:claim:1"));
	check("transport taps see every message", calls.includes("tap:claim:1"));

	calls.length = 0;
	await host.deliver(message("other:1"));
	check("unclaimed messages skip the claimer", !calls.some((c) => c.startsWith("claimer:")), calls);
	check("unclaimed messages still reach the listener", calls.includes("listener:other:1"));

	let failed = false;
	try {
		await host.deliver(message("fail:1"));
	} catch {
		failed = true;
	}
	check("a failing claimer fails the send", failed);
	check("taps still saw the failed message", calls.includes("tap:fail:1"));
	check("listener still saw the failed message", calls.includes("listener:fail:1"));

	check("module tools are collected", host.contributedTools().map((t) => t.name).join(",") === "from_module");
	check("module names are reported", host.moduleNames.join(",") === "claimer,listener,failing,tools");
	check("transport names are reported", host.transportNames.join(",") === "tap");
	const status = host.status() as { modules: Record<string, unknown> };
	check("status lists modules", Object.keys(status.modules).length === 4, status);

	await host.stop();
}

// ---------------------------------------------------------------------------
section("telegram threads");
{
	check("format includes the prefix", formatThread(42) === "telegram:42");
	check("format includes the topic", formatThread(-1001, 7) === "telegram:-1001/7");
	check("parse plain chat", parseThread("telegram:-100123")?.chatId === "-100123");
	check("parse topic", parseThread("telegram:-100123/7")?.topicId === "7");
	check("non-telegram thread is rejected", parseThread("console") === undefined);
	check("targets accept a thread", resolveChatTarget("telegram:42") === "42");
	check("targets accept a bare id", resolveChatTarget("-100123") === "-100123");
	check("targets accept a username", resolveChatTarget("@alive_bot") === "@alive_bot");
}

// ---------------------------------------------------------------------------
section("telegram text handling");
{
	const long = `${"a".repeat(3000)}\n\n${"b".repeat(3000)}`;
	const parts = splitMessage(long, 4096);
	check("long text is split", parts.length === 2, parts.map((p) => p.length));
	check("no part exceeds the limit", parts.every((p) => p.length <= 4096), parts.map((p) => p.length));
	check("no characters are lost", parts.join("").replace(/\s/g, "") === long.replace(/\s/g, ""));
	const prose = "Sentence number one is here. ".repeat(300);
	const proseParts = splitMessage(prose, 4096);
	check("prose without newlines is split", proseParts.length > 1, proseParts.length);
	check("prose loses no characters", proseParts.join("").replace(/\s/g, "") === prose.replace(/\s/g, ""), proseParts.map((p) => p.length));
	check("prose parts stay within the limit", proseParts.every((p) => p.length <= 4096), proseParts.map((p) => p.length));
	check("prose breaks on sentence ends", proseParts.slice(0, -1).every((p) => p.trimEnd().endsWith(".")), proseParts.map((p) => p.slice(-12)));
	check("short text stays one message", splitMessage("hello", 4096).length === 1);
	check("html is escaped", escapeHtml("<b>a & b</b>") === "&lt;b&gt;a &amp; b&lt;/b&gt;");
	check("parse errors are detected", isParseModeError(new Error("Bad Request: can't parse entities: Unexpected end tag")));
	check("other errors are not parse errors", !isParseModeError(new Error("chat not found")));
}

// ---------------------------------------------------------------------------
section("telegram update → event mapping");
const bot = { botId: 999, botUsername: "alive_bot", ingestEdits: true };
{
	const privateMessage: TelegramUpdate = {
		update_id: 1,
		message: {
			message_id: 10,
			date: 1_700_000_000,
			chat: { id: 42, type: "private", first_name: "Alice", username: "alice" },
			from: { id: 7, is_bot: false, first_name: "Alice", username: "alice" },
			text: "привет",
		},
	};
	const inbound = normalizeUpdate(privateMessage, bot);
	check("private message maps to a thread", inbound?.thread === "telegram:42", inbound?.thread);
	check("private message expects a reply", inbound?.expectsReply === true);
	check("author is captured", inbound?.author?.id === "7" && inbound?.author?.name === "Alice", inbound?.author);
	check("history id is stable", inbound?.historyId === "telegram:42:10" && inbound?.dedupeKey === "telegram:msg:42:10");

	const botMessage: TelegramUpdate = {
		update_id: 2,
		message: {
			message_id: 11,
			date: 1_700_000_000,
			chat: { id: 42, type: "private", first_name: "Alice" },
			from: { id: 999, is_bot: true, first_name: "Alive" },
			text: "my own message",
		},
	};
	check("bot messages are ignored", normalizeUpdate(botMessage, bot) === undefined);

	const groupChat = { id: -1001, type: "supergroup" as const, title: "Team" };
	const chatter: TelegramUpdate = {
		update_id: 3,
		message: { message_id: 12, date: 1_700_000_000, chat: groupChat, from: { id: 8, is_bot: false, first_name: "Bob" }, text: "just chatting" },
	};
	check("group chatter without a mention does not expect a reply", normalizeUpdate(chatter, bot)?.expectsReply === false);

	const mention: TelegramUpdate = {
		update_id: 4,
		message: {
			message_id: 13,
			date: 1_700_000_000,
			chat: groupChat,
			from: { id: 8, is_bot: false, first_name: "Bob" },
			text: "@alive_bot status?",
			entities: [{ type: "mention", offset: 0, length: 10 }],
		},
	};
	check("a mention expects a reply", normalizeUpdate(mention, bot)?.expectsReply === true);

	const replyToBot: TelegramUpdate = {
		update_id: 5,
		message: {
			message_id: 14,
			date: 1_700_000_000,
			chat: groupChat,
			from: { id: 8, is_bot: false, first_name: "Bob" },
			text: "and this?",
			reply_to_message: { message_id: 13, date: 1_700_000_000, chat: groupChat, from: { id: 999, is_bot: true, first_name: "Alive" }, text: "earlier" },
		},
	};
	const replied = normalizeUpdate(replyToBot, bot);
	check("a reply to the bot expects a reply", replied?.expectsReply === true);
	check("the quoted message is included", replied?.promptText.includes("earlier") === true, replied?.promptText);

	const command: TelegramUpdate = {
		update_id: 6,
		message: { message_id: 15, date: 1_700_000_000, chat: groupChat, from: { id: 8, is_bot: false, first_name: "Bob" }, text: "/start", entities: [{ type: "bot_command", offset: 0, length: 6 }] },
	};
	check("commands expect a reply", normalizeUpdate(command, bot)?.expectsReply === true);

	const media: TelegramUpdate = {
		update_id: 7,
		message: {
			message_id: 16,
			date: 1_700_000_000,
			chat: privateMessage.message!.chat,
			from: { id: 7, is_bot: false, first_name: "Alice" },
			caption: "look",
			photo: [
				{ file_id: "small", file_unique_id: "s", width: 90, height: 90, file_size: 1000 },
				{ file_id: "big", file_unique_id: "b", width: 1280, height: 720, file_size: 200_000 },
			],
		},
	};
	const mediaInbound = normalizeUpdate(media, bot);
	check("photo keeps the largest size", mediaInbound?.attachments[0]?.fileId === "big", mediaInbound?.attachments);
	check("caption becomes the text", mediaInbound?.text === "look");
	check("attachment summary reaches the prompt", mediaInbound?.promptText.includes("photo") === true, mediaInbound?.promptText);

	const topic: TelegramUpdate = {
		update_id: 8,
		message: { message_id: 17, date: 1_700_000_000, message_thread_id: 7, chat: groupChat, from: { id: 8, is_bot: false, first_name: "Bob" }, text: "in a topic" },
	};
	check("forum topics become their own thread", normalizeUpdate(topic, bot)?.thread === "telegram:-1001/7");

	const edit: TelegramUpdate = {
		update_id: 9,
		edited_message: { message_id: 10, date: 1_700_000_000, edit_date: 1_700_000_100, chat: privateMessage.message!.chat, from: { id: 7, is_bot: false, first_name: "Alice" }, text: "привет!" },
	};
	const edited = normalizeUpdate(edit, bot);
	check("edits are marked", edited?.isEdit === true);
	check("edits have their own history id", edited?.historyId === "telegram:42:10:edit:1700000100", edited?.historyId);
	check("edits can be turned off", normalizeUpdate(edit, { ...bot, ingestEdits: false }) === undefined);

	const callback: TelegramUpdate = {
		update_id: 10,
		callback_query: { id: "cb1", from: { id: 7, is_bot: false, first_name: "Alice" }, chat_instance: "x", data: "yes", message: { message_id: 18, date: 1, chat: privateMessage.message!.chat, text: "confirm?" } },
	};
	const cb = normalizeUpdate(callback, bot);
	check("callback queries become messages", cb?.expectsReply === true && cb?.text.includes("yes") === true, cb?.text);
	check("callback dedupe uses the callback id", cb?.dedupeKey === "telegram:cb:cb1");
}

// ---------------------------------------------------------------------------
section("telegram client");
{
	const calls: Array<{ method: string; params: Record<string, unknown> }> = [];
	const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
		const url = String(input);
		const method = url.slice(url.lastIndexOf("/") + 1);
		const params = init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : {};
		calls.push({ method, params });
		if (method === "getUpdates") return jsonResponse({ ok: true, result: [{ update_id: 5 }] });
		if (method === "sendMessage") return jsonResponse({ ok: true, result: { message_id: 77, date: 1, chat: { id: 1, type: "private" } } });
		if (method === "bad") {
			return jsonResponse({ ok: false, error_code: 429, description: "Too Many Requests", parameters: { retry_after: 3 } });
		}
		return jsonResponse({ ok: true, result: true });
	}) as unknown as typeof fetch;

	const api = new TelegramApi({ token: "tok", fetchImpl });
	const updates = await api.getUpdates({ offset: 1, timeout: 0 });
	check("getUpdates unwraps the envelope", updates.length === 1 && updates[0]?.update_id === 5, updates);
	const sent = await api.sendMessage({ chat_id: 1, text: "hi" });
	check("sendMessage returns the result", sent.message_id === 77, sent);
	let apiError: TelegramApiError | undefined;
	try {
		await api.call("bad");
	} catch (err) {
		apiError = err as TelegramApiError;
	}
	check("api errors keep the code", apiError?.errorCode === 429, apiError?.message);
	check("retry_after is exposed", apiError?.retryAfterSec === 3, apiError?.retryAfterSec);
}

// ---------------------------------------------------------------------------
section("telegram module end-to-end against a fake Bot API");
{
	const moduleRoot = fs.mkdtempSync(path.join(os.tmpdir(), "alive-telegram-test-"));
	const log = new Logger({ console: false, level: "error", scope: "telegram-test" });
	const store = EventStore.open(moduleRoot);
	const history = HistoryStore.open(moduleRoot);
	const outbox = new Outbox(moduleRoot);
	const calls: Array<{ method: string; params: Record<string, unknown> }> = [];
	let getUpdatesCalls = 0;

	const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
		const url = String(input);
		const method = url.slice(url.lastIndexOf("/") + 1);
		const params =
			init?.body instanceof FormData
				? ({ __multipart: [...init.body.keys()] } as Record<string, unknown>)
				: init?.body
					? (JSON.parse(String(init.body)) as Record<string, unknown>)
					: {};
		calls.push({ method, params });
		if (method === "getMe") {
			return jsonResponse({ ok: true, result: { id: 999, is_bot: true, first_name: "Alive", username: "alive_bot" } });
		}
		if (method === "deleteWebhook") return jsonResponse({ ok: true, result: true });
		if (method === "getUpdates") {
			getUpdatesCalls += 1;
			if (getUpdatesCalls > 1) await new Promise((resolve) => setTimeout(resolve, 10));
			if (getUpdatesCalls === 1) {
				return jsonResponse({
					ok: true,
					result: [
						{
							update_id: 100,
							message: {
								message_id: 5,
								date: 1_700_000_000,
								chat: { id: 42, type: "private", first_name: "Alice", username: "alice" },
								from: { id: 7, is_bot: false, first_name: "Alice", username: "alice" },
								text: "are you there?",
							},
						},
					],
				});
			}
			return jsonResponse({ ok: true, result: [] });
		}
		if (method === "sendMessage") {
			return jsonResponse({ ok: true, result: { message_id: 500 + calls.filter((c) => c.method === "sendMessage").length, date: 1, chat: { id: 42, type: "private" } } });
		}
		if (method === "sendChatAction") return jsonResponse({ ok: true, result: true });
		if (method === "sendDocument" || method === "sendPhoto") {
			return jsonResponse({ ok: true, result: { message_id: 700, date: 1, chat: { id: 42, type: "private" } } });
		}
		return jsonResponse({ ok: true, result: true });
	}) as unknown as typeof fetch;

	const config = loadConfig({
		cwd: moduleRoot,
		overrides: {
			chat: { console: false, http: { enabled: false, host: "127.0.0.1", port: 0, token: "" } },
			modules: {
				telegram: {
					enabled: true,
					token: "test-token",
					tokenEnv: "ALIVE_TEST_TELEGRAM_TOKEN_UNSET",
					apiBase: "https://api.telegram.org",
					allowedChatIds: [],
					allowedUserIds: [],
					pollTimeoutSec: 0,
					allowedUpdates: ["message"],
					parseMode: "",
					linkPreview: true,
					typingIndicator: true,
					ackReaction: "",
					ingestEdits: true,
					historyLimitPerThread: 0,
					maxMessageChars: 4096,
				},
				grafana: { enabled: false, host: "127.0.0.1", port: 0, path: "/grafana", token: "", firingPriority: "high", resolvedPriority: "low" },
				external: [],
			},
		},
	});

	// Inject the fake fetch before start(): the module builds its client there.
	const telegram = new TelegramModule(config.config.modules.telegram);
	const realFetch = globalThis.fetch;
	globalThis.fetch = fetchImpl;
	try {
		const host = new ModuleHost({
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
		await new Promise((resolve) => setTimeout(resolve, 60));

		const pending = store.peekPending(10);
		check("an update became a durable event", pending.length === 1, pending.map((e) => e.title));
		check("the event is a user message on the right thread", pending[0]?.kind === "user_message" && pending[0]?.thread === "telegram:42", pending[0]);
		check("the event expects a reply", pending[0]?.expectsReply === true);
		check("the event carries structured payload", (pending[0]?.payload as { messageId?: string })?.messageId === "5", pending[0]?.payload);

		const records = history.query({ thread: "telegram:42" });
		check("inbound message landed in history", records.length === 1 && records[0]?.direction === "inbound", records);
		check("history links back to the event", records[0]?.meta?.eventId === pending[0]?.id, records[0]?.meta);
		check("the chat directory knows the chat", history.thread("telegram:42")?.title === "Alice (@alice)", history.thread("telegram:42"));

		const tools = host.contributedTools();
		const telegramTool = tools.find((tool) => tool.name === "telegram");
		check("the telegram tool is contributed", telegramTool !== undefined);
		const historyResult = (await telegramTool!.execute(
			"call",
			{ action: "history", chat: "telegram:42" } as never,
			undefined,
			undefined,
			{} as never,
		)) as { content: Array<{ text: string }>; details: Record<string, unknown> };
		check("the tool reads chat history", historyResult.content[0]!.text.includes("are you there?"), historyResult.content[0]!.text);

		// Outbound: the module must claim telegram threads and deliver them.
		const delivery = await host.deliver({ id: "msg_1", runId: "run", thread: "telegram:42", text: "Yes, I am here.", ts: Date.now() });
		void delivery;
		const sendCall = calls.filter((call) => call.method === "sendMessage").pop();
		check("outbound reached the Bot API", sendCall?.params.text === "Yes, I am here.", sendCall?.params);
		check("outbound was recorded in history", history.query({ thread: "telegram:42", direction: "outbound" }).length === 1);

		// send_file: guard the workspace, then upload as a document.
		const workspace = config.paths.workspaceDir;
		fs.mkdirSync(workspace, { recursive: true });
		fs.writeFileSync(path.join(workspace, "report.txt"), "hello from the agent");
		let escaped = false;
		try {
			await telegramTool!.execute(
				"call",
				{ action: "send_file", chat: "telegram:42", path: "../../../../etc/passwd" } as never,
				undefined,
				undefined,
				{} as never,
			);
		} catch {
			escaped = true;
		}
		check("send_file refuses paths outside the workspace", escaped);
		await telegramTool!.execute(
			"call",
			{ action: "send_file", chat: "telegram:42", path: "report.txt", caption: "отчёт" } as never,
			undefined,
			undefined,
			{} as never,
		);
		const upload = calls.filter((call) => call.method === "sendDocument").pop();
		check("send_file uploads a document", upload !== undefined, calls.map((c) => c.method).slice(-5));
		check("upload carries chat, caption and file field", Array.isArray(upload?.params.__multipart) && (upload!.params.__multipart as string[]).includes("chat_id") && (upload!.params.__multipart as string[]).includes("caption") && (upload!.params.__multipart as string[]).includes("document"), upload?.params);
		check("uploaded file is recorded in history", history.query({ thread: "telegram:42", direction: "outbound" }).some((r) => r.attachments?.some((a) => a.name === "report.txt")));

		const status = telegram.status();
		check("module status reports the bot", (status.bot as { username?: string })?.username === "alive_bot", status);
		check("module status counts the inbound message", (status.counters as { inbound?: number })?.inbound === 1, status.counters);

		await host.stop();
	} finally {
		globalThis.fetch = realFetch;
	}

	// Long messages are split into several Bot API calls.
	const callsBefore = calls.filter((call) => call.method === "sendMessage").length;
	const api = new TelegramApi({
		token: "tok",
		fetchImpl: fetchImpl,
	});
	await api.sendLongMessage({ chat_id: 42, text: `${"x".repeat(2500)}\n\n${"y".repeat(2500)}` });
	const callsAfter = calls.filter((call) => call.method === "sendMessage").length;
	check("sendLongMessage splits and sends every part", callsAfter - callsBefore === 2, callsAfter - callsBefore);
}

// ---------------------------------------------------------------------------
section("grafana module: alerts become deduped events");
{
	const net = await import("node:net");
	const port = await new Promise<number>((resolve, reject) => {
		const probe = net.createServer();
		probe.once("error", reject);
		probe.listen(0, "127.0.0.1", () => {
			const address = probe.address();
			const value = typeof address === "object" && address ? address.port : 0;
			probe.close(() => resolve(value));
		});
	});

	const grafanaRoot = fs.mkdtempSync(path.join(os.tmpdir(), "alive-grafana-test-"));
	const log = new Logger({ console: false, level: "error", scope: "grafana-test" });
	const store = EventStore.open(grafanaRoot);
	const history = HistoryStore.open(grafanaRoot);
	const graphanaConfig = {
		enabled: true,
		host: "127.0.0.1",
		port,
		path: "/grafana",
		token: "",
		firingPriority: "high" as const,
		resolvedPriority: "low" as const,
	};
	const host = new ModuleHost({
		config: loadConfig({ cwd: grafanaRoot }),
		log,
		transports: [],
		modules: [new GrafanaModule(graphanaConfig)],
		ingest: (event) => store.append(event),
		outbox: () => [],
		history,
		runtimeStatus: () => ({}),
	});
	await host.init();

	const payload = {
		status: "firing",
		externalURL: "http://grafana.local",
		commonLabels: { cluster: "prod" },
		alerts: [
			{
				status: "firing",
				fingerprint: "fp-1",
				startsAt: "2026-01-01T00:00:00Z",
				labels: { alertname: "HighCPU", severity: "critical", instance: "web-1" },
				annotations: { summary: "CPU above 95%" },
				generatorURL: "http://grafana.local/alert",
			},
			{
				status: "resolved",
				fingerprint: "fp-2",
				endsAt: "2026-01-01T01:00:00Z",
				labels: { alertname: "DiskFull", severity: "warning" },
				annotations: { summary: "disk freed" },
			},
		],
	};

	const post = (path: string, body: unknown) =>
		fetch(`http://127.0.0.1:${port}${path}`, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify(body),
		});

	const first = await post("/grafana/alert", payload);
	check("alert webhook accepts the payload", first.status === 202, first.status);
	const events = store.peekPending(10);
	check("each alert becomes an event", events.length === 2, events.map((e) => e.title));
	check("alerts are observability events", events.every((e) => e.kind === "observability" && e.source === "grafana"), events);
	check("firing is high priority", events.find((e) => e.title.includes("HighCPU"))?.priority === "high");
	check("resolved is low priority", events.find((e) => e.title.includes("DiskFull"))?.priority === "low");
	check("alert text carries the annotations", events[0]!.text.includes("CPU above 95%") === true, events[0]!.text);

	await post("/grafana/alert", payload);
	check("a repeated alert is deduped", store.peekPending(10).length === 2, store.peekPending(10).map((e) => e.title));

	const generic = await post("/grafana/event", { title: "deploy done", text: "v1.2.3 shipped", priority: "normal", dedupe_key: "deploy-1" });
	check("generic events are accepted", generic.status === 202, generic.status);
	check("generic events land in the inbox", store.peekPending(10).length === 3);

	check("grafana writes shared history", history.query({ module: "grafana" }).length === 3, history.query({ module: "grafana" }).length);
	const status = host.status() as { modules: Record<string, { received?: number; requests?: number }> };
	check("grafana counts events (per alert)", status.modules.grafana?.received === 5, status.modules.grafana);
	check("grafana counts accepted requests", status.modules.grafana?.requests === 3, status.modules.grafana);

	const health = await fetch(`http://127.0.0.1:${port}/grafana/health`);
	check("health endpoint answers", health.status === 200, health.status);
	await host.stop();
}

// ---------------------------------------------------------------------------
section("telegram client: network failures keep the cause");
{
	const failing = new TelegramApi({
		token: "tok",
		fetchImpl: (async () => {
			const cause = Object.assign(new Error("read ECONNRESET"), { code: "ECONNRESET" });
			const err = new Error("fetch failed");
			(err as { cause?: unknown }).cause = cause;
			throw err;
		}) as unknown as typeof fetch,
	});
	let failure: TelegramApiError | undefined;
	try {
		await failing.getMe();
	} catch (err) {
		failure = err as TelegramApiError;
	}
	check("network failures are flagged", failure?.network === true, failure?.message);
	check("the errno is preserved", failure?.networkCode === "ECONNRESET", failure?.networkCode);
	check("the cause chain reaches the message", failure?.message.includes("ECONNRESET") === true, failure?.message);
	check("network failures carry no Telegram error code", failure?.errorCode === undefined);
}

// ---------------------------------------------------------------------------
section("telegram module: outage is reported once, not spammed");
{
	const outageRoot = fs.mkdtempSync(path.join(os.tmpdir(), "alive-telegram-outage-"));
	const log = new Logger({ console: false, level: "error", scope: "outage-test" });
	const store = EventStore.open(outageRoot);
	const history = HistoryStore.open(outageRoot);
	let pollAttempts = 0;
	const fetchImpl = (async (input: string | URL | Request) => {
		const method = String(input).slice(String(input).lastIndexOf("/") + 1);
		if (method === "getMe") return jsonResponse({ ok: true, result: { id: 1, is_bot: true, first_name: "Alive", username: "alive_bot" } });
		if (method === "deleteWebhook") return jsonResponse({ ok: true, result: true });
		pollAttempts += 1;
		const cause = Object.assign(new Error("read ECONNRESET"), { code: "ECONNRESET" });
		const err = new Error("fetch failed");
		(err as { cause?: unknown }).cause = cause;
		throw err;
	}) as unknown as typeof fetch;

	const outageConfig = loadConfig({
		cwd: outageRoot,
		overrides: {
			chat: { console: false, http: { enabled: false, host: "127.0.0.1", port: 0, token: "" } },
			modules: {
				telegram: {
					enabled: true,
					token: "tok",
					tokenEnv: "ALIVE_TEST_TELEGRAM_TOKEN_UNSET",
					apiBase: "https://api.telegram.org",
					allowedChatIds: [],
					allowedUserIds: [],
					pollTimeoutSec: 0,
					allowedUpdates: ["message"],
					parseMode: "",
					linkPreview: true,
					typingIndicator: false,
					ackReaction: "",
					ingestEdits: true,
					historyLimitPerThread: 0,
					maxMessageChars: 4096,
				},
				grafana: { enabled: false, host: "127.0.0.1", port: 0, path: "/grafana", token: "", firingPriority: "high", resolvedPriority: "low" },
			external: [],
			},
		},
	});
	const telegram = new TelegramModule(outageConfig.config.modules.telegram);
	const realFetch = globalThis.fetch;
	globalThis.fetch = fetchImpl;
	try {
		const host = new ModuleHost({
			config: outageConfig,
			log,
			transports: [],
			modules: [telegram],
			ingest: (event) => store.append(event),
			outbox: () => [],
			history,
			runtimeStatus: () => ({}),
		});
		await host.init();
		// First failure is immediate; the next attempt waits jitter(1s) ≈ 0.8–1.2s.
		await new Promise((resolve) => setTimeout(resolve, 1_700));
		const status = telegram.status() as {
			reachable?: boolean;
			consecutiveFailures?: number;
			lastError?: string;
			lastErrorAt?: number;
		};
		check("an outage eventually marks the module unreachable", status.reachable === false, status);
		check("consecutive failures are counted", (status.consecutiveFailures ?? 0) >= 1, status);
		check("the outage reason names the errno", status.lastError?.includes("ECONNRESET") === true, status.lastError);
		check("the outage is timestamped", typeof status.lastErrorAt === "number");
		check("polling keeps retrying", pollAttempts >= 2, pollAttempts);
		await host.stop();
	} finally {
		globalThis.fetch = realFetch;
	}
}

// ---------------------------------------------------------------------------
section("modules config and loader");
{
	const configRoot = fs.mkdtempSync(path.join(os.tmpdir(), "alive-modules-config-"));
	fs.writeFileSync(
		path.join(configRoot, "alive.config.json"),
		JSON.stringify({
			modules: {
				telegram: { enabled: true, tokenEnv: "MY_TG_TOKEN" },
				grafana: { enabled: true, port: 5999 },
			},
		}),
	);
	const config = loadConfig({ cwd: configRoot });
	check("telegram config merges with defaults", config.config.modules.telegram.pollTimeoutSec === 25, config.config.modules.telegram);
	check("grafana config merges with defaults", config.config.modules.grafana.host === "127.0.0.1" && config.config.modules.grafana.port === 5999, config.config.modules.grafana);
	check("env token wins", resolveToken(config.config.modules.telegram, { MY_TG_TOKEN: "from-env" } as NodeJS.ProcessEnv) === "from-env");
	check("config token is the fallback", resolveToken({ ...config.config.modules.telegram, token: "from-config" }, {} as NodeJS.ProcessEnv) === "from-config");
	check("missing token resolves to empty", resolveToken({ ...config.config.modules.telegram, token: "" }, {} as NodeJS.ProcessEnv) === "");

	const described = describeModules(config.config);
	check("describeModules lists telegram", described.find((m) => m.name === "telegram")?.enabled === true, described);
	check("describeModules lists grafana", described.find((m) => m.name === "grafana")?.enabled === true, described);

	const loaded = await loadModules(config, new Logger({ console: false, level: "error" }));
	check("telegram and grafana load as built-ins", loaded.modules.map((m) => m.name).sort().join(",") === "grafana,telegram", loaded.modules.map((m) => m.name));
	check("loading reports no errors", loaded.errors.length === 0, loaded.errors);
}

process.stdout.write(failures === 0 ? "\nALL MODULE TESTS PASSED\n" : `\n${failures} MODULE TEST(S) FAILED\n`);
process.exitCode = failures === 0 ? 0 : 1;
