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
	snapshotTruncationMarker, textTruncationMarker,
} from "../modules/browser/extract.js";
import { EventStore } from "../store/events.js";
import { HistoryStore } from "../store/history.js";

const WB_SEARCH = "https://www.wildberries.ru/catalog/0/search.aspx?search=heavy";
const TEXT_MARKER = /\[truncated: 1500 more characters\]/;
const NODE_MARKER = /\[truncated: 50 more snapshot nodes\]/;

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

// --- config validation for the two new limits ---
assert.equal(DEFAULT_BROWSER_CONFIG.maxPageTextChars, 200_000);
assert.equal(DEFAULT_BROWSER_CONFIG.maxSnapshotNodes, 2_000);
validateExtractionLimits({ maxPageTextChars: 1_000, maxSnapshotNodes: 50 });
validateExtractionLimits({ maxPageTextChars: 1_000_000, maxSnapshotNodes: 50_000 });
for (const limits of [
	{ maxPageTextChars: 0, maxSnapshotNodes: 2_000 },
	{ maxPageTextChars: 999, maxSnapshotNodes: 2_000 },
	{ maxPageTextChars: 1_500.5, maxSnapshotNodes: 2_000 },
	{ maxPageTextChars: 1_000_001, maxSnapshotNodes: 2_000 },
	{ maxPageTextChars: Number.NaN, maxSnapshotNodes: 2_000 },
	{ maxPageTextChars: 200_000, maxSnapshotNodes: 49 },
	{ maxPageTextChars: 200_000, maxSnapshotNodes: 50_001 },
	{ maxPageTextChars: 200_000, maxSnapshotNodes: 2_000.5 },
]) {
	assert.throws(() => validateExtractionLimits(limits), /maxPageTextChars|maxSnapshotNodes/);
}
// The module rejects the same values at startup, before any browser is launched.
await assert.rejects(() => new BrowserModule({ port: 0, maxPageTextChars: 500, humanization: { enabled: false } }).start({} as never), /maxPageTextChars/);
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
	{ port: 0, minActionIntervalMs: 0, minNavigationIntervalMs: 0, humanization: { enabled: false }, actionTimeoutMs: 400, maxPageTextChars: 1_000, maxSnapshotNodes: 50 },
	{ launch: (async () => context as unknown as BrowserContext) as BrowserType["launchPersistentContext"] },
);
const loaded = loadConfig({ cwd: root });
const host = new ModuleHost({
	config: loaded, log: new Logger({ console: false }), modules: [module], transports: [],
	ingest: input => EventStore.open(loaded.paths.stateDir).append(input), outbox: () => [], history: HistoryStore.open(loaded.paths.stateDir), runtimeStatus: () => ({}),
});

try {
	await host.init();

	// Heavy page text: capped, marked, and extracted inside the renderer.
	const read = await module.command({ action: "read" });
	const text = String(read.details.text);
	assert.match(text, TEXT_MARKER, "Heavy page text must name the dropped remainder");
	assert.equal(text.length, 1_000 + textTruncationMarker(1_500).length);
	const extraction = read.details.extraction as { truncated: boolean; totalChars: number; timedOut: boolean; failed: boolean; limits: { maxPageTextChars: number; maxSnapshotNodes: number } };
	assert.equal(extraction.truncated, true);
	assert.equal(extraction.totalChars, 2_500);
	assert.equal(extraction.failed, false);
	assert.deepEqual(extraction.limits, { maxPageTextChars: 1_000, maxSnapshotNodes: 50 });
	assert.equal(read.details.error, undefined, "Truncation alone is not a failure");
	assert.equal(page.innerTextCalls, 0, "Unbounded innerText must not cross CDP");
	assert.equal((read.details.content as { state: string }).state, "unconfirmed", "A heavy catalog page without cards stays unconfirmed");
	assert.ok(page.emptyStateProbes >= 2, "The empty-state check must run in the page");
	assert.ok(JSON.stringify(read).length < 20_000, "The tool payload must stay bounded");

	// Heavy snapshot: node cap plus per-node cap.
	const snap = await module.command({ action: "snapshot" });
	const snapshot = String(snap.details.snapshot);
	assert.match(snapshot, NODE_MARKER);
	assert.equal((snap.details.extraction as { nodes: number }).nodes, 50);
	assert.equal((snap.details.extraction as { omittedNodes: number }).omittedNodes, 50);
	assert.ok(JSON.stringify(snap).length < 20_000, "The snapshot payload must stay bounded");
	page.heavySnapshot = `- link "${"a".repeat(400)}" [ref=e1]\n${lines[0]}`;
	const clippedSnap = await module.command({ action: "snapshot" });
	assert.match(String(clippedSnap.details.snapshot), /…\[\+\d+ chars\]/, "Long node lines are clipped per node");

	// A forced CDP/protocol extraction error fails the call, not the session.
	page.error = new Error("Protocol error (Runtime.callFunctionOn): Target closed");
	const failed = await module.command({ action: "read" });
	assert.match(String(failed.details.error), /Protocol error .*Target closed/);
	assert.match(String(failed.details.error), /browser session was kept/);
	assert.equal(failed.details.text, "");
	assert.equal((failed.details.extraction as { failed: boolean }).failed, true);
	assert.equal(page.closed, false, "A failed read must not close the page");
	assert.equal(module.status().paused, false, "A failed read must not pause the session");
	page.error = undefined;
	const recovered = await module.command({ action: "read" });
	assert.equal(recovered.details.error, undefined, "The session must stay usable after a failed read");
	assert.ok(String(recovered.details.text).startsWith("Ж"));

	// A heavy page that never answers is bounded by the extraction deadline.
	let release!: () => void;
	page.delay = new Promise<void>(resolve => { release = resolve; });
	const timedOut = await module.command({ action: "read" });
	assert.equal((timedOut.details.extraction as { timedOut: boolean }).timedOut, true);
	assert.match(String(timedOut.details.error), /within 400 ms/);
	assert.match(String(timedOut.details.error), /browser session was kept/);
	assert.equal(timedOut.details.text, "", "A timeout must not pretend to return an empty page");
	assert.equal(module.status().paused, false);
	page.delay = undefined; release();
	const afterTimeout = await module.command({ action: "read" });
	assert.equal(afterTimeout.details.error, undefined, "The session must stay usable after a timed-out extraction");

	console.log("Browser heavy-page test passed: text/snapshot truncation markers, renderer-side bounded extraction, bounded catalog probe, per-call extraction errors and timeouts without closing the session, extraction limit validation");
} finally {
	await host.stop();
	fs.rmSync(root, { recursive: true, force: true });
}
