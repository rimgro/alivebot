/**
 * Provider network backoff and poll-outage tests (#282).
 *
 *   npm run test:provider-network
 *
 * Three incidents in one issue:
 *
 * 1. 79 consecutive runs (04:44–07:31Z on 2026-11-26) failed with
 *    `level=error "fetch failed"` and zero turns, each starting almost
 *    immediately: a provider network failure looked like a generic run error,
 *    so nothing backed off. This suite pins the classification, the 30 s → 10 min
 *    network schedule, the reset on a successful run, and the fact that the
 *    pause never stacks with the generic `stopReason: "error"` backoff.
 * 2. The log said nothing useful: the record must carry the cause
 *    (`fetch failed (EAI_AGAIN)`) and the number of attempts, and the loop must
 *    write exactly one line per failure.
 * 3. ~850 short `getUpdates` breaks a day: the poll loop must keep the offset,
 *    lose no incoming update, and not copy a long pause into its own backoff.
 *
 * No network and no real waiting: sleeps are injected, and the Telegram section
 * only stubs `fetch`.
 */
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { DEFAULT_CONFIG, loadConfig } from "../config.js";
import { ModuleHost } from "../events/host.js";
import { Logger } from "../log.js";
import { TelegramModule } from "../modules/telegram/module.js";
import { classifyNetworkError } from "../retry.js";
import {
	PROVIDER_NETWORK_BACKOFF_BASE_MS,
	PROVIDER_NETWORK_BACKOFF_MAX_MS,
	RUN_ERROR_BACKOFF_MAX_MS,
	RunBackoff,
	formatProviderNetworkLogLine,
	providerNetworkBackoffMs,
	providerNetworkErrorText,
	runErrorBackoffMs,
	type RunPauseRecord,
} from "../runtime/provider-network.js";
import { EventStore } from "../store/events.js";
import { HistoryStore } from "../store/history.js";
import type { RunProviderNetworkError } from "../store/runs.js";

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

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

/** `fetch` hides the real reason in `cause`; `undici` adds its own code there. */
function fetchFailure(message: string, code?: string): TypeError {
	const cause = Object.assign(new Error(message), code ? { code } : {});
	return Object.assign(new TypeError("fetch failed"), { cause });
}

function httpError(status: number, message = `HTTP ${status}`): Error {
	return Object.assign(new Error(message), { status });
}

/** A finished run that failed before the model was reached (#282). */
function networkRun(reason = "EAI_AGAIN", attempts = 3): RunPauseRecord & { providerNetwork: RunProviderNetworkError } {
	return {
		stopReason: "error",
		error: `provider network error: fetch failed (${reason})`,
		providerNetwork: { reason, code: reason, attempts },
	};
}

interface LogLine {
	msg: string;
	data?: Record<string, unknown>;
}

function collectingLogger(lines: LogLine[]): { warn(message: string, data?: unknown): void } {
	return {
		warn: (message, data) => {
			lines.push({ msg: message, data: data as Record<string, unknown> | undefined });
		},
	};
}

/** Injected clock: `sleep` never waits, it moves virtual time and records the pause. */
function virtualClock() {
	const sleeps: number[] = [];
	const starts: number[] = [0];
	let now = 0;
	return {
		sleeps,
		starts,
		now: () => now,
		sleep: async (ms: number) => {
			sleeps.push(ms);
			now += ms;
			starts.push(now);
		},
	};
}

const second = 1_000;

