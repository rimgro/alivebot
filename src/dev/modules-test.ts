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
import { DEFAULT_CONFIG, loadConfig } from "../config.js";
import { ModuleHost } from "../events/host.js";
import { describeModules, loadModules } from "../events/loader.js";
import type { AliveModule, ModuleContext } from "../events/api.js";
import { Logger } from "../log.js";
import { EventStore } from "../store/events.js";
import { HistoryStore } from "../store/history.js";
import { Outbox, type OutgoingMessage } from "../store/outbox.js";
import type { ChatTransport } from "../transports/types.js";
import { GrafanaModule } from "../modules/grafana/module.js";
import { TelegramApi, TelegramApiError, TelegramFileTooLargeError } from "../modules/telegram/client.js";
import { resolveToken, TelegramModule } from "../modules/telegram/module.js";
import { escapeHtml, isParseModeError, splitMessage } from "../modules/telegram/text.js";
import { formatThread, parseThread, resolveChatTarget } from "../modules/telegram/threads.js";
import { normalizeUpdate } from "../modules/telegram/update.js";
import { TELEGRAM_IMAGE_MAX_BYTES, imageAnnotation, imageFileName, imageMime, imageRelativePath } from "../modules/telegram/images.js";
import {
	GROQ_TRANSCRIPTION_ENDPOINT,
	GROQ_TRANSCRIPTION_MODEL,
	GroqTranscriptionError,
	TELEGRAM_VOICE_MAX_BYTES,
	transcribeWithGroq,
} from "../modules/telegram/voice-transcription.js";
import {
	extractPdfText,
	PDF_TEXT_MAX_BYTES,
	PdfTextError,
} from "../modules/telegram/pdf-text.js";
import { createTelegramTools } from "../modules/telegram/tools.js";
import {
	OUTBOUND_DOCUMENT_MAX_BYTES,
	OUTBOUND_PHOTO_MAX_BYTES,
	assertAttachmentSize,
	resolveOutgoingAttachment,
} from "../runtime/attachments.js";
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

/** Minimal valid PDF with one Helvetica text line per array entry. */
function buildPdf(pages: string[][]): Buffer {
	const objects = [
		"<< /Type /Catalog /Pages 2 0 R >>",
		`<< /Type /Pages /Kids [${pages.map((_, index) => `${4 + index * 2} 0 R`).join(" ")}] /Count ${pages.length} >>`,
		"<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
	];
	for (const [index, lines] of pages.entries()) {
		const content = [
			"BT",
			"/F1 12 Tf",
			"72 720 Td",
			...lines.map((line, lineIndex) => `${lineIndex === 0 ? "" : "0 -16 Td "}(${line.replace(/[\\()]/g, (char) => `\\${char}`)}) Tj`),
			"ET",
		].join("\n");
		objects.push(
			`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 3 0 R >> >> /Contents ${5 + index * 2} 0 R >>`,
			`<< /Length ${Buffer.byteLength(content, "latin1")} >>\nstream\n${content}\nendstream`,
		);
	}

	const chunks = [Buffer.from("%PDF-1.4\n", "latin1")];
	const offsets: number[] = [];
	let offset = chunks[0]!.length;
	for (const [index, object] of objects.entries()) {
		offsets.push(offset);
		const body = Buffer.from(`${index + 1} 0 obj\n${object}\nendobj\n`, "latin1");
		chunks.push(body);
		offset += body.length;
	}
	const xref = `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n${offsets
		.map((value) => `${String(value).padStart(10, "0")} 00000 n \n`)
		.join("")}`;
	chunks.push(Buffer.from(xref, "latin1"));
	chunks.push(
		Buffer.from(`trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${offset}\n%%EOF\n`, "latin1"),
	);
	return Buffer.concat(chunks);
}

