/**
 * Safe harness updates for `alive update`.
 *
 * Modes share one inspection path (repository root, tags, current ref, working
 * tree):
 *
 *   - check: fetch tags and report the current ref, the newest stable `vX.Y.Z`
 *     tag, the update marker and the presence of `dist/`/`dist.prev/`.
 *   - apply: check out the target tag, preserve the old build in `dist.prev/`,
 *     run `npm ci --prefer-offline` + `npm run build`, then a short health gate.
 *   - rollback: restore `previousRef` from the marker and either restore
 *     `dist.prev/` instantly or rebuild if no saved build exists.
 *   - status: report the current ref, marker contents and build directories.
 *
 * Safety rules enforced here:
 *   - never restart the harness (the operator does that after the update);
 *   - never touch `.alive/`, `alive.config.json`, `SOUL.md`, `.env` or any path
 *     outside the checkout;
 *   - never `git push`, never `git checkout --force`, never delete a ref;
 *   - a dirty tree is refused unless `--force`, and even then the checkout is
 *     plain (git refuses rather than discarding local changes);
 *   - every mutating apply is preceded by `.alive-update.json`, and every
 *     failure updates it after the rollback attempt.
 *
 * The command runner and filesystem are injected so the flow is testable
 * without real git, npm, network or filesystem access.
 */
import { execFile } from "node:child_process";
import { readFile, rename as renameFile, rm, stat, writeFile } from "node:fs/promises";
import * as path from "node:path";
import { promisify } from "node:util";
import { oneLine } from "./util.js";

const execFileAsync = promisify(execFile);

const GIT_TIMEOUT_MS = 120_000;
const FETCH_TIMEOUT_MS = 300_000;
const NPM_TIMEOUT_MS = 15 * 60_000;
const MAX_BUFFER = 32 * 1024 * 1024;

/** The health gate is deliberately short: it only proves that the CLI boots. */
export const HEALTH_TIMEOUT_MS = 15_000;

/** Root-level update artifacts. Both are gitignored. */
export const UPDATE_MARKER_FILE = ".alive-update.json";
export const DIST_DIR = "dist";
export const DIST_PREV_DIR = "dist.prev";

/** Stable release tags only: `v1.2.3`, with no prerelease or build suffix. */
const STABLE_TAG_PATTERN = /^v(\d+)\.(\d+)\.(\d+)$/;

export interface StableVersion {
	major: number;
	minor: number;
	patch: number;
}

/** Parse a stable `vX.Y.Z` tag; anything else (prereleases, branches, ranges) yields undefined. */
export function parseStableTag(tag: string): StableVersion | undefined {
	const match = STABLE_TAG_PATTERN.exec(tag.trim());
	if (!match) return undefined;
	const version: StableVersion = { major: Number(match[1]), minor: Number(match[2]), patch: Number(match[3]) };
	if (![version.major, version.minor, version.patch].every((part) => Number.isSafeInteger(part))) return undefined;
	return version;
}

export function compareStableVersions(a: StableVersion, b: StableVersion): number {
	if (a.major !== b.major) return a.major - b.major;
	if (a.minor !== b.minor) return a.minor - b.minor;
	return a.patch - b.patch;
}

/** Newest stable tag by numeric semver order; prereleases and malformed tags are ignored. */
export function pickLatestStableTag(tags: readonly string[]): string | undefined {
	let best: { tag: string; version: StableVersion } | undefined;
	for (const tag of tags) {
		const version = parseStableTag(tag);
		if (!version) continue;
		if (!best || compareStableVersions(version, best.version) > 0) best = { tag, version };
	}
	return best?.tag;
}

export interface RunOptions {
	cwd?: string;
	timeoutMs?: number;
	env?: NodeJS.ProcessEnv;
}

export interface RunResult {
	stdout: string;
	stderr: string;
}

/**
 * The only process-execution boundary used by the update flow. Real code uses
 * `createExecRunner()`; tests inject a fake and record every call.
 */
export type CommandRunner = (command: string, args: string[], options?: RunOptions) => Promise<RunResult>;

export class CommandFailure extends Error {
	readonly command: string;
	readonly args: string[];
	readonly exitCode: number | null;
	readonly stdout: string;
	readonly stderr: string;

