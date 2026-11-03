import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as net from "node:net";
import * as os from "node:os";
import * as path from "node:path";
import { loadConfig } from "../config.js";
import { ModuleHost } from "../events/host.js";
import { Logger } from "../log.js";
import { DEFAULT_BROWSER_CONFIG, type BrowserConfig } from "../modules/browser/config.js";
import { BrowserModule } from "../modules/browser/module.js";
import { EventStore } from "../store/events.js";
import { HistoryStore } from "../store/history.js";

// State lives only under os.tmpdir(): the worktree stays untouched.
const root = fs.mkdtempSync(path.join(os.tmpdir(), "alive-browser-port-test-"));
const log = new Logger({ console: false, level: "error" });
const hosts: ModuleHost[] = [];

async function start(overrides: Partial<BrowserConfig> = {}): Promise<{ module: BrowserModule; host: ModuleHost }> {
	const module = new BrowserModule({
		port: 0, minActionIntervalMs: 0, minNavigationIntervalMs: 0, humanization: { enabled: false }, ...overrides,
	}, { notifications: false });
	const loaded = loadConfig({ cwd: fs.mkdtempSync(path.join(root, "instance-")) });
	const store = EventStore.open(loaded.paths.stateDir);
	const host = new ModuleHost({
		config: loaded, log, transports: [], modules: [module],
		ingest: (event) => store.append(event), outbox: () => [], history: HistoryStore.open(loaded.paths.stateDir), runtimeStatus: () => ({}),
	});
	hosts.push(host);
	await host.init();
	return { module, host };
}

/** Reserve then release a loopback port, so the next bind can pin it. */
async function freePort(): Promise<number> {
	const socket = net.createServer();
	await new Promise<void>((resolve) => socket.listen(0, "127.0.0.1", resolve));
	const port = (socket.address() as net.AddressInfo).port;
	await new Promise<void>((resolve) => socket.close(() => resolve()));
	return port;
}

async function accepts(port: number): Promise<boolean> {
	return await new Promise((resolve) => {
		const socket = net.connect({ host: "127.0.0.1", port });
		socket.once("connect", () => { socket.destroy(); resolve(true); });
		socket.once("error", () => resolve(false));
	});
}

try {
	assert.equal(DEFAULT_BROWSER_CONFIG.port, 0, "the default browser port must be ephemeral so agents never collide on a fixed port");

	// The default asks the OS for a port; status reports the real bound port.
	const ephemeral = await start();
	const ephemeralStatus = ephemeral.module.status();
	assert.equal(ephemeralStatus.listening, true, "an ephemeral listener starts");
	assert.equal(typeof ephemeralStatus.port, "number", "status reports the bound port");
	assert.ok((ephemeralStatus.port as number) > 0 && (ephemeralStatus.port as number) <= 65_535, "the bound port is a real TCP port");
	assert.equal(ephemeralStatus.requestedPort, 0, "status keeps the requested ephemeral port");
	assert.equal(ephemeralStatus.error, undefined, "a successful start has no listener error");
	assert.equal(ephemeral.module.localEndpoint(), `http://127.0.0.1:${ephemeralStatus.port}`, "the local endpoint uses the real port");
	assert.equal(await accepts(ephemeralStatus.port as number), true, "the reported port is actually listening");

	// An explicitly configured non-zero port is still honoured exactly as before.
	const pinned = await freePort();
	const explicit = await start({ port: pinned });
	assert.equal(explicit.module.status().port, pinned, "an explicit port is bound unchanged");
	assert.equal(await accepts(pinned), true, "the pinned port is actually listening");

	// An occupied port fails startup with an operator-facing error naming the address and port.
	const holder = net.createServer((socket) => socket.end());
	await new Promise<void>((resolve) => holder.listen(0, "127.0.0.1", resolve));
	const occupied = (holder.address() as net.AddressInfo).port;
	try {
		const blocked = await start({ port: occupied });
		const blockedStatus = blocked.module.status();
		assert.equal(blockedStatus.listening, false, "a failed listener must not report listening");
		assert.equal(blockedStatus.port, undefined, "a failed listener has no bound port");
		const error = String(blockedStatus.error);
		assert.match(error, new RegExp(`127\\.0\\.0\\.1:${occupied}`), "the error names the address and port");
		assert.match(error, /EADDRINUSE/, "the error keeps the OS error code");
		assert.match(error, /already accepting TCP connections/, "the error reports the port probe result");
		assert.match(error, /modules\.browser\.port/, "the error explains how to pin a port");
		if (process.platform === "linux") assert.match(error, new RegExp(`pid ${process.pid}`), "the error names the likely holder on Linux");
		const modules = blocked.host.status().modules as Record<string, { listening?: boolean; port?: number; error?: string }>;
		assert.equal(modules.browser.listening, false, "host status does not claim a failed listener is up");
		assert.match(String(modules.browser.error), new RegExp(`:${occupied}`), "host status surfaces the startup error for the CLI");
	} finally {
		await new Promise<void>((resolve) => holder.close(() => resolve()));
	}

	console.log("browser port tests passed: ephemeral default, pinned port, startup error and real bound-port reporting");
} finally {
	for (const host of hosts) await host.stop();
	fs.rmSync(root, { recursive: true, force: true });
}
