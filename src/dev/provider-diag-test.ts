/**
 * Provider diagnostics tests (#176).
 *
 *   npx tsx src/dev/provider-diag-test.ts
 *
 * Pure functions plus an in-process fake agent: no model, no network, no pi
 * session. The last section round-trips the additive `providerError` field
 * through `RunLog` and reads a record written before the field existed.
 */
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { Logger } from "../log.js";
import { RunLog, providerRequestSummary, runProviderError, type ProviderRequestSummary, type RunRecord } from "../store/runs.js";
import {
	ATTACHMENT_OMITTED_TEXT,
	IMAGE_OMITTED_TEXT,
	ProviderDiagnostics,
	describeProviderError,
	hasImageAttachments,
	isRequestFormatError,
	providerErrorRecord,
	requestIdFromHeaders,
	summarizePayload,
	type ProviderHookAgent,
} from "../runtime/provider-diag.js";

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

/** A Logger whose `warn` calls are captured instead of written anywhere. */
function captureWarnings(): { logger: Logger; warnings: Array<{ message: string; data?: unknown }> } {
	const warnings: Array<{ message: string; data?: unknown }> = [];
	const logger = new Logger({ console: false, level: "error", scope: "provider-diag-test" });
	(logger as unknown as { warn: (message: string, data?: unknown) => void }).warn = (message, data) => {
		warnings.push({ message, data });
	};
	return { logger, warnings };
}

const log = new Logger({ console: false, level: "error", scope: "provider-diag-test" });
const secrets = { maskEnv: false, extraPatterns: [] as string[] };
const pngBase64 = "iVBORw0KGgoAAAANSUhEUg".repeat(10);

section("summarizePayload: aggregates only, anthropic shape");
{
	const payload = {
		model: "atlas",
		stream: true,
		tools: [{ name: "bash" }, { name: "sleep" }],
		messages: [
			{
				role: "user",
				content: [
					{ type: "text", text: "SECRET MESSAGE TEXT" },
					{ type: "image", source: { type: "base64", media_type: "image/png", data: pngBase64 } },
				],
			},
			{
				role: "assistant",
				content: [
					{ type: "tool_use", id: "t1", name: "bash", input: { command: "SECRET COMMAND" } },
					{ type: "text", text: "done" },
				],
			},
			{ role: "user", content: [{ type: "tool_result", tool_use_id: "t1", content: "ok" }] },
			{ role: "user", content: "plain string content" },
			{ role: "user", content: [{ type: "thinking", thinking: "SECRET THOUGHT" }] },
		],
	};
	const summary = summarizePayload(payload);
	const expectedImageBytes = Math.round((pngBase64.length * 3) / 4);
	check("counts messages", summary.messages === 5, summary.messages);
	check("counts text blocks", summary.blocks.text === 3, summary.blocks);
	check("counts image blocks", summary.blocks.image === 1, summary.blocks);
	check("counts tool_use blocks", summary.blocks.tool_use === 1, summary.blocks);
	check("counts tool_result blocks", summary.blocks.tool_result === 1, summary.blocks);
	check("counts unknown blocks as other", summary.blocks.other === 1, summary.blocks);
	check("estimates image bytes from base64 length", summary.imageBytes === expectedImageBytes, {
		got: summary.imageBytes,
		expected: expectedImageBytes,
	});
	check("reports the payload size", summary.bytes === JSON.stringify(payload).length, summary.bytes);
	check("reports model/stream/tools", summary.model === "atlas" && summary.stream === true && summary.tools === 2, summary);
	const serialized = JSON.stringify(summary);
	check(
		"never leaks text, tool input or base64 into the summary",
		!serialized.includes("SECRET") && !serialized.includes(pngBase64.slice(0, 16)),
		serialized,
	);
	check("hasImageAttachments sees the images", hasImageAttachments(summary));
}

section("summarizePayload: aggregates only, openai shape");
{
	const payload = {
		model: "atlas",
		messages: [
			{
				role: "user",
				content: [
					{ type: "text", text: "look" },
					{ type: "image_url", image_url: { url: `data:image/png;base64,${"B".repeat(800)}` } },
				],
			},
			{ role: "tool", content: "tool output" },
		],
	};
	const summary = summarizePayload(payload);
	check("counts messages", summary.messages === 2, summary.messages);
	check("counts text parts", summary.blocks.text === 2, summary.blocks);
	check("counts image_url parts as images", summary.blocks.image === 1, summary.blocks);
	check("estimates data-uri image bytes", summary.imageBytes === 600, summary.imageBytes);
	check("leaves stream/tools absent when the payload has none", summary.stream === undefined && summary.tools === undefined, summary);
	check("reports the payload size", summary.bytes === JSON.stringify(payload).length, summary.bytes);
	check("tolerates a non-object payload", summarizePayload(undefined).messages === 0);
}

