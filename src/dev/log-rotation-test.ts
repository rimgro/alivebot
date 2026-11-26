/**
 * Size-based rotation tests for the active structured log.
 *
 *   npx tsx src/dev/log-rotation-test.ts
 *
 * Filesystem fixtures only: no network, no model, no running runtime.
 */
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import * as zlib from "node:zlib";
import {
	DEFAULT_LOG_MAX_BYTES,
	DEFAULT_LOG_MAX_PARTS,
	LOG_MAX_BYTES_ENV,
	LOG_MAX_PARTS_ENV,
	listLogParts,
	readLogTailWithParts,
	resolveLogRotationOptions,
	type LogPart,
	type LogRotationOptions,
} from "../log-rotation.js";
import { Logger } from "../log.js";
import { readLogTail } from "../logs.js";

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

function tempRoot(label: string): string {
	return fs.mkdtempSync(path.join(os.tmpdir(), `alive-log-rotation-${label}-`));
}

function logFile(root: string): string {
	return path.join(root, "logs", "alive.jsonl");
}

function makeLogger(file: string, rotation: LogRotationOptions): Logger {
	return new Logger({ file, console: false, rotation });
}

function writeRows(logger: Logger, from: number, to: number, prefix = "row"): void {
	for (let i = from; i < to; i++) logger.info(`${prefix}-${i}`, { i });
}

function activeLines(file: string): string[] {
	try {
		return fs
			.readFileSync(file, "utf8")
			.split("\n")
			.filter((line) => line.trim().length > 0);
	} catch {
		return [];
	}
}

function partLines(part: LogPart): string[] {
	const data = part.gzip ? zlib.gunzipSync(fs.readFileSync(part.file)) : fs.readFileSync(part.file);
	return data
		.toString("utf8")
		.split("\n")
		.filter((line) => line.trim().length > 0);
}

/** Every archived line (oldest part first), then the active file. */
function allLogLines(file: string): string[] {
	const lines: string[] = [];
	// Part 1 is the newest; read the highest index (oldest) first.
	for (const part of listLogParts(file).sort((a, b) => b.index - a.index)) {
		lines.push(...partLines(part));
	}
	lines.push(...activeLines(file));
	return lines;
}

function ids(lines: string[], prefix = "row"): number[] {
	return lines.map((line) => {
		const record = JSON.parse(line) as { msg?: string };
		const match = new RegExp(`^${prefix}-(\\d+)$`).exec(record.msg ?? "");
		if (!match) throw new Error(`unexpected log line: ${line}`);
		return Number(match[1]);
	});
}

function directorySize(dir: string): number {
	let total = 0;
	for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
		const full = path.join(dir, entry.name);
		if (entry.isDirectory()) total += directorySize(full);
		else if (entry.isFile()) total += fs.statSync(full).size;
	}
	return total;
}

section("rotation by size");
{
	const root = tempRoot("size");
	const file = logFile(root);
	const maxBytes = 1024;
	const logger = makeLogger(file, { maxBytes, maxParts: 5 });
	writeRows(logger, 0, 100);

	const size = fs.statSync(file).size;
	check("active file stays below the threshold", size < maxBytes, { size, maxBytes });
	const parts = listLogParts(file);
	check(
		"active file was rotated into .1.gz",
		fs.existsSync(`${file}.1.gz`) && parts.some((part) => part.index === 1 && part.gzip),
		parts.map((part) => path.basename(part.file)),
	);
	const active = ids(activeLines(file));
	check("active file holds the newest records", active.slice(-5).join(",") === "95,96,97,98,99", active.slice(-5));
	check("active file is not empty right after rotation", active.length > 0, active);
	fs.rmSync(root, { recursive: true, force: true });
}

