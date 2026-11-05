/**
 * Provider request diagnostics (#176).
 *
 * A gateway can answer 400 with nothing but "this feature is not yet supported"
 * in the error message, while the request id that its owner needs to look the
 * rejection up lives in the response headers. This module keeps that evidence:
 *
 * - `summarizePayload` describes the outgoing request body in aggregates only
 *   (message/block counts, estimated image bytes, JSON size) — never the text,
 *   the images or the tool arguments;
 * - `describeProviderError` normalizes the SDK error shapes pi-ai already knows
 *   (`statusCode`, `status`, `$metadata.httpStatusCode`, `$response.statusCode`,
 *   `body`, `error`, `$response.body`) and pulls the request id out of the
 *   response headers;
 * - `ProviderDiagnostics` attaches to the pi agent through its public
 *   `onPayload`/`onResponse` hooks, remembers the last request/response pair,
 *   can strip image blocks from exactly one outgoing payload so a format
 *   rejection can be retried without attachments, and permanently replaces
 *   image blocks with a text note when the model has no image input (#202).
 *
 * Pure functions plus one small stateful helper: no filesystem, no network.
 * The caller (the runtime) masks the response body before logging/persisting it.
 */
import type { Logger } from "../log.js";
import { DEFAULT_SECRETS_CONFIG, maskSecrets, type SecretsConfig } from "../secrets.js";
import type { ProviderRequestSummary, RunProviderError } from "../store/runs.js";
import { oneLine } from "../util.js";

/** How much of a provider error body is kept for the one diagnostic line. */
export const MAX_PROVIDER_ERROR_BODY_CHARS = 1000;
/** Header values longer than this are not request ids. */
export const MAX_REQUEST_ID_CHARS = 200;
/** Text that replaces a dropped image block in the retried payload. */
export const ATTACHMENT_OMITTED_TEXT = "[attachment omitted: provider rejected the request format]";
/**
 * Text that permanently replaces an image block when the model has no image
 * input (#202). Unlike `ATTACHMENT_OMITTED_TEXT`, this is not a retry: the
 * session history keeps its images and every outgoing request gets the copy.
 *
 * pi's image parts are `{ type: "image", data, mimeType }` (or `image_url`
 * with a data URI on the wire) and carry no path, so there is no `path=` here.
 */
export const IMAGE_OMITTED_TEXT = "[image omitted: model has no image input]";

/** Header names probed for a request id, case-insensitively, in this order. */
const REQUEST_ID_HEADERS: readonly string[] = [
	"x-request-id",
	"request-id",
	"x-request-id-alt",
	"x-correlation-id",
	"cf-ray",
	"x-amzn-requestid",
	"openai-request-id",
	"x-goog-request-id",
];

const FORMAT_STATUSES: readonly number[] = [400, 413, 415, 422];
const FORMAT_TEXT_RE = /unsupported|not(?: yet)? supported|invalid|format|too large|too many/i;

type UnknownRecord = Record<string, unknown>;

function asRecord(value: unknown): UnknownRecord | undefined {
	if (typeof value !== "object" || value === null) return undefined;
	return value as UnknownRecord;
}

function isPlainObject(value: unknown): value is UnknownRecord {
	if (typeof value !== "object" || value === null) return false;
	const proto = Object.getPrototypeOf(value);
	return proto === Object.prototype || proto === null;
}

function isPlainNonEmptyObject(value: unknown): value is UnknownRecord {
	return isPlainObject(value) && Object.keys(value).length > 0;
}

function safeJsonStringify(value: unknown): string {
	try {
		const serialized = JSON.stringify(value);
		return serialized === undefined ? String(value) : serialized;
	} catch {
		return String(value);
	}
}

function count(value: unknown): number {
	return typeof value === "number" && Number.isFinite(value) ? Math.max(0, Math.trunc(value)) : 0;
}

/** `len * 3 / 4`, rounded: a base64 payload is four characters per three bytes. */
function base64Bytes(data: string): number {
	const length = data.replace(/\s+/g, "").length;
	return length === 0 ? 0 : Math.round((length * 3) / 4);
}

function dataUriBytes(value: string): number {
	if (!value.startsWith("data:")) return 0;
	const comma = value.indexOf(",");
	return comma === -1 ? 0 : base64Bytes(value.slice(comma + 1));
}

