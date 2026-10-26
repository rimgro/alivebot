import { getDocument } from "pdfjs-dist/legacy/build/pdf.mjs";

export const PDF_TEXT_MAX_BYTES = 20 * 1024 * 1024;
export const PDF_TEXT_MAX_PAGES = 50;
export const PDF_TEXT_MAX_CHARS = 40_000;
export const PDF_TEXT_TIMEOUT_MS = 20_000;

export type PdfTextErrorCode = "too_large" | "unsupported" | "timeout" | "failed";

/** A safe-to-log PDF failure: messages describe the category, never the document. */
export class PdfTextError extends Error {
	readonly code: PdfTextErrorCode;

	constructor(code: PdfTextErrorCode, description: string) {
		super(description);
		this.name = "PdfTextError";
		this.code = code;
	}
}

export interface PdfTextOptions {
	maxBytes?: number;
	maxPages?: number;
	maxChars?: number;
	timeoutMs?: number;
}

export interface PdfTextResult {
	/** Extracted plain text, with a marker appended when a limit was hit. */
	text: string;
	/** How many pages were read (at most `maxPages`). */
	pages: number;
	truncated: boolean;
}

/**
 * Extract plain text from a PDF locally, without a network call.
 *
 * The limits are part of the contract: a hostile or enormous PDF must not be
 * able to exhaust memory, flood the model context, or block the polling loop.
 */
export async function extractPdfText(bytes: Uint8Array, options: PdfTextOptions = {}): Promise<PdfTextResult> {
	const maxBytes = options.maxBytes ?? PDF_TEXT_MAX_BYTES;
	const maxPages = options.maxPages ?? PDF_TEXT_MAX_PAGES;
	const maxChars = options.maxChars ?? PDF_TEXT_MAX_CHARS;
	const timeoutMs = options.timeoutMs ?? PDF_TEXT_TIMEOUT_MS;

	if (bytes.byteLength > maxBytes) throw new PdfTextError("too_large", `PDF is larger than the ${maxBytes} byte limit`);
	if (bytes.byteLength === 0) throw new PdfTextError("failed", "PDF is empty");

	// pdf.js rejects Node Buffers on purpose, even though they are Uint8Arrays;
	// a plain copy also lets the parser transfer ownership without detaching our buffer.
	const data = new Uint8Array(bytes);
	let task: ReturnType<typeof getDocument>;
	try {
		task = getDocument({
			data,
			// Text extraction needs no script evaluation, DOM fonts or worker-side
			// fetching; keeping them off also prevents crafted PDFs from reaching
			// browser-only code paths.
			isEvalSupported: false,
			useWorkerFetch: false,
			disableFontFace: true,
			useSystemFonts: false,
			verbosity: 0,
		});
	} catch (err) {
		throw asPdfTextError(err);
	}

	try {
		return await withTimeout(readText(task, maxPages, maxChars), timeoutMs);
	} catch (err) {
		throw asPdfTextError(err);
	} finally {
		// Also stops the parse after a timeout; a rejected destroy is expected when
		// the loading task never finished, and must not escape as an unhandled rejection.
		void task.destroy().catch(() => undefined);
	}
}

async function readText(
	task: ReturnType<typeof getDocument>,
	maxPages: number,
	maxChars: number,
): Promise<PdfTextResult> {
	const doc = await task.promise;
	const totalPages = Math.max(0, doc.numPages);
	const pageLimit = Math.min(totalPages, Math.max(0, maxPages));
	let text = "";
	let pages = 0;
	let truncated = totalPages > pageLimit;

	for (let pageNumber = 1; pageNumber <= pageLimit; pageNumber += 1) {
		const page = await doc.getPage(pageNumber);
		const content = await page.getTextContent();
		pages += 1;
		const pageText = normalizeText(content.items);
		if (!pageText) continue;
		const separator = text.length > 0 ? "\n\n" : "";
		const remaining = maxChars - text.length - separator.length;
		if (remaining <= 0) {
			truncated = true;
			break;
		}
		if (pageText.length > remaining) {
			text += separator + pageText.slice(0, remaining);
			truncated = true;
			break;
		}
		text += separator + pageText;
	}

	if (!truncated) return { text, pages, truncated: false };

	// The marker is part of the character budget, so callers can rely on
	// `text.length <= maxChars` even when truncation happened. Compute the body
	// after reserving the marker, then report the body length that survived.
	const markerFor = (chars: number) =>
		`\n\n[PDF text truncated: ${pages} of ${totalPages} pages, ${chars} characters]`;
	const room = Math.max(0, maxChars - markerFor(text.length).length);
	const body = text.slice(0, room).trimEnd();
	const marker = markerFor(body.length);
	return { text: `${body}${marker.length <= maxChars ? marker : marker.slice(0, maxChars)}`, pages, truncated: true };
}

/** pdf.js emits positioned fragments; flatten them into readable prose. */
function normalizeText(items: readonly unknown[]): string {
	let out = "";
	for (const item of items) {
		if (!item || typeof item !== "object") continue;
		const { str, hasEOL } = item as { str?: unknown; hasEOL?: unknown };
		if (typeof str !== "string") continue;
		out += str;
		out += hasEOL ? "\n" : " ";
	}
	return out
		.replace(/[ \t]+\n/g, "\n")
		.replace(/[ \t]{2,}/g, " ")
		.replace(/\n{3,}/g, "\n\n")
		.trim();
}

function withTimeout<T>(work: Promise<T>, timeoutMs: number): Promise<T> {
	if (timeoutMs <= 0) return work;
	let timer: NodeJS.Timeout | undefined;
	const timeout = new Promise<never>((_, reject) => {
		timer = setTimeout(
			() => reject(new PdfTextError("timeout", `PDF parsing exceeded ${timeoutMs} ms`)),
			timeoutMs,
		);
		timer.unref?.();
	});
	return Promise.race([work, timeout]).finally(() => {
		if (timer) clearTimeout(timer);
	});
}

function asPdfTextError(err: unknown): PdfTextError {
	if (err instanceof PdfTextError) return err;
	const name = err instanceof Error ? err.name : "";
	// PasswordException is the only "valid PDF we cannot read without user input" case.
	if (name === "PasswordException") return new PdfTextError("unsupported", "PDF is password-protected");
	if (name === "AbortError" || name === "TimeoutError") return new PdfTextError("timeout", "PDF parsing timed out");
	return new PdfTextError("failed", "PDF could not be parsed");
}
