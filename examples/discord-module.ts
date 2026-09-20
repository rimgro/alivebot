/**
 * Reference **external** module: Discord.
 *
 * This file is not part of the built-in surface. It exists to show the whole
 * Events API in a second, very different integration, and it is loaded from
 * config by path:
 *
 *   "modules": {
 *     "external": [
 *       {
 *         "name": "discord",
 *         "path": "examples/discord-module.ts",
 *         "enabled": true,
 *         "options": {
 *           "webhookUrl": "https://discord.com/api/webhooks/…",
 *           "botTokenEnv": "DISCORD_BOT_TOKEN",
 *           "inboundPort": 4330
 *         }
 *       }
 *     ]
 *   }
 *
 * What it demonstrates:
 *   - `ctx.emit` / `ctx.userMessage` — turn the outside world into inbox events,
 *   - `ctx.onOutbound` + `handles()` — claim a chat thread and deliver replies,
 *   - `ctx.history` — record every message so the generic `history` tool works,
 *   - `ctx.registerTools` / `tools()` — contribute agent tools,
 *   - `ctx.contributeStatus` — show up in `alive status`,
 *   - a factory exported as `default` with the `{ config, log, options }` shape.
 *
 * Sending needs either a channel webhook (`webhookUrl`) or a bot token
 * (`botTokenEnv`, "Bot" auth on the REST API). Receiving uses a relay because
 * Discord only pushes messages over the gateway WebSocket; run something that
 * POSTs to `http://127.0.0.1:<inboundPort>/discord/message`, or extend this file
 * with a gateway client. The `discord` tool is what makes the rest testable by
 * hand.
 */
import * as http from "node:http";
import { defineTool, type ToolDefinition } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import type { AliveModule, AliveModuleFactory, ModuleContext } from "../src/events/api.js";

const DISCORD_API = "https://discord.com/api/v10";
const THREAD_PREFIX = "discord:";

interface DiscordOptions {
	webhookUrl?: string;
	botTokenEnv?: string;
	botToken?: string;
	inboundPort?: number;
	inboundPath?: string;
	inboundToken?: string;
	/** Channel used when the agent sends to a bare discord thread. */
	defaultChannelId?: string;
}

class DiscordModule implements AliveModule {
	readonly name = "discord";
	readonly kind = "chat" as const;

	private ctx?: ModuleContext;
	private server?: http.Server;
	private received = 0;
	private sent = 0;
	private lastError?: string;

	constructor(private readonly options: DiscordOptions) {}

	handles(message: { thread: string }): boolean {
		return message.thread.startsWith(THREAD_PREFIX);
	}

	async start(ctx: ModuleContext): Promise<void> {
		this.ctx = ctx;
		ctx.onOutbound(async (message) => {
			await this.deliver(message);
		});
		ctx.contributeStatus(() => this.status());
		ctx.registerTools([this.tool()]);

		const port = this.options.inboundPort ?? 0;
		if (port > 0) {
			const base = this.options.inboundPath ?? "/discord";
			this.server = http.createServer((req, res) => {
				void this.handleInbound(base, req, res).catch((err) => {
					this.lastError = err instanceof Error ? err.message : String(err);
					res.writeHead(500).end(JSON.stringify({ error: this.lastError }));
				});
			});
			await new Promise<void>((resolve, reject) => {
				this.server!.once("error", reject);
				this.server!.listen(port, "127.0.0.1", () => resolve());
			});
			ctx.log.info("discord relay listening", { url: `http://127.0.0.1:${port}${base}/message` });
		}
	}

	async stop(): Promise<void> {
		if (!this.server) return;
		const server = this.server;
		this.server = undefined;
		await new Promise<void>((resolve) => server.close(() => resolve()));
	}

	status(): Record<string, unknown> {
		return {
			connected: Boolean(this.token() || this.options.webhookUrl),
			relay: this.server !== undefined,
			received: this.received,
			sent: this.sent,
			lastError: this.lastError,
		};
	}

	// ------------------------------------------------------------------
	// inbound
	// ------------------------------------------------------------------

