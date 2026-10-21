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
import { createWorkerEnvironment, type WorkerEnvironment } from "./environment.js";
import {
	validateWorkerId,
	workerLabel,
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
	abortReason?: "stop" | "shutdown" | "timeout";
	waiters: Set<() => void>;
	activity?: string;
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
		const handle: WorkerHandle = { record, waiters: new Set() };
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
		session.subscribe((event) => {
			if (event.type === "tool_execution_start" && typeof event.toolName === "string") {
				const handle = this.handles.get(record.id);
				if (handle) handle.activity = `tool: ${event.toolName}`;
			} else if (event.type === "turn_start") {
				const handle = this.handles.get(record.id);
				if (handle) handle.activity = "thinking";
			}
		});
		return session;
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
		record.lastRunStartedAt = Date.now();
		record.lastRunFinishedAt = undefined;
		record.lastResult = undefined;
		record.lastError = undefined;
		record.updatedAt = record.lastRunStartedAt;
		this.store.save(record);
		const startedAt = record.lastRunStartedAt;
		let timedOut = false;
		const timer = setTimeout(() => {
			timedOut = true;
			handle.abortReason = "timeout";
			this.log.warn("worker run exceeded its runtime limit; aborting", { id: record.id, maxRuntimeMs: this.cfg.maxRuntimeMs });
			void session.abort().catch(() => undefined);
		}, this.cfg.maxRuntimeMs);

		const previousAbortReason = handle.abortReason;
		handle.abortReason = undefined;
		let status: WorkerStatus = "idle";
		let error: string | undefined;
		try {
			await session.prompt(prompt, { expandPromptTemplates: false, source: "extension" });
			if (previousAbortReason === "stop" || handle.abortReason === "stop") status = "stopped";
			else if (previousAbortReason === "shutdown" || handle.abortReason === "shutdown") status = "interrupted";
			else if (timedOut || handle.abortReason === "timeout") {
				status = "failed";
				error = `worker run exceeded ${this.cfg.maxRuntimeMs} ms and was aborted`;
			} else {
				status = "idle";
			}
		} catch (caught) {
			const message = caught instanceof Error ? caught.message : String(caught);
			if (previousAbortReason === "stop" || handle.abortReason === "stop") {
				status = "stopped";
			} else if (previousAbortReason === "shutdown" || handle.abortReason === "shutdown") {
				status = "interrupted";
				error = "the alive process stopped while this worker was running";
			} else if (timedOut || handle.abortReason === "timeout") {
				status = "failed";
				error = `worker run exceeded ${this.cfg.maxRuntimeMs} ms and was aborted`;
			} else {
				status = "failed";
				error = message;
			}
		} finally {
			clearTimeout(timer);
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
				durationMs: record.lastRunFinishedAt - startedAt,
				error,
			});
			if (status !== "stopped") void this.notifyCompletion(record, record.lastRunFinishedAt - startedAt);
			this.notifyWaiters(handle);
		}
	}

	private finishWithoutRun(handle: WorkerHandle): void {
		const record = handle.record;
		const reason = handle.abortReason;
		record.status = reason === "stop" ? "stopped" : "interrupted";
		record.lastError = reason === "shutdown" ? "the alive process stopped before this worker run started" : undefined;
		record.lastRunFinishedAt = Date.now();
		record.updatedAt = record.lastRunFinishedAt;
		this.store.save(record);
		this.disposeSession(handle);
		this.notifyWaiters(handle);
	}

	private fail(handle: WorkerHandle, message: string): void {
		const record = handle.record;
		record.status = handle.abortReason === "stop" ? "stopped" : handle.abortReason === "shutdown" ? "interrupted" : "failed";
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
			`duration=${Math.max(0, Math.round(durationMs / 1000))}s runs=${record.runs} workspace=${record.workspacePath}`,
			changed.length > 0 ? `changed (${changed.length}): ${changed.slice(0, 12).join(", ")}${changed.length > 12 ? ", …" : ""}` : "changed: none",
		];
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
					model: record.model,
					isolation: record.isolation,
					workspacePath: record.workspacePath,
					branch: record.branch,
					pullRequest: record.pullRequest,
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
		const handle: WorkerHandle = { record, waiters: new Set() };
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
