/**
 * Host-side `dashboard` tool: start, inspect and close the loopback dashboard
 * from inside the agent runtime.
 *
 * The agent is sandboxed and cannot bind a host port. This module is a trusted
 * host service (like memory or messaging): it starts the existing dashboard
 * command as a detached child on loopback, optionally attaches the existing
 * cloudflared quick tunnel, and hands the agent a link.
 *
 * Process lifecycle
 * -----------------
 * - `open` is idempotent. A dashboard already answering on the configured
 *   loopback port is adopted (or reused) instead of starting a second process.
 * - The detached child keeps running after `close`; `close` only detaches
 *   external access (tunnel + sessions + outstanding tickets).
 * - The tunnel is owned by this runtime process, not by the child, so it can be
 *   stopped without killing the local server. Its origin is written to the
 *   shared dashboard state, which the server reads to enforce Origin/Host
 *   checks for non-GET requests.
 *
 * Access control
 * --------------
 * Every action is refused outside the owner's private chats unless the thread is
 * listed in `dashboard.allowedThreads`. A group link always requires an
 * explicit `mode: "tunnel"`; the default stays `local`.
 */
import { spawn } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import type { QuickTunnel } from "../modules/browser/tunnel.js";
import { isProcessAlive, sleep } from "../util.js";
import { DashboardAuthStore, hasDashboardPassword } from "./auth.js";
import {
	validateDashboardBind,
	validateDashboardPublicUrl,
	DEFAULT_DASHBOARD_HOST,
	DEFAULT_DASHBOARD_PORT,
	DASHBOARD_MARKER_HEADER,
	DASHBOARD_MARKER_VALUE,
} from "./server.js";
import {
	readDashboardState,
	updateDashboardState,
	type DashboardMode,
	type DashboardRuntimeRecord,
} from "./state-file.js";
import {
	DashboardTicketStore,
	DASHBOARD_TICKET_RATE_MAX,
	DASHBOARD_TICKET_RATE_WINDOW_MS,
	DASHBOARD_TICKET_SESSION_TTL_MS,
	DASHBOARD_TICKET_TTL_MS,
} from "./tickets.js";

/** How long one `open` may spend waiting for the child to answer on loopback. */
export const DASHBOARD_START_TIMEOUT_MS = 15_000;
const START_POLL_MS = 120;
/** External access gets a hard ceiling even if nobody closes it. */
export const DASHBOARD_TUNNEL_TTL_MS = 60 * 60_000;
/** How long an `open` waits for an existing dashboard that is alive but not answering yet. */
const EXISTING_WAIT_MS = 1_500;
/** Probe timeout; the dashboard answers instantly on loopback. */
const PROBE_TIMEOUT_MS = 1_500;

export type DashboardAction = "open" | "status" | "close";

export interface DashboardToolRequest {
	/** The thread the call came from; used for access control and the ticket audit log. */
	thread: string;
	/** Only `open`. Defaults to `local`; `tunnel` must be explicit. */
	mode?: DashboardMode;
}

export interface DashboardAccessDecision {
	allowed: boolean;
	/** Owner console / private chat, not an allowlisted group. */
	privateThread: boolean;
	reason?: string;
}

/**
 * Thread id conventions relevant here: the local console, the operator TUI chat
 * (`local:agent:<id>:operator`), and Telegram private chats
 * (`telegram:<positive id>`). Groups have negative chat ids, and a forum topic
 * is never a private chat.
 */
export function isPrivateOwnerThread(thread: string): boolean {
	const value = (thread ?? "").trim().toLowerCase();
	if (value === "console" || value === "local") return true;
	if (/^local:agent:[a-z0-9][a-z0-9_-]{0,47}:operator$/.test(value)) return true;
	const prefix = "telegram:";
	if (!value.startsWith(prefix)) return false;
	const rest = value.slice(prefix.length);
	if (!rest || rest.includes("/")) return false;
	return /^\d+$/.test(rest);
}

