export const GROQ_TRANSCRIPTION_ENDPOINT = "https://api.groq.com/openai/v1/audio/transcriptions";
export const GROQ_TRANSCRIPTION_MODEL = "whisper-large-v3-turbo";
export const TELEGRAM_VOICE_MAX_BYTES = 20 * 1024 * 1024;
export const GROQ_TRANSCRIPTION_TIMEOUT_MS = 30_000;
/**
 * A 429 is retried only when the provider asks us to come back within this
 * budget. "Try again in 2h" is not a transient failure: retrying it burns the
 * daily quota for nothing (incident #117).
 */
export const GROQ_TRANSCRIPTION_MAX_RETRY_AFTER_MS = 10_000;
/** Error bodies are read only to classify the failure; never logged, never kept. */
const GROQ_ERROR_BODY_LIMIT = 2_048;

export type GroqTranscriptionErrorCode = "missing_api_key" | "too_large" | "request_failed" | "timeout" | "http_error" | "invalid_response";

/**
 * Why a transcription failed, reduced to the classes that decide retries and
 * the wording of the single summary line.
 */
export type TranscriptionFailureClass =
	| "aborted"
	| "timeout"
	| "network"
	| "provider_unavailable"
	| "rate_limit"
	| "auth"
	| "daily_quota"
	| "unsupported"
	| "too_large"
	| "invalid_response"
	| "unknown";

/** A classified failure: safe to log, safe to put in an event annotation. */
export interface TranscriptionFailure {
	readonly class: TranscriptionFailureClass;
	/** Short, secret-free reason. Never contains the key, URL or a provider body. */
	readonly reason: string;
	/** Worth another attempt (timeout, reset connection, 5xx, short 429). */
	readonly retryable: boolean;
	/** The provider reported exhausted daily quota/credit: stop for the rest of the day. */
	readonly dailyQuota: boolean;
	/** Provider-requested wait before the next attempt (429 `retry-after`). */
	readonly retryAfterMs?: number;
}

/** A safe-to-log error: never contains the request URL, authorization header, or provider response body. */
export class GroqTranscriptionError extends Error {
	readonly code: GroqTranscriptionErrorCode;
	readonly status?: number;
	/** Classification of this failure; the retry policy reads only this. */
	readonly failure: TranscriptionFailure;

	constructor(code: GroqTranscriptionErrorCode, status?: number, details: Partial<TranscriptionFailure> = {}) {
		super(code === "http_error" && status !== undefined ? `Groq transcription returned HTTP ${status}` : `Groq transcription ${code.replaceAll("_", " ")}`);
		this.name = "GroqTranscriptionError";
		this.code = code;
		this.status = status;
		this.failure = { ...defaultFailure(code, status), ...stripUndefined(details) };
	}
}

export interface GroqTranscriptionOptions {
	apiKey: string;
	audio: Uint8Array;
	mimeType?: string;
	model?: string;
	maxBytes?: number;
	timeoutMs?: number;
	signal?: AbortSignal;
	fetchImpl?: typeof fetch;
}

