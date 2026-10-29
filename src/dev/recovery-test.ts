/**
 * Recovery tests: what survives a crash/restart.
 *
 * Everything here is filesystem-only — a "crash" means dropping the in-memory
 * objects and opening fresh stores on the same state directory. No model is
 * involved.
 *
 *   npm run test:recovery
 */
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { EventStore } from "../store/events.js";
import {
	DEFAULT_OUTBOX_MAX_AGE_MS,
	Outbox,
	type OutgoingMessage,
} from "../store/outbox.js";
import { dispatchDueReminders, ReminderStore } from "../store/reminders.js";
import { appendJsonl } from "../util.js";

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
function messageId(message: OutgoingMessage): string {
	return message.deliveryKey ?? message.id;
}

const root = fs.mkdtempSync(path.join(os.tmpdir(), "alive-recovery-test-"));

section("outbox: a queued message is delivered once after restart");
{
	const stateDir = path.join(root, "outbox-restart");
	const sink: string[] = [];
	const outbox = new Outbox(stateDir);
	let firstAttempt = "";
	await outbox
		.send({ runId: "run1", thread: "telegram:1", text: "hello" }, async (message) => {
			firstAttempt = messageId(message);
			sink.push(firstAttempt);
			throw new Error("connection reset after send");
		})
		.catch(() => undefined);
	check("the failed first attempt is recorded", sink.length === 1, sink);

	const restarted = new Outbox(stateDir);
	const result = await restarted.recoverPending({
		deliver: async (message) => {
			const key = messageId(message);
			if (!sink.includes(key)) sink.push(key);
		},
	});
	check("one message was recovered", result.delivered === 1 && result.scanned === 1, result);
	check("the sink saw the message exactly once", sink.length === 1 && sink[0] === firstAttempt, sink);

	const again = await new Outbox(stateDir).recoverPending({
		deliver: async (message) => {
			const key = messageId(message);
			if (!sink.includes(key)) sink.push(key);
		},
	});
	check("a delivered message is not retried on the next restart", again.delivered === 0 && sink.length === 1, again);
}

section("outbox: a crash between send and mark does not duplicate");
{
	const stateDir = path.join(root, "outbox-interrupted");
	const file = path.join(stateDir, "outbox", "messages.jsonl");
	const id = "msg_interrupted";
	const now = Date.now();
	// Queue record written, first attempt reached the sink, then the process died
	// before either the success or the failure record could be appended.
	appendJsonl(file, {
		type: "message",
		id,
		deliveryKey: id,
		runId: "run1",
		thread: "telegram:1",
		text: "only once",
		ts: now,
	});
	appendJsonl(file, { type: "attempt", messageId: id, attempt: 1, ts: now });
	const sink: string[] = [id];

	const result = await new Outbox(stateDir).recoverPending({
		now,
		deliver: async (message) => {
			const key = messageId(message);
			if (!sink.includes(key)) sink.push(key);
		},
	});
	check("the interrupted message is retried", result.delivered === 1, result);
	check("the idempotency key prevented a duplicate", sink.length === 1 && sink[0] === id, sink);
}

section("outbox: bounded attempts stop a poison message");
{
	const stateDir = path.join(root, "outbox-attempts");
	const file = path.join(stateDir, "outbox", "messages.jsonl");
	const id = "msg_poison";
	const now = Date.now();
	appendJsonl(file, { type: "message", id, deliveryKey: id, runId: "run", thread: "telegram:1", text: "x", ts: now });
	for (let attempt = 1; attempt <= 3; attempt += 1) {
		appendJsonl(file, { type: "attempt", messageId: id, attempt, ts: now });
		appendJsonl(file, { type: "delivery", messageId: id, ok: false, error: "boom", ts: now });
	}
	let delivered = 0;
	const result = await new Outbox(stateDir).recoverPending({
		now,
		maxAttempts: 3,
		deliver: async () => {
			delivered += 1;
		},
	});
	check("attempt-limited message is not delivered", delivered === 0 && result.skippedExhausted === 1, result);
	const again = await new Outbox(stateDir).recoverPending({ now, maxAttempts: 3, deliver: async () => undefined });
	check("abandonment is durable", again.skippedExhausted === 0, again);
}

section("outbox: the age limit skips stale entries with a log line");
{
	const stateDir = path.join(root, "outbox-stale");
	const file = path.join(stateDir, "outbox", "messages.jsonl");
	const now = Date.now();
	const id = "msg_stale";
	appendJsonl(file, {
		type: "message",
		id,
		deliveryKey: id,
		runId: "run",
		thread: "telegram:1",
		text: "ancient",
		ts: now - DEFAULT_OUTBOX_MAX_AGE_MS - 60_000,
	});
	const logs: Array<{ level: string; message: string; details?: Record<string, unknown> }> = [];
	let delivered = 0;
	const result = await new Outbox(stateDir).recoverPending({
		now,
		deliver: async () => {
			delivered += 1;
		},
		log: (level, message, details) => logs.push({ level, message, details }),
	});
	check("stale message is skipped", result.skippedStale === 1 && delivered === 0, result);
	check(
		"the skip is logged",
		logs.some((line) => line.level === "warn" && line.message.includes("stale") && line.details?.messageId === id),
		logs,
	);
	const again = await new Outbox(stateDir).recoverPending({
		now,
		deliver: async () => {
			delivered += 1;
		},
		log: (level, message, details) => logs.push({ level, message, details }),
	});
	check("a stale message is not logged or retried forever", again.skippedStale === 0 && delivered === 0, again);
}

