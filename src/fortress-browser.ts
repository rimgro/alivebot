import * as fs from "node:fs";
import * as path from "node:path";
import { spawn, execFile } from "node:child_process";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));
const cli = path.join(root, "node_modules", "agent-browser", "bin", "agent-browser.js");

export function browserConnection(env = process.env) {
	const port = Number(env.ALIVE_FORTRESS_PORT ?? "9223");
	if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error("Invalid ALIVE_FORTRESS_PORT");
	const endpoint = env.ALIVE_FORTRESS_CDP || `http://127.0.0.1:${port}`;
	const url = new URL(endpoint);
	if (!["http:", "https:"].includes(url.protocol)) throw new Error("ALIVE_FORTRESS_CDP must be an HTTP(S) CDP endpoint");
	return { endpoint: endpoint.replace(/\/$/, ""), port, external: Boolean(env.ALIVE_FORTRESS_CDP) };
}

async function available(endpoint: string): Promise<boolean> {
	try {
		const response = await fetch(`${endpoint}/json/version`, { signal: AbortSignal.timeout(1_000) });
		if (!response.ok) return false;
		const info = await response.json() as { webSocketDebuggerUrl?: string };
		// Stealth Chromium deliberately identifies as Chrome, not "Fortress".
		return Boolean(info.webSocketDebuggerUrl);
	} catch { return false; }
}

let starting: Promise<string> | undefined;
export async function ensureFortress(): Promise<string> {
	if (starting) return starting;
	starting = startFortress();
	try { return await starting; } finally { starting = undefined; }
}

async function startFortress(): Promise<string> {
	const { endpoint, external, port } = browserConnection();
	const stateDir = path.join(root, ".alive", "browser");
	if (await available(endpoint)) {
		if (!external) {
			// A Chrome brand string cannot identify Fortress. For the default local
			// endpoint, require the project launcher's live ownership marker.
			try {
				const pid = Number(fs.readFileSync(path.join(stateDir, `fortress-${port}.pid`), "utf8"));
				if (!Number.isInteger(pid) || pid <= 0) throw new Error("Invalid PID");
				process.kill(pid, 0);
			} catch {
				throw new Error(`CDP port ${port} is occupied by an unmanaged browser. Free it or explicitly configure ALIVE_FORTRESS_CDP for your trusted Fortress instance.`);
			}
		}
		return endpoint;
	}
	if (external) throw new Error(`CDP unavailable at ${endpoint}. Start the configured Fortress instance.`);
	fs.mkdirSync(stateDir, { recursive: true });
	const logPath = path.join(stateDir, "fortress.log");
	const fd = fs.openSync(logPath, "a");
	const launcher = fileURLToPath(new URL(import.meta.url.endsWith(".ts") ? "./fortress.ts" : "./fortress.js", import.meta.url));
	const child = spawn(process.execPath, [...process.execArgv, launcher], {
		cwd: root, detached: true, stdio: ["ignore", fd, fd], env: process.env,
	});
	fs.closeSync(fd);
	let spawnError: Error | undefined;
	child.on("error", (error) => { spawnError = error; });
	child.unref();
	const deadline = Date.now() + 125_000;
	while (Date.now() < deadline) {
		if (spawnError) throw spawnError;
		if (await available(endpoint)) return endpoint;
		if (child.exitCode !== null && child.exitCode !== 0) break;
		await new Promise((resolve) => setTimeout(resolve, 300));
	}
	throw new Error(`Fortress did not start. See ${logPath}; run npm run browser:fortress for diagnostics.`);
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
