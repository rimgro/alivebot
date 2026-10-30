/**
 * `alive usage` tests.
 *
 *   npx tsx src/dev/usage-test.ts
 *
 * Filesystem fixtures only: every case builds a throwaway profile directory
 * (alive.config.json + .alive state) under the OS temp dir and reads it through
 * the real CLI/report code. No network, no real profile is touched.
 *
 * The privacy case plants distinctive strings in a run's prompt text, outbound
 * message text, tool arguments, tool result and error string, then asserts none
 * of them can appear in the JSON or the table.
 */
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { main } from "../cli.js";
import { loadConfig } from "../config.js";
import {
	findProfile,
	loadDashboard,
	loadRootConfig,
	type DashboardProfile,
} from "../dashboard/state.js";
import type { RunStopReason } from "../store/runs.js";
import { localDay, oneLine } from "../util.js";
import {
	buildUsageReport,
	DEFAULT_USAGE_DAYS,
	renderUsageReport,
	TOP_RUNS_LIMIT,
	USAGE_REPORT_KIND,
	USAGE_REPORT_VERSION,
	type UsageReport,
} from "../usage/report.js";
import { workerUsagePath } from "../workers/store.js";

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

function writeJson(file: string, value: unknown): void {
	fs.mkdirSync(path.dirname(file), { recursive: true });
	fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

function writeJsonl(file: string, values: unknown[]): void {
	fs.mkdirSync(path.dirname(file), { recursive: true });
	fs.writeFileSync(file, values.map((value) => `${JSON.stringify(value)}\n`).join(""), "utf8");
}

// ---------------------------------------------------------------------------
// fixtures
// ---------------------------------------------------------------------------

// A synthetic "now" late in the current local day keeps day buckets stable.
const NOW = (() => {
	const date = new Date(Date.now());
	date.setHours(23, 0, 0, 0);
	return date.getTime();
})();

/** Local day `offset` days before today, at `hour`. */
function dayAt(offset: number, hour = 12): number {
	const date = new Date(NOW);
	date.setDate(date.getDate() - offset);
	date.setHours(hour, 0, 0, 0);
	return date.getTime();
}

interface Fixture {
	root: string;
	stateDir: string;
	profile: DashboardProfile;
}

function makeProfile(name: string): Fixture {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), `alive-usage-${name}-`));
	writeJson(path.join(root, "alive.config.json"), {
		name: `Usage ${name}`,
		model: "anthropic/claude-test",
		stateDir: ".alive",
		workspace: ".alive/workspace",
		soulFile: "SOUL.md",
		sandbox: { enabled: false },
	});
	const config = loadConfig({ cwd: root, migrateSecrets: false });
	const stateDir = config.paths.stateDir;
	fs.mkdirSync(stateDir, { recursive: true });
	const profiles = loadDashboard(loadRootConfig({ rootDir: root }));
	const profile = findProfile(profiles, "main");
	if (!profile) throw new Error("fixture profile did not load");
	return { root, stateDir, profile };
}

interface RunOptions {
	index: number;
	finishedAt: number;
	stopReason?: RunStopReason;
	input?: number;
	output?: number;
	cacheRead?: number;
	cacheWrite?: number;
	cost?: number;
	turns?: number;
	durationMs?: number;
	events?: Array<{ seq: number; kind: string; thread?: string; title: string }>;
	outbound?: Array<{ thread: string; text: string; delivered: boolean }>;
	error?: string;
	extra?: Record<string, unknown>;
}

