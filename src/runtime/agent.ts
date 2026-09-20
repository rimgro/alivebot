import type { AgentSession, AgentSessionEvent } from "@earendil-works/pi-coding-agent";
import type { LoadedConfig } from "../config.js";
import type { Logger } from "../log.js";
import { appendJsonl, formatDuration, oneLine, truncate } from "../util.js";
import { term, stamp } from "../term.js";
import type { AliveEvent } from "../store/events.js";
import type { EventStore } from "../store/events.js";
import type { PolicyStore } from "../store/policy.js";
import type { RunLog, RunRecord, RunStopReason } from "../store/runs.js";
import type { ThreadStore } from "../store/threads.js";
import { renderAwakePrompt, renderInterruptPrompt, renderNudgePrompt } from "./prompt.js";
import type { RunHandle, ToolDeps } from "./tools.js";

export interface AgentRunnerDeps {
	config: LoadedConfig;
	/** Build the pi session. `forceNew` is set after a sleep so the context is fresh. */
	createSession: (forceNew: boolean) => Promise<AgentSession>;
	store: EventStore;
	runs: RunLog;
	threads: ThreadStore;
	policy: PolicyStore;
	toolDeps: ToolDeps;
	log: Logger;
	thoughtsFile: string;
	getRun: () => RunHandle | undefined;
	setRun: (run: RunHandle | undefined) => void;
	runtimeStatus: () => Record<string, unknown>;
	isStopping: () => boolean;
	isBudgetExhausted: () => boolean;
}

/**
 * Owns the continuous agent lifecycle.
 *
 * A **run** is one stretch of existence: it begins with an awake prompt and ends
 * when the agent calls `sleep`, stalls, or is stopped. Inside a run the agent
 * calls `idle` as often as it likes; `idle` blocks until events arrive and then
 * returns them as tool output, so the same ReAct loop carries the agent across
 * many real-world events.
 *
 * The runtime never ends a run because of an inbound event — only the agent's own
 * `sleep` (or a safety limit) does. This class is the seam between that
 * continuous loop and pi's single-response agent loop.
 */
export class AgentRunner {
	private readonly deps: AgentRunnerDeps;
	private session!: AgentSession;
	private unsubscribe?: () => void;
	private timedOutRunId: string | null = null;
	private budgetRunId: string | null = null;
	private aborting = false;
	private interruptInFlight = false;

	constructor(deps: AgentRunnerDeps) {
		this.deps = deps;
	}

	async init(): Promise<void> {
		this.session = await this.deps.createSession(false);
		this.attach();
	}

	get currentSession(): AgentSession {
		return this.session;
	}

	/** Set by AliveRuntime.stop() so the run record can distinguish abort from error. */
	markAborting(): void {
		this.aborting = true;
	}

	/** Install listeners and the turn guard on the current session. */
	private attach(): void {
		this.unsubscribe?.();
		this.unsubscribe = this.session.subscribe((event) => this.handleSessionEvent(event));
		this.installTurnGuard();
	}

	/**
	 * Replace the session with a fresh one. Called after a sleep: the transcript
	 * is wiped, the durable memory (journal/notes/reminders) is not.
	 */
	async rebuildSession(): Promise<void> {
		try {
			await this.session.abort();
		} catch {
			// already settled
		}
		this.unsubscribe?.();
		this.session.dispose();
		this.session = await this.deps.createSession(true);
		this.attach();
	}

	/**
	 * Active-time watchdog. Idle time does not count, so an agent may wait for
	 * hours, but it may not burn the model for longer than `runTimeoutMs` without
	 * yielding. Called by the runtime scheduler.
	 */
	checkActiveTimeout(): void {
		const run = this.deps.getRun();
		if (!run || run.idling) return;
		const since = run.activeSince ?? run.startedAt;
		if (Date.now() - since < this.deps.config.config.loop.runTimeoutMs) return;
		if (this.timedOutRunId === run.id) return;
		this.timedOutRunId = run.id;
		this.deps.log.warn(`run #${run.index} exceeded active-time limit; aborting`, {
			limitMs: this.deps.config.config.loop.runTimeoutMs,
			activeMs: Date.now() - since,
		});
		void this.session.abort();
	}

