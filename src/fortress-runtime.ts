import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import type { ChildProcess } from "node:child_process";

// A foreign host cannot own a local browser, but a lock created seconds ago may
// still belong to a browser that is starting on this machine under an old
// hostname. Require age before calling a foreign lock stale.
export const FOREIGN_LOCK_GRACE_MS = 5 * 60_000;
export const TERMINATE_GRACE_MS = 5_000;

/** Signal-0 probe. EPERM means the process exists but belongs to another user. */
export function isPidAlive(pid: number): boolean {
	if (!Number.isInteger(pid) || pid <= 0) return false;
	try { process.kill(pid, 0); return true; }
	catch (error) { return (error as NodeJS.ErrnoException).code === "EPERM"; }
}

/** Bounds a shutdown path so a hanging close cannot block the caller forever. */
export function withTimeout<T>(work: Promise<T>, ms: number, label: string): Promise<T> {
	return new Promise<T>((resolve, reject) => {
		const timer = setTimeout(() => reject(new Error(`${label} did not finish within ${ms}ms`)), ms);
		// The timer stays referenced: a bounded wait must still fire when the work
		// it guards holds no handle of its own.
		work.then((value) => { clearTimeout(timer); resolve(value); },
			(error) => { clearTimeout(timer); reject(error); });
	});
}

async function waitFor(check: () => boolean, ms: number, pollMs = 100): Promise<boolean> {
	const deadline = Date.now() + ms;
	while (Date.now() < deadline) {
		if (check()) return true;
		await delay(pollMs);
	}
	return check();
}

export type Termination = "already-exited" | "terminated" | "killed" | "stubborn";

function signal(pid: number, name: NodeJS.Signals): void {
	try { process.kill(pid, name); } catch { /* exited between the probe and the signal */ }
}

/** Terminates a process by pid: SIGTERM, short grace, then SIGKILL. */
export async function terminateProcess(pid: number, options: { graceMs?: number } = {}): Promise<Termination> {
	if (!isPidAlive(pid)) return "already-exited";
	const graceMs = options.graceMs ?? TERMINATE_GRACE_MS;
	signal(pid, "SIGTERM");
	if (await waitFor(() => !isPidAlive(pid), graceMs)) return "terminated";
	signal(pid, "SIGKILL");
	return await waitFor(() => !isPidAlive(pid), 2_000) ? "killed" : "stubborn";
}

/**
 * Terminates a child we spawned. Waits for its exit event, so a zombie is
 * recognised as gone even while signal 0 still succeeds. `group` is only safe
 * for a child spawned detached (its pid is then its own process group id).
 */
export async function terminateChild(child: ChildProcess | null | undefined, options: { graceMs?: number; group?: boolean } = {}): Promise<Termination> {
	if (!child || !child.pid || child.exitCode !== null || child.signalCode !== null) return "already-exited";
	const pid = child.pid;
	const graceMs = options.graceMs ?? TERMINATE_GRACE_MS;
	let exited = false;
	child.once("exit", () => { exited = true; });
	const kill = (name: NodeJS.Signals) => {
		signal(pid, name);
		if (options.group) { try { process.kill(-pid, name); } catch { /* not a process group leader */ } }
	};
	kill("SIGTERM");
	if (await waitFor(() => exited, graceMs)) return "terminated";
	kill("SIGKILL");
	return await waitFor(() => exited, 2_000) ? "killed" : "stubborn";
}

/** The debug port, not the pid file, decides whether a browser exists. */
export async function cdpAvailable(endpoint: string, timeoutMs = 1_000): Promise<boolean> {
	try {
		const response = await fetch(`${endpoint}/json/version`, { signal: AbortSignal.timeout(timeoutMs) });
		if (!response.ok) return false;
		// Stealth Chromium deliberately identifies as Chrome, not "Fortress".
		const info = await response.json() as { webSocketDebuggerUrl?: string };
		return Boolean(info.webSocketDebuggerUrl);
	} catch { return false; }
}

export async function waitForCdp(endpoint: string, timeoutMs: number, pollMs = 300): Promise<boolean> {
	const deadline = Date.now() + Math.max(0, timeoutMs);
	while (Date.now() < deadline) {
		if (await cdpAvailable(endpoint)) return true;
		await delay(pollMs);
	}
	return await cdpAvailable(endpoint);
}

/** Last `lines` lines of a log, read from the tail so the file can grow freely. */
export function logTail(file: string, lines = 40, maxBytes = 64 * 1024): string {
	try {
		const size = fs.statSync(file).size;
		const length = Math.min(size, maxBytes);
		const buffer = Buffer.alloc(length);
		const fd = fs.openSync(file, "r");
		try { fs.readSync(fd, buffer, 0, length, size - length); }
		finally { fs.closeSync(fd); }
		return buffer.toString("utf8").split("\n").slice(-lines).join("\n").trim();
	} catch { return "(fortress log unavailable)"; }
}

export function readPidFile(file: string): number | undefined {
	try {
		const value = Number(fs.readFileSync(file, "utf8").trim());
		return Number.isInteger(value) && value > 0 ? value : undefined;
	} catch { return undefined; }
}

export function pidFileAge(file: string): number {
	try { return Math.max(0, Date.now() - fs.statSync(file).mtimeMs); }
	catch { return Number.POSITIVE_INFINITY; }
}

/** Removes the pid file only when it still records `pid` (or unconditionally when omitted). */
export function removePidFile(file: string, pid?: number): boolean {
	if (pid !== undefined) {
		let current: string;
		try { current = fs.readFileSync(file, "utf8").trim(); } catch { return false; }
		if (current !== String(pid)) return false;
	}
	try { fs.rmSync(file, { force: true }); return true; } catch { return false; }
}

