import { randomBytes } from "node:crypto";
import * as http from "node:http";
import type { BrowserContext, CDPSession, Page } from "playwright";
import { WebSocket, WebSocketServer } from "ws";
import { assertAgentCdpCommand, assertBrowserUrl } from "./agent-cdp-policy.js";

interface Target { id: string; page: Page }
interface Attached { target: Target; cdp: CDPSession }
const events = [
	"Page.domContentEventFired", "Page.loadEventFired", "Page.frameNavigated", "Page.frameStartedLoading", "Page.frameStoppedLoading",
	"Page.javascriptDialogOpening", "Page.javascriptDialogClosed", "Runtime.executionContextCreated", "Runtime.executionContextDestroyed",
	"Runtime.executionContextsCleared", "Runtime.consoleAPICalled", "Runtime.exceptionThrown",
	"Network.requestWillBeSent", "Network.responseReceived", "Network.loadingFinished", "Network.loadingFailed",
];

/** A loopback-only, random-capability CDP facade for the native agent-browser
 * daemon. Target/session IDs are synthetic; every real CDPSession is obtained
 * from this conversation's SDK context. No engine CDP URL/target IDs are used.
 * The shared host independently enforces the page-command allowlist.
 */
export class AgentCdpBridge {
	private readonly server = http.createServer((_req, res) => { res.writeHead(404); res.end(); });
	private readonly sockets = new WebSocketServer({ noServer: true, maxPayload: 1024 * 1024, perMessageDeflate: false });
	private readonly capability = `/${randomBytes(32).toString("hex")}`;
	private readonly targets = new Map<Page, Target>();
	private readonly listeners = new Map<Page, { close(): void; navigate(): void }>();
	private readonly connections = new Set<() => Promise<void>>();
	private closed = false;
	private endpoint = "";
	constructor(private readonly context: BrowserContext, private readonly select: (page: Page) => void) {}

