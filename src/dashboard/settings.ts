/**
 * The dashboard's only write path: editing a profile's settings.
 *
 * The page edits two kinds of files, both strictly inside the selected profile:
 *
 * - `alive.config.json`: a JSON document with the effective, operator-owned
 *   settings that are worth editing (model, tool allowlist, worker/sandbox/
 *   browser permission flags). The submitted document is `JSON.parse`d, checked
 *   against an explicit schema (unknown fields are rejected), diffed against the
 *   *effective* config so unchanged defaults are never pinned into the file, and
 *   the merged result is run through the project's own validators
 *   (`validateWorkersConfig`, `validateSandboxConfig`, `validateSecretsConfig`,
 *   `validateToolAllowlist`) before anything is written.
 * - the prompt files (`SOUL.md`, `CONTRACT.md`, `summary.md`), whose real paths
 *   come from `LoadedConfig.paths` — never from hardcoded names — and are
 *   refused when they resolve outside the profile directory.
 *
 * Every write is preceded by a copy of the previous version into
 * `<profile state dir>/dashboard-backups/<file>-<stamp>.bak`, keeping the last
 * `DASHBOARD_BACKUP_KEEP`. Validation happens before the first write, so a
 * rejected request leaves the profile untouched.
 *
 * Nothing here executes commands or follows symlinks out of the profile.
 */
import { randomBytes, timingSafeEqual } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import { validateToolAllowlist } from "../agents.js";
import type { AliveConfig } from "../config.js";
import { formatFieldPath, isSecretKey } from "../config-secrets.js";
import { validateSandboxConfig } from "../sandbox/config.js";
import { createMaskContext, maskSecrets, validateSecretsConfig, type SecretsConfig } from "../secrets.js";
import { validateWorkersConfig, type WorkerPermissions } from "../workers/config.js";
import type { DashboardProfile } from "./state.js";

/** Backups live here, relative to the profile's state directory. */
export const DASHBOARD_BACKUPS_DIR = "dashboard-backups";
/** How many previous versions of one file are kept. */
export const DASHBOARD_BACKUP_KEEP = 20;
/** Hard cap for the urlencoded POST body (and for the config/prompt text in it). */
export const DASHBOARD_MAX_BODY_BYTES = 1024 * 1024;
/** Prompt files are capped for display only; the full file is still compared. */
export const DASHBOARD_MAX_PROMPT_CHARS = 200_000;
/** CSRF tokens are per-render, single-use and short-lived. */
export const DASHBOARD_CSRF_TTL_MS = 2 * 60 * 60_000;
const DASHBOARD_CSRF_MAX_TOKENS = 256;
/** Machine-local overrides next to the profile config; their presence disables config edits. */
const LOCAL_CONFIG_NAME = "alive.config.local.json";

/**
 * A rejected edit: `status` is the HTTP status the server must answer with.
 * The message is rendered through the masker like every other string.
 */
export class SettingsEditError extends Error {
	readonly status: number;

	constructor(status: number, message: string) {
		super(message);
		this.name = "SettingsEditError";
		this.status = status;
	}
}

// ---------------------------------------------------------------------------
// CSRF tokens
// ---------------------------------------------------------------------------

interface CsrfEntry {
	agentId: string;
	token: string;
	issuedAt: number;
}

/**
 * In-memory, per-server CSRF token table.
 *
 * A token is issued on every settings page render, is bound to one agent id,
 * expires, and is consumed by the first POST that presents it. Comparison is
 * timing-safe (`timingSafeEqual`) over every live entry, so a rejected token
 * does not leak a matching prefix through timing.
 */
export class CsrfTokenStore {
	private readonly entries = new Map<string, CsrfEntry>();

	constructor(
		private readonly ttlMs = DASHBOARD_CSRF_TTL_MS,
		private readonly maxTokens = DASHBOARD_CSRF_MAX_TOKENS,
	) {}

	issue(agentId: string, now = Date.now()): string {
		this.prune(now);
		const token = randomBytes(32).toString("base64url");
		this.entries.set(token, { agentId, token, issuedAt: now });
		while (this.entries.size > this.maxTokens) {
			const oldest = this.entries.keys().next();
			if (oldest.done) break;
			this.entries.delete(oldest.value);
		}
		return token;
	}

	/** True when `token` exists, belongs to `agentId`, is fresh — and consumes it. */
	consume(agentId: string, token: string, now = Date.now()): boolean {
		this.prune(now);
		if (!token) return false;
		let match: CsrfEntry | undefined;
		for (const entry of this.entries.values()) {
			if (!timingSafeEqualString(entry.token, token)) continue;
			match = entry;
		}
		if (!match) return false;
		this.entries.delete(match.token);
		return match.agentId === agentId;
	}

