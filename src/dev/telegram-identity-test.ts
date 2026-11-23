/**
 * Background `getMe` identity retry in the Telegram module (fix b1f1454).
 *
 *   npm run test:telegram-identity
 *
 * A single failed identity handshake used to leave the bot without
 * `botId`/`botUsername` forever, so group mentions and replies-to-us were not
 * recognised. These tests fake the Bot API, inject millisecond retry delays and
 * pin the recovery, the stop() cleanup and the mismatch guard.
 */
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { DEFAULT_CONFIG, loadConfig } from "../config.js";
import { ModuleHost } from "../events/host.js";
import { Logger } from "../log.js";
import { TelegramModule } from "../modules/telegram/module.js";
import { EventStore } from "../store/events.js";
import { HistoryStore } from "../store/history.js";
import { readJsonl } from "../util.js";

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

function jsonResponse(value: unknown, status = 200): Response {
	return new Response(JSON.stringify(value), { status, headers: { "content-type": "application/json" } });
}

/** Long-poll stand-in: stay pending until the module aborts the request. */
function pendingResponse(init?: RequestInit): Promise<Response> {
	return new Promise<Response>((_resolve, reject) => {
		const signal = init?.signal;
		if (!signal) return reject(new Error("getUpdates: missing abort signal"));
		const fail = () => reject(signal.reason instanceof Error ? signal.reason : new Error("getUpdates aborted"));
		if (signal.aborted) return fail();
		signal.addEventListener("abort", fail, { once: true });
	});
}

/** Node-shaped transport error: `fetch` hides the real reason in `cause`. */
function fetchFailure(): Error {
	const cause = Object.assign(new Error("read ECONNRESET"), { code: "ECONNRESET" });
	const error = new Error("fetch failed");
	(error as { cause?: unknown }).cause = cause;
	return error;
}

function telegramTestConfig(root: string) {
	return loadConfig({
		cwd: root,
		overrides: {
			chat: { console: false, http: { enabled: false, host: "127.0.0.1", port: 0, token: "" } },
			modules: {
				telegram: {
					...DEFAULT_CONFIG.modules.telegram,
					enabled: true,
					token: "test-token",
					tokenEnv: "ALIVE_TEST_TELEGRAM_IDENTITY_TOKEN_UNSET",
					apiBase: "https://api.telegram.org",
					allowedChatIds: [],
					allowedUserIds: [],
					pollTimeoutSec: 0,
					historyLimitPerThread: 0,
				},
				grafana: { ...DEFAULT_CONFIG.modules.grafana, enabled: false, host: "127.0.0.1", port: 0, token: "" },
				external: [],
			},
		},
	});
}

function makeHost(root: string, config: ReturnType<typeof telegramTestConfig>, log: Logger, telegram: TelegramModule): ModuleHost {
	const store = EventStore.open(root);
	const history = HistoryStore.open(root);
	return new ModuleHost({
		config,
		log,
		transports: [],
		modules: [telegram],
		ingest: (event) => store.append(event),
		outbox: () => [],
		history,
		runtimeStatus: () => ({}),
	});
}

interface IdentityStatus {
	polling?: boolean;
	identity?: { status?: string; id?: number; username?: string };
	bot?: { id?: number; username?: string };
}

async function waitFor(checkCondition: () => boolean, timeoutMs = 3000): Promise<boolean> {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		if (checkCondition()) return true;
		await new Promise((resolve) => setTimeout(resolve, 10));
	}
	return checkCondition();
}

// ---------------------------------------------------------------------------
section("telegram identity: a failed getMe recovers in the background");
{
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "alive-telegram-identity-recovery-"));
	const logFile = path.join(root, "telegram.jsonl");
	const log = new Logger({ console: false, level: "debug", file: logFile, scope: "telegram-identity-recovery-test" });
	let getMeCalls = 0;
	let getUpdatesCalls = 0;
	const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
		const method = String(input).slice(String(input).lastIndexOf("/") + 1);
		if (method === "getMe") {
			getMeCalls += 1;
			// The first handshake and the first background retry both hit the outage.
			if (getMeCalls <= 2) throw fetchFailure();
			return jsonResponse({ ok: true, result: { id: 999, is_bot: true, first_name: "Alive", username: "alive_bot" } });
		}
		if (method === "getUpdates") {
			getUpdatesCalls += 1;
			if (getUpdatesCalls === 1) return jsonResponse({ ok: true, result: [] });
			return pendingResponse(init);
		}
		return jsonResponse({ ok: true, result: true });
	}) as unknown as typeof fetch;

	const config = telegramTestConfig(root);
	// Real backoff is 2s/5s/15s/60s/5min; the test only needs the sequence.
	const telegram = new TelegramModule(config.config.modules.telegram, { identityRetryDelaysMs: [20, 20, 20] });
	const realFetch = globalThis.fetch;
	globalThis.fetch = fetchImpl;
	let host: ModuleHost | undefined;
	try {
		host = makeHost(root, config, log, telegram);
		await host.init();
		const before = telegram.status() as IdentityStatus;
		check("the failed handshake leaves the identity unknown", before.identity?.status === "unknown", before.identity);

		const recovered = await waitFor(() => (telegram.status() as IdentityStatus).identity?.status === "verified");
		const status = telegram.status() as IdentityStatus;
		check("background retries keep running after repeated failures", getMeCalls >= 3, { getMeCalls });
		check("a successful retry restores botId and botUsername", recovered && status.bot?.id === 999 && status.bot.username === "alive_bot", status.bot);
		check("status reports the recovered identity as verified", status.identity?.status === "verified" && status.identity.id === 999, status.identity);
		check("polling continues while identity is recovered", status.polling === true && getUpdatesCalls >= 1, { polling: status.polling, getUpdatesCalls });

		const logs = readJsonl<{ level?: string; msg?: string; data?: { botId?: number; username?: string } }>(logFile);
		const recoveredLog = logs.find((record) => record.msg === "telegram identity recovered after a failed handshake");
		check("the recovery is logged loudly", recoveredLog?.data?.botId === 999 && recoveredLog?.data?.username === "alive_bot", recoveredLog);
	} finally {
		if (host) await host.stop().catch(() => undefined);
		globalThis.fetch = realFetch;
	}
}

