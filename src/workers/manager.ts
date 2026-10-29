import type { EventStore } from "../store/events.js";
import type { LoadedConfig } from "../config.js";
import type { Logger } from "../log.js";
import { localDay, newId, oneLine, truncate } from "../util.js";
import {
	selectWorkerModel,
	validateGitRef,
	validateWorkerBranch,
	workerPermission,
	type WorkerPermissions,
	type WorkersConfig,
	WORKER_TOOL_NAMES,
} from "./config.js";
import {
	createPiWorkerSessionFactory,
	type WorkerSession,
	type WorkerSessionBuildInput,
	type WorkerSessionFactory,
} from "./session.js";
import {
	attachWorktree,
	baseBranchName,
	branchExists,
	commitAll,
	createPullRequest,
	createPullRequestWorktree,
	createWorktree,
	gitDiff,
	gitState,
	isGitRepository,
	pushBranch,
	removeWorktree,
	repositoryHead,
	runGit,
} from "./worktree.js";
import { isTransientProviderError, providerRetryDelayMs } from "./retry.js";
import { createWorkerEnvironment, type WorkerEnvironment } from "./environment.js";
import {
	validateWorkerId,
	workerLabel,
	type WorkerAbortReason,
	type WorkerIsolation,
	type WorkerRecord,
	type WorkerStatus,
	WorkerStore,
	worktreesRoot,
} from "./store.js";
import type { SandboxManager } from "../sandbox/manager.js";

export interface WorkerManagerOptions {
	config: LoadedConfig;
	events: EventStore;
	log: Logger;
	/** Test seam; production uses real pi sessions. */
	sessionFactory?: WorkerSessionFactory;
	/** Global budget gate supplied by the runtime. */
	budgetAllows?: () => boolean;
	/** Runtime-scoped sandbox; required when the profile is sandboxed. */
	sandbox?: SandboxManager;
}

interface WorkerHandle {
	record: WorkerRecord;
	session?: WorkerSession;
	runPromise?: Promise<void>;
	abortReason?: WorkerAbortReason;
	waiters: Set<() => void>;
	activity?: string;
	/** Last assistant turn that ended with stopReason "error" or "aborted" in this run. */
	sessionError?: string;
	/** Tool executions started during the current run. */
	toolCalls: number;
	/** Resolves an in-flight provider-retry backoff (stop, shutdown, run limits). */
	wakeRetryDelay?: () => void;
	/** Timers bounding the current run; absent when no run is active. */
	runTimers?: RunTimers;
}

/**
 * One run is bounded by two independent timers: an inactivity timer that is
 * reset by every session event, and an absolute wall-clock ceiling.
 */
interface RunTimers {
	idle?: NodeJS.Timeout;
	ceiling?: NodeJS.Timeout;
	lastActivityAt: number;
}

export interface StartWorkerOptions {
	task: string;
	model?: string;
	isolation?: WorkerIsolation;
	branch?: string;
	baseRef?: string;
	pullRequest?: number;
	name?: string;
	tools?: string[];
	notify?: boolean;
	wait?: boolean;
	waitTimeoutMs?: number;
}

export interface SendWorkerOptions {
	wait?: boolean;
	waitTimeoutMs?: number;
	notify?: boolean;
}

export interface WorkerStatusView {
	record: WorkerRecord;
	activity?: string;
	git?: Awaited<ReturnType<typeof gitState>>;
}

const MAX_TASK_CHARS = 100_000;
const MAX_PROMPT_CHARS = 100_000;
const MAX_RESULT_CHARS = 20_000;
const MAX_ERROR_CHARS = 4_000;
const MAX_WAIT_MS = 10 * 60_000;
const EMPTY_RUN_ERROR = "worker produced no output: the model returned no text, no tool calls and no new tokens";

export class WorkerManager {
	private readonly config: LoadedConfig;
	private readonly cfg: WorkersConfig;
	private readonly events: EventStore;
	private readonly log: Logger;
	private readonly store: WorkerStore;
	private readonly sessionFactory: WorkerSessionFactory;
	private readonly budgetAllows?: () => boolean;
	private readonly environment: WorkerEnvironment;
	private readonly sandboxed: boolean;
	private readonly handles = new Map<string, WorkerHandle>();
	private closing = false;

	constructor(options: WorkerManagerOptions) {
		this.config = options.config;
		this.cfg = options.config.config.workers;
		this.events = options.events;
		this.log = options.log.child("workers");
		this.store = new WorkerStore(options.config.paths);
		this.environment = createWorkerEnvironment(options.config, options.sandbox);
		this.sandboxed = this.environment.kind === "sandbox";
		this.sessionFactory = options.sessionFactory ?? createPiWorkerSessionFactory({
			agentDir: options.config.config.piAgentDir,
			config: options.config,
			sandbox: options.sandbox,
		});
		this.budgetAllows = options.budgetAllows;
	}

	get enabled(): boolean {
		return this.cfg.enabled;
	}

	/**
	 * Mark records that were running in a previous process as interrupted.
	 * Worker sessions are in-process, so after a restart the transcript can be
	 * resumed by `send`, but the previous run itself is gone.
	 */
	async init(): Promise<void> {
		if (!this.cfg.enabled) return;
		const stale = this.store.list().filter((record) => record.status === "running" || record.status === "starting");
		for (const record of stale) {
			record.status = "interrupted";
			record.lastError = "the alive process stopped while this worker was running; send a follow-up to resume the saved session";
			record.lastRunFinishedAt = Date.now();
			record.updatedAt = Date.now();
			this.store.save(record);
		}
		if (stale.length > 0) {
			this.events.append({
				kind: "worker",
				source: "workers",
				priority: "high",
				title: `${stale.length} worker${stale.length === 1 ? "" : "s"} interrupted by a restart`,
				text:
					`These workers were running when the previous alive process stopped: ${stale.map((record) => record.id).join(", ")}.\n` +
					`Their sessions are persisted. Inspect with worker({action:"status",...}); resume with worker({action:"send",...}); ` +
					`or remove them with worker({action:"remove",...}).`,
				payload: { workerIds: stale.map((record) => record.id) },
			});
		}
	}

