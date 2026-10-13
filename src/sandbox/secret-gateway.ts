import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import * as net from "node:net";
import { createHash, randomUUID } from "node:crypto";
import type { LoadedConfig } from "../config.js";
import { TelegramApi } from "../modules/telegram/client.js";

export interface GuardedRequest {
	kind: "http-request";
	url: string;
	method: string;
	headers: Record<string, string>;
	body?: string;
	bodyUnavailable?: boolean;
}

export interface SecretRecord { name: string; value: string }

const STORE_NAME = "secret-gateway.json";
const MAX_REQUEST_BYTES = 4 * 1024 * 1024;
const MAX_PREVIEW_CHARS = 3500;

export function secretStorePath(config: LoadedConfig): string {
	const profile = createHash("sha256").update(path.resolve(config.paths.stateDir)).digest("hex").slice(0, 32);
	return path.join(os.homedir(), ".alive", "secret-gateway", profile, STORE_NAME);
}

export function listMarkedSecrets(config: LoadedConfig): Array<{ name: string }> {
	return readSecrets(config).map(({ name }) => ({ name }));
}

export function markSecret(config: LoadedConfig, name: string, value: string): void {
	const cleanName = name.trim();
	if (!/^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,63}$/.test(cleanName)) throw new Error("secret name must be 1-64 letters, digits, dots, underscores or hyphens");
	if (value.length < 4) throw new Error("secret value must contain at least 4 characters");
	const entries = readSecrets(config).filter((entry) => entry.name !== cleanName);
	entries.push({ name: cleanName, value });
	writeSecrets(config, entries);
}

export function unmarkSecret(config: LoadedConfig, name: string): boolean {
	const entries = readSecrets(config);
	const next = entries.filter((entry) => entry.name !== name);
	if (next.length === entries.length) return false;
	writeSecrets(config, next);
	return true;
}

function readSecrets(config: LoadedConfig): SecretRecord[] {
	const file = secretStorePath(config);
	if (!fs.existsSync(file)) return [];
	fs.chmodSync(path.dirname(path.dirname(file)), 0o700);
	fs.chmodSync(path.dirname(file), 0o700);
	fs.chmodSync(file, 0o600);
	const rows = JSON.parse(fs.readFileSync(file, "utf8")) as unknown;
	if (!Array.isArray(rows)) throw new Error("secret registry has invalid format");
	return rows.filter((row): row is SecretRecord => Boolean(row && typeof row === "object" && typeof row.name === "string" && typeof row.value === "string" && row.value.length >= 4));
}

function writeSecrets(config: LoadedConfig, entries: SecretRecord[]): void {
	const file = secretStorePath(config);
	fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
	fs.chmodSync(path.dirname(path.dirname(file)), 0o700);
	fs.chmodSync(path.dirname(file), 0o700);
	const temp = `${file}.tmp-${process.pid}-${randomUUID()}`;
	fs.writeFileSync(temp, `${JSON.stringify(entries, null, 2)}\n`, { mode: 0o600 });
	fs.chmodSync(temp, 0o600);
	fs.renameSync(temp, file);
}

/** Host-only broker: the guest sends every browser request here; only a match to a marked value pauses for Telegram approval. */
export class SecretApprovalGateway {
	private readonly api?: TelegramApi;
	private readonly owners: Set<string>;
	private readonly timeoutMs: number;
	private readonly socketPath: string;
	private readonly server: net.Server;
	private readonly decisions = new Map<string, (approved: boolean) => void>();
	private stopped = false;
	private updateOffset = 0;
	private pollPromise?: Promise<void>;

	private constructor(private readonly config: LoadedConfig, socketPath: string) {
		this.socketPath = socketPath;
		this.owners = new Set(config.config.sandbox.approvalOwnerUserIds.map(String).filter((id) => /^\d+$/.test(id)));
		this.timeoutMs = Math.min(10 * 60_000, Math.max(10_000, config.config.sandbox.approvalTimeoutSec * 1000));
		const token = process.env[config.config.sandbox.approvalTelegramTokenEnv];
		if (token && this.owners.size) this.api = new TelegramApi({ token });
		this.server = net.createServer((socket) => { void this.handleSocket(socket); });
	}

	static async start(config: LoadedConfig, socketPath: string): Promise<SecretApprovalGateway> {
		const gateway = new SecretApprovalGateway(config, socketPath);
		fs.mkdirSync(path.dirname(socketPath), { recursive: true, mode: 0o700 });
		try { fs.unlinkSync(socketPath); } catch { /* no stale socket */ }
		await new Promise<void>((resolve, reject) => {
			gateway.server.once("error", reject);
			gateway.server.listen(socketPath, () => { gateway.server.removeListener("error", reject); resolve(); });
		});
		fs.chmodSync(socketPath, 0o600);
		if (gateway.api) gateway.pollPromise = gateway.pollUpdates();
		return gateway;
	}

	async stop(): Promise<void> {
		this.stopped = true;
		for (const resolve of this.decisions.values()) resolve(false);
		this.decisions.clear();
		this.server.close();
		try { fs.unlinkSync(this.socketPath); } catch { /* already removed */ }
		await this.pollPromise?.catch(() => undefined);
	}

