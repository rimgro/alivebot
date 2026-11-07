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
 * - `gc` itself never deletes a transcript: it only MOVES files into
 *   `<stateDir>/sessions-archive-<YYYYMMDD-HHMM>/`;
 * - the active transcript (from `runtime.json`'s `sessionFile`) and any file
 *   touched in the last `ACTIVE_SESSION_MTIME_GUARD_MS` are never moved;
 * - a failed move leaves the file in place and only logs a warning.
 *
 * Archive rotation (#228, off by default) is the only code path that deletes
 * anything, and it can only ever reach files INSIDE `sessions-archive-*`
 * directories: the live `sessions/` directory is never touched.
 *
 * Deliberately free of pi/runtime imports: the CLI can use it without pulling
 * the runtime in, and the tests can drive it on plain fixtures.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { StringDecoder } from "node:string_decoder";
import { pipeline } from "node:stream/promises";
import { createGzip } from "node:zlib";
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

// ---------------------------------------------------------------------------
// archive rotation: free the disk the archives themselves hold (#228)
// ---------------------------------------------------------------------------

/** Archive files older than this many days are gzipped (`sessions.archiveRotate.gzipAfterDays`). */
export const DEFAULT_ARCHIVE_GZIP_AFTER_DAYS = 7;
/** Archive files older than this many days are deleted (`sessions.archiveRotate.deleteAfterDays`). */
export const DEFAULT_ARCHIVE_DELETE_AFTER_DAYS = 30;
/** The only directories rotation may touch: `gc`'s own archive convention. */
export const ARCHIVE_DIR_NAME_RE = /^sessions-archive-\d{8}-\d{4}$/;

export interface SessionRotateOptions {
	/** Directory holding the `sessions-archive-*` directories (the state directory). */
	stateDir: string;
	log?: Logger;
	/** `false` (the default) means rotation never touches anything unless `dryRun`. */
	enabled?: boolean;
	/** Age in days above which an archive file is gzipped (default 7). */
	gzipAfterDays?: number;
	/** Age in days above which an archive file is deleted (default 30). */
	deleteAfterDays?: number;
	/** Report what would happen without gzipping, deleting, renaming or creating anything. */
	dryRun?: boolean;
	/** Clock seam for tests. */
	now?: number;
}

export type SessionRotateAction = "gzipped" | "deleted" | "error";

export interface SessionRotateEntry {
	/** Basename of the `sessions-archive-*` directory inside `stateDir`. */
	dir: string;
	/** Basename of the file inside that directory. */
	name: string;
	path: string;
	action: SessionRotateAction;
	bytesBefore: number;
	/** Size after rotation; `null` for a dry-run gzip (unknown until compressed). */
	bytesAfter: number | null;
	/** Age from mtime at scan time. */
	ageDays: number;
	detail?: string;
}

export interface SessionRotateResult {
	enabled: boolean;
	dryRun: boolean;
	gzipAfterDays: number;
	deleteAfterDays: number;
	stateDir: string;
	/** Number of `sessions-archive-*` directories scanned. */
	dirs: number;
	/** Number of regular files directly inside those directories. */
	files: number;
	/** Counts are "would" counts in a dry run. */
	gzipped: number;
	deleted: number;
	/** Archive directories removed because rotation emptied them (empty in a dry run). */
	removedDirs: string[];
	/** Bytes of every archive file seen before rotation. */
	bytesBefore: number;
	/** Bytes left afterwards; `null` when a dry run cannot know the gzip result. */
	bytesAfter: number | null;
	freedBytes: number;
	entries: SessionRotateEntry[];
}

export interface SessionArchiveUsage {
	dirs: number;
	files: number;
	bytes: number;
	/** Age of the oldest archive file; `null` when there is no file. */
	oldestAgeDays: number | null;
}

/** Direct children of `stateDir` that are `sessions-archive-YYYYMMDD-HHMM` directories. */
function listArchiveDirs(stateDir: string): string[] {
	let names: string[];
	try {
		names = fs.readdirSync(stateDir);
	} catch {
		// No state directory yet (or it is unreadable): nothing to rotate.
		return [];
	}
	const dirs: string[] = [];
	for (const name of names) {
		if (!ARCHIVE_DIR_NAME_RE.test(name)) continue;
		const dir = path.join(stateDir, name);
		let stats: fs.Stats;
		try {
			// lstat, never stat: a symlink is not an archive directory and is not followed.
			stats = fs.lstatSync(dir);
		} catch {
			continue;
		}
		if (!stats.isDirectory()) continue;
		dirs.push(dir);
	}
	return dirs.sort();
}

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

/**
 * Rotate `alive sessions gc`'s archive directories (#228): gzip archive files
 * older than `gzipAfterDays`, delete the ones older than `deleteAfterDays`, and
 * remove archive directories that become empty.
 *
 * The decision is made PER FILE, not per directory ("the whole directory is old
 * enough, drop it"): one archive directory mixes ages, so a directory-level
 * rule would sooner or later delete a recent transcript that was moved
 * alongside old ones. Only files inside `sessions-archive-*` directories can be
 * deleted (the manager's requirement), and the live `sessions/` directory is
 * never scanned at all.
 *
 * A failed gzip/unlink is a warning, not a failure: the file is left in place
 * and the rest continues. The only throws are invalid numeric options.
 */
export async function rotateSessionArchives(options: SessionRotateOptions): Promise<SessionRotateResult> {
	const stateDir = path.resolve(options.stateDir);
	const log = options.log;
	const now = options.now ?? Date.now();
	const dryRun = options.dryRun === true;
	const enabled = options.enabled === true;
	const gzipAfterDays = options.gzipAfterDays ?? DEFAULT_ARCHIVE_GZIP_AFTER_DAYS;
	if (!Number.isFinite(gzipAfterDays) || gzipAfterDays < 0) throw new Error("gzipAfterDays must be a non-negative number");
	const deleteAfterDays = options.deleteAfterDays ?? DEFAULT_ARCHIVE_DELETE_AFTER_DAYS;
	if (!Number.isFinite(deleteAfterDays) || deleteAfterDays < 0) throw new Error("deleteAfterDays must be a non-negative number");

	const entries: SessionRotateEntry[] = [];
	const result: SessionRotateResult = {
		enabled,
		dryRun,
		gzipAfterDays,
		deleteAfterDays,
		stateDir,
		dirs: 0,
		files: 0,
		gzipped: 0,
		deleted: 0,
		removedDirs: [],
		bytesBefore: 0,
		bytesAfter: 0,
		freedBytes: 0,
		entries,
	};
	// Disabled and not previewing: report the switch, scan nothing, change nothing.
	if (!enabled && !dryRun) return result;

	for (const dir of listArchiveDirs(stateDir)) {
		result.dirs += 1;
		const dirName = path.basename(dir);
		let names: string[];
		try {
			names = fs.readdirSync(dir).sort();
		} catch (error) {
			log?.warn("cannot read session archive directory; skipping it", { dir, error: errorMessage(error) });
			continue;
		}
		for (const name of names) {
			const file = path.join(dir, name);
			let stats: fs.Stats;
			try {
				stats = fs.lstatSync(file);
			} catch {
				// Vanished between readdir and lstat: nothing to do.
				continue;
			}
			// Only regular files directly inside the archive directory: subdirectories
			// are never recursed into and symlinks are never followed.
			if (!stats.isFile()) continue;
			result.files += 1;
			result.bytesBefore += stats.size;
			// max(0, ...) so a clock skew cannot produce a negative age.
			const ageDays = Math.max(0, (now - stats.mtimeMs) / DAY_MS);

			if (ageDays >= deleteAfterDays) {
				if (!dryRun) {
					try {
						fs.unlinkSync(file);
					} catch (error) {
						const detail = errorMessage(error);
						log?.warn("cannot rotate session archive file; leaving it in place", { file, error: detail });
						entries.push({ dir: dirName, name, path: file, action: "error", bytesBefore: stats.size, bytesAfter: stats.size, ageDays, detail });
						continue;
					}
				}
				log?.info("session archive file deleted", { file, bytes: stats.size, ageDays, dryRun });
				entries.push({ dir: dirName, name, path: file, action: "deleted", bytesBefore: stats.size, bytesAfter: 0, ageDays });
				result.deleted += 1;
				result.freedBytes += stats.size;
				continue;
			}

			// `.gz` files are already rotated and are never compressed twice.
			if (ageDays < gzipAfterDays || name.endsWith(".gz")) continue;
			const gzPath = `${file}.gz`;
			if (fs.existsSync(gzPath)) {
				// Never overwrite an existing archive: it may be the only copy.
				const detail = `${path.basename(gzPath)} already exists; not overwriting it`;
				log?.warn("cannot rotate session archive file; leaving it in place", { file, error: detail });
				entries.push({ dir: dirName, name, path: file, action: "error", bytesBefore: stats.size, bytesAfter: stats.size, ageDays, detail });
				continue;
			}
			if (dryRun) {
				// A gzip candidate's size is unknown until it is compressed, so it is
				// reported as null and never counted as freed bytes in a preview.
				log?.info("session archive file gzipped", { file, bytes: stats.size, ageDays, dryRun });
				entries.push({ dir: dirName, name, path: file, action: "gzipped", bytesBefore: stats.size, bytesAfter: null, ageDays });
				result.gzipped += 1;
				continue;
			}

			// Streaming, never readFileSync: a single live archive can be ~886 MB.
			const tmp = `${gzPath}.tmp-${process.pid}`;
			try {
				await pipeline(fs.createReadStream(file), createGzip(), fs.createWriteStream(tmp));
				const bytesAfter = fs.statSync(tmp).size;
				fs.renameSync(tmp, gzPath);
				// Keep the original timestamps: the rotation age must not reset by
				// compressing, or a gzipped file would never reach deleteAfterDays.
				fs.utimesSync(gzPath, stats.atime, stats.mtime);
				fs.unlinkSync(file);
				log?.info("session archive file gzipped", { file, bytes: stats.size, bytesAfter, ageDays, dryRun });
				entries.push({ dir: dirName, name, path: file, action: "gzipped", bytesBefore: stats.size, bytesAfter, ageDays });
				result.gzipped += 1;
				result.freedBytes += Math.max(0, stats.size - bytesAfter);
			} catch (error) {
				// A half-written temporary file must not survive a failed gzip.
				try {
					fs.rmSync(tmp, { force: true });
				} catch {
					// Nothing else to do: the source file is what matters.
				}
				const detail = errorMessage(error);
				log?.warn("cannot rotate session archive file; leaving it in place", { file, error: detail });
				entries.push({ dir: dirName, name, path: file, action: "error", bytesBefore: stats.size, bytesAfter: stats.size, ageDays, detail });
			}
		}

		// The archive DIRECTORY goes only once rotation emptied it; a directory
		// that still holds fresh transcripts stays. A dry run removes nothing.
		if (dryRun) continue;
		try {
			if (fs.readdirSync(dir).length === 0) {
				fs.rmdirSync(dir);
				result.removedDirs.push(dir);
			}
		} catch (error) {
			log?.warn("cannot remove empty session archive directory", { dir, error: errorMessage(error) });
		}
	}

	// In a dry run the gzip result is unknown, so the remaining total is unknown too.
	result.bytesAfter = entries.some((entry) => entry.action === "gzipped" && entry.bytesAfter === null)
		? null
		: result.bytesBefore - result.freedBytes;
	return result;
}

/**
 * Read-only size/age of every `sessions-archive-*` directory, for
 * `alive sessions stats`. One level deep, never follows symlinks and silently
 * skips entries it cannot read: stats is best-effort, not a verifier.
 */
export function measureSessionArchives(stateDir: string, options: { now?: number } = {}): SessionArchiveUsage {
	const now = options.now ?? Date.now();
	const result: SessionArchiveUsage = { dirs: 0, files: 0, bytes: 0, oldestAgeDays: null };
	for (const dir of listArchiveDirs(stateDir)) {
		result.dirs += 1;
		let names: string[];
		try {
			names = fs.readdirSync(dir);
		} catch {
			continue;
		}
		for (const name of names) {
			let stats: fs.Stats;
			try {
				stats = fs.lstatSync(path.join(dir, name));
			} catch {
				continue;
			}
			if (!stats.isFile()) continue;
			result.files += 1;
			result.bytes += stats.size;
			const ageDays = Math.max(0, (now - stats.mtimeMs) / DAY_MS);
			if (result.oldestAgeDays === null || ageDays > result.oldestAgeDays) result.oldestAgeDays = ageDays;
		}
	}
	return result;
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
