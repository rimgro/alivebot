/**
 * One-time external-access tickets for the dashboard.
 *
 * A ticket is the credential in a link handed to a chat:
 *
 *   https://<quick-tunnel-host>/t?t=<ticket>
 *
 * `GET /t` exchanges it exactly once for a short session cookie and redirects
 * to `/`. Compared with the password (#105), a ticket is:
 *
 * - **single-use**: consuming it deletes the record before the cookie is set,
 *   so a forwarded or replayed link gets `401` (an expired one gets `403`);
 * - **short**: tickets live minutes, and the session they create also lives
 *   minutes, not the 12-hour default;
 * - **thread-bound**: issuance records the requesting thread and is refused for
 *   threads outside the owner's private chats / `dashboard.allowedThreads`;
 * - **rate-limited**: a thread cannot mint an unbounded stream of links.
 *
 * Only ticket hashes and IP-free issuance metadata are written to
 * `<stateDir>/dashboard/state.json`; the raw ticket exists only in the returned
 * link and never in a log line.
 */
import { randomBytes } from "node:crypto";
import {
	DASHBOARD_MAX_ISSUANCES,
	hashTicket,
	readDashboardState,
	updateDashboardState,
	type DashboardTicketIssuance,
} from "./state-file.js";

/** How long a ticket can be exchanged: five minutes. */
export const DASHBOARD_TICKET_TTL_MS = 5 * 60_000;
/** Lifetime of the session a ticket creates: fifteen minutes. */
export const DASHBOARD_TICKET_SESSION_TTL_MS = 15 * 60_000;
/** Tickets one thread may mint inside the window. */
export const DASHBOARD_TICKET_RATE_MAX = 3;
/** Sliding window for `DASHBOARD_TICKET_RATE_MAX`. */
export const DASHBOARD_TICKET_RATE_WINDOW_MS = 10 * 60_000;
/** 256-bit ticket, base64url, the same shape as a session token. */
const TICKET_BYTES = 32;
const TICKET_RE = /^[A-Za-z0-9_-]{43}$/;

export interface IssuedTicket {
	/** The raw ticket; put it in the link and nowhere else. */
	token: string;
	thread: string;
	/** Epoch milliseconds. */
	createdAt: number;
	expiresAt: number;
}

export type TicketConsumeResult =
	| { kind: "ok"; thread: string; expiresAt: number }
	| { kind: "expired"; thread: string }
	| { kind: "invalid" };

export class DashboardTicketRateLimitError extends Error {
	constructor(
		readonly thread: string,
		readonly retryAfterMs: number,
		maxPerWindow: number,
		windowMs: number,
	) {
		super(
			`dashboard ticket rate limit reached for ${thread}: at most ${maxPerWindow} links per ` +
			`${Math.round(windowMs / 60_000)} minutes; try again in ${Math.max(1, Math.ceil(retryAfterMs / 1000))}s`,
		);
		this.name = "DashboardTicketRateLimitError";
	}
}

export interface DashboardTicketOptions {
	ttlMs?: number;
	sessionTtlMs?: number;
	maxPerWindow?: number;
	windowMs?: number;
}

function isTicket(value: string): boolean {
	return TICKET_RE.test(value);
}

/**
 * Ticket store over the shared dashboard state file.
 *
 * All methods are synchronous because they are read-modify-write operations
 * under a cross-process lock; the HTTP handler and the tool both call them.
 */
export class DashboardTicketStore {
	readonly ttlMs: number;
	readonly sessionTtlMs: number;
	readonly maxPerWindow: number;
	readonly windowMs: number;

	constructor(
		private readonly stateDir: string,
		private readonly now: () => number = Date.now,
		options: DashboardTicketOptions = {},
	) {
		this.ttlMs = options.ttlMs ?? DASHBOARD_TICKET_TTL_MS;
		this.sessionTtlMs = options.sessionTtlMs ?? DASHBOARD_TICKET_SESSION_TTL_MS;
		this.maxPerWindow = options.maxPerWindow ?? DASHBOARD_TICKET_RATE_MAX;
		this.windowMs = options.windowMs ?? DASHBOARD_TICKET_RATE_WINDOW_MS;
	}

	/**
	 * Mint a ticket for `thread`.
	 *
	 * The audit entry (thread, issuance time, expiry) is written before the raw
	 * token leaves this method; the token itself is never stored or logged.
	 */
	issue(thread: string): IssuedTicket {
		const trimmed = thread.trim();
		if (!trimmed) throw new Error("a dashboard ticket requires a requesting thread");
		const now = this.now();
		const recentSince = now - this.windowMs;
		const token = randomBytes(TICKET_BYTES).toString("base64url");
		return updateDashboardState(this.stateDir, now, (state) => {
			const recent = state.issuances.filter((entry) => entry.thread === trimmed && entry.at > recentSince);
			if (recent.length >= this.maxPerWindow) {
				const oldest = recent[0]!;
				throw new DashboardTicketRateLimitError(
					trimmed,
					Math.max(1, this.windowMs - (now - oldest.at)),
					this.maxPerWindow,
					this.windowMs,
				);
			}
			const expiresAt = now + this.ttlMs;
			const hash = hashTicket(token);
			state.tickets[hash] = { thread: trimmed, createdAt: now, expiresAt };
			const issuance: DashboardTicketIssuance = { thread: trimmed, at: now, expiresAt };
			state.issuances = [...state.issuances, issuance].slice(-DASHBOARD_MAX_ISSUANCES);
			return { token, thread: trimmed, createdAt: now, expiresAt };
		});
	}

	/**
	 * Consume a ticket. Success deletes the record in the same locked write, so
	 * concurrent exchanges cannot both win.
	 */
	consume(tokenInput: string): TicketConsumeResult {
		const token = (tokenInput ?? "").trim();
		if (!isTicket(token)) return { kind: "invalid" };
		const now = this.now();
		const hash = hashTicket(token);
		return updateDashboardState(this.stateDir, now, (state) => {
			const record = state.tickets[hash];
			if (!record) return { kind: "invalid" } as const;
			delete state.tickets[hash];
			if (record.expiresAt <= now) return { kind: "expired", thread: record.thread } as const;
			return { kind: "ok", thread: record.thread, expiresAt: record.expiresAt } as const;
		});
	}

	/** Drop every outstanding ticket (used by `dashboard({action:"close"})`). */
	revokeAll(): number {
		const now = this.now();
		return updateDashboardState(this.stateDir, now, (state) => {
			const count = Object.keys(state.tickets).length;
			state.tickets = {};
			return count;
		});
	}

	/** Number of unexpired tickets; read-only. */
	activeCount(): number {
		return Object.keys(readDashboardState(this.stateDir, this.now()).tickets).length;
	}

	/** The IP-free issuance audit log, newest last. */
	issuances(): DashboardTicketIssuance[] {
		return readDashboardState(this.stateDir, this.now()).issuances;
	}
}