	private async handleSocket(socket: net.Socket): Promise<void> {
		socket.setTimeout(this.timeoutMs + 5_000);
		socket.on("timeout", () => socket.destroy());
		let raw = "";
		for await (const chunk of socket) {
			raw += Buffer.from(chunk).toString("utf8");
			if (Buffer.byteLength(raw) > MAX_REQUEST_BYTES) { socket.destroy(); return; }
			const end = raw.indexOf("\n");
			if (end < 0) continue;
			try {
				const request = JSON.parse(raw.slice(0, end)) as GuardedRequest;
				const allowed = await this.inspect(request);
				socket.end(`${JSON.stringify({ allow: allowed })}\n`);
			} catch {
				socket.end('{"allow":false}\n');
			}
			return;
		}
	}

	private async inspect(request: GuardedRequest): Promise<boolean> {
		if (request.kind !== "http-request" || !isPublicHttpUrl(request.url)) return false;
		if (request.bodyUnavailable) return false;
		const haystack = `${request.url}\n${JSON.stringify(request.headers)}\n${request.body ?? ""}`;
		const matches = readSecrets(this.config).filter(({ value }) => secretVariants(value).some((variant) => haystack.includes(variant)));
		if (!matches.length) return true;
		if (!this.api || !this.owners.size) return false;
		const requestHash = createHash("sha256").update(JSON.stringify(request)).digest("hex");
		const preview = formatPreview(request, matches.map(({ name }) => name), requestHash);
		if (preview.length > MAX_PREVIEW_CHARS) return false;
		return this.askOwner(preview);
	}

	private async askOwner(preview: string): Promise<boolean> {
		if (!this.api) return false;
		const nonce = randomUUID().replaceAll("-", "").slice(0, 24);
		const result = new Promise<boolean>((resolve) => {
			const timer = setTimeout(() => { this.decisions.delete(nonce); resolve(false); }, this.timeoutMs);
			this.decisions.set(nonce, (approved) => { clearTimeout(timer); resolve(approved); });
		});
		for (const owner of this.owners) {
			try {
				await this.api.call("sendMessage", {
					chat_id: owner,
					text: `Запрос содержит помеченный личный секрет. Разрешить ровно эту отправку?\n\n${preview}`,
					disable_web_page_preview: true,
					reply_markup: { inline_keyboard: [[
						{ text: "Разрешить один раз", callback_data: `sg:${nonce}:y` },
						{ text: "Запретить", callback_data: `sg:${nonce}:n` },
					]] },
				});
			} catch {
				this.decisions.get(nonce)?.(false);
				this.decisions.delete(nonce);
				return false;
			}
		}
		return result;
	}

	private async pollUpdates(): Promise<void> {
		while (!this.stopped && this.api) {
			try {
				const updates = await this.api.call<Array<Record<string, unknown>>>("getUpdates", {
					offset: this.updateOffset, timeout: 20, allowed_updates: ["callback_query"],
				}, { timeoutMs: 30_000 });
				for (const update of updates) {
					this.updateOffset = Math.max(this.updateOffset, Number(update.update_id ?? 0) + 1);
					const callback = update.callback_query as Record<string, unknown> | undefined;
					const sender = callback?.from as Record<string, unknown> | undefined;
					const message = callback?.message as Record<string, unknown> | undefined;
					const chat = message?.chat as Record<string, unknown> | undefined;
					const data = String(callback?.data ?? "").split(":");
					if (data.length !== 3 || data[0] !== "sg" || !this.owners.has(String(sender?.id)) || chat?.type !== "private" || String(chat.id) !== String(sender?.id)) continue;
					const resolve = this.decisions.get(data[1]!);
					if (!resolve) continue;
					this.decisions.delete(data[1]!);
					resolve(data[2] === "y");
					if (callback?.id) await this.api.call("answerCallbackQuery", { callback_query_id: callback.id, text: data[2] === "y" ? "Запрос продолжен" : "Запрос заблокирован" }).catch(() => undefined);
				}
			} catch {
				await new Promise((resolve) => setTimeout(resolve, 1500));
			}
		}
	}
}

export function formatPreview(request: GuardedRequest, secretNames: string[], requestHash: string): string {
	let body = request.body ?? "(пустое тело)";
	try {
		const parsed = JSON.parse(body) as unknown;
		body = JSON.stringify(parsed, null, 2);
	} catch {
		if (body.includes("=") && body.includes("&")) {
			try { body = [...new URLSearchParams(body).entries()].map(([key, value]) => `${key}: ${value}`).join("\n"); }
			catch { /* retain form or text body verbatim */ }
		}
	}
	return [
		`Сайт: ${request.url}`,
		`Действие: ${request.method.toUpperCase()} ${request.url}`,
		`Заголовки:\n${JSON.stringify(request.headers, null, 2)}`,
		`Поля и значения:\n${body}`,
		`Совпавшие метки секрета: ${secretNames.join(", ")}`,
		`Отпечаток запроса: ${requestHash}`,
	].join("\n\n");
}

function isPublicHttpUrl(input: string): boolean {
	try {
		const url = new URL(input);
		return (url.protocol === "http:" || url.protocol === "https:") && !url.username && !url.password;
	} catch { return false; }
}

function secretVariants(value: string): string[] {
	const variants = new Set([value, encodeURIComponent(value), new URLSearchParams({ value }).toString().slice("value=".length)]);
	const bytes = Buffer.from(value, "utf8");
	variants.add(bytes.toString("base64"));
	variants.add(bytes.toString("base64url"));
	variants.add(bytes.toString("hex"));
	return [...variants].filter((item) => item.length >= 4);
}