/**
 * Decide whether a thread may use the dashboard tool.
 *
 * `allowedThreads` is an explicit operator allowlist (for example an approved
 * work group). It can never make an unlisted group pass, and it does not change
 * whether a link needs `mode: "tunnel"`.
 */
export function dashboardAccess(thread: string, allowedThreads: string[]): DashboardAccessDecision {
	const value = (thread ?? "").trim();
	if (!value) {
		return { allowed: false, privateThread: false, reason: "the dashboard tool needs a requesting thread" };
	}
	const allowed = new Set(allowedThreads.map((entry) => entry.trim()).filter((entry) => entry.length > 0));
	const privateThread = isPrivateOwnerThread(value);
	if (privateThread) return { allowed: true, privateThread: true };
	if (allowed.has(value)) return { allowed: true, privateThread: false };
	return {
		allowed: false,
		privateThread: false,
		reason:
			`dashboard is not available in thread ${value}: it may only be used from the owner's private chat ` +
			`or from a thread listed in dashboard.allowedThreads`,
	};
}

/** One detached dashboard child; only the pid is needed by the tool. */
export interface DashboardChildSpec {
	entry: string;
	args: string[];
	cwd: string;
	env: NodeJS.ProcessEnv;
	logFile: string;
}

export interface DashboardChildHandle {
	pid: number;
}

export type DashboardChildStarter = (spec: DashboardChildSpec) => DashboardChildHandle | Promise<DashboardChildHandle>;

/** A tunnel owned by the runtime process (fake in tests). */
export interface DashboardTunnelHandle {
	origin: string;
	handle: QuickTunnel;
	controller: AbortController;
	startedAt: number;
	expiresAt: number;
}

export interface DashboardToolOptions {
	/** Profile root, passed to the child as its working directory. */
	rootDir: string;
	/** Profile config path; the child must serve the same repo/config. */
	configPath: string;
	/** Profile state directory; auth, tickets and dashboard state live here. */
	stateDir: string;
	/** Loopback port; defaults to `DEFAULT_DASHBOARD_PORT`. Never any other host. */
	port?: number;
	/** `dashboard.allowedThreads`. */
	allowedThreads?: string[];
	now?: () => number;
	log?: (line: string) => void;
	/** Tests: count spawns without a process. */
	spawnDashboard?: DashboardChildStarter;
	/** Tests: never touch the network. */
	probe?: (url: string) => Promise<boolean>;
	/** Tests: fake `startQuickTunnel`. */
	startTunnel?: (url: string, signal: AbortSignal) => Promise<QuickTunnel>;
	/** Defaults to `hasDashboardPassword(stateDir)`. */
	hasPassword?: () => boolean;
	/** Entry script re-exec'd for the child; defaults to the running CLI. */
	entry?: string;
	tunnelTtlMs?: number;
	startTimeoutMs?: number;
	startPollMs?: number;
	ticketTtlMs?: number;
	ticketSessionTtlMs?: number;
	ticketMaxPerWindow?: number;
	ticketWindowMs?: number;
}

export interface DashboardOpenResult {
	url: string;
	mode: DashboardMode;
	/** Epoch ms when the delivered link stops working; `null` for a local URL. */
	expiresAt: number | null;
	/** Raw one-time ticket; present only for tunnel links. Never log this. */
	ticket?: string;
	ticketExpiresAt?: number;
	tunnelUrl?: string;
	tunnelExpiresAt?: number;
	localUrl: string;
	port: number;
	/** True when an already-running dashboard was reused instead of spawned. */
	reused: boolean;
	/** The dashboard was adopted from outside this tool (no pid recorded). */
	adopted: boolean;
	privateThread: boolean;
}

export interface DashboardStatusResult {
	running: boolean;
	port: number;
	mode: DashboardMode | null;
	localUrl: string | null;
	tunnelUrl: string | null;
	/** Epoch ms of the active tunnel's deadline; `null` without external access. */
	expiresAt: number | null;
	startedAt: number | null;
	/** Live password/ticket sessions from `<stateDir>/dashboard/auth.json`. */
	externalSessions: number;
	privateThread: boolean;
}

