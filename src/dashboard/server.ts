/**
 * Plain Node `http` server for the dashboard.
 *
 * Deliberately dependency-free: no framework, no build step, no client JS. The
 * server only binds to loopback. Every route is GET/HEAD except
 * `POST /agent/<id>/settings`, which is the single write path: it requires a
 * per-render CSRF token, a urlencoded body under 1 MiB, and writes only inside
 * the selected profile (see `settings.ts`). There is no "run command" button
 * anywhere in the rendered pages.
 */
import * as http from "node:http";
import type { AddressInfo } from "node:net";
import { DEFAULT_SECRETS_CONFIG, type SecretsConfig } from "../secrets.js";
import { loadMemoryPage } from "./memory.js";
import {
	renderAgentPage,
	renderErrorPage,
	renderIndexPage,
	renderMemoryPage,
	renderRunPage,
	renderSettingsErrorPage,
	renderSettingsPage,
	type RenderContext,
} from "./render.js";
import {
	CsrfTokenStore,
	DASHBOARD_MAX_BODY_BYTES,
	SettingsEditError,
	applySettingsEdit,
	loadSettingsView,
	parseSettingsSubmission,
	readSettingsCsrfToken,
} from "./settings.js";
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

/** CSP for the one page that carries a form; every other page forbids form actions. */
const SETTINGS_CSP =
	"default-src 'none'; style-src 'unsafe-inline'; img-src data:; base-uri 'none'; form-action 'self'; frame-ancestors 'none'";

/** The dashboard can be reached on loopback only, and that is the only origin its form may target. */
function settingsPath(agentId: string): string {
	return `/agent/${encodeURIComponent(agentId)}/settings`;
}

/** Max accepted urlencoded body; also the cap for one config/prompt textarea. */
export const DASHBOARD_MAX_SETTINGS_BODY_BYTES = DASHBOARD_MAX_BODY_BYTES;

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

interface SettingsRoute {
	kind: "settings";
	agentId: string;
}

