/**
 * Integration test for the run lifecycle in `src/runtime/agent.ts` using a fake
 * pi session. No model is involved: the fake "model" drives the real tools, so we
 * can assert that idle → sleep rebuilds the context, that a model which keeps
 * stopping is nudged and stalled out, and that policy-approved notifications are
 * steered into a working run.
 *
 * The last sections cover the empty-wake gate (#116): with an empty inbox the
 * runtime starts no run and prompts no model, consecutive empty wakes stretch the
 * idle interval up to the configured cap, an arriving event starts a run
 * immediately and resets the streak, and an event that is not addressed to the
 * agent (`wake: false`) never starts a run on its own.
 *
 *   npm run test:runner
 */
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { AgentSession, ToolDefinition } from "@earendil-works/pi-coding-agent";
import { loadConfig } from "../config.js";
import { Logger } from "../log.js";
import { EventStore } from "../store/events.js";
import { Journal } from "../store/journal.js";
import { NoteStore } from "../store/notes.js";
import { FakeMemoryStore } from "./fake-memory.js";
import { Outbox } from "../store/outbox.js";
import { PolicyStore } from "../store/policy.js";
import { ReminderStore } from "../store/reminders.js";
import { RUN_TURN_TRACE_LIMIT, RunLog } from "../store/runs.js";
import { ThreadStore } from "../store/threads.js";
import { HistoryStore } from "../store/history.js";
import { RunEventLog } from "../store/run-events.js";
import { AgentRunner, runActiveMs } from "../runtime/agent.js";
import { TurnTraceRecorder } from "../runtime/run-trace.js";
import { hasWakeWorthyPending, WakeScheduler, wakeIntervalMs } from "../runtime/wake.js";
import { createAliveTools, type RunHandle, type ToolDeps } from "../runtime/tools.js";

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

const root = fs.mkdtempSync(path.join(os.tmpdir(), "alive-runner-test-"));
const config = loadConfig({
	cwd: root,
	overrides: {
		loop: {
			pollIntervalMs: 10,
			sleepAfterMs: 60_000,
			runTimeoutMs: 60_000,
			runWarnMs: 10 * 60_000,
			runNoOutboundTurns: 60,
			runVeryLongMs: 3 * 60 * 60_000,
			maxEventsPerIdle: 8,
			maxNudges: 3,
			maxNudgesPerRun: 2,
			interrupt: true,
			emptyWakeBackoff: { enabled: true, afterWakes: 2, maxIntervalMs: 60 * 60_000 },
		},
	},
});
config.config.memory.sharedScopes = ["user:alice", "project:alive"];
const log = new Logger({ console: false, level: "error", scope: "runner-test" });
const store = EventStore.open(config.paths.stateDir);
const reminders = new ReminderStore(config.paths.stateDir);
const notes = new NoteStore(config.paths.stateDir);
const memory = new FakeMemoryStore();
const journal = new Journal(config.paths.stateDir);
const threads = new ThreadStore(config.paths.stateDir);
const outbox = new Outbox(config.paths.stateDir);
const policy = new PolicyStore(config.paths.stateDir);
const history = HistoryStore.open(config.paths.stateDir);
const runs = new RunLog(config.paths.stateDir);
const runEvents = new RunEventLog(config.paths.stateDir);

let currentRun: RunHandle | undefined;
const deps: ToolDeps = {
	config,
	store,
	reminders,
	notes,
	memory,
	journal,
	threads,
	outbox,
	policy,
	history,
	moduleTools: [],
	deliver: async () => undefined,
	getRun: () => currentRun,
	runtimeStatus: () => ({}),
	isStopping: () => false,
	log,
};
const tools = createAliveTools(deps);
const idle = tools.find((t) => t.name === "idle")!;
const sleepTool = tools.find((t) => t.name === "sleep")!;
const retainTool = tools.find((t) => t.name === "retain")!;
type Result = { content: Array<{ text: string }>; terminate?: boolean };
const call = (def: ToolDefinition, params: unknown): Promise<Result> =>
	def.execute("call", params as never, undefined, undefined, {} as never) as Promise<Result>;

type Handler = (session: FakeSession, prompt: string) => Promise<void>;

