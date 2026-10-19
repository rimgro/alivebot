import { TelegramApi, TelegramApiError } from "../telegram/client.js";

/** A single private controller card, edited when its relay or capability changes. */
export class BrowserNotification {
	private messageId?: number;
	constructor(private readonly api: TelegramApi, private readonly chatId: string) {}

	async open(url: string, reason: string, paused: boolean, signal?: AbortSignal): Promise<{ thread: string; messageId: number }> {
		const chat = await this.api.call<{ type: string }>("getChat", { chat_id: this.chatId }, { signal, timeoutMs: 5000 });
		if (chat.type !== "private") throw new Error("Browser Mini App assistance requires a private operator chat");
		const miniAppUrl = new URL(url);
		miniAppUrl.hash = `aliveKey=${miniAppUrl.hash.slice(1)}`;
		const text = paused ? /password|private|verification code/i.test(reason)
			? "Нужен ручной вход.\nОткрой браузер и введи данные."
			: /denied|403|429|rate limit/i.test(reason)
				? "Сайт ограничил доступ.\nОткрой браузер и проверь страницу."
				: "Нужна помощь с проверкой.\nОткрой браузер и нажми «Готово», когда закончишь."
			: "Браузер агента открыт.\nМожно смотреть и управлять страницей.";
		const params = { chat_id: this.chatId, text, disable_web_page_preview: true,
			reply_markup: { inline_keyboard: [[{ text: "Открыть браузер", web_app: { url: miniAppUrl.href } }], [{ text: "В обычном браузере", url }]] } };
		if (this.messageId !== undefined) {
			try { await this.api.call("editMessageText", { ...params, message_id: this.messageId }, { signal, timeoutMs: 5000 }); }
			catch (error) {
				if (error instanceof TelegramApiError && error.errorCode === 400 && /message is not modified/i.test(error.message)) { /* Existing card is already current. */ }
				else if (error instanceof TelegramApiError && error.errorCode === 400 && /message to edit not found|message can't be edited/i.test(error.message)) this.messageId = undefined;
				else throw error;
			}
		}
		if (this.messageId === undefined) {
			const sent = await this.api.call<{ message_id: number }>("sendMessage", { ...params, protect_content: true }, { signal, timeoutMs: 5000 });
			this.messageId = sent.message_id;
		}
		return { thread: `telegram:${this.chatId}`, messageId: this.messageId };
	}

	async finish(state: "returned" | "revoked" | "expired" | "closed"): Promise<void> {
		const messageId = this.messageId; this.messageId = undefined;
		if (messageId === undefined) return;
		const text = { returned: "Готово · агент продолжает работу.", revoked: "Агент отозвал доступ к браузеру.", expired: "Время доступа истекло. Запроси новый пульт у агента.", closed: "Сессия браузера закрыта." }[state];
		await this.api.call("editMessageText", { chat_id: this.chatId, message_id: messageId, text, reply_markup: { inline_keyboard: [] } }, { timeoutMs: 5000 });
	}
}
