import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { readJson } from "./util.js";

export interface LoopConfig {
	/**
	 * How often the runtime re-reads the durable inbox. Used both by the idle tool
	 * (which blocks waiting for events) and by the background scheduler that fires
	 * due reminders. This is the polling pulse of the runtime.
	 */
	pollIntervalMs: number;
	/**
	 * How long a single `idle` may last before the agent is offered a sleep
	 * (context reset). The agent may refuse with `idle({ important: true })`.
	 */
	sleepAfterMs: number;
	/**
	 * Active (non-idle) wall-clock limit for one run. Waiting inside `idle` does
	 * not count: a long-lived agent may idle for hours but may not burn the model
	 * for hours without ever yielding.
	 */
	runTimeoutMs: number;
	/** Max events returned by one `idle` call. The rest are delivered on the next idle. */
	maxEventsPerIdle: number;
	/** How many times an unanswered user message is carried over before we stop nudging. */
	maxNudges: number;
	/** How many times we re-prompt after the agent stops without calling idle/sleep. */
	maxNudgesPerRun: number;
	/** Allow interrupt-notification events to be steered into a running agent. */
	interrupt: boolean;
}

export interface BudgetConfig {
	/** 0 = unlimited. */
	maxDailyCostUsd: number;
	/** 0 = unlimited. */
	maxWakesPerHour: number;
}

export interface HttpConfig {
	enabled: boolean;
	host: string;
	port: number;
	/** Optional bearer token. Empty = no auth (bind to loopback only). */
	token: string;
}

export interface ChatConfig {
	console: boolean;
	http: HttpConfig;
}

/**
 * Telegram module settings.
 *
 * A bot token is a secret: keep it in the environment (`tokenEnv`) rather than
 * in a committed config file. `token` is a convenience for local setups and is
 * only used when the environment variable is empty.
 */
export interface TelegramConfig {
	enabled: boolean;
	token: string;
	/** Environment variable holding the bot token. Wins over `token` when set. */
	tokenEnv: string;
	/** Bot API base URL. Override for a local bot-api server. */
	apiBase: string;
	/** Chat allowlist (chat ids). Empty = every chat the bot can see. */
	allowedChatIds: string[];
	/** User allowlist (user ids). Empty = every user. */
	allowedUserIds: string[];
	/** Long-poll timeout for getUpdates, in seconds. */
	pollTimeoutSec: number;
	/** Telegram update types to subscribe to. */
	allowedUpdates: string[];
	/** "" (plain text) or "HTML". MarkdownV2 is accepted but fragile. */
	parseMode: string;
	/** Show link previews on outgoing messages. */
	linkPreview: boolean;
	/** Send "typing…" while the agent is working on a reply. */
	typingIndicator: boolean;
	/** Emoji reaction added to inbound user messages as an acknowledgement. Empty = off. */
	ackReaction: string;
	/** Treat edited messages / channel posts as events too. */
	ingestEdits: boolean;
	/** Keep at most N messages per chat locally. 0 = unlimited. */
	historyLimitPerThread: number;
	/** Split outgoing messages longer than this many characters. Telegram hard-limits 4096. */
	maxMessageChars: number;
}

/** Grafana-compatible inbound webhook module (alerts and annotations → events). */
export interface GrafanaConfig {
	enabled: boolean;
	host: string;
	port: number;
	path: string;
	/** Optional bearer token required on incoming requests. Empty = no auth. */
	token: string;
	/** Priority used for `firing` alerts. */
	firingPriority: "low" | "normal" | "high" | "interrupt";
	/** Priority used for `resolved` alerts. */
	resolvedPriority: "low" | "normal" | "high" | "interrupt";
}

/** A module loaded from the user's project rather than from `src/modules/`. */
export interface ExternalModuleConfig {
	name: string;
	/** Path to a JS/TS file, relative to the project root or absolute. */
	path: string;
	enabled: boolean;
	/** Arbitrary JSON handed to the module factory. */
	options: Record<string, unknown>;
}

export interface ModulesConfig {
	telegram: TelegramConfig;
	grafana: GrafanaConfig;
	/** Modules written by the user: `{ name, path, options }`. */
	external: ExternalModuleConfig[];
}

export interface ToolsConfig {
	builtin: string[];
	/** Allow bash in the agent workspace. */
	bash: boolean;
}