/**
 * Profile directories Fortress can actually use: the project profile passed via
 * --user-data-dir, plus the shared cache profile the upstream launcher defaults
 * to (~/.cache/tilion-fortress/profile, or FORTRESS_BROWSERS_PATH/profile).
 */
export function fortressProfiles(options: { stateDir: string; port: number; env?: NodeJS.ProcessEnv; home?: string }): string[] {
	const env = options.env ?? process.env;
	const cache = env.FORTRESS_BROWSERS_PATH?.trim() || path.join(options.home ?? os.homedir(), ".cache", "tilion-fortress");
	return [...new Set([path.join(options.stateDir, `profile-${options.port}`), path.join(cache, "profile")])];
}

export interface SingletonLockOwner { hostname: string; pid: number }

/** Chromium's POSIX lock target is `<hostname>-<pid>`; the hostname may contain dashes. */
export function parseSingletonLockTarget(target: string): SingletonLockOwner | undefined {
	const match = /^(.+)-(\d+)$/.exec(target.trim());
	if (!match) return;
	const pid = Number(match[2]);
	if (!Number.isInteger(pid) || pid <= 0) return;
	return { hostname: match[1], pid };
}

export interface LockDecision {
	path: string;
	action: "kept" | "removed";
	reason: string;
	pid?: number;
	hostname?: string;
}
export interface LockScan { decisions: LockDecision[]; live?: { path: string; pid: number } }

export interface ClearStaleLocksOptions {
	profile: string;
	hostname?: string;
	now?: number;
	foreignGraceMs?: number;
	alive?: (pid: number) => boolean;
	log?: (line: string) => void;
}

/**
 * Clears Chromium Singleton locks only when they are provably stale:
 * - SingletonLock records a foreign hostname (and is older than the grace
 *   period: a foreign host cannot own a running local chrome, but a start race
 *   must not be misread), or
 * - SingletonLock records a local pid that is no longer running.
 * SingletonSocket/SingletonCookie carry no owner, so they are removed only as
 * companions of a stale lock, or when no lock exists at all and they are older
 * than the grace period. Locks of a live local chrome are never touched.
 */
export function clearStaleSingletonLocks(options: ClearStaleLocksOptions): LockScan {
	const { profile, log } = options;
	if (!fs.existsSync(profile)) return { decisions: [] };
	const hostname = options.hostname ?? os.hostname();
	const now = options.now ?? Date.now();
	const graceMs = options.foreignGraceMs ?? FOREIGN_LOCK_GRACE_MS;
	const alive = options.alive ?? isPidAlive;
	const decisions: LockDecision[] = [];
	const keep = (decision: Omit<LockDecision, "action">) => {
		decisions.push({ ...decision, action: "kept" });
		log?.(`Fortress profile lock ${decision.path}: kept (${decision.reason})`);
	};
	const drop = (decision: Omit<LockDecision, "action">) => {
		try { fs.rmSync(decision.path, { force: true }); } catch { /* the next start reports the failure */ }
		decisions.push({ ...decision, action: "removed" });
		log?.(`Fortress profile lock ${decision.path}: removed (${decision.reason})`);
	};
	const lockPath = path.join(profile, "SingletonLock");
	let target: string | undefined;
	let stat: fs.Stats | undefined;
	try { target = fs.readlinkSync(lockPath); stat = fs.lstatSync(lockPath); }
	catch (error) {
		const code = (error as NodeJS.ErrnoException).code;
		// ENOENT is the healthy case; anything else means we cannot prove staleness.
		if (code !== "ENOENT") keep({ path: lockPath, reason: `lock cannot be inspected (${code ?? "unknown error"})` });
	}
	let staleReason: string | undefined;
	let live: LockScan["live"];
	if (target !== undefined && stat) {
		const owner = parseSingletonLockTarget(target);
		const ageMs = now - stat.mtimeMs;
		if (!owner) keep({ path: lockPath, reason: `unrecognized lock target ${JSON.stringify(target)}` });
		else if (owner.hostname.toLowerCase() !== hostname.toLowerCase()) {
			if (ageMs < graceMs) keep({ path: lockPath, reason: `foreign host ${owner.hostname} (pid ${owner.pid}) is younger than ${graceMs}ms; may be racing`, ...owner });
			else {
				staleReason = `foreign host ${owner.hostname} cannot own a local browser`;
				drop({ path: lockPath, reason: `${staleReason}; lock is ${Math.round(ageMs / 1000)}s old`, ...owner });
			}
		} else if (alive(owner.pid)) {
			const reason = `local pid ${owner.pid} is alive`;
			keep({ path: lockPath, reason, ...owner });
			live = { path: lockPath, pid: owner.pid };
		} else {
			staleReason = `local pid ${owner.pid} is not running`;
			drop({ path: lockPath, reason: staleReason, ...owner });
		}
	}
	for (const name of ["SingletonSocket", "SingletonCookie"] as const) {
		const file = path.join(profile, name);
		let fileStat: fs.Stats;
		try { fileStat = fs.lstatSync(file); } catch { continue; }
		if (staleReason) drop({ path: file, reason: `orphaned by a stale SingletonLock (${staleReason})` });
		else if (target === undefined || !stat) {
			const ageMs = now - fileStat.mtimeMs;
			if (ageMs < graceMs) keep({ path: file, reason: `no SingletonLock yet and the file is younger than ${graceMs}ms; may be racing` });
			else drop({ path: file, reason: `no SingletonLock owns this profile and the file is ${Math.round(ageMs / 1000)}s old` });
		} else keep({ path: file, reason: "SingletonLock exists and was not proven stale" });
	}
	return live ? { decisions, live } : { decisions };
}