// ---------------------------------------------------------------------------
section("telegram identity: stop() clears the pending retry timer");
{
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "alive-telegram-identity-stop-"));
	const log = new Logger({ console: false, level: "error", scope: "telegram-identity-stop-test" });
	let getMeCalls = 0;
	const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
		const method = String(input).slice(String(input).lastIndexOf("/") + 1);
		if (method === "getMe") {
			getMeCalls += 1;
			throw fetchFailure();
		}
		if (method === "getUpdates") return pendingResponse(init);
		return jsonResponse({ ok: true, result: true });
	}) as unknown as typeof fetch;

	const config = telegramTestConfig(root);
	const telegram = new TelegramModule(config.config.modules.telegram, { identityRetryDelaysMs: [500] });
	const realFetch = globalThis.fetch;
	globalThis.fetch = fetchImpl;
	let host: ModuleHost | undefined;
	try {
		host = makeHost(root, config, log, telegram);
		await host.init();
		check("the first getMe ran before stop", getMeCalls === 1, { getMeCalls });

		const stopping = Date.now();
		await host.stop();
		const stopElapsed = Date.now() - stopping;
		host = undefined;
		const callsAtStop = getMeCalls;
		check("stop() does not wait out the retry backoff", stopElapsed < 500, { stopElapsed });

		// 800 ms is well past the injected 500 ms delay: a leaked timer would fire.
		await new Promise((resolve) => setTimeout(resolve, 800));
		check("no getMe retry runs after stop()", getMeCalls === callsAtStop, { callsAtStop, getMeCalls });
	} finally {
		if (host) await host.stop().catch(() => undefined);
		globalThis.fetch = realFetch;
	}
}

// ---------------------------------------------------------------------------
section("telegram identity: a mismatching retry never overwrites the identity");
{
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "alive-telegram-identity-retry-mismatch-"));
	fs.writeFileSync(path.join(root, "telegram-managed-bot.json"), `${JSON.stringify({ id: 111, username: "stored_agent_bot" })}\n`);
	const logFile = path.join(root, "telegram.jsonl");
	const log = new Logger({ console: false, level: "debug", file: logFile, scope: "telegram-identity-retry-mismatch-test" });
	let getMeCalls = 0;
	const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
		const method = String(input).slice(String(input).lastIndexOf("/") + 1);
		if (method === "getMe") {
			getMeCalls += 1;
			if (getMeCalls === 1) throw fetchFailure();
			// The retry reaches a different bot than the one assigned to this agent.
			return jsonResponse({ ok: true, result: { id: 999, is_bot: true, first_name: "Alive", username: "alive_bot" } });
		}
		if (method === "getUpdates") return pendingResponse(init);
		return jsonResponse({ ok: true, result: true });
	}) as unknown as typeof fetch;

	const config = telegramTestConfig(root);
	const telegram = new TelegramModule(config.config.modules.telegram, { identityRetryDelaysMs: [20, 20, 20] });
	const realFetch = globalThis.fetch;
	globalThis.fetch = fetchImpl;
	let host: ModuleHost | undefined;
	try {
		host = makeHost(root, config, log, telegram);
		await host.init();
		await waitFor(() => getMeCalls >= 2);
		// More than one injected delay: a leaked retry would run in this window.
		await new Promise((resolve) => setTimeout(resolve, 120));
		const status = telegram.status() as IdentityStatus;
		const logs = readJsonl<{ level?: string; msg?: string }>(logFile);
		check("the mismatching retry is attempted once", getMeCalls === 2, { getMeCalls });
		check("the mismatching bot is not stored", status.bot === undefined, status.bot);
		check("the identity stays unknown", status.identity?.status === "unknown", status.identity);
		check(
			"the mismatch stops the identity retries",
			logs.some((record) => record.level === "error" && record.msg === "telegram bot identity mismatch; stopping identity retries"),
			logs.filter((record) => record.level === "error").map((record) => record.msg),
		);
		check(
			"a mismatching retry is never reported as recovered",
			logs.every((record) => record.msg !== "telegram identity recovered after a failed handshake"),
			logs.map((record) => record.msg),
		);
	} finally {
		if (host) await host.stop().catch(() => undefined);
		globalThis.fetch = realFetch;
	}
}

process.stdout.write(`\n${failures === 0 ? "telegram identity tests passed" : `${failures} telegram identity test(s) failed`}\n`);
if (failures > 0) process.exitCode = 1;
