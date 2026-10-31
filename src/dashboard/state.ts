/**
 * Read-only view over an alive profile's on-disk state.
 *
 * Nothing here writes: this layer is a pure read model over
 * `runs/runs.jsonl`, `reminders.json`, `usage.json`,
 * `runtime.json`, `inbox/events.jsonl` and the pi `sessions/*.jsonl` transcripts.
 * The dashboard's single write path lives in `settings.ts`.
 *
 * The shapes below mirror the files that exist today (see `src/store/*` and
 * `src/runtime/agent.ts`); when a file is missing the view degrades to an
 * explicit note instead of guessing.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { DEFAULT_CONTRACT, loadConfig, type LoadedConfig } from "../config.js";
import { buildSystemPrompt } from "../runtime/prompt.js";
import type { AliveEvent } from "../store/events.js";
import type { Reminder } from "../store/reminders.js";
import {
	RUN_TURN_TRACE_LIMIT,
	runTurnCount,
	type RunRecord,
	type RunStopReason,
	type RunUsage,
	type RuntimeStateFile,
	type UsageBucket,
} from "../store/runs.js";
import { formatDuration, isProcessAlive, localDay, oneLine, readJson, readJsonl } from "../util.js";

/** The root profile is always addressable as `main` (same id local agent messaging uses). */
export const ROOT_AGENT_ID = "main";

const AGENT_ID_RE = /^[a-z0-9][a-z0-9_-]{0,47}$/;

export function isValidAgentId(id: string): boolean {
	return AGENT_ID_RE.test(id);
}

export interface DashboardProfile {
	id: string;
	name: string;
	profileDir: string;
	configPath: string;
	stateDir: string;
	config: LoadedConfig;
}

export interface DashboardRootOptions {
	rootDir: string;
	configPath?: string;
}

/** Load the root config (never migrating secrets: that would write `.env`). */
export function loadRootConfig(options: DashboardRootOptions): LoadedConfig {
	return loadConfig({
		cwd: options.rootDir,
		configPath: options.configPath,
		migrateSecrets: false,
	});
}

export function loadDashboard(rootConfig: LoadedConfig): DashboardProfile[] {
	const profiles: DashboardProfile[] = [toProfile(ROOT_AGENT_ID, rootConfig)];
	for (const agent of listManagedAgentConfigs(rootConfig)) {
		// The root profile owns the `main` id; a managed agent with the same id is shadowed.
		if (agent.id === ROOT_AGENT_ID) continue;
		try {
			const loaded = loadConfig({ cwd: agent.directory, configPath: agent.configPath, migrateSecrets: false });
			profiles.push(toProfile(agent.id, loaded));
		} catch {
			// A broken managed profile must not take the whole dashboard down.
		}
	}
	return profiles;
}

export function findProfile(profiles: DashboardProfile[], idInput: string): DashboardProfile | undefined {
	const id = idInput.trim().toLowerCase();
	return profiles.find((profile) => profile.id === id);
}

function toProfile(id: string, config: LoadedConfig): DashboardProfile {
	return {
		id,
		name: config.config.name?.trim() || id,
		profileDir: config.paths.rootDir,
		configPath: config.paths.configPath,
		stateDir: config.paths.stateDir,
		config,
	};
}

/** `agentsRoot()` from `src/agents.ts`, duplicated read-only to avoid its write paths. */
function agentsRoot(config: LoadedConfig): string {
	const configured = config.config.agentsDirectory.trim();
	return configured ? path.resolve(config.paths.rootDir, configured) : path.join(config.paths.stateDir, "agents");
}

function listManagedAgentConfigs(config: LoadedConfig): Array<{ id: string; directory: string; configPath: string }> {
	const root = agentsRoot(config);
	let entries: fs.Dirent[];
	try {
		entries = fs.readdirSync(root, { withFileTypes: true });
	} catch {
		return [];
	}
	return entries
		.filter((entry) => entry.isDirectory() && AGENT_ID_RE.test(entry.name))
		.map((entry) => ({
			id: entry.name,
			directory: path.join(root, entry.name),
			configPath: path.join(root, entry.name, "alive.config.json"),
		}))
		.filter((agent) => fs.existsSync(agent.configPath));
}

// ---------------------------------------------------------------------------
// run records
// ---------------------------------------------------------------------------

export function readRunRecords(stateDir: string): RunRecord[] {
	return readJsonl<RunRecord>(path.join(stateDir, "runs", "runs.jsonl"));
}

export type RunOutcomeClass = "sleep" | "idle" | "error";

export interface RunOutcome {
	/** Stable machine key used for CSS classes and tests. */
	key: RunOutcomeClass;
	label: string;
}

/**
 * Collapse the stored stop reason into the three outcomes the dashboard shows.
 *
 * `slept` is a sleep (context reset), `stalled` means the model stopped without
 * idling (the run ended because it refused to wait), everything safety-related
 * is an error from the operator's point of view.
 */
export function runOutcome(stopReason: RunStopReason): RunOutcome {
	switch (stopReason) {
		case "slept":
			return { key: "sleep", label: "sleep (context reset)" };
		case "stalled":
			return { key: "idle", label: "idle (stopped without idling)" };
		case "timeout":
			return { key: "error", label: "error: active-time limit" };
		case "budget":
			return { key: "error", label: "error: budget exhausted" };
		case "aborted":
			return { key: "error", label: "error: aborted" };
		default:
			return { key: "error", label: "error" };
	}
}

export interface RunTrigger {
	seq: number;
	kind: string;
	thread?: string;
	title: string;
	redelivered?: boolean;
}

export type RunUsageView = RunUsage;

export interface RunStepView {
	index: number;
	startedAt: number;
	durationMs: number;
	usage: RunUsageView;
	tools: string[];
}

