import * as fs from "node:fs";
import * as path from "node:path";
import type { ChildProcess } from "node:child_process";
import {
	TERMINATE_GRACE_MS, clearStaleSingletonLocks, fortressProfiles, isPidAlive, pidFileAge,
	readPidFile, removePidFile, terminateChild, terminateProcess, waitForCdp, withTimeout,
} from "./fortress-runtime.js";

export interface FortressBrowser {
	proc: ChildProcess | null;
	start(): Promise<unknown>;
	close(): Promise<void>;
}

export interface LauncherOptions {
	stateDir: string;
	port: number;
	createBrowser: (input: { port: number; profile: string; stateDir: string }) => FortressBrowser;
	timeoutMs?: number;
	graceMs?: number;
	env?: NodeJS.ProcessEnv;
	log?: (line: string) => void;
	waitForCdp?: (endpoint: string, timeoutMs: number) => Promise<boolean>;
	/** Signal handler exit; defaults to process.exit. */
	exit?: (code: number) => void;
	/** Keep a started launcher alive (default) or return 0 right after start. */
	keepAlive?: boolean;
}

const message = (error: unknown) => error instanceof Error ? error.message : String(error);

/**
 * Owns one local Fortress browser: pid file, profile locks, startup timeout and
 * teardown. Returns the exit code instead of exiting, so the failure paths are
 * testable; src/fortress.ts wires it to the real process.
 */
export async function runFortressLauncher(options: LauncherOptions): Promise<number> {
	const { stateDir, port } = options;
	const env = options.env ?? process.env;
	const endpoint = `http://127.0.0.1:${port}`;
	const lock = path.join(stateDir, `fortress-${port}.pid`);
	const profile = path.join(stateDir, `profile-${port}`);
	const timeoutMs = options.timeoutMs ?? 120_000;
	const graceMs = options.graceMs ?? TERMINATE_GRACE_MS;
	// stderr is redirected to .alive/browser/fortress.log by the parent, and the
	// parent quotes the tail of that file when startup fails.
	const log = options.log ?? ((line: string) => console.error(`[${new Date().toISOString()}] fortress[${process.pid}] ${line}`));
	const cdp = options.waitForCdp ?? ((target: string, ms: number) => waitForCdp(target, ms));
	const exit = options.exit ?? ((code: number) => process.exit(code));
	fs.mkdirSync(stateDir, { recursive: true });

	// A pid file records intent, never ownership: the debug port decides whether
	// a browser exists. A launcher that is alive while its port is silent is a
	// browser that refused to start (for example because of a foreign-profile
	// SingletonLock), and it must not block every later attempt by exiting 0.
	const recorded = readPidFile(lock);
	if (recorded !== undefined && recorded !== process.pid) {
		if (isPidAlive(recorded)) {
			const ageMs = pidFileAge(lock);
			log(`launcher pid ${recorded} is recorded (age ${Math.round(ageMs)}ms); waiting for CDP ${endpoint}`);
			if (await cdp(endpoint, timeoutMs - ageMs)) {
				log(`another launcher (pid ${recorded}) is serving ${endpoint}; nothing to do`);
				return 0;
			}
			const outcome = await terminateProcess(recorded, { graceMs });
			removePidFile(lock, recorded);
			log(`launcher pid ${recorded} is alive but ${endpoint} never answered (${outcome}); removed it and starting a fresh browser`);
		} else {
			removePidFile(lock, recorded);
			log(`removed stale pid file: pid ${recorded} is not running`);
		}
	}
	try { fs.writeFileSync(lock, String(process.pid), { flag: "wx" }); }
	catch (error) {
		if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
		const winner = readPidFile(lock);
		if (winner !== undefined && winner !== process.pid && isPidAlive(winner)) {
			log(`another launcher (pid ${winner}) took ownership of ${endpoint}; exiting`);
			return 0;
		}
		fs.writeFileSync(lock, String(process.pid));
	}

	// Chromium refuses to start when the profile holds a SingletonLock owned by a
	// dead pid or by another machine, so clear only provably stale locks first.
	for (const candidate of fortressProfiles({ stateDir, port, env })) {
		const scan = clearStaleSingletonLocks({ profile: candidate, log });
		if (scan.live) {
			removePidFile(lock, process.pid);
			log(`profile ${candidate} is held by live Chromium pid ${scan.live.pid}; refusing to start a second browser`);
			return 1;
		}
	}

	const browser = options.createBrowser({ port, profile, stateDir });
	let closing: Promise<number> | undefined;
	const stop = (code: number, reason: string) => closing ??= (async () => {
		log(`stopping (exit ${code}): ${reason}`);
		const browserPid = browser.proc?.pid;
		try {
			const outcome = await terminateChild(browser.proc, { graceMs });
			if (outcome !== "already-exited") log(`browser process ${browserPid} ${outcome}`);
		} catch (error) { log(`browser termination failed: ${message(error)}`); }
		// A failed start can leave close() waiting on a browser that never came up.
		try { await withTimeout(browser.close(), graceMs, "Fortress close"); }
		catch (error) { log(`Fortress close: ${message(error)}`); }
		if (removePidFile(lock, process.pid)) log(`removed pid file ${lock}`);
		log("stopped");
		return code;
	})();
	const onSignal = (signal: NodeJS.Signals) => { void stop(0, signal).then((code) => exit(code)); };
	process.on("SIGINT", onSignal);
	process.on("SIGTERM", onSignal);
	const timer = setTimeout(() => { void stop(1, `startup timed out after ${timeoutMs}ms`).then((code) => exit(code)); }, timeoutMs);
	try {
		await browser.start();
		clearTimeout(timer);
		log(`ready: ${endpoint} (profile ${profile})`);
		browser.proc?.once("exit", (code, signal) => { void stop(1, `browser exited (${code ?? signal})`).then((value) => exit(value)); });
		if (options.keepAlive === false) return 0;
		setInterval(() => {}, 60_000);
		await new Promise(() => { /* stays alive until a signal or browser exit */ });
	} catch (error) {
		clearTimeout(timer);
		log(`start failed: ${message(error)}`);
		return await stop(1, "startup failed");
	} finally {
		clearTimeout(timer);
		process.off("SIGINT", onSignal);
		process.off("SIGTERM", onSignal);
	}
	return 0;
}
