import type { AgentSession } from "@earendil-works/pi-coding-agent";
import type { LoadedConfig } from "../config.js";
import type { Logger } from "../log.js";
import { EventStore } from "../store/events.js";
import { HistoryStore } from "../store/history.js";
import { Journal } from "../store/journal.js";
import { NoteStore } from "../store/notes.js";
import { Outbox, type OutgoingMessage } from "../store/outbox.js";
import { PolicyStore } from "../store/policy.js";
import { ReminderStore } from "../store/reminders.js";
import { AgentRunner, describeRunRecord } from "./agent.js";
import {
	readRuntimeState,
	RunLog,
	writeRuntimeState,
	type RunRecord,
	type RuntimeStateFile,
	type RuntimeStatusKind,
} from "../store/runs.js";
import { ThreadStore } from "../store/threads.js";
import { buildAgent, readSoul } from "./session.js";
import type { RunHandle, ToolDeps } from "./tools.js";
import { ConsoleTransport, NullTransport } from "../transports/console.js";
import { HttpTransport } from "../transports/http.js";
import type { ChatTransport } from "../transports/types.js";
import { ModuleHost } from "../events/host.js";
import { loadModules } from "../events/loader.js";
import type { AliveModule } from "../events/api.js";
import { term } from "../term.js";
import { formatDuration, isProcessAlive, nextMidnight, oneLine, sleep } from "../util.js";

export interface AliveRuntimeOptions {
	config: LoadedConfig;
	log: Logger;
	force?: boolean;
}

/**
 * The continuous runtime.
 *
 * There is no wake-per-batch outer loop anymore. The agent is a single
 * long-lived process: it is prompted once, then it drives itself with the
 * blocking `idle` tool, which returns events as tool output. The runtime only:
 *
 *   - keeps the durable inbox, reminders, memory and transports alive,
 *   - fires due reminders into the inbox on a timer,
 *   - applies the active-time watchdog and budget guard,
 *   - rebuilds the session (context reset) when the agent calls `sleep`.
 *
 * Everything else — when to work, when to wait, when to sleep — belongs to the
 * agent.
 */
export class AliveRuntime {
	readonly config: LoadedConfig;
	readonly log: Logger;

	private readonly force: boolean;
	private store!: EventStore;
	private reminders!: ReminderStore;
	private notes!: NoteStore;
	private journal!: Journal;
	private threads!: ThreadStore;
	private outbox!: Outbox;
	private policy!: PolicyStore;
	private history!: HistoryStore;
	private runs!: RunLog;
	private runner!: AgentRunner;
	private toolDeps!: ToolDeps;
	private host!: ModuleHost;
	private modules: AliveModule[] = [];
	private moduleErrors: Array<{ name: string; error: string }> = [];

	private currentRun: RunHandle | undefined;
	private redeliveryRange: { fromSeq: number; toSeq: number } | undefined;
	private statusKind: RuntimeStatusKind = "starting";
	private consecutiveFailures = 0;
	private sleepCount = 0;
	private abortController = new AbortController();
	private loopPromise: Promise<void> | undefined;
	private schedulerTimer: NodeJS.Timeout | undefined;
	private stopping = false;
	private initialized = false;
	private startedAt = Date.now();
	private lastStateWriteAt = 0;
	private lastBudgetNotice = "";

	private constructor(options: AliveRuntimeOptions) {
		this.config = options.config;
		this.log = options.log;
		this.force = options.force ?? false;
	}

	static async create(options: AliveRuntimeOptions): Promise<AliveRuntime> {
		const runtime = new AliveRuntime(options);
		await runtime.build();
		return runtime;
	}