	async close(): Promise<void> {
		this.closing = true;
		const active = [...this.handles.values()].filter((handle) => handle.record.status === "running" || handle.record.status === "starting");
		await Promise.all(active.map(async (handle) => {
			handle.abortReason = "shutdown";
			this.wakeRetryDelay(handle);
			try {
				await handle.session?.abort();
			} catch {
				// The session may already be settling.
			}
			await waitForSettle(handle.runPromise, 10_000);
			if (handle.record.status === "running" || handle.record.status === "starting") {
				handle.record.status = "interrupted";
				handle.record.lastError = "the alive process stopped while this worker was running";
				handle.record.lastRunFinishedAt = Date.now();
				handle.record.updatedAt = Date.now();
				this.store.save(handle.record);
				this.notifyWaiters(handle);
			}
		}));
		for (const handle of this.handles.values()) {
			handle.session?.dispose();
			handle.session = undefined;
		}
		this.handles.clear();
	}

	list(options: { includeFinished?: boolean; limit?: number } = {}): WorkerRecord[] {
		this.requirePermission("inspect");
		const records = this.store.list();
		const filtered = options.includeFinished === false
			? records.filter((record) => record.status === "starting" || record.status === "running" || record.status === "idle")
			: records;
		const limit = Math.max(1, Math.min(options.limit ?? 30, 200));
		return filtered.slice(0, limit).map((record) => this.snapshot(record));
	}

	/** Compact worker overview for the awake prompt; no permission gate. */
	overview(limit = 6): WorkerRecord[] {
		const cutoff = Date.now() - 24 * 60 * 60_000;
		return this.store.list()
			.filter((record) => record.status === "starting" || record.status === "running" || (
				record.status !== "stopped" && record.updatedAt >= cutoff
			))
			.slice(0, Math.max(1, limit))
			.map((record) => this.snapshot(record));
	}

	/** Cost recorded by worker runs finished today (survives worker removal). */
	usageToday(now = Date.now()): number {
		const day = localDay(now);
		const cutoff = now - 30 * 24 * 60 * 60_000;
		return this.store.usageHistory(cutoff)
			.filter((entry) => localDay(entry.ts) === day)
			.reduce((total, entry) => total + entry.cost, 0);
	}

	summary(): Record<string, unknown> {
		const records = this.store.list();
		const active = records.filter((record) => record.status === "running" || record.status === "starting");
		return {
			enabled: this.cfg.enabled,
			models: this.cfg.models,
			defaultModel: this.cfg.defaultModel || undefined,
			active: active.map((record) => ({ id: record.id, model: record.model, isolation: record.isolation })),
			activeCount: active.length,
			maxConcurrent: this.cfg.maxConcurrent,
			costTodayUsd: Number(this.usageToday().toFixed(6)),
		};
	}

	async start(options: StartWorkerOptions): Promise<WorkerRecord> {
		this.requirePermission("spawn");
		if (options.wait) this.requirePermission("inspect");
		this.assertBudget();
		const task = options.task.trim();
		if (!task) throw new Error("worker start requires a non-empty task");
		if (task.length > MAX_TASK_CHARS) throw new Error(`worker task exceeds ${MAX_TASK_CHARS} characters`);
		if (options.pullRequest !== undefined && (!Number.isSafeInteger(options.pullRequest) || options.pullRequest < 1)) {
			throw new Error("pull request number must be a positive integer");
		}
		const model = selectWorkerModel(this.cfg, options.model);
		const tools = this.validateTools(options.tools);
		const isolation: WorkerIsolation = options.pullRequest !== undefined ? "worktree" : options.isolation ?? "worktree";
		if (isolation === "worktree") this.requirePermission("worktree");
		if (isolation === "shared" && (options.branch !== undefined || options.baseRef !== undefined)) {
			throw new Error("branch and baseRef require worktree isolation");
		}
		if (options.pullRequest !== undefined && options.isolation === "shared") {
			throw new Error("pull request checkout requires worktree isolation");
		}
		if (options.pullRequest !== undefined && options.baseRef !== undefined) {
			throw new Error("base_ref cannot be combined with pull request checkout");
		}
		const active = this.countActive();
		if (active >= this.cfg.maxConcurrent) {
			throw new Error(`worker concurrency limit reached (${active}/${this.cfg.maxConcurrent}); wait for a worker to finish or stop one`);
		}
		const repositoryPath = this.environment.resolve(this.cfg.repository || ".");
		if (!(await this.environment.exists(repositoryPath))) throw new Error(`workers.repository does not exist: ${repositoryPath}`);
		if (isolation === "worktree" && !(await isGitRepository(this.environment, repositoryPath))) {
			throw new Error(`workers.repository is not a git repository: ${repositoryPath}; use isolation:"shared" or configure a repository`);
		}
		const id = newId("wrk");
		const branch = options.pullRequest !== undefined
			? validateWorkerBranch(options.branch?.trim() || `alive/pr-${options.pullRequest}-${id.slice(-8)}`)
			: isolation === "worktree"
				? validateWorkerBranch(options.branch?.trim() || `alive/${id}`)
				: undefined;
		const baseRef = options.pullRequest !== undefined
			? undefined
			: validateGitRef(options.baseRef ?? this.cfg.baseRef) || undefined;
		const createdAt = Date.now();
		const workspacePath = isolation === "worktree"
			? this.environment.join(this.worktreeRoot(), id)
			: repositoryPath;
		const record: WorkerRecord = {
			version: 1,
			id,
			name: options.name?.trim() ? truncate(options.name.trim(), 120) : undefined,
			createdAt,
			updatedAt: createdAt,
			status: "starting",
			task,
			model,
			tools,
			sandboxed: this.sandboxed,
			isolation,
			repositoryPath,
			workspacePath,
			branch,
			baseRef,
			pullRequest: options.pullRequest,
			runs: 0,
			notifyOnFinish: options.notify ?? this.cfg.notifyOnFinish,
		};
		this.store.save(record);
		const handle: WorkerHandle = { record, waiters: new Set(), toolCalls: 0 };
		this.handles.set(id, handle);
		this.log.info("worker starting", { id, model, isolation, branch, pullRequest: options.pullRequest });
		handle.runPromise = this.launch(handle, this.initialPrompt(task))
			.catch((error) => this.log.error("worker launch crashed", {
				id,
				error: error instanceof Error ? error.message : String(error),
			}))
			.finally(() => {
				handle.runPromise = undefined;
			});
		if (options.wait) return this.wait(id, options.waitTimeoutMs);
		return this.snapshot(record);
	}

