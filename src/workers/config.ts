/**
 * Configuration for ephemeral coding workers.
 *
 * A worker is deliberately *not* a managed agent: it has no inbox, no memory,
 * no reminders, no lifecycle of its own and no proactive behaviour. It is a
 * short-lived pi-coding-agent session that takes a task, edits files in a
 * repository (optionally an isolated git worktree), runs commands/tests and
 * reports back.
 *
 * Worker authority is a separate operator-owned permission from
 * `agentManagement`; `create_agent` must never be able to mint worker access.
 */

/** Tools a worker session may use. Workers never receive Alive tools. */
export const WORKER_BUILTIN_TOOLS = ["read", "write", "edit", "bash", "grep", "find", "ls"] as const;
export type WorkerToolName = (typeof WORKER_BUILTIN_TOOLS)[number];

export const WORKER_TOOL_NAMES = new Set<string>(WORKER_BUILTIN_TOOLS);

export interface WorkerPermissions {
	/** Start new worker sessions. */
	spawn: boolean;
	/** Send follow-up instructions to an existing worker session. */
	send: boolean;
	/** Abort a running worker or archive its record/worktree. */
	stop: boolean;
	/** Read worker status, transcript results and diffs. */
	inspect: boolean;
	/** Create isolated git worktrees and check out pull requests. */
	worktree: boolean;
	/** Push a worker branch and create a pull request. */
	pullRequest: boolean;
}

export interface WorkersConfig {
	/** Master switch. When false the worker tool is not exposed at all. */
	enabled: boolean;
	permissions: WorkerPermissions;
	/**
	 * Models this profile may assign to workers, e.g.
	 * `["anthropic/claude-sonnet-4-5", "openai/gpt-5.2:high", "anthropic/*"]`.
	 * Empty means no worker can be started.
	 */
	models: string[];
	/** Model used when the agent omits `model`. Must match `models`. */
	defaultModel: string;
	/** pi built-in tools the worker may use. */
	tools: string[];
	/** Concurrent worker runs. Finished sessions do not count. */
	maxConcurrent: number;
	/**
	 * Per-run inactivity limit: the session is aborted when no session event
	 * (turn start/end, tool execution, agent end) arrives for this long.
	 */
	idleTimeoutMs: number;
	/** Absolute per-run wall-clock ceiling; the session is aborted when exceeded. */
	maxRuntimeMs: number;
	/**
	 * Automatic retries of a transient provider failure (timeout, connection
	 * reset, 429, 5xx) inside one run. Only attempted while the run has no side
	 * effects yet: no tool executions and no new tokens.
	 */
	providerRetries: number;
	/** Base delay of the linear retry backoff (delay × attempt, capped at 60s). */
	providerRetryDelayMs: number;
	/** Repository workers operate on, relative to the worker environment root. */
	repository: string;
	/** Worktree parent inside the worker environment. Empty = environment default. */
	worktreesDirectory: string;
	/** Default git ref to branch workers from. Empty = HEAD. */
	baseRef: string;
	/** Git remote used to fetch pull-request refs and push worker branches. */
	remote: string;
	/** Default for completion events. A start call may override it. */
	notifyOnFinish: boolean;
}

export const DEFAULT_WORKERS_CONFIG: WorkersConfig = {
	enabled: false,
	permissions: {
		spawn: false,
		send: false,
		stop: false,
		inspect: false,
		worktree: false,
		pullRequest: false,
	},
	models: [],
	defaultModel: "",
	tools: [...WORKER_BUILTIN_TOOLS],
	maxConcurrent: 2,
	idleTimeoutMs: 10 * 60_000,
	maxRuntimeMs: 2 * 60 * 60_000,
	providerRetries: 2,
	providerRetryDelayMs: 5_000,
	repository: ".",
	worktreesDirectory: "",
	baseRef: "",
	remote: "origin",
	notifyOnFinish: true,
};

const MODEL_PATTERN_RE = /^[^\s]+$/;
const THINKING_LEVELS = new Set(["off", "minimal", "low", "medium", "high", "xhigh", "max"]);
const BRANCH_RE = /^[A-Za-z0-9._\/-]{1,160}$/;
const REMOTE_RE = /^[A-Za-z0-9._-]{1,80}$/;

