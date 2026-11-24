/**
 * HTTP front of the MCP-aware Telegram proxy (#264, step B).
 *
 * A POST /mcp carrying `Authorization: Bearer <profile token>` is forwarded to
 * that profile's `telegram mcp` stdio child after policy checks. The transport
 * matches what pi 1.6's `StreamableHttpTransport` expects: a JSON-RPC message per
 * POST and a plain `application/json` response (the client explicitly accepts
 * `application/json, text/event-stream`); GET /mcp answers 405, which tells the
 * client there is no server-to-client SSE stream to open.
 */
import { randomBytes } from "node:crypto";
import * as http from "node:http";
import type { Socket } from "node:net";
import { TelegramMcpAuditLog, auditPreview } from "./audit.js";
import type { TelegramMcpConfig, TelegramMcpProfileConfig } from "./config.js";
import { UpstreamChild, type UpstreamChildOptions } from "./child.js";
import { TelegramMcpLimitsStore } from "./limits.js";
import {
	JSON_RPC_ERROR,
	isJsonRpcNotification,
	isJsonRpcRequest,
	jsonRpcIdKey,
	parseJsonRpcMessage,
	type JsonRpcId,
	type JsonRpcMessage,
} from "./protocol.js";
import {
	decideTelegramMcpCall,
	extractWriteText,
	type TelegramMcpPolicyDecision,
} from "./policy.js";
import { TelegramMcpTokenStore } from "./tokens.js";

const MAX_BODY_BYTES = 1024 * 1024;
const REQUEST_TIMEOUT_MS = 60_000;
const DEFAULT_CONNECTION = "default";

interface PendingRequest {
	profile: string;
	connection: string;
	clientId: JsonRpcId;
	resolve: (message: JsonRpcMessage) => void;
	reject: (error: Error) => void;
	timer: NodeJS.Timeout;
}

interface ConnectionState {
	/** Upstream id key -> the id this connection sent. */
	pending: Map<string, JsonRpcId>;
}

export interface TelegramMcpServerOptions {
	config: TelegramMcpConfig;
	stateDir: string;
	/** Test seam: listen on an ephemeral port. */
	port?: number;
	host?: string;
	log?: (line: string) => void;
	tokens?: TelegramMcpTokenStore;
	limits?: TelegramMcpLimitsStore;
	audit?: TelegramMcpAuditLog;
	/** Test seam: e.g. a shorter restart delay. */
	child?: Partial<Omit<UpstreamChildOptions, "profile" | "onMessage" | "onExit" | "command" | "args">>;
}

/** What an allowed but unconfirmed write answers: structured, no upstream call. */
export interface TelegramMcpAskResult {
	decision: "ask";
	reason: string;
	ticketId: string;
	tool: string;
	profile: string;
	chat?: string;
}

export class TelegramMcpServer {
	private readonly options: TelegramMcpServerOptions;
	private readonly profiles = new Map<string, TelegramMcpProfileConfig>();
	private readonly tokens: TelegramMcpTokenStore;
	private readonly limits: TelegramMcpLimitsStore;
	private readonly audit: TelegramMcpAuditLog;
	private readonly childOptions: Partial<UpstreamChildOptions>;
	private readonly children = new Map<string, UpstreamChild>();
	private readonly connections = new Map<string, ConnectionState>();
	private readonly pending = new Map<string, PendingRequest>();
	private server: http.Server | undefined;
	private nextUpstreamId = 1;
	private boundPort = 0;
	private readonly sockets = new Set<Socket>();
	private stopping = false;

	constructor(options: TelegramMcpServerOptions) {
		this.options = options;
		for (const profile of options.config.profiles) this.profiles.set(profile.name, profile);
		this.tokens = options.tokens ?? new TelegramMcpTokenStore(options.stateDir);
		this.limits = options.limits ?? new TelegramMcpLimitsStore(options.stateDir);
		this.audit = options.audit ?? new TelegramMcpAuditLog(options.stateDir);
		this.childOptions = options.child ?? {};
	}

	get port(): number {
		return this.boundPort;
	}

	get url(): string {
		return `http://${this.options.host ?? this.options.config.host}:${this.boundPort}/mcp`;
	}

