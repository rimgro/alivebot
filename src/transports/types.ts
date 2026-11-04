import type { Logger } from "../log.js";
import type { AliveEvent, NewEvent } from "../store/events.js";
import type { OutgoingMessage } from "../store/outbox.js";

export interface TransportContext {
	/** Push an inbound event into the durable inbox. Safe to call from any process. */
	ingest: (event: NewEvent) => AliveEvent;
	status: () => Record<string, unknown>;
	outbox: (limit: number) => OutgoingMessage[];
	log: Logger;
}

/**
 * A transport is one way the outside world reaches the agent and/or receives
 * what the agent says. The runtime does not care which transports are attached:
 * console today, HTTP webhook / Slack / Telegram tomorrow.
 */
export interface ChatTransport {
	readonly name: string;
	/**
	 * Does `send()` actually hand the message to a human or external sink?
	 *
	 * Defaults to true. A placeholder such as `NullTransport` sets this to false
	 * so the module host can tell "accepted without error" apart from "delivered";
	 * otherwise an unclaimed `send_message` would be recorded as `ok:true` while
	 * nobody received it.
	 */
	readonly delivers?: boolean;
	start(ctx: TransportContext): Promise<void>;
	send(message: OutgoingMessage): Promise<void>;
	stop(): Promise<void>;
}
