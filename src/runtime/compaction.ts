/**
 * Robust auto-compaction summarization (#167).
 *
 * Pi decides when to compact and writes the compaction checkpoint itself. The
 * only thing it expects from the model is a summary. When an upstream proxy,
 * captive portal or provider error page answers that request with HTML (or an
 * error JSON object), pi used to accept the body as the summary and replace a
 * large context with garbage — or worse, with an empty checkpoint — so every
 * following turn kept the context growing while paying for it again.
 *
 * This module wraps the session's provider stream function and validates only
 * the *summarization* calls (`completeSummarization` in pi):
 *
 * - a response that is HTML, JSON-looking but not a summary, empty, a tool call
 *   or a truncated (`length`) response is a failed compaction, never a summary;
 * - the failure is retried through the shared {@link withRetries} helper with a
 *   bounded attempt budget; 401/403 and other permanent classes fail at once;
 * - after a transient failure the next compaction attempt is deferred with a
 *   capped exponential backoff (pi calls back on every following turn); the
 *   previous context stays untouched because pi only appends the checkpoint
 *   after `compact()` resolves successfully.
 *
 * The wrapper throws instead of returning an error assistant message, so pi's
 * own summarization retry helper cannot add a second, unbounded retry loop.
 *
 * The last outcome is exposed through a {@link CompactionMonitor} (looked up by
 * session) for the run record, runtime status and the `compaction_failed` anomaly.
 */
import type { StreamFn } from "@earendil-works/pi-agent-core";
import {
	contentText,
	createAssistantMessageEventStream,
	type AssistantMessage,
	type Context,
	type Model,
	type SimpleStreamOptions,
	type StopReason,
} from "@earendil-works/pi-ai";
import type { AgentSession } from "@earendil-works/pi-coding-agent";
import { classifyNetworkError, RETRY_DEFAULTS, withRetries, type RetryLogger, type RetryOptions } from "../retry.js";
import type { CompactionFailureClass, CompactionRecord } from "../store/runs.js";
import { oneLine } from "../util.js";

export type { CompactionFailureClass, CompactionRecord } from "../store/runs.js";

/** Bounded provider attempts for one summarization call. */
export const COMPACTION_RETRY_ATTEMPTS = 3;
export const COMPACTION_RETRY_BASE_MS = 750;
export const COMPACTION_RETRY_MAX_DELAY_MS = 15_000;

/** Cross-turn backoff after a transient failure: 30 s → 15 min. */
export const COMPACTION_BACKOFF_BASE_MS = 30_000;
export const COMPACTION_BACKOFF_MAX_MS = 15 * 60_000;

/** How much of a provider body is kept for the one diagnostic log line. */
export const COMPACTION_EXCERPT_CHARS = 200;
/** Shortest body treated as a usable summary; an empty/near-empty checkpoint is not one. */
export const COMPACTION_MIN_SUMMARY_CHARS = 16;

const MONITOR = new WeakMap<object, CompactionMonitor>();
const SUMMARIZATION_SYSTEM_PREFIX = "You are a context summarization assistant.";

export interface CompactionOutcome extends CompactionRecord {
	/** Masked, one-line excerpt of the rejected provider body; log-only, never persisted. */
	excerpt?: string;
}

export interface CompactionGuardOptions {
	/** Retry log sink; retries are logged by {@link withRetries}. */
	log?: RetryLogger;
	/** Mask configured secrets before an excerpt reaches the log. */
	mask?: (text: string) => string;
	/** Override the bounded retry policy (tests use millisecond delays). */
	retry?: Pick<RetryOptions, "attempts" | "baseDelayMs" | "maxDelayMs" | "jitter">;
	/** Context size (pi's prompt estimate) at the time of an attempt. */
	contextTokens?: () => number;
	/** Clock seam for tests. */
	now?: () => number;
}

/** A compaction response that must not become a session checkpoint. */
export class CompactionFailure extends Error {
	readonly reasonClass: CompactionFailureClass;
	readonly reason: string;
	readonly retryable: boolean;
	readonly excerpt?: string;
	readonly status?: number;
	/** Satisfies the retry classifier's errno shape without exposing the body. */
	readonly code: string;

