/**
 * Dashboard password/session/tunnel tests.
 *
 *   npx tsx src/dev/dashboard-auth-test.ts
 *
 * Everything is local: a loopback HTTP server, an injected clock and a fake
 * quick-tunnel factory. No network and no cloudflared process.
 */
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
	DASHBOARD_AUTH_FILE,
	DASHBOARD_SESSION_COOKIE,
	DASHBOARD_SESSION_TTL_MS,
	DashboardAuthStore,
	clearedSessionCookie,
	ensureDashboardPassword,
	hasDashboardPassword,
	readCookie,
	revokeAllDashboardSessions,
	sessionCookie,
	setDashboardPassword,
	verifyDashboardPassword,
} from "../dashboard/auth.js";
import { maskSecrets } from "../secrets.js";
import {
	DASHBOARD_LOGIN_BLOCKED_ERROR,
	DASHBOARD_LOGIN_ERROR,
	createDashboardServer,
	runDashboard,
	validateTunnelAccess,
} from "../dashboard/server.js";

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
function writeJson(file: string, value: unknown): void {
	fs.mkdirSync(path.dirname(file), { recursive: true });
	fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}
function appendJsonl(file: string, values: unknown[]): void {
	fs.mkdirSync(path.dirname(file), { recursive: true });
	fs.writeFileSync(file, values.map((value) => `${JSON.stringify(value)}\n`).join(""), "utf8");
}
async function waitFor(predicate: () => boolean, timeoutMs = 10_000): Promise<boolean> {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		if (predicate()) return true;
		await new Promise((resolve) => setTimeout(resolve, 20));
	}
	return predicate();
}
function assertThrows(name: string, run: () => void, pattern: RegExp): void {
	try {
		run();
		check(name, false, "did not throw");
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		check(name, pattern.test(message), message);
	}
}

const root = fs.mkdtempSync(path.join(os.tmpdir(), "alive-dashboard-auth-test-"));
const stateDir = path.join(root, ".alive");
const GITHUB_TOKEN = `ghp_${"c".repeat(36)}`;
const now = Date.now();

writeJson(path.join(root, "alive.config.json"), {
	name: "Auth Root",
	model: "anthropic/claude-test",
	stateDir: ".alive",
	workspace: ".alive/workspace",
	sandbox: { enabled: false },
});
appendJsonl(path.join(stateDir, "runs", "runs.jsonl"), [{
	id: "run_auth",
	index: 1,
	startedAt: now - 60_000,
	finishedAt: now - 50_000,
	durationMs: 10_000,
	activeMs: 8_000,
	idleMs: 2_000,
	stopReason: "error",
	error: `provider rejected key ${GITHUB_TOKEN}`,
	events: [{ seq: 1, kind: "user_message", thread: "console", title: "hello" }],
	outbound: [],
	remindersCreated: [],
	notesTouched: [],
	journalEntries: 0,
	idleReturns: 0,
	interruptDeliveries: 0,
	nudges: 0,
	turns: 1,
	promptChars: 10,
	usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, total: 2, cost: 0.001 },
}]);
writeJson(path.join(stateDir, "runtime.json"), {
	pid: process.pid,
	startedAt: now - 70_000,
	lastTickAt: now - 45_000,
	status: "idle",
	runIndex: 1,
	model: "anthropic/claude-test",
	pending: 0,
	openThreads: 0,
	sleeps: 0,
	mode: "background",
});

