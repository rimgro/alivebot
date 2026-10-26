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
import { WorkerManager } from "../workers/manager.js";
import type { WorkerSession, WorkerSessionFactory } from "../workers/session.js";
import { WorkerStore } from "../workers/store.js";
import { baseBranchName, createWorktree, gitDiff, removeWorktree } from "../workers/worktree.js";
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
	private lastText: string | undefined;
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
				});
			}
			if (this.errorMessage) {
				const message = { role: "assistant", stopReason: "error", errorMessage: this.errorMessage };
				for (const listener of this.listeners) listener({ type: "turn_end", message, toolResults: [] });
				return;
			}
			if (this.silent) return;
			this.lastText = `completed: ${text.split("\n")[0] ?? "task"}`;
			for (const listener of this.listeners) listener({ type: "turn_start" });
		} finally {
			this.isStreaming = false;
			this.abortReject = undefined;
		}
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
		if (this.silent || this.errorMessage) return { tokens: { input: 0, output: 0, total: 0 }, cost: 0 };
		return { tokens: { input: 11, output: 22, total: 33 }, cost: 0.001 };
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
				maxRuntimeMs: 30_000,
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
fs.writeFileSync(path.join(root, ".gitignore"), ".alive/\n");
fs.writeFileSync(path.join(root, "README.md"), "hello\n");
git(root, ["add", ".gitignore", "README.md"]);
git(root, ["commit", "-m", "initial"]);

section("worker config and model allowlist");
check("workers are disabled by default", DEFAULT_WORKERS_CONFIG.enabled === false);
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
	check("stop disposed the session", sessions[0]?.disposed === true);
	await manager.close();
}

section("timeout aborts a stuck worker");
{
	const config = makeConfig(root);
	config.config.workers.maxRuntimeMs = 80;
	const sessions: FakeSession[] = [];
	const manager = makeManager(config, sessions, true);
	await manager.init();
	const record = await manager.start({ task: "hang forever", isolation: "shared", wait: true, waitTimeoutMs: 2_000 });
	check("timeout marks the worker failed", record.status === "failed", record.status);
	check("timeout reason is stored", record.lastError?.includes("exceeded") === true, record.lastError);
	check("timed out session was disposed", sessions[0]?.disposed === true);
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

fs.rmSync(root, { recursive: true, force: true });
process.stdout.write(`\n${failures === 0 ? "worker tests passed" : `${failures} worker test(s) failed`}\n`);
if (failures > 0) process.exitCode = 1;
