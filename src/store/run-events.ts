import * as path from "node:path";
import { appendJsonl, ensureDir, readJsonl } from "../util.js";

/**
 * Run-anomaly events the runtime records about its own runs (#127).
 *
 * These replace the old habit of killing a run at a wall clock. The runtime
 * keeps working and, when something looks wrong, writes one structured event
 * here (and a matching line into the structured log). The payload is counters
 * only: run id, agent, how long the run worked, how many turns it took, how
 * many messages it sent. **No prompt, message or tool-argument text is ever
 * stored** — arguments can contain conversation content.
 *
 * One file per profile: `<stateDir>/runs/events.jsonl`, next to `runs.jsonl`.
 */
export type RunAnomalyType = "run_long" | "run_no_outbound" | "run_repeat_tool" | "run_very_long";

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
	/** `run_repeat_tool`: the tool name. Arguments are deliberately not recorded. */
	tool?: string;
	/** `run_repeat_tool`: how many times in a row the same call was repeated. */
	repeats?: number;
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
