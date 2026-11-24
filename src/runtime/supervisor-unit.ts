/**
 * "Which systemd unit supervises this process?" — the detection behind the
 * supervisor strategy of `alive restart --deferred`.
 *
 * A deferred restart used to always start a transient unit whose ExecStart was
 * `alive restart`. Under a real systemd unit that is wrong twice: the transient
 * unit does not inherit the caller's environment (so the restarted profile
 * loses its tokens and fails on init), and its process races the supervising
 * unit's `Restart=always`, producing two runtimes. Restarting the supervisor
 * itself (`systemctl restart <unit>`) takes the environment from the unit file
 * and performs exactly one restart.
 *
 * The supervisor is found from `/proc/self/cgroup`: the deepest `.service`
 * component is the unit systemd started this process under. That alone is not
 * proof — the process may live under a login session's `tmux.service` rather
 * than under the Alive unit — so the candidate is confirmed with
 * `systemctl show -p MainPID`: only a unit whose MainPID is the harness pid from
 * `runtime.json` is the supervisor. Anything else falls back to the direct
 * strategy.
 *
 * Everything here is pure or injected (`run`, `readCgroup`, `harnessPid`), so
 * tests never need a real service manager.
 */
import * as fs from "node:fs";
import { oneLine } from "../util.js";
import type { CommandRunner } from "../update.js";

export type SupervisorScope = "system" | "user";

export interface SupervisorUnit {
	unit: string;
	scope: SupervisorScope;
}

export type SupervisorStrategy = "supervisor" | "direct";

export interface SupervisorDetection {
	strategy: SupervisorStrategy;
	/** Set only when `strategy === "supervisor"`. */
	supervisor?: SupervisorUnit;
	/** Why the detection fell back to `direct`; one line, never fatal. */
	warning?: string;
}

export interface DetectSupervisorOptions {
	run: CommandRunner;
	/** Test seam; defaults to reading `/proc/<process.pid>/cgroup`. */
	readCgroup?: () => string | undefined;
	/** Pid of the running harness from `runtime.json`. */
	harnessPid?: number;
	timeoutMs?: number;
}

/** `systemctl show` answers immediately; a wedged manager must not hold the CLI. */
const COMMAND_TIMEOUT_MS = 15_000;

/** The user manager itself (`user@1000.service`), never a restart candidate. */
const USER_MANAGER_UNIT = /^user@\d+\.service$/;

/** `MainPID=1234` in `systemctl show -p MainPID` output. */
const MAIN_PID_LINE = /^MainPID=(\d+)\r?$/m;

function scopeArgs(scope: SupervisorScope): string[] {
	return scope === "user" ? ["--user"] : [];
}

/**
 * Parse `/proc/self/cgroup` and return the deepest `.service` unit in it.
 *
 * cgroup v2 is a single `0::/path` line; v1 has one line per controller, so
 * every line whose payload is an absolute path is considered and the deepest
 * parsed unit wins. A path may continue past the unit into slices/scopes
 * (`/system.slice/alive.service/app.slice/run-1.scope`), hence "last component
 * that ends in `.service`", not "last component". The user manager itself is
 * skipped: restarting `user@1000.service` would kill every unit of the session,
 * not just the harness, so a path with nothing deeper is not a supervisor.
 */
export function parseCgroupUnit(cgroupText: string): SupervisorUnit | undefined {
	let best: { supervisor: SupervisorUnit; depth: number } | undefined;
	for (const raw of cgroupText.split("\n")) {
		const line = raw.trim();
		if (!line) continue;
		// `hierarchy:controllers:path` — both v1 and v2 have exactly two leading
		// colons before the path, and the path never contains a colon in practice.
		const match = /^[^:]*:[^:]*:(.*)$/.exec(line);
		if (!match) continue;
		const cgroupPath = match[1]!.trim();
		if (!cgroupPath.startsWith("/")) continue;

		const segments = cgroupPath.split("/").filter(Boolean);
		let index = segments.length - 1;
		while (index >= 0 && !segments[index]!.endsWith(".service")) index -= 1;
		if (index < 0) continue;
		const rawUnit = segments[index]!;
		// `init.scope` below the manager leaves the manager as the last service.
		if (USER_MANAGER_UNIT.test(rawUnit)) continue;

		// systemd escapes `-` as `\x2d` in unit names inside cgroup paths.
		const unit = rawUnit.replace(/\\x2d/g, "-");
		const scope: SupervisorScope =
			cgroupPath.includes("user@") || cgroupPath.startsWith("/user.slice/") ? "user" : "system";
		if (!best || segments.length > best.depth) {
			best = { supervisor: { unit, scope }, depth: segments.length };
		}
	}
	return best?.supervisor;
}

/** Read `/proc/<pid>/cgroup`; missing or unreadable means "no supervisor". */
export function readSelfCgroup(pid: number = process.pid): string | undefined {
	try {
		return fs.readFileSync(`/proc/${pid}/cgroup`, "utf8");
	} catch {
		return undefined;
	}
}

/** `MainPID=1234` → `1234`; undefined when the output carries no such line. */
export function parseMainPid(stdout: string): number | undefined {
	const match = MAIN_PID_LINE.exec(stdout);
	if (!match) return undefined;
	return Number(match[1]);
}

/**
 * Find the supervisor unit and confirm it is really the one running the
 * harness. Every uncertain answer is `direct` plus one warning line: the
 * deferred restart still happens, just through its old, self-contained path.
 */
export async function detectSupervisorUnit(options: DetectSupervisorOptions): Promise<SupervisorDetection> {
	const cgroupText = (options.readCgroup ?? (() => readSelfCgroup()))() ?? "";
	const candidate = parseCgroupUnit(cgroupText);
	if (!candidate) return { strategy: "direct" };

	const harnessPid = options.harnessPid;
	if (harnessPid === undefined || !Number.isInteger(harnessPid) || harnessPid <= 0) {
		return {
			strategy: "direct",
			warning: `the process runs under ${candidate.unit}, but the harness pid is unknown (no runtime.json); scheduling a direct restart`,
		};
	}

	const args = [...scopeArgs(candidate.scope), "show", "-p", "MainPID", candidate.unit];
	let stdout: string;
	try {
		stdout = (await options.run("systemctl", args, { timeoutMs: options.timeoutMs ?? COMMAND_TIMEOUT_MS })).stdout;
	} catch (error) {
		return {
			strategy: "direct",
			warning: `could not verify that ${candidate.unit} supervises the harness (systemctl ${args.join(" ")}: ${oneLine(errorMessage(error))}); scheduling a direct restart`,
		};
	}

	const mainPid = parseMainPid(stdout);
	if (mainPid === undefined) {
		return {
			strategy: "direct",
			warning: `could not verify that ${candidate.unit} supervises the harness (systemctl ${args.join(" ")} did not report MainPID); scheduling a direct restart`,
		};
	}
	if (mainPid !== harnessPid) {
		return {
			strategy: "direct",
			warning: `${candidate.unit} is not the harness supervisor (MainPID ${mainPid}, harness pid ${harnessPid}); scheduling a direct restart`,
		};
	}
	return { strategy: "supervisor", supervisor: candidate };
}

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}
