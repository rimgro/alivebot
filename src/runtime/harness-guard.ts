/**
 * "Is this process running inside the harness?" — the guard that keeps
 * `alive restart` from killing the run that issued it.
 *
 * The question only has an environmental answer: the runtime and everything it
 * spawns share an environment, so a marker in the process tree is the cheapest
 * reliable signal, and under systemd the unit's variables (`INVOCATION_ID`,
 * `SYSTEMD_EXEC_PID`, `JOURNAL_STREAM`) are inherited the same way.
 *
 * Those systemd variables are also present in *other* units on the same
 * machine — the update watchdog and the recommended
 * `systemd-run --on-active=5 --unit=alive-restart …` form. Refusing there would
 * break every supported out-of-band restart, so a service-manager environment
 * only counts as "inside the harness" when it cannot be tied to another unit:
 * `SYSTEMD_EXEC_PID` is the pid systemd started for that unit, and when it is
 * not the pid recorded in `runtime.json` the command belongs to a different
 * unit and is allowed.
 *
 * The transient unit started by `alive restart --deferred` is one of those
 * other units, not "inside the harness": it inherits `ALIVE_RUNTIME=1` from the
 * process that scheduled it, but it is the ExecStart systemd started to perform
 * the restart. It marks itself with `ALIVE_DEFERRED_RESTART=<unit>`, and that
 * marker is honoured only when `SYSTEMD_EXEC_PID` is this very process — a
 * descendant (the new harness, runs) inherits the marker but not a matching
 * pid, so the guard keeps working there.
 */
import { term } from "../term.js";

/** Marker the runtime puts into its own environment (and so into every child). */
export const HARNESS_ENV_MARKER = "ALIVE_RUNTIME";

/** Earlier name of the same signal, set by spawnBackground since 0.5. */
export const LEGACY_HARNESS_ENV_MARKERS = ["ALIVE_DAEMON"] as const;

/** Variables systemd sets for every service and passes on to its children. */
export const SYSTEMD_ENV_VARIABLES = ["INVOCATION_ID", "SYSTEMD_EXEC_PID", "JOURNAL_STREAM"] as const;

/**
 * Marker `alive restart --deferred` puts on its transient unit
 * (`--setenv=ALIVE_DEFERRED_RESTART=<unit>`), so the unit's own `alive restart`
 * is recognised as the restart it was asked to perform.
 */
export const DEFERRED_RESTART_ENV_MARKER = "ALIVE_DEFERRED_RESTART";

/**
 * Variables that describe *the process they were read from* — the harness, the
 * deferred unit, or the systemd unit that started the caller. They must never
 * be copied into a different unit's environment (the `direct` strategy of
 * `alive restart --deferred` snapshots the caller's environment into an
 * `EnvironmentFile=`):
 *
 *   - `EnvironmentFile=` is applied after the unit's own `Environment=`, so a
 *     copied `ALIVE_RUNTIME=1` makes the restart refuse itself, and a copied
 *     `SYSTEMD_EXEC_PID` overwrites the pid systemd set for the new unit, so
 *     the deferred marker can no longer prove it is the unit's own ExecStart
 *     (live red on v0.35.4);
 *   - `INVOCATION_ID`/`JOURNAL_STREAM` point at the caller's journal stream.
 */
export const NON_INHERITABLE_ENV_VARIABLES = [
	HARNESS_ENV_MARKER,
	...LEGACY_HARNESS_ENV_MARKERS,
	DEFERRED_RESTART_ENV_MARKER,
	...SYSTEMD_ENV_VARIABLES,
] as const;

export type HarnessOrigin = "runtime" | "systemd" | "deferred";

export interface HarnessDetection {
	/** The command runs inside the harness, so restarting it would kill this run. */
	inside: boolean;
	/** Which signal decided it. */
	origin?: HarnessOrigin;
	/** `VAR=value` evidence for the message (ids only, never secrets). */
	evidence?: string;
	/** Why service-manager variables were not treated as "inside". */
	outsideReason?: string;
}

export interface HarnessDetectionOptions {
	/** Pid of the running harness from `runtime.json`, when it is known. */
	harnessPid?: number;
	/** Pid of the process being inspected; defaults to `process.pid`. */
	selfPid?: number;
}