function emptyBlocks(): ProviderRequestSummary["blocks"] {
	return { text: 0, image: 0, tool_use: 0, tool_result: 0, other: 0 };
}

function imageBytesFromBlock(block: UnknownRecord): number {
	// OpenAI chat/images: { type: "image_url", image_url: { url: "data:..." } }.
	const imageUrl = block.image_url;
	if (typeof imageUrl === "string") return dataUriBytes(imageUrl);
	const imageUrlRecord = asRecord(imageUrl);
	if (imageUrlRecord && typeof imageUrlRecord.url === "string") return dataUriBytes(imageUrlRecord.url);
	// Anthropic: { type: "image", source: { type: "base64", data } }.
	const source = asRecord(block.source);
	if (source) {
		if (source.type === "url") return 0;
		if (typeof source.data === "string") return base64Bytes(source.data);
	}
	// Flat variants used by some OpenAI-compatible gateways.
	if (typeof block.data === "string") return base64Bytes(block.data);
	if (typeof block.url === "string") return dataUriBytes(block.url);
	return 0;
}

function countBlock(block: unknown, blocks: ProviderRequestSummary["blocks"]): number {
	const record = asRecord(block);
	if (!record) {
		blocks.other += 1;
		return 0;
	}
	switch (record.type) {
		case "text":
			blocks.text += 1;
			return 0;
		case "image":
		case "image_url":
			blocks.image += 1;
			return imageBytesFromBlock(record);
		case "tool_use":
			blocks.tool_use += 1;
			return 0;
		case "tool_result":
			blocks.tool_result += 1;
			return 0;
		default:
			blocks.other += 1;
			return 0;
	}
}

function collectContent(content: unknown, blocks: ProviderRequestSummary["blocks"]): number {
	if (typeof content === "string") {
		// A plain string is one text part; its text is deliberately not inspected.
		blocks.text += 1;
		return 0;
	}
	if (!Array.isArray(content)) return 0;
	let imageBytes = 0;
	for (const block of content) imageBytes += countBlock(block, blocks);
	return imageBytes;
}

/**
 * Aggregate description of one outgoing provider payload.
 *
 * Counts only: the model name, whether it streams, the number of messages and
 * the block types are safe to log and to keep on a run record. Message text,
 * tool arguments and base64 data never leave the payload.
 */
export function summarizePayload(payload: unknown): ProviderRequestSummary {
	const blocks = emptyBlocks();
	const summary: ProviderRequestSummary = {
		messages: 0,
		blocks,
		imageBytes: 0,
		bytes: safeJsonStringify(payload).length,
	};
	const record = asRecord(payload);
	if (!record) return summary;

	const model = record.model;
	if (typeof model === "string" && model.length > 0) summary.model = model;
	else if (isPlainObject(model) && typeof model.id === "string" && model.id.length > 0) summary.model = model.id;
	if (typeof record.stream === "boolean") summary.stream = record.stream;
	if (Array.isArray(record.tools)) summary.tools = record.tools.length;

	if (Array.isArray(record.messages)) {
		summary.messages = record.messages.length;
		for (const message of record.messages) {
			const messageRecord = asRecord(message);
			if (!messageRecord) {
				blocks.other += 1;
				continue;
			}
			summary.imageBytes += collectContent(messageRecord.content, blocks);
		}
	}
	return summary;
}

function headerText(value: unknown): string | undefined {
	if (typeof value === "string") return value;
	if (typeof value === "number" && Number.isFinite(value)) return String(value);
	if (Array.isArray(value)) {
		const first = value.find((entry) => typeof entry === "string");
		return typeof first === "string" ? first : undefined;
	}
	return undefined;
}

function headerMap(headers: unknown): Map<string, string> {
	const out = new Map<string, string>();
	if (!headers || typeof headers !== "object") return out;
	// `Headers` and `Map` both expose forEach((value, key) => ...).
	const iterable = headers as { forEach?: (callback: (value: unknown, key: unknown) => void) => void; get?: unknown };
	if (typeof iterable.forEach === "function" && typeof iterable.get === "function") {
		iterable.forEach((value, key) => {
			const text = headerText(value);
			if (text === undefined) return;
			out.set(String(key).toLowerCase(), text);
		});
		return out;
	}
	for (const [key, value] of Object.entries(headers as UnknownRecord)) {
		const text = headerText(value);
		if (text !== undefined) out.set(key.toLowerCase(), text);
	}
	return out;
}

