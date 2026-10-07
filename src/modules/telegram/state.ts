import * as path from "node:path";
import { readJson, writeJsonAtomic } from "../../util.js";

export interface TelegramState {
	/** Next getUpdates offset: last processed update_id + 1. */
	offset: number;
	me?: { id: number; username?: string; firstName: string };
	lastPollAt?: number;
	lastUpdateAt?: number;
	lastError?: string;
	polls: number;
	updates: number;
	inbound: number;
	outbound: number;
	errors: number;
}

const EMPTY: TelegramState = { offset: 0, polls: 0, updates: 0, inbound: 0, outbound: 0, errors: 0 };

/**
 * Module-private durable state.
 *
 * The only thing here that is genuinely load-bearing is `offset`: it is what
 * makes long polling resume after a restart without replaying old updates
 * (Telegram keeps up to 24h of them). Counters are for `alive status`.
 *
 * Writes are atomic because the runtime may also be read by the CLI while the
 * agent runs.
 */
export class TelegramAllowlistStore {
	private readonly file: string;

	constructor(dir: string) {
		this.file = path.join(dir, "allowlist.json");
	}

	list(): string[] {
		const value = readJson<{ userIds?: unknown }>(this.file, {});
		return Array.isArray(value.userIds) ? [...new Set(value.userIds.map(String).filter(isTelegramId))] : [];
	}

	add(userId: string): boolean {
		if (!isTelegramId(userId)) throw new Error(`invalid Telegram user id: ${userId}`);
		const ids = this.list();
		if (ids.includes(userId)) return false;
		writeJsonAtomic(this.file, { userIds: [...ids, userId] });
		return true;
	}

	remove(userId: string): boolean {
		const ids = this.list();
		if (!ids.includes(userId)) return false;
		writeJsonAtomic(this.file, { userIds: ids.filter((id) => id !== userId) });
		return true;
	}
}

function isTelegramId(value: string): boolean {
	return /^\d+$/.test(value);
}

export class TelegramStateStore {
	private readonly file: string;

	constructor(private readonly dir: string) {
		this.file = path.join(dir, "state.json");
	}

	load(): TelegramState {
		const value = readJson<Partial<TelegramState>>(this.file, {});
		return { ...EMPTY, ...value };
	}

	patch(patch: Partial<TelegramState>): TelegramState {
		const next = { ...this.load(), ...patch };
		writeJsonAtomic(this.file, next);
		return next;
	}

	reset(): void {
		writeJsonAtomic(this.file, EMPTY);
	}
}