section("requestIdFromHeaders");
{
	check("finds a request id case-insensitively", requestIdFromHeaders({ "X-Request-Id": "req_1" }) === "req_1");
	check("finds request-id", requestIdFromHeaders({ "Request-Id": "req_2" }) === "req_2");
	check("prefers x-request-id over cf-ray", requestIdFromHeaders({ "cf-ray": "ray", "x-request-id": "req_3" }) === "req_3");
	check("falls back to cf-ray", requestIdFromHeaders({ "CF-Ray": "ray_1" }) === "ray_1");
	check("reads Map-like headers", requestIdFromHeaders(new Map([["X-Correlation-Id", "corr_1"]])) === "corr_1");
	check("skips empty values", requestIdFromHeaders({ "x-request-id": "   ", "request-id": "req_4" }) === "req_4");
	check(
		"skips over-long values",
		requestIdFromHeaders({ "x-request-id": "a".repeat(201), "request-id": "req_5" }) === "req_5",
		requestIdFromHeaders({ "x-request-id": "a".repeat(201), "request-id": "req_5" }),
	);
	check("returns undefined when no header matches", requestIdFromHeaders({ "content-type": "application/json" }) === undefined);
	check("returns undefined for a non-object", requestIdFromHeaders(undefined) === undefined);
}

section("describeProviderError: SDK shapes");
{
	const mistral = describeProviderError(
		Object.assign(new Error("400 status code (no body)"), { statusCode: 400, body: "this feature is not yet supported by atlas" }),
	);
	check("statusCode + body (Mistral)", mistral.status === 400 && mistral.body === "this feature is not yet supported by atlas", mistral);

	const openai = describeProviderError({
		status: 400,
		error: { message: "unsupported", code: "unsupported_feature" },
		headers: { "x-request-id": "req_openai" },
	});
	check("status + parsed error object (openai SDK)", openai.status === 400 && openai.code === "unsupported_feature", openai);
	check("body is the serialized error object", openai.body?.includes('"message":"unsupported"') === true, openai.body);
	check("request id from plain-object headers", openai.requestId === "req_openai", openai.requestId);

	const bedrock = describeProviderError({
		$metadata: { httpStatusCode: 422 },
		$response: { statusCode: 422, body: '{"message":"invalid format"}', headers: { "x-amzn-requestid": "req_aws" } },
	});
	check("status from $metadata.httpStatusCode", bedrock.status === 422, bedrock);
	check("body from $response.body", bedrock.body === '{"message":"invalid format"}', bedrock.body);
	check("request id from $response.headers", bedrock.requestId === "req_aws", bedrock.requestId);

	const responseOnly = describeProviderError({ $response: { statusCode: 413, body: "too large" } });
	check("status from $response.statusCode", responseOnly.status === 413 && responseOnly.body === "too large", responseOnly);

	const plain = describeProviderError("provider said no");
	check("a plain string still yields a body", plain.body === "provider said no", plain);

	const longBody = `first line\nsecond line ${"x".repeat(2000)}`;
	const truncated = describeProviderError({ status: 500, body: longBody });
	check("truncates the body to 1000 chars", (truncated.body?.length ?? 0) <= 1000, truncated.body?.length);
	check("squeezes the body to one line", truncated.body?.includes("\n") === false && truncated.body?.includes("first line second line") === true, truncated.body);
	check("marks truncation", truncated.body?.endsWith("…") === true, truncated.body?.slice(-10));
}

section("isRequestFormatError");
{
	check("400 is a format class", isRequestFormatError({ status: 400 }));
	check("422 is a format class", isRequestFormatError({ status: 422 }));
	check("413 is a format class", isRequestFormatError({ status: 413 }));
	check("500 alone is not", !isRequestFormatError({ status: 500 }));
	check("unsupported text is a format class", isRequestFormatError({ status: 500, body: "this feature is not yet supported by atlas" }));
	check("invalid/format text is a format class", isRequestFormatError({ body: "invalid request format" }));
	check("too many text is a format class", isRequestFormatError({ body: "too many images in one request" }));
	check("an unrelated body is not", !isRequestFormatError({ status: 500, body: "internal server error" }));
}