class FakeSession {
	messages: Array<{ role: string; content: unknown }> = [];
	model = undefined;
	sessionFile: string | undefined;
	isStreaming = false;
	agent: { shouldStopAfterTurn?: (context: unknown, signal?: AbortSignal) => boolean | Promise<boolean> } = {};
	listeners: Array<(event: unknown) => void> = [];
	steered: string[] = [];
	aborted = false;
	disposed = false;
	prompts: string[] = [];
	private stats = {
		sessionFile: undefined,
		sessionId: "fake",
		userMessages: 0,
		assistantMessages: 0,
		toolCalls: 0,
		toolResults: 0,
		totalMessages: 0,
		tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		cost: 0,
	};

	constructor(
		readonly label: string,
		private readonly handler: Handler,
	) {}

	subscribe(listener: (event: unknown) => void): () => void {
		this.listeners.push(listener);
		return () => {
			this.listeners = this.listeners.filter((l) => l !== listener);
		};
	}
	emit(event: unknown): void {
		for (const listener of this.listeners) listener(event);
	}
	getSessionStats(): typeof this.stats {
		return this.stats;
	}
	async prompt(text: string): Promise<void> {
		this.prompts.push(text);
		this.messages.push({ role: "user", content: text });
		await this.handler(this, text);
	}
	async steer(text: string): Promise<void> {
		this.steered.push(text);
	}
	async abort(): Promise<void> {
		this.aborted = true;
	}
	dispose(): void {
		this.disposed = true;
	}
	async turn(): Promise<boolean> {
		return Boolean(await this.agent.shouldStopAfterTurn?.({}, undefined));
	}
}

const created: FakeSession[] = [];
let handler: Handler = async () => undefined;
const createSession = async (): Promise<AgentSession> => {
	const session = new FakeSession(`s${created.length + 1}`, (s, p) => handler(s, p));
	created.push(session);
	return session as unknown as AgentSession;
};

const runner = new AgentRunner({
	config,
	createSession,
	store,
	runs,
	threads,
	policy,
	toolDeps: deps,
	log,
	thoughtsFile: config.paths.thoughtsFile,
	runEvents,
	getRun: () => currentRun,
	setRun: (run) => {
		currentRun = run;
	},
	runtimeStatus: () => ({}),
	isStopping: () => false,
	isBudgetExhausted: () => false,
});
await runner.init();

section("idle returns an event, then sleep resets the context");
{
	handler = async (session) => {
		session.emit({ type: "message_end", message: { role: "assistant", content: [{ type: "text", text: "thinking" }], stopReason: "endTurn" } });
		const incoming = setTimeout(() => store.append({ kind: "user_message", source: "test", priority: "normal", title: "hi", text: "hello there", thread: "alice", expectsReply: true }), 25);
		let idled: Awaited<ReturnType<typeof call>>;
		try { idled = await call(idle, { reason: "waiting for alice" }); }
		finally { clearTimeout(incoming); }
		session.emit({ type: "message_end", message: { role: "assistant", content: idled.content, stopReason: "endTurn" } });
		await session.turn();
		await call(retainTool, { facts: ["Alice asked about the project"], scopes: ["user:alice", "project:alive"] });
		await call(sleepTool, { summary: "answered alice (test)", summary_md: "# Test summary\n" });
		session.emit({ type: "message_end", message: { role: "assistant", content: [{ type: "text", text: "sleeping" }], stopReason: "endTurn" } });
	};
	const record = await runner.execute();
	check("run ended by sleeping", record?.stopReason === "slept", record?.stopReason);
	check("run recorded one idle return", record?.idleReturns === 1, record?.idleReturns);
	check("run recorded the event", record?.events.length === 1 && record?.events[0]?.thread === "alice", record?.events);
	check("idle time is tracked", (record?.idleMs ?? 0) > 0, record?.idleMs);
	check("context was rebuilt after sleep", created.length === 2, created.map((s) => s.label));
	check("old session was disposed", created[0]?.disposed === true);
	check("sleep summary hit the journal", journal.tail(20).some((line) => line.includes("answered alice")), journal.tail(3));
}

section("a model that keeps stopping is nudged and then stalled");
{
	handler = async (session) => {
		session.emit({ type: "message_end", message: { role: "assistant", content: [{ type: "text", text: "I am done (not really)" }], stopReason: "endTurn" } });
		await session.turn();
	};
	const record = await runner.execute();
	check("run stalled after the nudge budget", record?.stopReason === "stalled", record?.stopReason);
	check("run counted nudges", (record?.nudges ?? 0) >= 2, record?.nudges);
	check("the same session was reused across nudges", created.length === 2, created.length);
}

