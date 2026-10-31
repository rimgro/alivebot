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
import { isIP, type AddressInfo } from "node:net";
import { startQuickTunnel, type QuickTunnel } from "../modules/browser/tunnel.js";
import { DEFAULT_SECRETS_CONFIG, createMaskContext, maskSecrets, type SecretsConfig } from "../secrets.js";
import { loadMemoryPage } from "./memory.js";
import {
	renderAgentPage,
	renderErrorPage,
	renderIndexPage,
	renderLoginPage,
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
	DashboardAuthStore,
	DASHBOARD_LOGIN_DELAY_MS,
	DASHBOARD_LOGIN_MAX_FAILURES,
	DASHBOARD_LOGIN_WINDOW_MS,
	DASHBOARD_SESSION_TTL_MS,
	LoginRateLimiter,
	clearedSessionCookie,
	hasDashboardPassword,
	readCookie,
	sessionCookie,
} from "./auth.js";
import {
	findProfile,
	isValidAgentId,
	loadAgentDetail,
	loadDashboard,
	loadRootConfig,
	loadRunDetail,
	parseTimelineQuery,
	readAgentSummary,
	type DashboardProfile,
} from "./state.js";
import { DashboardTicketStore, type DashboardTicketOptions } from "./tickets.js";
import { readDashboardRuntime } from "./state-file.js";

export const DEFAULT_DASHBOARD_HOST = "127.0.0.1";
export const DEFAULT_DASHBOARD_PORT = 7777;
export const DEFAULT_DASHBOARD_SESSION_TTL_HOURS = 12;
/**
 * Header put on every dashboard response. The runtime `dashboard` tool probes
 * the configured loopback port with it to tell "a dashboard is already running"
 * apart from "some unrelated service owns the port".
 */
export const DASHBOARD_MARKER_HEADER = "x-alive-dashboard";
export const DASHBOARD_MARKER_VALUE = "alive";
/** Small body cap for login/logout forms. */
export const DASHBOARD_AUTH_MAX_BODY_BYTES = 16 * 1024;
/** One text for every bad credential; never say whether the password was close. */
export const DASHBOARD_LOGIN_ERROR = "invalid password";
/** Blocked-after-five message. The retry window is deliberately not exposed in seconds. */
export const DASHBOARD_LOGIN_BLOCKED_ERROR = "too many failed attempts; try again in a minute";

const RUN_ID_RE = /^[A-Za-z0-9_.-]{1,160}$/;
const LOGOUT_CSRF_KEY = "dashboard-logout";

/** CSP for the pages that carry a form; other pages forbid form actions. */
const SETTINGS_CSP =
	"default-src 'none'; style-src 'unsafe-inline'; img-src data:; base-uri 'none'; form-action 'self'; frame-ancestors 'none'";
const LOGIN_CSP = SETTINGS_CSP;
/** Authenticated pages carry only the logout form, so form actions stay same-origin. */
const AUTH_PAGE_CSP = SETTINGS_CSP;
/**
 * The agent page carries one GET-only filter form (the timeline search box).
 * Its action is the same page, and no route accepts a write there, so a
 * same-origin form action is safe.
 */
const AGENT_PAGE_CSP =
	"default-src 'none'; style-src 'unsafe-inline'; img-src data:; base-uri 'none'; form-action 'self'; frame-ancestors 'none'";
/** Unauthenticated non-GET checks are enabled only while a public tunnel origin is attached. */

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

/** Password/session settings for a dashboard that is reachable off-loopback. */
export interface DashboardAuthOptions {
	/** The root profile state directory; auth lives in `<stateDir>/dashboard/auth.json`. */
	stateDir: string;
	/** Session lifetime; defaults to 12 hours. */
	ttlMs?: number;
	/** Injectable clock (tests use it to expire sessions and the login window). */
	now?: () => number;
	/** Wrong-password delay; defaults to ~400 ms. */
	loginDelayMs?: number;
	maxLoginFailures?: number;
	loginWindowMs?: number;
}

