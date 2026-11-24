/**
 * One `telegram mcp` stdio child per profile (#264, step B).
 *
 * The child is spawned detached so it becomes the leader of its own process
 * group; shutdown kills the whole group (SIGTERM, 3 s, SIGKILL), otherwise a
 * helper the upstream started could outlive the proxy. An unexpected exit is
 * retried with exponential backoff from 250 ms up to 30 s.
 */
import { spawn, type ChildProcess } from "node:child_process";
import { formatStdioMessage, parseStdioChunk, type JsonRpcMessage } from "./protocol.js";

export const UPSTREAM_STOP_WAIT_MS = 3_000;
export const UPSTREAM_RESTART_INITIAL_MS = 250;
export const UPSTREAM_RESTART_MAX_MS = 30_000;
/** A child that stayed up this long resets the backoff. */
const HEALTHY_AFTER_MS = 30_000;
/** How long a request waits for a restarting child to come back. */
export const UPSTREAM_READY_TIMEOUT_MS = 10_000;

export interface UpstreamChildOptions {
	profile: string;
	command: string;
	args: string[];
	/** Extra environment on top of the parent's. */
	env?: NodeJS.ProcessEnv;
	cwd?: string;
	/** Log seam; defaults to stderr. Never receives tokens. */
	log?: (line: string) => void;
	onMessage: (message: JsonRpcMessage) => void;
	/** Called once per unexpected exit, after the group was swept. */
	onExit?: (error: Error) => void;
	initialRestartMs?: number;
	maxRestartMs?: number;
}

export class UpstreamChild {
	private readonly options: UpstreamChildOptions;
	private child: ChildProcess | undefined;
	private stopping = false;
	private attempt = 0;
	private restartTimer: NodeJS.Timeout | undefined;
	private healthyTimer: NodeJS.Timeout | undefined;
	private readonly readyWaiters = new Set<() => void>();

	constructor(options: UpstreamChildOptions) {
		this.options = options;
	}

	get profile(): string {
		return this.options.profile;
	}

	get pid(): number | undefined {
		return this.child?.pid;
	}

	get running(): boolean {
		const child = this.child;
		return child !== undefined && child.exitCode === null && child.signalCode === null;
	}

	/** First start: immediate, no backoff. */
	start(): void {
		if (this.child || this.stopping) return;
		this.spawnOnce();
	}

	/** Wait until a child is running. Resolves immediately when one already is. */
	waitUntilRunning(timeoutMs = UPSTREAM_READY_TIMEOUT_MS): Promise<void> {
		if (this.running) return Promise.resolve();
		return new Promise((resolve, reject) => {
			const done = () => {
				clearTimeout(timer);
				this.readyWaiters.delete(done);
				resolve();
			};
			const timer = setTimeout(() => {
				this.readyWaiters.delete(done);
				reject(new Error(`telegram mcp upstream for profile "${this.options.profile}" did not start in ${timeoutMs} ms`));
			}, timeoutMs);
			timer.unref?.();
			this.readyWaiters.add(done);
		});
	}

	/** Write one message; false when the child is not running or its stdin is gone. */
	send(message: JsonRpcMessage): boolean {
		const stdin = this.child?.stdin;
		if (!this.running || !stdin || !stdin.writable) return false;
		try {
			stdin.write(formatStdioMessage(message));
			return true;
		} catch {
			return false;
		}
	}

	/** Stop the child and its process group. Safe to call more than once. */
	async stop(): Promise<void> {
		if (this.stopping) return;
		this.stopping = true;
		clearTimeout(this.restartTimer);
		clearTimeout(this.healthyTimer);
		for (const waiter of this.readyWaiters) waiter();
		this.readyWaiters.clear();
		const child = this.child;
		if (!child?.pid) return;
		const pid = child.pid;
		const exited = new Promise<void>((resolve) => {
			if (child.exitCode !== null || child.signalCode !== null) return resolve();
			child.once("exit", () => resolve());
		});
		this.killGroup(pid, "SIGTERM");
		const timedOut = await Promise.race([
			exited.then(() => false),
			new Promise<boolean>((resolve) => {
				const timer = setTimeout(() => resolve(true), UPSTREAM_STOP_WAIT_MS);
				timer.unref?.();
			}),
		]);
		if (timedOut) this.killGroup(pid, "SIGKILL");
	}

