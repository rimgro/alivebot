#!/usr/bin/env node
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

// The upstream launcher's geo lookup has no connect timeout. Pin a timezone
// before launch so offline/firewalled machines cannot hang before Chrome starts.
process.env.TILION_TZ ||= process.env.TZ || Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
const { Fortress } = await import("tilion-fortress");
const root = fileURLToPath(new URL("../", import.meta.url));
const stateDir = path.join(root, ".alive", "browser");
fs.mkdirSync(stateDir, { recursive: true });
const port = Number(process.env.ALIVE_FORTRESS_PORT ?? "9223");
if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error("Invalid ALIVE_FORTRESS_PORT");
const lock = path.join(stateDir, `fortress-${port}.pid`);
try {
	const pid = Number(fs.readFileSync(lock, "utf8"));
	if (!Number.isInteger(pid) || pid <= 0) throw new Error(`Invalid Fortress PID file: ${lock}`);
	try { process.kill(pid, 0); process.exit(0); } catch (error) {
		if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
		fs.unlinkSync(lock);
	}
} catch (error) {
	if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
}
try { fs.writeFileSync(lock, String(process.pid), { flag: "wx" }); }
catch (error) { if ((error as NodeJS.ErrnoException).code === "EEXIST") process.exit(0); throw error; }
// Use upstream UA fields: the launcher discards --user-agent overrides.
// Canvas noise remains an upstream defect; zero/empty/absent seeds do not
// reliably preserve transparent pixels, so do not pretend to disable it here.
const fortress = new Fortress({
	port,
	persona: { platform: "Win32" },
	extraArgs: [
		"--uxr-ua-platform=Windows",
		"--uxr-ua-os=Windows NT 10.0; Win64; x64",
		`--user-data-dir=${path.join(stateDir, `profile-${port}`)}`,
	],
});
let closing = false;
async function stop(code: number) {
	if (closing) return;
	closing = true;
	await fortress.close();
	if (fs.existsSync(lock) && fs.readFileSync(lock, "utf8") === String(process.pid)) fs.unlinkSync(lock);
	process.exit(code);
}
process.on("SIGINT", () => { void stop(0); });
process.on("SIGTERM", () => { void stop(0); });
const timer = setTimeout(() => { console.error("Fortress startup timed out"); void stop(1); }, 120_000);
try {
	await fortress.start();
	clearTimeout(timer);
	console.error(`Fortress ready: http://127.0.0.1:${port}`);
	fortress.proc?.once("exit", () => { void stop(1); });
	setInterval(() => {}, 60_000);
} catch (error) {
	console.error(error);
	await stop(1);
}
