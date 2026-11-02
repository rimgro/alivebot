import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as http from "node:http";
import * as os from "node:os";
import * as path from "node:path";
import type { BrowserContext } from "playwright";
import { loadConfig } from "../config.js";
import { ModuleHost } from "../events/host.js";
import { Logger } from "../log.js";
import { BrowserRouter, LOCAL_THREAD_ACTIONS, isLocalAgentThread } from "../modules/browser/router.js";
import { writePrivateJson } from "../modules/browser/operator.js";
import { EventStore } from "../store/events.js";
import { HistoryStore } from "../store/history.js";
import { TelegramAllowlistStore } from "../modules/telegram/state.js";
import { createAliveTools, type ToolDeps } from "../runtime/tools.js";

/**
 * Issue #150: a managed agent in a local thread needs a headless browser.
 *
 * The local thread is a real conversation from `agent-messaging.ts`, so it has
 * no Telegram chat. Headless actions must work, sharing must be refused without
 * leaving a controller behind, two local threads must stay isolated, and the
 * Telegram routing rules must not change.
 */

const root = fs.mkdtempSync(path.join(os.tmpdir(), "alive-browser-local-"));
const sent: Array<{ chat_id: string; text: string }> = [];
const apiCalls: string[] = [];
const api = http.createServer((request, response) => {
	let body = ""; request.on("data", part => body += part); request.on("end", () => {
		const method = request.url!.split("/").at(-1)!; const params = JSON.parse(body || "{}");
		apiCalls.push(method);
		let result: unknown = { id: Number(params.chat_id), type: "private" };
		if (method === "sendMessage") { sent.push(params); result = { message_id: sent.length, chat: { id: Number(params.chat_id), type: "private" } }; }
		if (method === "editMessageText") result = { message_id: params.message_id };
		response.writeHead(200, { "Content-Type": "application/json" }); response.end(JSON.stringify({ ok: true, result }));
	});
});
await new Promise<void>(resolve => api.listen(0, "127.0.0.1", resolve));
const initial = loadConfig({ cwd: root });
const loaded = loadConfig({ cwd: root, overrides: { modules: { ...initial.config.modules, telegram: { ...initial.config.modules.telegram, enabled: true, token: "fixture-only", tokenEnv: "UNSET_FIXTURE_LOCAL_TOKEN", apiBase: `http://127.0.0.1:${(api.address() as { port: number }).port}`, allowedUserIds: ["111"], allowedChatIds: [] } } } });
writePrivateJson(path.join(root, "alive.config.local.json"), { modules: { browser: { publicUrl: "https://phone.test" } } });
new TelegramAllowlistStore(path.join(loaded.paths.modulesDir, "telegram")).add("222");
// A globally paired operator is exactly the wrong recipient for a local thread.
writePrivateJson(path.join(loaded.paths.modulesDir, "browser", "operator.json"), { chatId: "999", userId: "999", pairedAt: Date.now() });

interface Storage { visits: string[]; cookies: string[] }
const profiles: string[] = [];
const storages = new Map<string, Storage>();
const challengeSessions = new Set<string>();
const sessionId = (thread: string) => createHash("sha256").update(thread).digest("hex").slice(0, 24);

/** One locator handle: most selectors are absent, a challenge iframe is present only when armed. */
function fixtureLocator(name: string, selector: string, storage: Storage) {
	const challenged = () => challengeSessions.has(name);
	const handle: Record<string, any> = {
		count: async () => challenged() && (selector === 'iframe[src*="recaptcha"]' || selector === "#challenge-form") ? 1 : 0,
		first: () => handle,
		nth: () => handle,
		isVisible: async () => true,
		isEditable: async () => true,
		inputValue: async () => "",
		scrollIntoViewIfNeeded: async () => {},
		boundingBox: async () => ({ x: 0, y: 0, width: 10, height: 10 }),
		// The fixture page "writes a cookie" here; storage must stay per session.
		click: async () => { if (selector === "#set-cookie") storage.cookies.push(`cookie=${name}`); },
		fill: async () => {},
		press: async () => {},
		pressSequentially: async () => {},
		waitFor: async () => {},
		ariaSnapshot: async () => `- heading "fixture ${name}"`,
		evaluate: async () => `page ${name} visits=${storage.visits.join(",")} cookies=${storage.cookies.join(",")}`,
	};
	return handle;
}

