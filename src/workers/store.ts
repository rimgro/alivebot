import * as fs from "node:fs";
import * as path from "node:path";
import type { Paths } from "../config.js";
import { appendJsonl, ensureDir, readJson, readJsonl } from "../util.js";
import type { WorkerCostSource } from "./cost.js";

export type WorkerStatus = "starting" | "running" | "idle" | "failed" | "stopped" | "interrupted";
export type WorkerIsolation = "shared" | "worktree";
/** Why the last worker run was aborted (absent when the run ended on its own). */
export type WorkerAbortReason = "idle" | "runtime" | "stop" | "shutdown";

/**
 * Durable description of one worker. It intentionally contains no memory,
 * inbox or lifecycle fields: those belong to managed agents, not workers.
 */
export interface WorkerUsageEntry {
	ts: number;
	/**
	 * Run cost in USD, or `null` when no price is known (#162). `null` is not a
	 * zero: a real zero and an unknown spend must not look identical.
	 */
	cost: number | null;
	/** Where `cost` came from: provider-reported, computed from a known price, or unknown. */
	costSource: WorkerCostSource;
	/** Tokens this run spent (a run delta, not the session total). */
	input: number;
	output: number;
	cacheRead?: number;
	cacheWrite?: number;
	/** Model spec the worker actually ran, when known. */
	model?: string;
	/** Turns the run took, when the session reported them. */
	turns?: number;
	/** Worker id, so a usage line can be traced back to its record. */
	workerId?: string;
	/** Run status at the end of the run (`idle`, `failed`, …). */
	status?: string;
}

export interface WorkerRecord {
	version: 1;
	id: string;
	name?: string;
	createdAt: number;
	updatedAt: number;
	status: WorkerStatus;
	task: string;
	model: string;
	tools: string[];
	/** True when the worker operated inside the parent agent's sandbox VM. */
	sandboxed?: boolean;
	isolation: WorkerIsolation;
	repositoryPath: string;
	workspacePath: string;
	branch?: string;
	baseRef?: string;
	baseCommit?: string;
	pullRequest?: number;
	pullRequestUrl?: string;
	sessionFile?: string;
	sessionId?: string;
	runs: number;
	/**
	 * Session prompts spent by the last run, including provider retries. `runs`
	 * counts user-visible runs; this counts the attempts behind them.
	 */
	attempts?: number;
	lastRunStartedAt?: number;
	lastRunFinishedAt?: number;
	lastResult?: string;
	lastError?: string;
	/** Set by the last run that was aborted: which limit or command ended it. */
	abortReason?: WorkerAbortReason;
	tokens?: { input: number; output: number; total: number };
	/** Cumulative cost reported by pi for the current session, when it reports one. */
	costUsd?: number;
	/** Cost of the last run; `null` when the provider reported no price (#162). */
	lastRunCostUsd?: number | null;
	/** Provenance of `lastRunCostUsd`: provider, computed, or unreported. */
	lastRunCostSource?: WorkerCostSource;
	notifyOnFinish: boolean;
}

const WORKER_ID_RE = /^wrk_[a-z0-9]+$/;

export function validateWorkerId(id: string): string {
	const normalized = id.trim();
	if (!WORKER_ID_RE.test(normalized)) throw new Error("worker id must look like wrk_<timestamp>");
	return normalized;
}

export function workersStateRoot(paths: Paths): string {
	return path.join(paths.stateDir, "workers");
}

/** The append-only worker cost store. */
export function workerUsagePath(stateDir: string): string {
	return path.join(stateDir, "workers", "usage.jsonl");
}

/**
 * Normalize one stored usage line.
 *
 * Entries written before #162 have no `costSource`. The store only appended an
 * entry when it had a cost or tokens, so a stored `cost: 0` always meant
 * "tokens were spent but no price was reported" — it is surfaced as an explicit
 * unknown instead of a zero. A positive legacy cost is provider-reported.
 */
