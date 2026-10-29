/**
 * Moving plaintext secrets out of the project config and into `.env`.
 *
 * The config file is not a secret carrier: it is routinely copied, committed,
 * diffed, and read by coding agents. This module finds secret-looking leaf
 * values in a config object, moves each one to an environment variable next to
 * the config, removes it from the config file, and re-hydrates the in-memory
 * config from the environment at load time.
 *
 * One mechanism covers built-in modules, external modules, chat integration
 * tokens, and explicit `sandbox.env` entries. No module name is special-cased
 * in the migration algorithm itself; the few built-in field names only choose
 * friendly environment variable names.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { parseEnv } from "node:util";

export type SecretMigrationAction = "appended" | "existing" | "kept" | "read-only" | "failed";

export interface SecretMigrationEntry {
	/** Absolute path of the config file the secret was found in. */
	file: string;
	/** Dot/bracket path inside the config, e.g. `modules.telegram.token`. */
	field: string;
	/** Environment variable that now carries the value. */
	envName: string;
	action: SecretMigrationAction;
}

export interface SecretMigrationReport {
	envPath: string;
	dryRun: boolean;
	/** True when at least one file or `.env` was changed (always false in dry-run mode). */
	changed: boolean;
	entries: SecretMigrationEntry[];
	warnings: string[];
}

export interface MigrateSecretsOptions {
	/** Config files to inspect. Missing files are skipped. */
	configPaths: string[];
	/** Defaults to `.env` next to the first config file. */
	envPath?: string;
	/** Process environment to consult first; defaults to `process.env`. */
	env?: NodeJS.ProcessEnv;
	/**
	 * Built-in defaults for the same config shape. They supply sibling `*Env`
	 * names (e.g. `sharedTokenEnv`) when the raw file only has the plaintext
	 * field, so migration and later hydration agree on the variable name.
	 */
	defaults?: unknown;
	dryRun?: boolean;
	/** One line per migrated secret. Receives no secret values. */
	log?: (line: string) => void;
	/** Warnings and manual instructions. Receives no secret values. */
	warn?: (line: string) => void;
}

interface SecretFieldLocation {
	path: Array<string | number>;
	envName: string;
	value: string;
	/** Keep the key as an empty string instead of deleting it (explicit env maps). */
	keepEmpty: boolean;
}

const SECRET_KEY_RE = /(token|secret|passwd|password|api[_-]?key|access[_-]?key|private[_-]?key|credential)/i;
const NON_SECRET_SUFFIX_RE = /(env|file|path|url|uri|name|dir|ttl|timeout|limit|length|size|count|type|id|ids|header|headers|prefix|suffix|field|fields)$/i;
const ENV_NAME_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;

/** True for keys whose value is a secret rather than a reference/path/name. */
export function isSecretKey(key: string): boolean {
	if (!SECRET_KEY_RE.test(key)) return false;
	if (NON_SECRET_SUFFIX_RE.test(key)) return false;
	return true;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
	if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
	const prototype = Object.getPrototypeOf(value);
	return prototype === Object.prototype || prototype === null;
}

function toEnvSegment(value: string): string {
	return value
		.replace(/([a-z0-9])([A-Z])/g, "$1_$2")
		.replace(/[^A-Za-z0-9]+/g, "_")
		.replace(/^_+|_+$/g, "")
		.toUpperCase() || "VALUE";
}

function samePath(left: Array<string | number>, right: Array<string | number>): boolean {
	return left.length === right.length && left.every((segment, index) => segment === right[index]);
}

function externalModuleName(root: unknown, index: number): string | undefined {
	if (!isPlainObject(root) || !isPlainObject(root.modules)) return undefined;
	const external = root.modules.external;
	if (!Array.isArray(external) || !isPlainObject(external[index])) return undefined;
	const name = external[index].name;
	return typeof name === "string" && name.trim() ? name.trim() : undefined;
}

