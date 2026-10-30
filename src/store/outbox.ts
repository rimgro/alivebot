import * as path from "node:path";
import { appendJsonl, ensureDir, newId, readJsonl } from "../util.js";

/**
 * A local file the agent wants delivered with its message.
 *
 * `path` is always workspace-relative: a module must never be handed a host path
 * it was not already trusted with, and the durable outbox record stays portable.
 */
export interface OutgoingAttachment {
	path: string;
	/** `photo` for inlined images, `document` for a file upload. Inferred when omitted. */
	kind?: "photo" | "document";
	/** Display/upload file name; defaults to the basename of `path`. */
	name?: string;
	/** Mime type as inferred by the producer; a module may recompute it. */
	mime?: string;
	/** Size hint for early limit checks; the delivering module re-checks the real bytes. */
	size?: number;
}

/**
 * One inline quick-reply button produced by the agent.
 *
 * Exactly one of `data` (a callback action) or `url` (a link) is used. The
 * Telegram module validates the provider-specific limits; other sinks ignore
 * buttons they cannot render.
 */
export interface OutgoingButton {
	text: string;
	data?: string;
	url?: string;
}

/** Rows of inline buttons, 1–3 buttons per row. */
export type OutgoingButtonRows = OutgoingButton[][];

export interface OutgoingMessage {
	id: string;
	/**
	 * Stable idempotency key for delivery attempts.
	 *
	 * It is written once with the queue record and never changes, so a recovery
	 * retry can be recognised by a delivery handler even if the first attempt
	 * reached the sink and the process died before the outbox could mark it
	 * delivered. New messages use their `id`; old records fall back to it.
	 */
	deliveryKey?: string;
	runId: string;
	thread: string;
	text: string;
	/** Files delivered together with the text (`text` becomes the caption). */
	attachments?: OutgoingAttachment[];
	/** Inline quick-reply buttons attached to the message. */
	buttons?: OutgoingButtonRows;
	/** Explicit recipient for local managed-agent routing; thread remains a conversation id. */
	recipientAgentId?: string;
	senderId?: string;
	senderName?: string;
	ts: number;
	replyTo?: string;
	delivered?: boolean;
	deliveryError?: string;
}

/** Default age after which an undelivered queue record is abandoned instead of replayed. */
export const DEFAULT_OUTBOX_MAX_AGE_MS = 24 * 60 * 60 * 1000;
export const DEFAULT_OUTBOX_MAX_ATTEMPTS = 5;

export type OutboxLogLevel = "info" | "warn";

export interface OutboxRecoveryOptions {
	/** Deliver one queued message. Must be idempotent on `message.deliveryKey`. */
	deliver: (message: OutgoingMessage) => Promise<void>;
	/** Failed attempts allowed before a message is abandoned. Defaults to 5. */
	maxAttempts?: number;
	/** Messages older than this are abandoned instead of resurrected. Defaults to 24 h. */
	maxAgeMs?: number;
	/** Injectable clock for tests. */
	now?: number;
	/** Receives the recovery log lines (stale/abandoned/failed). */
	log?: (level: OutboxLogLevel, message: string, details?: Record<string, unknown>) => void;
}

export interface OutboxRecoveryResult {
	scanned: number;
	delivered: number;
	failed: number;
	skippedStale: number;
	skippedExhausted: number;
}

interface OutboxRecord {
	type?: string;
	messageId?: string;
	ok?: boolean;
	error?: string;
	attempt?: number;
	reason?: string;
	ts?: number;
	[key: string]: unknown;
}

interface OutboxRecordState {
	delivered: Set<string>;
	abandoned: Map<string, string>;
	attempts: Map<string, number>;
	failures: Map<string, number>;
	lastError: Map<string, string>;
}

/**
 * The agent's outbound channel of record.
 *
 * Every `send_message` tool call lands here before delivery is attempted, so the
 * full history of what the agent actually said survives transport failures and
 * restarts. A queue record preceded by an `attempt` record is the recovery
 * contract: `recoverPending()` picks up messages with no successful delivery
 * record, retries them with a bounded attempt count and abandons anything older
 * than the age limit instead of replaying ancient failures forever.
 */
export class Outbox {
	private readonly file: string;

	constructor(stateDir: string) {
		this.file = path.join(stateDir, "outbox", "messages.jsonl");
		ensureDir(path.dirname(this.file));
	}

	/** Messages the agent actually produced, newest last. */
	list(limit = 20): OutgoingMessage[] {
		const records = readJsonl<Record<string, unknown>>(this.file);
		const messages = records
			.filter((r) => r.type === "message")
			.map((r) => r as unknown as OutgoingMessage);
		return messages.slice(-limit);
	}