/** First non-empty request id header, case-insensitively, bounded in length. */
export function requestIdFromHeaders(headers: unknown): string | undefined {
	const found = headerMap(headers);
	for (const name of REQUEST_ID_HEADERS) {
		const value = found.get(name);
		if (value === undefined) continue;
		const trimmed = value.trim();
		if (trimmed.length === 0 || trimmed.length > MAX_REQUEST_ID_CHARS) continue;
		return trimmed;
	}
	return undefined;
}

export interface ProviderErrorDescription {
	status?: number;
	code?: string;
	body?: string;
	requestId?: string;
}

function firstStatus(record: UnknownRecord): number | undefined {
	const candidates = [
		record.statusCode,
		record.status,
		asRecord(record.$metadata)?.httpStatusCode,
		asRecord(record.$response)?.statusCode,
	];
	for (const candidate of candidates) {
		if (typeof candidate === "number" && Number.isFinite(candidate)) return candidate;
	}
	return undefined;
}

function firstCode(record: UnknownRecord): string | undefined {
	const candidates = [record.code, asRecord(record.error)?.code, record.type];
	for (const candidate of candidates) {
		if (typeof candidate === "string" && candidate.trim().length > 0) {
			return oneLine(candidate, 100);
		}
	}
	return undefined;
}

function pickBodyText(record: UnknownRecord): string | undefined {
	// Mistral SDK puts the raw body on `body`.
	if (typeof record.body === "string") return record.body;
	// The `openai` SDK parses the JSON body into `error`; a class instance is not a body.
	if (isPlainNonEmptyObject(record.error)) return safeJsonStringify(record.error);
	// AWS Bedrock keeps the raw body on `$response.body` (string or parsed object).
	const responseBody = asRecord(record.$response)?.body;
	if (typeof responseBody === "string") return responseBody;
	if (typeof responseBody === "object" && responseBody !== null && "pipe" in responseBody) {
		if (typeof (responseBody as { pipe?: unknown }).pipe === "function") return undefined;
	}
	if (isPlainNonEmptyObject(responseBody)) return safeJsonStringify(responseBody);
	return undefined;
}

/**
 * Normalize a thrown provider error into status/code/body/request id.
 *
 * Field probing mirrors pi-ai's own error normalization but is repeated here so
 * this module never imports a pi-ai internal. The body is squeezed to one line
 * and capped at `MAX_PROVIDER_ERROR_BODY_CHARS`; it is NOT masked here — the
 * caller has the secrets config (`ProviderDiagnostics.describeError` does both).
 */
export function describeProviderError(error: unknown): ProviderErrorDescription {
	if (error === null || error === undefined) return {};
	if (typeof error !== "object") {
		const body = oneLine(String(error), MAX_PROVIDER_ERROR_BODY_CHARS);
		return body.length > 0 ? { body } : {};
	}
	const record = error as UnknownRecord;
	const description: ProviderErrorDescription = {};
	const status = firstStatus(record);
	if (status !== undefined) description.status = status;
	const code = firstCode(record);
	if (code !== undefined) description.code = code;

	const bodyText = pickBodyText(record);
	if (bodyText !== undefined) {
		const trimmed = bodyText.trim();
		if (trimmed.length > 0) description.body = oneLine(trimmed, MAX_PROVIDER_ERROR_BODY_CHARS);
	}

	const requestId =
		requestIdFromHeaders(record.headers) ??
		requestIdFromHeaders(asRecord(record.$response)?.headers) ??
		requestIdFromHeaders(asRecord(record.response)?.headers);
	if (requestId !== undefined) description.requestId = requestId;
	return description;
}

/** True for HTTP/format rejections that a retry without attachments can help. */
export function isRequestFormatError(input: { status?: number; body?: string }): boolean {
	if (typeof input.status === "number" && FORMAT_STATUSES.includes(input.status)) return true;
	if (typeof input.body === "string" && FORMAT_TEXT_RE.test(input.body)) return true;
	return false;
}

/** True when a request summary shows at least one image part was sent. */
export function hasImageAttachments(summary: ProviderRequestSummary | undefined): boolean {
	if (!summary) return false;
	return summary.imageBytes > 0 || summary.blocks.image > 0;
}

