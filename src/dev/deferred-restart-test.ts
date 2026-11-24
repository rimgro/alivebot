/**
 * Deferred restart tests (`alive restart --deferred`).
 *
 * The feature schedules a transient systemd unit, so nothing here may touch the
 * real service manager: every command goes through the injected runner and the
 * clock is fixed, which also makes the unit name deterministic.
 *
 * Covered: unique unit names, tolerant parsing of `systemctl list-units`
 * output, the pending/stale split, the refusal on a lingering active unit, the
 * `reset-failed` cleanup (including a failing reset), `--collect` on the start,
 * the `--user` scope, flag forwarding and the delay validation in the CLI.
 *
 *   npm run test:deferred-restart
 */
import { main } from "../cli.js";
import {
	DEFAULT_DEFERRED_AFTER_SEC,
	MAX_DEFERRED_AFTER_SEC,
	classifyLingering,
	parseDeferredAfter,
	parseUnitList,
	runDeferredRestart,
	unitNameFor,
	type DeferredRestartOptions,
} from "../runtime/deferred-restart.js";
import { CommandFailure, type CommandRunner } from "../update.js";

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

/** 2023-11-14T22:13:20Z: the epoch seconds give a readable, fixed unit name. */
const NOW = new Date(1_700_000_000_000);
const EPOCH = "1700000000";
const EXEC = "/usr/bin/node";
const SCRIPT = "/opt/alive/dist/index.js";

interface FakeCall {
	command: string;
	args: string[];
}

interface FakeOptions {
	/** stdout of `systemctl list-units …`; empty means "no lingering units". */
	list?: string;
	/** Make the listing fail, e.g. no systemd on this host. */
	failList?: string;
	/** Unit names whose `reset-failed` fails. */
	failReset?: string[];
	/** Make `systemd-run` fail. */
	failStart?: string;
}

interface Fake {
	run: CommandRunner;
	calls: FakeCall[];
}

function fakeService(options: FakeOptions = {}): Fake {
	const calls: FakeCall[] = [];
	const run: CommandRunner = async (command, args) => {
		calls.push({ command, args: [...args] });
		const fail = (detail: string): never => {
			throw new CommandFailure(command, args, 1, "", detail);
		};
		if (command === "systemctl" && args.includes("list-units")) {
			if (options.failList) return fail(options.failList);
			return { stdout: options.list ?? "", stderr: "" };
		}
		if (command === "systemctl" && args.includes("reset-failed")) {
			const unit = args[args.length - 1]!;
			if ((options.failReset ?? []).includes(unit)) return fail(`Failed to reset failed state of unit ${unit}`);
			return { stdout: "", stderr: "" };
		}
		if (command === "systemd-run") {
			if (options.failStart) return fail(options.failStart);
			return { stdout: "", stderr: "" };
		}
		return fail(`unexpected command: ${command} ${args.join(" ")}`);
	};
	return { run, calls };
}

function lines(calls: FakeCall[]): string[] {
	return calls.map((call) => `${call.command} ${call.args.join(" ")}`);
}

async function runWith(fake: Fake, overrides: Partial<DeferredRestartOptions> = {}) {
	return await runDeferredRestart(
		{ afterSec: 5, scope: "system", execPath: EXEC, scriptPath: SCRIPT, execArgv: [], restartArgs: [], ...overrides },
		{ run: fake.run, now: () => NOW },
	);
}

interface CliResult {
	code: number;
	out: string;
	err: string;
	calls: FakeCall[];
}

/** Run the real CLI entry with the fake service manager and the fake clock. */
async function cli(argv: string[], fake: Fake): Promise<CliResult> {
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
		const code = await main(argv, { env: {}, deferred: { run: fake.run, now: () => NOW } });
		return { code, out: out.join(""), err: err.join(""), calls: fake.calls };
	} finally {
		process.stdout.write = stdoutWrite;
		process.stderr.write = stderrWrite;
	}
}

function unit(unit: string, active: string, sub: string, load = "loaded"): string {
	return `  ${unit} ${load} ${active} ${sub} description`;
}

