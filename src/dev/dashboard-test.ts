/**
 * Dashboard tests: the read-only state parsers, page masking and bind checks.
 *
 *   npx tsx src/dev/dashboard-test.ts
 *
 * Filesystem fixtures only. The parser checks need no socket; the small route
 * check binds an ephemeral loopback port (127.0.0.1:0) and closes it again.
 */
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { loadConfig } from "../config.js";
import { DEFAULT_SECRETS_CONFIG } from "../secrets.js";
import { formatDuration, localDay } from "../util.js";
import {
	buildTimeline,
	deriveAgentStatus,
	findProfile,
	loadAgentDetail,
	loadDashboard,
	loadRootConfig,
	loadRunDetail,
	readAgentSummary,
	readSessionTurns,
	runOutcome,
	sumRuns,
	toRunView,
	turnsForRun,
	type DashboardProfile,
	type RunView,
} from "../dashboard/state.js";
import { renderAgentPage, renderIndexPage, renderRunPage } from "../dashboard/render.js";
import { createDashboardServer, resolveDashboardRoute, validateDashboardBind } from "../dashboard/server.js";

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

function appendJsonl(file: string, values: unknown[]): void {
	fs.mkdirSync(path.dirname(file), { recursive: true });
	fs.writeFileSync(file, values.map((value) => `${JSON.stringify(value)}\n`).join(""), "utf8");
}

function snapshotTree(dir: string): string {
	const out: string[] = [];
	const walk = (current: string): void => {
		let entries: fs.Dirent[];
		try {
			entries = fs.readdirSync(current, { withFileTypes: true });
		} catch {
			return;
		}
		for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
			const full = path.join(current, entry.name);
			if (entry.isDirectory()) walk(full);
			else out.push(`${path.relative(dir, full)}:${fs.statSync(full).size}`);
		}
	};
	walk(dir);
	return out.join("\n");
}

const root = fs.mkdtempSync(path.join(os.tmpdir(), "alive-dashboard-test-"));

// Times stay inside the current local day so `spend today` is deterministic.
const now = Date.now();
const dayStart = new Date(now);
dayStart.setHours(0, 0, 0, 0);
const base = Math.max(dayStart.getTime(), now - 2 * 3_600_000) + 5 * 60_000;

const GITHUB_TOKEN = `ghp_${"a".repeat(36)}`;
const OPENAI_KEY = "sk-proj-Zx9Qw7Lm2Pv5Rt8Yb3Nc6Hd1";
const TELEGRAM_TOKEN = `123456789:${"B".repeat(35)}`;

const stateDir = path.join(root, ".alive");
writeJson(path.join(root, "alive.config.json"), {
	name: "Root Alive",
	model: "anthropic/claude-test",
	stateDir: ".alive",
	workspace: ".alive/workspace",
	soulFile: "SOUL.md",
	sandbox: { enabled: false },
});
fs.writeFileSync(
	path.join(root, "SOUL.md"),
	`# Who you are\n\nYou are the root test agent. Never print ${GITHUB_TOKEN}.\n`,
	"utf8",
);
fs.writeFileSync(path.join(root, "CONTRACT.md"), "# Role: tester\n\nOnly test things.\n", "utf8");