export interface DashboardCloseResult {
	stoppedTunnel: boolean;
	revokedSessions: number;
	revokedTickets: number;
	/** The loopback server is deliberately left running. */
	running: boolean;
	localUrl: string | null;
	port: number;
	privateThread: boolean;
}

/** Header used to recognise a dashboard on a loopback port. */
async function probeDashboard(url: string): Promise<boolean> {
	try {
		const response = await fetch(url, {
			redirect: "manual",
			signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
			headers: { accept: "text/html" },
		});
		// Drain the body so the socket can be reused/closed promptly.
		await response.body?.cancel().catch(() => undefined);
		return response.headers.get(DASHBOARD_MARKER_HEADER) === DASHBOARD_MARKER_VALUE;
	} catch {
		return false;
	}
}

function defaultSpawn(spec: DashboardChildSpec): DashboardChildHandle {
	fs.mkdirSync(path.dirname(spec.logFile), { recursive: true });
	const fd = fs.openSync(spec.logFile, "a");
	try {
		fs.writeSync(
			fd,
			`\n=== alive dashboard --serve (runtime tool, background) started ${new Date().toISOString()} ===\n`,
		);
		// Same re-exec pattern as the background runtime: the loader (tsx in dev)
		// travels in execArgv, so the child serves exactly this repo and config.
		const child = spawn(process.execPath, [...process.execArgv, spec.entry, ...spec.args], {
			cwd: spec.cwd,
			detached: true,
			stdio: ["ignore", fd, fd],
			env: { ...process.env, ...spec.env },
		});
		child.on("error", () => undefined);
		child.unref();
		if (child.pid === undefined) throw new Error("failed to spawn the background dashboard");
		return { pid: child.pid };
	} finally {
		fs.closeSync(fd);
	}
}

export class DashboardTool {
	private readonly now: () => number;
	private readonly port: number;
	private readonly allowedThreads: string[];
	private readonly localUrl: string;
	private readonly tickets: DashboardTicketStore;
	private readonly auth: DashboardAuthStore;
	private readonly spawnDashboard: DashboardChildStarter;
	private readonly probe: (url: string) => Promise<boolean>;
	private readonly startTunnel: (url: string, signal: AbortSignal) => Promise<QuickTunnel>;
	private readonly hasPassword: () => boolean;
	private readonly entry: string;
	private readonly tunnelTtlMs: number;
	private readonly startTimeoutMs: number;
	private readonly startPollMs: number;
	private tunnel?: DashboardTunnelHandle;

	constructor(private readonly options: DashboardToolOptions) {
		this.now = options.now ?? Date.now;
		const bind = validateDashboardBind(DEFAULT_DASHBOARD_HOST, options.port ?? DEFAULT_DASHBOARD_PORT);
		this.port = bind.port;
		this.localUrl = `http://${bind.host}:${bind.port}`;
		this.allowedThreads = options.allowedThreads ?? [];
		this.tickets = new DashboardTicketStore(options.stateDir, this.now, {
			ttlMs: options.ticketTtlMs ?? DASHBOARD_TICKET_TTL_MS,
			sessionTtlMs: options.ticketSessionTtlMs ?? DASHBOARD_TICKET_SESSION_TTL_MS,
			maxPerWindow: options.ticketMaxPerWindow ?? DASHBOARD_TICKET_RATE_MAX,
			windowMs: options.ticketWindowMs ?? DASHBOARD_TICKET_RATE_WINDOW_MS,
		});
		this.auth = new DashboardAuthStore(options.stateDir, this.now);
		this.spawnDashboard = options.spawnDashboard ?? defaultSpawn;
		this.probe = options.probe ?? probeDashboard;
		this.startTunnel = options.startTunnel
			?? (async (url, signal) => {
				const { startQuickTunnel } = await import("../modules/browser/tunnel.js");
				return startQuickTunnel(url, signal);
			});
		this.hasPassword = options.hasPassword ?? (() => hasDashboardPassword(options.stateDir));
		this.entry = options.entry ?? process.argv[1] ?? "";
		this.tunnelTtlMs = options.tunnelTtlMs ?? DASHBOARD_TUNNEL_TTL_MS;
		this.startTimeoutMs = options.startTimeoutMs ?? DASHBOARD_START_TIMEOUT_MS;
		this.startPollMs = options.startPollMs ?? START_POLL_MS;
	}

