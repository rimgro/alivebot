import type { HistoryAttachment } from "../../store/history.js";
import { TelegramApiError } from "./client.js";

/** Inbound Telegram photos larger than this are skipped instead of buffered in memory. */
export const TELEGRAM_IMAGE_MAX_BYTES = 10 * 1024 * 1024;
/** Cap covering `getFile` plus the streamed download. */
export const TELEGRAM_IMAGE_TIMEOUT_MS = 30_000;
/** Workspace folder shared with the `download_file` tool. */
export const TELEGRAM_IMAGE_DIR = "telegram-files";

export type InboundImageResult =
	| { status: "saved"; path: string; mime: string; bytes: number }
	| { status: "too_large" }
	| { status: "failed"; reason: string };

const EXTENSION_BY_IMAGE_MIME: Record<string, string> = {
	"image/jpeg": "jpg",
	"image/jpg": "jpg",
	"image/png": "png",
	"image/webp": "webp",
	"image/gif": "gif",
	"image/heic": "heic",
	"image/heif": "heif",
};

/** Telegram photos carry no mime type; static photos are JPEG unless stated otherwise. */
export function imageMime(attachment: HistoryAttachment): string {
	const mime = attachment.mime?.split(";", 1)[0]?.trim().toLowerCase();
	return mime?.startsWith("image/") ? mime : "image/jpeg";
}

function extensionForMime(mime: string): string {
	return EXTENSION_BY_IMAGE_MIME[mime] ?? "jpg";
}

/** `<messageId>-<fileUniqueId>.<ext>`, with every component reduced to a safe file name. */
export function imageFileName(messageId: string, fileUniqueId: string | undefined, mime: string): string {
	const message = safeSegment(messageId) || "message";
	const unique = safeSegment(fileUniqueId) || "image";
	return `${message}-${unique}.${extensionForMime(mime)}`;
}

/** Workspace-relative path, always POSIX: `telegram-files/123-AbCd.jpg`. */
export function imageRelativePath(messageId: string, fileUniqueId: string | undefined, mime: string): string {
	return `${TELEGRAM_IMAGE_DIR}/${imageFileName(messageId, fileUniqueId, mime)}`;
}

function safeSegment(value: string | undefined): string {
	if (!value) return "";
	const cleaned = value.replace(/[^A-Za-z0-9_-]+/g, "_").replace(/^[_-]+|[_-]+$/g, "");
	return cleaned.slice(0, 80);
}

/** One short, secret-free line appended to the agent-facing event (and history on success). */
export function imageAnnotation(result: InboundImageResult): string {
	switch (result.status) {
		case "saved":
			return `image saved: ${result.path} (read this local file to see the image)`;
		case "too_large":
			return `image not saved: file exceeds the ${mibLabel(TELEGRAM_IMAGE_MAX_BYTES)} limit`;
		case "failed":
			return `image not saved: ${result.reason}`;
	}
}

export function mibLabel(bytes: number): string {
	return bytes > 0 && bytes % (1024 * 1024) === 0 ? `${bytes / (1024 * 1024)} MiB` : `${bytes} bytes`;
}

/** Map a failure to a short reason that never carries the URL, the token, or the file path. */
export function imageFailureReason(err: unknown): string {
	if (err instanceof TelegramApiError) {
		return err.errorCode !== undefined ? `Telegram returned HTTP/API ${err.errorCode}` : "Telegram request failed";
	}
	if (err instanceof Error) {
		// `downloadFile` reports the HTTP status in its message; keep just the status.
		const http = /^file download failed: HTTP (\d{3})$/.exec(err.message);
		if (http) return `Telegram file download failed (HTTP ${http[1]})`;
		if (err.name === "AbortError" || err.name === "TimeoutError") return "request timed out";
	}
	return "request failed";
}
