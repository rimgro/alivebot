/**
 * Focused tests for Managed Bot requests: status, repeat, cancel, expiry and
 * the token being moved into the agent's `.env`.
 *
 *   npm run test:managed-bot
 *
 * Fake Bot API and filesystem fixtures only; no network and no model.
 */
import * as assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { createAgent, findManagedAgent, findManagedBotRequest, listManagedBotRequests, managedBotRequestStatus } from "../agents.js";
import { DEFAULT_CONFIG, loadConfig } from "../config.js";
import { ModuleHost } from "../events/host.js";
import { Logger } from "../log.js";
import { EventStore } from "../store/events.js";
import { HistoryStore } from "../store/history.js";
import { Outbox } from "../store/outbox.js";
import { TelegramApi } from "../modules/telegram/client.js";
import { TelegramModule } from "../modules/telegram/module.js";
import { mcpConfirmationCallbackData } from "../modules/telegram/mcp-confirmation.js";
import {
	decisionFilePath,
	readTicket,
	resolveTicketDir,
	ticketFilePath,
	writeTicket,
	type TelegramMcpTicket,
} from "../modules/telegram/mcp/tickets.js";
import type { TelegramUpdate } from "../modules/telegram/types.js";
import {
	cancelAgentTelegram,
	expireManagedBotRequests,
	finalizeManagedBotRequest,
	formatManagedBotStatus,
	managedBotCallbackData,
	managedBotScope,
	managedBotStatus,
	requestAgentTelegram,
} from "../modules/telegram/managed-request.js";

let failures = 0;
function check(name: string, condition: boolean, detail?: unknown): void {
	if (condition) {
		process.stdout.write(`  ok    ${name}\n`);
		return;
	}
	failures += 1;
	process.stdout.write(`  FAIL  ${name}${detail === undefined ? "" : ` — ${JSON.stringify(detail)}`}\n`);
}

function section(name: string): void {
	process.stdout.write(`\n${name}\n`);
}

function jsonResponse(value: unknown): Response {
	return new Response(JSON.stringify(value), { status: 200, headers: { "content-type": "application/json" } });
}

function mode(file: string): number {
	return fs.statSync(file).mode & 0o777;
}

async function waitFor(predicate: () => boolean, timeoutMs = 3_000): Promise<boolean> {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		if (predicate()) return true;
		await new Promise((resolve) => setTimeout(resolve, 10));
	}
	return predicate();
}

const root = fs.mkdtempSync(path.join(os.tmpdir(), "alive-managed-bot-test-"));
fs.writeFileSync(path.join(root, "SOUL.md"), "test soul\n");
fs.writeFileSync(path.join(root, "CONTRACT.md"), "test contract\n");

const telegramConfig = {
	...DEFAULT_CONFIG.modules.telegram,
	enabled: true,
	token: "master-test-token",
	tokenEnv: "ALIVE_MANAGED_BOT_TEST_MASTER_UNSET",
	apiBase: "https://telegram.invalid",
	managedBotTtlMs: DEFAULT_CONFIG.modules.telegram.managedBotTtlMs,
};
const config = loadConfig({
	cwd: root,
	overrides: { modules: { ...DEFAULT_CONFIG.modules, telegram: telegramConfig } },
});

section("ttl validation");
{
	check(
		"default TTL is within the 10–15 minute window",
		DEFAULT_CONFIG.modules.telegram.managedBotTtlMs >= 10 * 60_000 && DEFAULT_CONFIG.modules.telegram.managedBotTtlMs <= 15 * 60_000,
		DEFAULT_CONFIG.modules.telegram.managedBotTtlMs,
	);
	assert.throws(
		() => loadConfig({ cwd: root, overrides: { modules: { ...DEFAULT_CONFIG.modules, telegram: { ...telegramConfig, managedBotTtlMs: 60_000 } } } }),
		/managedBotTtlMs/,
	);
	check("out-of-range TTL is rejected", true);
}

const agent = createAgent(config, "analyst", "Analyst");
assert.ok(findManagedAgent(config, "analyst"));
const scope = managedBotScope(config);
const token = "987654:managed-secret-token";
const calls: Array<{ method: string; params: Record<string, any> }> = [];
let failManagedToken = false;

