import { randomUUID } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import { DEFAULT_CONFIG, DEFAULT_CONTRACT, loadConfig, resolveMemoryDatabasePath, type AgentManagementPermissions, type LoadedConfig } from "./config.js";
import { migrateConfigSecrets, readEnvFileValues } from "./config-secrets.js";
import { snapshotRuntime, spawnBackground, stopRuntime, waitForRuntime } from "./runtime/daemon.js";
import { sleep } from "./util.js";
import { mergeSandboxConfig, type SandboxConfig } from "./sandbox/config.js";
import { DEFAULT_WORKERS_CONFIG } from "./workers/config.js";

const ID_RE = /^[a-z0-9][a-z0-9_-]{0,47}$/;

export interface ManagedAgent {
	id: string;
	directory: string;
	configPath: string;
}

export function validateAgentId(id: string): string {
	const normalized = id.trim().toLowerCase();
	if (!ID_RE.test(normalized)) throw new Error("agent id must match [a-z0-9][a-z0-9_-]{0,47}");
	return normalized;
}

export function agentsRoot(config: LoadedConfig): string {
	const configured = config.config.agentsDirectory.trim();
	return configured ? path.resolve(config.paths.rootDir, configured) : path.join(config.paths.stateDir, "agents");
}

export function listAgents(config: LoadedConfig): ManagedAgent[] {
	const root = agentsRoot(config);
	if (!fs.existsSync(root)) return [];
	return fs.readdirSync(root, { withFileTypes: true })
		.filter((entry) => entry.isDirectory() && ID_RE.test(entry.name))
		.map((entry) => ({ id: entry.name, directory: path.join(root, entry.name), configPath: path.join(root, entry.name, "alive.config.json") }))
		.filter((agent) => fs.existsSync(agent.configPath));
}

export interface CreateAgentOptions {
	role?: string;
	contract?: string;
	toolAllowlist?: string[];
	management?: AgentManagementPermissions;
	/** Operator-owned setting; agent tools deliberately cannot grant host access. */
	sandbox?: Partial<SandboxConfig>;
}

export const NO_AGENT_MANAGEMENT: AgentManagementPermissions = {
	create: false, edit: false, start: false, stop: false, enable: false,
	configurePermissions: false, targets: [], grantableTools: [],
};

export const ADMIN_AGENT_MANAGEMENT: AgentManagementPermissions = {
	create: true, edit: true, start: true, stop: true, enable: true,
	configurePermissions: true, targets: ["*"], grantableTools: [],
};