	async send(id: string, prompt: string, options: SendWorkerOptions = {}): Promise<WorkerRecord> {
		this.requirePermission("send");
		if (options.wait) this.requirePermission("inspect");
		this.assertBudget();
		const text = prompt.trim();
		if (!text) throw new Error("worker send requires a non-empty prompt");
		if (text.length > MAX_PROMPT_CHARS) throw new Error(`worker prompt exceeds ${MAX_PROMPT_CHARS} characters`);
		const handle = this.handleFor(id);
		const record = handle.record;
		this.assertRecordEnvironment(record);
		if (record.status === "starting" || record.status === "running") {
			throw new Error(`worker ${record.id} is running; wait for it to finish or stop it before sending another instruction`);
		}
		// Re-check the operator allowlists: revoking a model or a tool must also
		// stop follow-up runs, not only new workers.
		selectWorkerModel(this.cfg, record.model);
		if (record.tools.some((tool) => !this.cfg.tools.includes(tool))) {
			throw new Error(`worker ${record.id} uses tools that are no longer in workers.tools; remove it and start a new worker`);
		}
		const active = this.countActive();
		if (active >= this.cfg.maxConcurrent) {
			throw new Error(`worker concurrency limit reached (${active}/${this.cfg.maxConcurrent}); wait for a worker to finish or stop one`);
		}
		if (options.notify !== undefined) record.notifyOnFinish = options.notify;
		handle.activity = undefined;
		record.status = "starting";
		record.updatedAt = Date.now();
		this.store.save(record);
		this.log.info("worker follow-up", { id: record.id, chars: text.length });
		handle.runPromise = this.launch(handle, this.followUpPrompt(text))
			.catch((error) => this.log.error("worker follow-up crashed", {
				id: record.id,
				error: error instanceof Error ? error.message : String(error),
			}))
			.finally(() => {
				handle.runPromise = undefined;
			});
		if (options.wait) return this.wait(id, options.waitTimeoutMs);
		return this.snapshot(record);
	}

	async wait(id: string, timeoutMs?: number): Promise<WorkerRecord> {
		this.requirePermission("inspect");
		const handle = this.handles.get(validateWorkerId(id));
		if (!handle || !handle.runPromise) return this.snapshot(this.requireRecord(id));
		if (handle.record.status !== "starting" && handle.record.status !== "running") {
			return this.snapshot(this.requireRecord(id));
		}
		const waitMs = Math.max(1_000, Math.min(timeoutMs ?? 120_000, MAX_WAIT_MS));
		await new Promise<void>((resolve) => {
			let timer: NodeJS.Timeout | undefined;
			const done = () => {
				if (timer) clearTimeout(timer);
				handle.waiters.delete(done);
				resolve();
			};
			timer = setTimeout(done, waitMs);
			handle.waiters.add(done);
		});
		return this.snapshot(this.requireRecord(id));
	}

	async status(id: string): Promise<WorkerStatusView> {
		this.requirePermission("inspect");
		const handle = this.handles.get(validateWorkerId(id));
		const record = this.requireRecord(id);
		this.assertRecordEnvironment(record);
		const view: WorkerStatusView = { record: this.snapshot(record), activity: handle?.activity };
		if (await this.environment.exists(record.workspacePath)) {
			view.git = await gitState(this.environment, record.workspacePath).catch(() => undefined);
		}
		return view;
	}

	async diff(id: string, full: boolean): Promise<string> {
		this.requirePermission("inspect");
		const record = this.requireRecord(id);
		this.assertRecordEnvironment(record);
		if (!(await this.environment.exists(record.workspacePath))) throw new Error(`worker workspace no longer exists: ${record.workspacePath}`);
		if (!(await isGitRepository(this.environment, record.workspacePath))) {
			throw new Error(`worker workspace is not a git repository: ${record.workspacePath}`);
		}
		const diff = await gitDiff(this.environment, record.workspacePath, { baseCommit: record.baseCommit, full });
		const status = diff.state.changed.length > 0 ? diff.state.changed.join("\n") : "(clean working tree)";
		const header = [
			`Worker ${record.id} diff (base ${record.baseCommit ?? "HEAD"})`,
			record.isolation === "shared" ? "NOTE: shared workspace; the diff may include other work in this repository." : undefined,
			`Status:\n${status}`,
			`Stat:\n${diff.stat || "(no tracked changes)"}`,
		].filter(Boolean);
		if (full && diff.patch !== undefined) {
			header.push(`Patch:\n${truncate(diff.patch || "(empty patch)", 60_000)}`);
		}
		return header.join("\n\n");
	}

	async stop(id: string): Promise<WorkerRecord> {
		this.requirePermission("stop");
		const handle = this.handleFor(id);
		const record = handle.record;
		if (record.status === "running" || record.status === "starting") {
			handle.abortReason = "stop";
			this.wakeRetryDelay(handle);
			try {
				await handle.session?.abort();
			} catch {
				// Settling anyway.
			}
			await handle.runPromise?.catch(() => undefined);
			return this.snapshot(this.requireRecord(id));
		}
		record.status = "stopped";
		record.updatedAt = Date.now();
		record.lastRunFinishedAt = record.lastRunFinishedAt ?? record.updatedAt;
		this.store.save(record);
		this.disposeSession(handle);
		this.log.info("worker stopped", { id: record.id });
		return this.snapshot(record);
	}