	private spawnOnce(): void {
		if (this.stopping) return;
		const { profile, command, args, env, cwd, log } = this.options;
		let child: ChildProcess;
		try {
			child = spawn(command, args, {
				cwd,
				env: { ...process.env, ...env, ALIVE_TELEGRAM_MCP_PROFILE: profile },
				detached: process.platform !== "win32",
				stdio: ["pipe", "pipe", "pipe"],
			});
		} catch (error) {
			this.onUnexpectedExit(error instanceof Error ? error : new Error(String(error)));
			return;
		}
		this.child = child;
		log?.(`telegram-mcp: upstream for profile "${profile}" started (pid ${child.pid ?? "?"})`);
		child.stdout?.setEncoding("utf8");
		let buffer = "";
		child.stdout?.on("data", (chunk: string) => {
			buffer += chunk;
			const parsed = parseStdioChunk(buffer);
			buffer = parsed.rest;
			for (const error of parsed.errors) log?.(`telegram-mcp: profile "${profile}": ${error}`);
			for (const message of parsed.messages) this.options.onMessage(message);
		});
		child.stderr?.setEncoding("utf8");
		child.stderr?.on("data", (chunk: string) => {
			for (const line of String(chunk).split("\n")) {
				if (line.trim()) log?.(`telegram-mcp: profile "${profile}" upstream: ${line}`);
			}
		});
		child.on("error", (error) => {
			log?.(`telegram-mcp: profile "${profile}" upstream error: ${error.message}`);
		});
		child.on("exit", (code, signal) => {
			if (this.child === child) this.child = undefined;
			clearTimeout(this.healthyTimer);
			// The leader is gone; its group may still hold helpers.
			if (child.pid) this.killGroup(child.pid, "SIGKILL");
			if (this.stopping) return;
			this.onUnexpectedExit(
				new Error(`telegram mcp upstream for profile "${profile}" exited (code=${String(code)}, signal=${String(signal)})`),
			);
		});
		child.once("spawn", () => {
			for (const waiter of this.readyWaiters) waiter();
			this.readyWaiters.clear();
		});
		this.healthyTimer = setTimeout(() => {
			this.attempt = 0;
		}, HEALTHY_AFTER_MS);
		this.healthyTimer.unref?.();
	}

	private onUnexpectedExit(error: Error): void {
		if (this.stopping) return;
		this.child = undefined;
		clearTimeout(this.healthyTimer);
		for (const waiter of this.readyWaiters) waiter();
		this.readyWaiters.clear();
		// Wake queued requests with the failure now; they may retry after restart.
		this.options.onExit?.(error);
		const initial = this.options.initialRestartMs ?? UPSTREAM_RESTART_INITIAL_MS;
		const max = this.options.maxRestartMs ?? UPSTREAM_RESTART_MAX_MS;
		const delay = Math.min(initial * 2 ** this.attempt, max);
		this.attempt += 1;
		this.options.log?.(
			`telegram-mcp: profile "${this.options.profile}": ${error.message}; restarting in ${delay} ms (attempt ${this.attempt})`,
		);
		clearTimeout(this.restartTimer);
		this.restartTimer = setTimeout(() => {
			this.restartTimer = undefined;
			this.spawnOnce();
		}, delay);
		this.restartTimer.unref?.();
	}

	private killGroup(pid: number, signal: NodeJS.Signals): void {
		try {
			process.kill(-pid, signal);
			return;
		} catch {
			// Not a group leader (or the group is already gone): fall back to the pid.
		}
		try {
			process.kill(pid, signal);
		} catch {
			// already dead
		}
	}
}
