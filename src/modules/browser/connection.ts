import type { BrowserConfig } from "./config.js";
import * as fs from "node:fs";
import * as path from "node:path";

/** Structural/expiry check only; the official engine verifies the signature. */
export function validateFortressToken(token: string, now = Date.now()): void {
	try {
		const parts = token.split(".");
		if (token.length > 16_384 || parts.length !== 3 || !parts.every(part => /^[a-zA-Z0-9_-]+$/.test(part))) throw new Error();
		const claims = JSON.parse(Buffer.from(parts[1], "base64url").toString("utf8"));
		if (!Number.isSafeInteger(claims?.exp) || claims.exp * 1000 <= now) throw new Error();
	} catch { throw new Error("Invalid or expired Fortress license token"); }
}

export function resolveFortressLicense(config: Pick<BrowserConfig, "fortressLicenseFileEnv" | "fortressRequireLicense">, env: NodeJS.ProcessEnv = process.env): string | undefined {
	const name = config.fortressLicenseFileEnv;
	if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) throw new Error("Invalid Fortress license environment variable name");
	const file = env[name];
	if (!file) { if (config.fortressRequireLicense) throw new Error("Activate Fortress first with alive browser activate; silent first-generation fallback is disabled"); return; }
	try {
		if (!path.isAbsolute(file) || !fs.statSync(file).isFile() || (process.platform !== "win32" && (fs.statSync(file).mode & 0o077))) throw new Error();
		validateFortressToken(fs.readFileSync(file, "utf8").trim());
	} catch { throw new Error("Fortress license file must be private and contain a current token; run alive browser activate"); }
	// Presence/expiry only: the official engine verifies the license signature.
	return file;
}

/** Operator configuration only; tool/page input cannot select an executable. */
export function resolveBrowserExecutable(config: Pick<BrowserConfig, "executablePathEnv" | "cdpEndpointEnv">, env: NodeJS.ProcessEnv = process.env): string | undefined {
	const name = config.executablePathEnv;
	if (!name) return undefined;
	if (config.cdpEndpointEnv) throw new Error("Choose a managed browser executable or external CDP, not both");
	if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) throw new Error("Invalid browser executable environment variable name");
	const value = env[name];
	if (!value) throw new Error(`Set ${name} to the trusted Chromium executable`);
	try {
		if (!path.isAbsolute(value) || !fs.statSync(value).isFile()) throw new Error();
		fs.accessSync(value, fs.constants.X_OK);
	} catch { throw new Error("Browser executable must be an existing absolute executable file"); }
	return value;
}

/** CDP grants full browser access. Remote browsers must use a private port forward. */
export function resolveCdpEndpoint(config: Pick<BrowserConfig, "cdpEndpointEnv">, env: NodeJS.ProcessEnv = process.env): string | undefined {
	const name = config.cdpEndpointEnv;
	if (!name) return undefined;
	if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) throw new Error("Invalid browser CDP environment variable name");
	const value = env[name];
	if (!value) throw new Error(`Set ${name} to the dedicated browser's loopback CDP endpoint`);
	let url: URL;
	try { url = new URL(value); } catch { throw new Error("Invalid browser CDP endpoint"); }
	if (!["http:", "ws:"].includes(url.protocol) || !["localhost", "127.0.0.1", "[::1]"].includes(url.hostname) || url.username || url.password || url.search || url.hash) {
		throw new Error("Browser CDP requires a loopback HTTP or WebSocket URL without credentials, query or fragment; use a private port forward for remote browsers");
	}
	return url.href;
}
