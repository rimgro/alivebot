/**
 * Provider-network backoff (#282).
 *
 * On 2026-11-26 a broken route to the provider produced 79 failed runs in a row
 * (04:44–07:31Z): every run reached the provider request, `fetch` failed before
 * the model was ever called, and the runtime started the next run immediately
 * because the run record said `stopReason: "error"` with no network-specific
 * handling. The generic `stopReason: "error"` backoff existed but the incident
 * showed two things it could not do on its own:
 *
 * - tell "the network was down and the request never reached the model" apart
 *   from "the model/provider rejected the work" (the run record now carries
 *   {@link RunProviderNetworkError} for the first case);
 * - keep the pause for a network outage bounded: an unreachable provider is a
 *   host/route problem, and 15 min of silence is a bad default for it.
 *
 * This module owns the pause decision for one finished run. It is deliberately
 * one planner for every stop reason, so the pauses can never be added together:
 *
 * - provider network failure: `30s * 2^(streak-1)`, capped at 10 min;
 * - other `stopReason: "error"`: the pre-existing `30s * 2^(failures-1)`, capped
 *   at 15 min;
 * - `stalled`: the 2 s courtesy pause;
 * - anything else: no pause.
 *
 * A provider network failure feeds only the network streak and clears the
 * generic one (and the other way round), so one incident is one pause.
 */
import type { Logger } from "../log.js";
import { sanitizeHostname, sanitizeNetworkReason } from "../retry.js";
import type { RunProviderNetworkError, RunStopReason } from "../store/runs.js";
import { formatDuration, oneLine, sleep } from "../util.js";

/** First pause after a provider network failure; doubles for each further one. */
export const PROVIDER_NETWORK_BACKOFF_BASE_MS = 30_000;
/**
 * Ceiling for one provider-network pause. Lower than the generic error ceiling:
 * an unreachable provider must not park a run for a quarter of an hour, but it
 * must also not be hammered.
 */
export const PROVIDER_NETWORK_BACKOFF_MAX_MS = 10 * 60_000;
/** Pre-existing ceiling for a run that failed for a non-network reason. */
export const RUN_ERROR_BACKOFF_MAX_MS = 15 * 60_000;
/** Courtesy pause after a `stalled` run so a broken model cannot spin runs. */
export const STALLED_PAUSE_MS = 2_000;

/**
 * Pause before the next run: `base * 2^(streak-1)`, capped.
 *
 * `streak` is the 1-based number of consecutive failures of one class, so the
 * first failure waits `base` and the cap applies once the exponential passes it.
 */
export function backoffMs(streak: number, baseMs: number, maxMs: number): number {
	const step = Math.max(1, Math.floor(Number.isFinite(streak) ? streak : 1));
	return Math.min(baseMs * 2 ** Math.min(step - 1, 30), maxMs);
}

/** Pause before the next run after `streak` consecutive provider network failures. */
export function providerNetworkBackoffMs(streak: number): number {
	return backoffMs(streak, PROVIDER_NETWORK_BACKOFF_BASE_MS, PROVIDER_NETWORK_BACKOFF_MAX_MS);
}

/** Pause before the next run after `streak` consecutive non-network run errors. */
export function runErrorBackoffMs(streak: number): number {
	return backoffMs(streak, PROVIDER_NETWORK_BACKOFF_BASE_MS, RUN_ERROR_BACKOFF_MAX_MS);
}

/**
 * The single log line for a provider network failure.
 *
 * `provider network unavailable; next attempt in 30s (streak 3, EAI_AGAIN, attempts: 3)`
 *
 * One line per failed run — no retry spam from this layer. `reason`/`code` come
 * from `classifyNetworkError`, never from a raw provider message, and carry no
 * URL, token or response body.
 */
export function formatProviderNetworkLogLine(info: {
	delayMs: number;
	streak: number;
	reason: string;
	code?: string;
	attempts: number;
}): string {
	const detail = sanitizeNetworkReason(oneLine(info.code ?? info.reason, 200)) || "network error";
	const attempts = Number.isFinite(info.attempts) && info.attempts > 0 ? Math.floor(info.attempts) : 1;
	return `provider network unavailable; next attempt in ${formatDuration(info.delayMs)} ` +
		`(streak ${info.streak}, ${detail}, attempts: ${attempts})`;
}

/**
 * `record.error` text for a provider network failure: the cause, not a bare
 * `fetch failed`.
 *
 * `provider network error: fetch failed (EAI_AGAIN)` — the classified errno and
 * the host from the error cause are appended only when the message does not
 * already name them, so a message that is just the errno is not turned into
 * `EAI_AGAIN (EAI_AGAIN)`. `hostname` comes from the error chain, never from a
 * hardcoded provider URL (#282).
 */