type Route = ResolvedRoute | AgentRoute | RunRoute | MemoryRoute | SettingsRoute | { kind: "not-found"; message: string };

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
	if (segments.length === 3 && segments[0] === "agent" && segments[2] === "settings") {
		const agentId = segments[1]!;
		if (!isValidAgentId(agentId)) return { kind: "not-found", message: `invalid agent id: ${agentId}` };
		return { kind: "settings", agentId };
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

/**
 * Read a request body with a hard size limit.
 *
 * The declared `content-length` is rejected up front; a chunked body that grows
 * past the limit is rejected as soon as the limit is crossed and drained, so a
 * client cannot keep the socket busy streaming gigabytes at the dashboard.
 */
function readRequestBody(req: http.IncomingMessage, maxBytes: number): Promise<Buffer> {
	return new Promise((resolve, reject) => {
		const declared = Number(req.headers["content-length"] ?? Number.NaN);
		if (Number.isFinite(declared) && declared > maxBytes) {
			reject(new SettingsEditError(413, `request body is larger than ${maxBytes} bytes`));
			req.resume();
			return;
		}
		const chunks: Buffer[] = [];
		let size = 0;
		let failed = false;
		req.on("data", (chunk: Buffer) => {
			if (failed) return;
			size += chunk.byteLength;
			if (size > maxBytes) {
				failed = true;
				chunks.length = 0;
				reject(new SettingsEditError(413, `request body is larger than ${maxBytes} bytes`));
				return;
			}
			chunks.push(chunk);
		});
		req.on("end", () => {
			if (!failed) resolve(Buffer.concat(chunks));
		});
		req.on("error", (error) => {
			if (!failed) reject(error);
		});
	});
}

function settingsErrorContext(secrets: SecretsConfig, env: NodeJS.ProcessEnv, now: number): RenderContext {
	return { secrets, env, now };
}

export function createDashboardServer(options: DashboardServerOptions): DashboardServer {
	const bind = validateDashboardBind(
		options.host ?? DEFAULT_DASHBOARD_HOST,
		options.port ?? DEFAULT_DASHBOARD_PORT,
		{ allowEphemeralPort: options.allowEphemeralPort },
	);
	const now = options.now ?? (() => Date.now());
	const env = options.env ?? process.env;
	const csrfTokens = new CsrfTokenStore();

	const fallbackContext = (): RenderContext => {
		try {
			const profiles = loadDashboard(loadRootConfig({ rootDir: options.rootDir, configPath: options.configPath }));
			return settingsErrorContext(profiles[0]?.config.config.secrets ?? DEFAULT_SECRETS_CONFIG, env, now());
		} catch {
			return settingsErrorContext(DEFAULT_SECRETS_CONFIG, env, now());
		}
	};

	const handleSettingsPost = async (
		req: http.IncomingMessage,
		res: http.ServerResponse,
		agentId: string,
	): Promise<void> => {
		let profile: DashboardProfile | undefined;
		try {
			const profiles = loadDashboard(loadRootConfig({ rootDir: options.rootDir, configPath: options.configPath }));
			profile = profileOrNull(profiles, agentId);
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			options.log?.(`dashboard settings error: ${message}`);
			send(res, 500, renderErrorPage(500, `internal dashboard error: ${message}`, fallbackContext()), false);
			return;
		}
		if (!profile) {
			send(res, 404, renderErrorPage(404, `unknown agent: ${agentId}`, fallbackContext()), false);
			return;
		}
		const target = { id: profile.id, name: profile.name };
		const context = settingsErrorContext(profile.config.config.secrets, env, now());
		try {
			const contentType = String(req.headers["content-type"] ?? "").split(";")[0]!.trim().toLowerCase();
			if (contentType !== "application/x-www-form-urlencoded") {
				throw new SettingsEditError(
					415,
					"settings POST requires Content-Type: application/x-www-form-urlencoded",
				);
			}
			const body = await readRequestBody(req, DASHBOARD_MAX_BODY_BYTES);
			const params = new URLSearchParams(body.toString("utf8"));
			// CSRF before anything else: no token, no parsing, no writing.
			if (!csrfTokens.consume(profile.id, readSettingsCsrfToken(params))) {
				throw new SettingsEditError(
					403,
					"invalid or missing CSRF token: reload the settings page and submit the form again",
				);
			}
			const submission = parseSettingsSubmission(params);
			const result = applySettingsEdit(profile, submission);
			options.log?.(
				`dashboard: saved ${profile.id} settings (${result.changed.map((change) => change.label).join(", ")})`,
			);
			res.writeHead(303, {
				location: `${settingsPath(profile.id)}?saved=1`,
				"content-length": "0",
				"cache-control": "no-store",
				"x-content-type-options": "nosniff",
				"referrer-policy": "no-referrer",
			});
			res.end();
		} catch (error) {
			if (error instanceof SettingsEditError) {
				send(res, error.status, renderSettingsErrorPage(target, error.status, [error.message], context), false);
				return;
			}
			const message = error instanceof Error ? error.message : String(error);
			options.log?.(`dashboard settings error: ${message}`);
			send(res, 500, renderSettingsErrorPage(target, 500, [`internal dashboard error: ${message}`], context), false);
		}
	};

	const server = http.createServer((req, res) => {
		const headOnly = req.method === "HEAD";
		const route = resolveDashboardRoute(req.url);
		if (req.method === "POST" && route.kind === "settings") {
			void handleSettingsPost(req, res, route.agentId).catch((error: unknown) => {
				const message = error instanceof Error ? error.message : String(error);
				options.log?.(`dashboard settings error: ${message}`);
				if (!res.headersSent) {
					send(res, 500, renderErrorPage(500, `internal dashboard error: ${message}`, fallbackContext()), false);
				}
			});
			return;
		}
		if (req.method !== "GET" && !headOnly) {
			const allow = route.kind === "settings" ? "GET, HEAD, POST" : "GET, HEAD";
			send(res, 405, renderErrorPage(405, `only ${allow} are allowed on this route`, fallbackContext()), false, { allow });
			return;
		}

		let base: DashboardProfile | undefined;
		try {
			const rootConfig = loadRootConfig({ rootDir: options.rootDir, configPath: options.configPath });
			const profiles = loadDashboard(rootConfig);
			base = profiles[0];
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
				case "settings": {
					const profile = profileOrNull(profiles, route.agentId);
					if (!profile) {
						send(res, 404, renderErrorPage(404, `unknown agent: ${route.agentId}`, renderContext), headOnly);
						return;
					}
					const searchParams = new URL(req.url ?? "/", "http://127.0.0.1").searchParams;
					const view = loadSettingsView(profile);
					// A token is minted per render; the POST consumes it.
					const csrfToken = csrfTokens.issue(profile.id, now());
					send(res, 200, renderSettingsPage(view, {
						secrets: profile.config.config.secrets,
						env,
						now: now(),
					}, { csrfToken, saved: searchParams.get("saved") === "1" }), headOnly, {
						"content-security-policy": SETTINGS_CSP,
					});
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
	log(`dashboard: http://${address.host}:${address.port}  (loopback only; settings edit is the only write path)`);
	log("press Ctrl+C to stop");
	await new Promise<void>((resolve) => {
		const stop = () => {
			void dashboard.close().finally(resolve);
		};
		process.once("SIGINT", stop);
		process.once("SIGTERM", stop);
	});
}
