/**
 * Retention and measurement for pi session transcripts (#222).
 *
 * Pi writes one append-only `<sessionsDir>/<timestamp>_<id>.jsonl` per session.
 * Nothing ever truncates them, so a long-lived agent that sleeps (starts a new
 * transcript) accumulates a directory of old files: one reviewer profile grew
 * 886 MB of transcripts in three days. This module is the operator side of the
 * fix — `alive sessions gc` and `alive sessions stats` — and the cheap
 * "how big is the context of this file" probe used by `openSessionManager`.
 *
 * Hard rules, because these files are the agent's memory of what it did:
 * - nothing is ever deleted: `gc` only MOVES files into
 *   `<stateDir>/sessions-archive-<YYYYMMDD-HHMM>/`;
 * - the active transcript (from `runtime.json`'s `sessionFile`) and any file
 *   touched in the last `ACTIVE_SESSION_MTIME_GUARD_MS` are never moved;
 * - a failed move leaves the file in place and only logs a warning.
 *
 * Deliberately free of pi/runtime imports: the CLI can use it without pulling
 * the runtime in, and the tests can drive it on plain fixtures.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { StringDecoder } from "node:string_decoder";
import type { Logger } from "../log.js";

export const DEFAULT_SESSION_KEEP = 3;
export const DEFAULT_SESSION_OLDER_THAN_DAYS = 14;
/** Default `--max-size-mb`: 0 = no size limit, age alone decides. */
export const DEFAULT_SESSION_MAX_SIZE_MB = 0;
/**
 * A transcript modified less than this recently is treated as live and is never
 * moved, even when `runtime.json` names no session file (a race with a run that
 * has started but not published its state yet).
 */
export const ACTIVE_SESSION_MTIME_GUARD_MS = 10 * 60_000;

const DAY_MS = 24 * 60 * 60_000;
const STATUS_SIZE_TIMEOUT_MS = 2_000;

export type SessionGcAction = "archived" | "skipped";

/** Why a transcript was left alone. */
export type SessionSkipReason = "active" | "recent" | "younger" | "error";
/** Why a transcript was archived. */
export type SessionArchiveReason = "older-than-days" | "max-size";
export type SessionGcReason = SessionSkipReason | SessionArchiveReason;

export interface SessionGcEntry {
	/** Basename inside `sessionsDir`. */
	name: string;
	path: string;
	bytes: number;
	/** Age from mtime at scan time. */
	ageDays: number;
	action: SessionGcAction;
	/** `older-than-days`/`max-size` for an archived file, the skip reason otherwise. */
	reason?: SessionGcReason;
	detail?: string;
}

export interface SessionGcResult {
	sessionsDir: string;
	/** Archive directory for this run; a dry run reports it without creating it. */
	archiveDir: string;
	dryRun: boolean;
	keep: number;
	olderThanDays: number | null;
	maxSizeMb: number;
	scanned: number;
	/** Bytes of every transcript seen before any move. */
	totalBytes: number;
	archived: number;
	skipped: number;
	/** Bytes moved (or, in a dry run, that would be moved). */
	freedBytes: number;
	entries: SessionGcEntry[];
}

export interface SessionGcOptions {
	sessionsDir: string;
	/** Where the archive directories live; defaults to the parent of `sessionsDir`. */
	stateDir?: string;
	log?: Logger;
	/** Newest transcripts always left alone (default 3). */
	keep?: number;
	/** Age in days above which a transcript is archived (default 14). */
	olderThanDays?: number;
	/** When all transcripts together exceed this many MB, archive the oldest first (0 = off). */
	maxSizeMb?: number;
	/** Absolute path of the transcript the runtime currently appends to. */
	activeSessionFile?: string;
	dryRun?: boolean;
	/** Clock seam for tests. */
	now?: number;
}

interface SessionFile {
	name: string;
	path: string;
	bytes: number;
	mtimeMs: number;
}

/** `sessions-archive-YYYYMMDD-HHMM` — the same name the operator used by hand. */
export function sessionArchiveDirName(now: number): string {
	const at = new Date(now);
	const pad = (value: number): string => String(value).padStart(2, "0");
	return `sessions-archive-${at.getFullYear()}${pad(at.getMonth() + 1)}${pad(at.getDate())}-${pad(at.getHours())}${pad(at.getMinutes())}`;
}

