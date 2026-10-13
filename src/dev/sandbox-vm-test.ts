/** Opt-in real KVM integration. Not part of the portable test suite. */
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { loadConfig } from "../config.js";
import { Logger } from "../log.js";
import { SandboxManager } from "../sandbox/manager.js";

if (process.platform === "linux") {
	try { fs.accessSync("/dev/kvm", fs.constants.R_OK | fs.constants.W_OK); }
	catch { throw new Error("Real VM test requires read/write access to /dev/kvm. Grant the operator KVM access and restart the login session; no host fallback or fake success."); }
}

const sdk = await import("microsandbox");
const directory = fs.mkdtempSync(path.join(os.tmpdir(), "alive-real-vm-"));
const loaded = loadConfig({ cwd: directory });
loaded.config.name = "VM Tester";
// Old persisted defaults must be upgraded to the agent home too.
loaded.config.sandbox.env = { HOME: "/workspace", XDG_CACHE_HOME: "/workspace/.cache" };
const shared = await sdk.Volume.builder(`alive-test-shared-${Date.now()}`).directory().create();
await shared.fs().write("/resource.txt", "one shared resource\n");
loaded.config.sandbox = { ...loaded.config.sandbox, sharedVolumes: [{ name: shared.name, mountPath: "/shared", readOnly: true }], idleTimeoutMs: 1, checkIntervalMs: 1000,
	image: process.env.ALIVE_SANDBOX_TEST_IMAGE || "python:3.12-slim" };
const manager = new SandboxManager(loaded, new Logger());
const home = manager.workspaceDir;
assert.equal(home, "/home/vm-tester");
const command = (script: string) => manager.exclusive(() => manager.execute(script, 30_000));

try {
	await manager.exclusive(async () => (await manager.files()).write(manager.path("file.txt"), "before boot\n"));
	assert.equal((await manager.control("status") as any).status, "not-created");
	const read = await command("cat ~/file.txt; printf '\nHOME=%s\nPWD=%s\nCACHE=%s\n' \"$HOME\" \"$PWD\" \"$XDG_CACHE_HOME\"");
	assert.equal(read.code, 0);
	assert.match(read.text, /before boot/);
	assert.ok(read.text.includes(`HOME=${home}\n`));
	assert.ok(read.text.includes(`PWD=${home}\n`));
	assert.ok(read.text.includes(`CACHE=${home}/.cache\n`));
	assert.equal((await command("test ! -e /workspace/file.txt")).code, 0, "old workspace is not mounted");
	const nonzero = await command("printf 'expected failure'; exit 7");
	assert.equal(nonzero.code, 7);
	assert.equal(nonzero.text, "expected failure");
	await assert.rejects(manager.exclusive(() => manager.execute("sleep 5", 200)), /timed out|timeout/i);
	assert.equal((await command("printf 'after timeout'")).text, "after timeout", "VM remains usable after command timeout");
	const sharedRead = await command("cat /shared/resource.txt; mount -o remount,rw /shared >\"$HOME/remount.log\" 2>&1 || true; if touch /shared/must-not-write 2>/dev/null; then exit 42; fi");
	assert.equal(sharedRead.code, 0, "shared mount must be read-only inside guest");
	assert.match(sharedRead.text, /one shared resource/);
	// Real inotify observer: online writes must happen in the guest, not through
	// host Volume.fs (virtiofs host-write notification is not assumed).
	const watch = `import ctypes,os,select; lib=ctypes.CDLL(None); fd=lib.inotify_init1(0); wd=lib.inotify_add_watch(fd,b'${home}/file.txt',10); assert wd>=0; open('${home}/watch.ready','w').close(); ready=select.select([fd],[],[],20)[0]; assert ready; data=os.read(fd,4096); open('${home}/watch.events','w').write(str(len(data)))`;
	const quoted = `'${watch.replaceAll("'", "'\\''")}'`;
	await command(`nohup python3 -I -S -c ${quoted} >"$HOME/watch.log" 2>&1 </dev/null & for i in $(seq 1 100); do test -e "$HOME/watch.ready" && break; sleep 0.1; done; test -e "$HOME/watch.ready"`);
	await manager.exclusive(async () => (await manager.files()).write(manager.path("file.txt"), "watcher event\n"));
	const notified = await command('for i in $(seq 1 100); do test -s "$HOME/watch.events" && break; sleep 0.1; done; test -s "$HOME/watch.events"');
	assert.equal(notified.code, 0, "guest watcher must observe file-tool writes");
	await command("chmod 640 ~/file.txt");
	await manager.exclusive(async () => (await manager.files()).write(manager.path("file.txt"), "live guest write\n"));
	const mode = await command("stat -c '%a' ~/file.txt; cat ~/file.txt");
	assert.match(mode.text, /640/);
	assert.match(mode.text, /live guest write/);
	await manager.control("pin", "critical", "VM integration background process");
	await command("nohup python3 -c 'import time; time.sleep(300)' >~/bg.log 2>&1 </dev/null & echo $! >~/bg.pid");
	const future = Date.now() + 100_000;
	assert.equal(await manager.checkIdle(future), false, "durable hold prevents shutdown");
	await manager.control("unpin", "critical");
	assert.equal(await manager.checkIdle(future + 1000), false, "detached background process prevents shutdown even without a hold");
	await command("kill $(cat ~/bg.pid)");
	assert.equal(await manager.checkIdle(future + 2000), false);
	const stopped = await manager.checkIdle(future + 3000);
	if (!stopped) console.error("Idle evidence:", await manager.control("status"));
	assert.equal(stopped, true, "empty VM should stop after two observations");
	await manager.exclusive(async () => (await manager.files()).write(manager.path("file.txt"), "offline after shutdown\n"));
	assert.equal((await manager.control("status") as any).status, "stopped");
	const restarted = await command("cat ~/file.txt");
	assert.match(restarted.text, /offline after shutdown/);
	console.log("sandbox-vm-test: ok (real boot, shared readonly volume, permissions/inotify, background processes, idle shutdown, restart)");
} finally {
	await manager.close();
	try {
		const handle = await sdk.Sandbox.get(manager.name);
		await handle.stopWithTimeout(10_000);
		await sdk.Sandbox.remove(manager.name);
	} catch (error) {
		if ((error as { code?: string }).code !== "sandboxNotFound") throw error;
	}
	await sdk.Volume.remove(manager.workspaceVolume);
	await sdk.Volume.remove(shared.name);
	fs.rmSync(directory, { recursive: true, force: true });
}
