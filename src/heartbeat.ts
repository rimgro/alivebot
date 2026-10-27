/**
 * Process heartbeat: `<stateDir>/heartbeat.json`.
 *
 * The runtime writes this file once, when the process comes up, and keeps its
 * mtime fresh while it lives. It exists so that something *outside* the agent —
 * a systemd timer, cron, a monitoring box, or the auto-update watchdog — can
 * answer "is the harness running, and which build is it?" without parsing logs,
 * talking to the model, or reading any other state file.
 *
 * Consequences of that job:
 *   - the write is atomic (temp file in the same directory, then rename), so a
 *     reader never sees a half-written file;
 *   - freshness is judged by the file's mtime, not by its contents, so a
 *     long-lived process can refresh liveness cheaply with `utimes`;
 *   - every failure is swallowed and logged at warn: a watchdog signal is never
 *     worth failing startup over.
 *
 * The file deliberately holds only facts about the *process*: pid, start time
 * and the harness build. Agent state (inbox, runs, memory) lives elsewhere.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { UPDATE_MARKER_FILE } from "./update.js";
import { readJson, writeJsonAtomic } from "./util.js";

export const HEARTBEAT_FILE = "heartbeat.json";

/** What is on disk: exactly this shape, nothing else. */
export interface HeartbeatRecord {
	pid: number;
	/** ISO timestamp of the process start. */
	startedAt: string;
	/** Harness package version that is actually running. */
	version: string;
	/** Last release tag applied by `alive update`, when known. */
	tag?: string;
	/** Git branch or short commit the harness runs from, when known. */
	ref?: string;
}

/** The subset of `Logger` the heartbeat needs; a stub is enough in tests. */
export interface HeartbeatLog {
	warn(message: string, data?: unknown): void;
}

export interface HeartbeatWriteOptions {
	stateDir: string;
	pid?: number;
	/** Process start time; defaults to now. */
	startedAt?: number | Date;
	version?: string;
	tag?: string;
	ref?: string;
}

export function heartbeatPath(stateDir: string): string {
	return path.join(stateDir, HEARTBEAT_FILE);
}

/**
 * Write the heartbeat atomically. Throws on filesystem errors; startup code
 * goes through `recordHeartbeat`, which never throws.
 */
export function writeHeartbeat(options: HeartbeatWriteOptions): HeartbeatRecord {
	const identity = harnessIdentity();
	const startedAt =
		options.startedAt instanceof Date
			? options.startedAt
			: new Date(options.startedAt ?? Date.now());
	const record: HeartbeatRecord = {
		pid: options.pid ?? process.pid,
		startedAt: startedAt.toISOString(),
		version: options.version ?? identity.version,
	};
	const tag = options.tag ?? identity.tag;
	if (tag) record.tag = tag;
	const ref = options.ref ?? identity.ref;
	if (ref) record.ref = ref;
	writeJsonAtomic(heartbeatPath(options.stateDir), record);
	return record;
}

/**
 * Start-of-process hook: write the heartbeat, swallow and warn on failure.
 * Returns the record, or undefined when nothing could be written.
 */
export function recordHeartbeat(
	options: HeartbeatWriteOptions & { log?: HeartbeatLog },
): HeartbeatRecord | undefined {
	try {
		return writeHeartbeat(options);
	} catch (error) {
		options.log?.warn("heartbeat write failed", {
			path: heartbeatPath(options.stateDir),
			error: errorMessage(error),
		});
		return undefined;
	}
}

/**
 * Refresh liveness without rewriting the record: only the mtime moves, so
 * `startedAt` keeps pointing at the real process start. Never throws.
 */
export function refreshHeartbeat(stateDir: string, log?: HeartbeatLog, now = Date.now()): boolean {
	const file = heartbeatPath(stateDir);
	try {
		const date = new Date(now);
		fs.utimesSync(file, date, date);
		return true;
	} catch (error) {
		log?.warn("heartbeat refresh failed", { path: file, error: errorMessage(error) });
		return false;
	}
}

/** Read and validate the heartbeat; a corrupt or missing file yields undefined. */
export function readHeartbeat(stateDir: string): HeartbeatRecord | undefined {
	const raw = readJson<Partial<HeartbeatRecord> | null>(heartbeatPath(stateDir), null);
	if (!raw || typeof raw !== "object") return undefined;
	if (typeof raw.pid !== "number" || typeof raw.startedAt !== "string" || typeof raw.version !== "string") {
		return undefined;
	}
	const record: HeartbeatRecord = { pid: raw.pid, startedAt: raw.startedAt, version: raw.version };
	if (typeof raw.tag === "string" && raw.tag) record.tag = raw.tag;
	if (typeof raw.ref === "string" && raw.ref) record.ref = raw.ref;
	return record;
}

