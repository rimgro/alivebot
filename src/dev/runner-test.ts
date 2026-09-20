/**
 * Integration test for the run lifecycle in `src/runtime/agent.ts` using a fake
 * pi session. No model is involved: the fake "model" drives the real tools, so we
 * can assert that idle → sleep rebuilds the context, that a model which keeps
 * stopping is nudged and stalled out, and that policy-approved notifications are
 * steered into a working run.
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
import { Outbox } from "../store/outbox.js";
import { PolicyStore } from "../store/policy.js";
import { ReminderStore } from "../store/reminders.js";
import { RunLog } from "../store/runs.js";
import { ThreadStore } from "../store/threads.js";
import { HistoryStore } from "../store/history.js";
import { AgentRunner } from "../runtime/agent.js";
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
			maxEventsPerIdle: 8,
			maxNudges: 3,
			maxNudgesPerRun: 2,
			interrupt: true,
		},
	},
});
const log = new Logger({ console: false, level: "error", scope: "runner-test" });
const store = EventStore.open(config.paths.stateDir);
const reminders = new ReminderStore(config.paths.stateDir);
const notes = new NoteStore(config.paths.stateDir);
const journal = new Journal(config.paths.stateDir);
const threads = new ThreadStore(config.paths.stateDir);
const outbox = new Outbox(config.paths.stateDir);
const policy = new PolicyStore(config.paths.stateDir);
const history = HistoryStore.open(config.paths.stateDir);
const runs = new RunLog(config.paths.stateDir);

let currentRun: RunHandle | undefined;
const deps: ToolDeps = {
	config,
	store,
	reminders,
	notes,
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
		store.append({ kind: "user_message", source: "test", priority: "normal", title: "hi", text: "hello there", thread: "alice", expectsReply: true });
		const idled = await call(idle, { reason: "waiting for alice" });
		session.emit({ type: "message_end", message: { role: "assistant", content: idled.content, stopReason: "endTurn" } });
		await session.turn();
		await call(sleepTool, { summary: "answered alice (test)" });
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
		await call(sleepTool, { summary: "steered test done" });
		session.emit({ type: "message_end", message: { role: "assistant", content: [{ type: "text", text: "sleeping" }], stopReason: "endTurn" } });
	};
	const record = await runner.execute();
	const steered = activeSession.steered.join("\n");
	check("alice's event was steered in", steered.includes("urgent from alice"), steered);
	check("bob's event was not steered in", !steered.includes("quiet from bob"), steered);
	check("run counted the interrupt", (record?.interruptDeliveries ?? 0) === 1, record?.interruptDeliveries);
}

process.stdout.write(
	failures === 0 ? `\nALL RUNNER TESTS PASSED (${root})\n` : `\n${failures} RUNNER TEST(S) FAILED\n`,
);
process.exitCode = failures === 0 ? 0 : 1;
