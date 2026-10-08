import assert from "node:assert/strict";
import { createHash, createPublicKey, generateKeyPairSync, verify } from "node:crypto";
import { EventEmitter } from "node:events";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { BrowserContext, BrowserType } from "playwright";
import { loadConfig } from "../config.js";
import type { ModuleContext } from "../events/api.js";
import { ModuleHost } from "../events/host.js";
import { loadModules, describeModules } from "../events/loader.js";
import { Logger } from "../log.js";
import { BrowserIdentity } from "../modules/browser/identity.js";
import { BrowserModule } from "../modules/browser/module.js";
import { DEFAULT_BROWSER_CONFIG } from "../modules/browser/config.js";
import { EventStore } from "../store/events.js";
import { HistoryStore } from "../store/history.js";

const root = fs.mkdtempSync(path.join(os.tmpdir(), "alive-browser-test-"));
const log = new Logger({ console: false, level: "error" });
const modules: BrowserModule[] = [];
const hosts: ModuleHost[] = [];

class FakePage extends EventEmitter {
	address = "about:blank";
	challenge = false;
	statusCode = 200;
	responseHeaders: Record<string, string> = {};
	inputs: unknown[] = [];
	gotos = 0;
	url() { return this.address; }
	isClosed() { return false; }
	mainFrame() { return this; }
	viewportSize() { return { width: 900, height: 720 }; }
	async title() { return "Test page"; }
	async goto(url: string) {
		this.address = url;
		this.gotos++;
		this.emit("response", { request: () => ({ isNavigationRequest: () => true }), frame: () => this, status: () => this.statusCode, headers: () => this.responseHeaders });
	}
	locator(selector: string) {
		return {
			innerText: async () => "Test page text",
			count: async () => selector === "body" ? 1 : selector.includes("#challenge-form") ? Number(this.challenge) : 0,
			nth: () => ({ isVisible: async () => this.challenge }),
			first: () => ({ click: async () => { this.inputs.push("agent-click"); }, fill: async (value: string) => { this.inputs.push(value); } }),
		};
	}
	async screenshot() { return Buffer.from([0xff, 0xd8, 0xff, 0xd9]); }
	mouse = {
		move: async (x: number, y: number) => { this.inputs.push({ x, y }); },
		down: async () => { this.inputs.push("down"); }, up: async () => { this.inputs.push("up"); },
		wheel: async (_x: number, y: number) => { this.inputs.push({ wheel: y }); },
	};
	keyboard = { insertText: async (value: string) => { this.inputs.push(value); }, press: async (value: string) => { this.inputs.push(value); } };
}

async function fixture(options: { notify?: (url: string, reason: string) => Promise<void>; ttl?: number } = {}) {
	const page = new FakePage();
	const requested: Array<{ url: string; options: unknown }> = [];
	const context = new EventEmitter() as EventEmitter & Record<string, unknown>;
	Object.assign(context, {
		pages: () => [page], newPage: async () => page, setDefaultTimeout: () => {}, close: async () => { context.emit("close"); },
		request: { get: async (url: string, opts: unknown) => {
			requested.push({ url, options: opts });
			return { status: () => 302, headers: () => ({ location: "https://other.test/" }), text: async () => "Redirect", dispose: async () => {} };
		} },
	});
	const module = new BrowserModule({ port: 0, minActionIntervalMs: 0, humanization: { enabled: false }, handoffTtlMs: options.ttl ?? 60_000 }, {
		launch: (async () => context as unknown as BrowserContext) as BrowserType["launchPersistentContext"], notify: options.notify,
	});
	const loaded = loadConfig({ cwd: fs.mkdtempSync(path.join(root, "instance-")) });
	const store = EventStore.open(loaded.paths.stateDir);
	const host = new ModuleHost({ config: loaded, log, transports: [], modules: [module], ingest: (e) => store.append(e), outbox: () => [], history: HistoryStore.open(loaded.paths.stateDir), runtimeStatus: () => ({}) });
	modules.push(module);
	hosts.push(host);
	await host.init();
	assert.equal(host.contributedTools().filter((tool) => tool.name === "browser").length, 1);
	return { module, page, requested, store };
}

function post(base: string, endpoint: string, credential: string, body: unknown = {}, origin?: string) {
	return fetch(`${base}/browser/${endpoint}`, { method: "POST", headers: { Authorization: `Bearer ${credential}`, "content-type": "application/json", ...(origin ? { origin } : {}) }, body: JSON.stringify(body) });
}

