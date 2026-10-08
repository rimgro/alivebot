/** Optional public directory host; it has no browser, Telegram or model credentials. */
export interface WorkerIdentityEnv {
	AGENT_ORIGIN: string;
	PUBLIC_JWK: string;
	/** Cloudflare secret containing base64-encoded PKCS#8 DER, never a public variable. */
	PRIVATE_KEY_PKCS8: string;
}

const encoder = new TextEncoder();
const identities = new WeakMap<WorkerIdentityEnv, Promise<Awaited<ReturnType<typeof loadIdentity>>>>();
const bytes = (value: string): Uint8Array<ArrayBuffer> => Uint8Array.from(atob(value), character => character.charCodeAt(0));
const base64 = (value: ArrayBuffer | Uint8Array): string => btoa(String.fromCharCode(...(value instanceof Uint8Array ? value : new Uint8Array(value))));

async function loadIdentity(env: WorkerIdentityEnv) {
	const origin = new URL(env.AGENT_ORIGIN);
	if (origin.protocol !== "https:" || origin.origin !== env.AGENT_ORIGIN) throw new Error("Invalid identity origin");
	const source = JSON.parse(env.PUBLIC_JWK) as Record<string, string>;
	if (source.d || source.kty !== "OKP" || source.crv !== "Ed25519" || !/^[A-Za-z0-9_-]{43}$/.test(source.x)) throw new Error("Invalid public identity key");
	const jwk = { crv: "Ed25519", kty: "OKP", x: source.x };
	const privateKey = await crypto.subtle.importKey("pkcs8", bytes(env.PRIVATE_KEY_PKCS8), "Ed25519", false, ["sign"]);
	const publicKey = await crypto.subtle.importKey("jwk", jwk, "Ed25519", false, ["verify"]);
	const challenge = encoder.encode("Alive directory key consistency");
	if (!await crypto.subtle.verify("Ed25519", publicKey, await crypto.subtle.sign("Ed25519", privateKey, challenge), challenge)) throw new Error("Identity keys do not match");
	const keyId = base64(await crypto.subtle.digest("SHA-256", encoder.encode(JSON.stringify(jwk)))).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
	return { origin, privateKey, keyId, body: JSON.stringify({ keys: [jwk] }) };
}

export default {
	async fetch(request: Request, env: WorkerIdentityEnv): Promise<Response> {
		const url = new URL(request.url);
		const headers: Record<string, string> = { "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" };
		if (url.pathname !== "/.well-known/http-message-signatures-directory") return new Response("Not found", { status: 404, headers });
		if (request.method !== "GET" && request.method !== "HEAD") return new Response("Method not allowed", { status: 405, headers: { ...headers, Allow: "GET, HEAD" } });
		try {
			let pending = identities.get(env);
			if (!pending) { pending = loadIdentity(env); identities.set(env, pending); }
			const identity = await pending;
			const authority = request.headers.get("host") ?? url.host;
			if (url.origin !== identity.origin.origin || authority !== identity.origin.host) return new Response("Unexpected identity authority", { status: 421, headers });
			const created = Math.floor(Date.now() / 1000);
			const nonce = base64(crypto.getRandomValues(new Uint8Array(24))).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
			const input = `("@authority";req);created=${created};expires=${created + 60};keyid="${identity.keyId}";alg="ed25519";nonce="${nonce}";tag="http-message-signatures-directory"`;
			const base = `"@authority";req: ${authority}\n"@signature-params": ${input}`;
			const signature = base64(await crypto.subtle.sign("Ed25519", identity.privateKey, encoder.encode(base)));
			return new Response(request.method === "HEAD" ? null : identity.body, { headers: {
				...headers, "Content-Type": "application/http-message-signatures-directory+json",
				"Signature-Input": `sig1=${input}`, Signature: `sig1=:${signature}:`,
			} });
		} catch {
			return new Response("Identity directory is not configured", { status: 503, headers });
		}
	},
};
