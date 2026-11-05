/**
 * Background instance management for the CLI.
 *
 * The agent is a long-lived process, so `alive run` detaches a child instead of
 * occupying a terminal. Everything the CLI needs to manage that instance lives
 * in two files: `runtime.json` (written by the runtime itself: pid, status,
 * uptime) and `logs/stdout.log` (the detached child's stdout+stderr).
 *
 * Deliberately dependency-free and signal-based: no pid-file locking of its own,
 * the runtime's `assertSingleInstance()` remains the single source of truth for
 * "only one instance per state dir".
 */
import { spawn, type ChildProcess } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import type { Paths } from "../config.js";
import { readRuntimeState, writeRuntimeState, type RuntimeStateFile } from "../store/runs.js";
import { ensureDir, isProcessAlive, isProcessSuspended, readJson, sleep, writeJsonAtomic } from "../util.js";

/** File the detached runtime writes its stdout/stderr to. */
export const STDOUT_LOG_NAME = "stdout.log";

/**
 * Who asked for the stop. Both `alive stop` and `alive restart` send SIGTERM,
 * so the signal itself cannot tell the runtime which one it was (#168).
 */
export type StopInitiator = "stop" | "restart";

/** `<stateDir>/stop-intent.json`: written by the CLI just before SIGTERM. */
export const STOP_INTENT_FILE = "stop-intent.json";

/** A marker older than this is a leftover, not an explanation for this stop. */
export const STOP_INTENT_TTL_MS = 5 * 60_000;

export interface StopIntent {
	initiator: StopInitiator;
	/** Wall clock the marker was written. */
	at: number;
	/** Pid the marker was written for, so another instance's stop is not claimed. */
	pid?: number;
}

export function stopIntentPath(stateDir: string): string {
	return path.join(stateDir, STOP_INTENT_FILE);
}

function isStopInitiator(value: unknown): value is StopInitiator {
	return value === "stop" || value === "restart";
}

/**
 * Record why the runtime is about to receive SIGTERM. Best effort: a missing
 * state dir or a read-only FS must never block an operator's stop.
 */
export function writeStopIntent(stateDir: string, initiator: StopInitiator, options: { at?: number; pid?: number } = {}): void {
	const intent: StopIntent = { initiator, at: options.at ?? Date.now() };
	if (options.pid !== undefined) intent.pid = options.pid;
	try {
		ensureDir(stateDir);
		writeJsonAtomic(stopIntentPath(stateDir), intent);
	} catch {
		// Diagnostics only: the stop itself proceeds.
	}
}

/** Delete the marker (idempotent). */
export function clearStopIntent(stateDir: string): void {
	try {
		fs.rmSync(stopIntentPath(stateDir), { force: true });
	} catch {
		// Already gone or not ours to delete.
	}
}

/**
 * Read the initiator of the stop in progress, then consume the marker.
 *
 * The marker is only trusted when it is fresh (`STOP_INTENT_TTL_MS`) and, if it
 * names a pid, when that pid is this process: a stale marker from a failed stop
 * must not relabel today's run. Stale and corrupt markers are deleted so they
 * cannot confuse the next shutdown. `now`/`pid` are clock and identity seams for
 * tests; they default to the wall clock and `process.pid`.
 */
export function readStopIntent(
	stateDir: string,
	options: { now?: number; pid?: number } = {},
): StopInitiator | undefined {
	const file = stopIntentPath(stateDir);
	if (!fs.existsSync(file)) return undefined;
	const now = options.now ?? Date.now();
	const pid = options.pid ?? process.pid;
	const intent = readJson<Partial<StopIntent> | null>(file, null);
	clearStopIntent(stateDir);
	if (!intent || typeof intent !== "object") return undefined;
	if (!isStopInitiator(intent.initiator)) return undefined;
	if (typeof intent.at !== "number" || !Number.isFinite(intent.at)) return undefined;
	if (now - intent.at >= STOP_INTENT_TTL_MS) return undefined;
	if (intent.pid !== undefined && intent.pid !== pid) return undefined;
	return intent.initiator;
}

