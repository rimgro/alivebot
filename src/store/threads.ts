import * as path from "node:path";
import { readJson, writeJsonAtomic } from "../util.js";

export interface ThreadState {
	thread: string;
	lastInboundAt: number;
	lastOutboundAt?: number;
	unansweredSince?: number;
	/** How many wake prompts carried this thread as unanswered. */
	attempts: number;
	/** Wake id of the last nudge, for introspecting why a thread went stale. */
	lastNudgedRunId?: string;
	closedAt?: number;
	closeReason?: string;
}

/**
 * Tracks open conversations.
 *
 * This is the enforcement layer behind "messages are sent by tool call, not by
 * text": a user message that expects a reply stays visible in every following
 * wake prompt until the agent either sends a message to that thread or closes
 * it explicitly. Assistant text does not clear it — only a `send_message` tool
 * call does.
 */
export class ThreadStore {
	private readonly file: string;

	constructor(stateDir: string) {
		this.file = path.join(stateDir, "threads.json");
		if (!readJson<Record<string, ThreadState> | null>(this.file, null)) writeJsonAtomic(this.file, {});
	}

	private load(): Record<string, ThreadState> {
		return readJson<Record<string, ThreadState>>(this.file, {});
	}

	private save(all: Record<string, ThreadState>): void {
		writeJsonAtomic(this.file, all);
	}

	recordInbound(thread: string, ts: number, expectsReply: boolean): void {
		const all = this.load();
		const state = all[thread] ?? { thread, lastInboundAt: ts, attempts: 0 };
		state.lastInboundAt = ts;
		if (expectsReply) {
			state.unansweredSince = state.unansweredSince ?? ts;
			state.closedAt = undefined;
			state.closeReason = undefined;
		}
		all[thread] = state;
		this.save(all);
	}

	recordOutbound(thread: string, ts: number): void {
		const all = this.load();
		const state = all[thread] ?? { thread, lastInboundAt: ts, attempts: 0 };
		state.lastOutboundAt = ts;
		if (state.unansweredSince !== undefined && state.unansweredSince <= ts) {
			state.unansweredSince = undefined;
			state.attempts = 0;
		}
		all[thread] = state;
		this.save(all);
	}

	close(thread: string, reason: string, ts = Date.now()): ThreadState | null {
		const all = this.load();
		const state = all[thread];
		if (!state) return null;
		state.closedAt = ts;
		state.closeReason = reason;
		state.unansweredSince = undefined;
		all[thread] = state;
		this.save(all);
		return state;
	}

	/** Threads waiting for an answer, optionally filtered to those we still nudge. */
	unsettled(maxNudges = Number.POSITIVE_INFINITY): ThreadState[] {
		const all = this.load();
		return Object.values(all)
			.filter((t) => t.unansweredSince !== undefined && t.closedAt === undefined)
			.filter((t) => t.attempts < maxNudges)
			.sort((a, b) => (a.unansweredSince ?? 0) - (b.unansweredSince ?? 0));
	}

	all(): ThreadState[] {
		return Object.values(this.load()).sort((a, b) => a.lastInboundAt - b.lastInboundAt);
	}

	/**
	 * Called at the end of a wake: threads that received a tool-delivered message
	 * are considered answered; the rest get a nudge attempt recorded.
	 */
	settle(runId: string, answeredThreads: string[], candidateThreads: string[]): void {
		const all = this.load();
		for (const thread of answeredThreads) {
			const state = all[thread];
			if (!state) continue;
			state.unansweredSince = undefined;
			state.attempts = 0;
		}
		for (const thread of candidateThreads) {
			if (answeredThreads.includes(thread)) continue;
			const state = all[thread];
			if (!state || state.unansweredSince === undefined || state.closedAt !== undefined) continue;
			state.attempts += 1;
			state.lastNudgedRunId = runId;
		}
		this.save(all);
	}
}
