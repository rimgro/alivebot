/**
 * Size-based rotation for the active structured log (`paths.logFile`,
 * `<stateDir>/logs/alive.jsonl`).
 *
 * The log is written one line at a time with `fs.appendFileSync` and no held
 * descriptor (see `src/util.ts`), so renaming the active file is safe: the next
 * append creates a fresh `alive.jsonl` and nothing keeps writing into a moved
 * inode. Rotation happens before the append that would cross the limit.
 *
 * Policy:
 *   - `ALIVE_LOG_MAX_BYTES` — rotate when the active file would exceed this
 *     many bytes. Default: 16 MiB (16 * 1024 * 1024).
 *   - `ALIVE_LOG_MAX_PARTS` — number of archived parts to keep. Default: 5.
 *     Older parts are deleted in a ring (`1 -> 2 -> ... -> maxParts -> gone`).
 *   - Parts are gzip-compressed as `<file>.N.gz`. A gzip failure is not fatal:
 *     the part stays uncompressed as `<file>.N` and rotation continues.
 *   - A part larger than `maxBytes` is never compressed: it came from a file
 *     that grew past the limit before this policy applied (an older build, a
 *     raised limit, a manual append). `gzipSync` of such a buffer would block
 *     the event loop for seconds inside `Logger.write`, so the part is kept
 *     plain under `<file>.N` and shifted out by later rotations. Reading
 *     handles plain parts, so nothing is lost.
 *
 * Invalid/empty env values silently fall back to the defaults; a bad env var
 * must never take the runtime (and therefore its logging) down.
 *
 * `rotateIfNeeded` also keeps a small per-file size cache. `Logger` supplies
 * `incomingBytes`, so an ordinary line costs one append and no `statSync`; the
 * size is checked with a single `statSync` only on the first write, when the
 * cached size is about to cross the limit, or periodically to notice external
 * writers/truncation.
 *
 * Reading (`readLogTailWithParts`) falls back from the active file to archived
 * parts from newest to oldest, returning lines in old-to-new order. This is
 * what makes `alive logs alive -n N` still show context right after rotation.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import * as zlib from "node:zlib";

export const DEFAULT_LOG_MAX_BYTES = 16 * 1024 * 1024;
export const DEFAULT_LOG_MAX_PARTS = 5;
export const DEFAULT_LOG_STAT_INTERVAL_MS = 1_000;

export const LOG_MAX_BYTES_ENV = "ALIVE_LOG_MAX_BYTES";
export const LOG_MAX_PARTS_ENV = "ALIVE_LOG_MAX_PARTS";

/** A rotation lock older than this is treated as left over by a dead process. */
export const ROTATION_LOCK_STALE_MS = 30_000;

export interface LogRotationOptions {
	/** Rotate when the active file would exceed this many bytes. */
	maxBytes?: number;
	/** Number of archived parts kept; older ones are deleted. */
	maxParts?: number;
	/** Compress archived parts with gzip (default true). */
	gzip?: boolean;
	/** Minimum time between size checks when `incomingBytes` is supplied. */
	statIntervalMs?: number;
	/** Bytes that are about to be appended. Lets the hot path skip `statSync`. */
	incomingBytes?: number;
	/** Force a fresh `statSync` even when the cached size says it is unnecessary. */
	force?: boolean;
	/** Environment source for the two overrides; defaults to `process.env`. */
	env?: NodeJS.ProcessEnv;
	/** Test hook replacing `zlib.gzipSync`. Throwing leaves the part uncompressed. */
	compress?: (data: Buffer) => Buffer;
}

export interface ResolvedLogRotationOptions {
	maxBytes: number;
	maxParts: number;
	gzip: boolean;
	statIntervalMs: number;
	compress?: (data: Buffer) => Buffer;
}

export interface LogRotationResult {
	rotated: boolean;
	/** Active-file size known after this call (including `incomingBytes`). */
	size: number;
	maxBytes: number;
	/** Path of the newly archived part, when rotation happened. */
	part?: string;
}

export interface LogPart {
	index: number;
	file: string;
	gzip: boolean;
}

interface RotationState {
	size: number;
	checkedAt: number;
	maxBytes: number;
}

/** Per-file cached size, shared by all Logger instances in this process. */
const states = new Map<string, RotationState>();

function positiveInteger(value: unknown): number | undefined {
	if (typeof value === "number") {
		return Number.isSafeInteger(value) && value > 0 ? value : undefined;
	}
	if (typeof value !== "string") return undefined;
	const trimmed = value.trim();
	if (!/^\d+$/.test(trimmed)) return undefined;
	const parsed = Number(trimmed);
	return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : undefined;
}

/**
 * Merge explicit options with `ALIVE_LOG_MAX_BYTES` / `ALIVE_LOG_MAX_PARTS`.
 * Explicit values win over env; invalid values fall through to the next source
 * and ultimately to the defaults.
 */
