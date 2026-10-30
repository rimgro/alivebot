#!/usr/bin/env node
import { main } from "./cli.js";
import { loadEnvFiles } from "./env.js";

// Load project-local secrets for foreground and daemon launches. Lookup order,
// most specific first: real process environment → `.env` next to the resolved
// `--config` → `.env` in the current working directory. Node never overrides an
// already-set variable, so loading the profile's own file first keeps a managed
// agent on its own bot instead of the shared root one (#108).
loadEnvFiles();

// Never crash because a consumer closed the pipe (e.g. `alive status | head`).
process.stdout.on("error", (err) => {
	if ((err as NodeJS.ErrnoException).code === "EPIPE") process.exit(0);
	throw err;
});
process.stderr.on("error", () => undefined);

main(process.argv.slice(2))
	.then((code) => {
		process.exitCode = code;
	})
	.catch((err) => {
		process.stderr.write(`fatal: ${err instanceof Error ? (err.stack ?? err.message) : String(err)}\n`);
		process.exitCode = 1;
	});
