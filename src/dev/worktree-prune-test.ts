/**
 * Worktree prune/retention test (#220):
 *
 *   npx tsx src/dev/worktree-prune-test.ts
 *
 * Filesystem + local bare-remote fixtures only: no model, network, or home
 * directory dependency.
 */
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { loadConfig, type LoadedConfig } from "../config.js";
import { main } from "../cli.js";
import { DEFAULT_SANDBOX_CONFIG } from "../sandbox/config.js";
import { Logger } from "../log.js";
import { EventStore } from "../store/events.js";
import { DEFAULT_WORKERS_CONFIG, validateWorkersConfig } from "../workers/config.js";
import { WorkerManager } from "../workers/manager.js";
import type { WorkerSession, WorkerSessionFactory } from "../workers/session.js";
import { WorkerStore, worktreesRoot, type WorkerRecord, type WorkerStatus } from "../workers/store.js";
import { createWorktree } from "../workers/worktree.js";
import { createHostWorkerEnvironment } from "../workers/environment.js";
import {
	DEFAULT_WORKTREE_KEEP,
	measureWorktrees,
	pruneWorkerWorktrees,
} from "../workers/prune.js";
import { WORKTREE_KEPT_DIRTY, worktreeAfterPullRequest } from "../workers/worktree.js";

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

const DAY_MS = 24 * 60 * 60_000;
const git = (cwd: string, args: string[]): string =>
	execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();

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
				maxConcurrent: 4,
				idleTimeoutMs: 20_000,
				maxRuntimeMs: 30_000,
				providerRetries: 0,
				providerRetryDelayMs: 1,
				repository: ".",
				worktreesDirectory: "",
				baseRef: "",
				remote: "origin",
				notifyOnFinish: false,
				keepWorktreeAfterPr: false,
				...overrides,
			},
		},
	});
}

interface Fixture {
	root: string;
	config: LoadedConfig;
	env: ReturnType<typeof createHostWorkerEnvironment>;
	worktrees: string;
}

function fixture(label: string): Fixture {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), `alive-worktree-prune-${label}-`));
	git(root, ["init"]);
	git(root, ["config", "user.email", "worktree-prune-test@example.com"]);
	git(root, ["config", "user.name", "Worktree Prune Test"]);
	fs.writeFileSync(path.join(root, ".gitignore"), ".alive/\n.env\n");
	fs.writeFileSync(path.join(root, "README.md"), "hello\n");
	git(root, ["add", ".gitignore", "README.md"]);
	git(root, ["commit", "-m", "initial"]);
	const config = makeConfig(root);
	const env = createHostWorkerEnvironment(root);
	return {
		root,
		config,
		env,
		worktrees: worktreesRoot(config.paths, config.config.workers.worktreesDirectory),
	};
}

async function addWorktree(fx: Fixture, id: string): Promise<string> {
	const worktreePath = path.join(fx.worktrees, id);
	await createWorktree(fx.env, {
		repositoryPath: fx.root,
		worktreePath,
		branch: `alive/${id}`,
		baseRef: "HEAD",
	});
	return worktreePath;
}

function age(directory: string, days: number): void {
	// `fs.utimesSync` takes seconds, not milliseconds.
	const timestamp = Math.floor((Date.now() - days * DAY_MS) / 1000);
	fs.utimesSync(directory, timestamp, timestamp);
}

function savedRecord(fx: Fixture, id: string, status: WorkerStatus, workspacePath: string): WorkerRecord {
	const now = Date.now();
	const record: WorkerRecord = {
		version: 1,
		id,
		createdAt: now,
		updatedAt: now,
		status,
		task: "fixture",
		model: "fake/model",
		tools: ["read"],
		isolation: "worktree",
		repositoryPath: fx.root,
		workspacePath,
		branch: `alive/${id}`,
		runs: 0,
		notifyOnFinish: false,
	};
	new WorkerStore(fx.config.paths).save(record);
	return record;
}

class FakeSession implements WorkerSession {
	readonly sessionFile: string;
	isStreaming = false;
	private lastText: string | undefined;

