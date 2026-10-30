/**
 * Password, session and login-rate state for the dashboard.
 *
 * The dashboard itself is local-only. This module is the small amount of state
 * needed when it is deliberately exposed through a temporary HTTPS tunnel:
 *
 * - `<stateDir>/dashboard/auth.json` (mode 0600) stores a scrypt verifier for
 *   the operator password and hashes of live session tokens. The password and
 *   the raw session tokens are never written anywhere.
 * - A session is a 256-bit random token carried in an HttpOnly/Secure/
 *   SameSite=Strict cookie. Only its SHA-256 hash is stored, together with
 *   `createdAt`, `expiresAt`, the client IP and the user agent.
 * - Failed logins are counted per client IP in a one-minute sliding window.
 *
 * Everything here is filesystem + crypto; HTTP concerns live in `server.ts`.
 */
import { createHash, randomBytes, scrypt as scryptCallback, timingSafeEqual } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";

/** `<stateDir>/dashboard`, relative to the profile's state directory. */
export const DASHBOARD_AUTH_DIR = "dashboard";
/** File name inside `DASHBOARD_AUTH_DIR`. */
export const DASHBOARD_AUTH_FILE = "auth.json";
/** Default session lifetime: 12 hours. */
export const DASHBOARD_SESSION_TTL_MS = 12 * 60 * 60_000;
/** Cookie that carries the raw session token. */
export const DASHBOARD_SESSION_COOKIE = "alive_dashboard_session";
/** Failed login budget per IP within the window. */
export const DASHBOARD_LOGIN_MAX_FAILURES = 5;
/** Sliding window (and subsequent cooldown) for failed logins. */
export const DASHBOARD_LOGIN_WINDOW_MS = 60_000;
/** A wrong-password response is deliberately slow, and always equally slow. */
export const DASHBOARD_LOGIN_DELAY_MS = 400;
/** Soft cap on live sessions; the oldest are dropped first. */
export const DASHBOARD_MAX_SESSIONS = 100;

const PASSWORD_ALGORITHM = "scrypt";
const SCRYPT_N = 16_384;
const SCRYPT_R = 8;
const SCRYPT_P = 1;
const SCRYPT_KEYLEN = 64;
const SCRYPT_MAXMEM = 64 * 1024 * 1024;
const SESSION_TOKEN_BYTES = 32;
const SESSION_TOKEN_RE = /^[A-Za-z0-9_-]{43}$/;

export interface ScryptVerifier {
	algorithm: "scrypt";
	/** base64url salt. */
	salt: string;
	/** base64url derived key. */
	hash: string;
	n: number;
	r: number;
	p: number;
	keylen: number;
}

export interface DashboardSessionRecord {
	/** Epoch milliseconds. */
	createdAt: number;
	/** Epoch milliseconds; `createdAt + ttl`. */
	expiresAt: number;
	/** Client IP as seen by the tunnel or the loopback socket. */
	ip: string;
	/** Truncated User-Agent header (audit metadata only). */
	userAgent: string;
}

interface AuthFile {
	version: 1;
	password: ScryptVerifier | null;
	/** Keyed by SHA-256 of the raw session token. */
	sessions: Record<string, DashboardSessionRecord>;
	updatedAt: number;
}

export function dashboardAuthDir(stateDir: string): string {
	return path.join(stateDir, DASHBOARD_AUTH_DIR);
}

export function dashboardAuthFile(stateDir: string): string {
	return path.join(dashboardAuthDir(stateDir), DASHBOARD_AUTH_FILE);
}

function emptyState(now = Date.now()): AuthFile {
	return { version: 1, password: null, sessions: {}, updatedAt: now };
}

function isString(value: unknown): value is string {
	return typeof value === "string" && value.length > 0;
}

function parseVerifier(value: unknown): ScryptVerifier | null {
	if (!value || typeof value !== "object" || Array.isArray(value)) return null;
	const record = value as Record<string, unknown>;
	if (record.algorithm !== PASSWORD_ALGORITHM) return null;
	if (!isString(record.salt) || !isString(record.hash)) return null;
	const n = record.n;
	const r = record.r;
	const p = record.p;
	const keylen = record.keylen;
	if (typeof n !== "number" || typeof r !== "number" || typeof p !== "number" || typeof keylen !== "number") return null;
	if (!Number.isInteger(n) || n < 1024 || n > 1_048_576) return null;
	if (!Number.isInteger(r) || r < 1 || r > 32) return null;
	if (!Number.isInteger(p) || p < 1 || p > 16) return null;
	if (!Number.isInteger(keylen) || keylen < 16 || keylen > 128) return null;
	return { algorithm: PASSWORD_ALGORITHM, salt: record.salt, hash: record.hash, n, r, p, keylen };
}

