import * as fs from "node:fs";
import * as path from "node:path";
import { agentsRoot, listAgents, validateAgentId } from "../agents.js";
import { loadConfig, type LoadedConfig } from "../config.js";
import type { Logger } from "../log.js";
import { EventStore } from "../store/events.js";
import { HistoryStore, type HistoryStore as HistoryStoreType } from "../store/history.js";
import type { Outbox, OutgoingMessage } from "../store/outbox.js";

/**
 * Reserved id of the root profile.
 *
 * The root profile is the operator-facing agent whose state directory IS the
 * root state directory (`paths.stateDir`). It is not a directory under the
 * managed-agents registry, so `listAgents()` never lists it; it is resolved
 * explicitly through `rootProfile()` instead.
 */
export const ROOT_AGENT_ID = "main";

/**
 * Structured sink for the routing trace. Message text is never passed to it.
 */
export type LocalMessageLogger = Pick<Logger, "debug" | "info" | "warn">;

export interface LocalMessageInput {
	config: LoadedConfig;
	outbox: Outbox;
	to: string;
	text: string;
	runId: string;
	senderId?: string;
	senderName?: string;
	/** Optional routing trace: who sent to whom, where it landed, under which event id. */
	log?: LocalMessageLogger;
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
	const rawTo = input.to.trim();
	let sender: LocalSender | undefined;
	let recipient: LocalAgentProfile | undefined;
	let eventId: string | undefined;
	try {
		const to = validateAgentId(rawTo);
		const text = input.text.trim();
		if (!text) throw new Error("message text cannot be empty");
		sender = resolveLocalSender(input.config, input.senderId, input.senderName);
		recipient = resolveLocalRecipient(input.config, to);
		// Operator conversations keep their historical thread shape so the operator
		// console and existing local history stay addressable.
		const thread = sender.ref === "operator"
			? operatorAgentThread(recipient.id)
			: localConversationThread(sender.ref, `agent:${recipient.id}`);

		const message = await input.outbox.send({
			runId: input.runId,
			thread,
			text,
			recipientAgentId: recipient.id,
			senderId: sender.id,
			senderName: sender.name,
		}, async (queued) => {
			eventId = queued.id;
			deliverLocalMessage({ config: input.config, message: queued, senderId: sender!.id, senderName: sender!.name, recipient: recipient! });
		});
		// A wrong inbox was indistinguishable from a correct one (#148): every
		// resolution states sender, recipient, absolute inbox and event id, never text.
		input.log?.info("message_agent resolved local delivery", {
			to,
			senderId: sender.id,
			recipientId: recipient.id,
			inbox: inboxPath(recipient),
			eventId: message.id,
			thread: message.thread,
		});
		return message;
	} catch (error) {
		input.log?.warn("message_agent resolution failed", {
			to: rawTo,
			senderId: sender?.id,
			recipientId: recipient?.id,
			inbox: recipient ? inboxPath(recipient) : undefined,
			eventId,
			reason: error instanceof Error ? error.message : String(error),
		});
		throw error;
	}
}

/** Absolute inbox directory of a resolved profile (`<stateDir>/inbox`). */
function inboxPath(profile: LocalAgentProfile): string {
	return path.join(path.resolve(profile.config.paths.stateDir), "inbox");
}

/**
 * Replay a queued local message after a restart.
 *
 * The outbox delivery handler receives the original record, including the
 * sender and recipient ids, so replay needs no session state. Both writes are
 * idempotent: the recipient inbox dedupes on `local-message:<id>` and history
 * dedupes on the record id. A crash between the two leaves no duplicate.
 */
export function redeliverLocalAgentMessage(config: LoadedConfig, message: OutgoingMessage): void {
	const recipientId = message.recipientAgentId;
	if (!recipientId) throw new Error(`message ${message.id} has no recipientAgentId`);
	if (!message.senderId) throw new Error(`message ${message.id} has no senderId`);
	const senderId = validateAgentId(message.senderId);
	const senderName = message.senderName?.trim() || (senderId === "operator" ? "Operator" : config.config.name);
	const recipient = resolveLocalRecipient(config, recipientId);
	deliverLocalMessage({ config, message, senderId, senderName, recipient });
}

/**
 * Append a local message to the recipient inbox and both histories.
 *
 * The inbox append is the delivery point: everything else is bookkeeping, and
 * no success is reported unless this stores the event. All appends are
 * idempotent on `message.id` so retries after a crash cannot duplicate.
 */
