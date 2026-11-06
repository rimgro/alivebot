/**
 * Worktree retention for ephemeral coding workers (#220).
 *
 * Worker worktrees are disposable after their branch is published: the branch
 * and the durable worker record stay in the repository/state, so a follow-up
 * can reattach the worktree. This module owns the two entry points:
 *
 * - `pruneWorkerWorktrees()` for the explicit `alive workers prune` command;
 * - `measureWorktrees()` for the status line, with a hard time budget because
 *   the directory can be tens of gigabytes.
 *
 * The host adapter uses `fs`; a sandboxed profile gets an adapter that runs the
 * same scan/removal inside the guest VM, so `alive workers prune` works for
 * both execution boundaries.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import type { LoadedConfig } from "../config.js";
import type { WorkerEnvironment } from "./environment.js";
import { worktreesRoot, type WorkerRecord, type WorkerStatus } from "./store.js";
import { gitState, runGit } from "./worktree.js";

export const DEFAULT_WORKTREE_KEEP = 5;
const STATUS_SIZE_TIMEOUT_MS = 2_000;
const DAY_MS = 24 * 60 * 60_000;

/** Statuses whose worktree must never be pruned (an interrupted worker can resume). */
const PROTECTED_WORKER_STATUSES = new Set<WorkerStatus>(["starting", "running", "interrupted"]);

export type WorktreePruneSkipReason = "active" | "dirty" | "recent" | "younger" | "error";

export interface WorktreePruneEntry {
	/** Directory name under the worktrees root (normally the worker id). */
	name: string;
	path: string;
	/** Bytes freed by this entry; `null` when nothing was removed (or would be). */
	bytes: number | null;
	/** Age from the directory mtime at scan time. */
	ageDays: number;
	action: "removed" | "skipped";
	reason?: WorktreePruneSkipReason;
	detail?: string;
}

export interface WorktreePruneCounts {
	active: number;
	dirty: number;
	recent: number;
	younger: number;
	error: number;
}

export interface WorktreePruneResult {
	root: string;
	dryRun: boolean;
	keep: number;
	olderThanDays: number | null;
	scanned: number;
	removed: number;
	skipped: number;
	/** Bytes removed, or bytes that `--dry-run` would remove. */
	freedBytes: number;
	skippedByReason: WorktreePruneCounts;
	entries: WorktreePruneEntry[];
}

export interface PruneWorktreesOptions {
	root: string;
	environment: WorkerEnvironment;
	/** Worker registry records; active statuses protect their worktrees. */
	records?: ReadonlyArray<Pick<WorkerRecord, "id" | "status" | "workspacePath" | "repositoryPath">>;
	/** Newest worktrees to retain (default 5). */
	keep?: number;
	/** Only prune worktrees at least this many days old. */
	olderThanDays?: number;
	dryRun?: boolean;
	/** Test seam for filesystem operations; defaults by environment kind. */
	filesystem?: WorktreeFilesystem;
	/** Test seam for age calculations. */
	now?: number;
}

interface DirectoryEntry {
	name: string;
	path: string;
	mtimeMs: number;
}

/** Filesystem operations the pruner needs, on either side of the VM boundary. */
export interface WorktreeFilesystem {
	listDirectories(root: string): Promise<DirectoryEntry[]>;
	measure(directory: string): Promise<number>;
	exists(target: string): Promise<boolean>;
	remove(target: string): Promise<void>;
}

function emptyCounts(): WorktreePruneCounts {
	return { active: 0, dirty: 0, recent: 0, younger: 0, error: 0 };
}

/** The worktrees parent the `WorkerManager` uses for this environment. */
export function workerWorktreesRoot(config: LoadedConfig, environment: WorkerEnvironment): string {
	if (environment.kind === "sandbox") {
		return environment.resolve(config.config.workers.worktreesDirectory || ".alive-workers/worktrees");
	}
	return worktreesRoot(config.paths, config.config.workers.worktreesDirectory);
}

