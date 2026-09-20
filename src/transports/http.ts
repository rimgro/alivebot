import * as http from "node:http";
import type { HttpConfig } from "../config.js";
import type { EventPriority } from "../store/events.js";
import type { OutgoingMessage } from "../store/outbox.js";
import type { ChatTransport, TransportContext } from "./types.js";

const MAX_BODY_BYTES = 256 * 1024;

/**
 * HTTP ingress/egress.
 *
 *   POST /message  {text, thread?, from?, expects_reply?}   → user message
 *   POST /event    {text, kind?, title?, payload?, ...}     → observability event
 *   GET  /status                                            → runtime status
 *   GET  /outbox?limit=20                                   → what the agent said
 *   GET  /health
 *
 * This is the seam for plugging in a real chat product or an ops pipeline: they
 * post events here and poll /outbox (or the sender can be extended to push).
 */
export class HttpTransport implements ChatTransport {
	readonly name = "http";
	private server?: http.Server;
	private ctx?: TransportContext;

	constructor(private readonly config: HttpConfig) {}

	async start(ctx: TransportContext): Promise<void> {
		this.ctx = ctx;
		this.server = http.createServer((req, res) => {
			void this.handle(req, res).catch((err) => {
				this.ctx?.log.error("http handler failed", { error: err instanceof Error ? err.message : String(err) });
				sendJson(res, 500, { error: "internal error" });
			});
		});
		await new Promise<void>((resolve, reject) => {
			this.server!.once("error", reject);
			this.server!.listen(this.config.port, this.config.host, () => resolve());
		});
		ctx.log.info("http transport listening", { host: this.config.host, port: this.config.port });
	}

	async send(message: OutgoingMessage): Promise<void> {
		// HTTP is pull-based for now; the outbox endpoint exposes what was sent.
		void message;
	}

	async stop(): Promise<void> {
		if (!this.server) return;
		await new Promise<void>((resolve) => this.server!.close(() => resolve()));
		this.server = undefined;
	}

	private async handle(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
		const ctx = this.ctx;
		if (!ctx) return sendJson(res, 503, { error: "not ready" });
		const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);

		if (req.method === "GET" && url.pathname === "/health") {
			return sendJson(res, 200, { ok: true, name: "alive" });
		}
		if (!this.authorized(req)) return sendJson(res, 401, { error: "unauthorized" });

		if (req.method === "GET" && url.pathname === "/status") {
			return sendJson(res, 200, ctx.status());
		}
		if (req.method === "GET" && url.pathname === "/outbox") {
			const limit = Math.min(Math.max(1, Number(url.searchParams.get("limit") ?? 20) || 20), 200);
			return sendJson(res, 200, { messages: ctx.outbox(limit) });
		}
		if (req.method === "POST" && url.pathname === "/message") {
			const body = await readBody(req);
			if (!body.text || typeof body.text !== "string") {
				return sendJson(res, 400, { error: "`text` is required" });
			}
			const thread = String(body.thread ?? body.from ?? "http");
			const event = ctx.ingest({
				kind: "user_message",
				source: "http",
				priority: normalizePriority(body.priority) ?? "normal",
				title: `message from ${String(body.from ?? thread)}`,
				text: body.text,
				thread,
				expectsReply: body.expects_reply !== false,
				payload: body.payload,
				meta: { from: body.from ?? thread },
			});
			ctx.log.info("http message ingested", { seq: event.seq, thread });
			return sendJson(res, 202, { ok: true, seq: event.seq, id: event.id });
		}
		if (req.method === "POST" && url.pathname === "/event") {
			const body = await readBody(req);
			if (!body.text && body.payload === undefined) {
				return sendJson(res, 400, { error: "`text` or `payload` is required" });
			}
			const text =
				typeof body.text === "string" ? body.text : `Structured event:\n${JSON.stringify(body.payload, null, 2)}`;
			const event = ctx.ingest({
				kind: (body.kind as never) ?? "observability",
				source: "http",
				priority: normalizePriority(body.priority) ?? "normal",
				title: String(body.title ?? `observability event (${String(body.kind ?? "generic")})`),
				text,
				payload: body.payload,
				thread: body.thread ? String(body.thread) : undefined,
				expectsReply: body.expects_reply === true,
				dedupeKey: body.dedupe_key ? String(body.dedupe_key) : undefined,
			});
			ctx.log.info("http event ingested", { seq: event.seq, kind: event.kind, priority: event.priority });
			return sendJson(res, 202, { ok: true, seq: event.seq, id: event.id });
		}
		return sendJson(res, 404, { error: "not found" });
	}

	private authorized(req: http.IncomingMessage): boolean {
		const token = this.config.token;
		if (!token) return true;
		const header = req.headers.authorization;
		const bearer = typeof header === "string" && header.startsWith("Bearer ") ? header.slice(7) : undefined;
		const direct = req.headers["x-alive-token"];
		return bearer === token || direct === token;
	}
}

function normalizePriority(value: unknown): EventPriority | undefined {
	if (value === "low" || value === "normal" || value === "high" || value === "interrupt") return value;
	return undefined;
}

async function readBody(req: http.IncomingMessage): Promise<Record<string, unknown>> {
	const chunks: Buffer[] = [];
	let size = 0;
	for await (const chunk of req) {
		const buffer = chunk as Buffer;
		size += buffer.length;
		if (size > MAX_BODY_BYTES) throw new Error("body too large");
		chunks.push(buffer);
	}
	const raw = Buffer.concat(chunks).toString("utf8").trim();
	if (!raw) return {};
	try {
		const parsed = JSON.parse(raw) as unknown;
		if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) return parsed as Record<string, unknown>;
		return { text: raw };
	} catch {
		return { text: raw };
	}
}

function sendJson(res: http.ServerResponse, status: number, value: unknown): void {
	const body = `${JSON.stringify(value, null, 2)}\n`;
	res.writeHead(status, { "content-type": "application/json; charset=utf-8", "content-length": Buffer.byteLength(body) });
	res.end(body);
}
