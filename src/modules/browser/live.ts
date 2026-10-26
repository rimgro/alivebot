import type { IncomingMessage, Server } from "node:http";
import type { Duplex } from "node:stream";
import { createHash } from "node:crypto";
import type { CDPSession, Page } from "playwright";
import { WebSocket, WebSocketServer } from "ws";
import { StreamPolicy } from "./stream-policy.js";

interface LiveDependencies {
	snapshotMode?(): boolean;
	state?(): { paused: boolean; url?: string };
	origin(): string;
	authorize(credential: string): { expiresAt: number };
	page(): Page | undefined;
	input(body: Record<string, unknown>, credential: string): Promise<void>;
	release(credential: string): Promise<void>;
	resume(credential: string): Promise<void>;
	busy(): boolean;
}

/** Three frames in flight and one replaceable latest frame; cumulative display ACKs. */
export class BrowserLive {
	private readonly server = new WebSocketServer({ noServer: true, maxPayload: 16 * 1024, perMessageDeflate: false });
	private active?: WebSocket;
	private endCapture?: () => void;
	private counters = { captured: 0, sent: 0, acknowledged: 0, bytesSent: 0, duplicates: 0 };
	private profile = "balanced";
	private readonly snapshots = new Set<Promise<void>>();

	constructor(server: Server, private readonly deps: LiveDependencies) {
		server.on("upgrade", (request, socket, head) => this.upgrade(request, socket, head));
	}

