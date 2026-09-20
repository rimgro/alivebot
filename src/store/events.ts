import * as fs from "node:fs";
import * as path from "node:path";
import { ensureDir, iso, newId, oneLine, readJson, writeJsonAtomic } from "../util.js";

export type EventKind = "user_message" | "reminder" | "observability" | "heartbeat" | "system";
export type EventPriority = "low" | "normal" | "high" | "interrupt";

/**
 * A durable unit of "something happened".
 *
 * The inbox is an append-only JSONL file. Sequence numbers are derived from
 * line numbers, so any number of external processes can append events safely
 * without coordinating with the runtime (single O_APPEND writes are atomic).
 */
export interface AliveEvent {
	seq: number;
	id: string;
	ts: number;
	kind: EventKind;
	source: string;
	priority: EventPriority;
	title: string;
	text: string;
	payload?: unknown;
	thread?: string;
	expectsReply?: boolean;
	dedupeKey?: string;
	meta?: Record<string, unknown>;
}

export type NewEvent = Omit<AliveEvent, "seq" | "id" | "ts"> & {
	id?: string;
	ts?: number;
};

export interface RunCursor {
	ackedSeq: number;
	openRun: { runId: string; lastSeq: number } | null;
}

export interface StoreStatus {
	totalEvents: number;
	ackedSeq: number;
	openRunId: string | null;
	pending: number;
	unclaimed: number;
}

/**
 * Durable, append-only event inbox with an at-least-once delivery cursor.
 *
 * Cursor semantics:
 *   - `ackedSeq`: everything up to here has been delivered to the agent and the
 *     agent has come back to `idle` (or the run ended cleanly), so it is done
 *     with it.
 *   - `openRun.lastSeq`: everything up to here has been handed to the *current*
 *     run (either in its opening prompt, by an `idle` return, or as a steered
 *     interrupt) but not yet acknowledged.
 *
 * `idle` acknowledges the previous batch before it starts waiting again: the
 * agent only calls `idle` when it is done with what it was given, which keeps
 * crash redelivery bounded to at most the in-flight batch instead of the whole
 * (potentially hours-long) run.
 *
 * If the process dies during a run, `recoverAfterCrash()` drops the open marker
 * without advancing `ackedSeq`, so the unacknowledged events are re-delivered
 * next time with a "redelivered" marker.
 */
export class EventStore {
	private readonly file: string;
	private readonly cursorFile: string;
	private events: AliveEvent[] = [];
	private cursor: RunCursor = { ackedSeq: 0, openRun: null };
	private offset = 0;
	private dedupe = new Map<string, AliveEvent>();

	private constructor(file: string, cursorFile: string) {
		this.file = file;
		this.cursorFile = cursorFile;
	}

	static open(stateDir: string): EventStore {
		const dir = path.join(stateDir, "inbox");
		ensureDir(dir);
		const store = new EventStore(path.join(dir, "events.jsonl"), path.join(dir, "cursor.json"));
		store.cursor = normalizeCursor(readJson<unknown>(store.cursorFile, null));
		store.refresh();
		return store;
	}

	/** Re-read everything appended since the last refresh (possibly by another process). */
	refresh(): void {
		let size: number;
		try {
			size = fs.statSync(this.file).size;
		} catch {
			return;
		}
		if (size === this.offset) return;
		if (size < this.offset) {
			// File was truncated/replaced: rebuild from scratch.
			this.events = [];
			this.offset = 0;
		}
		const fd = fs.openSync(this.file, "r");
		try {
			const length = size - this.offset;
			const buffer = Buffer.alloc(length);
			fs.readSync(fd, buffer, 0, length, this.offset);
			this.offset = size;
			for (const line of buffer.toString("utf8").split("\n")) {
				const trimmed = line.trim();
				if (!trimmed) continue;
				try {
					const parsed = JSON.parse(trimmed) as Omit<AliveEvent, "seq">;
					const event: AliveEvent = { ...parsed, seq: this.events.length + 1 };
					this.events.push(event);
					if (event.dedupeKey) this.dedupe.set(event.dedupeKey, event);
				} catch {
					// Skip corrupt lines rather than losing the whole inbox.
				}
			}
		} finally {
			fs.closeSync(fd);
		}
	}

