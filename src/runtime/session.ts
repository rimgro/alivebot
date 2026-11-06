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
import { DEFAULT_COMPACT_KEEP_TOOLS, DEFAULT_CONTRACT, defaultModelSpec, ensureCompactCatalogTools, resolveContextPolicy, type LoadedConfig } from "../config.js";
import type { Logger } from "../log.js";
import { ensureDir } from "../util.js";
import { maskSecrets } from "../secrets.js";
import { installCompactionGuard } from "./compaction.js";
import { measureSessionFileContext, mostRecentSessionFile } from "./session-retention.js";
import { buildSystemPrompt } from "./prompt.js";
import { ALIVE_TOOL_NAMES, createAliveTools, type CompactToolBridge, type CompactToolDefinition, type ToolDeps } from "./tools.js";
import { SandboxManager } from "../sandbox/manager.js";
import { createSandboxTools } from "../sandbox/tools.js";
import type { ToolAbortGate } from "./tool-abort.js";

export interface AgentBuildResult {
	session: AgentSession;
	model: Model<any> | undefined;
	modelRuntime: ModelRuntime;
	modelFallbackMessage?: string;
	/**
	 * Set when a resume transcript could not be reopened (#173): the session is a
	 * fresh one and the caller must close the interrupted run as `aborted`
	 * instead of pretending it continued.
	 */
	resumeFailure?: string;
}

export interface BuildAgentOptions {
	config: LoadedConfig;
	toolDeps: ToolDeps;
	log: Logger;
	soul: string;
	/** Ignore `config.session` and start a brand-new transcript (used after a sleep). */
	forceNewSession?: boolean;
	/**
	 * Explicit session file to reopen (resume after a deliberate restart, #124).
	 * When absent the configured `continue`/`create` behaviour is used.
	 */
	sessionFile?: string;
	/** Runtime-scoped owner; must be reused across context resets. */
	sandbox?: SandboxManager;
	/** Operator abort of the current tool (#164), shared across context resets. */
	toolAbortGate?: ToolAbortGate;
}

/**
 * Pick the directly active tools when the compact catalog is on (#69).
 *
 * The keep list is a preference: only names that survived the allowlist /
 * isolation / registration filter in `allowed` can stay active. The two
 * dispatchers are appended last and filtered the same way, so the compact set
 * is always a subset of the full set and never invents a permitted tool.
 */
export function compactActiveTools(input: {
	allowed: string[];
	keep?: string[];
	required?: string[];
}): string[] {
	const allowed = new Set(input.allowed);
	const names: string[] = [];
	const add = (name: string) => {
		if (allowed.has(name) && !names.includes(name)) names.push(name);
	};
	for (const name of input.keep ?? DEFAULT_COMPACT_KEEP_TOOLS) add(name);
	for (const name of input.required ?? ["find_tool", "use_tool"]) add(name);
	return names;
}

/** One-line fallbacks for pi built-ins, used only by the compact prompt table. */
const BUILTIN_TOOL_DESCRIPTIONS: Record<string, string> = {
	read: "Read a file from the workspace.",
	write: "Write a file in the workspace.",
	edit: "Replace exact text in a workspace file.",
	bash: "Run a shell command in the workspace.",
	grep: "Search file contents for a pattern.",
	find: "Find files by glob pattern.",
	ls: "List a workspace directory.",
};

