/**
 * Log reading for `alive logs`.
 *
 * Three sinks exist and they answer different questions:
 *   - `stdout`  — what the detached process printed (console logger + agent messages)
 *   - `alive`   — structured runtime JSONL (the primary observability surface)
 *   - `thoughts`— the agent's private monologue, never sent anywhere
 *
 * Rendering is deliberately shared with the console logger's format so a line
 * looks the same live and after the fact.
 */
import * as fs from "node:fs";
import { stdoutLogPath } from "./runtime/daemon.js";
import { term } from "./term.js";
import { sleep, tailLines } from "./util.js";
import type { Paths } from "./config.js";

export type LogSource = "stdout" | "alive" | "thoughts";

export const LOG_SOURCES: LogSource[] = ["stdout", "alive", "thoughts"];

export function resolveLogSource(paths: Paths, source: string): { source: LogSource; file: string } {
	switch (source) {
		case "stdout":
		case "out":
		case "console":
			return { source: "stdout", file: stdoutLogPath(paths) };
		case "alive":
		case "app":
		case "runtime":
		case "json":
			return { source: "alive", file: paths.logFile };
		case "thoughts":
		case "thinking":
		case "monologue":
			return { source: "thoughts", file: paths.thoughtsFile };
		default:
			throw new Error(`unknown log source "${source}" (use ${LOG_SOURCES.join(", ")})`);
	}
}

export function readLogTail(file: string, lines: number): string[] {
	return tailLines(file, lines);
}

export function fileSize(file: string): number {
	try {
		return fs.statSync(file).size;
	} catch {
		return 0;
	}
}

/** One line of a log file rendered for a terminal. Returns undefined to skip it. */
export function renderLogLine(source: LogSource, raw: string): string | undefined {
	if (!raw.trim()) return undefined;
	if (source === "stdout") return raw;
	if (source === "alive") return renderJsonl(raw);
	return renderThought(raw);
}

function renderJsonl(raw: string): string {
	let record: { ts?: number; level?: string; scope?: string; msg?: string; data?: unknown };
	try {
		record = JSON.parse(raw) as typeof record;
	} catch {
		return raw;
	}
	const level = record.level ?? "info";
	const time = new Date(record.ts ?? Date.now()).toISOString().slice(11, 19);
	const scope = record.scope ? ` ${record.scope}` : "";
	const data = record.data === undefined ? "" : ` ${compact(record.data)}`;
	return `${time} ${colorLevel(level)}${scope} ${record.msg ?? ""}${data}`;
}

function renderThought(raw: string): string | undefined {
	let record: { ts?: number; runIndex?: number; wakeIndex?: number; text?: string; thinking?: string };
	try {
		record = JSON.parse(raw) as typeof record;
	} catch {
		return raw;
	}
	const body = record.text?.trim() ? record.text : record.thinking ? term.dim(`(thinking) ${record.thinking}`) : "";
	if (!body) return undefined;
	const time = new Date(record.ts ?? Date.now()).toISOString().slice(11, 19);
	const index = record.runIndex ?? record.wakeIndex ?? 0;
	return `${term.gray(`[run #${index} ${time}]`)} ${body}`;
}

function colorLevel(level: string): string {
	const padded = level.toUpperCase().padEnd(5);
	if (level === "error") return term.red(padded);
	if (level === "warn") return term.yellow(padded);
	if (level === "debug") return term.gray(padded);
	return padded;
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

export interface FollowOptions {
	/** Byte offset to start at; defaults to the current end of file. */
	fromOffset?: number;
	pollMs?: number;
	signal?: AbortSignal;
}

/**
 * Stream appended lines until the signal aborts. Tails by offset instead of
 * `fs.watch` so it also works on filesystems where watch is unreliable (WSL,
 * network mounts) and survives truncation/rotation.
 */
export async function followFile(
	file: string,
	onLine: (line: string) => void,
	options: FollowOptions = {},
): Promise<void> {
	let offset = options.fromOffset ?? fileSize(file);
	let pending = "";
	const pollMs = options.pollMs ?? 250;
	while (!options.signal?.aborted) {
		const size = fileSize(file);
		if (size < offset) {
			// Truncated or rotated: start over instead of printing garbage.
			offset = 0;
			pending = "";
		}
		if (size > offset) {
			const length = size - offset;
			const buffer = Buffer.allocUnsafe(length);
			let read = 0;
			let fd: number | undefined;
			try {
				fd = fs.openSync(file, "r");
				read = fs.readSync(fd, buffer, 0, length, offset);
			} catch {
				read = 0;
			} finally {
				if (fd !== undefined) fs.closeSync(fd);
			}
			offset += read;
			pending += buffer.subarray(0, read).toString("utf8");
			let index = pending.indexOf("\n");
			while (index >= 0) {
				const line = pending.slice(0, index);
				pending = pending.slice(index + 1);
				if (line.trim()) onLine(line);
				index = pending.indexOf("\n");
			}
		}
		await sleep(pollMs);
	}
}