	async send(
		input: {
			runId: string;
			thread: string;
			text: string;
			replyTo?: string;
			recipientAgentId?: string;
			senderId?: string;
			senderName?: string;
			attachments?: OutgoingAttachment[];
			buttons?: OutgoingButtonRows;
		},
		deliver: (message: OutgoingMessage) => Promise<void>,
	): Promise<OutgoingMessage> {
		const id = newId("msg");
		const message: OutgoingMessage = {
			id,
			deliveryKey: id,
			runId: input.runId,
			thread: input.thread,
			text: input.text,
			...(input.attachments && input.attachments.length > 0 ? { attachments: input.attachments } : {}),
			...(input.buttons && input.buttons.length > 0 ? { buttons: input.buttons } : {}),
			recipientAgentId: input.recipientAgentId,
			senderId: input.senderId,
			senderName: input.senderName,
			ts: Date.now(),
			replyTo: input.replyTo,
		};
		appendJsonl(this.file, { type: "message", ...message });
		try {
			this.recordAttempt(message.id);
			await deliver(message);
			message.delivered = true;
			appendJsonl(this.file, { type: "delivery", messageId: message.id, ok: true, ts: Date.now() });
		} catch (err) {
			message.delivered = false;
			message.deliveryError = err instanceof Error ? err.message : String(err);
			appendJsonl(this.file, {
				type: "delivery",
				messageId: message.id,
				ok: false,
				error: message.deliveryError,
				ts: Date.now(),
			});
			throw err;
		}
		return message;
	}

	/**
	 * Retry messages that were queued but never marked delivered.
	 *
	 * Called once on startup after modules/transports are up. Delivery handlers
	 * must dedupe on `deliveryKey` (or `id`) because a crash can happen after the
	 * sink accepted the message but before the success record was appended.
	 */
	async recoverPending(options: OutboxRecoveryOptions): Promise<OutboxRecoveryResult> {
		const now = options.now ?? Date.now();
		const maxAttempts = Math.max(1, Math.floor(options.maxAttempts ?? DEFAULT_OUTBOX_MAX_ATTEMPTS));
		const maxAgeMs = Math.max(0, options.maxAgeMs ?? DEFAULT_OUTBOX_MAX_AGE_MS);
		const records = readJsonl<OutboxRecord>(this.file);
		const state = summarizeRecords(records);
		const messages = records.filter((record) => record.type === "message") as unknown as OutgoingMessage[];
		const result: OutboxRecoveryResult = {
			scanned: messages.length,
			delivered: 0,
			failed: 0,
			skippedStale: 0,
			skippedExhausted: 0,
		};
		for (const message of messages) {
			if (!message?.id || state.delivered.has(message.id) || state.abandoned.has(message.id)) continue;
			const attempts = Math.max(state.attempts.get(message.id) ?? 0, state.failures.get(message.id) ?? 0);
			const ageMs = Math.max(0, now - (typeof message.ts === "number" ? message.ts : now));
			if (ageMs > maxAgeMs) {
				this.abandon(message.id, "stale", now);
				result.skippedStale += 1;
				options.log?.("warn", "outbox: skipping stale message", {
					messageId: message.id,
					thread: message.thread,
					ageMs,
					maxAgeMs,
				});
				continue;
			}
			if (attempts >= maxAttempts) {
				this.abandon(message.id, "attempts", now);
				result.skippedExhausted += 1;
				options.log?.("warn", "outbox: abandoning message after too many delivery attempts", {
					messageId: message.id,
					thread: message.thread,
					attempts,
					maxAttempts,
					lastError: state.lastError.get(message.id),
				});
				continue;
			}
			this.recordAttempt(message.id, attempts + 1, now);
			try {
				await options.deliver({ ...message, deliveryKey: message.deliveryKey ?? message.id, delivered: false });
				appendJsonl(this.file, { type: "delivery", messageId: message.id, ok: true, recovered: true, ts: Date.now() });
				result.delivered += 1;
				options.log?.("info", "outbox: recovered queued message", {
					messageId: message.id,
					thread: message.thread,
					attempt: attempts + 1,
				});
			} catch (err) {
				const error = err instanceof Error ? err.message : String(err);
				appendJsonl(this.file, {
					type: "delivery",
					messageId: message.id,
					ok: false,
					error,
					recovered: true,
					ts: Date.now(),
				});
				result.failed += 1;
				options.log?.("warn", "outbox: recovery delivery failed", {
					messageId: message.id,
					thread: message.thread,
					attempt: attempts + 1,
					error,
				});
			}
		}
		return result;
	}

	private recordAttempt(messageId: string, attempt?: number, now = Date.now()): void {
		const next = attempt ?? (summarizeRecords(readJsonl<OutboxRecord>(this.file)).attempts.get(messageId) ?? 0) + 1;
		appendJsonl(this.file, { type: "attempt", messageId, attempt: next, ts: now });
	}

	private abandon(messageId: string, reason: string, now: number): void {
		appendJsonl(this.file, { type: "abandoned", messageId, reason, ts: now });
	}
}

function summarizeRecords(records: OutboxRecord[]): OutboxRecordState {
	const state: OutboxRecordState = {
		delivered: new Set(),
		abandoned: new Map(),
		attempts: new Map(),
		failures: new Map(),
		lastError: new Map(),
	};
	for (const record of records) {
		const id = typeof record.messageId === "string" ? record.messageId : undefined;
		if (!id) continue;
		if (record.type === "delivery") {
			if (record.ok === true) state.delivered.add(id);
			else {
				state.failures.set(id, (state.failures.get(id) ?? 0) + 1);
				if (typeof record.error === "string") state.lastError.set(id, record.error);
			}
		} else if (record.type === "attempt") {
			const attempt = typeof record.attempt === "number" ? record.attempt : 0;
			state.attempts.set(id, Math.max(state.attempts.get(id) ?? 0, attempt));
		} else if (record.type === "abandoned") {
			state.abandoned.set(id, typeof record.reason === "string" ? record.reason : "unknown");
		}
	}
	return state;
}