section("policy-approved notifications are steered into a working run");
{
	policy.reset();
	policy.add({ mode: "interrupt", thread: "alice" });
	const activeSession = created[created.length - 1]!;
	handler = async (session) => {
		session.emit({ type: "message_end", message: { role: "assistant", content: [{ type: "text", text: "working" }], stopReason: "endTurn" } });
		store.append({ kind: "user_message", source: "test", priority: "normal", title: "urgent", text: "urgent from alice", thread: "alice", expectsReply: true });
		store.append({ kind: "user_message", source: "test", priority: "normal", title: "quiet", text: "quiet from bob", thread: "bob", expectsReply: true });
		session.emit({ type: "turn_end", toolResults: [], context: {} });
		await new Promise((resolve) => setTimeout(resolve, 30));
		await call(retainTool, { facts: [], scopes: [] });
		await call(sleepTool, { summary: "steered test done", summary_md: "# Test summary\n" });
		session.emit({ type: "message_end", message: { role: "assistant", content: [{ type: "text", text: "sleeping" }], stopReason: "endTurn" } });
	};
	const record = await runner.execute();
	const steered = activeSession.steered.join("\n");
	check("alice's event was steered in", steered.includes("urgent from alice"), steered);
	check("bob's event was not steered in", !steered.includes("quiet from bob"), steered);
	check("run counted the interrupt", (record?.interruptDeliveries ?? 0) === 1, record?.interruptDeliveries);
}


// ---------------------------------------------------------------------------
// run health: soft warning + anomaly events instead of a wall-clock kill (#127)
// ---------------------------------------------------------------------------

/** Anomaly events recorded for one run (read back from the JSONL sink). */
const anomaliesFor = (runId: string) => runEvents.list(5_000).filter((event) => event.runId === runId);
const anomaliesOf = (runId: string, type: string) => anomaliesFor(runId).filter((event) => event.type === type);

function setRunHealth(patch: {
	runTimeoutMs?: number;
	runWarnMs?: number;
	runNoOutboundTurns?: number;
	runVeryLongMs?: number;
}): void {
	Object.assign(config.config.loop, patch);
}
function resetRunHealth(): void {
	setRunHealth({
		runTimeoutMs: 0,
		runWarnMs: 10 * 60_000,
		runNoOutboundTurns: 60,
		runVeryLongMs: 3 * 60 * 60_000,
	});
}

section("a 20-minute active run is warned, never killed, with runTimeoutMs = 0 (#127)");
{
	policy.reset();
	resetRunHealth();
	const WARN = "работаешь долго — закругляйся или объясни, зачем столько";
	handler = async (session) => {
		const run = currentRun!;
		runner.checkRunGuards(run.startedAt + 9 * 60_000);
		check(
			"nothing is warned or recorded before the window",
			session.steered.length === 0 && anomaliesOf(run.id, "run_long").length === 0,
			{ steered: session.steered.length, events: anomaliesOf(run.id, "run_long").length },
		);
		runner.checkRunGuards(run.startedAt + 10 * 60_000 + 1_000);
		check(
			"the built-in long-run warning is steered once",
			session.steered.length === 1 && session.steered[0]?.includes(WARN),
			session.steered,
		);
		const fired = anomaliesOf(run.id, "run_long");
		check(
			"run_long carries the run id, agent and counters",
			fired.length === 1 &&
				fired[0]?.runId === run.id &&
				fired[0]?.runIndex === run.index &&
				fired[0]?.agent === config.config.name &&
				fired[0]?.turns === run.turns &&
				fired[0]?.outbound === 0 &&
				fired[0]?.limitMs === 10 * 60_000 &&
				(fired[0]?.activeMs ?? 0) >= 10 * 60_000,
			fired[0],
		);
		check(
			"run_long stores no prompt or message text",
			fired.every((event) => !("text" in event) && !("prompt" in event) && !("message" in event)),
			fired[0],
		);
		runner.checkRunGuards(run.startedAt + 13 * 60_000);
		check(
			"the warning is not repeated inside the same window",
			session.steered.length === 1 && anomaliesOf(run.id, "run_long").length === 1,
			{ steered: session.steered.length, events: anomaliesOf(run.id, "run_long").length },
		);
		runner.checkRunGuards(run.startedAt + 21 * 60_000);
		check(
			"crossing the next runWarnMs window warns once more",
			session.steered.length === 2 && anomaliesOf(run.id, "run_long").length === 2,
			{ steered: session.steered.length, events: anomaliesOf(run.id, "run_long").length },
		);
		check(
			"20 minutes of active work did not abort the run",
			session.aborted === false && currentRun?.id === run.id,
			{ aborted: session.aborted },
		);
		await call(retainTool, { facts: [], scopes: [] });
		await call(sleepTool, { summary: "long-run warning test", summary_md: "# long-run warning test\n" });
	};
	const record = await runner.execute();
	check("the run ended by sleeping, not by a timeout", record?.stopReason === "slept", record?.stopReason);
	check(
		"both run_long events are persisted next to the run records",
		anomaliesOf(record?.id ?? "", "run_long").length === 2,
		anomaliesFor(record?.id ?? ""),
	);
}