function listSessionFiles(sessionsDir: string): SessionFile[] {
	let names: string[];
	try {
		names = fs.readdirSync(sessionsDir);
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
		throw error;
	}
	const files: SessionFile[] = [];
	for (const name of names) {
		if (!name.endsWith(".jsonl")) continue;
		const file = path.join(sessionsDir, name);
		let stats: fs.Stats;
		try {
			stats = fs.lstatSync(file);
		} catch {
			continue;
		}
		// Only regular files: a symlink or a directory is not ours to move.
		if (!stats.isFile()) continue;
		files.push({ name, path: file, bytes: stats.size, mtimeMs: stats.mtimeMs });
	}
	// Newest first; the name is a stable tie-breaker for fixtures and tests.
	return files.sort((a, b) => b.mtimeMs - a.mtimeMs || a.name.localeCompare(b.name));
}

/** First free name in the archive directory, so a second gc never overwrites. */
function archiveTarget(archiveDir: string, name: string): string {
	const direct = path.join(archiveDir, name);
	if (!fs.existsSync(direct)) return direct;
	const extension = path.extname(name);
	const stem = name.slice(0, name.length - extension.length);
	for (let index = 1; ; index += 1) {
		const candidate = path.join(archiveDir, `${stem}-${index}${extension}`);
		if (!fs.existsSync(candidate)) return candidate;
	}
}

/**
 * Apply the retention policy to `sessionsDir`: archive transcripts that are
 * older than `olderThanDays` and/or needed to bring the directory under
 * `maxSizeMb`, always keeping the `keep` newest files and the active one.
 */
export function runSessionGc(options: SessionGcOptions): SessionGcResult {
	const sessionsDir = path.resolve(options.sessionsDir);
	const stateDir = options.stateDir ? path.resolve(options.stateDir) : path.dirname(sessionsDir);
	const log = options.log;
	const now = options.now ?? Date.now();
	const dryRun = options.dryRun === true;
	const keep = options.keep ?? DEFAULT_SESSION_KEEP;
	if (!Number.isInteger(keep) || keep < 0) throw new Error("keep must be a non-negative integer");
	const olderThanDays = options.olderThanDays ?? DEFAULT_SESSION_OLDER_THAN_DAYS;
	if (!Number.isFinite(olderThanDays) || olderThanDays < 0) throw new Error("olderThanDays must be a non-negative number");
	const maxSizeMb = options.maxSizeMb ?? DEFAULT_SESSION_MAX_SIZE_MB;
	if (!Number.isFinite(maxSizeMb) || maxSizeMb < 0) throw new Error("maxSizeMb must be a non-negative number");
	const maxBytes = maxSizeMb > 0 ? Math.round(maxSizeMb * 1024 * 1024) : 0;
	const active = options.activeSessionFile ? path.resolve(options.activeSessionFile) : undefined;

	const files = listSessionFiles(sessionsDir);
	const totalBytes = files.reduce((sum, file) => sum + file.bytes, 0);
	const entries: SessionGcEntry[] = [];
	const archiveDir = path.join(stateDir, sessionArchiveDirName(now));
	const ageDaysOf = (file: SessionFile): number => Math.max(0, (now - file.mtimeMs) / DAY_MS);
	const bytesByPath = new Map(files.map((file) => [file.path, file.bytes] as const));

	const skipped = (file: SessionFile, reason: SessionSkipReason, detail?: string): void => {
		entries.push({
			name: file.name,
			path: file.path,
			bytes: file.bytes,
			ageDays: ageDaysOf(file),
			action: "skipped",
			reason,
			...(detail ? { detail } : {}),
		});
	};

	// Newest `keep` files and the active transcript are out of reach for BOTH
	// rules, so `--keep` means the same thing regardless of the size budget.
	const protectedFiles = new Set(files.slice(0, keep).map((file) => file.path));
	const eligible: SessionFile[] = [];
	for (const file of files) {
		if (protectedFiles.has(file.path)) {
			skipped(file, "recent");
			continue;
		}
		if (active && file.path === active) {
			skipped(file, "active", "named by runtime.json as the current session file");
			continue;
		}
		// A just-written transcript may belong to a run that has not published its
		// state yet (or to a second process). Its mtime says "live", so it is never
		// moved; this also covers "runtime.json names no session file at all".
		if (now - file.mtimeMs < ACTIVE_SESSION_MTIME_GUARD_MS) {
			skipped(file, "active", "modified in the last 10 minutes");
			continue;
		}
		eligible.push(file);
	}

	// Rule 1 — age.
	const selected = new Map<string, SessionArchiveReason>();
	for (const file of eligible) {
		if (ageDaysOf(file) >= olderThanDays) selected.set(file.path, "older-than-days");
	}
	// Rule 2 — total size: archive the oldest untouched transcripts until the
	// remaining bytes fit the budget. Files selected by age already count as
	// freed, so the two rules do not fight over the same bytes.
	if (maxBytes > 0) {
		let remaining = totalBytes - [...selected.keys()].reduce((sum, file) => sum + (bytesByPath.get(file) ?? 0), 0);
		for (const file of [...eligible].sort((a, b) => a.mtimeMs - b.mtimeMs || a.name.localeCompare(b.name))) {
			if (remaining <= maxBytes) break;
			if (selected.has(file.path)) continue;
			selected.set(file.path, "max-size");
			remaining -= file.bytes;
		}
	}

	let archived = 0;
	let freedBytes = 0;
	let archiveCreated = false;
	for (const file of eligible) {
		const reason = selected.get(file.path);
		if (!reason) {
			skipped(file, "younger");
			continue;
		}
		const ageDays = ageDaysOf(file);
		if (!dryRun) {
			try {
				if (!archiveCreated) {
					fs.mkdirSync(archiveDir, { recursive: true });
					archiveCreated = true;
				}
				fs.renameSync(file.path, archiveTarget(archiveDir, file.name));
			} catch (error) {
				// The file stays where it is; gc continues with the rest.
				log?.warn("cannot archive session file; leaving it in place", {
					file: file.path,
					bytes: file.bytes,
					error: error instanceof Error ? error.message : String(error),
				});
				skipped(file, "error", error instanceof Error ? error.message : String(error));
				continue;
			}
		}
		log?.info("session file archived", {
			file: file.path,
			bytes: file.bytes,
			ageDays,
			reason: reason === "max-size" ? "size budget exceeded" : "older than the retention age",
			archiveDir,
		});
		entries.push({ name: file.name, path: file.path, bytes: file.bytes, ageDays, action: "archived", reason });
		archived += 1;
		freedBytes += file.bytes;
	}

	// Stable oldest-first order for the machine-readable output.
	entries.sort((a, b) => b.ageDays - a.ageDays || a.name.localeCompare(b.name));
	return {
		sessionsDir,
		archiveDir,
		dryRun,
		keep,
		olderThanDays,
		maxSizeMb,
		scanned: files.length,
		totalBytes,
		archived,
		skipped: entries.filter((entry) => entry.action === "skipped").length,
		freedBytes,
		entries,
	};
}

