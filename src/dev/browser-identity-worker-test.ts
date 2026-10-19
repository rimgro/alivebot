import assert from "node:assert/strict";
import { createHash, generateKeyPairSync, verify } from "node:crypto";
import worker, { type WorkerIdentityEnv } from "../modules/browser/identity-worker.js";

const { privateKey, publicKey } = generateKeyPairSync("ed25519");
const env: WorkerIdentityEnv = {
	AGENT_ORIGIN: "https://alive-identity.example.workers.dev",
	PUBLIC_JWK: JSON.stringify(publicKey.export({ format: "jwk" })),
	PRIVATE_KEY_PKCS8: privateKey.export({ type: "pkcs8", format: "der" }).toString("base64"),
};
const url = `${env.AGENT_ORIGIN}/.well-known/http-message-signatures-directory`;
const response = await worker.fetch(new Request(url), env);
assert.equal(response.status, 200);
assert.equal(response.headers.get("content-type"), "application/http-message-signatures-directory+json");
assert.equal(response.headers.get("cache-control"), "no-store");
const body = await response.text();
const jwk = JSON.parse(body).keys[0];
assert.deepEqual(Object.keys(jwk).sort(), ["crv", "kty", "x"]);
assert.ok(!body.includes(env.PRIVATE_KEY_PKCS8));
const input = response.headers.get("signature-input")!.slice("sig1=".length);
const signature = response.headers.get("signature")!.match(/^sig1=:(.*):$/)![1];
const base = `"@authority";req: ${new URL(url).host}\n"@signature-params": ${input}`;
assert.equal(verify(null, Buffer.from(base), publicKey, Buffer.from(signature, "base64")), true);
assert.match(input, /\("@authority";req\)/);
assert.ok(input.includes(`keyid="${createHash("sha256").update(JSON.stringify(jwk)).digest("base64url")}"`));
const created = Number(input.match(/created=(\d+)/)![1]), expires = Number(input.match(/expires=(\d+)/)![1]);
assert.equal(expires - created, 60);
assert.ok(Math.abs(Date.now() / 1000 - created) < 2);
assert.notEqual((await worker.fetch(new Request(url), env)).headers.get("signature"), response.headers.get("signature"));
assert.equal((await worker.fetch(new Request(url, { method: "HEAD" }), env)).status, 200);
assert.equal((await worker.fetch(new Request(url, { method: "POST" }), env)).status, 405);
assert.equal((await worker.fetch(new Request(`${env.AGENT_ORIGIN}/browser`), env)).status, 404);
assert.equal((await worker.fetch(new Request(url.replace("alive-identity", "unrelated")), env)).status, 421);
assert.equal((await worker.fetch(new Request(url, { headers: { host: "other.example" } }), env)).status, 421);
const other = generateKeyPairSync("ed25519");
assert.equal((await worker.fetch(new Request(url), { ...env, PUBLIC_JWK: JSON.stringify(other.publicKey.export({ format: "jwk" })) })).status, 503);
assert.equal((await worker.fetch(new Request(url), { ...env, PUBLIC_JWK: JSON.stringify(privateKey.export({ format: "jwk" })) })).status, 503);
console.log("Identity Worker tests passed: independent Ed25519 verification, authority binding, public-only JWKS, fresh signatures, key consistency and method boundaries.");