	start(): Promise<number> {
		if (this.server) throw new Error("Telegram MCP proxy is already started");
		this.stopping = false;
		const server = http.createServer((req, res) => {
			void this.handle(req, res);
		});
		server.on("connection", (socket) => {
			this.sockets.add(socket);
			socket.on("close", () => this.sockets.delete(socket));
		});
		this.server = server;
		const port = this.options.port ?? this.options.config.port;
		const host = this.options.host ?? this.options.config.host;
		return new Promise<number>((resolve, reject) => {
			const onError = (error: Error) => {
				server.off("listening", onListening);
				reject(error);
			};
			const onListening = () => {
				server.off("error", onError);
				const address = server.address();
				this.boundPort = typeof address === "object" && address ? address.port : port;
				resolve(this.boundPort);
			};
			server.once("error", onError);
			server.once("listening", onListening);
			server.listen(port, host);
		});
	}

	async stop(): Promise<void> {
		if (this.stopping) return;
		this.stopping = true;
		for (const pending of this.pending.values()) {
			clearTimeout(pending.timer);
			pending.reject(new Error("Telegram MCP proxy is shutting down"));
		}
		this.pending.clear();
		for (const connection of this.connections.values()) connection.pending.clear();
		this.connections.clear();
		await Promise.all([...this.children.values()].map((child) => child.stop()));
		this.children.clear();
		const server = this.server;
		this.server = undefined;
		if (server) {
			await new Promise<void>((resolve) => {
				server.close(() => resolve());
				// Keep-alive connections from the agent would otherwise hold the
				// close callback open until they time out.
				server.closeAllConnections?.();
			});
			for (const socket of this.sockets) socket.destroy();
			this.sockets.clear();
		}
	}

	private async handle(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
		try {
			const url = new URL(req.url ?? "/", "http://localhost");
			if (url.pathname !== "/mcp") {
				writeJson(res, 404, { error: "not found" });
				return;
			}
			if (req.method !== "POST") {
				res.writeHead(405, { Allow: "POST", "Content-Type": "application/json" });
				res.end(JSON.stringify({ error: "only POST /mcp is supported" }));
				return;
			}
			const token = bearerToken(req.headers.authorization);
			if (!token) {
				unauthorized(res, "missing bearer token");
				return;
			}
			const profileName = this.tokens.resolve(token);
			const profile = profileName === undefined ? undefined : this.profiles.get(profileName);
			if (!profileName || !profile) {
				unauthorized(res, "unknown bearer token");
				return;
			}
			const connection = connectionId(req.headers["x-alive-connection"]);
			const body = await readBody(req);
			let parsed: unknown;
			try {
				parsed = JSON.parse(body);
			} catch {
				writeJson(res, 200, {
					jsonrpc: "2.0",
					id: null,
					error: { code: JSON_RPC_ERROR.parseError, message: "request body is not valid JSON" },
				});
				return;
			}
			if (Array.isArray(parsed)) {
				writeJson(res, 200, {
					jsonrpc: "2.0",
					id: null,
					error: { code: JSON_RPC_ERROR.invalidRequest, message: "JSON-RPC batches are not supported" },
				});
				return;
			}
			const message = parseJsonRpcMessage(parsed);
			if (!message) {
				writeJson(res, 200, {
					jsonrpc: "2.0",
					id: typeof parsed === "object" && parsed !== null && "id" in parsed ? (parsed as { id: JsonRpcId }).id : null,
					error: { code: JSON_RPC_ERROR.invalidRequest, message: "not a JSON-RPC 2.0 message" },
				});
				return;
			}
			if (isJsonRpcNotification(message)) {
				const child = await this.ensureChild(profile);
				child.send(message);
				res.writeHead(202);
				res.end();
				return;
			}
			if (!isJsonRpcRequest(message)) {
				// Responses to server-initiated requests: the proxy answers upstream
				// requests itself, so a client response has nothing to settle.
				res.writeHead(202);
				res.end();
				return;
			}
			if (message.method === "tools/call") {
				const decision = await this.decideToolCall(profile, message);
				if (decision) {
					writeJson(res, 200, { jsonrpc: "2.0", id: message.id, result: decision });
					return;
				}
			}
			let response: JsonRpcMessage;
			try {
				response = await this.forward(profile, connection, message);
			} catch (error) {
				writeJson(res, 200, {
					jsonrpc: "2.0",
					id: message.id,
					error: {
						code: JSON_RPC_ERROR.upstreamUnavailable,
						message: error instanceof Error ? error.message : String(error),
					},
				});
				return;
			}
			writeJson(res, 200, response);
		} catch (error) {
			if (!res.headersSent) {
				writeJson(res, 200, {
					jsonrpc: "2.0",
					id: null,
					error: {
						code: JSON_RPC_ERROR.internalError,
						message: error instanceof Error ? error.message : String(error),
					},
				});
			} else {
				res.end();
			}
		}
	}

