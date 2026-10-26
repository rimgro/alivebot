import * as fs from "node:fs";
import * as path from "node:path";
import type { OutgoingAttachment } from "../store/outbox.js";

/**
 * Outbound attachments (`send_message` with a file).
 *
 * One place for the rules every producer and the delivering module must agree
 * on: what a workspace-relative path may look like, how a file is inspected
 * without following a symlink out of the workspace, which mime/kind a file
 * gets, and which Telegram size caps apply.
 */

/** Telegram hard cap for `sendPhoto` uploads. */
export const OUTBOUND_PHOTO_MAX_BYTES = 10 * 1024 * 1024;
/** Telegram hard cap for `sendDocument` uploads. */
export const OUTBOUND_DOCUMENT_MAX_BYTES = 50 * 1024 * 1024;
/** Telegram hard cap for a media caption; the rest must be a separate message. */
export const TELEGRAM_CAPTION_MAX_CHARS = 1024;

export type AttachmentKind = "photo" | "document";

export interface InspectedAttachment {
	/** Workspace-relative POSIX path; the only path form that is recorded durably. */
	path: string;
	/** Host path with every symlink resolved. Not meaningful inside a sandbox. */
	absolutePath: string;
	name: string;
	mime?: string;
	kind: AttachmentKind;
	/** Byte size, when the host filesystem could stat the file. */
	size?: number;
}

/** The file is not visible at the requested path (missing, or not yet on the host). */
export class AttachmentNotFoundError extends Error {
	constructor(readonly relativePath: string) {
		super(`attachment not found in the workspace: ${relativePath}`);
		this.name = "AttachmentNotFoundError";
	}
}

const MIME_BY_EXT: Record<string, string> = {
	".png": "image/png",
	".jpg": "image/jpeg",
	".jpeg": "image/jpeg",
	".webp": "image/webp",
	".gif": "image/gif",
	".pdf": "application/pdf",
	".json": "application/json",
	".txt": "text/plain; charset=utf-8",
	".md": "text/markdown; charset=utf-8",
	".csv": "text/csv",
	".zip": "application/zip",
	".gz": "application/gzip",
	".mp3": "audio/mpeg",
	".ogg": "audio/ogg",
	".m4a": "audio/mp4",
	".wav": "audio/wav",
	".mp4": "video/mp4",
	".webm": "video/webm",
};

/** Mime type from a file name. Unknown extensions stay `undefined` (sent as a document). */
export function mimeForFile(name: string): string | undefined {
	return MIME_BY_EXT[path.extname(name).toLowerCase()];
}

/**
 * `photo` only for images; everything else is a document so it is never
 * silently converted or rejected by Telegram's photo pipeline.
 */
export function attachmentKind(mime: string | undefined, requested?: string): AttachmentKind {
	if (requested === "document") return "document";
	// An explicit `photo` for a non-image cannot become a photo; fall back to a file.
	return mime?.startsWith("image/") ? "photo" : "document";
}

/** Throws a clear, agent-facing error when the file exceeds the cap for its kind. */
export function assertAttachmentSize(kind: AttachmentKind, bytes: number, name: string): void {
	if (kind === "photo" && bytes > OUTBOUND_PHOTO_MAX_BYTES) {
		throw new Error(
			`attachment ${name} is ${bytes} bytes, over the ${mib(OUTBOUND_PHOTO_MAX_BYTES)} Telegram photo limit. ` +
				`Retry with attachment_kind="document" to send it as a file (limit ${mib(OUTBOUND_DOCUMENT_MAX_BYTES)}).`,
		);
	}
	if (kind === "document" && bytes > OUTBOUND_DOCUMENT_MAX_BYTES) {
		throw new Error(
			`attachment ${name} is ${bytes} bytes, over the ${mib(OUTBOUND_DOCUMENT_MAX_BYTES)} Telegram document limit.`,
		);
	}
}

/**
 * Lexical half of the validation, usable on the host and inside a sandbox:
 * a relative POSIX path that cannot climb out of the workspace.
 */
