import * as path from "node:path";
import { appendJsonl, ensureDir, localDay, readJson, readJsonl, writeJsonAtomic, writeJsonlAtomic } from "../util.js";

export interface RunEventSummary {
	seq: number;
	kind: string;
	thread?: string;
	title: string;
	redelivered?: boolean;
}

export type RunStopReason =
	| "slept"
	| "stalled"
	| "timeout"
	| "budget"
	| "error"
	/** A deliberate harness stop (SIGTERM/SIGINT/`alive stop`/update restart). */
	| "interrupted"
	| "aborted";

/**
 * Who initiated the stop of a run (#168).
 *
 * `RunStopReason` says *how* the run ended; this says *who* ended it, which is
 * what an operator asks after seeing a run that spent money and never slept:
 * the agent itself (`sleep`), a harness restart, `alive stop`, a stopped grace
 * period (`cancel`), a safety limit, or the provider/model.
 */
export type RunStoppedBy = "sleep" | "restart" | "stop" | "cancel" | "limit" | "provider" | "model";

/** Runtime list of the allowed `RunStoppedBy` values, used to sanitize records read from disk. */
export const RUN_STOPPED_BY_VALUES: readonly RunStoppedBy[] = [
	"sleep",
	"restart",
	"stop",
	"cancel",
	"limit",
	"provider",
	"model",
];

/** True when `value` is one of the allowed `RunStoppedBy` literals. */
export function isRunStoppedBy(value: unknown): value is RunStoppedBy {
	return typeof value === "string" && (RUN_STOPPED_BY_VALUES as readonly string[]).includes(value);
}

/**
 * Who stopped a run, for both shapes on disk.
 *
 * New records carry `stoppedBy`; records written before #168 only have
 * `stopReason`, so the initiator is derived from it. Readers (dashboard, usage
 * report) must use this helper instead of touching the raw field, which also
 * makes garbage values harmless.
 */
export function runStoppedBy(record: { stoppedBy?: unknown; stopReason?: RunStopReason }): RunStoppedBy {
	if (isRunStoppedBy(record.stoppedBy)) return record.stoppedBy;
	switch (record.stopReason) {
		case "slept":
			return "sleep";
		case "stalled":
		case "timeout":
		case "budget":
			return "limit";
		case "error":
			return "provider";
		case "interrupted":
		case "aborted":
			return "restart";
		default:
			// No usable stop reason at all: a deliberate stop is the neutral answer.
			return "restart";
	}
}

/**
 * True when `runStoppedBy` had to derive the initiator instead of reading it.
 *
 * Records written before #168 (and records with a corrupted field) only have
 * `stopReason`, so the answer is a guess. Readers must label it as such instead
 * of presenting it as a recorded fact.
 */
export function runStoppedByInferred(record: { stoppedBy?: unknown; stopReason?: RunStopReason }): boolean {
	return !isRunStoppedBy(record.stoppedBy);
}

/**
 * True when a run's stop was an interruption: a harness restart, `alive stop`,
 * a cancelled grace period, or the `interrupted`/`aborted` stop reasons.
 *
 * `sleep`, `limit`, `provider` and `model` are ordinary endings. Used by
 * `RunLog.record()` to decide whether a superseded closure belongs in the
 * run's interruption history (#185).
 */
export function isRunInterruption(record: { stoppedBy?: unknown; stopReason?: RunStopReason }): boolean {
	const stoppedBy = runStoppedBy(record);
	return (
		stoppedBy === "restart" ||
		stoppedBy === "stop" ||
		stoppedBy === "cancel" ||
		record.stopReason === "interrupted" ||
		record.stopReason === "aborted"
	);
}

/** One earlier stop of a run id that was later resumed (#185). */
export interface RunInterruption {
	stoppedBy: RunStoppedBy;
	stopReason: RunStopReason;
	at: number;
}

/** Runtime list of the allowed `RunStopReason` values, used to sanitize records read from disk. */
const RUN_STOP_REASON_VALUES: readonly RunStopReason[] = [
	"slept",
	"stalled",
	"timeout",
	"budget",
	"error",
	"interrupted",
	"aborted",
];

/**
 * The interruption history stored on a run record, sanitized.
 *
 * Older records have no field at all. Anything that is not an array of
 * well-formed entries is dropped instead of throwing, so readers can trust the
 * shape without guarding every access.
 */
