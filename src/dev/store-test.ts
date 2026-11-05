/**
 * Store-level tests: the delivery cursor, crash recovery, dedupe, threads and
 * reminders. These are the parts where a bug silently loses user messages, so
 * they are tested without any model involvement.
 *
 *   npm run test
 */
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { EventStore } from "../store/events.js";
import { ReminderStore } from "../store/reminders.js";
import { ThreadStore } from "../store/threads.js";
import { NoteStore } from "../store/notes.js";
import { Journal } from "../store/journal.js";
import {
	interruptedResumeDecision,
	isRunStoppedBy,
	RUN_STOPPED_BY_VALUES,
	RunLog,
	runStoppedBy,
	runStoppedByInferred,
	runTurnCount,
	type RunRecord,
	type RunStopReason,
} from "../store/runs.js";
import { DEFAULT_POLICY, PolicyStore } from "../store/policy.js";
import { DEFAULT_CONFIG, validateLoopConfig } from "../config.js";
import { runOutcome } from "../dashboard/state.js";

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

const root = fs.mkdtempSync(path.join(os.tmpdir(), "alive-store-test-"));
const stateDir = path.join(root, ".alive");

section("event store: claim / ack / dedupe");
{
	const store = EventStore.open(stateDir);
	const a = store.append({ kind: "user_message", source: "test", priority: "normal", title: "a", text: "a", thread: "t1", expectsReply: true });
	const b = store.append({ kind: "observability", source: "test", priority: "normal", title: "b", text: "b" });
	const dup = store.append({ kind: "observability", source: "test", priority: "normal", title: "b-dup", text: "b-dup", dedupeKey: "k1" });
	const dup2 = store.append({ kind: "observability", source: "test", priority: "normal", title: "b-dup2", text: "b-dup2", dedupeKey: "k1" });
	check("seq is sequential", a.seq === 1 && b.seq === 2 && dup.seq === 3, { a: a.seq, b: b.seq, dup: dup.seq });
	check("dedupe by key returns the original", dup2.id === dup.id, { dup: dup.id, dup2: dup2.id });
	check("pending count", store.pendingCount() === 3, store.status());

	store.beginRun("w1");
	const claimed = store.claim(10);
	check("claim returns all pending", claimed.length === 3, claimed.length);
	check("pending is empty while claimed", store.pendingCount() === 0, store.status());
	store.ack();
	check("ack advances ackedSeq", store.status().ackedSeq === 3, store.status());
	check("nothing pending after ack", store.pendingCount() === 0, store.status());
	check("ack keeps the run open for the next idle", store.openRunId === "w1", store.status());
	store.endRun();
	check("endRun closes the run", store.openRunId === null, store.status());
}

section("event store: rollback redelivers");
{
	const store = EventStore.open(stateDir);
	const c = store.append({ kind: "user_message", source: "test", priority: "normal", title: "c", text: "c", thread: "t2", expectsReply: true });
	store.beginRun("w2");
	store.claim(10);
	store.rollbackClaim();
	check("event is pending again", store.pendingCount() === 1, store.status());
	const again = store.peekPending(10);
	check("same event id", again[0]?.id === c.id, again.map((e) => e.id));
	store.beginRun("w3");
	store.claim(10);
	store.ack();
	check("acked after retry", store.status().ackedSeq === 4, store.status());
}

section("event store: crash recovery");
{
	const store = EventStore.open(stateDir);
	store.append({ kind: "user_message", source: "test", priority: "normal", title: "d", text: "d", thread: "t3" });
	store.append({ kind: "user_message", source: "test", priority: "normal", title: "e", text: "e", thread: "t4" });
	store.beginRun("crashed-wake");
	store.claim(1);
	// simulate process death: a fresh store instance reads the same files
	const reborn = EventStore.open(stateDir);
	check("open wake is visible", reborn.openRunId === "crashed-wake", reborn.status());
	const range = reborn.recoverAfterCrash();
	check("recovery reports the claimed range", range?.fromSeq === 5 && range?.toSeq === 5, range);
	check("recovered events are pending again", reborn.pendingCount() === 2, reborn.status());
	check("open wake cleared", reborn.openRunId === null, reborn.status());
	// consume the recovered events so the next section starts from a clean cursor
	reborn.beginRun("w-recovered");
	reborn.claim(10);
	reborn.ack();
	check("recovered events acknowledged", reborn.status().ackedSeq === 6, reborn.status());
}

