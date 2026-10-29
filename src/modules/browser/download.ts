/** Downloads stay in the workspace, bounded and named by response metadata.
 *
 * The browser's own `APIRequestContext` performs the request, so the active
 * context's cookies apply. A download is never written in place: it is capped,
 * written to a temporary sibling, and renamed only after the whole body has
 * been accepted. An existing file is never overwritten.
 */

import { randomBytes } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import { pageTextStamp } from "./page-file.js";

/** Workspace-relative directory holding downloaded files. */
export const DOWNLOAD_DIR = "browser-downloads";
export const MAX_DOWNLOAD_NAME_CHARS = 120;
const MAX_REDIRECTS = 10;

/** The response exceeded the configured byte budget; nothing was written. */
export class DownloadTooLargeError extends Error {
	readonly limitBytes: number;

	constructor(limitBytes: number) {
		super(`Download exceeds the ${limitBytes} byte limit (browser.maxDownloadBytes); no file was written`);
		this.name = "DownloadTooLargeError";
		this.limitBytes = limitBytes;
	}
}

export interface DownloadStore {
	/** Resolve whether a workspace-relative file already exists. */
	exists(relativePath: string): Promise<boolean>;
	/** Write a complete, already-capped body. */
	write(relativePath: string, data: Buffer): Promise<void>;
	/** Optional streaming sink: cap, write a temp file and rename only on success. */
	writeStream?(relativePath: string, source: AsyncIterable<Uint8Array>, maxBytes: number, signal?: AbortSignal): Promise<number>;
}

export interface BrowserDownload {
	status: number;
	headers: Record<string, string>;
	body: Buffer;
	/** Last URL in the redirect chain, used for name fallback. */
	finalUrl: string;
}

/** Minimal shape shared by Playwright and Patchright APIRequestContext. */
export interface BrowserRequestContext {
	get(url: string, options: { headers?: Record<string, string>; maxRedirects?: number; timeout?: number; signal?: AbortSignal; failOnStatusCode?: boolean }): Promise<{
		status(): number;
		headers(): Record<string, string>;
		body(): Promise<Buffer>;
		dispose(): Promise<void>;
	}>;
}

export interface BrowserDownloadOptions {
	headers?: Record<string, string>;
	maxBytes: number;
	timeoutMs: number;
	signal?: AbortSignal;
	/** Add per-hop headers (for example a Web Bot Auth signature) only to authorized origins. */
	sign?: (url: string) => Record<string, string>;
}

/** Perform a bounded GET with the browser request API and follow redirects manually.
 *
 * Manual redirects keep signed headers off unrelated origins. The request
 * context retains its cookie jar across hops, like a browser navigation.
 */
export async function fetchWithBrowserRequest(request: BrowserRequestContext, value: string, options: BrowserDownloadOptions): Promise<BrowserDownload> {
	let current = new URL(value);
	for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
		options.signal?.throwIfAborted();
		const headers = { ...(options.headers ?? {}), ...(options.sign?.(current.href) ?? {}) };
		const response = await request.get(current.href, {
			headers, maxRedirects: 0, timeout: options.timeoutMs, signal: options.signal, failOnStatusCode: false,
		});
		try {
			const status = response.status(), responseHeaders = response.headers();
			const location = responseHeaders.location;
			if (status >= 300 && status < 400 && location) {
				const next = new URL(location, current);
				if (!["http:", "https:"].includes(next.protocol) || next.username || next.password) throw new Error("Download redirect must stay on an HTTP(S) URL without embedded credentials");
				current = next;
				continue;
			}
			if (status < 200 || status >= 300) throw new Error(`Download failed with HTTP ${status}`);
			const declared = parseContentLength(responseHeaders["content-length"]);
			if (declared !== undefined && declared > options.maxBytes) throw new DownloadTooLargeError(options.maxBytes);
			const body = await response.body();
			if (body.length > options.maxBytes) throw new DownloadTooLargeError(options.maxBytes);
			return { status, headers: responseHeaders, body, finalUrl: current.href };
		} finally { await response.dispose().catch(() => {}); }
	}
	throw new Error(`Download exceeded ${MAX_REDIRECTS} redirects`);
}