	private prune(now: number): void {
		for (const [token, entry] of this.entries) {
			if (now - entry.issuedAt > this.ttlMs) this.entries.delete(token);
		}
	}
}

function timingSafeEqualString(left: string, right: string): boolean {
	const leftBuffer = Buffer.from(left, "utf8");
	const rightBuffer = Buffer.from(right, "utf8");
	// Length is not secret (tokens are fixed-size base64url), the content is.
	if (leftBuffer.length !== rightBuffer.length) return false;
	return timingSafeEqual(leftBuffer, rightBuffer);
}

// ---------------------------------------------------------------------------
// editable config document
// ---------------------------------------------------------------------------

/** The only config fields the dashboard may change, as a partial patch. */
export interface EditableConfigDoc {
	model?: string;
	tools?: { allowlist?: string[]; bash?: boolean };
	workers?: {
		enabled?: boolean;
		permissions?: Partial<WorkerPermissions>;
		models?: string[];
		defaultModel?: string;
	};
	sandbox?: { enabled?: boolean; network?: boolean; networkAccess?: "public" | "unrestricted" };
	modules?: { browser?: { enabled?: boolean } };
}

const WORKER_PERMISSION_KEYS = ["spawn", "send", "stop", "inspect", "worktree", "pullRequest"] as const;
const DOC_ROOT_KEYS = ["model", "tools", "workers", "sandbox", "modules"] as const;
const DOC_TOOLS_KEYS = ["allowlist", "bash"] as const;
const DOC_WORKERS_KEYS = ["enabled", "permissions", "models", "defaultModel"] as const;
const DOC_SANDBOX_KEYS = ["enabled", "network", "networkAccess"] as const;
const DOC_MODULES_KEYS = ["browser"] as const;
const DOC_BROWSER_KEYS = ["enabled"] as const;
const MAX_MODEL_SPEC_CHARS = 200;

function isPlainObject(value: unknown): value is Record<string, unknown> {
	if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
	const prototype = Object.getPrototypeOf(value);
	return prototype === Object.prototype || prototype === null;
}

function plainObject(value: unknown, at: string): Record<string, unknown> {
	if (!isPlainObject(value)) throw new SettingsEditError(400, `config.${at} must be a JSON object`);
	return value;
}

function assertKnownKeys(value: Record<string, unknown>, allowed: readonly string[], at: string): void {
	for (const key of Object.keys(value)) {
		if (!allowed.includes(key)) {
			const where = at ? `${at}.${key}` : key;
			throw new SettingsEditError(400, `unknown config field: ${where} (editable fields: ${allowed.join(", ")})`);
		}
	}
}

function assertBoolean(value: unknown, at: string): boolean {
	if (typeof value !== "boolean") throw new SettingsEditError(400, `config.${at} must be true or false`);
	return value;
}

function assertString(value: unknown, at: string): string {
	if (typeof value !== "string") throw new SettingsEditError(400, `config.${at} must be a string`);
	if (value.includes("\0")) throw new SettingsEditError(400, `config.${at} must not contain NUL bytes`);
	return value;
}

function assertStringArray(value: unknown, at: string): string[] {
	if (!Array.isArray(value)) throw new SettingsEditError(400, `config.${at} must be an array of strings`);
	return value.map((entry, index) => assertString(entry, `${at}[${index}]`));
}

/**
 * Parse and type-check the submitted settings document.
 *
 * Unknown fields are rejected at every level instead of being written into the
 * config: a typo must not silently travel to disk.
 */