function resolveEnvName(
	root: unknown,
	defaultsRoot: unknown,
	parentPath: Array<string | number>,
	key: string,
	parent: Record<string, unknown>,
): string {
	// A sibling `tokenEnv` / `apiKeyEnv` is the operator's explicit choice.
	const sibling = parent[`${key}Env`];
	if (typeof sibling === "string" && sibling.trim()) return sibling.trim();
	const defaultParent = valueAtPath(defaultsRoot, parentPath);
	if (isPlainObject(defaultParent)) {
		const defaultSibling = defaultParent[`${key}Env`];
		if (typeof defaultSibling === "string" && defaultSibling.trim()) return defaultSibling.trim();
	}

	// `sandbox.env` is already a name → value map; the key is the variable name.
	if (parentPath.length === 2 && parentPath[0] === "sandbox" && parentPath[1] === "env") {
		return ENV_NAME_RE.test(key) ? key : toEnvSegment(key);
	}

	// Friendly names for the built-in fields, matching their documented defaults.
	if (samePath(parentPath, ["modules", "telegram"])) return "ALIVE_TELEGRAM_TOKEN";
	if (samePath(parentPath, ["modules", "grafana"])) return "ALIVE_GRAFANA_TOKEN";
	if (samePath(parentPath, ["chat", "http"])) return "ALIVE_CHAT_HTTP_TOKEN";

	if (parentPath[0] === "modules" && parentPath[1] === "external") {
		const index = Number(parentPath[2]);
		const moduleName = Number.isSafeInteger(index) ? externalModuleName(root, index) : undefined;
		const prefix = moduleName ? toEnvSegment(moduleName) : `MODULE_${Number.isSafeInteger(index) ? index : "X"}`;
		const rest = [...parentPath.slice(4), key].map((segment) => toEnvSegment(String(segment))).join("_");
		return `ALIVE_${prefix}${rest ? `_${rest}` : ""}`;
	}

	const suffix = [...parentPath, key].map((segment) => toEnvSegment(String(segment))).join("_");
	return `ALIVE_${suffix}`;
}

function collectSecretFields(
	value: unknown,
	pathSegments: Array<string | number>,
	root: unknown,
	defaultsRoot: unknown,
	out: SecretFieldLocation[],
): void {
	if (Array.isArray(value)) {
		value.forEach((entry, index) => collectSecretFields(entry, [...pathSegments, index], root, defaultsRoot, out));
		return;
	}
	if (!isPlainObject(value)) return;
	for (const [key, entry] of Object.entries(value)) {
		if (typeof entry === "string") {
			if (!entry || !isSecretKey(key)) continue;
			out.push({
				path: [...pathSegments, key],
				envName: resolveEnvName(root, defaultsRoot, pathSegments, key, value),
				value: entry,
				keepEmpty: pathSegments.length === 2 && pathSegments[0] === "sandbox" && pathSegments[1] === "env",
			});
			continue;
		}
		if (entry !== null && typeof entry === "object") {
			collectSecretFields(entry, [...pathSegments, key], root, defaultsRoot, out);
		}
	}
}

/** Find every non-empty secret-looking string in a config object. */
export function findSecretFields(config: unknown, defaults?: unknown): SecretFieldLocation[] {
	const out: SecretFieldLocation[] = [];
	collectSecretFields(config, [], config, defaults, out);
	return out;
}

export function formatFieldPath(pathSegments: Array<string | number>): string {
	let out = "";
	for (const segment of pathSegments) {
		if (typeof segment === "number") out += `[${segment}]`;
		else out += out ? `.${segment}` : segment;
	}
	return out;
}

function valueAtPath(root: unknown, pathSegments: Array<string | number>): unknown {
	let current: unknown = root;
	for (const segment of pathSegments) {
		if (typeof segment === "number") {
			if (!Array.isArray(current)) return undefined;
			current = current[segment];
		} else {
			if (!isPlainObject(current)) return undefined;
			current = current[segment];
		}
	}
	return current;
}

