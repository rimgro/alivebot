import * as path from "node:path";
import { iso, readJson, writeJsonAtomic } from "../../util.js";

export interface TelegramBotIdentity {
	id: number;
	username?: string;
	firstName: string;
	/** Last successful getMe. Older state files may not have it. */
	verifiedAt?: number;
	/** Set when a later getMe failed: the stored identity is no longer trustworthy. */
	stale?: boolean;
	staleAt?: number;
}

/** A 409 that was not (or not only) caused by a webhook. */
export interface TelegramPollerConflict {
	since: number;
	message: string;
}

/**
 * A provider quota stop for voice transcription.
 *
 * The provider answered with a daily-quota error once, so every further voice
 * note that day is ingested without a transcript instead of hammering the API
 * (and burning whatever quota is left) — incident #117.
 */
export interface TelegramTranscriptionQuota {
	/** UTC day (YYYY-MM-DD) the marker belongs to; a new day clears it implicitly. */
	day: string;
	/** When the quota error was seen. */
	at: number;
	/**
	 * Signature of the transcription configuration that produced this stop.
	 * Changing the key/model/limits makes the marker stale, so transcription is
	 * attempted again with the new settings.
	 */
	signature: string;
	/** Classified reason (never the key or a provider body). */
	reason: string;
}

/**
 * A provider-requested pause for voice transcription (#136).
 *
 * Any 429 starts it — not only the daily-quota one — for the whole process, so
 * a replayed batch, a restarted worker or the next voice note cannot spend a
 * request while the limit is still live.
 */
export interface TelegramTranscriptionCooldown {
	/** Epoch ms when the provider may be asked again. */
	until: number;
	/** When the current pause started. */
	at: number;
	/** Classified reason (never the key or a provider body). */
	reason: string;
	/** Signature of the transcription configuration that recorded the pause. */
	signature: string;
	/** What started it: any rate limit or an exhausted daily quota. */
	kind: "rate_limit" | "daily_quota";
}

export interface TelegramState {
	/** Next getUpdates offset: last processed update_id + 1. */
	offset: number;
	/**
	 * SHA-256 of the configured bot token (#139). Only the hash is stored; a
	 * change means the state may belong to another bot, so offset/identity reset.
	 */
	tokenHash?: string;
	me?: TelegramBotIdentity;
	/** Last known duplicate-poller conflict. Cleared by the next successful poll. */
	pollerConflict?: TelegramPollerConflict;
	/** Set while voice transcription is skipped after a provider daily-quota error. */
	transcriptionQuota?: TelegramTranscriptionQuota;
	/** Set while voice transcription is paused by a provider rate limit (#136). */
	transcriptionCooldown?: TelegramTranscriptionCooldown;
	lastPollAt?: number;
	lastUpdateAt?: number;
	lastError?: string;
	polls: number;
	updates: number;
	inbound: number;
	outbound: number;
	errors: number;
}

/** Status wording shared by `alive status`, `GET /status` and the status tool. */
export interface TelegramIdentityView {
	status: "verified" | "stale" | "unknown";
	id?: number;
	username?: string;
	name?: string;
	verifiedAt?: number;
	staleAt?: number;
	text: string;
}

export function telegramIdentityView(me: TelegramBotIdentity | undefined): TelegramIdentityView {
	if (!me) {
		return { status: "unknown", text: "identity unknown (not verified yet)" };
	}
	const bot = `bot id ${me.id}${me.username ? `, @${me.username}` : ""}`;
	if (me.stale) {
		const verified = me.verifiedAt === undefined ? "unknown" : iso(me.verifiedAt);
		return {
			status: "stale",
			id: me.id,
			username: me.username,
			name: me.firstName,
			verifiedAt: me.verifiedAt,
			staleAt: me.staleAt,
			text: `identity unknown (last verified ${verified}); last known ${bot}`,
		};
	}
	return {
		status: "verified",
		id: me.id,
		username: me.username,
		name: me.firstName,
		verifiedAt: me.verifiedAt,
		text: `${bot} (verified${me.verifiedAt === undefined ? "" : ` ${iso(me.verifiedAt)}`})`,
	};
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

export type TelegramDeliveryState = "sending" | "sent" | "failed";

export interface TelegramDeliveryEntry {
	/** Stable idempotency key: outbox `deliveryKey` + part index. */
	key: string;
	state: TelegramDeliveryState;
	ts: number;
	chatId: string;
	/** Telegram `message_id` once the part was accepted. */
	messageId?: number;
	error?: string;
}

const DELIVERY_LEDGER_LIMIT = 2_000;
const DELIVERY_LEDGER_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;

/**
 * Durable per-part send ledger for outbound Telegram messages.
 *
 * The Bot API has no idempotency token, so the module provides one locally: a
 * part is marked `sending` before the API call. If the process dies before the
 * `sent` mark, recovery treats the part as possibly accepted and does not send
 * it again. A part rejected by the API (or never reached Telegram because of a
 * network error) is marked `failed` and may be retried safely.
 *
 * The ledger is keyed by the outbox `deliveryKey` plus part index and is pruned
 * by age and size; outbox recovery only looks back 24 h by default.
 */
export class TelegramDeliveryLedger {
	private readonly file: string;
	private readonly entries = new Map<string, TelegramDeliveryEntry>();

	constructor(dir: string) {
		this.file = path.join(dir, "outbound-delivery.json");
		const raw = readJson<{ entries?: TelegramDeliveryEntry[] } | null>(this.file, null);
		for (const entry of raw?.entries ?? []) {
			if (entry && typeof entry.key === "string" && typeof entry.ts === "number") this.entries.set(entry.key, entry);
		}
		this.prune();
	}

	/** A part that must not be sent again (it may already exist in the chat). */
	shouldSkip(key: string): TelegramDeliveryEntry | undefined {
		const entry = this.entries.get(key);
		return entry && (entry.state === "sent" || entry.state === "sending") ? entry : undefined;
	}

	markSending(key: string, chatId: string): void {
		this.put({ key, state: "sending", ts: Date.now(), chatId });
	}

	markSent(key: string, chatId: string, messageId: number): void {
		this.put({ key, state: "sent", ts: Date.now(), chatId, messageId });
	}

	markFailed(key: string, chatId: string, error: string): void {
		this.put({ key, state: "failed", ts: Date.now(), chatId, error });
	}

	private put(entry: TelegramDeliveryEntry): void {
		this.entries.set(entry.key, entry);
		this.prune();
		writeJsonAtomic(this.file, { entries: [...this.entries.values()] });
	}

	private prune(): void {
		const cutoff = Date.now() - DELIVERY_LEDGER_MAX_AGE_MS;
		for (const [key, entry] of this.entries) {
			if (entry.ts < cutoff) this.entries.delete(key);
		}
		while (this.entries.size > DELIVERY_LEDGER_LIMIT) {
			const oldest = [...this.entries.entries()].sort((a, b) => a[1].ts - b[1].ts)[0];
			if (!oldest) break;
			this.entries.delete(oldest[0]);
		}
	}
}
