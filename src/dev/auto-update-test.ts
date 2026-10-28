/**
 * Auto-update tests (`alive update --auto` and the external watchdog).
 *
 * The TypeScript half uses the same in-memory checkout as update-test.ts: a fake
 * command runner and an in-memory filesystem, so no real git, npm, network or
 * filesystem access happens. The auto probe (config, heartbeat age, runtime
 * state, clock) is injected directly.
 *
 * The watchdog half runs the real deploy/update/alive-auto-update.sh in a temp
 * directory with a fake `alive` binary and a fake restart command. All state
 * (heartbeat, calls, log) stays inside that temp directory; the real `.alive/`
 * and any real restart command are never touched.
 *
 *   npm run test:auto-update
 */
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import {
	CommandFailure,
	DIST_DIR,
	UPDATE_MARKER_FILE,
	autoBusyReason,
	isInsideUpdateWindow,
	type CommandRunner,
	type RunOptions,
	type RunResult,
	type UpdateDeps,
	type UpdateFileOps,
	type UpdateMarker,
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

type FakeRef = { kind: "branch"; name: string } | { kind: "tag"; name: string } | { kind: "detached"; name: string };

interface FakeRepoOptions {
	start?: FakeRef;
	tags?: string[];
	dirty?: string[];
	failBuild?: (ref: FakeRef) => boolean;
	initialFiles?: Record<string, string>;
}

interface FakeCall {
	command: string;
	args: string[];
	cwd?: string;
}

interface FakeFileOps extends UpdateFileOps {
	files: Map<string, string>;
	dirs: Set<string>;
}

interface FakeRepo {
	root: string;
	calls: FakeCall[];
	fs: FakeFileOps;
	run: CommandRunner;
	ref: () => FakeRef;
}

function createFakeFs(initialFiles: Record<string, string>): FakeFileOps {
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
		for (const file of [...files.keys()]) if (matches(file, target)) files.delete(file);
		for (const dir of [...dirs]) if (matches(dir, target)) dirs.delete(dir);
	};

	return {
		files,
		dirs,
		readText: async (file) => files.get(file),
		writeText: async (file, text) => {
			files.set(file, text);
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
		},
		remove,
	};
}

function createFakeRepo(options: FakeRepoOptions = {}): FakeRepo {
	const tags = options.tags ?? [];
	const dirty = options.dirty ?? [];
	const calls: FakeCall[] = [];
	const fsOps = createFakeFs(options.initialFiles ?? {});
	let ref: FakeRef = options.start ?? { kind: "branch", name: "main" };
	const commitOf = (value: FakeRef): string => `sha-${value.kind}-${value.name}`;
	const ok = (stdout = ""): RunResult => ({ stdout, stderr: "" });
	const fail = (command: string, args: string[], detail: string): never => {
		throw new CommandFailure(command, args, 1, "", detail);
	};

	const run: CommandRunner = async (command, args, runOptions: RunOptions = {}): Promise<RunResult> => {
		calls.push({ command, args: [...args], cwd: runOptions.cwd });

		if (command === "git") {
			switch (args[0]) {
				case "rev-parse":
					if (args.includes("--show-toplevel")) return ok(`${ROOT}\n`);
					if (args.includes("--abbrev-ref")) return ok(`${ref.kind === "branch" ? ref.name : "HEAD"}\n`);
					return ok(`${commitOf(ref)}\n`);
				case "fetch":
					return ok();
				case "tag":
					return ok(tags.length ? `${tags.join("\n")}\n` : "");
				case "describe":
					if (ref.kind !== "tag") return fail("git", args, "fatal: no tag exactly matches 'HEAD'");
					return ok(`${ref.name}\n`);
				case "status":
					return ok(dirty.length ? `${dirty.join("\n")}\n` : "");
				case "checkout": {
					const target = args[1];
					if (!target) return fail("git", args, "error: missing checkout target");
					ref = tags.includes(target) ? { kind: "tag", name: target } : { kind: "branch", name: target };
					return ok();
				}
				default:
					return fail("git", args, `unexpected git command: ${args.join(" ")}`);
			}
		}

		if (command === "npm") {
			if (args[0] === "ci") return ok();
			if (args[0] === "run" && args[1] === "build") {
				if (options.failBuild?.(ref)) return fail("npm", args, "error TS1005: build failed in the test");
				await fsOps.writeText(DIST_FILE, `build-${ref.kind}-${ref.name}`);
				return ok();
			}
			return fail("npm", args, `unexpected npm command: ${args.join(" ")}`);
		}

		if (command === "node") {
			if (args[0] !== "dist/index.js" || args[1] !== "--help") {
				return fail("node", args, `unexpected health command: ${args.join(" ")}`);
			}
			return ok();
		}

		return fail(command, args, `unexpected command: ${command}`);
	};

	return { root: ROOT, calls, fs: fsOps, run, ref: () => ref };
}

