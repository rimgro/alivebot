import { createHash } from "node:crypto";
import * as fs from "node:fs";
import type { AgentSession, AgentSessionEvent } from "@earendil-works/pi-coding-agent";
import type { LoadedConfig } from "../config.js";
import type { Logger } from "../log.js";
import { appendJsonl, formatDuration, oneLine, sleep, truncate } from "../util.js";
import { term, stamp } from "../term.js";
import type { AliveEvent } from "../store/events.js";
import type { EventStore } from "../store/events.js";
import type { PolicyStore } from "../store/policy.js";
import { runTurnCount, type RunLog, type RunRecord, type RunStopReason } from "../store/runs.js";
import type { ThreadStore } from "../store/threads.js";
import { renderAwakePrompt, renderInterruptPrompt, renderLongRunWarning, renderNudgePrompt } from "./prompt.js";
import { TurnTraceRecorder } from "./run-trace.js";
import type { RunAnomalyEvent, RunEventSink } from "../store/run-events.js";
import { hasWakeWorthyPending } from "./wake.js";
import { classifyNetworkError, withRetries } from "../retry.js";
import { maskSecrets } from "../secrets.js";
import { privateMemoryScope } from "./memory-access.js";
import type { RunHandle, ToolDeps } from "./tools.js";

/**
 * A prompt may be retried only when the failure happened before any tool ran or
 * any token was spent, so replaying it cannot duplicate work or billing.
 */
const AGENT_PROVIDER_RETRY_ATTEMPTS = 3;
const AGENT_PROVIDER_RETRY_BASE_MS = 1_000;
const AGENT_PROVIDER_RETRY_MAX_DELAY_MS = 15_000;

export interface ExecuteOptions {
	redeliveryRange?: { fromSeq: number; toSeq: number };
	requireEvents?: boolean;
	/**
	 * Continue this run instead of starting a fresh one. The record keeps its id,
	 * index and startedAt; usage/turn/outbound counters are seeded from it and the
	 * session gets a `продолжай` service prompt.
	 */
	resume?: RunRecord;
}

export interface DrainResult {
	/** `idle`: no active execution; `drained`: finished inside the grace budget. */
	outcome: "idle" | "drained" | "aborted";
	durationMs: number;
}

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
	/** Durable sink for `run_*` anomaly events (#127). Omit to log them only. */
	runEvents?: RunEventSink;
	getRun: () => RunHandle | undefined;
	setRun: (run: RunHandle | undefined) => void;
	runtimeStatus: () => Record<string, unknown>;
	isStopping: () => boolean;
	isBudgetExhausted: () => boolean;
}

/**
 * Active milliseconds of a run, idle excluded.
 *
 * `idle` freezes the clock: it flushes the elapsed active stretch into
 * `run.activeMs` and clears `activeSince`; the stretch that started after the
 * last idle is added on top. A run that idles for hours therefore never looks
 * "long" to any of the guards below.
 */
export function runActiveMs(run: RunHandle, now = Date.now()): number {
	if (run.idling) return run.activeMs;
	return run.activeMs + Math.max(0, now - (run.activeSince ?? run.startedAt));
}

/** How many identical tool calls in a row count as `run_repeat_tool`. */
export const RUN_REPEAT_TOOL_THRESHOLD = 3;

/**
 * Per-run guard state. Nothing here knows about prompts or messages: it is
 * counters and a tool-argument fingerprint only, so an anomaly event can never
 * leak conversation content.
 */
