import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { randomBytes } from "node:crypto";
import { spawn } from "node:child_process";
import { setTimeout as delay } from "node:timers/promises";
import { DEFAULT_BROWSER_CONFIG } from "../modules/browser/config.js";
import { SharedBrowserHost } from "../modules/browser/shared-server.js";
import { openSharedContext, type SharedContext } from "../modules/browser/shared-client.js";

const root = fs.mkdtempSync(path.join(os.tmpdir(), "alive-shared-e2e-"));
const token = randomBytes(32).toString("base64url"); process.env.ALIVE_BROWSER_SHARED_TEST_TOKEN = token;
const config = { ...DEFAULT_BROWSER_CONFIG, engine: "chrome" as const, headless: true, sharedTokenEnv: "ALIVE_BROWSER_SHARED_TEST_TOKEN", sharedTokenFileEnv: "ALIVE_BROWSER_SHARED_TEST_TOKEN_FILE", viewport: { width: 900, height: 720 }, actionTimeoutMs: 5000 };
const dockerClient = process.env.ALIVE_BROWSER_TEST_DOCKER_CLIENT === "1";
const host = new SharedBrowserHost({ config, directory: root, token, port: 0, maxClients: 3, ...(dockerClient ? { host: "0.0.0.0" } : {}) });
const opened: SharedContext[] = [];
async function until(test: () => boolean, label: string) { const end = Date.now() + 5000; while (!test() && Date.now() < end) await delay(30); assert.ok(test(), label); }
try {
	await host.start(); config.sharedUrl = host.endpoint().replace("0.0.0.0", "127.0.0.1");
	assert.equal((await fetch(`${config.sharedUrl}/v1/status`)).status, 401);
	assert.equal((await fetch(`${config.sharedUrl}/v1/status?token=${token}`)).status, 401, "Tokens in URLs must never authenticate");
	const a = await openSharedContext(config, path.join(root, "a"), new AbortController().signal); opened.push(a);
	const b = await openSharedContext(config, path.join(root, "b"), new AbortController().signal); opened.push(b);
	assert.equal(a.browser.contexts().length, 1); assert.equal(b.browser.contexts().length, 1);
	await a.context.route("https://shared-fixture.test/**", route => route.fulfill({ contentType: "text/html", body: "<title>First</title><input>" }));
	await b.context.route("https://shared-fixture.test/**", route => route.fulfill({ contentType: "text/html", body: "<title>Second</title><input>" }));
	const pa = await a.context.newPage(), pb = await b.context.newPage();
	await pa.goto("https://shared-fixture.test/"); await pb.goto("https://shared-fixture.test/");
	await a.context.addCookies([{ name: "owner", value: "first", domain: "shared-fixture.test", path: "/", expires: Math.floor(Date.now() / 1000) + 3600 }]);
	await pa.evaluate("localStorage.setItem('owner','first')");
	assert.equal((await b.context.cookies()).length, 0); assert.equal(await pb.evaluate("localStorage.getItem('owner')"), null);
	assert.equal(host.status().contexts, 2, "Two clients share one host while retaining two separate contexts");
	await assert.rejects(b.browser.newBrowserCDPSession(), /Browser-wide/);
	const cdp = await b.context.newCDPSession(pb);
	await assert.rejects(cdp.send("Target.getTargets"), /CDP command/);
	await assert.rejects(cdp.send("Browser.close"), /CDP command/);
	await assert.rejects(pb.locator("input").setInputFiles("/etc/passwd"), /server-file/);
	await cdp.detach();
	await a.close();
	assert.equal(await pb.title(), "Second", "Closing one client must not close another client's page or the shared engine");
	const restored = await openSharedContext({ ...config, driver: "playwright" }, path.join(root, "a"), new AbortController().signal); opened.push(restored);
	assert.equal((await restored.context.cookies()).find(cookie => cookie.name === "owner")?.value, "first");
	await restored.context.route("https://shared-fixture.test/**", route => route.fulfill({ contentType: "text/html", body: "<title>Restored</title>" }));
	const restoredPage = await restored.context.newPage(); await restoredPage.goto("https://shared-fixture.test/");
	assert.equal(await restoredPage.evaluate("localStorage.getItem('owner')"), "first");
	assert.equal(fs.statSync(path.join(root, "a", "shared-storage.json")).mode & 0o777, 0o600);
	if (dockerClient) {
		const client = spawn(process.env.ALIVE_TEST_DOCKER || "docker", ["run", "--rm", "-i", "--platform", "linux/amd64", "--add-host=host.docker.internal:host-gateway", "--entrypoint", "python3", "-e", "ALIVE_BROWSER_SHARED_TEST_TOKEN", "-e", "ALIVE_SHARED_FIXTURE_PORT", DEFAULT_BROWSER_CONFIG.fortressImage, "-"], { env: { ...process.env, ALIVE_SHARED_FIXTURE_PORT: new URL(config.sharedUrl).port }, stdio: ["pipe", "pipe", "pipe"] });
		try {
			client.stdin.end(fs.readFileSync(new URL("./browser-shared-docker-client.py", import.meta.url)));
			let output = "", error = ""; client.stdout.on("data", data => { output += data; }); client.stderr.on("data", data => { error += data; });
			await new Promise<void>((resolve, reject) => { client.once("error", reject); client.once("exit", code => code === 0 ? resolve() : reject(new Error(`Docker client failed: ${error}`))); });
			assert.match(output, /remote context\/page worked/); console.log(output.trim());
			await until(() => host.status().contexts === 2 && host.status().clients === 2, "Docker client context was cleaned up");
		} finally { client.kill("SIGTERM"); }
	}
	const script = `import {openSharedContext} from './src/modules/browser/shared-client.ts'; const config=JSON.parse(process.env.ALIVE_SHARED_FIXTURE_CONFIG); const own=await openSharedContext(config,process.env.ALIVE_SHARED_FIXTURE_DIR,new AbortController().signal); await own.context.newPage(); console.log('ready'); setInterval(()=>{},1000);`;
	const child = spawn(process.execPath, ["--import", "tsx", "--input-type=module", "-e", script], { cwd: process.cwd(), env: { ...process.env, ALIVE_SHARED_FIXTURE_CONFIG: JSON.stringify(config), ALIVE_SHARED_FIXTURE_DIR: path.join(root, "crashed") }, stdio: ["ignore", "pipe", "pipe"] });
	try {
		let ready = false; child.stdout.on("data", data => { if (data.toString().includes("ready")) ready = true; });
		await until(() => ready, "A second process connected to the same browser host");
		assert.equal(host.status().contexts, 3);
		await assert.rejects(openSharedContext(config, path.join(root, "over-limit"), new AbortController().signal), /Cannot connect/);
		child.kill("SIGKILL");
		await until(() => host.status().contexts === 2 && host.status().clients === 2, "A killed agent must leave no browser context or connection behind");
		assert.equal(await pb.title(), "Second");
	} finally { child.kill("SIGKILL"); }
	console.log("shared-browser: one host across processes, isolated contexts/cookies/storage, persistence, driver compatibility, crash cleanup, capacity and browser/CDP/filesystem boundary passed");
} finally {
	for (const connection of opened) await connection.close().catch(() => {});
	await host.close(); fs.rmSync(root, { recursive: true, force: true });
}
