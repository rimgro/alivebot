import { randomUUID } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import * as fs from "node:fs";
import * as path from "node:path";

export interface MemoryConfig {
	databasePath: string;
	embeddingProvider: "openai" | "cloudflare";
	embeddingBaseUrl: string;
	embeddingApiKey: string;
	embeddingModel: string;
	embeddingDimensions: number;
	revisionThreshold: number;
}

export interface MemoryFact {
	id: string;
	text: string;
	scopes: string[];
	createdAt: string;
	validFrom: string;
	validTo?: string;
	active: boolean;
	supersedes: string[];
	similarity?: number;
}

export interface RetainResult {
	status: "added" | "revised" | "unchanged";
	fact: MemoryFact;
}

export interface MemoryService {
	search(query: string, limit?: number, scopes?: string[], includeHistory?: boolean): Promise<MemoryFact[]>;
	history(id: string): Promise<MemoryFact[]>;
	retain(facts: string[], scopes: string[]): Promise<RetainResult[]>;
	close(): Promise<void>;
}

/** SQLite-backed long-term memory. Embeddings are compared in-process (cosine similarity). */
export class MemoryStore implements MemoryService {
	private readonly db: DatabaseSync;

	constructor(private readonly config: MemoryConfig) {
		if (!config.databasePath) throw new Error("SQLite memory database path must be configured");
		if (!config.embeddingBaseUrl || !config.embeddingModel) throw new Error("Embedding endpoint and model must be configured");
		if (config.embeddingProvider === "cloudflare" && !config.embeddingApiKey.trim()) {
			throw new Error("Cloudflare memory embeddings require a token. Set the environment variable configured by memory.embeddingApiKeyEnv (currently CLOUDFLARE_API_TOKEN) and restart Alive.");
		}
		if (!Number.isInteger(config.embeddingDimensions) || config.embeddingDimensions < 1) {
			throw new Error("embeddingDimensions must be a positive integer");
		}
		if (config.revisionThreshold < 0 || config.revisionThreshold > 1) throw new Error("revisionThreshold must be between 0 and 1");
		fs.mkdirSync(path.dirname(config.databasePath), { recursive: true });
		this.db = new DatabaseSync(config.databasePath);
	}

	async init(): Promise<void> {
		this.db.exec(`
			CREATE TABLE IF NOT EXISTS alive_memories (
				id TEXT PRIMARY KEY,
				text TEXT NOT NULL,
				embedding TEXT NOT NULL,
				scopes TEXT NOT NULL,
				created_at TEXT NOT NULL,
				valid_from TEXT NOT NULL,
				valid_to TEXT,
				active INTEGER NOT NULL DEFAULT 1,
				supersedes TEXT NOT NULL DEFAULT '[]'
			);
			CREATE INDEX IF NOT EXISTS alive_memories_active_idx ON alive_memories (active, valid_from DESC);
		`);
	}

	async search(query: string, limit = 6, scopes: string[] = [], includeHistory = false): Promise<MemoryFact[]> {
		const text = cleanText(query);
		if (!text) return [];
		const embedding = await this.embed(text);
		const rows = this.db.prepare(
			`SELECT * FROM alive_memories ${includeHistory ? "" : "WHERE active = 1"}`,
		).all() as unknown as DbRow[];
		const candidates = rows
			.map((row) => ({ fact: rowToFact(row), embedding: parseEmbedding(row.embedding) }))
			.filter(({ fact }) => !scopes.length || scopes.some((scope) => fact.scopes.includes(scope)))
			.map(({ fact, embedding: candidate }) => ({ ...fact, similarity: cosineSimilarity(embedding, candidate) }))
			.sort((left, right) => (right.similarity ?? 0) - (left.similarity ?? 0));
		return candidates.slice(0, Math.max(1, Math.min(50, Math.floor(limit))));
	}

	async history(id: string): Promise<MemoryFact[]> {
		const rows = this.db.prepare("SELECT * FROM alive_memories").all() as unknown as DbRow[];
		const facts = rows.map(rowToFact);
		const byId = new Map(facts.map((fact) => [fact.id, fact]));
		const related = new Set<string>([id]);
		let changed = true;
		while (changed) {
			changed = false;
			for (const fact of facts) {
				if (related.has(fact.id) || fact.supersedes.some((previousId) => related.has(previousId))) {
					for (const linkedId of [fact.id, ...fact.supersedes]) {
						if (!related.has(linkedId)) { related.add(linkedId); changed = true; }
					}
				}
			}
		}
		return [...related].map((factId) => byId.get(factId)).filter((fact): fact is MemoryFact => fact !== undefined)
			.sort((left, right) => left.validFrom.localeCompare(right.validFrom));
	}

	async retain(facts: string[], scopes: string[]): Promise<RetainResult[]> {
		const normalizedScopes = [...new Set(scopes.map((scope) => scope.trim()).filter(Boolean))].sort();
		if (facts.length && !normalizedScopes.length) throw new Error("retain requires at least one scope for non-empty facts");
		const uniqueFacts = [...new Set(facts.map(cleanText).filter(Boolean))];
		const results: RetainResult[] = [];
		this.db.exec("BEGIN IMMEDIATE");
		try {
			for (const text of uniqueFacts) {
				const embedding = await this.embed(text);
				results.push(this.retainOne(text, embedding, normalizedScopes));
			}
			this.db.exec("COMMIT");
			return results;
		} catch (error) {
			this.db.exec("ROLLBACK");
			throw error;
		}
	}

