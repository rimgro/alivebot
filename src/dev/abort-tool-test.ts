/**
 * Operator abort of the current tool (#164).
 *
 *   npx tsx src/dev/abort-tool-test.ts
 *
 * Filesystem and in-process fixtures only: no model, no VM, no network. The
 * fake tool blocks on its AbortSignal exactly like `SandboxManager.execute`
 * does, so the test exercises the real wrapper, flag consumption, TTL and the
 * exact agent-visible error.
 */
import { spawn } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { main } from "../cli.js";
import { Logger } from "../log.js";
import { Journal } from "../store/journal.js";
import {
	TOOL_ABORT_TTL_MS,
	ToolAbortGate,
	clearToolAbortRequest,
	parseAbortToolCommand,
	readToolAbortRequest,
	toolAbortRequestPath,
	writeToolAbortRequest,
} from "../runtime/tool-abort.js";
import { sleep } from "../util.js";

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

async function waitForFile(file: string, timeoutMs = 5_000): Promise<boolean> {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		if (fs.existsSync(file)) return true;
		await sleep(25);
	}
	return false;
}

const root = fs.mkdtempSync(path.join(os.tmpdir(), "alive-abort-tool-test-"));
const stateDir = path.join(root, "state");
const log = new Logger({ console: false, level: "error", scope: "abort-tool-test" });
const journal = new Journal(stateDir);

section("abort-tool marker: one-shot, TTL-bound, run-bound");
{
	const request = writeToolAbortRequest(stateDir, { source: "dashboard", by: "dashboard", runId: "run_1", at: 1_000 });
	check("the marker is written with source/by/run id", request.source === "dashboard" && request.by === "dashboard" && request.runId === "run_1");
	const read = readToolAbortRequest(stateDir, { now: 1_100, runId: "run_1" });
	check("a fresh matching marker is returned", read?.source === "dashboard" && read.runId === "run_1", read);
	check("reading consumes the marker", !fs.existsSync(toolAbortRequestPath(stateDir)));
	check("a consumed marker is not returned twice", readToolAbortRequest(stateDir, { now: 1_200 }) === undefined);

	writeToolAbortRequest(stateDir, { source: "cli", at: 1_000 });
	check(
		"a marker older than the TTL is ignored",
		readToolAbortRequest(stateDir, { now: 1_000 + TOOL_ABORT_TTL_MS }) === undefined,
	);
	check("the stale marker is deleted", !fs.existsSync(toolAbortRequestPath(stateDir)));

	writeToolAbortRequest(stateDir, { source: "telegram", runId: "run_a", at: 2_000 });
	check(
		"a marker for another run is ignored",
		readToolAbortRequest(stateDir, { now: 2_100, runId: "run_b" }) === undefined,
	);
	check("the wrong-run marker is deleted", !fs.existsSync(toolAbortRequestPath(stateDir)));

	writeToolAbortRequest(stateDir, { source: "cli", at: 3_000 });
	check(
		"a marker without a run id applies to the current run",
		readToolAbortRequest(stateDir, { now: 3_100, runId: "run_any" })?.source === "cli",
	);
	clearToolAbortRequest(stateDir);
}

section("the gate aborts exactly the running tool and returns the agent-visible error");
{
	const gate = new ToolAbortGate({
		stateDir,
		log,
		journal,
		currentRunId: () => "run_abort",
		now: () => 10_000,
	});
	const seen = { aborted: false };
	const tool = gate.wrapTool({
		name: "bash",
		execute: async (_id: string, _params: unknown, signal?: AbortSignal) => new Promise<string>((_resolve, reject) => {
			const abort = () => {
				seen.aborted = true;
				reject(new Error("the guest command was killed"));
			};
			if (signal?.aborted) {
				abort();
				return;
			}
			signal?.addEventListener("abort", abort, { once: true });
		}),
	});
	const running = tool.execute("call_1", { command: "sleep 600" });
	check("the gate reports the active tool", gate.activeTool()?.name === "bash" && gate.activeTool()?.runId === "run_abort", gate.activeTool());
	writeToolAbortRequest(stateDir, { source: "telegram", by: "telegram:42", runId: "run_abort" });
	const decision = gate.check(10_500);
	check("check() accepts the matching request", decision.kind === "aborted" && decision.tool.name === "bash", decision);
	let error: unknown;
	try {
		await running;
	} catch (caught) {
		error = caught;
	}
	check("the tool is actually aborted", seen.aborted);
	check(
		"the agent receives exactly the operator-abort tool error",
		error instanceof Error && error.message === "aborted by operator: tool bash",
		error instanceof Error ? error.message : error,
	);
	check("the active tool is cleared after the abort", gate.activeTool() === undefined);
	check("the marker was consumed", !fs.existsSync(toolAbortRequestPath(stateDir)));
	check(
		"the journal records tool, duration and initiator",
		journal.tail(5).some((line) => line.includes("[abort-tool] bash") && line.includes("telegram:42")),
		journal.tail(5),
	);
	check("a second check does nothing", gate.check(10_600).kind === "none");
}

