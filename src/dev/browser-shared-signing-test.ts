import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { generateKeyPairSync, randomBytes, verify } from "node:crypto";
import * as fs from "node:fs";
import * as https from "node:https";
import * as http from "node:http";
import * as os from "node:os";
import * as path from "node:path";
import { chromium, type Browser } from "playwright";
import { DEFAULT_BROWSER_CONFIG } from "../modules/browser/config.js";
import { SharedBrowserHost } from "../modules/browser/shared-server.js";
import { sharedDirectory } from "../modules/browser/shared-client.js";
import { loadConfig } from "../config.js";
import { ModuleHost } from "../events/host.js";
import { Logger } from "../log.js";
import { BrowserModule } from "../modules/browser/module.js";
import { BrowserRouter } from "../modules/browser/router.js";
import { ConversationAgentBrowser } from "../modules/browser/agent-browser.js";
import { EventStore } from "../store/events.js";
import { HistoryStore } from "../store/history.js";

const root = fs.mkdtempSync(path.join(os.tmpdir(), "alive-shared-signing-"));
const cert = path.join(root, "tls.pem"), tlsKey = path.join(root, "tls-key.pem"), key = path.join(root, "identity.pem");
execFileSync("openssl", ["req", "-x509", "-newkey", "rsa:2048", "-nodes", "-sha256", "-days", "1", "-subj", "/CN=localhost", "-keyout", tlsKey, "-out", cert], { stdio: "ignore" });
const { privateKey, publicKey } = generateKeyPairSync("ed25519");
fs.writeFileSync(key, privateKey.export({ type: "pkcs8", format: "pem" }), { mode: 0o600 }); process.env.ALIVE_SHARED_SIGNING_KEY = key;
const seen: Array<{ path: string; cookie?: string; valid: boolean; nonce?: string }> = [];
const fixture = https.createServer({ key: fs.readFileSync(tlsKey), cert: fs.readFileSync(cert) }, (request, response) => {
	const url = new URL(request.url!, `https://${request.headers.host}`), input = request.headers["signature-input"] as string;
	const parameters = input?.slice("sig1=".length), signature = request.headers.signature as string;
	const base = `"@authority": ${url.host}\n"@method": ${request.method}\n"@path": ${url.pathname}\n"@query": ${url.search || "?"}\n"signature-agent": ${request.headers["signature-agent"]}\n"@signature-params": ${parameters}`;
	const valid = !!signature && verify(null, Buffer.from(base), publicKey, Buffer.from(signature.slice("sig1=:".length, -1), "base64"));
	seen.push({ path: url.pathname, cookie: request.headers.cookie, valid, nonce: input?.match(/nonce="([^"]+)"/)?.[1] });
	if (url.pathname === "/redirect") response.writeHead(302, { location: "/must-not-follow" });
	else response.setHeader("content-type", "text/html");
	response.end("<title>Signed shared fixture</title>");
});
const fortress = process.env.ALIVE_BROWSER_TEST_FORTRESS === "1";
// The engine container cannot reach host loopback. This disposable HTTPS
// fixture binds only the Linux Docker bridge, never a phone/public endpoint.
const fixtureHost = fortress ? execFileSync("docker", ["network", "inspect", "bridge", "--format", "{{(index .IPAM.Config 0).Gateway}}"], { encoding: "utf8" }).trim() : "127.0.0.1";
await new Promise<void>((resolve, reject) => { fixture.once("error", reject); fixture.listen(0, fixtureHost, resolve); });
const origin = `https://${fixtureHost}:${(fixture.address() as { port: number }).port}`, token = randomBytes(32).toString("base64url");
const config = { ...DEFAULT_BROWSER_CONFIG, engine: fortress ? "fortress" as const : "chrome" as const, driver: "playwright" as const, headless: true, signing: { ...DEFAULT_BROWSER_CONFIG.signing, enabled: true, keyFileEnv: "ALIVE_SHARED_SIGNING_KEY", agentUrl: "https://identity.test", origins: [origin] } };
const host = new SharedBrowserHost({ config, directory: root, token, port: 0 });
const clients: Browser[] = [];
const agents: ConversationAgentBrowser[] = [];
try {
	await host.start();
	delete process.env.ALIVE_SHARED_SIGNING_KEY;
	process.env.ALIVE_SHARED_SIGNING_TOKEN = token;
	const directory = await sharedDirectory({ ...config, sharedUrl: host.endpoint(), sharedTokenEnv: "ALIVE_SHARED_SIGNING_TOKEN" });
	assert.equal(JSON.parse(directory.body).keys[0].d, undefined, "Only the public key may leave the shared host");
	assert.ok(directory.headers.Signature);
	for (const Module of [BrowserModule, BrowserRouter]) {
		const loaded = loadConfig({ cwd: root }), events = EventStore.open(loaded.paths.stateDir);
		const module = new Module({ ...config, enabled: true, port: 0, publicUrl: "https://identity.test", sharedUrl: host.endpoint(), sharedTokenEnv: "ALIVE_SHARED_SIGNING_TOKEN" });
		const modules = new ModuleHost({ config: loaded, log: new Logger({ console: false, level: "error" }), modules: [module], transports: [], ingest: event => events.append(event), history: HistoryStore.open(loaded.paths.stateDir), outbox: () => [], runtimeStatus: () => ({}) });
		try {
			await modules.init();
			const response = await new Promise<{ status: number; signature?: string; body: string }>((resolve, reject) => {
				const request = http.get(module.localEndpoint() + "/.well-known/http-message-signatures-directory", { headers: { Host: "identity.test" } }, incoming => {
					let body = ""; incoming.on("data", chunk => { body += chunk; }); incoming.on("error", reject); incoming.on("end", () => resolve({ status: incoming.statusCode!, signature: incoming.headers.signature as string, body }));
				}); request.on("error", reject);
			});
			assert.equal(response.status, 200, "Clients must relay the public identity without having its private key");
			assert.ok(response.signature); assert.equal(JSON.parse(response.body).keys[0].d, undefined);
		} finally { await modules.stop(); }
	}
	for (const owner of ["first", "second"]) {
		const browser = await chromium.connect(host.endpoint().replace("http:", "ws:") + "/connect", { headers: { Authorization: `Bearer ${token}` } }); clients.push(browser);
		// TLS exceptions apply only to this disposable local HTTPS fixture.
		const context = await browser.newContext({ acceptDownloads: false, ignoreHTTPSErrors: true });
		await context.addCookies([{ name: "owner", value: owner, url: origin }]);
		await context.newPage();
		const agent = new ConversationAgentBrowser(context, () => {}, 15000); agents.push(agent);
		await agent.run(["open", `${origin}/${owner}`]);
		assert.equal((await agent.run(["get", "title"])).title, "Signed shared fixture");
		const response = await context.request.get(`${origin}/api-${owner}`); assert.equal(response.status(), 200); await response.dispose();
	}
	const redirect = await clients[0].contexts()[0].request.get(`${origin}/redirect`); assert.equal(redirect.status(), 302); await redirect.dispose();
	assert.ok(seen.length >= 5); assert.ok(seen.every(request => request.valid));
	for (const owner of ["first", "second"]) for (const prefix of ["/", "/api-"]) assert.match(seen.find(request => request.path === prefix + owner)!.cookie!, new RegExp(`owner=${owner}`));
	assert.equal(seen.some(request => request.path === "/must-not-follow"), false);
	assert.equal(new Set(seen.map(request => request.nonce)).size, seen.length);
	await clients[0].close();
	await agents[1].run(["open", `${origin}/still-signed`]); assert.ok(seen.at(-1)!.valid);
	console.log(`shared signing on ${config.engine}: one host identity across isolated clients, independently verified native agent-browser/API signatures, private cookies, fresh nonces and no signed redirects passed`);
} finally {
	for (const agent of agents) await agent.close();
	for (const client of clients) await client.close().catch(() => {}); await host.close();
	fixture.closeAllConnections(); await new Promise<void>(resolve => fixture.close(() => resolve()));
	delete process.env.ALIVE_SHARED_SIGNING_KEY; delete process.env.ALIVE_SHARED_SIGNING_TOKEN; fs.rmSync(root, { recursive: true, force: true });
}
