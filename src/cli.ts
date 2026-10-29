import * as fs from "node:fs";
import * as path from "node:path";
import { configureAgentTelegram, createAgent, disableManagedAgent, enableManagedAgent, ensureAdminAgent, getAgentEnabled, listAgents, restartManagedAgent, startManagedAgent, stopManagedAgent, updateManagedAgentProfile, validateAgentId } from "./agents.js";
import type { AliveConfig, LoadedConfig } from "./config.js";
import { DEFAULT_CONFIG, loadConfig, redactSecretFields, writeDefaultConfig, migrateConfigSecrets } from "./config.js";
import { Logger } from "./log.js";
import { EventStore, type EventPriority } from "./store/events.js";
import { ReminderStore } from "./store/reminders.js";
import { PolicyStore, type NotifyMode } from "./store/policy.js";
import { ThreadStore } from "./store/threads.js";
import { RunLog, readRuntimeState } from "./store/runs.js";
import { HistoryStore, type HistoryDirection, type HistoryQuery } from "./store/history.js";
import { Outbox } from "./store/outbox.js";
import { listLocalMessages, operatorAgentThread, sendLocalAgentMessage } from "./runtime/agent-messaging.js";
import { runAgentConsole } from "./tui/agent-console.js";
import { describeModules } from "./events/loader.js";
import { TelegramApi } from "./modules/telegram/client.js";
import { requestAgentTelegram } from "./modules/telegram/managed-request.js";
import { resolveToken } from "./modules/telegram/module.js";
import { browserCommand } from "./modules/browser/cli.js";
import { TelegramAllowlistStore } from "./modules/telegram/state.js";
import { AliveRuntime } from "./runtime/loop.js";
import { readHeartbeatStatus } from "./heartbeat.js";
import { snapshotRuntime, spawnBackground, stdoutLogPath, stopRuntime, waitForRuntime, type StopResult } from "./runtime/daemon.js";
import {
	HARNESS_ENV_MARKER,
	detectHarnessEnvironment,
	interruptWarningLine,
	restartRefusalText,
} from "./runtime/harness-guard.js";
import { LOG_SOURCES, followFile, readLogTail, renderLogLine, resolveLogSource } from "./logs.js";
import { WorkerStore, validateWorkerId, workerLabel } from "./workers/store.js";
import { gitDiff, gitState, isGitRepository } from "./workers/worktree.js";
import { createHostWorkerEnvironment } from "./workers/environment.js";
import { renderWorkerRecord } from "./workers/manager.js";
import { term } from "./term.js";
import { createExecRunner, runUpdate } from "./update.js";
import {
	formatDuration,
	iso,
	isProcessAlive,
	oneLine,
	parseDurationMs,
	parseTimeSpec,
	parseTimestamp,
	tailLines,
	truncate,
} from "./util.js";

interface ParsedArgs {
	command: string;
	positionals: string[];
	flags: Record<string, string | boolean>;
}

/**
 * The start/stop side of `alive restart`, behind a seam so CLI tests can drive
 * the command with a fake service control instead of real processes.
 */
export interface ServiceControl {
	stop(config: LoadedConfig, flags: Record<string, string | boolean>): Promise<StopResult>;
	/** Returns the exit code of the start (0 = the runtime came up). */
	start(config: LoadedConfig, flags: Record<string, string | boolean>): Promise<number>;
}

export interface CliOptions {
	/** Environment the harness guard inspects; defaults to `process.env`. */
	env?: NodeJS.ProcessEnv;
	/** Service start/stop seam; defaults to the real background runtime control. */
	service?: ServiceControl;
}

export function parseArgs(argv: string[]): ParsedArgs {
	const command = argv[0] ?? "help";
	const positionals: string[] = [];
	const flags: Record<string, string | boolean> = {};
	for (let i = 1; i < argv.length; i += 1) {
		const token = argv[i]!;
		if (token.startsWith("--") || (token.startsWith("-") && token.length === 2 && !/^-\d/.test(token))) {
			const key = token.replace(/^--?/, "");
			const eq = key.indexOf("=");
			if (eq >= 0) {
				flags[key.slice(0, eq)] = key.slice(eq + 1);
				continue;
			}
			const next = argv[i + 1];
			if (next !== undefined && !next.startsWith("-")) {
				flags[key] = next;
				i += 1;
			} else {
				flags[key] = true;
			}
			continue;
		}
		positionals.push(token);
	}
	return { command, positionals, flags };
}

function flagString(flags: Record<string, string | boolean>, key: string): string | undefined {
	const value = flags[key];
	return typeof value === "string" ? value : undefined;
}

function flagBool(flags: Record<string, string | boolean>, key: string): boolean {
	return flags[key] === true || flags[key] === "true" || flags[key] === "1";
}

/**
 * Usage for the service commands. `--help` on `alive stop|restart|status` must
 * print this and touch nothing: the commands act on the running harness, and an
 * agent asking for help must never stop the run that asked.
 */
const SERVICE_USAGE: Record<"stop" | "restart" | "status", string> = {
	stop:
		"usage: alive stop [--timeout DURATION] [--force] [--config CONFIG]\n" +
		"\n" +
		"  --timeout DURATION  graceful SIGTERM window before SIGKILL (default 15s)\n" +
		"  --force, --kill     skip SIGTERM and kill immediately\n" +
		"  --config CONFIG     config file (default ./alive.config.json)\n" +
		"\n" +
		"Stops the background runtime of the current project. One warning line always\n" +
		"states that the run in progress is interrupted; stop is never refused, so it\n" +
		"remains the way to shut the harness down from inside.\n",
	restart:
		"usage: alive restart [--yes] [--timeout DURATION] [--force] [--config CONFIG] [--model MODEL] [--verbose]\n" +
		"\n" +
		"  --yes, -y           restart even from inside the harness (ends this run)\n" +
		"  --timeout DURATION  graceful SIGTERM window before SIGKILL (default 15s)\n" +
		"  --force, --kill     skip SIGTERM and kill the old runtime immediately\n" +
		"  --config CONFIG     config file (default ./alive.config.json)\n" +
		"  --model MODEL       model for the restarted runtime\n" +
		"  --verbose           verbose logging for the restarted runtime\n" +
		"\n" +
		"Stops the running instance, then starts a fresh one in the background. Refused\n" +
		"when this process runs inside the harness (ALIVE_RUNTIME, or systemd's\n" +
		"INVOCATION_ID/SYSTEMD_EXEC_PID/JOURNAL_STREAM when they belong to the harness\n" +
		"unit), because the restart would kill the run that issued it. Safe forms from\n" +
		"outside:\n" +
		"  systemd-run --on-active=5 --unit=alive-restart /path/to/alive restart\n" +
		"  sudo systemctl restart alive.service\n",
	status:
		"usage: alive status [--json] [--config CONFIG]\n" +
		"\n" +
		"  --json           machine-readable snapshot\n" +
		"  --config CONFIG  config file (default ./alive.config.json)\n" +
		"\n" +
		"Reads state only: it never starts, stops or restarts anything.\n",
};

/** Print the usage and report true when `--help`/`-h` was given; does nothing else. */
function printServiceHelp(command: "stop" | "restart" | "status", flags: Record<string, string | boolean>): boolean {
	// Presence, not truthiness: `alive restart --help` must never restart, even
	// if a stray token made the flag parser read `--help` as taking a value.
	if (flags.help === undefined && flags.h === undefined) return false;
	process.stdout.write(`${SERVICE_USAGE[command]}\n`);
	return true;
}

export function createServiceControl(): ServiceControl {
	return {
		stop: (config, flags) => {
			const timeoutFlag = flagString(flags, "timeout");
			return stopRuntime(config.paths.stateDir, {
				timeoutMs: timeoutFlag ? parseDurationMs(timeoutFlag) : undefined,
				force: flagBool(flags, "force") || flagBool(flags, "kill"),
			});
		},
		start: (config, flags) => startBackground(config, flags),
	};
}

