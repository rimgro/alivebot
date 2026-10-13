import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as http from "node:http";
import * as os from "node:os";
import * as path from "node:path";
import { chromium } from "patchright";
import type { BrowserContext, BrowserType } from "playwright";
import { loadConfig } from "../config.js";
import { ModuleHost } from "../events/host.js";
import { Logger } from "../log.js";
import { BrowserModule } from "../modules/browser/module.js";
import { DEFAULT_BROWSER_CONFIG } from "../modules/browser/config.js";
import { diagnoseBrowser } from "../modules/browser/diagnostics.js";
import { EventStore } from "../store/events.js";
import { HistoryStore } from "../store/history.js";

const root = fs.mkdtempSync(path.join(os.tmpdir(), "alive-browser-access-e2e-"));
const hosts: ModuleHost[] = [];
const headed = process.env.ALIVE_BROWSER_TEST_HEADED === "1";
const server = http.createServer((request, response) => {
	const route = new URL(request.url!, "http://fixture").pathname;
	response.setHeader("Content-Type", "text/html; charset=utf-8");
	response.setHeader("Cache-Control", "no-store");
	if (route === "/wb-auto") {
		response.writeHead(498);
		response.end('<title>Проверяем браузер</title><p>Проверка на бота</p><script>setTimeout(()=>location.href="/ready",450)</script>');
	} else if (route === "/auto-no-header") {
		response.writeHead(403);
		response.end('<title>Just a moment...</title><div id="challenge-running">Checking browser</div><script>setTimeout(()=>location.href="/ready",450)</script>');
	} else if (route === "/auto" || route === "/auto-form") {
		response.writeHead(403, { "cf-mitigated": "challenge" });
		response.end(`<title>Just a moment...</title><${route === "/auto-form" ? 'form id="challenge-form"' : 'div id="challenge-running"'}>Checking browser</${route === "/auto-form" ? "form" : "div"}><script>setTimeout(()=>location.href="/ready",450)</script>`);
	} else if (route === "/auto-inline") {
		response.writeHead(200, { "cf-mitigated": "challenge" });
		response.end('<title>Checking your browser...</title><div id="challenge-running">Checking browser</div><script>setTimeout(()=>{document.querySelector("#challenge-running").remove();document.title="Fixture ready";document.body.append("Ready after inline check")},450)</script>');
	} else if (route === "/stuck") {
		response.writeHead(403, { "cf-mitigated": "challenge" });
		response.end('<title>Just a moment...</title><div id="challenge-running">Checking browser</div>');
	} else if (route === "/private") {
		response.writeHead(200, { "cf-mitigated": "challenge" });
		response.end('<title>Checking your browser...</title><div id="challenge-running">Checking browser</div><script>setTimeout(()=>{document.title="Private fixture";document.body.innerHTML=\'<input type="password" value="SyntheticPrivateValue">\'},300)</script>');
	} else if (route === "/manual") {
		response.end('<title>Manual fixture</title><form id="challenge-form"><button type="button" onclick="this.parentElement.remove();document.body.append(\'Ready after manual completion\')">Complete test check</button></form>');
	} else if (route === "/smart") {
		response.end('<title>SmartCaptcha fixture</title><div class="smart-captcha" style="min-height:80px"><input type="hidden" name="smart-token"><button type="button" onclick="document.querySelector(\'[name=smart-token]\').value=\'synthetic-completed\';document.body.append(\'Ready after manual completion\')">Complete test check</button></div>');
	} else if (route === "/denied200") {
		response.end('<title>Доступ ограничен — тест</title>Access denied');
	} else if (route === "/439" || route === "/498") {
		response.writeHead(Number(route.slice(1))); response.end('<title>Unavailable fixture</title>Page not served');
	} else if (route === "/denied" || route === "/api-denied") {
		response.writeHead(403); response.end('<title>Denied fixture</title>Access denied');
	} else if (route === "/limited") {
		response.writeHead(429, { "X-Ratelimit-Retry": "2" }); response.end('<title>Limited fixture</title>Wait');
	} else response.end('<title>Fixture ready</title><p>Ready for normal browsing</p><input id="normal">');
});
await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
const origin = `http://127.0.0.1:${(server.address() as { port: number }).port}`;

