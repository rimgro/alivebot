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
import {
	INIT_FAILURE_STAY_THRESHOLD,
	INIT_FAILURE_WINDOW_MS,
	initFailureDecision,
	initFailuresPath,
	readInitFailures,
	resetInitFailures,
	writeInitFailures,
	type InitFailureRecord,
} from "../store/init-failures.js";
import { ReminderStore } from "../store/reminders.js";
import { ThreadStore } from "../store/threads.js";
import { NoteStore } from "../store/notes.js";
import { Journal } from "../store/journal.js";
import {
	detectRunStall,
	interruptedResumeDecision,
	isRunInterruption,
	isRunStoppedBy,
	resumeFileUsable,
	RUN_STOPPED_BY_VALUES,
	RunLog,
	runInterruptions,
	runStoppedBy,
	runStoppedByInferred,
	runTurnCount,
	startupResumeDecision,
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

section("event store: redelivery counters are bounded and pruned (#219)");
{
	const dir = path.join(root, ".alive-redelivery");
	const store = EventStore.open(dir);
	const a = store.append({ kind: "user_message", source: "test", priority: "normal", title: "ra", text: "ra" });
	const b = store.append({ kind: "user_message", source: "test", priority: "normal", title: "rb", text: "rb" });
	store.beginRun("r1");
	store.claim(10);
	store.rollbackClaim();
	check(
		"rollback increments every claimed event",
		store.redeliveryCount(a.seq) === 1 && store.redeliveryCount(b.seq) === 1,
		{ a: store.redeliveryCount(a.seq), b: store.redeliveryCount(b.seq) },
	);
	check("rolled back events are pending again", store.pendingCount() === 2, store.status());
	store.beginRun("r2");
	store.claim(10);
	store.rollbackClaim();
	check(
		"a second rollback increments again",
		store.redeliveryCount(a.seq) === 2 && store.redeliveryCount(b.seq) === 2,
		{ a: store.redeliveryCount(a.seq), b: store.redeliveryCount(b.seq) },
	);
	store.beginRun("r3");
	store.claim(10);
	store.ack();
	check(
		"ack clears the counters of acknowledged events",
		store.redeliveryCount(a.seq) === 0 && store.redeliveryCount(b.seq) === 0,
		{ a: store.redeliveryCount(a.seq), b: store.redeliveryCount(b.seq) },
	);
	check("ack keeps the run open", store.openRunId === "r3", store.status());
	store.endRun();

	// Mixed range: the exhausted head is acknowledged through ackThrough, the tail rolls back.
	const c = store.append({ kind: "user_message", source: "test", priority: "normal", title: "rc", text: "rc" });
	const d = store.append({ kind: "user_message", source: "test", priority: "normal", title: "rd", text: "rd" });
	store.beginRun("r4");
	store.claim(10);
	store.rollbackClaim();
	store.beginRun("r5");
	store.claim(10);
	store.ackThrough(c.seq);
	check("ackThrough advances ackedSeq", store.ackedSeq === c.seq, store.status());
	check("ackThrough prunes the acknowledged head", store.redeliveryCount(c.seq) === 0, store.redeliveryCount(c.seq));
	check("ackThrough leaves the tail counter", store.redeliveryCount(d.seq) === 1, store.redeliveryCount(d.seq));
	store.rollbackClaim();
	check("the tail still counts a rollback after ackThrough", store.redeliveryCount(d.seq) === 2, store.redeliveryCount(d.seq));
	check("only the tail remains pending", store.pendingCount() === 1, store.status());
	store.beginRun("r6");
	store.claim(10);
	store.endRun();
	check("endRun clears the counter too", store.redeliveryCount(d.seq) === 0, store.redeliveryCount(d.seq));
}

section("event store: an old cursor without redeliveries still reads (#219)");
{
	const dir = path.join(root, ".alive-old-cursor");
	const inbox = path.join(dir, "inbox");
	fs.mkdirSync(inbox, { recursive: true });
	fs.writeFileSync(path.join(inbox, "cursor.json"), JSON.stringify({ ackedSeq: 0, openRun: null }), "utf8");
	const store = EventStore.open(dir);
	const e = store.append({ kind: "user_message", source: "test", priority: "normal", title: "old", text: "old" });
	check("the missing field reads as an empty budget", store.redeliveryCount(e.seq) === 0, store.redeliveryCount(e.seq));
	store.beginRun("old-cursor");
	store.claim(10);
	store.rollbackClaim();
	check("a rollback starts the counter", store.redeliveryCount(e.seq) === 1, store.redeliveryCount(e.seq));
	const saved = JSON.parse(fs.readFileSync(path.join(inbox, "cursor.json"), "utf8")) as { redeliveries?: Record<string, number> };
	check("the new field is persisted", saved.redeliveries?.[String(e.seq)] === 1, saved);
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
	log.record({
		...base,
		id: "run_context_reset",
		index: 4,
		stopReason: "slept",
		contextReset: { reason: "hard", tokens: 260_000, limitTokens: 250_000 },
	});
	const storedReset = log.list(10).find((record) => record.id === "run_context_reset");
	check(
		"contextReset round-trips additively through runs.jsonl (#170)",
		storedReset?.contextReset?.reason === "hard" &&
			storedReset.contextReset.tokens === 260_000 &&
			storedReset.contextReset.limitTokens === 250_000,
		storedReset?.contextReset,
	);
	check(
		"old records without contextReset stay readable",
		log.list(10).find((record) => record.id === "run_legacy_shape")?.contextReset === undefined,
		log.list(10).find((record) => record.id === "run_legacy_shape"),
	);
	fs.rmSync(stoppedByRoot, { recursive: true, force: true });
}

section("run log: interrupted stops survive a resume (#185)");
{
	const interruptedRoot = fs.mkdtempSync(path.join(os.tmpdir(), "alive-run-interrupted-test-"));
	const log = new RunLog(interruptedRoot);
	const file = path.join(interruptedRoot, "runs", "runs.jsonl");
	const storedLines = (): RunRecord[] =>
		fs
			.readFileSync(file, "utf8")
			.split("\n")
			.filter((line) => line.trim().length > 0)
			.map((line) => JSON.parse(line) as RunRecord);
	const record = (input: {
		id: string;
		index: number;
		stopReason: RunStopReason;
		stoppedBy?: RunRecord["stoppedBy"];
		finishedAt: number;
	}): RunRecord => ({
		id: input.id,
		index: input.index,
		startedAt: input.finishedAt - 60_000,
		finishedAt: input.finishedAt,
		durationMs: 60_000,
		activeMs: 60_000,
		idleMs: 0,
		stopReason: input.stopReason,
		...(input.stoppedBy ? { stoppedBy: input.stoppedBy } : {}),
		events: [],
		outbound: [],
		remindersCreated: [],
		notesTouched: [],
		journalEntries: 0,
		idleReturns: 0,
		interruptDeliveries: 0,
		nudges: 0,
		turnCount: 1,
		promptChars: 0,
		usage: { input: 10, output: 5, cacheRead: 0, cacheWrite: 0, total: 15, cost: 0.001 },
	});
	const now = Date.now();

	log.record(record({ id: "run_plain", index: 1, stopReason: "slept", stoppedBy: "sleep", finishedAt: now }));
	const plain = storedLines().find((line) => line.id === "run_plain");
	check("a run that was never interrupted has no interruptedBy key", plain !== undefined && !("interruptedBy" in plain), plain);

	log.record(record({ id: "run_resume", index: 2, stopReason: "interrupted", stoppedBy: "restart", finishedAt: now }));
	log.record(record({ id: "run_resume", index: 2, stopReason: "slept", stoppedBy: "sleep", finishedAt: now + 30_000 }));
	const resumedLines = storedLines().filter((line) => line.id === "run_resume");
	const resumed = resumedLines[0];
	check("the resumed run is still one line, not a duplicate", resumedLines.length === 1, resumedLines);
	check("the top-level stop is the last closure", resumed?.stopReason === "slept" && resumed.stoppedBy === "sleep", resumed);
	check(
		"the interrupted closure is kept in interruptedBy with its finish time",
		JSON.stringify(resumed?.interruptedBy) ===
			JSON.stringify([{ stoppedBy: "restart", stopReason: "interrupted", at: now }]),
		resumed?.interruptedBy,
	);

	log.record(record({ id: "run_twice", index: 3, stopReason: "interrupted", stoppedBy: "restart", finishedAt: now + 60_000 }));
	log.record(record({ id: "run_twice", index: 3, stopReason: "interrupted", stoppedBy: "stop", finishedAt: now + 90_000 }));
	log.record(record({ id: "run_twice", index: 3, stopReason: "slept", stoppedBy: "sleep", finishedAt: now + 120_000 }));
	const twice = storedLines().find((line) => line.id === "run_twice");
	check(
		"two interruptions keep both stops oldest first",
		JSON.stringify(twice?.interruptedBy) ===
			JSON.stringify([
				{ stoppedBy: "restart", stopReason: "interrupted", at: now + 60_000 },
				{ stoppedBy: "stop", stopReason: "interrupted", at: now + 90_000 },
			]),
		twice?.interruptedBy,
	);

	check(
		"an identical closure is not recorded twice",
		(() => {
			const dedupeRoot = fs.mkdtempSync(path.join(os.tmpdir(), "alive-run-interrupted-dedupe-test-"));
			const dedupe = new RunLog(dedupeRoot);
			dedupe.record(record({ id: "run_dup", index: 5, stopReason: "interrupted", stoppedBy: "restart", finishedAt: now }));
			dedupe.record(record({ id: "run_dup", index: 5, stopReason: "interrupted", stoppedBy: "restart", finishedAt: now }));
			const history = dedupe.last()?.interruptedBy;
			fs.rmSync(dedupeRoot, { recursive: true, force: true });
			return history?.length === 1;
		})(),
	);

	check(
		"sleep/limit/provider/model stops are not interruptions",
		!isRunInterruption({ stoppedBy: "limit", stopReason: "timeout" }) &&
			!isRunInterruption({ stoppedBy: "sleep", stopReason: "slept" }) &&
			!isRunInterruption({ stoppedBy: "provider", stopReason: "error" }) &&
			!isRunInterruption({ stoppedBy: "model", stopReason: "error" }) &&
			isRunInterruption({ stoppedBy: "restart", stopReason: "interrupted" }) &&
			isRunInterruption({ stoppedBy: "stop", stopReason: "aborted" }) &&
			isRunInterruption({ stoppedBy: "cancel", stopReason: "aborted" }) &&
			isRunInterruption({ stopReason: "interrupted" }),
	);
	log.record(record({ id: "run_limit", index: 4, stopReason: "timeout", stoppedBy: "limit", finishedAt: now }));
	log.record(record({ id: "run_limit", index: 4, stopReason: "slept", stoppedBy: "sleep", finishedAt: now + 30_000 }));
	const limited = storedLines().find((line) => line.id === "run_limit");
	check("a limit timeout leaves the history empty and the key absent", limited !== undefined && !("interruptedBy" in limited), limited);

	check("runInterruptions ignores a non-array field", runInterruptions({ interruptedBy: "x" }).length === 0);
	const sanitized = runInterruptions({
		interruptedBy: [
			"x",
			null,
			7,
			{ stoppedBy: "nope", stopReason: "slept", at: 1 },
			{ stoppedBy: "restart", stopReason: "interrupted", at: 2 },
		],
	});
	check(
		"runInterruptions keeps only the well-formed entry",
		sanitized.length === 1 && sanitized[0]?.stoppedBy === "restart" && sanitized[0].stopReason === "interrupted" && sanitized[0].at === 2,
		sanitized,
	);
	check("a record without the field reads as no history", runInterruptions({}).length === 0);

	// Old records without the field stay readable and a resume still applies usage as a delta.
	const usageRoot = fs.mkdtempSync(path.join(os.tmpdir(), "alive-run-interrupted-usage-test-"));
	const usageLog = new RunLog(usageRoot);
	const usageFirst = record({ id: "run_usage", index: 9, stopReason: "interrupted", stoppedBy: "restart", finishedAt: now });
	usageLog.record(usageFirst);
	const usageBefore = usageLog.usageToday();
	const usageResumed = {
		...record({ id: "run_usage", index: 9, stopReason: "slept", stoppedBy: "sleep", finishedAt: now + 30_000 }),
		startedAt: usageFirst.startedAt,
		durationMs: usageFirst.durationMs + 30_000,
	};
	usageLog.record(usageResumed);
	const usageAfter = usageLog.usageToday();
	check(
		"a resume is one run in usage, not two",
		usageBefore.runs === 1 && usageAfter.runs === 1 && usageAfter.turns === 1 && usageAfter.input === 10,
		{ usageBefore, usageAfter },
	);
	check(
		"a resume keeps the original index and start",
		usageLog.last()?.index === 9 && usageLog.last()?.startedAt === usageFirst.startedAt,
		usageLog.last(),
	);
	check("the resumed usage record carries the interruption history", usageLog.last()?.interruptedBy?.length === 1, usageLog.last()?.interruptedBy);
	fs.rmSync(usageRoot, { recursive: true, force: true });
	fs.rmSync(interruptedRoot, { recursive: true, force: true });
}

section("startup resume refuses a missing or empty session file (#173)");
{
	const now = Date.now();
	const interrupted: RunRecord = {
		id: "run_gone_session",
		index: 3,
		startedAt: now - 120_000,
		finishedAt: now - 60_000,
		durationMs: 60_000,
		activeMs: 60_000,
		idleMs: 0,
		stopReason: "interrupted",
		sessionFile: "/tmp/archived-session.jsonl",
		events: [],
		outbound: [],
		remindersCreated: [],
		notesTouched: [],
		journalEntries: 0,
		idleReturns: 0,
		interruptDeliveries: 0,
		nudges: 0,
		turnCount: 1,
		promptChars: 0,
		usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0, cost: 0 },
	};
	check("a missing session file is not resumable", startupResumeDecision(interrupted, now, 600_000, interrupted.sessionFile, undefined) === "unusable");
	check("an empty session file is not resumable", startupResumeDecision(interrupted, now, 600_000, interrupted.sessionFile, 0) === "unusable");
	check("a readable non-empty session file resumes", startupResumeDecision(interrupted, now, 600_000, interrupted.sessionFile, 4_096) === "resume");
	check(
		"a record without a session file keeps the configured session mode",
		startupResumeDecision({ ...interrupted, sessionFile: undefined }, now, 600_000, undefined, undefined) === "resume",
	);
	check(
		"outside the resume window the file does not matter",
		startupResumeDecision(interrupted, now + 600_000, 600_000, interrupted.sessionFile, undefined) === "expire",
	);
	check(
		"a non-interrupted run is never resumed",
		startupResumeDecision({ ...interrupted, stopReason: "slept" }, now, 600_000, interrupted.sessionFile, 4_096) === "none",
	);
	check(
		"resumeFileUsable rejects missing, empty and blank paths",
		!resumeFileUsable(undefined, 10) && !resumeFileUsable("  ", 10) && !resumeFileUsable("/tmp/x", undefined) && !resumeFileUsable("/tmp/x", 0),
	);
	check("resumeFileUsable accepts a non-empty file", resumeFileUsable("/tmp/x", 1));

	// What the runtime does with an "unusable" decision: close the run, do not resume.
	const resumeRoot = fs.mkdtempSync(path.join(os.tmpdir(), "alive-run-unusable-resume-test-"));
	const runs = new RunLog(resumeRoot);
	runs.record(interrupted);
	const decision = startupResumeDecision(runs.last(), now, 600_000, interrupted.sessionFile, undefined);
	const closed = decision === "unusable"
		? runs.reclassify(interrupted.id, "aborted", "interrupted", "resume skipped: session file is missing, empty or unreadable")
		: undefined;
	check("an unusable resume target closes the run as aborted", decision === "unusable" && closed?.stopReason === "aborted" && runs.last()?.stopReason === "aborted", { decision, last: runs.last()?.stopReason });
	check("the reason is persisted in the record's error field", (runs.last()?.error ?? "").includes("resume skipped"), runs.last()?.error);
	check("the aborted run is no longer resumable", startupResumeDecision(runs.last(), now, 600_000, interrupted.sessionFile, 4_096) === "none");
	fs.rmSync(resumeRoot, { recursive: true, force: true });
}