function runRecord(options: RunOptions): Record<string, unknown> {
	const durationMs = options.durationMs ?? 60_000;
	const input = options.input ?? 100;
	const output = options.output ?? 10;
	const cacheRead = options.cacheRead ?? 50;
	const cacheWrite = options.cacheWrite ?? 5;
	return {
		id: `run_${options.index}`,
		index: options.index,
		startedAt: options.finishedAt - durationMs,
		finishedAt: options.finishedAt,
		durationMs,
		activeMs: durationMs / 2,
		idleMs: durationMs / 2,
		stopReason: options.stopReason ?? "slept",
		events:
			options.events ?? [
				{ seq: options.index, kind: "user_message", thread: "console", title: `event ${options.index}` },
			],
		outbound: options.outbound ?? [],
		remindersCreated: [],
		notesTouched: [],
		journalEntries: 0,
		idleReturns: 0,
		interruptDeliveries: 0,
		nudges: 0,
		turns: options.turns ?? 2,
		promptChars: 100,
		usage: {
			input,
			output,
			cacheRead,
			cacheWrite,
			total: input + output + cacheRead + cacheWrite,
			cost: options.cost ?? 0.01,
		},
		...(options.error ? { error: options.error } : {}),
		...(options.extra ?? {}),
	};
}

const SECRET_PROMPT = "S3CRET_PROMPT_PAYLOAD_9f2c";
const SECRET_OUTBOUND = "S3CRET_OUTBOUND_TEXT_4b81";
const SECRET_TOOL_ARG = "S3CRET_TOOL_ARGUMENT_77aa";
const SECRET_TOOL_RESULT = "S3CRET_TOOL_RESULT_31cd";
const SECRET_ERROR = "S3CRET_ERROR_STRING_5e0f";

function sessionEntry(
	at: number,
	message: Record<string, unknown>,
): Record<string, unknown> {
	return { type: "message", timestamp: new Date(at).toISOString(), message };
}

interface MainFixture extends Fixture {
	run3StartedAt: number;
}

function buildMainFixture(): MainFixture {
	const fixture = makeProfile("main");
	const run3Finished = dayAt(1, 12);
	const run3StartedAt = run3Finished - 60_000;
	const records = [
		runRecord({
			index: 1,
			finishedAt: dayAt(0, 10),
			input: 100,
			output: 20,
			cacheRead: 50,
			cacheWrite: 5,
			cost: 0.05,
			turns: 3,
			events: [{ seq: 1, kind: "user_message", thread: "console", title: "hello there" }],
		}),
		runRecord({
			index: 2,
			finishedAt: dayAt(0, 15),
			input: 40,
			output: 4,
			cacheRead: 10,
			cacheWrite: 1,
			cost: 0.02,
			turns: 1,
			stopReason: "error",
			error: `model call failed: ${SECRET_ERROR}`,
			events: [{ seq: 2, kind: "user_message", thread: "console", title: "broken request" }],
		}),
		runRecord({
			index: 3,
			finishedAt: run3Finished,
			input: 1000,
			output: 100,
			cacheRead: 500,
			cacheWrite: 20,
			cost: 0.3,
			turns: 6,
			events: [{ seq: 3, kind: "reminder", title: "deploy check" }],
			outbound: [{ thread: "console", text: `deploy finished ${SECRET_OUTBOUND}`, delivered: true }],
		}),
		runRecord({
			index: 4,
			finishedAt: dayAt(2, 9),
			input: 10,
			output: 2,
			cacheRead: 0,
			cacheWrite: 0,
			cost: 0.01,
			turns: 1,
			stopReason: "aborted",
			events: [{ seq: 4, kind: "user_message", thread: "console", title: "stop requested" }],
		}),
		runRecord({
			index: 5,
			finishedAt: dayAt(3, 16),
			input: 5,
			output: 1,
			cacheRead: 5,
			cacheWrite: 0,
			cost: 0.001,
			turns: 1,
			stopReason: "stalled",
			events: [{ seq: 5, kind: "reminder", title: "wake later" }],
		}),
		// Outside a 7-day window: must not appear anywhere.
		runRecord({ index: 6, finishedAt: dayAt(10, 12), cost: 99, turns: 9 }),
	];
	writeJsonl(path.join(fixture.stateDir, "runs", "runs.jsonl"), records);
	writeJson(path.join(fixture.stateDir, "usage.json"), {
		days: {
			[localDay(dayAt(0))]: { cost: 0.07, runs: 2, turns: 4, input: 140, output: 24 },
			[localDay(dayAt(1))]: { cost: 0.3, runs: 1, turns: 6, input: 1000, output: 100 },
		},
	});
	writeJsonl(workerUsagePath(fixture.stateDir), [
		{ ts: dayAt(0, 11), cost: 0.02, input: 500, output: 50 },
		{ ts: dayAt(1, 11), cost: 0.01, input: 200, output: 20 },
		{ ts: dayAt(20, 11), cost: 5, input: 9000, output: 900 },
	]);
	// pi session transcript: prompt text, tool arguments and a tool result all
	// carry secrets; only tool *names* may reach the report.
	writeJsonl(path.join(fixture.stateDir, "sessions", "2026-10-14T10-00-00-000Z_test.jsonl"), [
		sessionEntry(run3StartedAt + 5_000, {
			role: "user",
			content: [{ type: "text", text: `please deploy ${SECRET_PROMPT}` }],
		}),
		sessionEntry(run3StartedAt + 6_000, {
			role: "assistant",
			content: [
				{ type: "text", text: "running the deploy" },
				{ type: "toolCall", id: "call_bash", name: "bash", arguments: { command: `echo ${SECRET_TOOL_ARG}` } },
			],
			stopReason: "toolUse",
		}),
		sessionEntry(run3StartedAt + 7_000, {
			role: "toolResult",
			toolCallId: "call_bash",
			toolName: "bash",
			content: [{ type: "text", text: `deploy output ${SECRET_TOOL_RESULT}` }],
		}),
		sessionEntry(run3StartedAt + 8_000, {
			role: "assistant",
			content: [{ type: "text", text: "deploy done" }],
		}),
		// Earlier run: two read-only tools.
		sessionEntry(dayAt(0, 10) - 50_000, {
			role: "assistant",
			content: [
				{ type: "toolCall", id: "call_read", name: "read", arguments: { path: `notes-${SECRET_TOOL_ARG}` } },
				{ type: "toolCall", id: "call_grep", name: "grep", arguments: { pattern: SECRET_TOOL_ARG } },
			],
		}),
	]);
	return { ...fixture, run3StartedAt };
}