	async remove(id: string, options: { force?: boolean } = {}): Promise<void> {
		this.requirePermission("stop");
		const handle = this.handles.get(validateWorkerId(id));
		const record = this.requireRecord(id);
		this.assertRecordEnvironment(record);
		if (record.status === "running" || record.status === "starting") {
			throw new Error(`worker ${record.id} is still running; stop it before removing it`);
		}
		if (handle) this.disposeSession(handle);
		if (record.isolation === "worktree" && await this.environment.exists(record.workspacePath)) {
			await removeWorktree(this.environment, record.repositoryPath, record.workspacePath, { force: options.force });
		}
		this.store.remove(record.id);
		this.handles.delete(record.id);
		this.log.info("worker removed", { id: record.id, worktreeRemoved: record.isolation === "worktree" });
	}

	async createPullRequest(
		id: string,
		options: { title: string; body?: string; baseBranch?: string; draft?: boolean; commitMessage?: string } = { title: "" },
	): Promise<{ url: string; branch: string }> {
		this.requirePermission("pullRequest");
		const record = this.handleFor(id).record;
		this.assertRecordEnvironment(record);
		if (record.isolation !== "worktree") throw new Error("pull requests require worktree isolation");
		if (!record.branch) throw new Error("worker has no branch");
		if (record.status === "running" || record.status === "starting") {
			throw new Error(`worker ${record.id} is still running; wait for it to finish before publishing`);
		}
		if (!(await this.environment.exists(record.workspacePath))) throw new Error(`worker workspace no longer exists: ${record.workspacePath}`);
		if (!options.title.trim()) throw new Error("pull request title is required");
		if (options.commitMessage?.trim()) {
			const before = await gitState(this.environment, record.workspacePath);
			if (!before.clean) await commitAll(this.environment, record.workspacePath, options.commitMessage);
		}
		const state = await gitState(this.environment, record.workspacePath);
		if (!state.clean) {
			throw new Error(
				`worker workspace has uncommitted changes (${state.changed.length} path(s)); ask the worker to commit them or pass commit_message`,
			);
		}
		const { stdout: aheadRaw } = await runGit(this.environment, record.workspacePath, ["rev-list", "--count", `${record.baseCommit ?? "HEAD"}..HEAD`]);
		const ahead = Number.parseInt(aheadRaw.trim(), 10);
		if (!Number.isFinite(ahead) || ahead < 1) throw new Error("worker branch has no commits ahead of its base commit");
		await pushBranch(this.environment, record.workspacePath, this.cfg.remote, record.branch);
		const baseBranch = validateGitRef(options.baseBranch ?? "") || baseBranchName(this.cfg.baseRef);
		const result = await createPullRequest(this.environment, record.workspacePath, {
			title: options.title,
			body: options.body,
			baseBranch,
			draft: options.draft,
			branch: record.branch,
		});
		this.log.info("worker pull request created", { id: record.id, url: result.url, branch: result.branch });
		record.pullRequestUrl = result.url;
		record.updatedAt = Date.now();
		this.store.save(record);
		return { url: result.url, branch: result.branch };
	}

	// ---------------------------------------------------------------------
	// internal
	// ---------------------------------------------------------------------

	private async launch(handle: WorkerHandle, prompt: string): Promise<void> {
		handle.record.abortReason = undefined;
		try {
			await this.prepare(handle);
			if (handle.abortReason) {
				this.finishWithoutRun(handle);
				return;
			}
			await this.execute(handle, prompt);
		} catch (error) {
			this.fail(handle, error instanceof Error ? error.message : String(error));
		}
	}

	private async prepare(handle: WorkerHandle): Promise<void> {
		if (this.closing) throw new Error("worker manager is shutting down");
		const record = handle.record;
		this.assertRecordEnvironment(record);
		if (record.isolation === "worktree" && !(await this.environment.exists(record.workspacePath))) {
			const branch = record.branch ?? (record.pullRequest !== undefined
				? `alive/pr-${record.pullRequest}-${record.id.slice(-8)}`
				: `alive/${record.id}`);
			if (await branchExists(this.environment, record.repositoryPath, branch)) {
				// A previous worktree was removed manually; keep the branch's work.
				await attachWorktree(this.environment, record.repositoryPath, record.workspacePath, branch);
			} else if (record.pullRequest !== undefined) {
				await createPullRequestWorktree(this.environment, {
					repositoryPath: record.repositoryPath,
					worktreePath: record.workspacePath,
					branch,
					number: record.pullRequest,
					remote: this.cfg.remote,
				});
			} else {
				await createWorktree(this.environment, {
					repositoryPath: record.repositoryPath,
					worktreePath: record.workspacePath,
					branch,
					baseRef: record.baseRef,
				});
			}
		}
		record.baseCommit = record.baseCommit ?? await repositoryHead(this.environment, record.workspacePath);
		record.updatedAt = Date.now();
		this.store.save(record);
		if (this.closing) throw new Error("worker manager is shutting down");
		if (!handle.session) {
			handle.session = await this.buildSession(record);
		}
	}

