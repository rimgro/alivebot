/**
 * Start-loop counter tests: process starts inside a rolling window (#178).
 *
 *   npm run test:start-loop
 *
 * The counter is the only evidence a restart loop leaves for an outside
 * observer, so the interesting cases are the quiet ones: a corrupt file, a
 * hand-edited timestamp from the future, an unbounded list, an unwritable state
 * directory. Every one of them must read as "0 or fewer starts", never throw,
 * and never block a boot.
 */
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
	readStartLoop,
	recordProcessStart,
	START_LOOP_MAX_ENTRIES,
	START_LOOP_THRESHOLD,
	START_LOOP_WINDOW_MS,
	startLoopPath,
} from "../store/start-loop.js";

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

/** Fixed wall clock: every expectation below is independent of the real date. */
const now = Date.UTC(2026, 4, 6, 12, 0, 0);
const minute = 60_000;

function writeStarts(stateDir: string, starts: unknown[]): void {
	fs.mkdirSync(stateDir, { recursive: true });
	fs.writeFileSync(startLoopPath(stateDir), `${JSON.stringify({ starts }, null, 2)}\n`, "utf8");
}

function rawStarts(stateDir: string): unknown[] {
	const parsed = JSON.parse(fs.readFileSync(startLoopPath(stateDir), "utf8")) as { starts?: unknown };
	return Array.isArray(parsed.starts) ? parsed.starts : [];
}

const root = fs.mkdtempSync(path.join(os.tmpdir(), "alive-start-loop-test-"));

