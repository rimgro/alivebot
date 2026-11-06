/**
 * Repository integrity test for the pre-push / pre-merge gate (issue #216).
 *
 * The important case is a zero-byte loose object: `git fsck
 * --connectivity-only` skips blob contents and exits 0, so only the explicit
 * `find .git/objects -type f -size 0` scan notices it. The tests below use
 * throwaway repositories and real git/find commands; no network, no model.
 *
 *   npm run test:git-integrity
 */
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { assertRepositoryIntegrity, checkRepositoryIntegrity } from "../git/integrity.js";
import { createHostWorkerEnvironment } from "../workers/environment.js";

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

function git(cwd: string, args: string[], input?: string): string {
	return execFileSync("git", args, { cwd, encoding: "utf8", input, stdio: ["pipe", "pipe", "pipe"] }).trim();
}

function makeRepo(root: string, name: string): string {
	const repo = path.join(root, name);
	fs.mkdirSync(repo, { recursive: true });
	git(repo, ["init", "-q"]);
	git(repo, ["config", "user.name", "Integrity Test"]);
	git(repo, ["config", "user.email", "integrity-test@example.invalid"]);
	return repo;
}

function commitFile(repo: string, relativePath: string, content: string, message: string): void {
	const file = path.join(repo, relativePath);
	fs.mkdirSync(path.dirname(file), { recursive: true });
	fs.writeFileSync(file, content, "utf8");
	git(repo, ["add", "--", relativePath]);
	git(repo, ["commit", "-qm", message]);
}

function looseObjectPath(repo: string, hash: string): string {
	return path.join(repo, ".git", "objects", hash.slice(0, 2), hash.slice(2));
}

function truncateLooseObject(repo: string, hash: string): void {
	const file = looseObjectPath(repo, hash);
	if (!fs.existsSync(file)) throw new Error(`expected a loose object at ${file}`);
	fs.writeFileSync(file, "");
}

function expectAssertThrows(name: string, report: Parameters<typeof assertRepositoryIntegrity>[0], includes: string[]): void {
	try {
		assertRepositoryIntegrity(report);
		check(name, false, "expected assertRepositoryIntegrity to throw");
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		check(name, includes.every((part) => message.includes(part)), message);
	}
}

const root = fs.mkdtempSync(path.join(os.tmpdir(), "alive-git-integrity-test-"));

