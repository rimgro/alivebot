import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { BrowserContext, BrowserType } from "playwright";
import { loadConfig } from "../config.js";
import { ModuleHost } from "../events/host.js";
import { Logger } from "../log.js";
import { BrowserModule } from "../modules/browser/module.js";
import { DEFAULT_BROWSER_CONFIG, validateExtractionLimits } from "../modules/browser/config.js";
import {
	MAX_SNAPSHOT_NODE_CHARS, capSnapshot, capText, cappedSnapshotMarker, cappedTextMarker, extractSnapshot, extractText,
	previewSnapshot, previewText, snapshotTruncationMarker, textTruncationMarker,
} from "../modules/browser/extract.js";
import { PAGE_TEXT_DIR, pageTextFileName, pageTextHost, pageTextStamp, writePageText } from "../modules/browser/page-file.js";
import { EventStore } from "../store/events.js";
import { HistoryStore } from "../store/history.js";

const WB_SEARCH = "https://www.wildberries.ru/catalog/0/search.aspx?search=heavy";
const PREVIEW_CHARS = 500, PAGE_TEXT_CHARS = 1_000, SNAPSHOT_NODES = 50;

/** Longest string anywhere in a tool payload: no page dump may leak into it. */
function longestString(value: unknown): number {
	if (typeof value === "string") return value.length;
	if (Array.isArray(value)) return value.reduce((max: number, item) => Math.max(max, longestString(item)), 0);
	if (value && typeof value === "object") return Object.values(value).reduce((max: number, item) => Math.max(max, longestString(item)), 0);
	return 0;
}

// --- truncation helpers (no browser, no network) ---
const exact = capText("x".repeat(2_500), 1_000);
assert.equal(exact.truncated, true);
assert.equal(exact.totalChars, 2_500);
assert.equal(exact.text, "x".repeat(1_000) + textTruncationMarker(1_500));
assert.equal(exact.text, "x".repeat(1_000) + "\n[truncated: 1500 more characters]", "Marker wording is part of the contract");
const measured = capText("x".repeat(1_000), 1_000, 5_000);
assert.equal(measured.text, "x".repeat(1_000) + "\n[truncated: 4000 more characters]");
assert.equal(measured.totalChars, 5_000);
assert.deepEqual(capText("short", 1_000), { text: "short", totalChars: 5, truncated: false, timedOut: false, failed: false });
const transportCapped = capText("x".repeat(1_001), 1_000, 1_001, true);
assert.equal(transportCapped.truncated, true);
assert.ok(transportCapped.text.startsWith("x".repeat(1_000)));
assert.equal(transportCapped.text.slice(1_000), cappedTextMarker(1_000));

const lines = Array.from({ length: 100 }, (_, index) => `- link "Item ${index}" [ref=e${index}]`);
const snapshot = capSnapshot(lines.join("\n"), 50);
assert.equal(snapshot.nodes, 50);
assert.equal(snapshot.omittedNodes, 50);
assert.equal(snapshot.truncated, true);
assert.equal(snapshot.snapshot.split("\n").at(-1), snapshotTruncationMarker(50));
assert.equal(snapshot.snapshot, [...lines.slice(0, 50), "[truncated: 50 more snapshot nodes]"].join("\n"));
const longLine = `- link "${"a".repeat(400)}" [ref=e1]`;
const clipped = capSnapshot(longLine, 5, 20);
assert.equal(clipped.truncated, true);
assert.equal(clipped.nodes, 1);
assert.equal(clipped.snapshot, `${longLine.slice(0, 20)} …[+${longLine.length - 20} chars]`);
assert.ok(clipped.snapshot.split("\n")[0].length <= 20 + " …[+000 chars]".length);
assert.equal(capSnapshot("- text: \"ok\"", 5).snapshot, "- text: \"ok\"");
assert.equal(MAX_SNAPSHOT_NODE_CHARS, 200);

