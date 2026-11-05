/**
 * Compact tool catalog (#69).
 *
 *   npx tsx src/dev/compact-catalog-test.ts
 *
 * Filesystem-only config fixtures plus an injected bridge: no model, no VM, no
 * network. The bridge is exactly what session.ts fills after createAgentSession,
 * so find_tool/use_tool exercise their real code paths without pi's registry.
 */
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { Type } from "typebox";
import { defineTool, type AgentToolResult, type ToolDefinition } from "@earendil-works/pi-coding-agent";
import {
	DEFAULT_COMPACT_KEEP_TOOLS,
	DEFAULT_CONFIG,
	loadConfig,
	type LoadedConfig,
} from "../config.js";
import { Logger } from "../log.js";
import { buildSystemPrompt } from "../runtime/prompt.js";
import { compactActiveTools, selectAllowedTools } from "../runtime/session.js";
import {
	ALIVE_TOOL_NAMES,
	createAliveTools,
	parseToolArguments,
	rankHiddenTools,
	type CompactToolBridge,
	type CompactToolDefinition,
	type ToolDeps,
} from "../runtime/tools.js";

let failures = 0;

function check(name: string, condition: boolean, detail?: unknown): void {
	if (condition) {
		process.stdout.write(`  ok    ${name}\n`);
		return;
	}
	failures += 1;
	process.stdout.write(`  FAIL  ${name}${detail === undefined ? "" : ` — ${JSON.stringify(detail)}`}\n`);
}

function section(name: string): void {
	process.stdout.write(`\n${name}\n`);
}

const root = fs.mkdtempSync(path.join(os.tmpdir(), "alive-compact-catalog-"));

