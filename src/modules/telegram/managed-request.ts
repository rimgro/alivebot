import * as path from "node:path";
import { clearManagedBotRequest, queueManagedBotRequest, type ManagedAgent } from "../../agents.js";
import type { LoadedConfig } from "../../config.js";
import { TelegramApi } from "./client.js";
import { resolveToken } from "./module.js";

/** Request user-confirmed provisioning; never returns or exposes a bot token. */
export async function requestAgentTelegram(base: LoadedConfig, agent: ManagedAgent, chat: string): Promise<void> {
	if (!/^[1-9]\d*$/.test(chat) || !Number.isSafeInteger(Number(chat))) {
		throw new Error("chat must be a positive private Telegram chat ID");
	}
	const token = resolveToken(base.config.modules.telegram);
	if (!token) throw new Error(`master bot token is missing; set modules.telegram.token or $${base.config.modules.telegram.tokenEnv}`);
	const api = new TelegramApi({ token, apiBase: base.config.modules.telegram.apiBase });
	const master = await api.getMe().catch(() => {
		throw new Error("failed to check master bot; check Telegram connectivity and token configuration");
	});
	if (!master.can_manage_bots) throw new Error("master bot lacks can_manage_bots; enable bot management in the @BotFather Mini App first");
	const chatId = Number(chat);
	const pending = { agentId: agent.id, chatId, requestedAt: Date.now() };
	const pendingRoot = path.join(base.paths.modulesDir, "telegram");
	queueManagedBotRequest(pendingRoot, pending);
	try {
		await api.sendMessage({
			chat_id: chatId,
			text: `Create a Telegram bot profile for agent “${agent.id}” and share it with me. Telegram will ask you to confirm.`,
			reply_markup: {
				keyboard: [[{ text: `Create bot for ${agent.id}`, request_managed_bot: { request_id: Date.now() % 2_147_483_647, suggested_name: `${agent.id} agent` } }]],
				resize_keyboard: true,
				one_time_keyboard: true,
			},
		});
	} catch {
		clearManagedBotRequest(pendingRoot, pending);
		// Transport errors can contain the URL (and thus the master bot token).
		throw new Error("failed to send managed-bot request; check Telegram connectivity and that the user has started the master bot");
	}
}