section("event store: claimPrefix does not skip events");
{
	const store = EventStore.open(stateDir);
	store.append({ kind: "observability", source: "test", priority: "normal", title: "n1", text: "n1" });
	store.append({ kind: "observability", source: "test", priority: "interrupt", title: "i1", text: "i1" });
	store.append({ kind: "observability", source: "test", priority: "normal", title: "n2", text: "n2" });
	store.append({ kind: "observability", source: "test", priority: "interrupt", title: "i2", text: "i2" });
	store.append({ kind: "observability", source: "test", priority: "normal", title: "n3", text: "n3" });
	store.beginRun("w4");
	const interruptBatch = store.claimPrefix(8, (e) => e.priority === "interrupt");
	check(
		"prefix up to the last interrupt in the window",
		interruptBatch.map((e) => e.title).join(",") === "n1,i1,n2,i2",
		interruptBatch.map((e) => e.title),
	);
	const rest = store.claim(10);
	check("remaining events survive", rest.map((e) => e.title).join(",") === "n3", rest.map((e) => e.title));
	store.ack();
}

section("event store: external appends are picked up");
{
	const store = EventStore.open(stateDir);
	const file = path.join(stateDir, "inbox", "events.jsonl");
	const before = store.status().totalEvents;
	fs.appendFileSync(
		file,
		`${JSON.stringify({ id: "evt_external", ts: Date.now(), kind: "user_message", source: "other-process", priority: "normal", title: "external", text: "hello from another process", thread: "t5" })}\n`,
	);
	check("external event visible after refresh", store.pendingCount() === 1 && store.status().totalEvents === before + 1, store.status());
	const claimed = store.peekPending(5);
	check("external event has a seq", claimed[0]?.seq === before + 1, claimed[0]);
	store.beginRun("w5");
	store.claim(5);
	store.ack();
}

section("threads: unanswered until a tool-delivered message");
{
	const threads = new ThreadStore(stateDir);
	threads.recordInbound("alice", Date.now(), true);
	check("thread is unsettled", threads.unsettled(3).length === 1, threads.all());
	threads.settle("wake-x", [], ["alice"]);
	check("attempts incremented on unsettled nudge", threads.unsettled(3)[0]?.attempts === 1, threads.all());
	threads.recordOutbound("alice", Date.now());
	check("outbound clears unanswered", threads.unsettled(3).length === 0, threads.all());
	threads.recordInbound("bob", Date.now(), true);
	threads.settle("wake-x", ["bob"], ["bob"]);
	check("answered thread settles", threads.unsettled(3).length === 0, threads.all());
	threads.recordInbound("carol", Date.now(), true);
	threads.close("carol", "spam");
	check("closed thread is not nudged", threads.unsettled(3).length === 0, threads.all());
}

section("reminders: add / fire / cancel");
{
	const reminders = new ReminderStore(stateDir);
	const soon = reminders.add({ text: "check CI", dueAt: Date.now() + 1_000, thread: "ci" });
	const later = reminders.add({ text: "weekly review", dueAt: Date.now() + 86_400_000 });
	check("two pending", reminders.list().length === 2, reminders.list());
	check("earliest pending is the soonest", reminders.earliestPendingAt() === soon.dueAt, { soon: soon.dueAt });
	const fired = reminders.fireDue(Date.now() + 2_000);
	check("fires only what is due", fired.length === 1 && fired[0]?.id === soon.id, fired.map((r) => r.id));
	check("fired reminder is gone from pending", reminders.list().length === 1, reminders.list());
	const cancelled = reminders.cancel(later.id);
	check("cancel works", cancelled?.id === later.id, cancelled);
	check("cancelled reminder is gone from pending", reminders.list().length === 0, reminders.list());
}

