/**
 * Runtime `dashboard` tool tests.
 *
 *   npx tsx src/dev/dashboard-tool-test.ts
 *
 * No cloudflared and no child process: `spawnDashboard` and `startTunnel` are
 * fakes, and a real detached dashboard is never started. The only sockets are
 * loopback HTTP against an in-process `createDashboardServer` used to exercise
 * `GET /t?t=…` end to end.
 */
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { createAliveTools, type RunHandle, type ToolDeps } from "../runtime/tools.js";
import { loadConfig } from "../config.js";
import { Logger } from "../log.js";
import { DASHBOARD_SESSION_COOKIE } from "../dashboard/auth.js";
import {
	DASHBOARD_TICKET_SESSION_TTL_MS,
	DASHBOARD_TICKET_TTL_MS,
	DashboardTicketStore,
} from "../dashboard/tickets.js";
import { DASHBOARD_STATE_FILE, hashTicket, readDashboardState } from "../dashboard/state-file.js";
import { DashboardTool, dashboardAccess, isPrivateOwnerThread } from "../dashboard/tool.js";
import { createDashboardServer } from "../dashboard/server.js";
import { setDashboardPassword } from "../dashboard/auth.js";
import type { DashboardChildSpec } from "../dashboard/tool.js";

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
async function assertRejects(name: string, run: () => Promise<unknown>, pattern: RegExp): Promise<void> {
	try {
		await run();
		check(name, false, "did not throw");
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		check(name, pattern.test(message), message);
	}
}
function assertThrows(name: string, run: () => unknown, pattern: RegExp): void {
	try {
		run();
		check(name, false, "did not throw");
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		check(name, pattern.test(message), message);
	}
}

const root = fs.mkdtempSync(path.join(os.tmpdir(), "alive-dashboard-tool-test-"));
const stateDir = path.join(root, ".alive");
const configPath = path.join(root, "alive.config.json");
const PRIVATE_THREAD = "telegram:555001";
const WORK_GROUP = "telegram:-100200300";
const STRANGER_GROUP = "telegram:-100999999";
const TUNNEL_ORIGIN = "https://fake-dashboard-tool.trycloudflare.com";
const PASSWORD = "dashboard-tool-test-password";

fs.mkdirSync(stateDir, { recursive: true });
fs.writeFileSync(
	configPath,
	`${JSON.stringify({
		name: "Dashboard Tool Root",
		model: "anthropic/claude-test",
		stateDir: ".alive",
		workspace: ".alive/workspace",
		sandbox: { enabled: false },
		dashboard: { port: 7788, allowedThreads: [WORK_GROUP] },
	}, null, 2)}\n`,
	"utf8",
);

function readStateJson(): Record<string, unknown> {
	const file = path.join(stateDir, "dashboard", DASHBOARD_STATE_FILE);
	return JSON.parse(fs.readFileSync(file, "utf8")) as Record<string, unknown>;
}

function cookieOf(response: Response): string {
	return (response.headers.get("set-cookie") ?? "").split(";")[0] ?? "";
}

