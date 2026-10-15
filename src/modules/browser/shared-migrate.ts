import * as fs from "node:fs";
import * as path from "node:path";
import type { BrowserType } from "playwright";
import type { LoadedConfig } from "../../config.js";
import { snapshotRuntime } from "../../runtime/daemon.js";
import { DEFAULT_BROWSER_CONFIG } from "./config.js";
import { resolveFortressLicense } from "./connection.js";
import { launchManagedFortress } from "./fortress.js";
import { writePrivateJson } from "./operator.js";

/** Offline, non-destructive import. Browser profiles remain available for rollback. */
export async function migrateSharedState(loaded: LoadedConfig): Promise<number> {
	if (snapshotRuntime(loaded.paths.stateDir)?.alive) throw new Error("Stop this agent before importing its browser state");
	const config = { ...DEFAULT_BROWSER_CONFIG, ...loaded.config.modules.browser };
	if (config.engine !== "fortress" || config.cdpEndpointEnv || config.executablePathEnv) throw new Error("Automatic shared-state import supports managed Fortress profiles only; other source profiles were preserved");
	const root = path.join(loaded.paths.modulesDir, "browser"), sessions = path.join(root, "sessions");
	const candidates = [root, ...(fs.existsSync(sessions) ? fs.readdirSync(sessions).filter(name => /^[a-f0-9]{24}$/.test(name)).map(name => path.join(sessions, name)) : [])];
	const engine = (config.driver === "patchright" ? (await import("patchright")).chromium : (await import("playwright")).chromium) as unknown as BrowserType;
	let imported = 0, cookies = 0, origins = 0, skipped = 0;
	for (const directory of candidates) {
		const profile = path.join(directory, "profile-fortress"), destination = path.join(directory, "shared-storage.json");
		if (!fs.existsSync(profile)) continue;
		if (fs.existsSync(destination)) { skipped++; continue; }
		const managed = await launchManagedFortress({ image: config.fortressImage, profile, stateDir: directory, licenseFile: resolveFortressLicense(config), timeoutMs: 60_000, signal: AbortSignal.timeout(70_000) });
		let browser;
		try {
			browser = await engine.connectOverCDP(managed.endpoint, { timeout: config.actionTimeoutMs, noDefaults: true });
			const context = browser.contexts()[0]; if (!context) throw new Error("Source Fortress profile could not be opened; no state was overwritten");
			const storage = await context.storageState({ indexedDB: true });
			writePrivateJson(destination, storage); imported++; cookies += storage.cookies.length; origins += storage.origins.length;
		} finally { try { await browser?.close(); } finally { await managed.close(); } }
	}
	process.stdout.write(`Imported ${imported} profile states (${cookies} cookies, ${origins} observed storage origins); skipped ${skipped} existing states. Original profiles were preserved. Unopened storage origins and sessionStorage may require a new login.\n`);
	return 0;
}