	private async buildSession(record: WorkerRecord): Promise<WorkerSession> {
		const input: WorkerSessionBuildInput = {
			id: record.id,
			name: record.name,
			sandboxed: record.sandboxed === true,
			hostCwd: record.sandboxed ? this.config.paths.workspaceDir : record.workspacePath,
			workspacePath: record.workspacePath,
			repositoryPath: record.repositoryPath,
			modelSpec: record.model,
			tools: record.tools,
			isolation: record.isolation,
			branch: record.branch,
			baseRef: record.baseRef,
			pullRequest: record.pullRequest,
			sessionDir: this.store.sessionDir(record.id),
			sessionFile: record.sessionFile,
		};
		const session = await this.sessionFactory(input);
		record.sessionFile = session.sessionFile;
		record.updatedAt = Date.now();
		this.store.save(record);
		this.log.info("worker session created", {
			id: record.id,
			model: record.model,
			sandboxed: record.sandboxed === true,
			isolation: record.isolation,
		});
		session.subscribe((event) => {
			const handle = this.handles.get(record.id);
			if (!handle) return;
			// Every event the manager already reacts to is an activity signal: it
			// resets the run's inactivity timer.
			if (
				event.type === "turn_start" ||
				event.type === "tool_execution_start" ||
				event.type === "turn_end" ||
				event.type === "agent_end"
			) {
				this.touchRunActivity(handle);
			}
			if (event.type === "tool_execution_start" && typeof event.toolName === "string") {
				handle.activity = `tool: ${event.toolName}`;
				handle.toolCalls += 1;
			} else if (event.type === "turn_start") {
				handle.activity = "thinking";
			} else if (event.type === "turn_end" || event.type === "agent_end") {
				this.captureSessionError(handle, event);
			}
		});
		return session;
	}

	/**
	 * A provider failure does not throw out of `prompt()`; it ends the turn as an
	 * assistant message with stopReason "error". Keep that reason so an empty run
	 * is reported as failed instead of silently succeeding.
	 */
	private captureSessionError(handle: WorkerHandle, event: { type: string; [key: string]: unknown }): void {
		const messages: unknown[] = [];
		if (Array.isArray(event.messages)) messages.push(...event.messages);
		if (event.message !== undefined) messages.push(event.message);
		for (const message of messages) {
			if (!message || typeof message !== "object") continue;
			const candidate = message as { role?: unknown; stopReason?: unknown; errorMessage?: unknown };
			if (candidate.role !== "assistant") continue;
			if (candidate.stopReason !== "error" && candidate.stopReason !== "aborted") continue;
			const detail =
				typeof candidate.errorMessage === "string" && candidate.errorMessage.trim().length > 0
					? candidate.errorMessage.trim()
					: `assistant turn stopped with reason "${String(candidate.stopReason)}"`;
			handle.sessionError = detail;
		}
	}

	private async execute(handle: WorkerHandle, prompt: string): Promise<void> {
		const record = handle.record;
		const session = handle.session;
		if (!session) {
			this.fail(handle, "worker session was not created");
			return;
		}
		record.status = "running";
		record.runs += 1;
		record.attempts = 0;
		record.lastRunStartedAt = Date.now();
		record.lastRunFinishedAt = undefined;
		record.lastResult = undefined;
		record.lastError = undefined;
		record.updatedAt = record.lastRunStartedAt;
		this.store.save(record);
		const startedAt = record.lastRunStartedAt;
		handle.sessionError = undefined;
		handle.toolCalls = 0;
		const tokensBefore = this.tokenTotal(session);
		const textBefore = session.getLastAssistantText()?.trim();
		const previousAbortReason = handle.abortReason;
		handle.abortReason = undefined;
		record.abortReason = undefined;
		this.startRunTimers(handle);

		let status: WorkerStatus = "idle";
		let error: string | undefined;
		let attempt = 0;
		try {
			// One user-visible run may spend several prompts on transient provider
			// failures. Every attempt is counted, but `runs` counts the run once.
			// Defensive: a config object built without validation must not loop.
			const retries = Number.isInteger(this.cfg.providerRetries) && this.cfg.providerRetries > 0 ? this.cfg.providerRetries : 0;
			const maxAttempts = 1 + retries;
			for (;;) {
				attempt += 1;
				record.attempts = attempt;
				handle.sessionError = undefined;
				const outcome = await this.attemptPrompt(handle, prompt, { tokensBefore, textBefore, previousAbortReason });
				status = outcome.status;
				error = outcome.error;
				if (!outcome.retryable || attempt >= maxAttempts) break;
				// A retry delay is still activity: do not let the inactivity timer
				// mistake a scheduled backoff for a stuck provider.
				this.touchRunActivity(handle);
				const delayMs = providerRetryDelayMs(this.cfg.providerRetryDelayMs, attempt);
				this.log.warn("worker provider failure; retrying the prompt", {
					id: record.id,
					attempt,
					maxAttempts,
					delayMs,
					error: oneLine(error ?? "", 200),
				});
				await this.waitRetryDelay(handle, delayMs);
				// A stopped or shutting-down run never retries, and neither does one
				// whose run limits fired while it was backing off.
				if (this.closing || handle.abortReason) {
					const aborted = this.abortOutcome(handle, previousAbortReason);
					if (aborted) {
						status = aborted.status;
						error = aborted.error;
					}
					break;
				}
			}
			// Only a genuine provider failure gets the retry summary; a run killed by
			// a limit or a command keeps the message of that abort.
			if (status === "failed" && attempt > 1 && this.abortOutcome(handle, previousAbortReason) === undefined) {
				error = `${error ?? "worker run failed"} (gave up after ${attempt} attempts)`;
			}
		} finally {
			this.clearRunTimers(handle);
			try {
				const stats = session.getSessionStats();
				if (stats.tokens) {
					record.tokens = {
						input: stats.tokens.input ?? 0,
						output: stats.tokens.output ?? 0,
						total: stats.tokens.total ?? 0,
					};
				}
				if (typeof stats.cost === "number") {
					const previous = record.costUsd ?? 0;
					record.lastRunCostUsd = Math.max(0, stats.cost - previous);
					record.costUsd = stats.cost;
				}
			} catch {
				// Statistics are best-effort.
			}
			const result = status === "idle" ? session.getLastAssistantText() : undefined;
			record.status = status;
			record.lastResult = result ? truncate(result.trim(), MAX_RESULT_CHARS) : undefined;
			record.lastError = error ? truncate(error, MAX_ERROR_CHARS) : undefined;
			record.lastRunFinishedAt = Date.now();
			record.updatedAt = record.lastRunFinishedAt;
			record.abortReason = handle.abortReason ?? previousAbortReason;
			handle.abortReason = undefined;
			handle.activity = undefined;
			if (status !== "idle") this.disposeSession(handle);
			this.store.save(record);
			if ((record.lastRunCostUsd ?? 0) > 0 || (record.tokens?.total ?? 0) > 0) {
				this.store.appendUsage({
					ts: record.lastRunFinishedAt,
					cost: record.lastRunCostUsd ?? 0,
					input: record.tokens?.input ?? 0,
					output: record.tokens?.output ?? 0,
				});
			}
			this.log.info("worker run finished", {
				id: record.id,
				status,
				attempts: record.attempts,
				durationMs: record.lastRunFinishedAt - startedAt,
				error,
			});
			if (status !== "stopped") void this.notifyCompletion(record, record.lastRunFinishedAt - startedAt);
			this.notifyWaiters(handle);
		}
	}

