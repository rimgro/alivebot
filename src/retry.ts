/**
 * One retry helper for every outbound network call in the runtime.
 *
 * Before this module each call site rolled its own policy: the worker manager
 * retried linearly with no log line, the Telegram poll loop slept with a wide
 * jitter, outbound messages were not retried at all, and memory embeddings gave
 * up on the first `fetch failed`. The result was the same network hiccup either
 * costing a whole run or being retried invisibly.
 *
 * The policy here is deliberately small and uniform:
 *
 * - exponential backoff, full jitter (uniform in `[0, cap]`), capped delay;
 * - an HTTP `Retry-After` / Telegram `retry_after` overrides the backoff;
 * - abort wins: an aborted signal is never retried and interrupts a backoff;
 * - one warn line per retry so the log always answers "how many attempts?":
 *   `retry 2/4 after 1.8s: ECONNRESET`.
 *
 * Classification is not duplicated: {@link classifyNetworkError} flattens the
 * Node/undici error chain into text and delegates to the worker provider
 * classifier in `src/workers/retry.ts`, which already encodes "auth/quota/model
 * problems are not transient".
 */
import { formatDuration, oneLine, sleep } from "./util.js";
import { isPermanentProviderError, isTransientProviderError } from "./workers/retry.js";

/** Defaults for {@link withRetries}: four attempts, 0.5s → 15s exponential. */
export const RETRY_DEFAULTS = {
	attempts: 4,
	baseDelayMs: 500,
	maxDelayMs: 15_000,
	jitter: "full",
} as const;

/**
 * A provider-specified `retry_after` wins over the computed backoff, but never
 * beyond this ceiling: one broken server must not park a run for ten minutes.
 */
export const MAX_RETRY_AFTER_MS = 60_000;

/** `full` = uniform in `[0, cap]`; `none` = exactly the exponential cap. */
export type RetryJitter = "full" | "none";

/** Minimal logger shape; a `Logger` from `src/log.ts` satisfies it. */
export interface RetryLogger {
	warn(message: string, data?: unknown): void;
}

export interface RetryAttemptInfo {
	/** 1-based number of the attempt that is about to start. */
	attempt: number;
	/** Total attempts allowed. */
	attempts: number;
}

export interface RetryOptions {
	/** Total attempts, including the first one. */
	attempts?: number;
	/** Delay before the second attempt; doubles for each further one. */
	baseDelayMs?: number;
	/** Ceiling for one computed backoff. */
	maxDelayMs?: number;
	jitter?: RetryJitter;
	/** Extra gate on top of the network classification (e.g. "only idempotent calls"). */
	shouldRetry?: (error: unknown) => boolean;
	/** Call-site name for the structured log record, e.g. `telegram getUpdates`. */
	label?: string;
	/** When present, one warn line per retry is emitted. */
	log?: RetryLogger;
	/** Abort never retried, and interrupts an in-flight backoff. */
	signal?: AbortSignal;
	/** Called before every attempt; used to count attempts in run records. */
	onAttempt?: (info: RetryAttemptInfo) => void;
}

export interface NetworkErrorClassification {
	/** True when another attempt may succeed. */
	transient: boolean;
	/** Lowest-level errno, e.g. `ECONNRESET`, `ETIMEDOUT`, `EAI_AGAIN`. */
	code?: string;
	/** HTTP status when the failure is an API response (401, 429, 503, ...). */
	status?: number;
	/** Provider-requested wait before the next attempt, in milliseconds. */
	retryAfterMs?: number;
	/** Short, secret-free reason for a log line (`ECONNRESET`, `HTTP 429`, ...). */
	reason: string;
}

const MAX_ERROR_CHAIN_DEPTH = 6;
/** Errno-shaped codes only; a provider's own string code (`http_error`) is not an errno. */
const ERRNO_CODE = /^E[A-Z0-9_]+$/;

/**
 * Classify a failure as retryable or not.
 *
 * Transient: timeouts, connection resets/refusals, DNS hiccups, `fetch failed`,
 * `socket hang up`, 408/425/429/5xx, provider overload/rate-limit markers.
 * Permanent: 401/403, 400/422 and other 4xx, quota/billing, model-not-found,
 * invalid request, content policy, and every abort.
 */
