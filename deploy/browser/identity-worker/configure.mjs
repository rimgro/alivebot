import { createPrivateKey, createPublicKey } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

const cwd = fileURLToPath(new URL("../../../", import.meta.url));
if (fs.existsSync(path.join(cwd, ".env"))) process.loadEnvFile(path.join(cwd, ".env"));
const keyFile = process.env.ALIVE_BROWSER_SIGNING_KEY_FILE;
if (!keyFile) throw new Error("Configure ALIVE_BROWSER_SIGNING_KEY_FILE before preparing the Worker");
const key = createPrivateKey(fs.readFileSync(keyFile));
if (key.asymmetricKeyType !== "ed25519") throw new Error("An Ed25519 identity key is required");
if (process.argv.includes("--secret-stdin")) {
	// Pipe directly to `wrangler secret put PRIVATE_KEY_PKCS8`; never run standalone.
	process.stdout.write(key.export({ type: "pkcs8", format: "der" }).toString("base64"));
} else {
	const origin = new URL(process.argv[2]);
	if (origin.protocol !== "https:" || origin.origin !== process.argv[2]) throw new Error("Use an exact HTTPS identity origin");
	const jwk = createPublicKey(key).export({ format: "jwk" });
	const directory = path.join(cwd, ".alive", "identity-worker");
	fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
	const file = path.join(directory, "wrangler.json");
	const config = {
		name: "alive-browser-identity", main: path.join(cwd, "src/modules/browser/identity-worker.ts"),
		compatibility_date: "2026-10-08", workers_dev: true,
		...(process.argv[3] ? { account_id: process.argv[3] } : {}),
		vars: { AGENT_ORIGIN: origin.origin, PUBLIC_JWK: JSON.stringify({ crv: jwk.crv, kty: jwk.kty, x: jwk.x }) },
	};
	fs.writeFileSync(file, JSON.stringify(config, null, 2) + "\n", { mode: 0o600 });
	console.log(`Prepared ${file}; no private key is in the configuration.`);
}