export type HeartbeatState = "fresh" | "stale" | "missing";

export interface HeartbeatStatus {
	path: string;
	state: HeartbeatState;
	fresh: boolean;
	staleAfterMs: number;
	/** Time since the heartbeat file was last written; undefined when missing. */
	ageMs?: number;
	/** How long the recorded process has been running; undefined without `startedAt`. */
	uptimeMs?: number;
	heartbeat?: HeartbeatRecord;
}

/**
 * Freshness check used by `alive heartbeat` and (later) by the update watchdog.
 * Age comes from the file mtime, so a running process that refreshes its
 * heartbeat stays fresh and a killed one stops being fresh after `staleAfterMs`.
 */
export function readHeartbeatStatus(stateDir: string, staleAfterMs: number, now = Date.now()): HeartbeatStatus {
	const file = heartbeatPath(stateDir);
	const heartbeat = readHeartbeat(stateDir);
	let mtimeMs: number;
	try {
		mtimeMs = fs.statSync(file).mtimeMs;
	} catch {
		return { path: file, state: "missing", fresh: false, staleAfterMs };
	}
	if (!heartbeat) return { path: file, state: "missing", fresh: false, staleAfterMs };
	const ageMs = Math.max(0, now - mtimeMs);
	const status: HeartbeatStatus = {
		path: file,
		state: ageMs > staleAfterMs ? "stale" : "fresh",
		fresh: ageMs <= staleAfterMs,
		staleAfterMs,
		ageMs,
		heartbeat,
	};
	const startedAtMs = Date.parse(heartbeat.startedAt);
	if (Number.isFinite(startedAtMs)) status.uptimeMs = Math.max(0, now - startedAtMs);
	return status;
}

/** Version/tag/ref of the harness that is executing right now, best effort. */
export interface HarnessIdentity {
	version: string;
	tag?: string;
	ref?: string;
}

/**
 * The harness checkout. `src/heartbeat.ts` and `dist/heartbeat.js` sit one level
 * below it, so one relative hop works for both `tsx src/index.ts` and `dist/`.
 */
function harnessRoot(): string {
	return path.dirname(fileURLToPath(new URL("../package.json", import.meta.url)));
}

export function harnessIdentity(root = harnessRoot()): HarnessIdentity {
	const identity: HarnessIdentity = { version: "unknown" };
	try {
		const parsed = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8")) as { version?: unknown };
		if (typeof parsed.version === "string" && parsed.version.trim()) identity.version = parsed.version.trim();
	} catch {
		// Version stays "unknown": a heartbeat with a pid is still useful.
	}
	const tag = installedTag(root);
	if (tag) identity.tag = tag;
	const ref = gitRef(root);
	if (ref) identity.ref = ref;
	return identity;
}

/** Tag of the last successful `alive update`, read from its root marker. */
function installedTag(root: string): string | undefined {
	const marker = readJson<{ outcome?: unknown; targetTag?: unknown }>(path.join(root, UPDATE_MARKER_FILE), {});
	return marker.outcome === "success" && typeof marker.targetTag === "string" && marker.targetTag.trim()
		? marker.targetTag.trim()
		: undefined;
}

/**
 * Git branch (or short commit for a detached HEAD) without spawning git:
 * `.git/HEAD` is enough, including the `gitdir:` pointer used by worktrees.
 */
function gitRef(root: string): string | undefined {
	try {
		let gitDir = path.join(root, ".git");
		if (fs.statSync(gitDir).isFile()) {
			const pointer = /^gitdir:\s*(.+)$/m.exec(fs.readFileSync(gitDir, "utf8").trim());
			if (!pointer) return undefined;
			gitDir = path.resolve(root, pointer[1]!.trim());
		}
		const head = fs.readFileSync(path.join(gitDir, "HEAD"), "utf8").trim();
		if (head.startsWith("ref: ")) {
			const ref = head.slice(5).trim();
			return ref.replace(/^refs\/heads\//, "").replace(/^refs\/tags\//, "").replace(/^refs\//, "") || undefined;
		}
		return /^[0-9a-f]{7,40}$/i.test(head) ? head.slice(0, 12) : undefined;
	} catch {
		return undefined;
	}
}

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}