function parseSession(value: unknown): DashboardSessionRecord | null {
	if (!value || typeof value !== "object" || Array.isArray(value)) return null;
	const record = value as Record<string, unknown>;
	if (typeof record.createdAt !== "number" || !Number.isFinite(record.createdAt)) return null;
	if (typeof record.expiresAt !== "number" || !Number.isFinite(record.expiresAt)) return null;
	if (typeof record.ip !== "string" || typeof record.userAgent !== "string") return null;
	return { createdAt: record.createdAt, expiresAt: record.expiresAt, ip: record.ip, userAgent: record.userAgent };
}

/**
 * Read the auth state. A missing file is an empty state; a malformed file is
 * also treated as empty (and therefore has no password) rather than guessed
 * at. The caller that writes a new password replaces it atomically.
 */
function readState(stateDir: string, now = Date.now()): AuthFile {
	let raw: string;
	try {
		raw = fs.readFileSync(dashboardAuthFile(stateDir), "utf8");
	} catch {
		return emptyState(now);
	}
	try {
		const parsed = JSON.parse(raw) as unknown;
		if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return emptyState(now);
		const record = parsed as Record<string, unknown>;
		const sessions: Record<string, DashboardSessionRecord> = {};
		if (record.sessions && typeof record.sessions === "object" && !Array.isArray(record.sessions)) {
			for (const [hash, entry] of Object.entries(record.sessions as Record<string, unknown>)) {
				// Only accept hashes (hex SHA-256); a raw token accidentally put here is ignored.
				if (!/^[a-f0-9]{64}$/.test(hash)) continue;
				const session = parseSession(entry);
				if (session) sessions[hash] = session;
			}
		}
		return {
			version: 1,
			password: parseVerifier(record.password),
			sessions,
			updatedAt: typeof record.updatedAt === "number" ? record.updatedAt : now,
		};
	} catch {
		return emptyState(now);
	}
}

/**
 * Atomically replace the auth file with a JSON document, creating its directory
 * with owner-only permissions and forcing the file to 0600 even when it already
 * existed.
 */
