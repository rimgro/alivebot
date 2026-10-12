import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { BrowserContext, BrowserType } from "playwright";
import { loadConfig } from "../config.js";
import { ModuleHost } from "../events/host.js";
import { Logger } from "../log.js";
import { BrowserModule } from "../modules/browser/module.js";
import { EventStore } from "../store/events.js";
import { HistoryStore } from "../store/history.js";

const root = fs.mkdtempSync(path.join(os.tmpdir(), "alive-content-e2e-"));
const driver = process.env.ALIVE_BROWSER_TEST_DRIVER === "playwright" ? "playwright" : "patchright";
const { chromium } = await import(driver);
const secret = "SyntheticDiagnosticPrivateValue";
const notification: string[] = [];
let context: BrowserContext;
const card = '<article><a href="/catalog/123/detail.aspx">Handmade silver ring</a><p>Silver 925 · 4 000 ₽</p></article><input aria-label="Search"><button id="choose" onclick="document.querySelector(\'article\').dataset.chosen=\'yes\'">Choose ring</button>';
const module = new BrowserModule({ port: 0, driver, headless: true, minActionIntervalMs: 0, minNavigationIntervalMs: 0, humanization: { enabled: false } }, {
	launch: (async (profile, options) => {
		context = await chromium.launchPersistentContext(profile, options) as unknown as BrowserContext;
		await context.route("**/*", async route => {
			const url = new URL(route.request().url());
			if (url.pathname === "/failed") { await route.abort("failed"); return; }
			if (url.pathname === "/api-error") { await route.fulfill({ status: 498, body: "Fixture resource rejection" }); return; }
			if (url.pathname.includes("detail.aspx")) { await route.fulfill({ contentType: "text/html; charset=utf-8", body: "<main><h1>Silver ring details</h1></main>" }); return; }
			const scenario = url.searchParams.get("search");
			let script = "";
			if (scenario === "delayed") script = `setTimeout(()=>document.querySelector('main').innerHTML=${JSON.stringify(card)},1000);setTimeout(()=>{const p=document.createElement('p');p.id='later';p.textContent='Later content';document.querySelector('main').append(p)},2400)`;
			if (scenario === "empty") script = "setTimeout(()=>document.querySelector('main').textContent='По вашему запросу ничего не найдено',350)";
			if (scenario === "failed") script = `fetch('/api-error?token=${secret}');fetch('/failed?token=${secret}').catch(()=>{});setTimeout(()=>{throw Error('${secret}')},50)`;
			if (scenario === "private") script = `setTimeout(()=>document.querySelector('main').innerHTML='<input type="password" value="${secret}">',200)`;
			await route.fulfill({ contentType: "text/html; charset=utf-8", body: `<title>Catalog fixture</title><header>Header</header><main></main><footer>Footer</footer><script>${script}</script>` });
		});
		return context;
	}) as BrowserType["launchPersistentContext"], notify: async url => { notification.push(url); },
});
const loaded = loadConfig({ cwd: root });
const events = EventStore.open(loaded.paths.stateDir);
const host = new ModuleHost({ config: loaded, log: new Logger({ console: false }), modules: [module], transports: [], ingest: input => events.append(input), outbox: () => [], history: HistoryStore.open(loaded.paths.stateDir), runtimeStatus: () => ({}) });
async function navigate(scenario: string) { return module.command({ action: "navigate", url: `https://www.wildberries.ru/catalog/0/search.aspx?search=${scenario}` }); }
try {
	await host.init();
	await navigate("delayed");
	const read = await module.command({ action: "read", selector: "main" });
	assert.equal((read.details.content as { state: string }).state, "ready", "Read must await actual cards after DOMContentLoaded");
	assert.match(String(read.details.text), /Handmade silver ring/);
	assert.ok(!String(read.details.text).includes("Footer"), "Scoped reads must exclude unrelated page chrome");
	const snapshot = String((await module.command({ action: "snapshot", selector: "main" })).details.snapshot);
	assert.match(snapshot, /\/catalog\/123\/detail\.aspx/, "The snapshot must expose the observed product link");
	const textbox = snapshot.match(/textbox "Search"[^\n]*\[ref=([^\]]+)\]/)?.[1];
	const button = snapshot.match(/button "Choose ring"[^\n]*\[ref=([^\]]+)\]/)?.[1];
	assert.ok(textbox); assert.ok(button);
	await module.command({ action: "fill", selector: `aria-ref=${textbox}`, text: "silver" });
	assert.equal(await context!.pages()[0].getByRole("textbox").inputValue(), "silver");
	await module.command({ action: "click", selector: `aria-ref=${button}` });
	assert.equal(await context!.pages()[0].locator("article").getAttribute("data-chosen"), "yes", "Snapshot references must target the actual control");
	const timed = await module.command({ action: "wait", selector: "#missing", timeoutMs: 100 });
	assert.deepEqual(timed.details.wait, { matched: false, timedOut: true });
	assert.equal(timed.details.paused, false, "Missing content must not be classified as denial");
	const later = await module.command({ action: "wait", selector: "#later", timeoutMs: 4000 });
	assert.deepEqual(later.details.wait, { matched: true, timedOut: false });
	const stale = new AbortController();
	const pending = module.command({ action: "wait", selector: "#missing", timeoutMs: 5000 }, stale.signal);
	setTimeout(() => stale.abort(), 100);
	await assert.rejects(pending, /abort|cancel/i);

	await navigate("empty");
	assert.equal(((await module.command({ action: "snapshot" })).details.content as { state: string }).state, "empty");
	await navigate("failed");
	const failed = await module.command({ action: "snapshot", timeoutMs: 350 });
	assert.equal((failed.details.content as { state: string }).state, "unconfirmed");
	assert.equal(failed.details.paused, false);
	assert.equal(failed.details.lastHttpStatus, 200, "A resource error must not overwrite the document status");
	const diagnostics = failed.details.diagnostics as { failures: Array<{ status?: number; code?: string }>; scriptErrors: number };
	assert.ok(diagnostics.failures.some(failure => failure.status === 498));
	assert.ok(diagnostics.failures.some(failure => failure.code === "net::ERR_FAILED"));
	if (driver === "playwright") assert.equal(diagnostics.scriptErrors, 1, "The compatible driver must report the real script exception");
	else assert.ok(Number.isInteger(diagnostics.scriptErrors) && diagnostics.scriptErrors >= 0, "Patchright may suppress pageerror; do not infer error-free execution from zero");
	assert.ok(!JSON.stringify(failed).includes(secret), "Request queries and exception messages must not leak through diagnostics");
	assert.equal(notification.length, 0, "An uncertain catalog does not fabricate a verification challenge");
	await navigate("private");
	const privateRead = await module.command({ action: "snapshot" });
	assert.equal(privateRead.details.paused, true);
	assert.equal(notification.length, 1);
	assert.ok(!JSON.stringify(privateRead).includes(secret), "Late private entry must interrupt content observation before values are exported");
	console.log(`Browser content E2E passed (${driver}): delayed cards, explicit empty state, actionable snapshot refs, scoped read, bounded/cancelled waits, resource diagnostics without private data, late private-entry handoff`);
} finally { await host.stop(); fs.rmSync(root, { recursive: true, force: true }); }
