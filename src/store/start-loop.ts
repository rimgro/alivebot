/**
 * Process starts inside a rolling window, so an operator can see a restart loop
 * even when every individual boot looks harmless (#178).
 *
 * A service manager with `Restart=always` can start a process many times in a
 * few minutes; the runtime itself cannot stop that, but it can count the starts
 * and expose the count in the heartbeat (`alive status`, the dashboard card and
 * `heartbeat.json`). Once `START_LOOP_THRESHOLD` starts fall inside
 * `START_LOOP_WINDOW_MS` the status is `warn: true`, and the runtime logs one
 * warning per process.
 *
 * File: `<stateDir>/starts.json`:
 *
 *   { "starts": ["2026-11-05T01:35:00.000Z", "2026-11-05T01:36:12.000Z"] }
 *
 * Entries are ISO timestamps, oldest first. A missing or corrupt file means
 * "no starts": a fresh profile must be allowed to boot, and a damaged counter
 * must never block a start or pretend there is a loop.
 */
import * as path from "node:path";
import { ensureDir, readJson, writeJsonAtomic } from "../util.js";

/** Starts inside this window that make the status warn. */
export const START_LOOP_WINDOW_MS = 10 * 60_000;

/** Starts in the window (including the current one) that count as a restart loop. */
export const START_LOOP_THRESHOLD = 5;

/** Upper bound on stored timestamps; older entries are dropped first. */
export const START_LOOP_MAX_ENTRIES = 50;

/** File name inside `<stateDir>`. */
export const STARTS_FILE = "starts.json";

/**
 * What the runtime and the outside observers see. `starts` counts the current
 * process too, `warn` is true at the threshold.
 */
export interface StartLoopStatus {
	/** Process starts inside the window, including the current one. */
	starts: number;
	/** Length of the window in whole seconds. */
	windowSeconds: number;
	/** Starts in the window that make `warn` true. */
	threshold: number;
	/** True when `starts >= threshold`. */
	warn: boolean;
}

/** On-disk shape: an array of ISO timestamps, oldest first. */
interface StoredStarts {
	starts?: unknown;
}

/**
 * ISO-8601 timestamps only. The writer always emits `toISOString()`; accepting
 * a bare number or a human date here would let unrelated numbers grow the
 * counter, so anything that does not look like an ISO timestamp is dropped.
 */
const ISO_TIMESTAMP_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?(?:Z|[+-]\d{2}:\d{2})$/;

export function startLoopPath(stateDir: string): string {
	return path.join(stateDir, STARTS_FILE);
}

function startLoopStatus(starts: number): StartLoopStatus {
	return {
		starts,
		windowSeconds: START_LOOP_WINDOW_MS / 1_000,
		threshold: START_LOOP_THRESHOLD,
		warn: starts >= START_LOOP_THRESHOLD,
	};
}

/** Parse the timestamps that are actually ISO; anything else is ignored. */
function readStoredStarts(stateDir: string): number[] {
	const stored = readJson<StoredStarts | null>(startLoopPath(stateDir), null);
	if (!stored || typeof stored !== "object" || Array.isArray(stored)) return [];
	const entries = (stored as StoredStarts).starts;
	if (!Array.isArray(entries)) return [];
	const starts: number[] = [];
	for (const entry of entries) {
		if (typeof entry !== "string") continue;
		const value = entry.trim();
		if (!ISO_TIMESTAMP_RE.test(value)) continue;
		const parsed = Date.parse(value);
		if (Number.isFinite(parsed)) starts.push(parsed);
	}
	return starts;
}

/**
 * Keep only entries inside the rolling window. Anything older than the window
 * is a previous incident, and a timestamp too far in the future is corrupt
 * (clock jump or a hand-edited file): accepting it would dilute the count for
 * as long as the window lasts. The result is sorted oldest first.
 */
function filterStarts(starts: number[], now: number): number[] {
	const cutoff = now - START_LOOP_WINDOW_MS;
	const futureLimit = now + 60_000;
	return starts
		.filter((ts) => ts >= cutoff && ts <= futureLimit)
		.sort((left, right) => left - right);
}

/**
 * Read-only view of the counter. Does not write anything, so `alive status`
 * and the dashboard can ask repeatedly without moving the file.
 *
 * Missing, unreadable or corrupt files read as 0 starts; the function never
 * throws.
 */
export function readStartLoop(stateDir: string, now = Date.now()): StartLoopStatus {
	try {
		return startLoopStatus(filterStarts(readStoredStarts(stateDir), now).length);
	} catch {
		return startLoopStatus(0);
	}
}

/**
 * Record the current process start and return the updated status.
 *
 * The file is read, stale/invalid timestamps are dropped, `now` is appended,
 * and the result is truncated to `START_LOOP_MAX_ENTRIES` (oldest first) and
 * written atomically. Filesystem and JSON failures never escape: a broken
 * counter must not fail a boot, so the caller still gets a status for the
 * process that just started.
 */
export function recordProcessStart(stateDir: string, now = Date.now()): StartLoopStatus {
	let starts: number[] = [];
	try {
		starts = filterStarts(readStoredStarts(stateDir), now);
	} catch {
		// Treat an unreadable counter as empty; this process still counts.
	}
	const next = [...starts, now]
		.sort((left, right) => left - right)
		.slice(-START_LOOP_MAX_ENTRIES);
	const status = startLoopStatus(next.length);
	try {
		ensureDir(stateDir);
		writeJsonAtomic(startLoopPath(stateDir), {
			starts: next.map((ts) => new Date(ts).toISOString()),
		});
	} catch {
		// Best effort: a heartbeat status is still useful without persistence.
	}
	return status;
}
