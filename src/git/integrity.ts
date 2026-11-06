import * as path from "node:path";

/**
 * Minimal execution boundary for integrity checks. `WorkerEnvironment` satisfies
 * it structurally, which keeps this module independent of the worker runtime.
 */
export interface GitCommandRunner {
	run(argv: string[], cwd: string, options?: { timeoutMs?: number }): Promise<{ stdout: string; stderr: string }>;
}

export interface RepositoryIntegrityIssue {
	kind: "fsck" | "empty-object" | "scan";
	detail: string;
	objects?: string[];
}

export interface RepositoryIntegrityReport {
	repositoryPath: string;
	gitDir?: string;
	range?: string;
	fsckOk: boolean;
	/** Trimmed and capped; includes both stdout and stderr from git fsck. */
	fsckOutput: string;
	/** Hashes of zero-byte loose objects; non-loose paths are kept verbatim. */
	emptyObjects: string[];
	problems: RepositoryIntegrityIssue[];
	blocking: RepositoryIntegrityIssue[];
}

export interface RepositoryIntegrityOptions {
	range?: string;
	timeoutMs?: number;
}

const DEFAULT_TIMEOUT_MS = 120_000;
const FSCK_OUTPUT_CAP = 4_000;
const MAX_DETAIL_OBJECTS = 10;
const MAX_ERROR_OBJECTS = 5;

/**
 * Check the shared object store a worker push or a merge would use.
 *
 * Plain `git fsck` catches empty blobs but its cost grows with the whole
 * repository. `--connectivity-only` is cheap, but it skips blob contents, so a
 * zero-byte loose object can sit in a reachable tree without a word. The scan
 * below is the second half of the check: it notices exactly the failure mode
 * that motivated issue #216 (a sandbox filesystem flap truncating loose
 * objects) without paying full fsck cost on every push.
 *
 * The range bounds what can block: an empty object outside the commits being
 * pushed is logged as a problem but does not stop an otherwise valid push.
 */
export async function checkRepositoryIntegrity(
	runner: GitCommandRunner,
	repositoryPath: string,
	options: RepositoryIntegrityOptions = {},
): Promise<RepositoryIntegrityReport> {
	const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
	const range = options.range?.trim() || undefined;
	const report: RepositoryIntegrityReport = {
		repositoryPath,
		range,
		fsckOk: false,
		fsckOutput: "",
		emptyObjects: [],
		problems: [],
		blocking: [],
	};

	// Locate the object store first. From a linked worker worktree this is the
	// main checkout's `.git` (via `--git-common-dir`), which is where the worker's
	// objects actually live.
	report.gitDir = await resolveGitDir(runner, repositoryPath, timeoutMs);

	if (report.gitDir) {
		try {
			report.emptyObjects = await scanEmptyObjects(runner, report.gitDir, repositoryPath, timeoutMs);
		} catch (error) {
			report.problems.push({
				kind: "scan",
				detail: `zero-byte object scan failed: ${errorMessage(error)}`,
			});
		}
	} else {
		report.problems.push({
			kind: "scan",
			detail: "could not resolve the git directory; zero-byte object scan skipped",
		});
	}

	try {
		const { stdout, stderr } = await runner.run(["git", "fsck", "--connectivity-only", "--no-progress"], repositoryPath, {
			timeoutMs,
		});
		report.fsckOutput = cap(joinOutput(stdout, stderr));
		report.fsckOk = fsckOutputIsClean(report.fsckOutput, report.emptyObjects);
	} catch (error) {
		// The runner rejects on a non-zero exit; the fsck failure itself is the
		// result here, not an infrastructure error.
		report.fsckOutput = cap(errorMessage(error));
		report.fsckOk = false;
	}

	if (!report.fsckOk) {
		const detail = report.fsckOutput || "git fsck --connectivity-only reported a problem";
		const issue: RepositoryIntegrityIssue = { kind: "fsck", detail };
		report.problems.push(issue);
		report.blocking.push(issue);
	}

	for (const object of report.emptyObjects) {
		report.problems.push({
			kind: "empty-object",
			detail: `zero-byte loose object ${object}`,
			objects: [object],
		});
	}

	const blockingObjects = await selectRangeObjects(runner, repositoryPath, range, report.emptyObjects, timeoutMs, report.problems);
	if (blockingObjects.length > 0) {
		const examples = blockingObjects.slice(0, MAX_DETAIL_OBJECTS);
		const remainder = blockingObjects.length - examples.length;
		report.blocking.push({
			kind: "empty-object",
			detail:
				`${blockingObjects.length} zero-byte git object(s) ${range ? `in ${range}` : "in the repository"}: ` +
				`${examples.join(", ")}${remainder > 0 ? ` (+${remainder} more)` : ""}`,
			objects: blockingObjects,
		});
	}

	return report;
}

/** Throw the operator-facing damage message when anything blocks the operation. */
export function assertRepositoryIntegrity(report: RepositoryIntegrityReport): void {
	if (report.blocking.length === 0) return;
	throw new Error(repositoryIntegrityFailureText(report));
}

/**
 * One source of truth for the text used by the push gate and any CLI caller.
 * Names the count and up to five hashes; the remedy is always to rebuild the
 * commit rather than trusting an object store that just lost bytes.
 */
