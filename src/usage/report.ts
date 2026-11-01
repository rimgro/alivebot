/**
 * `alive usage`: where the tokens and the money went.
 *
 * Read-only and metadata-only. Every field is a count, a timestamp, a stored
 * event title or a tool *name*. Prompt text, message text, tool arguments and
 * tool results are never copied into the report; `src/dev/usage-test.ts` plants
 * a distinctive string in all of those places and asserts it cannot reach the
 * table or the JSON.
 *
 * Sources, all optional and all degrading to an explicit note:
 *   - `runs/runs.jsonl`     per-run records, parsed by `src/dashboard/state.ts`
 *   - `usage.json`          the runtime's own daily counter
 *   - `workers/usage.jsonl` the worker-run cost store
 *   - `sessions/*.jsonl`    pi transcripts, read only for per-run tool names
 *
 * The run record does not carry a model or provider today (see
 * `src/store/runs.ts`: `usage` has tokens + cost only), so no model split is
 * reported unless a record actually has one.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import {
	extractToolCalls,
	readRunRecords,
	readRuntimeStateFile,
	readSessionTurns,
	runOutcome,
	sumRuns,
	toRunView,
	turnsForRun,
	type DashboardProfile,
	type RunOutcomeClass,
	type RunView,
	type SessionTurn,
} from "../dashboard/state.js";
import { runTurnCount, type RunRecord, type RunStopReason } from "../store/runs.js";
import { formatDuration, localDay, oneLine, readJson } from "../util.js";
import { readWorkerUsage, workerUsagePath } from "../workers/store.js";

/** Bumped only for a breaking change to the JSON shape. */
export const USAGE_REPORT_VERSION = 1;
export const USAGE_REPORT_KIND = "alive-usage";
export const DEFAULT_USAGE_DAYS = 14;
export const TOP_RUNS_LIMIT = 10;
/** Failed runs are listed in full up to this many entries; the totals cover all of them. */
export const FAILURE_ITEMS_LIMIT = 50;
const TRIGGER_TITLE_MAX = 200;

export interface UsageTokens {
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
	/** The token total stored by pi; falls back to the sum of the four components. */
	total: number;
}

export interface UsageTotals {
	runs: number;
	turns: number;
	cost: number;
	durationMs: number;
	activeMs: number;
	idleMs: number;
	tokens: UsageTokens;
}

export interface UsageDayBucket extends UsageTotals {
	day: string;
	cacheHitShare: number | null;
}

export interface UsageModelBucket extends UsageTotals {
	model: string | null;
	provider: string | null;
}

export interface UsageWorkerSplit {
	/** True when the worker usage store exists (it is written only by worker runs). */
	available: boolean;
	entries: number;
	cost: number;
	tokens: {
		input: number;
		output: number;
		/** Worker entries store input/output only. */
		total: number;
	};
	/** Worker usage entries carry none of these; `null` says so instead of guessing. */
	cacheRead: null;
	cacheWrite: null;
	/** Turns summed over entries that recorded them; `null` when none did. */
	turns: number | null;
	/** Worker spend and entries broken down by model spec (only where recorded). */
	byModel: Array<{ model: string; entries: number; cost: number; tokens: { input: number; output: number } }>;
	/** Most expensive worker runs in the window (only entries with a cost). */
	workerTopRuns: Array<{ ts: number; cost: number; workerId?: string; model?: string; turns?: number; status?: string }>;
	note: string;
}

export interface UsageTopRun {
	id: string;
	index: number;
	finishedAt: number;
	day: string;
	stopReason: RunStopReason;
	outcome: RunOutcomeClass;
	cost: number;
	turns: number;
	durationMs: number;
	activeMs: number;
	tokens: UsageTokens;
	/** Stored event titles (metadata), never message bodies. */
	triggers: Array<{ kind: string; thread?: string; title: string }>;
	/** Tool *names* only. */
	tools: string[];
	toolsAvailable: boolean;
}

export interface UsageFailureRun {
	id: string;
	index: number;
	finishedAt: number;
	day: string;
	stopReason: RunStopReason;
	outcome: RunOutcomeClass;
	cost: number;
	turns: number;
	tokens: UsageTokens;
}

export interface UsageFailureTotals extends UsageTotals {
	items: UsageFailureRun[];
	/** How many failed runs did not fit in `items`. */
	omitted: number;
	note: string;
}

