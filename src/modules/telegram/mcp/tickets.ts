/**
 * File-based approval tickets shared by the Telegram MCP proxy and the runtime
 * module (#264, step B2).
 *
 * The proxy is a separate host process from the runtime: it owns the upstream
 * `telegram mcp` child, while the bot token and the operator's thread live in the
 * module. They agree on one directory of small JSON files:
 *
 *   <ticketDir>/<profile>/<ticketId>.json           the write the proxy is waiting on
 *   <ticketDir>/<profile>/<ticketId>.decision.json  the operator's verdict from the module
 *
 * Every write is atomic (temp file + rename) and both the directory (0700) and
 * the files (0600) are private. The proxy never sends anything before it reads a
 * matching decision: the ticket is the only contract between the two processes.
 */
import { createHash, randomBytes } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";

export type TelegramMcpTicketStatus = "pending" | "decided" | "sending" | "sent" | "failed" | "denied" | "expired";
export type TelegramMcpTicketDecision = "approve" | "deny";

/** One pending (or finished) write confirmation. */
export interface TelegramMcpTicket {
	version: 1;
	ticketId: string;
	profile: string;
	tool: string;
	/** Chat as the agent sent it; absent when the profile has no allowChats. */
	chat?: string;
	/** Exact text the upstream would receive; never truncated in the ticket. */
	text: string;
	createdAt: number;
	expiresAt: number;
	nonce: string;
	status: TelegramMcpTicketStatus;
	/** sha256 of the canonical JSON of every `tools/call` argument (#264 B2). */
	requestHash: string;
	/** sha256 of profile+tool+requestHash, used to reuse a pending ticket. */
	requestKey: string;
	/** Set by the module once it sent the card. */
	cardChatId?: number;
	cardMessageId?: number;
	cardSentAt?: number;
	/** Set by the module after the card was edited to its final state. */
	cardClosedAt?: number;
	/** Set by the module when the operator pressed a button. */
	decidedAt?: number;
	decidedBy?: number;
	/** Set by the proxy when it executed (or refused) the write. */
	sentAt?: number;
	error?: string;
}

/** The module's verdict. The proxy re-checks ticketId and nonce before acting. */
export interface TelegramMcpTicketDecisionRecord {
	version: 1;
	ticketId: string;
	nonce: string;
	/** Must equal both the ticket hash and the hash of the request about to be sent. */
	requestHash: string;
	decision: TelegramMcpTicketDecision;
	decidedAt: number;
	userId: number;
}

export type TicketDecisionParse =
	| { ok: true; decision: TelegramMcpTicketDecisionRecord }
	| { ok: false; reason: string };

export type TicketDecisionRead =
	| { found: false }
	| { found: true; raw: unknown };

const TICKET_ID = /^tgask_[0-9a-f]{16}$/;
const PROFILE_NAME = /^[A-Za-z0-9_-]+$/;
const DECISION_SUFFIX = ".decision.json";

/** Maximum pending tickets per profile; beyond it the proxy denies without writing. */
export const MAX_PENDING_TICKETS_PER_PROFILE = 8;

/** Absolute ticket directory: an absolute config value wins, a relative one is stateDir-relative. */
export function resolveTicketDir(stateDir: string, configured: string): string {
	return path.isAbsolute(configured) ? path.normalize(configured) : path.resolve(stateDir, configured);
}

export function ticketFilePath(ticketDir: string, ticketId: string): string {
	return path.join(ticketDir, `${ticketId}.json`);
}

export function decisionFilePath(ticketDir: string, ticketId: string): string {
	return path.join(ticketDir, `${ticketId}${DECISION_SUFFIX}`);
}

/** Profile subdirectory: tickets of one profile never mix with another's. */
export function profileTicketDir(ticketDir: string, profile: string): string {
	if (!PROFILE_NAME.test(profile)) throw new Error(`invalid MCP profile name "${profile}"`);
	return path.join(ticketDir, profile);
}

