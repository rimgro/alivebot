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
 * `version` is read from the checkout's `package.json`, so after `alive update`
 * it can name a release the running process has not loaded yet. `buildId`
 * identifies the code that is actually executing (an explicit build-id file or
 * the mtime of the loaded `dist/index.js`/`src/index.ts`); compare it, not the
 * version alone, when asking which code is running.
 *
 * The file deliberately holds only facts about the *process*: pid, start time
 * and the harness build. Agent state (inbox, runs, memory) lives elsewhere.
 */
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { UPDATE_MARKER_FILE } from "./update.js";
import { readJson, writeJsonAtomic } from "./util.js";
import type { StartLoopStatus } from "./store/start-loop.js";

export const HEARTBEAT_FILE = "heartbeat.json";

/**
 * Best-effort systemd unit state for a managed profile.
 *
 * `none` means there is no usable `systemctl` (or no unit to ask), `unknown`
 * means the command failed or answered something this build does not know.
 */
export type UnitStatus = "active" | "inactive" | "failed" | "activating" | "deactivating" | "unknown" | "none";

const UNIT_STATUS_VALUES: readonly UnitStatus[] = [
	"active",
	"inactive",
	"failed",
	"activating",
	"deactivating",
	"unknown",
	"none",
];

export function isUnitStatus(value: unknown): value is UnitStatus {
	return typeof value === "string" && (UNIT_STATUS_VALUES as readonly string[]).includes(value);
}

/** How long one answered `systemctl show` is trusted. */
export const UNIT_STATUS_CACHE_MS = 30_000;
/** A hung service manager must never hold the scheduler for longer than this. */
export const UNIT_STATUS_TIMEOUT_MS = 2_000;

const unitStatusCache = new Map<string, { status: UnitStatus; checkedAt: number }>();

/** The systemd template instance a managed profile is expected to run as. */
export function systemdUnitName(profileId: string): string {
	return `alive-agent@${profileId}`;
}

/** Test seam: forget every cached unit answer. */
export function resetUnitStatusCache(): void {
	unitStatusCache.clear();
}

/**
 * Ask `systemctl show` for one managed profile's unit, cached for 30 s.
 *
 * The user scope is asked first and the system scope is only a fallback: the
 * runtime starts as `alive-agent@<profile>` in the *user* manager (its unit
 * fragment lives under `~/.config/systemd/user/`), so `is-active` without
 * `--user` answered `inactive` for every healthy managed profile.
 *
 * One `show` per scope replaces `is-active` because `systemctl show` answers
 * both questions in a single spawn: `FragmentPath` says whether the unit exists
 * in that scope at all, and `ActiveState` is its state. `is-active` only
 * answers the second one, so a unit that is genuinely absent looked exactly
 * like a stopped one and there was no way to fall back between scopes.
 *
 * This is diagnostics only. It never throws: a missing `systemctl` reads as
 * `none`, a timeout/failure/unknown answer as `unknown`. At most two spawns are
 * made, each bounded by `UNIT_STATUS_TIMEOUT_MS`, so a wedged service manager
 * cannot hang the caller.
 */
export function detectUnitStatus(
	profileId: string,
	options: { now?: number; cacheTtlMs?: number; envPath?: string } = {},
): UnitStatus {
	const unit = systemdUnitName(profileId);
	const now = options.now ?? Date.now();
	const cached = unitStatusCache.get(unit);
	const ttl = options.cacheTtlMs ?? UNIT_STATUS_CACHE_MS;
	if (cached && now - cached.checkedAt < ttl) return cached.status;
	const status = queryUnitStatus(unit, options.envPath);
	unitStatusCache.set(unit, { status, checkedAt: now });
	return status;
}

function queryUnitStatus(unit: string, envPath = process.env.PATH ?? ""): UnitStatus {
	const executable = findExecutable("systemctl", envPath);
	if (!executable) return "none";

	// The scope that actually owns the runtime. No fallback on a failed call:
	// without an answer from here the system scope would only add noise.
	const userScope = showUnitInScope(executable, ["--user"], unit);
	if (!userScope) return "unknown";
	if (userScope.fragmentPath) return unitStatusFromActiveState(userScope.activeState);

	// Not a user unit at all: maybe this profile was installed system-wide.
	const systemScope = showUnitInScope(executable, [], unit);
	if (!systemScope) return "unknown";
	if (!systemScope.fragmentPath) return "none";
	return unitStatusFromActiveState(systemScope.activeState);
}

