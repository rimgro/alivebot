import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { MemoryStore } from "../store/memory.js";

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "alive-memory-test-"));
const databasePath = path.join(tempDir, "memory.sqlite");
const originalFetch = globalThis.fetch;
const requests: Array<{ url: string; body: unknown; authorization: string | null }> = [];
globalThis.fetch = async (input, init) => {
	const headers = new Headers(init?.headers);
	requests.push({ url: String(input), body: JSON.parse(String(init?.body)), authorization: headers.get("authorization") });
	return new Response(JSON.stringify({ result: { data: [[1, 0, 0]] } }), { status: 200 });
};

const config = {
	databasePath,
	embeddingProvider: "cloudflare" as const,
	embeddingBaseUrl: "https://api.cloudflare.com/client/v4/accounts/test/ai/run",
	embeddingApiKey: "test-token",
	embeddingModel: "@cf/qwen/qwen3-embedding-0.6b",
	embeddingDimensions: 3,
	revisionThreshold: 0.82,
};

try {
	assert.throws(
		() => new MemoryStore({ ...config, embeddingApiKey: "" }),
		/CLOUDFLARE_API_TOKEN/,
	);
	const store = new MemoryStore(config);
	await store.init();
	const added = await store.retain(["old fact"], ["user:test"]);
	assert.equal(added[0].status, "added");
	const unchanged = await store.retain(["old fact"], ["user:test"]);
	assert.equal(unchanged[0].status, "unchanged");
	const revised = await store.retain(["new fact"], ["user:test"]);
	assert.equal(revised[0].status, "revised");
	assert.equal(revised[0].fact.supersedes[0], added[0].fact.id);
	const results = await store.search("query", 6, ["user:test"]);
	assert.equal(results[0].id, revised[0].fact.id);
	assert.equal(results[0].similarity, 1);
	const history = await store.history(revised[0].fact.id);
	assert.deepEqual(history.map((fact) => fact.id), [added[0].fact.id, revised[0].fact.id]);
	// Shared scope does not merge a distinct agent's private audience through revision.
	const agentA = await store.retain(["private fact A"], ["agent:a", "project:shared"]);
	const agentB = await store.retain(["private fact B"], ["agent:b", "project:shared"]);
	assert.equal(agentA[0].status, "added");
	assert.equal(agentB[0].status, "added");
	assert.deepEqual(agentB[0].fact.supersedes, []);
	assert.ok(!(await store.search("query", 10, ["agent:b"])).some((fact) => fact.id === agentA[0].fact.id));
	assert.ok((await store.search("query", 10, ["project:shared"])).some((fact) => fact.id === agentA[0].fact.id));
	assert.equal(requests[0].url, `${config.embeddingBaseUrl}/${config.embeddingModel}`);
	assert.deepEqual(requests[0].body, { text: ["old fact"] });
	assert.equal(requests[0].authorization, "Bearer test-token");
	await store.close();

	const reopened = new MemoryStore(config);
	await reopened.init();
	assert.equal((await reopened.search("query", 6, ["user:test"]))[0].id, revised[0].fact.id);
	await reopened.close();
	console.log("memory tests passed");
} finally {
	globalThis.fetch = originalFetch;
	fs.rmSync(tempDir, { recursive: true, force: true });
}
