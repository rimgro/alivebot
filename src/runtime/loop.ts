import type { AgentSession } from "@earendil-works/pi-coding-agent";
import * as fs from "node:fs";
import * as path from "node:path";
import { resolveMemoryDatabasePath, type LoadedConfig } from "../config.js";
import { detectUnitStatus, recordHeartbeat, refreshHeartbeat } from "../heartbeat.js";
import type { Logger } from "../log.js";
import { EventStore } from "../store/events.js";
import { HistoryStore } from "../store/history.js";
import { Journal } from "../store/journal.js";
import { NoteStore } from "../store/notes.js";
import { MemoryStore } from "../store/memory.js";
import { Outbox, type OutgoingMessage } from "../store/outbox.js";
import { PolicyStore } from "../store/policy.js";
import { dispatchDueReminders, ReminderStore } from "../store/reminders.js";
import { AgentRunner, describeRunRecord } from "./agent.js";
import { compactionMonitorFor } from "./compaction.js";
import {
	detectRunStall,
	readRuntimeState,
	runTurnCount,
	RunLog,
	startupResumeDecision,
	writeRuntimeState,
	type RunRecord,
	type RunStalled,
	type RuntimeStateFile,
	type RuntimeStatusKind,
} from "../store/runs.js";
import {
	INIT_FAILURE_STAY_THRESHOLD,
	INIT_FAILURE_WINDOW_MS,
	initFailureDecision,
	readInitFailures,
	resetInitFailures,
	writeInitFailures,
	type InitFailureDecision,
	type InitFailureRecord,
} from "../store/init-failures.js";
import {
	readStartLoop,
	recordProcessStart,
	START_LOOP_WINDOW_MS,
	type StartLoopStatus,
} from "../store/start-loop.js";
import { RunEventLog } from "../store/run-events.js";
import { ThreadStore } from "../store/threads.js";
import { maskSecrets } from "../secrets.js";
import { readStopIntent, staleRuntimeReason, type StopInitiator } from "./daemon.js";
import { buildAgent, readSoul } from "./session.js";
import { hasWakeWorthyPending, WakeScheduler } from "./wake.js";
import { SandboxManager } from "../sandbox/manager.js";
import { ToolAbortGate } from "./tool-abort.js";
import { WorkerManager } from "../workers/manager.js";
import { DashboardTool } from "../dashboard/tool.js";
import type { RunHandle, ToolDeps } from "./tools.js";
import { ConsoleTransport, NullTransport } from "../transports/console.js";
import { HttpTransport } from "../transports/http.js";
import { redeliverLocalAgentMessage } from "./agent-messaging.js";
import type { ChatTransport } from "../transports/types.js";
import { ModuleHost } from "../events/host.js";
import { loadModules } from "../events/loader.js";
import type { AliveModule } from "../events/api.js";
import { term } from "../term.js";
import { formatDuration, nextMidnight, sleep } from "../util.js";

export interface AliveRuntimeOptions {
	config: LoadedConfig;
	log: Logger;
	force?: boolean;
}

/**
 * Extra, optional knobs for `stop()`.
 *
 * `reason` stays free-form and backward compatible ("signal", "once",
 * "smoke", "requested"); `initiator` is who stopped the run, which is what the
 * run record needs (#168).
 */
export interface StopOptions {
	initiator?: StopInitiator;
	/** `--force`: close the run immediately instead of waiting for the drain (#181). */
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
	private memory!: MemoryStore;
	private journal!: Journal;
	private threads!: ThreadStore;
	private outbox!: Outbox;
	private policy!: PolicyStore;
	private history!: HistoryStore;
	private runs!: RunLog;
	private runEvents!: RunEventLog;
	private toolAbort!: ToolAbortGate;
	private runner!: AgentRunner;
	private sandbox?: SandboxManager;
	private workers?: WorkerManager;
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
	private wake!: WakeScheduler;
	private schedulerTimer: NodeJS.Timeout | undefined;
	private stopping = false;
	private initialized = false;
	private startedAt = Date.now();
	private lastStateWriteAt = 0;
	private lastHeartbeatAt = 0;
	private lastBudgetNotice = "";
	/** Run id whose `run_stalled` anomaly was already written (#173). */
	private stalledRunId: string | undefined;
	/** True when repeated init failures left this process alive in `status: "error"` (#178). */
	private initHalted = false;
	/** Process starts in the rolling window (#178), recorded before any risky boot step. */
	private startLoop: StartLoopStatus | undefined;
	/** Resolves the pending `run()` when `stop()` ends a halted (status=error) process. */
	private stopResolve: (() => void) | undefined;
	/** Last run record to reopen on startup (#124), consumed by `loop()`. */
	private pendingResume: RunRecord | undefined;
	/** Session file to continue across a graceful restart; set before `runner.init()`. */
	private resumeSessionFile: string | undefined;

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
		if (this.config.config.sandbox.enabled) this.sandbox = new SandboxManager(this.config, this.log);
		this.store = EventStore.open(paths.stateDir);
		this.reminders = new ReminderStore(paths.stateDir);
		this.notes = new NoteStore(paths.stateDir);
		const memoryConfig = this.config.config.memory;
		this.memory = new MemoryStore({
			enabled: memoryConfig.enabled,
			databasePath: resolveMemoryDatabasePath(this.config),
			embeddingProvider: memoryConfig.embeddingProvider,
			embeddingBaseUrl: memoryConfig.embeddingBaseUrl,
			embeddingApiKey: process.env[memoryConfig.embeddingApiKeyEnv] ?? "",
			embeddingModel: memoryConfig.embeddingModel,
			embeddingDimensions: memoryConfig.embeddingDimensions,
			revisionThreshold: memoryConfig.revisionThreshold,
			log: this.log,
		});
		await this.memory.init();
		this.journal = new Journal(paths.stateDir);
		this.threads = new ThreadStore(paths.stateDir);
		this.outbox = new Outbox(paths.stateDir);
		this.policy = new PolicyStore(paths.stateDir);
		this.history = HistoryStore.open(paths.stateDir);
		this.runs = new RunLog(paths.stateDir);
		this.runEvents = new RunEventLog(paths.stateDir);
		// One gate per runtime process, shared by every context reset. It owns the
		// single "current tool" and turns `abort-tool.json` into an AbortSignal for
		// exactly that call (#164).
		this.toolAbort = new ToolAbortGate({
			stateDir: paths.stateDir,
			log: this.log.child("tool-abort"),
			journal: this.journal,
			currentRunId: () => this.currentRun?.id,
			onStateChange: () => this.writeState(true),
		});
		// The idle-wake gate (#116): a run starts only when there is something to
		// do, so an empty idle interval costs an inbox check, not a model call.
		this.wake = new WakeScheduler({
			baseIntervalMs: this.config.config.loop.sleepAfterMs,
			pollIntervalMs: this.config.config.loop.pollIntervalMs,
			backoff: this.config.config.loop.emptyWakeBackoff,
			log: this.log.child("wake"),
			hasWork: () => this.redeliveryRange !== undefined || hasWakeWorthyPending(this.store),
			isStopped: () => this.stopping || this.abortController.signal.aborted,
		});

