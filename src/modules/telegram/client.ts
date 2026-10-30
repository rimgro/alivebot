import type {
	TelegramApiEnvelope,
	TelegramCallbackQuery,
	TelegramChat,
	TelegramChatMember,
	TelegramFile,
	TelegramMessage,
	TelegramSentMessage,
	TelegramUpdate,
	TelegramUser,
	TelegramWebhookInfo,
} from "./types.js";
import { TELEGRAM_MAX_CHARS, splitMessage } from "./text.js";

export class TelegramApiError extends Error {
	readonly method: string;
	readonly errorCode?: number;
	readonly retryAfterSec?: number;
	/** True when the request never reached Telegram (network reset, timeout, DNS). */
	readonly network: boolean;
	/** Lowest-level OS/undici code, e.g. ECONNRESET, ETIMEDOUT, EAI_AGAIN. */
	readonly networkCode?: string;

	constructor(method: string, description: string, errorCode?: number, retryAfterSec?: number, network?: NetworkFailure) {
		super(`${method} failed${errorCode === undefined ? "" : ` (${errorCode})`}: ${description}`);
		this.name = "TelegramApiError";
		this.method = method;
		this.errorCode = errorCode;
		this.retryAfterSec = retryAfterSec;
		this.network = network !== undefined;
		this.networkCode = network?.code;
	}
}

/** The remote file exceeded the caller's byte budget; safe to surface as "too large". */
export class TelegramFileTooLargeError extends Error {
	readonly limitBytes: number;

	constructor(limitBytes: number) {
		super(`file is larger than the ${limitBytes} byte limit`);
		this.name = "TelegramFileTooLargeError";
		this.limitBytes = limitBytes;
	}
}

export interface TelegramApiOptions {
	token: string;
	/** Defaults to https://api.telegram.org. Point it at a local bot-api server if needed. */
	apiBase?: string;
	/** Default request timeout. Long polls override this automatically. */
	timeoutMs?: number;
	/** Injectable for tests. */
	fetchImpl?: typeof fetch;
}

export interface SendMessageParams {
	chat_id: string | number;
	text: string;
	message_thread_id?: number;
	parse_mode?: string;
	disable_web_page_preview?: boolean;
	disable_notification?: boolean;
	reply_to_message_id?: number;
	allow_sending_without_reply?: boolean;
	reply_markup?: unknown;
}

/**
 * Minimal, dependency-free Telegram Bot API client.
 *
 * Only what the module needs: long polling, sending/editing/deleting messages,
 * chat introspection, files and reactions. All methods POST JSON and unwrap the
 * `{ ok, result }` envelope, turning `ok: false` into a typed error so callers
 * can distinguish "broken markup" from "rate limited" from "bad token".
 */
export class TelegramApi {
	readonly token: string;
	readonly apiBase: string;
	private readonly timeoutMs: number;
	private readonly fetchImpl: typeof fetch;

	constructor(options: TelegramApiOptions) {
		if (!options.token) throw new Error("TelegramApi requires a bot token");
		this.token = options.token;
		this.apiBase = (options.apiBase || "https://api.telegram.org").replace(/\/+$/, "");
		this.timeoutMs = options.timeoutMs ?? 30_000;
		this.fetchImpl = options.fetchImpl ?? fetch;
	}

	async call<T>(method: string, params: Record<string, unknown> = {}, options: { timeoutMs?: number; signal?: AbortSignal } = {}): Promise<T> {
		return this.request<T>(
			method,
			{ method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(params) },
			options.timeoutMs ?? this.timeoutMs,
			options.signal,
		);
	}

