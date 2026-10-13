import * as fs from "node:fs";
import * as path from "node:path";
import * as crypto from "node:crypto";
import { execFileSync } from "node:child_process";

export function sleep(ms: number, signal?: AbortSignal): Promise<void> {
	const delay = Math.max(0, ms);
	if (signal?.aborted) return Promise.resolve();
	return new Promise((resolve) => {
		const timer = setTimeout(() => {
			signal?.removeEventListener("abort", onAbort);
			resolve();
		}, delay);
		const onAbort = () => {
			clearTimeout(timer);
			resolve();
		};
		signal?.addEventListener("abort", onAbort, { once: true });
	});
}

export function ensureDir(dir: string): void {
	fs.mkdirSync(dir, { recursive: true });
}

export function readJson<T>(file: string, fallback: T): T {
	try {
		const raw = fs.readFileSync(file, "utf8").trim();
		if (!raw) return fallback;
		return JSON.parse(raw) as T;
	} catch {
		return fallback;
	}
}

export function writeJsonAtomic(file: string, value: unknown): void {
	ensureDir(path.dirname(file));
	const tmp = `${file}.${process.pid}.tmp`;
	fs.writeFileSync(tmp, `${JSON.stringify(value, null, 2)}\n`, "utf8");
	fs.renameSync(tmp, file);
}

export function appendJsonl(file: string, value: unknown): void {
	ensureDir(path.dirname(file));
	fs.appendFileSync(file, `${JSON.stringify(value)}\n`, "utf8");
}

export function readJsonl<T>(file: string): T[] {
	try {
		const raw = fs.readFileSync(file, "utf8");
		const out: T[] = [];
		for (const line of raw.split("\n")) {
			const trimmed = line.trim();
			if (!trimmed) continue;
			try {
				out.push(JSON.parse(trimmed) as T);
			} catch {
				// ignore corrupt lines
			}
		}
		return out;
	} catch {
		return [];
	}
}

export function tailLines(file: string, count: number): string[] {
	try {
		const raw = fs.readFileSync(file, "utf8");
		const lines = raw.split("\n").filter((l) => l.trim().length > 0);
		return lines.slice(Math.max(0, lines.length - count));
	} catch {
		return [];
	}
}

/** Parse "45s", "10m", "2h", "1d", "500ms" or a bare number of seconds. */
export function parseDurationMs(input: string): number {
	const trimmed = input.trim();
	const match = /^(\d+(?:\.\d+)?)\s*(ms|s|m|h|d)?$/i.exec(trimmed);
	if (!match) throw new Error(`Cannot parse duration: "${input}" (use 30s, 5m, 2h, 1d)`);
	const value = Number(match[1]);
	const unit = (match[2] ?? "s").toLowerCase();
	const factor: Record<string, number> = { ms: 1, s: 1000, m: 60_000, h: 3_600_000, d: 86_400_000 };
	return Math.round(value * (factor[unit] ?? 1000));
}

/** Parse an absolute time: ISO timestamp, unix seconds (10 digits), unix ms (13 digits). */
export function parseTimestamp(input: string): number {
	const trimmed = input.trim();
	if (/^\d{13}$/.test(trimmed)) return Number(trimmed);
	if (/^\d{10}$/.test(trimmed)) return Number(trimmed) * 1000;
	const parsed = Date.parse(trimmed);
	if (Number.isNaN(parsed)) throw new Error(`Cannot parse timestamp: "${input}"`);
	return parsed;
}

/**
 * Parse a time bound that may be relative ("2h", "30m", "1d" = that long ago)
 * or absolute (ISO timestamp, unix seconds/ms). Used by history queries and the CLI.
 */
export function parseTimeSpec(input: string, now = Date.now()): number {
	const trimmed = input.trim();
	const match = /^(\d+(?:\.\d+)?)\s*(ms|s|m|h|d)$/i.exec(trimmed);
	if (match) {
		const factors: Record<string, number> = { ms: 1, s: 1000, m: 60_000, h: 3_600_000, d: 86_400_000 };
		return now - Number(match[1]) * (factors[match[2]!.toLowerCase()] ?? 1000);
	}
	return parseTimestamp(trimmed);
}

export function formatDuration(ms: number): string {
	if (!Number.isFinite(ms)) return "∞";
	const abs = Math.max(0, ms);
	if (abs < 1000) return `${Math.round(abs)}ms`;
	const s = abs / 1000;
	if (s < 60) return `${s.toFixed(s < 10 ? 1 : 0)}s`;
	const m = s / 60;
	if (m < 60) return `${m.toFixed(m < 10 ? 1 : 0)}m`;
	const h = m / 60;
	if (h < 48) return `${h.toFixed(1)}h`;
	return `${(h / 24).toFixed(1)}d`;
}

export function newId(prefix: string): string {
	const stamp = Date.now().toString(36);
	const rand = crypto.randomBytes(5).toString("hex");
	return `${prefix}_${stamp}${rand}`;
}

export function oneLine(text: string, max = 400): string {
	const flat = text.replace(/\s+/g, " ").trim();
	return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}

export function truncate(text: string, max: number): string {
	if (text.length <= max) return text;
	return `${text.slice(0, max)}\n… [truncated ${text.length - max} chars]`;
}

export function iso(ts: number): string {
	return new Date(ts).toISOString();
}

export function localTime(ts: number): string {
	return new Date(ts).toLocaleTimeString(undefined, { hour12: false });
}

export function localDay(ts: number): string {
	const d = new Date(ts);
	const y = d.getFullYear();
	const m = String(d.getMonth() + 1).padStart(2, "0");
	const day = String(d.getDate()).padStart(2, "0");
	return `${y}-${m}-${day}`;
}

export function nextMidnight(ts: number): number {
	const d = new Date(ts);
	d.setHours(24, 0, 0, 0);
	return d.getTime();
}

/**
 * Kernel-reported process state letter from procfs or macOS ps: `R`, `S`, `D`, `T`
 * (suspended by job control), `Z` (zombie). Undefined when the pid is gone or
 * the platform does not provide process state.
 */
export function processState(pid: number): string | undefined {
	if (!Number.isInteger(pid) || pid <= 0) return undefined;
	try {
		if (process.platform === "darwin") {
			return execFileSync("/bin/ps", ["-o", "stat=", "-p", String(pid)], { encoding: "utf8", timeout: 1000, stdio: ["ignore", "pipe", "ignore"] }).trim()[0];
		}
		const raw = fs.readFileSync(`/proc/${pid}/stat`, "utf8");
		// `comm` is parenthesised and may itself contain spaces and brackets.
		return raw.slice(raw.lastIndexOf(")") + 2).split(" ")[0];
	} catch {
		return undefined;
	}
}

/**
 * Alive but stopped by SIGSTOP/Ctrl+Z. Such a process still owns the pid and
 * the runtime lock, yet serves nothing until it is continued.
 */
export function isProcessSuspended(pid: number): boolean {
	const state = processState(pid);
	return state === "T" || state === "t";
}

export function isProcessAlive(pid: number): boolean {
	if (!Number.isInteger(pid) || pid <= 0) return false;
	// A zombie still answers `kill(pid, 0)` until its parent reaps it, but it is
	// no longer running anything: treating it as alive keeps `status` lying.
	if (processState(pid) === "Z") return false;
	try {
		process.kill(pid, 0);
		return true;
	} catch (err) {
		return (err as NodeJS.ErrnoException).code === "EPERM";
	}
}

export function fileMtimeMs(file: string): number {
	try {
		return fs.statSync(file).mtimeMs;
	} catch {
		return 0;
	}
}