	constructor(sessionFile?: string) {
		this.sessionFile = sessionFile ?? "/tmp/fake-worktree-prune-session.jsonl";
	}

	async prompt(text: string): Promise<void> {
		this.lastText = `completed: ${text.split("\n")[0] ?? "task"}`;
	}

	subscribe(_listener: (event: { type: string; [key: string]: unknown }) => void): () => void {
		return () => undefined;
	}

	async abort(): Promise<void> {
		// Nothing to abort in the fake.
	}

	dispose(): void {
		// Nothing to dispose.
	}

	getLastAssistantText(): string | undefined {
		return this.lastText;
	}

	getSessionStats() {
		return { tokens: { input: 10, output: 20, total: 30 }, cost: 0 };
	}
}

function makeManager(config: LoadedConfig): WorkerManager {
	const factory: WorkerSessionFactory = async (input) => new FakeSession(input.sessionFile);
	return new WorkerManager({
		config,
		events: EventStore.open(config.paths.stateDir),
		log: new Logger({ console: false, level: "error", scope: "worktree-prune-test" }),
		sessionFactory: factory,
	});
}

section("prune keeps the newest N and leaves branches alone");
{
	const fx = fixture("keep");
	const older = await addWorktree(fx, "wrk_older");
	const middle = await addWorktree(fx, "wrk_middle");
	const newest = await addWorktree(fx, "wrk_newest");
	age(older, 3);
	age(middle, 2);
	age(newest, 1);
	const result = await pruneWorkerWorktrees({
		root: fx.worktrees,
		environment: fx.env,
		records: [],
		keep: 1,
	});
	check("oldest worktree removed", !fs.existsSync(older));
	check("middle worktree removed", !fs.existsSync(middle));
	check("newest worktree kept", fs.existsSync(newest));
	check("scanned all three", result.scanned === 3, result);
	check("removed counter", result.removed === 2, result);
	check("skipped counter", result.skipped === 1 && result.skippedByReason.recent === 1, result);
	check("freed bytes counted", result.freedBytes > 0, result.freedBytes);
	check("removed branch kept", git(fx.root, ["branch", "--list", "alive/wrk_older"]).includes("alive/wrk_older"));
	fs.rmSync(fx.root, { recursive: true, force: true });
}

section("active and interrupted workers are never pruned");
{
	const fx = fixture("active");
	const running = await addWorktree(fx, "wrk_running");
	const interrupted = await addWorktree(fx, "wrk_interrupted");
	const stale = await addWorktree(fx, "wrk_stale");
	age(running, 5);
	age(interrupted, 4);
	age(stale, 3);
	savedRecord(fx, "wrk_running", "running", running);
	savedRecord(fx, "wrk_interrupted", "interrupted", interrupted);
	const result = await pruneWorkerWorktrees({
		root: fx.worktrees,
		environment: fx.env,
		records: new WorkerStore(fx.config.paths).list(),
		keep: 0,
	});
	check("running worker worktree kept", fs.existsSync(running));
	check("interrupted worker worktree kept", fs.existsSync(interrupted));
	check("stale worktree removed", !fs.existsSync(stale));
	check("status protected both active records", result.skippedByReason.active === 2, result);
	check("stale counted as removed", result.removed === 1, result);
	fs.rmSync(fx.root, { recursive: true, force: true });
}

section("dirty worktrees are skipped with reason dirty");
{
	const fx = fixture("dirty");
	const clean = await addWorktree(fx, "wrk_clean");
	const dirty = await addWorktree(fx, "wrk_dirty");
	age(clean, 2);
	age(dirty, 1);
	fs.writeFileSync(path.join(dirty, "README.md"), "uncommitted change\n");
	const result = await pruneWorkerWorktrees({
		root: fx.worktrees,
		environment: fx.env,
		records: [],
		keep: 0,
	});
	check("dirty worktree kept", fs.existsSync(dirty));
	check("clean worktree removed", !fs.existsSync(clean));
	check("dirty reason reported", result.skippedByReason.dirty === 1, result);
	check("dirty entry says dirty", result.entries.some((entry) => entry.name === "wrk_dirty" && entry.reason === "dirty"), result.entries);
	fs.rmSync(fx.root, { recursive: true, force: true });
}