	private async request<T>(method: string, init: RequestInit, timeoutMs: number, signal?: AbortSignal): Promise<T> {
		const url = `${this.apiBase}/bot${this.token}/${method}`;
		const controller = new AbortController();
		const timeout = setTimeout(() => {
			controller.abort(new Error(`telegram ${method} timed out after ${timeoutMs}ms`));
		}, timeoutMs);
		const onAbort = () => controller.abort(signal?.reason);
		signal?.addEventListener("abort", onAbort, { once: true });
		let response: Response;
		try {
			response = await this.fetchImpl(url, { ...init, signal: controller.signal });
		} catch (err) {
			const failure = describeNetworkFailure(err);
			throw new TelegramApiError(method, failure.description, undefined, undefined, failure);
		} finally {
			clearTimeout(timeout);
			signal?.removeEventListener("abort", onAbort);
		}

		const raw = await response.text();
		let envelope: TelegramApiEnvelope<T>;
		try {
			envelope = JSON.parse(raw) as TelegramApiEnvelope<T>;
		} catch {
			throw new TelegramApiError(method, `HTTP ${response.status}: ${raw.slice(0, 300) || "(empty body)"}`, response.status);
		}
		if (!envelope.ok) {
			throw new TelegramApiError(
				method,
				envelope.description ?? `HTTP ${response.status}`,
				envelope.error_code ?? response.status,
				envelope.parameters?.retry_after,
			);
		}
		return envelope.result as T;
	}

	/** POST a multipart form (file uploads). Telegram accepts the same JSON envelope. */
	sendMultipart<T>(method: string, form: FormData, options: { timeoutMs?: number; signal?: AbortSignal } = {}): Promise<T> {
		return this.request<T>(method, { method: "POST", body: form }, options.timeoutMs ?? this.timeoutMs, options.signal);
	}

	/**
	 * Upload a local file as a document or photo. Returns the sent message.
	 * `field` is the Bot API field name (`document`, `photo`, `audio`, `video`).
	 */
	async sendFile(params: {
		chat_id: string | number;
		file: { data: Buffer; name: string; mime?: string };
		field?: "document" | "photo" | "audio" | "video";
		caption?: string;
		parse_mode?: string;
		message_thread_id?: number;
		reply_to_message_id?: number;
		reply_markup?: unknown;
	}): Promise<TelegramMessage> {
		const form = new FormData();
		form.append("chat_id", String(params.chat_id));
		if (params.caption) form.append("caption", params.caption);
		if (params.parse_mode) form.append("parse_mode", params.parse_mode);
		if (params.message_thread_id !== undefined) form.append("message_thread_id", String(params.message_thread_id));
		if (params.reply_to_message_id !== undefined) form.append("reply_to_message_id", String(params.reply_to_message_id));
		if (params.reply_markup !== undefined) form.append("reply_markup", JSON.stringify(params.reply_markup));
		const bytes = new Uint8Array(params.file.data);
		const blob = new Blob([bytes], params.file.mime ? { type: params.file.mime } : undefined);
		const field = params.field ?? "document";
		form.append(field, blob, params.file.name);
		const method = ({ document: "sendDocument", photo: "sendPhoto", audio: "sendAudio", video: "sendVideo" } as const)[field];
		return this.sendMultipart<TelegramMessage>(method, form);
	}

	// ------------------------------------------------------------------
	// identity & polling
	// ------------------------------------------------------------------

	getMe(): Promise<TelegramUser> {
		return this.call<TelegramUser>("getMe");
	}

	getManagedBotToken(userId: number): Promise<string> {
		return this.call<string>("getManagedBotToken", { user_id: userId });
	}

	replaceManagedBotToken(userId: number): Promise<string> {
		return this.call<string>("replaceManagedBotToken", { user_id: userId });
	}

	getWebhookInfo(): Promise<TelegramWebhookInfo> {
		return this.call<TelegramWebhookInfo>("getWebhookInfo");
	}

	deleteWebhook(params: { drop_pending_updates?: boolean } = {}): Promise<boolean> {
		return this.call<boolean>("deleteWebhook", params);
	}