	constructor(command: string, args: string[], exitCode: number | null, stdout: string, stderr: string) {
		const detail = oneLine(stderr || stdout) || "no output";
		super(`${command} ${args.join(" ")} failed${exitCode === null ? "" : ` (exit ${exitCode})`}: ${detail}`);
		this.name = "CommandFailure";
		this.command = command;
		this.args = args;
		this.exitCode = exitCode;
		this.stdout = stdout;
		this.stderr = stderr;
	}
}

/** Real runner: `execFile` without a shell, non-zero exits become `CommandFailure`. */
export function createExecRunner(): CommandRunner {
	return async (command, args, options = {}) => {
		try {
			const result = await execFileAsync(command, args, {
				cwd: options.cwd ?? process.cwd(),
				timeout: options.timeoutMs ?? GIT_TIMEOUT_MS,
				killSignal: "SIGKILL",
				maxBuffer: MAX_BUFFER,
				encoding: "utf8",
				env: { ...process.env, GIT_TERMINAL_PROMPT: "0", ...options.env },
			});
			return { stdout: String(result.stdout ?? ""), stderr: String(result.stderr ?? "") };
		} catch (error) {
			const value = error as { code?: unknown; stdout?: unknown; stderr?: unknown; message?: unknown };
			const exitCode = typeof value.code === "number" ? value.code : null;
			const stdout = commandOutput(value.stdout);
			const stderr = commandOutput(value.stderr) || (typeof value.message === "string" ? value.message : "");
			throw new CommandFailure(command, args, exitCode, stdout, stderr);
		}
	};
}

function commandOutput(value: unknown): string {
	if (typeof value === "string") return value;
	if (Buffer.isBuffer(value)) return value.toString("utf8");
	return "";
}

/** Filesystem boundary for the update marker and the saved build. */
export interface UpdateFileOps {
	/** Returns undefined when the file does not exist; other errors are thrown. */
	readText(file: string): Promise<string | undefined>;
	writeText(file: string, text: string): Promise<void>;
	exists(target: string): Promise<boolean>;
	rename(from: string, to: string): Promise<void>;
	/** Recursively removes a file or directory; missing targets are ignored. */
	remove(target: string): Promise<void>;
}

export function createNodeFileOps(): UpdateFileOps {
	return {
		readText: async (file) => {
			try {
				return await readFile(file, "utf8");
			} catch (error) {
				if (isMissingPath(error)) return undefined;
				throw error;
			}
		},
		writeText: async (file, text) => {
			await writeFile(file, text, "utf8");
		},
		exists: async (target) => {
			try {
				await stat(target);
				return true;
			} catch (error) {
				if (isMissingPath(error)) return false;
				throw error;
			}
		},
		rename: async (from, to) => {
			await renameFile(from, to);
		},
		remove: async (target) => {
			await rm(target, { recursive: true, force: true });
		},
	};
}

function isMissingPath(error: unknown): boolean {
	return (error as NodeJS.ErrnoException | undefined)?.code === "ENOENT";
}

export type UpdateOutcome = "in-progress" | "success" | "rolled-back" | "failed";

/** Contents of `<repo>/.alive-update.json`. */
export interface UpdateMarker {
	previousRef: string;
	previousTag?: string;
	targetTag: string;
	startedAt: string;
	finishedAt?: string;
	outcome: UpdateOutcome;
}

type MarkerRead =
	| { status: "ok"; path: string; marker: UpdateMarker }
	| { status: "missing"; path: string }
	| { status: "corrupt"; path: string; reason: string };

export interface UpdateDeps {
	/** Injected command runner. Required. */
	run: CommandRunner;
	/** Injected filesystem. Defaults to node:fs/promises. */
	fs?: UpdateFileOps;
	/** Human-readable progress/messages. Defaults to stdout. */
	out?: (line: string) => void;
	/** Warnings and errors. Defaults to stderr. */
	err?: (line: string) => void;
	/** Reads the checkout's package version; defaults to `<root>/package.json`. */
	readPackageVersion?: (root: string) => Promise<string | undefined>;
	/** ISO clock used for marker timestamps. */
	now?: () => string;
}

export interface UpdateOptions {
	/** Directory used to discover the checkout; all commands run in the detected repository root. */
	cwd: string;
	/** Read-only mode: report ref, target, marker and build directories, change nothing. */
	check?: boolean;
	/** Restore `previousRef` from the marker and the saved build. */
	rollback?: boolean;
	/** Report ref, marker and build directories without fetching or changing anything. */
	status?: boolean;
	/** Update to this exact stable tag instead of the newest stable one. */
	tag?: string;
	/** Bypass the dirty-working-tree guard. Never turns into a forced git checkout. */
	force?: boolean;
}

