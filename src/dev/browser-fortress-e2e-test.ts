import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { chromium } from "patchright";
import type { Page } from "playwright";
import { DEFAULT_BROWSER_CONFIG } from "../modules/browser/config.js";
import { checkCanvas } from "../modules/browser/diagnostics.js";
import { launchManagedFortress, validateFortressImage, type ManagedFortress } from "../modules/browser/fortress.js";

const root = fs.mkdtempSync(path.join(os.tmpdir(), "alive-fortress-lifecycle-"));
const profile = path.join(root, "profile"), record = path.join(root, "fortress-container.json");
const input = { image: DEFAULT_BROWSER_CONFIG.fortressImage, profile, stateDir: root, timeoutMs: 60_000, signal: new AbortController().signal };
const owned: ManagedFortress[] = [];
try {
	assert.throws(() => validateFortressImage("tilion/fortress:latest"), /digest/);
	assert.throws(() => validateFortressImage(`other/image@sha256:${"0".repeat(64)}`), /official/);
	const first = await launchManagedFortress(input); owned.push(first);
	let browser = await chromium.connectOverCDP(first.endpoint, { noDefaults: true });
	let context = browser.contexts()[0];
	const probe = context.pages()[0] as unknown as Page;
	const canvas = await checkCanvas(probe);
	assert.equal(typeof canvas.passed, "boolean");
	if (!canvas.passed) console.log("OSS Fortress: known native transparent-Canvas defect is reported, not masked or treated as an activation failure");
	await context.route("https://alive-fixture.test/**", route => route.fulfill({ contentType: "text/html", body: '<title>Fortress fixture</title><p>Public fixture</p><script>localStorage.setItem("fortress-fixture","persistent")</script>' }));
	await context.pages()[0].goto("https://alive-fixture.test/");
	await context.addCookies([{ name: "fortress_fixture", value: "persistent", domain: "alive-fixture.test", path: "/", expires: Math.floor(Date.now() / 1000) + 3600 }]);
	assert.equal((await context.cookies("https://alive-fixture.test/")).find(cookie => cookie.name === "fortress_fixture")?.value, "persistent", "The fixture cookie must exist before shutdown");
	assert.ok(fs.existsSync(path.join(profile, "Local State")), "The running browser must use the mounted dedicated profile");
	assert.equal(await context.pages()[0].evaluate("navigator.webdriver"), false);
	const owner = JSON.parse(fs.readFileSync(record, "utf8"));
	assert.equal(fs.statSync(record).mode & 0o777, 0o600);
	if (process.platform === "linux") {
		assert.equal(execFileSync("docker", ["inspect", owner.id, "--format", "{{.Config.User}}"], { encoding: "utf8" }).trim(), `${process.getuid!()}:${process.getgid!()}`, "The container must retain the service account's bind-mount ownership");
		assert.equal(fs.statSync(profile).mode & 0o777, 0o700, "The profile must remain private, not world-writable");
		assert.equal(fs.statSync(path.join(root, "fortress-home")).mode & 0o777, 0o700);
	}
	fs.writeFileSync(record, JSON.stringify({ ...owner, token: "0".repeat(32) }));
	await assert.rejects(launchManagedFortress(input), /ownership cannot be verified/);
	assert.equal(await context.pages()[0].title(), "Fortress fixture", "Foreign ownership records must not stop the real browser");
	fs.writeFileSync(record, JSON.stringify(owner));
	await browser.close();
	const adopted = await launchManagedFortress(input); owned.push(adopted);
	assert.equal(adopted.endpoint, first.endpoint, "An owned live container is adopted without duplication");
	await adopted.close();
	assert.equal(fs.existsSync(record), false);
	await first.close();

	const restarted = await launchManagedFortress(input); owned.push(restarted);
	browser = await chromium.connectOverCDP(restarted.endpoint, { noDefaults: true });
	context = browser.contexts()[0];
	assert.equal((await context.cookies("https://alive-fixture.test/")).find(cookie => cookie.name === "fortress_fixture")?.value, "persistent", "Dedicated cookies must survive container cleanup");
	await context.route("https://alive-fixture.test/**", route => route.fulfill({ contentType: "text/html", body: "<p>Restarted fixture</p>" }));
	await context.pages()[0].goto("https://alive-fixture.test/");
	assert.equal(await context.pages()[0].evaluate("localStorage.getItem('fortress-fixture')"), "persistent");
	await browser.close(); await restarted.close();

	const cancel = new AbortController(), cancelledRoot = path.join(root, "cancelled");
	const pending = launchManagedFortress({ ...input, stateDir: cancelledRoot, profile: path.join(cancelledRoot, "profile"), signal: cancel.signal });
	setTimeout(() => cancel.abort(), 250);
	await assert.rejects(pending);
	assert.equal(fs.existsSync(path.join(cancelledRoot, "fortress-container.json")), false, "Cancellation must clean up the owned partial launch");
	await assert.rejects(launchManagedFortress({ ...input, image: `tilion/fortress@sha256:${"0".repeat(64)}` }), /Docker image failed/);
	assert.equal(fs.existsSync(record), false, "A missing image cannot silently start Chrome");
	console.log("Managed OSS Fortress lifecycle passed without activation: immutable image, private loopback, ownership/adoption, foreign-record refusal, persistent cookies/storage, cleanup, cancellation and no Chrome fallback");
} finally {
	for (const browser of owned) await browser.close();
	if (process.env.ALIVE_BROWSER_TEST_KEEP_PROFILE === "1") console.log(`Synthetic Fortress fixture retained at ${root}`);
	else fs.rmSync(root, { recursive: true, force: true });
}