		this.workers = this.config.config.workers.enabled
			? new WorkerManager({
				config: this.config,
				events: this.store,
				log: this.log,
				budgetAllows: () => this.budgetAllowsRun(),
				sandbox: this.sandbox,
			})
			: undefined;

		this.toolDeps = {
			config: this.config,
			store: this.store,
			reminders: this.reminders,
			notes: this.notes,
			memory: this.memory,
			journal: this.journal,
			threads: this.threads,
			outbox: this.outbox,
			policy: this.policy,
			history: this.history,
			moduleTools: [],
			workers: this.workers,
			// Host-side: the agent may be sandboxed, but the dashboard server binds a
			// host loopback port in a detached child. Access is gated per thread inside.
			dashboard: new DashboardTool({
				rootDir: paths.rootDir,
				configPath: paths.configPath,
				stateDir: paths.stateDir,
				port: this.config.config.dashboard.port,
				allowedThreads: this.config.config.dashboard.allowedThreads,
				log: (line) => this.log.info(line),
			}),
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
			runEvents: this.runEvents,
			getRun: () => this.currentRun,
			setRun: (run) => {
				this.currentRun = run;
			},
			runtimeStatus: () => this.status(),
			isStopping: () => this.stopping,
			isBudgetExhausted: () => !this.budgetAllowsRun(),
			toolAbortGate: this.toolAbort,
		});

		const loaded = await loadModules(this.config, this.log);
		this.modules = loaded.modules;
		this.moduleErrors = loaded.errors;

		const workspacePath = (file: string) => {
			const p = this.sandbox!.path(file);
			if (!p.startsWith(`${this.sandbox!.workspaceDir}/`)) throw new Error(`Integration files must be inside ${this.sandbox!.workspaceDir}`);
			return p;
		};
		this.host = new ModuleHost({
			config: this.config,
			log: this.log,
			transports: this.buildTransports(),
			modules: this.modules,
			ingest: (event) => this.store.append(event),
			outbox: (limit) => this.outbox.list(limit),
			history: this.history,
			runtimeStatus: () => this.status(),
			currentThreads: () => this.currentRun?.currentThreads ?? [],
			workspaceFiles: this.sandbox ? {
				rootDir: this.sandbox.workspaceDir,
				readFile: (file) => this.sandbox!.exclusive(async () => (await this.sandbox!.files()).read(workspacePath(file))),
				exists: (file) => this.sandbox!.exclusive(async () => { try { await (await this.sandbox!.files()).stat(workspacePath(file)); return true; } catch { return false; } }),
				writeFile: (file, data) => this.sandbox!.exclusive(async () => {
					const p = workspacePath(file);
					await (await this.sandbox!.files()).write(p, data);
					return p;
				}),
			} : undefined,
		});
	}

	private async createSession(forceNew: boolean): Promise<AgentSession> {
		const resumeSessionFile = forceNew ? undefined : this.pendingResume ? this.resumeSessionFile : undefined;
		const built = await buildAgent({
			config: this.config,
			toolDeps: this.toolDeps,
			log: this.log.child("agent"),
			soul: readSoul(this.config.paths.soulPath),
			forceNewSession: forceNew,
			// Reopen the exact transcript of an interrupted run. `forceNew` after a
			// sleep deliberately ignores it, and a normal start keeps respecting
			// `config.session` (new vs continue).
			sessionFile: resumeSessionFile,
			sandbox: this.sandbox,
			toolAbortGate: this.toolAbort,
		});
		// A resume target that cannot be reopened is not a dead process (#173): the
		// session is already a fresh one, so close the interrupted run as aborted
		// and let the new run start from scratch instead of pretending to continue.
		if (built.resumeFailure && this.pendingResume) {
			const resume = this.pendingResume;
			this.pendingResume = undefined;
			this.resumeSessionFile = undefined;
			const reason = `resume skipped: session file could not be reopened (${built.resumeFailure})`;
			this.runs.reclassify(resume.id, "aborted", "interrupted", reason);
			this.log.warn("interrupted run closed as aborted; its session file could not be reopened", {
				runId: resume.id,
				runIndex: resume.index,
				error: built.resumeFailure,
			});
		}
		this.sandbox?.startMonitoring();
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

	/**
	 * Decide what to do with the last run at startup (#124).
	 *
	 * A recent `interrupted` run is reopened instead of waiting for the inbox;
	 * an older one — or one whose pi transcript is missing/empty/unreadable — is
	 * closed as `aborted` and the runtime starts a new session (#173).
	 */
	private resolveStartupResume(): RunRecord | undefined {
		const last = this.runs.last();
		const now = Date.now();
		const windowMs = this.config.config.loop.resumeWindowMs;
		// Prefer the file recorded on the run; fall back to the previous process
		// state for records written before `sessionFile` was persisted.
		const sessionFile = last?.sessionFile ?? this.resumeSessionFile;
		const decision = startupResumeDecision(last, now, windowMs, sessionFile, sessionFile ? sessionFileSize(sessionFile) : undefined);
		if (decision === "none" || !last) return undefined;
		const ageMs = Math.max(0, now - last.finishedAt);
		if (decision === "resume") {
			if (sessionFile) this.resumeSessionFile = sessionFile;
			this.log.info("interrupted run is resumable; reopening the same run and session", {
				runId: last.id,
				runIndex: last.index,
				ageMs,
				windowMs,
			});
			return last;
		}
		if (decision === "unusable") {
			// pi's `SessionManager.open` would silently create a fresh session at the
			// missing path while the run claims to continue. Close the run instead and
			// start clean, which is what the operator did by hand before #173.
			this.resumeSessionFile = undefined;
			const reason = `resume skipped: session file ${sessionFile ?? "(none)"} is missing, empty or unreadable`;
			this.runs.reclassify(last.id, "aborted", "interrupted", reason);
			this.log.warn("interrupted run cannot reopen its session file; closed as aborted, starting a new session", {
				runId: last.id,
				runIndex: last.index,
				ageMs,
				sessionFile: sessionFile ?? "(none)",
			});
			return undefined;
		}
		this.runs.reclassify(last.id, "aborted", "interrupted");
		this.log.warn("interrupted run is outside the resume window; closed as aborted", {
			runId: last.id,
			runIndex: last.index,
			ageMs,
			windowMs,
		});
		return undefined;
	}

	async init(): Promise<void> {
		if (this.initialized) return;
		// Checked *before* the guarded body: losing the single-instance race must
		// not rewrite runtime.json, which belongs to the process that is running.
		this.assertSingleInstance();
		try {
			await this.initRuntime();
		} catch (error) {
			// A boot that dies here used to leave a live pid with `status: "starting"`
			// and no ticks, so systemd never restarted it (#173). Make the failure
			// loud on disk and let the caller exit non-zero — unless the same boot
			// has failed `INIT_FAILURE_STAY_THRESHOLD` times in a row: then exiting
			// only feeds a restart loop (#178) and the process stays alive in
			// `status: "error"` instead.
			const decision = this.recordBootFailure(error);
			if (decision.action === "stay") {
				this.initHalted = true;
				this.log.warn("init keeps failing; staying alive in status=error instead of restarting in a loop", {
					consecutive: decision.consecutive,
					threshold: INIT_FAILURE_STAY_THRESHOLD,
					windowMs: INIT_FAILURE_WINDOW_MS,
				});
				return;
			}
			throw error;
		}
		// A working boot clears the streak, so the next unrelated failure gets its
		// two retries again.
		resetInitFailures(this.config.paths.stateDir);
	}

	/** True when repeated init failures left the process alive in `status: "error"` (#178). */
	get haltedByInitFailures(): boolean {
		return this.initHalted;
	}

	private async initRuntime(): Promise<void> {
		// Read the previous process state *before* overwriting runtime.json: it
		// names the pi transcript that an interrupted run must reopen (#124).
		const previousState = readRuntimeState(this.config.paths.stateDir);
		this.resumeSessionFile = previousState?.sessionFile;
		this.pendingResume = this.resolveStartupResume();
		this.startedAt = Date.now();
		// Claim the state file immediately: `alive status` and the daemon readiness
		// wait both key off it, and it narrows the window where a second instance
		// could pass assertSingleInstance().
		this.writeState(true);
		// Liveness signal for outside watchdogs: written once per process start, never
		// per run. A failure is logged and ignored — it must not stop the boot.
		this.writeHeartbeat();

		// Overdue reminders are ordinary due reminders: dispatch them before the
		// first run so a reminder that came due while the process was down wakes
		// the agent once on this startup. Appending first and marking fired second
		// (plus the durable `reminder:<id>` dedupe key) makes a crash in between
		// replay-safe.
		this.fireDueReminders();

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

		// Worker recovery only reads persisted records and may enqueue one notice;
		// it must never prevent the main agent from starting.
		try {
			await this.workers?.init();
		} catch (error) {
			this.log.error("worker recovery failed; workers remain unavailable", {
				error: error instanceof Error ? error.message : String(error),
			});
		}

		// Modules start first: they register outbound handlers, contribute status and
		// hand the agent their tools, and the session is built once right after.
		await this.host.init();
		this.toolDeps.moduleTools = this.host.contributedTools();
		// Queue records are written before the first send attempt, so an
		// interrupted delivery leaves a message with no success record. Retry it
		// now that modules and transports can receive again. Delivery handlers are
		// idempotent on `message.deliveryKey`, which keeps send-then-crash from
		// duplicating in the sink.
		try {
			const recovered = await this.outbox.recoverPending({
				deliver: (message) => this.deliver(message),
				log: (level, message, details) => this.log[level](message, details),
			});
			if (recovered.delivered > 0 || recovered.failed > 0 || recovered.skippedStale > 0 || recovered.skippedExhausted > 0) {
				this.log.info("outbox recovery finished", { ...recovered });
			}
		} catch (error) {
			this.log.error("outbox recovery failed", { error: error instanceof Error ? error.message : String(error) });
		}
		await this.runner.init();

		this.schedulerTimer = setInterval(() => this.schedulerTick(), this.config.config.loop.pollIntervalMs);
		this.toolAbort.startPolling();
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

	/**
	 * Persist a failed boot (#173): `runtime.json` gets `status: "error"` with the
	 * message, and one `system` inbox event explains the failure to the agent that
	 * runs after the restart. Both writes are best effort — the caller still exits
	 * non-zero, which is what makes the service manager retry.
	 */
	private recordBootFailure(error: unknown): InitFailureDecision {
		// The message lands in runtime.json and in the agent's inbox, so it is
		// masked like every other text that leaves the process.
		const message = maskSecrets(
			error instanceof Error ? error.message : String(error),
			this.config.config.secrets,
		);
		const now = Date.now();
		this.log.error("runtime failed to start", { error: message });
		const decision = this.countBootFailure(now, message);
		try {
			const previous = readRuntimeState(this.config.paths.stateDir);
			// Only inherit fields from our own state file: a stale one belongs to the
			// previous process, and its runId/sessionFile would describe someone else.
			const own = previous && previous.pid === process.pid ? previous : undefined;
			const state: RuntimeStateFile = {
				...(own ?? {}),
				pid: process.pid,
				startedAt: this.startedAt,
				lastTickAt: now,
				status: "error",
				runIndex: own?.runIndex ?? this.runs?.last()?.index ?? 0,
				pending: this.store?.pendingCount() ?? own?.pending ?? 0,
				openThreads: own?.openThreads ?? 0,
				sleeps: this.sleepCount,
				idling: false,
				idleSince: undefined,
				activeTool: undefined,
				runStalled: undefined,
				mode: process.env.ALIVE_DAEMON === "1" ? "background" : "foreground",
				error: message,
			};
			writeRuntimeState(this.config.paths.stateDir, state);
		} catch (writeError) {
			this.log.error("cannot write the failed-boot runtime state", {
				error: writeError instanceof Error ? writeError.message : String(writeError),
			});
		}
		try {
			// One event per crash-loop, not one per restart: the dedupe key keeps a
			// broken unit from flooding the inbox while it restarts every few seconds.
			this.store?.append({
				kind: "system",
				source: "runner",
				priority: "high",
				title: "runtime failed to start",
				text:
					`The alive process could not finish its startup and exited non-zero: ${message}. ` +
					`The run was not resumed. Check the profile log before assuming work was lost.`,
				dedupeKey: "runtime-init-failed",
			});
		} catch (appendError) {
			this.log.error("cannot record the failed boot in the inbox", {
				error: appendError instanceof Error ? appendError.message : String(appendError),
			});
		}
		return decision;
	}

	/**
	 * Update the consecutive-failure counter before the process decides whether to
	 * exit (#178). A previous failure older than `INIT_FAILURE_WINDOW_MS` is a new
	 * incident: the count restarts at 1, so a one-off crash after a long uptime is
	 * retried normally.
	 */
	private countBootFailure(now: number, message: string): InitFailureDecision {
		let previous: InitFailureRecord | undefined;
		try {
			previous = readInitFailures(this.config.paths.stateDir);
		} catch (readError) {
			this.log.error("cannot read the init-failure counter; treating this as the first failure", {
				error: readError instanceof Error ? readError.message : String(readError),
			});
		}
		const decision = initFailureDecision(previous, now);
		try {
			writeInitFailures(this.config.paths.stateDir, {
				consecutive: decision.consecutive,
				lastFailureAt: now,
				lastError: message,
			});
		} catch (writeError) {
			// Without the counter the next boot cannot see the streak, so it will
			// exit again: the old behaviour, never a silent endless loop.
			this.log.error("cannot persist the init-failure counter", {
				error: writeError instanceof Error ? writeError.message : String(writeError),
			});
		}
		return decision;
	}

	/** Blocking loop. Resolves when stop() is called. */
	async run(): Promise<void> {
		// Count this boot before `init()` touches the inbox, modules, sandbox or the
		// model (#178). A restart loop is then visible from outside even when a
		// later boot step never completes and the process exits.
		this.startLoop = recordProcessStart(this.config.paths.stateDir, Date.now());
		if (this.startLoop.warn) {
			this.log.warn(`restart loop: ${this.startLoop.starts} starts in 10m`, {
				starts: this.startLoop.starts,
				threshold: this.startLoop.threshold,
				windowMs: START_LOOP_WINDOW_MS,
			});
		}
		await this.init();
		if (this.initHalted) {
			// The process must stay alive (systemd would restart a non-zero exit
			// forever, #178) but does nothing: no run, no ticks, no init retries.
			await this.waitForStop();
			return;
		}
		this.loopPromise = this.loop();
		await this.loopPromise;
	}

	/**
	 * Wait for `stop()`, which is the only way out of a halted boot.
	 *
	 * A pending promise alone does not keep Node alive, so the wait holds one
	 * no-op timer: without a live handle the process would exit (code 0) and a
	 * `Restart=always` unit would start it again — exactly the loop #178 is about.
	 * The timer never touches runtime state, so there are still no ticks.
	 */
	private waitForStop(): Promise<void> {
		// `stop()` may have completed between `init()` and this wait (SIGTERM
		// during a slow boot): `stopping` is already set and `stopResolve` was
		// never registered, so without this check the process would wait forever
		// while every further signal is ignored by stop()'s early return.
		if (this.stopping) return Promise.resolve();
		return new Promise<void>((resolve) => {
			const keepAlive = setInterval(() => undefined, INIT_HALT_KEEPALIVE_MS);
			this.stopResolve = () => {
				clearInterval(keepAlive);
				resolve();
			};
		});
	}

	/**
	 * Process exactly one run: boot the agent with whatever is pending, let it
	 * work until it sleeps or stops, then return the run record. Used by
	 * `alive run --once` and the end-to-end smoke test.
	 */
	async runOnce(): Promise<RunRecord | null> {
		await this.init();
		// A halted boot has nothing to run; the caller decides what a one-shot
		// command does with `status: "error"` (it exits instead of waiting).
		if (this.initHalted) return null;
		this.fireDueReminders();
		if (this.pendingResume) {
			const resume = this.pendingResume;
			this.pendingResume = undefined;
			const record = await this.runner.execute({ resume });
			if (record) this.finishRun(record);
			return record;
		}
		const range = this.redeliveryRange;
		this.redeliveryRange = undefined;
		const record = await this.runner.execute({ redeliveryRange: range, requireEvents: true });
		if (record) this.finishRun(record);
		return record;
	}

	async stop(reason = "requested", options: StopOptions = {}): Promise<void> {
		if (this.stopping) return;
		this.stopping = true;
		// A halted boot (status=error) waits here: SIGTERM/SIGINT must still end it.
		this.stopResolve?.();
		this.stopResolve = undefined;
		// Operator tool-abort polling belongs to a live runtime; a stop/restart is
		// the separate graceful path and must not race it (#164, #181).
		this.toolAbort?.stopPolling();
		// Both `alive stop` and `alive restart` arrive as SIGTERM, so the initiator
		// comes from the explicit argument, the stop-intent marker or the SIGTERM
		// default (a service manager restart) — never from the signal alone (#168).
		// The marker is always consumed, so a stale one cannot label a later stop.
		const marker = readStopIntent(this.config.paths.stateDir);
		const initiator: StopInitiator = options.initiator ?? marker?.initiator ?? "restart";
		const force = options.force ?? marker?.force ?? false;
		this.runner?.setStopInitiator(initiator);
		this.log.info("stopping", { reason, initiator, force });
		// Wake the loop from `WakeScheduler`/backoff without touching an in-flight
		// tool. On the graceful path the session is only aborted if the drain
		// budget expires.
		this.abortController.abort();
		if (this.schedulerTimer) {
			clearInterval(this.schedulerTimer);
			this.schedulerTimer = undefined;
		}
		if (force) {
			// `--force` means "do not wait for the drain", not "skip the shutdown":
			// the run is closed through the normal settle path, keeping its
			// `stoppedBy` and a `usageUnsettled` record (#181). It must not go
			// through the operator tool-abort gate, so the agent never sees an
			// "aborted by operator" tool error.
			const aborted = await this.runner.abortNow();
			this.toolAbort?.clearActive();
			this.log.info("force shutdown closed the active run without waiting for the drain", {
				durationMs: aborted.durationMs,
				activeRun: aborted.active,
			});
		} else {
			const graceMs = this.config.config.loop.shutdownGraceMs;
			const drained = await this.runner.drain(graceMs);
			if (drained.outcome === "drained") {
				this.log.info("graceful shutdown drained the active run", { durationMs: drained.durationMs, graceMs });
			} else if (drained.outcome === "aborted") {
				this.log.warn("graceful shutdown did not finish within the budget; run aborted", {
					durationMs: drained.durationMs,
					graceMs,
				});
			}
		}
		await this.loopPromise?.catch(() => undefined);
		const session = this.runner?.currentSession;
		await this.workers?.close().catch((error) => this.log.warn("worker shutdown failed", { error: String(error) }));
		await this.host?.stop().catch(() => undefined);
		await this.memory?.close().catch(() => undefined);
		session?.dispose();
		await this.sandbox?.close().catch((error) => this.log.warn("sandbox detach failed; VM retained", { error: String(error) }));
		this.statusKind = "stopped";
		// Force already cleared the gate; this is also a no-op on the graceful
		// path, where the settled `execute` removed its own tool.
		if (force) this.toolAbort?.clearActive();
		this.writeState(true);
		this.log.info("stopped", { reason, initiator, force });
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
				// A recent interrupted run is continued before the inbox gate: the
				// agent must finish what it was doing, not start from scratch (#124).
				if (this.pendingResume) {
					const resume = this.pendingResume;
					this.pendingResume = undefined;
					const record = await this.runner.execute({ resume });
					if (record) this.finishRun(record);
					continue;
				}
				// Block until something actually needs the agent. `nextRun` never
				// calls the model: an idle interval that ends with an empty inbox is
				// an empty wake (debug log only, interval stretched by the backoff)
				// and the agent simply stays asleep. No run record and no spend.
				const trigger = await this.wake.nextRun();
				if (trigger === "stopped") break;
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
			// A one-shot operator request must be noticed within about one poll
			// interval even while the agent is blocked inside a long tool.
			this.toolAbort.check();
			this.fireDueReminders();
			this.runner.checkRunGuards();
			this.writeState();
			this.keepHeartbeatFresh();
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
			`${runTurnCount(record)} turns`,
			record.usage.cost > 0 ? `$${record.usage.cost.toFixed(4)}` : undefined,
			record.stopReason === "slept" ? "slept (context reset)" : record.stopReason,
		].filter(Boolean);
		process.stderr.write(`${term.dim(`[alive] ${parts.join(" · ")}`)}\n`);
	}

	private fireDueReminders(): void {
		dispatchDueReminders(this.reminders, this.store, Date.now(), (reminder) => {
			this.log.info("reminder fired", { id: reminder.id, dueAt: new Date(reminder.dueAt).toISOString() });
		});
	}

	// ---------------------------------------------------------------------
	// budget & state
	// ---------------------------------------------------------------------

	private budgetAllowsRun(): boolean {
		const { maxDailyCostUsd, maxWakesPerHour } = this.config.config.budget;
		if (maxDailyCostUsd > 0 && this.runs.usageToday().cost + (this.workers?.usageToday() ?? 0) >= maxDailyCostUsd) return false;
		if (maxWakesPerHour > 0 && this.runs.runsLastHour() >= maxWakesPerHour) return false;
		return true;
	}

	private async waitForBudget(): Promise<void> {
		this.statusKind = "paused-budget";
		const { maxDailyCostUsd, maxWakesPerHour } = this.config.config.budget;
		const usage = this.runs.usageToday();
		const workerCost = this.workers?.usageToday() ?? 0;
		const unknownWorkerCosts = this.workers?.unknownCostRunsToday() ?? 0;
		const totalCost = usage.cost + workerCost;
		if (maxDailyCostUsd > 0 && totalCost >= maxDailyCostUsd) {
			const wakeAt = nextMidnight(Date.now()) + 1_000;
			// Unknown worker spend cannot be added to the total without inventing a
			// price; say so instead of silently treating it as zero (#162).
			const unknownNote = unknownWorkerCosts > 0
				? `; ${unknownWorkerCosts} worker run(s) today have unknown cost and are not in this total`
				: "";
			const notice = `daily cost budget reached ($${totalCost.toFixed(4)} / $${maxDailyCostUsd.toFixed(2)}${unknownNote}); pausing until ${new Date(wakeAt).toISOString()}`;
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
		// The previous write is the last tick this process managed to emit; a gap
		// longer than `loop.runStallMs` means an open run stopped ticking (#173).
		const lastTickAt = this.lastStateWriteAt || this.startedAt;
		this.lastStateWriteAt = now;
		const run = this.currentRun;
		// A deliberate stop is not a stall: the final write must stay `stopped`.
		const stall = this.statusKind === "stopped"
			? undefined
			: detectRunStall({
					runId: run?.id,
					lastTickAt,
					now,
					thresholdMs: this.config.config.loop.runStallMs,
				});
		if (stall && run) this.recordRunStall(run, stall);
		const state: RuntimeStateFile = {
			pid: process.pid,
			startedAt: this.startedAt,
			lastTickAt: now,
			status: stall ? "stalled" : this.effectiveStatus(),
			runIndex: run?.index ?? this.runs.last()?.index ?? 0,
			runId: run?.id,
			sessionFile: this.runner?.currentSession?.sessionFile ?? this.pendingResume?.sessionFile ?? this.resumeSessionFile,
			model: this.sessionModel(),
			pending: this.store.pendingCount(),
			openThreads: this.threads.unsettled(this.config.config.loop.maxNudges).length,
			idling: run?.idling,
			idleSince: run?.idleStartedAt,
			sleeps: this.sleepCount,
			emptyWakes: this.wake?.consecutiveEmptyWakes ?? 0,
			lastCompaction: this.lastCompactionRecord(),
			contextTokens: this.currentContextTokens(),
			activeTool: this.toolAbort?.activeTool(),
			...(stall ? { runStalled: stall } : {}),
			mode: process.env.ALIVE_DAEMON === "1" ? "background" : "foreground",
		};
		writeRuntimeState(this.config.paths.stateDir, state);
	}

	/**
	 * One `run_stalled` anomaly per run (#173): the run is visible as stalled,
	 * but it is never closed here — the operator (or a restart) decides.
	 */
	private recordRunStall(run: RunHandle, stall: RunStalled): void {
		if (this.stalledRunId === run.id) return;
		this.stalledRunId = run.id;
		const now = Date.now();
		const event = {
			ts: now,
			type: "run_stalled" as const,
			agent: this.config.config.name,
			runId: run.id,
			runIndex: run.index,
			activeMs: run.activeMs,
			durationMs: Math.max(0, now - run.startedAt),
			idleMs: run.idleMs,
			turns: run.turns,
			outbound: run.outbound.length,
			events: run.events.length,
			limitMs: stall.thresholdMs,
		};
		this.runEvents?.append(event);
		this.log.warn("run_stalled", { ...event, ageMs: stall.ageMs });
	}

	private sessionModel(): string | undefined {
		const model = this.runner?.currentSession?.model;
		return model ? `${model.provider}/${model.id}` : undefined;
	}

	/** Current context (prompt) size, the same estimate the context guards use (#170). */
	private currentContextTokens(): number | undefined {
		try {
			const tokens = this.runner?.currentSession?.getSessionStats().contextUsage?.tokens;
			return typeof tokens === "number" && Number.isFinite(tokens) && tokens > 0 ? Math.round(tokens) : undefined;
		} catch {
			return undefined;
		}
	}

	/** Latest compaction outcome: live monitor first, otherwise the last run record. */
	private lastCompactionRecord() {
		return compactionMonitorFor(this.runner?.currentSession)?.record() ?? this.runs.last()?.compaction;
	}

	// ---------------------------------------------------------------------
	// heartbeat
	// ---------------------------------------------------------------------

	private writeHeartbeat(): void {
		const now = Date.now();
		const profileId = this.managedProfileId();
		const record = recordHeartbeat({
			stateDir: this.config.paths.stateDir,
			startedAt: this.startedAt,
			lastTickAt: this.lastStateWriteAt || this.startedAt,
			unitStatus: profileId ? detectUnitStatus(profileId, { now }) : undefined,
			startLoop: this.currentStartLoop(now),
			log: this.log,
		});
		if (record) this.lastHeartbeatAt = now;
	}

	/**
	 * Start counter to write into the heartbeat *now*.
	 *
	 * The value captured at boot would keep `warn: true` in `heartbeat.json`
	 * forever; an outside monitor would never see the loop end. Re-reading the
	 * small counter file on each heartbeat update makes the alert go away with
	 * the window. A zero can also mean the boot-time write failed, so while the
	 * recorded start can still be inside the window, fall back to it; after the
	 * window an empty counter is simply quiet.
	 */
	private currentStartLoop(now: number): StartLoopStatus | undefined {
		const current = readStartLoop(this.config.paths.stateDir, now);
		if (current.starts > 0) return current;
		if (this.startLoop && this.startLoop.starts > 0 && now - this.startedAt <= START_LOOP_WINDOW_MS) {
			return this.startLoop;
		}
		return current;
	}

	/** Managed profile id (directory name), or undefined for the root profile. */
	private managedProfileId(): string | undefined {
		if (!this.config.config.rootConfigPath.trim()) return undefined;
		return path.basename(this.config.paths.rootDir) || undefined;
	}

	/**
	 * The record is written once at start; afterwards it is atomically rewritten
	 * on the configured interval so `updatedAt`, `lastTickAt`, `staleSeconds` and
	 * the best-effort systemd unit state stay true (#175). The mtime still moves
	 * with each rewrite, so outside watchdogs keep reading freshness from it.
	 *
	 * The interval is never shorter than one second nor than
	 * `updates.heartbeatStaleMs / 3`, matching the old touch cadence.
	 */
	private keepHeartbeatFresh(): void {
		const intervalMs = Math.max(1_000, Math.floor(this.config.config.updates.heartbeatStaleMs / 3));
		const now = Date.now();
		if (now - this.lastHeartbeatAt < intervalMs) return;
		const profileId = this.managedProfileId();
		// Diagnostics only, cached for 30 s and bounded by a 2 s timeout inside.
		const unitStatus = profileId ? detectUnitStatus(profileId, { now }) : undefined;
		const lastTickAt = this.lastStateWriteAt || this.startedAt;
		const startLoop = this.currentStartLoop(now);
		if (refreshHeartbeat(this.config.paths.stateDir, this.log, now, { lastTickAt, unitStatus, startLoop })) {
			this.lastHeartbeatAt = now;
			return;
		}
		// The file disappeared or cannot be rewritten: write the full record.
		this.writeHeartbeat();
	}

	status(): Record<string, unknown> {
		const usage = this.runs.usageToday();
		const lastRun = this.runs.last();
		const run = this.currentRun;
		const now = Date.now();
		const stall = this.statusKind === "stopped"
			? undefined
			: detectRunStall({
					runId: run?.id,
					lastTickAt: this.lastStateWriteAt || this.startedAt,
					now,
					thresholdMs: this.config.config.loop.runStallMs,
				});
		return {
			name: this.config.config.name,
			pid: process.pid,
			status: stall ? "stalled" : this.effectiveStatus(),
			uptimeMs: now - this.startedAt,
			runIndex: run?.index ?? lastRun?.index ?? 0,
			currentRunId: run?.id,
			idling: run?.idling ?? false,
			idleSince: run?.idleStartedAt,
			sleeps: this.sleepCount,
			pendingEvents: this.store.pendingCount(),
			consecutiveEmptyWakes: this.wake?.consecutiveEmptyWakes ?? 0,
			nextWakeIntervalMs: this.wake?.intervalMs,
			openThreads: this.threads.unsettled(this.config.config.loop.maxNudges).map((t) => t.thread),
			pendingReminders: this.reminders.list().length,
			notificationPolicy: this.policy.load(),
			costTodayUsd: Number(usage.cost.toFixed(6)),
			runsToday: usage.runs,
			tokensToday: { input: usage.input, output: usage.output },
			lastRun: lastRun ? { ...lastRun, summary: describeRunRecord(lastRun) } : undefined,
			lastCompaction: this.lastCompactionRecord(),
			contextTokens: this.currentContextTokens(),
			activeTool: this.toolAbort?.activeTool(),
			runStalled: stall,
			toolLongMs: this.config.config.loop.toolLongMs,
			cacheReadPerTurn: lastRun && runTurnCount(lastRun) > 0
				? (lastRun.usage?.cacheRead ?? 0) / runTurnCount(lastRun)
				: undefined,
			model: this.sessionModel(),
			sessionFile: this.runner?.currentSession?.sessionFile ?? this.pendingResume?.sessionFile ?? this.resumeSessionFile,
			history: this.history.stats(),
			modules: this.host?.status(),
			moduleErrors: this.moduleErrors.length > 0 ? this.moduleErrors : undefined,
			workers: this.workers?.summary(),
			runAnomalies: this.runEvents.list(10),
			workerCostTodayUsd: this.workers ? Number(this.workers.usageToday().toFixed(6)) : undefined,
			workerUnknownCostRunsToday: this.workers?.unknownCostRunsToday(),
		};
	}

	private async deliver(message: OutgoingMessage): Promise<void> {
		// Local agent-to-agent messages are not chat-module traffic: replaying one
		// through the transport taps would mark it delivered without ever reaching
		// the recipient's durable inbox. Both the inbox append (dedupe key) and the
		// history append (record id) are idempotent, so recovery is safe.
		if (message.recipientAgentId) {
			redeliverLocalAgentMessage(this.config, message, this.log);
			return;
		}
		// A local thread must never fall through to chat transports: the console or
		// NullTransport would report success while no agent inbox received the
		// event. A queued local record without its recipient is a bug, not chat.
		if (message.thread.startsWith("local:")) {
			throw new Error(`queued local message ${message.id} has no recipientAgentId; refusing to send it through chat transports`);
		}
		await this.host.deliver(message);
	}

	private assertSingleInstance(): void {
		// Two owners could race stopped-volume writes against boot/probes. Force
		// cannot bypass single-instance safety for an isolated profile.
		if (this.force && !this.config.config.sandbox.enabled) return;
		const state = readRuntimeState(this.config.paths.stateDir);
		if (!state || state.status === "stopped") return;
		if (state.pid === process.pid) return;
		// Identity, not mere liveness: after a VM crash the recorded pid can belong
		// to an unrelated (even another user's) process, and `kill(pid, 0)` then
		// says "alive" forever — the boot refuses to start and systemd gives up
		// after StartLimitBurst (#207).
		const reason = staleRuntimeReason(state.pid, this.config.paths.configPath);
		if (reason === undefined) {
			throw new Error(
				`another alive runtime is already running (pid ${state.pid}, started ${new Date(state.startedAt).toISOString()}). ` +
					(this.config.config.sandbox.enabled
						? `Stop the old runtime first; --force cannot create concurrent owners of an isolated workspace.`
						: `Use --force to start anyway (not recommended: cursor writes will race).`),
			);
		}
		// Say *why* the state file is ignored: a silent recovery looks like a
		// second instance to whoever reads the log after a crash.
		this.log.warn("stale runtime state file found", { pid: state.pid, status: state.status, reason });
	}
}

/** How often the halted (status=error) process proves it is still alive: once an hour. */
const INIT_HALT_KEEPALIVE_MS = 60 * 60_000;

/**
 * Size of a resume target in bytes, or `undefined` when it cannot be read
 * (#173). A missing, unreadable, non-file or empty transcript is unusable:
 * `SessionManager.open` would either throw or silently create a brand-new
 * session at that path while the run claims to continue.
 */
function sessionFileSize(file: string): number | undefined {
	try {
		fs.accessSync(file, fs.constants.R_OK);
		const stat = fs.statSync(file);
		return stat.isFile() ? stat.size : undefined;
	} catch {
		return undefined;
	}
}
