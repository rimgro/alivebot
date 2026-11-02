import * as fs from "node:fs";
import * as path from "node:path";
import { spawn, execFile } from "node:child_process";
import { fileURLToPath } from "node:url";
import { setTimeout as delay } from "node:timers/promises";
import {
	TERMINATE_GRACE_MS, clearStaleSingletonLocks, cdpAvailable, fortressProfiles, isPidAlive,
	logTail, pidFileAge, readPidFile, removePidFile, terminateChild, terminateProcess, waitForCdp,
} from "./fortress-runtime.js";

const root = fileURLToPath(new URL("../", import.meta.url));
const cli = path.join(root, "node_modules", "agent-browser", "bin", "agent-browser.js");

// The launcher gives up after 120s; the parent waits a little longer so the
// launcher can report its own diagnostic first.
const START_DEADLINE_MS = 125_000;

export function browserConnection(env = process.env) {
	const port = Number(env.ALIVE_FORTRESS_PORT ?? "9223");
	if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error("Invalid ALIVE_FORTRESS_PORT");
	const endpoint = env.ALIVE_FORTRESS_CDP || `http://127.0.0.1:${port}`;
	const url = new URL(endpoint);
	if (!["http:", "https:"].includes(url.protocol)) throw new Error("ALIVE_FORTRESS_CDP must be an HTTP(S) CDP endpoint");
	return { endpoint: endpoint.replace(/\/$/, ""), port, external: Boolean(env.ALIVE_FORTRESS_CDP) };
}

export interface FortressStartOptions {
	connection?: { endpoint: string; port: number; external: boolean };
	stateDir?: string;
	root?: string;
	launcher?: string;
	env?: NodeJS.ProcessEnv;
	home?: string;
	deadlineMs?: number;
	graceMs?: number;
	pollMs?: number;
	log?: (line: string) => void;
}

let starting: Promise<string> | undefined;
export async function ensureFortress(): Promise<string> {
	if (starting) return starting;
	starting = startFortress();
	try { return await starting; } finally { starting = undefined; }
}