section("a positive runTimeoutMs still aborts the run (regression)");
{
	policy.reset();
	setRunHealth({ runTimeoutMs: 60_000, runWarnMs: 0, runNoOutboundTurns: 0, runVeryLongMs: 0 });
	handler = async (session) => {
		const run = currentRun!;
		runner.checkRunGuards(run.startedAt + 61_000);
		check("the configured active-time limit still aborts the session", session.aborted === true);
		check("the hard stop does not also steer a warning", session.steered.length === 0, session.steered);
	};
	const record = await runner.execute();
	check("the run is recorded as a timeout", record?.stopReason === "timeout", record?.stopReason);
	resetRunHealth();
}

section("run_no_outbound fires above the turn threshold, once");
{
	policy.reset();
	setRunHealth({ runTimeoutMs: 0, runWarnMs: 0, runNoOutboundTurns: 60, runVeryLongMs: 0 });
	handler = async (session) => {
		const run = currentRun!;
		run.turns = 60;
		runner.checkRunGuards(Date.now());
		check("exactly N turns is not an anomaly yet", anomaliesOf(run.id, "run_no_outbound").length === 0);
		run.turns = 61;
		runner.checkRunGuards(Date.now());
		const fired = anomaliesOf(run.id, "run_no_outbound");
		check("more than N turns with zero outbound fires run_no_outbound", fired.length === 1, fired);
		check(
			"run_no_outbound carries the counters",
			fired[0]?.runId === run.id &&
				fired[0]?.agent === config.config.name &&
				fired[0]?.turns === 61 &&
				fired[0]?.outbound === 0 &&
				fired[0]?.limitTurns === 60,
			fired[0],
		);
		run.turns = 90;
		runner.checkRunGuards(Date.now());
		check("it fires once per run, not on every scheduler tick", anomaliesOf(run.id, "run_no_outbound").length === 1);
		await call(retainTool, { facts: [], scopes: [] });
		await call(sleepTool, { summary: "no-outbound test", summary_md: "# no-outbound test\n" });
	};
	const record = await runner.execute();
	check("the anomaly did not stop the run", record?.stopReason === "slept", record?.stopReason);
}

section("run_very_long fires at the active-time threshold, not before");
{
	policy.reset();
	setRunHealth({ runTimeoutMs: 0, runWarnMs: 0, runNoOutboundTurns: 0, runVeryLongMs: 3 * 60 * 60_000 });
	handler = async (session) => {
		const run = currentRun!;
		runner.checkRunGuards(run.startedAt + 3 * 60 * 60_000 - 1_000);
		check("no run_very_long just before the threshold", anomaliesOf(run.id, "run_very_long").length === 0);
		runner.checkRunGuards(run.startedAt + 3 * 60 * 60_000 + 1_000);
		const fired = anomaliesOf(run.id, "run_very_long");
		check(
			"run_very_long fires past three hours of active work",
			fired.length === 1 && fired[0]?.limitMs === 3 * 60 * 60_000 && (fired[0]?.activeMs ?? 0) >= 3 * 60 * 60_000,
			fired,
		);
		runner.checkRunGuards(run.startedAt + 5 * 60 * 60_000);
		check("run_very_long fires once per run", anomaliesOf(run.id, "run_very_long").length === 1);
		await call(retainTool, { facts: [], scopes: [] });
		await call(sleepTool, { summary: "very-long test", summary_md: "# very-long test\n" });
	};
	const record = await runner.execute();
	check("the run kept going past the anomaly threshold", record?.stopReason === "slept", record?.stopReason);
	const idleRun = { idling: true, activeMs: 5_000, activeSince: undefined, startedAt: 0 } as unknown as RunHandle;
	check(
		"hours inside idle are not counted as long active work",
		runActiveMs(idleRun, 10 * 60 * 60_000) === 5_000,
		runActiveMs(idleRun, 10 * 60 * 60_000),
	);
}

