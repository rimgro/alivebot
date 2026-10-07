import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
	ADMIN_AGENT_MANAGEMENT,
	agentsRoot,
	assertCanDelegate,
	canCreateAgents,
	canManageAgent,
	createAgent,
	disableManagedAgent,
	enableManagedAgent,
	ensureAdminAgent,
	getAgentEnabled,
	listAgents,
	startManagedAgent,
	stopManagedAgent,
	updateAgentProfile,
	withAgentLifecycleLock,
} from "../agents.js";
import { loadConfig, writeDefaultConfig } from "../config.js";
import { writeRuntimeState } from "../store/runs.js";
import { snapshotRuntime } from "../runtime/daemon.js";
import { createAliveTools, type ToolDeps } from "../runtime/tools.js";
import { Logger } from "../log.js";
import { sleep } from "../util.js";
import { selectAllowedTools } from "../runtime/session.js";

const root = fs.mkdtempSync(path.join(os.tmpdir(), "alive-agent-lifecycle-test-"));
const subprocesses: ChildProcess[] = [];
try {
	writeDefaultConfig(root);
	const base = loadConfig({ cwd: root });
	const admin = ensureAdminAgent(base);
	assert.equal(admin.id, "admin");
	assert.equal(ensureAdminAgent(base).configPath, admin.configPath, "admin bootstrap is idempotent");
	const adminConfig = loadConfig({ cwd: root, configPath: admin.configPath });
	assert.equal(canCreateAgents(adminConfig), true, "admin receives create_agent and the matching management capability");
	assert.ok(adminConfig.config.tools.allowlist.includes("manage_agents"), "admin receives the management tool");
	assert.deepEqual(adminConfig.config.agentManagement, { ...ADMIN_AGENT_MANAGEMENT, grantableTools: adminConfig.config.agentManagement.grantableTools });
	assert.equal(canCreateAgents(base), false, "ordinary profiles do not receive agent creation by default");

	const tools = ["read", "send_message", "create_agent", "calendar", "tool_registry", "agent_private"];
	const child = createAgent(adminConfig, "researcher", "Researcher", {
		role: "Research analyst",
		contract: "Own literature reviews.",
		toolAllowlist: tools,
	});
	const childConfig = loadConfig({ cwd: root, configPath: child.configPath });
	assert.deepEqual(childConfig.config.tools.allowlist, tools);
	assert.match(fs.readFileSync(path.join(child.directory, "CONTRACT.md"), "utf8"), /Role: Research analyst/);
	assert.match(fs.readFileSync(path.join(child.directory, "CONTRACT.md"), "utf8"), /Own literature reviews/);
	assert.equal(canCreateAgents(childConfig), false, "a create_agent tool name without the matching capability grants no authority");
	assert.equal(agentsRoot(childConfig), agentsRoot(base), "all managed profiles share one discoverable registry");
	const delegated: typeof adminConfig.config.agentManagement = {
		create: false, edit: true, start: true, stop: false, enable: false,
		configurePermissions: true, targets: ["analyst"], grantableTools: ["read"],
	};
	assertCanDelegate(adminConfig, ["read"], delegated);
	assert.throws(() => assertCanDelegate(childConfig, ["read"], delegated), /cannot grant agentManagement.edit/);
	assert.equal(canManageAgent(adminConfig, "stop", "anything"), true, "admin wildcard authorizes each lifecycle capability");
	updateAgentProfile(base, "researcher", { management: delegated });
	const updatedResearcher = loadConfig({ cwd: root, configPath: child.configPath });
	assert.equal(canManageAgent(updatedResearcher, "start", "analyst"), true);
	assert.equal(canManageAgent(updatedResearcher, "start", "writer"), false, "explicit target list blocks unrelated peers");
	assert.throws(() => assertCanDelegate(updatedResearcher, ["read"], { ...delegated, targets: ["writer"] }), /outside this agent's own target allowlist/);
	assert.throws(() => assertCanDelegate(updatedResearcher, ["bash"], delegated), /grantableTools/);
	assert.throws(() => assertCanDelegate(updatedResearcher, ["read"], { ...delegated, grantableTools: ["bash"] }), /grantableTools/);
	const managerTools = createAliveTools({
		config: updatedResearcher,
		moduleTools: [],
		log: new Logger({ console: false }),
		getRun: () => ({ id: "test-run" } as never),
	} as unknown as ToolDeps);
	const manageTool = managerTools.find((tool) => tool.name === "manage_agents")!;
	await assert.rejects(
		() => manageTool.execute("call", { action: "start", id: "admin" } as never, undefined, undefined, {} as never),
		/not authorized to start agent admin/,
	);
	await assert.rejects(
		() => manageTool.execute("call", { action: "disable", id: "admin" } as never, undefined, undefined, {} as never),
		/not authorized to disable agent admin/,
	);

	const nested = createAgent(adminConfig, "analyst", "Analyst", {
		role: "Analyst", contract: "Analyze data.", toolAllowlist: ["read", "idle"],
	});
	assert.ok(listAgents(base).some((agent) => agent.id === nested.id), "agents spawned by managed agents remain visible to the owner CLI");

	assert.equal(getAgentEnabled(nested), true);
	await disableManagedAgent(base, "analyst");
	assert.equal(getAgentEnabled(nested), false);
	await assert.rejects(() => startManagedAgent(base, "analyst"), /disabled/);
	await enableManagedAgent(base, "analyst");
	assert.equal(getAgentEnabled(nested), true);
	await stopManagedAgent(base, "analyst"); // stopping an already-stopped agent is idempotent

	// A start already in progress holds the cross-process lock. Disable must wait
	// for startup to finish, then stop that exact process before returning.
	const writer = createAgent(base, "writer", "Writer");
	const writerConfig = loadConfig({ cwd: root, configPath: writer.configPath });
	const stub = spawn(process.execPath, ["-e", "process.on('SIGTERM',()=>process.exit(0));setInterval(()=>{},1000)"], { stdio: "ignore" });
	subprocesses.push(stub);
	assert.ok(stub.pid);
	await sleep(100);
	let releaseStartup!: () => void;
	let startupEntered!: () => void;
	const startupGate = new Promise<void>((resolve) => { releaseStartup = resolve; });
	const startupReady = new Promise<void>((resolve) => { startupEntered = resolve; });
	const startPromise = startManagedAgent(base, "writer", {
		spawn: () => ({ pid: stub.pid!, logFile: "test.log", child: stub }),
		wait: async () => {
			startupEntered();
			await startupGate;
			writeRuntimeState(writerConfig.paths.stateDir, {
				pid: stub.pid!, startedAt: Date.now(), lastTickAt: Date.now(), status: "idle", runIndex: 0,
				pending: 0, openThreads: 0, sleeps: 0,
			});
			return { state: { pid: stub.pid!, startedAt: Date.now(), lastTickAt: Date.now(), status: "idle", runIndex: 0, pending: 0, openThreads: 0, sleeps: 0 }, pid: stub.pid!, alive: true, suspended: false, cleanStop: false, uptimeMs: 0 };
		},
	});
	let disablePromise: Promise<void> | undefined;
	try {
		await startupReady;
		let disableReturned = false;
		disablePromise = disableManagedAgent(base, "writer").then(() => { disableReturned = true; });
		await sleep(40);
		assert.equal(disableReturned, false, "disable cannot return while startup holds the shared lifecycle lock");
		releaseStartup();
		await startPromise;
		await disablePromise;
		assert.equal(getAgentEnabled(listAgents(base).find((item) => item.id === "writer")!), false);
		assert.equal(stub.exitCode, 0, "disable waits until the just-started process exits");
		assert.equal(snapshotRuntime(writerConfig.paths.stateDir)?.alive, false, "disable does not return with a running process");
	} finally {
		releaseStartup();
		await startPromise.catch(() => undefined);
		await disablePromise?.catch(() => undefined);
	}

	// A genuinely separate Node/tsx process cannot pass the lifecycle lock early.
	await enableManagedAgent(base, "writer");
	const crossProcessStub = spawn(process.execPath, ["-e", "process.on('SIGTERM',()=>process.exit(0));setInterval(()=>{},1000)"], { stdio: "ignore" });
	subprocesses.push(crossProcessStub);
	assert.ok(crossProcessStub.pid);
	await sleep(100);
	writeRuntimeState(writerConfig.paths.stateDir, {
		pid: crossProcessStub.pid!, startedAt: Date.now(), lastTickAt: Date.now(), status: "idle", runIndex: 0,
		pending: 0, openThreads: 0, sleeps: 0,
	});
	let releaseParentLock!: () => void;
	let parentLockEntered!: () => void;
	const parentLockGate = new Promise<void>((resolve) => { releaseParentLock = resolve; });
	const parentLockReady = new Promise<void>((resolve) => { parentLockEntered = resolve; });
	const parentLock = withAgentLifecycleLock(base, "writer", async () => {
		parentLockEntered();
		await parentLockGate;
	});
	await parentLockReady;
	try {
		const contendedFile = path.join(root, "cross-process-disable-contended");
		const doneFile = path.join(root, "cross-process-disable-done");
		const agentsUrl = new URL("../agents.ts", import.meta.url).href;
		const configUrl = new URL("../config.ts", import.meta.url).href;
		const script = [
			`import * as fs from "node:fs";`,
			`import * as path from "node:path";`,
			`const { loadConfig } = await import(${JSON.stringify(configUrl)});`,
			`const { disableManagedAgent } = await import(${JSON.stringify(agentsUrl)});`,
			`const root = process.env.ALIVE_TEST_ROOT;`,
			`const base = loadConfig({ cwd: root, configPath: path.join(root, "alive.config.json") });`,
			`await disableManagedAgent(base, "writer", { onLockContention: () => fs.writeFileSync(process.env.ALIVE_TEST_CONTENDED, "mkdir returned EEXIST") });`,
			`fs.writeFileSync(process.env.ALIVE_TEST_DONE, "done");`,
		].join("\n");
		const disableChild = spawn(process.execPath, ["--import", "tsx", "--input-type=module", "-e", script], {
			cwd: process.cwd(),
			env: { ...process.env, ALIVE_TEST_ROOT: root, ALIVE_TEST_CONTENDED: contendedFile, ALIVE_TEST_DONE: doneFile },
			stdio: ["ignore", "ignore", "pipe"],
		});
		subprocesses.push(disableChild);
		let childError = "";
		disableChild.stderr?.setEncoding("utf8").on("data", (chunk: string) => { childError += chunk; });
		const contentionDeadline = Date.now() + 5_000;
		while (!fs.existsSync(contendedFile) && Date.now() < contentionDeadline) await sleep(10);
		assert.equal(fs.existsSync(contendedFile), true, `separate process entered the real EEXIST contention path${childError ? `: ${childError}` : ""}`);
		assert.equal(fs.existsSync(doneFile), false, "separate process cannot complete disable while the parent owns the lifecycle lock");
		assert.equal(snapshotRuntime(writerConfig.paths.stateDir)?.alive, true, "agent stays running until the lock owner releases lifecycle work");
		releaseParentLock();
		await parentLock;
		const exit = await new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve, reject) => {
			disableChild.once("error", reject);
			disableChild.once("exit", (code, signal) => resolve({ code, signal }));
		});
		assert.equal(exit.code, 0, `separate disable process exits successfully${childError ? `: ${childError}` : ""}`);
		assert.equal(fs.existsSync(doneFile), true, "separate process completes disable only after acquiring the lock");
		assert.equal(getAgentEnabled(listAgents(base).find((agent) => agent.id === "writer")!), false, "cross-process disable persists the disabled state");
		assert.equal(crossProcessStub.exitCode, 0, "cross-process disable stops the running process before returning");
		assert.equal(snapshotRuntime(writerConfig.paths.stateDir)?.alive, false, "cross-process disable does not leave the agent running");
	} finally {
		releaseParentLock();
		await parentLock.catch(() => undefined);
	}

	// An unknown/stale lock is not reclaimed automatically; operations fail closed.
	const staleLock = path.join(writer.directory, ".lifecycle.lock");
	fs.mkdirSync(staleLock);
	await assert.rejects(
		() => withAgentLifecycleLock(base, "writer", () => undefined, { timeoutMs: 20, pollMs: 1 }),
		/lock is busy or stale.*refusing the operation/,
	);
	assert.equal(fs.existsSync(staleLock), true, "the lock owner cannot be guessed or deleted by a waiter");
	fs.rmSync(staleLock, { recursive: true, force: true });

	// Configs created before management fields existed inherit a safe disabled permission set.
	const legacy = createAgent(base, "legacy", "Legacy");
	const legacyRaw = JSON.parse(fs.readFileSync(legacy.configPath, "utf8")) as Record<string, any>;
	delete legacyRaw.agentManagement;
	delete legacyRaw.enabled;
	delete legacyRaw.tools.allowlist;
	fs.writeFileSync(legacy.configPath, JSON.stringify(legacyRaw));
	const legacyConfig = loadConfig({ cwd: root, configPath: legacy.configPath });
	assert.equal(legacyConfig.config.enabled, true);
	assert.equal(legacyConfig.config.agentManagement.create, false);
	assert.deepEqual(legacyConfig.config.agentManagement.targets, []);

	const selected = selectAllowedTools({
		allowlist: ["read", "send_message", "calendar"],
		builtins: ["read", "write", "bash"],
		alive: ["send_message", "idle", "create_agent"],
		modules: ["calendar", "telegram_admin"],
		custom: ["agent_private", "tool_registry"],
		toolRegistryAvailable: true,
	});
	assert.deepEqual(selected, ["read", "send_message", "calendar"]);
	assert.deepEqual(selectAllowedTools({
		allowlist: [], builtins: ["read"], alive: ["idle"], modules: ["m"], custom: ["c"], toolRegistryAvailable: true,
	}), [], "empty allowlists disable every tool source");
	assert.throws(() => createAgent(adminConfig, "invalid", "Invalid", {
		role: "None", contract: "None", toolAllowlist: ["not valid"],
	}), /valid tool names/);

	console.log("agent lifecycle tests passed");
} finally {
	await Promise.all(subprocesses.map(reapChild));
	fs.rmSync(root, { recursive: true, force: true });
}

async function reapChild(child: ChildProcess): Promise<void> {
	if (child.exitCode !== null || child.signalCode !== null) return;
	await new Promise<void>((resolve) => {
		const finish = () => {
			child.off("exit", finish);
			child.off("error", finish);
			resolve();
		};
		child.once("exit", finish);
		child.once("error", finish);
		if (child.exitCode !== null || child.signalCode !== null) finish();
		else {
			try { child.kill("SIGKILL"); } catch { finish(); }
		}
	});
}