export function validateEditableConfigDoc(input: unknown): EditableConfigDoc {
	const root = plainObject(input, "(root)");
	assertKnownKeys(root, DOC_ROOT_KEYS, "");
	const doc: EditableConfigDoc = {};

	if (root.model !== undefined) {
		const model = assertString(root.model, "model").trim();
		if (model.length > MAX_MODEL_SPEC_CHARS || /\s/.test(model)) {
			throw new SettingsEditError(
				400,
				`config.model must be a single model spec without whitespace (e.g. "anthropic/claude-sonnet-4-5:high")`,
			);
		}
		doc.model = model;
	}

	if (root.tools !== undefined) {
		const tools = plainObject(root.tools, "tools");
		assertKnownKeys(tools, DOC_TOOLS_KEYS, "tools");
		const out: NonNullable<EditableConfigDoc["tools"]> = {};
		if (tools.allowlist !== undefined) out.allowlist = assertStringArray(tools.allowlist, "tools.allowlist");
		if (tools.bash !== undefined) out.bash = assertBoolean(tools.bash, "tools.bash");
		doc.tools = out;
	}

	if (root.workers !== undefined) {
		const workers = plainObject(root.workers, "workers");
		assertKnownKeys(workers, DOC_WORKERS_KEYS, "workers");
		const out: NonNullable<EditableConfigDoc["workers"]> = {};
		if (workers.enabled !== undefined) out.enabled = assertBoolean(workers.enabled, "workers.enabled");
		if (workers.models !== undefined) out.models = assertStringArray(workers.models, "workers.models");
		if (workers.defaultModel !== undefined) {
			out.defaultModel = assertString(workers.defaultModel, "workers.defaultModel").trim();
		}
		if (workers.permissions !== undefined) {
			const permissions = plainObject(workers.permissions, "workers.permissions");
			assertKnownKeys(permissions, WORKER_PERMISSION_KEYS, "workers.permissions");
			const flags: Partial<WorkerPermissions> = {};
			for (const key of WORKER_PERMISSION_KEYS) {
				if (permissions[key] !== undefined) {
					flags[key] = assertBoolean(permissions[key], `workers.permissions.${key}`);
				}
			}
			out.permissions = flags;
		}
		doc.workers = out;
	}

	if (root.sandbox !== undefined) {
		const sandbox = plainObject(root.sandbox, "sandbox");
		assertKnownKeys(sandbox, DOC_SANDBOX_KEYS, "sandbox");
		const out: NonNullable<EditableConfigDoc["sandbox"]> = {};
		if (sandbox.enabled !== undefined) out.enabled = assertBoolean(sandbox.enabled, "sandbox.enabled");
		if (sandbox.network !== undefined) out.network = assertBoolean(sandbox.network, "sandbox.network");
		if (sandbox.networkAccess !== undefined) {
			const access = assertString(sandbox.networkAccess, "sandbox.networkAccess");
			if (access !== "public" && access !== "unrestricted") {
				throw new SettingsEditError(400, 'config.sandbox.networkAccess must be "public" or "unrestricted"');
			}
			out.networkAccess = access;
		}
		doc.sandbox = out;
	}

	if (root.modules !== undefined) {
		const modules = plainObject(root.modules, "modules");
		assertKnownKeys(modules, DOC_MODULES_KEYS, "modules");
		const out: NonNullable<EditableConfigDoc["modules"]> = {};
		if (modules.browser !== undefined) {
			const browser = plainObject(modules.browser, "modules.browser");
			assertKnownKeys(browser, DOC_BROWSER_KEYS, "modules.browser");
			out.browser = {};
			if (browser.enabled !== undefined) {
				out.browser.enabled = assertBoolean(browser.enabled, "modules.browser.enabled");
			}
		}
		doc.modules = out;
	}

	return doc;
}

/** The editable subset of the *effective* config, as rendered into the form. */
export function effectiveConfigDoc(config: AliveConfig): EditableConfigDoc {
	return {
		model: config.model,
		tools: { allowlist: [...config.tools.allowlist], bash: config.tools.bash },
		workers: {
			enabled: config.workers.enabled,
			permissions: { ...config.workers.permissions },
			models: [...config.workers.models],
			defaultModel: config.workers.defaultModel,
		},
		sandbox: {
			enabled: config.sandbox.enabled,
			network: config.sandbox.network,
			networkAccess: config.sandbox.networkAccess,
		},
		modules: { browser: { enabled: config.modules.browser?.enabled === true } },
	};
}

export interface ConfigChange {
	path: string[];
	before: unknown;
	after: unknown;
}

function docLeaves(value: unknown, segments: string[], out: Array<{ path: string[]; value: unknown }>): void {
	if (isPlainObject(value)) {
		for (const [key, entry] of Object.entries(value)) docLeaves(entry, [...segments, key], out);
		return;
	}
	if (segments.length > 0) out.push({ path: segments, value });
}

function valueAtPath(value: unknown, segments: string[]): unknown {
	let current: unknown = value;
	for (const segment of segments) {
		if (!isPlainObject(current)) return undefined;
		current = current[segment];
	}
	return current;
}

/**
 * Compare the submitted document with the effective config.
 *
 * Only leaves present in the submission are considered, and only leaves whose
 * value actually differs become changes — saving an untouched form never
 * writes defaults into `alive.config.json`.
 */
export function diffConfigDocs(before: EditableConfigDoc, after: EditableConfigDoc): ConfigChange[] {
	const leaves: Array<{ path: string[]; value: unknown }> = [];
	docLeaves(after, [], leaves);
	const changes: ConfigChange[] = [];
	for (const leaf of leaves) {
		const previous = valueAtPath(before, leaf.path);
		if (JSON.stringify(previous) === JSON.stringify(leaf.value)) continue;
		changes.push({ path: leaf.path, before: previous, after: leaf.value });
	}
	return changes;
}

function setAtPath(root: Record<string, unknown>, segments: string[], value: unknown): void {
	let current = root;
	for (let index = 0; index < segments.length - 1; index += 1) {
		const key = segments[index]!;
		const next = current[key];
		if (next === undefined) {
			const created: Record<string, unknown> = {};
			current[key] = created;
			current = created;
			continue;
		}
		if (!isPlainObject(next)) {
			throw new SettingsEditError(
				400,
				`cannot edit ${segments.join(".")}: the config file has a non-object value at ${segments.slice(0, index + 1).join(".")}`,
			);
		}
		current = next;
	}
	current[segments[segments.length - 1]!] = value;
}