// ---------------------------------------------------------------------------
// main fixture: totals, daily buckets, cache, split, top runs, failures
// ---------------------------------------------------------------------------

const mainFixture = buildMainFixture();
const report = buildUsageReport(mainFixture.profile, { days: 7, now: NOW });
const jsonText = JSON.stringify(report);
const tableText = renderUsageReport(report);

section("daily aggregation");
check("runs are counted inside the window only", report.totals.runs === 5, report.totals.runs);
check(
	"token totals add up across runs",
	report.totals.tokens.input === 1155 &&
		report.totals.tokens.output === 127 &&
		report.totals.tokens.cacheRead === 565 &&
		report.totals.tokens.cacheWrite === 26 &&
		report.totals.tokens.total === 1873,
	report.totals.tokens,
);
check("turns and cost add up", report.totals.turns === 12 && Math.abs(report.totals.cost - 0.381) < 1e-9, report.totals);
check("one bucket per local day with runs, oldest first", report.daily.length === 4 && report.daily[0]!.day < report.daily[3]!.day, report.daily.map((day) => day.day));
const today = report.daily.find((day) => day.day === localDay(dayAt(0)));
check(
	"today's bucket aggregates only today's runs",
	today !== undefined &&
		today.runs === 2 &&
		today.turns === 4 &&
		Math.abs(today.cost - 0.07) < 1e-9 &&
		today.tokens.input === 140 &&
		today.tokens.output === 24 &&
		today.tokens.cacheRead === 60 &&
		today.tokens.cacheWrite === 6,
	today,
);
check(
	"runs outside --days are excluded",
	!report.daily.some((day) => day.day === localDay(dayAt(10))) && report.totals.cost < 1,
);
check(
	"window reports its own bounds",
	report.window.days === 7 &&
		report.window.from === localDay(dayAt(6)) &&
		report.window.to === localDay(dayAt(0)) &&
		report.window.fromTs <= dayAt(6, 0),
	report.window,
);

