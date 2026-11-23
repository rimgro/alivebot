/**
 * Storage for the MTProto user-account session (#248).
 *
 * The session string is the account: whoever reads it becomes the user. So the
 * store keeps it in one private file and treats it as write-only data:
 *
 *  - the file is created with mode 0600 (chmod after the write, so umask cannot
 *    widen or zero it) and replaced atomically via a temp file + rename,
 *  - the directory is created and kept at mode 0700 (an existing, wider
 *    directory is tightened, `mkdir` alone would leave it alone),
 *  - nothing here returns, logs or stringifies the content; `describe()` reports
 *    only presence, size and mtime, and errors carry the path alone.
 */
import { randomUUID } from "node:crypto";
import * as fs from "node:fs/promises";
import * as path from "node:path";

export const USER_SESSION_FILE_MODE = 0o600;
export const USER_SESSION_DIR_MODE = 0o700;

export class UserSessionStore {
	constructor(private readonly file: string) {}

	/** The stored session, trimmed, or `undefined` when there is none. */
	async read(): Promise<string | undefined> {
		let raw: string;
		try {
			raw = await fs.readFile(this.file, "utf8");
		} catch (error) {
			if (isNotFound(error)) return undefined;
			throw new Error(`cannot read the telegram user session at ${this.file}: ${describeError(error)}`);
		}
		const value = raw.trim();
		return value ? value : undefined;
	}

	/**
	 * Replace the session atomically: temp file in the same directory, chmod to
	 * 0600, fsync, rename over the target. A crash never leaves a half-written
	 * session behind.
	 */
	async save(value: string): Promise<void> {
		const session = value.trim();
		if (!session) throw new Error(`refusing to save an empty telegram user session to ${this.file}`);
		const dir = path.dirname(this.file);
		const temp = path.join(dir, `.${path.basename(this.file)}.${process.pid}.${randomUUID()}.tmp`);
		try {
			await ensurePrivateDir(dir);
			const handle = await fs.open(temp, "w", USER_SESSION_FILE_MODE);
			try {
				await handle.writeFile(session, "utf8");
				// The mode passed to open() is masked by umask; an explicit chmod is
				// the only way to be sure the account credential is not world-readable.
				await handle.chmod(USER_SESSION_FILE_MODE);
				await handle.sync();
			} finally {
				await handle.close();
			}
			await fs.chmod(temp, USER_SESSION_FILE_MODE);
			await fs.rename(temp, this.file);
		} catch (error) {
			await fs.rm(temp, { force: true }).catch(() => {});
			throw new Error(`cannot save the telegram user session to ${this.file}: ${describeError(error)}`);
		}
	}

	/** Delete the session. Missing file is not an error: logout must be idempotent. */
	async remove(): Promise<void> {
		try {
			await fs.rm(this.file, { force: true });
		} catch (error) {
			throw new Error(`cannot remove the telegram user session at ${this.file}: ${describeError(error)}`);
		}
	}

	/** Presence, size and mtime only — enough for `status`, without the secret. */
	async describe(): Promise<{ present: boolean; bytes: number; mtime?: string }> {
		let info: Awaited<ReturnType<typeof fs.stat>>;
		try {
			info = await fs.stat(this.file);
		} catch (error) {
			if (isNotFound(error)) return { present: false, bytes: 0 };
			throw new Error(`cannot inspect the telegram user session at ${this.file}: ${describeError(error)}`);
		}
		if (!info.isFile()) return { present: false, bytes: 0 };
		return { present: true, bytes: info.size, mtime: info.mtime.toISOString() };
	}

	/** Log-safe representation: the path, never the content. */
	toString(): string {
		return `UserSessionStore(${this.file})`;
	}
}

function isNotFound(error: unknown): boolean {
	return (error as NodeJS.ErrnoException | undefined)?.code === "ENOENT";
}

/**
 * Create the session directory if needed and force it to 0700.
 *
 * `mkdir`'s `mode` only applies to directories it creates: a directory that
 * already exists (created earlier with a wider mode, or by a different umask/
 * user) is left alone. The session filename is not secret, but its directory
 * listing is still account metadata, so the mode is corrected explicitly.
 */
async function ensurePrivateDir(dir: string): Promise<void> {
	await fs.mkdir(dir, { recursive: true, mode: USER_SESSION_DIR_MODE });
	await fs.chmod(dir, USER_SESSION_DIR_MODE);
}

/** Only the code and a short cause: an fs error never carries the file content. */
function describeError(error: unknown): string {
	const code = (error as NodeJS.ErrnoException | undefined)?.code;
	const message = error instanceof Error ? error.message : String(error);
	return code ? `${code}: ${message}` : message;
}