	/** The configured loopback URL (always `http://127.0.0.1:<port>`). */
	loopbackUrl(): string {
		return this.localUrl;
	}

	private log(line: string): void {
		// Never pass a ticket through here: callers describe the thread and the
		// action, not the credential.
		this.options.log?.(`dashboard tool: ${line}`);
	}

	private requireAccess(thread: string): DashboardAccessDecision {
		const decision = dashboardAccess(thread, this.allowedThreads);
		if (!decision.allowed) throw new Error(decision.reason ?? "dashboard is not available in this thread");
		return decision;
	}

	private runtimeRecord(): DashboardRuntimeRecord | undefined {
		return readDashboardState(this.options.stateDir, this.now()).runtime;
	}

	private writeRuntime(runtime: DashboardRuntimeRecord | undefined): void {
		updateDashboardState(this.options.stateDir, this.now(), (state) => {
			if (runtime === undefined) delete state.runtime;
			else state.runtime = runtime;
		});
	}

	private async answers(url: string): Promise<boolean> {
		try {
			return await this.probe(url);
		} catch {
			return false;
		}
	}

	private async waitForDashboard(url: string, timeoutMs: number): Promise<boolean> {
		const deadline = Date.now() + Math.max(0, timeoutMs);
		for (;;) {
			if (await this.answers(url)) return true;
			if (Date.now() >= deadline) return false;
			await sleep(this.startPollMs);
		}
	}

	/**
	 * Is the recorded runtime still serving? A recorded pid must be alive, and
	 * the loopback port must answer with the dashboard marker. An adopted server
	 * has no pid and is judged by the probe alone.
	 */
	private async runtimeAlive(runtime: DashboardRuntimeRecord | undefined): Promise<boolean> {
		if (!runtime) return false;
		// Whichever process owns the port, a dashboard answering with the marker is
		// what matters: the recorded pid may be gone while an adopted server serves.
		if (await this.answers(runtime.localUrl)) return true;
		if (runtime.pid !== undefined && !isProcessAlive(runtime.pid)) return false;
		// A just-spawned child can take a moment to bind.
		return this.waitForDashboard(runtime.localUrl, EXISTING_WAIT_MS);
	}

	/**
	 * Ensure a loopback dashboard is running, without spawning a second one.
	 * Returns the record plus whether it was reused/adopted.
	 */
	private async ensureRunning(): Promise<{ runtime: DashboardRuntimeRecord; reused: boolean; adopted: boolean }> {
		const recorded = this.runtimeRecord();
		if (await this.runtimeAlive(recorded)) {
			return { runtime: recorded!, reused: true, adopted: recorded!.adopted === true };
		}
		// Never stack a second dashboard on a child that is alive but unresponsive:
		// the second bind would fail and leave two confusing pid records.
		if (recorded?.pid !== undefined && isProcessAlive(recorded.pid)) {
			throw new Error(
				`dashboard process ${recorded.pid} is alive but is not answering on ${this.localUrl}; ` +
				"check it or stop it before opening another one",
			);
		}
		// The port may already carry a dashboard started by hand (`alive dashboard
		// --serve`) or by a previous runtime. Adopt it instead of stacking servers.
		if (await this.answers(this.localUrl)) {
			const adopted: DashboardRuntimeRecord = {
				port: this.port,
				localUrl: this.localUrl,
				startedAt: this.now(),
				mode: "local",
				adopted: true,
			};
			this.writeRuntime(adopted);
			this.log(`adopted an already-running dashboard on ${this.localUrl}`);
			return { runtime: adopted, reused: true, adopted: true };
		}
		if (!this.entry) throw new Error("cannot locate the alive entry script to start the dashboard");
		const logFile = path.join(this.options.stateDir, "logs", "dashboard.log");
		const handle = await this.spawnDashboard({
			entry: this.entry,
			args: [
				"dashboard",
				"--serve",
				"--host",
				DEFAULT_DASHBOARD_HOST,
				"--port",
				String(this.port),
				"--config",
				this.options.configPath,
			],
			cwd: this.options.rootDir,
			env: { ALIVE_DASHBOARD_DAEMON: "1" },
			logFile,
		});
		const ready = await this.waitForDashboard(this.localUrl, this.startTimeoutMs);
		if (!ready) {
			try {
				process.kill(handle.pid, "SIGTERM");
			} catch {
				// The child may already be gone.
			}
			throw new Error(
				`dashboard process ${handle.pid} did not answer on ${this.localUrl}; see ${logFile}`,
			);
		}
		const runtime: DashboardRuntimeRecord = {
			pid: handle.pid,
			port: this.port,
			localUrl: this.localUrl,
			startedAt: this.now(),
			mode: "local",
		};
		this.writeRuntime(runtime);
		this.log(`started the dashboard on ${this.localUrl} (pid ${handle.pid})`);
		return { runtime, reused: false, adopted: false };
	}