export async function main(argv: string[], options: CliOptions = {}): Promise<number> {
	const { command, positionals, flags } = parseArgs(argv);
	const cwd = process.cwd();

	try {
		switch (command) {
			case "config": {
				return configCommand(cwd, flags, positionals);
			}
			case "init": {
				const { configPath, soulPath } = writeDefaultConfig(cwd);
				const admin = ensureAdminAgent(loadConfig({ cwd, configPath }));
				process.stdout.write(`created ${path.relative(cwd, configPath) || configPath}\n`);
				process.stdout.write(`created ${path.relative(cwd, soulPath) || soulPath}\n`);
				process.stdout.write(`administrator agent: ${admin.id} (${admin.configPath})\n`);
				process.stdout.write(`next: npm run run   (or: npm run dev -- run)\n`);
				return 0;
			}
			case "run": {
				return await runCommand(cwd, flags);
			}
			case "agents": {
				return agentsCommand(cwd, flags, positionals);
			}
			case "workers": {
				return workersCommand(cwd, flags, positionals);
			}
			case "sandbox": {
				if (positionals.length && positionals[0] !== "status") throw new Error("usage: alive sandbox status [--config CONFIG]");
				const config = loadForCli(flags);
				if (!config.config.sandbox.enabled) { process.stdout.write('sandbox disabled (host execution explicitly enabled)\n'); return 0; }
				const { SandboxManager } = await import("./sandbox/manager.js");
				const manager = new SandboxManager(config, makeLogger(config));
				try { process.stdout.write(`${JSON.stringify(await manager.control("status"), null, 2)}\n`); }
				finally { await manager.close(); }
				return 0;
			}
			case "stop": {
				if (printServiceHelp("stop", flags)) return 0;
				process.stderr.write(`${interruptWarningLine("stop")}\n`);
				return await stopCommand(cwd, flags, options);
			}
			case "restart": {
				if (printServiceHelp("restart", flags)) return 0;
				process.stderr.write(`${interruptWarningLine("restart")}\n`);
				return await restartCommand(cwd, flags, options);
			}
			case "update": {
				const usage =
					"usage: alive update [--check] [--tag vX.Y.Z] [--force] | alive update --rollback [--force] | alive update --status | alive update --auto";
				if (flagBool(flags, "help") || flagBool(flags, "h")) {
					process.stdout.write(
						`${usage}\n\n` +
							"  --check          report the current ref, latest stable tag, marker and dist/; change nothing\n" +
							"  --rollback       restore previousRef from the marker and dist.prev/ (no network needed)\n" +
							"  --status         report the current ref, marker contents and dist/dist.prev presence\n" +
							"  --auto           unattended: run the guards and apply only if they all allow it\n" +
							"                   (updates.auto, updates.window, an idle runtime, a newer tag)\n" +
							"  --tag vX.Y.Z     target an explicit stable tag instead of the latest one\n" +
							"  --force          allow apply/rollback with a dirty working tree (local changes are kept)\n\n" +
							"Exit codes with --auto: 0 = nothing to do, 1 = failed and rolled back,\n" +
							"10 = updated; restart me (the marker has restartRequested: true).\n" +
							"The update is applied without --check. Neither mode restarts the running harness;\n" +
							"with --auto an external watchdog restarts it after exit 10.\n",
					);
					return 0;
				}
				const known = new Set(["check", "dry-run", "apply", "rollback", "status", "auto", "tag", "force", "help", "h"]);
				const unknown = Object.keys(flags).filter((key) => !known.has(key));
				if (unknown.length > 0) throw new Error(`unknown flag${unknown.length === 1 ? "" : "s"}: --${unknown.join(", --")} (${usage})`);
				if (positionals.length > 0) throw new Error(usage);
				if (flags["tag"] === true) throw new Error("--tag requires a value (vX.Y.Z)");

				const check = flagBool(flags, "check") || flagBool(flags, "dry-run");
				const apply = flagBool(flags, "apply");
				const rollback = flagBool(flags, "rollback");
				const status = flagBool(flags, "status");
				const auto = flagBool(flags, "auto");
				if ([check, apply, rollback, status, auto].filter(Boolean).length > 1) {
					throw new Error("choose one of --check, --apply, --rollback, --status, --auto");
				}
				if ((rollback || status || auto) && flagString(flags, "tag") !== undefined) {
					throw new Error("--tag cannot be combined with --rollback, --status or --auto");
				}
				if ((status || auto) && flagBool(flags, "force")) throw new Error("--force is only used with apply or --rollback");

				if (auto) {
					const config = loadForCli(flags);
					const now = Date.now();
					const heartbeat = readHeartbeatStatus(config.paths.stateDir, config.config.updates.heartbeatStaleMs, now);
					const runtime = readRuntimeState(config.paths.stateDir);
					return await runUpdate(
						{ cwd, auto: true },
						{
							run: createExecRunner(),
							auto: {
								updates: config.config.updates,
								heartbeatAgeMs: heartbeat.ageMs,
								runtimeStatus: runtime?.status,
								runtimeRunId: runtime?.runId,
								now: new Date(now),
							},
						},
					);
				}

				return await runUpdate(
					{
						cwd,
						check,
						rollback,
						status,
						tag: flagString(flags, "tag"),
						force: flagBool(flags, "force"),
					},
					{ run: createExecRunner() },
				);
			}
			case "logs":
			case "log": {
				return await logsCommand(cwd, flags);
			}
			case "say": {
				return sayCommand(cwd, flags, positionals.join(" "));
			}
			case "emit": {
				return emitCommand(cwd, flags, positionals.join(" "));
			}
			case "remind": {
				return remindCommand(cwd, flags, positionals.join(" "));
			}
			case "reminders": {
				return remindersCommand(cwd, flags);
			}
			case "status": {
				if (printServiceHelp("status", flags)) return 0;
				return statusCommand(cwd, flags);
			}
			case "heartbeat": {
				return heartbeatCommand(flags, positionals);
			}
			case "runs": {
				return runsCommand(cwd, flags);
			}
			case "wakes": {
				return runsCommand(cwd, flags);
			}
			case "policy": {
				return policyCommand(cwd, positionals);
			}
			case "modules": {
				return modulesCommand(cwd, flags);
			}
			case "history": {
				return historyCommand(cwd, flags, positionals);
			}
			case "telegram": {
				return await telegramCommand(cwd, flags, positionals);
			}
			case "browser": {
				return await browserCommand(loadForCli(flags), positionals[0] ?? "help", flags);
			}
			case "thoughts": {
				return thoughtsCommand(cwd, flags);
			}
			default: {
				printHelp();
				return command === "help" || command === "--help" || command === "-h" ? 0 : 1;
			}
		}
	} catch (err) {
		process.stderr.write(`${term.red("error:")} ${err instanceof Error ? err.message : String(err)}\n`);
		return 1;
	}
}

function loadForCli(
	flags: Record<string, string | boolean>,
	options: { migrateSecrets?: boolean } = {},
): LoadedConfig {
	const overrides: Partial<AliveConfig> = {};
	const model = flagString(flags, "model");
	if (model) overrides.model = model;
	const thinking = flagString(flags, "thinking");
	if (thinking) overrides.thinkingLevel = thinking;
	if (flagBool(flags, "verbose")) overrides.verbose = true;
	return loadConfig({
		cwd: process.cwd(),
		configPath: flagString(flags, "config"),
		overrides,
		migrateSecrets: options.migrateSecrets,
	});
}

function configCommand(cwd: string, flags: Record<string, string | boolean>, positionals: string[]): number {
	const action = positionals[0] ?? "show";
	const configPath = flagString(flags, "config")
		? path.resolve(flagString(flags, "config")!)
		: path.join(cwd, "alive.config.json");
	if (action === "migrate-secrets") {
		if (!fs.existsSync(configPath)) throw new Error(`config not found: ${configPath}`);
		const localConfigPath = path.join(path.dirname(configPath), "alive.config.local.json");
		const json = flagBool(flags, "json");
		const dryRun = flagBool(flags, "dry-run");
		const report = migrateConfigSecrets({
			configPaths: [configPath, localConfigPath],
			defaults: DEFAULT_CONFIG,
			dryRun,
			log: json ? () => undefined : (line) => process.stdout.write(`${line}\n`),
			warn: json ? () => undefined : (line) => process.stderr.write(`${line}\n`),
		});
		if (json) process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
		return 0;
	}
	if (action !== "show") throw new Error("usage: alive config [show [--json]] | alive config migrate-secrets [--dry-run] [--json] [--config CONFIG]");
	const loaded = loadForCli(flags, { migrateSecrets: false });
	const safe = redactSecretFields(loaded.config);
	process.stdout.write(`${JSON.stringify(safe, null, 2)}\n`);
	return 0;
}