interface ResolvedDeps {
	run: CommandRunner;
	fs: UpdateFileOps;
	out: (line: string) => void;
	err: (line: string) => void;
	readPackageVersion: (root: string) => Promise<string | undefined>;
	now: () => string;
}

export class UpdateError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "UpdateError";
	}
}

/**
 * Entry point used by the CLI. Returns a process exit code instead of throwing.
 * `status`/`rollback` win over `check`; otherwise `check` is read-only and no
 * mode means apply.
 */
export async function runUpdate(options: UpdateOptions, deps: UpdateDeps): Promise<number> {
	if (options.status) return statusUpdate(options, deps);
	if (options.rollback) return rollbackUpdate(options, deps);
	return options.check ? checkForUpdate(options, deps) : applyUpdate(options, deps);
}

export async function checkForUpdate(options: UpdateOptions, deps: UpdateDeps): Promise<number> {
	const d = resolveDeps(deps);
	try {
		await inspectAndReport(options, d);
		return 0;
	} catch (error) {
		d.err(`error: ${errorMessage(error)}`);
		return 1;
	}
}

export async function applyUpdate(options: UpdateOptions, deps: UpdateDeps): Promise<number> {
	const d = resolveDeps(deps);
	try {
		await applyAndReport(options, d);
		return 0;
	} catch (error) {
		d.err(`error: ${errorMessage(error)}`);
		return 1;
	}
}

export async function rollbackUpdate(options: UpdateOptions, deps: UpdateDeps): Promise<number> {
	const d = resolveDeps(deps);
	try {
		await rollbackAndReport(options, d);
		return 0;
	} catch (error) {
		d.err(`error: ${errorMessage(error)}`);
		return 1;
	}
}

export async function statusUpdate(options: UpdateOptions, deps: UpdateDeps): Promise<number> {
	const d = resolveDeps(deps);
	try {
		await statusAndReport(options, d);
		return 0;
	} catch (error) {
		d.err(`error: ${errorMessage(error)}`);
		return 1;
	}
}

interface CurrentRef {
	commit: string;
	/** Set only when HEAD is exactly at a tag. */
	tag?: string;
	/** Set only when HEAD is on a branch. */
	branch?: string;
}

interface RepositorySnapshot {
	root: string;
	allTags: string[];
	stableTags: string[];
	current: CurrentRef;
	packageVersion?: string;
	/** `git status --porcelain` lines (empty means clean). */
	dirty: string[];
	clean: boolean;
}

interface UpdateVerdict {
	available: boolean;
	reason: string;
}

interface RollbackOutcome {
	ok: boolean;
	problem: string;
	/** Human-readable summary of what was restored. */
	detail: string;
}

async function inspectAndReport(options: UpdateOptions, d: ResolvedDeps): Promise<void> {
	const snapshot = await inspectRepository(options.cwd, d, true);
	const target = selectTarget(options, snapshot);

	d.out(`repository: ${snapshot.root}`);
	d.out(`current:    ${currentLabel(snapshot.current)}`);
	if (snapshot.packageVersion) d.out(`package:    ${snapshot.packageVersion}`);
	d.out(`working tree: ${describeWorktree(snapshot)}`);

	if (!target) {
		d.out("latest stable: none");
		d.out("no stable vX.Y.Z tags found on origin; nothing to update");
		await reportUpdateArtifacts(d, snapshot.root);
		return;
	}

	d.out(`${targetLabel(options)}: ${target}`);
	const verdict = updateVerdict(snapshot, target, options.tag !== undefined);
	if (!verdict.available) {
		d.out(`update available: no (${verdict.reason})`);
		await reportUpdateArtifacts(d, snapshot.root);
		return;
	}

	d.out(`update available: yes (${shortLabel(snapshot.current)} -> ${target})`);
	if (!snapshot.current.tag && !snapshot.current.branch) {
		d.out("note: apply refuses a detached HEAD that is not on a tag; check out a branch or a stable tag first");
	}
	const next = [`alive update`];
	if (options.tag !== undefined) next.push(`--tag ${target}`);
	if (!snapshot.clean) next.push("--force");
	d.out(`next: ${next.join(" ")}`);
	if (!snapshot.clean) d.out("note: the working tree is dirty, so apply requires --force (local changes are never discarded)");
	await reportUpdateArtifacts(d, snapshot.root);
}

