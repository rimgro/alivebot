/**
 * Markdown rendering for Telegram (#266) and the `send_message.format` plumbing.
 *
 *   npm run test:markdown
 *
 * Pure rendering/splitting tests plus one end-to-end pass through the module so
 * the HTML parse-mode fallback is exercised against a fake Bot API.
 */
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
import type { TelegramChat, TelegramUser } from "../modules/telegram/types.js";
import { displayWidth, htmlToPlainText, renderMarkdownToHtml, splitHtml } from "../modules/telegram/markdown.js";
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

const ALLOWED_TAGS = new Set(["b", "i", "s", "u", "code", "pre", "a", "blockquote", "tg-spoiler"]);

function tagsOf(html: string): string[] {
	return [...html.matchAll(/<\/?([a-zA-Z][a-zA-Z0-9-]*)/g)].map((match) => match[1].toLowerCase());
}

function onlyAllowedTags(html: string): boolean {
	return tagsOf(html).every((tag) => ALLOWED_TAGS.has(tag));
}

/** Well-formed enough for Telegram: no stray `<`/`>`, balanced non-void tags. */
function balancedTags(html: string): boolean {
	const text = html.replace(/<[^>]*>/g, "");
	if (text.includes("<") || text.includes(">")) return false;
	const stack: string[] = [];
	for (const token of html.match(/<\/?[a-zA-Z][^>]*>/g) ?? []) {
		const closing = token.startsWith("</");
		const name = /^<\/?([a-zA-Z][a-zA-Z0-9-]*)/.exec(token)?.[1]?.toLowerCase() ?? "";
		if (closing) {
			if (stack[stack.length - 1] !== name) return false;
			stack.pop();
		} else {
			stack.push(name);
		}
	}
	return stack.length === 0;
}

