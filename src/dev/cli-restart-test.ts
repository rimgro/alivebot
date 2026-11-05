/**
 * CLI tests for `alive restart` / `alive stop` / `alive status`: the commands
 * that act on the *running* harness.
 *
 * Two failures are silent and expensive, so both are covered here:
 *
 *  - `alive restart --help` used to actually restart, killing the run (and the
 *    agent) that only asked for usage (issue #82);
 *  - `alive restart` issued from inside the harness kills its own run, so it is
 *    refused unless `--yes` is given explicitly.
 *
 * Everything runs against a temp project and a fake service control: no real
 * process is stopped or started, and the harness environment is faked through
 * `main(argv, { env })` instead of the real `process.env`.
 *
 *   npm run test:cli-restart
 */
import { spawn, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { main, type ServiceControl } from "../cli.js";
import { loadConfig } from "../config.js";
import { writeHeartbeat } from "../heartbeat.js";
import { Logger } from "../log.js";
import { AliveRuntime } from "../runtime/loop.js";
import { readRuntimeState, writeRuntimeState } from "../store/runs.js";
import { initFailuresPath, readInitFailures, writeInitFailures } from "../store/init-failures.js";
import {
	detectHarnessEnvironment,
	interruptWarningLine,
	restartRefusalText,
} from "../runtime/harness-guard.js";
import { snapshotRuntime, type StopResult } from "../runtime/daemon.js";

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

const root = fs.mkdtempSync(path.join(os.tmpdir(), "alive-cli-restart-test-"));
const project = path.join(root, "project");
fs.mkdirSync(project, { recursive: true });
const configPath = path.join(project, "alive.config.json");
fs.writeFileSync(configPath, JSON.stringify({ name: "CliRestart" }), "utf8");
const stateDir = path.join(project, ".alive");

/** The harness this test pretends to be part of: our own pid, so it is alive. */
const HARNESS_PID = process.pid;
writeRuntimeState(stateDir, {
	pid: HARNESS_PID,
	startedAt: Date.now() - 60_000,
	lastTickAt: Date.now(),
	status: "idle",
	runIndex: 1,
	pending: 0,
	openThreads: 0,
	sleeps: 0,
	mode: "background",
});

/** Environment of a process in the harness's own systemd unit. */
const INSIDE_UNIT: NodeJS.ProcessEnv = {
	INVOCATION_ID: "1f0c2b6e2f0c4f5e8c1a5b0d9e7f3a21",
	SYSTEMD_EXEC_PID: String(HARNESS_PID),
	JOURNAL_STREAM: "9:31177",
};
/** Environment of a different unit (update watchdog, `systemd-run` helper). */
const OTHER_UNIT: NodeJS.ProcessEnv = { ...INSIDE_UNIT, SYSTEMD_EXEC_PID: "1", INVOCATION_ID: "ffffffffffffffffffffffffffffffff" };
/** A plain interactive shell: no service manager, no harness marker. */
const OUTSIDE: NodeJS.ProcessEnv = { PATH: "/usr/local/bin:/usr/bin:/bin" };

interface Calls {
	names: string[];
	stateDirs: string[];
	/** Initiator the CLI passed to the service control (#168). */
	initiators: string[];
	/** Whether `--force`/`--kill` reached the service control (#181). */
	forces: boolean[];
}
function fakeService(calls: Calls, stopResult: Partial<StopResult> = {}): ServiceControl {
	return {
		stop: async (config, flags, initiator) => {
			calls.names.push("stop");
			calls.stateDirs.push(config.paths.stateDir);
			calls.initiators.push(initiator ?? "(default)");
			calls.forces.push(flags.force === true || flags.kill === true);
			return { stopped: true, alreadyStopped: false, forceKilled: false, wasSuspended: false, pid: 4242, ...stopResult };
		},
		start: async () => {
			calls.names.push("start");
			return 0;
		},
	};
}

interface CliResult {
	code: number;
	out: string;
	err: string;
	calls: Calls;
}
/** Run the real CLI entry with a fake service control and a fake environment. */
async function cli(argv: string[], env: NodeJS.ProcessEnv, stopResult: Partial<StopResult> = {}): Promise<CliResult> {
	const calls: Calls = { names: [], stateDirs: [], initiators: [], forces: [] };
	const out: string[] = [];
	const err: string[] = [];
	const stdoutWrite = process.stdout.write;
	const stderrWrite = process.stderr.write;
	process.stdout.write = ((chunk: unknown) => {
		out.push(String(chunk));
		return true;
	}) as typeof process.stdout.write;
	process.stderr.write = ((chunk: unknown) => {
		err.push(String(chunk));
		return true;
	}) as typeof process.stderr.write;
	try {
		const code = await main([...argv, "--config", configPath], { env, service: fakeService(calls, stopResult) });
		return { code, out: out.join(""), err: err.join(""), calls };
	} finally {
		process.stdout.write = stdoutWrite;
		process.stderr.write = stderrWrite;
	}
}

try {
	// -------------------------------------------------------------------------
	section("harness detection from the environment");
	{
		check("an empty environment is outside", !detectHarnessEnvironment({}).inside);
		check("a plain shell is outside", !detectHarnessEnvironment(OUTSIDE).inside);

		const marker = detectHarnessEnvironment({ ALIVE_RUNTIME: "1" }, { harnessPid: HARNESS_PID });
		check("ALIVE_RUNTIME marks the process tree as inside", marker.inside && marker.origin === "runtime", marker);
		const legacy = detectHarnessEnvironment({ ALIVE_DAEMON: "1" }, { harnessPid: HARNESS_PID });
		check("ALIVE_DAEMON (pre-0.6 marker) is still recognised", legacy.inside && legacy.origin === "runtime", legacy);

		const unit = detectHarnessEnvironment(INSIDE_UNIT, { harnessPid: HARNESS_PID });
		check("systemd variables of the harness unit are inside", unit.inside && unit.origin === "systemd", unit);
		check("the evidence names the variables", unit.evidence?.includes("INVOCATION_ID=") === true, unit.evidence);

		const invocationOnly = detectHarnessEnvironment({ INVOCATION_ID: "abc" }, { harnessPid: HARNESS_PID });
		check("INVOCATION_ID alone (no way to prove another unit) is inside", invocationOnly.inside, invocationOnly);
		const journalOnly = detectHarnessEnvironment({ JOURNAL_STREAM: "9:1" }, { harnessPid: HARNESS_PID });
		check("JOURNAL_STREAM is enough on its own", journalOnly.inside, journalOnly);

		const otherUnit = detectHarnessEnvironment(OTHER_UNIT, { harnessPid: HARNESS_PID });
		check("a unit started with a different pid is outside", !otherUnit.inside, otherUnit);
		check("the outside reason names the pid mismatch", otherUnit.outsideReason?.includes("separate unit") === true, otherUnit.outsideReason);

		const noHarness = detectHarnessEnvironment(INSIDE_UNIT, {});
		check("without a harness pid the unit variables still count as inside", noHarness.inside, noHarness);
	}

	// -------------------------------------------------------------------------
	section("--help prints usage and does nothing (issue #82)");
	{
		for (const command of ["stop", "restart", "status"] as const) {
			const help = await cli([command, "--help"], INSIDE_UNIT);
			check(`${command} --help exits 0`, help.code === 0, help.code);
			check(`${command} --help prints the usage line`, help.out.startsWith(`usage: alive ${command}`), help.out);
			check(`${command} --help invokes no service control`, help.calls.names.length === 0, help.calls.names);
			check(`${command} --help prints no interrupt warning`, !help.err.includes("interrupts the current run"), help.err);
		}

		const restartHelp = await cli(["restart", "--help"], INSIDE_UNIT);
		check("restart --help documents --yes", restartHelp.out.includes("--yes"), restartHelp.out);
		check("restart --help shows the systemd-run form", restartHelp.out.includes("systemd-run --on-active=5 --unit=alive-restart"), restartHelp.out);
		check("restart --help shows the systemctl form", restartHelp.out.includes("systemctl restart alive.service"), restartHelp.out);

		const stopHelp = await cli(["stop", "--help"], INSIDE_UNIT);
		check("stop --help documents --timeout", stopHelp.out.includes("--timeout"), stopHelp.out);
		check(
			"stop --help describes force as not waiting for the drain (#181)",
			stopHelp.out.includes("do not wait for the graceful drain"),
			stopHelp.out,
		);
		const statusHelp = await cli(["status", "--help"], INSIDE_UNIT);
		check("status --help documents --json", statusHelp.out.includes("--json"), statusHelp.out);
		check("status --help does not read or print state", !statusHelp.out.includes("inbox"), statusHelp.out);

		// The parser may read a stray token as the value of `--help`; presence alone
		// must still win, otherwise a typo restarts the harness.
		const stray = await cli(["restart", "--help", "ignored"], INSIDE_UNIT);
		check(
			"restart --help with a stray token still only prints usage",
			stray.code === 0 && stray.calls.names.length === 0 && stray.out.startsWith("usage: alive restart"),
			{ code: stray.code, calls: stray.calls.names, out: stray.out },
		);
	}

	// -------------------------------------------------------------------------
	section("restart refuses inside the harness without --yes");
	{
		const refused = await cli(["restart"], INSIDE_UNIT);
		check("exits non-zero", refused.code === 1, refused.code);
		check("stops nothing and starts nothing", refused.calls.names.length === 0, refused.calls.names);
		check("says it is running inside the harness", refused.err.includes("running inside the harness"), refused.err);
		check("shows the detected variables", refused.err.includes("INVOCATION_ID="), refused.err);
		check("says the current run would be killed", refused.err.includes("kill this run"), refused.err);
		check("requires an explicit --yes", refused.err.includes("alive restart --yes"), refused.err);
		check("suggests the systemd-run form", refused.err.includes("systemd-run --on-active=5 --unit=alive-restart"), refused.err);
		check("suggests systemctl from outside", refused.err.includes("systemctl restart alive.service"), refused.err);
		check("prints the interruption warning line", refused.err.includes(interruptWarningLine("restart")), refused.err);
		check("prints nothing on stdout", refused.out.trim() === "", refused.out);

		const runtimeMarker = await cli(["restart"], { ALIVE_RUNTIME: "1" });
		check("the runtime marker refuses too", runtimeMarker.code === 1 && runtimeMarker.calls.names.length === 0, runtimeMarker.err);
		check("the runtime marker is named in the refusal", runtimeMarker.err.includes("ALIVE_RUNTIME=1"), runtimeMarker.err);

		const legacyMarker = await cli(["restart"], { ALIVE_DAEMON: "1" });
		check("the legacy daemon marker refuses too", legacyMarker.code === 1 && legacyMarker.calls.names.length === 0, legacyMarker.err);

		const exact = restartRefusalText(detectHarnessEnvironment(INSIDE_UNIT, { harnessPid: HARNESS_PID }));
		check("the refusal text is the one the CLI prints", refused.err.includes(exact.split("\n")[0]!), refused.err.split("\n")[0]);
	}

	// -------------------------------------------------------------------------
	section("restart --yes proceeds anyway");
	{
		const forced = await cli(["restart", "--yes"], INSIDE_UNIT);
		check("exits 0", forced.code === 0, [forced.code, forced.err]);
		check("stops, then starts", forced.calls.names.join(",") === "stop,start", forced.calls.names);
		check("alive restart tells the runtime it is a restart (#168)", forced.calls.initiators.join(",") === "restart", forced.calls.initiators);
		check("targets the configured state dir", forced.calls.stateDirs[0] === stateDir, forced.calls.stateDirs);
		check("says --yes was used", forced.err.includes("--yes given"), forced.err);
		check("prints the interruption warning line", forced.err.includes(interruptWarningLine("restart")), forced.err);

		const short = await cli(["restart", "-y"], INSIDE_UNIT);
		check("-y is accepted as --yes", short.code === 0 && short.calls.names.join(",") === "stop,start", short.err);
	}

	// -------------------------------------------------------------------------
	section("restart outside the harness behaves as before");
	{
		const plain = await cli(["restart"], OUTSIDE);
		check("exits 0", plain.code === 0, [plain.code, plain.err]);
		check("stops, then starts", plain.calls.names.join(",") === "stop,start", plain.calls.names);
		check("a plain restart is a restart initiator", plain.calls.initiators.join(",") === "restart", plain.calls.initiators);
		check("reports the stop like before", plain.out.includes("stopped pid 4242"), plain.out);
		check("prints no refusal", !plain.err.includes("refused"), plain.err);
		check("prints the interruption warning line", plain.err.includes(interruptWarningLine("restart")), plain.err);

		const otherUnit = await cli(["restart"], OTHER_UNIT);
		check("a different unit is allowed (update watchdog / systemd-run)", otherUnit.code === 0, otherUnit.err);
		check("the different unit still stops and starts", otherUnit.calls.names.join(",") === "stop,start", otherUnit.calls.names);
		check("the different unit is explained", otherUnit.err.includes("separate unit"), otherUnit.err);

		const already = await cli(["restart"], OUTSIDE, { alreadyStopped: true, stopped: true });
		check("restart with nothing running still starts", already.code === 0 && already.calls.names.join(",") === "stop,start", already.calls.names);
		check("nothing running is reported", already.out.includes("not running"), already.out);
	}

	// -------------------------------------------------------------------------
	section("stop still works, inside and outside the harness");
	{
		const stop = await cli(["stop"], OUTSIDE);
		check("exits 0", stop.code === 0, stop.code);
		check("invokes the service control once", stop.calls.names.join(",") === "stop", stop.calls.names);
		check("reports pid and signal", stop.out.includes("stopped pid 4242 (SIGTERM)"), stop.out);
		check("prints the interruption warning line", stop.err.includes(interruptWarningLine("stop")), stop.err);

		const inside = await cli(["stop"], INSIDE_UNIT);
		check("stop is not refused inside the harness", inside.code === 0 && inside.calls.names.join(",") === "stop", [inside.code, inside.err]);
		check("stop inside the harness still warns", inside.err.includes(interruptWarningLine("stop")), inside.err);

		check("alive stop tells the runtime it is a stop (#168)", stop.calls.initiators.join(",") === "stop", stop.calls.initiators);
		check("alive stop inside the harness is still a stop", inside.calls.initiators.join(",") === "stop", inside.calls.initiators);

		const forced = await cli(["stop", "--force"], OUTSIDE);
		check("--force is forwarded to the service control (#181)", forced.calls.forces.join(",") === "true", forced.calls);
		const killed = await cli(["stop", "--kill"], OUTSIDE);
		check("--kill is the force alias", killed.calls.forces.join(",") === "true", killed.calls);
		const plainStop = await cli(["stop"], OUTSIDE);
		check("a plain stop is not forced", plainStop.calls.forces.join(",") === "false", plainStop.calls);

		const failure = await cli(["stop"], OUTSIDE, { stopped: false, error: "still alive" });
		check("a failed stop exits 1", failure.code === 1, failure.code);
		check("a failed stop reports the reason", failure.err.includes("still alive"), failure.err);
	}

	// -------------------------------------------------------------------------
	section("one warning line in every restart/stop path");
	{
		const paths = {
			"restart refused": await cli(["restart"], INSIDE_UNIT),
			"restart --yes": await cli(["restart", "--yes"], INSIDE_UNIT),
			"restart outside": await cli(["restart"], OUTSIDE),
			stop: await cli(["stop"], OUTSIDE),
		};
		for (const [label, result] of Object.entries(paths)) {
			const line = label.startsWith("stop") ? interruptWarningLine("stop") : interruptWarningLine("restart");
			const occurrences = result.err.split("\n").filter((candidate) => candidate === line).length;
			check(`${label}: exactly one warning line`, occurrences === 1, result.err);
		}
	}
	// -------------------------------------------------------------------------
	section("alive status reports dead and running health (#175)");
	{
		const healthProject = fs.mkdtempSync(path.join(os.tmpdir(), "alive-cli-health-"));
		const healthConfig = path.join(healthProject, "alive.config.json");
		fs.writeFileSync(healthConfig, JSON.stringify({ name: "Health", health: { silentMs: 600_000 } }), "utf8");
		const healthStateDir = path.join(healthProject, ".alive");
		const statusJson = async (): Promise<{ code: number; payload: Record<string, unknown> }> => {
			const out: string[] = [];
			const stdoutWrite = process.stdout.write;
			const stderrWrite = process.stderr.write;
			process.stdout.write = ((chunk: unknown) => { out.push(String(chunk)); return true; }) as typeof process.stdout.write;
			process.stderr.write = (() => true) as typeof process.stderr.write;
			let code = -1;
			try {
				code = await main(["status", "--json", "--config", healthConfig]);
			} finally {
				process.stdout.write = stdoutWrite;
				process.stderr.write = stderrWrite;
			}
			return { code, payload: JSON.parse(out.join("")) as Record<string, unknown> };
		};

		const now = Date.now();
		writeRuntimeState(healthStateDir, {
			pid: 999_999_999,
			startedAt: now - 60_000,
			lastTickAt: now - 30_000,
			status: "working",
			runIndex: 1,
			pending: 0,
			openThreads: 0,
			sleeps: 0,
		});
		writeHeartbeat({
			stateDir: healthStateDir,
			pid: 999_999_999,
			startedAt: now - 60_000,
			lastTickAt: now - 30_000,
			unitStatus: "inactive",
		});
		const dead = await statusJson();
		const deadHealth = dead.payload.health as Record<string, unknown> | undefined;
		check("a dead pid is reported as health.state=dead", dead.code === 0 && deadHealth?.state === "dead", deadHealth);
		check(
			"the dead reason names the process, heartbeat and unit",
			typeof deadHealth?.reason === "string" &&
				deadHealth.reason.includes("process is not running") &&
				deadHealth.reason.includes("heartbeat") &&
				deadHealth.reason.includes("unit inactive"),
			deadHealth?.reason,
		);
		check(
			"the health block carries heartbeat age, silentMs and unitStatus",
			typeof deadHealth?.heartbeatAgeMs === "number" &&
				deadHealth.silentMs === 600_000 &&
				deadHealth.unitStatus === "inactive",
			deadHealth,
		);
		check(
			"the existing runtime/staleRuntime fields are unchanged",
			dead.payload.runtime === null && (dead.payload.staleRuntime as { pid?: number } | null)?.pid === 999_999_999,
			{ runtime: dead.payload.runtime, staleRuntime: dead.payload.staleRuntime },
		);

		writeRuntimeState(healthStateDir, {
			pid: process.pid,
			startedAt: now - 60_000,
			lastTickAt: now,
			status: "idle",
			runIndex: 1,
			pending: 0,
			openThreads: 0,
			sleeps: 0,
		});
		writeHeartbeat({ stateDir: healthStateDir, pid: process.pid, startedAt: now - 60_000, lastTickAt: now });
		const running = await statusJson();
		const runningHealth = running.payload.health as Record<string, unknown> | undefined;
		check("a live pid with a fresh heartbeat is health.state=running", runningHealth?.state === "running", runningHealth);
		check("a running health block has no dead reason", runningHealth?.reason === undefined, runningHealth);
		fs.rmSync(healthProject, { recursive: true, force: true });

		// #190: a profile that never started is sleeping, not dead. Nothing was
		// written into its state dir, so there is no trace of a launch.
		const freshProject = fs.mkdtempSync(path.join(os.tmpdir(), "alive-cli-never-started-"));
		const freshConfig = path.join(freshProject, "alive.config.json");
		fs.writeFileSync(freshConfig, JSON.stringify({ name: "Fresh", health: { silentMs: 600_000 } }), "utf8");
		const statusText = async (): Promise<string> => {
			const out: string[] = [];
			const stdoutWrite = process.stdout.write;
			const stderrWrite = process.stderr.write;
			process.stdout.write = ((chunk: unknown) => { out.push(String(chunk)); return true; }) as typeof process.stdout.write;
			process.stderr.write = (() => true) as typeof process.stderr.write;
			try {
				await main(["status", "--config", freshConfig]);
			} finally {
				process.stdout.write = stdoutWrite;
				process.stderr.write = stderrWrite;
			}
			return out.join("");
		};
		const freshJson = async (): Promise<Record<string, unknown> | undefined> => {
			const out: string[] = [];
			const stdoutWrite = process.stdout.write;
			const stderrWrite = process.stderr.write;
			process.stdout.write = ((chunk: unknown) => { out.push(String(chunk)); return true; }) as typeof process.stdout.write;
			process.stderr.write = (() => true) as typeof process.stderr.write;
			try {
				await main(["status", "--json", "--config", freshConfig]);
			} finally {
				process.stdout.write = stdoutWrite;
				process.stderr.write = stderrWrite;
			}
			return JSON.parse(out.join("")).health as Record<string, unknown> | undefined;
		};
		const neverStartedText = await statusText();
		check(
			"`alive status` prints sleeping (never started) for an untouched profile (#190)",
			neverStartedText.includes("sleeping (never started)") && !neverStartedText.includes("not running") && !neverStartedText.includes("dead"),
			neverStartedText,
		);
		const neverStartedHealth = await freshJson();
		check(
			"the JSON health block says stopped + neverStarted (#190)",
			neverStartedHealth?.state === "stopped" &&
				neverStartedHealth.neverStarted === true &&
				neverStartedHealth.reason === undefined,
			neverStartedHealth,
		);
		// One trace of a launch brings the no-runtime dead rule back.
		fs.mkdirSync(path.join(freshProject, ".alive"), { recursive: true });
		fs.writeFileSync(path.join(freshProject, ".alive", "usage.json"), JSON.stringify({ days: {} }), "utf8");
		const startedText = await statusText();
		const startedHealth = await freshJson();
		check(
			"`alive status` reports dead again once the profile has launched before (#190)",
			startedText.includes("dead") && startedHealth?.state === "dead" && startedHealth.neverStarted === undefined,
			{ text: startedText, health: startedHealth },
		);
		fs.rmSync(freshProject, { recursive: true, force: true });
	}

	// -------------------------------------------------------------------------
	section("a failed runtime boot is loud and exits non-zero (#173)");
	{
		// A regular file where the pi session directory belongs makes `init()` fail
		// after runtime.json was already claimed. Nothing here touches the network.
		const project = fs.mkdtempSync(path.join(os.tmpdir(), "alive-cli-dead-start-"));
		const bootConfig = path.join(project, "alive.config.json");
		fs.writeFileSync(bootConfig, JSON.stringify({ name: "DeadStart" }), "utf8");
		const bootStateDir = path.join(project, ".alive");
		fs.mkdirSync(bootStateDir, { recursive: true });
		fs.writeFileSync(path.join(bootStateDir, "sessions"), "not a directory", "utf8");
		const entry = fileURLToPath(new URL("../index.ts", import.meta.url));
		const child = spawn(process.execPath, [...process.execArgv, entry, "run", "--once", "--config", bootConfig], {
			cwd: project,
			env: { ...process.env, ALIVE_DAEMON: "" },
			stdio: ["ignore", "pipe", "pipe"],
		});
		let childOutput = "";
		child.stdout!.on("data", (chunk) => { childOutput += String(chunk); });
		child.stderr!.on("data", (chunk) => { childOutput += String(chunk); });
		const exitCode = (await once(child, "exit"))[0] as number | null;
		check("the failed boot exits with a non-zero code", typeof exitCode === "number" && exitCode !== 0, { exitCode, childOutput });
		const bootState = readRuntimeState(bootStateDir);
		check("runtime.json says status error", bootState?.status === "error", bootState);
		check("runtime.json carries the failure message", (bootState?.error ?? "").length > 0, bootState?.error);
		check("the failed pid is not the test process", bootState?.pid === child.pid, { pid: bootState?.pid, child: child.pid });
		let inbox = "";
		try {
			inbox = fs.readFileSync(path.join(bootStateDir, "inbox", "events.jsonl"), "utf8");
		} catch {
			inbox = "";
		}
		check("one system event explains the failed boot", inbox.includes("runtime failed to start"), inbox.slice(-400));
		check("the failure is reported on stderr", /runtime failed to start/.test(childOutput), childOutput.slice(-400));
		// `alive status` must not report a dead process as alive, and must show the error.
		const out: string[] = [];
		const stdoutWrite = process.stdout.write;
		const stderrWrite = process.stderr.write;
		process.stdout.write = ((chunk: unknown) => { out.push(String(chunk)); return true; }) as typeof process.stdout.write;
		process.stderr.write = ((chunk: unknown) => { return true; }) as typeof process.stderr.write;
		let statusCode = -1;
		try {
			statusCode = await main(["status", "--config", bootConfig]);
		} finally {
			process.stdout.write = stdoutWrite;
			process.stderr.write = stderrWrite;
		}
		const statusText = out.join("");
		check("`alive status` exits 0 for a dead runtime", statusCode === 0, statusCode);
		check("`alive status` does not call the dead runtime alive", statusText.includes("not running") && !statusText.includes(`(pid ${child.pid})`), statusText);
		check("`alive status` shows the recorded error state", statusText.includes("error"), statusText);
		const firstFailure = readInitFailures(bootStateDir);
		check("the failed boot is counted", firstFailure.consecutive === 1, firstFailure);
		check("the counter records the masked error", (firstFailure.lastError ?? "").length > 0, firstFailure.lastError);
		fs.rmSync(project, { recursive: true, force: true });
	}

	// -------------------------------------------------------------------------
	section("repeated init failures keep the process alive instead of a restart loop (#173/#178)");
	{
		const entry = fileURLToPath(new URL("../index.ts", import.meta.url));
		/** A profile whose init always fails after runtime.json was claimed. */
		const brokenProject = (name: string): { project: string; config: string; stateDir: string } => {
			const project = fs.mkdtempSync(path.join(os.tmpdir(), name));
			const config = path.join(project, "alive.config.json");
			fs.writeFileSync(config, JSON.stringify({ name: "LoopBreaker" }), "utf8");
			const stateDir = path.join(project, ".alive");
			fs.mkdirSync(stateDir, { recursive: true });
			fs.writeFileSync(path.join(stateDir, "sessions"), "not a directory", "utf8");
			return { project, config, stateDir };
		};
		/** Start the runtime as the CLI would and collect its output. */
		const launch = (cwd: string, args: string[]) => {
			const child = spawn(process.execPath, [...process.execArgv, entry, ...args], {
				cwd,
				env: { ...process.env, ALIVE_DAEMON: "" },
				stdio: ["ignore", "pipe", "pipe"],
			});
			let output = "";
			child.stdout!.on("data", (chunk) => { output += String(chunk); });
			child.stderr!.on("data", (chunk) => { output += String(chunk); });
			return { child, output: () => output };
		};
		/** Wait for the child to exit, or "timeout"; the timer never outlives the race. */
		const exitWithin = (child: ChildProcess, timeoutMs: number): Promise<number | null | "timeout"> => {
			let timer: NodeJS.Timeout | undefined;
			const timeout = new Promise<"timeout">((resolve) => {
				timer = setTimeout(() => resolve("timeout"), timeoutMs);
			});
			return Promise.race([once(child, "exit").then(([code]) => code as number | null), timeout]).finally(() => {
				if (timer) clearTimeout(timer);
			});
		};
		const waitFor = async (predicate: () => boolean, timeoutMs = 30_000): Promise<boolean> => {
			const deadline = Date.now() + timeoutMs;
			while (Date.now() < deadline) {
				if (predicate()) return true;
				await new Promise((resolve) => setTimeout(resolve, 100));
			}
			return predicate();
		};

		// Third failure inside the window: alive in status=error, no exit.
		const staying = brokenProject("alive-cli-init-halt-");
		writeInitFailures(staying.stateDir, { consecutive: 2, lastFailureAt: Date.now() - 60_000, lastError: "earlier failure" });
		const halted = launch(staying.project, ["run", "--foreground", "--config", staying.config]);
		try {
			const reachedError = await waitFor(() => readRuntimeState(staying.stateDir)?.status === "error");
			check("the third failure lands in status=error", reachedError && readRuntimeState(staying.stateDir)?.status === "error", readRuntimeState(staying.stateDir));
			const haltedState = readRuntimeState(staying.stateDir);
			check("the halted runtime keeps the failure message", (haltedState?.error ?? "").length > 0, haltedState?.error);
			check("the counter records the third failure", readInitFailures(staying.stateDir).consecutive === 3, readInitFailures(staying.stateDir));
			check("the halted process stays alive instead of exiting", halted.child.exitCode === null && halted.child.signalCode === null, {
				exitCode: halted.child.exitCode,
				signal: halted.child.signalCode,
				output: halted.output(),
			});
			check("the failure is logged once as a warning", (halted.output().match(/staying alive in status=error/g) ?? []).length === 1, halted.output());
			// `alive status` on a halted runtime: alive pid, error status, recorded reason.
			const out: string[] = [];
			const stdoutWrite = process.stdout.write;
			const stderrWrite = process.stderr.write;
			process.stdout.write = ((chunk: unknown) => { out.push(String(chunk)); return true; }) as typeof process.stdout.write;
			process.stderr.write = ((chunk: unknown) => { return true; }) as typeof process.stderr.write;
			try {
				await main(["status", "--config", staying.config]);
			} finally {
				process.stdout.write = stdoutWrite;
				process.stderr.write = stderrWrite;
			}
			const haltedStatus = out.join("");
			check(
				"`alive status` reports the halted runtime as error, not alive",
				haltedStatus.includes(`error (pid ${halted.child.pid})`) && haltedStatus.includes("EEXIST"),
				haltedStatus,
			);
		} finally {
			halted.child.kill("SIGTERM");
		}
		const haltedExit = (await once(halted.child, "exit"))[0] as number | null;
		check("SIGTERM still ends the halted process cleanly", haltedExit === 0, { exitCode: haltedExit, output: halted.output() });
		check("the halted process is not left behind", snapshotRuntime(staying.stateDir)?.alive === false, snapshotRuntime(staying.stateDir));
		check("the shutdown keeps the streak for the next start", readInitFailures(staying.stateDir).consecutive === 3, readInitFailures(staying.stateDir));

		// A stop that lands *before* `run()` reaches its wait (SIGTERM during a slow
		// init) must still end the process: `stop()` already ran, so its early
		// return would swallow every later signal and a halted boot would sit on
		// its keepalive timer forever (#173).
		{
			const raced = brokenProject("alive-cli-init-halt-raced-");
			writeInitFailures(raced.stateDir, { consecutive: 2, lastFailureAt: Date.now() - 60_000 });
			const racedConfig = loadConfig({ cwd: raced.project, configPath: raced.config });
			const runtime = await AliveRuntime.create({
				config: racedConfig,
				log: new Logger({ file: racedConfig.paths.logFile, console: false, level: "info" }),
			});
			// The signal handler completes the whole stop while init() is still running.
			await runtime.stop("test-before-run");
			let timer: NodeJS.Timeout | undefined;
			const timeout = new Promise<"timeout">((resolve) => {
				timer = setTimeout(() => resolve("timeout"), 10_000);
			});
			let settled: "resolved" | "timeout" = "timeout";
			try {
				settled = await Promise.race([runtime.run().then(() => "resolved" as const), timeout]);
			} finally {
				if (timer) clearTimeout(timer);
			}
			check("a stop before run() still ends the halted runtime", settled === "resolved", settled);
			check("the raced boot really halted in status=error", runtime.haltedByInitFailures, runtime.haltedByInitFailures);
			if (settled === "timeout") {
				// A regression here would leave the keepalive handle alive and hang the
				// whole suite; fail loudly instead of waiting for the CI timeout.
				process.stderr.write("\nhalted runtime did not finish after an early stop\n");
				process.exit(1);
			}
			fs.rmSync(raced.project, { recursive: true, force: true });
		}

		// `--once` is a one-shot command: it must not wait in status=error.
		const onceProject = brokenProject("alive-cli-init-halt-once-");
		writeInitFailures(onceProject.stateDir, { consecutive: 2, lastFailureAt: Date.now() - 60_000 });
		const onceChild = launch(onceProject.project, ["run", "--once", "--config", onceProject.config]);
		const onceExited = await exitWithin(onceChild.child, 30_000);
		if (onceExited === "timeout") onceChild.child.kill("SIGKILL");
		check("a one-shot run with a halted boot exits non-zero instead of hanging", typeof onceExited === "number" && onceExited !== 0, {
			code: onceExited,
			output: onceChild.output(),
		});
		check("the one-shot failure is counted too", readInitFailures(onceProject.stateDir).consecutive === 3, readInitFailures(onceProject.stateDir));

		// A working boot clears the streak, so a later unrelated failure retries.
		const good = fs.mkdtempSync(path.join(os.tmpdir(), "alive-cli-init-reset-"));
		const goodConfig = path.join(good, "alive.config.json");
		fs.writeFileSync(goodConfig, JSON.stringify({ name: "HealthyBoot", memory: { enabled: false } }), "utf8");
		const goodStateDir = path.join(good, ".alive");
		writeInitFailures(goodStateDir, { consecutive: 3, lastFailureAt: Date.now() - 60_000, lastError: "previous" });
		const goodChild = launch(good, ["run", "--once", "--config", goodConfig]);
		const goodExited = await exitWithin(goodChild.child, 60_000);
		if (goodExited === "timeout") goodChild.child.kill("SIGKILL");
		check("a healthy one-shot boot exits 0", goodExited === 0, { code: goodExited, output: goodChild.output().slice(-400) });
		check("a successful init resets the failure counter", readInitFailures(goodStateDir).consecutive === 0 && !fs.existsSync(initFailuresPath(goodStateDir)), readInitFailures(goodStateDir));
		fs.rmSync(staying.project, { recursive: true, force: true });
		fs.rmSync(onceProject.project, { recursive: true, force: true });
		fs.rmSync(good, { recursive: true, force: true });
	}

} finally {
	fs.rmSync(root, { recursive: true, force: true });
}

process.stdout.write(
	failures === 0 ? "\nALL CLI RESTART TESTS PASSED\n" : `\n${failures} CLI RESTART TEST(S) FAILED\n`,
);
process.exitCode = failures === 0 ? 0 : 1;