function listHostDirectories(root: string): DirectoryEntry[] {
	let entries: fs.Dirent[];
	try {
		entries = fs.readdirSync(root, { withFileTypes: true });
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
		throw error;
	}
	const directories: DirectoryEntry[] = [];
	for (const entry of entries) {
		if (!entry.isDirectory()) continue;
		const full = path.join(root, entry.name);
		try {
			const stats = fs.lstatSync(full);
			// Do not follow a symlinked directory out of the worktrees root.
			if (!stats.isDirectory()) continue;
			directories.push({ name: entry.name, path: full, mtimeMs: stats.mtimeMs });
		} catch {
			// The directory disappeared while we were scanning; ignore it.
		}
	}
	// Newest first; the name is a stable tie-breaker for tests and fixtures.
	return directories.sort((a, b) => b.mtimeMs - a.mtimeMs || a.name.localeCompare(b.name));
}

export function hostWorktreeFilesystem(): WorktreeFilesystem {
	return {
		listDirectories: async (root) => listHostDirectories(root),
		measure: async (directory) => measureDirectory(directory).bytes,
		exists: async (target) => fs.existsSync(target),
		remove: async (target) => {
			fs.rmSync(target, { recursive: true, force: true });
		},
	};
}

/**
 * Guest-side adapter used by `alive workers prune` for sandboxed profiles.
 * These are the same coreutils git already relies on inside the VM.
 */
export function sandboxWorktreeFilesystem(env: WorkerEnvironment): WorktreeFilesystem {
	const run = async (argv: string[]): Promise<string> => (await env.run(argv, env.root)).stdout;
	return {
		listDirectories: async (root) => {
			let stdout: string;
			try {
				stdout = await run(["find", root, "-mindepth", "1", "-maxdepth", "1", "-type", "d", "-printf", "%f\t%T@\n"]);
			} catch (error) {
				// A missing root is the normal "nothing to prune" state.
				if (error instanceof Error && /No such file|does not exist/i.test(error.message)) return [];
				throw error;
			}
			const directories: DirectoryEntry[] = [];
			for (const line of stdout.split("\n")) {
				if (!line.trim()) continue;
				const tab = line.lastIndexOf("\t");
				if (tab < 0) continue;
				const name = line.slice(0, tab);
				const seconds = Number(line.slice(tab + 1));
				directories.push({
					name,
					path: env.join(root, name),
					mtimeMs: Number.isFinite(seconds) ? seconds * 1000 : Date.now(),
				});
			}
			return directories.sort((a, b) => b.mtimeMs - a.mtimeMs || a.name.localeCompare(b.name));
		},
		measure: async (directory) => {
			try {
				const stdout = await run(["du", "-sb", directory]);
				const bytes = Number.parseInt(stdout.trim().split(/\s+/)[0] ?? "", 10);
				if (Number.isFinite(bytes) && bytes >= 0) return bytes;
			} catch {
				// Fall through to a recursive `find` sum when du is unavailable.
			}
			const stdout = await run(["find", directory, "-type", "f", "-printf", "%s\n"]);
			let bytes = 0;
			for (const line of stdout.split("\n")) {
				const size = Number.parseInt(line.trim(), 10);
				if (Number.isFinite(size)) bytes += size;
			}
			return bytes;
		},
		exists: async (target) => {
			try {
				await env.run(["test", "-e", target], env.root);
				return true;
			} catch {
				return false;
			}
		},
		remove: async (target) => {
			await env.run(["rm", "-rf", "--", target], env.root);
		},
	};
}

function filesystemFor(env: WorkerEnvironment): WorktreeFilesystem {
	return env.kind === "sandbox" ? sandboxWorktreeFilesystem(env) : hostWorktreeFilesystem();
}

/**
 * Recursively measure a directory without external utilities (`du`, `find`).
 * Returns the bytes seen so far when the deadline is hit, with `complete: false`.
 */