export interface AliveConfig {
	name: string;
	/** Model spec, e.g. "anthropic/claude-sonnet-4-5:high". Empty = use the default from ~/.pi/agent/settings.json. */
	model: string;
	thinkingLevel: string;
	stateDir: string;
	workspace: string;
	soulFile: string;
	/** "continue" keeps one evolving transcript across restarts; "new" starts a fresh session each start. */
	session: "continue" | "new";
	tools: ToolsConfig;
	loop: LoopConfig;
	budget: BudgetConfig;
	chat: ChatConfig;
	/** Event modules: inbound events, outbound delivery, extra agent tools. */
	modules: ModulesConfig;
	verbose: boolean;
	/** Extra pi extension files/globs loaded into the agent. */
	extensions: string[];
	/** Directory holding pi credentials/models. Default: ~/.pi/agent */
	piAgentDir: string;
}

export interface Paths {
	rootDir: string;
	stateDir: string;
	workspaceDir: string;
	agentDir: string;
	sessionsDir: string;
	logsDir: string;
	inboxDir: string;
	outboxDir: string;
	runsDir: string;
	journalDir: string;
	historyDir: string;
	modulesDir: string;
	soulPath: string;
	configPath: string;
	logFile: string;
	thoughtsFile: string;
}

export interface LoadedConfig {
	config: AliveConfig;
	paths: Paths;
}

export const DEFAULT_CONFIG: AliveConfig = {
	name: "Alive",
	model: "",
	thinkingLevel: "",
	stateDir: ".alive",
	workspace: ".alive/workspace",
	soulFile: "SOUL.md",
	session: "continue",
	tools: {
		builtin: ["read", "write", "edit", "bash", "grep", "find", "ls"],
		bash: true,
	},
	loop: {
		pollIntervalMs: 750,
		sleepAfterMs: 15 * 60_000,
		runTimeoutMs: 4 * 60_000,
		maxEventsPerIdle: 8,
		maxNudges: 3,
		maxNudgesPerRun: 5,
		interrupt: true,
	},
	budget: {
		maxDailyCostUsd: 0,
		maxWakesPerHour: 0,
	},
	chat: {
		console: true,
		http: {
			enabled: false,
			host: "127.0.0.1",
			port: 4321,
			token: "",
		},
	},
	modules: {
		telegram: {
			enabled: false,
			token: "",
			tokenEnv: "ALIVE_TELEGRAM_TOKEN",
			apiBase: "https://api.telegram.org",
			allowedChatIds: [],
			allowedUserIds: [],
			pollTimeoutSec: 25,
			allowedUpdates: [
				"message",
				"edited_message",
				"channel_post",
				"edited_channel_post",
				"callback_query",
			],
			parseMode: "",
			linkPreview: true,
			typingIndicator: true,
			ackReaction: "",
			ingestEdits: true,
			historyLimitPerThread: 0,
			maxMessageChars: 4000,
		},
		grafana: {
			enabled: false,
			host: "127.0.0.1",
			port: 4322,
			path: "/grafana",
			token: "",
			firingPriority: "high",
			resolvedPriority: "low",
		},
		external: [],
	},
	verbose: false,
	extensions: [],
	piAgentDir: path.join(os.homedir(), ".pi", "agent"),
};

export function resolvePaths(rootDir: string, config: AliveConfig): Paths {
	const stateDir = path.resolve(rootDir, config.stateDir);
	const agentDir = path.join(stateDir, "agent");
	return {
		rootDir,
		stateDir,
		workspaceDir: path.resolve(rootDir, config.workspace),
		agentDir,
		sessionsDir: path.join(stateDir, "sessions"),
		logsDir: path.join(stateDir, "logs"),
		inboxDir: path.join(stateDir, "inbox"),
		outboxDir: path.join(stateDir, "outbox"),
		runsDir: path.join(stateDir, "runs"),
		journalDir: path.join(stateDir, "journal"),
		historyDir: path.join(stateDir, "history"),
		modulesDir: path.join(stateDir, "modules"),
		soulPath: path.resolve(rootDir, config.soulFile),
		configPath: path.join(rootDir, "alive.config.json"),
		logFile: path.join(stateDir, "logs", "alive.jsonl"),
		thoughtsFile: path.join(stateDir, "logs", "thoughts.jsonl"),
	};
}

function deepMerge<T>(base: T, override: Partial<T> | undefined): T {
	if (!override) return base;
	const out: Record<string, unknown> = { ...(base as Record<string, unknown>) };
	for (const [key, value] of Object.entries(override as Record<string, unknown>)) {
		if (value === undefined) continue;
		const prev = out[key];
		if (
			value !== null &&
			typeof value === "object" &&
			!Array.isArray(value) &&
			prev !== null &&
			typeof prev === "object" &&
			!Array.isArray(prev)
		) {
			out[key] = deepMerge(prev as Record<string, unknown>, value as Record<string, unknown>);
		} else {
			out[key] = value;
		}
	}
	return out as T;
}

