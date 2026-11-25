/**
 * Markdown → Telegram HTML (#266, slice 1).
 *
 * The agent writes Markdown, Telegram accepts a narrow subset of HTML when
 * `parse_mode: "HTML"` is set. This module is the bridge: a small, dependency
 * free renderer that only ever emits the tags Telegram understands
 * (`b`, `i`, `s`, `u`, `code`, `pre`, `a href`, `blockquote`, `tg-spoiler`).
 *
 * Two rules matter more than feature completeness:
 *
 * 1. Everything the agent wrote is escaped. Raw HTML in the source never
 *    becomes markup, so a reply cannot inject tags of its own.
 * 2. Text is only emphasised where CommonMark says so. `snake_case_name` and
 *    `foo*bar*baz` stay literal, which is the behaviour users expect from a
 *    chat message (and what #266 asks for).
 */

import { escapeHtml, TELEGRAM_MAX_CHARS } from "./text.js";

/** Characters that may safely appear in a link target. */
const SAFE_URL = /^(https?:\/\/|tg:\/\/|mailto:)/i;

/** Fenced code block info strings are restricted to a harmless identifier. */
const SAFE_LANGUAGE = /[^a-zA-Z0-9_+.#-]/g;

/** Render Markdown into the HTML subset accepted by Telegram. */
export function renderMarkdownToHtml(markdown: string): string {
	const lines = markdown.replace(/\r\n?/g, "\n").split("\n");
	return renderBlocks(lines).join("\n");
}

/** Remove rendered tags and decode the entities we emit, for the plain fallback. */
export function htmlToPlainText(html: string): string {
	return html
		.replace(/<[^>]*>/g, "")
		.replace(/&lt;/g, "<")
		.replace(/&gt;/g, ">")
		.replace(/&quot;/g, '"')
		.replace(/&#39;/g, "'")
		.replace(/&amp;/g, "&");
}

// ---------------------------------------------------------------------------
// Block level
// ---------------------------------------------------------------------------

function renderBlocks(lines: string[]): string[] {
	const out: string[] = [];
	let i = 0;
	while (i < lines.length) {
		const line = lines[i];
		if (/^\s*$/.test(line)) {
			i += 1;
			continue;
		}

		const fence = /^ {0,3}(`{3,}|~{3,})\s*([^\s`]*)/.exec(line);
		if (fence) {
			const marker = fence[1][0];
			const length = fence[1].length;
			const language = fence[2] ?? "";
			const body: string[] = [];
			i += 1;
			const close = new RegExp(`^ {0,3}${marker === "`" ? "`" : "~"}{${length},}\\s*$`);
			while (i < lines.length && !close.test(lines[i])) {
				body.push(lines[i]);
				i += 1;
			}
			if (i < lines.length) i += 1;
			const className = language ? ` class="language-${escapeAttr(language.replace(SAFE_LANGUAGE, ""))}"` : "";
			out.push(`<pre><code${className}>${escapeHtml(body.join("\n"))}</code></pre>`);
			continue;
		}

		if (line.includes("|") && i + 1 < lines.length && isTableSeparator(lines[i + 1])) {
			const header = splitTableRow(line);
			const alignments = tableAlignments(lines[i + 1]);
			const rows: string[][] = [];
			i += 2;
			while (i < lines.length && lines[i].includes("|") && !/^\s*$/.test(lines[i])) {
				rows.push(splitTableRow(lines[i]));
				i += 1;
			}
			out.push(renderTable(header, rows, alignments));
			continue;
		}

		const heading = /^ {0,3}(#{1,6})\s+(.*?)\s*#*\s*$/.exec(line);
		if (heading) {
			out.push(`<b>${renderInline(heading[2])}</b>`);
			i += 1;
			continue;
		}

		if (/^ {0,3}>/.test(line)) {
			const quoted: string[] = [];
			while (i < lines.length && /^ {0,3}>/.test(lines[i])) {
				quoted.push(lines[i].replace(/^ {0,3}>\s?/, ""));
				i += 1;
			}
			out.push(`<blockquote>${renderBlocks(quoted).join("\n")}</blockquote>`);
			continue;
		}

		if (isListItem(line)) {
			const items: string[] = [];
			while (i < lines.length && isListItem(lines[i])) {
				const match = /^(\s*)([-*+]|\d+[.)])\s+(.*)$/.exec(lines[i])!;
				const indent = match[1].replace(/\t/g, "  ").length;
				const level = Math.floor(indent / 2);
				const ordered = /^\d/.test(match[2]);
				const marker = ordered ? `${Number.parseInt(match[2], 10)}.` : "•";
				items.push(`${"  ".repeat(level)}${marker} ${renderInline(match[3])}`);
				i += 1;
			}
			out.push(items.join("\n"));
			continue;
		}

		const paragraph: string[] = [];
		while (i < lines.length && !/^\s*$/.test(lines[i]) && !isBlockStart(lines, i)) {
			paragraph.push(renderInline(lines[i]));
			i += 1;
		}
		if (paragraph.length > 0) out.push(paragraph.join("\n"));
	}
	return out;
}

function isListItem(line: string): boolean {
	return /^\s*([-*+]|\d+[.)])\s+/.test(line);
}

