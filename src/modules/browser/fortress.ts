import { execFile } from "node:child_process";
import { randomBytes, createHash } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { WebSocket } from "ws";

interface Owner { id: string; token: string; image: string; imageId: string; profileHash: string; endpoint: string }
interface Inspection {
	Id: string; Image: string;
	State: { Running: boolean };
	Config: { Labels: Record<string, string> };
	HostConfig: { PortBindings: Record<string, Array<{ HostIp: string; HostPort: string }> | null> };
	Mounts: Array<{ Type: string; Source: string; Destination: string; RW: boolean }>;
	NetworkSettings: { Ports: Record<string, Array<{ HostIp: string; HostPort: string }> | null> };
}
export interface ManagedFortress { endpoint: string; image: string; close(): Promise<void> }

function dockerExecutable(): string {
	if (process.platform === "darwin" && fs.existsSync("/usr/local/bin/docker")) return "/usr/local/bin/docker";
	return "docker";
}
async function docker(args: string[], signal?: AbortSignal): Promise<string> {
	return await new Promise((resolve, reject) => {
		execFile(dockerExecutable(), args, { timeout: 20_000, maxBuffer: 2 * 1024 * 1024, signal }, (error, stdout) => {
			if (error) reject(signal?.aborted ? signal.reason : new Error(`Managed Fortress Docker ${args[0]} failed; verify Docker, the installed pinned image and its resources`));
			else resolve(stdout.trim());
		});
	});
}
export function validateFortressImage(image: string): void {
	if (!/^tilion\/fortress@sha256:[a-f0-9]{64}$/.test(image)) throw new Error("Fortress requires an official tilion/fortress image pinned by SHA-256 digest");
}
export async function fortressImageInstalled(image: string): Promise<boolean> {
	validateFortressImage(image);
	try { return JSON.parse(await docker(["image", "inspect", image]))[0]?.RepoDigests?.includes(image) === true; }
	catch { return false; }
}

function readOwner(file: string): Owner | undefined {
	if (!fs.existsSync(file)) return;
	let owner: Owner;
	try { owner = JSON.parse(fs.readFileSync(file, "utf8")); }
	catch { throw new Error("Invalid Fortress ownership record"); }
	if (!/^[a-f0-9]{64}$/.test(owner.id) || !/^sha256:[a-f0-9]{64}$/.test(owner.imageId) || !/^[a-f0-9]{32}$/.test(owner.token) || !/^[a-f0-9]{64}$/.test(owner.profileHash)) throw new Error("Invalid Fortress ownership record");
	validateFortressImage(owner.image);
	const endpoint = new URL(owner.endpoint);
	if (endpoint.protocol !== "http:" || endpoint.hostname !== "127.0.0.1" || !endpoint.port || endpoint.pathname !== "/" || endpoint.username || endpoint.password || endpoint.search || endpoint.hash) throw new Error("Invalid Fortress ownership endpoint");
	return owner;
}
async function inspect(id: string): Promise<Inspection | undefined> {
	// docker ps succeeds with no IDs when a container no longer exists. A daemon
	// failure is distinct and must not erase an ownership record or start a duplicate.
	const found = await docker(["ps", "-a", "--no-trunc", "--filter", `id=${id}`, "--format", "{{.ID}}"]);
	if (!found.split("\n").includes(id)) return;
	return JSON.parse(await docker(["inspect", id]))[0] as Inspection;
}
function matches(info: Inspection, owner: Owner, profile: string): boolean {
	const labels = info.Config.Labels || {};
	const mount = info.Mounts.find(mount => mount.Destination === "/alive/profile");
	const home = info.Mounts.find(mount => mount.Destination === "/alive/home");
	const ports = info.NetworkSettings.Ports["9222/tcp"];
	const binding = info.HostConfig.PortBindings["9222/tcp"];
	return info.Id === owner.id && info.Image === owner.imageId
		&& labels["alive.browser"] === "fortress" && labels["alive.owner"] === owner.token && labels["alive.profile"] === owner.profileHash
		&& mount?.Type === "bind" && mount.RW && path.resolve(mount.Source) === profile
		&& home?.Type === "bind" && home.RW && path.resolve(home.Source) === path.join(path.dirname(profile), "fortress-home")
		&& binding?.length === 1 && binding[0].HostIp === "127.0.0.1"
		&& (!info.State.Running || (ports?.length === 1 && ports[0].HostIp === "127.0.0.1" && `http://127.0.0.1:${ports[0].HostPort}` === owner.endpoint));
}
async function waitEndpoint(endpoint: string, timeoutMs: number, signal: AbortSignal): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		signal.throwIfAborted();
		try {
			const response = await fetch(`${endpoint}/json/version`, { redirect: "error", signal: AbortSignal.any([signal, AbortSignal.timeout(1000)]) });
			const version = await response.json() as { webSocketDebuggerUrl?: string };
			if (response.ok && version.webSocketDebuggerUrl) return;
		} catch { signal.throwIfAborted(); }
		await delay(200, undefined, { signal });
	}
	throw new Error("Managed Fortress startup timed out; no browser was attached");
}

