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
import { setupBrowser } from "../modules/browser/cli.js";
import { BrowserModule } from "../modules/browser/module.js";
import { acceptBrowserPairing, cancelBrowserPairing, readBrowserOperator, requestBrowserPairing } from "../modules/browser/operator.js";
import { startQuickTunnel } from "../modules/browser/tunnel.js";
import { TelegramModule } from "../modules/telegram/module.js";
import { TelegramAllowlistStore } from "../modules/telegram/state.js";
import type { TelegramMessage, TelegramUpdate } from "../modules/telegram/types.js";
import { EventStore } from "../store/events.js";
import { HistoryStore } from "../store/history.js";
import { sleep } from "../util.js";

const root = fs.mkdtempSync(path.join(os.tmpdir(), "alive-operator-test-"));
const privateMessage = (code: string): TelegramMessage => ({ message_id: 1, date: Math.floor(Date.now() / 1000), chat: { id: 777, type: "private" }, from: { id: 777, is_bot: false, first_name: "Operator" }, text: `/browser_pair ${code}` });
let host: ModuleHost | undefined;
let api: http.Server | undefined;
try {
	const config = path.join(root, "alive.config.json");
	const local = path.join(root, "alive.config.local.json");
	fs.writeFileSync(config, JSON.stringify({ tools: { allowlist: ["read", "status"] } }));
	fs.writeFileSync(local, JSON.stringify({ modules: { telegram: { allowedChatIds: ["777"] } }, tools: { bash: false }, name: "Preserved" }));
	setupBrowser(loadConfig({ cwd: root }), { "public-url": "https://phone.test", headless: true });
	let loaded = loadConfig({ cwd: root });
	assert.deepEqual(loaded.config.tools.allowlist, ["read", "status", "browser"]);
	assert.equal(loaded.config.tools.bash, false);
	assert.equal(loaded.config.name, "Preserved");
	assert.equal(loaded.config.modules.browser!.headless, true);
	assert.equal(fs.statSync(local).mode & 0o777, 0o600);
	assert.throws(() => setupBrowser(loaded, { "public-url": "http://phone.test" }), /HTTPS/);

	const request = requestBrowserPairing(loaded.paths.modulesDir, 1000);
	assert.equal(fs.statSync(path.join(loaded.paths.modulesDir, "browser", "pairing.json")).mode & 0o777, 0o600);
	assert.equal(acceptBrowserPairing(loaded.paths.modulesDir, privateMessage("x".repeat(32)), [], 1001), undefined);
	assert.equal(acceptBrowserPairing(loaded.paths.modulesDir, { ...privateMessage(request.code), chat: { id: 777, type: "group" } }, [], 1001), undefined);
	assert.equal(acceptBrowserPairing(loaded.paths.modulesDir, { ...privateMessage(request.code), from: { id: 888, is_bot: false, first_name: "Other" } }, [], 1001), undefined);
	assert.equal(acceptBrowserPairing(loaded.paths.modulesDir, privateMessage(request.code), ["888"], 1001), undefined);
	assert.equal(acceptBrowserPairing(loaded.paths.modulesDir, privateMessage(request.code), [], request.expiresAt), undefined);
	assert.equal(acceptBrowserPairing(loaded.paths.modulesDir, privateMessage(request.code), ["777"], 1001)?.chatId, "777");
	assert.equal(acceptBrowserPairing(loaded.paths.modulesDir, privateMessage(request.code), [], 1002), undefined, "Pairing must be single-use");

	const old = requestBrowserPairing(loaded.paths.modulesDir);
	const current = requestBrowserPairing(loaded.paths.modulesDir);
	cancelBrowserPairing(loaded.paths.modulesDir, old.code);
	assert.equal(acceptBrowserPairing(loaded.paths.modulesDir, privateMessage(old.code), []), undefined);
	assert.equal(acceptBrowserPairing(loaded.paths.modulesDir, privateMessage(current.code), [])?.chatId, "777");

	const setupWithIdentity = loadConfig({ cwd: root });
	setupBrowser(setupWithIdentity, { "identity-url": "https://identity.test", "sign-origins": "https://permitted.test" });
	assert.equal(loadConfig({ cwd: root }).config.modules.browser!.signing.agentUrl, "https://identity.test");
	assert.equal(loadConfig({ cwd: root }).config.modules.browser!.publicUrl, "https://phone.test", "An external directory must not replace the phone endpoint");
	const keyFile = process.env.ALIVE_BROWSER_SIGNING_KEY_FILE!;
	assert.equal(fs.statSync(keyFile).mode & 0o777, 0o600);
	const originalKey = fs.readFileSync(keyFile, "utf8");
	setupBrowser(loadConfig({ cwd: root }), { "sign-origins": "https://permitted.test" });
	assert.equal(fs.readFileSync(keyFile, "utf8"), originalKey, "Setup must not rotate an existing private key");
	delete process.env.ALIVE_BROWSER_SIGNING_KEY_FILE;
	assert.throws(() => setupBrowser(loadConfig({ cwd: root }), { "sign-origins": "https://permitted.test" }), /existing .env/);

	// Exercise Telegram polling -> private pairing -> dynamic allowlist -> handoff notification.
	const incoming: TelegramUpdate[] = [];
	const sent: Array<{ chat_id: string; text: string }> = [];
	api = http.createServer((req, res) => {
		let body = ""; req.on("data", chunk => { body += chunk; });
		req.on("end", () => {
			const params = JSON.parse(body || "{}");
			const method = req.url!.split("/").at(-1);
			let result: unknown = true;
			if (method === "getMe") result = { id: 123, is_bot: true, first_name: "Fixture", username: "fixture_bot" };
			if (method === "sendMessage") { sent.push(params); result = { message_id: sent.length, date: 1, chat: { id: Number(params.chat_id), type: "private" }, text: params.text }; }
			if (method === "getUpdates") result = incoming.splice(0);
			const reply = () => { if (!res.destroyed) { res.writeHead(200, { "content-type": "application/json" }); res.end(JSON.stringify({ ok: true, result })); } };
			if (method === "getUpdates") { const timer = setTimeout(reply, 30); res.on("close", () => clearTimeout(timer)); }
			else reply();
		});
	});
	await new Promise<void>(resolve => api!.listen(0, "127.0.0.1", resolve));
	const requestForBot = requestBrowserPairing(loaded.paths.modulesDir);
	incoming.push({ update_id: 1, message: privateMessage(requestForBot.code) });
	loaded = loadConfig({ cwd: root, overrides: { modules: { ...loaded.config.modules, telegram: { ...loaded.config.modules.telegram, enabled: true, token: "fixture-only", tokenEnv: "TEST_OPERATOR_TOKEN", apiBase: `http://127.0.0.1:${(api.address() as { port: number }).port}`, allowedUserIds: [], allowedChatIds: ["777"] } } } });
	const page = new EventEmitter();
	Object.assign(page, { mouse: { up: async () => {} }, url: () => "about:blank", isClosed: () => false });
	const context = new EventEmitter();
	Object.assign(context, { pages: () => [page], setDefaultTimeout: () => {}, close: async () => context.emit("close") });
	const browser = new BrowserModule({ port: 0, publicUrl: "https://phone.test", minActionIntervalMs: 0 }, { launch: async () => context as unknown as BrowserContext });
	const events = EventStore.open(loaded.paths.stateDir);
	const history = HistoryStore.open(loaded.paths.stateDir);
	host = new ModuleHost({ config: loaded, log: new Logger({ console: false, level: "error", file: loaded.paths.logFile }), transports: [], modules: [new TelegramModule(loaded.config.modules.telegram), browser], ingest: e => events.append(e), outbox: () => [], history, runtimeStatus: () => ({}) });
	await host.init();
	const deadline = Date.now() + 5000;
	while (!sent.some(r => r.text.includes("Телефон привязан")) && Date.now() < deadline) await sleep(20);
	assert.ok(sent.some(r => r.text.includes("Телефон привязан")));
	assert.equal(readBrowserOperator(loaded.paths.modulesDir)?.chatId, "777");
	assert.ok(new TelegramAllowlistStore(path.join(loaded.paths.modulesDir, "telegram")).list().includes("777"));
	assert.equal(history.stats().messages, 0, "Pairing command must not enter history");
	const handoff = await browser.command({ action: "handoff", reason: "Fixture human assistance" });
	assert.equal(handoff.details.notificationFailed, false);
	assert.equal(handoff.details.operatorUrl, undefined, "Telegram capability must not appear in model tool output");
	assert.ok(sent.some(r => String(r.chat_id) === "777" && /https:\/\/phone.test\/browser#[A-Za-z0-9_-]{43}/.test(r.text)));
	await browser.command({ action: "handoff" });
	assert.equal(sent.filter(r => r.text.includes("/browser#")).length, 1);
	const logs = fs.existsSync(loaded.paths.logFile) ? fs.readFileSync(loaded.paths.logFile, "utf8") : "";
	assert.equal(logs.includes(requestForBot.code), false);
	assert.equal(JSON.stringify(events.all()).includes(requestForBot.code), false);
	assert.equal(JSON.stringify(handoff).includes(requestForBot.code), false);

	const abort = new AbortController(); abort.abort();
	await assert.rejects(startQuickTunnel("http://127.0.0.1:4323", abort.signal, "/nonexistent/alive-test-cloudflared"), /cancelled|could not start/);
	console.log("Operator tests passed: private one-time pairing, expiry, chat boundaries, Telegram integration, notification secrecy, existing permission/key preservation, missing tunnel executable.");
} finally {
	await host?.stop();
	api?.closeAllConnections();
	await new Promise<void>(resolve => api ? api.close(() => resolve()) : resolve());
	delete process.env.ALIVE_BROWSER_SIGNING_KEY_FILE;
	fs.rmSync(root, { recursive: true, force: true });
}
