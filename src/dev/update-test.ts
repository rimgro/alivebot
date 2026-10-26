/**
 * Harness update tests (`alive update`).
 *
 * The real command shells out to git and npm and manipulates the checkout, so
 * these tests inject a fake runner and an in-memory filesystem. They assert the
 * exact command sequence, the `.alive-update.json` lifecycle, preservation and
 * restoration of `dist.prev/`, the health gate, explicit rollback and status.
 *
 * No real git, no network, no filesystem access outside this process.
 *
 *   npm run test:update
 */
import * as path from "node:path";
import {
	CommandFailure,
	DIST_DIR,
	DIST_PREV_DIR,
	UPDATE_MARKER_FILE,
	type CommandRunner,
	type RunOptions,
	type RunResult,
	type UpdateDeps,
	type UpdateFileOps,
	type UpdateMarker,
	parseStableTag,
	pickLatestStableTag,
	runUpdate,
} from "../update.js";

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

const ROOT = "/fake/alive";
const MARKER_FILE = path.join(ROOT, UPDATE_MARKER_FILE);
const DIST_FILE = path.join(ROOT, DIST_DIR, "index.js");
const DIST_PREV_FILE = path.join(ROOT, DIST_PREV_DIR, "index.js");

type FakeRef = { kind: "branch"; name: string } | { kind: "tag"; name: string } | { kind: "detached"; name: string };

interface FakeRepoOptions {
	/** Defaults to a branch named "main". */
	start?: FakeRef;
	tags?: string[];
	dirty?: string[];
	isGit?: boolean;
	failFetch?: boolean;
	failCheckout?: boolean;
	/** Simulate git refusing a checkout because local changes would be overwritten. */
	dirtyBlocksCheckout?: boolean;
	failInstall?: boolean;
	/** Return true to make `npm run build` fail for the ref that is checked out. */
	failBuild?: (ref: FakeRef) => boolean;
	/** Return true to make the `node dist/index.js --help` health gate fail. */
	failHealth?: (ref: FakeRef) => boolean;
	/** Files seeded into the in-memory checkout, keyed by repository-relative path. */
	initialFiles?: Record<string, string>;
}

interface FakeCall {
	command: string;
	args: string[];
	cwd?: string;
}

interface FakeEvent {
	type: "command" | "fs";
	description: string;
	/** Absolute path for fs events. */
	path?: string;
	/** Written contents for marker assertions. */
	text?: string;
}

interface FakeFileOps extends UpdateFileOps {
	files: Map<string, string>;
	dirs: Set<string>;
}

interface FakeRepo {
	root: string;
	calls: FakeCall[];
	log: FakeEvent[];
	fs: FakeFileOps;
	run: CommandRunner;
	ref: () => FakeRef;
}

/** In-memory checkout where `dist` is simply a tree of files under a prefix. */
function createFakeFs(log: FakeEvent[], initialFiles: Record<string, string>): FakeFileOps {
	const files = new Map<string, string>();
	const dirs = new Set<string>();
	const absolute = (file: string): string => (path.isAbsolute(file) ? file : path.join(ROOT, file));
	const matches = (candidate: string, target: string): boolean => candidate === target || candidate.startsWith(`${target}/`);

	for (const [file, contents] of Object.entries(initialFiles)) files.set(absolute(file), contents);

	const exists = async (target: string): Promise<boolean> => {
		if (files.has(target) || dirs.has(target)) return true;
		return [...files.keys()].some((file) => matches(file, target)) || [...dirs].some((dir) => matches(dir, target));
	};

	const remove = async (target: string): Promise<void> => {
		log.push({ type: "fs", description: `remove ${target}`, path: target });
		for (const file of [...files.keys()]) if (matches(file, target)) files.delete(file);
		for (const dir of [...dirs]) if (matches(dir, target)) dirs.delete(dir);
	};

	return {
		files,
		dirs,
		readText: async (file) => files.get(file),
		writeText: async (file, text) => {
			files.set(file, text);
			log.push({ type: "fs", description: `write ${file}`, path: file, text });
		},
		exists,
		rename: async (from, to) => {
			const movedFiles = [...files.entries()].filter(([file]) => matches(file, from));
			const movedDirs = [...dirs].filter((dir) => matches(dir, from));
			if (movedFiles.length === 0 && movedDirs.length === 0) {
				throw new Error(`ENOENT: no such file or directory, rename '${from}' -> '${to}'`);
			}
			await remove(to);
			for (const [file, contents] of movedFiles) {
				files.delete(file);
				files.set(to + file.slice(from.length), contents);
			}
			for (const dir of movedDirs) {
				dirs.delete(dir);
				dirs.add(to + dir.slice(from.length));
			}
			dirs.add(to);
			log.push({ type: "fs", description: `rename ${from} -> ${to}`, path: to });
		},
		remove,
	};
}