export interface LoadConfigOptions {
	cwd: string;
	configPath?: string;
	overrides?: Partial<AliveConfig>;
}

export function loadConfig(options: LoadConfigOptions): LoadedConfig {
	const rootDir = path.resolve(options.cwd);
	const configPath = options.configPath ? path.resolve(options.configPath) : path.join(rootDir, "alive.config.json");
	const fileConfig = fs.existsSync(configPath) ? readJson<Partial<AliveConfig>>(configPath, {}) : {};
	// Machine-local, gitignored overrides (secrets, ports, tokens).
	const localConfigPath = path.join(path.dirname(configPath), "alive.config.local.json");
	const localConfig = fs.existsSync(localConfigPath) ? readJson<Partial<AliveConfig>>(localConfigPath, {}) : {};
	const merged = deepMerge(deepMerge(deepMerge(DEFAULT_CONFIG, fileConfig), localConfig), options.overrides);
	migrateLoopConfig(merged.loop as unknown as Record<string, unknown>);
	merged.piAgentDir = expandHome(merged.piAgentDir);
	const paths = resolvePaths(path.dirname(configPath), merged);
	return { config: merged, paths };
}

/**
 * Accept configs written for the wake-per-batch runtime so existing
 * `alive.config.json` files keep working. The old keys only fill in when the
 * new key is absent, so explicit new values always win.
 */
function migrateLoopConfig(loop: Record<string, unknown>): void {
	const aliases: Array<[string, string]> = [
		["heartbeatMs", "sleepAfterMs"],
		["wakeTimeoutMs", "runTimeoutMs"],
		["maxEventsPerWake", "maxEventsPerIdle"],
	];
	for (const [oldKey, newKey] of aliases) {
		if (loop[newKey] === undefined && loop[oldKey] !== undefined) loop[newKey] = loop[oldKey];
		delete loop[oldKey];
	}
	// The per-run LLM turn limit was removed: only the active-time watchdog and
	// the budget guard bound a run. Clean the key out of configs that still have it.
	delete loop.maxTurnsPerWake;
	delete loop.maxTurnsPerRun;
}

function expandHome(value: string): string {
	if (value === "~") return os.homedir();
	if (value.startsWith("~/")) return path.join(os.homedir(), value.slice(2));
	return value;
}

/**
 * Config written by `alive init`. Deliberately omits machine-specific defaults
 * (piAgentDir) so the file is portable and safe to commit.
 */
export function configTemplate(): Omit<AliveConfig, "piAgentDir"> {
	const { piAgentDir: _piAgentDir, ...rest } = DEFAULT_CONFIG;
	return rest;
}

export function writeDefaultConfig(rootDir: string): { configPath: string; soulPath: string } {
	const configPath = path.join(rootDir, "alive.config.json");
	const soulPath = path.join(rootDir, "SOUL.md");
	if (!fs.existsSync(configPath)) {
		fs.writeFileSync(configPath, `${JSON.stringify(configTemplate(), null, 2)}\n`, "utf8");
	}
	if (!fs.existsSync(soulPath)) {
		fs.writeFileSync(soulPath, DEFAULT_SOUL, "utf8");
	}
	return { configPath, soulPath };
}

/**
 * Resolve the default model spec from the shared pi settings so `alive` works
 * out of the box on the same provider the user already configured for pi.
 */
export function defaultModelSpec(piAgentDir: string): string {
	const settings = readJson<{ defaultProvider?: string; defaultModel?: string; defaultThinkingLevel?: string }>(
		path.join(piAgentDir, "settings.json"),
		{},
	);
	const provider = settings.defaultProvider;
	const model = settings.defaultModel;
	if (!provider || !model) return "";
	const thinking = settings.defaultThinkingLevel;
	return thinking ? `${provider}/${model}:${thinking}` : `${provider}/${model}`;
}

export const DEFAULT_SOUL = `# Who you are

You are Alive: a persistent agent that lives continuously instead of inside a chat window.
You stay awake and work until you decide to wait (\`idle\`), and you sleep only when you choose to
(\`sleep\`), which resets your context but not your memory.

You have a name, a workspace, a journal, notes, and a set of reminders you control.
Your continuity is: this conversation while you are awake, \`journal/\`, \`notes\`, and your
scheduled reminders. If it is not written down, sleep will erase it.

# What you care about

- Being genuinely useful to the humans who write to you.
- Keeping promises: if you say you will check something later, schedule a reminder.
- Not pretending. If you did not do something, say so.
- Quiet competence: long silences are fine; unrequested chatter is not.

# Style

- Write like a person: short, concrete, warm, no corporate filler.
- No markdown headings or bullet spam in chat messages unless it genuinely helps.
- One message is usually enough. Do not narrate your internal process.
`;
