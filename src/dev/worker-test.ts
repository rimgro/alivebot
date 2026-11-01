/**
 * Worker subsystem test: config/permission gates, session reuse, concurrency,
 * stop/timeout, restart recovery and git worktree lifecycle. No model is used;
 * a fake pi session stands in for the coding agent.
 *
 *   npm run test:workers
 */
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { loadConfig, type LoadedConfig } from "../config.js";
import { DEFAULT_SANDBOX_CONFIG } from "../sandbox/config.js";
import { Logger } from "../log.js";
import { EventStore } from "../store/events.js";
import {
	DEFAULT_WORKERS_CONFIG,
	matchesModelAllowlist,
	selectWorkerModel,
	validateWorkerBranch,
	validateWorkersConfig,
} from "../workers/config.js";
import { WorkerManager, renderWorkerRecord } from "../workers/manager.js";
import { MAX_PROVIDER_RETRY_DELAY_MS, isTransientProviderError, providerRetryDelayMs } from "../workers/retry.js";
import type { WorkerSession, WorkerSessionFactory } from "../workers/session.js";
import { WorkerStore } from "../workers/store.js";
import { assertWorkerWorktreeIsSecretFree, baseBranchName, createWorktree, gitDiff, removeWorktree } from "../workers/worktree.js";
import { createHostWorkerEnvironment } from "../workers/environment.js";
import type { SandboxManager } from "../sandbox/manager.js";
import { createSandboxTools } from "../sandbox/tools.js";
import { sleep } from "../util.js";

let failures = 0;
function check(name: string, condition: boolean, detail?: unknown): void {
	if (condition) {
		process.stdout.write(`  ok    ${name}\n`);
		return;
	}
	failures += 1;
	process.stdout.write(`  FAIL  ${name}${detail === undefined ? "" : ` — ${JSON.stringify(detail)}`}\n`);
}
function section(name: string): void {
	process.stdout.write(`\n${name}\n`);
}
async function expectReject(name: string, action: () => Promise<unknown>, includes?: string): Promise<void> {
	try {
		await action();
		check(name, false, "expected rejection");
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		check(name, includes === undefined || message.includes(includes), message);
	}
}

class FakeSession implements WorkerSession {
	readonly sessionFile: string;
	isStreaming = false;
	prompts: string[] = [];
	disposed = false;
	hang = false;
	/** Simulate a provider failure: the run ends without text, tokens or tool calls. */
	silent = false;
	/** Simulate an assistant turn that ended with stopReason "error". */
	errorMessage?: string;
	/** Provider errors to emit for the next prompts, then succeed (retry tests). */
	failureQueue: string[] = [];
	/** Emit one tool execution before failing (a failed run that already did work). */
	toolCallBeforeError = false;
	/** Tool executions emitted by this session, over all prompts. */
	toolExecutions = 0;
	/** While hanging, emit a tool event every N ms (a run that keeps working). */
	heartbeatMs?: number;
	private heartbeat?: NodeJS.Timeout;
	private lastText: string | undefined;
	private successfulPrompts = 0;
	private listeners: Array<(event: { type: string; toolName?: string; [key: string]: unknown }) => void> = [];
	private abortReject?: (error: Error) => void;

	constructor(id: string, sessionFile?: string) {
		this.sessionFile = sessionFile ?? `/tmp/fake-worker-${id}.jsonl`;
	}

	async prompt(text: string): Promise<void> {
		this.prompts.push(text);
		this.isStreaming = true;
		try {
			if (this.hang) {
				await new Promise<void>((_resolve, reject) => {
					this.abortReject = reject;
					if (this.heartbeatMs) {
						this.heartbeat = setInterval(() => this.emitTool(), this.heartbeatMs);
					}
				});
			}
			const failure = this.failureQueue.shift() ?? this.errorMessage;
			if (failure) {
				if (this.toolCallBeforeError) this.emitTool();
				const message = { role: "assistant", stopReason: "error", errorMessage: failure };
				for (const listener of this.listeners) listener({ type: "turn_end", message, toolResults: [] });
				return;
			}
			if (this.silent) return;
			this.successfulPrompts += 1;
			this.lastText = `completed: ${text.split("\n")[0] ?? "task"}`;
			for (const listener of this.listeners) listener({ type: "turn_start" });
		} finally {
			if (this.heartbeat) clearInterval(this.heartbeat);
			this.heartbeat = undefined;
			this.isStreaming = false;
			this.abortReject = undefined;
		}
	}

	private emitTool(): void {
		this.toolExecutions += 1;
		for (const listener of this.listeners) listener({ type: "tool_execution_start", toolName: "bash" });
	}

	subscribe(listener: (event: { type: string; toolName?: string; [key: string]: unknown }) => void): () => void {
		this.listeners.push(listener);
		return () => {
			this.listeners = this.listeners.filter((item) => item !== listener);
		};
	}

	async abort(): Promise<void> {
		this.abortReject?.(new Error("aborted"));
		this.abortReject = undefined;
	}

	dispose(): void {
		this.disposed = true;
	}

	getLastAssistantText(): string | undefined {
		return this.lastText;
	}