	/**
	 * Run the agent until it sleeps or a safety limit stops it. Returns null when
	 * `requireEvents` is set and there is nothing pending.
	 */
	async execute(options: { redeliveryRange?: { fromSeq: number; toSeq: number }; requireEvents?: boolean } = {}): Promise<RunRecord | null> {
		const { config, store, runs, log } = this.deps;
		if (this.deps.getRun()) throw new Error("a run is already active");

		if (options.requireEvents && store.peekPending(1).length === 0) return null;

		const statsBefore = this.session.getSessionStats();
		const startedAt = Date.now();
		const run: RunHandle = {
			id: `run_${startedAt.toString(36)}_${Math.random().toString(36).slice(2, 6)}`,
			index: runs.nextIndex(),
			startedAt,
			events: [],
			outbound: [],
			reminderIds: [],
			noteKeys: [],
			journalEntries: 0,
			idleReturns: 0,
			interruptDeliveries: 0,
			nudges: 0,
			turns: 0,
			promptChars: 0,
			inboundThreads: new Set(),
			idling: false,
			idleMs: 0,
			activeSince: startedAt,
			activeMs: 0,
			sleepOffered: false,
			sleepRequested: false,
			sleepForced: false,
		};
		this.deps.setRun(run);
		store.beginRun(run.id);

		// Opening batch: everything pending that the policy does not mute.
		const opening = this.claimDeliverable();
		this.trackEvents(run, opening);

		log.info(`run #${run.index} start`, {
			runId: run.id,
			events: opening.length,
			kinds: opening.map((e) => e.kind),
			pendingAfterClaim: store.pendingCount(),
			resumed: Boolean(options.redeliveryRange),
		});

		let stopReason: RunStopReason | undefined;
		let error: string | undefined;
		let first = true;

		while (true) {
			if (!first) this.trackEvents(run, this.claimDeliverable());
			const prompt = first
				? this.renderAwake(run, options.redeliveryRange)
				: this.renderNudge(run, options.redeliveryRange);
			first = false;
			run.promptChars += prompt.length;

			try {
				await this.session.prompt(prompt, { expandPromptTemplates: false, source: "extension" });
			} catch (err) {
				error = err instanceof Error ? err.message : String(err);
				log.error(`run #${run.index} session error`, { error });
				stopReason = "error";
				break;
			}

			if (run.sleepRequested) {
				stopReason = "slept";
				break;
			}
			if (this.timedOutRunId === run.id) {
				stopReason = "timeout";
				break;
			}
			if (this.budgetRunId === run.id) {
				stopReason = "budget";
				break;
			}
			if (this.aborting || this.deps.isStopping()) {
				stopReason = "aborted";
				break;
			}
			if (run.lastStopReason === "error" || run.lastError) {
				error = run.lastError ?? "model error";
				stopReason = "error";
				break;
			}

			// The model ended its turn with plain text and no idle/sleep. It is not
			// done — it just forgot to wait. Nudge it back.
			run.nudges += 1;
			log.warn(`run #${run.index} stopped without idling`, { nudge: run.nudges });
			if (run.nudges > config.config.loop.maxNudgesPerRun) {
				stopReason = "stalled";
				break;
			}
			await new Promise((resolve) => setTimeout(resolve, 250));
		}

		const finishedAt = Date.now();
		const statsAfter = this.session.getSessionStats();
		const usage = this.diffUsage(statsBefore, statsAfter);
		if (!run.idling) run.activeMs += Math.max(0, finishedAt - (run.activeSince ?? finishedAt));

		const reachedModel = run.lastStopReason !== undefined || run.turns > 0 || run.idleReturns > 0;
		const redeliver = stopReason === "error" || stopReason === "timeout" || stopReason === "aborted";
		this.deps.setRun(undefined);
		if (reachedModel && !redeliver) {
			store.endRun();
		} else {
			store.rollbackClaim();
			log.warn(`run #${run.index} left events unacknowledged; they will be redelivered`, {
				stopReason,
				events: run.events.length,
				preflight: !reachedModel,
			});
		}

		if (reachedModel) {
			const answeredThreads = [...new Set(run.outbound.map((m) => m.thread))];
			this.deps.threads.settle(run.id, answeredThreads, [...run.inboundThreads]);
		}

		const record: RunRecord = {
			id: run.id,
			index: run.index,
			startedAt: run.startedAt,
			finishedAt,
			durationMs: finishedAt - run.startedAt,
			activeMs: run.activeMs,
			idleMs: run.idleMs,
			stopReason: stopReason ?? "stalled",
			error,
				events: run.events.map((e) => ({
					seq: e.seq,
					kind: e.kind,
					thread: e.thread,
					title: e.title,
					redelivered: this.isRedelivered(e.seq, options.redeliveryRange),
				})),
			outbound: run.outbound,
			remindersCreated: run.reminderIds,
			notesTouched: run.noteKeys,
			journalEntries: run.journalEntries,
			idleReturns: run.idleReturns,
			interruptDeliveries: run.interruptDeliveries,
			nudges: run.nudges,
			turns: run.turns,
			promptChars: run.promptChars,
			usage,
			sleep: run.sleepRequested ? { forced: run.sleepForced, summaryChars: run.sleepSummary?.length ?? 0 } : undefined,
		};

		this.deps.runs.record(record);
		this.timedOutRunId = null;
		this.budgetRunId = null;
		this.aborting = false;

		log.info(`run #${run.index} end`, {
			stopReason: record.stopReason,
			durationMs: record.durationMs,
			activeMs: record.activeMs,
			idleMs: record.idleMs,
			turns: record.turns,
			outbound: record.outbound.length,
			usage: usage.cost,
		});

		if (stopReason === "slept") await this.rebuildSession();
		return record;
	}

