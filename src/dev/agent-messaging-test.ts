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
import { sendLocalAgentMessage, managedAgentId, resolveRootProfile } from "../runtime/agent-messaging.js";
import { createAliveTools, type RunHandle, type ToolDeps } from "../runtime/tools.js";

const root = fs.mkdtempSync(path.join(os.tmpdir(), "alive-agent-messaging-"));
try {
	const initialized = writeDefaultConfig(root);
	const base = loadConfig({ cwd: root, configPath: initialized.configPath });
	assert.equal(base.config.rootConfigPath, "", "the root profile does not point at another root profile");
	const sender = createAgent(base, "researcher", "Researcher");
	const recipient = createAgent(base, "writer", "Writer");
	const senderConfig = loadConfig({ cwd: root, configPath: sender.configPath });
	const recipientConfig = loadConfig({ cwd: root, configPath: recipient.configPath });
	const mainConfig = loadConfig({ cwd: root, configPath: initialized.configPath });
	assert.equal(senderConfig.config.rootConfigPath, initialized.configPath, "managed profiles record the root profile config path");

	// --- managed -> managed (unchanged contract) ---
	const outgoing = await sendLocalAgentMessage({
		config: senderConfig,
		outbox: new Outbox(senderConfig.paths.stateDir),
		to: "writer",
		text: "Please summarize the latest research.",
		runId: "run-researcher-1",
	});
	assert.equal(outgoing.recipientAgentId, "writer", "recipient is explicit and not parsed from the conversation thread");
	assert.equal(outgoing.thread, "local:agent:researcher:agent:writer", "agent threads put the sender first");

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

	// --- managed -> main: the root profile is not a managed agent, but must receive like one ---
	const mainThread = "local:agent:researcher:agent:main";
	const toMain = await sendLocalAgentMessage({
		config: senderConfig,
		outbox: new Outbox(senderConfig.paths.stateDir),
		to: "main",
		text: "Research is ready for the root agent.",
		runId: "run-researcher-main",
	});
	assert.equal(toMain.recipientAgentId, "main", "main is the canonical root recipient id");
	assert.equal(toMain.senderId, "researcher", "a managed sender keeps its own id, never the main fallback");
	assert.equal(toMain.thread, mainThread, "direction is sender first, so main-as-recipient is not reversed");
	assert.notEqual(toMain.thread, "local:agent:main:agent:researcher", "a reply to main is not recorded as a main message");

	const mainInbox = EventStore.open(mainConfig.paths.stateDir);
	const mainEvent = mainInbox.peekPending(20).find((item) => item.id === toMain.id);
	assert.ok(mainEvent, "the event lands in the root profile's event store");
	assert.equal(mainEvent.source, "local-messenger");
	assert.equal(mainEvent.kind, "user_message");
	assert.equal(mainEvent.expectsReply, true, "main is expected to reply");
	assert.equal(mainEvent.thread, mainThread);
	assert.equal(mainEvent.text, "Research is ready for the root agent.");
	assert.equal(mainEvent.meta?.senderId, "researcher");
	assert.equal(mainEvent.meta?.recipientAgentId, "main");
	assert.equal(fs.existsSync(path.join(root, ".alive", "agents", "main")), false, "main is not invented as a managed agent directory");

	const mainInbound = HistoryStore.open(mainConfig.paths.stateDir).query({ module: "local", thread: mainThread });
	assert.equal(mainInbound.length, 1, "main's history has the inbound message");
	assert.equal(mainInbound[0]?.id, toMain.id);
	assert.equal(mainInbound[0]?.direction, "inbound");
	assert.equal(mainInbound[0]?.authorId, "researcher");
	const senderOutbound = HistoryStore.open(senderConfig.paths.stateDir).query({ module: "local", thread: mainThread });
	assert.equal(senderOutbound.length, 1, "the sender's history has the outbound message");
	assert.equal(senderOutbound[0]?.id, toMain.id);
	assert.equal(senderOutbound[0]?.direction, "outbound", "the sender side is outbound, not inbound");
	assert.equal(senderOutbound[0]?.authorId, "researcher");
	assert.equal(senderOutbound[0]?.thread, mainInbound[0]?.thread);

	const outboxToMain = new Outbox(senderConfig.paths.stateDir).list(20).find((message) => message.id === toMain.id);
	assert.equal(outboxToMain?.recipientAgentId, "main", "outbox keeps the message and its recipient");
	assert.equal(outboxToMain?.senderId, "researcher");
	assert.equal(outboxToMain?.text, "Research is ready for the root agent.");

	// --- main -> managed: regression, the root sender is main ---
	const fromMain = await sendLocalAgentMessage({
		config: mainConfig,
		outbox: new Outbox(mainConfig.paths.stateDir),
		to: "writer",
		text: "Please double-check the summary.",
		runId: "run-main-writer",
	});
	assert.equal(fromMain.senderId, "main", "the root profile sends as main");
	assert.equal(fromMain.recipientAgentId, "writer");
	assert.equal(fromMain.thread, "local:agent:main:agent:writer");
	const writerEvent = EventStore.open(recipientConfig.paths.stateDir).peekPending(20).find((item) => item.id === fromMain.id);
	assert.ok(writerEvent, "managed recipients still receive root messages");
	assert.equal(writerEvent.meta?.senderId, "main");
	assert.equal(writerEvent.thread, fromMain.thread);
	const writerInbound = HistoryStore.open(recipientConfig.paths.stateDir).query({ module: "local", thread: fromMain.thread });
	assert.deepEqual(writerInbound.map((message) => message.direction), ["inbound"]);
	assert.equal(writerInbound[0]?.authorId, "main");
	const mainOutbound = HistoryStore.open(mainConfig.paths.stateDir).query({ module: "local", thread: fromMain.thread });
	assert.deepEqual(mainOutbound.map((message) => message.direction), ["outbound"]);
	assert.equal(mainOutbound[0]?.authorId, "main");

	// --- legacy profiles without rootConfigPath still resolve main from the shared registry ---
	const senderRaw = JSON.parse(fs.readFileSync(sender.configPath, "utf8"));
	delete senderRaw.rootConfigPath;
	fs.writeFileSync(sender.configPath, `${JSON.stringify(senderRaw, null, 2)}\n`);
	const legacySenderConfig = loadConfig({ cwd: root, configPath: sender.configPath });
	assert.equal(legacySenderConfig.config.rootConfigPath, "");
	const inferred = await sendLocalAgentMessage({
		config: legacySenderConfig,
		outbox: new Outbox(legacySenderConfig.paths.stateDir),
		to: "main",
		text: "Second reply from a profile without rootConfigPath.",
		runId: "run-researcher-main-2",
	});
	assert.equal(inferred.recipientAgentId, "main");
	assert.equal(inferred.thread, mainThread);
	assert.ok(EventStore.open(mainConfig.paths.stateDir).peekPending(20).some((item) => item.id === inferred.id), "main still resolves without the explicit root config path");

	// --- unknown recipients are errors, and the attempt is still in the outbox ---
	const mainPendingBeforeUnknown = EventStore.open(mainConfig.paths.stateDir).pendingCount();
	await assert.rejects(() => sendLocalAgentMessage({
		config: legacySenderConfig,
		outbox: new Outbox(legacySenderConfig.paths.stateDir),
		to: "nobody",
		text: "This recipient does not exist.",
		runId: "run-researcher-unknown",
	}), /unknown managed agent: nobody/);
	assert.equal(EventStore.open(mainConfig.paths.stateDir).pendingCount(), mainPendingBeforeUnknown, "an unknown recipient writes nothing to any inbox");

	await assert.rejects(() => sendLocalAgentMessage({
		config: senderConfig,
		outbox: new Outbox(senderConfig.paths.stateDir),
		to: "local:agent:researcher:agent:writer",
		text: "This conversation id is not an agent recipient.",
		runId: "run-researcher-2",
	}), /agent id must match|unknown managed agent/);
	assert.equal(EventStore.open(recipientConfig.paths.stateDir).pendingCount(), 2, "invalid routing id does not write to a recipient inbox");

	// An already-open (idle) main inbox is polled, not reopened: the append alone wakes it.
	const idleInbox = EventStore.open(mainConfig.paths.stateDir);
	idleInbox.beginRun("run-main-idle");
	idleInbox.claim(100);
	idleInbox.ack();
	assert.deepEqual(idleInbox.claim(10), [], "a caught-up idle inbox has nothing pending");
	const wake = await sendLocalAgentMessage({
		config: senderConfig,
		outbox: new Outbox(senderConfig.paths.stateDir),
		to: "main",
		text: "Wake the idle root agent.",
		runId: "run-researcher-wake",
	});
	assert.deepEqual(idleInbox.claim(10).map((item) => item.id), [wake.id], "the open idle inbox receives the new local message on its next poll");
	idleInbox.endRun();

	// A managed profile that cannot establish its own identity must not claim to be main.
	// Corrupting its agents registry makes it unlisted while it is still a managed profile.
	const orphanDirectory = path.join(root, ".alive", "agents", "orphan");
	fs.mkdirSync(orphanDirectory, { recursive: true });
	const orphanConfigPath = path.join(orphanDirectory, "alive.config.json");
	fs.writeFileSync(orphanConfigPath, `${JSON.stringify({
		...senderRaw,
		stateDir: path.join(orphanDirectory, "state"),
		agentsDirectory: path.join(root, ".alive", "missing-agents"),
	}, null, 2)}\n`);
	const orphanConfig = loadConfig({ cwd: root, configPath: orphanConfigPath });
	await assert.rejects(() => sendLocalAgentMessage({
		config: orphanConfig,
		outbox: new Outbox(orphanConfig.paths.stateDir),
		to: "writer",
		text: "An unregistered profile must not impersonate main.",
		runId: "run-orphan",
	}), /cannot determine the sending agent/);

	// --- message_agent tool: delivered only after the recipient inbox stored the event ---
	const run = { id: "run-tool", outbound: [] } as unknown as RunHandle;
	const recorded: Array<{ thread: string; ts: number }> = [];
	const logEntries: Array<{ level: string; msg: string; data?: Record<string, unknown> }> = [];
	const captureLog = {
		debug: (msg: string, data?: Record<string, unknown>) => logEntries.push({ level: "debug", msg, data }),
		info: (msg: string, data?: Record<string, unknown>) => logEntries.push({ level: "info", msg, data }),
		warn: (msg: string, data?: Record<string, unknown>) => logEntries.push({ level: "warn", msg, data }),
		error: () => {},
	};
	const deps = {
		config: senderConfig,
		outbox: new Outbox(senderConfig.paths.stateDir),
		store: EventStore.open(senderConfig.paths.stateDir),
		threads: { recordOutbound: (thread: string, ts: number) => recorded.push({ thread, ts }) },
		moduleTools: [],
		getRun: () => run,
		log: { child: () => captureLog },
	} as unknown as ToolDeps;
	const messageTool = createAliveTools(deps).find((tool) => tool.name === "message_agent");
	assert.ok(messageTool, "message_agent is registered");
	const result = await messageTool.execute("call-1", { to: "main", text: "Tool-delivered reply to main." }, undefined, undefined, undefined as never);
	const details = result.details as Record<string, unknown>;
	assert.equal(details.delivered, true, "the tool reports delivery only from the delivery result");
	const deliveredId = details.messageId;
	assert.equal(typeof deliveredId, "string");
	assert.ok(EventStore.open(mainConfig.paths.stateDir).peekPending(20).some((item) => item.id === deliveredId), "the tool result corresponds to a stored inbox event");
	assert.equal(run.outbound.length, 1, "a successful delivery is recorded in the run outbound list");
	assert.equal(run.outbound[0]?.delivered, true);
	assert.equal(recorded.length, 1);

	// The routing trace names both ids, the absolute inbox and the event id, never the text.
	const routed = logEntries.find((entry) => entry.msg === "message_agent resolved local delivery");
	assert.ok(routed, "every message_agent resolution is logged");
	assert.equal(routed.level, "info");
	assert.equal(routed.data?.to, "main");
	assert.equal(routed.data?.senderId, "researcher");
	assert.equal(routed.data?.recipientId, "main");
	assert.equal(routed.data?.inbox, path.join(mainConfig.paths.stateDir, "inbox"), "the log names the absolute inbox that received the event");
	assert.equal(routed.data?.eventId, deliveredId);
	assert.equal(routed.data?.thread, "local:agent:researcher:agent:main");
	assert.equal(JSON.stringify(logEntries).includes("Tool-delivered reply to main."), false, "the routing log never contains message text");

	await assert.rejects(() => messageTool.execute("call-2", { to: "nobody", text: "lost" }, undefined, undefined, undefined as never), /could not deliver to nobody: unknown managed agent: nobody/);
	assert.equal(run.outbound.length, 1, "a failed delivery is not recorded as delivered");
	const failed = logEntries.filter((entry) => entry.msg === "message_agent resolution failed").at(-1);
	assert.ok(failed, "a failed resolution is logged with its reason");
	assert.equal(failed.level, "warn");
	assert.equal(failed.data?.to, "nobody");
	assert.equal(failed.data?.senderId, "researcher", "the failed trace still names the resolved sender");
	assert.equal(failed.data?.recipientId, undefined);
	assert.equal(failed.data?.inbox, undefined);
	assert.match(String(failed.data?.reason), /unknown managed agent: nobody/);
	assert.equal(JSON.stringify(logEntries).includes("lost"), false, "a failed routing log never contains message text");

	// --- #148: a managed profile that lives in a registry messages the root, not itself ---
	const registryRoot = fs.mkdtempSync(path.join(os.tmpdir(), "alive-agent-messaging-registry-"));
	try {
		const registryInit = writeDefaultConfig(registryRoot);
		const registryRaw = JSON.parse(fs.readFileSync(registryInit.configPath, "utf8"));
		// The shared registry lives at `<root>/agents`, so the root profile declares it.
		registryRaw.agentsDirectory = "agents";
		fs.writeFileSync(registryInit.configPath, `${JSON.stringify(registryRaw, null, 2)}\n`);
		const registryMain = loadConfig({ cwd: registryRoot, configPath: registryInit.configPath });

		// A managed profile as it exists in the field: only its private state directory
		// is configured locally, so `agentsDirectory` stays at the state-dir default and
		// `agentsRoot()` points inside the profile. That hid the registry it lives in (#148).
		const farmDirectory = path.join(registryRoot, "agents", "farm-analyst");
		fs.mkdirSync(farmDirectory, { recursive: true });
		const farmConfigPath = path.join(farmDirectory, "alive.config.json");
		const farmRaw = {
			...registryRaw,
			name: "Farm Analyst",
			stateDir: "state",
			agentsDirectory: "",
			rootConfigPath: registryInit.configPath,
		};
		fs.writeFileSync(farmConfigPath, `${JSON.stringify(farmRaw, null, 2)}\n`);
		const farmConfig = loadConfig({ cwd: farmDirectory, configPath: farmConfigPath });
		const writerDirectory = path.join(registryRoot, "agents", "writer");
		fs.mkdirSync(writerDirectory, { recursive: true });
		const writerConfigPath = path.join(writerDirectory, "alive.config.json");
		fs.writeFileSync(writerConfigPath, `${JSON.stringify({ ...farmRaw, name: "Writer" }, null, 2)}\n`);
		const fixtureWriter = loadConfig({ cwd: writerDirectory, configPath: writerConfigPath });
		assert.equal(managedAgentId(farmConfig), "farm-analyst", "the profile identity comes from the registry that contains it");
		assert.equal(
			path.resolve(resolveRootProfile(farmConfig)?.paths.configPath ?? ""),
			path.resolve(registryMain.paths.configPath),
			"the root is the profile that owns the registry, never the managed profile itself",
		);

		const farmToMain = await sendLocalAgentMessage({
			config: farmConfig,
			outbox: new Outbox(farmConfig.paths.stateDir),
			to: "main",
			text: "Farm report for the root agent.",
			runId: "run-farm-main",
		});
		assert.equal(farmToMain.senderId, "farm-analyst", "the managed sender keeps its own identity, not main");
		assert.equal(farmToMain.recipientAgentId, "main");
		assert.equal(farmToMain.thread, "local:agent:farm-analyst:agent:main", "the farm -> main thread is not reversed");

		const farmEvent = EventStore.open(registryMain.paths.stateDir).peekPending(20).find((item) => item.id === farmToMain.id);
		assert.ok(farmEvent, "the event lands in the root profile inbox, not the sender inbox");
		assert.equal(farmEvent.source, "local-messenger");
		assert.equal(farmEvent.thread, "local:agent:farm-analyst:agent:main");
		assert.equal(farmEvent.meta?.senderId, "farm-analyst");
		assert.equal(farmEvent.meta?.recipientAgentId, "main");
		assert.equal(
			EventStore.open(farmConfig.paths.stateDir).peekPending(20).some((item) => item.id === farmToMain.id),
			false,
			"the message is not delivered back into the sender's own inbox",
		);
		const farmOutbox = new Outbox(farmConfig.paths.stateDir).list(5).find((message) => message.id === farmToMain.id);
		assert.equal(farmOutbox?.recipientAgentId, "main", "the sender outbox records the addressed root recipient");
		assert.equal(farmOutbox?.senderId, "farm-analyst");

		// Peers in the same registry stay addressable from a registry-resident profile.
		const farmToWriter = await sendLocalAgentMessage({
			config: farmConfig,
			outbox: new Outbox(farmConfig.paths.stateDir),
			to: "writer",
			text: "Farm notes for the writer.",
			runId: "run-farm-writer",
		});
		assert.equal(farmToWriter.thread, "local:agent:farm-analyst:agent:writer");
		assert.ok(EventStore.open(fixtureWriter.paths.stateDir).peekPending(20).some((item) => item.id === farmToWriter.id), "managed peers are resolved through the same registry");
	} finally {
		fs.rmSync(registryRoot, { recursive: true, force: true });
	}

	// --- CLI operator send still routes to a managed agent inbox ---
	const originalCwd = process.cwd();
	process.chdir(root);
	try {
		assert.equal(await main(["agents", "send", "writer", "Hello from the operator.", "--config", initialized.configPath]), 0);
		assert.equal(await main(["agents", "inbox", "writer", "--n", "10", "--config", initialized.configPath]), 0);
	} finally {
		process.chdir(originalCwd);
	}
	const afterCli = EventStore.open(recipientConfig.paths.stateDir);
	assert.equal(afterCli.pendingCount(), 3, "CLI send routes to the selected agent inbox");
	const cliEvent = afterCli.peekPending(3).find((item) => item.meta?.senderId === "operator");
	assert.ok(cliEvent, "CLI inbox event preserves human sender identity");
	assert.equal(cliEvent.thread, "local:agent:writer:operator", "operator conversations keep their thread shape");

	console.log("agent messaging tests passed");
} finally {
	fs.rmSync(root, { recursive: true, force: true });
}