	getSessionStats() {
		if (this.silent) return { tokens: { input: 0, output: 0, total: 0 }, cost: 0 };
		return {
			tokens: { input: 11 * this.successfulPrompts, output: 22 * this.successfulPrompts, total: 33 * this.successfulPrompts },
			// Cost is cumulative and flat: a failed prompt (no tokens) costs nothing.
			cost: this.successfulPrompts > 0 ? 0.001 : 0,
		};
	}
}

function makeConfig(root: string, overrides: Record<string, unknown> = {}): LoadedConfig {
	return loadConfig({
		cwd: root,
		overrides: {
			sandbox: { ...DEFAULT_SANDBOX_CONFIG, enabled: false },
			workers: {
				enabled: true,
				permissions: { spawn: true, send: true, stop: true, inspect: true, worktree: true, pullRequest: true },
				models: ["fake/model", "fake/*"],
				defaultModel: "fake/model",
				tools: ["read", "write", "edit", "bash", "grep", "find", "ls"],
				maxConcurrent: 2,
				idleTimeoutMs: 20_000,
				maxRuntimeMs: 30_000,
				providerRetries: 2,
				providerRetryDelayMs: 1,
				repository: ".",
				worktreesDirectory: "",
				baseRef: "",
				remote: "origin",
				notifyOnFinish: true,
				...overrides,
			},
		},
	});
}

function makeManager(
	config: LoadedConfig,
	sessions: FakeSession[],
	hang = false,
	budgetAllows?: () => boolean,
	sandbox?: SandboxManager,
	prepare?: (session: FakeSession) => void,
): WorkerManager {
	const factory: WorkerSessionFactory = async (input) => {
		const session = new FakeSession(input.id, input.sessionFile);
		session.hang = hang;
		prepare?.(session);
		sessions.push(session);
		return session;
	};
	return new WorkerManager({
		config,
		events: EventStore.open(config.paths.stateDir),
		log: new Logger({ console: false, level: "error", scope: "worker-test" }),
		sessionFactory: factory,
		budgetAllows,
		sandbox,
	});
}

const root = fs.mkdtempSync(path.join(os.tmpdir(), "alive-worker-test-"));
const git = (cwd: string, args: string[]): string =>
	execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
git(root, ["init"]);
git(root, ["config", "user.email", "worker-test@example.com"]);
git(root, ["config", "user.name", "Worker Test"]);
fs.writeFileSync(path.join(root, ".gitignore"), ".alive/\n.env\n");
fs.writeFileSync(path.join(root, "README.md"), "hello\n");
// Track the worst case on purpose: a project that committed its config and
// local secret files. Worker worktrees must still not expose them.
fs.mkdirSync(path.join(root, ".alive"), { recursive: true });
fs.writeFileSync(path.join(root, ".alive", "state.txt"), "private runtime state\n");
fs.writeFileSync(path.join(root, "alive.config.json"), JSON.stringify({ name: "Worker Test Fixture" }, null, 2) + "\n");
fs.writeFileSync(path.join(root, ".env"), "WORKER_TEST_SECRET=fixture-only\n");
fs.writeFileSync(path.join(root, ".env.example"), "WORKER_TEST_SECRET=\n");
git(root, ["add", ".gitignore", "README.md", "alive.config.json", ".env.example"]);
git(root, ["add", "-f", ".env", ".alive/state.txt"]);
git(root, ["commit", "-m", "initial"]);

section("worker config and model allowlist");
check("workers are disabled by default", DEFAULT_WORKERS_CONFIG.enabled === false);
check("default idle timeout is 10 minutes", DEFAULT_WORKERS_CONFIG.idleTimeoutMs === 10 * 60_000, DEFAULT_WORKERS_CONFIG.idleTimeoutMs);
check("default runtime ceiling is 2 hours", DEFAULT_WORKERS_CONFIG.maxRuntimeMs === 2 * 60 * 60_000, DEFAULT_WORKERS_CONFIG.maxRuntimeMs);
try {
	validateWorkersConfig({ ...DEFAULT_WORKERS_CONFIG, enabled: true, models: [] });
	check("enabled workers require models", false);
} catch {
	check("enabled workers require models", true);
}
check("exact model matches", matchesModelAllowlist(["fake/model"], "fake/model"));
check("thinking suffix does not change model identity", matchesModelAllowlist(["fake/model"], "fake/model:high"));
check("wildcard provider matches", matchesModelAllowlist(["fake/*"], "fake/other"));
check("different provider does not match", !matchesModelAllowlist(["fake/*"], "other/model"));
check("default model selected", selectWorkerModel(makeConfig(root).config.workers, undefined) === "fake/model");
try {
	validateWorkerBranch("../escape");
	check("branch traversal rejected", false);
} catch {
	check("branch traversal rejected", true);
}
check("base ref strips remote", baseBranchName("origin/main") === "main");
check("HEAD base ref is omitted", baseBranchName("HEAD") === undefined);
{
	const validateTimeouts = (patch: Record<string, unknown>): unknown => validateWorkersConfig({
		...DEFAULT_WORKERS_CONFIG,
		enabled: true,
		models: ["fake/model"],
		...patch,
	});
	const rejects = (name: string, patch: Record<string, unknown>): void => {
		try {
			validateTimeouts(patch);
			check(name, false, "expected rejection");
		} catch {
			check(name, true);
		}
	};
	let defaultTimeoutsValid = true;
	try {
		validateTimeouts({});
	} catch {
		defaultTimeoutsValid = false;
	}
	check("default timeout config is valid", defaultTimeoutsValid);
	rejects("runtime ceiling must exceed the idle timeout", { idleTimeoutMs: 600_000, maxRuntimeMs: 600_000 });
	rejects("runtime ceiling below the idle timeout is rejected", { idleTimeoutMs: 60_000, maxRuntimeMs: 30_000 });
	rejects("idle timeout must be positive", { idleTimeoutMs: 0 });
	rejects("idle timeout must be an integer", { idleTimeoutMs: 1_500.5 });
	rejects("negative idle timeout is rejected", { idleTimeoutMs: -1 });
	rejects("runtime ceiling must be positive", { idleTimeoutMs: 10_000, maxRuntimeMs: 0 });
	rejects("negative runtime ceiling is rejected", { idleTimeoutMs: 10_000, maxRuntimeMs: -5_000 });
}