	/**
	 * One prompt inside a run: send the prompt, then classify how it ended.
	 *
	 * `retryable` is only true for a transient provider failure that left no side
	 * effects behind: at least one tool execution means a retry could duplicate
	 * work, and new tokens mean the provider already did (and billed) something.
	 */
	private async attemptPrompt(
		handle: WorkerHandle,
		prompt: string,
		context: { tokensBefore: number; textBefore?: string; previousAbortReason?: WorkerAbortReason },
	): Promise<{ status: WorkerStatus; error?: string; retryable: boolean }> {
		const session = handle.session;
		if (!session) return { status: "failed", error: "worker session was not created", retryable: false };
		const { tokensBefore, textBefore, previousAbortReason } = context;
		let status: WorkerStatus;
		let error: string | undefined;
		try {
			await session.prompt(prompt, { expandPromptTemplates: false, source: "extension" });
			const aborted = this.abortOutcome(handle, previousAbortReason);
			if (aborted) {
				status = aborted.status;
				error = aborted.error;
			} else if (handle.sessionError) {
				status = "failed";
				error = handle.sessionError;
			} else if (!this.runProducedOutput(handle, session, tokensBefore, textBefore)) {
				status = "failed";
				error = EMPTY_RUN_ERROR;
			} else {
				status = "idle";
			}
		} catch (caught) {
			const aborted = this.abortOutcome(handle, previousAbortReason);
			if (aborted) {
				status = aborted.status;
				error = aborted.error;
			} else {
				status = "failed";
				error = errorDetail(caught);
			}
		}
		const retryable =
			status === "failed" &&
			this.abortOutcome(handle, previousAbortReason) === undefined &&
			handle.toolCalls === 0 &&
			this.tokenTotal(session) <= tokensBefore &&
			isTransientProviderError(error);
		return { status, error, retryable };
	}

	/** Sleep between provider attempts; `stop`/`close` and the run limits resolve it early. */
	private waitRetryDelay(handle: WorkerHandle, delayMs: number): Promise<void> {
		if (!(delayMs > 0)) return Promise.resolve();
		return new Promise<void>((resolve) => {
			let settled = false;
			let timer: NodeJS.Timeout | undefined;
			const done = (): void => {
				if (settled) return;
				settled = true;
				if (timer) clearTimeout(timer);
				if (handle.wakeRetryDelay === done) handle.wakeRetryDelay = undefined;
				resolve();
			};
			timer = setTimeout(done, delayMs);
			handle.wakeRetryDelay = done;
		});
	}

	private wakeRetryDelay(handle: WorkerHandle): void {
		handle.wakeRetryDelay?.();
	}

	/**
	 * Arm both run limits: the inactivity timer (reset by every session event)
	 * and the absolute wall-clock ceiling. Whichever fires first aborts the
	 * session; the first reason wins so a later timer cannot relabel the run.
	 */
	private startRunTimers(handle: WorkerHandle): void {
		const timers: RunTimers = { lastActivityAt: Date.now() };
		timers.ceiling = setTimeout(() => {
			if (!handle.abortReason) handle.abortReason = "runtime";
			this.log.warn("worker run reached its runtime ceiling; aborting", {
				id: handle.record.id,
				maxRuntimeMs: this.cfg.maxRuntimeMs,
				elapsedMs: Date.now() - timers.lastActivityAt,
			});
			this.wakeRetryDelay(handle);
			void handle.session?.abort().catch(() => undefined);
		}, this.cfg.maxRuntimeMs);
		handle.runTimers = timers;
		this.touchRunActivity(handle);
	}

	/** Activity signal for the current run: restart the inactivity timer. */
	private touchRunActivity(handle: WorkerHandle): void {
		const timers = handle.runTimers;
		if (!timers) return;
		timers.lastActivityAt = Date.now();
		if (timers.idle) clearTimeout(timers.idle);
		timers.idle = setTimeout(() => {
			if (!handle.abortReason) handle.abortReason = "idle";
			this.log.warn("worker run idle for too long; aborting", {
				id: handle.record.id,
				idleTimeoutMs: this.cfg.idleTimeoutMs,
				silentMs: Date.now() - timers.lastActivityAt,
			});
			this.wakeRetryDelay(handle);
			void handle.session?.abort().catch(() => undefined);
		}, this.cfg.idleTimeoutMs);
	}

	private clearRunTimers(handle: WorkerHandle): void {
		const timers = handle.runTimers;
		if (!timers) return;
		if (timers.idle) clearTimeout(timers.idle);
		if (timers.ceiling) clearTimeout(timers.ceiling);
		handle.runTimers = undefined;
	}

	/** Map the run's abort reason to a final status; undefined when not aborted. */
	private abortOutcome(
		handle: WorkerHandle,
		previous: WorkerAbortReason | undefined,
	): { status: WorkerStatus; error?: string } | undefined {
		const reason = handle.abortReason ?? previous;
		if (reason === "stop") return { status: "stopped" };
		if (reason === "shutdown") {
			return { status: "interrupted", error: "the alive process stopped while this worker was running" };
		}
		if (reason === "idle") {
			return { status: "failed", error: `worker run idle for ${this.cfg.idleTimeoutMs} ms and was aborted` };
		}
		if (reason === "runtime") {
			return { status: "failed", error: `worker run exceeded ${this.cfg.maxRuntimeMs} ms and was aborted` };
		}
		return undefined;
	}

