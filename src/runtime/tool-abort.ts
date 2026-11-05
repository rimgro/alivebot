/**
 * Operator abort of the **current tool call** (#164).
 *
 * This is deliberately not a stop/restart path: the run stays alive, its
 * context is untouched, no `stopReason`/`stoppedBy` is written, and the agent
 * receives a normal tool error (`aborted by operator: tool <name>`) so it can
 * continue with the next step.
 *
 * The control surface is one small file in the profile state directory:
 *
 *   `<stateDir>/abort-tool.json`
 *
 * It is written by the dashboard, a Telegram slash command or
 * `alive abort-tool <agent>` and consumed by the runtime on its next scheduler
 * tick (well under a second with the default 750 ms poll interval). The marker
 * is single-use, TTL-bound and may name the run it was meant for, so a stale
 * click cannot abort an unrelated tool later.
 *
 * The runtime wraps every active pi tool once. A wrapper races the tool against
 * the gate's `AbortSignal` and passes a combined signal to the tool, so
 * `SandboxManager.execute` can kill exactly the guest command that is running
 * instead of tearing down the VM or the session.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import type { Logger } from "../log.js";
import type { Journal } from "../store/journal.js";
import { ensureDir, formatDuration, readJson, writeJsonAtomic } from "../util.js";

/** `<stateDir>/abort-tool.json`: a one-shot request to abort the running tool. */
export const TOOL_ABORT_FILE = "abort-tool.json";

/**
 * A request older than this is a leftover, not an instruction for today's tool.
 * The runtime polls every `loop.pollIntervalMs` (750 ms by default), so a live
 * operator action is consumed almost immediately; two minutes leaves ample room
 * for a busy event loop while still making an hour-old file inert.
 */
export const TOOL_ABORT_TTL_MS = 2 * 60_000;

export type ToolAbortSource = "dashboard" | "telegram" | "cli";

export interface ToolAbortRequest {
	/** Wall clock the request was written. */
	at: number;
	source: ToolAbortSource;
	/** Human/operator identity, e.g. `telegram:12345`, `dashboard`, `cli:alice`. */
	by?: string;
	/** The run the operator saw; a different current run ignores the request. */
	runId?: string;
}

export interface ToolAbortRequestInput {
	source: ToolAbortSource;
	by?: string;
	runId?: string;
	at?: number;
}

export interface ActiveToolInfo {
	name: string;
	startedAt: number;
	runId?: string;
}

export function toolAbortRequestPath(stateDir: string): string {
	return path.join(stateDir, TOOL_ABORT_FILE);
}

function isToolAbortSource(value: unknown): value is ToolAbortSource {
	return value === "dashboard" || value === "telegram" || value === "cli";
}

/**
 * Write a one-shot abort request. Best effort, like `stop-intent.json`: a
 * read-only or missing state directory must not crash a dashboard click or a
 * CLI command (the caller reports the failure it can see).
 */
export function writeToolAbortRequest(stateDir: string, input: ToolAbortRequestInput): ToolAbortRequest {
	const request: ToolAbortRequest = {
		at: input.at ?? Date.now(),
		source: input.source,
		...(input.by?.trim() ? { by: input.by.trim().slice(0, 200) } : {}),
		...(input.runId?.trim() ? { runId: input.runId.trim().slice(0, 200) } : {}),
	};
	ensureDir(stateDir);
	const file = toolAbortRequestPath(stateDir);
	writeJsonAtomic(file, request);
	try {
		fs.chmodSync(file, 0o600);
	} catch {
		// Diagnostics only; the flag itself is already written.
	}
	return request;
}

/** Delete the marker (idempotent). */
export function clearToolAbortRequest(stateDir: string): void {
	try {
		fs.rmSync(toolAbortRequestPath(stateDir), { force: true });
	} catch {
		// Already gone or not ours to delete.
	}
}

/**
 * Read and **consume** the marker.
 *
 * A stale, corrupt or wrong-run marker is deleted and reported as `undefined`:
 * a request is never replayed, and an old file cannot abort a later tool. The
 * `runId` check is skipped when either side is unknown, so a CLI request made
 * while the runtime is between runs is still allowed to target the next run.
 */
