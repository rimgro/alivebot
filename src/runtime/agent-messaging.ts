import * as fs from "node:fs";
import * as path from "node:path";
import { agentsRoot, listAgents, validateAgentId } from "../agents.js";
import { loadConfig, type LoadedConfig } from "../config.js";
import { EventStore } from "../store/events.js";
import { HistoryStore, type HistoryStore as HistoryStoreType } from "../store/history.js";
import type { Outbox, OutgoingMessage } from "../store/outbox.js";

/**
 * Reserved id of the root profile.
 *
 * The root profile is the operator-facing agent whose state directory IS the
 * root state directory (`paths.stateDir`). It is not a directory under the
 * managed-agents registry, so `listAgents()` never lists it; it is resolved
 * explicitly through `resolveRootProfile()` instead.
 */
export const ROOT_AGENT_ID = "main";

export interface LocalMessageInput {
	config: LoadedConfig;
	outbox: Outbox;
	to: string;
	text: string;
	runId: string;
	senderId?: string;
	senderName?: string;
}

export interface LocalAgentProfile {
	/** Canonical routing id: the managed agent id, or `main` for the root profile. */
	id: string;
	/** Display name from the profile config. */
	name: string;
	config: LoadedConfig;
}

interface LocalSender extends LocalAgentProfile {
	/** Thread-side reference of the sender (`operator` or `agent:<id>`). */
	ref: string;
}

/**
 * Deliver a message to a local agent profile. Thread ids are only for grouping
 * a conversation; they are never interpreted as a routing address.
 *
 * The recipient is either a managed agent id or the root profile (`main`). The
 * message is only reported as delivered after the event was appended to the
 * recipient's inbox.
 */
export async function sendLocalAgentMessage(input: LocalMessageInput): Promise<OutgoingMessage> {
	const to = validateAgentId(input.to);
	const text = input.text.trim();
	if (!text) throw new Error("message text cannot be empty");
	const sender = resolveLocalSender(input.config, input.senderId, input.senderName);
	const recipient = resolveLocalRecipient(input.config, to);
	const senderStateDir = path.resolve(input.config.paths.stateDir);
	const recipientStateDir = path.resolve(recipient.config.paths.stateDir);
	// Operator conversations keep their historical thread shape so the operator
	// console and existing local history stay addressable.
	const thread = sender.ref === "operator"
		? operatorAgentThread(recipient.id)
		: localConversationThread(sender.ref, `agent:${recipient.id}`);

	return input.outbox.send({
		runId: input.runId,
		thread,
		text,
		recipientAgentId: recipient.id,
		senderId: sender.id,
		senderName: sender.name,
	}, async (message) => {
		const meta = {
			channel: "local",
			senderId: sender.id,
			senderName: sender.name,
			recipientAgentId: recipient.id,
			messageId: message.id,
		};
		// The append to the recipient inbox is the delivery point: everything else
		// is bookkeeping, and no success is reported unless this stores the event.
		const inbox = EventStore.open(recipientStateDir);
		const stored = inbox.append({
			id: message.id,
			kind: "user_message",
			source: "local-messenger",
			priority: "normal",
			title: `message from ${sender.name}`,
			text,
			thread,
			expectsReply: true,
			dedupeKey: `local-message:${message.id}`,
			meta,
		});
		if (stored.id !== message.id) throw new Error(`recipient inbox ${recipientStateDir} did not store message ${message.id}`);

		HistoryStore.open(recipientStateDir).append({
			id: message.id,
			thread,
			module: "local",
			direction: "inbound",
			ts: message.ts,
			author: sender.name,
			authorId: sender.id,
			text,
			messageId: message.id,
			meta,
		});
		HistoryStore.open(recipientStateDir).upsertThread({
			thread,
			module: "local",
			title: `${sender.name} ↔ ${recipient.name}`,
			participants: [sender.id, recipient.id],
			meta: { recipientAgentId: recipient.id },
		});
		// A profile messaging itself has one history: writing both directions into
		// the same file would misrepresent who said what.
		if (senderStateDir === recipientStateDir) return;
		HistoryStore.open(senderStateDir).append({
			id: message.id,
			thread,
			module: "local",
			direction: "outbound",
			ts: message.ts,
			author: sender.name,
			authorId: sender.id,
			text,
			messageId: message.id,
			meta,
		});
		HistoryStore.open(senderStateDir).upsertThread({
			thread,
			module: "local",
			title: `${sender.name} ↔ ${recipient.name}`,
			participants: [sender.id, recipient.id],
			meta: { recipientAgentId: recipient.id },
		});
	});
}

/**
 * Resolve the profile a `to` value addresses.
 *
 * `main` (and the root profile's own config name) always means the root
 * profile; everything else is a managed agent id. Resolution never depends on
 * the sender's profile listing itself: the root profile is looked up explicitly
 * and the managed registry is only consulted for managed ids.
 */
export function resolveLocalRecipient(config: LoadedConfig, toInput: string): LocalAgentProfile {
	const id = validateAgentId(toInput);
	const root = resolveRootProfile(config);
	if (root && (id === ROOT_AGENT_ID || id === normalizedAgentId(root.config.name))) {
		return { id: ROOT_AGENT_ID, name: root.config.name, config: root };
	}
	const managed = listAgents(config).find((agent) => agent.id === id);
	if (managed) {
		const loaded = loadConfig({ cwd: config.paths.rootDir, configPath: managed.configPath });
		return { id, name: loaded.config.name, config: loaded };
	}
	if (id === ROOT_AGENT_ID) {
		throw new Error(`cannot resolve the root profile (${ROOT_AGENT_ID}) from ${config.paths.configPath}; set rootConfigPath in the profile config`);
	}
	throw new Error(`unknown managed agent: ${id}`);
}

