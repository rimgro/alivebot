import * as fs from "node:fs";
import * as path from "node:path";
import type { ThinkingLevel } from "@earendil-works/pi-agent-core";
import {
	createAgentSession,
	DefaultResourceLoader,
	ModelRuntime,
	resolveCliModel,
	SessionManager,
	SettingsManager,
} from "@earendil-works/pi-coding-agent";
import type { LoadedConfig } from "../config.js";
import type { SandboxManager } from "../sandbox/manager.js";
import { createSandboxTools } from "../sandbox/tools.js";
import { ensureDir } from "../util.js";
import type { WorkerIsolation } from "./store.js";

/** Minimal surface WorkerManager needs. Tests can substitute a fake. */
export interface WorkerSession {
	readonly sessionFile?: string;
	readonly isStreaming: boolean;
	prompt(text: string, options?: { expandPromptTemplates?: boolean; source?: "extension" | "rpc" | "interactive" }): Promise<void>;
	subscribe(listener: (event: WorkerSessionEvent) => void): () => void;
	abort(): Promise<void>;
	dispose(): void;
	getLastAssistantText(): string | undefined;
	getSessionStats(): WorkerSessionStats;
}

export interface WorkerSessionEvent {
	type: string;
	toolName?: string;
	[key: string]: unknown;
}

export interface WorkerSessionStats {
	tokens?: { input?: number; output?: number; total?: number };
	cost?: number;
}

export interface WorkerSessionBuildInput {
	id: string;
	name?: string;
	/** True when file/shell tools must execute inside the agent's sandbox VM. */
	sandboxed: boolean;
	/** Host cwd used only for pi resource discovery; never the worker operation root. */
	hostCwd: string;
	/** Path the worker sees and operates on: a guest path when sandboxed. */
	workspacePath: string;
	repositoryPath: string;
	modelSpec: string;
	tools: string[];
	isolation: WorkerIsolation;
	branch?: string;
	baseRef?: string;
	pullRequest?: number;
	sessionDir: string;
	sessionFile?: string;
}

export type WorkerSessionFactory = (input: WorkerSessionBuildInput) => Promise<WorkerSession>;

export function workerSystemPrompt(input: WorkerSessionBuildInput): string {
	const lines = [
		`# Coding worker ${input.id}`,
		"",
		"You are an ephemeral coding worker launched by a long-lived Alive agent.",
		"You are not a persistent agent: you have no inbox, no memory, no reminders and no lifecycle.",
		"Take the assigned task, work in the workspace, and finish. Do not behave proactively.",
		"",
		`- Workspace: ${input.workspacePath}`,
		`- Repository: ${input.repositoryPath}`,
		`- Isolation: ${input.isolation}${input.branch ? `, branch ${input.branch}` : ""}${input.pullRequest ? `, checked out PR #${input.pullRequest}` : ""}`,
		input.sandboxed
			? "- Shell and file tools run inside the agent's sandbox VM. The host filesystem is not mounted; stay inside the guest workspace."
			: "- Shell and file tools run on the host in the profile workspace.",
		"",
		"Rules:",
		"- Do the task end to end: inspect the code, edit it, and run the relevant tests or checks.",
		"- Stay inside the workspace. Do not modify unrelated repositories or system files.",
		"- Do not push branches or open pull requests; the parent agent controls publishing. Local commits are allowed when the task asks for them.",
		"- Do not create nested workers or persistent agents; those tools are not available to you.",
		"- If a requirement is ambiguous or blocked, report the blocker instead of inventing requirements.",
		"- Finish with a concise report: what changed, which checks ran and their result, and what the parent should do next.",
		"- Do not paste whole diffs or long logs; the parent can inspect the diff separately.",
	];
	return lines.join("\n");
}

export interface PiWorkerSessionFactoryOptions {
	/** Shared pi agent dir holding auth.json and models.json. */
	agentDir: string;
	config: LoadedConfig;
	/** Present for sandboxed profiles; workers then use the same VM as the agent. */
	sandbox?: SandboxManager;
}

/**
 * Build a real in-process pi coding-agent session for a worker.
 *
 * Deliberately narrow: no Alive extensions, no Alive tools, no Telegram, no
 * agent management, no worker tool. The session only gets the built-in coding
 * tools selected by the operator.
 */
export function createPiWorkerSessionFactory(options: PiWorkerSessionFactoryOptions): WorkerSessionFactory {
	let runtimePromise: Promise<ModelRuntime> | undefined;
	const runtime = async (): Promise<ModelRuntime> => {
		runtimePromise ??= ModelRuntime.create({
			authPath: path.join(options.agentDir, "auth.json"),
			modelsPath: path.join(options.agentDir, "models.json"),
		});
		return runtimePromise;
	};

	return async (input) => {
		if (input.sandboxed && !options.sandbox) throw new Error("sandboxed worker has no SandboxManager");
		const modelRuntime = await runtime();
		const resolved = resolveCliModel({ cliModel: input.modelSpec, modelRuntime });
		if (resolved.error || !resolved.model) {
			throw new Error(`cannot resolve worker model "${input.modelSpec}": ${resolved.error ?? "unknown model"}`);
		}
		const settingsManager = SettingsManager.inMemory({
			compaction: { enabled: true },
			retry: { enabled: true, maxRetries: 2 },
		});
		const sandboxTools = input.sandboxed
			? createSandboxTools(options.sandbox!, options.config, { rootDir: input.workspacePath })
				.filter((tool) => input.tools.includes(tool.name))
			: [];
		const resourceLoader = new DefaultResourceLoader({
			cwd: input.hostCwd,
			agentDir: options.agentDir,
			settingsManager,
			noExtensions: true,
			noThemes: true,
			noPromptTemplates: true,
			noSkills: input.sandboxed,
			noContextFiles: input.sandboxed,
			systemPromptOverride: (base) => {
				let adjusted = base ?? "";
				if (input.sandboxed && adjusted) {
					// Pi's base prompt describes its host cwd. The worker only ever
					// sees guest paths, so do not leak or name the host workspace.
					adjusted = adjusted.split(input.hostCwd).join(input.workspacePath);
					adjusted = adjusted.replace(/Current working directory: .*/g, `Current working directory: ${input.workspacePath}`);
				}
				return `${workerSystemPrompt(input)}\n\n${adjusted}`.trim();
			},
		});
		await resourceLoader.reload();

		ensureDir(input.sessionDir);
		const sessionManager = input.sessionFile && fs.existsSync(input.sessionFile)
			? SessionManager.open(input.sessionFile, input.sessionDir, input.hostCwd)
			: SessionManager.create(input.hostCwd, input.sessionDir);
		const { session } = await createAgentSession({
			// The session prompt and sandbox tools describe the worker's visible
			// root. Resource discovery and session storage still use hostCwd.
			cwd: input.sandboxed ? input.workspacePath : input.hostCwd,
			agentDir: options.agentDir,
			modelRuntime,
			model: resolved.model,
			thinkingLevel: (resolved.thinkingLevel || undefined) as ThinkingLevel | undefined,
			// Sandboxed workers must never fall back to host built-ins.
			noTools: input.sandboxed ? "builtin" : undefined,
			resourceLoader,
			sessionManager,
			settingsManager,
			tools: input.tools,
			customTools: input.sandboxed ? sandboxTools : undefined,
		});
		session.setActiveToolsByName(input.tools);
		return session as unknown as WorkerSession;
	};
}