export function measureDirectory(
	root: string,
	options: { timeoutMs?: number; now?: () => number } = {},
): { bytes: number; complete: boolean; elapsedMs: number } {
	const now = options.now ?? Date.now;
	const timeoutMs = options.timeoutMs ?? Number.POSITIVE_INFINITY;
	const startedAt = now();
	let bytes = 0;
	let complete = true;
	const stack: string[] = [root];
	while (stack.length > 0) {
		// Checking every entry keeps a huge tree from overrunning the caller's
		// budget by more than one directory read.
		if (now() - startedAt > timeoutMs) {
			complete = false;
			break;
		}
		const current = stack.pop()!;
		let stats: fs.Stats;
		try {
			stats = fs.lstatSync(current);
		} catch {
			continue;
		}
		if (stats.isSymbolicLink()) {
			// Count the link itself, never its target.
			bytes += stats.size;
			continue;
		}
		if (stats.isDirectory()) {
			let entries: string[];
			try {
				entries = fs.readdirSync(current);
			} catch {
				continue;
			}
			for (const entry of entries) stack.push(path.join(current, entry));
			continue;
		}
		if (stats.isFile()) bytes += stats.size;
	}
	return { bytes, complete, elapsedMs: now() - startedAt };
}

export interface WorktreesUsage {
	path: string;
	count: number;
	/** `null` when the scan exceeded its time budget. */
	bytes: number | null;
	complete: boolean;
}

/** Count and size the worktree directories under `root` with a hard time budget. */
export function measureWorktrees(
	root: string,
	options: { timeoutMs?: number; now?: () => number } = {},
): WorktreesUsage {
	let count = 0;
	try {
		count = fs.readdirSync(root, { withFileTypes: true }).filter((entry) => entry.isDirectory()).length;
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") {
			return { path: root, count: 0, bytes: 0, complete: true };
		}
		// A status line must not fail because a state directory is unreadable.
		return { path: root, count: 0, bytes: null, complete: false };
	}
	const scan = measureDirectory(root, {
		timeoutMs: options.timeoutMs ?? STATUS_SIZE_TIMEOUT_MS,
		now: options.now,
	});
	return { path: root, count, bytes: scan.complete ? scan.bytes : null, complete: scan.complete };
}

async function commonRepository(env: WorkerEnvironment, worktreePath: string): Promise<string | undefined> {
	try {
		const { stdout } = await runGit(env, worktreePath, ["rev-parse", "--git-common-dir"]);
		const common = stdout.trim();
		if (!common) return undefined;
		const absolute = path.isAbsolute(common) ? common : path.resolve(worktreePath, common);
		// A linked worktree reports `<repo>/.git`; a bare repository reports `.`.
		return path.basename(absolute) === ".git" ? path.dirname(absolute) : absolute;
	} catch {
		return undefined;
	}
}

async function removeWorktreeDirectory(
	env: WorkerEnvironment,
	filesystem: WorktreeFilesystem,
	worktreePath: string,
	repositoryPath: string | undefined,
): Promise<void> {
	const repository = repositoryPath ?? await commonRepository(env, worktreePath);
	if (repository) {
		try {
			// `git worktree remove` owns the registration; the explicit fallback
			// below also covers a directory that is no longer registered.
			await runGit(env, repository, ["worktree", "remove", "--force", worktreePath]);
		} catch {
			await filesystem.remove(worktreePath);
		}
		await runGit(env, repository, ["worktree", "prune"]).catch(() => undefined);
	} else {
		await filesystem.remove(worktreePath);
	}
	if (await filesystem.exists(worktreePath)) throw new Error(`failed to remove worktree directory: ${worktreePath}`);
}

/**
 * Remove stale worker worktrees.
 *
 * Safety rules, in this order:
 * 1. worktrees of active/interrupted workers are never touched (`active`);
 * 2. worktrees with uncommitted changes are never touched (`dirty`);
 * 3. the `keep` newest clean worktrees are retained (`recent`);
 * 4. with `olderThanDays`, younger clean worktrees are retained (`younger`).
 *
 * Branches are never deleted. Only direct child directories of `root` are
 * considered, so the configured worktrees parent can never broaden the scan.
 */