section("empty runs surface as failures instead of idle");
{
	const config = makeConfig(root);
	const silentSessions: FakeSession[] = [];
	const silentManager = makeManager(config, silentSessions, false, undefined, undefined, (session) => {
		session.silent = true;
	});
	await silentManager.init();
	const silent = await silentManager.start({ task: "Do nothing", isolation: "shared", wait: true, waitTimeoutMs: 5_000 });
	check("silent run is failed", silent.status === "failed", silent.status);
	check("silent run explains itself", silent.lastError?.includes("no output") === true, silent.lastError);
	check("silent run keeps no result", silent.lastResult === undefined, silent.lastResult);
	await silentManager.close();

	const errorSessions: FakeSession[] = [];
	const errorManager = makeManager(config, errorSessions, false, undefined, undefined, (session) => {
		session.errorMessage = "provider rejected the request (401 invalid api key)";
	});
	await errorManager.init();
	const errored = await errorManager.start({ task: "Call the model", isolation: "shared", wait: true, waitTimeoutMs: 5_000 });
	check("provider error is failed", errored.status === "failed", errored.status);
	check("provider error text is kept", errored.lastError?.includes("401 invalid api key") === true, errored.lastError);
	await errorManager.close();
}

section("start, wait, completion event and session reuse");
{
	const config = makeConfig(root);
	const sessions: FakeSession[] = [];
	const manager = makeManager(config, sessions);
	await manager.init();
	const first = await manager.start({ task: "Change the README", isolation: "shared", wait: true, waitTimeoutMs: 5_000 });
	check("worker finished idle", first.status === "idle", first.status);
	check("worker stored the result", first.lastResult?.includes("completed") === true, first.lastResult);
	check("worker used one run", first.runs === 1);
	check("worker recorded usage", first.tokens?.total === 33);
	check("worker cost counted today", Math.abs(manager.usageToday() - 0.001) < 1e-9, manager.usageToday());
	const usageEntry = new WorkerStore(config.paths).usageHistory().at(-1);
	check(
		"worker usage records model, turns, worker id and status (#122)",
		usageEntry?.model === "fake/model" && typeof usageEntry?.turns === "number" && usageEntry?.workerId === first.id && usageEntry?.status === "idle",
		usageEntry,
	);
	check("worker session file recorded", Boolean(first.sessionFile));
	await sleep(100);
	const events = EventStore.open(config.paths.stateDir).peekPending(20);
	check("completion event queued", events.some((event) => event.kind === "worker" && event.title.includes(first.id)), events.map((event) => event.title));

	const second = await manager.send(first.id, "Now add a test", { wait: true, waitTimeoutMs: 5_000 });
	check("follow-up finished idle", second.status === "idle", second.status);
	check("follow-up reused one pi session", sessions.length === 1, sessions.length);
	check("follow-up added a run", second.runs === 2, second.runs);
	check("follow-up reached the session", sessions[0]?.prompts.length === 2, sessions[0]?.prompts.length);

	await expectReject("unknown model rejected", () => manager.start({ task: "x", model: "other/model", isolation: "shared" }), "not in workers.models");

	const list = manager.list();
	check("list includes the worker", list.some((record) => record.id === first.id));
	const view = await manager.status(first.id);
	check("status includes live git state", view.git?.clean === true, view.git);

	await expectReject("pr requires worktree isolation", () => manager.createPullRequest(first.id, { title: "Nope" }), "worktree isolation");

	await manager.remove(first.id);
	check("remove deletes the record", new WorkerStore(config.paths).load(first.id) === undefined);
	check("worker cost survives removal", Math.abs(manager.usageToday() - 0.001) < 1e-9, manager.usageToday());
	await expectReject("removed worker is unknown", () => manager.status(first.id), "unknown worker");
	await manager.close();
}