function makeLogger(config: LoadedConfig, quiet = true): Logger {
	return new Logger({
		file: config.paths.logFile,
		level: config.config.verbose ? "debug" : "info",
		console: !quiet,
		scope: "alive",
		secrets: config.config.secrets,
	});
}

async function runCommand(cwd: string, flags: Record<string, string | boolean>): Promise<number> {
	// Every child of this process (agent tools, workers, the TUI) inherits the
	// marker, which is how `alive restart` notices it would kill its own run.
	process.env[HARNESS_ENV_MARKER] = "1";
	const config = loadForCli(flags);
	if (!config.config.enabled) {
		process.stderr.write(`${term.red("agent is disabled:")} ${config.config.name}; enable it before starting\n`);
		return 1;
	}
	// `--once` is a one-shot debug run, so it stays attached; everything else goes
	// to the background and is managed with stop/restart/logs/status.
	const once = flagBool(flags, "once");
	if (!once && !flagBool(flags, "foreground") && !flagBool(flags, "fg") && !flagBool(flags, "attach")) {
		return startBackground(config, flags);
	}

	const log = makeLogger(config, false);
	const runtime = await AliveRuntime.create({ config, log, force: flagBool(flags, "force") });

	let stopping = false;
	const onSignal = () => {
		if (stopping) return;
		stopping = true;
		void runtime.stop("signal");
	};
	process.on("SIGINT", onSignal);
	process.on("SIGTERM", onSignal);
	// Closing the terminal (SIGHUP) should shut down gracefully, not leave the inbox
	// marked mid-run and force an "interrupted run" recovery on the next start.
	process.on("SIGHUP", onSignal);

	if (once) {
		await runtime.init();
		const record = await runtime.runOnce();
		await runtime.stop("once");
		return record ? 0 : 0;
	}
	await runtime.run();
	return 0;
}

/** Flags the detached child must inherit to behave like the command just typed. */
function forwardedRunFlags(flags: Record<string, string | boolean>): string[] {
	const forwarded: string[] = [];
	const config = flagString(flags, "config");
	if (config) forwarded.push("--config", config);
	const model = flagString(flags, "model");
	if (model) forwarded.push("--model", model);
	const thinking = flagString(flags, "thinking");
	if (thinking) forwarded.push("--thinking", thinking);
	if (flagBool(flags, "verbose")) forwarded.push("--verbose");
	if (flagBool(flags, "force")) forwarded.push("--force");
	return forwarded;
}

function printLogTail(file: string, lines: number): void {
	const tail = readLogTail(file, lines);
	if (tail.length === 0) {
		process.stderr.write(`${term.gray(`(no output in ${file})`)}\n`);
		return;
	}
	process.stderr.write(`${term.gray(`last ${tail.length} line(s) of ${file}:`)}\n`);
	for (const line of tail) {
		const rendered = renderLogLine("stdout", line);
		if (rendered) process.stderr.write(`${rendered}\n`);
	}
}

async function startBackground(config: LoadedConfig, flags: Record<string, string | boolean>): Promise<number> {
	const existing = snapshotRuntime(config.paths.stateDir);
	if (existing?.alive) {
		if (!flagBool(flags, "force")) {
			process.stderr.write(
				`${term.yellow("already running")} — pid ${existing.pid}, ${existing.state.status}` +
					`${existing.suspended ? term.red(", SUSPENDED (serves nothing)") : ""}, up ${formatDuration(existing.uptimeMs)}\n` +
					`${term.dim("alive restart        replace it\nalive logs -f        watch it\nalive stop           stop it")}\n`,
			);
			return 1;
		}
		process.stderr.write(
			`${term.yellow("warning:")} starting a second runtime while pid ${existing.pid} is alive — cursors will race\n`,
		);
	} else if (existing && !existing.cleanStop) {
		process.stderr.write(
			`${term.gray(`stale runtime state (pid ${existing.pid}, ${existing.state.status}) — recovering`)}${existing.suspended ? term.red(" (was suspended)") : ""}\n`,
		);
	}

	const handle = spawnBackground({ paths: config.paths, args: forwardedRunFlags(flags) });
	const snapshot = await waitForRuntime(config.paths.stateDir, handle.pid, { child: handle.child });
	if (!snapshot) {
		process.stderr.write(`${term.red("failed to start:")} pid ${handle.pid} did not come up\n`);
		printLogTail(handle.logFile, 15);
		return 1;
	}

	const logPath = path.relative(config.paths.rootDir, handle.logFile) || handle.logFile;
	process.stdout.write(
		`${term.green("started")} ${config.config.name} in background (pid ${handle.pid}, mode ${snapshot.state.mode ?? "background"})\n` +
			`  alive logs -f     follow ${logPath}\n` +
			`  alive status      state, inbox, threads\n` +
			`  alive stop        graceful stop (SIGTERM, then SIGKILL)\n`,
	);
	return 0;
}

async function stopCommand(cwd: string, flags: Record<string, string | boolean>, options: CliOptions = {}): Promise<number> {
	return await stopWithConfig(loadForCli(flags), flags, options);
}

async function stopWithConfig(
	config: LoadedConfig,
	flags: Record<string, string | boolean>,
	options: CliOptions = {},
): Promise<number> {
	const service = options.service ?? createServiceControl();
	const result = await service.stop(config, flags);

	if (result.alreadyStopped) {
		process.stdout.write(`not running${result.pid ? term.gray(` (last pid ${result.pid})`) : ""}\n`);
		return 0;
	}
	if (!result.stopped) {
		process.stderr.write(`${term.red("failed to stop:")} ${result.error ?? "unknown reason"}\n`);
		return 1;
	}
	const how = result.forceKilled ? "SIGKILL" : "SIGTERM";
	const woke = result.wasSuspended ? ", was suspended" : "";
	process.stdout.write(`${term.green("stopped")} pid ${result.pid} (${how}${woke})\n`);
	return 0;
}

async function restartCommand(cwd: string, flags: Record<string, string | boolean>, options: CliOptions = {}): Promise<number> {
	const config = loadForCli(flags);
	const env = options.env ?? process.env;
	const harnessPid = snapshotRuntime(config.paths.stateDir)?.pid;
	const detection = detectHarnessEnvironment(env, { harnessPid });

	if (detection.inside) {
		if (!flagBool(flags, "yes") && !flagBool(flags, "y")) {
			process.stderr.write(restartRefusalText(detection));
			return 1;
		}
		process.stderr.write(
			`${term.yellow("warning:")} --yes given — restarting from inside the harness ends this run\n`,
		);
	} else if (detection.outsideReason) {
		// e.g. the update watchdog unit, or the recommended systemd-run form.
		process.stderr.write(`${term.gray(`note: ${detection.outsideReason}`)}\n`);
	}

	const service = options.service ?? createServiceControl();
	const stopped = await stopWithConfig(config, flags, options);
	if (stopped !== 0) return stopped;
	return service.start(config, flags);
}

