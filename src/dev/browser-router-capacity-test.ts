import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { loadConfig } from "../config.js";
import { ModuleHost } from "../events/host.js";
import { Logger } from "../log.js";
import { BrowserRouter } from "../modules/browser/router.js";
import { EventStore } from "../store/events.js";
import { HistoryStore } from "../store/history.js";

const root = fs.mkdtempSync(path.join(os.tmpdir(), "alive-browser-capacity-"));
const initial = loadConfig({ cwd: root });
const users = Array.from({ length: 12 }, (_, index) => String(index + 1));
const loaded = loadConfig({ cwd: root, overrides: { modules: { ...initial.config.modules, telegram: { ...initial.config.modules.telegram, enabled: true, token: "fixture-only", allowedUserIds: users, allowedChatIds: [] } } } });
let scope: string[] = [], attempts = 0;
const router = new BrowserRouter({ port: 0, humanization: { ...initial.config.modules.browser?.humanization, enabled: false, minDelayMs: 0, maxDelayMs: 0, minTypingDelayMs: 0, maxTypingDelayMs: 0 } }, { launch: async () => { attempts++; throw new Error("Fixture browser unavailable"); } });
const events = EventStore.open(loaded.paths.stateDir), history = HistoryStore.open(loaded.paths.stateDir);
const host = new ModuleHost({ config: loaded, log: new Logger({ console: false, level: "error" }), modules: [router], transports: [], ingest: input => events.append(input), outbox: () => [], history, runtimeStatus: () => ({}), currentThreads: () => scope });
try {
	await host.init();
	for (const user of users) {
		scope = [`telegram:${user}`];
		const status = await router.command({ action: "status" });
		assert.equal(status.details.open, false); assert.equal(status.isError, undefined);
	}
	assert.deepEqual(router.status().sessions, [], "Status must not allocate listeners or count against capacity");
	for (const user of users) {
		scope = [`telegram:${user}`];
		const failed = await router.command({ action: "navigate", url: "https://fixture.test/" });
		assert.match(String(failed.details.error), /Fixture browser unavailable/);
		assert.deepEqual(router.status().sessions, [], "Failed startup must release its empty router session");
	}
	assert.equal(attempts, users.length, "Every user reaches startup instead of hitting a leaked capacity limit");
	scope = ["telegram:1"];
	const failed = await Promise.all([router.command({ action: "navigate", url: "https://fixture.test/" }), router.command({ action: "navigate", url: "https://fixture.test/" })]);
	assert.ok(failed.every(result => result.isError)); assert.deepEqual(router.status().sessions, []);
	console.log("browser-router capacity: status is allocation-free; failed and concurrent starts release empty sessions");
} finally { await host.stop(); fs.rmSync(root, { recursive: true, force: true }); }
