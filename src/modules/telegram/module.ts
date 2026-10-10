import * as fs from "node:fs";
import * as path from "node:path";
import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import type { TelegramConfig } from "../../config.js";
import { attachManagedBotToken, clearManagedBotRequest, findManagedBotRequest, validateAgentId, type ManagedAgent } from "../../agents.js";
import type { AliveModule, ModuleContext } from "../../events/api.js";
import type { OutgoingMessage } from "../../store/outbox.js";
import { sleep } from "../../util.js";
import { TelegramApi, TelegramApiError, type SendMessageParams } from "./client.js";
import { TelegramAllowlistStore, TelegramStateStore, type TelegramState } from "./state.js";
import { chatLabel, isParseModeError, splitMessage } from "./text.js";
import { createTelegramTools, type TelegramToolHost } from "./tools.js";
import { formatThread, parseThread } from "./threads.js";
import type { TelegramChat, TelegramSentMessage, TelegramUpdate } from "./types.js";
import { normalizeUpdate, type NormalizedInbound } from "./update.js";
import { acceptBrowserPairing } from "../browser/operator.js";

const DEFAULT_ALLOWED_UPDATES = ["message", "edited_message", "channel_post", "edited_channel_post", "callback_query"];

/**
 * Full Telegram Bot API integration.
 *
 * Inbound: long polling (`getUpdates`) with a persisted offset, so restarts
 * resume instead of replaying. Every accepted update becomes a durable
 * `user_message` event (deduped by message id) and a record in the shared
 * conversation history. Access lists and bot-authored messages are filtered out
 * before anything reaches the agent.
 *
 * Outbound: `send_message` to a `telegram:<chatId>[/<topicId>]` thread is split
 * across Telegram's 4096-character limit, replied to the message the agent chose
 * (`reply_to`), and recorded in history. Broken markup falls back to plain text
 * instead of losing the message.
 *
 * Tools: the `telegram` tool exposes the history, chat/member introspection,
 * reactions, pins, forwarding, file download and command registration.
 *
 * Telegram's Bot API gives bots no server-side chat history — the local history
 * written by this module (and readable through the `telegram` and `history`
 * tools) is what makes "read the chat history" possible.
 */
export class TelegramModule implements AliveModule {
	readonly name = "telegram";
	readonly kind = "chat" as const;

	private readonly config: TelegramConfig;
	private ctx?: ModuleContext;
	private api?: TelegramApi;
	private state?: TelegramStateStore;
	private allowlist?: TelegramAllowlistStore;
	private readonly abort = new AbortController();
	private pollPromise?: Promise<void>;
	private stopped = false;
	private lastError?: string;
	private botId?: number;
	private botUsername?: string;
	private botName?: string;
	private readonly typing = new Map<string, { interval: NodeJS.Timeout; deadline: NodeJS.Timeout }>();
	private typingMaxMsValue = 5 * 60_000;
	private readonly counters = { updates: 0, inbound: 0, outbound: 0, errors: 0 };
	private consecutiveFailures = 0;
	private outageStartedAt?: number;
	private lastErrorAt?: number;
	private lastSuccessAt?: number;

	constructor(config: TelegramConfig) {
		this.config = config;
	}

	handles(message: OutgoingMessage): boolean {
		return parseThread(message.thread) !== undefined;
	}

