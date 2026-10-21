import { validateWorkerBranch } from "./config.js";
import type { WorkerEnvironment } from "./environment.js";

const GIT_TIMEOUT_MS = 120_000;
const PR_TIMEOUT_MS = 180_000;

export interface GitState {
	/** Current branch name, or undefined for a detached HEAD. */
	branch?: string;
	head?: string;
	clean: boolean;
	/** `git status --porcelain` lines, capped. */
	changed: string[];
}

export interface WorktreeOptions {
	repositoryPath: string;
	worktreePath: string;
	branch: string;
	baseRef?: string;
}

export interface PullRequestWorktreeOptions {
	repositoryPath: string;
	worktreePath: string;
	branch: string;
	number: number;
	remote: string;
}

export interface CreatePullRequestOptions {
	title: string;
	body?: string;
	baseBranch?: string;
	draft?: boolean;
	branch: string;
}

export interface PullRequestResult {
	url: string;
	branch: string;
	head?: string;
}

export async function runGit(
	env: WorkerEnvironment,
	cwd: string,
	args: string[],
	options: { timeoutMs?: number } = {},
): Promise<{ stdout: string; stderr: string }> {
	return env.run(["git", ...args], cwd, { timeoutMs: options.timeoutMs ?? GIT_TIMEOUT_MS });
}

export async function isGitRepository(env: WorkerEnvironment, directory: string): Promise<boolean> {
	if (!(await env.exists(directory))) return false;
	try {
		const { stdout } = await runGit(env, directory, ["rev-parse", "--is-inside-work-tree"]);
		return stdout.trim() === "true";
	} catch {
		return false;
	}
}

export async function repositoryHead(env: WorkerEnvironment, directory: string): Promise<string | undefined> {
	try {
		const { stdout } = await runGit(env, directory, ["rev-parse", "HEAD"]);
		return stdout.trim() || undefined;
	} catch {
		return undefined;
	}
}

export async function branchExists(env: WorkerEnvironment, repositoryPath: string, branch: string): Promise<boolean> {
	try {
		await runGit(env, repositoryPath, ["show-ref", "--verify", "--quiet", `refs/heads/${validateWorkerBranch(branch)}`]);
		return true;
	} catch {
		return false;
	}
}

/** Reattach an existing worker branch after its worktree was removed manually. */
export async function attachWorktree(
	env: WorkerEnvironment,
	repositoryPath: string,
	worktreePath: string,
	branch: string,
): Promise<void> {
	if (await env.exists(worktreePath)) throw new Error(`worktree path already exists: ${worktreePath}`);
	await env.mkdirp(env.dirname(worktreePath));
	await runGit(env, repositoryPath, ["worktree", "add", worktreePath, validateWorkerBranch(branch)]);
}

export async function createWorktree(env: WorkerEnvironment, options: WorktreeOptions): Promise<void> {
	const branch = validateWorkerBranch(options.branch);
	if (await env.exists(options.worktreePath)) throw new Error(`worktree path already exists: ${options.worktreePath}`);
	await env.mkdirp(env.dirname(options.worktreePath));
	// --no-track: a worker branch must not accidentally push back to the base
	// branch. The worker PR flow pushes explicitly with --set-upstream.
	await runGit(env, options.repositoryPath, [
		"worktree", "add", "--no-track", "-b", branch, options.worktreePath, options.baseRef?.trim() || "HEAD",
	]);
}

export async function createPullRequestWorktree(env: WorkerEnvironment, options: PullRequestWorktreeOptions): Promise<void> {
	if (!Number.isSafeInteger(options.number) || options.number < 1) throw new Error("pull request number must be a positive integer");
	const branch = validateWorkerBranch(options.branch);
	if (await env.exists(options.worktreePath)) throw new Error(`worktree path already exists: ${options.worktreePath}`);
	await env.mkdirp(env.dirname(options.worktreePath));
	// Read-only checkout of a PR head. The worker's own commits will live on a
	// local branch and can be pushed only by the explicit `pr` action.
	await runGit(env, options.repositoryPath, ["fetch", options.remote, `refs/pull/${options.number}/head:refs/heads/${branch}`]);
	await runGit(env, options.repositoryPath, ["worktree", "add", options.worktreePath, branch]);
}