/** Build the durable provider-error block of a run record (additive field). */
export function providerErrorRecord(
	at: number,
	description: ProviderErrorDescription,
	snapshot: ProviderDiagnosticsSnapshot | undefined,
): RunProviderError {
	const record: RunProviderError = { at: new Date(at).toISOString() };
	// The thrown error often carries only the message; `onResponse` still saw the
	// status and headers of the rejected request, so fall back to that snapshot.
	const status = description.status ?? snapshot?.response?.status;
	if (status !== undefined) record.status = status;
	const requestId = description.requestId ?? snapshot?.response?.requestId;
	if (requestId !== undefined) record.requestId = requestId;
	if (description.code !== undefined) record.code = description.code;
	if (description.body !== undefined) record.body = description.body;
	if (snapshot?.request?.model !== undefined) record.model = snapshot.request.model;
	if (snapshot?.request !== undefined) record.request = snapshot.request;
	if (snapshot?.attachmentsDropped === true) record.attachmentsDropped = true;
	if (snapshot?.imagesOmitted !== undefined && snapshot.imagesOmitted > 0) record.imagesOmitted = snapshot.imagesOmitted;
	return record;
}

/** What an `onPayload`/`onResponse` hook pair saw, aggregated. */
export interface ProviderDiagnosticsSnapshot {
	request?: ProviderRequestSummary;
	response?: { status?: number; requestId?: string };
	/** True when this request was sent without the image blocks. */
	attachmentsDropped?: boolean;
	/** How many image blocks this request replaced because the model cannot see images (#202). */
	imagesOmitted?: number;
	at: number;
}

/** The subset of the pi `Agent` this module touches. */
export interface ProviderHookAgent<TModel = unknown> {
	onPayload?: (payload: unknown, model: TModel) => unknown | undefined | Promise<unknown | undefined>;
	onResponse?: (response: { status: number; headers: Record<string, string> }, model: TModel) => void | Promise<void>;
}

export interface ProviderDiagnosticsOptions {
	log: Logger;
	secrets?: SecretsConfig;
}

/**
 * Remembers the last provider request/response and can strip attachments once.
 *
 * The hooks are installed on the pi agent's public fields, so every provider
 * request the session makes is covered — including the main agent loop — without
 * touching pi internals or the session history. Existing hooks are preserved and
 * still called.
 */
export class ProviderDiagnostics {
	private readonly log: Logger;
	private readonly secrets: SecretsConfig;
	private state: ProviderDiagnosticsSnapshot | undefined;
	private dropNextPayload = false;
	/** One warning per session, not per request: a run's `reset()` must not clear it. */
	private imagesOmittedWarned = false;
	private readonly attachedAgents = new WeakSet<object>();

	constructor(options: ProviderDiagnosticsOptions) {
		this.log = options.log;
		this.secrets = options.secrets ?? DEFAULT_SECRETS_CONFIG;
	}

	/**
	 * Install the hooks on an agent. Idempotent per agent object: rebuilding a
	 * session creates a new agent, which gets its own pair.
	 */
	attach<TModel>(agent: ProviderHookAgent<TModel>): void {
		if (!agent || typeof agent !== "object") return;
		if (this.attachedAgents.has(agent)) return;
		this.attachedAgents.add(agent);
		// A new agent object means a rebuilt session, even though `reset()` runs on
		// every run of the same session: the one-warning budget starts over here.
		this.imagesOmittedWarned = false;
		const previousPayload = agent.onPayload;
		const previousResponse = agent.onResponse;

		agent.onPayload = async (payload, model) => {
			const ours = this.recordPayload(payload, model);
			let next = ours;
			if (previousPayload) {
				const theirs = await previousPayload(next ?? payload, model);
				if (theirs !== undefined) next = theirs;
			}
			return next;
		};
		agent.onResponse = async (response, model) => {
			this.recordResponse(response);
			if (previousResponse) await previousResponse(response, model);
		};
	}

	/** Last observed request/response pair, copied so callers cannot mutate it. */
	last(): ProviderDiagnosticsSnapshot | undefined {
		if (!this.state) return undefined;
		return {
			...this.state,
			...(this.state.request ? { request: { ...this.state.request, blocks: { ...this.state.request.blocks } } } : {}),
			...(this.state.response ? { response: { ...this.state.response } } : {}),
		};
	}

	/** Return and clear the accumulated snapshot. */
	take(): ProviderDiagnosticsSnapshot | undefined {
		const snapshot = this.last();
		this.state = undefined;
		return snapshot;
	}

