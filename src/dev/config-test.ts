/**
 * Config secret-migration test:
 *
 *   npx tsx src/dev/config-test.ts
 *
 * Filesystem fixtures only: no network, no model, no running runtime.
 */
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
	DEFAULT_CONFIG,
	DEFAULT_EMPTY_WAKE_BACKOFF,
	EMPTY_WAKE_MAX_INTERVAL_MAX_MS,
	EMPTY_WAKE_MAX_INTERVAL_MIN_MS,
	loadConfig,
	redactSecretFields,
	validateLoopConfig,
	type LoopConfig,
} from "../config.js";
import { findSecretFields, migrateConfigSecrets } from "../config-secrets.js";
import { resolveToken } from "../modules/telegram/module.js";

let failures = 0;

function check(name: string, condition: boolean, detail?: unknown): void {
	if (condition) {
		process.stdout.write(`  ok    ${name}\n`);
		return;
	}
	failures += 1;
	process.stdout.write(`  FAIL  ${name}${detail === undefined ? "" : ` — ${JSON.stringify(detail)}`}\n`);
}

function section(name: string): void {
	process.stdout.write(`\n${name}\n`);
}

const TELEGRAM_VALUE = `123456789:${"A".repeat(35)}`;
const GRAFANA_VALUE = "grafana-bearer-value";
const CHAT_VALUE = "chat-http-bearer-value";
const DISCORD_VALUE = "discord-bot-token-value";
const SANDBOX_VALUE = "sandbox-provider-key-value";
const BROWSER_VALUE = "browser-shared-token-value";
const EMBEDDING_VALUE = "embedding-provider-key-value";
const ALL_VALUES = [TELEGRAM_VALUE, GRAFANA_VALUE, CHAT_VALUE, DISCORD_VALUE, SANDBOX_VALUE, BROWSER_VALUE, EMBEDDING_VALUE];

function tempRoot(label: string): string {
	return fs.mkdtempSync(path.join(os.tmpdir(), `alive-config-${label}-`));
}

function writeConfig(root: string, value: unknown, indent = 2): string {
	const file = path.join(root, "alive.config.json");
	fs.writeFileSync(file, `${JSON.stringify(value, null, indent)}\n`, "utf8");
	return file;
}

function readConfig(root: string): Record<string, unknown> {
	return JSON.parse(fs.readFileSync(path.join(root, "alive.config.json"), "utf8")) as Record<string, unknown>;
}

function capture(): { log: string[]; warn: string[]; logFn: (line: string) => void; warnFn: (line: string) => void } {
	const log: string[] = [];
	const warn: string[] = [];
	return { log, warn, logFn: (line) => log.push(line), warnFn: (line) => warn.push(line) };
}

function cleanupEnv(...names: string[]): void {
	for (const name of names) delete process.env[name];
}

function envLineCount(file: string, name: string): number {
	if (!fs.existsSync(file)) return 0;
	return fs.readFileSync(file, "utf8").split(/\r?\n/).filter((line) => line.startsWith(`${name}=`)).length;
}

function envValue(file: string, name: string): string | undefined {
	if (!fs.existsSync(file)) return undefined;
	for (const line of fs.readFileSync(file, "utf8").split(/\r?\n/)) {
		if (!line.startsWith(`${name}=`)) continue;
		let value = line.slice(name.length + 1);
		if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) value = value.slice(1, -1);
		return value;
	}
	return undefined;
}

