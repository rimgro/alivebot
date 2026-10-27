/** Bounded page extraction.
 *
 * A page is untrusted, potentially enormous input. Nothing derived from it may
 * cross the CDP/agent-browser boundary in full: text is cut inside the renderer
 * and again in Node, snapshots are capped per node and in node count, and every
 * extraction has a deadline. A heavy page then produces a truncated or failed
 * result instead of a wedged or closed browser session.
 *
 * The model never receives the capped text either. `read` writes it to a file
 * under `browser-pages/` and returns a preview plus that path, so a busy page
 * cannot flood the conversation the way a full dump would.
 */

/** Longest single snapshot line (node name, role plus attributes) kept in a result. */
export const MAX_SNAPSHOT_NODE_CHARS = 200;

export interface TextExtraction {
	text: string;
	/** Length of the text observed in the page, before capping. */
	totalChars: number;
	truncated: boolean;
	timedOut: boolean;
	failed: boolean;
	note?: string;
}

export interface SnapshotExtraction {
	snapshot: string;
	/** Non-empty snapshot lines kept in the result. */
	nodes: number;
	/** Non-empty snapshot lines dropped by the node cap. */
	omittedNodes: number;
	truncated: boolean;
	timedOut: boolean;
	failed: boolean;
	note?: string;
}

export interface ExtractionOptions {
	/** Hard cap on returned page text; a truncation marker is appended beyond it. */
	maxChars: number;
	/** Deadline for the whole extraction; exceeding it fails this result only. */
	timeoutMs: number;
	/** Cancellation of the calling action or session. Aborting it rejects. */
	signal?: AbortSignal;
}

export interface SnapshotOptions {
	maxNodes: number;
	maxNodeChars?: number;
	timeoutMs: number;
	signal?: AbortSignal;
}

export class ExtractionTimeoutError extends Error {
	constructor(readonly timeoutMs: number) {
		super(`Page extraction did not finish within ${timeoutMs} ms`);
		this.name = "ExtractionTimeoutError";
	}
}

export function isExtractionTimeout(error: unknown): error is ExtractionTimeoutError {
	return error instanceof ExtractionTimeoutError;
}

/** Playwright reports its own locator deadlines as `TimeoutError`. */
export function isTimeoutError(error: unknown): boolean {
	return isExtractionTimeout(error) || (error instanceof Error && error.name === "TimeoutError");
}

/** `[truncated: N more characters]` when the remaining size is known. */
export function textTruncationMarker(remaining: number): string {
	return `\n[truncated: ${remaining} more characters]`;
}

/** Used when a transport already capped the payload, so the remainder is unknown. */
export function cappedTextMarker(maxChars: number): string {
	return `\n[truncated: page output exceeded ${maxChars} characters; the rest was dropped]`;
}

export function snapshotTruncationMarker(omittedNodes: number): string {
	return `[truncated: ${omittedNodes} more snapshot nodes]`;
}

/** Used when the transport already cut the snapshot, so node totals are unknown. */
export function cappedSnapshotMarker(maxChars: number): string {
	return `[truncated: snapshot output exceeded ${maxChars} characters; the rest was dropped]`;
}

/**
 * Bounded preview handed to the model. The full text is not returned: it is
 * written to a workspace file that the agent can read in chunks.
 */
export function previewText(value: string, maxChars: number): string {
	return value.length > maxChars ? value.slice(0, maxChars) : value;
}

/**
 * Snapshot preview cut at a line boundary, so every `@eN`/`ref=eN` in it stays
 * usable. Only whole node lines are kept; the dropped nodes are counted
 * separately instead of being appended as an unreadable partial line.
 */
export function previewSnapshot(value: string, maxChars: number): { preview: string; truncated: boolean } {
	if (value.length <= maxChars) return { preview: value, truncated: false };
	const cut = value.lastIndexOf("\n", maxChars);
	return { preview: cut > 0 ? value.slice(0, cut) : value.slice(0, maxChars), truncated: true };
}

/**
 * Cap page text. `totalChars` is the size measured in the page; `cappedBySource`
 * marks a value a transport already cut, so the remainder is unknown instead of
 * being guessed.
 */
export function capText(value: string, maxChars: number, totalChars = value.length, cappedBySource = false): TextExtraction {
	if (value.length <= maxChars && totalChars <= maxChars) {
		return { text: value, totalChars, truncated: false, timedOut: false, failed: false };
	}
	const text = value.slice(0, maxChars);
	const marker = cappedBySource ? cappedTextMarker(maxChars) : textTruncationMarker(Math.max(1, totalChars - maxChars));
	return { text: text + marker, totalChars, truncated: true, timedOut: false, failed: false };
}

