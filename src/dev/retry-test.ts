/**
 * Tests for the generic network retry helper.
 *
 *   npm run test:retry
 *
 * No network and no real waiting: delays are 0–5 ms unless the test inspects the
 * formatter directly, so the suite pins attempt counts, jitter bounds, the
 * classification of retryable vs permanent failures, abort behaviour and the
 * exact retry log line.
 */
import {
	MAX_RETRY_AFTER_MS,
	RETRY_DEFAULTS,
	classifyNetworkError,
	formatRetryLogLine,
	isRetryableNetworkError,
	retryDelayMs,
	withRetries,
} from "../retry.js";
import { isPermanentProviderError, isTransientProviderError } from "../workers/retry.js";
import { sleep } from "../util.js";

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

/** Node-shaped transport error: `fetch` hides the real reason in `cause`. */
function fetchFailure(code: string): Error {
	const inner = Object.assign(new Error(`read ${code}`), { code });
	return Object.assign(new TypeError("fetch failed"), { cause: inner });
}

function httpError(status: number, message = `HTTP ${status}`, extra: Record<string, unknown> = {}): Error {
	return Object.assign(new Error(message), { status, ...extra });
}

const fast = { baseDelayMs: 1, maxDelayMs: 2, jitter: "none" as const };

// ---------------------------------------------------------------------------
section("retry defaults and formatting");
{
	check("four attempts by default", RETRY_DEFAULTS.attempts === 4, RETRY_DEFAULTS.attempts);
	check("500 ms base delay by default", RETRY_DEFAULTS.baseDelayMs === 500, RETRY_DEFAULTS.baseDelayMs);
	check("15 s delay ceiling by default", RETRY_DEFAULTS.maxDelayMs === 15_000, RETRY_DEFAULTS.maxDelayMs);
	check("full jitter by default", RETRY_DEFAULTS.jitter === "full", RETRY_DEFAULTS.jitter);
	check(
		"the canonical log line matches the README example",
		formatRetryLogLine({ attempt: 2, attempts: 4, delayMs: 1800, reason: "ECONNRESET" }) ===
			"retry 2/4 after 1.8s: ECONNRESET",
		formatRetryLogLine({ attempt: 2, attempts: 4, delayMs: 1800, reason: "ECONNRESET" }),
	);
	check(
		"sub-second delays are logged in milliseconds",
		formatRetryLogLine({ attempt: 3, attempts: 4, delayMs: 500, reason: "HTTP 503" }) ===
			"retry 3/4 after 500ms: HTTP 503",
	);
}

// ---------------------------------------------------------------------------
section("exponential backoff and jitter bounds");
{
	check("first retry waits the base delay", retryDelayMs(1, { baseDelayMs: 500, maxDelayMs: 15_000, jitter: "none" }) === 500);
	check("the delay doubles per attempt", retryDelayMs(3, { baseDelayMs: 500, maxDelayMs: 15_000, jitter: "none" }) === 2000);
	check("the ceiling caps the delay", retryDelayMs(10, { baseDelayMs: 500, maxDelayMs: 15_000, jitter: "none" }) === 15_000);
	check("a huge attempt number never overflows", retryDelayMs(10_000, { baseDelayMs: 500, maxDelayMs: 15_000, jitter: "none" }) === 15_000);
	check("zero base delay stays zero", retryDelayMs(1, { baseDelayMs: 0, maxDelayMs: 15_000, jitter: "none" }) === 0);
	const cap = 8000;
	check("full jitter can return zero", retryDelayMs(4, { baseDelayMs: 500, maxDelayMs: cap }, () => 0) === 0);
	check("full jitter never exceeds the cap", retryDelayMs(4, { baseDelayMs: 500, maxDelayMs: cap }, () => 0.999999) <= cap);
	check(
		"full jitter is uniform in [0, cap]",
		retryDelayMs(1, { baseDelayMs: 1000, maxDelayMs: cap }, () => 0.5) === 500,
		retryDelayMs(1, { baseDelayMs: 1000, maxDelayMs: cap }, () => 0.5),
	);
	check("an out-of-range random value is clamped", retryDelayMs(2, { baseDelayMs: 1000, maxDelayMs: cap }, () => 7) === 2000);
}