	private get isFreshContext(): boolean {
		return this.session.messages.length === 0;
	}

	private isRedelivered(seq: number, range: { fromSeq: number; toSeq: number } | undefined): boolean {
		return Boolean(range && seq >= range.fromSeq && seq <= range.toSeq);
	}

	private claimDeliverable(): AliveEvent[] {
		const { store, policy, config } = this.deps;
		const out: AliveEvent[] = [];
		for (let i = 0; i < 50; i += 1) {
			const batch = store.claim(config.config.loop.maxEventsPerIdle);
			if (batch.length === 0) break;
			out.push(...batch.filter((event) => !policy.shouldMute(event)));
			if (batch.length < config.config.loop.maxEventsPerIdle) break;
			if (out.length >= config.config.loop.maxEventsPerIdle) break;
		}
		return out;
	}

	private trackEvents(run: RunHandle, events: AliveEvent[]): void {
		const seen = new Set(run.events.map((event) => event.seq));
		for (const event of events) {
			if (!seen.has(event.seq)) {
				run.events.push(event);
				seen.add(event.seq);
			}
			if (event.kind === "user_message" && event.thread) {
				this.deps.threads.recordInbound(event.thread, event.ts, event.expectsReply !== false);
				run.inboundThreads.add(event.thread);
			}
		}
	}

	private renderAwake(run: RunHandle, redeliveryRange: { fromSeq: number; toSeq: number } | undefined): string {
		return renderAwakePrompt(this.promptInput(run, redeliveryRange));
	}

	private renderNudge(run: RunHandle, redeliveryRange: { fromSeq: number; toSeq: number } | undefined): string {
		return renderNudgePrompt({ ...this.promptInput(run, redeliveryRange), nudge: run.nudges });
	}

	private promptInput(run: RunHandle, redeliveryRange: { fromSeq: number; toSeq: number } | undefined) {
		const { config, store, runs } = this.deps;
		const inbound = new Set(run.events.filter((e) => e.thread).map((e) => e.thread as string));
		const carried = this.deps.threads
			.unsettled(config.config.loop.maxNudges)
			.filter((thread) => !inbound.has(thread.thread));
		return {
			runIndex: run.index,
			runId: run.id,
			now: Date.now(),
			events: run.events.slice(-config.config.loop.maxEventsPerIdle),
			redeliveredSeqs: run.events
				.map((e) => e.seq)
				.filter((seq) => this.isRedelivered(seq, redeliveryRange)),
			resumed: Boolean(redeliveryRange) || !this.isFreshContext,
			threads: carried,
			notes: this.deps.toolDeps.notes.all(),
			reminders: this.deps.toolDeps.reminders.list(),
			journalTail: this.deps.toolDeps.journal.tail(40),
			recentRuns: runs.list(3),
			policy: this.deps.policy.load(),
			costTodayUsd: runs.usageToday().cost,
			maxDailyCostUsd: config.config.budget.maxDailyCostUsd,
			pendingAfterClaim: store.pendingCount(),
		};
	}

	private installTurnGuard(): void {
		const previous = this.session.agent.shouldStopAfterTurn;
		this.session.agent.shouldStopAfterTurn = async (context) => {
			if (previous && (await previous(context))) return true;
			const run = this.deps.getRun();
			if (!run) return false;
			// Turns are counted for telemetry only. There is deliberately no turn
			// limit: a run may work for as long as it needs, and only the budget
			// guard (and the runtime's active-time watchdog) can stop it.
			run.turns += 1;
			if (this.deps.isBudgetExhausted()) {
				this.budgetRunId = run.id;
				this.deps.log.warn(`run #${run.index} stopped: budget exhausted`);
				return true;
			}
			return false;
		};
	}