/** One-time external-access tickets; only meaningful together with `auth`. */
export interface DashboardTicketServerOptions extends DashboardTicketOptions {
	/** The root profile state directory; tickets and runtime state live in `<stateDir>/dashboard/`. */
	stateDir: string;
	/** Injectable clock, defaults to the server clock. */
	now?: () => number;
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
	/** Enable the password/login/session layer. Without it the dashboard keeps its previous loopback-only behavior. */
	auth?: DashboardAuthOptions;
	/** Set when the loopback server is behind the temporary HTTPS tunnel. */
	publicOrigin?: string;
	/**
	 * Enable `GET /t?t=…` one-time ticket exchange. The tunnel origin is then
	 * also read from the shared dashboard state, so a tunnel started by the
	 * runtime `dashboard` tool (not by this process) still enables Origin/Host
	 * checks for non-GET requests.
	 */
	tickets?: DashboardTicketServerOptions;
}

export interface DashboardServer {
	server: http.Server;
	listen(): Promise<{ host: string; port: number }>;
	/** Attach (or clear) the public tunnel origin after the tunnel is ready. */
	setPublicOrigin(origin: string | undefined): void;
	publicOrigin(): string | undefined;
	close(): Promise<void>;
}

/** Is this a bind target the dashboard may use? Same rule as `validateDashboardBind`. */
export function isLoopbackDashboardHost(hostInput: string): boolean {
	const host = (hostInput ?? "").trim().toLowerCase();
	return host === "127.0.0.1" || host === "localhost";
}

/** Validate and normalise the tunnel's public origin; only an HTTPS URL is acceptable. */
export function validateDashboardPublicUrl(publicUrl: string): string {
	let url: URL;
	try {
		url = new URL(publicUrl);
	} catch {
		throw new Error(`--tunnel requires an https public URL, got "${publicUrl}"`);
	}
	if (url.protocol !== "https:" || !url.hostname) {
		throw new Error(`--tunnel requires an https public URL, got "${publicUrl}"`);
	}
	if (url.username || url.password) throw new Error("--tunnel public URL must not contain credentials");
	return url.origin;
}

export interface TunnelAccessOptions {
	host: string;
	publicUrl: string;
	hasPassword: boolean;
}

/**
 * The hard guard for `--tunnel`: loopback bind, an HTTPS public URL, and a
 * password hash already on disk. It deliberately does not generate a password:
 * a quick tunnel can start and print a URL only after the operator has run
 * `alive dashboard --set-password`.
 */
export function validateTunnelAccess(options: TunnelAccessOptions): void {
	if (!isLoopbackDashboardHost(options.host)) {
		throw new Error(`--tunnel requires a loopback bind (127.0.0.1 or localhost), got "${options.host}"`);
	}
	if (!options.hasPassword) {
		throw new Error("dashboard tunnel refused: no dashboard password is set; run `alive dashboard --set-password` first");
	}
	validateDashboardPublicUrl(options.publicUrl);
}

/** A tunnel handle; tests inject a fake `start` so cloudflared is never spawned. */
export interface DashboardTunnelOptions {
	enabled?: boolean;
	start?: (url: string, signal: AbortSignal) => Promise<QuickTunnel>;
	cloudflared?: string;
	/**
	 * An externally terminated HTTPS origin (reverse proxy / rathole on a VPS).
	 * When set, cloudflared is not started: the loopback server simply trusts
	 * this origin for Origin/Host checks and ticket links.
	 */
	publicUrl?: string;
}

export interface DashboardRunOptions extends DashboardServerOptions {
	tunnel?: DashboardTunnelOptions;
	/** Tests and embedders can stop the server without sending a signal. */
	signal?: AbortSignal;
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
		[DASHBOARD_MARKER_HEADER]: DASHBOARD_MARKER_VALUE,
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

function headerValue(value: string | string[] | undefined): string | undefined {
	if (Array.isArray(value)) return value[0];
	return value;
}

function redirect(res: http.ServerResponse, location: string, setCookie?: string): void {
	const headers: Record<string, string> = {
		location,
		"content-length": "0",
		"cache-control": "no-store",
		"x-content-type-options": "nosniff",
		"referrer-policy": "no-referrer",
		[DASHBOARD_MARKER_HEADER]: DASHBOARD_MARKER_VALUE,
	};
	if (setCookie) headers["set-cookie"] = setCookie;
	res.writeHead(303, headers);
	res.end();
}

function delay(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, Math.max(0, ms)));
}

