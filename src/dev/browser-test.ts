import assert from "node:assert/strict";
import { createServer } from "node:http";
import { browserArgs, browserConnection, ensureFortress, runBrowser } from "../fortress-browser.js";
import { createAliveTools, type ToolDeps } from "../runtime/tools.js";

assert.equal(browserConnection({}).endpoint, "http://127.0.0.1:9223");
assert.equal(browserConnection({ ALIVE_FORTRESS_PORT: "9444" }).port, 9444);
assert.equal(browserConnection({ ALIVE_FORTRESS_CDP: "http://localhost:9444/" }).endpoint, "http://localhost:9444");
assert.throws(() => browserConnection({ ALIVE_FORTRESS_PORT: "NaN" }));
assert.throws(() => browserConnection({ ALIVE_FORTRESS_CDP: "file:///tmp/browser" }));
const args = browserArgs("http://localhost:9223", ["snapshot", "-i"]);
assert.ok(args[0].endsWith("node_modules/agent-browser/bin/agent-browser.js"));
assert.deepEqual(args.slice(1), ["--session", "alive-fortress", "--cdp", "http://localhost:9223", "snapshot", "-i"]);
for (const argv of [[], ["connect", "9222"], ["--cdp=9222", "open", "https://example.com"], ["--session", "default", "snapshot"], ["close", "--all"]]) {
	assert.throws(() => browserArgs("http://localhost:9223", argv));
}
const saved = process.env.ALIVE_FORTRESS_CDP;
const savedPort = process.env.ALIVE_FORTRESS_PORT;
let healthy = true;
const server = createServer((_req, res) => {
	res.setHeader("Content-Type", "application/json");
	res.end(JSON.stringify(healthy ? { Browser: "Chrome/151.0.7908.0", webSocketDebuggerUrl: "ws://localhost/devtools/browser/test" } : {}));
});
await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
const address = server.address();
assert.ok(address && typeof address !== "string");
process.env.ALIVE_FORTRESS_CDP = `http://127.0.0.1:${address.port}`;
try {
	// Fortress intentionally advertises Chrome: no brand-string rejection.
	assert.equal(await ensureFortress(), process.env.ALIVE_FORTRESS_CDP);
	delete process.env.ALIVE_FORTRESS_CDP;
	process.env.ALIVE_FORTRESS_PORT = String(address.port);
	await assert.rejects(ensureFortress(), /unmanaged browser/);
	process.env.ALIVE_FORTRESS_CDP = `http://127.0.0.1:${address.port}`;
	healthy = false;
	await assert.rejects(ensureFortress(), /CDP unavailable/);
} finally {
	if (saved === undefined) delete process.env.ALIVE_FORTRESS_CDP;
	else process.env.ALIVE_FORTRESS_CDP = saved;
	if (savedPort === undefined) delete process.env.ALIVE_FORTRESS_PORT;
	else process.env.ALIVE_FORTRESS_PORT = savedPort;
	await new Promise<void>((resolve) => server.close(() => resolve()));
}

// Local identity regression: checks both JS and HTTP UA, without external sites.
// Opt-in because this starts the real engine (and may download its binary).
if (process.env.ALIVE_BROWSER_IDENTITY_TEST === "1" || process.env.ALIVE_BROWSER_LIVE_TEST === "1" || process.env.ALIVE_BROWSER_CANVAS_TEST === "1") {
	let requestUA = "";
	const probe = createServer((req, res) => {
		requestUA = req.headers["user-agent"] ?? "";
		res.setHeader("Content-Type", "text/html");
		res.end("<!doctype html><title>Browser identity probe</title>");
	});
	await new Promise<void>((resolve) => probe.listen(0, "127.0.0.1", resolve));
	const probeAddress = probe.address();
	assert.ok(probeAddress && typeof probeAddress !== "string");
	try {
		await runBrowser(["tab", "new", `http://127.0.0.1:${probeAddress.port}`]);
		assert.match(await runBrowser(["eval", "navigator.userAgent"]), /Windows NT 10\.0; Win64; x64/);
		assert.equal(await runBrowser(["eval", "navigator.platform"]), '"Win32"');
		assert.equal(await runBrowser(["eval", "navigator.userAgentData.platform"]), '"Windows"');
		assert.match(requestUA, /Windows NT 10\.0; Win64; x64/);
		// Canvas must preserve fully transparent pixels, including decoded PNGs.
		// Returning RGB noise with alpha=0 is not valid unpremultiplied readback.
		// Separate opt-in: expected to fail until the upstream engine is fixed.
		if (process.env.ALIVE_BROWSER_CANVAS_TEST === "1") {
			const pixels = JSON.parse(await runBrowser(["eval", `(async () => {
				const canvas = document.createElement("canvas");
				canvas.width = canvas.height = 1;
				const ctx = canvas.getContext("2d");
				const read = () => Array.from(ctx.getImageData(0, 0, 1, 1).data);
				const blank = read();
				const image = new Image();
				image.src = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAACklEQVR4nGMAAQAABQABDQottAAAAABJRU5ErkJggg==";
				await image.decode();
				ctx.drawImage(image, 0, 0);
				const png = read();
				ctx.fillRect(0, 0, 1, 1);
				ctx.clearRect(0, 0, 1, 1);
				return { blank, png, cleared: read() };
			})()`]));
			for (const [kind, pixel] of Object.entries(pixels)) {
				assert.deepEqual(pixel, [0, 0, 0, 0], `Upstream canvas readback corruption: ${kind}`);
			}
		}
	} finally {
		try { await runBrowser(["tab", "close"]); }
		finally { await new Promise<void>((resolve) => probe.close(() => resolve())); }
	}
}

// Optional real-engine check; ordinary tests do not download/start browsers.
if (process.env.ALIVE_BROWSER_LIVE_TEST === "1") {
	await runBrowser(["open", "https://example.com"]);
	assert.match(await runBrowser(["snapshot", "-i"]), /Learn more/);
	assert.equal(await runBrowser(["eval", "navigator.webdriver"]), "false");
	assert.doesNotMatch(await runBrowser(["eval", "navigator.userAgent"]), /HeadlessChrome/);
	const tools = createAliveTools({ log: { child: () => ({}) }, moduleTools: [] } as unknown as ToolDeps);
	const search = tools.find((tool) => tool.name === "web_search")!;
	const result = await search.execute("test", { query: "fortress browser", count: 2 }, undefined, undefined, {} as never);
	assert.match(JSON.stringify(result.content), /tilion/);
	assert.equal(await runBrowser(["get", "url"]), "https://example.com/");
	await runBrowser(["close"]);
}
console.log("browser tests passed");