/** Cap snapshot node count and per-node line length, naming the omitted nodes. */
export function capSnapshot(value: string, maxNodes: number, maxNodeChars = MAX_SNAPSHOT_NODE_CHARS): SnapshotExtraction {
	const lines = value.split("\n");
	const kept: string[] = [];
	let nodes = 0, omittedNodes = 0, clipped = 0;
	for (const line of lines) {
		if (!line.trim()) { kept.push(line); continue; }
		if (nodes >= maxNodes) { omittedNodes++; continue; }
		nodes++;
		if (line.length > maxNodeChars) {
			kept.push(`${line.slice(0, maxNodeChars)} …[+${line.length - maxNodeChars} chars]`);
			clipped++;
		} else kept.push(line);
	}
	if (omittedNodes) kept.push(snapshotTruncationMarker(omittedNodes));
	return {
		snapshot: kept.join("\n").replace(/\n+$/, ""),
		nodes, omittedNodes,
		truncated: omittedNodes > 0 || clipped > 0,
		timedOut: false, failed: false,
	};
}

/**
 * Runs inside the page. Only the capped prefix is serialized over CDP, so a
 * multi-megabyte document cannot flood the connection; the full length is
 * reported so the result can name what was dropped.
 */
export function pageTextExtractor(element: { innerText?: string | null; textContent?: string | null }, maxChars: number): { text: string; total: number } {
	const value = typeof element.innerText === "string" ? element.innerText : element.textContent ?? "";
	return { text: value.length > maxChars ? value.slice(0, maxChars) : value, total: value.length };
}

export type TextSource = () => Promise<string | { text: string; total?: number; capped?: boolean }>;

export async function extractText(source: TextSource, options: ExtractionOptions): Promise<TextExtraction> {
	let measured: string | { text: string; total?: number; capped?: boolean };
	try {
		measured = await withDeadline(source, options.timeoutMs, options.signal);
	} catch (error) {
		if (options.signal?.aborted) throw options.signal.reason ?? error;
		return { text: "", totalChars: 0, truncated: false, timedOut: isTimeoutError(error), failed: true, note: extractionNote(error, options.timeoutMs, "read the page text") };
	}
	if (typeof measured === "string") return capText(measured, options.maxChars);
	return capText(measured.text, options.maxChars, measured.total ?? measured.text.length, measured.capped === true);
}

export async function extractSnapshot(source: () => Promise<string | { snapshot: string; capped?: boolean; maxChars?: number }>, options: SnapshotOptions): Promise<SnapshotExtraction> {
	let measured: string | { snapshot: string; capped?: boolean; maxChars?: number };
	try {
		measured = await withDeadline(source, options.timeoutMs, options.signal);
	} catch (error) {
		if (options.signal?.aborted) throw options.signal.reason ?? error;
		return { snapshot: "", nodes: 0, omittedNodes: 0, truncated: false, timedOut: isTimeoutError(error), failed: true, note: extractionNote(error, options.timeoutMs, "build the page snapshot") };
	}
	if (typeof measured === "string") return capSnapshot(measured, options.maxNodes, options.maxNodeChars);
	const extraction = capSnapshot(measured.snapshot, options.maxNodes, options.maxNodeChars);
	if (measured.capped) {
		extraction.snapshot += `\n${cappedSnapshotMarker(measured.maxChars ?? extraction.snapshot.length)}`;
		extraction.truncated = true;
	}
	return extraction;
}

/**
 * Bounds one extraction. The losing operation is left to settle on its own so a
 * slow CDP response can never keep the agent's tool call (or its queue) open.
 */
export async function withDeadline<T>(operation: () => Promise<T>, timeoutMs: number, signal?: AbortSignal): Promise<T> {
	if (signal?.aborted) throw signal.reason ?? new Error("Browser action was cancelled");
	let timer: ReturnType<typeof setTimeout> | undefined;
	let onAbort: (() => void) | undefined;
	const deadline = new Promise<never>((_, reject) => {
		timer = setTimeout(() => reject(new ExtractionTimeoutError(timeoutMs)), timeoutMs);
	});
	const aborted = new Promise<never>((_, reject) => {
		onAbort = () => reject(signal!.reason ?? new Error("Browser action was cancelled"));
		signal?.addEventListener("abort", onAbort, { once: true });
	});
	try {
		return await Promise.race([operation(), deadline, aborted]);
	} finally {
		clearTimeout(timer);
		if (onAbort) signal?.removeEventListener("abort", onAbort);
	}
}

/** Readable, bounded failure text; never echoes page content or browser endpoints. */
export function extractionNote(error: unknown, timeoutMs: number, action: string): string {
	if (isExtractionTimeout(error)) {
		return `Could not ${action} within ${timeoutMs} ms: the page is too heavy or busy. Nothing was returned. Scope the read with a selector for the needed block and retry; the browser session was kept.`;
	}
	const message = (error instanceof Error ? error.message : String(error)).replace(/\s+/g, " ").trim();
	const detail = message.slice(0, 300);
	return `Could not ${action}: ${detail || "unknown browser error"}. The browser session was kept; retry after the page finishes loading.`;
}
