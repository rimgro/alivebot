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
	DEFAULT_HEALTH_CONFIG,
	DEFAULT_HEALTH_SILENT_MS,
	DEFAULT_LOOP_CONTEXT_HARD_TOKENS,
	DEFAULT_LOOP_CONTEXT_SLEEP_GRACE_TURNS,
	DEFAULT_LOOP_CONTEXT_SLEEP_TOKENS,
	DEFAULT_LOOP_CONTEXT_WARN_STEP_TOKENS,
	DEFAULT_LOOP_CONTEXT_WARN_TOKENS,
	DEFAULT_LOOP_REPEAT_TOOL_ABORT,
	DEFAULT_LOOP_REPEAT_TOOL_THRESHOLD,
	DEFAULT_LOOP_REPEAT_TOOL_WINDOW,
	DEFAULT_LOOP_RUN_NO_OUTBOUND_TURNS,
	DEFAULT_LOOP_RUN_STALL_MS,
	DEFAULT_LOOP_RUN_TIMEOUT_MS,
	DEFAULT_LOOP_RUN_VERY_LONG_MS,
	DEFAULT_LOOP_RUN_WARN_MS,
	DEFAULT_LOOP_RESUME_WINDOW_MS,
	DEFAULT_LOOP_SHUTDOWN_GRACE_MS,
	DEFAULT_LOOP_TOOL_LONG_MS,
	DEFAULT_SESSIONS_CONFIG,
	EMPTY_WAKE_MAX_INTERVAL_MAX_MS,
	EMPTY_WAKE_MAX_INTERVAL_MIN_MS,
	ensureContextTools,
	loadConfig,
	redactSecretFields,
	resolveContextPolicy,
	validateHealthConfig,
	validateLoopConfig,
	validateProfileContextConfig,
	validateSessionsConfig,
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
section("health.silentMs: dead-agent default and validation (#175)");
{
	check(
		"the schema default is 2 hours and 0 means disabled",
		DEFAULT_HEALTH_CONFIG.silentMs === 7_200_000 && DEFAULT_HEALTH_SILENT_MS === 7_200_000 && DEFAULT_CONFIG.health.silentMs === 7_200_000,
		{ config: DEFAULT_CONFIG.health, constant: DEFAULT_HEALTH_SILENT_MS },
	);
	const root = tempRoot("health");
	const loaded = loadConfig({ cwd: root, secretLog: () => undefined, secretWarn: () => undefined });
	check("a config without a health block inherits the 2 h default", loaded.config.health.silentMs === 7_200_000, loaded.config.health);

	writeConfig(root, { health: { silentMs: 300_000 } });
	const overridden = loadConfig({ cwd: root, secretLog: () => undefined, secretWarn: () => undefined });
	check("an explicit health.silentMs wins", overridden.config.health.silentMs === 300_000, overridden.config.health);

	writeConfig(root, { health: { silentMs: 0 } });
	const disabled = loadConfig({ cwd: root, secretLog: () => undefined, secretWarn: () => undefined });
	check("health.silentMs = 0 disables the dead rule", disabled.config.health.silentMs === 0, disabled.config.health);

	const filled = validateHealthConfig(undefined);
	const nulled = validateHealthConfig(null);
	check(
		"a missing or null block falls back to the default",
		filled.silentMs === 7_200_000 && nulled.silentMs === 7_200_000,
		{ filled, nulled },
	);
	for (const value of [-1, 1.5, Number.POSITIVE_INFINITY, Number.NaN, "300000"]) {
		let message = "";
		try {
			validateHealthConfig({ silentMs: value });
		} catch (error) {
			message = error instanceof Error ? error.message : String(error);
		}
		check(`health.silentMs=${String(value)} is rejected`, message.startsWith("health.silentMs"), message || "accepted");
	}
	let objectMessage = "";
	try {
		validateHealthConfig("nope");
	} catch (error) {
		objectMessage = error instanceof Error ? error.message : String(error);
	}
	check("a non-object health block is rejected", objectMessage.startsWith("health must be an object"), objectMessage || "accepted");
	fs.rmSync(root, { recursive: true, force: true });
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

// ---------------------------------------------------------------------------
section("loop run-health keys: no hard stop by default, validated thresholds (#127)");
{
	check(
		"the defaults are 0 / 10 min / 60 turns / 3 h",
		DEFAULT_CONFIG.loop.runTimeoutMs === 0 &&
			DEFAULT_LOOP_RUN_TIMEOUT_MS === 0 &&
			DEFAULT_LOOP_RUN_WARN_MS === 10 * 60_000 &&
			DEFAULT_LOOP_RUN_NO_OUTBOUND_TURNS === 60 &&
			DEFAULT_LOOP_RUN_VERY_LONG_MS === 3 * 60 * 60_000 &&
			DEFAULT_LOOP_TOOL_LONG_MS === 10 * 60_000,
		DEFAULT_CONFIG.loop,
	);
	check("the single-tool anomaly defaults to 10 minutes (#164)", DEFAULT_CONFIG.loop.toolLongMs === 10 * 60_000, DEFAULT_CONFIG.loop.toolLongMs);
	check(
		"the stalled-open-run threshold defaults to 10 minutes (#173)",
		DEFAULT_CONFIG.loop.runStallMs === 10 * 60_000 && DEFAULT_LOOP_RUN_STALL_MS === 10 * 60_000,
		DEFAULT_CONFIG.loop.runStallMs,
	);
	const root = tempRoot("runhealth");
	const loaded = loadConfig({ cwd: root, secretLog: () => undefined, secretWarn: () => undefined });
	check(
		"a config file without the keys gets no hard stop and the anomaly defaults",
		loaded.config.loop.runTimeoutMs === 0 &&
			loaded.config.loop.runWarnMs === 10 * 60_000 &&
			loaded.config.loop.runNoOutboundTurns === 60 &&
			loaded.config.loop.runVeryLongMs === 3 * 60 * 60_000 &&
			loaded.config.loop.toolLongMs === 10 * 60_000,
		loaded.config.loop,
	);

	const overridden = loadConfig({
		cwd: root,
		secretLog: () => undefined,
		secretWarn: () => undefined,
		overrides: { loop: { ...DEFAULT_CONFIG.loop, runTimeoutMs: 120_000, runWarnMs: 0, runNoOutboundTurns: 0, runVeryLongMs: 0 } },
	});
	check(
		"explicit values win and 0 disables each guard",
		overridden.config.loop.runTimeoutMs === 120_000 &&
			overridden.config.loop.runWarnMs === 0 &&
			overridden.config.loop.runNoOutboundTurns === 0 &&
			overridden.config.loop.runVeryLongMs === 0,
		overridden.config.loop,
	);

	// A legacy wake-per-batch config that asked for a hard stop keeps it: the old
	// key is renamed before defaults fill `runTimeoutMs` with 0.
	writeConfig(root, { loop: { wakeTimeoutMs: 90_000 } });
	const legacy = loadConfig({ cwd: root, secretLog: () => undefined, secretWarn: () => undefined });
	check("legacy wakeTimeoutMs still becomes a positive runTimeoutMs", legacy.config.loop.runTimeoutMs === 90_000, legacy.config.loop);

	const rejects: Array<[string, string, unknown]> = [
		["a negative runTimeoutMs", "runTimeoutMs", -1],
		["a fractional runWarnMs", "runWarnMs", 1.5],
		["a string runNoOutboundTurns", "runNoOutboundTurns", "60"],
		["a NaN runVeryLongMs", "runVeryLongMs", Number.NaN],
		["an infinite runWarnMs", "runWarnMs", Number.POSITIVE_INFINITY],
		["a negative toolLongMs", "toolLongMs", -1],
		["a fractional toolLongMs", "toolLongMs", 1.5],
		["a string toolLongMs", "toolLongMs", "600000"],
		["a negative runStallMs", "runStallMs", -1],
		["a fractional runStallMs", "runStallMs", 1.5],
		["a string runStallMs", "runStallMs", "600000"],
	];
	for (const [label, key, value] of rejects) {
		let message = "";
		try {
			validateLoopConfig({ ...DEFAULT_CONFIG.loop, [key]: value } as LoopConfig);
		} catch (error) {
			message = error instanceof Error ? error.message : String(error);
		}
		check(`${label} is rejected`, message.startsWith(`loop.${key}`), message || "accepted");
	}
	const zeroed = validateLoopConfig({
		...DEFAULT_CONFIG.loop,
		runTimeoutMs: 0,
		runWarnMs: 0,
		runNoOutboundTurns: 0,
		runVeryLongMs: 0,
		toolLongMs: 0,
		runStallMs: 0,
	});
	check(
		"0 is accepted for every key, meaning disabled",
		zeroed.runTimeoutMs === 0 && zeroed.runWarnMs === 0 && zeroed.runNoOutboundTurns === 0 && zeroed.runVeryLongMs === 0 && zeroed.toolLongMs === 0 && zeroed.runStallMs === 0,
		zeroed,
	);
	const partial = validateLoopConfig({
		...DEFAULT_CONFIG.loop,
		runTimeoutMs: undefined,
		runWarnMs: null,
		runNoOutboundTurns: undefined,
		runVeryLongMs: null,
		toolLongMs: null,
		runStallMs: null,
	} as unknown as LoopConfig);
	check(
		"missing or null keys fall back to the defaults, not undefined",
		partial.runTimeoutMs === 0 &&
			partial.runWarnMs === 10 * 60_000 &&
			partial.runNoOutboundTurns === 60 &&
			partial.runVeryLongMs === 3 * 60 * 60_000 &&
			partial.toolLongMs === 10 * 60_000 &&
			partial.runStallMs === 10 * 60_000,
		partial,
	);
	fs.rmSync(root, { recursive: true, force: true });
}

// ---------------------------------------------------------------------------
section("loop repeated-tool keys: sliding-window defaults and validation (#70)");
{
	check(
		"the defaults are threshold 0 (off), window 12, abort off",
		DEFAULT_CONFIG.loop.repeatToolThreshold === 0 &&
			DEFAULT_CONFIG.loop.repeatToolWindow === 12 &&
			DEFAULT_CONFIG.loop.repeatToolAbort === false &&
			DEFAULT_LOOP_REPEAT_TOOL_THRESHOLD === 0 &&
			DEFAULT_LOOP_REPEAT_TOOL_WINDOW === 12 &&
			DEFAULT_LOOP_REPEAT_TOOL_ABORT === false,
		DEFAULT_CONFIG.loop,
	);
	const root = tempRoot("repeattool");
	const loaded = loadConfig({ cwd: root, secretLog: () => undefined, secretWarn: () => undefined });
	check(
		"a config file without the keys keeps detection off and the window valid",
		loaded.config.loop.repeatToolThreshold === 0 &&
			loaded.config.loop.repeatToolWindow === 12 &&
			loaded.config.loop.repeatToolAbort === false,
		loaded.config.loop,
	);
	const disabledInFile = loadConfig({
		cwd: root,
		secretLog: () => undefined,
		secretWarn: () => undefined,
		overrides: { loop: { ...DEFAULT_CONFIG.loop, repeatToolThreshold: 0, repeatToolWindow: 0 } },
	});
	check(
		"threshold 0 in the config disables detection and does not break the window",
		disabledInFile.config.loop.repeatToolThreshold === 0 &&
			disabledInFile.config.loop.repeatToolWindow === 12 &&
			disabledInFile.config.loop.repeatToolAbort === false,
		disabledInFile.config.loop,
	);
	const overridden = loadConfig({
		cwd: root,
		secretLog: () => undefined,
		secretWarn: () => undefined,
		overrides: {
			loop: {
				...DEFAULT_CONFIG.loop,
				repeatToolThreshold: 5,
				repeatToolWindow: 8,
				repeatToolAbort: true,
			},
		},
	});
	check(
		"explicit values win",
		overridden.config.loop.repeatToolThreshold === 5 &&
			overridden.config.loop.repeatToolWindow === 8 &&
			overridden.config.loop.repeatToolAbort === true,
		overridden.config.loop,
	);
	const disabled = validateLoopConfig({ ...DEFAULT_CONFIG.loop, repeatToolThreshold: 0 });
	check("threshold 0 is accepted and disables detection", disabled.repeatToolThreshold === 0, disabled);
	const disabledWithWindow = validateLoopConfig({
		...DEFAULT_CONFIG.loop,
		repeatToolThreshold: 0,
		repeatToolWindow: 5,
	});
	const zeroBoth = validateLoopConfig({ ...DEFAULT_CONFIG.loop, repeatToolThreshold: 0, repeatToolWindow: 0 });
	check(
		"with detection off, a configured window is kept and an explicit 0 falls back to 12",
		disabledWithWindow.repeatToolThreshold === 0 &&
			disabledWithWindow.repeatToolWindow === 5 &&
			zeroBoth.repeatToolThreshold === 0 &&
			zeroBoth.repeatToolWindow === 12,
		{ disabledWithWindow, zeroBoth },
	);
	const enabled = validateLoopConfig({ ...DEFAULT_CONFIG.loop, repeatToolThreshold: 3, repeatToolWindow: 12 });
	const zeroWindow = validateLoopConfig({ ...DEFAULT_CONFIG.loop, repeatToolThreshold: 4, repeatToolWindow: 0 });
	const smallWindow = validateLoopConfig({ ...DEFAULT_CONFIG.loop, repeatToolThreshold: 4, repeatToolWindow: 2 });
	check(
		"an explicit threshold 3 is kept and a window below the threshold is raised to it",
		enabled.repeatToolThreshold === 3 &&
			enabled.repeatToolWindow === 12 &&
			zeroWindow.repeatToolWindow === 4 &&
			smallWindow.repeatToolWindow === 4,
		{
			enabled: { threshold: enabled.repeatToolThreshold, window: enabled.repeatToolWindow },
			zeroWindow: zeroWindow.repeatToolWindow,
			smallWindow: smallWindow.repeatToolWindow,
		},
	);
	const filled = validateLoopConfig({
		...DEFAULT_CONFIG.loop,
		repeatToolThreshold: undefined,
		repeatToolWindow: null,
		repeatToolAbort: undefined,
	} as unknown as LoopConfig);
	check(
		"missing or null keys fall back to the defaults, not undefined",
		filled.repeatToolThreshold === 0 && filled.repeatToolWindow === 12 && filled.repeatToolAbort === false,
		filled,
	);
	const rejects: Array<[string, string, unknown]> = [
		["a negative repeatToolThreshold", "repeatToolThreshold", -1],
		["a fractional repeatToolThreshold", "repeatToolThreshold", 1.5],
		["a string repeatToolThreshold", "repeatToolThreshold", "3"],
		["a NaN repeatToolThreshold", "repeatToolThreshold", Number.NaN],
		["a negative repeatToolWindow", "repeatToolWindow", -1],
		["a fractional repeatToolWindow", "repeatToolWindow", 12.5],
		["a string repeatToolWindow", "repeatToolWindow", "12"],
		["a non-boolean repeatToolAbort", "repeatToolAbort", "true"],
		["a numeric repeatToolAbort", "repeatToolAbort", 1],
	];
	for (const [label, key, value] of rejects) {
		let message = "";
		try {
			validateLoopConfig({ ...DEFAULT_CONFIG.loop, [key]: value } as LoopConfig);
		} catch (error) {
			message = error instanceof Error ? error.message : String(error);
		}
		check(`${label} is rejected`, message.startsWith(`loop.${key}`), message || "accepted");
	}
	fs.rmSync(root, { recursive: true, force: true });
}

// ---------------------------------------------------------------------------
section("loop context-size hint keys are validated (#123)");
{
	check(
		"the defaults are 150k tokens with a 50k re-arm step",
		DEFAULT_CONFIG.loop.contextWarnTokens === 150_000 &&
			DEFAULT_CONFIG.loop.contextWarnStepTokens === 50_000 &&
			DEFAULT_LOOP_CONTEXT_WARN_TOKENS === 150_000 &&
			DEFAULT_LOOP_CONTEXT_WARN_STEP_TOKENS === 50_000,
		DEFAULT_CONFIG.loop,
	);
	const root = tempRoot("contextwarn");
	const loaded = loadConfig({ cwd: root, secretLog: () => undefined, secretWarn: () => undefined });
	check(
		"a config file without the keys gets the defaults",
		loaded.config.loop.contextWarnTokens === 150_000 && loaded.config.loop.contextWarnStepTokens === 50_000,
		loaded.config.loop,
	);

	const overridden = loadConfig({
		cwd: root,
		secretLog: () => undefined,
		secretWarn: () => undefined,
		overrides: { loop: { ...DEFAULT_CONFIG.loop, contextWarnTokens: 90_000, contextWarnStepTokens: 10_000 } },
	});
	check(
		"explicit values win",
		overridden.config.loop.contextWarnTokens === 90_000 && overridden.config.loop.contextWarnStepTokens === 10_000,
		overridden.config.loop,
	);

	const disabled = validateLoopConfig({ ...DEFAULT_CONFIG.loop, contextWarnTokens: 0, contextWarnStepTokens: 0 });
	check(
		"contextWarnTokens = 0 disables the hint and accepts step 0 too",
		disabled.contextWarnTokens === 0 && disabled.contextWarnStepTokens === 0,
		disabled,
	);

	const rejects: Array<[string, LoopConfig, string]> = [
		["a negative contextWarnTokens", { ...DEFAULT_CONFIG.loop, contextWarnTokens: -1 }, "loop.contextWarnTokens"],
		["a fractional contextWarnTokens", { ...DEFAULT_CONFIG.loop, contextWarnTokens: 1.5 }, "loop.contextWarnTokens"],
		["a string contextWarnTokens", { ...DEFAULT_CONFIG.loop, contextWarnTokens: "150000" as unknown as number }, "loop.contextWarnTokens"],
		["a negative contextWarnStepTokens", { ...DEFAULT_CONFIG.loop, contextWarnStepTokens: -1 }, "loop.contextWarnStepTokens"],
		["a fractional contextWarnStepTokens", { ...DEFAULT_CONFIG.loop, contextWarnStepTokens: 1.5 }, "loop.contextWarnStepTokens"],
		["an infinite contextWarnStepTokens", { ...DEFAULT_CONFIG.loop, contextWarnStepTokens: Number.POSITIVE_INFINITY }, "loop.contextWarnStepTokens"],
		[
			"a zero step while warnings are enabled",
			{ ...DEFAULT_CONFIG.loop, contextWarnTokens: 150_000, contextWarnStepTokens: 0 },
			"loop.contextWarnStepTokens must be > 0",
		],
	];
	for (const [label, value, expected] of rejects) {
		let message = "";
		try {
			validateLoopConfig(value);
		} catch (error) {
			message = error instanceof Error ? error.message : String(error);
		}
		check(`${label} is rejected`, message.startsWith(expected), message || "accepted");
	}

	const partial = validateLoopConfig({
		...DEFAULT_CONFIG.loop,
		contextWarnTokens: undefined,
		contextWarnStepTokens: null,
	} as unknown as LoopConfig);
	check(
		"missing or null context keys fall back to the defaults",
		partial.contextWarnTokens === 150_000 && partial.contextWarnStepTokens === 50_000,
		partial,
	);
	fs.rmSync(root, { recursive: true, force: true });
}

// ---------------------------------------------------------------------------
section("loop shutdown/resume keys are validated (#124)");
{
	check(
		"the defaults are 30 s grace and a 10 min resume window",
		DEFAULT_CONFIG.loop.shutdownGraceMs === DEFAULT_LOOP_SHUTDOWN_GRACE_MS &&
			DEFAULT_CONFIG.loop.resumeWindowMs === DEFAULT_LOOP_RESUME_WINDOW_MS &&
			DEFAULT_LOOP_SHUTDOWN_GRACE_MS === 30_000 &&
			DEFAULT_LOOP_RESUME_WINDOW_MS === 10 * 60_000,
		DEFAULT_CONFIG.loop,
	);
	const overridden = validateLoopConfig({ ...DEFAULT_CONFIG.loop, shutdownGraceMs: 5_000, resumeWindowMs: 60_000 });
	check("explicit values win", overridden.shutdownGraceMs === 5_000 && overridden.resumeWindowMs === 60_000, overridden);
	for (const key of ["shutdownGraceMs", "resumeWindowMs"] as const) {
		const zero = validateLoopConfig({ ...DEFAULT_CONFIG.loop, [key]: 0 });
		check(`${key}=0 is accepted (immediate abort / no resume)`, zero[key] === 0, zero[key]);
		for (const value of [-1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, "30000"]) {
			let message = "";
			try {
				validateLoopConfig({ ...DEFAULT_CONFIG.loop, [key]: value } as never);
			} catch (error) {
				message = error instanceof Error ? error.message : String(error);
			}
			check(`${key}=${String(value)} is rejected`, message.startsWith(`loop.${key}`), message || "accepted");
		}
	}
	const partial = validateLoopConfig({
		...DEFAULT_CONFIG.loop,
		shutdownGraceMs: undefined,
		resumeWindowMs: null,
	} as unknown as LoopConfig);
	check(
		"missing/null keys fall back to the defaults",
		partial.shutdownGraceMs === 30_000 && partial.resumeWindowMs === 10 * 60_000,
		partial,
	);
}

// ---------------------------------------------------------------------------
section("loop context-sleep thresholds and profile overrides are validated (#170)");
{
	check(
		"the defaults are soft 150k, grace 3 turns and a hard 250k ceiling",
		DEFAULT_CONFIG.loop.contextSleepTokens === 150_000 &&
			DEFAULT_CONFIG.loop.contextSleepGraceTurns === 3 &&
			DEFAULT_CONFIG.loop.contextHardTokens === 250_000 &&
			DEFAULT_LOOP_CONTEXT_SLEEP_TOKENS === 150_000 &&
			DEFAULT_LOOP_CONTEXT_SLEEP_GRACE_TURNS === 3 &&
			DEFAULT_LOOP_CONTEXT_HARD_TOKENS === 250_000,
		DEFAULT_CONFIG.loop,
	);
	const root = tempRoot("contextsleep");
	const loaded = loadConfig({ cwd: root, secretLog: () => undefined, secretWarn: () => undefined });
	check(
		"a config file without the keys gets the defaults",
		loaded.config.loop.contextSleepTokens === 150_000 &&
			loaded.config.loop.contextSleepGraceTurns === 3 &&
			loaded.config.loop.contextHardTokens === 250_000,
		loaded.config.loop,
	);

	const overridden = validateLoopConfig({
		...DEFAULT_CONFIG.loop,
		contextSleepTokens: 100_000,
		contextSleepGraceTurns: 0,
		contextHardTokens: 120_000,
	});
	check(
		"explicit values win",
		overridden.contextSleepTokens === 100_000 &&
			overridden.contextSleepGraceTurns === 0 &&
			overridden.contextHardTokens === 120_000,
		overridden,
	);
	const disabled = validateLoopConfig({
		...DEFAULT_CONFIG.loop,
		contextSleepTokens: 0,
		contextSleepGraceTurns: 0,
		contextHardTokens: 0,
	});
	check(
		"0 disables every context-sleep threshold",
		disabled.contextSleepTokens === 0 && disabled.contextSleepGraceTurns === 0 && disabled.contextHardTokens === 0,
		disabled,
	);

	const rejects: Array<[string, LoopConfig, string]> = [
		["a negative contextSleepTokens", { ...DEFAULT_CONFIG.loop, contextSleepTokens: -1 }, "loop.contextSleepTokens"],
		["a fractional contextSleepTokens", { ...DEFAULT_CONFIG.loop, contextSleepTokens: 1.5 }, "loop.contextSleepTokens"],
		["a string contextSleepTokens", { ...DEFAULT_CONFIG.loop, contextSleepTokens: "150000" as unknown as number }, "loop.contextSleepTokens"],
		["a negative contextSleepGraceTurns", { ...DEFAULT_CONFIG.loop, contextSleepGraceTurns: -1 }, "loop.contextSleepGraceTurns"],
		["a fractional contextSleepGraceTurns", { ...DEFAULT_CONFIG.loop, contextSleepGraceTurns: 1.5 }, "loop.contextSleepGraceTurns"],
		["a negative contextHardTokens", { ...DEFAULT_CONFIG.loop, contextHardTokens: -1 }, "loop.contextHardTokens"],
		["a fractional contextHardTokens", { ...DEFAULT_CONFIG.loop, contextHardTokens: 1.5 }, "loop.contextHardTokens"],
		[
			"a hard ceiling below the soft threshold",
			{ ...DEFAULT_CONFIG.loop, contextSleepTokens: 200_000, contextHardTokens: 150_000 },
			"loop.contextHardTokens must be >= loop.contextSleepTokens",
		],
	];
	for (const [label, value, expected] of rejects) {
		let message = "";
		try {
			validateLoopConfig(value);
		} catch (error) {
			message = error instanceof Error ? error.message : String(error);
		}
		check(`${label} is rejected`, message.startsWith(expected), message || "accepted");
	}

	const zeroSoftWithHard = validateLoopConfig({ ...DEFAULT_CONFIG.loop, contextSleepTokens: 0, contextHardTokens: 250_000 });
	check(
		"a disabled soft threshold does not require a hard ceiling above it",
		zeroSoftWithHard.contextSleepTokens === 0 && zeroSoftWithHard.contextHardTokens === 250_000,
		zeroSoftWithHard,
	);
	const partial = validateLoopConfig({
		...DEFAULT_CONFIG.loop,
		contextSleepTokens: undefined,
		contextSleepGraceTurns: null,
		contextHardTokens: undefined,
	} as unknown as LoopConfig);
	check(
		"missing or null context-sleep keys fall back to the defaults",
		partial.contextSleepTokens === 150_000 && partial.contextSleepGraceTurns === 3 && partial.contextHardTokens === 250_000,
		partial,
	);

	const profile = validateProfileContextConfig({ sleepTokens: 90_000, sleepGraceTurns: 0 }, DEFAULT_CONFIG.loop);
	check(
		"a profile context block keeps only the fields it sets",
		profile?.sleepTokens === 90_000 && profile?.sleepGraceTurns === 0 && profile?.hardTokens === undefined,
		profile,
	);
	check("an absent profile block stays undefined", validateProfileContextConfig(undefined, DEFAULT_CONFIG.loop) === undefined);
	check(
		"the effective policy merges profile over loop",
		resolveContextPolicy({ ...DEFAULT_CONFIG, context: { sleepTokens: 90_000 } }).sleepTokens === 90_000 &&
			resolveContextPolicy({ ...DEFAULT_CONFIG, context: { sleepTokens: 90_000 } }).hardTokens === 250_000,
		resolveContextPolicy({ ...DEFAULT_CONFIG, context: { sleepTokens: 90_000 } }),
	);
	let profileMessage = "";
	try {
		validateProfileContextConfig({ hardTokens: 100_000 }, DEFAULT_CONFIG.loop);
	} catch (error) {
		profileMessage = error instanceof Error ? error.message : String(error);
	}
	check(
		"a profile hard ceiling below the inherited soft threshold is rejected",
		profileMessage.startsWith("context.hardTokens must be >="),
		profileMessage || "accepted",
	);
	for (const value of [-1, 1.5, Number.POSITIVE_INFINITY, "100000"]) {
		let message = "";
		try {
			validateProfileContextConfig({ sleepTokens: value }, DEFAULT_CONFIG.loop);
		} catch (error) {
			message = error instanceof Error ? error.message : String(error);
		}
		check(`context.sleepTokens=${String(value)} is rejected`, message.startsWith("context.sleepTokens"), message || "accepted");
	}

	const required = ensureContextTools(["read", "bash"]);
	check(
		"sleep, retain and journal are added back to a custom allowlist",
		required.added.join(",") === "sleep,retain,journal" &&
			required.allowlist.includes("read") &&
			required.allowlist.includes("sleep") &&
			required.allowlist.includes("retain") &&
			required.allowlist.includes("journal"),
		required,
	);
	const already = ensureContextTools(["read", "sleep", "retain", "journal"]);
	check("an allowlist that already has them is unchanged and silent", already.added.length === 0 && already.allowlist.join(",") === "read,sleep,retain,journal", already);

	writeConfig(root, { tools: { allowlist: ["read", "bash"] } });
	const warnings: string[] = [];
	const normalized = loadConfig({
		cwd: root,
		secretLog: () => undefined,
		secretWarn: () => undefined,
		configWarn: (line) => warnings.push(line),
	});
	check(
		"loadConfig normalizes a local/custom allowlist and warns once",
		["sleep", "retain", "journal"].every((tool) => normalized.config.tools.allowlist.includes(tool)) && warnings.length === 1,
		{ allowlist: normalized.config.tools.allowlist, warnings },
	);
	check(
		"the warning names the added tools",
		warnings[0]?.includes("sleep") && warnings[0]?.includes("retain") && warnings[0]?.includes("journal"),
		warnings[0],
	);

	const profileLoaded = loadConfig({
		cwd: root,
		secretLog: () => undefined,
		secretWarn: () => undefined,
		overrides: { context: { sleepTokens: 90_000, sleepGraceTurns: 1, hardTokens: 200_000 } },
	});
	check(
		"a profile context block survives loadConfig and resolves over the loop",
		profileLoaded.config.context?.sleepTokens === 90_000 &&
			resolveContextPolicy(profileLoaded.config).sleepGraceTurns === 1,
		profileLoaded.config.context,
	);
	fs.rmSync(root, { recursive: true, force: true });
}

// ---------------------------------------------------------------------------
section("sessions.archiveRotate: off by default, validated, merged from defaults (#228)");
{
	check(
		"the schema default is off, gzip after 7 days, delete after 30, no byte cap",
		DEFAULT_CONFIG.sessions.archiveRotate.enabled === false &&
			DEFAULT_CONFIG.sessions.archiveRotate.gzipAfterDays === 7 &&
			DEFAULT_CONFIG.sessions.archiveRotate.deleteAfterDays === 30 &&
			DEFAULT_CONFIG.sessions.archiveRotate.maxBytes === 0 &&
			DEFAULT_SESSIONS_CONFIG.archiveRotate.enabled === false &&
			DEFAULT_SESSIONS_CONFIG.archiveRotate.maxBytes === 0,
		DEFAULT_SESSIONS_CONFIG,
	);
	const root = tempRoot("sessions-rotate");
	const load = (): ReturnType<typeof loadConfig> =>
		loadConfig({ cwd: root, secretLog: () => undefined, secretWarn: () => undefined });
	const loaded = load();
	check(
		"a config without a sessions block inherits the defaults",
		loaded.config.sessions.archiveRotate.enabled === false &&
			loaded.config.sessions.archiveRotate.gzipAfterDays === 7 &&
			loaded.config.sessions.archiveRotate.deleteAfterDays === 30 &&
			loaded.config.sessions.archiveRotate.maxBytes === 0,
		loaded.config.sessions,
	);
	writeConfig(root, { sessions: { archiveRotate: { enabled: true } } });
	const partial = load();
	check(
		"a partial block is filled from the defaults",
		partial.config.sessions.archiveRotate.enabled === true &&
			partial.config.sessions.archiveRotate.gzipAfterDays === 7 &&
			partial.config.sessions.archiveRotate.deleteAfterDays === 30 &&
			partial.config.sessions.archiveRotate.maxBytes === 0,
		partial.config.sessions,
	);
	const partialCap = validateSessionsConfig({ archiveRotate: { enabled: false, maxBytes: 1_500_000_000 } });
	check(
		"maxBytes is accepted together with enabled:false",
		partialCap.archiveRotate.enabled === false &&
			partialCap.archiveRotate.maxBytes === 1_500_000_000 &&
			partialCap.archiveRotate.gzipAfterDays === 7 &&
			partialCap.archiveRotate.deleteAfterDays === 30,
		partialCap,
	);
	writeConfig(root, { sessions: { archiveRotate: { enabled: true, gzipAfterDays: 3, deleteAfterDays: 10, maxBytes: 500 } } });
	const explicit = load();
	check(
		"explicit values win",
		explicit.config.sessions.archiveRotate.gzipAfterDays === 3 &&
			explicit.config.sessions.archiveRotate.deleteAfterDays === 10 &&
			explicit.config.sessions.archiveRotate.maxBytes === 500,
		explicit.config.sessions,
	);

	const filled = validateSessionsConfig(undefined);
	const nulled = validateSessionsConfig(null);
	check(
		"a missing or null block falls back to the default",
		filled.archiveRotate.enabled === false && nulled.archiveRotate.deleteAfterDays === 30,
		{ filled, nulled },
	);
	const rejects: Array<[string, unknown, string]> = [
		[
			"deleteAfterDays below gzipAfterDays",
			{ archiveRotate: { enabled: true, gzipAfterDays: 10, deleteAfterDays: 5 } },
			"sessions.archiveRotate.deleteAfterDays must be >= sessions.archiveRotate.gzipAfterDays",
		],
		["a non-boolean enabled", { archiveRotate: { enabled: "yes" } }, "sessions.archiveRotate.enabled"],
		["a negative gzipAfterDays", { archiveRotate: { gzipAfterDays: -1 } }, "sessions.archiveRotate.gzipAfterDays"],
		["a fractional gzipAfterDays", { archiveRotate: { gzipAfterDays: 1.5 } }, "sessions.archiveRotate.gzipAfterDays"],
		[
			"an infinite deleteAfterDays",
			{ archiveRotate: { deleteAfterDays: Number.POSITIVE_INFINITY } },
			"sessions.archiveRotate.deleteAfterDays",
		],
		["a string deleteAfterDays", { archiveRotate: { deleteAfterDays: "30" } }, "sessions.archiveRotate.deleteAfterDays"],
		["a negative maxBytes", { archiveRotate: { maxBytes: -1 } }, "sessions.archiveRotate.maxBytes"],
		["a fractional maxBytes", { archiveRotate: { maxBytes: 1.5 } }, "sessions.archiveRotate.maxBytes"],
		["a string maxBytes", { archiveRotate: { maxBytes: "1024" } }, "sessions.archiveRotate.maxBytes"],
		[
			"an infinite maxBytes",
			{ archiveRotate: { maxBytes: Number.POSITIVE_INFINITY } },
			"sessions.archiveRotate.maxBytes",
		],
	];
	for (const [label, value, expected] of rejects) {
		let message = "";
		try {
			validateSessionsConfig(value);
		} catch (error) {
			message = error instanceof Error ? error.message : String(error);
		}
		check(`${label} is rejected`, message.startsWith(expected), message || "accepted");
	}
	let maxBytesMessage = "";
	try {
		validateSessionsConfig({ archiveRotate: { maxBytes: -1 } });
	} catch (error) {
		maxBytesMessage = error instanceof Error ? error.message : String(error);
	}
	check(
		"the maxBytes error names the exact contract",
		maxBytesMessage === "sessions.archiveRotate.maxBytes must be a non-negative whole number of bytes",
		maxBytesMessage,
	);
	for (const [label, value, expected] of [
		["a non-object sessions block", "nope", "sessions must be an object"],
		["a non-object archiveRotate block", { archiveRotate: "nope" }, "sessions.archiveRotate must be an object"],
	] as Array<[string, unknown, string]>) {
		let message = "";
		try {
			validateSessionsConfig(value);
		} catch (error) {
			message = error instanceof Error ? error.message : String(error);
		}
		check(`${label} is rejected`, message.startsWith(expected), message || "accepted");
	}
	writeConfig(root, { sessions: { archiveRotate: { enabled: true, gzipAfterDays: 10, deleteAfterDays: 5 } } });
	let loadMessage = "";
	try {
		load();
	} catch (error) {
		loadMessage = error instanceof Error ? error.message : String(error);
	}
	check(
		"loadConfig rejects deleteAfterDays below gzipAfterDays",
		loadMessage.startsWith("sessions.archiveRotate.deleteAfterDays must be >="),
		loadMessage || "accepted",
	);
	fs.rmSync(root, { recursive: true, force: true });
}

process.stdout.write(`\n${failures === 0 ? "all config tests passed" : `${failures} config test(s) failed`}\n`);
process.exitCode = failures === 0 ? 0 : 1;