// ---------------------------------------------------------------------------
section("classification: transport failures are transient, request errors are not");
{
	const cases: Array<{ name: string; error: unknown; code?: string }> = [
		{ name: "EAI_AGAIN", error: fetchFailure("getaddrinfo EAI_AGAIN api.provider.example", "EAI_AGAIN"), code: "EAI_AGAIN" },
		{ name: "ETIMEDOUT", error: fetchFailure("connect ETIMEDOUT 10.0.0.1:443", "ETIMEDOUT"), code: "ETIMEDOUT" },
		{ name: "ECONNRESET", error: fetchFailure("read ECONNRESET", "ECONNRESET"), code: "ECONNRESET" },
		{
			name: "TLS handshake",
			error: fetchFailure("TLS handshake with api.provider.example failed: tlsv1 alert internal error"),
		},
		{
			// undici's own code is not an `E*` errno; it must still reach the log.
			name: "UND_ERR_CONNECT_TIMEOUT",
			error: fetchFailure("Connect Timeout Error", "UND_ERR_CONNECT_TIMEOUT"),
			code: "UND_ERR_CONNECT_TIMEOUT",
		},
	];
	for (const testCase of cases) {
		const classification = classifyNetworkError(testCase.error);
		check(`${testCase.name} is transient`, classification.transient === true, classification);
		if (testCase.code) check(`${testCase.name} keeps its code as the reason`, classification.reason === testCase.code, classification);
	}
	check(
		"a TLS handshake failure names the handshake, not the bare wrapper",
		classifyNetworkError(fetchFailure("TLS handshake with api.provider.example failed")).reason.startsWith("TLS handshake"),
		classifyNetworkError(fetchFailure("TLS handshake with api.provider.example failed")),
	);

	const permanent: Array<{ name: string; error: unknown }> = [
		{ name: "401", error: httpError(401, "Unauthorized") },
		{ name: "400", error: httpError(400, "Bad Request") },
		{ name: "quota", error: new Error("insufficient_quota: you exceeded your current quota") },
	];
	for (const testCase of permanent) {
		check(`${testCase.name} is not transient`, classifyNetworkError(testCase.error).transient === false, classifyNetworkError(testCase.error));
	}
	check(
		"an aborted stop is never a provider network failure",
		classifyNetworkError(Object.assign(new Error("fetch failed"), { name: "AbortError" })).transient === false,
	);
}

// ---------------------------------------------------------------------------
section("backoff schedule: 30 s doubling, capped at 10 min (not 15)");
{
	check("the network base is 30 s", PROVIDER_NETWORK_BACKOFF_BASE_MS === 30 * second);
	check("the network cap is 10 min", PROVIDER_NETWORK_BACKOFF_MAX_MS === 10 * 60 * second);
	check("the generic error cap stays 15 min", RUN_ERROR_BACKOFF_MAX_MS === 15 * 60 * second);
	check(
		"the first five network pauses are 30s/60s/120s/240s/480s",
		[1, 2, 3, 4, 5].map(providerNetworkBackoffMs).join(",") === [30, 60, 120, 240, 480].map((s) => s * second).join(","),
		[1, 2, 3, 4, 5].map(providerNetworkBackoffMs),
	);
	check("the sixth pause is capped at 10 min", providerNetworkBackoffMs(6) === 10 * 60 * second, providerNetworkBackoffMs(6));
	check("the cap is not the generic 15 min", providerNetworkBackoffMs(99) === 10 * 60 * second, providerNetworkBackoffMs(99));
	check("the generic error schedule keeps its own cap", runErrorBackoffMs(99) === 15 * 60 * second, runErrorBackoffMs(99));
}

// ---------------------------------------------------------------------------
section("five consecutive provider network failures throttle the run starts");
{
	const clock = virtualClock();
	const lines: LogLine[] = [];
	const backoff = new RunBackoff({ log: collectingLogger(lines), sleep: clock.sleep });
	for (let i = 0; i < 6; i += 1) await backoff.waitFor(networkRun());
	const schedule = [30, 60, 120, 240, 480, 600].map((s) => s * second);
	check("one pause per failed run", clock.sleeps.length === 6, clock.sleeps);
	check("the pauses follow the exponential schedule", clock.sleeps.join(",") === schedule.join(","), clock.sleeps);
	check(
		"the run starts are limited by the accumulated pauses",
		clock.starts.join(",") === [0, 30, 90, 210, 450, 930, 1530].map((s) => s * second).join(","),
		clock.starts,
	);
	check("the sixth pause is the 10 min cap, not 16 min", clock.sleeps[5] === 10 * 60 * second, clock.sleeps[5]);
	check("the streak is reported", backoff.providerNetworkStreak === 6, backoff.providerNetworkStreak);
	check("the generic error streak stayed empty", backoff.errorFailureStreak === 0, backoff.errorFailureStreak);

	// A run that is not a network failure clears the network streak.
	const after = await backoff.waitFor({ stopReason: "slept" });
	check("a successful run takes no pause", after === undefined, after);
	check("a successful run resets the network streak", backoff.providerNetworkStreak === 0, backoff.providerNetworkStreak);
	await backoff.waitFor(networkRun());
	check("the first failure after a success waits 30 s again", clock.sleeps[6] === 30 * second, clock.sleeps[6]);

	// Any non-network run resets it, including a plain error.
	await backoff.waitFor({ stopReason: "error", error: "HTTP 500 from the model" });
	await backoff.waitFor(networkRun());
	check("a generic error resets the network streak too", clock.sleeps[8] === 30 * second, clock.sleeps[8]);
}