/** Send a bounded voice recording to Groq's OpenAI-compatible Whisper endpoint. */
export async function transcribeWithGroq(options: GroqTranscriptionOptions): Promise<string> {
	if (!options.apiKey.trim()) throw new GroqTranscriptionError("missing_api_key");
	if (options.audio.byteLength > (options.maxBytes ?? TELEGRAM_VOICE_MAX_BYTES)) throw new GroqTranscriptionError("too_large");

	const model = options.model ?? GROQ_TRANSCRIPTION_MODEL;
	const mimeType = normalizeAudioMime(options.mimeType);
	const form = new FormData();
	// Copy into a tightly-sized ArrayBuffer so Blob does not retain a larger pooled Buffer backing store.
	const bytes = Uint8Array.from(options.audio);
	form.append("file", new Blob([bytes.buffer], { type: mimeType }), `telegram-voice.${extensionForMime(mimeType)}`);
	form.append("model", model);
	form.append("response_format", "json");

	const timeoutSignal = AbortSignal.timeout(options.timeoutMs ?? GROQ_TRANSCRIPTION_TIMEOUT_MS);
	const signal = options.signal ? AbortSignal.any([options.signal, timeoutSignal]) : timeoutSignal;
	let response: Response;
	try {
		response = await (options.fetchImpl ?? fetch)(GROQ_TRANSCRIPTION_ENDPOINT, {
			method: "POST",
			headers: { authorization: `Bearer ${options.apiKey}` },
			body: form,
			signal,
		});
	} catch (err) {
		// Do not forward fetch errors: runtimes may include request details in them.
		if (err instanceof Error && (err.name === "AbortError" || err.name === "TimeoutError")) {
			throw new GroqTranscriptionError("timeout");
		}
		throw new GroqTranscriptionError("request_failed");
	}

	if (!response.ok) {
		// Read a small, bounded slice of the body to classify the rejection (quota
		// markers, retry-after) and drop it: it is never logged or stored. Reading
		// also releases the socket instead of pinning it to a rejected request.
		const body = await readErrorBody(response);
		throw new GroqTranscriptionError("http_error", response.status, classifyProviderRejection(response.status, response.headers, body));
	}
	let payload: unknown;
	try {
		payload = await response.json();
	} catch {
		throw new GroqTranscriptionError("invalid_response");
	}
	if (!payload || typeof payload !== "object" || typeof (payload as { text?: unknown }).text !== "string") {
		throw new GroqTranscriptionError("invalid_response");
	}
	return (payload as { text: string }).text.trim();
}

/**
 * Classify any error thrown while fetching/transcribing one voice note.
 *
 * Only the failure facts are used: a provider body, the request URL and the key
 * never enter the returned value, so callers may log it and annotate events.
 */
export function classifyTranscriptionFailure(err: unknown, options: { aborted?: boolean } = {}): TranscriptionFailure {
	if (err instanceof GroqTranscriptionError) return err.failure;
	if (options.aborted || (err instanceof Error && err.name === "AbortError")) {
		return { class: "aborted", reason: "transcription cancelled", retryable: false, dailyQuota: false };
	}
	if (err instanceof Error && err.name === "TimeoutError") {
		return { class: "timeout", reason: "request timed out", retryable: true, dailyQuota: false };
	}
	return { class: "unknown", reason: "request failed", retryable: false, dailyQuota: false };
}

/** Classify an HTTP rejection of the transcription request. */
function classifyProviderRejection(status: number, headers: Headers, body: string): Partial<TranscriptionFailure> {
	const retryAfterMs = parseRetryAfterMs(headers.get("retry-after"), body);
	if (status >= 400 && status < 500 && hasDailyQuotaMarker(body)) {
		return { class: "daily_quota", reason: "Groq daily quota exhausted", retryable: false, dailyQuota: true, retryAfterMs };
	}
	if (status === 429) {
		// A long retry-after is not a transient failure: do not spend attempts on it.
		if (retryAfterMs !== undefined && retryAfterMs > GROQ_TRANSCRIPTION_MAX_RETRY_AFTER_MS) {
			return { class: "rate_limit", reason: "Groq rate limit (retry-after exceeds the retry budget)", retryable: false, retryAfterMs };
		}
		return { class: "rate_limit", reason: "Groq returned HTTP 429 (rate limit)", retryable: true, retryAfterMs };
	}
	if (status === 408) return { class: "timeout", reason: "Groq returned HTTP 408 (timeout)", retryable: true };
	if (status >= 500) return { class: "provider_unavailable", reason: `Groq returned HTTP ${status}`, retryable: true };
	return {};
}

/** Marker list covers Groq/OpenAI daily limits ("requests per day (RPD)", TPD, insufficient_quota). */
const DAILY_QUOTA_MARKER = /insufficient_quota|exceeded your current quota|requests per day|\brpd\b|\btpd\b|\bdaily\b|per[- ]day/i;

function hasDailyQuotaMarker(body: string): boolean {
	return DAILY_QUOTA_MARKER.test(body);
}