export interface SessionDirUsage {
	path: string;
	files: number;
	/** `null` when the scan exceeded its time budget. */
	bytes: number | null;
	complete: boolean;
}

/**
 * Count and size the `*.jsonl` transcripts with a hard time budget, for the
 * `alive status` line: a directory of hundreds of megabytes must never make
 * `status` hang.
 */
export function measureSessions(
	sessionsDir: string,
	options: { timeoutMs?: number; now?: () => number } = {},
): SessionDirUsage {
	const now = options.now ?? Date.now;
	const timeoutMs = options.timeoutMs ?? STATUS_SIZE_TIMEOUT_MS;
	const startedAt = now();
	let names: string[];
	try {
		names = fs.readdirSync(sessionsDir).filter((name) => name.endsWith(".jsonl"));
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return { path: sessionsDir, files: 0, bytes: 0, complete: true };
		// A status line must not fail because a state directory is unreadable.
		return { path: sessionsDir, files: 0, bytes: null, complete: false };
	}
	let bytes = 0;
	let complete = true;
	for (const name of names) {
		if (now() - startedAt > timeoutMs) {
			complete = false;
			break;
		}
		try {
			bytes += fs.statSync(path.join(sessionsDir, name)).size;
		} catch {
			// Removed while scanning; the count is a snapshot anyway.
		}
	}
	return { path: sessionsDir, files: names.length, bytes: complete ? bytes : null, complete };
}

// ---------------------------------------------------------------------------
// stats: where the bytes go (read-only measurement for the base64 question)
// ---------------------------------------------------------------------------

/** Bytes of message content, by kind. `base64` is a superset of `image`. */
export interface SessionContentBytes {
	text: number;
	thinking: number;
	tool: number;
	image: number;
	base64: number;
}

export interface SessionFileStats {
	name: string;
	path: string;
	bytes: number;
	mtimeMs: number;
	ageDays: number;
	lines: number;
	messages: number;
	contentBytes: SessionContentBytes;
	/** Inline image attachments (`{type:"image", data:"<base64>"}`). */
	imageBlocks: number;
	imageBytes: number;
	/** Inline base64 payloads: image data plus `data:` URIs. */
	base64Blocks: number;
	base64Bytes: number;
}