section("misc stores");
{
	const notes = new NoteStore(stateDir);
	notes.set("focus", "waiting for CI");
	check("note roundtrip", notes.get("focus") === "waiting for CI", notes.all());
	check("note delete", notes.delete("focus") && notes.all().focus === undefined, notes.all());

	const journal = new Journal(stateDir);
	const file = journal.append("first entry");
	check("journal file created", fs.existsSync(file), file);
	check("journal tail contains entry", journal.tail(10).some((l) => l.includes("first entry")), journal.tail(10));

	const runs = new RunLog(stateDir);
	check("run index starts at zero", runs.nextIndex() === 1, runs.list().length);
	check("usage today starts empty", runs.usageToday().runs === 0, runs.usageToday());
}

section("notification policy: specificity and recency win");
{
	const policy = new PolicyStore(stateDir);
	const event = (input: { thread?: string; priority?: "low" | "normal" | "high" | "interrupt"; source?: string }) => ({
		seq: 0,
		id: "evt",
		ts: Date.now(),
		kind: "user_message" as const,
		source: input.source ?? "test",
		priority: input.priority ?? ("normal" as const),
		title: "x",
		text: "x",
		thread: input.thread,
	});

	check("default is queue", policy.modeFor(event({})) === "queue", policy.load());
	check("interrupt priority interrupts by default", policy.modeFor(event({ priority: "interrupt" })) === "interrupt");
	policy.add({ mode: "interrupt", thread: "alice" });
	check("thread rule wins for alice", policy.modeFor(event({ thread: "alice" })) === "interrupt");
	check("other threads still queue", policy.modeFor(event({ thread: "bob" })) === "queue");
	policy.add({ mode: "mute", source: "test", thread: "alice" });
	check("more specific rule wins", policy.modeFor(event({ thread: "alice" })) === "mute");
	const aliceRule = policy.load().rules.find((r) => r.mode === "interrupt" && r.thread === "alice");
	check("remove works", aliceRule !== undefined && policy.remove(aliceRule.id)?.id === aliceRule.id);
	policy.reset();
	check("reset restores the seed", policy.load().rules.length === DEFAULT_POLICY.rules.length, policy.load());
}


section("run log: a resumed record replaces its line and accumulates usage (#124)");
{
	const resumeRoot = fs.mkdtempSync(path.join(os.tmpdir(), "alive-run-resume-test-"));
	const runs = new RunLog(resumeRoot);
	const finishedAt = Date.now();
	const first: RunRecord = {
		id: "run_resume",
		index: 7,
		startedAt: finishedAt - 60_000,
		finishedAt,
		durationMs: 60_000,
		activeMs: 55_000,
		idleMs: 5_000,
		stopReason: "interrupted",
		sessionFile: "/tmp/session.jsonl",
		summary: "interrupted by a planned harness restart",
		events: [{ seq: 10, kind: "user_message", thread: "alice", title: "one" }],
		outbound: [{ thread: "alice", text: "already sent", delivered: true, deliveryKey: "msg_1" }],
		remindersCreated: [],
		notesTouched: [],
		journalEntries: 1,
		idleReturns: 0,
		interruptDeliveries: 0,
		nudges: 0,
		turnCount: 1,
		promptChars: 100,
		usage: { input: 100, output: 10, cacheRead: 0, cacheWrite: 0, total: 110, cost: 0.01 },
		turns: [{ index: 1, startedAt: finishedAt - 50_000, durationMs: 1_000, usage: { input: 100, output: 10, cacheRead: 0, cacheWrite: 0, total: 110, cost: 0.01 }, tools: [] }],
	};
	runs.record(first);
	const afterFirst = runs.usageToday();
	const resumed: RunRecord = {
		...first,
		finishedAt: finishedAt + 30_000,
		durationMs: 90_000,
		turnCount: 2,
		outbound: [...first.outbound, { thread: "alice", text: "after restart", delivered: true, deliveryKey: "msg_2" }],
		events: [...first.events, { seq: 11, kind: "user_message", thread: "bob", title: "two" }],
		usage: { input: 150, output: 15, cacheRead: 0, cacheWrite: 0, total: 165, cost: 0.015 },
		turns: [...(first.turns ?? []), { index: 2, startedAt: finishedAt + 20_000, durationMs: 1_000, usage: { input: 50, output: 5, cacheRead: 0, cacheWrite: 0, total: 55, cost: 0.005 }, tools: [] }],
		stopReason: "slept",
	};
	runs.record(resumed);
	const all = runs.list(10);
	const usage = runs.usageToday();
	check("the resumed run is one line, not a duplicate", all.length === 1 && all[0]?.id === first.id && all[0]?.index === 7, all);
	check("startedAt and outbound survive the resume", all[0]?.startedAt === first.startedAt && all[0]?.outbound.length === 2, all[0]);
	check("usage is the accumulated total", usage.runs === afterFirst.runs && usage.turns === afterFirst.turns + 1 && usage.input === 150 && Math.abs(usage.cost - 0.015) < 1e-9, { afterFirst, usage });
	runs.reclassify(first.id, "interrupted", "slept");
	check("reclassify closes an expired interrupted run as aborted", runs.reclassify(first.id, "aborted", "interrupted")?.stopReason === "aborted" && runs.last()?.stopReason === "aborted", runs.last());
	check("reclassify refuses a non-matching stop reason", runs.reclassify(first.id, "aborted", "interrupted") === undefined);
	runs.reclassify(first.id, "interrupted", "aborted");
	check("resume decision: recent resumes", interruptedResumeDecision(runs.last(), finishedAt + 1_000, 10 * 60_000) === "resume");
	check("resume decision: outside the window expires", interruptedResumeDecision(runs.last(), (runs.last()?.finishedAt ?? 0) + 10 * 60_000, 10 * 60_000) === "expire");
	check("resume decision: 0 disables", interruptedResumeDecision(runs.last(), finishedAt + 1, 0) === "expire");
	check("runTurnCount reads the current shape", runTurnCount(runs.last()!) === 2, runs.last());
	fs.rmSync(resumeRoot, { recursive: true, force: true });
}

