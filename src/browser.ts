#!/usr/bin/env node
import { spawn } from "node:child_process";
import { browserArgs, browserConnection, ensureFortress } from "./fortress-browser.js";

try {
	const args = process.argv.slice(2);
	browserArgs(browserConnection().endpoint, args);
	const endpoint = await ensureFortress();
	const child = spawn(process.execPath, browserArgs(endpoint, args), { stdio: "inherit" });
	child.on("error", (error) => { console.error(error.message); process.exitCode = 1; });
	child.on("exit", (code, signal) => { process.exitCode = code ?? (signal ? 1 : 0); });
	for (const signal of ["SIGINT", "SIGTERM"] as const) process.on(signal, () => child.kill(signal));
} catch (error) {
	console.error(error instanceof Error ? error.message : String(error));
	process.exitCode = 1;
}
