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
/** Values shorter than this get the generic `custom` label instead of a type. */
const SHORT_SECRET_LENGTH = 8;

/**
 * Per-masking-context id table.
 *
 * One context is created per log line, per outgoing message, or per rendered
 * prompt. Inside it the same secret value always maps to the same `#n`, while
 * distinct values get distinct ids in order of first appearance.
 */
export class MaskContext {
	private readonly values = new Map<string, { label: string; id: number }>();
	private nextId = 1;

	/** Render one secret occurrence; repeated values reuse their id and label. */
	mask(label: string, value: string): string {
		const existing = this.values.get(value);
		if (existing) return `[${existing.label}#${existing.id}]`;
		const safeLabel = value.length < SHORT_SECRET_LENGTH ? "custom" : label;
		const id = this.nextId++;
		this.values.set(value, { label: safeLabel, id });
		return `[${safeLabel}#${id}]`;
	}
}

export function createMaskContext(): MaskContext {
	return new MaskContext();
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

interface SecretMatch {
	start: number;
	end: number;
	value: string;
	label: string;
	/** 0 = env literal, 1 = built-in format, 2 = operator pattern. */
	priority: number;
}

interface RegexDetector {
	label: string;
	regex: RegExp;
	/** The part of the match that is the secret (defaults to the whole match). */
	extract?: (match: RegExpExecArray) => { value: string; start: number };
}

const STATIC_DETECTORS: ReadonlyArray<RegexDetector> = [
	{ label: "pem", regex: PEM_BLOCK_RE },
	{
		label: "url-credentials",
		regex: URL_CREDENTIALS_RE,
		extract: (match) => {
			const password = match[3] ?? "";
			return {
				value: password,
				start: match.index + (match[1]?.length ?? 0) + (match[2]?.length ?? 0) + 1,
			};
		},
	},
	{
		label: "bearer",
		regex: AUTHORIZATION_BEARER_RE,
		extract: (match) => ({
			value: match[2] ?? "",
			start: match.index + (match[1]?.length ?? 0),
		}),
	},
	{
		label: "bearer",
		regex: BARE_BEARER_RE,
		extract: (match) => ({
			value: match[2] ?? "",
			start: match.index + (match[1]?.length ?? 0),
		}),
	},
	{ label: "telegram-bot", regex: TELEGRAM_TOKEN_RE },
	{ label: "github", regex: GITHUB_PAT_RE },
	{ label: "github", regex: GITHUB_TOKEN_RE },
	{ label: "anthropic", regex: ANTHROPIC_KEY_RE },
	{ label: "groq", regex: GROQ_KEY_RE },
	{ label: "openai", regex: OPENAI_KEY_RE },
	{ label: "aws", regex: AWS_ACCESS_KEY_RE },
	{ label: "jwt", regex: JWT_RE },
];

interface EnvSecret {
	name: string;
	value: string;
}

function collectEnvSecrets(env: NodeJS.ProcessEnv): EnvSecret[] {
	const secrets: EnvSecret[] = [];
	for (const [name, value] of Object.entries(env)) {
		if (!value || value.length < SHORT_SECRET_LENGTH || !ENV_SECRET_NAME.test(name)) continue;
		secrets.push({ name, value });
	}
	// Longest first so one secret that contains another does not leave a tail.
	secrets.sort((left, right) => right.value.length - left.value.length);
	return secrets;
}

function collectRegexMatches(detector: RegexDetector, text: string, out: SecretMatch[]): void {
	const regex = detector.regex;
	regex.lastIndex = 0;
	let match: RegExpExecArray | null;
	while ((match = regex.exec(text)) !== null) {
		if (match[0].length === 0) {
			regex.lastIndex += 1;
			continue;
		}
		const extracted = detector.extract
			? detector.extract(match)
			: { value: match[0], start: match.index };
		if (extracted.value.length === 0) continue;
		out.push({
			start: extracted.start,
			end: extracted.start + extracted.value.length,
			value: extracted.value,
			label: detector.label,
			priority: 1,
		});
	}
	regex.lastIndex = 0;
}

function collectEnvMatches(text: string, envSecrets: EnvSecret[], out: SecretMatch[]): void {
	for (const secret of envSecrets) {
		let from = 0;
		while (from <= text.length) {
			const start = text.indexOf(secret.value, from);
			if (start < 0) break;
			out.push({
				start,
				end: start + secret.value.length,
				value: secret.value,
				label: `env:${secret.name}`,
				priority: 0,
			});
			from = start + secret.value.length;
		}
	}
}

function collectExtraMatches(text: string, config: SecretsConfig, out: SecretMatch[]): void {
	for (const source of config.extraPatterns) {
		const regex = new RegExp(source, "g");
		let match: RegExpExecArray | null;
		while ((match = regex.exec(text)) !== null) {
			if (match[0].length === 0) {
				regex.lastIndex += 1;
				continue;
			}
			out.push({
				start: match.index,
				end: match.index + match[0].length,
				value: match[0],
				label: "custom",
				priority: 2,
			});
		}
	}
}

/** Keep the earliest, most specific matches and close overlaps so no tail leaks. */
function selectMatches(matches: SecretMatch[]): SecretMatch[] {
	matches.sort(
		(left, right) =>
			left.start - right.start ||
			left.priority - right.priority ||
			right.end - right.start - (left.end - left.start),
	);
	const selected: SecretMatch[] = [];
	for (const match of matches) {
		const previous = selected[selected.length - 1];
		if (!previous || match.start >= previous.end) {
			selected.push({ ...match });
			continue;
		}
		// Overlapping detections: extend the earlier mask over the union. The
		// earlier secret keeps its id, and no character of either value survives.
		if (match.end > previous.end) previous.end = match.end;
	}
	return selected;
}

function maskText(text: string, config: SecretsConfig, envSecrets: EnvSecret[], context: MaskContext): string {
	if (!text) return text;
	const matches: SecretMatch[] = [];
	if (config.maskEnv) collectEnvMatches(text, envSecrets, matches);
	for (const detector of STATIC_DETECTORS) collectRegexMatches(detector, text, matches);
	collectExtraMatches(text, config, matches);
	if (matches.length === 0) return text;

	const selected = selectMatches(matches);
	let out = "";
	let cursor = 0;
	for (const match of selected) {
		if (match.start < cursor) continue;
		out += text.slice(cursor, match.start);
		out += context.mask(match.label, match.value);
		cursor = match.end;
	}
	return out + text.slice(cursor);
}

/**
 * Mask secrets in a single string.
 *
 * `config`, `env` and `context` are optional so callers that do not have a
 * loaded config (or tests) still get the safe defaults. Pass the same
 * `MaskContext` across several strings to keep ids stable within one log line,
 * message or prompt.
 */
export function maskSecrets(text: string, context: MaskContext): string;
export function maskSecrets(
	text: string,
	config?: SecretsConfig,
	env?: NodeJS.ProcessEnv,
	context?: MaskContext,
): string;
export function maskSecrets(
	text: string,
	configOrContext: SecretsConfig | MaskContext = DEFAULT_SECRETS_CONFIG,
	env: NodeJS.ProcessEnv = process.env,
	context?: MaskContext,
): string {
	if (typeof text !== "string" || text.length === 0) return text;
	const config = configOrContext instanceof MaskContext ? DEFAULT_SECRETS_CONFIG : configOrContext;
	const activeContext = configOrContext instanceof MaskContext ? configOrContext : context ?? new MaskContext();
	return maskText(text, config, config.maskEnv ? collectEnvSecrets(env) : [], activeContext);
}

/**
 * Recursively mask strings in structured logger/tool data: plain objects,
 * arrays, maps, sets and Error fields. Unknown objects are returned as-is.
 */
export function maskValue(value: unknown, context: MaskContext): unknown;
export function maskValue(
	value: unknown,
	config?: SecretsConfig,
	env?: NodeJS.ProcessEnv,
	context?: MaskContext,
): unknown;
export function maskValue(
	value: unknown,
	configOrContext: SecretsConfig | MaskContext = DEFAULT_SECRETS_CONFIG,
	env: NodeJS.ProcessEnv = process.env,
	context?: MaskContext,
): unknown {
	const config = configOrContext instanceof MaskContext ? DEFAULT_SECRETS_CONFIG : configOrContext;
	const activeContext = configOrContext instanceof MaskContext ? configOrContext : context ?? new MaskContext();
	return maskAny(value, config, config.maskEnv ? collectEnvSecrets(env) : [], activeContext, new WeakSet<object>());
}

function maskAny(
	value: unknown,
	config: SecretsConfig,
	envSecrets: EnvSecret[],
	context: MaskContext,
	seen: WeakSet<object>,
): unknown {
	if (typeof value === "string") return maskText(value, config, envSecrets, context);
	if (value === null || typeof value !== "object") return value;
	if (value instanceof Date || Buffer.isBuffer(value)) return value;
	if (seen.has(value)) return "[circular]";
	seen.add(value);

	if (value instanceof Error) {
		const out: Record<string, unknown> = {
			name: maskText(value.name, config, envSecrets, context),
			message: maskText(value.message, config, envSecrets, context),
		};
		if (value.stack) out.stack = maskText(value.stack, config, envSecrets, context);
		if (value.cause !== undefined) out.cause = maskAny(value.cause, config, envSecrets, context, seen);
		for (const [key, entry] of Object.entries(value)) {
			if (!(key in out)) out[key] = maskAny(entry, config, envSecrets, context, seen);
		}
		return out;
	}
	if (Array.isArray(value)) return value.map((entry) => maskAny(entry, config, envSecrets, context, seen));
	if (value instanceof Map) {
		return new Map([...value.entries()].map(([key, entry]) => [key, maskAny(entry, config, envSecrets, context, seen)]));
	}
	if (value instanceof Set) return [...value].map((entry) => maskAny(entry, config, envSecrets, context, seen));

	const prototype = Object.getPrototypeOf(value);
	if (prototype === Object.prototype || prototype === null) {
		const out: Record<string, unknown> = {};
		for (const [key, entry] of Object.entries(value)) out[key] = maskAny(entry, config, envSecrets, context, seen);
		return out;
	}
	return value;
}

function errorMessage(err: unknown): string {
	return err instanceof Error ? err.message : String(err);
}
