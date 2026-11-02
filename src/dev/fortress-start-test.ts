import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import * as fs from "node:fs";
import { createServer, type AddressInfo } from "node:net";
import * as os from "node:os";
import * as path from "node:path";
import { startFortress } from "../fortress-browser.js";
import { runFortressLauncher } from "../fortress-launcher.js";
import { clearStaleSingletonLocks, isPidAlive, parseSingletonLockTarget, terminateProcess } from "../fortress-runtime.js";

// Every fixture lives under os.tmpdir(); nothing may create .alive in the repo.
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "alive-fortress-start-"));
const cache = path.join(tmp, "cache");
fs.mkdirSync(cache, { recursive: true });
const spawned = new Set<number>();

function directory(...parts: string[]): string {
	const dir = path.join(tmp, ...parts);
	fs.mkdirSync(dir, { recursive: true });
	return dir;
}

async function freePort(): Promise<number> {
	const server = createServer();
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
	const port = (server.address() as AddressInfo).port;
	await new Promise<void>((resolve) => server.close(() => resolve()));
	return port;
}

// existsSync follows symlinks; Chromium's locks point at names that need not exist.
function exists(file: string): boolean {
	try { fs.lstatSync(file); return true; } catch { return false; }
}

async function deadPid(): Promise<number> {
	const child = spawn(process.execPath, ["-e", "process.exit(0)"], { stdio: "ignore" });
	await once(child, "exit");
	return child.pid!;
}

function singletonLock(profile: string, target: string, ageMs = 0): string {
	const file = path.join(profile, "SingletonLock");
	fs.symlinkSync(target, file);
	const when = new Date(Date.now() - ageMs);
	fs.lutimesSync(file, when, when);
	return file;
}

function singletonCompanions(profile: string, ageMs = 0): string[] {
	return ["SingletonSocket", "SingletonCookie"].map((name) => {
		const file = path.join(profile, name);
		fs.symlinkSync(`/tmp/${name}`, file);
		const when = new Date(Date.now() - ageMs);
		fs.lutimesSync(file, when, when);
		return file;
	});
}

function within<T>(work: Promise<T>, ms: number, label: string): Promise<T> {
	return Promise.race([work, new Promise<T>((_resolve, reject) => {
		const timer = setTimeout(() => reject(new Error(`${label} took longer than ${ms}ms`)), ms);
		timer.unref();
	})]);
}

function hangingProcess(marker: string): ReturnType<typeof spawn> {
	const script = `require('node:fs').writeFileSync(${JSON.stringify(marker)}, String(process.pid)); setInterval(() => {}, 1000);`;
	const child = spawn(process.execPath, ["-e", script], { stdio: "ignore" });
	spawned.add(child.pid!);
	return child;
}

function launcher(name: string, source: string): string {
	const file = path.join(tmp, name);
	fs.writeFileSync(file, source);
	return file;
}

function job(name: string, port: number, extra: NodeJS.ProcessEnv = {}) {
	const stateDir = directory(`state-${name}`);
	return {
		stateDir,
		pidPath: path.join(stateDir, `fortress-${port}.pid`),
		logPath: path.join(stateDir, "fortress.log"),
		marker: path.join(stateDir, "browser-started.json"),
		env: { ...process.env, FORTRESS_BROWSERS_PATH: cache, FAKE_PORT: String(port), FAKE_MARKER: path.join(stateDir, "browser-started.json"), ...extra } as NodeJS.ProcessEnv,
	};
}

async function waitGone(pid: number): Promise<void> {
	const deadline = Date.now() + 5_000;
	while (Date.now() < deadline && isPidAlive(pid)) await new Promise((resolve) => setTimeout(resolve, 50));
}

const healthyLauncher = launcher("healthy.mjs", `
import * as fs from "node:fs";
import * as http from "node:http";
fs.writeFileSync(process.env.FAKE_PID_FILE, String(process.pid));
fs.writeFileSync(process.env.FAKE_MARKER, JSON.stringify({ pid: process.pid, argv: process.argv.slice(2) }));
process.stderr.write("fake fortress browser: listening\\n");
http.createServer((_req, res) => {
	res.setHeader("content-type", "application/json");
	res.end(JSON.stringify({ Browser: "Chrome/151.0.7908.0", webSocketDebuggerUrl: "ws://127.0.0.1/devtools/browser/fake" }));
}).listen(Number(process.env.FAKE_PORT), "127.0.0.1");
setInterval(() => {}, 1000);
`);
const hangingLauncher = launcher("hanging.mjs", `
import * as fs from "node:fs";
fs.writeFileSync(process.env.FAKE_PID_FILE, String(process.pid));
fs.writeFileSync(process.env.FAKE_PID_FILE + ".started", "1");
process.stderr.write("Fake Chromium: profile appears to be in use by another Chromium process on another computer.\\n");
process.on("SIGTERM", () => { fs.writeFileSync(process.env.FAKE_PID_FILE + ".term", "1"); process.exit(0); });
setInterval(() => {}, 1000);
`);
const exitingLauncher = launcher("exiting.mjs", `
process.stderr.write("fake launcher: refusing to start a second browser\\n");
process.exit(1);
`);

