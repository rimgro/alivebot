import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { loadConfig } from "../config.js";
import { SandboxManager, guestHome, guestPath } from "../sandbox/manager.js";
import { createSandboxTools } from "../sandbox/tools.js";
import { DEFAULT_SANDBOX_CONFIG, validateSandboxConfig } from "../sandbox/config.js";
import { IDLE_PROBE, parseIdleEvidence } from "../sandbox/probe.js";
import { createAgent, updateAgentProfile } from "../agents.js";
import { buildAgent } from "../runtime/session.js";
import type { ToolDeps } from "../runtime/tools.js";
import { Logger } from "../log.js";
import { createTelegramTools, type TelegramToolHost } from "../modules/telegram/tools.js";
import { NetworkPolicy } from "microsandbox";
import { publicNetworkPolicy } from "../sandbox/network.js";

const temp = fs.mkdtempSync(path.join(os.tmpdir(), "alive-sandbox-test-"));
const log = new Logger({ console: false });

function fakeBackend() {
	let status: string | undefined;
	let labels: Record<string, string> = {};
	let probe = { processes: [] as Array<{ pid: number; command: string }>, containers: [] as unknown[], workspaceMounts: [] as string[] };
	let probeFails = false;
	let jobs: Array<{ id: string; state: string }> = [];
	let nextCursor: string | null = null;
	let created = 0;
	let networkPolicy: unknown;
	let networkDisabled = false;
	let stopped = 0;
	let liveWrites = 0;
	let user = "";
	let execDelayMs = 0;
	let execEvents: Array<{ kind: "stdout" | "stderr"; data: Buffer } | { kind: "exited"; code: number }> = [{ kind: "exited", code: 0 }];
	const files = new Map<string, Buffer>();
	const dirs = new Set(["/"]);
	const modes = new Map<string, number>();
	const links = new Set<string>();
	let readGate: Promise<void> | undefined;
	let readStarted: (() => void) | undefined;
	const volumeFs = {
		async write(p: string, content: string | Buffer) { files.set(p, Buffer.from(content)); },
		async mkdir(p: string) { dirs.add(p); },
		async exists(p: string) { return files.has(p) || dirs.has(p) || links.has(p); },
		async stat(p: string) {
			if (!files.has(p) && !dirs.has(p) && !links.has(p)) throw { code: "io", message: "missing" };
			return { kind: links.has(p) ? "symlink" : dirs.has(p) ? "directory" : "file", size: files.get(p)?.length ?? 0, mode: modes.get(p) ?? 0o755, readonly: false };
		},
		async list(p: string) {
			const entries = [...dirs, ...files.keys(), ...links].filter((e) => e !== "/" && path.posix.dirname(e) === p);
			return Promise.all(entries.map(async (e) => ({ ...(await volumeFs.stat(e)), path: e })));
		},
		async readStream(p: string) {
			const data = files.get(p);
			if (!data) throw new Error("missing");
			return { async *[Symbol.asyncIterator]() { readStarted?.(); await readGate; yield data; }, async [Symbol.asyncDispose]() {} };
		},
	};
	const handle = {
		id: "identity", backendKind: "local", get status() { return status; },
		config: () => ({ labels }),
		async connectOrStart() { status = "running"; return vm; },
		async stopWithTimeout() { stopped++; status = "stopped"; },
	};
	const vm = {
		id: "identity", backendKind: "local",
		async detach() {},
		async listJobsWith(configure: (b: any) => unknown) {
			const b = { all() { return b; }, limit(value: number) { assert.ok(value >= 1 && value <= 100, "native job page size must be 1..100"); return b; }, cursor() { return b; } };
			configure(b);
			return { items: jobs, nextCursor };
		},
		async execStreamWith() {
			return {
				async *[Symbol.asyncIterator]() {
					if (execDelayMs) await new Promise((resolve) => setTimeout(resolve, execDelayMs));
					yield* execEvents;
				},
				async wait() { throw new Error("exec session ended without exit event"); },
				async kill() {},
				async [Symbol.asyncDispose]() {},
			};
		},
		async execWith(_command: string, configure: (b: any) => unknown) {
			let args: string[] = [];
			let stdin: Buffer = Buffer.alloc(0);
			const b = { args(value: string[]) { args = value; return b; }, user(value: string) { user = value; return b; }, timeout() { return b; }, stdinNull() { return b; }, stdinBytes(value: Buffer) { stdin = value; return b; } };
			configure(b);
			if (args.at(-2) === IDLE_PROBE) {
				assert.match(args.at(-1)!, /^\/home\//);
				assert.deepEqual(args.slice(0, 3), ["-I", "-S", "-c"], "probe must not import project or user-site Python modules");
				if (probeFails) throw new Error("probe failed");
				return { success: true, stdout: () => JSON.stringify(probe), stderr: () => "" };
			}
			const request = JSON.parse(stdin.toString());
			let value: unknown = null;
			const relative = request.path.replace(/^\/home\/[^/]+/, "");
			if (request.op === "write") { liveWrites++; files.set(relative, Buffer.from(request.data, "base64")); }
			if (request.op === "read") value = files.get(relative)?.toString("base64");
			if (request.op === "stat") value = await volumeFs.stat(relative);
			if (request.op === "mkdir") dirs.add(relative);
			return { success: true, stdout: () => JSON.stringify(value), stderr: () => "" };
		},
	};
	const builder: any = new Proxy({}, { get: (_target, key) => {
		if (key === "label") return (k: string, v: string) => { labels[k] = v; return builder; };
		if (key === "network") return (configure: (network: any) => unknown) => {
			configure({ policyFromBuilder(policy: ReturnType<typeof NetworkPolicy.builder>) { networkPolicy = policy.build(); return this; } });
			return builder;
		};
		if (key === "disableNetwork") return () => { networkDisabled = true; return builder; };
		if (key === "create") return async () => { created++; status = "running"; return vm; };
		return () => builder;
	} });
	const sdk = {
		NetworkPolicy,
		Sandbox: { async get() { if (!status) throw { code: "sandboxNotFound" }; return handle; }, builder: () => builder },
		Volume: { async get() { return { fs: () => volumeFs }; } },
	};
	return {
		sdk: sdk as unknown as typeof import("microsandbox"), files, dirs, links, modes,
		setProbe(value: Omit<typeof probe, "workspaceMounts"> & { workspaceMounts?: string[] }) { probe = { ...value, workspaceMounts: value.workspaceMounts ?? [] }; }, setProbeFailure(value: boolean) { probeFails = value; },
		setJobs(value: typeof jobs, cursor: string | null = null) { jobs = value; nextCursor = cursor; },
		setStatus(value: string) { status = value; },
		setExec(events: typeof execEvents, delayMs = 0) { execEvents = events; execDelayMs = delayMs; },
		setReadGate(gate?: Promise<void>, started?: () => void) { readGate = gate; readStarted = started; },
		get networkPolicy() { return networkPolicy; }, get networkDisabled() { return networkDisabled; },
		get created() { return created; }, get stopped() { return stopped; }, get liveWrites() { return liveWrites; }, get user() { return user; },
	};
}

async function testNetworkPolicy() {
	const expected = publicNetworkPolicy(await import("microsandbox")).build();
	assert.equal(expected.defaultEgress, "deny");
	assert.equal(expected.defaultIngress, "deny");
	assert.deepEqual(expected.rules.map((rule) => rule.destination), [
		{ kind: "group", group: "host" }, { kind: "group", group: "public" },
	]);
	assert.deepEqual(expected.rules[0]!.ports, [{ start: 53, end: 53 }]);
	assert.deepEqual(expected.rules[0]!.protocols, ["tcp", "udp"]);
	assert.deepEqual(expected.rules[1]!.protocols, ["tcp", "udp", "icmpv4", "icmpv6"]);
	assert.ok(expected.rules.every((rule) => rule.direction === "egress" && rule.action === "allow"));
	for (const mode of ["public", "unrestricted", "disabled"] as const) {
		const loaded = loadConfig({ cwd: path.join(temp, `network-${mode}`) });
		loaded.config.sandbox.network = mode !== "disabled";
		loaded.config.sandbox.networkAccess = mode === "unrestricted" ? "unrestricted" : "public";
		const fake = fakeBackend();
		const manager = new SandboxManager(loaded, log, async () => fake.sdk, () => {});
		try {
			await manager.exclusive(() => manager.execute("true", 30_000));
			assert.equal(fake.networkDisabled, mode === "disabled");
			assert.deepEqual(fake.networkPolicy, mode === "public" ? expected : undefined);
		} finally { await manager.close(); }
	}
}

async function testManager() {
	const loaded = loadConfig({ cwd: path.join(temp, "mock") });
	loaded.config.sandbox.idleTimeoutMs = 1;
	loaded.config.sandbox.checkIntervalMs = 1000;
	const fake = fakeBackend();
	const manager = new SandboxManager(loaded, log, async () => fake.sdk, () => {});
	const invoke = async (name: string, args: unknown) => {
		const tool = createSandboxTools(manager).find((t) => t.name === name)!;
		return tool.execute("test", args, undefined, undefined, {} as any);
	};
	assert.equal((await manager.control("status") as any).status, "not-created");
	assert.equal(fake.created, 0, "status must never boot a VM");
	await invoke("write", { path: "data.txt", content: "alpha beta gamma" });
	await invoke("edit", { path: "data.txt", edits: [{ oldText: "alpha", newText: "ALPHA" }, { oldText: "gamma", newText: "GAMMA" }] });
	assert.equal(fake.files.get("/data.txt")?.toString(), "ALPHA beta GAMMA");
	assert.equal(fake.created, 0, "ordinary filesystem operations must remain offline");
	await invoke("write", { path: "~/lines.txt", content: "one\ntwo\nthree" });
	const page = await invoke("read", { path: "~/lines.txt", offset: 2, limit: 1 });
	assert.match((page.content[0] as any).text, /^two\n/);
	assert.match((page.content[0] as any).text, /offset=3/);
	assert.equal(fake.files.get("/lines.txt")?.toString(), "one\ntwo\nthree");
	await assert.rejects(invoke("read", { path: "lines.txt", offset: 10 }), /beyond end/);
	await assert.rejects(invoke("edit", { path: "data.txt", edits: [{ oldText: "ALPHA beta", newText: "x" }, { oldText: "beta", newText: "y" }] }), /overlap/i);
	assert.equal(fake.files.get("/data.txt")?.toString(), "ALPHA beta GAMMA", "failed multi-edit must not write");
	const grep = await invoke("grep", { pattern: "beta" });
	assert.match((grep.content[0] as any).text, /data.txt:1:/);
	await assert.rejects(invoke("write", { path: "huge.txt", content: "x".repeat(loaded.config.sandbox.maxFileBytes + 1) }), /maxFileBytes/);
	// A dangling symlink cannot be mistaken for a nonexistent ordinary file.
	fake.links.add("/link");
	await manager.exclusive(async () => {
		const f = await manager.files();
		await f.write(manager.path("link"), "guest write");
		await f.write(manager.path("data.txt"), "live");
	});
	assert.equal(fake.created, 1);
	assert.equal(fake.liveWrites, 2, "route must switch to guest after a sibling operation boots the VM");
	assert.equal(fake.user, "0:0");
	fake.setExec([{ kind: "stdout", data: Buffer.from("out") }, { kind: "stderr", data: Buffer.from("err") }, { kind: "exited", code: 7 }]);
	assert.deepEqual(await manager.exclusive(() => manager.execute("test", 30_000)), { text: "outerr", code: 7, truncated: false }, "stream exit must not be consumed twice via wait()");
	fake.setExec([{ kind: "stdout", data: Buffer.alloc(70 * 1024, "x") }, { kind: "exited", code: 0 }]);
	const capped = await manager.exclusive(() => manager.execute("test", 30_000));
	assert.equal(capped.text.length, 64 * 1024);
	assert.equal(capped.truncated, true);
	fake.setExec([]);
	await assert.rejects(manager.exclusive(() => manager.execute("test", 30_000)), /ended without exit event/, "missing completion must never report success");
	fake.setExec([{ kind: "exited", code: -9 }], 20);
	await assert.rejects(manager.exclusive(() => manager.execute("test", 1)), /timed out/, "raw timeout exit must not be reported as normal completion");
	fake.setExec([{ kind: "stdout", data: Buffer.from("out") }, { kind: "exited", code: 0 }]);
	const cancelled = new AbortController();
	await assert.rejects(manager.exclusive(() => manager.execute("test", 30_000, cancelled.signal, () => cancelled.abort())), /abort/i);
	const metadata = await invoke("file", { action: "stat", path: "data.txt" });
	assert.equal((metadata.details as any).metadataSource, "guest", "permission metadata must come from the guest, not raw backing volume stat");
	const future = Date.now() + 100_000;
	fake.setProbe({ processes: [{ pid: 42, command: "docker-containerd" }], containers: [] });
	assert.equal(await manager.checkIdle(future), false);
	assert.equal(fake.stopped, 0);
	fake.setProbe({ processes: [], containers: [{ Id: "critical-container" }] });
	assert.equal(await manager.checkIdle(future + 1000), false);
	fake.setProbe({ processes: [], containers: [], workspaceMounts: [manager.path("overlay")] });
	assert.equal(await manager.checkIdle(future + 2000), false, "untracked workspace mounts must prevent shutdown/offline view changes");
	fake.setProbe({ processes: [], containers: [] });
	fake.setJobs([{ id: "pending-job", state: "starting" }]);
	assert.equal(await manager.checkIdle(future + 2000), false);
	fake.setJobs([{ id: "uncertain-job", state: "lost" }]);
	assert.equal(await manager.checkIdle(future + 3000), false);
	fake.setJobs([], "more");
	assert.equal(await manager.checkIdle(future + 4000), false);
	fake.setJobs([]);
	fake.setProbeFailure(true);
	assert.equal(await manager.checkIdle(future + 5000), false, "probe failure must retain VM");
	fake.setProbeFailure(false);
	await manager.control("pin", "important", "critical background service");
	assert.equal(await manager.checkIdle(future + 6000), false);
	assert.equal(fake.stopped, 0);
	await manager.close();
	assert.equal(fake.stopped, 0, "agent shutdown must not kill background work");
	const restored = new SandboxManager(loaded, log, async () => fake.sdk, () => {});
	assert.equal((await restored.control("status") as any).holds.important, "critical background service");
	await restored.control("unpin", "important");
	assert.equal(await restored.checkIdle(future + 7000), false, "first empty observation only arms shutdown");
	assert.equal(await restored.checkIdle(future + 7500), false, "observations must span checkIntervalMs");
	assert.equal(await restored.checkIdle(future + 8000), true);
	assert.equal(fake.stopped, 1);
	await restored.exclusive(async () => (await restored.files()).write(restored.path("data.txt"), "offline again"));
	assert.equal(fake.liveWrites, 2, "stopped VM must not wake for an ordinary file write");
	await restored.close();
	loaded.config.name = "Renamed Agent";
	const renamed = new SandboxManager(loaded, log, async () => fake.sdk, () => {});
	assert.equal(renamed.workspaceDir, "/home/renamed-agent");
	assert.equal(renamed.workspaceVolume, manager.workspaceVolume, "renaming home must retain the persistent volume identity");
	await assert.rejects(renamed.control("status"), /configuration\/ownership mismatch/, "old VM must not silently retain the previous home mount");
	await renamed.close();

	const nonroot = loadConfig({ cwd: path.join(temp, "nonroot") });
	nonroot.config.sandbox.uid = 1000;
	nonroot.config.sandbox.gid = 1000;
	const nonrootFake = fakeBackend();
	const nonrootManager = new SandboxManager(nonroot, log, async () => nonrootFake.sdk, () => {});
	await nonrootManager.exclusive(async () => (await nonrootManager.files()).write(nonrootManager.path("file.txt"), "hi"));
	assert.equal(nonrootFake.liveWrites, 1, "nonroot permissions must be checked by guest, never host");
	assert.equal(nonrootFake.user, "1000:1000");
	await nonrootManager.close();

	const serialFake = fakeBackend();
	const serial = new SandboxManager(loadConfig({ cwd: path.join(temp, "serial") }), log, async () => serialFake.sdk, () => {});
	let release!: () => void;
	const gate = new Promise<void>((resolve) => { release = resolve; });
	const order: string[] = [];
	const a = serial.exclusive(async () => { order.push("a"); await gate; order.push("A"); });
	const b = serial.exclusive(async () => { order.push("b"); });
	await Promise.resolve();
	assert.deepEqual(order, ["a"]);
	release(); await Promise.all([a, b]);
	assert.deepEqual(order, ["a", "A", "b"]);
	await serial.close();

	const ioFake = fakeBackend();
	ioFake.files.set("/slow.txt", Buffer.from("slow read"));
	const io = new SandboxManager(loadConfig({ cwd: path.join(temp, "io") }), log, async () => ioFake.sdk, () => {});
	let releaseRead!: () => void;
	let markReadStarted!: () => void;
	const readGate = new Promise<void>((resolve) => { releaseRead = resolve; });
	const readStarted = new Promise<void>((resolve) => { markReadStarted = resolve; });
	ioFake.setReadGate(readGate, markReadStarted);
	const abort = new AbortController();
	const reader = createSandboxTools(io).find((tool) => tool.name === "read")!;
	const reading = reader.execute("slow-read", { path: "slow.txt" }, abort.signal, undefined, {} as any);
	const rejected = assert.rejects(reading, /abort/i); // Observe rejection before signalling.
	await readStarted;
	abort.abort();
	let successorRan = false;
	const successor = io.exclusive(async () => { successorRan = true; });
	await Promise.resolve();
	assert.equal(successorRan, false, "abort must not release the lifecycle lock while native IO is still running");
	releaseRead();
	await rejected;
	await successor;
	assert.equal(successorRan, true);
	await io.close();
}

async function testSessionBoundary() {
	const loaded = loadConfig({ cwd: path.join(temp, "session") });
	loaded.config.piAgentDir = path.join(temp, "pi");
	loaded.config.model = "openai/gpt-4.1";
	loaded.config.tools.allowlist.push("tool_registry", "sandbox_control", "file", "powershell");
	loaded.config.tools.builtin.push("powershell");
	const fake = fakeBackend();
	const manager = new SandboxManager(loaded, log, async () => fake.sdk, () => {});
	const deps = { config: loaded, moduleTools: [], log } as unknown as ToolDeps;
	const built = await buildAgent({ config: loaded, sandbox: manager, toolDeps: deps, log: log as Logger, soul: "Test" });
	try {
		const active = built.session.getActiveToolNames();
		assert.ok(active.includes("read") && active.includes("bash") && active.includes("sandbox_control"));
		assert.ok(!active.includes("browser") && !active.includes("web_search") && !active.includes("tool_registry") && !active.includes("powershell"));
		built.session.setActiveToolsByName([...active, "powershell", "browser"]);
		assert.ok(!built.session.getActiveToolNames().includes("powershell"), "SDK tool ceiling must prevent activating host shell aliases");
		assert.ok(built.session.systemPrompt.includes(manager.workspaceDir));
		assert.equal(manager.workspaceDir, "/home/alive");
		assert.equal(fake.created, 0, "session creation must not boot the VM");
		const writeTool = built.session.agent.state.tools.find((t) => t.name === "write")!;
		await writeTool.execute("verify-isolation", { path: "guest.txt", content: "inside guest volume" });
		assert.equal(fake.files.get("/guest.txt")?.toString(), "inside guest volume");
		assert.equal(fs.existsSync(path.join(loaded.paths.workspaceDir, "guest.txt")), false, "registered write must not fall through to host builtins");
		assert.equal(fake.created, 0, "Pi's host context cwd must not cause a VM boot for relative workspace paths");
	} finally { built.session.dispose(); await manager.close(); }
	loaded.config.extensions = ["untrusted.ts"];
	await assert.rejects(buildAgent({ config: loaded, sandbox: manager, toolDeps: deps, log: log as Logger, soul: "Test" }), /Host pi extensions are disabled/);
}

async function testTelegramBridge() {
	const bytes = Buffer.from([0, 255, 10, 1]);
	let written: { file: string; data: Buffer } | undefined;
	const host = {
		workspaceDir: "/home/telegram-agent",
		api: { async getFile() { return { file_path: "photos/image.png", file_size: bytes.length }; }, async downloadFile() { return bytes; } },
		async writeWorkspaceFile(file: string, data: Buffer) { written = { file, data }; return file; },
	} as unknown as TelegramToolHost;
	const tool = createTelegramTools(host).find((t) => t.name === "telegram")!;
	const output = await tool.execute("download", { action: "download_file", file_id: "test", name: "image.png" }, undefined, undefined, {} as any);
	assert.deepEqual(written, { file: "/home/telegram-agent/telegram-files/image.png", data: bytes });
	assert.match((output.content[0] as any).text, /\/home\/telegram-agent\/telegram-files\/image.png/);
}

async function testRealOfflineFiles() {
	// Uses the actual native volume API, but VM creation is forbidden by the
	// adapter: these tests need neither KVM access, OCI pulls nor a booted guest.
	const sdk = await import("microsandbox");
	let bootAttempts = 0;
	const noBootSdk = { ...sdk, Sandbox: {
		get: sdk.Sandbox.get.bind(sdk.Sandbox),
		builder() { bootAttempts++; throw new Error("VM creation forbidden in offline test"); },
	} } as unknown as typeof sdk;
	const loaded = loadConfig({ cwd: path.join(temp, "native") });
	const manager = new SandboxManager(loaded, log, async () => noBootSdk, () => {});
	const volume = await sdk.Volume.builder(manager.workspaceVolume).directory().create();
	try {
		await manager.exclusive(async () => {
			const f = await manager.files();
			await f.mkdir(manager.path("nested"));
			await f.write(manager.path("nested/test.bin"), Buffer.from([0, 1, 2, 255]));
			assert.deepEqual(await f.read(manager.path("nested/test.bin")), Buffer.from([0, 1, 2, 255]));
		});
		const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAACklEQVR4nGMAAQAABQABDQottAAAAABJRU5ErkJggg==", "base64");
		await manager.exclusive(async () => (await manager.files()).write(manager.path("pixel.png"), png));
		const reader = createSandboxTools(manager).find((tool) => tool.name === "read")!;
		const image = await reader.execute("image", { path: "pixel.png" }, undefined, undefined, {} as any);
		assert.ok(image.content.some((part) => part.type === "image"), "real offline image bytes must reach vision via Pi resizing");
		assert.equal(bootAttempts, 0);
		const sentinel = path.join(temp, "host-secret");
		fs.writeFileSync(sentinel, "HOST SECRET");
		fs.symlinkSync(sentinel, path.join(volume.path, "escape"));
		await assert.rejects(manager.exclusive(async () => (await manager.files()).read(manager.path("escape"))), /VM creation forbidden/);
		assert.equal(fs.readFileSync(sentinel, "utf8"), "HOST SECRET");
		// Direct native access must also be capability scoped.
		await assert.rejects(volume.fs().read("/escape"));
		await assert.rejects(volume.fs().write("/escape", "overwrite"));
		await assert.rejects(volume.fs().read("../../etc/passwd"));
		assert.equal(fs.readFileSync(sentinel, "utf8"), "HOST SECRET");
	} finally {
		await manager.close();
		await sdk.Volume.remove(manager.workspaceVolume);
	}
}

try {
	assert.equal(loadConfig({ cwd: temp }).config.sandbox.enabled, true);
	assert.equal(loadConfig({ cwd: temp }).config.sandbox.networkAccess, "public");
	assert.throws(() => validateSandboxConfig({ ...DEFAULT_SANDBOX_CONFIG, networkAccess: "all" as any }), /networkAccess/);
	await testNetworkPolicy();
	assert.equal(guestHome("Writer"), "/home/writer");
	assert.equal(guestHome("../../Writer Team"), "/home/writer-team");
	assert.match(guestHome("Агент"), /^\/home\/agent-[a-f0-9]+$/);
	assert.equal(guestPath("test.txt", "/home/writer"), "/home/writer/test.txt");
	assert.equal(guestPath("~", "/home/writer"), "/home/writer");
	assert.equal(guestPath("~/test.txt", "/home/writer"), "/home/writer/test.txt");
	assert.throws(() => guestPath("../host", "/home/writer"));
	assert.throws(() => guestPath("a\0b", "/home/writer"));
	assert.throws(() => validateSandboxConfig({ ...DEFAULT_SANDBOX_CONFIG, sharedVolumes: [{ name: "bad", mountPath: "/home/writer/cache", readOnly: true }] }));
	assert.throws(() => validateSandboxConfig({ ...DEFAULT_SANDBOX_CONFIG, sharedVolumes: [{ name: "bad", mountPath: "/workspace/cache", readOnly: true }] }));
	assert.throws(() => validateSandboxConfig({ ...DEFAULT_SANDBOX_CONFIG, memoryMiB: 1 }));
	assert.throws(() => parseIdleEvidence('{"processes":[]}'));
	const base = loadConfig({ cwd: path.join(temp, "profiles") });
	fs.mkdirSync(base.paths.rootDir, { recursive: true });
	fs.writeFileSync(base.paths.soulPath, "test soul");
	const one = createAgent(base, "one", undefined, { sandbox: { memoryMiB: 256, network: false } });
	const two = createAgent(base, "two");
	updateAgentProfile(base, "one", { sandbox: { idleTimeoutMs: 60000 } });
	const oneConfig = loadConfig({ cwd: one.directory, configPath: one.configPath });
	const twoConfig = loadConfig({ cwd: two.directory, configPath: two.configPath });
	assert.equal(oneConfig.config.sandbox.memoryMiB, 256);
	assert.equal(oneConfig.config.sandbox.idleTimeoutMs, 60000);
	assert.equal(twoConfig.config.sandbox.memoryMiB, 512);
	const oneManager = new SandboxManager(oneConfig, log);
	const twoManager = new SandboxManager(twoConfig, log);
	assert.notEqual(oneManager.workspaceVolume, twoManager.workspaceVolume);
	assert.equal(oneManager.workspaceDir, "/home/one");
	assert.equal(twoManager.workspaceDir, "/home/two");
	assert.deepEqual(oneManager.config.sharedVolumes, twoManager.config.sharedVolumes);
	await Promise.all([oneManager.close(), twoManager.close()]);
	await testManager();
	await testSessionBoundary();
	await testTelegramBridge();
	await testRealOfflineFiles();
	console.log("sandbox-test: ok (policy, per-agent settings, permissions, lifecycle, real offline volume isolation)");
} finally {
	fs.rmSync(temp, { recursive: true, force: true });
}