/** A deterministic in-memory git checkout: tags, one branch, one npm project. */
function createFakeRepo(options: FakeRepoOptions = {}): FakeRepo {
	const tags = options.tags ?? [];
	const dirty = options.dirty ?? [];
	const calls: FakeCall[] = [];
	const log: FakeEvent[] = [];
	const fs = createFakeFs(log, options.initialFiles ?? {});
	let ref: FakeRef = options.start ?? { kind: "branch", name: "main" };
	const commitOf = (value: FakeRef): string => `sha-${value.kind}-${value.name}`;
	const ok = (stdout = ""): RunResult => ({ stdout, stderr: "" });
	const fail = (command: string, args: string[], detail: string): never => {
		throw new CommandFailure(command, args, 1, "", detail);
	};

	const run: CommandRunner = async (command, args, runOptions: RunOptions = {}): Promise<RunResult> => {
		calls.push({ command, args: [...args], cwd: runOptions.cwd });
		log.push({ type: "command", description: `${command} ${args.join(" ")}` });

		if (command === "git") {
			const sub = args[0];
			if (options.isGit === false && sub === "rev-parse") {
				return fail("git", args, "fatal: not a git repository (or any of the parent directories): .git");
			}
			switch (sub) {
				case "rev-parse": {
					if (args.includes("--show-toplevel")) return ok(`${ROOT}\n`);
					if (args.includes("--abbrev-ref")) return ok(`${ref.kind === "branch" ? ref.name : "HEAD"}\n`);
					if (args[1] === "HEAD") return ok(`${commitOf(ref)}\n`);
					return fail("git", args, `unexpected rev-parse: ${args.join(" ")}`);
				}
				case "fetch": {
					if (options.failFetch) return fail("git", args, "fatal: unable to access remote: network is unreachable");
					return ok();
				}
				case "tag":
					return ok(tags.length ? `${tags.join("\n")}\n` : "");
				case "describe": {
					if (ref.kind !== "tag") return fail("git", args, "fatal: no tag exactly matches 'HEAD'");
					return ok(`${ref.name}\n`);
				}
				case "status":
					return ok(dirty.length ? `${dirty.join("\n")}\n` : "");
				case "checkout": {
					const target = args[1];
					if (!target) return fail("git", args, "error: missing checkout target");
					if (args.some((arg) => arg === "-f" || arg === "--force")) {
						throw new Error("the update flow must never force a checkout");
					}
					const alreadyOnTarget = (ref.kind === "branch" || ref.kind === "tag") && ref.name === target;
					if (alreadyOnTarget) return ok();
					if (options.failCheckout) return fail("git", args, "error: checkout refused by test");
					if (dirty.length && options.dirtyBlocksCheckout) {
						return fail("git", args, "error: Your local changes would be overwritten by checkout");
					}
					ref = tags.includes(target) ? { kind: "tag", name: target } : { kind: "branch", name: target };
					return ok();
				}
				default:
					return fail("git", args, `unexpected git command: ${args.join(" ")}`);
			}
		}

		if (command === "npm") {
			if (args[0] === "ci") {
				if (options.failInstall) return fail("npm", args, "npm ERR! `npm ci` failed in the test");
				return ok();
			}
			if (args[0] === "run" && args[1] === "build") {
				if (options.failBuild?.(ref)) return fail("npm", args, "error TS1005: build failed in the test");
				await fs.writeText(DIST_FILE, `build-${ref.kind}-${ref.name}`);
				return ok();
			}
			return fail("npm", args, `unexpected npm command: ${args.join(" ")}`);
		}

		if (command === "node") {
			if (args[0] !== "dist/index.js" || (args[1] !== "--help" && args[1] !== "--version")) {
				return fail("node", args, `unexpected health command: ${args.join(" ")}`);
			}
			if (options.failHealth?.(ref)) return fail("node", args, "health check failed in the test");
			return ok();
		}

		return fail(command, args, `unexpected command: ${command}`);
	};

	return { root: ROOT, calls, log, fs, run, ref: () => ref };
}

interface Harness {
	deps: UpdateDeps;
	out: string[];
	err: string[];
}

function harness(repo: FakeRepo, packageVersion: string | (() => string) = "0.1.0", now = "2024-03-01T12:00:00.000Z"): Harness {
	const out: string[] = [];
	const err: string[] = [];
	return {
		out,
		err,
		deps: {
			run: repo.run,
			fs: repo.fs,
			out: (line) => out.push(line),
			err: (line) => err.push(line),
			readPackageVersion: async () => (typeof packageVersion === "function" ? packageVersion() : packageVersion),
			now: () => now,
		},
	};
}

/** Everything that changes checkout contents/build output, in order. */
function mutations(repo: FakeRepo): string[] {
	return repo.calls
		.filter(
			(call) =>
				call.command === "npm" ||
				call.command === "node" ||
				(call.command === "git" && (call.args[0] === "fetch" || call.args[0] === "checkout")),
		)
		.map((call) => `${call.command} ${call.args.join(" ")}`);
}

function markerWrites(repo: FakeRepo): UpdateMarker[] {
	return repo.log
		.filter((event) => event.type === "fs" && event.path === MARKER_FILE && event.description.startsWith("write "))
		.map((event) => JSON.parse(event.text ?? "{}") as UpdateMarker);
}

function marker(): UpdateMarker {
	return {
		previousRef: "main",
		previousTag: "v0.1.0",
		targetTag: "v0.2.0",
		startedAt: "2024-01-01T00:00:00.000Z",
		finishedAt: "2024-01-01T00:05:00.000Z",
		outcome: "success",
	};
}

function markerContents(overrides: Partial<UpdateMarker> = {}): string {
	return `${JSON.stringify({ ...marker(), ...overrides }, null, 2)}\n`;
}

