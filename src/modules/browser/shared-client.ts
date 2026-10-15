import * as fs from "node:fs";
import * as path from "node:path";
import type { Browser, BrowserContext, BrowserType } from "playwright";
import type { BrowserConfig } from "./config.js";
import { writePrivateJson } from "./operator.js";

export interface SharedMetadata {
	protocol: 1; engine: string; browserVersion: string; fortressImage?: string; fortressActivationVerified: boolean;
	signing?: { agentUrl: string; keyId: string; origins: string[] };
}
export interface SharedContext {
	context: BrowserContext; browser: Browser; metadata: SharedMetadata;
	checkpoint(): Promise<void>; close(): Promise<void>;
}

export function sharedOrigin(value: string): string {
	const url = new URL(value);
	if (!["http:", "https:"].includes(url.protocol) || url.username || url.password || url.pathname !== "/" || url.search || url.hash) throw new Error("Use an exact private HTTP(S) shared browser origin without credentials");
	return url.origin;
}

export function sharedToken(config: Pick<BrowserConfig, "sharedTokenFileEnv" | "sharedTokenEnv">): string {
	for (const name of [config.sharedTokenFileEnv, config.sharedTokenEnv]) if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) throw new Error("Invalid shared browser token variable name");
	let token = process.env[config.sharedTokenEnv] || "";
	const file = process.env[config.sharedTokenFileEnv];
	if (file) {
		if (!path.isAbsolute(file) || !fs.statSync(file).isFile() || (process.platform !== "win32" && (fs.statSync(file).mode & 0o077))) throw new Error("Shared browser token file must be absolute and private");
		token = fs.readFileSync(file, "utf8").trim();
	}
	if (!/^[A-Za-z0-9_-]{43,128}$/.test(token)) throw new Error("Configure a private shared browser token file or environment variable; no dedicated-browser fallback is allowed");
	return token;
}

export async function sharedMetadata(config: BrowserConfig, signal?: AbortSignal): Promise<SharedMetadata> {
	try {
		const response = await fetch(`${sharedOrigin(config.sharedUrl)}/v1/status`, { headers: { Authorization: `Bearer ${sharedToken(config)}` }, redirect: "error", signal: AbortSignal.any([AbortSignal.timeout(config.actionTimeoutMs), ...(signal ? [signal] : [])]) });
		if (!response.ok) throw new Error();
		const metadata = await response.json() as SharedMetadata;
		if (metadata.protocol !== 1 || !metadata.browserVersion || !["chrome", "fortress"].includes(metadata.engine)) throw new Error();
		if (metadata.engine !== config.engine || (config.engine === "fortress" && (metadata.fortressImage !== config.fortressImage || (config.fortressRequireLicense && !metadata.fortressActivationVerified)))) throw new Error();
		if (config.signing.enabled && (metadata.signing?.agentUrl !== config.signing.agentUrl || JSON.stringify([...metadata.signing.origins].sort()) !== JSON.stringify([...config.signing.origins].sort()))) throw new Error();
		return metadata;
	} catch { throw new Error("Shared browser host is unavailable, unauthorized, or differs from the configured engine/signing policy; no local browser was started"); }
}

/** Relay a freshly signed public directory without distributing the host's private key. */
export async function sharedDirectory(config: BrowserConfig): Promise<{ headers: Record<string, string>; body: string }> {
	try {
		const response = await fetch(`${sharedOrigin(config.sharedUrl)}/v1/identity-directory`, { headers: { Authorization: `Bearer ${sharedToken(config)}` }, redirect: "error", signal: AbortSignal.timeout(config.actionTimeoutMs) });
		if (!response.ok) throw new Error();
		const directory = await response.json() as { headers: Record<string, string>; body: string };
		if (typeof directory.body !== "string" || !directory.headers || typeof directory.headers.Signature !== "string") throw new Error();
		return directory;
	} catch { throw new Error("Shared host public identity directory is unavailable"); }
}

/** Each remote connection owns one incognito context. A dropped connection cleans up only its contexts. */
export async function openSharedContext(config: BrowserConfig, directory: string, signal: AbortSignal): Promise<SharedContext> {
	const metadata = await sharedMetadata(config, signal);
	const engine = (config.driver === "patchright" ? (await import("patchright")).chromium : (await import("playwright")).chromium) as unknown as BrowserType;
	const endpoint = new URL("/connect", sharedOrigin(config.sharedUrl)); endpoint.protocol = endpoint.protocol === "https:" ? "wss:" : "ws:";
	let browser: Browser;
	try { browser = await engine.connect(endpoint.href, { headers: { Authorization: `Bearer ${sharedToken(config)}` }, timeout: config.actionTimeoutMs }); }
	catch { throw new Error("Cannot connect to the shared browser protocol; check host availability, credentials and matching driver versions"); }
	let context: BrowserContext;
	const file = path.join(directory, "shared-storage.json");
	try {
		signal.throwIfAborted();
		context = await browser.newContext({ viewport: config.viewport, acceptDownloads: false, ...(fs.existsSync(file) ? { storageState: JSON.parse(fs.readFileSync(file, "utf8")) } : {}) });
	} catch { await browser.close(); throw new Error("Cannot restore the private shared-browser context; the saved state was preserved"); }
	let stopped = false, saving: Promise<void> | undefined;
	const checkpoint = async () => {
		if (stopped || saving) return saving;
		saving = (async () => { const storage = await context.storageState({ indexedDB: true }); writePrivateJson(file, storage); })();
		try { await saving; } finally { saving = undefined; }
	};
	const timer = setInterval(() => { void checkpoint().catch(() => {}); }, 15_000); timer.unref();
	browser.once("disconnected", () => { clearInterval(timer); });
	if (signal.aborted) { clearInterval(timer); await context.close(); await browser.close(); signal.throwIfAborted(); }
	return { context, browser, metadata, checkpoint, close: async () => {
		clearInterval(timer);
		try { await checkpoint(); } finally { stopped = true; await context.close().catch(() => {}); await browser.close().catch(() => {}); }
	} };
}