/**
 * Detect the harness from the environment. `env` is explicit so tests can
 * exercise a fake service environment without touching the real one.
 */
export function detectHarnessEnvironment(
	env: NodeJS.ProcessEnv = process.env,
	options: HarnessDetectionOptions = {},
): HarnessDetection {
	const execPid = Number(env.SYSTEMD_EXEC_PID);
	const selfPid = options.selfPid ?? process.pid;
	const deferredUnit = env[DEFERRED_RESTART_ENV_MARKER];
	// The deferred unit is ExecStart itself: it inherited ALIVE_RUNTIME from the
	// process that scheduled it, so the marker may only exempt the process whose
	// own pid is the one systemd started for that unit.
	if ((deferredUnit ?? "") !== "" && Number.isInteger(execPid) && execPid > 0 && execPid === selfPid) {
		return {
			inside: false,
			origin: "deferred",
			evidence: `${DEFERRED_RESTART_ENV_MARKER}=${deferredUnit} SYSTEMD_EXEC_PID=${execPid}`,
			outsideReason: `this process is the ExecStart of the scheduled unit ${deferredUnit} — it performs the restart that was asked for`,
		};
	}

	for (const variable of [HARNESS_ENV_MARKER, ...LEGACY_HARNESS_ENV_MARKERS]) {
		const value = env[variable];
		if (value === "1" || value === "true") {
			return { inside: true, origin: "runtime", evidence: `${variable}=${value}` };
		}
	}

	const present = SYSTEMD_ENV_VARIABLES.filter((variable) => (env[variable] ?? "") !== "");
	if (present.length === 0) return { inside: false };
	const evidence = present.map((variable) => `${variable}=${env[variable]}`).join(" ");

	if (options.harnessPid !== undefined && Number.isInteger(execPid) && execPid > 0 && execPid !== options.harnessPid) {
		return {
			inside: false,
			origin: "systemd",
			evidence,
			outsideReason: `SYSTEMD_EXEC_PID=${execPid} is not the harness (pid ${options.harnessPid}) — this is a separate unit, e.g. the update watchdog or systemd-run`,
		};
	}
	return { inside: true, origin: "systemd", evidence };
}

/** The one line every `restart`/`stop` invocation prints, accepted or refused. */
export function interruptWarningLine(command: "restart" | "stop"): string {
	return command === "restart"
		? "warning: alive restart interrupts the current run — the harness stops and starts again"
		: "warning: alive stop interrupts the current run — the harness stops";
}

/** Exact CLI prefix used in the refusal, so it is greppable in logs. */
export const RESTART_REFUSED_PREFIX = "refused: alive restart would kill this run";

/**
 * The refusal: says what was detected, that nothing happened, how to force it
 * and the safe out-of-band forms. The deferred form comes first: it is the one
 * the CLI can do itself from here, and it schedules the restart instead of
 * betting on the operator remembering the raw systemd-run line.
 */
export function restartRefusalText(detection: HarnessDetection): string {
	const evidence = detection.evidence ? ` (${detection.evidence})` : "";
	return (
		`${term.red("refused:")} alive restart would kill this run — this process is running inside the harness${evidence}.\n` +
		"Restarting from here stops the very run that issued it: this process dies mid-work and\n" +
		"nothing is left to start the new one. Nothing was stopped and nothing was started.\n" +
		`Schedule the restart instead — it is allowed from here and returns immediately:\n` +
		"  alive restart --deferred              # in 5s; --after 30 / --deferred 30 to wait longer\n" +
		"  alive restart --deferred --user       # when the harness runs as a systemd user service\n" +
		"The current run is interrupted when that unit fires. Raw equivalent (unique unit,\n" +
		"--collect so systemd does not keep it around):\n" +
		"  systemd-run --on-active=5 --collect --unit=alive-restart-$(date +%s) --working-directory=\"$PWD\" /path/to/alive restart\n" +
		"  sudo systemctl restart alive.service   # from a shell outside the service\n" +
		`Re-run as ${term.bold("alive restart --yes")} to interrupt this run right now (it is lost regardless).\n` +
		"(/path/to/alive is the CLI binary, e.g. /opt/alive/dist/index.js)\n"
	);
}