section("dry-run reports without deleting");
{
	const fx = fixture("dry-run");
	const first = await addWorktree(fx, "wrk_first");
	const second = await addWorktree(fx, "wrk_second");
	age(first, 2);
	age(second, 1);
	const result = await pruneWorkerWorktrees({
		root: fx.worktrees,
		environment: fx.env,
		records: [],
		keep: 0,
		dryRun: true,
	});
	check("dry-run keeps first worktree", fs.existsSync(first));
	check("dry-run keeps second worktree", fs.existsSync(second));
	check("dry-run marks the command", result.dryRun === true, result);
	check("dry-run counts would-be removals", result.removed === 2, result);
	check("dry-run counts would-be freed bytes", result.freedBytes > 0, result.freedBytes);

	// The same call with --json must be a stable, serializable structure.
	const json = JSON.parse(JSON.stringify(result)) as Record<string, unknown>;
	check("json has root and flags", typeof json.root === "string" && json.dryRun === true && json.keep === 0, json);
	check("json has counters", json.scanned === 2 && json.removed === 2 && json.skipped === 0, json);
	check("json has freed bytes", typeof json.freedBytes === "number" && json.freedBytes > 0, json.freedBytes);
	check("json has entries list", Array.isArray(json.entries) && json.entries.length === 2, json.entries);
	check(
		"json has all skip reasons",
		Object.keys(json.skippedByReason as object).sort().join(",") === "active,dirty,error,recent,younger",
		json.skippedByReason,
	);
	fs.rmSync(fx.root, { recursive: true, force: true });
}

section("CLI --json emits a stable machine-readable result");
{
	const fx = fixture("cli-json");
	await addWorktree(fx, "wrk_cli");
	fs.writeFileSync(
		path.join(fx.root, "alive.config.json"),
		`${JSON.stringify({
			name: "Worktree Prune CLI Test",
			sandbox: { enabled: false },
			workers: {
				enabled: true,
				permissions: { spawn: true, send: true, stop: true, inspect: true, worktree: true, pullRequest: true },
				models: ["fake/model"],
				defaultModel: "fake/model",
				repository: ".",
			},
		}, null, 2)}\n`,
	);
	const previousCwd = process.cwd();
	const chunks: string[] = [];
	const originalWrite = process.stdout.write;
	process.stdout.write = ((chunk: unknown) => {
		chunks.push(String(chunk));
		return true;
	}) as typeof process.stdout.write;
	let code = 1;
	try {
		process.chdir(fx.root);
		code = await main(["workers", "prune", "--keep", "0", "--dry-run", "--json"]);
	} finally {
		process.chdir(previousCwd);
		process.stdout.write = originalWrite;
	}
	check("CLI prune exits 0", code === 0, code);
	const output = chunks.join("");
	const parsed = JSON.parse(output) as Record<string, unknown>;
	check("CLI --json is valid JSON", typeof parsed.root === "string", output.slice(0, 200));
	check("CLI --json preserves dryRun/keep", parsed.dryRun === true && parsed.keep === 0, parsed);
	check("CLI --json has entries and counters", Array.isArray(parsed.entries) && parsed.scanned === 1 && parsed.removed === 1, parsed);
	check("CLI --json has freedBytes", typeof parsed.freedBytes === "number" && parsed.freedBytes > 0, parsed.freedBytes);
	fs.rmSync(fx.root, { recursive: true, force: true });
}

section("older-than-days retention");
{
	const fx = fixture("older-than");
	const old = await addWorktree(fx, "wrk_old");
	const young = await addWorktree(fx, "wrk_young");
	age(old, 10);
	age(young, 1);
	const result = await pruneWorkerWorktrees({
		root: fx.worktrees,
		environment: fx.env,
		records: [],
		keep: 0,
		olderThanDays: 7,
	});
	check("old worktree removed", !fs.existsSync(old));
	check("young worktree kept", fs.existsSync(young));
	check("younger reason reported", result.skippedByReason.younger === 1, result);
	fs.rmSync(fx.root, { recursive: true, force: true });
}

