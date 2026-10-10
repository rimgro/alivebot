import { createHash, createPrivateKey, createPublicKey, randomBytes, sign, type KeyObject } from "node:crypto";
import * as fs from "node:fs";
import type { BrowserSigningConfig } from "./config.js";

/** Cloudflare's supported Web Bot Auth profile (RFC 9421 / RFC 7638). */
export class BrowserIdentity {
	private readonly key: KeyObject;
	private readonly publicJwk: { crv: string; kty: string; x: string };
	readonly keyId: string;
	readonly agentUrl: string;
	private readonly origins: Set<string>;

	constructor(config: BrowserSigningConfig, env: NodeJS.ProcessEnv = process.env) {
		const agent = new URL(config.agentUrl);
		if (agent.protocol !== "https:" || agent.username || agent.password || agent.pathname !== "/" || agent.search || agent.hash) {
			throw new Error("signing.agentUrl must be an HTTPS origin");
		}
		this.agentUrl = agent.origin;
		this.origins = new Set(config.origins.map((value) => {
			const url = new URL(value);
			if (url.protocol !== "https:" || url.username || url.password || url.pathname !== "/" || url.search || url.hash) {
				throw new Error("signing.origins must contain exact HTTPS origins");
			}
			return url.origin;
		}));
		if (!this.origins.size) throw new Error("signing.origins must explicitly authorize at least one origin");
		const file = env[config.keyFileEnv];
		if (!file) throw new Error(`Set ${config.keyFileEnv} to the Ed25519 private key file path`);
		this.key = createPrivateKey(fs.readFileSync(file));
		if (this.key.asymmetricKeyType !== "ed25519") throw new Error("Web Bot Auth requires an Ed25519 key");
		const jwk = createPublicKey(this.key).export({ format: "jwk" });
		this.publicJwk = { crv: jwk.crv!, kty: jwk.kty!, x: jwk.x! };
		this.keyId = createHash("sha256").update(JSON.stringify(this.publicJwk)).digest("base64url");
	}

	authorizes(value: string): boolean {
		const url = new URL(value);
		return !url.username && !url.password && this.origins.has(url.origin);
	}

	requestHeaders(value: string, now = Date.now(), method = "GET"): Record<string, string> {
		const url = new URL(value);
		if (!this.authorizes(value)) throw new Error("Origin is not authorized for signed requests");
		if (!/^[A-Z]+$/.test(method)) throw new Error("Invalid signed request method");
		const agent = JSON.stringify(this.agentUrl);
		const components = '("@authority" "@method" "@path" "@query" "signature-agent")';
		const input = this.parameters(components, "web-bot-auth", now);
		const base = `"@authority": ${url.host}\n"@method": ${method}\n"@path": ${url.pathname}\n"@query": ${url.search || "?"}\n"signature-agent": ${agent}\n"@signature-params": ${input}`;
		return { "Signature-Agent": agent, ...this.headers(input, base) };
	}

	directory(now = Date.now()): { body: string; headers: Record<string, string> } {
		const authority = new URL(this.agentUrl).host;
		const input = this.parameters('("@authority";req)', "http-message-signatures-directory", now);
		return {
			body: JSON.stringify({ keys: [this.publicJwk] }),
			headers: {
				"Content-Type": "application/http-message-signatures-directory+json",
				"Cache-Control": "no-store",
				...this.headers(input, `"@authority";req: ${authority}\n"@signature-params": ${input}`),
			},
		};
	}

	private parameters(components: string, tag: string, now: number): string {
		const created = Math.floor(now / 1000);
		return `${components};created=${created};expires=${created + 60};keyid="${this.keyId}";alg="ed25519";nonce="${randomBytes(24).toString("base64url")}";tag="${tag}"`;
	}

	private headers(input: string, base: string): Record<string, string> {
		if (/[^\x20-\x7e\n]/.test(base)) throw new Error("Signature components must contain ASCII only");
		return { "Signature-Input": `sig1=${input}`, Signature: `sig1=:${sign(null, Buffer.from(base), this.key).toString("base64")}:` };
	}
}