// ---------------------------------------------------------------------------
section("permanent request errors never enter the network streak");
{
	const clock = virtualClock();
	const lines: LogLine[] = [];
	const backoff = new RunBackoff({ log: collectingLogger(lines), sleep: clock.sleep });
	// A 400 has no `providerNetwork` block: agent.ts only sets it for a transient
	// failure with zero turns and zero tool calls.
	const pause = await backoff.waitFor({ stopReason: "error", error: "provider request failed: HTTP 400 (invalid request)" });
	check("a 400 run still pauses, but as a generic error", pause?.kind === "error", pause);
	check("the first generic error waits 30 s", clock.sleeps[0] === 30 * second, clock.sleeps);
	check("a 400 does not grow the network streak", backoff.providerNetworkStreak === 0, backoff.providerNetworkStreak);
	check("a 400 grows the generic error streak", backoff.errorFailureStreak === 1, backoff.errorFailureStreak);
	check(
		"a 400 writes the generic backoff line, not the network line",
		lines.length === 1 && lines[0]?.msg === "run failed; backing off",
		lines,
	);
	check(
		"no network line is written for a 400",
		!lines.some((line) => line.msg.includes("provider network unavailable")),
		lines.map((line) => line.msg),
	);
}

// ---------------------------------------------------------------------------
section("the network pause never stacks with the stopReason=error backoff");
{
	const clock = virtualClock();
	const backoff = new RunBackoff({ sleep: clock.sleep });
	// A network failure is also `stopReason: "error"`: both counters match, but
	// there must be exactly one pause, the network one.
	const pause = await backoff.waitFor(networkRun());
	check("a network run takes exactly one pause", clock.sleeps.length === 1, clock.sleeps);
	check("that pause is the network 30 s, not 30 s + 30 s", pause?.delayMs === 30 * second && clock.sleeps[0] === 30 * second, clock.sleeps);
	check("the pause is labelled as a network pause", pause?.kind === "provider-network", pause);
	check("the generic streak was cleared by the network failure", backoff.errorFailureStreak === 0, backoff.errorFailureStreak);

	// Several network failures followed by a generic error: the generic streak
	// starts at 1 again instead of inheriting the network streak.
	await backoff.waitFor(networkRun());
	await backoff.waitFor(networkRun());
	const generic = await backoff.waitFor({ stopReason: "error", error: "model error" });
	check("the generic streak does not inherit the network streak", generic?.streak === 1, generic);
	check("the generic pause is 30 s", generic?.delayMs === 30 * second, generic);
	check("both counters are independent", backoff.providerNetworkStreak === 0 && backoff.errorFailureStreak === 1, {
		network: backoff.providerNetworkStreak,
		error: backoff.errorFailureStreak,
	});
}