section("ProviderDiagnostics: hooks, summaries, one-shot attachment drop, take");
{
	type FakeAgent = ProviderHookAgent & {
		onPayload: (payload: unknown, model: unknown) => unknown | undefined | Promise<unknown | undefined>;
		onResponse: (response: { status: number; headers: Record<string, string> }, model: unknown) => void | Promise<void>;
	};
	const calls = { payload: 0, response: 0 };
	const agent: FakeAgent = {
		onPayload: () => {
			calls.payload += 1;
			return undefined;
		},
		onResponse: () => {
			calls.response += 1;
		},
	};
	const diag = new ProviderDiagnostics({ log, secrets });
	diag.attach(agent);
	diag.attach(agent);

	const payload = {
		model: "atlas",
		stream: true,
		messages: [
			{
				role: "user",
				content: [
					{ type: "text", text: "describe these" },
					{ type: "image", source: { type: "base64", media_type: "image/png", data: pngBase64 } },
				],
			},
		],
	};
	const before = JSON.stringify(payload);
	const firstResult = await agent.onPayload(payload, { id: "atlas" });
	check("a pre-existing onPayload hook is still called", calls.payload === 1, calls);
	check("attach is idempotent per agent (no double wrap)", calls.payload === 1, calls);
	check("an unchanged payload returns undefined", firstResult === undefined, firstResult);
	check("the request summary is recorded", diag.last()?.request?.messages === 1 && diag.last()?.request?.blocks.image === 1, diag.last());

	await agent.onResponse({ status: 400, headers: { "X-Request-Id": "req_176" } }, { id: "atlas" });
	check("a pre-existing onResponse hook is still called", calls.response === 1, calls);
	check(
		"the response status and request id are recorded",
		diag.last()?.response?.status === 400 && diag.last()?.response?.requestId === "req_176",
		diag.last()?.response,
	);

	diag.dropAttachmentsOnce();
	const retried = await agent.onPayload(payload, { id: "atlas" });
	const retriedText = JSON.stringify(retried);
	check("the retried payload exists", retried !== undefined && typeof retried === "object", retried);
	check("image blocks are replaced with the placeholder", retriedText.includes(ATTACHMENT_OMITTED_TEXT), retriedText);
	check("no image blocks remain in the retried payload", !retriedText.includes('"type":"image"') && !retriedText.includes(pngBase64.slice(0, 16)), retriedText);
	check("the original payload object is not mutated", JSON.stringify(payload) === before);
	check("the snapshot marks the dropped attachments", diag.last()?.attachmentsDropped === true, diag.last());
	check("the recorded retry summary has no images", diag.last()?.request?.blocks.image === 0 && diag.last()?.request?.imageBytes === 0, diag.last()?.request);

	const secondResult = await agent.onPayload(payload, { id: "atlas" });
	check("the drop flag is one-shot", secondResult === undefined, secondResult);
	check("a later request is summarized with its images again", diag.last()?.request?.blocks.image === 1 && diag.last()?.attachmentsDropped !== true, diag.last());

	const snapshot = diag.take();
	check("take returns the accumulated snapshot", snapshot?.request?.messages === 1 && snapshot?.at !== undefined, snapshot);
	check("take clears the accumulated snapshot", diag.last() === undefined);
	check("a second take is empty", diag.take() === undefined);

	const masked = diag.describeError({ status: 400, body: "request rejected, key sk-ant-abcdefghijklmnop" });
	check("describeError masks secrets in the body", masked.body?.includes("sk-ant-") === false && masked.body?.includes("[anthropic#1]") === true, masked.body);
}