/**
 * Run the project's own validators over a candidate config.
 *
 * This is the same set `loadConfig` applies to the merged config, so a value the
 * runtime would refuse at startup is refused here, before it reaches disk.
 */
export function validateEffectiveConfig(config: AliveConfig): void {
	try {
		validateSandboxConfig(config.sandbox);
		validateWorkersConfig(config.workers);
		validateSecretsConfig(config.secrets);
		validateToolAllowlist(config.tools.allowlist);
	} catch (error) {
		throw new SettingsEditError(400, error instanceof Error ? error.message : String(error));
	}
	if (typeof config.tools.bash !== "boolean") throw new SettingsEditError(400, "tools.bash must be boolean");
}

// ---------------------------------------------------------------------------
// secrets
// ---------------------------------------------------------------------------

interface DocLeaf {
	path: string[];
	key: string;
	value: unknown;
}

/**
 * Field paths in the submitted document that look like secrets.
 *
 * Two independent checks, both reusing `config-secrets`/`secrets` logic:
 * a secret-looking key name (`isSecretKey`), and a value the project masker
 * would redact (built-in token formats plus the profile's `secrets.extraPatterns`).
 * Process environment values are deliberately not consulted: a model name that
 * happens to equal an unrelated env secret is not a secret.
 */
export function findSecretLikeValues(doc: EditableConfigDoc, secrets: SecretsConfig): string[] {
	const leaves: DocLeaf[] = [];
	const walk = (value: unknown, segments: string[]): void => {
		if (isPlainObject(value)) {
			for (const [key, entry] of Object.entries(value)) {
				if (typeof entry === "string" && entry !== "" && isSecretKey(key)) {
					leaves.push({ path: [...segments, key], key, value: entry });
					continue;
				}
				walk(entry, [...segments, key]);
			}
			return;
		}
		if (segments.length === 0) return;
		leaves.push({ path: segments, key: segments[segments.length - 1]!, value });
	};
	walk(doc, []);

	const hits: string[] = [];
	for (const leaf of leaves) {
		if (typeof leaf.value !== "string" || leaf.value === "") continue;
		const masked = maskSecrets(
			leaf.value,
			{ maskEnv: false, extraPatterns: secrets.extraPatterns },
			{},
			createMaskContext(),
		);
		if (masked !== leaf.value) hits.push(formatFieldPath(leaf.path));
	}
	return [...new Set(hits)];
}

function secretsHint(profile: DashboardProfile): string {
	const envPath = path.join(path.dirname(profile.configPath), ".env");
	return `put it in ${envPath} (chmod 600) and point the config at the variable with a matching *Env field`;
}

// ---------------------------------------------------------------------------
// profiles, prompts and path containment
// ---------------------------------------------------------------------------

export const PROMPT_KEYS = ["soul", "contract", "summary"] as const;
export type PromptKey = (typeof PROMPT_KEYS)[number];

const PROMPT_SPECS: Record<PromptKey, { field: string; label: string; path: (profile: DashboardProfile) => string }> = {
	soul: { field: "prompt:soul", label: "SOUL.md", path: (profile) => profile.config.paths.soulPath },
	contract: { field: "prompt:contract", label: "CONTRACT.md", path: (profile) => profile.config.paths.contractPath },
	summary: { field: "prompt:summary", label: "summary.md", path: (profile) => profile.config.paths.summaryPath },
};

/** True when `target` is a file inside `root` (the root itself does not count). */
export function isInsideDirectory(root: string, target: string): boolean {
	const relative = path.relative(path.resolve(root), path.resolve(target));
	if (relative === "" || path.isAbsolute(relative)) return false;
	return relative !== ".." && !relative.startsWith(`..${path.sep}`);
}

/** True when `target` is `root` or a path inside it. */
function isWithinOrEqual(root: string, target: string): boolean {
	const relative = path.relative(path.resolve(root), path.resolve(target));
	if (relative === "") return true;
	if (path.isAbsolute(relative)) return false;
	return relative !== ".." && !relative.startsWith(`..${path.sep}`);
}

function realDirectory(directory: string): string {
	try {
		return fs.realpathSync(directory);
	} catch {
		throw new SettingsEditError(400, `refusing to write: directory does not exist: ${directory}`);
	}
}

/**
 * Resolve a writable target inside the profile, with no way through a symlink.
 *
 * The configured path is checked lexically first; then the real parent directory
 * and the real file (if any) are checked again, so a symlinked directory or file
 * cannot be used to land a write outside the profile.
 */