	private async build(): Promise<void> {
		const { paths } = this.config;
		this.store = EventStore.open(paths.stateDir);
		this.reminders = new ReminderStore(paths.stateDir);
		this.notes = new NoteStore(paths.stateDir);
		this.journal = new Journal(paths.stateDir);
		this.threads = new ThreadStore(paths.stateDir);
		this.outbox = new Outbox(paths.stateDir);
		this.policy = new PolicyStore(paths.stateDir);
		this.history = HistoryStore.open(paths.stateDir);
		this.runs = new RunLog(paths.stateDir);

		this.toolDeps = {
			config: this.config,
			store: this.store,
			reminders: this.reminders,
			notes: this.notes,
			journal: this.journal,
			threads: this.threads,
			outbox: this.outbox,
			policy: this.policy,
			history: this.history,
			moduleTools: [],
			deliver: (message) => this.deliver(message),
			getRun: () => this.currentRun,
			runtimeStatus: () => this.status(),
			isStopping: () => this.stopping,
			log: this.log,
		};

		this.runner = new AgentRunner({
			config: this.config,
			createSession: (forceNew) => this.createSession(forceNew),
			store: this.store,
			runs: this.runs,
			threads: this.threads,
			policy: this.policy,
			toolDeps: this.toolDeps,
			log: this.log.child("agent"),
			thoughtsFile: paths.thoughtsFile,
			getRun: () => this.currentRun,
			setRun: (run) => {
				this.currentRun = run;
			},
			runtimeStatus: () => this.status(),
			isStopping: () => this.stopping,
			isBudgetExhausted: () => !this.budgetAllowsRun(),
		});

		const loaded = await loadModules(this.config, this.log);
		this.modules = loaded.modules;
		this.moduleErrors = loaded.errors;

		this.host = new ModuleHost({
			config: this.config,
			log: this.log,
			transports: this.buildTransports(),
			modules: this.modules,
			ingest: (event) => this.store.append(event),
			outbox: (limit) => this.outbox.list(limit),
			history: this.history,
			runtimeStatus: () => this.status(),
		});
	}

	private async createSession(forceNew: boolean): Promise<AgentSession> {
		const built = await buildAgent({
			config: this.config,
			toolDeps: this.toolDeps,
			log: this.log.child("agent"),
			soul: readSoul(this.config.paths.soulPath),
			forceNewSession: forceNew,
		});
		return built.session;
	}

	private buildTransports(): ChatTransport[] {
		const transports: ChatTransport[] = [];
		if (this.config.config.chat.console) transports.push(new ConsoleTransport());
		if (this.config.config.chat.http.enabled) transports.push(new HttpTransport(this.config.config.chat.http));
		if (transports.length === 0) transports.push(new NullTransport());
		return transports;
	}

	// ---------------------------------------------------------------------
	// lifecycle
	// ---------------------------------------------------------------------

	async init(): Promise<void> {
		if (this.initialized) return;
		this.assertSingleInstance();
		this.startedAt = Date.now();
		// Claim the state file immediately: `alive status` and the daemon readiness
		// wait both key off it, and it narrows the window where a second instance
		// could pass assertSingleInstance().
		this.writeState(true);

		const crashRange = this.store.recoverAfterCrash();
		if (crashRange) {
			this.redeliveryRange = crashRange;
			this.log.warn("recovered from an interrupted run; events will be redelivered", crashRange);
			this.store.append({
				kind: "system",
				source: "runner",
				priority: "high",
				title: "process was interrupted mid-run",
				text:
					`The previous alive process stopped in the middle of a run. ` +
					`Events ${crashRange.fromSeq}..${crashRange.toSeq} are being redelivered. ` +
					`State may be partially updated — verify before assuming work is complete or missing.`,
				meta: crashRange,
			});
		}

		// Modules start first: they register outbound handlers, contribute status and
		// hand the agent their tools, and the session is built once right after.
		await this.host.init();
		this.toolDeps.moduleTools = this.host.contributedTools();
		await this.runner.init();

		this.schedulerTimer = setInterval(() => this.schedulerTick(), this.config.config.loop.pollIntervalMs);
		this.statusKind = "idle";
		this.writeState(true);
		this.initialized = true;
		const session = this.runner.currentSession;
		this.log.info(`${this.config.config.name} is alive`, {
			pid: process.pid,
			stateDir: this.config.paths.stateDir,
			workspace: this.config.paths.workspaceDir,
			model: session.model ? `${session.model.provider}/${session.model.id}` : "(default)",
			transports: this.host.transportNames,
			modules: this.host.moduleNames,
			moduleErrors: this.moduleErrors,
			sessionFile: session.sessionFile ?? "(none)",
		});
	}

	/** Blocking loop. Resolves when stop() is called. */
	async run(): Promise<void> {
		await this.init();
		this.loopPromise = this.loop();
		await this.loopPromise;
	}

	/**
	 * Process exactly one run: boot the agent with whatever is pending, let it
	 * work until it sleeps or stops, then return the run record. Used by
	 * `alive run --once` and the end-to-end smoke test.
	 */
	async runOnce(): Promise<RunRecord | null> {
		await this.init();
		this.fireDueReminders();
		const range = this.redeliveryRange;
		this.redeliveryRange = undefined;
		const record = await this.runner.execute({ redeliveryRange: range, requireEvents: true });
		if (record) this.finishRun(record);
		return record;
	}

