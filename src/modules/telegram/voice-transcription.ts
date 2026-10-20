export const GROQ_TRANSCRIPTION_ENDPOINT = "https://api.groq.com/openai/v1/audio/transcriptions";
export const GROQ_TRANSCRIPTION_MODEL = "whisper-large-v3-turbo";
export const TELEGRAM_VOICE_MAX_BYTES = 20 * 1024 * 1024;
export const GROQ_TRANSCRIPTION_TIMEOUT_MS = 30_000;

export type GroqTranscriptionErrorCode = "missing_api_key" | "too_large" | "request_failed" | "timeout" | "http_error" | "invalid_response";

/** A safe-to-log error: never contains the request URL, authorization header, or provider response body. */
export class GroqTranscriptionError extends Error {
	readonly code: GroqTranscriptionErrorCode;
	readonly status?: number;

	constructor(code: GroqTranscriptionErrorCode, status?: number) {
		super(code === "http_error" && status !== undefined ? `Groq transcription returned HTTP ${status}` : `Groq transcription ${code.replaceAll("_", " ")}`);
		this.name = "GroqTranscriptionError";
		this.code = code;
		this.status = status;
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
		// Cancel the body so a long-lived process never pins a socket to a rejected request.
		await response.body?.cancel().catch(() => undefined);
		throw new GroqTranscriptionError("http_error", response.status);
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