section("agent tool wrapping: every active tool is wrapped once");
{
	const gate = new ToolAbortGate({ stateDir, log, currentRunId: () => "run_3" });
	const fake = { name: "read", execute: async () => "ok" };
	const agent = { state: { tools: [fake as { name: string; execute: (...args: any[]) => Promise<any> }] } };
	gate.wrapAgent(agent);
	check("wrapAgent replaces the active tool with an abortable wrapper", agent.state.tools[0] !== fake);
	const once = agent.state.tools[0];
	gate.wrapAgent(agent);
	check("re-wrapping the same agent is idempotent", agent.state.tools[0] === once);
	check("the wrapped tool still returns its result", (await once.execute("call_3", {})) === "ok");
}

section("no request means no abort; a request without an active tool is ignored");
{
	const gate = new ToolAbortGate({ stateDir, log, journal, currentRunId: () => "run_2", now: () => 20_000 });
	const tool = gate.wrapTool({ name: "read", execute: async () => "ok" });
	check("a tool completes normally without a request", (await (tool.execute as unknown as (id: string, params: unknown) => Promise<string>)("call_2", {})) === "ok");
	writeToolAbortRequest(stateDir, { source: "dashboard", runId: "run_2" });
	const ignored = gate.check(20_100);
	check("a request with no running tool is ignored", ignored.kind === "ignored" && ignored.reason === "no-active-tool", ignored);
	check("the ignored request is consumed, not left for a later tool", !fs.existsSync(toolAbortRequestPath(stateDir)));
}

section("Telegram command parser");
{
	check("/abort_tool is recognized", parseAbortToolCommand("/abort_tool"));
	check("/abort-tool is recognized", parseAbortToolCommand("/abort-tool"));
	check("/abort_tool@bot is recognized", parseAbortToolCommand("/abort_tool@alive_bot"));
	check("plain text is not a command", !parseAbortToolCommand("please abort_tool"));
	check("a longer command is not matched", !parseAbortToolCommand("/abort_tool_extra"));
}

section("CLI: alive abort-tool <agent> writes the one-shot flag");
{
	const project = fs.mkdtempSync(path.join(root, "cli-"));
	const previous = process.cwd();
	const previousUser = process.env.USER;
	let runtime: ReturnType<typeof spawn> | undefined;
	try {
		process.env.USER = "tester";
		fs.writeFileSync(
			path.join(project, "alive.config.json"),
			`${JSON.stringify({ name: "CLI Test", stateDir: ".alive", sandbox: { enabled: false } }, null, 2)}\n`,
			"utf8",
		);
		fs.mkdirSync(path.join(project, ".alive"), { recursive: true });
		// #212: abort-tool verifies that the pid is this profile's runtime, not
		// merely alive, so the fixture needs a real runtime-shaped process.
		const runtimeMarker = path.join(project, "runtime.ready");
		const runtimeScript = path.join(project, "index.js");
		fs.writeFileSync(
			runtimeScript,
			`require("node:fs").writeFileSync(${JSON.stringify(runtimeMarker)}, "ready");\nsetTimeout(() => {}, 60000);\n`,
			"utf8",
		);
		runtime = spawn(process.execPath, [runtimeScript, "run", "--foreground"], { cwd: project, stdio: "ignore" });
		if (!(await waitForFile(runtimeMarker))) throw new Error("runtime stub never became ready");
		const runtimePid = runtime.pid!;
		fs.writeFileSync(
			path.join(project, ".alive", "runtime.json"),
			`${JSON.stringify({
				pid: runtimePid,
				startedAt: Date.now() - 60_000,
				lastTickAt: Date.now(),
				status: "working",
				runIndex: 1,
				runId: "run_cli",
				pending: 0,
				openThreads: 0,
				sleeps: 0,
				activeTool: { name: "bash", startedAt: Date.now() - 5_000, runId: "run_cli" },
			}, null, 2)}\n`,
			"utf8",
		);
		process.chdir(project);
		const code = await main(["abort-tool", "main"]);
		check("the CLI exits 0 when a tool is running", code === 0, code);
		const flag = readToolAbortRequest(path.join(project, ".alive"), { now: Date.now(), runId: "run_cli" });
		check(
			"the CLI writes a CLI-sourced marker for the live run",
			flag?.source === "cli" && flag.by === "cli:tester" && flag.runId === "run_cli",
			flag,
		);
		clearToolAbortRequest(path.join(project, ".alive"));

		fs.writeFileSync(
			path.join(project, ".alive", "runtime.json"),
			`${JSON.stringify({
				pid: runtimePid,
				startedAt: Date.now() - 60_000,
				lastTickAt: Date.now(),
				status: "working",
				runIndex: 1,
				runId: "run_cli",
				pending: 0,
				openThreads: 0,
				sleeps: 0,
			}, null, 2)}\n`,
			"utf8",
		);
		const noToolCode = await main(["abort-tool", "main"]);
		check("the CLI exits 1 when no tool is running", noToolCode === 1, noToolCode);
		check("no marker is written when no tool is running", !fs.existsSync(toolAbortRequestPath(path.join(project, ".alive"))));
	} finally {
		if (runtime) {
			try {
				process.kill(runtime.pid!, "SIGKILL");
			} catch {
				// already gone
			}
		}
		process.chdir(previous);
		if (previousUser === undefined) delete process.env.USER;
		else process.env.USER = previousUser;
	}
}

fs.rmSync(root, { recursive: true, force: true });
process.stdout.write(`\n${failures === 0 ? "all abort-tool checks passed" : `${failures} abort-tool check(s) failed`}\n`);
process.exit(failures === 0 ? 0 : 1);
