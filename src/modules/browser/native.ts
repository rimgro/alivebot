import { spawn, type ChildProcess } from "node:child_process";
import * as fs from "node:fs";
import * as net from "node:net";
import * as path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { WebSocket } from "ws";

interface Owner { pid: number; endpoint: string; websocket: string }
export interface NativeBrowser { endpoint: string; initialUrl?: string; close(): Promise<void> }

export function chromeExecutable(): string {
	const candidates = process.platform === "darwin" ? ["/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"]
		: process.platform === "win32" ? [path.join(process.env.PROGRAMFILES ?? "", "Google/Chrome/Application/chrome.exe"), path.join(process.env.LOCALAPPDATA ?? "", "Google/Chrome/Application/chrome.exe")]
		: ["/opt/google/chrome/chrome", "/usr/bin/google-chrome", "/usr/bin/google-chrome-stable"];
	const executable = candidates.find(file => fs.existsSync(file));
	if (!executable) throw new Error("Native Chrome executable not found; install Chrome or configure a trusted browser executable");
	return executable;
}

async function protocol(websocket: string, method: string): Promise<unknown> {
	return await new Promise((resolve, reject) => {
		const socket = new WebSocket(websocket, { handshakeTimeout: 2000, maxPayload: 64 * 1024 });
		const timer = setTimeout(() => { socket.terminate(); reject(new Error("Native browser protocol timed out")); }, 3000);
		const finish = (error?: Error, value?: unknown) => { clearTimeout(timer); socket.close(); if (error) reject(error); else resolve(value); };
		socket.once("error", () => finish(new Error("Native browser protocol unavailable")));
		socket.once("open", () => socket.send(JSON.stringify({ id: 1, method })));
		socket.on("message", raw => {
			try { const message = JSON.parse(raw.toString()); if (message.id === 1) finish(message.error ? new Error("Native browser protocol refused") : undefined, message.result); }
			catch { finish(new Error("Invalid native browser protocol response")); }
		});
	});
}

function validOwner(value: unknown): value is Owner {
	if (!value || typeof value !== "object") return false;
	const owner = value as Owner;
	try {
		const endpoint = new URL(owner.endpoint), websocket = new URL(owner.websocket);
		return Number.isInteger(owner.pid) && owner.pid > 0 && endpoint.protocol === "http:" && endpoint.hostname === "127.0.0.1" && !!endpoint.port && !endpoint.username && !endpoint.password && !endpoint.search && !endpoint.hash
			&& websocket.protocol === "ws:" && websocket.host === endpoint.host && /^\/devtools\/browser\/[a-zA-Z0-9-]+$/.test(websocket.pathname) && !websocket.username && !websocket.password && !websocket.search && !websocket.hash;
	} catch { return false; }
}

async function verifyOwner(owner: Owner): Promise<boolean> {
	try {
		const response = await fetch(`${owner.endpoint}/json/version`, { signal: AbortSignal.timeout(2000), redirect: "error" });
		const version = await response.json() as { webSocketDebuggerUrl?: string };
		if (!response.ok || version.webSocketDebuggerUrl !== owner.websocket) return false;
		const processes = await protocol(owner.websocket, "SystemInfo.getProcessInfo") as { processInfo: Array<{ type: string; id: number }> };
		return processes.processInfo.some(process => process.type === "browser" && process.id === owner.pid);
	} catch { return false; }
}

