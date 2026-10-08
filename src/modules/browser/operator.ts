import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import { readJson } from "../../util.js";
import type { TelegramMessage } from "../telegram/types.js";

export interface BrowserOperator { chatId: string; userId: string; pairedAt: number }
interface PairRequest { digest: string; expiresAt: number }

export function writePrivateJson(file: string, value: unknown): void {
	fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
	const temporary = `${file}.${randomBytes(8).toString("hex")}.tmp`;
	try {
		fs.writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600, flag: "wx" });
		fs.renameSync(temporary, file);
	} finally { fs.rmSync(temporary, { force: true }); }
}

function requestFile(modulesDir: string): string { return path.join(modulesDir, "browser", "pairing.json"); }
function operatorFile(modulesDir: string): string { return path.join(modulesDir, "browser", "operator.json"); }
function hash(code: string): Buffer { return createHash("sha256").update(code).digest(); }

export function requestBrowserPairing(modulesDir: string, now = Date.now()): { code: string; expiresAt: number } {
	const code = randomBytes(24).toString("base64url");
	const expiresAt = now + 10 * 60_000;
	writePrivateJson(requestFile(modulesDir), { digest: hash(code).toString("hex"), expiresAt } satisfies PairRequest);
	return { code, expiresAt };
}

export function cancelBrowserPairing(modulesDir: string, code: string): void {
	const request = readJson<PairRequest | undefined>(requestFile(modulesDir), undefined);
	if (request?.digest === hash(code).toString("hex")) fs.rmSync(requestFile(modulesDir), { force: true });
}

export function readBrowserOperator(modulesDir: string): BrowserOperator | undefined {
	const operator = readJson<BrowserOperator | undefined>(operatorFile(modulesDir), undefined);
	if (!operator || !/^\d+$/.test(operator.chatId) || operator.chatId !== operator.userId || !Number.isFinite(operator.pairedAt)) return undefined;
	return operator;
}

/** Only a private, human-authored Telegram command can consume the local capability. */
export function acceptBrowserPairing(modulesDir: string, message: TelegramMessage, allowedChatIds: string[], now = Date.now()): BrowserOperator | undefined {
	if (message.chat.type !== "private" || !message.from || message.from.is_bot || message.from.id !== message.chat.id) return undefined;
	const code = message.text?.match(/^\/browser_pair(?:@[A-Za-z0-9_]+)?\s+([A-Za-z0-9_-]{32})\s*$/)?.[1];
	if (!code) return undefined;
	const request = readJson<PairRequest | undefined>(requestFile(modulesDir), undefined);
	if (!request || !/^[a-f0-9]{64}$/.test(request.digest) || request.expiresAt <= now || !Number.isFinite(request.expiresAt)) return undefined;
	if (!timingSafeEqual(hash(code), Buffer.from(request.digest, "hex"))) return undefined;
	const chatId = String(message.chat.id);
	if (allowedChatIds.length && !allowedChatIds.map(String).includes(chatId)) return undefined;
	// Atomic rename makes a capability single-use even across processes.
	const claimed = `${requestFile(modulesDir)}.${randomBytes(8).toString("hex")}.claimed`;
	try { fs.renameSync(requestFile(modulesDir), claimed); }
	catch { return undefined; }
	try {
		const operator = { chatId, userId: String(message.from.id), pairedAt: now };
		writePrivateJson(operatorFile(modulesDir), operator);
		return operator;
	} finally { fs.rmSync(claimed, { force: true }); }
}
