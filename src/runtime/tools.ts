import { Type } from "typebox";
import { defineTool, type AgentToolResult, type ToolDefinition } from "@earendil-works/pi-coding-agent";
import type { LoadedConfig } from "../config.js";
import { EventStore, type AliveEvent, type EventKind, type EventPriority } from "../store/events.js";
import type { Journal } from "../store/journal.js";
import type { HistoryQuery, HistoryRecord, HistoryStore } from "../store/history.js";
import type { NoteStore } from "../store/notes.js";
import type { Outbox, OutgoingMessage } from "../store/outbox.js";
import type { NotifyMode, PolicyStore } from "../store/policy.js";
import type { ReminderStore } from "../store/reminders.js";
import type { ThreadStore } from "../store/threads.js";
import type { Logger } from "../log.js";
import { formatDuration, iso, parseTimeSpec, parseTimestamp, sleep, truncate } from "../util.js";
import { renderIdleEvents, renderSleepForced, renderSleepOffer } from "./prompt.js";

/**
 * Mutable per-run bookkeeping shared between the run runner and the tools.
 *
 * A "run" is one continuous stretch of agent existence: from the prompt that
 * wakes it until it calls `sleep`, stalls, or is stopped. Inside a run the agent
 * may call `idle` many times; every batch of events lands here so the run record
 * can describe the whole episode.
 */
export interface RunHandle {
	id: string;
	index: number;
	startedAt: number;
	/** Every event delivered to this run (opening prompt, idle returns, interrupts). */
	events: AliveEvent[];
	outbound: Array<{ thread: string; text: string; delivered: boolean }>;
	reminderIds: string[];
	noteKeys: string[];
	journalEntries: number;
	idleReturns: number;
	interruptDeliveries: number;
	nudges: number;
	turns: number;
	promptChars: number;
	/** Threads that produced inbound messages during this run. */
	inboundThreads: Set<string>;
	/** True while the agent is blocked inside the idle tool. */
	idling: boolean;
	idleStartedAt?: number;
	idleMs: number;
	activeSince?: number;
	activeMs: number;
	/** Set when the runtime offered a sleep and the agent has not answered yet. */
	sleepOffered: boolean;
	sleepOfferedAfterMs?: number;
	sleepRequested: boolean;
	sleepForced: boolean;
	sleepSummary?: string;
	lastStopReason?: string;
	lastError?: string;
}

export interface ToolDeps {
	config: LoadedConfig;
	store: EventStore;
	reminders: ReminderStore;
	notes: NoteStore;
	journal: Journal;
	threads: ThreadStore;
	outbox: Outbox;
	policy: PolicyStore;
	history: HistoryStore;
	/** Tools contributed by event modules (Telegram, Grafana, user modules). */
	moduleTools: ToolDefinition[];
	deliver: (message: OutgoingMessage) => Promise<void>;
	getRun: () => RunHandle | undefined;
	runtimeStatus: () => Record<string, unknown>;
	isStopping: () => boolean;
	log: Logger;
}

export const ALIVE_TOOL_NAMES = [
	"send_message",
	"idle",
	"sleep",
	"notifications",
	"remind",
	"list_reminders",
	"cancel_reminder",
	"note",
	"journal",
	"history",
	"close_thread",
	"status",
] as const;

type ToolResult = AgentToolResult<Record<string, unknown>>;

function ok(text: string, details: Record<string, unknown> = {}, terminate = false): ToolResult {
	return { content: [{ type: "text", text }], details, ...(terminate ? { terminate: true } : {}) };
}

