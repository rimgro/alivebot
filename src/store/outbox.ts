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

export interface OutgoingMessage {
	id: string;
	runId: string;
	thread: string;
	text: string;
	/** Files delivered together with the text (`text` becomes the caption). */
	attachments?: OutgoingAttachment[];
	/** Explicit recipient for local managed-agent routing; thread remains a conversation id. */
	recipientAgentId?: string;
	senderId?: string;
	senderName?: string;
	ts: number;
	replyTo?: string;
	delivered?: boolean;
	deliveryError?: string;
}

/**
 * The agent's outbound channel of record.
 *
 * Every `send_message` tool call lands here before delivery is attempted, so the
 * full history of what the agent actually said survives transport failures and
 * restarts.
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
		},
		deliver: (message: OutgoingMessage) => Promise<void>,
	): Promise<OutgoingMessage> {
		const message: OutgoingMessage = {
			id: newId("msg"),
			runId: input.runId,
			thread: input.thread,
			text: input.text,
			...(input.attachments && input.attachments.length > 0 ? { attachments: input.attachments } : {}),
			recipientAgentId: input.recipientAgentId,
			senderId: input.senderId,
			senderName: input.senderName,
			ts: Date.now(),
			replyTo: input.replyTo,
		};
		appendJsonl(this.file, { type: "message", ...message });
		try {
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
}