section("sandbox workers use the agent VM paths, not host paths");
{
	const config = makeConfig(root, {});
	config.config.sandbox = { ...DEFAULT_SANDBOX_CONFIG, enabled: true };
	const commands: string[] = [];
	const cwds: string[] = [];
	const fakeSandbox = {
		workspaceDir: "/home/alive",
		path(value: string) {
			return path.posix.resolve("/home/alive", value || ".");
		},
		exclusive<T>(operation: () => Promise<T>): Promise<T> {
			return operation();
		},
		async execute(command: string, _timeout?: number, _signal?: AbortSignal, _onData?: unknown, cwd?: string) {
			commands.push(command);
			if (cwd) cwds.push(cwd);
			if (command.includes("test -e")) return { text: "", code: 0, truncated: false };
			if (command.includes("rev-parse --is-inside-work-tree")) return { text: "true\n", code: 0, truncated: false };
			if (command.includes("rev-parse HEAD")) return { text: "0123456789abcdef\n", code: 0, truncated: false };
			if (command.includes("rev-parse --abbrev-ref HEAD")) return { text: "main\n", code: 0, truncated: false };
			if (command.includes("status --porcelain")) return { text: "", code: 0, truncated: false };
			if (command.includes("rev-list")) return { text: "0\n", code: 0, truncated: false };
			return { text: "", code: 0, truncated: false };
		},
	} as unknown as SandboxManager;
	const manager = makeManager(config, [], false, undefined, fakeSandbox);
	await manager.init();
	const record = await manager.start({ task: "inspect the guest repo", isolation: "shared", wait: true, waitTimeoutMs: 5_000 });
	check("sandbox worker is marked sandboxed", record.sandboxed === true);
	check("sandbox worker uses guest workspace", record.workspacePath === "/home/alive", record.workspacePath);
	check("sandbox worker uses guest repository", record.repositoryPath === "/home/alive", record.repositoryPath);
	check("sandbox commands stay in the guest", commands.some((command) => command.includes("cd '/home/alive'")), commands.slice(0, 4));
	const workerRoot = "/home/alive/.alive-workers/worktrees/wrk_probe";
	const sandboxTools = createSandboxTools(fakeSandbox, config, { rootDir: workerRoot });
	const bash = sandboxTools.find((tool) => tool.name === "bash")!;
	await bash.execute("probe", { command: "pwd" }, undefined, undefined, {} as never);
	check("sandbox worker bash runs in its worktree", cwds.includes(workerRoot), cwds.slice(0, 6));
	await manager.remove(record.id);
	await manager.close();
}

section("permission and concurrency gates");
{
	const config = makeConfig(root);
	const manager = makeManager(config, [], false, () => false);
	await manager.init();
	await expectReject("budget gate blocks worker start", () => manager.start({ task: "x", isolation: "shared" }), "budget");
	await manager.close();
}
{
	const config = makeConfig(root, { permissions: { spawn: false, send: true, stop: true, inspect: true, worktree: false, pullRequest: false } });
	const manager = makeManager(config, []);
	await manager.init();
	await expectReject("spawn permission is enforced", () => manager.start({ task: "x", isolation: "shared" }), "permission");
	await manager.close();
}
{
	const config = makeConfig(root, { maxConcurrent: 1 });
	const sessions: FakeSession[] = [];
	const manager = makeManager(config, sessions, true);
	await manager.init();
	const first = await manager.start({ task: "long task", isolation: "shared" });
	await sleep(100);
	await expectReject("concurrency limit enforced", () => manager.start({ task: "second", isolation: "shared" }), "concurrency limit");
	check("first worker is running", manager.list().find((record) => record.id === first.id)?.status === "running");
	const stopped = await manager.stop(first.id);
	check("stop marks the worker stopped", stopped.status === "stopped", stopped.status);
	check("stop records the abort reason", stopped.abortReason === "stop", stopped.abortReason);
	check("stop disposed the session", sessions[0]?.disposed === true);
	await manager.close();
}

section("shutdown records the abort reason");
{
	const config = makeConfig(root);
	const sessions: FakeSession[] = [];
	const manager = makeManager(config, sessions, true);
	await manager.init();
	const record = await manager.start({ task: "run until shutdown", isolation: "shared" });
	await sleep(50);
	await manager.close();
	const stored = new WorkerStore(config.paths).load(record.id)!;
	check("shutdown interrupts the run", stored.status === "interrupted", stored.status);
	check("shutdown recorded as abort reason", stored.abortReason === "shutdown", stored.abortReason);
}

section("runtime ceiling aborts a stuck worker");
{
	const config = makeConfig(root);
	config.config.workers.idleTimeoutMs = 5_000;
	config.config.workers.maxRuntimeMs = 80;
	const sessions: FakeSession[] = [];
	const manager = makeManager(config, sessions, true);
	await manager.init();
	const record = await manager.start({ task: "hang forever", isolation: "shared", wait: true, waitTimeoutMs: 2_000 });
	check("timeout marks the worker failed", record.status === "failed", record.status);
	check("timeout reason is stored", record.lastError?.includes("exceeded") === true, record.lastError);
	check("runtime ceiling recorded as abort reason", record.abortReason === "runtime", record.abortReason);
	check("status text reports the runtime ceiling", renderWorkerRecord(record).includes("abort_reason: runtime"), renderWorkerRecord(record));
	check("timed out session was disposed", sessions[0]?.disposed === true);
	await manager.close();
}

