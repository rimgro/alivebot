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
import { TelegramApi } from "../modules/telegram/client.js";
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
} finally {
	globalThis.fetch = previousFetch;
	fs.rmSync(root, { recursive: true, force: true });
}

process.stdout.write(`\n${failures === 0 ? "all managed-bot tests passed" : `${failures} managed-bot test(s) failed`}\n`);
process.exitCode = failures === 0 ? 0 : 1;