section("run_repeat_tool fires on the third identical call in a row");
{
	policy.reset();
	resetRunHealth();
	handler = async (session) => {
		const run = currentRun!;
		const toolCall = (args: Record<string, unknown>) => session.emit({ type: "tool_execution_start", toolName: "bash", args });
		// Same arguments, different key order: the fingerprint is canonical.
		toolCall({ command: "ls -la", cwd: "/tmp" });
		toolCall({ cwd: "/tmp", command: "ls -la" });
		check("two identical calls are not an anomaly", anomaliesOf(run.id, "run_repeat_tool").length === 0);
		toolCall({ command: "ls -la", cwd: "/tmp" });
		const fired = anomaliesOf(run.id, "run_repeat_tool");
		check(
			"the third identical call in a row fires run_repeat_tool",
			fired.length === 1 && fired[0]?.tool === "bash" && fired[0]?.repeats === 3 && fired[0]?.runId === run.id,
			fired,
		);
		check(
			"tool arguments are never recorded",
			fired.every((event) => !JSON.stringify(event).includes("ls -la")),
			fired[0],
		);
		toolCall({ command: "ls -la", cwd: "/tmp" });
		check("it fires once per streak, not on every further repeat", anomaliesOf(run.id, "run_repeat_tool").length === 1);
		toolCall({ command: "pwd", cwd: "/tmp" });
		toolCall({ command: "ls -la", cwd: "/tmp" });
		toolCall({ command: "ls -la", cwd: "/tmp" });
		toolCall({ command: "ls -la", cwd: "/tmp" });
		check("a new streak of three fires again", anomaliesOf(run.id, "run_repeat_tool").length === 2);
		await call(retainTool, { facts: [], scopes: [] });
		await call(sleepTool, { summary: "repeat-tool test", summary_md: "# repeat-tool test\n" });
	};
	const record = await runner.execute();
	check("the anomaly did not stop the run", record?.stopReason === "slept", record?.stopReason);
}

// ---------------------------------------------------------------------------
// per-turn usage (#121)
// ---------------------------------------------------------------------------

section("per-turn usage is persisted on the run record (#121)");
{
	handler = async (session) => {
		const turns = [
			{ input: 100, output: 10, cacheRead: 50, cacheWrite: 5, cost: 0.001, tools: ["read"] },
			{ input: 200, output: 20, cacheRead: 150, cacheWrite: 0, cost: 0.0025, tools: ["bash", "edit"] },
		];
		for (const [index, turn] of turns.entries()) {
			session.emit({ type: "turn_start" });
			session.emit({
				type: "turn_end",
				message: {
					role: "assistant",
					content: [
						{ type: "text", text: `turn ${index + 1}` },
						...turn.tools.map((name, callIndex) => ({
							type: "toolCall",
							id: `call_${index}_${callIndex}`,
							name,
							arguments: {},
						})),
					],
					usage: {
						input: turn.input,
						output: turn.output,
						cacheRead: turn.cacheRead,
						cacheWrite: turn.cacheWrite,
						totalTokens: turn.input + turn.output + turn.cacheRead + turn.cacheWrite,
						cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: turn.cost },
					},
					stopReason: "toolUse",
				},
				toolResults: turn.tools.map((name, callIndex) => ({
					role: "toolResult",
					toolCallId: `call_${index}_${callIndex}`,
					toolName: name,
					content: [],
				})),
			});
			await session.turn();
		}
		await call(retainTool, { facts: [], scopes: [] });
		await call(sleepTool, { summary: "trace test", summary_md: "# trace test\n" });
	};
	const turnsBefore = runs.usageToday().turns;
	const record = await runner.execute();
	const trace = record?.turns ?? [];
	check(
		"the run record stores the per-turn trace and the turn count",
		record?.turnCount === 2 && trace.length === 2,
		{ turnCount: record?.turnCount, steps: trace.length },
	);
	check("turns are numbered from 1", trace.map((turn) => turn.index).join(",") === "1,2", trace.map((turn) => turn.index));
	check(
		"token usage and cost are copied per turn",
		trace[0]?.usage.input === 100 &&
			trace[0]?.usage.cacheRead === 50 &&
			trace[1]?.usage.cacheRead === 150 &&
			trace[1]?.usage.cost === 0.0025,
		trace.map((turn) => turn.usage),
	);
	check(
		"the tools called in each turn are recorded",
		trace[0]?.tools.join(",") === "read" && trace[1]?.tools.join(",") === "bash,edit",
		trace.map((turn) => turn.tools),
	);
	check(
		"turn timing is measured from turn_start to turn_end",
		trace.every((turn) => turn.startedAt > 0 && turn.durationMs >= 0),
		trace.map((turn) => ({ startedAt: turn.startedAt, durationMs: turn.durationMs })),
	);
	const persisted = runs.list(1)[0];
	check(
		"the trace is persisted to runs.jsonl",
		persisted?.turnCount === 2 && persisted.turns?.length === 2 && persisted.turns[1]?.usage.cacheRead === 150,
		{ turnCount: persisted?.turnCount, steps: persisted?.turns?.length },
	);
	check("the daily counter counts the run's turns", runs.usageToday().turns === turnsBefore + 2, {
		before: turnsBefore,
		after: runs.usageToday().turns,
	});
}