function writeConfig(value: unknown): void {
	fs.writeFileSync(path.join(root, "alive.config.json"), `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

function load(value: unknown): LoadedConfig {
	writeConfig(value);
	return loadConfig({
		cwd: root,
		secretLog: () => undefined,
		secretWarn: () => undefined,
		configWarn: () => undefined,
		migrateSecrets: false,
	});
}

function promptBase() {
	return {
		name: "Compact Test",
		soul: "Test soul.",
		contract: "Test contract.",
		workspace: "/tmp/workspace",
		stateDir: "/tmp/state",
		runTimeoutMs: 0,
		runWarnMs: 0,
		sleepAfterMs: 60_000,
	};
}

/** The same candidate selection buildAgent performs, without opening a session. */
function fullAllowedTools(loaded: LoadedConfig): string[] {
	return selectAllowedTools({
		allowlist: [...loaded.config.tools.allowlist],
		builtins: loaded.config.tools.builtin,
		alive: [...ALIVE_TOOL_NAMES],
		modules: [],
		sandbox: [],
		custom: [],
		toolRegistryAvailable: true,
	});
}

function fakeDeps(loaded: LoadedConfig, bridge?: CompactToolBridge): ToolDeps {
	return {
		config: loaded,
		moduleTools: [],
		compactBridge: bridge,
		log: new Logger({ console: false, level: "error", scope: "compact-catalog-test" }),
		getRun: () => undefined,
		runtimeStatus: () => ({}),
		isStopping: () => false,
	} as unknown as ToolDeps;
}

function toolText(result: AgentToolResult<unknown>): string {
	return result.content
		.map((entry) => (entry.type === "text" ? entry.text : ""))
		.join("\n");
}

async function runTool(tool: ToolDefinition, params: unknown): Promise<AgentToolResult<unknown>> {
	return tool.execute("compact_test_call", params as never, undefined, undefined, {} as never);
}

async function rejects(promise: Promise<unknown>, pattern: RegExp): Promise<boolean> {
	try {
		await promise;
		return false;
	} catch (error) {
		return pattern.test(error instanceof Error ? error.message : String(error));
	}
}

try {
	// -----------------------------------------------------------------------
	section("config: the flag is opt-in and old files keep working");
	{
		const off = load({ tools: {} });
		check("absent fields default to compactCatalog=false", off.config.tools.compactCatalog === false, off.config.tools);
		check(
			"the default keep list is available without a config field",
			JSON.stringify(off.config.tools.compactKeep) === JSON.stringify([...DEFAULT_COMPACT_KEEP_TOOLS]),
			off.config.tools.compactKeep,
		);
		check(
			"the default allowlist is untouched when the mode is off",
			!off.config.tools.allowlist.includes("find_tool") && !off.config.tools.allowlist.includes("use_tool"),
			off.config.tools.allowlist,
		);

		const on = load({ tools: { compactCatalog: true, compactKeep: ["read", " idle ", "read"] } });
		check("compactCatalog=true survives loadConfig", on.config.tools.compactCatalog === true, on.config.tools);
		check(
			"compactKeep entries are trimmed and de-duplicated",
			JSON.stringify(on.config.tools.compactKeep) === JSON.stringify(["read", "idle"]),
			on.config.tools.compactKeep,
		);
		check(
			"enabling the mode grants the two dispatchers",
			on.config.tools.allowlist.includes("find_tool") && on.config.tools.allowlist.includes("use_tool"),
			on.config.tools.allowlist,
		);

		let malformed = "";
		try {
			load({ tools: { compactCatalog: "yes" } });
		} catch (error) {
			malformed = error instanceof Error ? error.message : String(error);
		}
		check("a malformed flag is rejected with a clear message", /tools\.compactCatalog must be a boolean/.test(malformed), malformed);

		// DEFAULT_CONFIG is the template `alive init` writes; it must not turn the
		// feature on by accident.
		check("DEFAULT_CONFIG explicitly disables the mode", DEFAULT_CONFIG.tools.compactCatalog === false);
	}

	// -----------------------------------------------------------------------
	section("active sets: compact is a subset and keeps the dispatchers");
	const off = load({ tools: {} });
	const on = load({
		tools: {
			compactCatalog: true,
			// calendar is the hidden tool the bridge exposes in this test; a real
			// hidden tool is always on the profile allowlist.
			allowlist: [...DEFAULT_CONFIG.tools.allowlist, "calendar"],
		},
	});
	const full = fullAllowedTools(off);
	const compactFull = fullAllowedTools(on);
	const compact = compactActiveTools({ allowed: compactFull, keep: on.config.tools.compactKeep });
	{
		check("the full set is non-trivial", full.length > 10, full.length);
		check("the compact set is not larger than the full set", compact.length <= compactFull.length, {
			compact: compact.length,
			full: compactFull.length,
		});
		check("every compact tool is in the full set", compact.every((name) => compactFull.includes(name)), compact);
		check("find_tool and use_tool are active", compact.includes("find_tool") && compact.includes("use_tool"), compact);
		check(
			"the conversational core stays direct",
			["idle", "sleep", "send_message", "read", "write", "edit", "bash", "grep", "find", "ls"].every((name) =>
				compact.includes(name),
			),
			compact,
		);
		check(
			"large optional tools become hidden",
			["browser", "web_search", "history", "dashboard", "remind", "notifications"].every((name) => !compact.includes(name)),
			compact,
		);
		check(
			"a keep entry outside the allowlist is dropped rather than activated",
			!compactActiveTools({ allowed: ["read", "find_tool", "use_tool"], keep: ["browser", "read"] }).includes("browser"),
		);
	}

	// -----------------------------------------------------------------------
	section("prompt: a short table of contents appears only in compact mode");
	{
		const hidden = [
			{ name: "browser", description: "Drive a browser for the requesting conversation." },
			{ name: "history", description: "Read the durable cross-sleep conversation history." },
		];
		const base = promptBase();
		const plain = buildSystemPrompt(base);
		const compactPrompt = buildSystemPrompt({ ...base, compactCatalog: hidden });
		check("the default prompt has no compact section", !plain.includes("Оглавление инструментов"));
		check(
			"the compact prompt names the section and the workflow",
			compactPrompt.includes("Оглавление инструментов") &&
				compactPrompt.includes("find_tool") &&
				compactPrompt.includes("use_tool"),
		);
		check(
			"the table has one line per hidden tool",
			compactPrompt.includes("- browser — Drive a browser") && compactPrompt.includes("- history — Read the durable"),
		);
		check("the table does not carry JSON schemas", !compactPrompt.includes("\"type\": \"object\""));
		check(
			"the compact section only adds text and is much smaller than a catalogue",
			compactPrompt.length > plain.length && compactPrompt.length - plain.length < 1_500,
			compactPrompt.length - plain.length,
		);
	}

	// -----------------------------------------------------------------------
	section("dispatchers are registered only in compact mode");
	const hiddenTool = defineTool({
		name: "calendar",
		label: "Calendar",
		description: "Create and list calendar events for the team.",
		parameters: Type.Object({
			title: Type.String({ description: "Event title." }),
			when: Type.Optional(Type.String({ description: "ISO time, optional." })),
		}),
		execute: async (_id, params): Promise<AgentToolResult<Record<string, unknown>>> => ({
			content: [{ type: "text", text: `calendar created: ${params.title}` }],
			details: { title: params.title },
		}),
	});
	const calls: Array<{ name: string; args: Record<string, unknown> }> = [];
	const bridge: CompactToolBridge = {
		hidden: () => [hiddenTool as unknown as CompactToolDefinition],
		execute: async (name, args, signal) => {
			calls.push({ name, args });
			if (name !== "calendar") throw new Error(`unexpected tool ${name}`);
			return hiddenTool.execute("bridged_call", args as never, signal, undefined, {} as never);
		},
	};
	const disabledTools = createAliveTools(fakeDeps(off));
	const enabledTools = createAliveTools(fakeDeps(on, bridge));
	{
		check(
			"the disabled mode registers no find_tool/use_tool",
			!disabledTools.some((tool) => tool.name === "find_tool" || tool.name === "use_tool"),
		);
		check(
			"the compact mode registers both dispatchers",
			["find_tool", "use_tool"].every((name) => enabledTools.some((tool) => tool.name === name)),
			enabledTools.map((tool) => tool.name),
		);
	}

	// -----------------------------------------------------------------------
	section("find_tool ranks name/description/schema hits and returns full schemas");
	{
		const extra: CompactToolDefinition[] = [
			...bridge.hidden!(),
			{
				name: "browser",
				description: "Drive a browser for the requesting conversation.",
				parameters: Type.Object({ action: Type.String() }),
				execute: async () => ({ content: [], details: {} }),
			},
			{
				name: "browser_share",
				description: "Share a browser page with a human.",
				parameters: Type.Object({ thread: Type.String() }),
				execute: async () => ({ content: [], details: {} }),
			},
		];
		check("a name hit wins over a description hit", rankHiddenTools("browser", extra)[0]?.name === "browser", rankHiddenTools("browser", extra).map((t) => t.name));
		check(
			"a word-start hit wins inside a longer name",
			rankHiddenTools("share", extra)[0]?.name === "browser_share",
			rankHiddenTools("share", extra).map((t) => t.name),
		);
		check(
			"a multi-word query falls back to separate words",
			rankHiddenTools("share browser", extra)[0]?.name === "browser_share",
			rankHiddenTools("share browser", extra).map((t) => t.name),
		);
		check("the limit is three", rankHiddenTools("calendar browser share tool", extra, 3).length === 3);
		check("an empty query matches nothing", rankHiddenTools("   ", extra).length === 0);

		const findTool = enabledTools.find((tool) => tool.name === "find_tool")!;
		const match = await runTool(findTool, { query: "calendar" });
		const matchText = toolText(match);
		check("find_tool returns the tool name", matchText.includes("calendar"), matchText);
		check("find_tool returns the description", matchText.includes("Create and list calendar events"), matchText);
		check(
			"find_tool returns the full parameter schema",
			matchText.includes("\"title\"") && matchText.includes("\"Event title.\""),
			matchText,
		);
		check("find_tool points at use_tool", matchText.includes("use_tool({ name, arguments })"), matchText);

		const none = await runTool(findTool, { query: "definitely-nowhere" });
		check("no match is short and suggests a broader word", /no match/.test(toolText(none)) && /broader word/.test(toolText(none)), toolText(none));
	}

	// -----------------------------------------------------------------------
	section("use_tool calls through the bridge, with clear refusals");
	{
		const useTool = enabledTools.find((tool) => tool.name === "use_tool")!;

		const fromString = await runTool(useTool, { name: "calendar", arguments: "{\"title\":\"standup\"}" });
		check("a JSON-string argument is parsed", toolText(fromString).includes("standup"), toolText(fromString));
		check("the bridge receives the parsed object", calls.at(-1)?.args.title === "standup", calls.at(-1));

		const fromObject = await runTool(useTool, { name: "calendar", arguments: { title: "retro" } });
		check("an object argument passes through", toolText(fromObject).includes("retro"), toolText(fromObject));

		check(
			"a name outside the allowlist is refused before execution",
			await rejects(runTool(useTool, { name: "not_in_allowlist", arguments: {} }), /not in tools\.allowlist/),
		);
		check(
			"the dispatchers cannot be called recursively",
			await rejects(runTool(useTool, { name: "find_tool", arguments: { query: "x" } }), /cannot be called through use_tool/),
		);
		check(
			"an unregistered name is refused",
			await rejects(runTool(useTool, { name: "read", arguments: {} }), /not a hidden tool/),
		);
		check(
			"broken JSON is a clear error",
			await rejects(runTool(useTool, { name: "calendar", arguments: "{oops" }), /not valid JSON/),
		);
		check("the bridge is not called for a refused name", calls.at(-1)?.args.title !== "retro" || calls.length < 5, calls);
	}

	// -----------------------------------------------------------------------
	section("argument parsing is shared and strict");
	{
		check("undefined becomes an empty object", JSON.stringify(parseToolArguments(undefined)) === "{}");
		check("an empty string becomes an empty object", JSON.stringify(parseToolArguments("  ")) === "{}");
		check("arrays are rejected", (() => {
			try {
				parseToolArguments("[1,2]");
				return false;
			} catch (error) {
				return /JSON object|object or a JSON object string/.test(error instanceof Error ? error.message : "");
			}
		})());
	}

	// -----------------------------------------------------------------------
	section("disabled flag changes nothing observable");
	{
		const disabled = load({ tools: { compactCatalog: false } });
		const disabledFull = fullAllowedTools(disabled);
		check(
			"the active set equals the full allowlisted set",
			JSON.stringify(disabledFull) === JSON.stringify(fullAllowedTools(off)),
		);
		check("no dispatchers are granted by the loader", !disabled.config.tools.allowlist.some((name) => name === "find_tool" || name === "use_tool"));
		check(
			"the prompt stays the plain one",
			!buildSystemPrompt(promptBase()).includes("Оглавление инструментов") &&
				!buildSystemPrompt(promptBase()).includes("use_tool({ name, arguments })"),
		);
		check("the disabled tool list has no dispatchers", !disabledTools.some((tool) => tool.name.endsWith("_tool")));
	}
} finally {
	fs.rmSync(root, { recursive: true, force: true });
}

process.stdout.write(`\n${failures === 0 ? "all compact catalog tests passed" : `${failures} compact catalog test(s) failed`}\n`);
process.exitCode = failures === 0 ? 0 : 1;