	async close(): Promise<void> { this.db.close(); }

	private retainOne(text: string, embedding: number[], scopes: string[]): RetainResult {
		const rows = this.db.prepare("SELECT * FROM alive_memories WHERE active = 1").all() as unknown as DbRow[];
		const candidates = rows
			.map((row) => ({ fact: rowToFact(row), embedding: parseEmbedding(row.embedding) }))
			.filter(({ fact }) => fact.scopes.some((scope) => scopes.includes(scope)))
			.map(({ fact, embedding: candidate }) => ({ ...fact, similarity: cosineSimilarity(embedding, candidate) }))
			.sort((left, right) => (right.similarity ?? 0) - (left.similarity ?? 0))
			.slice(0, 8);
		const exact = candidates.find((candidate) => normalize(candidate.text) === normalize(text) && sameScopes(candidate.scopes, scopes));
		if (exact) return { status: "unchanged", fact: exact };

		// Revision must not widen visibility by inheriting scopes from a different
		// audience (e.g. one agent's private scope plus a shared project scope).
		const replaced = candidates.filter((candidate) => (candidate.similarity ?? 0) >= this.config.revisionThreshold && sameScopes(candidate.scopes, scopes));
		const id = randomUUID();
		const now = new Date().toISOString();
		const supersedes = replaced.map((fact) => fact.id);
		const effectiveScopes = [...new Set([...scopes, ...replaced.flatMap((fact) => fact.scopes)])].sort();
		if (supersedes.length) {
			const update = this.db.prepare("UPDATE alive_memories SET active = 0, valid_to = ? WHERE id = ?");
			for (const oldId of supersedes) update.run(now, oldId);
		}
		this.db.prepare(`
			INSERT INTO alive_memories (id, text, embedding, scopes, created_at, valid_from, active, supersedes)
			VALUES (?, ?, ?, ?, ?, ?, 1, ?)
		`).run(id, text, JSON.stringify(embedding), JSON.stringify(effectiveScopes), now, now, JSON.stringify(supersedes));
		const fact: MemoryFact = { id, text, scopes: effectiveScopes, createdAt: now, validFrom: now, active: true, supersedes };
		return { status: supersedes.length ? "revised" : "added", fact };
	}

	private async embed(text: string): Promise<number[]> {
		const base = this.config.embeddingBaseUrl.replace(/\/+$/, "");
		const cloudflare = this.config.embeddingProvider === "cloudflare";
		const response = await fetch(
			cloudflare ? `${base}/${this.config.embeddingModel}` : `${base}/embeddings`,
			{
				method: "POST",
				headers: {
					"content-type": "application/json",
					...(this.config.embeddingApiKey ? { authorization: `Bearer ${this.config.embeddingApiKey}` } : {}),
				},
				body: JSON.stringify(cloudflare
					? { text: [text] }
					: { model: this.config.embeddingModel, input: text }),
			},
		);
		if (!response.ok) throw new Error(`Embedding request failed (${response.status}): ${(await response.text()).slice(0, 500)}`);
		const payload = await response.json() as {
			data?: Array<{ embedding?: number[] }>;
			result?: { data?: number[][] };
		};
		const embedding = cloudflare ? payload.result?.data?.[0] : payload.data?.[0]?.embedding;
		if (!embedding || embedding.length !== this.config.embeddingDimensions || embedding.some((value) => !Number.isFinite(value))) {
			throw new Error(`Embedding response must contain ${this.config.embeddingDimensions} finite dimensions`);
		}
		return embedding;
	}
}

interface DbRow {
	id: string;
	text: string;
	embedding: string;
	scopes: string;
	created_at: string;
	valid_from: string;
	valid_to: string | null;
	active: number;
	supersedes: string;
}

function cleanText(text: string): string { return text.trim().replace(/\s+/g, " "); }
function normalize(text: string): string { return text.toLocaleLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ").trim(); }
function parseEmbedding(value: string): number[] { return JSON.parse(value) as number[]; }
function cosineSimilarity(left: number[], right: number[]): number {
	if (left.length !== right.length || left.length === 0) return 0;
	let dot = 0;
	let leftNorm = 0;
	let rightNorm = 0;
	for (let index = 0; index < left.length; index++) {
		dot += left[index] * right[index];
		leftNorm += left[index] * left[index];
		rightNorm += right[index] * right[index];
	}
	return leftNorm && rightNorm ? dot / Math.sqrt(leftNorm * rightNorm) : 0;
}
function sameScopes(left: string[], right: string[]): boolean { return left.length === right.length && left.every((scope) => right.includes(scope)); }
function rowToFact(row: DbRow): MemoryFact {
	return {
		id: row.id,
		text: row.text,
		scopes: JSON.parse(row.scopes) as string[],
		createdAt: row.created_at,
		validFrom: row.valid_from,
		validTo: row.valid_to ?? undefined,
		active: row.active === 1,
		supersedes: JSON.parse(row.supersedes) as string[],
	};
}