export function readToolAbortRequest(
	stateDir: string,
	options: { now?: number; runId?: string } = {},
): ToolAbortRequest | undefined {
	const file = toolAbortRequestPath(stateDir);
	if (!fs.existsSync(file)) return undefined;
	const now = options.now ?? Date.now();
	const raw = readJson<Partial<ToolAbortRequest> | null>(file, null);
	clearToolAbortRequest(stateDir);
	if (!raw || typeof raw !== "object") return undefined;
	if (!isToolAbortSource(raw.source)) return undefined;
	if (typeof raw.at !== "number" || !Number.isFinite(raw.at)) return undefined;
	if (now - raw.at >= TOOL_ABORT_TTL_MS) return undefined;
	if (raw.runId !== undefined && typeof raw.runId !== "string") return undefined;
	if (raw.by !== undefined && typeof raw.by !== "string") return undefined;
	if (raw.runId && options.runId && raw.runId !== options.runId) return undefined;
	return {
		at: raw.at,
		source: raw.source,
		...(raw.by ? { by: raw.by } : {}),
		...(raw.runId ? { runId: raw.runId } : {}),
	};
}

/** Parse the owner Telegram command, with or without `@botname`. */
export function parseAbortToolCommand(text: string): boolean {
	return /^\/(?:abort[_-]tool)(?:@[A-Za-z0-9_]+)?(?:\s|$)/i.test(text.trim());
}

/** One active tool execution, as seen by the gate. */
interface ActiveExecution {
	name: string;
	startedAt: number;
	runId?: string;
	controller: AbortController;
	request?: ToolAbortRequest;
	/** Set once the wrapper has turned the abort into the agent-visible error. */
	reported: boolean;
}

/** The result of one `check()` call, mostly for tests and structured logs. */
export type ToolAbortCheckResult =
	| { kind: "none" }
	| { kind: "ignored"; reason: "no-active-tool" | "already-aborted" | "wrong-run"; request: ToolAbortRequest }
	| { kind: "aborted"; tool: ActiveToolInfo; request: ToolAbortRequest };

export interface ToolAbortGateOptions {
	stateDir: string;
	log: Pick<Logger, "info" | "warn" | "debug">;
	/** Durable journal line for a real abort (tool, duration, initiator). */
	journal?: Pick<Journal, "append">;
	/** Run id the request must match, when known. */
	currentRunId?: () => string | undefined;
	/** Called when the active tool changes, so the runtime can refresh `runtime.json`. */
	onStateChange?: () => void;
	now?: () => number;
}

/**
 * Owns the single active tool execution and translates a request file into an
 * `AbortSignal` for exactly that execution.
 */
export class ToolAbortGate {
	private readonly stateDir: string;
	private readonly log: ToolAbortGateOptions["log"];
	private readonly journal?: Pick<Journal, "append">;
	private readonly currentRunId?: () => string | undefined;
	private readonly onStateChange?: () => void;
	private readonly now: () => number;
	private readonly wrapped = new WeakSet<object>();
	private active?: ActiveExecution;
	private pollTimer?: NodeJS.Timeout;

	constructor(options: ToolAbortGateOptions) {
		this.stateDir = options.stateDir;
		this.log = options.log;
		this.journal = options.journal;
		this.currentRunId = options.currentRunId;
		this.onStateChange = options.onStateChange;
		this.now = options.now ?? Date.now;
	}

	/**
	 * Poll the marker independently of the scheduler tick. The runtime already
	 * calls `check()` on every tick; this timer keeps the ~1 s promise even if a
	 * tick is busy with a long synchronous operation.
	 */
	startPolling(intervalMs = 1_000): void {
		if (this.pollTimer) return;
		this.pollTimer = setInterval(() => {
			try {
				this.check();
			} catch (error) {
				this.log.warn("abort-tool check failed", { error: error instanceof Error ? error.message : String(error) });
			}
		}, Math.max(250, intervalMs));
		this.pollTimer.unref();
	}

	stopPolling(): void {
		if (!this.pollTimer) return;
		clearInterval(this.pollTimer);
		this.pollTimer = undefined;
	}