section("chat vs workers");
check("chat totals equal the run totals", report.split.chat.cost === report.totals.cost && report.split.chat.runs === 5);
check(
	"worker spend comes from workers/usage.jsonl inside the window",
	report.split.workers.available &&
		report.split.workers.entries === 2 &&
		Math.abs(report.split.workers.cost - 0.03) < 1e-9 &&
		report.split.workers.tokens.input === 700 &&
		report.split.workers.tokens.output === 70,
	report.split.workers,
);
check(
	"combined cost is chat + workers",
	Math.abs(report.split.combinedCost - 0.411) < 1e-9 &&
		report.split.chatCostShare !== null &&
		report.split.workerCostShare !== null &&
		Math.abs(report.split.chatCostShare + report.split.workerCostShare - 1) < 1e-9,
	{ combined: report.split.combinedCost, chat: report.split.chatCostShare, workers: report.split.workerCostShare },
);
check(
	"worker split admits what its store does not have",
	report.split.workers.turns === null &&
		report.split.workers.cacheRead === null &&
		report.split.workers.cacheWrite === null &&
		report.split.workers.note.includes("no turns"),
	report.split.workers.note,
);

section("model / provider split");
check("no model split is invented for records without a model", report.models.available === false && report.models.items.length === 0);
check(
	"the report says why the model split is missing",
	report.models.note.includes("no model or provider field") && report.models.note.includes("runs.jsonl"),
	report.models.note,
);
check(
	"current settings are reported as current, not historical",
	report.models.current.config === "anthropic/claude-test" && report.models.current.runtime === null,
	report.models.current,
);
check("the table states the model is not recorded", tableText.includes("not recorded:"), tableText.split("\n").find((line) => line.includes("model")));

section("top runs by cost");
check("top-10 limit is respected", report.topRuns.length === 5 && report.topRuns.length <= TOP_RUNS_LIMIT);
check(
	"top runs are ordered by cost, newest first on ties",
	report.topRuns.map((run) => run.id).join(",") === "run_3,run_1,run_2,run_4,run_5",
	report.topRuns.map((run) => run.id),
);
check(
	"a top run carries the trigger event title",
	report.topRuns[0]!.triggers.length === 1 && report.topRuns[0]!.triggers[0]!.title === "deploy check",
	report.topRuns[0]!.triggers,
);
check(
	"tool names come from the session transcript window",
	report.topRuns[0]!.toolsAvailable &&
		report.topRuns[0]!.tools.join(",") === "bash" &&
		report.topRuns[1]!.tools.join(",") === "grep,read",
	report.topRuns.map((run) => run.tools),
);
check(
	"duration and cost are per run",
	report.topRuns[0]!.durationMs === 60_000 && Math.abs(report.topRuns[0]!.cost - 0.3) < 1e-9,
	report.topRuns[0],
);
check("runs without a transcript say so", report.topRuns.slice(2).every((run) => !run.toolsAvailable));

section("failed / aborted runs");
check(
	"failed-run spend is reported separately",
	report.failures.runs === 2 &&
		report.failures.turns === 2 &&
		Math.abs(report.failures.cost - 0.03) < 1e-9 &&
		report.failures.tokens.input === 50,
	report.failures,
);
check(
	"error and aborted runs are listed, cheapest last",
	report.failures.items.map((run) => `${run.id}:${run.stopReason}`).join(",") === "run_2:error,run_4:aborted",
	report.failures.items.map((run) => run.id),
);
check("stalled runs are not counted as failures", !report.failures.items.some((run) => run.id === "run_5"));
check(
	"failure spend is visible in the table",
	tableText.includes("failed / aborted runs") && tableText.includes("2 run(s)"),
);

section("cache hit share");
const expectedShare = 565 / (1155 + 565);
check(
	"cache share is cacheRead / (input + cacheRead)",
	report.cache.hitShare !== null &&
		report.cache.numerator === 565 &&
		report.cache.denominator === 1720 &&
		Math.abs(report.cache.hitShare - expectedShare) < 1e-12,
	report.cache,
);
check("cache share is marked approximate", report.cache.approximate === true && report.cache.note.includes("approximate"));
check("per-day cache share uses the same formula", Math.abs(today!.cacheHitShare! - 60 / (140 + 60)) < 1e-12);