function writeState(stateDir: string, state: AuthFile): void {
	const dir = dashboardAuthDir(stateDir);
	fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
	try {
		fs.chmodSync(dir, 0o700);
	} catch {
		// Best effort: a filesystem may not support chmod.
	}
	const file = dashboardAuthFile(stateDir);
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

function sha256(value: string): string {
	return createHash("sha256").update(value, "utf8").digest("hex");
}

export function hashSessionToken(token: string): string {
	return sha256(token);
}

export function generateSessionToken(): string {
	return randomBytes(SESSION_TOKEN_BYTES).toString("base64url");
}

/** Generate a password that is safe to copy from a terminal. */
export function generateDashboardPassword(): string {
	return randomBytes(24).toString("base64url");
}

function scrypt(password: string, salt: Buffer, keylen: number, options: { n: number; r: number; p: number }): Promise<Buffer> {
	return new Promise((resolve, reject) => {
		scryptCallback(password, salt, keylen, { N: options.n, r: options.r, p: options.p, maxmem: SCRYPT_MAXMEM }, (error, derived) => {
			if (error) reject(error);
			else resolve(derived as Buffer);
		});
	});
}

async function makeVerifier(password: string): Promise<ScryptVerifier> {
	const salt = randomBytes(16);
	const hash = await scrypt(password, salt, SCRYPT_KEYLEN, { n: SCRYPT_N, r: SCRYPT_R, p: SCRYPT_P });
	return {
		algorithm: PASSWORD_ALGORITHM,
		salt: salt.toString("base64url"),
		hash: hash.toString("base64url"),
		n: SCRYPT_N,
		r: SCRYPT_R,
		p: SCRYPT_P,
		keylen: SCRYPT_KEYLEN,
	};
}

async function verifyVerifier(verifier: ScryptVerifier, password: string): Promise<boolean> {
	let salt: Buffer;
	let expected: Buffer;
	try {
		salt = Buffer.from(verifier.salt, "base64url");
		expected = Buffer.from(verifier.hash, "base64url");
	} catch {
		return false;
	}
	if (salt.length === 0 || expected.length === 0) return false;
	let derived: Buffer;
	try {
		derived = await scrypt(password, salt, expected.length, { n: verifier.n, r: verifier.r, p: verifier.p });
	} catch {
		return false;
	}
	return derived.length === expected.length && timingSafeEqual(derived, expected);
}

export interface SetPasswordResult {
	/** Present only when the password was generated here, so it can be shown once. */
	password?: string;
	generated: boolean;
}

export function hasDashboardPassword(stateDir: string): boolean {
	return readState(stateDir).password !== null;
}

/**
 * Set (or, with no argument, generate) the dashboard password.
 *
 * Changing the password invalidates every existing session: a stolen cookie
 * must not survive credential rotation.
 */
export async function setDashboardPassword(
	stateDir: string,
	password?: string,
	now = Date.now(),
): Promise<SetPasswordResult> {
	const generated = password === undefined;
	const value = generated ? generateDashboardPassword() : password;
	if (!value || value.length === 0) throw new Error("dashboard password must not be empty");
	const verifier = await makeVerifier(value);
	const state = readState(stateDir, now);
	state.password = verifier;
	state.sessions = {};
	state.updatedAt = now;
	writeState(stateDir, state);
	return generated ? { password: value, generated: true } : { generated: false };
}

/**
 * Generate a password only when the profile has none. This is the "first use"
 * path: the returned password is meant to be printed once, and later calls
 * return `generated: false` with no plaintext.
 */
export async function ensureDashboardPassword(stateDir: string, now = Date.now()): Promise<SetPasswordResult> {
	if (hasDashboardPassword(stateDir)) return { generated: false };
	return setDashboardPassword(stateDir, undefined, now);
}

export async function verifyDashboardPassword(stateDir: string, password: string): Promise<boolean> {
	const verifier = readState(stateDir).password;
	if (!verifier || typeof password !== "string") return false;
	return verifyVerifier(verifier, password);
}

export interface CreateSessionOptions {
	ttlMs?: number;
	ip: string;
	userAgent: string;
	now?: number;
}

export interface CreatedSession {
	token: string;
	record: DashboardSessionRecord;
}

export class DashboardAuthStore {
	constructor(
		private readonly stateDir: string,
		private readonly now: () => number = Date.now,
	) {}

	hasPassword(): boolean {
		return hasDashboardPassword(this.stateDir);
	}

	async setPassword(password?: string): Promise<SetPasswordResult> {
		return setDashboardPassword(this.stateDir, password, this.now());
	}

	async ensurePassword(): Promise<SetPasswordResult> {
		return ensureDashboardPassword(this.stateDir, this.now());
	}

	async verifyPassword(password: string): Promise<boolean> {
		return verifyDashboardPassword(this.stateDir, password);
	}

	/** Create a session, storing only the token hash. */
	createSession(options: CreateSessionOptions): CreatedSession {
		const now = options.now ?? this.now();
		const state = readState(this.stateDir, now);
		for (const [hash, record] of Object.entries(state.sessions)) {
			if (record.expiresAt <= now) delete state.sessions[hash];
		}
		const token = generateSessionToken();
		const record: DashboardSessionRecord = {
			createdAt: now,
			expiresAt: now + (options.ttlMs ?? DASHBOARD_SESSION_TTL_MS),
			ip: options.ip,
			userAgent: options.userAgent.slice(0, 512),
		};
		state.sessions[sha256(token)] = record;
		// Keep the live table bounded without touching the newest sessions.
		const entries = Object.entries(state.sessions).sort((left, right) => left[1].createdAt - right[1].createdAt);
		while (entries.length > DASHBOARD_MAX_SESSIONS) {
			const oldest = entries.shift();
			if (!oldest) break;
			delete state.sessions[oldest[0]];
		}
		state.updatedAt = now;
		writeState(this.stateDir, state);
		return { token, record };
	}

	/**
	 * Return the session for a raw token, or `undefined` when it is missing or
	 * expired. Expired records are removed (and the file rewritten) on the way.
	 */
	verifySession(token: string): DashboardSessionRecord | undefined {
		if (!SESSION_TOKEN_RE.test(token)) return undefined;
		const now = this.now();
		const state = readState(this.stateDir, now);
		const hash = sha256(token);
		const record = state.sessions[hash];
		if (!record) return undefined;
		if (record.expiresAt <= now) {
			delete state.sessions[hash];
			state.updatedAt = now;
			writeState(this.stateDir, state);
			return undefined;
		}
		return record;
	}

	/** Remove one session by raw token. Returns true when it existed. */
	revokeSession(token: string): boolean {
		if (!SESSION_TOKEN_RE.test(token)) return false;
		const now = this.now();
		const state = readState(this.stateDir, now);
		const hash = sha256(token);
		if (!state.sessions[hash]) return false;
		delete state.sessions[hash];
		state.updatedAt = now;
		writeState(this.stateDir, state);
		return true;
	}

	/** Remove every session. Returns how many were removed. */
	revokeAllSessions(): number {
		const now = this.now();
		const state = readState(this.stateDir, now);
		const count = Object.keys(state.sessions).length;
		if (count === 0) return 0;
		state.sessions = {};
		state.updatedAt = now;
		writeState(this.stateDir, state);
		return count;
	}

	/** Drop expired records; returns how many remain. */
	pruneExpiredSessions(): number {
		const now = this.now();
		const state = readState(this.stateDir, now);
		let changed = false;
		for (const [hash, record] of Object.entries(state.sessions)) {
			if (record.expiresAt <= now) {
				delete state.sessions[hash];
				changed = true;
			}
		}
		const remaining = Object.keys(state.sessions).length;
		if (changed) {
			state.updatedAt = now;
			writeState(this.stateDir, state);
		}
		return remaining;
	}

	/**
	 * Count live sessions without rewriting the file. Used by the runtime
	 * `dashboard` tool's status action ("external sessions").
	 */
	activeSessionCount(): number {
		const now = this.now();
		const state = readState(this.stateDir, now);
		return Object.values(state.sessions).filter((record) => record.expiresAt > now).length;
	}
}

export function revokeAllDashboardSessions(stateDir: string, now = Date.now()): number {
	return new DashboardAuthStore(stateDir, () => now).revokeAllSessions();
}

// ---------------------------------------------------------------------------
// cookies
// ---------------------------------------------------------------------------

export function sessionCookie(token: string, maxAgeSeconds: number): string {
	return `${DASHBOARD_SESSION_COOKIE}=${token}; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=${Math.max(0, Math.floor(maxAgeSeconds))}`;
}

export function clearedSessionCookie(): string {
	return `${DASHBOARD_SESSION_COOKIE}=; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=0`;
}

/** Parse one named cookie from a Cookie header without pulling in a dependency. */
export function readCookie(header: string | undefined, name = DASHBOARD_SESSION_COOKIE): string | undefined {
	if (!header) return undefined;
	for (const part of header.split(";")) {
		const index = part.indexOf("=");
		if (index < 0) continue;
		if (part.slice(0, index).trim() !== name) continue;
		const value = part.slice(index + 1).trim();
		// Cookie values are quoted occasionally; session tokens are not.
		return value.startsWith('"') && value.endsWith('"') ? value.slice(1, -1) : value;
	}
	return undefined;
}

// ---------------------------------------------------------------------------
// login rate limiting
// ---------------------------------------------------------------------------

export interface LoginRateDecision {
	blocked: boolean;
	/** Milliseconds until the next failure slot frees up (0 when not blocked). */
	retryAfterMs: number;
}

/**
 * A one-minute sliding window of failed logins per client IP. The sixth
 * attempt inside the window is blocked; once the oldest failure ages out the
 * IP gets a fresh budget.
 */
export class LoginRateLimiter {
	private readonly failures = new Map<string, number[]>();

	constructor(
		private readonly now: () => number = Date.now,
		private readonly maxFailures = DASHBOARD_LOGIN_MAX_FAILURES,
		private readonly windowMs = DASHBOARD_LOGIN_WINDOW_MS,
	) {}

	private recent(ip: string, now: number): number[] {
		const list = (this.failures.get(ip) ?? []).filter((at) => now - at < this.windowMs);
		if (list.length === 0) this.failures.delete(ip);
		else this.failures.set(ip, list);
		return list;
	}

	check(ip: string): LoginRateDecision {
		const now = this.now();
		const list = this.recent(ip, now);
		if (list.length < this.maxFailures) return { blocked: false, retryAfterMs: 0 };
		const oldest = list[0] ?? now;
		return { blocked: true, retryAfterMs: Math.max(1, this.windowMs - (now - oldest)) };
	}

	recordFailure(ip: string): void {
		const now = this.now();
		const list = this.recent(ip, now);
		list.push(now);
		this.failures.set(ip, list);
	}

	recordSuccess(ip: string): void {
		this.failures.delete(ip);
	}

	reset(): void {
		this.failures.clear();
	}
}
