# Stable Web Bot Auth directory on workers.dev

This optional Worker hosts only the signed public-key directory. It provides a stable HTTPS identity origin without buying a domain or hosting the browser in Cloudflare. The phone control endpoint remains on the machine running Alive and can use a separate HTTPS address.

The Worker uses the same Ed25519 identity as Alive. Cloudflare stores a copy of the signing key in a Worker **secret**, so control of that secret allows signing this identity. It has no Telegram token, browser profile, model credentials or browser-control endpoint. Public requests cannot choose what is signed: the only signature is the directory response bound to the configured authority. Use a dedicated key for this identity and rotate both deployments together.

Prepare Alive and the public configuration (replace the account subdomain/ID):

```sh
npm run browser -- setup --identity-url https://alive-browser-identity.YOUR_SUBDOMAIN.workers.dev --sign-origins https://crawltest.com
node deploy/browser/identity-worker/configure.mjs https://alive-browser-identity.YOUR_SUBDOMAIN.workers.dev YOUR_ACCOUNT_ID
```

The configuration is saved to the gitignored `.alive/identity-worker/wrangler.json`, without private key material. The key path is retained in the gitignored `.env`. The setup command does not deploy or register anything. Configure the separate phone endpoint with `--public-url` when available; changing it does not rotate the identity.

After the operator authorizes Cloudflare hosting, use official Wrangler 4.148.0:

```sh
npx wrangler@4.148.0 login --scopes account:read workers_scripts:write
npx wrangler@4.148.0 deploy --config .alive/identity-worker/wrangler.json
node deploy/browser/identity-worker/configure.mjs --secret-stdin | npx wrangler@4.148.0 secret put PRIVATE_KEY_PKCS8 --config .alive/identity-worker/wrangler.json
npm run browser -- doctor --online
```

Wrangler also requests `offline_access` to refresh its authorization. Authorize these three permissions only after reviewing them; the older `workers:write` scope does not authorize the current script deployment API. Access can be revoked under Cloudflare **My Profile → Access Management → Connected Applications**.

Run the secret command only as the shown pipeline; never print or paste its output into chat. Until the secret is installed, the directory returns 503. Local cryptographic tests use disposable keys and no Cloudflare account: `npm run test:browser:identity-worker`.

Submit the exact directory URL `https://alive-browser-identity.YOUR_SUBDOMAIN.workers.dev/.well-known/http-message-signatures-directory` with Web Bot Auth in [Cloudflare's bot application](https://dash.cloudflare.com/?to=/:account/configurations/verified-bots). The current dashboard redirects this link to **Application security → BotBase → Submission form**. Register your own deployed instance and state its actual operator, categories and content use. Cloudflare approval is separate from successful deployment or a format-valid 401 at the crawltest endpoint.

The Worker validates matching private/public keys, exports only public JWK fields, rejects unexpected authorities, and generates fresh 60-second directory signatures. No DNS records or existing Workers need to be changed.