/** Name + one line for the hidden tools; schemas come from find_tool instead. */
function compactPromptEntries(input: {
	allowed: string[];
	active: string[];
	definitions: Array<{ name: string; description: string }>;
}): Array<{ name: string; description: string }> {
	const active = new Set(input.active);
	const descriptions = new Map(input.definitions.map((definition) => [definition.name, definition.description]));
	return input.allowed
		.filter((name) => !active.has(name) && name !== "find_tool" && name !== "use_tool")
		.map((name) => ({
			name,
			description:
				descriptions.get(name) ??
				BUILTIN_TOOL_DESCRIPTIONS[name] ??
				"custom or extension tool registered in this session",
		}))
		.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
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
	const sandboxTools = isolated ? createSandboxTools(options.sandbox!, config, { log }) : [];
	// Only the explicitly configured shared-browser module may cross this boundary.
	// Its scoped protocol is a trusted host service; the legacy host browser and
	// dedicated engines remain unavailable to isolated profiles.
	const sharedBrowser = cfg.modules.browser?.enabled === true && !!cfg.modules.browser.sharedUrl && toolDeps.moduleTools.some((tool) => tool.name === "browser");
	const blockedHostTools = new Set(["web_search", ...(!sharedBrowser ? ["browser"] : [])]);
	const reserved = new Set([...sandboxTools.map((tool) => tool.name), ...blockedHostTools, "tool_registry"]);
	if (isolated && toolDeps.moduleTools.some((tool) => reserved.has(tool.name))) throw new Error("Module tools cannot override isolated filesystem/shell tools");
	const compactCatalog = cfg.tools.compactCatalog === true;
	// Keep the dispatchers allowed even when a caller built LoadedConfig by hand
	// instead of going through loadConfig's normalization.
	const toolAllowlist = compactCatalog ? ensureCompactCatalogTools(cfg.tools.allowlist, true) : cfg.tools.allowlist;

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

	const settingsManager = SettingsManager.inMemory({
		compaction: { enabled: true },
		retry: { enabled: true, maxRetries: 3 },
	});

	const toolboxExtensionPath = path.join(
		path.dirname(fileURLToPath(import.meta.url)),
		`toolbox-extension${fileURLToPath(import.meta.url).endsWith(".ts") ? ".ts" : ".js"}`,
	);
	process.env.ALIVE_TOOLS_DIR = path.join(paths.stateDir, "tools");
	process.env.ALIVE_TOOL_ALLOWLIST = JSON.stringify(toolAllowlist);

	const sandboxBuiltins = new Set(["read", "write", "edit", "bash", "grep", "find", "ls"]);
	const builtinTools = cfg.tools.builtin.filter((tool) => (!isolated || sandboxBuiltins.has(tool)) && (tool !== "bash" || cfg.tools.bash));
	const persistedTools = isolated ? [] : readPersistedToolNames(path.join(paths.stateDir, "tools", "registry.json"));
	// Workers use the same execution boundary as this session: the agent's VM
	// when sandboxed, the profile workspace otherwise. Enable the tool from the
	// operator-owned workers switch, not from a delegated grant.
	const workerTools = cfg.workers.enabled ? ["worker"] : [];
	const allowedTools = selectAllowedTools({
		allowlist: [...toolAllowlist, ...workerTools],
		builtins: builtinTools,
		alive: isolated ? [...ALIVE_TOOL_NAMES.filter((name) => !blockedHostTools.has(name)), "file", "sandbox_control"] : [...ALIVE_TOOL_NAMES],
		modules: toolDeps.moduleTools.map((tool) => tool.name),
		sandbox: sandboxTools.map((tool) => tool.name),
		custom: persistedTools,
		toolRegistryAvailable: !isolated,
	});

	// Compact catalog (#69): the whole allowlisted set stays registered so
	// use_tool can reach it; only a short subset is active. The mode is opt-in,
	// so the default path below keeps the exact previous prompt and tool list.
	const compactBridge: CompactToolBridge | undefined = compactCatalog ? {} : undefined;
	const aliveTools = createAliveTools(compactBridge ? { ...toolDeps, compactBridge } : toolDeps);
	const registeredAliveTools = isolated ? aliveTools.filter((tool) => !blockedHostTools.has(tool.name)) : aliveTools;
	const activeTools = compactCatalog
		? compactActiveTools({ allowed: allowedTools, keep: cfg.tools.compactKeep })
		: allowedTools;

	const promptBase = {
		name: cfg.name,
		soul,
		contract: readContract(paths.contractPath),
		workspace,
		stateDir: paths.stateDir,
		runTimeoutMs: cfg.loop.runTimeoutMs,
		runWarnMs: cfg.loop.runWarnMs,
		sleepAfterMs: cfg.loop.sleepAfterMs,
		workers: cfg.workers.enabled
			? {
				models: cfg.workers.models,
				defaultModel: cfg.workers.defaultModel,
				worktree: cfg.workers.permissions.worktree,
				pullRequest: cfg.workers.permissions.pullRequest,
				sandboxed: isolated,
			}
			: undefined,
	};
	// `fullSystemPrompt` is the pre-#69 prompt, kept only as the "before" side
	// of the start-up metric when compact mode is on.
	const fullSystemPrompt = buildSystemPrompt(promptBase);
	const hiddenPromptEntries = compactCatalog
		? compactPromptEntries({
			allowed: allowedTools,
			active: activeTools,
			definitions: [...registeredAliveTools, ...sandboxTools],
		})
		: undefined;
	const systemPrompt = hiddenPromptEntries
		? buildSystemPrompt({ ...promptBase, compactCatalog: hiddenPromptEntries })
		: fullSystemPrompt;

	const resourceLoader = new DefaultResourceLoader({
		cwd: paths.workspaceDir,
		agentDir: paths.agentDir,
		settingsManager,
		noThemes: true,
		noExtensions: isolated,
		noSkills: isolated,
		noPromptTemplates: isolated,
		noContextFiles: isolated,
		systemPrompt: isolated ? `${systemPrompt}\n\nShell and file tools run in microsandbox, never on the host. Your guest home and workspace is ${workspace} in a private persistent volume. The host workspace is not mounted. Memory, messaging, the dashboard tool and explicitly granted module tools are trusted host services. ${sharedBrowser ? "Browser tools use only the authenticated shared host with a conversation-owned context; no local browser fallback is available." : "Host browser tools are unavailable."} Host web_search and executable tool registry are unavailable. Pin critical services with sandbox_control before starting them. VM shutdown requires two empty process/Docker observations; holds prevent shutdown. Ordinary workspace file operations may run without a VM only while it is stopped; running VM writes always use guest permissions/inotify. Shared resources are under configured guest mount paths. No host fallback on sandbox errors.` : systemPrompt,
		additionalExtensionPaths: isolated ? [] : [...cfg.extensions, toolboxExtensionPath],
	});
	await resourceLoader.reload();
	for (const error of resourceLoader.getExtensions().errors) {
		log.warn("extension failed to load", { path: error.path, error: error.error });
	}

	const { sessionManager, resumeFailure } = openSessionManager({
		config,
		log,
		sessionFile: options.sessionFile,
		forceNewSession: options.forceNewSession,
	});

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
		customTools: isolated ? [...registeredAliveTools, ...sandboxTools] : registeredAliveTools,
		resourceLoader,
		sessionManager,
		settingsManager,
	});

	// Auto-compaction is pi's own loop, but the summary is a provider response
	// like any other. Guard it so an HTML/error page can never become the new
	// context (#167); failures keep the old transcript and back off across turns.
	installCompactionGuard(session, {
		log,
		mask: (text) => maskSecrets(text, config.config.secrets),
		contextTokens: () => {
			try {
				return session.getContextUsage()?.tokens ?? 0;
			} catch {
				return 0;
			}
		},
	});

	// Extensions may register tools, but only names selected below become active.
	// The same configured allowlist is enforced by the toolbox extension for tools
	// created or loaded after this initial activation.
	session.setActiveToolsByName(activeTools);

	// Fill the compact bridge only after the registry and activation exist: it
	// must resolve hidden tools through pi, not through a private copy.
	if (compactCatalog && compactBridge) {
		const hiddenAllowed = new Set(allowedTools);
		const hiddenActive = new Set(activeTools);
		compactBridge.hidden = () =>
			session
				.getAllTools()
				.filter(
					(info) =>
						hiddenAllowed.has(info.name) &&
						!hiddenActive.has(info.name) &&
						info.name !== "find_tool" &&
						info.name !== "use_tool",
				)
				.map((info) => {
					const definition = session.getToolDefinition(info.name);
					if (!definition) return undefined;
					return {
						name: definition.name,
						description: definition.description,
						parameters: definition.parameters,
						execute: definition.execute,
					} as CompactToolDefinition;
				})
				.filter((definition): definition is CompactToolDefinition => definition !== undefined);
		let callSeq = 0;
		compactBridge.execute = async (name, params, signal) => {
			const definition = session.getToolDefinition(name);
			if (!definition) throw new Error(`tool "${name}" is not registered in this session`);
			callSeq += 1;
			// Same pi execution path as a direct call: the definition owns its
			// implementation, limits and error text. Only the extension context has
			// to be synthesized here (the SDK does the same for agent-loop calls).
			const context = session.extensionRunner.createContext();
			return definition.execute(`compact_${callSeq}_${name}`, params, signal, undefined, context);
		};
	}
	// Wrap every active tool (built-ins, alive tools and sandbox tools) so the
	// operator can abort exactly the call that is running (#164). The runtime
	// re-wraps before each model step for tools activated later.
	options.toolAbortGate?.wrapAgent(session.agent);

	if (compactCatalog) {
		log.info("compact tool catalog active", {
			activeTools: session.getActiveToolNames().length,
			hiddenTools: compactBridge?.hidden?.().length ?? 0,
			promptCharsBefore: fullSystemPrompt.length,
			promptCharsAfter: systemPrompt.length,
			promptCharsSession: session.systemPrompt.length,
		});
	}

	if (modelFallbackMessage) log.warn("model fallback", { message: modelFallbackMessage });
	log.info("agent session ready", {
		sessionId: session.sessionId,
		sessionFile: session.sessionFile ?? "(none)",
		model: session.model ? `${session.model.provider}/${session.model.id}` : "(default)",
		thinkingLevel: session.thinkingLevel,
		tools: session.getActiveToolNames(),
	});

	return { session, modelRuntime, model: model ?? session.model ?? undefined, modelFallbackMessage, resumeFailure };
}

