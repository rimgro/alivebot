import type { BrowserConfig } from "./config.js";
import * as fs from "node:fs";
import * as path from "node:path";

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