export function classifyNetworkError(error: unknown): NetworkErrorClassification {
	if (isAbortError(error)) {
		const reason = reasonFrom(error);
		return { transient: false, reason: reason === "unknown error" ? "aborted" : reason };
	}
	const details = errorDetails(error);
	const status = details.status;
	const text = [
		details.messages.join(" <- "),
		details.code,
		status !== undefined ? `HTTP ${status}` : undefined,
	]
		.filter((part): part is string => typeof part === "string" && part.length > 0)
		.join(" ");
	// A status is authoritative for the few codes the textual classifier cannot
	// know about (408 and 425 are timeouts, not request-shape errors).
	const statusTransient = status === 408 || status === 425 || status === 429 || (status !== undefined && status >= 500);
	const transient = !isPermanentProviderError(text) && (isTransientProviderError(text) || statusTransient);
	const classification: NetworkErrorClassification = {
		transient,
		reason: reasonFrom(error, details, status),
	};
	if (details.code) classification.code = details.code;
	if (status !== undefined) classification.status = status;
	if (details.retryAfterMs !== undefined) classification.retryAfterMs = details.retryAfterMs;
	return classification;
}

/** Convenience predicate for `if (isRetryableNetworkError(err))`. */
export function isRetryableNetworkError(error: unknown): boolean {
	return classifyNetworkError(error).transient;
}

/** Abort errors are never retried, whatever else they look like. */
export function isAbortError(error: unknown): boolean {
	return (
		(error instanceof Error && error.name === "AbortError") ||
		(typeof DOMException !== "undefined" && error instanceof DOMException && error.name === "AbortError")
	);
}

/**
 * Delay before `attempt` (1 = the first retry), exponential with full jitter.
 *
 * `random` is injectable so tests can pin the jitter bounds without touching the
 * public options.
 */
export function retryDelayMs(
	attempt: number,
	options: { baseDelayMs?: number; maxDelayMs?: number; jitter?: RetryJitter } = {},
	random: () => number = Math.random,
): number {
	const base = positive(options.baseDelayMs, RETRY_DEFAULTS.baseDelayMs);
	const max = positive(options.maxDelayMs, RETRY_DEFAULTS.maxDelayMs);
	const step = Math.max(1, Math.floor(Number.isFinite(attempt) ? attempt : 1));
	const exponential = Math.min(max, base * 2 ** Math.min(step - 1, 30));
	if ((options.jitter ?? RETRY_DEFAULTS.jitter) === "none") return Math.round(exponential);
	const unit = Math.min(Math.max(random(), 0), 1);
	return Math.round(unit * exponential);
}

/**
 * The canonical retry log line, e.g. `retry 2/4 after 1.8s: ECONNRESET`.
 *
 * It intentionally carries no URL, token or response body: `reason` is the
 * sanitized classification reason, never a raw provider message.
 */
export function formatRetryLogLine(info: { attempt: number; attempts: number; delayMs: number; reason: string }): string {
	return `retry ${info.attempt}/${info.attempts} after ${formatDuration(info.delayMs)}: ${info.reason}`;
}

/**
 * Run `operation` with retries.
 *
 * The operation receives the 1-based attempt number and the abort signal. A
 * returned value wins; a thrown error is retried when classification says it is
 * transient (and `shouldRetry`, if given, agrees) and attempts remain.
 */
export async function withRetries<T>(
	operation: (attempt: number, signal?: AbortSignal) => Promise<T> | T,
	options: RetryOptions = {},
): Promise<T> {
	const attempts = Math.max(1, Math.floor(positive(options.attempts, RETRY_DEFAULTS.attempts)));
	const baseDelayMs = positive(options.baseDelayMs, RETRY_DEFAULTS.baseDelayMs);
	const maxDelayMs = positive(options.maxDelayMs, RETRY_DEFAULTS.maxDelayMs);
	const jitter = options.jitter ?? RETRY_DEFAULTS.jitter;
	const signal = options.signal;
	if (signal?.aborted) throw abortReason(signal);

	let lastError: unknown;
	for (let attempt = 1; attempt <= attempts; attempt += 1) {
		options.onAttempt?.({ attempt, attempts });
		try {
			return await operation(attempt, signal);
		} catch (error) {
			lastError = error;
			if (signal?.aborted) throw abortReason(signal);
			if (attempt >= attempts) break;
			const classification = classifyNetworkError(error);
			if (!(options.shouldRetry ? options.shouldRetry(error) : classification.transient)) break;
			const delayMs = classification.retryAfterMs !== undefined
				? Math.min(classification.retryAfterMs, MAX_RETRY_AFTER_MS)
				: retryDelayMs(attempt, { baseDelayMs, maxDelayMs, jitter });
			// The retry line names the attempt that is about to run, matching the log
			// example in README: `retry 2/4 after 1.8s: ECONNRESET`.
			options.log?.warn(formatRetryLogLine({ attempt: attempt + 1, attempts, delayMs, reason: classification.reason }), {
				label: options.label,
				attempt: attempt + 1,
				attempts,
				delayMs,
				reason: classification.reason,
				...(classification.code ? { code: classification.code } : {}),
				...(classification.status !== undefined ? { status: classification.status } : {}),
				...(classification.retryAfterMs !== undefined ? { retryAfterMs: classification.retryAfterMs } : {}),
			});
			await sleep(delayMs, signal);
			if (signal?.aborted) throw abortReason(signal);
		}
	}
	throw lastError;
}

