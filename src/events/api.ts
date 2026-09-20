import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import type { AliveConfig, Paths } from "../config.js";
import type { Logger } from "../log.js";
import type { AliveEvent, EventKind, EventPriority, NewEvent } from "../store/events.js";
import type { HistoryStore } from "../store/history.js";
import type { OutgoingMessage } from "../store/outbox.js";

/**
 * The alive Events API.
 *
 * A **module** is the unit of extensibility: it turns some outside world
 * (Telegram, Discord, Grafana, a webhook, your own service) into the three
 * things the runtime understands:
 *
 *   1. **inbound events** — pushed into the durable inbox via `ctx.emit(...)`,
 *   2. **outbound delivery** — the agent's `send_message` calls routed back to
 *      the outside world via `ctx.onOutbound(...)`,
 *   3. **agent tools** — optional extra tools contributed via `ctx.registerTools`.
 *
 * Modules also share one durable conversation history (`ctx.history`), which is
 * how "read the chat history" works uniformly across integrations, and may
 * contribute fields to `alive status`.
 *
 * Built-in modules live in `src/modules/`; user modules are loaded from disk by
 * path (see `alive.config.json` → `modules.external`). The contract below is the
 * whole API: anything a module needs is here, and nothing here is Telegram- or
 * Discord-specific.
 */

/** A human message coming in from an outside world. */
export interface UserMessageInput {
	text: string;
	/** Canonical thread id, e.g. `telegram:12345`, `discord:guild/channel`. */
	thread: string;
	title?: string;
	/** Display name of the sender. */
	author?: string;
	/** Provider-side user id of the sender. */
	authorId?: string;
	priority?: EventPriority;
	/** Defaults to true: an inbound human message is normally waiting for an answer. */
	expectsReply?: boolean;
	payload?: unknown;
	meta?: Record<string, unknown>;
	/** Stable key so a redelivered provider update cannot double-spawn an event. */
	dedupeKey?: string;
	ts?: number;
}

/** A machine event (alert, CI result, metric, deploy, …) for the agent to react to. */
export interface ModuleEventInput {
	text: string;
	title?: string;
	kind?: EventKind;
	priority?: EventPriority;
	/** Canonical thread to reply on, if this event belongs to a conversation. */
	thread?: string;
	/** Defaults to false: machine events do not oblige the agent to answer. */
	expectsReply?: boolean;
	payload?: unknown;
	meta?: Record<string, unknown>;
	dedupeKey?: string;
	ts?: number;
}

/**
 * Receives the agent's `send_message` output. Register with `ctx.onOutbound`.
 * Handlers may be async; a rejection counts as a delivery failure for the
 * message when the owning module claims it (see `AliveModule.handles`).
 */
export type OutboundHandler = (message: OutgoingMessage) => void | Promise<void>;

/** Everything a module gets when it starts. */
export interface ModuleContext {
	/** Module name from config, e.g. `telegram`. */
	readonly name: string;
	readonly config: AliveConfig;
	readonly paths: Paths;
	/** Scoped logger (`alive:module:telegram`). */
	readonly log: Logger;
	/** Aborted when the runtime is stopping; long-running loops must respect it. */
	readonly signal: AbortSignal;

	/** Push any event into the durable inbox. Idempotent when `dedupeKey` is set. */
	emit(event: NewEvent): AliveEvent;
	/** Push an inbound human message (fills in kind/source/title defaults). */
	userMessage(input: UserMessageInput): AliveEvent;
	/** Push a machine/observability event. */
	event(input: ModuleEventInput): AliveEvent;

	/** Subscribe to the agent's outbound messages. Returns an unsubscribe function. */
	onOutbound(handler: OutboundHandler): () => void;

	/** Shared durable conversation history for every module. */
	readonly history: HistoryStore;

	/**
	 * Contribute tools to the agent. Call during `start()`: the agent session is
	 * built once, right after modules start.
	 */
	registerTools(tools: ToolDefinition[]): void;

	/** Contribute a read-only snapshot to `GET /status` and the `status` tool. */
	contributeStatus(snapshot: () => Record<string, unknown>): void;

	/** Current runtime status (pid, run, pending events, …). */
	runtimeStatus(): Record<string, unknown>;

	/** Module-private durable directory (`<stateDir>/modules/<name>`), created on demand. */
	moduleDir(...segments: string[]): string;
}

/**
 * A pluggable integration.
 *
 * Lifecycle: `start(ctx)` is called once at runtime boot, before the agent
 * session is built; `stop()` is called once on shutdown. A module is expected to
 * be resilient: it must not throw out of its background loops after `start()`
 * resolves, and it must stop cleanly when `ctx.signal` aborts.
 */
export interface AliveModule {
	readonly name: string;
	/** Informational: `chat` modules talk to humans, `events` modules report machines. */
	readonly kind?: "chat" | "events";

	/**
	 * Outbound routing predicate. When defined, this module only receives
	 * `send_message` calls it claims, and it becomes responsible for their
	 * delivery: if it claims a message and fails to send it, `send_message`
	 * reports a delivery error. When undefined, the module receives every
	 * message (a broadcast listener). At least one module should claim each chat
	 * thread, otherwise outbound messages fall back to the transports.
	 */
	handles?(message: OutgoingMessage): boolean;

	start(ctx: ModuleContext): Promise<void>;
	stop(): Promise<void>;

	/** Snapshot merged into `alive status` / `GET /status`. */
	status?(): Record<string, unknown>;

	/** Tools contributed to the agent (may also be registered via `ctx.registerTools`). */
	tools?(ctx: ModuleContext): ToolDefinition[];
}

/** Options a module factory receives when it is constructed from config. */
export interface ModuleFactoryOptions {
	config: AliveConfig;
	log: Logger;
	/** Raw JSON from `modules.external[].options`, or a built-in's config block. */
	options: Record<string, unknown>;
}

/** Factory shape for user modules loaded from disk. */
export type AliveModuleFactory = (options: ModuleFactoryOptions) => AliveModule | Promise<AliveModule>;

export type { AliveEvent, NewEvent, OutgoingMessage, HistoryStore };
