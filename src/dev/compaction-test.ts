/**
 * Focused tests for robust auto-compaction summarization (#167).
 *
 *   npm run test:compaction
 *
 * pi's real `compact()` entry point is used, with a fake provider stream that
 * returns HTML, JSON error bodies, transient failures or a good summary. No
 * network, no real model and no long waits (retry delays are 1 ms).
 */
import type { StreamFn } from "@earendil-works/pi-agent-core";
import {
	createAssistantMessageEventStream,
	type AssistantMessage,
	type AssistantMessageEventStream,
	type Context,
	type Model,
} from "@earendil-works/pi-ai";
import { compact, DEFAULT_COMPACTION_SETTINGS, type AgentSession } from "@earendil-works/pi-coding-agent";
import {
	COMPACTION_EXCERPT_CHARS,
	CompactionFailure,
	classifyCompactionText,
	compactionMonitorFor,
	installCompactionGuard,
	isSummarizationContext,
} from "../runtime/compaction.js";

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

const model = {
	id: "fake-compaction-model",
	name: "Fake compaction model",
	provider: "fake",
	api: "openai-completions",
	contextWindow: 200_000,
	maxTokens: 8_192,
	reasoning: false,
	input: ["text"],
	output: ["text"],
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
} as unknown as Model<any>;

const goodSummary = [
	"## Goal",
	"- Keep the runtime healthy while the provider is flaky.",
	"",
	"## Progress",
	"- Checked the inbox and answered the operator.",
	"- Compaction must preserve the previous context until a valid summary arrives.",
].join("\n");

const htmlBody = "<!DOCTYPE html><html><head><title>502 Bad Gateway</title></head><body><h1>502 Bad Gateway</h1><p>upstream connect error or disconnect/reset before headers</p></body></html>";