async function logsCommand(cwd: string, flags: Record<string, string | boolean>): Promise<number> {
	const config = loadForCli(flags);
	const requested = flagString(flags, "file") ?? flagString(flags, "source") ?? "stdout";
	const { source, file } = resolveLogSource(config.paths, requested);
	const json = flagBool(flags, "json");
	const render = (line: string): string | undefined => (json ? line : renderLogLine(source, line));
	// `-n 0` means "no history, only new lines" — hence an explicit 0 check.
	const requestedLines = flagString(flags, "n") ?? flagString(flags, "lines");
	const limit = flagBool(flags, "all")
		? Number.MAX_SAFE_INTEGER
		: requestedLines === undefined
			? 50
			: Math.max(0, Number(requestedLines) || 0);

	const tail = readLogTail(file, limit);
	for (const line of tail) {
		const rendered = render(line);
		if (rendered) process.stdout.write(`${rendered}\n`);
	}

	if (!flagBool(flags, "follow") && !flagBool(flags, "f")) {
		if (tail.length === 0) {
			process.stderr.write(`${term.gray(`nothing logged yet at ${file} (sources: ${LOG_SOURCES.join(", ")})`)}\n`);
		}
		return 0;
	}

	process.stdout.write(`${term.gray(`-- following ${file} (Ctrl+C to stop) --`)}\n`);
	const controller = new AbortController();
	const onSignal = () => controller.abort();
	process.on("SIGINT", onSignal);
	process.on("SIGTERM", onSignal);
	await followFile(
		file,
		(line) => {
			const rendered = render(line);
			if (rendered) process.stdout.write(`${rendered}\n`);
		},
		{ signal: controller.signal },
	);
	return 0;
}

async function agentsCommand(cwd: string, flags: Record<string, string | boolean>, positionals: string[]): Promise<number> {
	const base = loadForCli(flags);
	const action = positionals[0] ?? "list";
	if (action === "tui") {
		await runAgentConsole({
			listAgents: async () => listAgents(base).map((agent) => {
				const loaded = loadConfig({ cwd, configPath: agent.configPath });
				return {
					id: agent.id,
					name: loaded.config.name,
					enabled: getAgentEnabled(agent),
					running: snapshotRuntime(loaded.paths.stateDir)?.alive ?? false,
				};
			}),
			listMessages: async (id) => {
				const agent = findManagedAgent(base, id);
				const loaded = loadConfig({ cwd, configPath: agent.configPath });
				return HistoryStore.open(loaded.paths.stateDir).query({ module: "local", thread: operatorAgentThread(id), limit: 300, order: "asc" });
			},
			send: async (id, text) => {
				await sendLocalAgentMessage({ config: base, outbox: new Outbox(base.paths.stateDir), to: id, text, runId: `tui-${Date.now()}`, senderId: "operator", senderName: "Operator" });
			},
			start: async (id) => { await startManagedAgent(base, id); },
			stop: async (id) => { await stopManagedAgent(base, id); },
		});
		return 0;
	}
	if (action === "list") {
		const agents = listAgents(base);
		if (!agents.length) process.stdout.write("no agents; create one with: alive agents create <id>\n");
		for (const agent of agents) {
			const loaded = loadConfig({ cwd, configPath: agent.configPath });
			const snapshot = snapshotRuntime(loaded.paths.stateDir);
			const running = snapshot?.alive ? `running pid=${snapshot.pid}` : "stopped";
			const enabled = getAgentEnabled(agent) ? "enabled" : "disabled";
			process.stdout.write(`${agent.id.padEnd(20)} ${loaded.config.name}  ${enabled}  ${running}  workspace=${loaded.paths.workspaceDir}\n`);
		}
		return 0;
	}
	if (action === "send" || action === "message") {
		const recipientId = positionals[1];
		const text = positionals.slice(2).join(" ");
		if (!recipientId || !text.trim()) throw new Error("usage: alive agents send <agent-id> <message text>");
		const message = await sendLocalAgentMessage({
			config: base,
			outbox: new Outbox(base.paths.stateDir),
			to: recipientId,
			text,
			runId: `cli-${Date.now()}`,
			senderId: "operator",
			senderName: flagString(flags, "from") ?? "Operator",
		});
		process.stdout.write(`message ${message.id} delivered to ${message.recipientAgentId} (thread ${message.thread})\n`);
		return 0;
	}
	if (action === "inbox" || action === "read") {
		const agent = findManagedAgent(base, positionals[1]);
		const target = loadConfig({ cwd, configPath: agent.configPath });
		const thread = flagString(flags, "thread");
		const limit = Math.max(1, Math.min(Number(flagString(flags, "n") ?? 30) || 30, 1000));
		const messages = listLocalMessages(target, limit, thread);
		if (!messages.length) {
			process.stdout.write(`no local messages for ${agent.id}\n`);
			return 0;
		}
		for (const message of messages) {
			process.stdout.write(`${new Date(message.ts).toISOString()} ${message.direction} ${message.author ?? message.authorId ?? "unknown"} [${message.thread}]: ${message.text}\n`);
		}
		return 0;
	}
	if (["enable", "disable", "edit", "permissions"].includes(action)) {
		const id = positionals[1];
		if (!id) throw new Error(`usage: alive agents ${action} <id>`);
		const agent = findManagedAgent(base, id);
		if (action === "enable") {
			await enableManagedAgent(base, agent.id);
			process.stdout.write(`enabled ${agent.id}; start it with: alive agents start ${agent.id}\n`);
			return 0;
		}
		if (action === "disable") {
			await disableManagedAgent(base, agent.id);
			process.stdout.write(`disabled and stopped ${agent.id}\n`);
			return 0;
		}
		const updates: { name?: string; role?: string; contract?: string; toolAllowlist?: string[]; management?: import("./config.js").AgentManagementPermissions; sandbox?: Partial<import("./sandbox/config.js").SandboxConfig> } = {};
		if (action === "edit") {
			const name = flagString(flags, "name");
			const role = flagString(flags, "role");
			const contract = flagString(flags, "contract");
			const contractFile = flagString(flags, "contract-file");
			const tools = flagString(flags, "tools");
			const sandboxFile = flagString(flags, "sandbox-file");
			if (sandboxFile) updates.sandbox = JSON.parse((await import("node:fs")).readFileSync(path.resolve(cwd, sandboxFile), "utf8"));
			if (name !== undefined) updates.name = name;
			if (role !== undefined) updates.role = role;
			if (contract !== undefined && contractFile !== undefined) throw new Error("use only one of --contract or --contract-file");
			if (contract !== undefined) updates.contract = contract;
			if (contractFile !== undefined) updates.contract = (await import("node:fs")).readFileSync(path.resolve(cwd, contractFile), "utf8");
			if (tools !== undefined) updates.toolAllowlist = tools.split(",").map((tool) => tool.trim()).filter(Boolean);
		}
		const permissionFile = flagString(flags, "permissions-file");
		if (permissionFile) {
			updates.management = JSON.parse((await import("node:fs")).readFileSync(path.resolve(cwd, permissionFile), "utf8"));
		}
		if (!Object.keys(updates).length) throw new Error(`usage: alive agents ${action} ${agent.id} --name NAME --role ROLE --contract TEXT --tools read,write ... --permissions-file JSON`);
		await updateManagedAgentProfile(base, agent.id, updates);
		process.stdout.write(`updated ${agent.id}; security-sensitive changes are active\n`);
		return 0;
	}
	if (action === "create") {
		const id = positionals[1];
		if (!id) throw new Error("usage: alive agents create <id> [--name <name>]");
		const sandboxFile = flagString(flags, "sandbox-file");
		const sandbox = sandboxFile ? JSON.parse((await import("node:fs")).readFileSync(path.resolve(cwd, sandboxFile), "utf8")) : undefined;
		const agent = createAgent(base, id, flagString(flags, "name"), { sandbox });
		process.stdout.write(`created agent ${agent.id}\nconfig: ${agent.configPath}\nworkspace: ${path.join(agent.directory, "workspace")}\nstart: alive agents start ${agent.id}\n`);
		return 0;
	}
	if (action === "request-telegram") {
		const agent = findManagedAgent(base, positionals[1]);
		const chatValue = flagString(flags, "chat");
		if (!chatValue) throw new Error("usage: alive agents request-telegram <id> --chat <private-chat-id>");
		await requestAgentTelegram(base, agent, chatValue);
		process.stdout.write(`Managed Bot creation request sent for ${agent.id}; approve it in Telegram. The master bot will attach its token when Telegram returns the created bot.\n`);
		return 0;
	}
	if (action === "telegram") {
		const agent = findManagedAgent(base, positionals[1]);
		const tokenEnv = flagString(flags, "token-env");
		if (!tokenEnv) throw new Error("usage: alive agents telegram <id> --token-env <ENV_NAME> (create the bot with @BotFather first)");
		configureAgentTelegram(agent, tokenEnv);
		process.stdout.write(`Telegram enabled for ${agent.id} using $${tokenEnv}; restart the agent to apply.\n`);
		return 0;
	}
	if (action === "start" || action === "stop" || action === "restart" || action === "status") {
		const agent = findManagedAgent(base, positionals[1]);
		if (action === "start") {
			const started = await startManagedAgent(base, agent.id);
			process.stdout.write(`started ${agent.id} (pid ${started.pid})\n`);
			return 0;
		}
		if (action === "stop") {
			await stopManagedAgent(base, agent.id);
			process.stdout.write(`stopped ${agent.id}\n`);
			return 0;
		}
		if (action === "restart") {
			const started = await restartManagedAgent(base, agent.id);
			process.stdout.write(`restarted ${agent.id} (pid ${started.pid})\n`);
			return 0;
		}
		return statusCommand(cwd, { ...flags, config: agent.configPath });
	}
	throw new Error(`unknown agents action: ${action} (use list, create, edit, permissions, enable, disable, send, inbox, start, stop, restart, status, telegram, request-telegram)`);
}