// ---------------------------------------------------------------------------
section("one log line per failure: streak, classified code, attempts");
{
	const lines: LogLine[] = [];
	const backoff = new RunBackoff({ log: collectingLogger(lines), sleep: virtualClock().sleep });
	await backoff.waitFor(networkRun("EAI_AGAIN", 3));
	await backoff.waitFor(networkRun("ECONNRESET", 1));
	await backoff.waitFor(networkRun("ETIMEDOUT", 3));
	check("exactly one line per failed run", lines.length === 3, lines.map((line) => line.msg));
	check(
		"the line matches the documented shape",
		lines[0]?.msg === "provider network unavailable; next attempt in 30s (streak 1, EAI_AGAIN, attempts: 3)",
		lines[0]?.msg,
	);
	check("the streak grows on every line", lines.map((line) => line.data?.streak).join(",") === "1,2,3", lines.map((line) => line.data));
	check("the classified code is on the line", lines[1]?.msg.includes("ECONNRESET") === true, lines[1]?.msg);
	check(
		"the attempt count distinguishes retried from not retried",
		lines[1]?.msg.endsWith("(streak 2, ECONNRESET, attempts: 1)") === true,
		lines[1]?.msg,
	);
	check("no generic run-failed line is added for a network failure", !lines.some((line) => line.msg === "run failed; backing off"), lines.map((line) => line.msg));
	check(
		"the structured record carries the same numbers",
		lines[2]?.data?.streak === 3 && lines[2]?.data?.attempts === 3 && lines[2]?.data?.code === "ETIMEDOUT",
		lines[2]?.data,
	);

	check(
		"the formatter keeps the cap readable",
		formatProviderNetworkLogLine({ delayMs: 10 * 60 * second, streak: 7, reason: "EAI_AGAIN", code: "EAI_AGAIN", attempts: 3 }) ===
			"provider network unavailable; next attempt in 10m (streak 7, EAI_AGAIN, attempts: 3)",
		formatProviderNetworkLogLine({ delayMs: 10 * 60 * second, streak: 7, reason: "EAI_AGAIN", code: "EAI_AGAIN", attempts: 3 }),
	);
	check(
		"a missing attempt count reads as one attempt",
		formatProviderNetworkLogLine({ delayMs: 30_000, streak: 1, reason: "ETIMEDOUT", attempts: 0 }).includes("attempts: 1"),
	);
	check(
		"no URL, token or body can reach the line",
		!formatProviderNetworkLogLine({
			delayMs: 30_000,
			streak: 1,
			reason: "bot123:SECRET https://api.telegram.org/bot123:SECRET/getUpdates",
			attempts: 2,
		}).includes("SECRET"),
	);
}

// ---------------------------------------------------------------------------
section("the run record text names the cause instead of a bare `fetch failed`");
{
	check(
		"an errno is appended to the message",
		providerNetworkErrorText("fetch failed", { reason: "EAI_AGAIN", code: "EAI_AGAIN" }) ===
			"provider network error: fetch failed (EAI_AGAIN)",
		providerNetworkErrorText("fetch failed", { reason: "EAI_AGAIN", code: "EAI_AGAIN" }),
	);
	check(
		"a TLS cause is appended when there is no errno",
		providerNetworkErrorText("fetch failed", { reason: "TLS handshake with api.provider.example failed" }) ===
			"provider network error: fetch failed (TLS handshake with api.provider.example failed)",
		providerNetworkErrorText("fetch failed", { reason: "TLS handshake with api.provider.example failed" }),
	);
	check(
		"a message that already names the cause is not doubled",
		providerNetworkErrorText("read ECONNRESET", { reason: "ECONNRESET", code: "ECONNRESET" }) ===
			"provider network error: read ECONNRESET",
		providerNetworkErrorText("read ECONNRESET", { reason: "ECONNRESET", code: "ECONNRESET" }),
	);
	check(
		"an empty message still produces a full sentence",
		providerNetworkErrorText(undefined, {}) === "provider network error: provider request failed",
		providerNetworkErrorText(undefined, {}),
	);
}

// ---------------------------------------------------------------------------
section("inbox events survive the pause and the next run handles them");
{
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "alive-provider-network-inbox-"));
	const store = EventStore.open(root);
	const first = store.append({
		kind: "user_message",
		source: "telegram",
		priority: "normal",
		title: "are you there?",
		text: "are you there?",
		thread: "telegram:42",
		expectsReply: true,
	});
	// The run that fails wakes on exactly this event.
	store.beginRun("run_1");
	const claimed = store.claim(10);
	check("the failed run claimed the trigger", claimed.some((event) => event.seq === first.seq), claimed.map((event) => event.seq));
	// A provider network failure did no work, so the runner rolls the claim back
	// instead of acknowledging it (agent.ts `reachedModel === false`).
	store.rollbackClaim();
	const pendingAfterFailure = store.pendingCount();
	check("the trigger is pending again after the network failure", pendingAfterFailure === 1, pendingAfterFailure);

	const clock = virtualClock();
	const backoff = new RunBackoff({ sleep: clock.sleep });
	// Someone writes while the runtime is inside the 30 s pause.
	const duringPause = { event: undefined as ReturnType<typeof store.append> | undefined };
	await backoff.waitFor(networkRun(), undefined);
	check("the failed run paused before the retry", clock.sleeps[0] === 30 * second, clock.sleeps);
	duringPause.event = store.append({
		kind: "user_message",
		source: "telegram",
		priority: "normal",
		title: "hello?",
		text: "hello?",
		thread: "telegram:43",
		expectsReply: true,
	});
	store.beginRun("run_2");
	const next = store.claim(10);
	check("the redelivered trigger is in the next run", next.some((event) => event.seq === first.seq), next.map((event) => event.seq));
	check(
		"the message written during the pause is in the same next run",
		duringPause.event !== undefined && next.some((event) => event.seq === duringPause.event?.seq),
		next.map((event) => event.seq),
	);
	check("both are delivered immediately after the pause", next.length === 2, next.map((event) => event.title));
	store.endRun();
	check("the successful claim acknowledges both", store.pendingCount() === 0, store.pendingCount());
	fs.rmSync(root, { recursive: true, force: true });
}

