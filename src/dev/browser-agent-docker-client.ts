import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { DEFAULT_BROWSER_CONFIG } from "../modules/browser/config.js";
import { openSharedContext } from "../modules/browser/shared-client.js";
import { ConversationAgentBrowser } from "../modules/browser/agent-browser.js";

const root = fs.mkdtempSync(path.join(os.tmpdir(), "alive-docker-agent-"));
const config = { ...DEFAULT_BROWSER_CONFIG, engine: process.env.ALIVE_AGENT_E2E_ENGINE === "fortress" ? "fortress" as const : "chrome" as const, sharedUrl: process.env.ALIVE_AGENT_E2E_URL!, sharedTokenEnv: "ALIVE_AGENT_E2E_TOKEN", actionTimeoutMs: 15000, viewport: { width: 900, height: 720 } };
const own = await openSharedContext(config, root, new AbortController().signal);
const agent = new ConversationAgentBrowser(own.context, () => {}, config.actionTimeoutMs);
try {
	await own.context.route("https://container-fixture.test/**", route => route.fulfill({ contentType: "text/html", body: '<title>Remote Fortress</title><label>Name<input></label><button onclick="document.querySelector(\'output\').textContent=document.querySelector(\'input\').value">Save</button><output></output>' }));
	await own.context.newPage();
	await agent.run(["open", "https://container-fixture.test/"]);
	const snapshot = String((await agent.run(["snapshot", "-i"])).snapshot);
	const ref = snapshot.match(/textbox[^\n]*\[ref=(e\d+)\]/)?.[1]; assert.ok(ref);
	await agent.run(["fill", `@${ref}`, "Remote native client"]); await agent.run(["click", "button"]);
	assert.equal((await agent.run(["get", "text", "output"])).text, "Remote native client");
	assert.ok((await agent.screenshot()).length > 100);
	for (const pid of fs.readdirSync("/proc").filter(name => /^\d+$/.test(name))) {
		let command = ""; try { command = fs.readFileSync(`/proc/${pid}/cmdline`, "utf8").split("\0")[0]; } catch { continue; }
		assert.ok(!/\/(chrome|chromium|chrome-headless-shell)$/.test(command), "No browser process may run in the agent container");
	}
	console.log("Docker agent: real native agent-browser @refs/input/screenshot over authenticated shared-host SDK; no local browser process");
} finally { await agent.close(); await own.close(); fs.rmSync(root, { recursive: true, force: true }); }