function findManagedAgent(base: LoadedConfig, idInput: string | undefined) {
	if (!idInput) throw new Error("agent id is required");
	const id = validateAgentId(idInput);
	const agent = listAgents(base).find((item) => item.id === id);
	if (!agent) throw new Error(`unknown agent: ${id}`);
	return agent;
}

function sayCommand(cwd: string, flags: Record<string, string | boolean>, text: string): number {
	const config = loadForCli(flags);
	if (!text.trim()) throw new Error("usage: alive say <text> [--thread console] [--no-reply]");
	const store = EventStore.open(config.paths.stateDir);
	const thread = flagString(flags, "thread") ?? "console";
	const expectsReply = !flagBool(flags, "no-reply");
	const event = store.append({
		kind: "user_message",
		source: "cli",
		priority: (flagString(flags, "priority") as EventPriority | undefined) ?? "normal",
		title: `message from ${flagString(flags, "from") ?? thread}`,
		text,
		thread,
		expectsReply,
		meta: { from: flagString(flags, "from") ?? thread, via: "cli" },
	});
	process.stdout.write(`queued ${event.id} (seq ${event.seq}) for thread "${thread}"${runningHint(config)}\n`);
	return 0;
}

function emitCommand(cwd: string, flags: Record<string, string | boolean>, text: string): number {
	const config = loadForCli(flags);
	const json = flagString(flags, "json");
	let payload: unknown;
	if (json) {
		try {
			payload = JSON.parse(json);
		} catch {
			throw new Error("--json must be valid JSON");
		}
	}
	if (!text.trim() && payload === undefined) throw new Error("usage: alive emit <text> [--json '<payload>']");
	const store = EventStore.open(config.paths.stateDir);
	const kind = (flagString(flags, "kind") as never) ?? "observability";
	const event = store.append({
		kind,
		source: "cli",
		priority: (flagString(flags, "priority") as EventPriority | undefined) ?? "normal",
		title: flagString(flags, "title") ?? oneLine(text || JSON.stringify(payload), 80),
		text: text.trim() ? text : JSON.stringify(payload, null, 2),
		payload,
		thread: flagString(flags, "thread"),
		expectsReply: flagBool(flags, "expects-reply"),
		dedupeKey: flagString(flags, "dedupe"),
	});
	process.stdout.write(`queued ${event.id} (seq ${event.seq}) kind=${event.kind}${runningHint(config)}\n`);
	return 0;
}

function remindCommand(cwd: string, flags: Record<string, string | boolean>, text: string): number {
	const config = loadForCli(flags);
	if (!text.trim()) throw new Error("usage: alive remind <text> --in 5m | --at <ISO>");
	const inFlag = flagString(flags, "in");
	const atFlag = flagString(flags, "at");
	const dueAt = inFlag ? Date.now() + parseDurationMs(inFlag) : atFlag ? parseTimestamp(atFlag) : undefined;
	if (!dueAt) throw new Error("one of --in <duration> or --at <timestamp> is required");
	const reminders = new ReminderStore(config.paths.stateDir);
	const reminder = reminders.add({ text, dueAt, thread: flagString(flags, "thread") });
	process.stdout.write(`reminder ${reminder.id} scheduled for ${iso(dueAt)} (in ${formatDuration(dueAt - Date.now())})\n`);
	return 0;
}

function remindersCommand(cwd: string, _flags: Record<string, string | boolean>): number {
	const config = loadForCli(_flags);
	const reminders = new ReminderStore(config.paths.stateDir);
	const all = reminders.list(flagBool(_flags, "all") ? { includeInactive: true } : {});
	if (all.length === 0) {
		process.stdout.write("no reminders\n");
		return 0;
	}
	for (const reminder of all) {
		const status = reminder.firedAt ? "fired" : reminder.cancelledAt ? "cancelled" : "pending";
		process.stdout.write(
			`${reminder.id}  ${iso(reminder.dueAt)}  [${status}]${reminder.thread ? ` thread=${reminder.thread}` : ""}  ${reminder.text}\n`,
		);
	}
	return 0;
}

function statusCommand(cwd: string, flags: Record<string, string | boolean>): number {
	const config = loadForCli(flags);
	const store = EventStore.open(config.paths.stateDir);
	const reminders = new ReminderStore(config.paths.stateDir);
	const threads = new ThreadStore(config.paths.stateDir);
	const policy = new PolicyStore(config.paths.stateDir);
	const runs = new RunLog(config.paths.stateDir);
	const runtime = readRuntimeState(config.paths.stateDir);
	const usage = runs.usageToday();
	const storeStatus = store.status();
	const running = runtime ? isProcessAlive(runtime.pid) : false;

	if (flagBool(flags, "json")) {
		process.stdout.write(
			`${JSON.stringify(
				{
					config: redactSecrets(config.config),
					paths: config.paths,
					runtime: runtime && running ? runtime : null,
					staleRuntime: runtime && !running ? runtime : null,
					inbox: storeStatus,
					reminders: reminders.list(),
					threads: threads.all(),
					policy: policy.load(),
					modules: describeModules(config.config),
					workers: config.config.workers.enabled ? new WorkerStore(config.paths).list() : undefined,
					usageToday: usage,
					lastRun: runs.last(),
				},
				null,
				2,
			)}\n`,
		);
		return 0;
	}

	const line = (label: string, value: string) => process.stdout.write(`${label.padEnd(12)} ${value}\n`);
	const snapshot = snapshotRuntime(config.paths.stateDir);
	line("agent", config.config.name);
	line("status", running && runtime ? `${runtime.status} (pid ${runtime.pid})` : "not running");
	if (running && runtime) {
		line("mode", `${runtime.mode ?? "foreground"}${snapshot?.suspended ? term.red(" — SUSPENDED (SIGSTOP/Ctrl+Z), serves nothing") : ""}`);
		line("uptime", formatDuration(Date.now() - runtime.startedAt));
		line("model", runtime.model ?? "(default)");
		line("session", runtime.sessionFile ?? "(none)");
		line("idle", runtime.idling ? `yes since ${iso(runtime.idleSince ?? runtime.lastTickAt)}` : "no");
		line("sleeps", String(runtime.sleeps ?? 0));
		line("logs", `${term.dim("alive logs -f")}  ${path.relative(config.paths.rootDir, stdoutLogPath(config.paths))}`);
	} else if (snapshot && !snapshot.cleanStop) {
		line("stale", `runtime state for pid ${snapshot.pid} (${snapshot.state.status}) — start with ${term.dim("alive run")}`);
	}
	line("inbox", `pending ${storeStatus.pending} (acked ${storeStatus.ackedSeq} of ${storeStatus.totalEvents})`);
	const open = threads.unsettled(config.config.loop.maxNudges);
	line("threads", open.length > 0 ? open.map((t) => `${t.thread}(${t.attempts}x)`).join(", ") : "none open");
	const pendingReminders = reminders.list();
	line(
		"reminders",
		pendingReminders.length > 0
			? `${pendingReminders.length}, next in ${formatDuration((pendingReminders[0]?.dueAt ?? 0) - Date.now())}`
			: "none",
	);
	line("policy", `${policy.load().defaultMode} default, ${policy.load().rules.length} rule(s)`);
	const modules = describeModules(config.config);
	const enabledModules = modules.filter((m) => m.enabled);
	line("modules", enabledModules.length > 0 ? enabledModules.map((m) => m.name).join(", ") : `none (${modules.length} available)`);
	line("budget", `$${usage.cost.toFixed(4)} today, ${usage.runs} runs, ${usage.turns} turns`);
	const last = runs.last();
	line("last run", last ? `#${last.index} ${formatDuration(last.durationMs)} ${last.stopReason}` : "never");
	line("workspace", config.paths.workspaceDir);
	line("journal", config.paths.journalDir);
	if (config.config.workers.enabled) {
		const workerRecords = new WorkerStore(config.paths).list();
		const active = workerRecords.filter((record) => record.status === "running" || record.status === "starting").length;
		line("workers", `${active}/${config.config.workers.maxConcurrent} active, ${workerRecords.length} total`);
	}
	return 0;
}