	async start(ctx: ModuleContext): Promise<void> {
		this.ctx = ctx;
		this.typingMaxMsValue = ctx.config.loop.runTimeoutMs + 60_000;
		ctx.signal.addEventListener(
			"abort",
			() => {
				this.stopped = true;
				this.abort.abort();
			},
			{ once: true },
		);
		ctx.onOutbound(async (message) => {
			await this.send(message);
		});
		ctx.contributeStatus(() => this.status());

		const token = resolveToken(this.config);
		if (!token) {
			this.lastError = "no bot token configured";
			ctx.log.error(
				"telegram is enabled but has no token: set modules.telegram.token or the environment variable " +
					`${this.config.tokenEnv || "ALIVE_TELEGRAM_TOKEN"}`,
			);
			return;
		}

		const moduleDir = ctx.moduleDir();
		this.state = new TelegramStateStore(moduleDir);
		this.allowlist = new TelegramAllowlistStore(moduleDir);
		this.api = new TelegramApi({ token, apiBase: this.config.apiBase });

		// Polling must never depend on the identity handshake: a single network blip
		// during getMe/deleteWebhook used to leave the bot silently deaf until a
		// restart. Start the long-poll loop first, then treat identity as best-effort.
		this.pollPromise = this.poll();

		try {
			await this.api.deleteWebhook({ drop_pending_updates: false });
		} catch (err) {
			this.lastError = message(err);
			this.lastErrorAt = Date.now();
			ctx.log.warn("telegram deleteWebhook failed; polling anyway", { error: this.lastError });
		}

		try {
			const me = await this.api.getMe();
			this.botId = me.id;
			this.botUsername = me.username;
			this.botName = [me.first_name, me.last_name].filter(Boolean).join(" ") || me.username || "bot";
			this.state.patch({ me: { id: me.id, username: me.username, firstName: me.first_name } });
			ctx.log.info("telegram connected", { bot: this.botName, username: this.botUsername, id: this.botId });
		} catch (err) {
			this.lastError = message(err);
			this.lastErrorAt = Date.now();
			ctx.log.warn("telegram getMe failed; polling anyway", { error: this.lastError });
		}
	}

	async stop(): Promise<void> {
		this.stopped = true;
		this.abort.abort();
		for (const thread of [...this.typing.keys()]) this.stopTyping(thread);
		await this.pollPromise?.catch(() => undefined);
		this.pollPromise = undefined;
	}

	tools(ctx: ModuleContext): ToolDefinition[] {
		if (!this.api) return [];
		return createTelegramTools(this.toolHost(ctx));
	}

	status(): Record<string, unknown> {
		const state = this.state?.load();
		const chats = this.ctx ? this.ctx.history.threads({ module: "telegram" }).length : 0;
		const messages = this.ctx ? this.ctx.history.stats().messages : 0;
		return {
			configured: Boolean(this.api),
			polling: Boolean(this.pollPromise),
			connected: Boolean(this.api) && this.consecutiveFailures === 0,
			reachable: Boolean(this.api) && this.consecutiveFailures === 0,
			bot: state?.me,
			offset: state?.offset,
			lastPollAt: state?.lastPollAt,
			lastUpdateAt: state?.lastUpdateAt,
			lastSuccessAt: this.lastSuccessAt,
			lastError: this.lastError ?? state?.lastError,
			lastErrorAt: this.lastErrorAt,
			consecutiveFailures: this.consecutiveFailures,
			outageMs: this.outageStartedAt ? Date.now() - this.outageStartedAt : 0,
			chats,
			historyMessages: messages,
			counters: { ...this.counters },
		};
	}

	// ------------------------------------------------------------------
	// polling
	// ------------------------------------------------------------------