// --- bounded previews and workspace file naming (no browser, no network) ---
assert.equal(previewText("x".repeat(200), 100), "x".repeat(100));
assert.equal(previewText("short", 100), "short", "A small page yields its whole text as the preview");
const linePreview = previewSnapshot(lines.join("\n"), 60);
assert.equal(linePreview.truncated, true);
assert.ok(linePreview.preview.length <= 60);
for (const line of linePreview.preview.split("\n")) assert.ok(lines.includes(line), "The snapshot preview keeps whole node lines so every ref stays usable");
assert.deepEqual(previewSnapshot("a\nb", 100), { preview: "a\nb", truncated: false });
assert.equal(pageTextHost(WB_SEARCH), "www.wildberries.ru");
assert.equal(pageTextHost("https://example.com:8443/x?y=1"), "example.com");
assert.equal(pageTextHost("about:blank"), "page");
assert.equal(pageTextHost(undefined), "page");
assert.equal(pageTextHost("https://../../etc/passwd"), "page", "A host can never become a path traversal");
for (const host of [pageTextHost(WB_SEARCH), pageTextHost("https://пример.рф/путь"), pageTextHost("https://[::1]:8443/")]) {
	assert.match(host, /^[a-z0-9.-]*$/, `Sanitized host ${host} must be file-name safe`);
}
const fixedStamp = pageTextStamp(Date.UTC(2026, 9, 26, 14, 33, 52, 123));
assert.equal(fixedStamp, "20261026T143352123Z", "The timestamp is fixed-width UTC so names sort by time");
assert.equal(pageTextFileName(WB_SEARCH, Date.UTC(2026, 9, 26, 14, 33, 52, 123)), `${PAGE_TEXT_DIR}/www.wildberries.ru-20261026T143352123Z.txt`);
assert.match(pageTextFileName(WB_SEARCH), /^browser-pages\/[a-z0-9.-]+-\d{8}T\d{9}Z\.txt$/);
const earlier = pageTextStamp(1_700_000_000_001), later = pageTextStamp(1_700_000_000_002);
assert.ok(earlier < later, "Timestamps must sort chronologically as strings");
assert.notEqual(pageTextStamp(), pageTextStamp(), "Two reads in the same millisecond must not share a file name");
// The writer stores exactly the capped text at the returned relative path.
const stored: Array<{ file: string; text: string }> = [];
const writtenPath = await writePageText({ write: async (file, data) => { stored.push({ file, text: data.toString("utf8") }); } }, WB_SEARCH, "capped body", Date.UTC(2026, 9, 26, 14, 33, 52, 123));
assert.equal(writtenPath, "browser-pages/www.wildberries.ru-20261026T143352123Z.txt");
assert.deepEqual(stored, [{ file: writtenPath, text: "capped body" }]);

// Extraction helpers bound their own time and state failures instead of throwing.
const cappedSnapshot = await extractSnapshot(async () => ({ snapshot: '- link "x"', capped: true, maxChars: 200_000 }), { maxNodes: 50, timeoutMs: 1_000 });
assert.equal(cappedSnapshot.truncated, true);
assert.equal(cappedSnapshot.snapshot, `- link "x"\n${cappedSnapshotMarker(200_000)}`);
const timedText = await extractText(() => new Promise<string>(() => {}), { maxChars: 100, timeoutMs: 50 });
assert.equal(timedText.timedOut, true);
assert.equal(timedText.text, "");
assert.match(String(timedText.note), /within 50 ms/);
assert.match(String(timedText.note), /browser session was kept/);
const failedText = await extractText(async () => { throw new Error("Protocol error (Runtime.evaluate): Target closed"); }, { maxChars: 100, timeoutMs: 1_000 });
assert.equal(failedText.failed, true);
assert.equal(failedText.text, "");
assert.match(String(failedText.note), /Target closed/);
assert.match(String(failedText.note), /browser session was kept/);