/**
 * Runs that were prompted with an empty inbox (#116).
 *
 * Before the empty-wake fix the runtime started a run whenever its idle interval
 * expired, even with nothing pending: the model loaded the full system prompt
 * (~7k tokens), saw "no events" and went back to `idle`. These runs are the ones
 * whose stored `events` array is empty; they cost money and produced nothing.
 * Since the fix an idle runtime waits for an event instead, so the count should
 * fall to zero (a forced `alive run --once` still records one).
 */
export interface UsageEmptyWakes extends UsageTotals {
	/** Share of the window's agent spend (`cost / totals.cost`); null when nothing was spent. */
	costShare: number | null;
	/** Share of the window's agent tokens (`tokens.total / totals.tokens.total`). */
	tokenShare: number | null;
	note: string;
}

export interface UsageReportSources {
	runs: {
		path: string;
		records: number;
		inWindow: number;
		missingUsage: number;
		missingCacheTokens: number;
		missingDuration: number;
		invalid: number;
	};
	usageCounter: { path: string; present: boolean; days: number };
	workerUsage: { path: string; present: boolean; entries: number };
	sessions: { available: boolean; note: string };
}

export interface UsageReport {
	report: typeof USAGE_REPORT_KIND;
	version: number;
	generatedAt: number;
	/** Always true; the report is built from counts, titles and tool names only. */
	metadataOnly: true;
	window: { days: number; from: string; to: string; fromTs: number; toTs: number };
	agent: { id: string; name: string; model: string; profileDir: string; stateDir: string };
	/** True when some of the source data is missing or in an older format. */
	partial: boolean;
	partialReasons: string[];
	notes: string[];
	sources: UsageReportSources;
	/** Agent (chat) runs only; the worker store is reported under `split.workers`. */
	totals: UsageTotals;
	daily: UsageDayBucket[];
	split: {
		chat: UsageTotals;
		workers: UsageWorkerSplit;
		/** chat + workers, the money spent by this profile in the window. */
		combinedCost: number;
		chatCostShare: number | null;
		workerCostShare: number | null;
	};
	models: {
		/** True only when at least one in-window run record actually stores a model/provider. */
		available: boolean;
		coveredRuns: number;
		unattributedRuns: number;
		items: UsageModelBucket[];
		note: string;
		current: { config: string | null; runtime: string | null };
	};
	cache: {
		hitShare: number | null;
		numerator: number;
		denominator: number;
		approximate: true;
		note: string;
	};
	topRuns: UsageTopRun[];
	failures: UsageFailureTotals;
	emptyWakes: UsageEmptyWakes;
}

export interface BuildUsageReportOptions {
	days?: number;
	now?: number;
}

export interface UsageWindow {
	days: number;
	from: string;
	to: string;
	fromTs: number;
	toTs: number;
}

export function startOfLocalDay(ts: number): number {
	const date = new Date(ts);
	date.setHours(0, 0, 0, 0);
	return date.getTime();
}

/** `days` is inclusive of today: `--days 14` covers today and the 13 days before it. */
export function usageWindow(days: number, now: number): UsageWindow {
	if (!Number.isSafeInteger(days) || days < 1) throw new Error("usage window needs a positive whole number of days");
	const from = new Date(startOfLocalDay(now));
	from.setDate(from.getDate() - (days - 1));
	const fromTs = from.getTime();
	return { days, from: localDay(fromTs), to: localDay(now), fromTs, toTs: now };
}

