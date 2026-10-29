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
import {
	loadMemoryPage,
	MEMORY_MAX_ITEMS,
	MEMORY_MAX_TEXT_CHARS,
	openMemoryDatabaseReadOnly,
} from "../dashboard/memory.js";
import {
	CsrfTokenStore,
	DASHBOARD_BACKUPS_DIR,
	DASHBOARD_BACKUP_KEEP,
	DASHBOARD_CSRF_TTL_MS,
	DASHBOARD_MAX_BODY_BYTES,
	SettingsEditError,
	applySettingsEdit,
	findSecretLikeValues,
	isInsideDirectory,
	listDashboardBackups,
	loadSettingsView,
	parseSettingsSubmission,
	resolveWritableTarget,
} from "../dashboard/settings.js";
import { DEFAULT_SECRETS_CONFIG, createMaskContext, maskSecrets } from "../secrets.js";
import { MemoryStore } from "../store/memory.js";
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
import { renderAgentPage, renderIndexPage, renderMemoryPage, renderRunPage, renderSettingsPage } from "../dashboard/render.js";
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

// Memory fixtures: summary.md, notes.json + notes/, and a journal with enough
// entries to exercise the section cap. The sqlite facts are created with the
// project's own MemoryStore (stubbed embeddings) inside main().
fs.writeFileSync(path.join(root, "summary.md"), "# Summary\n\ndeploy plan lives here.\n", "utf8");
writeJson(path.join(stateDir, "notes.json"), {
	status: "waiting on deploy",
	secret: `notes token ${GITHUB_TOKEN}`,
	huge: `huge note ${'x'.repeat(MEMORY_MAX_TEXT_CHARS + 50)}`,
});
fs.mkdirSync(path.join(stateDir, "notes"), { recursive: true });
fs.writeFileSync(path.join(stateDir, "notes", "plan.md"), "# Plan\n\nfinish the memory page.\n", "utf8");
fs.mkdirSync(path.join(stateDir, "journal"), { recursive: true });
fs.writeFileSync(
	path.join(stateDir, "journal", "2026-02-01.md"),
	`# Journal 2026-02-01\n\n${
		Array.from({ length: 205 }, (_, index) => `## 00:${String(index % 60).padStart(2, "0")} — filler item ${index}`).join("\n\n")
	}\n\n## 23:58 — token ${TELEGRAM_TOKEN}\n\n## 23:59 — check deploy\n`,
	"utf8",
);

async function createMemoryFacts(databasePath: string): Promise<void> {
	const originalFetch = globalThis.fetch;
	globalThis.fetch = async () => new Response(JSON.stringify({ result: { data: [[1, 0, 0]] } }), { status: 200 });
	try {
		const store = new MemoryStore({
			databasePath,
			embeddingProvider: "cloudflare",
			embeddingBaseUrl: "https://memory.invalid/embeddings",
			embeddingApiKey: "test-token",
			embeddingModel: "test-model",
			embeddingDimensions: 3,
			revisionThreshold: 0.82,
		});
		await store.init();
		await store.retain(["deploy window is Friday 14:00"], ["project:shared"]);
		await store.retain(["deploy window is Friday 15:30"], ["project:shared"]);
		await store.retain([`api key ${OPENAI_KEY}`], ["agent:main"]);
		await store.retain(["unrelated coffee fact"], ["agent:other"]);
		await store.close();
	} finally {
		globalThis.fetch = originalFetch;
	}
}

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

const memoryDbPath = path.join(stateDir, "memory.sqlite");

// Settings fixtures: a managed profile whose SOUL.md path is configured under
// `prompts/` (so a hardcoded "SOUL.md" in the project root would be wrong), and
// one whose soul path escapes its own directory so writes must be refused.
const editorDir = path.join(stateDir, "agents", "editor");
const escapedDir = path.join(stateDir, "agents", "escaped");
const editorSoulFile = path.join(editorDir, "prompts", "SOUL.md");
const editorContractFile = path.join(editorDir, "CONTRACT.md");
const editorSummaryFile = path.join(editorDir, "summary.md");
const escapedSoulFile = path.join(stateDir, "agents", "outside-SOUL.md");

