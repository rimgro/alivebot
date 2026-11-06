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
import { loadConfig, type AliveConfig, type LoadedConfig } from "../config.js";
import { Logger } from "../log.js";
import { main } from "../cli.js";
import { openSessionManager } from "../runtime/session.js";
import {
	ACTIVE_SESSION_MTIME_GUARD_MS,
	DEFAULT_SESSION_KEEP,
	DEFAULT_SESSION_MAX_SIZE_MB,
	DEFAULT_SESSION_OLDER_THAN_DAYS,
	measureSessionFileContext,
	measureSessionStats,
	measureSessions,
	mostRecentSessionFile,
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
