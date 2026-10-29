/**
 * Provider failure classification and retry backoff for worker runs.
 *
 * A worker run can die before it does any work because the provider failed
 * transiently (`Request timed out`, a dropped connection, a 429 or a 5xx).
 * Those failures are worth one more prompt inside the same run; everything
 * that describes the request itself (auth, invalid request, unknown model) is
 * not, because repeating it only burns tokens.
 *
 * Classification is intentionally textual: pi surfaces provider failures as an
 * assistant message with `stopReason: "error"` and a free-form `errorMessage`,
 * so there is no typed error code to switch on.
 */

/** Hard ceiling for one retry backoff, regardless of base delay and attempt. */
export const MAX_PROVIDER_RETRY_DELAY_MS = 60_000;

/**
 * Linear backoff: `baseDelayMs × attempt`, capped at
 * {@link MAX_PROVIDER_RETRY_DELAY_MS}. `attempt` is the number of the attempt
 * that just failed (1 = first retry waits `baseDelayMs`).
 */
export function providerRetryDelayMs(baseDelayMs: number, attempt: number): number {
	const base = Number.isFinite(baseDelayMs) && baseDelayMs > 0 ? baseDelayMs : 0;
	const step = Number.isFinite(attempt) && attempt > 0 ? Math.floor(attempt) : 1;
	return Math.min(Math.round(base * step), MAX_PROVIDER_RETRY_DELAY_MS);
}

/**
 * Conditions that mean "the request was wrong", not "the network was unlucky".
 * Checked before the transient patterns so a message that mentions both (e.g.
 * `401 Unauthorized` with a request id) is never retried.
 */
const NON_RETRYABLE_PATTERNS: readonly RegExp[] = [
	// Explicit HTTP 4xx client errors. 408/429 are handled as transient below.
	// A trailing duration ("timed out after 400 ms") is not a status code.
	/\b4(?:00|01|03|04|05|09|13|15|22)\b(?!\s*(?:ms|milliseconds?|s|sec|seconds?)\b)/i,
	// Auth / credentials.
	/unauthori[sz]ed/i,
	/authentication (?:failed|error|required)/i,
	/invalid[ _-]?api[ _-]?key/i,
	/incorrect api key/i,
	/no api key/i,
	/missing api key/i,
	/api key (?:is )?(?:invalid|expired|revoked)/i,
	/forbidden/i,
	/permission denied/i,
	// Request shape / model identity.
	/invalid[ _-]?request/i,
	/invalid[ _-]?argument/i,
	/bad request/i,
	/unsupported (?:model|parameter|value|content)/i,
	/model[ _-]?not[ _-]?found/i,
	/no such model/i,
	/model .* does not exist/i,
	/cannot resolve worker model/i,
	/context[ _-]?(?:length|window)/i,
	/too many tokens/i,
	/prompt is too long/i,
	/content[ _-]?policy/i,
	// Billing/quota failures: the account, not the network, is the problem.
	/insufficient[ _-]?quota/i,
	/exceeded your current quota/i,
	/billing (?:hard )?limit/i,
];

/** Failures another attempt may well survive. */
const TRANSIENT_PATTERNS: readonly RegExp[] = [
	// Timeouts (client, proxy or provider side).
	/timed?\s*out/i,
	/timeout/i,
	/\bETIMEDOUT\b/,
	/\bESOCKETTIMEDOUT\b/,
	/deadline exceeded/i,
	// Connection resets / refusals / DNS hiccups.
	/\bECONNRESET\b/,
	/\bECONNREFUSED\b/,
	/\bECONNABORTED\b/,
	/\bEPIPE\b/,
	/\bEAI_AGAIN\b/,
	/\bENETUNREACH\b/,
	/\bEHOSTUNREACH\b/,
	/\bENOTFOUND\b/,
	/connection (?:error|reset|refused|closed|aborted|terminated|dropped)/i,
	/network error/i,
	/fetch failed/i,
	/socket hang ?up/i,
	/other side closed/i,
	/server disconnected/i,
	/upstream connect error/i,
	// Rate limits and overload markers.
	/\b(?:429|529)\b(?!\s*(?:ms|milliseconds?|s|sec|seconds?)\b)/,
	/rate[ _-]?limit/i,
	/too many requests/i,
	/\boverloaded\b/i,
	/capacity exceeded/i,
	/temporarily unavailable/i,
	// HTTP 5xx in any of its usual spellings.
	/\b(?:http|status|status code|response|api|server|upstream|error code)\D{0,16}5\d{2}\b/i,
	/\bHTTP\/\d(?:\.\d)?\s*5\d{2}\b/,
	/\b5\d{2}\s+(?:internal server error|bad gateway|service unavailable|gateway time-?out|server error)/i,
	/internal server error/i,
	/bad gateway/i,
	/service unavailable/i,
	/gateway time-?out/i,
];

/** True when another prompt in the same run may succeed where this one failed. */
export function isTransientProviderError(message: string | undefined | null): boolean {
	const text = typeof message === "string" ? message.trim() : "";
	if (!text) return false;
	if (NON_RETRYABLE_PATTERNS.some((pattern) => pattern.test(text))) return false;
	return TRANSIENT_PATTERNS.some((pattern) => pattern.test(text));
}

/** Why an error is (not) retried; useful for logs and tests. */
export function classifyProviderError(message: string | undefined | null): "transient" | "permanent" {
	return isTransientProviderError(message) ? "transient" : "permanent";
}