section("gzip archives are lossless JSONL");
{
	const root = tempRoot("gzip");
	const file = logFile(root);
	const count = 120;
	const logger = makeLogger(file, { maxBytes: 800, maxParts: 50 });
	writeRows(logger, 0, count);

	const parts = listLogParts(file);
	check("at least one part is compressed", parts.some((part) => part.gzip));
	let validJsonl = true;
	for (const part of parts) {
		try {
			for (const line of partLines(part)) JSON.parse(line);
		} catch {
			validJsonl = false;
		}
	}
	try {
		for (const line of activeLines(file)) JSON.parse(line);
	} catch {
		validJsonl = false;
	}
	check("every part decompresses to valid JSONL", validJsonl);

	const all = ids(allLogLines(file));
	const unique = new Set(all);
	check("no records were lost", all.length === count, { got: all.length, expected: count });
	check("no records were duplicated", unique.size === count, { unique: unique.size, expected: count });
	check(
		"all record ids are present exactly once",
		all.every((id, index) => id === index),
		all.slice(0, 5).concat(all.slice(-5)),
	);
	fs.rmSync(root, { recursive: true, force: true });
}

section("maxParts is enforced");
{
	const root = tempRoot("parts");
	const file = logFile(root);
	const maxParts = 2;
	const count = 200;
	const logger = makeLogger(file, { maxBytes: 512, maxParts });
	writeRows(logger, 0, count);

	const parts = listLogParts(file);
	check("no more than maxParts archives are kept", parts.length <= maxParts, parts.map((part) => part.index));
	check("all kept parts are within the cap", parts.every((part) => part.index <= maxParts), parts.map((part) => part.index));
	const all = ids(allLogLines(file));
	check("the oldest records were deleted", all[0] !== undefined && all[0] > 0, all[0]);
	check("the newest records survived", all[all.length - 1] === count - 1, all.slice(-3));
	fs.rmSync(root, { recursive: true, force: true });
}

section("tail reading across parts");
{
	const root = tempRoot("tail");
	const file = logFile(root);
	const count = 120;
	const logger = makeLogger(file, { maxBytes: 512, maxParts: 20 });
	writeRows(logger, 0, count);

	const tail = readLogTail(file, 25);
	const tailIds = ids(tail);
	check("tail returns the requested number of lines", tail.length === 25, tail.length);
	check(
		"tail is ordered oldest to newest",
		tailIds.join(",") === Array.from({ length: 25 }, (_, index) => count - 25 + index).join(","),
		tailIds,
	);
	const viaModule = readLogTailWithParts(file, 10);
	check(
		"readLogTailWithParts agrees with readLogTail",
		ids(viaModule).join(",") === Array.from({ length: 10 }, (_, index) => count - 10 + index).join(","),
		ids(viaModule),
	);
	fs.rmSync(root, { recursive: true, force: true });
}

section("repeated rotations stay bounded");
{
	const root = tempRoot("bounded");
	const file = logFile(root);
	const maxBytes = 1024;
	const maxParts = 3;
	const logger = makeLogger(file, { maxBytes, maxParts });
	writeRows(logger, 0, 1_500);

	const size = fs.statSync(file).size;
	check("active file stays below the threshold after many rotations", size < maxBytes, { size, maxBytes });
	check("part count stays bounded", listLogParts(file).length <= maxParts, listLogParts(file).length);
	const total = directorySize(path.join(root, "logs"));
	const bound = (maxParts + 1) * maxBytes * 2;
	check("log directory size is bounded, not linear in writes", total < bound, { total, bound });
	fs.rmSync(root, { recursive: true, force: true });
}