export function providerNetworkErrorText(
	message: string | undefined,
	classification: { reason?: string; code?: string; hostname?: string },
): string {
	const base = sanitizeNetworkReason(oneLine(typeof message === "string" ? message : "", 300)) || "provider request failed";
	const primary = classification.code?.trim() || classification.reason?.trim();
	const hostname = sanitizeHostname(classification.hostname);
	const details: string[] = [];
	if (primary && primary !== base && !base.includes(primary)) details.push(sanitizeNetworkReason(primary));
	if (hostname && !base.toLowerCase().includes(hostname)) details.push(hostname);
	if (details.length === 0) return `provider network error: ${base}`;
	return `provider network error: ${base} (${details.join(", ")})`;
}

/** What the pause planner needs from a finished run. */
export interface RunPauseRecord {
	stopReason: RunStopReason;
	error?: string;
	/** Set only when the provider request failed before any model work. */
	providerNetwork?: RunProviderNetworkError;
}

export type RunPauseKind = "provider-network" | "error" | "stalled";

/** The one pause the loop must take before the next run starts. */
export interface RunPause {
	kind: RunPauseKind;
	delayMs: number;
	/** 1-based number of consecutive runs of this kind. */
	streak: number;
}

export interface RunBackoffOptions {
	/** A `Logger` from `src/log.ts`; one line per pause when present. */
	log?: Pick<Logger, "warn">;
	/** Injectable for tests: defaults to `sleep` from `../util.js`. */
	sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
}

/**
 * The loop's single pause planner.
 *
 * Holds the two streaks (provider network and generic run errors) across runs
 * and answers one question per finished run: how long to wait before the next
 * start, and what to log. Both streaks reset on any run that is not of their
 * own kind, so a single success clears both.
 */
export class RunBackoff {
	private errorStreak = 0;
	private networkStreak = 0;
	private readonly log?: Pick<Logger, "warn">;
	private readonly wait: (ms: number, signal?: AbortSignal) => Promise<void>;

	constructor(options: RunBackoffOptions = {}) {
		this.log = options.log;
		this.wait = options.sleep ?? sleep;
	}

	/** Consecutive provider network failures seen so far. */
	get providerNetworkStreak(): number {
		return this.networkStreak;
	}

	/** Consecutive non-network run errors seen so far. */
	get errorFailureStreak(): number {
		return this.errorStreak;
	}

	/** Pause for a finished run; logs it once. Pure decision, no waiting. */
	after(record: RunPauseRecord): RunPause | undefined {
		// A provider network failure is one incident: it feeds only the network
		// streak, and clears the generic one so the two can never add up.
		if (record.providerNetwork) {
			this.errorStreak = 0;
			this.networkStreak += 1;
			const pause: RunPause = {
				kind: "provider-network",
				delayMs: providerNetworkBackoffMs(this.networkStreak),
				streak: this.networkStreak,
			};
			this.log?.warn(formatProviderNetworkLogLine({
				delayMs: pause.delayMs,
				streak: pause.streak,
				reason: record.providerNetwork.reason,
				...(record.providerNetwork.code ? { code: record.providerNetwork.code } : {}),
				attempts: record.providerNetwork.attempts,
			}), {
				kind: pause.kind,
				streak: pause.streak,
				delayMs: pause.delayMs,
				reason: record.providerNetwork.reason,
				...(record.providerNetwork.code ? { code: record.providerNetwork.code } : {}),
				attempts: record.providerNetwork.attempts,
			});
			return pause;
		}
		this.networkStreak = 0;
		if (record.stopReason === "error") {
			this.errorStreak += 1;
			const pause: RunPause = {
				kind: "error",
				delayMs: runErrorBackoffMs(this.errorStreak),
				streak: this.errorStreak,
			};
			this.log?.warn("run failed; backing off", { failures: pause.streak, error: record.error });
			return pause;
		}
		this.errorStreak = 0;
		if (record.stopReason === "stalled") return { kind: "stalled", delayMs: STALLED_PAUSE_MS, streak: 1 };
		return undefined;
	}

	/**
	 * Apply the pause for a finished run: decide, log, wait.
	 *
	 * `sleep` resolves on abort, so a stop during the pause never throws out of
	 * the loop; the loop condition sees `stopping` on the next iteration.
	 */
	async waitFor(record: RunPauseRecord, signal?: AbortSignal): Promise<RunPause | undefined> {
		const pause = this.after(record);
		if (pause && pause.delayMs > 0) await this.wait(pause.delayMs, signal);
		return pause;
	}
}