	async start(): Promise<string> {
		this.server.on("upgrade", (req, socket, head) => {
			if (this.closed || req.url !== this.capability || req.headers.origin || this.sockets.clients.size >= 1) { socket.destroy(); return; }
			this.sockets.handleUpgrade(req, socket, head, ws => this.connect(ws));
		});
		await new Promise<void>((resolve, reject) => { this.server.once("error", reject); this.server.listen(0, "127.0.0.1", resolve); });
		this.endpoint = `ws://127.0.0.1:${(this.server.address() as { port: number }).port}${this.capability}`;
		for (const page of this.context.pages()) this.target(page);
		this.context.on("page", this.opened);
		return this.endpoint;
	}
	private readonly opened = (page: Page) => { this.target(page); };
	private info(target: Target) { return { targetId: target.id, type: "page", title: "", url: target.page.url(), attached: false, canAccessOpener: false, browserContextId: "conversation" }; }
	private broadcast(method: string, params: unknown): void {
		for (const ws of this.sockets.clients) if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ method, params }));
	}
	private target(page: Page): Target {
		const existing = this.targets.get(page); if (existing) return existing;
		const target = { id: randomBytes(16).toString("hex"), page }; this.targets.set(page, target);
		const close = () => {
			this.targets.delete(page); this.listeners.delete(page); page.off("framenavigated", navigate);
			this.broadcast("Target.targetDestroyed", { targetId: target.id });
		};
		const navigate = () => this.broadcast("Target.targetInfoChanged", { targetInfo: this.info(target) });
		this.listeners.set(page, { close, navigate }); page.on("close", close); page.on("framenavigated", navigate);
		this.broadcast("Target.targetCreated", { targetInfo: this.info(target) });
		return target;
	}
	private connect(ws: WebSocket): void {
		const sessions = new Map<string, Attached>(); let pending = 0, disconnected = false;
		let cleaning: Promise<void> | undefined;
		const cleanup: () => Promise<void> = () => cleaning ??= (async () => {
			disconnected = true;
			await Promise.all([...sessions.values()].map(({ cdp }) => cdp.detach().catch(() => {}))); sessions.clear(); this.connections.delete(cleanup);
		})();
		this.connections.add(cleanup);
		const send = (packet: unknown) => { if (ws.readyState === WebSocket.OPEN && ws.bufferedAmount < 8 * 1024 * 1024) ws.send(JSON.stringify(packet)); else ws.terminate(); };
		const command = async (method: string, params: Record<string, any>, sessionId?: string): Promise<unknown> => {
			if (this.closed || disconnected) throw new Error("Browser connection closed");
			// Virtual browser-level operations never reach the engine's Target domain.
			if (method === "Browser.getVersion") return { protocolVersion: "1.3", product: `Chrome/${this.context.browser()?.version() || "unknown"}`, revision: "", userAgent: "", jsVersion: "" };
			if (method === "Target.setDiscoverTargets") return {};
			if (method === "Target.getTargets") return { targetInfos: [...this.targets.values()].map(target => this.info(target)) };
			if (method === "Target.createTarget") {
				assertBrowserUrl(params.url);
				if (this.targets.size >= 8) throw new Error("Too many pages in this shared browser session");
				const page = await this.context.newPage(), target = this.target(page);
				if (params.url !== "about:blank") await page.goto(params.url, { waitUntil: "domcontentloaded" });
				return { targetId: target.id };
			}
			if (method === "Target.attachToTarget") {
				const target = [...this.targets.values()].find(target => target.id === params.targetId);
				if (!target || params.flatten !== true) throw new Error("Target does not belong to this conversation");
				if (sessions.size >= 16) throw new Error("Too many page sessions");
				const cdp = await this.context.newCDPSession(target.page), id = randomBytes(16).toString("hex");
				if (disconnected) { await cdp.detach(); throw new Error("Browser connection closed"); }
				sessions.set(id, { target, cdp });
				cdp.on("close", () => { sessions.delete(id); send({ method: "Target.detachedFromTarget", params: { sessionId: id, targetId: target.id } }); });
				cdp.on("event", ({ method, params }) => { if (events.includes(method)) send({ method, params, sessionId: id }); });
				return { sessionId: id };
			}
			if (method === "Target.detachFromTarget") {
				const attached = sessions.get(params.sessionId); if (!attached) throw new Error("Unknown page session");
				sessions.delete(params.sessionId); await attached.cdp.detach(); return {};
			}
			if (method === "Target.activateTarget" || method === "Target.closeTarget") {
				const target = [...this.targets.values()].find(target => target.id === params.targetId);
				if (!target) throw new Error("Target does not belong to this conversation");
				if (method === "Target.closeTarget") { await target.page.close(); return { success: true }; }
				this.select(target.page); await target.page.bringToFront(); return {};
			}
			// Do not forward Target.setAutoAttach: nested targets must never escape
			// the SDK context. Cross-origin iframe attachment is not supported yet.
			const attached = sessionId ? sessions.get(sessionId) : undefined;
			if (!attached) throw new Error("A conversation-owned page session is required");
			assertAgentCdpCommand(method, params);
			this.select(attached.target.page);
			return attached.cdp.send(method as Parameters<CDPSession["send"]>[0], params);
		};
		ws.on("message", (raw, binary) => {
			let packet: { id: number; method: string; params?: Record<string, unknown>; sessionId?: string };
			try {
				packet = JSON.parse(raw.toString());
				if (binary || !Number.isSafeInteger(packet.id) || typeof packet.method !== "string" || (packet.params !== undefined && (!packet.params || typeof packet.params !== "object" || Array.isArray(packet.params))) || ++pending > 64) throw new Error();
			} catch { ws.terminate(); return; }
			void command(packet.method, packet.params || {}, packet.sessionId).then(result => send({ id: packet.id, result: result ?? {}, ...(packet.sessionId ? { sessionId: packet.sessionId } : {}) }))
				.catch(error => send({ id: packet.id, error: { code: -32000, message: error instanceof Error ? error.message : "Browser operation failed" }, ...(packet.sessionId ? { sessionId: packet.sessionId } : {}) })).finally(() => { pending--; });
		});
		ws.on("close", () => { void cleanup(); }); ws.on("error", () => ws.terminate());
	}
	async close(): Promise<void> {
		this.closed = true; this.context.off("page", this.opened);
		for (const [page, listeners] of this.listeners) { page.off("close", listeners.close); page.off("framenavigated", listeners.navigate); }
		this.listeners.clear(); this.targets.clear();
		for (const ws of this.sockets.clients) ws.terminate();
		await Promise.all([...this.connections].map(cleanup => cleanup()));
		this.sockets.close(); this.server.closeAllConnections();
		await new Promise<void>(resolve => this.server.close(() => resolve()));
	}
}
