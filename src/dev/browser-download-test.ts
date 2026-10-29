import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import * as fs from "node:fs";
import * as http from "node:http";
import * as os from "node:os";
import * as path from "node:path";
import { randomBytes } from "node:crypto";
import type { BrowserContext, BrowserType } from "playwright";
import { loadConfig } from "../config.js";
import type { ModuleContext } from "../events/api.js";
import { ModuleHost } from "../events/host.js";
import { Logger } from "../log.js";
import { BrowserModule } from "../modules/browser/module.js";
import { DEFAULT_BROWSER_CONFIG, validateDownloadLimits } from "../modules/browser/config.js";
import {
	DownloadTooLargeError, contentDispositionFilename, createFileDownloadStore, downloadMime, downloadName,
	sanitizeDownloadName, saveDownload, uniqueDownloadName,
} from "../modules/browser/download.js";
import { sharedDownload } from "../modules/browser/shared-client.js";
import { SharedBrowserHost } from "../modules/browser/shared-server.js";
import { EventStore } from "../store/events.js";
import { HistoryStore } from "../store/history.js";

const root = fs.mkdtempSync(path.join(os.tmpdir(), "alive-browser-download-test-"));
const log = new Logger({ console: false, level: "error" });
const modules: BrowserModule[] = [];
const hosts: ModuleHost[] = [];

class FakePage extends EventEmitter {
	address = "https://fixture.test/";
	text = "Download fixture page";
	closed = false;
	url() { return this.address; }
	isClosed() { return this.closed; }
	async close() { if (!this.closed) { this.closed = true; this.emit("close"); } }
	async bringToFront() {}
	mainFrame() { return this; }
	frames() { return [this]; }
	parentFrame() { return null; }
	viewportSize() { return { width: 900, height: 720 }; }
	async title() { return "Download fixture"; }
	async goto(url: string) { this.address = url; }
	async evaluate<T>(fn: (...args: unknown[]) => T, arg?: unknown): Promise<T> { return fn(arg); }
	locator(selector: string) {
		const text = () => this.text;
		const target = {
			innerText: async () => text(),
			evaluate: async (fn: (element: unknown, arg: unknown) => unknown, arg: unknown) => fn({ innerText: text(), textContent: text() }, arg),
			ariaSnapshot: async () => '- text: "Download fixture page"',
			count: async () => selector === "body" ? 1 : 0,
			nth: () => ({ isVisible: async () => false, isEditable: async () => false, inputValue: async () => "" }),
			first: () => target,
		};
		return target;
	}
	async screenshot() { return Buffer.from([0xff, 0xd8, 0xff, 0xd9]); }
	mouse = { move: async () => {}, down: async () => {}, up: async () => {}, wheel: async () => {} };
	keyboard = { insertText: async () => {}, press: async () => {} };
}

interface Route { status: number; headers: Record<string, string>; body: Buffer; delayMs?: number }

function routes(): Record<string, Route> {
	return {
		"https://fixture.test/": { status: 200, headers: { "content-type": "text/html" }, body: Buffer.from("<html>fixture</html>") },
		"https://fixture.test/files/small.bin": { status: 200, headers: { "content-disposition": "attachment; filename=\"report.bin\"", "content-type": "application/octet-stream" }, body: Buffer.from([0, 1, 2, 255]) },
		"https://fixture.test/files/rfc5987.txt": { status: 200, headers: { "content-disposition": "attachment; filename*=UTF-8''%D0%BE%D1%82%D1%87%D1%91%D1%82.txt", "content-type": "text/plain; charset=utf-8" }, body: Buffer.from("rfc5987", "utf8") },
		"https://fixture.test/files/from-url.bin": { status: 200, headers: { "content-type": "application/octet-stream" }, body: Buffer.from([7]) },
		"https://fixture.test/files/redirect": { status: 302, headers: { location: "/files/small.bin" }, body: Buffer.alloc(0) },
		"https://fixture.test/files/error": { status: 500, headers: { "content-type": "text/plain" }, body: Buffer.from("denied") },
	};
}