// ---------------------------------------------------------------------------
section("network error classification");
{
	const transient: Array<[string, unknown]> = [
		["fetch failed", Object.assign(new TypeError("fetch failed"), {})],
		["ECONNRESET", fetchFailure("ECONNRESET")],
		["ECONNREFUSED", fetchFailure("ECONNREFUSED")],
		["EPIPE", fetchFailure("EPIPE")],
		["ETIMEDOUT", fetchFailure("ETIMEDOUT")],
		["EAI_AGAIN", fetchFailure("EAI_AGAIN")],
		["ENOTFOUND", fetchFailure("ENOTFOUND")],
		["socket hang up", new Error("socket hang up")],
		["request timeout", new Error("Request timed out after 30s")],
		["408", httpError(408, "Request Timeout")],
		["425", httpError(425, "Too Early")],
		["429", httpError(429, "Too Many Requests")],
		["500", new Error("Internal Server Error")],
		["502", httpError(502)],
		["503", httpError(503)],
		["529", httpError(529, "overloaded")],
	];
	for (const [name, error] of transient) {
		const classification = classifyNetworkError(error);
		check(`transient: ${name}`, classification.transient, classification);
	}
	const permanent: Array<[string, unknown]> = [
		["401", httpError(401, "Unauthorized")],
		["403", httpError(403, "Forbidden")],
		["400", httpError(400, "Bad Request")],
		["404", httpError(404, "Not Found")],
		["422", httpError(422, "Unprocessable Entity")],
		["429 + quota", httpError(429, "insufficient_quota: exceeded your current quota")],
		["500 + quota", httpError(500, "billing hard limit reached")],
		["invalid api key", new Error("401 invalid api key")],
		["model not found", new Error("model not found: fake/gone")],
		["invalid request", new Error("400 invalid_request_error: messages is required")],
		["abort", Object.assign(new Error("This operation was aborted"), { name: "AbortError" })],
		["unknown", new Error("something unexpected")],
	];
	for (const [name, error] of permanent) {
		const classification = classifyNetworkError(error);
		check(`not retried: ${name}`, !classification.transient, classification);
	}
	check("an empty error is not retried", !isRetryableNetworkError(undefined));
	check("errno is the log reason", classifyNetworkError(fetchFailure("ECONNRESET")).reason === "ECONNRESET");
	check("status is the log reason without an errno", classifyNetworkError(httpError(503)).reason === "HTTP 503");
	check("classification exposes code and status", (() => {
		const classification = classifyNetworkError(httpError(429, "Too Many Requests", { code: "ECONNRESET" }));
		return classification.code === "ECONNRESET" && classification.status === 429;
	})());
	check("Telegram's errorCode is read as a status", classifyNetworkError(Object.assign(new Error("getUpdates failed (500)"), { errorCode: 500 })).status === 500);
	check("retry_after seconds become milliseconds", classifyNetworkError(Object.assign(new Error("429"), { errorCode: 429, retryAfterSec: 3 })).retryAfterMs === 3000);
	check("retry_after on a plain field is honoured", classifyNetworkError(Object.assign(new Error("429"), { status: 429, retry_after: 2 })).retryAfterMs === 2000);
	check("permanent classification and transient classification stay exclusive", (() => {
		const text = "insufficient_quota";
		return isPermanentProviderError(text) && !isTransientProviderError(text);
	})());
	check(
		"the worker classifier stays consistent with the shared helper",
		isTransientProviderError("socket hang up") && !isTransientProviderError("403 forbidden"),
	);
	check(
		"the log reason never carries a token or URL",
		(() => {
			const reason = classifyNetworkError(new Error("getUpdates failed: https://api.telegram.org/bot123:SECRET-token/getUpdates"));
			return !reason.reason.includes("SECRET") && !reason.reason.includes("http");
		})(),
	);
}