/** True when the line at `index` starts a block that must not join a paragraph. */
function isBlockStart(lines: string[], index: number): boolean {
	const line = lines[index];
	if (/^ {0,3}(`{3,}|~{3,})/.test(line)) return true;
	if (/^ {0,3}#{1,6}\s+/.test(line)) return true;
	if (/^ {0,3}>/.test(line)) return true;
	if (isListItem(line)) return true;
	if (line.includes("|") && index + 1 < lines.length && isTableSeparator(lines[index + 1])) return true;
	return false;
}

// ---------------------------------------------------------------------------
// Tables
// ---------------------------------------------------------------------------

function isTableSeparator(line: string): boolean {
	return /^\s*\|?\s*:?-{1,}:?\s*(\|\s*:?-{1,}:?\s*)+\|?\s*$/.test(line);
}

function splitTableRow(line: string): string[] {
	let raw = line.trim();
	if (raw.startsWith("|")) raw = raw.slice(1);
	if (raw.endsWith("|") && !raw.endsWith("\\|")) raw = raw.slice(0, -1);
	const cells: string[] = [];
	let current = "";
	let escaped = false;
	for (const char of raw) {
		if (escaped) {
			current += char;
			escaped = false;
		} else if (char === "\\") {
			escaped = true;
		} else if (char === "|") {
			cells.push(current.trim());
			current = "";
		} else {
			current += char;
		}
	}
	cells.push(current.trim());
	return cells;
}

type Alignment = "left" | "center" | "right";

function tableAlignments(separator: string): Alignment[] {
	const cells = splitTableRow(separator);
	return cells.map((cell) => {
		const left = cell.startsWith(":");
		const right = cell.endsWith(":");
		if (left && right) return "center";
		if (right) return "right";
		return "left";
	});
}

function renderTable(header: string[], rows: string[][], alignments: Alignment[]): string {
	const columns = Math.max(header.length, ...rows.map((row) => row.length), alignments.length, 1);
	const normalizedHeader = normalizeCells(header, columns);
	const normalizedRows = rows.map((row) => normalizeCells(row, columns));
	const widths: number[] = [];
	for (let column = 0; column < columns; column += 1) {
		let width = 1;
		width = Math.max(width, displayWidth(normalizedHeader[column]));
		for (const row of normalizedRows) width = Math.max(width, displayWidth(row[column]));
		widths[column] = width;
	}
	const align = (column: number): Alignment => alignments[column] ?? "left";
	const row = (cells: string[]): string => `| ${cells.map((cell, column) => padCell(cell, widths[column], align(column))).join(" | ")} |`;
	const separator = `|${widths
		.map((width, column) => {
			const alignment = align(column);
			if (alignment === "center") return `:${"-".repeat(width)}:`;
			if (alignment === "right") return `${"-".repeat(width + 1)}:`;
			return `:${"-".repeat(width + 1)}`;
		})
		.join("|")}|`;
	const lines = [row(normalizedHeader), separator, ...normalizedRows.map(row)];
	return `<pre><code>${escapeHtml(lines.join("\n"))}</code></pre>`;
}

function normalizeCells(cells: string[], columns: number): string[] {
	const result = cells.slice(0, columns);
	while (result.length < columns) result.push("");
	return result;
}

function padCell(value: string, width: number, alignment: Alignment): string {
	const missing = Math.max(0, width - displayWidth(value));
	if (missing === 0) return value;
	if (alignment === "right") return " ".repeat(missing) + value;
	if (alignment === "center") {
		const left = Math.floor(missing / 2);
		return " ".repeat(left) + value + " ".repeat(missing - left);
	}
	return value + " ".repeat(missing);
}

// ---------------------------------------------------------------------------
// Display width (a small wcwidth)
// ---------------------------------------------------------------------------

/** Visible width of `text` in a monospace font: CJK/emoji are two cells, marks zero. */
export function displayWidth(text: string): number {
	let width = 0;
	let afterJoiner = false;
	let regional = false;
	for (const char of text) {
		const code = char.codePointAt(0)!;
		if (code === 0x200d) {
			afterJoiner = true;
			continue;
		}
		if (code === 0xfe0e || code === 0xfe0f) continue;
		if (isCombining(code)) continue;
		if (afterJoiner) {
			afterJoiner = false;
			continue;
		}
		if (code >= 0x1f1e6 && code <= 0x1f1ff) {
			if (regional) {
				regional = false;
				continue;
			}
			regional = true;
			width += 2;
			continue;
		}
		regional = false;
		width += isWide(code) ? 2 : 1;
	}
	return width;
}

function isCombining(code: number): boolean {
	return (
		(code >= 0x0300 && code <= 0x036f) ||
		(code >= 0x1ab0 && code <= 0x1aff) ||
		(code >= 0x1dc0 && code <= 0x1dff) ||
		(code >= 0x20d0 && code <= 0x20ff) ||
		(code >= 0xfe20 && code <= 0xfe2f)
	);
}

function isWide(code: number): boolean {
	return (
		code >= 0x1100 &&
		(code <= 0x115f ||
			code === 0x2329 ||
			code === 0x232a ||
			(code >= 0x2e80 && code <= 0x303e) ||
			(code >= 0x3041 && code <= 0x33ff) ||
			(code >= 0x3400 && code <= 0x4dbf) ||
			(code >= 0x4e00 && code <= 0x9fff) ||
			(code >= 0xa000 && code <= 0xa4cf) ||
			(code >= 0xa960 && code <= 0xa97f) ||
			(code >= 0xac00 && code <= 0xd7a3) ||
			(code >= 0xf900 && code <= 0xfaff) ||
			(code >= 0xfe10 && code <= 0xfe19) ||
			(code >= 0xfe30 && code <= 0xfe6f) ||
			(code >= 0xff00 && code <= 0xff60) ||
			(code >= 0xffe0 && code <= 0xffe6) ||
			(code >= 0x1f300 && code <= 0x1f64f) ||
			(code >= 0x1f680 && code <= 0x1f6ff) ||
			(code >= 0x1f900 && code <= 0x1f9ff) ||
			(code >= 0x1fa70 && code <= 0x1faff) ||
			(code >= 0x2600 && code <= 0x27bf) ||
			(code >= 0x1f200 && code <= 0x1f251))
	);
}

// ---------------------------------------------------------------------------
// Inline level
// ---------------------------------------------------------------------------

function renderInline(text: string, allowLinks = true): string {
	let out = "";
	let i = 0;
	while (i < text.length) {
		const char = text[i];

		if (char === "\\" && i + 1 < text.length && isAsciiPunctuation(text[i + 1])) {
			out += escapeHtml(text[i + 1]);
			i += 2;
			continue;
		}

		if (char === "`") {
			const run = runLength(text, i, "`");
			const close = findBacktickClose(text, i + run, run);
			if (close !== -1) {
				let content = text.slice(i + run, close);
				if (content.length >= 2 && content.startsWith(" ") && content.endsWith(" ") && content.trim() !== "") {
					content = content.slice(1, -1);
				}
				out += `<code>${escapeHtml(content)}</code>`;
				i = close + run;
				continue;
			}
			out += escapeHtml("`".repeat(run));
			i += run;
			continue;
		}

		if (char === "|" && text[i + 1] === "|") {
			const close = findDelimiterClose(text, i + 2, "||", "|", true);
			if (close !== -1) {
				out += `<tg-spoiler>${renderInline(text.slice(i + 2, close), allowLinks)}</tg-spoiler>`;
				i = close + 2;
				continue;
			}
			out += "||";
			i += 2;
			continue;
		}

		if (char === "~" && text[i + 1] === "~") {
			const close = findDelimiterClose(text, i + 2, "~~", "~", true);
			if (close !== -1) {
				out += `<s>${renderInline(text.slice(i + 2, close), allowLinks)}</s>`;
				i = close + 2;
				continue;
			}
			out += "~~";
			i += 2;
			continue;
		}

		if (char === "*" || char === "_") {
			const strong = text[i + 1] === char;
			const delimiter = strong ? char + char : char;
			if (canOpen(text, i, delimiter, char) && !isPartOfLongerRun(text, i, char, strong)) {
				const close = findDelimiterClose(text, i + delimiter.length, delimiter, char, strong);
				if (close !== -1) {
					const inner = renderInline(text.slice(i + delimiter.length, close), allowLinks);
					out += strong ? `<b>${inner}</b>` : `<i>${inner}</i>`;
					i = close + delimiter.length;
					continue;
				}
			}
			out += escapeHtml(delimiter);
			i += delimiter.length;
			continue;
		}

		if (char === "[" && allowLinks) {
			const link = parseLink(text, i);
			if (link) {
				out += `<a href="${escapeAttr(link.url)}">${renderInline(link.text, false)}</a>`;
				i = link.end;
				continue;
			}
			out += "[";
			i += 1;
			continue;
		}

		if (allowLinks && (char === "h" || char === "H")) {
			const rest = text.slice(i);
			if (/^https?:\/\//i.test(rest)) {
				const match = /^https?:\/\/[^\s<>"']+/i.exec(rest);
				if (match) {
					const url = trimUrl(match[0]);
					out += `<a href="${escapeAttr(url)}">${escapeHtml(url)}</a>`;
					i += url.length;
					continue;
				}
			}
		}

		out += escapeHtml(char);
		i += 1;
	}
	return out;
}

function runLength(text: string, start: number, char: string): number {
	let length = 0;
	while (start + length < text.length && text[start + length] === char) length += 1;
	return length;
}

function findBacktickClose(text: string, from: number, run: number): number {
	const needle = "`".repeat(run);
	let index = text.indexOf(needle, from);
	while (index !== -1) {
		if (!isEscaped(text, index) && runLength(text, index, "`") === run) return index;
		index = text.indexOf(needle, index + 1);
	}
	return -1;
}

/** Find a closing delimiter that satisfies the flanking rules at `from`. */
function findDelimiterClose(text: string, from: number, delimiter: string, mark: string, strong: boolean): number {
	let index = text.indexOf(delimiter, from);
	while (index !== -1) {
		if (!isEscaped(text, index) && !isPartOfLongerRun(text, index, mark, strong) && canClose(text, index, delimiter, mark)) {
			return index;
		}
		index = text.indexOf(delimiter, index + 1);
	}
	return -1;
}

function isPartOfLongerRun(text: string, index: number, mark: string, strong: boolean): boolean {
	let start = index;
	while (start > 0 && text[start - 1] === mark) start -= 1;
	const run = runLength(text, start, mark);
	// The delimiter must be the first character of its run and have the right length.
	if (strong) return run !== 2 || index !== start;
	return run !== 1;
}

function isEscaped(text: string, index: number): boolean {
	let backslashes = 0;
	for (let i = index - 1; i >= 0 && text[i] === "\\"; i -= 1) backslashes += 1;
	return backslashes % 2 === 1;
}

function parseLink(text: string, start: number): { text: string; url: string; end: number } | undefined {
	const labelEnd = text.indexOf("]", start + 1);
	if (labelEnd === -1 || text[labelEnd + 1] !== "(") return undefined;
	let depth = 1;
	let index = labelEnd + 2;
	for (; index < text.length && depth > 0; index += 1) {
		if (text[index] === "(" && !isEscaped(text, index)) depth += 1;
		else if (text[index] === ")" && !isEscaped(text, index)) depth -= 1;
	}
	if (depth !== 0) return undefined;
	const url = text.slice(labelEnd + 2, index - 1).trim();
	if (!SAFE_URL.test(url) || /[\s]/.test(url)) return undefined;
	return { text: text.slice(start + 1, labelEnd), url, end: index };
}

function trimUrl(url: string): string {
	let result = url.replace(/[.,;:!?]+$/, "");
	if (result.endsWith(")") && !result.includes("(")) result = result.slice(0, -1).replace(/[.,;:!?]+$/, "");
	return result;
}

// ---------------------------------------------------------------------------
// CommonMark emphasis flanking
// ---------------------------------------------------------------------------

function canOpen(text: string, index: number, delimiter: string, mark: string): boolean {
	const previous = charBefore(text, index);
	const next = charAfter(text, index + delimiter.length);
	if (isWord(previous) && isWord(next)) return false;
	const left = leftFlanking(previous, next);
	const right = rightFlanking(previous, next);
	if (mark === "_") return left && (!right || isPunctuation(previous));
	return left;
}

function canClose(text: string, index: number, delimiter: string, mark: string): boolean {
	const previous = charBefore(text, index);
	const next = charAfter(text, index + delimiter.length);
	if (isWord(previous) && isWord(next)) return false;
	const left = leftFlanking(previous, next);
	const right = rightFlanking(previous, next);
	if (mark === "_") return right && (!left || isPunctuation(next));
	return right;
}

function leftFlanking(previous: string, next: string): boolean {
	return !isWhitespace(next) && (!isPunctuation(next) || isWhitespace(previous) || isPunctuation(previous));
}

function rightFlanking(previous: string, next: string): boolean {
	return !isWhitespace(previous) && (!isPunctuation(previous) || isWhitespace(next) || isPunctuation(next));
}

function charBefore(text: string, index: number): string {
	if (index <= 0) return "";
	const code = text.codePointAt(index - 1)!;
	if (code >= 0xdc00 && code <= 0xdfff && index >= 2) {
		const high = text.charCodeAt(index - 2);
		if (high >= 0xd800 && high <= 0xdbff) return text.slice(index - 2, index);
	}
	return String.fromCodePoint(code);
}

function charAfter(text: string, index: number): string {
	if (index >= text.length) return "";
	return String.fromCodePoint(text.codePointAt(index)!);
}

function isWhitespace(char: string): boolean {
	return char === "" || /\s/u.test(char);
}

function isPunctuation(char: string): boolean {
	return char !== "" && /[\p{P}\p{S}]/u.test(char);
}

function isWord(char: string): boolean {
	return char !== "" && /[\p{L}\p{N}]/u.test(char);
}

function isAsciiPunctuation(char: string): boolean {
	return /[!-/:-@[-`{-~]/.test(char);
}

// ---------------------------------------------------------------------------
// Splitting rendered HTML
// ---------------------------------------------------------------------------

const HTML_TOKEN = /<\/?[a-zA-Z][^>]*>|&#?[a-zA-Z0-9]+;|[\s\S]/gu;

/**
 * Split rendered HTML into Telegram-sized chunks.
 *
 * The limit is applied to the HTML that will actually be sent, and a cut never
 * falls inside a tag or an entity. Open tags are closed at the end of a chunk
 * and reopened in the next one, so every chunk is valid on its own while the
 * visible text is preserved exactly once.
 */
export function splitHtml(html: string, max = TELEGRAM_MAX_CHARS): string[] {
	const limit = Math.max(32, Math.floor(max));
	if (html.length <= limit) return html.length > 0 ? [html] : [];
	const tokens = html.match(HTML_TOKEN) ?? [];
	const chunks: string[] = [];
	let stack: string[] = [];
	let current: string[] = [];
	let length = 0;
	let body = false;

	const closers = (open: string[]): string => open.slice().reverse().map((tag) => `</${tagName(tag)}>`).join("");
	const flush = (): void => {
		chunks.push(current.join("") + closers(stack));
		current = [];
		length = 0;
		if (stack.length > 0) {
			const reopened = stack.join("");
			current.push(reopened);
			length = reopened.length;
		}
		body = false;
	};

	for (const token of tokens) {
		if (token.startsWith("</")) {
			const closingName = tagName(token);
			const nextStack = popTag(stack, closingName);
			if (body && length + token.length + closers(nextStack).length > limit) flush();
			stack = popTag(stack, closingName);
			current.push(token);
			length += token.length;
			continue;
		}
		if (token.startsWith("<")) {
			const nextStack = [...stack, token];
			if (body && length + token.length + closers(nextStack).length > limit) flush();
			stack = [...stack, token];
			current.push(token);
			length += token.length;
			continue;
		}
		if (body && length + token.length + closers(stack).length > limit) flush();
		current.push(token);
		length += token.length;
		body = true;
	}

	if (current.length > 0 && (body || chunks.length === 0)) chunks.push(current.join("") + closers(stack));
	return chunks.filter((chunk) => chunk.length > 0);
}

function popTag(stack: string[], name: string): string[] {
	const index = stack.map(tagName).lastIndexOf(name);
	return index === -1 ? [...stack] : stack.slice(0, index);
}

function tagName(tag: string): string {
	return /^<\/?([a-zA-Z][a-zA-Z0-9-]*)/.exec(tag)?.[1]?.toLowerCase() ?? "";
}

function escapeAttr(value: string): string {
	return escapeHtml(value).replace(/"/g, "&quot;");
}