const runA = {
	id: "run_a",
	index: 1,
	startedAt: base,
	finishedAt: base + 10_000,
	durationMs: 10_000,
	activeMs: 6_000,
	idleMs: 4_000,
	stopReason: "error" as const,
	error: `model call failed with ${OPENAI_KEY}`,
	events: [{ seq: 1, kind: "user_message", thread: "console", title: "hello there" }],
	outbound: [{ thread: "console", text: "hi", delivered: true }],
	remindersCreated: [],
	notesTouched: [],
	journalEntries: 0,
	idleReturns: 0,
	interruptDeliveries: 0,
	nudges: 0,
	turns: 2,
	promptChars: 1_234,
	usage: { input: 10, output: 2, cacheRead: 30, cacheWrite: 4, total: 46, cost: 0.01 },
};
const runB = {
	id: "run_b",
	index: 2,
	startedAt: base + 60_000,
	finishedAt: base + 72_000,
	durationMs: 12_000,
	activeMs: 5_000,
	idleMs: 7_000,
	stopReason: "slept" as const,
	events: [{ seq: 2, kind: "user_message", thread: "console", title: "wake up" }],
	outbound: [],
	remindersCreated: ["rem_1"],
	notesTouched: ["plan"],
	journalEntries: 1,
	idleReturns: 2,
	interruptDeliveries: 0,
	nudges: 0,
	turns: 3,
	promptChars: 2_345,
	usage: { input: 20, output: 4, cacheRead: 40, cacheWrite: 6, total: 70, cost: 0.02 },
	sleep: { forced: false, summaryChars: 42 },
};
const runC = {
	id: "run_c",
	index: 3,
	startedAt: base + 120_000,
	finishedAt: base + 130_000,
	durationMs: 10_000,
	activeMs: 9_000,
	idleMs: 1_000,
	stopReason: "stalled" as const,
	events: [{ seq: 3, kind: "reminder", title: `check deploy ${GITHUB_TOKEN}` }],
	outbound: [],
	remindersCreated: [],
	notesTouched: [],
	journalEntries: 0,
	idleReturns: 1,
	interruptDeliveries: 1,
	nudges: 2,
	turns: 1,
	promptChars: 3_456,
	usage: { input: 30, output: 6, cacheRead: 50, cacheWrite: 8, total: 94, cost: 0.03 },
};

appendJsonl(path.join(stateDir, "runs", "runs.jsonl"), [runA, runB, runC]);
writeJson(path.join(stateDir, "usage.json"), {
	days: {
		[localDay(now)]: { cost: 0.06, runs: 3, turns: 6, input: 60, output: 12 },
	},
});
writeJson(path.join(stateDir, "runtime.json"), {
	pid: process.pid,
	startedAt: base,
	lastTickAt: base + 130_000,
	status: "working",
	runIndex: 3,
	runId: "run_c",
	model: "anthropic/claude-test",
	pending: 0,
	openThreads: 0,
	sleeps: 1,
	mode: "background",
});
writeJson(path.join(stateDir, "reminders.json"), [
	{ id: "rem_1", text: "check deploy", dueAt: base + 90_000, createdAt: base + 80_000, firedAt: base + 91_000 },
	{ id: "rem_2", text: "write the report", dueAt: base + 600_000, createdAt: base + 100_000 },
	{ id: "rem_3", text: "old reminder", dueAt: base + 110_000, createdAt: base + 10_000, cancelledAt: base + 20_000 },
]);
appendJsonl(path.join(stateDir, "inbox", "events.jsonl"), [
	{ seq: 1, id: "evt_1", ts: base + 15_000, kind: "user_message", source: "console", priority: "normal", title: "hello", text: "hello" },
	{ seq: 2, id: "evt_2", ts: base + 30_000, kind: "observability", source: "grafana", priority: "high", title: `deploy failed ${GITHUB_TOKEN}`, text: "the deploy failed" },
	{ seq: 3, id: "evt_3", ts: base + 40_000, kind: "worker", source: "worker", priority: "normal", title: "worker finished", text: "done" },
	{ seq: 4, id: "evt_4", ts: base + 50_000, kind: "reminder", source: "scheduler", priority: "high", title: "reminder fired", text: "check deploy" },
]);