function lines(value: string[]): string {
	return value.join("\n");
}

function refName(ref: FakeRef): string {
	return `${ref.kind}:${ref.name}`;
}

function firstIndex(repo: FakeRepo, predicate: (event: FakeEvent) => boolean): number {
	return repo.log.findIndex(predicate);
}

const TAGS = ["v0.1.0", "v0.2.0", "v0.3.0-rc.1"];

async function main(): Promise<void> {
	section("stable tag selection");
	check("newest stable tag is chosen numerically", pickLatestStableTag(["v1.2.3", "v1.10.0", "v1.9.9"]) === "v1.10.0", pickLatestStableTag(["v1.2.3", "v1.10.0", "v1.9.9"]));
	check("prereleases are ignored", pickLatestStableTag(["v2.0.0-rc.1", "v2.0.0-beta.2", "v1.9.9"]) === "v1.9.9", pickLatestStableTag(["v2.0.0-rc.1", "v2.0.0-beta.2", "v1.9.9"]));
	check("non-vX.Y.Z refs are ignored", pickLatestStableTag(["1.2.3", "v1.2", "release", "v1.2.3+build"]) === undefined);
	check("parseStableTag accepts v0.1.0", parseStableTag("v0.1.0")?.patch === 0);
	check("parseStableTag rejects a prerelease", parseStableTag("v1.2.3-rc.1") === undefined);

	section("--check is read-only and reports marker/dist");
	{
		const repo = createFakeRepo({
			tags: TAGS,
			initialFiles: {
				[UPDATE_MARKER_FILE]: markerContents(),
				[path.join(DIST_DIR, "index.js")]: "old-build",
			},
		});
		const h = harness(repo);
		const code = await runUpdate({ cwd: `${ROOT}/src`, check: true }, h.deps);
		const output = lines(h.out);
		check("check exits 0", code === 0, code);
		check("reports the branch and commit", output.includes("branch main @ "), h.out);
		check("reports the package version", output.includes("package:    0.1.0"), h.out);
		check("reports the newest stable tag", output.includes("latest stable: v0.2.0"), h.out);
		check("says an update is available", output.includes("update available: yes"), h.out);
		check("suggests the apply command", output.includes("next: alive update"), h.out);
		check("reports the marker outcome", output.includes("outcome:      success"), h.out);
		check("reports the marker previous ref", output.includes("previous ref: main"), h.out);
		check("reports the marker target tag", output.includes("target tag:   v0.2.0"), h.out);
		check("reports marker timestamps", output.includes("started:      2024-01-01T00:00:00.000Z") && output.includes("finished:     2024-01-01T00:05:00.000Z"), h.out);
		check("reports dist presence", output.includes("dist:      present"), h.out);
		check("reports dist.prev absence", output.includes("dist.prev: absent"), h.out);
		check("only fetches tags", mutations(repo).join("|") === "git fetch --tags --quiet origin", mutations(repo));
		check("writes no files", repo.log.every((event) => event.type !== "fs" || event.description.startsWith("remove ")), repo.log);
		check("leaves the marker untouched", repo.fs.files.get(MARKER_FILE) === markerContents(), repo.fs.files.get(MARKER_FILE));
		check(
			"runs in the detected repository root after discovery",
			repo.calls[0]?.cwd === `${ROOT}/src` && repo.calls.slice(1).every((call) => call.cwd === ROOT),
			repo.calls.map((call) => call.cwd),
		);
	}

	section("dirty tree");
	{
		const repo = createFakeRepo({ tags: TAGS, dirty: [" M src/cli.ts", "?? .env"] });
		const h = harness(repo);
		const code = await runUpdate({ cwd: ROOT }, h.deps);
		check("apply refuses a dirty tree without --force", code === 1, code);
		check("error mentions --force", lines(h.err).includes("--force"), h.err);
		check("error names the dirty paths", lines(h.err).includes("src/cli.ts"), h.err);
		check("no checkout/install/build/marker happened", mutations(repo).join("|") === "git fetch --tags --quiet origin", mutations(repo));
		check("no marker was written", markerWrites(repo).length === 0, markerWrites(repo));
		check("the current ref is unchanged", refName(repo.ref()) === "branch:main", refName(repo.ref()));
	}

	section("update artifacts never count as dirty");
	{
		const repo = createFakeRepo({ tags: TAGS, dirty: ["?? .alive-update.json", "?? dist.prev/"] });
		const h = harness(repo);
		const code = await runUpdate({ cwd: ROOT }, h.deps);
		check("marker/dist.prev leftovers do not block apply", code === 0, { code, err: h.err });
		check("the checkout proceeds", mutations(repo).includes("git checkout v0.2.0"), mutations(repo));
	}

	section("successful apply: marker, saved build, health gate");
	{
		const repo = createFakeRepo({
			tags: TAGS,
			initialFiles: {
				[path.join(DIST_DIR, "index.js")]: "old-build",
				[path.join(DIST_PREV_DIR, "index.js")]: "older-build",
			},
		});
		const h = harness(repo, () => (repo.ref().kind === "tag" ? "0.2.0" : "0.1.0"));
		const code = await runUpdate({ cwd: ROOT }, h.deps);
		const output = lines(h.out);
		check("apply exits 0", code === 0, code);
		check(
			"fetches, checks out, installs, builds and health-checks in order",
			mutations(repo).join("|") ===
				[
					"git fetch --tags --quiet origin",
					"git checkout v0.2.0",
					"npm ci --prefer-offline",
					"npm run build",
					"node dist/index.js --help",
				].join("|"),
			mutations(repo),
		);
		check("all commands run in the repository root", repo.calls.every((call) => call.cwd === ROOT), repo.calls.map((call) => call.cwd));
		check("checks out the newest stable tag", refName(repo.ref()) === "tag:v0.2.0", refName(repo.ref()));
		check("prints the new tag and package version", output.includes("updated: v0.2.0 (package 0.2.0; was main)"), h.out);
		check("asks the operator to restart the harness", output.includes("restart required") && output.includes("alive restart"), h.out);
		check("mentions the saved build", output.includes("previous build kept in dist.prev/"), h.out);
		check("never restarts or stops anything", repo.calls.every((call) => /^(git|npm|node)$/.test(call.command)), repo.calls.map((call) => call.command));
		check("never pushes or force-checks out", repo.calls.every((call) => !call.args.includes("push") && !call.args.includes("--force") && !call.args.includes("-f")), repo.calls);
		check("never touches state, config or .env", repo.calls.every((call) => call.args.every((arg) => !/(^|\/)\.env$|\.alive\/|alive\.config\.json/.test(arg))), repo.calls);

		const writes = markerWrites(repo);
		check("marker was written in-progress then finalized as success", writes[0]?.outcome === "in-progress" && writes.at(-1)?.outcome === "success", writes);
		check("success marker records refs and timestamps", writes.at(-1)?.previousRef === "main" && writes.at(-1)?.targetTag === "v0.2.0" && Boolean(writes.at(-1)?.startedAt) && Boolean(writes.at(-1)?.finishedAt), writes.at(-1));
		check("marker has no previousTag on a branch checkout", writes.at(-1)?.previousTag === undefined, writes.at(-1));

		const firstMarkerWrite = firstIndex(repo, (event) => event.type === "fs" && event.path === MARKER_FILE && event.description.startsWith("write "));
		const firstMutation = firstIndex(
			repo,
			(event) =>
				(event.type === "command" && /^(git checkout|npm |node )/.test(event.description)) ||
				(event.type === "fs" && event.path === path.join(ROOT, DIST_PREV_DIR) && event.description.startsWith("rename ")),
		);
		check("marker is written before the first mutating command", firstMarkerWrite >= 0 && firstMutation > firstMarkerWrite, { firstMarkerWrite, firstMutation, log: repo.log });
		check("in-progress marker was actually on disk before the mutation", writes[0]?.outcome === "in-progress", writes[0]);
		check("old build moved to dist.prev", repo.fs.files.get(DIST_PREV_FILE) === "old-build", repo.fs.files.get(DIST_PREV_FILE));
		check("a stale dist.prev is replaced (one generation)", repo.fs.files.get(DIST_PREV_FILE) !== "older-build", repo.fs.files.get(DIST_PREV_FILE));
		check("new build landed in dist", repo.fs.files.get(DIST_FILE) === "build-tag-v0.2.0", repo.fs.files.get(DIST_FILE));
	}

	section("build failure rolls back and rebuilds when no dist was saved");
	{
		const repo = createFakeRepo({ tags: TAGS, failBuild: (ref) => ref.kind === "tag" && ref.name === "v0.2.0" });
		const h = harness(repo);
		const code = await runUpdate({ cwd: ROOT }, h.deps);
		check("exits non-zero", code === 1, code);
		check(
			"restores the previous ref and rebuilds/health-checks it",
			mutations(repo).join("|") ===
				[
					"git fetch --tags --quiet origin",
					"git checkout v0.2.0",
					"npm ci --prefer-offline",
					"npm run build",
					"git checkout main",
					"npm ci --prefer-offline",
					"npm run build",
					"node dist/index.js --help",
				].join("|"),
			mutations(repo),
		);
		check("ends on the previous branch", refName(repo.ref()) === "branch:main", refName(repo.ref()));
		check("reports the original failure", lines(h.err).includes("build failed in the test"), h.err);
		check("reports the rollback and rebuild", lines(h.err).includes("rolling back to main") && lines(h.err).includes("rebuilt"), h.err);
		check("does not claim success", !lines(h.out).includes("updated: v0.2.0") && !lines(h.out).includes("restart required"), h.out);
		const writes = markerWrites(repo);
		check("marker ends rolled-back with a finish time", writes.at(-1)?.outcome === "rolled-back" && Boolean(writes.at(-1)?.finishedAt), writes.at(-1));
		check("a rebuilt dist exists", repo.fs.files.get(DIST_FILE) === "build-branch-main", repo.fs.files.get(DIST_FILE));
	}

	section("build failure restores dist.prev without rebuilding");
	{
		const repo = createFakeRepo({
			tags: TAGS,
			failBuild: (ref) => ref.kind === "tag" && ref.name === "v0.2.0",
			initialFiles: { [path.join(DIST_DIR, "index.js")]: "old-build" },
		});
		const h = harness(repo);
		const code = await runUpdate({ cwd: ROOT }, h.deps);
		check("exits non-zero", code === 1, code);
		check(
			"rolls back ref and stops (no npm after the failure)",
			mutations(repo).join("|") ===
				[
					"git fetch --tags --quiet origin",
					"git checkout v0.2.0",
					"npm ci --prefer-offline",
					"npm run build",
					"git checkout main",
				].join("|"),
			mutations(repo),
		);
		check("dist is restored from dist.prev", repo.fs.files.get(DIST_FILE) === "old-build", repo.fs.files.get(DIST_FILE));
		check("dist.prev was consumed", repo.fs.files.get(DIST_PREV_FILE) === undefined);
		check("marker ends rolled-back", markerWrites(repo).at(-1)?.outcome === "rolled-back", markerWrites(repo));
	}

	section("health-gate failure triggers automatic rollback");
	{
		const repo = createFakeRepo({
			tags: TAGS,
			failHealth: (ref) => ref.kind === "tag" && ref.name === "v0.2.0",
			initialFiles: { [path.join(DIST_DIR, "index.js")]: "old-build" },
		});
		const h = harness(repo);
		const code = await runUpdate({ cwd: ROOT }, h.deps);
		check("exits non-zero", code === 1, code);
		check(
			"health gate runs after the build, then rolls back without reinstalling",
			mutations(repo).join("|") ===
				[
					"git fetch --tags --quiet origin",
					"git checkout v0.2.0",
					"npm ci --prefer-offline",
					"npm run build",
					"node dist/index.js --help",
					"git checkout main",
				].join("|"),
			mutations(repo),
		);
		check("reports the health failure", lines(h.err).includes("health check failed in the test"), h.err);
		check("dist is restored from dist.prev", repo.fs.files.get(DIST_FILE) === "old-build", repo.fs.files.get(DIST_FILE));
		check("marker ends rolled-back", markerWrites(repo).at(-1)?.outcome === "rolled-back", markerWrites(repo));
		check("does not claim success", !lines(h.out).includes("updated: v0.2.0"), h.out);
	}

	section("failed rollback is recorded as failed");
	{
		const repo = createFakeRepo({ tags: TAGS, failBuild: () => true });
		const h = harness(repo);
		const code = await runUpdate({ cwd: ROOT }, h.deps);
		check("exits non-zero", code === 1, code);
		check(
			"attempts to restore and rebuild the previous ref",
			mutations(repo).join("|") ===
				[
					"git fetch --tags --quiet origin",
					"git checkout v0.2.0",
					"npm ci --prefer-offline",
					"npm run build",
					"git checkout main",
					"npm ci --prefer-offline",
					"npm run build",
				].join("|"),
			mutations(repo),
		);
		check("ends on the previous branch even though the rebuild failed", refName(repo.ref()) === "branch:main", refName(repo.ref()));
		check("reports an incomplete rollback", lines(h.err).includes("incomplete"), h.err);
		check("marker ends failed (not rolled-back)", markerWrites(repo).at(-1)?.outcome === "failed", markerWrites(repo));
		check("does not claim success", !lines(h.out).includes("updated: v0.2.0"), h.out);
	}

	section("checkout failure rolls back without rebuilding");
	{
		const repo = createFakeRepo({ tags: TAGS, failCheckout: true });
		const h = harness(repo);
		const code = await runUpdate({ cwd: ROOT }, h.deps);
		check("exits non-zero", code === 1, code);
		check(
			"stops after the failed checkout and restores the previous ref",
			mutations(repo).join("|") === "git fetch --tags --quiet origin|git checkout v0.2.0|git checkout main",
			mutations(repo),
		);
		check("stays on the previous branch", refName(repo.ref()) === "branch:main", refName(repo.ref()));
		check("explains that the previous build is unchanged", lines(h.err).includes("previous build was unchanged"), h.err);
		check("does not reinstall or rebuild", !repo.calls.some((call) => call.command === "npm" || call.command === "node"), repo.calls);
		check("marker ends rolled-back", markerWrites(repo).at(-1)?.outcome === "rolled-back", markerWrites(repo));
	}

	section("dirty tree with --force never force-checks out");
	{
		const repo = createFakeRepo({
			tags: TAGS,
			dirty: [" M src/cli.ts"],
			dirtyBlocksCheckout: true,
		});
		const h = harness(repo);
		const code = await runUpdate({ cwd: ROOT, force: true }, h.deps);
		check("exits non-zero when git refuses the plain checkout", code === 1, code);
		check("warns that local changes are kept", lines(h.err).includes("local changes are never discarded"), h.err);
		check("git refused rather than discarding changes", lines(h.err).includes("would be overwritten"), h.err);
		check("rollback leaves the branch in place", refName(repo.ref()) === "branch:main", refName(repo.ref()));
		check("no forced checkout argument was used", repo.calls.every((call) => !call.args.includes("--force") && !call.args.includes("-f")), repo.calls);
		check("marker ends rolled-back", markerWrites(repo).at(-1)?.outcome === "rolled-back", markerWrites(repo));
	}

	section("--force overrides only the dirty guard");
	{
		const repo = createFakeRepo({ tags: TAGS, dirty: [" M src/cli.ts"] });
		const h = harness(repo);
		const code = await runUpdate({ cwd: ROOT, force: true }, h.deps);
		check("apply proceeds", code === 0, code);
		check("checks out plainly", repo.calls.filter((call) => call.args[0] === "checkout").every((call) => call.args.length === 2), repo.calls);
		check("warns about the dirty tree", lines(h.err).includes("working tree is dirty"), h.err);
		check("marker ends success", markerWrites(repo).at(-1)?.outcome === "success", markerWrites(repo));
	}

	section("--tag override");
	{
		const repo = createFakeRepo({ tags: TAGS });
		const h = harness(repo);
		const code = await runUpdate({ cwd: ROOT, check: true, tag: "v0.1.0" }, h.deps);
		check("check accepts an explicit stable tag", code === 0, code);
		check("reports the requested target", lines(h.out).includes("target: v0.1.0"), h.out);
		check("does not mutate", mutations(repo).join("|") === "git fetch --tags --quiet origin", mutations(repo));
		check("does not write a marker", markerWrites(repo).length === 0, markerWrites(repo));
	}
	{
		const repo = createFakeRepo({ tags: TAGS });
		const h = harness(repo);
		const code = await runUpdate({ cwd: ROOT, check: true, tag: "v0.3.0-rc.1" }, h.deps);
		check("prerelease --tag is rejected", code === 1, code);
		check("error explains stable tags only", lines(h.err).includes("not a stable vX.Y.Z tag"), h.err);
		check("rejected tags write no marker", markerWrites(repo).length === 0);
	}

	section("no stable tags");
	{
		const repo = createFakeRepo({ tags: ["v0.3.0-rc.1", "nightly"] });
		const h = harness(repo);
		const code = await runUpdate({ cwd: ROOT, check: true }, h.deps);
		check("check exits 0", code === 0, code);
		check("reports that nothing is available", lines(h.out).includes("no stable vX.Y.Z tags found on origin"), h.out);
		check("changes nothing", mutations(repo).join("|") === "git fetch --tags --quiet origin", mutations(repo));
		check("writes no marker", markerWrites(repo).length === 0);
	}
	{
		const repo = createFakeRepo({ tags: [] });
		const h = harness(repo);
		const code = await runUpdate({ cwd: ROOT }, h.deps);
		check("apply exits non-zero", code === 1, code);
		check("apply explains there is nothing to update", lines(h.err).includes("no stable vX.Y.Z tags found on origin"), h.err);
		check("apply checks nothing out", !repo.calls.some((call) => call.args[0] === "checkout" || call.command === "npm"), repo.calls);
		check("apply writes no marker", markerWrites(repo).length === 0);
	}

	section("detached HEAD");
	{
		const repo = createFakeRepo({ start: { kind: "detached", name: "deadbeef" }, tags: TAGS });
		const h = harness(repo);
		const checkCode = await runUpdate({ cwd: ROOT, check: true }, h.deps);
		check("check reports the detached commit", checkCode === 0 && lines(h.out).includes("detached @ "), h.out);
	}
	{
		const repo = createFakeRepo({ start: { kind: "detached", name: "deadbeef" }, tags: TAGS });
		const h = harness(repo);
		const code = await runUpdate({ cwd: ROOT }, h.deps);
		check("apply refuses a detached HEAD that is not a tag", code === 1, code);
		check("error points at the detached checkout", lines(h.err).includes("detached HEAD"), h.err);
		check("apply stays detached", refName(repo.ref()) === "detached:deadbeef", refName(repo.ref()));
		check("apply changes nothing beyond fetching", mutations(repo).join("|") === "git fetch --tags --quiet origin", mutations(repo));
		check("apply writes no marker", markerWrites(repo).length === 0);
	}
	{
		const repo = createFakeRepo({ start: { kind: "tag", name: "v0.2.0" }, tags: TAGS });
		const h = harness(repo);
		const code = await runUpdate({ cwd: ROOT }, h.deps);
		check("apply is a no-op when already on the latest tag", code === 0 && lines(h.out).includes("nothing to do"), h.out);
		check("no-op still only fetches", mutations(repo).join("|") === "git fetch --tags --quiet origin", mutations(repo));
		check("no-op writes no marker", markerWrites(repo).length === 0);
	}

	section("not a git checkout / fetch failure");
	{
		const repo = createFakeRepo({ isGit: false });
		const h = harness(repo);
		const code = await runUpdate({ cwd: "/tmp/not-a-repo", check: true }, h.deps);
		check("fails clearly outside a git checkout", code === 1 && lines(h.err).includes("not inside a git checkout"), h.err);
		check("runs no mutating command", mutations(repo).length === 0, mutations(repo));
	}
	{
		const repo = createFakeRepo({ tags: TAGS, failFetch: true });
		const h = harness(repo);
		const code = await runUpdate({ cwd: ROOT, check: true }, h.deps);
		check("fails non-zero when git fetch fails", code === 1, code);
		check("reports the fetch failure", lines(h.err).includes("network is unreachable"), h.err);
		check("checks nothing out", !repo.calls.some((call) => call.args[0] === "checkout" || call.command === "npm"), repo.calls);
		check("fetch failure writes no marker", markerWrites(repo).length === 0);
	}

	section("--rollback restores ref and dist.prev without network");
	{
		const repo = createFakeRepo({
			start: { kind: "tag", name: "v0.2.0" },
			tags: TAGS,
			initialFiles: {
				[UPDATE_MARKER_FILE]: markerContents(),
				[path.join(DIST_DIR, "index.js")]: "new-build",
				[path.join(DIST_PREV_DIR, "index.js")]: "old-build",
			},
		});
		const h = harness(repo);
		const code = await runUpdate({ cwd: ROOT, rollback: true }, h.deps);
		check("rollback exits 0", code === 0, code);
		check("only checks out the previous ref", mutations(repo).join("|") === "git checkout main", mutations(repo));
		check("does not fetch", !repo.calls.some((call) => call.args[0] === "fetch"), repo.calls);
		check("does not install, build or run the health gate", !repo.calls.some((call) => call.command === "npm" || call.command === "node"), repo.calls);
		check("ends on the previous branch", refName(repo.ref()) === "branch:main", refName(repo.ref()));
		check("dist.prev is restored instantly", repo.fs.files.get(DIST_FILE) === "old-build", repo.fs.files.get(DIST_FILE));
		check("dist.prev is consumed", repo.fs.files.get(DIST_PREV_FILE) === undefined);
		const writes = markerWrites(repo);
		check("marker is updated to rolled-back", writes.at(-1)?.outcome === "rolled-back", writes.at(-1));
		check("rollback marker keeps the recorded refs", writes.at(-1)?.previousRef === "main" && writes.at(-1)?.targetTag === "v0.2.0", writes.at(-1));
		check("rollback marker has a finish time", Boolean(writes.at(-1)?.finishedAt), writes.at(-1));
		check("prints what was restored", lines(h.out).includes("rolled back to main") && lines(h.out).includes("no network or rebuild needed"), h.out);
		check("asks for a harness restart", lines(h.out).includes("restart required") && lines(h.out).includes("alive restart"), h.out);
	}

	section("--rollback rebuilds when dist.prev is absent");
	{
		const repo = createFakeRepo({
			start: { kind: "tag", name: "v0.2.0" },
			tags: TAGS,
			initialFiles: {
				[UPDATE_MARKER_FILE]: markerContents(),
				[path.join(DIST_DIR, "index.js")]: "new-build",
			},
		});
		const h = harness(repo);
		const code = await runUpdate({ cwd: ROOT, rollback: true }, h.deps);
		check("rollback exits 0", code === 0, code);
		check(
			"checks out the previous ref and rebuilds/health-checks it",
			mutations(repo).join("|") ===
				["git checkout main", "npm ci --prefer-offline", "npm run build", "node dist/index.js --help"].join("|"),
			mutations(repo),
		);
		check("dist is rebuilt on the previous ref", repo.fs.files.get(DIST_FILE) === "build-branch-main", repo.fs.files.get(DIST_FILE));
		check("marker is updated to rolled-back", markerWrites(repo).at(-1)?.outcome === "rolled-back", markerWrites(repo));
	}

	section("--rollback refuses missing or corrupt markers");
	{
		const repo = createFakeRepo({ start: { kind: "tag", name: "v0.2.0" }, tags: TAGS });
		const h = harness(repo);
		const code = await runUpdate({ cwd: ROOT, rollback: true }, h.deps);
		check("missing marker exits non-zero", code === 1, code);
		check("missing marker has a clear message", lines(h.err).includes("no update marker"), h.err);
		check("missing marker changes nothing", mutations(repo).length === 0 && repo.fs.files.size === 0, { mutations: mutations(repo), files: [...repo.fs.files.keys()] });
	}
	{
		const corrupt = "{ this is not json";
		const repo = createFakeRepo({
			start: { kind: "tag", name: "v0.2.0" },
			tags: TAGS,
			initialFiles: { [UPDATE_MARKER_FILE]: corrupt },
		});
		const h = harness(repo);
		const code = await runUpdate({ cwd: ROOT, rollback: true }, h.deps);
		check("corrupt marker exits non-zero", code === 1, code);
		check("corrupt marker has a clear message", lines(h.err).includes("is corrupt"), h.err);
		check("corrupt marker is left untouched", repo.fs.files.get(MARKER_FILE) === corrupt, repo.fs.files.get(MARKER_FILE));
		check("corrupt marker changes nothing", mutations(repo).length === 0, mutations(repo));
	}

	section("--rollback dirty-tree rule");
	{
		const repo = createFakeRepo({
			start: { kind: "tag", name: "v0.2.0" },
			tags: TAGS,
			dirty: [" M src/cli.ts"],
			initialFiles: {
				[UPDATE_MARKER_FILE]: markerContents(),
				[path.join(DIST_DIR, "index.js")]: "new-build",
				[path.join(DIST_PREV_DIR, "index.js")]: "old-build",
			},
		});
		const h = harness(repo);
		const code = await runUpdate({ cwd: ROOT, rollback: true }, h.deps);
		check("dirty rollback is refused without --force", code === 1, code);
		check("dirty rollback mentions --force", lines(h.err).includes("--force"), h.err);
		check("dirty rollback changes nothing", mutations(repo).length === 0, mutations(repo));
		check("dirty rollback leaves the marker untouched", repo.fs.files.get(MARKER_FILE) === markerContents(), repo.fs.files.get(MARKER_FILE));
	}
	{
		const repo = createFakeRepo({
			start: { kind: "tag", name: "v0.2.0" },
			tags: TAGS,
			dirty: [" M src/cli.ts"],
			initialFiles: {
				[UPDATE_MARKER_FILE]: markerContents(),
				[path.join(DIST_DIR, "index.js")]: "new-build",
				[path.join(DIST_PREV_DIR, "index.js")]: "old-build",
			},
		});
		const h = harness(repo);
		const code = await runUpdate({ cwd: ROOT, rollback: true, force: true }, h.deps);
		check("dirty rollback proceeds with --force", code === 0, code);
		check("dirty rollback checks out plainly", mutations(repo).join("|") === "git checkout main", mutations(repo));
		check("dirty rollback restores dist.prev", repo.fs.files.get(DIST_FILE) === "old-build", repo.fs.files.get(DIST_FILE));
	}

	section("--status");
	{
		const repo = createFakeRepo({
			start: { kind: "tag", name: "v0.2.0" },
			tags: TAGS,
			initialFiles: {
				[UPDATE_MARKER_FILE]: markerContents(),
				[path.join(DIST_DIR, "index.js")]: "new-build",
				[path.join(DIST_PREV_DIR, "index.js")]: "old-build",
			},
		});
		const h = harness(repo);
		const code = await runUpdate({ cwd: ROOT, status: true }, h.deps);
		const output = lines(h.out);
		check("status exits 0", code === 0, code);
		check("status reports the current ref", output.includes("current:    v0.2.0 (tag)"), h.out);
		check("status reports the marker outcome", output.includes("outcome:      success"), h.out);
		check("status reports previous ref/tag", output.includes("previous ref: main") && output.includes("previous tag: v0.1.0"), h.out);
		check("status reports the target tag", output.includes("target tag:   v0.2.0"), h.out);
		check("status reports timestamps", output.includes("started:      2024-01-01T00:00:00.000Z") && output.includes("finished:     2024-01-01T00:05:00.000Z"), h.out);
		check("status reports dist presence", output.includes("dist:      present"), h.out);
		check("status reports dist.prev presence", output.includes("dist.prev: present"), h.out);
		check("status is read-only (no fetch/checkout/npm/node)", !repo.calls.some((call) => call.command === "npm" || call.command === "node" || call.args[0] === "fetch" || call.args[0] === "checkout"), repo.calls);
		check("status writes no files", repo.log.every((event) => event.type !== "fs" || event.description.startsWith("remove ")), repo.log);
	}
	{
		const repo = createFakeRepo({ tags: TAGS });
		const h = harness(repo);
		const code = await runUpdate({ cwd: ROOT, status: true }, h.deps);
		check("status without a marker exits 0", code === 0, code);
		check("status says the marker is missing", lines(h.out).includes("update marker: none"), h.out);
		check("status says dist is absent", lines(h.out).includes("dist:      absent") && lines(h.out).includes("dist.prev: absent"), h.out);
	}
	{
		const repo = createFakeRepo({ tags: TAGS, initialFiles: { [UPDATE_MARKER_FILE]: "not-json" } });
		const h = harness(repo);
		const code = await runUpdate({ cwd: ROOT, status: true }, h.deps);
		check("status with a corrupt marker still exits 0", code === 0, code);
		check("status reports the corrupt marker", lines(h.out).includes("update marker: corrupt"), h.out);
	}

	section("safety invariants");
	{
		const repos = [
			createFakeRepo({ tags: TAGS, initialFiles: { [path.join(DIST_DIR, "index.js")]: "old" } }),
			createFakeRepo({ tags: TAGS, failHealth: (ref) => ref.kind === "tag", initialFiles: { [path.join(DIST_DIR, "index.js")]: "old" } }),
			createFakeRepo({
				start: { kind: "tag", name: "v0.2.0" },
				tags: TAGS,
				initialFiles: { [UPDATE_MARKER_FILE]: markerContents(), [path.join(DIST_DIR, "index.js")]: "new", [path.join(DIST_PREV_DIR, "index.js")]: "old" },
			}),
		];
		await runUpdate({ cwd: ROOT }, harness(repos[0]!).deps);
		await runUpdate({ cwd: ROOT }, harness(repos[1]!).deps);
		await runUpdate({ cwd: ROOT, rollback: true }, harness(repos[2]!).deps);
		const calls = repos.flatMap((repo) => repo.calls);
		check("no git push was ever invoked", calls.every((call) => !(call.command === "git" && call.args[0] === "push")), calls);
		check("no force checkout was ever invoked", calls.every((call) => !(call.command === "git" && call.args[0] === "checkout" && call.args.some((arg) => arg === "-f" || arg === "--force"))), calls);
		check("no restart or stop command was ever invoked", calls.every((call) => call.command !== "alive" && !call.args.includes("restart") && !call.args.includes("stop")), calls);
	}
}

try {
	await main();
} catch (error) {
	failures += 1;
	process.stderr.write(`\nUNEXPECTED ERROR: ${error instanceof Error ? (error.stack ?? error.message) : String(error)}\n`);
}

process.stdout.write(failures === 0 ? "\nALL UPDATE TESTS PASSED\n" : `\n${failures} UPDATE TEST(S) FAILED\n`);
process.exitCode = failures === 0 ? 0 : 1;