	private async poll(): Promise<void> {
		const ctx = this.ctx;
		const api = this.api;
		const state = this.state;
		if (!ctx || !api || !state) return;
		let backoff = 1000;
		while (!this.stopped && !this.abort.signal.aborted) {
			try {
				const current = state.load();
				const updates = await api.getUpdates({
					offset: current.offset > 0 ? current.offset : undefined,
					limit: 100,
					timeout: this.config.pollTimeoutSec,
					allowed_updates: this.config.allowedUpdates.length > 0 ? this.config.allowedUpdates : DEFAULT_ALLOWED_UPDATES,
					signal: this.abort.signal,
				});
				let highest = current.offset - 1;
				for (const update of updates) {
					await this.handleUpdate(update);
					highest = Math.max(highest, update.update_id);
				}
				state.patch({
					offset: highest + 1,
					lastPollAt: Date.now(),
					polls: current.polls + 1,
					updates: current.updates + updates.length,
					lastError: undefined,
				});
				this.lastError = undefined;
				this.lastSuccessAt = Date.now();
				backoff = 1000;
				if (this.consecutiveFailures > 0) {
					const outageMs = this.outageStartedAt ? Date.now() - this.outageStartedAt : 0;
					ctx.log.info("telegram polling recovered", { failures: this.consecutiveFailures, outageMs });
				}
				this.consecutiveFailures = 0;
				this.outageStartedAt = undefined;
			} catch (err) {
				if (this.stopped || this.abort.signal.aborted) break;
				this.counters.errors += 1;
				this.consecutiveFailures += 1;
				this.lastError = message(err);
				this.lastErrorAt = Date.now();
				this.outageStartedAt ??= this.lastErrorAt;
				const current = state.load();
				state.patch({ lastError: this.lastError, errors: current.errors + 1 });
				if (err instanceof TelegramApiError && err.errorCode === 401) {
					ctx.log.error("telegram rejected the bot token; polling stopped", { error: this.lastError });
					break;
				}
				// A leftover webhook makes every getUpdates fail with 409. Startup could not
				// clear it (offline), so retry here instead of staying deaf forever.
				if (err instanceof TelegramApiError && err.errorCode === 409) {
					try {
						await api.deleteWebhook({ drop_pending_updates: false });
						ctx.log.warn("telegram cleared a conflicting webhook; resuming polling", { error: this.lastError });
					} catch {
						// keep the normal backoff path below
					}
				}
				const retryAfter = err instanceof TelegramApiError ? err.retryAfterSec : undefined;
				const waitMs = retryAfter !== undefined ? retryAfter * 1000 : jitter(backoff);
				// One warning when the outage starts (and occasionally after), otherwise
				// debug: a blocked route must not flood the console every second.
				const loud = this.consecutiveFailures === 1 || this.consecutiveFailures % 30 === 0;
				const detail = {
					error: this.lastError,
					networkCode: err instanceof TelegramApiError ? err.networkCode : undefined,
					failures: this.consecutiveFailures,
					outageMs: Date.now() - (this.outageStartedAt ?? Date.now()),
					waitMs,
					...(this.consecutiveFailures === 1 && isNetworkError(err)
						? { hint: "telegram is unreachable from this host; check the VPN/proxy route or point modules.telegram.apiBase at a local proxy" }
						: {}),
				};
				if (loud) ctx.log.warn("telegram getUpdates failed", detail);
				else ctx.log.debug("telegram getUpdates still failing", detail);
				await sleep(waitMs, this.abort.signal);
				backoff = Math.min(backoff * 2, 60_000);
			}
		}
	}

	private async handleManagedBotCreated(update: TelegramUpdate): Promise<void> {
		const ctx = this.ctx;
		const api = this.api;
		const messageUpdate = update.message;
		const created = messageUpdate?.managed_bot_created?.bot;
		if (!ctx || !api || !messageUpdate || !created || !created.is_bot) return;
		// Managed-bot creation must be approved by the same private user who
		// initiated the local request. Never accept a bot shared in a group.
		if (messageUpdate.chat.type !== "private" || !messageUpdate.from || messageUpdate.chat.id !== messageUpdate.from.id) return;
		const requestRoot = ctx.moduleDir();
		const request = findManagedBotRequest(requestRoot, messageUpdate.chat.id);
		if (!request) return;
		if (Date.now() - request.requestedAt > 24 * 60 * 60 * 1000) {
			clearManagedBotRequest(requestRoot, request);
			await api.sendMessage({ chat_id: messageUpdate.chat.id, text: "That agent's bot request expired. Start a new request from the alive CLI." });
			return;
		}
		const agentId = validateAgentId(request.agentId);
		const agentDirectory = path.join(ctx.paths.stateDir, "agents", agentId);
		const agent: ManagedAgent = {
			id: agentId,
			directory: agentDirectory,
			configPath: path.join(agentDirectory, "alive.config.json"),
		};
		if (!fs.existsSync(agent.configPath)) throw new Error(`requested agent no longer exists: ${agentId}`);
		const token = await api.getManagedBotToken(created.id);
		attachManagedBotToken(agent, token, { id: created.id, username: created.username });
		clearManagedBotRequest(requestRoot, request);
		await api.sendMessage({
			chat_id: messageUpdate.chat.id,
			text: `Managed bot @${created.username ?? created.id} is now attached to agent “${agentId}”. Start it with: alive agents start ${agentId}`,
		});
		ctx.log.info("managed Telegram bot attached to agent", { agentId, botId: created.id, username: created.username });
	}