async function fixture(options: { maxDownloadBytes?: number; downloadTimeoutMs?: number; routes?: Record<string, Route>; memoryFiles?: boolean } = {}) {
	const page = new FakePage(), pages = [page], table = options.routes ?? routes(), requests: Array<{ url: string; options: Record<string, unknown> }> = [];
	const context = new EventEmitter() as EventEmitter & Record<string, unknown>;
	Object.assign(context, {
		pages: () => pages,
		newPage: async () => page,
		setDefaultTimeout: () => {},
		close: async () => { context.emit("close"); },
		request: {
			get: async (url: string, requestOptions: Record<string, unknown>) => {
				requests.push({ url, options: requestOptions });
				const route = table[url];
				if (url.endsWith("/slow")) {
					return await new Promise((_, reject) => {
						const signal = requestOptions.signal as AbortSignal | undefined;
						signal?.addEventListener("abort", () => reject(signal.reason), { once: true });
					});
				}
				if (!route) throw new Error(`Unexpected fixture URL: ${url}`);
				if (route.delayMs) await new Promise(resolve => setTimeout(resolve, route.delayMs));
				return { status: () => route.status, headers: () => ({ ...route.headers }), body: async () => route.body, dispose: async () => {} };
			},
		},
	});
	const module = new BrowserModule({
		port: 0, minActionIntervalMs: 0, minNavigationIntervalMs: 0, humanization: { enabled: false },
		actionTimeoutMs: 2_000, downloadTimeoutMs: options.downloadTimeoutMs ?? 5_000, maxDownloadBytes: options.maxDownloadBytes ?? 1024,
	}, { launch: (async () => context as unknown as BrowserContext) as BrowserType["launchPersistentContext"] });
	const loaded = loadConfig({ cwd: fs.mkdtempSync(path.join(root, "instance-")) });
	const store = EventStore.open(loaded.paths.stateDir);
	const memory = options.memoryFiles ? new Map<string, Buffer>() : undefined;
	const workspaceFiles = memory ? {
		rootDir: "/workspace",
		readFile: async (file: string) => { const data = memory.get(file); if (!data) throw new Error("ENOENT"); return data; },
		writeFile: async (file: string, data: Buffer) => { memory.set(file, data); return file; },
		exists: async (file: string) => memory.has(file),
	} : undefined;
	const host = new ModuleHost({ config: loaded, log, transports: [], modules: [module], workspaceFiles, ingest: (event) => store.append(event), outbox: () => [], history: HistoryStore.open(loaded.paths.stateDir), runtimeStatus: () => ({}) });
	modules.push(module); hosts.push(host);
	await host.init();
	await module.command({ action: "navigate", url: "https://fixture.test/" });
	return { module, page, requests, workspace: loaded.paths.workspaceDir, store, memory };
}

function workspaceFile(workspace: string, relativePath: string): Buffer {
	return fs.readFileSync(path.join(workspace, ...relativePath.split("/")));
}

function downloadFiles(workspace: string): string[] {
	const directory = path.join(workspace, "browser-downloads");
	return fs.existsSync(directory) ? fs.readdirSync(directory).sort() : [];
}