/** Existing profile subdirectories under a shared ticket root. */
export function listProfileTicketDirs(ticketDir: string): string[] {
	let entries: fs.Dirent[];
	try {
		entries = fs.readdirSync(ticketDir, { withFileTypes: true });
	} catch {
		return [];
	}
	return entries
		.filter((entry) => entry.isDirectory() && PROFILE_NAME.test(entry.name))
		.map((entry) => path.join(ticketDir, entry.name))
		.sort();
}

/** JSON with object keys sorted and `undefined` omitted, recursively. */
export function stableStringify(value: unknown): string {
	return JSON.stringify(canonicalize(value)) ?? "null";
}

function canonicalize(value: unknown): unknown {
	if (value === undefined || typeof value === "function" || typeof value === "symbol") return undefined;
	if (value === null || typeof value !== "object") return value;
	if (Array.isArray(value)) return value.map((item) => canonicalize(item) ?? null);
	const source = value as Record<string, unknown>;
	const out: Record<string, unknown> = {};
	for (const key of Object.keys(source).sort()) {
		const item = canonicalize(source[key]);
		if (item !== undefined) out[key] = item;
	}
	return out;
}

/** Hash of every argument the proxy is going to send upstream (`params.arguments`). */
export function telegramMcpRequestHash(args: unknown): string {
	return createHash("sha256").update(stableStringify(args), "utf8").digest("hex");
}

/** Exact request identity for reuse: the same profile, tool and canonical arguments. */
export function telegramMcpTicketRequestKey(profile: string, tool: string, requestHash: string): string {
	return createHash("sha256").update(JSON.stringify([profile, tool, requestHash]), "utf8").digest("hex");
}

export function newTelegramMcpTicketId(): string {
	return `tgask_${randomBytes(8).toString("hex")}`;
}

export function newTelegramMcpTicketNonce(): string {
	return randomBytes(16).toString("hex");
}

/** Create the ticket directory with the private mode the files rely on. */
export function ensureTicketDir(ticketDir: string): void {
	fs.mkdirSync(ticketDir, { recursive: true, mode: 0o700 });
	try {
		fs.chmodSync(ticketDir, 0o700);
	} catch {
		// best effort: an unusual filesystem may refuse chmod
	}
}