export function attachmentRelativePath(requested: string): string {
	const raw = requested.trim();
	if (!raw) throw new Error("attachment path is empty");
	if (raw.includes("\0")) throw new Error("attachment path must not contain NUL bytes");
	if (raw.includes("\\")) throw new Error(`attachment path must use forward slashes: ${requested}`);
	if (path.posix.isAbsolute(raw)) {
		throw new Error(`attachment path must be relative to the workspace, not absolute: ${requested}`);
	}
	if (raw.split("/").includes("..")) throw new Error(`attachment path must not contain '..': ${requested}`);
	const relative = path.posix.normalize(raw).replace(/^\.\/+/, "");
	if (!relative || relative === ".") throw new Error("attachment path is empty");
	return relative;
}

/**
 * Host-side inspection: lexical rules, then realpath containment so a symlink
 * cannot hand Telegram a file from outside the workspace. Existence and
 * regular-file checks happen before any upload.
 */
export function inspectHostAttachment(
	workspaceDir: string,
	requested: string,
	requestedKind?: string,
): InspectedAttachment {
	const relative = attachmentRelativePath(requested);
	const root = path.resolve(workspaceDir);
	let realRoot = root;
	try {
		realRoot = fs.realpathSync.native(root);
	} catch {
		// A missing workspace can only mean "nothing to attach"; the target check below reports it.
	}
	const target = path.resolve(realRoot, relative);
	let realTarget: string;
	try {
		realTarget = fs.realpathSync.native(target);
	} catch {
		throw new AttachmentNotFoundError(relative);
	}
	if (realTarget !== realRoot && !realTarget.startsWith(`${realRoot}${path.sep}`)) {
		throw new Error(`attachment resolves outside the workspace (${workspaceDir}): ${requested}`);
	}
	let stat: fs.Stats;
	try {
		stat = fs.statSync(realTarget);
	} catch {
		throw new Error(`attachment is not readable: ${relative}`);
	}
	if (!stat.isFile()) throw new Error(`attachment is not a regular file: ${relative}`);
	const name = path.posix.basename(relative);
	const mime = mimeForFile(name);
	return {
		path: relative,
		absolutePath: realTarget,
		name,
		mime,
		kind: attachmentKind(mime, requestedKind),
		size: stat.size,
	};
}

export interface ResolveAttachmentOptions {
	/**
	 * The workspace may live inside a sandbox VM, where the host cannot see the
	 * agent's files. A missing host file is then deferred to delivery, which
	 * re-validates through the sandbox file bridge before uploading anything.
	 */
	deferHostChecks?: boolean;
}

/**
 * Resolve (and pre-validate) an attachment passed by the agent. Path escapes and
 * oversize files fail here, before a message is written or an API call is made.
 */
export function resolveOutgoingAttachment(
	workspaceDir: string,
	requested: string,
	requestedKind?: string,
	options: ResolveAttachmentOptions = {},
): InspectedAttachment {
	let inspected: InspectedAttachment;
	try {
		inspected = inspectHostAttachment(workspaceDir, requested, requestedKind);
	} catch (err) {
		if (!options.deferHostChecks || !(err instanceof AttachmentNotFoundError)) throw err;
		const relative = attachmentRelativePath(requested);
		const name = path.posix.basename(relative);
		const mime = mimeForFile(name);
		inspected = {
			path: relative,
			absolutePath: path.resolve(workspaceDir, relative),
			name,
			mime,
			kind: attachmentKind(mime, requestedKind),
		};
	}
	if (inspected.size !== undefined) assertAttachmentSize(inspected.kind, inspected.size, inspected.name);
	return inspected;
}

/** The durable outbox form of a resolved attachment. */
export function toOutgoingAttachment(inspected: InspectedAttachment): OutgoingAttachment {
	return {
		path: inspected.path,
		kind: inspected.kind,
		name: inspected.name,
		...(inspected.mime ? { mime: inspected.mime } : {}),
		...(inspected.size !== undefined ? { size: inspected.size } : {}),
	};
}

function mib(bytes: number): string {
	return bytes > 0 && bytes % (1024 * 1024) === 0 ? `${bytes / (1024 * 1024)} MiB` : `${bytes} bytes`;
}