	async getUpdates(params: {
		offset?: number;
		limit?: number;
		timeout?: number;
		allowed_updates?: string[];
		signal?: AbortSignal;
	}): Promise<TelegramUpdate[]> {
		const pollSeconds = params.timeout ?? 0;
		return this.call<TelegramUpdate[]>(
			"getUpdates",
			{
				offset: params.offset,
				limit: params.limit ?? 100,
				timeout: pollSeconds,
				allowed_updates: params.allowed_updates,
			},
			{ timeoutMs: (pollSeconds + 15) * 1000, signal: params.signal },
		);
	}

	// ------------------------------------------------------------------
	// messages
	// ------------------------------------------------------------------

	sendMessage(params: SendMessageParams): Promise<TelegramSentMessage> {
		return this.call<TelegramSentMessage>("sendMessage", { ...params });
	}

	editMessageText(params: {
		chat_id: string | number;
		message_id: number;
		text: string;
		parse_mode?: string;
		disable_web_page_preview?: boolean;
	}): Promise<TelegramMessage | boolean> {
		return this.call<TelegramMessage | boolean>("editMessageText", { ...params });
	}

	deleteMessage(params: { chat_id: string | number; message_id: number }): Promise<boolean> {
		return this.call<boolean>("deleteMessage", { ...params });
	}

	forwardMessage(params: {
		chat_id: string | number;
		from_chat_id: string | number;
		message_id: number;
		message_thread_id?: number;
		disable_notification?: boolean;
	}): Promise<TelegramMessage> {
		return this.call<TelegramMessage>("forwardMessage", { ...params });
	}

	copyMessage(params: {
		chat_id: string | number;
		from_chat_id: string | number;
		message_id: number;
		message_thread_id?: number;
	}): Promise<{ message_id: number }> {
		return this.call<{ message_id: number }>("copyMessage", { ...params });
	}

	sendChatAction(params: { chat_id: string | number; action: string; message_thread_id?: number }): Promise<boolean> {
		return this.call<boolean>("sendChatAction", { ...params });
	}

	pinChatMessage(params: {
		chat_id: string | number;
		message_id: number;
		disable_notification?: boolean;
	}): Promise<boolean> {
		return this.call<boolean>("pinChatMessage", { ...params });
	}

	unpinChatMessage(params: { chat_id: string | number; message_id?: number }): Promise<boolean> {
		return this.call<boolean>("unpinChatMessage", { ...params });
	}

	setMessageReaction(params: {
		chat_id: string | number;
		message_id: number;
		reaction: Array<{ type: "emoji"; emoji: string }>;
		is_big?: boolean;
	}): Promise<boolean> {
		return this.call<boolean>("setMessageReaction", { ...params });
	}

	answerCallbackQuery(params: { callback_query_id: string; text?: string; show_alert?: boolean }): Promise<boolean> {
		return this.call<boolean>("answerCallbackQuery", { ...params });
	}

	// ------------------------------------------------------------------
	// chats
	// ------------------------------------------------------------------

	getChat(params: { chat_id: string | number }): Promise<TelegramChat> {
		return this.call<TelegramChat>("getChat", { ...params });
	}

	getChatMemberCount(params: { chat_id: string | number }): Promise<number> {
		return this.call<number>("getChatMemberCount", { ...params });
	}

	getChatAdministrators(params: { chat_id: string | number }): Promise<TelegramChatMember[]> {
		return this.call<TelegramChatMember[]>("getChatAdministrators", { ...params });
	}

	getChatMember(params: { chat_id: string | number; user_id: number | string }): Promise<TelegramChatMember> {
		return this.call<TelegramChatMember>("getChatMember", { ...params });
	}

	setMyCommands(params: { commands: Array<{ command: string; description: string }>; scope?: unknown }): Promise<boolean> {
		return this.call<boolean>("setMyCommands", { ...params });
	}

	// ------------------------------------------------------------------
	// files
	// ------------------------------------------------------------------

	getFile(params: { file_id: string }, options: { timeoutMs?: number; signal?: AbortSignal } = {}): Promise<TelegramFile> {
		return this.call<TelegramFile>("getFile", { ...params }, options);
	}