function countCalls(profile: string): number {
	return clearStaleSingletonLocks({ profile }).decisions.length;
}

try {
	// Lock target parsing: Chromium writes "<hostname>-<pid>", and hostnames may
	// contain dashes, so the pid is the trailing numeric segment.
	assert.deepEqual(parseSingletonLockTarget("workstation-4242"), { hostname: "workstation", pid: 4242 });
	assert.deepEqual(parseSingletonLockTarget("mac.example-777"), { hostname: "mac.example", pid: 777 });
	assert.deepEqual(parseSingletonLockTarget("mac-book-pro-12-777"), { hostname: "mac-book-pro-12", pid: 777 });
	for (const malformed of ["", "host", "host-0", "host-abc", "-42"]) assert.equal(parseSingletonLockTarget(malformed), undefined, malformed);

	// Stale SingletonLock (dead pid) is provably stale: lock and its companions go.
	{
		const profile = directory("unit-dead");
		const pid = await deadPid();
		const lock = singletonLock(profile, `${os.hostname()}-${pid}`);
		const companions = singletonCompanions(profile);
		const scan = clearStaleSingletonLocks({ profile });
		assert.deepEqual(scan.decisions.map((decision) => [decision.action, decision.pid]), [["removed", pid], ["removed", undefined], ["removed", undefined]]);
		assert.equal(scan.live, undefined);
		for (const file of [lock, ...companions]) assert.equal(exists(file), false, `${file} must be removed`);
	}

	// A live local Chrome is never touched, even though the profile looks broken.
	{
		const profile = directory("unit-live");
		const lock = singletonLock(profile, `${os.hostname()}-${process.pid}`);
		const companions = singletonCompanions(profile);
		const scan = clearStaleSingletonLocks({ profile });
		assert.deepEqual(scan.live, { path: lock, pid: process.pid });
		assert.ok(scan.decisions.every((decision) => decision.action === "kept"));
		for (const file of [lock, ...companions]) assert.equal(exists(file), true, `${file} must be kept`);
	}

	// A foreign host cannot own a running local Chrome: stale once it is old
	// enough that a start race is impossible. A fresh foreign lock is kept.
	{
		const profile = directory("unit-foreign");
		const stale = singletonLock(profile, `some-other-machine-${process.pid}`, 10 * 60_000);
		const companions = singletonCompanions(profile, 10 * 60_000);
		const scan = clearStaleSingletonLocks({ profile });
		assert.equal(scan.live, undefined);
		assert.match(scan.decisions[0]!.reason, /foreign host some-other-machine/);
		assert.equal(exists(stale), false);
		for (const file of companions) assert.equal(exists(file), false, `${file} must be removed with its lock`);
	}
	{
		const profile = directory("unit-foreign-fresh");
		const fresh = singletonLock(profile, "some-other-machine-999999", 5_000);
		const scan = clearStaleSingletonLocks({ profile });
		assert.equal(exists(fresh), true, "a recent foreign lock may belong to a browser that is starting");
		assert.match(scan.decisions[0]!.reason, /may be racing/);
	}
	// Orphaned companions without any lock are stale only after the grace period.
	{
		const profile = directory("unit-orphans");
		const old = singletonCompanions(profile, 10 * 60_000);
		const fresh = path.join(directory("unit-orphans-fresh"), "SingletonSocket");
		const freshProfile = path.dirname(fresh);
		fs.symlinkSync("/tmp/SingletonSocket", fresh);
		assert.ok(clearStaleSingletonLocks({ profile }).decisions.every((decision) => decision.action === "removed"));
		assert.ok(clearStaleSingletonLocks({ profile: freshProfile }).decisions.every((decision) => decision.action === "kept"));
		for (const file of old) assert.equal(exists(file), false);
		assert.equal(exists(fresh), true);
	}
	assert.equal(countCalls(directory("unit-missing")), 0);

	// Stale locks (project profile and shared cache profile) are cleared before
	// the launcher spawns, and a healthy start still succeeds.
	{
		const port = await freePort();
		const fixture = job("stale-start", port, { FAKE_PID_FILE: path.join(tmp, "stale-start.browser.pid") });
		const projectProfile = path.join(fixture.stateDir, `profile-${port}`);
		fs.mkdirSync(projectProfile, { recursive: true });
		singletonLock(projectProfile, `${os.hostname()}-${await deadPid()}`, 0);
		singletonCompanions(projectProfile, 0);
		const sharedProfile = path.join(cache, "profile");
		fs.mkdirSync(sharedProfile, { recursive: true });
		const foreign = singletonLock(sharedProfile, `foreign-workstation-${process.pid}`, 10 * 60_000);
		const endpoint = await startFortress({
			connection: { endpoint: `http://127.0.0.1:${port}`, port, external: false },
			stateDir: fixture.stateDir, launcher: healthyLauncher, env: fixture.env,
			deadlineMs: 10_000, pollMs: 100, home: tmp,
		});
		assert.equal(endpoint, `http://127.0.0.1:${port}`);
		const browserPid = Number(fs.readFileSync(fixture.env.FAKE_PID_FILE!, "utf8"));
		spawned.add(browserPid);
		assert.equal(exists(fixture.marker), true, "a start with stale locks must reach the browser");
		assert.equal(exists(path.join(projectProfile, "SingletonLock")), false);
		assert.equal(exists(foreign), false, "the shared cache profile lock must be cleared too");
		const log = fs.readFileSync(fixture.logPath, "utf8");
		assert.match(log, /start Fortress: endpoint=http:\/\/127\.0\.0\.1:\d+ argv=/);
		assert.match(log, /SingletonLock: removed \(local pid \d+ is not running\)/);
		assert.match(log, /SingletonLock: removed \(foreign host foreign-workstation/);
	}

	// A live local Chrome owns the profile: start fails fast, before spawning,
	// with a message that names the pid instead of waiting for Chrome to hang.
	{
		const port = await freePort();
		const fixture = job("live-lock", port, { FAKE_PID_FILE: path.join(tmp, "live-lock.browser.pid") });
		const profile = path.join(fixture.stateDir, `profile-${port}`);
		fs.mkdirSync(profile, { recursive: true });
		const lock = singletonLock(profile, `${os.hostname()}-${process.pid}`);
		await assert.rejects(startFortress({
			connection: { endpoint: `http://127.0.0.1:${port}`, port, external: false },
			stateDir: fixture.stateDir, launcher: healthyLauncher, env: fixture.env,
			deadlineMs: 2_000, pollMs: 50, home: tmp,
		}), new RegExp(`in use by live Chromium pid ${process.pid}`));
		assert.equal(exists(lock), true, "a live lock must never be removed");
		assert.equal(exists(fixture.marker), false, "no launcher may be spawned");
	}

	// Startup timeout: the fake child is terminated, the pid file is removed, and
	// the error carries the tail of the log (where the Chrome message is).
	{
		const port = await freePort();
		const fakePidFile = path.join(tmp, "timeout.browser.pid");
		const fixture = job("timeout", port, { FAKE_PID_FILE: fakePidFile });
		const error = await startFortress({
			connection: { endpoint: `http://127.0.0.1:${port}`, port, external: false },
			stateDir: fixture.stateDir, launcher: hangingLauncher, env: fixture.env,
			deadlineMs: 1_500, graceMs: 1_000, pollMs: 100, home: tmp,
		}).then(() => assert.fail("a silent port must not look like a healthy start"), (reason: Error) => reason);
		const browserPid = Number(fs.readFileSync(fakePidFile, "utf8"));
		spawned.add(browserPid);
		assert.match(error.message, /did not start/);
		assert.match(error.message, /profile appears to be in use by another Chromium process on another computer/);
		assert.match(error.message, /Last lines of .*fortress\.log/);
		await waitGone(browserPid);
		assert.equal(isPidAlive(browserPid), false, "the launcher must not survive a failed start");
		assert.equal(fs.existsSync(fixture.pidPath), false, "a failed start must not leave a pid file");
	}

	// A pid file that claims "running" while no port answers is a broken
	// instance: it is terminated, cleaned up, and the start fails loudly.
	{
		const port = await freePort();
		const fixture = job("broken-pid", port, {});
		const orphan = spawn(process.execPath, [hangingLauncher], {
			stdio: "ignore", env: { ...fixture.env, FAKE_PID_FILE: path.join(tmp, "broken-pid.browser.pid") },
		});
		spawned.add(orphan.pid!);
		const deadline = Date.now() + 5_000;
		while (!fs.existsSync(path.join(tmp, "broken-pid.browser.pid")) && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 20));
		fs.writeFileSync(fixture.pidPath, String(orphan.pid));
		const error = await startFortress({
			connection: { endpoint: `http://127.0.0.1:${port}`, port, external: false },
			stateDir: fixture.stateDir, launcher: exitingLauncher, env: fixture.env,
			deadlineMs: 600, graceMs: 1_000, pollMs: 50, home: tmp,
		}).then(() => assert.fail("a pid file without a listening port must not be treated as healthy"), (reason: Error) => reason);
		assert.match(error.message, /did not start/);
		await waitGone(orphan.pid!);
		assert.equal(isPidAlive(orphan.pid!), false, "the broken instance must be terminated");
		assert.equal(fs.existsSync(fixture.pidPath), false, "the stale pid file must be removed");
		const log = fs.readFileSync(fixture.logPath, "utf8");
		assert.match(log, /was alive but CDP .* never answered .*treated as a broken instance/);
		assert.match(log, /refusing to start a second browser/);
	}
	// The launcher's own timeout path: a browser that never becomes ready is
	// terminated (SIGTERM, grace, SIGKILL), the unbounded upstream close() cannot
	// block teardown, and the pid file does not survive.
	{
		const port = await freePort();
		const stateDir = directory("launcher-timeout");
		const browserPidFile = path.join(tmp, "launcher-timeout.browser.pid");
		const browser = hangingProcess(browserPidFile);
		while (!fs.existsSync(browserPidFile)) await new Promise((resolve) => setTimeout(resolve, 20));
		const lines: string[] = [];
		let resolveExit!: (code: number) => void;
		const exited = new Promise<number>((resolve) => { resolveExit = resolve; });
		void runFortressLauncher({
			stateDir, port, timeoutMs: 300, graceMs: 200, keepAlive: false,
			env: { ...process.env, FORTRESS_BROWSERS_PATH: cache },
			log: (line) => lines.push(line),
			createBrowser: () => ({ proc: browser, start: () => new Promise(() => {}), close: () => new Promise(() => {}) }),
			exit: (code) => resolveExit(code),
		});
		assert.equal(await within(exited, 10_000, "launcher startup timeout"), 1);
		const log = lines.join("\n");
		assert.match(log, /startup timed out after 300ms/);
		assert.match(log, new RegExp(`browser process ${browser.pid} terminated`));
		assert.match(log, /Fortress close: Fortress close did not finish within 200ms/);
		assert.match(log, /removed pid file .*fortress-\d+\.pid/);
		assert.equal(exists(path.join(stateDir, `fortress-${port}.pid`)), false);
		await waitGone(browser.pid!);
		assert.equal(isPidAlive(browser.pid!), false, "the fake browser must not survive the timeout");
	}

	// A rejected start takes the same bounded teardown path and exits non-zero.
	{
		const port = await freePort();
		const stateDir = directory("launcher-failed");
		const lines: string[] = [];
		const code = await runFortressLauncher({
			stateDir, port, timeoutMs: 5_000, graceMs: 200, keepAlive: false,
			env: { ...process.env, FORTRESS_BROWSERS_PATH: cache },
			log: (line) => lines.push(line),
			createBrowser: () => ({ proc: null, start: async () => { throw new Error("chrome refused to start"); }, close: async () => {} }),
			exit: () => { throw new Error("a failed start must return instead of exiting"); },
		});
		assert.equal(code, 1);
		assert.match(lines.join("\n"), /start failed: chrome refused to start/);
		assert.match(lines.join("\n"), /removed pid file/);
		assert.equal(exists(path.join(stateDir, `fortress-${port}.pid`)), false);
	}

	// The launcher also refuses to start a second browser for a live local lock.
	{
		const port = await freePort();
		const stateDir = directory("launcher-live-lock");
		const profile = path.join(stateDir, `profile-${port}`);
		fs.mkdirSync(profile, { recursive: true });
		const lock = singletonLock(profile, `${os.hostname()}-${process.pid}`);
		const lines: string[] = [];
		const code = await runFortressLauncher({
			stateDir, port, timeoutMs: 5_000, keepAlive: false,
			env: { ...process.env, FORTRESS_BROWSERS_PATH: cache },
			log: (line) => lines.push(line),
			createBrowser: () => { throw new Error("no browser may be created"); },
			exit: () => { throw new Error("must return instead of exiting"); },
		});
		assert.equal(code, 1);
		assert.match(lines.join("\n"), new RegExp(`held by live Chromium pid ${process.pid}`));
		assert.equal(exists(lock), true);
		assert.equal(exists(path.join(stateDir, `fortress-${port}.pid`)), false);
	}
} finally {
	for (const pid of spawned) await terminateProcess(pid, { graceMs: 1_000 });
	fs.rmSync(tmp, { recursive: true, force: true });
}
console.log("fortress start tests passed");
