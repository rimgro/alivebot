import * as path from "node:path";
import { appendJsonl, ensureDir, localDay, readJson, readJsonl, writeJsonAtomic } from "../util.js";

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
	| "aborted";

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
	events: RunEventSummary[];
	outbound: Array<{ thread: string; text: string; delivered: boolean }>;
	remindersCreated: string[];
	notesTouched: string[];
	journalEntries: number;
	/** How many times the agent returned from idle with events. */
	idleReturns: number;
	/** How many policy-approved events were steered in while working. */
	interruptDeliveries: number;
	/** How many times we had to re-prompt after a stop without idle/sleep. */
	nudges: number;
	turns: number;
	promptChars: number;
	usage: { input: number; output: number; cacheRead: number; cacheWrite: number; total: number; cost: number };
	sleep?: { forced: boolean; summaryChars: number };
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

	record(record: RunRecord): void {
		appendJsonl(this.file, record);
		this.bumpUsage(record);
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

	private bumpUsage(record: RunRecord): void {
		const usage = readJson<UsageFile>(this.usageFile, { days: {} });
		const day = localDay(record.finishedAt);
		const bucket = usage.days[day] ?? { cost: 0, runs: 0, turns: 0, input: 0, output: 0 };
		bucket.cost += record.usage.cost;
		bucket.runs += 1;
		bucket.turns += record.turns;
		bucket.input += record.usage.input;
		bucket.output += record.usage.output;
		usage.days[day] = bucket;
		usage.runTimes = [...(usage.runTimes ?? []), record.finishedAt].filter((ts) => ts > Date.now() - 3_600_000);
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
