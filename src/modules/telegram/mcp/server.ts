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
import {
	findPendingTicket,
	newTelegramMcpTicketId,
	newTelegramMcpTicketNonce,
	parseTicketDecision,
	patchTicket,
	readDecision,
	readTicket,
	resolveTicketDir,
	telegramMcpTicketRequestKey,
	writeTicket,
	type TelegramMcpTicket,
} from "./tickets.js";

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
	/** Test seam: how often a pending operator confirmation is polled. Default 100 ms. */
	confirmationPollMs?: number;
}

type ConfirmedWriteOutcome =
	| { kind: "result"; result: Record<string, unknown> }
	| { kind: "forward"; response: JsonRpcMessage }
	| { kind: "error"; message: string };

interface ToolCallOutcome {
	/** Synthetic result: deny, or ask without a confirmation directory. */
	result?: Record<string, unknown>;
	/** Ask that must wait for the runtime module's decision. */
	ticket?: TelegramMcpTicket;
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
	/** One in-flight promise per ticket so a repeated ask cannot double-send. */
	private readonly confirmations = new Map<string, Promise<ConfirmedWriteOutcome>>();
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
				if (decision.ticket) {
					const response = await this.confirmAndForward(profile, connection, message, decision.ticket);
					writeJson(res, 200, response);
					return;
				}
				if (decision.result) {
					writeJson(res, 200, { jsonrpc: "2.0", id: message.id, result: decision.result });
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
	 * Apply policy to `tools/call`. Returns a synthetic result for deny/ask, a
	 * ticket when the runtime must confirm the write, or nothing when the call
	 * may be forwarded upstream.
	 */
	private async decideToolCall(
		profile: TelegramMcpProfileConfig,
		message: { id: JsonRpcId; params?: unknown },
	): Promise<ToolCallOutcome> {
		const params = isRecord(message.params) ? message.params : {};
		const tool = typeof params.name === "string" ? params.name : "";
		const args = isRecord(params.arguments) ? params.arguments : {};
		const now = this.limits.now();
		let decision: TelegramMcpPolicyDecision = decideTelegramMcpCall({
			profile,
			tool,
			args,
			now,
			limits: this.limits.snapshot(profile.name, now),
		});
		// Policy used a snapshot; reserve the slot and count it in one synchronous
		// step so parallel auto-writes cannot pass the last free slot together.
		if (decision.decision === "allow" && tool === "telegram_write" && profile.mode === "write:auto") {
			const reservation = this.limits.reserveWrite(profile.name, profile.writeLimitPerHour, now);
			if (!reservation.allowed) {
				decision = {
					decision: "deny",
					...(decision.chat === undefined ? {} : { chat: decision.chat }),
					reason: reservation.reason ?? `write reservation refused for profile "${profile.name}"`,
				};
			}
		}
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
		if (decision.decision === "allow") return {};
		if (decision.decision === "ask") {
			if (profile.confirmation) {
				return { ticket: this.createOrReuseTicket(profile, tool, decision.chat, text ?? "", now) };
			}
			const ask: TelegramMcpAskResult = {
				decision: "ask",
				reason: decision.reason,
				ticketId: newTelegramMcpTicketId(),
				tool,
				profile: profile.name,
				...(decision.chat === undefined ? {} : { chat: decision.chat }),
			};
			return { result: toolResult("approval required", { ...ask }, false) };
		}
		return {
			result: toolResult(`denied: ${decision.reason}`, { decision: "deny", reason: decision.reason, tool, profile: profile.name }, true),
		};
	}

	private ticketDirFor(profile: TelegramMcpProfileConfig): string {
		const configured = profile.confirmation?.ticketDir;
		if (!configured) throw new Error(`profile "${profile.name}" has no confirmation directory`);
		return resolveTicketDir(this.options.stateDir, configured);
	}

	/** One pending ticket per exact (profile, tool, chat, text): a retry never spams. */
	private createOrReuseTicket(
		profile: TelegramMcpProfileConfig,
		tool: string,
		chat: string | undefined,
		text: string,
		now: number,
	): TelegramMcpTicket {
		const ticketDir = this.ticketDirFor(profile);
		const requestKey = telegramMcpTicketRequestKey(profile.name, tool, chat ?? "", text);
		const existing = findPendingTicket(ticketDir, requestKey, now);
		if (existing) return existing;
		const ttlMs = profile.confirmation?.ttlMs;
		if (ttlMs === undefined) throw new Error(`profile "${profile.name}" has no confirmation TTL`);
		const ticket: TelegramMcpTicket = {
			version: 1,
			ticketId: newTelegramMcpTicketId(),
			profile: profile.name,
			tool,
			...(chat === undefined ? {} : { chat }),
			text,
			createdAt: now,
			expiresAt: now + ttlMs,
			nonce: newTelegramMcpTicketNonce(),
			status: "pending",
			requestKey,
		};
		writeTicket(ticketDir, ticket);
		return ticket;
	}

	/**
	 * Wait for the operator and then perform the write exactly once. Concurrent
	 * asks that reused the same pending ticket share this promise, so an approval
	 * cannot send the message twice.
	 */
	private async confirmAndForward(
		profile: TelegramMcpProfileConfig,
		connection: string,
		message: { id: JsonRpcId; method: string; params?: unknown; jsonrpc: "2.0" },
		ticket: TelegramMcpTicket,
	): Promise<JsonRpcMessage> {
		let execution = this.confirmations.get(ticket.ticketId);
		if (!execution) {
			execution = this.executeConfirmedWrite(profile, connection, message, ticket);
			this.confirmations.set(ticket.ticketId, execution);
			void execution
				.catch(() => undefined)
				.finally(() => {
					if (this.confirmations.get(ticket.ticketId) === execution) this.confirmations.delete(ticket.ticketId);
				});
		}
		const outcome = await execution;
		if (outcome.kind === "result") return { jsonrpc: "2.0", id: message.id, result: outcome.result };
		if (outcome.kind === "forward") return { ...outcome.response, id: message.id };
		return {
			jsonrpc: "2.0",
			id: message.id,
			error: { code: JSON_RPC_ERROR.upstreamUnavailable, message: outcome.message },
		};
	}

	private async executeConfirmedWrite(
		profile: TelegramMcpProfileConfig,
		connection: string,
		message: { id: JsonRpcId; method: string; params?: unknown; jsonrpc: "2.0" },
		ticket: TelegramMcpTicket,
	): Promise<ConfirmedWriteOutcome> {
		const ticketDir = this.ticketDirFor(profile);
		const verdict = await this.waitForDecision(ticketDir, ticket);
		if (verdict.kind === "expired") {
			this.finishTicket(ticketDir, ticket.ticketId, "expired", verdict.reason);
			this.auditTerminal(profile, ticket, "deny", verdict.reason);
			return { kind: "result", result: confirmationError(verdict.reason, ticket) };
		}
		if (verdict.kind === "rejected") {
			this.finishTicket(ticketDir, ticket.ticketId, "failed", verdict.reason);
			this.auditTerminal(profile, ticket, "deny", verdict.reason);
			return { kind: "result", result: confirmationError(verdict.reason, ticket) };
		}
		if (verdict.kind === "deny") {
			this.finishTicket(ticketDir, ticket.ticketId, "denied", "write denied by operator");
			this.auditTerminal(profile, ticket, "deny", "write denied by operator");
			return { kind: "result", result: confirmationError("write denied by operator: nothing was sent", ticket) };
		}

		// Approved: enforce the hourly limit and count this write once. write:ask has
		// no persistent window of its own, so open a short one before the atomic
		// reserve (the same check-and-count step write:auto uses).
		const now = this.limits.now();
		this.limits.openWindow(profile.name, profile.writeTtlMs, now);
		const reservation = this.limits.reserveWrite(profile.name, profile.writeLimitPerHour, now);
		if (!reservation.allowed) {
			const reason = reservation.reason ?? `write reservation refused for profile "${profile.name}"`;
			this.finishTicket(ticketDir, ticket.ticketId, "failed", reason);
			this.auditTerminal(profile, ticket, "deny", reason);
			return { kind: "result", result: toolResult(`denied: ${reason}`, { decision: "deny", reason, ticketId: ticket.ticketId, tool: ticket.tool, profile: profile.name }, true) };
		}
		try {
			const response = await this.forward(profile, connection, message);
			const failed = "error" in response || isErrorToolResponse(response);
			const reason = failed ? "upstream returned an error" : "operator approved the write";
			this.finishTicket(ticketDir, ticket.ticketId, failed ? "failed" : "sent", failed ? reason : undefined);
			this.auditTerminal(profile, ticket, failed ? "deny" : "allow", reason);
			return { kind: "forward", response };
		} catch (error) {
			const reason = error instanceof Error ? error.message : String(error);
			this.finishTicket(ticketDir, ticket.ticketId, "failed", reason);
			this.auditTerminal(profile, ticket, "deny", reason);
			return { kind: "error", message: reason };
		}
	}

	/** Poll the decision file until the operator answers, the ticket expires or the proxy stops. */
	private async waitForDecision(
		ticketDir: string,
		ticket: TelegramMcpTicket,
	): Promise<{ kind: "approve" | "deny" } | { kind: "rejected"; reason: string } | { kind: "expired"; reason: string }> {
		const pollMs = this.options.confirmationPollMs ?? 100;
		for (;;) {
			const read = readDecision(ticketDir, ticket.ticketId);
			if (read.found) {
				const parsed = parseTicketDecision(read.raw, ticket);
				if (!parsed.ok) return { kind: "rejected", reason: `confirmation decision rejected: ${parsed.reason}` };
				return { kind: parsed.decision.decision };
			}
			const current = readTicket(ticketDir, ticket.ticketId);
			if (current?.status === "expired") return { kind: "expired", reason: "confirmation expired: nothing was sent" };
			if (current && (current.status === "failed" || current.status === "denied")) {
				return { kind: "rejected", reason: `confirmation ${current.status}${current.error ? `: ${current.error}` : ""}` };
			}
			if (this.limits.now() >= ticket.expiresAt) {
				return { kind: "expired", reason: "confirmation expired: nothing was sent" };
			}
			if (this.stopping) return { kind: "rejected", reason: "Telegram MCP proxy is shutting down" };
			await new Promise<void>((resolve) => setTimeout(resolve, pollMs));
		}
	}

	private finishTicket(ticketDir: string, ticketId: string, status: "sent" | "failed" | "denied" | "expired", error?: string): void {
		try {
			patchTicket(ticketDir, ticketId, {
				status,
				...(status === "sent" ? { sentAt: this.limits.now() } : {}),
				...(error === undefined ? {} : { error }),
			});
		} catch {
			// A ticket that suddenly becomes unwritable must not turn a sent message
			// into a retry the operator would approve twice.
		}
	}

	private auditTerminal(
		profile: TelegramMcpProfileConfig,
		ticket: TelegramMcpTicket,
		decision: "allow" | "deny",
		reason: string,
	): void {
		this.audit.record({
			ts: new Date(this.limits.now()).toISOString(),
			profile: profile.name,
			tool: ticket.tool,
			chat: ticket.chat ?? "",
			decision,
			reason,
			bytes: Buffer.byteLength(ticket.text, "utf8"),
			...(ticket.tool === "telegram_write" && ticket.text ? { preview: auditPreview(ticket.text) } : {}),
		});
	}

	private async ensureChild(profile: TelegramMcpProfileConfig): Promise<UpstreamChild> {
		let child = this.children.get(profile.name);
		if (!child) {
			child = new UpstreamChild({
				...this.childOptions,
				profile: profile.name,
				command: profile.command,
				args: profile.args,
				env: { ...(this.childOptions.env ?? {}), ...(profile.env ?? {}) },
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

/** A tool-level error result: no upstream write happened. */
function confirmationError(reason: string, ticket: TelegramMcpTicket): Record<string, unknown> {
	return toolResult(
		`write not sent: ${reason}`,
		{
			decision: "deny",
			reason,
			ticketId: ticket.ticketId,
			tool: ticket.tool,
			profile: ticket.profile,
			...(ticket.chat === undefined ? {} : { chat: ticket.chat }),
		},
		true,
	);
}

function isErrorToolResponse(response: JsonRpcMessage): boolean {
	if (!("result" in response)) return true;
	const result = response.result;
	return isRecord(result) && result.isError === true;
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
