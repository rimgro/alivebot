import * as fs from "node:fs";
import * as path from "node:path";
import { ensureDir, newId, readJson, writeJsonAtomic } from "../util.js";

export type HistoryDirection = "inbound" | "outbound";

export interface HistoryAttachment {
	kind: string;
	name?: string;
	mime?: string;
	size?: number;
	/** Provider-side file id (e.g. Telegram `file_id`). */
	fileId?: string;
	/** Provider-side unique id for the attachment. */
	fileUniqueId?: string;
	durationSec?: number;
	meta?: Record<string, unknown>;
}

/**
 * One message in the durable conversation history.
 *
 * `id` must be stable and provider-scoped (e.g. `telegram:12345:678`) so that a
 * module can safely append the same message twice without duplicating it.
 */
export interface HistoryRecord {
	id: string;
	/** Canonical alive thread id, e.g. `telegram:12345` or `telegram:12345/7`. */
	thread: string;
	/** Which module produced the record: `telegram`, `console`, ... */
	module: string;
	direction: HistoryDirection;
	ts: number;
	author?: string;
	authorId?: string;
	text: string;
	/** Provider-side message id, as a string. */
	messageId?: string;
	replyTo?: string;
	attachments?: HistoryAttachment[];
	meta?: Record<string, unknown>;
}

export interface NewHistoryRecord extends Omit<HistoryRecord, "id" | "ts"> {
	id?: string;
	ts?: number;
}

export interface HistoryThread {
	thread: string;
	module: string;
	title: string;
	lastMessageAt: number;
	firstMessageAt: number;
	messageCount: number;
	inboundCount: number;
	outboundCount: number;
	participants: string[];
	meta?: Record<string, unknown>;
}

export interface ThreadUpsert {
	thread: string;
	module: string;
	title: string;
	participants?: string[];
	meta?: Record<string, unknown>;
}

export interface HistoryQuery {
	thread?: string;
	/** Only these threads. Ignored when `thread` is set. */
	threads?: string[];
	module?: string;
	direction?: HistoryDirection;
	authorId?: string;
	/** Inclusive lower bound (ms). */
	since?: number;
	/** Inclusive upper bound (ms). */
	until?: number;
	/** Case-insensitive substring match over text and author. */
	search?: string;
	/** Return messages strictly older than this provider message id (same thread). */
	before?: string;
	/** Return messages strictly newer than this provider message id (same thread). */
	after?: string;
	limit?: number;
	maxLimit?: number;
	order?: "asc" | "desc";
}

const DEFAULT_LIMIT = 50;
const HARD_LIMIT = 1000;

interface ThreadMeta {
	thread: string;
	module: string;
	title: string;
	participants?: string[];
	meta?: Record<string, unknown>;
	updatedAt: number;
}

/**
 * Durable, provider-agnostic conversation history.
 *
 * Every module (Telegram, Discord, console, …) appends what it saw and what the
 * agent said to this one append-only log. That is what makes "read the chat
 * history" a first-class capability for the agent instead of a per-integration
 * special case: the `history` tool queries this store, and each module keeps its
 * own provider-specific extras (chat metadata, file ids) in `meta`.
 *
 * The file is append-only JSONL; a second process may append safely. Reads are
 * served from an in-memory index that is refreshed incrementally by file size.
 */
export class HistoryStore {
	private readonly file: string;
	private readonly threadsFile: string;
	private records: HistoryRecord[] = [];
	private offset = 0;
	private readonly byId = new Map<string, HistoryRecord>();
	private readonly byThread = new Map<string, HistoryRecord[]>();
	private threadsMeta = new Map<string, ThreadMeta>();

	private constructor(file: string, threadsFile: string) {
		this.file = file;
		this.threadsFile = threadsFile;
	}

	static open(stateDir: string): HistoryStore {
		const dir = path.join(stateDir, "history");
		ensureDir(dir);
		const store = new HistoryStore(path.join(dir, "messages.jsonl"), path.join(dir, "threads.json"));
		store.threadsMeta = new Map(Object.entries(readJson<Record<string, ThreadMeta>>(store.threadsFile, {})));
		store.refresh();
		return store;
	}