export function resolveWritableTarget(profileDir: string, file: string): string {
	const root = path.resolve(profileDir);
	const target = path.resolve(file);
	if (!isInsideDirectory(root, target)) {
		throw new SettingsEditError(
			400,
			`refusing to write ${target}: it is outside the profile directory ${root}`,
		);
	}
	const realRoot = realDirectory(root);
	const parent = realDirectory(path.dirname(target));
	const resolved = path.join(parent, path.basename(target));
	if (!isInsideDirectory(realRoot, resolved)) {
		throw new SettingsEditError(
			400,
			`refusing to write ${target}: it resolves outside the profile directory ${realRoot}`,
		);
	}
	if (fs.existsSync(resolved) && fs.lstatSync(resolved).isSymbolicLink()) {
		const real = fs.realpathSync(resolved);
		if (!isInsideDirectory(realRoot, real)) {
			throw new SettingsEditError(
				400,
				`refusing to write ${target}: it is a symlink to ${real}, outside the profile directory ${realRoot}`,
			);
		}
		return real;
	}
	return resolved;
}

export function promptPath(profile: DashboardProfile, key: PromptKey): string {
	return PROMPT_SPECS[key].path(profile);
}

export function backupsDirectory(profile: DashboardProfile): string {
	return path.join(profile.stateDir, DASHBOARD_BACKUPS_DIR);
}

/** Why editing is disabled for a profile, or undefined when it is enabled. */
export function settingsDisabledReason(profile: DashboardProfile): string | undefined {
	if (!fs.existsSync(profile.profileDir)) return `profile directory does not exist: ${profile.profileDir}`;
	if (!isInsideDirectory(profile.profileDir, profile.configPath)) {
		return `the config file ${profile.configPath} is outside the profile directory; editing is disabled`;
	}
	if (!isWithinOrEqual(profile.profileDir, profile.stateDir)) {
		return `the state directory ${profile.stateDir} is outside the profile directory; backups cannot be kept safely, editing is disabled`;
	}
	return undefined;
}

/**
 * Why the JSON config textarea is read-only, or undefined when it is editable.
 *
 * A machine-local `alive.config.local.json` overrides the values in
 * `alive.config.json`, so a dashboard edit to the base file could be silently
 * overridden. Refusing is honest; prompt files are still editable.
 */
export function configDisabledReason(profile: DashboardProfile): string | undefined {
	const local = path.join(path.dirname(profile.configPath), LOCAL_CONFIG_NAME);
	if (fs.existsSync(local)) {
		return `${local} exists and overrides ${path.basename(profile.configPath)}; edit the config files by hand`;
	}
	return undefined;
}

// ---------------------------------------------------------------------------
// backups
// ---------------------------------------------------------------------------

export interface DashboardBackup {
	/** Backup file name, e.g. `SOUL.md-20260102T030405123-000.bak`. */
	name: string;
	/** Absolute path of the backup. */
	path: string;
	/** Base name of the file this backup was taken from. */
	originalName: string;
	size: number;
	mtimeMs: number;
}

/** `20260102T030405123Z` — sortable, filesystem-safe, explicitly UTC. */
function backupStamp(now: number): string {
	return new Date(now).toISOString().replace(/[-:.]/g, "");
}

const BACKUP_NAME_RE = /^(.*)-\d{8}T\d{9}Z-\d{3}\.bak$/;

/** Newest last (the names sort chronologically). */
export function listDashboardBackups(profile: DashboardProfile, original?: string): DashboardBackup[] {
	const dir = backupsDirectory(profile);
	let names: string[];
	try {
		names = fs.readdirSync(dir);
	} catch {
		return [];
	}
	const wanted = original === undefined ? undefined : path.basename(original);
	const backups: DashboardBackup[] = [];
	for (const name of names) {
		const parsed = BACKUP_NAME_RE.exec(name);
		if (!parsed) continue;
		const originalName = parsed[1]!;
		if (wanted !== undefined && originalName !== wanted) continue;
		const full = path.join(dir, name);
		let stats: fs.Stats;
		try {
			stats = fs.statSync(full);
		} catch {
			continue;
		}
		if (!stats.isFile()) continue;
		backups.push({ name, path: full, originalName, size: stats.size, mtimeMs: stats.mtimeMs });
	}
	backups.sort((left, right) => left.name.localeCompare(right.name));
	return backups;
}

/**
 * Copy the current version of `file` into the profile's backup directory.
 *
 * Returns the backup path, or undefined when the file does not exist yet (a
 * first-time write has nothing to back up). The directory is created `0700`,
 * backups are `0600`, and only the newest `DASHBOARD_BACKUP_KEEP` per file survive.
 */
