import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { createHmac } from "node:crypto";
import * as fs from "node:fs";
import * as http from "node:http";
import * as os from "node:os";
import * as path from "node:path";
import type { BrowserContext } from "playwright";
import { loadConfig } from "../config.js";
import { ModuleHost } from "../events/host.js";
import { Logger } from "../log.js";
import { BrowserRouter } from "../modules/browser/router.js";
import { writePrivateJson } from "../modules/browser/operator.js";
import { EventStore } from "../store/events.js";
import { HistoryStore } from "../store/history.js";
import { TelegramAllowlistStore } from "../modules/telegram/state.js";
import { createAliveTools, type ToolDeps } from "../runtime/tools.js";

const root = fs.mkdtempSync(path.join(os.tmpdir(), "alive-browser-routing-"));
const sent: Array<{ chat_id: string; reply_markup: { inline_keyboard: Array<Array<{ web_app: { url: string } }>> } }> = [];
const edited: Array<{ chat_id: string; message_id: number; text: string; reply_markup: { inline_keyboard: Array<Array<{ web_app: { url: string } }>> } }> = [];
const profiles: string[] = [];
let failDelivery = false, scope = ["telegram:111"];
let editFailure: "" | "limited" | "missing" = "";
const api = http.createServer((request, response) => {
	let body = ""; request.on("data", part => body += part); request.on("end", () => {
		const params = JSON.parse(body); const method = request.url!.split("/").at(-1);
		if (method === "sendMessage" && failDelivery) { response.writeHead(500); response.end(JSON.stringify({ ok: false, description: "Fixture delivery failure" })); return; }
		if (method === "editMessageText" && editFailure) { const missing = editFailure === "missing"; response.writeHead(missing ? 400 : 429); response.end(JSON.stringify({ ok: false, error_code: missing ? 400 : 429, description: missing ? "Bad Request: message to edit not found" : "Too Many Requests" })); return; }
		let result: unknown = { id: Number(params.chat_id), type: "private" };
		if (method === "sendMessage") { sent.push(params); result = { message_id: sent.length, chat: { id: Number(params.chat_id), type: "private" } }; }
		if (method === "editMessageText") { edited.push(params); result = { message_id: params.message_id }; }
		response.writeHead(200, { "Content-Type": "application/json" }); response.end(JSON.stringify({ ok: true, result }));
	});
});
await new Promise<void>(resolve => api.listen(0, "127.0.0.1", resolve));
const initial = loadConfig({ cwd: root });
const loaded = loadConfig({ cwd: root, overrides: { modules: { ...initial.config.modules, telegram: { ...initial.config.modules.telegram, enabled: true, token: "fixture-only", tokenEnv: "UNSET_FIXTURE_ROUTER_TOKEN", apiBase: `http://127.0.0.1:${(api.address() as { port: number }).port}`, allowedUserIds: ["111"], allowedChatIds: [] } } } });
writePrivateJson(path.join(root, "alive.config.local.json"), { modules: { browser: { publicUrl: "https://phone.test" } } });
let origin = "https://phone.test";
new TelegramAllowlistStore(path.join(loaded.paths.modulesDir, "telegram")).add("222");
writePrivateJson(path.join(loaded.paths.modulesDir, "browser", "operator.json"), { chatId: "999", userId: "999", pairedAt: Date.now() });
const pages: Array<EventEmitter & Record<string, any>> = [];
const router = new BrowserRouter({ port: 0, publicUrl: "https://phone.test", minActionIntervalMs: 0 }, {
	launch: async directory => {
		profiles.push(directory);
		const page = Object.assign(new EventEmitter(), { url: () => "https://fixture.test/", isClosed: () => false, frames: () => [page], locator: () => ({ count: async () => 0 }), mouse: { up: async () => {} }, screenshot: async () => Buffer.from([0xff, 0xd8, 0xff, 0xd9]) });
		pages.push(page);
		const context = Object.assign(new EventEmitter(), { pages: () => [page], setDefaultTimeout: () => {}, close: async () => context.emit("close") });
		return context as unknown as BrowserContext;
	},
});
const events = EventStore.open(loaded.paths.stateDir);
const host = new ModuleHost({ config: loaded, log: new Logger({ console: false, level: "error" }), modules: [router], transports: [], ingest: input => events.append(input), outbox: () => [], history: HistoryStore.open(loaded.paths.stateDir), runtimeStatus: () => ({}), currentThreads: () => scope });
let expiryHost: ModuleHost | undefined;
function identity(user: number, date = Math.floor(Date.now() / 1000)) {
	const fields = new URLSearchParams({ auth_date: String(date), query_id: "fixture", user: JSON.stringify({ id: user, first_name: "Fixture" }) });
	const check = [...fields].sort(([a], [b]) => a.localeCompare(b)).map(([key, value]) => `${key}=${value}`).join("\n");
	fields.set("hash", createHmac("sha256", createHmac("sha256", "WebAppData").update("fixture-only").digest()).update(check).digest("hex"));
	return fields.toString();
}
function claim(url: string, telegramInitData?: string) {
	const link = new URL(url); return fetch(router.localEndpoint() + link.pathname + "/claim", { method: "POST", headers: { Origin: origin, "Content-Type": "application/json", Authorization: `Bearer ${new URLSearchParams(link.hash.slice(1)).get("aliveKey")}` }, body: JSON.stringify(telegramInitData === undefined ? {} : { telegramInitData }) });
}
try {
	await host.init();
	const allTools = createAliveTools({ config: loaded, moduleTools: host.contributedTools(), log: new Logger({ console: false }) } as ToolDeps);
	assert.equal(allTools.filter(tool => tool.name === "browser").length, 1, "The shared browser must replace the Fortress fallback without a duplicate tool name");
	assert.ok(JSON.stringify(allTools.find(tool => tool.name === "browser")!.parameters).includes('"action"'));
	const fallback = createAliveTools({ config: loaded, moduleTools: [], log: new Logger({ console: false }) } as unknown as ToolDeps);
	assert.ok(JSON.stringify(fallback.find(tool => tool.name === "browser")!.parameters).includes('"args"'), "Fortress remains available when the shared browser module is disabled");
	const share = host.contributedTools().find(tool => tool.name === "browser_share")!;
	const first = await share.execute("share-a", { reason: "First user" } as never, undefined, undefined, {} as never) as { details: Record<string, unknown> };
	assert.deepEqual(first.details.notification, { thread: "telegram:111", messageId: 1 });
	assert.equal(first.details.notificationSent, true); assert.equal(first.details.operatorUrl, undefined);
	assert.equal(String(sent[0].chat_id), "111", "Global paired operator must never replace the task owner");
	assert.ok(!JSON.stringify((sent[0] as unknown as { text: string }).text).includes("https://"), "Controller URLs belong in buttons, not the message body");
	assert.ok((sent[0] as unknown as { text: string }).text.length < 130, "The controller card must remain concise");
	const firstUrl = sent[0].reply_markup.inline_keyboard[0][0].web_app.url;
	assert.match(firstUrl, /\/browser\/s\/[a-f0-9]{24}#aliveKey=/);
	assert.equal((await router.command({ action: "handoff", thread: "telegram:222" })).isError, true, "A user cannot select another conversation outside its trusted batch");
	assert.equal(sent.length, 1);
	scope = ["telegram:222"];
	const second = await share.execute("share-b", { reason: "Second user" } as never, undefined, undefined, {} as never) as { details: Record<string, unknown> };
	assert.deepEqual(second.details.notification, { thread: "telegram:222", messageId: 2 });
	assert.equal(String(sent[1].chat_id), "222");
	const secondUrl = sent[1].reply_markup.inline_keyboard[0][0].web_app.url;
	assert.notEqual(new URL(firstUrl).pathname, new URL(secondUrl).pathname);
	assert.equal(new Set(profiles).size, 2, "Users must own separate persistent profiles");
	const firstClaim = await claim(firstUrl); assert.equal(firstClaim.status, 200);
	const firstCredential = (await firstClaim.json() as { credential: string }).credential;
	assert.equal((await claim(firstUrl)).status, 401, "The original activation key alone remains single-use");
	assert.equal((await claim(firstUrl, identity(222))).status, 403, "Another Telegram account cannot reopen a user's controller");
	assert.equal((await claim(firstUrl, identity(111, Math.floor(Date.now() / 1000) - 601))).status, 403, "Stale signed launch data is rejected");
	assert.equal((await claim(firstUrl, identity(111).replace("Fixture", "Tampered"))).status, 403, "Changing signed identity fields invalidates recovery");
	assert.equal((await claim(firstUrl, identity(111) + "&auth_date=1")).status, 403, "Duplicate signed fields are rejected");
	const restored = await claim(firstUrl, identity(111)); assert.equal(restored.status, 200, "The same verified owner can reopen without browser storage");
	const restoredCredential = (await restored.json() as { credential: string }).credential;
	assert.notEqual(restoredCredential, firstCredential);
	const firstPath = new URL(firstUrl).pathname;
	assert.equal((await fetch(router.localEndpoint() + firstPath + "/frame", { headers: { Authorization: `Bearer ${firstCredential}` } })).status, 401, "Reopening revokes the previous window's credential");
	const reopened = await fetch(router.localEndpoint() + firstPath + "/claim", { method: "POST", headers: { Origin: origin, "Content-Type": "application/json", Authorization: `Bearer ${restoredCredential}` }, body: "{}" });
	assert.equal(reopened.status, 200, "A saved rotated credential can recover a regular browser window");
	const secondPath = new URL(secondUrl).pathname;
	assert.equal((await fetch(router.localEndpoint() + secondPath + "/frame", { headers: { Authorization: `Bearer ${firstCredential}` } })).status, 401, "One user's credential must not access another browser");
	scope = ["telegram:111", "telegram:222"];
	await assert.rejects(() => share.execute("ambiguous", { reason: "No destination" } as never, undefined, undefined, {} as never), /ambiguous/);
	assert.equal(sent.length, 2, "Ambiguous routing must send no button");
	const beforeClose = sent.length;
	assert.equal((await router.command({ action: "close", thread: "telegram:111" })).details.credentialsRevoked, true);
	assert.equal(sent.length, beforeClose, "Cancelling must not send an assistance notification");
	assert.equal((await fetch(router.localEndpoint() + new URL(firstUrl).pathname + "/frame", { headers: { Authorization: `Bearer ${firstCredential}` } })).status, 410);
	assert.equal((await claim(secondUrl)).status, 200, "Cancelling one conversation must preserve another user's session");
	scope = ["telegram:111"]; failDelivery = true;
	await assert.rejects(() => share.execute("failed", { reason: "Offline delivery" } as never, undefined, undefined, {} as never), /not delivered/);
	assert.equal(sent.length, 2);
	failDelivery = false;
	const retry = await share.execute("retry", { reason: "Retry same user" } as never, undefined, undefined, {} as never) as { details: Record<string, unknown> };
	assert.deepEqual(retry.details.notification, { thread: "telegram:111", messageId: 3 });
	assert.equal(String(sent[2].chat_id), "111");
	assert.equal(JSON.stringify(events.all()).includes("aliveKey"), false);
	assert.equal(JSON.stringify(retry).includes("aliveKey"), false);
	const previousLink = sent[2].reply_markup.inline_keyboard[0][0].web_app.url;
	const profileCount = profiles.length;
	const beforeRotations = edited.length, beforeEvents = events.all().length;
	const deadline = (retry.details.handoff as { expiresAt: number }).expiresAt;
	origin = "https://phone2.test";
	writePrivateJson(path.join(root, "alive.config.local.json"), { modules: { browser: { publicUrl: origin } } });
	const rotated = await router.command({ action: "status", thread: "telegram:111" });
	assert.equal((rotated.details.handoff as { expiresAt: number }).expiresAt, deadline, "Relay rotation must not indefinitely extend abandoned assistance");
	assert.equal(profiles.length, profileCount, "Relay rotation must preserve browser contexts");
	assert.equal((await claim(previousLink)).status, 401, "Relay rotation revokes previous activation keys");
	assert.equal(sent.length, 3, "Relay rotation must edit existing cards instead of sending duplicates");
	const rotations = edited.slice(beforeRotations);
	assert.deepEqual(rotations.map(message => String(message.chat_id)).sort(), ["111", "222"], "Each card must be edited only in its owner's chat");
	assert.equal(events.all().length, beforeEvents, "Relay renewal must not wake the agent with duplicate assistance events");
	for (const message of rotations) {
		const link = message.reply_markup.inline_keyboard[0][0].web_app.url;
		assert.equal(new URL(link).origin, origin);
		assert.equal((await claim(link)).status, 200);
	}
	const expiring = new BrowserRouter({ port: 0, publicUrl: origin, handoffTtlMs: 1000 }, {
		launch: async () => {
			const page = Object.assign(new EventEmitter(), { url: () => "https://fixture.test/", isClosed: () => false, frames: () => [page], locator: (selector: string) => ({ count: async () => selector.includes("#challenge-form") ? 1 : 0, nth: () => ({ isVisible: async () => true }) }), mouse: { up: async () => {} } });
			const context = Object.assign(new EventEmitter(), { pages: () => [page], setDefaultTimeout: () => {}, close: async () => context.emit("close") });
			return context as unknown as BrowserContext;
		},
	});
	expiryHost = new ModuleHost({ config: loaded, log: new Logger({ console: false, level: "error" }), modules: [expiring], transports: [], ingest: input => events.append(input), outbox: () => [], history: HistoryStore.open(loaded.paths.stateDir), runtimeStatus: () => ({}), currentThreads: () => ["telegram:111"] });
	await expiryHost.init(); await expiring.command({ action: "handoff", thread: "telegram:111" });
	const expiredPath = new URL(sent.at(-1)!.reply_markup.inline_keyboard[0][0].web_app.url).pathname, beforeExpiry = sent.length;
	await new Promise(resolve => setTimeout(resolve, 1300));
	assert.equal((expiring.status().sessions as unknown[]).length, 0, "Expired routed sessions must leave the pool");
	assert.equal((await fetch(expiring.localEndpoint() + expiredPath + "/frame")).status, 410);
	const endedPage = await fetch(expiring.localEndpoint() + expiredPath);
	assert.match(endedPage.headers.get("content-type") || "", /text\/html/);
	assert.match(await endedPage.text(), /frame-wait/, "Reopening an expired button must show the controller's ended state, not raw JSON");
	assert.equal(sent.length, beforeExpiry, "Expiration must send no replacement button");
	assert.equal(edited.at(-1)!.reply_markup.inline_keyboard.length, 0, "Expired cards must remove their controls");
	const beforeFailure = sent.length;
	editFailure = "limited";
	assert.equal((await router.command({ action: "handoff", thread: "telegram:111", renew: true })).details.notificationFailed, true);
	assert.equal(sent.length, beforeFailure, "A rate-limited edit must not create a duplicate message");
	editFailure = "";
	assert.equal((await router.command({ action: "handoff", thread: "telegram:111" })).details.notificationSent, true);
	assert.equal(sent.length, beforeFailure, "Retry delivery by editing the same card");
	editFailure = "missing";
	assert.equal((await router.command({ action: "handoff", thread: "telegram:111", renew: true })).details.notificationSent, true);
	assert.equal(sent.length, beforeFailure + 1, "A deleted card can be replaced for its owner");
	assert.equal(String(sent.at(-1)!.chat_id), "111"); editFailure = "";
	console.log("browser-router: isolated recipients, owner-authenticated reopening, tamper/stale/cross-user rejection, revocation, cancellation, relay rotation and expiry cleanup passed");
} finally {
	await expiryHost?.stop(); await host.stop(); api.closeAllConnections(); await new Promise<void>(resolve => api.close(() => resolve())); fs.rmSync(root, { recursive: true, force: true });
}
