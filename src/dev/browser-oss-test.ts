import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { loadConfig } from "../config.js";
import { ModuleHost } from "../events/host.js";
import { Logger } from "../log.js";
import { DEFAULT_BROWSER_CONFIG } from "../modules/browser/config.js";
import { setupBrowser } from "../modules/browser/cli.js";
import { BrowserModule } from "../modules/browser/module.js";
import { EventStore } from "../store/events.js";
import { HistoryStore } from "../store/history.js";

const root = fs.mkdtempSync(path.join(os.tmpdir(), "alive-browser-oss-"));
const oldEnvironment = process.env.ALIVE_FORTRESS_LICENSE_FILE;
process.env.ALIVE_FORTRESS_LICENSE_FILE = "/nonexistent/obsolete-license-must-not-be-read";
let host: ModuleHost | undefined;
try {
	fs.writeFileSync(path.join(root, "alive.config.local.json"), JSON.stringify({ modules: { browser: {
		engine: "fortress", fortressRequireLicense: true, fortressLicenseFileEnv: "ALIVE_FORTRESS_LICENSE_FILE",
		fortressImage: "tilion/fortress@sha256:6c275b96f96199f48ab7ca05366898cdf796ac1da8cb5cceb936a4ce98e41b4e",
	} } }));
	setupBrowser(loadConfig({ cwd: root }), { engine: "fortress" });
	const loaded = loadConfig({ cwd: root });
	const browser = loaded.config.modules.browser!;
	assert.equal(browser.fortressImage, DEFAULT_BROWSER_CONFIG.fortressImage, "Selecting Fortress must select the pinned BSD image, not retain the activation build");
	assert.equal("fortressRequireLicense" in browser, false);
	assert.equal("fortressLicenseFileEnv" in browser, false);
	assert.equal(fs.existsSync(path.join(root, ".env")), false, "OSS setup must not create activation credentials");
	const module = new BrowserModule({ ...browser, port: 0 });
	const events = EventStore.open(loaded.paths.stateDir);
	host = new ModuleHost({ config: loaded, log: new Logger({ console: false }), modules: [module], transports: [], ingest: input => events.append(input), outbox: () => [], history: HistoryStore.open(loaded.paths.stateDir), runtimeStatus: () => ({}) });
	await host.init();
	assert.equal(module.status().listening, true, "OSS runtime must initialize without reading even an invalid obsolete token path");
	assert.equal(module.status().fortressActivationVerified, undefined);
	console.log("OSS Fortress: pinned BSD image, legacy activation settings removed, no account/token requirement or credential writes");
} finally {
	await host?.stop();
	if (oldEnvironment === undefined) delete process.env.ALIVE_FORTRESS_LICENSE_FILE; else process.env.ALIVE_FORTRESS_LICENSE_FILE = oldEnvironment;
	fs.rmSync(root, { recursive: true, force: true });
}