try {
	section("a healthy repository passes quickly");
	{
		const repo = makeRepo(root, "healthy");
		commitFile(repo, "hello.txt", "hello\n", "initial commit");
		const runner = createHostWorkerEnvironment(repo);
		const startedAt = Date.now();
		const report = await checkRepositoryIntegrity(runner, repo);
		const elapsedMs = Date.now() - startedAt;
		check("fsck is ok", report.fsckOk, report.fsckOutput);
		check("no empty objects", report.emptyObjects.length === 0, report.emptyObjects);
		check("no problems", report.problems.length === 0, report.problems);
		check("nothing blocks", report.blocking.length === 0, report.blocking);
		check("the check finishes in a few seconds", elapsedMs < 15_000, elapsedMs);
		try {
			assertRepositoryIntegrity(report);
			check("assertRepositoryIntegrity accepts a healthy repository", true);
		} catch (error) {
			check("assertRepositoryIntegrity accepts a healthy repository", false, error);
		}
	}

	section("a zero-byte blob in HEAD is caught despite connectivity-only fsck");
	{
		const repo = makeRepo(root, "empty-head-blob");
		commitFile(repo, "hello.txt", "hello\n", "initial commit");
		const blob = git(repo, ["rev-parse", "HEAD:hello.txt"]);
		truncateLooseObject(repo, blob);
		const runner = createHostWorkerEnvironment(repo);
		// Document why the scan exists: connectivity-only does not read blobs.
		const connectivityOnly = execFileSync("git", ["fsck", "--connectivity-only", "--no-progress"], {
			cwd: repo,
			encoding: "utf8",
			stdio: ["ignore", "pipe", "pipe"],
		});
		check("connectivity-only fsck ignores the empty reachable blob", connectivityOnly.trim() === "", connectivityOnly);
		const report = await checkRepositoryIntegrity(runner, repo, { range: "HEAD" });
		check("connectivity-only fsck still reports ok", report.fsckOk, report.fsckOutput);
		check("the scan finds the empty object", report.emptyObjects.includes(blob), report.emptyObjects);
		check(
			"an empty object inside the range blocks",
			report.blocking.some((issue) => issue.objects?.includes(blob)),
			report.blocking,
		);
		expectAssertThrows("assert explains the damage and the sandbox flap", report, [
			"damaged",
			"flap",
			"Rebuild the commit",
		]);
	}

	section("a zero-byte object outside the range is logged, not blocking");
	{
		const repo = makeRepo(root, "empty-outside-range");
		commitFile(repo, "base.txt", "base\n", "initial commit");
		const orphan = git(repo, ["hash-object", "-w", "--stdin"], "orphan contents");
		truncateLooseObject(repo, orphan);
		const runner = createHostWorkerEnvironment(repo);
		const report = await checkRepositoryIntegrity(runner, repo, { range: "HEAD" });
		check("the scan finds the orphan empty object", report.emptyObjects.includes(orphan), report.emptyObjects);
		check(
			"the orphan is reported as a problem",
			report.problems.some((issue) => issue.kind === "empty-object" && issue.objects?.includes(orphan)),
			report.problems,
		);
		check(
			"the orphan does not block a push of HEAD",
			!report.blocking.some((issue) => issue.objects?.includes(orphan)),
			report.blocking,
		);
		try {
			assertRepositoryIntegrity(report);
			check("unrelated zero-byte cruft does not block", true);
		} catch (error) {
			check("unrelated zero-byte cruft does not block", false, error);
		}
	}

	section("a linked worktree checks the shared object store");
	{
		const repo = makeRepo(root, "linked-main");
		commitFile(repo, "base.txt", "base\n", "initial commit");
		const base = git(repo, ["rev-parse", "HEAD"]);
		const worktree = path.join(root, "linked-worktree");
		git(repo, ["worktree", "add", "-q", "-b", "alive/integrity-test", worktree]);
		fs.writeFileSync(path.join(worktree, "feature.txt"), "feature\n", "utf8");
		git(worktree, ["add", "--", "feature.txt"]);
		git(worktree, ["commit", "-qm", "feature commit"]);
		const blob = git(worktree, ["rev-parse", "HEAD:feature.txt"]);
		// Objects live in the main checkout's .git, not in the linked worktree.
		truncateLooseObject(repo, blob);
		const runner = createHostWorkerEnvironment(worktree);
		const report = await checkRepositoryIntegrity(runner, worktree, { range: `${base}..HEAD` });
		check("the shared git dir is resolved", report.gitDir === path.join(repo, ".git"), report.gitDir);
		check("the scan sees the worktree's empty object", report.emptyObjects.includes(blob), report.emptyObjects);
		check(
			"the worktree HEAD range blocks on the empty object",
			report.blocking.some((issue) => issue.objects?.includes(blob)),
			report.blocking,
		);
		expectAssertThrows("a damaged linked worktree cannot be published", report, ["damaged", "flap"]);
	}

	section("a missing tree object fails fsck and blocks");
	{
		const repo = makeRepo(root, "missing-tree");
		commitFile(repo, "dir/file.txt", "hello\n", "initial commit");
		const tree = git(repo, ["rev-parse", "HEAD^{tree}"]);
		fs.rmSync(looseObjectPath(repo, tree));
		const runner = createHostWorkerEnvironment(repo);
		const report = await checkRepositoryIntegrity(runner, repo, { range: "HEAD" });
		check("fsck fails", report.fsckOk === false, report.fsckOutput);
		check("something blocks", report.blocking.length > 0, report.blocking);
		expectAssertThrows("assert rejects a missing tree", report, ["damaged", "flap"]);
	}
} finally {
	fs.rmSync(root, { recursive: true, force: true });
}

process.stdout.write(`\n${failures === 0 ? "git integrity tests passed" : `${failures} git integrity test(s) failed`}\n`);
if (failures > 0) process.exitCode = 1;
