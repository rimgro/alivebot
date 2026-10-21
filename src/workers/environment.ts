import { execFile } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { promisify } from "node:util";
import type { LoadedConfig } from "../config.js";
import type { SandboxManager } from "../sandbox/manager.js";

const execFileAsync = promisify(execFile);

const COMMAND_TIMEOUT_MS = 120_000;
const COMMAND_MAX_BUFFER = 16 * 1024 * 1024;

/**
 * The execution boundary a worker shares with its parent agent.
 *
 * - `host` profiles: commands run on the host in the profile workspace.
 * - sandboxed profiles: commands run inside the same microVM as the agent, as
 *   the same guest user. Workers never get an implicit host fallback.
 */
export interface WorkerEnvironment {
	readonly kind: "host" | "sandbox";
	readonly root: string;
	resolve(value: string): string;
	join(...parts: string[]): string;
	dirname(value: string): string;
	run(argv: string[], cwd: string, options?: { timeoutMs?: number }): Promise<{ stdout: string; stderr: string }>;
	exists(target: string): Promise<boolean>;
	mkdirp(target: string): Promise<void>;
}

export function createWorkerEnvironment(config: LoadedConfig, sandbox?: SandboxManager): WorkerEnvironment {
	if (config.config.sandbox.enabled) {
		if (!sandbox) throw new Error("a sandboxed profile requires its SandboxManager for workers");
		return sandboxEnvironment(sandbox);
	}
	return createHostWorkerEnvironment(config.paths.rootDir);
}

/** Host environment for CLI inspection of host workers only. */
export function createHostWorkerEnvironment(root: string): WorkerEnvironment {
	return hostEnvironment(root);
}

function hostEnvironment(root: string): WorkerEnvironment {
	const run = async (argv: string[], cwd: string, options: { timeoutMs?: number } = {}) => {
		if (argv.length === 0) throw new Error("empty command");
		try {
			return await execFileAsync(argv[0]!, argv.slice(1), {
				cwd,
				timeout: options.timeoutMs ?? COMMAND_TIMEOUT_MS,
				maxBuffer: COMMAND_MAX_BUFFER,
				env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
			});
		} catch (error) {
			const value = error as { stderr?: string; stdout?: string; message?: string };
			const detail = (value.stderr || value.stdout || value.message || "unknown error").trim();
			throw new Error(`${argv[0]} ${argv[1] ?? ""} failed: ${detail.slice(0, 4000)}`);
		}
	};
	return {
		kind: "host",
		root,
		resolve: (value) => path.resolve(root, value || "."),
		join: (...parts) => path.join(...parts),
		dirname: (value) => path.dirname(value),
		run,
		exists: async (target) => fs.existsSync(target),
		mkdirp: async (target) => {
			fs.mkdirSync(target, { recursive: true });
		},
	};
}

function sandboxEnvironment(sandbox: SandboxManager): WorkerEnvironment {
	const execute = async (command: string, timeoutMs = COMMAND_TIMEOUT_MS) => {
		return sandbox.exclusive(() => sandbox.execute(command, timeoutMs));
	};
	const run = async (argv: string[], cwd: string, options: { timeoutMs?: number } = {}) => {
		if (argv.length === 0) throw new Error("empty command");
		const command = `cd ${shellQuote(cwd)} && export GIT_TERMINAL_PROMPT=0; ${argv.map(shellQuote).join(" ")}`;
		const result = await execute(command, options.timeoutMs);
		if (result.code !== 0) {
			throw new Error(`${argv[0]} ${argv[1] ?? ""} failed (${result.code}): ${result.text.trim().slice(0, 4000)}`);
		}
		return { stdout: result.text, stderr: "" };
	};
	return {
		kind: "sandbox",
		root: sandbox.workspaceDir,
		resolve: (value) => sandbox.path(value || "."),
		join: (...parts) => path.posix.join(...parts),
		dirname: (value) => path.posix.dirname(value),
		run,
		exists: async (target) => (await execute(`test -e ${shellQuote(target)}`, 30_000)).code === 0,
		mkdirp: async (target) => {
			const result = await execute(`mkdir -p ${shellQuote(target)}`, 30_000);
			if (result.code !== 0) throw new Error(`mkdir -p ${target} failed (${result.code}): ${result.text.trim().slice(0, 1000)}`);
		},
	};
}

function shellQuote(value: string): string {
	if (value === "") return "''";
	return `'${value.replace(/'/g, `'\\''`)}'`;
}
