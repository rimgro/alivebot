/**
 * Deferred restart: schedule `alive restart` as a transient systemd unit.
 *
 * `alive restart` cannot replace the harness from inside it — the process that
 * issues the command *is* the run that gets killed, so the command is refused
 * there (see `harness-guard.ts`). The way out is a one-shot systemd unit that
 * fires a few seconds later, outside this process. The CLI used to only print
 * that advice; this module schedules the unit itself.
 *
 * House rules, after a live incident (23.11) left `alive-restart-manual`
 * hanging around from an earlier manual attempt:
 *   - every request gets a unique name, `alive-restart-<epoch-seconds>`, so two
 *     requests can never reuse or overwrite each other's unit;
 *   - the unit is started with `--collect`, so systemd forgets it once it ran
 *     instead of leaving loaded/failed garbage behind forever;
 *   - a lingering unit from an earlier request is never ignored: an *active*
 *     one means a restart is already on its way (refuse and tell the operator
 *     how to inspect/stop it), while finished `inactive`/`dead`/`failed` ones
 *     are cleaned up with `systemctl reset-failed`;
 *   - the flow is planning plus an injected command runner, so tests never
 *     touch a real service manager.
 *
 * The unit must also look like the restart it was asked for:
 *   - `--working-directory=<cwd>` pins the unit to the directory the operator
 *     ran `alive restart --deferred` from. Without it the unit starts in
 *     `$HOME`, `loadForCli` reads another (or an empty) profile there, and the
 *     restart would target the wrong instance — or refuse, because the harness
 *     pid from that profile's `runtime.json` is not found;
 *   - `--setenv=ALIVE_DEFERRED_RESTART=<unit>` marks the unit explicitly.
 *     `systemd-run` does *not* pass the caller's environment to a transient
 *     unit, but `ALIVE_RUNTIME=1` may still arrive from a parent process; the
 *     marker lets the guard recognise the unit's own ExecStart and not refuse
 *     it (see `harness-guard.ts`).
 *
 * Two strategies (#258):
 *   - **supervisor** — the profile already runs under a systemd unit, so the
 *     transient unit just runs `systemctl [--user] restart <supervisor>`. The
 *     environment and the profile come from that unit, the restart happens
 *     exactly once, and there is no race with its `Restart=always`.
 *   - **direct** — no supervisor: the transient unit runs `alive restart` from
 *     the caller's directory. `systemd-run` drops the caller's environment, so
 *     it is snapshotted into a 0600 file passed as `EnvironmentFile=`, and the
 *     absolute `--config` is always forwarded (the unit's cwd alone does not
 *     identify the root profile's `.env`).
 *
 * Scope: the default is the system manager, the same scope the printed advice
 * has always used. `--user` switches both `systemctl` and `systemd-run` to the
 * user manager for setups where the harness runs as a user service. In the
 * supervisor strategy the scope must match the supervisor's manager.
 */
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { oneLine } from "../util.js";
import type { CommandRunner } from "../update.js";
import { DEFERRED_RESTART_ENV_MARKER } from "./harness-guard.js";
import {
	detectSupervisorUnit,
	type SupervisorScope,
	type SupervisorUnit,
} from "./supervisor-unit.js";

/** Transient units this feature owns; the glob systemd matches them by. */
export const DEFERRED_UNIT_PREFIX = "alive-restart-";
// No dash before the star: this also matches a legacy `alive-restart` unit left
// by the raw advice that older versions printed.
export const DEFERRED_UNIT_PATTERN = "alive-restart*";

/** Default and maximum delay, in seconds. */
export const DEFAULT_DEFERRED_AFTER_SEC = 5;
export const MAX_DEFERRED_AFTER_SEC = 3600;

/**
 * systemctl/systemd-run answer immediately; a wedged service manager must never
 * hold the run (which is being interrupted anyway) for longer than this.
 */
const COMMAND_TIMEOUT_MS = 15_000;