interface AutoOptions {
	auto?: boolean;
	window?: string;
	heartbeatAgeMs?: number;
	/** undefined means "omit" (idle default); null means "runtime.json unreadable". */
	runtimeStatus?: string | null;
	runtimeRunId?: string;
	now?: Date;
}

interface Harness {
	deps: UpdateDeps;
	out: string[];
	err: string[];
}

function harness(repo: FakeRepo, options: AutoOptions = {}): Harness {
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
			readPackageVersion: async () => "0.1.0",
			now: () => "2024-03-01T12:00:00.000Z",
			auto: {
				updates: { auto: options.auto ?? true, window: options.window ?? "" },
				heartbeatAgeMs: options.heartbeatAgeMs,
				runtimeStatus: options.runtimeStatus === null ? undefined : (options.runtimeStatus ?? "idle"),
				runtimeRunId: options.runtimeRunId,
				now: options.now ?? new Date(2024, 2, 1, 12, 0, 0),
			},
		},
	};
}

function marker(overrides: Partial<UpdateMarker> = {}): UpdateMarker {
	return {
		previousRef: "main",
		previousTag: "v0.1.0",
		targetTag: "v0.2.0",
		startedAt: "2024-01-01T00:00:00.000Z",
		finishedAt: "2024-01-01T00:05:00.000Z",
		outcome: "success",
		...overrides,
	};
}

function markerContents(overrides: Partial<UpdateMarker> = {}): string {
	return `${JSON.stringify(marker(overrides), null, 2)}\n`;
}

function markerWrites(repo: FakeRepo): UpdateMarker[] {
	// writeText is the only writer; read the final file after the run instead of
	// instrumenting every write. Tests that need history use `repo.fs.files`.
	const raw = repo.fs.files.get(MARKER_FILE);
	return raw ? [JSON.parse(raw) as UpdateMarker] : [];
}

function commandLines(repo: FakeRepo): string[] {
	return repo.calls.map((call) => `${call.command} ${call.args.join(" ")}`);
}

const TAGS = ["v0.1.0", "v0.2.0", "v0.3.0-rc.1"];
const EXISTING_MARKER = { [UPDATE_MARKER_FILE]: markerContents() };