export function runInterruptions(record: { interruptedBy?: unknown }): RunInterruption[] {
	if (!Array.isArray(record.interruptedBy)) return [];
	const out: RunInterruption[] = [];
	for (const item of record.interruptedBy) {
		if (!item || typeof item !== "object") continue;
		const candidate = item as Record<string, unknown>;
		if (!isRunStoppedBy(candidate.stoppedBy)) continue;
		if (
			typeof candidate.stopReason !== "string" ||
			!(RUN_STOP_REASON_VALUES as readonly string[]).includes(candidate.stopReason)
		) {
			continue;
		}
		if (typeof candidate.at !== "number" || !Number.isFinite(candidate.at)) continue;
		out.push({ stoppedBy: candidate.stoppedBy, stopReason: candidate.stopReason as RunStopReason, at: candidate.at });
	}
	return out;
}

/**
 * One message the run delivered.
 *
 * `deliveryKey` is the outbox idempotency key (`OutgoingMessage.deliveryKey`)
 * written with the message. The resume path uses it together with `thread` and
 * `text` to prove a message is already in this run before sending it again.
 */
export interface RunOutbound {
	thread: string;
	text: string;
	delivered: boolean;
	deliveryKey?: string;
	/** Local agent recipient, used by resume dedupe for `message_agent`. */
	recipientAgentId?: string;
}

export interface RunUsage {
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
	total: number;
	cost: number;
}

/**
 * One model turn of a run, as reported by the pi session.
 *
 * `startedAt`/`durationMs` come from the `turn_start`/`turn_end` events, the
 * token counts and cost from the assistant message's provider usage, and
 * `tools` from the tool calls that turn made.
 */
export interface RunTurnTrace {
	index: number;
	startedAt: number;
	durationMs: number;
	usage: RunUsage;
	tools: string[];
}

/** How many per-turn traces are kept on a run record (the oldest are dropped). */
export const RUN_TURN_TRACE_LIMIT = 200;

/**
 * Why a compaction summarization response was rejected (#167).
 *
 * `provider_html` — the provider (or an upstream proxy/captive portal) returned
 * an HTML page instead of a summary;
 * `provider_json_invalid` — the body looked like JSON but was not a usable
 * summary (an error object or malformed JSON);
 * `provider_error` — any other provider failure, including an empty summary.
 */
export type CompactionFailureClass = "provider_html" | "provider_json_invalid" | "provider_error";

/**
 * Why the runtime forced a context reset (#170):
 *
 * - `soft` — the context stayed above `contextSleepTokens` past
 *   `contextSleepGraceTurns`;
 * - `hard` — the context crossed `contextHardTokens`;
 * - `compaction` — auto-compaction kept failing, so growing the context was
 *   worse than resetting it (compaction remains the first fallback).
 */
export type ContextResetReason = "soft" | "hard" | "compaction";

/**
 * One forced context reset, persisted on the run record only when the runtime
 * (not the agent) ended the run with `sleepForced`. Additive field: older
 * records simply do not carry it.
 */
export interface RunContextReset {
	reason: ContextResetReason;
	/** Context size (pi's prompt estimate) at the moment of the reset. */
	tokens: number;
	/** Threshold that fired (`sleepTokens`, `hardTokens`, or the fallback limit). */
	limitTokens: number;
}

/**
 * The last compaction attempt, persisted on the run record and runtime status so
 * the dashboard can explain why the context keeps growing after a failed
 * compaction. Counters/reason classes only: the provider body itself is logged
 * once (masked, truncated) and never persisted here.
 */
export interface CompactionRecord {
	/** Wall clock of the last attempt. */
	at: number;
	/** True when the summary was accepted and the context was compacted. */
	ok: boolean;
	reasonClass?: CompactionFailureClass;
	/** Short, secret-free reason for the log/dashboard. */
	reason?: string;
	/** Provider attempts used by this outcome (0 when a backoff skipped the call). */
	attempts: number;
	/** Attempt budget for one summarization call. */
	maxAttempts?: number;
	/** Context size (pi's prompt estimate) when the attempt finished. */
	contextTokens?: number;
	/** True when the cross-turn backoff deferred the request without calling the provider. */
	skipped?: boolean;
	/** Earliest wall clock for the next attempt after a transient failure. */
	nextAttemptAt?: number;
	/** Wall clock spent on the provider call(s). */
	durationMs?: number;
}

