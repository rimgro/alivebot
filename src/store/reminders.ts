import * as path from "node:path";
import { ensureDir, newId, readJson, writeJsonAtomic } from "../util.js";

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

	/** Return due reminders and mark them fired. The caller turns them into inbox events. */
	fireDue(now: number): Reminder[] {
		const all = this.load();
		const due = all.filter((r) => !r.firedAt && !r.cancelledAt && r.dueAt <= now);
		if (due.length === 0) return [];
		for (const reminder of due) reminder.firedAt = now;
		this.save(all);
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
