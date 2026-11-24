/**
 * File-based approval tickets shared by the Telegram MCP proxy and the runtime
 * module (#264, step B2).
 *
 * The proxy is a separate host process from the runtime: it owns the upstream
 * `telegram mcp` child, while the bot token and the operator's thread live in the
 * module. They agree on one directory of small JSON files:
 *
 *   <ticketDir>/<ticketId>.json           the write the proxy is waiting on
 *   <ticketDir>/<ticketId>.decision.json  the operator's verdict from the module
 *
 * Every write is atomic (temp file + rename) and both the directory (0700) and
 * the files (0600) are private. The proxy never sends anything before it reads a
 * matching decision: the ticket is the only contract between the two processes.
 */
import { createHash, randomBytes } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";

export type TelegramMcpTicketStatus = "pending" | "decided" | "sent" | "failed" | "denied" | "expired";
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
	/** sha256 of profile+tool+chat+text, used to reuse a pending ticket. */
	requestKey: string;
	/** Set by the module once it sent the card. */
	cardChatId?: number;
	cardMessageId?: number;
	cardSentAt?: number;
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
const DECISION_SUFFIX = ".decision.json";

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

/** Exact request identity for reuse: the same profile, tool, chat and text. */
export function telegramMcpTicketRequestKey(profile: string, tool: string, chat: string, text: string): string {
	return createHash("sha256").update(JSON.stringify([profile, tool, chat, text]), "utf8").digest("hex");
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
	if (typeof raw.requestKey !== "string" || !raw.requestKey) return undefined;
	const statuses: TelegramMcpTicketStatus[] = ["pending", "decided", "sent", "failed", "denied", "expired"];
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
		requestKey: raw.requestKey,
	};
	if (typeof raw.chat === "string") ticket.chat = raw.chat;
	if (Number.isSafeInteger(raw.cardChatId)) ticket.cardChatId = raw.cardChatId as number;
	if (Number.isSafeInteger(raw.cardMessageId)) ticket.cardMessageId = raw.cardMessageId as number;
	if (Number.isSafeInteger(raw.cardSentAt)) ticket.cardSentAt = raw.cardSentAt as number;
	if (Number.isSafeInteger(raw.decidedAt)) ticket.decidedAt = raw.decidedAt as number;
	if (Number.isSafeInteger(raw.decidedBy)) ticket.decidedBy = raw.decidedBy as number;
	if (Number.isSafeInteger(raw.sentAt)) ticket.sentAt = raw.sentAt as number;
	if (typeof raw.error === "string") ticket.error = raw.error;
	return ticket;
}