function finiteNumber(value: unknown): number | undefined {
	return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function usageView(value: unknown): RunUsageView {
	const fields = value && typeof value === "object" ? (value as Record<string, unknown>) : {};
	return {
		input: finiteNumber(fields.input) ?? 0,
		output: finiteNumber(fields.output) ?? 0,
		cacheRead: finiteNumber(fields.cacheRead) ?? 0,
		cacheWrite: finiteNumber(fields.cacheWrite) ?? 0,
		total: finiteNumber(fields.total) ?? 0,
		cost: finiteNumber(fields.cost) ?? 0,
	};
}

/**
 * Sanitize the stored per-turn traces.
 *
 * Returns `undefined` when the record has no usable `turns` array (an old run,
 * or a malformed field). Individual malformed entries are skipped instead of
 * turning into zero-cost steps; the dashboard must show "not recorded" rather
 * than invented numbers.
 */
export function toRunStepViews(value: unknown): RunStepView[] | undefined {
	if (!Array.isArray(value)) return undefined;
	const steps: RunStepView[] = [];
	for (const entry of value) {
		if (!entry || typeof entry !== "object") continue;
		const record = entry as Record<string, unknown>;
		// A step without a usage object has nothing to show; skipping it keeps
		// the step table honest about what was recorded.
		if (!record.usage || typeof record.usage !== "object") continue;
		const index = finiteNumber(record.index);
		steps.push({
			index: index === undefined ? steps.length + 1 : Math.max(1, Math.trunc(index)),
			startedAt: finiteNumber(record.startedAt) ?? 0,
			durationMs: Math.max(0, finiteNumber(record.durationMs) ?? 0),
			usage: usageView(record.usage),
			tools: Array.isArray(record.tools)
				? record.tools.filter((tool): tool is string => typeof tool === "string")
				: [],
		});
	}
	steps.sort((left, right) => left.index - right.index);
	return steps;
}

export interface RunView {
	id: string;
	index: number;
	startedAt: number;
	finishedAt: number;
	durationMs: number;
	activeMs: number;
	idleMs: number;
	stopReason: RunStopReason;
	outcome: RunOutcome;
	error?: string;
	turns: number;
	/** Per-turn usage from the run record; `undefined` when it was not recorded. */
	steps?: RunStepView[];
	promptChars: number;
	usage: RunUsageView;
	nudges: number;
	idleReturns: number;
	interruptDeliveries: number;
	triggers: RunTrigger[];
	outboundCount: number;
	remindersCreated: string[];
	notesTouched: string[];
	journalEntries: number;
	sleep?: { forced: boolean; summaryChars: number };
}

export function toRunView(record: RunRecord): RunView {
	const usage = record.usage ?? { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0, cost: 0 };
	return {
		id: record.id,
		index: record.index,
		startedAt: record.startedAt,
		finishedAt: record.finishedAt,
		durationMs: record.durationMs,
		activeMs: record.activeMs,
		idleMs: record.idleMs,
		stopReason: record.stopReason,
		outcome: runOutcome(record.stopReason),
		error: record.error,
		turns: runTurnCount(record),
		steps: toRunStepViews(record.turns),
		promptChars: record.promptChars,
		usage: {
			input: usage.input ?? 0,
			output: usage.output ?? 0,
			cacheRead: usage.cacheRead ?? 0,
			cacheWrite: usage.cacheWrite ?? 0,
			total: usage.total ?? 0,
			cost: usage.cost ?? 0,
		},
		nudges: record.nudges ?? 0,
		idleReturns: record.idleReturns ?? 0,
		interruptDeliveries: record.interruptDeliveries ?? 0,
		triggers: (record.events ?? []).map((event) => ({
			seq: event.seq,
			kind: event.kind,
			thread: event.thread,
			title: event.title,
			redelivered: event.redelivered,
		})),
		outboundCount: (record.outbound ?? []).length,
		remindersCreated: record.remindersCreated ?? [],
		notesTouched: record.notesTouched ?? [],
		journalEntries: record.journalEntries ?? 0,
		sleep: record.sleep,
	};
}

export interface RunTotals {
	runs: number;
	turns: number;
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
	total: number;
	cost: number;
	durationMs: number;
	activeMs: number;
	idleMs: number;
}

export function sumRuns(runs: RunView[]): RunTotals {
	const totals: RunTotals = {
		runs: 0,
		turns: 0,
		input: 0,
		output: 0,
		cacheRead: 0,
		cacheWrite: 0,
		total: 0,
		cost: 0,
		durationMs: 0,
		activeMs: 0,
		idleMs: 0,
	};
	for (const run of runs) {
		totals.runs += 1;
		totals.turns += run.turns;
		totals.input += run.usage.input;
		totals.output += run.usage.output;
		totals.cacheRead += run.usage.cacheRead;
		totals.cacheWrite += run.usage.cacheWrite;
		totals.total += run.usage.total;
		totals.cost += run.usage.cost;
		totals.durationMs += run.durationMs;
		totals.activeMs += run.activeMs;
		totals.idleMs += run.idleMs;
	}
	return totals;
}

// ---------------------------------------------------------------------------
// per-turn / per-step usage (#121)
// ---------------------------------------------------------------------------

/** Tolerance when comparing a step sum against the run aggregate (floating cents). */
export const RUN_STEP_COST_EPSILON = 1e-6;

export interface RunStepsView {
	/** True when the run record carried a usable per-turn trace. */
	recorded: boolean;
	/** Recorded steps, oldest first. Empty when nothing was recorded. */
	steps: RunStepView[];
	/** Turn count stored on the record (known even for old runs). */
	turnCount: number;
	/** First/last absolute turn index in the stored trace (null when empty). */
	firstIndex: number | null;
	lastIndex: number | null;
	/** True when only the last turns were kept, so the sum covers a window. */
	truncated: boolean;
	/** Sum of the recorded steps. All zeros when nothing was recorded. */
	sum: RunUsageView;
	/** The run's own aggregate usage from `runs.jsonl`. */
	aggregate: RunUsageView;
	/** True when the recorded sum does not match the aggregate. */
	mismatch: boolean;
	/** True when sums exist but only cover part of the run (bounded trace). */
	partial: boolean;
	/** `cacheRead / (input + cacheRead)` over the run aggregate, or null when there is no input. */
	cacheHitRate: number | null;
	/** Up to three recorded steps with the highest step cost. */
	top: RunStepView[];
	/** Honest notes shown above the table. */
	notes: string[];
}

function emptyUsageView(): RunUsageView {
	return { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0, cost: 0 };
}

function addUsage(target: RunUsageView, usage: RunUsageView): void {
	target.input += usage.input;
	target.output += usage.output;
	target.cacheRead += usage.cacheRead;
	target.cacheWrite += usage.cacheWrite;
	target.total += usage.total;
	target.cost += usage.cost;
}

/** `cacheRead / (input + cacheRead)`, the usual cache hit rate; null when there is no prompt tokens. */
export function cacheHitRate(usage: RunUsageView): number | null {
	const prompt = usage.input + usage.cacheRead;
	if (prompt <= 0) return null;
	return usage.cacheRead / prompt;
}

export function formatRate(rate: number | null): string {
	if (rate === null || !Number.isFinite(rate)) return "—";
	return `${(rate * 100).toFixed(1)}%`;
}

/**
 * Build the per-step view for a run page.
 *
 * The sum check compares the recorded steps with the run's aggregate `usage`.
 * A mismatch is surfaced (`mismatch: true`), never hidden or corrected. Old runs
 * have no trace at all: `recorded` is false and the page shows `—` per step.
 */
export function buildRunSteps(
	run: Pick<RunView, "turns" | "steps" | "usage">,
): RunStepsView {
	const aggregate: RunUsageView = { ...run.usage };
	const notes: string[] = [];
	const steps = run.steps;
	const rate = cacheHitRate(aggregate);
	if (!steps) {
		notes.push(
			"per-turn usage was not recorded for this run (records written before issue #121 store only the aggregate); " +
				"the step rows show — and no numbers are reconstructed",
		);
		return {
			recorded: false,
			steps: [],
			turnCount: run.turns,
			firstIndex: null,
			lastIndex: null,
			truncated: false,
			sum: emptyUsageView(),
			aggregate,
			mismatch: false,
			partial: false,
			cacheHitRate: rate,
			top: [],
			notes,
		};
	}

	const sum = emptyUsageView();
	for (const step of steps) addUsage(sum, step.usage);
	const firstIndex = steps.length > 0 ? steps[0]!.index : null;
	const lastIndex = steps.length > 0 ? steps[steps.length - 1]!.index : null;
	const truncated = firstIndex !== null && firstIndex > 1;
	const partial = truncated;
	const mismatch = !truncated && (
		sum.input !== aggregate.input ||
		sum.output !== aggregate.output ||
		sum.cacheRead !== aggregate.cacheRead ||
		sum.cacheWrite !== aggregate.cacheWrite ||
		sum.total !== aggregate.total ||
		Math.abs(sum.cost - aggregate.cost) > RUN_STEP_COST_EPSILON
	);

	notes.push("per-turn usage was recorded by the runtime from the pi session's turn events (turn_start/turn_end)");
	notes.push(
		"the run aggregate also counts provider usage from compaction/branch summaries and tool executions, " +
			"which belong to no turn; such a difference is shown below as a mismatch, never corrected",
	);
	if (truncated) {
		notes.push(
			`the trace is bounded to the last ${RUN_TURN_TRACE_LIMIT} turns: stored turns ${firstIndex}–${lastIndex}, ` +
				"so the step sums cover only this window and cannot be compared with the run aggregate",
		);
	}
	if (steps.length === 0 && run.turns > 0) {
		notes.push(`the record lists ${run.turns} turn(s) but stored no usable per-turn usage`);
	}
	if (!truncated && steps.length > 0 && run.turns > 0 && steps.length !== run.turns) {
		notes.push(`the record counts ${run.turns} turn(s) but the trace has ${steps.length} step(s)`);
	}
	if (mismatch) {
		notes.push("the step sum does not match the run aggregate; both are shown below unchanged");
	}

	const top = [...steps]
		.sort((left, right) => right.usage.cost - left.usage.cost || left.index - right.index)
		.slice(0, 3);

	return {
		recorded: true,
		steps,
		turnCount: run.turns,
		firstIndex,
		lastIndex,
		truncated,
		sum,
		aggregate,
		mismatch,
		partial,
		cacheHitRate: rate,
		top,
		notes,
	};
}

// ---------------------------------------------------------------------------
// usage / runtime / reminders / events
// ---------------------------------------------------------------------------

const EMPTY_USAGE: UsageBucket = { cost: 0, runs: 0, turns: 0, input: 0, output: 0 };

/**
 * Spend for the local day. `usage.json` is the runtime's own counter; when it
 * is absent (older state or a fixture) fall back to summing today's run records.
 */
export function readUsageToday(stateDir: string, now = Date.now()): UsageBucket {
	const day = localDay(now);
	const usage = readJson<{ days?: Record<string, UsageBucket> } | null>(path.join(stateDir, "usage.json"), null);
	const recorded = usage && usage.days && typeof usage.days === "object" ? usage.days[day] : undefined;
	if (recorded) return recorded;
	// No counter for today: a fresh/older state dir still has today's run records.
	const bucket: UsageBucket = { ...EMPTY_USAGE };
	for (const record of readRunRecords(stateDir)) {
		if (localDay(record.finishedAt) !== day) continue;
		bucket.cost += record.usage?.cost ?? 0;
		bucket.runs += 1;
		bucket.turns += runTurnCount(record);
		bucket.input += record.usage?.input ?? 0;
		bucket.output += record.usage?.output ?? 0;
	}
	return bucket;
}

// ---------------------------------------------------------------------------
// cost / run trend (#121, slice 3)
// ---------------------------------------------------------------------------

export const COST_TREND_DAYS = 14;

export interface CostTrendDayView {
	/** Local calendar day, `YYYY-MM-DD`. */
	day: string;
	runs: number;
	cost: number;
	/** `cost / runs`; null on a day with no runs. */
	avgCostPerRun: number | null;
	/** Where this row came from: the runtime counter or a runs.jsonl fallback. */
	source: "usage.json" | "runs.jsonl" | "none";
}

export interface CostTrendView {
	days: CostTrendDayView[];
	totalCost: number;
	totalRuns: number;
	avgCostPerRun: number | null;
	maxDayCost: number;
	notes: string[];
}

/** `usage.json`'s `days` map, or an empty object when the file is absent. */
export function readUsageDays(stateDir: string): Record<string, UsageBucket> {
	const usage = readJson<{ days?: Record<string, UsageBucket> } | null>(path.join(stateDir, "usage.json"), null);
	const days = usage?.days;
	return days && typeof days === "object" ? days : {};
}

/** Local calendar day `offset` days before `now` (noon avoids DST edge cases). */
function localDayBefore(now: number, offset: number): string {
	const date = new Date(now);
	date.setDate(date.getDate() - offset);
	date.setHours(12, 0, 0, 0);
	return localDay(date.getTime());
}

/**
 * Daily cost/run trend for the last `days` local days, oldest first.
 *
 * `usage.json` is the runtime's own counter and wins when it has a bucket for
 * the day. Days it does not cover are summed from `runs.jsonl`; a day with no
 * runs either way is shown as 0 runs / $0.0000 with an average of `—`, never
 * filled in from another day.
 */
export function buildCostTrend(
	profile: Pick<DashboardProfile, "stateDir">,
	options: { now?: number; days?: number } = {},
): CostTrendView {
	const now = options.now ?? Date.now();
	const dayCount = Math.max(1, Math.trunc(options.days ?? COST_TREND_DAYS));
	const usageDays = readUsageDays(profile.stateDir);
	const recordsByDay = new Map<string, RunRecord[]>();
	for (const record of readRunRecords(profile.stateDir)) {
		const day = localDay(record.finishedAt);
		const dayRecords = recordsByDay.get(day);
		if (dayRecords) dayRecords.push(record);
		else recordsByDay.set(day, [record]);
	}
	const days: CostTrendDayView[] = [];
	for (let offset = dayCount - 1; offset >= 0; offset -= 1) {
		const day = localDayBefore(now, offset);
		const bucket = usageDays[day];
		const dayRecords = recordsByDay.get(day) ?? [];
		let runs: number;
		let cost: number;
		let source: CostTrendDayView["source"];
		if (bucket) {
			runs = bucket.runs;
			cost = bucket.cost;
			source = "usage.json";
		} else if (dayRecords.length > 0) {
			runs = dayRecords.length;
			cost = dayRecords.reduce((total, record) => total + (record.usage?.cost ?? 0), 0);
			source = "runs.jsonl";
		} else {
			runs = 0;
			cost = 0;
			source = "none";
		}
		days.push({
			day,
			runs,
			cost,
			avgCostPerRun: runs > 0 ? cost / runs : null,
			source,
		});
	}
	const totalCost = days.reduce((total, day) => total + day.cost, 0);
	const totalRuns = days.reduce((total, day) => total + day.runs, 0);
	const notes: string[] = [
		`cost and run counts come from usage.json when it has a bucket for the day; other days are summed from runs.jsonl`,
		"a day with no runs is shown as 0 runs and $0.0000 with an average of —; nothing is interpolated",
	];
	if (Object.keys(usageDays).length === 0) {
		notes.push("usage.json is missing or empty: every day is summed from runs.jsonl");
	}
	return {
		days,
		totalCost,
		totalRuns,
		avgCostPerRun: totalRuns > 0 ? totalCost / totalRuns : null,
		maxDayCost: days.reduce((max, day) => Math.max(max, day.cost), 0),
		notes,
	};
}

export function readRuntimeStateFile(stateDir: string): RuntimeStateFile | null {
	return readJson<RuntimeStateFile | null>(path.join(stateDir, "runtime.json"), null);
}

export function readReminders(stateDir: string): Reminder[] {
	const reminders = readJson<Reminder[] | null>(path.join(stateDir, "reminders.json"), null);
	return Array.isArray(reminders) ? reminders : [];
}

export function readInboxEvents(stateDir: string): AliveEvent[] {
	return readJsonl<AliveEvent>(path.join(stateDir, "inbox", "events.jsonl"));
}

// ---------------------------------------------------------------------------
// agents list
// ---------------------------------------------------------------------------

export type AgentStatus = "working" | "waiting" | "sleeping";

export interface AgentStatusView {
	status: AgentStatus;
	note: string;
}

export interface DeriveStatusOptions {
	now?: number;
	/** Seam for tests: defaults to the real `isProcessAlive` check. */
	pidAlive?: (pid: number) => boolean;
}

/**
 * Map `runtime.json` onto the three states the issue asks for.
 *
 * working = a run is in progress; waiting = blocked in `idle` (or paused by the
 * budget); sleeping = no live runtime, i.e. the agent is between lives and its
 * context is gone.
 */
export function deriveAgentStatus(
	runtime: RuntimeStateFile | null,
	options: DeriveStatusOptions = {},
): AgentStatusView {
	if (!runtime) return { status: "sleeping", note: "no runtime state" };
	const alive = (options.pidAlive ?? isProcessAlive)(runtime.pid);
	if (!alive) return { status: "sleeping", note: runtime.status === "stopped" ? "runtime stopped" : "process is not running" };
	if (runtime.status === "paused-budget") return { status: "waiting", note: "paused: budget" };
	if (runtime.idling || runtime.status === "idle") {
		const now = options.now ?? Date.now();
		const since = runtime.idleSince ? ` since ${new Date(runtime.idleSince).toISOString()}` : "";
		const waited = runtime.idleSince ? `, ${formatDuration(now - runtime.idleSince)}` : "";
		return { status: "waiting", note: `idle${since}${waited}` };
	}
	if (runtime.status === "starting") return { status: "working", note: "starting" };
	return { status: "working", note: `run #${runtime.runIndex}` };
}

export interface AgentSummary {
	id: string;
	name: string;
	model: string;
	status: AgentStatus;
	statusNote: string;
	currentRun: string;
	spendTodayUsd: number;
	runsToday: number;
	lastFinishedAt?: number;
	pid?: number;
	profileDir: string;
	configPath: string;
	stateDir: string;
}

export interface AgentSummaryOptions extends DeriveStatusOptions {
	/** Model resolved by the running pi session, used when the config is empty. */
	runtimeModel?: string;
}

export function describeRun(record: RunRecord): string {
	const outcome = runOutcome(record.stopReason);
	return `#${record.index} ${formatDuration(record.durationMs)} · ${outcome.key} · ${runTurnCount(record)} turns · ${record.events?.length ?? 0} events`;
}

export function readAgentSummary(
	profile: DashboardProfile,
	options: AgentSummaryOptions = {},
): AgentSummary {
	const now = options.now ?? Date.now();
	const runtime = readRuntimeStateFile(profile.stateDir);
	const status = deriveAgentStatus(runtime, options);
	const runs = readRunRecords(profile.stateDir);
	const usage = readUsageToday(profile.stateDir, now);
	const activeRun = runtime?.runId ? runs.find((run) => run.id === runtime.runId) : undefined;
	const last = runs[runs.length - 1];
	const currentRun = activeRun
		? `run #${activeRun.index} in progress`
		: runtime?.runId
			? `run #${runtime.runIndex ?? "?"} in progress`
			: last
				? describeRun(last)
				: "no runs yet";
	const model = profile.config.config.model.trim() || runtime?.model || options.runtimeModel || "default";
	return {
		id: profile.id,
		name: profile.name,
		model,
		status: status.status,
		statusNote: status.note,
		currentRun,
		spendTodayUsd: usage.cost,
		runsToday: usage.runs,
		lastFinishedAt: last?.finishedAt,
		pid: runtime?.pid,
		profileDir: profile.profileDir,
		configPath: profile.configPath,
		stateDir: profile.stateDir,
	};
}

// ---------------------------------------------------------------------------
// agent detail / timeline
// ---------------------------------------------------------------------------

export type TimelineKind = "run" | "sleep" | "reminder" | "event";

/** Canonical order for kind filters and the filter panel. */
export const TIMELINE_KINDS: readonly TimelineKind[] = ["run", "sleep", "reminder", "event"];

export const TIMELINE_PERIODS = ["today", "7d", "all"] as const;
export type TimelinePeriod = (typeof TIMELINE_PERIODS)[number];
/** One page of the timeline; the page parameter is a plain GET parameter. */
export const TIMELINE_PAGE_SIZE = 50;
/** The search term is capped before it is compared with every item. */
export const TIMELINE_MAX_QUERY_CHARS = 200;
/**
 * Upper bound on the feed built in memory. Pagination keeps the rendered page
 * at `TIMELINE_PAGE_SIZE` rows; this cap only protects against a pathological
 * state file, so filters still see an agent's whole recent history.
 */
export const TIMELINE_MAX_ITEMS = 5_000;

export interface TimelineItem {
	kind: TimelineKind;
	at: number;
	/** Run id for run/sleep items; reminder id for reminders. */
	ref?: string;
	title: string;
	detail?: string;
	/** Link to the run detail page for run items. */
	href?: string;
	badge: string;
	run?: RunView;
	/**
	 * Untruncated text the search looks at (event text, reminder text, run
	 * triggers). Rendered titles are shortened, so searching them alone would
	 * miss matches past the cut.
	 */
	searchText?: string;
}

/**
 * Parsed view of the timeline's GET parameters.
 *
 * `kind` may repeat (`?kind=run&kind=sleep`); `event` is the feed's name for
 * a key event. `period` defaults to `all`, `q` is a case-insensitive substring
 * search and `page` is 1-based.
 */
export interface TimelineQuery {
	kinds: TimelineKind[];
	period: TimelinePeriod;
	q: string;
	page: number;
	pageSize: number;
}

export interface TimelineQueryOverrides {
	kinds?: TimelineKind[];
	period?: TimelinePeriod;
	q?: string;
	page?: number;
}

const TIMELINE_KIND_ALIASES: Record<string, TimelineKind> = {
	run: "run",
	sleep: "sleep",
	reminder: "reminder",
	event: "event",
	"key-event": "event",
	key_event: "event",
};

function parseTimelineKinds(params: URLSearchParams): TimelineKind[] {
	const selected = new Set<TimelineKind>();
	for (const raw of params.getAll("kind")) {
		// Repeated params are canonical; comma-separated values are accepted too.
		for (const part of raw.split(",")) {
			const kind = TIMELINE_KIND_ALIASES[part.trim().toLowerCase()];
			if (kind) selected.add(kind);
		}
	}
	return TIMELINE_KINDS.filter((kind) => selected.has(kind));
}

export function parseTimelineQuery(
	params: URLSearchParams,
	options: { pageSize?: number } = {},
): TimelineQuery {
	const periodInput = (params.get("period") ?? "").trim().toLowerCase();
	const period = (TIMELINE_PERIODS as readonly string[]).includes(periodInput)
		? (periodInput as TimelinePeriod)
		: "all";
	const pageInput = Number.parseInt(params.get("page") ?? "", 10);
	const page = Number.isFinite(pageInput) ? Math.min(10_000, Math.max(1, Math.trunc(pageInput))) : 1;
	const pageSize = options.pageSize && options.pageSize > 0
		? Math.max(1, Math.trunc(options.pageSize))
		: TIMELINE_PAGE_SIZE;
	return {
		kinds: parseTimelineKinds(params),
		period,
		q: (params.get("q") ?? "").trim().slice(0, TIMELINE_MAX_QUERY_CHARS),
		page,
		pageSize,
	};
}

/** The canonical query string for a timeline view (empty when nothing is filtered). */
export function timelineQueryString(
	query: TimelineQuery,
	overrides: TimelineQueryOverrides = {},
): string {
	const params = new URLSearchParams();
	for (const kind of overrides.kinds ?? query.kinds) params.append("kind", kind);
	const period = overrides.period ?? query.period;
	if (period !== "all") params.set("period", period);
	const q = (overrides.q ?? query.q).trim();
	if (q) params.set("q", q);
	const page = overrides.page ?? query.page;
	if (page > 1) params.set("page", String(page));
	const encoded = params.toString();
	return encoded ? `?${encoded}` : "";
}

export function hasTimelineFilters(query: TimelineQuery): boolean {
	return query.kinds.length > 0 || query.period !== "all" || query.q.trim() !== "";
}

/** Local midnight, the start of "today" for `period=today`. */
export function startOfLocalDay(ts: number): number {
	const day = new Date(ts);
	day.setHours(0, 0, 0, 0);
	return day.getTime();
}

/** Everything the text search compares, lowercased. */
export function timelineSearchText(item: TimelineItem): string {
	const parts = [item.title, item.detail ?? "", item.badge, item.searchText ?? ""];
	if (item.run) {
		for (const trigger of item.run.triggers) {
			parts.push(trigger.kind, trigger.title, trigger.thread ?? "");
		}
	}
	return parts.join("\n").toLowerCase();
}

/** Apply `kind`, `period` and `q` to the feed (newest first). */
export function filterTimeline(
	items: TimelineItem[],
	query: TimelineQuery,
	options: { now?: number } = {},
): TimelineItem[] {
	const now = options.now ?? Date.now();
	// `today` is the local day; `7d` is a rolling seven-day window.
	const since = query.period === "today"
		? startOfLocalDay(now)
		: query.period === "7d"
			? now - 7 * 24 * 3_600_000
			: Number.NEGATIVE_INFINITY;
	const kinds = new Set(query.kinds);
	const needle = query.q.trim().toLowerCase();
	return items.filter((item) => {
		if (item.at < since) return false;
		if (kinds.size > 0 && !kinds.has(item.kind)) return false;
		if (needle && !timelineSearchText(item).includes(needle)) return false;
		return true;
	});
}

export interface TimelinePage {
	/** Items on this page only (at most `pageSize`). */
	items: TimelineItem[];
	/** The query with the page clamped to the available range. */
	query: TimelineQuery;
	/** Number of items after filtering. */
	total: number;
	/** Items rendered on this page (`items.length`). */
	shown: number;
	page: number;
	pageSize: number;
	pageCount: number;
	/** Index of the first item on this page. */
	offset: number;
	hasMore: boolean;
	nextPage?: number;
}

/** Slice an already filtered feed into a 1-based page of `query.pageSize` items. */
export function paginateTimeline(items: TimelineItem[], query: TimelineQuery): TimelinePage {
	const pageSize = Math.max(1, Math.trunc(query.pageSize) || TIMELINE_PAGE_SIZE);
	const total = items.length;
	const pageCount = Math.max(1, Math.ceil(total / pageSize));
	const page = Math.min(Math.max(1, Math.trunc(query.page) || 1), pageCount);
	const offset = (page - 1) * pageSize;
	const pageItems = items.slice(offset, offset + pageSize);
	const hasMore = page < pageCount;
	return {
		items: pageItems,
		query: { ...query, page, pageSize },
		total,
		shown: pageItems.length,
		page,
		pageSize,
		pageCount,
		offset,
		hasMore,
		nextPage: hasMore ? page + 1 : undefined,
	};
}

export interface ReminderView {
	id: string;
	text: string;
	dueAt: number;
	createdAt: number;
	thread?: string;
	firedAt?: number;
	cancelledAt?: number;
	state: "pending" | "fired" | "cancelled";
}

export function toReminderView(reminder: Reminder): ReminderView {
	return {
		id: reminder.id,
		text: reminder.text,
		dueAt: reminder.dueAt,
		createdAt: reminder.createdAt,
		thread: reminder.thread,
		firedAt: reminder.firedAt,
		cancelledAt: reminder.cancelledAt,
		state: reminder.cancelledAt ? "cancelled" : reminder.firedAt ? "fired" : "pending",
	};
}

/** Inbox events promoted into the feed: urgent, or produced by the runtime itself. */
export function isKeyEvent(event: AliveEvent): boolean {
	if (event.kind === "reminder") return false;
	return event.priority === "high" || event.priority === "interrupt" || event.kind === "system" || event.kind === "worker";
}

export interface TimelineOptions {
	limit?: number;
}

export function buildTimeline(profile: DashboardProfile, options: TimelineOptions = {}): TimelineItem[] {
	const items: TimelineItem[] = [];
	const runs = readRunRecords(profile.stateDir);
	for (const record of runs) {
		const run = toRunView(record);
		const trigger = run.triggers.length > 0
			? run.triggers.map((event) => event.kind).join(", ")
			: "no events";
		const firstTitle = run.triggers[0]?.title;
		items.push({
			kind: "run",
			at: run.finishedAt,
			ref: run.id,
			title: firstTitle ? `trigger: ${trigger} — ${oneLine(firstTitle, 120)}` : "trigger: no events",
			badge: `run #${run.index}`,
			href: `/run/${profile.id}/${encodeURIComponent(run.id)}`,
			run,
			// The run item searches its triggers, not just the shortened title.
			searchText: run.triggers.map((event) =>
				`${event.kind} ${event.thread ?? ""} ${event.title}`).join("\n"),
		});
		if (run.stopReason === "slept" || run.sleep) {
			items.push({
				kind: "sleep",
				at: run.finishedAt,
				ref: run.id,
				title: "context reset (sleep)",
				detail:
					`the transcript was wiped${run.sleep?.forced ? " by the runtime" : " at the agent's request"}; ` +
					`summary.md, retained facts, journal, notes and reminders survive. ` +
					`summary ${run.sleep?.summaryChars ?? 0} chars`,
				badge: "sleep",
			});
		}
	}

	for (const reminder of readReminders(profile.stateDir)) {
		items.push({
			kind: "reminder",
			at: reminder.createdAt,
			ref: reminder.id,
			title: `reminder scheduled: ${oneLine(reminder.text, 120)}`,
			detail: `due ${formatTimestamp(reminder.dueAt)}${reminder.thread ? ` · thread ${reminder.thread}` : ""}`,
			badge: "reminder",
			searchText: reminder.text,
		});
		if (reminder.firedAt) {
			items.push({
				kind: "reminder",
				at: reminder.firedAt,
				ref: reminder.id,
				title: `reminder fired: ${oneLine(reminder.text, 120)}`,
				detail: `due ${formatTimestamp(reminder.dueAt)}`,
				badge: "reminder",
				searchText: reminder.text,
			});
		}
		if (reminder.cancelledAt) {
			items.push({
				kind: "reminder",
				at: reminder.cancelledAt,
				ref: reminder.id,
				title: `reminder cancelled: ${oneLine(reminder.text, 120)}`,
				detail: `due ${formatTimestamp(reminder.dueAt)}`,
				badge: "reminder",
				searchText: reminder.text,
			});
		}
	}

	for (const event of readInboxEvents(profile.stateDir)) {
		if (!isKeyEvent(event)) continue;
		items.push({
			kind: "event",
			at: event.ts,
			ref: event.id,
			title: `${event.kind}: ${oneLine(event.title, 120)}`,
			detail: `priority ${event.priority} · source ${event.source}${event.thread ? ` · thread ${event.thread}` : ""} — ${oneLine(event.text, 240)}`,
			badge: `event ${event.kind}`,
			// The detail paragraph shortens the event text; search the full text.
			searchText: `${event.title}\n${event.text}\n${event.source} ${event.kind}`,
		});
	}

	items.sort((left, right) => right.at - left.at);
	return items.slice(0, options.limit ?? TIMELINE_MAX_ITEMS);
}

export interface AgentDetail {
	summary: AgentSummary;
	runtime: RuntimeStateFile | null;
	/** Items on the current timeline page (filtered and paginated). */
	timeline: TimelineItem[];
	/** Counts and the clamped query for the timeline page. */
	timelinePage: TimelinePage;
	runs: RunView[];
	totals: RunTotals;
	/** Last-14-days cost/run trend, oldest first, shown above the timeline. */
	trend: CostTrendView;
	reminders: ReminderView[];
}

export interface AgentDetailOptions extends AgentSummaryOptions {
	/** Parsed `kind` / `period` / `q` / `page` parameters; defaults to all, page 1. */
	timelineQuery?: TimelineQuery;
}

export function loadAgentDetail(
	profile: DashboardProfile,
	options: AgentDetailOptions = {},
): AgentDetail {
	const records = readRunRecords(profile.stateDir);
	const runs = records.map(toRunView);
	const query = options.timelineQuery ?? parseTimelineQuery(new URLSearchParams());
	const filtered = filterTimeline(buildTimeline(profile), query, { now: options.now });
	const timelinePage = paginateTimeline(filtered, query);
	return {
		summary: readAgentSummary(profile, options),
		runtime: readRuntimeStateFile(profile.stateDir),
		timeline: timelinePage.items,
		timelinePage,
		// Newest first, bounded: the detail page is an overview, not an export.
		runs: runs.slice(-30).reverse(),
		totals: sumRuns(runs),
		trend: buildCostTrend(profile, { now: options.now }),
		reminders: readReminders(profile.stateDir).map(toReminderView),
	};
}

// ---------------------------------------------------------------------------
// pi session transcripts
// ---------------------------------------------------------------------------

export type SessionTurnRole = "user" | "assistant" | "toolResult";

export interface SessionToolCall {
	id: string;
	name: string;
	args: string;
}

export interface SessionTurn {
	at: number;
	role: SessionTurnRole;
	text: string;
	thinking?: string;
	toolCalls?: SessionToolCall[];
	toolCallId?: string;
	toolName?: string;
	isError?: boolean;
	stopReason?: string;
	errorMessage?: string;
	/** Session file this turn came from (shown on the run page for honesty). */
	file: string;
}

function listJsonlFiles(dir: string, depth = 0): string[] {
	if (depth > 3) return [];
	let entries: fs.Dirent[];
	try {
		entries = fs.readdirSync(dir, { withFileTypes: true });
	} catch {
		return [];
	}
	const files: string[] = [];
	for (const entry of entries) {
		const full = path.join(dir, entry.name);
		if (entry.isDirectory()) files.push(...listJsonlFiles(full, depth + 1));
		else if (entry.isFile() && entry.name.endsWith(".jsonl")) files.push(full);
	}
	return files.sort();
}

function textParts(content: unknown, key: "text" | "thinking"): string[] {
	if (typeof content === "string") return key === "text" ? [content] : [];
	if (!Array.isArray(content)) return [];
	const parts: string[] = [];
	for (const part of content) {
		if (!part || typeof part !== "object") continue;
		const record = part as Record<string, unknown>;
		if (record.type === key && typeof record[key] === "string") parts.push(record[key] as string);
	}
	return parts;
}

function toolCallParts(content: unknown): SessionToolCall[] {
	if (!Array.isArray(content)) return [];
	const calls: SessionToolCall[] = [];
	for (const part of content) {
		if (!part || typeof part !== "object") continue;
		const record = part as Record<string, unknown>;
		if (record.type !== "toolCall") continue;
		let args = "";
		try {
			args = JSON.stringify(record.arguments ?? {});
		} catch {
			args = "[unserializable arguments]";
		}
		calls.push({
			id: typeof record.id === "string" ? record.id : "",
			name: typeof record.name === "string" ? record.name : "(unknown tool)",
			args,
		});
	}
	return calls;
}

function parseSessionTurn(entry: Record<string, unknown>, file: string): SessionTurn | null {
	if (entry.type !== "message") return null;
	const message = entry.message as Record<string, unknown> | undefined;
	if (!message || typeof message !== "object") return null;
	const role = message.role;
	if (role !== "user" && role !== "assistant" && role !== "toolResult") return null;
	const entryTimestamp = typeof entry.timestamp === "string" ? Date.parse(entry.timestamp) : Number.NaN;
	const messageTimestamp = typeof message.timestamp === "number" ? message.timestamp : Number.NaN;
	const at = Number.isFinite(entryTimestamp) ? entryTimestamp : Number.isFinite(messageTimestamp) ? messageTimestamp : 0;
	const turn: SessionTurn = {
		at,
		role,
		text: textParts(message.content, "text").join("\n"),
		file,
	};
	if (role === "assistant") {
		const thinking = textParts(message.content, "thinking").join("\n");
		if (thinking) turn.thinking = thinking;
		const calls = toolCallParts(message.content);
		if (calls.length > 0) turn.toolCalls = calls;
		if (typeof message.stopReason === "string") turn.stopReason = message.stopReason;
		if (typeof message.errorMessage === "string" && message.errorMessage) turn.errorMessage = message.errorMessage;
	}
	if (role === "toolResult") {
		if (typeof message.toolCallId === "string") turn.toolCallId = message.toolCallId;
		if (typeof message.toolName === "string") turn.toolName = message.toolName;
		if (message.isError === true) turn.isError = true;
	}
	return turn;
}

export interface ReadSessionsOptions {
	/** Skip files whose mtime is older than this (the transcript cannot cover the run). */
	sinceMs?: number;
}

/** Parse every pi session transcript under `state/sessions` into a flat message list. */
export function readSessionTurns(stateDir: string, options: ReadSessionsOptions = {}): SessionTurn[] {
	const dir = path.join(stateDir, "sessions");
	const turns: SessionTurn[] = [];
	for (const file of listJsonlFiles(dir)) {
		if (options.sinceMs !== undefined) {
			try {
				if (fs.statSync(file).mtimeMs < options.sinceMs) continue;
			} catch {
				continue;
			}
		}
		let raw: string;
		try {
			raw = fs.readFileSync(file, "utf8");
		} catch {
			continue;
		}
		for (const line of raw.split("\n")) {
			const trimmed = line.trim();
			if (!trimmed) continue;
			let entry: Record<string, unknown>;
			try {
				entry = JSON.parse(trimmed) as Record<string, unknown>;
			} catch {
				continue;
			}
			const turn = parseSessionTurn(entry ?? {}, file);
			if (turn) turns.push(turn);
		}
	}
	turns.sort((left, right) => left.at - right.at);
	return turns;
}

/**
 * Messages that belong to one run.
 *
 * The session JSONL stores no run id: it is one continuous pi transcript. The
 * only durable correlation is time, so we keep message timestamps inside the
 * run's `[startedAt, finishedAt]` window. A one-second tolerance covers the
 * entry timestamp being written just after `finishedAt` was sampled.
 */
export const RUN_WINDOW_SLACK_MS = 1_000;

export function turnsForRun(turns: SessionTurn[], run: Pick<RunView, "startedAt" | "finishedAt">): SessionTurn[] {
	return turns.filter(
		(turn) => turn.at >= run.startedAt - RUN_WINDOW_SLACK_MS && turn.at <= run.finishedAt + RUN_WINDOW_SLACK_MS,
	);
}

// ---------------------------------------------------------------------------
// run detail: tools, errors, prompt
// ---------------------------------------------------------------------------

export interface ToolCallView {
	id: string;
	name: string;
	args: string;
	durationMs?: number;
	result: string;
	isError: boolean;
	/** True when no tool result was recorded (run aborted mid-call). */
	pending: boolean;
}

export function extractToolCalls(turns: SessionTurn[]): ToolCallView[] {
	const results = new Map<string, SessionTurn>();
	for (const turn of turns) {
		if (turn.role === "toolResult" && turn.toolCallId) results.set(turn.toolCallId, turn);
	}
	const calls: ToolCallView[] = [];
	for (const turn of turns) {
		if (turn.role !== "assistant" || !turn.toolCalls) continue;
		for (const call of turn.toolCalls) {
			const result = call.id ? results.get(call.id) : undefined;
			const durationMs = result && result.at >= turn.at ? result.at - turn.at : undefined;
			calls.push({
				id: call.id,
				name: call.name,
				args: call.args,
				durationMs,
				result: result?.text ?? "",
				isError: result?.isError === true,
				pending: !result,
			});
		}
	}
	return calls;
}

export function extractErrors(run: RunView, turns: SessionTurn[]): string[] {
	const errors: string[] = [];
	if (run.error) errors.push(run.error);
	for (const turn of turns) {
		if (turn.role === "assistant" && turn.errorMessage) {
			errors.push(`${turn.at ? new Date(turn.at).toISOString() : "?"} model error: ${turn.errorMessage}`);
		}
		if (turn.role === "toolResult" && turn.isError) {
			errors.push(`tool ${turn.toolName ?? "?"} failed: ${oneLine(turn.text, 300)}`);
		}
	}
	return [...new Set(errors)];
}

export interface SystemPromptView {
	text: string;
	/** Chars of the stable base/system instructions (everything except SOUL and contract). */
	baseChars: number;
	/** Chars of SOUL.md as embedded in the prompt (trimmed). */
	soulChars: number;
	/** Chars of CONTRACT.md (or the built-in default) as embedded in the prompt (trimmed). */
	contractChars: number;
	notes: string[];
}

/**
 * Rebuild the stable system prompt from the profile's current files.
 *
 * The runtime does not persist the exact system prompt a run saw, so this is a
 * reconstruction from `alive.config.json`, `SOUL.md` and `CONTRACT.md` (the
 * same inputs `buildSystemPrompt` receives in `src/runtime/session.ts`). The
 * page says so instead of presenting it as an exact record.
 */
export function reconstructSystemPrompt(profile: DashboardProfile): SystemPromptView {
	const cfg = profile.config.config;
	const paths = profile.config.paths;
	const soul = readTextFile(paths.soulPath).trim();
	const contract = readTextFile(paths.contractPath).trim() || DEFAULT_CONTRACT.trim();
	const text = buildSystemPrompt({
		name: cfg.name,
		soul,
		contract,
		workspace: paths.workspaceDir,
		stateDir: paths.stateDir,
		runTimeoutMs: cfg.loop.runTimeoutMs,
		runWarnMs: cfg.loop.runWarnMs,
		sleepAfterMs: cfg.loop.sleepAfterMs,
		workers: cfg.workers.enabled
			? {
				models: cfg.workers.models,
				defaultModel: cfg.workers.defaultModel,
				worktree: cfg.workers.permissions.worktree,
				pullRequest: cfg.workers.permissions.pullRequest,
				sandboxed: cfg.sandbox.enabled,
			}
			: undefined,
	});
	const notes = [
		"reconstructed from the profile's current alive.config.json, SOUL.md and CONTRACT.md — the exact system prompt is not persisted by the runtime",
	];
	if (cfg.sandbox.enabled) {
		notes.push("the running session appends a sandbox addendum to this text; that addendum is generated at session build time and is not stored");
	}
	notes.push(
		"resource-loader context files, skills and extension prompts are added at session build time and are not persisted, so they are not shown",
	);
	// `buildSystemPrompt` embeds the trimmed soul and contract exactly once, so
	// subtracting their lengths leaves the stable base/system instructions.
	return {
		text,
		baseChars: Math.max(0, text.length - soul.length - contract.length),
		soulChars: soul.length,
		contractChars: contract.length,
		notes,
	};
}

function readTextFile(file: string): string {
	try {
		return fs.readFileSync(file, "utf8");
	} catch {
		return "";
	}
}

// ---------------------------------------------------------------------------
// prompt composition (#121, slice 3)
// ---------------------------------------------------------------------------

/**
 * The dashboard has no provider tokenizer. Token counts on the run page are
 * therefore labelled estimates: `ceil(chars / 4)`. They are never mixed with
 * the measured usage numbers in `runs.jsonl`.
 */
export const PROMPT_TOKEN_ESTIMATE_CHARS = 4;

export function estimatePromptTokens(chars: number): number {
	return Math.ceil(chars / PROMPT_TOKEN_ESTIMATE_CHARS);
}

export type PromptBlockKey =
	| "base"
	| "soul"
	| "contract"
	| "summary"
	| "memory"
	| "toolSchemas"
	| "history"
	| "toolResults"
	| "unattributed";

export type PromptBlockSource = "reconstructed" | "measured" | "unattributed" | "not-recorded";

export const PROMPT_BLOCK_LABELS: Record<PromptBlockKey, string> = {
	base: "base / system prompt",
	soul: "SOUL.md",
	contract: "contract",
	summary: "summary.md",
	memory: "memory facts",
	toolSchemas: "tool schemas",
	history: "session history",
	toolResults: "tool results",
	unattributed: "unattributed",
};

export interface PromptBlockView {
	key: PromptBlockKey;
	label: string;
	/** Chars attributable to this block; null when the source was not recorded. */
	chars: number | null;
	/** Estimate only: `ceil(chars / 4)`. Null when `chars` is null. */
	tokens: number | null;
	/** Share of the reconstructed total; null when the block is not measurable. */
	share: number | null;
	source: PromptBlockSource;
	note?: string;
}

export interface PromptDeltaRowView {
	key: PromptBlockKey;
	label: string;
	firstChars: number | null;
	lastChars: number | null;
	/** `lastChars - firstChars`; null when either side is not measurable. */
	delta: number | null;
}

export interface PromptDeltaView {
	/** True only when at least two prompts with text exist in the run window. */
	available: boolean;
	promptCount: number;
	firstAt?: number;
	lastAt?: number;
	rows: PromptDeltaRowView[];
	notes: string[];
}

export interface PromptCompositionView {
	/** True when a user-role prompt from the session transcript was available. */
	available: boolean;
	/** 1-based index of the prompt used for the composition (last awake prompt). */
	promptIndex: number | null;
	promptAt: number | null;
	promptCount: number;
	totalChars: number;
	totalTokens: number;
	blocks: PromptBlockView[];
	delta: PromptDeltaView;
	notes: string[];
}

/** Markers written by `renderAwakePrompt` in `src/runtime/prompt.ts`. */
const SUMMARY_SECTION_MARKER = "Long-term memory (summary.md — primary, always loaded):\n";
const MEMORY_SECTION_MARKER = "Relevant fact memories (search the memory tool for more):\n";
/** The next carried-over subsection, or the next top-level section. */
const PROMPT_SECTION_END_MARKERS = [
	"\n\nRelevant fact memories (search the memory tool for more):",
	"\n\nJournal (tail):",
	"\n\nRecent runs:",
	"\n\nYour coding workers:",
	"\n\n### Notification policy",
	"\n\n### Budget",
	"\n\n### New events",
	"\n\n### Still unanswered",
];

/**
 * Chars of one prompt subsection, without its header.
 *
 * Returns 0 when the marker is absent: the prompt text is present, so an absent
 * summary/memory section is a measured zero, not an unknown value.
 */
function promptSectionChars(text: string, marker: string): number {
	const start = text.indexOf(marker);
	if (start < 0) return 0;
	const from = start + marker.length;
	let end = text.length;
	for (const next of PROMPT_SECTION_END_MARKERS) {
		const index = text.indexOf(next, from);
		if (index >= 0 && index < end) end = index;
	}
	return Math.max(0, end - from);
}

/** Chars an assistant message adds to the context sent to the next model turn. */
function assistantMessageChars(turn: SessionTurn): number {
	let chars = turn.text.length + (turn.thinking?.length ?? 0);
	for (const call of turn.toolCalls ?? []) chars += call.args.length;
	return chars;
}

interface PromptSnapshot {
	index: number;
	at: number;
	text: string;
	promptChars: number;
	summaryChars: number;
	memoryChars: number;
	historyChars: number;
	toolResultChars: number;
	unattributedChars: number;
	totalChars: number;
}

/**
 * Per-prompt context reconstruction, oldest prompt first.
 *
 * `history` and `tool results` are the transcript messages that preceded the
 * prompt *inside this run's window*. Context from before the run is not in the
 * window and is therefore not attributed to any block.
 */
function promptSnapshots(turns: SessionTurn[], system: SystemPromptView): PromptSnapshot[] {
	const systemChars = system.baseChars + system.soulChars + system.contractChars;
	const snapshots: PromptSnapshot[] = [];
	let historyChars = 0;
	let toolResultChars = 0;
	for (const turn of turns) {
		if (turn.role === "user") {
			const promptChars = turn.text.length;
			const summaryChars = promptSectionChars(turn.text, SUMMARY_SECTION_MARKER);
			const memoryChars = promptSectionChars(turn.text, MEMORY_SECTION_MARKER);
			snapshots.push({
				index: snapshots.length + 1,
				at: turn.at,
				text: turn.text,
				promptChars,
				summaryChars,
				memoryChars,
				historyChars,
				toolResultChars,
				unattributedChars: Math.max(0, promptChars - summaryChars - memoryChars),
				totalChars: systemChars + promptChars + historyChars + toolResultChars,
			});
			// Earlier prompts are conversation history for the next model turn.
			historyChars += promptChars;
			continue;
		}
		if (turn.role === "assistant") historyChars += assistantMessageChars(turn);
		if (turn.role === "toolResult") toolResultChars += turn.text.length;
	}
	return snapshots;
}

function blockView(
	key: PromptBlockKey,
	chars: number | null,
	source: PromptBlockSource,
	totalChars: number,
	note?: string,
): PromptBlockView {
	return {
		key,
		label: PROMPT_BLOCK_LABELS[key],
		chars,
		tokens: chars === null ? null : estimatePromptTokens(chars),
		share: chars === null || totalChars <= 0 ? null : chars / totalChars,
		source,
		note,
	};
}

const DELTA_KEYS: PromptBlockKey[] = [
	"base",
	"soul",
	"contract",
	"summary",
	"memory",
	"toolSchemas",
	"history",
	"toolResults",
	"unattributed",
];

function deltaChars(snapshot: PromptSnapshot | undefined, key: PromptBlockKey, system: SystemPromptView): number | null {
	if (!snapshot) return null;
	switch (key) {
		case "base":
			return system.baseChars;
		case "soul":
			return system.soulChars;
		case "contract":
			return system.contractChars;
		case "summary":
			return snapshot.summaryChars;
		case "memory":
			return snapshot.memoryChars;
		case "toolSchemas":
			return null;
		case "history":
			return snapshot.historyChars;
		case "toolResults":
			return snapshot.toolResultChars;
		case "unattributed":
			return snapshot.unattributedChars;
	}
}

function buildPromptDelta(snapshots: PromptSnapshot[], system: SystemPromptView): PromptDeltaView {
	const first = snapshots[0];
	const last = snapshots[snapshots.length - 1];
	const notes: string[] = [];
	if (snapshots.length < 2) {
		notes.push(
			snapshots.length === 0
				? "no user-role prompt was found in this run's session transcript, so the first→last prompt delta is not available"
				: "this run's transcript contains only one prompt, so there is no first→last prompt delta to compare",
		);
		return {
			available: false,
			promptCount: snapshots.length,
			firstAt: first?.at,
			lastAt: last?.at,
			rows: [],
			notes,
		};
	}
	const rows = DELTA_KEYS.map((key) => {
		const firstChars = deltaChars(first, key, system);
		const lastChars = deltaChars(last, key, system);
		return {
			key,
			label: PROMPT_BLOCK_LABELS[key],
			firstChars,
			lastChars,
			delta: firstChars === null || lastChars === null ? null : lastChars - firstChars,
		};
	});
	notes.push("compares the first and last user-role prompt inside this run's session window");
	if (rows.some((row) => row.key === "toolSchemas")) {
		notes.push("tool schemas are not persisted, so their delta is not measurable and is shown as —");
	}
	return {
		available: true,
		promptCount: snapshots.length,
		firstAt: first.at,
		lastAt: last.at,
		rows,
		notes,
	};
}

/**
 * Reconstruct the prompt composition for a run.
 *
 * The stable system prompt is reconstructed from the profile's current files
 * (its exact chars are not persisted). `summary.md`, memory facts, history and
 * tool results are measured in the run's actual session transcript. The rest of
 * the user prompt — event batch, notes, reminders, journal, policy, budget — and
 * the tool schemas / resource-loader context the pi session adds at build time
 * are lumped into `unattributed`: their exact sizes are not on disk, so the
 * dashboard does not guess them.
 */
function buildPromptComposition(
	system: SystemPromptView,
	transcript: SessionTurn[],
	measuredPromptChars = 0,
): PromptCompositionView {
	const snapshots = promptSnapshots(transcript, system);
	const transcriptPromptChars = snapshots.reduce((total, snapshot) => total + snapshot.promptChars, 0);
	const selected = [...snapshots].reverse().find((snapshot) => /^## (AWAKE|RESUMED)\b/.test(snapshot.text))
		?? snapshots[snapshots.length - 1];
	const delta = buildPromptDelta(snapshots, system);
	const notes: string[] = [
		"the stable system prompt is reconstructed from the profile's current config, SOUL.md and CONTRACT.md — the exact system prompt is not persisted by the runtime",
		"the summary, memory-fact, history and tool-result sizes are measured in this run's session transcript; the remaining prompt text cannot be split exactly",
		"token counts are estimates only: ceil(chars / 4), not provider tokens",
	];
	if (!selected) {
		notes.push(
			"no user-role prompt text is available for this run, so only the reconstructed system-prompt blocks can be sized; summary, memory, history and tool results are shown as — rather than guessed",
		);
		const totalChars = system.baseChars + system.soulChars + system.contractChars;
		return {
			available: false,
			promptIndex: null,
			promptAt: null,
			promptCount: snapshots.length,
			totalChars,
			totalTokens: estimatePromptTokens(totalChars),
			blocks: [
				blockView("base", system.baseChars, "reconstructed", totalChars),
				blockView("soul", system.soulChars, "reconstructed", totalChars),
				blockView("contract", system.contractChars, "reconstructed", totalChars),
				blockView("summary", null, "not-recorded", totalChars),
				blockView("memory", null, "not-recorded", totalChars),
				blockView("toolSchemas", null, "not-recorded", totalChars, "tool schemas are registered at session build time and are not persisted"),
				blockView("history", null, "not-recorded", totalChars),
				blockView("toolResults", null, "not-recorded", totalChars),
				blockView("unattributed", null, "not-recorded", totalChars),
			],
			delta,
			notes,
		};
	}
	const totalChars = selected.totalChars;
	notes.unshift(
		`showing prompt ${selected.index} of ${snapshots.length} (the last AWAKE/RESUMED prompt in this run's transcript)`,
	);
	if (measuredPromptChars > 0 && transcriptPromptChars !== measuredPromptChars) {
		notes.push(
			`the run record counted ${measuredPromptChars} prompt chars across all prompts; the transcript holds ${transcriptPromptChars}, and the difference is not guessed`,
		);
	}
	notes.push(...delta.notes);
	notes.push(
		"unattributed = the rest of that prompt's text (events, notes, reminders, journal, policy, budget) plus the tool schemas and resource-loader context, whose sizes are not recorded",
	);
	return {
		available: true,
		promptIndex: selected.index,
		promptAt: selected.at,
		promptCount: snapshots.length,
		totalChars,
		totalTokens: estimatePromptTokens(totalChars),
		blocks: [
			blockView("base", system.baseChars, "reconstructed", totalChars),
			blockView("soul", system.soulChars, "reconstructed", totalChars),
			blockView("contract", system.contractChars, "reconstructed", totalChars),
			blockView("summary", selected.summaryChars, "measured", totalChars),
			blockView("memory", selected.memoryChars, "measured", totalChars),
			blockView("toolSchemas", null, "not-recorded", totalChars, "not persisted; its size is not guessed"),
			blockView("history", selected.historyChars, "measured", totalChars),
			blockView("toolResults", selected.toolResultChars, "measured", totalChars),
			blockView("unattributed", selected.unattributedChars, "unattributed", totalChars),
		],
		delta,
		notes,
	};
}

export interface PromptCostPairView {
	/** Recorded step/turn index, or null for a prompt that no step follows. */
	turn: number | null;
	stepAt: number | null;
	stepCost: number | null;
	promptAt: number | null;
	promptChars: number | null;
}

export interface PromptCostPairsView {
	pairs: PromptCostPairView[];
	notes: string[];
}

/**
 * Pair each recorded step with the latest prompt at or before it.
 *
 * Missing halves stay null so the page renders `—`: an old run has step costs
 * but no prompt transcript, a new run can have a prompt after its last step.
 */
export function buildPromptCostPairs(steps: RunStepsView, promptTurns: SessionTurn[]): PromptCostPairsView {
	const prompts = [...promptTurns].sort((left, right) => left.at - right.at);
	const pairs: PromptCostPairView[] = [];
	const usedPrompts = new Set<number>();
	if (steps.recorded) {
		for (const step of steps.steps) {
			let match = -1;
			for (let index = 0; index < prompts.length; index += 1) {
				if (prompts[index]!.at <= step.startedAt + RUN_WINDOW_SLACK_MS) match = index;
				else break;
			}
			const prompt = match >= 0 ? prompts[match] : undefined;
			if (match >= 0) usedPrompts.add(match);
			pairs.push({
				turn: step.index,
				stepAt: step.startedAt,
				stepCost: step.usage.cost,
				promptAt: prompt?.at ?? null,
				promptChars: prompt ? prompt.text.length : null,
			});
		}
	}
	for (let index = 0; index < prompts.length; index += 1) {
		if (usedPrompts.has(index)) continue;
		const prompt = prompts[index]!;
		pairs.push({
			turn: null,
			stepAt: null,
			stepCost: null,
			promptAt: prompt.at,
			promptChars: prompt.text.length,
		});
	}
	pairs.sort((left, right) => (left.stepAt ?? left.promptAt ?? 0) - (right.stepAt ?? right.promptAt ?? 0));
	const notes: string[] = [];
	if (!steps.recorded) {
		notes.push("per-turn cost was not recorded for this run, so prompt sizes have no step cost to pair with (—)");
	}
	if (prompts.length === 0) {
		notes.push("no user-role prompt was found in the session transcript, so step costs have no prompt size to pair with (—)");
	}
	if (steps.recorded && prompts.length > 0) {
		notes.push("a step is paired with the latest prompt at or before its start (within 1s); a prompt after the last recorded step has no step cost");
	}
	return { pairs, notes };
}

export interface RunDetail {
	agent: { id: string; name: string; model: string };
	run: RunView;
	/** Per-turn cost breakdown and its sum check against the aggregate (#121). */
	steps: RunStepsView;
	/** Prompt blocks with chars, estimated tokens and shares (#121). */
	promptComposition: PromptCompositionView;
	/** Per-turn prompt size next to the recorded step cost (#121). */
	promptCostPairs: PromptCostPairsView;
	toolCalls: ToolCallView[];
	errors: string[];
	systemPrompt: SystemPromptView;
	/** User-role messages (the prompts the runtime sent) that fall in this run. */
	promptTurns: SessionTurn[];
	/** Every session message in this run's window, for the collapsed transcript. */
	transcript: SessionTurn[];
	promptAvailable: boolean;
	sessionFiles: string[];
	notes: string[];
}

export interface RunDetailOptions {
	now?: number;
}

export function loadRunDetail(
	profile: DashboardProfile,
	runId: string,
	options: RunDetailOptions = {},
): RunDetail | undefined {
	const record = readRunRecords(profile.stateDir).find((candidate) => candidate.id === runId);
	if (!record) return undefined;
	const run = toRunView(record);
	const allTurns = readSessionTurns(profile.stateDir, { sinceMs: run.startedAt - 60_000 });
	const turns = turnsForRun(allTurns, run);
	const promptTurns = turns.filter((turn) => turn.role === "user");
	const errors = extractErrors(run, turns);
	const notes: string[] = [];
	if (turns.length === 0) {
		notes.push(
			"no session transcript covers this run: the pi session files are missing, were reset by a sleep, or the run predates them",
		);
	} else if (promptTurns.length === 0) {
		notes.push(
			"a transcript was found in this run's time window, but it contains no user-role prompt messages (only assistant/tool messages)",
		);
	}
	notes.push(
		"turn messages are the session JSONL entries whose timestamps fall inside this run's [startedAt, finishedAt] window; the transcript stores no run id",
	);
	notes.push(
		"the raw session entries are shown without applying pi compaction, so a compacted context may have sent the model less than what is listed here",
	);
	if (turns.length > 0) {
		const userText = promptTurns.map((turn) => turn.text).join("\n").trim();
		if (userText) notes.push("these are the actual runtime prompts the model received (awake, nudge or interrupt messages)");
	}
	const steps = buildRunSteps(run);
	const systemPrompt = reconstructSystemPrompt(profile);
	return {
		agent: {
			id: profile.id,
			name: profile.name,
			model: profile.config.config.model.trim() || "default",
		},
		run,
		steps,
		promptComposition: buildPromptComposition(systemPrompt, turns, run.promptChars),
		promptCostPairs: buildPromptCostPairs(steps, promptTurns),
		toolCalls: extractToolCalls(turns),
		errors,
		systemPrompt,
		promptTurns,
		transcript: turns,
		promptAvailable: promptTurns.length > 0,
		sessionFiles: [...new Set(turns.map((turn) => turn.file))],
		notes,
	};
}

// ---------------------------------------------------------------------------
// helpers used by the renderer
// ---------------------------------------------------------------------------

export function formatCost(cost: number): string {
	return `$${(Number.isFinite(cost) ? cost : 0).toFixed(4)}`;
}

export function formatTimestamp(ts: number): string {
	if (!Number.isFinite(ts) || ts <= 0) return "—";
	return new Date(ts).toISOString().replace("T", " ").replace(/\.\d{3}Z$/, "Z");
}
