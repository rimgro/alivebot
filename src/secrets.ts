/**
 * Secret masking at the boundaries where text leaves the process.
 *
 * Everything here is a pure string transformation: no filesystem, no network,
 * and no mutation of stored history or agent memory. The only ambient input is
 * `process.env` (unless an explicit environment is passed), which is what lets
 * unknown provider key formats be caught by value.
 */

export interface SecretsConfig {
	/** Mask values of `process.env` entries whose name looks secret-ish. */
	maskEnv: boolean;
	/** Extra regular-expression sources for project-specific secret formats. */
	extraPatterns: string[];
}

export const DEFAULT_SECRETS_CONFIG: SecretsConfig = {
	maskEnv: true,
	extraPatterns: [],
};

/**
 * Validate the `secrets` config block. Extra patterns are compiled eagerly so a
 * bad operator regex fails at startup, not silently at log time.
 */
export function validateSecretsConfig(value: SecretsConfig): SecretsConfig {
	if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("secrets must be an object");
	if (typeof value.maskEnv !== "boolean") throw new Error("secrets.maskEnv must be boolean");
	if (!Array.isArray(value.extraPatterns)) throw new Error("secrets.extraPatterns must be an array of strings");
	const extraPatterns = value.extraPatterns.map((source, index) => {
		if (typeof source !== "string") throw new Error(`secrets.extraPatterns[${index}] must be a string`);
		try {
			new RegExp(source, "g");
		} catch (err) {
			throw new Error(`secrets.extraPatterns[${index}] is not a valid RegExp: ${errorMessage(err)}`);
		}
		return source;
	});
	return { maskEnv: value.maskEnv, extraPatterns };
}

const ENV_SECRET_NAME = /(TOKEN|SECRET|PASSWORD|PASS|KEY|CREDENTIAL)/i;
const MIN_ENV_SECRET_LENGTH = 8;
const KEEP_HEAD = 3;
const KEEP_TAIL = 2;

/** A masked value keeps at most 5 characters of the secret (first 3 + last 2). */
function maskLiteral(label: string, value: string): string {
	if (value.length <= KEEP_HEAD + KEEP_TAIL) return `[${label}:…]`;
	return `[${label}:${value.slice(0, KEEP_HEAD)}…${value.slice(-KEEP_TAIL)}]`;
}

