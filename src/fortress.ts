#!/usr/bin/env node
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { runFortressLauncher } from "./fortress-launcher.js";

// The upstream launcher's geo lookup has no connect timeout. Pin a timezone
// before launch so offline/firewalled machines cannot hang before Chrome starts.
process.env.TILION_TZ ||= process.env.TZ || Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
const { Fortress } = await import("tilion-fortress");
const root = fileURLToPath(new URL("../", import.meta.url));
const port = Number(process.env.ALIVE_FORTRESS_PORT ?? "9223");
if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error("Invalid ALIVE_FORTRESS_PORT");
process.exit(await runFortressLauncher({
	stateDir: path.join(root, ".alive", "browser"),
	port,
	createBrowser: ({ port, profile }) => new Fortress({
		port,
		persona: { platform: "Win32" },
		// Use upstream UA fields: the launcher discards --user-agent overrides.
		// Canvas noise remains an upstream defect; zero/empty/absent seeds do not
		// reliably preserve transparent pixels, so do not pretend to disable it here.
		extraArgs: [
			"--uxr-ua-platform=Windows",
			"--uxr-ua-os=Windows NT 10.0; Win64; x64",
			`--user-data-dir=${profile}`,
		],
	}),
}));