async function applyAndReport(options: UpdateOptions, d: ResolvedDeps): Promise<void> {
	const snapshot = await inspectRepository(options.cwd, d, true);
	const target = selectTarget(options, snapshot);

	d.out(`repository: ${snapshot.root}`);
	d.out(`current:    ${currentLabel(snapshot.current)}`);
	if (snapshot.packageVersion) d.out(`package:    ${snapshot.packageVersion}`);
	if (!target) throw new UpdateError("no stable vX.Y.Z tags found on origin; cannot update");

	d.out(`${targetLabel(options)}: ${target}`);
	const verdict = updateVerdict(snapshot, target, options.tag !== undefined);
	if (!verdict.available) {
		d.out(`already on ${target}; nothing to do`);
		return;
	}

	if (!snapshot.current.tag && !snapshot.current.branch) {
		const short = snapshot.current.commit ? snapshot.current.commit.slice(0, 12) : "unknown";
		throw new UpdateError(
			`refusing to update a detached HEAD (${short}) that is not on a tag; check out a branch or a stable tag first`,
		);
	}
	if (!snapshot.clean && !options.force) {
		throw new UpdateError(
			`working tree is ${describeWorktree(snapshot)}; commit or stash the changes, or re-run with --force`,
		);
	}
	if (!snapshot.clean) {
		d.err("warning: working tree is dirty; continuing because --force was given (local changes are never discarded)");
	}

	// Prefer the branch when HEAD is on one (a branch tip may also carry a tag):
	// rolling back to a tag would silently detach the operator's checkout.
	const previous = {
		ref: (snapshot.current.branch ?? snapshot.current.tag) as string,
		commit: snapshot.current.commit,
	};
	const root = snapshot.root;
	const marker: UpdateMarker = {
		previousRef: previous.ref,
		previousTag: snapshot.current.tag,
		targetTag: target,
		startedAt: d.now(),
		outcome: "in-progress",
	};

	// The marker must exist before the first mutating command so an interrupted
	// update can always be recovered with `alive update --rollback`.
	try {
		await writeMarker(d, root, marker);
	} catch (error) {
		throw new UpdateError(
			`could not write ${markerPath(root)} (${oneLine(errorMessage(error))}); nothing was changed`,
		);
	}

	d.out(`updating ${currentLabel(snapshot.current)} -> ${target}`);
	let checkoutDone = false;
	let savedBuild = false;
	try {
		d.out(`checking out ${target}...`);
		await d.run("git", ["checkout", target], { cwd: root, timeoutMs: GIT_TIMEOUT_MS });
		checkoutDone = true;

		const dist = path.join(root, DIST_DIR);
		if (await d.fs.exists(dist)) {
			d.out(`preserving the previous build (${DIST_DIR}/ -> ${DIST_PREV_DIR}/)...`);
			savedBuild = await preserveBuild(d, root);
		}

		d.out("installing dependencies (npm ci --prefer-offline)...");
		await d.run("npm", ["ci", "--prefer-offline"], { cwd: root, timeoutMs: NPM_TIMEOUT_MS });
		d.out("building (npm run build)...");
		await d.run("npm", ["run", "build"], { cwd: root, timeoutMs: NPM_TIMEOUT_MS });
		d.out("checking the new build (node dist/index.js --help)...");
		await healthCheck(d, root);
	} catch (error) {
		d.err(`error: ${errorMessage(error)}`);
		const rollback = await rollbackTo(d, root, previous, checkoutDone, savedBuild);
		await finalizeMarker(d, root, marker, rollback.ok ? "rolled-back" : "failed");
		if (rollback.ok) {
			throw new UpdateError(`update to ${target} failed; ${rollback.detail} (the running harness was not restarted)`);
		}
		throw new UpdateError(
			`update to ${target} failed; rollback to ${previous.ref} was incomplete (${rollback.problem}); inspect the checkout manually before restarting the harness`,
		);
	}

	await finalizeMarker(d, root, marker, "success");
	const updatedVersion = await d.readPackageVersion(root);
	d.out(`updated: ${target} (package ${updatedVersion ?? "unknown"}; was ${previous.ref})`);
	if (savedBuild) d.out(`previous build kept in ${DIST_PREV_DIR}/ for \`alive update --rollback\``);
	d.out("restart required: the running harness still executes the old code; restart it yourself with `alive restart` (this command never restarts anything)");
}

