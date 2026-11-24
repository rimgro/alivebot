/**
 * Operator approval card for Telegram MCP writes (#264, step B2).
 *
 * The proxy writes a pending ticket file; this module-side watcher scans the
 * shared directory, sends one inline card per ticket into the configured thread
 * and turns an allowed operator press into `<ticketId>.decision.json`. The proxy
 * is the only process that sends the actual write, and only after reading that
 * decision.
 *
 * Tickets live in `<ticketDir>/<profile>/`; this module scans every profile
 * subdirectory but accepts a press only from `chatId` and `operatorUserIds`.
 *
 * Nothing here is model-facing: the callback is intercepted in
 * `TelegramModule.handleUpdate` before `normalizeUpdate`, exactly like the
 * managed-bot button.
 */
import type { TelegramApi } from "./client.js";
import type { TelegramMcpConfirmationRuntimeConfig } from "./mcp/config.js";
import {
	listProfileTicketDirs,
	listTickets,
	readTicket,
	resolveTicketDir,
	sweepExpiredTickets,
	writeDecision,
	writeTicket,
	type TelegramMcpTicket,
} from "./mcp/tickets.js";
import type { TelegramCallbackQuery } from "./types.js";

export const MCP_CONFIRMATION_CALLBACK_PREFIX = "alive_tgmcp:";

export interface McpConfirmationCallback {
	ticketId: string;
	decision: "approve" | "deny";
}

/** Telegram limits `callback_data` to 64 bytes; a ticket id is 22 characters. */
export function mcpConfirmationCallbackData(ticketId: string, decision: "ok" | "no"): string {
	return `${MCP_CONFIRMATION_CALLBACK_PREFIX}${ticketId}:${decision}`;
}

export function parseMcpConfirmationCallbackData(data: string | undefined): McpConfirmationCallback | undefined {
	if (!data?.startsWith(MCP_CONFIRMATION_CALLBACK_PREFIX)) return undefined;
	const rest = data.slice(MCP_CONFIRMATION_CALLBACK_PREFIX.length);
	const match = /^(tgask_[0-9a-f]{16}):(ok|no)$/.exec(rest);
	if (!match?.[1] || !match[2]) return undefined;
	return { ticketId: match[1], decision: match[2] === "ok" ? "approve" : "deny" };
}

export interface TelegramMcpConfirmationContext {
	/** Host state directory; a relative ticketDir is resolved against it. */
	stateDir: string;
	api: Pick<TelegramApi, "sendMessage" | "editMessageText" | "answerCallbackQuery">;
	now?: () => number;
	log?: { warn: (message: string, meta?: Record<string, unknown>) => void };
}

export interface TelegramMcpConfirmationOptions extends TelegramMcpConfirmationContext {
	ticketDir: string;
	pollMs: number;
	/** The only thread cards are sent to and presses are accepted from. */
	chatId: number;
	/** Non-empty allowlist of Telegram user ids allowed to press the buttons. */
	operatorUserIds: number[];
}

/** A press that is not from the configured chat and operator list. */
export const MCP_CONFIRMATION_FOREIGN_PRESS = "это не ваш запрос";
/** A second press on an already processed ticket. */
export const MCP_CONFIRMATION_ALREADY_HANDLED = "уже обработано";

/**
 * Return a watcher only when `modules.telegram.mcpConfirmation` is configured:
 * with the option absent there is no timer and no directory read at all.
 */
export function createTelegramMcpConfirmation(
	config: TelegramMcpConfirmationRuntimeConfig | undefined,
	context: TelegramMcpConfirmationContext,
): TelegramMcpConfirmation | undefined {
	if (!config) return undefined;
	return new TelegramMcpConfirmation({
		...context,
		ticketDir: resolveTicketDir(context.stateDir, config.ticketDir),
		pollMs: config.pollMs,
		chatId: config.chatId,
		operatorUserIds: [...config.operatorUserIds],
	});
}

/** How much of the write text a Telegram card shows; the ticket keeps it whole. */
export const MCP_CONFIRMATION_CARD_TEXT_MAX = 2_800;

/** Final card suffix per terminal ticket status. */
const FINAL_SUFFIX: Record<string, string> = {
	approve: "\n\n✅ Подтверждено оператором. Запись выполняется.",
	sent: "\n\n✅ Отправлено.",
	denied: "\n\n⛔ Отказ. Запись не отправлена.",
	failed: "\n\n⚠️ Ошибка. Запись не отправлена.",
	expired: "\n\n⌛ Подтверждение истекло. Запись не отправлена.",
	processed: "\n\nЗаявка уже обработана.",
};

export class TelegramMcpConfirmation {
	private readonly options: TelegramMcpConfirmationOptions;
	private timer?: NodeJS.Timeout;
	private sweeping = false;
	private stopped = false;

