import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
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

const root = fs.mkdtempSync(path.join(os.tmpdir(), "alive-browser-routing-"));
const sent: Array<{ chat_id: string; reply_markup: { inline_keyboard: Array<Array<{ web_app: { url: string } }>> } }> = [];
const profiles: string[] = [];
let failDelivery = false, scope = ["telegram:111"];
const api = http.createServer((request, response) => {
	let body = ""; request.on("data", part => body += part); request.on("end", () => {
		const params = JSON.parse(body); const method = request.url!.split("/").at(-1);
		if (method === "sendMessage" && failDelivery) { response.writeHead(500); response.end(JSON.stringify({ ok: false, description: "Fixture delivery failure" })); return; }
		let result: unknown = { id: Number(params.chat_id), type: "private" };
		if (method === "sendMessage") { sent.push(params); result = { message_id: sent.length, chat: { id: Number(params.chat_id), type: "private" } }; }
		response.writeHead(200, { "Content-Type": "application/json" }); response.end(JSON.stringify({ ok: true, result }));
	});
});
await new Promise<void>(resolve => api.listen(0, "127.0.0.1", resolve));
const initial = loadConfig({ cwd: root });
const loaded = loadConfig({ cwd: root, overrides: { modules: { ...initial.config.modules, telegram: { ...initial.config.modules.telegram, enabled: true, token: "fixture-only", tokenEnv: "UNSET_FIXTURE_ROUTER_TOKEN", apiBase: `http://127.0.0.1:${(api.address() as { port: number }).port}`, allowedUserIds: ["111"], allowedChatIds: [] } } } });
new TelegramAllowlistStore(path.join(loaded.paths.modulesDir, "telegram")).add("222");
writePrivateJson(path.join(loaded.paths.modulesDir, "browser", "operator.json"), { chatId: "999", userId: "999", pairedAt: Date.now() });
const pages: Array<EventEmitter & Record<string, any>> = [];
const router = new BrowserRouter({ port: 0, publicUrl: "https://phone.test", minActionIntervalMs: 0 }, {
	launch: async directory => {
		profiles.push(directory);
		const page = Object.assign(new EventEmitter(), { url: () => "about:blank", isClosed: () => false, mouse: { up: async () => {} }, screenshot: async () => Buffer.from([0xff, 0xd8, 0xff, 0xd9]) });
		pages.push(page);
		const context = Object.assign(new EventEmitter(), { pages: () => [page], setDefaultTimeout: () => {}, close: async () => context.emit("close") });
		return context as unknown as BrowserContext;
	},
});
const events = EventStore.open(loaded.paths.stateDir);
const host = new ModuleHost({ config: loaded, log: new Logger({ console: false, level: "error" }), modules: [router], transports: [], ingest: input => events.append(input), outbox: () => [], history: HistoryStore.open(loaded.paths.stateDir), runtimeStatus: () => ({}), currentThreads: () => scope });
function claim(url: string) {
	const link = new URL(url); return fetch(router.localEndpoint() + link.pathname + "/claim", { method: "POST", headers: { Origin: "https://phone.test", "Content-Type": "application/json", Authorization: `Bearer ${new URLSearchParams(link.hash.slice(1)).get("aliveKey")}` }, body: "{}" });
}
try {
	await host.init();
	const share = host.contributedTools().find(tool => tool.name === "browser_share")!;
	const first = await share.execute("share-a", { reason: "First user" } as never, undefined, undefined, {} as never) as { details: Record<string, unknown> };
	assert.deepEqual(first.details.notification, { thread: "telegram:111", messageId: 1 });
	assert.equal(first.details.notificationSent, true); assert.equal(first.details.operatorUrl, undefined);
	assert.equal(String(sent[0].chat_id), "111", "Global paired operator must never replace the task owner");
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
	console.log("browser-router: two private recipients, isolated profiles/paths/credentials, trusted thread routing, receipt, cancellation and failed-delivery reporting passed");
} finally {
	await host.stop(); api.closeAllConnections(); await new Promise<void>(resolve => api.close(() => resolve())); fs.rmSync(root, { recursive: true, force: true });
}
