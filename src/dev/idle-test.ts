/**
 * Integration test for the continuous-cycle primitives: the blocking `idle`
 * tool, the sleep offer/refusal/force path, memory-on-sleep, and the
 * notification policy. No model is involved — it exercises the tools exactly as
 * the agent would call them.
 *
 *   npm run test:idle
 */
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import { loadConfig } from "../config.js";
import { Logger } from "../log.js";
import { EventStore } from "../store/events.js";
import { Journal } from "../store/journal.js";
import { NoteStore } from "../store/notes.js";
import { Outbox } from "../store/outbox.js";
import { PolicyStore } from "../store/policy.js";
import { ReminderStore } from "../store/reminders.js";
import { ThreadStore } from "../store/threads.js";
import { HistoryStore } from "../store/history.js";
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

const root = fs.mkdtempSync(path.join(os.tmpdir(), "alive-idle-test-"));
const config = loadConfig({
	cwd: root,
	overrides: {
		loop: {
			pollIntervalMs: 10,
			sleepAfterMs: 120,
			runTimeoutMs: 60_000,
			maxEventsPerIdle: 8,
			maxNudges: 3,
			maxNudgesPerRun: 5,
			interrupt: true,
		},
	},
});
const log = new Logger({ console: false, level: "error", scope: "idle-test" });

const store = EventStore.open(config.paths.stateDir);
const reminders = new ReminderStore(config.paths.stateDir);
const notes = new NoteStore(config.paths.stateDir);
const journal = new Journal(config.paths.stateDir);
const threads = new ThreadStore(config.paths.stateDir);
const outbox = new Outbox(config.paths.stateDir);
const policy = new PolicyStore(config.paths.stateDir);
const history = HistoryStore.open(config.paths.stateDir);

let run: RunHandle | undefined;
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
	getRun: () => run,
	runtimeStatus: () => ({}),
	isStopping: () => false,
	log,
};
const tools = createAliveTools(deps) as ToolDefinition[];
const tool = (name: string): ToolDefinition => {
	const found = tools.find((t) => t.name === name);
	if (!found) throw new Error(`missing tool ${name}`);
	return found;
};
const idle = tool("idle");
const sleepTool = tool("sleep");
const notifications = tool("notifications");
type Result = { content: Array<{ text: string }>; terminate?: boolean };
const call = (def: ToolDefinition, params: unknown, signal?: AbortSignal): Promise<Result> =>
	def.execute("call", params as never, signal, undefined, {} as never) as Promise<Result>;

function makeRun(index: number): RunHandle {
	return {
		id: `run_test_${index}`,
		index,
		startedAt: Date.now(),
		events: [],
		outbound: [],
		reminderIds: [],
		noteKeys: [],
		journalEntries: 0,
		idleReturns: 0,
		interruptDeliveries: 0,
		nudges: 0,
		turns: 0,
		promptChars: 0,
		inboundThreads: new Set(),
		idling: false,
		idleMs: 0,
		activeMs: 0,
		sleepOffered: false,
		sleepRequested: false,
		sleepForced: false,
	};
}
const event = (text: string, thread = "console") =>
	store.append({ kind: "user_message", source: "test", priority: "normal", title: text, text, thread, expectsReply: true });

section("idle returns pending events as tool output");
{
	run = makeRun(1);
	store.beginRun(run.id);
	event("hello from the world");
	const started = Date.now();
	const result = await call(idle, { reason: "wait for the user" });
	check("idle returned quickly when an event was pending", Date.now() - started < 80, Date.now() - started);
	check("idle output contains the event", result.content[0].text.includes("hello from the world"), result.content[0].text);
	check("idle did not terminate the run", result.terminate !== true);
	check("run recorded the idle return", run.idleReturns === 1);
	check("idle is no longer blocked", run.idling === false);
	check("event is recorded in the run", run.events.some((e) => e.text.includes("hello")));
	store.endRun();
}

