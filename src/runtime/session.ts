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
import { SandboxManager } from "../sandbox/manager.js";
import { createSandboxTools } from "../sandbox/tools.js";

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
	/** Runtime-scoped owner; must be reused across context resets. */
	sandbox?: SandboxManager;
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
	const isolated = cfg.sandbox.enabled;
	if (isolated && !options.sandbox) throw new Error("An isolated session requires a runtime-scoped SandboxManager");
	if (isolated && cfg.extensions.length) throw new Error("Host pi extensions are disabled for isolated profiles; remove extensions or explicitly disable sandboxing");
	const workspace = isolated ? options.sandbox!.workspaceDir : paths.workspaceDir;
	const sandboxTools = isolated ? createSandboxTools(options.sandbox!, config) : [];
	// Only the explicitly configured shared-browser module may cross this boundary.
	// Its scoped protocol is a trusted host service; the legacy host browser and
	// dedicated engines remain unavailable to isolated profiles.
	const sharedBrowser = cfg.modules.browser?.enabled === true && !!cfg.modules.browser.sharedUrl && toolDeps.moduleTools.some((tool) => tool.name === "browser");
	const blockedHostTools = new Set(["web_search", ...(!sharedBrowser ? ["browser"] : [])]);
	const reserved = new Set([...sandboxTools.map((tool) => tool.name), ...blockedHostTools, "tool_registry"]);
	if (isolated && toolDeps.moduleTools.some((tool) => reserved.has(tool.name))) throw new Error("Module tools cannot override isolated filesystem/shell tools");

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
		workspace,
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
		noExtensions: isolated,
		noSkills: isolated,
		noPromptTemplates: isolated,
		noContextFiles: isolated,
		systemPrompt: isolated ? `${systemPrompt}\n\nShell and file tools run in microsandbox, never on the host. Your guest home and workspace is ${workspace} in a private persistent volume. The host workspace is not mounted. Memory, messaging and explicitly granted module tools are trusted host services. ${sharedBrowser ? "Browser tools use only the authenticated shared host with a conversation-owned context; no local browser fallback is available." : "Host browser tools are unavailable."} Host web_search and executable tool registry are unavailable. Pin critical services with sandbox_control before starting them. VM shutdown requires two empty process/Docker observations; holds prevent shutdown. Ordinary workspace file operations may run without a VM only while it is stopped; running VM writes always use guest permissions/inotify. Shared resources are under configured guest mount paths. No host fallback on sandbox errors.` : systemPrompt,
		additionalExtensionPaths: isolated ? [] : [...cfg.extensions, toolboxExtensionPath],
	});
	await resourceLoader.reload();
	for (const error of resourceLoader.getExtensions().errors) {
		log.warn("extension failed to load", { path: error.path, error: error.error });
	}

	const sandboxBuiltins = new Set(["read", "write", "edit", "bash", "grep", "find", "ls"]);
	const builtinTools = cfg.tools.builtin.filter((tool) => (!isolated || sandboxBuiltins.has(tool)) && (tool !== "bash" || cfg.tools.bash));
	const persistedTools = isolated ? [] : readPersistedToolNames(path.join(paths.stateDir, "tools", "registry.json"));
	const allowedTools = selectAllowedTools({
		allowlist: cfg.tools.allowlist,
		builtins: builtinTools,
		alive: isolated ? [...ALIVE_TOOL_NAMES.filter((name) => !blockedHostTools.has(name)), "file", "sandbox_control"] : [...ALIVE_TOOL_NAMES],
		modules: toolDeps.moduleTools.map((tool) => tool.name),
		sandbox: sandboxTools.map((tool) => tool.name),
		custom: persistedTools,
		toolRegistryAvailable: !isolated,
	});

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
		// noTools alone only changes initial activation in Pi; tools is also the
		// SDK-level name ceiling, so future host builtins cannot become active.
		noTools: isolated ? "builtin" : undefined,
		tools: isolated ? allowedTools : undefined,
		customTools: isolated
			? [...createAliveTools(toolDeps).filter((tool) => !blockedHostTools.has(tool.name)), ...sandboxTools]
			: createAliveTools(toolDeps),
		resourceLoader,
		sessionManager,
		settingsManager,
	});

	// Extensions may register tools, but only names selected below become active.
	// The same configured allowlist is enforced by the toolbox extension for tools
	// created or loaded after this initial activation.
	session.setActiveToolsByName(allowedTools);

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
	sandbox?: string[];
	custom: string[];
	toolRegistryAvailable?: boolean;
}): string[] {
	const allowed = new Set(input.allowlist);
	const candidates = [
		...input.builtins,
		...input.alive,
		...input.modules,
		...(input.sandbox ?? []),
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
