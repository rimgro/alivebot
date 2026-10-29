import * as path from "node:path";
import {
	attachManagedBotToken,
	cancelManagedBotRequests,
	clearManagedBotRequest,
	findManagedBotRequest,
	listManagedBotRequests,
	managedBotRequestStatus,
	markManagedBotRequest,
	queueManagedBotRequest,
	validateAgentId,
	type ManagedAgent,
	type ManagedBotRequest,
	type ManagedBotRequestStatus,
} from "../../agents.js";
import type { LoadedConfig } from "../../config.js";
import { maskSecrets } from "../../secrets.js";
import { iso } from "../../util.js";
import { TelegramApi } from "./client.js";
import { resolveToken } from "./module.js";

/** The durable managed-bot request file and the TTL that applies to it. */
export interface ManagedBotScope {
	root: string;
	ttlMs: number;
}

/** Read-only status row exposed by the CLI and the agent tools. */
export interface ManagedBotRequestView {
	agentId: string;
	chatId: number;
	status: ManagedBotRequestStatus;
	requestedAt: number;
	expiresAt: number;
	error?: string;
	botUsername?: string;
}

export function managedBotScope(base: {
	paths: { modulesDir: string };
	config: { modules: { telegram: { managedBotTtlMs: number } } };
}): ManagedBotScope {
	return {
		root: path.join(base.paths.modulesDir, "telegram"),
		ttlMs: base.config.modules.telegram.managedBotTtlMs,
	};
}

function viewOf(request: ManagedBotRequest, ttlMs: number, now = Date.now()): ManagedBotRequestView {
	return {
		agentId: request.agentId,
		chatId: request.chatId,
		status: managedBotRequestStatus(request, ttlMs, now),
		requestedAt: request.requestedAt,
		expiresAt: request.requestedAt + ttlMs,
		...(request.error ? { error: request.error } : {}),
		...(request.botUsername ? { botUsername: request.botUsername } : {}),
	};
}

/** Pending and terminal requests, newest first, optionally filtered to one agent. */
export function managedBotStatus(scope: ManagedBotScope, agentIdInput?: string): ManagedBotRequestView[] {
	const agentId = agentIdInput ? validateAgentId(agentIdInput) : undefined;
	return listManagedBotRequests(scope.root)
		.filter((request) => !agentId || request.agentId === agentId)
		.map((request) => viewOf(request, scope.ttlMs))
		.sort((left, right) => right.requestedAt - left.requestedAt);
}

export function formatManagedBotStatus(views: ManagedBotRequestView[]): string {
	if (views.length === 0) return "No managed-bot requests.";
	const rows = views.map((view) => {
		const error = view.error ? `\t${view.error}` : "";
		return `${view.agentId}\t${view.status}\trequested ${iso(view.requestedAt)}\texpires ${iso(view.expiresAt)}\tchat ${view.chatId}${error}`;
	});
	return ["agent\tstatus\trequested\texpires\tchat", ...rows].join("\n");
}

function expiryText(request: ManagedBotRequest, ttlMs: number): string {
	const minutes = Math.round(ttlMs / 60_000);
	return (
		`Заявка на создание бота для агента «${request.agentId}» истекла, начни заново. ` +
		`Telegram не прислал подтверждение за ${minutes} мин: возможно, твой клиент не поддерживает managed bots ` +
		"(нужен актуальный Telegram). Запасной вариант — создать бота через @BotFather и выполнить " +
		`alive agents telegram ${request.agentId} --token-env <ENV_NAME>.`
	);
}

export function managedBotKeyboardRemoval() {
	return { reply_markup: { remove_keyboard: true } };
}

/** Request user-confirmed provisioning; never returns or exposes a bot token. */
export async function requestAgentTelegram(base: LoadedConfig, agent: ManagedAgent, chat: string): Promise<ManagedBotRequestView> {
	if (!/^[1-9]\d*$/.test(chat) || !Number.isSafeInteger(Number(chat))) {
		throw new Error("chat must be a positive private Telegram chat ID");
	}
	const scope = managedBotScope(base);
	const chatId = Number(chat);
	const requests = listManagedBotRequests(scope.root);
	// A repeated request is not an error: report the request that is already active.
	const existing = requests.filter((item) => item.agentId === agent.id && !item.status).at(-1);
	if (existing) {
		const status = managedBotRequestStatus(existing, scope.ttlMs);
		if (status === "pending") return viewOf(existing, scope.ttlMs);
		markManagedBotRequest(scope.root, existing, "expired");
	}
	const chatPending = requests.find(
		(item) => item.chatId === chatId && !item.status && managedBotRequestStatus(item, scope.ttlMs) === "pending",
	);
	if (chatPending && chatPending.agentId !== agent.id) {
		throw new Error(
			`a managed-bot request for agent ${chatPending.agentId} is already pending in chat ${chatId}; cancel it first`,
		);
	}
	const token = resolveToken(base.config.modules.telegram);
	if (!token) throw new Error(`master bot token is missing; set modules.telegram.token or $${base.config.modules.telegram.tokenEnv}`);
	const api = new TelegramApi({ token, apiBase: base.config.modules.telegram.apiBase });
	const master = await api.getMe().catch(() => {
		throw new Error("failed to check master bot; check Telegram connectivity and token configuration");
	});
	if (!master.can_manage_bots) throw new Error("master bot lacks can_manage_bots; enable bot management in the @BotFather Mini App first");
	const pending: ManagedBotRequest = { agentId: agent.id, chatId, requestedAt: Date.now() };
	queueManagedBotRequest(scope.root, pending);
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
		clearManagedBotRequest(scope.root, pending);
		// Transport errors can contain the URL (and thus the master bot token).
		throw new Error("failed to send managed-bot request; check Telegram connectivity and that the user has started the master bot");
	}
	return viewOf(pending, scope.ttlMs);
}