section("idle wakes on an event that arrives while it is already waiting");
{
	run = makeRun(2);
	store.beginRun(run.id);
	const waiting = call(idle, { reason: "nothing yet" });
	await new Promise((resolve) => setTimeout(resolve, 40));
	check("idle is blocking", run.idling === true);
	event("late arrival", "alice");
	const result = await waiting;
	check("blocking idle returned the late event", result.content[0].text.includes("late arrival"), result.content[0].text);
	check("blocking idle cleared the idling flag", run.idling === false);
	store.endRun();
}

section("idle offers sleep after a long wait");
{
	run = makeRun(3);
	store.beginRun(run.id);
	const started = Date.now();
	const offer = await call(idle, { reason: "waiting" });
	check("sleep offer arrived after sleepAfterMs", Date.now() - started >= config.config.loop.sleepAfterMs - 20);
	check("offer mentions sleep", /SLEEP OFFER/i.test(offer.content[0].text), offer.content[0].text);
	check("run remembers the offer", run.sleepOffered === true);
	const forced = await call(idle, { reason: "still waiting" });
	check("returning to idle without pinning forces sleep", forced.terminate === true && run.sleepRequested === true);
	check("forced sleep is marked", run.sleepForced === true);
	store.endRun();
}

section("idle({important:true}) refuses to be put to sleep");
{
	run = makeRun(4);
	store.beginRun(run.id);
	const result = await call(idle, { reason: "critical deploy", important: true, max_seconds: 0.15 });
	check("pinned idle does not offer sleep", !/SLEEP OFFER/i.test(result.content[0].text), result.content[0].text);
	check("pinned idle only returns on its cap", /cap/i.test(result.content[0].text), result.content[0].text);
	check("run was not asked to sleep", run.sleepRequested === false);
	store.endRun();
}

section("sleep writes memory and requests a context reset");
{
	run = makeRun(5);
	store.beginRun(run.id);
	const result = await call(sleepTool, { summary: "user asked about the deploy; PR #12 is green", note_key: "focus", note_value: "PR #12" });
	check("sleep terminates the run", result.terminate === true && run.sleepRequested === true);
	check("sleep summary is in the journal", journal.tail(20).some((line) => line.includes("PR #12 is green")), journal.tail(3));
	check("note written before sleep", notes.get("focus") === "PR #12", notes.all());
	check("run recorded a journal entry", run.journalEntries >= 1);
	store.endRun();
}

section("muted events are skipped, not returned and not blocking");
{
	policy.reset();
	policy.add({ mode: "mute", thread: "noise" });
	run = makeRun(7);
	store.beginRun(run.id);
	event("ignore me", "noise");
	const waiting = call(idle, { reason: "wait for something real", important: true });
	await new Promise((resolve) => setTimeout(resolve, 50));
	check("a muted-only inbox does not wake the agent", run.idling === true);
	event("real news", "alice");
	const real = await waiting;
	check("muted event was not returned", !real.content[0].text.includes("ignore me"), real.content[0].text);
	check("a real event is still delivered after a muted one", real.content[0].text.includes("real news"), real.content[0].text);
	check("both were consumed", store.pendingCount() === 0, store.status());
	store.endRun();
	policy.reset();
}

section("notification policy steers and silences");
{
	policy.reset();
	const aliceRule = policy.add({ mode: "interrupt", thread: "alice" });
	check("alice rule interrupts", policy.shouldInterrupt(event("x", "alice")));
	check("bob still queues", !policy.shouldInterrupt(event("x", "bob")));
	run = makeRun(6);
	const added = await call(notifications, { action: "add", mode: "mute", thread: "noise" });
	check("notifications tool adds a rule", added.content[0].text.includes("Added rule"), added.content[0].text);
	check("muted thread is muted", policy.shouldMute(event("x", "noise")));
	const listed = await call(notifications, { action: "list" });
	check("notifications list renders the policy", listed.content[0].text.includes(aliceRule.id), listed.content[0].text);
}

process.stdout.write(
	failures === 0 ? `\nALL IDLE/SLEEP TESTS PASSED (${root})\n` : `\n${failures} IDLE/SLEEP TEST(S) FAILED\n`,
);
process.exitCode = failures === 0 ? 0 : 1;
