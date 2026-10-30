/**
 * Empty-wake gate (#116).
 *
 * The runtime used to start a run whenever its idle interval expired, even with
 * an empty inbox: the model got the full system prompt (~7k tokens), saw "no
 * events", answered `idle`, and the whole thing repeated after every sleep.
 * Five agents × ~96 wakes/day ≈ 3.4M input tokens/day for nothing.
 *
 * The rule now: **a run starts only when there is something to do.** An idle
 * runtime waits for a wake-worthy event, creates no run and never calls the
 * model. One full idle interval with nothing to do is an *empty wake*; its only
 * effect is debug logging and — after `loop.emptyWakeBackoff.afterWakes`
 * consecutive empty wakes — a stretched interval, so a quiet profile checks its
 * inbox less and less often (15 → 30 → 60 min by default, capped by
 * `maxIntervalMs`). Any wake-worthy event resets the streak and starts a run
 * immediately: the wait polls the inbox every `pollIntervalMs`.
 *
 * "Wake-worthy" is `event.wake !== false` (see `src/store/events.ts`). Modules
 * mark traffic that is not addressed to the agent (unaddressed group chatter)
 * with `wake: false`: it stays in the inbox and reaches the context with the
 * next real wake, but it never starts a run on its own.
 */
import type { EmptyWakeBackoffConfig } from "../config.js";
import type { Logger } from "../log.js";
import type { AliveEvent, EventStore } from "../store/events.js";
import { sleep } from "../util.js";

/** Never spin: even a misconfigured base interval waits at least this long. */
export const MIN_WAKE_INTERVAL_MS = 1_000;

/**
 * May this event start a run by itself?
 *
 * `wake: false` is the only opt-out; every older event (and every event from a
 * module that does not set the field) still wakes the agent, so nothing that used
 * to be delivered is lost.
 */
export function eventWakesAgent(event: AliveEvent): boolean {
	return event.wake !== false;
}

/**
 * Is there pending work that deserves a run?
 *
 * Scans the pending queue from the cursor until the first wake-worthy event, so
 * an arbitrary amount of unaddressed chatter in front of it cannot hide a real
 * request and starve the wake-up.
 */
export function hasWakeWorthyPending(store: Pick<EventStore, "findPending">): boolean {
	return store.findPending(eventWakesAgent) !== undefined;
}

/**
 * Interval before the next inbox check.
 *
 * `emptyWakes` counts consecutive empty wakes *already observed*, so 0 is the
 * fresh base interval. With `afterWakes: 2` and base 15 min the sequence is
 * 15, 15, 30, 60, 60, … (capped at `maxIntervalMs`); `enabled: false` pins it to
 * the base.
 */
export function wakeIntervalMs(options: {
	baseIntervalMs: number;
	emptyWakes: number;
	backoff: EmptyWakeBackoffConfig;
}): number {
	const base = Math.max(MIN_WAKE_INTERVAL_MS, Math.floor(options.baseIntervalMs) || MIN_WAKE_INTERVAL_MS);
	const cap = Math.max(MIN_WAKE_INTERVAL_MS, Math.floor(options.backoff.maxIntervalMs) || MIN_WAKE_INTERVAL_MS);
	if (!options.backoff.enabled) return base;
	const after = Math.max(1, Math.floor(options.backoff.afterWakes) || 1);
	const doublings = Math.max(0, options.emptyWakes - after + 1);
	if (doublings === 0) return Math.min(base, cap);
	// Cap the exponent before multiplying: the interval is bounded anyway and a
	// long quiet stretch must not depend on float precision.
	const stretched = base * 2 ** Math.min(doublings, 20);
	return Math.min(stretched, cap);
}

export interface WakeSchedulerOptions {
	/** Fresh idle interval, normally `loop.sleepAfterMs`. */
	baseIntervalMs: number;
	/** Inbox poll inside a wait; events are picked up within this delay. */
	pollIntervalMs: number;
	backoff: EmptyWakeBackoffConfig;
	log: Logger;
	/** True when a run should start (wake-worthy event pending, redelivery pending). */
	hasWork: () => boolean;
	/** True once the runtime is stopping; `nextRun` then resolves with "stopped". */
	isStopped: () => boolean;
	/** Injectable for tests. */
	now?: () => number;
	sleep?: (ms: number) => Promise<void>;
	/** Called after each empty wake (already logged at debug level). */
	onEmptyWake?: (info: { emptyWakes: number; intervalMs: number }) => void;
}

export type WakeOutcome = "event" | "stopped";

/**
 * Blocks until a run should start. This is the only place that decides whether
 * the runtime wakes up; it never calls the model itself.
 */
export class WakeScheduler {
	private emptyWakes = 0;
	private readonly now: () => number;
	private readonly sleep: (ms: number) => Promise<void>;

	constructor(private readonly options: WakeSchedulerOptions) {
		this.now = options.now ?? (() => Date.now());
		this.sleep = options.sleep ?? ((ms) => sleep(ms));
	}

	/** Consecutive idle intervals that elapsed without a wake-worthy event. */
	get consecutiveEmptyWakes(): number {
		return this.emptyWakes;
	}

	/** Interval of the wait that is (or would be) in progress right now. */
	get intervalMs(): number {
		return wakeIntervalMs({
			baseIntervalMs: this.options.baseIntervalMs,
			emptyWakes: this.emptyWakes,
			backoff: this.options.backoff,
		});
	}

	/** An event arrived / a run started: the streak is over. */
	noteWake(): void {
		if (this.emptyWakes > 0) {
			this.options.log.debug("wake streak reset by an event", { emptyWakes: this.emptyWakes });
		}
		this.emptyWakes = 0;
	}

	/** Record one full idle interval with nothing to do; returns the next interval. */
	noteEmptyWake(): number {
		this.emptyWakes += 1;
		const intervalMs = this.intervalMs;
		this.options.log.debug("empty wake: no events, staying asleep", {
			emptyWakes: this.emptyWakes,
			nextCheckInMs: intervalMs,
		});
		this.options.onEmptyWake?.({ emptyWakes: this.emptyWakes, intervalMs });
		return intervalMs;
	}

	/**
	 * Wait until a run should start.
	 *
	 * Returns `"event"` as soon as `hasWork()` is true (immediately when work is
	 * already pending — the streak is reset then) and `"stopped"` when the runtime
	 * stops or the abort signal fires. While nothing happens, each elapsed interval
	 * is counted as an empty wake and the next interval stretches.
	 */
	async nextRun(): Promise<WakeOutcome> {
		while (true) {
			if (this.options.hasWork()) {
				this.noteWake();
				return "event";
			}
			if (this.options.isStopped()) return "stopped";
			const deadline = this.now() + this.intervalMs;
			const work = await this.waitForDeadline(deadline);
			if (work === "work") {
				this.noteWake();
				return "event";
			}
			if (work === "stopped") return "stopped";
			this.noteEmptyWake();
		}
	}

	private async waitForDeadline(deadline: number): Promise<"work" | "empty" | "stopped"> {
		const pollMs = Math.max(1, Math.floor(this.options.pollIntervalMs) || MIN_WAKE_INTERVAL_MS);
		while (true) {
			if (this.options.hasWork()) return "work";
			if (this.options.isStopped()) return "stopped";
			const remaining = deadline - this.now();
			if (remaining <= 0) return "empty";
			await this.sleep(Math.min(pollMs, remaining));
		}
	}
}
