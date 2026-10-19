import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { DEFAULT_BROWSER_CONFIG } from "../modules/browser/config.js";

const root = fs.mkdtempSync(path.join(os.tmpdir(), "alive-shared-cli-"));
const entry = path.resolve("src/index.ts"), loader = import.meta.resolve("tsx");
const run = promisify(execFile), file = path.join(root, "alive.config.json");
const fortress = process.env.ALIVE_BROWSER_TEST_FORTRESS === "1";
fs.writeFileSync(file, JSON.stringify({ modules: { browser: { ...DEFAULT_BROWSER_CONFIG, engine: fortress ? "fortress" : "chrome", headless: true } } }));
const invoke = (args: string[]) => run(process.execPath, ["--import", loader, entry, "browser", ...args, "--config", file], { cwd: root, timeout: 30_000, maxBuffer: 1024 * 1024 });
try {
	const start = await invoke(["host", "--background", "--port", "0"]);
	assert.match(start.stdout, /Shared browser host started/);
	const directory = path.join(root, ".alive", "modules", "browser", "shared-host");
	const endpoint = JSON.parse(fs.readFileSync(path.join(directory, "endpoint.json"), "utf8"));
	const token = fs.readFileSync(endpoint.tokenFile, "utf8").trim();
	assert.equal(start.stdout.includes(token), false, "The host command must never print its credential");
	assert.equal(fs.statSync(endpoint.tokenFile).mode & 0o777, 0o600);
	assert.equal(fs.existsSync(path.join(root, ".alive", "runtime.json")), false, "The browser host must not claim the agent runtime directory");
	assert.equal(JSON.parse((await invoke(["host-status"])).stdout).running, true);
	await assert.rejects(invoke(["host", "--background", "--port", "0"]), /already owns/);
	await invoke(["setup", "--shared-url", endpoint.origin]);
	const local = JSON.parse(fs.readFileSync(path.join(root, "alive.config.local.json"), "utf8"));
	assert.equal(local.modules.browser.sharedUrl, endpoint.origin);
	const env = fs.readFileSync(path.join(root, ".env"), "utf8");
	assert.ok(env.includes("ALIVE_BROWSER_SHARED_TOKEN_FILE=")); assert.equal(env.includes(token), false);
	let diagnosticOutput: string;
	try { diagnosticOutput = (await invoke(["diagnose"])).stdout; }
	catch (error) {
		const failed = error as { code?: number; stdout?: string };
		if (!fortress || failed.code !== 1 || !failed.stdout) throw error;
		diagnosticOutput = failed.stdout;
	}
	const diagnose = JSON.parse(diagnosticOutput);
	assert.equal(diagnose.connection, "shared");
	assert.equal(typeof diagnose.canvas.passed, "boolean");
	if (!fortress) assert.equal(diagnose.canvas.passed, true);
	if (fortress) assert.equal(diagnose.version, "151.0.7908.0", "The actual BSD engine must run without activation");
	await invoke(["host-stop"]);
	await assert.rejects(invoke(["host-status"]));
	console.log("shared-browser CLI: independent background lifecycle, duplicate refusal, secret-free setup, remote diagnostics and cleanup passed");
} finally {
	await invoke(["host-stop"]).catch(() => {}); fs.rmSync(root, { recursive: true, force: true });
}