try {
	// -------------------------------------------------------------------------
	section("missing and empty counters read as zero");
	{
		const missing = path.join(root, "missing", ".alive");
		const zero = readStartLoop(missing, now);
		check("a missing file means 0 starts", zero.starts === 0, zero);
		check("the status always carries the window in seconds", zero.windowSeconds === START_LOOP_WINDOW_MS / 1_000, zero);
		check("the status always carries the threshold", zero.threshold === START_LOOP_THRESHOLD, zero);
		check("0 starts never warn", zero.warn === false, zero);

		const empty = path.join(root, "empty", ".alive");
		writeStarts(empty, []);
		check("an empty starts array reads as 0", readStartLoop(empty, now).starts === 0, rawStarts(empty));

		const malformedShape = path.join(root, "malformed-shape", ".alive");
		writeStarts(malformedShape, "not-an-array" as unknown as unknown[]);
		check("a non-array `starts` reads as 0", readStartLoop(malformedShape, now).starts === 0);

		const recorded = recordProcessStart(missing, now);
		check("the first recorded start counts as 1", recorded.starts === 1 && recorded.warn === false, recorded);
		check("the recorded start is an ISO timestamp, oldest first", rawStarts(missing).join(",") === new Date(now).toISOString(), rawStarts(missing));
	}

	// -------------------------------------------------------------------------
	section("starts accumulate inside the window");
	{
		const stateDir = path.join(root, "three", ".alive");
		const first = recordProcessStart(stateDir, now - 2 * minute);
		const second = recordProcessStart(stateDir, now - minute);
		const third = recordProcessStart(stateDir, now);
		check("three starts in a row count as 1, 2, 3", first.starts === 1 && second.starts === 2 && third.starts === 3, {
			first,
			second,
			third,
		});
		check("the file keeps the three timestamps", rawStarts(stateDir).length === 3, rawStarts(stateDir));
		check(
			"the file stays oldest first",
			rawStarts(stateDir).join(",") ===
				[now - 2 * minute, now - minute, now].map((ts) => new Date(ts).toISOString()).join(","),
			rawStarts(stateDir),
		);
		const read = readStartLoop(stateDir, now);
		check("readStartLoop sees the same count without recording a start", read.starts === 3 && rawStarts(stateDir).length === 3, read);
	}

	// -------------------------------------------------------------------------
	section("warn fires at the threshold");
	{
		const stateDir = path.join(root, "threshold", ".alive");
		const statuses = Array.from({ length: START_LOOP_THRESHOLD }, (_, index) =>
			recordProcessStart(stateDir, now + index));
		check(
			"the threshold is 5 starts in 10 minutes",
			START_LOOP_THRESHOLD === 5 && START_LOOP_WINDOW_MS === 10 * minute,
			{ threshold: START_LOOP_THRESHOLD, windowMs: START_LOOP_WINDOW_MS },
		);
		check(
			"the first four starts do not warn",
			statuses.slice(0, START_LOOP_THRESHOLD - 1).every((status) => status.warn === false),
			statuses,
		);
		const last = statuses[START_LOOP_THRESHOLD - 1]!;
		check("the fifth start warns", last.warn === true && last.starts === START_LOOP_THRESHOLD, last);
		check(
			"the status carries the window and threshold used by the outside readers",
			last.windowSeconds === 600 && last.threshold === START_LOOP_THRESHOLD,
			last,
		);
		check("readStartLoop reports the warn state too", readStartLoop(stateDir, now).warn === true, readStartLoop(stateDir, now));
	}

	// -------------------------------------------------------------------------
	section("entries outside the window are dropped");
	{
		const stateDir = path.join(root, "window", ".alive");
		const old = now - START_LOOP_WINDOW_MS - 1_000;
		const recent = now - minute;
		writeStarts(stateDir, [new Date(old).toISOString(), new Date(recent).toISOString()]);
		check("readStartLoop ignores an entry just outside the window", readStartLoop(stateDir, now).starts === 1, rawStarts(stateDir));
		const recorded = recordProcessStart(stateDir, now);
		check("recording adds the current start to the surviving entry", recorded.starts === 2, recorded);
		check("the old entry is gone from the file", rawStarts(stateDir).join(",") === [recent, now].map((ts) => new Date(ts).toISOString()).join(","), rawStarts(stateDir));

		const boundary = path.join(root, "window-boundary", ".alive");
		writeStarts(boundary, [new Date(now - START_LOOP_WINDOW_MS).toISOString()]);
		check("an entry exactly at the window edge is still inside", readStartLoop(boundary, now).starts === 1);
	}

	// -------------------------------------------------------------------------
	section("corrupt files are ignored, never fatal");
	{
		const stateDir = path.join(root, "corrupt", ".alive");
		fs.mkdirSync(stateDir, { recursive: true });
		fs.writeFileSync(startLoopPath(stateDir), "{not json", "utf8");
		const read = readStartLoop(stateDir, now);
		check("a corrupt file reads as 0", read.starts === 0 && read.warn === false, read);
		const recorded = recordProcessStart(stateDir, now);
		check("recording after corruption counts only the current start", recorded.starts === 1, recorded);
		check("recording replaces the corrupt file with valid JSON", rawStarts(stateDir).join(",") === new Date(now).toISOString(), rawStarts(stateDir));

		const arrayFile = path.join(root, "array-file", ".alive");
		fs.mkdirSync(arrayFile, { recursive: true });
		fs.writeFileSync(startLoopPath(arrayFile), "[]\n", "utf8");
		check("a JSON array instead of an object reads as 0", readStartLoop(arrayFile, now).starts === 0);
	}

	// -------------------------------------------------------------------------
	section("garbage, non-ISO and future timestamps are filtered");
	{
		const stateDir = path.join(root, "garbage", ".alive");
		const inWindow = new Date(now - minute).toISOString();
		const futureEdge = new Date(now + 60_000).toISOString();
		const futureTooFar = new Date(now + 61_000).toISOString();
		writeStarts(stateDir, [
			"not-a-date",
			"123",
			"2026-13-40T00:00:00.000Z",
			12_345,
			null,
			{ nested: true },
			futureTooFar,
			futureEdge,
			inWindow,
		]);
		const read = readStartLoop(stateDir, now);
		check("only ISO timestamps inside the window survive", read.starts === 2, { read, starts: rawStarts(stateDir) });
		const recorded = recordProcessStart(stateDir, now);
		check("recording drops the garbage and keeps the current start", recorded.starts === 3, recorded);
		check(
			"the rewritten file contains only the two valid entries and now",
			rawStarts(stateDir).join(",") === [inWindow, new Date(now).toISOString(), futureEdge].join(","),
			rawStarts(stateDir),
		);
	}

	// -------------------------------------------------------------------------
	section("the file is capped at START_LOOP_MAX_ENTRIES");
	{
		const stateDir = path.join(root, "cap", ".alive");
		const many = Array.from({ length: START_LOOP_MAX_ENTRIES + 10 }, (_, index) =>
			new Date(now - (START_LOOP_MAX_ENTRIES + 10 - index) * 1_000).toISOString());
		writeStarts(stateDir, many);
		const recorded = recordProcessStart(stateDir, now);
		const kept = rawStarts(stateDir);
		check("the returned status is capped", recorded.starts === START_LOOP_MAX_ENTRIES, recorded);
		check("the file is capped", kept.length === START_LOOP_MAX_ENTRIES, kept.length);
		check("the oldest entries are dropped first", kept[0] === new Date(now - (START_LOOP_MAX_ENTRIES - 1) * 1_000).toISOString(), kept[0]);
		check("the current start is the newest entry", kept[kept.length - 1] === new Date(now).toISOString(), kept[kept.length - 1]);
		check("no temp file is left behind", fs.readdirSync(stateDir).join(",") === path.basename(startLoopPath(stateDir)), fs.readdirSync(stateDir));
	}

	// -------------------------------------------------------------------------
	section("reads do not write; filesystem errors never escape");
	{
		const stateDir = path.join(root, "read-only", ".alive");
		writeStarts(stateDir, [new Date(now - minute).toISOString(), new Date(now).toISOString()]);
		const before = fs.readFileSync(startLoopPath(stateDir), "utf8");
		readStartLoop(stateDir, now);
		check("readStartLoop leaves the file untouched", fs.readFileSync(startLoopPath(stateDir), "utf8") === before);

		const blocker = path.join(root, "blocker");
		fs.writeFileSync(blocker, "a file where a directory is expected", "utf8");
		const brokenStateDir = path.join(blocker, ".alive");
		let threw = false;
		let recorded: ReturnType<typeof recordProcessStart> | undefined;
		try {
			recorded = recordProcessStart(brokenStateDir, now);
		} catch {
			threw = true;
		}
		check("an unwritable state dir does not throw", threw === false);
		check("the current start is still reported", recorded?.starts === 1 && recorded.warn === false, recorded);
		check("an unreadable counter reads as 0", readStartLoop(brokenStateDir, now).starts === 0);
	}
} finally {
	fs.rmSync(root, { recursive: true, force: true });
}

process.stdout.write(failures === 0 ? "\nALL START-LOOP TESTS PASSED\n" : `\n${failures} START-LOOP TEST(S) FAILED\n`);
process.exitCode = failures === 0 ? 0 : 1;