section("metadata only");
// Sanity: the fixture really does carry the planted strings, so the leak checks mean something.
const rawRuns = fs.readFileSync(path.join(mainFixture.stateDir, "runs", "runs.jsonl"), "utf8");
const rawSessions = fs.readFileSync(
	path.join(mainFixture.stateDir, "sessions", "2026-10-14T10-00-00-000Z_test.jsonl"),
	"utf8",
);
check(
	"the fixture really contains the planted strings",
	rawRuns.includes(SECRET_OUTBOUND) &&
		rawRuns.includes(SECRET_ERROR) &&
		rawSessions.includes(SECRET_PROMPT) &&
		rawSessions.includes(SECRET_TOOL_ARG) &&
		rawSessions.includes(SECRET_TOOL_RESULT),
);
for (const [label, secret] of Object.entries({
	"prompt text": SECRET_PROMPT,
	"outbound message text": SECRET_OUTBOUND,
	"tool arguments": SECRET_TOOL_ARG,
	"tool results": SECRET_TOOL_RESULT,
	"error text": SECRET_ERROR,
})) {
	check(`JSON does not leak ${label}`, !jsonText.includes(secret));
	check(`table does not leak ${label}`, !tableText.includes(secret));
}
check("tool names are still reported", report.topRuns[0]!.tools.includes("bash") && tableText.includes("bash"));
check("the report declares itself metadata-only", report.metadataOnly === true && report.notes[0]!.includes("metadata only"));

section("partial data");
const partialFixture = makeProfile("partial");
writeJsonl(path.join(partialFixture.stateDir, "runs", "runs.jsonl"), [
	// Old record: no usage block, no durationMs, no cache fields.
	{
		id: "run_old",
		index: 1,
		startedAt: NOW - 60_000,
		finishedAt: NOW - 30_000,
		activeMs: 1_000,
		idleMs: 2_000,
		stopReason: "slept",
		events: [],
		outbound: [],
		remindersCreated: [],
		notesTouched: [],
		journalEntries: 0,
		idleReturns: 0,
		interruptDeliveries: 0,
		nudges: 0,
		turns: 2,
	},
	// Usage without cache fields.
	{
		...runRecord({ index: 2, finishedAt: NOW - 10_000, cost: 0.001 }),
		usage: { input: 10, output: 2, total: 12, cost: 0.001 },
	},
]);
const partial = buildUsageReport(partialFixture.profile, { days: 7, now: NOW });
const partialReasons = partial.partialReasons.join(" | ");
check("missing usage.json marks the report partial", partial.partial === true && partialReasons.includes("usage.json"));
check("old records without usage are reported, not crashed on", partialReasons.includes("no usage block") && partial.totals.runs === 2, partial.partialReasons);
check("missing cache fields are called out", partialReasons.includes("cacheRead/cacheWrite"));
check("missing durationMs is derived and called out", partialReasons.includes("durationMs") && partial.totals.durationMs === 90_000, partial.totals.durationMs);
check(
	"available tokens are still reported",
	partial.totals.tokens.input === 10 && partial.totals.tokens.output === 2 && Math.abs(partial.totals.cost - 0.001) < 1e-9,
	partial.totals,
);
check("cache share over the surviving token counts", partial.cache.numerator === 0 && partial.cache.denominator === 10 && partial.cache.hitShare === 0);
check("the table shows the partial marker", renderUsageReport(partial).includes("partial data: yes"));

const emptyFixture = makeProfile("empty");
const empty = buildUsageReport(emptyFixture.profile, { days: DEFAULT_USAGE_DAYS, now: NOW });
check(
	"a profile with no state at all does not crash",
	empty.totals.runs === 0 && empty.daily.length === 0 && empty.topRuns.length === 0 && empty.cache.hitShare === null,
	empty.totals,
);
check("the empty report is partial (no usage.json) and says so", empty.partial === true && empty.partialReasons.some((reason) => reason.includes("usage.json")));
check("the empty table says there are no runs", renderUsageReport(empty).includes("no runs in this window"));
check("the complete fixture is not partial", report.partial === false && report.partialReasons.length === 0, report.partialReasons);

