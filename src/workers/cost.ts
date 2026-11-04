/**
 * Worker run cost (#162).
 *
 * pi reports a session cost only when the resolved model carries prices in its
 * registry entry (`Model.cost`, per million tokens). Custom `models.json`
 * entries have no `cost` field by default, and pi then falls back to all-zero
 * rates: `getSessionStats().cost` is `0` for every run of such a model, which is
 * indistinguishable from "this run really cost nothing". `alive usage` then
 * reports worker spend as `$0` even though 42% of a profile's spend is workers.
 *
 * The rules here keep the two apart:
 *   - a provider-reported cost above zero is written as-is (`costSource: "provider"`);
 *   - a zero report on a model whose registry prices are known is recomputed
 *     from the run's token delta (`costSource: "computed"`);
 *   - everything else with real token usage is an explicit unknown
 *     (`cost: null`, `costSource: "unreported"`).
 *
 * Prices are never invented: a model with no rates, or with all-zero rates, has
 * no pricing here and therefore no computed cost.
 */

export type WorkerCostSource = "provider" | "computed" | "unreported";

/** Token counts for one run (or one pricing tier's threshold check). */
export interface WorkerTokenUsage {
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
}

/** Request-wide price tier, mirroring pi's `ModelCostTier`. */
export interface WorkerModelCostTier extends WorkerTokenUsage {
	/** Use this tier for requests whose total input usage exceeds this count. */
	inputTokensAbove: number;
}

/** Per-million-token rates of a model, mirroring pi's `ModelCost`. */
export interface WorkerModelPricing extends WorkerTokenUsage {
	tiers?: WorkerModelCostTier[];
}

export interface ResolvedWorkerRunCost {
	/** Run cost in USD, or `null` when no price is known. */
	cost: number | null;
	costSource: WorkerCostSource;
}

const RATE_KEYS = ["input", "output", "cacheRead", "cacheWrite"] as const;

function finiteNonNegative(value: unknown): number | undefined {
	return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : undefined;
}

function ratesOf(value: unknown): WorkerTokenUsage | undefined {
	if (!value || typeof value !== "object") return undefined;
	const record = value as Record<string, unknown>;
	const rates: Partial<WorkerTokenUsage> = {};
	for (const key of RATE_KEYS) {
		const rate = finiteNonNegative(record[key]);
		if (rate === undefined) return undefined;
		rates[key] = rate;
	}
	return rates as WorkerTokenUsage;
}

/** True when a rate table carries at least one non-zero price. */
export function hasPrices(pricing: WorkerTokenUsage | undefined): pricing is WorkerTokenUsage {
	if (!pricing) return false;
	return RATE_KEYS.some((key) => pricing[key] > 0);
}

/**
 * Normalize pi's `Model.cost` (or any structurally similar value) to a pricing
 * table. Returns `undefined` for unknown or unpriced models: a missing rate,
 * a non-finite rate or an all-zero table is "no price", never a free model.
 */
export function toWorkerModelPricing(value: unknown): WorkerModelPricing | undefined {
	const rates = ratesOf(value);
	if (!rates || !hasPrices(rates)) return undefined;
	const rawTiers = (value as { tiers?: unknown }).tiers;
	const tiers: WorkerModelCostTier[] = [];
	if (Array.isArray(rawTiers)) {
		for (const rawTier of rawTiers) {
			const tierRates = ratesOf(rawTier);
			const inputTokensAbove = finiteNonNegative((rawTier as { inputTokensAbove?: unknown })?.inputTokensAbove);
			if (!tierRates || inputTokensAbove === undefined) continue;
			tiers.push({ inputTokensAbove, ...tierRates });
		}
	}
	return tiers.length > 0 ? { ...rates, tiers } : { ...rates };
}

/** Total tokens a pricing decision depends on (pi includes cache tokens in the tier check). */
export function tokenCount(tokens: WorkerTokenUsage): number {
	return tokens.input + tokens.output + tokens.cacheRead + tokens.cacheWrite;
}

/**
 * Cost of one run from token usage and a known price table, in USD.
 *
 * Mirrors pi's `calculateCost`: rates are per million tokens, the highest
 * matching request-wide tier wins, and cache reads/writes use their own rates.
 */
export function costFromPricing(pricing: WorkerModelPricing, tokens: WorkerTokenUsage): number {
	const inputTokens = tokens.input + tokens.cacheRead + tokens.cacheWrite;
	let rates: WorkerTokenUsage = pricing;
	let matchedThreshold = -1;
	for (const tier of pricing.tiers ?? []) {
		if (inputTokens > tier.inputTokensAbove && tier.inputTokensAbove > matchedThreshold) {
			rates = tier;
			matchedThreshold = tier.inputTokensAbove;
		}
	}
	const micro = 1_000_000;
	return (
		(rates.input * tokens.input +
			rates.output * tokens.output +
			rates.cacheRead * tokens.cacheRead +
			rates.cacheWrite * tokens.cacheWrite) /
		micro
	);
}

/**
 * Decide what to write for one run.
 *
 * `reportedCost` is the provider/pi cost delta for this run, or `undefined` when
 * the session did not report one at all.
 */
export function resolveWorkerRunCost(input: {
	reportedCost: number | undefined;
	tokens: WorkerTokenUsage;
	pricing?: WorkerModelPricing;
}): ResolvedWorkerRunCost {
	const tokens = input.tokens;
	const reported =
		typeof input.reportedCost === "number" && Number.isFinite(input.reportedCost)
			? Math.max(0, input.reportedCost)
			: undefined;
	if (reported !== undefined && reported > 0) return { cost: reported, costSource: "provider" };
	if (tokenCount(tokens) <= 0) {
		// No prompt reached the model: a genuine zero, whether or not a cost was reported.
		return { cost: reported ?? 0, costSource: "provider" };
	}
	if (input.pricing) {
		// pi reported nothing (or zero) but the model is priced: derive from tokens.
		return { cost: costFromPricing(input.pricing, tokens), costSource: "computed" };
	}
	return { cost: null, costSource: "unreported" };
}