// ---------------------------------------------------------------------------
section("attempt counts");
{
	let calls = 0;
	const attemptsSeen: number[] = [];
	const result = await withRetries(
		async () => {
			calls += 1;
			if (calls < 3) throw fetchFailure("ECONNRESET");
			return "ok";
		},
		{ ...fast, onAttempt: ({ attempt }) => attemptsSeen.push(attempt) },
	);
	check("the operation runs once per attempt", calls === 3, calls);
	check("onAttempt sees every attempt in order", attemptsSeen.join(",") === "1,2,3", attemptsSeen);
	check("the recovered value is returned", result === "ok", result);

	let exhaustedCalls = 0;
	let exhausted: unknown;
	try {
		await withRetries(
			async () => {
				exhaustedCalls += 1;
				throw fetchFailure("ECONNRESET");
			},
			{ ...fast, attempts: 4 },
		);
	} catch (error) {
		exhausted = error;
	}
	check("attempts is the total number of calls", exhaustedCalls === 4, exhaustedCalls);
	check("the last error is rethrown after exhaustion", exhausted instanceof TypeError && exhausted.message === "fetch failed");

	let permanentCalls = 0;
	let permanent: unknown;
	try {
		await withRetries(
			async () => {
				permanentCalls += 1;
				throw httpError(401, "Unauthorized");
			},
			{ ...fast, attempts: 4 },
		);
	} catch (error) {
		permanent = error;
	}
	check("a permanent failure is not retried", permanentCalls === 1, permanentCalls);
	check("the permanent error is rethrown unchanged", permanent instanceof Error && permanent.message === "Unauthorized");

	let customCalls = 0;
	await withRetries(
		async () => {
			customCalls += 1;
			if (customCalls === 1) throw new Error("not a network error");
			return "custom";
		},
		{ ...fast, shouldRetry: () => true },
	);
	check("shouldRetry can widen the policy", customCalls === 2, customCalls);
}

// ---------------------------------------------------------------------------
section("retry logging and retry_after");
{
	const lines: string[] = [];
	const records: unknown[] = [];
	let calls = 0;
	await withRetries(
		async () => {
			calls += 1;
			if (calls < 3) throw fetchFailure("ECONNRESET");
			return "ok";
		},
		{
			...fast,
			attempts: 4,
			label: "test call",
			log: { warn: (message: string, data?: unknown) => { lines.push(message); records.push(data); } },
		},
	);
	check("one log line per retry", lines.length === 2, lines);
	check("the retry line names the upcoming attempt", lines[0]?.startsWith("retry 2/4 after ") === true, lines[0]);
	check("the retry line names the reason", lines[0]?.endsWith(": ECONNRESET") === true, lines[0]);
	check("the log record labels the call site", (records[0] as { label?: string })?.label === "test call");
	check("the log record carries the attempt count", (records[0] as { attempts?: number })?.attempts === 4);

	const retryAfterLines: string[] = [];
	let rateLimited = 0;
	await withRetries(
		async () => {
			rateLimited += 1;
			if (rateLimited === 1) throw Object.assign(new Error("Too Many Requests"), { status: 429, retry_after: 1 });
			return "sent";
		},
		{ baseDelayMs: 1, maxDelayMs: 2, log: { warn: (message: string) => retryAfterLines.push(message) } },
	);
	check("retry_after overrides the computed backoff", retryAfterLines[0]?.includes("after 1.0s") === true, retryAfterLines[0]);
	check("a huge retry_after is capped", (() => {
		const classification = classifyNetworkError(Object.assign(new Error("429"), { status: 429, retry_after: 3600 }));
		return classification.retryAfterMs === 3_600_000 && MAX_RETRY_AFTER_MS === 60_000;
	})());
}

// ---------------------------------------------------------------------------
section("abort never retries");
{
	const controller = new AbortController();
	controller.abort();
	let calls = 0;
	let aborted: unknown;
	try {
		await withRetries(
			async () => {
				calls += 1;
				return "never";
			},
			{ ...fast, signal: controller.signal },
		);
	} catch (error) {
		aborted = error;
	}
	check("a pre-aborted signal runs nothing", calls === 0, calls);
	check("the abort reason is surfaced", (aborted as Error | undefined)?.name === "AbortError", aborted);

	const during = new AbortController();
	let backoffCalls = 0;
	const started = Date.now();
	const pending = withRetries(
		async () => {
			backoffCalls += 1;
			throw fetchFailure("ECONNRESET");
		},
		{ attempts: 4, baseDelayMs: 5_000, maxDelayMs: 5_000, jitter: "none", signal: during.signal },
	);
	await sleep(30);
	during.abort();
	let abortedDuring: unknown;
	try {
		await pending;
	} catch (error) {
		abortedDuring = error;
	}
	const elapsed = Date.now() - started;
	check("abort interrupts the backoff instead of waiting it out", elapsed < 1_000, elapsed);
	check("abort during backoff never retries", backoffCalls === 1, backoffCalls);
	check("abort during backoff surfaces as an abort", (abortedDuring as Error | undefined)?.name === "AbortError", abortedDuring);
}

process.stdout.write(`\n${failures === 0 ? "retry tests passed" : `${failures} retry test(s) failed`}\n`);
if (failures > 0) process.exitCode = 1;