async function rollbackAndReport(options: UpdateOptions, d: ResolvedDeps): Promise<void> {
	const root = await detectRepositoryRoot(options.cwd, d);
	const read = await readMarker(d, root);
	if (read.status === "missing") throw new UpdateError(`no update marker at ${read.path}; nothing to roll back`);
	if (read.status === "corrupt") {
		throw new UpdateError(`update marker ${read.path} is corrupt (${read.reason}); refusing to change anything`);
	}
	const marker = read.marker;

	const dirty = await readDirty(d, root);
	if (dirty.length > 0 && !options.force) {
		const sample = dirty.slice(0, 3).join(", ");
		throw new UpdateError(
			`working tree is dirty (${dirty.length} path${dirty.length === 1 ? "" : "s"}: ${sample}${dirty.length > 3 ? ", …" : ""}); commit or stash the changes, or re-run with --force`,
		);
	}
	if (dirty.length > 0) {
		d.err("warning: working tree is dirty; continuing because --force was given (local changes are never discarded)");
	}

	d.out(`rolling back to ${marker.previousRef} (last target: ${marker.targetTag})...`);
	let problem = "";
	try {
		await d.run("git", ["checkout", marker.previousRef], { cwd: root, timeoutMs: GIT_TIMEOUT_MS });
	} catch (error) {
		problem = `checkout ${marker.previousRef} failed: ${oneLine(errorMessage(error))}`;
		d.err(`error: ${problem}`);
	}

	let restored = "";
	if (!problem) {
		try {
			const how = await restoreBuild(d, root, true);
			restored =
				how === "saved"
					? `restored ${DIST_PREV_DIR}/ to ${DIST_DIR}/ (no network or rebuild needed)`
					: `rebuilt ${DIST_DIR}/ on ${marker.previousRef}`;
		} catch (error) {
			problem = `build restore failed: ${oneLine(errorMessage(error))}`;
			d.err(`error: ${problem}`);
		}
	}

	const ok = problem === "";
	await finalizeMarker(d, root, marker, ok ? "rolled-back" : "failed");
	if (!ok) throw new UpdateError(`rollback to ${marker.previousRef} failed (${problem})`);

	d.out(`rolled back to ${marker.previousRef}; ${restored}`);
	d.out("restart required: restart the harness yourself with `alive restart` so it picks up the restored code (this command never restarts anything)");
}

async function statusAndReport(options: UpdateOptions, d: ResolvedDeps): Promise<void> {
	const root = await detectRepositoryRoot(options.cwd, d);
	d.out(`repository: ${root}`);

	try {
		const current = await readCurrentRef(d, root);
		d.out(`current:    ${currentLabel(current)}`);
		const version = await d.readPackageVersion(root);
		if (version) d.out(`package:    ${version}`);
	} catch (error) {
		d.out(`current:    unknown (${oneLine(errorMessage(error))})`);
	}

	await reportUpdateArtifacts(d, root);
}

async function inspectRepository(cwd: string, d: ResolvedDeps, announceFetch: boolean): Promise<RepositorySnapshot> {
	const root = await detectRepositoryRoot(cwd, d);
	if (announceFetch) d.out("fetching tags from origin...");
	await d.run("git", ["fetch", "--tags", "--quiet", "origin"], { cwd: root, timeoutMs: FETCH_TIMEOUT_MS });

	const allTags = await listTags(d, root);
	const stableTags = allTags.filter((tag) => parseStableTag(tag) !== undefined);
	const current = await readCurrentRef(d, root);
	const packageVersion = await d.readPackageVersion(root);
	const dirty = await readDirty(d, root);
	return { root, allTags, stableTags, current, packageVersion, dirty, clean: dirty.length === 0 };
}

async function detectRepositoryRoot(cwd: string, d: ResolvedDeps): Promise<string> {
	try {
		const { stdout } = await d.run("git", ["rev-parse", "--show-toplevel"], { cwd, timeoutMs: GIT_TIMEOUT_MS });
		const root = stdout.trim();
		if (!root) throw new Error("empty output");
		return root;
	} catch (error) {
		throw new UpdateError(
			`not inside a git checkout (${oneLine(errorMessage(error))}); run this from the Alive repository root`,
		);
	}
}

async function listTags(d: ResolvedDeps, root: string): Promise<string[]> {
	const { stdout } = await d.run("git", ["tag", "--list"], { cwd: root, timeoutMs: GIT_TIMEOUT_MS });
	return stdout
		.split("\n")
		.map((line) => line.trim())
		.filter((line) => line.length > 0);
}