export function resolveLogRotationOptions(options: LogRotationOptions = {}): ResolvedLogRotationOptions {
	const env = options.env ?? process.env;
	return {
		maxBytes:
			positiveInteger(options.maxBytes) ??
			positiveInteger(env[LOG_MAX_BYTES_ENV]) ??
			DEFAULT_LOG_MAX_BYTES,
		maxParts:
			positiveInteger(options.maxParts) ??
			positiveInteger(env[LOG_MAX_PARTS_ENV]) ??
			DEFAULT_LOG_MAX_PARTS,
		gzip: options.gzip ?? true,
		statIntervalMs:
			positiveInteger(options.statIntervalMs) ?? DEFAULT_LOG_STAT_INTERVAL_MS,
		...(options.compress ? { compress: options.compress } : {}),
	};
}

function partFile(file: string, index: number, gzip: boolean): string {
	return gzip ? `${file}.${index}.gz` : `${file}.${index}`;
}

function removePart(file: string, index: number): void {
	for (const candidate of [partFile(file, index, false), partFile(file, index, true)]) {
		try {
			fs.unlinkSync(candidate);
		} catch {
			// Missing is the normal case.
		}
	}
}

/** Move `.N[.gz]` to `.M[.gz]`, preserving whether the part is compressed. */
function renamePart(file: string, from: number, to: number): void {
	const gzFrom = partFile(file, from, true);
	if (fs.existsSync(gzFrom)) {
		fs.renameSync(gzFrom, partFile(file, to, true));
		return;
	}
	const plainFrom = partFile(file, from, false);
	if (fs.existsSync(plainFrom)) fs.renameSync(plainFrom, partFile(file, to, false));
}

function activeSize(file: string): number {
	try {
		return fs.statSync(file).size;
	} catch {
		return 0;
	}
}

/**
 * Shift parts by one, move the active file to `.1`, then compress it.
 * Returns the archived part path, or undefined if rotation itself failed.
 */
function rotateFile(file: string, policy: ResolvedLogRotationOptions): string | undefined {
	try {
		// A lowered maxParts (or leftovers from an older policy) must not leave
		// parts beyond the cap behind.
		for (const part of listLogParts(file)) {
			if (part.index > policy.maxParts) removePart(file, part.index);
		}
		// Shift every existing part one slot to the right, newest first. The
		// oldest part ends up at maxParts + 1 and is dropped below.
		for (let index = policy.maxParts; index >= 1; index--) {
			renamePart(file, index, index + 1);
		}
		fs.renameSync(file, partFile(file, 1, false));
	} catch {
		// Rotation is best-effort: logging must keep working even if the
		// filesystem is unhappy (read-only mount, part raced away, ...).
		return undefined;
	}

	const plain = partFile(file, 1, false);
	const gz = partFile(file, 1, true);
	try {
		// Never gzip a part that already exceeds the threshold: this is the hot
		// path (`Logger.write`), and a synchronous gzip of a 200 MB part would
		// freeze the run. The part stays readable as a plain `.1`.
		if (!policy.gzip || activeSize(plain) > policy.maxBytes) return plain;
		const data = fs.readFileSync(plain);
		const compressed = policy.compress ? policy.compress(data) : zlib.gzipSync(data);
		fs.writeFileSync(gz, compressed);
		fs.unlinkSync(plain);
		return gz;
	} catch {
		// Leave the part uncompressed under the same name, and never leave a
		// partial `.gz` behind.
		try {
			fs.unlinkSync(gz);
		} catch {
			// Nothing to clean up.
		}
		return plain;
	} finally {
		// The part that fell off the end is always removed, compressed or not.
		removePart(file, policy.maxParts + 1);
	}
}

/**
 * One `alive.jsonl` can have several writers: the profile runtime plus short-lived
 * CLI processes (`alive sessions gc`, `alive browser ...`) and a second harness
 * started by hand. Two rotations that interleave their renames silently drop
 * lines (both `active -> .1` renames target the same slot), so rotation is
 * serialised with an `O_EXCL` lock file next to the log. A writer that cannot
 * take the lock skips rotation this time; the next record tries again.
 */
function lockFile(file: string): string {
	return `${file}.rotate.lock`;
}

/** Take the rotation lock; false when another process holds a fresh one. */
function acquireRotationLock(file: string): boolean {
	const lockPath = lockFile(file);
	for (let attempt = 0; attempt < 2; attempt++) {
		try {
			const fd = fs.openSync(lockPath, "wx");
			try {
				fs.writeSync(fd, String(process.pid));
			} finally {
				fs.closeSync(fd);
			}
			return true;
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "EEXIST") return false;
			try {
				if (Date.now() - fs.statSync(lockPath).mtimeMs <= ROTATION_LOCK_STALE_MS) return false;
				// Left over by a process that died mid-rotation: safe to steal.
				fs.unlinkSync(lockPath);
			} catch {
				return false;
			}
		}
	}
	return false;
}