	constructor(input: {
		reasonClass: CompactionFailureClass;
		reason: string;
		retryable: boolean;
		excerpt?: string;
		status?: number;
	}) {
		super(`${input.reasonClass}: ${input.reason}`);
		this.name = "CompactionFailure";
		this.reasonClass = input.reasonClass;
		this.reason = input.reason;
		this.retryable = input.retryable;
		this.excerpt = input.excerpt;
		this.status = input.status;
		this.code = input.reasonClass === "provider_html"
			? "E_PROVIDER_HTML"
			: input.reasonClass === "provider_json_invalid"
				? "E_PROVIDER_JSON_INVALID"
				: "E_PROVIDER_ERROR";
	}
}

/** True when a context is pi's one-shot conversation summarization request. */
export function isSummarizationContext(context: Context | undefined): boolean {
	return typeof context?.systemPrompt === "string" && context.systemPrompt.startsWith(SUMMARIZATION_SYSTEM_PREFIX);
}

/**
 * Classify an arbitrary provider body or error text.
 *
 * HTML is checked first: an error page can contain `{` or the word "error", and
 * it must never be mistaken for a summary or a JSON error object.
 */
export function classifyCompactionText(text: string | undefined, status?: number): CompactionFailure {
	const body = typeof text === "string" ? text : "";
	const excerpt = excerptOf(body);
	if (looksLikeHtml(body)) {
		return new CompactionFailure({
			reasonClass: "provider_html",
			reason: status ? `provider returned an HTML page (HTTP ${status})` : "provider returned an HTML page",
			retryable: retryableStatus(status) ?? true,
			excerpt,
			status,
		});
	}
	if (looksLikeJsonFailure(body)) {
		return new CompactionFailure({
			reasonClass: "provider_json_invalid",
			reason: status ? `provider returned a non-summary JSON body (HTTP ${status})` : "provider returned a non-summary JSON body",
			retryable: retryableStatus(status) ?? false,
			excerpt,
			status,
		});
	}
	const trimmed = body.trim();
	if (!trimmed) {
		return new CompactionFailure({
			reasonClass: "provider_error",
			reason: status ? `provider returned an empty summary (HTTP ${status})` : "provider returned an empty summary",
			retryable: retryableStatus(status) ?? false,
			excerpt,
			status,
		});
	}
	if (trimmed.length < COMPACTION_MIN_SUMMARY_CHARS) {
		return new CompactionFailure({
			reasonClass: "provider_error",
			reason: `provider summary is too short (${trimmed.length} chars)`,
			retryable: false,
			excerpt,
			status,
		});
	}
	return new CompactionFailure({
		reasonClass: "provider_error",
		reason: status ? `provider returned an unusable compaction response (HTTP ${status})` : "provider returned an unusable compaction response",
		retryable: retryableStatus(status) ?? false,
		excerpt,
		status,
	});
}

/** Classify a thrown provider/transport error. */
export function compactionFailureFromError(error: unknown, status?: number): CompactionFailure {
	if (error instanceof CompactionFailure) {
		if (status === undefined || error.status !== undefined) return error;
		return new CompactionFailure({
			reasonClass: error.reasonClass,
			reason: error.reason,
			retryable: error.retryable,
			excerpt: error.excerpt,
			status,
		});
	}
	const text = errorText(error);
	const classification = classifyNetworkError(error);
	const effectiveStatus = status ?? classification.status;
	if (looksLikeHtml(text)) {
		return new CompactionFailure({
			reasonClass: "provider_html",
			reason: effectiveStatus ? `provider returned an HTML page (HTTP ${effectiveStatus})` : "provider returned an HTML page",
			retryable: retryableStatus(effectiveStatus) ?? true,
			excerpt: excerptOf(text),
			status: effectiveStatus,
		});
	}
	if (looksLikeJsonFailure(text) || /not valid json|json parse|unexpected token|unexpected end of json|end of json/i.test(text)) {
		return new CompactionFailure({
			reasonClass: "provider_json_invalid",
			reason: effectiveStatus ? `provider returned a non-summary JSON body (HTTP ${effectiveStatus})` : "provider returned a non-summary JSON body",
			retryable: retryableStatus(effectiveStatus) ?? classification.transient,
			excerpt: excerptOf(text),
			status: effectiveStatus,
		});
	}
	return new CompactionFailure({
		reasonClass: "provider_error",
		reason: classification.reason || "compaction provider call failed",
		retryable: retryableStatus(effectiveStatus) ?? classification.transient,
		excerpt: excerptOf(text),
		status: effectiveStatus,
	});
}