function hasDanglingEntity(html: string): boolean {
	return /&[a-zA-Z0-9#]*$/.test(html);
}

// ---------------------------------------------------------------------------
section("markdown: emphasis and CommonMark flanking");
{
	const rendered = renderMarkdownToHtml("**bold** __bold__ *italic* _italic_ ~~strike~~ ||spoiler||");
	check("bold with ** and __", rendered.includes("<b>bold</b>") && (rendered.match(/<b>bold<\/b>/g) ?? []).length === 2, rendered);
	check("italic with * and _", (rendered.match(/<i>italic<\/i>/g) ?? []).length === 2, rendered);
	check("strikethrough", rendered.includes("<s>strike</s>"), rendered);
	check("spoiler", rendered.includes("<tg-spoiler>spoiler</tg-spoiler>"), rendered);
	check("only Telegram's allowed tags are emitted", onlyAllowedTags(rendered), tagsOf(rendered));

	const snake = renderMarkdownToHtml("snake_case_name and SCREAMING_SNAKE_CASE");
	check("underscores inside words never become italic", !snake.includes("<i>") && snake === "snake_case_name and SCREAMING_SNAKE_CASE", snake);
	const intraword = renderMarkdownToHtml("foo*bar*baz");
	check("intraword asterisks stay literal", !intraword.includes("<i>") && !intraword.includes("<b>") && intraword === "foo*bar*baz", intraword);
	const nested = renderMarkdownToHtml("**bold *italic* end** and _a **b** c_");
	check(
		"emphasis nests",
		nested === "<b>bold <i>italic</i> end</b> and <i>a <b>b</b> c</i>",
		nested,
	);
	check("backslash escapes markdown punctuation", renderMarkdownToHtml("\\*not italic\\*") === "*not italic*");
}

// ---------------------------------------------------------------------------
section("markdown: blocks, code and escaping");
{
	const heading = renderMarkdownToHtml("### Heading **here**");
	check("headings become a bold line", heading === "<b>Heading <b>here</b></b>", heading);

	const list = renderMarkdownToHtml("- one\n  - nested\n  - nested two\n1. first\n2. second");
	check(
		"lists keep nesting and ordered markers",
		list === "• one\n  • nested\n  • nested two\n1. first\n2. second",
		list,
	);

	const quote = renderMarkdownToHtml("> quoted **text**\n> second line");
	check("blockquote keeps its content", quote === "<blockquote>quoted <b>text</b>\nsecond line</blockquote>", quote);

	const fenced = renderMarkdownToHtml("```ts\nconst x = 1 < 2 && **not bold**;\n```");
	check(
		"a fenced code block carries the language and does not parse markdown",
		fenced === `<pre><code class="language-ts">const x = 1 &lt; 2 &amp;&amp; **not bold**;</code></pre>`,
		fenced,
	);
	const noLanguage = renderMarkdownToHtml("```\nplain <code>\n```");
	check("a fenced block without a language still renders", noLanguage === "<pre><code>plain &lt;code&gt;</code></pre>", noLanguage);

	const inline = renderMarkdownToHtml("use `a < b && c` here");
	check("inline code is escaped and not parsed", inline === "use <code>a &lt; b &amp;&amp; c</code> here", inline);

	const raw = renderMarkdownToHtml("<script>alert(1)</script> <b>not a tag</b> &");
	check(
		"raw HTML in the source is escaped, never emitted as markup",
		raw === "&lt;script&gt;alert(1)&lt;/script&gt; &lt;b&gt;not a tag&lt;/b&gt; &amp;" && !tagsOf(raw).includes("script"),
		raw,
	);

	const links = renderMarkdownToHtml("[docs](https://example.com/a?x=1&y=2) and https://example.org/b.");
	check(
		"markdown links and bare URLs become <a href>",
		links ===
			`<a href="https://example.com/a?x=1&amp;y=2">docs</a> and <a href="https://example.org/b">https://example.org/b</a>.`,
		links,
	);
	const unsafe = renderMarkdownToHtml("[click](javascript:alert(1))");
	check("unsafe link schemes stay literal text", !unsafe.includes("<a ") && unsafe.includes("javascript:"), unsafe);
}

// ---------------------------------------------------------------------------
section("markdown: tables with display-width padding");
{
	const markdown = [
		"| Имя | Возраст | 漢字 |",
		"|:----|:-------:|-----:|",
		"| Аня | 30 | 東京 |",
		"| Bob | 7 | 😀 |",
		"| Евгений | 105 | 中 |",
	].join("\n");
	const html = renderMarkdownToHtml(markdown);
	const inner = html.replace(/^<pre><code>/, "").replace(/<\/code><\/pre>$/, "");
	const lines = inner.split("\n");
	check("a table is a <pre><code> block", html.startsWith("<pre><code>") && html.endsWith("</code></pre>"), html);
	check("a 3×3 table has a header, a separator and three rows", lines.length === 5, lines);
	const widths = lines.map(displayWidth);
	check(
		"all table rows have the same visible width (Cyrillic/CJK/emoji included)",
		widths.every((width) => width === widths[0]),
		{ widths, lines },
	);
	check("alignment markers are preserved in the separator", lines[1].includes(":") && lines[1].includes(":"), lines[1]);
	check("right-aligned numeric column is padded on the left", /\|\s+30\s+\|/.test(lines[2]) && /\|\s+7\s+\|/.test(lines[3]), [lines[2], lines[3]]);
	check("table content is escaped inside <pre>", renderMarkdownToHtml("| a |\n|---|\n| <x> |").includes("&lt;x&gt;"));
}

// ---------------------------------------------------------------------------
section("markdown: splitting rendered HTML");
{
	function assertSplit(name: string, markdown: string, limit = 4096): void {
		const html = renderMarkdownToHtml(markdown);
		const chunks = splitHtml(html, limit);
		check(`${name}: long enough to split`, html.length > limit && chunks.length >= 2, { html: html.length, chunks: chunks.length });
		check(`${name}: every chunk fits the limit`, chunks.every((chunk) => chunk.length <= limit), chunks.map((chunk) => chunk.length));
		check(`${name}: no tag or entity is cut`, chunks.every((chunk) => balancedTags(chunk) && !hasDanglingEntity(chunk)), chunks.map((chunk) => chunk.slice(-20)));
		check(`${name}: visible text survives exactly`, htmlToPlainText(chunks.join("")) === htmlToPlainText(html));
	}

	// `<b>` starts at index 4095: a naive slice at 4096 would end with "<".
	assertSplit("bold on the boundary", "x".repeat(4094) + " **bold** and the rest");
	// `<code>` starts at index 4091: a naive slice cuts through the opening tag.
	assertSplit("inline code on the boundary", "y".repeat(4090) + " `code here` tail");
	// `<a href="...">` starts at index 4086: a naive slice cuts the attribute.
	assertSplit("link on the boundary", "z".repeat(4085) + " [x](https://example.com/a/long/path) tail");

	const many = Array.from({ length: 900 }, (_, index) => `**line ${index}** with \`code ${index}\``).join("\n\n");
	assertSplit("many blocks", many);

	const bold = renderMarkdownToHtml("**" + "word ".repeat(1199) + "word**");
	const boldChunks = splitHtml(bold, 4096);
	check(
		"a bold run spanning the limit reopens in every chunk",
		boldChunks.length >= 2 && boldChunks.every((chunk) => chunk.startsWith("<b>") && chunk.endsWith("</b>")),
		boldChunks.map((chunk) => [chunk.slice(0, 4), chunk.slice(-5)]),
	);
	check("empty HTML yields no chunks", splitHtml("", 4096).length === 0);
}

// ---------------------------------------------------------------------------
section("send_message format and plain fallback");
{
	const moduleRoot = fs.mkdtempSync(path.join(os.tmpdir(), "alive-telegram-markdown-test-"));
	const logFile = path.join(moduleRoot, "test-log.jsonl");
	const log = new Logger({ console: false, level: "error", file: logFile, scope: "telegram-markdown-test" });
	const store = EventStore.open(moduleRoot);
	const history = HistoryStore.open(moduleRoot);
	const outbox = new Outbox(moduleRoot);
	const calls: Array<{ method: string; params: Record<string, unknown> }> = [];
	let sendSequence = 5000;

	const privateChat: TelegramChat = { id: 42, type: "private", first_name: "Alice", username: "alice" };
	const botUser: TelegramUser = { id: 999, is_bot: true, first_name: "Alive", username: "alive_bot" };

	const jsonResponse = (body: unknown, status = 200): Response =>
		new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

	const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
		const url = String(input);
		const method = url.slice(url.lastIndexOf("/") + 1);
		const params = init?.body && !(init.body instanceof FormData) ? (JSON.parse(String(init.body)) as Record<string, unknown>) : {};
		calls.push({ method, params });
		if (method === "getMe") return jsonResponse({ ok: true, result: { ...botUser, can_manage_bots: true } });
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
			const text = String(params.text ?? "");
			if (params.parse_mode === "HTML" && text.includes("BROKEN")) {
				return jsonResponse(
					{ ok: false, error_code: 400, description: "Bad Request: can't parse entities: unsupported start tag \"broken\"" },
					400,
				);
			}
			return jsonResponse({ ok: true, result: { message_id: sendSequence++, date: 1, chat: privateChat } });
		}
		if (method === "sendChatAction") return jsonResponse({ ok: true, result: true });
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
					token: "test-token",
					tokenEnv: "ALIVE_TEST_TELEGRAM_TOKEN_UNSET_MARKDOWN",
					allowedUserIds: ["7"],
					pollTimeoutSec: 0,
					parseMode: "",
				},
				grafana: { ...DEFAULT_CONFIG.modules.grafana, enabled: false },
				external: [],
			},
		},
	});
	const workspace = config.paths.workspaceDir;
	fs.mkdirSync(workspace, { recursive: true });
	fs.writeFileSync(path.join(moduleRoot, "SOUL.md"), "markdown test soul\n");
	fs.writeFileSync(path.join(moduleRoot, "CONTRACT.md"), "markdown test contract\n");

	const telegram = new TelegramModule(config.config.modules.telegram);
	const realFetch = globalThis.fetch;
	globalThis.fetch = fetchImpl;
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
		await new Promise((resolve) => setTimeout(resolve, 40));
		calls.length = 0;

		const event: AliveEvent = {
			seq: 1,
			id: "evt_markdown_1",
			ts: Date.now(),
			kind: "user_message",
			source: "test",
			priority: "normal",
			title: "event",
			text: "event",
			thread: "telegram:42",
			expectsReply: true,
		};
		const run = {
			id: "run_markdown",
			events: [event],
			outbound: [],
			currentThreads: ["telegram:42"],
		} as unknown as RunHandle;
		const deps = {
			config,
			history,
			outbox,
			threads: { recordOutbound: () => undefined },
			moduleTools: [],
			deliver: (message: OutgoingMessage) => host.deliver(message),
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
		const lastSend = () => calls.filter((call) => call.method === "sendMessage").at(-1);

		const beforeDefault = calls.length;
		await send({ thread: "telegram:42", text: "**literal**" });
		const defaultCall = lastSend();
		check(
			"without format the payload is unchanged (no render, configured parse mode)",
			calls.length - beforeDefault === 1 && defaultCall?.params.text === "**literal**" && defaultCall?.params.parse_mode === undefined,
			defaultCall?.params,
		);

		await send({ thread: "telegram:42", text: "**bold** and <b>raw</b>", format: "markdown" });
		const markdownCall = lastSend();
		check(
			"format=markdown renders to Telegram HTML and escapes raw tags",
			markdownCall?.params.parse_mode === "HTML" &&
				markdownCall?.params.text === "<b>bold</b> and &lt;b&gt;raw&lt;/b&gt;",
			markdownCall?.params,
		);

		const beforeLongMarkdown = calls.length;
		await send({ thread: "telegram:42", text: "**" + "word ".repeat(900) + "word**", format: "markdown" });
		const longCalls = calls.slice(beforeLongMarkdown).filter((call) => call.method === "sendMessage");
		check(
			"a rendered message over the limit is split after rendering into valid HTML chunks",
			longCalls.length >= 2 &&
				longCalls.every((call) => call.params.parse_mode === "HTML") &&
				longCalls.every((call) => {
					const text = String(call.params.text ?? "");
					return text.length <= 4000 && balancedTags(text) && text.startsWith("<b>") && text.endsWith("</b>");
				}),
			longCalls.map((call) => ({ length: String(call.params.text ?? "").length, head: String(call.params.text ?? "").slice(0, 6), tail: String(call.params.text ?? "").slice(-6) })),
		);

		await send({ thread: "telegram:42", text: "<b>as is</b>", format: "html" });
		const htmlCall = lastSend();
		check(
			"format=html sends the text untouched with parse_mode HTML",
			htmlCall?.params.parse_mode === "HTML" && htmlCall?.params.text === "<b>as is</b>",
			htmlCall?.params,
		);

		await send({ thread: "telegram:42", text: "**plain**", format: "plain" });
		const plainCall = lastSend();
		check(
			"format=plain sends no parse_mode",
			plainCall?.params.parse_mode === undefined && plainCall?.params.text === "**plain**",
			plainCall?.params,
		);

		const unknown = await send({ thread: "telegram:42", text: "**typo**", format: "bogus" });
		const unknownCall = lastSend();
		check(
			"an unknown format degrades to plain instead of failing",
			unknownCall?.params.parse_mode === undefined && unknownCall?.params.text === "**typo**" && unknown.details.format === "plain",
			{ params: unknownCall?.params, details: unknown.details },
		);

		const beforeFallback = calls.length;
		await send({ thread: "telegram:42", text: "**BROKEN**", format: "markdown" });
		const fallbackCalls = calls.slice(beforeFallback).filter((call) => call.method === "sendMessage");
		check(
			"a rejected markup is retried once as plain text",
			fallbackCalls.length === 2 &&
				fallbackCalls[0]?.params.parse_mode === "HTML" &&
				fallbackCalls[1]?.params.parse_mode === undefined &&
				fallbackCalls[1]?.params.text === "BROKEN",
			fallbackCalls.map((call) => call.params),
		);
		const warnings = readJsonl<{ level?: string; msg?: string; data?: { snippet?: string } }>(logFile).filter(
			(record) => record.level === "warn" && String(record.msg ?? "").includes("markup"),
		);
		check(
			"the fallback logs a warn naming the failing source snippet",
			warnings.length >= 1 && String(warnings.at(-1)?.data?.snippet ?? "").includes("BROKEN"),
			warnings.at(-1),
		);
	} finally {
		await started?.stop();
		globalThis.fetch = realFetch;
	}
}

process.stdout.write(failures === 0 ? "\nALL MARKDOWN TESTS PASSED\n" : `\n${failures} MARKDOWN TEST(S) FAILED\n`);
process.exitCode = failures === 0 ? 0 : 1;
