/** Page text belongs in a workspace file, not in the model's context.
 *
 * A capped page is still up to `maxPageTextChars` characters — far more than a
 * conversation should carry. `read` therefore writes that text to
 * `<workspace>/browser-pages/<host>-<UTC timestamp>.txt` and returns only a
 * preview, the size, and the workspace-relative path. The name is sanitized and
 * fixed-width, so files for one host sort by time and cannot escape the
 * directory.
 */

/** Workspace-relative directory holding extracted page text. */
export const PAGE_TEXT_DIR = "browser-pages";

/** Host part of a page URL, reduced to a portable file-name token. */
export function pageTextHost(url: string | undefined): string {
	let host = "";
	try { host = new URL(url ?? "").hostname.toLowerCase(); } catch { /* blank or malformed page */ }
	const safe = host.replace(/[^a-z0-9.-]+/g, "_").replace(/^[._-]+/, "").replace(/[._-]+$/, "").slice(0, 64);
	return safe || "page";
}

let lastStampMs = 0;

/** `YYYYMMDDTHHMMSSmmmZ` in UTC: fixed width, so names sort chronologically. */
export function pageTextStamp(now?: number): string {
	// Two reads inside one millisecond must not overwrite each other.
	const stamp = now === undefined ? Math.max(Date.now(), lastStampMs + 1) : Math.max(0, now);
	lastStampMs = Math.max(lastStampMs, stamp);
	return new Date(stamp).toISOString().replace(/[-:.]/g, "");
}

/** `browser-pages/<host>-<stamp>.txt`, always POSIX. */
export function pageTextFileName(url: string | undefined, now?: number): string {
	return `${PAGE_TEXT_DIR}/${pageTextHost(url)}-${pageTextStamp(now)}.txt`;
}

/** Workspace-relative path for a just-written page text. */
export interface PageTextStore {
	/** Must create parent directories; resolves once the file exists. */
	write(relativePath: string, data: Buffer): Promise<void>;
}

/** Writes the already-capped text and returns its workspace-relative path. */
export async function writePageText(store: PageTextStore, url: string | undefined, text: string, now?: number): Promise<string> {
	const relativePath = pageTextFileName(url, now);
	await store.write(relativePath, Buffer.from(text, "utf8"));
	return relativePath;
}