/** An owned, isolated container per conversation. No downloads, shared profiles or fallback. */
export async function launchManagedFortress(input: { image: string; profile: string; stateDir: string; timeoutMs: number; signal: AbortSignal }): Promise<ManagedFortress> {
	validateFortressImage(input.image); input.signal.throwIfAborted();
	const profile = path.resolve(input.profile), profileHash = createHash("sha256").update(profile).digest("hex");
	if (!path.isAbsolute(input.profile) || profile.includes(",")) throw new Error("Fortress requires an absolute dedicated profile path without commas");
	fs.mkdirSync(profile, { recursive: true, mode: 0o700 }); fs.chmodSync(profile, 0o700);
	const home = path.join(path.dirname(profile), "fortress-home");
	fs.mkdirSync(home, { recursive: true, mode: 0o700 }); fs.chmodSync(home, 0o700);
	fs.mkdirSync(path.join(home, ".tilion"), { recursive: true, mode: 0o700 });
	fs.mkdirSync(input.stateDir, { recursive: true, mode: 0o700 });
	const record = path.join(input.stateDir, "fortress-container.json"), previous = readOwner(record);
	if (previous) {
		if (previous.image !== input.image || previous.profileHash !== profileHash) throw new Error("Fortress ownership differs from this configuration; close the owned session before changing its image/profile");
		const info = await inspect(previous.id);
		if (info) {
			if (!matches(info, previous, profile)) throw new Error("Fortress ownership cannot be verified; no container was changed or attached");
			if (info.State.Running) {
				const browser = owned(previous, profile, record);
				try { await waitEndpoint(previous.endpoint, input.timeoutMs, input.signal); return browser; }
				catch (error) { await browser.close(); throw error; }
			}
			// A stopped owned container may receive a different ephemeral port on
			// restart. Replace the process while retaining its dedicated profile.
			await docker(["rm", previous.id], input.signal);
		}
		fs.unlinkSync(record);
	}
	// Inspect only a locally installed image. Setup instructions handle explicit pulling.
	const image = JSON.parse(await docker(["image", "inspect", input.image], input.signal))[0] as { Id: string; Architecture: string; RepoDigests: string[] };
	if (!image.RepoDigests?.includes(input.image) || !/^sha256:[a-f0-9]{64}$/.test(image.Id) || !["amd64", "arm64"].includes(image.Architecture)) throw new Error("Installed Fortress image does not match its configured digest/platform");
	const token = randomBytes(16).toString("hex"), name = `alive-fortress-${profileHash.slice(0, 12)}-${token.slice(0, 8)}`;
	// Preserve the launcher's bounded egress-country discovery. Supplying only
	// the host timezone leaves country unset and can generate an unrelated locale.
	const geoEnvironment = ["TILION_COUNTRY", "TILION_TZ", "TILION_NO_GEO"].flatMap(name => process.env[name] ? ["--env", `${name}=${process.env[name]}`] : []);
	const args = ["create", "--name", name, "--label", "alive.browser=fortress", "--label", `alive.owner=${token}`, "--label", `alive.profile=${profileHash}`,
		"--platform", `linux/${image.Architecture}`, "--publish", "127.0.0.1::9222", "--cap-drop", "ALL", "--security-opt", "no-new-privileges", "--read-only",
		"--memory", "3g", "--cpus", "2", "--pids-limit", "512", "--shm-size", "512m", "--tmpfs", "/tmp:rw,nosuid,size=256m",
		"--mount", `type=bind,source=${profile},target=/alive/profile`, "--mount", `type=bind,source=${home},target=/alive/home`,
		"--env", "HOME=/alive/home", ...geoEnvironment,
		input.image, "--user-data-dir=/alive/profile", "about:blank"];
	let owner: Owner | undefined, created: string | undefined;
	try {
		// Creation completes independently of cancellation so a cancelled command
		// cannot lose the container ID before its cleanup can verify ownership.
		created = await docker(args);
		if (!/^[a-f0-9]{64}$/.test(created)) throw new Error("Invalid Fortress container ID");
		input.signal.throwIfAborted();
		await docker(["start", created], input.signal);
		const info = await inspect(created);
		const ports = info?.NetworkSettings.Ports["9222/tcp"];
		if (!info || ports?.length !== 1 || ports[0].HostIp !== "127.0.0.1") throw new Error("Fortress debug endpoint must be bound only to loopback");
		owner = { id: created, token, image: input.image, imageId: image.Id, profileHash, endpoint: `http://127.0.0.1:${ports[0].HostPort}` };
		if (!matches(info, owner, profile)) throw new Error("Fortress container ownership verification failed");
		fs.writeFileSync(record, `${JSON.stringify(owner)}\n`, { mode: 0o600 }); fs.chmodSync(record, 0o600);
		await waitEndpoint(owner.endpoint, input.timeoutMs, input.signal);
		return owned(owner, profile, record);
	} catch (error) {
		if (owner) await owned(owner, profile, record).close();
		else if (created && /^[a-f0-9]{64}$/.test(created)) {
			const info = await inspect(created);
			if (info?.Config.Labels?.["alive.owner"] === token && info.Config.Labels["alive.profile"] === profileHash) await docker(["rm", "-f", created]);
		}
		throw error;
	}
}