export function stdoutLogPath(paths: Paths): string {
	return path.join(paths.logsDir, STDOUT_LOG_NAME);
}

export interface RuntimeSnapshot {
	state: RuntimeStateFile;
	pid: number;
	/** Pid exists and is neither a zombie nor a leftover state entry. */
	alive: boolean;
	/** Alive but suspended (SIGSTOP/Ctrl+Z): holds the lock yet serves nothing. */
	suspended: boolean;
	/** The runtime shut down on purpose, so a dead pid here is expected. */
	cleanStop: boolean;
	uptimeMs: number;
}

export function snapshotRuntime(stateDir: string): RuntimeSnapshot | null {
	const state = readRuntimeState(stateDir);
	if (!state || !Number.isInteger(state.pid) || state.pid <= 0) return null;
	const alive = isProcessAlive(state.pid);
	return {
		state,
		pid: state.pid,
		alive,
		suspended: alive && isProcessSuspended(state.pid),
		cleanStop: state.status === "stopped",
		uptimeMs: Math.max(0, Date.now() - state.startedAt),
	};
}

export interface BackgroundHandle {
	pid: number;
	logFile: string;
	child: ChildProcess;
}

export interface SpawnOptions {
	paths: Paths;
	/** Forwarded to the child, e.g. --config/--model/--verbose. */
	args?: string[];
	/** Child subcommand; defaults to `run --foreground`. */
	command?: string[];
	/** Entry script to re-exec; defaults to the CLI that is running now. */
	entry?: string;
	env?: NodeJS.ProcessEnv;
}

/**
 * Detach a runtime process. Stdio goes to `logs/stdout.log`, so the child keeps
 * running after the terminal (or this CLI) goes away.
 */
export function spawnBackground(options: SpawnOptions): BackgroundHandle {
	ensureDir(options.paths.logsDir);
	const logFile = stdoutLogPath(options.paths);
	const entry = options.entry ?? process.argv[1];
	if (!entry) {
		throw new Error("cannot locate the alive entry script; use `alive run --foreground` instead");
	}
	const command = options.command ?? ["run", "--foreground"];
	// Re-exec ourselves the same way we were launched (works for both the built
	// dist/index.js and `tsx src/index.ts`: the tsx loader travels in execArgv).
	const args = [...process.execArgv, entry, ...command, ...(options.args ?? [])];
	const fd = fs.openSync(logFile, "a");
	try {
		fs.writeSync(fd, `\n=== ${[path.basename(entry), ...command].join(" ")} (background) started ${new Date().toISOString()} ===\n`);
		const child = spawn(process.execPath, args, {
			cwd: options.paths.rootDir,
			detached: true,
			stdio: ["ignore", fd, fd],
			env: { ...process.env, ALIVE_DAEMON: "1", ...options.env },
		});
		// `fetch`-style spawn failures arrive as an async 'error' event; the
		// readiness wait below reports them instead of crashing the CLI.
		child.on("error", () => undefined);
		child.unref();
		if (child.pid === undefined) throw new Error("failed to spawn the background runtime");
		return { pid: child.pid, logFile, child };
	} finally {
		fs.closeSync(fd);
	}
}

export interface WaitOptions {
	timeoutMs?: number;
	pollMs?: number;
	child?: ChildProcess;
}

/**
 * Wait until the detached child owns `runtime.json`. Returns null on timeout or
 * when the child dies first (a lock conflict, a bad config, a crash).
 */
export async function waitForRuntime(
	stateDir: string,
	pid: number,
	options: WaitOptions = {},
): Promise<RuntimeSnapshot | null> {
	const timeoutMs = options.timeoutMs ?? 30_000;
	const pollMs = options.pollMs ?? 150;
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		if (options.child && options.child.exitCode !== null) return null;
		const snapshot = snapshotRuntime(stateDir);
		if (snapshot && snapshot.pid === pid && snapshot.alive) return snapshot;
		await sleep(pollMs);
	}
	return null;
}