section("environment overrides");
{
	const previousBytes = process.env[LOG_MAX_BYTES_ENV];
	const previousParts = process.env[LOG_MAX_PARTS_ENV];
	try {
		process.env[LOG_MAX_BYTES_ENV] = "2048";
		process.env[LOG_MAX_PARTS_ENV] = "3";
		const resolved = resolveLogRotationOptions();
		check("ALIVE_LOG_MAX_BYTES overrides the default", resolved.maxBytes === 2048, resolved);
		check("ALIVE_LOG_MAX_PARTS overrides the default", resolved.maxParts === 3, resolved);

		const explicit = resolveLogRotationOptions({
			maxBytes: 128,
			maxParts: 2,
			env: { [LOG_MAX_BYTES_ENV]: "2048", [LOG_MAX_PARTS_ENV]: "3" },
		});
		check("explicit options win over env", explicit.maxBytes === 128 && explicit.maxParts === 2, explicit);

		const root = tempRoot("env");
		const file = logFile(root);
		const logger = new Logger({ file, console: false });
		writeRows(logger, 0, 100);
		check("Logger picks the env threshold", fs.statSync(file).size < 2048, fs.statSync(file).size);
		check("Logger picks the env part count", listLogParts(file).length <= 3, listLogParts(file).length);
		fs.rmSync(root, { recursive: true, force: true });

		const garbage: Array<[string, string, string]> = [
			["non-numeric", "not-a-number", "also-not-a-number"],
			["empty", "", ""],
			["zero", "0", "0"],
			["fractional", "1.5", "2.5"],
			["negative", "-1", "-2"],
			["scientific notation", "1e3", "1e3"],
			["whitespace", "   ", "  "],
		];
		for (const [label, bytes, partsValue] of garbage) {
			const fallback = resolveLogRotationOptions({
				env: { [LOG_MAX_BYTES_ENV]: bytes, [LOG_MAX_PARTS_ENV]: partsValue },
			});
			check(
				`garbage env (${label}) falls back to defaults`,
				fallback.maxBytes === DEFAULT_LOG_MAX_BYTES && fallback.maxParts === DEFAULT_LOG_MAX_PARTS,
				fallback,
			);
		}
	} finally {
		if (previousBytes === undefined) delete process.env[LOG_MAX_BYTES_ENV];
		else process.env[LOG_MAX_BYTES_ENV] = previousBytes;
		if (previousParts === undefined) delete process.env[LOG_MAX_PARTS_ENV];
		else process.env[LOG_MAX_PARTS_ENV] = previousParts;
	}
}

section("gzip failure does not stop rotation");
{
	const root = tempRoot("gzip-failure");
	const file = logFile(root);
	const logger = makeLogger(file, {
		maxBytes: 512,
		maxParts: 5,
		compress: () => {
			throw new Error("injected gzip failure");
		},
	});
	writeRows(logger, 0, 80);

	const parts = listLogParts(file);
	check("rotation continued with an uncompressed .1 part", fs.existsSync(`${file}.1`), parts.map((part) => path.basename(part.file)));
	check("no partial .1.gz was left behind", !fs.existsSync(`${file}.1.gz`));
	check("every archive is uncompressed after the failure", parts.every((part) => !part.gzip), parts);
	const firstPart = parts.find((part) => part.index === 1);
	let valid = false;
	try {
		valid = firstPart !== undefined && partLines(firstPart).length > 0 && partLines(firstPart).every((line) => JSON.parse(line));
	} catch {
		valid = false;
	}
	check("data in the uncompressed part is valid JSONL", valid, firstPart?.file);
	const all = ids(allLogLines(file));
	check("the newest record is still readable", all.includes(79), all.slice(-3));
	fs.rmSync(root, { recursive: true, force: true });
}

section("two Logger instances on one file");
{
	const root = tempRoot("two-loggers");
	const file = logFile(root);
	const first = makeLogger(file, { maxBytes: 1024, maxParts: 100 });
	const second = makeLogger(file, { maxBytes: 1024, maxParts: 100 });
	for (let i = 0; i < 200; i++) {
		const logger = i % 2 === 0 ? first : second;
		logger.info(`row-${i}`, { i });
	}

	const all = ids(allLogLines(file));
	const unique = new Set(all);
	check("200 records are present", all.length === 200, all.length);
	check("no record was duplicated", unique.size === 200, unique.size);
	check(
		"records are complete and in order",
		all.every((id, index) => id === index),
		all.slice(0, 5).concat(all.slice(-5)),
	);
	const tail = readLogTail(file, 200);
	check("readLogTail sees all 200 records across parts", tail.length === 200, tail.length);
	fs.rmSync(root, { recursive: true, force: true });
}

process.stdout.write(
	failures === 0 ? "\nall log rotation tests passed\n" : `\n${failures} log rotation test(s) failed\n`,
);
process.exitCode = failures === 0 ? 0 : 1;