const sessionFile = path.join(stateDir, "sessions", `2026-01-01T00-00-00-000Z_session1.jsonl`);
const sessionEntries: unknown[] = [
	{ type: "session", version: 3, id: "session1", timestamp: new Date(base - 1_000).toISOString(), cwd: root },
	{
		type: "message",
		id: "m1",
		parentId: null,
		timestamp: new Date(base + 1_000).toISOString(),
		message: { role: "user", content: "## AWAKE #1 — first run prompt", timestamp: base + 1_000 },
	},
	{
		type: "message",
		id: "m2",
		parentId: "m1",
		timestamp: new Date(base + 2_000).toISOString(),
		message: {
			role: "assistant",
			content: [
				{ type: "text", text: "checking the workspace" },
				{ type: "toolCall", id: "call_1", name: "bash", arguments: { command: "ls" } },
			],
			api: "anthropic",
			provider: "anthropic",
			model: "claude-test",
			usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
			stopReason: "toolUse",
			timestamp: base + 2_000,
		},
	},
	{
		type: "message",
		id: "m3",
		parentId: "m2",
		timestamp: new Date(base + 4_000).toISOString(),
		message: {
			role: "toolResult",
			toolCallId: "call_1",
			toolName: "bash",
			content: [{ type: "text", text: "file.txt" }],
			isError: false,
			timestamp: base + 4_000,
		},
	},
	{
		type: "message",
		id: "m4",
		parentId: "m3",
		timestamp: new Date(base + 5_000).toISOString(),
		message: { role: "user", content: "## YOU STOPPED WITHOUT IDLING (nudge 1)", timestamp: base + 5_000 },
	},
	{
		type: "message",
		id: "m5",
		parentId: "m4",
		timestamp: new Date(base + 61_000).toISOString(),
		message: { role: "user", content: "## AWAKE #2 — sleep prompt", timestamp: base + 61_000 },
	},
	{
		type: "message",
		id: "m6",
		parentId: "m5",
		timestamp: new Date(base + 62_000).toISOString(),
		message: { role: "assistant", content: [{ type: "text", text: "going to sleep" }], timestamp: base + 62_000 },
	},
	{
		type: "message",
		id: "m7",
		parentId: "m6",
		timestamp: new Date(base + 121_000).toISOString(),
		message: {
			role: "user",
			content: `## AWAKE #3 — reminder check deploy\nuse ${OPENAI_KEY}`,
			timestamp: base + 121_000,
		},
	},
	{
		type: "message",
		id: "m8",
		parentId: "m7",
		timestamp: new Date(base + 122_000).toISOString(),
		message: {
			role: "assistant",
			content: [{ type: "toolCall", id: "call_2", name: "grep", arguments: { pattern: "deploy" } }],
			timestamp: base + 122_000,
		},
	},
	{
		type: "message",
		id: "m9",
		parentId: "m8",
		timestamp: new Date(base + 123_500).toISOString(),
		message: {
			role: "toolResult",
			toolCallId: "call_2",
			toolName: "grep",
			content: [{ type: "text", text: "grep: no such file" }],
			isError: true,
			timestamp: base + 123_500,
		},
	},
	{
		type: "message",
		id: "m10",
		parentId: "m9",
		timestamp: new Date(base + 124_000).toISOString(),
		message: {
			role: "assistant",
			content: [{ type: "text", text: "" }],
			stopReason: "error",
			errorMessage: `provider timed out; key ${TELEGRAM_TOKEN}`,
			timestamp: base + 124_000,
		},
	},
];
appendJsonl(sessionFile, sessionEntries);

// A managed profile: its own state dir, a dead runtime, no usage.json (fallback).
const writerDir = path.join(stateDir, "agents", "writer");
writeJson(path.join(writerDir, "alive.config.json"), {
	name: "Writer",
	model: "openai/gpt-test",
	stateDir: "state",
	workspace: "workspace",
	sandbox: { enabled: false },
});
appendJsonl(path.join(writerDir, "state", "runs", "runs.jsonl"), [
	{
		id: "run_w1",
		index: 1,
		startedAt: base + 200_000,
		finishedAt: base + 210_000,
		durationMs: 10_000,
		activeMs: 10_000,
		idleMs: 0,
		stopReason: "slept",
		events: [],
		outbound: [],
		remindersCreated: [],
		notesTouched: [],
		journalEntries: 0,
		idleReturns: 0,
		interruptDeliveries: 0,
		nudges: 0,
		turns: 1,
		promptChars: 10,
		usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, total: 2, cost: 0.005 },
		sleep: { forced: true, summaryChars: 1 },
	},
]);
writeJson(path.join(writerDir, "state", "runtime.json"), {
	pid: 999_999_999,
	startedAt: base,
	lastTickAt: base,
	status: "stopped",
	runIndex: 1,
	pending: 0,
	openThreads: 0,
	sleeps: 1,
});