	private async handleInbound(base: string, req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
		const url = new URL(req.url ?? "/", "http://localhost");
		if (req.method !== "POST" || url.pathname !== `${base}/message`) {
			res.writeHead(404).end(JSON.stringify({ error: "not found" }));
			return;
		}
		if (this.options.inboundToken && req.headers["x-alive-token"] !== this.options.inboundToken) {
			res.writeHead(401).end(JSON.stringify({ error: "unauthorized" }));
			return;
		}
		const body = JSON.parse(await readBody(req)) as {
			channel_id?: string;
			channel_name?: string;
			message_id?: string;
			content?: string;
			author?: { id?: string; name?: string };
			guild?: string;
		};
		if (!body.channel_id || !body.content) {
			res.writeHead(400).end(JSON.stringify({ error: "channel_id and content are required" }));
			return;
		}
		const ctx = this.requireCtx();
		const thread = `${THREAD_PREFIX}${body.channel_id}`;
		const event = ctx.userMessage({
			thread,
			text: body.content,
			title: `message from ${body.author?.name ?? "someone"} in #${body.channel_name ?? body.channel_id}`,
			author: body.author?.name,
			authorId: body.author?.id,
			expectsReply: true,
			dedupeKey: body.message_id ? `discord:msg:${body.channel_id}:${body.message_id}` : undefined,
			payload: body,
		});
		ctx.history.append({
			id: body.message_id ? `discord:${body.channel_id}:${body.message_id}` : `discord:${Date.now()}`,
			thread,
			module: "discord",
			direction: "inbound",
			text: body.content,
			author: body.author?.name,
			authorId: body.author?.id,
			messageId: body.message_id,
			meta: { eventId: event.id, channelId: body.channel_id, channelName: body.channel_name, guild: body.guild },
		});
		ctx.history.upsertThread({
			thread,
			module: "discord",
			title: body.channel_name ? `#${body.channel_name}` : thread,
			meta: { channelId: body.channel_id, guild: body.guild },
		});
		this.received += 1;
		res.writeHead(202, { "content-type": "application/json" }).end(JSON.stringify({ ok: true, id: event.id }));
	}

	// ------------------------------------------------------------------
	// outbound
	// ------------------------------------------------------------------

	private async deliver(message: { thread: string; text: string; id: string }): Promise<void> {
		const channelId = message.thread.slice(THREAD_PREFIX.length);
		if (!channelId) throw new Error(`not a discord thread: ${message.thread}`);
		const payload = { content: message.text };
		const token = this.token();

		let response: Response;
		if (token) {
			response = await fetch(`${DISCORD_API}/channels/${channelId}/messages`, {
				method: "POST",
				headers: { "content-type": "application/json", authorization: `Bot ${token}` },
				body: JSON.stringify(payload),
			});
		} else if (this.options.webhookUrl) {
			response = await fetch(this.options.webhookUrl, {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify(payload),
			});
		} else {
			throw new Error("discord has neither botTokenEnv nor webhookUrl configured");
		}
		if (!response.ok) {
			const body = await response.text();
			throw new Error(`discord send failed: HTTP ${response.status} ${body.slice(0, 200)}`);
		}
		const sent = (await response.json().catch(() => ({}))) as { id?: string };
		const ctx = this.requireCtx();
		ctx.history.append({
			id: sent.id ? `discord:${channelId}:${sent.id}` : `discord:${channelId}:out:${Date.now()}`,
			thread: message.thread,
			module: "discord",
			direction: "outbound",
			text: message.text,
			author: "agent",
			messageId: sent.id,
			meta: { agentMessageId: message.id },
		});
		this.sent += 1;
	}

	// ------------------------------------------------------------------
	// tool + helpers
	// ------------------------------------------------------------------

	private tool(): ToolDefinition {
		return defineTool({
			name: "discord",
			label: "Discord",
			description: "Discord: read recorded channel history and send a message to a channel.",
			parameters: Type.Object({
				action: Type.Union([Type.Literal("history"), Type.Literal("send")]),
				channel: Type.Optional(Type.String({ description: "Channel id, or discord:<id> thread." })),
				text: Type.Optional(Type.String({ description: "Message to send." })),
				limit: Type.Optional(Type.Number({ description: "How many history messages (default 30)." })),
			}),
			execute: async (_toolCallId, params) => {
				const ctx = this.requireCtx();
				const channelId = (params.channel ?? this.options.defaultChannelId ?? "").replace(THREAD_PREFIX, "");
				if (params.action === "history") {
					const records = ctx.history.query({ thread: `${THREAD_PREFIX}${channelId}`, limit: params.limit ?? 30 });
					const text = records.map((r) => `${new Date(r.ts).toISOString()} ${r.direction === "outbound" ? "→" : "←"} ${r.author ?? "?"}: ${r.text}`).join("\n");
					return { content: [{ type: "text", text: text || "no messages" }], details: { count: records.length } };
				}
				if (!params.text?.trim()) throw new Error("text is required");
				await this.deliver({ thread: `${THREAD_PREFIX}${channelId}`, text: params.text, id: "tool" });
				return { content: [{ type: "text", text: `sent to ${channelId}` }], details: { count: 1 } };
			},
		});
	}

	private token(): string | undefined {
		if (this.options.botToken) return this.options.botToken;
		if (this.options.botTokenEnv) return process.env[this.options.botTokenEnv];
		return undefined;
	}

	private requireCtx(): ModuleContext {
		if (!this.ctx) throw new Error("discord module is not started");
		return this.ctx;
	}
}

async function readBody(req: http.IncomingMessage): Promise<string> {
	const chunks: Buffer[] = [];
	for await (const chunk of req) chunks.push(chunk as Buffer);
	return Buffer.concat(chunks).toString("utf8");
}

const factory: AliveModuleFactory = ({ options }) => new DiscordModule(options as DiscordOptions);
export default factory;
export const createModule = factory;