/** `FragmentPath`/`ActiveState` of a unit as one `systemctl show` reported them. */
interface UnitProperties {
	/** Empty when the unit is not loaded in the scope that was asked. */
	fragmentPath: string;
	activeState: string;
}

/**
 * `systemctl [--user] show -p FragmentPath -p ActiveState <unit>`.
 *
 * A missing unit makes `show` exit non-zero but still print its properties, so
 * stdout is parsed regardless of the exit status. Undefined means the call told
 * us nothing usable (spawn error, timeout, empty or unreadable stdout — e.g. a
 * `Failed to connect to [user scope] bus` message on stderr): the caller must
 * report `unknown` rather than treat the unit as absent.
 */
function showUnitInScope(
	executable: string,
	scopeArgs: readonly string[],
	unit: string,
): UnitProperties | undefined {
	let result: ReturnType<typeof spawnSync>;
	try {
		result = spawnSync(executable, [...scopeArgs, "show", "-p", "FragmentPath", "-p", "ActiveState", unit], {
			encoding: "utf8",
			timeout: UNIT_STATUS_TIMEOUT_MS,
			stdio: ["ignore", "pipe", "pipe"],
		});
	} catch {
		return undefined;
	}
	if (result.error) return undefined;
	return parseUnitProperties(String(result.stdout ?? ""));
}

/** Parse `key=value` output line by line; undefined when nothing looked like a property. */
function parseUnitProperties(stdout: string): UnitProperties | undefined {
	const properties = new Map<string, string>();
	for (const line of stdout.split(/\r?\n/)) {
		const separator = line.indexOf("=");
		if (separator <= 0) continue;
		properties.set(line.slice(0, separator).trim(), line.slice(separator + 1).trim());
	}
	if (properties.size === 0) return undefined;
	return {
		fragmentPath: properties.get("FragmentPath") ?? "",
		activeState: properties.get("ActiveState") ?? "",
	};
}

/** systemd `ActiveState` → `UnitStatus`; anything this build does not know reads as `unknown`. */
function unitStatusFromActiveState(activeState: string): UnitStatus {
	switch (activeState.toLowerCase()) {
		case "active":
		case "activating":
		case "deactivating":
		case "failed":
		case "inactive":
			return activeState.toLowerCase() as UnitStatus;
		default:
			return "unknown";
	}
}

/** Find an executable on PATH without spawning a shell. */
function findExecutable(name: string, envPath: string): string | undefined {
	const extensions = process.platform === "win32"
		? (process.env.PATHEXT ?? ".EXE;.CMD;.BAT;.COM").split(";").filter(Boolean)
		: [""];
	for (const directory of envPath.split(path.delimiter)) {
		if (!directory) continue;
		for (const extension of extensions) {
			const candidate = path.join(directory, name + extension);
			try {
				if (!fs.statSync(candidate).isFile()) continue;
				fs.accessSync(candidate, fs.constants.X_OK);
				return candidate;
			} catch {
				// Not here or not executable.
			}
		}
	}
	return undefined;
}

/**
 * What is on disk.
 *
 * The first six fields are the historical record. The rest were added for the
 * dashboard's dead-agent detection (#175) and are optional so files written by
 * older builds, and old readers that ignore unknown keys, keep working.
 */
