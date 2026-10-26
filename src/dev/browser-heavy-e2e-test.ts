import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { BrowserContext, BrowserType } from "playwright";
import { chromium } from "playwright";
import { loadConfig } from "../config.js";
import { ModuleHost } from "../events/host.js";
import { Logger } from "../log.js";
import { BrowserModule } from "../modules/browser/module.js";
import { MAX_SNAPSHOT_NODE_CHARS, snapshotTruncationMarker, textTruncationMarker } from "../modules/browser/extract.js";
import { EventStore } from "../store/events.js";
import { HistoryStore } from "../store/history.js";

// A synthetic catalog far heavier than a real one: ~4 000 cards, ~1 MiB of text.
const cards = Array.from({ length: 4_000 }, (_, index) => `<article class="product-card"><a href="/catalog/${index}/detail.aspx">Товар ${index}</a><p>${"Описание товара ".repeat(20)} 4 000 ₽</p></article>`).join("");
const HTML = `<!doctype html><title>Heavy catalog</title><header>Header</header><main>${cards}</main><footer>Footer</footer>`;
const WB_SEARCH = "https://www.wildberries.ru/catalog/0/search.aspx?search=heavy";
const MAX_TEXT = 5_000, MAX_NODES = 300;

const root = fs.mkdtempSync(path.join(os.tmpdir(), "alive-heavy-e2e-"));
let context: BrowserContext;
const module = new BrowserModule({ port: 0, driver: "playwright", headless: true, minActionIntervalMs: 0, minNavigationIntervalMs: 0, humanization: { enabled: false }, actionTimeoutMs: 5_000, maxPageTextChars: MAX_TEXT, maxSnapshotNodes: MAX_NODES }, {
	launch: (async (profile, options) => {
		context = await chromium.launchPersistentContext(profile, { ...options, channel: undefined, executablePath: chromium.executablePath() }) as unknown as BrowserContext;
		await context.route("**/*", route => route.fulfill({ contentType: "text/html; charset=utf-8", body: HTML }));
		return context;
	}) as BrowserType["launchPersistentContext"],
});
const loaded = loadConfig({ cwd: root });
const events = EventStore.open(loaded.paths.stateDir);
const host = new ModuleHost({ config: loaded, log: new Logger({ console: false }), modules: [module], transports: [], ingest: input => events.append(input), outbox: () => [], history: HistoryStore.open(loaded.paths.stateDir), runtimeStatus: () => ({}) });

try {
	await host.init();
	const navigated = await module.command({ action: "navigate", url: WB_SEARCH });
	assert.equal(navigated.details.error, undefined);

	const page = context!.pages()[0];
	const fullText = await page.locator("main").innerText();
	assert.ok(fullText.length > 500_000, `Fixture must be heavy (${fullText.length} chars)`);

	const read = await module.command({ action: "read", selector: "main" });
	const text = String(read.details.text);
	const extraction = read.details.extraction as { truncated: boolean; timedOut: boolean; totalChars: number };
	assert.equal(read.details.error, undefined, "Truncation is not a failure");
	assert.equal(extraction.truncated, true);
	assert.equal(extraction.timedOut, false);
	assert.ok(extraction.totalChars > MAX_TEXT * 100, `Measured ${extraction.totalChars} chars must reflect the real page`);
	assert.ok(text.startsWith(fullText.slice(0, MAX_TEXT)), "The capped prefix must match the page text");
	assert.ok(text.endsWith(textTruncationMarker(extraction.totalChars - MAX_TEXT)), "The marker must name the dropped remainder");
	assert.ok(JSON.stringify(read).length < 50_000, "The read payload must stay bounded");
	assert.equal((read.details.content as { state: string }).state, "ready");

	const snapshot = await module.command({ action: "snapshot", selector: "main" });
	const lines = String(snapshot.details.snapshot).split("\n");
	const snapshotInfo = snapshot.details.extraction as { nodes: number; omittedNodes: number; truncated: boolean };
	assert.equal(snapshotInfo.truncated, true);
	assert.equal(snapshotInfo.nodes, MAX_NODES);
	assert.ok(snapshotInfo.omittedNodes > 0);
	assert.equal(lines.at(-1), snapshotTruncationMarker(snapshotInfo.omittedNodes));
	for (const line of lines.slice(0, MAX_NODES)) assert.ok(line.length <= MAX_SNAPSHOT_NODE_CHARS + 20, "Each node line is bounded");
	assert.ok(JSON.stringify(snapshot).length < 120_000, "The snapshot payload must stay bounded");

	// A bounded extraction failure (selector never appears) leaves the session usable.
	const missing = await module.command({ action: "read", selector: "#never-rendered", timeoutMs: 100 });
	assert.ok(missing.details.error, "A missing selector must be reported, not returned as an empty page");
	assert.equal((missing.details.extraction as { timedOut: boolean }).timedOut, true);
	assert.equal(module.status().paused, false);
	assert.equal(page.isClosed(), false, "A failed read must not close the page");
	const recovered = await module.command({ action: "read", selector: "main" });
	assert.equal(recovered.details.error, undefined);
	assert.ok(String(recovered.details.text).startsWith("Товар 0"), "The same page stays readable afterwards");

	console.log(`Browser heavy-page E2E passed (playwright): ${fullText.length}-char page capped to ${MAX_TEXT} chars, snapshot capped to ${MAX_NODES} of ${snapshotInfo.nodes + snapshotInfo.omittedNodes} nodes, payloads bounded, failed extraction kept the session usable`);
} finally {
	await host.stop();
	fs.rmSync(root, { recursive: true, force: true });
}