// --- config validation for the extraction limits ---
assert.equal(DEFAULT_BROWSER_CONFIG.maxPageTextChars, 200_000);
assert.equal(DEFAULT_BROWSER_CONFIG.maxPagePreviewChars, 8_000);
assert.equal(DEFAULT_BROWSER_CONFIG.maxSnapshotNodes, 2_000);
validateExtractionLimits({ maxPageTextChars: 1_000, maxPagePreviewChars: 500, maxSnapshotNodes: 50 });
validateExtractionLimits({ maxPageTextChars: 1_000_000, maxPagePreviewChars: 50_000, maxSnapshotNodes: 50_000 });
for (const limits of [
	{ maxPageTextChars: 0, maxPagePreviewChars: 8_000, maxSnapshotNodes: 2_000 },
	{ maxPageTextChars: 999, maxPagePreviewChars: 8_000, maxSnapshotNodes: 2_000 },
	{ maxPageTextChars: 1_500.5, maxPagePreviewChars: 8_000, maxSnapshotNodes: 2_000 },
	{ maxPageTextChars: 1_000_001, maxPagePreviewChars: 8_000, maxSnapshotNodes: 2_000 },
	{ maxPageTextChars: Number.NaN, maxPagePreviewChars: 8_000, maxSnapshotNodes: 2_000 },
	{ maxPageTextChars: 200_000, maxPagePreviewChars: 0, maxSnapshotNodes: 2_000 },
	{ maxPageTextChars: 200_000, maxPagePreviewChars: 499, maxSnapshotNodes: 2_000 },
	{ maxPageTextChars: 200_000, maxPagePreviewChars: 50_001, maxSnapshotNodes: 2_000 },
	{ maxPageTextChars: 200_000, maxPagePreviewChars: 8_000.5, maxSnapshotNodes: 2_000 },
	{ maxPageTextChars: 200_000, maxPagePreviewChars: Number.NaN, maxSnapshotNodes: 2_000 },
	{ maxPageTextChars: 200_000, maxPagePreviewChars: 8_000, maxSnapshotNodes: 49 },
	{ maxPageTextChars: 200_000, maxPagePreviewChars: 8_000, maxSnapshotNodes: 50_001 },
	{ maxPageTextChars: 200_000, maxPagePreviewChars: 8_000, maxSnapshotNodes: 2_000.5 },
]) {
	assert.throws(() => validateExtractionLimits(limits), /maxPageTextChars|maxPagePreviewChars|maxSnapshotNodes/);
}
// The module rejects the same values at startup, before any browser is launched.
await assert.rejects(() => new BrowserModule({ port: 0, maxPageTextChars: 500, humanization: { enabled: false } }).start({} as never), /maxPageTextChars/);
await assert.rejects(() => new BrowserModule({ port: 0, maxPagePreviewChars: 100, humanization: { enabled: false } }).start({} as never), /maxPagePreviewChars/);
await assert.rejects(() => new BrowserModule({ port: 0, maxSnapshotNodes: 5, humanization: { enabled: false } }).start({} as never), /maxSnapshotNodes/);

// --- synthetic heavy page through the real BrowserModule ---
class HeavyPage extends EventEmitter {
	address = WB_SEARCH;
	text = "Ж".repeat(2_500);
	heavySnapshot = lines.join("\n");
	error?: Error;
	delay?: Promise<void>;
	innerTextCalls = 0;
	emptyStateProbes = 0;
	closed = false;
	url() { return this.address; }
	isClosed() { return this.closed; }
	mainFrame() { return this; }
	frames() { return [this]; }
	viewportSize() { return { width: 900, height: 720 }; }
	async title() { return "Heavy fixture"; }
	async goto(url: string) { this.address = url; }
	private async extract<T>(operation: (element: { innerText: string; textContent: string }) => T): Promise<T> {
		if (this.error) throw this.error;
		if (this.delay) await this.delay;
		return operation({ innerText: this.text, textContent: this.text });
	}
	locator(selector: string) {
		const page = this;
		const target = {
			innerText: async () => { page.innerTextCalls++; return page.text; },
			evaluate: async (fn: (element: { innerText: string; textContent: string }, arg: unknown) => unknown, arg: unknown) => page.extract(element => {
				if (fn.name === "catalogEmptyStateExtractor") page.emptyStateProbes++;
				return fn(element, arg);
			}),
			ariaSnapshot: async () => page.extract(() => page.heavySnapshot),
			count: async () => selector === "body" || selector === "main, [role=main]" ? 1 : 0,
			nth: () => ({ isVisible: async () => false, isEditable: async () => false, inputValue: async () => "" }),
			first: () => target,
		};
		return target;
	}
	async screenshot() { return Buffer.from([0xff, 0xd8, 0xff, 0xd9]); }
}

