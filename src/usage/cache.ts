/**
 * Prompt cache statistics (#76).
 *
 * Pure arithmetic and formatting, on purpose: this module is imported by the
 * runtime prompt builder and by the dashboard read model, so it must not import
 * anything from `src/` (not even a runtime helper) and cannot create a cycle.
 *
 * `cacheHitRate = cacheRead / (input + cacheRead)`: the share of prompt tokens
 * the provider served from its prompt cache instead of reprocessing them.
 */

/**
 * How many cache-write tokens make a run's `cacheWrite` worth explaining.
 *
 * A cache write is billed at a premium, so a run that writes a non-trivial
 * cache and reads none is the signature of a changed static prefix (every
 * request misses) or of a run too short to ever hit its own cache. Below this
 * threshold the write is ordinary noise and not worth a warning.
 */
export const CACHE_WRITE_NOTABLE_TOKENS = 1000;

/** `cacheRead / (input + cacheRead)`; null when no prompt tokens were recorded. */
export function cacheHitRate(usage: { input: number; cacheRead: number }): number | null {
	const prompt = usage.input + usage.cacheRead;
	if (!Number.isFinite(prompt) || prompt <= 0) return null;
	return usage.cacheRead / prompt;
}

/** `46.2%` — the one rate format the dashboard and the prompt share; `—` when unknown. */
export function formatRate(rate: number | null): string {
	if (rate === null || !Number.isFinite(rate)) return "—";
	return `${(rate * 100).toFixed(1)}%`;
}

/**
 * True when a run wrote a notable cache but read none of it: the static prefix
 * changed, or the run was too short to pay the write off.
 */
export function isColdCacheRun(usage: { cacheRead: number; cacheWrite: number }): boolean {
	return usage.cacheRead === 0 && usage.cacheWrite >= CACHE_WRITE_NOTABLE_TOKENS;
}
