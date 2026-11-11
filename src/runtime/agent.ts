import { createHash } from "node:crypto";
import * as fs from "node:fs";
import type { AgentSession, AgentSessionEvent } from "@earendil-works/pi-coding-agent";
import { resolveContextPolicy, type LoadedConfig } from "../config.js";
import type { Logger } from "../log.js";
import { appendJsonl, formatDuration, oneLine, sleep, truncate } from "../util.js";
import { term, stamp } from "../term.js";
import type { AliveEvent } from "../store/events.js";
import type { EventStore } from "../store/events.js";
import type { PolicyStore } from "../store/policy.js";
import { runTurnCount, type ContextResetReason, type RunLog, type RunProviderError, type RunRecord, type RunStoppedBy, type RunStopReason } from "../store/runs.js";
import type { ThreadStore } from "../store/threads.js";
import { renderAwakePrompt, renderInterruptPrompt, renderLongRunWarning, renderNudgePrompt } from "./prompt.js";
import { onboardingContext } from "../store/onboarding.js";
import { TurnTraceRecorder, hasUsage, residualUsage } from "./run-trace.js";
import type { RunAnomalyEvent, RunEventSink } from "../store/run-events.js";
import { hasWakeWorthyPending } from "./wake.js";
import { classifyNetworkError, withRetries } from "../retry.js";
import { maskSecrets } from "../secrets.js";
import { cacheHitRate, isColdCacheRun } from "../usage/cache.js";
import { privateMemoryScope } from "./memory-access.js";
import { compactionMonitorFor } from "./compaction.js";
import {
	ProviderDiagnostics,
	hasImageAttachments,
	isRequestFormatError,
	providerErrorRecord,
	type ProviderDiagnosticsSnapshot,
} from "./provider-diag.js";
import type { RunHandle, ToolDeps } from "./tools.js";
import type { ToolAbortGate } from "./tool-abort.js";

/**
 * A prompt may be retried only when the failure happened before any tool ran or
 * any token was spent, so replaying it cannot duplicate work or billing.
 */
const AGENT_PROVIDER_RETRY_ATTEMPTS = 3;
const AGENT_PROVIDER_RETRY_BASE_MS = 1_000;
const AGENT_PROVIDER_RETRY_MAX_DELAY_MS = 15_000;

/**
 * How many times a context-sleep run may roll its claim back for redelivery.
 *
 * This is a safety cap, not a configuration knob (#219). A run that wakes on an
 * event, gets the context-sleep directive and sleeps without sending anything
 * must not acknowledge the event, otherwise the sender sees a successful
 * delivery and never gets an answer. Redelivering it is only safe while the
 * loop is bounded: the next run starts on a fresh context, but if it grows past
 * the threshold again before handling the event, the same event comes back.
 * After {@link CONTEXT_SLEEP_REDELIVER_MAX} redeliveries the runtime accepts the
 * loss (acknowledges the events) and records `events_dropped` instead of
 * looping forever.
 */
export const CONTEXT_SLEEP_REDELIVER_MAX = 2;

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

/** Who asked for a deliberate shutdown (#168): `alive restart` or `alive stop`. */
export type StopInitiator = "restart" | "stop";

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
	/**
	 * Operator abort of the current tool (#164). Optional so the fake-session
	 * tests and embedders that do not expose a dashboard still work; when set,
	 * every active tool is wrapped and can be aborted without touching the run.
	 */
	toolAbortGate?: ToolAbortGate;
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

/**
 * Who ended a run, from how it ended (#168).
 *
 * - `slept` — the agent chose to sleep;
 * - `timeout`/`budget`/`stalled` — a safety limit (or a model that refused to idle);
 * - `error` — the provider/session that raised it (`errorSource: "provider"`) or
 *   the assistant message that reported it (`"model"`);
 * - `interrupted`/`aborted` — a deliberate shutdown: `cancel` once the grace
 *   budget expired and the session was aborted, otherwise the initiator the
 *   runtime recorded (`restart` by default, `stop` for `alive stop`).
 */
export function runStoppedByFor(
	stopReason: RunStopReason,
	input: { errorSource?: "provider" | "model"; forcedAbort: boolean; initiator: StopInitiator },
): RunStoppedBy {
	switch (stopReason) {
		case "slept":
			return "sleep";
		case "stalled":
		case "timeout":
		case "budget":
			return "limit";
		case "error":
			return input.errorSource === "provider" ? "provider" : "model";
		default:
			return input.forcedAbort ? "cancel" : input.initiator;
	}
}

/**
 * The one built-in context-size hint (#123).
 *
 * The runtime steers this message when the session context crosses
 * `loop.contextWarnTokens`: sleep is the agent's own tool and remains
 * voluntary, so the hint only tells it when sleeping is a good idea. The
 * operator may reword this freely — keep it a hint, not an instruction to stop
 * in the middle of a coherent task.
 */
export const CONTEXT_WARN_MESSAGE =
	"Контекст стал большим. Если текущая задача завершена или ты переключаешься на несвязанную работу — " +
	"уйди в `sleep`: сон сохраняет память через summary. Не уходи в сон посреди связной задачи.";

/**
 * The soft context-sleep directive (#170).
 *
 * Unlike {@link CONTEXT_WARN_MESSAGE} this is an instruction, not a hint: at
 * `contextSleepTokens` the agent must finish the current step and sleep. The
 * runtime enforces it at the step boundary after `contextSleepGraceTurns`, so
 * the agent cannot grow the context past the ceiling just by ignoring it.
 */