section("status size measurement has a time budget");
{
	const fx = fixture("measure");
	await addWorktree(fx, "wrk_size");
	const usage = measureWorktrees(fx.worktrees, { timeoutMs: 10_000 });
	check("measurement counts directories", usage.count === 1, usage);
	check("measurement reports bytes", typeof usage.bytes === "number" && usage.bytes > 0, usage);
	check("measurement completes", usage.complete === true, usage);
	const timedOut = measureWorktrees(fx.worktrees, {
		timeoutMs: 5,
		now: (() => {
			let tick = 0;
			return () => {
				tick += 10;
				return tick;
			};
		})(),
	});
	check("timed out measurement returns null bytes", timedOut.bytes === null && timedOut.complete === false, timedOut);
	fs.rmSync(fx.root, { recursive: true, force: true });
}

section("config and post-PR retention decision");
{
	check("keepWorktreeAfterPr defaults to false", DEFAULT_WORKERS_CONFIG.keepWorktreeAfterPr === false);
	check("DEFAULT keep count is 5", DEFAULT_WORKTREE_KEEP === 5);
	const enabled = validateWorkersConfig({ ...DEFAULT_WORKERS_CONFIG, keepWorktreeAfterPr: true });
	check("keepWorktreeAfterPr is accepted", enabled.keepWorktreeAfterPr === true);
	let rejected = false;
	try {
		validateWorkersConfig({ ...DEFAULT_WORKERS_CONFIG, keepWorktreeAfterPr: "yes" as unknown as boolean });
	} catch {
		rejected = true;
	}
	check("keepWorktreeAfterPr rejects non-booleans", rejected);

	const clean = worktreeAfterPullRequest({ keepWorktree: false, clean: true });
	check("clean worktree is removed by default", clean.remove === true && clean.warning === undefined, clean);
	const dirty = worktreeAfterPullRequest({ keepWorktree: false, clean: false });
	check("dirty worktree is kept with a warning", dirty.remove === false && dirty.warning === WORKTREE_KEPT_DIRTY, dirty);
	const configured = worktreeAfterPullRequest({ keepWorktree: true, clean: true });
	check("config can keep a clean worktree", configured.remove === false && configured.warning === undefined, configured);
	const unknown = worktreeAfterPullRequest({ keepWorktree: false, clean: undefined });
	check("unknown state is never deleted", unknown.remove === false && Boolean(unknown.warning), unknown);
}