export interface RunRecord {
	id: string;
	index: number;
	startedAt: number;
	finishedAt: number;
	durationMs: number;
	/** Wall clock spent actually working (idle time excluded). */
	activeMs: number;
	/** Wall clock spent blocked inside `idle`. */
	idleMs: number;
	stopReason: RunStopReason;
	/** Who initiated the stop (#168). Absent on records written before it existed. */
	stoppedBy?: RunStoppedBy;
	error?: string;
	/** Pi session file backing this run, so a resume can reopen the exact session. */
	sessionFile?: string;
	/** Human-readable interruption summary, written when a harness restart drains the run. */
	summary?: string;
	/** Previous stops of this run id, oldest first (#185). Absent when the run was never interrupted. */
	interruptedBy?: RunInterruption[];
	events: RunEventSummary[];
	outbound: RunOutbound[];
	remindersCreated: string[];
	notesTouched: string[];
	journalEntries: number;
	/** How many times the agent returned from idle with events. */
	idleReturns: number;
	/** How many policy-approved events were steered in while working. */
	interruptDeliveries: number;
	/** How many times we had to re-prompt after a stop without idle/sleep. */
	nudges: number;
	/** How many model turns the run completed. Older records stored this in the numeric `turns` field. */
	turnCount: number;
	promptChars: number;
	usage: RunUsage;
	/**
	 * True when the session-stats delta of this run contains spend that none of
	 * its per-turn traces account for — the provider billed a step that never
	 * reported `turn_end` (#168). A consistency flag only: the usage numbers are
	 * the runtime's own and are never rewritten.
	 */
	usageUnsettled?: boolean;
	/**
	 * Per-turn usage captured while the run happened (bounded to the last
	 * `RUN_TURN_TRACE_LIMIT` turns). Absent on records written before #121.
	 */
	turns?: RunTurnTrace[];
	sleep?: { forced: boolean; summaryChars: number };
	/** Last auto-compaction outcome in this run (#167). Absent when none happened. */
	compaction?: CompactionRecord;
	/**
	 * Forced context reset that ended this run (#170). Absent when the agent
	 * slept itself, or when no threshold fired.
	 */
	contextReset?: RunContextReset;
}

/**
 * The number of model turns in a run record, for both shapes on disk.
 *
 * Records written before #121 store a numeric `turns`; new records store the
 * count in `turnCount` and keep the per-turn trace in `turns`. Readers must use
 * this helper instead of touching either field directly.
 */
export function runTurnCount(record: { turnCount?: unknown; turns?: unknown }): number {
	if (typeof record.turnCount === "number" && Number.isFinite(record.turnCount)) {
		return Math.max(0, Math.trunc(record.turnCount));
	}
	if (typeof record.turns === "number" && Number.isFinite(record.turns)) {
		return Math.max(0, Math.trunc(record.turns));
	}
	return Array.isArray(record.turns) ? record.turns.length : 0;
}

/** What startup should do with the last persisted run (#124). */
export type InterruptedResumeDecision = "none" | "resume" | "expire";

/**
 * Decide whether the last run is resumable. Pure clock test seam: `resume` for
 * a recent `interrupted` run, `expire` when the window has passed (the caller
 * closes it as `aborted`), `none` for any other stop reason or no record.
 */
export function interruptedResumeDecision(
	record: RunRecord | undefined,
	now: number,
	windowMs: number,
): InterruptedResumeDecision {
	if (!record || record.stopReason !== "interrupted") return "none";
	if (!(windowMs > 0)) return "expire";
	const ageMs = Math.max(0, now - record.finishedAt);
	return ageMs < windowMs ? "resume" : "expire";
}

/**
 * True when a resume target can actually be reopened (#173).
 *
 * Pure on purpose: the caller stats the file and passes the size, so the
 * "missing, empty or unreadable" decision is testable without a filesystem.
 * An empty file is not a usable transcript: pi would silently start a new
 * session at that path while the run claims to continue.
 */
export function resumeFileUsable(file: string | undefined, sizeBytes: number | undefined): boolean {
	if (typeof file !== "string" || file.trim().length === 0) return false;
	return typeof sizeBytes === "number" && Number.isFinite(sizeBytes) && sizeBytes > 0;
}

/** What startup should do with the last run, transcript included (#173). */
export type StartupResumeDecision = InterruptedResumeDecision | "unusable";

/**
 * Startup decision with the transcript check (#173): a resumable run whose
 * `sessionFile` is gone or unreadable must be closed as `aborted` instead of
 * being reopened (pi would otherwise open a brand-new session under the old
 * run and pretend it continued).
 *
 * A record without a session file keeps the historical behaviour: the
 * configured `session: "continue"`/`"new"` mode decides. Pure clock/FS seam:
 * `fileSizeBytes` is `undefined` for a missing or unreadable file.
 */
export function startupResumeDecision(
	record: RunRecord | undefined,
	now: number,
	windowMs: number,
	sessionFile: string | undefined,
	fileSizeBytes: number | undefined,
): StartupResumeDecision {
	const decision = interruptedResumeDecision(record, now, windowMs);
	if (decision !== "resume") return decision;
	if (!sessionFile) return "resume";
	return resumeFileUsable(sessionFile, fileSizeBytes) ? "resume" : "unusable";
}

