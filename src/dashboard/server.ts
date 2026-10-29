/**
 * Plain Node `http` server for the read-only dashboard.
 *
 * Deliberately dependency-free: no framework, no build step, no client JS. The
 * server only binds to loopback and only answers GET/HEAD — there is no write
 * route and no "run command" button anywhere in the rendered pages.
 */
import * as http from "node:http";
import type { AddressInfo } from "node:net";
import { DEFAULT_SECRETS_CONFIG } from "../secrets.js";
import { loadMemoryPage } from "./memory.js";
import { renderAgentPage, renderErrorPage, renderIndexPage, renderMemoryPage, renderRunPage } from "./render.js";
import {
	findProfile,
	isValidAgentId,
	loadAgentDetail,
	loadDashboard,
	loadRootConfig,
	loadRunDetail,
	readAgentSummary,
	type DashboardProfile,
} from "./state.js";

export const DEFAULT_DASHBOARD_HOST = "127.0.0.1";
export const DEFAULT_DASHBOARD_PORT = 7777;

const RUN_ID_RE = /^[A-Za-z0-9_.-]{1,160}$/;

export interface DashboardBindOptions {
	/** Tests use an ephemeral port (0) to avoid colliding with a real dashboard. */
	allowEphemeralPort?: boolean;
}

/**
 * Refuse anything but loopback.
 *
 * `localhost` is normalised to `127.0.0.1`, so the socket is always IPv4
 * loopback; an operator asking for `0.0.0.0`, `::` or a LAN address gets a hard
 * error instead of an exposed read model of agent prompts.
 */
export function validateDashboardBind(
	hostInput: string,
	portInput: number,
	options: DashboardBindOptions = {},
): { host: string; port: number } {
	const host = (hostInput ?? "").trim().toLowerCase();
	if (host !== "127.0.0.1" && host !== "localhost") {
		throw new Error(
			`dashboard refuses to bind to "${hostInput}": only loopback is allowed (--host 127.0.0.1, or localhost)`,
		);
	}
	const port = portInput;
	const minPort = options.allowEphemeralPort ? 0 : 1;
	if (!Number.isInteger(port) || port < minPort || port > 65535) {
		throw new Error(`dashboard port must be an integer between ${minPort} and 65535, got "${String(portInput)}"`);
	}
	return { host: "127.0.0.1", port };
}

export interface DashboardServerOptions {
	rootDir: string;
	configPath?: string;
	host?: string;
	port?: number;
	env?: NodeJS.ProcessEnv;
	now?: () => number;
	log?: (line: string) => void;
	allowEphemeralPort?: boolean;
}

export interface DashboardServer {
	server: http.Server;
	listen(): Promise<{ host: string; port: number }>;
	close(): Promise<void>;
}

interface ResolvedRoute {
	kind: "index";
}

interface AgentRoute {
	kind: "agent";
	agentId: string;
}

interface RunRoute {
	kind: "run";
	agentId: string;
	runId: string;
}

interface MemoryRoute {
	kind: "memory";
	agentId: string;
}

type Route = ResolvedRoute | AgentRoute | RunRoute | MemoryRoute | { kind: "not-found"; message: string };

function decodeSegment(segment: string): string {
	try {
		return decodeURIComponent(segment);
	} catch {
		return "";
	}
}

export function resolveDashboardRoute(rawUrl: string | undefined): Route {
	let pathname: string;
	try {
		pathname = new URL(rawUrl ?? "/", "http://127.0.0.1").pathname;
	} catch {
		return { kind: "not-found", message: "invalid URL" };
	}
	const segments = pathname.split("/").filter((segment) => segment.length > 0).map(decodeSegment);
	if (segments.length === 0) return { kind: "index" };
	if (segments.length === 2 && segments[0] === "agent") {
		const agentId = segments[1]!;
		if (!isValidAgentId(agentId)) return { kind: "not-found", message: `invalid agent id: ${agentId}` };
		return { kind: "agent", agentId };
	}
	if (segments.length === 3 && segments[0] === "agent" && segments[2] === "memory") {
		const agentId = segments[1]!;
		if (!isValidAgentId(agentId)) return { kind: "not-found", message: `invalid agent id: ${agentId}` };
		return { kind: "memory", agentId };
	}
	if (segments.length === 3 && segments[0] === "run") {
		const agentId = segments[1]!;
		const runId = segments[2]!;
		if (!isValidAgentId(agentId)) return { kind: "not-found", message: `invalid agent id: ${agentId}` };
		if (!RUN_ID_RE.test(runId)) return { kind: "not-found", message: `invalid run id: ${runId}` };
		return { kind: "run", agentId, runId };
	}
	return { kind: "not-found", message: `no such page: ${pathname}` };
}

function send(
	res: http.ServerResponse,
	status: number,
	html: string,
	headOnly: boolean,
	extraHeaders: Record<string, string> = {},
): void {
	const body = Buffer.from(html, "utf8");
	res.writeHead(status, {
		"content-type": "text/html; charset=utf-8",
		"content-length": String(body.byteLength),
		"cache-control": "no-store",
		"x-content-type-options": "nosniff",
		"referrer-policy": "no-referrer",
		// No scripts, no forms, no frames: the page cannot become an action surface.
		"content-security-policy":
			"default-src 'none'; style-src 'unsafe-inline'; img-src data:; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
		...extraHeaders,
	});
	if (headOnly) {
		res.end();
		return;
	}
	res.end(body);
}