	private tokenTotal(session: WorkerSession): number {
		try {
			return session.getSessionStats().tokens?.total ?? 0;
		} catch {
			return 0;
		}
	}

	/** True when the run left a visible trace: assistant text, a tool call, or new tokens. */
	private runProducedOutput(handle: WorkerHandle, session: WorkerSession, tokensBefore: number, textBefore?: string): boolean {
		const text = session.getLastAssistantText()?.trim();
		if (text && text !== textBefore) return true;
		if (handle.toolCalls > 0) return true;
		return this.tokenTotal(session) > tokensBefore;
	}

	private finishWithoutRun(handle: WorkerHandle): void {
		const record = handle.record;
		const reason = handle.abortReason;
		// No prompt was spent, so no attempt is reported.
		record.attempts = 0;
		record.status = reason === "stop" ? "stopped" : "interrupted";
		record.lastError = reason === "shutdown" ? "the alive process stopped before this worker run started" : undefined;
		record.abortReason = reason;
		record.lastRunFinishedAt = Date.now();
		record.updatedAt = record.lastRunFinishedAt;
		this.store.save(record);
		this.disposeSession(handle);
		this.notifyWaiters(handle);
	}

	private fail(handle: WorkerHandle, message: string): void {
		const record = handle.record;
		// A launch/prepare failure spends no prompt, so it reports no attempts.
		record.attempts = 0;
		record.status = handle.abortReason === "stop" ? "stopped" : handle.abortReason === "shutdown" ? "interrupted" : "failed";
		record.abortReason = handle.abortReason ?? record.abortReason;
		record.lastError = truncate(message, MAX_ERROR_CHARS);
		record.lastResult = undefined;
		record.lastRunFinishedAt = Date.now();
		record.updatedAt = record.lastRunFinishedAt;
		this.store.save(record);
		this.disposeSession(handle);
		this.log.error("worker failed", { id: record.id, error: message });
		if (record.status !== "stopped") void this.notifyCompletion(record, 0);
		this.notifyWaiters(handle);
	}

	private async notifyCompletion(record: WorkerRecord, durationMs: number): Promise<void> {
		if (!record.notifyOnFinish || this.closing) return;
		if (!this.store.load(record.id)) return;
		const failed = record.status === "failed" || record.status === "interrupted";
		let changed: string[] = [];
		try {
			if (await this.environment.exists(record.workspacePath)) {
				changed = (await gitState(this.environment, record.workspacePath)).changed;
			}
		} catch {
			// The VM may already be shutting down; the event itself is still useful.
		}
		const header = [
			`Worker ${record.id}${record.name ? ` "${record.name}"` : ""} is ${record.status}.`,
			`model=${record.model} isolation=${record.isolation}${record.branch ? ` branch=${record.branch}` : ""}${record.pullRequest ? ` pr=#${record.pullRequest}` : ""}`,
			record.abortReason ? `abort_reason: ${record.abortReason}` : undefined,
			`duration=${Math.max(0, Math.round(durationMs / 1000))}s runs=${record.runs}${
				record.attempts && record.attempts > 1 ? ` attempts=${record.attempts}` : ""
			} workspace=${record.workspacePath}`,
			changed.length > 0 ? `changed (${changed.length}): ${changed.slice(0, 12).join(", ")}${changed.length > 12 ? ", …" : ""}` : "changed: none",
		].filter((line): line is string => Boolean(line));
		const body = record.lastResult?.trim() || record.lastError?.trim() || "(no result reported)";
		const text = `${header.join("\n")}\n\n${truncate(body, 2000)}`;
		try {
			this.events.append({
				kind: "worker",
				source: "workers",
				priority: failed ? "high" : "normal",
				title: `worker ${record.id} ${record.status}`,
				text,
				payload: {
					workerId: record.id,
					status: record.status,
					abortReason: record.abortReason,
					model: record.model,
					isolation: record.isolation,
					workspacePath: record.workspacePath,
					branch: record.branch,
					pullRequest: record.pullRequest,
					attempts: record.attempts,
					changed: changed.slice(0, 50),
					result: record.lastResult ? truncate(record.lastResult, 2000) : undefined,
					error: record.lastError ? truncate(record.lastError, 2000) : undefined,
				},
				dedupeKey: `worker:${record.id}:${record.runs}:${record.updatedAt}`,
			});
		} catch (error) {
			this.log.warn("could not append worker completion event", {
				id: record.id,
				error: error instanceof Error ? error.message : String(error),
			});
		}
	}

	private notifyWaiters(handle: WorkerHandle): void {
		for (const resolve of [...handle.waiters]) resolve();
		handle.waiters.clear();
	}

	private countActive(): number {
		return [...this.handles.values()].filter(
			(handle) => handle.record.status === "starting" || handle.record.status === "running",
		).length;
	}

	private assertBudget(): void {
		if (this.budgetAllows && !this.budgetAllows()) {
			throw new Error("the runtime budget is exhausted; worker runs are paused until it resets");
		}
	}

	private requirePermission(key: keyof WorkerPermissions): void {
		if (!this.cfg.enabled) throw new Error("workers are disabled for this profile; ask the operator to configure workers.enabled");
		if (!workerPermission(this.cfg, key)) {
			throw new Error(`worker permission "${key}" is not granted to this profile`);
		}
	}

	private validateTools(requested: string[] | undefined): string[] {
		if (!requested) return [...this.cfg.tools];
		if (requested.length === 0) throw new Error("worker tools cannot be empty");
		for (const tool of requested) {
			if (!WORKER_TOOL_NAMES.has(tool)) throw new Error(`"${tool}" is not a built-in coding tool`);
			if (!this.cfg.tools.includes(tool)) throw new Error(`tool "${tool}" is not allowed by workers.tools`);
		}
		return [...new Set(requested)];
	}