async function typescriptTests(): Promise<void> {
	section("maintenance-window helper");
	const at = (hours: number, minutes: number): Date => new Date(2024, 2, 1, hours, minutes, 0);
	check("empty window allows any time", isInsideUpdateWindow("", at(12, 0)));
	check("inside a normal window", isInsideUpdateWindow("04:00-05:00", at(4, 30)));
	check("window start is inclusive", isInsideUpdateWindow("04:00-05:00", at(4, 0)));
	check("window end is exclusive", !isInsideUpdateWindow("04:00-05:00", at(5, 0)));
	check("outside a normal window", !isInsideUpdateWindow("04:00-05:00", at(12, 0)));
	check("window across midnight, late side", isInsideUpdateWindow("23:00-02:00", at(23, 30)));
	check("window across midnight, early side", isInsideUpdateWindow("23:00-02:00", at(1, 0)));
	check("outside a window across midnight", !isInsideUpdateWindow("23:00-02:00", at(12, 0)));
	check("malformed window disables auto-updates", !isInsideUpdateWindow("4:00-5:00", at(4, 30)));
	check("zero-length window disables auto-updates", !isInsideUpdateWindow("04:00-04:00", at(4, 0)));

	section("--auto guard: updates.auto is false");
	{
		const repo = createFakeRepo({ tags: TAGS, initialFiles: EXISTING_MARKER });
		const h = harness(repo, { auto: false });
		const code = await runUpdate({ cwd: ROOT, auto: true }, h.deps);
		check("exits 0", code === 0, code);
		check("logs the disabled guard", h.out.join("\n").includes("updates.auto is false"), h.out);
		check("does not touch git or npm", repo.calls.length === 0, commandLines(repo));
		check("leaves the marker untouched", repo.fs.files.get(MARKER_FILE) === EXISTING_MARKER[UPDATE_MARKER_FILE]);
	}

	section("--auto guard: outside updates.window");
	{
		const repo = createFakeRepo({ tags: TAGS, initialFiles: EXISTING_MARKER });
		const h = harness(repo, { window: "02:00-03:00", now: new Date(2024, 2, 1, 12, 0, 0) });
		const code = await runUpdate({ cwd: ROOT, auto: true }, h.deps);
		check("exits 0", code === 0, code);
		check("logs the window refusal with local time", h.out.join("\n").includes("outside updates.window 02:00-03:00 at local 12:00"), h.out);
		check("does not fetch or apply", repo.calls.length === 0, commandLines(repo));
	}

	section("--auto guard: runtime is busy");
	{
		const repo = createFakeRepo({ tags: TAGS, initialFiles: EXISTING_MARKER });
		const h = harness(repo, { heartbeatAgeMs: 5_000, runtimeStatus: "working", runtimeRunId: "run-7" });
		const code = await runUpdate({ cwd: ROOT, auto: true }, h.deps);
		check("exits 0", code === 0, code);
		check("logs the active run", h.out.join("\n").includes("run run-7 is in progress"), h.out);
		check("does not fetch or apply", repo.calls.length === 0, commandLines(repo));
	}
	{
		const repo = createFakeRepo({ tags: TAGS, initialFiles: EXISTING_MARKER });
		const h = harness(repo, { heartbeatAgeMs: 5_000, runtimeStatus: "starting" });
		const code = await runUpdate({ cwd: ROOT, auto: true }, h.deps);
		check("a starting runtime is also busy", code === 0 && h.out.join("\n").includes("still starting"), h.out);
	}
	{
		const repo = createFakeRepo({ tags: TAGS, initialFiles: EXISTING_MARKER });
		const h = harness(repo, { heartbeatAgeMs: 5_000, runtimeStatus: null });
		const code = await runUpdate({ cwd: ROOT, auto: true }, h.deps);
		check("fresh heartbeat + unreadable runtime.json is conservative", code === 0 && h.out.join("\n").includes("runtime.json is unreadable"), h.out);
		check("conservative busy check runs no git command", repo.calls.length === 0, commandLines(repo));
	}
	{
		const repo = createFakeRepo({ start: { kind: "tag", name: "v0.2.0" }, tags: TAGS, initialFiles: EXISTING_MARKER });
		const h = harness(repo, { heartbeatAgeMs: 600_000, runtimeStatus: "working" });
		const code = await runUpdate({ cwd: ROOT, auto: true }, h.deps);
		check("a stale heartbeat (dead process) is not busy", code === 0 && h.out.join("\n").includes("no newer stable tag"), h.out);
		check("stale heartbeat proceeds to the tag check", commandLines(repo).some((line) => line.startsWith("git fetch")), commandLines(repo));
		check("autoBusyReason agrees", autoBusyReason({ updates: { auto: true, window: "" }, heartbeatAgeMs: 600_000, runtimeStatus: "working", now: new Date() }) === undefined);
	}

	section("--auto guard: no newer stable tag");
	{
		const repo = createFakeRepo({ start: { kind: "tag", name: "v0.2.0" }, tags: TAGS, initialFiles: EXISTING_MARKER });
		const h = harness(repo, { heartbeatAgeMs: 600_000 });
		const code = await runUpdate({ cwd: ROOT, auto: true }, h.deps);
		check("exits 0", code === 0, code);
		check("explains that no tag is newer", h.out.join("\n").includes("no newer stable tag"), h.out);
		check("does not apply", !commandLines(repo).some((line) => line.startsWith("git checkout") || line.startsWith("npm ") || line.startsWith("node ")), commandLines(repo));
		check("writes no marker", repo.fs.files.get(MARKER_FILE) === EXISTING_MARKER[UPDATE_MARKER_FILE]);
	}
	{
		const repo = createFakeRepo({ start: { kind: "tag", name: "v0.2.0" }, tags: ["v0.3.0-rc.1"], initialFiles: EXISTING_MARKER });
		const h = harness(repo);
		const code = await runUpdate({ cwd: ROOT, auto: true }, h.deps);
		check("prereleases never trigger auto-updates", code === 0 && h.out.join("\n").includes("no stable vX.Y.Z tags"), h.out);
	}

	section("--auto guard: corrupt or missing marker");
	{
		const repo = createFakeRepo({ tags: TAGS, initialFiles: { [UPDATE_MARKER_FILE]: "{ not json" } });
		const h = harness(repo);
		const code = await runUpdate({ cwd: ROOT, auto: true }, h.deps);
		check("corrupt marker exits 0", code === 0, code);
		check("corrupt marker is logged", h.out.join("\n").includes("is corrupt"), h.out);
		check("corrupt marker changes nothing", !repo.calls.some((call) => call.args[0] === "fetch" || call.args[0] === "checkout" || call.command === "npm"), commandLines(repo));
		check("corrupt marker is left on disk", repo.fs.files.get(MARKER_FILE) === "{ not json");
	}
	{
		const repo = createFakeRepo({ tags: TAGS });
		const h = harness(repo);
		const code = await runUpdate({ cwd: ROOT, auto: true }, h.deps);
		check("missing marker exits 0", code === 0, code);
		check("missing marker is logged with the baseline hint", h.out.join("\n").includes("update marker is missing") && h.out.join("\n").includes("baseline"), h.out);
		check("missing marker does not apply", !repo.calls.some((call) => call.args[0] === "fetch" || call.args[0] === "checkout" || call.command === "npm"), commandLines(repo));
		check("missing marker stays missing", repo.fs.files.get(MARKER_FILE) === undefined);
	}
	{
		const repo = createFakeRepo({ tags: TAGS, initialFiles: { [UPDATE_MARKER_FILE]: markerContents({ outcome: "in-progress" }) } });
		const h = harness(repo);
		const code = await runUpdate({ cwd: ROOT, auto: true }, h.deps);
		check("an interrupted update blocks auto mode", code === 0 && h.out.join("\n").includes("update is in progress"), h.out);
	}

	section("--auto applies, exits 10 and requests a restart");
	{
		const repo = createFakeRepo({ tags: TAGS, initialFiles: EXISTING_MARKER });
		const h = harness(repo);
		const code = await runUpdate({ cwd: ROOT, auto: true }, h.deps);
		check("exits 10", code === 10, code);
		check("checks out the newest stable tag", repo.ref().kind === "tag" && repo.ref().name === "v0.2.0", repo.ref());
		check(
			"runs the normal apply path",
			commandLines(repo).includes("git fetch --tags --quiet origin") &&
				commandLines(repo).includes("git checkout v0.2.0") &&
				commandLines(repo).includes("npm ci --prefer-offline") &&
				commandLines(repo).includes("npm run build") &&
				commandLines(repo).includes("node dist/index.js --help"),
			commandLines(repo),
		);
		const final = markerWrites(repo)[0];
		check("marker records success", final?.outcome === "success", final);
		check("marker records the target tag", final?.targetTag === "v0.2.0", final);
		check("marker has restartRequested: true", final?.restartRequested === true, final);
		check("output explains the exit-10 contract", h.out.join("\n").includes("restart requested") && h.out.join("\n").includes("exiting 10"), h.out);
		check("auto never restarts or stops anything", !repo.calls.some((call) => call.command === "alive" || call.args.includes("restart") || call.args.includes("stop")), commandLines(repo));
	}

	section("--auto failure inside apply rolls back and exits 1");
	{
		const repo = createFakeRepo({
			tags: TAGS,
			initialFiles: { ...EXISTING_MARKER, [DIST_FILE]: "old-build" },
			failBuild: (ref) => ref.kind === "tag" && ref.name === "v0.2.0",
		});
		const h = harness(repo);
		const code = await runUpdate({ cwd: ROOT, auto: true }, h.deps);
		check("exits 1, not 10", code === 1, code);
		check("rolls back to the previous ref", repo.ref().kind === "branch" && repo.ref().name === "main", repo.ref());
		const final = markerWrites(repo)[0];
		check("marker ends rolled-back", final?.outcome === "rolled-back", final);
		check("marker does not request a restart", final?.restartRequested !== true, final);
		check("reports the original failure", h.err.join("\n").includes("build failed in the test"), h.err);
		check("never restarts anything", !repo.calls.some((call) => call.command === "alive"), commandLines(repo));
	}
}

