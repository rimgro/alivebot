import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { createAgent } from "../agents.js";
import { DEFAULT_CONTRACT, loadConfig, writeDefaultConfig } from "../config.js";
import { buildSystemPrompt } from "../runtime/prompt.js";
import { readContract } from "../runtime/session.js";
import { privateMemoryScope, retainedMemoryScopes, searchableMemoryScopes } from "../runtime/memory-access.js";

const root = fs.mkdtempSync(path.join(os.tmpdir(), "alive-onboarding-test-"));
try {
	writeDefaultConfig(root);
	const base = loadConfig({ cwd: root });
	fs.writeFileSync(base.paths.contractPath, "# My personal operator preferences\nUse my private casual style.", "utf8");
	const child = createAgent(base, "researcher", "Researcher");
	const contract = fs.readFileSync(path.join(child.directory, "CONTRACT.md"), "utf8");
	assert.ok(contract.startsWith(`# Role: Agent Researcher\n\n${DEFAULT_CONTRACT}`));
	assert.ok(!contract.includes("private casual style"));
	const childConfig = JSON.parse(fs.readFileSync(child.configPath, "utf8")) as { memory: { databasePath: string; sharedScopes: string[] } };
	assert.equal(childConfig.memory.databasePath, path.join(base.paths.stateDir, "memory.sqlite"));
	assert.deepEqual(childConfig.memory.sharedScopes, []);

	const editableContract = "# Research contract\n\nOwn research on supply-chain security; prefer concise Russian replies.";
	fs.writeFileSync(path.join(child.directory, "CONTRACT.md"), editableContract, "utf8");
	const prompt = buildSystemPrompt({
		name: "Researcher",
		soul: "You are a research agent.",
		contract: readContract(path.join(child.directory, "CONTRACT.md")),
		workspace: child.directory,
		stateDir: path.join(child.directory, "state"),
		runTimeoutMs: 60_000,
		sleepAfterMs: 600_000,
	});
	assert.ok(prompt.includes("# Your contract"));
	assert.ok(prompt.includes("Own research on supply-chain security"));
	assert.ok(prompt.includes("do not assume or inherit another agent's personal preferences"));

	const childLoaded = loadConfig({ cwd: root, configPath: child.configPath });
	const privateScope = privateMemoryScope(childLoaded);
	assert.match(privateScope, /^agent:[a-f0-9]{20}$/);
	assert.deepEqual(searchableMemoryScopes(childLoaded), [privateScope]);
	assert.deepEqual(retainedMemoryScopes(childLoaded, []), [privateScope]);
	assert.throws(() => searchableMemoryScopes(childLoaded, ["project:alive"]), /not allowlisted/);
	childLoaded.config.memory.sharedScopes = ["project:alive"];
	assert.deepEqual(searchableMemoryScopes(childLoaded, ["project:alive"]), [privateScope, "project:alive"].sort());
	assert.throws(() => retainedMemoryScopes(childLoaded, ["user:someone"]), /not allowlisted/);

	console.log("onboarding tests passed");
} finally {
	fs.rmSync(root, { recursive: true, force: true });
}