/**
 * Pick the pi transcript for this session: a resumed run's file, the configured
 * `continue`/`new` behaviour, or a brand-new transcript (#173).
 *
 * Reopening a resume target is the one place where a corrupt file must not take
 * the whole runtime down: `SessionManager.open` throws on a non-empty file that
 * is not a pi session, and an unhandled throw during `init()` used to leave the
 * process alive with `status: "starting"` and no ticks. The failure is reported
 * to the caller through `resumeFailure` (logged as a warning here), which closes
 * the interrupted run as `aborted` and starts a new session instead.
 *
 * A `continue` start also refuses a transcript that already carries the
 * context-sleep threshold or more (#222). Resuming it means the first model
 * step is a context-sleep directive and no work happens; the fix is to start an
 * empty transcript and leave the old file untouched (memory lives in
 * `summary.md`, the journal, notes and reminders, not in the transcript).
 */
export function openSessionManager(options: {
	config: LoadedConfig;
	log: Logger;
	sessionFile?: string;
	forceNewSession?: boolean;
}): { sessionManager: SessionManager; resumeFailure?: string } {
	const { log } = options;
	const { config: cfg, paths } = options.config;
	// Only the configured `continue` mode is guarded. An explicit `sessionFile`
	// (resume of an interrupted run) keeps its own resume logic below.
	const continueRecent = (): SessionManager => {
		const threshold = resolveContextPolicy(cfg).sleepTokens;
		const recent = threshold > 0 ? mostRecentSessionFile(paths.sessionsDir, paths.workspaceDir) : undefined;
		if (recent) {
			const contextTokens = measureSessionFileContext(recent);
			if (contextTokens > 0 && contextTokens >= threshold) {
				log.warn(
					"recent session is at the context-sleep threshold; starting a new transcript and keeping the old file",
					{ sessionFile: recent, contextTokens, threshold },
				);
				return SessionManager.create(paths.workspaceDir, paths.sessionsDir);
			}
		}
		return SessionManager.continueRecent(paths.workspaceDir, paths.sessionsDir);
	};
	// `forceNewSession` (a sleep) ignores the configured `continue` on purpose.
	const fresh = () =>
		cfg.session === "continue" && !options.forceNewSession
			? continueRecent()
			: SessionManager.create(paths.workspaceDir, paths.sessionsDir);
	if (options.forceNewSession || !options.sessionFile) return { sessionManager: fresh() };
	try {
		return { sessionManager: SessionManager.open(options.sessionFile, paths.sessionsDir, paths.workspaceDir) };
	} catch (error) {
		const resumeFailure = error instanceof Error ? error.message : String(error);
		log.warn("cannot reopen the interrupted session file; starting a new session", {
			sessionFile: options.sessionFile,
			error: resumeFailure,
		});
		return { sessionManager: fresh(), resumeFailure };
	}
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
