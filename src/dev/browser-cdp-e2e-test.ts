import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { generateKeyPairSync } from "node:crypto";
import * as fs from "node:fs";
import * as http from "node:http";
import * as os from "node:os";
import * as path from "node:path";
import { chromium, type Browser } from "playwright";
import { loadConfig } from "../config.js";
import { ModuleHost } from "../events/host.js";
import { Logger } from "../log.js";
import { DEFAULT_BROWSER_CONFIG } from "../modules/browser/config.js";
import { diagnoseBrowser } from "../modules/browser/diagnostics.js";
import { BrowserModule } from "../modules/browser/module.js";
import { EventStore } from "../store/events.js";
import { HistoryStore } from "../store/history.js";
import { sleep } from "../util.js";

// External Chrome exercises the same CDP attachment boundary as Fortress.
// This test does not claim to execute or certify a Fortress release.
const root = fs.mkdtempSync(path.join(os.tmpdir(), "alive-cdp-e2e-"));
const profile = path.join(root, "external-profile");
const executable = process.env.ALIVE_BROWSER_TEST_EXECUTABLE || (process.platform === "darwin"
	? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" : chromium.executablePath());
const child = spawn(executable, ["--headless=new", "--remote-debugging-address=127.0.0.1", "--remote-debugging-port=0", `--user-data-dir=${profile}`, "--no-first-run", "--no-default-browser-check", "about:blank"], { stdio: "ignore" });
let spawnError: Error | undefined;
child.once("error", error => { spawnError = error; });
let owner: Browser | undefined, host: ModuleHost | undefined;
const fixture = http.createServer((req, res) => {
	res.writeHead(200, { "content-type": "text/html", "set-cookie": "fixture=cdp; Path=/" });
	if (req.url === "/password") {
		res.end('<title>Private login fixture</title><form action="/ready"><input id="password" type="password"><button>Log in</button></form>'); return;
	}
	if (req.url === "/otp") {
		res.end('<input id="code" autocomplete="one-time-code">'); return;
	}
	if (req.url === "/delayed") {
		res.end('<title>Delayed login fixture</title><p>Waiting</p><script>setTimeout(()=>{const f=document.createElement("iframe");f.src="/otp";document.body.append(f)},1200)</script>'); return;
	}
	res.end('<title>Existing CDP session</title><p id="ready">Session ready</p><input id="target">');
});

async function eventually(check: () => boolean, label: string): Promise<void> {
	for (let i = 0; i < 100 && !check(); i++) await sleep(100);
	assert.ok(check(), label);
}
async function claim(module: BrowserModule): Promise<{ origin: string; credential: string }> {
	const response = await module.command({ action: "handoff" });
	const url = new URL(response.details.operatorUrl as string);
	const activation = await post(url.origin, "claim", url.hash.slice(1));
	assert.equal(activation.status, 200);
	return { origin: url.origin, credential: (await activation.json() as { credential: string }).credential };
}
function post(origin: string, endpoint: string, credential: string, body: unknown = {}) {
	return fetch(`${origin}/browser/${endpoint}`, { method: "POST", headers: { authorization: `Bearer ${credential}`, "content-type": "application/json", origin }, body: JSON.stringify(body) });
}

try {
	await eventually(() => !!spawnError || fs.existsSync(path.join(profile, "DevToolsActivePort")), "External browser must publish its local CDP port");
	if (spawnError) throw spawnError;
	const [port] = fs.readFileSync(path.join(profile, "DevToolsActivePort"), "utf8").trim().split("\n");
	process.env.ALIVE_TEST_CDP_ENDPOINT = `http://127.0.0.1:${port}`;
	await new Promise<void>(resolve => fixture.listen(0, "127.0.0.1", resolve));
	const target = `http://127.0.0.1:${(fixture.address() as { port: number }).port}`;
	owner = await chromium.connectOverCDP(process.env.ALIVE_TEST_CDP_ENDPOINT, { noDefaults: true });
	const context = owner.contexts()[0], page = context.pages()[0];
	await page.goto(target);
	await page.evaluate("localStorage.setItem('persistent', 'existing-session')");
	const driver = process.env.ALIVE_BROWSER_TEST_DRIVER === "playwright" ? "playwright" : "patchright";
	const report = await diagnoseBrowser({ ...DEFAULT_BROWSER_CONFIG, driver, cdpEndpointEnv: "ALIVE_TEST_CDP_ENDPOINT" });
	assert.equal(report.canvas.passed, true, JSON.stringify(report));
	assert.deepEqual(report.canvas.blank, [0, 0, 0, 0]);
	assert.equal(context.pages().length, 1, "Diagnostics must close only their temporary tab");
	assert.equal(page.url(), `${target}/`, "Diagnostics must preserve the current page");
	const keyFile = path.join(root, "identity.pem");
	fs.writeFileSync(keyFile, generateKeyPairSync("ed25519").privateKey.export({ type: "pkcs8", format: "pem" }), { mode: 0o600 });
	process.env.ALIVE_TEST_CDP_KEY = keyFile;
	const module = new BrowserModule({ port: 0, driver, cdpEndpointEnv: "ALIVE_TEST_CDP_ENDPOINT", minActionIntervalMs: 0, humanization: { enabled: false }, signing: { enabled: true, agentUrl: "https://identity.test", keyFileEnv: "ALIVE_TEST_CDP_KEY", origins: ["https://approved.test"] } });
	const loaded = loadConfig({ cwd: root }), events = EventStore.open(loaded.paths.stateDir);
	host = new ModuleHost({ config: loaded, log: new Logger({ console: false, level: "error" }), transports: [], modules: [module], ingest: event => events.append(event), outbox: () => [], history: HistoryStore.open(loaded.paths.stateDir), runtimeStatus: () => ({}) });
	await host.init();
	assert.match((await module.command({ action: "read" })).details.text as string, /Session ready/);
	assert.equal(module.status().connection, "cdp");
	assert.equal(module.status().url, page.url(), "Attach must adopt the existing page without navigating it");
	assert.equal(fs.existsSync(path.join(loaded.paths.modulesDir, "browser", "profile")), false, "Attach must not create a second profile");
	await module.command({ action: "close" });
	assert.ok(owner.isConnected(), "Detaching Alive must keep the external browser alive");
	await page.goto(`${target}/ready`, { timeout: 5000 });
	assert.equal(await page.evaluate("localStorage.getItem('persistent')"), "existing-session");
	assert.ok((await context.cookies()).some(cookie => cookie.name === "fixture"));
	await module.command({ action: "navigate", url: `${target}/password` });
	assert.equal(module.status().paused, true, "Password input must automatically request private human entry");
	assert.equal((await module.command({ action: "fill", selector: "#password", text: "must-not-be-entered" })).details.error !== undefined, true);
	assert.equal(await page.locator("#password").inputValue(), "");
	assert.equal((await module.command({ action: "read" })).details.text, undefined, "Private login must not be read into agent results");
	assert.equal((await module.command({ action: "screenshot" })).content[0].type, "text", "Private login must not produce an agent screenshot");
	const control = await claim(module);
	const frame = await fetch(`${control.origin}/browser/frame`, { headers: { authorization: `Bearer ${control.credential}` } });
	assert.equal(frame.status, 200);
	assert.equal(frame.headers.get("content-type"), "image/jpeg");
	assert.ok((await frame.arrayBuffer()).byteLength > 1000);
	await page.locator("#password").focus();
	assert.equal((await post(control.origin, "input", control.credential, { type: "text", text: "local-fixture-password" })).status, 200);
	assert.equal(await page.locator("#password").inputValue(), "local-fixture-password");
	assert.equal((await post(control.origin, "resume", control.credential)).status, 409, "Visible private entry must prevent premature resume");
	await post(control.origin, "input", control.credential, { type: "key", key: "Enter" });
	await page.waitForURL(url => url.origin === target && url.pathname === "/ready");
	assert.equal((await post(control.origin, "resume", control.credential)).status, 200);
	assert.equal(module.status().paused, false);
	assert.equal((await post(control.origin, "input", control.credential, { type: "key", key: "Enter" })).status, 401);
	await module.command({ action: "navigate", url: `${target}/delayed` });
	assert.equal(module.status().paused, false);
	await eventually(() => module.status().paused === true, "Idle observer must catch private code entry in a newly loaded iframe");
	const interrupted = await claim(module);
	child.kill("SIGTERM");
	await eventually(() => module.status().open === false, "External browser shutdown must invalidate the attachment");
	assert.equal(module.status().paused, true);
	assert.equal(module.status().handoff, undefined, "Disconnect must revoke phone access");
	assert.equal((await post(interrupted.origin, "input", interrupted.credential, { type: "key", key: "Enter" })).status, 401);
	assert.ok((await module.command({ action: "read" })).details.error, "Disconnect must not silently launch another browser");
	assert.ok(!JSON.stringify(events.peekPending(100)).includes("local-fixture-password"), "Private input must not enter event history");
	console.log(`CDP attachment, native canvas, private login, phone input, detach and disconnect tests passed (${driver})`);
} finally {
	await host?.stop();
	await owner?.close().catch(() => {});
	if (child.exitCode === null && child.signalCode === null) {
		child.kill("SIGTERM");
		await Promise.race([new Promise<void>(resolve => child.once("exit", () => resolve())), sleep(3000)]);
		if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
	}
	fixture.closeAllConnections();
	await new Promise<void>(resolve => fixture.close(() => resolve()));
	fs.rmSync(root, { recursive: true, force: true });
	delete process.env.ALIVE_TEST_CDP_ENDPOINT;
	delete process.env.ALIVE_TEST_CDP_KEY;
}