function owned(owner: Owner, profile: string, record: string): ManagedFortress {
	let closed = false;
	return { endpoint: owner.endpoint, image: owner.image, close: async () => {
		if (closed) return;
		const info = await inspect(owner.id);
		if (info && !matches(info, owner, profile)) throw new Error("Fortress cleanup refused an unverifiable container");
		// Browser.close flushes persistent cookies and storage before the bridge
		// container is stopped. SIGTERM alone can terminate the launcher too early.
		if (info?.State.Running) {
			const pid = await closeChrome(owner.endpoint);
			if (pid) {
				const deadline = Date.now() + 5000;
				while (Date.now() < deadline) {
					const state = await docker(["exec", owner.id, "/bin/sh", "-c", `if [ -d /proc/${pid} ]; then printf running; else printf exited; fi`]);
					if (state === "exited") break;
					await delay(100);
				}
			}
		}
		if (info) await docker(["stop", "--time", "5", owner.id]);
		if (info) await docker(["rm", owner.id]);
		if (readOwner(record)?.id === owner.id) fs.unlinkSync(record);
		closed = true;
	} };
}

async function closeChrome(endpoint: string): Promise<number | undefined> {
	try {
		const response = await fetch(`${endpoint}/json/version`, { redirect: "error", signal: AbortSignal.timeout(2000) });
		const version = await response.json() as { webSocketDebuggerUrl?: string };
		const remote = new URL(version.webSocketDebuggerUrl!), local = new URL(endpoint);
		if (remote.protocol !== "ws:" || !/^\/devtools\/browser\/[a-zA-Z0-9-]+$/.test(remote.pathname) || remote.username || remote.password || remote.search || remote.hash) return;
		return await new Promise<number | undefined>(resolve => {
			let pid: number | undefined;
			const socket = new WebSocket(`ws://${local.host}${remote.pathname}`, { handshakeTimeout: 2000, maxPayload: 64 * 1024 });
			const timer = setTimeout(() => { socket.terminate(); resolve(pid); }, 3000);
			const finish = () => { clearTimeout(timer); socket.close(); resolve(pid); };
			socket.once("error", finish); socket.once("close", finish);
			socket.once("open", () => socket.send(JSON.stringify({ id: 1, method: "SystemInfo.getProcessInfo" })));
			socket.on("message", raw => {
				try {
					const message = JSON.parse(raw.toString());
					if (message.id === 1) {
						const id = message.result?.processInfo?.find((process: { type: string; id: number }) => process.type === "browser")?.id;
						if (Number.isInteger(id) && id > 0) pid = id;
						socket.send(JSON.stringify({ id: 2, method: "Browser.close" }));
					} else if (message.id === 2) finish();
				} catch { finish(); }
			});
		});
	} catch { /* An already exited browser still permits verified container cleanup. */ }
}