	async stop(reason = "requested"): Promise<void> {
		if (this.stopping) return;
		this.stopping = true;
		this.log.info("stopping", { reason });
		this.abortController.abort();
		if (this.schedulerTimer) {
			clearInterval(this.schedulerTimer);
			this.schedulerTimer = undefined;
		}
		this.runner.markAborting();
		const session = this.runner?.currentSession;
		if (session?.isStreaming) {
			try {
				await session.abort();
			} catch (err) {
				this.log.warn("abort failed", { error: err instanceof Error ? err.message : String(err) });
			}
		}
		await this.loopPromise?.catch(() => undefined);
		await this.host?.stop().catch(() => undefined);
		session?.dispose();
		this.statusKind = "stopped";
		this.writeState(true);
		this.log.info("stopped", { reason });
	}

	// ---------------------------------------------------------------------
	// the loop
	// ---------------------------------------------------------------------

	private async loop(): Promise<void> {
		while (!this.stopping) {
			try {
				if (!this.budgetAllowsRun()) {
					await this.waitForBudget();
					continue;
				}
				const range = this.redeliveryRange;
				this.redeliveryRange = undefined;
				const record = await this.runner.execute({ redeliveryRange: range });
				if (record) this.finishRun(record);
				if (record?.stopReason === "error") {
					const backoffMs = Math.min(30_000 * 2 ** (this.consecutiveFailures - 1), 15 * 60_000);
					await sleep(backoffMs, this.abortController.signal);
				} else if (record?.stopReason === "stalled") {
					// The model kept ending its turn without idle/sleep. Pause briefly so
					// a broken model cannot spin runs back-to-back; this is a courtesy
					// delay, not a step limit.
					await sleep(2_000, this.abortController.signal);
				}
			} catch (err) {
				this.log.error("run failed", { error: err instanceof Error ? err.message : String(err) });
				await sleep(2_000, this.abortController.signal);
			}
		}
	}

	private schedulerTick(): void {
		try {
			this.fireDueReminders();
			this.runner.checkActiveTimeout();
			this.writeState();
		} catch (err) {
			this.log.error("scheduler tick failed", { error: err instanceof Error ? err.message : String(err) });
		}
	}

	private finishRun(record: RunRecord): void {
		if (record.stopReason === "error") {
			this.consecutiveFailures += 1;
			this.log.warn("run failed; backing off", {
				failures: this.consecutiveFailures,
				error: record.error,
			});
		} else {
			this.consecutiveFailures = 0;
		}
		if (record.stopReason === "slept") this.sleepCount += 1;
		this.printRunSummary(record);
		this.writeState(true);
	}

	private printRunSummary(record: RunRecord): void {
		const parts = [
			`run #${record.index}`,
			formatDuration(record.durationMs),
			record.idleMs > 0 ? `${formatDuration(record.idleMs)} idle` : undefined,
			`${record.events.length} event${record.events.length === 1 ? "" : "s"}`,
			record.idleReturns > 0 ? `${record.idleReturns} idle returns` : undefined,
			record.outbound.length > 0
				? `${record.outbound.length} message${record.outbound.length === 1 ? "" : "s"} → ${[
						...new Set(record.outbound.map((m) => m.thread)),
					].join(", ")}`
				: "no outbound",
			`${record.turns} turns`,
			record.usage.cost > 0 ? `$${record.usage.cost.toFixed(4)}` : undefined,
			record.stopReason === "slept" ? "slept (context reset)" : record.stopReason,
		].filter(Boolean);
		process.stderr.write(`${term.dim(`[alive] ${parts.join(" · ")}`)}\n`);
	}

	private fireDueReminders(): void {
		const due = this.reminders.fireDue(Date.now());
		for (const reminder of due) {
			this.store.append({
				kind: "reminder",
				source: "scheduler",
				priority: "normal",
				title: oneLine(reminder.text, 80),
				text: reminder.text,
				thread: reminder.thread,
				expectsReply: Boolean(reminder.thread),
				dedupeKey: `reminder:${reminder.id}`,
				meta: { reminderId: reminder.id, dueAt: reminder.dueAt, createdAt: reminder.createdAt },
			});
			this.log.info("reminder fired", { id: reminder.id, dueAt: new Date(reminder.dueAt).toISOString() });
		}
	}

	// ---------------------------------------------------------------------
	// budget & state
	// ---------------------------------------------------------------------

	private budgetAllowsRun(): boolean {
		const { maxDailyCostUsd, maxWakesPerHour } = this.config.config.budget;
		if (maxDailyCostUsd > 0 && this.runs.usageToday().cost >= maxDailyCostUsd) return false;
		if (maxWakesPerHour > 0 && this.runs.runsLastHour() >= maxWakesPerHour) return false;
		return true;
	}

