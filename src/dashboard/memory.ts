/**
 * Read-only view over an alive profile's long-term memory.
 *
 * The SQLite database is always opened with `readOnly: true` and queried with
 * bound parameters: the dashboard never migrates, inserts or updates a fact.
 * `summary.md`, `notes.json` (the `NoteStore` scratchpad) and `journal/*.md`
 * are read from disk and capped before they reach the renderer.
 *
 * Facts are revisioned, not deleted: a revise marks the old row `active = 0`
 * and the new row lists the replaced ids in `supersedes`. The view therefore
 * groups every current fact with the chain of older revisions it replaced.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { resolveMemoryDatabasePath } from "../config.js";
import { readJson } from "../util.js";
import type { DashboardProfile } from "./state.js";

/** Per-item cap for fact/note/journal/summary text. */
export const MEMORY_MAX_TEXT_CHARS = 20_000;
/** Per-section item cap; the page says "showing X of Y" when it bites. */
export const MEMORY_MAX_ITEMS = 200;
/** The dashboard refuses to evaluate absurdly long search terms. */
export const MEMORY_QUERY_MAX_CHARS = 200;
/** Bound filesystem scans for the optional `notes/` and `journal/` directories. */
const MEMORY_MAX_SCANNED_FILES = 1_000;

export interface MemoryFactView {
	id: string;
	text: string;
	scopes: string[];
	createdAt: string;
	validFrom: string;
	validTo?: string;
	active: boolean;
	supersedes: string[];
	truncated: boolean;
	originalChars: number;
}

export interface MemoryFactGroup {
	/** Current (active) revision. Absent only for orphaned historical rows. */
	current?: MemoryFactView;
	/** Older revisions, newest first. */
	revisions: MemoryFactView[];
}

export interface MemoryFactSection {
	groups: MemoryFactGroup[];
	shown: number;
	total: number;
	matches: number;
	note?: string;
}

export interface MemoryTextItem {
	title: string;
	text: string;
	/** Free-form right-aligned metadata (timestamps, source). */
	meta?: string;
	source?: string;
	truncated: boolean;
	originalChars: number;
}

export interface MemoryTextSection {
	items: MemoryTextItem[];
	shown: number;
	total: number;
	matches: number;
	note?: string;
}

export interface MemorySummarySection {
	item?: MemoryTextItem;
	matches: number;
	note?: string;
}

export interface MemoryView {
	agent: { id: string; name: string };
	databasePath: string;
	/** Trimmed search term, empty when browsing. */
	query: string;
	facts: MemoryFactSection;
	summary: MemorySummarySection;
	notes: MemoryTextSection;
	journal: MemoryTextSection;
}

// ---------------------------------------------------------------------------
// text caps
// ---------------------------------------------------------------------------

export interface CappedText {
	text: string;
	truncated: boolean;
	originalChars: number;
}

export function capMemoryText(text: string, max = MEMORY_MAX_TEXT_CHARS): CappedText {
	const originalChars = text.length;
	if (originalChars <= max) return { text, truncated: false, originalChars };
	return { text: text.slice(0, max), truncated: true, originalChars };
}

export function countOccurrences(haystack: string, needle: string): number {
	if (!needle) return 0;
	const text = haystack.toLocaleLowerCase();
	const term = needle.toLocaleLowerCase();
	let count = 0;
	let from = 0;
	while (true) {
		const index = text.indexOf(term, from);
		if (index < 0) return count;
		count += 1;
		from = index + term.length;
	}
}

export function matchesQuery(text: string, query: string): boolean {
	return query.length > 0 && text.toLocaleLowerCase().includes(query.toLocaleLowerCase());
}

function textItem(title: string, text: string, extra: { meta?: string; source?: string } = {}): MemoryTextItem {
	const capped = capMemoryText(text);
	return {
		title,
		text: capped.text,
		meta: extra.meta,
		source: extra.source,
		truncated: capped.truncated,
		originalChars: capped.originalChars,
	};
}

// ---------------------------------------------------------------------------
// facts (sqlite, read-only)
// ---------------------------------------------------------------------------

/**
 * Open the memory database for reading only. Exported so tests can assert that
 * a write through this handle fails.
 */