/** Write one JSON file atomically with 0600. */
export function writeJsonAtomic(file: string, value: unknown): void {
	ensureTicketDir(path.dirname(file));
	const temp = `${file}.${process.pid}.${randomBytes(4).toString("hex")}.tmp`;
	fs.writeFileSync(temp, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
	try {
		fs.chmodSync(temp, 0o600);
	} catch {
		// best effort
	}
	fs.renameSync(temp, file);
	try {
		fs.chmodSync(file, 0o600);
	} catch {
		// best effort
	}
}

export function writeTicket(ticketDir: string, ticket: TelegramMcpTicket): void {
	if (!TICKET_ID.test(ticket.ticketId)) throw new Error(`invalid ticket id "${ticket.ticketId}"`);
	writeJsonAtomic(ticketFilePath(ticketDir, ticket.ticketId), ticket);
}

/** Read one ticket; a missing or corrupt file reads as undefined. */
export function readTicket(ticketDir: string, ticketId: string): TelegramMcpTicket | undefined {
	if (!TICKET_ID.test(ticketId)) return undefined;
	try {
		const parsed = JSON.parse(fs.readFileSync(ticketFilePath(ticketDir, ticketId), "utf8")) as unknown;
		return normalizeTicket(parsed);
	} catch {
		return undefined;
	}
}

/** Every readable ticket, oldest first. Malformed files are skipped. */
export function listTickets(ticketDir: string): TelegramMcpTicket[] {
	let names: string[];
	try {
		names = fs.readdirSync(ticketDir);
	} catch {
		return [];
	}
	const tickets: TelegramMcpTicket[] = [];
	for (const name of names) {
		if (!name.endsWith(".json") || name.endsWith(DECISION_SUFFIX)) continue;
		const ticketId = name.slice(0, -".json".length);
		if (!TICKET_ID.test(ticketId)) continue;
		const ticket = readTicket(ticketDir, ticketId);
		if (ticket) tickets.push(ticket);
	}
	return tickets.sort((left, right) => left.createdAt - right.createdAt);
}

/** Pending tickets that are still within their TTL. */
export function countPendingTickets(ticketDir: string, now: number): number {
	return listTickets(ticketDir).filter((ticket) => ticket.status === "pending" && ticket.expiresAt > now).length;
}

/**
 * Remove tickets past their TTL together with their decisions. Called on proxy
 * start and on every module scan so an abandoned directory cannot grow.
 */
export function sweepExpiredTickets(ticketDir: string, now: number): number {
	let removed = 0;
	for (const ticket of listTickets(ticketDir)) {
		// Keep one full TTL after expiry so a late decision/card edit can still see
		// the terminal ticket; anything older is pure garbage.
		const ttl = Math.max(60_000, ticket.expiresAt - ticket.createdAt);
		if (ticket.expiresAt + ttl > now) continue;
		for (const file of [ticketFilePath(ticketDir, ticket.ticketId), decisionFilePath(ticketDir, ticket.ticketId)]) {
			try {
				fs.unlinkSync(file);
				removed += 1;
			} catch {
				// already gone
			}
		}
	}
	return removed;
}

/**
 * A `sending` ticket survived a proxy restart: the write may or may not have
 * reached the upstream. It is never retried; the caller gets an error instead.
 */
export function failInterruptedSendingTickets(ticketDir: string): number {
	let recovered = 0;
	for (const ticket of listTickets(ticketDir)) {
		if (ticket.status !== "sending") continue;
		writeTicket(ticketDir, {
			...ticket,
			status: "failed",
			error: "proxy restarted while the write was being sent; not retried",
		});
		recovered += 1;
	}
	return recovered;
}

/** Start-of-proxy hygiene for one profile directory. */
export function prepareProfileTicketDir(ticketDir: string, profile: string, now: number): string {
	const dir = profileTicketDir(ticketDir, profile);
	ensureTicketDir(dir);
	sweepExpiredTickets(dir, now);
	failInterruptedSendingTickets(dir);
	return dir;
}

/** Re-read and merge a patch. Terminal statuses are never downgraded. */
export function patchTicket(
	ticketDir: string,
	ticketId: string,
	patch: Partial<Omit<TelegramMcpTicket, "version" | "ticketId">>,
	options: { onlyStatus?: TelegramMcpTicketStatus[] } = {},
): TelegramMcpTicket | undefined {
	const ticket = readTicket(ticketDir, ticketId);
	if (!ticket) return undefined;
	if (options.onlyStatus && !options.onlyStatus.includes(ticket.status)) return ticket;
	const next: TelegramMcpTicket = { ...ticket, ...patch, version: 1, ticketId: ticket.ticketId };
	writeTicket(ticketDir, next);
	return next;
}

/** A pending ticket with the same request identity and no decision yet. */
export function findPendingTicket(ticketDir: string, requestKey: string, now: number): TelegramMcpTicket | undefined {
	return listTickets(ticketDir).find(
		(ticket) =>
			ticket.status === "pending" &&
			ticket.requestKey === requestKey &&
			ticket.expiresAt > now &&
			!readDecision(ticketDir, ticket.ticketId).found,
	);
}

export function writeDecision(ticketDir: string, decision: TelegramMcpTicketDecisionRecord): void {
	if (!TICKET_ID.test(decision.ticketId)) throw new Error(`invalid ticket id "${decision.ticketId}"`);
	writeJsonAtomic(decisionFilePath(ticketDir, decision.ticketId), decision);
}

/** Read the decision file; `found` is true even when the JSON is corrupt. */
export function readDecision(ticketDir: string, ticketId: string): TicketDecisionRead {
	if (!TICKET_ID.test(ticketId)) return { found: false };
	try {
		const text = fs.readFileSync(decisionFilePath(ticketDir, ticketId), "utf8");
		try {
			return { found: true, raw: JSON.parse(text) as unknown };
		} catch {
			return { found: true, raw: undefined };
		}
	} catch {
		return { found: false };
	}
}

/**
 * Semantic check of a decision against the ticket it claims to answer. A
 * decision for another ticket, with another nonce, malformed, or written after
 * the ticket expired is rejected; the caller treats that as no approval.
 */
export function parseTicketDecision(raw: unknown, ticket: TelegramMcpTicket): TicketDecisionParse {
	if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
		return { ok: false, reason: "decision file is not an object" };
	}
	const record = raw as Record<string, unknown>;
	if (record.version !== 1) return { ok: false, reason: "decision file has an unsupported version" };
	if (record.ticketId !== ticket.ticketId) return { ok: false, reason: "decision belongs to another ticket" };
	if (typeof record.nonce !== "string" || record.nonce !== ticket.nonce) {
		return { ok: false, reason: "decision nonce does not match the ticket" };
	}
	if (typeof record.requestHash !== "string" || record.requestHash !== ticket.requestHash) {
		return { ok: false, reason: "decision request hash does not match the ticket" };
	}
	if (record.decision !== "approve" && record.decision !== "deny") {
		return { ok: false, reason: 'decision must be "approve" or "deny"' };
	}
	if (!Number.isSafeInteger(record.decidedAt) || (record.decidedAt as number) <= 0) {
		return { ok: false, reason: "decision decidedAt is not a positive timestamp" };
	}
	if (!Number.isSafeInteger(record.userId) || (record.userId as number) === 0) {
		return { ok: false, reason: "decision userId is not a Telegram user id" };
	}
	if ((record.decidedAt as number) > ticket.expiresAt) {
		return { ok: false, reason: "decision was written after the ticket expired" };
	}
	return {
		ok: true,
		decision: {
			version: 1,
			ticketId: ticket.ticketId,
			nonce: ticket.nonce,
			requestHash: ticket.requestHash,
			decision: record.decision,
			decidedAt: record.decidedAt as number,
			userId: record.userId as number,
		},
	};
}