// ---------------------------------------------------------------------------
section("plaintext Telegram token is moved to .env");
{
	const root = tempRoot("telegram");
	const envName = "ALIVE_CONFIG_TEST_TELEGRAM_TOKEN";
	cleanupEnv(envName);
	const configPath = writeConfig(root, {
		modules: { telegram: { enabled: true, token: TELEGRAM_VALUE, tokenEnv: envName } },
	});
	const bytesBefore = fs.readFileSync(configPath, "utf8");
	const lines = capture();
	const loaded = loadConfig({ cwd: root, secretLog: lines.logFn, secretWarn: lines.warnFn });
	const envPath = path.join(root, ".env");
	const raw = readConfig(root);

	check("migration reports exactly one line", lines.log.length === 1 && lines.warn.length === 0, lines);
	check("the line names the variable", lines.log[0]?.includes(envName) === true, lines.log);
	check("the line never contains the value", !lines.log.join("\n").includes(TELEGRAM_VALUE), lines.log);
	check(".env exists with mode 0600", fs.existsSync(envPath) && (fs.statSync(envPath).mode & 0o777) === 0o600, fs.existsSync(envPath) ? (fs.statSync(envPath).mode & 0o777).toString(8) : "missing");
	check(".env has exactly one assignment", envLineCount(envPath, envName) === 1 && envValue(envPath, envName) === TELEGRAM_VALUE);
	const telegram = (raw.modules as Record<string, unknown>).telegram as Record<string, unknown>;
	check("plaintext token field is gone", !("token" in telegram), telegram);
	check("no secret value remains in the config", !fs.readFileSync(configPath, "utf8").includes(TELEGRAM_VALUE));
	check("config formatting is preserved", fs.readFileSync(configPath, "utf8").includes('\n  "modules"'), fs.readFileSync(configPath, "utf8").slice(0, 80));
	check("config changed from the original", fs.readFileSync(configPath, "utf8") !== bytesBefore);
	check("in-memory token resolves to the migrated value", loaded.config.modules.telegram.token === TELEGRAM_VALUE, loaded.config.modules.telegram.token);
	check("resolveToken sees the migrated value", resolveToken(loaded.config.modules.telegram) === TELEGRAM_VALUE);
	check("a second load appends nothing", (() => {
		const before = fs.readFileSync(envPath, "utf8");
		loadConfig({ cwd: root, secretLog: () => undefined, secretWarn: () => undefined });
		return fs.readFileSync(envPath, "utf8") === before;
	})());
	fs.rmSync(root, { recursive: true, force: true });
	cleanupEnv(envName);
}

// ---------------------------------------------------------------------------
section("existing identical env var: no duplicate line");
{
	const root = tempRoot("identical");
	const envName = "ALIVE_CONFIG_TEST_IDENTICAL_TOKEN";
	cleanupEnv(envName);
	const configPath = writeConfig(root, {
		modules: { telegram: { enabled: true, token: TELEGRAM_VALUE, tokenEnv: envName } },
	});
	const envPath = path.join(root, ".env");
	fs.writeFileSync(envPath, `${envName}=${TELEGRAM_VALUE}\n`, { mode: 0o600 });
	const lines = capture();
	const loaded = loadConfig({ cwd: root, secretLog: lines.logFn, secretWarn: lines.warnFn });
	check("no duplicate assignment", envLineCount(envPath, envName) === 1, fs.readFileSync(envPath, "utf8"));
	check("one migration line", lines.log.length === 1 && lines.warn.length === 0, lines);
	check("value not printed", !lines.log.join("\n").includes(TELEGRAM_VALUE), lines.log);
	check("config token removed", !("token" in ((readConfig(root).modules as any).telegram as object)));
	check("token resolved from env", loaded.config.modules.telegram.token === TELEGRAM_VALUE);
	fs.rmSync(root, { recursive: true, force: true });
	cleanupEnv(envName);
}

// ---------------------------------------------------------------------------
section("existing different env var: keep the config value, warn, touch nothing");
{
	const root = tempRoot("different");
	const envName = "ALIVE_CONFIG_TEST_DIFFERENT_TOKEN";
	cleanupEnv(envName);
	const existing = "different-existing-value";
	const configPath = writeConfig(root, {
		modules: { telegram: { enabled: true, token: TELEGRAM_VALUE, tokenEnv: envName } },
	});
	const envPath = path.join(root, ".env");
	fs.writeFileSync(envPath, `${envName}=${existing}\n`, { mode: 0o600 });
	const lines = capture();
	const loaded = loadConfig({ cwd: root, secretLog: lines.logFn, secretWarn: lines.warnFn });
	check("existing value is kept", envValue(envPath, envName) === existing && envLineCount(envPath, envName) === 1, fs.readFileSync(envPath, "utf8"));
	check("one warning and no success line", lines.log.length === 0 && lines.warn.length === 1, lines);
	check("warning names the variable", lines.warn[0]?.includes(envName) === true, lines.warn);
	check("warning never prints either value", !lines.warn.join("\n").includes(existing) && !lines.warn.join("\n").includes(TELEGRAM_VALUE), lines.warn);
	check("config token is kept (never dropped because env differs)", ((readConfig(root).modules as any).telegram as { token?: string }).token === TELEGRAM_VALUE);
	check("effective token is the config value", loaded.config.modules.telegram.token === TELEGRAM_VALUE);
	fs.rmSync(root, { recursive: true, force: true });
	cleanupEnv(envName);
}