const root = fs.mkdtempSync(path.join(os.tmpdir(), "alive-heavy-browser-"));
const page = new HeavyPage();
const context = new EventEmitter() as EventEmitter & Record<string, unknown>;
Object.assign(context, {
	pages: () => [page], newPage: async () => page, setDefaultTimeout: () => {},
	close: async () => { page.closed = true; context.emit("close"); },
});
const module = new BrowserModule(
	{ port: 0, minActionIntervalMs: 0, minNavigationIntervalMs: 0, humanization: { enabled: false }, actionTimeoutMs: 400, maxPageTextChars: PAGE_TEXT_CHARS, maxPagePreviewChars: PREVIEW_CHARS, maxSnapshotNodes: SNAPSHOT_NODES },
	{ launch: (async () => context as unknown as BrowserContext) as BrowserType["launchPersistentContext"] },
);
const loaded = loadConfig({ cwd: root });
// The runtime's sandboxed workspace writer is the production path; record what it receives.
const savedPageFiles: Array<{ file: string; text: string }> = [];
const host = new ModuleHost({
	config: loaded, log: new Logger({ console: false }), modules: [module], transports: [],
	workspaceFiles: {
		rootDir: loaded.paths.workspaceDir,
		readFile: async (file) => fs.readFileSync(file),
		writeFile: async (file, data) => { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, data); savedPageFiles.push({ file, text: data.toString("utf8") }); return file; },
	},
	ingest: input => EventStore.open(loaded.paths.stateDir).append(input), outbox: () => [], history: HistoryStore.open(loaded.paths.stateDir), runtimeStatus: () => ({}),
});