// ---------------------------------------------------------------------------
// Telegram long polling: a short break keeps the offset, loses nothing and
// retries within the small poll backoff (#282 point 6).
// ---------------------------------------------------------------------------

function jsonResponse(value: unknown): Response {
	return new Response(JSON.stringify(value), { status: 200, headers: { "content-type": "application/json" } });
}

function pendingResponse(init?: RequestInit): Promise<Response> {
	return new Promise<Response>((_resolve, reject) => {
		const signal = init?.signal;
		if (!signal) return reject(new Error("getUpdates: missing abort signal"));
		const fail = () => reject(signal.reason instanceof Error ? signal.reason : new Error("getUpdates aborted"));
		if (signal.aborted) return fail();
		signal.addEventListener("abort", fail, { once: true });
	});
}

async function waitFor(condition: () => boolean, timeoutMs = 8_000): Promise<boolean> {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		if (condition()) return true;
		await new Promise((resolve) => setTimeout(resolve, 20));
	}
	return condition();
}

function updateEnvelope(updateId: number, messageId: number) {
	return jsonResponse({
		ok: true,
		result: [
			{
				update_id: updateId,
				message: {
					message_id: messageId,
					date: 1_700_000_000,
					chat: { id: 42, type: "private", first_name: "Alice", username: "alice" },
					from: { id: 7, is_bot: false, first_name: "Alice", username: "alice" },
					text: `message ${messageId}`,
				},
			},
		],
	});
}

