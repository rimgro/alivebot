/**
 * The minimal MCP JSON-RPC surface the proxy needs (#264, step B).
 *
 * Upstream (`telegram mcp`) speaks newline-delimited JSON on stdio. `parseStdioChunk`
 * is deliberately the only place that knows the framing: when the upstream grows a
 * different frame (Content-Length, SSE, ...), only this function changes.
 */
export type JsonRpcId = string | number | null;

export interface JsonRpcRequest {
	jsonrpc: "2.0";
	id: JsonRpcId;
	method: string;
	params?: unknown;
}

export interface JsonRpcNotification {
	jsonrpc: "2.0";
	method: string;
	params?: unknown;
}

export interface JsonRpcErrorObject {
	code: number;
	message: string;
	data?: unknown;
}

export interface JsonRpcSuccessResponse {
	jsonrpc: "2.0";
	id: JsonRpcId;
	result: unknown;
}

export interface JsonRpcErrorResponse {
	jsonrpc: "2.0";
	id: JsonRpcId;
	error: JsonRpcErrorObject;
}

export type JsonRpcResponse = JsonRpcSuccessResponse | JsonRpcErrorResponse;
export type JsonRpcMessage = JsonRpcRequest | JsonRpcNotification | JsonRpcResponse;

/** Application error codes (JSON-RPC reserves -32000..-32099 for the server). */
export const JSON_RPC_ERROR = {
	parseError: -32700,
	invalidRequest: -32600,
	methodNotFound: -32601,
	internalError: -32603,
	upstreamUnavailable: -32010,
} as const;

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Validate one parsed value as a JSON-RPC 2.0 message. Returns undefined when it is not one. */
export function parseJsonRpcMessage(value: unknown): JsonRpcMessage | undefined {
	if (!isRecord(value) || value.jsonrpc !== "2.0") return undefined;
	const hasId = Object.prototype.hasOwnProperty.call(value, "id");
	const id = value.id;
	if (hasId && typeof id !== "string" && typeof id !== "number" && id !== null) return undefined;
	if (typeof value.method === "string") {
		if (hasId) return value as unknown as JsonRpcRequest;
		return value as unknown as JsonRpcNotification;
	}
	if (!hasId) return undefined;
	if (isRecord(value.error)) {
		if (typeof value.error.code !== "number" || typeof value.error.message !== "string") return undefined;
		return value as unknown as JsonRpcErrorResponse;
	}
	if (Object.prototype.hasOwnProperty.call(value, "result")) return value as unknown as JsonRpcSuccessResponse;
	return undefined;
}

export function isJsonRpcRequest(message: JsonRpcMessage): message is JsonRpcRequest {
	return "method" in message && "id" in message;
}

export function isJsonRpcNotification(message: JsonRpcMessage): message is JsonRpcNotification {
	return "method" in message && !("id" in message);
}

/** Stable map key for an id: `1` and `"1"` are different ids. */
export function jsonRpcIdKey(id: JsonRpcId): string {
	return `${typeof id}:${String(id)}`;
}

export interface ParsedStdioChunk {
	/** Complete messages of all complete lines in this chunk. */
	messages: JsonRpcMessage[];
	/** Trailing bytes after the last newline, kept for the next chunk. */
	rest: string;
	/** Parse/validation failures, one per non-empty bad line. */
	errors: string[];
}

/**
 * Parse the newline-delimited JSON that the upstream writes to stdout.
 *
 * A chunk can end in the middle of a line (and a line can end in CRLF), so the
 * incomplete tail is returned as `rest` and must be prepended to the next chunk.
 */
export function parseStdioChunk(chunk: string): ParsedStdioChunk {
	const messages: JsonRpcMessage[] = [];
	const errors: string[] = [];
	const lines = chunk.split("\n");
	const rest = lines.pop() ?? "";
	for (const rawLine of lines) {
		const line = rawLine.endsWith("\r") ? rawLine.slice(0, -1) : rawLine;
		if (!line.trim()) continue;
		let parsed: unknown;
		try {
			parsed = JSON.parse(line);
		} catch (error) {
			errors.push(`invalid JSON from upstream: ${error instanceof Error ? error.message : String(error)}`);
			continue;
		}
		const message = parseJsonRpcMessage(parsed);
		if (!message) {
			errors.push("upstream line is not a JSON-RPC 2.0 message");
			continue;
		}
		messages.push(message);
	}
	return { messages, rest, errors };
}

/** One JSON-RPC message per line, as the upstream expects on stdin. */
export function formatStdioMessage(message: JsonRpcMessage): string {
	return `${JSON.stringify(message)}\n`;
}