async function fixture(wait = 1500, customExecutable = false) {
	const loaded = loadConfig({ cwd: fs.mkdtempSync(path.join(root, "session-")) });
	const messages: string[] = [];
	let context: BrowserContext | undefined;
	const module = new BrowserModule({ port: 0, headless: !headed, challengeWaitMs: wait, minActionIntervalMs: 0, minNavigationIntervalMs: 0, humanization: { enabled: false }, ...(customExecutable ? { executablePathEnv: "ALIVE_ACCESS_TEST_EXECUTABLE" } : {}) }, {
		launch: (async (profile, options) => { context = await chromium.launchPersistentContext(profile, options) as unknown as BrowserContext; return context; }) as BrowserType["launchPersistentContext"],
		notify: async url => { messages.push(url); },
	});
	const store = EventStore.open(loaded.paths.stateDir);
	const host = new ModuleHost({ config: loaded, log: new Logger({ console: false }), transports: [], modules: [module], ingest: event => store.append(event), outbox: () => [], history: HistoryStore.open(loaded.paths.stateDir), runtimeStatus: () => ({}) });
	hosts.push(host); await host.init();
	return { module, messages, page: () => context!.pages()[0] };
}

async function claim(link: string) {
	const url = new URL(link), base = url.origin;
	const response = await fetch(`${base}/browser/claim`, { method: "POST", headers: { Authorization: `Bearer ${url.hash.slice(1)}`, "Content-Type": "application/json" }, body: "{}" });
	assert.equal(response.status, 200);
	const { credential } = await response.json() as { credential: string };
	return { base, credential };
}