export interface UsageBucket {
	cost: number;
	runs: number;
	turns: number;
	input: number;
	output: number;
}

interface UsageFile {
	days: Record<string, UsageBucket>;
	runTimes?: number[];
}

/**
 * Durable record of every run: what came in, what the agent did, what it cost,
 * and how much of its life it spent waiting. Also owns the daily/hourly usage
 * counters used by the budget guard.
 */
export class RunLog {
	private readonly file: string;
	private readonly usageFile: string;
	private index: number;

	constructor(stateDir: string) {
		this.file = path.join(stateDir, "runs", "runs.jsonl");
		this.usageFile = path.join(stateDir, "usage.json");
		ensureDir(path.dirname(this.file));
		this.index = readJsonl<RunRecord>(this.file).length;
	}

	nextIndex(): number {
		this.index += 1;
		return this.index;
	}

	/**
	 * Persist a run. A resumed run keeps its original id: the existing line is
	 * replaced in place (never duplicated) and only the usage delta is added to
	 * the daily counters, so index, startedAt, turns, tokens, cost and outbound
	 * accumulate instead of resetting.
	 */
	record(record: RunRecord): void {
		const all = readJsonl<RunRecord>(this.file);
		const previousIndex = all.findIndex((candidate) => candidate.id === record.id);
		if (previousIndex === -1) {
			appendJsonl(this.file, record);
			this.applyUsage(record, 1);
			return;
		}
		const previous = all[previousIndex]!;
		// A replacement means the interrupted run was resumed and closed again;
		// keep the earlier stops so the history does not lose the interruption (#185).
		const history = runInterruptions(previous);
		if (isRunInterruption(previous)) {
			const entry: RunInterruption = {
				stoppedBy: runStoppedBy(previous),
				stopReason: previous.stopReason,
				at: previous.finishedAt,
			};
			const last = history[history.length - 1];
			const duplicate =
				last !== undefined &&
				last.stoppedBy === entry.stoppedBy &&
				last.stopReason === entry.stopReason &&
				last.at === entry.at;
			if (!duplicate) history.push(entry);
		}
		all[previousIndex] = { ...record, interruptedBy: history.length > 0 ? history : undefined };
		writeJsonlAtomic(this.file, all);
		this.applyUsage(previous, -1);
		this.applyUsage(record, 1);
	}

	/**
	 * Close a run whose stop reason became stale (an `interrupted` run that is
	 * older than the resume window, or one whose session file is gone). Usage and
	 * timing stay untouched: only the audit outcome changes. An optional `reason`
	 * (#173) is persisted in the existing `error` field so the record says why the
	 * outcome changed instead of only that it did.
	 */
	reclassify(id: string, to: RunStopReason, from?: RunStopReason, reason?: string): RunRecord | undefined {
		const all = readJsonl<RunRecord>(this.file);
		const index = all.findIndex((candidate) => candidate.id === id && (from === undefined || candidate.stopReason === from));
		if (index === -1) return undefined;
		const updated = { ...all[index]!, stopReason: to, ...(reason ? { error: reason } : {}) };
		all[index] = updated;
		writeJsonlAtomic(this.file, all);
		return updated;
	}

	/** Most recent run that ended `interrupted`, if it is the last record. */
	lastInterrupted(): RunRecord | undefined {
		const last = this.last();
		return last?.stopReason === "interrupted" ? last : undefined;
	}

	list(limit = 20): RunRecord[] {
		const all = readJsonl<RunRecord>(this.file);
		return all.slice(-limit);
	}

	last(): RunRecord | undefined {
		const all = this.list(1);
		return all[all.length - 1];
	}

	usageToday(now = Date.now()): UsageBucket {
		const usage = readJson<UsageFile>(this.usageFile, { days: {} });
		return usage.days[localDay(now)] ?? { cost: 0, runs: 0, turns: 0, input: 0, output: 0 };
	}

	runsLastHour(now = Date.now()): number {
		const usage = readJson<UsageFile>(this.usageFile, { days: {} });
		const cutoff = now - 3_600_000;
		return (usage.runTimes ?? []).filter((ts) => ts > cutoff).length;
	}

