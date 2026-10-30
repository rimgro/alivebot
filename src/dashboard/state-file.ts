/**
 * Shared, file-backed state for the runtime `dashboard` tool.
 *
 * The dashboard tool lives in the agent runtime process, while the dashboard
 * HTTP server may run in a detached child process (or was started by hand with
 * `alive dashboard`). They still have to agree on three things:
 *
 * - which loopback server is running (pid/port/local URL) and whether external
 *   access is attached (tunnel URL + expiry);
 * - the outstanding one-time tickets and their issuance audit log;
 * - nothing else.
 *
 * Everything lives in `<stateDir>/dashboard/state.json` (mode 0600). Raw ticket
 * values are never written: only their SHA-256 hashes, exactly like sessions.
 *
 * Two processes may write the file at the same time (the tool issues a ticket
 * while the server consumes another), so every read-modify-write takes an
 * exclusive lock directory. The critical sections are tiny and synchronous.
 */
import { createHash, randomBytes } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";

/** `<stateDir>/dashboard`, relative to the profile's state directory. */
export const DASHBOARD_STATE_DIR = "dashboard";
/** File name inside `DASHBOARD_STATE_DIR`. */
export const DASHBOARD_STATE_FILE = "state.json";
/** Lock directory used for read-modify-write of the state file. */
const LOCK_DIR = "state.json.lock";
/** How long a process waits for the state lock before giving up. */
const LOCK_WAIT_MS = 2_000;
/** A lock older than this is considered abandoned (crash, kill -9). */
const LOCK_STALE_MS = 10_000;
/** Keep the issuance audit trail bounded. */
export const DASHBOARD_MAX_ISSUANCES = 50;

export type DashboardMode = "local" | "tunnel";

/** How the loopback server was started. */
export interface DashboardRuntimeRecord {
	/** Pid of the detached child; absent when an already-running server was adopted. */
	pid?: number;
	port: number;
	/** `http://127.0.0.1:<port>` */
	localUrl: string;
	/** True when the server was found on the port but not started by this tool. */
	adopted?: boolean;
	startedAt: number;
	/** Active external access, if any. */
	mode: DashboardMode;
	tunnelUrl?: string;
	tunnelStartedAt?: number;
	tunnelExpiresAt?: number;
}

/**
 * One issuance. Deliberately IP-free: the audit trail answers "which thread
 * asked for a link, and when", not "who clicked it".
 */
export interface DashboardTicketIssuance {
	thread: string;
	/** Epoch milliseconds. */
	at: number;
	/** Epoch milliseconds when the link stops working. */
	expiresAt: number;
}

export interface DashboardTicketRecord {
	/** Hash of the raw ticket; the raw value is never stored. */
	thread: string;
	createdAt: number;
	expiresAt: number;
}

export interface DashboardState {
	version: 1;
	runtime?: DashboardRuntimeRecord;
	/** Keyed by SHA-256 of the raw ticket. */
	tickets: Record<string, DashboardTicketRecord>;
	/** Newest last; bounded by `DASHBOARD_MAX_ISSUANCES`. */
	issuances: DashboardTicketIssuance[];
	updatedAt: number;
}

export function dashboardStateDir(stateDir: string): string {
	return path.join(stateDir, DASHBOARD_STATE_DIR);
}

export function dashboardStatePath(stateDir: string): string {
	return path.join(dashboardStateDir(stateDir), DASHBOARD_STATE_FILE);
}

export function emptyDashboardState(now = Date.now()): DashboardState {
	return { version: 1, tickets: {}, issuances: [], updatedAt: now };
}

export function hashTicket(token: string): string {
	return createHash("sha256").update(token, "utf8").digest("hex");
}

function parseTicket(value: unknown): DashboardTicketRecord | null {
	if (!value || typeof value !== "object" || Array.isArray(value)) return null;
	const record = value as Record<string, unknown>;
	if (typeof record.thread !== "string" || record.thread.length === 0) return null;
	if (typeof record.createdAt !== "number" || !Number.isFinite(record.createdAt)) return null;
	if (typeof record.expiresAt !== "number" || !Number.isFinite(record.expiresAt)) return null;
	return { thread: record.thread, createdAt: record.createdAt, expiresAt: record.expiresAt };
}

function parseIssuance(value: unknown): DashboardTicketIssuance | null {
	if (!value || typeof value !== "object" || Array.isArray(value)) return null;
	const record = value as Record<string, unknown>;
	if (typeof record.thread !== "string" || record.thread.length === 0) return null;
	if (typeof record.at !== "number" || !Number.isFinite(record.at)) return null;
	if (typeof record.expiresAt !== "number" || !Number.isFinite(record.expiresAt)) return null;
	return { thread: record.thread, at: record.at, expiresAt: record.expiresAt };
}

function parseRuntime(value: unknown): DashboardRuntimeRecord | undefined {
	if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
	const record = value as Record<string, unknown>;
	if (typeof record.port !== "number" || !Number.isInteger(record.port) || record.port <= 0) return undefined;
	if (typeof record.localUrl !== "string" || !record.localUrl.startsWith("http://127.0.0.1:")) return undefined;
	if (typeof record.startedAt !== "number" || !Number.isFinite(record.startedAt)) return undefined;
	const mode: DashboardMode = record.mode === "tunnel" ? "tunnel" : "local";
	const runtime: DashboardRuntimeRecord = {
		port: record.port,
		localUrl: record.localUrl,
		startedAt: record.startedAt,
		mode,
	};
	if (typeof record.pid === "number" && Number.isInteger(record.pid) && record.pid > 0) runtime.pid = record.pid;
	if (record.adopted === true) runtime.adopted = true;
	if (typeof record.tunnelUrl === "string" && record.tunnelUrl.length > 0) runtime.tunnelUrl = record.tunnelUrl;
	if (typeof record.tunnelStartedAt === "number" && Number.isFinite(record.tunnelStartedAt)) runtime.tunnelStartedAt = record.tunnelStartedAt;
	if (typeof record.tunnelExpiresAt === "number" && Number.isFinite(record.tunnelExpiresAt)) runtime.tunnelExpiresAt = record.tunnelExpiresAt;
	return runtime;
}