export type DeferredScope = SupervisorScope;

/**
 * How the deferred restart is carried out. `supervisor` restarts the systemd
 * unit that already owns the profile; `direct` schedules a self-contained
 * `alive restart` with an environment snapshot.
 */
export type DeferredStrategy = "supervisor" | "direct";

/** One row of `systemctl list-units --all --no-legend --plain --type=service`. */
export interface RestartUnit {
	unit: string;
	load: string;
	active: string;
	sub: string;
}

/** Units that exist right now, split by whether they still matter. */
export interface LingeringUnits {
	/** A restart is already on its way: `active`/`activating`/`reloading`/`refreshing`. */
	pending: RestartUnit[];
	/** Garbage from an earlier request: `inactive`/`dead`/`failed`. */
	stale: RestartUnit[];
}

const PENDING_STATES = new Set(["active", "activating", "reloading", "refreshing"]);
const STALE_STATES = new Set(["inactive", "dead", "failed"]);

/**
 * Unit name for one request. Unique per epoch second: two requests cannot
 * collide, and the timestamp makes a leftover unit traceable to its attempt.
 */
export function unitNameFor(now: Date): string {
	const seconds = Math.floor(now.getTime() / 1000);
	return `${DEFERRED_UNIT_PREFIX}${seconds}`;
}

/**
 * Parse `systemctl list-units --all --no-legend --plain --type=service <glob>`.
 *
 * Real output is whitespace-aligned columns and may still carry the `●` bullet
 * for failed units (older systemd, or without `--plain`); blank lines, the
 * `UNIT LOAD ACTIVE SUB DESCRIPTION` legend and the `N loaded units listed.`
 * footer are skipped rather than mistaken for units.
 */
export function parseUnitList(stdout: string): RestartUnit[] {
	const units: RestartUnit[] = [];
	for (const raw of stdout.split("\n")) {
		const line = raw.replace(/^[\s●*]+/, "").trim();
		if (!line) continue;
		const fields = line.split(/\s+/);
		const [unit, load, active, sub] = fields;
		if (!unit || !load || !active || !sub) continue;
		// Only service units; this also drops the legend and the footer.
		if (!unit.endsWith(".service")) continue;
		units.push({ unit, load, active, sub });
	}
	return units;
}

/** Split lingering units into "a restart is coming" and "cleaned up later". */
export function classifyLingering(units: readonly RestartUnit[]): LingeringUnits {
	const pending: RestartUnit[] = [];
	const stale: RestartUnit[] = [];
	for (const unit of units) {
		if (PENDING_STATES.has(unit.active)) pending.push(unit);
		else if (STALE_STATES.has(unit.active)) stale.push(unit);
		// Anything else (`deactivating`, unknown states) is on its way out and
		// needs neither a refusal nor a reset.
	}
	return { pending, stale };
}

/**
 * Validate the requested delay. Both spellings (`--deferred 30`,
 * `--deferred=30`, `--after 30`) end up here, so the error names the concept,
 * not one flag.
 */
export function parseDeferredAfter(value: string | undefined): { ok: true; seconds: number } | { ok: false; error: string } {
	const text = (value ?? "").trim();
	if (text === "") return { ok: true, seconds: DEFAULT_DEFERRED_AFTER_SEC };
	if (!/^\d+$/.test(text)) {
		return { ok: false, error: `deferred restart delay must be a whole number of seconds, got "${text}" (--after SECONDS)` };
	}
	const seconds = Number(text);
	if (seconds < 1 || seconds > MAX_DEFERRED_AFTER_SEC) {
		return {
			ok: false,
			error: `deferred restart delay must be between 1 and ${MAX_DEFERRED_AFTER_SEC} seconds, got ${seconds}`,
		};
	}
	return { ok: true, seconds };
}