/** Dedicated profiles only. No shell, personal profile, external debug port or stealth injection. */
export async function launchNativeBrowser(input: { executable: string; profile: string; initialUrl?: string; headless: boolean; warmupMs: number; timeoutMs: number; signal: AbortSignal }): Promise<NativeBrowser> {
	input.signal.throwIfAborted();
	fs.mkdirSync(input.profile, { recursive: true, mode: 0o700 }); fs.chmodSync(input.profile, 0o700);
	const marker = path.join(input.profile, "alive-native-owner.json");
	if (fs.existsSync(marker)) {
		let previous: unknown; try { previous = JSON.parse(fs.readFileSync(marker, "utf8")); } catch { throw new Error("Invalid native browser ownership record"); }
		if (!validOwner(previous)) throw new Error("Invalid native browser ownership record");
		let alive = true;
		try { process.kill(previous.pid, 0); } catch (error) { if ((error as NodeJS.ErrnoException).code === "ESRCH") alive = false; else throw new Error("Cannot verify the previous native browser process"); }
		if (alive) {
			if (!await verifyOwner(previous)) throw new Error("The previous native browser cannot be verified; close its dedicated window before restarting this session");
			return owned(previous, marker);
		}
		fs.unlinkSync(marker);
	}
	const reservation = net.createServer();
	await new Promise<void>((resolve, reject) => { reservation.once("error", reject); reservation.listen(0, "127.0.0.1", resolve); });
	const port = (reservation.address() as net.AddressInfo).port;
	await new Promise<void>(resolve => reservation.close(() => resolve()));
	input.signal.throwIfAborted();
	// Port zero enables Chrome's WebDriver flag. Use a reserved nonzero loopback port.
	const args = [`--user-data-dir=${input.profile}`, "--remote-debugging-address=127.0.0.1", `--remote-debugging-port=${port}`, "--no-first-run", "--no-default-browser-check", ...(input.headless ? ["--headless=new"] : []), input.initialUrl || "about:blank"];
	const child = spawn(input.executable, args, { stdio: "ignore" });
	let spawnError = false; child.once("error", () => { spawnError = true; });
	const endpoint = `http://127.0.0.1:${port}`;
	let owner: Owner | undefined;
	try {
		const deadline = Date.now() + input.timeoutMs;
		while (Date.now() < deadline) {
			input.signal.throwIfAborted();
			if (spawnError || child.exitCode !== null || child.signalCode !== null) throw new Error("Native Chrome exited before startup; check its dedicated profile and display");
			try {
				const response = await fetch(`${endpoint}/json/version`, { signal: AbortSignal.any([input.signal, AbortSignal.timeout(1000)]), redirect: "error" });
				const version = await response.json() as { webSocketDebuggerUrl?: string };
				const candidate = { pid: child.pid!, endpoint, websocket: version.webSocketDebuggerUrl! };
				if (response.ok && validOwner(candidate) && await verifyOwner(candidate)) { owner = candidate; break; }
			} catch { input.signal.throwIfAborted(); }
			await delay(100, undefined, { signal: input.signal });
		}
		if (!owner) throw new Error("Native Chrome startup timed out; no verified browser was attached");
		fs.writeFileSync(marker, `${JSON.stringify(owner)}\n`, { mode: 0o600 }); fs.chmodSync(marker, 0o600);
		if (input.initialUrl && input.warmupMs) await delay(input.warmupMs, undefined, { signal: input.signal });
		return { ...owned(owner, marker, child), initialUrl: input.initialUrl };
	} catch (error) {
		if (owner) await owned(owner, marker, child).close(); else await stopChild(child);
		throw error;
	}
}

function owned(owner: Owner, marker: string, child?: ChildProcess): NativeBrowser {
	let closed = false;
	return { endpoint: owner.endpoint, close: async () => {
		if (closed) return; closed = true;
		if (await verifyOwner(owner)) await protocol(owner.websocket, "Browser.close").catch(() => {});
		if (child) await stopChild(child);
		let alive = true;
		for (let i = 0; i < 40; i++) {
			try { process.kill(owner.pid, 0); } catch { alive = false; break; }
			await delay(50);
		}
		// Preserve an unverifiable live process record for explicit recovery; never kill an unrelated PID.
		if (!alive && fs.existsSync(marker)) { const current = JSON.parse(fs.readFileSync(marker, "utf8")) as Owner; if (current.websocket === owner.websocket) fs.unlinkSync(marker); }
	} };
}

async function stopChild(child: ChildProcess): Promise<void> {
	if (!child.pid || child.exitCode !== null || child.signalCode !== null) return;
	child.kill("SIGTERM");
	await new Promise<void>(resolve => { const timer = setTimeout(() => { child.kill("SIGKILL"); resolve(); }, 3000); child.once("exit", () => { clearTimeout(timer); resolve(); }); });
}