/**
 * `alive heartbeat`: is the runtime alive, and which build is running?
 *
 * Contract for outside watchdogs: exit 0 while the heartbeat is fresh, 1 when it
 * is missing or older than `updates.heartbeatStaleMs` (300000 ms by default).
 * No flags prints the contents and age, `--status` prints one line, `--json`
 * prints machine-readable JSON.
 */
function heartbeatCommand(flags: Record<string, string | boolean>, positionals: string[] = []): number {
	const usage = "usage: alive heartbeat [--status] [--json] [--config CONFIG]";
	if (flagBool(flags, "help") || flagBool(flags, "h")) {
		process.stdout.write(
			`${usage}\n\n` +
				"  --status   one line: fresh|stale|missing, age, pid, version and the file path\n" +
				"  --json     machine-readable status and heartbeat contents\n\n" +
				"The heartbeat (<stateDir>/heartbeat.json) is written once when the runtime starts:\n" +
				'{ "pid", "startedAt" (ISO), "version", "tag"?, "ref"? }.\n' +
				"Exit code: 0 while it is fresh, 1 when it is missing or older than\n" +
				"updates.heartbeatStaleMs (default 300000 = 5 minutes). This is the signal an\n" +
				"external watchdog uses to decide that the harness is down.\n",
		);
		return 0;
	}
	const known = new Set(["status", "json", "config", "help", "h"]);
	const unknown = Object.keys(flags).filter((key) => !known.has(key));
	if (unknown.length > 0) {
		throw new Error(`unknown flag${unknown.length === 1 ? "" : "s"}: --${unknown.join(", --")} (${usage})`);
	}
	if (positionals.length > 0) throw new Error(usage);

	const config = loadForCli(flags);
	const status = readHeartbeatStatus(config.paths.stateDir, config.config.updates.heartbeatStaleMs);
	const code = status.fresh ? 0 : 1;
	const limit = formatDuration(status.staleAfterMs);
	const age = status.ageMs === undefined ? "unknown" : formatDuration(status.ageMs);

	if (flagBool(flags, "json")) {
		process.stdout.write(
			`${JSON.stringify(
				{
					path: status.path,
					state: status.state,
					fresh: status.fresh,
					ageMs: status.ageMs ?? null,
					uptimeMs: status.uptimeMs ?? null,
					staleAfterMs: status.staleAfterMs,
					heartbeat: status.heartbeat ?? null,
				},
				null,
				2,
			)}\n`,
		);
		return code;
	}

	const heartbeat = status.heartbeat;
	if (flagBool(flags, "status")) {
		const agePart = status.state === "missing" ? "no readable heartbeat file" : `age ${age} (limit ${limit})`;
		const detail = heartbeat ? `  pid ${heartbeat.pid}  version ${heartbeat.version}` : "";
		process.stdout.write(`${status.state}  ${agePart}${detail}  ${status.path}\n`);
		return code;
	}

	const line = (label: string, value: string) => process.stdout.write(`${label.padEnd(12)} ${value}\n`);
	line("heartbeat", status.path);
	line(
		"status",
		status.state === "missing"
			? "missing — no readable heartbeat file (the runtime has not started, or it was removed or corrupt)"
			: `${status.state} — ${age} old, limit ${limit}`,
	);
	if (heartbeat) {
		line("pid", String(heartbeat.pid));
		line("startedAt", heartbeat.startedAt);
		if (status.uptimeMs !== undefined) line("running", formatDuration(status.uptimeMs));
		line("version", heartbeat.version);
		line("tag", heartbeat.tag ?? "(unknown)");
		line("ref", heartbeat.ref ?? "(unknown)");
	}
	return code;
}

function redactSecrets(config: AliveConfig): AliveConfig {
	return redactSecretFields(config);
}

async function workersCommand(cwd: string, flags: Record<string, string | boolean>, positionals: string[]): Promise<number> {
	const config = loadForCli(flags);
	const action = positionals[0] ?? "list";
	const store = new WorkerStore(config.paths);
	if (action === "list") {
		const records = store.list();
		if (records.length === 0) {
			process.stdout.write("no workers\n");
			return 0;
		}
		for (const record of records) {
			const changed = record.lastResult ? ` — ${oneLine(record.lastResult, 160)}` : record.lastError ? ` — error: ${oneLine(record.lastError, 160)}` : "";
			process.stdout.write(`${workerLabel(record)}${changed}\n`);
		}
		return 0;
	}
	if (action === "status") {
		const id = validateWorkerId(positionals[1] ?? "");
		const record = store.load(id);
		if (!record) throw new Error(`unknown worker: ${id}`);
		if (record.sandboxed) {
			process.stdout.write(`${renderWorkerRecord(record)}\n`);
			process.stdout.write("git state: inside the agent VM; use the agent's worker({action:\"status\"}) tool\n");
			return 0;
		}
		const env = createHostWorkerEnvironment(config.paths.rootDir);
		const git = (await env.exists(record.workspacePath)) ? await gitState(env, record.workspacePath).catch(() => undefined) : undefined;
		process.stdout.write(`${renderWorkerRecord(record, { git })}\n`);
		return 0;
	}
	if (action === "diff") {
		const id = validateWorkerId(positionals[1] ?? "");
		const record = store.load(id);
		if (!record) throw new Error(`unknown worker: ${id}`);
		if (record.sandboxed) {
			throw new Error("this worker runs inside the agent VM; use the agent's worker({action:\"diff\"}) tool (the VM cannot be shared with the CLI)");
		}
		const env = createHostWorkerEnvironment(config.paths.rootDir);
		if (!(await isGitRepository(env, record.workspacePath))) throw new Error(`worker workspace is not a git repository: ${record.workspacePath}`);
		const diff = await gitDiff(env, record.workspacePath, { baseCommit: record.baseCommit, full: flagBool(flags, "full") });
		process.stdout.write(`${diff.state.changed.length > 0 ? diff.state.changed.join("\n") : "(clean working tree)"}\n`);
		if (diff.stat) process.stdout.write(`\n${diff.stat}\n`);
		if (diff.patch) process.stdout.write(`\n${diff.patch}\n`);
		return 0;
	}
	if (action === "models") {
		const workers = config.config.workers;
		process.stdout.write(`enabled: ${workers.enabled}\n`);
		process.stdout.write(`environment: ${config.config.sandbox.enabled ? "sandbox VM (same VM as the agent)" : "host"}\n`);
		process.stdout.write(`models: ${workers.models.join(", ") || "(none)"}\n`);
		process.stdout.write(`default: ${workers.defaultModel || "(none)"}\n`);
		process.stdout.write(`permissions: ${Object.entries(workers.permissions).filter(([, value]) => value).map(([key]) => key).join(", ") || "(none)"}\n`);
		return 0;
	}
	throw new Error("usage: alive workers list | status <id> | diff <id> [--full] | models");
}