// ---------------------------------------------------------------------------
section("read-only config: warn, do not crash, leave it untouched");
{
	const root = tempRoot("readonly");
	const envName = "ALIVE_CONFIG_TEST_READONLY_TOKEN";
	cleanupEnv(envName);
	const configPath = writeConfig(root, {
		modules: { telegram: { enabled: true, token: TELEGRAM_VALUE, tokenEnv: envName } },
	});
	fs.chmodSync(configPath, 0o444);
	const before = fs.readFileSync(configPath, "utf8");
	const lines = capture();
	let loaded: ReturnType<typeof loadConfig> | undefined;
	let crashed = false;
	try {
		loaded = loadConfig({ cwd: root, secretLog: lines.logFn, secretWarn: lines.warnFn });
	} catch {
		crashed = true;
	}
	check("load does not crash", !crashed);
	check("warning says the secret is still on disk", lines.warn.some((line) => line.includes("read-only") && line.includes("still on disk")), lines.warn);
	check("warning includes the exact manual instruction", lines.warn.some((line) => line.includes("Manual:") && line.includes(envName) && line.includes("alive config migrate-secrets")), lines.warn);
	check("no secret value in warnings", !lines.warn.join("\n").includes(TELEGRAM_VALUE), lines.warn);
	check("config unchanged", fs.readFileSync(configPath, "utf8") === before);
	check("no .env created", !fs.existsSync(path.join(root, ".env")));
	check("the value remains available from config (nothing was lost)", loaded?.config.modules.telegram.token === TELEGRAM_VALUE);
	fs.chmodSync(configPath, 0o644);
	fs.rmSync(root, { recursive: true, force: true });
	cleanupEnv(envName);
}

// ---------------------------------------------------------------------------
section("dry run touches nothing");
{
	const root = tempRoot("dry");
	const envName = "ALIVE_CONFIG_TEST_DRY_TOKEN";
	cleanupEnv(envName);
	const configPath = writeConfig(root, {
		modules: { telegram: { enabled: true, token: TELEGRAM_VALUE, tokenEnv: envName } },
	});
	const before = fs.readFileSync(configPath, "utf8");
	const lines = capture();
	const report = migrateConfigSecrets({ configPaths: [configPath], dryRun: true, log: lines.logFn, warn: lines.warnFn });
	check("dry run reports a would-migrate line", lines.log.length === 1 && lines.log[0]?.includes("would migrate") === true, lines.log);
	check("dry run reports no value", !lines.log.join("\n").includes(TELEGRAM_VALUE), lines.log);
	check("config bytes unchanged", fs.readFileSync(configPath, "utf8") === before);
	check("no .env created", !fs.existsSync(path.join(root, ".env")));
	check("report says nothing changed and lists the entry", report.changed === false && report.entries.length === 1 && report.entries[0]?.envName === envName, report.entries);
	fs.rmSync(root, { recursive: true, force: true });
	cleanupEnv(envName);
}

