import * as path from "node:path";
import { appendJsonl, ensureDir, newId, readJsonl } from "../util.js";

export interface OutgoingMessage {
	id: string;
	runId: string;
	thread: string;
	text: string;
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
		input: { runId: string; thread: string; text: string; replyTo?: string },
		deliver: (message: OutgoingMessage) => Promise<void>,
	): Promise<OutgoingMessage> {
		const message: OutgoingMessage = {
			id: newId("msg"),
			runId: input.runId,
			thread: input.thread,
			text: input.text,
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