section("reminders: overdue on startup fires once");
{
	const stateDir = path.join(root, "reminders");
	const reminders = new ReminderStore(stateDir);
	const events = EventStore.open(stateDir);
	const overdue = reminders.add({ text: "the build finished", dueAt: Date.now() - 60 * 60_000, thread: "ci" });
	const now = Date.now();
	const fired = dispatchDueReminders(reminders, events, now);
	check("the overdue reminder fired", fired.length === 1 && fired[0]?.id === overdue.id, fired);
	const reminderEvents = events.all().filter((event) => event.kind === "reminder");
	check("it produced one inbox event", reminderEvents.length === 1 && reminderEvents[0]?.dedupeKey === `reminder:${overdue.id}`, reminderEvents);

	// Restart: fresh stores on the same files.
	const rebornReminders = new ReminderStore(stateDir);
	const rebornEvents = EventStore.open(stateDir);
	const again = dispatchDueReminders(rebornReminders, rebornEvents, now + 1_000);
	check("it does not fire twice after restart", again.length === 0, again);
	check("no duplicate event was appended", rebornEvents.all().filter((event) => event.kind === "reminder").length === 1, rebornEvents.status());
	check("no reminder is left pending", rebornReminders.list().length === 0, rebornReminders.list());
}

section("reminders: crash between event append and firedAt replays safely");
{
	const stateDir = path.join(root, "reminders-crash-window");
	const reminders = new ReminderStore(stateDir);
	const events = EventStore.open(stateDir);
	const overdue = reminders.add({ text: "retry me", dueAt: Date.now() - 1_000 });
	const now = Date.now();
	// Simulate the process dying after the durable inbox append, before
	// markFired() persisted.
	events.append({
		kind: "reminder",
		source: "scheduler",
		priority: "normal",
		title: "retry me",
		text: "retry me",
		dedupeKey: `reminder:${overdue.id}`,
	});
	check("the reminder is still pending after the simulated crash", reminders.list().length === 1, reminders.list());

	const rebornReminders = new ReminderStore(stateDir);
	const rebornEvents = EventStore.open(stateDir);
	const fired = dispatchDueReminders(rebornReminders, rebornEvents, now + 1_000);
	check("the pending reminder fires after restart", fired.length === 1, fired);
	check("the dedupe key prevents a second inbox event", rebornEvents.all().filter((event) => event.kind === "reminder").length === 1, rebornEvents.status());
	check("it is now marked fired", rebornReminders.list().length === 0, rebornReminders.list());
}

section("inbox: a durable cursor does not process an event twice");
{
	const stateDir = path.join(root, "inbox-clean");
	const events = EventStore.open(stateDir);
	const event = events.append({ kind: "user_message", source: "test", priority: "normal", title: "once", text: "once", thread: "t1" });
	events.beginRun("run1");
	const claimed = events.claim(10);
	events.endRun();
	check("the run claimed the event", claimed.length === 1 && claimed[0]?.id === event.id, claimed);

	const restarted = EventStore.open(stateDir);
	check("after restart the acknowledged event is not pending", restarted.pendingCount() === 0, restarted.status());
	check("a clean shutdown leaves no crash range", restarted.recoverAfterCrash() === null);
	const duplicate = restarted.append({
		kind: "user_message",
		source: "test",
		priority: "normal",
		title: "once",
		text: "once",
		thread: "t1",
		dedupeKey: "inbox-once",
	});
	const duplicateAgain = restarted.append({
		kind: "user_message",
		source: "test",
		priority: "normal",
		title: "once",
		text: "once",
		thread: "t1",
		dedupeKey: "inbox-once",
	});
	check("a durable dedupe key returns the stored event", duplicate.id === duplicateAgain.id && restarted.all().length === 2, restarted.status());
}

section("inbox: an event appended before a crash is claimed once per cursor stage");
{
	const stateDir = path.join(root, "inbox-crash");
	const events = EventStore.open(stateDir);
	const event = events.append({ kind: "user_message", source: "test", priority: "normal", title: "before crash", text: "before crash", thread: "t2" });
	const reborn = EventStore.open(stateDir);
	check("the appended event is pending after restart", reborn.pendingCount() === 1 && reborn.peekPending(10)[0]?.id === event.id, reborn.status());

	reborn.beginRun("run-after-restart");
	const first = reborn.claim(10);
	check("it is claimed exactly once", first.length === 1 && first[0]?.id === event.id, first);

	// Crash after claim, before ack: the in-flight batch is intentionally
	// redelivered once (at-least-once), but it is the same event, not a new one.
	const rebornAgain = EventStore.open(stateDir);
	const range = rebornAgain.recoverAfterCrash();
	check("the interrupted claim is reported for redelivery", range?.fromSeq === event.seq && range?.toSeq === event.seq, range);
	check("there is still exactly one event", rebornAgain.all().length === 1, rebornAgain.status());
	rebornAgain.beginRun("run-after-crash");
	const redelivered = rebornAgain.claim(10);
	rebornAgain.endRun();
	check("the redelivered event has the same id", redelivered.length === 1 && redelivered[0]?.id === event.id, redelivered);
	const settled = EventStore.open(stateDir);
	check("after the ack it is not pending again", settled.pendingCount() === 0 && settled.all().length === 1, settled.status());
}

process.stdout.write(failures === 0 ? `\nALL RECOVERY TESTS PASSED (${root})\n` : `\n${failures} RECOVERY TEST(S) FAILED\n`);
process.exitCode = failures === 0 ? 0 : 1;
