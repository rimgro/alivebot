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
import { MAX_SNAPSHOT_NODE_CHARS, textTruncationMarker } from "../modules/browser/extract.js";
import { PAGE_TEXT_DIR } from "../modules/browser/page-file.js";
import { EventStore } from "../store/events.js";
import { HistoryStore } from "../store/history.js";

// A synthetic catalog far heavier than a real one: ~4 000 cards, ~1 MiB of text.
const cards = Array.from({ length: 4_000 }, (_, index) => `<article class="product-card"><a href="/catalog/${index}/detail.aspx">Товар ${index}</a><p>${"Описание товара ".repeat(20)} 4 000 ₽</p></article>`).join("");
const HTML = `<!doctype html><title>Heavy catalog</title><header>Header</header><main>${cards}</main><footer>Footer</footer>`;
const WB_SEARCH = "https://www.wildberries.ru/catalog/0/search.aspx?search=heavy";
const MAX_TEXT = 5_000, MAX_PREVIEW = 1_000, MAX_NODES = 300;

/** Longest string anywhere in a tool payload: no page dump may leak into it. */
function longestString(value: unknown): number {
	if (typeof value === "string") return value.length;
	if (Array.isArray(value)) return value.reduce((max: number, item) => Math.max(max, longestString(item)), 0);
	if (value && typeof value === "object") return Object.values(value).reduce((max: number, item) => Math.max(max, longestString(item)), 0);
	return 0;
}

const root = fs.mkdtempSync(path.join(os.tmpdir(), "alive-heavy-e2e-"));
let context: BrowserContext;
const module = new BrowserModule({ port: 0, driver: "playwright", headless: true, minActionIntervalMs: 0, minNavigationIntervalMs: 0, humanization: { enabled: false }, actionTimeoutMs: 5_000, maxPageTextChars: MAX_TEXT, maxPagePreviewChars: MAX_PREVIEW, maxSnapshotNodes: MAX_NODES }, {
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
	const preview = String(read.details.text);
	assert.equal(read.details.error, undefined, "Truncation is not a failure");
	assert.equal(read.details.truncated, true);
	assert.ok(Number(read.details.totalChars) > MAX_TEXT * 100, `Measured ${read.details.totalChars} chars must reflect the real page`);
	assert.equal(preview.length, MAX_PREVIEW, "The result carries only maxPagePreviewChars");
	assert.ok(preview.startsWith(fullText.slice(0, MAX_PREVIEW)), "The preview must be the start of the real page text");
	assert.ok(JSON.stringify(read).length < 50_000, "The read payload must stay bounded");
	assert.ok(longestString(read.details) <= MAX_PREVIEW, `No page string longer than the preview may be returned (${longestString(read.details)})`);
	assert.equal((read.details.content as { state: string }).state, "ready");

	// The full text (guarded at maxPageTextChars, marker inside) is a workspace file.
	const relativePath = String(read.details.path);
	assert.match(relativePath, /^browser-pages\/www\.wildberries\.ru-\d{8}T\d{9}Z\.txt$/);
	const pageFile = path.resolve(loaded.paths.workspaceDir, ...relativePath.split("/"));
	assert.ok(pageFile.startsWith(`${path.resolve(loaded.paths.workspaceDir)}${path.sep}`), "The page file must stay inside the workspace");
	assert.equal(path.basename(path.dirname(pageFile)), PAGE_TEXT_DIR);
	assert.ok(fs.existsSync(pageFile), `Page text file must exist: ${pageFile}`);
	const stored = fs.readFileSync(pageFile, "utf8");
	assert.ok(stored.startsWith(fullText.slice(0, MAX_TEXT)), "The file keeps the capped page text from the start");
	assert.equal(stored, fullText.slice(0, MAX_TEXT) + textTruncationMarker(read.details.totalChars as number - MAX_TEXT), "The truncation marker belongs inside the file");
	const hint = String(read.details.hint);
	assert.ok(hint.includes(relativePath) && /read it in chunks/.test(hint), `The hint names the file and how to read it: ${hint}`);
	assert.ok(!hint.includes("Товар 0"), "The hint must not quote page text");

	// The snapshot keeps the node cap and states how many nodes were dropped.
	const snapshot = await module.command({ action: "snapshot", selector: "main" });
	const snapshotPreview = String(snapshot.details.snapshot);
	assert.equal(snapshot.details.nodes, MAX_NODES);
	assert.ok(Number(snapshot.details.droppedNodes) > 0, "Dropped nodes must be counted");
	assert.equal(snapshot.details.totalNodes, Number(snapshot.details.nodes) + Number(snapshot.details.droppedNodes));
	assert.equal(snapshot.details.truncated, true);
	assert.equal(snapshot.details.previewTruncated, true);
	assert.ok(snapshotPreview.length <= MAX_PREVIEW && snapshotPreview.length > 0, "The snapshot preview is bounded");
	for (const line of snapshotPreview.split("\n")) assert.ok(line.length <= MAX_SNAPSHOT_NODE_CHARS + 20, "Each node line is bounded");
	assert.match(String(snapshot.details.hint), new RegExp(`${snapshot.details.droppedNodes} dropped by maxSnapshotNodes=${MAX_NODES}`));
	assert.ok(JSON.stringify(snapshot).length < 120_000, "The snapshot payload must stay bounded");

	// A bounded extraction failure (selector never appears) leaves the session usable.
	const filesBefore = fs.readdirSync(path.join(loaded.paths.workspaceDir, PAGE_TEXT_DIR)).length;
	const missing = await module.command({ action: "read", selector: "#never-rendered", timeoutMs: 100 });
	assert.ok(missing.details.error, "A missing selector must be reported, not returned as an empty page");
	assert.equal(missing.details.timedOut, true);
	assert.equal(missing.details.text, "");
	assert.equal(missing.details.path, undefined, "A failed read writes no file");
	assert.equal(fs.readdirSync(path.join(loaded.paths.workspaceDir, PAGE_TEXT_DIR)).length, filesBefore);
	assert.equal(module.status().paused, false);
	assert.equal(page.isClosed(), false, "A failed read must not close the page");
	const recovered = await module.command({ action: "read", selector: "main" });
	assert.equal(recovered.details.error, undefined);
	assert.ok(String(recovered.details.text).startsWith("Товар 0"), "The same page stays readable afterwards");
	assert.ok(String(recovered.details.path).startsWith(`${PAGE_TEXT_DIR}/`), "The recovered read writes its own file");

	console.log(`Browser heavy-page E2E passed (playwright): ${fullText.length}-char page -> ${MAX_PREVIEW}-char preview + ${MAX_TEXT}-char guarded file (${relativePath}), snapshot ${snapshot.details.nodes}/${snapshot.details.totalNodes} nodes with ${snapshot.details.droppedNodes} dropped, payloads bounded, failed extraction kept the session usable`);
} finally {
	await host.stop();
	fs.rmSync(root, { recursive: true, force: true });
}
