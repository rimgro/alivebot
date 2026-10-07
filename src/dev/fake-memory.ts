import type { MemoryFact, MemoryService, RetainResult } from "../store/memory.js";

/** In-memory test double for runtime/tool lifecycle tests (production uses SQLite). */
export class FakeMemoryStore implements MemoryService {
	readonly retained: RetainResult[] = [];
	async search(): Promise<MemoryFact[]> { return []; }
	async history(): Promise<MemoryFact[]> { return []; }
	async retain(facts: string[], scopes: string[]): Promise<RetainResult[]> {
		const results = facts.map((text) => {
			const now = new Date().toISOString();
			return {
				status: "added" as const,
				fact: { id: `test-${this.retained.length + 1}`, text, scopes, createdAt: now, validFrom: now, active: true, supersedes: [] },
			};
		});
		this.retained.push(...results);
		return results;
	}
	async close(): Promise<void> {}
}