function launchFixture(directory: string): BrowserContext {
	profiles.push(directory);
	const name = path.basename(path.dirname(directory));
	let storage = storages.get(name);
	if (!storage) { storage = { visits: [], cookies: [] }; storages.set(name, storage); }
	const current = storage;
	const page: EventEmitter & Record<string, any> = Object.assign(new EventEmitter(), {
		title: async () => "Fixture",
		url: () => current.visits.at(-1) ?? "https://fixture.test/",
		isClosed: () => false,
		frames: () => [page],
		locator: (selector: string) => fixtureLocator(name, selector, current),
		mouse: { up: async () => {}, move: async () => {}, wheel: async () => {} },
		keyboard: { press: async () => {} },
		screenshot: async () => Buffer.from(`fixture-screenshot:${name}`),
		goto: async (value: string) => { current.visits.push(value); },
		evaluate: async () => "fixture-agent",
		bringToFront: async () => {},
		setViewportSize: async () => {},
	});
	const context: EventEmitter & Record<string, any> = Object.assign(new EventEmitter(), {
		pages: () => [page],
		browser: () => undefined,
		setDefaultTimeout: () => {},
		close: async () => { context.emit("close"); },
		request: { get: async (url: string) => ({ status: () => 200, headers: () => ({ "content-type": "application/json" }), text: async () => JSON.stringify({ session: name, url, cookies: current.cookies }), dispose: async () => {} }) },
	});
	page.context = () => context;
	return context as unknown as BrowserContext;
}