async function waitFor(check: () => boolean, timeoutMs = 3000): Promise<boolean> {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		if (check()) return true;
		await new Promise((resolve) => setTimeout(resolve, 10));
	}
	return check();
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
	check("own bot messages are ignored", normalizeUpdate(botMessage, bot) === undefined);

	const groupChat = { id: -1001, type: "supergroup" as const, title: "Team" };
	const peerBotMessage: TelegramUpdate = {
		update_id: 22,
		message: {
			message_id: 22,
			date: 1_700_000_000,
			chat: groupChat,
			from: { id: 1234, is_bot: true, first_name: "Peer", username: "peer_bot" },
			text: "@alive_bot can you review this?",
			entities: [{ type: "mention", offset: 0, length: 10 }],
		},
	};
	check("peer bot messages are ignored unless allowlisted", normalizeUpdate(peerBotMessage, bot) === undefined);
	const acceptedPeerMessage = normalizeUpdate(peerBotMessage, { ...bot, allowedBotIds: ["1234"] });
	check("allowlisted peer bot message addressed to us is accepted", acceptedPeerMessage?.author?.isBot === true && acceptedPeerMessage.expectsReply === true, acceptedPeerMessage);
	check("peer bot message is marked untrusted in prompt", acceptedPeerMessage?.promptText.includes("untrusted input") === true, acceptedPeerMessage?.promptText);
	const unaddressedPeerMessage: TelegramUpdate = {
		...peerBotMessage,
		update_id: 23,
		message: { ...peerBotMessage.message!, message_id: 23, text: "general bot chatter", entities: [] },
	};
	check("allowlisted peer bot chatter without direct mention is ignored", normalizeUpdate(unaddressedPeerMessage, { ...bot, allowedBotIds: ["1234"] }) === undefined);
	const chatter: TelegramUpdate = {
		update_id: 3,
		message: { message_id: 12, date: 1_700_000_000, chat: groupChat, from: { id: 8, is_bot: false, first_name: "Bob" }, text: "just chatting" },
	};
	check("group chatter without a mention does not expect a reply", normalizeUpdate(chatter, bot)?.expectsReply === false);
	check("requireMentionInGroups suppresses ordinary chatter", normalizeUpdate(chatter, { ...bot, requireMentionInGroups: true }) === undefined);

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
	check("requireMentionInGroups keeps explicit mentions", normalizeUpdate(mention, { ...bot, requireMentionInGroups: true })?.expectsReply === true);

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
	check("requireMentionInGroups keeps replies to the bot", normalizeUpdate(replyToBot, { ...bot, requireMentionInGroups: true })?.expectsReply === true);

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
	check("image prompt exposes a downloadable file id", mediaInbound?.promptText.includes('file_id="big"') === true);
	check("image prompt explains how to see pixels", mediaInbound?.promptText.includes('action="download_file"') === true && mediaInbound.promptText.includes("read the returned local path"));

	const documentMessage: TelegramUpdate = {
		update_id: 8,
		message: {
			message_id: 17,
			date: 1_700_000_000,
			chat: privateMessage.message!.chat,
			from: { id: 7, is_bot: false, first_name: "Alice" },
			document: { file_id: "doc-1", file_unique_id: "du-1", file_name: "report.pdf", mime_type: "application/pdf", file_size: 20_000 },
		},
	};
	const documentInbound = normalizeUpdate(documentMessage, bot);
	check("document prompt exposes a downloadable file id", documentInbound?.promptText.includes('file_id="doc-1"') === true, documentInbound?.promptText);
	check("document prompt explains download_file", documentInbound?.promptText.includes('action="download_file"') === true && documentInbound.promptText.includes("read the returned local path"));
	check("document prompt does not claim to describe content", documentInbound?.promptText.includes("not the image content") !== true);

	const groupPhoto = normalizeUpdate({ update_id: 70, message: { ...media.message!, chat: groupChat } }, bot);
	check("group photos expose the same vision path", groupPhoto?.promptText.includes('file_id="big"') === true);
	const photoReply = normalizeUpdate({
		update_id: 71,
		message: {
			...replyToBot.message!,
			text: "what is in this picture?",
			reply_to_message: { ...media.message!, chat: groupChat },
		},
	}, bot);
	check("reply to a group photo includes its file id", photoReply?.promptText.includes('reply attachments: photo') === true && photoReply.promptText.includes('file_id="big"'));
	check("quoted attachments are not attributed to the new message", photoReply?.attachments.length === 0);
	const documentImage = normalizeUpdate({
		update_id: 72,
		message: { ...command.message!, document: { file_id: "png", file_unique_id: "png-id", file_name: "screenshot.png", mime_type: "image/png" } },
	}, bot);
	check("images sent as documents include vision instructions", documentImage?.promptText.includes('file_id="png"') === true && documentImage.promptText.includes("read the returned local path"));

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
section("telegram inbound image paths");
{
	const photo = { kind: "photo", fileId: "big", fileUniqueId: "AbCd", size: 4 };
	check("photos default to image/jpeg", imageMime(photo) === "image/jpeg", imageMime(photo));
	check("explicit image mime is kept", imageMime({ kind: "photo", mime: "image/png; charset=binary" }) === "image/png");
	check("file names use the message id and file_unique_id", imageFileName("123", "AbCd", "image/jpeg") === "123-AbCd.jpg", imageFileName("123", "AbCd", "image/jpeg"));
	check("the extension follows the mime type", imageRelativePath("7", "u1", "image/png") === "telegram-files/7-u1.png", imageRelativePath("7", "u1", "image/png"));
	check("unknown image mime types fall back to .jpg", imageFileName("1", "u", "image/avif") === "1-u.jpg");
	check(
		"file name components are sanitized",
		imageRelativePath("../9", "../../etc/passwd", "image/jpeg") === "telegram-files/9-etc_passwd.jpg",
		imageRelativePath("../9", "../../etc/passwd", "image/jpeg"),
	);
	const saved = imageAnnotation({ status: "saved", path: "telegram-files/1-u.jpg", mime: "image/jpeg", bytes: 4 });
	check("a saved image annotation carries the path and a read hint", saved.includes("image saved: telegram-files/1-u.jpg") && saved.includes("read this local file"), saved);
	check("an oversize annotation is short and states the cap", imageAnnotation({ status: "too_large" }) === "image not saved: file exceeds the 10 MiB limit");
	check("a failed annotation never includes the token or URL", !imageAnnotation({ status: "failed", reason: "Telegram file download failed" }).includes("bot"));
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

	let oversizedStreamCancelled = false;
	const oversizedBody = new ReadableStream<Uint8Array>({
		start(controller) {
			controller.enqueue(Uint8Array.from([1, 2]));
			controller.enqueue(Uint8Array.from([3]));
		},
		cancel() {
			oversizedStreamCancelled = true;
		},
	});
	const downloadApi = new TelegramApi({ token: "tok", fetchImpl: (async () => new Response(oversizedBody)) as unknown as typeof fetch });
	let downloadError: unknown;
	try {
		await downloadApi.downloadFile("voice.oga", { maxBytes: 2 });
	} catch (err) {
		downloadError = err;
	}
	check("file downloads stop as soon as the byte limit is exceeded", downloadError instanceof Error && downloadError.message.includes("2 byte limit"));
	check("oversized downloads raise a typed error", downloadError instanceof TelegramFileTooLargeError && downloadError.limitBytes === 2);
	check("oversized response stream is cancelled", oversizedStreamCancelled);
}

// ---------------------------------------------------------------------------
section("Groq Whisper transcription client");
{
	let authHeader = "";
	let uploadedName = "";
	let uploadedType = "";
	let requestKeys: string[] = [];
	const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
		check("transcription targets the Groq endpoint", String(input) === GROQ_TRANSCRIPTION_ENDPOINT);
		authHeader = new Headers(init?.headers).get("authorization") ?? "";
		if (init?.body instanceof FormData) {
			requestKeys = [...init.body.keys()].sort();
			const file = init.body.get("file");
			if (file instanceof Blob) {
				uploadedName = "name" in file ? String(file.name) : "";
				uploadedType = file.type;
			}
		}
		return jsonResponse({ text: "  create a bug report  " });
	}) as unknown as typeof fetch;
	const transcript = await transcribeWithGroq({
		apiKey: "test-groq-key",
		audio: Uint8Array.from([1, 2, 3]),
		mimeType: "audio/ogg",
		fetchImpl,
	});
	check("transcription text is trimmed", transcript === "create a bug report", transcript);
	check("Groq receives the bearer authorization", authHeader === "Bearer test-groq-key");
	check("Groq multipart body includes file, model and JSON response format", requestKeys.join(",") === "file,model,response_format", requestKeys);
	check("voice bytes retain an audio MIME and safe filename", uploadedType === "audio/ogg" && uploadedName === "telegram-voice.ogg", { uploadedType, uploadedName });
	check("the configured Whisper model is stable", GROQ_TRANSCRIPTION_MODEL === "whisper-large-v3-turbo");

	let error: unknown;
	try {
		await transcribeWithGroq({
			apiKey: "test-groq-key",
			audio: new Uint8Array(TELEGRAM_VOICE_MAX_BYTES + 1),
			fetchImpl: (async () => {
				throw new Error("oversized audio must not be uploaded");
			}) as unknown as typeof fetch,
		});
	} catch (caught) {
		error = caught;
	}
	check("oversized audio is rejected before upload", error instanceof GroqTranscriptionError && error.code === "too_large");
	check("safe transcription errors never include the API key", error instanceof Error && !error.message.includes("test-groq-key"));

	let missingKeyError: unknown;
	let missingKeyFetchCalled = false;
	try {
		await transcribeWithGroq({
			apiKey: " ",
			audio: Uint8Array.from([1]),
			fetchImpl: (async () => {
				missingKeyFetchCalled = true;
				return jsonResponse({ text: "should not be sent" });
			}) as unknown as typeof fetch,
		});
	} catch (caught) {
		missingKeyError = caught;
	}
	check("empty Groq key is rejected without a request", missingKeyError instanceof GroqTranscriptionError && missingKeyError.code === "missing_api_key" && !missingKeyFetchCalled);

	let httpError: unknown;
	try {
		await transcribeWithGroq({
			apiKey: "test-groq-key",
			audio: Uint8Array.from([1]),
			fetchImpl: (async () => new Response('secret not to log', { status: 401 })) as unknown as typeof fetch,
		});
	} catch (caught) {
		httpError = caught;
	}
	check("provider HTTP errors are safe and keep the status", httpError instanceof GroqTranscriptionError && httpError.code === "http_error" && httpError.status === 401 && !httpError.message.includes("secret"));

	let timeoutError: unknown;
	try {
		await transcribeWithGroq({
			apiKey: "test-groq-key",
			audio: Uint8Array.from([1]),
			fetchImpl: (async () => {
				throw Object.assign(new Error("aborted"), { name: "TimeoutError" });
			}) as unknown as typeof fetch,
		});
	} catch (caught) {
		timeoutError = caught;
	}
	check("a timed-out request is reported as a timeout, not a generic failure", timeoutError instanceof GroqTranscriptionError && timeoutError.code === "timeout");

	let configuredLimitError: unknown;
	try {
		await transcribeWithGroq({
			apiKey: "test-groq-key",
			audio: Uint8Array.from([1, 2, 3]),
			maxBytes: 2,
			fetchImpl: (async () => {
				throw new Error("audio over the configured limit must not be uploaded");
			}) as unknown as typeof fetch,
		});
	} catch (caught) {
		configuredLimitError = caught;
	}
	check("the byte ceiling is configurable", configuredLimitError instanceof GroqTranscriptionError && configuredLimitError.code === "too_large");
}