	private async handleUpdate(update: TelegramUpdate): Promise<void> {
		if (update.message?.managed_bot_created) {
			await this.handleManagedBotCreated(update);
			return;
		}
		const ctx = this.ctx;
		const api = this.api;
		const state = this.state;
		if (!ctx || !api || !state) return;
		if (update.message?.text?.match(/^\/browser_pair(?:@[A-Za-z0-9_]+)?(?:\s|$)/)) {
			const operator = acceptBrowserPairing(ctx.paths.modulesDir, update.message, this.config.allowedChatIds);
			if (operator) this.allowlist?.add(operator.userId);
			await api.sendMessage({ chat_id: update.message.chat.id, text: operator
				? "Телефон привязан. Alive будет отправлять помощь браузеру в этот личный чат."
				: "Привязка не выполнена. Запустите alive browser pair и отправьте новую команду боту в личном чате. Настроенный список разрешённых чатов также должен допускать этот чат." });
			// Pairing capabilities must never enter history, events or model context.
			return;
		}
		const inbound = normalizeUpdate(update, {
			botId: this.botId,
			botUsername: this.botUsername,
			ingestEdits: this.config.ingestEdits,
		});
		if (!inbound) return;
		if (update.callback_query) {
			void api.answerCallbackQuery({ callback_query_id: update.callback_query.id }).catch(() => undefined);
		}
		if (!this.allowed(inbound)) {
			ctx.log.debug("telegram update denied by allowlist", { chatId: inbound.chatId, author: inbound.author?.id });
			if (inbound.author?.id) {
				const text =
					`⛔ Доступ не разрешён. Ваш Telegram ID: ${inbound.author.id}.\n` +
					`Чтобы добавить себя в вайтлист, попросите владельца выполнить в консоли: alive telegram whitelist add ${inbound.author.id}`;
				void api.sendMessage({
					chat_id: inbound.chatId,
					text,
					message_thread_id: inbound.topicId !== undefined ? Number(inbound.topicId) : undefined,
				}).catch((err) => ctx.log.warn("telegram deny message failed", { chatId: inbound.chatId, error: message(err) }));
			}
			return;
		}

		try {
			const event = ctx.userMessage({
				text: inbound.promptText,
				thread: inbound.thread,
				title: inbound.eventTitle,
				author: inbound.author?.name,
				authorId: inbound.author?.id,
				expectsReply: inbound.expectsReply,
				dedupeKey: inbound.dedupeKey,
				ts: inbound.ts,
				payload: inbound.payload,
				meta: {
					chatId: inbound.chatId,
					chatTitle: inbound.chatLabel,
					chatType: inbound.chat.type,
					topicId: inbound.topicId,
					messageId: inbound.messageId,
					updateId: inbound.updateId,
					updateType: inbound.updateType,
					edited: inbound.isEdit,
					replyTo: inbound.replyToMessageId,
				},
			});
			ctx.history.append({
				id: inbound.historyId,
				thread: inbound.thread,
				module: "telegram",
				direction: "inbound",
				ts: inbound.ts,
				author: inbound.author?.name,
				authorId: inbound.author?.id,
				text: inbound.text,
				messageId: inbound.messageId,
				replyTo: inbound.replyToMessageId,
				attachments: inbound.attachments,
				meta: {
					eventId: event.id,
					chatId: inbound.chatId,
					chatType: inbound.chat.type,
					chatTitle: inbound.chatLabel,
					username: inbound.chat.username,
					topicId: inbound.topicId,
					updateId: inbound.updateId,
					updateType: inbound.updateType,
					edited: inbound.isEdit,
				},
			});
			this.maybePrune(inbound.thread);
			ctx.history.upsertThread({
				thread: inbound.thread,
				module: "telegram",
				title: inbound.chatLabel,
				participants: inbound.author ? [inbound.author.name] : [],
				meta: {
					chatId: inbound.chatId,
					chatType: inbound.chat.type,
					chatTitle: inbound.chat.title,
					username: inbound.chat.username,
					topicId: inbound.topicId,
					lastMessageId: inbound.messageId,
				},
			});

			if (this.config.ackReaction && inbound.expectsReply && inbound.updateType === "message") {
				void api
					.setMessageReaction({
						chat_id: inbound.chatId,
						message_id: Number(inbound.messageId),
						reaction: [{ type: "emoji", emoji: this.config.ackReaction }],
					})
					.catch((err) => ctx.log.debug("telegram ack reaction failed", { error: message(err) }));
			}
			if (this.config.typingIndicator && inbound.expectsReply) this.startTyping(inbound.thread);

			this.counters.updates += 1;
			this.counters.inbound += 1;
			const current = state.load();
			state.patch({ inbound: current.inbound + 1, lastUpdateAt: Date.now() });
		} catch (err) {
			this.counters.errors += 1;
			ctx.log.error("telegram update handling failed", { updateId: update.update_id, error: message(err) });
		}
	}