	get busy(): boolean { return !!this.active; }
	status(): Record<string, unknown> { return { connected: this.busy, ...this.counters, profile: this.profile }; }
	/** Terminal viewport restoration must follow any temporary metrics used by an in-flight screenshot. */
	async settleCapture(): Promise<void> {
		let timer: NodeJS.Timeout | undefined;
		try { await Promise.race([Promise.all([...this.snapshots]), new Promise<void>(resolve => { timer = setTimeout(resolve, 1800); })]); }
		finally { clearTimeout(timer); }
	}

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
		let credential = "", queued = 0, sent = 0, previousState = "";
		const outstanding = new Map<number, number>();
		let sourcePage: Page | undefined, cdp: CDPSession | undefined;
		let latest: { data: Buffer; width: number; height: number; fingerprint: string } | undefined;
		let stopped = false, capturing = false, generation = 0, mode = "screencast";
		let forcedSnapshots = false;
		let geometrySnapshots = false;
		let captureKey = "", nativeFingerprint = "", sentFingerprint = "";
		let revision = 0, detailedRevision = -1, changedAt = performance.now(), snapshotInFlight = false;
		const policy = new StreamPolicy();
		const desiredKey = () => `${policy.profile.name}:${policy.profile.quality}:${!!this.deps.snapshotMode?.()}:${geometrySnapshots}`;
		const offer = (data: Buffer, viewport: { width: number; height: number }, detail = false) => {
			if (data.length > 4 * 1024 * 1024) return;
			const fingerprint = createHash("sha256").update(`${viewport.width}:${viewport.height}:`).update(data).digest("hex");
			if (!detail) {
				if (fingerprint === nativeFingerprint) { this.counters.duplicates++; return; }
				nativeFingerprint = fingerprint; revision++; changedAt = performance.now();
				policy.frame(data.length);
			}
			if (fingerprint === sentFingerprint) { this.counters.duplicates++; return; }
			latest = { data, ...viewport, fingerprint };
		};
		let fallbackTimer: NodeJS.Timeout | undefined;
		let seedTimer: NodeJS.Timeout | undefined;
		const authTimer = setTimeout(() => socket.close(1008), 5000);
		const reply = (body: unknown) => { if (socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify(body)); };
		const fail = (error: unknown, id?: number) => {
			const failure = error as { status?: number; message?: string };
			reply({ type: id === undefined ? "error" : "ack", id, ok: false, status: failure.status ?? 503, error: failure.status ? failure.message : "Browser operation interrupted" });
			if (id === undefined || failure.status === 401 || failure.status === 410) socket.close(1008);
		};
		const detach = async () => {
			generation++; latest = undefined;
			clearTimeout(fallbackTimer); fallbackTimer = undefined;
			clearTimeout(seedTimer); seedTimer = undefined;
			const session = cdp; cdp = undefined;
			if (session) { await session.send("Page.stopScreencast").catch(() => {}); await session.detach().catch(() => {}); }
		};
		const stop = () => { if (stopped) return; stopped = true; clearTimeout(authTimer); clearInterval(tick); void detach(); };
		const screenshot = async (page: Page, quality: number, current: number, detail = false) => {
			if (snapshotInFlight) return;
			snapshotInFlight = true; const before = revision;
			let finished!: () => void;
			const completion = new Promise<void>(resolve => { finished = resolve; }); this.snapshots.add(completion);
			try {
				this.deps.authorize(credential);
				const viewport = page.viewportSize() ?? await page.evaluate(() => ({ width: (globalThis as unknown as { innerWidth: number }).innerWidth, height: (globalThis as unknown as { innerHeight: number }).innerHeight }));
				let data: Buffer;
				const scale = Math.min(1, 1100 / viewport.width, 900 / viewport.height);
				let session = cdp, temporary: CDPSession | undefined;
				if (scale < 1 && !session) {
					try { session = temporary = await page.context().newCDPSession(page); } catch { /* Drivers without CDP retain logical screenshot compatibility. */ }
				}
				if (scale < 1 && session) {
					let timeout: NodeJS.Timeout | undefined;
					try {
						const result = await Promise.race([
							session.send("Page.captureScreenshot", { format: "jpeg", quality, captureBeyondViewport: true, clip: { x: 0, y: 0, ...viewport, scale } }),
							new Promise<never>((_, reject) => { timeout = setTimeout(() => reject(new Error("Still capture timed out")), 1500); timeout.unref(); }),
						]);
						data = Buffer.from(result.data, "base64");
					} finally { clearTimeout(timeout); await temporary?.detach().catch(() => {}); }
				} else data = await page.screenshot({ type: "jpeg", quality, scale: "css", timeout: 1500 });
				this.deps.authorize(credential);
				if (!stopped && current === generation && before === revision) {
					this.counters.captured++; offer(data, viewport, detail);
				}
			} catch { /* Navigation or revocation may interrupt an independent capture. */ }
			finally { snapshotInFlight = false; this.snapshots.delete(completion); finished(); }
		};
		const capture = async (page: Page) => {
			capturing = true; sourcePage = page;
			const pending = detach(), current = generation;
			captureKey = desiredKey(); nativeFingerprint = ""; detailedRevision = -1;
			forcedSnapshots = !!this.deps.snapshotMode?.();
			try {
				await pending; if (stopped || current !== generation) return;
				if (forcedSnapshots || geometrySnapshots) throw new Error("Viewport requires logical snapshots");
				await page.bringToFront();
				const captureViewport = page.viewportSize() ?? await page.evaluate(() => ({ width: (globalThis as unknown as { innerWidth: number }).innerWidth, height: (globalThis as unknown as { innerHeight: number }).innerHeight }));
				const session = await page.context().newCDPSession(page);
				if (stopped || current !== generation) { await session.detach(); return; }
				cdp = session;
				session.on("Page.screencastFrame", (event: { data: string; sessionId: number; metadata: { deviceWidth: number; deviceHeight: number } }) => {
					void session.send("Page.screencastFrameAck", { sessionId: event.sessionId }).catch(() => {});
					if (stopped || current !== generation) return;
					this.counters.captured++;
					const viewport = page.viewportSize() ?? captureViewport;
					const surface = event.metadata;
					// Headed Chromium can crop a window beyond the physical display while
					// retaining a larger emulated layout. Never send that as the full page.
					if (surface.deviceWidth > 0 && surface.deviceHeight > 0 && Math.abs((surface.deviceWidth / surface.deviceHeight) / (viewport.width / viewport.height) - 1) > .01) {
						geometrySnapshots = true; latest = undefined; return;
					}
					const data = Buffer.from(event.data, "base64");
					offer(data, viewport);
				});
				const profile = policy.profile;
				await session.send("Page.startScreencast", { format: "jpeg", quality: profile.quality, maxWidth: profile.maxWidth, maxHeight: profile.maxHeight, everyNthFrame: 1 });
				mode = "screencast";
				// An unchanged/background Chromium surface may emit no initial frame.
				seedTimer = setTimeout(() => { void (async () => {
					if (stopped || current !== generation || sent || latest) return;
					await screenshot(page, profile.quality, current);
				})(); }, 800); seedTimer.unref();
			} catch {
				if (stopped || current !== generation) return;
				const session = cdp; cdp = undefined; await session?.detach().catch(() => {});
				mode = "snapshot";
				// Compatibility fallback remains outside the input queue.
				const snapshot = async () => {
					if (stopped || current !== generation) return;
					await screenshot(page, policy.profile.quality, current);
					if (!stopped && current === generation) fallbackTimer = setTimeout(snapshot, 125);
				};
				void snapshot();
			} finally { if (current === generation) { capturing = false; reply({ type: "ready", mode }); } }
		};
		const tick = setInterval(() => {
			if (!credential || stopped || socket.readyState !== WebSocket.OPEN) return;
			try {
				this.deps.authorize(credential);
				const state = JSON.stringify(this.deps.state?.() ?? { paused: true });
				if (state !== previousState) { previousState = state; reply({ type: "state", ...JSON.parse(state) }); }
				const page = this.deps.page();
				if (!page || page.isClosed()) throw { status: 410, message: "Browser page closed" };
				const oldest = outstanding.values().next().value;
				if (oldest !== undefined && Date.now() - oldest > 10_000) throw { status: 503, message: "Stream receiver is too slow" };
				policy.observe(oldest === undefined ? 0 : Date.now() - oldest, socket.bufferedAmount);
				this.profile = policy.profile.name;
				if ((page !== sourcePage || captureKey !== desiredKey()) && !capturing) void capture(page);
				// Refine once after motion stops; a later native update invalidates an in-flight still.
				if (!capturing && !latest && !snapshotInFlight && revision > 0 && detailedRevision !== revision && outstanding.size === 0 && performance.now() - changedAt >= 650) {
					detailedRevision = revision; void screenshot(page, 70, generation, true);
				}
				if (!latest || outstanding.size >= 3 || socket.bufferedAmount > 256 * 1024) return;
				if (!policy.canSend(latest.data.length + 16)) return;
				const frame = latest; latest = undefined; outstanding.set(++sent, Date.now());
				sentFingerprint = frame.fingerprint;
				policy.spend(frame.data.length + 16);
				this.counters.sent++; this.counters.bytesSent += frame.data.length + 16;
				const header = Buffer.alloc(16);
				header.writeUInt32BE(0x414c4956, 0); header.writeUInt32BE(sent, 4);
				header.writeUInt32BE(Math.round(frame.width), 8); header.writeUInt32BE(Math.round(frame.height), 12);
				socket.send(Buffer.concat([header, frame.data]), { binary: true }, (error) => { if (error) socket.terminate(); });
			} catch (error) { fail(error); }
		}, 40);
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
					credential = packet.credential; this.active = socket; this.endCapture = stop; clearTimeout(authTimer); this.counters = { captured: 0, sent: 0, acknowledged: 0, bytesSent: 0, duplicates: 0 }; this.profile = "balanced";
					reply({ type: "authenticated", ...this.deps.state?.() }); return;
				}
				this.deps.authorize(credential);
				if (packet.type === "frame_ack") {
					if (typeof packet.id === "number" && outstanding.has(packet.id)) {
						policy.ack(Date.now() - outstanding.get(packet.id)!);
						for (const id of outstanding.keys()) if (id <= packet.id) { outstanding.delete(id); this.counters.acknowledged++; }
					}
					return;
				}
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
