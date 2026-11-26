/**
 * CLI tests for `alive logs [<source>]`: which sink the command actually reads.
 *
 * `alive logs alive` used to ignore the positional source and silently tail the
 * stdout log, while `alive logs --file alive` worked. That is the worst kind of
 * bug for an operator: the command exits 0 and answers a different question
 * than the one asked. The precedence is now
 *   --file > --source > first positional > "alive"
 * and more than one positional is a usage error instead of being dropped.
 *
 * The default is `alive` on purpose (#285): on a systemd deployment the process
 * stdout goes to journald and the stdout file can be a dead leftover from
 * October, so a bare `alive logs` used to answer with another month. `stdout`
 * stays reachable explicitly.
 *
 * Every case runs the real CLI in a child process, so the exit code and the
 * stdout/stderr split are the ones a user would see. The project is a throwaway
 * directory with its own config and state dir; the three sinks are filled with
 * distinct marker lines.
 *
 *   npm run test:cli-logs
 */
import { spawn } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { loadConfig } from "../config.js";
import { renderLogLine, renderLogTime } from "../logs.js";
import { stdoutLogPath } from "../runtime/daemon.js";

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

const entry = fileURLToPath(new URL("../index.ts", import.meta.url));
const repoRoot = path.dirname(path.dirname(entry));

const root = fs.mkdtempSync(path.join(os.tmpdir(), "alive-cli-logs-test-"));
const project = path.join(root, "project");
fs.mkdirSync(project, { recursive: true });
const configPath = path.join(project, "alive.config.json");
fs.writeFileSync(configPath, JSON.stringify({ name: "CliLogs" }), "utf8");

const { paths } = loadConfig({ cwd: project, configPath });
fs.mkdirSync(paths.logsDir, { recursive: true });

const STDOUT_MARKER = "STDOUT_ONLY_MARKER";
const ALIVE_MARKER = "ALIVE_ONLY_MARKER";
const THOUGHTS_MARKER = "THOUGHTS_ONLY_MARKER";

fs.writeFileSync(
	stdoutLogPath(paths),
	[`${STDOUT_MARKER}_1`, `${STDOUT_MARKER}_2`, `${STDOUT_MARKER}_3`].join("\n") + "\n",
	"utf8",
);
fs.writeFileSync(
	paths.logFile,
	[1, 2, 3]
		.map((n) => JSON.stringify({ ts: 1_700_000_000_000 + n, level: "info", scope: "test", msg: `${ALIVE_MARKER}_${n}` }))
		.join("\n") + "\n",
	"utf8",
);
fs.writeFileSync(
	paths.thoughtsFile,
	[1, 2, 3]
		.map((n) => JSON.stringify({ ts: 1_700_000_000_000 + n, runIndex: n, text: `${THOUGHTS_MARKER}_${n}` }))
		.join("\n") + "\n",
	"utf8",
);

interface CliRun {
	code: number | null;
	stdout: string;
	stderr: string;
}

/** Run the real CLI (`logs` subcommand) against the temp project. */
function runLogs(args: string[]): Promise<CliRun> {
	return new Promise((resolve, reject) => {
		const child = spawn(
			process.execPath,
			["--import", "tsx", entry, "logs", ...args, "--config", configPath],
			{ cwd: repoRoot, env: { ...process.env, NO_COLOR: "1" }, stdio: ["ignore", "pipe", "pipe"] },
		);
		let stdout = "";
		let stderr = "";
		child.stdout.on("data", (chunk) => {
			stdout += String(chunk);
		});
		child.stderr.on("data", (chunk) => {
			stderr += String(chunk);
		});
		const timer = setTimeout(() => {
			child.kill("SIGKILL");
			reject(new Error(`alive logs ${args.join(" ")} did not exit within 30s`));
		}, 30_000);
		child.on("error", (err) => {
			clearTimeout(timer);
			reject(err);
		});
		child.on("close", (code) => {
			clearTimeout(timer);
			resolve({ code, stdout, stderr });
		});
	});
}

const has = (text: string, marker: string): boolean => text.includes(marker);

