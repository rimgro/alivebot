/**
 * Write window and hourly write counter for the Telegram MCP proxy (#264, step B).
 *
 * State lives in `<stateDir>/telegram-mcp/limits.json` (0600). Every update is a
 * write-to-temp + rename so a crash cannot leave a half-written counter. The
 * clock is injectable (`clock`) so TTL and hourly rollover are testable.
 */
import { randomBytes } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import type { TelegramMcpLimitsSnapshot } from "./policy.js";
import { telegramMcpDir } from "./tokens.js";

export const ONE_HOUR_MS = 60 * 60_000;

interface ProfileLimitRecord {
	windowStartedAt?: number;
	windowExpiresAt?: number;
	hourStartedAt?: number;
	writesThisHour: number;
}

interface LimitsFile {
	version: 1;
	profiles: Record<string, ProfileLimitRecord>;
}

export interface WriteReservation {
	allowed: boolean;
	/** Why the write was refused; present only when `allowed` is false. */
	reason?: string;
	/** Writes counted in the current hour, including this reservation when allowed. */
	writesThisHour: number;
}

export interface LimitsStoreOptions {
	/** Test seam: replace Date.now. */
	clock?: () => number;
	/** Test seam: use a different file. */
	file?: string;
}

export function telegramMcpLimitsFile(stateDir: string): string {
	return path.join(telegramMcpDir(stateDir), "limits.json");
}

export class TelegramMcpLimitsStore {
	private readonly file: string;
	private readonly clock: () => number;

	constructor(stateDir: string, options: LimitsStoreOptions = {}) {
		this.file = options.file ?? telegramMcpLimitsFile(stateDir);
		this.clock = options.clock ?? (() => Date.now());
	}

	now(): number {
		return this.clock();
	}

	/** Current window and hourly counter without changing the file. */
	snapshot(profile: string, now = this.now()): TelegramMcpLimitsSnapshot {
		const record = this.read().profiles[profile];
		if (!record) return { windowActive: false, writesThisHour: 0 };
		const writes = isNewHour(record, now) ? 0 : record.writesThisHour;
		return {
			windowActive: record.windowExpiresAt !== undefined && record.windowExpiresAt > now,
			...(record.windowExpiresAt === undefined ? {} : { windowExpiresAt: record.windowExpiresAt }),
			writesThisHour: writes,
		};
	}

	/**
	 * Check and count one write in a single synchronous read-modify-write. Two
	 * parallel calls cannot both observe the last free slot: the second sees the
	 * counter incremented by the first.
	 */
	reserveWrite(profile: string, limit: number, now = this.now()): WriteReservation {
		const data = this.read();
		const record = data.profiles[profile];
		const expired = record?.windowExpiresAt !== undefined && record.windowExpiresAt <= now;
		if (!record || record.windowExpiresAt === undefined || expired) {
			return {
				allowed: false,
				reason:
					`no active write window for profile "${profile}"` +
					(expired ? ` (the previous window expired at ${new Date(record!.windowExpiresAt!).toISOString()})` : "") +
					`; write:auto sends only inside an open TTL window`,
				writesThisHour: record ? (isNewHour(record, now) ? 0 : record.writesThisHour) : 0,
			};
		}
		if (isNewHour(record, now)) {
			record.hourStartedAt = now;
			record.writesThisHour = 0;
		}
		if (record.hourStartedAt === undefined) record.hourStartedAt = now;
		if (record.writesThisHour >= limit) {
			return {
				allowed: false,
				reason:
					`write limit reached for profile "${profile}": ` +
					`${record.writesThisHour}/${limit} writes this hour; retry in the next hour`,
				writesThisHour: record.writesThisHour,
			};
		}
		record.writesThisHour += 1;
		data.profiles[profile] = record;
		this.write(data);
		return { allowed: true, writesThisHour: record.writesThisHour };
	}

	/**
	 * Count one allowed write. The hour is reset lazily: a record older than an
	 * hour starts a new hour at `now`. The TTL window is not extended by writes.
	 *
	 * Kept for callers that already did their own window/limit check; the server
	 * uses `reserveWrite`, which checks and counts atomically.
	 */
	recordWrite(profile: string, now = this.now()): TelegramMcpLimitsSnapshot {
		const data = this.read();
		const record = data.profiles[profile] ?? { writesThisHour: 0 };
		if (isNewHour(record, now)) {
			record.hourStartedAt = now;
			record.writesThisHour = 0;
		}
		if (record.hourStartedAt === undefined) record.hourStartedAt = now;
		record.writesThisHour += 1;
		data.profiles[profile] = record;
		this.write(data);
		return this.snapshot(profile, now);
	}

	/** Open a new write window. Used by tests today and by the approval card in step C. */
	openWindow(profile: string, ttlMs: number, now = this.now()): TelegramMcpLimitsSnapshot {
		const data = this.read();
		const record = data.profiles[profile] ?? { writesThisHour: 0 };
		record.windowStartedAt = now;
		record.windowExpiresAt = now + ttlMs;
		if (record.hourStartedAt === undefined) record.hourStartedAt = now;
		data.profiles[profile] = record;
		this.write(data);
		return this.snapshot(profile, now);
	}

	/** Close the write window without touching the hourly counter. */
	closeWindow(profile: string): void {
		const data = this.read();
		const record = data.profiles[profile];
		if (!record) return;
		delete record.windowStartedAt;
		delete record.windowExpiresAt;
		data.profiles[profile] = record;
		this.write(data);
	}

	private read(): LimitsFile {
		try {
			const parsed = JSON.parse(fs.readFileSync(this.file, "utf8")) as Partial<LimitsFile>;
			if (parsed && parsed.version === 1 && parsed.profiles && typeof parsed.profiles === "object") {
				const profiles: Record<string, ProfileLimitRecord> = {};
				for (const [name, value] of Object.entries(parsed.profiles)) {
					if (value && typeof value === "object") profiles[name] = normalizeRecord(value as ProfileLimitRecord);
				}
				return { version: 1, profiles };
			}
		} catch {
			// Missing or corrupt: start clean. Losing a counter is safer than a
			// corrupt file blocking every write or, worse, granting a window.
		}
		return { version: 1, profiles: {} };
	}

	private write(data: LimitsFile): void {
		fs.mkdirSync(path.dirname(this.file), { recursive: true, mode: 0o700 });
		try {
			fs.chmodSync(path.dirname(this.file), 0o700);
		} catch {
			// best effort
		}
		const temp = `${this.file}.${process.pid}.${randomBytes(4).toString("hex")}.tmp`;
		fs.writeFileSync(temp, `${JSON.stringify(data, null, 2)}\n`, { mode: 0o600 });
		fs.chmodSync(temp, 0o600);
		fs.renameSync(temp, this.file);
		fs.chmodSync(this.file, 0o600);
	}
}

function normalizeRecord(record: ProfileLimitRecord): ProfileLimitRecord {
	const out: ProfileLimitRecord = {
		writesThisHour: Number.isSafeInteger(record.writesThisHour) && record.writesThisHour > 0 ? record.writesThisHour : 0,
	};
	if (typeof record.windowStartedAt === "number") out.windowStartedAt = record.windowStartedAt;
	if (typeof record.windowExpiresAt === "number") out.windowExpiresAt = record.windowExpiresAt;
	if (typeof record.hourStartedAt === "number") out.hourStartedAt = record.hourStartedAt;
	return out;
}

function isNewHour(record: ProfileLimitRecord, now: number): boolean {
	return record.hourStartedAt === undefined || now - record.hourStartedAt >= ONE_HOUR_MS;
}
