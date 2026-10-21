import * as fs from "node:fs";
import * as path from "node:path";
import type { Paths } from "../config.js";
import { appendJsonl, ensureDir, readJson, readJsonl } from "../util.js";

export type WorkerStatus = "starting" | "running" | "idle" | "failed" | "stopped" | "interrupted";
export type WorkerIsolation = "shared" | "worktree";

/**
 * Durable description of one worker. It intentionally contains no memory,
 * inbox or lifecycle fields: those belong to managed agents, not workers.
 */
export interface WorkerUsageEntry {
	ts: number;
	cost: number;
	input: number;
	output: number;
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
	lastRunStartedAt?: number;
	lastRunFinishedAt?: number;
	lastResult?: string;
	lastError?: string;
	tokens?: { input: number; output: number; total: number };
	costUsd?: number;
	lastRunCostUsd?: number;
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
		if (!(entry.cost > 0) && entry.input === 0 && entry.output === 0) return;
		appendJsonl(this.usagePath(), entry);
	}

	usageHistory(since = 0): WorkerUsageEntry[] {
		return readJsonl<WorkerUsageEntry>(this.usagePath()).filter((entry) => entry.ts >= since);
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
