import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import * as fs from "node:fs";
import * as net from "node:net";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { startQuickTunnel } from "../modules/browser/tunnel.js";
import { readRuntimeState } from "../store/runs.js";
import { sleep } from "../util.js";

const root = fs.mkdtempSync(path.join(os.tmpdir(), "alive-browser-cli-"));
const entry = fileURLToPath(new URL("../index.ts", import.meta.url));
const environment = { ...process.env, ALIVE_TELEGRAM_TOKEN: "", ALIVE_BROWSER_SIGNING_KEY_FILE: "" };
let child: ChildProcess | undefined;
let tunnel: Awaited<ReturnType<typeof startQuickTunnel>> | undefined;
function launch(...args: string[]): { child: ChildProcess; output: () => string } {
	const processChild = spawn(process.execPath, [...process.execArgv, entry, "browser", ...args], { cwd: root, env: environment, stdio: ["ignore", "pipe", "pipe"] });
	let output = "";
	processChild.stdout!.on("data", data => { output += data; });
	processChild.stderr!.on("data", data => { output += data; });
	return { child: processChild, output: () => output };
}
try {
	let command = launch("setup", "--headless");
	assert.equal((await once(command.child, "exit"))[0], 0, command.output());
	command = launch("doctor");
	assert.equal((await once(command.child, "exit"))[0], 1, "Doctor must report the missing external setup");
	assert.match(command.output(), /not configured/);
	assert.match(command.output(), /not paired/);
	assert.match(command.output(), /Telegram token: missing/);
	const socket = net.createServer();
	await new Promise<void>(resolve => socket.listen(0, "127.0.0.1", resolve));
	const port = (socket.address() as { port: number }).port;
	await new Promise<void>(resolve => socket.close(() => resolve()));
	const localPath = path.join(root, "alive.config.local.json");
	const config = JSON.parse(fs.readFileSync(localPath, "utf8"));
	config.modules.browser.port = port;
	fs.writeFileSync(localPath, JSON.stringify(config));
	command = launch("serve", "--local", "--headless");
	child = command.child;
	const deadline = Date.now() + 20_000;
	while (!command.output().includes("Browser serve is running") && Date.now() < deadline && child.exitCode === null) await sleep(30);
	const link = command.output().match(/http:\/\/127\.0\.0\.1:\d+\/browser#[A-Za-z0-9_-]{43}/)?.[0];
	assert.ok(link, "Standalone serve must issue a local operator capability");
	const url = new URL(link);
	const stateDir = path.join(root, ".alive");
	assert.equal(readRuntimeState(stateDir)?.pid, child.pid);
	assert.equal(readRuntimeState(stateDir)?.status, "idle");
	const original = url.hash.slice(1);
	const claim = await fetch(`${url.origin}/browser/claim`, { method: "POST", headers: { "content-type": "application/json", Authorization: `Bearer ${original}` }, body: "{}" });
	assert.equal(claim.status, 200);
	const { credential } = await claim.json() as { credential: string };
	const frame = await fetch(`${url.origin}/browser/frame`, { headers: { Authorization: `Bearer ${credential}` } });
	assert.equal(frame.status, 200);
	assert.equal(frame.headers.get("content-type"), "image/jpeg");
	assert.ok((await frame.arrayBuffer()).byteLength > 1000);
	const blocked = launch("serve", "--local", "--headless");
	assert.equal((await once(blocked.child, "exit"))[0], 1);
	assert.match(blocked.output(), /owns this state directory/);
	const exit = once(child, "exit");
	child.kill("SIGTERM");
	assert.equal((await exit)[0], 0);
	assert.equal(readRuntimeState(stateDir)?.status, "stopped");
	await assert.rejects(fetch(`${url.origin}/browser/frame`));
	child = undefined;

	// Test subprocess parsing/cleanup without creating a public tunnel.
	const fake = path.join(root, "fake-cloudflared");
	fs.writeFileSync(fake, `#!${process.execPath}\nprocess.stderr.write('https://fixture-');setTimeout(()=>process.stderr.write('tunnel.trycloudflare.com\\n'),20);setTimeout(()=>process.stderr.write('Registered tunnel connection\\n'),40);setInterval(()=>{},1000);\n`, { mode: 0o700 });
	const abort = new AbortController();
	tunnel = await startQuickTunnel("http://127.0.0.1:4323", abort.signal, fake);
	assert.equal(tunnel.origin, "https://fixture-tunnel.trycloudflare.com");
	await tunnel.stop();
	await tunnel.stop();
	const failed = path.join(root, "failed-cloudflared");
	fs.writeFileSync(failed, `#!${process.execPath}\nprocess.stderr.write('https://unconnected.trycloudflare.com\\n');setTimeout(()=>process.exit(1),30);\n`, { mode: 0o700 });
	await assert.rejects(startQuickTunnel("http://127.0.0.1:4323", new AbortController().signal, failed), /exited/, "A hostname without a registered connection must not be reported as ready");
	const blockedTunnel = path.join(root, "blocked-cloudflared");
	fs.writeFileSync(blockedTunnel, `#!${process.execPath}\nprocess.stderr.write('https://blocked.trycloudflare.com\\nAllow outbound TCP on port 7844\\n');setInterval(()=>{},1000);\n`, { mode: 0o700 });
	await assert.rejects(startQuickTunnel("http://127.0.0.1:4323", new AbortController().signal, blockedTunnel), /port 7844/, "Firewall failures must have an actionable error");
	console.log("Browser CLI E2E passed: setup/doctor, real Chrome standalone demo without LLM, authenticated frame, single-instance protection, graceful shutdown, tunnel URL parsing and process cleanup.");
} finally {
	child?.kill("SIGKILL");
	await tunnel?.stop();
	fs.rmSync(root, { recursive: true, force: true });
}