	/** The tool the dashboard should show, if one is running right now. */
	activeTool(): ActiveToolInfo | undefined {
		return this.active ? { name: this.active.name, startedAt: this.active.startedAt, ...(this.active.runId ? { runId: this.active.runId } : {}) } : undefined;
	}

	/**
	 * Register a tool execution and return its private abort signal.
	 *
	 * Only one tool is considered "current": pi runs tools sequentially for the
	 * built-in/alive sets, and the first still-running call is the one an
	 * operator means. (A parallel batch is not exposed by any operator surface;
	 * aborting the first active call is still narrower than aborting the run.)
	 */
	begin(name: string, runId = this.currentRunId?.()): { signal: AbortSignal; execution: object } {
		if (this.active) {
			// Defensive: a nested/parallel call must not steal the gate from the
			// call the operator is watching. It still gets its own controller, but
			// it is not the one `check()` aborts.
			const isolated = new AbortController();
			return { signal: isolated.signal, execution: { name, startedAt: this.now(), runId, controller: isolated, reported: false } };
		}
		const controller = new AbortController();
		const execution: ActiveExecution = {
			name,
			startedAt: this.now(),
			...(runId ? { runId } : {}),
			controller,
			reported: false,
		};
		this.active = execution;
		this.notifyStateChange();
		return { signal: controller.signal, execution };
	}

	/** Clear the active tool if this call still owns it. */
	end(execution: object): void {
		if (this.active !== execution) return;
		this.active = undefined;
		this.notifyStateChange();
	}

	/**
	 * Forget the active tool without turning it into an operator abort (#181).
	 *
	 * A force stop closes the whole run instead of going through the tool-abort
	 * gate, so no "aborted by operator" error is delivered to the agent. This
	 * makes sure `runtime.json` does not keep advertising a tool after the run
	 * settled, even if the underlying call never reached its own `end()`.
	 */
	clearActive(): void {
		if (!this.active) return;
		this.active = undefined;
		this.notifyStateChange();
	}

	/** Never let a state-file write failure break the tool call itself. */
	private notifyStateChange(): void {
		try {
			this.onStateChange?.();
		} catch (error) {
			this.log.warn("abort-tool state refresh failed", { error: error instanceof Error ? error.message : String(error) });
		}
	}

	/** Turn an observed abort into the one log/journal line for this execution. */
	reportAborted(execution: object): { tool: ActiveToolInfo; request: ToolAbortRequest; durationMs: number } | undefined {
		if (this.active !== execution) return undefined;
		const active = this.active as ActiveExecution;
		if (!active.request || active.reported) return undefined;
		active.reported = true;
		const durationMs = Math.max(0, this.now() - active.startedAt);
		const tool: ActiveToolInfo = { name: active.name, startedAt: active.startedAt, ...(active.runId ? { runId: active.runId } : {}) };
		const by = active.request.by;
		const who = !by ? active.request.source : by.startsWith(`${active.request.source}:`) ? by : `${active.request.source}:${by}`;
		this.log.warn("tool aborted by operator", {
			tool: active.name,
			durationMs,
			duration: formatDuration(durationMs),
			source: active.request.source,
			by: active.request.by,
			runId: active.runId,
			requestAt: active.request.at,
		});
		this.journal?.append(
			`[abort-tool] ${active.name} aborted by operator (${who}) after ${formatDuration(durationMs)}; ` +
				"the run continues with a tool error, no stopReason/stoppedBy was written",
		);
		return { tool, request: active.request, durationMs };
	}