export interface StopOptions {
	/** Graceful window before escalating to SIGKILL. */
	timeoutMs?: number;
	pollMs?: number;
	/** Skip SIGTERM and kill immediately. */
	force?: boolean;
	/** Who asked for the stop: `alive stop` vs `alive restart` (#168). */
	initiator?: StopInitiator;
}

export interface StopResult {
	pid?: number;
	/** True when the process is gone (or was already gone) afterwards. */
	stopped: boolean;
	/** Nothing was running in the first place. */
	alreadyStopped: boolean;
	forceKilled: boolean;
	wasSuspended: boolean;
	/** Set when SIGTERM was ignored past the timeout. */
	error?: string;
}

/**
 * Stop the running instance.
 *
 * A suspended process never runs its SIGTERM handler, so it is continued first —
 * that is exactly the Ctrl+Z case that leaves a "running" bot that answers
 * nothing. Escalates to SIGKILL if the runtime ignores SIGTERM.
 */
export async function stopRuntime(stateDir: string, options: StopOptions = {}): Promise<StopResult> {
	const timeoutMs = options.timeoutMs ?? 15_000;
	const pollMs = options.pollMs ?? 150;
	const initiator = options.initiator ?? "restart";
	const snapshot = snapshotRuntime(stateDir);
	if (!snapshot || !snapshot.alive) {
		// Nothing to tell: a marker left behind would relabel the next stop.
		clearStopIntent(stateDir);
		return { pid: snapshot?.pid, stopped: true, alreadyStopped: true, forceKilled: false, wasSuspended: false };
	}

	const { pid } = snapshot;
	const wasSuspended = snapshot.suspended;
	if (!options.force) {
		// The runtime writes the run record from inside its SIGTERM handler; the
		// marker is the only way it can know whether this was a stop or a restart.
		writeStopIntent(stateDir, initiator, { pid });
		if (wasSuspended) {
			try {
				process.kill(pid, "SIGCONT");
			} catch {
				// already gone
			}
		}
		try {
			process.kill(pid, "SIGTERM");
		} catch (err) {
			if ((err as NodeJS.ErrnoException).code === "ESRCH") {
				clearStopIntent(stateDir);
				return { pid, stopped: true, alreadyStopped: true, forceKilled: false, wasSuspended };
			}
			throw err;
		}
		if (await waitForExit(pid, timeoutMs, pollMs)) {
			finishStop(stateDir, pid);
			return { pid, stopped: true, alreadyStopped: false, forceKilled: false, wasSuspended };
		}
	}

	let killed = false;
	try {
		process.kill(pid, "SIGKILL");
		killed = true;
	} catch (err) {
		if ((err as NodeJS.ErrnoException).code !== "ESRCH") throw err;
	}
	// SIGKILL never reaches a handler, so the marker describes nothing now.
	clearStopIntent(stateDir);
	const gone = await waitForExit(pid, 5_000, pollMs);
	if (gone) finishStop(stateDir, pid);
	return {
		pid,
		stopped: gone,
		alreadyStopped: false,
		forceKilled: killed,
		wasSuspended,
		...(gone ? {} : { error: `pid ${pid} is still alive after SIGKILL` }),
	};
}

async function waitForExit(pid: number, timeoutMs: number, pollMs: number): Promise<boolean> {
	const deadline = Date.now() + timeoutMs;
	for (;;) {
		if (!isProcessAlive(pid)) return true;
		if (Date.now() >= deadline) return false;
		await sleep(pollMs);
	}
}

/**
 * Killed runtimes leave `runtime.json` describing a live run. Rewrite it as
 * stopped (only if it still belongs to the pid we killed) so `alive status`
 * does not report a stale instance forever.
 */
function finishStop(stateDir: string, pid: number): void {
	const state = readRuntimeState(stateDir);
	if (!state || state.pid !== pid) return;
	writeRuntimeState(stateDir, { ...state, status: "stopped", idling: false, lastTickAt: Date.now() });
}
