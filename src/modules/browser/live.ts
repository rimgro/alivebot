import type { IncomingMessage, Server } from "node:http";
import type { Duplex } from "node:stream";
import type { CDPSession, Page } from "playwright";
import { WebSocket, WebSocketServer } from "ws";

interface LiveDependencies {
	origin(): string;
	authorize(credential: string): { expiresAt: number };
	page(): Page | undefined;
	input(body: Record<string, unknown>, credential: string): Promise<void>;
	release(credential: string): Promise<void>;
	resume(credential: string): Promise<void>;
	busy(): boolean;
}

/** One acknowledged frame in flight and one replaceable latest frame. */
export class BrowserLive {
	private readonly server = new WebSocketServer({ noServer: true, maxPayload: 16 * 1024, perMessageDeflate: false });
	private active?: WebSocket;
	private endCapture?: () => void;
	private counters = { captured: 0, sent: 0, acknowledged: 0 };

	constructor(server: Server, private readonly deps: LiveDependencies) {
		server.on("upgrade", (request, socket, head) => this.upgrade(request, socket, head));
	}

	get busy(): boolean { return !!this.active; }
	status(): Record<string, unknown> { return { connected: this.busy, ...this.counters }; }

	end(message = "No active handoff", completed = false): void {
		this.endCapture?.(); this.endCapture = undefined;
		const socket = this.active; this.active = undefined;
		if (socket?.readyState === WebSocket.OPEN) {
			if (!completed) socket.send(JSON.stringify({ type: "error", status: 401, error: message }));
			socket.close(1000);
			const timeout = setTimeout(() => socket.terminate(), 1000); timeout.unref();
		}
	}

	close(): void {
		this.end();
		for (const socket of this.server.clients) socket.terminate();
		this.server.close();
	}

	private upgrade(request: IncomingMessage, socket: Duplex, head: Buffer): void {
		const reject = (status: number) => { socket.end(`HTTP/1.1 ${status} Rejected\r\nConnection: close\r\n\r\n`); };
		// Credentials never appear in URLs, cookies or upgrade headers.
		if (request.url !== "/browser/live") { reject(404); return; }
		if (request.headers.origin !== this.deps.origin()) { reject(403); return; }
		if (this.server.clients.size >= 8) { reject(429); return; }
		this.server.handleUpgrade(request, socket, head, (ws) => this.connect(ws));
	}