function runsCommand(_cwd: string, flags: Record<string, string | boolean>): number {
	const config = loadForCli(flags);
	const runs = new RunLog(config.paths.stateDir);
	const limit = Number(flagString(flags, "n") ?? 10) || 10;
	for (const record of runs.list(limit)) {
		const out = record.outbound.length > 0 ? `→ ${record.outbound.map((m) => m.thread).join(",")}` : "—";
		process.stdout.write(
			`#${String(record.index).padStart(4)} ${iso(record.finishedAt)} ${formatDuration(record.durationMs).padStart(7)} ` +
				`${record.stopReason.padEnd(10)} events=${record.events.length} idle=${record.idleReturns} turns=${record.turns} out=${out} $${record.usage.cost.toFixed(4)}\n`,
		);
		if (record.error) process.stdout.write(`      error: ${record.error}\n`);
	}
	return 0;
}

function policyCommand(_cwd: string, positionals: string[]): number {
	const config = loadForCli({});
	const policy = new PolicyStore(config.paths.stateDir);
	const sub = positionals[0] ?? "list";
	if (sub === "list" || sub === "show") {
		const current = policy.load();
		process.stdout.write(`default: ${current.defaultMode}\n`);
		for (const rule of current.rules) {
			process.stdout.write(`  ${rule.id}  ${rule.mode}  ${JSON.stringify(rule)}\n`);
		}
		return 0;
	}
	if (sub === "default") {
		const mode = parseNotifyMode(positionals[1]);
		policy.setDefault(mode);
		process.stdout.write(`default notification mode: ${mode}\n`);
		return 0;
	}
	if (sub === "add") {
		const mode = parseNotifyMode(positionals[1]);
		const rule = policy.add({ mode, thread: positionals[2] });
		process.stdout.write(`added rule ${rule.id}: ${rule.mode}${rule.thread ? ` thread=${rule.thread}` : ""}\n`);
		return 0;
	}
	if (sub === "remove") {
		const id = positionals[1];
		if (!id) throw new Error("usage: alive policy remove <rule-id>");
		const removed = policy.remove(id);
		if (!removed) throw new Error(`no rule matches ${id}`);
		process.stdout.write(`removed rule ${removed.id}\n`);
		return 0;
	}
	if (sub === "reset") {
		policy.reset();
		process.stdout.write("notification policy reset\n");
		return 0;
	}
	throw new Error(`unknown policy subcommand: ${sub}`);
}

function parseNotifyMode(value: string | undefined): NotifyMode {
	if (value === "interrupt" || value === "queue" || value === "mute") return value;
	throw new Error("mode must be one of: interrupt, queue, mute");
}

function modulesCommand(_cwd: string, flags: Record<string, string | boolean>): number {
	const config = loadForCli(flags);
	const described = describeModules(config.config);
	if (flagBool(flags, "json")) {
		process.stdout.write(`${JSON.stringify({ modules: described }, null, 2)}\n`);
		return 0;
	}
	for (const module of described) {
		const state = module.enabled ? term.green("on ") : term.gray("off");
		process.stdout.write(`${state}  ${module.name.padEnd(12)} ${module.source.padEnd(8)} ${module.detail ?? ""}\n`);
	}
	process.stdout.write(
		`${term.dim("live module status: alive status --json (modules field) or GET /status")}\n`,
	);
	return 0;
}

function historyCommand(_cwd: string, flags: Record<string, string | boolean>, positionals: string[]): number {
	const config = loadForCli(flags);
	const history = HistoryStore.open(config.paths.stateDir);
	const limit = Number(flagString(flags, "n") ?? flagString(flags, "limit") ?? 30) || 30;
	const thread = flagString(flags, "thread") ?? positionals[0];
	const search = flagString(flags, "search") ?? flagString(flags, "query");
	const moduleName = flagString(flags, "module");
	const directionFlag = flagString(flags, "direction");
	const direction: HistoryDirection | undefined =
		directionFlag === "inbound" || directionFlag === "outbound" ? directionFlag : undefined;
	const since = flagString(flags, "since");
	const until = flagString(flags, "until");

	if (!thread && !search && !flagBool(flags, "all")) {
		const threads = history.threads({ module: moduleName }).slice(0, Math.max(1, limit));
		if (flagBool(flags, "json")) {
			process.stdout.write(`${JSON.stringify({ threads }, null, 2)}\n`);
			return 0;
		}
		if (threads.length === 0) {
			process.stdout.write("no conversation history yet\n");
			return 0;
		}
		for (const entry of threads) {
			process.stdout.write(
				`${entry.thread.padEnd(28)} ${String(entry.module).padEnd(10)} ${String(entry.messageCount).padStart(5)} msgs  ` +
					`last ${iso(entry.lastMessageAt)}  ${oneLine(String(entry.title ?? ""), 60)}\n`,
			);
		}
		return 0;
	}

	const query: HistoryQuery = {
		thread,
		module: moduleName,
		direction,
		search,
		since: since ? parseTimeSpec(since) : undefined,
		until: until ? parseTimeSpec(until) : undefined,
		limit: Math.min(Math.max(1, limit), 500),
		order: flagString(flags, "order") === "asc" ? "asc" : "desc",
	};
	const records = history.query(query);
	if (flagBool(flags, "json")) {
		process.stdout.write(`${JSON.stringify({ query, messages: records }, null, 2)}\n`);
		return 0;
	}
	if (records.length === 0) {
		process.stdout.write("no messages matched\n");
		return 0;
	}
	for (const record of [...records].reverse()) {
		const arrow = record.direction === "outbound" ? "→" : "←";
		const who = record.direction === "outbound" ? "agent" : record.author ?? "unknown";
		const media = record.attachments && record.attachments.length > 0 ? ` [${record.attachments.map((a) => a.kind).join(", ")}]` : "";
		process.stdout.write(`${iso(record.ts)} ${arrow} ${record.thread} ${who}: ${truncate(record.text, 4000)}${media}\n`);
	}
	return 0;
}