/** `retry-after` may be seconds or an HTTP date; Groq bodies also say "try again in 7.66s". */
function parseRetryAfterMs(header: string | null, body: string): number | undefined {
	const trimmed = header?.trim();
	if (trimmed) {
		if (/^\d+(?:\.\d+)?$/.test(trimmed)) return Math.round(Number(trimmed) * 1000);
		const date = Date.parse(trimmed);
		if (!Number.isNaN(date)) return Math.max(0, date - Date.now());
	}
	const match = /try again in\s+([\d.]+)\s*(ms|s|m|h)\b/i.exec(body);
	if (!match) return undefined;
	const value = Number(match[1]);
	if (!Number.isFinite(value)) return undefined;
	const unit = match[2].toLowerCase();
	const factor = unit === "ms" ? 1 : unit === "s" ? 1000 : unit === "m" ? 60_000 : 3_600_000;
	return Math.round(value * factor);
}

/** Read at most `GROQ_ERROR_BODY_LIMIT` bytes of a rejected response, then cancel it. */
async function readErrorBody(response: Response): Promise<string> {
	const body = response.body;
	if (!body) return "";
	const reader = body.getReader();
	const chunks: Uint8Array[] = [];
	let total = 0;
	try {
		while (total < GROQ_ERROR_BODY_LIMIT) {
			const { done, value } = await reader.read();
			if (done) break;
			if (!value) continue;
			chunks.push(value);
			total += value.byteLength;
		}
	} catch {
		return "";
	} finally {
		await reader.cancel().catch(() => undefined);
	}
	const merged = new Uint8Array(chunks.reduce((sum, chunk) => sum + chunk.byteLength, 0));
	let offset = 0;
	for (const chunk of chunks) {
		merged.set(chunk, offset);
		offset += chunk.byteLength;
	}
	return new TextDecoder().decode(merged).slice(0, GROQ_ERROR_BODY_LIMIT);
}

function defaultFailure(code: GroqTranscriptionErrorCode, status?: number): TranscriptionFailure {
	switch (code) {
		case "missing_api_key":
			return { class: "auth", reason: "Groq request failed", retryable: false, dailyQuota: false };
		case "too_large":
			return { class: "too_large", reason: "audio exceeds the Groq size limit", retryable: false, dailyQuota: false };
		case "timeout":
			return { class: "timeout", reason: "Groq request timed out", retryable: true, dailyQuota: false };
		case "request_failed":
			// A reset connection, DNS blip or proxy hiccup: worth a bounded retry.
			return { class: "network", reason: "Groq request failed", retryable: true, dailyQuota: false };
		case "invalid_response":
			return { class: "invalid_response", reason: "Groq returned an unreadable response", retryable: false, dailyQuota: false };
		case "http_error":
			return failureForStatus(status);
	}
}

function failureForStatus(status?: number): TranscriptionFailure {
	const reason = status === undefined ? "Groq request failed" : `Groq returned HTTP ${status}`;
	if (status === undefined) return { class: "unknown", reason, retryable: false, dailyQuota: false };
	// Auth and quota problems are never retried; neither is a request the
	// provider already rejected as unsupported.
	if (status === 401 || status === 403) return { class: "auth", reason, retryable: false, dailyQuota: false };
	if (status === 413) return { class: "too_large", reason, retryable: false, dailyQuota: false };
	if (status === 429) return { class: "rate_limit", reason, retryable: true, dailyQuota: false };
	if (status >= 500) return { class: "provider_unavailable", reason, retryable: true, dailyQuota: false };
	if (status === 408) return { class: "timeout", reason, retryable: true, dailyQuota: false };
	if (status >= 400) return { class: "unsupported", reason, retryable: false, dailyQuota: false };
	return { class: "unknown", reason, retryable: false, dailyQuota: false };
}

function stripUndefined(details: Partial<TranscriptionFailure>): Partial<TranscriptionFailure> {
	return Object.fromEntries(Object.entries(details).filter(([, value]) => value !== undefined)) as Partial<TranscriptionFailure>;
}

function normalizeAudioMime(value?: string): string {
	const mime = value?.split(";", 1)[0]?.trim().toLowerCase();
	return mime?.startsWith("audio/") ? mime : "audio/ogg";
}

function extensionForMime(mime: string): string {
	switch (mime) {
		case "audio/mpeg":
		case "audio/mp3":
			return "mp3";
		case "audio/mp4":
			return "m4a";
		case "audio/wav":
		case "audio/x-wav":
			return "wav";
		case "audio/webm":
			return "webm";
		case "audio/flac":
			return "flac";
		default:
			return "ogg";
	}
}
