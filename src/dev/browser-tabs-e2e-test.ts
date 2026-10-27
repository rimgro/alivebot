import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as http from "node:http";
import * as os from "node:os";
import * as path from "node:path";
import { chromium, type BrowserContext, type BrowserType, type Page } from "playwright";
import { loadConfig } from "../config.js";
import { ModuleHost } from "../events/host.js";
import { Logger } from "../log.js";
import { BrowserModule } from "../modules/browser/module.js";
import { EventStore } from "../store/events.js";
import { HistoryStore } from "../store/history.js";
import { sleep } from "../util.js";

// Local fixtures only: a real Chromium page opens window.open and target=_blank
// tabs. No Docker, external network or CAPTCHA is involved.
const root = fs.mkdtempSync(path.join(os.tmpdir(), "alive-tabs-e2e-"));
const fixture = http.createServer((req, res) => {
	res.setHeader("content-type", "text/html; charset=utf-8");
	if (req.url === "/popup") { res.end("<title>OAuth popup</title><h1>Popup page</h1>"); return; }
	if (req.url === "/blank") { res.end("<title>Blank target</title><h1>Blank tab</h1>"); return; }
	res.end(`<title>Main fixture</title><h1>Main page</h1>
<button id="open" onclick="window.open('/popup','oauth','width=420,height=640')">Open OAuth</button>
<a id="blank" href="/blank" target="_blank">New tab</a>`);
});
await new Promise<void>(resolve => fixture.listen(0, "127.0.0.1", resolve));
const origin = `http://127.0.0.1:${(fixture.address() as { port: number }).port}`;
const loaded = loadConfig({ cwd: root });
const store = EventStore.open(loaded.paths.stateDir);
const browser = new BrowserModule({ port: 0, driver: "playwright", headless: true, minActionIntervalMs: 0, minNavigationIntervalMs: 0, humanization: { enabled: false } }, {
	launch: (async (profile, options) => {
		const { channel: _channel, ...rest } = (options ?? {}) as Record<string, unknown>;
		return chromium.launchPersistentContext(profile, { ...rest, headless: true }) as unknown as BrowserContext;
	}) as BrowserType["launchPersistentContext"],
});
const host = new ModuleHost({ config: loaded, log: new Logger({ console: false, level: "error" }), modules: [browser], transports: [], ingest: event => store.append(event), outbox: () => [], history: HistoryStore.open(loaded.paths.stateDir), runtimeStatus: () => ({}) });
async function waitUrl(expected: string): Promise<void> {
	const deadline = Date.now() + 5000;
	while (browser.status().url !== expected && Date.now() < deadline) await sleep(25);
	assert.equal(browser.status().url, expected, `Expected the active tab to become ${expected}`);
}
try {
	await host.init();
	await browser.command({ action: "navigate", url: `${origin}/` });
	const single = (await browser.command({ action: "tabs" })).details.tabs as Array<{ id: string; url: string; title: string; active: boolean }>;
	assert.equal(single.length, 1, "A single-page session has one tab");
	assert.equal(single[0].active, true);

	await browser.command({ action: "click", selector: "#open" });
	await waitUrl(`${origin}/popup`);
	const opened = (await browser.command({ action: "tabs" })).details.tabs as Array<{ id: string; url: string; title: string; active: boolean }>;
	assert.deepEqual(opened.map(tab => ({ url: tab.url, active: tab.active })), [
		{ url: `${origin}/`, active: false },
		{ url: `${origin}/popup`, active: true },
	], "window.open creates a new active tab");
	assert.match(String((await browser.command({ action: "read", selector: "h1" })).details.text), /Popup page/, "Agent actions follow the popup");
	const mainId = opened[0].id;
	await browser.command({ action: "switch_tab", tab: mainId });
	await waitUrl(`${origin}/`);
	assert.match(String((await browser.command({ action: "read", selector: "h1" })).details.text), /Main page/, "switch_tab moves agent actions to the previous tab");
	const control = await (await fetch(`${browser.localEndpoint()}/browser`)).text();
	assert.ok(control.includes(JSON.stringify(`${origin}/`)), "The control page reflects the switched-to tab");
	assert.ok(!control.includes(JSON.stringify(`${origin}/popup`)), "The control page drops the old popup URL");

	await browser.command({ action: "click", selector: "#blank" });
	await waitUrl(`${origin}/blank`);
	const three = (await browser.command({ action: "tabs" })).details.tabs as Array<{ id: string; url: string; active: boolean }>;
	assert.deepEqual(three.map(tab => ({ url: tab.url, active: tab.active })), [
		{ url: `${origin}/`, active: false },
		{ url: `${origin}/popup`, active: false },
		{ url: `${origin}/blank`, active: true },
	], "target=_blank also opens and activates a tab");
	// Close the active tab through the real browser's page handle.
	const blankPage = (browser as unknown as { page?: Page }).page;
	assert.ok(blankPage);
	await blankPage!.close();
	await waitUrl(`${origin}/`);
	const afterClose = (await browser.command({ action: "tabs" })).details.tabs as Array<{ url: string; active: boolean }>;
	assert.deepEqual(afterClose.map(tab => ({ url: tab.url, active: tab.active })), [
		{ url: `${origin}/`, active: true },
		{ url: `${origin}/popup`, active: false },
	], "Closing the active tab falls back to the most recently used live tab");
	console.log(`Browser tab E2E passed (playwright): window.open, target=_blank, tabs, switch_tab, active URL handoff, close fallback`);
} finally {
	await host.stop();
	fixture.close();
	fs.rmSync(root, { recursive: true, force: true });
}