try {
	// --- limits and pure naming helpers ---
	assert.equal(DEFAULT_BROWSER_CONFIG.maxDownloadBytes, 50 * 1024 * 1024);
	assert.equal(DEFAULT_BROWSER_CONFIG.downloadTimeoutMs, 60_000);
	validateDownloadLimits({ maxDownloadBytes: 1_024, downloadTimeoutMs: 100 });
	validateDownloadLimits({ maxDownloadBytes: 1_073_741_824, downloadTimeoutMs: 600_000 });
	for (const limits of [
		{ maxDownloadBytes: 0, downloadTimeoutMs: 60_000 },
		{ maxDownloadBytes: 1_023, downloadTimeoutMs: 60_000 },
		{ maxDownloadBytes: 1_500.5, downloadTimeoutMs: 60_000 },
		{ maxDownloadBytes: Number.NaN, downloadTimeoutMs: 60_000 },
		{ maxDownloadBytes: 1_073_741_825, downloadTimeoutMs: 60_000 },
		{ maxDownloadBytes: 1_024, downloadTimeoutMs: 99 },
		{ maxDownloadBytes: 1_024, downloadTimeoutMs: 600_001 },
		{ maxDownloadBytes: 1_024, downloadTimeoutMs: 1_500.5 },
	]) assert.throws(() => validateDownloadLimits(limits), /maxDownloadBytes|downloadTimeoutMs/);
	await assert.rejects(() => new BrowserModule({ port: 0, maxDownloadBytes: 0, humanization: { enabled: false } }).start({} as never), /maxDownloadBytes/);
	await assert.rejects(() => new BrowserModule({ port: 0, downloadTimeoutMs: 99, humanization: { enabled: false } }).start({} as never), /downloadTimeoutMs/);

	assert.equal(contentDispositionFilename("attachment; filename=\"report.bin\""), "report.bin");
	assert.equal(contentDispositionFilename("attachment; filename*=UTF-8''%D0%BE%D1%82%D1%87%D1%91%D1%82.txt"), "отчёт.txt");
	assert.equal(contentDispositionFilename("attachment; filename=\"plain.txt\"; filename*=UTF-8''extended.txt"), "extended.txt");
	assert.equal(contentDispositionFilename("inline"), undefined);
	assert.equal(sanitizeDownloadName("../../etc/passwd"), "passwd");
	assert.equal(sanitizeDownloadName(".."), undefined);
	assert.equal(sanitizeDownloadName("a/b\\c.txt"), "c.txt");
	assert.equal(sanitizeDownloadName("bad\u0000name.txt"), "badname.txt");
	assert.equal(sanitizeDownloadName("CON"), "_CON");
	assert.ok((sanitizeDownloadName(`${"x".repeat(500)}.txt`) ?? "").length <= 120);
	assert.equal(downloadName({ contentDisposition: "attachment; filename=\"cd.bin\"", name: "name.bin", url: "https://fixture.test/url.bin" }), "cd.bin");
	assert.equal(downloadName({ name: "name.bin", url: "https://fixture.test/url.bin" }), "name.bin");
	assert.equal(downloadName({ url: "https://fixture.test/files/url.bin?x=1" }), "url.bin");
	assert.match(downloadName({ url: "https://fixture.test/" }), /^download-\d{8}T\d{9}Z$/);
	assert.equal(downloadMime({ "content-type": "text/plain; charset=utf-8" }), "text/plain");
	assert.equal(downloadMime({}), "application/octet-stream");

	// --- streaming sink: cap, no partial file, no overwrite ---
	const sinkDir = fs.mkdtempSync(path.join(root, "sink-"));
	const sink = createFileDownloadStore(sinkDir);
	await assert.rejects(() => saveDownload(sink, "browser-downloads/oversize.bin", [Buffer.alloc(3), Buffer.alloc(3)], 4), DownloadTooLargeError);
	assert.deepEqual(fs.readdirSync(path.join(sinkDir, "browser-downloads")), [], "An oversized stream leaves no temp or target file");
	const written = await saveDownload(sink, "browser-downloads/ok.bin", [Buffer.from([1, 2]), Buffer.from([3])], 4);
	assert.equal(written, 3);
	assert.deepEqual(fs.readFileSync(path.join(sinkDir, "browser-downloads/ok.bin")), Buffer.from([1, 2, 3]));
	assert.equal(await uniqueDownloadName(sink, "ok.bin"), "ok-1.bin");
	await assert.rejects(() => saveDownload(sink, "browser-downloads/ok.bin", [Buffer.from([9])], 4), /already exists/);
	assert.deepEqual(fs.readFileSync(path.join(sinkDir, "browser-downloads/ok.bin")), Buffer.from([1, 2, 3]), "An existing file is never overwritten");

	// --- local browser-session download through the module ---
	const { module, page, requests, workspace } = await fixture();
	const small = await module.command({ action: "download", url: "https://fixture.test/files/small.bin" });
	assert.equal(small.details.path, "browser-downloads/report.bin");
	assert.equal(small.details.filename, "report.bin");
	assert.equal(small.details.bytes, 4);
	assert.equal(small.details.mime, "application/octet-stream");
	assert.deepEqual(workspaceFile(workspace, "browser-downloads/report.bin"), Buffer.from([0, 1, 2, 255]));
	assert.equal((requests[0]!.options.headers as Record<string, string>).Referer, "https://fixture.test/", "The active page is the referer");
	assert.ok((requests[0]!.options.headers as Record<string, string>)["User-Agent"], "The active page User-Agent is used");
	assert.equal(requests[0]!.options.maxRedirects, 0, "Redirects are followed manually to keep signed headers scoped");

	// Content-Disposition RFC 5987 and MIME from headers.
	const extended = await module.command({ action: "download", url: "https://fixture.test/files/rfc5987.txt" });
	assert.equal(extended.details.filename, "отчёт.txt");
	assert.equal(extended.details.mime, "text/plain");
	assert.equal(workspaceFile(workspace, "browser-downloads/отчёт.txt").toString("utf8"), "rfc5987");

	// Redirect chain uses the final response's name and body.
	const redirected = await module.command({ action: "download", url: "https://fixture.test/files/redirect" });
	assert.equal(redirected.details.url, "https://fixture.test/files/small.bin");
	assert.equal(redirected.details.filename, "report-1.bin", "The first report.bin is not overwritten");

	// Name fallback: explicit name, then URL basename, then timestamp.
	const named = await module.command({ action: "download", url: "https://fixture.test/files/from-url.bin", name: "custom.bin" });
	assert.equal(named.details.filename, "custom.bin");
	const fromUrl = await module.command({ action: "download", url: "https://fixture.test/files/from-url.bin" });
	assert.equal(fromUrl.details.filename, "from-url.bin");
	const fallback = await module.command({ action: "download", url: "https://fixture.test/" });
	assert.match(String(fallback.details.filename), /^download-\d{8}T\d{9}Z$/);

	// Existing file suffix order.
	const suffixed = await module.command({ action: "download", url: "https://fixture.test/files/small.bin" });
	assert.equal(suffixed.details.filename, "report-2.bin");
	assert.deepEqual(workspaceFile(workspace, "browser-downloads/report-2.bin"), Buffer.from([0, 1, 2, 255]));

	// Non-HTTP schemes and HTTP failures write nothing.
	for (const url of ["file:///etc/passwd", "data:text/plain,hello", "ftp://fixture.test/file"]) {
		await assert.rejects(() => module.command({ action: "download", url }), /HTTP\(S\)|HTTP/);
	}
	await assert.rejects(() => module.command({ action: "download", url: "https://fixture.test/files/error" }), /HTTP 500/);
	assert.ok(!downloadFiles(workspace).includes("error"), "An HTTP error writes no file");

	// --- sandbox workspace bridge: one capped buffer, existence-aware suffixing ---
	const sandboxed = await fixture({ memoryFiles: true });
	await sandboxed.module.command({ action: "download", url: "https://fixture.test/files/small.bin" });
	assert.deepEqual(sandboxed.memory?.get("/workspace/browser-downloads/report.bin"), Buffer.from([0, 1, 2, 255]), "The sandbox writer receives the workspace-relative path and bytes");
	await sandboxed.module.command({ action: "download", url: "https://fixture.test/files/small.bin" });
	assert.ok(sandboxed.memory?.has("/workspace/browser-downloads/report-1.bin"), "The sandbox existence check refuses to overwrite");

	// --- oversize rejects without a partial file, and the session stays usable ---
	const limited = await fixture({ maxDownloadBytes: 1_024, routes: { ...routes(), "https://fixture.test/files/oversize.bin": { status: 200, headers: { "content-length": "2048", "content-type": "application/octet-stream" }, body: Buffer.alloc(2_048) } } });
	await assert.rejects(() => limited.module.command({ action: "download", url: "https://fixture.test/files/oversize.bin" }), error => error instanceof Error && /1024 byte limit/.test(error.message) && /maxDownloadBytes/.test(error.message));
	assert.deepEqual(downloadFiles(limited.workspace), [], "An oversized response leaves no partial file");
	const afterOversize = await limited.module.command({ action: "read" });
	assert.equal(afterOversize.details.text, "Download fixture page", "A failed download keeps the session usable");
	assert.equal(limited.module.status().open, true);

	// A chunked body without Content-Length is also capped before writing.
	const chunked = await fixture({ maxDownloadBytes: 1_024, routes: { ...routes(), "https://fixture.test/files/oversize.bin": { status: 200, headers: { "content-type": "application/octet-stream" }, body: Buffer.alloc(2_048) } } });
	await assert.rejects(() => chunked.module.command({ action: "download", url: "https://fixture.test/files/oversize.bin" }), DownloadTooLargeError);
	assert.deepEqual(downloadFiles(chunked.workspace), []);

	// --- timeout aborts cleanly and keeps the session ---
	const timed = await fixture({ downloadTimeoutMs: 150 });
	await assert.rejects(() => timed.module.command({ action: "download", url: "https://fixture.test/files/slow" }), error => error instanceof Error && /150 ms/.test(error.message) && /session was kept/.test(error.message));
	assert.deepEqual(downloadFiles(timed.workspace), []);
	assert.equal((await timed.module.command({ action: "read" })).details.text, "Download fixture page", "A timed-out download keeps the session usable");

	// --- shared-host fallback: client -> authenticated host endpoint -> Playwright request context ---
	const token = randomBytes(32).toString("base64url");
	process.env.ALIVE_TEST_SHARED_TOKEN = token;
	let upstreamHeaders: http.IncomingHttpHeaders | undefined;
	const upstream = http.createServer((request, response) => {
		upstreamHeaders = request.headers;
		if (request.url === "/file") {
			const body = Buffer.from([5, 6, 7]);
			response.writeHead(200, { "content-type": "image/png", "content-disposition": "attachment; filename=\"shared.png\"", "content-length": body.length });
			response.end(body);
		} else if (request.url === "/big") {
			response.writeHead(200, { "content-type": "application/octet-stream", "content-length": "2048" });
			response.end(Buffer.alloc(2_048));
		} else { response.writeHead(404); response.end(); }
	});
	await new Promise<void>(resolve => upstream.listen(0, "127.0.0.1", resolve));
	const upstreamUrl = `http://127.0.0.1:${(upstream.address() as { port: number }).port}`;
	const hostConfig = { ...DEFAULT_BROWSER_CONFIG, driver: "playwright" as const, maxDownloadBytes: 1_024, downloadTimeoutMs: 5_000 };
	const sharedHost = new SharedBrowserHost({ config: hostConfig, directory: fs.mkdtempSync(path.join(root, "shared-host-")), token, host: "127.0.0.1", port: 0 });
	const bridge = http.createServer((request, response) => {
		if (request.method === "POST" && request.url === "/v1/download") { void (sharedHost as unknown as { download(request: http.IncomingMessage, response: http.ServerResponse): Promise<void> }).download(request, response); return; }
		response.writeHead(404); response.end();
	});
	await new Promise<void>(resolve => bridge.listen(0, "127.0.0.1", resolve));
	const sharedConfig = { ...hostConfig, sharedUrl: `http://127.0.0.1:${(bridge.address() as { port: number }).port}`, sharedTokenEnv: "ALIVE_TEST_SHARED_TOKEN", sharedTokenFileEnv: "ALIVE_TEST_SHARED_FILE" };
	try {
		const shared = await sharedDownload(sharedConfig, {
			url: `${upstreamUrl}/file`, headers: { Referer: "https://fixture.test/page", "User-Agent": "TestAgent/1.0" },
			cookies: [{ name: "session", value: "secret", domain: "127.0.0.1", path: "/", httpOnly: true, secure: false, sameSite: "Lax" }],
		});
		const parts: Buffer[] = [];
		for await (const chunk of shared.body) parts.push(Buffer.from(chunk));
		assert.deepEqual(Buffer.concat(parts), Buffer.from([5, 6, 7]));
		assert.equal(shared.status, 200);
		assert.equal(shared.headers["content-type"], "image/png");
		assert.equal(shared.headers["content-disposition"], "attachment; filename=\"shared.png\"");
		assert.equal(shared.finalUrl, `${upstreamUrl}/file`);
		assert.equal(upstreamHeaders?.cookie, "session=secret", "The client context's session cookie reaches the host-side request");
		assert.equal(upstreamHeaders?.referer, "https://fixture.test/page");
		assert.equal(upstreamHeaders?.["user-agent"], "TestAgent/1.0");

		// The host enforces the same cap and returns a readable refusal.
		await assert.rejects(() => sharedDownload(sharedConfig, { url: `${upstreamUrl}/big` }), /1024 byte limit/);
	} finally {
		bridge.closeAllConnections(); await new Promise<void>(resolve => bridge.close(() => resolve()));
		upstream.closeAllConnections(); await new Promise<void>(resolve => upstream.close(() => resolve()));
		await sharedHost.close();
		delete process.env.ALIVE_TEST_SHARED_TOKEN;
	}

	assert.equal(page.address, "https://fixture.test/", "The active page is unchanged by downloads");
	console.log("browser download: limits, RFC 5987 naming, fallback order, suffixing, oversize, timeout, session survival and shared-host transport passed");
} finally {
	for (const host of hosts) await host.stop();
	fs.rmSync(root, { recursive: true, force: true });
}
