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
	rotateIfNeeded,
	type LogPart,
	type LogRotationOptions,
} from "../log-rotation.js";
import { Logger } from "../log.js";
import { readLogTail, renderLogLine } from "../logs.js";
import { DEFAULT_CONFIG, resolvePaths } from "../config.js";

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

function note(text: string): void {
	process.stdout.write(`  note  ${text}\n`);
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

function rawPartText(part: LogPart): string {
	const data = part.gzip ? zlib.gunzipSync(fs.readFileSync(part.file)) : fs.readFileSync(part.file);
	return data.toString("utf8");
}

function nonEmptyLines(text: string): string[] {
	return text.split("\n").filter((line) => line.trim().length > 0);
}

function parseLines(lines: string[]): Array<Record<string, unknown>> | undefined {
	try {
		return lines.map((line) => JSON.parse(line) as Record<string, unknown>);
	} catch {
		return undefined;
	}
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

section("secret masking survives rotation");
{
	const root = tempRoot("secrets-rotation");
	const file = logFile(root);
	const secret = `tok_live_${"Q7x".repeat(8)}`;
	// Explicit rules only: no dependence on the ambient environment.
	const secretsConfig = { maskEnv: false, extraPatterns: ["tok_live_[A-Za-z0-9]{24}"] };
	const logger = new Logger({
		file,
		console: false,
		secrets: secretsConfig,
		rotation: { maxBytes: 400, maxParts: 50 },
	});
	const count = 9;
	for (let i = 0; i < count; i++) logger.info(`row-${i} uses ${secret}`, { i, token: secret });

	const parts = listLogParts(file);
	note(`secret section rotations: ${parts.length} (parts: ${parts.map((part) => part.index).join(",") || "none"})`);
	check("rotation fired more than once for the secret log", parts.length >= 2, parts.length);

	const chunks: Array<{ label: string; lines: string[] }> = [];
	let activeText = "";
	try {
		activeText = fs.readFileSync(file, "utf8");
	} catch {
		activeText = "";
	}
	chunks.push({ label: "active", lines: nonEmptyLines(activeText) });
	for (const part of parts) chunks.push({ label: path.basename(part.file), lines: nonEmptyLines(rawPartText(part)) });

	const totalLines = chunks.reduce((sum, chunk) => sum + chunk.lines.length, 0);
	check("every secret record survived rotation", totalLines === count, { totalLines, count });

	const leaking = chunks.filter((chunk) => chunk.lines.some((line) => line.includes(secret))).map((chunk) => chunk.label);
	check("no chunk (active or archived) contains the raw secret", leaking.length === 0, leaking);
	const partial = chunks
		.filter((chunk) => chunk.lines.some((line) => line.includes(secret.slice(4, 16)) || line.includes(secret.slice(-12))))
		.map((chunk) => chunk.label);
	check("no chunk leaks a long fragment of the secret", partial.length === 0, partial);
	const compressedLeak = parts.filter((part) => part.gzip).filter((part) => fs.readFileSync(part.file).includes(Buffer.from(secret, "utf8")));
	check("compressed parts carry no raw secret in their bytes", compressedLeak.length === 0, compressedLeak.map((part) => part.file));

	let validJson = true;
	let maskedEverywhere = true;
	let fieldsIntact = true;
	for (const chunk of chunks) {
		for (const line of chunk.lines) {
			let record: { ts?: unknown; level?: unknown; msg?: unknown; data?: { token?: unknown; i?: unknown } };
			try {
				record = JSON.parse(line) as typeof record;
			} catch {
				validJson = false;
				continue;
			}
			if (typeof record.ts !== "number" || typeof record.level !== "string" || typeof record.msg !== "string") fieldsIntact = false;
			if (!/\[custom#\d+\]/.test(String(record.msg))) maskedEverywhere = false;
			if (record.data === undefined || !/^\[custom#\d+\]$/.test(String(record.data.token))) maskedEverywhere = false;
		}
	}
	check("every active and archived line is valid JSON with ts/level/msg", validJson && fieldsIntact);
	check("the masked form replaces the secret in message and data of every record", maskedEverywhere);
	fs.rmSync(root, { recursive: true, force: true });
}

section("line integrity across rotation boundaries");
{
	const root = tempRoot("integrity");
	const file = logFile(root);
	const maxBytes = 720;
	const maxParts = 100;
	const count = 300;
	const logger = makeLogger(file, { maxBytes, maxParts });

	let oversize = false;
	let tornWrite = false;
	let rotations = 0;
	let brokenFirstLine: unknown;
	let previousParts = 0;
	let previousSize = 0;
	for (let i = 0; i < count; i++) {
		logger.info(`row-${i}`, { i });
		const size = fs.statSync(file).size;
		const lines = activeLines(file);
		if (size > maxBytes) oversize = true;
		const parsed = parseLines(lines);
		if (parsed === undefined) tornWrite = true;
		const partCount = listLogParts(file).length;
		const rotated = partCount > previousParts || size < previousSize;
		if (rotated) {
			rotations += 1;
			// The record that triggered the rotation must open the new active
			// file as a complete, parseable line — never a fragment.
			const first = parsed?.[0];
			if (lines.length !== 1 || first === undefined || first.msg !== `row-${i}` || first.level !== "info") {
				brokenFirstLine = { i, lines: lines.slice(0, 2), size };
			}
		}
		previousParts = partCount;
		previousSize = size;
	}
	note(`integrity section rotations: ${rotations} (maxBytes ${maxBytes})`);
	check("the log crossed several rotation boundaries", rotations >= 5, rotations);
	check("the active file never exceeded the threshold", !oversize, { maxBytes, finalSize: fs.statSync(file).size });
	check("no torn or glued line appeared while writing", !tornWrite);
	check("the first line of every new active file is a whole record", brokenFirstLine === undefined, brokenFirstLine);

	const all = allLogLines(file);
	const records = parseLines(all);
	check("every line of the union parses as JSON", records !== undefined, { lines: all.length });
	const wellFormed = all.every(
		(line) => line.startsWith('{"ts":') && line.endsWith("}") && line.split('"ts":').length === 2,
	);
	check("no line is truncated or glued to its neighbour", wellFormed, all.find((line) => !line.startsWith('{"ts":') || !line.endsWith("}")));

	const seen: number[] = [];
	let fieldsOk = records !== undefined;
	for (const record of records ?? []) {
		const match = /^row-(\d+)$/.exec(String(record.msg));
		if (!match) {
			fieldsOk = false;
			continue;
		}
		const id = Number(match[1]);
		seen.push(id);
		const data = record.data as { i?: unknown } | undefined;
		if (
			typeof record.ts !== "number" ||
			typeof record.level !== "string" ||
			data === undefined ||
			data.i !== id ||
			!Number.isFinite(record.ts)
		) {
			fieldsOk = false;
		}
	}
	check("every record keeps ts/level/msg/data.i", fieldsOk, seen.slice(0, 5));
	check("all 300 records are present in the union", seen.length === count, seen.length);
	check("no record was duplicated", new Set(seen).size === seen.length, { unique: new Set(seen).size });
	check(
		"records are complete and ordered oldest to newest",
		seen.every((id, index) => id === index),
		seen.slice(0, 5).concat(seen.slice(-5)),
	);

	const activeFirst = parseLines(activeLines(file))?.[0];
	const activeId = Number(/^row-(\d+)$/.exec(String(activeFirst?.msg))?.[1]);
	check(
		"the current active file opens with a whole record",
		activeFirst !== undefined && Number.isFinite(activeId) && (activeFirst.data as { i?: unknown }).i === activeId,
		activeFirst,
	);
	fs.rmSync(root, { recursive: true, force: true });
}

section("archived lines through the public read path");
{
	const root = tempRoot("read-path");
	const file = logFile(root);
	const count = 120;
	const logger = makeLogger(file, { maxBytes: 512, maxParts: 20 });
	writeRows(logger, 0, count);
	logger.warn(`row-${count}`, { i: count });
	logger.error(`row-${count + 1}`, { i: count + 1 });
	const total = count + 2;

	const archived = listLogParts(file)
		.sort((left, right) => right.index - left.index)
		.flatMap((part) => partLines(part));
	check("archived parts are non-empty", archived.length > 0, archived.length);

	const tail = readLogTail(file, 100_000);
	const tailIds = ids(tail);
	check("readLogTail returns every archived line", archived.every((line) => tail.includes(line)), {
		archived: archived.length,
		tail: tail.length,
	});
	check("readLogTail sees the whole history oldest to newest", tailIds.length === total && tailIds.every((id, index) => id === index), {
		tail: tailIds.length,
		total,
	});
	const activeIds = new Set(ids(activeLines(file)));
	check(
		"lines from parts are visible even when the active file is short",
		tailIds.filter((id) => !activeIds.has(id)).length === total - activeIds.size,
		{ active: activeIds.size, total },
	);

	let renderThrew: unknown;
	let renderEmpty = false;
	let fieldsLost: unknown;
	for (const line of archived) {
		const record = JSON.parse(line) as { ts: number; level: string; msg: string };
		let rendered: string | undefined;
		try {
			rendered = renderLogLine("alive", line);
		} catch (err) {
			renderThrew = err instanceof Error ? err.message : String(err);
			continue;
		}
		const text = rendered ?? "";
		if (text.trim().length === 0) renderEmpty = true;
		const time = new Date(record.ts).toISOString().slice(11, 19);
		if (!text.includes(record.msg) || !text.includes(record.level.toUpperCase()) || !text.includes(time)) {
			fieldsLost = { line, rendered };
		}
	}
	check("renderLogLine never throws on archived lines", renderThrew === undefined, renderThrew);
	check("renderLogLine never renders an archived line as empty", !renderEmpty);
	check("renderLogLine keeps ts, level and msg of archived lines", fieldsLost === undefined, fieldsLost);
	const warnLine = archived.find((line) => (JSON.parse(line) as { level?: string }).level === "warn");
	const errorLine = archived.find((line) => (JSON.parse(line) as { level?: string }).level === "error");
	check(
		"archive keeps non-info levels readable",
		(warnLine === undefined || renderLogLine("alive", warnLine)?.includes("WARN")) === true &&
			(errorLine === undefined || renderLogLine("alive", errorLine)?.includes("ERROR")) === true,
	);
	fs.rmSync(root, { recursive: true, force: true });
}

section("one threshold for every file and directory");
{
	const previousBytes = process.env[LOG_MAX_BYTES_ENV];
	const previousParts = process.env[LOG_MAX_PARTS_ENV];
	try {
		delete process.env[LOG_MAX_BYTES_ENV];
		delete process.env[LOG_MAX_PARTS_ENV];

		const rootA = tempRoot("threshold-root");
		const rootB = tempRoot("threshold-profile");
		// Root profile vs a managed-profile layout: different state dirs, so
		// different log files and different current sizes.
		const rootPaths = resolvePaths(rootA, DEFAULT_CONFIG);
		const profilePaths = resolvePaths(rootB, { ...DEFAULT_CONFIG, stateDir: "profiles/agent-x/.alive" });
		check("the two fixtures use different log directories", rootPaths.logsDir !== profilePaths.logsDir, {
			root: rootPaths.logsDir,
			profile: profilePaths.logsDir,
		});

		// A pre-existing file much larger than a typical threshold: if the limit
		// were derived from the file size, this one would differ.
		fs.mkdirSync(rootPaths.logsDir, { recursive: true });
		const filler = `${JSON.stringify({ ts: 1, level: "info", msg: "old" })}\n`;
		fs.writeFileSync(rootPaths.logFile, filler.repeat(4_000));

		const rootLogger = new Logger({ file: rootPaths.logFile, console: false });
		const profileLogger = new Logger({ file: profilePaths.logFile, console: false });
		check("the default threshold is 16 MiB", DEFAULT_LOG_MAX_BYTES === 16 * 1024 * 1024, DEFAULT_LOG_MAX_BYTES);
		check("no env override is in effect", resolveLogRotationOptions({}).maxBytes === DEFAULT_LOG_MAX_BYTES);
		check("both files resolve to the default threshold", rootLogger.rotation.maxBytes === DEFAULT_LOG_MAX_BYTES && profileLogger.rotation.maxBytes === DEFAULT_LOG_MAX_BYTES, {
			root: rootLogger.rotation.maxBytes,
			profile: profileLogger.rotation.maxBytes,
		});
		check("both files resolve to the same threshold and part count", rootLogger.rotation.maxBytes === profileLogger.rotation.maxBytes && rootLogger.rotation.maxParts === profileLogger.rotation.maxParts && rootLogger.rotation.maxParts === DEFAULT_LOG_MAX_PARTS, {
			root: rootLogger.rotation,
			profile: profileLogger.rotation,
		});

		rootLogger.info("row-root");
		profileLogger.info("row-profile");
		check("a pre-filled ~100 KiB file does not rotate", listLogParts(rootPaths.logFile).length === 0, rootPaths.logFile);
		check("a fresh file in the other directory does not rotate either", listLogParts(profilePaths.logFile).length === 0, profilePaths.logFile);
		check(
			"the threshold was not derived from the current file size",
			fs.statSync(rootPaths.logFile).size > 100_000 && rootLogger.rotation.maxBytes === DEFAULT_LOG_MAX_BYTES,
			fs.statSync(rootPaths.logFile).size,
		);

		const bigRoot = tempRoot("threshold-big");
		const bigFile = logFile(bigRoot);
		fs.mkdirSync(path.dirname(bigFile), { recursive: true });
		fs.writeFileSync(bigFile, "");
		fs.truncateSync(bigFile, DEFAULT_LOG_MAX_BYTES + 1024 * 1024);
		new Logger({ file: bigFile, console: false }).info("row-big");
		check(
			"a file above 16 MiB rotates, so the limit is the default and not its own size",
			listLogParts(bigFile).length === 1 && fs.statSync(bigFile).size < DEFAULT_LOG_MAX_BYTES,
			{ parts: listLogParts(bigFile).length, active: fs.statSync(bigFile).size },
		);

		const boundaryRoot = tempRoot("threshold-incoming");
		const boundaryFile = logFile(boundaryRoot);
		fs.mkdirSync(path.dirname(boundaryFile), { recursive: true });
		fs.writeFileSync(boundaryFile, "x".repeat(150));
		const below = rotateIfNeeded(boundaryFile, { maxBytes: 200, maxParts: 5, incomingBytes: 10, force: true });
		check("incoming bytes below the limit do not rotate", below.rotated === false && below.maxBytes === 200, below);
		const crosses = rotateIfNeeded(boundaryFile, { maxBytes: 200, maxParts: 5, incomingBytes: 100, force: true });
		check("incoming bytes are counted when checking the threshold", crosses.rotated === true, crosses);
		const afterRotation = rotateIfNeeded(boundaryFile, { maxBytes: 200, maxParts: 5, incomingBytes: 10, force: true });
		check(
			"after rotation the new active file starts counting from zero",
			afterRotation.rotated === false && afterRotation.size === 10,
			afterRotation,
		);
	} finally {
		if (previousBytes === undefined) delete process.env[LOG_MAX_BYTES_ENV];
		else process.env[LOG_MAX_BYTES_ENV] = previousBytes;
		if (previousParts === undefined) delete process.env[LOG_MAX_PARTS_ENV];
		else process.env[LOG_MAX_PARTS_ENV] = previousParts;
	}
}

process.stdout.write(
	failures === 0 ? "\nall log rotation tests passed\n" : `\n${failures} log rotation test(s) failed\n`,
);
process.exitCode = failures === 0 ? 0 : 1;