	/** Stop external access that has outlived its deadline. */
	private async enforceTunnelExpiry(runtime: DashboardRuntimeRecord | undefined): Promise<DashboardRuntimeRecord | undefined> {
		if (!runtime || runtime.mode !== "tunnel" || runtime.tunnelExpiresAt === undefined) return runtime;
		if (runtime.tunnelExpiresAt > this.now()) return runtime;
		await this.stopTunnel();
		// A stale ticket session must not outlive the external link.
		this.auth.revokeAllSessions();
		this.tickets.revokeAll();
		const cleared: DashboardRuntimeRecord = { ...runtime, mode: "local" };
		delete cleared.tunnelUrl;
		delete cleared.tunnelStartedAt;
		delete cleared.tunnelExpiresAt;
		this.writeRuntime(cleared);
		this.log(`external access expired at ${new Date(runtime.tunnelExpiresAt).toISOString()}; tunnel stopped and sessions revoked`);
		return cleared;
	}

	private async stopTunnel(): Promise<boolean> {
		const tunnel = this.tunnel;
		if (!tunnel) return false;
		this.tunnel = undefined;
		tunnel.controller.abort();
		try {
			await tunnel.handle.stop();
		} catch {
			// A tunnel that is already gone still counts as stopped.
		}
		return true;
	}