export function openMemoryDatabaseReadOnly(databasePath: string): DatabaseSync {
	return new DatabaseSync(databasePath, { readOnly: true });
}

interface FactRow {
	id: string;
	text: string;
	text_length: number;
	scopes: string;
	created_at: string;
	valid_from: string;
	valid_to: string | null;
	active: number;
	supersedes: string;
}

function parseStringArray(value: unknown): string[] {
	if (typeof value !== "string") return [];
	try {
		const parsed = JSON.parse(value) as unknown;
		return Array.isArray(parsed) ? parsed.filter((entry): entry is string => typeof entry === "string") : [];
	} catch {
		return [];
	}
}

function rowToFact(row: FactRow): MemoryFactView {
	const capped = capMemoryText(String(row.text ?? ""));
	// `text` is already SELECTed with substr(); keep the DB-reported length for
	// the truncation note even when the row is bigger than the cap.
	const originalChars = Number(row.text_length ?? capped.originalChars);
	const text = capped.text;
	return {
		id: String(row.id ?? ""),
		text,
		scopes: parseStringArray(row.scopes),
		createdAt: String(row.created_at ?? ""),
		validFrom: String(row.valid_from ?? ""),
		validTo: row.valid_to === null || row.valid_to === undefined ? undefined : String(row.valid_to),
		active: Number(row.active) === 1,
		supersedes: parseStringArray(row.supersedes),
		truncated: originalChars > MEMORY_MAX_TEXT_CHARS,
		originalChars,
	};
}

function emptyFactSection(note?: string): MemoryFactSection {
	return { groups: [], shown: 0, total: 0, matches: 0, note };
}

function readFactSection(databasePath: string, query: string): MemoryFactSection {
	if (!fs.existsSync(databasePath)) {
		return emptyFactSection(`no memory database at ${databasePath} (the agent has not retained facts yet)`);
	}
	let db: DatabaseSync;
	try {
		db = openMemoryDatabaseReadOnly(databasePath);
	} catch (error) {
		return emptyFactSection(`memory database could not be opened read-only: ${errorMessage(error)}`);
	}
	try {
		const table = db.prepare(
			"SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'alive_memories'",
		).get();
		if (!table) return emptyFactSection("memory database has no alive_memories table");

		const filter = query ? "WHERE instr(lower(text), lower(?)) > 0" : "";
		const filterArgs = query ? [query] : [];
		const countRow = db.prepare(`SELECT COUNT(*) AS total FROM alive_memories ${filter}`).get(...filterArgs) as
			| { total?: number }
			| undefined;
		const total = Number(countRow?.total ?? 0);
		if (total === 0) {
			return { groups: [], shown: 0, total: 0, matches: 0 };
		}
		const rows = db.prepare(
			`SELECT id, substr(text, 1, ?) AS text, length(text) AS text_length, scopes, created_at,
				valid_from, valid_to, active, supersedes
			 FROM alive_memories ${filter}
			 ORDER BY active DESC, valid_from DESC, created_at DESC, id
			 LIMIT ?`,
		).all(MEMORY_MAX_TEXT_CHARS + 1, ...filterArgs, MEMORY_MAX_ITEMS) as unknown as FactRow[];
		const facts = rows.map(rowToFact);
		const groups = groupMemoryFacts(facts);
		return {
			groups,
			shown: facts.length,
			total,
			matches: query ? total : 0,
		};
	} catch (error) {
		return emptyFactSection(`memory database could not be read: ${errorMessage(error)}`);
	} finally {
		db.close();
	}
}

/**
 * Fold planar fact rows into `current + superseded revisions` groups.
 *
 * Rows the query did not return stay unknown: in search mode a matching old
 * revision can appear without its current descendant, and that is reported as
 * an orphaned historical row instead of pretending it is current.
 */
