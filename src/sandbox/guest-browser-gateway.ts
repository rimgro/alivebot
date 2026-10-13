import type { GuardedRequest } from "./secret-gateway.js";

const GATEWAY_VSOCK_PORT = 7142;
const HOST_CID = 2;
const POLL_MS = 750;

interface CdpTarget { targetId: string; type: string }
interface CdpRequest { requestId: string; request: { url: string; method: string; headers?: Record<string, string>; hasPostData?: boolean } }

/** Guest sidecar. Chromium requests pause here and receive a host decision before they can leave the VM. */
export async function runGuestBrowserGateway(
	setReady: (ready: boolean) => void = () => undefined,
	endpoint = process.env.ALIVE_FORTRESS_CDP ?? "http://127.0.0.1:9223",
): Promise<void> {
	while (true) {
		try {
			const response = await fetch(`${endpoint.replace(/\/$/, "")}/json/version`, { signal: AbortSignal.timeout(1_000) });
			if (response.ok) {
				const version = await response.json() as { webSocketDebuggerUrl?: string };
				if (version.webSocketDebuggerUrl) {
					await protectBrowser(version.webSocketDebuggerUrl, setReady);
				}
			}
		} catch { /* browser has not started yet or is restarting */ }
		await delay(POLL_MS);
	}
}

async function protectBrowser(webSocketUrl: string, setReady: (ready: boolean) => void): Promise<void> {
	const cdp = new CdpClient(webSocketUrl);
	await cdp.open();
	const attached = new Set<string>();
	let setupFailed = false;
	const configureSession = async (sessionId: string, target: CdpTarget) => {
		if (!["page", "iframe", "worker", "shared_worker", "service_worker"].includes(target.type) || attached.has(target.targetId)) return;
		attached.add(target.targetId);
		try {
			await cdp.call("Fetch.enable", { patterns: [{ urlPattern: "*", requestStage: "Request" }] }, sessionId);
			await cdp.call("Target.setAutoAttach", { autoAttach: true, waitForDebuggerOnStart: true, flatten: true }, sessionId).catch(() => undefined);
			// WebSocket frames cannot be paused by Fetch; block that uninspected side channel.
			await cdp.call("Network.enable", {}, sessionId);
			await cdp.call("Network.setBlockedURLs", { urls: ["ws://*", "wss://*"] }, sessionId);
			await cdp.call("Runtime.runIfWaitingForDebugger", {}, sessionId).catch(() => undefined);
		} catch {
			attached.delete(target.targetId);
			setupFailed = true;
			setReady(false);
			cdp.socket.close();
		}
	};
	cdp.on("Target.attachedToTarget", (event) => {
		const attachedEvent = event as { sessionId?: string; targetInfo?: CdpTarget };
		if (attachedEvent.sessionId && attachedEvent.targetInfo) void configureSession(attachedEvent.sessionId, attachedEvent.targetInfo);
	});
	cdp.on("Fetch.requestPaused", (event, sessionId) => { void handleRequest(cdp, event as CdpRequest, sessionId); });
	await cdp.call("Target.setAutoAttach", { autoAttach: true, waitForDebuggerOnStart: true, flatten: true });
	await cdp.call("Target.setDiscoverTargets", { discover: true });
	const targets = await cdp.call<{ targetInfos: CdpTarget[] }>("Target.getTargets");
	for (const target of targets.targetInfos) {
		if (target.type !== "page") continue;
		try {
			const { sessionId } = await cdp.call<{ sessionId: string }>("Target.attachToTarget", { targetId: target.targetId, flatten: true });
			await configureSession(sessionId, target);
		} catch { /* target closed while attaching */ }
	}
	if (setupFailed) return;
	setReady(true);
	if (cdp.socket.readyState === WebSocket.CLOSED) { setReady(false); return; }
	await new Promise<void>((resolve) => cdp.socket.addEventListener("close", () => { setReady(false); resolve(); }, { once: true }));
}

