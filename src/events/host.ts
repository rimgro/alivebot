import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import * as path from "node:path";
import type { LoadedConfig } from "../config.js";
import type { Logger } from "../log.js";
import type { AliveEvent, NewEvent } from "../store/events.js";
import { ensureDir } from "../util.js";
import type { HistoryStore } from "../store/history.js";
import type { OutgoingMessage } from "../store/outbox.js";
import type { ChatTransport } from "../transports/types.js";
import type {
	AliveModule,
	ModuleContext,
	ModuleEventInput,
	OutboundHandler,
	UserMessageInput,
} from "./api.js";

export interface ModuleHostOptions {
	config: LoadedConfig;
	log: Logger;
	transports: ChatTransport[];
	modules: AliveModule[];
	ingest: (event: NewEvent) => AliveEvent;
	outbox: (limit: number) => OutgoingMessage[];
	history: HistoryStore;
	runtimeStatus: () => Record<string, unknown>;
}

interface ModuleRuntime {
	module: AliveModule;
	handlers: OutboundHandler[];
	statusContributors: Array<() => Record<string, unknown>>;
	error?: string;
}

/**
 * Owns the modules and the legacy transports, and routes the agent's output.
 *
 * Routing rules (documented in EVENTS_API.md):
 *   - a module with `handles()` **claims** matching messages and is responsible
 *     for delivering them: a claimer failure fails the `send_message` call;
 *   - a module without `handles()` is a passive **listener** (its failures are
 *     logged, never fatal);
 *   - transports are **taps**: they see every message for observability, and are
 *     only authoritative when no module claims the thread.
 *
 * This keeps `send_message` semantics intact (the caller learns whether the
 * message reached the outside world) without any transport knowing about the
 * others.
 */
export class ModuleHost {
	private readonly options: ModuleHostOptions;
	private readonly runtimes: ModuleRuntime[] = [];
	private readonly tools: ToolDefinition[] = [];
	private readonly abort = new AbortController();
	private started = false;

	constructor(options: ModuleHostOptions) {
		this.options = options;
	}

	get moduleNames(): string[] {
		return this.runtimes.map((r) => r.module.name);
	}

	get transportNames(): string[] {
		return this.options.transports.map((t) => t.name);
	}

	async init(): Promise<void> {
		if (this.started) return;
		this.started = true;
		const { log } = this.options;

		const transportContext = {
			ingest: this.options.ingest,
			status: this.options.runtimeStatus,
			outbox: this.options.outbox,
			log: this.options.log,
		};
		for (const transport of this.options.transports) {
			try {
				await transport.start(transportContext);
			} catch (err) {
				log.error(`transport ${transport.name} failed to start`, { error: errorText(err) });
			}
		}

		for (const module of this.options.modules) {
			const runtime: ModuleRuntime = {
				module,
				handlers: [],
				statusContributors: [],
			};
			this.runtimes.push(runtime);
			const ctx = this.createContext(module, runtime);
			try {
				await module.start(ctx);
				// Tools are collected after start() so a module can build them from
				// initialized state (API client, identity, …).
				const declared = module.tools?.(ctx) ?? [];
				if (declared.length > 0) this.tools.push(...declared);
				log.info(`module ${module.name} started`, { kind: module.kind ?? "chat" });
			} catch (err) {
				runtime.error = errorText(err);
				log.error(`module ${module.name} failed to start`, { error: runtime.error });
			}
		}
	}

	async stop(): Promise<void> {
		this.abort.abort();
		for (const runtime of [...this.runtimes].reverse()) {
			try {
				await runtime.module.stop();
			} catch (err) {
				this.options.log.warn(`module ${runtime.module.name} failed to stop`, { error: errorText(err) });
			}
		}
		for (const transport of this.options.transports) {
			try {
				await transport.stop();
			} catch (err) {
				this.options.log.warn(`transport ${transport.name} failed to stop`, { error: errorText(err) });
			}
		}
	}

	/** Tools contributed by modules, in start order. */
	contributedTools(): ToolDefinition[] {
		return this.tools;
	}