// ---------------------------------------------------------------------------
section("PDF text extraction: local, bounded, fail-safe");
{
	const extracted = await extractPdfText(buildPdf([["Hello PDF from Alive", "Second line"]]));
	check(
		"PDF text is extracted locally",
		extracted.text.includes("Hello PDF from Alive") && extracted.text.includes("Second line"),
		extracted,
	);
	check("a normal PDF is one page and not truncated", extracted.pages === 1 && !extracted.truncated, extracted);

	const capped = await extractPdfText(buildPdf([Array.from({ length: 12 }, () => "A".repeat(50))]), { maxChars: 100 });
	check(
		"the character cap is respected and marked",
		capped.truncated && capped.text.length <= 100 && capped.text.includes("[PDF text truncated"),
		capped,
	);

	const pageLimited = await extractPdfText(buildPdf([["page one"], ["page two"]]), { maxPages: 1 });
	check(
		"the page cap stops after the configured page",
		pageLimited.pages === 1 && pageLimited.truncated && !pageLimited.text.includes("page two"),
		pageLimited,
	);

	let oversized: unknown;
	try {
		await extractPdfText(new Uint8Array(PDF_TEXT_MAX_BYTES + 1));
	} catch (err) {
		oversized = err;
	}
	check("an oversized PDF is rejected before parsing", oversized instanceof PdfTextError && oversized.code === "too_large", oversized);

	let parseFailure: unknown;
	try {
		await extractPdfText(Buffer.from("%PDF-1.4\nthis is not a PDF\n%%EOF", "latin1"));
	} catch (err) {
		parseFailure = err;
	}
	check("unparseable PDF bytes fail safely", parseFailure instanceof PdfTextError && parseFailure.code === "failed", parseFailure);
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
	const writtenFiles: Array<{ path: string; bytes: number }> = [];
	let getUpdatesCalls = 0;
	let serveNoKeyBatch = false;

	const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
		const url = String(input);
		const isGroq = url === GROQ_TRANSCRIPTION_ENDPOINT;
		const method = isGroq ? "groqTranscription" : url.slice(url.lastIndexOf("/") + 1);
		const params =
			init?.body instanceof FormData
				? ({
						__multipart: [...init.body.keys()],
						...(isGroq ? { authorizationValid: new Headers(init.headers).get("authorization") === "Bearer test-groq-key" } : {}),
				  } as Record<string, unknown>)
				: init?.body
					? (JSON.parse(String(init.body)) as Record<string, unknown>)
					: {};
		calls.push({ method, params });
		if (url.includes("/file/bot")) {
			if (url.endsWith("photos/missing.jpg")) return new Response("gone", { status: 404 });
			if (url.endsWith("photos/photo.jpg")) return new Response(Uint8Array.from([0xff, 0xd8, 0xff, 0xd9]), { status: 200, headers: { "content-type": "image/jpeg" } });
			const bytes = url.endsWith("voice-fail.oga") ? [9, 9, 9] : [1, 2, 3];
			return new Response(Uint8Array.from(bytes), { status: 200, headers: { "content-type": "audio/ogg" } });
		}
		if (isGroq) {
			const file = init?.body instanceof FormData ? init.body.get("file") : undefined;
			const bytes = file instanceof Blob ? new Uint8Array(await file.arrayBuffer()) : new Uint8Array();
			// Byte 9 marks the recording whose provider call must fail.
			if (bytes[0] === 9) return new Response("provider body must not be logged", { status: 500 });
			return jsonResponse({ text: "create a bug report" });
		}
		if (method === "getFile") {
			const fileId = String(params.file_id ?? "");
			if (fileId === "photo-file") return jsonResponse({ ok: true, result: { file_id: fileId, file_unique_id: "photo-unique", file_path: "photos/photo.jpg", file_size: 4 } });
			if (fileId === "photo-missing") return jsonResponse({ ok: true, result: { file_id: fileId, file_unique_id: "photo-missing-unique", file_path: "photos/missing.jpg", file_size: 4 } });
			if (fileId === "photo-large") return jsonResponse({ ok: true, result: { file_id: fileId, file_unique_id: "photo-large-unique", file_path: "photos/photo.jpg", file_size: TELEGRAM_IMAGE_MAX_BYTES + 1 } });
			if (fileId === "voice-fail") return jsonResponse({ ok: true, result: { file_id: fileId, file_unique_id: "voice-fail-unique", file_path: "voice-fail.oga", file_size: 3 } });
			if (fileId === "voice-large") return jsonResponse({ ok: true, result: { file_id: fileId, file_unique_id: "voice-large-unique", file_path: "voice-large.oga", file_size: TELEGRAM_VOICE_MAX_BYTES + 1 } });
			return jsonResponse({ ok: true, result: { file_id: "voice-file", file_unique_id: "voice-unique", file_path: "voice.oga", file_size: 3 } });
		}
		if (method === "getMe") {
			return jsonResponse({ ok: true, result: { id: 999, is_bot: true, first_name: "Alive", username: "alive_bot" } });
		}
		if (method === "deleteWebhook") return jsonResponse({ ok: true, result: true });
		if (method === "getUpdates") {
			getUpdatesCalls += 1;
			if (getUpdatesCalls > 1) await new Promise((resolve) => setTimeout(resolve, 10));
			if (serveNoKeyBatch) {
				serveNoKeyBatch = false;
				return jsonResponse({
					ok: true,
					result: [
						{
							update_id: 200,
							message: {
								message_id: 11,
								date: 1_700_000_010,
								chat: { id: 42, type: "private", first_name: "Alice", username: "alice" },
								from: { id: 7, is_bot: false, first_name: "Alice", username: "alice" },
								voice: { file_id: "voice-file", file_unique_id: "voice-unique", file_size: 3, duration: 2, mime_type: "audio/ogg" },
							},
						},
					],
				});
			}
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
						{
							update_id: 101,
							message: {
								message_id: 6,
								date: 1_700_000_001,
								chat: { id: 43, type: "private", first_name: "Bob" },
								from: { id: 8, is_bot: false, first_name: "Bob" },
								text: "unknown user message",
							},
						},
						{
							update_id: 102,
							message: {
								message_id: 7,
								date: 1_700_000_002,
								chat: { id: 42, type: "private", first_name: "Alice", username: "alice" },
								from: { id: 7, is_bot: false, first_name: "Alice", username: "alice" },
								voice: { file_id: "voice-file", file_unique_id: "voice-unique", file_size: 3, duration: 2, mime_type: "audio/ogg" },
							},
						},
						{
							update_id: 103,
							message: {
								message_id: 8,
								date: 1_700_000_003,
								chat: { id: 42, type: "private", first_name: "Alice", username: "alice" },
								from: { id: 7, is_bot: false, first_name: "Alice", username: "alice" },
								voice: { file_id: "voice-fail", file_unique_id: "voice-fail-unique", file_size: 3, duration: 2, mime_type: "audio/ogg" },
							},
						},
						{
							update_id: 104,
							message: {
								message_id: 9,
								date: 1_700_000_004,
								chat: { id: 42, type: "private", first_name: "Alice", username: "alice" },
								from: { id: 7, is_bot: false, first_name: "Alice", username: "alice" },
								voice: { file_id: "voice-large", file_unique_id: "voice-large-unique", file_size: TELEGRAM_VOICE_MAX_BYTES + 1, duration: 2, mime_type: "audio/ogg" },
							},
						},
						{
							update_id: 105,
							message: {
								message_id: 10,
								date: 1_700_000_005,
								chat: { id: 42, type: "private", first_name: "Alice", username: "alice" },
								from: { id: 7, is_bot: false, first_name: "Alice", username: "alice" },
								audio: { file_id: "audio-track", file_unique_id: "audio-track-unique", file_size: 4, duration: 2, mime_type: "audio/mpeg" },
							},
						},
						{
							update_id: 106,
							message: {
								message_id: 12,
								date: 1_700_000_006,
								chat: { id: 42, type: "private", first_name: "Alice", username: "alice" },
								from: { id: 7, is_bot: false, first_name: "Alice", username: "alice" },
								caption: "what is this?",
								photo: [
									{ file_id: "photo-small", file_unique_id: "photo-small-unique", width: 90, height: 60, file_size: 1 },
									{ file_id: "photo-file", file_unique_id: "photo-unique", width: 1280, height: 720, file_size: 4 },
								],
							},
						},
						{
							update_id: 107,
							message: {
								message_id: 13,
								date: 1_700_000_007,
								chat: { id: 42, type: "private", first_name: "Alice", username: "alice" },
								from: { id: 7, is_bot: false, first_name: "Alice", username: "alice" },
								photo: [{ file_id: "photo-large", file_unique_id: "photo-large-unique", width: 4000, height: 3000, file_size: TELEGRAM_IMAGE_MAX_BYTES + 1 }],
							},
						},
						{
							update_id: 108,
							message: {
								message_id: 14,
								date: 1_700_000_008,
								chat: { id: 42, type: "private", first_name: "Alice", username: "alice" },
								from: { id: 7, is_bot: false, first_name: "Alice", username: "alice" },
								photo: [{ file_id: "photo-missing", file_unique_id: "photo-missing-unique", width: 640, height: 480, file_size: 4 }],
							},
						},
						{
							update_id: 109,
							message: {
								message_id: 15,
								date: 1_700_000_009,
								chat: { id: 42, type: "private", first_name: "Alice", username: "alice" },
								from: { id: 7, is_bot: false, first_name: "Alice", username: "alice" },
								document: { file_id: "doc-pdf", file_unique_id: "doc-pdf-unique", file_name: "report.pdf", mime_type: "application/pdf", file_size: 1000 },
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
					allowedUserIds: ["7"],
					allowedBotIds: [],
					requireMentionInGroups: false,
					pollTimeoutSec: 0,
					allowedUpdates: ["message"],
					parseMode: "",
					linkPreview: true,
					typingIndicator: true,
					ackReaction: "",
					ingestEdits: true,
					historyLimitPerThread: 0,
					maxMessageChars: 4096,
					transcription: { ...DEFAULT_CONFIG.modules.telegram.transcription },
				},
				grafana: { enabled: false, host: "127.0.0.1", port: 0, path: "/grafana", token: "", firingPriority: "high", resolvedPriority: "low" },
				external: [],
			},
		},
	});

	// Inject the fake fetch before start(): the module builds its client there.
	const telegram = new TelegramModule(config.config.modules.telegram);
	const realFetch = globalThis.fetch;
	const previousGroqKey = process.env.GROQ_API_KEY;
	process.env.GROQ_API_KEY = "test-groq-key";
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
			workspaceFiles: {
				rootDir: config.paths.workspaceDir,
				readFile: async (file) => fs.readFileSync(file),
				writeFile: async (file, data) => {
					writtenFiles.push({ path: file, bytes: data.length });
					fs.mkdirSync(path.dirname(file), { recursive: true });
					fs.writeFileSync(file, data);
					return file;
				},
			},
		});
		await host.init();
		await new Promise((resolve) => setTimeout(resolve, 60));

		const pending = store.peekPending(20);
		check("updates became durable events", pending.length === 9, pending.map((e) => e.title));
		check("the event is a user message on the right thread", pending[0]?.kind === "user_message" && pending[0]?.thread === "telegram:42", pending[0]);
		check("the event expects a reply", pending[0]?.expectsReply === true);
		const denial = calls.find((call) => call.method === "sendMessage" && String(call.params.text).includes("Ваш Telegram ID: 8"));
		check("unknown Telegram users get a whitelist request and are not processed", pending.length === 9 && denial !== undefined, { pending: pending.length, denial });
		check("the event carries structured payload", (pending[0]?.payload as { messageId?: string })?.messageId === "5", pending[0]?.payload);
		const voiceEvent = pending.find((event) => (event.payload as { messageId?: string })?.messageId === "7");
		check("voice message event includes Groq transcript", voiceEvent?.text.includes("create a bug report") === true, voiceEvent?.text);
		check("voice message payload records transcription status", (voiceEvent?.payload as { transcription?: { status?: string } })?.transcription?.status === "transcribed");
		const transcriptionCall = calls.find((call) => call.method === "groqTranscription");
		check("Telegram resolves the voice file before transcription", calls.some((call) => call.method === "getFile"));
		check("voice bytes are downloaded from Telegram", calls.some((call) => call.method === "voice.oga"));
		check("voice is sent to Groq with auth", transcriptionCall?.params.authorizationValid === true, transcriptionCall?.params);
		check("module status reports the configured transcription model", (telegram.status().transcription as { configured?: boolean; model?: string })?.configured === true && (telegram.status().transcription as { model?: string })?.model === GROQ_TRANSCRIPTION_MODEL, telegram.status().transcription);

		const failedEvent = pending.find((event) => (event.payload as { messageId?: string })?.messageId === "8");
		check(
			"a provider failure keeps the message and records the failure",
			failedEvent !== undefined &&
				failedEvent.text.includes("Groq returned HTTP 500") &&
				(failedEvent.payload as { transcription?: { status?: string } })?.transcription?.status === "failed",
			failedEvent?.text,
		);
		check("the provider error body never reaches the event", failedEvent?.text.includes("provider body must not be logged") !== true, failedEvent?.text);
		const largeEvent = pending.find((event) => (event.payload as { messageId?: string })?.messageId === "9");
		check(
			"oversized voice notes are skipped as too large",
			(largeEvent?.payload as { transcription?: { status?: string } })?.transcription?.status === "too_large" && largeEvent?.text.includes("MiB") === true,
			largeEvent?.text,
		);
		check("an oversized voice note is never downloaded", !calls.some((call) => call.method === "getFile" && call.params.file_id === "voice-large"));
		const audioEvent = pending.find((event) => (event.payload as { messageId?: string })?.messageId === "10");
		check(
			"non-voice audio attachments are left alone",
			audioEvent !== undefined && !audioEvent.text.includes("voice transcript") && (audioEvent.payload as { transcription?: unknown })?.transcription === undefined,
			audioEvent?.text,
		);

		const imageEvent = pending.find((event) => (event.payload as { messageId?: string })?.messageId === "12");
		const savedImagePath = "telegram-files/12-photo-unique.jpg";
		const imagePayload = (imageEvent?.payload as { image?: { path?: string; mime?: string; bytes?: number } })?.image;
		check("incoming photos are saved automatically", imageEvent?.text.includes(`image saved: ${savedImagePath}`) === true, imageEvent?.text);
		check("the saved-image line tells the agent to read the local file", imageEvent?.text.includes("read this local file") === true, imageEvent?.text);
		check("the existing download hint is kept as a fallback", imageEvent?.text.includes('action="download_file"') === true, imageEvent?.text);
		check("the payload records the saved image", imagePayload?.path === savedImagePath && imagePayload?.mime === "image/jpeg" && imagePayload?.bytes === 4, imagePayload);
		check(
			"the image is written through workspaceFiles",
			writtenFiles.some((file) => file.path === path.join(config.paths.workspaceDir, savedImagePath) && file.bytes === 4),
			writtenFiles,
		);
		const savedImage = fs.existsSync(path.join(config.paths.workspaceDir, savedImagePath)) ? fs.readFileSync(path.join(config.paths.workspaceDir, savedImagePath)) : undefined;
		check("the saved file contains the downloaded bytes", savedImage?.length === 4 && savedImage[0] === 0xff && savedImage[3] === 0xd9, savedImage);
		check("only the largest photo of the message is fetched", !calls.some((call) => call.method === "getFile" && call.params.file_id === "photo-small"));
		const imageRecord = history.query({ thread: "telegram:42" }).find((record) => record.messageId === "12");
		check("history carries the saved image path", imageRecord?.text.includes(`image saved: ${savedImagePath}`) === true, imageRecord?.text);
		check("the caption and photo metadata survive", imageRecord?.text.startsWith("what is this?") === true && imageRecord?.attachments?.[0]?.kind === "photo", imageRecord);

		const largeImageEvent = pending.find((event) => (event.payload as { messageId?: string })?.messageId === "13");
		check(
			"oversized photos are skipped with a note",
			largeImageEvent !== undefined && largeImageEvent.text.includes("image not saved: file exceeds the 10 MiB limit"),
			largeImageEvent?.text,
		);
		check("an oversized photo is never downloaded", !calls.some((call) => call.method === "getFile" && call.params.file_id === "photo-large"));
		check("a skipped image has no payload image", (largeImageEvent?.payload as { image?: unknown })?.image === undefined);

		const brokenImageEvent = pending.find((event) => (event.payload as { messageId?: string })?.messageId === "14");
		check("a failed image download keeps the message", brokenImageEvent !== undefined && brokenImageEvent.text.includes("image not saved: Telegram file download failed (HTTP 404)"), brokenImageEvent?.text);
		check("a failed image has no payload image", (brokenImageEvent?.payload as { image?: unknown })?.image === undefined);
		check("the failed download never leaks the file URL or token", brokenImageEvent?.text.includes("bot") !== true && brokenImageEvent?.text.includes("test-token") !== true, brokenImageEvent?.text);
		const brokenImageRecord = history.query({ thread: "telegram:42" }).find((record) => record.messageId === "14");
		check("transient image failures stay out of durable history", brokenImageRecord !== undefined && !brokenImageRecord.text.includes("image not saved"), brokenImageRecord?.text);

		const documentEvent = pending.find((event) => (event.payload as { messageId?: string })?.messageId === "15");
		check(
			"documents are not downloaded automatically",
			documentEvent !== undefined &&
				!documentEvent.text.includes("image saved") &&
				(documentEvent.payload as { image?: unknown })?.image === undefined &&
				!calls.some((call) => call.method === "getFile" && call.params.file_id === "doc-pdf"),
			documentEvent?.text,
		);
		check("documents keep the on-demand download hint", documentEvent?.text.includes('action="download_file"') === true, documentEvent?.text);

		const records = history.query({ thread: "telegram:42" });
		check("inbound messages landed in history", records.length === 9 && records[0]?.direction === "inbound", records.length);
		check("transcript is searchable in history text", records.some((record) => record.text.includes("create a bug report")), records.map((record) => record.text));
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

		// Degrade, do not drop: without a key the voice note still becomes an event.
		delete process.env.GROQ_API_KEY;
		const groqCallsBefore = calls.filter((call) => call.method === "groqTranscription").length;
		serveNoKeyBatch = true;
		await new Promise((resolve) => setTimeout(resolve, 80));
		const noKeyEvent = store.peekPending(20).find((event) => (event.payload as { messageId?: string })?.messageId === "11");
		check("a voice note without a key is still delivered", noKeyEvent !== undefined, store.peekPending(20).map((event) => event.title));
		check("the event explains how to enable transcription", noKeyEvent?.text.includes("set GROQ_API_KEY in the host environment") === true, noKeyEvent?.text);
		check("no transcription request is sent without a key", calls.filter((call) => call.method === "groqTranscription").length === groqCallsBefore);
		check("unconfigured history stays free of configuration hints", history.query({ thread: "telegram:42" }).every((record) => !record.text.includes("GROQ_API_KEY")));

		const status = telegram.status();
		check("module status reports the bot", (status.bot as { username?: string })?.username === "alive_bot", status);
		check("module status counts accepted inbound messages", (status.counters as { inbound?: number })?.inbound === 10, status.counters);
		check("module status reports missing transcription credentials", (status.transcription as { configured?: boolean })?.configured === false, status.transcription);

		await host.stop();
	} finally {
		globalThis.fetch = realFetch;
		if (previousGroqKey === undefined) delete process.env.GROQ_API_KEY;
		else process.env.GROQ_API_KEY = previousGroqKey;
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
section("telegram outbound attachments: send_message delivers a workspace file");
{
	const moduleRoot = fs.mkdtempSync(path.join(os.tmpdir(), "alive-telegram-attachment-test-"));
	const log = new Logger({ console: false, level: "error", scope: "telegram-attachment-test" });
	const store = EventStore.open(moduleRoot);
	const history = HistoryStore.open(moduleRoot);
	const outbox = new Outbox(moduleRoot);
	const calls: Array<{ method: string; params: Record<string, unknown>; form?: Record<string, unknown> }> = [];

	const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
		const url = String(input);
		const method = url.slice(url.lastIndexOf("/") + 1);
		const isForm = init?.body instanceof FormData;
		const form = isForm
			? Object.fromEntries(
					[...(init!.body as FormData).entries()].map(([key, value]) => [
						key,
						typeof value === "string" ? value : { name: value.name, type: value.type, size: value.size },
					]),
			  )
			: undefined;
		const params = isForm
			? { __multipart: [...(init!.body as FormData).keys()] }
			: init?.body
				? (JSON.parse(String(init.body)) as Record<string, unknown>)
				: {};
		calls.push({ method, params, form });
		if (method === "getMe") return jsonResponse({ ok: true, result: { id: 999, is_bot: true, first_name: "Alive", username: "alive_bot" } });
		if (method === "deleteWebhook") return jsonResponse({ ok: true, result: true });
		if (method === "getUpdates") {
			// Long-poll stand-in: stay pending until the module aborts. Answering
			// immediately would spin the poll loop on microtasks and starve the
			// test's own timers, so nothing after host.init() would ever run.
			return new Promise<Response>((_resolve, reject) => {
				const signal = init?.signal;
				if (!signal) return reject(new Error("getUpdates: missing abort signal"));
				const fail = () => reject(signal.reason instanceof Error ? signal.reason : new Error("getUpdates aborted"));
				if (signal.aborted) return fail();
				signal.addEventListener("abort", fail, { once: true });
			});
		}
		if (method === "sendChatAction") return jsonResponse({ ok: true, result: true });
		if (method === "sendPhoto") {
			const id = 810 + calls.filter((call) => call.method === "sendPhoto").length;
			return jsonResponse({ ok: true, result: { message_id: id, date: 1, chat: { id: 42, type: "private" } } });
		}
		if (method === "sendDocument") {
			const id = 830 + calls.filter((call) => call.method === "sendDocument").length;
			return jsonResponse({ ok: true, result: { message_id: id, date: 1, chat: { id: 42, type: "private" } } });
		}
		if (method === "sendMessage") {
			const id = 800 + calls.filter((call) => call.method === "sendMessage").length;
			return jsonResponse({ ok: true, result: { message_id: id, date: 1, chat: { id: 42, type: "private" } } });
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
					allowedUserIds: ["7"],
					allowedBotIds: [],
					requireMentionInGroups: false,
					pollTimeoutSec: 0,
					allowedUpdates: ["message"],
					parseMode: "",
					linkPreview: true,
					typingIndicator: true,
					ackReaction: "",
					ingestEdits: true,
					historyLimitPerThread: 0,
					maxMessageChars: 4096,
					transcription: { ...DEFAULT_CONFIG.modules.telegram.transcription },
				},
				grafana: { enabled: false, host: "127.0.0.1", port: 0, path: "/grafana", token: "", firingPriority: "high", resolvedPriority: "low" },
				external: [],
			},
		},
	});

	const workspace = config.paths.workspaceDir;
	fs.mkdirSync(workspace, { recursive: true });
	const photoBytes = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3, 4]);
	fs.writeFileSync(path.join(workspace, "shot.png"), photoBytes);
	fs.writeFileSync(path.join(workspace, "report.pdf"), buildPdf([["Attachment report"]]));

	const telegram = new TelegramModule(config.config.modules.telegram);
	const realFetch = globalThis.fetch;
	globalThis.fetch = fetchImpl;
	// Stop the module even if an expectation throws: its long-poll loop would
	// otherwise keep the process alive and turn a failed check into a hang.
	let started: ModuleHost | undefined;
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
			workspaceFiles: {
				rootDir: workspace,
				readFile: async (file) => fs.readFileSync(file),
				writeFile: async (file, data) => {
					fs.mkdirSync(path.dirname(file), { recursive: true });
					fs.writeFileSync(file, data);
					return file;
				},
			},
		});
		started = host;
		await host.init();
		await new Promise((resolve) => setTimeout(resolve, 60));
		calls.length = 0;

		const deliver = (message: Omit<OutgoingMessage, "runId" | "ts">) => host.deliver({ runId: "run", ts: Date.now(), ...message } as OutgoingMessage);
		const lastCall = (method: string) => calls.filter((call) => call.method === method).pop();

		// Image attachment: the kind is inferred from the mime type.
		await deliver({ id: "att_photo", thread: "telegram:42", text: "Look at this", attachments: [{ path: "shot.png" }] });
		const photoForm = lastCall("sendPhoto")?.form;
		const photoFile = photoForm?.photo as { name?: string; type?: string; size?: number } | undefined;
		check("an image attachment is uploaded with sendPhoto", lastCall("sendPhoto") !== undefined && lastCall("sendMessage") === undefined, calls.map((call) => call.method));
		check("the photo upload carries the message text as caption", photoForm?.caption === "Look at this", photoForm);
		check("the photo upload sends the workspace file", photoFile?.name === "shot.png" && photoFile?.type === "image/png" && photoFile?.size === photoBytes.length, photoFile);
		check("the photo upload keeps the chat routing", photoForm?.chat_id === "42", photoForm);
		const photoRecord = history.query({ thread: "telegram:42", direction: "outbound" }).find((record) => record.meta?.agentMessageId === "att_photo");
		check("history records the outbound caption", photoRecord?.text === "Look at this", photoRecord?.text);
		check("history records the attachment kind", photoRecord?.attachments?.[0]?.kind === "photo", photoRecord?.attachments);
		check("history records the attachment path", photoRecord?.attachments?.[0]?.meta?.path === "shot.png", photoRecord?.attachments);
		check("history records the attachment size", photoRecord?.attachments?.[0]?.size === photoBytes.length, photoRecord?.attachments);

		// A caption longer than 1024 characters spills into a normal follow-up message.
		const longText = "a".repeat(1500);
		const beforeLong = calls.length;
		await deliver({ id: "att_long", thread: "telegram:42", text: longText, attachments: [{ path: "shot.png", kind: "photo" }] });
		const longCalls = calls.slice(beforeLong);
		const longCaption = longCalls.find((call) => call.method === "sendPhoto")?.form?.caption as string | undefined;
		const followUp = longCalls.find((call) => call.method === "sendMessage");
		check("a long caption is truncated to the 1024-character limit", longCaption?.length === 1024, longCaption?.length);
		check("the caption remainder is sent as a follow-up text message", followUp?.params.text === longText.slice(1024), followUp?.params);
		check("the follow-up keeps the chat and thread", followUp?.params.chat_id === "42" && followUp?.params.message_thread_id === undefined, followUp?.params);

		// Non-image files (and a forced kind) go out as documents.
		await deliver({ id: "att_doc", thread: "telegram:42", text: "Report attached", attachments: [{ path: "report.pdf" }] });
		const docForm = lastCall("sendDocument")?.form;
		check("a non-image attachment is uploaded with sendDocument", (docForm?.document as { name?: string })?.name === "report.pdf", docForm);
		check("the document upload carries the mime type and caption", (docForm?.document as { type?: string })?.type === "application/pdf" && docForm?.caption === "Report attached", docForm);
		const docRecord = history.query({ thread: "telegram:42", direction: "outbound" }).find((record) => record.meta?.agentMessageId === "att_doc");
		check("history records the document attachment", docRecord?.attachments?.[0]?.kind === "document" && docRecord?.attachments?.[0]?.meta?.path === "report.pdf", docRecord?.attachments);

		await deliver({ id: "att_forced", thread: "telegram:42", text: "As a file", attachments: [{ path: "shot.png", kind: "document" }] });
		check("attachment_kind=document sends an image as a file", (lastCall("sendDocument")?.form?.document as { name?: string })?.name === "shot.png", lastCall("sendDocument")?.form);

		// Topic and reply routing survive an attachment.
		await deliver({ id: "att_topic", thread: "telegram:42/7", replyTo: "1005", text: "In the topic", attachments: [{ path: "shot.png", kind: "photo" }] });
		const topicForm = lastCall("sendPhoto")?.form;
		check("an attachment keeps topic routing", topicForm?.message_thread_id === "7", topicForm);
		check("an attachment keeps the explicit reply target", topicForm?.reply_to_message_id === "1005", topicForm);

		// Rejections happen before any Bot API call.
		const callsBeforeRejections = calls.length;
		const rejected = async (attachment: Record<string, unknown>, message = "See file") => {
			try {
				await deliver({ id: `att_${Math.random().toString(36).slice(2)}`, thread: "telegram:42", text: message, attachments: [attachment as never] });
				return undefined;
			} catch (err) {
				return err instanceof Error ? err : new Error(String(err));
			}
		};

		const escaped = await rejected({ path: "../../../../etc/passwd" });
		check("an attachment path that climbs out of the workspace is rejected", escaped !== undefined && /must not contain '\.\.'|outside the workspace/.test(escaped.message), escaped?.message);
		const absolute = await rejected({ path: "/etc/passwd" });
		check("an absolute attachment path is rejected", absolute !== undefined && /must be relative to the workspace/.test(absolute.message), absolute?.message);
		const missing = await rejected({ path: "does-not-exist.png" });
		check("a missing attachment is rejected clearly", missing !== undefined && /attachment not found in the workspace: does-not-exist\.png/.test(missing.message), missing?.message);
		const link = path.join(workspace, "passwd-link.txt");
		try {
			fs.symlinkSync("/etc/passwd", link);
		} catch {
			// symlinks unavailable: the escape test above still covers containment
		}
		if (fs.existsSync(link)) {
			const symlinkEscape = await rejected({ path: "passwd-link.txt" });
			check("a symlink pointing outside the workspace is rejected", symlinkEscape !== undefined && /outside the workspace/.test(symlinkEscape.message), symlinkEscape?.message);
		}
		const huge = Buffer.alloc(OUTBOUND_PHOTO_MAX_BYTES + 1);
		fs.writeFileSync(path.join(workspace, "huge.png"), huge);
		const oversize = await rejected({ path: "huge.png" });
		check("an oversize photo is rejected with the limit and a way out", oversize !== undefined && /photo limit/.test(oversize.message) && /attachment_kind="document"/.test(oversize.message), oversize?.message);
		check("no API call is made for a rejected attachment", calls.length === callsBeforeRejections, calls.slice(callsBeforeRejections).map((call) => call.method));
		check(
			"an oversize document is rejected with the document limit",
			(() => {
				try {
					assertAttachmentSize("document", OUTBOUND_DOCUMENT_MAX_BYTES + 1, "big.zip");
					return false;
				} catch (err) {
					return /document limit/.test((err as Error).message);
				}
			})(),
		);

		// The tool-level validator (what `send_message` calls before writing the outbox).
		const inferred = resolveOutgoingAttachment(workspace, "shot.png");
		check("the tool validator infers photo from the mime type", inferred.kind === "photo" && inferred.path === "shot.png" && inferred.size === photoBytes.length, inferred);
		const forcedDocument = resolveOutgoingAttachment(workspace, "shot.png", "document");
		check("the tool validator honours attachment_kind", forcedDocument.kind === "document", forcedDocument);
		const deferred = resolveOutgoingAttachment(workspace, "guest-only.png", undefined, { deferHostChecks: true });
		check("a sandbox workspace defers the existence check to delivery", deferred.path === "guest-only.png" && deferred.kind === "photo", deferred);
		check(
			"the tool validator rejects a missing file when the workspace is host-visible",
			(() => {
				try {
					resolveOutgoingAttachment(workspace, "guest-only.png");
					return false;
				} catch (err) {
					return /attachment not found/.test((err as Error).message);
				}
			})(),
		);
		check(
			"the tool validator rejects paths outside the workspace",
			(() => {
				try {
					resolveOutgoingAttachment(workspace, "../outside.png");
					return false;
				} catch (err) {
					return /must not contain '\.\.'/.test((err as Error).message);
				}
			})(),
		);

		// Regression: a text-only message is byte-for-byte the old behaviour.
		const beforeText = calls.length;
		await deliver({ id: "att_text", thread: "telegram:42", text: "plain text only" });
		const textCalls = calls.slice(beforeText);
		check(
			"a text-only message still goes through sendMessage only",
			textCalls.length === 1 && textCalls[0]?.method === "sendMessage" && textCalls[0]?.params.text === "plain text only",
			textCalls,
		);
		const textRecord = history.query({ thread: "telegram:42", direction: "outbound" }).find((record) => record.meta?.agentMessageId === "att_text");
		check("a text-only message has no attachment record", textRecord !== undefined && textRecord.attachments === undefined, textRecord);
	} finally {
		await started?.stop();
		globalThis.fetch = realFetch;
	}
}