export function createAgent(base: LoadedConfig, idInput: string, name?: string, options: CreateAgentOptions = {}): ManagedAgent {
	const id = validateAgentId(idInput);
	const directory = path.join(agentsRoot(base), id);
	if (fs.existsSync(directory)) throw new Error(`agent already exists: ${id}`);
	const allowedTools = validateToolAllowlist(
		options.toolAllowlist ?? base.config.tools.allowlist.filter((name) => name !== "create_agent" && name !== "tool_registry" && name !== "worker"),
	);
	const role = options.role?.trim() || `Agent ${name?.trim() || id}`;
	const contract = options.contract?.trim() || DEFAULT_CONTRACT;
	if (!role || !contract) throw new Error("agent role and contract must not be empty");
	const sandboxConfig = mergeSandboxConfig(base.config.sandbox, options.sandbox);
	fs.mkdirSync(directory, { recursive: true });
	const configPath = path.join(directory, "alive.config.json");
	const soulPath = path.join(directory, "SOUL.md");
	const contractPath = path.join(directory, "CONTRACT.md");
	const config = structuredClone(base.config);
	config.name = name?.trim() || id;
	config.stateDir = path.join(directory, "state");
	config.agentsDirectory = agentsRoot(base);
	// Keep the root profile addressable from any depth: a managed profile created by
	// another managed profile still points at the original root config.
	config.rootConfigPath = base.config.rootConfigPath.trim()
		? path.resolve(base.paths.rootDir, base.config.rootConfigPath)
		: base.paths.configPath;
	config.enabled = true;
	config.agentManagement = validateAgentManagementPermissions(options.management ?? NO_AGENT_MANAGEMENT);
	// Workers are a host-side operator grant. Persistent profiles never inherit
	// them from the creator: an agent tool must not be able to mint host coding
	// sessions. An operator enables them explicitly in the profile config.
	config.workers = structuredClone(DEFAULT_WORKERS_CONFIG);
	config.workspace = path.join(directory, "workspace");
	config.sandbox = sandboxConfig;
	config.soulFile = soulPath;
	// Managed agents may share the database, but memory tools enforce private scope by default.
	config.memory.databasePath = resolveMemoryDatabasePath(base);
	config.memory.sharedScopes = [];
	config.tools.allowlist = allowedTools;
	// Every agent needs its own bot identity. Keep Telegram off until explicitly configured.
	config.modules.telegram.enabled = false;
	config.modules.telegram.token = "";
	config.modules.grafana.token = "";
	fs.writeFileSync(configPath, `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600 });
	fs.writeFileSync(soulPath, fs.readFileSync(base.paths.soulPath, "utf8"), { mode: 0o600 });
	// Contracts are per-agent onboarding artifacts; do not copy the creator's personal preferences.
	fs.writeFileSync(contractPath, `# Role: ${role}\n\n${contract}\n`, { mode: 0o600 });
	fs.mkdirSync(config.workspace, { recursive: true });
	return { id, directory, configPath };
}

const TOOL_NAME_RE = /^[a-zA-Z][a-zA-Z0-9_-]{0,63}$/;

export function validateToolAllowlist(names: string[]): string[] {
	if (!Array.isArray(names) || names.some((name) => typeof name !== "string" || !TOOL_NAME_RE.test(name))) {
		throw new Error("tool allowlist must contain valid tool names");
	}
	return [...new Set(names)];
}

export function ensureAdminAgent(base: LoadedConfig): ManagedAgent {
	const existing = listAgents(base).find((agent) => agent.id === "admin");
	if (!existing) {
		const safeTools = base.config.tools.allowlist.filter((name) => name !== "bash" && name !== "write" && name !== "edit" && name !== "worker");
		return createAgent(base, "admin", "Alive Admin", {
			role: "Administrator",
			contract: "Manage the creation, configuration, permissions, and lifecycle of persistent agents. Grant each agent only the tools and actions it needs.",
			toolAllowlist: [...safeTools, "create_agent", "manage_agents"],
			management: { ...ADMIN_AGENT_MANAGEMENT, grantableTools: [...new Set([...base.config.tools.allowlist, "create_agent", "manage_agents"])] },
		});
	}
	const raw = readAgentConfig(existing);
	raw.agentManagement = { ...ADMIN_AGENT_MANAGEMENT, grantableTools: [...new Set([...(raw.agentManagement?.grantableTools ?? []), ...base.config.tools.allowlist, "create_agent", "manage_agents"])] };
	raw.tools = { ...raw.tools, allowlist: [...new Set([...(raw.tools?.allowlist ?? []), "create_agent", "manage_agents"])] };
	writeJsonPrivate(existing.configPath, raw);
	return existing;
}

export function canCreateAgents(config: LoadedConfig): boolean {
	return config.config.tools.allowlist.includes("create_agent") && config.config.agentManagement.create;
}

export function validateAgentManagementPermissions(value: AgentManagementPermissions): AgentManagementPermissions {
	if (!value || typeof value !== "object") throw new Error("agent management permissions are required");
	const flags: Array<keyof Omit<AgentManagementPermissions, "targets" | "grantableTools">> = ["create", "edit", "start", "stop", "enable", "configurePermissions"];
	for (const flag of flags) if (typeof value[flag] !== "boolean") throw new Error(`agentManagement.${flag} must be boolean`);
	if (!Array.isArray(value.targets) || value.targets.some((target) => typeof target !== "string" || (target !== "*" && !ID_RE.test(target)))) {
		throw new Error("agent management targets must be valid managed agent ids or '*'");
	}
	const grantableTools = value.grantableTools ?? [];
	if (!Array.isArray(grantableTools) || grantableTools.some((tool) => typeof tool !== "string" || !TOOL_NAME_RE.test(tool))) {
		throw new Error("agent management grantableTools must contain valid tool names");
	}
	return { ...value, targets: [...new Set(value.targets)], grantableTools: [...new Set(grantableTools)] };
}

export function canManageAgent(actor: LoadedConfig, capability: keyof Omit<AgentManagementPermissions, "targets">, targetId: string): boolean {
	const permission = actor.config.agentManagement;
	return permission[capability] && (permission.targets.includes("*") || permission.targets.includes(targetId));
}

export function assertCanDelegate(
	actor: LoadedConfig,
	toolAllowlist: string[],
	management: AgentManagementPermissions,
): void {
	const requested = validateAgentManagementPermissions(management);
	const actorPermissions = actor.config.agentManagement;
	for (const capability of Object.keys(requested).filter((key) => key !== "targets" && key !== "grantableTools") as Array<keyof Omit<AgentManagementPermissions, "targets" | "grantableTools">>) {
		if (requested[capability] && !actorPermissions[capability]) throw new Error(`cannot grant agentManagement.${capability}: this agent does not have that capability`);
	}
	const allowedTargets = new Set(actorPermissions.targets);
	if (requested.targets.some((target) => !allowedTargets.has("*") && !allowedTargets.has(target))) {
		throw new Error("cannot grant management access to targets outside this agent's own target allowlist");
	}
	const grantableTools = new Set(actorPermissions.grantableTools);
	if (requested.grantableTools.some((tool) => !grantableTools.has(tool))) throw new Error("cannot delegate tool-grant authority beyond this agent's own grantableTools");
	if (toolAllowlist.some((tool) => !grantableTools.has(tool))) throw new Error("cannot grant tools outside this agent's grantableTools permission");
}

export function updateAgentProfile(
	base: LoadedConfig,
	idInput: string,
	updates: { name?: string; role?: string; contract?: string; toolAllowlist?: string[]; management?: AgentManagementPermissions; sandbox?: Partial<SandboxConfig> },
): ManagedAgent {
	const agent = findManagedAgent(base, idInput);
	const raw = readAgentConfig(agent);
	if (updates.name !== undefined) {
		const name = updates.name.trim();
		if (!name) throw new Error("agent name cannot be empty");
		raw.name = name;
	}
	if (updates.toolAllowlist !== undefined) {
		raw.tools = { ...raw.tools, allowlist: validateToolAllowlist(updates.toolAllowlist) };
	}
	if (updates.management !== undefined) raw.agentManagement = validateAgentManagementPermissions(updates.management);
	if (updates.sandbox !== undefined) {
		raw.sandbox = mergeSandboxConfig(loadAgentConfig(base, agent).config.sandbox, updates.sandbox);
	}
	if (updates.role !== undefined || updates.contract !== undefined) {
		const contractPath = path.join(agent.directory, "CONTRACT.md");
		const oldContract = fs.existsSync(contractPath) ? fs.readFileSync(contractPath, "utf8") : DEFAULT_CONTRACT;
		const contract = updates.contract?.trim() || oldContract.replace(/^# Role: .*\n/, "").trim();
		const role = updates.role?.trim() || oldContract.match(/^# Role: (.*)$/m)?.[1] || `Agent ${agent.id}`;
		if (!role || !contract) throw new Error("agent role and contract must not be empty");
		writeTextPrivate(contractPath, `# Role: ${role}\n\n${contract}\n`);
	}
	writeJsonPrivate(agent.configPath, raw);
	return agent;
}

export function getAgentEnabled(agent: ManagedAgent): boolean {
	return readAgentConfig(agent).enabled !== false;
}

export async function updateManagedAgentProfile(
	base: LoadedConfig,
	idInput: string,
	updates: { name?: string; role?: string; contract?: string; toolAllowlist?: string[]; management?: AgentManagementPermissions; sandbox?: Partial<SandboxConfig> },
): Promise<ManagedAgent> {
	const agent = findManagedAgent(base, idInput);
	return withAgentLifecycleLock(base, agent.id, async () => {
		const config = loadAgentConfig(base, agent);
		const wasRunning = snapshotRuntime(config.paths.stateDir)?.alive ?? false;
		updateAgentProfile(base, agent.id, updates);
		if (wasRunning) {
			await stopManagedAgentUnlocked(base, agent);
			if (getAgentEnabled(agent)) await startManagedAgentUnlocked(base, agent);
		}
		return agent;
	});
}

/**
 * Atomic directory lock shared by CLI and agent processes. Never reclaims an
 * unknown/stale lock automatically: after a crash, an operator must verify no
 * manager still owns the target before removing the reported lock directory.
 */
export async function withAgentLifecycleLock<T>(
	base: LoadedConfig,
	idInput: string,
	operation: () => Promise<T> | T,
	options: { timeoutMs?: number; pollMs?: number; onLockContention?: () => void } = {},
): Promise<T> {
	const agent = findManagedAgent(base, idInput);
	const lockDirectory = path.join(agent.directory, ".lifecycle.lock");
	const token = randomUUID();
	const deadline = Date.now() + (options.timeoutMs ?? 90_000);
	const pollMs = options.pollMs ?? 25;
	fs.mkdirSync(agent.directory, { recursive: true });
	let acquired = false;
	let reportedContention = false;
	while (!acquired) {
		try {
			fs.mkdirSync(lockDirectory);
			acquired = true;
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
			if (!reportedContention) {
				reportedContention = true;
				options.onLockContention?.();
			}
			if (Date.now() >= deadline) {
				let owner = "owner metadata is unavailable";
				try { owner = fs.readFileSync(path.join(lockDirectory, "owner.json"), "utf8").trim() || owner; } catch {}
				throw new Error(`agent ${agent.id} lifecycle lock is busy or stale (${owner}); refusing the operation; verify no manager is running before removing ${lockDirectory}`);
			}
			await sleep(Math.min(pollMs, Math.max(1, deadline - Date.now())));
		}
	}
	const ownerFile = path.join(lockDirectory, "owner.json");
	try {
		fs.writeFileSync(ownerFile, JSON.stringify({ pid: process.pid, token, startedAt: Date.now() }), { flag: "wx", mode: 0o600 });
		return await operation();
	} finally {
		try {
			const owner = JSON.parse(fs.readFileSync(ownerFile, "utf8")) as { token?: string };
			if (owner.token === token) fs.rmSync(lockDirectory, { recursive: true, force: true });
		} catch {
			// Keep an unrecognized lock in place: deleting a lock of uncertain ownership is unsafe.
		}
	}
}

export async function enableManagedAgent(base: LoadedConfig, idInput: string): Promise<ManagedAgent> {
	const agent = findManagedAgent(base, idInput);
	return withAgentLifecycleLock(base, agent.id, () => {
		writeAgentEnabled(agent, true);
		return agent;
	});
}

export interface ManagedAgentStartOperations {
	spawn: typeof spawnBackground;
	wait: typeof waitForRuntime;
}

export async function startManagedAgent(
	base: LoadedConfig,
	idInput: string,
	operations: ManagedAgentStartOperations = { spawn: spawnBackground, wait: waitForRuntime },
): Promise<{ pid: number; logFile: string }> {
	const agent = findManagedAgent(base, idInput);
	return withAgentLifecycleLock(base, agent.id, () => startManagedAgentUnlocked(base, agent, operations));
}

async function startManagedAgentUnlocked(
	base: LoadedConfig,
	agent: ManagedAgent,
	operations: ManagedAgentStartOperations = { spawn: spawnBackground, wait: waitForRuntime },
): Promise<{ pid: number; logFile: string }> {
	if (!getAgentEnabled(agent)) throw new Error(`agent ${agent.id} is disabled and cannot be started`);
	const config = loadAgentConfig(base, agent);
	const current = snapshotRuntime(config.paths.stateDir);
	if (current?.alive) return { pid: current.pid, logFile: path.join(config.paths.logsDir, "stdout.log") };
	const child = operations.spawn({ paths: config.paths, args: ["--config", agent.configPath] });
	const started = await operations.wait(config.paths.stateDir, child.pid, { child: child.child });
	if (!started) throw new Error(`agent ${agent.id} failed to start; see ${child.logFile}`);
	return { pid: child.pid, logFile: child.logFile };
}

export async function stopManagedAgent(base: LoadedConfig, idInput: string): Promise<void> {
	const agent = findManagedAgent(base, idInput);
	await withAgentLifecycleLock(base, agent.id, () => stopManagedAgentUnlocked(base, agent));
}

export async function restartManagedAgent(base: LoadedConfig, idInput: string): Promise<{ pid: number; logFile: string }> {
	const agent = findManagedAgent(base, idInput);
	return withAgentLifecycleLock(base, agent.id, async () => {
		if (!getAgentEnabled(agent)) throw new Error(`agent ${agent.id} is disabled and cannot be restarted`);
		await stopManagedAgentUnlocked(base, agent);
		return startManagedAgentUnlocked(base, agent);
	});
}

async function stopManagedAgentUnlocked(base: LoadedConfig, agent: ManagedAgent): Promise<void> {
	const config = loadAgentConfig(base, agent);
	const result = await stopRuntime(config.paths.stateDir);
	if (!result.stopped) throw new Error(result.error ?? `agent ${agent.id} could not be stopped`);
}

export async function disableManagedAgent(
	base: LoadedConfig,
	idInput: string,
	options: { onLockContention?: () => void } = {},
): Promise<void> {
	const agent = findManagedAgent(base, idInput);
	await withAgentLifecycleLock(base, agent.id, async () => {
		writeAgentEnabled(agent, false);
		await stopManagedAgentUnlocked(base, agent);
		const config = loadAgentConfig(base, agent);
		if (snapshotRuntime(config.paths.stateDir)?.alive) throw new Error(`agent ${agent.id} remains running; it is disabled but must be stopped manually`);
	}, options);
}

function writeAgentEnabled(agent: ManagedAgent, enabled: boolean): void {
	const raw = readAgentConfig(agent);
	raw.enabled = enabled;
	writeJsonPrivate(agent.configPath, raw);
}

export function findManagedAgent(base: LoadedConfig, idInput: string): ManagedAgent {
	const id = validateAgentId(idInput);
	const agent = listAgents(base).find((item) => item.id === id);
	if (!agent) throw new Error(`unknown managed agent: ${id}`);
	return agent;
}

function loadAgentConfig(base: LoadedConfig, agent: ManagedAgent): LoadedConfig {
	return loadConfig({ cwd: base.paths.rootDir, configPath: agent.configPath });
}

function readAgentConfig(agent: ManagedAgent): any {
	return JSON.parse(fs.readFileSync(agent.configPath, "utf8"));
}

function writeJsonPrivate(file: string, value: unknown): void {
	writeTextPrivate(file, `${JSON.stringify(value, null, 2)}\n`);
}

function writeTextPrivate(file: string, value: string): void {
	const temporary = `${file}.${process.pid}.${Date.now()}.tmp`;
	fs.writeFileSync(temporary, value, { mode: 0o600 });
	fs.renameSync(temporary, file);
	fs.chmodSync(file, 0o600);
}

/** A request is pending until Telegram confirms, the operator cancels, or the TTL passes. */
export type ManagedBotRequestStatus = "pending" | "created" | "expired" | "failed";
type ManagedBotTerminalStatus = Exclude<ManagedBotRequestStatus, "pending">;

export interface ManagedBotRequest {
	agentId: string;
	chatId: number;
	requestedAt: number;
	/** Absent while the request is pending; terminal states remain for the status view. */
	status?: ManagedBotTerminalStatus;
	statusAt?: number;
	/** Failure reason; never contains a bot token. */
	error?: string;
	botUsername?: string;
}

function managedBotRequestFile(root: string): string {
	return path.join(root, "managed-bot-requests.json");
}

export function listManagedBotRequests(root: string): ManagedBotRequest[] {
	const file = managedBotRequestFile(root);
	if (!fs.existsSync(file)) return [];
	const parsed = JSON.parse(fs.readFileSync(file, "utf8")) as ManagedBotRequest[];
	return Array.isArray(parsed) ? parsed : [];
}

function writeManagedBotRequests(root: string, requests: ManagedBotRequest[]): void {
	fs.mkdirSync(root, { recursive: true });
	const file = managedBotRequestFile(root);
	const temporary = `${file}.${process.pid}.${Date.now()}.tmp`;
	fs.writeFileSync(temporary, `${JSON.stringify(requests, null, 2)}\n`, { mode: 0o600 });
	fs.renameSync(temporary, file);
	fs.chmodSync(file, 0o600);
}

export function managedBotRequestStatus(request: ManagedBotRequest, ttlMs: number, now = Date.now()): ManagedBotRequestStatus {
	if (request.status) return request.status;
	return now - request.requestedAt >= ttlMs ? "expired" : "pending";
}

/** Store a fresh pending request, keeping at most one row per agent and chat. */
export function queueManagedBotRequest(root: string, request: ManagedBotRequest): void {
	const requests = listManagedBotRequests(root).filter((item) => item.agentId !== request.agentId && item.chatId !== request.chatId);
	requests.push(request);
	writeManagedBotRequests(root, requests);
}

/** Latest request for a chat that has not reached a terminal state yet. */
export function findManagedBotRequest(root: string, chatId: number): ManagedBotRequest | undefined {
	return listManagedBotRequests(root).filter((item) => item.chatId === chatId && !item.status).at(-1);
}

export function markManagedBotRequest(
	root: string,
	request: ManagedBotRequest,
	status: ManagedBotTerminalStatus,
	details: { error?: string; botUsername?: string } = {},
): void {
	const requests = listManagedBotRequests(root);
	const match = requests.find((item) => item.agentId === request.agentId && item.chatId === request.chatId && item.requestedAt === request.requestedAt);
	if (!match) return;
	match.status = status;
	match.statusAt = Date.now();
	if (details.error !== undefined) match.error = details.error;
	if (details.botUsername !== undefined) match.botUsername = details.botUsername;
	writeManagedBotRequests(root, requests);
}

export function clearManagedBotRequest(root: string, request: ManagedBotRequest): void {
	const requests = listManagedBotRequests(root).filter(
		(item) => item.agentId !== request.agentId || item.chatId !== request.chatId || item.requestedAt !== request.requestedAt,
	);
	writeManagedBotRequests(root, requests);
}

/** Remove every not-yet-terminal request for one agent and return what was removed. */
export function cancelManagedBotRequests(root: string, agentId: string): ManagedBotRequest[] {
	const requests = listManagedBotRequests(root);
	const removed = requests.filter((item) => item.agentId === agentId && !item.status);
	if (removed.length > 0) writeManagedBotRequests(root, requests.filter((item) => !removed.includes(item)));
	return removed;
}

function removePlaintextManagedToken(agent: ManagedAgent, envName: string): void {
	try {
		const current = readAgentConfig(agent);
		current.modules ??= {};
		current.modules.telegram ??= {};
		current.modules.telegram.token = "";
		current.modules.telegram.tokenEnv = envName;
		writeJsonPrivate(agent.configPath, current);
	} catch {
		// A read-only config cannot be cleaned; surface the original error instead.
	}
}

/** Keep the bot token in `.env` (0600) and only its variable name in the config. */
export function attachManagedBotToken(agent: ManagedAgent, token: string, bot: { id: number; username?: string }): void {
	if (!token.trim()) throw new Error("Telegram returned an empty managed-bot token");
	const envName = `ALIVE_TELEGRAM_${agent.id.replace(/[^A-Za-z0-9]+/g, "_").replace(/^_+|_+$/g, "").toUpperCase()}_${bot.id}_TOKEN`;
	const raw = readAgentConfig(agent);
	raw.modules ??= {};
	raw.modules.telegram ??= {};
	raw.modules.telegram.enabled = true;
	raw.modules.telegram.token = token;
	raw.modules.telegram.tokenEnv = envName;
	// Persist through the one migration path that owns `.env` formatting and permissions.
	writeJsonPrivate(agent.configPath, raw);
	try {
		migrateConfigSecrets({
			configPaths: [agent.configPath],
			envPath: path.join(agent.directory, ".env"),
			env: {},
			defaults: DEFAULT_CONFIG,
			log: () => undefined,
			warn: () => undefined,
		});
	} catch (error) {
		removePlaintextManagedToken(agent, envName);
		throw error;
	}
	const stored = readAgentConfig(agent);
	if (typeof stored.modules?.telegram?.token === "string" && stored.modules.telegram.token) {
		// Never leave a plaintext token behind, even if the helper could not finish.
		removePlaintextManagedToken(agent, envName);
		throw new Error("could not move the Telegram bot token into .env; the token was removed from the agent config");
	}
	if (stored.modules?.telegram?.tokenEnv !== envName) {
		stored.modules ??= {};
		stored.modules.telegram ??= {};
		stored.modules.telegram.tokenEnv = envName;
		writeJsonPrivate(agent.configPath, stored);
	}
	if (readEnvFileValues(path.join(agent.directory, ".env"))[envName] !== token) {
		throw new Error(`the Telegram bot token was not stored in .env as ${envName}`);
	}
	writeTextPrivate(path.join(agent.directory, "telegram-managed-bot.json"), `${JSON.stringify(bot, null, 2)}\n`);
}

export function configureAgentTelegram(agent: ManagedAgent, tokenEnv: string): void {
	if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(tokenEnv)) throw new Error("token environment variable name is invalid");
	const raw = JSON.parse(fs.readFileSync(agent.configPath, "utf8"));
	raw.modules.telegram.enabled = true;
	raw.modules.telegram.token = "";
	raw.modules.telegram.tokenEnv = tokenEnv;
	fs.writeFileSync(agent.configPath, `${JSON.stringify(raw, null, 2)}\n`, { mode: 0o600 });
}
