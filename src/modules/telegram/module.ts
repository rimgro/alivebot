import * as fs from "node:fs";
import * as path from "node:path";
import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import type { TelegramConfig, TelegramTranscriptionConfig } from "../../config.js";
import { findManagedBotRequest, managedBotRequestStatus, validateAgentId, type ManagedAgent } from "../../agents.js";
import {
	cancelAgentTelegram,
	expireManagedBotRequests,
	finalizeManagedBotRequest,
	formatManagedBotStatus,
	managedBotScope,
	managedBotStatus,
} from "./managed-request.js";
import type { AliveModule, ModuleContext } from "../../events/api.js";
import type { HistoryAttachment } from "../../store/history.js";
import type { OutgoingMessage } from "../../store/outbox.js";
import { ensureDir, newId, sleep } from "../../util.js";
import { MaskContext, maskSecrets } from "../../secrets.js";
import { TelegramApi, TelegramApiError, TelegramFileTooLargeError, type SendMessageParams } from "./client.js";
import {
	TELEGRAM_IMAGE_MAX_BYTES,
	TELEGRAM_IMAGE_TIMEOUT_MS,
	imageAnnotation,
	imageFailureReason,
	imageMime,
	imageRelativePath,
	type InboundImageResult,
} from "./images.js";
import {
	TelegramAllowlistStore,
	TelegramDeliveryLedger,
	TelegramStateStore,
	telegramIdentityView,
	type TelegramPollerConflict,
	type TelegramState,
} from "./state.js";
import { chatLabel, isParseModeError, splitMessage } from "./text.js";
import {
	TELEGRAM_CAPTION_MAX_CHARS,
	AttachmentNotFoundError,
	assertAttachmentSize,
	attachmentKind,
	attachmentRelativePath,
	inspectHostAttachment,
	mimeForFile,
} from "../../runtime/attachments.js";
import { createTelegramTools, type TelegramToolHost } from "./tools.js";
import { formatThread, isTelegramTarget, parseThread, resolveThreadRef } from "./threads.js";
import type { TelegramChat, TelegramSentMessage, TelegramUpdate } from "./types.js";
import { normalizeUpdate, type NormalizedInbound } from "./update.js";
import { acceptBrowserPairing } from "../browser/operator.js";
import {
	GroqTranscriptionError,
	transcribeWithGroq,
} from "./voice-transcription.js";

const DEFAULT_ALLOWED_UPDATES = ["message", "edited_message", "channel_post", "edited_channel_post", "callback_query"];

/** Telegram's 409 description omits the cause; this is the actionable version. */
export const TELEGRAM_DUPLICATE_POLLER_MESSAGE =
	"another poller is using this bot token (duplicate agent/process or a shared token)";

/** Probe/delete and report a 409 at most once per five minutes for this token. */
const TELEGRAM_CONFLICT_WINDOW_MS = 5 * 60_000;

/** A validated attachment, loaded and ready for one Bot API upload. */
interface PreparedUpload {
	data: Buffer;
	name: string;
	mime?: string;
	kind: "photo" | "document";
	/** Workspace-relative path, recorded in the outbound history entry. */
	path: string;
}

/**
 * A burst of edits of the same Telegram message waiting for the debounce window
 * to go quiet. Only the latest version is delivered; `edits` counts the whole
 * burst so the event can say how many corrections it replaced.
 */
interface PendingEditBatch {
	/** `${chatId}:${messageId}` — one batch per message, independent of topic. */
	key: string;
	thread: string;
	latest: NormalizedInbound;
	edits: number;
	/** Timestamp (ms) of the first edit in the burst. */
	firstEditAt: number;
	timer?: NodeJS.Timeout;
}

/** Extra facts attached to a debounced edit event (absent for new messages). */
interface EditBatchMeta {
	edits: number;
	firstEditAt: number;
	editedAfterReply: boolean;
}

/** How often a debounced edit retries while a run is actively working on its thread. */
const TELEGRAM_EDIT_RUN_RETRY_MS = 250;

type VoiceTranscriptionResult =
	| { status: "transcribed"; text: string }
	| { status: "disabled" }
	| { status: "not_configured" }
	| { status: "too_large" }
	| { status: "failed"; reason: string };

