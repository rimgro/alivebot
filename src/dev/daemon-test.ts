/**
 * Instance-management tests: the background lifecycle used by
 * `alive run|stop|restart|logs`.
 *
 * These are the paths where a mistake leaves an agent that looks alive but
 * answers nothing (suspended process, zombie pid, stale runtime state), so they
 * are exercised against real child processes instead of mocks.
 *
 *   npm run test:daemon
 */
import { spawn, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { loadConfig } from "../config.js";
import { followFile, readLogTail, renderLogLine, resolveLogSource } from "../logs.js";
import { snapshotRuntime, spawnBackground, stdoutLogPath, stopRuntime, waitForRuntime } from "../runtime/daemon.js";
import { writeRuntimeState, readRuntimeState } from "../store/runs.js";
import { isProcessAlive, isProcessSuspended, processState, sleep } from "../util.js";

let failures = 0;
function check(name: string, condition: boolean, detail?: unknown): void {
	if (condition) {
		process.stdout.write(`  ok    ${name}\n`);
		return;
	}
	failures += 1;
	process.stdout.write(`  FAIL  ${name}${detail === undefined ? "" : ` — ${JSON.stringify(detail)}`}\n`);
}
function section(name: string): void {
	process.stdout.write(`\n${name}\n`);
}

const root = fs.mkdtempSync(path.join(os.tmpdir(), "alive-daemon-test-"));
const config = loadConfig({ cwd: root });
const stateDir = config.paths.stateDir;

/** A detached process that outlives this test until it is explicitly killed. */
function spawnStub(script: string): ChildProcess {
	const child = spawn(process.execPath, ["-e", script], { detached: true, stdio: "ignore" });
	child.unref();
	return child;
}

/** Poll until the pid disappears; `once(child, 'exit')` can miss an already-reaped child. */
async function waitGone(pid: number, timeoutMs = 3_000): Promise<boolean> {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		if (!isProcessAlive(pid)) return true;
		await sleep(25);
	}
	return false;
}

async function waitForFile(file: string, timeoutMs = 5_000): Promise<boolean> {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		if (fs.existsSync(file)) return true;
		await sleep(25);
	}
	return false;
}

/**
 * A stub that ignores SIGTERM, ready to be signalled: it touches a marker file
 * only after the handler is installed, because a signal sent during node's own
 * startup would hit the default disposition and prove nothing.
 */
async function spawnSigtermIgnoringStub(): Promise<ChildProcess> {
	const marker = path.join(root, `stubborn-${Date.now()}-${Math.random().toString(36).slice(2)}.ready`);
	const child = spawnStub(
		`process.on('SIGTERM', () => {}); require('node:fs').writeFileSync(${JSON.stringify(marker)}, 'ready'); setInterval(() => {}, 1000);`,
	);
	if (!(await waitForFile(marker))) throw new Error("stubborn stub never became ready");
	return child;
}

async function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T | "timeout"> {
	let timer: NodeJS.Timeout | undefined;
	const timeout = new Promise<"timeout">((resolve) => {
		timer = setTimeout(() => {
			check(`${label} finishes within ${ms}ms`, false);
			resolve("timeout");
		}, ms);
	});
	try {
		return await Promise.race([promise, timeout]);
	} finally {
		if (timer) clearTimeout(timer);
	}
}

section("process state helpers");
{
	check("our own pid is alive", isProcessAlive(process.pid));
	check("our own state comes from /proc", (processState(process.pid) ?? "").length === 1, processState(process.pid));
	check("our own pid is not suspended", !isProcessSuspended(process.pid));
	check("pid 0 is never alive", !isProcessAlive(0));
	check("nonsense pid is never alive", !isProcessAlive(Number.NaN));

	const dead = spawn(process.execPath, ["-e", ""], { stdio: "ignore" });
	const deadPid = dead.pid!;
	await once(dead, "exit");
	check("an exited (reaped) child is not alive", !isProcessAlive(deadPid), deadPid);

	const suspended = spawnStub("setInterval(() => {}, 1000)");
	try {
		process.kill(suspended.pid!, "SIGSTOP");
		await sleep(150);
		check("SIGSTOP is detected as suspended", isProcessSuspended(suspended.pid!), processState(suspended.pid!));
	} finally {
		process.kill(suspended.pid!, "SIGCONT");
		process.kill(suspended.pid!, "SIGKILL");
	}
	check("a SIGCONT+SIGKILL'd stub is gone", await waitGone(suspended.pid!));
}

section("snapshotRuntime");
{
	check("no state file means no snapshot", snapshotRuntime(stateDir) === null);

	writeRuntimeState(stateDir, {
		pid: process.pid,
		startedAt: Date.now() - 5_000,
		lastTickAt: Date.now(),
		status: "idle",
		runIndex: 1,
		pending: 0,
		openThreads: 0,
		sleeps: 0,
		mode: "background",
	});
	const live = snapshotRuntime(stateDir);
	check("own pid reads as alive", live?.alive === true, live);
	check("not flagged as suspended", live?.suspended === false);
	check("a live run is not a clean stop", live?.cleanStop === false);
	check("mode is preserved", live?.state.mode === "background");

	const stale = spawn(process.execPath, ["-e", ""], { stdio: "ignore" });
	const stalePid = stale.pid!;
	await once(stale, "exit");
	writeRuntimeState(stateDir, { ...readRuntimeState(stateDir)!, pid: stalePid });
	check("dead pid reads as not alive", snapshotRuntime(stateDir)?.alive === false, stalePid);

	writeRuntimeState(stateDir, { ...readRuntimeState(stateDir)!, status: "stopped" });
	check("clean stop is reported", snapshotRuntime(stateDir)?.cleanStop === true);
}