section("telegram getUpdates: a short break keeps the offset and is aggregated");
{
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "alive-provider-network-poll-"));
	const logFile = path.join(dir, "poll.jsonl");
	const log = new Logger({ console: false, level: "error", scope: "provider-network-poll", file: logFile });
	const store = EventStore.open(dir);
	const history = HistoryStore.open(dir);
	const calls: Array<{ call: number; offset: unknown; at: number }> = [];
	let pollCalls = 0;
	/** call 1 → update 100; 2,3 → reset; 4 → update 101; 5,6 → reset; 7 → update 102; then park. */
	const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
		const method = String(input).slice(String(input).lastIndexOf("/") + 1);
		if (method === "getMe") return jsonResponse({ ok: true, result: { id: 1, is_bot: true, first_name: "Alive", username: "alive_bot" } });
		if (method === "deleteWebhook") return jsonResponse({ ok: true, result: true });
		if (method !== "getUpdates") return jsonResponse({ ok: true, result: true });
		pollCalls += 1;
		const params = init?.body ? (JSON.parse(String(init.body)) as { offset?: unknown }) : {};
		calls.push({ call: pollCalls, offset: params.offset, at: Date.now() });
		switch (pollCalls) {
			case 1:
				return updateEnvelope(100, 1);
			case 4:
				return updateEnvelope(101, 2);
			case 7:
				return updateEnvelope(102, 3);
			case 2:
			case 3:
			case 5:
			case 6:
				throw fetchFailure("read ECONNRESET", "ECONNRESET");
			default:
				return pendingResponse(init);
		}
	}) as unknown as typeof fetch;
	const config = loadConfig({
		cwd: dir,
		overrides: {
			chat: { console: false, http: { enabled: false, host: "127.0.0.1", port: 0, token: "" } },
			modules: {
				telegram: {
					...DEFAULT_CONFIG.modules.telegram,
					enabled: true,
					token: "tok",
					tokenEnv: "ALIVE_TEST_TELEGRAM_TOKEN_UNSET",
					allowedUserIds: ["7"],
					pollTimeoutSec: 0,
					typingIndicator: false,
					ackReaction: "",
				},
				grafana: { ...DEFAULT_CONFIG.modules.grafana, enabled: false },
				external: [],
			},
		},
	});
	const telegram = new TelegramModule(config.config.modules.telegram);
	const realFetch = globalThis.fetch;
	globalThis.fetch = fetchImpl;
	let host: ModuleHost | undefined;
	try {
		host = new ModuleHost({
			config,
			log,
			transports: [],
			modules: [telegram],
			ingest: (event) => store.append(event),
			outbox: () => [],
			history,
			runtimeStatus: () => ({}),
		});
		await host.init();
		const delivered = await waitFor(() => store.peekPending(50).filter((event) => event.kind === "user_message").length >= 3);
		const records = fs
			.readFileSync(logFile, "utf8")
			.split("\n")
			.filter((line) => line.trim().length > 0)
			.map((line) => JSON.parse(line) as { level: string; msg: string; data?: Record<string, unknown> });
		const outageLines = records.filter((record) => record.msg.startsWith("telegram getUpdates"));
		const updates = store.peekPending(50).filter((event) => event.kind === "user_message");
		check("all three batches were processed", delivered && updates.length === 3, updates.map((event) => event.text));
		check(
			"the incoming messages were not skipped by the break",
			updates.map((event) => event.text).join(",") === "message 1,message 2,message 3",
			updates.map((event) => event.text),
		);
		// The loop keeps polling; only the first seven calls matter (three broke,
		// four were answered). Call 8 is the parked long poll.
		const offsets = calls.slice(0, 7).map((call) => call.offset ?? "(none)");
		check("the offset is persisted, not reset", offsets.join(",") === "(none),101,101,101,102,102,102", offsets);
		check(
			"the retry of the break and the poll after it reuse the stored offset",
			offsets[1] === 101 && offsets[2] === 101 && offsets[3] === 101,
			offsets,
		);
		check(
			"the poll after the second break resumes from the stored offset",
			offsets[4] === 102 && offsets[5] === 102 && offsets[6] === 102,
			offsets,
		);
		check(
			"the module reports the stored offset",
			(telegram.status() as { offset?: number }).offset === 103,
			(telegram.status() as { offset?: number }).offset,
		);
		// jitter(1s) then jitter(2s) plus one 0.5 s inner retry: small poll backoff,
		// never the runtime's 30 s provider pause.
		const gapAfterFirstBreak = (calls[3]?.at ?? 0) - (calls[2]?.at ?? 0);
		const gapAfterSecondBreak = (calls[6]?.at ?? 0) - (calls[5]?.at ?? 0);
		check("the next poll starts within the small backoff (first break)", gapAfterFirstBreak <= 3_000, gapAfterFirstBreak);
		check("the next poll starts within the small backoff (second break)", gapAfterSecondBreak <= 4_500, gapAfterSecondBreak);
		const warnings = outageLines.filter((record) => record.level === "warn");
		const debug = outageLines.filter((record) => record.level === "debug");
		check("a repeated short break writes one warning, not one per break", warnings.length === 1, outageLines);
		check("the repeats stay in the log at debug", debug.length >= 1, outageLines);
		check(
			"the outage line carries the classified reason",
			warnings[0]?.data?.reason === "ECONNRESET",
			warnings[0]?.data,
		);
		const retryWarnings = records.filter((record) => record.level === "warn" && record.msg.startsWith("retry "));
		const retryDebug = records.filter((record) => record.level === "debug" && record.msg.startsWith("retry "));
		check("the retry line is aggregated too", retryWarnings.length === 1 && retryDebug.length >= 1, {
			warn: retryWarnings.length,
			debug: retryDebug.length,
			lines: records.filter((record) => record.msg.startsWith("retry ")).map((record) => record.msg),
		});
		check(
			"the retry line keeps the classified errno",
			retryWarnings[0]?.msg.endsWith(": ECONNRESET") === true,
			retryWarnings[0]?.msg,
		);
	} finally {
		await host?.stop().catch(() => undefined);
		globalThis.fetch = realFetch;
		fs.rmSync(dir, { recursive: true, force: true });
	}
}

// ---------------------------------------------------------------------------
if (failures > 0) {
	process.stdout.write(`\n${failures} check(s) failed\n`);
	process.exit(1);
}
process.stdout.write("\nall provider-network checks passed\n");