	private connect(socket: WebSocket): void {
		let credential = "", queued = 0, sent = 0, outstanding = 0, sentAt = 0;
		let sourcePage: Page | undefined, cdp: CDPSession | undefined;
		let latest: { data: Buffer; width: number; height: number } | undefined;
		let stopped = false, capturing = false, generation = 0, mode = "screencast";
		let fallbackTimer: NodeJS.Timeout | undefined;
		const authTimer = setTimeout(() => socket.close(1008), 5000);
		const reply = (body: unknown) => { if (socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify(body)); };
		const fail = (error: unknown, id?: number) => {
			const failure = error as { status?: number; message?: string };
			reply({ type: id === undefined ? "error" : "ack", id, ok: false, status: failure.status ?? 503, error: failure.status ? failure.message : "Browser operation interrupted" });
			if (id === undefined || failure.status === 401 || failure.status === 410) socket.close(1008);
		};
		const detach = () => {
			generation++; latest = undefined;
			clearTimeout(fallbackTimer); fallbackTimer = undefined;
			const session = cdp; cdp = undefined;
			if (session) void session.send("Page.stopScreencast").catch(() => {}).finally(() => session.detach().catch(() => {}));
		};
		const stop = () => { if (stopped) return; stopped = true; clearTimeout(authTimer); clearInterval(tick); detach(); };
		const capture = async (page: Page) => {
			detach(); const current = generation; sourcePage = page; capturing = true;
			try {
				await page.bringToFront();
				const session = await page.context().newCDPSession(page);
				if (stopped || current !== generation) { await session.detach(); return; }
				cdp = session;
				session.on("Page.screencastFrame", (event: { data: string; sessionId: number; metadata: { deviceWidth: number; deviceHeight: number } }) => {
					void session.send("Page.screencastFrameAck", { sessionId: event.sessionId }).catch(() => {});
					if (stopped || current !== generation) return;
					this.counters.captured++;
					const viewport = page.viewportSize() ?? { width: event.metadata.deviceWidth, height: event.metadata.deviceHeight };
					const data = Buffer.from(event.data, "base64");
					if (data.length <= 4 * 1024 * 1024) latest = { data, ...viewport };
				});
				await session.send("Page.startScreencast", { format: "jpeg", quality: 60, maxWidth: 1100, maxHeight: 900, everyNthFrame: 1 });
				mode = "screencast";
			} catch {
				if (stopped || current !== generation) return;
				const session = cdp; cdp = undefined; await session?.detach().catch(() => {});
				mode = "snapshot";
				// Compatibility fallback remains outside the input queue.
				const snapshot = async () => {
					if (stopped || current !== generation) return;
					try {
						this.deps.authorize(credential);
						const viewport = page.viewportSize() ?? await page.evaluate(() => ({ width: (globalThis as unknown as { innerWidth: number }).innerWidth, height: (globalThis as unknown as { innerHeight: number }).innerHeight }));
						const data = await page.screenshot({ type: "jpeg", quality: 60, scale: "css", timeout: 1500 });
						if (!stopped && current === generation && data.length <= 4 * 1024 * 1024) { this.counters.captured++; latest = { data, ...viewport }; }
					} catch { /* A navigation can temporarily prevent capture. */ }
					if (!stopped && current === generation) fallbackTimer = setTimeout(snapshot, 100);
				};
				void snapshot();
			} finally { if (current === generation) { capturing = false; reply({ type: "ready", mode }); } }
		};
		const tick = setInterval(() => {
			if (!credential || stopped || socket.readyState !== WebSocket.OPEN) return;
			try {
				this.deps.authorize(credential);
				const page = this.deps.page();
				if (!page || page.isClosed()) throw { status: 410, message: "Browser page closed" };
				if (page !== sourcePage && !capturing) void capture(page);
				if (outstanding && Date.now() - sentAt > 10_000) throw { status: 503, message: "Stream receiver is too slow" };
				if (!latest || outstanding || socket.bufferedAmount > 256 * 1024) return;
				const frame = latest; latest = undefined; outstanding = ++sent; sentAt = Date.now();
				this.counters.sent++;
				const header = Buffer.alloc(16);
				header.writeUInt32BE(0x414c4956, 0); header.writeUInt32BE(outstanding, 4);
				header.writeUInt32BE(Math.round(frame.width), 8); header.writeUInt32BE(Math.round(frame.height), 12);
				socket.send(Buffer.concat([header, frame.data]), { binary: true }, (error) => { if (error) socket.terminate(); });
			} catch (error) { fail(error); }
		}, 50);
		socket.on("error", () => socket.terminate());
		socket.on("close", () => {
			stop();
			if (credential) void this.deps.release(credential).catch(() => {});
			if (this.active === socket) { this.active = undefined; this.endCapture = undefined; }
		});
		socket.on("message", (raw, binary) => {
			let packet: Record<string, unknown>;
			try { if (binary) throw new Error(); packet = JSON.parse(raw.toString()); if (!packet || typeof packet !== "object" || Array.isArray(packet)) throw new Error(); }
			catch { socket.close(1008); return; }
			try {
				if (!credential) {
					if (packet.type !== "auth" || typeof packet.credential !== "string") throw { status: 401, message: "Invalid access key" };
					this.deps.authorize(packet.credential);
					if (this.active || this.deps.busy()) throw { status: 409, message: "A browser stream is already open" };
					credential = packet.credential; this.active = socket; this.endCapture = stop; clearTimeout(authTimer); this.counters = { captured: 0, sent: 0, acknowledged: 0 };
					reply({ type: "authenticated" }); return;
				}
				this.deps.authorize(credential);
				if (packet.type === "frame_ack") { if (outstanding && packet.id === outstanding) { outstanding = 0; this.counters.acknowledged++; } return; }
				if (packet.type === "ping") { reply({ type: "pong", id: packet.id }); return; }
				if (packet.type === "resume" && Number.isSafeInteger(packet.id) && queued < 32) {
					queued++;
					void this.deps.resume(credential).then(() => {
						reply({ type: "ack", id: packet.id, ok: true }); this.end("", true);
					}).catch(error => fail(error, packet.id as number)).finally(() => { queued--; });
					return;
				}
				if (packet.type !== "input" || !Number.isSafeInteger(packet.id) || queued >= 32 || !packet.body || typeof packet.body !== "object" || Array.isArray(packet.body)) throw { status: 400, message: "Invalid browser input" };
				queued++;
				void this.deps.input(packet.body as Record<string, unknown>, credential).then(() => {
					this.deps.authorize(credential); reply({ type: "ack", id: packet.id, ok: true });
				}).catch((error) => fail(error, packet.id as number)).finally(() => { queued--; });
			} catch (error) { fail(error); }
		});
	}
}
