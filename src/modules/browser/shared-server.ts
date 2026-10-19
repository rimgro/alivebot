import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import * as fs from "node:fs";
import * as http from "node:http";
import * as net from "node:net";
import * as path from "node:path";
import { createRequire } from "node:module";
import type { Browser, BrowserType } from "playwright";
import { WebSocket, WebSocketServer } from "ws";
import type { BrowserConfig } from "./config.js";
import { launchManagedFortress, type ManagedFortress } from "./fortress.js";
import { BrowserIdentity } from "./identity.js";
import { BrowserSigningTransport } from "./transport.js";
import { checkCanvas, type CanvasReport } from "./diagnostics.js";
import type { SharedMetadata } from "./shared-client.js";
import { SharedProtocol } from "./shared-protocol.js";

interface ProtocolServer { listen(port: number, host: string): Promise<string>; close(): Promise<void> }
interface Options { config: BrowserConfig; directory: string; token: string; host?: string; port?: number; maxClients?: number; failure?(): void }

/** Pinned 1.63 adapter: isolateContexts=true, denyLaunch=true and ignoreStopAndKill=true. */
function protocolServer(browser: Browser, driver: BrowserConfig["driver"], maxClients: number): ProtocolServer {
	const require = createRequire(import.meta.url), own = createRequire(require.resolve(driver));
	const core = path.dirname(own.resolve(`${driver}-core`));
	const pkg = JSON.parse(fs.readFileSync(path.join(core, "package.json"), "utf8"));
	if (pkg.version !== "1.63.0") throw new Error("The shared-browser bridge requires the tested driver version 1.63.0");
	const Server = require(path.join(core, "lib/coreBundle.js")).remote?.PlaywrightServer;
	const internal = (browser as unknown as { _connection?: { toImpl?(object: Browser): any } })._connection?.toImpl?.(browser);
	if (!Server || !internal?.attribution?.playwright) throw new Error("Shared-browser protocol adapter is unavailable; no unscoped CDP endpoint was exposed");
	internal.attribution.playwright.options.isServer = true;
	return new Server({ mode: "launchServer", path: `/${randomBytes(24).toString("hex")}`, maxConnections: maxClients, preLaunchedBrowser: internal });
}

/** One engine process serves isolated remote SDK connections. Its CDP endpoint is never returned to clients. */
export class SharedBrowserHost {
	private server?: http.Server;
	private mutex?: net.Server;
	private readonly sockets = new WebSocketServer({ noServer: true, maxPayload: 8 * 1024 * 1024, perMessageDeflate: false });
	private readonly clients = new Set<WebSocket>();
	private readonly responsive = new WeakSet<WebSocket>();
	private heartbeat?: NodeJS.Timeout;
	private bridge?: ProtocolServer;
	private bridgeUrl = "";
	private browser?: Browser;
	private fortress?: ManagedFortress;
	private signing?: BrowserSigningTransport;
	private identity?: BrowserIdentity;
	private metadata?: SharedMetadata;
	private initialContexts = 0;
	private stopping = false;
	private closing?: Promise<void>;
	private readonly maxClients: number;

	constructor(private readonly options: Options) {
		if (!/^[A-Za-z0-9_-]{43,128}$/.test(options.token)) throw new Error("Shared browser host requires a strong private token");
		this.maxClients = options.maxClients ?? 8;
		if (!Number.isInteger(this.maxClients) || this.maxClients < 1 || this.maxClients > 64) throw new Error("Shared browser max clients must be between 1 and 64");
	}

	endpoint(): string { return `http://${this.options.host === "::1" ? "[::1]" : this.options.host || "127.0.0.1"}:${(this.server!.address() as { port: number }).port}`; }
	status(): Record<string, unknown> { return { ...this.metadata, ready: !!this.metadata && !!this.browser?.isConnected(), clients: this.clients.size, contexts: Math.max(0, (this.browser?.contexts().length || 0) - this.initialContexts), maxClients: this.maxClients }; }

