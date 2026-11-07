/**
 * Session transcript hygiene test (#222):
 *
 *   npx tsx src/dev/session-retention-test.ts
 *
 * Filesystem fixtures only: no model, network, or home-directory dependency.
 * Covers `alive sessions gc` (dry run, age, size, keep, active file, archive
 * directory, move failure, JSON), `alive sessions stats` (base64/image
 * measurement), the `alive status` size budget, and the resume guard that
 * refuses a transcript already at the context-sleep threshold.
 */
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { gunzipSync } from "node:zlib";
import { loadConfig, type AliveConfig, type LoadedConfig } from "../config.js";
import { Logger } from "../log.js";
import { main } from "../cli.js";
import { openSessionManager } from "../runtime/session.js";
import {
	ACTIVE_SESSION_MTIME_GUARD_MS,
	DEFAULT_ARCHIVE_DELETE_AFTER_DAYS,
	DEFAULT_ARCHIVE_GZIP_AFTER_DAYS,
	DEFAULT_SESSION_KEEP,
	DEFAULT_SESSION_MAX_SIZE_MB,
	DEFAULT_SESSION_OLDER_THAN_DAYS,
	measureSessionArchives,
	measureSessionFileContext,
	measureSessionStats,
	measureSessions,
	mostRecentSessionFile,
	rotateSessionArchives,
	runSessionGc,
	sessionArchiveDirName,
} from "../runtime/session-retention.js";

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
const silent = new Logger({ console: false });

function makeConfig(root: string, overrides: Partial<AliveConfig> = {}): LoadedConfig {
	return loadConfig({
		cwd: root,
		migrateSecrets: false,
		overrides: { session: "continue", ...overrides },
	});
}

interface Fixture {
	root: string;
	stateDir: string;
	sessions: string;
	config: LoadedConfig;
}

function fixture(name: string): Fixture {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), `alive-session-${name}-`));
	const config = makeConfig(root);
	fs.mkdirSync(config.paths.sessionsDir, { recursive: true });
	return { root, stateDir: config.paths.stateDir, sessions: config.paths.sessionsDir, config };
}

/** A minimal but valid pi transcript with one assistant turn. */
function writeTranscript(file: string, options: { contextTokens?: number; text?: string; image?: string } = {}): void {
	// pi only discovers a transcript whose header cwd matches the workspace.
	const cwd = path.join(path.dirname(path.dirname(file)), "workspace");
	const header = {
		type: "session",
		version: 3,
		id: path.basename(file, ".jsonl"),
		timestamp: new Date().toISOString(),
		cwd,
	};
	const user = {
		type: "message",
		id: "u1",
		parentId: null,
		timestamp: new Date().toISOString(),
		message: { role: "user", content: options.text ?? "hello", timestamp: Date.now() },
	};
	const assistantContent: unknown[] = [{ type: "text", text: options.text ?? "ok" }];
	if (options.image) assistantContent.push({ type: "image", data: options.image, mimeType: "image/png" });
	const assistant = {
		type: "message",
		id: "a1",
		parentId: "u1",
		timestamp: new Date().toISOString(),
		message: {
			role: "assistant",
			content: assistantContent,
			stopReason: "stop",
			usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: options.contextTokens ?? 0, cost: {} },
			timestamp: Date.now(),
		},
	};
	fs.writeFileSync(file, `${[header, user, assistant].map((entry) => JSON.stringify(entry)).join("\n")}\n`, "utf8");
}

function age(file: string, days: number): void {
	const at = new Date(Date.now() - days * DAY_MS);
	fs.utimesSync(file, at, at);
}

function exists(file: string): boolean {
	return fs.existsSync(file);
}

/** `stateDir/sessions-archive-YYYYMMDD-HHMM` fixture directory. */
function archiveDir(fx: Fixture, name: string): string {
	const dir = path.join(fx.stateDir, name);
	fs.mkdirSync(dir, { recursive: true });
	return dir;
}

/** Names, sizes and mtimes of one directory; equal strings mean "nothing changed". */
function snapshot(dir: string): string {
	return fs
		.readdirSync(dir)
		.sort()
		.map((name) => {
			const stats = fs.statSync(path.join(dir, name));
			return `${name}:${stats.size}:${stats.mtimeMs}`;
		})
		.join("|");
}

