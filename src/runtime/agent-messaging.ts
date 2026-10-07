import * as path from "node:path";
import { listAgents, validateAgentId } from "../agents.js";
import { loadConfig, type LoadedConfig } from "../config.js";
import { EventStore } from "../store/events.js";
import { HistoryStore, type HistoryStore as HistoryStoreType } from "../store/history.js";
import type { Outbox, OutgoingMessage } from "../store/outbox.js";

export interface LocalMessageInput {
	config: LoadedConfig;
	outbox: Outbox;
	to: string;
	text: string;
	runId: string;
	senderId?: string;
	senderName?: string;
}

/**
 * Deliver to a managed agent by explicit recipient id. Thread ids are only for
 * grouping a conversation; they are never interpreted as a routing address.
 */
export async function sendLocalAgentMessage(input: LocalMessageInput): Promise<OutgoingMessage> {
	const to = validateAgentId(input.to);
	const text = input.text.trim();
	if (!text) throw new Error("message text cannot be empty");
	const recipient = listAgents(input.config).find((agent) => agent.id === to);
	if (!recipient) throw new Error(`unknown managed agent: ${to}`);
	const targetConfig = loadConfig({ cwd: input.config.paths.rootDir, configPath: recipient.configPath });
	const senderId = input.senderId ?? managedAgentId(input.config) ?? "main";
	const senderName = input.senderName?.trim() || (senderId === "operator" ? "Operator" : input.config.config.name);
	const senderRef = senderId === "operator" ? "operator" : `agent:${senderId}`;
	const recipientRef = `agent:${to}`;
	const thread = localConversationThread(senderRef, recipientRef);

	return input.outbox.send({
		runId: input.runId,
		thread,
		text,
		recipientAgentId: to,
		senderId,
		senderName,
	}, async (message) => {
		const meta = {
			channel: "local",
			senderId,
			senderName,
			recipientAgentId: to,
			messageId: message.id,
		};
		EventStore.open(targetConfig.paths.stateDir).append({
			id: message.id,
			kind: "user_message",
			source: "local-messenger",
			priority: "normal",
			title: `message from ${senderName}`,
			text,
			thread,
			expectsReply: true,
			dedupeKey: `local-message:${message.id}`,
			meta,
		});

		HistoryStore.open(targetConfig.paths.stateDir).append({
			id: message.id,
			thread,
			module: "local",
			direction: "inbound",
			ts: message.ts,
			author: senderName,
			authorId: senderId,
			text,
			messageId: message.id,
			meta,
		});
		HistoryStore.open(input.config.paths.stateDir).append({
			id: message.id,
			thread,
			module: "local",
			direction: "outbound",
			ts: message.ts,
			author: senderName,
			authorId: senderId,
			text,
			messageId: message.id,
			meta,
		});
		HistoryStore.open(targetConfig.paths.stateDir).upsertThread({
			thread,
			module: "local",
			title: `${senderName} ↔ ${targetConfig.config.name}`,
			participants: [senderId, to],
			meta: { recipientAgentId: to },
		});
		HistoryStore.open(input.config.paths.stateDir).upsertThread({
			thread,
			module: "local",
			title: `${senderName} ↔ ${targetConfig.config.name}`,
			participants: [senderId, to],
			meta: { recipientAgentId: to },
		});
	});
}

export function listLocalMessages(config: LoadedConfig, limit = 30, thread?: string) {
	const messages = HistoryStore.open(config.paths.stateDir).query({ module: "local", thread, limit: Math.max(1, Math.min(limit, 1000)), order: "desc" });
	return messages.reverse();
}

export function localConversationThread(left: string, right: string): string {
	return `local:${[left, right].sort().join(":")}`;
}

export function operatorAgentThread(agentId: string): string {
	return localConversationThread("operator", `agent:${validateAgentId(agentId)}`);
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