export function createAliveTools(deps: ToolDeps): ToolDefinition[] {
	const log = deps.log.child("tools");

	const sendMessage = defineTool({
		name: "send_message",
		label: "Send message",
		description:
			"Send a message to a human. This is the ONLY way your words reach anyone: your plain assistant text is private thought. " +
			"Use the thread id from the incoming event. Returns a message id when delivered.",
		parameters: Type.Object({
			text: Type.String({ description: "Message body. Write like a person: short, concrete, no process narration." }),
			thread: Type.Optional(
				Type.String({ description: "Conversation / person to send to. Defaults to the thread of the newest event." }),
			),
			reply_to: Type.Optional(Type.String({ description: "Event id or message id this replies to, if any." })),
		}),
		execute: async (_toolCallId, params): Promise<ToolResult> => {
			const run = requireRun(deps, "send_message");
			if (!params.text.trim()) throw new Error("send_message requires non-empty text");
			const thread = params.thread ?? defaultThread(run) ?? "console";
			const message = await deps.outbox.send(
				{ runId: run.id, thread, text: params.text, replyTo: params.reply_to },
				deps.deliver,
			);
			run.outbound.push({ thread, text: params.text, delivered: message.delivered ?? false });
			deps.threads.recordOutbound(thread, message.ts);
			log.info("outbound message", { thread, chars: params.text.length, messageId: message.id });
			return ok(`Delivered to ${thread} (message ${message.id}).`, {
				messageId: message.id,
				thread,
				delivered: message.delivered ?? false,
			});
		},
	});

	/**
	 * The heart of the continuous cycle. `idle` blocks until the world produces
	 * an event, then returns that event as the tool result. It also hands the
	 * agent the periodic choice between waiting (context preserved) and sleeping
	 * (context reset after memory is written).
	 */
	const idle = defineTool({
		name: "idle",
		label: "Idle (wait for events)",
		description:
			"Stop working and wait. Blocks until an event arrives (message, reminder, notification) and returns it as your output. " +
			"Call this whenever you have nothing left to do — it is the only correct way to end your turn. " +
			"Set important=true when you are waiting on something you cannot miss, so you are not offered a sleep. " +
			"Set until=<ISO> to be returned to at a deadline.",
		executionMode: "sequential",
		parameters: Type.Object({
			reason: Type.String({ description: "Why you are going idle, e.g. 'waiting for CI on PR #12'." }),
			important: Type.Optional(
				Type.Boolean({ description: "Pin this wait: never be offered a sleep while waiting for this." }),
			),
			until: Type.Optional(Type.String({ description: "Return to you at this ISO timestamp even if nothing arrives." })),
			max_seconds: Type.Optional(Type.Number({ description: "Hard cap on this idle; return with a notice after N seconds." })),
		}),
		execute: async (_toolCallId, params, signal): Promise<ToolResult> => {
			const run = requireRun(deps, "idle");
			// Calling idle means the previous batch is done. Acknowledge it so a
			// crash only ever redelivers the batch still in flight, not the run.
			deps.store.ack();
			const pinned = params.important === true;
			const sleepAfterMs = pinned ? Number.POSITIVE_INFINITY : deps.config.config.loop.sleepAfterMs;
			const until = params.until ? parseTimestamp(params.until) : undefined;
			const maxMs = params.max_seconds !== undefined ? Math.max(1, params.max_seconds) * 1000 : undefined;

			// Returning to idle after a sleep offer without pinning the wait is
			// consent to sleep.
			if (run.sleepOffered && !pinned) {
				deps.journal.append("[sleep] forced after a long idle without a summary; context was reset");
				run.journalEntries += 1;
				run.sleepRequested = true;
				run.sleepForced = true;
				return ok(renderSleepForced(run.sleepOfferedAfterMs ?? 0), { sleeping: true, forced: true }, true);
			}

			const startedAt = Date.now();
			run.idling = true;
			run.idleStartedAt = startedAt;
			run.activeMs += Math.max(0, startedAt - (run.activeSince ?? startedAt));
			run.activeSince = undefined;
			log.info("idle", { reason: params.reason, pinned, until: until ? iso(until) : undefined });

			try {
				while (true) {
					if (signal?.aborted || deps.isStopping()) {
						return ok("idle was interrupted because the runtime is stopping.", { aborted: true }, true);
					}
					// Claim the pending batch and drop muted events (the cursor still
					// advances past them, so they are never redelivered).
					let claimed = deps.store.claim(deps.config.config.loop.maxEventsPerIdle);
					let events = claimed.filter((event) => !deps.policy.shouldMute(event));
					// A batch made entirely of muted events should not stall the inbox.
					while (events.length === 0 && claimed.length === deps.config.config.loop.maxEventsPerIdle) {
						claimed = deps.store.claim(deps.config.config.loop.maxEventsPerIdle);
						if (claimed.length === 0) break;
						events = claimed.filter((event) => !deps.policy.shouldMute(event));
					}
					if (events.length > 0) {
						run.sleepOffered = false;
						run.idleReturns += 1;
						recordEvents(run, events);
						for (const event of events) {
							if (event.kind === "user_message" && event.thread) {
								deps.threads.recordInbound(event.thread, event.ts, event.expectsReply !== false);
								run.inboundThreads.add(event.thread);
							}
						}
						log.info("idle returned", { events: events.length, seqs: events.map((e) => e.seq) });
						return ok(renderIdleEvents(events), { events: events.length, seqs: events.map((e) => e.seq) });
					}
					const waited = Date.now() - startedAt;
					if (until !== undefined && Date.now() >= until) {
						return ok(`idle reached its deadline (${iso(until)}). Check what you were waiting for.`, {
							deadline: until,
						});
					}
					if (waited >= sleepAfterMs) {
						run.sleepOffered = true;
						run.sleepOfferedAfterMs = waited;
						return ok(renderSleepOffer(waited), { sleepOffered: true, waitedMs: waited });
					}
					if (maxMs !== undefined && waited >= maxMs) {
						return ok(`idle hit its ${formatDuration(maxMs)} cap. Nothing arrived.`, { capped: true });
					}
					await sleep(deps.config.config.loop.pollIntervalMs, signal);
				}
			} finally {
				const now = Date.now();
				run.idling = false;
				if (run.idleStartedAt !== undefined) run.idleMs += now - run.idleStartedAt;
				run.idleStartedAt = undefined;
				run.activeSince = now;
			}
		},
	});

	const sleepTool = defineTool({
		name: "sleep",
		label: "Sleep (reset context)",
		description:
			"End this run and reset your conversation context. Your summary is written to the journal first, so write down " +
			"everything your future self needs. You will wake again when a message, reminder or notification arrives.",
		executionMode: "sequential",
		parameters: Type.Object({
			summary: Type.String({
				description: "What your future self must know: decisions, open threads, promises, facts. Saved to the journal.",
			}),
			note_key: Type.Optional(Type.String({ description: "Optional short note key to set before sleeping." })),
			note_value: Type.Optional(Type.String({ description: "Value for note_key." })),
		}),
		execute: async (_toolCallId, params): Promise<ToolResult> => {
			const run = requireRun(deps, "sleep");
			const summary = params.summary.trim();
			if (summary) {
				deps.journal.append(`[sleep] ${summary}`);
				run.journalEntries += 1;
			}
			if (params.note_key && params.note_value !== undefined) {
				deps.notes.set(params.note_key, params.note_value);
				run.noteKeys.push(params.note_key);
			}
			deps.store.ack();
			run.sleepRequested = true;
			run.sleepForced = false;
			run.sleepSummary = summary;
			log.info("agent chose to sleep", { chars: summary.length });
			return ok("Sleeping now. Context will be reset; journal, notes and reminders survive.", { sleeping: true }, true);
		},
	});

	const notifications = defineTool({
		name: "notifications",
		label: "Notification policy",
		description:
			"Read and edit when the world may interrupt you while you are working (not idle). " +
			"`interrupt` steers the event in immediately, `queue` waits for your next idle, `mute` never shows it. " +
			"The most specific matching rule wins. Example: add {mode:'interrupt', thread:'alice'} to always hear from Alice.",
		parameters: Type.Object({
			action: Type.Union([
				Type.Literal("list"),
				Type.Literal("add"),
				Type.Literal("remove"),
				Type.Literal("default"),
				Type.Literal("reset"),
			]),
			id: Type.Optional(Type.String({ description: "Rule id (prefix ok) for remove." })),
			mode: Type.Optional(
				Type.Union([Type.Literal("interrupt"), Type.Literal("queue"), Type.Literal("mute")], {
					description: "Mode for add/default.",
				}),
			),
			thread: Type.Optional(Type.String({ description: "Match events from this conversation." })),
			source: Type.Optional(Type.String({ description: "Match events from this source (cli, http, scheduler, ...)." })),
			kind: Type.Optional(
				Type.Union([
					Type.Literal("user_message"),
					Type.Literal("reminder"),
					Type.Literal("observability"),
					Type.Literal("heartbeat"),
					Type.Literal("system"),
				]),
			),
			priority: Type.Optional(
				Type.Union([Type.Literal("low"), Type.Literal("normal"), Type.Literal("high"), Type.Literal("interrupt")]),
			),
			note: Type.Optional(Type.String({ description: "Why this rule exists, for your future self." })),
		}),
		execute: async (_toolCallId, params): Promise<ToolResult> => {
			switch (params.action) {
				case "list": {
					return ok(renderPolicy(deps), { policy: deps.policy.load() });
				}
				case "add": {
					if (!params.mode) throw new Error("`mode` is required for add");
					const rule = deps.policy.add({
						mode: params.mode as NotifyMode,
						thread: params.thread,
						source: params.source,
						kind: params.kind as EventKind | undefined,
						priority: params.priority as EventPriority | undefined,
						note: params.note,
					});
					log.info("notification rule added", { id: rule.id, mode: rule.mode });
					return ok(`Added rule ${rule.id}: ${rule.mode}.`, { id: rule.id });
				}
				case "remove": {
					if (!params.id) throw new Error("`id` is required for remove");
					const removed = deps.policy.remove(params.id);
					if (!removed) throw new Error(`No rule matches ${params.id}`);
					return ok(`Removed rule ${removed.id} (${removed.mode}).`, { id: removed.id });
				}
				case "default": {
					if (!params.mode) throw new Error("`mode` is required for default");
					deps.policy.setDefault(params.mode as NotifyMode);
					return ok(`Default notification mode is now ${params.mode}.`, { defaultMode: params.mode });
				}
				case "reset": {
					deps.policy.reset();
					return ok("Notification policy reset to defaults.", {});
				}
				default:
					throw new Error(`Unknown action ${String(params.action)}`);
			}
		},
	});

	const remind = defineTool({
		name: "remind",
		label: "Schedule reminder",
		description:
			"Schedule a future wake for yourself. The reminder fires even if you are asleep: it arrives at your next idle. " +
			"Use it whenever you promise to do something later or want to check back on something.",
		parameters: Type.Object({
			text: Type.String({ description: "What to do when the reminder fires." }),
			after_seconds: Type.Optional(Type.Number({ description: "Fire after this many seconds." })),
			at: Type.Optional(Type.String({ description: "Fire at this ISO timestamp." })),
			thread: Type.Optional(Type.String({ description: "Related conversation, if any." })),
		}),
		execute: async (_toolCallId, params): Promise<ToolResult> => {
			const run = requireRun(deps, "remind");
			if (!params.at && params.after_seconds === undefined) {
				throw new Error("remind requires either `at` or `after_seconds`");
			}
			const dueAt = params.at
				? parseTimestamp(params.at)
				: Date.now() + Math.max(1, params.after_seconds ?? 60) * 1000;
			const reminder = deps.reminders.add({ text: params.text, dueAt, thread: params.thread });
			run.reminderIds.push(reminder.id);
			log.info("reminder created", { id: reminder.id, dueAt });
			return ok(`Reminder ${reminder.id} scheduled for ${iso(dueAt)}.`, { id: reminder.id, dueAt });
		},
	});

	const listReminders = defineTool({
		name: "list_reminders",
		label: "List reminders",
		description: "List your pending reminders, soonest first.",
		parameters: Type.Object({}),
		execute: async (): Promise<ToolResult> => {
			const reminders = deps.reminders.list();
			if (reminders.length === 0) return ok("No pending reminders.", { count: 0 });
			const body = reminders
				.map((r) => `- ${r.id} @ ${iso(r.dueAt)}${r.thread ? ` thread=${r.thread}` : ""}: ${r.text}`)
				.join("\n");
			return ok(body, { count: reminders.length });
		},
	});

	const cancelReminder = defineTool({
		name: "cancel_reminder",
		label: "Cancel reminder",
		description: "Cancel a reminder you previously scheduled.",
		parameters: Type.Object({
			id: Type.String({ description: "Reminder id (prefix is enough)." }),
		}),
		execute: async (_toolCallId, params): Promise<ToolResult> => {
			const cancelled = deps.reminders.cancel(params.id);
			if (!cancelled) throw new Error(`No pending reminder matches ${params.id}`);
			return ok(`Cancelled ${cancelled.id} (${cancelled.text}).`, { id: cancelled.id });
		},
	});

	const note = defineTool({
		name: "note",
		label: "Notes",
		description:
			"Read and write your small persistent scratchpad. Notes are rendered into every future wake and survive sleep, so keep " +
			"them short and current (focus, open threads, tiny facts). Delete notes you no longer need.",
		parameters: Type.Object({
			action: Type.Union([Type.Literal("set"), Type.Literal("get"), Type.Literal("list"), Type.Literal("delete")]),
			key: Type.Optional(Type.String()),
			value: Type.Optional(Type.String()),
		}),
		execute: async (_toolCallId, params): Promise<ToolResult> => {
			const run = deps.getRun();
			if (params.action === "list") {
				const all = deps.notes.all();
				const keys = Object.keys(all);
				if (keys.length === 0) return ok("No notes.", { keys: [] });
				return ok(keys.map((k) => `- ${k}: ${all[k]}`).join("\n"), { keys });
			}
			if (!params.key) throw new Error("`key` is required for this action");
			if (params.action === "get") {
				const value = deps.notes.get(params.key);
				return ok(value === undefined ? `No note named "${params.key}".` : value, {
					key: params.key,
					found: value !== undefined,
				});
			}
			if (params.action === "delete") {
				const removed = deps.notes.delete(params.key);
				return ok(removed ? `Deleted note "${params.key}".` : "Note not found.", { removed });
			}
			if (params.value === undefined) throw new Error("`value` is required for set");
			deps.notes.set(params.key, params.value);
			run?.noteKeys.push(params.key);
			return ok(`Note "${params.key}" saved.`, { key: params.key });
		},
	});

	const journal = defineTool({
		name: "journal",
		label: "Journal",
		description:
			"Your durable diary. Append a short entry when something worth remembering happened (a decision, an outcome, " +
			"a fact about a person, a promise). This survives sleep and compaction, so it is how your future self remembers.",
		parameters: Type.Object({
			action: Type.Union([Type.Literal("append"), Type.Literal("tail")]),
			entry: Type.Optional(Type.String({ description: "Entry text for append." })),
			lines: Type.Optional(Type.Number({ description: "How many lines to read for tail. Default 20." })),
		}),
		execute: async (_toolCallId, params): Promise<ToolResult> => {
			if (params.action === "append") {
				if (!params.entry?.trim()) throw new Error("`entry` is required for append");
				const run = deps.getRun();
				deps.journal.append(params.entry);
				if (run) run.journalEntries += 1;
				return ok("Journal entry written.", {});
			}
			const tail = deps.journal.tail(Math.min(Math.max(1, params.lines ?? 20), 100));
			return ok(tail.length > 0 ? tail.join("\n") : "(journal is empty)", { lines: tail.length });
		},
	});

	/**
	 * Cross-module conversation history. Every event module records what it saw and
	 * what the agent sent, so this is how the agent recovers a conversation after a
	 * sleep or a restart — the transcript is reset, the history is not.
	 */
	const history = defineTool({
		name: "history",
		label: "Conversation history",
		description:
			"Read and search the durable conversation history recorded by your chat modules (Telegram, Grafana, console, …). " +
			"`threads` lists conversations; `read` shows one thread (or the newest messages across all threads); " +
			"`search` finds text anywhere; `around` shows context around one message. " +
			"Use it to recover what was said before a sleep or before you started.",
		parameters: Type.Object({
			action: Type.Union([
				Type.Literal("threads"),
				Type.Literal("read"),
				Type.Literal("search"),
				Type.Literal("around"),
			]),
			thread: Type.Optional(Type.String({ description: "Thread id, e.g. telegram:12345. Omit to read across all threads." })),
			query: Type.Optional(Type.String({ description: "Text to search for (case-insensitive)." })),
			message_id: Type.Optional(Type.String({ description: "Provider message id (or history id) for `around`." })),
			limit: Type.Optional(Type.Number({ description: "How many messages to return (default 30, max 200)." })),
			before: Type.Optional(Type.String({ description: "Only messages older than this provider message id." })),
			after: Type.Optional(Type.String({ description: "Only messages newer than this provider message id." })),
			since: Type.Optional(Type.String({ description: "Lower time bound: ISO timestamp or relative like 2h, 1d." })),
			until: Type.Optional(Type.String({ description: "Upper time bound: ISO timestamp or relative like 30m." })),
			direction: Type.Optional(Type.Union([Type.Literal("inbound"), Type.Literal("outbound")])),
			module: Type.Optional(Type.String({ description: "Only this module's records, e.g. telegram." })),
			order: Type.Optional(
				Type.Union([Type.Literal("asc"), Type.Literal("desc")], { description: "Default desc (newest first)." }),
			),
		}),
		execute: async (_toolCallId, params): Promise<ToolResult> => {
			const limit = Math.min(Math.max(1, Math.floor(params.limit ?? 30)), 200);
			const base: HistoryQuery = {
				thread: params.thread,
				module: params.module,
				direction: params.direction,
				since: params.since ? parseTimeSpec(params.since) : undefined,
				until: params.until ? parseTimeSpec(params.until) : undefined,
				limit,
				order: params.order ?? "desc",
			};
			switch (params.action) {
				case "threads": {
					const all = deps.history.threads({ module: params.module });
					if (all.length === 0) return ok("No conversations recorded yet.", { threads: [] });
					const shown = all.slice(0, limit);
					const lines = shown.map((thread) => {
						const meta = thread.meta ?? {};
						const title = thread.title || String(meta.chatTitle ?? thread.thread);
						return `- ${thread.thread} [${thread.module}] ${title} — ${thread.messageCount} msgs, last ${iso(thread.lastMessageAt)}`;
					});
					return ok(lines.join("\n"), { threads: shown });
				}
				case "read": {
					const records = deps.history.query({ ...base, before: params.before, after: params.after });
					if (records.length === 0) {
						return ok(params.thread ? `No messages in ${params.thread}.` : "No messages recorded yet.", { count: 0 });
					}
					return ok(renderHistory(records, params.thread), { count: records.length, messages: records });
				}
				case "search": {
					if (!params.query) throw new Error("`query` is required for search");
					const matches = deps.history.query({ ...base, search: params.query, limit });
					if (matches.length === 0) return ok(`Nothing matches "${params.query}".`, { count: 0 });
					return ok(`${matches.length} match(es) for "${params.query}":\n\n${renderHistory(matches, params.thread)}`, {
						count: matches.length,
						messages: matches,
					});
				}
				case "around": {
					if (!params.message_id) throw new Error("`message_id` is required for around");
					const anchor =
						deps.history.get(params.message_id) ?? deps.history.findByMessageId(params.thread, params.message_id);
					const records: HistoryRecord[] = [];
					if (anchor) {
						const beforeCount = Math.ceil(limit / 2);
						const afterCount = Math.max(0, limit - beforeCount);
						records.push(
							...deps.history.query({ ...base, thread: anchor.thread, before: anchor.messageId, limit: beforeCount, order: "asc" }),
						);
						records.push(anchor);
						records.push(
							...deps.history.query({ ...base, thread: anchor.thread, after: anchor.messageId, limit: afterCount, order: "asc" }),
						);
					} else {
						records.push(...deps.history.query({ ...base, before: params.message_id }));
					}
					if (records.length === 0) return ok(`No messages around ${params.message_id}.`, { count: 0 });
					return ok(renderHistory(records, anchor?.thread ?? params.thread), { count: records.length, messages: records });
				}
				default:
					throw new Error(`Unknown action ${String(params.action)}`);
			}
		},
	});

	const closeThread = defineTool({
		name: "close_thread",
		label: "Close thread",
		description:
			"Mark a conversation as intentionally not needing an answer. This stops the runtime from carrying it into future wakes " +
			"as UNANSWERED. Only use it when silence is the right response (spam, acknowledgements, not-for-me messages).",
		parameters: Type.Object({
			thread: Type.String({ description: "Thread id to close." }),
			reason: Type.String({ description: "Why no reply is correct. Recorded for introspection." }),
		}),
		execute: async (_toolCallId, params): Promise<ToolResult> => {
			const closed = deps.threads.close(params.thread, params.reason);
			if (!closed) throw new Error(`Unknown thread ${params.thread}`);
			return ok(`Thread ${params.thread} closed: ${params.reason}`, { thread: params.thread });
		},
	});

	const status = defineTool({
		name: "status",
		label: "Status",
		description: "Inspect your own runtime: pending events, open threads, budget, last run, session.",
		parameters: Type.Object({}),
		execute: async (): Promise<ToolResult> => {
			const value = deps.runtimeStatus();
			return ok(JSON.stringify(value, null, 2), { status: value });
		},
	});

	return [
		sendMessage,
		idle,
		sleepTool,
		notifications,
		remind,
		listReminders,
		cancelReminder,
		note,
		journal,
		history,
		closeThread,
		status,
		...deps.moduleTools,
	] as ToolDefinition[];
}