export interface HeartbeatRecord {
	pid: number;
	/** ISO timestamp of the process start. */
	startedAt: string;
	/** Harness package version from the checkout's package.json. */
	version: string;
	/** Identity of the code loaded in this process (see `buildIdFor`). */
	buildId: string;
	/** Last release tag applied by `alive update`, when known. */
	tag?: string;
	/** Git branch or short commit the harness runs from, when known. */
	ref?: string;
	/** ISO timestamp of the last heartbeat update (#175). */
	updatedAt?: string;
	/** ISO timestamp of the runtime's last tick, when known (#175). */
	lastTickAt?: string;
	/** Whole seconds between `lastTickAt` and `updatedAt`; 0 when no tick was recorded (#175). */
	staleSeconds?: number;
	/** Best-effort unit state of `alive-agent@<profile>` (#175), from a systemd `show` in the user scope. */
	unitStatus?: UnitStatus;
	/** Process starts inside the rolling window (#178), written by a newer build. */
	startLoop?: StartLoopStatus;
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
	buildId?: string;
	tag?: string;
	ref?: string;
	/** Runtime tick this update reflects (#175); omitted at process start. */
	lastTickAt?: number | Date;
	/** Best-effort unit state (#175); omitted when unknown or not managed. */
	unitStatus?: UnitStatus;
	/** Process starts inside the rolling window (#178); omitted when not recorded. */
	startLoop?: StartLoopStatus;
	/** Clock seam for tests; defaults to now. */
	now?: number | Date;
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
	const writtenAt = options.now instanceof Date ? options.now : new Date(options.now ?? Date.now());
	const lastTickAt = options.lastTickAt instanceof Date
		? options.lastTickAt
		: options.lastTickAt === undefined
			? undefined
			: new Date(options.lastTickAt);
	const record: HeartbeatRecord = {
		pid: options.pid ?? process.pid,
		startedAt: startedAt.toISOString(),
		version: options.version ?? identity.version,
		buildId: options.buildId ?? identity.buildId,
		updatedAt: writtenAt.toISOString(),
		staleSeconds: lastTickAt ? Math.max(0, Math.trunc((writtenAt.getTime() - lastTickAt.getTime()) / 1_000)) : 0,
	};
	const tag = options.tag ?? identity.tag;
	if (tag) record.tag = tag;
	const ref = options.ref ?? identity.ref;
	if (ref) record.ref = ref;
	if (lastTickAt) record.lastTickAt = lastTickAt.toISOString();
	if (options.unitStatus) record.unitStatus = options.unitStatus;
	if (options.startLoop) record.startLoop = options.startLoop;
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

export interface HeartbeatRefreshOptions {
	/** Runtime tick this refresh reflects (#175). */
	lastTickAt?: number | Date;
	/** Best-effort unit state (#175); omitted keeps the previous value. */
	unitStatus?: UnitStatus;
	/** Process starts inside the rolling window (#178); omitted keeps the previous value. */
	startLoop?: StartLoopStatus;
}

/**
 * Refresh the record in place (#175).
 *
 * The historical refresh only moved the mtime. The file now also carries
 * `updatedAt`, `lastTickAt`, `staleSeconds` and `unitStatus`, so a real rewrite
 * is needed; it is still atomic and preserves `pid`, `startedAt`, `version`,
 * `buildId`, `tag` and `ref` verbatim. The rename also moves the mtime, which
 * remains the freshness signal. Never throws; returns false when the caller
 * should write a full record instead.
 */
export function refreshHeartbeat(
	stateDir: string,
	log?: HeartbeatLog,
	now = Date.now(),
	options: HeartbeatRefreshOptions = {},
): boolean {
	const file = heartbeatPath(stateDir);
	try {
		const existing = readHeartbeat(stateDir);
		if (!existing) {
			if (fs.existsSync(file)) return false;
			// Historical contract: refreshing a missing file is an error (and the
			// caller then writes the full record). utimes throws ENOENT for us.
			const date = new Date(now);
			fs.utimesSync(file, date, date);
			return true;
		}
		const previousTick = existing.lastTickAt ? Date.parse(existing.lastTickAt) : undefined;
		const optionTick = options.lastTickAt instanceof Date
			? options.lastTickAt.getTime()
			: options.lastTickAt;
		const lastTickAt = optionTick ?? (Number.isFinite(previousTick) ? previousTick : undefined);
		const record: HeartbeatRecord = {
			...existing,
			updatedAt: new Date(now).toISOString(),
			staleSeconds: lastTickAt === undefined ? 0 : Math.max(0, Math.trunc((now - lastTickAt) / 1_000)),
		};
		if (lastTickAt !== undefined) record.lastTickAt = new Date(lastTickAt).toISOString();
		const unitStatus = options.unitStatus ?? existing.unitStatus;
		if (unitStatus) record.unitStatus = unitStatus;
		const startLoop = options.startLoop ?? existing.startLoop;
		if (startLoop) record.startLoop = startLoop;
		writeJsonAtomic(file, record);
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
	const record: HeartbeatRecord = {
		pid: raw.pid,
		startedAt: raw.startedAt,
		version: raw.version,
		// Heartbeats written before buildId existed still identify the process;
		// report the code identity as unknown rather than dropping the record.
		buildId: typeof raw.buildId === "string" && raw.buildId ? raw.buildId : "unknown",
	};
	if (typeof raw.tag === "string" && raw.tag) record.tag = raw.tag;
	if (typeof raw.ref === "string" && raw.ref) record.ref = raw.ref;
	if (typeof raw.updatedAt === "string" && raw.updatedAt) record.updatedAt = raw.updatedAt;
	if (typeof raw.lastTickAt === "string" && raw.lastTickAt) record.lastTickAt = raw.lastTickAt;
	if (typeof raw.staleSeconds === "number" && Number.isFinite(raw.staleSeconds) && raw.staleSeconds >= 0) {
		record.staleSeconds = Math.trunc(raw.staleSeconds);
	}
	if (isUnitStatus(raw.unitStatus)) record.unitStatus = raw.unitStatus;
	const startLoop = sanitizeStartLoop(raw.startLoop);
	if (startLoop) record.startLoop = startLoop;
	return record;
}

/**
 * Validate the additive `startLoop` block (#178).
 *
 * A hand-edited or partially written file must not invent a restart loop, so
 * every counter has to be a finite non-negative number, `windowSeconds` and
 * `threshold` have to be positive, and `warn` has to be a boolean. Any other
 * shape drops the whole block instead of guessing.
 */
function sanitizeStartLoop(value: unknown): StartLoopStatus | undefined {
	if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
	const raw = value as Record<string, unknown>;
	const starts = typeof raw.starts === "number" && Number.isFinite(raw.starts) && raw.starts >= 0
		? Math.trunc(raw.starts)
		: undefined;
	const windowSeconds = typeof raw.windowSeconds === "number" && Number.isFinite(raw.windowSeconds) && raw.windowSeconds > 0
		? raw.windowSeconds
		: undefined;
	const threshold = typeof raw.threshold === "number" && Number.isFinite(raw.threshold) && raw.threshold > 0
		? raw.threshold
		: undefined;
	if (starts === undefined || windowSeconds === undefined || threshold === undefined) return undefined;
	if (typeof raw.warn !== "boolean") return undefined;
	return { starts, windowSeconds, threshold, warn: raw.warn };
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
	/** `staleSeconds` from the record, when an updated build wrote it (#175). */
	staleSeconds?: number;
	/** `unitStatus` from the record, when an updated build wrote it (#175). */
	unitStatus?: UnitStatus;
	/** `startLoop` from the record, when an updated build wrote it (#178). */
	startLoop?: StartLoopStatus;
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
	if (heartbeat.staleSeconds !== undefined) status.staleSeconds = heartbeat.staleSeconds;
	if (heartbeat.unitStatus !== undefined) status.unitStatus = heartbeat.unitStatus;
	if (heartbeat.startLoop !== undefined) status.startLoop = heartbeat.startLoop;
	return status;
}

/** Version/tag/ref/build identity of the harness executing right now, best effort. */
export interface HarnessIdentity {
	version: string;
	/** `build:<id>` from an explicit build-id file, or `<entry>:<mtimeMs>`. */
	buildId: string;
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
	const identity: HarnessIdentity = { version: "unknown", buildId: buildIdFor(root) };
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

/**
 * Identity of the code that is loaded, not merely the checkout metadata.
 *
 * An explicit `dist/build-id` (written by packaging) wins. Otherwise the mtime
 * of the entry file that the process actually runs identifies the build well
 * enough to distinguish "updated on disk" from "running the updated code".
 */
function buildIdFor(root: string): string {
	for (const relative of ["dist/build-id", ".build-id"]) {
		try {
			const value = fs.readFileSync(path.join(root, relative), "utf8").trim();
			if (value) return `build:${value.slice(0, 200)}`;
		} catch {
			// No explicit build id.
		}
	}
	for (const relative of [path.join("dist", "index.js"), path.join("src", "index.ts"), "dist", "src"]) {
		try {
			const stat = fs.statSync(path.join(root, relative));
			return `${relative.replaceAll(path.sep, "/")}:${Math.trunc(stat.mtimeMs)}`;
		} catch {
			// Try the next candidate.
		}
	}
	return "unknown";
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