section("an open run without ticks is a stall (#173)");
{
	const now = Date.now();
	check("a fresh open run is not stalled", detectRunStall({ runId: "run_1", lastTickAt: now - 1_000, now, thresholdMs: 600_000 }) === undefined);
	const stalled = detectRunStall({ runId: "run_1", lastTickAt: now - 600_000, now, thresholdMs: 600_000 });
	check(
		"an open run past the threshold reports the age and the threshold",
		stalled?.ageMs === 600_000 && stalled.thresholdMs === 600_000 && stalled.runId === "run_1" && stalled.since === now - 600_000,
		stalled,
	);
	check("threshold 0 disables the check", detectRunStall({ runId: "run_1", lastTickAt: now - 10 * 600_000, now, thresholdMs: 0 }) === undefined);
	check("no open run is never a stall", detectRunStall({ lastTickAt: now - 10 * 600_000, now, thresholdMs: 600_000 }) === undefined);
	check("a missing tick timestamp is not a stall", detectRunStall({ runId: "run_1", now, thresholdMs: 600_000 }) === undefined);
}

section("consecutive init failures stop a restart loop (#173/#178)");
{
	const now = Date.now();
	const fail = (previous?: InitFailureRecord, at = now) => initFailureDecision(previous, at);
	const first = fail();
	check("the first failure counts 1 and exits", first.consecutive === 1 && first.action === "exit" && !first.reset, first);
	const second = fail({ consecutive: 1, lastFailureAt: now - 60_000 });
	check("the second failure counts 2 and still exits", second.consecutive === 2 && second.action === "exit", second);
	const third = fail({ consecutive: 2, lastFailureAt: now - 60_000 });
	check(
		"the third failure stays alive in status=error instead of exiting",
		third.consecutive === INIT_FAILURE_STAY_THRESHOLD && third.action === "stay",
		third,
	);
	check(
		"the guard is 3 failures inside a 30 minute window",
		INIT_FAILURE_STAY_THRESHOLD === 3 && INIT_FAILURE_WINDOW_MS === 30 * 60_000,
		{ threshold: INIT_FAILURE_STAY_THRESHOLD, windowMs: INIT_FAILURE_WINDOW_MS },
	);
	const stale = fail({ consecutive: 4, lastFailureAt: now - INIT_FAILURE_WINDOW_MS - 1 });
	check("a failure after the window starts the count over at 1", stale.consecutive === 1 && stale.action === "exit" && stale.reset, stale);
	const boundary = fail({ consecutive: 2, lastFailureAt: now - INIT_FAILURE_WINDOW_MS });
	check("the window boundary is inclusive", boundary.consecutive === 3 && boundary.action === "stay", boundary);
	// The runtime's own sequence: three fast failures, then one after a long pause.
	let record: InitFailureRecord | undefined;
	const actions: string[] = [];
	for (const at of [now, now + 1_000, now + 2_000]) {
		const decision = initFailureDecision(record, at);
		actions.push(`${decision.consecutive}:${decision.action}`);
		record = { consecutive: decision.consecutive, lastFailureAt: at };
	}
	const afterPause = initFailureDecision(record, now + 45 * 60_000);
	actions.push(`${afterPause.consecutive}:${afterPause.action}`);
	check("the streak 1,2 exits, 3 stays, and a late failure retries", actions.join(",") === "1:exit,2:exit,3:stay,1:exit", actions);

	// File round-trip: atomic write, documented shape, corrupt file reads as 0.
	const failuresRoot = fs.mkdtempSync(path.join(os.tmpdir(), "alive-init-failures-test-"));
	const failuresDir = path.join(failuresRoot, ".alive");
	check("a missing counter reads as 0", readInitFailures(failuresDir).consecutive === 0);
	writeInitFailures(failuresDir, { consecutive: 2, lastFailureAt: now, lastError: "boom" });
	const stored = JSON.parse(fs.readFileSync(initFailuresPath(failuresDir), "utf8")) as { consecutive: number; lastFailureAt: string; lastError?: string };
	check(
		"the counter file is the documented shape",
		stored.consecutive === 2 && stored.lastFailureAt === new Date(now).toISOString() && stored.lastError === "boom",
		stored,
	);
	const read = readInitFailures(failuresDir);
	check("the counter round-trips", read.consecutive === 2 && read.lastFailureAt === now && read.lastError === "boom", read);
	fs.writeFileSync(initFailuresPath(failuresDir), "{not json", "utf8");
	check("a corrupt counter reads as 0", readInitFailures(failuresDir).consecutive === 0);
	fs.writeFileSync(initFailuresPath(failuresDir), JSON.stringify({ consecutive: -2, lastFailureAt: "yesterday" }));
	const garbage = readInitFailures(failuresDir);
	check("garbage counts read as 0", garbage.consecutive === 0 && garbage.lastFailureAt === 0, garbage);
	writeInitFailures(failuresDir, { consecutive: 3, lastFailureAt: now });
	resetInitFailures(failuresDir);
	check(
		"a successful boot resets the counter to 0",
		readInitFailures(failuresDir).consecutive === 0 && !fs.existsSync(initFailuresPath(failuresDir)),
	);
	resetInitFailures(failuresDir);
	check("resetting a missing counter is harmless", readInitFailures(failuresDir).consecutive === 0);
	fs.rmSync(failuresRoot, { recursive: true, force: true });
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