	/**
	 * Apply policy to `tools/call`. Returns the synthetic result for deny/ask and
	 * undefined when the call may be forwarded upstream.
	 */
	private async decideToolCall(
		profile: TelegramMcpProfileConfig,
		message: { id: JsonRpcId; params?: unknown },
	): Promise<Record<string, unknown> | undefined> {
		const params = isRecord(message.params) ? message.params : {};
		const tool = typeof params.name === "string" ? params.name : "";
		const args = isRecord(params.arguments) ? params.arguments : {};
		const now = this.limits.now();
		const decision: TelegramMcpPolicyDecision = decideTelegramMcpCall({
			profile,
			tool,
			args,
			now,
			limits: this.limits.snapshot(profile.name, now),
		});
		const text = extractWriteText(args);
		this.audit.record({
			ts: new Date(now).toISOString(),
			profile: profile.name,
			tool,
			chat: decision.chat ?? "",
			decision: decision.decision,
			reason: decision.reason,
			bytes: text === undefined ? 0 : Buffer.byteLength(text, "utf8"),
			...(tool === "telegram_write" && text !== undefined ? { preview: auditPreview(text) } : {}),
		});
		if (decision.decision === "allow") {
			if (tool === "telegram_write" && profile.mode === "write:auto") this.limits.recordWrite(profile.name, now);
			return undefined;
		}
		if (decision.decision === "ask") {
			const ask: TelegramMcpAskResult = {
				decision: "ask",
				reason: decision.reason,
				ticketId: `tgask_${randomBytes(8).toString("hex")}`,
				tool,
				profile: profile.name,
				...(decision.chat === undefined ? {} : { chat: decision.chat }),
			};
			return toolResult("approval required", { ...ask }, false);
		}
		return toolResult(`denied: ${decision.reason}`, { decision: "deny", reason: decision.reason, tool, profile: profile.name }, true);
	}

	private async ensureChild(profile: TelegramMcpProfileConfig): Promise<UpstreamChild> {
		let child = this.children.get(profile.name);
		if (!child) {
			child = new UpstreamChild({
				...this.childOptions,
				profile: profile.name,
				command: profile.command,
				args: profile.args,
				log: this.options.log ?? ((line) => process.stderr.write(`${line}\n`)),
				onMessage: (message) => this.onUpstreamMessage(profile.name, message),
				onExit: (error) => this.failPending(profile.name, error),
			});
			this.children.set(profile.name, child);
			child.start();
		}
		await child.waitUntilRunning();
		return child;
	}

	private async forward(
		profile: TelegramMcpProfileConfig,
		connection: string,
		message: { id: JsonRpcId; method: string; params?: unknown; jsonrpc: "2.0" },
	): Promise<JsonRpcMessage> {
		const child = await this.ensureChild(profile);
		const upstreamId = this.nextUpstreamId++;
		const key = jsonRpcIdKey(upstreamId);
		const state = this.connection(connection);
		state.pending.set(key, message.id);
		const response = new Promise<JsonRpcMessage>((resolve, reject) => {
			const timer = setTimeout(() => {
				this.pending.delete(key);
				state.pending.delete(key);
				reject(new Error(`upstream did not answer ${message.method} in ${REQUEST_TIMEOUT_MS} ms`));
			}, REQUEST_TIMEOUT_MS);
			timer.unref?.();
			this.pending.set(key, {
				profile: profile.name,
				connection,
				clientId: message.id,
				resolve,
				reject,
				timer,
			});
		});
		const sent = child.send({ jsonrpc: "2.0", id: upstreamId, method: message.method, ...(message.params === undefined ? {} : { params: message.params }) });
		if (!sent) {
			this.settle(key, new Error("telegram mcp upstream is not running"));
		}
		return response;
	}

