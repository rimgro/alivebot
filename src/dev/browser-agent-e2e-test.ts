import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { randomBytes } from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { setTimeout as delay } from "node:timers/promises";
import { WebSocket } from "ws";
import { DEFAULT_BROWSER_CONFIG } from "../modules/browser/config.js";
import { SharedBrowserHost } from "../modules/browser/shared-server.js";
import { openSharedContext } from "../modules/browser/shared-client.js";
import { ConversationAgentBrowser } from "../modules/browser/agent-browser.js";
import { AgentCdpBridge } from "../modules/browser/agent-cdp.js";

const root = fs.mkdtempSync(path.join(os.tmpdir(), "alive-agent-browser-e2e-"));
const token = randomBytes(32).toString("base64url"); process.env.ALIVE_AGENT_E2E_TOKEN = token;
const config = { ...DEFAULT_BROWSER_CONFIG, engine: process.env.ALIVE_BROWSER_TEST_FORTRESS === "1" ? "fortress" as const : "chrome" as const, channel: "chromium" as const, headless: true, sharedTokenEnv: "ALIVE_AGENT_E2E_TOKEN", actionTimeoutMs: 15000, viewport: { width: 900, height: 720 } };
const dockerClient = process.env.ALIVE_BROWSER_TEST_DOCKER_CLIENT === "1";
const host = new SharedBrowserHost({ config, directory: root, token, port: 0, ...(dockerClient ? { host: "0.0.0.0" } : {}) });
const opened: Awaited<ReturnType<typeof openSharedContext>>[] = [];
const agents: ConversationAgentBrowser[] = [];
let facade: AgentCdpBridge | undefined;
try {
	await host.start(); config.sharedUrl = host.endpoint().replace("0.0.0.0", "127.0.0.1");
	if (config.engine === "fortress") assert.ok(host.status().fortressCanvas, "OSS diagnostics must be reported without blocking the host");
	for (let i = 0; i < 2; i++) {
		const connection = await openSharedContext(config, path.join(root, String(i)), new AbortController().signal); opened.push(connection);
		await connection.context.route("https://agent-fixture.test/**", route => route.fulfill({ contentType: "text/html", body: `<title>Owner ${i}</title><label>Name<input id=name></label><button onclick="document.querySelector('#out').textContent=document.querySelector('input').value">Apply</button><p id=out></p>` }));
		await connection.context.newPage();
		agents.push(new ConversationAgentBrowser(connection.context, () => {}, config.actionTimeoutMs));
	}
	await Promise.all(agents.map(agent => agent.run(["open", "https://agent-fixture.test/"])));
	const snapshot = await agents[0].run(["snapshot", "-i"]);
	assert.match(String(snapshot.snapshot), /textbox|Name/i);
	const ref = String(snapshot.snapshot).match(/(?:textbox|input)[^\n]*\[ref=(e\d+)\]/i)?.[1];
	assert.ok(ref, "Real agent-browser snapshots must provide native @eN refs");
	await agents[0].run(["fill", `@${ref}`, "Alice"]);
	await agents[0].run(["press", "Tab"]);
	await agents[0].run(["scroll", "down", "100"]);
	await agents[0].run(["click", "button"]);
	assert.equal((await agents[0].run(["get", "text", "#out"])).text, "Alice");
	assert.equal(await opened[1].context.pages()[0].inputValue("input"), "", "Another agent must retain its own page and input");
	assert.ok((await agents[0].screenshot()).length > 100);
	await agents[0].run(["wait", "#out"], undefined, 1000);
	await assert.rejects(agents[0].run(["wait", "#missing"], undefined, 100), /timeout|timed out/i);
	await agents[0].close();
	assert.equal((await agents[1].run(["get", "title"])).title, "Owner 1", "Closing one daemon must not stop another agent or the host");
	assert.equal(host.status().contexts, 2);
	await assert.rejects(agents[1].run(["wait", "#never-appears"], AbortSignal.timeout(100)), error => error instanceof Error && error.name === "TimeoutError");
	assert.equal(agents[1].isClosed, true, "Cancellation must revoke the daemon's page connection, not only kill the CLI");
	agents[1] = new ConversationAgentBrowser(opened[1].context, () => {}, config.actionTimeoutMs);
	assert.equal((await agents[1].run(["get", "title"])).title, "Owner 1", "A replacement daemon can reuse the preserved private context");

	if (dockerClient) {
		const result = await promisify(execFile)("docker", ["run", "--rm", "--add-host=host.docker.internal:host-gateway",
			"--mount", `type=bind,source=${process.cwd()},target=/work,readonly`, "--workdir", "/work",
			"-e", "ALIVE_AGENT_E2E_TOKEN", "-e", `ALIVE_AGENT_E2E_ENGINE=${config.engine}`,
			"-e", `ALIVE_AGENT_E2E_URL=http://host.docker.internal:${new URL(config.sharedUrl).port}`,
			"node:22-bookworm-slim", "node", "--import", "tsx", "src/dev/browser-agent-docker-client.ts"],
			{ timeout: 90000, maxBuffer: 1024 * 1024, env: process.env });
		assert.match(result.stdout, /no local browser process/); console.log(result.stdout.trim());
		const deadline = Date.now() + 5000;
		while (host.status().contexts !== 2 && Date.now() < deadline) await delay(50);
		assert.equal(host.status().contexts, 2, "The Docker client's context must be removed without affecting the other two");
	}

	// Exercise the facade independently of the CLI: synthetic IDs cannot be
	// exchanged between clients and even authenticated SDK clients cannot use
	// engine-wide CDP/filesystem operations.
	facade = new AgentCdpBridge(opened[0].context, () => {});
	const endpoint = await facade.start(), socket = new WebSocket(endpoint);
	await new Promise<void>((resolve, reject) => { socket.once("open", resolve); socket.once("error", reject); });
	let id = 0;
	const rpc = (method: string, params = {}, sessionId?: string) => new Promise<any>(resolve => { socket.once("message", raw => resolve(JSON.parse(raw.toString()))); socket.send(JSON.stringify({ id: ++id, method, params, ...(sessionId ? { sessionId } : {}) })); });
	const targets = await rpc("Target.getTargets"); assert.equal(targets.result.targetInfos.length, 1);
	assert.ok((await rpc("Target.attachToTarget", { targetId: "another-conversation", flatten: true })).error);
	assert.ok((await rpc("Browser.close")).error);
	const attached = await rpc("Target.attachToTarget", { targetId: targets.result.targetInfos[0].targetId, flatten: true });
	for (const method of ["Network.getAllCookies", "Network.clearBrowserCookies", "Storage.getCookies", "DOM.setFileInputFiles", "Target.createBrowserContext"]) assert.ok((await rpc(method, {}, attached.result.sessionId)).error, method);
	assert.ok((await rpc("Page.navigate", { url: "file:///etc/passwd" }, attached.result.sessionId)).error);
	socket.terminate();
	console.log(`agent-browser on ${config.engine}: real native CLI, @refs, navigation/read/fill/click/wait/screenshot, isolated contexts/daemons, host survival and scoped CDP boundaries passed`);
} finally {
	await facade?.close(); for (const agent of agents) await agent.close();
	for (const connection of opened) await connection.close().catch(() => {});
	await host.close(); delete process.env.ALIVE_AGENT_E2E_TOKEN; fs.rmSync(root, { recursive: true, force: true });
}