async function telegramCommand(
	_cwd: string,
	flags: Record<string, string | boolean>,
	positionals: string[],
): Promise<number> {
	const config = loadForCli(flags);
	const sub = positionals[0] ?? "me";
	const moduleConfig = config.config.modules.telegram;

	if (sub === "whitelist") {
		const allowlist = new TelegramAllowlistStore(path.join(config.paths.modulesDir, "telegram"));
		const action = positionals[1] ?? "list";
		const userId = positionals[2];
		if (action === "list") {
			const ids = [...new Set([...moduleConfig.allowedUserIds.map(String), ...allowlist.list()])];
			process.stdout.write(ids.length ? `${ids.join("\n")}\n` : "Вайтлист пуст: сообщения обрабатываться не будут.\n");
			return 0;
		}
		if ((action === "add" || action === "remove") && !userId) {
			throw new Error(`usage: alive telegram whitelist ${action} <user-id>`);
		}
		if (action === "add") {
			const added = allowlist.add(userId!);
			process.stdout.write(added ? `Добавлен Telegram ID ${userId} в вайтлист\n` : `Telegram ID ${userId} уже в вайтлисте\n`);
			return 0;
		}
		if (action === "remove") {
			const removed = allowlist.remove(userId!);
			process.stdout.write(removed ? `Удалён Telegram ID ${userId} из динамического вайтлиста\n` : `Telegram ID ${userId} не найден в динамическом вайтлисте\n`);
			return 0;
		}
		throw new Error(`unknown whitelist action: ${action} (use list, add, remove)`);
	}

	if (sub === "chats") {
		const history = HistoryStore.open(config.paths.stateDir);
		const threads = history.threads({ module: "telegram" });
		if (threads.length === 0) {
			process.stdout.write("no telegram chats recorded yet\n");
			return 0;
		}
		for (const entry of threads) {
			process.stdout.write(
				`${entry.thread.padEnd(24)} ${String(entry.messageCount).padStart(5)} msgs  last ${iso(entry.lastMessageAt)}  ${oneLine(String(entry.title ?? ""), 50)}\n`,
			);
		}
		return 0;
	}

	const token = resolveToken(moduleConfig);
	if (!token) {
		throw new Error(
			`no telegram token: set modules.telegram.token or $${moduleConfig.tokenEnv || "ALIVE_TELEGRAM_TOKEN"}`,
		);
	}
	const api = new TelegramApi({ token, apiBase: moduleConfig.apiBase });

	if (sub === "ping") {
		try {
			const me = await api.getMe();
			process.stdout.write(`ok: @${me.username ?? "?"} (id ${me.id})\n`);
			return 0;
		} catch (err) {
			process.stderr.write(`${term.red("telegram unreachable:")} ${err instanceof Error ? err.message : String(err)}\n`);
			process.stderr.write(
				"hint: запрос не дошёл до Telegram (ECONNRESET/ETIMEDOUT — обычно VPN/прокси-маршрут). " +
					"Проверь сеть или задай modules.telegram.apiBase на локальный прокси.\n",
			);
			return 2;
		}
	}

	if (sub === "me") {
		const me = await api.getMe();
		process.stdout.write(
			`${[me.first_name, me.last_name].filter(Boolean).join(" ")} — @${me.username ?? "?"} (id ${me.id})\n`,
		);
		return 0;
	}
	if (sub === "chat") {
		const target = positionals[1];
		if (!target) throw new Error("usage: alive telegram chat <chat-id|@username>");
		const chat = await api.getChat({ chat_id: target });
		process.stdout.write(`${JSON.stringify(chat, null, 2)}\n`);
		return 0;
	}
	if (sub === "send") {
		const target = positionals[1];
		const text = positionals.slice(2).join(" ");
		if (!target || !text.trim()) throw new Error("usage: alive telegram send <chat-id|@username> <text>");
		const sent = await api.sendLongMessage({
			chat_id: target,
			text,
			parse_mode: moduleConfig.parseMode || undefined,
			disable_web_page_preview: !moduleConfig.linkPreview,
		});
		process.stdout.write(`sent ${sent.length} message(s): ${sent.map((m) => m.message_id).join(", ")}\n`);
		return 0;
	}
	throw new Error(`unknown telegram subcommand: ${sub} (use me, chats, chat, send)`);
}

function thoughtsCommand(_cwd: string, flags: Record<string, string | boolean>): number {
	const config = loadForCli(flags);
	const limit = Number(flagString(flags, "n") ?? 20) || 20;
	const lines = tailLines(config.paths.thoughtsFile, limit);
	if (lines.length === 0) {
		process.stdout.write("no private thoughts recorded yet\n");
		return 0;
	}
	for (const raw of lines) {
		try {
			const record = JSON.parse(raw) as { ts: number; runIndex?: number; wakeIndex?: number; text?: string; thinking?: string };
			const body = record.text?.trim() ? record.text : record.thinking ? term.dim(`(thinking) ${record.thinking}`) : "";
			const index = record.runIndex ?? record.wakeIndex ?? 0;
			process.stdout.write(`${term.gray(`[run #${index} ${iso(record.ts)}]`)} ${body}\n\n`);
		} catch {
			process.stdout.write(`${raw}\n`);
		}
	}
	return 0;
}

function runningHint(config: LoadedConfig): string {
	const runtime = readRuntimeState(config.paths.stateDir);
	if (runtime && isProcessAlive(runtime.pid)) {
		return ` — runtime running (pid ${runtime.pid}), will pick it up within ~${config.config.loop.pollIntervalMs}ms`;
	}
	return " — no runtime running; it will be processed on next start";
}

function printHelp(): void {
	process.stdout.write(`alive — a long-lived agent runtime on top of pi

usage:
  alive config [show] [--json]                 effective config with secrets redacted
  alive config migrate-secrets [--dry-run] [--json]
                                              move plaintext config secrets into .env
  alive init                                  create alive.config.json + SOUL.md
  alive run [--foreground|--once] [--force] [--verbose]
                                              start the default agent in the background
  alive agents list | create <id> [--name name]
  alive agents tui                            interactive local agent messenger
                                              (↑/↓ select, Alt+S start, Alt+X stop, Esc quit)
  alive agents start|stop|restart|enable|disable|status <id>
  alive agents edit <id> [--name NAME] [--role ROLE] [--contract TEXT] [--tools read,write,...]
  alive agents edit <id> --sandbox-file JSON    per-agent sandbox overrides (operator only)
  alive agents permissions <id> --permissions-file JSON
  alive agents send <id> <message>          send a durable local message to an agent
  alive agents inbox <id> [--thread ID]     list/read local messages for an agent
  alive agents telegram <id> --token-env ENV
  alive agents request-telegram <id> --chat ID
                                              request a Managed Bot for an agent via Telegram 9.6
                                              (--foreground: stay attached, --once: one run)
  alive workers list                          ephemeral coding workers (not agents)
  alive workers status <id>                   inspect a worker and its git state
  alive workers diff <id> [--full]            review worker changes
  alive workers models                        show the worker model/permission allowlist
  alive stop [--force] [--timeout 30s]        stop the running instance
                                              (--force: SIGKILL immediately)
  alive restart [--yes] [--verbose]           stop, then start in the background again
                                              (refused when run inside the harness unless --yes)
  alive update [--check] [--tag vX.Y.Z] [--force]
                                              update the harness to the newest stable vX.Y.Z tag
                                              (--check: report only; --force: allow a dirty tree)
  alive update --auto                         unattended: apply only if updates.auto, updates.window,
                                              an idle runtime and a newer tag allow it; exit 10 = restart me
  alive update --rollback [--force]           restore previousRef and dist.prev/ from .alive-update.json
  alive update --status                       current ref, update marker, dist/ and dist.prev/
                                              (update never restarts the harness — restart it yourself)
  alive logs [-n 50] [-f] [--file <source>] [--json]
                                              tail logs; sources: stdout (default), alive, thoughts
  alive say <text> [--thread t] [--no-reply]  send a message into the agent's inbox
  alive emit <text> [--kind k] [--priority p] [--json '<obj>'] [--dedupe key]
                                              inject an observability event
  alive remind <text> --in 5m | --at <ISO>    schedule a reminder for the agent
  alive reminders [--all]                     list reminders
  alive status [--json]                       show runtime + inbox state
  alive heartbeat [--status] [--json]         process heartbeat: exit 0 fresh, 1 missing/stale
  alive runs [-n 10]                          run history (alias: wakes)
  alive policy [list]                         show the notification policy
  alive policy add <interrupt|queue|mute> [thread]
  alive policy default <interrupt|queue|mute> set the fallback mode
  alive policy remove <rule-id> | reset
  alive sandbox status [--config CONFIG]       inspect VM/volumes without booting
  alive modules [--json]                      configured event modules
  alive history [--thread t] [--search s] [--all] [-n 30] [--json]
                                              conversation history (no args = list threads)
  alive telegram me | chats | chat <id|@name> | send <id|@name> <text> | ping
  alive telegram whitelist [list | add <user-id> | remove <user-id>]
                                              manage Telegram user access without restart
  alive browser setup [--engine chrome|fortress] [--shared-url PRIVATE_ORIGIN | --cdp-env ENV_NAME | --executable-env ENV_NAME] [--launch-mode auto|driver|native] [--public-url HTTPS_ORIGIN] [--headless true|false] [--sign-origins ORIGIN,...]
  alive browser activate | doctor [--online] | diagnose | pair | serve [--local] [--url URL]
                                              configure, diagnose and test phone handoff without an LLM
  alive browser host [--background|--foreground] [--bind ADDRESS] [--port 4330] [--max-clients 8]
  alive browser host-status | host-stop | migrate-shared
                                              one private browser host for isolated agent connections
  alive thoughts [-n 20]                      the agent's private monologue
`);
}