	async start(): Promise<void> {
		if (this.server) throw new Error("Shared browser host is already started");
		// The kernel releases this directory-specific loopback lock after a crash.
		// Unlike a PID file it also excludes simultaneous starts with ephemeral API ports.
		const lockPort = 20_000 + createHash("sha256").update(path.resolve(this.options.directory)).digest().readUInt32BE(0) % 10_000;
		const mutex = net.createServer(socket => socket.destroy()); mutex.maxConnections = 1;
		try { await new Promise<void>((resolve, reject) => { mutex.once("error", reject); mutex.listen(lockPort, "127.0.0.1", resolve); }); }
		catch { throw new Error("Shared browser host directory is already locked by a running instance"); }
		this.mutex = mutex;
		const server = http.createServer((request, response) => {
			response.setHeader("Cache-Control", "no-store"); response.setHeader("Content-Type", "application/json");
			if (!this.authorized(request)) { response.writeHead(401); response.end('{"error":"Unauthorized"}'); return; }
			if (request.method === "GET" && request.url === "/v1/identity-directory" && this.identity && this.metadata) { response.end(JSON.stringify(this.identity.directory())); return; }
			if (request.method !== "GET" || request.url !== "/v1/status") { response.writeHead(404); response.end("{}"); return; }
			response.writeHead(this.metadata ? 200 : 503); response.end(JSON.stringify(this.status()));
		});
		server.maxConnections = 80; server.requestTimeout = 10_000; server.headersTimeout = 5000;
		server.on("upgrade", (request, socket, head) => {
			const reject = (status: number) => socket.end(`HTTP/1.1 ${status} Rejected\r\nConnection: close\r\n\r\n`);
			if (!this.authorized(request) || request.headers.origin) { reject(401); return; }
			if (request.url !== "/connect") { reject(404); return; }
			if (!this.metadata || !this.browser?.isConnected()) { reject(503); return; }
			if (this.clients.size >= this.maxClients) { reject(429); return; }
			this.sockets.handleUpgrade(request, socket, head, client => this.connect(client, request.headers["user-agent"]));
		});
		this.server = server;
		try {
			await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(this.options.port ?? 4330, this.options.host || "127.0.0.1", resolve); });
			this.heartbeat = setInterval(() => {
				for (const client of this.clients) {
					if (!this.responsive.has(client)) { client.terminate(); continue; }
					this.responsive.delete(client); if (client.readyState === WebSocket.OPEN) client.ping();
				}
			}, 15_000); this.heartbeat.unref();
			const config = this.options.config;
			let fortressCanvas: CanvasReport | undefined;
			if (config.cdpEndpointEnv || config.executablePathEnv) throw new Error("Shared host supports an owned Fortress image or installed Chrome; external CDP/executable overrides are not inherited");
			const engine = (config.driver === "patchright" ? (await import("patchright")).chromium : (await import("playwright")).chromium) as unknown as BrowserType;
			if (config.engine === "fortress") {
				this.fortress = await launchManagedFortress({ image: config.fortressImage, profile: path.join(this.options.directory, "profile-fortress"), stateDir: this.options.directory, timeoutMs: 60_000, signal: new AbortController().signal });
				this.browser = await engine.connectOverCDP(this.fortress.endpoint, { timeout: config.actionTimeoutMs, noDefaults: true });
				const context = await this.browser.newContext({ acceptDownloads: false });
				try { const page = await context.newPage(); fortressCanvas = await checkCanvas(page); }
				finally { await context.close(); }
			} else this.browser = await engine.launch({ channel: config.channel, headless: config.headless });
			this.initialContexts = this.browser.contexts().length;
			const identity = this.identity = config.signing.enabled ? new BrowserIdentity(config.signing) : undefined;
			if (identity) {
				const context = this.browser.contexts()[0] || await this.browser.newContext({ acceptDownloads: false });
				this.initialContexts = this.browser.contexts().length;
				this.signing = new BrowserSigningTransport(identity, () => { this.metadata = undefined; this.options.failure?.(); });
				await this.signing.start(context);
			}
			this.bridge = protocolServer(this.browser, config.driver, this.maxClients);
			this.bridgeUrl = await this.bridge.listen(0, "127.0.0.1");
			this.metadata = { protocol: 1, engine: config.engine, browserVersion: this.browser.version(), fortressImage: this.fortress?.image, fortressCanvas, ...(identity ? { signing: { agentUrl: identity.agentUrl, keyId: identity.keyId, origins: [...config.signing.origins] } } : {}) };
			this.browser.on("disconnected", () => { this.metadata = undefined; if (!this.stopping) this.options.failure?.(); });
		} catch (error) { await this.close(); throw error; }
	}

	private authorized(request: http.IncomingMessage): boolean {
		const token = request.headers.authorization?.match(/^Bearer ([A-Za-z0-9_-]{43,128})$/)?.[1];
		return !!token && timingSafeEqual(createHash("sha256").update(token).digest(), createHash("sha256").update(this.options.token).digest());
	}

	private connect(client: WebSocket, userAgent?: string): void {
		this.clients.add(client);
		this.responsive.add(client); client.on("pong", () => this.responsive.add(client));
		const remote = new WebSocket(this.bridgeUrl, { maxPayload: 16 * 1024 * 1024, perMessageDeflate: false, headers: userAgent ? { "user-agent": userAgent } : {} });
		const guard = new SharedProtocol();
		const waiting: Buffer[] = []; let waitingBytes = 0;
		const stop = () => { client.terminate(); remote.terminate(); this.clients.delete(client); };
		client.on("error", stop); remote.on("error", stop); client.on("close", stop); remote.on("close", stop);
		const send = (data: Buffer) => {
			let packet;
			try {
				packet = JSON.parse(data.toString()); const type = guard.client(packet);
				if (type === "APIRequestContext" && packet.method === "fetch") {
					// SDK requests bypass Chromium Fetch interception. Sign at the host,
					// retaining the connection's own cookies and never following a signed redirect.
					packet.params.maxRedirects = 0;
					packet.params.headers = (packet.params.headers || []).filter((header: { name: string }) => !["signature", "signature-input", "signature-agent"].includes(header.name.toLowerCase()));
					if (this.identity?.authorizes(packet.params.url)) for (const [name, value] of Object.entries(this.identity.requestHeaders(packet.params.url, Date.now(), packet.params.method || "GET"))) packet.params.headers.push({ name, value });
					data = Buffer.from(JSON.stringify(packet));
				}
			}
			catch (error) {
				if (Number.isSafeInteger(packet?.id)) client.send(JSON.stringify({ id: packet.id, error: { error: { name: "Error", message: error instanceof Error ? error.message : "Invalid shared browser command", stack: "" } } }));
				else stop(); return;
			}
			if (remote.bufferedAmount > 8 * 1024 * 1024) { stop(); return; }
			remote.send(data, { binary: false });
		};
		client.on("message", (raw, binary) => {
			if (binary) { stop(); return; }
			const data = Buffer.from(raw as Buffer);
			if (remote.readyState === WebSocket.OPEN) send(data);
			else { waiting.push(data); waitingBytes += data.length; if (waitingBytes > 1024 * 1024) stop(); }
		});
		remote.on("open", () => { for (const data of waiting) send(data); waiting.length = 0; waitingBytes = 0; });
		remote.on("message", raw => {
			if (client.readyState !== WebSocket.OPEN || client.bufferedAmount > 8 * 1024 * 1024) { stop(); return; }
			try { const packet = JSON.parse(raw.toString()); guard.server(packet); client.send(raw, { binary: false }); }
			catch { stop(); }
		});
	}

	close(): Promise<void> { return this.closing ??= this.dispose(); }

	private async dispose(): Promise<void> {
		this.stopping = true; this.metadata = undefined;
		clearInterval(this.heartbeat);
		for (const client of this.clients) client.terminate(); this.clients.clear(); this.sockets.close();
		try { await this.signing?.close(); }
		finally {
			try { await this.bridge?.close(); }
			finally {
				await this.browser?.close().catch(() => {});
				try { await this.fortress?.close(); }
				finally {
					this.server?.closeAllConnections(); await new Promise<void>(resolve => this.server ? this.server.close(() => resolve()) : resolve()); this.server = undefined;
					await new Promise<void>(resolve => this.mutex ? this.mutex.close(() => resolve()) : resolve()); this.mutex = undefined;
				}
			}
		}
	}
}
