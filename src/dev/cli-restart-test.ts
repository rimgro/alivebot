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
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { main, type ServiceControl } from "../cli.js";
import { writeRuntimeState } from "../store/runs.js";
import {
	detectHarnessEnvironment,
	interruptWarningLine,
	restartRefusalText,
} from "../runtime/harness-guard.js";
import type { StopResult } from "../runtime/daemon.js";

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
}
function fakeService(calls: Calls, stopResult: Partial<StopResult> = {}): ServiceControl {
	return {
		stop: async (config) => {
			calls.names.push("stop");
			calls.stateDirs.push(config.paths.stateDir);
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
	const calls: Calls = { names: [], stateDirs: [] };
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
} finally {
	fs.rmSync(root, { recursive: true, force: true });
}

process.stdout.write(
	failures === 0 ? "\nALL CLI RESTART TESTS PASSED\n" : `\n${failures} CLI RESTART TEST(S) FAILED\n`,
);
process.exitCode = failures === 0 ? 0 : 1;