function setAtPath(root: unknown, pathSegments: Array<string | number>, value: unknown): void {
	if (pathSegments.length === 0) return;
	const parent = valueAtPath(root, pathSegments.slice(0, -1));
	const key = pathSegments[pathSegments.length - 1]!;
	if (typeof key === "number") {
		if (Array.isArray(parent)) parent[key] = value;
	} else if (isPlainObject(parent)) {
		parent[key] = value;
	}
}

/** Remove the plaintext value; keep the field name only for explicit env maps. */
export function stripSecretField(root: unknown, field: SecretFieldLocation): void {
	const parent = valueAtPath(root, field.path.slice(0, -1));
	const key = field.path[field.path.length - 1];
	if (typeof key !== "string" || !isPlainObject(parent)) return;
	if (field.keepEmpty) {
		parent[key] = "";
		return;
	}
	delete parent[key];
	const sibling = `${key}Env`;
	// Remember the env name so a later load can hydrate the value back into the
	// in-memory config without the secret ever returning to the file.
	if (typeof parent[sibling] !== "string" || !(parent[sibling] as string).trim()) parent[sibling] = field.envName;
}

/** Return a deep copy with every secret-looking value replaced by `[redacted]`. */
export function redactSecretFields<T>(config: T): T {
	const clone = structuredClone(config);
	for (const field of findSecretFields(clone)) {
		setAtPath(clone, field.path, field.keepEmpty ? "" : "[redacted]");
	}
	return clone;
}

/** Parse `.env` without touching process state. */
export function readEnvFileValues(file: string): Record<string, string> {
	if (!fs.existsSync(file)) return {};
	let content: string;
	try {
		content = fs.readFileSync(file, "utf8");
	} catch {
		return {};
	}
	try {
		const parsed = parseEnv(content);
		const values: Record<string, string> = {};
		for (const [key, value] of Object.entries(parsed)) if (typeof value === "string") values[key] = value;
		return values;
	} catch {
		const values: Record<string, string> = {};
		for (const line of content.split(/\r?\n/)) {
			const match = line.match(/^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/);
			if (!match) continue;
			let value = match[2]!.trim();
			if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
				value = value.slice(1, -1);
			}
			values[match[1]!] = value;
		}
		return values;
	}
}

/** Effective secret env: `.env` values with non-empty process values taking precedence. */
export function collectSecretEnv(envPath: string, env: NodeJS.ProcessEnv = process.env): Record<string, string> {
	const values = readEnvFileValues(envPath);
	for (const [key, value] of Object.entries(env)) {
		if (value !== undefined && value !== "") values[key] = value;
	}
	return values;
}

/**
 * Hydrate secret fields in a loaded config from environment values.
 *
 * This is what lets code keep reading `config.modules.grafana.token` while the
 * value itself lives only in `.env`. A sibling `*Env` field identifies the
 * variable; `sandbox.env` keys are their own variable names. Environment values
 * win over anything still present in the config object.
 */
export function applySecretEnv(config: unknown, env: Record<string, string>): void {
	const visit = (value: unknown, pathSegments: Array<string | number>): void => {
		if (Array.isArray(value)) {
			value.forEach((entry, index) => visit(entry, [...pathSegments, index]));
			return;
		}
		if (!isPlainObject(value)) return;

		// `sandbox.env` is an explicit env map; values are hydrated by their key.
		if (pathSegments.length === 2 && pathSegments[0] === "sandbox" && pathSegments[1] === "env") {
			for (const key of Object.keys(value)) {
				if (!isSecretKey(key)) continue;
				const replacement = env[key];
				if (replacement !== undefined && replacement !== "") value[key] = replacement;
			}
		}

		for (const [key, entry] of Object.entries(value)) {
			if (key.endsWith("Env") && typeof entry === "string" && entry.trim()) {
				const base = key.slice(0, -3);
				const replacement = env[entry.trim()];
				if (isSecretKey(base) && replacement !== undefined && replacement !== "") value[base] = replacement;
			}
			if (entry !== null && typeof entry === "object") visit(entry, [...pathSegments, key]);
		}
	};
	visit(config, []);
}

