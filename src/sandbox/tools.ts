import * as path from "node:path";
import { createHash } from "node:crypto";
import { Type } from "typebox";
import {
	defineTool, createWriteToolDefinition, createEditToolDefinition,
	truncateHead, DEFAULT_MAX_BYTES, DEFAULT_MAX_LINES, resizeImage, formatDimensionNote,
	type ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import { type SandboxManager, type VirtualFiles } from "./manager.js";
import type { LoadedConfig } from "../config.js";
import { createGitHubAuthTool } from "../github/app-auth.js";
import { createGitHubApiTool } from "../github/api-tool.js";

const result = (text: string, details: unknown = undefined) => ({ content: [{ type: "text" as const, text }], details });

/** Guest-only read (Pi image resizing/truncation) and SDK multi-edit/diff.
 * Pi's stock read also probes ambient host paths and rejects early on abort;
 * the custom reader avoids both and retains the lifecycle lock until IO settles.
 */
export function createSandboxTools(manager: SandboxManager, loaded?: LoadedConfig): ToolDefinition[] {
	const GUEST_WORKSPACE = manager.workspaceDir;
	const guestPath = (file: string) => manager.path(file);
	let files: VirtualFiles;
	let targetPath = GUEST_WORKSPACE;
	// SDK write/edit use host-platform path helpers (including tilde/Unicode
	// normalization). Their paths are only queue/render keys; IO uses this
	// original POSIX guest target, never those host-derived strings.
	const readFile = async (_sdkPath: string) => files.read(targetPath);
	const read = defineTool({
		name: "read", label: "Sandbox read",
		description: "Read a guest text file or PNG/JPEG/GIF/WebP/BMP image. offset/limit are 1-indexed lines; text output is capped to 2000 lines or 50 KiB. Private ordinary files can be read without booting a stopped VM. Never probes host paths. Images are resized for vision; maxFileBytes applies to input.",
		parameters: Type.Object({ path: Type.String(), offset: Type.Optional(Type.Integer({ minimum: 1 })), limit: Type.Optional(Type.Integer({ minimum: 1 })) }),
		execute: async (_id, params, signal, _update, ctx) => manager.exclusive(async () => {
			signal?.throwIfAborted();
			const f = await manager.files();
			const data = await f.read(guestPath(params.path));
			signal?.throwIfAborted();
			const mime = data.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])) ? "image/png"
				: data[0] === 255 && data[1] === 216 && data[2] === 255 ? "image/jpeg"
				: data.subarray(0, 6).toString().startsWith("GIF8") ? "image/gif"
				: data.subarray(0, 4).toString() === "RIFF" && data.subarray(8, 12).toString() === "WEBP" ? "image/webp"
				: data.subarray(0, 2).toString() === "BM" ? "image/bmp" : undefined;
			if (mime) {
				if (ctx?.model && !ctx.model.input.includes("image")) return result("Current model does not support images; use a vision model.");
				const image = await resizeImage(data, mime);
				signal?.throwIfAborted();
				if (!image) return result("Image omitted: could not be resized to the inline image limit.");
				return { content: [{ type: "text" as const, text: `Read image [${image.mimeType}] ${formatDimensionNote(image) ?? ""}` },
					{ type: "image" as const, data: image.data, mimeType: image.mimeType }], details: undefined };
			}
			if (data.includes(0)) throw new Error("Binary file is not a supported inline image; use file stat/hash or guest shell");
			const text = data.toString("utf8");
			const offset = params.offset ?? 1;
			const selected: string[] = [];
			let bytes = 0;
			let start = 0;
			let totalLines = 0;
			// Count all lines, but never build an array of millions of tiny lines.
			while (start <= text.length) {
				const newline = text.indexOf("\n", start);
				const end = newline < 0 ? text.length : newline;
				totalLines++;
				if (totalLines >= offset && selected.length < (params.limit ?? Infinity)
					&& selected.length <= DEFAULT_MAX_LINES && bytes <= DEFAULT_MAX_BYTES) {
					const line = text.slice(start, Math.min(end, start + DEFAULT_MAX_BYTES + 1));
					selected.push(line); bytes += Buffer.byteLength(line) + 1;
				}
				if (newline < 0) break;
				start = end + 1;
			}
			if (offset > totalLines) throw new Error(`Offset ${offset} is beyond end of file (${totalLines} lines)`);
			const truncation = truncateHead(selected.join("\n"));
			if (truncation.firstLineExceedsLimit) return result(`Line ${offset} exceeds 50 KiB; use guest bash to extract byte ranges.`, { truncation, totalLines });
			const lastLine = offset + truncation.outputLines - 1;
			const continuation = lastLine < totalLines ? `\n\n[Showing lines ${offset}-${lastLine} of ${totalLines}. Use offset=${lastLine + 1} to continue.]` : "";
			return result(truncation.content + continuation, { truncation, totalLines });
		}),
	});
	const write = createWriteToolDefinition(GUEST_WORKSPACE, { operations: {
		writeFile: (_file, content) => files.write(targetPath, content),
		mkdir: (_file) => files.mkdir(path.posix.dirname(targetPath)),
	} });
	const edit = createEditToolDefinition(GUEST_WORKSPACE, { operations: {
		readFile,
		writeFile: (_file, content) => files.write(targetPath, content),
		// Do not decide guest writability from host metadata: readonly targets
		// must fall through to the guest uid/mode check in write(), not bypass it.
		access: async (_file) => { await files.stat(targetPath); },
	} });
	const guard = (tool: ToolDefinition): ToolDefinition => ({
		...tool,
		execute: (...args) => manager.exclusive(async () => {
			files = await manager.files();
			args[2]?.throwIfAborted();
			// Pi supplies the HOST cwd through ExtensionContext even when the tool
			// factory was created with the guest home. Override it before path resolution.
			const input = args[1] as { path: string };
			targetPath = guestPath(input.path);
			return tool.execute(args[0], { ...input, path: targetPath }, args[2], args[3], { ...args[4], cwd: GUEST_WORKSPACE });
		}),
	});
	const guarded = [guard(write as ToolDefinition), guard(edit as ToolDefinition)];

	const bash = defineTool({
		name: "bash", label: "Sandbox bash",
		description: `Run bash inside your persistent microsandbox VM, cwd ${manager.workspaceDir}. Never runs on the host. Background processes keep the VM alive. Output is capped to the last 64 KiB. Use sandbox_control pin for critical services before launching them.`,
		parameters: Type.Object({ command: Type.String(), timeout: Type.Optional(Type.Number({ minimum: 1, maximum: 3600, description: "Seconds, default 120." })) }),
		execute: async (_id, params, signal, update) => manager.exclusive(async () => {
			const output = await manager.execute(params.command, (params.timeout ?? 120) * 1000, signal,
				(data) => update?.(result(data.toString("utf8"))));
			return result(`${output.text}${output.truncated ? "\n[Output truncated to last 64 KiB]" : ""}\n[exit ${output.code}]`, { exitCode: output.code, truncated: output.truncated });
		}),
	});

	const ls = defineTool({
		name: "ls", label: "Sandbox directory",
		description: "List guest directory entries with kind and size, without booting a stopped VM for ordinary workspace paths. Does not follow directory symlinks.",
		parameters: Type.Object({ path: Type.Optional(Type.String()), limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 10000 })) }),
		execute: async (_id, params, signal) => manager.exclusive(async () => {
			signal?.throwIfAborted();
			const f = await manager.files();
			const entries = (await f.list(guestPath(params.path ?? "."))).sort((a, b) => a.path.localeCompare(b.path));
			const shown = entries.slice(0, params.limit ?? 500).map(({ path, kind, size }) => ({ path, kind, size }));
			return result(shown.map((e) => `${e.kind} ${e.size}\t${e.path}`).join("\n")
				+ (shown.length < entries.length ? "\n[Entries truncated]" : ""), { total: entries.length, entries: shown });
		}),
	});

	const searchTools = ["find", "grep"].map((name) => defineTool({
		name, label: `Sandbox ${name}`,
		description: name === "find"
			? "Find workspace files by glob (** supported), without following symlinks. Bounded to 10000 visited entries and 64 KiB output."
			: "Search file contents for a literal string (not regex). Supports glob and ignoreCase. Skips symlinks, binaries and oversized files. Bounded traversal and output; no host subprocess.",
		parameters: Type.Object({
			pattern: Type.String({ description: name === "find" ? "Relative glob, e.g. **/*.ts" : "Literal text to search for" }),
			path: Type.Optional(Type.String()), glob: Type.Optional(Type.String()),
			ignoreCase: Type.Optional(Type.Boolean()), limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 2000 })),
		}),
		execute: async (_id, params, signal) => manager.exclusive(async () => {
			const f = await manager.files();
			const root = guestPath(params.path ?? ".");
			const limit = params.limit ?? 100;
			const output: string[] = [];
			let bytes = 0;
			let visited = 0;
			let skipped = 0;
			let readBytes = 0;
			let truncated = false;
			const queue = [root];
			const rootMeta = await f.stat(root);
			const candidates: string[] = rootMeta.kind === "file" ? [root] : [];
			if (rootMeta.kind === "file") queue.length = 0;
			if (rootMeta.kind !== "file" && rootMeta.kind !== "directory") throw new Error("Search root must be a regular file or directory");
			while (queue.length || candidates.length) {
				signal?.throwIfAborted();
				if (output.length >= limit || visited >= 10000 || bytes >= 64 * 1024) { truncated = true; break; }
				if (!candidates.length) {
					const directory = queue.shift()!;
					for (const e of await f.list(directory)) {
						if (++visited > 10000) { truncated = true; break; }
						const file = path.posix.join(directory, e.path);
						if (e.kind === "directory") queue.push(file);
						else if (e.kind === "file") candidates.push(file);
					}
					continue;
				}
				const file = candidates.shift()!;
				const relative = path.posix.relative(root, file) || path.posix.basename(file);
				const glob = name === "find" ? params.pattern : params.glob;
				if (glob && !path.posix.matchesGlob(relative, glob)) continue;
				if (name === "find") { output.push(relative); bytes += Buffer.byteLength(relative) + 1; continue; }
				const meta = await f.stat(file);
				if (meta.size > manager.config.maxFileBytes || meta.kind !== "file") { skipped++; continue; }
				if (readBytes + meta.size > 32 * 1024 * 1024) { truncated = true; break; }
				const content = await f.read(file);
				readBytes += content.length;
				if (content.includes(0)) { skipped++; continue; }
				const needle = params.ignoreCase ? params.pattern.toLowerCase() : params.pattern;
				const text = content.toString("utf8");
				let start = 0;
				let lineNumber = 0;
				while (start <= text.length) {
					const newline = text.indexOf("\n", start);
					const end = newline < 0 ? text.length : newline;
					const source = text.slice(start, end);
					lineNumber++;
					if ((params.ignoreCase ? source.toLowerCase() : source).includes(needle)) {
						const line = `${relative}:${lineNumber}:${source.slice(0, 2000)}`;
						output.push(line); bytes += Buffer.byteLength(line) + 1;
						if (output.length >= limit || bytes >= 64 * 1024) { truncated = true; break; }
					}
					if (newline < 0) break;
					start = end + 1;
				}
			}
			return result(output.join("\n") + (truncated ? "\n[Search truncated]" : "") + (skipped ? `\n[Skipped ${skipped} binary/oversized files]` : ""), { visited, skipped, readBytes, truncated });
		}),
	}));

	const fileTool = defineTool({
		name: "file", label: "Sandbox file metadata",
		description: "Inspect authoritative guest file metadata/permissions (stat boots VM), get a SHA-256 digest, or create directories. Hash/mkdir on ordinary private workspace paths can stay offline. Guest metadata cannot be inferred from backing volume modes: microsandbox virtualizes permissions.",
		parameters: Type.Object({ action: Type.Union([Type.Literal("stat"), Type.Literal("hash"), Type.Literal("mkdir")]), path: Type.String() }),
		execute: async (_id, params, signal) => manager.exclusive(async () => {
			signal?.throwIfAborted();
			const f = await manager.files(params.action === "stat");
			const p = guestPath(params.path);
			if (params.action === "mkdir") { await f.mkdir(p); return result(`Created ${p}`); }
			if (params.action === "hash") {
				const hash = createHash("sha256").update(await f.read(p)).digest("hex");
				return result(hash, { path: p, sha256: hash });
			}
			const meta = await f.stat(p);
			const authoritative = { ...meta, modeOctal: (meta.mode & 0o7777).toString(8), metadataSource: "guest" };
			return result(JSON.stringify(authoritative), authoritative);
		}),
	});

	const control = defineTool({
		name: "sandbox_control", label: "Sandbox lifecycle",
		description: "Inspect VM state without booting it, or pin/unpin a durable sleep hold. Pin BEFORE starting critical Docker/services/watchers. Holds survive context resets and restarts; unpin by key when no longer needed. No force-stop capability.",
		parameters: Type.Object({ action: Type.Union([Type.Literal("status"), Type.Literal("pin"), Type.Literal("unpin")]), key: Type.Optional(Type.String()), reason: Type.Optional(Type.String()) }),
		execute: async (_id, params) => {
			const status = await manager.control(params.action, params.key, params.reason);
			return result(JSON.stringify(status, null, 2), status);
		},
	});
	const githubAuth = loaded ? createGitHubAuthTool(manager, loaded) : undefined;
	const githubApi = loaded ? createGitHubApiTool(loaded) : undefined;
	return [read, ...guarded, bash, ls, ...searchTools, fileTool, control, ...(githubAuth ? [githubAuth] : []), ...(githubApi ? [githubApi] : [])] as ToolDefinition[];
}
