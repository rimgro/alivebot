/**
 * `.env` loading for the CLI/daemon entry point.
 *
 * Lookup order, most specific first:
 *
 *   1. variables already present in the process environment (shell export, systemd
 *      unit, container env): `process.loadEnvFile` never overrides them;
 *   2. `.env` next to the resolved `--config` (the profile's own secrets, e.g.
 *      `<agents>/developer/.env`) — loaded first so it wins over the root file;
 *   3. `.env` in the current working directory (the root profile's secrets).
 *
 * The per-profile file must load before the root one: when a managed agent is
 * launched with `--config <agent>/alive.config.json` from the root directory,
 * a shared root `.env` would otherwise put the master bot token into
 * `process.env` first and the agent would answer the master's bot (#108).
 */
import * as fs from "node:fs";
import * as path from "node:path";

/** Value of `--config <path>` / `--config=<path>` in CLI argv (command included). */
export function configFlag(argv: readonly string[]): string | undefined {
	for (let index = 1; index < argv.length; index += 1) {
		const token = argv[index]!;
		if (!token.startsWith("-")) continue;
		const key = token.replace(/^--?/, "");
		const eq = key.indexOf("=");
		if (eq >= 0) {
			if (key.slice(0, eq) === "config") {
				const value = key.slice(eq + 1);
				if (value) return value;
			}
			continue;
		}
		if (key !== "config") continue;
		const next = argv[index + 1];
		if (next !== undefined && !next.startsWith("-")) return next;
	}
	return undefined;
}

/**
 * Load `.env` files in precedence order. Returns the files that were loaded,
 * most specific first. Missing files are skipped; a malformed file throws from
 * Node, exactly like `process.loadEnvFile`.
 */
export function loadEnvFiles(argv: readonly string[] = process.argv.slice(2), cwd: string = process.cwd()): string[] {
	const configPath = configFlag(argv);
	const candidates = [
		configPath ? path.join(path.dirname(path.resolve(cwd, configPath)), ".env") : undefined,
		path.join(cwd, ".env"),
	];
	const loaded: string[] = [];
	for (const candidate of candidates) {
		if (!candidate || loaded.includes(candidate)) continue;
		if (!fs.existsSync(candidate)) continue;
		process.loadEnvFile(candidate);
		loaded.push(candidate);
	}
	return loaded;
}