// ---------------------------------------------------------------------------
section("other module and integration secret fields follow the same path");
{
	const root = tempRoot("others");
	const names = ["ALIVE_GRAFANA_TOKEN", "ALIVE_CHAT_HTTP_TOKEN", "ALIVE_DISCORD_TOKEN", "MY_API_KEY", "ALIVE_BROWSER_SHARED_TOKEN", "ALIVE_EMBEDDING_API_KEY"];
	cleanupEnv(...names);
	const configPath = writeConfig(root, {
		modules: {
			grafana: { enabled: true, token: GRAFANA_VALUE, tokenEnv: "ALIVE_GRAFANA_TOKEN" },
			browser: { sharedToken: BROWSER_VALUE },
			external: [{ name: "discord", path: "discord.js", enabled: true, options: { token: DISCORD_VALUE } }],
		},
		memory: { embeddingApiKey: EMBEDDING_VALUE },
		chat: { http: { enabled: true, token: CHAT_VALUE, tokenEnv: "ALIVE_CHAT_HTTP_TOKEN" } },
		sandbox: { env: { MY_API_KEY: SANDBOX_VALUE } },
	});
	const lines = capture();
	const loaded = loadConfig({ cwd: root, secretLog: lines.logFn, secretWarn: lines.warnFn });
	const envPath = path.join(root, ".env");
	const rawText = fs.readFileSync(configPath, "utf8");
	check("one line per migrated field", lines.log.length === 6 && lines.warn.length === 0, lines);
	check("each env var is written", envValue(envPath, "ALIVE_GRAFANA_TOKEN") === GRAFANA_VALUE && envValue(envPath, "ALIVE_CHAT_HTTP_TOKEN") === CHAT_VALUE && envValue(envPath, "ALIVE_DISCORD_TOKEN") === DISCORD_VALUE && envValue(envPath, "MY_API_KEY") === SANDBOX_VALUE && envValue(envPath, "ALIVE_BROWSER_SHARED_TOKEN") === BROWSER_VALUE && envValue(envPath, "ALIVE_EMBEDDING_API_KEY") === EMBEDDING_VALUE, fs.existsSync(envPath) ? fs.readFileSync(envPath, "utf8") : "missing");
	check("no secret value remains in the file", ALL_VALUES.every((value) => !rawText.includes(value)), rawText);
	const raw = readConfig(root);
	check("grafana token field is gone", !("token" in ((raw.modules as any).grafana as object)));
	check("external module token is gone", !("token" in ((raw.modules as any).external[0].options as object)));
	check("chat token field is gone", !("token" in ((raw.chat as any).http as object)));
	check("sandbox env entry is empty, not secret", ((raw.sandbox as any).env as Record<string, string>).MY_API_KEY === "");
	check("in-memory config is hydrated", loaded.config.modules.grafana.token === GRAFANA_VALUE && loaded.config.chat.http.token === CHAT_VALUE && loaded.config.modules.external[0]?.options.token === DISCORD_VALUE && loaded.config.sandbox.env.MY_API_KEY === SANDBOX_VALUE && (loaded.config.modules.browser as any).sharedToken === BROWSER_VALUE && (loaded.config.memory as any).embeddingApiKey === EMBEDDING_VALUE);
	const redacted = JSON.stringify(redactSecretFields(loaded.config));
	check("redacted config contains no secret values", ALL_VALUES.every((value) => !redacted.includes(value)), redacted.slice(0, 200));
	check("redacted config still marks the fields", redacted.includes("[redacted]"));
	const fields = findSecretFields(loaded.config).map((field) => field.envName).sort();
	check("the same detector finds every hydrated secret", names.every((name) => fields.includes(name)), fields);
	fs.rmSync(root, { recursive: true, force: true });
	cleanupEnv(...names);
}

// ---------------------------------------------------------------------------
section("process environment with a different value never overwrites the config secret");
{
	const root = tempRoot("envwins");
	const envName = "ALIVE_CONFIG_TEST_ENV_WINS_TOKEN";
	const existing = "process-env-value";
	process.env[envName] = existing;
	const configPath = writeConfig(root, {
		modules: { telegram: { enabled: true, token: TELEGRAM_VALUE, tokenEnv: envName } },
	});
	const lines = capture();
	const loaded = loadConfig({ cwd: root, secretLog: lines.logFn, secretWarn: lines.warnFn });
	check("config value wins over a conflicting process env value", loaded.config.modules.telegram.token === TELEGRAM_VALUE);
	check("config plaintext is kept on disk", ((readConfig(root).modules as any).telegram as { token?: string }).token === TELEGRAM_VALUE);
	check("warning notes the different existing value", lines.warn.length === 1 && lines.warn[0]?.includes(envName) === true, lines);
	check("no .env entry was needed", !fs.existsSync(path.join(root, ".env")) || envLineCount(path.join(root, ".env"), envName) === 0);
	fs.rmSync(root, { recursive: true, force: true });
	cleanupEnv(envName);
	fs.rmSync(configPath, { force: true });
}


