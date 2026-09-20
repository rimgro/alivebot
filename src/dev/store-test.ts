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
import { RunLog } from "../store/runs.js";
import { DEFAULT_POLICY, PolicyStore } from "../store/policy.js";

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

process.stdout.write(
	failures === 0 ? `\nALL STORE TESTS PASSED (${stateDir})\n` : `\n${failures} STORE TEST(S) FAILED\n`,
);
process.exitCode = failures === 0 ? 0 : 1;