section("the turn recorder is bounded and tolerates malformed events (#121)");
{
	const clock = { now: 1_000 };
	const recorder = new TurnTraceRecorder(() => clock.now);
	check("a turn_end without an assistant message is ignored", recorder.endTurn({ message: undefined }) === undefined);
	check("a non-assistant message is ignored", recorder.endTurn({ message: { role: "user", content: [] } }) === undefined);
	check("a non-object message is ignored", recorder.endTurn({ message: "nope" }) === undefined);
	check("a message without usage records zeros, not fabricated values", recorder.endTurn({ message: { role: "assistant" } })?.usage.input === 0);
	recorder.reset();
	for (let index = 0; index < RUN_TURN_TRACE_LIMIT + 5; index += 1) {
		clock.now += 1_000;
		recorder.startTurn();
		clock.now += 500;
		recorder.endTurn({
			message: {
				role: "assistant",
				usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { total: 0.0001 } },
			},
			at: clock.now,
		});
	}
	const snapshot = recorder.snapshot();
	check(`the trace is bounded to the last ${RUN_TURN_TRACE_LIMIT} turns`, snapshot.length === RUN_TURN_TRACE_LIMIT, snapshot.length);
	check(
		"indexes stay absolute after truncation",
		snapshot[0]?.index === 6 && snapshot[snapshot.length - 1]?.index === RUN_TURN_TRACE_LIMIT + 5,
		{ first: snapshot[0]?.index, last: snapshot[snapshot.length - 1]?.index },
	);
	check("each recorded turn keeps its own duration", snapshot[0]?.durationMs === 500, snapshot[0]?.durationMs);
	check("snapshot() returns a copy", recorder.snapshot() !== snapshot && recorder.snapshot()[0] !== snapshot[0]);
}


// ---------------------------------------------------------------------------
// empty wakes (#116)
// ---------------------------------------------------------------------------