export async function pruneWorkerWorktrees(options: PruneWorktreesOptions): Promise<WorktreePruneResult> {
	const keep = options.keep ?? DEFAULT_WORKTREE_KEEP;
	if (!Number.isInteger(keep) || keep < 0) throw new Error("keep must be a non-negative integer");
	const olderThanDays = options.olderThanDays;
	if (olderThanDays !== undefined && (!Number.isFinite(olderThanDays) || olderThanDays < 0)) {
		throw new Error("olderThanDays must be a non-negative number");
	}
	const now = options.now ?? Date.now();
	const dryRun = options.dryRun === true;
	const filesystem = options.filesystem ?? filesystemFor(options.environment);
	const records = options.records ?? [];
	const activePaths = new Set(
		records
			.filter((record) => PROTECTED_WORKER_STATUSES.has(record.status))
			.map((record) => options.environment.resolve(record.workspacePath)),
	);
	const activeIds = new Set(
		records.filter((record) => PROTECTED_WORKER_STATUSES.has(record.status)).map((record) => record.id),
	);
	const repositoryByPath = new Map(
		records.map((record) => [options.environment.resolve(record.workspacePath), record.repositoryPath] as const),
	);

	const directories = await filesystem.listDirectories(options.root);
	const entries: WorktreePruneEntry[] = [];
	const counts = emptyCounts();
	const clean: DirectoryEntry[] = [];

	const skip = (directory: DirectoryEntry, reason: WorktreePruneSkipReason, detail?: string): void => {
		counts[reason] += 1;
		entries.push({
			name: directory.name,
			path: directory.path,
			bytes: null,
			ageDays: Math.max(0, (now - directory.mtimeMs) / DAY_MS),
			action: "skipped",
			reason,
			...(detail ? { detail } : {}),
		});
	};

	for (const directory of directories) {
		const active = activeIds.has(directory.name) || activePaths.has(options.environment.resolve(directory.path));
		if (active) {
			skip(directory, "active");
			continue;
		}
		try {
			const state = await gitState(options.environment, directory.path);
			if (!state.clean) {
				skip(directory, "dirty");
				continue;
			}
		} catch (error) {
			// A directory git cannot read is not safe to delete automatically.
			skip(directory, "error", error instanceof Error ? error.message : String(error));
			continue;
		}
		clean.push(directory);
	}

	const retained = new Set(clean.slice(0, keep).map((directory) => directory.path));
	let removed = 0;
	let skipped = 0;
	let freedBytes = 0;

	for (const directory of clean) {
		const ageDays = Math.max(0, (now - directory.mtimeMs) / DAY_MS);
		if (retained.has(directory.path)) {
			skip(directory, "recent");
			continue;
		}
		if (olderThanDays !== undefined && ageDays < olderThanDays) {
			skip(directory, "younger");
			continue;
		}
		const bytes = await filesystem.measure(directory.path);
		if (!dryRun) {
			try {
				await removeWorktreeDirectory(
					options.environment,
					filesystem,
					directory.path,
					repositoryByPath.get(options.environment.resolve(directory.path)),
				);
			} catch (error) {
				skip(directory, "error", error instanceof Error ? error.message : String(error));
				continue;
			}
		}
		entries.push({
			name: directory.name,
			path: directory.path,
			bytes,
			ageDays,
			action: "removed",
		});
		removed += 1;
		freedBytes += bytes;
	}

	// Keep a stable newest-first order in the machine-readable output.
	entries.sort((a, b) => a.ageDays - b.ageDays || a.name.localeCompare(b.name));
	for (const count of Object.values(counts)) skipped += count;
	return {
		root: options.root,
		dryRun,
		keep,
		olderThanDays: olderThanDays ?? null,
		scanned: directories.length,
		removed,
		skipped,
		freedBytes,
		skippedByReason: counts,
		entries,
	};
}
