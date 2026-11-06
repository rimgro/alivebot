/**
 * Prompt cache statistics (#76).
 *
 *   npx tsx src/dev/cache-stats-test.ts
 *
 * Filesystem-only: the daily counter is exercised through a real `RunLog` in a
 * temp state dir, and the prompt text is rendered from a hand-built
 * `AwakePromptInput`. No model, no network.
 */
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { DEFAULT_POLICY } from "../store/policy.js";
import { RunLog, type RunRecord, type RunUsage } from "../store/runs.js";
import { renderAwakePrompt, type AwakePromptInput } from "../runtime/prompt.js";
import { CACHE_WRITE_NOTABLE_TOKENS, cacheHitRate, formatRate, isColdCacheRun } from "../usage/cache.js";
import { localDay } from "../util.js";

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

const root = fs.mkdtempSync(path.join(os.tmpdir(), "alive-cache-stats-test-"));

function usage(overrides: Partial<RunUsage> = {}): RunUsage {
	const input = overrides.input ?? 0;
	const output = overrides.output ?? 0;
	const cacheRead = overrides.cacheRead ?? 0;
	const cacheWrite = overrides.cacheWrite ?? 0;
	return {
		input,
		output,
		cacheRead,
		cacheWrite,
		total: overrides.total ?? input + output + cacheRead + cacheWrite,
		cost: overrides.cost ?? 0,
	};
}

function runRecord(index: number, runUsage: RunUsage, overrides: Partial<RunRecord> = {}): RunRecord {
	const finishedAt = overrides.finishedAt ?? Date.now();
	return {
		id: `run_${index}`,
		index,
		startedAt: finishedAt - 30_000,
		finishedAt,
		durationMs: 30_000,
		activeMs: 25_000,
		idleMs: 5_000,
		stopReason: "slept",
		events: [],
		outbound: [],
		remindersCreated: [],
		notesTouched: [],
		journalEntries: 0,
		idleReturns: 0,
		interruptDeliveries: 0,
		nudges: 0,
		turnCount: 1,
		promptChars: 1_000,
		usage: runUsage,
		...overrides,
	};
}

function promptInput(overrides: Partial<AwakePromptInput> = {}): AwakePromptInput {
	return {
		runIndex: 12,
		runId: "run_test",
		now: Date.UTC(2026, 0, 15, 12, 0, 0),
		events: [],
		redeliveredSeqs: [],
		resumed: false,
		threads: [],
		notes: {},
		reminders: [],
		journalTail: [],
		summary: "Test summary.",
		relevantMemories: [],
		recentRuns: [],
		policy: DEFAULT_POLICY,
		costTodayUsd: 0.5,
		maxDailyCostUsd: 5,
		pendingAfterClaim: 0,
		...overrides,
	};
}

section("cache rate helpers (#76)");
{
	check("a zero denominator has no rate", cacheHitRate({ input: 0, cacheRead: 0 }) === null, cacheHitRate({ input: 0, cacheRead: 0 }));
	check("cacheRead only is a 100% hit rate", cacheHitRate({ input: 0, cacheRead: 100 }) === 1, cacheHitRate({ input: 0, cacheRead: 100 }));
	check("half the prompt tokens cached is 50%", cacheHitRate({ input: 100, cacheRead: 100 }) === 0.5, cacheHitRate({ input: 100, cacheRead: 100 }));
	check("no cacheRead is 0%, not null", cacheHitRate({ input: 100, cacheRead: 0 }) === 0, cacheHitRate({ input: 100, cacheRead: 0 }));
	check("formatRate renders one decimal", formatRate(0.462) === "46.2%", formatRate(0.462));
	check("formatRate renders 0 and 1", formatRate(0) === "0.0%" && formatRate(1) === "100.0%", [formatRate(0), formatRate(1)]);
	check("formatRate renders null as —", formatRate(null) === "—", formatRate(null));
	check("formatRate renders non-finite as —", formatRate(Number.NaN) === "—", formatRate(Number.NaN));
	check("an empty usage has neither a rate nor a dash", formatRate(cacheHitRate({ input: 0, cacheRead: 0 })) === "—");
	check("the notable-write threshold is 1000 tokens", CACHE_WRITE_NOTABLE_TOKENS === 1_000, CACHE_WRITE_NOTABLE_TOKENS);
	check("no cache write is not a cold run", !isColdCacheRun({ cacheRead: 0, cacheWrite: 0 }));
	check("999 written tokens are below the threshold", !isColdCacheRun({ cacheRead: 0, cacheWrite: 999 }));
	check("1000 written tokens with no read is a cold run", isColdCacheRun({ cacheRead: 0, cacheWrite: 1_000 }));
	check("a read disables the cold-run flag", !isColdCacheRun({ cacheRead: 1, cacheWrite: 5_000 }));
}

section("daily usage bucket keeps cacheRead / cacheWrite (#76)");
{
	const stateDir = path.join(root, "fresh");
	const runs = new RunLog(stateDir);
	runs.record(runRecord(1, usage({ input: 100, cacheRead: 300, cacheWrite: 40, cost: 0.01 })));
	runs.record(runRecord(2, usage({ input: 50, cacheRead: 100, cacheWrite: 0, cost: 0.02 })));
	const today = runs.usageToday();
	check("runs are summed", today.runs === 2, today);
	check("input is summed", today.input === 150, today);
	check("cacheRead is summed", today.cacheRead === 400, today);
	check("cacheWrite is summed", today.cacheWrite === 40, today);
	check("the day's rate is computed from the sums", formatRate(cacheHitRate({ input: today.input, cacheRead: today.cacheRead ?? 0 })) === "72.7%", today);
}