/** Validate an assistant response returned for a summarization request. */
export function validateCompactionResponse(message: AssistantMessage, status?: number): void {
	if (!message || message.role !== "assistant") {
		throw classifyCompactionText("", status);
	}
	if (message.stopReason === "aborted") {
		throw new CompactionFailure({ reasonClass: "provider_error", reason: "compaction aborted", retryable: false, status });
	}
	if (message.stopReason === "error") {
		throw compactionFailureFromError(Object.assign(new Error(message.errorMessage || "provider error"), {
			...(status !== undefined ? { status } : {}),
		}), status);
	}
	if (message.stopReason === "length") {
		throw new CompactionFailure({
			reasonClass: "provider_error",
			reason: "summarization hit the token cap and the summary is incomplete",
			retryable: false,
			status,
		});
	}
	if (message.content.some((block) => block.type === "toolCall")) {
		throw new CompactionFailure({
			reasonClass: "provider_error",
			reason: "summarization attempted to call a tool",
			retryable: false,
			excerpt: excerptOf(contentText(message.content)),
			status,
		});
	}
	const text = contentText(message.content);
	const failure = classifyCompactionText(text, status);
	if (failure.reasonClass !== "provider_error" || failure.reason.startsWith("provider returned an empty summary") || failure.reason.startsWith("provider summary is too short")) {
		throw failure;
	}
	// A genuine summary is free-form markdown, so the only remaining check is the
	// HTML/JSON/empty/truncated validation above. Do not reject ordinary prose.
}

/** Guard installed on one pi session. */
export class CompactionMonitor {
	private readonly options: CompactionGuardOptions;
	private outcome: CompactionOutcome | undefined;
	private consecutiveFailures = 0;
	private nextAttemptAt: number | undefined;
	private readonly now: () => number;

	constructor(options: CompactionGuardOptions = {}) {
		this.options = options;
		this.now = options.now ?? Date.now;
	}

	/** Latest outcome including the log-only excerpt. */
	last(): CompactionOutcome | undefined {
		return this.outcome
			? { ...this.outcome, ...(this.outcome.excerpt ? { excerpt: this.outcome.excerpt } : {}) }
			: undefined;
	}

	/** Persistable/status-safe outcome (no provider excerpt). */
	record(): CompactionRecord | undefined {
		if (!this.outcome) return undefined;
		const { excerpt: _excerpt, ...record } = this.outcome;
		return { ...record };
	}

	/** Update the context size of the latest outcome (pi knows it after the call). */
	noteContextTokens(tokens: number | undefined): void {
		if (!this.outcome || typeof tokens !== "number" || !Number.isFinite(tokens) || tokens <= 0) return;
		this.outcome = { ...this.outcome, contextTokens: Math.round(tokens) };
	}

	/** Run and validate one summarization provider call. */
	async summarize(
		previous: StreamFn,
		model: Model<any>,
		context: Context,
		options: SimpleStreamOptions | undefined,
	): Promise<AssistantMessage> {
		const now = this.now();
		if (this.nextAttemptAt !== undefined && now < this.nextAttemptAt) {
			const failure = new CompactionFailure({
				reasonClass: this.outcome?.reasonClass ?? "provider_error",
				reason: `compaction retry deferred until ${new Date(this.nextAttemptAt).toISOString()}`,
				retryable: false,
			});
			this.outcome = {
				at: now,
				ok: false,
				reasonClass: failure.reasonClass,
				reason: failure.reason,
				attempts: 0,
				maxAttempts: this.attempts(),
				contextTokens: this.contextTokens(),
				skipped: true,
				nextAttemptAt: this.nextAttemptAt,
			};
			throw failure;
		}

		const startedAt = now;
		let attempts = 0;
		try {
			const message = await withRetries(
				async (attempt) => {
					attempts = attempt;
					let status: number | undefined;
					const wrappedOptions = captureStatus(options, (value) => {
						status = value;
					});
					let response: AssistantMessage;
					try {
						const stream = await previous(model, context, wrappedOptions);
						response = await stream.result();
					} catch (error) {
						throw this.masked(compactionFailureFromError(error, status));
					}
					try {
						validateCompactionResponse(response, status);
					} catch (error) {
						throw this.masked(compactionFailureFromError(error, status));
					}
					return response;
				},
				{
					attempts: this.attempts(),
					baseDelayMs: this.options.retry?.baseDelayMs ?? COMPACTION_RETRY_BASE_MS,
					maxDelayMs: this.options.retry?.maxDelayMs ?? COMPACTION_RETRY_MAX_DELAY_MS,
					jitter: this.options.retry?.jitter,
					label: "compaction summarization",
					log: this.options.log,
					signal: options?.signal,
					shouldRetry: (error) => isRetryableCompactionFailure(error),
				},
			);
			this.consecutiveFailures = 0;
			this.nextAttemptAt = undefined;
			this.outcome = {
				at: this.now(),
				ok: true,
				attempts,
				maxAttempts: this.attempts(),
				contextTokens: this.contextTokens(),
				durationMs: Math.max(0, this.now() - startedAt),
			};
			return message;
		} catch (error) {
			const failure = this.masked(compactionFailureFromError(error));
			this.consecutiveFailures += 1;
			const delayMs = Math.min(
				COMPACTION_BACKOFF_MAX_MS,
				COMPACTION_BACKOFF_BASE_MS * 2 ** Math.min(this.consecutiveFailures - 1, 20),
			);
			this.nextAttemptAt = this.now() + delayMs;
			this.outcome = {
				at: this.now(),
				ok: false,
				reasonClass: failure.reasonClass,
				reason: failure.reason,
				excerpt: failure.excerpt,
				attempts,
				maxAttempts: this.attempts(),
				contextTokens: this.contextTokens(),
				nextAttemptAt: this.nextAttemptAt,
				durationMs: Math.max(0, this.now() - startedAt),
			};
			throw failure;
		}
	}

