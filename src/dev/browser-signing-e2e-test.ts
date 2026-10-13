import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { generateKeyPairSync, verify } from "node:crypto";
import * as fs from "node:fs";
import * as https from "node:https";
import * as os from "node:os";
import * as path from "node:path";
import { chromium, type BrowserContext } from "playwright";
import { loadConfig } from "../config.js";
import { ModuleHost } from "../events/host.js";
import { Logger } from "../log.js";
import { BrowserModule } from "../modules/browser/module.js";
import { EventStore } from "../store/events.js";
import { HistoryStore } from "../store/history.js";

const root = fs.mkdtempSync(path.join(os.tmpdir(), "alive-signing-e2e-"));
const certFile = path.join(root, "tls.pem");
const tlsKey = path.join(root, "tls-key.pem");
execFileSync("openssl", ["req", "-x509", "-newkey", "rsa:2048", "-nodes", "-sha256", "-days", "1", "-subj", "/CN=localhost", "-keyout", tlsKey, "-out", certFile], { stdio: "ignore" });
const { privateKey, publicKey } = generateKeyPairSync("ed25519");
const signingKey = path.join(root, "identity.pem");
fs.writeFileSync(signingKey, privateKey.export({ type: "pkcs8", format: "pem" }), { mode: 0o600 });
process.env.ALIVE_TEST_BROWSER_KEY = signingKey;
const seen: Array<{ path: string; method: string; signed: boolean; nonce?: string; cookie?: string; body: string }> = [];
const failures: string[] = [];
let origin = "";
let frameOrigin = "";
let unapprovedOrigin = "";
const tls = { key: fs.readFileSync(tlsKey), cert: fs.readFileSync(certFile) };
const fixture = https.createServer(tls, (req, res) => {
	const url = new URL(req.url!, `https://${req.headers.host}`);
	const input = req.headers["signature-input"] as string | undefined;
	let signed = false;
	if (input) {
		const params = input.slice("sig1=".length);
		const base = `"@authority": ${url.host}\n"@method": ${req.method}\n"@path": ${url.pathname}\n"@query": ${url.search || "?"}\n"signature-agent": ${req.headers["signature-agent"]}\n"@signature-params": ${params}`;
		const signature = Buffer.from((req.headers.signature as string).slice("sig1=:".length, -1), "base64");
		signed = verify(null, Buffer.from(base), publicKey, signature);
	}
	if (!signed) failures.push(`${req.method} ${url.href}`);
	let body = "";
	req.on("data", (chunk) => { body += chunk; });
	req.on("end", () => {
		seen.push({ path: url.pathname, method: req.method!, signed, nonce: input?.match(/nonce="([^"]+)"/)?.[1], cookie: req.headers.cookie, body });
		if (url.pathname === "/redirect") { res.writeHead(302, { location: "/redirected?q=fresh" }); res.end(); return; }
		if (url.pathname === "/escape") { res.writeHead(302, { location: `${unapprovedOrigin}/unsigned` }); res.end(); return; }
		if (url.pathname === "/worker.js") {
			res.writeHead(200, { "content-type": "text/javascript" }); res.end("fetch('/worker-request').then(()=>postMessage('done'))"); return;
		}
		if (url.pathname === "/shared.js") {
			res.writeHead(200, { "content-type": "text/javascript" }); res.end("onconnect=e=>fetch('/shared-request').then(()=>e.ports[0].postMessage('done'))"); return;
		}
		if (url.pathname === "/service.js") {
			res.writeHead(200, { "content-type": "text/javascript" }); res.end("self.addEventListener('install',()=>self.skipWaiting());self.addEventListener('activate',e=>e.waitUntil(clients.claim()));self.addEventListener('fetch',e=>{if(new URL(e.request.url).pathname==='/sw-probe')e.respondWith(fetch('/sw-upstream'))})"); return;
		}
		res.writeHead(200, { "content-type": "text/html", "set-cookie": "signed=session; Path=/; Secure; SameSite=Lax" });
		if (url.pathname !== "/") { res.end(`<p id="ready">${url.pathname}</p>`); return; }
		res.end(`<html><title>Signed fixture</title><link rel="stylesheet" href="/asset.css"><iframe src="${frameOrigin}/frame"></iframe><button id="popup" onclick="window.open('/popup','test')">Popup</button><p id="ready">loading</p><script>
Promise.all([fetch('/post?q=value',{method:'POST',body:'unchanged-body'}),fetch('/redirect'),new Promise(r=>{const w=new Worker('/worker.js');w.onmessage=()=>{w.terminate();r()}}),new Promise(r=>{const w=new SharedWorker('/shared.js');w.port.onmessage=()=>r();w.port.start()}),navigator.serviceWorker.register('/service.js').then(()=>navigator.serviceWorker.ready).then(()=>new Promise(r=>{if(navigator.serviceWorker.controller)r();else navigator.serviceWorker.addEventListener('controllerchange',r,{once:true})})).then(()=>fetch('/sw-probe'))]).then(()=>document.getElementById('ready').textContent='done');
</script></html>`);
	});
});
const unapproved = https.createServer(tls, (req, res) => {
	if (req.headers.signature || req.headers["signature-agent"] || req.headers["signature-input"]) failures.push("Identity leaked to unapproved redirect");
	seen.push({ path: "/unsigned", method: req.method!, signed: false, body: "" });
	res.end("Unapproved destination");
});
await Promise.all([new Promise<void>(r => fixture.listen(0, "127.0.0.1", r)), new Promise<void>(r => unapproved.listen(0, "127.0.0.1", r))]);
const port = (fixture.address() as { port: number }).port;
origin = `https://127.0.0.1:${port}`;
frameOrigin = `https://localhost:${port}`;
unapprovedOrigin = `https://127.0.0.1:${(unapproved.address() as { port: number }).port}`;
let native: BrowserContext;
const agentDriver = process.env.ALIVE_BROWSER_TEST_DRIVER === "playwright" ? "playwright" : "patchright";
const agentChromium = agentDriver === "patchright" ? (await import("patchright")).chromium : chromium;
const loaded = loadConfig({ cwd: root });
const module = new BrowserModule({ port: 0, headless: true, minActionIntervalMs: 0, publicUrl: "https://identity.test", signing: { enabled: true, agentUrl: "https://identity.test", keyFileEnv: "ALIVE_TEST_BROWSER_KEY", origins: [origin, frameOrigin] } }, {
	// Self-signed TLS is confined to local test fixtures; production verifies TLS.
	launch: async (profile, options) => native = await agentChromium.launchPersistentContext(profile, { ...options, ignoreHTTPSErrors: true, args: ["--ignore-certificate-errors"] }) as unknown as BrowserContext,
});
const events = EventStore.open(loaded.paths.stateDir);
const host = new ModuleHost({ config: loaded, log: new Logger({ console: true, level: "warn" }), transports: [], modules: [module], ingest: e => events.append(e), outbox: () => [], history: HistoryStore.open(loaded.paths.stateDir), runtimeStatus: () => ({}) });
try {
	await host.init();
	await module.command({ action: "navigate", url: `${origin}/` });
	const page = native!.pages()[0];
	await page.locator("#ready").filter({ hasText: "done" }).waitFor({ timeout: 15_000 });
	await page.frameLocator("iframe").locator("#ready").waitFor();
	assert.equal(module.status().paused, false, JSON.stringify(module.status()));
	const popupPromise = native!.waitForEvent("page");
	await module.command({ action: "click", selector: "#popup" });
	const popup = await popupPromise;
	await popup.locator("#ready").waitFor();
	await module.command({ action: "navigate", url: `${origin}/escape` });
	assert.deepEqual(failures, [], "Every approved request must independently verify; unapproved requests must not carry identity");
	for (const path of ["/", "/asset.css", "/frame", "/post", "/redirect", "/redirected", "/worker.js", "/worker-request", "/shared.js", "/shared-request", "/service.js", "/sw-upstream", "/popup"]) assert.ok(seen.some(r => r.path === path && r.signed), `Missing signed request: ${path}`);
	assert.equal(seen.find(r => r.path === "/post")!.body, "unchanged-body");
	assert.equal(seen.find(r => r.path === "/post")!.method, "POST");
	assert.match(seen.find(r => r.path === "/redirect")!.cookie!, /signed=session/);
	const nonces = seen.filter(r => r.signed).map(r => r.nonce);
	assert.equal(new Set(nonces).size, nonces.length, "Each request and redirect must have a fresh nonce");
	assert.equal(module.status().paused, false);
	assert.ok(seen.some(r => r.path === "/unsigned" && !r.signed));
	console.log("Signing E2E passed: native Chrome HTTPS, independent Ed25519 verification, POST body, cookies, redirects, assets, cross-site iframe, dedicated/shared/service workers, popup, unapproved origin isolation.");
} finally {
	await host.stop();
	fixture.closeAllConnections(); unapproved.closeAllConnections();
	await Promise.all([new Promise<void>(r => fixture.close(() => r())), new Promise<void>(r => unapproved.close(() => r()))]);
	delete process.env.ALIVE_TEST_BROWSER_KEY;
	fs.rmSync(root, { recursive: true, force: true });
}