section("ProviderDiagnostics: text-only model image placeholders (#202)");
{
	type FakeAgent = ProviderHookAgent & {
		onPayload: (payload: unknown, model: unknown) => unknown | undefined | Promise<unknown | undefined>;
		onResponse: (response: { status: number; headers: Record<string, string> }, model: unknown) => void | Promise<void>;
	};
	const makeAgent = (): FakeAgent => ({ onPayload: () => undefined, onResponse: () => {} });
	const { logger, warnings } = captureWarnings();
	const diag = new ProviderDiagnostics({ log: logger, secrets });
	const agent = makeAgent();
	diag.attach(agent);

	const payload = {
		model: "deepseek-v4.1-flash",
		stream: true,
		messages: [
			{
				role: "user",
				content: [
					{ type: "text", text: "what is on this screenshot" },
					{ type: "image", data: pngBase64, mimeType: "image/png" },
				],
			},
		],
	};
	const before = JSON.stringify(payload);
	const textOnly = { id: "deepseek-v4.1-flash", input: ["text"] };
	const omitted = await agent.onPayload(payload, textOnly);
	const omittedText = JSON.stringify(omitted);
	check("a text-only model gets a payload copy", omitted !== undefined && omitted !== payload, omitted);
	check("the image block becomes the text placeholder", omittedText.includes(IMAGE_OMITTED_TEXT), omittedText);
	check("no base64 reaches the provider copy", !omittedText.includes(pngBase64.slice(0, 16)), omittedText);
	check("the session payload is not mutated", JSON.stringify(payload) === before);
	check("the original still carries the image block", JSON.stringify(payload).includes('"type":"image"'));
	check("the snapshot counts the omitted images", diag.last()?.imagesOmitted === 1, diag.last());
	check(
		"the recorded request has no images left",
		diag.last()?.request?.blocks.image === 0 && diag.last()?.request?.imageBytes === 0,
		diag.last()?.request,
	);
	check("one warning is logged", warnings.length === 1, warnings);
	const warnData = warnings[0]?.data as Record<string, unknown> | undefined;
	check(
		"the warning names the model and the dropped image count, never the image",
		warnData?.model === "deepseek-v4.1-flash" && warnData?.images === 1 && (warnData?.imageBytes as number) > 0,
		warnData,
	);
	check("the warning has no base64", !JSON.stringify(warnings).includes(pngBase64.slice(0, 16)), warnings);

	const second = await agent.onPayload(payload, textOnly);
	check("a second request is still sent with the placeholder", JSON.stringify(second).includes(IMAGE_OMITTED_TEXT));
	check("but the warning is per session, not per request", warnings.length === 1, warnings);

	diag.reset();
	await agent.onPayload(payload, textOnly);
	check("reset() between runs does not re-enable the warning", warnings.length === 1, warnings);

	const openaiPayload = {
		messages: [{ role: "user", content: [{ type: "image_url", image_url: { url: `data:image/png;base64,${pngBase64}` } }] }],
	};
	const openaiBefore = JSON.stringify(openaiPayload);
	const openaiOmitted = JSON.stringify(await agent.onPayload(openaiPayload, textOnly));
	check("image_url blocks are replaced too", openaiOmitted.includes(IMAGE_OMITTED_TEXT) && !openaiOmitted.includes("data:image/png"), openaiOmitted);
	check("the image_url payload is not mutated", JSON.stringify(openaiPayload) === openaiBefore);
	check("a payload without content is left alone", (await agent.onPayload({ model: "deepseek-v4.1-flash" }, textOnly)) === undefined);

	const vision = await agent.onPayload(payload, { id: "vision-model", input: ["text", "image"] });
	check("a vision model gets the payload unchanged", vision === undefined, vision);
	check("a vision model does not log the warning", warnings.length === 1, warnings);
	check("a vision request keeps its images in the snapshot", diag.last()?.request?.blocks.image === 1, diag.last()?.request);
	check("a vision request is not marked as omitted", diag.last()?.imagesOmitted === undefined, diag.last());

	const rebuilt = makeAgent();
	diag.attach(rebuilt);
	await rebuilt.onPayload(payload, textOnly);
	check("a rebuilt session (new agent) warns again", warnings.length === 2, warnings);
	await rebuilt.onPayload(payload, textOnly);
	check("the rebuilt session still warns only once", warnings.length === 2, warnings);

	const noInput = await rebuilt.onPayload(payload, { id: "unknown-capabilities" });
	check("an unknown model capability is left untouched", noInput === undefined, noInput);
}

section("providerErrorRecord: the shape persisted on the run");
{
	const request: ProviderRequestSummary = {
		model: "atlas",
		stream: true,
		messages: 3,
		blocks: { text: 2, image: 18, tool_use: 0, tool_result: 0, other: 0 },
		imageBytes: 1234,
		bytes: 5678,
		tools: 4,
	};
	const description = describeProviderError({
		status: 400,
		body: "this feature is not yet supported by atlas",
		headers: { "x-request-id": "req_roundtrip" },
	});
	const record = providerErrorRecord(Date.UTC(2026, 0, 2, 3, 4, 5), description, {
		at: Date.now(),
		request,
		response: { status: 400, requestId: "req_roundtrip" },
		attachmentsDropped: true,
	});
	check("carries status/requestId/body", record.status === 400 && record.requestId === "req_roundtrip" && record.body !== undefined, record);
	check("carries the ISO timestamp", record.at === "2026-01-02T03:04:05.000Z", record.at);
	check("carries the model and request summary", record.model === "atlas" && record.request?.blocks.image === 18, record);
	check("carries attachmentsDropped", record.attachmentsDropped === true, record);
	const omittedRecord = providerErrorRecord(Date.now(), { body: "rejected" }, {
		at: Date.now(),
		request,
		imagesOmitted: 18,
	});
	check("carries imagesOmitted for a text-only model", omittedRecord.imagesOmitted === 18, omittedRecord);

	const fromSnapshot = providerErrorRecord(Date.now(), { body: "rejected" }, {
		at: Date.now(),
		response: { status: 400, requestId: "req_from_headers" },
	});
	check(
		"falls back to the onResponse snapshot for status and request id",
		fromSnapshot.status === 400 && fromSnapshot.requestId === "req_from_headers",
		fromSnapshot,
	);
}