async function readCurrentRef(d: ResolvedDeps, root: string): Promise<CurrentRef> {
	const commit = (await d.run("git", ["rev-parse", "HEAD"], { cwd: root, timeoutMs: GIT_TIMEOUT_MS })).stdout.trim();
	if (!commit) throw new UpdateError("could not read HEAD; is this a full git checkout?");

	let tag: string | undefined;
	try {
		const described = await d.run("git", ["describe", "--tags", "--exact-match", "HEAD"], {
			cwd: root,
			timeoutMs: GIT_TIMEOUT_MS,
		});
		tag = described.stdout.trim().split("\n")[0] || undefined;
	} catch {
		// Not on a tag: expected for branch and detached checkouts.
	}

	let branch: string | undefined;
	const abbreviated = (await d.run("git", ["rev-parse", "--abbrev-ref", "HEAD"], { cwd: root, timeoutMs: GIT_TIMEOUT_MS })).stdout.trim();
	if (abbreviated && abbreviated !== "HEAD") branch = abbreviated;

	return { commit, tag, branch };
}

async function readDirty(d: ResolvedDeps, root: string): Promise<string[]> {
	const { stdout } = await d.run("git", ["status", "--porcelain"], { cwd: root, timeoutMs: GIT_TIMEOUT_MS });
	return stdout
		.split("\n")
		.map((line) => line.trimEnd())
		.filter((line) => line.length > 0)
		// The update's own artifacts must never make the tree look dirty. This
		// matters when updating a checkout whose .gitignore predates them, and
		// after an interrupted update left the marker or dist.prev behind.
		.filter((line) => !isUpdateArtifact(line));
}

function isUpdateArtifact(line: string): boolean {
	const file = line.slice(3).trim();
	return file === UPDATE_MARKER_FILE || file === DIST_PREV_DIR || file.startsWith(`${DIST_PREV_DIR}/`);
}

async function readHead(d: ResolvedDeps, root: string): Promise<string> {
	return (await d.run("git", ["rev-parse", "HEAD"], { cwd: root, timeoutMs: GIT_TIMEOUT_MS })).stdout.trim();
}

function selectTarget(options: UpdateOptions, snapshot: RepositorySnapshot): string | undefined {
	if (options.tag !== undefined) {
		const tag = options.tag.trim();
		if (!parseStableTag(tag)) {
			throw new UpdateError(`--tag ${tag || "(empty)"} is not a stable vX.Y.Z tag; prereleases and other refs are not supported`);
		}
		if (!snapshot.allTags.includes(tag)) {
			throw new UpdateError(`tag ${tag} was not found after git fetch --tags origin`);
		}
		return tag;
	}
	return pickLatestStableTag(snapshot.stableTags);
}

function updateVerdict(snapshot: RepositorySnapshot, target: string, explicit: boolean): UpdateVerdict {
	const currentTag = snapshot.current.tag;
	if (currentTag === target) return { available: false, reason: `already on ${target}` };
	const currentVersion = currentTag ? parseStableTag(currentTag) : undefined;
	const targetVersion = parseStableTag(target);
	if (!explicit && currentVersion && targetVersion && compareStableVersions(currentVersion, targetVersion) >= 0) {
		return { available: false, reason: `${currentTag} is not older than the latest stable tag` };
	}
	return { available: true, reason: "" };
}

function targetLabel(options: UpdateOptions): string {
	return options.tag !== undefined ? "target" : "latest stable";
}

function shortLabel(current: CurrentRef): string {
	return current.tag ?? currentLabel(current);
}

function currentLabel(current: CurrentRef): string {
	const short = current.commit ? current.commit.slice(0, 12) : "unknown";
	if (current.branch) return `branch ${current.branch} @ ${short}${current.tag ? ` (tag ${current.tag})` : ""}`;
	if (current.tag) return `${current.tag} (tag)`;
	return `detached @ ${short}`;
}

function describeWorktree(snapshot: RepositorySnapshot): string {
	if (snapshot.dirty.length === 0) return "clean";
	const sample = snapshot.dirty.slice(0, 3).join(", ");
	const suffix = snapshot.dirty.length > 3 ? ", …" : "";
	return `dirty (${snapshot.dirty.length} path${snapshot.dirty.length === 1 ? "" : "s"}: ${sample}${suffix})`;
}