export async function listWorktrees(env: WorkerEnvironment, repositoryPath: string): Promise<Array<{ path: string; branch?: string }>> {
	const { stdout } = await runGit(env, repositoryPath, ["worktree", "list", "--porcelain"]);
	const entries: Array<{ path: string; branch?: string }> = [];
	let current: { path: string; branch?: string } | undefined;
	for (const line of stdout.split("\n")) {
		if (line.startsWith("worktree ")) {
			if (current) entries.push(current);
			current = { path: line.slice("worktree ".length) };
		} else if (line.startsWith("branch ") && current) {
			current.branch = line.slice("branch ".length).replace(/^refs\/heads\//, "");
		}
	}
	if (current) entries.push(current);
	return entries;
}

export async function removeWorktree(
	env: WorkerEnvironment,
	repositoryPath: string,
	worktreePath: string,
	options: { force?: boolean } = {},
): Promise<void> {
	const registered = (await listWorktrees(env, repositoryPath)).some((entry) => env.resolve(entry.path) === env.resolve(worktreePath));
	if (!registered) {
		if (await env.exists(worktreePath)) {
			throw new Error(
				`${worktreePath} exists but is not a registered git worktree of ${repositoryPath}; refusing to delete it automatically`,
			);
		}
		await runGit(env, repositoryPath, ["worktree", "prune"]).catch(() => undefined);
		return;
	}
	await runGit(env, repositoryPath, ["worktree", "remove", ...(options.force ? ["--force"] : []), worktreePath]);
	await runGit(env, repositoryPath, ["worktree", "prune"]).catch(() => undefined);
}

export async function gitState(env: WorkerEnvironment, directory: string): Promise<GitState> {
	const [{ stdout: status }, head] = await Promise.all([
		runGit(env, directory, ["status", "--porcelain=v1", "--untracked-files=all"]),
		repositoryHead(env, directory),
	]);
	let branch: string | undefined;
	try {
		const { stdout } = await runGit(env, directory, ["rev-parse", "--abbrev-ref", "HEAD"]);
		branch = stdout.trim() === "HEAD" ? undefined : stdout.trim();
	} catch {
		branch = undefined;
	}
	const changed = status
		.split("\n")
		.map((line) => line.trimEnd())
		.filter(Boolean)
		.slice(0, 200);
	return { branch, head, clean: changed.length === 0, changed };
}

export interface DiffOptions {
	baseCommit?: string;
	full?: boolean;
}

/**
 * Diff of a worker workspace relative to its starting commit. Untracked files
 * are reported by `git status` but not in `git diff`; the status block makes
 * that explicit instead of silently hiding new files.
 */
export async function gitDiff(
	env: WorkerEnvironment,
	directory: string,
	options: DiffOptions = {},
): Promise<{ state: GitState; stat: string; patch?: string }> {
	const state = await gitState(env, directory);
	const base = options.baseCommit?.trim();
	const range = base ? [base] : [];
	const stat = (await runGit(env, directory, ["diff", "--stat", ...range])).stdout.trim();
	const patch = options.full ? (await runGit(env, directory, ["diff", ...range])).stdout : undefined;
	return { state, stat, patch };
}

export async function commitAll(env: WorkerEnvironment, directory: string, message: string): Promise<string> {
	if (!message.trim()) throw new Error("commit message cannot be empty");
	const state = await gitState(env, directory);
	if (state.clean) throw new Error("nothing to commit in the worker workspace");
	await runGit(env, directory, ["add", "-A"]);
	await runGit(env, directory, ["commit", "-m", message.trim()]);
	const { stdout } = await runGit(env, directory, ["rev-parse", "HEAD"]);
	return stdout.trim();
}

export async function pushBranch(env: WorkerEnvironment, directory: string, remote: string, branch: string): Promise<void> {
	await runGit(env, directory, ["push", "--set-upstream", remote, branch], { timeoutMs: PR_TIMEOUT_MS });
}

export async function hasGitHubCli(env: WorkerEnvironment, cwd: string): Promise<boolean> {
	try {
		await env.run(["gh", "--version"], cwd, { timeoutMs: 10_000 });
		return true;
	} catch {
		return false;
	}
}

function extractUrl(output: string): string | undefined {
	return output.match(/https?:\/\/[^\s]+/)?.[0];
}

async function existingPullRequestUrl(env: WorkerEnvironment, directory: string, branch: string): Promise<string | undefined> {
	try {
		const { stdout } = await env.run(["gh", "pr", "view", branch, "--json", "url"], directory, { timeoutMs: 30_000 });
		const parsed = JSON.parse(stdout) as { url?: unknown };
		return typeof parsed.url === "string" ? parsed.url : undefined;
	} catch {
		return undefined;
	}
}

export async function createPullRequest(
	env: WorkerEnvironment,
	directory: string,
	options: CreatePullRequestOptions,
): Promise<PullRequestResult> {
	if (!(await hasGitHubCli(env, directory))) {
		throw new Error("the GitHub CLI (`gh`) is not available in this worker environment; install it there or create the pull request manually after pushing the branch");
	}
	const branch = validateWorkerBranch(options.branch);
	const args = ["pr", "create", "--head", branch, "--title", options.title.trim()];
	if (options.body?.trim()) args.push("--body", options.body.trim());
	if (options.baseBranch?.trim()) args.push("--base", options.baseBranch.trim());
	if (options.draft) args.push("--draft");
	let stdout = "";
	try {
		stdout = (await env.run(["gh", ...args], directory, { timeoutMs: PR_TIMEOUT_MS })).stdout;
	} catch (error) {
		const text = error instanceof Error ? error.message : String(error);
		const existing = /already exists/i.test(text) ? await existingPullRequestUrl(env, directory, branch) : undefined;
		if (existing) return { url: existing, branch, head: await repositoryHead(env, directory) };
		throw error;
	}
	const url = extractUrl(stdout) ?? (await existingPullRequestUrl(env, directory, branch));
	if (!url) throw new Error(`gh pr create succeeded but no pull request URL was returned: ${stdout.trim().slice(0, 1000)}`);
	return { url, branch, head: await repositoryHead(env, directory) };
}

/** Convert a configured base ref into the branch name expected by `gh --base`. */
export function baseBranchName(baseRef: string): string | undefined {
	const value = baseRef.trim();
	if (!value || value === "HEAD") return undefined;
	if (value.startsWith("refs/heads/")) return value.slice("refs/heads/".length);
	const match = value.match(/^[^/]+\/(.+)$/);
	if (match && /^(origin|upstream)$/.test(value.split("/")[0] ?? "")) return match[1];
	return value;
}