export function normalizeWorkerUsageEntry(value: unknown): WorkerUsageEntry | undefined {
	if (!value || typeof value !== "object") return undefined;
	const raw = value as Record<string, unknown>;
	if (typeof raw.ts !== "number" || !Number.isFinite(raw.ts)) return undefined;
	const storedCost = typeof raw.cost === "number" && Number.isFinite(raw.cost) ? raw.cost : undefined;
	const storedSource =
		raw.costSource === "provider" || raw.costSource === "computed" || raw.costSource === "unreported"
			? (raw.costSource as WorkerCostSource)
			: undefined;
	const costSource: WorkerCostSource =
		storedSource ?? (storedCost !== undefined && storedCost > 0 ? "provider" : "unreported");
	const cost = costSource === "unreported" ? null : storedCost ?? null;
	const count = (input: unknown): number =>
		typeof input === "number" && Number.isFinite(input) && input >= 0 ? input : 0;
	const entry: WorkerUsageEntry = {
		ts: raw.ts,
		cost,
		costSource,
		input: count(raw.input),
		output: count(raw.output),
	};
	const cacheRead = raw.cacheRead;
	const cacheWrite = raw.cacheWrite;
	if (typeof cacheRead === "number" && Number.isFinite(cacheRead)) entry.cacheRead = cacheRead;
	if (typeof cacheWrite === "number" && Number.isFinite(cacheWrite)) entry.cacheWrite = cacheWrite;
	if (typeof raw.model === "string" && raw.model) entry.model = raw.model;
	if (typeof raw.turns === "number" && Number.isFinite(raw.turns)) entry.turns = raw.turns;
	if (typeof raw.workerId === "string" && raw.workerId) entry.workerId = raw.workerId;
	if (typeof raw.status === "string" && raw.status) entry.status = raw.status;
	return entry;
}

/**
 * Worker-run spend since `since`. Read-only and usable without a `Paths` object
 * (the usage report only has a state directory). Entries with an unknown price
 * keep `cost: null`; callers must not add them as zero.
 */
export function readWorkerUsage(stateDir: string, since = 0): WorkerUsageEntry[] {
	return readJsonl<unknown>(workerUsagePath(stateDir))
		.map(normalizeWorkerUsageEntry)
		.filter((entry): entry is WorkerUsageEntry => entry !== undefined && entry.ts >= since);
}

export function worktreesRoot(paths: Paths, configured: string): string {
	return path.resolve(paths.rootDir, configured || path.join(workersStateRoot(paths), "worktrees"));
}

export class WorkerStore {
	private readonly root: string;

	constructor(paths: Paths) {
		this.root = workersStateRoot(paths);
	}

	get directory(): string {
		return this.root;
	}

	directoryFor(id: string): string {
		return path.join(this.root, validateWorkerId(id));
	}

	recordPath(id: string): string {
		return path.join(this.directoryFor(id), "worker.json");
	}

	usagePath(): string {
		return path.join(this.root, "usage.jsonl");
	}

	appendUsage(entry: WorkerUsageEntry): void {
		const tokens = entry.input + entry.output + (entry.cacheRead ?? 0) + (entry.cacheWrite ?? 0);
		const cost = typeof entry.cost === "number" ? entry.cost : 0;
		if (cost <= 0 && tokens <= 0) return;
		appendJsonl(this.usagePath(), entry);
	}

	usageHistory(since = 0): WorkerUsageEntry[] {
		return readJsonl<unknown>(this.usagePath())
			.map(normalizeWorkerUsageEntry)
			.filter((entry): entry is WorkerUsageEntry => entry !== undefined && entry.ts >= since);
	}

	sessionDir(id: string): string {
		return path.join(this.directoryFor(id), "sessions");
	}

	list(): WorkerRecord[] {
		if (!fs.existsSync(this.root)) return [];
		const records: WorkerRecord[] = [];
		for (const entry of fs.readdirSync(this.root, { withFileTypes: true })) {
			if (!entry.isDirectory() || !WORKER_ID_RE.test(entry.name)) continue;
			const record = this.load(entry.name);
			if (record) records.push(record);
		}
		return records.sort((a, b) => b.createdAt - a.createdAt);
	}

	load(id: string): WorkerRecord | undefined {
		const record = readJson<WorkerRecord | undefined>(this.recordPath(id), undefined);
		if (!record || record.version !== 1 || record.id !== validateWorkerId(id)) return undefined;
		if (!["starting", "running", "idle", "failed", "stopped", "interrupted"].includes(record.status)) return undefined;
		return record;
	}

	save(record: WorkerRecord): void {
		const directory = this.directoryFor(record.id);
		ensureDir(directory);
		const file = this.recordPath(record.id);
		const temporary = `${file}.${process.pid}.${Date.now()}.tmp`;
		fs.writeFileSync(temporary, `${JSON.stringify(record, null, 2)}\n`, { mode: 0o600 });
		fs.renameSync(temporary, file);
	}

	remove(id: string): void {
		fs.rmSync(this.directoryFor(id), { recursive: true, force: true });
	}
}

export function workerLabel(record: WorkerRecord): string {
	const branch = record.branch ? ` branch=${record.branch}` : "";
	const pr = record.pullRequest ? ` pr=#${record.pullRequest}` : "";
	const name = record.name ? ` "${record.name}"` : "";
	return `${record.id}${name} [${record.status}] env=${record.sandboxed ? "sandbox" : "host"} model=${record.model} isolation=${record.isolation}${branch}${pr}`;
}
