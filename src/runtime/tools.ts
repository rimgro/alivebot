import * as fs from "node:fs";
import * as path from "node:path";
import { Type } from "typebox";
import { defineTool, type AgentToolResult, type ToolDefinition } from "@earendil-works/pi-coding-agent";
import { loadConfig, type AgentManagementPermissions, type LoadedConfig } from "../config.js";
import {
	assertCanDelegate,
	canCreateAgents,
	canManageAgent,
	createAgent,
	disableManagedAgent,
	findManagedAgent,
	getAgentEnabled,
	listAgents,
	NO_AGENT_MANAGEMENT,
	enableManagedAgent,
	startManagedAgent,
	stopManagedAgent,
	updateManagedAgentProfile,
} from "../agents.js";
import { EventStore, type AliveEvent, type EventKind, type EventPriority } from "../store/events.js";
import type { Journal } from "../store/journal.js";
import type { HistoryQuery, HistoryRecord, HistoryStore } from "../store/history.js";
import type { NoteStore } from "../store/notes.js";
import type { MemoryService } from "../store/memory.js";
import type { Outbox, OutgoingMessage } from "../store/outbox.js";
import type { NotifyMode, PolicyStore } from "../store/policy.js";
import type { ReminderStore } from "../store/reminders.js";
import type { ThreadStore } from "../store/threads.js";
import type { Logger } from "../log.js";
import { canReadMemoryFact, retainedMemoryScopes, searchableMemoryScopes } from "./memory-access.js";
import { recordOperatorAgentReply, sendLocalAgentMessage } from "./agent-messaging.js";
import { snapshotRuntime } from "./daemon.js";
import { formatDuration, iso, parseTimeSpec, parseTimestamp, sleep, truncate } from "../util.js";
import { renderIdleEvents, renderSleepOffer } from "./prompt.js"

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
	retainedThisRun: boolean;
	sleepSummary?: string;
	lastStopReason?: string;
	lastError?: string;
}

export interface ToolDeps {
	config: LoadedConfig;
	store: EventStore;
	reminders: ReminderStore;
	notes: NoteStore;
	memory: MemoryService;
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
	"retain",
	"memory",
	"journal",
	"history",
	"close_thread",
	"status",
	"create_agent",
	"manage_agents",
	"message_agent",
] as const;

type ToolResult = AgentToolResult<Record<string, unknown>>;

function ok(text: string, details: Record<string, unknown> = {}, terminate = false): ToolResult {
	return { content: [{ type: "text", text }], details, ...(terminate ? { terminate: true } : {}) };
}