section("inactivity timeout aborts a silent worker");
{
	const config = makeConfig(root);
	config.config.workers.idleTimeoutMs = 120;
	config.config.workers.maxRuntimeMs = 60_000;
	const sessions: FakeSession[] = [];
	const manager = makeManager(config, sessions, true);
	await manager.init();
	const record = await manager.start({ task: "go silent", isolation: "shared", wait: true, waitTimeoutMs: 5_000 });
	check("silent run is failed", record.status === "failed", record.status);
	check("silent run names the inactivity limit", record.lastError?.includes("idle for 120 ms and was aborted") === true, record.lastError);
	check("idle abort reason recorded", record.abortReason === "idle", record.abortReason);
	check("status text reports the idle abort", renderWorkerRecord(record).includes("abort_reason: idle"), renderWorkerRecord(record));
	check("idle session was disposed", sessions[0]?.disposed === true);
	await sleep(100);
	const events = EventStore.open(config.paths.stateDir).peekPending(500);
	const completion = events.find((event) => {
		const payload = event.payload as { workerId?: string } | undefined;
		return event.kind === "worker" && payload?.workerId === record.id;
	});
	check("completion event mentions the abort reason", completion?.text.includes("abort_reason: idle") === true, completion?.text);
	await manager.close();
}

section("an active worker survives past the idle timeout");
{
	const config = makeConfig(root);
	config.config.workers.idleTimeoutMs = 120;
	config.config.workers.maxRuntimeMs = 500;
	const sessions: FakeSession[] = [];
	const manager = makeManager(config, sessions, true, undefined, undefined, (session) => {
		session.heartbeatMs = 40;
	});
	await manager.init();
	const startedAt = Date.now();
	const record = await manager.start({ task: "work steadily", isolation: "shared", wait: true, waitTimeoutMs: 5_000 });
	const elapsed = Date.now() - startedAt;
	check("active run outlives the idle timeout", elapsed >= 400, elapsed);
	check("active run is stopped by the runtime ceiling", record.abortReason === "runtime", record.abortReason);
	check("active run reports the ceiling message", record.lastError?.includes("exceeded 500 ms") === true, record.lastError);
	await manager.close();
}

section("restart recovery");
{
	const config = makeConfig(root);
	const sessions: FakeSession[] = [];
	const manager = makeManager(config, sessions);
	await manager.init();
	const record = await manager.start({ task: "finish then simulate a crash", isolation: "shared", wait: true, waitTimeoutMs: 5_000 });
	await manager.close();
	const store = new WorkerStore(config.paths);
	const stale = store.load(record.id)!;
	stale.status = "running";
	stale.runs = 1;
	store.save(stale);

	const recovered = makeManager(config, []);
	await recovered.init();
	const after = store.load(record.id)!;
	check("stale worker marked interrupted", after.status === "interrupted", after.status);
	const events = EventStore.open(config.paths.stateDir).peekPending(50);
	check("restart recovery emits an event", events.some((event) => event.title.includes("interrupted")), events.map((event) => event.title));
	await recovered.close();
}

section("git worktree lifecycle");
{
	const config = makeConfig(root, { maxConcurrent: 2 });
	const sessions: FakeSession[] = [];
	const manager = makeManager(config, sessions);
	await manager.init();
	const record = await manager.start({ task: "work on a branch", isolation: "worktree", wait: true, waitTimeoutMs: 5_000 });
	check("worktree worker idle", record.status === "idle", record.status);
	check("worktree exists", fs.existsSync(record.workspacePath), record.workspacePath);
	check("branch is recorded", Boolean(record.branch), record.branch);
	check("branch is alive/<id>", record.branch === `alive/${record.id}`, record.branch);
	check("base commit recorded", Boolean(record.baseCommit));
	const env = createHostWorkerEnvironment(root);
	await removeWorktree(env, root, record.workspacePath);
	check("worktree removed manually", !fs.existsSync(record.workspacePath));
	const resumed = await manager.send(record.id, "continue after the worktree was recreated", { wait: true, waitTimeoutMs: 5_000 });
	check("worktree reattached on resume", resumed.status === "idle" && fs.existsSync(record.workspacePath), resumed.status);
	fs.writeFileSync(path.join(record.workspacePath, "NEW.md"), "new file\n");
	const diff = await manager.diff(record.id, true);
	check("diff reports untracked file", diff.includes("NEW.md"), diff.slice(0, 500));
	const view = await manager.status(record.id);
	check("status sees the change", view.git?.clean === false && view.git?.changed.some((line) => line.includes("NEW.md")) === true);
	await manager.remove(record.id, { force: true });
	check("worktree removed", !fs.existsSync(record.workspacePath));
	check("branch kept after worktree removal", git(root, ["branch", "--list", record.branch!]).includes(record.branch!));
	await manager.close();
}