section("empty wakes: two quiet hours cost nothing, events wake and reset the backoff");
{
	// A separate fixture world: the shared store above has history of its own.
	const wakeRoot = fs.mkdtempSync(path.join(os.tmpdir(), "alive-wake-test-"));
	const wakeStore = EventStore.open(wakeRoot);
	const wakeRuns = new RunLog(wakeRoot);
	const wakeThreads = new ThreadStore(wakeRoot);
	const wakePolicy = new PolicyStore(wakeRoot);
	const wakeHistory = HistoryStore.open(wakeRoot);
	const wakeNotes = new NoteStore(wakeRoot);
	const wakeReminders = new ReminderStore(wakeRoot);
	const wakeJournal = new Journal(wakeRoot);
	const wakeOutbox = new Outbox(wakeRoot);
	let wakeRun: RunHandle | undefined;
	const wakeDeps: ToolDeps = {
		config,
		store: wakeStore,
		reminders: wakeReminders,
		notes: wakeNotes,
		memory: new FakeMemoryStore(),
		journal: wakeJournal,
		threads: wakeThreads,
		outbox: wakeOutbox,
		policy: wakePolicy,
		history: wakeHistory,
		moduleTools: [],
		deliver: async () => undefined,
		getRun: () => wakeRun,
		runtimeStatus: () => ({}),
		isStopping: () => false,
		log,
	};
	const wakeTools = createAliveTools(wakeDeps);
	const wakeRetain = wakeTools.find((t) => t.name === "retain")!;
	const wakeSleep = wakeTools.find((t) => t.name === "sleep")!;

	const wakeSessions: FakeSession[] = [];
	let wakeHandler: Handler = async () => undefined;
	const wakeRunner = new AgentRunner({
		config,
		createSession: async () => {
			const session = new FakeSession(`w${wakeSessions.length + 1}`, (s, p) => wakeHandler(s, p));
			wakeSessions.push(session);
			return session as unknown as AgentSession;
		},
		store: wakeStore,
		runs: wakeRuns,
		threads: wakeThreads,
		policy: wakePolicy,
		toolDeps: wakeDeps,
		log,
		thoughtsFile: path.join(wakeRoot, "thoughts.jsonl"),
		getRun: () => wakeRun,
		setRun: (next) => {
			wakeRun = next;
		},
		runtimeStatus: () => ({}),
		isStopping: () => false,
		isBudgetExhausted: () => false,
	});
	await wakeRunner.init();

	// Virtual clock: two hours pass in milliseconds. The intervals are the
	// documented defaults (base 15 min, cap 60 min), so 15/30/60 is exactly what
	// the production config does.
	const BASE = 15 * 60_000;
	const CAP = 60 * 60_000;
	const clock = { now: Date.UTC(2026, 0, 1, 0, 0, 0) };
	// One extra second so the 15+15+30+60 minute wait that ends at 2:00:00 is
	// counted as the fourth empty wake instead of racing the stop check.
	const phase = { endsAt: clock.now + 2 * 60 * 60_000 + 1_000 };
	const emptyWakes: Array<{ emptyWakes: number; intervalMs: number }> = [];
	const wake = new WakeScheduler({
		baseIntervalMs: BASE,
		pollIntervalMs: 750,
		backoff: { enabled: true, afterWakes: 2, maxIntervalMs: CAP },
		log,
		hasWork: () => hasWakeWorthyPending(wakeStore),
		isStopped: () => clock.now >= phase.endsAt,
		now: () => clock.now,
		sleep: async (ms) => {
			clock.now += ms;
		},
		onEmptyWake: (info) => emptyWakes.push(info),
	});

	// Mirrors AliveRuntime.loop(): the gate decides, the runner executes, nothing else runs.
	let startedRuns = 0;
	const pump = async (): Promise<"event" | "stopped"> => {
		const trigger = await wake.nextRun();
		if (trigger === "event") startedRuns += 1;
		return trigger;
	};

	const quiet = await pump();
	check("two hours with an empty inbox start no run", quiet === "stopped" && startedRuns === 0, { quiet, startedRuns });
	check("no run record and no spend was created", wakeRuns.list().length === 0 && wakeSessions.every((session) => session.prompts.length === 0), wakeRuns.list().length);
	check("the inbox stayed empty", wakeStore.pendingCount() === 0, wakeStore.status());
	check(
		"empty wakes stretch the interval 15 → 30 → 60 and then hold at the cap",
		emptyWakes.map((wake) => wake.intervalMs).join(",") === [BASE, 2 * BASE, 4 * BASE, CAP].join(","),
		emptyWakes.map((wake) => wake.intervalMs),
	);
	check("two hours produce exactly four empty wakes (15+15+30+60 min)", emptyWakes.length === 4, emptyWakes.map((wake) => wake.emptyWakes));
	check(
		"the interval is the base until afterWakes, then doubles to the cap",
		wakeIntervalMs({ baseIntervalMs: 900_000, emptyWakes: 0, backoff: { enabled: true, afterWakes: 2, maxIntervalMs: 3_600_000 } }) === 900_000 &&
			wakeIntervalMs({ baseIntervalMs: 900_000, emptyWakes: 2, backoff: { enabled: true, afterWakes: 2, maxIntervalMs: 3_600_000 } }) === 1_800_000 &&
			wakeIntervalMs({ baseIntervalMs: 900_000, emptyWakes: 3, backoff: { enabled: true, afterWakes: 2, maxIntervalMs: 3_600_000 } }) === 3_600_000 &&
			wakeIntervalMs({ baseIntervalMs: 900_000, emptyWakes: 9, backoff: { enabled: true, afterWakes: 2, maxIntervalMs: 3_600_000 } }) === 3_600_000 &&
			wakeIntervalMs({ baseIntervalMs: 900_000, emptyWakes: 9, backoff: { enabled: false, afterWakes: 2, maxIntervalMs: 3_600_000 } }) === 900_000,
	);

	// The fake model does the minimum: one turn, then retain + sleep.
	wakeHandler = async (session) => {
		session.emit({ type: "message_end", message: { role: "assistant", content: [{ type: "text", text: "on it" }], stopReason: "endTurn" } });
		await session.turn();
		await call(wakeRetain, { facts: [], scopes: [] });
		await call(wakeSleep, { summary: "empty-wake test", summary_md: "# empty-wake test\n" });
		session.emit({ type: "message_end", message: { role: "assistant", content: [{ type: "text", text: "sleeping" }], stopReason: "endTurn" } });
	};

	// The next wait would run into the (already expired) phase end; extend it and
	// drop an event in. The gate must return before any more virtual time passes.
	phase.endsAt = clock.now + 60 * 60_000;
	const arrivingAt = clock.now;
	wakeStore.append({ kind: "user_message", source: "test", priority: "normal", title: "hi", text: "real question", thread: "alice", expectsReply: true });
	const woken = await pump();
	check("an arriving event wakes the runtime immediately", woken === "event" && clock.now === arrivingAt, { woken, elapsed: clock.now - arrivingAt });
	check("the wait polled often enough to see the event at once", wake.consecutiveEmptyWakes === 0, wake.consecutiveEmptyWakes);
	const eventRun = await wakeRunner.execute({ requireEvents: true });
	check("the event started a real run and reached the model", (eventRun?.events.length ?? 0) === 1 && wakeSessions.some((session) => session.prompts.length > 0), eventRun?.events);
	check("the run was prompted once, for the event it was woken for", (eventRun?.stopReason === "slept") && (eventRun?.promptChars ?? 0) > 0 && wakeRuns.list().length === 1, { stopReason: eventRun?.stopReason, promptChars: eventRun?.promptChars, runs: wakeRuns.list().length });
	check("a run with events resets the empty-wake streak", wake.consecutiveEmptyWakes === 0, wake.consecutiveEmptyWakes);
	check("the interval is back at the base after the event", wake.intervalMs === BASE, { intervalMs: wake.intervalMs, base: BASE });

	// Unaddressed chatter: stored, delivered later, never a reason to wake up.
	phase.endsAt = clock.now + 30 * 60_000;
	wakeStore.append({ kind: "user_message", source: "test", priority: "low", title: "group chatter", text: "just chatting", thread: "group", expectsReply: false, wake: false });
	const chatterWake = await pump();
	check("an unaddressed event does not start a run", chatterWake === "stopped" && startedRuns === 1, { chatterWake, startedRuns });
	check("unaddressed chatter stays in the inbox", wakeStore.pendingCount() === 1, wakeStore.status());
	check("the empty-wake streak keeps growing while only chatter arrives", wake.consecutiveEmptyWakes > 0, wake.consecutiveEmptyWakes);

	phase.endsAt = clock.now + 60 * 60_000;
	wakeStore.append({ kind: "user_message", source: "test", priority: "normal", title: "@alive status?", text: "@alive status?", thread: "group", expectsReply: true });
	const addressedWake = await pump();
	check("an addressed group message does wake the runtime", addressedWake === "event", addressedWake);
	const addressedRun = await wakeRunner.execute({ requireEvents: true });
	const addressedTitles = (addressedRun?.events ?? []).map((event) => event.title).join(",");
	check("the addressed run delivers the chatter too, nothing is dropped", addressedTitles === "group chatter,@alive status?", addressedTitles);
	check("the run counted only the event it was woken for as new work", addressedRun?.stopReason === "slept", addressedRun?.stopReason);
}

process.stdout.write(
	failures === 0 ? `\nALL RUNNER TESTS PASSED (${root})\n` : `\n${failures} RUNNER TEST(S) FAILED\n`,
);
process.exitCode = failures === 0 ? 0 : 1;
