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
 */
import { term } from "../term.js";

/** Marker the runtime puts into its own environment (and so into every child). */
export const HARNESS_ENV_MARKER = "ALIVE_RUNTIME";

/** Earlier name of the same signal, set by spawnBackground since 0.5. */
export const LEGACY_HARNESS_ENV_MARKERS = ["ALIVE_DAEMON"] as const;

/** Variables systemd sets for every service and passes on to its children. */
export const SYSTEMD_ENV_VARIABLES = ["INVOCATION_ID", "SYSTEMD_EXEC_PID", "JOURNAL_STREAM"] as const;

export type HarnessOrigin = "runtime" | "systemd";

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
}

/**
 * Detect the harness from the environment. `env` is explicit so tests can
 * exercise a fake service environment without touching the real one.
 */
export function detectHarnessEnvironment(
	env: NodeJS.ProcessEnv = process.env,
	options: HarnessDetectionOptions = {},
): HarnessDetection {
	for (const variable of [HARNESS_ENV_MARKER, ...LEGACY_HARNESS_ENV_MARKERS]) {
		const value = env[variable];
		if (value === "1" || value === "true") {
			return { inside: true, origin: "runtime", evidence: `${variable}=${value}` };
		}
	}

	const present = SYSTEMD_ENV_VARIABLES.filter((variable) => (env[variable] ?? "") !== "");
	if (present.length === 0) return { inside: false };
	const evidence = present.map((variable) => `${variable}=${env[variable]}`).join(" ");

	const execPid = Number(env.SYSTEMD_EXEC_PID);
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
 * and the two safe out-of-band forms.
 */
export function restartRefusalText(detection: HarnessDetection): string {
	const evidence = detection.evidence ? ` (${detection.evidence})` : "";
	return (
		`${term.red("refused:")} alive restart would kill this run — this process is running inside the harness${evidence}.\n` +
		"Restarting from here stops the very run that issued it: this process dies mid-work and\n" +
		"nothing is left to start the new one. Nothing was stopped and nothing was started.\n" +
		`Re-run as ${term.bold("alive restart --yes")} to restart anyway (the current run is lost regardless).\n` +
		"To restart without interrupting this run, schedule it from outside:\n" +
		"  systemd-run --on-active=5 --unit=alive-restart /path/to/alive restart\n" +
		"  sudo systemctl restart alive.service   # from a shell outside the service\n" +
		"(/path/to/alive is the CLI binary, e.g. /opt/alive/dist/index.js)\n"
	);
}