	private async waitForBudget(): Promise<void> {
		this.statusKind = "paused-budget";
		const { maxDailyCostUsd, maxWakesPerHour } = this.config.config.budget;
		const usage = this.runs.usageToday();
		if (maxDailyCostUsd > 0 && usage.cost >= maxDailyCostUsd) {
			const wakeAt = nextMidnight(Date.now()) + 1_000;
			const notice = `daily cost budget reached ($${usage.cost.toFixed(4)} / $${maxDailyCostUsd.toFixed(2)}); pausing until ${new Date(wakeAt).toISOString()}`;
			if (this.lastBudgetNotice !== notice) {
				this.lastBudgetNotice = notice;
				this.log.warn(notice);
				process.stderr.write(`${term.yellow(`[alive] ${notice}`)}\n`);
			}
			this.writeState(true);
			await sleep(wakeAt - Date.now(), this.abortController.signal);
			return;
		}
		const notice = `hourly run limit reached (${maxWakesPerHour}/h); cooling down`;
		if (this.lastBudgetNotice !== notice) {
			this.lastBudgetNotice = notice;
			this.log.warn(notice);
			process.stderr.write(`${term.yellow(`[alive] ${notice}`)}\n`);
		}
		this.writeState(true);
		await sleep(60_000, this.abortController.signal);
	}

	private effectiveStatus(): RuntimeStatusKind {
		if (this.statusKind === "paused-budget" || this.statusKind === "stopped" || this.statusKind === "starting") {
			return this.statusKind;
		}
		return this.currentRun && !this.currentRun.idling ? "working" : "idle";
	}

	private writeState(force = false): void {
		const now = Date.now();
		if (!force && now - this.lastStateWriteAt < 5_000) return;
		this.lastStateWriteAt = now;
		const run = this.currentRun;
		const state: RuntimeStateFile = {
			pid: process.pid,
			startedAt: this.startedAt,
			lastTickAt: now,
			status: this.effectiveStatus(),
			runIndex: run?.index ?? this.runs.last()?.index ?? 0,
			runId: run?.id,
			sessionFile: this.runner?.currentSession?.sessionFile,
			model: this.sessionModel(),
			pending: this.store.pendingCount(),
			openThreads: this.threads.unsettled(this.config.config.loop.maxNudges).length,
			idling: run?.idling,
			idleSince: run?.idleStartedAt,
			sleeps: this.sleepCount,
			mode: process.env.ALIVE_DAEMON === "1" ? "background" : "foreground",
		};
		writeRuntimeState(this.config.paths.stateDir, state);
	}

	private sessionModel(): string | undefined {
		const model = this.runner?.currentSession?.model;
		return model ? `${model.provider}/${model.id}` : undefined;
	}

	status(): Record<string, unknown> {
		const usage = this.runs.usageToday();
		const lastRun = this.runs.last();
		const run = this.currentRun;
		return {
			name: this.config.config.name,
			pid: process.pid,
			status: this.effectiveStatus(),
			uptimeMs: Date.now() - this.startedAt,
			runIndex: run?.index ?? lastRun?.index ?? 0,
			currentRunId: run?.id,
			idling: run?.idling ?? false,
			idleSince: run?.idleStartedAt,
			sleeps: this.sleepCount,
			pendingEvents: this.store.pendingCount(),
			openThreads: this.threads.unsettled(this.config.config.loop.maxNudges).map((t) => t.thread),
			pendingReminders: this.reminders.list().length,
			notificationPolicy: this.policy.load(),
			costTodayUsd: Number(usage.cost.toFixed(6)),
			runsToday: usage.runs,
			tokensToday: { input: usage.input, output: usage.output },
			lastRun: lastRun ? { ...lastRun, summary: describeRunRecord(lastRun) } : undefined,
			model: this.sessionModel(),
			sessionFile: this.runner?.currentSession?.sessionFile,
			history: this.history.stats(),
			modules: this.host?.status(),
			moduleErrors: this.moduleErrors.length > 0 ? this.moduleErrors : undefined,
		};
	}

	private async deliver(message: OutgoingMessage): Promise<void> {
		await this.host.deliver(message);
	}

	private assertSingleInstance(): void {
		if (this.force) return;
		const state = readRuntimeState(this.config.paths.stateDir);
		if (!state || state.status === "stopped") return;
		if (state.pid === process.pid) return;
		if (isProcessAlive(state.pid)) {
			throw new Error(
				`another alive runtime is already running (pid ${state.pid}, started ${new Date(state.startedAt).toISOString()}). ` +
					`Use --force to start anyway (not recommended: cursor writes will race).`,
			);
		}
		this.log.warn("stale runtime state file found", { pid: state.pid, status: state.status });
	}
}