	private worktreeRoot(): string {
		if (this.environment.kind === "sandbox") {
			return this.environment.resolve(this.cfg.worktreesDirectory || ".alive-workers/worktrees");
		}
		return worktreesRoot(this.config.paths, this.cfg.worktreesDirectory);
	}

	private assertRecordEnvironment(record: WorkerRecord): void {
		if ((record.sandboxed === true) !== this.sandboxed) {
			throw new Error(
				`worker ${record.id} was created in a ${record.sandboxed ? "sandboxed" : "host"} profile but this profile is now ${this.sandboxed ? "sandboxed" : "host"}; remove it or restore the profile environment`,
			);
		}
	}

	private requireRecord(id: string): WorkerRecord {
		const record = this.store.load(validateWorkerId(id));
		if (!record) throw new Error(`unknown worker: ${id}`);
		return record;
	}

	private handleFor(id: string): WorkerHandle {
		const normalized = validateWorkerId(id);
		const existing = this.handles.get(normalized);
		if (existing) return existing;
		const record = this.requireRecord(normalized);
		const handle: WorkerHandle = { record, waiters: new Set(), toolCalls: 0 };
		this.handles.set(normalized, handle);
		return handle;
	}

	/** Use the live record while this process owns the handle, otherwise reload from disk. */
	private snapshot(record: WorkerRecord): WorkerRecord {
		const live = this.handles.get(record.id)?.record;
		return { ...(live ?? record) };
	}

	private disposeSession(handle: WorkerHandle): void {
		if (!handle.session) return;
		try {
			handle.session.dispose();
		} catch {
			// Disposal is best-effort.
		}
		handle.session = undefined;
	}

	private initialPrompt(task: string): string {
		return [
			"Task from the parent Alive agent:",
			"",
			task,
			"",
			"Work until the task is complete. End with a concise report: changes, checks/tests and their outcome, and any blocker.",
		].join("\n");
	}

	private followUpPrompt(prompt: string): string {
		return [
			"Follow-up instruction from the parent Alive agent:",
			"",
			prompt,
			"",
			"End with a concise report: changes, checks/tests and their outcome, and any blocker.",
		].join("\n");
	}
}

/** Human-readable error chain, including an errno buried in `cause` (`fetch failed <- read ECONNRESET`). */
function errorDetail(error: unknown): string {
	const parts: string[] = [];
	let current: unknown = error;
	for (let depth = 0; depth < 4 && current !== undefined && current !== null; depth += 1) {
		if (current instanceof Error) {
			const code = (current as { code?: unknown }).code;
			const message = current.message || current.name;
			const text = typeof code === "string" && code.length > 0 && !message.includes(code) ? `${message} [${code}]` : message;
			if (text && !parts.includes(text)) parts.push(text);
			current = (current as { cause?: unknown }).cause;
		} else {
			const text = String(current);
			if (text && !parts.includes(text)) parts.push(text);
			break;
		}
	}
	return parts.join(" <- ") || "worker run failed";
}

/** Await a settle promise with a bounded timeout; clears the timer on early completion. */
function waitForSettle(promise: Promise<void> | undefined, timeoutMs: number): Promise<void> {
	if (!promise) return Promise.resolve();
	return new Promise((resolve) => {
		const timer = setTimeout(resolve, timeoutMs);
		const done = () => {
			clearTimeout(timer);
			resolve();
		};
		promise.then(done, done);
	});
}

export function renderWorkerRecord(record: WorkerRecord, extra: { activity?: string; git?: Awaited<ReturnType<typeof gitState>> } = {}): string {
	const lines = [
		workerLabel(record),
		`environment: ${record.sandboxed ? "sandbox VM (same VM as the agent)" : "host"}`,
		`workspace: ${record.workspacePath}`,
		record.repositoryPath !== record.workspacePath ? `repository: ${record.repositoryPath}` : undefined,
		record.baseRef ? `base_ref: ${record.baseRef}` : undefined,
		record.baseCommit ? `base_commit: ${record.baseCommit.slice(0, 12)}` : undefined,
		extra.activity ? `activity: ${extra.activity}` : undefined,
		record.sessionFile ? `session: ${record.sessionFile}` : undefined,
		record.lastRunStartedAt ? `last_run_started: ${new Date(record.lastRunStartedAt).toISOString()}` : undefined,
		record.lastRunFinishedAt ? `last_run_finished: ${new Date(record.lastRunFinishedAt).toISOString()}` : undefined,
		record.runs ? `runs: ${record.runs}` : undefined,
		record.attempts && record.attempts > 1 ? `attempts: ${record.attempts}` : undefined,
		record.abortReason ? `abort_reason: ${record.abortReason}` : undefined,
		record.tokens ? `tokens: ${record.tokens.total}` : undefined,
		typeof record.costUsd === "number" ? `cost_usd: ${record.costUsd.toFixed(4)}` : undefined,
		typeof record.lastRunCostUsd === "number" ? `last_run_cost_usd: ${record.lastRunCostUsd.toFixed(4)}` : undefined,
		extra.git ? `git: ${extra.git.branch ?? "detached"}${extra.git.clean ? " (clean)" : ` (${extra.git.changed.length} changed)`}` : undefined,
	].filter((line): line is string => Boolean(line));
	const text = lines.join("\n");
	const result = record.lastResult?.trim();
	const error = record.lastError?.trim();
	if (result) return `${text}\n\nResult:\n${truncate(result, 4000)}`;
	if (error) return `${text}\n\nError:\n${truncate(error, 2000)}`;
	return text;
}

export function renderWorkerList(records: WorkerRecord[]): string {
	if (records.length === 0) return "No workers.";
	return records.map((record) => {
		const changed = record.lastResult ? ` — ${oneLine(record.lastResult, 140)}` : record.lastError ? ` — error: ${oneLine(record.lastError, 140)}` : "";
		return `- ${workerLabel(record)}${changed}`;
	}).join("\n");
}
