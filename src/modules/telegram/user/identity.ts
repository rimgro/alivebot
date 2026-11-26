/**
 * Identity sidecar for the Telegram user account (#248, step B).
 *
 * The session store keeps the credential; this file keeps the *non-secret*
 * answer to "who is logged in and when": `{ id, username, firstName,
 * loggedInAt }`. It sits next to the session (`<stateDir>/telegram-user/
 * identity.json` by default) so `alive telegram user-status` can answer
 * without a network, an `api_hash` or the session content.
 *
 * The file is still written atomically and with mode 0600 — a Telegram user id
 * and username are account metadata, not something to leave world-readable.
 * Errors name the path and never echo the content.
 */
import { randomUUID } from "node:crypto";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import type { TelegramUserIdentity } from "./client.js";

export const USER_IDENTITY_FILE = "identity.json";
export const USER_IDENTITY_FILE_MODE = 0o600;
export const USER_IDENTITY_DIR_MODE = 0o700;

/** Sidecar contents: the identity plus the moment the login succeeded. */
export interface TelegramUserIdentityRecord extends TelegramUserIdentity {
	/** ISO timestamp of the most recent successful login. */
	loggedInAt: string;
}

/** `identity.json` next to the configured session file. */
export function identityFileForSession(sessionFile: string): string {
	return path.join(path.dirname(sessionFile), USER_IDENTITY_FILE);
}

/** Read/write the identity sidecar. Missing file is not an error. */
export class TelegramUserIdentityStore {
	constructor(private readonly file: string) {}

	/** The stored identity, or `undefined` when nobody has logged in yet. */
	async read(): Promise<TelegramUserIdentityRecord | undefined> {
		let raw: string;
		try {
			raw = await fs.readFile(this.file, "utf8");
		} catch (error) {
			if (isNotFound(error)) return undefined;
			throw new Error(`cannot read the telegram user identity at ${this.file}: ${describeError(error)}`);
		}
		return parseIdentity(raw, this.file);
	}

	/** Replace the sidecar atomically (temp file + rename), mode 0600. */
	async save(record: TelegramUserIdentityRecord): Promise<void> {
		const identity = normalise(record, this.file);
		const dir = path.dirname(this.file);
		const temp = path.join(dir, `.${path.basename(this.file)}.${process.pid}.${randomUUID()}.tmp`);
		try {
			await fs.mkdir(dir, { recursive: true, mode: USER_IDENTITY_DIR_MODE });
			const handle = await fs.open(temp, "w", USER_IDENTITY_FILE_MODE);
			try {
				await handle.writeFile(`${JSON.stringify(identity, null, 2)}\n`, "utf8");
				await handle.chmod(USER_IDENTITY_FILE_MODE);
				await handle.sync();
			} finally {
				await handle.close();
			}
			await fs.rename(temp, this.file);
		} catch (error) {
			await fs.rm(temp, { force: true }).catch(() => {});
			throw new Error(`cannot save the telegram user identity to ${this.file}: ${describeError(error)}`);
		}
	}

	/** Delete the sidecar. Missing file is not an error: logout is idempotent. */
	async remove(): Promise<void> {
		try {
			await fs.rm(this.file, { force: true });
		} catch (error) {
			throw new Error(`cannot remove the telegram user identity at ${this.file}: ${describeError(error)}`);
		}
	}

	/** Log-safe representation: the path, never the content. */
	toString(): string {
		return `TelegramUserIdentityStore(${this.file})`;
	}
}

/** Keep only the known fields, in a stable order, so the file stays diff-friendly. */
function normalise(record: TelegramUserIdentityRecord, file: string): TelegramUserIdentityRecord {
	const id = String(record.id ?? "").trim();
	if (!id) throw new Error(`refusing to save a telegram user identity without an id to ${file}`);
	const username = (record.username ?? "").trim().replace(/^@/, "");
	const firstName = (record.firstName ?? "").trim();
	const loggedInAt = String(record.loggedInAt ?? "").trim();
	if (Number.isNaN(Date.parse(loggedInAt))) {
		throw new Error(`refusing to save a telegram user identity with an invalid loggedInAt to ${file}`);
	}
	const out: TelegramUserIdentityRecord = { id, loggedInAt: new Date(loggedInAt).toISOString() };
	if (username) out.username = username;
	if (firstName) out.firstName = firstName;
	return out;
}

/**
 * Strict parse: a hand-edited or truncated sidecar must fail loudly instead of
 * producing half an identity. The message names the field, never the value.
 */
function parseIdentity(raw: string, file: string): TelegramUserIdentityRecord {
	let value: unknown;
	try {
		value = JSON.parse(raw);
	} catch {
		throw new Error(`cannot read the telegram user identity at ${file}: not valid JSON`);
	}
	if (!value || typeof value !== "object" || Array.isArray(value)) {
		throw new Error(`cannot read the telegram user identity at ${file}: expected a JSON object`);
	}
	const rawRecord = value as Record<string, unknown>;
	if (typeof rawRecord.id !== "string" || !rawRecord.id.trim()) {
		throw new Error(`cannot read the telegram user identity at ${file}: missing "id"`);
	}
	if (typeof rawRecord.loggedInAt !== "string" || Number.isNaN(Date.parse(rawRecord.loggedInAt))) {
		throw new Error(`cannot read the telegram user identity at ${file}: missing or invalid "loggedInAt"`);
	}
	if (rawRecord.username !== undefined && typeof rawRecord.username !== "string") {
		throw new Error(`cannot read the telegram user identity at ${file}: "username" must be a string`);
	}
	if (rawRecord.firstName !== undefined && typeof rawRecord.firstName !== "string") {
		throw new Error(`cannot read the telegram user identity at ${file}: "firstName" must be a string`);
	}
	return normalise(
		{
			id: rawRecord.id,
			username: rawRecord.username as string | undefined,
			firstName: rawRecord.firstName as string | undefined,
			loggedInAt: rawRecord.loggedInAt,
		},
		file,
	);
}

function isNotFound(error: unknown): boolean {
	return (error as NodeJS.ErrnoException | undefined)?.code === "ENOENT";
}

/** Only the code and a short cause: an fs error never carries the file content. */
function describeError(error: unknown): string {
	const code = (error as NodeJS.ErrnoException | undefined)?.code;
	const message = error instanceof Error ? error.message : String(error);
	return code ? `${code}: ${message}` : message;
}