try {
	for (const route of ["/auto", "/auto-form", "/auto-inline", "/auto-no-header", "/wb-auto"]) {
		const test = await fixture();
		const result = await test.module.command({ action: "navigate", url: `${origin}${route}` });
		assert.equal(result.details.paused, false, "Automatic checks may finish without human assistance");
		assert.deepEqual((result.details.access as { state: string }).state, "ready");
		assert.equal(test.messages.length, 0, "No controller notification for a completed passive check");
		const read = await test.module.command({ action: "read" });
		assert.match(String(read.details.text), /Ready/);
		assert.equal(typeof result.details.browserVersion, "string");
		assert.equal(result.details.headless, !headed);
		await test.module.command({ action: "close" });
	}

	const stuck = await fixture(650);
	const stuckResult = await stuck.module.command({ action: "navigate", url: `${origin}/stuck` });
	assert.equal(stuckResult.details.paused, true);
	assert.equal((stuckResult.details.access as { state: string }).state, "verification");
	assert.equal(stuck.messages.length, 1, "An unfinished check gets one human handoff");
	assert.ok((await stuck.module.command({ action: "click", selector: "body" })).details.error);
	assert.equal(stuck.messages.length, 1);
	await stuck.module.command({ action: "close" });

	const privateEntry = await fixture();
	const privateResult = await privateEntry.module.command({ action: "navigate", url: `${origin}/private` });
	assert.equal((privateResult.details.access as { state: string }).state, "private-entry");
	assert.equal(privateEntry.messages.length, 1);
	assert.ok(!JSON.stringify(privateResult).includes("SyntheticPrivateValue"));
	assert.ok((await privateEntry.module.command({ action: "read" })).details.error);
	assert.ok((await privateEntry.module.command({ action: "screenshot" })).details.error);
	await privateEntry.module.command({ action: "close" });

	for (const route of ["/manual", "/smart"]) {
	const manual = await fixture();
	await manual.module.command({ action: "navigate", url: `${origin}${route}` });
	assert.equal((manual.module.status().access as { state: string }).state, "verification");
	const operator = await claim(manual.messages[0]);
	const box = await manual.page().locator("button").boundingBox(); assert.ok(box);
	for (const type of ["down", "up"]) {
		const response = await fetch(`${operator.base}/browser/input`, { method: "POST", headers: { Authorization: `Bearer ${operator.credential}`, "Content-Type": "application/json" }, body: JSON.stringify({ type, x: box.x + box.width / 2, y: box.y + box.height / 2 }) });
		assert.equal(response.status, 200);
	}
	await new Promise(resolve => setTimeout(resolve, 100));
	assert.equal(manual.module.status().paused, true, "Finishing the widget does not silently reclaim a human session");
	const resumed = await fetch(`${operator.base}/browser/resume`, { method: "POST", headers: { Authorization: `Bearer ${operator.credential}`, "Content-Type": "application/json" }, body: "{}" });
	assert.equal(resumed.status, 200);
	assert.match(String((await manual.module.command({ action: "read" })).details.text), /Ready after manual/);
	await manual.module.command({ action: "close" });
	}

	for (const route of ["/denied", "/denied200"]) {
	const denied = await fixture();
	await denied.module.command({ action: "navigate", url: `${origin}${route}` });
	assert.equal((denied.module.status().access as { state: string }).state, "denied");
	assert.equal(denied.messages.length, 1);
	assert.ok((await denied.module.command({ action: "navigate", url: `${origin}/ready` })).details.error, "A denial is not automatically retried");
	await denied.module.command({ action: "close" });
	}
	const limited = await fixture();
	await limited.module.command({ action: "navigate", url: `${origin}/limited` });
	assert.equal((limited.module.status().access as { state: string }).state, "rate-limited");
	assert.ok(Number(limited.module.status().retryAt) > Date.now());
	assert.ok((await limited.module.command({ action: "navigate", url: `${origin}/ready` })).details.error);
	await limited.module.command({ action: "close" });
	for (const route of ["/439", "/498"]) {
		const test = await fixture();
		const result = await test.module.command({ action: "navigate", url: `${origin}${route}` });
		assert.equal((result.details.access as { state: string }).state, "http-error");
		assert.equal(result.details.notificationSent, true);
		assert.equal(test.messages.length, 1);
		assert.ok((await test.module.command({ action: "read" })).details.error);
		const operator = await claim(test.messages[0]);
		const response = await fetch(`${operator.base}/browser/resume`, { method: "POST", headers: { Authorization: `Bearer ${operator.credential}`, "Content-Type": "application/json" }, body: "{}" });
		assert.equal(response.status, 409, "An unusual HTTP failure is not successful verification");
		await test.module.command({ action: "close" });
	}

	const api = await fixture();
	await api.module.command({ action: "navigate", url: `${origin}/ready` });
	const apiResponse = await api.module.command({ action: "request", url: `${origin}/api-denied` });
	assert.equal(apiResponse.details.requestAccess, "denied");
	assert.equal(apiResponse.details.paused, false, "A separate API-client denial does not mislabel the page");
	assert.equal(api.messages.length, 0, "Do not send a controller for an unrelated API rejection");
	assert.match(String((await api.module.command({ action: "read" })).details.text), /Ready/);
	await api.module.command({ action: "close" });

	const cancelled = await fixture(5000);
	const abort = new AbortController();
	const pending = cancelled.module.command({ action: "navigate", url: `${origin}/stuck` }, abort.signal);
	setTimeout(() => abort.abort(), 300);
	await assert.rejects(() => pending, /abort/i);
	await cancelled.module.stop();
	assert.equal(cancelled.messages.length, 0, "Cancellation must not manufacture a human notification");

	const executable = process.platform === "darwin" ? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" : chromium.executablePath();
	process.env.ALIVE_ACCESS_TEST_EXECUTABLE = executable;
	const custom = await fixture(1500, true);
	const customResult = await custom.module.command({ action: "navigate", url: `${origin}/ready` });
	assert.equal(customResult.details.engine, "custom-chromium");
	await custom.module.command({ action: "close" });
	delete process.env.ALIVE_ACCESS_TEST_EXECUTABLE;

	const report = await diagnoseBrowser({ ...DEFAULT_BROWSER_CONFIG, headless: !headed });
	assert.equal(report.environment.headlessMarker, !headed);
	assert.equal(report.environment.webdriver, false);
	assert.equal(report.canvas.passed, true);
	console.log(`browser access E2E passed (${headed ? "headed" : "headless"} Chrome): passive checks, timeout handoff, private entry, human return, denial, API isolation, cancellation, custom executable and diagnostics`);
} finally {
	delete process.env.ALIVE_ACCESS_TEST_EXECUTABLE;
	for (const host of hosts) await host.stop();
	server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve()));
	fs.rmSync(root, { recursive: true, force: true });
}