// ---------------------------------------------------------------------------
section("loop.emptyWakeBackoff: defaults, validation and safe fallbacks (#116)");
{
	const base = DEFAULT_CONFIG.loop;
	check(
		"the default block is enabled, doubles after 2 empty wakes and caps at 60 min",
		DEFAULT_EMPTY_WAKE_BACKOFF.enabled === true &&
			DEFAULT_EMPTY_WAKE_BACKOFF.afterWakes === 2 &&
			DEFAULT_EMPTY_WAKE_BACKOFF.maxIntervalMs === 60 * 60_000,
		DEFAULT_EMPTY_WAKE_BACKOFF,
	);
	const root = tempRoot("loop");
	const loaded = loadConfig({ cwd: root, secretLog: () => undefined, secretWarn: () => undefined });
	check(
		"a config file without the block gets the defaults",
		loaded.config.loop.emptyWakeBackoff.enabled === true &&
			loaded.config.loop.emptyWakeBackoff.afterWakes === 2 &&
			loaded.config.loop.emptyWakeBackoff.maxIntervalMs === 3_600_000,
		loaded.config.loop.emptyWakeBackoff,
	);
	const overridden = loadConfig({
		cwd: root,
		secretLog: () => undefined,
		secretWarn: () => undefined,
		overrides: { loop: { ...base, emptyWakeBackoff: { enabled: false, afterWakes: 5, maxIntervalMs: 120_000 } } },
	});
	check(
		"an explicit block wins over the defaults",
		overridden.config.loop.emptyWakeBackoff.enabled === false &&
			overridden.config.loop.emptyWakeBackoff.afterWakes === 5 &&
			overridden.config.loop.emptyWakeBackoff.maxIntervalMs === 120_000,
		overridden.config.loop.emptyWakeBackoff,
	);
	const rejects: Array<[string, unknown]> = [
		["not an object", "nope"],
		["enabled that is not a boolean", { enabled: "yes", afterWakes: 2, maxIntervalMs: 60_000 }],
		["afterWakes 0", { enabled: true, afterWakes: 0, maxIntervalMs: 60_000 }],
		["a negative afterWakes", { enabled: true, afterWakes: -1, maxIntervalMs: 60_000 }],
		["a fractional afterWakes", { enabled: true, afterWakes: 1.5, maxIntervalMs: 60_000 }],
		["an afterWakes above 100", { enabled: true, afterWakes: 101, maxIntervalMs: 60_000 }],
		["a missing maxIntervalMs", { enabled: true, afterWakes: 2 }],
		["a sub-minute maxIntervalMs", { enabled: true, afterWakes: 2, maxIntervalMs: 60 }],
		["a maxIntervalMs beyond 24h", { enabled: true, afterWakes: 2, maxIntervalMs: EMPTY_WAKE_MAX_INTERVAL_MAX_MS + 1 }],
		["a fractional maxIntervalMs", { enabled: true, afterWakes: 2, maxIntervalMs: 60_000.5 }],
	];
	for (const [label, block] of rejects) {
		let message = "";
		try {
			validateLoopConfig({ ...base, emptyWakeBackoff: block as never });
		} catch (error) {
			message = error instanceof Error ? error.message : String(error);
		}
		check(`${label} is rejected`, message.startsWith("loop.emptyWakeBackoff"), message || "accepted");
	}
	const filled = validateLoopConfig({ ...base, emptyWakeBackoff: undefined as unknown as LoopConfig["emptyWakeBackoff"] });
	const nulled = validateLoopConfig({ ...base, emptyWakeBackoff: null as unknown as LoopConfig["emptyWakeBackoff"] });
	check(
		"a missing or null block is filled with the defaults, not left undefined",
		filled.emptyWakeBackoff.enabled === DEFAULT_EMPTY_WAKE_BACKOFF.enabled &&
			filled.emptyWakeBackoff.afterWakes === DEFAULT_EMPTY_WAKE_BACKOFF.afterWakes &&
			filled.emptyWakeBackoff.maxIntervalMs === DEFAULT_EMPTY_WAKE_BACKOFF.maxIntervalMs &&
			nulled.emptyWakeBackoff.afterWakes === DEFAULT_EMPTY_WAKE_BACKOFF.afterWakes,
		{ filled: filled.emptyWakeBackoff, nulled: nulled.emptyWakeBackoff },
	);
	check(
		"the minimum and maximum caps are a minute and a day",
		EMPTY_WAKE_MAX_INTERVAL_MIN_MS === 60_000 && EMPTY_WAKE_MAX_INTERVAL_MAX_MS === 86_400_000,
		{ min: EMPTY_WAKE_MAX_INTERVAL_MIN_MS, max: EMPTY_WAKE_MAX_INTERVAL_MAX_MS },
	);
	fs.rmSync(root, { recursive: true, force: true });
}

process.stdout.write(`\n${failures === 0 ? "all config tests passed" : `${failures} config test(s) failed`}\n`);
process.exitCode = failures === 0 ? 0 : 1;