/** Starts the launcher and returns only when the CDP port answers. */
export async function startFortress(options: FortressStartOptions = {}): Promise<string> {
	const env = options.env ?? process.env;
	const { endpoint, external, port } = options.connection ?? browserConnection(env);
	const stateDir = options.stateDir ?? path.join(root, ".alive", "browser");
	const pidPath = path.join(stateDir, `fortress-${port}.pid`);
	const logPath = path.join(stateDir, "fortress.log");
	const deadlineMs = options.deadlineMs ?? START_DEADLINE_MS;
	const graceMs = options.graceMs ?? TERMINATE_GRACE_MS;
	const pollMs = options.pollMs ?? 300;
	const log = options.log ?? ((line: string) => {
		try { fs.appendFileSync(logPath, `[${new Date().toISOString()}] ${line}\n`); } catch { /* the start error surfaces the failure */ }
	});
	if (await cdpAvailable(endpoint)) {
		if (!external) {
			// A Chrome brand string cannot identify Fortress. For the default local
			// endpoint, require the project launcher's live ownership marker.
			const pid = readPidFile(pidPath);
			if (pid === undefined || !isPidAlive(pid)) {
				throw new Error(`CDP port ${port} is occupied by an unmanaged browser. Free it or explicitly configure ALIVE_FORTRESS_CDP for your trusted Fortress instance.`);
			}
		}
		return endpoint;
	}
	if (external) throw new Error(`CDP unavailable at ${endpoint}. Start the configured Fortress instance.`);
	fs.mkdirSync(stateDir, { recursive: true });

	// A pid file is a hint, never proof: the port decides ownership. A recorded
	// launcher that is alive while the port is silent is a broken instance whose
	// browser refused to start; terminating it is the only way the next start
	// can succeed, and it must never be mistaken for a healthy browser.
	const recorded = readPidFile(pidPath);
	if (recorded !== undefined) {
		if (isPidAlive(recorded)) {
			const ageMs = pidFileAge(pidPath);
			// A launcher started seconds ago may still be bringing Chrome up.
			if (ageMs < deadlineMs && await waitForCdp(endpoint, deadlineMs - ageMs, pollMs)) {
				log(`CDP answered ${endpoint} while waiting for launcher pid ${recorded}`);
				return endpoint;
			}
			const outcome = await terminateProcess(recorded, { graceMs });
			removePidFile(pidPath, recorded);
			log(`Fortress launcher pid ${recorded} was alive but CDP ${endpoint} never answered (${outcome}); treated as a broken instance and removed it`);
		} else {
			removePidFile(pidPath, recorded);
			log(`removed stale Fortress pid file: pid ${recorded} is not running`);
		}
	}

	// A profile lock from a dead pid or another machine makes Chromium refuse to
	// start, so clear only provably stale locks before spawning anything.
	for (const profile of fortressProfiles({ stateDir, port, env, home: options.home })) {
		const scan = clearStaleSingletonLocks({ profile, log });
		if (scan.live) {
			const error = `Fortress profile ${profile} is in use by live Chromium pid ${scan.live.pid}. Close that browser (or remove ${scan.live.path} if it is stale) and retry.`;
			log(error);
			throw new Error(error);
		}
	}

	const launcher = options.launcher ?? fileURLToPath(new URL(import.meta.url.endsWith(".ts") ? "./fortress.ts" : "./fortress.js", import.meta.url));
	const argv = [process.execPath, ...process.execArgv, launcher];
	const fd = fs.openSync(logPath, "a");
	// Timestamped header, so the log is readable after the fact. The argv has no
	// secrets: the launcher takes its configuration from the environment.
	fs.writeSync(fd, `\n[${new Date().toISOString()}] start Fortress: endpoint=${endpoint} argv=${JSON.stringify(argv)}\n`);
	let child: ReturnType<typeof spawn>;
	try {
		child = spawn(argv[0], argv.slice(1), {
			cwd: options.root ?? root, detached: true, stdio: ["ignore", fd, fd], env,
		});
	} finally { fs.closeSync(fd); }
	let spawnError: Error | undefined;
	child.on("error", (error) => { spawnError = error; });
	child.unref();
	const deadline = Date.now() + deadlineMs;
	while (Date.now() < deadline) {
		if (spawnError) break;
		if (await cdpAvailable(endpoint)) return endpoint;
		// Exit 0 means another launcher owns the port; keep waiting for it.
		if (child.exitCode !== null && child.exitCode !== 0) break;
		await delay(pollMs);
	}
	const outcome = await terminateChild(child, { graceMs, group: true });
	if (child.pid !== undefined) removePidFile(pidPath, child.pid);
	log(`Fortress did not start: CDP ${endpoint} did not answer${spawnError ? ` after ${spawnError.message}` : ""}; launcher ${child.pid} ${outcome}; removed pid file`);
	throw new Error(`Fortress did not start: CDP ${endpoint} did not answer within ${deadlineMs}ms. See ${logPath}; run npm run browser:fortress for diagnostics.\nLast lines of ${logPath}:\n${logTail(logPath, 40)}`);
}

export function browserArgs(endpoint: string, args: string[], session = "alive-fortress"): string[] {
	if (!args.length) throw new Error("Provide an agent-browser command (open, snapshot, click, eval, close, …)");
	if (args[0] === "connect") throw new Error("connect is managed by the Fortress adapter");
	// Connection/session flags belong to this adapter, not callers. Otherwise a
	// command can silently reconnect the shared daemon to ordinary Chrome.
	const reserved = ["--cdp", "--session", "--session-name", "--auto-connect", "--provider", "-p", "--executable-path", "--config", "--profile", "--engine"];
	if (args.some((arg) => reserved.some((flag) => arg === flag || arg.startsWith(`${flag}=`)) || arg === "--all")) {
		throw new Error("Browser connection/session overrides and --all are not allowed through the Fortress adapter");
	}
	return [cli, "--session", session, "--cdp", endpoint, ...args];
}

export async function runBrowser(args: string[], signal?: AbortSignal, session = "alive-fortress"): Promise<string> {
	// Validate before spawning/downloading anything.
	browserArgs(browserConnection().endpoint, args, session);
	signal?.throwIfAborted();
	const endpoint = await ensureFortress();
	signal?.throwIfAborted();
	return new Promise((resolve, reject) => {
		execFile(process.execPath, browserArgs(endpoint, args, session), {
			cwd: root, timeout: 60_000, maxBuffer: 4 * 1024 * 1024, signal,
		}, (error, stdout, stderr) => {
			if (error) reject(new Error(`Fortress agent-browser failed: ${stderr || stdout || error.message}`));
			else resolve(stdout.trim());
		});
	});
}