	private attempts(): number {
		return Math.max(1, Math.floor(this.options.retry?.attempts ?? COMPACTION_RETRY_ATTEMPTS));
	}

	/** Apply the configured secret mask to the log-only excerpt before it is stored. */
	private masked(failure: CompactionFailure): CompactionFailure {
		if (!this.options.mask || !failure.excerpt) return failure;
		return new CompactionFailure({
			reasonClass: failure.reasonClass,
			reason: failure.reason,
			retryable: failure.retryable,
			excerpt: this.options.mask(failure.excerpt),
			status: failure.status,
		});
	}

	private contextTokens(): number | undefined {
		try {
			const tokens = this.options.contextTokens?.();
			return typeof tokens === "number" && Number.isFinite(tokens) && tokens > 0 ? Math.round(tokens) : undefined;
		} catch {
			return undefined;
		}
	}
}

/**
 * Install the compaction guard on a pi session. Idempotent: a second call keeps
 * the existing monitor and wrapper. Returns the monitor for status wiring.
 */
export function installCompactionGuard(session: AgentSession, options: CompactionGuardOptions = {}): CompactionMonitor {
	const existing = MONITOR.get(session as unknown as object);
	if (existing) return existing;
	const monitor = new CompactionMonitor(options);
	const previous = session.agent.streamFunction;
	if (typeof previous !== "function") return monitor;
	session.agent.streamFunction = ((model: Model<any>, context: Context, streamOptions?: SimpleStreamOptions) => {
		if (!isSummarizationContext(context)) return previous(model, context, streamOptions);
		return guardedStream(monitor, previous, model, context, streamOptions);
	}) as StreamFn;
	MONITOR.set(session as unknown as object, monitor);
	return monitor;
}

/** The guard installed on this session, if any. */
export function compactionMonitorFor(session: AgentSession | undefined): CompactionMonitor | undefined {
	return session ? MONITOR.get(session as unknown as object) : undefined;
}

/**
 * Return an AssistantMessageEventStream whose `result()` is the promise of the
 * validated summarization call. Rejection is deliberate: pi's own
 * `retryAssistantCall` only inspects returned messages, so it cannot retry a
 * rejected call and the bounded policy above stays authoritative.
 */
function guardedStream(
	monitor: CompactionMonitor,
	previous: StreamFn,
	model: Model<any>,
	context: Context,
	options: SimpleStreamOptions | undefined,
): ReturnType<StreamFn> {
	const stream = createAssistantMessageEventStream();
	const result = monitor.summarize(previous, model, context, options);
	void result.then(
		(message) => {
			stream.push({
				type: "done",
				reason: message.stopReason as Extract<StopReason, "stop" | "length" | "toolUse" | "deferred">,
				message,
			});
		},
		(error: unknown) => {
			stream.push({ type: "error", reason: "error", error: errorMessageFor(error, model) });
		},
	);
	// Compaction only calls `result()`. Returning the rejecting promise here is
	// what keeps pi from treating a failed provider response as a summary.
	stream.result = () => result;
	return stream;
}

function errorMessageFor(error: unknown, model: Model<any>): AssistantMessage {
	return {
		role: "assistant",
		content: [],
		api: model.api,
		provider: model.provider,
		model: model.id,
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "error",
		errorMessage: error instanceof Error ? error.message : String(error),
		timestamp: Date.now(),
	};
}

