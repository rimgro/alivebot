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
	detectUnitStatus,
	heartbeatPath,
	readHeartbeat,
	harnessIdentity,
	readHeartbeatStatus,
	recordHeartbeat,
	refreshHeartbeat,
	resetUnitStatusCache,
	systemdUnitName,
	writeHeartbeat,
} from "../heartbeat.js";
import {
	readStartLoop,
	recordProcessStart,
	START_LOOP_THRESHOLD,
	START_LOOP_WINDOW_MS,
} from "../store/start-loop.js";

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
		const writtenAt = startedAt + 20_000;
		const written = recordHeartbeat({
			stateDir,
			pid: 4242,
			startedAt,
			version: "9.9.9",
			buildId: "test-build-1",
			tag: "v9.9.9",
			ref: "feature/heartbeat",
			lastTickAt: startedAt,
			unitStatus: "active",
			now: writtenAt,
		});
		check("recordHeartbeat returns what it wrote", written?.pid === 4242 && written.version === "9.9.9", written);

		const file = heartbeatPath(stateDir);
		check("the heartbeat lives at <stateDir>/heartbeat.json", file === path.join(stateDir, HEARTBEAT_FILE) && fs.existsSync(file), file);

		const raw = JSON.parse(fs.readFileSync(file, "utf8")) as Record<string, unknown>;
		check(
			"the JSON shape keeps the old fields and adds the #175 observability fields",
			JSON.stringify(Object.keys(raw).sort()) ===
				JSON.stringify(["buildId", "lastTickAt", "pid", "ref", "staleSeconds", "startedAt", "tag", "unitStatus", "updatedAt", "version"]),
			raw,
		);
		check("updatedAt records the last update", raw.updatedAt === new Date(writtenAt).toISOString(), raw.updatedAt);
		check("lastTickAt is recorded as ISO", raw.lastTickAt === new Date(startedAt).toISOString(), raw.lastTickAt);
		check("staleSeconds is the whole number of seconds since the tick", raw.staleSeconds === 20, raw.staleSeconds);
		check("unitStatus is recorded", raw.unitStatus === "active", raw.unitStatus);
		check("pid is a number", raw.pid === 4242);
		check("startedAt is an ISO timestamp", raw.startedAt === new Date(startedAt).toISOString(), raw.startedAt);
		check("version is recorded", raw.version === "9.9.9");
		check("the loaded code identity is recorded", raw.buildId === "test-build-1", raw.buildId);
		check("tag and ref travel with the record", raw.tag === "v9.9.9" && raw.ref === "feature/heartbeat");
		check("no temp file is left behind", fs.readdirSync(stateDir).join(",") === HEARTBEAT_FILE, fs.readdirSync(stateDir));

		const before = fs.statSync(file).ino;
		recordHeartbeat({ stateDir, pid: 4243, startedAt: Date.UTC(2026, 0, 2, 3, 5, 0), version: "9.9.10", buildId: "test-build-2" });
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
		check(
			"the running code identity is filled in by default",
			typeof defaults?.buildId === "string" && defaults.buildId !== "unknown" && defaults.buildId.length > 0,
			defaults?.buildId,
		);
		const identity = harnessIdentity();
		check("harnessIdentity names the loaded entry, not just the package version", identity.buildId === defaults?.buildId, identity);

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
	section("new observability fields: old files, growth and identity preservation (#175)");
	{
		const legacyDir = path.join(root, "legacy", ".alive");
		fs.mkdirSync(legacyDir, { recursive: true });
		const legacyStart = new Date(Date.now() - 120_000).toISOString();
		fs.writeFileSync(
			heartbeatPath(legacyDir),
			`${JSON.stringify({ pid: 55, startedAt: legacyStart, version: "0.0.1", buildId: "legacy-build" })}\n`,
			"utf8",
		);
		const legacy = readHeartbeat(legacyDir);
		check(
			"an old heartbeat without the new fields still reads",
			legacy !== undefined && legacy.pid === 55 && legacy.startedAt === legacyStart && legacy.buildId === "legacy-build",
			legacy,
		);
		check(
			"the new fields stay undefined on an old file",
			legacy !== undefined &&
				legacy.updatedAt === undefined &&
				legacy.lastTickAt === undefined &&
				legacy.staleSeconds === undefined &&
				legacy.unitStatus === undefined,
			legacy,
		);
		const legacyStatus = readHeartbeatStatus(legacyDir, 300_000);
		check(
			"readHeartbeatStatus does not invent staleSeconds/unitStatus for an old file",
			legacyStatus.staleSeconds === undefined && legacyStatus.unitStatus === undefined,
			legacyStatus,
		);

		const growthDir = path.join(root, "growth", ".alive");
		const tick = Date.now() - 7_000;
		const firstWrite = Date.now();
		recordHeartbeat({
			stateDir: growthDir,
			pid: 6161,
			startedAt: tick - 30_000,
			version: "2.0.0",
			buildId: "growth-build",
			tag: "v2.0.0",
			ref: "feature/growth",
			lastTickAt: tick,
			now: firstWrite,
		});
		const first = readHeartbeat(growthDir)!;
		check("staleSeconds is non-zero after the tick", (first.staleSeconds ?? 0) >= 7, first);
		check("the first update carries updatedAt", typeof first.updatedAt === "string" && first.updatedAt.length > 0, first.updatedAt);

		const nextWrite = firstWrite + 5_000;
		check(
			"refreshHeartbeat rewrites the record",
			refreshHeartbeat(growthDir, undefined, nextWrite, { lastTickAt: tick, unitStatus: "inactive" }) === true,
		);
		const second = readHeartbeat(growthDir)!;
		check("staleSeconds grows with the next update", (second.staleSeconds ?? 0) >= (first.staleSeconds ?? 0) + 5, {
			first: first.staleSeconds,
			second: second.staleSeconds,
		});
		check("updatedAt moves with the next update", second.updatedAt === new Date(nextWrite).toISOString(), second.updatedAt);
		check(
			"the refresh preserves pid/startedAt/version/buildId/tag/ref",
			second.pid === 6161 &&
				second.startedAt === first.startedAt &&
				second.version === "2.0.0" &&
				second.buildId === "growth-build" &&
				second.tag === "v2.0.0" &&
				second.ref === "feature/growth",
			second,
		);
		check("the refresh records unitStatus", second.unitStatus === "inactive", second.unitStatus);
		const growthStatus = readHeartbeatStatus(growthDir, 300_000);
		check(
			"readHeartbeatStatus exposes the new fields when they exist",
			growthStatus.staleSeconds === second.staleSeconds && growthStatus.unitStatus === "inactive" && growthStatus.state === "fresh",
			growthStatus,
		);
	}

	// -------------------------------------------------------------------------
	section("start-loop status travels with the heartbeat (#178)");
	{
		const stateDir = path.join(root, "start-loop", ".alive");
		const writtenAt = Date.UTC(2026, 0, 2, 3, 4, 5);
		const startLoop = { starts: 6, windowSeconds: 600, threshold: 5, warn: true };
		recordHeartbeat({
			stateDir,
			pid: 8181,
			startedAt: writtenAt - 60_000,
			version: "3.0.0",
			buildId: "start-loop-build",
			startLoop,
			now: writtenAt,
		});
		const raw = JSON.parse(fs.readFileSync(heartbeatPath(stateDir), "utf8")) as Record<string, unknown>;
		check(
			"the heartbeat writes the structured startLoop block",
			JSON.stringify(raw.startLoop) === JSON.stringify(startLoop),
			raw.startLoop,
		);
		const fromFile = readHeartbeat(stateDir);
		check(
			"readHeartbeat round-trips startLoop",
			fromFile?.startLoop?.starts === 6 && fromFile.startLoop.warn === true && fromFile.startLoop.windowSeconds === 600,
			fromFile?.startLoop,
		);
		const status = readHeartbeatStatus(stateDir, 300_000, writtenAt);
		check(
			"readHeartbeatStatus exposes startLoop",
			status.startLoop?.starts === 6 && status.startLoop.threshold === 5 && status.startLoop.warn === true,
			status.startLoop,
		);

		const refreshedAt = writtenAt + 5_000;
		check("refreshHeartbeat accepts a record with startLoop", refreshHeartbeat(stateDir, undefined, refreshedAt) === true);
		const preserved = readHeartbeat(stateDir);
		check(
			"a refresh without startLoop preserves the previous value",
			preserved?.startLoop?.starts === 6 && preserved.startLoop.warn === true,
			preserved?.startLoop,
		);

		const nextStartLoop = { starts: 2, windowSeconds: 600, threshold: 5, warn: false };
		check(
			"refreshHeartbeat overwrites startLoop when given a new value",
			refreshHeartbeat(stateDir, undefined, refreshedAt + 5_000, { startLoop: nextStartLoop }) === true,
		);
		const overwritten = readHeartbeat(stateDir);
		check(
			"the refreshed startLoop is what the reader sees",
			overwritten?.startLoop?.starts === 2 && overwritten.startLoop.warn === false,
			overwritten?.startLoop,
		);

		const corruptDir = path.join(root, "start-loop-corrupt", ".alive");
		fs.mkdirSync(corruptDir, { recursive: true });
		fs.writeFileSync(
			heartbeatPath(corruptDir),
			JSON.stringify({
				pid: 1,
				startedAt: new Date(writtenAt).toISOString(),
				version: "1.0.0",
				buildId: "corrupt",
				startLoop: { starts: -1, windowSeconds: 600, threshold: 5, warn: true },
			}),
			"utf8",
		);
		check("a malformed startLoop block is not invented", readHeartbeat(corruptDir)?.startLoop === undefined, readHeartbeat(corruptDir));
		check(
			"readHeartbeatStatus does not invent startLoop either",
			readHeartbeatStatus(corruptDir, 300_000, writtenAt).startLoop === undefined,
			readHeartbeatStatus(corruptDir, 300_000, writtenAt),
		);

		const badWarnDir = path.join(root, "start-loop-bad-warn", ".alive");
		fs.mkdirSync(badWarnDir, { recursive: true });
		fs.writeFileSync(
			heartbeatPath(badWarnDir),
			JSON.stringify({
				pid: 2,
				startedAt: new Date(writtenAt).toISOString(),
				version: "1.0.0",
				buildId: "bad-warn",
				startLoop: { starts: 6, windowSeconds: 600, threshold: 5, warn: "yes" },
			}),
			"utf8",
		);
		check("a non-boolean warn drops the block", readHeartbeat(badWarnDir)?.startLoop === undefined, readHeartbeat(badWarnDir));
	}

	// -------------------------------------------------------------------------
	section("start-loop status decays with the window (#178 review)");
	{
		const stateDir = path.join(root, "start-loop-decay", ".alive");
		const base = Date.UTC(2026, 0, 2, 3, 4, 5);
		for (let index = 0; index < START_LOOP_THRESHOLD; index += 1) {
			recordProcessStart(stateDir, base + index * 1_000);
		}
		const atBoot = readStartLoop(stateDir, base + START_LOOP_THRESHOLD * 1_000);
		check("five starts inside the window warn", atBoot.starts === START_LOOP_THRESHOLD && atBoot.warn === true, atBoot);

		const bootHeartbeatAt = base + (START_LOOP_THRESHOLD + 1) * 1_000;
		recordHeartbeat({
			stateDir,
			pid: 9191,
			startedAt: base,
			version: "3.1.0",
			buildId: "start-loop-decay",
			startLoop: atBoot,
			now: bootHeartbeatAt,
		});
		const bootStatus = readHeartbeatStatus(stateDir, 300_000, bootHeartbeatAt);
		check("the heartbeat carries the warn state while the window is full", bootStatus.startLoop?.warn === true, bootStatus.startLoop);

		// After the whole window the five old starts are gone; the next boot is the
		// only one left, so the next heartbeat rewrite must not keep the alert.
		const later = base + START_LOOP_WINDOW_MS + 60_000;
		check("all old starts fall out of the window", readStartLoop(stateDir, later).starts === 0, readStartLoop(stateDir, later));
		const nextStart = recordProcessStart(stateDir, later);
		check("the next start counts 1 and does not warn", nextStart.starts === 1 && nextStart.warn === false, nextStart);
		check("the heartbeat is rewritten with the decayed status", refreshHeartbeat(stateDir, undefined, later, { startLoop: nextStart }) === true);
		const decayed = readHeartbeatStatus(stateDir, 300_000, later);
		check(
			"the rewritten heartbeat reports 1 start and no warn",
			decayed.startLoop?.starts === 1 && decayed.startLoop.warn === false,
			decayed.startLoop,
		);
	}

	// -------------------------------------------------------------------------
	section("systemd unit status: best effort, cached and bounded (#175)");
	{
		check("the unit name follows the managed profile id", systemdUnitName("developer") === "alive-agent@developer");
		check(
			"no systemctl on PATH reads as none",
			detectUnitStatus("no-systemctl", { now: 1, envPath: path.join(root, "definitely-empty-bin") }) === "none",
		);

		const binDir = path.join(root, "fake-systemctl-bin");
		fs.mkdirSync(binDir, { recursive: true });
		const fake = path.join(binDir, "systemctl");
		fs.writeFileSync(
			fake,
			[
				"#!/bin/sh",
				'if [ "$1" = "is-active" ]; then',
				'  printf "%s\\n" "${FAKE_UNIT_STATUS:-active}"',
				'  exit "${FAKE_UNIT_EXIT:-0}"',
				"fi",
				"exit 1",
				"",
			].join("\n"),
		);
		fs.chmodSync(fake, 0o755);
		const originalPath = process.env.PATH;
		process.env.PATH = `${binDir}${path.delimiter}${originalPath ?? ""}`;
		try {
			resetUnitStatusCache();
			process.env.FAKE_UNIT_STATUS = "inactive";
			check("the fake systemctl answer is read", detectUnitStatus("cache-test", { now: 1_000 }) === "inactive");
			process.env.FAKE_UNIT_STATUS = "active";
			check("a second query inside 30 s uses the cache", detectUnitStatus("cache-test", { now: 20_000 }) === "inactive");
			check("after 30 s the answer is refreshed", detectUnitStatus("cache-test", { now: 31_001 }) === "active");
			process.env.FAKE_UNIT_STATUS = "banana";
			check("an unknown answer is reported as unknown", detectUnitStatus("odd-answer", { now: 1 }) === "unknown");
			process.env.FAKE_UNIT_STATUS = "failed";
			process.env.FAKE_UNIT_EXIT = "3";
			check("a failing systemctl still reports its printed state", detectUnitStatus("failed-unit", { now: 1 }) === "failed");
		} finally {
			delete process.env.FAKE_UNIT_STATUS;
			delete process.env.FAKE_UNIT_EXIT;
			process.env.PATH = originalPath;
			resetUnitStatusCache();
			fs.rmSync(binDir, { recursive: true, force: true });
		}
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

		recordHeartbeat({ stateDir, pid: process.pid, version: "0.2.0", buildId: "cli-build-1", tag: "v0.2.0", ref: "main" });
		const fresh = await cli("heartbeat", "--status");
		check("--status exits 0 while the heartbeat is fresh", fresh.code === 0, fresh);
		check(
			"--status prints state, age, pid, version and build",
			/fresh.*age.*pid \d+.*version 0\.2\.0.*build cli-build-1/.test(fresh.out),
			fresh.out,
		);

		const human = await cli("heartbeat");
		check("plain output exits 0 while fresh", human.code === 0, human);
		check(
			"plain output prints the contents including the build id",
			human.out.includes("heartbeat") && human.out.includes("v0.2.0") && human.out.includes("cli-build-1") && human.out.includes("main"),
			human.out,
		);

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
			beat !== null && beat.pid === process.pid && beat.version === "0.2.0" && beat.buildId === "cli-build-1" && beat.tag === "v0.2.0" && beat.ref === "main",
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