function markerPath(root: string): string {
	return path.join(root, UPDATE_MARKER_FILE);
}

async function writeMarker(d: ResolvedDeps, root: string, marker: UpdateMarker): Promise<void> {
	await d.fs.writeText(markerPath(root), `${JSON.stringify(marker, null, 2)}\n`);
}

async function finalizeMarker(d: ResolvedDeps, root: string, marker: UpdateMarker, outcome: UpdateOutcome): Promise<void> {
	try {
		await writeMarker(d, root, { ...marker, outcome, finishedAt: d.now() });
	} catch (error) {
		d.err(`warning: could not update ${markerPath(root)}: ${oneLine(errorMessage(error))}`);
	}
}

async function readMarker(d: ResolvedDeps, root: string): Promise<MarkerRead> {
	const file = markerPath(root);
	let raw: string | undefined;
	try {
		raw = await d.fs.readText(file);
	} catch (error) {
		return { status: "corrupt", path: file, reason: oneLine(errorMessage(error)) };
	}
	if (raw === undefined) return { status: "missing", path: file };
	try {
		const marker = validateMarker(JSON.parse(raw) as unknown);
		return { status: "ok", path: file, marker };
	} catch (error) {
		return { status: "corrupt", path: file, reason: oneLine(errorMessage(error)) };
	}
}

function validateMarker(value: unknown): UpdateMarker {
	if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("not a JSON object");
	const record = value as Record<string, unknown>;
	const previousRef = requiredString(record, "previousRef");
	const targetTag = requiredString(record, "targetTag");
	const startedAt = requiredString(record, "startedAt");
	const outcome = record.outcome;
	if (outcome !== "in-progress" && outcome !== "success" && outcome !== "rolled-back" && outcome !== "failed") {
		throw new Error("outcome is missing or invalid");
	}
	const previousTag = optionalString(record, "previousTag");
	const finishedAt = optionalString(record, "finishedAt");
	return { previousRef, previousTag, targetTag, startedAt, finishedAt, outcome };
}

function requiredString(record: Record<string, unknown>, key: string): string {
	const value = record[key];
	if (typeof value !== "string" || value.trim().length === 0) throw new Error(`${key} is missing or empty`);
	return value;
}

function optionalString(record: Record<string, unknown>, key: string): string | undefined {
	const value = record[key];
	if (value === undefined) return undefined;
	if (typeof value !== "string") throw new Error(`${key} must be a string`);
	return value;
}

async function reportUpdateArtifacts(d: ResolvedDeps, root: string): Promise<void> {
	const read = await readMarker(d, root);
	if (read.status === "missing") {
		d.out(`update marker: none (${read.path})`);
	} else if (read.status === "corrupt") {
		d.out(`update marker: corrupt (${read.path}): ${read.reason}`);
	} else {
		const marker = read.marker;
		d.out(`update marker: ${read.path}`);
		d.out(`  outcome:      ${marker.outcome}`);
		d.out(`  previous ref: ${marker.previousRef}`);
		d.out(`  previous tag: ${marker.previousTag ?? "none"}`);
		d.out(`  target tag:   ${marker.targetTag}`);
		d.out(`  started:      ${marker.startedAt}`);
		d.out(`  finished:     ${marker.finishedAt ?? "not finished"}`);
	}
	d.out(`dist:      ${(await d.fs.exists(path.join(root, DIST_DIR))) ? "present" : "absent"}`);
	d.out(`dist.prev: ${(await d.fs.exists(path.join(root, DIST_PREV_DIR))) ? "present" : "absent"}`);
}

/** Move `dist/` to `dist.prev/`, replacing any older saved generation. */
async function preserveBuild(d: ResolvedDeps, root: string): Promise<boolean> {
	const dist = path.join(root, DIST_DIR);
	const previous = path.join(root, DIST_PREV_DIR);
	if (!(await d.fs.exists(dist))) return false;
	if (await d.fs.exists(previous)) await d.fs.remove(previous);
	await d.fs.rename(dist, previous);
	return true;
}

/**
 * Restore a usable build after checking out the previous ref. With a saved
 * `dist.prev/` this is a rename (instant, no network); otherwise the old ref is
 * reinstalled, rebuilt and health-checked.
 */