interface RunWatch {
	runId: string;
	/** How many `runWarnMs` windows have already produced a warning. */
	warningsSent: number;
	noOutboundFlagged: boolean;
	veryLongFlagged: boolean;
	/** Stable fingerprint of the last tool call: name + canonical arguments. */
	lastToolKey?: string;
	/** Consecutive calls with the same tool and identical arguments. */
	repeatCount: number;
	repeatFlagged: boolean;
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
	/** Interrupts an in-flight provider-retry backoff when the run is stopped. */
	private promptRetryAbort?: AbortController;
	/** Tool executions started in the current run; a retry must never replay past one. */
	private toolCallsThisRun = 0;
	/** Per-turn usage of the current run, persisted on its record (#121). */
	private readonly turnTrace = new TurnTraceRecorder();
	/** Soft run-health state for the current run (#127); reset by every `execute`. */
	private watch: RunWatch | undefined;
	/**
	 * Set by a deliberate shutdown: existing work may finish its current step,
	 * but `shouldStopAfterTurn` and the post-prompt checks end the run instead of
	 * starting another model step.
	 */
	private draining = false;
	/** Resolves when the active `execute` has written its record. */
	private executionSettled: { promise: Promise<void>; resolve: () => void } | undefined;

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
		this.abortRetryDelay();
	}

	/** Interrupt a scheduled backoff, but leave an in-flight prompt to session.abort(). */
	private abortRetryDelay(): void {
		if (!this.session.isStreaming) this.promptRetryAbort?.abort();
	}

	/**
	 * Graceful shutdown for an active run (#124).
	 *
	 * Sets the drain flag so the current tool call may finish and
	 * `shouldStopAfterTurn` ends the session loop instead of starting another
	 * model step. Waits for `execute` to write its `interrupted` record. If the
	 * grace budget expires, falls back to the historical abort path.
	 */
	async drain(graceMs = this.deps.config.config.loop.shutdownGraceMs): Promise<DrainResult> {
		const startedAt = Date.now();
		this.draining = true;
		this.abortRetryDelay();
		const execution = this.executionSettled?.promise;
		if (!execution) return { outcome: "idle", durationMs: 0 };
		const budget = Math.max(0, graceMs);
		const drained = await Promise.race([
			execution.then(() => true),
			sleep(budget).then(() => false),
		]);
		if (drained) return { outcome: "drained", durationMs: Date.now() - startedAt };
		this.deps.log.warn("graceful shutdown budget expired; aborting the run", { graceMs: budget });
		this.markAborting();
		try {
			await this.session.abort();
		} catch (err) {
			this.deps.log.warn("abort failed", { error: err instanceof Error ? err.message : String(err) });
		}
		await execution;
		return { outcome: "aborted", durationMs: Date.now() - startedAt };
	}

	/** Install listeners and the turn guard on the current session. */
	private attach(): void {
		this.unsubscribe?.();
		this.unsubscribe = this.session.subscribe((event) => this.handleSessionEvent(event));
		this.installTurnGuard();
	}

	/**
	 * Replace the session with a fresh one. Called after a sleep: the transcript
	 * is wiped, while SQLite facts, summary.md, journal/notes/reminders survive.
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
	 * Run health check, called by the runtime scheduler on every tick.
	 *
	 * Idle time never counts: the agent may wait for hours. While it is actively
	 * working the runtime:
	 *
	 *   - aborts the run **only** if an operator configured a positive
	 *     `runTimeoutMs` (the historical watchdog, off by default since #127);
	 *   - steers one built-in "wrap up or explain" warning per `runWarnMs` window
	 *     of active work and records a `run_long` event;
	 *   - records `run_no_outbound` and `run_very_long` anomaly events once per run.
	 *
	 * Nothing here is a step limit. `now` is a clock seam for tests.
	 */
	checkRunGuards(now = Date.now()): void {
		const run = this.deps.getRun();
		if (!run || run.idling) return;
		const watch = this.watch?.runId === run.id ? this.watch : undefined;
		if (!watch) return;
		const loop = this.deps.config.config.loop;
		const activeMs = runActiveMs(run, now);

		// Explicitly configured hard stop: unchanged behaviour, opt-in only.
		if (loop.runTimeoutMs > 0 && activeMs >= loop.runTimeoutMs) {
			if (this.timedOutRunId === run.id) return;
			this.timedOutRunId = run.id;
			this.deps.log.warn(`run #${run.index} exceeded active-time limit; aborting`, {
				limitMs: loop.runTimeoutMs,
				activeMs,
			});
			this.abortRetryDelay();
			void this.session.abort();
			return;
		}

		// Soft warning: at most one per `runWarnMs` window of active work. A late
		// check that sees several windows at once still sends exactly one message
		// (and marks them all seen), so a busy scheduler never produces a burst.
		if (loop.runWarnMs > 0) {
			const windows = Math.floor(activeMs / loop.runWarnMs);
			if (windows > watch.warningsSent) {
				watch.warningsSent = windows;
				this.emitAnomaly(run, { type: "run_long", now, activeMs, limitMs: loop.runWarnMs });
				void this.steerLongRunWarning(run, activeMs);
			}
		}

		// A run that burns many turns without saying anything to anyone.
		if (
			loop.runNoOutboundTurns > 0 &&
			!watch.noOutboundFlagged &&
			run.outbound.length === 0 &&
			run.turns > loop.runNoOutboundTurns
		) {
			watch.noOutboundFlagged = true;
			this.emitAnomaly(run, {
				type: "run_no_outbound",
				now,
				activeMs,
				limitTurns: loop.runNoOutboundTurns,
			});
		}

		// A run that has been actively working for hours.
		if (loop.runVeryLongMs > 0 && !watch.veryLongFlagged && activeMs >= loop.runVeryLongMs) {
			watch.veryLongFlagged = true;
			this.emitAnomaly(run, { type: "run_very_long", now, activeMs, limitMs: loop.runVeryLongMs });
		}
	}

	/**
	 * Steer the one built-in long-run warning into the working agent (#127).
	 *
	 * It is a hint, not a stop: the run keeps going and the agent decides whether
	 * to wrap up, send what it has, or explain itself.
	 */
	private async steerLongRunWarning(run: RunHandle, activeMs: number): Promise<void> {
		try {
			await this.session.steer(
				renderLongRunWarning({ activeMs, turns: run.turns, outbound: run.outbound.length }),
			);
			this.deps.log.info(`run #${run.index} long-run warning steered`, {
				activeMs,
				turns: run.turns,
				outbound: run.outbound.length,
			});
		} catch (err) {
			this.deps.log.warn("long-run warning failed", {
				error: err instanceof Error ? err.message : String(err),
			});
		}
	}

	/**
	 * Record one anomaly event: durably through the sink (when wired) and in the
	 * structured log, which is the primary observability surface. Counters only —
	 * never prompt, message or tool-argument text.
	 */
	private emitAnomaly(
		run: RunHandle,
		input: {
			type: RunAnomalyEvent["type"];
			now: number;
			activeMs: number;
			limitMs?: number;
			limitTurns?: number;
			tool?: string;
			repeats?: number;
		},
	): void {
		const event: RunAnomalyEvent = {
			ts: input.now,
			type: input.type,
			agent: this.deps.config.config.name,
			runId: run.id,
			runIndex: run.index,
			activeMs: Math.round(input.activeMs),
			durationMs: Math.max(0, input.now - run.startedAt),
			idleMs: Math.round(run.idleMs),
			turns: run.turns,
			outbound: run.outbound.length,
			events: run.events.length,
			limitMs: input.limitMs,
			limitTurns: input.limitTurns,
			tool: input.tool,
			repeats: input.repeats,
		};
		this.deps.runEvents?.append(event);
		this.deps.log.warn(event.type, { ...event });
	}

	/**
	 * Run the agent until it sleeps or a safety limit stops it. Returns null when
	 * `requireEvents` is set and there is nothing pending.
	 */
	async execute(options: ExecuteOptions = {}): Promise<RunRecord | null> {
		const { config, store, runs, log } = this.deps;
		if (this.deps.getRun()) throw new Error("a run is already active");
		// A stop that lands between loop iterations must not start a new run.
		if (this.deps.isStopping()) return null;

		// An empty inbox is not a wake: no run, no model call, no spend (#116).
		// `wake: false` events (unaddressed group chatter) count as no work here too.
		// A resumed run is always allowed to continue: it has its own context.
		if (options.requireEvents && !options.resume && !hasWakeWorthyPending(store)) return null;

		let settle!: () => void;
		const settled = new Promise<void>((resolve) => {
			settle = resolve;
		});
		this.executionSettled = { promise: settled, resolve: settle };
		try {
			const previous = options.resume;
			const statsBefore = this.session.getSessionStats();
			const retryAbort = new AbortController();
			this.promptRetryAbort = retryAbort;
			this.draining = false;
			const startedAt = Date.now();
			this.turnTrace.reset({ turns: previous?.turns, count: previous ? runTurnCount(previous) : 0 });
			this.toolCallsThisRun = 0;
			const run: RunHandle = {
				id: previous?.id ?? `run_${startedAt.toString(36)}_${Math.random().toString(36).slice(2, 6)}`,
				index: previous?.index ?? runs.nextIndex(),
				startedAt: previous?.startedAt ?? startedAt,
				events: [],
				outbound: previous ? previous.outbound.map((message) => ({ ...message })) : [],
				reminderIds: previous ? [...previous.remindersCreated] : [],
				noteKeys: previous ? [...previous.notesTouched] : [],
				journalEntries: previous?.journalEntries ?? 0,
				idleReturns: previous?.idleReturns ?? 0,
				interruptDeliveries: previous?.interruptDeliveries ?? 0,
				nudges: previous?.nudges ?? 0,
				turns: previous ? runTurnCount(previous) : 0,
				promptChars: previous?.promptChars ?? 0,
				inboundThreads: new Set<string>(),
				idling: false,
				idleMs: previous?.idleMs ?? 0,
				activeSince: startedAt,
				activeMs: previous?.activeMs ?? 0,
				sleepOffered: false,
				sleepRequested: false,
				sleepForced: false,
				retainedThisRun: false,
				dedupeOutbound: Boolean(previous),
			};
			this.deps.setRun(run);
			this.watch = {
				runId: run.id,
				warningsSent: 0,
				noOutboundFlagged: false,
				veryLongFlagged: false,
				repeatCount: 0,
				repeatFlagged: false,
			};
			store.beginRun(run.id);

			// Opening batch: everything pending that the policy does not mute.
			const opening = this.claimDeliverable();
			this.trackEvents(run, opening);

			log.info(`run #${run.index} start`, {
				runId: run.id,
				events: opening.length,
				kinds: opening.map((e) => e.kind),
				pendingAfterClaim: store.pendingCount(),
				resumed: Boolean(previous || options.redeliveryRange),
			});

			let stopReason: RunStopReason | undefined;
			let error: string | undefined;
			let first = true;

			while (true) {
				if (this.draining || this.aborting || this.deps.isStopping()) {
					stopReason = this.draining && !this.aborting ? "interrupted" : "aborted";
					break;
				}
				if (!first) this.trackEvents(run, this.claimDeliverable());
				try {
					const awake = first
						? await this.renderAwake(run, options.redeliveryRange)
						: await this.renderNudge(run, options.redeliveryRange);
					const prompt = first && previous ? resumePrompt(previous, awake) : awake;
					first = false;
					run.promptChars += prompt.length;
					const tokensBeforePrompt = sessionTokenTotal(this.session);
					const turnsBeforePrompt = run.turns;
					const toolCallsBeforePrompt = this.toolCallsThisRun;
					await withRetries(
						() => this.session.prompt(prompt, { expandPromptTemplates: false, source: "extension" }),
						{
							attempts: AGENT_PROVIDER_RETRY_ATTEMPTS,
							baseDelayMs: AGENT_PROVIDER_RETRY_BASE_MS,
							maxDelayMs: AGENT_PROVIDER_RETRY_MAX_DELAY_MS,
							label: `agent ${run.id} provider`,
							log,
							signal: retryAbort.signal,
							// Never replay a prompt after a tool call or token spend: the provider
							// already did (and billed) work that a retry would duplicate. Permanent
							// classes (auth, quota, invalid request) are rejected by the classifier.
							shouldRetry: (caught) =>
								!retryAbort.signal.aborted &&
								!this.aborting &&
								!this.deps.isStopping() &&
								run.turns === turnsBeforePrompt &&
								this.toolCallsThisRun === toolCallsBeforePrompt &&
								sessionTokenTotal(this.session) <= tokensBeforePrompt &&
								classifyNetworkError(caught).transient,
						},
					);
				} catch (err) {
					if (this.aborting || this.draining || this.deps.isStopping()) {
						// The fallback abort after the grace budget, or an abort raced by a
						// stop: this is a deliberate stop, not a model failure.
						stopReason = this.draining && !this.aborting ? "interrupted" : "aborted";
						log.info(`run #${run.index} session stopped during shutdown`, { stopReason });
						break;
					}
					error = maskSecrets(err instanceof Error ? err.message : String(err), this.deps.config.config.secrets);
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
				if (this.draining || this.aborting || this.deps.isStopping()) {
					stopReason = this.draining && !this.aborting ? "interrupted" : "aborted";
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
			const segmentUsage = this.diffUsage(statsBefore, statsAfter);
			const usage = previous ? addUsage(previous.usage, segmentUsage) : segmentUsage;
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

			// The run record itself is the durable summary. When a deliberate restart
			// drains the run, also write an episodic line to the journal so the next
			// context sees why the run ended without a sleep summary.
			const summary = stopReason === "interrupted"
				? `run #${run.index} interrupted by a planned harness restart after ${formatDuration(finishedAt - run.startedAt)}: ` +
					`${run.events.length} event(s), ${run.turns} turn(s), ${run.outbound.length} outbound message(s); ` +
					`resume continues the same session.`
				: undefined;
			if (summary) {
				this.deps.toolDeps.journal.append(`[interrupted] ${summary}`);
				run.journalEntries += 1;
			}

			const priorEvents = previous?.events ?? [];
			const currentSeqs = new Set(run.events.map((event) => event.seq));
			const events = [
				...priorEvents.filter((event) => !currentSeqs.has(event.seq)),
				...run.events.map((e) => ({
					seq: e.seq,
					kind: e.kind,
					thread: e.thread,
					title: e.title,
					redelivered: this.isRedelivered(e.seq, options.redeliveryRange),
				})),
			];
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
				sessionFile: this.session.sessionFile,
				summary,
				events,
				outbound: run.outbound,
				remindersCreated: run.reminderIds,
				notesTouched: run.noteKeys,
				journalEntries: run.journalEntries,
				idleReturns: run.idleReturns,
				interruptDeliveries: run.interruptDeliveries,
				nudges: run.nudges,
				turnCount: run.turns,
				// Bounded per-turn trace: the page checks its sum against `usage`.
				turns: this.turnTrace.snapshot(),
				promptChars: run.promptChars,
				usage,
				sleep: run.sleepRequested ? { forced: run.sleepForced, summaryChars: run.sleepSummary?.length ?? 0 } : undefined,
			};

			this.deps.runs.record(record);
			this.timedOutRunId = null;
			this.budgetRunId = null;
			this.watch = undefined;
			this.promptRetryAbort = undefined;

			log.info(`run #${run.index} end`, {
				stopReason: record.stopReason,
				durationMs: record.durationMs,
				activeMs: record.activeMs,
				idleMs: record.idleMs,
				turns: record.turns,
				outbound: record.outbound.length,
				usage: usage.cost,
				resumed: Boolean(previous),
			});

			if (stopReason === "slept") await this.rebuildSession();
			return record;
		} finally {
			this.aborting = false;
			this.draining = false;
			this.deps.setRun(undefined);
			if (this.executionSettled?.promise === settled) this.executionSettled = undefined;
			settle();
		}
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
		if (events.length) run.currentThreads = [...new Set([...(run.currentThreads ?? []), ...events.flatMap(event => event.thread ? [event.thread] : [])])];
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

	private async renderAwake(run: RunHandle, redeliveryRange: { fromSeq: number; toSeq: number } | undefined): Promise<string> {
		return renderAwakePrompt(await this.promptInput(run, redeliveryRange));
	}

	private async renderNudge(run: RunHandle, redeliveryRange: { fromSeq: number; toSeq: number } | undefined): Promise<string> {
		return renderNudgePrompt({ ...(await this.promptInput(run, redeliveryRange)), nudge: run.nudges });
	}

	private async promptInput(run: RunHandle, redeliveryRange: { fromSeq: number; toSeq: number } | undefined) {
		const { config, store, runs } = this.deps;
		const inbound = new Set(run.events.filter((e) => e.thread).map((e) => e.thread as string));
		const carried = this.deps.threads
			.unsettled(config.config.loop.maxNudges)
			.filter((thread) => !inbound.has(thread.thread));
		const memoryQuery = run.events.map((event) => `${event.title} ${event.text}`).join(" ");
		const relevantMemories = config.config.memory.enabled !== false && memoryQuery.trim()
			? await this.deps.toolDeps.memory.search(memoryQuery, 6, [privateMemoryScope(this.deps.config)])
			: [];
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
			summary: readSummary(config.paths.summaryPath),
			relevantMemories,
			recentRuns: runs.list(3),
			policy: this.deps.policy.load(),
			costTodayUsd: runs.usageToday().cost + (this.deps.toolDeps.workers?.usageToday() ?? 0),
			maxDailyCostUsd: config.config.budget.maxDailyCostUsd,
			pendingAfterClaim: store.pendingCount(),
			secrets: config.config.secrets,
			workers: this.deps.toolDeps.workers?.overview(6).map((worker) => ({
				id: worker.id,
				status: worker.status,
				model: worker.model,
				isolation: worker.isolation,
				branch: worker.branch,
				task: worker.task,
				result: worker.lastResult,
				error: worker.lastError,
			})),
		};
	}

	private installTurnGuard(): void {
		const previous = this.session.agent.shouldStopAfterTurn;
		this.session.agent.shouldStopAfterTurn = async (context) => {
			if (previous && (await previous(context))) return true;
			const run = this.deps.getRun();
			if (!run) return false;
			// Turns are counted for telemetry and anomaly detection only. There is
			// deliberately no turn limit: a run may work for as long as it needs.
			// Only the budget guard and an explicitly configured `runTimeoutMs`
			// can stop it; a long run is warned about, not killed (#127).
			run.turns += 1;
			// A deliberate shutdown lets the current tool result finish, then stops
			// the session loop here instead of starting another model step (#124).
			if (this.draining) {
				this.deps.log.info(`run #${run.index} stopping after the current step (graceful shutdown)`);
				return true;
			}
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
					if (errorMessage) {
						run.lastError = maskSecrets(errorMessage, this.deps.config.config.secrets);
					}
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
				this.trackRepeatedTool(event.toolName, event.args);
				if (run) this.toolCallsThisRun += 1;
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
			case "turn_start": {
				if (run) this.turnTrace.startTurn();
				break;
			}
			case "turn_end": {
				// The assistant message carries the provider usage of this turn; the
				// tool results name the tools it called.
				if (run) this.turnTrace.endTurn({ message: event.message, toolResults: event.toolResults });
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
	 * Detect the same tool call repeated with identical arguments (#127).
	 *
	 * Only the tool name and a canonical fingerprint of its arguments are kept,
	 * so this can never store prompt or message text. Fires once per run when the
	 * streak reaches `RUN_REPEAT_TOOL_THRESHOLD`; a different call resets it.
	 */
	private trackRepeatedTool(toolName: string | undefined, args: unknown): void {
		const run = this.deps.getRun();
		const watch = this.watch;
		if (!run || !watch || watch.runId !== run.id || typeof toolName !== "string") return;
		// Hash keeps the memory bounded even when a tool argument carries a file.
		const key = `${toolName}\u0000${createHash("sha1").update(stableJson(args)).digest("hex")}`;
		if (key === watch.lastToolKey) {
			watch.repeatCount += 1;
		} else {
			watch.lastToolKey = key;
			watch.repeatCount = 1;
			watch.repeatFlagged = false;
		}
		if (watch.repeatFlagged || watch.repeatCount < RUN_REPEAT_TOOL_THRESHOLD) return;
		watch.repeatFlagged = true;
		const now = Date.now();
		this.emitAnomaly(run, {
			type: "run_repeat_tool",
			now,
			activeMs: runActiveMs(run, now),
			tool: toolName,
			repeats: watch.repeatCount,
		});
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
			await this.session.steer(renderInterruptPrompt(pending, this.deps.config.config.secrets));
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

function addUsage(left: RunRecord["usage"], right: RunRecord["usage"]): RunRecord["usage"] {
	return {
		input: left.input + right.input,
		output: left.output + right.output,
		cacheRead: left.cacheRead + right.cacheRead,
		cacheWrite: left.cacheWrite + right.cacheWrite,
		total: left.total + right.total,
		cost: left.cost + right.cost,
	};
}

/**
 * The service prompt that reopens an interrupted run (#124).
 *
 * It is deliberately explicit about context preservation and the outbound
 * dedupe rule: the model must continue rather than replay work it already did.
 */
export function resumePrompt(previous: RunRecord, awake: string): string {
	const interruptedAt = new Date(previous.finishedAt).toISOString();
	return [
		`продолжай — предыдущий run #${previous.index} был прерван плановым рестартом harness (${interruptedAt}).`,
		`Его контекст сохранён: это та же запись run и та же pi-сессия. Не начинай заново и не повторяй уже сделанное.`,
		`В записи уже ${previous.outbound.length} outbound-сообщени(й); не отправляй их повторно.`,
		``, awake,
	].join("\n");
}

/** JSON with recursively sorted object keys, so identical arguments compare equal. */
export function stableJson(value: unknown): string {
	if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "undefined";
	if (Array.isArray(value)) return `[${value.map((item) => stableJson(item)).join(",")}]`;
	const record = value as Record<string, unknown>;
	const keys = Object.keys(record).sort();
	return `{${keys.map((key) => `${JSON.stringify(key)}:${stableJson(record[key])}`).join(",")}}`;
}

function sessionTokenTotal(session: AgentSession): number {
	try {
		return session.getSessionStats().tokens?.total ?? 0;
	} catch {
		return 0;
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

export function readSummary(file: string): string {
	try { return fs.readFileSync(file, "utf8").trim(); } catch { return ""; }
}

export function describeRunRecord(record: RunRecord): string {
	const outbound = record.outbound.length > 0 ? `${record.outbound.length} outbound` : "no outbound";
	return `#${record.index} ${formatDuration(record.durationMs)} ${record.stopReason}: ${record.events.length} events, ${outbound}`;
}