section("worker worktrees exclude config and state");
{
	const config = makeConfig(root, { maxConcurrent: 2 });
	const manager = makeManager(config, []);
	await manager.init();
	const record = await manager.start({ task: "inspect the repository", isolation: "worktree", wait: true, waitTimeoutMs: 5_000 });
	check("worktree worker idle", record.status === "idle", record.status);
	check("worktree has no alive.config.json", !fs.existsSync(path.join(record.workspacePath, "alive.config.json")));
	check("worktree has no alive.config.local.json", !fs.existsSync(path.join(record.workspacePath, "alive.config.local.json")));
	check("worktree has no .alive state", !fs.existsSync(path.join(record.workspacePath, ".alive")));
	check("worktree has no .env", !fs.existsSync(path.join(record.workspacePath, ".env")));
	check("worktree still has the code", fs.existsSync(path.join(record.workspacePath, "README.md")));
	check("worktree keeps the value-free .env.example", fs.existsSync(path.join(record.workspacePath, ".env.example")));
	const env = createHostWorkerEnvironment(root);
	const unsafe = path.join(root, ".worktrees", "unsafe-probe");
	await createWorktree(env, { repositoryPath: root, worktreePath: unsafe, branch: "unsafe-probe", baseRef: "HEAD" });
	// Simulate an old/hand-made worktree: put the private files back.
	fs.writeFileSync(path.join(unsafe, "alive.config.json"), "{}\n");
	await expectReject(
		"guard refuses a worktree containing private runtime data",
		() => assertWorkerWorktreeIsSecretFree(env, unsafe),
		"private runtime data",
	);
	await removeWorktree(env, root, unsafe, { force: true });
	await manager.remove(record.id, { force: true });
	await manager.close();
}

section("pull request publish flow");
{
	const remote = path.join(os.tmpdir(), `alive-worker-remote-${Date.now()}.git`);
	execFileSync("git", ["init", "--bare", remote], { stdio: "ignore" });
	git(root, ["remote", "add", "origin", remote]);
	git(root, ["push", "-u", "origin", "HEAD"]);
	const bin = fs.mkdtempSync(path.join(os.tmpdir(), "alive-worker-gh-"));
	const fakeGh = path.join(bin, "gh");
	fs.writeFileSync(fakeGh, [
		"#!/bin/sh",
		'if [ "$1" = "--version" ]; then echo "gh version 0.0.0 (fake)"; exit 0; fi',
		'if [ "$1 $2" = "pr create" ]; then echo "https://example.test/alive/pull/1"; exit 0; fi',
		'if [ "$1 $2" = "pr view" ]; then echo \'{"url":"https://example.test/alive/pull/1"}\'; exit 0; fi',
		"exit 1",
		"",
	].join("\n"));
	fs.chmodSync(fakeGh, 0o755);
	const originalPath = process.env.PATH;
	process.env.PATH = `${bin}:${originalPath ?? ""}`;
	try {
		const config = makeConfig(root, { maxConcurrent: 2 });
		const manager = makeManager(config, []);
		await manager.init();
		const record = await manager.start({ task: "make a change and publish it", isolation: "worktree", wait: true, waitTimeoutMs: 5_000 });
		check("publish worker idle", record.status === "idle", record.status);
		fs.writeFileSync(path.join(record.workspacePath, "FEATURE.md"), "feature\n");
		const published = await manager.createPullRequest(record.id, { title: "Add a feature", commitMessage: "Add feature" });
		check("pull request url returned", published.url === "https://example.test/alive/pull/1", published);
		check("pull request url persisted", (await manager.status(record.id)).record.pullRequestUrl === published.url);
		check("branch pushed to remote", git(remote, ["show-ref", "--verify", `refs/heads/${published.branch}`]).includes(published.branch));
		await manager.remove(record.id);
		await manager.close();
	} finally {
		process.env.PATH = originalPath;
		fs.rmSync(bin, { recursive: true, force: true });
		fs.rmSync(remote, { recursive: true, force: true });
	}
}

section("standalone worktree helpers");
{
	const helperRepo = fs.mkdtempSync(path.join(os.tmpdir(), "alive-worker-worktree-"));
	git(helperRepo, ["init"]);
	git(helperRepo, ["config", "user.email", "worker-test@example.com"]);
	git(helperRepo, ["config", "user.name", "Worker Test"]);
	fs.writeFileSync(path.join(helperRepo, "file.txt"), "one\n");
	git(helperRepo, ["add", "file.txt"]);
	git(helperRepo, ["commit", "-m", "initial"]);
	const worktree = path.join(helperRepo, ".worktrees", "probe");
	const env = createHostWorkerEnvironment(helperRepo);
	await createWorktree(env, { repositoryPath: helperRepo, worktreePath: worktree, branch: "probe", baseRef: "HEAD" });
	check("helper created worktree", fs.existsSync(path.join(worktree, "file.txt")));
	fs.writeFileSync(path.join(worktree, "file.txt"), "two\n");
	const diff = await gitDiff(env, worktree, { full: true });
	check("helper diff sees modification", diff.patch?.includes("two") === true, diff.stat);
	check("helper diffstat", diff.stat.includes("file.txt"), diff.stat);
	await removeWorktree(env, helperRepo, worktree, { force: true });
	check("helper removed worktree", !fs.existsSync(worktree));
	fs.rmSync(helperRepo, { recursive: true, force: true });
}