// ---------------------------------------------------------------------------
section("telegram pdf_text tool: downloaded PDFs, paging and path safety");
{
	const moduleRoot = fs.mkdtempSync(path.join(os.tmpdir(), "alive-telegram-pdf-tool-test-"));
	const workspace = path.join(moduleRoot, "workspace");
	fs.mkdirSync(workspace, { recursive: true });
	const history = HistoryStore.open(moduleRoot);
	const calls: Array<{ method: string; params: Record<string, unknown> }> = [];
	const pdfBytes = buildPdf([
		[
			"Quarterly report",
			"Revenue grew 12 percent",
			...Array.from({ length: 8 }, (_, index) => `Line ${index + 1}: ${"x".repeat(40)}`),
		],
	]);

	const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
		const url = String(input);
		const method = url.includes("/file/bot") ? "file" : url.slice(url.lastIndexOf("/") + 1);
		const params = init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : {};
		calls.push({ method, params: { ...params, url } });
		if (method === "file") return new Response(pdfBytes, { status: 200, headers: { "content-type": "application/pdf" } });
		if (method === "getFile") {
			return jsonResponse({
				ok: true,
				result: { file_id: "pdf-tool", file_unique_id: "pdf-tool-unique", file_path: "report.pdf", file_size: pdfBytes.length },
			});
		}
		return jsonResponse({ ok: true, result: true });
	}) as unknown as typeof fetch;

	const api = new TelegramApi({ token: "tok", fetchImpl });
	const tool = createTelegramTools({
		api,
		history,
		workspaceDir: workspace,
		defaultParseMode: "",
		maxMessageChars: 4096,
		sendText: async () => {
			throw new Error("pdf_text tests must not send messages");
		},
		sendFile: async () => {
			throw new Error("pdf_text tests must not upload files");
		},
		upsertChat: () => undefined,
		typing: () => undefined,
		botIdentity: () => ({}),
		snapshot: () => ({}),
	}).find((entry) => entry.name === "telegram")!;
	const run = (params: Record<string, unknown>) =>
		tool.execute("call", params as never, undefined, undefined, {} as never) as Promise<{
			content: Array<{ text: string }>;
			details: Record<string, unknown>;
		}>;

	const download = await run({ action: "download_file", file_id: "pdf-tool", name: "report.pdf" });
	const pdfPath = String(download.details.path ?? "");
	check(
		"download_file saves the PDF into telegram-files",
		pdfPath.includes(`${path.sep}telegram-files${path.sep}`) && fs.existsSync(pdfPath),
		pdfPath,
	);

	const callsBeforeText = calls.length;
	const first = await run({ action: "pdf_text", path: pdfPath, limit: 120 });
	const firstText = first.content[0]!.text;
	check(
		"pdf_text returns text from the downloaded PDF",
		firstText.includes("Quarterly report") && firstText.includes("Revenue grew 12 percent"),
		firstText,
	);
	check(
		"pdf_text header carries pages, totalChars, offset and nextOffset",
		/pages=1/.test(firstText) &&
			/totalChars=\d+/.test(firstText) &&
			/offset=0/.test(firstText) &&
			/nextOffset=\d+/.test(firstText),
		firstText,
	);
	check(
		"pdf_text details expose paging metadata",
		first.details.pages === 1 &&
			typeof first.details.totalChars === "number" &&
			first.details.totalChars > 120 &&
			first.details.offset === 0 &&
			typeof first.details.nextOffset === "number",
		first.details,
	);
	check("pdf_text makes no network calls", calls.length === callsBeforeText, calls.slice(callsBeforeText));

	const nextOffset = first.details.nextOffset as number;
	const second = await run({ action: "pdf_text", path: pdfPath, offset: nextOffset, limit: 120 });
	const secondText = second.content[0]!.text;
	check(
		"offset pages through the PDF without repeating the first slice",
		second.details.offset === nextOffset && secondText !== firstText && secondText.includes(`offset=${nextOffset}`),
		secondText,
	);

	const beyond = await run({ action: "pdf_text", path: pdfPath, offset: 1_000_000 });
	check(
		"an offset beyond the extracted text is reported plainly",
		/beyond the end/.test(beyond.content[0]!.text) && beyond.content[0]!.text.includes("1000000"),
		beyond.content[0]!.text,
	);

	const downloadDir = path.join(workspace, "telegram-files");
	const outsidePdf = path.join(workspace, "outside.pdf");
	fs.writeFileSync(outsidePdf, pdfBytes);
	let outsideError: unknown;
	try {
		await run({ action: "pdf_text", path: outsidePdf });
	} catch (err) {
		outsideError = err;
	}
	check(
		"pdf_text rejects paths outside the download directory",
		outsideError instanceof Error && /only read files in/.test(outsideError.message),
		outsideError instanceof Error ? outsideError.message : outsideError,
	);

	const escapeLink = path.join(downloadDir, "escape.pdf");
	fs.symlinkSync(outsidePdf, escapeLink);
	let escapeError: unknown;
	try {
		await run({ action: "pdf_text", path: escapeLink });
	} catch (err) {
		escapeError = err;
	}
	check(
		"pdf_text resolves symlinks before reading",
		escapeError instanceof Error && /can only read files inside/.test(escapeError.message),
		escapeError instanceof Error ? escapeError.message : escapeError,
	);

	const textPath = path.join(downloadDir, "notes.txt");
	fs.writeFileSync(textPath, "plain text");
	let nonPdfError: unknown;
	try {
		await run({ action: "pdf_text", path: textPath });
	} catch (err) {
		nonPdfError = err;
	}
	check(
		"pdf_text rejects non-PDF files",
		nonPdfError instanceof Error && /only accepts \.pdf files/.test(nonPdfError.message),
		nonPdfError instanceof Error ? nonPdfError.message : nonPdfError,
	);

	let fileIdError: unknown;
	try {
		await run({ action: "pdf_text", file_id: "pdf-tool" });
	} catch (err) {
		fileIdError = err;
	}
	check(
		"pdf_text never accepts a Telegram file_id",
		fileIdError instanceof Error && /not accepted by pdf_text/.test(fileIdError.message),
		fileIdError instanceof Error ? fileIdError.message : fileIdError,
	);
	check("rejected pdf_text calls make no network calls", calls.length === callsBeforeText, calls.slice(callsBeforeText));
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
					allowedBotIds: [],
					requireMentionInGroups: false,
					pollTimeoutSec: 0,
					allowedUpdates: ["message"],
					parseMode: "",
					linkPreview: true,
					typingIndicator: false,
					ackReaction: "",
					ingestEdits: true,
					historyLimitPerThread: 0,
					maxMessageChars: 4096,
					transcription: { ...DEFAULT_CONFIG.modules.telegram.transcription },
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
	check("allowed bot IDs default to an empty allowlist", config.config.modules.telegram.allowedBotIds.length === 0, config.config.modules.telegram.allowedBotIds);
	check("requireMentionInGroups defaults off", config.config.modules.telegram.requireMentionInGroups === false, config.config.modules.telegram.requireMentionInGroups);
	const mergedTranscription = config.config.modules.telegram.transcription;
	check(
		"voice transcription defaults to the Groq Whisper config",
		mergedTranscription.enabled === true &&
			mergedTranscription.apiKeyEnv === "GROQ_API_KEY" &&
			mergedTranscription.model === GROQ_TRANSCRIPTION_MODEL &&
			mergedTranscription.maxBytes === TELEGRAM_VOICE_MAX_BYTES &&
			mergedTranscription.timeoutMs > 0,
		mergedTranscription,
	);

	const transcriptionOverride = loadConfig({
		cwd: configRoot,
		overrides: { modules: { telegram: { transcription: { enabled: false, apiKeyEnv: "MY_STT_KEY" } } } as never },
	});
	check(
		"transcription settings merge field by field",
		transcriptionOverride.config.modules.telegram.transcription.enabled === false &&
			transcriptionOverride.config.modules.telegram.transcription.apiKeyEnv === "MY_STT_KEY" &&
			transcriptionOverride.config.modules.telegram.transcription.model === GROQ_TRANSCRIPTION_MODEL,
		transcriptionOverride.config.modules.telegram.transcription,
	);
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
