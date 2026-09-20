import * as path from "node:path";
import { appendJsonl, ensureDir } from "./util.js";

export type LogLevel = "debug" | "info" | "warn" | "error";

const LEVEL_ORDER: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 };

export interface LoggerOptions {
	/** JSONL sink. Every record is appended here regardless of console verbosity. */
	file?: string;
	/** Print to stderr. */
	console?: boolean;
	/** Lowest level printed to console. File always receives everything. */
	level?: LogLevel;
	scope?: string;
}

/**
 * Structured logger.
 *
 * The agent runtime is long-lived and headless: the JSONL log is the primary
 * observability surface, the console is only a live convenience.
 */
export class Logger {
	readonly file?: string;
	readonly level: LogLevel;
	readonly scope?: string;
	private readonly printToConsole: boolean;

	constructor(options: LoggerOptions = {}) {
		this.file = options.file;
		this.level = options.level ?? "info";
		this.scope = options.scope;
		this.printToConsole = options.console ?? true;
		if (this.file) ensureDir(path.dirname(this.file));
	}

	child(scope: string): Logger {
		return new Logger({
			file: this.file,
			console: this.printToConsole,
			level: this.level,
			scope: this.scope ? `${this.scope}:${scope}` : scope,
		});
	}

	debug(msg: string, data?: unknown): void {
		this.write("debug", msg, data);
	}
	info(msg: string, data?: unknown): void {
		this.write("info", msg, data);
	}
	warn(msg: string, data?: unknown): void {
		this.write("warn", msg, data);
	}
	error(msg: string, data?: unknown): void {
		this.write("error", msg, data);
	}

	/** Raw block output (message bodies, prompts). Never goes to the JSONL log by itself. */
	raw(text: string): void {
		if (this.printToConsole) process.stderr.write(text.endsWith("\n") ? text : `${text}\n`);
	}

	private write(level: LogLevel, msg: string, data?: unknown): void {
		const record = {
			ts: Date.now(),
			level,
			scope: this.scope,
			msg,
			...(data === undefined ? {} : { data: safeData(data) }),
		};
		if (this.file) appendJsonl(this.file, record);
		if (!this.printToConsole || LEVEL_ORDER[level] < LEVEL_ORDER[this.level]) return;
		const time = new Date(record.ts).toISOString().slice(11, 19);
		const scope = this.scope ? ` ${this.scope}` : "";
		const suffix = data === undefined ? "" : ` ${compact(data)}`;
		process.stderr.write(`${time} ${level.toUpperCase().padEnd(5)}${scope} ${msg}${suffix}\n`);
	}
}

function safeData(data: unknown): unknown {
	if (data instanceof Error) return { name: data.name, message: data.message, stack: data.stack };
	return data;
}

function compact(data: unknown): string {
	if (data === null || data === undefined) return "";
	if (typeof data === "string") return data;
	try {
		const json = JSON.stringify(data);
		return json.length > 300 ? `${json.slice(0, 300)}…` : json;
	} catch {
		return String(data);
	}
}
