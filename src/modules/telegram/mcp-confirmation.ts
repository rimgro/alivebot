/**
 * Operator approval card for Telegram MCP writes (#264, step B2).
 *
 * The proxy writes a pending ticket file; this module-side watcher scans the
 * shared directory, sends one inline card per ticket into the target thread and
 * turns an owner press into `<ticketId>.decision.json`. The proxy is the only
 * process that sends the actual write, and only after reading that decision.
 *
 * Nothing here is model-facing: the callback is intercepted in
 * `TelegramModule.handleUpdate` before `normalizeUpdate`, exactly like the
 * managed-bot button.
 */
import type { TelegramApi } from "./client.js";
import type { TelegramMcpConfirmationRuntimeConfig } from "./mcp/config.js";
import {
	listTickets,
	readTicket,
	resolveTicketDir,
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
	/** Same owner/allowlist check the module applies to inbound updates. */
	isOperator: (userId: number, chatId: number) => boolean;
	/** Used when a ticket carries no chat (an allowChats-free profile). */
	fallbackChatId?: string | number;
	now?: () => number;
	log?: { warn: (message: string, meta?: Record<string, unknown>) => void };
}

export interface TelegramMcpConfirmationOptions extends TelegramMcpConfirmationContext {
	ticketDir: string;
	pollMs: number;
}

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
	});
}

/** How much of the write text a Telegram card shows; the ticket keeps it whole. */
export const MCP_CONFIRMATION_CARD_TEXT_MAX = 2_800;

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

	/** Send cards for new pending tickets and retire overdue ones. */
	async sweep(): Promise<void> {
		if (this.sweeping || this.stopped) return;
		this.sweeping = true;
		try {
			for (const ticket of listTickets(this.options.ticketDir)) {
				if (ticket.status !== "pending") continue;
				const now = this.now();
				if (ticket.expiresAt <= now) {
					await this.expire(ticket);
					continue;
				}
				if (ticket.cardChatId !== undefined && ticket.cardMessageId !== undefined) continue;
				await this.announce(ticket);
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
		const chatId = query.message?.chat.id;
		const userId = query.from.id;
		if (chatId === undefined) {
			await this.answer(query, "Не удалось определить чат карточки", true);
			return true;
		}
		const ticket = readTicket(this.options.ticketDir, parsed.ticketId);
		if (!ticket) {
			await this.answer(query, "Заявка не найдена", true);
			return true;
		}
		// The card is sent into the target thread; a callback from anywhere else
		// is not an operator confirmation for this ticket.
		if (ticket.cardChatId !== undefined && chatId !== ticket.cardChatId) {
			await this.answer(query, "Карточка принадлежит другому чату", true);
			return true;
		}
		// Same rule as every inbound update: the presser must be an allowed human
		// in an allowed chat. A group member who is not the owner cannot approve.
		if (!this.options.isOperator(userId, chatId)) {
			await this.answer(query, "Подтвердить запись может только владелец в разрешённом чате", true);
			return true;
		}
		if (ticket.status !== "pending") {
			await this.answer(query, ticket.status === "expired" ? "Подтверждение истекло" : "Заявка уже обработана", true);
			await this.finishCard(ticket, ticket.status === "expired" ? "expired" : "processed");
			return true;
		}
		const now = this.now();
		if (ticket.expiresAt <= now) {
			await this.expire(ticket);
			await this.answer(query, "Подтверждение истекло", true);
			return true;
		}
		writeDecision(this.options.ticketDir, {
			version: 1,
			ticketId: ticket.ticketId,
			nonce: ticket.nonce,
			decision: parsed.decision,
			decidedAt: now,
			userId,
		});
		markTicketDecided(this.options.ticketDir, ticket.ticketId, userId, now);
		await this.answer(query, parsed.decision === "approve" ? "Подтверждено, запись выполняется" : "Запись отклонена");
		await this.finishCard(ticket, parsed.decision);
		return true;
	}

	private now(): number {
		return (this.options.now ?? (() => Date.now()))();
	}

	/** The card goes into the thread the write targets; fallback is the owner DM. */
	private cardChat(ticket: TelegramMcpTicket): string | number | undefined {
		return ticket.chat ?? this.options.fallbackChatId;
	}

	private async announce(ticket: TelegramMcpTicket): Promise<void> {
		const chat = this.cardChat(ticket);
		if (chat === undefined) {
			this.options.log?.warn("telegram mcp confirmation: no chat for the card", { ticketId: ticket.ticketId, profile: ticket.profile });
			return;
		}
		try {
			const sent = await this.options.api.sendMessage({
				chat_id: chat,
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
			const current = readTicket(this.options.ticketDir, ticket.ticketId);
			if (current && current.status === "pending") {
				writeTicket(this.options.ticketDir, {
					...current,
					cardChatId: sent.chat.id,
					cardMessageId: sent.message_id,
					cardSentAt: this.now(),
				});
			}
		} catch (error) {
			this.options.log?.warn("telegram mcp confirmation card failed", {
				ticketId: ticket.ticketId,
				error: error instanceof Error ? error.message : String(error),
			});
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
			`Действует до: ${expires}\n\n` +
			`Текст записи:\n${text}\n\n` +
			`Без подтверждения ничего не отправляется.`
		);
	}

	private async expire(ticket: TelegramMcpTicket): Promise<void> {
		const current = readTicket(this.options.ticketDir, ticket.ticketId);
		if (!current || current.status !== "pending") return;
		writeTicket(this.options.ticketDir, { ...current, status: "expired" });
		await this.finishCard(current, "expired");
	}

	/** Update the card in place; a short reply is the fallback when editing fails. */
	private async finishCard(ticket: TelegramMcpTicket, outcome: "approve" | "deny" | "expired" | "processed"): Promise<void> {
		if (ticket.cardChatId === undefined || ticket.cardMessageId === undefined) return;
		const suffix =
			outcome === "approve"
				? "\n\n✅ Подтверждено оператором. Запись выполняется."
				: outcome === "deny"
					? "\n\n⛔ Отклонено оператором. Запись не отправлена."
					: outcome === "expired"
						? "\n\n⌛ Подтверждение истекло. Запись не отправлена."
						: "\n\nЗаявка уже обработана.";
		const text = `${this.cardText(ticket)}${suffix}`;
		try {
			await this.options.api.editMessageText({
				chat_id: ticket.cardChatId,
				message_id: ticket.cardMessageId,
				text,
				reply_markup: { inline_keyboard: [] },
			});
		} catch {
			try {
				await this.options.api.sendMessage({ chat_id: ticket.cardChatId, text: `Заявка ${ticket.ticketId}: ${suffix.trim()}` });
			} catch {
				// the callback answer already told the operator; never fail the press on cosmetics
			}
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
