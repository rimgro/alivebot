import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as http from "node:http";
import * as os from "node:os";
import * as path from "node:path";
import { chromium, type BrowserContext } from "playwright";
import { loadConfig } from "../config.js";
import { ModuleHost } from "../events/host.js";
import { Logger } from "../log.js";
import { BrowserModule } from "../modules/browser/module.js";
import { EventStore } from "../store/events.js";
import { HistoryStore } from "../store/history.js";

// Minimal browser-global types keep the server project's Node-only tsconfig.
declare const document: { documentElement: { scrollWidth: number }; querySelector(selector: string): { naturalWidth: number; value: string } };
declare const innerWidth: number;
declare function requestAnimationFrame(callback: () => void): number;

// Runs only against local fixtures. No external CAPTCHA or website is contacted.
const root = fs.mkdtempSync(path.join(os.tmpdir(), "alive-browser-e2e-"));
const artifacts = path.join(root, "artifacts");
fs.mkdirSync(artifacts);
let destinations = 0;
let requestCookie = "";
const fixture = http.createServer((req, res) => {
	if (req.url === "/denied") { res.writeHead(403); res.end("Access denied"); return; }
	if (req.url === "/redirect") {
		requestCookie = req.headers.cookie ?? "";
		res.writeHead(302, { location: "/destination" }); res.end("Redirect"); return;
	}
	if (req.url === "/destination") destinations++;
	res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
	res.end(`<!doctype html><html lang="ru"><meta charset="utf-8"><title>Local browser fixture</title>
<style>body{padding:40px;font:18px system-ui;color:#1e2e23;background:#fafaf6}input,button{font:inherit;padding:12px;margin:12px 0}h1{font-size:26px}#challenge-form{border:1px solid #b9c8ba;padding:20px;max-width:500px}label{display:block}#drag{width:300px}#saved{margin-top:24px}</style>
<h1>Локальная тестовая страница</h1><p>Этот экран проверяет ручную передачу управления.</p>
<label>Тестовое поле <input id="target" value="initial"></label>
<label>Тест перетаскивания <input id="drag" type="range" min="0" max="100" value="0"></label>
${req.url === "/challenge" ? '<div id="challenge-form"><p>Тестовая проверка присутствия человека</p><button id="solve" onclick="this.parentElement.remove()">Подтвердить вручную</button></div>' : ""}
<p id="saved"></p><script>document.getElementById('saved').textContent='Сохранённый профиль: '+(localStorage.getItem('profile')||'новый');localStorage.setItem('profile','persistent');document.cookie='fixture=session; path=/';</script></html>`);
});
await new Promise<void>((resolve) => fixture.listen(0, "127.0.0.1", resolve));
const address = fixture.address();
const targetOrigin = `http://127.0.0.1:${typeof address === "object" && address ? address.port : 0}`;
const loaded = loadConfig({ cwd: root });
const log = new Logger({ console: false, level: "error" });
const store = EventStore.open(loaded.paths.stateDir);
let nativeContext: BrowserContext;
const browser = new BrowserModule({ port: 0, headless: true, minActionIntervalMs: 0 }, {
	launch: async (directory, options) => {
		nativeContext = await chromium.launchPersistentContext(directory, options);
		return nativeContext;
	},
});
const host = new ModuleHost({ config: loaded, log, transports: [], modules: [browser], ingest: (event) => store.append(event), outbox: () => [], history: HistoryStore.open(loaded.paths.stateDir), runtimeStatus: () => ({}) });
let operatorBrowser: Awaited<ReturnType<typeof chromium.launch>> | undefined;
try {
	await host.init();
	await browser.command({ action: "navigate", url: `${targetOrigin}/` });
	await browser.command({ action: "fill", selector: "#target", text: "Agent input" });
	const native = nativeContext!.pages()[0];
	assert.equal(await native.locator("#target").inputValue(), "Agent input");
	const redirect = await browser.command({ action: "request", url: `${targetOrigin}/redirect` });
	assert.equal(redirect.details.status, 302);
	assert.equal(destinations, 0, "request must not follow redirects");
	assert.match(requestCookie, /fixture=session/, "HTTP requests share the persistent browser cookies");
	await browser.command({ action: "navigate", url: `${targetOrigin}/challenge` });
	assert.equal(browser.status().paused, true);
	const assist = await browser.command({ action: "handoff" });
	const link = assist.details.operatorUrl as string;
	assert.ok(link.includes("/browser#"));
	operatorBrowser = await chromium.launch({ channel: "chrome", headless: true });
	const operator = await operatorBrowser.newPage({ viewport: { width: 375, height: 812 } });
	const errors: string[] = [];
	operator.on("pageerror", (error) => errors.push(error.message));
	await operator.goto(link);
	await operator.getByRole("status").filter({ hasText: "Подключено" }).waitFor();
	await operator.waitForFunction(() => document.querySelector("#frame").naturalWidth > 0);
	assert.equal(new URL(operator.url()).hash, "", "capability must be removed from the visible URL");
	assert.equal(await operator.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
	await operator.getByRole("button", { name: "Приостановить изображение" }).click();
	await operator.screenshot({ path: path.join(artifacts, "mobile.png"), fullPage: true });
	await operator.setViewportSize({ width: 1366, height: 1400 });
	await operator.evaluate(() => new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))));
	await operator.screenshot({ path: path.join(artifacts, "desktop.png") });
	await operator.setViewportSize({ width: 812, height: 375 });
	assert.equal(await operator.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
	await operator.setViewportSize({ width: 375, height: 812 });
	await operator.getByRole("button", { name: "Увеличить", exact: true }).click();
	await operator.getByRole("button", { name: "Перемещать изображение", exact: true }).click();
	assert.equal(await operator.locator("#pan").getAttribute("aria-pressed"), "true");
	assert.equal(await operator.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
	await operator.getByRole("button", { name: "По ширине", exact: true }).click();
	await operator.getByRole("button", { name: "Продолжить изображение", exact: true }).click();
	const field = await native.locator("#target").boundingBox();
	const frame = await operator.locator("#frame").boundingBox();
	assert.ok(field && frame);
	const point = async (x: number, y: number) => {
		await operator.locator("#frame").scrollIntoViewIfNeeded();
		const box = (await operator.locator("#frame").boundingBox())!;
		return { x: box.x + x * box.width / 900, y: box.y + y * box.height / 720 };
	};
	const focus = await point(field.x + field.width / 2, field.y + field.height / 2);
	await operator.mouse.click(focus.x, focus.y);
	await operator.getByLabel("Текст в выбранное поле браузера").fill(" — ручной ввод");
	await operator.getByRole("button", { name: "Ввести текст", exact: true }).click();
	await native.waitForFunction(() => document.querySelector("#target").value.includes("ручной ввод"));
	const blocked = await browser.command({ action: "fill", selector: "#target", text: "must not overwrite" });
	assert.match(blocked.details.error as string, /paused/);
	await operator.getByRole("button", { name: "Готово — вернуть агенту" }).click();
	await operator.getByRole("status").filter({ hasText: "Site still requires verification" }).waitFor();
	const control = await native.locator("#drag").boundingBox();
	assert.ok(control);
	const first = await point(control.x + 10, control.y + control.height / 2);
	const last = await point(control.x + control.width - 10, control.y + control.height / 2);
	await operator.mouse.move(first.x, first.y);
	await operator.mouse.down();
	await operator.mouse.move(last.x, last.y, { steps: 12 });
	await operator.mouse.up();
	await native.waitForFunction(() => Number(document.querySelector("#drag").value) > 80);
	const solve = await native.locator("#solve").boundingBox();
	assert.ok(solve);
	const click = await point(solve.x + solve.width / 2, solve.y + solve.height / 2);
	await operator.mouse.click(click.x, click.y);
	await native.locator("#challenge-form").waitFor({ state: "detached" });
	await operator.getByRole("button", { name: "Готово — вернуть агенту" }).click();
	await operator.getByRole("status").filter({ hasText: "Управление возвращено агенту" }).waitFor();
	assert.equal(browser.status().paused, false);
	assert.deepEqual(errors, []);
	await browser.command({ action: "close" });
	await browser.command({ action: "navigate", url: `${targetOrigin}/` });
	assert.match((await browser.command({ action: "read" })).details.text as string, /профиль: persistent/);
	await browser.command({ action: "navigate", url: `${targetOrigin}/denied` });
	assert.equal(browser.status().paused, true);
	assert.match((await browser.command({ action: "navigate", url: `${targetOrigin}/` })).details.error as string, /paused/);
	console.log(`Browser E2E passed: real Chrome, shared profile/cookies, 403 pause, same-session pointer/drag/text, mobile/desktop UI, explicit resume. Screenshots: ${artifacts}`);
} finally {
	await operatorBrowser?.close();
	await host.stop();
	await new Promise<void>((resolve) => fixture.close(() => resolve()));
	// Retain UI screenshots for review; remove the session profile and cookies.
	fs.rmSync(loaded.paths.stateDir, { recursive: true, force: true });
}