async function restoreBuild(d: ResolvedDeps, root: string, preferSaved: boolean): Promise<"saved" | "rebuilt"> {
	const dist = path.join(root, DIST_DIR);
	const previous = path.join(root, DIST_PREV_DIR);
	if (preferSaved && (await d.fs.exists(previous))) {
		d.err(`restoring the previous build from ${DIST_PREV_DIR}/...`);
		if (await d.fs.exists(dist)) await d.fs.remove(dist);
		await d.fs.rename(previous, dist);
		if (!(await d.fs.exists(dist))) throw new UpdateError(`${DIST_PREV_DIR}/ was moved but ${DIST_DIR}/ is missing`);
		return "saved";
	}

	d.err(`rebuilding (npm ci --prefer-offline + npm run build) on the previous ref...`);
	await d.run("npm", ["ci", "--prefer-offline"], { cwd: root, timeoutMs: NPM_TIMEOUT_MS });
	await d.run("npm", ["run", "build"], { cwd: root, timeoutMs: NPM_TIMEOUT_MS });
	await healthCheck(d, root);
	return "rebuilt";
}

async function healthCheck(d: ResolvedDeps, root: string): Promise<void> {
	await d.run("node", ["dist/index.js", "--help"], { cwd: root, timeoutMs: HEALTH_TIMEOUT_MS });
}

/**
 * Automatic rollback after a failed apply: restore the previous ref and, when
 * this run saved it, the previous `dist/`. No fetch and no npm when a saved
 * build exists.
 */
async function rollbackTo(
	d: ResolvedDeps,
	root: string,
	previous: { ref: string; commit: string },
	checkoutDone: boolean,
	savedBuild: boolean,
): Promise<RollbackOutcome> {
	d.err(`rolling back to ${previous.ref}...`);
	try {
		await d.run("git", ["checkout", previous.ref], { cwd: root, timeoutMs: GIT_TIMEOUT_MS });
	} catch (error) {
		const problem = `checkout ${previous.ref} failed: ${oneLine(errorMessage(error))}`;
		d.err(`error: ${problem}`);
		return { ok: false, problem, detail: "" };
	}

	let head = "";
	try {
		head = await readHead(d, root);
	} catch (error) {
		const problem = `could not verify HEAD after rollback: ${oneLine(errorMessage(error))}`;
		d.err(`error: ${problem}`);
		return { ok: false, problem, detail: "" };
	}
	if (head !== previous.commit) {
		const problem = `HEAD is ${head.slice(0, 12) || "unknown"} after rollback, expected ${previous.commit.slice(0, 12)}`;
		d.err(`error: ${problem}`);
		return { ok: false, problem, detail: "" };
	}

	if (!checkoutDone) {
		// The failed `git checkout` never changed any files, so the old build output is intact.
		d.err(`restored ${previous.ref}; the checkout never moved, so the previous build is unchanged`);
		return { ok: true, problem: "", detail: `restored ${previous.ref}; the previous build was unchanged` };
	}

	try {
		const how = await restoreBuild(d, root, savedBuild);
		const detail =
			how === "saved"
				? `rolled back to ${previous.ref} and restored ${DIST_PREV_DIR}/`
				: `rolled back to ${previous.ref} and rebuilt the previous version`;
		d.err(`restored ${previous.ref} (${how === "saved" ? "saved build" : "rebuilt"})`);
		return { ok: true, problem: "", detail };
	} catch (error) {
		const problem = `build restore on ${previous.ref} failed: ${oneLine(errorMessage(error))}`;
		d.err(`error: ${problem}`);
		return { ok: false, problem, detail: "" };
	}
}

async function defaultReadPackageVersion(root: string): Promise<string | undefined> {
	try {
		const raw = await readFile(path.join(root, "package.json"), "utf8");
		const parsed = JSON.parse(raw) as { version?: unknown };
		return typeof parsed.version === "string" ? parsed.version : undefined;
	} catch {
		return undefined;
	}
}

function resolveDeps(deps: UpdateDeps): ResolvedDeps {
	if (!deps || typeof deps.run !== "function") throw new Error("alive update requires an injected command runner");
	return {
		run: deps.run,
		fs: deps.fs ?? createNodeFileOps(),
		out: deps.out ?? ((line) => void process.stdout.write(`${line}\n`)),
		err: deps.err ?? ((line) => void process.stderr.write(`${line}\n`)),
		readPackageVersion: deps.readPackageVersion ?? defaultReadPackageVersion,
		now: deps.now ?? (() => new Date().toISOString()),
	};
}

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}
