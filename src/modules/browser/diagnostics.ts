import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { Browser, BrowserContext, BrowserType, Page } from "playwright";
import type { BrowserConfig } from "./config.js";
import { resolveCdpEndpoint } from "./connection.js";

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
export async function diagnoseBrowser(config: BrowserConfig): Promise<{ connection: string; version: string; canvas: CanvasReport }> {
	const engine = (config.driver === "patchright" ? (await import("patchright")).chromium : (await import("playwright")).chromium) as unknown as BrowserType;
	const endpoint = resolveCdpEndpoint(config);
	let browser: Browser | undefined, context: BrowserContext | undefined, page: Page | undefined, directory: string | undefined;
	try {
		if (endpoint) {
			try { browser = await engine.connectOverCDP(endpoint, { timeout: config.actionTimeoutMs, noDefaults: true }); }
			catch { throw new Error("Cannot connect to the configured browser CDP endpoint"); }
			context = browser.contexts()[0];
			if (!context) throw new Error("The CDP browser has no default persistent context");
		} else {
			directory = fs.mkdtempSync(path.join(os.tmpdir(), "alive-browser-diagnose-"));
			context = await engine.launchPersistentContext(directory, { channel: config.channel, headless: config.headless, viewport: null, acceptDownloads: false });
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
		return { connection: endpoint ? "cdp" : "managed", version: context.browser()!.version(), canvas };
	} finally {
		await page?.close().catch(() => {});
		if (browser) await browser.close();
		else await context?.close();
		if (directory) fs.rmSync(directory, { recursive: true, force: true });
	}
}
