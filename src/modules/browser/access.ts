import { setTimeout as delay } from "node:timers/promises";

export type BrowserAccessState = "ready" | "checking" | "verification" | "private-entry" | "denied" | "http-error" | "rate-limited" | "disconnected";

/** Response metadata only. Never logs headers, cookies, page bodies or request URLs. */
export function retryDeadline(headers: Record<string, string>, now = Date.now()): number {
	const value = headers["retry-after"];
	if (value && /^\d+$/.test(value)) {
		const seconds = Number(value), until = now + seconds * 1000;
		if (Number.isSafeInteger(until)) return Math.max(now, until);
	} else if (value) {
		const until = Date.parse(value);
		if (Number.isFinite(until)) return Math.max(now, until);
	}
	const seconds = headers["x-ratelimit-retry"];
	if (seconds && /^\d+(\.\d+)?$/.test(seconds)) {
		const until = Math.ceil(now + Number(seconds) * 1000);
		if (Number.isSafeInteger(until)) return Math.max(now, until);
	}
	return now + 60_000;
}

/** Shared by routed conversations; controls top-level workload, not browser resources. */
export class BrowserNavigationBudget {
	private origins = new Map<string, { nextAt: number; retryAt: number }>();
	constructor(private readonly intervalMs: number) {
		if (!Number.isInteger(intervalMs) || intervalMs < 0 || intervalMs > 60_000) throw new Error("Invalid browser navigation interval");
	}

	defer(url: string, until: number): void {
		const origin = new URL(url).origin;
		const entry = this.entry(origin);
		entry.retryAt = Math.max(entry.retryAt, until);
	}

	async wait(url: string, signal: AbortSignal, maxWaitMs: number): Promise<void> {
		const entry = this.entry(new URL(url).origin);
		signal.throwIfAborted();
		const now = Date.now();
		if (entry.retryAt > now) throw new Error(`Site rate limit cooldown has not elapsed; retryAt=${entry.retryAt}`);
		const at = Math.max(now, entry.nextAt), wait = at - now;
		if (wait > maxWaitMs) throw new Error("Site navigation budget is busy; wait before retrying");
		// Reserve synchronously before yielding, including for parallel conversations.
		entry.nextAt = at + this.intervalMs;
		if (wait > 0) await delay(wait, undefined, { signal });
		if (entry.retryAt > Date.now()) throw new Error(`Site rate limit cooldown has not elapsed; retryAt=${entry.retryAt}`);
		signal.throwIfAborted();
	}

	private entry(origin: string): { nextAt: number; retryAt: number } {
		const existing = this.origins.get(origin);
		if (existing) return existing;
		for (const [key, entry] of this.origins) if (Math.max(entry.nextAt, entry.retryAt) <= Date.now()) this.origins.delete(key);
		if (this.origins.size >= 256) throw new Error("Too many active site budgets; wait before opening another origin");
		const entry = { nextAt: 0, retryAt: 0 }; this.origins.set(origin, entry); return entry;
	}
}