export function createDashboardBackup(
	profile: DashboardProfile,
	file: string,
	now = Date.now(),
): string | undefined {
	if (!fs.existsSync(file)) return undefined;
	const dir = path.join(profile.stateDir, DASHBOARD_BACKUPS_DIR);
	if (!isInsideDirectory(profile.profileDir, dir)) {
		throw new SettingsEditError(
			400,
			`refusing to back up ${file}: ${dir} is outside the profile directory ${profile.profileDir}`,
		);
	}
	fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
	const stamp = backupStamp(now);
	let sequence = 0;
	let target = path.join(dir, `${path.basename(file)}-${stamp}-${String(sequence).padStart(3, "0")}.bak`);
	while (fs.existsSync(target)) {
		sequence += 1;
		if (sequence > 999) throw new Error(`too many backups for ${path.basename(file)}`);
		target = path.join(dir, `${path.basename(file)}-${stamp}-${String(sequence).padStart(3, "0")}.bak`);
	}
	fs.copyFileSync(file, target);
	fs.chmodSync(target, 0o600);
	pruneBackups(profile, file);
	return target;
}

function pruneBackups(profile: DashboardProfile, file: string): void {
	const keep = DASHBOARD_BACKUP_KEEP;
	const backups = listDashboardBackups(profile, file);
	for (let index = 0; index < backups.length - keep; index += 1) {
		try {
			fs.unlinkSync(backups[index]!.path);
		} catch {
			// A backup that cannot be pruned is not a reason to fail the edit.
		}
	}
}