/** Run `alive ...` against the fixture root and return everything printed. */
async function runCli(root: string, argv: string[]): Promise<string> {
	const out: string[] = [];
	const stdoutWrite = process.stdout.write;
	const cwd = process.cwd();
	process.stdout.write = ((chunk: unknown) => {
		out.push(String(chunk));
		return true;
	}) as typeof process.stdout.write;
	try {
		process.chdir(root);
		const code = await main(argv);
		if (code !== 0) throw new Error(`alive ${argv.join(" ")} exited ${code}`);
	} finally {
		process.chdir(cwd);
		process.stdout.write = stdoutWrite;
	}
	return out.join("");
}

try {
	// -------------------------------------------------------------------------
	section("archive directory name matches the operator's manual convention");
	{
		const at = new Date(2026, 10, 6, 17, 45).getTime();
		check("sessions-archive-YYYYMMDD-HHMM", sessionArchiveDirName(at) === "sessions-archive-20261106-1745", sessionArchiveDirName(at));
		check("defaults: keep 3, 14 days, no size limit", DEFAULT_SESSION_KEEP === 3 && DEFAULT_SESSION_OLDER_THAN_DAYS === 14 && DEFAULT_SESSION_MAX_SIZE_MB === 0);
	}

	// -------------------------------------------------------------------------
	section("gc --dry-run plans but moves nothing");
	{
		const fx = fixture("dry-run");
		const old = path.join(fx.sessions, "2026-01-01T00-00-00-000Z_old.jsonl");
		writeTranscript(old, { text: "old transcript body" });
		age(old, 30);
		const result = runSessionGc({ sessionsDir: fx.sessions, stateDir: fx.stateDir, keep: 0, olderThanDays: 14, dryRun: true, log: silent });
		check("the plan names one archived file", result.archived === 1 && result.entries.some((entry) => entry.action === "archived"), result.entries);
		check("the plan reports freed bytes", result.freedBytes === fs.statSync(old).size && result.freedBytes > 0, result.freedBytes);
		check("nothing was moved", exists(old));
		check("no archive directory was created", !exists(result.archiveDir));
		check("archive path lives in stateDir", path.dirname(result.archiveDir) === fx.stateDir, result.archiveDir);
		fs.rmSync(fx.root, { recursive: true, force: true });
	}

	// -------------------------------------------------------------------------
	section("gc by age archives old files and keeps young ones");
	{
		const fx = fixture("age");
		const old = path.join(fx.sessions, "2026-01-01T00-00-00-000Z_old.jsonl");
		const young = path.join(fx.sessions, "2026-01-02T00-00-00-000Z_young.jsonl");
		writeTranscript(old);
		writeTranscript(young);
		age(old, 20);
		age(young, 2);
		const result = runSessionGc({ sessionsDir: fx.sessions, stateDir: fx.stateDir, keep: 0, olderThanDays: 14, log: silent });
		check("old transcript is archived", result.archived === 1 && !exists(old), result.entries);
		check("young transcript is skipped as younger", result.entries.some((entry) => entry.name.includes("young") && entry.reason === "younger"), result.entries);
		check("young transcript stays", exists(young));
		const archived = path.join(result.archiveDir, path.basename(old));
		check("the file was moved, not deleted", exists(archived) && fs.statSync(archived).size > 0, archived);
		check("the archive directory is named by the timestamp", /^sessions-archive-\d{8}-\d{4}$/.test(path.basename(result.archiveDir)), result.archiveDir);
		check("the source file keeps its name", fs.readdirSync(result.archiveDir).length === 1, fs.readdirSync(result.archiveDir));
		fs.rmSync(fx.root, { recursive: true, force: true });
	}

	// -------------------------------------------------------------------------
	section("gc by total size archives the oldest until the budget fits");
	{
		const fx = fixture("size");
		const files: string[] = [];
		for (let index = 0; index < 5; index += 1) {
			const file = path.join(fx.sessions, `2026-02-0${index + 1}T00-00-00-000Z_s${index}.jsonl`);
			// ~40 KB each: 5 files ≈ 200 KB, a 0.1 MB budget forces archiving.
			writeTranscript(file, { text: "x".repeat(40 * 1024) });
			age(file, 10 - index);
			files.push(file);
		}
		const result = runSessionGc({ sessionsDir: fx.sessions, stateDir: fx.stateDir, keep: 0, olderThanDays: 365, maxSizeMb: 0.1, log: silent });
		const remaining = fs.readdirSync(fx.sessions).length;
		const remainingBytes = fs
			.readdirSync(fx.sessions)
			.reduce((sum, name) => sum + fs.statSync(path.join(fx.sessions, name)).size, 0);
		check("the oldest files are archived first", !exists(files[0]!) && exists(files[4]!), result.entries);
		check("the directory fits the budget", remainingBytes <= 0.1 * 1024 * 1024, { remaining, remainingBytes });
		check("at least one file was archived", result.archived > 0 && result.freedBytes > 0, result);
		check("size decisions are reported", result.entries.some((entry) => entry.action === "archived" && entry.reason === "max-size"), result.entries);
		fs.rmSync(fx.root, { recursive: true, force: true });
	}

	// -------------------------------------------------------------------------
	section("gc --keep leaves the newest N transcripts alone");
	{
		const fx = fixture("keep");
		const files: string[] = [];
		for (let index = 0; index < 4; index += 1) {
			const file = path.join(fx.sessions, `2026-03-0${index + 1}T00-00-00-000Z_k${index}.jsonl`);
			writeTranscript(file);
			age(file, 30 - index);
			files.push(file);
		}
		const result = runSessionGc({ sessionsDir: fx.sessions, stateDir: fx.stateDir, keep: 2, olderThanDays: 0, log: silent });
		check("only the newest two survive", exists(files[2]!) && exists(files[3]!) && !exists(files[0]!) && !exists(files[1]!), result.entries);
		check("kept files are reported as recent", result.entries.filter((entry) => entry.reason === "recent").length === 2, result.entries);
		fs.rmSync(fx.root, { recursive: true, force: true });
	}

	// -------------------------------------------------------------------------
	section("gc never moves the active transcript or a just-written one");
	{
		const fx = fixture("active");
		const active = path.join(fx.sessions, "2026-04-01T00-00-00-000Z_active.jsonl");
		const other = path.join(fx.sessions, "2026-04-02T00-00-00-000Z_other.jsonl");
		const fresh = path.join(fx.sessions, "2026-04-03T00-00-00-000Z_fresh.jsonl");
		writeTranscript(active);
		writeTranscript(other);
		age(active, 30);
		age(other, 30);
		const withActive = runSessionGc({
			sessionsDir: fx.sessions,
			stateDir: fx.stateDir,
			keep: 0,
			olderThanDays: 14,
			activeSessionFile: active,
			log: silent,
		});
		check("the active file stays", exists(active));
		check("the active file is reported as active", withActive.entries.some((entry) => entry.name.includes("active") && entry.reason === "active"), withActive.entries);
		check("other old files are still archived", !exists(other), withActive.entries);

		// No active file in runtime state: a transcript modified moments ago is
		// still treated as live.
		writeTranscript(fresh);
		const guarded = runSessionGc({ sessionsDir: fx.sessions, stateDir: fx.stateDir, keep: 0, olderThanDays: 0, log: silent });
		check("a fresh mtime is protected when no active file is known", exists(fresh), guarded.entries);
		check(
			"the reason explains the mtime guard",
			guarded.entries.some((entry) => entry.reason === "active" && (entry.detail ?? "").includes("10 minutes")),
			guarded.entries,
		);
		check("the guard window is 10 minutes", ACTIVE_SESSION_MTIME_GUARD_MS === 10 * 60_000);
		fs.rmSync(fx.root, { recursive: true, force: true });
	}

	// -------------------------------------------------------------------------
	section("gc logs a failed move and keeps going");
	{
		const fx = fixture("failure");
		const first = path.join(fx.sessions, "2026-05-01T00-00-00-000Z_first.jsonl");
		const second = path.join(fx.sessions, "2026-05-02T00-00-00-000Z_second.jsonl");
		writeTranscript(first);
		writeTranscript(second);
		age(first, 30);
		age(second, 30);
		// A regular file where the archive DIRECTORY should be makes mkdir fail.
		const blocker = path.join(fx.stateDir, sessionArchiveDirName(Date.now()));
		fs.writeFileSync(blocker, "not a directory", "utf8");
		const warnings: string[] = [];
		const log = new Logger({ console: false });
		const originalWarn = log.warn.bind(log);
		log.warn = ((message: string) => {
			warnings.push(message);
			originalWarn(message);
		}) as typeof log.warn;
		const result = runSessionGc({ sessionsDir: fx.sessions, stateDir: fx.stateDir, keep: 0, olderThanDays: 14, log });
		check("the failed files stay in place", exists(first) && exists(second));
		check("each failure is a warning", warnings.length === 2, warnings);
		check("failures are reported as skipped errors", result.entries.filter((entry) => entry.reason === "error").length === 2, result.entries);
		check("nothing was freed", result.freedBytes === 0 && result.archived === 0, result);
		fs.rmSync(fx.root, { recursive: true, force: true });
	}

	// -------------------------------------------------------------------------
	section("alive sessions gc --json is a stable structure");
	{
		const fx = fixture("cli-json");
		const old = path.join(fx.sessions, "2026-06-01T00-00-00-000Z_old.jsonl");
		writeTranscript(old);
		age(old, 30);
		const out: string[] = [];
		const stdoutWrite = process.stdout.write;
		const cwd = process.cwd();
		process.stdout.write = ((chunk: unknown) => {
			out.push(String(chunk));
			return true;
		}) as typeof process.stdout.write;
		let code = 0;
		try {
			process.chdir(fx.root);
			code = await main(["sessions", "gc", "--json", "--keep", "0", "--older-than-days", "14"]);
		} finally {
			process.chdir(cwd);
			process.stdout.write = stdoutWrite;
		}
		const parsed = JSON.parse(out.join("")) as Record<string, unknown>;
		const entries = parsed.entries as Array<Record<string, unknown>>;
		check("exit code 0", code === 0, code);
		check(
			"counters are present",
			typeof parsed.archived === "number" && typeof parsed.skipped === "number" && typeof parsed.freedBytes === "number" && Boolean(parsed.archiveDir),
			parsed,
		);
		check(
			"entries carry name/bytes/ageDays/action/reason",
			entries.every((entry) =>
				typeof entry.name === "string" &&
				typeof entry.bytes === "number" &&
				typeof entry.ageDays === "number" &&
				(entry.action === "archived" || entry.action === "skipped") &&
				typeof entry.reason === "string",
			),
			entries,
		);
		check("the JSON run actually archived", parsed.archived === 1 && !exists(old), parsed);
		fs.rmSync(fx.root, { recursive: true, force: true });
	}

	// -------------------------------------------------------------------------
	section("alive sessions stats measures content without changing anything");
	{
		const fx = fixture("stats");
		const image = "A".repeat(4096);
		const file = path.join(fx.sessions, "2026-07-01T00-00-00-000Z_measured.jsonl");
		writeTranscript(file, { text: "hello world", image });
		const before = fs.statSync(file);
		const stats = measureSessionStats(fx.sessions);
		const entry = stats.entries[0];
		check("one file and one message turn measured", stats.files === 1 && entry?.messages === 2, entry);
		check("file size and age are reported", entry?.bytes === before.size && entry.ageDays >= 0, entry);
		check("text bytes are counted", (entry?.contentBytes.text ?? 0) > 0, entry?.contentBytes);
		check("the image attachment is counted", entry?.imageBlocks === 1 && entry.imageBytes === image.length, entry);
		check("the base64 payload is counted", entry?.base64Blocks === 1 && entry.base64Bytes === image.length, entry);
		check("aggregates mirror the per-file numbers", stats.imageBytes === image.length && stats.base64Bytes === image.length, stats);
		const json = JSON.stringify(measureSessionStats(fx.sessions, { now: Date.now() }));
		check("stats output is JSON-serialisable", json.includes("\"contentBytes\""), json.slice(0, 120));
		const after = fs.statSync(file);
		check("stats never modifies the transcript", after.size === before.size && after.mtimeMs === before.mtimeMs, { before, after });
		fs.rmSync(fx.root, { recursive: true, force: true });
	}

	// -------------------------------------------------------------------------
	section("the status size scan has a deadline");
	{
		const fx = fixture("measure");
		writeTranscript(path.join(fx.sessions, "a.jsonl"));
		writeTranscript(path.join(fx.sessions, "b.jsonl"));
		const usage = measureSessions(fx.sessions, { timeoutMs: 10_000 });
		check("files and bytes are counted", usage.files === 2 && typeof usage.bytes === "number" && usage.bytes > 0 && usage.complete, usage);
		let tick = 0;
		const timedOut = measureSessions(fx.sessions, {
			timeoutMs: 5,
			now: () => {
				tick += 10;
				return tick;
			},
		});
		check("a timed out scan reports null bytes", timedOut.bytes === null && timedOut.complete === false && timedOut.files === 2, timedOut);
		check("a missing directory is empty, not an error", measureSessions(path.join(fx.root, "nope")).bytes === 0);
		fs.rmSync(fx.root, { recursive: true, force: true });
	}

	// -------------------------------------------------------------------------
	section("resume context is measured from the transcript tail");
	{
		const fx = fixture("tail");
		const file = path.join(fx.sessions, "2026-08-01T00-00-00-000Z_tail.jsonl");
		writeTranscript(file, { contextTokens: 139_000 });
		check("the last assistant usage is the context size", measureSessionFileContext(file) === 139_000, measureSessionFileContext(file));
		check("an unreadable file measures 0", measureSessionFileContext(path.join(fx.sessions, "missing.jsonl")) === 0);
		const empty = path.join(fx.sessions, "empty.jsonl");
		fs.writeFileSync(empty, "", "utf8");
		check("an empty file measures 0", measureSessionFileContext(empty) === 0);
		fs.rmSync(fx.root, { recursive: true, force: true });
	}

	// -------------------------------------------------------------------------
	section("a resume above the context-sleep threshold starts a new transcript");
	{
		const fx = fixture("resume-over");
		const recent = path.join(fx.sessions, "2026-09-01T00-00-00-000Z_bloated.jsonl");
		writeTranscript(recent, { contextTokens: 139_000 });
		const contents = fs.readFileSync(recent, "utf8");
		const config = makeConfig(fx.root, { loop: { ...fx.config.config.loop, contextSleepTokens: 130_000 } });
		const warns: string[] = [];
		const log = new Logger({ console: false });
		const originalWarn = log.warn.bind(log);
		log.warn = ((message: string) => {
			warns.push(message);
			originalWarn(message);
		}) as typeof log.warn;
		const opened = openSessionManager({ config, log });
		const sessionFile = opened.sessionManager.getSessionFile();
		check("a new file is chosen", typeof sessionFile === "string" && path.resolve(sessionFile) !== recent, sessionFile);
		check("the refusal is logged with the file, tokens and threshold", warns.length === 1 && warns[0]!.includes("context-sleep threshold"), warns);
		check("the old transcript is untouched", exists(recent) && fs.readFileSync(recent, "utf8") === contents);
		check("the old transcript is still the most recent one on disk", mostRecentSessionFile(fx.sessions) === recent, mostRecentSessionFile(fx.sessions));
		fs.rmSync(fx.root, { recursive: true, force: true });
	}

	// -------------------------------------------------------------------------
	section("a resume below the threshold keeps the old transcript");
	{
		const fx = fixture("resume-under");
		const recent = path.join(fx.sessions, "2026-09-02T00-00-00-000Z_small.jsonl");
		writeTranscript(recent, { contextTokens: 5_000 });
		const config = makeConfig(fx.root, { loop: { ...fx.config.config.loop, contextSleepTokens: 130_000 } });
		const opened = openSessionManager({ config, log: silent });
		check("the recent transcript is reopened", opened.sessionManager.getSessionFile() === recent, opened.sessionManager.getSessionFile());
		fs.rmSync(fx.root, { recursive: true, force: true });
	}

	// -------------------------------------------------------------------------
	section("a disabled threshold (0) keeps the old behaviour");
	{
		const fx = fixture("resume-off");
		const recent = path.join(fx.sessions, "2026-09-03T00-00-00-000Z_bloated.jsonl");
		writeTranscript(recent, { contextTokens: 1_000_000 });
		const config = makeConfig(fx.root, { loop: { ...fx.config.config.loop, contextSleepTokens: 0 } });
		const opened = openSessionManager({ config, log: silent });
		check("the session is resumed even when it is huge", opened.sessionManager.getSessionFile() === recent, opened.sessionManager.getSessionFile());
		fs.rmSync(fx.root, { recursive: true, force: true });
	}

	// -------------------------------------------------------------------------
	section("a sleep and an explicit session file are not affected by the guard");
	{
		const fx = fixture("resume-explicit");
		const recent = path.join(fx.sessions, "2026-09-04T00-00-00-000Z_bloated.jsonl");
		writeTranscript(recent, { contextTokens: 139_000 });
		const config = makeConfig(fx.root, { loop: { ...fx.config.config.loop, contextSleepTokens: 130_000 } });
		const slept = openSessionManager({ config, log: silent, forceNewSession: true });
		check("a sleep starts a fresh transcript", path.resolve(slept.sessionManager.getSessionFile() ?? "") !== recent, slept.sessionManager.getSessionFile());
		const explicit = openSessionManager({ config, log: silent, sessionFile: recent });
		check("an explicit resume target is opened as given", explicit.sessionManager.getSessionFile() === recent, explicit.sessionManager.getSessionFile());
		check("the guard did not touch the file", exists(recent));
		fs.rmSync(fx.root, { recursive: true, force: true });
	}

	// -------------------------------------------------------------------------
	section("archive rotation: off by default, a partial config block is merged with defaults");
	{
		const fx = fixture("rotate-defaults");
		const defaults = fx.config.config.sessions.archiveRotate;
		check(
			"enabled=false, gzipAfterDays=7, deleteAfterDays=30 by default",
			defaults.enabled === false &&
				defaults.gzipAfterDays === DEFAULT_ARCHIVE_GZIP_AFTER_DAYS &&
				defaults.deleteAfterDays === DEFAULT_ARCHIVE_DELETE_AFTER_DAYS,
			defaults,
		);
		check(
			"the module defaults are 7 and 30 days",
			DEFAULT_ARCHIVE_GZIP_AFTER_DAYS === 7 && DEFAULT_ARCHIVE_DELETE_AFTER_DAYS === 30,
			{ DEFAULT_ARCHIVE_GZIP_AFTER_DAYS, DEFAULT_ARCHIVE_DELETE_AFTER_DAYS },
		);
		fs.writeFileSync(
			path.join(fx.root, "alive.config.json"),
			JSON.stringify({ sessions: { archiveRotate: { enabled: true } } }),
			"utf8",
		);
		const merged = loadConfig({ cwd: fx.root, migrateSecrets: false }).config.sessions.archiveRotate;
		check(
			"a partial block is filled from the defaults",
			merged.enabled === true && merged.gzipAfterDays === 7 && merged.deleteAfterDays === 30,
			merged,
		);
		fs.rmSync(fx.root, { recursive: true, force: true });
	}

	// -------------------------------------------------------------------------
	section("archive rotation disabled changes nothing on disk");
	{
		const fx = fixture("rotate-disabled");
		const dir = archiveDir(fx, "sessions-archive-20260101-0000");
		const file = path.join(dir, "2026-01-01T00-00-00-000Z_old.jsonl");
		writeTranscript(file);
		age(file, 40);
		const before = snapshot(dir);
		const result = await rotateSessionArchives({ stateDir: fx.stateDir, enabled: false, log: silent });
		check("the result reports the switch", result.enabled === false && result.dryRun === false, result);
		check(
			"nothing is scanned or reported",
			result.dirs === 0 && result.files === 0 && result.entries.length === 0 && result.gzipped === 0 && result.deleted === 0,
			result,
		);
		check("the archive file is untouched", exists(file) && snapshot(dir) === before, snapshot(dir));
		fs.rmSync(fx.root, { recursive: true, force: true });
	}

	// -------------------------------------------------------------------------
	section("archive rotation --dry-run previews even while it is disabled");
	{
		const fx = fixture("rotate-preview");
		const dir = archiveDir(fx, "sessions-archive-20260102-0000");
		const gzipFile = path.join(dir, "2026-01-02T00-00-00-000Z_gzip.jsonl");
		const deleteFile = path.join(dir, "2026-01-03T00-00-00-000Z_delete.jsonl");
		writeTranscript(gzipFile);
		writeTranscript(deleteFile);
		age(gzipFile, 10);
		age(deleteFile, 40);
		const before = snapshot(dir);
		const result = await rotateSessionArchives({ stateDir: fx.stateDir, enabled: false, dryRun: true, log: silent });
		check("the preview reports the switch and the dry run", result.enabled === false && result.dryRun === true, result);
		check(
			"the 10-day file is a gzip candidate with an unknown result size",
			result.gzipped === 1 &&
				result.entries.some(
					(entry) => entry.name.includes("gzip") && entry.action === "gzipped" && entry.bytesAfter === null,
				),
			result.entries,
		);
		check(
			"the 40-day file is a delete candidate with a known result size",
			result.deleted === 1 &&
				result.entries.some(
					(entry) => entry.name.includes("delete") && entry.action === "deleted" && entry.bytesAfter === 0,
				),
			result.entries,
		);
		check(
			"only deletions count as freed bytes in a preview",
			result.freedBytes === fs.statSync(deleteFile).size && result.freedBytes < fs.statSync(gzipFile).size + fs.statSync(deleteFile).size,
			result.freedBytes,
		);
		check("the remaining total is unknown while a gzip candidate exists", result.bytesAfter === null, result.bytesAfter);
		check("nothing changed on disk", exists(gzipFile) && exists(deleteFile) && snapshot(dir) === before, snapshot(dir));
		fs.rmSync(fx.root, { recursive: true, force: true });
	}

	// -------------------------------------------------------------------------
	section("archive rotation gzips and deletes, and never touches the live sessions dir");
	{
		const fx = fixture("rotate-enabled");
		const freshDir = archiveDir(fx, "sessions-archive-20260110-0000");
		const agedDir = archiveDir(fx, "sessions-archive-20260111-0000");
		const doomedDir = archiveDir(fx, "sessions-archive-20260112-0000");
		const fresh = path.join(freshDir, "2026-01-10T00-00-00-000Z_fresh.jsonl");
		const aged = path.join(agedDir, "2026-01-11T00-00-00-000Z_ten.jsonl");
		const doomed = path.join(doomedDir, "2026-01-12T00-00-00-000Z_forty.jsonl");
		writeTranscript(fresh);
		writeTranscript(aged);
		writeTranscript(doomed);
		const agedContent = fs.readFileSync(aged, "utf8");
		age(fresh, 1);
		age(aged, 10);
		age(doomed, 40);
		const agedMtime = fs.statSync(aged).mtimeMs;
		// A live transcript, old enough to be deleted if rotation ever looked at `sessions/`.
		const live = path.join(fx.sessions, "2026-01-13T00-00-00-000Z_live.jsonl");
		writeTranscript(live);
		age(live, 40);

		const result = await rotateSessionArchives({ stateDir: fx.stateDir, enabled: true, log: silent });
		const gz = `${aged}.gz`;
		check("a fresh archive file is untouched", exists(fresh) && !exists(`${fresh}.gz`), fs.readdirSync(freshDir));
		check("the 10-day file is replaced by .gz", !exists(aged) && exists(gz), fs.readdirSync(agedDir));
		check("the decompressed content is identical", gunzipSync(fs.readFileSync(gz)).toString("utf8") === agedContent);
		check(
			"the .gz keeps the original mtime",
			Math.abs(fs.statSync(gz).mtimeMs - agedMtime) < 1,
			{ before: agedMtime, after: fs.statSync(gz).mtimeMs },
		);
		check(
			"the gzip is reported with before/after bytes",
			result.entries.some(
				(entry) => entry.action === "gzipped" && entry.bytesAfter !== null && entry.bytesAfter < entry.bytesBefore,
			),
			result.entries,
		);
		check(
			"the 40-day file is gone and its now-empty dir is removed",
			!exists(doomed) && !exists(doomedDir) && result.removedDirs.includes(doomedDir),
			result.removedDirs,
		);
		check("the live sessions dir is never touched", exists(live) && fs.readdirSync(fx.sessions).length === 1, fs.readdirSync(fx.sessions));
		check("directories that still hold files stay", exists(freshDir) && exists(agedDir), result.removedDirs);
		check(
			"counters and the known remaining total are reported",
			result.gzipped === 1 && result.deleted === 1 && result.freedBytes > 0 && typeof result.bytesAfter === "number" && result.bytesAfter < result.bytesBefore,
			result,
		);

		const gzSize = fs.statSync(gz).size;
		const second = await rotateSessionArchives({ stateDir: fx.stateDir, enabled: true, log: silent });
		check(
			"a second run is a no-op for the existing .gz",
			second.gzipped === 0 &&
				!second.entries.some((entry) => entry.action === "gzipped") &&
				fs.statSync(gz).size === gzSize &&
				fs.readdirSync(agedDir).join(",") === path.basename(gz),
			{ entries: second.entries, files: fs.readdirSync(agedDir) },
		);
		fs.rmSync(fx.root, { recursive: true, force: true });
	}

	// -------------------------------------------------------------------------
	section("a failed gzip of an archive file is a warning, not a failure");
	{
		const fx = fixture("rotate-error");
		const dir = archiveDir(fx, "sessions-archive-20260120-0000");
		const file = path.join(dir, "2026-01-20T00-00-00-000Z_blocked.jsonl");
		writeTranscript(file);
		age(file, 10);
		// A DIRECTORY where the gzip target goes: rotation must refuse to overwrite it.
		fs.mkdirSync(`${file}.gz`);
		const warnings: string[] = [];
		const log = new Logger({ console: false });
		const originalWarn = log.warn.bind(log);
		log.warn = ((message: string) => {
			warnings.push(message);
			originalWarn(message);
		}) as typeof log.warn;
		const result = await rotateSessionArchives({ stateDir: fx.stateDir, enabled: true, log });
		check("the original file stays", exists(file));
		check(
			"the conflict is reported as an error entry with a detail",
			result.entries.some((entry) => entry.action === "error" && entry.name === path.basename(file) && Boolean(entry.detail)),
			result.entries,
		);
		check("a warning is logged", warnings.includes("cannot rotate session archive file; leaving it in place"), warnings);
		check("nothing was gzipped or freed", result.gzipped === 0 && result.freedBytes === 0, result);
		fs.rmSync(fx.root, { recursive: true, force: true });
	}

	// -------------------------------------------------------------------------
	section("archive usage is measured read-only");
	{
		const fx = fixture("rotate-measure");
		const older = archiveDir(fx, "sessions-archive-20260201-0000");
		const newer = archiveDir(fx, "sessions-archive-20260202-0000");
		const a = path.join(older, "a.jsonl");
		const b = path.join(newer, "b.jsonl.gz");
		fs.writeFileSync(a, "a".repeat(100), "utf8");
		fs.writeFileSync(b, "b".repeat(50), "utf8");
		age(a, 40);
		age(b, 5);
		fs.mkdirSync(path.join(newer, "subdir"));
		const usage = measureSessionArchives(fx.stateDir);
		check("dirs and files are counted, subdirectories are not", usage.dirs === 2 && usage.files === 2, usage);
		check("bytes are summed", usage.bytes === 150, usage);
		check("the oldest age is reported", usage.oldestAgeDays !== null && usage.oldestAgeDays >= 39.9 && usage.oldestAgeDays < 41, usage);
		check("a missing state dir measures zero", measureSessionArchives(path.join(fx.root, "nope")).dirs === 0);
		check(
			"measurement changes nothing",
			fs.readdirSync(older).join(",") === "a.jsonl" && fs.readdirSync(newer).sort().join(",") === "b.jsonl.gz,subdir",
			{ older: fs.readdirSync(older), newer: fs.readdirSync(newer) },
		);
		fs.rmSync(fx.root, { recursive: true, force: true });
	}

	// -------------------------------------------------------------------------
	section("alive sessions gc|stats surface rotation and archives (№228)");
	{
		const fx = fixture("rotate-cli");
		const dir = archiveDir(fx, "sessions-archive-20260301-0000");
		const ten = path.join(dir, "2026-03-01T00-00-00-000Z_ten.jsonl");
		writeTranscript(ten);
		age(ten, 10);

		const gc = JSON.parse(await runCli(fx.root, ["sessions", "gc", "--json", "--dry-run"])) as Record<string, unknown>;
		const rotation = gc.rotation as Record<string, unknown>;
		check(
			"gc json keeps its counters and adds rotation",
			typeof gc.scanned === "number" && Array.isArray(gc.entries) && Boolean(rotation),
			Object.keys(gc),
		);
		check(
			"rotation carries the documented fields",
			[
				"enabled",
				"dryRun",
				"gzipAfterDays",
				"deleteAfterDays",
				"stateDir",
				"dirs",
				"files",
				"gzipped",
				"deleted",
				"removedDirs",
				"bytesBefore",
				"bytesAfter",
				"freedBytes",
				"entries",
			].every((key) => key in rotation),
			Object.keys(rotation),
		);
		check(
			"a dry run previews rotation while the config keeps it off",
			rotation.enabled === false && rotation.dryRun === true && rotation.gzipped === 1,
			rotation,
		);
		check("the preview moved nothing", exists(ten));

		const text = await runCli(fx.root, ["sessions", "gc"]);
		check(
			"the text output names the disabled switch",
			text.includes("archive rotation: disabled (sessions.archiveRotate.enabled)"),
			text,
		);

		const stats = JSON.parse(await runCli(fx.root, ["sessions", "stats", "--json"])) as Record<string, unknown>;
		const archives = stats.archives as Record<string, unknown>;
		check(
			"stats json carries archives",
			Boolean(archives) && archives.dirs === 1 && archives.files === 1 && typeof archives.bytes === "number" && archives.oldestAgeDays !== null,
			archives,
		);
		fs.rmSync(fx.root, { recursive: true, force: true });
	}

	// -------------------------------------------------------------------------
	section("alive status reports the sessions line");
	{
		const fx = fixture("status");
		writeTranscript(path.join(fx.sessions, "2026-10-01T00-00-00-000Z_status.jsonl"));
		const out: string[] = [];
		const stdoutWrite = process.stdout.write;
		const cwd = process.cwd();
		process.stdout.write = ((chunk: unknown) => {
			out.push(String(chunk));
			return true;
		}) as typeof process.stdout.write;
		let code = 0;
		try {
			process.chdir(fx.root);
			code = await main(["status", "--json"]);
		} finally {
			process.chdir(cwd);
			process.stdout.write = stdoutWrite;
		}
		const parsed = JSON.parse(out.join("")) as { sessions?: { path?: string; files?: number; bytes?: number | null } };
		check("exit code 0", code === 0, code);
		check("json carries sessions {path, files, bytes}", parsed.sessions?.path === fx.sessions && parsed.sessions.files === 1 && (parsed.sessions.bytes ?? 0) > 0, parsed.sessions);
		fs.rmSync(fx.root, { recursive: true, force: true });
	}
} finally {
	// fixtures are removed inside each block; nothing global to clean up.
}

process.stdout.write(failures === 0 ? "\nALL SESSION RETENTION TESTS PASSED\n" : `\n${failures} SESSION RETENTION TEST(S) FAILED\n`);
process.exitCode = failures === 0 ? 0 : 1;