export interface SessionStatsResult {
	sessionsDir: string;
	files: number;
	bytes: number;
	contentBytes: SessionContentBytes;
	imageBlocks: number;
	imageBytes: number;
	base64Blocks: number;
	base64Bytes: number;
	entries: SessionFileStats[];
}

function emptyContentBytes(): SessionContentBytes {
	return { text: 0, thinking: 0, tool: 0, image: 0, base64: 0 };
}

function byteLength(value: unknown): number {
	return typeof value === "string" ? Buffer.byteLength(value, "utf8") : 0;
}

interface StatsAccumulator {
	messages: number;
	contentBytes: SessionContentBytes;
	imageBlocks: number;
	imageBytes: number;
	base64Blocks: number;
	base64Bytes: number;
}

function emptyAccumulator(): StatsAccumulator {
	return { messages: 0, contentBytes: emptyContentBytes(), imageBlocks: 0, imageBytes: 0, base64Blocks: 0, base64Bytes: 0 };
}

/** `data:` URI (optionally `data:image/png;base64,...`). */
function isDataUri(value: string): boolean {
	return value.startsWith("data:") && value.length > 5;
}

/** Walk a parsed JSON value and count `data:` URIs wherever they hide. */
function scanDataUris(value: unknown, acc: StatsAccumulator): void {
	if (typeof value === "string") {
		if (isDataUri(value)) {
			acc.base64Blocks += 1;
			acc.base64Bytes += byteLength(value);
			acc.contentBytes.base64 += byteLength(value);
		}
		return;
	}
	if (Array.isArray(value)) {
		for (const item of value) scanDataUris(item, acc);
		return;
	}
	if (value && typeof value === "object") {
		for (const item of Object.values(value as Record<string, unknown>)) scanDataUris(item, acc);
	}
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

/** Count one content block; `toolRole` sends plain text of tool results to `tool`. */
function scanBlock(block: unknown, toolRole: boolean, acc: StatsAccumulator): void {
	if (typeof block === "string") {
		acc.contentBytes[toolRole ? "tool" : "text"] += byteLength(block);
		return;
	}
	if (!isRecord(block)) return;
	const type = typeof block.type === "string" ? block.type : "";
	switch (type) {
		case "text": {
			acc.contentBytes[toolRole ? "tool" : "text"] += byteLength(block.text);
			return;
		}
		case "thinking": {
			acc.contentBytes.thinking += byteLength(block.thinking) + byteLength(block.text);
			return;
		}
		case "toolCall":
		case "tool_use":
		case "tool_result":
		case "toolResult": {
			acc.contentBytes.tool += byteLength(JSON.stringify(block.arguments ?? block.input ?? block.content ?? {}));
			return;
		}
		case "image": {
			// pi stores `{type:"image", data:"<base64>", mimeType}`.
			const data = typeof block.data === "string" ? block.data : "";
			const bytes = data ? byteLength(data) : byteLength(block.url);
			acc.imageBlocks += 1;
			acc.imageBytes += bytes;
			acc.contentBytes.image += bytes;
			if (data) {
				acc.base64Blocks += 1;
				acc.base64Bytes += bytes;
				acc.contentBytes.base64 += bytes;
			}
			return;
		}
		default: {
			// Unknown block: its `data:` payloads are already counted by the
			// entry-level scan, so nothing to add here.
			return;
		}
	}
}

/** Fold one parsed JSONL entry into the accumulator. */
function scanEntry(entry: unknown, acc: StatsAccumulator): void {
	if (!isRecord(entry)) return;
	// `data:` payloads may also live in tool results / details, not only in
	// message content, so always scan the whole entry for them.
	scanDataUris(entry, acc);
	if (entry.type !== "message") return;
	const message = entry.message;
	if (!isRecord(message)) return;
	acc.messages += 1;
	const role = typeof message.role === "string" ? message.role : "";
	const toolRole = role === "toolResult" || role === "bashExecution";
	const content = message.content;
	if (Array.isArray(content)) {
		for (const block of content) scanBlock(block, toolRole, acc);
		return;
	}
	if (content !== undefined) scanBlock(content, toolRole, acc);
}

/** Read one transcript line by line; returns `null` when it cannot be read. */
function scanSessionFile(file: string, now: number): SessionFileStats | null {
	let stats: fs.Stats;
	try {
		stats = fs.statSync(file);
	} catch {
		return null;
	}
	const acc = emptyAccumulator();
	let lines = 0;
	const consume = (line: string): void => {
		if (!line.trim()) return;
		lines += 1;
		let entry: unknown;
		try {
			entry = JSON.parse(line);
		} catch {
			return;
		}
		scanEntry(entry, acc);
	};
	// Chunked, so a 886 MB transcript is measured without loading it whole.
	let fd: number;
	try {
		fd = fs.openSync(file, "r");
	} catch {
		return null;
	}
	try {
		const decoder = new StringDecoder("utf8");
		const buffer = Buffer.allocUnsafe(1024 * 1024);
		let pending = "";
		for (;;) {
			const read = fs.readSync(fd, buffer, 0, buffer.length, null);
			if (read === 0) break;
			const chunk = pending + decoder.write(buffer.subarray(0, read));
			const parts = chunk.split("\n");
			pending = parts.pop() ?? "";
			for (const line of parts) consume(line);
		}
		consume(pending + decoder.end());
	} catch {
		return null;
	} finally {
		fs.closeSync(fd);
	}
	return {
		name: path.basename(file),
		path: file,
		bytes: stats.size,
		mtimeMs: stats.mtimeMs,
		ageDays: Math.max(0, (now - stats.mtimeMs) / DAY_MS),
		lines,
		messages: acc.messages,
		contentBytes: acc.contentBytes,
		imageBlocks: acc.imageBlocks,
		imageBytes: acc.imageBytes,
		base64Blocks: acc.base64Blocks,
		base64Bytes: acc.base64Bytes,
	};
}

/**
 * Measure every transcript: size, age, messages, bytes by content kind and the
 * inline base64/image share. Read-only; used as the data point for the future
 * "store a file reference instead of a base64 frame" decision, which this
 * module deliberately does not implement.
 */
export function measureSessionStats(
	sessionsDir: string,
	options: { now?: number } = {},
): SessionStatsResult {
	const now = options.now ?? Date.now();
	const result: SessionStatsResult = {
		sessionsDir,
		files: 0,
		bytes: 0,
		contentBytes: emptyContentBytes(),
		imageBlocks: 0,
		imageBytes: 0,
		base64Blocks: 0,
		base64Bytes: 0,
		entries: [],
	};
	for (const file of listSessionFiles(sessionsDir)) {
		const stats = scanSessionFile(file.path, now);
		if (!stats) continue;
		result.files += 1;
		result.bytes += stats.bytes;
		result.imageBlocks += stats.imageBlocks;
		result.imageBytes += stats.imageBytes;
		result.base64Blocks += stats.base64Blocks;
		result.base64Bytes += stats.base64Bytes;
		for (const kind of Object.keys(result.contentBytes) as Array<keyof SessionContentBytes>) {
			result.contentBytes[kind] += stats.contentBytes[kind];
		}
		result.entries.push(stats);
	}
	return result;
}

// ---------------------------------------------------------------------------
// resume guard: how much context would `continue` carry? (#222)
// ---------------------------------------------------------------------------

/** `usage.totalTokens` when present, else the sum of the components. */
function usageContextTokens(usage: Record<string, unknown>): number {
	const total = typeof usage.totalTokens === "number" ? usage.totalTokens : 0;
	if (total > 0) return total;
	const sum = ["input", "output", "cacheRead", "cacheWrite"].reduce(
		(acc, key) => acc + (typeof usage[key] === "number" ? (usage[key] as number) : 0),
		0,
	);
	return sum > 0 ? sum : 0;
}

const RESUME_TAIL_WINDOWS = [256 * 1024, 1024 * 1024, 4 * 1024 * 1024, 16 * 1024 * 1024, 64 * 1024 * 1024];

/** Read at most the last `bytes` bytes of `file` as complete lines. */
function readTailLines(file: string, bytes: number, fileSize: number): string[] {
	const start = Math.max(0, fileSize - bytes);
	const length = fileSize - start;
	const buffer = Buffer.allocUnsafe(length);
	const fd = fs.openSync(file, "r");
	try {
		fs.readSync(fd, buffer, 0, length, start);
	} finally {
		fs.closeSync(fd);
	}
	let text = buffer.toString("utf8");
	if (start > 0) {
		// The first line is truncated; drop it.
		const newline = text.indexOf("\n");
		text = newline === -1 ? "" : text.slice(newline + 1);
	}
	return text.split("\n");
}

/**
 * Context tokens `continue` would resume with, parsed from the transcript tail.
 *
 * Mirrors pi's `estimateContextTokens`: the last assistant `usage` plus a
 * chars/4 estimate of the messages after it. Returns 0 when the file gives no
 * trustworthy answer (unreadable, no usage found, or a compaction after the last
 * usage, where pi itself reports `null`). 0 means "unknown", so the caller keeps
 * the old behaviour instead of guessing.
 */
export function measureSessionFileContext(file: string, options: { maxTailBytes?: number } = {}): number {
	let fileSize: number;
	try {
		fileSize = fs.statSync(file).size;
	} catch {
		return 0;
	}
	if (fileSize === 0) return 0;
	// Never read an 886 MB transcript whole: the largest window is a fixed cap,
	// and a smaller file is simply read in full.
	const cap = RESUME_TAIL_WINDOWS[RESUME_TAIL_WINDOWS.length - 1]!;
	const windows = options.maxTailBytes !== undefined
		? [Math.min(options.maxTailBytes, fileSize)]
		: [...RESUME_TAIL_WINDOWS.filter((size) => size < fileSize), Math.min(fileSize, cap)];
	for (const window of windows) {
		let lines: string[];
		try {
			lines = readTailLines(file, window, fileSize);
		} catch {
			return 0;
		}
		const entries: Record<string, unknown>[] = [];
		for (const line of lines) {
			if (!line.trim()) continue;
			try {
				const parsed = JSON.parse(line) as unknown;
				if (isRecord(parsed)) entries.push(parsed);
			} catch {
				// Truncated or half-written line: ignore it.
			}
		}
		if (entries.length === 0) continue;
		let usageIndex = -1;
		let usageTokens = 0;
		for (let index = entries.length - 1; index >= 0; index -= 1) {
			const entry = entries[index]!;
			if (entry.type !== "message" || !isRecord(entry.message)) continue;
			const message = entry.message;
			if (message.role !== "assistant") continue;
			if (message.stopReason === "aborted" || message.stopReason === "error") continue;
			if (!isRecord(message.usage)) continue;
			const tokens = usageContextTokens(message.usage);
			if (tokens > 0) {
				usageIndex = index;
				usageTokens = tokens;
				break;
			}
		}
		if (usageIndex === -1) {
			// No usable usage in this window: widen it before giving up.
			if (window >= fileSize) return 0;
			continue;
		}
		let trailing = 0;
		for (let index = usageIndex + 1; index < entries.length; index += 1) {
			const entry = entries[index]!;
			if (entry.type !== "message" || !isRecord(entry.message)) continue;
			// Conservative chars/4 estimate, same idea as pi's estimateTokens.
			trailing += Math.ceil(JSON.stringify(entry.message).length / 4);
		}
		// A compaction after the last usage means the context is compacted and its
		// size is unknown until the next model response.
		for (let index = usageIndex + 1; index < entries.length; index += 1) {
			if (entries[index]!.type === "compaction") return 0;
		}
		return usageTokens + trailing;
	}
	return 0;
}

/**
 * Newest `*.jsonl` in `sessionsDir`, the file `SessionManager.continueRecent`
 * would open. With `cwd`, transcripts whose header names another workspace are
 * skipped, exactly like pi's own discovery.
 */
export function mostRecentSessionFile(sessionsDir: string, cwd?: string): string | undefined {
	const wanted = cwd ? path.resolve(cwd) : undefined;
	for (const file of listSessionFiles(sessionsDir)) {
		if (!wanted) return file.path;
		const headerCwd = sessionFileCwd(file.path);
		if (headerCwd && path.resolve(headerCwd) === wanted) return file.path;
	}
	return undefined;
}

/** `cwd` from a transcript header; undefined when the header is not a pi session. */
function sessionFileCwd(file: string): string | undefined {
	let fd: number;
	try {
		fd = fs.openSync(file, "r");
	} catch {
		return undefined;
	}
	try {
		const buffer = Buffer.allocUnsafe(64 * 1024);
		const read = fs.readSync(fd, buffer, 0, buffer.length, 0);
		const firstLine = buffer.toString("utf8", 0, read).split("\n")[0] ?? "";
		const header = JSON.parse(firstLine) as unknown;
		if (!isRecord(header) || header.type !== "session") return undefined;
		return typeof header.cwd === "string" ? header.cwd : undefined;
	} catch {
		return undefined;
	} finally {
		fs.closeSync(fd);
	}
}
