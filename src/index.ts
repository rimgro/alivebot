#!/usr/bin/env node
import { main } from "./cli.js";

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
