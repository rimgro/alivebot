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
	error?: string;
	/** Pi session file backing this run, so a resume can reopen the exact session. */
	sessionFile?: string;
	/** Human-readable interruption summary, written when a harness restart drains the run. */
	summary?: string;
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
	 * Per-turn usage captured while the run happened (bounded to the last
	 * `RUN_TURN_TRACE_LIMIT` turns). Absent on records written before #121.
	 */
	turns?: RunTurnTrace[];
	sleep?: { forced: boolean; summaryChars: number };
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
		all[previousIndex] = record;
		writeJsonlAtomic(this.file, all);
		this.applyUsage(previous, -1);
		this.applyUsage(record, 1);
	}

	/**
	 * Close a run whose stop reason became stale (an `interrupted` run that is
	 * older than the resume window). Usage and timing stay untouched: only the
	 * audit outcome changes.
	 */
	reclassify(id: string, to: RunStopReason, from?: RunStopReason): RunRecord | undefined {
		const all = readJsonl<RunRecord>(this.file);
		const index = all.findIndex((candidate) => candidate.id === id && (from === undefined || candidate.stopReason === from));
		if (index === -1) return undefined;
		const updated = { ...all[index]!, stopReason: to };
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

export type RuntimeStatusKind = "starting" | "working" | "idle" | "paused-budget" | "stopped";

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
	error?: string;
}

export function writeRuntimeState(stateDir: string, state: RuntimeStateFile): void {
	writeJsonAtomic(path.join(stateDir, "runtime.json"), state);
}

export function readRuntimeState(stateDir: string): RuntimeStateFile | null {
	return readJson<RuntimeStateFile | null>(path.join(stateDir, "runtime.json"), null);
}