function filesUnder(directory: string): string[] {
	if (!fs.existsSync(directory)) return [];
	const found: string[] = [];
	const walk = (current: string) => {
		for (const entry of fs.readdirSync(current, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
			const full = path.join(current, entry.name);
			found.push(path.relative(directory, full));
			if (entry.isDirectory()) walk(full);
		}
	};
	walk(directory);
	return found;
}

let scope: string[] = [];
// notifyChatId is the console/alert destination: a local thread must never fall back to it.
const router = new BrowserRouter({ port: 0, publicUrl: "https://phone.test", notifyChatId: "999", minActionIntervalMs: 0, minNavigationIntervalMs: 0, humanization: { enabled: false, minDelayMs: 0, maxDelayMs: 0, minTypingDelayMs: 0, maxTypingDelayMs: 0 } }, { launch: async directory => launchFixture(directory) });
const events = EventStore.open(loaded.paths.stateDir);
const host = new ModuleHost({ config: loaded, log: new Logger({ console: false, level: "error" }), modules: [router], transports: [], ingest: input => events.append(input), outbox: () => [], history: HistoryStore.open(loaded.paths.stateDir), runtimeStatus: () => ({}), currentThreads: () => scope });
const ROUTING_REJECTION = /outside the current trusted conversation batch|no human recipient|headless browser actions only/;
const rejectedByRouter = (result: { details: Record<string, unknown> }) => Boolean(result.details.error && ROUTING_REJECTION.test(String(result.details.error)));
const sessions = () => router.status().sessions as Array<Record<string, unknown>>;
let plainHost: ModuleHost | undefined;
try {
	await host.init();
	const browserTool = host.contributedTools().find(tool => tool.name === "browser")!;
	const shareTool = host.contributedTools().find(tool => tool.name === "browser_share");
	assert.ok(browserTool && shareTool, "the router contributes both browser tools");
	assert.equal(createAliveTools({ config: loaded, moduleTools: host.contributedTools(), log: new Logger({ console: false }) } as ToolDeps).filter(tool => tool.name === "browser").length, 1, "the routed browser replaces the fallback without duplicating its name");

	// The local thread shapes produced by agent-messaging.ts, and nothing else.
	const writer = "local:agent:writer:agent:main";
	const reader = "local:agent:researcher:operator";
	const idle = "local:agent:main:agent:writer";
	const challenged = "local:agent:main:agent:researcher";
	for (const thread of [writer, reader, idle, challenged, "local:agent:main"]) assert.equal(isLocalAgentThread(thread), true, `${thread} is a local agent thread`);
	for (const thread of ["telegram:111", "console", "local:someone", "local:agent:Bad Id", "local:agent:writer:agent:"]) assert.equal(isLocalAgentThread(thread), false, `${thread} is not a local agent thread`);
	assert.equal(LOCAL_THREAD_ACTIONS.has("handoff"), false, "sharing is never a headless local action");

	// 1. Headless actions run through the real tool path for a local thread.
	scope = [writer, reader];
	const firstNavigate = await browserTool.execute("nav-a", { action: "navigate", thread: writer, url: "https://alpha.test/one" } as never, undefined, undefined, {} as never) as { details: Record<string, unknown> };
	assert.equal(firstNavigate.details.thread, writer);
	const secondNavigate = await browserTool.execute("nav-b", { action: "navigate", thread: reader, url: "https://beta.test/two" } as never, undefined, undefined, {} as never) as { details: Record<string, unknown> };
	assert.equal(secondNavigate.details.thread, reader);
	const firstRead = await browserTool.execute("read-a", { action: "read", thread: writer } as never, undefined, undefined, {} as never) as { details: Record<string, unknown> };
	assert.match(String(firstRead.details.text), new RegExp(`page ${sessionId(writer)}`), "read returns this thread's page");
	const headless: Array<{ action: string; params?: Record<string, unknown> }> = [
		{ action: "status" },
		{ action: "tabs" },
		{ action: "snapshot" },
		{ action: "wait", params: { selector: "#ready" } },
		{ action: "screenshot" },
		{ action: "click", params: { selector: "#set-cookie" } },
		{ action: "fill", params: { selector: "#query", text: "hello" } },
		{ action: "press", params: { key: "Enter" } },
		{ action: "scroll", params: { delta: 400 } },
		{ action: "request", params: { url: "https://alpha.test/api" } },
		{ action: "reclaim" },
	];
	for (const { action, params } of headless) {
		const result = await router.command({ action, thread: writer, ...params });
		assert.equal(rejectedByRouter(result), false, `${action} is allowed for a local thread: ${String(result.details.error)}`);
		assert.equal(result.isError, undefined, `${action} did not fail: ${String(result.details.error)}`);
	}
	const tabs = await router.command({ action: "tabs", thread: writer });
	const tab = (tabs.details.tabs as Array<{ id: string }>)[0];
	const switched = await router.command({ action: "switch_tab", thread: writer, tab: tab.id });
	assert.equal(rejectedByRouter(switched), false); assert.equal(switched.isError, undefined, String(switched.details.error));
	// download is permitted by the routing guard (the module then validates its own url).
	const download = await router.command({ action: "download", thread: writer });
	assert.equal(rejectedByRouter(download), false, "download is not rejected by the local-thread guard");
	assert.match(String(download.details.error), /url is required/);

	// 2. Two local threads keep separate sessions, pages and storage.
	assert.notEqual(sessionId(writer), sessionId(reader));
	assert.notEqual(sessionId(writer), sessionId(idle));
	const profileOf = (thread: string) => path.join(loaded.paths.modulesDir, "browser", "sessions", sessionId(thread), "profile");
	assert.ok(profiles.includes(profileOf(writer)), "the writer thread owns its own profile directory");
	assert.ok(profiles.includes(profileOf(reader)), "the reader thread owns its own profile directory");
	assert.notEqual(profileOf(writer), profileOf(reader));
	assert.deepEqual(storages.get(sessionId(writer))!.visits, ["https://alpha.test/one"], "the writer session only visited its own page");
	assert.deepEqual(storages.get(sessionId(reader))!.visits, ["https://beta.test/two"], "the reader session only visited its own page");
	assert.equal(storages.get(sessionId(writer))!.cookies.length, 1, "the writer page stored its cookie");
	assert.equal(storages.get(sessionId(reader))!.cookies.length, 0, "the writer page's cookie is not in the reader session");
	const secondRead = await router.command({ action: "read", thread: reader });
	assert.match(String(secondRead.details.text), /visits=https:\/\/beta\.test\/two/, "the reader reads its own page");
	assert.doesNotMatch(String(secondRead.details.text), new RegExp(sessionId(writer)), "the reader cannot see the writer's page");
	assert.doesNotMatch(String(secondRead.details.text), /alpha\.test/, "the reader cannot see the writer's visited url");
	const writerAgain = await router.command({ action: "read", thread: writer });
	assert.match(String(writerAgain.details.text), new RegExp(`page ${sessionId(writer)}`));
	assert.match(String(writerAgain.details.text), /cookies=cookie=/, "the writer storage persisted in its own session");
	const screenshotOf = async (thread: string): Promise<string> => {
		const result = await router.command({ action: "screenshot", thread });
		const image = result.content[0] as { type: string; data: string };
		assert.equal(image.type, "image");
		return Buffer.from(image.data, "base64").toString();
	};
	assert.match(await screenshotOf(writer), new RegExp(sessionId(writer)), "the writer screenshot comes from the writer page");
	assert.match(await screenshotOf(reader), new RegExp(sessionId(reader)), "the reader screenshot comes from the reader page");
	assert.doesNotMatch(await screenshotOf(writer), new RegExp(sessionId(reader)));
	assert.deepEqual(sessions().map(session => session.thread).sort(), [reader, writer].sort(), "both local sessions are live at once");

	// 3. Sharing is refused for a local thread before any session or handoff state exists.
	scope = [writer, reader, idle];
	const beforeFiles = filesUnder(loaded.paths.modulesDir), beforeEvents = events.all().length, beforeCalls = apiCalls.length;
	const handoff = await router.command({ action: "handoff", thread: idle, reason: "Manual check" });
	assert.equal(handoff.isError, true, "a local thread cannot share");
	assert.match(String(handoff.details.error), /requires a private Telegram conversation; this thread has no human recipient/);
	assert.doesNotMatch(String(handoff.details.error), /outside the current trusted conversation batch/);
	assert.equal(sessions().some(session => session.thread === idle), false, "a rejected local handoff allocates no session");
	assert.equal(apiCalls.length, beforeCalls, "a rejected local handoff sends no Telegram message");
	assert.deepEqual(filesUnder(loaded.paths.modulesDir), beforeFiles, "a rejected local handoff writes no state");
	assert.equal(events.all().length, beforeEvents, "a rejected local handoff wakes nobody");
	await assert.rejects(() => shareTool!.execute("share-local", { thread: idle, reason: "Manual check" } as never, undefined, undefined, {} as never), /no human recipient/, "browser_share reports the local rejection");
	assert.equal(sessions().some(session => session.thread === idle), false);
	const existing = await router.command({ action: "handoff", thread: writer, reason: "Manual check" });
	assert.equal(existing.isError, true);
	assert.match(String(existing.details.error), /no human recipient/);
	assert.equal(sessions().find(session => session.thread === writer)!.handoff, undefined, "no controller is attached to a live local session");
	assert.equal(apiCalls.length, beforeCalls, "an existing local session never notifies a chat");
	assert.deepEqual(filesUnder(loaded.paths.modulesDir), beforeFiles, "an existing local session leaves no handoff state");

	// 4. A local session with no chat degrades safely: no Telegram call, no controller.
	challengeSessions.add(sessionId(challenged));
	scope = [challenged];
	const callsBeforeChallenge = apiCalls.length;
	const challengedNavigate = await router.command({ action: "navigate", thread: challenged, url: "https://verify.test/" });
	assert.equal(challengedNavigate.isError, undefined, `a challenge must not crash a local session: ${String(challengedNavigate.details.error)}`);
	assert.equal(apiCalls.length, callsBeforeChallenge, "a local challenge must not message any Telegram chat");
	const localChallenge = sessions().find(session => session.thread === challenged)!;
	assert.equal(localChallenge.paused, true, "the local session records that the page needs help");
	assert.equal(localChallenge.handoff, undefined, "no controller exists for a thread with no human recipient");
	const paused = await router.command({ action: "read", thread: challenged });
	assert.match(String(paused.details.error), /no human recipient/, "paused local actions explain why no operator can help");
	await router.command({ action: "reclaim", thread: challenged });
	challengeSessions.delete(sessionId(challenged));
	const recovered = await router.command({ action: "navigate", thread: challenged, url: "https://verify.test/ok" });
	assert.equal(recovered.isError, undefined, String(recovered.details.error));
	assert.equal(recovered.details.paused, false, "reclaim plus navigate recovers without a human");

	// 5. Telegram routing is unchanged: allowlist, private chats only, and it still notifies.
	scope = ["telegram:111"];
	const telegramShare = await router.command({ action: "handoff", thread: "telegram:111", reason: "Manual assistance" });
	assert.equal(telegramShare.isError, undefined, String(telegramShare.details.error));
	assert.equal(telegramShare.details.notificationSent, true);
	assert.deepEqual(telegramShare.details.notification, { thread: "telegram:111", messageId: 1 });
	assert.equal(String(sent[0].chat_id), "111");
	scope = ["telegram:333"];
	const notAllowed = await router.command({ action: "navigate", thread: "telegram:333", url: "https://fixture.test/" });
	assert.match(String(notAllowed.details.error), /not permitted by Telegram allowlists/);
	scope = ["telegram:-100123"];
	const group = await router.command({ action: "navigate", thread: "telegram:-100123", url: "https://fixture.test/" });
	assert.match(String(group.details.error), /groups and topics are not supported/);
	assert.equal(sent.length, 1, "rejected Telegram threads send nothing");
	assert.deepEqual([...new Set(sent.map(message => String(message.chat_id)))], ["111"], "only the task's own private chat was ever messaged, never the alert chat or the paired operator");

	// 6. The trusted-batch scope still gates local threads; sharing stays out of it.
	scope = [writer];
	const outside = await router.command({ action: "navigate", thread: "local:agent:stranger:agent:main", url: "https://fixture.test/" });
	assert.match(String(outside.details.error), /outside the current trusted conversation batch/);
	assert.equal(sessions().some(session => session.thread === "local:agent:stranger:agent:main"), false);
	scope = ["console"];
	const consoleThread = await router.command({ action: "navigate", thread: "local:agent:main:agent:worker", url: "https://gamma.test/" });
	assert.equal(rejectedByRouter(consoleThread), false, "a console run keeps its existing thread escape");

	// 7. A local thread needs no Telegram configuration at all.
	const noTelegram = loadConfig({ cwd: root, overrides: { modules: { ...initial.config.modules, telegram: { ...initial.config.modules.telegram, enabled: false, allowedUserIds: [], allowedChatIds: [] } } } });
	const plainScope = ["local:agent:solo:operator"];
	const plainRouter = new BrowserRouter({ port: 0, minActionIntervalMs: 0, minNavigationIntervalMs: 0, humanization: { enabled: false, minDelayMs: 0, maxDelayMs: 0, minTypingDelayMs: 0, maxTypingDelayMs: 0 } }, { launch: async directory => launchFixture(directory) });
	plainHost = new ModuleHost({ config: noTelegram, log: new Logger({ console: false, level: "error" }), modules: [plainRouter], transports: [], ingest: input => events.append(input), outbox: () => [], history: HistoryStore.open(noTelegram.paths.stateDir), runtimeStatus: () => ({}), currentThreads: () => plainScope });
	await plainHost.init();
	const unconfigured = await plainRouter.command({ action: "navigate", thread: plainScope[0], url: "https://solo.test/" });
	assert.equal(unconfigured.isError, undefined, `local browser actions need no Telegram module: ${String(unconfigured.details.error)}`);
	const unconfiguredShare = await plainRouter.command({ action: "handoff", thread: plainScope[0], reason: "Manual check" });
	assert.match(String(unconfiguredShare.details.error), /no human recipient/, "sharing stays impossible without Telegram");
	await plainRouter.command({ action: "close", thread: plainScope[0] });
	await plainHost.stop(); plainHost = undefined;

	// Closing local sessions needs no controller and stays silent.
	const messages = sent.length;
	for (const thread of [writer, reader, challenged, "local:agent:main:agent:worker"]) {
		const closed = await router.command({ action: "close", thread });
		assert.equal(closed.details.credentialsRevoked, true);
	}
	assert.equal(sent.length, messages, "closing local sessions sends nothing");
	assert.deepEqual(sessions().map(session => session.thread), ["telegram:111"], "only the Telegram session remains");
	console.log("browser-router local: headless actions allowed without Telegram config, sharing refused with no dangling controller, local threads isolated, notifications silent, Telegram unchanged and scope enforced");
} finally {
	await plainHost?.stop(); await host.stop(); api.closeAllConnections(); await new Promise<void>(resolve => api.close(() => resolve())); fs.rmSync(root, { recursive: true, force: true });
}