function normalizeTicket(value: unknown): TelegramMcpTicket | undefined {
	if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
	const raw = value as Record<string, unknown>;
	if (raw.version !== 1) return undefined;
	if (typeof raw.ticketId !== "string" || !TICKET_ID.test(raw.ticketId)) return undefined;
	if (typeof raw.profile !== "string" || !raw.profile) return undefined;
	if (typeof raw.tool !== "string" || !raw.tool) return undefined;
	if (typeof raw.text !== "string") return undefined;
	if (!Number.isFinite(raw.createdAt) || !Number.isFinite(raw.expiresAt)) return undefined;
	if (typeof raw.nonce !== "string" || !raw.nonce) return undefined;
	if (typeof raw.requestHash !== "string" || !raw.requestHash) return undefined;
	if (typeof raw.requestKey !== "string" || !raw.requestKey) return undefined;
	const statuses: TelegramMcpTicketStatus[] = ["pending", "decided", "sending", "sent", "failed", "denied", "expired"];
	if (typeof raw.status !== "string" || !statuses.includes(raw.status as TelegramMcpTicketStatus)) return undefined;
	const ticket: TelegramMcpTicket = {
		version: 1,
		ticketId: raw.ticketId,
		profile: raw.profile,
		tool: raw.tool,
		text: raw.text,
		createdAt: raw.createdAt as number,
		expiresAt: raw.expiresAt as number,
		nonce: raw.nonce,
		status: raw.status as TelegramMcpTicketStatus,
		requestHash: raw.requestHash,
		requestKey: raw.requestKey,
	};
	if (typeof raw.chat === "string") ticket.chat = raw.chat;
	if (Number.isSafeInteger(raw.cardChatId)) ticket.cardChatId = raw.cardChatId as number;
	if (Number.isSafeInteger(raw.cardMessageId)) ticket.cardMessageId = raw.cardMessageId as number;
	if (Number.isSafeInteger(raw.cardSentAt)) ticket.cardSentAt = raw.cardSentAt as number;
	if (Number.isSafeInteger(raw.cardClosedAt)) ticket.cardClosedAt = raw.cardClosedAt as number;
	if (Number.isSafeInteger(raw.decidedAt)) ticket.decidedAt = raw.decidedAt as number;
	if (Number.isSafeInteger(raw.decidedBy)) ticket.decidedBy = raw.decidedBy as number;
	if (Number.isSafeInteger(raw.sentAt)) ticket.sentAt = raw.sentAt as number;
	if (typeof raw.error === "string") ticket.error = raw.error;
	return ticket;
}