function releaseRotationLock(file: string): void {
	try {
		fs.unlinkSync(lockFile(file));
	} catch {
		// Already gone or never created.
	}
}

/**
 * Rotate `file` if appending `incomingBytes` would take it over the limit.
 * Synchronous and safe to call before every JSONL append.
 */
export function rotateIfNeeded(file: string, options: LogRotationOptions = {}): LogRotationResult {
	const policy = resolveLogRotationOptions(options);
	const incoming = typeof options.incomingBytes === "number" && Number.isFinite(options.incomingBytes)
		? Math.max(0, options.incomingBytes)
		: 0;
	const tracksBytes = typeof options.incomingBytes === "number";
	const key = path.resolve(file);
	const now = Date.now();

	let state = states.get(key);
	if (state && state.maxBytes !== policy.maxBytes) state = undefined;

	// Without incoming bytes we cannot update the cached size ourselves, so a
	// direct caller gets an exact stat on every call (still at most one).
	const shouldStat =
		!state ||
		!tracksBytes ||
		options.force === true ||
		state.size + incoming > policy.maxBytes ||
		now - state.checkedAt >= policy.statIntervalMs;

	if (shouldStat || !state) {
		state = { size: activeSize(file), checkedAt: now, maxBytes: policy.maxBytes };
		states.set(key, state);
	}

	// An empty/missing file has nothing worth rotating; a single record larger
	// than maxBytes cannot be split anyway.
	if (state.size > 0 && state.size + incoming > policy.maxBytes) {
		// Another writer may have rotated (or grown) the file since the cached
		// size was recorded, and the cache is per process. Check the real size
		// and serialise the rotation on disk; a lock held by someone else means
		// that writer is rotating right now, so this append simply goes on top
		// of a slightly oversized file.
		if (acquireRotationLock(file)) {
			try {
				const actual = activeSize(file);
				if (actual > 0 && actual + incoming > policy.maxBytes) {
					const part = rotateFile(file, policy);
					if (part) {
						state.size = incoming;
						state.checkedAt = now;
						return { rotated: true, size: state.size, maxBytes: policy.maxBytes, part };
					}
					// Rotation itself failed (read-only mount, raced part): keep
					// logging into the current file.
					state.size = actual;
				} else {
					state.size = actual;
					state.checkedAt = now;
				}
			} finally {
				releaseRotationLock(file);
			}
		}
	}

	state.size += incoming;
	return { rotated: false, size: state.size, maxBytes: policy.maxBytes };
}

/** Archived parts for `file`, ascending by index (`1` is the newest part). */
export function listLogParts(file: string): LogPart[] {
	let entries: string[];
	try {
		entries = fs.readdirSync(path.dirname(file));
	} catch {
		return [];
	}
	const prefix = `${path.basename(file)}.`;
	const byIndex = new Map<number, LogPart>();
	for (const entry of entries) {
		if (!entry.startsWith(prefix)) continue;
		const match = /^(\d+)(\.gz)?$/.exec(entry.slice(prefix.length));
		if (!match) continue;
		const index = Number(match[1]);
		if (!Number.isSafeInteger(index) || index <= 0) continue;
		const gzip = match[2] === ".gz";
		// If both names somehow exist, prefer the compressed one.
		if (byIndex.has(index) && !gzip) continue;
		byIndex.set(index, { index, file: path.join(path.dirname(file), entry), gzip });
	}
	return [...byIndex.values()].sort((a, b) => a.index - b.index);
}

function readPartLines(part: LogPart): string[] {
	try {
		const raw = part.gzip
			? zlib.gunzipSync(fs.readFileSync(part.file)).toString("utf8")
			: fs.readFileSync(part.file, "utf8");
		return raw.split("\n").filter((line) => line.trim().length > 0);
	} catch {
		return [];
	}
}

function readActiveLines(file: string): string[] {
	try {
		return fs
			.readFileSync(file, "utf8")
			.split("\n")
			.filter((line) => line.trim().length > 0);
	} catch {
		return [];
	}
}

/**
 * Tail `count` non-empty lines from `file` and its archived parts. When the
 * active file is short (for example immediately after rotation), older parts
 * are read newest-first until enough lines are collected; the result is always
 * ordered oldest-to-newest.
 */
export function readLogTailWithParts(file: string, count: number): string[] {
	if (!Number.isFinite(count) || count <= 0) return [];
	const limit = Math.floor(count);
	const active = readActiveLines(file);
	if (active.length >= limit) return active.slice(active.length - limit);

	let collected = active;
	// Index 1 is the newest part; read newest-to-oldest and prepend each chunk.
	const parts = listLogParts(file).sort((a, b) => a.index - b.index);
	for (const part of parts) {
		if (collected.length >= limit) break;
		const lines = readPartLines(part);
		if (lines.length === 0) continue;
		const take = Math.min(lines.length, limit - collected.length);
		if (take <= 0) break;
		collected = lines.slice(lines.length - take).concat(collected);
	}
	return collected;
}