	/** Re-read appends from other processes (or our own earlier writes). */
	refresh(): void {
		let size: number;
		try {
			size = fs.statSync(this.file).size;
		} catch {
			return;
		}
		if (size === this.offset) return;
		if (size < this.offset) {
			this.reset();
		}
		const fd = fs.openSync(this.file, "r");
		try {
			const length = size - this.offset;
			const buffer = Buffer.alloc(length);
			fs.readSync(fd, buffer, 0, length, this.offset);
			this.offset = size;
			for (const line of buffer.toString("utf8").split("\n")) {
				const trimmed = line.trim();
				if (!trimmed) continue;
				try {
					const record = JSON.parse(trimmed) as HistoryRecord;
					if (!record?.id || !record.thread) continue;
					if (this.byId.has(record.id)) continue;
					this.index(record);
				} catch {
					// ignore corrupt lines: a bad append must not hide the rest of history
				}
			}
		} finally {
			fs.closeSync(fd);
		}
	}

	private reset(): void {
		this.records = [];
		this.offset = 0;
		this.byId.clear();
		this.byThread.clear();
	}

	private index(record: HistoryRecord): void {
		this.records.push(record);
		this.byId.set(record.id, record);
		const bucket = this.byThread.get(record.thread);
		if (bucket) bucket.push(record);
		else this.byThread.set(record.thread, [record]);
	}

	/**
	 * Append a record. Returns the stored record. If a record with the same `id`
	 * already exists it is returned unchanged (idempotent for at-least-once
	 * delivery).
	 */
	append(input: NewHistoryRecord): HistoryRecord {
		this.refresh();
		const id = input.id ?? newId(`hist`);
		const existing = this.byId.get(id);
		if (existing) return existing;
		const record: HistoryRecord = {
			id,
			thread: input.thread,
			module: input.module,
			direction: input.direction,
			ts: input.ts ?? Date.now(),
			author: input.author,
			authorId: input.authorId,
			text: input.text,
			messageId: input.messageId,
			replyTo: input.replyTo,
			attachments: input.attachments,
			meta: input.meta,
		};
		ensureDir(path.dirname(this.file));
		fs.appendFileSync(this.file, `${JSON.stringify(record)}\n`, "utf8");
		this.index(record);
		this.offset = fs.statSync(this.file).size;
		return record;
	}

	upsertThread(input: ThreadUpsert): void {
		const previous = this.threadsMeta.get(input.thread);
		const merged: ThreadMeta = {
			thread: input.thread,
			module: input.module,
			title: input.title || previous?.title || input.thread,
			participants: mergeParticipants(previous?.participants, input.participants),
			meta: { ...(previous?.meta ?? {}), ...(input.meta ?? {}) },
			updatedAt: Date.now(),
		};
		this.threadsMeta.set(input.thread, merged);
		this.saveThreadsMeta();
	}

	get(id: string): HistoryRecord | undefined {
		this.refresh();
		return this.byId.get(id);
	}

	query(query: HistoryQuery = {}): HistoryRecord[] {
		this.refresh();
		const limit = clampLimit(query.limit, query.maxLimit);
		const order = query.order ?? "asc";
		let pool: HistoryRecord[];
		if (query.thread) {
			pool = this.byThread.get(query.thread) ?? [];
		} else if (query.threads && query.threads.length > 0) {
			const allowed = new Set(query.threads);
			pool = this.records.filter((r) => allowed.has(r.thread));
		} else {
			pool = this.records;
		}

		const before = query.before ?? query.after;
		const anchor = before ? this.findByMessageId(query.thread, before) : undefined;

		let filtered = pool.filter((record) => {
			if (query.module && record.module !== query.module) return false;
			if (query.direction && record.direction !== query.direction) return false;
			if (query.authorId && record.authorId !== query.authorId) return false;
			if (query.since !== undefined && record.ts < query.since) return false;
			if (query.until !== undefined && record.ts > query.until) return false;
			if (query.search && !matchesSearch(record, query.search)) return false;
			if (anchor) {
				if (query.before && record.ts >= anchor.ts) return false;
				if (query.after && record.ts <= anchor.ts) return false;
			}
			return true;
		});

		// Stable order within equal timestamps by provider message id when numeric.
		filtered = filtered.sort((a, b) => a.ts - b.ts || compareMessageIds(a.messageId, b.messageId));
		if (order === "desc") filtered = filtered.reverse();
		return filtered.slice(0, limit);
	}

	search(query: string, options: Omit<HistoryQuery, "search"> = {}): HistoryRecord[] {
		return this.query({ ...options, search: query });
	}