	constructor(options: TelegramMcpConfirmationOptions) {
		this.options = options;
	}

	start(): void {
		if (this.stopped || this.timer) return;
		this.timer = setInterval(() => void this.sweep(), this.options.pollMs);
		this.timer.unref?.();
		void this.sweep();
	}

	stop(): void {
		this.stopped = true;
		if (this.timer) clearInterval(this.timer);
		this.timer = undefined;
	}

	/** Send cards for new pending tickets, finalize terminal ones and clean up. */
	async sweep(): Promise<void> {
		if (this.sweeping || this.stopped) return;
		this.sweeping = true;
		try {
			for (const dir of listProfileTicketDirs(this.options.ticketDir)) {
				for (const ticket of listTickets(dir)) {
					const now = this.now();
					if (ticket.status === "pending") {
						if (ticket.expiresAt <= now) {
							await this.expire(dir, ticket);
							continue;
						}
						if (ticket.cardChatId !== undefined && ticket.cardMessageId !== undefined) continue;
						await this.announce(dir, ticket);
						continue;
					}
					// A terminal ticket whose card still has buttons gets its final edit.
					if (
						FINAL_SUFFIX[ticket.status] !== undefined &&
						ticket.cardChatId !== undefined &&
						ticket.cardMessageId !== undefined &&
						ticket.cardClosedAt === undefined
					) {
						await this.finishCard(dir, ticket, ticket.status);
					}
				}
				sweepExpiredTickets(dir, this.now());
			}
		} finally {
			this.sweeping = false;
		}
	}

	/**
	 * Intercept the internal callback before `normalizeUpdate`. Returns true for
	 * every `alive_tgmcp:` callback, valid or not, so it never reaches the model.
	 */
	async handleCallback(query: TelegramCallbackQuery): Promise<boolean> {
		const parsed = parseMcpConfirmationCallbackData(query.data);
		if (!parsed) return false;
		try {
			await this.handleParsedCallback(query, parsed);
		} catch (error) {
			this.options.log?.warn("telegram mcp confirmation callback failed", {
				error: error instanceof Error ? error.message : String(error),
			});
			// The operator must always get an answer, including on an internal error.
			await this.answer(query, "Не удалось обработать подтверждение", true);
		}
		return true;
	}

	private async handleParsedCallback(query: TelegramCallbackQuery, parsed: McpConfirmationCallback): Promise<void> {
		const chatId = query.message?.chat.id;
		const userId = query.from.id;
		// Authorization is explicit and independent of the module allowlist: only
		// the configured thread and the configured operator ids may decide.
		if (chatId !== this.options.chatId || !this.options.operatorUserIds.includes(userId)) {
			await this.answer(query, MCP_CONFIRMATION_FOREIGN_PRESS, true);
			return;
		}
		const found = this.findTicket(parsed.ticketId);
		if (!found) {
			await this.answer(query, "Заявка не найдена", true);
			return;
		}
		const { dir, ticket } = found;
		if (ticket.status !== "pending") {
			await this.answer(query, MCP_CONFIRMATION_ALREADY_HANDLED);
			if (FINAL_SUFFIX[ticket.status] !== undefined && ticket.cardClosedAt === undefined) {
				await this.finishCard(dir, ticket, ticket.status);
			}
			return;
		}
		const now = this.now();
		if (ticket.expiresAt <= now) {
			await this.expire(dir, ticket);
			await this.answer(query, "Подтверждение истекло", true);
			return;
		}
		writeDecision(dir, {
			version: 1,
			ticketId: ticket.ticketId,
			nonce: ticket.nonce,
			requestHash: ticket.requestHash,
			decision: parsed.decision,
			decidedAt: now,
			userId,
		});
		if (parsed.decision === "approve") {
			markTicketDecided(dir, ticket.ticketId, userId, now);
		} else {
			markTicketDenied(dir, ticket.ticketId, userId, now);
		}
		await this.answer(query, parsed.decision === "approve" ? "Подтверждено, запись выполняется" : "Запись отклонена");
		// "approve" is not final: the proxy will mark sent/failed and the sweep
		// edits the card then. Deny/expiry are final immediately.
		await this.finishCard(dir, ticket, parsed.decision === "approve" ? "approve" : "denied");
	}

	private now(): number {
		return (this.options.now ?? (() => Date.now()))();
	}

	private findTicket(ticketId: string): { dir: string; ticket: TelegramMcpTicket } | undefined {
		for (const dir of listProfileTicketDirs(this.options.ticketDir)) {
			const ticket = readTicket(dir, ticketId);
			if (ticket) return { dir, ticket };
		}
		return undefined;
	}