export function groupMemoryFacts(facts: MemoryFactView[]): MemoryFactGroup[] {
	const byId = new Map(facts.map((fact) => [fact.id, fact]));
	const consumed = new Set<string>();
	const groups: MemoryFactGroup[] = [];
	for (const current of facts) {
		if (!current.active || consumed.has(current.id)) continue;
		const seen = new Set<string>([current.id]);
		const revisions: MemoryFactView[] = [];
		const stack = [...current.supersedes];
		while (stack.length > 0) {
			const id = stack.pop()!;
			if (seen.has(id)) continue;
			seen.add(id);
			const revision = byId.get(id);
			if (!revision) continue;
			revisions.push(revision);
			stack.push(...revision.supersedes);
		}
		revisions.sort((left, right) => right.validFrom.localeCompare(left.validFrom));
		for (const id of seen) consumed.add(id);
		groups.push({ current, revisions });
	}
	// Rows left over are superseded facts whose current descendant was not in
	// the result set (or a corrupt/orphaned row). Keep them, clearly marked.
	for (const fact of facts) {
		if (consumed.has(fact.id)) continue;
		consumed.add(fact.id);
		groups.push({ revisions: [fact] });
	}
	return groups;
}

// ---------------------------------------------------------------------------
// summary.md
// ---------------------------------------------------------------------------

function readSummarySection(profile: DashboardProfile, query: string): MemorySummarySection {
	const summaryPath = profile.config.paths.summaryPath;
	let raw: string;
	try {
		raw = fs.readFileSync(summaryPath, "utf8");
	} catch {
		return { matches: 0, note: `no summary.md at ${summaryPath}` };
	}
	const matches = query ? countOccurrences(raw, query) : 0;
	if (query && matches === 0) {
		return { matches: 0, note: "summary.md does not contain the search term" };
	}
	return {
		item: textItem("summary.md", raw, { source: summaryPath }),
		matches,
	};
}

// ---------------------------------------------------------------------------
// notes (notes.json + optional notes/ directory)
// ---------------------------------------------------------------------------

interface NoteDraft {
	title: string;
	text: string;
	source: string;
}

function readNotesDrafts(stateDir: string): { drafts: NoteDraft[]; note?: string } {
	const drafts: NoteDraft[] = [];
	const notesFile = path.join(stateDir, "notes.json");
	const notes = readJson<Record<string, unknown> | null>(notesFile, null);
	if (notes && typeof notes === "object" && !Array.isArray(notes)) {
		for (const key of Object.keys(notes).sort()) {
			const value = notes[key];
			const text = typeof value === "string" ? value : JSON.stringify(value, null, 2);
			drafts.push({ title: key, text: text ?? "(empty)", source: `${notesFile}#${key}` });
		}
	}

	// The store is `notes.json`; some profiles may also keep markdown notes in
	// `state/notes/`, so surface those too rather than hiding agent-written text.
	const notesDir = path.join(stateDir, "notes");
	const listed = listFiles(notesDir, MEMORY_MAX_SCANNED_FILES);
	let note: string | undefined;
	if (listed.total > listed.files.length) {
		note = `notes directory contains ${listed.total} files; only the first ${listed.files.length} were scanned`;
	}
	for (const file of listed.files) {
		let raw: string;
		try {
			raw = fs.readFileSync(file, "utf8");
		} catch {
			continue;
		}
		drafts.push({ title: path.relative(notesDir, file), text: raw, source: file });
	}
	return { drafts, note };
}

function readNotesSection(stateDir: string, query: string): MemoryTextSection {
	const { drafts, note } = readNotesDrafts(stateDir);
	const matching = query
		? drafts.filter((draft) => matchesQuery(`${draft.title}\n${draft.text}`, query))
		: drafts;
	return {
		items: matching.slice(0, MEMORY_MAX_ITEMS).map((draft) => textItem(draft.title, draft.text, { source: draft.source })),
		shown: Math.min(matching.length, MEMORY_MAX_ITEMS),
		total: drafts.length,
		matches: query ? matching.length : 0,
		note: matching.length > MEMORY_MAX_ITEMS ? `${matching.length - MEMORY_MAX_ITEMS} more note(s) not shown` : note,
	};
}

// ---------------------------------------------------------------------------
// journal (state/journal/YYYY-MM-DD.md)
// ---------------------------------------------------------------------------

interface JournalDraft {
	date: string;
	time?: string;
	text: string;
	source: string;
}