function formatEnvAssignment(name: string, value: string): string {
	if (!ENV_NAME_RE.test(name)) throw new Error(`invalid environment variable name: ${name}`);
	const safe = /^[A-Za-z0-9_@%+=:,./-]+$/.test(value) ? value : JSON.stringify(value);
	return `${name}=${safe}`;
}

function appendEnvFile(file: string, assignments: string[]): void {
	if (assignments.length === 0) return;
	const existed = fs.existsSync(file);
	let needsNewline = false;
	if (existed) {
		const content = fs.readFileSync(file, "utf8");
		needsNewline = content.length > 0 && !content.endsWith("\n");
	}
	const text = `${needsNewline ? "\n" : ""}${assignments.join("\n")}\n`;
	const fd = fs.openSync(file, "a", 0o600);
	try {
		fs.writeFileSync(fd, text, "utf8");
	} finally {
		fs.closeSync(fd);
	}
	// The file must never be group/world readable, even when it already existed.
	fs.chmodSync(file, 0o600);
}

function detectIndent(content: string): string {
	const match = content.match(/\n([ \t]+)"/);
	return match?.[1] ?? "\t";
}

function writeJsonAtomic(file: string, value: unknown): void {
	const original = fs.readFileSync(file, "utf8");
	const mode = fs.statSync(file).mode & 0o777;
	const indent = detectIndent(original);
	const text = `${JSON.stringify(value, null, indent)}\n`;
	const directory = path.dirname(file);
	const temporary = path.join(directory, `.${path.basename(file)}.tmp-${process.pid}-${Math.random().toString(36).slice(2)}`);
	try {
		fs.writeFileSync(temporary, text, { encoding: "utf8", mode });
		fs.chmodSync(temporary, mode);
		fs.renameSync(temporary, file);
	} catch (error) {
		fs.rmSync(temporary, { force: true });
		throw error;
	}
}

function formatWarnings(
	entry: SecretMigrationEntry,
	detail: "different" | "read-only" | "failed",
	envPath: string,
	dryRun: boolean,
): string {
	const verb = dryRun ? "would keep" : "kept";
	if (detail === "different") {
		return `warning: ${entry.envName} already has a different value; ${verb} it and ${dryRun ? "remove" : "removed"} ${entry.field} from ${entry.file}`;
	}
	if (detail === "read-only") {
		return (
			`warning: cannot migrate ${entry.field}: ${entry.file} is read-only; the secret is still on disk. ` +
			`Manual: add ${entry.envName}=<value> to ${envPath} (chmod 600), remove ${entry.field} from ${entry.file}, ` +
			"then run 'alive config migrate-secrets'."
		);
	}
	return (
		`warning: could not migrate ${entry.field}; the secret is still in ${entry.file}. ` +
		`Manual: add ${entry.envName}=<value> to ${envPath} (chmod 600), remove ${entry.field} from ${entry.file}, ` +
		"then run 'alive config migrate-secrets'."
	);
}

/**
 * Move plaintext secrets from config files into `.env`.
 *
 * Appends only: unrelated `.env` lines are never rewritten. The config file is
 * replaced atomically and keeps its original mode. A read-only config produces
 * a warning with manual instructions instead of an exception.
 */
export function migrateConfigSecrets(options: MigrateSecretsOptions): SecretMigrationReport {
	const configPaths = [...new Set(options.configPaths.map((file) => path.resolve(file)))];
	const firstConfig = configPaths[0];
	if (!firstConfig) throw new Error("migrateConfigSecrets requires at least one config path");
	const envPath = path.resolve(options.envPath ?? path.join(path.dirname(firstConfig), ".env"));
	const env = options.env ?? process.env;
	const dryRun = options.dryRun === true;
	const log = options.log ?? ((line: string) => process.stderr.write(`${line}\n`));
	const reportWarnings: string[] = [];
	const warn = (line: string) => {
		reportWarnings.push(line);
		(options.warn ?? ((text: string) => process.stderr.write(`${text}\n`)))(line);
	};

	const envFileValues = readEnvFileValues(envPath);
	const planned = new Map<string, string>();
	const entries: SecretMigrationEntry[] = [];
	let changed = false;

	for (const file of configPaths) {
		if (!fs.existsSync(file)) continue;
		let raw: unknown;
		try {
			raw = JSON.parse(fs.readFileSync(file, "utf8")) as unknown;
		} catch {
			warn(`warning: cannot migrate secrets in ${file}: the file is not valid JSON`);
			continue;
		}
		const fields = findSecretFields(raw, options.defaults);
		if (fields.length === 0) continue;

		const writable = (fs.statSync(file).mode & 0o222) !== 0;
		if (!writable) {
			for (const field of fields) {
				const entry: SecretMigrationEntry = {
					file,
					field: formatFieldPath(field.path),
					envName: field.envName,
					action: "read-only",
				};
				entries.push(entry);
				warn(formatWarnings(entry, "read-only", envPath, dryRun));
			}
			continue;
		}

		const fileEntries: Array<{ field: SecretFieldLocation; entry: SecretMigrationEntry }> = [];
		const assignments: string[] = [];
		for (const field of fields) {
			const processValue = env[field.envName];
			const fileValue = envFileValues[field.envName] ?? planned.get(field.envName);
			const existing = processValue !== undefined && processValue !== "" ? processValue : fileValue;
			let action: SecretMigrationAction;
			if (existing !== undefined && existing !== "") {
				action = existing === field.value ? "existing" : "kept";
			} else {
				action = "appended";
				planned.set(field.envName, field.value);
				assignments.push(formatEnvAssignment(field.envName, field.value));
			}
			const entry: SecretMigrationEntry = {
				file,
				field: formatFieldPath(field.path),
				envName: field.envName,
				action,
			};
			entries.push(entry);
			fileEntries.push({ field, entry });
		}

		if (!dryRun) {
			try {
				appendEnvFile(envPath, assignments);
			} catch {
				for (const { entry } of fileEntries) {
					entry.action = "failed";
					warn(formatWarnings(entry, "failed", envPath, dryRun));
				}
				continue;
			}
			for (const { field } of fileEntries) stripSecretField(raw, field);
			try {
				writeJsonAtomic(file, raw);
			} catch {
				// The values are already safely in .env; keep the config untouched and
				// tell the operator exactly what remains on disk.
				for (const { entry } of fileEntries) {
					entry.action = "failed";
					warn(formatWarnings(entry, "failed", envPath, dryRun));
				}
				continue;
			}
			changed = true;
		}

		for (const { entry } of fileEntries) {
			if (entry.action === "kept") {
				warn(formatWarnings(entry, "different", envPath, dryRun));
				continue;
			}
			if (entry.action === "failed" || entry.action === "read-only") continue;
			const prefix = dryRun ? "would migrate secret" : "migrated secret";
			const suffix = entry.action === "appended"
				? dryRun ? `would append to ${envPath}` : `appended to ${envPath}`
				: "already set";
			log(`${prefix} ${entry.field} -> ${entry.envName} (${suffix})`);
		}
	}

	return { envPath, dryRun, changed, entries, warnings: reportWarnings };
}

/** Render one migration entry without ever including the secret value. */
export function formatSecretMigrationLine(entry: SecretMigrationEntry, dryRun: boolean): string {
	if (entry.action === "read-only") return `read-only ${entry.field} -> ${entry.envName} (${entry.file})`;
	if (entry.action === "failed") return `failed ${entry.field} -> ${entry.envName} (${entry.file})`;
	if (entry.action === "kept") return `${dryRun ? "would keep" : "kept"} existing ${entry.envName}; ${dryRun ? "would remove" : "removed"} ${entry.field}`;
	const prefix = dryRun ? "would migrate" : "migrated";
	const suffix = entry.action === "appended" ? (dryRun ? "would append" : "appended") : "already set";
	return `${prefix} ${entry.field} -> ${entry.envName} (${suffix})`;
}