function profileOrNull(profiles: DashboardProfile[], id: string): DashboardProfile | undefined {
	return findProfile(profiles, id);
}

export function createDashboardServer(options: DashboardServerOptions): DashboardServer {
	const bind = validateDashboardBind(
		options.host ?? DEFAULT_DASHBOARD_HOST,
		options.port ?? DEFAULT_DASHBOARD_PORT,
		{ allowEphemeralPort: options.allowEphemeralPort },
	);
	const now = options.now ?? (() => Date.now());
	const env = options.env ?? process.env;

	const server = http.createServer((req, res) => {
		const headOnly = req.method === "HEAD";
		if (req.method !== "GET" && !headOnly) {
			send(res, 405, renderErrorPage(405, "read-only dashboard: only GET and HEAD are allowed", {
				secrets: DEFAULT_SECRETS_CONFIG,
				env,
				now: now(),
			}), false, { allow: "GET, HEAD" });
			return;
		}

		let base: DashboardProfile | undefined;
		try {
			const rootConfig = loadRootConfig({ rootDir: options.rootDir, configPath: options.configPath });
			const profiles = loadDashboard(rootConfig);
			base = profiles[0];
			const route = resolveDashboardRoute(req.url);
			const renderContext = {
				secrets: base?.config.config.secrets ?? DEFAULT_SECRETS_CONFIG,
				env,
				now: now(),
			};
			switch (route.kind) {
				case "index": {
					const summaries = profiles.map((profile) => readAgentSummary(profile, { now: now() }));
					send(res, 200, renderIndexPage(summaries, renderContext), headOnly);
					return;
				}
				case "agent": {
					const profile = profileOrNull(profiles, route.agentId);
					if (!profile) {
						send(res, 404, renderErrorPage(404, `unknown agent: ${route.agentId}`, renderContext), headOnly);
						return;
					}
					const detail = loadAgentDetail(profile, { now: now() });
					send(res, 200, renderAgentPage(detail, {
						secrets: profile.config.config.secrets,
						env,
						now: now(),
					}), headOnly);
					return;
				}
				case "memory": {
					const profile = profileOrNull(profiles, route.agentId);
					if (!profile) {
						send(res, 404, renderErrorPage(404, `unknown agent: ${route.agentId}`, renderContext), headOnly);
						return;
					}
					const searchParams = new URL(req.url ?? "/", "http://127.0.0.1").searchParams;
					const view = loadMemoryPage(profile, { query: searchParams.get("q") ?? "" });
					send(res, 200, renderMemoryPage(view, {
						secrets: profile.config.config.secrets,
						env,
						now: now(),
					}), headOnly);
					return;
				}
				case "run": {
					const profile = profileOrNull(profiles, route.agentId);
					if (!profile) {
						send(res, 404, renderErrorPage(404, `unknown agent: ${route.agentId}`, renderContext), headOnly);
						return;
					}
					const detail = loadRunDetail(profile, route.runId, { now: now() });
					if (!detail) {
						send(res, 404, renderErrorPage(404, `unknown run: ${route.runId}`, {
							secrets: profile.config.config.secrets,
							env,
							now: now(),
						}), headOnly);
						return;
					}
					send(res, 200, renderRunPage(detail, {
						secrets: profile.config.config.secrets,
						env,
						now: now(),
					}), headOnly);
					return;
				}
				default: {
					send(res, 404, renderErrorPage(404, route.message, renderContext), headOnly);
					return;
				}
			}
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			options.log?.(`dashboard error: ${message}`);
			send(res, 500, renderErrorPage(500, `internal dashboard error: ${message}`, {
				secrets: base?.config.config.secrets ?? DEFAULT_SECRETS_CONFIG,
				env,
				now: now(),
			}), headOnly);
		}
	});

	return {
		server,
		listen(): Promise<{ host: string; port: number }> {
			return new Promise((resolve, reject) => {
				const onError = (error: Error) => reject(error);
				server.once("error", onError);
				server.listen(bind.port, bind.host, () => {
					server.off("error", onError);
					const address = server.address() as AddressInfo | string | null;
					if (!address || typeof address === "string") {
						resolve({ host: bind.host, port: bind.port });
						return;
					}
					resolve({ host: address.address, port: address.port });
				});
			});
		},
		close(): Promise<void> {
			return new Promise((resolve) => {
				if (!server.listening) {
					resolve();
					return;
				}
				server.close(() => resolve());
			});
		},
	};
}

/**
 * Start the dashboard and block until SIGINT/SIGTERM, like `alive run --foreground`.
 * The bound socket is reported so the operator can open it; nothing is opened
 * automatically.
 */
export async function runDashboard(options: DashboardServerOptions): Promise<void> {
	const log = options.log ?? ((line: string) => process.stdout.write(`${line}\n`));
	const dashboard = createDashboardServer(options);
	const address = await dashboard.listen();
	log(`dashboard: http://${address.host}:${address.port}  (read-only, loopback only)`);
	log("press Ctrl+C to stop");
	await new Promise<void>((resolve) => {
		const stop = () => {
			void dashboard.close().finally(resolve);
		};
		process.once("SIGINT", stop);
		process.once("SIGTERM", stop);
	});
}
