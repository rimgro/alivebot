import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { createAgent } from "../agents.js";
import { main } from "../cli.js";
import { loadConfig, writeDefaultConfig } from "../config.js";
import { EventStore } from "../store/events.js";
import { HistoryStore } from "../store/history.js";
import { Outbox } from "../store/outbox.js";
import { sendLocalAgentMessage } from "../runtime/agent-messaging.js";

const root = fs.mkdtempSync(path.join(os.tmpdir(), "alive-agent-messaging-"));
try {
	const initialized = writeDefaultConfig(root);
	const base = loadConfig({ cwd: root, configPath: initialized.configPath });
	const sender = createAgent(base, "researcher", "Researcher");
	const recipient = createAgent(base, "writer", "Writer");
	const senderConfig = loadConfig({ cwd: root, configPath: sender.configPath });
	const recipientConfig = loadConfig({ cwd: root, configPath: recipient.configPath });

	const outgoing = await sendLocalAgentMessage({
		config: senderConfig,
		outbox: new Outbox(senderConfig.paths.stateDir),
		to: "writer",
		text: "Please summarize the latest research.",
		runId: "run-researcher-1",
	});
	assert.equal(outgoing.recipientAgentId, "writer", "recipient is explicit and not parsed from the conversation thread");
	assert.match(outgoing.thread, /agent:researcher:agent:writer/, "thread only identifies the pair conversation");

	const inbox = EventStore.open(recipientConfig.paths.stateDir);
	assert.equal(inbox.pendingCount(), 1, "recipient inbox event persists and is pending after reopening the store");
	const event = inbox.peekPending(1)[0]!;
	assert.equal(event.id, outgoing.id);
	assert.equal(event.source, "local-messenger");
	assert.equal(event.thread, outgoing.thread);
	assert.equal(event.meta?.senderId, "researcher");
	assert.equal(event.meta?.recipientAgentId, "writer");
	assert.equal(event.text, "Please summarize the latest research.");

	const recipientHistory = HistoryStore.open(recipientConfig.paths.stateDir).query({ module: "local" });
	const senderHistory = HistoryStore.open(senderConfig.paths.stateDir).query({ module: "local" });
	assert.equal(recipientHistory.length, 1);
	assert.equal(senderHistory.length, 1);
	assert.equal(recipientHistory[0]?.id, outgoing.id);
	assert.equal(recipientHistory[0]?.direction, "inbound");
	assert.equal(recipientHistory[0]?.authorId, "researcher");
	assert.equal(senderHistory[0]?.direction, "outbound");
	assert.equal(senderHistory[0]?.thread, recipientHistory[0]?.thread);

	const outboxEntry = new Outbox(senderConfig.paths.stateDir).list(1)[0];
	assert.equal(outboxEntry?.recipientAgentId, "writer", "sender outbox durably records the addressed recipient");
	assert.equal(outboxEntry?.senderId, "researcher");

	await assert.rejects(() => sendLocalAgentMessage({
		config: senderConfig,
		outbox: new Outbox(senderConfig.paths.stateDir),
		to: "local:agent:researcher:agent:writer",
		text: "This conversation id is not an agent recipient.",
		runId: "run-researcher-2",
	}), /agent id must match|unknown managed agent/);
	assert.equal(EventStore.open(recipientConfig.paths.stateDir).pendingCount(), 1, "invalid routing id does not write to a recipient inbox");

	const originalCwd = process.cwd();
	process.chdir(root);
	try {
		assert.equal(await main(["agents", "send", "writer", "Hello from the operator.", "--config", initialized.configPath]), 0);
		assert.equal(await main(["agents", "inbox", "writer", "--n", "10", "--config", initialized.configPath]), 0);
	} finally {
		process.chdir(originalCwd);
	}
	const afterCli = EventStore.open(recipientConfig.paths.stateDir);
	assert.equal(afterCli.pendingCount(), 2, "CLI send routes to the selected agent inbox");
	assert.equal(afterCli.peekPending(2)[1]?.meta?.senderId, "operator", "CLI inbox event preserves human sender identity");

	console.log("agent messaging tests passed");
} finally {
	fs.rmSync(root, { recursive: true, force: true });
}
