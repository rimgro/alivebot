/**
 * Heartbeat tests: the file an outside watchdog checks, and the
 * `alive heartbeat` command that reads it.
 *
 *   npm run test:heartbeat
 *
 * Everything runs against temp state dirs: no runtime, no model, no network.
 * The interesting failures here are silent ones — a half-written file, a
 * heartbeat that survives a crash as "fresh", a startup hook that throws — so
 * each is exercised explicitly.
 */
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { main } from "../cli.js";
import {
	HEARTBEAT_FILE,
	heartbeatPath,
	readHeartbeat,
	readHeartbeatStatus,
	recordHeartbeat,
	refreshHeartbeat,
	writeHeartbeat,
} from "../heartbeat.js";

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

const packageJson = JSON.parse(
	fs.readFileSync(new URL("../../package.json", import.meta.url), "utf8"),
) as { version?: string };

const root = fs.mkdtempSync(path.join(os.tmpdir(), "alive-heartbeat-test-"));

/** Run a CLI command and capture its output instead of letting it hit the test log. */
async function runCli(argv: string[]): Promise<{ code: number; out: string; err: string }> {
	const out: string[] = [];
	const err: string[] = [];
	const stdoutWrite = process.stdout.write;
	const stderrWrite = process.stderr.write;
	process.stdout.write = ((chunk: unknown) => {
		out.push(String(chunk));
		return true;
	}) as typeof process.stdout.write;
	process.stderr.write = ((chunk: unknown) => {
		err.push(String(chunk));
		return true;
	}) as typeof process.stderr.write;
	try {
		const code = await main(argv);
		return { code, out: out.join(""), err: err.join("") };
	} finally {
		process.stdout.write = stdoutWrite;
		process.stderr.write = stderrWrite;
	}
}