section("run log: who stopped the run (#168)");
{
	const legacy = (stopReason: RunStopReason) => runStoppedBy({ stopReason });
	check("a slept run was stopped by the agent's own sleep", legacy("slept") === "sleep", legacy("slept"));
	check(
		"stalled/timeout/budget derive to a limit stop",
		legacy("stalled") === "limit" && legacy("timeout") === "limit" && legacy("budget") === "limit",
		[legacy("stalled"), legacy("timeout"), legacy("budget")],
	);
	check("a bare error is attributed to the provider", legacy("error") === "provider", legacy("error"));
	check(
		"legacy interrupted/aborted runs derive to a restart",
		legacy("interrupted") === "restart" && legacy("aborted") === "restart",
		[legacy("interrupted"), legacy("aborted")],
	);
	check(
		"an explicit field wins over the derived value",
		runStoppedBy({ stoppedBy: "stop", stopReason: "interrupted" }) === "stop" &&
			runStoppedBy({ stoppedBy: "model", stopReason: "error" }) === "model" &&
			runStoppedBy({ stoppedBy: "cancel", stopReason: "aborted" }) === "cancel",
		[runStoppedBy({ stoppedBy: "stop", stopReason: "interrupted" })],
	);
	check(
		"garbage values are ignored and the stop reason still answers",
		runStoppedBy({ stoppedBy: "banana", stopReason: "slept" }) === "sleep" &&
			runStoppedBy({ stoppedBy: 42, stopReason: "error" }) === "provider" &&
			runStoppedBy({ stoppedBy: null }) === "restart" &&
			runStoppedBy({ stoppedBy: "", stopReason: "timeout" }) === "limit",
		[runStoppedBy({ stoppedBy: "banana", stopReason: "slept" }), runStoppedBy({ stoppedBy: 42, stopReason: "error" })],
	);
	check(
		"every allowed literal is accepted as-is",
		RUN_STOPPED_BY_VALUES.every((value) => isRunStoppedBy(value) && runStoppedBy({ stoppedBy: value, stopReason: "slept" }) === value),
		RUN_STOPPED_BY_VALUES.filter((value) => runStoppedBy({ stoppedBy: value, stopReason: "slept" }) !== value),
	);
	check("non-literals are rejected", !isRunStoppedBy("slept") && !isRunStoppedBy(undefined) && !isRunStoppedBy("STOP"));

	// Both shapes must survive a real write/read cycle.
	const stoppedByRoot = fs.mkdtempSync(path.join(os.tmpdir(), "alive-run-stopped-by-test-"));
	const log = new RunLog(stoppedByRoot);
	const now = Date.now();
	const base: RunRecord = {
		id: "run_legacy_shape",
		index: 1,
		startedAt: now - 1_000,
		finishedAt: now,
		durationMs: 1_000,
		activeMs: 1_000,
		idleMs: 0,
		stopReason: "interrupted",
		events: [],
		outbound: [],
		remindersCreated: [],
		notesTouched: [],
		journalEntries: 0,
		idleReturns: 0,
		interruptDeliveries: 0,
		nudges: 0,
		turnCount: 0,
		promptChars: 0,
		usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0, cost: 0 },
	};
	log.record(base);
	log.record({ ...base, id: "run_explicit", index: 2, stopReason: "interrupted", stoppedBy: "stop" });
	const stored = log.list(10);
	check(
		"a legacy line without the field still reads and derives its initiator",
		stored[0]?.stoppedBy === undefined && runStoppedBy(stored[0]!) === "restart",
		stored[0],
	);
	check("the new field round-trips through runs.jsonl", stored[1]?.stoppedBy === "stop" && runStoppedBy(stored[1]!) === "stop", stored[1]);
	check(
		"a derived initiator is marked inferred, a recorded one is not",
		runStoppedByInferred(stored[0]!) && !runStoppedByInferred(stored[1]!),
		{ legacy: runStoppedByInferred(stored[0]!), recorded: runStoppedByInferred(stored[1]!) },
	);
	check(
		"garbage in the stored field counts as inferred",
		runStoppedByInferred({ stoppedBy: "banana", stopReason: "slept" }) && runStoppedByInferred({ stoppedBy: 7 }),
		runStoppedByInferred({ stoppedBy: "banana", stopReason: "slept" }),
	);
	log.record({ ...base, id: "run_unsettled", index: 3, usageUnsettled: true });
	check(
		"the usage-unsettled flag round-trips and absent means settled",
		log.list(10).find((record) => record.id === "run_unsettled")?.usageUnsettled === true &&
			log.list(10).find((record) => record.id === "run_legacy_shape")?.usageUnsettled === undefined,
		log.list(10).map((record) => [record.id, record.usageUnsettled]),
	);
	fs.rmSync(stoppedByRoot, { recursive: true, force: true });
}