	/**
	 * Consume a request file and abort the current tool, if any.
	 *
	 * Always called from the runtime scheduler (every `pollIntervalMs`). A
	 * request that arrives while no tool is running is consumed and logged: the
	 * operator asked to abort a tool, not the run, and silently keeping the
	 * marker would abort an unrelated future call.
	 */
	check(now = this.now()): ToolAbortCheckResult {
		const currentRunId = this.currentRunId?.();
		const request = readToolAbortRequest(this.stateDir, { now, ...(currentRunId ? { runId: currentRunId } : {}) });
		if (!request) return { kind: "none" };
		const active = this.active;
		if (!active) {
			this.log.warn("abort-tool request ignored: no tool is running", { source: request.source, by: request.by, runId: request.runId });
			return { kind: "ignored", reason: "no-active-tool", request };
		}
		if (active.controller.signal.aborted) {
			this.log.info("abort-tool request ignored: the tool is already aborting", { tool: active.name, source: request.source, by: request.by });
			return { kind: "ignored", reason: "already-aborted", request };
		}
		active.request = request;
		this.log.info("abort-tool request accepted", {
			tool: active.name,
			durationMs: Math.max(0, now - active.startedAt),
			source: request.source,
			by: request.by,
			runId: active.runId,
		});
		active.controller.abort(new Error(`aborted by operator: tool ${active.name}`));
		return { kind: "aborted", tool: { name: active.name, startedAt: active.startedAt, ...(active.runId ? { runId: active.runId } : {}) }, request };
	}

	/** Wrap one pi tool. Idempotent across repeated agent-state refreshes. */
	wrapTool<T extends AbortableTool>(tool: T): T {
		if (this.wrapped.has(tool)) return tool;
		const gate = this;
		const wrapped = {
			...tool,
			execute: async (
				toolCallId: string,
				params: unknown,
				signal?: AbortSignal,
				onUpdate?: (partial: unknown) => void,
				ctx?: unknown,
			) => {
				const started = gate.begin(tool.name);
				const execution = started.execution;
				const combined = combineSignals(signal, started.signal);
				const abort = abortRejection(started.signal);
				try {
					const result = await Promise.race([
						Promise.resolve().then(() => tool.execute(toolCallId, params, combined.signal, onUpdate, ctx)),
						abort.promise,
					]);
					return result;
				} catch (error) {
					// Only the gate's own signal means "operator aborted". A session
					// abort or a tool's own timeout keeps its original error.
					if (started.signal.aborted) {
						gate.reportAborted(execution);
						throw new Error(`aborted by operator: tool ${tool.name}`);
					}
					throw error;
				} finally {
					abort.cleanup();
					combined.cleanup();
					gate.end(execution);
				}
			},
		} as T;
		this.wrapped.add(tool);
		this.wrapped.add(wrapped);
		return wrapped;
	}

	/**
	 * Wrap the tools currently active on a pi agent.
	 *
	 * Called after session creation and again before every model step, so a
	 * tool activated later (e.g. by the tool registry) is covered from the next
	 * step onward. Tools already wrapped are returned unchanged.
	 */
	wrapAgent(agent: { state: { tools: AbortableTool[] } }): void {
		const tools = agent?.state?.tools;
		if (!Array.isArray(tools)) return;
		let changed = false;
		const next = tools.map((tool) => {
			const wrapped = this.wrapTool(tool);
			if (wrapped !== tool) changed = true;
			return wrapped;
		});
		if (changed) agent.state.tools = next;
	}
}

export interface AbortableTool {
	name: string;
	execute: (
		toolCallId: string,
		params: any,
		signal?: AbortSignal,
		onUpdate?: any,
		ctx?: any,
	) => Promise<any>;
}

function abortRejection(signal: AbortSignal): { promise: Promise<never>; cleanup: () => void } {
	let listener: (() => void) | undefined;
	const promise = new Promise<never>((_resolve, reject) => {
		if (signal.aborted) {
			reject(new Error("aborted"));
			return;
		}
		listener = () => reject(new Error("aborted"));
		signal.addEventListener("abort", listener, { once: true });
	});
	return {
		promise,
		cleanup: () => {
			if (listener) signal.removeEventListener("abort", listener);
			listener = undefined;
		},
	};
}

function combineSignals(
	first: AbortSignal | undefined,
	second: AbortSignal,
): { signal: AbortSignal; cleanup: () => void } {
	if (!first) return { signal: second, cleanup: () => undefined };
	const controller = new AbortController();
	const abort = () => controller.abort();
	if (first.aborted || second.aborted) controller.abort();
	else {
		first.addEventListener("abort", abort, { once: true });
		second.addEventListener("abort", abort, { once: true });
	}
	return {
		signal: controller.signal,
		cleanup: () => {
			first.removeEventListener("abort", abort);
			second.removeEventListener("abort", abort);
		},
	};
}