	private handleSessionEvent(event: AgentSessionEvent): void {
		const run = this.deps.getRun();
		switch (event.type) {
			case "message_end": {
				if (event.message.role !== "assistant") break;
				if (run) {
					const stopReason = (event.message as { stopReason?: string }).stopReason;
					if (stopReason) run.lastStopReason = stopReason;
					const errorMessage = (event.message as { errorMessage?: string }).errorMessage;
					if (errorMessage) run.lastError = errorMessage;
				}
				if (!run) break;
				const text = assistantText(event.message);
				const thinking = assistantThinking(event.message);
				if (!text.trim() && !thinking.trim()) break;
				appendJsonl(this.deps.thoughtsFile, {
					ts: Date.now(),
					runId: run.id,
					runIndex: run.index,
					text,
					thinking: thinking ? truncate(thinking, 4000) : undefined,
				});
				if (this.deps.config.config.verbose) {
					const shown = text.trim() || thinking;
					this.deps.log.raw(`${term.gray(`💭 ${truncate(shown, 2000)}`)}`);
				}
				break;
			}
			case "tool_execution_start": {
				const label = oneLine(JSON.stringify(event.args ?? {}), 160);
				if (this.deps.config.config.verbose) {
					this.deps.log.raw(`${term.dim(stamp())} ${term.cyan(`→ ${event.toolName}`)} ${term.gray(label)}`);
				}
				break;
			}
			case "tool_execution_end": {
				const resultText = toolResultText(event.result);
				if (this.deps.config.config.verbose) {
					const color = event.isError ? term.red : term.green;
					this.deps.log.raw(
						`${term.dim(stamp())} ${color(`← ${event.toolName}`)} ${term.gray(oneLine(resultText, 200))}`,
					);
				}
				break;
			}
			case "turn_end": {
				void this.deliverInterrupts();
				break;
			}
			case "compaction_end": {
				this.deps.log.info("compaction", {
					reason: event.reason,
					aborted: event.aborted,
					error: event.errorMessage,
				});
				break;
			}
			default:
				break;
		}
	}

	/**
	 * Deliver policy-approved notifications into a running agent via pi steering.
	 * Skipped while the agent is idling: events arriving during idle are returned
	 * by the `idle` call itself, and steering would be stuck behind the blocked
	 * tool call.
	 */
	private async deliverInterrupts(): Promise<void> {
		if (!this.deps.config.config.loop.interrupt || this.interruptInFlight) return;
		const run = this.deps.getRun();
		if (!run || run.idling) return;
		const claimed = this.deps.store.claimPrefix(8, (event) => this.deps.policy.shouldInterrupt(event));
		const pending = claimed.filter((event) => !this.deps.policy.shouldMute(event));
		if (pending.length === 0) return;
		this.interruptInFlight = true;
		try {
			run.interruptDeliveries += 1;
			this.trackEvents(run, pending);
			this.deps.log.info(`run #${run.index} notification interrupt`, { seqs: pending.map((e) => e.seq) });
			await this.session.steer(renderInterruptPrompt(pending));
		} catch (err) {
			this.deps.log.warn("interrupt delivery failed", { error: err instanceof Error ? err.message : String(err) });
		} finally {
			this.interruptInFlight = false;
		}
	}

	private diffUsage(
		before: ReturnType<AgentSession["getSessionStats"]>,
		after: ReturnType<AgentSession["getSessionStats"]>,
	): RunRecord["usage"] {
		const delta = (a: number, b: number) => Math.max(0, b - a);
		return {
			input: delta(before.tokens.input, after.tokens.input),
			output: delta(before.tokens.output, after.tokens.output),
			cacheRead: delta(before.tokens.cacheRead, after.tokens.cacheRead),
			cacheWrite: delta(before.tokens.cacheWrite, after.tokens.cacheWrite),
			total: delta(before.tokens.total, after.tokens.total),
			cost: delta(before.cost, after.cost),
		};
	}
}

function assistantText(message: { content: unknown }): string {
	return contentParts(message, "text").join("\n");
}

function assistantThinking(message: { content: unknown }): string {
	return contentParts(message, "thinking").join("\n");
}

function contentParts(message: { content: unknown }, type: "text" | "thinking"): string[] {
	if (typeof message.content === "string") return type === "text" ? [message.content] : [];
	if (!Array.isArray(message.content)) return [];
	return message.content
		.filter((part): part is Record<string, string> => {
			return (
				typeof part === "object" &&
				part !== null &&
				(part as { type?: string }).type === type &&
				typeof (part as Record<string, unknown>)[type] === "string"
			);
		})
		.map((part) => part[type]!);
}

function toolResultText(result: unknown): string {
	if (!result || typeof result !== "object") return String(result ?? "");
	const content = (result as { content?: unknown }).content;
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	return content
		.map((part) =>
			typeof part === "object" && part !== null && "text" in part ? String((part as { text: unknown }).text) : "",
		)
		.filter(Boolean)
		.join("\n");
}

export function describeRunRecord(record: RunRecord): string {
	const outbound = record.outbound.length > 0 ? `${record.outbound.length} outbound` : "no outbound";
	return `#${record.index} ${formatDuration(record.durationMs)} ${record.stopReason}: ${record.events.length} events, ${outbound}`;
}