section("provider failure classification");
{
	const transient = [
		"Request timed out",
		"request timeout after 30s",
		"connect ETIMEDOUT 10.0.0.1:443",
		"read ECONNRESET",
		"Connection error",
		"connect ECONNREFUSED 127.0.0.1:8443",
		"socket hang up",
		"fetch failed",
		"HTTP 429 Too Many Requests",
		"rate_limit_error: retry later",
		"provider overloaded",
		"HTTP 503 Service Unavailable",
		"500 Internal Server Error",
		"upstream returned 502 after a timeout",
		"gateway timeout",
	];
	for (const message of transient) check(`transient: ${message}`, isTransientProviderError(message));
	const permanent = [
		"401 Unauthorized",
		"invalid api key provided",
		"400 invalid_request_error: messages is required",
		"403 forbidden",
		"model not found: fake/gone",
		"404 model_not_found",
		"context_length_exceeded",
		"invalid request: temperature must be a number",
		"429 insufficient_quota: exceeded your current quota",
	];
	for (const message of permanent) check(`not retried: ${message}`, !isTransientProviderError(message));
	check("empty error text is not retried", !isTransientProviderError(""));
	check("a millisecond duration is not a 4xx status", isTransientProviderError("Request timed out after 400 ms"));
	check("a millisecond duration is not a 429", !isTransientProviderError("request finished in 429 ms"));
}

section("provider retry config");
{
	check("default provider retries is 2", DEFAULT_WORKERS_CONFIG.providerRetries === 2, DEFAULT_WORKERS_CONFIG.providerRetries);
	check(
		"default provider retry delay is 5s",
		DEFAULT_WORKERS_CONFIG.providerRetryDelayMs === 5_000,
		DEFAULT_WORKERS_CONFIG.providerRetryDelayMs,
	);
	const validateRetries = (patch: Record<string, unknown>): unknown => validateWorkersConfig({
		...DEFAULT_WORKERS_CONFIG,
		enabled: true,
		models: ["fake/model"],
		...patch,
	});
	let defaultsValid = true;
	try {
		validateRetries({});
	} catch {
		defaultsValid = false;
	}
	check("default provider retry config is valid", defaultsValid);
	const rejects = (name: string, patch: Record<string, unknown>): void => {
		try {
			validateRetries(patch);
			check(name, false, "expected rejection");
		} catch {
			check(name, true);
		}
	};
	rejects("negative provider retries rejected", { providerRetries: -1 });
	rejects("fractional provider retries rejected", { providerRetries: 1.5 });
	rejects("non-numeric provider retries rejected", { providerRetries: Number.NaN });
	rejects("negative provider retry delay rejected", { providerRetryDelayMs: -1 });
	rejects("non-finite provider retry delay rejected", { providerRetryDelayMs: Number.POSITIVE_INFINITY });
	rejects("provider retries above the safety cap rejected", { providerRetries: 11 });
	check("linear backoff grows with the attempt", providerRetryDelayMs(5_000, 1) === 5_000 && providerRetryDelayMs(5_000, 2) === 10_000);
	check("backoff is capped at 60s", providerRetryDelayMs(5_000, 100) === MAX_PROVIDER_RETRY_DELAY_MS, providerRetryDelayMs(5_000, 100));
	check("zero base delay stays zero", providerRetryDelayMs(0, 3) === 0);
}

section("provider retries: transient failures then success");
{
	const config = makeConfig(root);
	const sessions: FakeSession[] = [];
	const manager = makeManager(config, sessions, false, undefined, undefined, (session) => {
		session.failureQueue.push("Request timed out", "Connection error: read ECONNRESET");
	});
	await manager.init();
	const record = await manager.start({ task: "retry the provider", isolation: "shared", wait: true, waitTimeoutMs: 5_000 });
	check("run recovered after retries", record.status === "idle", record.status);
	check("retries do not add runs", record.runs === 1, record.runs);
	check("attempts count the retries", record.attempts === 3, record.attempts);
	check("recovered run keeps the result", record.lastResult?.includes("completed") === true, record.lastResult);
	check("recovered run has no error", record.lastError === undefined, record.lastError);
	check("each attempt sent the prompt once", sessions[0]?.prompts.length === 3, sessions[0]?.prompts.length);
	check("retries did not execute tools", sessions[0]?.toolExecutions === 0, sessions[0]?.toolExecutions);
	check("status text mentions attempts", renderWorkerRecord(record).includes("attempts: 3"), renderWorkerRecord(record));
	await sleep(100);
	const events = EventStore.open(config.paths.stateDir).peekPending(50);
	const completion = events.find((event) => {
		const payload = event.payload as { workerId?: string } | undefined;
		return event.kind === "worker" && payload?.workerId === record.id;
	});
	check("completion event mentions attempts", completion?.text.includes("attempts=3") === true, completion?.text);
	await manager.close();
}