section("model split when the record has it");
const modelFixture = makeProfile("model-split");
writeJsonl(path.join(modelFixture.stateDir, "runs", "runs.jsonl"), [
	runRecord({ index: 1, finishedAt: dayAt(0, 9), cost: 0.02, extra: { model: "gpt-x", provider: "openai" } }),
	runRecord({ index: 2, finishedAt: dayAt(0, 10), cost: 0.01 }),
]);
const modelReport = buildUsageReport(modelFixture.profile, { days: 7, now: NOW });
check(
	"a record that carries model/provider produces a split",
	modelReport.models.available && modelReport.models.items.length === 1,
	modelReport.models,
);
check(
	"the model bucket aggregates that model's runs",
	modelReport.models.items[0]!.model === "gpt-x" &&
		modelReport.models.items[0]!.provider === "openai" &&
		modelReport.models.items[0]!.runs === 1 &&
		Math.abs(modelReport.models.items[0]!.cost - 0.02) < 1e-9,
	modelReport.models.items[0],
);
check(
	"runs without a model are counted but not attributed",
	modelReport.models.coveredRuns === 1 && modelReport.models.unattributedRuns === 1,
	{ covered: modelReport.models.coveredRuns, unattributed: modelReport.models.unattributedRuns },
);

section("top-10 ordering");
const topFixture = makeProfile("top-ten");
writeJsonl(
	path.join(topFixture.stateDir, "runs", "runs.jsonl"),
	Array.from({ length: 12 }, (_, index) =>
		runRecord({ index: index + 1, finishedAt: dayAt(0, 8 + index), cost: (index + 1) * 0.01 }),
	),
);
const topReport = buildUsageReport(topFixture.profile, { days: 7, now: NOW });
check("12 runs are trimmed to 10", topReport.topRuns.length === TOP_RUNS_LIMIT, topReport.topRuns.length);
check(
	"the most expensive runs come first",
	topReport.topRuns.map((run) => run.cost).join(",") === "0.12,0.11,0.1,0.09,0.08,0.07,0.06,0.05,0.04,0.03",
	topReport.topRuns.map((run) => run.cost),
);
check("the two cheapest runs fall out", !topReport.topRuns.some((run) => run.index < 3), topReport.topRuns.map((run) => run.index));
check(
	"missing transcripts are reported once in the notes",
	topReport.topRuns.every((run) => !run.toolsAvailable) &&
		topReport.notes.some((note) => note.includes("tool names") && note.includes("unavailable")),
	topReport.notes,
);

section("stable --json shape");
const TOP_LEVEL_KEYS = [
	"agent",
	"cache",
	"daily",
	"failures",
	"generatedAt",
	"metadataOnly",
	"models",
	"notes",
	"partial",
	"partialReasons",
	"report",
	"sources",
	"split",
	"topRuns",
	"totals",
	"version",
	"window",
].sort();
check("top-level keys are stable", JSON.stringify(Object.keys(report).sort()) === JSON.stringify(TOP_LEVEL_KEYS), Object.keys(report).sort());
check(
	"report kind and version are pinned",
	report.report === USAGE_REPORT_KIND && report.report === "alive-usage" && report.version === USAGE_REPORT_VERSION && report.version === 1,
);
check(
	"totals keys are stable",
	JSON.stringify(Object.keys(report.totals).sort()) ===
		JSON.stringify(["activeMs", "cost", "durationMs", "idleMs", "runs", "tokens", "turns"]),
	Object.keys(report.totals).sort(),
);
check(
	"split keys are stable",
	JSON.stringify(Object.keys(report.split).sort()) ===
		JSON.stringify(["chat", "chatCostShare", "combinedCost", "workerCostShare", "workers"]),
	Object.keys(report.split).sort(),
);
check(
	"cache keys are stable",
	JSON.stringify(Object.keys(report.cache).sort()) ===
		JSON.stringify(["approximate", "denominator", "hitShare", "note", "numerator"]),
	Object.keys(report.cache).sort(),
);
check(
	"top-run keys are stable",
	JSON.stringify(Object.keys(report.topRuns[0]!).sort()) ===
		JSON.stringify([
			"activeMs",
			"cost",
			"day",
			"durationMs",
			"finishedAt",
			"id",
			"index",
			"outcome",
			"stopReason",
			"tokens",
			"tools",
			"toolsAvailable",
			"triggers",
			"turns",
		]),
	Object.keys(report.topRuns[0]!).sort(),
);
check(
	"daily keys are stable",
	JSON.stringify(Object.keys(today!).sort()) ===
		JSON.stringify(["activeMs", "cacheHitShare", "cost", "day", "durationMs", "idleMs", "runs", "tokens", "turns"]),
	Object.keys(today!).sort(),
);
check(
	"notes are flattened one-liners",
	partial.notes.every((note) => note === oneLine(note)),
	partial.notes,
);