async function mainTests(): Promise<void> {
	section("unit names are unique per request");
	{
		const name = unitNameFor(NOW);
		check("the name carries the epoch seconds", name === `alive-restart-${EPOCH}`, name);
		check("the name is the documented prefix + digits", /^alive-restart-\d+$/.test(name), name);
		check("two requests never share a name", unitNameFor(new Date(1_700_000_001_000)) !== name, unitNameFor(new Date(1_700_000_001_000)));
		check(
			"a later request sorts after an earlier one",
			Number(unitNameFor(new Date(1_700_000_002_000)).slice("alive-restart-".length)) >
				Number(name.slice("alive-restart-".length)),
		);
	}

	section("parseUnitList tolerates real systemctl output");
	{
		const listing = [
			"  ● alive-restart-manual.service loaded failed failed Manual restart attempt",
			"  alive-restart-1700000000.service loaded active running alive restart",
			"",
			"LOAD   = Reflects whether the unit definition was properly loaded.",
			"ACTIVE = The high-level unit activation state, i.e. generalization of SUB.",
			"1 loaded units listed.",
			"junk",
		].join("\n");
		const units = parseUnitList(listing);
		check("bullet lines and plain lines are both parsed", units.length === 2, units);
		check("the failed unit keeps its state", units[0]?.unit === "alive-restart-manual.service" && units[0].active === "failed" && units[0].sub === "failed", units[0]);
		check("the active unit keeps its state", units[1]?.unit === "alive-restart-1700000000.service" && units[1].active === "active" && units[1].sub === "running", units[1]);
		check("the legend and footer are not units", units.every((candidate) => candidate.unit.endsWith(".service")), units);
		check("empty output means no units", parseUnitList("").length === 0);
		check("whitespace-only output means no units", parseUnitList("\n   \n\t\n").length === 0);
	}

	section("classifyLingering splits pending from stale");
	{
		const units = parseUnitList(
			[
				unit("alive-restart-a.service", "active", "running"),
				unit("alive-restart-b.service", "activating", "start"),
				unit("alive-restart-c.service", "reloading", "reload"),
				unit("alive-restart-d.service", "refreshing", "refresh"),
				unit("alive-restart-e.service", "inactive", "dead"),
				unit("alive-restart-f.service", "failed", "failed"),
				unit("alive-restart-g.service", "deactivating", "stop"),
			].join("\n"),
		);
		const { pending, stale } = classifyLingering(units);
		check("active/activating/reloading/refreshing are pending", pending.map((entry) => entry.unit).join(",") === "alive-restart-a.service,alive-restart-b.service,alive-restart-c.service,alive-restart-d.service", pending);
		check("inactive/failed are stale", stale.map((entry) => entry.unit).join(",") === "alive-restart-e.service,alive-restart-f.service", stale);
		check("a stopping unit is neither", ![...pending, ...stale].some((entry) => entry.unit === "alive-restart-g.service"));
	}

	section("delay validation");
	{
		const fallback = parseDeferredAfter(undefined);
		check("no value means the 5s default", fallback.ok && fallback.seconds === DEFAULT_DEFERRED_AFTER_SEC);
		const empty = parseDeferredAfter("");
		check("an empty value means the default", empty.ok && empty.seconds === DEFAULT_DEFERRED_AFTER_SEC);
		const thirty = parseDeferredAfter("30");
		check("a plain integer is accepted", thirty.ok && thirty.seconds === 30);
		check("the maximum is accepted", parseDeferredAfter(String(MAX_DEFERRED_AFTER_SEC)).ok);
		for (const [value, expected] of [
			["0", "between 1 and 3600"],
			["4000", "between 1 and 3600"],
			["abc", "whole number of seconds"],
			["1.5", "whole number of seconds"],
			["-5", "whole number of seconds"],
		] as const) {
			const parsed = parseDeferredAfter(value);
			check(`--after ${value} is rejected with a clear reason`, !parsed.ok && parsed.error.includes(expected), parsed);
		}
		const fake = fakeService();
		const result = await runWith(fake, { afterSec: 0 });
		check("an invalid delay never reaches the service manager", result.outcome === "failed" && fake.calls.length === 0, { result, calls: lines(fake.calls) });
		check("the invalid-delay error says what is allowed", (result.error ?? "").includes("between 1 and 3600"), result.error);
	}

	section("clean start: one --collect unit with a unique name");
	{
		const fake = fakeService();
		const result = await runWith(fake);
		check("the restart is scheduled", result.outcome === "started", result);
		check("the result carries the unique unit name", result.unit === `alive-restart-${EPOCH}`, result.unit);
		check("the delay is reported", result.afterSec === 5, result.afterSec);
		check("exactly two commands run: list, then start", fake.calls.length === 2, lines(fake.calls));
		check(
			"the listing asks only for alive-restart* services",
			lines(fake.calls)[0] === "systemctl list-units --all --no-legend --plain --type=service alive-restart*",
			lines(fake.calls)[0],
		);
		check(
			"the unit is transient, --collect and uniquely named",
			lines(fake.calls)[1] ===
				`systemd-run --on-active=5 --collect --unit=alive-restart-${EPOCH} ${EXEC} ${SCRIPT} restart`,
			lines(fake.calls)[1],
		);
		check("nothing was reset and nothing warned", result.reset.length === 0 && result.warnings.length === 0, result);
	}

	section("a pending unit blocks a second request");
	{
		const fake = fakeService({ list: unit("alive-restart-manual.service", "active", "start", "loaded") });
		const result = await runWith(fake);
		check("the request is refused", result.outcome === "blocked", result);
		check("the pending unit is named with its state", result.pending[0]?.unit === "alive-restart-manual.service" && result.pending[0].active === "active" && result.pending[0].sub === "start", result.pending);
		check("nothing is started", !fake.calls.some((call) => call.command === "systemd-run"), lines(fake.calls));
		check("nothing is reset either", !fake.calls.some((call) => call.args.includes("reset-failed")), lines(fake.calls));
		check("only the listing ran", fake.calls.length === 1, lines(fake.calls));
	}

	section("stale units are cleaned up before the start");
	{
		const fake = fakeService({ list: unit("alive-restart-manual.service", "failed", "failed") });
		const result = await runWith(fake);
		check("the restart still happens", result.outcome === "started", result);
		check(
			"reset-failed runs before systemd-run",
			lines(fake.calls).join(" | ") ===
				[
					"systemctl list-units --all --no-legend --plain --type=service alive-restart*",
					"systemctl reset-failed alive-restart-manual.service",
					`systemd-run --on-active=5 --collect --unit=alive-restart-${EPOCH} ${EXEC} ${SCRIPT} restart`,
				].join(" | "),
			lines(fake.calls),
		);
		check("the cleaned unit is reported", result.reset.map((entry) => entry.unit).join(",") === "alive-restart-manual.service", result.reset);
		check("a clean reset is not a warning", result.warnings.length === 0, result.warnings);
	}
	{
		const fake = fakeService({ list: unit("alive-restart-manual.service", "inactive", "dead") });
		const result = await runWith(fake);
		check("an inactive/dead unit is reset too", result.outcome === "started" && result.reset.length === 1, result);
	}

	section("a failing reset-failed is a warning, never fatal");
	{
		const fake = fakeService({ list: unit("alive-restart-manual.service", "failed", "failed"), failReset: ["alive-restart-manual.service"] });
		const result = await runWith(fake);
		check("the restart still starts", result.outcome === "started", result);
		check("the failed unit is not reported as cleaned", result.reset.length === 0, result.reset);
		check("the failure is reported as a warning", result.warnings.length === 1 && result.warnings[0]!.includes("could not reset alive-restart-manual.service"), result.warnings);
		check("systemd-run still ran", fake.calls.some((call) => call.command === "systemd-run"), lines(fake.calls));
	}

	section("--user switches both commands to the user manager");
	{
		const fake = fakeService({ list: unit("alive-restart-old.service", "failed", "failed") });
		const result = await runWith(fake, { scope: "user" });
		check("the result records the scope", result.scope === "user", result.scope);
		check("the listing uses --user", lines(fake.calls)[0] === "systemctl --user list-units --all --no-legend --plain --type=service alive-restart*", lines(fake.calls)[0]);
		check("the reset uses --user", lines(fake.calls)[1] === "systemctl --user reset-failed alive-restart-old.service", lines(fake.calls)[1]);
		check(
			"systemd-run uses --user",
			lines(fake.calls)[2] === `systemd-run --user --on-active=5 --collect --unit=alive-restart-${EPOCH} ${EXEC} ${SCRIPT} restart`,
			lines(fake.calls)[2],
		);
	}

	section("restart flags are forwarded, scheduling flags are not");
	{
		const forwarded = ["--config", "/opt/alive/alive.config.json", "--force", "--timeout", "45s", "--model", "m1", "--verbose"];
		const fake = fakeService();
		const result = await runWith(fake, { restartArgs: forwarded, afterSec: 20 });
		check("the restart is scheduled", result.outcome === "started", result);
		const start = fake.calls.find((call) => call.command === "systemd-run");
		check(
			"every restart flag reaches the unit command",
			start !== undefined &&
				["--config", "/opt/alive/alive.config.json", "--force", "--timeout", "45s", "--model", "m1", "--verbose"].every((arg) =>
					start.args.includes(arg),
				),
			start?.args,
		);
		check("the unit runs `restart` again", start?.args.slice(start.args.indexOf("restart")).join(" ") === `restart ${forwarded.join(" ")}`, start?.args);
		check("no scheduling flag leaks into the unit", !start?.args.some((arg) => arg === "--deferred" || arg === "--after" || arg === "--user"), start?.args);
		check("the delay is used on systemd-run", start?.args.includes("--on-active=20") === true, start?.args);
	}

	section("listing and start failures are reported, not thrown");
	{
		const fake = fakeService({ failList: "System has not been booted with systemd as init system" });
		const result = await runWith(fake);
		check("a failed listing is an error", result.outcome === "failed", result);
		check("the error says nothing was started", (result.error ?? "").includes("nothing was started"), result.error);
		check("the underlying reason is kept", (result.error ?? "").includes("System has not been booted"), result.error);
		check("no start was attempted", !fake.calls.some((call) => call.command === "systemd-run"), lines(fake.calls));
	}
	{
		const fake = fakeService({ failStart: "Failed to start transient service unit: Unit alive-restart-1700000000.service already exists." });
		const result = await runWith(fake);
		check("a failed start is an error", result.outcome === "failed", result);
		check("the error says no restart was scheduled", (result.error ?? "").includes("no restart was scheduled"), result.error);
		check("the systemd-run reason is kept", (result.error ?? "").includes("already exists"), result.error);
	}

	section("CLI: --deferred validates --after and prints the schedule");
	{
		for (const value of ["0", "abc", "4000"]) {
			const fake = fakeService();
			const result = await cli(["restart", "--deferred", "--after", value], fake);
			check(`--after ${value} exits 1`, result.code === 1, result);
			check(`--after ${value} prints a clear error`, result.err.includes("deferred restart delay"), result.err);
			check(`--after ${value} starts nothing`, fake.calls.length === 0, lines(fake.calls));
		}
		const inline = await cli(["restart", "--deferred=abc"], fakeService());
		check("--deferred=abc is rejected too", inline.code === 1 && inline.err.includes("whole number of seconds"), inline.err);
	}
	{
		const fake = fakeService({ list: unit("alive-restart-manual.service", "failed", "failed") });
		const result = await cli(["restart", "--deferred", "--after", "120", "--user", "--force", "--config", "/tmp/alive.config.json"], fake);
		check("the CLI exits 0", result.code === 0, result);
		check("the unit name is printed", result.out.includes(`deferred restart scheduled: alive-restart-${EPOCH}`), result.out);
		check("the delay is printed", result.out.includes("restart in 120s"), result.out);
		check("the interruption is stated plainly", result.out.includes("the current run will be interrupted in 120s"), result.out);
		check("the journal command uses --user", result.out.includes(`journalctl --user -u alive-restart-${EPOCH}`), result.out);
		check("the stale unit cleanup is printed", result.out.includes("reset stale unit alive-restart-manual.service"), result.out);
		check(
			"the unit command keeps the config and --force, drops --deferred/--after/--user",
			result.calls.some(
				(call) =>
					call.command === "systemd-run" &&
					call.args.includes("--config") &&
					call.args.includes("/tmp/alive.config.json") &&
					call.args.includes("--force") &&
					!call.args.includes("--deferred") &&
					!call.args.includes("--after") &&
					!call.args.some((arg) => arg.startsWith("--after=")),
			),
			lines(result.calls),
		);
	}
	{
		const fake = fakeService({ list: unit("alive-restart-manual.service", "active", "start") });
		const result = await cli(["restart", "--deferred"], fake);
		check("a pending unit makes the CLI exit 1", result.code === 1, result);
		check("the refusal names the unit and its state", result.err.includes("alive-restart-manual.service is active/start"), result.err);
		check("the refusal gives the inspect command", result.err.includes("systemctl status alive-restart-manual.service"), result.err);
		check("the refusal gives the stop command", result.err.includes("systemctl stop alive-restart-manual.service"), result.err);
		check("nothing is started", !fake.calls.some((call) => call.command === "systemd-run"), lines(fake.calls));
	}
}

try {
	await mainTests();
} catch (error) {
	failures += 1;
	process.stderr.write(`\nUNEXPECTED ERROR: ${error instanceof Error ? (error.stack ?? error.message) : String(error)}\n`);
}

process.stdout.write(failures === 0 ? "\nALL DEFERRED RESTART TESTS PASSED\n" : `\n${failures} DEFERRED RESTART TEST(S) FAILED\n`);
process.exitCode = failures === 0 ? 0 : 1;
