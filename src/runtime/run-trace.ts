/**
 * Per-turn usage trace for a run (#121).
 *
 * The pi session emits `turn_start` before each assistant response and
 * `turn_end` with the assistant message (which carries the provider's token
 * usage and cost) plus the tool results of that turn. `AgentRunner` already
 * subscribes to those events; this recorder turns them into the bounded
 * per-step cost breakdown stored on the run record.
 *
 * The recorder never invents numbers: a turn without an assistant message is
 * skipped, and missing usage fields fall back to 0 only because the provider
 * itself reported no tokens for that field.
 */
import { RUN_TURN_TRACE_LIMIT, type RunTurnTrace, type RunUsage } from "../store/runs.js";

function numberOrZero(value: unknown): number {
	return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

/** A zeroed usage object (`RunUsage` is always fully populated). */
export function zeroUsage(): RunUsage {
	return { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0, cost: 0 };
}

/** True when a usage object reports any token or any cost. */
export function hasUsage(usage: RunUsage): boolean {
	return (
		usage.input !== 0 ||
		usage.output !== 0 ||
		usage.cacheRead !== 0 ||
		usage.cacheWrite !== 0 ||
		usage.total !== 0 ||
		usage.cost !== 0
	);
}

/** Per-field slack below which a residual is floating-point noise, not spend. */
export const RESIDUAL_USAGE_EPSILON = 1e-9;

/**
 * The spend of a run segment that none of its per-turn traces accounts for.
 *
 * `total` is the session-stats delta of the segment (measured from the snapshot
 * taken at run start, never from session start); `traces` are the confirmed
 * `turn_end` steps recorded during that same segment. A provider that bills a
 * step without ever sending `turn_end` leaves a positive residual, which the
 * run record surfaces as `usageUnsettled` (#168). Every field is clamped at 0:
 * an over-reported trace (a resumed session, a provider that settles twice)
 * must never produce negative numbers, and sub-epsilon float noise is not spend.
 */
export function residualUsage(total: RunUsage, traces: ReadonlyArray<{ usage: RunUsage }>): RunUsage {
	const attributed = zeroUsage();
	for (const trace of traces) {
		attributed.input += numberOrZero(trace.usage?.input);
		attributed.output += numberOrZero(trace.usage?.output);
		attributed.cacheRead += numberOrZero(trace.usage?.cacheRead);
		attributed.cacheWrite += numberOrZero(trace.usage?.cacheWrite);
		attributed.total += numberOrZero(trace.usage?.total);
		attributed.cost += numberOrZero(trace.usage?.cost);
	}
	const delta = (difference: number): number => {
		// Sub-epsilon differences are float noise (0.01 + 0.01 is not 0.02), not spend.
		return difference > RESIDUAL_USAGE_EPSILON ? difference : 0;
	};
	return {
		input: delta(total.input - attributed.input),
		output: delta(total.output - attributed.output),
		cacheRead: delta(total.cacheRead - attributed.cacheRead),
		cacheWrite: delta(total.cacheWrite - attributed.cacheWrite),
		total: delta(total.total - attributed.total),
		cost: delta(total.cost - attributed.cost),
	};
}

/**
 * Read the usage of one assistant message.
 *
 * pi-ai reports `{ input, output, cacheRead, cacheWrite, totalTokens, cost: { total } }`;
 * older/test messages may omit some fields, so every read is guarded.
 */
export function usageFromMessage(message: unknown): RunUsage {
	const usage = message && typeof message === "object"
		? (message as { usage?: unknown }).usage
		: undefined;
	const fields = usage && typeof usage === "object" ? (usage as Record<string, unknown>) : {};
	const input = numberOrZero(fields.input);
	const output = numberOrZero(fields.output);
	const cacheRead = numberOrZero(fields.cacheRead);
	const cacheWrite = numberOrZero(fields.cacheWrite);
	const reportedTotal = fields.totalTokens;
	const total = typeof reportedTotal === "number" && Number.isFinite(reportedTotal) && reportedTotal > 0
		? reportedTotal
		: input + output + cacheRead + cacheWrite;
	const costField = fields.cost;
	const cost = typeof costField === "number"
		? numberOrZero(costField)
		: costField && typeof costField === "object"
			? numberOrZero((costField as Record<string, unknown>).total)
			: 0;
	return { input, output, cacheRead, cacheWrite, total, cost };
}

/** Unique tool names in call order: message tool calls first, then tool results. */
function toolNames(message: Record<string, unknown>, toolResults: unknown): string[] {
	const names: string[] = [];
	const push = (name: unknown): void => {
		if (typeof name === "string" && name.length > 0 && !names.includes(name)) names.push(name);
	};
	if (Array.isArray(message.content)) {
		for (const part of message.content) {
			if (!part || typeof part !== "object") continue;
			const record = part as Record<string, unknown>;
			if (record.type === "toolCall") push(record.name);
		}
	}
	if (Array.isArray(toolResults)) {
		for (const result of toolResults) {
			if (!result || typeof result !== "object") continue;
			push((result as Record<string, unknown>).toolName);
		}
	}
	return names;
}

export interface TurnEndInput {
	/** The assistant message of the finished turn (`turn_end.message`). */
	message?: unknown;
	/** The tool results of the finished turn (`turn_end.toolResults`). */
	toolResults?: unknown;
	/** Clock seam for tests; defaults to the wall clock. */
	at?: number;
}

/**
 * Accumulates per-turn usage for one run.
 *
 * The buffer is bounded: only the last `RUN_TURN_TRACE_LIMIT` turns survive, so
 * a pathological run cannot grow `runs.jsonl` without limit. Kept turn indexes
 * stay absolute, which lets the dashboard detect a truncated trace.
 */
export class TurnTraceRecorder {
	private buffer: RunTurnTrace[] = [];
	private startedAt: number | undefined;
	private count = 0;
	/** Spend already attributed to confirmed turns since the last `reset()`. */
	private attributed = zeroUsage();

	constructor(private readonly now: () => number = Date.now) {}

	/**
	 * Called when a run starts. A resumed run seeds the recorder with its prior
	 * traces and turn count so new steps continue at the next absolute index.
	 * The attributed-usage counter is per segment: the caller subtracts it from
	 * the session-stats delta of the same segment.
	 */
	reset(previous: { turns?: RunTurnTrace[]; count?: number } = {}): void {
		this.buffer = (previous.turns ?? []).map((trace) => ({
			...trace,
			usage: { ...trace.usage },
			tools: [...trace.tools],
		}));
		this.startedAt = undefined;
		this.attributed = zeroUsage();
		const lastIndex = this.buffer[this.buffer.length - 1]?.index ?? 0;
		this.count = Math.max(previous.count ?? 0, lastIndex, this.buffer.length);
	}

	/** Usage of every confirmed turn recorded since the last `reset()`. */
	usageSinceReset(): RunUsage {
		return { ...this.attributed };
	}

	/** `turn_start`: remember when the turn began. */
	startTurn(at = this.now()): void {
		this.startedAt = at;
	}

	/**
	 * `turn_end`: append the turn if the session actually produced an assistant
	 * message. Returns the stored trace, or undefined when the event was ignored.
	 */
	endTurn(input: TurnEndInput = {}): RunTurnTrace | undefined {
		const at = input.at ?? this.now();
		const startedAt = this.startedAt ?? at;
		this.startedAt = undefined;
		const message = input.message;
		if (!message || typeof message !== "object") return undefined;
		const fields = message as Record<string, unknown>;
		// A turn without an assistant message would be a zero-cost fiction.
		if (fields.role !== undefined && fields.role !== "assistant") return undefined;
		this.count += 1;
		const usage = usageFromMessage(fields);
		this.attributed.input += usage.input;
		this.attributed.output += usage.output;
		this.attributed.cacheRead += usage.cacheRead;
		this.attributed.cacheWrite += usage.cacheWrite;
		this.attributed.total += usage.total;
		this.attributed.cost += usage.cost;
		const trace: RunTurnTrace = {
			index: this.count,
			startedAt,
			durationMs: Math.max(0, at - startedAt),
			usage,
			tools: toolNames(fields, input.toolResults),
		};
		this.buffer.push(trace);
		if (this.buffer.length > RUN_TURN_TRACE_LIMIT) {
			this.buffer.splice(0, this.buffer.length - RUN_TURN_TRACE_LIMIT);
		}
		return trace;
	}

	/** Turns collected so far, oldest first (a copy, safe to persist). */
	snapshot(): RunTurnTrace[] {
		return this.buffer.map((trace) => ({ ...trace, usage: { ...trace.usage }, tools: [...trace.tools] }));
	}
}