async function main(): Promise<void> {
	const loaded = loadConfig({ cwd: root, configPath, migrateSecrets: false });
	await setDashboardPassword(stateDir, PASSWORD, Date.now());

	let clock = Date.now();
	let running = false;
	let spawnCount = 0;
	let tunnelStarts = 0;
	let tunnelStops = 0;
	const spawns: DashboardChildSpec[] = [];
	const logs: string[] = [];

	const spawnDashboard = (spec: DashboardChildSpec): { pid: number } => {
		spawns.push(spec);
		spawnCount += 1;
		running = true;
		return { pid: 90_000 + spawnCount };
	};
	const probe = async (): Promise<boolean> => running;
	const startTunnel = async (): Promise<{ origin: string; stop(): Promise<void> }> => {
		tunnelStarts += 1;
		return {
			origin: TUNNEL_ORIGIN,
			stop: async () => {
				tunnelStops += 1;
			},
		};
	};

	const dashboard = new DashboardTool({
		rootDir: root,
		configPath,
		stateDir,
		port: loaded.config.dashboard.port,
		allowedThreads: loaded.config.dashboard.allowedThreads,
		now: () => clock,
		log: (line) => logs.push(line),
		spawnDashboard,
		probe,
		startTunnel,
		startTimeoutMs: 200,
		startPollMs: 5,
		// The main scenario mints several links on purpose; rate limiting has its
		// own store-level test below.
		ticketMaxPerWindow: 20,
	});

	section("access rules");
	check("the local console is a private owner thread", isPrivateOwnerThread("console"));
	check("the operator TUI thread is a private owner thread", isPrivateOwnerThread("local:agent:main:operator"));
	check("an agent-to-agent local conversation is not private", !isPrivateOwnerThread("local:dev:main"));
	check("a Telegram private chat is a private owner thread", isPrivateOwnerThread(PRIVATE_THREAD));
	check("a Telegram group is not a private owner thread", !isPrivateOwnerThread(WORK_GROUP));
	check("a forum topic is not a private owner thread", !isPrivateOwnerThread("telegram:555001/42"));
	check("an unknown module thread is not private", !isPrivateOwnerThread("http:anonymous"));
	check("private threads are allowed with an empty allowlist", dashboardAccess(PRIVATE_THREAD, []).allowed);
	check("unlisted groups are refused", !dashboardAccess(STRANGER_GROUP, []).allowed);
	check("allowlisted work groups are allowed", dashboardAccess(WORK_GROUP, [WORK_GROUP]).allowed && !dashboardAccess(WORK_GROUP, [WORK_GROUP]).privateThread);
	check("the refusal names dashboard.allowedThreads", /dashboard\.allowedThreads/.test(dashboardAccess(STRANGER_GROUP, []).reason ?? ""));
	await assertRejects("open refuses an unlisted thread", () => dashboard.open({ thread: STRANGER_GROUP }), /not available in thread/);
	await assertRejects("status refuses an unlisted thread", () => dashboard.status({ thread: STRANGER_GROUP }), /not available in thread/);
	await assertRejects("close refuses an unlisted thread", () => dashboard.close({ thread: STRANGER_GROUP }), /not available in thread/);
	check("a refused call started nothing", spawnCount === 0 && tunnelStarts === 0);

	section("status before open");
	const idleStatus = await dashboard.status({ thread: PRIVATE_THREAD });
	check("status reports not running", idleStatus.running === false && idleStatus.mode === null, idleStatus);
	check("status still reports the configured port", idleStatus.port === 7788, idleStatus.port);

	section("open is idempotent");
	const opened = await dashboard.open({ thread: PRIVATE_THREAD });
	check("the first open spawns exactly one dashboard", spawnCount === 1, spawnCount);
	check("the first open returns the loopback URL", opened.url === "http://127.0.0.1:7788" && opened.mode === "local", opened);
	check("a local open has no expiry and no ticket", opened.expiresAt === null && opened.ticket === undefined, opened);
	check("the child is the same repo/config, loopback and serve-only", spawns[0]!.cwd === root && spawns[0]!.args.includes(configPath) && spawns[0]!.args.includes("--serve") && spawns[0]!.args.join(" ").includes("--host 127.0.0.1"), spawns[0]!.args);
	const again = await dashboard.open({ thread: PRIVATE_THREAD });
	check("a second open returns the same URL", again.url === opened.url, again.url);
	check("a second open does not spawn a second process", spawnCount === 1, spawnCount);
	check("a second open is reported as reused", again.reused === true, again.reused);

	section("tunnel open and one-time tickets");
	const tunnel = await dashboard.open({ thread: PRIVATE_THREAD, mode: "tunnel" });
	check("tunnel mode starts exactly one fake tunnel", tunnelStarts === 1, tunnelStarts);
	check("tunnel open returns a tunnel mode", tunnel.mode === "tunnel", tunnel.mode);
	check("the link is a /t ticket URL on the tunnel origin", tunnel.url.startsWith(`${TUNNEL_ORIGIN}/t?t=`) && tunnel.ticket !== undefined, tunnel.url);
	check("the ticket expires in minutes, not hours", tunnel.expiresAt !== null && tunnel.expiresAt - clock === DASHBOARD_TICKET_TTL_MS, tunnel.expiresAt);
	check("the tunnel deadline is reported separately", tunnel.tunnelExpiresAt !== undefined && tunnel.tunnelUrl === TUNNEL_ORIGIN, tunnel.tunnelUrl);
	const stateAfterIssue = readStateJson();
	const tickets = stateAfterIssue.tickets as Record<string, unknown>;
	check("state stores only the ticket hash", Object.keys(tickets).includes(hashTicket(tunnel.ticket!)) && !JSON.stringify(stateAfterIssue).includes(tunnel.ticket!), Object.keys(tickets));
	const issuances = stateAfterIssue.issuances as Array<Record<string, unknown>>;
	const lastIssuance = issuances[issuances.length - 1]!;
	check("issuance is logged with the requesting thread and time", lastIssuance.thread === PRIVATE_THREAD && typeof lastIssuance.at === "number" && typeof lastIssuance.expiresAt === "number", lastIssuance);
	check("the issuance log is IP-free", !Object.keys(lastIssuance).some((key) => /ip|address|client/i.test(key)), lastIssuance);
	check("no log line contains the ticket value", !logs.some((line) => line.includes(tunnel.ticket!)), logs.filter((line) => line.includes("ticket")));
	check("the tunnel log line names the thread, not the ticket", logs.some((line) => line.includes(`thread ${PRIVATE_THREAD}`)), logs.filter((line) => line.includes("tunnel")));

	section("status while external access is active");
	const activeStatus = await dashboard.status({ thread: PRIVATE_THREAD });
	check("status reports running + tunnel mode", activeStatus.running && activeStatus.mode === "tunnel", activeStatus);
	check("status reports the tunnel URL and expiry", activeStatus.tunnelUrl === TUNNEL_ORIGIN && activeStatus.expiresAt === tunnel.tunnelExpiresAt, activeStatus);
	check("status starts with zero external sessions", activeStatus.externalSessions === 0, activeStatus.externalSessions);

	section("GET /t ticket exchange");
	const server = createDashboardServer({
		rootDir: root,
		port: 0,
		allowEphemeralPort: true,
		now: () => clock,
		log: (line) => logs.push(line),
		auth: { stateDir, ttlMs: 60_000, now: () => clock, loginDelayMs: 5 },
		tickets: { stateDir, now: () => clock },
	});
	const address = await server.listen();
	const base = `http://${address.host}:${address.port}`;
	const exchange = (token: string): Promise<Response> =>
		fetch(`${base}/t?t=${encodeURIComponent(token)}`, { redirect: "manual" });
	try {
		const first = await exchange(tunnel.ticket!);
		const cookie = cookieOf(first);
		check("a valid ticket redirects to /", first.status === 303 && first.headers.get("location") === "/", first.status);
		check("the exchange sets an HttpOnly session cookie", cookie.startsWith(`${DASHBOARD_SESSION_COOKIE}=`) && (first.headers.get("set-cookie") ?? "").includes("HttpOnly"), cookie);
		check("the ticket session has a short TTL", (first.headers.get("set-cookie") ?? "").includes(`Max-Age=${Math.ceil(DASHBOARD_TICKET_SESSION_TTL_MS / 1000)}`), first.headers.get("set-cookie"));
		const page = await fetch(`${base}/`, { headers: { cookie }, redirect: "manual" });
		check("the ticket session authenticates the dashboard", page.status === 200, page.status);
		const reused = await exchange(tunnel.ticket!);
		check("the same ticket cannot be reused", reused.status === 401, reused.status);
		check("a reused ticket sets no cookie", cookieOf(reused) === "", cookieOf(reused));
		check("the ticket value never appears in any log line", !logs.some((line) => line.includes(tunnel.ticket!)), logs.filter((line) => line.includes("ticket")));

		const sessionStatus = await dashboard.status({ thread: PRIVATE_THREAD });
		check("status counts the exchanged external session", sessionStatus.externalSessions === 1, sessionStatus.externalSessions);

		const expiring = await dashboard.open({ thread: PRIVATE_THREAD, mode: "tunnel" });
		check("a second tunnel open reuses the tunnel", tunnelStarts === 1 && expiring.tunnelUrl === TUNNEL_ORIGIN, tunnelStarts);
		check("a second tunnel open mints a new ticket", expiring.ticket !== undefined && expiring.ticket !== tunnel.ticket, expiring.ticket);
		clock += DASHBOARD_TICKET_TTL_MS + 1;
		const expired = await exchange(expiring.ticket!);
		check("an expired ticket is rejected with 403", expired.status === 403, expired.status);
		check("an expired ticket sets no cookie", cookieOf(expired) === "");
	} finally {
		await server.close();
	}

	section("group safety");
	const groupLocal = await dashboard.open({ thread: WORK_GROUP });
	check("an allowlisted work group may use the tool", groupLocal.privateThread === false, groupLocal.privateThread);
	check("a group open defaults to local, not a tunnel", groupLocal.mode === "local" && groupLocal.ticket === undefined, groupLocal);
	check("a group open does not start a tunnel", tunnelStarts === 1, tunnelStarts);
	const groupTunnel = await dashboard.open({ thread: WORK_GROUP, mode: "tunnel" });
	check("a group may request a tunnel explicitly", groupTunnel.mode === "tunnel" && groupTunnel.ticket !== undefined, groupTunnel.mode);
	check("the group ticket is bound to the group thread", (readStateJson().issuances as Array<Record<string, unknown>>).at(-1)!.thread === WORK_GROUP);

	section("close stops external access only");
	const outstanding = await dashboard.open({ thread: PRIVATE_THREAD, mode: "tunnel" });
	const beforeClose = await dashboard.status({ thread: PRIVATE_THREAD });
	const spawnsBeforeClose = spawnCount;
	const closed = await dashboard.close({ thread: PRIVATE_THREAD });
	check("close stops the tunnel", closed.stoppedTunnel === true && tunnelStops === 1, { stoppedTunnel: closed.stoppedTunnel, tunnelStops });
	check("close revokes every session", closed.revokedSessions === beforeClose.externalSessions && closed.revokedSessions >= 1, { closed: closed.revokedSessions, before: beforeClose.externalSessions });
	check("close revokes outstanding tickets", closed.revokedTickets >= 1, closed.revokedTickets);
	check("close leaves the local dashboard running", closed.running === true && closed.localUrl === "http://127.0.0.1:7788", closed);
	check("close does not spawn or kill the local server", spawnCount === spawnsBeforeClose, spawnCount);
	const afterClose = await dashboard.status({ thread: PRIVATE_THREAD });
	check("status after close is local mode", afterClose.running && afterClose.mode === "local", afterClose);
	check("status after close has no tunnel URL or expiry", afterClose.tunnelUrl === null && afterClose.expiresAt === null, afterClose);
	check("status after close reports zero sessions", afterClose.externalSessions === 0, afterClose.externalSessions);
	const revokedServer = createDashboardServer({
		rootDir: root,
		port: 0,
		allowEphemeralPort: true,
		now: () => clock,
		auth: { stateDir, ttlMs: 60_000, now: () => clock, loginDelayMs: 5 },
		tickets: { stateDir, now: () => clock },
	});
	const revokedAddress = await revokedServer.listen();
	try {
		const revoked = await fetch(`http://${revokedAddress.host}:${revokedAddress.port}/t?t=${encodeURIComponent(outstanding.ticket!)}`, { redirect: "manual" });
		check("a ticket issued before close is dead afterwards", revoked.status === 401, revoked.status);
	} finally {
		await revokedServer.close();
	}

	section("status enforces the tunnel deadline");
	const reopened = await dashboard.open({ thread: PRIVATE_THREAD, mode: "tunnel" });
	check("reopening after close starts a fresh tunnel", tunnelStarts === 2, tunnelStarts);
	void reopened;
	clock += 60 * 60_000 + 1;
	const expiredStatus = await dashboard.status({ thread: PRIVATE_THREAD });
	check("an expired tunnel is stopped by status", tunnelStops === 2, tunnelStops);
	check("status reports local mode after the tunnel deadline", expiredStatus.running && expiredStatus.mode === "local", expiredStatus);
	check("status clears the expired tunnel URL", expiredStatus.tunnelUrl === null && expiredStatus.expiresAt === null, expiredStatus);

	section("ticket rate limit per thread");
	let rateClock = clock;
	const store = new DashboardTicketStore(stateDir, () => rateClock);
	const rateThread = "telegram:555777";
	for (let i = 0; i < 3; i += 1) store.issue(rateThread);
	assertThrows("the fourth ticket inside the window is rate-limited", () => store.issue(rateThread), /rate limit/);
	check("another thread keeps its own budget", store.issue(PRIVATE_THREAD).thread === PRIVATE_THREAD);
	const singleUseToken = store.issue("telegram:555888").token;
	const firstConsume = store.consume(singleUseToken);
	const secondConsume = store.consume(singleUseToken);
	check(
		"a ticket is consumed exactly once",
		firstConsume.kind === "ok" && secondConsume.kind === "invalid",
		{ first: firstConsume.kind, second: secondConsume.kind },
	);
	rateClock += 10 * 60_000 + 1;
	check("the rate limit window frees up", store.issue(rateThread).thread === rateThread);

	section("tool surface and thread attribution");
	const toolDeps = {
		config: loaded,
		moduleTools: [],
		log: new Logger({ console: false }),
		dashboard,
		getRun: () => ({
			id: "run-dashboard",
			index: 1,
			startedAt: clock,
			events: [{ seq: 1, kind: "user_message", thread: STRANGER_GROUP, ts: clock }],
			currentThreads: [STRANGER_GROUP],
			outbound: [],
			reminderIds: [],
			noteKeys: [],
			journalEntries: 0,
			idleReturns: 0,
			interruptDeliveries: 0,
			nudges: 0,
			turns: 1,
			promptChars: 10,
			inboundThreads: new Set([STRANGER_GROUP]),
			idling: false,
			idleMs: 0,
			activeMs: 0,
			sleepOffered: false,
			sleepRequested: false,
			sleepForced: false,
			retainedThisRun: false,
		} as unknown as RunHandle),
	} as unknown as ToolDeps;
	const tools = createAliveTools(toolDeps);
	const tool = tools.find((entry) => entry.name === "dashboard");
	check("the runtime exposes a dashboard tool", tool !== undefined, tools.map((entry) => entry.name));
	await assertRejects("the tool refuses a non-allowlisted requesting thread", () => tool!.execute("call-1", { action: "status" }, undefined, undefined, undefined as never), /not available in thread/);
	await assertRejects(
		"the model cannot attribute the call to another allowlisted thread",
		() => tool!.execute("call-2", { action: "status", thread: PRIVATE_THREAD }, undefined, undefined, undefined as never),
		/not one of this run's threads/,
	);

	const privateDeps = {
		...toolDeps,
		getRun: () => ({
			...toolDeps.getRun(),
			events: [{ seq: 1, kind: "user_message", thread: PRIVATE_THREAD, ts: clock }],
			currentThreads: [PRIVATE_THREAD],
		}),
	} as unknown as ToolDeps;
	const privateTool = createAliveTools(privateDeps).find((entry) => entry.name === "dashboard")!;
	const statusResult = await privateTool.execute("call-3", { action: "status" }, undefined, undefined, undefined as never);
	const statusText = statusResult.content.map((part) => (part.type === "text" ? part.text : "")).join("");
	check("the tool reports status from the owner's private thread", /Dashboard is running on port 7788/.test(statusText), statusText);
	const closeResult = await privateTool.execute("call-4", { action: "close" }, undefined, undefined, undefined as never);
	const closeText = closeResult.content.map((part) => (part.type === "text" ? part.text : "")).join("");
	check("the tool close action keeps the local dashboard", /keeps running at http:\/\/127\.0\.0\.1:7788/.test(closeText), closeText);

	section("state file");
	const stateFile = path.join(stateDir, "dashboard", DASHBOARD_STATE_FILE);
	check("the dashboard state file is mode 0600", (fs.statSync(stateFile).mode & 0o777) === 0o600, (fs.statSync(stateFile).mode & 0o777).toString(8));
	const finalState = readDashboardState(stateDir, clock);
	check("the state keeps a bounded Issuance log", finalState.issuances.length <= 50 && finalState.issuances.length > 0, finalState.issuances.length);
	check("no issuance record carries an IP", finalState.issuances.every((entry) => !("ip" in entry)));

	section("summary");
	if (failures > 0) {
		process.stdout.write(`\n${failures} check(s) failed\n`);
		process.exitCode = 1;
		return;
	}
	process.stdout.write("\nall dashboard tool checks passed\n");
}

main()
	.catch((error) => {
		process.stderr.write(`dashboard tool test crashed: ${error instanceof Error ? (error.stack ?? error.message) : String(error)}\n`);
		process.exitCode = 1;
	})
	.finally(() => {
		fs.rmSync(root, { recursive: true, force: true });
	});