/** Created inside `main()` so the profiles fixture above keeps its two agents. */
function createSettingsFixtures(): void {
	writeJson(path.join(editorDir, "alive.config.json"), {
		name: "Editor",
		model: "openai/gpt-test",
		stateDir: "state",
		workspace: "workspace",
		soulFile: "prompts/SOUL.md",
		sandbox: { enabled: false },
		tools: { bash: true, allowlist: ["read", "write", "edit", "bash", "idle"] },
		workers: { enabled: false, permissions: { worktree: false, pullRequest: false } },
	});
	fs.mkdirSync(path.join(editorDir, "prompts"), { recursive: true });
	fs.writeFileSync(editorSoulFile, "# Editor soul\n\nedit me.\n", "utf8");
	fs.writeFileSync(editorContractFile, `# Role: editor\n\nnever leak ${GITHUB_TOKEN}\n`, "utf8");
	fs.writeFileSync(editorSummaryFile, "# Summary\n\nold summary\n", "utf8");

	writeJson(path.join(escapedDir, "alive.config.json"), {
		name: "Escaped",
		model: "openai/gpt-test",
		stateDir: "state",
		workspace: "workspace",
		soulFile: "../outside-SOUL.md",
		sandbox: { enabled: false },
	});
	fs.writeFileSync(escapedSoulFile, "# Outside soul\n\nmust not be written.\n", "utf8");
	fs.writeFileSync(path.join(escapedDir, "CONTRACT.md"), "# Role: escaped\n", "utf8");
	fs.writeFileSync(path.join(escapedDir, "summary.md"), "# Summary\n", "utf8");
}

function reloadProfile(id: string): DashboardProfile {
	const profiles = loadDashboard(loadRootConfig({ rootDir: root }));
	const profile = findProfile(profiles, id);
	if (!profile) throw new Error(`test profile not found: ${id}`);
	return profile;
}

function readText(file: string): string {
	try {
		return fs.readFileSync(file, "utf8");
	} catch {
		return "";
	}
}

/** Assert that an edit throws the dashboard's typed rejection. */
function expectSettingsError(
	name: string,
	run: () => unknown,
	expect: { status?: number; includes?: string[] } = {},
): void {
	try {
		run();
		check(name, false, "no error was thrown");
		return;
	} catch (error) {
		const status = error instanceof SettingsEditError ? error.status : undefined;
		const message = error instanceof Error ? error.message : String(error);
		const statusOk = expect.status === undefined || status === expect.status;
		const textOk = (expect.includes ?? []).every((part) => message.includes(part));
		check(name, statusOk && textOk, { status, message });
	}
}