async function main(): Promise<void> {
	section("profiles");
	const rootConfig = loadRootConfig({ rootDir: root });
	const profiles = loadDashboard(rootConfig);
	check("lists the root profile as main + managed agents", profiles.map((profile) => profile.id).join(",") === "main,writer", profiles.map((profile) => profile.id));
	const main = findProfile(profiles, "main")!;
	const writer = findProfile(profiles, "writer")!;
	check("root profile name/model come from the config", main.name === "Root Alive" && main.config.config.model === "anthropic/claude-test", { name: main.name, model: main.config.config.model });
	check("managed profile resolves its own state dir", writer.stateDir === path.join(writerDir, "state"), writer.stateDir);
	check("unknown agent is not found", findProfile(profiles, "nobody") === undefined);

	section("agents list");
	const mainSummary = readAgentSummary(main, { now });
	check("summary uses name, model", mainSummary.name === "Root Alive" && mainSummary.model === "anthropic/claude-test", mainSummary);
	check("working runtime -> status working", mainSummary.status === "working", mainSummary.status);
	check("active run is reported as current run", mainSummary.currentRun === "run #3 in progress", mainSummary.currentRun);
	check("spend today comes from usage.json", Math.abs(mainSummary.spendTodayUsd - 0.06) < 1e-9, mainSummary.spendTodayUsd);
	check("runs today comes from usage.json", mainSummary.runsToday === 3, mainSummary.runsToday);
	const writerSummary = readAgentSummary(writer, { now });
	check("dead runtime -> status sleeping", writerSummary.status === "sleeping", writerSummary.status);
	check("spend falls back to today's run records when usage.json is absent", Math.abs(writerSummary.spendTodayUsd - 0.005) < 1e-9, writerSummary.spendTodayUsd);

	section("status derivation");
	const waiting = deriveAgentStatus(
		{ pid: 42, startedAt: base, lastTickAt: base, status: "idle", runIndex: 3, pending: 0, openThreads: 0, sleeps: 0, idling: true, idleSince: now - 5_000 },
		{ now, pidAlive: () => true },
	);
	check("idling runtime -> waiting, with the wait duration", waiting.status === "waiting" && waiting.note.includes("idle since") && waiting.note.includes(formatDuration(5_000)), waiting);
	const paused = deriveAgentStatus(
		{ pid: 42, startedAt: base, lastTickAt: base, status: "paused-budget", runIndex: 3, pending: 0, openThreads: 0, sleeps: 0 },
		{ now, pidAlive: () => true },
	);
	check("budget pause -> waiting", paused.status === "waiting" && paused.note === "paused: budget", paused);
	const sleeping = deriveAgentStatus(null, { now });
	check("missing runtime -> sleeping", sleeping.status === "sleeping", sleeping);
	const dead = deriveAgentStatus(
		{ pid: 42, startedAt: base, lastTickAt: base, status: "stopped", runIndex: 3, pending: 0, openThreads: 0, sleeps: 0 },
		{ now, pidAlive: () => false },
	);
	check("stopped process -> sleeping", dead.status === "sleeping" && dead.note === "runtime stopped", dead);

	section("timeline");
	const detail = loadAgentDetail(main, { now });
	const runItems = detail.timeline.filter((item) => item.kind === "run");
	const sleepItems = detail.timeline.filter((item) => item.kind === "sleep");
	const reminderItems = detail.timeline.filter((item) => item.kind === "reminder");
	const eventItems = detail.timeline.filter((item) => item.kind === "event");
	check("every run appears in the timeline", runItems.length === 3, runItems.length);
	check("newest item first", detail.timeline[0]?.ref === "run_c", detail.timeline[0]);
	check(
		"timeline is sorted newest first",
		detail.timeline.every((item, index) => index === 0 || detail.timeline[index - 1]!.at >= item.at),
		detail.timeline.map((item) => item.at),
	);
	check("sleep is shown with a context-reset note", sleepItems.length === 1 && sleepItems[0]!.detail!.includes("transcript was wiped") && sleepItems[0]!.title.includes("context reset"), sleepItems[0]);
	check("reminder schedule/fire/cancel items are present", reminderItems.length === 5, reminderItems.map((item) => item.title));
	check("high-priority and worker inbox events are key events", eventItems.length === 2, eventItems.map((item) => item.title));
	check("normal user messages are not duplicated as key events", !eventItems.some((item) => item.title.includes("hello")), eventItems.map((item) => item.title));
	check("reminder inbox events are represented by the reminder store", !eventItems.some((item) => item.title.includes("reminder fired")), eventItems.map((item) => item.title));
	check("run timeline item links to the run page", runItems[0]!.href === "/run/main/run_c", runItems[0]!.href);
	check("run timeline item carries the trigger", runItems[0]!.title.startsWith("trigger: reminder"), runItems[0]);

	section("run totals");
	const allRuns: RunView[] = [toRunView(runA), toRunView(runB), toRunView(runC)];
	const totals = sumRuns(allRuns);
	check("input tokens summed", totals.input === 60, totals.input);
	check("output tokens summed", totals.output === 12, totals.output);
	check("cacheRead/cacheWrite summed", totals.cacheRead === 120 && totals.cacheWrite === 18, { cacheRead: totals.cacheRead, cacheWrite: totals.cacheWrite });
	check("cost summed", Math.abs(totals.cost - 0.06) < 1e-9, totals.cost);
	check("duration/active/idle summed", totals.durationMs === 32_000 && totals.activeMs === 20_000 && totals.idleMs === 12_000, totals);
	check("outcomes map to sleep/idle/error", runOutcome("slept").key === "sleep" && runOutcome("stalled").key === "idle" && runOutcome("error").key === "error");

	section("prompt extraction");
	const runDetail = loadRunDetail(main, "run_c")!;
	check("run is found by id", runDetail.run.id === "run_c");
	check("system prompt is rebuilt with SOUL.md", runDetail.systemPrompt.text.includes("You are the root test agent."), runDetail.systemPrompt.text.slice(0, 80));
	check("system prompt includes CONTRACT.md", runDetail.systemPrompt.text.includes("Only test things."));
	check("system prompt says it is reconstructed", runDetail.systemPrompt.notes.some((note) => note.includes("reconstructed")), runDetail.systemPrompt.notes);
	check("the run's own prompt is extracted", runDetail.promptTurns.length === 1 && runDetail.promptTurns[0]!.text.includes("AWAKE #3"), runDetail.promptTurns.map((turn) => turn.text));
	check("another run's prompt is not mixed in", !runDetail.promptTurns.some((turn) => turn.text.includes("AWAKE #2")));
	check("prompt availability is reported", runDetail.promptAvailable === true);
	check("nudge prompt of the first run is retained inside that run", (loadRunDetail(main, "run_a")!.promptTurns.length ?? 0) === 2, loadRunDetail(main, "run_a")!.promptTurns.length);
	check("sleeping run has its own prompt only", (loadRunDetail(main, "run_b")!.promptTurns[0]?.text ?? "").includes("AWAKE #2"));
	const runCTurns = readSessionTurns(stateDir);
	check("only session messages inside the run window are used", turnsForRun(runCTurns, loadRunDetail(main, "run_c")!.run).length === 4, turnsForRun(runCTurns, loadRunDetail(main, "run_c")!.run).length);

	section("run detail: tools and errors");
	check("tool call gets a duration and short result", runDetail.toolCalls.length === 1 && runDetail.toolCalls[0]!.name === "grep" && runDetail.toolCalls[0]!.durationMs === 1_500 && runDetail.toolCalls[0]!.isError === true, runDetail.toolCalls);
	check("tool result text is present", runDetail.toolCalls[0]!.result.includes("no such file"), runDetail.toolCalls[0]!.result);
	check("model and tool errors are listed", runDetail.errors.some((error) => error.includes("provider timed out")) && runDetail.errors.some((error) => error.includes("grep")), runDetail.errors);
	check("missing run returns undefined", loadRunDetail(main, "run_missing") === undefined);
	check("run A tool duration is measured too", loadRunDetail(main, "run_a")!.toolCalls[0]!.durationMs === 2_000, loadRunDetail(main, "run_a")!.toolCalls);

	section("masking");
	const renderContext = { secrets: DEFAULT_SECRETS_CONFIG, env: {}, now };
	const indexHtml = renderIndexPage([mainSummary, writerSummary], renderContext);
	const agentHtml = renderAgentPage(detail, renderContext);
	const runHtml = renderRunPage(runDetail, renderContext);
	check("agents page never renders the agent token", !indexHtml.includes(GITHUB_TOKEN));
	check("agent page masks the fake token in an event/trigger title", !agentHtml.includes(GITHUB_TOKEN) && /\[github#\d+\]/.test(agentHtml), { hasMask: /\[github#\d+\]/.test(agentHtml), hasToken: agentHtml.includes(GITHUB_TOKEN) });
	check("run page masks the token in the model error", !runHtml.includes(TELEGRAM_TOKEN), runHtml.includes(TELEGRAM_TOKEN));
	check("run page masks the token in the prompt text", !runHtml.includes(OPENAI_KEY) && /\[openai#\d+\]/.test(runHtml), { hasMask: /\[openai#\d+\]/.test(runHtml), hasToken: runHtml.includes(OPENAI_KEY) });
	check("run page masks the token in the reconstructed system prompt", !runHtml.includes(GITHUB_TOKEN), runHtml.includes(GITHUB_TOKEN));
	check("masking keeps the prompt readable around the placeholder", runHtml.includes("AWAKE #3") && runHtml.includes("You are the root test agent."));
	check("run page states when the exact system prompt is unavailable", runHtml.includes("not persisted") && runHtml.includes("reconstructed"));

	section("bind validation");
	check("accepts 127.0.0.1:7777", JSON.stringify(validateDashboardBind("127.0.0.1", 7777)) === JSON.stringify({ host: "127.0.0.1", port: 7777 }));
	check("normalises localhost to 127.0.0.1", validateDashboardBind("localhost", 1234).host === "127.0.0.1");
	for (const host of ["0.0.0.0", "::", "::1", "192.168.1.10", "example.com", ""]) {
		let refused = false;
		try {
			validateDashboardBind(host, 7777);
		} catch {
			refused = true;
		}
		check(`refuses non-loopback host "${host}"`, refused);
	}
	for (const port of [0, -1, 65_536, Number.NaN, 1.5]) {
		let refused = false;
		try {
			validateDashboardBind("127.0.0.1", port);
		} catch {
			refused = true;
		}
		check(`refuses port ${String(port)}`, refused);
	}
	check("tests may bind an ephemeral port explicitly", validateDashboardBind("127.0.0.1", 0, { allowEphemeralPort: true }).port === 0);

	section("routes");
	check("index route", resolveDashboardRoute("/").kind === "index");
	check("agent route", JSON.stringify(resolveDashboardRoute("/agent/writer")) === JSON.stringify({ kind: "agent", agentId: "writer" }));
	check("run route", JSON.stringify(resolveDashboardRoute("/run/main/run_c")) === JSON.stringify({ kind: "run", agentId: "main", runId: "run_c" }));
	check("unknown route is 404", resolveDashboardRoute("/nope").kind === "not-found");
	check("traversal-ish agent id is 404", resolveDashboardRoute("/agent/..%2fsecret").kind === "not-found");

	section("server (ephemeral loopback port)");
	const before = snapshotTree(stateDir);
	const dashboard = createDashboardServer({ rootDir: root, port: 0, allowEphemeralPort: true, now: () => now });
	const address = await dashboard.listen();
	try {
		const baseUrl = `http://${address.host}:${address.port}`;
		const indexResponse = await fetch(`${baseUrl}/`);
		const indexBody = await indexResponse.text();
		check("GET / is 200 and lists both agents", indexResponse.status === 200 && indexBody.includes("Root Alive") && indexBody.includes("Writer"), indexResponse.status);
		const agentResponse = await fetch(`${baseUrl}/agent/main`);
		const agentBody = await agentResponse.text();
		check("GET /agent/main is 200 with a timeline", agentResponse.status === 200 && agentBody.includes("timeline"), agentResponse.status);
		const runResponse = await fetch(`${baseUrl}/run/main/run_c`);
		const runBody = await runResponse.text();
		check("GET /run/main/run_c is 200 with the prompt section", runResponse.status === 200 && runBody.includes("system prompt"), runResponse.status);
		const missing = await fetch(`${baseUrl}/agent/nobody`);
		check("unknown agent is 404", missing.status === 404, missing.status);
		const post = await fetch(`${baseUrl}/`, { method: "POST" });
		check("POST is refused (read-only)", post.status === 405, post.status);
		const head = await fetch(`${baseUrl}/`, { method: "HEAD" });
		check("HEAD works without a body", head.status === 200 && (await head.text()) === "", head.status);
	} finally {
		await dashboard.close();
	}
	const after = snapshotTree(stateDir);
	check("serving pages wrote nothing to the state dir", before === after);

	section("summary");
	if (failures > 0) {
		process.stdout.write(`\n${failures} check(s) failed\n`);
		process.exitCode = 1;
		return;
	}
	process.stdout.write("\nall dashboard checks passed\n");
}

main().catch((error) => {
	process.stderr.write(`dashboard test crashed: ${error instanceof Error ? (error.stack ?? error.message) : String(error)}\n`);
	process.exitCode = 1;
});
