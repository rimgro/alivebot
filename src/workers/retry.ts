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
 * so there is no typed error code to switch on. The textual rules live in the
 * shared `src/retry.ts` classifier; this module delegates to them.
 */
import { isPermanentNetworkErrorText, isTransientNetworkErrorText } from "../retry.js";

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
 * True when the text describes a request/account problem no retry can fix
 * (auth, invalid request, unknown model, quota/billing).
 *
 * The rules live in `src/retry.ts` so every call site shares one classifier;
 * this module keeps only the worker-specific backoff and public predicates.
 */
export function isPermanentProviderError(message: string | undefined | null): boolean {
	return isPermanentNetworkErrorText(message);
}

/** True when another prompt in the same run may succeed where this one failed. */
export function isTransientProviderError(message: string | undefined | null): boolean {
	return isTransientNetworkErrorText(message);
}

/** Why an error is (not) retried; useful for logs and tests. */
export function classifyProviderError(message: string | undefined | null): "transient" | "permanent" {
	return isTransientProviderError(message) ? "transient" : "permanent";
}