export function repositoryIntegrityFailureText(report: RepositoryIntegrityReport): string {
	const hashes = [...new Set(report.blocking.flatMap((issue) => issue.objects ?? []))];
	const examples = hashes.slice(0, MAX_ERROR_OBJECTS);
	const count = hashes.length > 0 ? hashes.length : report.blocking.length;
	const named = examples.length > 0 ? ` (${examples.join(", ")}${hashes.length > examples.length ? ", ..." : ""})` : "";
	return (
		`git objects are damaged: ${count} damaged object${count === 1 ? "" : "s"}${named}. ` +
		"This is likely a sandbox filesystem flap rather than a problem with the commit. " +
		"Rebuild the commit in a fresh worktree and push again."
	);
}

async function resolveGitDir(
	runner: GitCommandRunner,
	repositoryPath: string,
	timeoutMs: number,
): Promise<string | undefined> {
	try {
		const { stdout } = await runner.run(
			["git", "rev-parse", "--path-format=absolute", "--git-common-dir"],
			repositoryPath,
			{ timeoutMs },
		);
		const value = stdout.trim();
		if (value) return path.resolve(repositoryPath, value);
	} catch {
		// Older git versions do not know --path-format; fall through.
	}
	try {
		const { stdout } = await runner.run(["git", "rev-parse", "--git-common-dir"], repositoryPath, { timeoutMs });
		const value = stdout.trim();
		if (value) return path.resolve(repositoryPath, value);
	} catch {
		return undefined;
	}
	return undefined;
}

async function scanEmptyObjects(
	runner: GitCommandRunner,
	gitDir: string,
	repositoryPath: string,
	timeoutMs: number,
): Promise<string[]> {
	const objectsDir = path.join(gitDir, "objects");
	const { stdout } = await runner.run(["find", objectsDir, "-type", "f", "-size", "0"], repositoryPath, { timeoutMs });
	const objects: string[] = [];
	for (const raw of stdout.split("\n")) {
		const line = raw.trim();
		if (!line) continue;
		const loose = /[\\/]objects[\\/]([0-9a-f]{2})[\\/]([0-9a-f]{38})$/i.exec(line);
		objects.push(loose ? `${loose[1]}${loose[2]}`.toLowerCase() : line);
	}
	return [...new Set(objects)].sort();
}

/**
 * Intersect the empty set with the pushed range. A rev-list failure is itself
 * a sign the repository cannot be trusted; conservatively block on every empty
 * object instead of silently letting an unreadable range through.
 */
async function selectRangeObjects(
	runner: GitCommandRunner,
	repositoryPath: string,
	range: string | undefined,
	emptyObjects: string[],
	timeoutMs: number,
	problems: RepositoryIntegrityIssue[],
): Promise<string[]> {
	if (emptyObjects.length === 0) return [];
	if (!range) return emptyObjects;
	try {
		const { stdout } = await runner.run(["git", "rev-list", "--objects", range], repositoryPath, { timeoutMs });
		const inRange = new Set<string>();
		for (const line of stdout.split("\n")) {
			const hash = line.trim().split(/\s+/, 1)[0];
			if (hash) inRange.add(hash.toLowerCase());
		}
		return emptyObjects.filter((object) => inRange.has(object.toLowerCase()));
	} catch (error) {
		problems.push({
			kind: "scan",
			detail: `could not list objects in ${range}; treating every zero-byte object as blocking: ${errorMessage(error)}`,
		});
		return emptyObjects;
	}
}

/**
 * fsck's simple pass/fail rule, with one exception: connectivity-only still
 * complains about *unreachable* empty loose objects that the scan already
 * found. Those lines are the scan's job; without filtering them, unrelated
 * cruft would block a valid push, which is explicitly not wanted. Any line
 * that does not name a known zero-byte object still fails the check.
 */
function fsckOutputIsClean(output: string, emptyObjects: string[]): boolean {
	const known = new Set(emptyObjects.map((object) => object.toLowerCase()));
	for (const raw of output.split("\n")) {
		const line = raw.trim();
		if (!line) continue;
		if (known.size > 0 && mentionsKnownEmptyObject(line, known)) continue;
		if (/^(error|fatal|missing)\b/i.test(line)) return false;
		if (/corrupt/i.test(line)) return false;
	}
	return true;
}

function mentionsKnownEmptyObject(line: string, known: Set<string>): boolean {
	const lower = line.toLowerCase();
	for (const object of known) {
		if (lower.includes(object)) return true;
		// Loose-object messages name the split path (ab/cdef…) rather than the
		// 40-character hash, so match that form too.
		const loosePath = `${object.slice(0, 2)}/${object.slice(2)}`;
		if (lower.includes(loosePath) || lower.includes(loosePath.replace("/", "\\"))) return true;
	}
	return false;
}

function joinOutput(stdout: string, stderr: string): string {
	return [stdout, stderr]
		.map((value) => value.trim())
		.filter(Boolean)
		.join("\n")
		.trim();
}

function cap(value: string): string {
	const trimmed = value.trim();
	if (trimmed.length <= FSCK_OUTPUT_CAP) return trimmed;
	return `${trimmed.slice(0, FSCK_OUTPUT_CAP)}\n... (truncated)`;
}

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}
