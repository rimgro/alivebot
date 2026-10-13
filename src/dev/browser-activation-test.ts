import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { loadConfig } from "../config.js";
import { activateFortress } from "../modules/browser/activation.js";
import { resolveFortressLicense } from "../modules/browser/connection.js";

const root = fs.mkdtempSync(path.join(os.tmpdir(), "alive-fortress-activation-test-"));
const originalFetch = globalThis.fetch, originalWrite = process.stdout.write;
let output = "";
const token = (expiry: number) => [Buffer.from('{"alg":"EdDSA"}').toString("base64url"), Buffer.from(JSON.stringify({ exp: expiry })).toString("base64url"), "fixture-signature-not-valid"].join(".");
const current = token(Math.floor(Date.now() / 1000) + 3600);
const required = { fortressLicenseFileEnv: "FIXTURE_LICENSE_FILE", fortressRequireLicense: true };
try {
	fs.writeFileSync(path.join(root, "alive.config.json"), "{}");
	const loaded = loadConfig({ cwd: root });
	const directory = path.join(loaded.paths.modulesDir, "browser", "fortress-license");
	const file = path.join(directory, "license.jwt"), envFile = path.join(root, ".env");
	fs.mkdirSync(directory, { recursive: true });
	fs.writeFileSync(file, current, { mode: 0o600 });
	assert.equal(resolveFortressLicense(required, { FIXTURE_LICENSE_FILE: file }), file);
	assert.throws(() => resolveFortressLicense(required, {}), /Activate Fortress first/);
	assert.equal(resolveFortressLicense({ ...required, fortressRequireLicense: false }, {}), undefined);
	for (const content of ["malformed-secret-token", token(1), "e30.bnVsbA.c2ln"]) {
		fs.writeFileSync(file, content);
		assert.throws(() => resolveFortressLicense(required, { FIXTURE_LICENSE_FILE: file }), error => error instanceof Error && !error.message.includes(content));
	}
	fs.writeFileSync(file, current);
	if (process.platform !== "win32") {
		fs.chmodSync(file, 0o644);
		assert.throws(() => resolveFortressLicense(required, { FIXTURE_LICENSE_FILE: file }), /private/);
		fs.chmodSync(file, 0o600);
	}
	assert.throws(() => resolveFortressLicense(required, { FIXTURE_LICENSE_FILE: "secret-relative-path" }), error => error instanceof Error && !error.message.includes("secret-relative-path"));

	process.stdout.write = ((chunk: string | Uint8Array) => { output += chunk.toString(); return true; }) as typeof process.stdout.write;
	const deviceCredential = "fixture-device-credential-must-not-be-persisted";
	let startUrl = "https://fortress.tilion.com/activate?code=TEST-1234", reply: unknown = { license: current }, pollStatus = 200;
	globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
		assert.equal(init?.redirect, "error");
		assert.equal(init?.method, "POST");
		const url = String(input);
		assert.ok(url.startsWith("https://fortress.tilion.dev/v1/activate/"));
		assert.equal(url.includes(deviceCredential), false);
		if (url.endsWith("/start")) return new Response(JSON.stringify({ verification_uri: startUrl, user_code: "TEST-1234", device_code: deviceCredential, interval: 1, expires_in: 60 }));
		assert.deepEqual(JSON.parse(String(init?.body)), { device_code: deviceCredential });
		const pending = fs.readFileSync(path.join(directory, "pending.json"), "utf8");
		assert.equal(pending.includes(deviceCredential), false);
		assert.equal(pending.includes(current), false);
		return new Response(JSON.stringify(reply), { status: pollStatus });
	}) as typeof fetch;
	fs.writeFileSync(envFile, "EXISTING_SECRET=fixture-preserved\nexport ALIVE_FORTRESS_LICENSE_FILE = \"/previous/file\"\n");
	await activateFortress(loaded, new AbortController().signal);
	assert.equal(fs.readFileSync(file, "utf8").trim(), current);
	assert.match(fs.readFileSync(envFile, "utf8"), /EXISTING_SECRET=fixture-preserved/);
	assert.match(fs.readFileSync(envFile, "utf8"), /^ALIVE_FORTRESS_LICENSE_FILE=/m);
	assert.equal(fs.readFileSync(envFile, "utf8").includes(current), false);
	assert.equal(fs.statSync(envFile).mode & 0o777, 0o600);
	assert.equal(fs.statSync(file).mode & 0o777, 0o600);
	assert.equal(fs.existsSync(path.join(directory, "pending.json")), false);
	const previousEnv = fs.readFileSync(envFile, "utf8");
	for (const invalid of ["response-secret-invalid", token(1)]) {
		reply = { license: invalid };
		await assert.rejects(activateFortress(loaded, new AbortController().signal), /Invalid or expired/);
		assert.equal(fs.readFileSync(file, "utf8").trim(), current, "Invalid responses must not replace existing credentials");
		assert.equal(fs.readFileSync(envFile, "utf8"), previousEnv);
		assert.equal(fs.existsSync(path.join(directory, "pending.json")), false);
	}
	startUrl = "https://untrusted.test/activate";
	await assert.rejects(activateFortress(loaded, new AbortController().signal), /Unexpected Fortress verification origin/);
	startUrl = "https://fortress.tilion.com/activate?code=TEST-1234";
	pollStatus = 410;
	await assert.rejects(activateFortress(loaded, new AbortController().signal), /expired/);
	const abort = new AbortController();
	setTimeout(() => abort.abort(), 20);
	await assert.rejects(activateFortress(loaded, abort.signal), /abort/i);
	assert.equal(fs.existsSync(path.join(directory, "pending.json")), false);
	assert.equal(output.includes(deviceCredential), false);
	assert.equal(output.includes(current), false);
	assert.equal(output.includes("response-secret-invalid"), false);
	assert.deepEqual(fs.readdirSync(directory), ["license.jwt"], "No pending or temporary credential files remain");
} finally {
	globalThis.fetch = originalFetch; process.stdout.write = originalWrite;
	fs.rmSync(root, { recursive: true, force: true });
}
console.log("Fortress activation passed: required/current/private token, approved origin, secret-free pending/output, atomic credential saves, existing environment preservation, invalid response/expiry/cancellation cleanup");