function requireRun(deps: ToolDeps, tool: string): RunHandle {
	const run = deps.getRun();
	if (!run) throw new Error(`${tool} can only be used while you are awake (no active run)`);
	return run;
}

function recordEvents(run: RunHandle, events: AliveEvent[]): void {
	const seen = new Set(run.events.map((event) => event.seq));
	for (const event of events) {
		if (seen.has(event.seq)) continue;
		run.events.push(event);
		seen.add(event.seq);
	}
}

function defaultThread(run: RunHandle): string | undefined {
	for (let i = run.events.length - 1; i >= 0; i -= 1) {
		const thread = run.events[i]?.thread;
		if (thread) return thread;
	}
	return undefined;
}

function renderHistory(records: HistoryRecord[], thread?: string): string {
	const scope = thread ? `thread ${thread}` : `${new Set(records.map((record) => record.thread)).size} thread(s)`;
	const lines = records.map((record) => {
		const arrow = record.direction === "outbound" ? "→" : "←";
		const who = record.direction === "outbound" ? "you" : record.author ?? "unknown";
		const id = record.messageId ? ` #${record.messageId}` : "";
		const media = record.attachments && record.attachments.length > 0 ? ` [${record.attachments.map((a) => a.kind).join(", ")}]` : "";
		return `${iso(record.ts)} [${record.thread}] ${arrow} ${who}${id}: ${truncate(record.text.replace(/\n/g, " ⏎ "), 1200)}${media}`;
	});
	return `${scope}\n\n${lines.join("\n")}`;
}

function renderPolicy(deps: ToolDeps): string {
	const policy = deps.policy.load();
	const lines = [`default: ${policy.defaultMode}`];
	for (const rule of policy.rules) {
		const matchers = [
			rule.thread ? `thread=${rule.thread}` : undefined,
			rule.source ? `source=${rule.source}` : undefined,
			rule.kind ? `kind=${rule.kind}` : undefined,
			rule.priority ? `priority=${rule.priority}` : undefined,
			rule.note ? `note="${rule.note}"` : undefined,
		]
			.filter(Boolean)
			.join(" ");
		lines.push(`- ${rule.id}: ${rule.mode}${matchers ? ` (${matchers})` : ""}`);
	}
	return lines.join("\n");
}
