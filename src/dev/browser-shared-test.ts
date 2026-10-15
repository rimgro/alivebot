import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import * as http from "node:http";
import { randomBytes } from "node:crypto";
import { DEFAULT_BROWSER_CONFIG } from "../modules/browser/config.js";
import { sharedMetadata, sharedOrigin, sharedToken } from "../modules/browser/shared-client.js";
import { SharedProtocol } from "../modules/browser/shared-protocol.js";

const root = fs.mkdtempSync(path.join(os.tmpdir(), "alive-shared-policy-"));
const file = path.join(root, "token"), token = randomBytes(32).toString("base64url");
const config = { ...DEFAULT_BROWSER_CONFIG, sharedTokenFileEnv: "ALIVE_SHARED_POLICY_FILE", sharedTokenEnv: "ALIVE_SHARED_POLICY_TOKEN", actionTimeoutMs: 1000 };
process.env.ALIVE_SHARED_POLICY_FILE = file;
fs.writeFileSync(file, token + "\n", { mode: 0o600 });
let requests = 0;
const server = http.createServer((request, response) => {
	requests++; assert.equal(request.headers.authorization, `Bearer ${token}`);
	response.writeHead(302, { location: "http://127.0.0.1:1/credential-must-not-be-forwarded" }); response.end();
});
try {
	assert.equal(sharedOrigin("http://127.0.0.1:4330"), "http://127.0.0.1:4330");
	for (const value of ["http://operator:secret@host", "http://host/connect", "http://host?token=secret", "http://host/#secret", "file:///tmp/host"]) assert.throws(() => sharedOrigin(value));
	assert.equal(sharedToken(config), token);
	fs.chmodSync(file, 0o644); assert.throws(() => sharedToken(config), /private/); fs.chmodSync(file, 0o600);
	const guard = new SharedProtocol();
	guard.server({ method: "__create__", params: { guid: "browser-owned", type: "Browser" } });
	guard.server({ method: "__create__", params: { guid: "context-owned", type: "BrowserContext" } });
	guard.server({ method: "__create__", params: { guid: "cdp-owned", type: "CDPSession" } });
	guard.server({ method: "__create__", params: { guid: "frame-owned", type: "Frame" } });
	assert.throws(() => guard.client({ id: 20, guid: "frame-owned", method: "goto", params: { url: "file:///etc/passwd" } }), /HTTP/);
	assert.throws(() => guard.client({ id: 1, guid: "page-owned-by-another-client", method: "screenshot" }), /unavailable/);
	assert.throws(() => guard.client({ id: 2, guid: "browser-owned", method: "newBrowserCDPSession" }), /Browser-wide/);
	assert.throws(() => guard.client({ id: 3, guid: "browser-owned", method: "newContext", params: { acceptDownloads: "accept" } }), /downloads/);
	guard.client({ id: 4, guid: "browser-owned", method: "newContext", params: { acceptDownloads: "deny" } });
	assert.throws(() => guard.client({ id: 5, guid: "browser-owned", method: "newContext", params: { acceptDownloads: "deny" } }), /one isolated/);
	for (const method of ["Target.getTargets", "Target.attachToTarget", "Browser.close", "Storage.getCookies", "Runtime.evaluate"]) assert.throws(() => guard.client({ id: 6, guid: "cdp-owned", method: "send", params: { method } }), /CDP command/);
	guard.client({ id: 7, guid: "cdp-owned", method: "send", params: { method: "Page.startScreencast", params: { format: "jpeg" } } });
	assert.throws(() => guard.client({ id: 8, guid: "cdp-owned", method: "send", params: { method: "Browser.getWindowForTarget", params: { targetId: "foreign" } } }), /current page/);
	assert.throws(() => guard.client({ id: 9, guid: "cdp-owned", method: "send", params: { method: "Browser.setContentsSize", params: { windowId: 33, width: 500, height: 800 } } }), /does not belong/);
	guard.client({ id: 10, guid: "cdp-owned", method: "send", params: { method: "Browser.getWindowForTarget" } });
	guard.server({ id: 10, result: { value: { windowId: 33 } } });
	guard.client({ id: 11, guid: "cdp-owned", method: "send", params: { method: "Browser.setContentsSize", params: { windowId: 33, width: 500, height: 800 } } });
	assert.throws(() => guard.client({ id: 12, guid: "context-owned", method: "createTempFiles" }), /server-file/);
	await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
	config.sharedUrl = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
	await assert.rejects(sharedMetadata(config), error => error instanceof Error && !error.message.includes(token));
	assert.equal(requests, 1, "The credential must never follow a redirect to another origin");
	console.log("shared-browser policy: private credentials, strict origins, redirect refusal, object/context/window scoping and global-CDP/filesystem denial passed");
} finally {
	server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve()));
	delete process.env.ALIVE_SHARED_POLICY_FILE; fs.rmSync(root, { recursive: true, force: true });
}