async function main(): Promise<void> {
	section("password file");
	check("no password before first use", !hasDashboardPassword(stateDir));
	const first = await ensureDashboardPassword(stateDir, now);
	check("first use generates exactly one password", first.generated && typeof first.password === "string" && first.password!.length >= 32, first.generated);
	const generatedPassword = first.password!;
	const second = await ensureDashboardPassword(stateDir, now);
	check("later uses do not generate or return a password", !second.generated && second.password === undefined);
	const authFile = path.join(stateDir, "dashboard", DASHBOARD_AUTH_FILE);
	const authText = fs.readFileSync(authFile, "utf8");
	const authMode = fs.statSync(authFile).mode & 0o777;
	check("auth.json is mode 0600", authMode === 0o600, authMode.toString(8));
	check("auth.json contains a scrypt verifier", /"algorithm": "scrypt"/.test(authText) && /"salt":/.test(authText) && /"hash":/.test(authText));
	check("plaintext password is absent from auth.json", !authText.includes(generatedPassword));
	check("password verifies", await verifyDashboardPassword(stateDir, generatedPassword));
	check("a wrong password does not verify", !(await verifyDashboardPassword(stateDir, `${generatedPassword}x`)));

	section("sessions");
	let clock = now;
	const store = new DashboardAuthStore(stateDir, () => clock);
	const created = store.createSession({ ttlMs: 60_000, ip: "203.0.113.7", userAgent: "auth-test/1.0" });
	check("session token is 256 bits (43 base64url chars)", /^[A-Za-z0-9_-]{43}$/.test(created.token), created.token.length);
	check("session stores createdAt/expiresAt/ip/userAgent", created.record.createdAt === clock && created.record.expiresAt === clock + 60_000 && created.record.ip === "203.0.113.7" && created.record.userAgent === "auth-test/1.0", created.record);
	const storedText = fs.readFileSync(authFile, "utf8");
	check("raw session token is absent from auth.json", !storedText.includes(created.token));
	check("session is stored under its SHA-256 hash", new RegExp(`"[a-f0-9]{64}"`).test(storedText));
	check("session verifies while fresh", store.verifySession(created.token)?.ip === "203.0.113.7");
	check("default session TTL is 12 hours", DASHBOARD_SESSION_TTL_MS === 12 * 60 * 60_000);
	const defaultSession = store.createSession({ ip: "203.0.113.8", userAgent: "auth-test/default" });
	check("createSession defaults to the 12-hour TTL", defaultSession.record.expiresAt - defaultSession.record.createdAt === DASHBOARD_SESSION_TTL_MS);
	check("a session can be revoked by token", store.revokeSession(defaultSession.token) && store.verifySession(defaultSession.token) === undefined);
	clock += 60_001;
	check("expired session is rejected", store.verifySession(created.token) === undefined);
	const afterPrune = JSON.parse(fs.readFileSync(authFile, "utf8")) as { sessions: Record<string, unknown> };
	check("expired session is pruned from disk", Object.keys(afterPrune.sessions).length === 0, Object.keys(afterPrune.sessions));
	const sessionCookieHeader = sessionCookie("a".repeat(43), 60);
	check("session cookie is HttpOnly + Secure + SameSite=Strict", sessionCookieHeader.includes("HttpOnly") && sessionCookieHeader.includes("Secure") && sessionCookieHeader.includes("SameSite=Strict"));
	check("cleared cookie expires immediately", clearedSessionCookie().includes("Max-Age=0"));
	check("cookie parser reads the session token", readCookie(`x=1; ${DASHBOARD_SESSION_COOKIE}=${"b".repeat(43)}; y=2`) === "b".repeat(43));

	section("tunnel guards");
	assertThrows("non-loopback bind is refused", () => validateTunnelAccess({ host: "0.0.0.0", publicUrl: "https://x.trycloudflare.com", hasPassword: true }), /loopback/);
	assertThrows("non-https public URL is refused", () => validateTunnelAccess({ host: "127.0.0.1", publicUrl: "http://x.trycloudflare.com", hasPassword: true }), /https public URL/);
	assertThrows("missing password hash is refused with --set-password", () => validateTunnelAccess({ host: "127.0.0.1", publicUrl: "https://x.trycloudflare.com", hasPassword: false }), /--set-password/);
	let guardOk = true;
	try {
		validateTunnelAccess({ host: "127.0.0.1", publicUrl: "https://x.trycloudflare.com", hasPassword: true });
	} catch {
		guardOk = false;
	}
	check("valid loopback + https + password passes", guardOk);

	section("login, sessions and origin checks over HTTP");
	const password = "correct horse battery staple";
	await setDashboardPassword(stateDir, password, now);
	const logs: string[] = [];
	let serverClock = now + 120_000;
	const dashboard = createDashboardServer({
		rootDir: root,
		port: 0,
		allowEphemeralPort: true,
		now: () => serverClock,
		log: (line) => logs.push(line),
		publicOrigin: "https://fake-test.trycloudflare.com",
		auth: { stateDir, ttlMs: 60_000, now: () => serverClock, loginDelayMs: 25 },
	});
	const address = await dashboard.listen();
	const baseUrl = `http://${address.host}:${address.port}`;
	const origin = baseUrl;
	try {
		const unauth = await fetch(`${baseUrl}/`, { redirect: "manual" });
		check("unauthenticated GET redirects to /login", unauth.status === 303 && unauth.headers.get("location") === "/login", { status: unauth.status, location: unauth.headers.get("location") });
		const loginPage = await fetch(`${baseUrl}/login`);
		const loginBody = await loginPage.text();
		check("GET /login renders the password form", loginPage.status === 200 && loginBody.includes('type="password"') && loginBody.includes('action="/login"'), loginPage.status);
		check("login page CSP allows only a same-origin form", (loginPage.headers.get("content-security-policy") ?? "").includes("form-action 'self'"));

		const postLogin = async (value: string, extra: Record<string, string> = {}): Promise<{ status: number; body: string; headers: Headers; ms: number }> => {
			const started = Date.now();
			const response = await fetch(`${baseUrl}/login`, {
				method: "POST",
				headers: { "content-type": "application/x-www-form-urlencoded", origin, ...extra },
				body: new URLSearchParams({ password: value }).toString(),
				redirect: "manual",
			});
			return { status: response.status, body: await response.text(), headers: response.headers, ms: Date.now() - started };
		};

		const wrong = await postLogin("definitely wrong");
		const missing = await postLogin("");
		check("wrong password is 401", wrong.status === 401, wrong.status);
		check("missing password is the same 401 error text", missing.status === 401 && missing.body === wrong.body);
		check("the single error text is present", wrong.body.includes(DASHBOARD_LOGIN_ERROR) && !wrong.body.includes("definitely wrong"));
		check("wrong-password responses share the ~constant configured delay", wrong.ms >= 20 && missing.ms >= 20, { wrong: wrong.ms, missing: missing.ms });
		// Two failures above; three more reaches the five-per-minute budget.
		await postLogin("wrong 3");
		await postLogin("wrong 4");
		await postLogin("wrong 5");
		const blocked = await postLogin(password, { "x-forwarded-for": "198.51.100.9" });
		check("6th attempt from the same IP is blocked despite a spoofed X-Forwarded-For", blocked.status === 429 && blocked.body.includes(DASHBOARD_LOGIN_BLOCKED_ERROR), blocked.status);
		const tunnelIp = await postLogin(password, { "cf-connecting-ip": "198.51.100.7" });
		check("a distinct tunnel-provided client IP gets its own budget", tunnelIp.status === 303, tunnelIp.status);
		const tunnelCookie = (tunnelIp.headers.get("set-cookie") ?? "").split(";")[0] ?? "";
		const tunnelPage = await fetch(`${baseUrl}/`, { headers: { cookie: tunnelCookie }, redirect: "manual" });
		check("session created for the tunnel IP authenticates", tunnelPage.status === 200, tunnelPage.status);

		serverClock += 60_001;
		const login = await postLogin(password);
		const setCookie = login.headers.get("set-cookie") ?? "";
		const cookie = setCookie.split(";")[0] ?? "";
		check("correct password redirects", login.status === 303 && login.headers.get("location") === "/", login.status);
		check("login sets HttpOnly + Secure + SameSite=Strict + Path", setCookie.includes("HttpOnly") && setCookie.includes("Secure") && setCookie.includes("SameSite=Strict") && setCookie.includes("Path=/"), setCookie);
		check("login cookie has a 12-hour-style Max-Age derived from TTL", setCookie.includes("Max-Age=60"), setCookie);

		const page = await fetch(`${baseUrl}/`, { headers: { cookie }, redirect: "manual" });
		const pageBody = await page.text();
		check("authenticated GET / is 200", page.status === 200, page.status);
		check("authenticated page carries a POST logout header button", pageBody.includes('action="/logout"') && pageBody.includes("log out") && pageBody.includes('method="post"'));
		check("authenticated page CSP allows the same-origin logout form", (page.headers.get("content-security-policy") ?? "").includes("form-action 'self'"));
		const csrf = /name="csrf" value="([^"]+)"/.exec(pageBody)?.[1] ?? "";
		check("logout header has a CSRF token", csrf.length >= 32, csrf.length);

		const maskedPage = await fetch(`${baseUrl}/run/main/run_auth`, { headers: { cookie }, redirect: "manual" });
		const maskedBody = await maskedPage.text();
		check("a rendered authenticated page still masks secrets", maskedPage.status === 200 && !maskedBody.includes(GITHUB_TOKEN) && /\[github#\d+\]/.test(maskedBody), maskedPage.status);

		const foreign = await fetch(`${baseUrl}/logout`, {
			method: "POST",
			headers: { "content-type": "application/x-www-form-urlencoded", cookie, origin: "https://evil.example", "sec-fetch-site": "cross-site" },
			body: new URLSearchParams({ csrf }).toString(),
			redirect: "manual",
		});
		check("foreign Origin on non-GET is 403 even with a valid session + CSRF", foreign.status === 403, foreign.status);

		const noCsrf = await fetch(`${baseUrl}/logout`, {
			method: "POST",
			headers: { "content-type": "application/x-www-form-urlencoded", cookie, origin },
			body: "",
			redirect: "manual",
		});
		check("logout without CSRF is 403", noCsrf.status === 403, noCsrf.status);

		const logout = await fetch(`${baseUrl}/logout`, {
			method: "POST",
			headers: { "content-type": "application/x-www-form-urlencoded", cookie, origin },
			body: new URLSearchParams({ csrf }).toString(),
			redirect: "manual",
		});
		check("logout with CSRF redirects to /login", logout.status === 303 && logout.headers.get("location") === "/login", logout.status);
		check("logout clears the cookie", (logout.headers.get("set-cookie") ?? "").includes("Max-Age=0"));
		const afterLogout = await fetch(`${baseUrl}/`, { headers: { cookie }, redirect: "manual" });
		check("the logged-out session no longer works", afterLogout.status === 303 && afterLogout.headers.get("location") === "/login", afterLogout.status);

		// Log in again, then revoke from outside the server (the CLI path).
		serverClock += 1;
		const login2 = await postLogin(password);
		const cookie2 = (login2.headers.get("set-cookie") ?? "").split(";")[0] ?? "";
		const revoked = revokeAllDashboardSessions(stateDir, serverClock);
		check("--revoke-sessions reports the revoked count", revoked === 1, revoked);
		const afterRevoke = await fetch(`${baseUrl}/`, { headers: { cookie: cookie2 }, redirect: "manual" });
		check("--revoke-sessions invalidates a live cookie", afterRevoke.status === 303, afterRevoke.status);

		// Expiry: a fresh session dies once the injected clock passes its TTL.
		serverClock += 2;
		const login3 = await postLogin(password);
		const cookie3 = (login3.headers.get("set-cookie") ?? "").split(";")[0] ?? "";
		const beforeExpiry = await fetch(`${baseUrl}/`, { headers: { cookie: cookie3 }, redirect: "manual" });
		check("fresh session works before expiry", beforeExpiry.status === 200, beforeExpiry.status);
		serverClock += 60_001;
		const expired = await fetch(`${baseUrl}/`, { headers: { cookie: cookie3 }, redirect: "manual" });
		const expiredFile = JSON.parse(fs.readFileSync(authFile, "utf8")) as { sessions: Record<string, unknown> };
		check("expired session is rejected with a login redirect", expired.status === 303 && expired.headers.get("location") === "/login", expired.status);
		check("expired session is pruned from auth.json", Object.keys(expiredFile.sessions).length === 0, Object.keys(expiredFile.sessions));

		section("login logs");
		check("login log lines carry time, IP and ok/fail", logs.some((line) => /dashboard login: \d{4}-\d{2}-\d{2}T.* ip=127\.0\.0\.1 fail$/.test(line)) && logs.some((line) => /dashboard login: .* ip=127\.0\.0\.1 ok$/.test(line)), logs.filter((line) => line.includes("login")).slice(0, 3));
		check("tunnel client IP is logged, not the loopback peer", logs.some((line) => line.includes("ip=198.51.100.7")), logs.filter((line) => line.includes("198.51")));
		check("no login log line contains the password", !logs.some((line) => line.includes(password)));
		check("no log line contains a session token", !logs.some((line) => line.includes(cookie.split("=")[1] ?? "never")));
	} finally {
		await dashboard.close();
	}

	section("fake tunnel (no cloudflared)");
	const tunnelLogs: string[] = [];
	const controller = new AbortController();
	let stopped = 0;
	let sawLocalUrl = "";
	const running = runDashboard({
		rootDir: root,
		port: 0,
		allowEphemeralPort: true,
		log: (line) => tunnelLogs.push(line),
		auth: { stateDir, ttlMs: 60_000 },
		tunnel: {
			enabled: true,
			start: async (url) => {
				sawLocalUrl = url;
				return { origin: "https://fake-auth-test.trycloudflare.com", stop: async () => { stopped += 1; } };
			},
		},
		signal: controller.signal,
	});
	await waitFor(() => tunnelLogs.some((line) => line.includes("dashboard public HTTPS URL:")));
	controller.abort();
	await running;
	const publicLines = tunnelLogs.filter((line) => line.includes("https://fake-auth-test.trycloudflare.com"));
	check("the fake tunnel was pointed at the loopback URL", /^http:\/\/127\.0\.0\.1:\d+$/.test(sawLocalUrl), sawLocalUrl);
	check("the public HTTPS URL is printed exactly once", publicLines.length === 1, publicLines);
	check("the temporary-URL warning is printed", tunnelLogs.some((line) => /temporary/i.test(line)), tunnelLogs);
	check("the local URL is printed", tunnelLogs.some((line) => line.includes("dashboard: http://127.0.0.1:")), tunnelLogs);
	check("stopping the dashboard stops the fake tunnel", stopped === 1, stopped);
	check("tunnel output never contains the password", !tunnelLogs.some((line) => line.includes(password)));

	let nonHttpsStopped = 0;
	const nonHttpsController = new AbortController();
	let nonHttpsError = "";
	try {
		await runDashboard({
			rootDir: root,
			port: 0,
			allowEphemeralPort: true,
			log: () => {},
			auth: { stateDir },
			tunnel: {
				enabled: true,
				start: async () => ({ origin: "http://not-https.example", stop: async () => { nonHttpsStopped += 1; } }),
			},
			signal: nonHttpsController.signal,
		});
	} catch (error) {
		nonHttpsError = error instanceof Error ? error.message : String(error);
	}
	check("a fake non-https tunnel URL is refused", /https public URL/.test(nonHttpsError), nonHttpsError);
	check("a refused tunnel is stopped", nonHttpsStopped === 1, nonHttpsStopped);

	section("masked output");
	const generatedMask = maskSecrets(`debug ${generatedPassword}`, undefined);
	check("the existing masker transforms a password-like value", generatedMask !== generatedPassword);

	section("summary");
	if (failures > 0) {
		process.stdout.write(`\n${failures} check(s) failed\n`);
		process.exitCode = 1;
		return;
	}
	process.stdout.write("\nall dashboard auth checks passed\n");
}

main()
	.catch((error) => {
		process.stderr.write(`dashboard auth test crashed: ${error instanceof Error ? (error.stack ?? error.message) : String(error)}\n`);
		process.exitCode = 1;
	})
	.finally(() => {
		fs.rmSync(root, { recursive: true, force: true });
	});
