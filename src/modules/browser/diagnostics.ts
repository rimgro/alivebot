import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { Browser, BrowserContext, BrowserType, Page } from "playwright";
import type { BrowserConfig } from "./config.js";
import { resolveBrowserExecutable, resolveCdpEndpoint, resolveFortressLicense } from "./connection.js";
import { chromeExecutable, launchNativeBrowser, type NativeBrowser } from "./native.js";
import { launchManagedFortress, type ManagedFortress } from "./fortress.js";

export interface CanvasReport {
	passed: boolean;
	blank: number[];
	cleared: number[];
	pngRoundTrip: number[];
	offscreen: number[] | null;
	opaque: number[];
	regions: { blank: boolean; cleared: boolean; pngRoundTrip: boolean; offscreen: boolean | null };
}

/** Observe native Canvas on an isolated blank tab without modifying browser APIs. */
export async function checkCanvas(page: Page): Promise<CanvasReport> {
	return await page.evaluate(`(async () => {
		const canvas = document.createElement("canvas");
		canvas.width = canvas.height = 8;
		const ctx = canvas.getContext("2d");
		const pixels = () => Array.from(ctx.getImageData(0, 0, 8, 8).data);
		const zero = values => values.every(value => value === 0);
		const blankData = pixels(), blank = blankData.slice(0, 4);
		ctx.fillStyle = "rgb(100, 120, 140)";
		ctx.fillRect(0, 0, 8, 8);
		const opaque = pixels().slice(0, 4);
		ctx.clearRect(0, 0, 8, 8);
		const clearedData = pixels(), cleared = clearedData.slice(0, 4);
		const image = new Image();
		image.src = canvas.toDataURL("image/png");
		await image.decode();
		ctx.drawImage(image, 0, 0);
		const pngData = pixels(), pngRoundTrip = pngData.slice(0, 4);
		const offscreenData = typeof OffscreenCanvas === "function"
			? Array.from(new OffscreenCanvas(8, 8).getContext("2d").getImageData(0, 0, 8, 8).data) : null;
		const offscreen = offscreenData ? offscreenData.slice(0, 4) : null;
		const regions = { blank: zero(blankData), cleared: zero(clearedData), pngRoundTrip: zero(pngData), offscreen: offscreenData ? zero(offscreenData) : null };
		return { blank, cleared, pngRoundTrip, offscreen, opaque, regions,
			passed: Object.values(regions).every(value => value !== false)
				&& opaque[3] === 255 && opaque.slice(0, 3).some(value => value > 0) };
	})()`) as CanvasReport;
}

/** Uses a fresh temporary profile, or a temporary tab in the configured CDP browser. */
export async function diagnoseBrowser(config: BrowserConfig): Promise<{ connection: string; version: string; fortressActivationVerified?: boolean; environment: { userAgent: string; webdriver: boolean; language: string; timezone: string; headlessMarker: boolean }; canvas: CanvasReport }> {
	const engine = (config.driver === "patchright" ? (await import("patchright")).chromium : (await import("playwright")).chromium) as unknown as BrowserType;
	const endpoint = resolveCdpEndpoint(config);
	const executablePath = resolveBrowserExecutable(config);
	const licenseFile = config.engine === "fortress" && !endpoint ? resolveFortressLicense(config) : undefined;
	let browser: Browser | undefined, context: BrowserContext | undefined, page: Page | undefined, directory: string | undefined;
	let native: NativeBrowser | undefined;
	let fortress: ManagedFortress | undefined;
	try {
		if (endpoint) {
			try { browser = await engine.connectOverCDP(endpoint, { timeout: config.actionTimeoutMs, noDefaults: true }); }
			catch { throw new Error("Cannot connect to the configured browser CDP endpoint"); }
			context = browser.contexts()[0];
			if (!context) throw new Error("The CDP browser has no default persistent context");
		} else {
			directory = fs.mkdtempSync(path.join(os.tmpdir(), "alive-browser-diagnose-"));
			if (config.engine === "fortress" && !executablePath) {
				fortress = await launchManagedFortress({ image: config.fortressImage, profile: path.join(directory, "profile"), stateDir: directory, licenseFile, timeoutMs: 60_000, signal: AbortSignal.timeout(60_000) });
				browser = await engine.connectOverCDP(fortress.endpoint, { timeout: config.actionTimeoutMs, noDefaults: true });
				context = browser.contexts()[0];
			} else if (config.engine === "fortress" || config.launchMode === "native" || (config.launchMode === "auto" && !config.headless && config.channel === "chrome")) {
				native = await launchNativeBrowser({ executable: executablePath || (config.channel === "chrome" ? chromeExecutable() : engine.executablePath()), profile: directory, headless: config.headless, warmupMs: 0, timeoutMs: config.actionTimeoutMs, signal: AbortSignal.timeout(config.actionTimeoutMs), ...(licenseFile ? { env: { ...process.env, TILION_LICENSE_KEY: fs.readFileSync(licenseFile, "utf8").trim() } } : {}) });
				browser = await engine.connectOverCDP(native.endpoint, { timeout: config.actionTimeoutMs, noDefaults: true });
				context = browser.contexts()[0];
			} else context = await engine.launchPersistentContext(directory, { ...(executablePath ? { executablePath } : { channel: config.channel }), headless: config.headless, viewport: null, acceptDownloads: false });
		}
		page = await context.newPage();
		page.setDefaultTimeout(config.actionTimeoutMs);
		let timer: ReturnType<typeof setTimeout> | undefined;
		let canvas: CanvasReport;
		try {
			canvas = await Promise.race([checkCanvas(page), new Promise<never>((_resolve, reject) => {
				timer = setTimeout(() => reject(new Error("Canvas diagnostics timed out")), config.actionTimeoutMs);
			})]);
		} finally { clearTimeout(timer); }
		const environment = await page.evaluate(() => ({ userAgent: navigator.userAgent, webdriver: (navigator as unknown as { webdriver?: boolean }).webdriver === true, language: navigator.language, timezone: Intl.DateTimeFormat().resolvedOptions().timeZone, headlessMarker: /HeadlessChrome/i.test(navigator.userAgent) }));
		const fortressActivationVerified = fortress?.activationVerified;
		return { connection: endpoint ? "cdp" : fortress ? "managed-fortress" : native ? "managed-native" : "managed", version: context.browser()!.version(), ...(fortress ? { fortressActivationVerified } : {}), environment, canvas };
	} finally {
		await page?.close().catch(() => {});
		if (browser) await browser.close();
		else await context?.close();
		await native?.close();
		await fortress?.close();
		if (directory) fs.rmSync(directory, { recursive: true, force: true });
	}
}
