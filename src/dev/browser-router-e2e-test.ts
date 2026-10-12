import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as http from "node:http";
import * as os from "node:os";
import * as path from "node:path";
import { chromium, type BrowserContext } from "playwright";
import { loadConfig } from "../config.js";
import { ModuleHost } from "../events/host.js";
import { Logger } from "../log.js";
import { BrowserRouter } from "../modules/browser/router.js";
import { DEFAULT_HUMANIZATION } from "../modules/browser/config.js";
import { EventStore } from "../store/events.js";
import { HistoryStore } from "../store/history.js";

declare const document: { querySelector(selector: string): { value: string; naturalWidth: number } };
const root = fs.mkdtempSync(path.join(os.tmpdir(), "alive-browser-router-e2e-"));
const fixture = http.createServer((request, response) => {
	if (request.url === "/favicon.ico") { response.writeHead(204); response.end(); return; }
	const owner = new URL(request.url!, "http://fixture").searchParams.get("owner") || "none";
	response.writeHead(200, { "Content-Type": "text/html", "Set-Cookie": `fixture_owner=${owner}; Path=/` });
	response.end(`<!doctype html><title>Browser ${owner}</title><h1>Owner ${owner}</h1><input id="target"><div id="challenge-form"><button id="done" onclick="this.parentElement.remove()">Manual fixture completion</button></div><script>localStorage.setItem('owner','${owner}')</script>`);
});
await new Promise<void>(resolve => fixture.listen(0, "127.0.0.1", resolve));
const target = `http://127.0.0.1:${(fixture.address() as { port: number }).port}`;
const initial = loadConfig({ cwd: root });
const loaded = loadConfig({ cwd: root, overrides: { modules: { ...initial.config.modules, telegram: { ...initial.config.modules.telegram, enabled: true, token: "fixture-only", allowedUserIds: ["111", "222"] } } } });
let scope = ["telegram:111"];
const contexts: BrowserContext[] = [];
const links: Array<{ thread: string; url: string }> = [];
const driver = process.env.ALIVE_BROWSER_TEST_DRIVER === "playwright" ? "playwright" : "patchright";
const engine = driver === "patchright" ? (await import("patchright")).chromium : chromium;
const router = new BrowserRouter({ port: 0, viewport: { width: 900, height: 720 }, driver, headless: true, minActionIntervalMs: 0, humanization: { ...DEFAULT_HUMANIZATION, enabled: false } }, {
	launch: async (directory, options) => { const context = await engine.launchPersistentContext(directory, options) as unknown as BrowserContext; contexts.push(context); return context; },
	notify: async url => { const id = new URL(url).pathname.split("/").at(-1); const thread = ["telegram:111", "telegram:222"].find(value => createHash("sha256").update(value).digest("hex").slice(0, 24) === id)!; links.push({ thread, url }); return { thread, messageId: links.length }; },
});
const events = EventStore.open(loaded.paths.stateDir);
const host = new ModuleHost({ config: loaded, log: new Logger({ console: false, level: "error" }), modules: [router], transports: [], ingest: event => events.append(event), history: HistoryStore.open(loaded.paths.stateDir), outbox: () => [], runtimeStatus: () => ({}), currentThreads: () => scope });
let operator: Awaited<ReturnType<typeof chromium.launch>> | undefined;
try {
	await host.init();
	await router.command({ action: "navigate", url: `${target}/?owner=111` });
	assert.deepEqual(links.map(value => value.thread), ["telegram:111"]);
	scope = ["telegram:222"];
	await router.command({ action: "navigate", url: `${target}/?owner=222` });
	assert.deepEqual(links.map(value => value.thread), ["telegram:111", "telegram:222"]);
	assert.equal((await contexts[0].cookies(target)).find(cookie => cookie.name === "fixture_owner")?.value, "111");
	assert.equal((await contexts[1].cookies(target)).find(cookie => cookie.name === "fixture_owner")?.value, "222");
	assert.equal(await contexts[0].pages()[0].evaluate("localStorage.getItem('owner')"), "111");
	assert.equal(await contexts[1].pages()[0].evaluate("localStorage.getItem('owner')"), "222");
	assert.ok(events.all().filter(event => event.source === "browser").every(event => ["telegram:111", "telegram:222"].includes(event.thread!)), "Automatic assistance and return events must identify their owner");
	operator = await chromium.launch({ channel: "chrome", headless: true });
	const phone = await operator.newPage({ viewport: { width: 375, height: 812 }, hasTouch: true, isMobile: true });
	let websockets = 0; phone.on("websocket", () => websockets++);
	await phone.goto(links[0].url);
	await phone.waitForFunction(() => document.querySelector("#frame").naturalWidth > 0);
	assert.equal(websockets, 1, "Routed sessions must retain native binary WebSocket streaming");
	const native = contexts[0].pages()[0];
	const click = async (selector: string) => {
		await phone.locator("#frame").scrollIntoViewIfNeeded();
		const image = (await phone.locator("#frame").boundingBox())!, element = (await native.locator(selector).boundingBox())!;
		await phone.touchscreen.tap(image.x + (element.x + element.width / 2) * image.width / 900, image.y + (element.y + element.height / 2) * image.height / 720);
	};
	await click("#target");
	await phone.getByLabel("Текст в выбранное поле браузера").fill("First user's input");
	await phone.getByRole("button", { name: "Ввести текст", exact: true }).click();
	await native.waitForFunction(() => document.querySelector("#target").value === "First user's input");
	assert.equal(await contexts[1].pages()[0].locator("#target").inputValue(), "", "First user's controller must never type into the second page");
	await click("#done"); await native.locator("#challenge-form").waitFor({ state: "detached" });
	await phone.getByRole("button", { name: "Готово — вернуть агенту" }).click();
	await phone.locator("#status").filter({ hasText: "Управление возвращено агенту" }).waitFor();
	scope = ["telegram:111"];
	assert.equal((await router.command({ action: "status" })).details.paused, false);
	scope = ["telegram:222"];
	assert.equal((await router.command({ action: "status" })).details.paused, true, "Returning one user's browser must not resume another");
	await phone.goto(links[1].url); await phone.waitForFunction(() => document.querySelector("#frame").naturalWidth > 0);
	const before = links.length; await router.command({ action: "close" });
	assert.equal(links.length, before);
	await phone.locator("#status").filter({ hasText: "Сессия управления завершена" }).waitFor();
	console.log(`Browser routing E2E passed (${driver}): isolated real profiles/cookies/storage, mobile routed WebSocket, same-owner input/return, cross-user pause isolation and cancellation`);
} finally {
	await operator?.close(); await host.stop(); fixture.closeAllConnections(); await new Promise<void>(resolve => fixture.close(() => resolve())); fs.rmSync(root, { recursive: true, force: true });
}
