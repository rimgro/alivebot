import * as path from "node:path";
import { appendJsonl, ensureDir, readJsonl } from "../util.js";
import type { CompactionFailureClass, ContextResetReason } from "./runs.js";

/**
 * Run-anomaly events the runtime records about its own runs (#127, #123).
 *
 * These replace the old habit of killing a run at a wall clock. The runtime
 * keeps working and, when something looks wrong, writes one structured event
 * here (and a matching line into the structured log). The payload is counters
 * only: run id, agent, how long the run worked, how many turns it took, how
 * many messages it sent. **No prompt, message or tool-argument text is ever
 * stored** — arguments can contain conversation content.
 *
 * `context_high` (#123) is the one event that is also a hint: it records that
 * the session context crossed `loop.contextWarnTokens` and the agent was asked
 * to sleep only if the task is finished or it is switching to unrelated work.
 * It is recorded once per crossing, not per turn.
 *
 * `context_reset` (#170) records that the runtime forced a sleep at a step
 * boundary because the context crossed the soft or hard ceiling (or compaction
 * kept failing). Unlike `context_high`, the run does not continue: its next run
 * starts with an empty context.
 *
 * `tool_long` (#164) records one tool call that has been running longer than
 * `loop.toolLongMs`. It is a visible anomaly, not a limit: neither the tool nor
 * the run is stopped. The operator can abort only that tool through the
 * dashboard button, the owner Telegram command or `alive abort-tool <agent>`.
 *
 * One file per profile: `<stateDir>/runs/events.jsonl`, next to `runs.jsonl`.
 */
export type RunAnomalyType =
	| "run_long"
	| "run_no_outbound"
	| "run_repeat_tool"
	| "run_very_long"
	| "tool_long"
	| "context_high"
	| "context_reset"
	| "compaction_failed";

export interface RunAnomalyEvent {
	/** Wall clock of the event. */
	ts: number;
	type: RunAnomalyType;
	/** Profile/agent name (`config.name`), so events from several profiles can share a sink. */
	agent: string;
	runId: string;
	runIndex: number;
	/** Active (non-idle) milliseconds at the moment of the event. */
	activeMs: number;
	/** Wall-clock age of the run, idle included. */
	durationMs: number;
	idleMs: number;
	/** Model turns completed so far. */
	turns: number;
	/** Outbound messages sent so far. */
	outbound: number;
	/** Inbound events delivered to the run so far. */
	events: number;
	/** `run_long`/`run_very_long`: the threshold that fired, for reference. */
	limitMs?: number;
	/** `run_no_outbound`: the turn threshold that fired, for reference. */
	limitTurns?: number;
	/**
	 * `context_high`: current context size in tokens. This is pi's prompt/context
	 * estimate (`contextUsage.tokens`), never cumulative billing.
	 */
	contextTokens?: number;
	/** `context_high`/`context_reset`: the configured threshold that fired. */
	limitTokens?: number;
	/** `context_reset`: why `sleepForced` happened — soft grace, the hard ceiling, or repeated compaction failures. */
	resetReason?: ContextResetReason;
	/** `run_repeat_tool`/`tool_long`: the tool name. Arguments are deliberately not recorded. */
	tool?: string;
	/** `run_repeat_tool`: how many times in a row the same call was repeated. */
	repeats?: number;
	/** `tool_long`: how long the single tool call has been running when the anomaly fired. */
	toolMs?: number;
	/** `compaction_failed`: why the summarization response was rejected (#167). */
	reasonClass?: CompactionFailureClass;
	/** `compaction_failed`: provider attempt number that failed (0 = deferred by backoff). */
	attempt?: number;
	/** `compaction_failed`: attempt budget for one summarization call. */
	maxAttempts?: number;
}

/** Anything that can persist a run-anomaly event (the runtime uses `RunEventLog`). */
export interface RunEventSink {
	append(event: RunAnomalyEvent): void;
}

/** Append-only JSONL sink for run-anomaly events. */
export class RunEventLog implements RunEventSink {
	private readonly file: string;

	constructor(stateDir: string) {
		this.file = path.join(stateDir, "runs", "events.jsonl");
		ensureDir(path.dirname(this.file));
	}

	append(event: RunAnomalyEvent): void {
		appendJsonl(this.file, event);
	}

	/** Recorded events, oldest first (bounded to the last `limit`). */
	list(limit = 100): RunAnomalyEvent[] {
		const all = readJsonl<RunAnomalyEvent>(this.file);
		return all.slice(-limit);
	}
}