function captureStatus(
	options: SimpleStreamOptions | undefined,
	onStatus: (status: number) => void,
): SimpleStreamOptions | undefined {
	if (!options) return options;
	const previous = options.onResponse;
	return {
		...options,
		onResponse: async (response, model) => {
			if (typeof response?.status === "number") onStatus(response.status);
			await previous?.(response, model);
		},
	};
}

function isRetryableCompactionFailure(error: unknown): boolean {
	if (error instanceof CompactionFailure) return error.retryable;
	return classifyNetworkError(error).transient;
}

function retryableStatus(status: number | undefined): boolean | undefined {
	if (status === undefined) return undefined;
	if (status === 408 || status === 425 || status === 429) return true;
	if (status >= 500) return true;
	if (status >= 400) return false;
	return undefined;
}

/** Tags that only appear in a real HTML document, never in a summary wrapper. */
const HTML_DOCUMENT_TAGS = /<\s*(?:html|head|body|script|style|title)\b|<\?xml\b|<!doctype\s+html/i;
/** Block-level tags used by error/proxy pages; a single one is already HTML. */
const HTML_BLOCK_TAGS = new Set([
	"div", "p", "h1", "h2", "h3", "h4", "h5", "h6", "table", "thead", "tbody", "tfoot", "tr", "td", "th",
	"ul", "ol", "li", "pre", "center", "blockquote", "form", "iframe", "noscript", "hr", "br", "meta", "link",
	"header", "footer", "main", "section", "article", "nav", "address", "dl", "dt", "dd",
]);
/** Inline tags that are suspicious when several distinct ones wrap the body. */
const HTML_INLINE_TAGS = new Set(["a", "span", "b", "i", "strong", "em", "font", "img", "input", "button", "label"]);

function looksLikeHtml(text: string): boolean {
	const trimmed = text.trim();
	if (!trimmed) return false;
	// A real document marker is decisive even when it is not at offset 0: an
	// error body is often prefixed by the provider/SDK message.
	if (HTML_DOCUMENT_TAGS.test(trimmed)) return true;
	const tags = new Set<string>();
	for (const match of trimmed.matchAll(/<\/?([a-z][a-z0-9-]*)\b[^>]*>/gi)) tags.add(match[1]!.toLowerCase());
	for (const tag of tags) {
		if (HTML_BLOCK_TAGS.has(tag)) return true;
	}
	let inline = 0;
	for (const tag of tags) if (HTML_INLINE_TAGS.has(tag)) inline += 1;
	// Two different inline tags wrapping the text are a page fragment, not a
	// markdown summary. A single `<summary>…</summary>` wrapper is accepted: pi
	// itself uses that wrapper for compaction summaries.
	return inline >= 2;
}

function looksLikeJsonFailure(text: string): boolean {
	const trimmed = text.trim();
	if (!trimmed) return false;
	if (!(trimmed.startsWith("{") || trimmed.startsWith("["))) return false;
	// A compaction summary is markdown, never a top-level JSON document, so a
	// syntactically valid JSON object is still an error body (e.g. {"error":...}).
	return true;
}

function errorText(error: unknown): string {
	const parts: string[] = [];
	let current: unknown = error;
	for (let depth = 0; depth < 6 && current !== undefined && current !== null; depth += 1) {
		if (current instanceof Error) {
			if (current.message) parts.push(current.message);
			current = (current as Error & { cause?: unknown }).cause;
		} else {
			parts.push(String(current));
			break;
		}
	}
	return parts.join(" <- ");
}

function excerptOf(text: string): string | undefined {
	const trimmed = text.trim();
	if (!trimmed) return undefined;
	return oneLine(
		trimmed
			.replace(/bot\d+:[A-Za-z0-9_-]+/g, "bot<redacted>")
			.replace(/\bBearer\s+[^\s,;]+/gi, "Bearer <redacted>")
			.replace(/\b(?:sk|pk|api[_-]?key)[-_][A-Za-z0-9_-]{12,}\b/gi, "<redacted>")
			.replace(/\bhttps?:\/\/\S+/gi, "<url>")
			.replace(/\b[A-Za-z0-9_-]{40,}\b/g, "<redacted>"),
		COMPACTION_EXCERPT_CHARS,
	);
}

/** Default attempt count, exported so tests and docs share one number. */
export const COMPACTION_DEFAULT_ATTEMPTS = RETRY_DEFAULTS.attempts;