	/** Public URL of a file path returned by getFile. Contains the bot token. */
	fileUrl(filePath: string): string {
		return `${this.apiBase}/file/bot${this.token}/${filePath.replace(/^\/+/, "")}`;
	}

	/** Download a file by its Telegram file path. Capped to avoid unbounded memory use. */
	async downloadFile(filePath: string, options: { maxBytes?: number; signal?: AbortSignal } = {}): Promise<Buffer> {
		const maxBytes = options.maxBytes ?? 20 * 1024 * 1024;
		const response = await this.fetchImpl(this.fileUrl(filePath), { signal: options.signal });
		if (!response.ok) {
			throw new Error(`file download failed: HTTP ${response.status}`);
		}
		const declaredLength = Number(response.headers.get("content-length"));
		if (Number.isFinite(declaredLength) && declaredLength > maxBytes) {
			await response.body?.cancel().catch(() => undefined);
			throw new TelegramFileTooLargeError(maxBytes);
		}
		const reader = response.body?.getReader();
		if (!reader) {
			const buffer = Buffer.from(await response.arrayBuffer());
			if (buffer.length > maxBytes) throw new TelegramFileTooLargeError(maxBytes);
			return buffer;
		}
		const chunks: Uint8Array[] = [];
		let total = 0;
		try {
			while (true) {
				const { done, value } = await reader.read();
				if (done) break;
				total += value.byteLength;
				if (total > maxBytes) {
					await reader.cancel().catch(() => undefined);
					throw new TelegramFileTooLargeError(maxBytes);
				}
				chunks.push(value);
			}
		} finally {
			reader.releaseLock();
		}
		return Buffer.concat(chunks, total);
	}

	// ------------------------------------------------------------------
	// convenience
	// ------------------------------------------------------------------

	/**
	 * Send text that may exceed Telegram's 4096-character limit by splitting it
	 * into several messages. `reply_to_message_id` is applied to the first chunk
	 * only. Returns every message the bot produced.
	 */
	async sendLongMessage(params: SendMessageParams): Promise<TelegramSentMessage[]> {
		const chunks = splitMessage(params.text, TELEGRAM_MAX_CHARS);
		const sent: TelegramSentMessage[] = [];
		for (let i = 0; i < chunks.length; i += 1) {
			sent.push(
				await this.sendMessage({
					...params,
					text: chunks[i]!,
					reply_to_message_id: i === 0 ? params.reply_to_message_id : undefined,
				}),
			);
		}
		return sent;
	}
}

export interface NetworkFailure {
	/** Human-readable chain, e.g. "fetch failed <- read ECONNRESET [ECONNRESET]". */
	description: string;
	/** Lowest-level errno, e.g. ECONNRESET, ETIMEDOUT, EAI_AGAIN. */
	code?: string;
}

/**
 * Flatten a Node/undici fetch failure into something a human can act on.
 *
 * `fetch` reports every transport problem as the opaque "fetch failed"; the real
 * reason (`ECONNRESET`, `ETIMEDOUT`, `EAI_AGAIN`, TLS errors) is buried in the
 * `cause` chain. Losing it is why a blocked VPN route looked like a module bug.
 */
export function describeNetworkFailure(err: unknown): NetworkFailure {
	const parts: string[] = [];
	let code: string | undefined;
	let current: unknown = err;
	for (let depth = 0; depth < 5 && current !== undefined && current !== null; depth += 1) {
		if (current instanceof Error) {
			const errno = (current as NodeJS.ErrnoException).code;
			if (errno && code === undefined) code = errno;
			parts.push(errno ? `${current.message} [${errno}]` : current.message);
			current = (current as { cause?: unknown }).cause;
		} else {
			parts.push(String(current));
			break;
		}
	}
	const description = parts.join(" <- ") || String(err);
	if (code === undefined && /timed out|aborted/i.test(description)) code = "ETIMEDOUT";
	return { description, code };
}