section("an old usage.json without cache fields (#76)");
{
	const stateDir = path.join(root, "legacy");
	const day = localDay(Date.now());
	fs.mkdirSync(stateDir, { recursive: true });
	fs.writeFileSync(
		path.join(stateDir, "usage.json"),
		`${JSON.stringify({ days: { [day]: { cost: 0.5, runs: 3, turns: 7, input: 900, output: 90 } } }, null, 2)}\n`,
		"utf8",
	);
	const runs = new RunLog(stateDir);
	const before = runs.usageToday();
	check("the legacy bucket still reads", before.runs === 3 && before.input === 900 && before.cost === 0.5, before);
	check("missing cache fields read as undefined (readers use 0)", before.cacheRead === undefined && before.cacheWrite === undefined, before);
	check("an absent field does not throw: the historical input alone is a 0% rate", formatRate(cacheHitRate({ input: before.input, cacheRead: before.cacheRead ?? 0 })) === "0.0%", before);
	// A new run adds its cache tokens beside the historical numbers; the file is
	// extended, never rewritten backwards.
	runs.record(runRecord(9, usage({ input: 100, cacheRead: 50, cacheWrite: 10, cost: 0.1 })));
	const after = runs.usageToday();
	check("a new record adds cache tokens to the legacy bucket", after.cacheRead === 50 && after.cacheWrite === 10, after);
	check("the legacy counters are preserved", after.runs === 4 && after.input === 1_000, after);
}

section("renderAwakePrompt: cache hit in the budget section (#76)");
{
	const text = renderAwakePrompt(promptInput({
		cacheToday: { input: 100, cacheRead: 100, cacheWrite: 0 },
		recentRuns: [runRecord(3, usage({ input: 100, cacheRead: 300 }))],
	}));
	check(
		"the budget names today's cache hit rate with the formula",
		text.includes("- cache hit today: 50.0% = cacheRead 100 / (input 100 + cacheRead 100) · agent runs only"),
		text.match(/- cache hit today[^\n]*/)?.[0],
	);
	check("the budget names the last run's cache hit rate", text.includes("- cache hit last run: 75.0% (#3)"), text.match(/- cache hit last run[^\n]*/)?.[0]);
	check("a warm run has no cold-cache note", !text.includes("wrote"), text.match(/last run wrote[^\n]*/)?.[0]);
	check("the recent-runs line carries the compact rate", text.includes(", cache 75.0%"), text.match(/Recent runs:\n(?:- [^\n]*\n?)*/)?.[0]);

	const noCacheToday = renderAwakePrompt(promptInput({
		recentRuns: [runRecord(4, usage({ input: 200, cacheRead: 0, cacheWrite: 0 }))],
	}));
	check(
		"without cacheToday the section prints — instead of guessing",
		noCacheToday.includes("- cache hit today: — (no prompt tokens recorded)"),
		noCacheToday.match(/- cache hit today[^\n]*/)?.[0],
	);

	const zeroDenominator = renderAwakePrompt(promptInput({
		cacheToday: { input: 0, cacheRead: 0, cacheWrite: 0 },
	}));
	check(
		"a zero denominator is also —",
		zeroDenominator.includes("- cache hit today: — (no prompt tokens recorded)"),
		zeroDenominator.match(/- cache hit today[^\n]*/)?.[0],
	);
	check(
		"no runs yet keeps the last-run line honest",
		zeroDenominator.includes("- cache hit last run: — (no completed run yet)"),
		zeroDenominator.match(/- cache hit last run[^\n]*/)?.[0],
	);

	const cold = renderAwakePrompt(promptInput({
		cacheToday: { input: 1_000, cacheRead: 0, cacheWrite: 1_500 },
		recentRuns: [runRecord(5, usage({ input: 1_000, cacheRead: 0, cacheWrite: 1_500 }))],
	}));
	check("a cold run reports a 0% last-run rate", cold.includes("- cache hit last run: 0.0% (#5)"), cold.match(/- cache hit last run[^\n]*/)?.[0]);
	check(
		"the prompt never explains the cache write (that is a log signal only)",
		!cold.includes("wrote") && !cold.includes("cache tokens and read none"),
		cold.match(/last run wrote[^\n]*/)?.[0],
	);
	check(
		"a cold run's recent-runs line still shows the plain rate",
		cold.includes(", cache 0.0%") && !cold.includes("cache write"),
		cold.match(/Recent runs:\n(?:- [^\n]*\n?)*/)?.[0],
	);
	const budgetLines = cold.split("### Budget\n\n")[1]?.split("\n\n")[0]?.split("\n") ?? [];
	check("the budget section stays at three lines at most", budgetLines.length <= 3, budgetLines);
}

fs.rmSync(root, { recursive: true, force: true });

process.stdout.write(`\n${failures === 0 ? "all checks passed" : `${failures} check(s) failed`}\n`);
if (failures > 0) process.exit(1);