try {
	// -------------------------------------------------------------------------
	section("heartbeat file: shape and atomic write");
	{
		const stateDir = path.join(root, "shape", ".alive");
		const startedAt = Date.UTC(2026, 0, 2, 3, 4, 5);
		const written = recordHeartbeat({
			stateDir,
			pid: 4242,
			startedAt,
			version: "9.9.9",
			tag: "v9.9.9",
			ref: "feature/heartbeat",
		});
		check("recordHeartbeat returns what it wrote", written?.pid === 4242 && written.version === "9.9.9", written);

		const file = heartbeatPath(stateDir);
		check("the heartbeat lives at <stateDir>/heartbeat.json", file === path.join(stateDir, HEARTBEAT_FILE) && fs.existsSync(file), file);

		const raw = JSON.parse(fs.readFileSync(file, "utf8")) as Record<string, unknown>;
		check(
			"the JSON shape is exactly pid, startedAt, version, tag, ref",
			JSON.stringify(Object.keys(raw).sort()) === JSON.stringify(["pid", "ref", "startedAt", "tag", "version"]),
			raw,
		);
		check("pid is a number", raw.pid === 4242);
		check("startedAt is an ISO timestamp", raw.startedAt === new Date(startedAt).toISOString(), raw.startedAt);
		check("version is recorded", raw.version === "9.9.9");
		check("tag and ref travel with the record", raw.tag === "v9.9.9" && raw.ref === "feature/heartbeat");
		check("no temp file is left behind", fs.readdirSync(stateDir).join(",") === HEARTBEAT_FILE, fs.readdirSync(stateDir));

		const before = fs.statSync(file).ino;
		recordHeartbeat({ stateDir, pid: 4243, startedAt: Date.UTC(2026, 0, 2, 3, 5, 0), version: "9.9.10" });
		const after = fs.statSync(file).ino;
		const replaced = JSON.parse(fs.readFileSync(file, "utf8")) as { pid: number; version: string };
		check(
			"a rewrite replaces the file by rename, not in place",
			before !== after && replaced.pid === 4243 && replaced.version === "9.9.10",
			{ before, after, replaced },
		);
		check("the file never disappears between writes", fs.existsSync(file));
		check("rewrites leave exactly one file", fs.readdirSync(stateDir).join(",") === HEARTBEAT_FILE, fs.readdirSync(stateDir));

		check("readHeartbeat round-trips the record", readHeartbeat(stateDir)?.pid === 4243, readHeartbeat(stateDir));

		const defaults = recordHeartbeat({ stateDir: path.join(root, "defaults", ".alive"), pid: 1, startedAt: 0 });
		check(
			"the harness version is filled in by default",
			defaults?.version === packageJson.version && packageJson.version !== undefined,
			{ recorded: defaults?.version, package: packageJson.version },
		);

		const malformed = path.join(root, "malformed", ".alive");
		fs.mkdirSync(malformed, { recursive: true });
		fs.writeFileSync(heartbeatPath(malformed), "{not json", "utf8");
		check("a corrupt heartbeat is ignored", readHeartbeat(malformed) === undefined);
		check(
			"a corrupt heartbeat counts as missing",
			readHeartbeatStatus(malformed, 300_000).state === "missing",
			readHeartbeatStatus(malformed, 300_000),
		);
	}

	// -------------------------------------------------------------------------
	section("heartbeat write failures never escape the startup hook");
	{
		const blocker = path.join(root, "blocker");
		fs.writeFileSync(blocker, "a file where a directory is expected", "utf8");
		const brokenStateDir = path.join(blocker, ".alive");
		const warnings: Array<{ msg: string; data?: unknown }> = [];
		const log = { warn: (msg: string, data?: unknown) => warnings.push({ msg, data }) };

		let threw = false;
		let returned: ReturnType<typeof recordHeartbeat> | "not-called" = "not-called";
		try {
			returned = recordHeartbeat({ stateDir: brokenStateDir, version: "1.0.0", log });
		} catch {
			threw = true;
		}
		check("recordHeartbeat does not throw", threw === false);
		check("recordHeartbeat reports no record", returned === undefined, returned);
		check("the failure is logged at warn", warnings.length === 1 && warnings[0]?.msg === "heartbeat write failed", warnings);
		check(
			"the warn names the path and the reason",
			typeof (warnings[0]?.data as { path?: unknown })?.path === "string" &&
				(warnings[0]?.data as { path: string }).path.endsWith(HEARTBEAT_FILE) &&
				typeof (warnings[0]?.data as { error?: unknown })?.error === "string",
			warnings[0]?.data,
		);

		let strictThrew = false;
		try {
			writeHeartbeat({ stateDir: brokenStateDir, version: "1.0.0" });
		} catch {
			strictThrew = true;
		}
		check("writeHeartbeat itself still surfaces errors to direct callers", strictThrew);

		const refreshWarnings: Array<{ msg: string }> = [];
		check(
			"a failed refresh is swallowed too",
			refreshHeartbeat(path.join(root, "no-such-state-dir"), { warn: (msg: string) => refreshWarnings.push({ msg }) }) === false &&
				refreshWarnings[0]?.msg === "heartbeat refresh failed",
			refreshWarnings,
		);
	}

	// -------------------------------------------------------------------------
	section("freshness: fresh, stale, missing");
	{
		const stateDir = path.join(root, "freshness", ".alive");
		const startedAt = Date.now() - 60_000;
		recordHeartbeat({ stateDir, pid: 777, startedAt, version: "0.0.1" });

		const fresh = readHeartbeatStatus(stateDir, 300_000);
		check("a just-written heartbeat is fresh", fresh.state === "fresh" && fresh.fresh === true, fresh);
		check("age is measured from the write", fresh.ageMs !== undefined && fresh.ageMs < 5_000, fresh.ageMs);
		check("uptime comes from startedAt", fresh.uptimeMs !== undefined && fresh.uptimeMs >= 60_000, fresh.uptimeMs);
		check("the recorded heartbeat is exposed", fresh.heartbeat?.pid === 777 && fresh.heartbeat.version === "0.0.1");

		const old = (Date.now() - 10 * 60_000) / 1000;
		fs.utimesSync(heartbeatPath(stateDir), old, old);
		const stale = readHeartbeatStatus(stateDir, 300_000);
		check("an old file is stale", stale.state === "stale" && stale.fresh === false, stale);
		check("staleness keeps the contents readable", stale.heartbeat?.pid === 777);

		check("refreshHeartbeat makes it fresh again", refreshHeartbeat(stateDir) === true);
		const refreshed = readHeartbeatStatus(stateDir, 300_000);
		check("a refresh keeps the original startedAt", refreshed.state === "fresh" && refreshed.heartbeat?.startedAt === new Date(startedAt).toISOString(), refreshed);

		fs.rmSync(heartbeatPath(stateDir));
		const missing = readHeartbeatStatus(stateDir, 300_000);
		check("a missing file is missing", missing.state === "missing" && missing.fresh === false, missing);
		check("a missing file has no age and no contents", missing.ageMs === undefined && missing.heartbeat === undefined);
	}

	// -------------------------------------------------------------------------
	section("alive heartbeat: exit codes and output");
	{
		const project = path.join(root, "project");
		fs.mkdirSync(project, { recursive: true });
		const configPath = path.join(project, "alive.config.json");
		fs.writeFileSync(configPath, JSON.stringify({ name: "Heartbeat", updates: { heartbeatStaleMs: 60_000 } }), "utf8");
		const stateDir = path.join(project, ".alive");
		const cli = (...args: string[]) => runCli([...args, "--config", configPath]);

		const missing = await cli("heartbeat", "--status");
		check("--status exits 1 when the heartbeat is missing", missing.code === 1, missing);
		check("--status says missing", missing.out.includes("missing"), missing.out);

		recordHeartbeat({ stateDir, pid: process.pid, version: "0.2.0", tag: "v0.2.0", ref: "main" });
		const fresh = await cli("heartbeat", "--status");
		check("--status exits 0 while the heartbeat is fresh", fresh.code === 0, fresh);
		check("--status prints state, age, pid and version", /fresh.*age.*pid \d+.*version 0\.2\.0/.test(fresh.out), fresh.out);

		const human = await cli("heartbeat");
		check("plain output exits 0 while fresh", human.code === 0, human);
		check("plain output prints the contents", human.out.includes("heartbeat") && human.out.includes("v0.2.0") && human.out.includes("main"), human.out);

		const json = await cli("heartbeat", "--json");
		check("--json exits 0 while fresh", json.code === 0, json);
		const payload = JSON.parse(json.out) as Record<string, unknown>;
		check(
			"the JSON shape is path, state, fresh, ageMs, uptimeMs, staleAfterMs, heartbeat",
			JSON.stringify(Object.keys(payload).sort()) ===
				JSON.stringify(["ageMs", "fresh", "heartbeat", "path", "staleAfterMs", "state", "uptimeMs"]),
			payload,
		);
		check("--json reports the state and the configured limit", payload.state === "fresh" && payload.staleAfterMs === 60_000, payload);
		const beat = payload.heartbeat as Record<string, unknown> | null;
		check(
			"--json carries the heartbeat record",
			beat !== null && beat.pid === process.pid && beat.version === "0.2.0" && beat.tag === "v0.2.0" && beat.ref === "main",
			beat,
		);
		check("--json age is a number", typeof payload.ageMs === "number" && (payload.ageMs as number) < 5_000, payload.ageMs);

		const old = (Date.now() - 2 * 60_000) / 1000;
		fs.utimesSync(heartbeatPath(stateDir), old, old);
		const stale = await cli("heartbeat", "--status");
		check("--status exits 1 when the heartbeat is stale", stale.code === 1, stale);
		check("--status says stale", stale.out.includes("stale"), stale.out);
		const staleJson = await cli("heartbeat", "--json");
		check("--json exits 1 when stale", staleJson.code === 1, staleJson);
		check("--json state is stale", (JSON.parse(staleJson.out) as { state: string }).state === "stale");
		const staleHuman = await cli("heartbeat");
		check("plain output exits 1 when stale", staleHuman.code === 1, staleHuman);

		const help = await cli("heartbeat", "--help");
		check("--help exits 0", help.code === 0, help);
		check("--help documents --status and --json", help.out.includes("--status") && help.out.includes("--json"), help.out);
		check("--help documents the staleness default", help.out.includes("5 minutes"), help.out);

		const unknown = await cli("heartbeat", "--nope");
		check("an unknown flag is an error", unknown.code === 1 && unknown.err.includes("unknown flag"), unknown);
	}
} finally {
	fs.rmSync(root, { recursive: true, force: true });
}

process.stdout.write(failures === 0 ? "\nALL HEARTBEAT TESTS PASSED\n" : `\n${failures} HEARTBEAT TEST(S) FAILED\n`);
process.exitCode = failures === 0 ? 0 : 1;