	/**
	 * Clear the per-run state, including a pending attachment drop.
	 *
	 * `imagesOmittedWarned` deliberately survives: `reset()` runs at the start
	 * and the end of every run of the SAME session, while #202 wants one warning
	 * per session. Attaching a new agent (a rebuilt session) clears it.
	 */
	reset(): void {
		this.state = undefined;
		this.dropNextPayload = false;
	}

	/**
	 * Strip `image`/`image_url` blocks from the next outgoing payload only.
	 *
	 * The session history is untouched: the next `onPayload` returns a modified
	 * copy, pi sends that copy, and the transcript keeps its attachments.
	 */
	dropAttachmentsOnce(): void {
		this.dropNextPayload = true;
	}

	/** `describeProviderError` plus secret masking of the body. */
	describeError(error: unknown): ProviderErrorDescription {
		const description = describeProviderError(error);
		if (description.body !== undefined) description.body = maskSecrets(description.body, this.secrets);
		return description;
	}

	private recordPayload(payload: unknown, model?: unknown): unknown | undefined {
		const summary = summarizePayload(payload);
		this.state = { at: Date.now(), request: summary };
		if (this.dropNextPayload) {
			this.dropNextPayload = false;
			const stripped = stripImageBlocks(payload);
			if (stripped.changed) {
				this.state.attachmentsDropped = true;
				this.state.request = summarizePayload(stripped.value);
				this.log.debug("provider payload sent without attachments", { request: this.state.request });
				return stripped.value;
			}
		}
		// #202: a text-only model rejects a request that carries images. Replace
		// them in the outgoing copy; the session history is never mutated. The warn
		// is per session because every request of a text-only session gets here.
		if (summary.blocks.image > 0 && modelHasNoImageInput(model)) {
			const omitted = stripImageBlocks(payload, IMAGE_OMITTED_TEXT);
			if (omitted.changed) {
				this.state.imagesOmitted = summary.blocks.image;
				this.state.request = summarizePayload(omitted.value);
				if (!this.imagesOmittedWarned) {
					this.imagesOmittedWarned = true;
					this.log.warn("provider payload images omitted: model has no image input", {
						model: modelId(model) ?? summary.model,
						images: summary.blocks.image,
						imageBytes: summary.imageBytes,
					});
				}
				return omitted.value;
			}
		}
		return undefined;
	}

	private recordResponse(response: { status?: number; headers?: unknown }): void {
		const previous = this.state ?? { at: Date.now() };
		const requestId = requestIdFromHeaders(response?.headers);
		this.state = {
			...previous,
			at: Date.now(),
			response: {
				...(typeof response?.status === "number" ? { status: response.status } : {}),
				...(requestId !== undefined ? { requestId } : {}),
			},
		};
	}
}

function isImageBlock(record: UnknownRecord): boolean {
	return record.type === "image" || record.type === "image_url";
}

/** True only when the model advertises its inputs and none of them is `image`. */
function modelHasNoImageInput(model: unknown): boolean {
	const input = asRecord(model)?.input;
	return Array.isArray(input) && !input.includes("image");
}

function modelId(model: unknown): string | undefined {
	const id = asRecord(model)?.id;
	return typeof id === "string" && id.length > 0 ? id : undefined;
}

/**
 * Copy `value`, replacing every image block with a text placeholder.
 *
 * Returns the original reference when nothing changed, so callers can tell a
 * no-op from a real rewrite (and the history object is never mutated).
 */
function stripImageBlocks(value: unknown, placeholder = ATTACHMENT_OMITTED_TEXT): { value: unknown; changed: boolean } {
	if (Array.isArray(value)) {
		let changed = false;
		const out = value.map((entry) => {
			const stripped = stripImageBlocks(entry, placeholder);
			if (stripped.changed) changed = true;
			return stripped.value;
		});
		return changed ? { value: out, changed: true } : { value, changed: false };
	}
	if (!isPlainObject(value)) return { value, changed: false };
	if (isImageBlock(value)) {
		return { value: { type: "text", text: placeholder }, changed: true };
	}
	let changed = false;
	const out: UnknownRecord = {};
	for (const [key, entry] of Object.entries(value)) {
		const stripped = stripImageBlocks(entry, placeholder);
		if (stripped.changed) changed = true;
		out[key] = stripped.value;
	}
	return changed ? { value: out, changed: true } : { value, changed: false };
}
