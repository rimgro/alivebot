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

	constructor(private readonly now: () => number = Date.now) {}

	/**
	 * Called when a run starts. A resumed run seeds the recorder with its prior
	 * traces and turn count so new steps continue at the next absolute index.
	 */
	reset(previous: { turns?: RunTurnTrace[]; count?: number } = {}): void {
		this.buffer = (previous.turns ?? []).map((trace) => ({
			...trace,
			usage: { ...trace.usage },
			tools: [...trace.tools],
		}));
		this.startedAt = undefined;
		const lastIndex = this.buffer[this.buffer.length - 1]?.index ?? 0;
		this.count = Math.max(previous.count ?? 0, lastIndex, this.buffer.length);
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
		const trace: RunTurnTrace = {
			index: this.count,
			startedAt,
			durationMs: Math.max(0, at - startedAt),
			usage: usageFromMessage(fields),
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
