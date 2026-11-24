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
 * Scope: the default is the system manager, the same scope the printed advice
 * has always used. `--user` switches both `systemctl` and `systemd-run` to the
 * user manager for setups where the harness runs as a user service.
 */
import * as path from "node:path";
import { oneLine } from "../util.js";
import type { CommandRunner } from "../update.js";

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

export type DeferredScope = "system" | "user";

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
	/** Flags forwarded to the unit's own `alive restart`. */
	restartArgs?: string[];
}

export interface DeferredRestartPlan {
	scope: DeferredScope;
	unit: string;
	afterSec: number;
	pending: RestartUnit[];
	stale: RestartUnit[];
	/** `systemctl [--user] reset-failed <unit>` for every stale unit. */
	resetCommands: DeferredCommand[];
	/** `systemd-run [--user] --on-active=N --collect --unit=<unit> node <script> restart …`. */
	startCommand: DeferredCommand;
}

function scopeArgs(scope: DeferredScope): string[] {
	return scope === "user" ? ["--user"] : [];
}

/** Pure planning step: no command runs, everything is decided from `units`. */
export function planDeferredRestart(request: DeferredRestartRequest, units: readonly RestartUnit[]): DeferredRestartPlan {
	const { pending, stale } = classifyLingering(units);
	return {
		scope: request.scope,
		unit: unitNameFor(request.now),
		afterSec: request.afterSec,
		pending,
		stale,
		resetCommands: stale.map((unit) => ({
			command: "systemctl",
			args: [...scopeArgs(request.scope), "reset-failed", unit.unit],
		})),
		startCommand: {
			command: "systemd-run",
			args: [
				...scopeArgs(request.scope),
				`--on-active=${request.afterSec}`,
				"--collect",
				`--unit=${unitNameFor(request.now)}`,
				request.execPath,
				...(request.execArgv ?? []),
				request.scriptPath,
				"restart",
				...(request.restartArgs ?? []),
			],
		},
	};
}

export interface DeferredRestartOptions {
	afterSec: number;
	scope: DeferredScope;
	restartArgs?: string[];
	/** Defaults: `process.execPath`, `process.argv[1]`, `process.execArgv`. */
	execPath?: string;
	scriptPath?: string;
	execArgv?: string[];
}

export interface DeferredRestartDeps {
	run: CommandRunner;
	now?: () => Date;
}

export type DeferredRestartOutcome = "started" | "blocked" | "failed";

export interface DeferredRestartResult {
	outcome: DeferredRestartOutcome;
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
		scope,
		afterSec: options.afterSec,
		pending: [],
		stale: [],
		reset: [],
		warnings: [],
	};
	if (invalid) return { ...result, error: invalid };

	const scriptPath = options.scriptPath ?? selfScriptPath();
	if (!scriptPath) {
		return {
			...result,
			error: "cannot locate the alive entry script (process.argv[1] is empty); start the CLI as `node dist/index.js` or `tsx src/index.ts`",
		};
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

	const now = (deps.now ?? (() => new Date()))();
	const plan = planDeferredRestart(
		{
			scope,
			afterSec: options.afterSec,
			now,
			execPath: options.execPath ?? process.execPath,
			scriptPath,
			execArgv: options.execArgv ?? process.execArgv,
			restartArgs: options.restartArgs ?? [],
		},
		parseUnitList(listing),
	);

	// 2. A pending unit: refuse before touching anything (no reset either, so the
	//    operator can see the garbage exactly as it was).
	if (plan.pending.length > 0) {
		return { ...result, outcome: "blocked", unit: plan.unit, pending: plan.pending, stale: plan.stale };
	}

	// 3. Clean up units left behind by earlier requests. Best effort: a failure
	//    here must never stop the restart the operator asked for.
	const reset: RestartUnit[] = [];
	for (const unit of plan.stale) {
		const command = plan.resetCommands.find((candidate) => candidate.args.at(-1) === unit.unit);
		if (!command) continue;
		try {
			await deps.run(command.command, command.args, { timeoutMs: COMMAND_TIMEOUT_MS });
			reset.push(unit);
		} catch (error) {
			result.warnings.push(`could not reset ${unit.unit} (${oneLine(errorMessage(error))}); continuing`);
		}
	}

	// 4. Start the one-shot unit.
	try {
		await deps.run(plan.startCommand.command, plan.startCommand.args, { timeoutMs: COMMAND_TIMEOUT_MS });
	} catch (error) {
		return {
			...result,
			outcome: "failed",
			unit: plan.unit,
			stale: plan.stale,
			reset,
			error: `systemd-run failed (${oneLine(errorMessage(error))}); no restart was scheduled`,
		};
	}

	return { outcome: "started", scope, afterSec: plan.afterSec, unit: plan.unit, pending: [], stale: plan.stale, reset, warnings: result.warnings };
}

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