/** `Content-Length` is advisory; invalid values are ignored. */
export function parseContentLength(value: string | undefined): number | undefined {
	if (value === undefined) return undefined;
	const trimmed = value.trim();
	if (!/^\d+$/.test(trimmed)) return undefined;
	const parsed = Number(trimmed);
	return Number.isSafeInteger(parsed) ? parsed : undefined;
}

/** MIME type from the response headers, without parameters. */
export function downloadMime(headers: Record<string, string>): string {
	const value = headers["content-type"]?.split(";")[0]?.trim().toLowerCase();
	return value || "application/octet-stream";
}

/** RFC 5987/6266 `filename*` first, then the plain `filename` parameter. */
export function contentDispositionFilename(value: string | undefined): string | undefined {
	if (!value) return undefined;
	const params = parseParameters(value);
	const extended = params.get("filename*");
	if (extended) {
		const match = /^([^']*)'([^']*)'(.*)$/.exec(extended);
		if (match) {
			const charset = match[1]!.toLowerCase();
			const encoded = match[3]!;
			try {
				if (!charset || charset === "utf-8") return decodeURIComponent(encoded);
				if (charset === "iso-8859-1" || charset === "latin1") return decodeLatin1(encoded);
			} catch { /* fall through to filename */ }
		}
	}
	return params.get("filename");
}

function parseParameters(value: string): Map<string, string> {
	const params = new Map<string, string>();
	let index = 0;
	// Skip the disposition token, e.g. "attachment".
	while (index < value.length && value[index] !== ";") index++;
	while (index < value.length) {
		index++;
		while (index < value.length && /[ \t]/.test(value[index]!)) index++;
		if (index >= value.length) break;
		let key = "";
		while (index < value.length && value[index] !== "=" && value[index] !== ";") key += value[index++]!;
		key = key.trim().toLowerCase();
		let raw = "";
		if (value[index] === "=") {
			index++;
			while (index < value.length && /[ \t]/.test(value[index]!)) index++;
			if (value[index] === "\"") {
				index++;
				while (index < value.length) {
					const char = value[index++]!;
					if (char === "\\" && index < value.length) { raw += value[index++]!; continue; }
					if (char === "\"") break;
					raw += char;
				}
			} else {
				while (index < value.length && value[index] !== ";") raw += value[index++]!;
			}
		}
		if (key && !params.has(key)) params.set(key, raw.trim());
	}
	return params;
}

function decodeLatin1(value: string): string {
	return Buffer.from(value.replace(/%([0-9a-f]{2})/gi, (_, hex: string) => String.fromCharCode(Number.parseInt(hex, 16))), "latin1").toString("latin1");
}

/** A portable single path segment: no separators, no `..`, bounded length. */
export function sanitizeDownloadName(value: string | undefined): string | undefined {
	if (!value) return undefined;
	let name = value.normalize("NFC").replace(/[\\/]+/g, "/");
	name = name.slice(name.lastIndexOf("/") + 1);
	name = name.replace(/[\u0000-\u001f\u007f-\u009f\u200e\u200f\u202a-\u202e\u2066-\u2069]/g, "");
	name = name.replace(/[<>:"|?*]/g, "_");
	name = name.replace(/\s+/g, " ").trim();
	name = name.replace(/^\.+/, "").replace(/\.+$/, "");
	if (!name || name === "." || name === "..") return undefined;
	if (/^(con|prn|aux|nul|com[1-9]|lpt[1-9])(\..*)?$/i.test(name)) name = `_${name}`;
	if (name.length > MAX_DOWNLOAD_NAME_CHARS) {
		const dot = name.lastIndexOf(".");
		const extension = dot > 0 && name.length - dot <= 16 ? name.slice(dot) : "";
		const stem = extension ? name.slice(0, dot) : name;
		name = `${stem.slice(0, Math.max(1, MAX_DOWNLOAD_NAME_CHARS - extension.length)).trimEnd()}${extension}`;
	}
	return name || undefined;
}

/** Content-Disposition, then the requested `name`, then the URL basename, then a timestamp. */
export function downloadName(options: { contentDisposition?: string; name?: string; url?: string; now?: number }): string {
	const candidates = [contentDispositionFilename(options.contentDisposition), options.name, urlBasename(options.url)];
	for (const candidate of candidates) {
		const safe = sanitizeDownloadName(candidate);
		if (safe) return safe;
	}
	return `download-${pageTextStamp(options.now)}`;
}

function urlBasename(value: string | undefined): string | undefined {
	if (!value) return undefined;
	try {
		const segment = new URL(value).pathname.split("/").filter(Boolean).pop();
		if (!segment) return undefined;
		try { return decodeURIComponent(segment); } catch { return segment; }
	} catch { return undefined; }
}

/** Add `-1`, `-2`, ... before the extension instead of overwriting a file. */
export async function uniqueDownloadName(store: Pick<DownloadStore, "exists">, name: string): Promise<string> {
	if (!await store.exists(`${DOWNLOAD_DIR}/${name}`)) return name;
	const dot = name.lastIndexOf(".");
	const extension = dot > 0 ? name.slice(dot) : "";
	const stem = dot > 0 ? name.slice(0, dot) : name;
	for (let suffix = 1; suffix <= 999; suffix++) {
		const candidate = `${stem}-${suffix}${extension}`;
		if (!await store.exists(`${DOWNLOAD_DIR}/${candidate}`)) return candidate;
	}
	return `${stem}-${pageTextStamp()}${extension}`;
}

/** Stream or buffer a capped body into the workspace; failures leave no file. */
export async function saveDownload(store: DownloadStore, relativePath: string, source: AsyncIterable<Uint8Array> | Iterable<Uint8Array>, maxBytes: number, signal?: AbortSignal): Promise<number> {
	signal?.throwIfAborted();
	if (store.writeStream) return store.writeStream(relativePath, asAsync(source), maxBytes, signal);
	const chunks: Buffer[] = [];
	let total = 0;
	for await (const chunk of source) {
		signal?.throwIfAborted();
		total += chunk.byteLength;
		if (total > maxBytes) throw new DownloadTooLargeError(maxBytes);
		chunks.push(Buffer.from(chunk));
	}
	await store.write(relativePath, Buffer.concat(chunks, total));
	return total;
}

async function* asAsync(source: AsyncIterable<Uint8Array> | Iterable<Uint8Array>): AsyncGenerator<Uint8Array> {
	yield* source;
}

/** Host-side streaming sink: temp file in the target directory, rename only after success. */
export function createFileDownloadStore(workspaceDir: string): DownloadStore {
	const target = (relativePath: string) => path.join(workspaceDir, ...relativePath.split("/"));
	return {
		exists: async (relativePath) => fs.existsSync(target(relativePath)),
		write: async (relativePath, data) => {
			const file = target(relativePath);
			fs.mkdirSync(path.dirname(file), { recursive: true });
			fs.writeFileSync(file, data);
		},
		writeStream: async (relativePath, source, maxBytes, signal) => {
			const file = target(relativePath);
			fs.mkdirSync(path.dirname(file), { recursive: true });
			const temp = path.join(path.dirname(file), `.${path.basename(file)}.${randomBytes(6).toString("hex")}.part`);
			const handle = await fs.promises.open(temp, "wx", 0o600);
			let total = 0;
			try {
				for await (const chunk of source) {
					signal?.throwIfAborted();
					total += chunk.byteLength;
					if (total > maxBytes) throw new DownloadTooLargeError(maxBytes);
					await handle.write(chunk);
				}
				await handle.sync().catch(() => {});
				await handle.close();
				if (fs.existsSync(file)) throw new Error(`Download target already exists: ${relativePath}`);
				await fs.promises.rename(temp, file);
				return total;
			} catch (error) {
				await handle.close().catch(() => {});
				await fs.promises.unlink(temp).catch(() => {});
				throw error;
			}
		},
	};
}