function normalizeIp(value: string | undefined): string {
	const ip = (value ?? "").trim();
	return ip.startsWith("::ffff:") ? ip.slice(7) : ip;
}

function isLoopbackIp(ip: string): boolean {
	return ip === "::1" || ip === "localhost" || /^127\./.test(ip);
}

function isLoopbackHostHeader(hostHeader: string): boolean {
	const host = hostHeader.trim().toLowerCase();
	if (host.startsWith("[")) {
		const end = host.indexOf("]");
		return end > 0 && host.slice(1, end) === "::1";
	}
	const colon = host.lastIndexOf(":");
	const name = colon >= 0 ? host.slice(0, colon) : host;
	return name === "127.0.0.1" || name === "localhost";
}

/**
 * Client IP for login throttling.
 *
 * Behind the quick tunnel the socket peer is cloudflared on loopback, so the
 * tunnel-provided `CF-Connecting-IP` is the address to use. It is only trusted
 * when the peer really is loopback (the local tunnel endpoint). Direct
 * localhost requests never trust a forwarded header. `X-Forwarded-For` is
 * intentionally never consulted: it is client-controlled.
 */
function clientIp(req: http.IncomingMessage, exposed: boolean): string {
	const remote = normalizeIp(req.socket.remoteAddress) || "unknown";
	if (!exposed || !isLoopbackIp(remote)) return remote;
	const forwarded = normalizeIp(headerValue(req.headers["cf-connecting-ip"]));
	return isIP(forwarded) ? forwarded : remote;
}

/**
 * Origin/Host agreement for any non-GET request while a public tunnel origin is
 * attached. Same-origin public traffic and loopback forms are accepted; a
 * foreign Origin, a missing Origin or a mismatched Host is rejected before the
 * session or CSRF check.
 */
function originAndHostAllowed(req: http.IncomingMessage, publicOrigin: string): boolean {
	const host = headerValue(req.headers.host)?.trim().toLowerCase();
	if (!host) return false;
	let publicHost: string;
	try {
		publicHost = new URL(publicOrigin).host.toLowerCase();
	} catch {
		return false;
	}
	const rawOrigin = headerValue(req.headers.origin);
	if (!rawOrigin) return false;
	// Chrome serialises the Origin of a same-origin form POST as the literal
	// "null" whenever the document was served with `Referrer-Policy: no-referrer`
	// (every dashboard page is), so the serialised origin cannot carry the host.
	// The browser still labels the request: `Sec-Fetch-Site: same-origin` is set by
	// the user agent and a cross-site form can never produce it, so it is the
	// trustworthy signal. Fail closed when it is missing (old clients, curl).
	if (rawOrigin.trim().toLowerCase() === "null") {
		const site = headerValue(req.headers["sec-fetch-site"])?.trim().toLowerCase();
		if (site !== "same-origin") return false;
		const mode = headerValue(req.headers["sec-fetch-mode"])?.trim().toLowerCase();
		if (mode !== undefined && mode !== "navigate" && mode !== "same-origin") return false;
		return host === publicHost || isLoopbackHostHeader(host);
	}
	let origin: URL;
	try {
		origin = new URL(rawOrigin);
	} catch {
		return false;
	}
	if (origin.protocol !== "http:" && origin.protocol !== "https:") return false;
	if (origin.username || origin.password) return false;
	if (origin.host.toLowerCase() !== host) return false;
	if (host === publicHost) return origin.protocol === "https:";
	return isLoopbackHostHeader(host);
}

function userAgent(req: http.IncomingMessage): string {
	return (headerValue(req.headers["user-agent"]) ?? "").slice(0, 512);
}