/**
 * Find the root profile config.
 *
 * The root profile owns the root state directory, which is the parent of the
 * shared agents registry (`stateDir/agents` by default). Managed profiles also
 * record its absolute config path in `rootConfigPath`, which is tried first so
 * a non-default registry layout still resolves. Returns `undefined` instead of
 * guessing: an unresolved root profile must surface as an error, never as a
 * silently wrong inbox.
 */
export function resolveRootProfile(config: LoadedConfig): LoadedConfig | undefined {
	const currentConfigPath = path.resolve(config.paths.configPath);
	const agentsDir = path.resolve(agentsRoot(config));
	const rootStateDir = path.dirname(agentsDir);
	const configured = config.config.rootConfigPath?.trim();
	if (configured) {
		const configPath = path.resolve(config.paths.rootDir, configured);
		if (configPath !== currentConfigPath && fs.existsSync(configPath)) {
			const candidate = loadConfig({ cwd: path.dirname(configPath), configPath });
			if (path.resolve(candidate.paths.stateDir) === rootStateDir || path.resolve(agentsRoot(candidate)) === agentsDir) {
				return candidate;
			}
		}
	}
	if (path.resolve(config.paths.stateDir) === rootStateDir) return config;
	for (let dir = rootStateDir, parent = ""; dir !== parent; parent = dir, dir = path.dirname(dir)) {
		const configPath = path.join(dir, "alive.config.json");
		if (!fs.existsSync(configPath)) continue;
		const candidate = loadConfig({ cwd: dir, configPath });
		if (path.resolve(candidate.paths.stateDir) === rootStateDir || path.resolve(agentsRoot(candidate)) === agentsDir) return candidate;
	}
	return undefined;
}

/**
 * The sender is who actually sends, never a default. Inside a managed profile
 * that is the profile id; from the root profile that is `main`. A profile whose
 * identity cannot be established is an error, because mislabelling it would
 * reverse the conversation direction.
 */
function resolveLocalSender(config: LoadedConfig, senderIdInput?: string, senderNameInput?: string): LocalSender {
	const name = senderNameInput?.trim();
	const explicit = senderIdInput?.trim();
	if (explicit) {
		const id = validateAgentId(explicit);
		return {
			id,
			name: name || (id === "operator" ? "Operator" : config.config.name),
			ref: id === "operator" ? "operator" : `agent:${id}`,
			config,
		};
	}
	const managed = managedAgentId(config);
	if (managed) {
		return { id: managed, name: name || config.config.name, ref: `agent:${managed}`, config };
	}
	const root = resolveRootProfile(config);
	if (root && path.resolve(root.paths.configPath) === path.resolve(config.paths.configPath)) {
		return { id: ROOT_AGENT_ID, name: name || config.config.name, ref: `agent:${ROOT_AGENT_ID}`, config };
	}
	throw new Error(`cannot determine the sending agent for ${config.paths.configPath}: it is neither listed in ${agentsRoot(config)} nor the root profile; refusing to label the message as ${ROOT_AGENT_ID}`);
}

export function listLocalMessages(config: LoadedConfig, limit = 30, thread?: string) {
	const messages = HistoryStore.open(config.paths.stateDir).query({ module: "local", thread, limit: Math.max(1, Math.min(limit, 1000)), order: "desc" });
	return messages.reverse();
}

/** Agent conversation thread id: the sender side always comes first. */
export function localConversationThread(sender: string, recipient: string): string {
	return `local:${sender}:${recipient}`;
}

/** Operator console thread for one managed agent (historical shape, kept stable for stored history). */
export function operatorAgentThread(agentId: string): string {
	return `local:agent:${validateAgentId(agentId)}:operator`;
}

export function isOperatorAgentThread(config: LoadedConfig, thread: string): boolean {
	const agentId = managedAgentId(config);
	return agentId !== undefined && thread === operatorAgentThread(agentId);
}

export function recordOperatorAgentReply(
	history: Pick<HistoryStoreType, "append" | "upsertThread">,
	config: LoadedConfig,
	thread: string,
	message: { id: string; text: string; ts: number; replyTo?: string },
): boolean {
	const agentId = managedAgentId(config);
	if (!agentId || thread !== operatorAgentThread(agentId)) return false;
	history.append({
		id: message.id,
		thread,
		module: "local",
		direction: "outbound",
		ts: message.ts,
		author: config.config.name,
		authorId: agentId,
		text: message.text,
		messageId: message.id,
		replyTo: message.replyTo,
		meta: { channel: "local", senderId: agentId, recipientId: "operator" },
	});
	history.upsertThread({ thread, module: "local", title: `Operator ↔ ${config.config.name}`, participants: ["operator", agentId] });
	return true;
}

export function managedAgentId(config: LoadedConfig): string | undefined {
	const configPath = path.resolve(config.paths.configPath);
	return listAgents(config).find((agent) => path.resolve(agent.configPath) === configPath)?.id;
}

function normalizedAgentId(value: string): string | undefined {
	try {
		return validateAgentId(value);
	} catch {
		return undefined;
	}
}