function assistant(content: string, stopReason: AssistantMessage["stopReason"] = "stop"): AssistantMessage {
	return {
		role: "assistant",
		content: content ? [{ type: "text", text: content }] : [],
		api: model.api,
		provider: model.provider,
		model: model.id,
		usage: {
			input: 8_000,
			output: 200,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 8_200,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason,
		timestamp: Date.now(),
	};
}

function streamOf(message: AssistantMessage): AssistantMessageEventStream {
	const stream = createAssistantMessageEventStream();
	stream.push({ type: "done", reason: "stop", message });
	return stream;
}

interface Script {
	/** Messages/errors returned in order; the last entry repeats once exhausted. */
	steps: Array<AssistantMessage | Error>;
}

function scriptedStream(script: Script): { fn: StreamFn; calls: () => number } {
	let index = 0;
	const fn: StreamFn = () => {
		const step = script.steps[Math.min(index, script.steps.length - 1)]!;
		index += 1;
		if (step instanceof Error) throw step;
		return streamOf(step);
	};
	return { fn, calls: () => index };
}

function fakeSession(fn: StreamFn): AgentSession {
	return { agent: { streamFunction: fn } } as unknown as AgentSession;
}

const preparation = {
	firstKeptEntryId: "entry-1",
	messagesToSummarize: [
		{ role: "user", content: [{ type: "text", text: "hello" }], timestamp: 1 },
		{ role: "assistant", content: [{ type: "text", text: "hi" }], timestamp: 2 },
	],
	turnPrefixMessages: [],
	isSplitTurn: false,
	tokensBefore: 120_000,
	fileOps: { read: new Set<string>(), written: new Set<string>(), edited: new Set<string>() },
	settings: DEFAULT_COMPACTION_SETTINGS,
} as unknown as Parameters<typeof compact>[0];

function compactWith(session: AgentSession): Promise<Awaited<ReturnType<typeof compact>>> {
	return compact(preparation, model, "test-api-key", undefined, undefined, undefined, undefined, session.agent.streamFunction);
}

const fastRetry = { attempts: 3, baseDelayMs: 1, maxDelayMs: 2, jitter: "none" as const };

// ---------------------------------------------------------------------------
section("classification: HTML, JSON error bodies and empty responses");
{
	check("summarization context is detected by its system prompt", isSummarizationContext({
		systemPrompt: "You are a context summarization assistant. Your task is to read a conversation",
		messages: [],
	} as Context));
	check("normal agent context is not touched", !isSummarizationContext({
		systemPrompt: "You are a long-lived agent.",
		messages: [],
	} as Context));

	const html = classifyCompactionText(htmlBody, 502);
	check("HTML is provider_html", html.reasonClass === "provider_html", html.reasonClass);
	check("HTML from a 5xx proxy is retryable", html.retryable, html.retryable);
	check("the excerpt carries the visible cause", (html.excerpt ?? "").includes("502 Bad Gateway"), html.excerpt);
	check("the excerpt is bounded", (html.excerpt ?? "").length <= COMPACTION_EXCERPT_CHARS, html.excerpt?.length);

	const json = classifyCompactionText('{"error":{"message":"upstream failed","type":"server_error"}}', 200);
	check("a non-summary JSON body is provider_json_invalid", json.reasonClass === "provider_json_invalid", json.reasonClass);

	const empty = classifyCompactionText("   ", 200);
	check("an empty body is provider_error", empty.reasonClass === "provider_error", empty.reasonClass);
	check("an empty body is not retried", !empty.retryable, empty.retryable);

	const permanent = classifyCompactionText(htmlBody, 401);
	check("an HTML page returned with 401 is permanent", permanent.reasonClass === "provider_html" && !permanent.retryable, permanent);

	// pi wraps compaction summaries in <summary>…</summary>; that wrapper is not HTML.
	const wrapped = `<summary>\n${goodSummary}\n</summary>`;
	check("a <summary> wrapper is not misclassified as HTML", classifyCompactionText(wrapped, 200).reasonClass !== "provider_html", classifyCompactionText(wrapped, 200).reasonClass);
	check("<div>502 Bad Gateway</div> is provider_html", classifyCompactionText("<div>502 Bad Gateway</div>", 200).reasonClass === "provider_html");
	check("<p>upstream error</p> is provider_html", classifyCompactionText("<p>upstream error</p>", 200).reasonClass === "provider_html");
}

// ---------------------------------------------------------------------------
section("an HTML error page never becomes the compaction summary");
{
	// The last scripted step repeats, so every bounded attempt sees the same HTML page.
	const provider = scriptedStream({ steps: [assistant(htmlBody)] });
	const session = fakeSession(provider.fn);
	const monitor = installCompactionGuard(session, { retry: fastRetry });

	let result: Awaited<ReturnType<typeof compact>> | undefined;
	let error: unknown;
	try {
		result = await compactWith(session);
	} catch (caught) {
		error = caught;
	}
	check("compact() rejects instead of returning a summary", result === undefined && error instanceof CompactionFailure, error);
	check("the failure class is provider_html", monitor.last()?.reasonClass === "provider_html", monitor.last());
	check(
		"the failed response used all bounded attempts",
		provider.calls() === 3 && monitor.last()?.attempts === 3,
		{ calls: provider.calls(), outcome: monitor.last() },
	);
	check("the monitor keeps the last failure (not a success)", monitor.last()?.ok === false, monitor.last());
	check(
		"the context was never replaced by an empty/garbage checkpoint",
		monitor.record()?.ok === false && monitor.record()?.reasonClass === "provider_html" && monitor.record()?.attempts === 3,
		monitor.record(),
	);
}

// ---------------------------------------------------------------------------
section("a <summary> wrapper around real markdown still compacts");
{
	const provider = scriptedStream({ steps: [assistant(`<summary>\n${goodSummary}\n</summary>`)] });
	const session = fakeSession(provider.fn);
	const monitor = installCompactionGuard(session, { retry: fastRetry });

	const result = await compactWith(session);
	check("the wrapped markdown summary is accepted", result.summary.includes("Keep the runtime healthy"), result.summary.slice(0, 120));
	check("the monitor records success", monitor.last()?.ok === true, monitor.last());
}

// ---------------------------------------------------------------------------
section("the logged excerpt masks secrets");
{
	const provider = scriptedStream({
		steps: [assistant("<!DOCTYPE html><html><body><p>bad token sk-supersecret123456</p></body></html>")],
	});
	const session = fakeSession(provider.fn);
	const monitor = installCompactionGuard(session, {
		retry: { ...fastRetry, attempts: 1 },
		mask: (text) => text.replace(/sk-[A-Za-z0-9]+/g, "<redacted>"),
	});
	try {
		await compactWith(session);
	} catch {
		// expected
	}
	check("the provider secret never reaches the excerpt", !(monitor.last()?.excerpt ?? "").includes("sk-supersecret"), monitor.last()?.excerpt);
	check("the rest of the cause is still visible", (monitor.last()?.excerpt ?? "").includes("bad token"), monitor.last()?.excerpt);
}

// ---------------------------------------------------------------------------
section("a transient failure retries through withRetries and then succeeds");
{
	const provider = scriptedStream({ steps: [assistant(htmlBody), assistant(goodSummary)] });
	const session = fakeSession(provider.fn);
	const monitor = installCompactionGuard(session, { retry: fastRetry, log: { warn: () => undefined } });

	const result = await compactWith(session);
	check("compaction eventually succeeds", result.summary.includes("Keep the runtime healthy"), result.summary.slice(0, 80));
	check("the provider was called twice", provider.calls() === 2, provider.calls());
	check("the successful outcome records both attempts", monitor.last()?.ok === true && monitor.last()?.attempts === 2, monitor.last());

	const timeout = Object.assign(new Error("request timed out"), { code: "ETIMEDOUT" });
	const provider2 = scriptedStream({ steps: [timeout, assistant(goodSummary)] });
	const session2 = fakeSession(provider2.fn);
	installCompactionGuard(session2, { retry: fastRetry });
	const result2 = await compactWith(session2);
	check("a timeout is transient and retried", provider2.calls() === 2 && result2.summary.includes("Keep the runtime healthy"), provider2.calls());
}

// ---------------------------------------------------------------------------
section("a permanent 401 stops at the first attempt");
{
	const provider = scriptedStream({
		steps: [Object.assign(new Error("401 Unauthorized"), { status: 401 })],
	});
	const session = fakeSession(provider.fn);
	const monitor = installCompactionGuard(session, { retry: fastRetry });

	let error: unknown;
	try {
		await compactWith(session);
	} catch (caught) {
		error = caught;
	}
	check("the permanent failure rejects", error instanceof CompactionFailure, error);
	check("the provider is called exactly once", provider.calls() === 1, provider.calls());
	check("the outcome records one attempt", monitor.last()?.attempts === 1, monitor.last());
	check("the outcome is a provider_error", monitor.last()?.reasonClass === "provider_error", monitor.last());
	check("the monitor exposes a next retry time for the next turn", (monitor.last()?.nextAttemptAt ?? 0) > Date.now(), monitor.last());
}

// ---------------------------------------------------------------------------
section("a valid summary still compacts (regression)");
{
	const provider = scriptedStream({ steps: [assistant(goodSummary)] });
	const session = fakeSession(provider.fn);
	const monitor = installCompactionGuard(session, { retry: fastRetry });

	const result = await compactWith(session);
	check("compact() returns the generated summary", result.summary.includes("Compaction must preserve the previous context"), result.summary.slice(0, 120));
	check("the first kept entry is preserved", result.firstKeptEntryId === "entry-1", result.firstKeptEntryId);
	check("tokensBefore is preserved", result.tokensBefore === 120_000, result.tokensBefore);
	check("the monitor records success", monitor.last()?.ok === true, monitor.last());
	check("a successful compaction is not marked failed", !compactionMonitorFor(session)?.record()?.reasonClass);
}

// ---------------------------------------------------------------------------
section("cross-turn backoff: a retry inside the cooldown does not call the provider");
{
	const provider = scriptedStream({ steps: [assistant(htmlBody)] });
	const session = fakeSession(provider.fn);
	const monitor = installCompactionGuard(session, { retry: { ...fastRetry, attempts: 1 } });

	try {
		await compactWith(session);
	} catch {
		// expected
	}
	const callsAfterFailure = provider.calls();
	try {
		await compactWith(session);
	} catch {
		// expected: backoff
	}
	check("the first turn called the provider once", callsAfterFailure === 1, callsAfterFailure);
	check("the next turn is deferred by backoff without a provider call", provider.calls() === callsAfterFailure, provider.calls());
	check("the deferred outcome is marked skipped", monitor.last()?.skipped === true, monitor.last());
	check("the deferred outcome keeps the failure class", monitor.last()?.reasonClass === "provider_html", monitor.last());
}

process.stdout.write(`\n${failures === 0 ? "compaction tests passed" : `${failures} compaction test(s) failed`}\n`);
if (failures > 0) process.exitCode = 1;