function validateAfterSeconds(seconds: number): string | undefined {
	if (!Number.isInteger(seconds) || seconds < 1 || seconds > MAX_DEFERRED_AFTER_SEC) {
		return `deferred restart delay must be a whole number of seconds between 1 and ${MAX_DEFERRED_AFTER_SEC}, got ${seconds}`;
	}
	return undefined;
}

/** One command line, kept structured so the CLI and tests can assert on it. */
export interface DeferredCommand {
	command: string;
	args: string[];
}

export interface DeferredRestartRequest {
	scope: DeferredScope;
	afterSec: number;
	/** Clock used for the unique unit name. */
	now: Date;
	/** Node executable that runs the CLI (process.execPath). */
	execPath: string;
	/** CLI entry script (process.argv[1], resolved). */
	scriptPath: string;
	/** Loader args the entry script needs, e.g. `--import tsx` (process.execArgv). */
	execArgv?: string[];
	/** Directory the unit runs in (`--working-directory`), the caller's cwd. */
	cwd: string;
	/** Flags forwarded to the unit's own `alive restart`. */
	restartArgs?: string[];
	/** Defaults to `direct` for backward compatibility. */
	strategy?: DeferredStrategy;
	/** Required for `strategy === "supervisor"`. */
	supervisor?: SupervisorUnit;
	/** Environment snapshot file for `strategy === "direct"` (EnvironmentFile=). */
	envFile?: string;
	/** Remarks collected by the caller (e.g. ignored supervisor flags). */
	notes?: string[];
}

export interface DeferredRestartPlan {
	strategy: DeferredStrategy;
	scope: DeferredScope;
	supervisor?: SupervisorUnit;
	unit: string;
	afterSec: number;
	pending: RestartUnit[];
	stale: RestartUnit[];
	/** Non-fatal remarks, e.g. flags that a supervisor restart ignores. */
	notes: string[];
	/** `systemctl [--user] reset-failed <unit>` for every stale unit. */
	resetCommands: DeferredCommand[];
	/** The one `systemd-run` that schedules the restart. */
	startCommand: DeferredCommand;
}

function scopeArgs(scope: DeferredScope): string[] {
	return scope === "user" ? ["--user"] : [];
}

/** `--config` as it appears in the forwarded restart arguments, if at all. */
export function hasConfigArg(args: readonly string[]): boolean {
	return args.some((arg) => arg === "--config" || arg.startsWith("--config="));
}

/**
 * Replace (or add) `--config` with an absolute path. The unit's cwd alone is
 * not enough: `loadEnvFiles` then reads the profile's `.env` and the cwd `.env`
 * but never the root checkout's, which is where shared tokens live (#258).
 */
export function absoluteConfigArgs(
	args: readonly string[],
	cwd: string,
	defaultConfig = "alive.config.json",
): string[] {
	const result: string[] = [];
	let seen = false;
	for (let index = 0; index < args.length; index += 1) {
		const arg = args[index]!;
		if (arg === "--config") {
			const next = args[index + 1];
			if (next !== undefined && next !== "" && !next.startsWith("-")) {
				result.push("--config", path.resolve(cwd, next));
				index += 1;
			} else {
				result.push("--config", path.resolve(cwd, defaultConfig));
			}
			seen = true;
			continue;
		}
		if (arg.startsWith("--config=")) {
			const value = arg.slice("--config=".length) || defaultConfig;
			result.push(`--config=${path.resolve(cwd, value)}`);
			seen = true;
			continue;
		}
		result.push(arg);
	}
	if (!seen) result.push("--config", path.resolve(cwd, defaultConfig));
	return result;
}

/**
 * systemd EnvironmentFile syntax: one `KEY="value"` per line, with these
 * escapes inside the quotes. Keys systemd would not accept are dropped.
 */
export function formatEnvironmentFile(env: NodeJS.ProcessEnv): string {
	const lines: string[] = [];
	for (const key of Object.keys(env).sort()) {
		if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) continue;
		const value = env[key];
		if (value === undefined || value.includes("\0")) continue;
		lines.push(`${key}="${escapeEnvironmentValue(value)}"`);
	}
	return lines.length === 0 ? "" : `${lines.join("\n")}\n`;
}