section("provider retries: every attempt fails");
{
	const config = makeConfig(root);
	const sessions: FakeSession[] = [];
	const manager = makeManager(config, sessions, false, undefined, undefined, (session) => {
		session.errorMessage = "HTTP 503 Service Unavailable";
	});
	await manager.init();
	const record = await manager.start({ task: "fail forever", isolation: "shared", wait: true, waitTimeoutMs: 5_000 });
	check("exhausted retries end failed", record.status === "failed", record.status);
	check("last provider error is kept", record.lastError?.includes("503 Service Unavailable") === true, record.lastError);
	check("failure reports how many attempts were made", record.lastError?.includes("3 attempts") === true, record.lastError);
	check("failed retries are still one run", record.runs === 1, record.runs);
	check("attempts are recorded on failure", record.attempts === 3, record.attempts);
	check("three prompts were spent", sessions[0]?.prompts.length === 3, sessions[0]?.prompts.length);
	await manager.close();
}

section("provider retries: side effects and permanent errors are never retried");
{
	const config = makeConfig(root);
	const afterToolSessions: FakeSession[] = [];
	const afterTool = makeManager(config, afterToolSessions, false, undefined, undefined, (session) => {
		session.errorMessage = "Request timed out";
		session.toolCallBeforeError = true;
	});
	await afterTool.init();
	const afterToolRecord = await afterTool.start({ task: "work then time out", isolation: "shared", wait: true, waitTimeoutMs: 5_000 });
	check("failure after a tool call is not retried", afterToolRecord.attempts === 1, afterToolRecord.attempts);
	check("failure after a tool call sent one prompt", afterToolSessions[0]?.prompts.length === 1, afterToolSessions[0]?.prompts.length);
	check("failure after a tool call ends failed", afterToolRecord.status === "failed", afterToolRecord.status);
	check("tool-call failure keeps the provider text", afterToolRecord.lastError === "Request timed out", afterToolRecord.lastError);
	await afterTool.close();

	const authSessions: FakeSession[] = [];
	const auth = makeManager(config, authSessions, false, undefined, undefined, (session) => {
		session.errorMessage = "401 invalid api key";
	});
	await auth.init();
	const authRecord = await auth.start({ task: "call the model", isolation: "shared", wait: true, waitTimeoutMs: 5_000 });
	check("non-transient error is not retried", authRecord.attempts === 1, authRecord.attempts);
	check("non-transient error sent one prompt", authSessions[0]?.prompts.length === 1, authSessions[0]?.prompts.length);
	check("auth error text is kept", authRecord.lastError?.includes("401 invalid api key") === true, authRecord.lastError);
	check("auth failure has no retry suffix", authRecord.lastError === "401 invalid api key", authRecord.lastError);
	await auth.close();
}

section("provider retries: disabled and stopped");
{
	const config = makeConfig(root, { providerRetries: 0 });
	const sessions: FakeSession[] = [];
	const manager = makeManager(config, sessions, false, undefined, undefined, (session) => {
		session.errorMessage = "Request timed out";
	});
	await manager.init();
	const record = await manager.start({ task: "no retries configured", isolation: "shared", wait: true, waitTimeoutMs: 5_000 });
	check("providerRetries 0 disables retries", record.attempts === 1 && sessions[0]?.prompts.length === 1, record.attempts);
	check("disabled retry still fails", record.status === "failed", record.status);
	await manager.close();
}
{
	// A long backoff makes the stop land while the run is waiting to retry.
	const config = makeConfig(root, { providerRetryDelayMs: 30_000 });
	const sessions: FakeSession[] = [];
	const manager = makeManager(config, sessions, false, undefined, undefined, (session) => {
		session.failureQueue.push("Request timed out");
	});
	await manager.init();
	const record = await manager.start({ task: "back off for a while", isolation: "shared" });
	// Wait until the first attempt failed; the run is then parked in its backoff.
	const deadline = Date.now() + 2_000;
	while ((sessions[0]?.prompts.length ?? 0) === 0 && Date.now() < deadline) await sleep(10);
	await sleep(50);
	check("run is waiting to retry", sessions[0]?.prompts.length === 1, sessions[0]?.prompts.length);
	const stopStartedAt = Date.now();
	const stopped = await manager.stop(record.id);
	const stopElapsed = Date.now() - stopStartedAt;
	check("stop during backoff returns immediately", stopElapsed < 2_000, stopElapsed);
	check("stop during backoff marks the worker stopped", stopped.status === "stopped", stopped.status);
	check("stop during backoff records the abort reason", stopped.abortReason === "stop", stopped.abortReason);
	check("stop during backoff never retries", sessions[0]?.prompts.length === 1, sessions[0]?.prompts.length);
	check("stopped run reports one attempt", stopped.attempts === 1, stopped.attempts);
	await manager.close();
}

fs.rmSync(root, { recursive: true, force: true });
process.stdout.write(`\n${failures === 0 ? "worker tests passed" : `${failures} worker test(s) failed`}\n`);
if (failures > 0) process.exitCode = 1;