	private allowed(inbound: NormalizedInbound): boolean {
		if (this.config.allowedChatIds.length > 0) {
			const allowed = this.config.allowedChatIds.map(String);
			if (!allowed.includes(inbound.chatId)) return false;
		}
		if (!inbound.author) return false;
		const allowed = new Set([
			...this.config.allowedUserIds.map(String),
			...(this.allowlist?.list() ?? []),
		]);
		return allowed.has(inbound.author.id);
	}

	// ------------------------------------------------------------------
	// outbound
	// ------------------------------------------------------------------

	private async send(message: OutgoingMessage): Promise<TelegramSentMessage[]> {
		const ctx = this.ctx;
		if (!ctx) throw new Error("telegram module is not started");
		const ref = parseThread(message.thread);
		if (!ref) throw new Error(`not a telegram thread: ${message.thread}`);
		const api = this.requireApi();
		const topicId = ref.topicId !== undefined ? Number(ref.topicId) : undefined;
		const chunks = splitMessage(message.text, this.config.maxMessageChars);
		const replyTo = this.resolveReplyTo(message);
		const sent: Array<{ result: TelegramSentMessage; text: string }> = [];

		for (let index = 0; index < chunks.length; index += 1) {
			const text = chunks[index]!;
			const base: SendMessageParams = {
				chat_id: ref.chatId,
				text,
				message_thread_id: Number.isFinite(topicId) ? topicId : undefined,
				disable_web_page_preview: !this.config.linkPreview,
				reply_to_message_id: index === 0 ? replyTo : undefined,
				allow_sending_without_reply: true,
			};
			let result: TelegramSentMessage;
			try {
				result = await api.sendMessage({ ...base, parse_mode: this.config.parseMode || undefined });
			} catch (err) {
				if (this.config.parseMode && isParseModeError(err)) {
					ctx.log.warn("telegram rejected the message markup; resending as plain text", { thread: message.thread });
					result = await api.sendMessage({ ...base, parse_mode: undefined });
				} else {
					throw err;
				}
			}
			sent.push({ result, text });
		}

		this.stopTyping(message.thread);
		const outboundAt = Date.now();
		for (const [index, entry] of sent.entries()) {
			ctx.history.append({
				id: `telegram:${ref.chatId}:${entry.result.message_id}`,
				thread: message.thread,
				module: "telegram",
				direction: "outbound",
				ts: outboundAt,
				author: this.botName ?? "agent",
				authorId: this.botId !== undefined ? String(this.botId) : undefined,
				text: entry.text,
				messageId: String(entry.result.message_id),
				replyTo: index === 0 && replyTo !== undefined ? String(replyTo) : undefined,
				meta: {
					agentMessageId: message.id,
					part: index + 1,
					parts: sent.length,
					chatId: ref.chatId,
					topicId: ref.topicId,
				},
			});
		}
		this.counters.outbound += sent.length;
		const state = this.state;
		if (state) {
			const current = state.load();
			state.patch({ outbound: current.outbound + sent.length });
		}
		ctx.log.info("telegram message sent", { thread: message.thread, parts: sent.length, chars: message.text.length });
		return sent.map((entry) => entry.result);
	}

	/** Send used by the `telegram` tool (proactive messages to any chat). */
	private async sendText(input: { thread: string; text: string; replyTo?: number }): Promise<TelegramSentMessage[]> {
		const message: OutgoingMessage = {
			id: `tool_${Date.now().toString(36)}`,
			runId: "tool",
			thread: input.thread,
			text: input.text,
			ts: Date.now(),
			replyTo: input.replyTo !== undefined ? String(input.replyTo) : undefined,
		};
		return this.send(message);
	}

