/**
 * Append-only JSONL audit of Telegram MCP decisions (#264, step B).
 *
 * One line per `tools/call` decision in `<stateDir>/audit/telegram-mcp.jsonl`
 * (0600): who, which tool, which chat, allow/deny/ask and why. A write carries
 * its byte length and at most 120 characters of text, never the full message.
 * Writing is best effort: an audit failure must not break the tool response.
 */
import * as fs from "node:fs";
import * as path from "node:path";

export const TELEGRAM_MCP_AUDIT_PREVIEW_CHARS = 120;

export interface TelegramMcpAuditEntry {
	ts: string;
	profile: string;
	tool: string;
	/** Canonical command name the call would run, e.g. "send" (#274). */
	command?: string;
	chat?: string;
	decision: "allow" | "deny" | "ask";
	reason: string;
	/** UTF-8 bytes of the write text, 0 when the call carries none. */
	bytes: number;
	/** First 120 characters of the write text; omitted for reads. */
	preview?: string;
}

export function telegramMcpAuditFile(stateDir: string): string {
	return path.join(stateDir, "audit", "telegram-mcp.jsonl");
}

export class TelegramMcpAuditLog {
	private readonly file: string;

	constructor(stateDir: string, file?: string) {
		this.file = file ?? telegramMcpAuditFile(stateDir);
	}

	/** Append one entry. Never throws: audit is best effort. */
	record(entry: TelegramMcpAuditEntry): void {
		try {
			fs.mkdirSync(path.dirname(this.file), { recursive: true, mode: 0o700 });
			try {
				fs.chmodSync(path.dirname(this.file), 0o700);
			} catch {
				// best effort
			}
			fs.appendFileSync(this.file, `${JSON.stringify(entry)}\n`, { mode: 0o600 });
			// Tighten even a pre-existing file: the audit names chats and tools.
			fs.chmodSync(this.file, 0o600);
		} catch {
			// A full disk or a read-only state dir must not turn a sent message
			// into an error the agent will retry.
		}
	}
}

/** Preview helper shared by the server and its tests. */
export function auditPreview(text: string | undefined): string | undefined {
	if (text === undefined) return undefined;
	return text.slice(0, TELEGRAM_MCP_AUDIT_PREVIEW_CHARS);
}