try {
	// -------------------------------------------------------------------------
	section("a positional source is the source that is read");
	{
		const alive = await runLogs(["alive", "-n", "5"]);
		check("`logs alive -n 5` exits 0", alive.code === 0, { code: alive.code, stderr: alive.stderr });
		check("it prints the alive.jsonl lines", has(alive.stdout, `${ALIVE_MARKER}_1`), alive.stdout);
		check("it prints no stdout.log lines", !has(alive.stdout, STDOUT_MARKER), alive.stdout);
	}

	// -------------------------------------------------------------------------
	section("a flag outranks the positional source");
	{
		const fileFlag = await runLogs(["stdout", "-n", "5", "--file", "alive"]);
		check("`logs stdout --file alive` exits 0", fileFlag.code === 0, { code: fileFlag.code, stderr: fileFlag.stderr });
		check("--file wins over the positional", has(fileFlag.stdout, `${ALIVE_MARKER}_1`), fileFlag.stdout);
		check("the positional stdout is not read", !has(fileFlag.stdout, STDOUT_MARKER), fileFlag.stdout);

		const sourceFlag = await runLogs(["stdout", "-n", "5", "--source", "alive"]);
		check("`logs stdout --source alive` exits 0", sourceFlag.code === 0, { code: sourceFlag.code, stderr: sourceFlag.stderr });
		check("--source wins over the positional", has(sourceFlag.stdout, `${ALIVE_MARKER}_1`), sourceFlag.stdout);
		check("the positional stdout is not read with --source", !has(sourceFlag.stdout, STDOUT_MARKER), sourceFlag.stdout);
	}

	// -------------------------------------------------------------------------
	section("the positional and flag forms are byte-identical");
	{
		const byFlag = await runLogs(["--file", "stdout", "-n", "5"]);
		const byPositional = await runLogs(["stdout", "-n", "5"]);
		check("both forms exit 0", byFlag.code === 0 && byPositional.code === 0, {
			flag: byFlag.code,
			positional: byPositional.code,
		});
		check("both read the stdout log", has(byFlag.stdout, STDOUT_MARKER) && has(byPositional.stdout, STDOUT_MARKER), {
			flag: byFlag.stdout,
			positional: byPositional.stdout,
		});
		check("their stdout is identical", byFlag.stdout === byPositional.stdout, {
			flag: byFlag.stdout,
			positional: byPositional.stdout,
		});
	}

	// -------------------------------------------------------------------------
	section("no source at all means the structured log");
	{
		const plain = await runLogs(["-n", "5"]);
		check("`logs -n 5` exits 0", plain.code === 0, { code: plain.code, stderr: plain.stderr });
		check("it reads alive.jsonl by default", has(plain.stdout, ALIVE_MARKER), plain.stdout);
		check("it does not read the stdout file by default", !has(plain.stdout, STDOUT_MARKER), plain.stdout);

		const explicitStdout = await runLogs(["--file", "stdout", "-n", "5"]);
		check("`logs --file stdout` exits 0", explicitStdout.code === 0, { code: explicitStdout.code, stderr: explicitStdout.stderr });
		check("the stdout sink stays reachable explicitly", has(explicitStdout.stdout, STDOUT_MARKER), explicitStdout.stdout);
		check("explicit stdout does not read alive.jsonl", !has(explicitStdout.stdout, ALIVE_MARKER), explicitStdout.stdout);
	}

	// -------------------------------------------------------------------------
	section("a line from another day cannot pass for today's");
	{
		const now = Date.UTC(2026, 10, 26, 16, 57, 7);
		check("today's timestamp is the bare clock", renderLogTime(now, now) === "16:57:07", renderLogTime(now, now));
		const yesterday = renderLogTime(now - 24 * 3600_000, now);
		check("an older timestamp carries its date", yesterday === "25.11 16:57:07", yesterday);
		const older = renderLogTime(now - 40 * 24 * 3600_000, now);
		check("a month-old timestamp carries its date", older === "17.10 16:57:07", older);

		const freshLine = JSON.stringify({ ts: Date.now(), level: "info", msg: `${ALIVE_MARKER}_fresh` });
		check(
			"a rendered line from today starts with the clock only",
			/^\d{2}:\d{2}:\d{2} /.test(renderLogLine("alive", freshLine) ?? ""),
			renderLogLine("alive", freshLine),
		);
		const staleLine = JSON.stringify({ ts: Date.now() - 30 * 24 * 3600_000, level: "info", msg: "stale" });
		check(
			"a rendered line from last month starts with its date",
			/^\d{2}\.\d{2} \d{2}:\d{2}:\d{2} /.test(renderLogLine("alive", staleLine) ?? ""),
			renderLogLine("alive", staleLine),
		);
		const staleThought = JSON.stringify({ ts: Date.now() - 30 * 24 * 3600_000, runIndex: 3, text: "old thought" });
		check(
			"thoughts from another day carry the date too",
			/\[run #3 \d{2}\.\d{2} \d{2}:\d{2}:\d{2}\]/.test(renderLogLine("thoughts", staleThought) ?? ""),
			renderLogLine("thoughts", staleThought),
		);
	}

	// -------------------------------------------------------------------------
	section("an unknown source fails loudly and names the sinks");
	{
		const garbage = await runLogs(["garbage", "-n", "5"]);
		check("`logs garbage` exits 1", garbage.code === 1, { code: garbage.code, stderr: garbage.stderr });
		check("stderr says the source is unknown", garbage.stderr.includes("unknown log source"), garbage.stderr);
		check(
			"stderr lists stdout, alive and thoughts",
			garbage.stderr.includes("stdout") && garbage.stderr.includes("alive") && garbage.stderr.includes("thoughts"),
			garbage.stderr,
		);
		check(
			"stdout carries no log content",
			!has(garbage.stdout, STDOUT_MARKER) && !has(garbage.stdout, ALIVE_MARKER) && !has(garbage.stdout, THOUGHTS_MARKER),
			garbage.stdout,
		);
	}

	// -------------------------------------------------------------------------
	section("more than one positional is a usage error");
	{
		const extra = await runLogs(["alive", "alive", "-n", "5"]);
		check("`logs alive alive` exits 1", extra.code === 1, { code: extra.code, stderr: extra.stderr });
		check("stderr shows the logs usage line", extra.stderr.includes("alive logs"), extra.stderr);
		check(
			"the extra positional is not silently ignored",
			!has(extra.stdout, ALIVE_MARKER) && !has(extra.stdout, STDOUT_MARKER),
			extra.stdout,
		);
	}
} finally {
	fs.rmSync(root, { recursive: true, force: true });
}

process.stdout.write(
	failures === 0 ? "\nALL CLI LOGS TESTS PASSED\n" : `\n${failures} CLI LOGS TEST(S) FAILED\n`,
);
process.exitCode = failures === 0 ? 0 : 1;
