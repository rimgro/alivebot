import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { createAgent } from "../agents.js";
import { main } from "../cli.js";
import { loadConfig, writeDefaultConfig } from "../config.js";
import { ModuleHost } from "../events/host.js";
import { Logger } from "../log.js";
import { EventStore } from "../store/events.js";
import { HistoryStore } from "../store/history.js";
import { Outbox } from "../store/outbox.js";
import {
	managedAgentId,
	redeliverLocalAgentMessage,
	resolveLocalRecipient,
	resolveRootProfile,
	sendLocalAgentMessage,
} from "../runtime/agent-messaging.js";
import { createAliveTools, type RunHandle, type ToolDeps } from "../runtime/tools.js";

/** Raw JSONL records, used to assert what the outbox actually persisted. */
function jsonlRecords(file: string): Array<Record<string, unknown>> {
	if (!fs.existsSync(file)) return [];
	return fs.readFileSync(file, "utf8").split("\n").filter((line) => line.trim()).map((line) => JSON.parse(line) as Record<string, unknown>);
}

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

	// The write must land in the exact state directory the recipient runtime
	// resolves, never in a re-derived nested one (`.../state/state/...`).
	const routedRecipient = resolveLocalRecipient(senderConfig, "writer");
	assert.equal(
		path.resolve(routedRecipient.config.paths.stateDir),
		path.resolve(recipientConfig.paths.stateDir),
		"routing and the recipient process resolve the same stateDir",
	);
	const recipientEventsFile = path.join(recipientConfig.paths.stateDir, "inbox", "events.jsonl");
	assert.ok(
		jsonlRecords(recipientEventsFile).some((record) => record.id === outgoing.id),
		"the event is physically present in the recipient's own events.jsonl",
	);
	assert.equal(fs.existsSync(path.join(recipient.directory, "state", "state", "inbox", "events.jsonl")), false, "delivery does not create a nested duplicate inbox");

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
	assert.ok(
		jsonlRecords(path.join(mainConfig.paths.stateDir, "inbox", "events.jsonl")).some((event) => event.id === toMain.id),
		"managed -> root writes the event into the root inbox file",
	);
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
		// The profile declares a relative `stateDir: "state"`; delivery must use the
		// path the writer process itself resolves, not a nested re-derivation.
		const routedWriter = resolveLocalRecipient(farmConfig, "writer");
		assert.equal(
			path.resolve(routedWriter.config.paths.stateDir),
			path.resolve(fixtureWriter.paths.stateDir),
			"managed -> managed uses the recipient profile's own stateDir",
		);
		assert.equal(path.resolve(fixtureWriter.paths.stateDir), path.resolve(path.join(writerDirectory, "state")), "relative stateDir resolves next to the recipient config");
		const farmToWriter = await sendLocalAgentMessage({
			config: farmConfig,
			outbox: new Outbox(farmConfig.paths.stateDir),
			to: "writer",
			text: "Farm notes for the writer.",
			runId: "run-farm-writer",
		});
		assert.equal(farmToWriter.thread, "local:agent:farm-analyst:agent:writer");
		assert.ok(EventStore.open(fixtureWriter.paths.stateDir).peekPending(20).some((item) => item.id === farmToWriter.id), "managed peers are resolved through the same registry");
		assert.ok(
			jsonlRecords(path.join(fixtureWriter.paths.stateDir, "inbox", "events.jsonl")).some((event) => event.id === farmToWriter.id),
			"the peer event is physically in the writer's own stateDir/inbox/events.jsonl",
		);
		assert.equal(fs.existsSync(path.join(writerDirectory, "state", "state", "inbox", "events.jsonl")), false, "no nested duplicate inbox is created for a peer");
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

	// --- #160: send_message must fail when no module/transport actually delivers ---
	const sendRun = { id: "run-send", outbound: [] } as unknown as RunHandle;
	const sendOutboxFile = path.join(senderConfig.paths.stateDir, "outbox", "messages.jsonl");
	const deliveryHost = new ModuleHost({
		config: senderConfig,
		log: new Logger({ console: false, level: "error", scope: "agent-messaging-test" }),
		transports: [],
		modules: [],
		ingest: (event) => EventStore.open(senderConfig.paths.stateDir).append(event),
		outbox: () => new Outbox(senderConfig.paths.stateDir).list(10),
		history: HistoryStore.open(senderConfig.paths.stateDir),
		runtimeStatus: () => ({}),
	});
	await deliveryHost.init();
	const sendDeps = {
		config: senderConfig,
		outbox: new Outbox(senderConfig.paths.stateDir),
		store: EventStore.open(senderConfig.paths.stateDir),
		history: HistoryStore.open(senderConfig.paths.stateDir),
		threads: { recordOutbound: (thread: string, ts: number) => recorded.push({ thread, ts }) },
		moduleTools: [],
		getRun: () => sendRun,
		deliver: (message: Parameters<ToolDeps["deliver"]>[0]) => deliveryHost.deliver(message),
		log: { child: () => captureLog },
	} as unknown as ToolDeps;
	const sendTool = createAliveTools(sendDeps).find((tool) => tool.name === "send_message");
	assert.ok(sendTool, "send_message is registered");

	await assert.rejects(
		() => sendTool!.execute("send-nobody", { thread: "telegram:no-claimer", text: "Nobody receives this." }, undefined, undefined, undefined as never),
		/no module or transport delivered message for thread "telegram:no-claimer"/,
	);
	const noisyRecords = jsonlRecords(sendOutboxFile);
	const noisyMessage = noisyRecords.filter((record) => record.type === "message" && record.text === "Nobody receives this.").at(-1);
	assert.ok(noisyMessage, "the failed attempt is still durable in the outbox");
	const noisyDelivery = noisyRecords.find((record) => record.type === "delivery" && record.messageId === noisyMessage.id);
	assert.equal(noisyDelivery?.ok, false, "an undelivered send_message records ok:false");
	assert.match(String(noisyDelivery?.error), /telegram:no-claimer/);
	assert.equal(sendRun.outbound.length, 0, "an undelivered send_message is not recorded as an outbound delivery");

	// A local agent conversation is not an address: refuse it before the outbox.
	const writerEventsBeforeSendRefusal = jsonlRecords(recipientEventsFile).length;
	await assert.rejects(
		() => sendTool!.execute("send-local", { thread: "local:agent:researcher:agent:writer", text: "Use message_agent instead." }, undefined, undefined, undefined as never),
		/use message_agent for agent-to-agent messages/,
	);
	assert.equal(jsonlRecords(recipientEventsFile).length, writerEventsBeforeSendRefusal, "a refused local thread writes nothing to the recipient inbox");
	assert.equal(
		jsonlRecords(sendOutboxFile).some((record) => record.type === "message" && record.text === "Use message_agent instead."),
		false,
		"a refused local thread does not create an outbox record",
	);

	// The operator TUI has no chat module: its local history is the delivery sink.
	const operatorReply = await sendTool!.execute(
		"send-operator",
		{ thread: "local:agent:researcher:operator", text: "Reply for the operator TUI." },
		undefined,
		undefined,
		undefined as never,
	);
	const operatorDetails = operatorReply.details as Record<string, unknown>;
	assert.equal(operatorDetails.delivered, true, "an operator-thread reply is delivered to local history");
	const operatorHistory = HistoryStore.open(senderConfig.paths.stateDir).query({ module: "local", thread: "local:agent:researcher:operator" });
	assert.ok(operatorHistory.some((record) => record.id === operatorDetails.messageId && record.direction === "outbound"), "the operator reply is physically in local history");
	const operatorOutboxDelivery = jsonlRecords(sendOutboxFile).find(
		(record) => record.type === "delivery" && record.messageId === operatorDetails.messageId,
	);
	assert.equal(operatorOutboxDelivery?.ok, true, "operator-thread delivery records ok:true only after the history append");

	// message_agent still works after the host/send_message changes.
	const agentRegression = await messageTool!.execute("call-regression", { to: "writer", text: "message_agent still works." }, undefined, undefined, undefined as never);
	const agentRegressionDetails = agentRegression.details as Record<string, unknown>;
	assert.equal(agentRegressionDetails.delivered, true);
	assert.ok(
		EventStore.open(recipientConfig.paths.stateDir).peekPending(50).some((event) => event.id === agentRegressionDetails.messageId),
		"the message_agent regression event is in the writer inbox",
	);

	// --- #160: a recipient inbox append failure is never reported as delivered ---
	const recipientEventsBeforeFailure = jsonlRecords(recipientEventsFile).length;
	const originalAppend = EventStore.prototype.append;
	EventStore.prototype.append = function forcedAppendFailure(): never {
		throw new Error("forced append failure");
	};
	try {
		await assert.rejects(
			() => sendLocalAgentMessage({
				config: senderConfig,
				outbox: new Outbox(senderConfig.paths.stateDir),
				to: "writer",
				text: "Forced append failure via direct send.",
				runId: "run-forced-append",
			}),
			/recipient inbox append failed at .*forced append failure/,
		);
		const outboundBeforeFailure = run.outbound.length;
		await assert.rejects(
			() => messageTool.execute("call-forced", { to: "writer", text: "Forced append failure via tool." }, undefined, undefined, undefined as never),
			/recipient inbox append failed at .*forced append failure/,
		);
		assert.equal(run.outbound.length, outboundBeforeFailure, "a failed append does not record an outbound delivery in the run");
	} finally {
		EventStore.prototype.append = originalAppend;
	}
	assert.equal(jsonlRecords(recipientEventsFile).length, recipientEventsBeforeFailure, "a failed append does not write an event");
	const afterFailureRecords = jsonlRecords(path.join(senderConfig.paths.stateDir, "outbox", "messages.jsonl"));
	const failedAppendMessages = afterFailureRecords.filter((record) => record.type === "message" && String(record.text).startsWith("Forced append failure"));
	assert.equal(failedAppendMessages.length, 2, "both failed attempts are still durable outbox records");
	for (const failedMessage of failedAppendMessages) {
		const deliveries = afterFailureRecords.filter((record) => record.type === "delivery" && record.messageId === failedMessage.id);
		assert.ok(deliveries.length > 0, "every attempt carries a delivery record");
		assert.equal(deliveries.some((record) => record.ok === true), false, "the outbox never records ok:true when the recipient append failed");
		assert.match(String(deliveries.at(-1)?.error), /recipient inbox append failed/);
	}

	// --- #160: outbox replay logs the same delivery line and appends before ok:true ---
	const recoveryStateDir = fs.mkdtempSync(path.join(os.tmpdir(), "alive-agent-messaging-recovery-"));
	const recoveryOutbox = new Outbox(recoveryStateDir);
	await assert.rejects(
		() => recoveryOutbox.send(
			{
				runId: "run-recovery",
				thread: "local:agent:researcher:agent:writer",
				text: "Recovered after a simulated crash.",
				recipientAgentId: "writer",
				senderId: "researcher",
				senderName: "Researcher",
			},
			async () => {
				throw new Error("simulated crash before delivery");
			},
		),
		/simulated crash before delivery/,
	);
	const recoveryMessage = recoveryOutbox.list(1)[0]!;
	assert.equal(recoveryMessage.recipientAgentId, "writer");
	// A legacy/out-of-contract local record without its recipient must fail loudly
	// instead of falling through to chat transports and reporting ok:true.
	assert.throws(
		() => redeliverLocalAgentMessage(senderConfig, {
			id: "msg_legacy_local",
			runId: "run-legacy",
			thread: "local:agent:researcher:agent:writer",
			text: "legacy local record",
			senderId: "researcher",
			ts: Date.now(),
		}),
		/has no recipientAgentId/,
	);
	const recoveryLogStart = logEntries.length;
	const recovered = await recoveryOutbox.recoverPending({
		deliver: async (message) => {
			redeliverLocalAgentMessage(senderConfig, message, captureLog);
		},
		now: Date.now(),
	});
	assert.ok(recovered.delivered >= 1, "the queued message is replayed");
	assert.equal(recovered.failed, 0);
	const recoveryLines = logEntries.slice(recoveryLogStart).filter((entry) => entry.msg === "message_agent resolved local delivery");
	assert.ok(recoveryLines.length >= 1, "outbox replay emits the delivery log line");
	const recoveryLine = recoveryLines.find((entry) => entry.data?.eventId === recoveryMessage.id);
	assert.ok(recoveryLine, "the replay log line names the recovered event id");
	assert.equal(recoveryLine.data?.recovered, true);
	assert.equal(recoveryLine.data?.recipientId, "writer");
	assert.equal(recoveryLine.data?.inbox, path.join(recipientConfig.paths.stateDir, "inbox"), "the replay log names the exact inbox path");
	assert.ok(
		jsonlRecords(recipientEventsFile).some((event) => event.id === recoveryMessage.id),
		"the recovered event is physically present in the recipient inbox",
	);
	fs.rmSync(recoveryStateDir, { recursive: true, force: true });

	// --- #160: an orphaned registry-resident profile must never deliver main to itself ---
	const orphanRoot = fs.mkdtempSync(path.join(os.tmpdir(), "alive-agent-messaging-orphan-"));
	try {
		const orphanInit = writeDefaultConfig(orphanRoot);
		const orphanRaw = JSON.parse(fs.readFileSync(orphanInit.configPath, "utf8"));
		const orphanDirectory = path.join(orphanRoot, "agents", "reviewer");
		fs.mkdirSync(orphanDirectory, { recursive: true });
		const orphanConfigPath = path.join(orphanDirectory, "alive.config.json");
		fs.writeFileSync(orphanConfigPath, `${JSON.stringify({
			...orphanRaw,
			name: "Reviewer",
			stateDir: "state",
			agentsDirectory: "",
			rootConfigPath: orphanInit.configPath,
		}, null, 2)}\n`);
		const orphanConfig = loadConfig({ cwd: orphanDirectory, configPath: orphanConfigPath });
		assert.equal(managedAgentId(orphanConfig), undefined, "a profile the registry does not own has no managed identity");
		assert.equal(resolveRootProfile(orphanConfig), undefined, "an orphaned managed profile is never its own root");
		assert.throws(() => resolveLocalRecipient(orphanConfig, "main"), /not registered in the agents registry/);
		await assert.rejects(
			() => sendLocalAgentMessage({
				config: orphanConfig,
				outbox: new Outbox(orphanConfig.paths.stateDir),
				to: "main",
				text: "This must not be written into the sender's own inbox.",
				runId: "run-orphan-main",
			}),
			/cannot determine the sending agent/,
		);
		assert.equal(fs.existsSync(path.join(orphanConfig.paths.stateDir, "inbox", "events.jsonl")), false, "main is not self-delivered into the orphan's inbox");
		assert.equal(
			jsonlRecords(path.join(orphanConfig.paths.stateDir, "outbox", "messages.jsonl")).some((record) => record.type === "delivery" && record.ok === true),
			false,
			"the orphan's outbox has no ok:true record",
		);

		// A stale absolute agentsDirectory from a previous install must not route
		// peers into the obsolete registry either.
		const staleRoot = fs.mkdtempSync(path.join(os.tmpdir(), "alive-agent-messaging-stale-"));
		try {
			const staleInit = writeDefaultConfig(staleRoot);
			const staleRaw = JSON.parse(fs.readFileSync(staleInit.configPath, "utf8"));
			const staleRegistry = path.join(staleRoot, ".alive", "agents");
			const staleEditorDirectory = path.join(staleRegistry, "editor");
			fs.mkdirSync(staleEditorDirectory, { recursive: true });
			fs.writeFileSync(path.join(staleEditorDirectory, "alive.config.json"), `${JSON.stringify({
				...staleRaw,
				name: "Editor",
				stateDir: "state",
				rootConfigPath: staleInit.configPath,
			}, null, 2)}\n`);
			const staleEditor = loadConfig({ cwd: staleEditorDirectory, configPath: path.join(staleEditorDirectory, "alive.config.json") });
			const movedDirectory = path.join(orphanRoot, "agents", "reviewer-moved");
			fs.mkdirSync(movedDirectory, { recursive: true });
			const movedConfigPath = path.join(movedDirectory, "alive.config.json");
			fs.writeFileSync(movedConfigPath, `${JSON.stringify({
				...orphanRaw,
				name: "Reviewer Moved",
				stateDir: "state",
				agentsDirectory: staleRegistry,
				rootConfigPath: staleInit.configPath,
			}, null, 2)}\n`);
			const movedConfig = loadConfig({ cwd: movedDirectory, configPath: movedConfigPath });
			assert.throws(() => resolveLocalRecipient(movedConfig, "editor"), /not registered in the agents registry/);
			await assert.rejects(
				() => sendLocalAgentMessage({
					config: movedConfig,
					outbox: new Outbox(movedConfig.paths.stateDir),
					to: "editor",
					text: "This must not be routed into a stale registry.",
					runId: "run-stale-editor",
				}),
				/cannot determine the sending agent|not registered in the agents registry/,
			);
			assert.equal(EventStore.open(staleEditor.paths.stateDir).pendingCount(), 0, "the obsolete registry's inbox receives nothing");
		} finally {
			fs.rmSync(staleRoot, { recursive: true, force: true });
		}
	} finally {
		fs.rmSync(orphanRoot, { recursive: true, force: true });
	}

	console.log("agent messaging tests passed");
} finally {
	fs.rmSync(root, { recursive: true, force: true });
}