const previousFetch = globalThis.fetch;
globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
	const method = String(input).split("/").pop()!;
	const params = init?.body ? (JSON.parse(String(init.body)) as Record<string, any>) : {};
	calls.push({ method, params });
	if (method === "getMe") {
		return jsonResponse({ ok: true, result: { id: 1, is_bot: true, first_name: "Master", username: "master_bot", can_manage_bots: true } });
	}
	if (method === "sendMessage") {
		return jsonResponse({ ok: true, result: { message_id: calls.length, date: 1, chat: { id: Number(params.chat_id), type: "private" } } });
	}
	if (method === "getManagedBotToken") {
		if (failManagedToken) throw new Error("Telegram rejected getManagedBotToken: bot was not authorized");
		return jsonResponse({ ok: true, result: token });
	}
	throw new Error(`unexpected Bot API method ${method}`);
}) as typeof fetch;
const api = new TelegramApi({ token: "master-test-token", apiBase: "https://telegram.invalid" });

try {
	section("request and status");
	{
		const requested = await requestAgentTelegram(config, agent, "123456789");
		check("a new request is pending", requested.status === "pending", requested);
		check("the request carries the target agent and chat", requested.agentId === "analyst" && requested.chatId === 123456789, requested);
		const requestMessage = calls.filter((call) => call.method === "sendMessage").at(-1)?.params;
		check(
			"the request uses an inline keyboard that cannot stick above the composer",
			requestMessage?.reply_markup?.inline_keyboard?.[0]?.[0]?.callback_data === managedBotCallbackData("analyst") &&
				requestMessage?.reply_markup?.keyboard === undefined,
			requestMessage?.reply_markup,
		);
		check(
			"expiry is the request time plus the TTL",
			requested.expiresAt === requested.requestedAt + config.config.modules.telegram.managedBotTtlMs,
			{ requested, ttl: config.config.modules.telegram.managedBotTtlMs },
		);
		const views = managedBotStatus(scope);
		check("status lists the pending request", views.length === 1 && views[0]?.status === "pending" && views[0]?.agentId === "analyst", views);
		check("status text names agent, request time and expiry", ["analyst", "pending", "requested", "expires"].every((part) => formatManagedBotStatus(views).includes(part)), formatManagedBotStatus(views));

		const sendsBefore = calls.filter((call) => call.method === "sendMessage").length;
		const repeated = await requestAgentTelegram(config, agent, "123456789");
		check("a repeat request returns the same request", repeated.requestedAt === requested.requestedAt && repeated.expiresAt === requested.expiresAt, { requested, repeated });
		check("a repeat request does not send another button message", calls.filter((call) => call.method === "sendMessage").length === sendsBefore);
	}

	section("cancel and retry");
	{
		const cancelled = await cancelAgentTelegram(scope, api, "analyst");
		check("cancel reports the removed request", cancelled?.agentId === "analyst" && cancelled?.status === "pending", cancelled);
		check("cancel removes the pending state", findManagedBotRequest(scope.root, 123456789) === undefined && managedBotStatus(scope).length === 0);
		const cancelMessage = calls.filter((call) => call.method === "sendMessage").at(-1)?.params;
		check("cancel removes the Telegram keyboard", cancelMessage?.reply_markup?.remove_keyboard === true, cancelMessage);
		const afterCancel = await requestAgentTelegram(config, agent, "123456789");
		check("a new request after cancel succeeds", afterCancel.status === "pending" && afterCancel.requestedAt > (cancelled?.requestedAt ?? 0), afterCancel);
	}

	section("expiry");
	{
		const pending = findManagedBotRequest(scope.root, 123456789);
		assert.ok(pending);
		const requests = listManagedBotRequests(scope.root);
		for (const request of requests) if (request.requestedAt === pending.requestedAt) request.requestedAt = Date.now() - scope.ttlMs - 1;
		fs.writeFileSync(path.join(scope.root, "managed-bot-requests.json"), `${JSON.stringify(requests, null, 2)}\n`, { mode: 0o600 });
		check("an overdue request is expired by status even before the sweep", managedBotRequestStatus(listManagedBotRequests(scope.root)[0]!, scope.ttlMs) === "expired");
		const expired = await expireManagedBotRequests(scope, api);
		check("the sweep expires the request", expired.length === 1 && expired[0]?.status === "expired", expired);
		const expiryMessage = calls.filter((call) => call.method === "sendMessage").at(-1)?.params;
		check(
			"the human is told the request expired and gets the BotFather fallback",
			String(expiryMessage?.text).includes("истекла") &&
				String(expiryMessage?.text).includes("начни заново") &&
				String(expiryMessage?.text).includes("managed bots") &&
				String(expiryMessage?.text).includes("BotFather"),
			expiryMessage,
		);
		check("expiry removes the Telegram keyboard", expiryMessage?.reply_markup?.remove_keyboard === true, expiryMessage);
		check("expiry clears the pending state but keeps the status row", findManagedBotRequest(scope.root, 123456789) === undefined && managedBotStatus(scope)[0]?.status === "expired", managedBotStatus(scope));
		const afterExpiry = await requestAgentTelegram(config, agent, "123456789");
		check("a new request after expiry succeeds", afterExpiry.status === "pending", afterExpiry);
	}

	section("success path: token goes to .env");
	{
		const pending = findManagedBotRequest(scope.root, 123456789);
		assert.ok(pending);
		const created = await finalizeManagedBotRequest({ scope, api, request: pending, agent, bot: { id: 555, username: "analyst_bot" } });
		check("success reports a created request", created.status === "created" && created.botUsername === "analyst_bot", created);
		const configText = fs.readFileSync(agent.configPath, "utf8");
		const raw = JSON.parse(configText);
		check("no plaintext token remains in alive.config.json", !configText.includes(token) && raw.modules.telegram.token === undefined, configText);
		const envName = raw.modules.telegram.tokenEnv;
		check("the config points at a tokenEnv", typeof envName === "string" && /^[A-Za-z_][A-Za-z0-9_]*$/.test(envName), envName);
		check("Telegram is enabled for the agent", raw.modules.telegram.enabled === true);
		const envPath = path.join(agent.directory, ".env");
		check(".env exists next to the agent config", fs.existsSync(envPath));
		check(".env is mode 0600", (fs.statSync(envPath).mode & 0o777) === 0o600, (fs.statSync(envPath).mode & 0o777).toString(8));
		const envText = fs.readFileSync(envPath, "utf8");
		check("the token is in .env under tokenEnv", envText.includes(`${envName}=${token}`), envText.replace(token, "<token>"));
		const reloaded = loadConfig({ cwd: agent.directory, configPath: agent.configPath, migrateSecrets: false });
		check("loading the agent config hydrates the token from .env", reloaded.config.modules.telegram.token === token, reloaded.config.modules.telegram.tokenEnv);
		const successMessage = calls.filter((call) => call.method === "sendMessage").at(-1)?.params;
		check(
			"the initiator is told which agent got the bot and how to start it",
			String(successMessage?.text).includes("analyst") && String(successMessage?.text).includes("alive agents start analyst"),
			successMessage,
		);
		check("success removes the Telegram keyboard", successMessage?.reply_markup?.remove_keyboard === true, successMessage);
		check("the success caption explains the button was removed", String(successMessage?.text).includes("Кнопка создания убрана"), successMessage);
		check("status shows the created request", managedBotStatus(scope)[0]?.status === "created", managedBotStatus(scope));
	}

	section("failure path reports the reason");
	{
		const pending = await requestAgentTelegram(config, agent, "123456789");
		check("the next request replaces the created row with a fresh pending request", pending.status === "pending", pending);
		failManagedToken = true;
		const request = findManagedBotRequest(scope.root, 123456789);
		assert.ok(request);
		const failed = await finalizeManagedBotRequest({ scope, api, request, agent, bot: { id: 556, username: "broken_bot" } });
		check("failure is recorded with the exact reason", failed.status === "failed" && String(failed.error).includes("not authorized"), failed);
		check("failure clears the pending state", findManagedBotRequest(scope.root, 123456789) === undefined);
		const failureMessage = calls.filter((call) => call.method === "sendMessage").at(-1)?.params;
		check(
			"the initiator is told exactly what failed",
			String(failureMessage?.text).includes("Не удалось") && String(failureMessage?.text).includes("not authorized"),
			failureMessage,
		);
		check("status shows the failed request", managedBotStatus(scope)[0]?.status === "failed", managedBotStatus(scope));
	}

	section("mcp confirmation: card, owner press and disabled option");
	{
		const mcpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "alive-mcp-confirmation-test-"));
		fs.writeFileSync(path.join(mcpRoot, "SOUL.md"), "test soul\n");
		fs.writeFileSync(path.join(mcpRoot, "CONTRACT.md"), "test contract\n");
		const mcpLog = new Logger({ console: false, level: "error", scope: "mcp-confirmation-test" });
		const store = EventStore.open(mcpRoot);
		const history = HistoryStore.open(mcpRoot);
		const outbox = new Outbox(mcpRoot);
		const mcpCalls: Array<{ method: string; params: Record<string, any> }> = [];
		const updates: TelegramUpdate[] = [];
		let nextMessageId = 700;
		let nextUpdateId = 10_000;
		const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
			const url = String(input);
			const method = url.slice(url.lastIndexOf("/") + 1);
			const params = init?.body ? (JSON.parse(String(init.body)) as Record<string, any>) : {};
			mcpCalls.push({ method, params });
			if (method === "getMe") {
				return jsonResponse({ ok: true, result: { id: 999, is_bot: true, first_name: "Alive", username: "alive_bot" } });
			}
			if (method === "deleteWebhook") return jsonResponse({ ok: true, result: true });
			if (method === "getUpdates") {
				if (updates.length > 0) return jsonResponse({ ok: true, result: updates.splice(0) });
				return new Promise<Response>((resolve) => {
					const timer = setTimeout(() => resolve(jsonResponse({ ok: true, result: [] })), 10);
					if (init?.signal?.aborted) {
						clearTimeout(timer);
						return resolve(jsonResponse({ ok: true, result: [] }));
					}
					init?.signal?.addEventListener(
						"abort",
						() => {
							clearTimeout(timer);
							resolve(jsonResponse({ ok: true, result: [] }));
						},
						{ once: true },
					);
				});
			}
			if (method === "sendMessage") {
				nextMessageId += 1;
				return jsonResponse({
					ok: true,
					result: { message_id: nextMessageId, date: 1, chat: { id: Number(params.chat_id), type: "private" } },
				});
			}
			if (method === "editMessageText" || method === "answerCallbackQuery") return jsonResponse({ ok: true, result: true });
			return jsonResponse({ ok: true, result: true });
		}) as unknown as typeof fetch;

		const makeConfig = (withConfirmation: boolean) =>
			loadConfig({
				cwd: mcpRoot,
				overrides: {
					chat: { console: false, http: { enabled: false, host: "127.0.0.1", port: 0, token: "" } },
					modules: {
						telegram: {
							...DEFAULT_CONFIG.modules.telegram,
							enabled: true,
							token: "mcp-confirmation-test-token",
							tokenEnv: "ALIVE_MCP_CONFIRMATION_TEST_TOKEN_UNSET",
							apiBase: "https://telegram.invalid",
							allowedChatIds: ["42"],
							allowedUserIds: ["7"],
							pollTimeoutSec: 0,
							historyLimitPerThread: 0,
							...(withConfirmation ? { mcpConfirmation: { ticketDir: "telegram-mcp-tickets", pollMs: 10 } } : {}),
						},
						grafana: { ...DEFAULT_CONFIG.modules.grafana, enabled: false, host: "127.0.0.1", port: 0, token: "" },
						external: [],
					},
				},
			});

		const makeTicket = (ticketId: string, text: string): TelegramMcpTicket => {
			const now = Date.now();
			return {
				version: 1,
				ticketId,
				profile: "ops",
				tool: "telegram_write",
				chat: "42",
				text,
				createdAt: now,
				expiresAt: now + 60_000,
				nonce: `nonce-${ticketId}`,
				status: "pending",
				requestKey: `key-${ticketId}`,
			};
		};
		const cardCall = (text: string) =>
			mcpCalls
				.filter((call) => call.method === "sendMessage" && String(call.params.text).includes("Подтверждение записи в Telegram"))
				.find((call) => String(call.params.text).includes(text));
		const callbackUpdate = (id: string, data: string, userId: number, chatId: number, messageId: number): TelegramUpdate => ({
			update_id: nextUpdateId++,
			callback_query: {
				id,
				from: { id: userId, is_bot: false, first_name: `User${userId}` },
				chat_instance: "chat-instance",
				data,
				message: { message_id: messageId, date: 1, chat: { id: chatId, type: "private" }, text: "confirmation card" },
			},
		});

		const realFetch = globalThis.fetch;
		globalThis.fetch = fetchImpl;
		let host: ModuleHost | undefined;
		try {
			const config = makeConfig(true);
			const ticketDir = resolveTicketDir(config.paths.stateDir, "telegram-mcp-tickets");
			const telegram = new TelegramModule(config.config.modules.telegram);
			host = new ModuleHost({
				config,
				log: mcpLog,
				transports: [],
				modules: [telegram],
				ingest: (event) => store.append(event),
				outbox: (limit) => outbox.list(limit),
				history,
				runtimeStatus: () => ({}),
			});
			await host.init();

			check(
				"the confirmation watcher exists only with the config option",
				(telegram as unknown as { mcpConfirmation?: unknown }).mcpConfirmation !== undefined,
			);

			const ticket = makeTicket("tgask_aaaaaaaaaaaaaaaa", "confirm-card-text");
			writeTicket(ticketDir, ticket);
			const cardSent = await waitFor(() => cardCall("confirm-card-text") !== undefined);
			const card = cardCall("confirm-card-text");
			check("a pending ticket becomes a card in the target thread", cardSent && Number(card?.params.chat_id) === 42, card?.params);
			check("the ticket file is 0600", mode(ticketFilePath(ticketDir, ticket.ticketId)) === 0o600, mode(ticketFilePath(ticketDir, ticket.ticketId)).toString(8));
			check(
				"the card names the profile, chat, expiry and exact write text",
				String(card?.params.text).includes("Профиль: ops") &&
					String(card?.params.text).includes("Чат: 42") &&
					String(card?.params.text).includes("Действует до:") &&
					String(card?.params.text).includes("confirm-card-text"),
				card?.params.text,
			);
			const buttons = (card?.params.reply_markup?.inline_keyboard ?? []) as Array<Array<{ text?: string; callback_data?: string }>>;
			check(
				"the card has Send and Refuse buttons with ticket callback data",
				buttons[0]?.[0]?.callback_data === mcpConfirmationCallbackData(ticket.ticketId, "ok") &&
					buttons[0]?.[1]?.callback_data === mcpConfirmationCallbackData(ticket.ticketId, "no"),
				buttons,
			);
			const cardMessageId = readTicket(ticketDir, ticket.ticketId)?.cardMessageId;
			check(
				"the card is recorded on the ticket",
				typeof cardMessageId === "number" && readTicket(ticketDir, ticket.ticketId)?.cardChatId === 42,
				readTicket(ticketDir, ticket.ticketId),
			);

			updates.push(callbackUpdate("cb-owner-ok", mcpConfirmationCallbackData(ticket.ticketId, "ok"), 7, 42, cardMessageId ?? 0));
			check(
				"an owner press writes decision.json",
				await waitFor(() => fs.existsSync(decisionFilePath(ticketDir, ticket.ticketId))),
			);
			const decision = JSON.parse(fs.readFileSync(decisionFilePath(ticketDir, ticket.ticketId), "utf8")) as Record<string, unknown>;
			check(
				"the decision carries the ticket, nonce, approve and the owner id",
				decision.ticketId === ticket.ticketId && decision.nonce === ticket.nonce && decision.decision === "approve" && decision.userId === 7,
				decision,
			);
			check(
				"the ticket is marked processed after the press",
				readTicket(ticketDir, ticket.ticketId)?.status === "decided" && readTicket(ticketDir, ticket.ticketId)?.decidedBy === 7,
				readTicket(ticketDir, ticket.ticketId),
			);
			check(
				"the press answers the callback and removes the buttons",
				mcpCalls.some((call) => call.method === "answerCallbackQuery" && call.params.callback_query_id === "cb-owner-ok") &&
					mcpCalls.some(
						(call) =>
							call.method === "editMessageText" &&
							call.params.message_id === cardMessageId &&
							Array.isArray(call.params.reply_markup?.inline_keyboard) &&
							call.params.reply_markup.inline_keyboard.length === 0,
					),
				mcpCalls.filter((call) => call.method === "answerCallbackQuery" || call.method === "editMessageText"),
			);

			// A non-owner in the card chat cannot approve.
			const otherTicket = makeTicket("tgask_bbbbbbbbbbbbbbbb", "confirm-non-owner");
			writeTicket(ticketDir, otherTicket);
			await waitFor(() => cardCall("confirm-non-owner") !== undefined);
			const otherCard = cardCall("confirm-non-owner");
			updates.push(callbackUpdate("cb-stranger", mcpConfirmationCallbackData(otherTicket.ticketId, "ok"), 8, 42, otherCard?.params.message_id ?? 0));
			await new Promise((resolve) => setTimeout(resolve, 300));
			check(
				"a non-owner press writes no decision",
				!fs.existsSync(decisionFilePath(ticketDir, otherTicket.ticketId)) && readTicket(ticketDir, otherTicket.ticketId)?.status === "pending",
				readTicket(ticketDir, otherTicket.ticketId),
			);
			check(
				"the stranger sees a permission answer",
				mcpCalls.some((call) => call.method === "answerCallbackQuery" && call.params.callback_query_id === "cb-stranger" && String(call.params.text).includes("владелец")),
				mcpCalls.filter((call) => call.method === "answerCallbackQuery").map((call) => call.params.text),
			);

			// The owner pressing from a different (not allowed) chat is also rejected.
			const foreignChatTicket = makeTicket("tgask_cccccccccccccccc", "confirm-foreign-chat");
			writeTicket(ticketDir, foreignChatTicket);
			await waitFor(() => cardCall("confirm-foreign-chat") !== undefined);
			const foreignChatCard = cardCall("confirm-foreign-chat");
			updates.push(callbackUpdate("cb-foreign-chat", mcpConfirmationCallbackData(foreignChatTicket.ticketId, "ok"), 7, 43, foreignChatCard?.params.message_id ?? 0));
			await new Promise((resolve) => setTimeout(resolve, 300));
			check(
				"the owner pressing in another chat writes no decision",
				!fs.existsSync(decisionFilePath(ticketDir, foreignChatTicket.ticketId)) && readTicket(ticketDir, foreignChatTicket.ticketId)?.status === "pending",
				readTicket(ticketDir, foreignChatTicket.ticketId),
			);

			// An overdue pending ticket is retired and its card loses the buttons.
			const expiredTicket = {
				...makeTicket("tgask_eeeeeeeeeeeeeeee", "confirm-expired-card"),
				expiresAt: Date.now() - 1,
				cardChatId: 42,
				cardMessageId: 999,
			};
			writeTicket(ticketDir, expiredTicket);
			const expiredRetired = await waitFor(
				() =>
					readTicket(ticketDir, expiredTicket.ticketId)?.status === "expired" &&
					mcpCalls.some(
						(call) =>
							call.method === "editMessageText" &&
							call.params.message_id === expiredTicket.cardMessageId &&
							String(call.params.text).includes("истекло") &&
							Array.isArray(call.params.reply_markup?.inline_keyboard) &&
							call.params.reply_markup.inline_keyboard.length === 0,
					),
			);
			check("an expired card is retired and its buttons are removed", expiredRetired, readTicket(ticketDir, expiredTicket.ticketId));
		} finally {
			await host?.stop().catch(() => undefined);
			host = undefined;
		}

		// With the option absent there is no watcher and therefore no timer/read.
		try {
			mcpCalls.length = 0;
			const disabledConfig = makeConfig(false);
			const disabledDir = resolveTicketDir(disabledConfig.paths.stateDir, "telegram-mcp-tickets");
			const disabled = new TelegramModule(disabledConfig.config.modules.telegram);
			host = new ModuleHost({
				config: disabledConfig,
				log: mcpLog,
				transports: [],
				modules: [disabled],
				ingest: (event) => store.append(event),
				outbox: (limit) => outbox.list(limit),
				history,
				runtimeStatus: () => ({}),
			});
			await host.init();
			check(
				"no confirmation watcher or timer is created when the option is absent",
				(disabled as unknown as { mcpConfirmation?: unknown }).mcpConfirmation === undefined,
			);
			writeTicket(disabledDir, makeTicket("tgask_dddddddddddddddd", "confirm-disabled"));
			await new Promise((resolve) => setTimeout(resolve, 80));
			check(
				"a disabled watcher never reads tickets or sends a card",
				!mcpCalls.some((call) => call.method === "sendMessage" && String(call.params.text).includes("confirm-disabled")),
				mcpCalls.filter((call) => call.method === "sendMessage").map((call) => call.params.text),
			);
		} finally {
			await host?.stop().catch(() => undefined);
			host = undefined;
			globalThis.fetch = realFetch;
			fs.rmSync(mcpRoot, { recursive: true, force: true });
		}
	}
} finally {
	globalThis.fetch = previousFetch;
	fs.rmSync(root, { recursive: true, force: true });
}

process.stdout.write(`\n${failures === 0 ? "all managed-bot tests passed" : `${failures} managed-bot test(s) failed`}\n`);
process.exitCode = failures === 0 ? 0 : 1;
