import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as http from "node:http";
import * as os from "node:os";
import * as path from "node:path";
import { chromium } from "patchright";
import { chromeExecutable, launchNativeBrowser, type NativeBrowser } from "../modules/browser/native.js";

const root = fs.mkdtempSync(path.join(os.tmpdir(), "alive-native-lifecycle-"));
const processes: NativeBrowser[] = [];
const server = http.createServer((request, response) => {
	if (request.url === "/json/version") { response.setHeader("Content-Type", "application/json"); response.end(JSON.stringify({ webSocketDebuggerUrl: "ws://127.0.0.1:1/devtools/browser/wrong" })); return; }
	response.setHeader("Content-Type", "text/html");
	response.setHeader("Set-Cookie", "native_fixture=persistent; Max-Age=3600; Path=/");
	response.end('<title>Native lifecycle fixture</title><p>Native browser ready</p><script>localStorage.setItem("native-fixture","persistent")</script>');
});
await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
const url = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
const settings = { executable: chromeExecutable(), headless: false, warmupMs: 400, timeoutMs: 15_000, signal: new AbortController().signal };
try {
	const profile = path.join(root, "profile");
	const first = await launchNativeBrowser({ ...settings, profile, initialUrl: url }); processes.push(first);
	let browser = await chromium.connectOverCDP(first.endpoint, { noDefaults: true });
	const page = browser.contexts()[0].pages().find(page => page.url().startsWith(url))!;
	assert.ok(page);
	assert.equal(await page.evaluate("navigator.webdriver"), false, "Native startup must not enable the WebDriver flag");
	assert.ok(!await page.evaluate("navigator.userAgent.includes('HeadlessChrome')"));
	await page.locator("p").waitFor();
	await browser.close();
	const adopted = await launchNativeBrowser({ ...settings, profile }); processes.push(adopted);
	assert.equal(adopted.endpoint, first.endpoint, "A verified owned process is adopted, not duplicated");
	await adopted.close();
	assert.equal(fs.existsSync(path.join(profile, "alive-native-owner.json")), false, "Graceful cleanup removes the ownership marker");
	await first.close();

	const restarted = await launchNativeBrowser({ ...settings, profile, initialUrl: url }); processes.push(restarted);
	browser = await chromium.connectOverCDP(restarted.endpoint, { noDefaults: true });
	assert.equal((await browser.contexts()[0].cookies(url)).find(cookie => cookie.name === "native_fixture")?.value, "persistent");
	assert.equal(await browser.contexts()[0].pages()[0].evaluate("localStorage.getItem('native-fixture')"), "persistent");
	await browser.close(); await restarted.close();

	const foreign = path.join(root, "foreign"); fs.mkdirSync(foreign);
	fs.writeFileSync(path.join(foreign, "alive-native-owner.json"), JSON.stringify({ pid: process.pid, endpoint: url, websocket: `${url.replace('http:', 'ws:')}/devtools/browser/wrong` }), { mode: 0o600 });
	await assert.rejects(() => launchNativeBrowser({ ...settings, profile: foreign }), /cannot be verified/);
	assert.doesNotThrow(() => process.kill(process.pid, 0), "An unverifiable PID must never be killed");

	const cancelledProfile = path.join(root, "cancelled"), cancel = new AbortController();
	const pending = launchNativeBrowser({ ...settings, profile: cancelledProfile, initialUrl: url, warmupMs: 5000, signal: cancel.signal });
	setTimeout(() => cancel.abort(), 500);
	await assert.rejects(() => pending, /abort/i);
	assert.equal(fs.existsSync(path.join(cancelledProfile, "alive-native-owner.json")), false, "Cancellation must clean up its verified process");
	console.log("native browser lifecycle passed: nonzero loopback port, native WebDriver state, owned-process adoption, persistent profile, graceful cleanup, foreign PID refusal and startup cancellation");
} finally {
	for (const process of processes) await process.close();
	server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve()));
	fs.rmSync(root, { recursive: true, force: true });
}