function numberOr(value: unknown, fallback: number): number {
	return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

function isFiniteNumber(value: unknown): value is number {
	return typeof value === "number" && Number.isFinite(value);
}

function toTokens(totals: ReturnType<typeof sumRuns>): UsageTokens {
	return {
		input: totals.input,
		output: totals.output,
		cacheRead: totals.cacheRead,
		cacheWrite: totals.cacheWrite,
		total: totals.total,
	};
}

function toUsageTotals(views: RunView[]): UsageTotals {
	const totals = sumRuns(views);
	return {
		runs: totals.runs,
		turns: totals.turns,
		cost: totals.cost,
		durationMs: totals.durationMs,
		activeMs: totals.activeMs,
		idleMs: totals.idleMs,
		tokens: toTokens(totals),
	};
}

/** cacheRead / (input + cacheRead); `null` when the window has no input or cache-read tokens. */
export function cacheHitShare(tokens: UsageTokens): number | null {
	const denominator = tokens.input + tokens.cacheRead;
	if (denominator <= 0) return null;
	return tokens.cacheRead / denominator;
}

interface ModelAttribution {
	model: string | null;
	provider: string | null;
	key: string;
}

function modelOf(record: RunRecord): ModelAttribution | undefined {
	const raw = record as RunRecord & { model?: unknown; provider?: unknown };
	const model = typeof raw.model === "string" && raw.model.trim() ? raw.model.trim() : null;
	const provider = typeof raw.provider === "string" && raw.provider.trim() ? raw.provider.trim() : null;
	if (!model && !provider) return undefined;
	return { model, provider, key: `${provider ?? ""}\u0000${model ?? ""}` };
}

interface RunScan {
	records: number;
	invalid: number;
	missingUsage: number;
	missingCacheTokens: number;
	missingDuration: number;
	runs: RunView[];
	models: Map<string, { model: string | null; provider: string | null; views: RunView[] }>;
}

/**
 * Normalize and window the stored run records through the dashboard parsers.
 *
 * Older records may predate `usage`/`cacheRead`/`cacheWrite`/`durationMs`; each
 * gap is counted so the report can say "partial" instead of pretending zero is
 * a measurement.
 */
function scanRuns(stateDir: string, fromTs: number): RunScan {
	const scan: RunScan = {
		records: 0,
		invalid: 0,
		missingUsage: 0,
		missingCacheTokens: 0,
		missingDuration: 0,
		runs: [],
		models: new Map(),
	};
	for (const record of readRunRecords(stateDir)) {
		scan.records += 1;
		if (!record || typeof record !== "object" || !isFiniteNumber(record.finishedAt)) {
			scan.invalid += 1;
			continue;
		}
		if (record.finishedAt < fromTs) continue;

		const usage = record.usage && typeof record.usage === "object" ? record.usage : undefined;
		if (!usage) scan.missingUsage += 1;
		if (!usage || !isFiniteNumber(usage.cacheRead) || !isFiniteNumber(usage.cacheWrite)) {
			scan.missingCacheTokens += 1;
		}
		let durationMs = record.durationMs;
		if (!isFiniteNumber(durationMs)) {
			scan.missingDuration += 1;
			durationMs =
				isFiniteNumber(record.startedAt) && record.finishedAt >= record.startedAt
					? record.finishedAt - record.startedAt
					: 0;
		}

		const input = numberOr(usage?.input, 0);
		const output = numberOr(usage?.output, 0);
		const cacheRead = numberOr(usage?.cacheRead, 0);
		const cacheWrite = numberOr(usage?.cacheWrite, 0);
		const normalized: RunRecord = {
			...record,
			durationMs,
			// `turnCount` is the new field; older records keep the count in `turns`.
			turnCount: runTurnCount(record),
			events: Array.isArray(record.events) ? record.events : [],
			outbound: Array.isArray(record.outbound) ? record.outbound : [],
			usage: {
				input,
				output,
				cacheRead,
				cacheWrite,
				// The stored total wins; otherwise the components are the best available sum.
				total: numberOr(usage?.total, input + output + cacheRead + cacheWrite),
				cost: numberOr(usage?.cost, 0),
			},
		};
		const view = toRunView(normalized);
		scan.runs.push(view);
		const attribution = modelOf(record);
		if (attribution) {
			const bucket = scan.models.get(attribution.key) ?? {
				model: attribution.model,
				provider: attribution.provider,
				views: [],
			};
			bucket.views.push(view);
			scan.models.set(attribution.key, bucket);
		}
	}
	scan.runs.sort((left, right) => left.finishedAt - right.finishedAt);
	return scan;
}

function triggerList(view: RunView): UsageTopRun["triggers"] {
	return view.triggers.map((trigger) => ({
		kind: trigger.kind,
		...(trigger.thread ? { thread: trigger.thread } : {}),
		title: oneLine(trigger.title ?? "", TRIGGER_TITLE_MAX),
	}));
}

function toTopRun(view: RunView, tools: string[], toolsAvailable: boolean): UsageTopRun {
	return {
		id: view.id,
		index: view.index,
		finishedAt: view.finishedAt,
		day: localDay(view.finishedAt),
		stopReason: view.stopReason,
		outcome: runOutcome(view.stopReason).key,
		cost: view.usage.cost,
		turns: view.turns,
		durationMs: view.durationMs,
		activeMs: view.activeMs,
		tokens: {
			input: view.usage.input,
			output: view.usage.output,
			cacheRead: view.usage.cacheRead,
			cacheWrite: view.usage.cacheWrite,
			total: view.usage.total,
		},
		triggers: triggerList(view),
		tools,
		toolsAvailable,
	};
}

function toFailureRun(view: RunView): UsageFailureRun {
	return {
		id: view.id,
		index: view.index,
		finishedAt: view.finishedAt,
		day: localDay(view.finishedAt),
		stopReason: view.stopReason,
		outcome: runOutcome(view.stopReason).key,
		cost: view.usage.cost,
		turns: view.turns,
		tokens: {
			input: view.usage.input,
			output: view.usage.output,
			cacheRead: view.usage.cacheRead,
			cacheWrite: view.usage.cacheWrite,
			total: view.usage.total,
		},
	};
}

function toolNamesByRun(
	views: RunView[],
	turns: SessionTurn[],
): Map<string, { names: string[]; available: boolean }> {
	const out = new Map<string, { names: string[]; available: boolean }>();
	for (const view of views) {
		const runTurns = turnsForRun(turns, view);
		const names = [...new Set(extractToolCalls(runTurns).map((call) => call.name))].sort();
		// Tool *names* only: arguments and results are deliberately dropped here.
		out.set(view.id, { names, available: runTurns.length > 0 });
	}
	return out;
}

function formatUsd(cost: number): string {
	if (!Number.isFinite(cost) || cost <= 0) return "$0.0000";
	if (cost < 0.0001) return "<$0.0001";
	return `$${cost.toFixed(4)}`;
}

function formatShare(share: number | null): string {
	if (share === null) return "n/a";
	return `${(share * 100).toFixed(1)}%`;
}

/** Build the machine-readable report. `--json` prints exactly this object. */
export function buildUsageReport(profile: DashboardProfile, options: BuildUsageReportOptions = {}): UsageReport {
	const days = options.days ?? DEFAULT_USAGE_DAYS;
	const now = options.now ?? Date.now();
	const window = usageWindow(days, now);
	const stateDir = profile.stateDir;

	const scan = scanRuns(stateDir, window.fromTs);
	const views = scan.runs;
	const totals = toUsageTotals(views);

	// usage.json: the runtime's own counter. It only has cost/runs/turns/input/output
	// and keeps ~30 days, so it is reported as a source, not used to overwrite runs.
	const usageCounterPath = path.join(stateDir, "usage.json");
	const counter = readJson<{ days?: Record<string, unknown> } | null>(usageCounterPath, null);
	const counterPresent = counter !== null && typeof counter === "object";
	const counterDays =
		counterPresent && counter?.days && typeof counter.days === "object" ? Object.keys(counter.days).length : 0;

	// Worker cost lives in its own append-only store.
	const workerPath = workerUsagePath(stateDir);
	const workerPresent = fs.existsSync(workerPath);
	const workerEntries = workerPresent ? readWorkerUsage(stateDir, window.fromTs) : [];
	const workerCost = workerEntries.reduce((sum, entry) => sum + numberOr(entry.cost, 0), 0);
	const workerInput = workerEntries.reduce((sum, entry) => sum + numberOr(entry.input, 0), 0);
	const workerOutput = workerEntries.reduce((sum, entry) => sum + numberOr(entry.output, 0), 0);
	const turnsRecorded = workerEntries.filter((entry) => typeof entry.turns === "number");
	const workerTurns = turnsRecorded.length
		? turnsRecorded.reduce((sum, entry) => sum + numberOr(entry.turns, 0), 0)
		: null;
	const modelBuckets = new Map<string, { entries: number; cost: number; input: number; output: number }>();
	for (const entry of workerEntries) {
		const model = typeof entry.model === "string" && entry.model ? entry.model : "unknown";
		const bucket = modelBuckets.get(model) ?? { entries: 0, cost: 0, input: 0, output: 0 };
		bucket.entries += 1;
		bucket.cost += numberOr(entry.cost, 0);
		bucket.input += numberOr(entry.input, 0);
		bucket.output += numberOr(entry.output, 0);
		modelBuckets.set(model, bucket);
	}
	const byModel = [...modelBuckets.entries()]
		.map(([model, bucket]) => ({
			model,
			entries: bucket.entries,
			cost: bucket.cost,
			tokens: { input: bucket.input, output: bucket.output },
		}))
		.sort((left, right) => right.cost - left.cost);
	const workerTopRuns = workerEntries
		.filter((entry) => numberOr(entry.cost, 0) > 0)
		.sort((left, right) => numberOr(right.cost, 0) - numberOr(left.cost, 0))
		.slice(0, 10)
		.map((entry) => ({
			ts: entry.ts,
			cost: numberOr(entry.cost, 0),
			...(entry.workerId ? { workerId: entry.workerId } : {}),
			...(entry.model ? { model: entry.model } : {}),
			...(typeof entry.turns === "number" ? { turns: entry.turns } : {}),
			...(entry.status ? { status: entry.status } : {}),
		}));
	const workers: UsageWorkerSplit = {
		available: workerPresent,
		entries: workerEntries.length,
		cost: workerCost,
		tokens: { input: workerInput, output: workerOutput, total: workerInput + workerOutput },
		cacheRead: null,
		cacheWrite: null,
		turns: workerTurns,
		byModel,
		workerTopRuns,
		note: workerPresent
			? turnsRecorded.length === workerEntries.length
				? "worker entries now record model, turns and run status"
				: "older worker entries predate model/turns recording; those fields are shown only where present"
			: `no worker usage store at ${workerPath}; worker spend cannot be reported`,
	};
	const combinedCost = totals.cost + workerCost;

	// Per-day totals, local-day bucketed exactly like RunLog.bumpUsage.
	const byDay = new Map<string, RunView[]>();
	for (const view of views) {
		const day = localDay(view.finishedAt);
		const bucket = byDay.get(day) ?? [];
		bucket.push(view);
		byDay.set(day, bucket);
	}
	const daily: UsageDayBucket[] = [...byDay.entries()]
		.sort((left, right) => left[0].localeCompare(right[0]))
		.map(([day, dayViews]) => {
			const dayTotals = toUsageTotals(dayViews);
			return { day, ...dayTotals, cacheHitShare: cacheHitShare(dayTotals.tokens) };
		});

	// Model/provider split, only from records that actually carry it.
	const modelItems: UsageModelBucket[] = [...scan.models.values()]
		.map((bucket) => ({
			model: bucket.model,
			provider: bucket.provider,
			...toUsageTotals(bucket.views),
		}))
		.sort((left, right) => right.cost - left.cost);
	const coveredRuns = modelItems.reduce((sum, item) => sum + item.runs, 0);
	const runtime = readRuntimeStateFile(stateDir);
	const configuredModel = profile.config.config.model.trim() || null;
	const runtimeModel = runtime?.model?.trim() || null;
	const modelsAvailable = modelItems.length > 0;
	const modelsNote = modelsAvailable
		? `model/provider is present on ${coveredRuns} of ${views.length} in-window run record(s); runs without it are not attributed to a model`
		: "runs.jsonl stores tokens and cost per run but no model or provider field, so a per-model split would be invented; none is reported. " +
			"`current` shows the configured and runtime model, which are current settings, not a historical breakdown";

	// Top runs by cost, then newest first for a stable order.
	const topViews = [...views]
		.sort((left, right) => right.usage.cost - left.usage.cost || right.finishedAt - left.finishedAt)
		.slice(0, TOP_RUNS_LIMIT);
	const earliestStart = topViews.reduce(
		(earliest, view) => (isFiniteNumber(view.startedAt) ? Math.min(earliest, view.startedAt) : earliest),
		Number.POSITIVE_INFINITY,
	);
	const sessionTurns = Number.isFinite(earliestStart)
		? readSessionTurns(stateDir, { sinceMs: earliestStart - 60_000 })
		: [];
	const toolsByRun = toolNamesByRun(topViews, sessionTurns);
	const topRuns = topViews.map((view) => {
		const tools = toolsByRun.get(view.id) ?? { names: [], available: false };
		return toTopRun(view, tools.names, tools.available);
	});
	const topRunsWithoutTranscript = topRuns.filter((run) => !run.toolsAvailable).length;

	// Failed / aborted runs: the dashboard's own outcome mapping decides what failed.
	const failedViews = views.filter((view) => runOutcome(view.stopReason).key === "error");
	const failureTotals = toUsageTotals(failedViews);
	const sortedFailures = [...failedViews].sort(
		(left, right) => right.usage.cost - left.usage.cost || right.finishedAt - left.finishedAt,
	);
	const failures: UsageFailureTotals = {
		...failureTotals,
		items: sortedFailures.slice(0, FAILURE_ITEMS_LIMIT).map(toFailureRun),
		omitted: Math.max(0, sortedFailures.length - FAILURE_ITEMS_LIMIT),
		note:
			failedViews.length > 0
				? `${failedViews.length} run(s) ended in error/timeout/budget/abort; their spend is included in the totals above but they produced no normal result`
				: "no failed or aborted runs in the window",
	};

	// Empty wakes (#116): runs whose recorded trigger list is empty. Historical data:
	// these are the runs that woke the model with nothing to do.
	const emptyWakeViews = views.filter((view) => view.triggers.length === 0);
	const emptyWakeTotals = toUsageTotals(emptyWakeViews);
	const emptyWakes: UsageEmptyWakes = {
		...emptyWakeTotals,
		costShare: totals.cost > 0 ? emptyWakeTotals.cost / totals.cost : null,
		tokenShare: totals.tokens.total > 0 ? emptyWakeTotals.tokens.total / totals.tokens.total : null,
		note:
			emptyWakeViews.length > 0
				? `${emptyWakeViews.length} run(s) were prompted with no events at all (empty trigger list); since #116 an idle runtime waits for an event instead of starting a run, so this should trend to zero`
				: "no run in the window was prompted with an empty inbox",
	};

	// Partial data: every gap gets a reason; the report still prints what exists.
	const partialReasons: string[] = [];
	if (!counterPresent) {
		partialReasons.push(
			"usage.json (the runtime's daily counter) is missing; daily totals were rebuilt from runs.jsonl",
		);
	}
	if (scan.missingUsage > 0) {
		partialReasons.push(
			`${scan.missingUsage} in-window run record(s) have no usage block; their tokens and cost are counted as 0 (older record format)`,
		);
	}
	if (scan.missingCacheTokens > 0) {
		partialReasons.push(
			`${scan.missingCacheTokens} in-window run record(s) have no cacheRead/cacheWrite fields; the cache share only covers records that carry them`,
		);
	}
	if (scan.missingDuration > 0) {
		partialReasons.push(
			`${scan.missingDuration} in-window run record(s) have no durationMs; duration was derived from startedAt/finishedAt`,
		);
	}
	if (scan.invalid > 0) {
		partialReasons.push(`${scan.invalid} run record(s) are malformed and were skipped`);
	}

	const notes: string[] = [
		"metadata only: this report contains counts, timestamps, stored event titles and tool names — never prompt text, message text, tool arguments or tool results",
		"daily buckets are local days keyed by the run's finishedAt; runs.jsonl is the source of truth, while usage.json is only read for presence/day coverage (it stores cost/runs/turns/input/output and keeps ~30 days)",
		"cost is the value pi reports for the run; it is not recomputed from a price table",
		"top-run trigger titles are stored event titles (metadata), flattened and truncated to 200 chars",
	];
	if (topRunsWithoutTranscript > 0) {
		notes.push(
			`tool names for ${topRunsWithoutTranscript} of ${topRuns.length} top run(s) are unavailable: no pi session transcript covers their run window`,
		);
	}
	if (!workerPresent) notes.push(workers.note);
	if (emptyWakeViews.length > 0) notes.push(emptyWakes.note);

	const tokens = totals.tokens;
	const cacheDenominator = tokens.input + tokens.cacheRead;
	const cache = {
		hitShare: cacheHitShare(tokens),
		numerator: tokens.cacheRead,
		denominator: cacheDenominator,
		approximate: true as const,
		note:
			"cacheRead / (input + cacheRead) from the token counts that exist today; providers differ in how they count " +
			"input versus cache reads, so treat this as an approximate share (null when the window has no input or cache-read tokens)",
	};

	const sessionNote =
		sessionTurns.length > 0
			? "pi session transcripts were read for tool names in the top-run windows; arguments and results were discarded"
			: "no pi session transcript covers the top-run windows; tool names are unavailable";

	return {
		report: USAGE_REPORT_KIND,
		version: USAGE_REPORT_VERSION,
		generatedAt: now,
		metadataOnly: true,
		window,
		agent: {
			id: profile.id,
			name: profile.name,
			model: configuredModel ?? runtimeModel ?? "(default)",
			profileDir: profile.profileDir,
			stateDir,
		},
		partial: partialReasons.length > 0,
		partialReasons,
		notes,
		sources: {
			runs: {
				path: path.join(stateDir, "runs", "runs.jsonl"),
				records: scan.records,
				inWindow: views.length,
				missingUsage: scan.missingUsage,
				missingCacheTokens: scan.missingCacheTokens,
				missingDuration: scan.missingDuration,
				invalid: scan.invalid,
			},
			usageCounter: { path: usageCounterPath, present: counterPresent, days: counterDays },
			workerUsage: { path: workerPath, present: workerPresent, entries: workerEntries.length },
			sessions: { available: sessionTurns.length > 0, note: sessionNote },
		},
		totals,
		daily,
		split: {
			chat: totals,
			workers,
			combinedCost,
			chatCostShare: combinedCost > 0 ? totals.cost / combinedCost : null,
			workerCostShare: combinedCost > 0 ? workerCost / combinedCost : null,
		},
		models: {
			available: modelsAvailable,
			coveredRuns,
			unattributedRuns: views.length - coveredRuns,
			items: modelItems,
			note: modelsNote,
			current: { config: configuredModel, runtime: runtimeModel },
		},
		cache,
		topRuns,
		failures,
		emptyWakes,
	};
}

// ---------------------------------------------------------------------------
// plain-table renderer
// ---------------------------------------------------------------------------

function pad(value: string | number, width: number, align: "left" | "right" = "left"): string {
	const text = String(value);
	return align === "right" ? text.padStart(width) : text.padEnd(width);
}

/**
 * Human-readable form. Same data as the JSON, laid out for a terminal.
 * Nothing is read from the report beyond the fields above.
 */
export function renderUsageReport(report: UsageReport): string {
	const lines: string[] = [];
	const { window: win, totals, cache } = report;
	lines.push(
		`usage — ${report.agent.id} (${report.agent.name}) · last ${win.days} day${win.days === 1 ? "" : "s"} · ${win.from} → ${win.to}`,
	);
	lines.push(
		`model: ${report.agent.model} ${
			report.models.available
				? "(current setting; per-model split below comes from run records that carry it)"
				: "(current setting; run records carry no model)"
		} · metadata only — no prompt or message text`,
	);
	if (report.partial) {
		lines.push(`partial data: yes (${report.partialReasons.length} gap${report.partialReasons.length === 1 ? "" : "s"})`);
	}

	lines.push("");
	lines.push("totals (agent runs)");
	lines.push(`  runs ${totals.runs} · turns ${totals.turns} · cost ${formatUsd(totals.cost)} · active ${formatDuration(totals.activeMs)}`);
	lines.push(
		`  tokens: input ${totals.tokens.input} · output ${totals.tokens.output} · cache read ${totals.tokens.cacheRead} · cache write ${totals.tokens.cacheWrite} · total ${totals.tokens.total}`,
	);
	lines.push(
		`  cache hit share ${formatShare(cache.hitShare)} (cacheRead ${cache.numerator} / (input + cacheRead) ${cache.denominator}) — approximate`,
	);
	lines.push(
		`  empty wakes ${report.emptyWakes.runs} run(s) · ${report.emptyWakes.turns} turns · ${formatUsd(report.emptyWakes.cost)} · ${formatShare(report.emptyWakes.costShare)} of spend · tokens ${report.emptyWakes.tokens.total} (${formatShare(report.emptyWakes.tokenShare)})`,
	);

	lines.push("");
	lines.push("per day");
	if (report.daily.length === 0) {
		lines.push("  no runs in this window");
	} else {
		lines.push(
			`  ${pad("day", 12)}${pad("runs", 6, "right")}${pad("turns", 7, "right")}${pad("cost", 11, "right")}${pad("input", 13, "right")}${pad("output", 13, "right")}${pad("cacheRead", 13, "right")}${pad("cacheWrite", 13, "right")}`,
		);
		for (const day of report.daily) {
			lines.push(
				`  ${pad(day.day, 12)}${pad(day.runs, 6, "right")}${pad(day.turns, 7, "right")}${pad(formatUsd(day.cost), 11, "right")}${pad(day.tokens.input, 13, "right")}${pad(day.tokens.output, 13, "right")}${pad(day.tokens.cacheRead, 13, "right")}${pad(day.tokens.cacheWrite, 13, "right")}`,
			);
		}
	}

	const split = report.split;
	lines.push("");
	lines.push("chat vs workers");
	lines.push(
		`  chat      ${pad(split.chat.runs, 4, "right")} runs · ${pad(split.chat.turns, 4, "right")} turns · ${formatUsd(split.chat.cost)} · ${formatShare(split.chatCostShare)} of spend`,
	);
	lines.push(
		`  workers   ${pad(split.workers.entries, 4, "right")} entries · ${split.workers.turns === null ? "   —" : pad(split.workers.turns, 4, "right")} turns · ${formatUsd(split.workers.cost)} · ${formatShare(split.workerCostShare)} of spend`,
	);
	lines.push(`  combined  ${formatUsd(split.combinedCost)}`);
	if (!split.workers.available) lines.push(`  note: ${split.workers.note}`);

	if (split.workers.available && split.workers.entries > 0) {
		lines.push("");
		lines.push("workers by model");
		for (const item of split.workers.byModel) {
			lines.push(
				`  ${pad(item.model, 28)} ${pad(item.entries, 3, "right")} entries · ${formatUsd(item.cost)} · in ${item.tokens.input} / out ${item.tokens.output}`,
			);
		}
		if (split.workers.workerTopRuns.length > 0) {
			lines.push("");
			lines.push("most expensive worker runs");
			for (const run of split.workers.workerTopRuns.slice(0, 10)) {
				const when = new Date(run.ts).toISOString().slice(0, 16).replace("T", " ");
				const turns = typeof run.turns === "number" ? `${run.turns} turns` : "—";
				lines.push(
					`  ${when}  ${formatUsd(run.cost)}  ${pad(run.model ?? "unknown model", 26)} ${turns}${run.status ? ` · ${run.status}` : ""}${run.workerId ? ` · ${run.workerId}` : ""}`,
				);
			}
		}
		if (split.workers.note.startsWith("older")) lines.push(`  note: ${split.workers.note}`);
	}

	lines.push("");
	lines.push("model / provider split");
	if (report.models.available) {
		for (const item of report.models.items) {
			lines.push(
				`  ${pad(`${item.provider ?? "?"}/${item.model ?? "?"}`, 32)}${pad(`${item.runs} runs`, 10, "right")}${pad(item.turns, 7, "right")} turns ${pad(formatUsd(item.cost), 11, "right")}`,
			);
		}
		lines.push(`  ${report.models.note}`);
	} else {
		lines.push(`  not recorded: ${report.models.note}`);
	}

	lines.push("");
	lines.push(`top ${TOP_RUNS_LIMIT} runs by cost`);
	if (report.topRuns.length === 0) {
		lines.push("  no runs in this window");
	} else {
		for (const run of report.topRuns) {
			const trigger =
				run.triggers.length > 0
					? run.triggers
							.map((event) => `${event.kind}${event.thread ? `@${event.thread}` : ""} "${event.title}"`)
							.join(", ")
					: "no events";
			const tools = run.toolsAvailable ? run.tools.join(", ") || "(none)" : "(no session transcript)";
			lines.push(
				`  #${pad(run.index, 4)} ${run.day} ${pad(formatUsd(run.cost), 9, "right")} ${pad(`${run.turns} turn${run.turns === 1 ? "" : "s"}`, 9, "right")} ${pad(formatDuration(run.durationMs), 7, "right")} ${pad(run.outcome, 7)} trigger: ${trigger}`,
			);
			lines.push(`         tools: ${tools}`);
		}
	}

	lines.push("");
	lines.push(`failed / aborted runs — spend without a normal result`);
	if (report.failures.runs === 0) {
		lines.push(`  ${report.failures.note}`);
	} else {
		lines.push(
			`  ${report.failures.runs} run(s) · ${report.failures.turns} turns · ${formatUsd(report.failures.cost)} · tokens ${report.failures.tokens.total}`,
		);
		for (const run of report.failures.items) {
			lines.push(
				`  #${pad(run.index, 4)} ${run.day} ${pad(run.stopReason, 9)} ${pad(formatUsd(run.cost), 9, "right")} ${pad(`${run.turns} turn${run.turns === 1 ? "" : "s"}`, 9, "right")} tokens ${run.tokens.total}`,
			);
		}
		if (report.failures.omitted > 0) lines.push(`  … ${report.failures.omitted} more failed run(s) not listed`);
	}

	lines.push("");
	lines.push("sources");
	lines.push(
		`  runs: ${report.sources.runs.inWindow}/${report.sources.runs.records} record(s) in window · usage.json ${report.sources.usageCounter.present ? `present (${report.sources.usageCounter.days} day(s))` : "missing"} · worker usage ${report.sources.workerUsage.present ? `${report.sources.workerUsage.entries} entr${report.sources.workerUsage.entries === 1 ? "y" : "ies"}` : "missing"}`,
	);
	lines.push(`  sessions: ${report.sources.sessions.note}`);

	if (report.partialReasons.length > 0 || report.notes.length > 0) {
		lines.push("");
		lines.push("notes");
		for (const reason of report.partialReasons) lines.push(`  ! partial: ${reason}`);
		for (const note of report.notes) lines.push(`  - ${note}`);
	}
	lines.push("");
	return `${lines.join("\n")}\n`;
}