section("background spawn + readiness detection");
{
	// The real CLI entry, so the child parses alive's own flags instead of this test.
	const entry = fileURLToPath(new URL("../index.ts", import.meta.url));
	const failing = spawnBackground({ paths: config.paths, entry, command: ["--help"], args: [] });
	const notReady = await waitForRuntime(stateDir, failing.pid, { child: failing.child, timeoutMs: 5_000 });
	check("a child that exits at once never becomes the runtime", notReady === null, failing.pid);
	check("the spawn banner goes to stdout.log", fs.existsSync(stdoutLogPath(config.paths)));
	check(
		"the banner names the command and mode",
		fs.readFileSync(stdoutLogPath(config.paths), "utf8").includes("(background) started"),
		readLogTail(stdoutLogPath(config.paths), 5),
	);
	check("the child is gone afterwards", await waitGone(failing.pid));
}

section("stopRuntime");
{
	check("stopping nothing is a no-op", (await stopRuntime(stateDir)).alreadyStopped);

	// Ignores SIGTERM: the only way out is the SIGKILL escalation.
	const stubborn = await spawnSigtermIgnoringStub();
	writeRuntimeState(stateDir, { ...readRuntimeState(stateDir)!, pid: stubborn.pid!, status: "idle" });
	const escalated = await stopRuntime(stateDir, { timeoutMs: 400, pollMs: 50 });
	check("SIGTERM-ignoring runtime is force killed", escalated.stopped && escalated.forceKilled, escalated);
	check("the runtime state is rewritten as stopped", readRuntimeState(stateDir)?.status === "stopped");

	// Suspended (Ctrl+Z): a stopped process never runs its SIGTERM handler, so it
	// must be continued first — otherwise every stop turns into a SIGKILL.
	const frozen = spawnStub("setInterval(() => {}, 1000)");
	process.kill(frozen.pid!, "SIGSTOP");
	await sleep(150);
	writeRuntimeState(stateDir, { ...readRuntimeState(stateDir)!, pid: frozen.pid!, status: "idle" });
	const woken = await stopRuntime(stateDir, { timeoutMs: 5_000, pollMs: 50 });
	check("a suspended runtime is stopped", woken.stopped, woken);
	check("a suspended runtime is reported", woken.wasSuspended, woken);
	check("a suspended runtime dies from SIGTERM, not SIGKILL", !woken.forceKilled, woken);

	// Default disposition: plain SIGTERM.
	const graceful = spawnStub("setInterval(() => {}, 1000)");
	writeRuntimeState(stateDir, { ...readRuntimeState(stateDir)!, pid: graceful.pid!, status: "idle" });
	const clean = await stopRuntime(stateDir, { timeoutMs: 5_000, pollMs: 50 });
	check("a cooperative runtime stops gracefully", clean.stopped && !clean.forceKilled, clean);
}

section("log rendering and following");
{
	const aliveLine = JSON.stringify({ ts: Date.now(), level: "warn", scope: "alive:module:telegram", msg: "telegram getUpdates failed", data: { failures: 3 } });
	const rendered = renderLogLine("alive", aliveLine) ?? "";
	check("jsonl is rendered as a log line", rendered.includes("telegram getUpdates failed") && rendered.includes("WARN"), rendered);
	check("jsonl data is appended", rendered.includes('"failures":3'), rendered);
	check("broken jsonl is passed through", renderLogLine("alive", "not json") === "not json");
	check("stdout lines are passed through", renderLogLine("stdout", "hello") === "hello");
	check("blank lines are dropped", renderLogLine("stdout", "   ") === undefined);

	const thought = renderLogLine("thoughts", JSON.stringify({ ts: Date.now(), runIndex: 7, text: "", thinking: "hmm" })) ?? "";
	check("thoughts fall back to the thinking field", thought.includes("run #7") && thought.includes("hmm"), thought);

	check("source aliases resolve", resolveLogSource(config.paths, "json").source === "alive");
	check("thoughts source resolves", resolveLogSource(config.paths, "thoughts").file === config.paths.thoughtsFile);
	let unknownSource = "";
	try {
		resolveLogSource(config.paths, "nope");
	} catch (err) {
		unknownSource = (err as Error).message;
	}
	check("an unknown source is rejected with the valid list", unknownSource.includes("stdout, alive, thoughts"), unknownSource);

	const file = path.join(root, "follow.log");
	fs.writeFileSync(file, "old line\n");
	const controller = new AbortController();
	const seen: string[] = [];
	const follower = followFile(
		file,
		(line) => {
			seen.push(line);
			if (seen.length >= 2) controller.abort();
		},
		{ fromOffset: fs.statSync(file).size, pollMs: 20, signal: controller.signal },
	);
	await sleep(60);
	fs.appendFileSync(file, "first appended\nsecond appended\n");
	const followed = await withTimeout(follower, 3_000, "follow");
	check("follow streams appended lines", seen.join(",") === "first appended,second appended", seen);
	check("follow stops when aborted", followed !== "timeout", followed);
}

process.stdout.write(
	failures === 0 ? `\nALL DAEMON TESTS PASSED (${root})\n` : `\n${failures} DAEMON TEST(S) FAILED\n`,
);
process.exitCode = failures === 0 ? 0 : 1;