section("loop shutdown/resume config is validated and interrupted is not an error (#124)");
{
	check(
		"the defaults are 30 s and 10 min",
		DEFAULT_CONFIG.loop.shutdownGraceMs === 30_000 && DEFAULT_CONFIG.loop.resumeWindowMs === 10 * 60_000,
		DEFAULT_CONFIG.loop,
	);
	const accepted = validateLoopConfig({ ...DEFAULT_CONFIG.loop, shutdownGraceMs: 5_000, resumeWindowMs: 0 });
	check("explicit values are accepted, 0 disables resume", accepted.shutdownGraceMs === 5_000 && accepted.resumeWindowMs === 0, accepted);
	for (const key of ["shutdownGraceMs", "resumeWindowMs"] as const) {
		for (const value of [-1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, "30000"]) {
			let message = "";
			try {
				validateLoopConfig({ ...DEFAULT_CONFIG.loop, [key]: value } as never);
			} catch (error) {
				message = error instanceof Error ? error.message : String(error);
			}
			check(`invalid ${key}=${String(value)} is rejected`, message.startsWith(`loop.${key}`), message || "accepted");
		}
	}
	const partial = validateLoopConfig({ ...DEFAULT_CONFIG.loop, shutdownGraceMs: undefined, resumeWindowMs: null } as never);
	check("missing keys fall back to the defaults", partial.shutdownGraceMs === 30_000 && partial.resumeWindowMs === 10 * 60_000, partial);
	check("interrupted is its own successful outcome, not an error", runOutcome("interrupted").key === "interrupted" && runOutcome("interrupted").key !== "error", runOutcome("interrupted"));
	check("aborted still maps to error", runOutcome("aborted").key === "error");
	check("slept/stalled mappings are unchanged", runOutcome("slept").key === "sleep" && runOutcome("stalled").key === "idle");
}

process.stdout.write(
	failures === 0 ? `\nALL STORE TESTS PASSED (${stateDir})\n` : `\n${failures} STORE TEST(S) FAILED\n`,
);
process.exitCode = failures === 0 ? 0 : 1;