export const CONTEXT_SLEEP_MESSAGE =
	"Контекст выше порога: заверши текущий шаг и уйди в `sleep` сейчас. " +
	"Сон сохраняет память через summary — перед сном вызови retain и передай полный summary_md. " +
	"Не начинай новую задачу в этом контексте.";

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
	/**
	 * Bounded sliding window of the most recent tool-call fingerprints (#70):
	 * `tool name + sha1(canonical args)`, at most `repeatToolWindow` entries.
	 * Short strings only — never prompt, message or argument text.
	 */
	recentToolKeys: string[];
	/** Fingerprints already reported in this run, so one repeat pattern warns once. */
	repeatToolFlagged: Set<string>;
	/** Context size (tokens) at the last `context_high` hint; undefined until the first. */
	contextWarnedAt?: number;
	/** First turn at/above the soft threshold; undefined while below it. */
	contextSoftSince?: number;
	/** True once the soft sleep directive has been steered for this crossing. */
	contextSleepSteered: boolean;
	/**
	 * True once the context-sleep directive has been steered in this run.
	 *
	 * Unlike `contextSleepSteered` this is never re-armed when the context falls
	 * back below the soft threshold: it survives until the run ends, so the
	 * runtime can tell at the end of `execute()` that a sleep came from the
	 * directive rather than from the agent's own decision (#219).
	 */
	contextSleepDirected: boolean;
	/** Forced reset that ended this run; persisted on the record. */
	contextReset?: { reason: ContextResetReason; tokens: number; limitTokens: number };
	/** Turn of the previous failed compaction, for the repeated-failure window. */
	lastCompactionFailureTurn?: number;
	/** The tool currently executing in this run (#164), if any. */
	activeTool?: { name: string; startedAt: number };
	/** True once `tool_long` was emitted for the current tool invocation. */
	toolLongFlagged: boolean;
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
	/** Run id whose repeated tool calls already triggered `repeatToolAbort` (#70). */
	private repeatAbortRunId: string | null = null;
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
	/**
	 * Who is shutting the runner down (#168), set by `AliveRuntime.stop()` before
	 * draining. It only labels the run record: `stop` vs `restart` decide nothing
	 * else. Defaults to `restart`, the historical meaning of a SIGTERM.
	 */
	private stopInitiator: StopInitiator = "restart";
	/**
	 * Set by `abortNow()`: a force stop (#181) closes the run mid-flight, so any
	 * spend without a confirmed `turn_end` must be flagged unsettled on the
	 * record. It never invents usage numbers.
	 */
	private forceClosing = false;
	/** Resolves when the active `execute` has written its record. */
	private executionSettled: { promise: Promise<void>; resolve: () => void } | undefined;
	/** Provider request/response evidence of the current run (#176). */
	private readonly providerDiagnostics: ProviderDiagnostics;

	constructor(deps: AgentRunnerDeps) {
		this.deps = deps;
		this.providerDiagnostics = new ProviderDiagnostics({
			log: deps.log,
			secrets: deps.config.config.secrets,
		});
	}

	async init(): Promise<void> {
		this.session = await this.deps.createSession(false);
		this.attach();
	}

	get currentSession(): AgentSession {
		return this.session;
	}

	/**
	 * True once `init()` built a session. A boot that failed before that (for
	 * example a repeated init failure that leaves the process alive in
	 * `status: "error"`, #178) still has to survive a stop request.
	 */
	get hasSession(): boolean {
		return Boolean(this.session);
	}

	/** Set by AliveRuntime.stop() so the run record can distinguish abort from error. */
	markAborting(): void {
		this.aborting = true;
		this.abortRetryDelay();
	}

	/**
	 * Record who is stopping the runner (#168). Called before `drain()` so the run
	 * that the deliberate shutdown ends carries `stoppedBy: "stop"` or
	 * `"restart"` instead of a guess.
	 */
	setStopInitiator(initiator: StopInitiator): void {
		this.stopInitiator = initiator;
	}

	/** Interrupt a scheduled backoff, but leave an in-flight prompt to session.abort(). */
	private abortRetryDelay(): void {
		if (!this.session.isStreaming) this.promptRetryAbort?.abort();
	}

	/**
	 * Close the active run immediately, without waiting for the drain (#181).
	 *
	 * This is the `--force` half of a stop/restart: it keeps the `draining` flag
	 * (not `aborting`) so the run settles through the ordinary path as a
	 * deliberate `interrupted` record labelled with the initiator (`stop` or
	 * `restart`) instead of `cancel`, and marks the record `usageUnsettled`
	 * because the aborted step may have spent tokens without a `turn_end`.
	 * The session abort is what stops the current tool call; the operator
	 * tool-abort gate is deliberately not involved (#164, #181).
	 */
	async abortNow(): Promise<{ durationMs: number; active: boolean }> {
		const startedAt = Date.now();
		if (!this.hasSession) return { durationMs: 0, active: false };
		this.forceClosing = true;
		this.draining = true;
		this.abortRetryDelay();
		const execution = this.executionSettled?.promise;
		if (!execution) {
			this.forceClosing = false;
			this.draining = false;
			return { durationMs: Date.now() - startedAt, active: false };
		}
		try {
			await this.session.abort();
		} catch (err) {
			this.deps.log.warn("force-stop abort failed", { error: err instanceof Error ? err.message : String(err) });
		}
		await execution;
		return { durationMs: Date.now() - startedAt, active: true };
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
		// A stop before the first session exists (a halted boot) has nothing to drain.
		if (!this.hasSession) return { outcome: "idle", durationMs: 0 };
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
		// A rebuilt session has a new agent; `attach` is idempotent per agent object.
		this.providerDiagnostics.attach(this.session.agent);
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
		// A repeated-tool abort (#70) has already ended this run: no further guard or
		// warning should race a second `session.abort()`.
		if (this.repeatAbortRunId === run.id) return;
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

		// One tool call that has been running longer than `toolLongMs` (#164). This
		// is a visible anomaly, never a stop: the operator may abort only that tool
		// (dashboard, Telegram or CLI), and the run continues afterwards. The flag
		// is reset when the call ends or another call starts, so a single hanging
		// invocation produces exactly one event, not one per scheduler tick.
		if (loop.toolLongMs > 0 && watch.activeTool && !watch.toolLongFlagged) {
			const toolMs = Math.max(0, now - watch.activeTool.startedAt);
			if (toolMs >= loop.toolLongMs) {
				watch.toolLongFlagged = true;
				this.emitAnomaly(run, {
					type: "tool_long",
					now,
					activeMs,
					limitMs: loop.toolLongMs,
					tool: watch.activeTool.name,
					toolMs,
				});
			}
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
			contextTokens?: number;
			limitTokens?: number;
			resetReason?: RunAnomalyEvent["resetReason"];
			tool?: string;
			repeats?: number;
			reasonClass?: RunAnomalyEvent["reasonClass"];
			attempt?: number;
			maxAttempts?: number;
			/** `events_dropped`: override the base inbound-event count with the dropped count. */
			events?: number;
			/** `events_dropped`: the sequence numbers dropped. */
			seqs?: number[];
			/** `events_dropped`: event kind for each seq, in the same order. */
			kinds?: string[];
			/** `events_dropped`: why the run stopped. */
			stopReason?: RunStopReason;
			/** `tool_long`: how long the single tool call has been running. */
			toolMs?: number;
			/** Log-only: the short reason and masked provider excerpt, never persisted. */
			reason?: string;
			excerpt?: string;
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
			events: input.events ?? run.events.length,
			limitMs: input.limitMs,
			limitTurns: input.limitTurns,
			contextTokens: input.contextTokens,
			limitTokens: input.limitTokens,
			resetReason: input.resetReason,
			tool: input.tool,
			repeats: input.repeats,
			reasonClass: input.reasonClass,
			attempt: input.attempt,
			maxAttempts: input.maxAttempts,
			toolMs: input.toolMs,
			seqs: input.seqs,
			kinds: input.kinds,
			stopReason: input.stopReason,
		};
		this.deps.runEvents?.append(event);
		this.deps.log.warn(event.type, {
			...event,
			...(input.reason ? { reason: input.reason } : {}),
			...(input.excerpt ? { excerpt: input.excerpt } : {}),
		});
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
			// Fresh evidence per run: a previous run's request must never be attached
			// to an error that happened before this run reached the provider.
			this.providerDiagnostics.reset();
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
				repeatToolFlagged: new Set<string>(),
				recentToolKeys: [],
				contextWarnedAt: undefined,
				contextSoftSince: undefined,
				contextSleepSteered: false,
				contextSleepDirected: false,
				contextReset: undefined,
				lastCompactionFailureTurn: undefined,
				activeTool: undefined,
				toolLongFlagged: false,
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
			/** Which side raised `stopReason = "error"`: the provider/session or the model (#168). */
			let errorSource: "provider" | "model" | undefined;
			let error: string | undefined;
			/** Provider evidence persisted when the run closes with a provider error (#176). */
			let providerError: RunProviderError | undefined;
			/** One attachment-free retry per run: a format rejection must not loop. */
			let formatRetried = false;
			let first = true;

			while (true) {
				if (this.draining || this.aborting || this.deps.isStopping()) {
					stopReason = this.draining && !this.aborting ? "interrupted" : "aborted";
					break;
				}
				if (!first) this.trackEvents(run, this.claimDeliverable());
				let activePrompt: string | undefined;
				try {
					const awake = first
						? await this.renderAwake(run, options.redeliveryRange)
						: await this.renderNudge(run, options.redeliveryRange);
					const prompt = first && previous ? resumePrompt(previous, awake) : awake;
					activePrompt = prompt;
					first = false;
					run.promptChars += prompt.length;
					const tokensBeforePrompt = sessionTokenTotal(this.session);
					// Re-wrap right before each model step: a tool activated during the
					// previous step (e.g. by the tool registry) must also be abortable.
					this.deps.toolAbortGate?.wrapAgent(this.session.agent);
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
				} catch (caught) {
					if (this.aborting || this.draining || this.deps.isStopping()) {
						// The fallback abort after the grace budget, or an abort raced by a
						// stop: this is a deliberate stop, not a model failure.
						stopReason = this.draining && !this.aborting ? "interrupted" : "aborted";
						log.info(`run #${run.index} session stopped during shutdown`, { stopReason });
						break;
					}
					const snapshot = this.providerDiagnostics.take();
					const reported = this.logProviderError(run, caught, snapshot);
					error = reported.error;
					// #176: a format rejection of a request that carried images gets exactly one
					// retry with the image blocks stripped from the OUTGOING payload. The
					// session history keeps its attachments; `dropAttachmentsOnce` changes
					// only what is sent next. Never retried during shutdown or a second time
					// in the same run.
					const retryPrompt = activePrompt;
					const canRetryWithoutAttachments =
						!formatRetried &&
						hasImageAttachments(snapshot?.request) &&
						isRequestFormatError({ status: reported.record.status, body: reported.record.body }) &&
						!this.aborting &&
						!this.draining &&
						!this.deps.isStopping();
					if (!canRetryWithoutAttachments || retryPrompt === undefined) {
						providerError = reported.record;
						stopReason = "error";
						// Thrown out of `session.prompt`: the provider, the network or the
						// session failed, not the model's answer (#168).
						errorSource = "provider";
						break;
					}
					formatRetried = true;
					this.providerDiagnostics.dropAttachmentsOnce();
					log.warn(`run #${run.index} provider format retry without attachments`, {
						status: reported.record.status,
						requestId: reported.record.requestId,
						model: snapshot?.request?.model,
						images: snapshot?.request?.blocks.image,
						imageBytes: snapshot?.request?.imageBytes,
					});
					try {
						await this.session.prompt(retryPrompt, { expandPromptTemplates: false, source: "extension" });
					} catch (retryCaught) {
						// The retry itself failed: close the run with its own evidence.
						const retrySnapshot = this.providerDiagnostics.take();
						const retryReport = this.logProviderError(run, retryCaught, retrySnapshot);
						error = retryReport.error;
						providerError = retryReport.record;
						stopReason = "error";
						errorSource = "provider";
						break;
					}
					// Retry succeeded: fall through to the ordinary post-prompt checks.
				}

				if (run.sleepRequested) {
					stopReason = "slept";
					break;
				}
				if (this.timedOutRunId === run.id || this.repeatAbortRunId === run.id) {
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
					// The assistant message itself reported the failure (#168).
					errorSource = "model";
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
			// Consistency check only (#168): the session-stats delta is measured from
			// the snapshot taken at *run* start (`statsBefore`), so spend the session
			// made before this run began is never counted here. Spend that no
			// confirmed `turn_end` of this segment accounts for is flagged on the
			// record and logged; the usage numbers themselves are never rewritten
			// and no step is invented.
			const residual = residualUsage(segmentUsage, [{ usage: this.turnTrace.usageSinceReset() }]);
			// Force stop (#181): a run closed mid-flight may have no `turn_end` for
			// its last step, so treat its usage as unsettled even when the numbers
			// happen to balance. The flag never changes the numbers themselves.
			const usageUnsettled = hasUsage(residual) || this.forceClosing;
			if (!run.idling) run.activeMs += Math.max(0, finishedAt - (run.activeSince ?? finishedAt));
			// Who ended the run (#168): derived once from the outcome and, for a
			// deliberate shutdown, from the initiator the CLI recorded.
			const finalStopReason: RunStopReason = stopReason ?? "stalled";
			const stoppedBy = runStoppedByFor(finalStopReason, {
				errorSource,
				forcedAbort: this.aborting,
				initiator: this.stopInitiator,
			});

			const reachedModel = run.lastStopReason !== undefined || run.turns > 0 || run.idleReturns > 0;
			const redeliver = stopReason === "error" || stopReason === "timeout" || stopReason === "aborted";
			// #219: a sleep caused by the context-sleep directive before any outbound
			// means the claimed events were never handled. Acknowledge nothing in that
			// case: the sender would otherwise see a successful delivery with no answer.
			const contextSleepDirected =
				stopReason === "slept" && this.watch?.contextSleepDirected === true && run.outbound.length === 0;
			this.deps.setRun(undefined);
			if (contextSleepDirected) {
				this.settleContextSleepClaim(run, finalStopReason);
			} else if (reachedModel && !redeliver) {
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
				stopReason: finalStopReason,
				stoppedBy,
				error,
				providerError: finalStopReason === "error" && errorSource === "provider" ? providerError : undefined,
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
				usageUnsettled: usageUnsettled ? true : undefined,
				sleep: run.sleepRequested ? { forced: run.sleepForced, summaryChars: run.sleepSummary?.length ?? 0 } : undefined,
				compaction: compactionMonitorFor(this.session)?.record(),
				contextReset: this.watch?.contextReset,
			};

			this.deps.runs.record(record);
			this.timedOutRunId = null;
			this.repeatAbortRunId = null;
			this.budgetRunId = null;
			this.watch = undefined;
			this.promptRetryAbort = undefined;

			log.info(`run #${run.index} end`, {
				stopReason: record.stopReason,
				stoppedBy: record.stoppedBy,
				durationMs: record.durationMs,
				activeMs: record.activeMs,
				idleMs: record.idleMs,
				turns: record.turns,
				outbound: record.outbound.length,
				usage: usage.cost,
				promptTokens: usage.input,
				cacheRead: usage.cacheRead,
				cacheWrite: usage.cacheWrite,
				cacheHitRate: cacheHitRate(usage),
				resumed: Boolean(previous),
			});
			if (isColdCacheRun(usage)) {
				log.warn(`run #${run.index} wrote ${usage.cacheWrite} cache tokens and read none`);
			}
			if (usageUnsettled) {
				log.warn(`run #${run.index} spent tokens that no turn_end accounts for`, {
					residualInput: residual.input,
					residualOutput: residual.output,
					residualTotal: residual.total,
					residualCost: residual.cost,
					turns: run.turns,
				});
			}

			if (stopReason === "slept") await this.rebuildSession();
			return record;
		} finally {
			this.aborting = false;
			this.draining = false;
			this.forceClosing = false;
			this.providerDiagnostics.reset();
			this.deps.setRun(undefined);
			if (this.executionSettled?.promise === settled) this.executionSettled = undefined;
			settle();
		}
	}

	/**
	 * `{seq, kind}` for each seq, in ascending order, read from the durable inbox.
	 * Used by the redelivery/drop warnings so an operator can find the event in
	 * `inbox/events.jsonl` and resend it by hand. Never includes event text.
	 */
	private describeSeqs(seqs: number[]): Array<{ seq: number; kind: string }> {
		const kinds = new Map(this.deps.store.all().map((event) => [event.seq, event.kind]));
		return [...seqs].sort((left, right) => left - right).map((seq) => ({ seq, kind: kinds.get(seq) ?? "unknown" }));
	}

	/**
	 * Settle the claim of a run that slept on the context-sleep directive without
	 * sending anything (#219).
	 *
	 * The events were delivered but never handled, so they are rolled back for
	 * redelivery. To keep the wake → directive → sleep loop bounded, every event
	 * carries a redelivery counter in the cursor; once the whole claimed range
	 * has exhausted {@link CONTEXT_SLEEP_REDELIVER_MAX}, the runtime accepts the
	 * loss: it acknowledges the range, warns with the seqs and records an
	 * `events_dropped` anomaly. A mixed range gives up on the exhausted head
	 * only (via `ackThrough`) and redelivers the rest, which is simple and
	 * guarantees the loop terminates.
	 */
	private settleContextSleepClaim(run: RunHandle, stopReason: RunStopReason): void {
		const store = this.deps.store;
		const range = store.claimedRange();
		if (!range) {
			store.endRun();
			return;
		}
		const seqs: number[] = [];
		for (let seq = range.fromSeq; seq <= range.toSeq; seq += 1) seqs.push(seq);
		const retryable = seqs.filter((seq) => store.redeliveryCount(seq) < CONTEXT_SLEEP_REDELIVER_MAX);
		if (retryable.length === 0) {
			store.endRun();
			const dropped = this.describeSeqs(seqs);
			this.deps.log.warn(`run #${run.index} dropping events unprocessed by context-sleep`, {
				reason: "context-sleep",
				stopReason,
				events: seqs.length,
				seqs,
				dropped,
				maxRedeliveries: CONTEXT_SLEEP_REDELIVER_MAX,
			});
			const now = Date.now();
			this.emitAnomaly(run, {
				type: "events_dropped",
				now,
				activeMs: runActiveMs(run, now),
				events: seqs.length,
				seqs,
				kinds: dropped.map((entry) => entry.kind),
				stopReason,
			});
			return;
		}
		// Mixed range: acknowledge the exhausted head, roll back the rest. Events
		// after the first retryable seq are redelivered even if their own counter
		// is already at the cap; that only delays their drop by a round.
		const firstRetryable = retryable[0]!;
		if (firstRetryable > range.fromSeq) store.ackThrough(firstRetryable - 1);
		store.rollbackClaimForRedelivery();
		const droppedHead = seqs.filter((seq) => seq < firstRetryable);
		const redelivered = seqs.filter((seq) => seq >= firstRetryable);
		if (droppedHead.length > 0) {
			// The exhausted head is lost even though the tail is redelivered: the
			// dashboard must show it as a drop, not only the redelivery warn.
			const dropped = this.describeSeqs(droppedHead);
			const now = Date.now();
			this.emitAnomaly(run, {
				type: "events_dropped",
				now,
				activeMs: runActiveMs(run, now),
				events: droppedHead.length,
				seqs: droppedHead,
				kinds: dropped.map((entry) => entry.kind),
				stopReason,
			});
		}
		this.deps.log.warn(`run #${run.index} left events unacknowledged; they will be redelivered`, {
			reason: "context-sleep",
			stopReason,
			events: redelivered.length,
			seqs: redelivered,
			redelivered: this.describeSeqs(redelivered),
			dropped: droppedHead.length > 0 ? this.describeSeqs(droppedHead) : undefined,
			maxRedeliveries: CONTEXT_SLEEP_REDELIVER_MAX,
		});
	}

	/**
	 * Log one provider failure with its #176 evidence and build the record block.
	 *
	 * The existing `error` field stays exactly what it was (the masked error
	 * message); status/request id/body/request summary are added beside it.
	 */
	private logProviderError(
		run: RunHandle,
		caught: unknown,
		snapshot: ProviderDiagnosticsSnapshot | undefined,
	): { error: string; record: RunProviderError } {
		const description = this.providerDiagnostics.describeError(caught);
		const record = providerErrorRecord(Date.now(), description, snapshot);
		const error = maskSecrets(caught instanceof Error ? caught.message : String(caught), this.deps.config.config.secrets);
		this.deps.log.error(`run #${run.index} session error`, {
			error,
			...(record.status !== undefined ? { status: record.status } : {}),
			...(record.requestId !== undefined ? { requestId: record.requestId } : {}),
			...(record.code !== undefined ? { code: record.code } : {}),
			...(record.body !== undefined ? { body: record.body } : {}),
			...(record.model !== undefined ? { model: record.model } : {}),
			...(record.request !== undefined ? { request: record.request } : {}),
			...(record.attachmentsDropped === true ? { attachmentsDropped: true } : {}),
			...(record.imagesOmitted !== undefined ? { imagesOmitted: record.imagesOmitted } : {}),
		});
		return { error, record };
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
		return renderAwakePrompt(await this.promptInput(run, redeliveryRange)) + this.conversationPreferences(run.events.slice(-this.deps.config.config.loop.maxEventsPerIdle));
	}

	private conversationPreferences(events: AliveEvent[]): string {
		return this.deps.config.config.tools.allowlist.includes("onboarding")
			? maskSecrets(onboardingContext(this.deps.config.paths.stateDir, events), this.deps.config.config.secrets)
			: "";
	}

	private async renderNudge(run: RunHandle, redeliveryRange: { fromSeq: number; toSeq: number } | undefined): Promise<string> {
		return renderNudgePrompt({ ...(await this.promptInput(run, redeliveryRange)), nudge: run.nudges }) + this.conversationPreferences(run.events.slice(-this.deps.config.config.loop.maxEventsPerIdle));
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
		const today = runs.usageToday();
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
			costTodayUsd: today.cost + (this.deps.toolDeps.workers?.usageToday() ?? 0),
			cacheToday: { input: today.input, cacheRead: today.cacheRead ?? 0, cacheWrite: today.cacheWrite ?? 0 },
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
			// Only hint while the run is actually continuing: no steering into a
			// run that is already being stopped or drained.
			this.noteContextSize(run);
			// Context pressure is enforced here, at the step boundary, in runtime
			// code (#170). It must not depend on the agent calling a tool.
			this.maybeForceContextReset(run);
			if (run.sleepRequested) return true;
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
				if (this.watch && this.watch.runId === run?.id && typeof event.toolName === "string") {
					this.watch.activeTool = { name: event.toolName, startedAt: Date.now() };
					this.watch.toolLongFlagged = false;
				}
				const label = oneLine(JSON.stringify(event.args ?? {}), 160);
				if (this.deps.config.config.verbose) {
					this.deps.log.raw(`${term.dim(stamp())} ${term.cyan(`→ ${event.toolName}`)} ${term.gray(label)}`);
				}
				break;
			}
			case "tool_execution_end": {
				if (this.watch && this.watch.activeTool?.name === event.toolName) {
					this.watch.activeTool = undefined;
					this.watch.toolLongFlagged = false;
				}
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
				const monitor = compactionMonitorFor(this.session);
				const contextTokens = sessionContextTokens(this.session);
				monitor?.noteContextTokens(contextTokens);
				const outcome = monitor?.last();
				if (!event.errorMessage) {
					this.deps.log.info("compaction", {
						reason: event.reason,
						aborted: event.aborted,
						contextTokens: contextTokens || outcome?.contextTokens,
						attempts: outcome?.attempts,
					});
					break;
				}
				const reasonClass = outcome?.reasonClass ?? "provider_error";
				const attempt = outcome?.attempts ?? 1;
				const tokens = contextTokens || outcome?.contextTokens;
				if (outcome?.skipped) {
					// The failure itself was already logged once; this turn only waited
					// out the cross-turn backoff, so do not emit another anomaly/warn.
					this.deps.log.info("compaction deferred by backoff", {
						reason: event.reason,
						reasonClass,
						nextAttemptAt: outcome.nextAttemptAt,
						contextTokens: tokens,
					});
					break;
				}
				if (run) {
					this.emitAnomaly(run, {
						type: "compaction_failed",
						now: Date.now(),
						activeMs: runActiveMs(run),
						contextTokens: tokens,
						reasonClass,
						attempt,
						maxAttempts: outcome?.maxAttempts,
						reason: outcome?.reason ?? event.errorMessage,
						excerpt: outcome?.excerpt,
					});
					// A stable compaction failure is the last fallback: if it repeats within
					// the grace window, sleep resets the context instead of growing it (#170).
					this.noteCompactionFailure(run, tokens ?? 0);
				} else {
					this.deps.log.warn("compaction failed", {
						reason: event.reason,
						reasonClass,
						attempt,
						maxAttempts: outcome?.maxAttempts,
						contextTokens: tokens,
						error: maskSecrets(event.errorMessage, this.deps.config.config.secrets),
						excerpt: outcome?.excerpt,
					});
				}
				break;
			}
			default:
				break;
		}
	}

	/**
	 * Detect repeated identical tool calls (#70).
	 *
	 * Only a bounded sliding window of the most recent fingerprints is kept: the
	 * tool name plus `sha1(stableJson(args))`, at most `repeatToolWindow` short
	 * strings. Arguments are hashed and never stored, so this can never leak
	 * prompt, message or tool-argument text into an event or the log.
	 *
	 * Each call pushes its fingerprint and counts how many times that same
	 * fingerprint occurs in the window. Reaching `repeatToolThreshold` records one
	 * `run_repeat_tool` anomaly (`tool` + `repeats`) and one warning log line.
	 * A window, unlike the old strict streak, also catches an alternating
	 * A,B,A,B loop where no two identical calls are adjacent; at the same time a
	 * one-off retry after some other call still counts toward the same fingerprint.
	 * A fingerprint is reported at most once per run, so a long loop produces one
	 * event, not one per repeat. `repeatToolThreshold: 0` disables the check
	 * completely.
	 *
	 * With `repeatToolAbort` the same point aborts the run once via the existing
	 * `session.abort()` safety path. It reuses the existing `timeout` stop reason
	 * (`stoppedBy: "limit"`) instead of growing the record schema. Otherwise the
	 * event is observation-only and the runtime never steers the turn.
	 */
	private trackRepeatedTool(toolName: string | undefined, args: unknown): void {
		const run = this.deps.getRun();
		const watch = this.watch;
		if (!run || !watch || watch.runId !== run.id || typeof toolName !== "string") return;
		const loop = this.deps.config.config.loop;
		const threshold = loop.repeatToolThreshold;
		if (threshold <= 0) return;
		// Normalisation also happens in validateLoopConfig; keep a direct assignment
		// safe when a caller mutates the loaded config at runtime (tests do).
		const windowSize = Math.max(loop.repeatToolWindow, threshold);
		// Hash keeps the memory bounded even when a tool argument carries a file.
		const key = `${toolName}\u0000${createHash("sha1").update(stableJson(args)).digest("hex")}`;
		watch.recentToolKeys.push(key);
		if (watch.recentToolKeys.length > windowSize) {
			watch.recentToolKeys.splice(0, watch.recentToolKeys.length - windowSize);
		}
		let repeats = 0;
		for (const seen of watch.recentToolKeys) if (seen === key) repeats += 1;
		if (repeats < threshold || watch.repeatToolFlagged.has(key)) return;
		watch.repeatToolFlagged.add(key);
		const now = Date.now();
		this.emitAnomaly(run, {
			type: "run_repeat_tool",
			now,
			activeMs: runActiveMs(run, now),
			tool: toolName,
			repeats,
		});
		this.deps.log.warn("repeated tool call detected", { tool: toolName, repeats });
		if (!loop.repeatToolAbort || this.repeatAbortRunId === run.id) return;
		// Same single-abort guard as `timedOutRunId`: further repeats and scheduler
		// ticks must not call `session.abort()` again for this run.
		this.repeatAbortRunId = run.id;
		this.deps.log.warn(`run #${run.index} repeated tool call; aborting`, {
			tool: toolName,
			repeats,
			threshold,
			window: windowSize,
		});
		this.abortRetryDelay();
		void this.session.abort();
	}

	/**
	 * Context-size steering, checked once per turn boundary (#123, #170).
	 *
	 * The size is pi's own estimate of the current prompt/context
	 * (`contextUsage.tokens`), not the cumulative billed token counter: what
	 * matters is how much the model must carry, not how much it has spent.
	 *
	 * - At `contextSleepTokens` the agent gets one **directive**: finish the step
	 *   and sleep now. This is the soft path; the runtime still gives it
	 *   `contextSleepGraceTurns` before forcing the reset.
	 * - At `contextWarnTokens` (the older hint) it gets the advisory
	 *   {@link CONTEXT_WARN_MESSAGE}, re-armed only after another
	 *   `contextWarnStepTokens` of growth. When the soft directive fires at the
	 *   same threshold the hint is skipped so the two do not stack.
	 *
	 * Dropping back below a threshold re-arms it for the next crossing.
	 */
	private noteContextSize(run: RunHandle): void {
		const loop = this.deps.config.config.loop;
		const policy = resolveContextPolicy(this.deps.config.config);
		const watch = this.watch?.runId === run.id ? this.watch : undefined;
		if (!watch) return;
		const contextTokens = sessionContextTokens(this.session);
		if (contextTokens <= 0) return;

		if (policy.sleepTokens > 0 && contextTokens >= policy.sleepTokens) {
			// First turn of this crossing: remember when it happened and steer one
			// directive. The hint below is skipped for the same crossing.
			if (watch.contextSoftSince === undefined) watch.contextSoftSince = run.turns;
			if (!watch.contextSleepSteered) {
				watch.contextSleepSteered = true;
				watch.contextSleepDirected = true;
				// The sleep tool reads the run handle, not the private watch: expose the
				// same fact there so it does not acknowledge an unhandled claim (#219).
				run.contextSleepDirected = true;
				void this.steerContextSleep(run, contextTokens, policy.sleepTokens);
			}
			return;
		}
		// Fell back below the soft threshold: a later crossing deserves a fresh
		// directive and a fresh grace window (e.g. after a successful compaction).
		watch.contextSoftSince = undefined;
		watch.contextSleepSteered = false;

		if (loop.contextWarnTokens <= 0) return;
		if (contextTokens < loop.contextWarnTokens) {
			// Fell back below the threshold: a later crossing deserves a fresh hint.
			watch.contextWarnedAt = undefined;
			return;
		}
		const last = watch.contextWarnedAt;
		if (last !== undefined && contextTokens < last + loop.contextWarnStepTokens) return;
		watch.contextWarnedAt = contextTokens;
		const now = Date.now();
		this.emitAnomaly(run, {
			type: "context_high",
			now,
			activeMs: runActiveMs(run, now),
			contextTokens,
			limitTokens: loop.contextWarnTokens,
		});
		void this.steerContextWarning(run, contextTokens);
	}

	/**
	 * Enforce the context-sleep policy at a step boundary (#170).
	 *
	 * The hard ceiling wins over grace: crossing `contextHardTokens` forces the
	 * sleep immediately. Otherwise the soft threshold forces it once
	 * `contextSleepGraceTurns` turns have completed since the first crossing.
	 * The sleep is runtime state (`sleepRequested`/`sleepForced`), not a tool
	 * call, so a profile without `sleep` in its allowlist still resets.
	 */
	private maybeForceContextReset(run: RunHandle): void {
		if (run.sleepRequested) return;
		const watch = this.watch?.runId === run.id ? this.watch : undefined;
		if (!watch) return;
		const policy = resolveContextPolicy(this.deps.config.config);
		const contextTokens = sessionContextTokens(this.session);
		if (contextTokens <= 0) return;
		if (policy.hardTokens > 0 && contextTokens >= policy.hardTokens) {
			this.forceContextReset(run, { reason: "hard", tokens: contextTokens, limitTokens: policy.hardTokens });
			return;
		}
		if (
			policy.sleepTokens > 0 &&
			contextTokens >= policy.sleepTokens &&
			watch.contextSoftSince !== undefined &&
			run.turns - watch.contextSoftSince >= policy.sleepGraceTurns
		) {
			this.forceContextReset(run, { reason: "soft", tokens: contextTokens, limitTokens: policy.sleepTokens });
		}
	}

	/**
	 * End the run with a forced sleep and record why. The existing run path sees
	 * `sleepRequested`, records `stopReason = "slept"` and rebuilds the session,
	 * so the next run starts with a genuinely empty context.
	 */
	private forceContextReset(
		run: RunHandle,
		reset: { reason: ContextResetReason; tokens: number; limitTokens: number },
	): void {
		if (run.sleepRequested) return;
		run.sleepRequested = true;
		run.sleepForced = true;
		// A forced reset ends the run exactly like the soft context-sleep directive:
		// if it sent nothing, its claimed events were never handled and must not be
		// acknowledged (#219). This covers the hard ceiling, soft grace and repeated
		// compaction failures, including `sleepTokens = 0` where no directive is
		// ever steered.
		run.contextSleepDirected = true;
		const watch = this.watch?.runId === run.id ? this.watch : undefined;
		if (watch) {
			watch.contextReset = { ...reset };
			watch.contextSleepDirected = true;
		}
		this.deps.toolDeps.journal.append(
			`[context-reset] forced sleep (${reset.reason}): context ${reset.tokens} tokens reached ${reset.limitTokens}; ` +
				"memory survives through summary.md and journal; the next run starts with an empty context",
		);
		run.journalEntries += 1;
		const now = Date.now();
		this.emitAnomaly(run, {
			type: "context_reset",
			now,
			activeMs: runActiveMs(run, now),
			contextTokens: reset.tokens,
			limitTokens: reset.limitTokens,
			resetReason: reset.reason,
		});
	}

	/**
	 * Track a failed auto-compaction (#167) and force a reset when it keeps
	 * failing (#170). A single failure is still left to compaction's own backoff;
	 * a repeat within the grace window means the context would only keep growing.
	 * `contextSleepGraceTurns = 0` means "no grace": the first failure resets.
	 */
	private noteCompactionFailure(run: RunHandle, tokens: number): void {
		if (run.sleepRequested) return;
		const watch = this.watch?.runId === run.id ? this.watch : undefined;
		if (!watch) return;
		const policy = resolveContextPolicy(this.deps.config.config);
		const turn = run.turns;
		const previous = watch.lastCompactionFailureTurn;
		const repeatedWithinGrace = previous !== undefined && turn - previous <= policy.sleepGraceTurns;
		watch.lastCompactionFailureTurn = turn;
		if (policy.sleepGraceTurns > 0 && !repeatedWithinGrace) return;
		const limitTokens = policy.hardTokens > 0 ? policy.hardTokens : policy.sleepTokens;
		this.forceContextReset(run, { reason: "compaction", tokens, limitTokens });
	}

	/**
	 * Steer the built-in context-size hint into the working agent (#123).
	 * `sleep` remains voluntary: the run continues if the agent decides not to.
	 */
	private async steerContextWarning(run: RunHandle, contextTokens: number): Promise<void> {
		try {
			await this.session.steer(CONTEXT_WARN_MESSAGE);
			this.deps.log.info(`run #${run.index} context-size hint steered`, {
				contextTokens,
				threshold: this.deps.config.config.loop.contextWarnTokens,
			});
		} catch (err) {
			this.deps.log.warn("context-size hint failed", {
				error: err instanceof Error ? err.message : String(err),
			});
		}
	}

	/** Steer the directive that tells the agent to finish the step and sleep (#170). */
	private async steerContextSleep(run: RunHandle, contextTokens: number, threshold: number): Promise<void> {
		try {
			await this.session.steer(CONTEXT_SLEEP_MESSAGE);
			this.deps.log.info(`run #${run.index} context-sleep directive steered`, { contextTokens, threshold });
		} catch (err) {
			this.deps.log.warn("context-sleep directive failed", {
				error: err instanceof Error ? err.message : String(err),
			});
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
			await this.session.steer(renderInterruptPrompt(pending, this.deps.config.config.secrets) + this.conversationPreferences(pending));
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

/**
 * Current context (prompt) size in tokens, from pi's own estimate.
 *
 * Deliberately **not** `tokens.total`: that is the cumulative billing counter
 * over all session entries. `contextUsage.tokens` is what the model currently
 * has to carry, and it is `null`/absent while unknown (no model, or right after
 * a compaction) — an unknown size is not a reason to hint.
 */
function sessionContextTokens(session: AgentSession): number {
	try {
		const tokens = session.getSessionStats().contextUsage?.tokens;
		return typeof tokens === "number" && Number.isFinite(tokens) && tokens > 0 ? Math.round(tokens) : 0;
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