	async deliver(message: OutgoingMessage): Promise<void> {
		const claimers: Array<{ name: string; handler: OutboundHandler }> = [];
		const listeners: Array<{ name: string; handler: OutboundHandler }> = [];
		for (const runtime of this.runtimes) {
			if (runtime.error) continue;
			for (const handler of runtime.handlers) {
				const handles = runtime.module.handles;
				if (!handles) listeners.push({ name: runtime.module.name, handler });
				else if (handles(message)) claimers.push({ name: runtime.module.name, handler });
			}
		}

		if (claimers.length > 0) {
			const failures: string[] = [];
			for (const claimer of claimers) {
				try {
					await claimer.handler(message);
				} catch (err) {
					failures.push(`${claimer.name}: ${errorText(err)}`);
				}
			}
			// Taps and passive listeners still see the message, but their failures
			// do not invalidate a successful, responsible delivery.
			await this.runTaps(message, listeners);
			if (failures.length > 0) throw new Error(`delivery failed: ${failures.join("; ")}`);
			return;
		}

		const errors = await this.runTaps(message, listeners);
		if (errors.length > 0) throw new Error(`all transports failed: ${errors.join("; ")}`);
	}

	private async runTaps(
		message: OutgoingMessage,
		listeners: Array<{ name: string; handler: OutboundHandler }>,
	): Promise<string[]> {
		const errors: string[] = [];
		for (const listener of listeners) {
			try {
				await listener.handler(message);
			} catch (err) {
				errors.push(`${listener.name}: ${errorText(err)}`);
				this.options.log.warn(`module ${listener.name} outbound handler failed`, { error: errorText(err) });
			}
		}
		for (const transport of this.options.transports) {
			try {
				await transport.send(message);
			} catch (err) {
				errors.push(`${transport.name}: ${errorText(err)}`);
				this.options.log.warn(`transport ${transport.name} send failed`, { error: errorText(err) });
			}
		}
		return errors;
	}

	status(): Record<string, unknown> {
		const modules: Record<string, unknown> = {};
		for (const runtime of this.runtimes) {
			const own = safeSnapshot(() => runtime.module.status?.() ?? {});
			const contributed = runtime.statusContributors.map((fn) => safeSnapshot(fn));
			modules[runtime.module.name] = {
				kind: runtime.module.kind ?? "chat",
				...(runtime.error ? { error: runtime.error } : {}),
				...own,
				...Object.assign({}, ...contributed),
			};
		}
		return {
			transports: this.transportNames,
			modules,
		};
	}

	private createContext(module: AliveModule, runtime: ModuleRuntime): ModuleContext {
		const { config, history, log } = this.options;
		const moduleLog = log.child(`module:${module.name}`);
		const name = module.name;
		return {
			name,
			config: config.config,
			paths: config.paths,
			log: moduleLog,
			signal: this.abort.signal,
			emit: (event) => this.options.ingest(event),
			userMessage: (input) => this.options.ingest(userMessageEvent(name, input)),
			event: (input) => this.options.ingest(moduleEvent(name, input)),
			onOutbound: (handler) => {
				runtime.handlers.push(handler);
				return () => {
					const index = runtime.handlers.indexOf(handler);
					if (index >= 0) runtime.handlers.splice(index, 1);
				};
			},
			history,
			registerTools: (tools) => {
				if (tools.length > 0) this.tools.push(...tools);
			},
			contributeStatus: (snapshot) => {
				runtime.statusContributors.push(snapshot);
			},
			runtimeStatus: () => this.options.runtimeStatus(),
			moduleDir: (...segments) => {
				const dir = path.join(config.paths.modulesDir, sanitize(name), ...segments);
				ensureDir(dir);
				return dir;
			},
		};
	}
}

function userMessageEvent(module: string, input: UserMessageInput): NewEvent {
	const author = input.author ?? input.authorId ?? "unknown";
	return {
		kind: "user_message",
		source: module,
		priority: input.priority ?? "normal",
		title: input.title ?? `message from ${author} on ${input.thread}`,
		text: input.text,
		thread: input.thread,
		expectsReply: input.expectsReply !== false,
		payload: input.payload,
		dedupeKey: input.dedupeKey,
		ts: input.ts,
		meta: {
			author,
			authorId: input.authorId,
			module,
			...(input.meta ?? {}),
		},
	};
}

function moduleEvent(module: string, input: ModuleEventInput): NewEvent {
	return {
		kind: input.kind ?? "observability",
		source: module,
		priority: input.priority ?? "normal",
		title: input.title ?? input.text.slice(0, 80),
		text: input.text,
		thread: input.thread,
		expectsReply: input.expectsReply === true,
		payload: input.payload,
		dedupeKey: input.dedupeKey,
		ts: input.ts,
		meta: { module, ...(input.meta ?? {}) },
	};
}

function safeSnapshot(fn: () => Record<string, unknown>): Record<string, unknown> {
	try {
		return fn() ?? {};
	} catch (err) {
		return { statusError: errorText(err) };
	}
}

function sanitize(name: string): string {
	return name.replace(/[^a-zA-Z0-9._-]+/g, "_");
}

function errorText(err: unknown): string {
	return err instanceof Error ? err.message : String(err);
}