function escapeEnvironmentValue(value: string): string {
	return value
		.replace(/\\/g, "\\\\")
		.replace(/"/g, '\\"')
		.replace(/\n/g, "\\n")
		.replace(/\r/g, "\\r")
		.replace(/\t/g, "\\t");
}

/** Flags that only make sense when the transient unit runs `alive restart`. */
const SUPERVISOR_IGNORED_FLAGS = ["--force", "--kill", "--timeout", "--model", "--verbose"] as const;

/** Flags from `args` that a supervisor restart cannot apply. */
export function supervisorIgnoredFlags(args: readonly string[]): string[] {
	const found = new Set<string>();
	for (const arg of args) {
		for (const flag of SUPERVISOR_IGNORED_FLAGS) {
			if (arg === flag || arg.startsWith(`${flag}=`)) found.add(flag);
		}
	}
	return [...found];
}

/** Pure planning step: no command runs, everything is decided from `units`. */
export function planDeferredRestart(request: DeferredRestartRequest, units: readonly RestartUnit[]): DeferredRestartPlan {
	const { pending, stale } = classifyLingering(units);
	const strategy = request.strategy ?? "direct";
	const unit = unitNameFor(request.now);
	let startCommand: DeferredCommand;

	if (strategy === "supervisor" && request.supervisor) {
		startCommand = {
			command: "systemd-run",
			args: [
				...scopeArgs(request.scope),
				`--on-active=${request.afterSec}`,
				"--collect",
				`--unit=${unit}`,
				"systemctl",
				...scopeArgs(request.supervisor.scope),
				"restart",
				request.supervisor.unit,
			],
		};
	} else {
		const args = [
			...scopeArgs(request.scope),
			`--on-active=${request.afterSec}`,
			"--collect",
			`--working-directory=${request.cwd}`,
			`--unit=${unit}`,
		];
		if (request.envFile) {
			args.push(`--property=EnvironmentFile=${request.envFile}`);
			args.push(`--property=ExecStopPost=/bin/rm -f ${request.envFile}`);
		}
		args.push(
			`--setenv=${DEFERRED_RESTART_ENV_MARKER}=${unit}`,
			request.execPath,
			...(request.execArgv ?? []),
			request.scriptPath,
			"restart",
			...absoluteConfigArgs(request.restartArgs ?? [], request.cwd),
		);
		startCommand = { command: "systemd-run", args };
	}

	return {
		strategy,
		scope: request.scope,
		...(request.strategy === "supervisor" && request.supervisor ? { supervisor: request.supervisor } : {}),
		unit,
		afterSec: request.afterSec,
		pending,
		stale,
		notes: [...(request.notes ?? [])],
		resetCommands: stale.map((entry) => ({
			command: "systemctl",
			args: [...scopeArgs(request.scope), "reset-failed", entry.unit],
		})),
		startCommand,
	};
}

export interface DeferredRestartOptions {
	afterSec: number;
	scope: DeferredScope;
	restartArgs?: string[];
	/** Defaults to `process.cwd()`. */
	cwd?: string;
	/** Defaults: `process.execPath`, `process.argv[1]`, `process.execArgv`. */
	execPath?: string;
	scriptPath?: string;
	execArgv?: string[];
	/** Harness pid from `runtime.json`, used to confirm the supervisor unit. */
	harnessPid?: number;
	/** Profile state directory; receives the direct-mode environment snapshot. */
	stateDir?: string;
	/** Environment to snapshot in direct mode; defaults to `process.env`. */
	env?: NodeJS.ProcessEnv;
	/** Test seam replacing `/proc/<pid>/cgroup`. */
	cgroupText?: string;
	/** Override the directory of the direct-mode environment snapshot. */
	envFileDir?: string;
}

export interface DeferredRestartDeps {
	run: CommandRunner;
	now?: () => Date;
	/** Test seam for supervisor detection through the CLI. */
	cgroupText?: string;
}

export type DeferredRestartOutcome = "started" | "blocked" | "failed";

export interface DeferredRestartResult {
	outcome: DeferredRestartOutcome;
	/** Which strategy the restart was planned with. */
	strategy: DeferredStrategy;
	/** The confirmed supervisor, when `strategy === "supervisor"`. */
	supervisor?: SupervisorUnit;
	scope: DeferredScope;
	afterSec: number;
	/** The unique unit name, when planning got that far. */
	unit?: string;
	/** A restart was already on its way (`blocked`). */
	pending: RestartUnit[];
	/** Lingering units found before this request. */
	stale: RestartUnit[];
	/** Stale units actually cleaned up with `reset-failed`. */
	reset: RestartUnit[];
	/** Non-fatal problems (a failed reset is a warning, never fatal). */
	warnings: string[];
	/** Non-fatal remarks, e.g. flags a supervisor restart ignores. */
	notes: string[];
	/** Set when `outcome === "failed"`. */
	error?: string;
}

/** The CLI entry script of *this* process, the way `spawnBackground` re-execs it. */
export function selfScriptPath(): string | undefined {
	const entry = process.argv[1];
	if (!entry) return undefined;
	return path.resolve(entry);
}

/**
 * Schedule the restart: inspect lingering units, clean the stale ones, start
 * one `--collect` unit. Every failure is reported as data; nothing throws, so
 * the CLI can print a clear message and exit non-zero.
 */
export async function runDeferredRestart(
	options: DeferredRestartOptions,
	deps: DeferredRestartDeps,
): Promise<DeferredRestartResult> {
	const scope = options.scope;
	const invalid = validateAfterSeconds(options.afterSec);
	const result: DeferredRestartResult = {
		outcome: "failed",
		strategy: "direct",
		scope,
		afterSec: options.afterSec,
		pending: [],
		stale: [],
		reset: [],
		warnings: [],
		notes: [],
	};
	if (invalid) return { ...result, error: invalid };

	const scriptPath = options.scriptPath ?? selfScriptPath();
	if (!scriptPath) {
		return {
			...result,
			error: "cannot locate the alive entry script (process.argv[1] is empty); start the CLI as `node dist/index.js` or `tsx src/index.ts`",
		};
	}

	const cwd = options.cwd ?? process.cwd();
	const now = (deps.now ?? (() => new Date()))();

	// 0. Detection: a confirmed supervisor unit decides the whole strategy.
	//    It runs before any restart command; a fallback only adds a warning.
	const detection = await detectSupervisorUnit({
		run: deps.run,
		readCgroup: options.cgroupText === undefined ? undefined : () => options.cgroupText,
		harnessPid: options.harnessPid,
	});
	result.strategy = detection.strategy;
	if (detection.supervisor) result.supervisor = detection.supervisor;
	if (detection.warning) result.warnings.push(detection.warning);

	const restartArgs = options.restartArgs ?? [];
	if (detection.strategy === "supervisor" && detection.supervisor) {
		const supervisor = detection.supervisor;
		if (supervisor.scope !== scope) {
			return {
				...result,
				error:
					supervisor.scope === "user"
						? `the profile is supervised by a user unit (${supervisor.unit}); rerun with --user`
						: `the profile is supervised by a system unit (${supervisor.unit}); drop --user`,
			};
		}
		if (hasConfigArg(restartArgs)) {
			return {
				...result,
				error: `--config cannot be forwarded when the profile is supervised by ${supervisor.unit}: the supervisor determines the profile and its environment; rerun without --config (or from the target profile's directory)`,
			};
		}
		const ignored = supervisorIgnoredFlags(restartArgs);
		if (ignored.length > 0) {
			result.notes.push(
				`ignored with a supervisor unit: ${ignored.join(", ")} (systemctl restart takes them from ${supervisor.unit})`,
			);
		}
	}

	// 1. Inspect: a pending unit means a restart is already scheduled.
	const listArgs = [...scopeArgs(scope), "list-units", "--all", "--no-legend", "--plain", "--type=service", DEFERRED_UNIT_PATTERN];
	let listing: string;
	try {
		const { stdout } = await deps.run("systemctl", listArgs, { timeoutMs: COMMAND_TIMEOUT_MS });
		listing = stdout;
	} catch (error) {
		return {
			...result,
			error: `could not list ${DEFERRED_UNIT_PATTERN} units (systemctl ${listArgs.join(" ")}: ${oneLine(errorMessage(error))}); nothing was started`,
		};
	}

	const request: DeferredRestartRequest = {
		scope,
		afterSec: options.afterSec,
		now,
		execPath: options.execPath ?? process.execPath,
		scriptPath,
		execArgv: options.execArgv ?? process.execArgv,
		cwd,
		restartArgs,
		strategy: detection.strategy,
		...(detection.supervisor ? { supervisor: detection.supervisor } : {}),
		notes: result.notes,
	};
	const units = parseUnitList(listing);
	const basePlan = planDeferredRestart(request, units);

	// 2. A pending unit: refuse before touching anything (no reset either, so the
	//    operator can see the garbage exactly as it was).
	if (basePlan.pending.length > 0) {
		return { ...result, outcome: "blocked", unit: basePlan.unit, pending: basePlan.pending, stale: basePlan.stale };
	}

	// 3. Clean up units left behind by earlier requests. Best effort: a failure
	//    here must never stop the restart the operator asked for.
	const reset: RestartUnit[] = [];
	for (const unit of basePlan.stale) {
		const command = basePlan.resetCommands.find((candidate) => candidate.args.at(-1) === unit.unit);
		if (!command) continue;
		try {
			await deps.run(command.command, command.args, { timeoutMs: COMMAND_TIMEOUT_MS });
			reset.push(unit);
		} catch (error) {
			result.warnings.push(`could not reset ${unit.unit} (${oneLine(errorMessage(error))}); continuing`);
		}
	}

	// 4. Direct strategy: snapshot the caller's environment. Written only now,
	//    after the pending refusal, so a refused request leaves no file behind.
	let plan = basePlan;
	let envSnapshot: string | undefined;
	if (basePlan.strategy === "direct") {
		const envFile = path.join(options.envFileDir ?? options.stateDir ?? os.tmpdir(), `${basePlan.unit}.env`);
		try {
			fs.writeFileSync(envFile, formatEnvironmentFile(options.env ?? process.env), { mode: 0o600 });
			envSnapshot = envFile;
			plan = planDeferredRestart({ ...request, envFile }, units);
		} catch (error) {
			result.warnings.push(
				`could not write the environment snapshot ${envFile} (${oneLine(errorMessage(error))}); the unit will start without EnvironmentFile`,
			);
		}
	}

	// 5. Start the one-shot unit.
	try {
		await deps.run(plan.startCommand.command, plan.startCommand.args, { timeoutMs: COMMAND_TIMEOUT_MS });
	} catch (error) {
		if (envSnapshot) {
			try {
				fs.rmSync(envSnapshot, { force: true });
			} catch {
				// Best effort: the unit never started, the file is only a snapshot.
			}
		}
		return {
			...result,
			outcome: "failed",
			unit: plan.unit,
			stale: plan.stale,
			reset,
			// The start args carry the EnvironmentFile paths; keep enough of the
			// command in the error for the underlying reason to survive oneLine.
			error: `systemd-run failed (${oneLine(errorMessage(error), 1000)}); no restart was scheduled`,
		};
	}

	return {
		...result,
		outcome: "started",
		strategy: plan.strategy,
		...(plan.supervisor ? { supervisor: plan.supervisor } : {}),
		unit: plan.unit,
		pending: [],
		stale: plan.stale,
		reset,
	};
}

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