section("RunLog: providerError round-trip and old records");
{
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "alive-provider-diag-test-"));
	const record = (overrides: Partial<RunRecord>): RunRecord => ({
		id: "run_1",
		index: 1,
		startedAt: 1_000,
		finishedAt: 2_000,
		durationMs: 1_000,
		activeMs: 900,
		idleMs: 100,
		stopReason: "error",
		events: [],
		outbound: [],
		remindersCreated: [],
		notesTouched: [],
		journalEntries: 0,
		idleReturns: 0,
		interruptDeliveries: 0,
		nudges: 0,
		turnCount: 1,
		promptChars: 10,
		usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0, cost: 0 },
		...overrides,
	});

	const stateDir = path.join(root, "state");
	const runs = new RunLog(stateDir);
	const providerError = {
		at: "2026-01-02T03:04:05.000Z",
		status: 400,
		requestId: "req_roundtrip",
		code: "unsupported_feature",
		body: "this feature is not yet supported by atlas",
		model: "atlas",
		request: {
			model: "atlas",
			stream: true,
			messages: 3,
			blocks: { text: 2, image: 18, tool_use: 0, tool_result: 0, other: 0 },
			imageBytes: 1_234,
			bytes: 5_678,
			tools: 4,
		},
		attachmentsDropped: true,
	};
	runs.record(record({ providerError }));
	const stored = runs.last();
	check("providerError survives a RunLog round-trip", JSON.stringify(stored?.providerError) === JSON.stringify(providerError), stored?.providerError);
	check("the sanitizer accepts the stored block", runProviderError(stored ?? {})?.requestId === "req_roundtrip", runProviderError(stored ?? {}));

	const oldStateDir = path.join(root, "old-state");
	const oldRecord = record({ id: "run_old", index: 7, stopReason: "error", error: "old provider failure" });
	fs.mkdirSync(path.join(oldStateDir, "runs"), { recursive: true });
	fs.writeFileSync(path.join(oldStateDir, "runs", "runs.jsonl"), `${JSON.stringify(oldRecord)}\n`, "utf8");
	const oldRuns = new RunLog(oldStateDir);
	const old = oldRuns.last();
	check("an old record without the field still loads", old?.id === "run_old" && old?.error === "old provider failure", old);
	check("the old record has no providerError", old?.providerError === undefined);
	check("the sanitizer returns undefined for an old record", runProviderError(old ?? {}) === undefined);
	check("the sanitizer ignores a malformed block", runProviderError({ providerError: { status: 400 } }) === undefined);
	check("the sanitizer ignores a non-object block", runProviderError({ providerError: "boom" }) === undefined);
	check(
		"the sanitizer keeps imagesOmitted",
		runProviderError({ providerError: { at: "2026-01-02T03:04:05.000Z", imagesOmitted: 18 } })?.imagesOmitted === 18,
		runProviderError({ providerError: { at: "2026-01-02T03:04:05.000Z", imagesOmitted: 18 } }),
	);
	check(
		"the sanitizer drops a non-numeric imagesOmitted",
		runProviderError({ providerError: { at: "2026-01-02T03:04:05.000Z", imagesOmitted: "18" } })?.imagesOmitted === undefined,
	);

	const partial = providerRequestSummary({ messages: "nope", blocks: { image: 2 }, imageBytes: 3, bytes: 4 });
	check(
		"a partial request summary is normalized, not thrown on",
		partial?.messages === 0 && partial?.blocks.image === 2 && partial?.blocks.text === 0,
		partial,
	);
}

if (failures > 0) {
	process.stdout.write(`\n${failures} failure(s)\n`);
	process.exit(1);
}
process.stdout.write("\nall provider-diag tests passed\n");