	/**
	 * Add (`direction = 1`) or subtract (`direction = -1`) one record's
	 * contribution to the daily/hourly counters. Subtracting the previous version
	 * before adding the resumed version makes a resume a delta, not a new run.
	 */
	private applyUsage(record: RunRecord, direction: 1 | -1): void {
		const usage = readJson<UsageFile>(this.usageFile, { days: {} });
		const day = localDay(record.finishedAt);
		const bucket = usage.days[day] ?? { cost: 0, runs: 0, turns: 0, input: 0, output: 0 };
		bucket.cost += direction * record.usage.cost;
		bucket.runs += direction;
		bucket.turns += direction * runTurnCount(record);
		bucket.input += direction * record.usage.input;
		bucket.output += direction * record.usage.output;
		if (bucket.runs <= 0 && bucket.turns <= 0 && bucket.cost <= 0 && bucket.input <= 0 && bucket.output <= 0) {
			delete usage.days[day];
		} else {
			usage.days[day] = bucket;
		}
		const recent = (usage.runTimes ?? []).filter((ts) => ts > Date.now() - 3_600_000);
		if (direction === 1) {
			recent.push(record.finishedAt);
		} else {
			const index = recent.lastIndexOf(record.finishedAt);
			if (index !== -1) recent.splice(index, 1);
		}
		usage.runTimes = recent;
		const days = Object.keys(usage.days).sort();
		for (const old of days.slice(0, Math.max(0, days.length - 30))) delete usage.days[old];
		writeJsonAtomic(this.usageFile, usage);
	}
}

export type RuntimeStatusKind = "starting" | "working" | "idle" | "paused-budget" | "stopped" | "stalled" | "error";

export interface RuntimeStateFile {
	pid: number;
	startedAt: number;
	lastTickAt: number;
	status: RuntimeStatusKind;
	runIndex: number;
	runId?: string;
	sessionFile?: string;
	model?: string;
	pending: number;
	openThreads: number;
	/** True while the agent is blocked inside `idle`. */
	idling?: boolean;
	/** Timestamp when the current idle began. */
	idleSince?: number;
	/** How many full context resets (sleeps) this process has performed. */
	sleeps: number;
	/** Consecutive idle intervals that ended with an empty inbox (#116). */
	emptyWakes?: number;
	/** `background` for a detached CLI instance, `foreground` for an attached one. */
	mode?: "background" | "foreground";
	/** Last auto-compaction outcome (#167), so operators see why context is growing. */
	lastCompaction?: CompactionRecord;
	/** Current context (pi's prompt estimate) in tokens (#170); absent while unknown. */
	contextTokens?: number;
	/**
	 * The tool call running right now (#164), so the dashboard can show it and
	 * mark a call that has outlived `loop.toolLongMs`. Absent while no tool runs.
	 */
	activeTool?: RuntimeActiveTool;
	/**
	 * An open run that stopped ticking (#173). Additive and optional: older state
	 * files do not carry it, and a reader can derive the same view from
	 * `lastTickAt` with `detectRunStall()`.
	 */
	runStalled?: RunStalled;
	error?: string;
}

/** One observed stall of an open run (#173). */
export interface RunStalled {
	/** The tick that went stale (the last state write before the gap). */
	since: number;
	/** Age of that tick when the stall was observed. */
	ageMs: number;
	/** Configured `loop.runStallMs` threshold that fired (0 = detection off). */
	thresholdMs: number;
	runId?: string;
}

/**
 * Detect an open run whose runtime stopped ticking (#173).
 *
 * Pure clock seam: `lastTickAt` comes from `runtime.json`, so `alive status` and
 * the dashboard can flag a frozen run even when the process can no longer write
 * its own state. A run is open exactly when `runtime.json` carries a `runId`;
 * without one there is nothing to stall.
 */
export function detectRunStall(input: {
	runId?: string;
	lastTickAt?: number;
	now: number;
	thresholdMs: number;
}): RunStalled | undefined {
	if (!(input.thresholdMs > 0)) return undefined;
	if (!input.runId) return undefined;
	if (typeof input.lastTickAt !== "number" || !Number.isFinite(input.lastTickAt)) return undefined;
	const ageMs = Math.max(0, input.now - input.lastTickAt);
	if (ageMs < input.thresholdMs) return undefined;
	return { since: input.lastTickAt, ageMs, thresholdMs: input.thresholdMs, runId: input.runId };
}

export interface RuntimeActiveTool {
	name: string;
	startedAt: number;
	runId?: string;
}

export function writeRuntimeState(stateDir: string, state: RuntimeStateFile): void {
	writeJsonAtomic(path.join(stateDir, "runtime.json"), state);
}

export function readRuntimeState(stateDir: string): RuntimeStateFile | null {
	return readJson<RuntimeStateFile | null>(path.join(stateDir, "runtime.json"), null);
}