section("successful PR removes a clean worktree and keeps the branch");
{
	const fx = fixture("pr");
	const remote = path.join(os.tmpdir(), `alive-worktree-prune-remote-${Date.now()}.git`);
	execFileSync("git", ["init", "--bare", remote], { stdio: "ignore" });
	git(fx.root, ["remote", "add", "origin", remote]);
	git(fx.root, ["push", "-u", "origin", "HEAD"]);
	const bin = fs.mkdtempSync(path.join(os.tmpdir(), "alive-worktree-prune-gh-"));
	const fakeGh = path.join(bin, "gh");
	fs.writeFileSync(fakeGh, [
		"#!/bin/sh",
		'if [ "$1" = "--version" ]; then echo "gh version 0.0.0 (fake)"; exit 0; fi',
		'if [ "$1 $2" = "pr create" ]; then echo "https://example.test/alive/pull/220"; exit 0; fi',
		'if [ "$1 $2" = "pr view" ]; then echo \'{"url":"https://example.test/alive/pull/220"}\'; exit 0; fi',
		"exit 1",
		"",
	].join("\n"));
	fs.chmodSync(fakeGh, 0o755);
	const originalPath = process.env.PATH;
	process.env.PATH = `${bin}:${originalPath ?? ""}`;
	try {
		const manager = makeManager(fx.config);
		await manager.init();
		const record = await manager.start({ task: "publish a feature", isolation: "worktree", wait: true, waitTimeoutMs: 5_000 });
		fs.writeFileSync(path.join(record.workspacePath, "FEATURE.md"), "feature\n");
		const published = await manager.createPullRequest(record.id, {
			title: "Add a feature",
			commitMessage: "Add feature",
		});
		check("PR returns no warning for a clean worktree", published.warning === undefined, published);
		check("clean worktree removed after PR", !fs.existsSync(record.workspacePath), record.workspacePath);
		check("branch kept after PR", git(fx.root, ["branch", "--list", record.branch!]).includes(record.branch!));
		check("worker record kept", new WorkerStore(fx.config.paths).load(record.id) !== undefined);
		check("PR url persisted", new WorkerStore(fx.config.paths).load(record.id)?.pullRequestUrl === published.url);

		// Follow-up stays possible: the missing worktree is reattached from the
		// branch retained in the repository.
		const resumed = await manager.send(record.id, "continue after publish", { wait: true, waitTimeoutMs: 5_000 });
		check("follow-up reattached the worktree", resumed.status === "idle" && fs.existsSync(record.workspacePath), resumed.status);
		await manager.remove(record.id, { force: true });
		await manager.close();
	} finally {
		process.env.PATH = originalPath;
		fs.rmSync(bin, { recursive: true, force: true });
		fs.rmSync(remote, { recursive: true, force: true });
		fs.rmSync(fx.root, { recursive: true, force: true });
	}
}

section("config keepWorktreeAfterPr keeps the worktree after a successful PR");
{
	const fx = fixture("pr-keep");
	const remote = path.join(os.tmpdir(), `alive-worktree-prune-remote-keep-${Date.now()}.git`);
	execFileSync("git", ["init", "--bare", remote], { stdio: "ignore" });
	git(fx.root, ["remote", "add", "origin", remote]);
	git(fx.root, ["push", "-u", "origin", "HEAD"]);
	const bin = fs.mkdtempSync(path.join(os.tmpdir(), "alive-worktree-prune-gh-keep-"));
	const fakeGh = path.join(bin, "gh");
	fs.writeFileSync(fakeGh, [
		"#!/bin/sh",
		'if [ "$1" = "--version" ]; then echo "gh version 0.0.0 (fake)"; exit 0; fi',
		'if [ "$1 $2" = "pr create" ]; then echo "https://example.test/alive/pull/221"; exit 0; fi',
		'if [ "$1 $2" = "pr view" ]; then echo \'{"url":"https://example.test/alive/pull/221"}\'; exit 0; fi',
		"exit 1",
		"",
	].join("\n"));
	fs.chmodSync(fakeGh, 0o755);
	const originalPath = process.env.PATH;
	process.env.PATH = `${bin}:${originalPath ?? ""}`;
	try {
		const manager = makeManager(makeConfig(fx.root, { keepWorktreeAfterPr: true }));
		await manager.init();
		const record = await manager.start({ task: "publish and keep the worktree", isolation: "worktree", wait: true, waitTimeoutMs: 5_000 });
		fs.writeFileSync(path.join(record.workspacePath, "KEPT.md"), "kept\n");
		const published = await manager.createPullRequest(record.id, { title: "Keep worktree", commitMessage: "Keep worktree" });
		check("configured retention keeps the worktree", fs.existsSync(record.workspacePath), record.workspacePath);
		check("configured retention has no warning", published.warning === undefined, published);
		await manager.remove(record.id, { force: true });
		await manager.close();
	} finally {
		process.env.PATH = originalPath;
		fs.rmSync(bin, { recursive: true, force: true });
		fs.rmSync(remote, { recursive: true, force: true });
		fs.rmSync(fx.root, { recursive: true, force: true });
	}
}

process.stdout.write(`\n${failures === 0 ? "worktree prune tests passed" : `${failures} worktree prune test(s) failed`}\n`);
if (failures > 0) process.exitCode = 1;