export function validateWorkersConfig(value: WorkersConfig): WorkersConfig {
	if (!value || typeof value !== "object") throw new Error("workers configuration is required");
	if (typeof value.enabled !== "boolean") throw new Error("workers.enabled must be boolean");
	const permissions = value.permissions;
	if (!permissions || typeof permissions !== "object") throw new Error("workers.permissions is required");
	for (const key of ["spawn", "send", "stop", "inspect", "worktree", "pullRequest"] as const) {
		if (typeof permissions[key] !== "boolean") throw new Error(`workers.permissions.${key} must be boolean`);
	}
	if (permissions.pullRequest && !permissions.worktree) {
		throw new Error("workers.permissions.pullRequest requires workers.permissions.worktree");
	}
	if (!Array.isArray(value.models) || value.models.some((model) => typeof model !== "string" || !MODEL_PATTERN_RE.test(model.trim()))) {
		throw new Error("workers.models must be an array of non-empty model specs without whitespace");
	}
	const models = [...new Set(value.models.map((model) => model.trim()))];
	if (value.enabled && models.length === 0) throw new Error("workers.enabled requires at least one entry in workers.models");
	const defaultModel = typeof value.defaultModel === "string" ? value.defaultModel.trim() : "";
	if (typeof value.defaultModel !== "string") throw new Error("workers.defaultModel must be a string");
	if (defaultModel && !matchesModelAllowlist(models, defaultModel)) {
		throw new Error(`workers.defaultModel "${defaultModel}" is not covered by workers.models`);
	}
	if (!Array.isArray(value.tools) || value.tools.length === 0) throw new Error("workers.tools must be a non-empty array");
	const tools: string[] = [];
	for (const tool of value.tools) {
		if (typeof tool !== "string" || !WORKER_TOOL_NAMES.has(tool)) {
			throw new Error(`workers.tools may contain only built-in coding tools: ${[...WORKER_TOOL_NAMES].join(", ")}`);
		}
		tools.push(tool);
	}
	const maxConcurrent = Number(value.maxConcurrent);
	if (!Number.isInteger(maxConcurrent) || maxConcurrent < 1 || maxConcurrent > 16) {
		throw new Error("workers.maxConcurrent must be an integer between 1 and 16");
	}
	const idleTimeoutMs = Number(value.idleTimeoutMs);
	if (!Number.isInteger(idleTimeoutMs) || idleTimeoutMs < 1) {
		throw new Error("workers.idleTimeoutMs must be a positive integer (milliseconds)");
	}
	const maxRuntimeMs = Number(value.maxRuntimeMs);
	if (!Number.isFinite(maxRuntimeMs) || maxRuntimeMs < 10_000 || maxRuntimeMs > 24 * 60 * 60_000) {
		throw new Error("workers.maxRuntimeMs must be between 10000 and 86400000");
	}
	if (maxRuntimeMs <= idleTimeoutMs) {
		throw new Error("workers.maxRuntimeMs must be strictly greater than workers.idleTimeoutMs");
	}
	const providerRetries = Number(value.providerRetries);
	if (!Number.isInteger(providerRetries) || providerRetries < 0 || providerRetries > 10) {
		throw new Error("workers.providerRetries must be an integer between 0 and 10");
	}
	const providerRetryDelayMs = Number(value.providerRetryDelayMs);
	if (!Number.isFinite(providerRetryDelayMs) || providerRetryDelayMs < 0 || providerRetryDelayMs > 60_000) {
		throw new Error("workers.providerRetryDelayMs must be between 0 and 60000");
	}
	if (typeof value.repository !== "string" || !value.repository.trim()) throw new Error("workers.repository must be a non-empty path");
	if (typeof value.worktreesDirectory !== "string") throw new Error("workers.worktreesDirectory must be a string");
	if (typeof value.baseRef !== "string") throw new Error("workers.baseRef must be a string");
	const baseRef = value.baseRef.trim();
	if (baseRef && (baseRef.startsWith("-") || /\s/.test(baseRef))) {
		throw new Error("workers.baseRef must be a git ref without whitespace or a leading '-'");
	}
	if (typeof value.remote !== "string" || !REMOTE_RE.test(value.remote)) throw new Error("workers.remote must be a git remote name");
	if (typeof value.notifyOnFinish !== "boolean") throw new Error("workers.notifyOnFinish must be boolean");
	return {
		enabled: value.enabled,
		permissions: { ...permissions },
		models,
		defaultModel,
		tools: [...new Set(tools)],
		maxConcurrent,
		idleTimeoutMs,
		maxRuntimeMs,
		providerRetries,
		providerRetryDelayMs,
		repository: value.repository.trim(),
		worktreesDirectory: value.worktreesDirectory.trim(),
		baseRef,
		remote: value.remote,
		notifyOnFinish: value.notifyOnFinish,
	};
}

/** Split `provider/model:thinking` into its model identity and thinking level. */
export function splitModelSpec(spec: string): { base: string; thinking?: string } {
	const trimmed = spec.trim();
	const index = trimmed.lastIndexOf(":");
	if (index > 0) {
		const thinking = trimmed.slice(index + 1);
		if (THINKING_LEVELS.has(thinking)) return { base: trimmed.slice(0, index), thinking };
	}
	return { base: trimmed };
}

export function matchesModelAllowlist(models: string[], spec: string): boolean {
	const base = splitModelSpec(spec).base;
	return models.some((entry) => {
		const pattern = splitModelSpec(entry).base;
		if (!pattern.includes("*")) return pattern === base;
		const source = pattern
			.split("*")
			.map((part) => part.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))
			.join(".*");
		return new RegExp(`^${source}$`).test(base);
	});
}

/** Resolve the worker model and enforce the configured allowlist. */
export function selectWorkerModel(config: WorkersConfig, requested: string | undefined): string {
	const spec = requested?.trim() || config.defaultModel.trim();
	if (!spec) throw new Error("a worker model is required; pass `model` or configure workers.defaultModel");
	if (!matchesModelAllowlist(config.models, spec)) {
		throw new Error(`model "${spec}" is not in workers.models (${config.models.join(", ") || "empty"})`);
	}
	return spec;
}

/** A ref-like value safe to pass as one git/gh argument (never an option). */
export function validateGitRef(value: string): string {
	const trimmed = value.trim();
	if (!trimmed) return "";
	if (trimmed.startsWith("-") || /\s/.test(trimmed)) {
		throw new Error("git refs must not contain whitespace or start with '-'");
	}
	return trimmed;
}

export function validateWorkerBranch(branch: string): string {
	const trimmed = branch.trim();
	if (!BRANCH_RE.test(trimmed) || trimmed.startsWith("-") || trimmed.endsWith("/") || trimmed.includes("..") || trimmed.includes("//")) {
		throw new Error("branch must be a safe git branch name (letters, digits, . _ / -, no leading '-', no '..')");
	}
	return trimmed;
}

export function workerPermission(config: WorkersConfig, key: keyof WorkerPermissions): boolean {
	return config.enabled && config.permissions[key];
}