try {
	const { privateKey, publicKey } = generateKeyPairSync("ed25519");
	const keyPath = path.join(root, "key.pem");
	fs.writeFileSync(keyPath, privateKey.export({ type: "pkcs8", format: "pem" }), { mode: 0o600 });
	const settings = { enabled: true, agentUrl: "https://agent.test", keyFileEnv: "TEST_KEY_FILE", origins: ["https://authorized.test"] };
	const identity = new BrowserIdentity(settings, { TEST_KEY_FILE: keyPath });
	const headers = identity.requestHeaders("https://authorized.test/path?q=test", 1_700_000_000_000);
	const params = headers["Signature-Input"].slice("sig1=".length);
	const base = `"@authority": authorized.test\n"@method": GET\n"@path": /path\n"@query": ?q=test\n"signature-agent": "https://agent.test"\n"@signature-params": ${params}`;
	const signature = Buffer.from(headers.Signature.slice("sig1=:".length, -1), "base64");
	assert.ok(verify(null, Buffer.from(base), publicKey, signature));
	assert.ok(!verify(null, Buffer.from(base.replace("/path", "/other")), publicKey, signature));
	assert.match(params, /created=1700000000;expires=1700000060/);
	assert.notEqual(headers.Signature, identity.requestHeaders("https://authorized.test/path?q=test", 1_700_000_000_000).Signature);
	assert.throws(() => identity.requestHeaders("https://other.test/"), /not authorized/);
	assert.throws(() => identity.requestHeaders("http://authorized.test/"), /not authorized/);
	assert.throws(() => new BrowserIdentity({ ...settings, agentUrl: "http://agent.test" }, { TEST_KEY_FILE: keyPath }), /HTTPS/);
	const directory = identity.directory(1_700_000_000_000);
	const jwk = JSON.parse(directory.body).keys[0];
	assert.equal(jwk.d, undefined);
	assert.equal(identity.keyId, createHash("sha256").update(JSON.stringify({ crv: jwk.crv, kty: jwk.kty, x: jwk.x })).digest("base64url"));
	const directoryParams = directory.headers["Signature-Input"].slice(5);
	assert.ok(verify(null, Buffer.from(`"@authority";req: agent.test\n"@signature-params": ${directoryParams}`), createPublicKey({ key: jwk, format: "jwk" }), Buffer.from(directory.headers.Signature.slice(6, -1), "base64")));
	assert.equal(directory.headers["Content-Type"], "application/http-message-signatures-directory+json");

	const { module, page, requested, store } = await fixture();
	await module.command({ action: "navigate", url: "https://authorized.test/" });
	assert.equal(module.status().paused, false);
	await assert.rejects(() => module.command({ action: "navigate", url: "file:///etc/passwd" }), /HTTP/);
	await module.command({ action: "request", url: "https://authorized.test/" });
	assert.equal((requested[0].options as { maxRedirects: number }).maxRedirects, 0);
	assert.equal(requested.length, 1, "signed/unsigned requests must not follow redirects");
	const handoff = await module.command({ action: "handoff", reason: "Test assistance" });
	const link = new URL(handoff.details.operatorUrl as string);
	const token = link.hash.slice(1);
	const origin = link.origin;
	assert.ok(!JSON.stringify(module.status()).includes(token));
	assert.ok(!JSON.stringify(store.peekPending(100)).includes(token));
	assert.equal((await fetch(`${origin}/browser/frame`)).status, 401);
	assert.equal((await post(origin, "claim", token, {}, "https://attacker.test")).status, 403);
	const before = page.inputs.length;
	const denied = await module.command({ action: "click", selector: "button" });
	assert.equal(page.inputs.length, before, "agent cannot act while the human owns the page");
	assert.match(denied.details.error as string, /paused/);
	const claim = await post(origin, "claim", token);
	assert.equal(claim.status, 200);
	const credential = (await claim.json() as { credential: string }).credential;
	assert.notEqual(credential, token);
	assert.equal((await post(origin, "claim", token)).status, 401);
	assert.equal((await fetch(`${origin}/browser/frame`, { headers: { Authorization: `Bearer ${token}` } })).status, 401);
	const frame = await fetch(`${origin}/browser/frame`, { headers: { Authorization: `Bearer ${credential}` } });
	assert.equal(frame.status, 200);
	assert.equal(frame.headers.get("cache-control"), "no-store");
	assert.equal(frame.headers.get("content-type"), "image/jpeg");
	assert.equal((await post(origin, "input", credential, { type: "down", x: 901, y: 10 })).status, 400);
	assert.equal((await post(origin, "input", credential, { type: "key", key: "F12" })).status, 400);
	assert.equal((await post(origin, "input", credential, { type: "text", text: "x".repeat(4097) })).status, 400);
	assert.equal((await post(origin, "input", credential, { type: "text", text: "x".repeat(20_000) })).status, 413);
	const malformed = await fetch(`${origin}/browser/input`, { method: "POST", headers: { Authorization: `Bearer ${credential}`, "content-type": "application/json" }, body: "[1]" });
	assert.equal(malformed.status, 400);
	assert.equal((await post(origin, "input", credential, { type: "text", text: "Ручной ввод" })).status, 200);
	assert.ok(page.inputs.includes("Ручной ввод"));
	page.challenge = true;
	assert.equal((await post(origin, "resume", credential)).status, 409);
	page.challenge = false;
	assert.equal((await post(origin, "resume", credential)).status, 200);
	assert.equal(module.status().paused, false);
	assert.equal((await post(origin, "input", credential, { type: "text", text: "after resume" })).status, 401);

	page.statusCode = 403;
	await module.command({ action: "navigate", url: "https://authorized.test/denied" });
	assert.equal(module.status().paused, true);
	const count = page.gotos;
	await module.command({ action: "navigate", url: "https://authorized.test/retry" });
	assert.equal(page.gotos, count, "403 cannot trigger an automatic retry");
	const renewed = await module.command({ action: "handoff", renew: true });
	const replacement = new URL(renewed.details.operatorUrl as string).hash.slice(1);
	const claimedAgain = await post(origin, "claim", replacement);
	const credential2 = (await claimedAgain.json() as { credential: string }).credential;
	assert.equal((await post(origin, "resume", credential2)).status, 409, "a persistent access denial cannot be resumed");
	page.statusCode = 429;
	page.responseHeaders = { "retry-after": "60" };
	await page.goto("https://authorized.test/limited");
	page.statusCode = 200;
	page.responseHeaders = {};
	await page.goto("https://authorized.test/okay");
	assert.equal((await post(origin, "resume", credential2)).status, 409, "Retry-After must still apply after a successful navigation");
	assert.equal((await post(origin, "input", credential2, { type: "reload" })).status, 409, "Operator reload also respects the cooldown");
	await module.command({ action: "handoff", renew: true });
	assert.equal((await post(origin, "input", credential2, { type: "key", key: "Tab" })).status, 401, "renewal revokes the previous controller");

	let notifications = 0;
	let notifiedLink = "";
	const notified = await fixture({ notify: async (url) => { notifications++; if (notifications === 1) throw new Error("offline"); notifiedLink = url; } });
	const failed = await notified.module.command({ action: "handoff" });
	assert.equal(failed.details.notificationFailed, true);
	assert.equal(failed.details.operatorUrl, undefined, "Telegram links must not enter the agent transcript");
	const retried = await notified.module.command({ action: "handoff" });
	assert.equal(retried.details.notificationFailed, false);
	await notified.module.command({ action: "handoff" });
	assert.equal(notifications, 2, "successful notification is not repeated");
	assert.ok(!JSON.stringify(notified.store.peekPending(100)).includes(new URL(notifiedLink).hash.slice(1)));

	const expires = await fixture({ ttl: 1000 });
	const expiringLink = new URL((await expires.module.command({ action: "handoff" })).details.operatorUrl as string);
	await new Promise((resolve) => setTimeout(resolve, 1100));
	assert.equal((await post(expiringLink.origin, "claim", expiringLink.hash.slice(1))).status, 410);
	assert.equal(expires.module.status().paused, true, "expiration must never auto-resume the agent");

	const defaults = loadConfig({ cwd: root });
	assert.equal(defaults.config.modules.browser?.enabled, false);
	assert.equal(describeModules(defaults.config).find((item) => item.name === "browser")?.enabled, false);
	defaults.config.modules.browser = { ...DEFAULT_BROWSER_CONFIG, enabled: true, port: 0 };
	assert.ok((await loadModules(defaults, log)).modules.some((item) => item.name === "browser"));
	await assert.rejects(() => new BrowserModule({ host: "0.0.0.0" }).start({} as ModuleContext), /HTTPS/);
	console.log("browser identity, handoff, authorization, rate limit and lifecycle tests passed");
} finally {
	for (const host of hosts) await host.stop();
	fs.rmSync(root, { recursive: true, force: true });
}