function parseJournalFile(file: string, date: string): JournalDraft[] {
	let raw: string;
	try {
		raw = fs.readFileSync(file, "utf8");
	} catch {
		return [];
	}
	const drafts: JournalDraft[] = [];
	let current: { time?: string; lines: string[] } | undefined;
	const flush = (): void => {
		if (!current) return;
		const text = current.lines.join("\n").trim();
		if (text) drafts.push({ date, time: current.time, text, source: file });
	};
	for (const line of raw.split("\n")) {
		if (line.startsWith("## ")) {
			flush();
			const header = line.slice(3).trim();
			const separator = header.indexOf("—");
			const time = separator < 0 ? header : header.slice(0, separator).trim();
			current = { time: time || undefined, lines: [line] };
			continue;
		}
		if (current) current.lines.push(line);
	}
	flush();
	return drafts;
}

function readJournalSection(journalDir: string, query: string): MemoryTextSection {
	const listed = listFiles(journalDir, MEMORY_MAX_SCANNED_FILES, (name) => name.endsWith(".md"), "desc");
	let note: string | undefined;
	if (listed.total > listed.files.length) {
		note = `journal contains ${listed.total} files; only the newest ${listed.files.length} were scanned`;
	}
	const files = listed.files;
	const drafts: JournalDraft[] = [];
	for (const file of files) {
		const date = path.basename(file).replace(/\.md$/, "");
		// Each journal file is append-only and chronological, so reverse it.
		drafts.push(...parseJournalFile(file, date).reverse());
	}
	const matching = query
		? drafts.filter((draft) => matchesQuery(`${draft.date} ${draft.time ?? ""}\n${draft.text}`, query))
		: drafts;
	const items = matching.slice(0, MEMORY_MAX_ITEMS).map((draft) => textItem(
		`${draft.date}${draft.time ? ` ${draft.time}` : ""}`,
		draft.text,
		{ source: draft.source },
	));
	if (matching.length > MEMORY_MAX_ITEMS) {
		const existing = note ? `${note}; ` : "";
		note = `${existing}${matching.length - MEMORY_MAX_ITEMS} older entr${matching.length - MEMORY_MAX_ITEMS === 1 ? "y" : "ies"} not shown`;
	}
	return {
		items,
		shown: items.length,
		total: drafts.length,
		matches: query ? matching.length : 0,
		note,
	};
}

// ---------------------------------------------------------------------------
// filesystem helpers
// ---------------------------------------------------------------------------

function listFiles(
	dir: string,
	max: number,
	accept?: (name: string) => boolean,
	order: "asc" | "desc" = "asc",
): { files: string[]; total: number } {
	const files: string[] = [];
	let total = 0;
	const walk = (current: string, depth: number): void => {
		if (depth > 4) return;
		let entries: fs.Dirent[];
		try {
			entries = fs.readdirSync(current, { withFileTypes: true });
		} catch {
			return;
		}
		entries.sort((left, right) => order === "desc"
			? right.name.localeCompare(left.name)
			: left.name.localeCompare(right.name));
		for (const entry of entries) {
			if (entry.name.startsWith(".")) continue;
			const full = path.join(current, entry.name);
			if (entry.isDirectory()) {
				walk(full, depth + 1);
				continue;
			}
			if (!entry.isFile()) continue;
			if (accept && !accept(entry.name)) continue;
			total += 1;
			if (files.length < max) files.push(full);
		}
	};
	walk(dir, 0);
	return { files, total };
}

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

// ---------------------------------------------------------------------------
// page loader
// ---------------------------------------------------------------------------

export interface MemoryPageOptions {
	/** Raw `?q=` value; trimmed and length-capped here. */
	query?: string;
}

export function loadMemoryPage(profile: DashboardProfile, options: MemoryPageOptions = {}): MemoryView {
	const query = (options.query ?? "").trim().slice(0, MEMORY_QUERY_MAX_CHARS);
	return {
		agent: { id: profile.id, name: profile.name },
		databasePath: resolveMemoryDatabasePath(profile.config),
		query,
		facts: readFactSection(resolveMemoryDatabasePath(profile.config), query),
		summary: readSummarySection(profile, query),
		notes: readNotesSection(profile.stateDir, query),
		journal: readJournalSection(profile.config.paths.journalDir, query),
	};
}
