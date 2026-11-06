import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import type { ExecHandle, Sandbox, SandboxHandle, VolumeFs } from "microsandbox";
import type { LoadedConfig } from "../config.js";
import type { Logger } from "../log.js";
import { validateSandboxConfig, type SandboxConfig } from "./config.js";
import { publicNetworkPolicy } from "./network.js";
import { FILE_RPC, IDLE_PROBE, parseIdleEvidence, type IdleEvidence } from "./probe.js";

export interface VirtualFiles {
	read(file: string): Promise<Buffer>;
	write(file: string, content: string | Buffer): Promise<void>;
	mkdir(directory: string): Promise<void>;
	stat(file: string): Promise<{ kind: string; size: number; mode: number; readonly?: boolean; uid?: number; gid?: number; mtimeMs?: number }>;
	list(directory: string): Promise<Array<{ path: string; kind: string; size: number; mode: number }>>;
}

export function guestHome(name: string): string {
	const slug = name.normalize("NFKD").toLowerCase().replace(/[^a-z0-9_-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 48);
	return `/home/${slug || `agent-${digest(name)}`}`;
}

export function guestPath(file: string, workspace: string): string {
	if (typeof file !== "string" || file.includes("\0") || file.includes("\\") || file.split("/").includes("..")) {
		throw new Error("Use a guest path without NUL, backslashes or '..'");
	}
	// Never expand '~' through the host user's home directory.
	if (file === "~") return workspace;
	if (file.startsWith("~/")) file = file.slice(2);
	return path.posix.resolve(workspace, file);
}

const digest = (text: string) => createHash("sha256").update(text).digest("hex").slice(0, 24);
const hasCode = (error: unknown, code: string) => (error as { code?: string })?.code === code;

/** Host-side slack on top of the guest exec timeout. SDK timeouts only cover the
 * guest process; a dead guest never closes the event stream. Not part of the
 * boot fingerprint: these are runtime limits, not VM configuration. */
export const EXEC_DEADLINE_GRACE_MS = 10_000;
/** Upper bound for attach/boot. Image pulls are slow, a stuck hypervisor is not.
 * Overridable per manager so tests never wait minutes. */
export const BOOT_DEADLINE_MS = 180_000;
/** Guest filesystem RPC deadline; mirrors the SDK exec timeout. */
export const GUEST_FS_DEADLINE_MS = 30_000;
/** Idle inspection pages are bounded as well: a guest that never answers must
 * not stall the most frequent path ("may the VM sleep?"). */
const MAX_JOB_PAGES = 100;
/** Teardown must be bounded too, otherwise a killed stream still blocks the queue. */
const TEARDOWN_DEADLINE_MS = 5_000;

/** Settle a promise within `ms`; late outcomes and failures are ignored. */
async function bounded(promise: Promise<unknown>, ms: number): Promise<void> {
	let timer: NodeJS.Timeout | undefined;
	try {
		await Promise.race([
			promise.then(() => undefined, () => undefined),
			new Promise<void>((resolve) => { timer = setTimeout(resolve, ms); }),
		]);
	} finally { if (timer) clearTimeout(timer); }
}

function checkLocalHardware(): void {
	if (process.platform !== "linux") return; // macOS HVF / Windows WHP are validated by the SDK.
	try { fs.accessSync("/dev/kvm", fs.constants.R_OK | fs.constants.W_OK); }
	catch { throw new Error("microsandbox needs read/write access to /dev/kvm. Grant the operator KVM access and restart its login/service session. Refusing VM boot (no host fallback)."); }
}

/** One owner per runtime, shared across all context resets. All tools and lifecycle
 * decisions run through one queue: no stop/write/boot races inside Alive.
 * External msb lifecycle operations while Alive runs are unsupported.
 */
export class SandboxManager {
	readonly name: string;
	readonly workspaceVolume: string;
	readonly workspaceDir: string;
	readonly config: SandboxConfig;
	private readonly guestEnv: Record<string, string>;
	private readonly owner: string;
	private readonly fingerprint: string;
	private readonly holdsPath: string;
	private readonly holds = new Map<string, string>();
	private sdkPromise?: Promise<typeof import("microsandbox")>;
	private vm?: Sandbox;
	private timer?: NodeJS.Timeout;
	private tail: Promise<unknown> = Promise.resolve();
	private pending = 0;
	private closed = false;
	private lastActivity = Date.now();
	private emptyObservedAt?: number;
	private evidence?: IdleEvidence;
	private evidenceAt?: number;
	private lastError?: string;

	constructor(private readonly loaded: LoadedConfig, private readonly log: Pick<Logger, "warn" | "info">,
		private readonly loadSdk: () => Promise<typeof import("microsandbox")> = () => import("microsandbox"),
		private readonly checkHardware: () => void = checkLocalHardware,
		private readonly bootDeadlineMs: number = BOOT_DEADLINE_MS,
		private readonly guestRpcDeadlineMs: number = GUEST_FS_DEADLINE_MS) {
		this.config = validateSandboxConfig(loaded.config.sandbox);
		this.workspaceDir = guestHome(loaded.config.name);
		this.guestEnv = { HOME: this.workspaceDir, XDG_CACHE_HOME: `${this.workspaceDir}/.cache`, ...this.config.env };
		// Upgrade previous default env values in persisted profiles, not arbitrary overrides.
		if (this.guestEnv.HOME === "/workspace") this.guestEnv.HOME = this.workspaceDir;
		if (this.guestEnv.XDG_CACHE_HOME === "/workspace/.cache") this.guestEnv.XDG_CACHE_HOME = `${this.workspaceDir}/.cache`;
		this.owner = digest(path.resolve(loaded.paths.stateDir));
		this.name = `alive-${this.owner}`;
		this.workspaceVolume = `alive-private-${this.owner}`;
		const { idleTimeoutMs: _idle, checkIntervalMs: _check, offlineFiles: _offline, maxFileBytes: _max, ...boot } = this.config;
		// Bump layout when changing mount/identity/boot semantics. A persisted VM
		// from an incompatible implementation must never be reused silently.
		this.fingerprint = digest(JSON.stringify({ layout: "alive-microsandbox-v3", sdk: "0.7.8", ...boot, workspace: this.workspaceDir, env: this.guestEnv }));
		this.holdsPath = path.join(loaded.paths.stateDir, "sandbox-holds.json");
		if (fs.existsSync(this.holdsPath)) {
			const holds: unknown = JSON.parse(fs.readFileSync(this.holdsPath, "utf8"));
			if (!holds || typeof holds !== "object" || Array.isArray(holds)
				|| Object.values(holds).some((reason) => typeof reason !== "string")) throw new Error("Invalid sandbox holds file; refusing automatic lifecycle management");
			for (const [key, reason] of Object.entries(holds)) this.holds.set(key, reason as string);
		}
	}

	path(file: string): string { return guestPath(file, this.workspaceDir); }

	/** Lazy SDK loading: host-only profiles do not require microsandbox native runtime. */
	private sdk(): Promise<typeof import("microsandbox")> {
		return this.sdkPromise ??= this.loadSdk();
	}

	startMonitoring(): void {
		if (this.timer || this.closed || !this.config.enabled) return;
		this.timer = setInterval(() => {
			if (this.pending || this.closed) return;
			void this.checkIdle().catch((error) => this.report(error));
		}, this.config.checkIntervalMs);
		this.timer.unref();
	}

	private report(error: unknown): void {
		this.emptyObservedAt = undefined;
		this.lastError = error instanceof Error ? error.message : String(error);
		this.log.warn("sandbox check failed; VM retained (no host fallback)", { sandbox: this.name, error: this.lastError });
	}

	async exclusive<T>(operation: () => Promise<T>, activity = true): Promise<T> {
		if (this.closed) throw new Error("Sandbox manager is closed");
		this.pending++;
		const run = this.tail.then(async () => {
			if (activity) { this.lastActivity = Date.now(); this.emptyObservedAt = undefined; }
			try { return await operation(); }
			finally { if (activity) this.lastActivity = Date.now(); }
		});
		this.tail = run.catch(() => undefined);
		try { return await run; } finally { this.pending--; }
	}

	private async handle(): Promise<SandboxHandle | undefined> {
		const sdk = await this.sdk();
		let handle: SandboxHandle;
		try { handle = await sdk.Sandbox.get(this.name); }
		catch (error) { if (hasCode(error, "sandboxNotFound")) return undefined; throw error; }
		if (handle.backendKind !== "local") throw new Error("Alive requires a local microsandbox backend");
		const labels = handle.config().labels as Record<string, string> | undefined;
		if (labels?.["alive.owner"] !== this.owner || labels?.["alive.config"] !== this.fingerprint) {
			throw new Error(`Sandbox configuration/ownership mismatch for ${this.name}. Stop Alive, inspect and explicitly stop/remove the old VM with msb, then restart. Private volumes are retained.`);
		}
		return handle;
	}

	private async ensureVolume(name: string): Promise<VolumeFs> {
		const sdk = await this.sdk();
		try { return (await sdk.Volume.get(name)).fs(); }
		catch (error) {
			if (!hasCode(error, "volumeNotFound")) throw error;
			try { return (await sdk.Volume.builder(name).directory().create()).fs(); }
			catch (createdError) {
				if (!hasCode(createdError, "volumeAlreadyExists")) throw createdError;
				return (await sdk.Volume.get(name)).fs();
			}
		}
	}

	/** Attach/create is the other unbounded SDK operation: a stuck boot would hold
	 * the exclusive queue forever. A late VM from a timed-out attempt is detached. */
	private async boot<T>(start: Promise<T>, onLate: (value: T) => unknown): Promise<T> {
		let timer: NodeJS.Timeout | undefined;
		let settled = false;
		try {
			return await Promise.race([
				start.then((value) => { settled = true; return value; }),
				new Promise<never>((_, reject) => {
					timer = setTimeout(() => reject(new Error(`Sandbox boot did not complete in ${this.bootDeadlineMs} ms`)), this.bootDeadlineMs);
				}),
			]);
		} catch (error) {
			if (!settled) void start.then((value) => onLate(value), () => undefined).catch(() => undefined);
			throw error;
		} finally { if (timer) clearTimeout(timer); }
	}

	private async running(): Promise<Sandbox> {
		const handle = await this.handle();
		if (handle) {
			if (this.vm && this.vm.id !== handle.id) throw new Error("Sandbox replaced externally; refusing access");
			if (!this.vm || handle.status !== "running") {
				if (handle.status !== "running") this.checkHardware();
				await this.vm?.detach();
				try { this.vm = await this.boot(handle.connectOrStart({ detached: true }), (late) => late.detach()); }
				catch (error) {
					// Never keep a half-attached VM: the next operation must retry cleanly.
					this.vm = undefined;
					throw error;
				}
			}
			return this.vm;
		}
		if (this.vm) throw new Error("Sandbox removed externally; refusing implicit replacement");
		this.checkHardware();
		const sdk = await this.sdk();
		await this.ensureVolume(this.workspaceVolume);
		for (const volume of this.config.sharedVolumes) await this.ensureVolume(volume.name);
		let builder = sdk.Sandbox.builder(this.name)
			.image(this.config.image).cpus(this.config.cpus).memory(this.config.memoryMiB)
			.detached(true).disableMetricsSample().workdir(this.workspaceDir).user(`${this.config.uid}:${this.config.gid}`)
			.entrypoint([]).cmd([]).envs(this.guestEnv)
			.label("alive.owner", this.owner).label("alive.config", this.fingerprint)
			.volume(this.workspaceDir, (mount) => mount.named(this.workspaceVolume).owner(this.config.uid, this.config.gid).nosuid().nodev());
		if (!this.config.network) builder = builder.disableNetwork();
		else if (this.config.networkAccess === "public") builder = builder.network((network) => network.policyFromBuilder(publicNetworkPolicy(sdk)));
		for (const volume of this.config.sharedVolumes) {
			builder = builder.volume(volume.mountPath, (mount) => {
				const configured = mount.named(volume.name).nosuid().nodev();
				return volume.readOnly ? configured.readonly() : configured;
			});
		}
		if (this.config.dockerDiskMiB) {
			builder = builder.volume("/var/lib/docker", (mount) => mount.owned({ kind: "disk", sizeMib: this.config.dockerDiskMiB }));
		}
		this.vm = await this.boot(builder.create(), (late) => late.detach());
		if (this.vm.backendKind !== "local") { await this.vm.detach(); this.vm = undefined; throw new Error("Alive requires local microsandbox"); }
		this.log.info("sandbox booted", { name: this.name, memoryMiB: this.config.memoryMiB });
		return this.vm;
	}

	/** Called inside exclusive(), never exposes host environment or host credentials. */
	async execute(command: string, timeoutMs: number, signal?: AbortSignal, onData?: (data: Buffer) => void, cwd = this.workspaceDir): Promise<{ text: string; code: number; truncated: boolean }> {
		signal?.throwIfAborted();
		const deadlineMs = timeoutMs + EXEC_DEADLINE_GRACE_MS;
		let exec: ExecHandle | undefined;
		let consumed: Promise<void> | undefined;
		let output = Buffer.alloc(0);
		let truncated = false;
		let exitCode: number | undefined;
		let timer: NodeJS.Timeout | undefined;
		const abort = () => { if (exec) void exec.kill().catch((error) => this.report(error)); };
		try {
			signal?.addEventListener("abort", abort, { once: true });
			// Boot carries its own deadline. The command timeout must not be spent on
			// attaching, or a slow first boot would report a fake command timeout.
			const vm = await this.running();
			signal?.throwIfAborted();
			const startedAt = Date.now();
			// Bounds the command itself (stream, exit). The SDK only bounds the guest
			// process; a dead guest never closes the event stream.
			const deadline = new Promise<never>((_, reject) => {
				timer = setTimeout(() => {
					// Command text may contain secrets: only its length is safe to log.
					this.log.warn("sandbox command deadline exceeded", { deadlineMs, commandLength: command.length });
					abort();
					reject(new Error(`Sandbox command did not finish within ${deadlineMs} ms (no exit event from guest); killed`));
				}, deadlineMs);
			});
			void deadline.catch(() => undefined); // A later throw may discard the race.
			const session = await Promise.race([vm.execStreamWith("/bin/bash", (b) => b.args(["-c", command]).cwd(guestPath(cwd, this.workspaceDir))
				.user(`${this.config.uid}:${this.config.gid}`).timeout(timeoutMs).stdinNull()), deadline]);
			exec = session;
			if (signal?.aborted) abort();
			consumed = (async () => {
				for await (const event of session) {
					if (event.kind === "exited") { exitCode = event.code; break; }
					if (event.kind !== "stdout" && event.kind !== "stderr") continue;
					const bytes = Buffer.from(event.data);
					output = Buffer.concat([output, bytes]);
					if (output.length > 64 * 1024) { output = output.subarray(output.length - 64 * 1024); truncated = true; }
					onData?.(output);
				}
			})();
			void consumed.catch(() => undefined); // The deadline may win; teardown still settles it.
			await Promise.race([consumed, deadline]);
			// microsandbox 0.7.8 wait() consumes the same event queue as the
			// iterator; calling it after consuming `exited` loses the exit event.
			// Raw events don't surface ExecTimeout, so retain deadline reporting
			// after the SDK has confirmed termination (never unlock on a timer).
			if (exitCode === undefined) exitCode = (await Promise.race([session.wait(), deadline])).code;
			signal?.throwIfAborted();
			if (Date.now() - startedAt >= timeoutMs) throw new Error(`Sandbox command timed out after ${timeoutMs} ms`);
			return { text: output.toString("utf8"), code: exitCode, truncated };
		} finally {
			signal?.removeEventListener("abort", abort);
			if (timer) clearTimeout(timer);
			if (exec) {
				const session = exec;
				// Bounded teardown; a dead guest must never leave the exclusive queue locked.
				await bounded(Promise.resolve().then(() => session[Symbol.asyncDispose]()), TEARDOWN_DEADLINE_MS);
				if (consumed) await bounded(consumed, TEARDOWN_DEADLINE_MS);
			}
		}
	}

	/** Guest RPC has no host-side wait: a dead guest must not wedge a file operation. */
	private async guestRpc<T>(op: string, operation: Promise<T>): Promise<T> {
		let timer: NodeJS.Timeout | undefined;
		try {
			return await Promise.race([operation, new Promise<never>((_, reject) => {
				timer = setTimeout(() => reject(new Error(`Guest filesystem ${op} timed out after ${this.guestRpcDeadlineMs} ms`)), this.guestRpcDeadlineMs);
			})]);
		} finally { if (timer) clearTimeout(timer); }
	}

	private liveFiles(): VirtualFiles {
		const rpc = async (op: string, file: string, data?: string) => {
			const vm = await this.running();
			const result = await this.guestRpc(op, vm.execWith("python3", (b) => b.args(["-I", "-S", "-c", FILE_RPC])
				.user(`${this.config.uid}:${this.config.gid}`).timeout(GUEST_FS_DEADLINE_MS)
				.stdinBytes(Buffer.from(JSON.stringify({ op, path: this.path(file), maxBytes: this.config.maxFileBytes, data })))));
			if (!result.success) throw new Error(`Guest filesystem ${op} failed: ${result.stderr().slice(0, 4000)}`);
			return JSON.parse(result.stdout());
		};
		return {
			read: async (file) => Buffer.from(await rpc("read", file), "base64"),
			write: async (file, content) => { this.checkSize(content); this.assertWritable(file); await rpc("write", file, Buffer.from(content).toString("base64")); },
			mkdir: async (file) => { this.assertWritable(file); await rpc("mkdir", file); },
			stat: (file) => rpc("stat", file),
			list: (file) => rpc("list", file),
		};
	}

	private assertWritable(file: string): void {
		const normalized = this.path(file);
		if (this.config.sharedVolumes.some((v) => v.readOnly && (normalized === v.mountPath || normalized.startsWith(`${v.mountPath}/`)))) {
			throw new Error("Shared volume is read-only");
		}
	}

	private checkSize(content: string | Buffer): void {
		if (Buffer.byteLength(content) > this.config.maxFileBytes) throw new Error("Content exceeds configured sandbox.maxFileBytes");
	}

	/** A tool selects its route under the lifecycle lock. VolumeFs is capability-
	 * scoped by microsandbox, not realpath-then-open on arbitrary host paths.
	 * Only an absent/stopped VM permits offline access. Symlinks/special modes
	 * use the guest instead, preserving guest-relative link and permission semantics.
	 */
	async files(forceGuestMetadata = false): Promise<VirtualFiles> {
		const handle = await this.handle();
		const offline = !forceGuestMetadata && this.config.offlineFiles && this.config.uid === 0 && this.config.gid === 0
			&& (!handle || handle.status === "stopped" || handle.status === "created");
		const live = this.liveFiles();
		if (!offline) return live;
		const volume = await this.ensureVolume(this.workspaceVolume);
		const route = async (file: string, writing = false): Promise<string | undefined> => {
			const currentHandle = await this.handle();
			if (currentHandle && currentHandle.status !== "stopped" && currentHandle.status !== "created") return undefined;
			const normalized = this.path(file);
			if (normalized !== this.workspaceDir && !normalized.startsWith(`${this.workspaceDir}/`)) return undefined;
			const relative = normalized.slice(this.workspaceDir.length) || "/";
			const parts = relative.split("/").filter(Boolean);
			let current = "";
			for (const part of parts) {
				current += `/${part}`;
				let meta;
				try { meta = await volume.stat(current); } // Native Volume.stat is lstat-like, including dangling links.
				catch (error) {
					// exists() alone would misclassify a dangling symlink as a missing file.
					// Permission and other IO errors are not silently treated as absence.
					if (hasCode(error, "io") && !(await volume.exists(current))) break;
					throw error;
				}
				if (meta.kind === "symlink" || meta.kind === "other" || (meta.mode & 0o7000) || (writing && meta.readonly)
					|| (meta.kind === "directory" && !(meta.mode & 0o100)) || (!writing && meta.kind === "file" && !(meta.mode & 0o400))) return undefined;
			}
			return relative;
		};
		return {
			read: async (file) => {
				const p = await route(file);
				if (p === undefined) return live.read(file);
				const meta = await volume.stat(p);
				if (meta.kind !== "file") throw new Error("Only regular files can be read");
				if (meta.size > this.config.maxFileBytes) throw new Error("File exceeds configured sandbox.maxFileBytes");
				const stream = await volume.readStream(p);
				const chunks: Buffer[] = [];
				let size = 0;
				try {
					for await (const chunk of stream) {
						size += chunk.length;
						if (size > this.config.maxFileBytes) throw new Error("File exceeds configured sandbox.maxFileBytes");
						chunks.push(Buffer.from(chunk));
					}
				} finally { await stream[Symbol.asyncDispose](); }
				return Buffer.concat(chunks);
			},
			write: async (file, content) => {
				this.checkSize(content);
				const p = await route(file, true);
				if (p === undefined) return live.write(file, content);
				await volume.write(p, content);
			},
			mkdir: async (file) => { const p = await route(file, true); if (p === undefined) return live.mkdir(file); await volume.mkdir(p); },
			stat: async (file) => { const p = await route(file); return p === undefined ? live.stat(file) : volume.stat(p); },
			list: async (file) => {
				const p = await route(file);
				const entries = p === undefined ? await live.list(file) : await volume.list(p);
				if (entries.length > 10000) throw new Error("Directory exceeds 10000 entries");
				// SDK volume entries may include parent-relative paths; tools need basenames.
				return entries.map((entry) => ({ ...entry, path: path.posix.basename(entry.path) }));
			},
		};
	}

	private async inspectActivity(): Promise<IdleEvidence> {
		const vm = await this.running();
		const result = await this.guestRpc("activity probe", vm.execWith("python3", (b) => b.args(["-I", "-S", "-c", IDLE_PROBE, this.workspaceDir]).user("0:0").timeout(10_000).stdinNull()));
		if (!result.success) throw new Error(`VM activity probe failed: ${result.stderr().slice(0, 2000)}`);
		const evidence = parseIdleEvidence(result.stdout());
		// Detached jobs can be admitted before they get a /proc PID. A lost job
		// or incomplete inventory is uncertainty, not permission to stop.
		evidence.jobs = [];
		let cursor: string | undefined;
		let inspected = 0;
		const seen = new Set<string>();
		for (let page = 0; ; page++) {
			if (page >= MAX_JOB_PAGES) throw new Error(`VM job inventory exceeds ${MAX_JOB_PAGES} pages; shutdown refused`);
			// A dead guest must not wedge the idle check, which is the most frequent path.
			const jobs = await this.guestRpc("job inventory", vm.listJobsWith((b) => cursor ? b.all().limit(100).cursor(cursor) : b.all().limit(100)));
			inspected += jobs.items.length;
			if (inspected > 10000) throw new Error("VM job inventory exceeds safe scan limit; shutdown refused");
			evidence.jobs.push(...jobs.items.filter((job) => job.state !== "exited" && job.state !== "failed")
				.map((job) => ({ id: job.id, state: job.state })));
			if (!jobs.nextCursor) break;
			if (seen.has(jobs.nextCursor)) throw new Error("VM job inventory has a repeated cursor; shutdown refused");
			seen.add(jobs.nextCursor);
			cursor = jobs.nextCursor;
		}
		this.evidence = evidence;
		this.lastError = undefined;
		this.evidenceAt = Date.now();
		return evidence;
	}

	async checkIdle(now = Date.now()): Promise<boolean> {
		return this.exclusive(async () => {
			if (!this.config.idleTimeoutMs || this.holds.size || now - this.lastActivity < this.config.idleTimeoutMs) return false;
			const handle = await this.handle();
			if (!handle || handle.status === "stopped" || handle.status === "created") return false;
			if (handle.status !== "running") { this.emptyObservedAt = undefined; return false; }
			const evidence = await this.inspectActivity();
			if (evidence.processes.length || evidence.containers.length || evidence.workspaceMounts.length || evidence.jobs?.length) { this.emptyObservedAt = undefined; return false; }
			if (this.emptyObservedAt === undefined) { this.emptyObservedAt = now; return false; }
			if (now - this.emptyObservedAt < this.config.checkIntervalMs) return false;
			if (this.pending > 1) return false; // A tool/hold queued while inspection was in flight.
			await handle.stopWithTimeout(10_000);
			await this.vm?.detach();
			this.vm = undefined;
			this.emptyObservedAt = undefined;
			this.log.info("sandbox stopped after two empty process/Docker observations", { name: this.name });
			return true;
		}, false).catch((error) => { this.report(error); return false; });
	}

	async control(action: "status" | "pin" | "unpin", key?: string, reason?: string): Promise<unknown> {
		return this.exclusive(async () => {
			if (action !== "status") {
				if (!key || !/^[a-zA-Z0-9_-]{1,64}$/.test(key)) throw new Error("A hold key (1..64 letters/digits/_/-) is required");
				const proposed = new Map(this.holds);
				if (action === "pin") {
					if (!reason?.trim() || reason.length > 2000) throw new Error("A bounded non-empty hold reason is required");
					proposed.set(key, reason);
				} else proposed.delete(key);
				fs.mkdirSync(path.dirname(this.holdsPath), { recursive: true });
				const temporary = `${this.holdsPath}.${process.pid}.tmp`;
				fs.writeFileSync(temporary, `${JSON.stringify(Object.fromEntries(proposed), null, 2)}\n`, { mode: 0o600 });
				fs.renameSync(temporary, this.holdsPath);
				this.holds.clear();
				for (const [holdKey, holdReason] of proposed) this.holds.set(holdKey, holdReason);
			}
			const handle = await this.handle();
			return { name: this.name, workspaceVolume: this.workspaceVolume, workspaceDir: this.workspaceDir, status: handle?.status ?? "not-created",
				holds: Object.fromEntries(this.holds), lastActivity: this.lastActivity, evidence: this.evidence, evidenceAt: this.evidenceAt, lastError: this.lastError,
				memoryMiB: this.config.memoryMiB, sharedVolumes: this.config.sharedVolumes };
		}, action !== "status");
	}

	async close(): Promise<void> {
		if (this.closed) return;
		this.closed = true;
		if (this.timer) clearInterval(this.timer);
		this.timer = undefined;
		await this.tail;
		// Never destroy background services on agent/context shutdown. A detached VM
		// persists; after a crash/restart the next owner reconciles its actual state.
		await this.vm?.detach();
		this.vm = undefined;
	}
}
