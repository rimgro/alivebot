import type { AgentToolResult, ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type, type TSchema } from "typebox";
import * as fs from "node:fs";
import * as path from "node:path";
import { pathToFileURL } from "node:url";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

interface ToolRecord {
	name: string;
	description: string;
	parameters: Record<string, unknown>;
	file: string;
}

const execFileAsync = promisify(execFile);

export default function toolboxExtension(pi: ExtensionAPI): void {
	const root = process.env.ALIVE_TOOLS_DIR ?? path.resolve(import.meta.dirname, "../../tools");
	const registryPath = path.join(root, "registry.json");
	const allowedTools = new Set<string>(parseAllowedTools(process.env.ALIVE_TOOL_ALLOWLIST));
	fs.mkdirSync(root, { recursive: true });

	const readRegistry = (): ToolRecord[] => {
		try {
			const parsed = JSON.parse(fs.readFileSync(registryPath, "utf8")) as unknown;
			if (!Array.isArray(parsed)) return [];
			return parsed.filter(isToolRecord);
		} catch {
			return [];
		}
	};
	const writeRegistry = (records: ToolRecord[]) => atomicWrite(registryPath, `${JSON.stringify(records, null, 2)}\n`);
	const safeName = (name: string): string => {
		if (!/^[a-zA-Z][a-zA-Z0-9_-]{0,63}$/.test(name)) {
			throw new Error("Tool name must start with a letter and contain only letters, digits, '_' or '-'.");
		}
		return name;
	};

	const register = (record: ToolRecord): void => {
		if (!allowedTools.has(record.name)) return;
		if (pi.getAllTools().some((tool) => tool.name === record.name)) {
			throw new Error(`A tool named '${record.name}' is already registered.`);
		}
		pi.registerTool({
			name: record.name,
			label: record.name,
			description: record.description,
			promptSnippet: record.description,
			parameters: Type.Unsafe(record.parameters as TSchema),
			async execute(toolCallId, params, signal) {
				const moduleUrl = `${pathToFileURL(path.join(root, record.file)).href}?v=${Date.now()}`;
				const loaded = await import(moduleUrl) as { default?: unknown; execute?: unknown };
				const implementation = loaded.default ?? loaded.execute;
				if (typeof implementation !== "function") {
					throw new Error(`Tool '${record.name}' must export a default function (or named execute function).`);
				}
				const result: unknown = await implementation(params, { signal, toolCallId });
				if (isAgentToolResult(result)) return result;
				const text = typeof result === "string" ? result : JSON.stringify(result ?? null, null, 2);
				return { content: [{ type: "text" as const, text }], details: { tool: record.name } };
			},
		});
	};

	const createSchema = Type.Object({
		action: Type.Union([Type.Literal("create"), Type.Literal("install"), Type.Literal("list"), Type.Literal("remove")]),
		name: Type.Optional(Type.String({ description: "Unique tool name, e.g. weather_lookup." })),
		description: Type.Optional(Type.String()),
		parameters: Type.Optional(Type.Unknown({ description: "JSON Schema object for this tool's arguments." })),
		code: Type.Optional(Type.String({ description: "ES module exporting default async function(params, {signal, toolCallId}). Return a string, JSON value, or AgentToolResult." })),
		package: Type.Optional(Type.String({ description: "Trusted npm package name/version to install under .alive/tools." })),
	});

	pi.registerTool({
		name: "tool_registry",
		label: "Create and manage tools",
		description:
			"Create tools that register directly in your tool list under their own names, install npm dependencies, list, and remove tools. " +
			"New tools become callable immediately in this session and persist across restarts. Tool code executes with Alive's full permissions; only use trusted code and packages.",
		promptSnippet: "Create, install, list, or remove directly registered named tools",
		parameters: createSchema,
		async execute(_toolCallId, params) {
			if (!allowedTools.has("tool_registry")) throw new Error("tool_registry is not allowed for this profile");
			const records = readRegistry();
			switch (params.action) {
				case "list":
					return textResult(records.length
						? records.map((record) => `- ${record.name}: ${record.description}`).join("\n")
						: "No custom tools registered.", { tools: records });
				case "create": {
					const name = safeName(params.name ?? "");
					if (!allowedTools.has(name)) throw new Error(`Tool '${name}' is not in this profile's tool allowlist.`);
					if (records.some((record) => record.name === name) || pi.getAllTools().some((tool) => tool.name === name)) {
						throw new Error(`Tool '${name}' already exists; names must be unique.`);
					}
					if (typeof params.code !== "string" || !params.code.trim()) throw new Error("code is required");
					if (params.code.length > 100_000) throw new Error("Tool source exceeds 100 KB.");
					const parameters = params.parameters;
					if (!parameters || typeof parameters !== "object" || Array.isArray(parameters) || (parameters as Record<string, unknown>).type !== "object") {
						throw new Error("parameters must be a JSON Schema object with type='object'.");
					}
					const record: ToolRecord = {
						name,
						description: params.description?.trim() || `Custom tool ${name}`,
						parameters: parameters as Record<string, unknown>,
						file: `${name}.mjs`,
					};
					const filePath = path.join(root, record.file);
					atomicWrite(filePath, params.code);
					try {
						writeRegistry([...records, record]);
						register(record);
						if (allowedTools.has(name)) pi.setActiveTools([...new Set([...pi.getActiveTools(), name])]);
					} catch (error) {
						fs.rmSync(filePath, { force: true });
						writeRegistry(records);
						throw error;
					}
					return textResult(`Registered '${name}' as a native tool. It is available now under its own name.`, { name });
				}
				case "install": {
					const packageName = params.package?.trim();
					if (!packageName || !/^(?:@[a-zA-Z0-9._-]+\/)?[a-zA-Z0-9][a-zA-Z0-9._-]*(?:@[a-zA-Z0-9.*^~<>=|+-]+)?$/.test(packageName)) {
						throw new Error("package must be an npm package name, optionally with a version");
					}
					const { stdout, stderr } = await execFileAsync("npm", ["install", "--prefix", root, "--", packageName], {
						timeout: 120_000,
						maxBuffer: 1_000_000,
					});
					return textResult(`Installed ${packageName}. It can now be imported by custom tools.\n${stdout}${stderr}`, { package: packageName });
				}
				case "remove": {
					const name = safeName(params.name ?? "");
					const index = records.findIndex((record) => record.name === name);
					if (index < 0) throw new Error(`No custom tool named '${name}'.`);
					const next = records.filter((record) => record.name !== name);
					writeRegistry(next);
					fs.rmSync(path.join(root, records[index]!.file), { force: true });
					pi.setActiveTools(pi.getActiveTools().filter((toolName) => toolName !== name));
					return textResult(`Removed '${name}' from the registry.`, { name });
				}
			}
		},
	});

	for (const record of readRegistry()) {
		try {
			safeName(record.name);
			register(record);
		} catch (error) {
			console.error(`[alive toolbox] Could not register '${record.name}': ${error instanceof Error ? error.message : String(error)}`);
		}
	}
}

function parseAllowedTools(value: string | undefined): string[] {
	if (!value) return [];
	try {
		const parsed = JSON.parse(value) as unknown;
		return Array.isArray(parsed) ? parsed.filter((name): name is string => typeof name === "string") : [];
	} catch {
		return [];
	}
}

function atomicWrite(file: string, value: string): void {
	fs.mkdirSync(path.dirname(file), { recursive: true });
	const temporary = `${file}.${process.pid}.${Date.now()}.tmp`;
	fs.writeFileSync(temporary, value, "utf8");
	fs.renameSync(temporary, file);
}

function isToolRecord(value: unknown): value is ToolRecord {
	if (!value || typeof value !== "object") return false;
	const record = value as Partial<ToolRecord>;
	return typeof record.name === "string" && typeof record.description === "string" &&
		typeof record.file === "string" && typeof record.parameters === "object" && record.parameters !== null;
}

function isAgentToolResult(value: unknown): value is AgentToolResult<unknown> {
	return typeof value === "object" && value !== null && Array.isArray((value as { content?: unknown }).content);
}

function textResult(text: string, details: Record<string, unknown> = {}) {
	return { content: [{ type: "text" as const, text }], details };
}