async function handleRequest(cdp: CdpClient, event: CdpRequest, sessionId?: string): Promise<void> {
	const { requestId, request } = event;
	let allow = false;
	try {
		const url = new URL(request.url);
		if (!["http:", "https:"].includes(url.protocol)) allow = true;
		else {
			let body: string | undefined;
			let bodyUnavailable = false;
			if (request.hasPostData) {
				try {
					const result = await cdp.call<{ postData?: string }>("Fetch.getRequestPostData", { requestId }, sessionId);
					body = result.postData ?? "";
				} catch { bodyUnavailable = true; }
			}
			allow = await askHost({
				kind: "http-request", url: request.url, method: request.method,
				headers: request.headers ?? {}, body, bodyUnavailable,
			});
		}
	} catch { allow = false; }
	await cdp.call(allow ? "Fetch.continueRequest" : "Fetch.failRequest", allow
		? { requestId }
		: { requestId, errorReason: "BlockedByClient" }, sessionId).catch(() => undefined);
}

async function askHost(request: GuardedRequest): Promise<boolean> {
	const { VsockSocket } = await import("node-vsock");
	return new Promise<boolean>((resolve) => {
		const socket = new VsockSocket();
		let raw = "";
		let finished = false;
		const done = (allow: boolean) => {
			if (finished) return;
			finished = true;
			clearTimeout(timer);
			socket.destroy();
			resolve(allow);
		};
		const timer = setTimeout(() => done(false), 650_000);
		socket.on("error", () => done(false));
		socket.on("data", (chunk: Buffer) => {
			raw += chunk.toString("utf8");
			if (Buffer.byteLength(raw) > 4096) return done(false);
			const newline = raw.indexOf("\n");
			if (newline < 0) return;
			try { done((JSON.parse(raw.slice(0, newline)) as { allow?: boolean }).allow === true); }
			catch { done(false); }
		});
		socket.connect(HOST_CID, GATEWAY_VSOCK_PORT, () => {
			try { socket.writeTextSync(`${JSON.stringify(request)}\n`); }
			catch { done(false); }
		});
	});
}

class CdpClient {
	readonly socket: WebSocket;
	private nextId = 0;
	private readonly pending = new Map<number, { resolve: (value: unknown) => void; reject: (error: Error) => void; timer: NodeJS.Timeout }>();
	private readonly listeners = new Map<string, Array<(params: unknown, sessionId?: string) => void>>();

	constructor(url: string) { this.socket = new WebSocket(url); }

	async open(): Promise<void> {
		await new Promise<void>((resolve, reject) => {
			this.socket.addEventListener("open", () => resolve(), { once: true });
			this.socket.addEventListener("error", () => reject(new Error("browser CDP connection failed")), { once: true });
		});
		this.socket.addEventListener("message", (event) => this.receive(String(event.data)));
		this.socket.addEventListener("close", () => {
			for (const pending of this.pending.values()) { clearTimeout(pending.timer); pending.reject(new Error("browser CDP closed")); }
			this.pending.clear();
		});
	}

	on(method: string, handler: (params: unknown, sessionId?: string) => void): void {
		this.listeners.set(method, [...(this.listeners.get(method) ?? []), handler]);
	}

	call<T = unknown>(method: string, params: Record<string, unknown> = {}, sessionId?: string): Promise<T> {
		const id = ++this.nextId;
		return new Promise<T>((resolve, reject) => {
			const timer = setTimeout(() => { this.pending.delete(id); reject(new Error(`CDP ${method} timed out`)); }, 30_000);
			this.pending.set(id, { resolve: resolve as (value: unknown) => void, reject, timer });
			this.socket.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }));
		});
	}

	private receive(raw: string): void {
		let message: { id?: number; result?: unknown; error?: { message?: string }; method?: string; params?: unknown; sessionId?: string };
		try { message = JSON.parse(raw) as typeof message; } catch { return; }
		if (message.id) {
			const pending = this.pending.get(message.id);
			if (!pending) return;
			clearTimeout(pending.timer);
			this.pending.delete(message.id);
			if (message.error) pending.reject(new Error(message.error.message ?? "CDP command failed"));
			else pending.resolve(message.result);
			return;
		}
		if (message.method) for (const handler of this.listeners.get(message.method) ?? []) handler(message.params, message.sessionId);
	}
}

function delay(ms: number): Promise<void> { return new Promise((resolve) => setTimeout(resolve, ms)); }