/**
 * Read the state. Missing or malformed files degrade to an empty state: a
 * corrupt audit file must not stop the dashboard, and it must never be guessed
 * at. Expired tickets are dropped on read so a stale link cannot be exchanged
 * even if nobody has pruned the file.
 */
export function readDashboardState(
	stateDir: string,
	now = Date.now(),
	options: { includeExpiredTickets?: boolean } = {},
): DashboardState {
	const state = emptyDashboardState(now);
	let raw: string;
	try {
		raw = fs.readFileSync(dashboardStatePath(stateDir), "utf8");
	} catch {
		return state;
	}
	try {
		const parsed = JSON.parse(raw) as unknown;
		if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return state;
		const record = parsed as Record<string, unknown>;
		state.runtime = parseRuntime(record.runtime);
		state.updatedAt = typeof record.updatedAt === "number" ? record.updatedAt : now;
		if (record.tickets && typeof record.tickets === "object" && !Array.isArray(record.tickets)) {
			for (const [hash, entry] of Object.entries(record.tickets as Record<string, unknown>)) {
				// Only accept hashes; a raw token accidentally stored here is ignored.
				if (!/^[a-f0-9]{64}$/.test(hash)) continue;
				const ticket = parseTicket(entry);
				if (ticket && (options.includeExpiredTickets === true || ticket.expiresAt > now)) state.tickets[hash] = ticket;
			}
		}
		if (Array.isArray(record.issuances)) {
			for (const entry of record.issuances) {
				const issuance = parseIssuance(entry);
				if (issuance) state.issuances.push(issuance);
			}
			state.issuances = state.issuances.slice(-DASHBOARD_MAX_ISSUANCES);
		}
		return state;
	} catch {
		return state;
	}
}

function writeDashboardState(stateDir: string, state: DashboardState): void {
	const dir = dashboardStateDir(stateDir);
	fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
	try {
		fs.chmodSync(dir, 0o700);
	} catch {
		// Best effort: a filesystem may not support chmod.
	}
	const file = dashboardStatePath(stateDir);
	const temp = `${file}.${process.pid}.${randomBytes(6).toString("hex")}.tmp`;
	const body = `${JSON.stringify(state, null, 2)}\n`;
	try {
		fs.writeFileSync(temp, body, { encoding: "utf8", mode: 0o600 });
		fs.chmodSync(temp, 0o600);
		fs.renameSync(temp, file);
		fs.chmodSync(file, 0o600);
	} finally {
		try {
			if (fs.existsSync(temp)) fs.rmSync(temp, { force: true });
		} catch {
			// The rename already succeeded, or cleanup is best effort.
		}
	}
}

function sleepSync(ms: number): void {
	// A synchronous sleep is intentional: the lock critical section cannot yield
	// to the event loop, otherwise two async callers could interleave a
	// read-modify-write in the same process.
	Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, Math.max(1, ms));
}

function acquireLock(stateDir: string): () => void {
	const dir = dashboardStateDir(stateDir);
	fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
	const lockPath = path.join(dir, LOCK_DIR);
	const deadline = Date.now() + LOCK_WAIT_MS;
	for (;;) {
		try {
			fs.mkdirSync(lockPath);
			return () => {
				try {
					fs.rmdirSync(lockPath);
				} catch {
					// Someone else already removed an abandoned lock.
				}
			};
		} catch (error) {
			const code = (error as NodeJS.ErrnoException).code;
			if (code !== "EEXIST") throw error;
			try {
				const age = Date.now() - fs.statSync(lockPath).mtimeMs;
				if (age > LOCK_STALE_MS) {
					fs.rmdirSync(lockPath);
					continue;
				}
			} catch {
				// The lock disappeared between mkdir and stat; retry immediately.
				continue;
			}
			if (Date.now() >= deadline) throw new Error("dashboard state is locked by another process; try again");
			sleepSync(15);
		}
	}
}

/**
 * Atomically read, mutate and write the dashboard state.
 *
 * The callback runs under the cross-process lock, so it must be quick and
 * synchronous. Its return value is passed through.
 */
export function updateDashboardState<T>(
	stateDir: string,
	now: number,
	mutate: (state: DashboardState) => T,
): T {
	const release = acquireLock(stateDir);
	try {
		// Expired tickets are visible to the callback so `consume` can report
		// "expired" distinctly from "already used", then they are pruned below.
		const state = readDashboardState(stateDir, now, { includeExpiredTickets: true });
		const result = mutate(state);
		for (const [hash, ticket] of Object.entries(state.tickets)) {
			if (ticket.expiresAt <= now) delete state.tickets[hash];
		}
		state.updatedAt = now;
		state.issuances = state.issuances.slice(-DASHBOARD_MAX_ISSUANCES);
		writeDashboardState(stateDir, state);
		return result;
	} finally {
		release();
	}
}

/** Read-only peek used by the HTTP server for the current tunnel origin. */
export function readDashboardRuntime(stateDir: string, now = Date.now()): DashboardRuntimeRecord | undefined {
	return readDashboardState(stateDir, now).runtime;
}