	/**
	 * Upload a file from the agent workspace. Paths outside the workspace are
	 * refused: the agent should not be able to exfiltrate arbitrary host files.
	 */
	private async sendFile(input: {
		thread: string;
		filePath: string;
		caption?: string;
		as?: "document" | "photo" | "audio" | "video";
		replyTo?: number;
	}): Promise<TelegramSentMessage> {
		const ctx = this.requireCtx();
		const ref = parseThread(input.thread);
		if (!ref) throw new Error(`not a telegram thread: ${input.thread}`);
		const api = this.requireApi();
		const workspace = path.resolve(ctx.paths.workspaceDir);
		const resolved = path.resolve(workspace, input.filePath);
		if (resolved !== workspace && !resolved.startsWith(`${workspace}${path.sep}`)) {
			throw new Error(`send_file can only read files inside the workspace (${workspace})`);
		}
		const stat = fs.statSync(resolved);
		if (!stat.isFile()) throw new Error(`not a file: ${resolved}`);
		const maxBytes = 50 * 1024 * 1024;
		if (stat.size > maxBytes) throw new Error(`file is ${stat.size} bytes, over the ${maxBytes} byte upload limit`);
		const name = path.basename(resolved);
		const field = input.as ?? guessFileField(name);
		const replyTo = input.replyTo;
		const sent = await api.sendFile({
			chat_id: ref.chatId,
			file: { data: fs.readFileSync(resolved), name, mime: mimeForFile(name) },
			field,
			caption: input.caption,
			parse_mode: this.config.parseMode || undefined,
			message_thread_id: ref.topicId !== undefined ? Number(ref.topicId) : undefined,
			reply_to_message_id: replyTo,
		});
		this.stopTyping(input.thread);
		ctx.history.append({
			id: `telegram:${ref.chatId}:${sent.message_id}`,
			thread: input.thread,
			module: "telegram",
			direction: "outbound",
			ts: Date.now(),
			author: this.botName ?? "agent",
			text: input.caption ? `${input.caption} [file: ${name}]` : `[file: ${name}]`,
			messageId: String(sent.message_id),
			replyTo: replyTo !== undefined ? String(replyTo) : undefined,
			attachments: [{ kind: field, name, mime: mimeForFile(name), size: stat.size }],
			meta: { agentMessageId: "tool", chatId: ref.chatId, topicId: ref.topicId, uploadedPath: resolved },
		});
		this.counters.outbound += 1;
		ctx.log.info("telegram file sent", { thread: input.thread, name, bytes: stat.size, field });
		return sent;
	}

	private resolveReplyTo(message: OutgoingMessage): number | undefined {
		const raw = message.replyTo;
		if (!raw) return undefined;
		if (/^\d+$/.test(raw)) return Number(raw);
		const history = this.ctx?.history;
		if (!history) return undefined;
		const record =
			history.get(raw) ??
			history.query({ thread: message.thread, limit: 200, order: "desc" }).find((entry) => entry.meta?.eventId === raw);
		const id = record?.messageId;
		return id !== undefined && /^\d+$/.test(id) ? Number(id) : undefined;
	}

	private requireApi(): TelegramApi {
		if (!this.api) throw new Error(this.lastError ?? "telegram module has no API client (no token or startup failed)");
		return this.api;
	}

	private requireCtx(): ModuleContext {
		if (!this.ctx) throw new Error("telegram module is not started");
		return this.ctx;
	}

	// ------------------------------------------------------------------
	// typing indicator
	// ------------------------------------------------------------------

	private startTyping(thread: string): void {
		if (this.typing.has(thread)) return;
		const ref = parseThread(thread);
		const api = this.api;
		if (!ref || !api) return;
		const tick = () => {
			void api
				.sendChatAction({
					chat_id: ref.chatId,
					action: "typing",
					message_thread_id: ref.topicId !== undefined ? Number(ref.topicId) : undefined,
				})
				.catch(() => undefined);
		};
		tick();
		const interval = setInterval(tick, 4500);
		interval.unref?.();
		const deadline = setTimeout(() => this.stopTyping(thread), this.typingMaxMs());
		deadline.unref?.();
		this.typing.set(thread, { interval, deadline });
	}