interface ErrorDetails {
	messages: string[];
	code?: string;
	status?: number;
	retryAfterMs?: number;
}

/** Flatten an error and its `cause` chain; fetch hides the real reason there. */
function errorDetails(error: unknown): ErrorDetails {
	const messages: string[] = [];
	let code: string | undefined;
	let status: number | undefined;
	let retryAfterMs: number | undefined;
	let current: unknown = error;
	for (let depth = 0; depth < MAX_ERROR_CHAIN_DEPTH && current !== undefined && current !== null; depth += 1) {
		if (current instanceof Error) {
			if (current.message) messages.push(current.message);
			const fields = current as Error & Record<string, unknown>;
			const errno = fields.code;
			if (code === undefined && typeof errno === "string" && ERRNO_CODE.test(errno.toUpperCase())) {
				code = errno.toUpperCase();
			}
			status ??= numericStatus(fields.status) ?? numericStatus(fields.statusCode) ?? numericStatus(fields.errorCode);
			const response = fields.response;
			if (response && typeof response === "object") status ??= numericStatus((response as { status?: unknown }).status);
			retryAfterMs ??= retryAfter(fields);
			current = fields.cause;
		} else {
			messages.push(String(current));
			break;
		}
	}
	return { messages, code, status, retryAfterMs };
}

/** Accept only plausible HTTP statuses; `errorCode` is also used for non-HTTP codes. */
function numericStatus(value: unknown): number | undefined {
	const status = typeof value === "string" ? Number(value) : value;
	return typeof status === "number" && Number.isInteger(status) && status >= 100 && status <= 599 ? status : undefined;
}

/** `Retry-After` in seconds, the Telegram `retry_after` field, or an explicit ms field. */
function retryAfter(fields: Record<string, unknown>): number | undefined {
	const seconds = fields.retryAfterSec ?? fields.retry_after ?? fields.retryAfter;
	if (typeof seconds === "number" && Number.isFinite(seconds) && seconds >= 0) return Math.round(seconds * 1000);
	const explicitMs = fields.retryAfterMs ?? fields.retry_after_ms;
	if (typeof explicitMs === "number" && Number.isFinite(explicitMs) && explicitMs >= 0) return Math.round(explicitMs);
	const parameters = fields.parameters;
	if (parameters && typeof parameters === "object") {
		const nested = (parameters as { retry_after?: unknown }).retry_after;
		if (typeof nested === "number" && Number.isFinite(nested) && nested >= 0) return Math.round(nested * 1000);
	}
	const header = fields.retryAfterHeader ?? fields["retry-after"];
	if (typeof header === "string" && /^\d+$/.test(header.trim())) return Number(header.trim()) * 1000;
	return undefined;
}

/**
 * Short, secret-free reason. Prefer the errno, then the status, then a sanitized
 * one-line message: a provider body must never end up in the log.
 */
function reasonFrom(error: unknown, details?: ErrorDetails, status?: number): string {
	const info = details ?? errorDetails(error);
	if (info.code) return info.code;
	if (status !== undefined) return `HTTP ${status}`;
	const message = sanitizeReason(info.messages[0] ?? (error instanceof Error ? error.message : String(error)));
	return message || "unknown error";
}

function sanitizeReason(text: string): string {
	return oneLine(
		text
			// Bot API URLs carry the token in the path: `.../bot123:ABC/getUpdates`.
			.replace(/bot\d+:[A-Za-z0-9_-]+/g, "bot<redacted>")
			.replace(/\bBearer\s+[^\s,;]+/gi, "Bearer <redacted>")
			.replace(/\bhttps?:\/\/\S+/gi, "<url>")
			.replace(/\b[A-Za-z0-9_-]{40,}\b/g, "<redacted>"),
		160,
	);
}

function positive(value: number | undefined, fallback: number): number {
	return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : fallback;
}

function abortReason(signal: AbortSignal): unknown {
	const reason = signal.reason;
	return reason === undefined || reason === null ? Object.assign(new Error("the operation was aborted"), { name: "AbortError" }) : reason;
}