// ---------------------------------------------------------------------------
// CLI surface
// ---------------------------------------------------------------------------

interface Captured {
	code: number;
	stdout: string;
	stderr: string;
}

async function capture(run: () => Promise<number>): Promise<Captured> {
	const stdout = process.stdout as unknown as { write: (chunk: string) => boolean };
	const stderr = process.stderr as unknown as { write: (chunk: string) => boolean };
	const writeOut = stdout.write;
	const writeErr = stderr.write;
	let capturedOut = "";
	let capturedErr = "";
	stdout.write = (chunk: string) => {
		capturedOut += String(chunk);
		return true;
	};
	stderr.write = (chunk: string) => {
		capturedErr += String(chunk);
		return true;
	};
	try {
		const code = await run();
		return { code, stdout: capturedOut, stderr: capturedErr };
	} finally {
		stdout.write = writeOut;
		stderr.write = writeErr;
	}
}

section("cli");
const originalCwd = process.cwd();
process.chdir(mainFixture.root);
try {
	const jsonRun = await capture(() => main(["usage", "--json", "--days", "7"]));
	check("`alive usage --json` exits 0", jsonRun.code === 0, jsonRun.stderr);
	let parsed: UsageReport | undefined;
	try {
		parsed = JSON.parse(jsonRun.stdout) as UsageReport;
	} catch {
		parsed = undefined;
	}
	check("`--json` prints the report object", parsed?.report === "alive-usage" && parsed?.window.days === 7, parsed?.report);
	check("`--json` totals match the builder", parsed?.totals.runs === report.totals.runs && parsed?.totals.cost === report.totals.cost);
	check("`--json` never contains prompt text", !jsonRun.stdout.includes(SECRET_PROMPT) && !jsonRun.stdout.includes(SECRET_OUTBOUND));

	const tableRun = await capture(() => main(["usage", "--agent", "main", "--days", "7"]));
	check("`alive usage` prints a table", tableRun.code === 0 && tableRun.stdout.includes("chat vs workers"));
	check(
		"the table has the expected sections",
		tableRun.stdout.includes("per day") &&
			tableRun.stdout.includes("top 10 runs by cost") &&
			tableRun.stdout.includes("failed / aborted runs") &&
			tableRun.stdout.includes("cache hit share"),
	);
	check("the table never contains prompt or outbound text", !tableRun.stdout.includes(SECRET_PROMPT) && !tableRun.stdout.includes(SECRET_OUTBOUND));

	const badDay = await capture(() => main(["usage", "--days", "zero"]));
	check("`--days` is validated", badDay.code === 1 && badDay.stderr.includes("--days"), badDay.stderr);
	const unknownAgent = await capture(() => main(["usage", "--agent", "nope"]));
	check(
		"an unknown `--agent` fails with the known ids",
		unknownAgent.code === 1 && unknownAgent.stderr.includes("unknown agent") && unknownAgent.stderr.includes("main"),
		unknownAgent.stderr,
	);
} finally {
	process.chdir(originalCwd);
}

if (failures > 0) {
	process.stdout.write(`\n${failures} check(s) failed\n`);
	process.exitCode = 1;
} else {
	process.stdout.write("\nall usage checks passed\n");
}