	private stopTyping(thread: string): void {
		const entry = this.typing.get(thread);
		if (!entry) return;
		clearInterval(entry.interval);
		clearTimeout(entry.deadline);
		this.typing.delete(thread);
	}

	private typingMaxMs(): number {
		// Bound the indicator so a crashed run cannot leave the bot "typing" forever.
		return this.typingMaxMsValue;
	}

	private maybePrune(thread: string): void {
		const limit = this.config.historyLimitPerThread;
		if (limit <= 0 || !this.ctx) return;
		const info = this.ctx.history.thread(thread);
		if (info && info.messageCount > limit + 64) {
			const dropped = this.ctx.history.prune(thread, limit);
			this.ctx.log.debug("telegram history pruned", { thread, dropped, limit });
		}
	}

	// ------------------------------------------------------------------
	// tool host
	// ------------------------------------------------------------------

	private toolHost(ctx: ModuleContext): TelegramToolHost {
		return {
			api: this.requireApi(),
			history: ctx.history,
			workspaceDir: ctx.paths.workspaceDir,
			defaultParseMode: this.config.parseMode,
			maxMessageChars: this.config.maxMessageChars,
			sendText: (input) => this.sendText(input),
			sendFile: (input) => this.sendFile(input),
			upsertChat: (chat: TelegramChat) => this.upsertChat(chat),
			typing: (thread: string) => this.startTyping(thread),
			botIdentity: () => ({ id: this.botId, username: this.botUsername, name: this.botName }),
			snapshot: () => this.status(),
		};
	}

	upsertChat(chat: TelegramChat): void {
		this.ctx?.history.upsertThread({
			thread: formatThread(chat.id),
			module: "telegram",
			title: chatLabel(chat),
			meta: {
				chatId: String(chat.id),
				chatType: chat.type,
				chatTitle: chat.title,
				username: chat.username,
				description: chat.description,
				isForum: chat.is_forum,
			},
		});
	}
}

/** Environment wins over the config file so tokens do not have to be committed. */
export function resolveToken(config: TelegramConfig, env: NodeJS.ProcessEnv = process.env): string {
	const fromEnv = config.tokenEnv ? env[config.tokenEnv] : undefined;
	return (fromEnv ?? "").trim() || (config.token ?? "").trim();
}

function message(err: unknown): string {
	return err instanceof Error ? err.message : String(err);
}

/** Transport-level failure (never reached Telegram): reset, timeout, DNS, TLS. */
function isNetworkError(err: unknown): boolean {
	return err instanceof TelegramApiError && err.network;
}

/** Spread retries so a fleet of bots does not reconnect in lockstep. */
function jitter(ms: number): number {
	return Math.round(ms * (0.8 + Math.random() * 0.4));
}

/** Pick the Bot API upload field from the file extension. */
function guessFileField(name: string): "document" | "photo" | "audio" | "video" {
	const ext = path.extname(name).toLowerCase();
	if ([".jpg", ".jpeg", ".png", ".webp", ".gif"].includes(ext)) return "photo";
	if ([".mp3", ".m4a", ".ogg", ".flac", ".wav"].includes(ext)) return "audio";
	if ([".mp4", ".mov", ".webm", ".mkv"].includes(ext)) return "video";
	return "document";
}

const MIME_BY_EXT: Record<string, string> = {
	".png": "image/png",
	".jpg": "image/jpeg",
	".jpeg": "image/jpeg",
	".webp": "image/webp",
	".gif": "image/gif",
	".pdf": "application/pdf",
	".json": "application/json",
	".txt": "text/plain; charset=utf-8",
	".md": "text/markdown; charset=utf-8",
	".csv": "text/csv",
	".zip": "application/zip",
	".gz": "application/gzip",
	".mp3": "audio/mpeg",
	".ogg": "audio/ogg",
	".m4a": "audio/mp4",
	".wav": "audio/wav",
	".mp4": "video/mp4",
	".webm": "video/webm",
};

function mimeForFile(name: string): string | undefined {
	return MIME_BY_EXT[path.extname(name).toLowerCase()];
}

export type { TelegramState };
