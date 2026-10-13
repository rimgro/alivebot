import * as fs from "node:fs";
import * as path from "node:path";
import { randomBytes } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import type { LoadedConfig } from "../../config.js";
import { writePrivateJson } from "./operator.js";
import { validateFortressToken } from "./connection.js";

const API = "https://fortress.tilion.dev";
async function post(route: string, body: unknown, signal: AbortSignal): Promise<{ status: number; body: Record<string, unknown> }> {
	const response = await fetch(API + route, { method: "POST", redirect: "error", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body), signal: AbortSignal.any([signal, AbortSignal.timeout(15_000)]) });
	let result: unknown;
	try { result = await response.json(); } catch { throw new Error("Invalid Fortress activation response"); }
	if (!result || typeof result !== "object" || Array.isArray(result)) throw new Error("Invalid Fortress activation response");
	return { status: response.status, body: result as Record<string, unknown> };
}

function writePrivateText(file: string, content: string): void {
	const temporary = `${file}.${randomBytes(8).toString("hex")}.tmp`;
	try {
		fs.writeFileSync(temporary, content, { mode: 0o600, flag: "wx" });
		fs.renameSync(temporary, file);
	} finally { fs.rmSync(temporary, { force: true }); }
}

/** Official device flow. Never prints device credentials or a license token. */
export async function activateFortress(loaded: LoadedConfig, signal: AbortSignal): Promise<void> {
	const directory = path.join(loaded.paths.modulesDir, "browser", "fortress-license");
	fs.mkdirSync(directory, { recursive: true, mode: 0o700 }); fs.chmodSync(directory, 0o700);
	const start = await post("/v1/activate/start", {}, signal);
	if (start.status !== 200) throw new Error(`Fortress activation could not start (HTTP ${start.status})`);
	const { verification_uri: link, user_code: code, device_code: credential } = start.body;
	if (typeof link !== "string" || typeof code !== "string" || !/^[A-Za-z0-9-]{1,64}$/.test(code) || typeof credential !== "string" || !credential || credential.length > 4096) throw new Error("Invalid Fortress activation response");
	let url: URL;
	try { url = new URL(link); } catch { throw new Error("Unexpected Fortress verification origin"); }
	if (url.protocol !== "https:" || !["fortress.tilion.dev", "fortress.tilion.com"].includes(url.hostname) || url.username || url.password || url.hash) throw new Error("Unexpected Fortress verification origin");
	const interval = Math.min(15_000, Math.max(1000, Number(start.body.interval || 5) * 1000));
	const expires = Math.min(15 * 60_000, Math.max(30_000, Number(start.body.expires_in || 900) * 1000));
	if (!Number.isFinite(interval) || !Number.isFinite(expires)) throw new Error("Invalid Fortress activation lifetime");
	writePrivateJson(path.join(directory, "pending.json"), { verificationUrl: url.href, userCode: code, expiresAt: Date.now() + expires });
	process.stdout.write(`Open ${url.href}\nVerification code: ${code}\nWaiting for device approval. The license stays in private local storage.\n`);
	try {
		const deadline = Date.now() + expires;
		while (Date.now() < deadline) {
			await delay(interval, undefined, { signal });
			const poll = await post("/v1/activate/poll", { device_code: credential }, signal);
			if (poll.status === 410) break;
			if (poll.status !== 200 || typeof poll.body.license !== "string") continue;
			const file = path.join(directory, "license.jwt");
			const token = poll.body.license.trim();
			validateFortressToken(token);
			const envFile = path.join(path.dirname(loaded.paths.configPath), ".env"), name = loaded.config.modules.browser?.fortressLicenseFileEnv || "ALIVE_FORTRESS_LICENSE_FILE";
			if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) throw new Error("Invalid Fortress license environment variable name");
			const existing = fs.existsSync(envFile) ? fs.readFileSync(envFile, "utf8") : "";
			const assignment = `${name}=${JSON.stringify(file)}`;
			const pattern = new RegExp(`^(?:export\\s+)?${name}\\s*=.*$`, "m");
			const updated = pattern.test(existing) ? existing.replace(pattern, assignment) : existing + (existing.endsWith("\n") || !existing ? "" : "\n") + assignment + "\n";
			writePrivateText(file, token + "\n");
			writePrivateText(envFile, updated);
			process.stdout.write("Fortress license saved privately. The engine verifies its signature at startup.\n");
			return;
		}
		throw new Error("Fortress activation expired; run alive browser activate again");
	} finally { fs.rmSync(path.join(directory, "pending.json"), { force: true }); }
}
