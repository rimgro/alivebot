/**
 * End-to-end smoke test on a real model.
 *
 *   npm run smoke
 *
 * It creates a throwaway state dir, injects one user message, runs exactly one
 * run (the agent answers, then sleeps) and asserts that the agent reached a human
 * through the `send_message` tool. This is the proof that the continuous
 * idle/sleep loop + tool-output discipline works, not just that the code
 * typechecks.
 */
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { loadConfig } from "../config.js";
import { Logger } from "../log.js";
import { AliveRuntime } from "../runtime/loop.js";
import { EventStore } from "../store/events.js";
import { Outbox } from "../store/outbox.js";

const root = fs.mkdtempSync(path.join(os.tmpdir(), "alive-smoke-"));
const config = loadConfig({
	cwd: root,
	overrides: {
		model: process.env.ALIVE_MODEL ?? "",
		verbose: process.env.ALIVE_VERBOSE === "1",
		chat: { console: false, http: { enabled: false, host: "127.0.0.1", port: 0, token: "" } },
		loop: {
			pollIntervalMs: 100,
			sleepAfterMs: 5_000,
			runTimeoutMs: 120_000,
			maxEventsPerIdle: 4,
			maxNudges: 3,
			maxNudgesPerRun: 5,
			interrupt: true,
		},
	},
});
const log = new Logger({ file: config.paths.logFile, console: true, level: "info", scope: "smoke" });

log.info("smoke root", { root, stateDir: config.paths.stateDir });

const store = EventStore.open(config.paths.stateDir);
store.append({
	kind: "user_message",
	source: "smoke",
	priority: "high",
	title: "smoke test message",
	text:
		"Reply with exactly: pong, using send_message. Then write a one-line journal entry and call " +
		"sleep with a short summary. Do not do anything else.",
	thread: "console",
	expectsReply: true,
});

const runtime = await AliveRuntime.create({ config, log });
await runtime.init();
const record = await runtime.runOnce();
await runtime.stop("smoke");

const messages = new Outbox(config.paths.stateDir).list(10);
const thoughts = fs.existsSync(config.paths.thoughtsFile)
	? fs.readFileSync(config.paths.thoughtsFile, "utf8").trim().split("\n").length
	: 0;

log.info("smoke result", {
	run: record ? `#${record.index} ${record.stopReason}` : "(no run)",
	turns: record?.turns,
	idleReturns: record?.idleReturns,
	outbound: messages.length,
	thoughtRecords: thoughts,
	stateDir: config.paths.stateDir,
});

if (messages.length === 0) {
	log.error("FAIL: the agent produced no send_message output");
	process.exitCode = 1;
} else {
	for (const message of messages) {
		process.stdout.write(`delivered to ${message.thread}: ${message.text}\n`);
	}
	log.info("PASS: messages as tool use, text output kept private", { stateDir: config.paths.stateDir });
}