	private async announce(dir: string, ticket: TelegramMcpTicket): Promise<void> {
		try {
			const sent = await this.options.api.sendMessage({
				chat_id: this.options.chatId,
				text: this.cardText(ticket),
				reply_markup: {
					inline_keyboard: [
						[
							{ text: "✅ Отправить", callback_data: mcpConfirmationCallbackData(ticket.ticketId, "ok") },
							{ text: "⛔ Отказ", callback_data: mcpConfirmationCallbackData(ticket.ticketId, "no") },
						],
					],
				},
			});
			// Only bookkeeping fields: never overwrite a status the proxy just set.
			const current = readTicket(dir, ticket.ticketId);
			if (current && current.status === "pending") {
				writeTicket(dir, {
					...current,
					cardChatId: sent.chat.id,
					cardMessageId: sent.message_id,
					cardSentAt: this.now(),
				});
			}
		} catch (error) {
			const reason = `confirmation card could not be sent: ${error instanceof Error ? error.message : String(error)}`;
			this.options.log?.warn("telegram mcp confirmation card failed", { ticketId: ticket.ticketId, error: reason });
			// No card means no way to approve: deny now instead of waiting for the TTL.
			const current = readTicket(dir, ticket.ticketId);
			if (current && current.status === "pending") {
				writeTicket(dir, { ...current, status: "denied", error: reason });
			}
		}
	}

	private cardText(ticket: TelegramMcpTicket): string {
		const text =
			ticket.text.length > MCP_CONFIRMATION_CARD_TEXT_MAX
				? `${ticket.text.slice(0, MCP_CONFIRMATION_CARD_TEXT_MAX)}\n… (обрезано для карточки, запись уйдёт целиком)`
				: ticket.text;
		const expires = new Date(ticket.expiresAt).toISOString().replace("T", " ").replace(/\.\d+Z$/, " UTC");
		return (
			`🔐 Подтверждение записи в Telegram\n\n` +
			`Профиль: ${ticket.profile}\n` +
			`Чат: ${ticket.chat ?? "не указан"}\n` +
			`Действие: ${ticket.tool}\n` +
			`Действует до: ${expires}\n` +
			`Хэш запроса: ${ticket.requestHash}\n\n` +
			`Текст записи:\n${text}\n\n` +
			`Без подтверждения ничего не отправляется.`
		);
	}

	private async expire(dir: string, ticket: TelegramMcpTicket): Promise<void> {
		const current = readTicket(dir, ticket.ticketId);
		if (!current || current.status !== "pending") return;
		writeTicket(dir, { ...current, status: "expired" });
		await this.finishCard(dir, { ...current, status: "expired" }, "expired");
	}

	/** Update the card in place without buttons; a short reply is the last resort. */
	private async finishCard(dir: string, ticket: TelegramMcpTicket, outcome: string): Promise<void> {
		if (ticket.cardChatId === undefined || ticket.cardMessageId === undefined) return;
		const suffix = FINAL_SUFFIX[outcome] ?? FINAL_SUFFIX.processed;
		const text = `${this.cardText(ticket)}${suffix}`;
		let edited = false;
		try {
			await this.options.api.editMessageText({
				chat_id: ticket.cardChatId,
				message_id: ticket.cardMessageId,
				text,
				reply_markup: { inline_keyboard: [] },
			});
			edited = true;
		} catch {
			try {
				await this.options.api.sendMessage({ chat_id: ticket.cardChatId, text: `Заявка ${ticket.ticketId}: ${suffix.trim()}` });
				edited = true;
			} catch {
				// the callback answer already told the operator; never fail the press on cosmetics
			}
		}
		// "approve" is only a transient marker: the proxy will produce sent/failed
		// and the card must be editable one more time.
		if (!edited || outcome === "approve") return;
		const current = readTicket(dir, ticket.ticketId);
		if (current && current.cardClosedAt === undefined) {
			writeTicket(dir, { ...current, cardClosedAt: this.now() });
		}
	}

	private async answer(query: TelegramCallbackQuery, text: string, alert = false): Promise<void> {
		try {
			await this.options.api.answerCallbackQuery({ callback_query_id: query.id, text, ...(alert ? { show_alert: true } : {}) });
		} catch {
			// the client spinner is best-effort
		}
	}
}

function markTicketDecided(ticketDir: string, ticketId: string, userId: number, at: number): void {
	const ticket = readTicket(ticketDir, ticketId);
	if (!ticket || ticket.status !== "pending") return;
	writeTicket(ticketDir, { ...ticket, status: "decided", decidedAt: at, decidedBy: userId });
}

function markTicketDenied(ticketDir: string, ticketId: string, userId: number, at: number): void {
	const ticket = readTicket(ticketDir, ticketId);
	if (!ticket || ticket.status !== "pending") return;
	writeTicket(ticketDir, {
		...ticket,
		status: "denied",
		decidedAt: at,
		decidedBy: userId,
		error: "write denied by operator",
	});
}