	append(input: NewEvent): AliveEvent {
		this.refresh();
		if (input.dedupeKey) {
			const existing = this.dedupe.get(input.dedupeKey);
			if (existing) return existing;
		}
		const event: Omit<AliveEvent, "seq"> = {
			id: input.id ?? newId("evt"),
			ts: input.ts ?? Date.now(),
			kind: input.kind,
			source: input.source,
			priority: input.priority ?? "normal",
			title: input.title ?? oneLine(input.text, 80),
			text: input.text,
			payload: input.payload,
			thread: input.thread,
			expectsReply: input.expectsReply,
			dedupeKey: input.dedupeKey,
			meta: input.meta,
		};
		ensureDir(path.dirname(this.file));
		fs.appendFileSync(this.file, `${JSON.stringify(event)}\n`, "utf8");
		this.refresh();
		const stored = this.events[this.events.length - 1];
		if (!stored) throw new Error("event append failed");
		return stored;
	}

	private cursorSeq(): number {
		return this.cursor.openRun ? this.cursor.openRun.lastSeq : this.cursor.ackedSeq;
	}

	peekPending(max: number): AliveEvent[] {
		this.refresh();
		const from = this.cursorSeq();
		return this.events.filter((e) => e.seq > from).slice(0, max);
	}

	pendingCount(): number {
		this.refresh();
		return Math.max(0, this.events.length - this.cursorSeq());
	}

	/** Start a run: the cursor stops advancing by ack and starts advancing by claim. */
	beginRun(runId: string): void {
		this.refresh();
		this.cursor.openRun = { runId, lastSeq: this.cursor.ackedSeq };
		this.saveCursor();
	}

	/**
	 * Claim up to `max` pending events for the current run. Returns events that
	 * were not handed to the agent before (either brand new, or redelivered after
	 * a crash because they were never acknowledged).
	 */
	claim(max: number): AliveEvent[] {
		this.refresh();
		if (!this.cursor.openRun) throw new Error("claim() called outside a run");
		const from = this.cursor.openRun.lastSeq;
		const claimed = this.events.filter((e) => e.seq > from).slice(0, max);
		if (claimed.length === 0) return [];
		this.cursor.openRun.lastSeq = claimed[claimed.length - 1]!.seq;
		this.saveCursor();
		return claimed;
	}

	/**
	 * Claim the pending prefix up to (and including) the last event matching
	 * `predicate` inside a window of `max` pending events.
	 *
	 * Used for mid-wake interrupts: sequence numbers stay gap-free, so an
	 * interrupt never silently swallows newer normal events that were already
	 * queued behind it.
	 */
	claimPrefix(max: number, predicate: (event: AliveEvent) => boolean): AliveEvent[] {
		this.refresh();
		if (!this.cursor.openRun) throw new Error("claimPrefix() called outside a run");
		const pending = this.events.filter((e) => e.seq > this.cursor.openRun!.lastSeq).slice(0, max);
		let lastMatch = -1;
		for (let i = 0; i < pending.length; i += 1) {
			if (predicate(pending[i]!)) lastMatch = i;
		}
		if (lastMatch < 0) return [];
		const claimed = pending.slice(0, lastMatch + 1);
		this.cursor.openRun.lastSeq = claimed[claimed.length - 1]!.seq;
		this.saveCursor();
		return claimed;
	}

