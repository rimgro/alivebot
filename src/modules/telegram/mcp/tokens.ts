/**
 * Per-profile bearer tokens for the Telegram MCP proxy (#264, step B).
 *
 * Only a SHA-256 hash is stored, in `<stateDir>/telegram-mcp/tokens.json` (0600,
 * directory 0700). The plaintext token is printed once by
 * `alive telegram-mcp token <profile>` and never logged. Revoking one profile
 * rewrites the file without the others.
 */
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";

interface TokenRecord {
	hash: string;
	createdAt: string;
}

interface TokensFile {
	version: 1;
	profiles: Record<string, TokenRecord>;
}

export const TELEGRAM_MCP_TOKEN_PREFIX = "alive_tg_";

export function telegramMcpDir(stateDir: string): string {
	return path.join(stateDir, "telegram-mcp");
}

export function telegramMcpTokensFile(stateDir: string): string {
	return path.join(telegramMcpDir(stateDir), "tokens.json");
}

export class TelegramMcpTokenStore {
	private readonly file: string;

	constructor(stateDir: string) {
		this.file = telegramMcpTokensFile(stateDir);
	}

	/** Issue a fresh token for `profile`, replacing any previous one. */
	issue(profile: string): string {
		const token = `${TELEGRAM_MCP_TOKEN_PREFIX}${randomBytes(32).toString("base64url")}`;
		const data = this.read();
		data.profiles[profile] = { hash: hashToken(token), createdAt: new Date().toISOString() };
		this.write(data);
		return token;
	}

	/** Remove one profile's token. Other profiles are untouched. */
	revoke(profile: string): boolean {
		const data = this.read();
		if (!(profile in data.profiles)) return false;
		delete data.profiles[profile];
		this.write(data);
		return true;
	}

	has(profile: string): boolean {
		return profile in this.read().profiles;
	}

	/** Profile name for a presented bearer token, or undefined. Constant-time per stored hash. */
	resolve(token: string): string | undefined {
		if (!token) return undefined;
		const presented = Buffer.from(hashToken(token), "utf8");
		let matched: string | undefined;
		for (const [profile, record] of Object.entries(this.read().profiles)) {
			const stored = Buffer.from(record.hash, "utf8");
			// Both are 64-byte SHA-256 hex strings; timingSafeEqual needs equal lengths.
			if (stored.length === presented.length && timingSafeEqual(stored, presented) && matched === undefined) {
				matched = profile;
			}
		}
		return matched;
	}

	private read(): TokensFile {
		try {
			const parsed = JSON.parse(fs.readFileSync(this.file, "utf8")) as Partial<TokensFile>;
			if (parsed && parsed.version === 1 && parsed.profiles && typeof parsed.profiles === "object") {
				const profiles: Record<string, TokenRecord> = {};
				for (const [name, value] of Object.entries(parsed.profiles)) {
					if (
						value &&
						typeof value === "object" &&
						typeof (value as TokenRecord).hash === "string" &&
						typeof (value as TokenRecord).createdAt === "string"
					) {
						profiles[name] = value as TokenRecord;
					}
				}
				return { version: 1, profiles };
			}
		} catch {
			// Missing or unreadable file: no tokens yet. A corrupt file must not
			// authenticate anybody, and the next issue() replaces it.
		}
		return { version: 1, profiles: {} };
	}

	private write(data: TokensFile): void {
		fs.mkdirSync(path.dirname(this.file), { recursive: true, mode: 0o700 });
		try {
			fs.chmodSync(path.dirname(this.file), 0o700);
		} catch {
			// best effort; the directory may be owned by a different service user
		}
		const temp = `${this.file}.${process.pid}.${randomBytes(4).toString("hex")}.tmp`;
		fs.writeFileSync(temp, `${JSON.stringify(data, null, 2)}\n`, { mode: 0o600 });
		fs.chmodSync(temp, 0o600);
		fs.renameSync(temp, this.file);
		fs.chmodSync(this.file, 0o600);
	}
}

function hashToken(token: string): string {
	return createHash("sha256").update(token, "utf8").digest("hex");
}