const PEM_BLOCK_RE = /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g;
const URL_CREDENTIALS_RE = /\b(https?:\/\/)([^\s/?#:@]+):([^\s/?#@]+)@/gi;
const AUTHORIZATION_BEARER_RE = /(\bAuthorization\s*:\s*Bearer\s+)([A-Za-z0-9._~+/=-]{16,})/gi;
const BARE_BEARER_RE = /(\bBearer\s+)([A-Za-z0-9._~+/=-]{16,})/g;
const TELEGRAM_TOKEN_RE = /\b\d{6,12}:[A-Za-z0-9_-]{30,}/g;
const GITHUB_PAT_RE = /\bgithub_pat_[A-Za-z0-9_]{20,}/g;
const GITHUB_TOKEN_RE = /\bgh[pousr]_[A-Za-z0-9]{20,}/g;
const ANTHROPIC_KEY_RE = /\bsk-ant-[A-Za-z0-9_-]{16,}/g;
const GROQ_KEY_RE = /\bgsk_[A-Za-z0-9]{20,}/g;
const OPENAI_KEY_RE = /\bsk-[A-Za-z0-9_-]{16,}/g;
const AWS_ACCESS_KEY_RE = /\bAKIA[0-9A-Z]{16}\b/g;
const JWT_RE = /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g;

const STATIC_RULES: ReadonlyArray<(text: string) => string> = [
	// A private key spans lines; mask the whole block before line-based rules.
	(text) => text.replace(PEM_BLOCK_RE, (match) => maskLiteral("pem", match)),
	// Keep the scheme and user, mask the password.
	(text) =>
		text.replace(
			URL_CREDENTIALS_RE,
			(_match, scheme: string, user: string, password: string) =>
				`${scheme}${user}:${maskLiteral("url", password)}@`,
		),
	(text) =>
		text.replace(
			AUTHORIZATION_BEARER_RE,
			(_match, prefix: string, token: string) => `${prefix}${maskLiteral("bearer", token)}`,
		),
	(text) => text.replace(BARE_BEARER_RE, (_match, prefix: string, token: string) => `${prefix}${maskLiteral("bearer", token)}`),
	(text) => text.replace(TELEGRAM_TOKEN_RE, (match) => maskLiteral("telegram", match)),
	(text) => text.replace(GITHUB_PAT_RE, (match) => maskLiteral("github", match)),
	(text) => text.replace(GITHUB_TOKEN_RE, (match) => maskLiteral("github", match)),
	(text) => text.replace(ANTHROPIC_KEY_RE, (match) => maskLiteral("anthropic", match)),
	(text) => text.replace(GROQ_KEY_RE, (match) => maskLiteral("groq", match)),
	(text) => text.replace(OPENAI_KEY_RE, (match) => maskLiteral("openai", match)),
	(text) => text.replace(AWS_ACCESS_KEY_RE, (match) => maskLiteral("aws", match)),
	(text) => text.replace(JWT_RE, (match) => maskLiteral("jwt", match)),
];

interface EnvSecret {
	name: string;
	value: string;
}

function collectEnvSecrets(env: NodeJS.ProcessEnv): EnvSecret[] {
	const secrets: EnvSecret[] = [];
	for (const [name, value] of Object.entries(env)) {
		if (!value || value.length < MIN_ENV_SECRET_LENGTH || !ENV_SECRET_NAME.test(name)) continue;
		secrets.push({ name, value });
	}
	// Longest first so one secret that contains another does not leave a tail.
	secrets.sort((left, right) => right.value.length - left.value.length);
	return secrets;
}

function maskText(text: string, config: SecretsConfig, envSecrets: EnvSecret[]): string {
	if (!text) return text;
	let out = text;
	// Exact env values first: an unknown provider key must not survive because
	// another rule only matched part of it.
	for (const secret of envSecrets) {
		if (!out.includes(secret.value)) continue;
		out = out.split(secret.value).join(maskLiteral("env", secret.value));
	}
	for (const rule of STATIC_RULES) out = rule(out);
	for (const source of config.extraPatterns) {
		out = out.replace(new RegExp(source, "g"), (match) => maskLiteral("custom", match));
	}
	return out;
}

/**
 * Mask secrets in a single string.
 *
 * `config` and `env` are optional so callers that do not have a loaded config
 * (or tests) still get the safe defaults.
 */
export function maskSecrets(
	text: string,
	config: SecretsConfig = DEFAULT_SECRETS_CONFIG,
	env: NodeJS.ProcessEnv = process.env,
): string {
	if (typeof text !== "string" || text.length === 0) return text;
	return maskText(text, config, config.maskEnv ? collectEnvSecrets(env) : []);
}

/**
 * Recursively mask strings in structured logger/tool data: plain objects,
 * arrays, maps, sets and Error fields. Unknown objects are returned as-is.
 */
export function maskValue(
	value: unknown,
	config: SecretsConfig = DEFAULT_SECRETS_CONFIG,
	env: NodeJS.ProcessEnv = process.env,
): unknown {
	return maskAny(value, config, config.maskEnv ? collectEnvSecrets(env) : [], new WeakSet<object>());
}

function maskAny(value: unknown, config: SecretsConfig, envSecrets: EnvSecret[], seen: WeakSet<object>): unknown {
	if (typeof value === "string") return maskText(value, config, envSecrets);
	if (value === null || typeof value !== "object") return value;
	if (value instanceof Date || Buffer.isBuffer(value)) return value;
	if (seen.has(value)) return "[circular]";
	seen.add(value);

	if (value instanceof Error) {
		const out: Record<string, unknown> = {
			name: maskText(value.name, config, envSecrets),
			message: maskText(value.message, config, envSecrets),
		};
		if (value.stack) out.stack = maskText(value.stack, config, envSecrets);
		if (value.cause !== undefined) out.cause = maskAny(value.cause, config, envSecrets, seen);
		for (const [key, entry] of Object.entries(value)) {
			if (!(key in out)) out[key] = maskAny(entry, config, envSecrets, seen);
		}
		return out;
	}
	if (Array.isArray(value)) return value.map((entry) => maskAny(entry, config, envSecrets, seen));
	if (value instanceof Map) {
		return new Map([...value.entries()].map(([key, entry]) => [key, maskAny(entry, config, envSecrets, seen)]));
	}
	if (value instanceof Set) return [...value].map((entry) => maskAny(entry, config, envSecrets, seen));

	const prototype = Object.getPrototypeOf(value);
	if (prototype === Object.prototype || prototype === null) {
		const out: Record<string, unknown> = {};
		for (const [key, entry] of Object.entries(value)) out[key] = maskAny(entry, config, envSecrets, seen);
		return out;
	}
	return value;
}

function errorMessage(err: unknown): string {
	return err instanceof Error ? err.message : String(err);
}
