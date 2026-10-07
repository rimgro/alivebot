import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import type { ThinkingLevel } from "@earendil-works/pi-agent-core";
import type { Model } from "@earendil-works/pi-ai";
import {
	createAgentSession,
	DefaultResourceLoader,
	ModelRuntime,
	resolveCliModel,
	SessionManager,
	SettingsManager,
	type AgentSession,
} from "@earendil-works/pi-coding-agent";
import { DEFAULT_CONTRACT, type LoadedConfig } from "../config.js";
import { defaultModelSpec } from "../config.js";
import type { Logger } from "../log.js";
import { ensureDir } from "../util.js";
import { buildSystemPrompt } from "./prompt.js";
import { ALIVE_TOOL_NAMES, createAliveTools, type ToolDeps } from "./tools.js";

export interface AgentBuildResult {
	session: AgentSession;
	model: Model<any> | undefined;
	modelRuntime: ModelRuntime;
	modelFallbackMessage?: string;
}

export interface BuildAgentOptions {
	config: LoadedConfig;
	toolDeps: ToolDeps;
	log: Logger;
	soul: string;
	/** Ignore `config.session` and start a brand-new transcript (used after a sleep). */
	forceNewSession?: boolean;
}

/**
 * Build the pi coding-agent session that backs this runtime.
 *
 * We use the SDK in-process (not RPC/TUI). Everything is explicit:
 *  - a dedicated pi agent dir, so the alive agent does not load the user's
 *    interactive extensions by accident,
 *  - credentials/models are read from the shared pi agent dir,
 *  - the system prompt is ours, and it is stable across wakes for prompt caching,
 *  - the tool surface = pi built-ins (read/write/edit/bash/grep/find/ls) plus the
 *    alive tool set (send_message, idle, sleep, notifications, remind, note, journal, ...).
 */
export async function buildAgent(options: BuildAgentOptions): Promise<AgentBuildResult> {
	const { config, toolDeps, log, soul } = options;
	const { config: cfg, paths } = config;

	ensureDir(paths.agentDir);
	ensureDir(paths.sessionsDir);
	ensureDir(paths.workspaceDir);

	const modelRuntime = await ModelRuntime.create({
		authPath: path.join(cfg.piAgentDir, "auth.json"),
		modelsPath: path.join(cfg.piAgentDir, "models.json"),
	});

	const modelSpec = cfg.model.trim() || defaultModelSpec(cfg.piAgentDir);
	let model: Model<any> | undefined;
	let resolvedThinking = cfg.thinkingLevel.trim();
	if (modelSpec) {
		const resolved = resolveCliModel({ cliModel: modelSpec, modelRuntime });
		if (resolved.error) {
			log.warn(`cannot resolve model "${modelSpec}"; falling back to runtime defaults`, { error: resolved.error });
		} else {
			if (resolved.warning) log.warn("model resolution warning", { warning: resolved.warning });
			model = resolved.model;
			resolvedThinking = resolvedThinking || resolved.thinkingLevel || "";
		}
	}

	const systemPrompt = buildSystemPrompt({
		name: cfg.name,
		soul,
		contract: readContract(paths.contractPath),
		workspace: paths.workspaceDir,
		stateDir: paths.stateDir,
		runTimeoutMs: cfg.loop.runTimeoutMs,
		sleepAfterMs: cfg.loop.sleepAfterMs,
	});

	const settingsManager = SettingsManager.inMemory({
		compaction: { enabled: true },
		retry: { enabled: true, maxRetries: 3 },
	});

	const toolboxExtensionPath = path.join(
		path.dirname(fileURLToPath(import.meta.url)),
		`toolbox-extension${fileURLToPath(import.meta.url).endsWith(".ts") ? ".ts" : ".js"}`,
	);
	process.env.ALIVE_TOOLS_DIR = path.join(paths.stateDir, "tools");
	process.env.ALIVE_TOOL_ALLOWLIST = JSON.stringify(cfg.tools.allowlist);
	const resourceLoader = new DefaultResourceLoader({
		cwd: paths.workspaceDir,
		agentDir: paths.agentDir,
		settingsManager,
		noThemes: true,
		systemPrompt,
		additionalExtensionPaths: [...cfg.extensions, toolboxExtensionPath],
	});
	await resourceLoader.reload();
	for (const error of resourceLoader.getExtensions().errors) {
		log.warn("extension failed to load", { path: error.path, error: error.error });
	}

	const builtinTools = cfg.tools.builtin.filter((tool) => (tool === "bash" ? cfg.tools.bash : true));

	const sessionManager =
		cfg.session === "continue" && !options.forceNewSession
			? SessionManager.continueRecent(paths.workspaceDir, paths.sessionsDir)
			: SessionManager.create(paths.workspaceDir, paths.sessionsDir);

	const { session, modelFallbackMessage } = await createAgentSession({
		cwd: paths.workspaceDir,
		agentDir: paths.agentDir,
		model,
		thinkingLevel: (resolvedThinking || undefined) as ThinkingLevel | undefined,
		modelRuntime,
		customTools: createAliveTools(toolDeps),
		resourceLoader,
		sessionManager,
		settingsManager,
	});

	// Extensions may register tools, but only names selected below become active.
	// The same configured allowlist is enforced by the toolbox extension for tools
	// created or loaded after this initial activation.
	const persistedTools = readPersistedToolNames(path.join(paths.stateDir, "tools", "registry.json"));
	session.setActiveToolsByName(selectAllowedTools({
		allowlist: cfg.tools.allowlist,
		builtins: builtinTools,
		alive: [...ALIVE_TOOL_NAMES],
		modules: toolDeps.moduleTools.map((tool) => tool.name),
		custom: persistedTools,
		toolRegistryAvailable: true,
	}));

	if (modelFallbackMessage) log.warn("model fallback", { message: modelFallbackMessage });
	log.info("agent session ready", {
		sessionId: session.sessionId,
		sessionFile: session.sessionFile ?? "(none)",
		model: session.model ? `${session.model.provider}/${session.model.id}` : "(default)",
		thinkingLevel: session.thinkingLevel,
		tools: session.getActiveToolNames(),
	});

	return { session, modelRuntime, model: model ?? session.model ?? undefined, modelFallbackMessage };
}

export function selectAllowedTools(input: {
	allowlist: string[];
	builtins: string[];
	alive: string[];
	modules: string[];
	custom: string[];
	toolRegistryAvailable?: boolean;
}): string[] {
	const allowed = new Set(input.allowlist);
	const candidates = [
		...input.builtins,
		...input.alive,
		...input.modules,
		...input.custom,
		...(input.toolRegistryAvailable ? ["tool_registry"] : []),
	];
	return [...new Set(candidates.filter((name) => allowed.has(name)))];
}

function readPersistedToolNames(file: string): string[] {
	try {
		const records = JSON.parse(fs.readFileSync(file, "utf8")) as Array<{ name?: unknown }>;
		return Array.isArray(records)
			? records.map((record) => record?.name).filter((name): name is string => typeof name === "string")
			: [];
	} catch {
		return [];
	}
}

export function readSoul(file: string): string {
	try {
		return fs.readFileSync(file, "utf8");
	} catch {
		return "";
	}
}

export function readContract(file: string): string {
	try {
		return fs.readFileSync(file, "utf8");
	} catch {
		return DEFAULT_CONTRACT;
	}
}