async function main(): Promise<void> {
	await createMemoryFacts(memoryDbPath);

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

	section("memory page");
	const memory = loadMemoryPage(main);
	check("memory path resolves to the profile's sqlite", memory.databasePath === memoryDbPath, memory.databasePath);
	check("facts are grouped into current + revision chains", memory.facts.groups.length === 3 && memory.facts.total === 4, { groups: memory.facts.groups.length, total: memory.facts.total });
	const deployGroup = memory.facts.groups.find((group) => group.current?.text.includes("15:30"));
	check("the current revision is the active fact", deployGroup?.current?.active === true, deployGroup?.current);
	check("the older revision is kept under the current one", deployGroup?.revisions.length === 1 && deployGroup.revisions[0]!.text.includes("14:00"), deployGroup?.revisions.map((fact) => fact.text));
	check("fact scopes and timestamps are preserved", deployGroup?.current?.scopes.includes("project:shared") === true && deployGroup.current.validFrom.length > 0 && deployGroup.current.createdAt.length > 0, deployGroup?.current);
	check("summary.md is read", memory.summary.item?.text.includes("deploy plan") === true, memory.summary);
	check("notes.json keys become notes", memory.notes.items.some((item) => item.title === "status" && item.text.includes("waiting on deploy")), memory.notes.items.map((item) => item.title));
	check("notes/ files are read too", memory.notes.items.some((item) => item.title === "plan.md" && item.text.includes("finish the memory page")), memory.notes.items.map((item) => item.title));
	check("journal entries are read newest first with dates", memory.journal.items[0]?.title.startsWith("2026-02-01") === true && memory.journal.items[0]!.text.includes("check deploy"), memory.journal.items.slice(0, 3));
	check("journal item cap reports showing X of Y", memory.journal.total === 207 && memory.journal.shown === MEMORY_MAX_ITEMS, { total: memory.journal.total, shown: memory.journal.shown });
	check("oversized note text is truncated", memory.notes.items.some((item) => item.title === "huge" && item.truncated && item.originalChars > MEMORY_MAX_TEXT_CHARS), memory.notes.items.find((item) => item.title === "huge"));

	const lower = loadMemoryPage(main, { query: "deploy" });
	const upper = loadMemoryPage(main, { query: "DEPLOY" });
	check("search filters facts case-insensitively", lower.facts.matches === 2 && upper.facts.matches === 2, { lower: lower.facts.matches, upper: upper.facts.matches });
	check("search keeps the matching current revision and its older revision", lower.facts.groups.length === 1 && lower.facts.groups[0]!.current?.text.includes("15:30") === true && lower.facts.groups[0]!.revisions.some((fact) => fact.text.includes("14:00")), lower.facts.groups);
	check("search filters notes", lower.notes.matches === 1 && lower.notes.items.length === 1 && lower.notes.items[0]!.title === "status", { matches: lower.notes.matches, items: lower.notes.items.map((item) => item.title) });
	check("search filters journal entries", lower.journal.matches === 1 && lower.journal.items.length === 1 && lower.journal.items[0]!.text.includes("check deploy"), { matches: lower.journal.matches, items: lower.journal.items });
	check("search counts summary occurrences", lower.summary.matches === 1, lower.summary.matches);
	const noMatch = loadMemoryPage(main, { query: "no-such-memory-term-xyz" });
	check("a miss returns empty sections", noMatch.facts.groups.length === 0 && noMatch.notes.items.length === 0 && noMatch.journal.items.length === 0 && noMatch.summary.item === undefined, { facts: noMatch.facts, notes: noMatch.notes.items.length });
	check("search terms are length-capped before reaching sqlite", loadMemoryPage(main, { query: "x".repeat(500) }).query.length === 200);

	const sqliteBefore = fs.readFileSync(memoryDbPath);
	const memoryHtml = renderMemoryPage(memory, renderContext);
	const searchHtml = renderMemoryPage(lower, renderContext);
	check("memory page renders the current fact prominently", memoryHtml.includes("deploy window is Friday 15:30") && memoryHtml.includes("current"), memoryHtml.includes("deploy window is Friday 15:30"));
	check("memory page renders older revisions collapsed in details", memoryHtml.includes("deploy window is Friday 14:00") && memoryHtml.includes("older revision") && memoryHtml.includes("<details"), memoryHtml.includes("older revision"));
	check("memory page renders summary, notes and journal", memoryHtml.includes("deploy plan lives here") && memoryHtml.includes("waiting on deploy") && memoryHtml.includes("finish the memory page") && memoryHtml.includes("check deploy"));
	check("memory page shows truncation notes", memoryHtml.includes("truncated: showing the first"));
	check("memory page shows the section cap", memoryHtml.includes(`showing ${MEMORY_MAX_ITEMS} of 207`), memoryHtml.match(/showing \d+ of \d+ journal/));
	check("search page shows match counts", searchHtml.includes("matches:") && searchHtml.includes("facts 2") && searchHtml.includes("journal 1"), searchHtml.match(/matches:[^<]+/));
	check("search page hides non-matching facts", !searchHtml.includes("unrelated coffee fact"), searchHtml.includes("unrelated coffee fact"));
	check("memory page masks a secret in a fact", !memoryHtml.includes(OPENAI_KEY) && /\[openai#\d+\]/.test(memoryHtml), /\[openai#\d+\]/.test(memoryHtml));
	check("memory page masks a secret in a note", !memoryHtml.includes(GITHUB_TOKEN) && /\[github#\d+\]/.test(memoryHtml), /\[github#\d+\]/.test(memoryHtml));
	check("memory page masks a secret in the journal", !memoryHtml.includes(TELEGRAM_TOKEN) && /\[telegram-bot#\d+\]/.test(memoryHtml), /\[telegram-bot#\d+\]/.test(memoryHtml));

	const readOnly = openMemoryDatabaseReadOnly(memoryDbPath);
	let writeRefused = false;
	try {
		readOnly.exec("INSERT INTO alive_memories (id, text, embedding, scopes, created_at, valid_from, active, supersedes) VALUES ('x', 'x', '[]', '[]', 'x', 'x', 1, '[]')");
	} catch {
		writeRefused = true;
	} finally {
		readOnly.close();
	}
	check("the memory sqlite handle refuses writes", writeRefused);
	check("reading memory did not modify the sqlite file", fs.readFileSync(memoryDbPath).equals(sqliteBefore));
	check("the agent page links to the memory page", agentHtml.includes(`/agent/main/memory`), agentHtml.includes("/memory"));

	// ------------------------------------------------------------------
	// settings (the dashboard's only write path)
	// ------------------------------------------------------------------
	createSettingsFixtures();
	let editor = reloadProfile("editor");
	const escaped = reloadProfile("escaped");
	const editorBackupDir = path.join(editorDir, "state", DASHBOARD_BACKUPS_DIR);

	section("settings page");
	const editorView = loadSettingsView(editor);
	check("settings page shows the configured model", editorView.model === "openai/gpt-test", editorView.model);
	check(
		"settings page shows the tool allowlist",
		editorView.allowlist.join(",") === "read,write,edit,bash,idle",
		editorView.allowlist,
	);
	check(
		"settings page shows workers/sandbox/browser permission flags",
		editorView.flags.some((flag) => flag.path === "workers.permissions.pullRequest" && flag.value === false) &&
			editorView.flags.some((flag) => flag.path === "sandbox.enabled" && flag.value === false) &&
			editorView.flags.some((flag) => flag.path === "modules.browser.enabled" && flag.value === false) &&
			editorView.flags.some((flag) => flag.path === "tools.bash" && flag.value === true),
		editorView.flags,
	);
	check(
		"prompt paths are resolved from the config, not hardcoded project-relative names",
		editorView.prompts.find((prompt) => prompt.key === "soul")?.path === editorSoulFile &&
			editorView.prompts.find((prompt) => prompt.key === "contract")?.path === editorContractFile &&
			editorView.prompts.find((prompt) => prompt.key === "summary")?.path === editorSummaryFile,
		editorView.prompts.map((prompt) => prompt.path),
	);
	check(
		"the editable JSON textarea is prefilled with the effective config",
		(JSON.parse(editorView.configJson) as { tools?: { allowlist?: string[] } }).tools?.allowlist?.includes("idle") === true,
		editorView.configJson.slice(0, 80),
	);
	check("the backup directory is inside the profile state dir", editorView.backupsDir === editorBackupDir, editorView.backupsDir);
	check(
		"a soul path outside the profile is flagged, not silently edited",
		loadSettingsView(escaped).prompts.find((prompt) => prompt.key === "soul")?.insideProfile === false,
		escaped.config.paths.soulPath,
	);
	check("path containment helper rejects siblings and traversal", !isInsideDirectory(editorDir, escapedSoulFile) && isInsideDirectory(editorDir, editorSoulFile));
	const escapedLocalConfig = path.join(escapedDir, "alive.config.local.json");
	writeJson(escapedLocalConfig, { name: "Escaped local" });
	check(
		"a machine-local override disables the config textarea",
		loadSettingsView(reloadProfile("escaped")).configDisabledReason?.includes("alive.config.local.json") === true,
		loadSettingsView(reloadProfile("escaped")).configDisabledReason,
	);
	expectSettingsError(
		"config edits are refused when alive.config.local.json overrides them",
		() => applySettingsEdit(reloadProfile("escaped"), { configText: JSON.stringify({ model: "openai/other" }), prompts: {} }),
		{ status: 400, includes: ["alive.config.local.json"] },
	);
	fs.rmSync(escapedLocalConfig);
	expectSettingsError(
		"a writable target outside the profile is refused",
		() => resolveWritableTarget(editorDir, escapedSoulFile),
		{ status: 400, includes: ["outside the profile directory"] },
	);
	const editorHtml = renderSettingsPage(editorView, renderContext, { csrfToken: "csrf-render-token" });
	check("the settings form is a plain POST form to the settings route", editorHtml.includes('method="post"') && editorHtml.includes('action="/agent/editor/settings"'), editorHtml.includes("<form"));
	check("the form carries the per-render CSRF token", editorHtml.includes('name="csrf" value="csrf-render-token"'));
	check("the page renders current values", editorHtml.includes("openai/gpt-test") && editorHtml.includes("read, write, edit, bash, idle") && editorHtml.includes("edit me."));
	check("the page names the real prompt paths", editorHtml.includes(editorSoulFile) && editorHtml.includes(editorSummaryFile));
	check("the page shows where backups go", editorHtml.includes(editorBackupDir));
	check("the page says secrets belong in .env", editorHtml.includes(".env") && editorHtml.toLowerCase().includes("secret"));
	check("the page masks secrets in prompt files", !editorHtml.includes(GITHUB_TOKEN) && /\[github#\d+\]/.test(editorHtml));
	check("the agent page links to the settings page", agentHtml.includes("/agent/main/settings"));

	section("settings CSRF tokens");
	const csrfStore = new CsrfTokenStore();
	const issued = csrfStore.issue("editor");
	check("a freshly issued token is accepted", csrfStore.consume("editor", issued) === true);
	check("a token is single-use", csrfStore.consume("editor", issued) === false);
	const bound = csrfStore.issue("editor");
	check("a token is bound to its agent id", csrfStore.consume("writer", bound) === false);
	check("a missing token is rejected", csrfStore.consume("editor", "") === false);
	const expired = csrfStore.issue("editor", 1_000);
	check("an expired token is rejected", csrfStore.consume("editor", expired, 1_000 + DASHBOARD_CSRF_TTL_MS + 1) === false);

	section("settings form parsing");
	const parsedForm = parseSettingsSubmission(
		new URLSearchParams("config=%7B%7D&prompt%3Asoul=hello%0D%0Aworld"),
	);
	check("textareas are normalised from CRLF to LF", parsedForm.prompts.soul === "hello\nworld", parsedForm.prompts.soul);
	check("an absent prompt field stays absent", parsedForm.prompts.contract === undefined);
	expectSettingsError(
		"unknown form fields are rejected",
		() => parseSettingsSubmission(new URLSearchParams("config=%7B%7D&evil=1")),
		{ status: 400, includes: ["unknown form field"] },
	);
	expectSettingsError(
		"duplicated form fields are rejected",
		() => parseSettingsSubmission(new URLSearchParams("config=%7B%7D&config=%7B%7D")),
		{ status: 400, includes: ["more than once"] },
	);
	expectSettingsError(
		"an empty submission is rejected",
		() => parseSettingsSubmission(new URLSearchParams("")),
		{ status: 400, includes: ["no settings"] },
	);

	section("settings validation (no write on rejection)");
	const untouchedTree = snapshotTree(editorDir);
	expectSettingsError(
		"invalid JSON is rejected",
		() => applySettingsEdit(editor, { configText: "{not json", prompts: {} }),
		{ status: 400, includes: ["not valid JSON"] },
	);
	expectSettingsError(
		"an unknown top-level config field is rejected",
		() => applySettingsEdit(editor, { configText: JSON.stringify({ surprise: true }), prompts: {} }),
		{ status: 400, includes: ["unknown config field: surprise"] },
	);
	expectSettingsError(
		"an unknown nested config field is rejected",
		() => applySettingsEdit(editor, { configText: JSON.stringify({ tools: { allowlist: ["read"], typo: 1 } }), prompts: {} }),
		{ status: 400, includes: ["unknown config field: tools.typo"] },
	);
	expectSettingsError(
		"a wrong value type is rejected",
		() => applySettingsEdit(editor, { configText: JSON.stringify({ sandbox: { enabled: "yes" } }), prompts: {} }),
		{ status: 400, includes: ["sandbox.enabled"] },
	);
	expectSettingsError(
		"the project's workers validator runs before writing",
		() => applySettingsEdit(editor, {
			configText: JSON.stringify({ workers: { enabled: true, models: ["openai/gpt-test"], permissions: { pullRequest: true } } }),
			prompts: {},
		}),
		{ status: 400, includes: ["pullRequest requires"] },
	);
	expectSettingsError(
		"the project's sandbox validator runs before writing",
		() => applySettingsEdit(editor, { configText: JSON.stringify({ sandbox: { networkAccess: "everything" } }), prompts: {} }),
		{ status: 400, includes: ["networkAccess"] },
	);
	expectSettingsError(
		"a secret-looking value is refused and .env is named",
		() => applySettingsEdit(editor, { configText: JSON.stringify({ model: OPENAI_KEY }), prompts: {} }),
		{ status: 400, includes: ["looks like a secret", ".env", "model"] },
	);
	expectSettingsError(
		"an unchanged config is not an edit",
		() => applySettingsEdit(editor, { configText: editorView.configJson, prompts: {} }),
		{ status: 400, includes: ["nothing to save"] },
	);
	expectSettingsError(
		"a write outside the profile directory is refused",
		() => applySettingsEdit(escaped, { prompts: { soul: "# Escaped edit\n" } }),
		{ status: 400, includes: ["outside the profile directory"] },
	);
	check("rejected edits left every file untouched", snapshotTree(editorDir) === untouchedTree);
	check("the outside file was not written", readText(escapedSoulFile) === "# Outside soul\n\nmust not be written.\n", readText(escapedSoulFile));
	check("the current contract still holds its secret", readText(editorContractFile).includes(GITHUB_TOKEN));
	const maskedContract = maskSecrets(readText(editorContractFile), DEFAULT_SECRETS_CONFIG, {}, createMaskContext());
	expectSettingsError(
		"a renderer-masked secret is not written back over the real value",
		() => applySettingsEdit(editor, { prompts: { contract: maskedContract } }),
		{ status: 400, includes: ["mask placeholder"] },
	);
	check("the masked round-trip wrote nothing", readText(editorContractFile) === `# Role: editor\n\nnever leak ${GITHUB_TOKEN}\n`);
	check(
		"secret detection reuses the project's masker",
		findSecretLikeValues({ model: OPENAI_KEY }, DEFAULT_SECRETS_CONFIG).join(",") === "model",
		findSecretLikeValues({ model: OPENAI_KEY }, DEFAULT_SECRETS_CONFIG),
	);

	section("settings edit: config");
	const configFile = path.join(editorDir, "alive.config.json");
	const originalConfigText = readText(configFile);
	const configEdit = applySettingsEdit(editor, {
		configText: JSON.stringify(
			{
				model: "anthropic/claude-edited",
				tools: { allowlist: ["read", "write", "idle"], bash: false },
				sandbox: { networkAccess: "unrestricted" },
				workers: { permissions: { worktree: true } },
			},
			null,
			2,
		),
		prompts: {},
	});
	const savedConfig = JSON.parse(readText(configFile)) as {
		model?: string;
		name?: string;
		stateDir?: string;
		tools?: { allowlist?: string[]; bash?: boolean };
		sandbox?: { networkAccess?: string };
		workers?: { permissions?: { worktree?: boolean } };
	};
	check("a valid config edit is written", configEdit.changed.some((change) => change.kind === "config"));
	check("the model is updated", savedConfig.model === "anthropic/claude-edited", savedConfig.model);
	check("the tool allowlist and bash flag are updated", savedConfig.tools?.allowlist?.join(",") === "read,write,idle" && savedConfig.tools?.bash === false, savedConfig.tools);
	check("nested sandbox/workers flags are updated", savedConfig.sandbox?.networkAccess === "unrestricted" && savedConfig.workers?.permissions?.worktree === true, { sandbox: savedConfig.sandbox, workers: savedConfig.workers });
	check("unrelated config fields are preserved", savedConfig.name === "Editor" && savedConfig.stateDir === "state", { name: savedConfig.name, stateDir: savedConfig.stateDir });
	const configBackups = listDashboardBackups(editor, configFile);
	check("the config edit made one backup", configBackups.length === 1, configBackups.map((backup) => backup.name));
	check("the config backup holds the previous version", readText(configBackups[0]!.path) === originalConfigText);
	check("the config backup path is under <profile>/state/dashboard-backups", path.dirname(configBackups[0]!.path) === editorBackupDir, configBackups[0]!.path);
	editor = reloadProfile("editor");
	check("the edited model is effective after reload", editor.config.config.model === "anthropic/claude-edited", editor.config.config.model);

	section("settings edit: prompt files");
	const previousSoul = readText(editorSoulFile);
	const promptEdit = applySettingsEdit(editor, { prompts: { soul: "# Editor soul\n\nedited by the dashboard.\n" } });
	check("a valid prompt edit is written", readText(editorSoulFile) === "# Editor soul\n\nedited by the dashboard.\n", readText(editorSoulFile));
	check("the edit reports the prompt it changed", promptEdit.changed.length === 1 && promptEdit.changed[0]!.kind === "soul", promptEdit.changed);
	const soulBackups = listDashboardBackups(editor, editorSoulFile);
	check("the prompt edit made one backup", soulBackups.length === 1, soulBackups.map((backup) => backup.name));
	check("the backup holds the previous content", readText(soulBackups[0]!.path) === previousSoul);
	check("the backup is named after the original file", soulBackups[0]!.originalName === "SOUL.md" && soulBackups[0]!.path.startsWith(editorBackupDir), soulBackups[0]);
	const afterEditView = loadSettingsView(editor);
	const afterEditHtml = renderSettingsPage(afterEditView, renderContext, { csrfToken: "t" });
	check("after an edit the page shows the new value", afterEditHtml.includes("edited by the dashboard."));
	check("the previous version is still in the backup", readText(soulBackups[0]!.path).includes("edit me."));
	check("the page lists the backup", afterEditHtml.includes(soulBackups[0]!.name), soulBackups[0]!.name);

	section("settings backups: cap");
	const capBase = base + 1_000_000;
	for (let index = 0; index < DASHBOARD_BACKUP_KEEP + 5; index += 1) {
		applySettingsEdit(
			reloadProfile("editor"),
			{ prompts: { summary: `# Summary\n\nrevision ${index}\n` } },
			{ now: capBase + index * 1_000 },
		);
	}
	const cappedBackups = listDashboardBackups(reloadProfile("editor"), editorSummaryFile);
	check(`backups are capped at ${DASHBOARD_BACKUP_KEEP}`, cappedBackups.length === DASHBOARD_BACKUP_KEEP, cappedBackups.length);
	check("the cap drops the oldest backup", !cappedBackups.some((backup) => readText(backup.path).includes("old summary")), cappedBackups.map((backup) => backup.name));
	check(
		"the newest backup holds the version before the last edit",
		readText(cappedBackups[cappedBackups.length - 1]!.path).includes(`revision ${DASHBOARD_BACKUP_KEEP + 3}`),
		readText(cappedBackups[cappedBackups.length - 1]!.path),
	);
	check("the profile kept editing after the cap", readText(editorSummaryFile).includes(`revision ${DASHBOARD_BACKUP_KEEP + 4}`));

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
	check("memory route", JSON.stringify(resolveDashboardRoute("/agent/main/memory")) === JSON.stringify({ kind: "memory", agentId: "main" }));
	check("traversal-ish memory agent id is 404", resolveDashboardRoute("/agent/..%2fsecret/memory").kind === "not-found");
	check("unknown route is 404", resolveDashboardRoute("/nope").kind === "not-found");
	check("traversal-ish agent id is 404", resolveDashboardRoute("/agent/..%2fsecret").kind === "not-found");

	section("server (ephemeral loopback port)");
	const before = snapshotTree(stateDir);
	const dashboard = createDashboardServer({ rootDir: root, port: 0, allowEphemeralPort: true, now: () => now });
	const address = await dashboard.listen();
	let afterReadOnlyServing = "";
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
		const memoryResponse = await fetch(`${baseUrl}/agent/main/memory`);
		const memoryBody = await memoryResponse.text();
		check("GET /agent/main/memory is 200 with facts and revisions", memoryResponse.status === 200 && memoryBody.includes("deploy window is Friday 15:30") && memoryBody.includes("deploy window is Friday 14:00"), memoryResponse.status);
		const searchResponse = await fetch(`${baseUrl}/agent/main/memory?q=DEPLOY`);
		const searchBody = await searchResponse.text();
		check("GET /agent/main/memory?q= filters case-insensitively", searchResponse.status === 200 && searchBody.includes("deploy window is Friday 15:30") && !searchBody.includes("unrelated coffee fact"), searchResponse.status);
		const missingMemory = await fetch(`${baseUrl}/agent/nobody/memory`);
		check("unknown agent memory page is 404", missingMemory.status === 404, missingMemory.status);
		const missing = await fetch(`${baseUrl}/agent/nobody`);
		check("unknown agent is 404", missing.status === 404, missing.status);
		const post = await fetch(`${baseUrl}/`, { method: "POST" });
		check("POST is refused outside the settings route", post.status === 405, post.status);
		const head = await fetch(`${baseUrl}/`, { method: "HEAD" });
		check("HEAD works without a body", head.status === 200 && (await head.text()) === "", head.status);

		// Read-only pages above must not have touched the profile tree.
		afterReadOnlyServing = snapshotTree(stateDir);

		section("settings over HTTP");
		const settingsUrl = `${baseUrl}/agent/editor/settings`;
		const tokenFrom = (html: string): string => /name="csrf" value="([^"]+)"/.exec(html)?.[1] ?? "";
		const csrfFromPage = async (url = settingsUrl): Promise<string> => tokenFrom(await (await fetch(url)).text());
		const postSettings = (fields: Record<string, string>, url = settingsUrl): Promise<Response> =>
			fetch(url, {
				method: "POST",
				headers: { "content-type": "application/x-www-form-urlencoded" },
				body: new URLSearchParams(fields).toString(),
				redirect: "manual",
			});

		const settingsPage = await fetch(settingsUrl);
		const settingsPageBody = await settingsPage.text();
		check(
			"GET /agent/editor/settings is 200 with a form",
			settingsPage.status === 200 && settingsPageBody.includes('method="post"') && settingsPageBody.includes("save settings"),
			settingsPage.status,
		);
		check("the rendered settings page carries a per-render CSRF token", tokenFrom(settingsPageBody).length >= 32, tokenFrom(settingsPageBody).length);
		check(
			"the settings page CSP allows a same-origin form",
			(settingsPage.headers.get("content-security-policy") ?? "").includes("form-action 'self'"),
			settingsPage.headers.get("content-security-policy"),
		);
		check(
			"read-only pages still forbid form actions",
			(agentResponse.headers.get("content-security-policy") ?? "").includes("form-action 'none'"),
			agentResponse.headers.get("content-security-policy"),
		);
		const rootSettingsPage = await fetch(`${baseUrl}/agent/main/settings`);
		const rootSettingsBody = await rootSettingsPage.text();
		check(
			"the root profile has an editable settings page too",
			rootSettingsPage.status === 200 && rootSettingsBody.includes("save settings") && !rootSettingsBody.includes("config is read-only here"),
			rootSettingsPage.status,
		);
		check(
			"each render gets a different CSRF token",
			tokenFrom(settingsPageBody) !== (await csrfFromPage()),
		);

		const beforeRejected = snapshotTree(editorDir);
		const soulBeforeRejected = readText(editorSoulFile);
		const noToken = await postSettings({ "prompt:soul": "# hijack\n" });
		check("POST without a CSRF token is 403", noToken.status === 403, noToken.status);
		const wrongToken = await postSettings({ csrf: "not-the-token", "prompt:soul": "# hijack\n" });
		const wrongTokenBody = await wrongToken.text();
		check("POST with a wrong CSRF token is 403", wrongToken.status === 403, wrongToken.status);
		check("the 403 page explains the CSRF problem", wrongTokenBody.includes("CSRF"), wrongTokenBody.slice(0, 120));
		const invalidJson = await postSettings({ csrf: await csrfFromPage(), config: "{not json", "prompt:soul": "# hijack\n" });
		const invalidJsonBody = await invalidJson.text();
		check("POST with invalid JSON is 400", invalidJson.status === 400 && invalidJsonBody.includes("not valid JSON"), invalidJson.status);
		const unknownField = await postSettings({ csrf: await csrfFromPage(), config: "{}", evil: "1" });
		check("POST with an unknown form field is 400", unknownField.status === 400 && (await unknownField.text()).includes("unknown form field"), unknownField.status);
		const unknownConfig = await postSettings({ csrf: await csrfFromPage(), config: JSON.stringify({ tools: { allowlist: ["read"], typo: true } }) });
		check("POST with an unknown config field is 400", unknownConfig.status === 400 && (await unknownConfig.text()).includes("unknown config field"), unknownConfig.status);
		const secretPost = await postSettings({ csrf: await csrfFromPage(), config: JSON.stringify({ model: OPENAI_KEY }) });
		const secretBody = await secretPost.text();
		check("POST with a secret-looking value is 400 and names .env", secretPost.status === 400 && secretBody.includes(".env"), secretPost.status);
		check("the rejected secret is never rendered back", !secretBody.includes(OPENAI_KEY));
		const escapedUrl = `${baseUrl}/agent/escaped/settings`;
		const outsidePost = await postSettings({ csrf: await csrfFromPage(escapedUrl), "prompt:soul": "# Escaped edit\n" }, escapedUrl);
		check(
			"POST editing a prompt outside the profile is 400",
			outsidePost.status === 400 && (await outsidePost.text()).includes("outside the profile directory"),
			outsidePost.status,
		);
		check("every rejected POST left the profile untouched", snapshotTree(editorDir) === beforeRejected);
		check("every rejected POST left the prompt file untouched", readText(editorSoulFile) === soulBeforeRejected);
		check("the outside file was not written over HTTP either", readText(escapedSoulFile) === "# Outside soul\n\nmust not be written.\n");

		const contractBefore = readText(editorContractFile);
		const okPost = await postSettings({
			csrf: await csrfFromPage(),
			config: JSON.stringify({ sandbox: { network: false } }),
			"prompt:contract": "# Role: editor\n\nwritten over HTTP.\n",
		});
		check(
			"a valid POST redirects back to the settings page",
			okPost.status === 303 && (okPost.headers.get("location") ?? "").includes("/agent/editor/settings"),
			{ status: okPost.status, location: okPost.headers.get("location") },
		);
		await okPost.text();
		check("the valid POST wrote the prompt file", readText(editorContractFile) === "# Role: editor\n\nwritten over HTTP.\n", readText(editorContractFile));
		const contractBackups = listDashboardBackups(reloadProfile("editor"), editorContractFile);
		check(
			"the valid POST backed up the previous prompt",
			readText(contractBackups[contractBackups.length - 1]?.path ?? "") === contractBefore,
			contractBackups.map((backup) => backup.name),
		);
		const savedPage = await fetch(`${settingsUrl}?saved=1`);
		const savedBody = await savedPage.text();
		check("after the edit the page shows the new value", savedBody.includes("written over HTTP."));
		check("the page shows the saved banner", savedBody.includes("saved."));
		const httpConfig = JSON.parse(readText(path.join(editorDir, "alive.config.json"))) as { sandbox?: { enabled?: boolean; network?: boolean } };
		check("the valid POST wrote the config change", httpConfig.sandbox?.network === false && httpConfig.sandbox?.enabled === false, httpConfig.sandbox);
		check("the page reflects the edited config JSON", savedBody.includes("&quot;network&quot;: false"), savedBody.includes("network"));

		const wrongType = await fetch(settingsUrl, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
		check("POST with the wrong content type is 415", wrongType.status === 415, wrongType.status);
		const oversized = await postSettings({ csrf: await csrfFromPage(), config: JSON.stringify({ model: "a".repeat(DASHBOARD_MAX_BODY_BYTES + 100) }) });
		check("an oversized POST body is 413", oversized.status === 413, oversized.status);
		const postMemory = await fetch(`${baseUrl}/agent/editor/memory`, { method: "POST" });
		check(
			"POST to a non-settings route is 405 with GET in Allow",
			postMemory.status === 405 && (postMemory.headers.get("allow") ?? "").includes("GET"),
			{ status: postMemory.status, allow: postMemory.headers.get("allow") },
		);
		await postMemory.text();
		const putSettings = await fetch(settingsUrl, { method: "PUT" });
		check(
			"PUT on settings is 405 with POST in Allow",
			putSettings.status === 405 && (putSettings.headers.get("allow") ?? "").includes("POST"),
			{ status: putSettings.status, allow: putSettings.headers.get("allow") },
		);
		await putSettings.text();
		const missingSettingsAgent = await fetch(`${baseUrl}/agent/nobody/settings`);
		check("unknown agent settings page is 404", missingSettingsAgent.status === 404, missingSettingsAgent.status);
		const missingSettingsPost = await fetch(`${baseUrl}/agent/nobody/settings`, {
			method: "POST",
			headers: { "content-type": "application/x-www-form-urlencoded" },
			body: "csrf=x",
		});
		check("POST to an unknown agent settings route is 404", missingSettingsPost.status === 404, missingSettingsPost.status);
	} finally {
		await dashboard.close();
	}
	check("serving the read-only pages wrote nothing to the state dir", before === afterReadOnlyServing);

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