/** Remove a pending request now; the Telegram keyboard is removed best-effort. */
export async function cancelAgentTelegram(
	scope: ManagedBotScope,
	api: Pick<TelegramApi, "sendMessage"> | undefined,
	agentIdInput: string,
): Promise<ManagedBotRequestView | undefined> {
	const agentId = validateAgentId(agentIdInput);
	const removed = cancelManagedBotRequests(scope.root, agentId);
	const request = removed.at(-1);
	if (!request) return undefined;
	if (api) {
		await api
			.sendMessage({
				chat_id: request.chatId,
				text: `Заявка на создание бота для агента «${agentId}» отменена. Кнопка создания убрана, можно запросить заново.`,
				...managedBotKeyboardRemoval(),
			})
			.catch(() => undefined);
	}
	return viewOf(request, scope.ttlMs);
}

/**
 * Expire overdue requests: tell the human (the client may not support managed
 * bots) and remove the stale keyboard. Records stay for the status view.
 */
export async function expireManagedBotRequests(
	scope: ManagedBotScope,
	api: Pick<TelegramApi, "sendMessage">,
	options: { now?: number; log?: (error: unknown, request: ManagedBotRequest) => void } = {},
): Promise<ManagedBotRequestView[]> {
	const now = options.now ?? Date.now();
	const expired: ManagedBotRequestView[] = [];
	for (const request of listManagedBotRequests(scope.root)) {
		if (request.status || managedBotRequestStatus(request, scope.ttlMs, now) !== "expired") continue;
		try {
			await api.sendMessage({
				chat_id: request.chatId,
				text: expiryText(request, scope.ttlMs),
				...managedBotKeyboardRemoval(),
			});
			markManagedBotRequest(scope.root, request, "expired");
			expired.push({ ...viewOf(request, scope.ttlMs, now), status: "expired" });
		} catch (error) {
			options.log?.(error, request);
		}
	}
	return expired;
}

/**
 * Finish one `managed_bot_created` confirmation: fetch the bot token, move it
 * into the agent's `.env`, and report the outcome to the initiator.
 */
export async function finalizeManagedBotRequest(options: {
	scope: ManagedBotScope;
	api: Pick<TelegramApi, "getManagedBotToken" | "sendMessage">;
	request: ManagedBotRequest;
	agent?: ManagedAgent;
	bot: { id: number; username?: string };
}): Promise<ManagedBotRequestView> {
	const { scope, api, request, agent, bot } = options;
	let token: string;
	try {
		if (!agent) throw new Error(`agent no longer exists: ${request.agentId}`);
		token = await api.getManagedBotToken(bot.id);
		attachManagedBotToken(agent, token, bot);
	} catch (error) {
		const reason = maskSecrets(error instanceof Error ? error.message : String(error)).slice(0, 300);
		markManagedBotRequest(scope.root, request, "failed", { error: reason });
		const failed: ManagedBotRequestView = { ...viewOf(request, scope.ttlMs), status: "failed", error: reason };
		await api
			.sendMessage({
				chat_id: request.chatId,
				text:
					`Не удалось подключить бота к агенту «${request.agentId}»: ${reason}. Заявка снята, кнопка убрана. ` +
					"Попробуй ещё раз или создай бота через @BotFather.",
				...managedBotKeyboardRemoval(),
			})
			.catch(() => undefined);
		return failed;
	}
	markManagedBotRequest(scope.root, request, "created", { botUsername: bot.username });
	const created: ManagedBotRequestView = { ...viewOf(request, scope.ttlMs), status: "created", botUsername: bot.username };
	await api
		.sendMessage({
			chat_id: request.chatId,
			text:
				`Managed bot @${bot.username ?? bot.id} подключён к агенту «${request.agentId}». ` +
				`Токен лежит в .env агента (0600). Запусти: alive agents start ${request.agentId}`,
			...managedBotKeyboardRemoval(),
		})
		.catch(() => undefined);
	return created;
}

export { findManagedBotRequest };
