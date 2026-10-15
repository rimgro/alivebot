import * as fs from "node:fs";
import * as path from "node:path";
import { randomBytes } from "node:crypto";
import type { LoadedConfig } from "../../config.js";
import { snapshotRuntime, spawnBackground, stopRuntime, waitForRuntime } from "../../runtime/daemon.js";
import { writeRuntimeState } from "../../store/runs.js";
import { sleep } from "../../util.js";
import { DEFAULT_BROWSER_CONFIG } from "./config.js";
import { sharedToken } from "./shared-client.js";
import { SharedBrowserHost } from "./shared-server.js";
import { writePrivateJson } from "./operator.js";

type Flags = Record<string, string | boolean>;
export function sharedHostDirectory(loaded: LoadedConfig): string { return path.join(loaded.paths.modulesDir, "browser", "shared-host"); }
export function sharedHostTokenFile(loaded: LoadedConfig): string { return path.join(sharedHostDirectory(loaded), "token"); }

export async function sharedHostCommand(loaded: LoadedConfig, action: string, flags: Flags): Promise<number> {
	const directory = sharedHostDirectory(loaded), state = snapshotRuntime(directory);
	if (action === "host-stop") {
		const stopped = await stopRuntime(directory, { timeoutMs: 20_000 });
		if (!stopped.stopped && !stopped.alreadyStopped) throw new Error("Shared browser host did not stop");
		process.stdout.write(stopped.alreadyStopped ? "Shared browser host is not running\n" : "Shared browser host stopped; client contexts were disconnected\n"); return 0;
	}
	if (action === "host-status") {
		process.stdout.write(JSON.stringify({ running: !!state?.alive && !state.cleanStop, pid: state?.pid, status: state?.state.status }) + "\n"); return state?.alive && !state.cleanStop ? 0 : 1;
	}
	if (state?.alive && !state.cleanStop) throw new Error(`Shared browser host already owns its directory (pid ${state.pid})`);
	const forwarded: string[] = [];
	for (const name of ["bind", "port", "max-clients", "token-file"]) if (typeof flags[name] === "string") forwarded.push(`--${name}`, flags[name] as string);
	if (flags.background === true && flags.foreground !== true) {
		const handle = spawnBackground({ paths: { ...loaded.paths, stateDir: directory, logsDir: path.join(directory, "logs") }, command: ["browser", "host", "--foreground"], args: [...forwarded, "--config", loaded.paths.configPath] });
		const ready = await waitForRuntime(directory, handle.pid, { child: handle.child, timeoutMs: 70_000 });
		if (!ready || ready.state.status !== "idle") throw new Error(`Shared browser host did not become ready; inspect ${handle.logFile}`);
		process.stdout.write(`Shared browser host started (pid ${handle.pid}); token file: ${typeof flags["token-file"] === "string" ? flags["token-file"] : sharedHostTokenFile(loaded)}\n`); return 0;
	}
	const config = { ...DEFAULT_BROWSER_CONFIG, ...loaded.config.modules.browser };
	const tokenFile = typeof flags["token-file"] === "string" ? path.resolve(flags["token-file"]) : process.env[config.sharedTokenFileEnv] || sharedHostTokenFile(loaded);
	fs.mkdirSync(path.dirname(tokenFile), { recursive: true, mode: 0o700 });
	if (!fs.existsSync(tokenFile)) fs.writeFileSync(tokenFile, randomBytes(32).toString("base64url") + "\n", { flag: "wx", mode: 0o600 });
	const saved = process.env[config.sharedTokenFileEnv]; process.env[config.sharedTokenFileEnv] = tokenFile;
	let token: string; try { token = sharedToken(config); } finally { if (saved === undefined) delete process.env[config.sharedTokenFileEnv]; else process.env[config.sharedTokenFileEnv] = saved; }
	const port = flags.port === undefined ? 4330 : Number(flags.port), maxClients = flags["max-clients"] === undefined ? 8 : Number(flags["max-clients"]);
	if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error("Invalid shared host port");
	const abort = new AbortController(), cancel = () => abort.abort(); let failed = false;
	for (const name of ["SIGTERM", "SIGINT", "SIGHUP"] as const) process.on(name, cancel);
	const host = new SharedBrowserHost({ config, directory, token, port, maxClients, host: typeof flags.bind === "string" ? flags.bind : "127.0.0.1", failure: () => { failed = true; abort.abort(); } });
	const startedAt = Date.now(); let heartbeat: NodeJS.Timeout | undefined, ownedState = false;
	const write = (status: "idle" | "stopped") => writeRuntimeState(directory, { pid: process.pid, startedAt, lastTickAt: Date.now(), status, runIndex: 0, pending: 0, openThreads: 0, sleeps: 0, mode: flags.foreground === true ? "foreground" : "background" });
	try {
		await host.start();
		writePrivateJson(path.join(directory, "endpoint.json"), { origin: host.endpoint(), tokenFile });
		write("idle"); ownedState = true; heartbeat = setInterval(() => write("idle"), 1000);
		process.stdout.write(`Shared browser host ready: ${host.endpoint()}; ${config.engine}; token file: ${tokenFile}\n`);
		while (!abort.signal.aborted) await sleep(1000, abort.signal);
		return failed ? 1 : 0;
	} finally {
		clearInterval(heartbeat); await host.close(); if (ownedState) write("stopped");
		for (const name of ["SIGTERM", "SIGINT", "SIGHUP"] as const) process.off(name, cancel);
	}
}