/**
 * Full Telegram Bot API integration.
 *
 * Inbound: long polling (`getUpdates`) with a persisted offset, so restarts
 * resume instead of replaying. Every accepted update becomes a durable
 * `user_message` event (deduped by message id) and a record in the shared
 * conversation history. User allowlists and non-allowlisted or unaddressed bot messages are filtered out
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
	private deliveryLedger?: TelegramDeliveryLedger;
	private readonly abort = new AbortController();
	private pollPromise?: Promise<void>;
	private stopped = false;
	private lastError?: string;
	private botId?: number;
	private botUsername?: string;
	private botName?: string;
	private readonly typing = new Map<string, { interval: NodeJS.Timeout; deadline: NodeJS.Timeout }>();
	private managedSweep?: NodeJS.Timeout;
	private typingMaxMsValue = 5 * 60_000;
	private readonly counters = { updates: 0, inbound: 0, outbound: 0, errors: 0 };
	/** Debounced edit bursts, keyed by `${chatId}:${messageId}`. */
	private readonly pendingEdits = new Map<string, PendingEditBatch>();
	private consecutiveFailures = 0;
	private outageStartedAt?: number;
	private lastErrorAt?: number;
	private lastSuccessAt?: number;
	private lastErrorKind?: "network" | "api" | "duplicate-poller";
	private lastFailureNetwork = false;
	private pollerConflict?: TelegramPollerConflict;
	private lastConflictProbeAt = 0;
	private lastConflictNoticeAt = 0;

	constructor(config: TelegramConfig) {
		this.config = config;
	}

	handles(message: OutgoingMessage): boolean {
		return isTelegramTarget(message.thread);
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
		this.deliveryLedger = new TelegramDeliveryLedger(moduleDir);
		this.allowlist = new TelegramAllowlistStore(moduleDir);
		this.api = new TelegramApi({ token, apiBase: this.config.apiBase });
		this.managedSweep = setInterval(() => void this.sweepManagedRequests(), 15_000);
		this.managedSweep.unref?.();
		void this.sweepManagedRequests();

		// Polling must never depend on the identity handshake: a single network blip
		// during getMe used to leave the bot silently deaf until a restart. Start the
		// long-poll loop first, then treat identity as best-effort. A webhook is no
		// longer deleted unconditionally here: the 409 handler checks first.
		this.pollPromise = this.poll();

		let me: Awaited<ReturnType<TelegramApi["getMe"]>> | undefined;
		try {
			me = await this.api.getMe();
		} catch (err) {
			const now = Date.now();
			this.lastError = message(err);
			this.lastErrorAt = now;
			this.lastErrorKind = isNetworkError(err) ? "network" : "api";
			this.lastFailureNetwork = isNetworkError(err);
			// A failed getMe invalidates whatever bot was recorded by an earlier run:
			// status must not keep presenting that identity as connected.
			const current = this.state.load();
			if (current.me) this.state.patch({ me: { ...current.me, stale: true, staleAt: now } });
			ctx.log.warn("telegram getMe failed; polling anyway", { error: this.lastError });
		}

		if (me) {
			const mismatch = this.managedBotIdentityMismatch(ctx, me.id);
			if (mismatch) {
				const error = new Error(mismatch);
				this.lastError = mismatch;
				this.lastErrorAt = Date.now();
				this.lastErrorKind = "api";
				ctx.log.error("telegram bot identity mismatch; refusing to poll", { error: mismatch, botId: me.id });
				// The poll loop already started; a fatal identity mismatch must not leave
				// a second poller behind.
				await this.stop();
				throw error;
			}
			this.botId = me.id;
			this.botUsername = me.username;
			this.botName = [me.first_name, me.last_name].filter(Boolean).join(" ") || me.username || "bot";
			this.state.patch({
				me: { id: me.id, username: me.username, firstName: me.first_name, verifiedAt: Date.now() },
			});
			ctx.log.info("telegram connected", { bot: this.botName, username: this.botUsername, id: this.botId });
		}
	}

	async stop(): Promise<void> {
		this.stopped = true;
		this.abort.abort();
		if (this.managedSweep) clearInterval(this.managedSweep);
		this.managedSweep = undefined;
		for (const thread of [...this.typing.keys()]) this.stopTyping(thread);
		// Deliver edits that were still inside their debounce window instead of
		// silently dropping them: the event and history writes are synchronous.
		for (const batch of [...this.pendingEdits.values()]) this.flushEditBatch(batch.key, true);
		this.pendingEdits.clear();
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
		const identity = telegramIdentityView(state?.me);
		const conflict = this.pollerConflict ?? state?.pollerConflict;
		const networkProblem = Boolean(this.api) && this.consecutiveFailures > 0 && this.lastFailureNetwork;
		const connected =
			Boolean(this.api) &&
			!this.stopped &&
			identity.status === "verified" &&
			this.consecutiveFailures === 0 &&
			conflict === undefined;
		const moduleState = conflict
			? "duplicate-poller"
			: identity.status === "stale"
				? "identity-stale"
				: identity.status === "unknown" && this.api
					? "identity-unknown"
					: networkProblem
						? "network-error"
						: this.consecutiveFailures > 0
							? "error"
							: this.stopped
								? "stopped"
								: "connected";
		return {
			configured: Boolean(this.api),
			polling: Boolean(this.pollPromise),
			pollingBlocked: conflict !== undefined,
			state: moduleState,
			connected,
			reachable: Boolean(this.api) && !networkProblem,
			networkProblem,
			identity,
			bot: state?.me,
			duplicatePoller: conflict !== undefined,
			pollerConflict: conflict ? { ...conflict, state: "duplicate-poller" } : undefined,
			offset: state?.offset,
			lastPollAt: state?.lastPollAt,
			lastUpdateAt: state?.lastUpdateAt,
			lastSuccessAt: this.lastSuccessAt,
			lastError: this.lastError ?? conflict?.message ?? state?.lastError,
			lastErrorKind: this.lastErrorKind ?? (conflict ? "duplicate-poller" : undefined),
			lastErrorAt: this.lastErrorAt,
			consecutiveFailures: this.consecutiveFailures,
			outageMs: this.outageStartedAt ? Date.now() - this.outageStartedAt : 0,
			transcription: {
				enabled: this.config.transcription.enabled,
				// Configuration presence is reported even when the module is not started yet.
				configured:
					this.config.transcription.enabled &&
					Boolean(this.config.transcription.apiKeyEnv) &&
					Boolean(process.env[this.config.transcription.apiKeyEnv]?.trim()),
				provider: "groq",
				model: this.config.transcription.model,
			},
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
					pollerConflict: undefined,
				});
				this.lastError = undefined;
				this.lastErrorKind = undefined;
				this.lastFailureNetwork = false;
				this.pollerConflict = undefined;
				this.lastSuccessAt = Date.now();
				backoff = 1000;
				if (this.consecutiveFailures > 0) {
					const outageMs = this.outageStartedAt ? Date.now() - this.outageStartedAt : 0;
					ctx.log.info("telegram polling recovered", { failures: this.consecutiveFailures, outageMs });
				}
				this.consecutiveFailures = 0;
				this.outageStartedAt = undefined;
				// Probe again immediately if a conflict returns after this recovery.
				this.lastConflictProbeAt = 0;
			} catch (err) {
				if (this.stopped || this.abort.signal.aborted) break;
				this.counters.errors += 1;
				this.consecutiveFailures += 1;
				this.lastErrorAt = Date.now();
				this.outageStartedAt ??= this.lastErrorAt;
				const current = state.load();
				const duplicatePoller = err instanceof TelegramApiError && err.errorCode === 409;

				if (duplicatePoller) {
					// 409 almost always means another process polls this token; deleting the
					// webhook every cycle cannot fix that and can destroy a real webhook.
					// Record the condition before the probe so status is never transiently
					// misreported as a generic error while getWebhookInfo is in flight.
					this.lastError = TELEGRAM_DUPLICATE_POLLER_MESSAGE;
					this.lastErrorKind = "duplicate-poller";
					this.lastFailureNetwork = false;
					this.pollerConflict = {
						since: current.pollerConflict?.since ?? this.pollerConflict?.since ?? this.lastErrorAt,
						message: TELEGRAM_DUPLICATE_POLLER_MESSAGE,
					};
					state.patch({ lastError: this.lastError, errors: current.errors + 1, pollerConflict: this.pollerConflict });
					// Probe once per window and delete only a webhook that is actually set.
					const probe = await this.probeConflictingWebhook(api);
					const detail = {
						error: this.lastError,
						state: "duplicate-poller",
						failures: this.consecutiveFailures,
						outageMs: Date.now() - (this.outageStartedAt ?? Date.now()),
						webhookChecked: probe.checked,
						webhookRemoved: probe.removed,
						...(probe.error ? { webhookCheckError: probe.error } : {}),
					};
					if (probe.removed) {
						ctx.log.info("telegram removed a webhook that was blocking polling", detail);
					} else if (this.lastErrorAt - this.lastConflictNoticeAt >= TELEGRAM_CONFLICT_WINDOW_MS) {
						this.lastConflictNoticeAt = this.lastErrorAt;
						ctx.log.warn(`telegram 409: ${TELEGRAM_DUPLICATE_POLLER_MESSAGE}`, detail);
					} else {
						ctx.log.debug("telegram is still blocked by a duplicate poller", detail);
					}
				} else {
					this.lastError = message(err);
					this.lastFailureNetwork = isNetworkError(err);
					this.lastErrorKind = this.lastFailureNetwork ? "network" : "api";
					state.patch({ lastError: this.lastError, errors: current.errors + 1 });
					if (err instanceof TelegramApiError && err.errorCode === 401) {
						ctx.log.error("telegram rejected the bot token; polling stopped", { error: this.lastError });
						break;
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
						// The VPN/proxy hint is only for a request that never reached Telegram.
						...(this.consecutiveFailures === 1 && this.lastFailureNetwork
							? { hint: "telegram is unreachable from this host; check the VPN/proxy route or point modules.telegram.apiBase at a local proxy" }
							: {}),
					};
					if (loud) ctx.log.warn("telegram getUpdates failed", detail);
					else ctx.log.debug("telegram getUpdates still failing", detail);
				}

				const retryAfter = err instanceof TelegramApiError ? err.retryAfterSec : undefined;
				const waitMs = retryAfter !== undefined ? retryAfter * 1000 : jitter(backoff);
				await sleep(waitMs, this.abort.signal);
				backoff = Math.min(backoff * 2, 60_000);
			}
		}
	}

	/**
	 * Guard against a managed agent accidentally reading somebody else's token:
	 * `telegram-managed-bot.json` records the bot Telegram assigned to this agent.
	 */
	private managedBotIdentityMismatch(ctx: ModuleContext, actualId: number): string | undefined {
		const file = path.join(ctx.paths.rootDir, "telegram-managed-bot.json");
		if (!fs.existsSync(file)) return undefined;
		try {
			const raw = JSON.parse(fs.readFileSync(file, "utf8")) as { id?: unknown };
			const recordedId = Number(raw.id);
			if (!Number.isSafeInteger(recordedId) || recordedId <= 0) {
				ctx.log.warn("telegram-managed-bot.json has no valid bot id; skipping the identity check", { file });
				return undefined;
			}
			if (recordedId === actualId) return undefined;
			return (
				`telegram bot identity mismatch: getMe returned bot id ${actualId}, but telegram-managed-bot.json ` +
				`records bot id ${recordedId}; the config token does not belong to this agent`
			);
		} catch (err) {
			ctx.log.warn("telegram-managed-bot.json could not be read; skipping the identity check", { file, error: message(err) });
			return undefined;
		}
	}

	/**
	 * A 409 means another poller holds this token, but Telegram also reports it
	 * when a webhook is set. Check `getWebhookInfo` at most once per window and
	 * delete a webhook only if one is really configured. Never delete blindly.
	 */
	private async probeConflictingWebhook(
		api: TelegramApi,
	): Promise<{ checked: boolean; removed: boolean; error?: string }> {
		const now = Date.now();
		if (now - this.lastConflictProbeAt < TELEGRAM_CONFLICT_WINDOW_MS) {
			return { checked: false, removed: false };
		}
		this.lastConflictProbeAt = now;
		try {
			const info = await api.getWebhookInfo();
			if (!info.url?.trim()) return { checked: true, removed: false };
			await api.deleteWebhook({ drop_pending_updates: false });
			return { checked: true, removed: true };
		} catch (err) {
			return { checked: true, removed: false, error: message(err) };
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
		const scope = managedBotScope({ paths: ctx.paths, config: { modules: { telegram: this.config } } });
		// A late confirmation after the TTL is expired, not attached.
		await this.sweepManagedRequests();
		const request = findManagedBotRequest(scope.root, messageUpdate.chat.id);
		if (!request || managedBotRequestStatus(request, scope.ttlMs) !== "pending") return;
		const agentId = validateAgentId(request.agentId);
		const agentDirectory = path.join(ctx.paths.stateDir, "agents", agentId);
		const agent: ManagedAgent = {
			id: agentId,
			directory: agentDirectory,
			configPath: path.join(agentDirectory, "alive.config.json"),
		};
		const view = await finalizeManagedBotRequest({
			scope,
			api,
			request,
			agent: fs.existsSync(agent.configPath) ? agent : undefined,
			bot: { id: created.id, username: created.username },
		});
		if (view.status === "created") {
			ctx.log.info("managed Telegram bot attached to agent", { agentId, botId: created.id, username: created.username });
		} else {
			ctx.log.warn("managed Telegram bot was not attached", { agentId, botId: created.id, error: view.error });
		}
	}

	/** Expire overdue managed-bot requests and remove their stale keyboards. */
	private async sweepManagedRequests(): Promise<void> {
		const ctx = this.ctx;
		const api = this.api;
		if (!ctx || !api) return;
		try {
			const expired = await expireManagedBotRequests(managedBotScope({ paths: ctx.paths, config: { modules: { telegram: this.config } } }), api, {
				log: (error, request) => ctx.log.warn("managed-bot expiry message failed", { agentId: request.agentId, error: message(error) }),
			});
			if (expired.length > 0) ctx.log.info("managed-bot requests expired", { agents: expired.map((view) => view.agentId) });
		} catch (error) {
			ctx.log.warn("managed-bot expiry sweep failed", { error: message(error) });
		}
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
				? "Телефон привязан для локальных демонстраций. В обычном Alive помощь браузеру приходит в личный чат пользователя, который поставил задачу."
				: "Привязка не выполнена. Запустите alive browser pair и отправьте новую команду боту в личном чате. Настроенный список разрешённых чатов также должен допускать этот чат." });
			// Pairing capabilities must never enter history, events or model context.
			return;
		}
		const inbound = normalizeUpdate(update, {
			botId: this.botId,
			botUsername: this.botUsername,
			allowedBotIds: this.config.allowedBotIds,
			requireMentionInGroups: this.config.requireMentionInGroups,
			ingestEdits: this.config.ingestEdits,
			editExpectsReply: this.config.editExpectsReply,
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

		// Edits are corrections, not new questions (#113): debounce them per message
		// and deliver one merged event for the whole burst instead of one run per
		// keystroke. `processInbound` receives the burst metadata for `meta.edits`.
		if (inbound.isEdit) {
			this.queueEdit(inbound);
			return;
		}
		await this.processInbound(inbound);
	}

	/**
	 * Persist one normalized inbound update as history + a durable event.
	 *
	 * Edits arrive here only through the debounce batch below, so `edit` is set
	 * when several corrections of one message collapsed into this event.
	 */
	private async processInbound(inbound: NormalizedInbound, edit?: EditBatchMeta): Promise<void> {
		const ctx = this.ctx;
		const api = this.api;
		const state = this.state;
		if (!ctx || !api || !state) return;

		try {
			let eventText = inbound.promptText;
			let historyText = inbound.text;
			let payload: Record<string, unknown> = inbound.payload;
			const photo = inbound.attachments.find((attachment) => attachment.kind === "photo");
			if (photo) {
				if (this.config.typingIndicator && inbound.expectsReply) this.startTyping(inbound.thread);
				const image = await this.saveInboundImage(photo, inbound.messageId, api, ctx);
				const annotation = imageAnnotation(image);
				eventText = `${eventText}\n\n${annotation}`;
				// The saved path is durable knowledge for later searches; transient failures
				// stay in the event text only, like voice transcription errors.
				if (image.status === "saved") {
					historyText = `${historyText}\n\n${annotation}`;
					payload = { ...payload, image: { path: image.path, mime: image.mime, bytes: image.bytes } };
				}
			}

			const voice = inbound.attachments.find((attachment) => attachment.kind === "voice");
			if (voice) {
				if (this.config.typingIndicator && inbound.expectsReply) this.startTyping(inbound.thread);
				const transcriptionConfig = this.config.transcription;
				const transcription = await this.transcribeVoice(voice, api, ctx, transcriptionConfig);
				const annotation = voiceAnnotation(transcription, transcriptionConfig);
				eventText = `${eventText}\n\n${annotation}`;
				// Only the transcript belongs in durable history: configuration hints and
				// transient provider failures there would be permanent noise for search.
				if (transcription.status === "transcribed") historyText = `${historyText}\n\n${annotation}`;
				payload = {
					...payload,
					transcription: {
						provider: "groq",
						model: transcriptionConfig.model,
						status: transcription.status,
						...(transcription.status === "transcribed" ? { text: transcription.text } : {}),
					},
				};
			}

			const event = ctx.userMessage({
				text: eventText,
				thread: inbound.thread,
				title: inbound.eventTitle,
				author: inbound.author?.name,
				authorId: inbound.author?.id,
				expectsReply: inbound.expectsReply,
				// The store supports priorities and the prompt shows them. Edits are
				// deliberately low: a correction should join the pending batch rather
				// than compete with fresh human requests.
				priority: inbound.isEdit ? "low" : "normal",
				dedupeKey: inbound.dedupeKey,
				ts: inbound.ts,
				payload,
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
					...(edit
						? { edits: edit.edits, firstEditAt: edit.firstEditAt, editedAfterReply: edit.editedAfterReply }
						: {}),
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
				text: historyText,
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
					...(edit ? { edits: edit.edits, firstEditAt: edit.firstEditAt, editedAfterReply: edit.editedAfterReply } : {}),
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
			ctx.log.error("telegram update handling failed", { updateId: inbound.updateId, error: message(err) });
		}
	}

	// ------------------------------------------------------------------
	// edit debouncing (#113)
	// ------------------------------------------------------------------

	/**
	 * Add one edit to its message's batch and (re)start the quiet window.
	 *
	 * Debounce is trailing-edge: every correction restarts the timer, so a burst
	 * of edits separated by less than `editDebounceMs` becomes one event that
	 * carries the final text. `editDebounceMs: 0` flushes after each edit while
	 * still tagging the event as an edit.
	 */
	private queueEdit(inbound: NormalizedInbound): void {
		const key = `${inbound.chatId}:${inbound.messageId}`;
		const existing = this.pendingEdits.get(key);
		if (existing) {
			existing.latest = inbound;
			existing.edits += 1;
			this.scheduleEditFlush(existing);
			return;
		}
		const batch: PendingEditBatch = {
			key,
			thread: inbound.thread,
			latest: inbound,
			edits: 1,
			firstEditAt: inbound.ts,
		};
		this.pendingEdits.set(key, batch);
		this.scheduleEditFlush(batch);
	}

	private scheduleEditFlush(batch: PendingEditBatch): void {
		if (batch.timer) clearTimeout(batch.timer);
		const delay = this.config.editDebounceMs;
		if (delay <= 0) {
			batch.timer = undefined;
			void this.flushEditBatch(batch.key);
			return;
		}
		batch.timer = setTimeout(() => {
			batch.timer = undefined;
			void this.flushEditBatch(batch.key);
		}, delay);
		batch.timer.unref?.();
	}

	/**
	 * Emit the merged batch once the quiet window elapsed.
	 *
	 * While a run is actively working on this thread the batch is not emitted
	 * yet: it keeps merging and retries in a moment. Once the run goes idle the
	 * event lands in the same durable pending batch and is claimed by that run's
	 * `idle`, so a second parallel run never starts (the runtime is single-run by
	 * construction). Edits are also emitted as `priority: "low"` — the store
	 * records the field and the prompt shows it, while the pending queue itself
	 * is still strict FIFO. `force` is used from `stop()` to flush instead of
	 * losing the last window.
	 */
	private async flushEditBatch(key: string, force = false): Promise<void> {
		const batch = this.pendingEdits.get(key);
		if (!batch) return;
		if (batch.timer) clearTimeout(batch.timer);
		batch.timer = undefined;
		if (this.stopped && !force) {
			this.pendingEdits.delete(key);
			return;
		}
		if (!force && this.threadHasWorkingRun(batch.thread)) {
			this.retryEditFlush(batch);
			return;
		}
		this.pendingEdits.delete(key);
		const { inbound, edit } = this.mergeEditBatch(batch);
		await this.processInbound(inbound, edit);
	}

	private retryEditFlush(batch: PendingEditBatch): void {
		batch.timer = setTimeout(() => {
			batch.timer = undefined;
			void this.flushEditBatch(batch.key);
		}, TELEGRAM_EDIT_RUN_RETRY_MS);
		batch.timer.unref?.();
	}

	/** Is the runtime currently running the model for this thread (not idling)? */
	private threadHasWorkingRun(thread: string): boolean {
		const ctx = this.ctx;
		if (!ctx) return false;
		const status = ctx.runtimeStatus();
		if (status.status !== "working") return false;
		return (ctx.currentThreads?.() ?? []).includes(thread);
	}

	/** Latest text of the batch plus the counters and the after-answer marker. */
	private mergeEditBatch(batch: PendingEditBatch): { inbound: NormalizedInbound; edit: EditBatchMeta } {
		const inbound: NormalizedInbound = { ...batch.latest, payload: { ...batch.latest.payload } };
		const editedAfterReply = this.hasRepliedTo(batch.thread, inbound.messageId);
		if (editedAfterReply) {
			inbound.promptText += "\n(правка после ответа: это сообщение изменено после того, как агент уже ответил; отвечай только если новая версия явно адресована боту)";
			// An edit after the answer is a correction, never a renewed obligation.
			// Only an explicit mention / reply-to-bot keeps `expectsReply` true.
			if (!inbound.addressedToBot) inbound.expectsReply = false;
		}
		const edit: EditBatchMeta = { edits: batch.edits, firstEditAt: batch.firstEditAt, editedAfterReply };
		inbound.payload = {
			...inbound.payload,
			edits: edit.edits,
			firstEditAt: edit.firstEditAt,
			editedAfterReply: edit.editedAfterReply,
		};
		return { inbound, edit };
	}

	/**
	 * Did the agent already send a message that is a Telegram reply to this one?
	 *
	 * The outbound history record keeps `replyTo` as the Telegram message id when
	 * `send_message` used `reply_to` (a raw id or an event id resolved through
	 * history), which is the only durable evidence that the answer belongs to
	 * this exact message.
	 */
	private hasRepliedTo(thread: string, messageId: string): boolean {
		const history = this.ctx?.history;
		if (!history) return false;
		return history
			.query({ thread, direction: "outbound", limit: 200, order: "desc" })
			.some((record) => record.replyTo === messageId);
	}

	/**
	 * Save the largest photo of an incoming message into the workspace so the agent
	 * can read it without spending a tool round-trip on `download_file`.
	 *
	 * Photos only: documents (including image PDFs), stickers and voice notes keep
	 * their existing on-demand behaviour. A failure here is reported in the event
	 * text but never drops the message.
	 */
	private async saveInboundImage(
		photo: HistoryAttachment,
		messageId: string,
		api: TelegramApi,
		ctx: ModuleContext,
	): Promise<InboundImageResult> {
		if (!photo.fileId) return { status: "failed", reason: "Telegram photo attachment has no file id" };
		if (photo.size !== undefined && photo.size > TELEGRAM_IMAGE_MAX_BYTES) return { status: "too_large" };
		const mime = imageMime(photo);
		// One budget for the metadata call and the streamed download, aborted with the module.
		const signal = AbortSignal.any([this.abort.signal, AbortSignal.timeout(TELEGRAM_IMAGE_TIMEOUT_MS)]);
		try {
			const file = await api.getFile({ file_id: photo.fileId }, { timeoutMs: TELEGRAM_IMAGE_TIMEOUT_MS, signal });
			if (file.file_size !== undefined && file.file_size > TELEGRAM_IMAGE_MAX_BYTES) return { status: "too_large" };
			if (!file.file_path) return { status: "failed", reason: "Telegram did not provide a file path" };
			const data = await api.downloadFile(file.file_path, { maxBytes: TELEGRAM_IMAGE_MAX_BYTES, signal });
			const relativePath = imageRelativePath(messageId, photo.fileUniqueId, mime);
			if (ctx.workspaceFiles) {
				await ctx.workspaceFiles.writeFile(path.posix.join(ctx.workspaceFiles.rootDir, relativePath), data);
			} else {
				const target = path.join(ctx.paths.workspaceDir, relativePath);
				ensureDir(path.dirname(target));
				fs.writeFileSync(target, data);
			}
			return { status: "saved", path: relativePath, mime, bytes: data.length };
		} catch (err) {
			// The byte cap also fires while streaming, after the metadata size check.
			if (err instanceof TelegramFileTooLargeError) return { status: "too_large" };
			const reason = imageFailureReason(err);
			ctx.log.warn("telegram image save failed", { reason, messageId });
			return { status: "failed", reason };
		}
	}

	private async transcribeVoice(
		voice: HistoryAttachment,
		api: TelegramApi,
		ctx: ModuleContext,
		config: TelegramTranscriptionConfig,
	): Promise<VoiceTranscriptionResult> {
		// An explicit switch plus an explicit key keep voice audio from leaving the host
		// just because some unrelated feature happens to export the same env variable.
		if (!config.enabled) return { status: "disabled" };
		if (!config.apiKeyEnv) return { status: "disabled" };
		const apiKey = process.env[config.apiKeyEnv]?.trim();
		if (!apiKey) return { status: "not_configured" };
		if (!voice.fileId) return { status: "failed", reason: "Telegram voice attachment has no file id" };
		if (voice.size !== undefined && voice.size > config.maxBytes) return { status: "too_large" };

		const signal = AbortSignal.any([this.abort.signal, AbortSignal.timeout(config.timeoutMs)]);
		try {
			const file = await api.getFile({ file_id: voice.fileId }, { timeoutMs: config.timeoutMs, signal });
			if (file.file_size !== undefined && file.file_size > config.maxBytes) return { status: "too_large" };
			if (!file.file_path) return { status: "failed", reason: "Telegram did not provide a file path" };
			const audio = await api.downloadFile(file.file_path, { maxBytes: config.maxBytes, signal });
			const text = await transcribeWithGroq({
				apiKey,
				audio,
				mimeType: voice.mime,
				model: config.model,
				maxBytes: config.maxBytes,
				signal,
				timeoutMs: config.timeoutMs,
			});
			return { status: "transcribed", text };
		} catch (err) {
			// The byte cap also fires while streaming, after the update's own size check.
			if (err instanceof TelegramFileTooLargeError) return { status: "too_large" };
			const reason = transcriptionFailureReason(err);
			ctx.log.warn("telegram voice transcription failed", { reason });
			return { status: "failed", reason };
		}
	}

	private allowed(inbound: NormalizedInbound): boolean {
		if (this.config.allowedChatIds.length > 0) {
			const allowed = this.config.allowedChatIds.map(String);
			if (!allowed.includes(inbound.chatId)) return false;
		}
		if (!inbound.author) return false;
		if (inbound.author.isBot) {
			return this.config.allowedBotIds.map(String).includes(inbound.author.id) && inbound.expectsReply;
		}
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
		// One masking context per message: repeated secrets share an id across text,
		// caption and the follow-up remainder.
		const context = new MaskContext();
		const text = maskSecrets(message.text, ctx.config.secrets, process.env, context);
		const ref = resolveThreadRef(message.thread);
		const api = this.requireApi();
		const topicId = ref.topicId !== undefined ? Number(ref.topicId) : undefined;
		const threadId = Number.isFinite(topicId) ? topicId : undefined;
		const replyTo = this.resolveReplyTo(message);
		// Attachments are read and limit-checked before the first API call: an
		// unreadable or oversize file must not leave half a message in the chat.
		const uploads = await this.prepareAttachments(ctx, message.attachments);
		const sent: Array<{ result: TelegramSentMessage; text: string; attachment?: PreparedUpload }> = [];
		let replyUsed = false;
		const nextReplyTo = () => (replyUsed ? undefined : ((replyUsed = true), replyTo));
		// One stable idempotency key per outbox message part. Recovery of a message
		// whose first attempt crashed must not send an already-accepted part again.
		const idempotencyBase = message.deliveryKey ?? message.id ?? `${message.runId}:${message.ts}`;
		const partKey = (index: number) => `${idempotencyBase}:${index}`;

		if (uploads.length > 0) {
			// Telegram captions are limited to 1024 characters; the remainder becomes
			// ordinary text messages so no part of the reply is lost. Only the first
			// attachment carries the caption (one file per `send_message` today).
			const captions = splitMessage(text, TELEGRAM_CAPTION_MAX_CHARS);
			for (const [index, upload] of uploads.entries()) {
				const caption = index === 0 ? captions[0] ?? "" : "";
				const params = {
					chat_id: ref.chatId,
					file: { data: upload.data, name: upload.name, mime: upload.mime },
					field: upload.kind,
					caption: caption || undefined,
					message_thread_id: threadId,
					reply_to_message_id: nextReplyTo(),
				};
				const result = await this.sendPart(partKey(index), ref.chatId, message.thread, async () => {
					try {
						return await api.sendFile({ ...params, parse_mode: this.config.parseMode || undefined });
					} catch (err) {
						if (this.config.parseMode && isParseModeError(err)) {
							ctx.log.warn("telegram rejected the caption markup; resending as plain text", { thread: message.thread });
							return api.sendFile({ ...params, parse_mode: undefined });
						}
						throw err;
					}
				});
				if (result) sent.push({ result, text: caption || `[${upload.kind}: ${upload.name}]`, attachment: upload });
			}
			for (const [index, text] of captions.slice(1).entries()) {
				const result = await this.sendPart(partKey(uploads.length + index), ref.chatId, message.thread, () =>
					this.sendTextChunk(ctx, api, ref.chatId, threadId, text, nextReplyTo()),
				);
				if (result) sent.push({ result, text });
			}
		} else {
			const chunks = splitMessage(text, this.config.maxMessageChars);
			for (const [index, text] of chunks.entries()) {
				const result = await this.sendPart(partKey(index), ref.chatId, message.thread, () =>
					this.sendTextChunk(ctx, api, ref.chatId, threadId, text, nextReplyTo()),
				);
				if (result) sent.push({ result, text });
			}
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
				...(entry.attachment ? { attachments: [historyAttachment(entry.attachment)] } : {}),
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
		ctx.log.info("telegram message sent", {
			thread: message.thread,
			parts: sent.length,
			chars: text.length,
			attachments: uploads.map((upload) => `${upload.kind}:${upload.name}`),
		});
		return sent.map((entry) => entry.result);
	}

	/**
	 * Send one message part at most once across a crash.
	 *
	 * The Bot API offers no idempotency key, so `sending` is persisted before the
	 * call. A crash leaves the part `sending`; recovery logs and skips it instead
	 * of risking a duplicate in the chat. Definite API rejections and network
	 * failures that never reached Telegram are marked `failed` and stay retryable.
	 */
	private async sendPart(
		key: string,
		chatId: string,
		thread: string,
		send: () => Promise<TelegramSentMessage>,
	): Promise<TelegramSentMessage | undefined> {
		const ledger = this.deliveryLedger;
		const prior = ledger?.shouldSkip(key);
		if (prior) {
			this.ctx?.log.warn("telegram suppressed a duplicate message part after an interrupted delivery", {
				thread,
				part: key,
				state: prior.state,
				messageId: prior.messageId,
			});
			return undefined;
		}
		ledger?.markSending(key, chatId);
		try {
			const sent = await send();
			ledger?.markSent(key, chatId, sent.message_id);
			return sent;
		} catch (err) {
			const network = err instanceof TelegramApiError && err.network;
			const rejected = err instanceof TelegramApiError && !err.network && err.errorCode !== undefined && err.errorCode < 500;
			// Anything else is ambiguous (e.g. a 5xx after the write): leaving it
			// `sending` chooses no duplicate over possible loss.
			if (network || rejected) ledger?.markFailed(key, chatId, message(err));
			throw err;
		}
	}

	/** One text chunk of an outbound message, with the plain-text fallback for broken markup. */
	private async sendTextChunk(
		ctx: ModuleContext,
		api: TelegramApi,
		chatId: string,
		threadId: number | undefined,
		text: string,
		replyTo: number | undefined,
	): Promise<TelegramSentMessage> {
		const base: SendMessageParams = {
			chat_id: chatId,
			text,
			message_thread_id: threadId,
			disable_web_page_preview: !this.config.linkPreview,
			reply_to_message_id: replyTo,
			allow_sending_without_reply: true,
		};
		try {
			return await api.sendMessage({ ...base, parse_mode: this.config.parseMode || undefined });
		} catch (err) {
			if (this.config.parseMode && isParseModeError(err)) {
				ctx.log.warn("telegram rejected the message markup; resending as plain text", { thread: `telegram:${chatId}` });
				return api.sendMessage({ ...base, parse_mode: undefined });
			}
			throw err;
		}
	}

	/**
	 * Read every attachment and apply Telegram's limits before any API call.
	 *
	 * Host-side validation (realpath containment, regular file, size) runs
	 * whenever the host can see the workspace. Inside a sandbox it usually cannot,
	 * so a missing host file is deferred and the bridge read proves existence.
	 */
	private async prepareAttachments(ctx: ModuleContext, attachments: OutgoingMessage["attachments"]): Promise<PreparedUpload[]> {
		const uploads: PreparedUpload[] = [];
		const bridge = ctx.workspaceFiles;
		const workspace = path.resolve(bridge?.rootDir ?? ctx.paths.workspaceDir);
		for (const attachment of attachments ?? []) {
			if (!attachment || typeof attachment.path !== "string" || !attachment.path.trim()) continue;
			const requestedKind = attachment.kind;
			const relativePath = attachmentRelativePath(attachment.path);
			let inspected: ReturnType<typeof inspectHostAttachment> | undefined;
			try {
				inspected = inspectHostAttachment(workspace, relativePath, requestedKind);
			} catch (err) {
				// A sandbox workspace is not visible on the host; only that case may defer.
				if (!bridge || !(err instanceof AttachmentNotFoundError)) throw err;
			}
			const name = uploadName(attachment.name, relativePath);
			const mime = mimeForFile(name);
			const kind = attachmentKind(mime, requestedKind);
			if (attachment.size !== undefined) assertAttachmentSize(kind, attachment.size, name);
			if (inspected?.size !== undefined) assertAttachmentSize(kind, inspected.size, name);
			let data: Buffer;
			if (bridge) {
				try {
					data = await bridge.readFile(path.posix.join(bridge.rootDir, relativePath));
				} catch (err) {
					if (isMissingFileError(err)) throw new AttachmentNotFoundError(relativePath);
					throw new Error(`attachment not readable in the workspace: ${relativePath} (${message(err)})`);
				}
			} else {
				data = fs.readFileSync(inspected!.absolutePath);
			}
			assertAttachmentSize(kind, data.length, name);
			uploads.push({ data, name, mime, kind, path: relativePath });
		}
		return uploads;
	}

	/** Send used by the `telegram` tool (proactive messages to any chat). */
	private async sendText(input: { thread: string; text: string; replyTo?: number }): Promise<TelegramSentMessage[]> {
		const id = newId("msg");
		const message: OutgoingMessage = {
			id,
			deliveryKey: id,
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
		const filePaths = ctx.workspaceFiles ? path.posix : path;
		const workspace = filePaths.resolve(ctx.workspaceFiles?.rootDir ?? ctx.paths.workspaceDir);
		const resolved = filePaths.resolve(workspace, input.filePath);
		if (resolved !== workspace && !resolved.startsWith(`${workspace}${filePaths.sep}`)) {
			throw new Error(`send_file can only read files inside the workspace (${workspace})`);
		}
		const maxBytes = 50 * 1024 * 1024;
		let data: Buffer;
		if (ctx.workspaceFiles) {
			data = await ctx.workspaceFiles.readFile(resolved);
		} else {
			const stat = fs.statSync(resolved);
			if (!stat.isFile()) throw new Error(`not a file: ${resolved}`);
			if (stat.size > maxBytes) throw new Error(`file is ${stat.size} bytes, over the ${maxBytes} byte upload limit`);
			data = fs.readFileSync(resolved);
		}
		if (data.length > maxBytes) throw new Error(`file is ${data.length} bytes, over the ${maxBytes} byte upload limit`);
		const name = filePaths.basename(resolved);
		const field = input.as ?? guessFileField(name);
		const replyTo = input.replyTo;
		const caption = input.caption === undefined
			? undefined
			: maskSecrets(input.caption, ctx.config.secrets, process.env, new MaskContext());
		const sent = await api.sendFile({
			chat_id: ref.chatId,
			file: { data, name, mime: mimeForFile(name) },
			field,
			caption,
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
			text: caption ? `${caption} [file: ${name}]` : `[file: ${name}]`,
			messageId: String(sent.message_id),
			replyTo: replyTo !== undefined ? String(replyTo) : undefined,
			attachments: [{ kind: field, name, mime: mimeForFile(name), size: data.length }],
			meta: { agentMessageId: "tool", chatId: ref.chatId, topicId: ref.topicId, uploadedPath: resolved },
		});
		this.counters.outbound += 1;
		ctx.log.info("telegram file sent", { thread: input.thread, name, bytes: data.length, field });
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
			workspaceDir: ctx.workspaceFiles?.rootDir ?? ctx.paths.workspaceDir,
			writeWorkspaceFile: ctx.workspaceFiles?.writeFile,
			readWorkspaceFile: ctx.workspaceFiles?.readFile,
			defaultParseMode: this.config.parseMode,
			maxMessageChars: this.config.maxMessageChars,
			sendText: (input) => this.sendText(input),
			sendFile: (input) => this.sendFile(input),
			upsertChat: (chat: TelegramChat) => this.upsertChat(chat),
			typing: (thread: string) => this.startTyping(thread),
			botIdentity: () => ({ id: this.botId, username: this.botUsername, name: this.botName }),
			snapshot: () => this.status(),
			managedStatus: (agentId) => formatManagedBotStatus(managedBotStatus(managedBotScope({ paths: ctx.paths, config: { modules: { telegram: this.config } } }), agentId)),
			cancelManagedRequest: async (agentId) => {
				const view = await cancelAgentTelegram(managedBotScope({ paths: ctx.paths, config: { modules: { telegram: this.config } } }), this.requireApi(), agentId);
				return view
					? `Cancelled pending managed-bot request for ${view.agentId} in chat ${view.chatId}.`
					: `No pending managed-bot request for ${agentId}.`;
			},
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

/** Upload file name: the recorded one, reduced to a bare name, or the path's basename. */
function uploadName(recorded: string | undefined, relativePath: string): string {
	const base = path.posix.basename((recorded ?? "").trim());
	if (base && base !== "." && base !== "..") return base;
	return path.posix.basename(relativePath);
}

/** Bridge read failed because the file is not in the (possibly sandboxed) workspace. */
function isMissingFileError(err: unknown): boolean {
	const code = (err as NodeJS.ErrnoException | undefined)?.code;
	return code === "ENOENT" || code === "ENOTDIR" || message(err).includes("ENOENT");
}

/** Outbound history keeps the attachment path next to the provider metadata. */
function historyAttachment(upload: PreparedUpload): HistoryAttachment {
	return {
		kind: upload.kind,
		name: upload.name,
		...(upload.mime ? { mime: upload.mime } : {}),
		size: upload.data.length,
		meta: { path: upload.path },
	};
}

/** Human-readable, secret-free annotation appended to the agent-facing event text. */
function voiceAnnotation(result: VoiceTranscriptionResult, config: TelegramTranscriptionConfig): string {
	switch (result.status) {
		case "transcribed":
			return `voice transcript (${config.model} via Groq):\n${result.text || "(no speech recognized)"}`;
		case "disabled":
			return "voice transcription disabled: modules.telegram.transcription.enabled=false";
		case "not_configured":
			return `voice transcription unavailable: set ${config.apiKeyEnv} in the host environment`;
		case "too_large":
			return `voice transcription skipped: file exceeds the ${mibLabel(config.maxBytes)} limit`;
		case "failed":
			return `voice transcription unavailable: ${result.reason}`;
	}
}

function mibLabel(bytes: number): string {
	return bytes > 0 && bytes % (1024 * 1024) === 0 ? `${bytes / (1024 * 1024)} MiB` : `${bytes} bytes`;
}

/** Map a failure to a short reason that never carries the key, the URL, or a provider body. */
function transcriptionFailureReason(err: unknown): string {
	if (err instanceof GroqTranscriptionError) {
		if (err.status !== undefined) return `Groq returned HTTP ${err.status}`;
		if (err.code === "timeout") return "Groq request timed out";
		if (err.code === "invalid_response") return "Groq returned an unreadable response";
		return "Groq request failed";
	}
	if (err instanceof TelegramApiError) {
		return err.errorCode !== undefined ? `Telegram returned HTTP/API ${err.errorCode}` : "Telegram file download failed";
	}
	if (err instanceof Error && (err.name === "AbortError" || err.name === "TimeoutError")) return "request timed out";
	return "request failed";
}

export type { TelegramState };