function settingsErrorContext(
	secrets: SecretsConfig,
	env: NodeJS.ProcessEnv,
	now: number,
	auth?: RenderContext["auth"],
): RenderContext {
	return auth ? { secrets, env, now, auth } : { secrets, env, now };
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
	const logoutCsrfTokens = new CsrfTokenStore();
	const authOptions = options.auth;
	const authStore = authOptions
		? new DashboardAuthStore(authOptions.stateDir, authOptions.now ?? now)
		: undefined;
	if (authOptions && !authStore!.hasPassword()) {
		throw new Error("dashboard auth requires a password; run `alive dashboard --set-password` first");
	}
	const loginLimiter = authOptions
		? new LoginRateLimiter(
			authOptions.now ?? now,
			authOptions.maxLoginFailures ?? DASHBOARD_LOGIN_MAX_FAILURES,
			authOptions.loginWindowMs ?? DASHBOARD_LOGIN_WINDOW_MS,
		)
		: undefined;
	const loginDelayMs = authOptions?.loginDelayMs ?? DASHBOARD_LOGIN_DELAY_MS;
	const sessionTtlMs = authOptions?.ttlMs ?? DASHBOARD_SESSION_TTL_MS;
	const ticketOptions = options.tickets;
	const ticketStore = authOptions && ticketOptions?.stateDir
		? new DashboardTicketStore(ticketOptions.stateDir, ticketOptions.now ?? now, ticketOptions)
		: undefined;
	let publicOrigin = options.publicOrigin ? validateDashboardPublicUrl(options.publicOrigin) : undefined;
	/**
	 * The tunnel may be started by the runtime `dashboard` tool, not by this
	 * process. In that case its origin is in the shared dashboard state; read it
	 * per request so Origin/Host checks apply as soon as the tunnel is up.
	 */
	const currentPublicOrigin = (): string | undefined => {
		if (publicOrigin) return publicOrigin;
		if (!ticketOptions?.stateDir) return undefined;
		try {
			const tunnelUrl = readDashboardRuntime(ticketOptions.stateDir, now())?.tunnelUrl;
			return tunnelUrl === undefined ? undefined : validateDashboardPublicUrl(tunnelUrl);
		} catch {
			return undefined;
		}
	};

	const safeLog = (line: string): void => {
		options.log?.(maskSecrets(line, DEFAULT_SECRETS_CONFIG, env, createMaskContext()));
	};
	const loginLog = (ip: string, ok: boolean): void => {
		safeLog(`dashboard login: ${new Date(now()).toISOString()} ip=${ip} ${ok ? "ok" : "fail"}`);
	};

	const pageAuth = (): RenderContext["auth"] => {
		if (!authStore) return undefined;
		return { logoutCsrfToken: logoutCsrfTokens.issue(LOGOUT_CSRF_KEY, now()) };
	};
	const authHeaders = (): Record<string, string> =>
		authStore ? { "content-security-policy": AUTH_PAGE_CSP } : {};

	const fallbackContext = (auth?: RenderContext["auth"]): RenderContext => {
		try {
			const profiles = loadDashboard(loadRootConfig({ rootDir: options.rootDir, configPath: options.configPath }));
			return settingsErrorContext(profiles[0]?.config.config.secrets ?? DEFAULT_SECRETS_CONFIG, env, now(), auth);
		} catch {
			return settingsErrorContext(DEFAULT_SECRETS_CONFIG, env, now(), auth);
		}
	};

	const sessionFor = (req: http.IncomingMessage): { token: string; record: ReturnType<DashboardAuthStore["verifySession"]> } | undefined => {
		if (!authStore) return undefined;
		const token = readCookie(headerValue(req.headers.cookie));
		if (!token) return undefined;
		const record = authStore.verifySession(token);
		return record ? { token, record } : undefined;
	};

	const sendLoginError = async (
		res: http.ServerResponse,
		status: number,
		message: string,
		headOnly: boolean,
	): Promise<void> => {
		await delay(loginDelayMs);
		send(res, status, renderLoginPage(fallbackContext(), message), headOnly, {
			"content-security-policy": LOGIN_CSP,
		});
	};

	const handleLogin = async (
		req: http.IncomingMessage,
		res: http.ServerResponse,
		headOnly: boolean,
		exposed: boolean,
	): Promise<void> => {
		const ip = clientIp(req, exposed);
		const decision = loginLimiter!.check(ip);
		if (decision.blocked) {
			loginLog(ip, false);
			await sendLoginError(res, 429, DASHBOARD_LOGIN_BLOCKED_ERROR, headOnly);
			return;
		}
		let password = "";
		try {
			const contentType = String(req.headers["content-type"] ?? "").split(";")[0]!.trim().toLowerCase();
			if (contentType !== "application/x-www-form-urlencoded") {
				throw new SettingsEditError(415, "login POST requires Content-Type: application/x-www-form-urlencoded");
			}
			const body = await readRequestBody(req, DASHBOARD_AUTH_MAX_BODY_BYTES);
			password = new URLSearchParams(body.toString("utf8")).get("password") ?? "";
		} catch (error) {
			const status = error instanceof SettingsEditError ? error.status : 400;
			const message = error instanceof Error ? error.message : String(error);
			loginLog(ip, false);
			await sendLoginError(res, status, message, headOnly);
			return;
		}
		if (!(await authStore!.verifyPassword(password))) {
			loginLimiter!.recordFailure(ip);
			loginLog(ip, false);
			await sendLoginError(res, 401, DASHBOARD_LOGIN_ERROR, headOnly);
			return;
		}
		loginLimiter!.recordSuccess(ip);
		const session = authStore!.createSession({
			ttlMs: sessionTtlMs,
			ip,
			userAgent: userAgent(req),
		});
		loginLog(ip, true);
		redirect(res, "/", sessionCookie(session.token, Math.ceil(sessionTtlMs / 1000)));
	};

	const handleLogout = async (
		req: http.IncomingMessage,
		res: http.ServerResponse,
		headOnly: boolean,
		exposed: boolean,
	): Promise<void> => {
		const session = sessionFor(req);
		if (!session) {
			redirect(res, "/login", clearedSessionCookie());
			return;
		}
		let csrf = "";
		try {
			const contentType = String(req.headers["content-type"] ?? "").split(";")[0]!.trim().toLowerCase();
			if (contentType !== "application/x-www-form-urlencoded") {
				throw new SettingsEditError(415, "logout POST requires Content-Type: application/x-www-form-urlencoded");
			}
			const body = await readRequestBody(req, DASHBOARD_AUTH_MAX_BODY_BYTES);
			csrf = new URLSearchParams(body.toString("utf8")).get("csrf") ?? "";
		} catch (error) {
			const status = error instanceof SettingsEditError ? error.status : 400;
			const message = error instanceof Error ? error.message : String(error);
			send(res, status, renderErrorPage(status, message, fallbackContext(pageAuth())), headOnly, authHeaders());
			return;
		}
		if (!logoutCsrfTokens.consume(LOGOUT_CSRF_KEY, csrf, now())) {
			send(res, 403, renderErrorPage(403, "invalid or missing CSRF token; reload the page and log out again", fallbackContext(pageAuth())), headOnly, authHeaders());
			return;
		}
		authStore!.revokeSession(session.token);
		safeLog(`dashboard logout: ${new Date(now()).toISOString()} ip=${clientIp(req, exposed)} ok`);
		redirect(res, "/login", clearedSessionCookie());
	};

	const handleSettingsPost = async (
		req: http.IncomingMessage,
		res: http.ServerResponse,
		agentId: string,
		auth: RenderContext["auth"],
	): Promise<void> => {
		let profile: DashboardProfile | undefined;
		try {
			const profiles = loadDashboard(loadRootConfig({ rootDir: options.rootDir, configPath: options.configPath }));
			profile = profileOrNull(profiles, agentId);
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			options.log?.(`dashboard settings error: ${message}`);
			send(res, 500, renderErrorPage(500, `internal dashboard error: ${message}`, fallbackContext(auth)), false, authHeaders());
			return;
		}
		if (!profile) {
			send(res, 404, renderErrorPage(404, `unknown agent: ${agentId}`, fallbackContext(auth)), false, authHeaders());
			return;
		}
		const target = { id: profile.id, name: profile.name };
		const context = settingsErrorContext(profile.config.config.secrets, env, now(), auth);
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
				send(res, error.status, renderSettingsErrorPage(target, error.status, [error.message], context), false, {
					"content-security-policy": SETTINGS_CSP,
				});
				return;
			}
			const message = error instanceof Error ? error.message : String(error);
			options.log?.(`dashboard settings error: ${message}`);
			send(res, 500, renderSettingsErrorPage(target, 500, [`internal dashboard error: ${message}`], context), false, {
				"content-security-policy": SETTINGS_CSP,
			});
		}
	};

	const server = http.createServer((req, res) => {
		void (async () => {
			const method = req.method ?? "GET";
			const headOnly = method === "HEAD";
			let pathname: string;
			try {
				pathname = new URL(req.url ?? "/", "http://127.0.0.1").pathname;
			} catch {
				send(res, 400, renderErrorPage(400, "invalid URL", fallbackContext()), false);
				return;
			}
			const publicBase = currentPublicOrigin();
			const exposed = publicBase !== undefined;

			// One-time external-access ticket: exchange for a short session cookie.
			// Deliberately before the session gate — the ticket *is* the credential.
			if (pathname === "/t") {
				if (!ticketStore || !authStore) {
					send(res, 404, renderErrorPage(404, "ticket access is not enabled on this dashboard", fallbackContext()), headOnly);
					return;
				}
				if (method !== "GET" && !headOnly) {
					send(res, 405, renderErrorPage(405, "only GET and HEAD are allowed on this route", fallbackContext()), false, {
						allow: "GET, HEAD",
					});
					return;
				}
				const ticketValue = new URL(req.url ?? "/", "http://127.0.0.1").searchParams.get("t") ?? "";
				const consumed = ticketStore.consume(ticketValue);
				if (consumed.kind !== "ok") {
					const status = consumed.kind === "expired" ? 403 : 401;
					const message = consumed.kind === "expired"
						? "this dashboard link has expired; ask the agent for a new one"
						: "this dashboard link is invalid or was already used";
					// The ticket value is never logged, only the outcome and (for an
					// expired ticket) the thread it was issued to.
					safeLog(
						`dashboard ticket: ${new Date(now()).toISOString()} thread=${consumed.kind === "expired" ? consumed.thread : "unknown"} ${consumed.kind}`,
					);
					send(res, status, renderErrorPage(status, message, fallbackContext()), headOnly);
					return;
				}
				const session = authStore.createSession({
					ttlMs: ticketStore.sessionTtlMs,
					ip: clientIp(req, exposed),
					userAgent: userAgent(req),
				});
				safeLog(`dashboard ticket: ${new Date(now()).toISOString()} thread=${consumed.thread} exchanged`);
				redirect(res, "/", sessionCookie(session.token, Math.ceil(ticketStore.sessionTtlMs / 1000)));
				return;
			}

			if (authStore && (pathname === "/login" || pathname === "/logout")) {
				if (pathname === "/login") {
					if (method === "GET" || headOnly) {
						if (sessionFor(req)) {
							redirect(res, "/");
							return;
						}
						send(res, 200, renderLoginPage(fallbackContext()), headOnly, {
							"content-security-policy": LOGIN_CSP,
						});
						return;
					}
					if (method === "POST") {
						if (exposed && !originAndHostAllowed(req, publicBase!)) {
							send(res, 403, renderErrorPage(403, "request origin or host is not allowed", fallbackContext()), false);
							return;
						}
						await handleLogin(req, res, headOnly, exposed);
						return;
					}
					send(res, 405, renderErrorPage(405, "only GET, HEAD and POST are allowed on this route", fallbackContext()), false, {
						allow: "GET, HEAD, POST",
					});
					return;
				}
				if (method !== "POST") {
					send(res, 405, renderErrorPage(405, "only POST is allowed on this route", fallbackContext()), false, {
						allow: "POST",
					});
					return;
				}
				if (exposed && !originAndHostAllowed(req, publicBase!)) {
					send(res, 403, renderErrorPage(403, "request origin or host is not allowed", fallbackContext()), false);
					return;
				}
				await handleLogout(req, res, headOnly, exposed);
				return;
			}

			const route = resolveDashboardRoute(req.url);
			const session = sessionFor(req);

			// Origin/Host agreement is checked before session or CSRF for every
			// non-GET request while the tunnel is attached.
			if (exposed && method !== "GET" && !headOnly && !originAndHostAllowed(req, publicBase!)) {
				send(res, 403, renderErrorPage(403, "request origin or host is not allowed", fallbackContext()), false);
				return;
			}

			if (authStore && !session) {
				if (method === "GET" || headOnly) {
					redirect(res, "/login");
					return;
				}
				send(res, 401, renderErrorPage(401, "sign in to the dashboard first", fallbackContext()), false);
				return;
			}

			const auth = pageAuth();
			if (method === "POST" && route.kind === "settings") {
				await handleSettingsPost(req, res, route.agentId, auth);
				return;
			}
			if (method !== "GET" && !headOnly) {
				const allow = route.kind === "settings" ? "GET, HEAD, POST" : "GET, HEAD";
				send(res, 405, renderErrorPage(405, `only ${allow} are allowed on this route`, fallbackContext(auth)), false, { allow, ...authHeaders() });
				return;
			}

			let base: DashboardProfile | undefined;
			try {
				const rootConfig = loadRootConfig({ rootDir: options.rootDir, configPath: options.configPath });
				const profiles = loadDashboard(rootConfig);
				base = profiles[0];
				const renderContext: RenderContext = {
					secrets: base?.config.config.secrets ?? DEFAULT_SECRETS_CONFIG,
					env,
					now: now(),
					...(auth ? { auth } : {}),
				};
				switch (route.kind) {
					case "index": {
						const summaries = profiles.map((profile) => readAgentSummary(profile, { now: now() }));
						send(res, 200, renderIndexPage(summaries, renderContext), headOnly, authHeaders());
						return;
					}
					case "agent": {
						const profile = profileOrNull(profiles, route.agentId);
						if (!profile) {
							send(res, 404, renderErrorPage(404, `unknown agent: ${route.agentId}`, renderContext), headOnly, authHeaders());
							return;
						}
						const searchParams = new URL(req.url ?? "/", "http://127.0.0.1").searchParams;
						const detail = loadAgentDetail(profile, {
							now: now(),
							timelineQuery: parseTimelineQuery(searchParams),
						});
						send(res, 200, renderAgentPage(detail, {
							secrets: profile.config.config.secrets,
							env,
							now: now(),
							...(auth ? { auth } : {}),
						}), headOnly, { "content-security-policy": AGENT_PAGE_CSP });
						return;
					}
					case "memory": {
						const profile = profileOrNull(profiles, route.agentId);
						if (!profile) {
							send(res, 404, renderErrorPage(404, `unknown agent: ${route.agentId}`, renderContext), headOnly, authHeaders());
							return;
						}
						const searchParams = new URL(req.url ?? "/", "http://127.0.0.1").searchParams;
						const view = loadMemoryPage(profile, { query: searchParams.get("q") ?? "" });
						send(res, 200, renderMemoryPage(view, {
							secrets: profile.config.config.secrets,
							env,
							now: now(),
							...(auth ? { auth } : {}),
						}), headOnly, authHeaders());
						return;
					}
					case "settings": {
						const profile = profileOrNull(profiles, route.agentId);
						if (!profile) {
							send(res, 404, renderErrorPage(404, `unknown agent: ${route.agentId}`, renderContext), headOnly, authHeaders());
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
							...(auth ? { auth } : {}),
						}, { csrfToken, saved: searchParams.get("saved") === "1" }), headOnly, {
							"content-security-policy": SETTINGS_CSP,
						});
						return;
					}
					case "run": {
						const profile = profileOrNull(profiles, route.agentId);
						if (!profile) {
							send(res, 404, renderErrorPage(404, `unknown agent: ${route.agentId}`, renderContext), headOnly, authHeaders());
							return;
						}
						const detail = loadRunDetail(profile, route.runId, { now: now() });
						if (!detail) {
							send(res, 404, renderErrorPage(404, `unknown run: ${route.runId}`, {
								secrets: profile.config.config.secrets,
								env,
								now: now(),
								...(auth ? { auth } : {}),
							}), headOnly, authHeaders());
							return;
						}
						send(res, 200, renderRunPage(detail, {
							secrets: profile.config.config.secrets,
							env,
							now: now(),
							...(auth ? { auth } : {}),
						}), headOnly, authHeaders());
						return;
					}
					default: {
						send(res, 404, renderErrorPage(404, route.message, renderContext), headOnly, authHeaders());
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
					...(auth ? { auth } : {}),
				}), headOnly, authHeaders());
			}
		})().catch((error: unknown) => {
			const message = error instanceof Error ? error.message : String(error);
			options.log?.(`dashboard error: ${message}`);
			if (!res.headersSent) {
				send(res, 500, renderErrorPage(500, `internal dashboard error: ${message}`, fallbackContext()), false);
			} else {
				try {
					res.end();
				} catch {
					// The socket may already be gone.
				}
			}
		});
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
		setPublicOrigin(origin: string | undefined): void {
			publicOrigin = origin === undefined ? undefined : validateDashboardPublicUrl(origin);
		},
		publicOrigin(): string | undefined {
			return publicOrigin;
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

function waitForAbort(signal: AbortSignal): Promise<void> {
	if (signal.aborted) return Promise.resolve();
	return new Promise((resolve) => signal.addEventListener("abort", () => resolve(), { once: true }));
}

/**
 * Start the dashboard and block until SIGINT/SIGTERM (or an injected signal).
 *
 * With `tunnel.enabled`, the already-running loopback server is exposed through
 * the existing `startQuickTunnel` helper. The guard runs before the tunnel is
 * started (loopback + password hash) and again on the URL it reports (HTTPS).
 */
export async function runDashboard(options: DashboardRunOptions): Promise<void> {
	const log = options.log ?? ((line: string) => process.stdout.write(`${line}\n`));
	const env = options.env ?? process.env;
	const safeLog = (line: string): void => {
		log(maskSecrets(line, DEFAULT_SECRETS_CONFIG, env, createMaskContext()));
	};
	const externalPublicUrl =
		options.tunnel?.publicUrl === undefined ? undefined : validateDashboardPublicUrl(options.tunnel.publicUrl);
	const tunnelRequested = options.tunnel?.enabled === true || externalPublicUrl !== undefined;
	const host = options.host ?? DEFAULT_DASHBOARD_HOST;
	if (tunnelRequested) {
		if (!isLoopbackDashboardHost(host)) {
			throw new Error(`--tunnel requires a loopback bind (127.0.0.1 or localhost), got "${host}"`);
		}
		if (!options.auth?.stateDir || !hasDashboardPassword(options.auth.stateDir)) {
			throw new Error("dashboard tunnel refused: no dashboard password is set; run `alive dashboard --set-password` first");
		}
	}
	const dashboard = createDashboardServer(options);
	const address = await dashboard.listen();
	const localUrl = `http://${address.host}:${address.port}`;
	safeLog(`dashboard: ${localUrl}  (loopback only; settings edit is the only write path)`);

	const controller = new AbortController();
	const abort = () => controller.abort();
	const externalSignal = options.signal;
	if (externalSignal?.aborted) abort();
	externalSignal?.addEventListener("abort", abort, { once: true });
	let tunnel: QuickTunnel | undefined;
	try {
		if (externalPublicUrl !== undefined) {
			validateTunnelAccess({
				host,
				publicUrl: externalPublicUrl,
				hasPassword: options.auth ? hasDashboardPassword(options.auth.stateDir) : false,
			});
			dashboard.setPublicOrigin(externalPublicUrl);
			safeLog(`dashboard public HTTPS URL: ${externalPublicUrl} (externally terminated; no quick tunnel)`);
			safeLog("press Ctrl+C to stop");
		} else if (tunnelRequested) {
			const start = options.tunnel?.start
				?? ((url: string, signal: AbortSignal) => startQuickTunnel(url, signal, options.tunnel?.cloudflared));
			tunnel = await start(localUrl, controller.signal);
			validateTunnelAccess({
				host,
				publicUrl: tunnel.origin,
				hasPassword: options.auth ? hasDashboardPassword(options.auth.stateDir) : false,
			});
			dashboard.setPublicOrigin(tunnel.origin);
			safeLog(`dashboard public HTTPS URL: ${tunnel.origin}`);
			safeLog("warning: a quick tunnel URL is temporary — it changes on every restart and is not a permanent domain.");
			safeLog("press Ctrl+C to stop");
		} else {
			safeLog("press Ctrl+C to stop");
		}

		if (options.signal) {
			await waitForAbort(options.signal);
		} else {
			await new Promise<void>((resolve) => {
				const stop = () => {
					process.off("SIGINT", stop);
					process.off("SIGTERM", stop);
					resolve();
				};
				process.once("SIGINT", stop);
				process.once("SIGTERM", stop);
			});
		}
	} finally {
		externalSignal?.removeEventListener("abort", abort);
		await tunnel?.stop();
		await dashboard.close();
	}
}
