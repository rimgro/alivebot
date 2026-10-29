import * as path from "node:path";
import { ensureDir, newId, oneLine, readJson, writeJsonAtomic } from "../util.js";
import type { EventStore } from "./events.js";

export interface Reminder {
	id: string;
	text: string;
	dueAt: number;
	createdAt: number;
	thread?: string;
	firedAt?: number;
	cancelledAt?: number;
}

/**
 * Turn due reminders into durable inbox events exactly once.
 *
 * Events are appended before `firedAt` is persisted and carry a stable
 * `reminder:<id>` dedupe key, so a crash in either half of the operation is
 * recoverable: before the append the reminder fires again; after the append the
 * duplicate append returns the existing event. Overdue reminders (due while the
 * process was down) are ordinary due reminders and fire once on startup.
 */
export function dispatchDueReminders(
	reminders: ReminderStore,
	events: Pick<EventStore, "append">,
	now: number,
	onFire?: (reminder: Reminder) => void,
): Reminder[] {
	const due = reminders.due(now);
	if (due.length === 0) return [];
	for (const reminder of due) {
		events.append({
			kind: "reminder",
			source: "scheduler",
			priority: "normal",
			title: oneLine(reminder.text, 80),
			text: reminder.text,
			thread: reminder.thread,
			expectsReply: Boolean(reminder.thread),
			dedupeKey: `reminder:${reminder.id}`,
			meta: { reminderId: reminder.id, dueAt: reminder.dueAt, createdAt: reminder.createdAt },
		});
		onFire?.(reminder);
	}
	reminders.markFired(due.map((reminder) => reminder.id), now);
	return due;
}

/**
 * Reminders are the agent's own sense of future time. They live in a small JSON
 * file (not in the transcript) so they survive compaction and restarts.
 *
 * The CLI may add reminders while the runtime is running, so every read goes to
 * disk. The file is tiny; correctness beats caching here.
 */
export class ReminderStore {
	private readonly file: string;

	constructor(stateDir: string) {
		this.file = path.join(stateDir, "reminders.json");
		ensureDir(stateDir);
		if (!readJson<Reminder[] | null>(this.file, null)) writeJsonAtomic(this.file, []);
	}

	private load(): Reminder[] {
		return readJson<Reminder[]>(this.file, []);
	}

	private save(reminders: Reminder[]): void {
		writeJsonAtomic(this.file, reminders);
	}

	add(input: { text: string; dueAt: number; thread?: string }): Reminder {
		const reminder: Reminder = {
			id: newId("rem"),
			text: input.text,
			dueAt: input.dueAt,
			createdAt: Date.now(),
			thread: input.thread,
		};
		const all = this.load();
		all.push(reminder);
		this.save(all);
		return reminder;
	}

	cancel(id: string): Reminder | null {
		const all = this.load();
		const reminder = all.find((r) => r.id === id || r.id.startsWith(id));
		if (!reminder || reminder.cancelledAt || reminder.firedAt) return null;
		reminder.cancelledAt = Date.now();
		this.save(all);
		return reminder;
	}

	/** Due reminders without changing their state. */
	due(now: number): Reminder[] {
		return this.load().filter((r) => !r.firedAt && !r.cancelledAt && r.dueAt <= now);
	}

	/**
	 * Mark reminders fired after their inbox events were durably appended.
	 *
	 * The ordering matters: if the process dies between the append and this
	 * call, the reminder is still pending on restart, fires again, and the
	 * event store's durable `reminder:<id>` dedupe key drops the duplicate.
	 * Marking first would lose a reminder that crashed before its event landed.
	 */
	markFired(ids: string[], now = Date.now()): number {
		const wanted = new Set(ids);
		const all = this.load();
		let changed = 0;
		for (const reminder of all) {
			if (!wanted.has(reminder.id) || reminder.firedAt || reminder.cancelledAt) continue;
			reminder.firedAt = now;
			changed += 1;
		}
		if (changed > 0) this.save(all);
		return changed;
	}

	/** Return due reminders and mark them fired. The caller turns them into inbox events. */
	fireDue(now: number): Reminder[] {
		const due = this.due(now);
		if (due.length === 0) return [];
		this.markFired(due.map((reminder) => reminder.id), now);
		return due;
	}

	list(options: { includeInactive?: boolean } = {}): Reminder[] {
		const all = this.load();
		const filtered = options.includeInactive
			? all
			: all.filter((r) => !r.firedAt && !r.cancelledAt);
		return filtered.sort((a, b) => a.dueAt - b.dueAt);
	}

	earliestPendingAt(): number | undefined {
		const pending = this.list();
		return pending.length > 0 ? pending[0]!.dueAt : undefined;
	}

	/** Next scheduled reminder text, used in the wake prompt header. */
	upcoming(withinMs: number, now: number): Reminder[] {
		return this.list().filter((r) => r.dueAt <= now + withinMs);
	}
}