export function createAliveTools(deps: ToolDeps): ToolDefinition[] {
	const log = deps.log.child("tools");

	const createManagedAgent = defineTool({
		name: "create_agent",
		label: "Create persistent agent",
		description: "Create a persistent managed agent profile with its own state, workspace, role contract, and explicitly selected least-privilege tools. This is agent provisioning, not one-off task dispatch. Only administrator profiles granted this tool may use it.",
		parameters: Type.Object({
			id: Type.String({ description: "Unique agent id: lowercase letters, digits, underscore or hyphen." }),
			name: Type.String({ description: "Human-readable agent name." }),
			role: Type.String({ description: "The role and work this persistent agent owns." }),
			contract: Type.String({ description: "Its responsibilities, boundaries, collaboration expectations, and communication onboarding instructions." }),
			tools: Type.Array(Type.String(), { description: "Exact tool names this agent may use; privileged tools are never inherited." }),
			permissions: Type.Optional(Type.Unknown({ description: "Fine-grained permissions: create/edit/start/stop/enable/configurePermissions booleans, targets allowlist, and grantableTools allowlist." })),
		}),
		execute: async (_toolCallId, params): Promise<ToolResult> => {
			requireRun(deps, "create_agent");
			if (!canCreateAgents(deps.config)) throw new Error("agent creation is not authorized for this profile");
			const permissions = (params.permissions ?? NO_AGENT_MANAGEMENT) as AgentManagementPermissions;
			assertCanDelegate(deps.config, params.tools, permissions);
			const agent = createAgent(deps.config, params.id, params.name, {
				role: params.role,
				contract: params.contract,
				toolAllowlist: params.tools,
				management: permissions,
			});
			return ok(`Created persistent agent ${agent.id}. Start it with: alive agents start ${agent.id}`, {
				agentId: agent.id,
				configPath: agent.configPath,
				toolAllowlist: params.tools,
			});
		},
	});

	const manageAgents = defineTool({
		name: "manage_agents",
		label: "Manage persistent agents",
		description: "Manage persistent agent profiles and lifecycles. Each action requires its matching agentManagement capability and the target must be in your target allowlist. Permission and tool grants cannot exceed your own authority.",
		parameters: Type.Object({
			action: Type.Union([Type.Literal("create"), Type.Literal("edit"), Type.Literal("start"), Type.Literal("stop"), Type.Literal("enable"), Type.Literal("disable"), Type.Literal("permissions"), Type.Literal("status")]),
			id: Type.String(),
			name: Type.Optional(Type.String()),
			role: Type.Optional(Type.String()),
			contract: Type.Optional(Type.String()),
			tools: Type.Optional(Type.Array(Type.String())),
			permissions: Type.Optional(Type.Unknown({ description: "Fine-grained permissions: action booleans, targets list, and grantableTools list." })),
		}),
		execute: async (_toolCallId, params): Promise<ToolResult> => {
			requireRun(deps, "manage_agents");
			const actorId = managedAgentIdForConfig(deps.config);
			if (!actorId) throw new Error("only a managed agent profile may manage agents through this tool");
			const action = params.action;
			const capability = action === "create" ? "create" : action === "edit" ? "edit" :
				action === "start" ? "start" : action === "stop" ? "stop" :
				action === "enable" || action === "disable" ? "enable" :
				action === "permissions" ? "configurePermissions" : undefined;
			if (action === "create") {
				if (!canCreateAgents(deps.config)) throw new Error("agent creation is not authorized for this profile");
				if (!params.name?.trim() || !params.role?.trim() || !params.contract?.trim() || !params.tools) {
					throw new Error("create requires name, role, contract, and tools");
				}
				const permissions = (params.permissions ?? NO_AGENT_MANAGEMENT) as AgentManagementPermissions;
				assertCanDelegate(deps.config, params.tools, permissions);
				const created = createAgent(deps.config, params.id, params.name, {
					role: params.role, contract: params.contract, toolAllowlist: params.tools, management: permissions,
				});
				return ok(`Created persistent agent ${created.id}; it is ${getAgentEnabled(created) ? "enabled" : "disabled"} and stopped.`, { agentId: created.id, configPath: created.configPath });
			}
			const target = findManagedAgent(deps.config, params.id);
			if (target.id === actorId) throw new Error("an agent cannot manage its own profile or lifecycle");
			if (capability && !canManageAgent(deps.config, capability, target.id)) throw new Error(`not authorized to ${action} agent ${target.id}`);
			if (action === "edit" && (params.permissions !== undefined || params.tools !== undefined) && !canManageAgent(deps.config, "configurePermissions", target.id)) {
				throw new Error(`not authorized to configure tools or permissions for agent ${target.id}`);
			}
			if (action === "status") {
				if (!deps.config.config.agentManagement.targets.includes("*") && !deps.config.config.agentManagement.targets.includes(target.id)) throw new Error(`agent ${target.id} is outside your target allowlist`);
				const state = snapshotRuntime(loadManagedConfig(deps.config, target).paths.stateDir);
				const enabled = getAgentEnabled(target);
				const running = state?.alive ?? false;
				return ok(`${target.id}: ${enabled ? "enabled" : "disabled"}, ${running ? `running pid=${state?.pid}` : "stopped"}`, { agentId: target.id, enabled, running, pid: running ? state?.pid : undefined });
			}
			if (action === "start") {
				const started = await startManagedAgent(deps.config, target.id);
				return ok(`Started ${target.id} (pid ${started.pid}).`, { agentId: target.id, pid: started.pid });
			}
			if (action === "stop") {
				await stopManagedAgent(deps.config, target.id);
				return ok(`Stopped ${target.id}.`, { agentId: target.id, enabled: getAgentEnabled(target) });
			}
			if (action === "disable") {
				await disableManagedAgent(deps.config, target.id);
				return ok(`Disabled and stopped ${target.id}. It cannot be restarted until enabled.`, { agentId: target.id, enabled: false });
			}
			if (action === "enable") {
				await enableManagedAgent(deps.config, target.id);
				return ok(`Enabled ${target.id}; it remains stopped until started.`, { agentId: target.id, enabled: true });
			}
			if (action === "edit" || action === "permissions") {
				const updates: { name?: string; role?: string; contract?: string; toolAllowlist?: string[]; management?: AgentManagementPermissions } = {};
				if (action === "edit") {
					if (params.name !== undefined) updates.name = params.name;
					if (params.role !== undefined) updates.role = params.role;
					if (params.contract !== undefined) updates.contract = params.contract;
					if (params.tools !== undefined) updates.toolAllowlist = params.tools;
				}
				if (params.permissions !== undefined) updates.management = params.permissions as AgentManagementPermissions;
				if (updates.toolAllowlist === undefined && updates.management === undefined && updates.name === undefined && updates.role === undefined && updates.contract === undefined) throw new Error(`${action} requires at least one field to update`);
				const current = loadManagedConfig(deps.config, target);
				if (updates.management || updates.toolAllowlist) {
					assertCanDelegate(deps.config, updates.toolAllowlist ?? current.config.tools.allowlist, updates.management ?? current.config.agentManagement);
				}
				await updateManagedAgentProfile(deps.config, target.id, updates);
				return ok(`Updated ${target.id}; security-sensitive changes are active.`, { agentId: target.id, updated: Object.keys(updates) });
			}
			throw new Error(`unsupported agent action ${action}`);
		},
	});

	const messageAgent = defineTool({
		name: "message_agent",
		label: "Message another agent",
		description: "Send a durable local message to a managed agent. The recipient is the explicit agent id; thread ids only group conversations. Messages are recorded in the sender outbox and both agents' local history before the recipient inbox is woken on its next poll.",
		parameters: Type.Object({
			to: Type.String({ description: "Managed recipient agent id (not a thread id)." }),
			text: Type.String({ description: "Message body." }),
		}),
		execute: async (_toolCallId, params): Promise<ToolResult> => {
			const run = requireRun(deps, "message_agent");
			const message = await sendLocalAgentMessage({
				config: deps.config,
				outbox: deps.outbox,
				to: params.to,
				text: params.text,
				runId: run.id,
			});
			run.outbound.push({ thread: message.thread, text: message.text, delivered: true });
			deps.threads.recordOutbound(message.thread, message.ts);
			return ok(`Message ${message.id} delivered to managed agent ${message.recipientAgentId}.`, {
				messageId: message.id,
				recipientAgentId: message.recipientAgentId,
				thread: message.thread,
			});
		},
	});

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
			recordOperatorAgentReply(deps.history, deps.config, thread, {
				id: message.id,
				text: params.text,
				ts: message.ts,
				replyTo: params.reply_to,
			});
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
				return ok("Sleep is not automatic. Call retain with selected facts (or an empty list), then sleep with the updated summary_md. Use important=true to keep waiting.", { sleepOffered: true, needsExplicitSleep: true });
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
			"Reset your context only after calling retain with selected facts and passing the complete updated summary.md as summary_md. " +
			"The runtime enforces this order; the optional summary is an episodic journal note.",
		executionMode: "sequential",
		parameters: Type.Object({
			summary: Type.String({
				description: "Short episodic sleep note for the journal (decisions, open threads, promises).",
			}),
			summary_md: Type.String({
				description: "Complete replacement content for summary.md: concise, stable, current long-term memory.",
			}),
			note_key: Type.Optional(Type.String({ description: "Optional short note key to set before sleeping." })),
			note_value: Type.Optional(Type.String({ description: "Value for note_key." })),
		}),
		execute: async (_toolCallId, params): Promise<ToolResult> => {
			const run = requireRun(deps, "sleep");
			if (!run.retainedThisRun) throw new Error("Call retain (with selected facts, or an empty list) before sleeping");
			const summary = params.summary.trim();
			const summaryMd = params.summary_md.trim();
			if (!summaryMd) throw new Error("summary_md cannot be empty; pass the complete updated summary.md content");
			writeTextAtomic(deps.config.paths.summaryPath, `${summaryMd}\n`);
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
			log.info("agent chose to sleep", { chars: summary.length, summaryChars: summaryMd.length });
			return ok("Sleeping now. Facts retained and summary.md updated before context reset.", { sleeping: true }, true);
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

	const retain = defineTool({
		name: "retain",
		label: "Retain facts",
		description: "Before sleep, retain durable facts selected from your own context. Facts are private to you by default. To share, name a scope explicitly configured in memory.sharedScopes; unapproved scopes are rejected. Related current facts are superseded into a dated revision chain; nothing is physically deleted. Call even with an empty facts list when there is nothing worth retaining.",
		parameters: Type.Object({
			facts: Type.Array(Type.String(), { description: "Durable facts; formulate updates as the current complete truth." }),
			scopes: Type.Array(Type.String(), { description: "Optional explicitly allowlisted shared scopes; your private agent scope is always added automatically." }),
		}),
		execute: async (_toolCallId, params): Promise<ToolResult> => {
			const run = requireRun(deps, "retain");
			const scopes = retainedMemoryScopes(deps.config, params.scopes);
			const results = await deps.memory.retain(params.facts, scopes);
			run.retainedThisRun = true;
			const lines = results.map(({ status, fact }) => `- ${status}: [${fact.id}] ${fact.text} (scopes: ${fact.scopes.join(", ")})`);
			return ok(lines.length ? lines.join("\n") : "No facts stored. You may now update summary.md and sleep.", { results });
		},
	});

	const memory = defineTool({
		name: "memory",
		label: "Search memory",
		description: "Search your private facts by default or inspect a fact's immutable revision history. Cross-agent knowledge is visible only when you explicitly request a scope configured in memory.sharedScopes. Search before relying on long-term memory.",
		parameters: Type.Object({
			action: Type.Union([Type.Literal("search"), Type.Literal("history")]),
			query: Type.Optional(Type.String()),
			id: Type.Optional(Type.String()),
			scopes: Type.Optional(Type.Array(Type.String(), { description: "Optional shared scopes to search; each must be listed in memory.sharedScopes. Omit to search only your private facts." })),
			include_history: Type.Optional(Type.Boolean()),
			limit: Type.Optional(Type.Number()),
		}),
		execute: async (_toolCallId, params): Promise<ToolResult> => {
			const requestedScopes = params.scopes ?? [];
			const visibleScopes = searchableMemoryScopes(deps.config, requestedScopes);
			const facts = params.action === "history"
				? (await deps.memory.history(required(params.id, "id"))).filter((fact) => canReadMemoryFact(deps.config, fact.scopes, requestedScopes))
				: await deps.memory.search(required(params.query, "query"), params.limit ?? 6, visibleScopes, params.include_history ?? false);
			const lines = facts.map((fact) => `- ${fact.active ? "CURRENT" : `superseded at ${fact.validTo ?? "unknown"}`} [${fact.id}] (${fact.scopes.join(", ")}; ${fact.validFrom}) ${fact.text}${fact.supersedes.length ? ` <- ${fact.supersedes.join(",")}` : ""}`);
			return ok(lines.length ? lines.join("\n") : "No matching memories.", { facts });
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
		createManagedAgent,
		manageAgents,
		messageAgent,
		note,
		retain,
		memory,
		journal,
		history,
		closeThread,
		status,
		...deps.moduleTools,
	] as ToolDefinition[];
}

function managedAgentIdForConfig(config: LoadedConfig): string | undefined {
	const configPath = path.resolve(config.paths.configPath);
	return listAgents(config).find((agent) => path.resolve(agent.configPath) === configPath)?.id;
}

function loadManagedConfig(base: LoadedConfig, agent: { configPath: string }): LoadedConfig {
	return loadConfig({ cwd: base.paths.rootDir, configPath: agent.configPath });
}

function required(value: string | undefined, name: string): string {
	if (!value?.trim()) throw new Error(`\`${name}\` is required`);
	return value;
}

function writeTextAtomic(file: string, value: string): void {
	fs.mkdirSync(path.dirname(file), { recursive: true });
	const temporary = `${file}.${process.pid}.${Date.now()}.tmp`;
	fs.writeFileSync(temporary, value, "utf8");
	fs.renameSync(temporary, file);
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