	/** `dashboard({action:"open", mode?})`. */
	async open(request: DashboardToolRequest): Promise<DashboardOpenResult> {
		const access = this.requireAccess(request.thread);
		const mode: DashboardMode = request.mode ?? "local";
		if (mode !== "local" && mode !== "tunnel") throw new Error(`unknown dashboard mode ${String(request.mode)}`);
		// #105 guard, before anything is started: external access always keeps the
		// password layer available for direct logins; a ticket is an alternative
		// entry, not a replacement. The CLI/environment may set one later, but a
		// tunnel must never be exposed without it.
		if (mode === "tunnel" && !this.hasPassword()) {
			throw new Error(
				"dashboard tunnel refused: no dashboard password is set; run `alive dashboard --set-password` first",
			);
		}
		const now = this.now();
		let { runtime, reused, adopted } = await this.ensureRunning();
		runtime = (await this.enforceTunnelExpiry(runtime))!;

		let activeTunnel: DashboardTunnelHandle | undefined;
		if (runtime.mode === "tunnel" && runtime.tunnelUrl !== undefined && runtime.tunnelExpiresAt !== undefined) {
			if (this.tunnel && this.tunnel.origin === runtime.tunnelUrl) activeTunnel = this.tunnel;
		}

		if (mode === "tunnel") {
			if (!activeTunnel) {
				const controller = new AbortController();
				const handle = await this.startTunnel(this.localUrl, controller.signal);
				const origin = validateDashboardPublicUrl(handle.origin);
				activeTunnel = {
					origin,
					handle,
					controller,
					startedAt: now,
					expiresAt: now + this.tunnelTtlMs,
				};
				this.tunnel = activeTunnel;
				reused = false;
				const withTunnel: DashboardRuntimeRecord = {
					...runtime,
					mode: "tunnel",
					tunnelUrl: origin,
					tunnelStartedAt: activeTunnel.startedAt,
					tunnelExpiresAt: activeTunnel.expiresAt,
				};
				runtime = withTunnel;
				this.writeRuntime(withTunnel);
				this.log(`attached a quick tunnel at ${origin} for thread ${request.thread} (expires ${new Date(activeTunnel.expiresAt).toISOString()})`);
			}
			const issued = this.tickets.issue(request.thread);
			const url = `${activeTunnel.origin}/t?t=${encodeURIComponent(issued.token)}`;
			return {
				url,
				mode: "tunnel",
				expiresAt: issued.expiresAt,
				ticket: issued.token,
				ticketExpiresAt: issued.expiresAt,
				tunnelUrl: activeTunnel.origin,
				tunnelExpiresAt: activeTunnel.expiresAt,
				localUrl: this.localUrl,
				port: this.port,
				reused,
				adopted,
				privateThread: access.privateThread,
			};
		}

		// Local is the default and never creates external access by itself.
		return {
			url: this.localUrl,
			mode: "local",
			expiresAt: null,
			...(activeTunnel ? { tunnelUrl: activeTunnel.origin, tunnelExpiresAt: activeTunnel.expiresAt } : {}),
			localUrl: this.localUrl,
			port: this.port,
			reused,
			adopted,
			privateThread: access.privateThread,
		};
	}

	/** `dashboard({action:"status"})`. */
	async status(request: DashboardToolRequest): Promise<DashboardStatusResult> {
		const access = this.requireAccess(request.thread);
		let runtime = await this.enforceTunnelExpiry(this.runtimeRecord());
		// A dashboard started by hand (`alive dashboard --serve`) has no runtime
		// record yet; report it instead of claiming nothing is running.
		if (!runtime && await this.answers(this.localUrl)) {
			runtime = { port: this.port, localUrl: this.localUrl, startedAt: this.now(), mode: "local", adopted: true };
		}
		const running = await this.runtimeAlive(runtime);
		return {
			running,
			port: runtime?.port ?? this.port,
			mode: running ? runtime?.mode ?? "local" : null,
			localUrl: running ? runtime?.localUrl ?? this.localUrl : runtime?.localUrl ?? this.localUrl,
			tunnelUrl: running ? runtime?.tunnelUrl ?? null : null,
			expiresAt: running ? runtime?.tunnelExpiresAt ?? null : null,
			startedAt: runtime?.startedAt ?? null,
			externalSessions: this.auth.activeSessionCount(),
			privateThread: access.privateThread,
		};
	}

	/** `dashboard({action:"close"})`: external access only. */
	async close(request: DashboardToolRequest): Promise<DashboardCloseResult> {
		const access = this.requireAccess(request.thread);
		const stoppedTunnel = await this.stopTunnel();
		const revokedSessions = this.auth.revokeAllSessions();
		const revokedTickets = this.tickets.revokeAll();
		const runtime = this.runtimeRecord();
		if (runtime) {
			const cleared: DashboardRuntimeRecord = { ...runtime, mode: "local" };
			delete cleared.tunnelUrl;
			delete cleared.tunnelStartedAt;
			delete cleared.tunnelExpiresAt;
			this.writeRuntime(cleared);
		}
		const running = await this.runtimeAlive(runtime);
		this.log(
			`closed external access (tunnel ${stoppedTunnel ? "stopped" : "was not attached"}, ` +
			`${revokedSessions} session(s), ${revokedTickets} ticket(s)); the local dashboard keeps running`,
		);
		return {
			stoppedTunnel,
			revokedSessions,
			revokedTickets,
			running,
			localUrl: runtime?.localUrl ?? this.localUrl,
			port: runtime?.port ?? this.port,
			privateThread: access.privateThread,
		};
	}
}