	/**
	 * Mark everything handed to the current run as handled, but keep the run open.
	 *
	 * The idle tool calls this on entry: the agent only returns to idle once it is
	 * done with the previous batch, so acknowledging keeps crash redelivery bounded
	 * to the in-flight batch while the run itself continues for as long as the
	 * agent wants.
	 */
	ack(): void {
		if (!this.cursor.openRun) return;
		this.cursor.ackedSeq = this.cursor.openRun.lastSeq;
		this.cursor.openRun.lastSeq = this.cursor.ackedSeq;
		this.saveCursor();
	}

	/** Acknowledge the remaining batch and close the run. Called when a run ends cleanly. */
	endRun(): void {
		if (!this.cursor.openRun) return;
		this.cursor.ackedSeq = this.cursor.openRun.lastSeq;
		this.cursor.openRun = null;
		this.saveCursor();
	}

	/**
	 * Drop the current claim without acknowledging: used when the run did not
	 * finish cleanly (error/timeout/abort), so in-flight events are redelivered
	 * instead of being lost.
	 */
	rollbackClaim(): void {
		if (!this.cursor.openRun) return;
		this.cursor.openRun = null;
		this.saveCursor();
	}

	get openRunId(): string | null {
		return this.cursor.openRun?.runId ?? null;
	}

	get ackedSeq(): number {
		return this.cursor.ackedSeq;
	}

	/**
	 * Called once on startup. If a run was interrupted by a crash, its in-flight
	 * events were never acknowledged: drop the open marker so they are pending
	 * again and report the range so the next prompt can mark them as redelivered.
	 */
	recoverAfterCrash(): { fromSeq: number; toSeq: number } | null {
		this.refresh();
		const open = this.cursor.openRun;
		if (!open) return null;
		const range = { fromSeq: this.cursor.ackedSeq + 1, toSeq: open.lastSeq };
		this.cursor.openRun = null;
		this.saveCursor();
		if (range.toSeq < range.fromSeq) return null;
		return range;
	}

	status(): StoreStatus {
		this.refresh();
		return {
			totalEvents: this.events.length,
			ackedSeq: this.cursor.ackedSeq,
			openRunId: this.cursor.openRun?.runId ?? null,
			pending: this.pendingCount(),
			unclaimed: Math.max(0, this.events.length - this.cursor.ackedSeq),
		};
	}

	all(): AliveEvent[] {
		this.refresh();
		return this.events;
	}

	toPromptLine(event: AliveEvent, options: { redelivered: boolean }): string {
		const flags: string[] = [event.kind, `priority=${event.priority}`];
		if (event.thread) flags.push(`thread=${event.thread}`);
		if (event.expectsReply) flags.push("expects_reply");
		if (options.redelivered) flags.push("REDELIVERED");
		const indent = (value: string) =>
			value
				.split("\n")
				.map((line) => `    ${line}`)
				.join("\n");
		const header = `[${event.seq}] ${flags.join(" | ")} @ ${iso(event.ts)}`;
		const payload =
			event.payload === undefined ? "" : `\n    payload: ${JSON.stringify(event.payload).slice(0, 1200)}`;
		return `${header}\n    title: ${event.title}\n${indent(event.text)}${payload}`;
	}

	private saveCursor(): void {
		writeJsonAtomic(this.cursorFile, this.cursor);
	}
}

/** Accept cursor files written by the wake-per-batch runtime. */
function normalizeCursor(value: unknown): RunCursor {
	const fallback: RunCursor = { ackedSeq: 0, openRun: null };
	if (!value || typeof value !== "object") return fallback;
	const raw = value as Record<string, unknown>;
	const ackedSeq = typeof raw.ackedSeq === "number" ? raw.ackedSeq : 0;
	const open = (raw.openRun ?? raw.openWake) as { wakeId?: string; runId?: string; lastSeq?: number } | null | undefined;
	if (!open || typeof open.lastSeq !== "number") return { ackedSeq, openRun: null };
	return { ackedSeq, openRun: { runId: open.runId ?? open.wakeId ?? "unknown", lastSeq: open.lastSeq } };
}