/** Spawn a fake tool with a small, explicit environment. */
interface WatchdogRun {
	status: number | null;
	stderr: string;
}

function writeExecutable(file: string, contents: string): void {
	fs.writeFileSync(file, contents, "utf8");
	fs.chmodSync(file, 0o755);
}

function watchdogTest(): void {
	section("watchdog: no update (exit 0)");
	const script = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../deploy/update/alive-auto-update.sh");
	const temp = fs.mkdtempSync(path.join(os.tmpdir(), "alive-auto-update-"));
	try {
		const repoDir = path.join(temp, "repo dir");
		const stateDir = path.join(temp, "state dir");
		const binDir = path.join(temp, "bin");
		fs.mkdirSync(repoDir, { recursive: true });
		fs.mkdirSync(stateDir, { recursive: true });
		fs.mkdirSync(binDir, { recursive: true });

		const callsFile = path.join(temp, "calls.txt");
		const restartCount = path.join(temp, "restart-count.txt");
		const heartbeatFile = path.join(stateDir, "heartbeat.json");
		const restartScript = path.join(temp, "restart.sh");

		writeExecutable(
			path.join(binDir, "alive"),
			`#!/usr/bin/env bash
set -euo pipefail
printf '%s\\n' "alive $*" >> "$FAKE_CALLS"
case "\${2:-}" in
  --auto) printf '%s\\n' "fake auto output"; exit "\${FAKE_AUTO_EXIT:-0}" ;;
  --rollback) printf '%s\\n' "fake rollback output"; exit "\${FAKE_ROLLBACK_EXIT:-0}" ;;
  *) printf 'unexpected alive arguments: %s\\n' "$*" >&2; exit 64 ;;
esac
`,
		);
		writeExecutable(
			restartScript,
			`#!/usr/bin/env bash
set -euo pipefail
count="$(cat "$FAKE_RESTART_COUNT" 2>/dev/null || printf '0')"
count=$((count + 1))
printf '%s' "$count" > "$FAKE_RESTART_COUNT"
printf 'restart %s\\n' "$count" >> "$FAKE_CALLS"
if (( count >= \${FAKE_HEARTBEAT_AFTER:-1} )); then
  started="$("$NODE_BIN" -e 'process.stdout.write(new Date().toISOString())')"
  printf '{"pid": 1, "startedAt": "%s", "version": "0.0.0"}\\n' "$started" > "$FAKE_HEARTBEAT"
fi
`,
		);

		const runWatchdog = (options: { autoExit: number; heartbeatAfter: number; rollbackExit?: number }): WatchdogRun => {
			fs.rmSync(callsFile, { force: true });
			fs.rmSync(restartCount, { force: true });
			fs.rmSync(heartbeatFile, { force: true });
			fs.rmSync(path.join(stateDir, "logs", "auto-update.log"), { force: true });
			const env = {
				...process.env,
				PATH: `${binDir}${path.delimiter}${process.env.PATH ?? ""}`,
				ALIVE_BIN: "alive",
				NODE_BIN: process.execPath,
				ALIVE_UPDATE_RESTART_TIMEOUT_SEC: "1",
				ALIVE_UPDATE_POLL_INTERVAL_SEC: "1",
				FAKE_CALLS: callsFile,
				FAKE_RESTART_COUNT: restartCount,
				FAKE_HEARTBEAT: heartbeatFile,
				FAKE_AUTO_EXIT: String(options.autoExit),
				FAKE_HEARTBEAT_AFTER: String(options.heartbeatAfter),
				FAKE_ROLLBACK_EXIT: String(options.rollbackExit ?? 0),
			};
			const result = spawnSync("bash", [script, repoDir, stateDir, `"${restartScript}"`], {
				encoding: "utf8",
				env,
				timeout: 30_000,
			});
			return { status: result.status, stderr: result.stderr ?? "" };
		};
		const calls = (): string => (fs.existsSync(callsFile) ? fs.readFileSync(callsFile, "utf8") : "");
		const log = (): string => {
			const file = path.join(stateDir, "logs", "auto-update.log");
			return fs.existsSync(file) ? fs.readFileSync(file, "utf8") : "";
		};

		{
			const result = runWatchdog({ autoExit: 0, heartbeatAfter: 1 });
			check("no-update watchdog exits 0", result.status === 0, result);
			check("no-update logs the no-op", log().includes("no update (alive update --auto exited 0)"), log());
			check("no-update never runs the restart command", !calls().includes("restart"), calls());
			check("no-update creates no heartbeat", !fs.existsSync(heartbeatFile));
		}

		section("watchdog: update applied and restart healthy (exit 0)");
		{
			const result = runWatchdog({ autoExit: 10, heartbeatAfter: 1 });
			check("healthy restart exits 0", result.status === 0, result);
			check("runs auto then exactly one restart", calls() === "alive update --auto\nrestart 1\n", calls());
			check("logs the applied update", log().includes("update applied (alive update --auto exited 10)"), log());
			check("logs the fresh heartbeat", log().includes("fresh heartbeat observed"), log());
			check("logs success", log().includes("success: the harness restarted with the new build"), log());
			check("never rolls back", !calls().includes("rollback"), calls());
		}

		section("watchdog: missing heartbeat -> rollback and second restart");
		{
			const result = runWatchdog({ autoExit: 10, heartbeatAfter: 2 });
			check("a recovered rollback still exits non-zero", result.status === 1, result);
			check(
				"runs auto, restart, rollback, restart",
				calls() === "alive update --auto\nrestart 1\nalive update --rollback\nrestart 2\n",
				calls(),
			);
			check("logs the missing heartbeat", log().includes("no fresh heartbeat within 1s"), log());
			check("logs the rollback decision", log().includes("rolling back with alive update --rollback"), log());
			check("logs the rollback result", log().includes("rollback completed (alive update --rollback exited 0)"), log());
			check("logs the second restart", log().includes("second restart baseline"), log());
			check("logs the recovered state as a failure", log().includes("recovered: rollback was restarted"), log());
		}

		section("watchdog: nothing ever comes back (final failure)");
		{
			const result = runWatchdog({ autoExit: 10, heartbeatAfter: 99 });
			check("final failure exits non-zero", result.status === 1, result);
			check("rolls back after both timeouts", calls() === "alive update --auto\nrestart 1\nalive update --rollback\nrestart 2\n", calls());
			check("logs the fatal outcome", log().includes("FATAL: the harness did not come back"), log());
		}
	} finally {
		fs.rmSync(temp, { recursive: true, force: true });
	}
}

try {
	await typescriptTests();
	watchdogTest();
} catch (error) {
	failures += 1;
	process.stderr.write(`\nUNEXPECTED ERROR: ${error instanceof Error ? (error.stack ?? error.message) : String(error)}\n`);
}

process.stdout.write(failures === 0 ? "\nALL AUTO-UPDATE TESTS PASSED\n" : `\n${failures} AUTO-UPDATE TEST(S) FAILED\n`);
process.exitCode = failures === 0 ? 0 : 1;