function deliverLocalMessage(input: {
	config: LoadedConfig;
	message: OutgoingMessage;
	senderId: string;
	senderName: string;
	recipient: LocalAgentProfile;
}): void {
	const { config, message, senderId, senderName, recipient } = input;
	const senderStateDir = path.resolve(config.paths.stateDir);
	const recipientStateDir = path.resolve(recipient.config.paths.stateDir);
	const thread = message.thread;
	const meta = {
		channel: "local",
		senderId,
		senderName,
		recipientAgentId: recipient.id,
		messageId: message.id,
	};
	const inbox = EventStore.open(recipientStateDir);
	const stored = inbox.append({
		id: message.id,
		ts: message.ts,
		kind: "user_message",
		source: "local-messenger",
		priority: "normal",
		title: `message from ${senderName}`,
		text: message.text,
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
		author: senderName,
		authorId: senderId,
		text: message.text,
		messageId: message.id,
		meta,
	});
	HistoryStore.open(recipientStateDir).upsertThread({
		thread,
		module: "local",
		title: `${senderName} ↔ ${recipient.name}`,
		participants: [senderId, recipient.id],
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
		author: senderName,
		authorId: senderId,
		text: message.text,
		messageId: message.id,
		meta,
	});
	HistoryStore.open(senderStateDir).upsertThread({
		thread,
		module: "local",
		title: `${senderName} ↔ ${recipient.name}`,
		participants: [senderId, recipient.id],
		meta: { recipientAgentId: recipient.id },
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
	// The root profile is resolved for routing even when it is the current profile:
	// the root may address itself, while a managed profile never may (#148).
	const root = rootProfile(config);
	if (root && (id === ROOT_AGENT_ID || id === normalizedAgentId(root.config.name))) {
		return { id: ROOT_AGENT_ID, name: root.config.name, config: root };
	}
	const managed = listAgents(registryConfigFor(config)).find((agent) => agent.id === id);
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
 * Find the root profile config that is *not* the current profile.
 *
 * A managed profile is never its own root: it lives inside a registry and the
 * root is the profile that owns that registry. For the root profile itself this
 * returns `undefined` (it has no parent profile); `rootProfile()` is the
 * routing-side helper that also covers the root addressing itself. Returns
 * `undefined` instead of guessing: an unresolved root profile must surface as an
 * error, never as a silently wrong inbox.
 */
export function resolveRootProfile(config: LoadedConfig): LoadedConfig | undefined {
	const root = rootProfile(config);
	if (!root) return undefined;
	return path.resolve(root.paths.configPath) === path.resolve(config.paths.configPath) ? undefined : root;
}

/**
 * The root profile for routing: the current profile when it is the root itself.
 *
 * Managed profiles record the root config in `rootConfigPath`, tried first as
 * today. A profile that lives in a registry (`<registry>/<id>/alive.config.json`)
 * resolves the root as the profile that owns that registry, so the wrong
 * `agentsRoot()` a managed profile derives from its own state directory can
 * never make the profile look like the root (#148).
 */
function rootProfile(config: LoadedConfig): LoadedConfig | undefined {
	const currentConfigPath = path.resolve(config.paths.configPath);
	const location = managedRegistryLocation(config);
	const configured = config.config.rootConfigPath?.trim();
	if (configured) {
		const configPath = path.resolve(config.paths.rootDir, configured);
		if (configPath !== currentConfigPath && fs.existsSync(configPath)) {
			const candidate = loadConfig({ cwd: path.dirname(configPath), configPath });
			const accepted = location
				? ownsRegistry(candidate, location.registry)
				: ownsStateDir(candidate, config);
			if (accepted) return candidate;
		}
	}
	if (location) {
		const owner = registryOwner(location.registry);
		return owner && path.resolve(owner.paths.configPath) !== currentConfigPath ? owner : undefined;
	}
	// Not a managed profile: it may be the root profile itself.
	const agentsDir = path.resolve(agentsRoot(config));
	const rootStateDir = path.dirname(agentsDir);
	if (path.resolve(config.paths.stateDir) === rootStateDir) return config;
	for (let dir = rootStateDir, parent = ""; dir !== parent; parent = dir, dir = path.dirname(dir)) {
		const configPath = path.join(dir, "alive.config.json");
		if (!fs.existsSync(configPath)) continue;
		const candidate = loadConfig({ cwd: dir, configPath });
		if (path.resolve(candidate.paths.stateDir) === rootStateDir || path.resolve(agentsRoot(candidate)) === agentsDir) return candidate;
	}
	return undefined;
}

/** Location of a profile that sits inside a managed-agents registry. */
interface AgentRegistryLocation {
	/** Absolute registry directory (`<root>/.alive/agents` by default). */
	registry: string;
	/** Agent id: the agent directory name. */
	id: string;
	configPath: string;
}

/** Recognise `<registry>/<id>/alive.config.json`. */
function registryLocation(configPath: string): AgentRegistryLocation | undefined {
	const resolved = path.resolve(configPath);
	if (path.basename(resolved) !== "alive.config.json") return undefined;
	const directory = path.dirname(resolved);
	const id = path.basename(directory);
	if (normalizedAgentId(id) !== id) return undefined;
	return { registry: path.dirname(directory), id, configPath: resolved };
}

/**
 * The registry a managed profile actually lives in, validated.
 *
 * The registry must be owned by a root profile and must list this exact config
 * under this exact id. A profile that declares a different *absolute* agents
 * directory is not a profile of that registry: it is genuinely orphaned and must
 * not acquire an identity it does not have (#95). A relative declaration inside
 * a managed profile always resolves inside its own directory, so it carries no
 * information about the shared registry and is ignored.
 */
function managedRegistryLocation(config: LoadedConfig): AgentRegistryLocation | undefined {
	const configPath = path.resolve(config.paths.configPath);
	const location = registryLocation(configPath);
	if (!location) return undefined;
	const declared = config.config.agentsDirectory.trim();
	if (declared && path.isAbsolute(declared) && path.resolve(config.paths.rootDir, declared) !== location.registry) return undefined;
	const owner = registryOwner(location.registry);
	if (!owner || path.resolve(owner.paths.configPath) === configPath) return undefined;
	const listed = listAgents(owner).find((agent) => agent.id === location.id);
	if (!listed || path.resolve(listed.configPath) !== location.configPath) return undefined;
	return location;
}

/**
 * The profile that owns an agents registry: the config whose `agentsRoot()` is
 * exactly `registry`. Searched upward from the registry, never inside it, so a
 * managed profile (which declares the shared registry too) can never be taken
 * for its owner.
 */
function registryOwner(registry: string): LoadedConfig | undefined {
	const target = path.resolve(registry);
	for (let dir = path.dirname(target), parent = ""; dir !== parent; parent = dir, dir = path.dirname(dir)) {
		const configPath = path.join(dir, "alive.config.json");
		if (!fs.existsSync(configPath)) continue;
		const candidate = loadConfig({ cwd: dir, configPath });
		if (ownsRegistry(candidate, target)) return candidate;
	}
	return undefined;
}

function ownsRegistry(candidate: LoadedConfig, registry: string): boolean {
	const target = path.resolve(registry);
	const candidateConfig = path.resolve(candidate.paths.configPath);
	// A profile inside the registry (a managed agent) never owns it, even when it
	// declares the shared registry as its own agents directory.
	if (candidateConfig === target || candidateConfig.startsWith(`${target}${path.sep}`)) return false;
	return path.resolve(agentsRoot(candidate)) === target;
}

function ownsStateDir(candidate: LoadedConfig, config: LoadedConfig): boolean {
	const agentsDir = path.resolve(agentsRoot(config));
	return path.resolve(candidate.paths.stateDir) === path.dirname(agentsDir) || path.resolve(agentsRoot(candidate)) === agentsDir;
}

/**
 * The config whose `agentsRoot()` lists the agents reachable from this profile.
 *
 * For a managed profile that is the root owning its registry, because a managed
 * profile's own state-dir-derived registry is empty and must never be used to
 * address peers (#148). Every other profile keeps its own registry.
 */
function registryConfigFor(config: LoadedConfig): LoadedConfig {
	const location = managedRegistryLocation(config);
	if (!location) return config;
	return registryOwner(location.registry) ?? config;
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
	const root = rootProfile(config);
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

/**
 * Canonical managed id of a profile, or `undefined` when it is not a managed
 * profile.
 *
 * A managed profile's own `agentsRoot()` is derived from its private state
 * directory, so looking only there cannot find the registry the profile lives
 * in (#148). The registry that contains the config is authoritative: when the
 * config path is `<registry>/<id>/alive.config.json`, the profile id is the
 * directory name and the registry is the parent directory. The state-dir lookup
 * remains as a fallback for profiles outside a registry layout.
 */
export function managedAgentId(config: LoadedConfig): string | undefined {
	const configPath = path.resolve(config.paths.configPath);
	const location = managedRegistryLocation(config);
	if (location) return location.id;
	return listAgents(config).find((agent) => path.resolve(agent.configPath) === configPath)?.id;
}

function normalizedAgentId(value: string): string | undefined {
	try {
		return validateAgentId(value);
	} catch {
		return undefined;
	}
}
