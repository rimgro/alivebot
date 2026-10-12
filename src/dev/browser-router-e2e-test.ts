import assert from "node:assert/strict";
import { createHash, createHmac } from "node:crypto";
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
	response.end(`<!doctype html><title>Browser ${owner}</title><h1>Owner ${owner}</h1><input id="target"><div id="challenge-form" style="min-height:40px"><button id="done" style="position:fixed;bottom:24px;left:16px;height:40px;font-size:16px" onclick="this.parentElement.remove()">Manual fixture completion</button></div><script>localStorage.setItem('owner','${owner}');for(const type of ['mousedown','mouseup','click'])document.addEventListener(type,e=>document.body.dataset[type]=JSON.stringify({x:e.clientX,y:e.clientY,target:e.target.id}))</script>`);
});
await new Promise<void>(resolve => fixture.listen(0, "127.0.0.1", resolve));
const target = `http://127.0.0.1:${(fixture.address() as { port: number }).port}`;
const initial = loadConfig({ cwd: root });
const loaded = loadConfig({ cwd: root, overrides: { modules: { ...initial.config.modules, telegram: { ...initial.config.modules.telegram, enabled: true, token: "fixture-only", tokenEnv: "UNSET_ROUTER_E2E_TOKEN", allowedUserIds: ["111", "222"] } } } });
let scope = ["telegram:111"];
const contexts: BrowserContext[] = [];
const links: Array<{ thread: string; url: string }> = [];
const driver = process.env.ALIVE_BROWSER_TEST_DRIVER === "playwright" ? "playwright" : "patchright";
const engine = driver === "patchright" ? (await import("patchright")).chromium : chromium;
const nativeViewport = process.env.ALIVE_BROWSER_TEST_NATIVE_VIEWPORT === "1";
const forceCompatibility = process.env.ALIVE_BROWSER_TEST_VIEWPORT_FALLBACK === "1";
const router = new BrowserRouter({ port: 0, viewport: nativeViewport ? null : { width: 900, height: 720 }, driver, headless: process.env.ALIVE_BROWSER_TEST_HEADED !== "1", minActionIntervalMs: 0, humanization: { ...DEFAULT_HUMANIZATION, enabled: false } }, {
	launch: async (directory, options) => {
		const context = await engine.launchPersistentContext(directory, options) as unknown as BrowserContext;
		if (forceCompatibility) {
			const connect = context.newCDPSession.bind(context);
			context.newCDPSession = async page => {
				const cdp = await connect(page), send = cdp.send.bind(cdp);
				cdp.send = (async (method, params) => { if (method === "Browser.setContentsSize") throw new Error("Fixture old-engine resize rejection"); return send(method, params); }) as typeof cdp.send;
				return cdp;
			};
		}
		contexts.push(context); return context;
	},
	notify: async url => { const id = new URL(url).pathname.split("/").at(-1); const thread = ["telegram:111", "telegram:222"].find(value => createHash("sha256").update(value).digest("hex").slice(0, 24) === id)!; links.push({ thread, url }); return { thread, messageId: links.length }; },
});
const events = EventStore.open(loaded.paths.stateDir);
const host = new ModuleHost({ config: loaded, log: new Logger({ console: false, level: "error" }), modules: [router], transports: [], ingest: event => events.append(event), history: HistoryStore.open(loaded.paths.stateDir), outbox: () => [], runtimeStatus: () => ({}), currentThreads: () => scope });
let operator: Awaited<ReturnType<typeof chromium.launch>> | undefined;
const artifacts = process.env.ALIVE_BROWSER_E2E_ARTIFACT_DIR;
function identity(user: number) {
	const fields = new URLSearchParams({ auth_date: String(Math.floor(Date.now() / 1000)), user: JSON.stringify({ id: user, first_name: "Fixture" }) });
	const check = [...fields].sort(([a], [b]) => a.localeCompare(b)).map(([key, value]) => `${key}=${value}`).join("\n");
	fields.set("hash", createHmac("sha256", createHmac("sha256", "WebAppData").update("fixture-only").digest()).update(check).digest("hex"));
	return fields.toString();
}
try {
	await host.init();
	const share = host.contributedTools().find(tool => tool.name === "browser_share")!;
	const prepared = await share.execute("loaded-share", { url: `${target}/?owner=111`, thread: "telegram:111", reason: "Load before sending the pult" } as never, undefined, undefined, {} as never) as { details: Record<string, unknown> };
	assert.equal(prepared.details.url, `${target}/?owner=111`, "The agent's atomic share tool must load the target before delivery");
	assert.deepEqual(links.map(value => value.thread), ["telegram:111"]);
	scope = ["telegram:222"];
	await router.command({ action: "navigate", url: `${target}/?owner=222` });
	assert.deepEqual(links.map(value => value.thread), ["telegram:111", "telegram:222"]);
	assert.equal((await contexts[0].cookies(target)).find(cookie => cookie.name === "fixture_owner")?.value, "111");
	assert.equal((await contexts[1].cookies(target)).find(cookie => cookie.name === "fixture_owner")?.value, "222");
	assert.equal(await contexts[0].pages()[0].evaluate("localStorage.getItem('owner')"), "111");
	assert.equal(await contexts[1].pages()[0].evaluate("localStorage.getItem('owner')"), "222");
	const originalViewport = await contexts[0].pages()[0].evaluate("({width:innerWidth,height:innerHeight})");
	assert.ok(events.all().filter(event => event.source === "browser").every(event => ["telegram:111", "telegram:222"].includes(event.thread!)), "Automatic assistance and return events must identify their owner");
	operator = await chromium.launch({ channel: "chrome", headless: true });
	const originalContext = await operator.newContext({ viewport: { width: 375, height: 812 }, hasTouch: true, isMobile: true });
	let phone = await originalContext.newPage();
	let websockets = 0; phone.on("websocket", () => websockets++);
	await phone.goto(links[0].url);
	await phone.waitForFunction(() => document.querySelector("#frame").naturalWidth > 0);
	assert.equal(websockets, 1, "Routed sessions must retain native binary WebSocket streaming");
	await phone.close();
	phone = await originalContext.newPage(); await phone.goto(links[0].url);
	await phone.waitForFunction(() => document.querySelector("#frame").naturalWidth > 0);
	assert.equal(links.length, 2, "Accidental closure and reopening must not require another bot message");
	await originalContext.close();
	const recoveredContext = await operator.newContext({ viewport: { width: 375, height: 812 }, hasTouch: true, isMobile: true });
	const initData = identity(111);
	await recoveredContext.addInitScript(`window.Telegram={WebApp:{initData:${JSON.stringify(initData)},ready(){},expand(){},enableClosingConfirmation(){},disableClosingConfirmation(){},isVersionAtLeast(){return false},onEvent(){}}}`);
	phone = await recoveredContext.newPage();
	const errors: string[] = []; phone.on("pageerror", error => errors.push(error.message));
	const recoveredLink = new URL(links[0].url); recoveredLink.hash = `aliveKey=${recoveredLink.hash.slice(1)}&tgWebAppData=${encodeURIComponent(initData)}&tgWebAppVersion=8.0`;
	await phone.goto(recoveredLink.href);
	await phone.waitForFunction(() => document.querySelector("#frame").naturalWidth === 500 && (document.querySelector("#frame") as unknown as { naturalHeight: number }).naturalHeight === 812, undefined, { timeout: 8000 }).catch(async error => {
		console.error({ stage: "recovered-mobile-frame", status: await phone.locator("#status").textContent(), frame: await phone.locator("#frame").evaluate(element => ({ width: (element as unknown as { naturalWidth: number }).naturalWidth, height: (element as unknown as { naturalHeight: number }).naturalHeight })), viewport: contexts[0].pages()[0].viewportSize(), actual: await contexts[0].pages()[0].evaluate("({width:innerWidth,height:innerHeight,outerWidth,outerHeight,devicePixelRatio})"), errors }); throw error;
	});
	const wrongContext = await operator.newContext(); const wrongPhone = await wrongContext.newPage();
	const wrongLink = new URL(links[0].url); wrongLink.hash = `aliveKey=${wrongLink.hash.slice(1)}&tgWebAppData=${encodeURIComponent(identity(222))}&tgWebAppVersion=8.0`;
	await wrongPhone.addInitScript(`window.Telegram={WebApp:{ready(){},expand(){},enableClosingConfirmation(){},isVersionAtLeast(){return false},onEvent(){}}}`);
	await wrongPhone.goto(wrongLink.href); await wrongPhone.locator("#status").filter({ hasText: "другому Telegram-пользователю" }).waitFor();
	assert.equal(await wrongPhone.locator("#frame").evaluate(element => (element as unknown as { naturalWidth: number }).naturalWidth), 0);
	await wrongContext.close();
	const native = contexts[0].pages()[0];
	assert.deepEqual(native.viewportSize(), { width: 500, height: 812 }, "The phone viewport respects Chromium's minimum window width");
	const click = async (selector: string) => {
		await phone.locator("#frame").scrollIntoViewIfNeeded();
		const image = (await phone.locator("#frame").boundingBox())!, element = (await native.locator(selector).boundingBox())!;
		const viewport = native.viewportSize()!;
		await phone.touchscreen.tap(image.x + (element.x + element.width / 2) * image.width / viewport.width, image.y + (element.y + element.height / 2) * image.height / viewport.height);
	};
	await phone.getByRole("button", { name: "Во весь экран", exact: true }).click();
	assert.equal(await phone.locator("#frame").evaluate(element => { const r = (element as unknown as { getBoundingClientRect(): { height: number } }).getBoundingClientRect(); return r.height <= 740; }), true);
	if (artifacts) { fs.mkdirSync(artifacts, { recursive: true }); await phone.screenshot({ path: path.join(artifacts, `${driver}-fullscreen.png`) }); }
	await phone.getByRole("button", { name: "Вернуться к пульту", exact: true }).click();
	if (artifacts) await phone.screenshot({ path: path.join(artifacts, `${driver}-mobile.png`), fullPage: true });
	await click("#target");
	await phone.getByLabel("Текст в выбранное поле браузера").fill("First user's input");
	await phone.getByRole("button", { name: "Ввести текст", exact: true }).click();
	await native.waitForFunction(() => document.querySelector("#target").value === "First user's input");
	assert.equal(await contexts[1].pages()[0].locator("#target").inputValue(), "", "First user's controller must never type into the second page");
	await click("#done"); await native.locator("#challenge-form").waitFor({ state: "detached", timeout: 4000 }).catch(async error => {
		console.error({ stage: "fixture-confirmation", nativeEvents: await native.locator("body").evaluate(element => ({ ...(element as unknown as { dataset: Record<string, string> }).dataset })), button: await native.locator("#done").boundingBox(), image: await phone.locator("#frame").boundingBox(), state: await phone.evaluate("({remoteWidth,remoteHeight,dragging,ended})"), feedback: await phone.locator("#pointer-status").textContent() }); throw error;
	});
	await phone.getByRole("button", { name: "Готово — вернуть агенту" }).click();
	await phone.locator("#status").filter({ hasText: "Управление возвращено агенту" }).waitFor();
	assert.deepEqual(await native.evaluate("({width:innerWidth,height:innerHeight})"), originalViewport, "Returning control restores the agent's actual viewport");
	scope = ["telegram:111"];
	assert.equal((await router.command({ action: "status" })).details.paused, false);
	scope = ["telegram:222"];
	assert.equal((await router.command({ action: "status" })).details.paused, true, "Returning one user's browser must not resume another");
	await recoveredContext.close(); phone = await operator.newPage({ viewport: { width: 375, height: 812 } });
	await phone.goto(links[1].url); await phone.waitForFunction(() => document.querySelector("#frame").naturalWidth > 0);
	await phone.getByLabel("Текст в выбранное поле браузера").fill("Unsent private fixture draft");
	const before = links.length; await router.command({ action: "reclaim" });
	assert.equal(links.length, before);
	await phone.locator("#status").filter({ hasText: "Агент отозвал пульт" }).waitFor();
	assert.equal(await phone.getByLabel("Текст в выбранное поле браузера").inputValue(), "", "Terminal revocation clears unsent controller text");
	assert.equal((await router.command({ action: "status" })).details.open, true);
	assert.equal((await router.command({ action: "status" })).details.handoff, undefined);
	await router.command({ action: "close" });
	assert.equal(links.length, before);
	console.log(`Browser routing E2E passed (${driver}): isolated profiles, closure/reopen, authenticated recovery without storage, cross-account denial, mobile fit/fullscreen, same-owner input/return and agent revocation`);
} finally {
	await operator?.close(); await host.stop(); fixture.closeAllConnections(); await new Promise<void>(resolve => fixture.close(() => resolve())); fs.rmSync(root, { recursive: true, force: true });
}