	thread(thread: string): HistoryThread | undefined {
		this.refresh();
		const records = this.byThread.get(thread);
		const meta = this.threadsMeta.get(thread);
		if (!records && !meta) return undefined;
		const example = records?.[0];
		const module = meta?.module ?? example?.module ?? thread.split(":")[0] ?? "unknown";
		const base: HistoryThread = {
			thread,
			module,
			title: meta?.title ?? example?.author ?? thread,
			firstMessageAt: records?.[0]?.ts ?? meta?.updatedAt ?? 0,
			lastMessageAt: records?.[records.length - 1]?.ts ?? meta?.updatedAt ?? 0,
			messageCount: records?.length ?? 0,
			inboundCount: records?.filter((r) => r.direction === "inbound").length ?? 0,
			outboundCount: records?.filter((r) => r.direction === "outbound").length ?? 0,
			participants: meta?.participants ?? [],
			meta: meta?.meta,
		};
		return base;
	}

	/** All known threads, newest activity first. */
	threads(options: { module?: string } = {}): HistoryThread[] {
		this.refresh();
		const ids = new Set<string>([...this.threadsMeta.keys(), ...this.byThread.keys()]);
		const out: HistoryThread[] = [];
		for (const id of ids) {
			const thread = this.thread(id);
			if (!thread) continue;
			if (options.module && thread.module !== options.module) continue;
			out.push(thread);
		}
		return out.sort((a, b) => b.lastMessageAt - a.lastMessageAt);
	}

	stats(): { messages: number; threads: number; bytes: number } {
		this.refresh();
		let bytes = 0;
		try {
			bytes = fs.statSync(this.file).size;
		} catch {
			bytes = 0;
		}
		return { messages: this.records.length, threads: this.byThread.size, bytes };
	}

	/**
	 * Keep only the newest `keep` messages of a thread, rewriting the log.
	 * Called by modules that set a per-thread retention limit.
	 */
	prune(thread: string, keep: number): number {
		if (keep <= 0) return 0;
		this.refresh();
		const records = this.byThread.get(thread);
		if (!records || records.length <= keep) return 0;
		const drop = new Set(records.slice(0, records.length - keep).map((r) => r.id));
		this.rewrite(this.records.filter((r) => !drop.has(r.id)));
		return drop.size;
	}

	private rewrite(records: HistoryRecord[]): void {
		ensureDir(path.dirname(this.file));
		const tmp = `${this.file}.${process.pid}.tmp`;
		fs.writeFileSync(tmp, records.map((r) => JSON.stringify(r)).join("\n") + (records.length > 0 ? "\n" : ""), "utf8");
		fs.renameSync(tmp, this.file);
		this.reset();
		this.refresh();
	}

	/** Find a record by provider message id (or history id) inside a thread. */
	findByMessageId(thread: string | undefined, messageId: string): HistoryRecord | undefined {
		this.refresh();
		const pool = thread ? this.byThread.get(thread) ?? [] : this.records;
		for (let i = pool.length - 1; i >= 0; i -= 1) {
			if (pool[i]!.messageId === messageId || pool[i]!.id === messageId) return pool[i];
		}
		return undefined;
	}

	private saveThreadsMeta(): void {
		const value: Record<string, ThreadMeta> = {};
		for (const [key, meta] of this.threadsMeta) value[key] = meta;
		writeJsonAtomic(this.threadsFile, value);
	}
}

function clampLimit(limit: number | undefined, maxLimit: number | undefined): number {
	const ceiling = Math.min(maxLimit ?? HARD_LIMIT, HARD_LIMIT);
	const value = limit === undefined ? DEFAULT_LIMIT : Math.floor(limit);
	if (!Number.isFinite(value) || value <= 0) return Math.min(DEFAULT_LIMIT, ceiling);
	return Math.min(value, ceiling);
}

function matchesSearch(record: HistoryRecord, needle: string): boolean {
	const lower = needle.toLowerCase();
	return (
		record.text.toLowerCase().includes(lower) ||
		(record.author?.toLowerCase().includes(lower) ?? false) ||
		record.thread.toLowerCase().includes(lower)
	);
}

function mergeParticipants(previous: string[] | undefined, next: string[] | undefined): string[] {
	const set = new Set<string>(previous ?? []);
	for (const value of next ?? []) if (value) set.add(value);
	return [...set];
}

function compareMessageIds(a: string | undefined, b: string | undefined): number {
	if (a === undefined || b === undefined) return 0;
	const na = Number(a);
	const nb = Number(b);
	if (Number.isFinite(na) && Number.isFinite(nb)) return na - nb;
	return a.localeCompare(b);
}