function detectJsonIndent(text: string): string {
	const match = text.match(/\n([ \t]+)"/);
	return match?.[1] ?? "\t";
}

function writeFileAtomic(file: string, content: string): void {
	const mode = fs.existsSync(file) ? fs.statSync(file).mode & 0o777 : 0o600;
	const directory = path.dirname(file);
	const temporary = path.join(
		directory,
		`.${path.basename(file)}.tmp-${process.pid}-${randomBytes(4).toString("hex")}`,
	);
	try {
		fs.writeFileSync(temporary, content, { encoding: "utf8", mode });
		fs.chmodSync(temporary, mode);
		fs.renameSync(temporary, file);
	} catch (error) {
		fs.rmSync(temporary, { force: true });
		throw error;
	}
}

// ---------------------------------------------------------------------------
// form parsing
// ---------------------------------------------------------------------------

export interface SettingsSubmission {
	/** Raw JSON text of the editable config document, when the field was posted. */
	configText?: string;
	/** Prompt file bodies, keyed by prompt. Absent fields are left untouched. */
	prompts: Partial<Record<PromptKey, string>>;
}

export const SETTINGS_CSRF_FIELD = "csrf";

const ALLOWED_FORM_FIELDS = new Set<string>([
	SETTINGS_CSRF_FIELD,
	"config",
	...PROMPT_KEYS.map((key) => PROMPT_SPECS[key].field),
]);

/** Reject unknown and duplicated form fields (a duplicated field is a smuggling attempt). */
function assertFormShape(params: URLSearchParams): void {
	for (const key of new Set(params.keys())) {
		if (!ALLOWED_FORM_FIELDS.has(key)) {
			throw new SettingsEditError(
				400,
				`unknown form field "${key}" (allowed: ${[...ALLOWED_FORM_FIELDS].join(", ")})`,
			);
		}
		if (params.getAll(key).length > 1) {
			throw new SettingsEditError(400, `form field "${key}" was sent more than once`);
		}
	}
}

/** The CSRF token from a parsed form; the server checks it before anything else. */
export function readSettingsCsrfToken(params: URLSearchParams): string {
	const values = params.getAll(SETTINGS_CSRF_FIELD);
	return values.length === 1 ? values[0]! : "";
}

/**
 * Turn the urlencoded form into a submission.
 *
 * Browsers submit textareas with CRLF line endings; they are normalised to LF
 * so an untouched file is not rewritten just because the form round-tripped it.
 */
export function parseSettingsSubmission(params: URLSearchParams): SettingsSubmission {
	assertFormShape(params);
	const submission: SettingsSubmission = { prompts: {} };
	const config = params.get("config");
	if (config !== null) submission.configText = config;
	for (const key of PROMPT_KEYS) {
		const value = params.get(PROMPT_SPECS[key].field);
		if (value === null) continue;
		submission.prompts[key] = value.replace(/\r\n/g, "\n");
	}
	if (submission.configText === undefined && Object.keys(submission.prompts).length === 0) {
		throw new SettingsEditError(400, "the form contained no settings: post `config` and/or a prompt field");
	}
	return submission;
}

// ---------------------------------------------------------------------------
// the edit
// ---------------------------------------------------------------------------

export interface SettingsChange {
	kind: "config" | PromptKey;
	label: string;
	file: string;
	backup?: string;
}

export interface SettingsEditResult {
	changed: SettingsChange[];
	/** The profile's backup directory, shown on the page after a successful save. */
	backupsDir: string;
}

interface PlannedWrite {
	kind: "config" | PromptKey;
	label: string;
	file: string;
	content: string;
}

/**
 * Validate the whole submission, then write it — or throw before writing
 * anything. Every check (JSON, schema, secrets, project validators, path
 * containment, writability) runs before the first file is touched.
 */
export function applySettingsEdit(
	profile: DashboardProfile,
	submission: SettingsSubmission,
	options: { now?: number } = {},
): SettingsEditResult {
	const disabled = settingsDisabledReason(profile);
	if (disabled) throw new SettingsEditError(400, disabled);
	const now = options.now ?? Date.now();
	const plan: PlannedWrite[] = [];

	if (submission.configText !== undefined) {
		const configDisabled = configDisabledReason(profile);
		if (configDisabled) throw new SettingsEditError(400, `config is not editable from the dashboard: ${configDisabled}`);
		const configWrite = planConfigWrite(profile, submission.configText);
		if (configWrite) plan.push(configWrite);
	}

	for (const key of PROMPT_KEYS) {
		const content = submission.prompts[key];
		if (content === undefined) continue;
		const spec = PROMPT_SPECS[key];
		const file = resolveWritableTarget(profile.profileDir, spec.path(profile));
		const current = readTextFile(file);
		if (current === content) continue;
		// The page renders secrets masked, so a submitted value equal to the
		// masked file would destroy the real secret. Refuse that round-trip.
		const masked = maskSecrets(
			current,
			{ maskEnv: false, extraPatterns: profile.config.config.secrets.extraPatterns },
			{},
			createMaskContext(),
		);
		if (masked !== current && content === masked) {
			throw new SettingsEditError(
				400,
				`refusing to save ${spec.label}: the page shows its secret as a mask placeholder, and saving it would replace the real value. ` +
					"Edit the file directly on disk (or remove the secret from it) instead.",
			);
		}
		plan.push({ kind: key, label: spec.label, file, content });
	}

	if (plan.length === 0) {
		throw new SettingsEditError(400, "nothing to save: the submitted values are identical to the files on disk");
	}

	// Preflight every target so a permission problem cannot leave a half-applied edit.
	for (const item of plan) {
		const directory = path.dirname(item.file);
		if (!fs.existsSync(directory)) {
			throw new SettingsEditError(400, `refusing to write ${item.file}: directory does not exist`);
		}
		if (fs.existsSync(item.file) && !fs.statSync(item.file).isFile()) {
			throw new SettingsEditError(400, `refusing to write ${item.file}: it is not a regular file`);
		}
		try {
			fs.accessSync(directory, fs.constants.W_OK);
			if (fs.existsSync(item.file)) fs.accessSync(item.file, fs.constants.W_OK);
		} catch {
			throw new SettingsEditError(400, `refusing to write ${item.file}: the file or its directory is not writable`);
		}
	}

	const changed: SettingsChange[] = [];
	for (const item of plan) {
		const backup = createDashboardBackup(profile, item.file, now);
		writeFileAtomic(item.file, item.content);
		changed.push({ kind: item.kind, label: item.label, file: item.file, backup });
	}
	return { changed, backupsDir: backupsDirectory(profile) };
}

function planConfigWrite(profile: DashboardProfile, configText: string): PlannedWrite | undefined {
	let parsed: unknown;
	try {
		parsed = JSON.parse(configText);
	} catch (error) {
		const detail = error instanceof Error ? error.message : String(error);
		throw new SettingsEditError(400, `settings are not valid JSON: ${detail.slice(0, 300)}`);
	}
	const submitted = validateEditableConfigDoc(parsed);

	const secretFields = findSecretLikeValues(submitted, profile.config.config.secrets);
	if (secretFields.length > 0) {
		throw new SettingsEditError(
			400,
			`refusing to store ${secretFields.join(", ")}: the value looks like a secret. Secrets do not belong in alive.config.json — ${
				secretsHint(profile)
			}`,
		);
	}

	const effective = effectiveConfigDoc(profile.config.config);
	const changes = diffConfigDocs(effective, submitted);
	// An untouched JSON textarea is not an edit: never pin effective defaults into the file.
	if (changes.length === 0) return undefined;

	// 1. validate the effective result exactly as the runtime would load it
	const candidate = structuredClone(profile.config.config);
	for (const change of changes) {
		setAtPath(candidate as unknown as Record<string, unknown>, change.path, change.after);
	}
	validateEffectiveConfig(candidate);

	// 2. apply the same leaves to the file on disk (never the merged defaults)
	const file = resolveWritableTarget(profile.profileDir, profile.configPath);
	const originalText = readTextFile(file);
	let raw: unknown = {};
	if (originalText.trim() !== "") {
		try {
			raw = JSON.parse(originalText);
		} catch (error) {
			const detail = error instanceof Error ? error.message : String(error);
			throw new SettingsEditError(
				400,
				`refusing to edit ${file}: it is not valid JSON (${detail.slice(0, 200)})`,
			);
		}
	}
	if (!isPlainObject(raw)) {
		throw new SettingsEditError(400, `refusing to edit ${file}: the file does not contain a JSON object`);
	}
	for (const change of changes) setAtPath(raw, change.path, change.after);
	const indent = detectJsonIndent(originalText);
	return {
		kind: "config",
		label: path.basename(file),
		file,
		content: `${JSON.stringify(raw, null, indent)}\n`,
	};
}

function readTextFile(file: string): string {
	try {
		return fs.readFileSync(file, "utf8");
	} catch {
		return "";
	}
}

// ---------------------------------------------------------------------------
// page view
// ---------------------------------------------------------------------------

export interface SettingsPromptView {
	key: PromptKey;
	label: string;
	/** Real path resolved from the profile config (`paths.soulPath` and friends). */
	path: string;
	field: string;
	exists: boolean;
	insideProfile: boolean;
	content: string;
	truncated: boolean;
	originalChars: number;
}

export interface SettingsFlagView {
	path: string;
	label: string;
	value: boolean;
}

export interface SettingsView {
	agent: { id: string; name: string; profileDir: string; configPath: string; stateDir: string };
	/** Why editing is disabled, or undefined when it is enabled. */
	disabledReason?: string;
	/** Why the JSON config textarea is read-only, or undefined when it is editable. */
	configDisabledReason?: string;
	backupsDir: string;
	model: string;
	allowlist: string[];
	flags: SettingsFlagView[];
	/** Pretty-printed editable document, exactly what the JSON textarea shows. */
	configJson: string;
	prompts: SettingsPromptView[];
	backups: DashboardBackup[];
}

const WORKER_PERMISSION_LABELS: Record<(typeof WORKER_PERMISSION_KEYS)[number], string> = {
	spawn: "workers may start sessions",
	send: "workers may receive follow-up instructions",
	stop: "workers may be aborted or archived",
	inspect: "workers may be inspected (status, transcript, diff)",
	worktree: "workers may create git worktrees and check out PRs",
	pullRequest: "workers may push branches and open pull requests",
};

function flagViews(doc: EditableConfigDoc): SettingsFlagView[] {
	const flags: SettingsFlagView[] = [
		{ path: "tools.bash", label: "agent may run bash in its workspace", value: doc.tools?.bash === true },
		{ path: "workers.enabled", label: "ephemeral coding workers", value: doc.workers?.enabled === true },
	];
	for (const key of WORKER_PERMISSION_KEYS) {
		flags.push({
			path: `workers.permissions.${key}`,
			label: WORKER_PERMISSION_LABELS[key],
			value: doc.workers?.permissions?.[key] === true,
		});
	}
	flags.push(
		{ path: "sandbox.enabled", label: "sandboxed shell and files", value: doc.sandbox?.enabled === true },
		{ path: "sandbox.network", label: "sandbox network access", value: doc.sandbox?.network === true },
		{
			path: "sandbox.networkAccess",
			label: "sandbox egress is public-only",
			value: doc.sandbox?.networkAccess === "public",
		},
		{ path: "modules.browser.enabled", label: "browser module", value: doc.modules?.browser?.enabled === true },
	);
	return flags;
}

export function loadSettingsView(profile: DashboardProfile): SettingsView {
	const doc = effectiveConfigDoc(profile.config.config);
	const disabledReason = settingsDisabledReason(profile);
	const prompts = PROMPT_KEYS.map((key): SettingsPromptView => {
		const spec = PROMPT_SPECS[key];
		const file = spec.path(profile);
		const raw = readTextFile(file);
		const truncated = raw.length > DASHBOARD_MAX_PROMPT_CHARS;
		return {
			key,
			label: spec.label,
			path: file,
			field: spec.field,
			exists: fs.existsSync(file),
			insideProfile: isInsideDirectory(profile.profileDir, file),
			content: truncated ? raw.slice(0, DASHBOARD_MAX_PROMPT_CHARS) : raw,
			truncated,
			originalChars: raw.length,
		};
	});
	return {
		agent: {
			id: profile.id,
			name: profile.name,
			profileDir: profile.profileDir,
			configPath: profile.configPath,
			stateDir: profile.stateDir,
		},
		disabledReason,
		configDisabledReason: configDisabledReason(profile),
		backupsDir: backupsDirectory(profile),
		model: profile.config.config.model,
		allowlist: [...profile.config.config.tools.allowlist],
		flags: flagViews(doc),
		configJson: `${JSON.stringify(doc, null, 2)}\n`,
		prompts,
		backups: listDashboardBackups(profile).slice(-10).reverse(),
	};
}