try {
	await host.init();
	const pageFiles = path.join(loaded.paths.workspaceDir, PAGE_TEXT_DIR);
	const listPageFiles = () => fs.existsSync(pageFiles) ? fs.readdirSync(pageFiles) : [];

	// Heavy page text: a preview in the result, the full capped text in the workspace.
	const read = await module.command({ action: "read" });
	const text = String(read.details.text);
	assert.equal(read.details.error, undefined, "Truncation alone is not a failure");
	assert.equal(read.details.totalChars, 2_500, "The result states the real page size");
	assert.equal(read.details.truncated, true);
	assert.equal(text.length, PREVIEW_CHARS, "The result carries only maxPagePreviewChars");
	assert.equal(text, "Ж".repeat(PREVIEW_CHARS));
	assert.ok(!text.includes("[truncated:"), "The preview is the page text, not the file body");
	assert.equal(page.innerTextCalls, 0, "Unbounded innerText must not cross CDP");
	assert.equal((read.details.content as { state: string }).state, "unconfirmed", "A heavy catalog page without cards stays unconfirmed");
	assert.ok(page.emptyStateProbes >= 2, "The empty-state check must run in the page");
	assert.ok(JSON.stringify(read).length < 20_000, "The tool payload must stay bounded");
	assert.ok(longestString(read.details) <= PREVIEW_CHARS, `No page string longer than the preview may be returned (${longestString(read.details)})`);

	// The full text lives in a workspace file named after the host and UTC time.
	const relativePath = String(read.details.path);
	assert.match(relativePath, /^browser-pages\/www\.wildberries\.ru-\d{8}T\d{9}Z\.txt$/, `Workspace-relative page file: ${relativePath}`);
	const pageFile = path.resolve(loaded.paths.workspaceDir, ...relativePath.split("/"));
	assert.ok(pageFile.startsWith(`${path.resolve(loaded.paths.workspaceDir)}${path.sep}`), "The file must stay inside the workspace");
	assert.ok(fs.existsSync(pageFile), `Page text file must exist: ${pageFile}`);
	assert.equal(fs.readFileSync(pageFile, "utf8"), "Ж".repeat(PAGE_TEXT_CHARS) + textTruncationMarker(1_500), "The file holds the capped text plus the truncation marker");
	assert.equal(savedPageFiles.length, 1, "The page text must go through the workspace writer");
	assert.ok(savedPageFiles[0]!.file.endsWith(`/${relativePath}`), `The writer receives the workspace path for ${relativePath}`);
	assert.equal(savedPageFiles[0]!.text, "Ж".repeat(PAGE_TEXT_CHARS) + textTruncationMarker(1_500));
	const hint = String(read.details.hint);
	assert.ok(hint.includes(relativePath), "The hint names the file");
	assert.match(hint, /read it in chunks/);
	assert.ok(!hint.includes("Ж"), "The hint must not quote page text");

	// An empty page writes no file and says so instead of looking like a failure.
	page.text = "";
	const emptyRead = await module.command({ action: "read" });
	assert.equal(emptyRead.details.error, undefined);
	assert.equal(emptyRead.details.text, "");
	assert.equal(emptyRead.details.totalChars, 0);
	assert.equal(emptyRead.details.path, undefined, "Nothing to store means no file");
	assert.match(String(emptyRead.details.hint), /no text/);
	assert.equal(savedPageFiles.length, 1, "An empty page writes no file");
	page.text = "Ж".repeat(2_500);

	// Heavy snapshot: the node cap is kept, the dropped count is stated, and only
	// a bounded preview (whole node lines) is returned.
	const snap = await module.command({ action: "snapshot" });
	const snapshot = String(snap.details.snapshot);
	assert.equal(snap.details.nodes, SNAPSHOT_NODES);
	assert.equal(snap.details.droppedNodes, 50);
	assert.equal(snap.details.totalNodes, 100);
	assert.equal(snap.details.truncated, true);
	assert.equal(snap.details.previewTruncated, true, "The preview is smaller than the capped snapshot");
	assert.ok(snapshot.length <= PREVIEW_CHARS && snapshot.length > 0);
	for (const line of snapshot.split("\n")) assert.ok(lines.includes(line), "The snapshot preview keeps whole node lines so refs stay usable");
	assert.match(String(snap.details.hint), /50 dropped by maxSnapshotNodes=50/);
	assert.match(String(snap.details.hint), /narrow the selector/);
	assert.ok(!snapshot.includes("[truncated:"), "No node-cap marker is smuggled into the preview");
	assert.ok(JSON.stringify(snap).length < 20_000, "The snapshot payload must stay bounded");
	page.heavySnapshot = `- link "${"a".repeat(400)}" [ref=e1]\n${lines[0]}`;
	const clippedSnap = await module.command({ action: "snapshot" });
	assert.match(String(clippedSnap.details.snapshot), /…\[\+\d+ chars\]/, "Long node lines are clipped per node");

	// A forced CDP/protocol extraction error fails the call, not the session.
	const filesBeforeFailure = listPageFiles().length;
	page.error = new Error("Protocol error (Runtime.callFunctionOn): Target closed");
	const failed = await module.command({ action: "read" });
	assert.match(String(failed.details.error), /Protocol error .*Target closed/);
	assert.match(String(failed.details.error), /browser session was kept/);
	assert.equal(failed.details.text, "");
	assert.equal(failed.details.path, undefined, "A failed read writes no file");
	assert.equal(failed.details.failed, true);
	assert.equal(listPageFiles().length, filesBeforeFailure, "A failed read must not write an empty file");
	assert.equal(savedPageFiles.length, 1, "A failed read must not call the workspace writer");
	assert.equal(page.closed, false, "A failed read must not close the page");
	assert.equal(module.status().paused, false, "A failed read must not pause the session");
	page.error = undefined;
	const recovered = await module.command({ action: "read" });
	assert.equal(recovered.details.error, undefined, "The session must stay usable after a failed read");
	assert.ok(String(recovered.details.text).startsWith("Ж"));
	assert.equal(listPageFiles().length, filesBeforeFailure + 1, "A recovered read writes a fresh file");
	assert.equal(savedPageFiles.length, 2);

	// A heavy page that never answers is bounded by the extraction deadline.
	let release!: () => void;
	page.delay = new Promise<void>(resolve => { release = resolve; });
	const timedOut = await module.command({ action: "read" });
	assert.equal(timedOut.details.timedOut, true);
	assert.match(String(timedOut.details.error), /within 400 ms/);
	assert.match(String(timedOut.details.error), /browser session was kept/);
	assert.equal(timedOut.details.text, "", "A timeout must not pretend to return an empty page");
	assert.equal(timedOut.details.path, undefined, "A timed-out read writes no file");
	assert.equal(module.status().paused, false);
	page.delay = undefined; release();
	const afterTimeout = await module.command({ action: "read" });
	assert.equal(afterTimeout.details.error, undefined, "The session must stay usable after a timed-out extraction");

	console.log(`Browser heavy-page test passed: ${PREVIEW_CHARS}-char preview with ${PAGE_TEXT_CHARS}-char guarded page file (${relativePath}), node cap reporting (${SNAPSHOT_NODES} kept / 50 dropped), bounded catalog probe, per-call extraction errors and timeouts without closing the session, preview/file/limit validation`);
} finally {
	await host.stop();
	fs.rmSync(root, { recursive: true, force: true });
}