	private connection(id: string): ConnectionState {
		let state = this.connections.get(id);
		if (!state) {
			state = { pending: new Map() };
			this.connections.set(id, state);
		}
		return state;
	}

	private settle(key: string, error: Error): void {
		const pending = this.pending.get(key);
		if (!pending) return;
		clearTimeout(pending.timer);
		this.pending.delete(key);
		this.connections.get(pending.connection)?.pending.delete(key);
		pending.reject(error);
	}

	private failPending(profile: string, error: Error): void {
		for (const [key, pending] of [...this.pending.entries()]) {
			if (pending.profile === profile) this.settle(key, error);
		}
	}

	private onUpstreamMessage(profile: string, message: JsonRpcMessage): void {
		if ("method" in message && "id" in message) {
			// Server-initiated sampling/elicitation: the proxy does not implement
			// client capabilities, so answer with an error instead of leaving the
			// upstream (and this connection) hanging.
			const child = this.children.get(profile);
			child?.send({
				jsonrpc: "2.0",
				id: message.id,
				error: { code: JSON_RPC_ERROR.methodNotFound, message: `client does not support upstream method ${message.method}` },
			});
			this.options.log?.(`telegram-mcp: profile "${profile}" asked for ${message.method}; answered method-not-found`);
			return;
		}
		if ("method" in message) return; // notification: no downstream stream to deliver to
		const key = jsonRpcIdKey(message.id);
		const pending = this.pending.get(key);
		if (!pending) {
			this.options.log?.(`telegram-mcp: profile "${profile}" sent a response for unknown id ${String(message.id)}`);
			return;
		}
		clearTimeout(pending.timer);
		this.pending.delete(key);
		this.connections.get(pending.connection)?.pending.delete(key);
		pending.resolve({ ...message, id: pending.clientId } as JsonRpcMessage);
	}
}

function toolResult(
	text: string,
	structured: Record<string, unknown>,
	isError: boolean,
): Record<string, unknown> {
	return {
		content: [{ type: "text", text }],
		structuredContent: structured,
		isError,
	};
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function bearerToken(header: string | string[] | undefined): string | undefined {
	const value = Array.isArray(header) ? header[0] : header;
	if (!value) return undefined;
	const match = /^Bearer\s+(.+)$/i.exec(value.trim());
	return match?.[1]?.trim() || undefined;
}

function connectionId(header: string | string[] | undefined): string {
	const value = Array.isArray(header) ? header[0] : header;
	if (!value) return DEFAULT_CONNECTION;
	const trimmed = value.trim();
	return trimmed.length > 0 && trimmed.length <= 200 ? trimmed : DEFAULT_CONNECTION;
}

function readBody(req: http.IncomingMessage): Promise<string> {
	return new Promise((resolve, reject) => {
		let size = 0;
		const chunks: Buffer[] = [];
		req.on("data", (chunk: Buffer) => {
			size += chunk.length;
			if (size > MAX_BODY_BYTES) {
				reject(new Error(`request body exceeds ${MAX_BODY_BYTES} bytes`));
				req.destroy();
				return;
			}
			chunks.push(chunk);
		});
		req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
		req.on("error", reject);
	});
}

function unauthorized(res: http.ServerResponse, message: string): void {
	res.writeHead(401, {
		"Content-Type": "application/json",
		"WWW-Authenticate": 'Bearer realm="alive-telegram-mcp"',
	});
	res.end(JSON.stringify({ error: message }));
}

function writeJson(res: http.ServerResponse, status: number, body: unknown): void {
	if (res.headersSent) return;
	const payload = JSON.stringify(body);
	res.writeHead(status, { "Content-Type": "application/json; charset=utf-8", "Content-Length": Buffer.byteLength(payload) });
	res.end(payload);
}
