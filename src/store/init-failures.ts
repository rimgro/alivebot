/**
 * Consecutive failed boots, so a permanent init error cannot become a restart
 * loop (#173 follow-up, see #178: one broken unit produced 7992 starts a day).
 *
 * A service manager with `Restart=` retries a non-zero exit immediately, and a
 * broken profile fails the same way every time. The counter is written *before*
 * the process exits, so the next start can see the streak; once the streak
 * reaches `INIT_FAILURE_STAY_THRESHOLD` inside `INIT_FAILURE_WINDOW_MS` the
 * runtime stops exiting and stays alive in `status: "error"` instead — one
 * visible failure and no hot restart cycle.
 *
 * File: `<stateDir>/init-failures.json`:
 *
 *   { "consecutive": 3, "lastFailureAt": "2026-11-05T01:35:00.000Z", "lastError": "…" }
 *
 * A missing or corrupt file means "no streak" (0): a fresh profile must be
 * allowed to retry, and a damaged counter must never block a boot forever.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { ensureDir, readJson, writeJsonAtomic } from "../util.js";

/** Failed boots in a row that keep the process alive in `status: "error"` instead of exiting. */
export const INIT_FAILURE_STAY_THRESHOLD = 3;

/** Two failures further apart than this are separate incidents, not one streak. */
export const INIT_FAILURE_WINDOW_MS = 30 * 60_000;

/** File name inside `<stateDir>`. */
export const INIT_FAILURES_FILE = "init-failures.json";

/** The counter as the runtime uses it (timestamps parsed to wall clock). */
export interface InitFailureRecord {
	/** Failed boots in a row, including the latest one. */
	consecutive: number;
	/** Wall clock of the latest failed boot; 0 when unknown. */
	lastFailureAt: number;
	/** Masked message of the latest failed boot. */
	lastError?: string;
}

/** On-disk shape: `lastFailureAt` is an ISO string so a human can read the file. */
interface StoredInitFailureRecord {
	consecutive?: unknown;
	lastFailureAt?: unknown;
	lastError?: unknown;
}

export function initFailuresPath(stateDir: string): string {
	return path.join(stateDir, INIT_FAILURES_FILE);
}

/**
 * Read the streak. Missing, unparsable, negative or fractional counters all read
 * as 0, so a corrupt file can only make the runtime *more* willing to retry.
 */
export function readInitFailures(stateDir: string): InitFailureRecord {
	const stored = readJson<StoredInitFailureRecord | null>(initFailuresPath(stateDir), null);
	if (!stored || typeof stored !== "object" || Array.isArray(stored)) return { consecutive: 0, lastFailureAt: 0 };
	const consecutive =
		typeof stored.consecutive === "number" && Number.isFinite(stored.consecutive) && stored.consecutive > 0
			? Math.trunc(stored.consecutive)
			: 0;
	const parsed =
		typeof stored.lastFailureAt === "string"
			? Date.parse(stored.lastFailureAt)
			: typeof stored.lastFailureAt === "number"
				? stored.lastFailureAt
				: Number.NaN;
	return {
		consecutive,
		lastFailureAt: Number.isFinite(parsed) && parsed > 0 ? parsed : 0,
		...(typeof stored.lastError === "string" && stored.lastError.length > 0 ? { lastError: stored.lastError } : {}),
	};
}

/** Persist the streak atomically (tmp file + rename), before the process exits. */
export function writeInitFailures(stateDir: string, record: InitFailureRecord): void {
	ensureDir(stateDir);
	const stored: StoredInitFailureRecord = {
		consecutive: record.consecutive,
		lastFailureAt: new Date(record.lastFailureAt).toISOString(),
		...(record.lastError ? { lastError: record.lastError } : {}),
	};
	writeJsonAtomic(initFailuresPath(stateDir), stored);
}

/**
 * Forget the streak after a successful boot. Removing the file (instead of
 * writing `consecutive: 0`) keeps `state/` free of stale diagnostics and makes
 * the next start read 0 exactly like a fresh profile.
 */
export function resetInitFailures(stateDir: string): void {
	try {
		fs.rmSync(initFailuresPath(stateDir), { force: true });
	} catch {
		// Best effort: an unreadable counter must never fail a working boot.
	}
}

/** What a failed boot should do next. */
export type InitFailureAction = "exit" | "stay";

export interface InitFailureDecision {
	/** Consecutive failures including the one that just happened. */
	consecutive: number;
	/** `exit` = rethrow, the service manager may retry; `stay` = live in status error. */
	action: InitFailureAction;
	/** True when the previous failure was outside the window, so the count restarted at 1. */
	reset: boolean;
}

/**
 * Pure decision for one failed boot (#173/#178).
 *
 * `consecutive` counts this failure: a previous failure inside
 * `INIT_FAILURE_WINDOW_MS` continues the streak, anything older (or unknown)
 * starts a new one at 1. The runtime only stays alive at
 * `INIT_FAILURE_STAY_THRESHOLD` failures, so the first two failures still exit
 * non-zero and a transient problem keeps its normal retry.
 *
 * `windowMs`/`threshold` exist as test seams only; production always uses the
 * constants above (the operator does not tune the restart guard).
 */
export function initFailureDecision(
	previous: InitFailureRecord | undefined,
	now: number,
	options: { windowMs?: number; threshold?: number } = {},
): InitFailureDecision {
	const windowMs = options.windowMs ?? INIT_FAILURE_WINDOW_MS;
	const threshold = options.threshold ?? INIT_FAILURE_STAY_THRESHOLD;
	const previousCount = previous?.consecutive ?? 0;
	const previousAt = previous?.lastFailureAt ?? 0;
	const withinWindow = previousCount > 0 && previousAt > 0 && now >= previousAt && now - previousAt <= windowMs;
	const consecutive = withinWindow ? previousCount + 1 : 1;
	return {
		consecutive,
		action: consecutive >= threshold ? "stay" : "exit",
		reset: !withinWindow && previousCount > 0,
	};
}
