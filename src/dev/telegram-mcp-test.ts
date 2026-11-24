/**
 * Telegram MCP proxy test (#264, step B):
 *
 *   npx tsx src/dev/telegram-mcp-test.ts
 *
 * Filesystem fixtures and a fake stdio upstream only: no Telegram, no network
 * beyond loopback HTTP. The fake upstream is a node script that speaks
 * newline-delimited JSON-RPC, so the real `telegram mcp` is never needed.
 */
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
	DEFAULT_TELEGRAM_MCP_CONFIG,
	DEFAULT_TELEGRAM_MCP_CONFIRMATION_TTL_MS,
	DEFAULT_TELEGRAM_MCP_WRITE_LIMIT_PER_HOUR,
	DEFAULT_TELEGRAM_MCP_WRITE_TTL_MS,
	MAX_TELEGRAM_MCP_CONFIRMATION_TTL_MS,
	validateTelegramMcpConfirmationRuntimeConfig,
	validateTelegramMcpConfig,
	type TelegramMcpConfig,
	type TelegramMcpProfileConfig,
} from "../modules/telegram/mcp/config.js";
import { DEFAULT_CONFIG, validateTelegramConfig } from "../config.js";
import { telegramMcpAuditFile } from "../modules/telegram/mcp/audit.js";
import { UPSTREAM_ENV_ALLOWLIST, buildUpstreamEnv } from "../modules/telegram/mcp/child.js";
import { TelegramMcpLimitsStore, telegramMcpLimitsFile } from "../modules/telegram/mcp/limits.js";
import { decideTelegramMcpCall } from "../modules/telegram/mcp/policy.js";
import { parseJsonRpcMessage, parseStdioChunk } from "../modules/telegram/mcp/protocol.js";
import { TelegramMcpServer } from "../modules/telegram/mcp/server.js";
import {
	decisionFilePath,
	ensureTicketDir,
	listTickets,
	profileTicketDir,
	readTicket,
	telegramMcpRequestHash,
	telegramMcpTicketRequestKey,
	ticketFilePath,
	writeDecision,
	writeTicket,
	type TelegramMcpTicket,
} from "../modules/telegram/mcp/tickets.js";
import {
	TELEGRAM_MCP_TOKEN_PREFIX,
	TelegramMcpTokenStore,
	telegramMcpTokensFile,
} from "../modules/telegram/mcp/tokens.js";

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

function thrown(fn: () => unknown): string {
	try {
		fn();
	} catch (error) {
		return error instanceof Error ? error.message : String(error);
	}
	return "";
}

function mode(file: string): number {
	return fs.statSync(file).mode & 0o777;
}

const delay = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
const savedEnv = new Map<string, string | undefined>();

function setTestEnv(name: string, value: string): void {
	if (!savedEnv.has(name)) savedEnv.set(name, process.env[name]);
	process.env[name] = value;
}

const root = fs.mkdtempSync(path.join(os.tmpdir(), "alive-telegram-mcp-test-"));
const stateDir = path.join(root, ".alive");
const fakePath = path.join(root, "fake-telegram-mcp.cjs");
const startLog = path.join(root, "starts.jsonl");
const writeLog = path.join(root, "writes.jsonl");
const groupPidFile = path.join(root, "group-pids.jsonl");
const groupTermFile = path.join(root, "group-terms.txt");
const crashMarker = path.join(root, "crashed.once");
const confirmationDir = path.join(root, "confirmation-tickets");
const confirmerDir = profileTicketDir(confirmationDir, "confirmer");
const serverLog: string[] = [];

/** The fake upstream gets its control paths through profile.env, not the proxy env. */
function profileEnv(name: string, extra: Record<string, string> = {}): Record<string, string> {
	return {
		FAKE_START_LOG: startLog,
		FAKE_WRITE_LOG: writeLog,
		FAKE_GROUP_PID_FILE: groupPidFile,
		FAKE_GROUP_TERM_FILE: groupTermFile,
		FAKE_CRASH_MARKER: crashMarker,
		FAKE_ENV_LOG: path.join(root, `env-${name}.json`),
		...extra,
	};
}
const longWriteText = `BEGIN-${"x".repeat(300)}-END-SECRET-SUFFIX`;

const fakeSource = String.raw`
const fs = require("node:fs");
const { spawn } = require("node:child_process");
const profile = process.env.ALIVE_TELEGRAM_MCP_PROFILE || "unknown";
const startLog = process.env.FAKE_START_LOG;
if (startLog) fs.appendFileSync(startLog, JSON.stringify({ profile, pid: process.pid, ts: Date.now() }) + "\n");
if (process.env.FAKE_ENV_LOG) fs.writeFileSync(process.env.FAKE_ENV_LOG, JSON.stringify(process.env));
if (process.env.FAKE_GROUP_PID_FILE) {
	const code = "const fs=require('node:fs');process.on('SIGTERM',()=>{fs.appendFileSync(" +
		JSON.stringify(process.env.FAKE_GROUP_TERM_FILE || "") +
		", 'term:'+process.env.ALIVE_TELEGRAM_MCP_PROFILE+'\\n');process.exit(0);});setInterval(()=>{},1000);";
	const gc = spawn(process.execPath, ["-e", code], { stdio: "ignore" });
	fs.appendFileSync(process.env.FAKE_GROUP_PID_FILE, JSON.stringify({ profile, pid: process.pid, groupChild: gc.pid }) + "\n");
}
process.on("SIGTERM", () => process.exit(0));
function respond(message) { process.stdout.write(JSON.stringify(message) + "\n"); }
let buffer = "";
let serverRequest;
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
	buffer += chunk;
	const lines = buffer.split("\n");
	buffer = lines.pop();
	for (const line of lines) {
		if (!line.trim()) continue;
		let message;
		try { message = JSON.parse(line); } catch { continue; }
		if (message.id !== undefined && message.method === undefined) {
			if (serverRequest && String(message.id) === serverRequest.id) {
				const original = serverRequest.original;
				const code = message.error ? message.error.code : "none";
				serverRequest = undefined;
				respond({ jsonrpc: "2.0", id: original.id, result: { content: [{ type: "text", text: "srv-error:" + code }], structuredContent: { serverRequestError: code } } });
			}
			continue;
		}
		if (message.id === undefined) continue;
		if (message.method === "initialize") {
			respond({ jsonrpc: "2.0", id: message.id, result: { protocolVersion: "2025-06-18", capabilities: { tools: {} }, serverInfo: { name: "fake-telegram", version: "1.0.0" } } });
			continue;
		}
		if (message.method === "tools/list") {
			respond({ jsonrpc: "2.0", id: message.id, result: { tools: [
				{ name: "telegram_help", description: "help", inputSchema: { type: "object", properties: {} } },
				{ name: "telegram_read", description: "read", inputSchema: { type: "object", properties: {} } },
				{ name: "telegram_write", description: "write", inputSchema: { type: "object", properties: {} } }
			] } });
			continue;
		}
		if (message.method !== "tools/call") {
			respond({ jsonrpc: "2.0", id: message.id, error: { code: -32601, message: "unknown method" } });
			continue;
		}
		const params = message.params || {};
		const name = params.name;
		const args = params.arguments || {};
		const text = typeof args.text === "string" ? args.text : "";
		if (text.includes("crash-once") && process.env.FAKE_CRASH_MARKER && !fs.existsSync(process.env.FAKE_CRASH_MARKER)) {
			fs.writeFileSync(process.env.FAKE_CRASH_MARKER, "1");
			process.exit(1);
		}
		if (process.env.FAKE_WRITE_LOG && name === "telegram_write") {
			fs.appendFileSync(process.env.FAKE_WRITE_LOG, JSON.stringify({ profile, args }) + "\n");
		}
		if (args.serverRequest === true) {
			const id = "srv-" + String(message.id);
			serverRequest = { id, original: message };
			respond({ jsonrpc: "2.0", id, method: "sampling/createMessage", params: {} });
			continue;
		}
		const wait = args.slow === true ? 80 : 5;
		setTimeout(() => respond({ jsonrpc: "2.0", id: message.id, result: {
			content: [{ type: "text", text: "fake:" + name + ":" + (args.chat || "") + ":" + text }],
			structuredContent: { name, chat: args.chat || "", text }
		} }), wait);
	}
});
process.stdin.on("end", () => process.exit(0));
setInterval(() => {}, 1000);
`;

let server: TelegramMcpServer | undefined;
let readerToken = "";
let askerToken = "";
let autoToken = "";
let unopenedToken = "";
let expiredToken = "";
let crasherToken = "";
let resolverToken = "";
let burstToken = "";
let guardedToken = "";
let confirmerToken = "";
let limits: TelegramMcpLimitsStore | undefined;
let clockNow = Date.UTC(2026, 0, 1, 12, 0, 0);

async function rpc(
	token: string | undefined,
	body: Record<string, unknown>,
	connection?: string,
): Promise<{ status: number; body: Record<string, unknown> }> {
	const headers: Record<string, string> = { "content-type": "application/json" };
	if (token !== undefined) headers.authorization = `Bearer ${token}`;
	if (connection !== undefined) headers["x-alive-connection"] = connection;
	const response = await fetch(`${server!.url}`, { method: "POST", headers, body: JSON.stringify(body) });
	const text = await response.text();
	let parsed: Record<string, unknown> = {};
	try {
		parsed = text ? (JSON.parse(text) as Record<string, unknown>) : {};
	} catch {
		parsed = { raw: text };
	}
	return { status: response.status, body: parsed };
}

function call(token: string, id: string | number, name: string, args: Record<string, unknown>, connection?: string) {
	return rpc(token, { jsonrpc: "2.0", id, method: "tools/call", params: { name, arguments: args } }, connection);
}

function decisionOf(body: Record<string, unknown>): string | undefined {
	const result = body.result as { structuredContent?: { decision?: string } } | undefined;
	return result?.structuredContent?.decision;
}

function textOf(body: Record<string, unknown>): string {
	const result = body.result as { content?: Array<{ text?: string }> } | undefined;
	return result?.content?.map((item) => item.text ?? "").join("") ?? "";
}

function readJsonl(file: string): Array<Record<string, unknown>> {
	if (!fs.existsSync(file)) return [];
	return fs
		.readFileSync(file, "utf8")
		.split("\n")
		.filter((line) => line.trim())
		.map((line) => JSON.parse(line) as Record<string, unknown>);
}

function pidAlive(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch {
		return false;
	}
}

async function waitFor(predicate: () => boolean, timeoutMs = 3_000): Promise<boolean> {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		if (predicate()) return true;
		await delay(10);
	}
	return predicate();
}

function ticketsWithText(text: string): TelegramMcpTicket[] {
	return listTickets(confirmerDir).filter((ticket) => ticket.text === text);
}

function decisionFor(ticket: TelegramMcpTicket, decision: "approve" | "deny", overrides: Partial<Record<string, unknown>> = {}) {
	return {
		version: 1,
		ticketId: ticket.ticketId,
		nonce: ticket.nonce,
		requestHash: ticket.requestHash,
		decision,
		decidedAt: clockNow,
		userId: 7,
		...overrides,
	};
}

try {
	fs.writeFileSync(fakePath, fakeSource);
	// Parent-only markers: the proxy must not pass these to the upstream child.
	setTestEnv("ALIVE_TEST_SECRET", "must-not-reach-the-child");
	setTestEnv("ALIVE_TEST_GITHUB_TOKEN", "ghs_must-not-reach-the-child");
	setTestEnv("ALIVE_TELEGRAM_MCP_TOKEN", "bearer-proxy-marker");
	setTestEnv("TELEGRAM_MCP_TOKEN", "bearer-proxy-marker");
	setTestEnv("TELEGRAM_FOO", "arbitrary-telegram-prefix-must-not-pass");
	setTestEnv("LC_ALIVE_TEST", "arbitrary-lc-prefix-must-not-pass");
	setTestEnv("XDG_ALIVE_TEST", "arbitrary-xdg-prefix-must-not-pass");
	// Set every exact allowlist name so the child dump can prove exact matching.
	for (const name of UPSTREAM_ENV_ALLOWLIST) {
		if (name === "PATH") continue;
		setTestEnv(name, name === "LANG" ? "parent-lang" : `${name}-marker`);
	}

	section("config: defaults and validation");
	{
		const defaults = validateTelegramMcpConfig(DEFAULT_TELEGRAM_MCP_CONFIG);
		check("default is disabled", defaults.enabled === false && DEFAULT_CONFIG.modules.telegram.mcp?.enabled === false, defaults);
		check("default host is loopback", defaults.host === "127.0.0.1" && defaults.port === 8787, defaults);
		check("default has no profiles", defaults.profiles.length === 0, defaults);
		check(
			"profile defaults are write:ask, empty allowlist, 15m TTL and 20/hour",
			(() => {
				const parsed = validateTelegramMcpConfig({
					enabled: true,
					profiles: [{ name: "alice" }],
				});
				const profile = parsed.profiles[0]!;
				return (
					profile.mode === "write:ask" &&
					profile.allowChats.length === 0 &&
					profile.writeTtlMs === DEFAULT_TELEGRAM_MCP_WRITE_TTL_MS &&
					profile.writeLimitPerHour === DEFAULT_TELEGRAM_MCP_WRITE_LIMIT_PER_HOUR &&
					profile.command === "telegram" &&
					profile.args.join(" ") === "mcp"
				);
			})(),
		);
		const withEnv = validateTelegramMcpConfig({
			enabled: true,
			profiles: [{ name: "alice", env: { TELEGRAM_SESSION: "fixture", EMPTY: "" } }],
		});
		check(
			"a flat string env map is kept",
			withEnv.profiles[0]?.env?.TELEGRAM_SESSION === "fixture" && withEnv.profiles[0]?.env?.EMPTY === "",
			withEnv.profiles[0]?.env,
		);
		const bad = [
			["non-object", 42, "must be an object"],
			["enabled type", { enabled: "yes", profiles: [] }, "enabled must be true or false"],
			["port range", { enabled: true, port: 0, profiles: [] }, "port must be"],
			["profiles type", { enabled: true, profiles: {} }, "profiles must be an array"],
			["duplicate names", { enabled: true, profiles: [{ name: "a" }, { name: "a" }] }, "duplicate"],
			["bad name", { enabled: true, profiles: [{ name: "a/b" }] }, "name must contain"],
			["bad mode", { enabled: true, profiles: [{ name: "a", mode: "admin" }] }, "mode must be"],
			["allowChats type", { enabled: true, profiles: [{ name: "a", allowChats: "1" }] }, "allowChats must be"],
			["ttl", { enabled: true, profiles: [{ name: "a", writeTtlMs: 0 }] }, "writeTtlMs must be"],
			["limit", { enabled: true, profiles: [{ name: "a", writeLimitPerHour: -1 }] }, "writeLimitPerHour must be"],
			["args", { enabled: true, profiles: [{ name: "a", args: [1] }] }, "args must be an array of strings"],
			["env type", { enabled: true, profiles: [{ name: "a", env: "X=1" }] }, "env must be an object"],
			["env number", { enabled: true, profiles: [{ name: "a", env: { PORT: 1 } }] }, "env.PORT must be a string"],
			["env nested", { enabled: true, profiles: [{ name: "a", env: { BAD: { nested: true } } }] }, "env.BAD must be a string"],
			["env empty key", { enabled: true, profiles: [{ name: "a", env: { " ": "x" } }] }, "empty variable name"],
		] as const;
		for (const [label, value, expected] of bad) {
			const message = thrown(() => validateTelegramMcpConfig(value));
			check(`${label} is rejected`, message.includes(expected), message || "accepted");
		}

		const defaultConfirmation = validateTelegramMcpConfig({ enabled: true, profiles: [{ name: "alice" }] }).profiles[0]?.confirmation;
		check("confirmation is absent by default (old ask is unchanged)", defaultConfirmation === undefined, defaultConfirmation);
		const withConfirmation = validateTelegramMcpConfig({
			enabled: true,
			profiles: [{ name: "alice", confirmation: { ticketDir: "telegram-mcp-tickets" } }],
		});
		check(
			"confirmation keeps a relative ticketDir and defaults to a 5 minute TTL",
			withConfirmation.profiles[0]?.confirmation?.ticketDir === "telegram-mcp-tickets" &&
				withConfirmation.profiles[0]?.confirmation?.ttlMs === DEFAULT_TELEGRAM_MCP_CONFIRMATION_TTL_MS,
			withConfirmation.profiles[0]?.confirmation,
		);
		const maxConfirmation = validateTelegramMcpConfig({
			enabled: true,
			profiles: [{ name: "alice", confirmation: { ticketDir: "/var/tmp/tickets", ttlMs: MAX_TELEGRAM_MCP_CONFIRMATION_TTL_MS } }],
		});
		check(
			"an absolute ticketDir and the 1 hour maximum are accepted",
			maxConfirmation.profiles[0]?.confirmation?.ticketDir === "/var/tmp/tickets" &&
				maxConfirmation.profiles[0]?.confirmation?.ttlMs === MAX_TELEGRAM_MCP_CONFIRMATION_TTL_MS,
			maxConfirmation.profiles[0]?.confirmation,
		);
		const badConfirmation = [
			["not an object", { ticketDir: "x", confirmation: "yes" }, "confirmation must be an object"],
			["missing ticketDir", { ticketDir: "x", confirmation: {} }, "confirmation.ticketDir must be"],
			["empty ticketDir", { ticketDir: "x", confirmation: { ticketDir: "  " } }, "confirmation.ticketDir must be"],
			["zero ttl", { ticketDir: "x", confirmation: { ticketDir: "x", ttlMs: 0 } }, "confirmation.ttlMs must be"],
			["non-integer ttl", { ticketDir: "x", confirmation: { ticketDir: "x", ttlMs: 1.5 } }, "confirmation.ttlMs must be"],
			["ttl over one hour", { ticketDir: "x", confirmation: { ticketDir: "x", ttlMs: MAX_TELEGRAM_MCP_CONFIRMATION_TTL_MS + 1 } }, "confirmation.ttlMs must be"],
		] as const;
		for (const [label, value, expected] of badConfirmation) {
			const message = thrown(() => validateTelegramMcpConfig({ enabled: true, profiles: [{ name: "alice", ...(value as object) }] }));
			check(`${label} is rejected`, message.includes(expected), message || "accepted");
		}

		const runtimeConfirmation = validateTelegramMcpConfirmationRuntimeConfig({ ticketDir: "tickets", chatId: 42, operatorUserIds: [7] });
		check(
			"runtime confirmation defaults to a 2 second poll",
			runtimeConfirmation.ticketDir === "tickets" && runtimeConfirmation.pollMs === 2_000 &&
				runtimeConfirmation.chatId === 42 && runtimeConfirmation.operatorUserIds.join(",") === "7",
			runtimeConfirmation,
		);
		const noRuntimeConfirmation = validateTelegramConfig({ ...DEFAULT_CONFIG.modules.telegram, mcpConfirmation: undefined });
		check("runtime confirmation is disabled when the option is absent", noRuntimeConfirmation.mcpConfirmation === undefined);
		const withRuntimeConfirmation = validateTelegramConfig({
			...DEFAULT_CONFIG.modules.telegram,
			mcpConfirmation: { ticketDir: "tickets", chatId: 42, operatorUserIds: [7, 8], pollMs: 25 },
		});
		check(
			"runtime confirmation accepts ticketDir, chatId, operatorUserIds and pollMs",
			withRuntimeConfirmation.mcpConfirmation?.ticketDir === "tickets" &&
				withRuntimeConfirmation.mcpConfirmation?.chatId === 42 &&
				withRuntimeConfirmation.mcpConfirmation?.operatorUserIds.join(",") === "7,8" &&
				withRuntimeConfirmation.mcpConfirmation?.pollMs === 25,
			withRuntimeConfirmation.mcpConfirmation,
		);
		for (const [label, value, expected] of [
			["non-object runtime confirmation", "yes", "mcpConfirmation must be an object"],
			["missing runtime ticketDir", {}, "mcpConfirmation.ticketDir must be"],
			["missing runtime chatId", { ticketDir: "tickets", operatorUserIds: [7] }, "mcpConfirmation.chatId must be"],
			["empty operatorUserIds", { ticketDir: "tickets", chatId: 42, operatorUserIds: [] }, "mcpConfirmation.operatorUserIds must be"],
			["string operator id", { ticketDir: "tickets", chatId: 42, operatorUserIds: ["7"] }, "mcpConfirmation.operatorUserIds must contain"],
			["duplicate operator id", { ticketDir: "tickets", chatId: 42, operatorUserIds: [7, 7] }, "must not contain duplicates"],
			["zero pollMs", { ticketDir: "tickets", chatId: 42, operatorUserIds: [7], pollMs: 0 }, "mcpConfirmation.pollMs must be"],
		] as const) {
			const message = thrown(() => validateTelegramConfig({ ...DEFAULT_CONFIG.modules.telegram, mcpConfirmation: value as never }));
			check(`${label} is rejected`, message.includes(expected), message || "accepted");
		}
	}

	section("tokens: per-profile file, permissions and revocation isolation");
	{
		const store = new TelegramMcpTokenStore(stateDir);
		const a = store.issue("alice");
		const b = store.issue("bob");
		check("token has the expected prefix", a.startsWith(TELEGRAM_MCP_TOKEN_PREFIX) && a.length > 40, a.length);
		check("tokens differ", a !== b);
		check("tokens.json is 0600", mode(telegramMcpTokensFile(stateDir)) === 0o600, mode(telegramMcpTokensFile(stateDir)));
		check("telegram-mcp directory is 0700", mode(path.dirname(telegramMcpTokensFile(stateDir))) === 0o700);
		check("resolve finds the issuing profile", store.resolve(a) === "alice" && store.resolve(b) === "bob");
		check("an unknown token resolves to nothing", store.resolve("alive_tg_unknown") === undefined);
		check("revoking bob keeps alice", store.revoke("bob") === true && store.resolve(a) === "alice" && store.resolve(b) === undefined);
		const onDisk = fs.readFileSync(telegramMcpTokensFile(stateDir), "utf8");
		check("the file stores hashes, never the plaintext tokens", !onDisk.includes(a) && !onDisk.includes(b), onDisk.slice(0, 40));
		check("revoking a missing profile reports false", store.revoke("carol") === false);
	}

	section("protocol: newline framing is isolated in parseStdioChunk");
	{
		const first = parseStdioChunk('{"jsonrpc":"2.0","id":1,"method":"tools/list"}\r\n{"jsonrpc":"2.0","id":2,"meth');
		check("a complete CRLF line is parsed", first.messages.length === 1 && first.messages[0] && "method" in first.messages[0], first.messages);
		check("the incomplete tail is kept for the next chunk", first.rest === '{"jsonrpc":"2.0","id":2,"meth', first.rest);
		const second = parseStdioChunk(`${first.rest}od":"tools/call"}\nnot-json\n\n{"jsonrpc":"2.0","id":3,"result":{}}\n`);
		check("the split line is completed by the next chunk", second.messages.length === 2 && second.messages[0] && "method" in second.messages[0]);
		check("a bad line is reported, not thrown", second.errors.length === 1, second.errors);
		check("an empty line is ignored", second.messages.length === 2, second.messages);
		check("a non-JSON-RPC object is rejected", parseJsonRpcMessage({ jsonrpc: "1.0", id: 1, method: "x" }) === undefined);
		check("a response is recognised", parseJsonRpcMessage({ jsonrpc: "2.0", id: "a", result: {} }) !== undefined);
	}

	const profiles: TelegramMcpProfileConfig[] = [
		{ name: "reader", mode: "read", allowChats: ["111"], writeTtlMs: 60_000, writeLimitPerHour: 2, command: process.execPath, args: [fakePath], env: profileEnv("reader", { PROFILE_ONLY: "from-profile", LANG: "profile-lang" }) },
		{ name: "asker", mode: "write:ask", allowChats: ["111"], writeTtlMs: 60_000, writeLimitPerHour: 2, command: process.execPath, args: [fakePath], env: profileEnv("asker") },
		{ name: "autowriter", mode: "write:auto", allowChats: ["111"], writeTtlMs: 60_000, writeLimitPerHour: 2, command: process.execPath, args: [fakePath], env: profileEnv("autowriter") },
		{ name: "unopened", mode: "write:auto", allowChats: ["111"], writeTtlMs: 60_000, writeLimitPerHour: 2, command: process.execPath, args: [fakePath], env: profileEnv("unopened") },
		{ name: "expired", mode: "write:auto", allowChats: ["111"], writeTtlMs: 1_000, writeLimitPerHour: 2, command: process.execPath, args: [fakePath], env: profileEnv("expired") },
		{ name: "crasher", mode: "read", allowChats: ["111"], writeTtlMs: 60_000, writeLimitPerHour: 2, command: process.execPath, args: [fakePath], env: profileEnv("crasher") },
		{ name: "resolver", mode: "write:auto", allowChats: ["111"], writeTtlMs: 60_000, writeLimitPerHour: 20, command: process.execPath, args: [fakePath], env: profileEnv("resolver") },
		{ name: "burst", mode: "write:auto", allowChats: ["111"], writeTtlMs: 60_000, writeLimitPerHour: 3, command: process.execPath, args: [fakePath], env: profileEnv("burst") },
		{ name: "guarded", mode: "write:auto", allowChats: ["123"], writeTtlMs: 60_000, writeLimitPerHour: 5, command: process.execPath, args: [fakePath], env: profileEnv("guarded") },
		{
			name: "confirmer",
			mode: "write:ask",
			allowChats: ["111"],
			writeTtlMs: 60_000,
			writeLimitPerHour: 5,
			confirmation: { ticketDir: confirmationDir, ttlMs: 60_000 },
			command: process.execPath,
			args: [fakePath],
			env: profileEnv("confirmer"),
		},
	];
	const config: TelegramMcpConfig = { enabled: true, host: "127.0.0.1", port: 8787, profiles };

	// Start-of-proxy fixtures: a stale ticket+decision and a `sending` ticket.
	ensureTicketDir(confirmerDir);
	const fixtureTicket = (ticketId: string, createdAt: number, expiresAt: number, status: TelegramMcpTicket["status"]): TelegramMcpTicket => ({
		version: 1,
		ticketId,
		profile: "confirmer",
		tool: "telegram_write",
		chat: "111",
		text: `fixture-${ticketId}`,
		createdAt,
		expiresAt,
		nonce: `nonce-${ticketId}`,
		status,
		requestHash: telegramMcpRequestHash({ chat: "111", text: `fixture-${ticketId}` }),
		requestKey: `key-${ticketId}`,
	});
	const staleFixture = fixtureTicket("tgask_1111111111111111", clockNow - 180_000, clockNow - 120_000, "expired");
	const interruptedFixture = fixtureTicket("tgask_2222222222222222", clockNow - 1_000, clockNow + 60_000, "sending");
	writeTicket(confirmerDir, staleFixture);
	writeDecision(confirmerDir, decisionFor(staleFixture, "approve") as Parameters<typeof writeDecision>[1]);
	writeTicket(confirmerDir, interruptedFixture);

	section("policy: pure decisions");
	{
		const profile = profiles[2]!;
		const open = { windowActive: true, windowExpiresAt: clockNow + 60_000, writesThisHour: 0 };
		check("tools/list is always allowed", decideTelegramMcpCall({ profile, tool: "tools/list", args: {}, now: clockNow, limits: open }).decision === "allow");
		check("telegram_help is always allowed", decideTelegramMcpCall({ profile, tool: "telegram_help", args: {}, now: clockNow, limits: open }).decision === "allow");
		check(
			"read inside allowChats is allowed",
			decideTelegramMcpCall({ profile, tool: "telegram_read", args: { chat: "111" }, now: clockNow, limits: open }).decision === "allow",
		);
		const outside = decideTelegramMcpCall({ profile, tool: "telegram_read", args: { chat: "222" }, now: clockNow, limits: open });
		check("read outside allowChats is denied with the allowed value", outside.decision === "deny" && outside.reason.includes('"111"') && outside.reason.includes("allowChats"), outside);
		check(
			"an unknown tool is denied with the allowed list",
			(() => {
				const decision = decideTelegramMcpCall({ profile, tool: "telegram_delete_all", args: {}, now: clockNow, limits: open });
				return decision.decision === "deny" && decision.reason.includes("telegram_help, telegram_read, telegram_write");
			})(),
		);
		const unresolved = decideTelegramMcpCall({ profile, tool: "telegram_write", args: {}, now: clockNow, limits: open });
		check(
			"write with allowChats and an unresolved chat is denied",
			unresolved.decision === "deny" && unresolved.reason.includes("cannot resolve target chat") && unresolved.reason.includes('"111"'),
			unresolved,
		);
		const objectChat = decideTelegramMcpCall({
			profile,
			tool: "telegram_write",
			args: { chat: { id: "111" } },
			now: clockNow,
			limits: open,
		});
		check("write with a nested chat object is denied, not guessed", objectChat.decision === "deny" && objectChat.reason.includes("cannot resolve target chat"), objectChat);
		for (const [label, args] of [
			["numeric chat", { chat: 111 }],
			["to string", { to: "111" }],
			["recipient string", { recipient: "111" }],
		] as const) {
			const decision = decideTelegramMcpCall({ profile, tool: "telegram_write", args, now: clockNow, limits: open });
			check(`write resolves ${label}`, decision.decision === "allow" && decision.chat === "111", decision);
		}
		const unrestricted = decideTelegramMcpCall({
			profile: { ...profile, allowChats: [] },
			tool: "telegram_write",
			args: {},
			now: clockNow,
			limits: open,
		});
		check("an empty allowChats keeps the old write behaviour", unrestricted.decision === "allow", unrestricted);
		const nonMatchingWrite = { ...profile, allowChats: ["123"] };
		for (const [label, args] of [
			["chat", { chat: "999" }],
			["to", { to: "999" }],
			["recipient", { recipient: "999" }],
		] as const) {
			const decision = decideTelegramMcpCall({
				profile: nonMatchingWrite,
				tool: "telegram_write",
				args,
				now: clockNow,
				limits: open,
			});
			check(
				`write via ${label} with a non-matching string is denied`,
				decision.decision === "deny" && decision.reason.includes('"123"') && decision.reason.includes("allowChats"),
				decision,
			);
		}
		const nonMatchingRead = decideTelegramMcpCall({
			profile: nonMatchingWrite,
			tool: "telegram_read",
			args: { chat: "999" },
			now: clockNow,
			limits: open,
		});
		check(
			"read with a non-matching string is denied",
			nonMatchingRead.decision === "deny" && nonMatchingRead.reason.includes('"123"') && nonMatchingRead.reason.includes("allowChats"),
			nonMatchingRead,
		);
		for (const [modeName, mode] of [
			["read", "read"],
			["write:ask", "write:ask"],
			["write:auto", "write:auto"],
		] as const) {
			const target = { ...profile, mode };
			const blacklist = [
				["mass", { recipients: ["1", "2"] }],
				["invite", { action: "invite_user" }],
				["camelCase invite", { action: "inviteUser" }],
				["join", { action: "join_chat" }],
				["camelCase join", { action: "joinChat" }],
				["delete", { action: "delete_chat" }],
				["camelCase delete", { action: "deleteChat" }],
			] as const;
			for (const [label, args] of blacklist) {
				const decision = decideTelegramMcpCall({ profile: target, tool: "telegram_write", args, now: clockNow, limits: open });
				check(`${label} is denied in ${modeName}`, decision.decision === "deny", decision);
			}
		}
	}

	section("limits: TTL and hourly counter with an injected clock");
	{
		const fixture = path.join(root, "limits-fixture");
		limits = new TelegramMcpLimitsStore(fixture, { clock: () => clockNow });
		check("a fresh profile has no window", limits.snapshot("a", clockNow).windowActive === false);
		limits.openWindow("a", 1_000, clockNow);
		check("an opened window is active", limits.snapshot("a", clockNow).windowActive === true);
		clockNow += 1_500;
		check("an expired window is inactive", limits.snapshot("a", clockNow).windowActive === false);
		limits.recordWrite("a", clockNow);
		limits.recordWrite("a", clockNow);
		check("writes are counted in the hour", limits.snapshot("a", clockNow).writesThisHour === 2);
		clockNow += 60 * 60_000;
		check("the counter rolls over after an hour", limits.snapshot("a", clockNow).writesThisHour === 0);
		check("limits.json is 0600", mode(telegramMcpLimitsFile(fixture)) === 0o600, mode(telegramMcpLimitsFile(fixture)));
		const reserveStore = new TelegramMcpLimitsStore(path.join(root, "limits-reserve"), { clock: () => clockNow });
		reserveStore.openWindow("b", 60_000, clockNow);
		const first = reserveStore.reserveWrite("b", 2, clockNow);
		const second = reserveStore.reserveWrite("b", 2, clockNow);
		const third = reserveStore.reserveWrite("b", 2, clockNow);
		check(
			"reserveWrite checks and counts in one step",
			first.allowed && second.allowed && !third.allowed && third.reason?.includes("write limit") === true,
			{ first, second, third },
		);
		clockNow = Date.UTC(2026, 0, 1, 12, 0, 0);
		limits = new TelegramMcpLimitsStore(stateDir, { clock: () => clockNow });
		limits.openWindow("autowriter", 60_000, clockNow);
		limits.openWindow("expired", 1_000, clockNow - 5_000);
		limits.openWindow("resolver", 60_000, clockNow);
		limits.openWindow("burst", 60_000, clockNow);
		limits.openWindow("guarded", 60_000, clockNow);
	}

	section("server: transport, auth and policy");
	{
		const tokens = new TelegramMcpTokenStore(stateDir);
		readerToken = tokens.issue("reader");
		askerToken = tokens.issue("asker");
		autoToken = tokens.issue("autowriter");
		unopenedToken = tokens.issue("unopened");
		expiredToken = tokens.issue("expired");
		crasherToken = tokens.issue("crasher");
		resolverToken = tokens.issue("resolver");
		burstToken = tokens.issue("burst");
		guardedToken = tokens.issue("guarded");
		confirmerToken = tokens.issue("confirmer");
		server = new TelegramMcpServer({
			config,
			stateDir,
			port: 0,
			limits,
			confirmationPollMs: 10,
			log: (line) => serverLog.push(line),
			child: { initialRestartMs: 100, maxRestartMs: 400 },
		});
		await server.start();
		check("the server listens on an ephemeral loopback port", server.port > 0, server.port);
		check(
			"start removes tickets and decisions older than their TTL",
			!fs.existsSync(ticketFilePath(confirmerDir, staleFixture.ticketId)) &&
				!fs.existsSync(decisionFilePath(confirmerDir, staleFixture.ticketId)),
			fs.readdirSync(confirmerDir),
		);
		check(
			"start fails a ticket interrupted in sending instead of retrying it",
			readTicket(confirmerDir, interruptedFixture.ticketId)?.status === "failed" &&
				String(readTicket(confirmerDir, interruptedFixture.ticketId)?.error).includes("not retried"),
			readTicket(confirmerDir, interruptedFixture.ticketId),
		);

		const noToken = await rpc(undefined, { jsonrpc: "2.0", id: 1, method: "tools/list" });
		check("no token gets 401", noToken.status === 401, noToken);
		const wrongToken = await rpc("alive_tg_wrong", { jsonrpc: "2.0", id: 1, method: "tools/list" });
		check("an unknown token gets 401", wrongToken.status === 401, wrongToken);
		const notFound = await fetch(`http://127.0.0.1:${server.port}/other`, { method: "POST" });
		check("another path gets 404", notFound.status === 404, notFound.status);
		const getMcp = await fetch(`http://127.0.0.1:${server.port}/mcp`, {
			headers: { authorization: `Bearer ${readerToken}` },
		});
		check("GET /mcp answers 405 (pi opens no SSE stream)", getMcp.status === 405, getMcp.status);

		const init = await rpc(readerToken, {
			jsonrpc: "2.0",
			id: "init-1",
			method: "initialize",
			params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "test", version: "1" } },
		});
		check("initialize passes through", init.status === 200 && !!init.body.result, init.body);
		const initialized = await rpc(readerToken, { jsonrpc: "2.0", method: "notifications/initialized" });
		check("notifications are acknowledged with 202", initialized.status === 202, initialized.status);
		const list = await rpc(readerToken, { jsonrpc: "2.0", id: "list-1", method: "tools/list" });
		const tools = (list.body.result as { tools?: Array<{ name?: string }> } | undefined)?.tools ?? [];
		check("tools/list passes through with exactly 3 tools", list.status === 200 && tools.length === 3, tools);

		const readAllowed = await call(readerToken, "read-1", "telegram_read", { chat: "111" });
		check("telegram_read inside allowChats is forwarded", textOf(readAllowed.body).startsWith("fake:telegram_read:111:"), readAllowed.body);
		const readDenied = await call(readerToken, "read-2", "telegram_read", { chat: "222" });
		check(
			"telegram_read outside allowChats is denied with a clear reason",
			decisionOf(readDenied.body) === "deny" && textOf(readDenied.body).includes("allowChats") && textOf(readDenied.body).includes('"111"'),
			readDenied.body,
		);
		const readNoChat = await call(readerToken, "read-3", "telegram_read", {});
		check("telegram_read without a chat is denied", decisionOf(readNoChat.body) === "deny" && textOf(readNoChat.body).includes("chat argument"), readNoChat.body);

		const readModeWrite = await call(readerToken, "rw-1", "telegram_write", { chat: "111", text: "nope" });
		check("telegram_write in mode read is denied", decisionOf(readModeWrite.body) === "deny" && textOf(readModeWrite.body).includes("read-only"), readModeWrite.body);

		const asked = await call(askerToken, "ask-1", "telegram_write", { chat: "111", text: longWriteText });
		const askStructured = (asked.body.result as { structuredContent?: { ticketId?: string } } | undefined)?.structuredContent;
		check(
			"telegram_write in write:ask asks with a ticket id",
			decisionOf(asked.body) === "ask" && typeof askStructured?.ticketId === "string" && askStructured.ticketId.startsWith("tgask_"),
			asked.body,
		);
		const askerWrites = readJsonl(writeLog).filter((entry) => entry.profile === "asker");
		check("write:ask never reaches the upstream", askerWrites.length === 0, askerWrites);

		const unresolved = await call(resolverToken, "res-0", "telegram_write", { text: "no chat" });
		check(
			"write:auto with an unresolved chat is denied before the upstream",
			decisionOf(unresolved.body) === "deny" && textOf(unresolved.body).includes("cannot resolve target chat"),
			unresolved.body,
		);
		const objectChat = await call(resolverToken, "res-object", "telegram_write", { chat: { id: "111" }, text: "nested" });
		check(
			"write:auto with a chat object is denied, not guessed",
			decisionOf(objectChat.body) === "deny" && textOf(objectChat.body).includes("cannot resolve target chat"),
			objectChat.body,
		);
		const numericChat = await call(resolverToken, "res-number", "telegram_write", { chat: 111, text: "numeric" });
		const toChat = await call(resolverToken, "res-to", "telegram_write", { to: "111", text: "to-string" });
		const recipientChat = await call(resolverToken, "res-recipient", "telegram_write", { recipient: "111", text: "recipient-string" });
		check(
			"a numeric chat, to and recipient resolve to an allowChats entry",
			textOf(numericChat.body).startsWith("fake:telegram_write:111:numeric") &&
				textOf(toChat.body).startsWith("fake:telegram_write:") &&
				textOf(recipientChat.body).startsWith("fake:telegram_write:"),
			[numericChat.body, toChat.body, recipientChat.body],
		);
		const resolverWrites = readJsonl(writeLog).filter((entry) => entry.profile === "resolver");
		check("only calls with a resolved allowed chat reached the upstream", resolverWrites.length === 3, resolverWrites.length);

		for (const [label, args] of [
			["chat", { chat: "999", text: "no-match-chat" }],
			["to", { to: "999", text: "no-match-to" }],
			["recipient", { recipient: "999", text: "no-match-recipient" }],
		] as const) {
			const denied = await call(guardedToken, `guarded-${label}`, "telegram_write", args);
			check(
				`guarded write via ${label} with a non-matching string is denied`,
				decisionOf(denied.body) === "deny" && textOf(denied.body).includes('"123"'),
				denied.body,
			);
		}
		const guardedRead = await call(guardedToken, "guarded-read", "telegram_read", { chat: "999" });
		check(
			"guarded read with a non-matching string is denied",
			decisionOf(guardedRead.body) === "deny" && textOf(guardedRead.body).includes('"123"'),
			guardedRead.body,
		);
		const guardedWrites = readJsonl(writeLog).filter((entry) => entry.profile === "guarded");
		check("no guarded write reached the upstream", guardedWrites.length === 0, guardedWrites);

		const unopened = await call(unopenedToken, "auto-0", "telegram_write", { chat: "111", text: "no window" });
		check(
			"write:auto without an open TTL window is denied",
			decisionOf(unopened.body) === "deny" && textOf(unopened.body).includes("write window"),
			unopened.body,
		);
		const outsideWrite = await call(autoToken, "auto-outside", "telegram_write", { chat: "222", text: "elsewhere" });
		check(
			"telegram_write outside allowChats is denied",
			decisionOf(outsideWrite.body) === "deny" && textOf(outsideWrite.body).includes("allowChats"),
			outsideWrite.body,
		);
		const auto1 = await call(autoToken, "auto-1", "telegram_write", { chat: "111", text: "one" });
		const auto2 = await call(autoToken, "auto-2", "telegram_write", { chat: "111", text: "two" });
		check("write:auto allows writes within the limit", textOf(auto1.body).startsWith("fake:telegram_write:111:one") && textOf(auto2.body).startsWith("fake:telegram_write:111:two"), [auto1.body, auto2.body]);
		const auto3 = await call(autoToken, "auto-3", "telegram_write", { chat: "111", text: "three" });
		check(
			"write:auto denies the write over the hourly limit",
			decisionOf(auto3.body) === "deny" && textOf(auto3.body).includes("write limit"),
			auto3.body,
		);
		const autoWrites = readJsonl(writeLog).filter((entry) => entry.profile === "autowriter");
		check("only the two allowed auto writes reached the upstream", autoWrites.length === 2, autoWrites.length);

		const burst = await Promise.all(
			Array.from({ length: 4 }, (_, index) =>
				call(burstToken, `burst-${index}`, "telegram_write", { chat: "111", text: `burst-${index}` }),
			),
		);
		const burstAllowed = burst.filter((response) => textOf(response.body).startsWith("fake:telegram_write:")).length;
		const burstDenied = burst.filter((response) => decisionOf(response.body) === "deny").length;
		check("parallel auto writes reserve exactly the free slots", burstAllowed === 3 && burstDenied === 1, { burstAllowed, burstDenied });
		const burstWrites = readJsonl(writeLog).filter((entry) => entry.profile === "burst");
		check("the parallel burst sent exactly three writes upstream", burstWrites.length === 3, burstWrites.length);

		const expired = await call(expiredToken, "expired-1", "telegram_write", { chat: "111", text: "late" });
		check(
			"an expired TTL window closes write:auto",
			decisionOf(expired.body) === "deny" && textOf(expired.body).includes("expired"),
			expired.body,
		);

		for (const [label, args] of [
			["mass send", { recipients: ["1", "2"], text: "spam" }],
			["invite", { action: "invite_user", chat: "111" }],
			["delete chat", { action: "delete_chat", chat: "111" }],
		] as const) {
			const denied = await call(autoToken, `black-${label}`, "telegram_write", args);
			check(`${label} is denied in any mode`, decisionOf(denied.body) === "deny", denied.body);
		}

		const serverRequest = await call(readerToken, "srv-1", "telegram_read", { chat: "111", serverRequest: true });
		check(
			"an upstream sampling/elicitation request gets a JSON-RPC error and the call still completes",
			textOf(serverRequest.body) === "srv-error:-32601",
			serverRequest.body,
		);
	}

	section("child env: exact allowlist plus profile.env");
	{
		const envFile = path.join(root, "env-reader.json");
		check("the fake upstream wrote its environment", fs.existsSync(envFile), envFile);
		const childEnv = JSON.parse(fs.readFileSync(envFile, "utf8")) as Record<string, string>;
		check("ALIVE_* and GitHub marker secrets do not leak", childEnv.ALIVE_TEST_SECRET === undefined && childEnv.ALIVE_TEST_GITHUB_TOKEN === undefined, Object.keys(childEnv).filter((key) => key.startsWith("ALIVE_")));
		check(
			"proxy bearer markers do not leak",
			childEnv.ALIVE_TELEGRAM_MCP_TOKEN === undefined && childEnv.TELEGRAM_MCP_TOKEN === undefined,
			{ alive: childEnv.ALIVE_TELEGRAM_MCP_TOKEN, telegram: childEnv.TELEGRAM_MCP_TOKEN },
		);
		for (const name of UPSTREAM_ENV_ALLOWLIST) {
			const expected = name === "LANG" ? "profile-lang" : process.env[name];
			check(`allowlist ${name} reaches the child`, childEnv[name] === expected, { expected, actual: childEnv[name] });
		}
		check(
			"arbitrary TELEGRAM_/LC_/XDG_ prefixes do not leak",
			childEnv.TELEGRAM_FOO === undefined && childEnv.LC_ALIVE_TEST === undefined && childEnv.XDG_ALIVE_TEST === undefined,
			{ TELEGRAM_FOO: childEnv.TELEGRAM_FOO, LC: childEnv.LC_ALIVE_TEST, XDG: childEnv.XDG_ALIVE_TEST },
		);
		check("profile.env is merged on top", childEnv.PROFILE_ONLY === "from-profile", childEnv.PROFILE_ONLY);
		check("profile.env overrides an allowlisted name", childEnv.LANG === "profile-lang", childEnv.LANG);
		check("the internal profile marker is present", childEnv.ALIVE_TELEGRAM_MCP_PROFILE === "reader", childEnv.ALIVE_TELEGRAM_MCP_PROFILE);

		const allowlist = [...UPSTREAM_ENV_ALLOWLIST];
		check(
			"the allowlist is a fixed exact-name array with no wildcard or prefix entries",
			allowlist.length > 0 && allowlist.every((name) => /^[A-Za-z0-9_]+$/.test(name) && !name.includes("*") && !name.endsWith("_")),
			allowlist,
		);
		const exact = buildUpstreamEnv(
			{},
			{
				LC_ALL: "listed-exactly",
				TELEGRAM_API_HASH: "telegram-credential",
				TELEGRAM_API_ID: "telegram-credential",
				TELEGRAM_MCP_TOKEN: "bearer",
				TELEGRAM_FOO: "not-listed",
				LC_ALIVE_TEST: "not-listed",
				XDG_ALIVE_TEST: "not-listed",
				ALIVE_TELEGRAM_MCP_TOKEN: "bearer",
			},
		);
		check(
			"selection is exact: LC_ALL passes, Telegram credentials and prefixed names do not",
			exact.LC_ALL === "listed-exactly" &&
				exact.TELEGRAM_API_HASH === undefined &&
				exact.TELEGRAM_API_ID === undefined &&
				exact.TELEGRAM_MCP_TOKEN === undefined &&
				exact.TELEGRAM_FOO === undefined &&
				exact.LC_ALIVE_TEST === undefined &&
				exact.XDG_ALIVE_TEST === undefined &&
				exact.ALIVE_TELEGRAM_MCP_TOKEN === undefined,
			exact,
		);
	}

	section("server: id rewriting across parallel connections");
	{
		// Both connections deliberately use the same client id. Only the per-connection
		// upstream-id table can tell their responses apart.
		const slow = call(readerToken, "same-id", "telegram_read", { chat: "111", slow: true, text: "slow-call" }, "conn-a");
		await delay(15);
		const fast = call(readerToken, "same-id", "telegram_read", { chat: "111", text: "fast-call" }, "conn-b");
		const first = await Promise.race([slow.then(() => "slow"), fast.then(() => "fast")]);
		check("the upstream answers arrive out of order", first === "fast", first);
		const [a, b] = await Promise.all([slow, fast]);
		check("connection A gets its own client id back", a.body.id === "same-id", a.body);
		check("connection B gets its own client id back", b.body.id === "same-id", b.body);
		check("connection A gets its own payload", textOf(a.body).includes("slow-call"), textOf(a.body));
		check("connection B gets its own payload", textOf(b.body).includes("fast-call"), textOf(b.body));
	}

	section("server: upstream crash, restart and audit");
	{
		const crashed = await call(crasherToken, "crash-1", "telegram_read", { chat: "111", text: "crash-once" });
		check("a killed upstream turns the call into a JSON-RPC error", !!crashed.body.error, crashed.body);
		let starts = readJsonl(startLog).filter((entry) => entry.profile === "crasher");
		for (let i = 0; i < 100 && starts.length < 2; i += 1) {
			await delay(50);
			starts = readJsonl(startLog).filter((entry) => entry.profile === "crasher");
		}
		check("the child is restarted after the crash", starts.length >= 2, starts.length);
		const afterRestart = await rpc(crasherToken, { jsonrpc: "2.0", id: "after-1", method: "tools/list" });
		const afterTools = (afterRestart.body.result as { tools?: unknown[] } | undefined)?.tools ?? [];
		check("the next request works after the restart", afterRestart.status === 200 && afterTools.length === 3, afterRestart.body);
		check(
			"the restart is logged without secrets",
			serverLog.some((line) => line.includes('profile "crasher"') && line.includes("restarting in")),
			serverLog.filter((line) => line.includes("crasher")),
		);

		const auditFile = telegramMcpAuditFile(stateDir);
		check("the audit file exists and is 0600", fs.existsSync(auditFile) && mode(auditFile) === 0o600, fs.existsSync(auditFile) ? mode(auditFile) : "missing");
		const audit = readJsonl(auditFile) as unknown as Array<{
			profile?: string;
			tool?: string;
			chat?: string;
			decision?: string;
			reason?: string;
			bytes?: number;
			preview?: string;
		}>;
		check("the audit records allow and deny decisions", audit.some((entry) => entry.decision === "allow") && audit.some((entry) => entry.decision === "deny"), audit.length);
		const deniedRead = audit.find((entry) => entry.tool === "telegram_read" && entry.chat === "222");
		check("the denied read has profile, reason and decision", deniedRead?.profile === "reader" && deniedRead?.decision === "deny" && (deniedRead?.reason ?? "").includes("allowChats"), deniedRead);
		const unresolvedAudit = audit.find(
			(entry) => entry.profile === "resolver" && entry.tool === "telegram_write" && entry.decision === "deny" && (entry.reason ?? "").includes("cannot resolve target chat"),
		);
		check("the audit records the unresolved-chat reason", unresolvedAudit !== undefined, unresolvedAudit);
		const askedAudit = audit.find((entry) => entry.tool === "telegram_write" && entry.decision === "ask");
		check("the write audit carries byte length and a 120-char preview", askedAudit?.bytes === Buffer.byteLength(longWriteText) && askedAudit?.preview?.length === 120, askedAudit);
		const auditText = fs.readFileSync(auditFile, "utf8");
		check("the audit never contains the full write text", !auditText.includes(longWriteText) && !auditText.includes("-END-SECRET-SUFFIX"));
	}

	section("server: operator confirmation tickets (write:ask)");
	{
		const ask = (id: string, text: string, extra: Record<string, unknown> = {}) =>
			call(confirmerToken, id, "telegram_write", { chat: "111", text, ...extra });
		const confirmerWrites = (text?: string) =>
			readJsonl(writeLog).filter(
				(entry) => entry.profile === "confirmer" && (text === undefined || (entry.args as { text?: string } | undefined)?.text === text),
			);
		const auditFile = telegramMcpAuditFile(stateDir);

		// 1. The ask becomes a private pending ticket and waits; nothing is sent.
		const approveCall = ask("conf-approve", "confirm-approve");
		let approveSettled = false;
		void approveCall.then(() => {
			approveSettled = true;
		});
		const ticketReady = await waitFor(() => ticketsWithText("confirm-approve").length === 1);
		const approveTicket = ticketsWithText("confirm-approve")[0];
		check("a confirmation ask writes one pending ticket", ticketReady && approveTicket?.status === "pending", approveTicket);
		check(
			"the ticket carries profile, tool, chat, exact text, nonce and TTL",
			approveTicket?.profile === "confirmer" &&
				approveTicket?.tool === "telegram_write" &&
				approveTicket?.chat === "111" &&
				approveTicket?.text === "confirm-approve" &&
				typeof approveTicket?.nonce === "string" &&
				approveTicket.nonce.length >= 32 &&
				approveTicket?.expiresAt === approveTicket?.createdAt + 60_000,
			approveTicket,
		);
		if (!approveTicket) throw new Error("the pending confirmation ticket is missing");
		check(
			"the ticket directory is 0700 and the ticket file 0600",
			mode(confirmerDir) === 0o700 && mode(ticketFilePath(confirmerDir, approveTicket.ticketId)) === 0o600,
			{ dir: mode(confirmerDir).toString(8), file: mode(ticketFilePath(confirmerDir, approveTicket.ticketId)).toString(8) },
		);
		await delay(50);
		check(
			"the ask blocks instead of returning while the ticket is pending",
			!approveSettled && confirmerWrites("confirm-approve").length === 0 && !fs.existsSync(decisionFilePath(confirmerDir, approveTicket.ticketId)),
			{ settled: approveSettled, writes: confirmerWrites("confirm-approve").length },
		);

		writeDecision(confirmerDir, decisionFor(approveTicket, "approve") as unknown as Parameters<typeof writeDecision>[1]);
		const approved = await approveCall;
		check(
			"approve forwards the write to the upstream",
			textOf(approved.body).startsWith("fake:telegram_write:111:confirm-approve"),
			approved.body,
		);
		check("approve sends the upstream write exactly once", confirmerWrites("confirm-approve").length === 1, confirmerWrites("confirm-approve"));
		check("the ticket is marked sent", readTicket(confirmerDir, approveTicket.ticketId)?.status === "sent", readTicket(confirmerDir, approveTicket.ticketId));
		check(
			"the hourly limit counts the approved write once",
			limits!.snapshot("confirmer", clockNow).writesThisHour === 1,
			limits!.snapshot("confirmer", clockNow),
		);
		const confirmerAudit = readJsonl(auditFile).filter((entry) => entry.profile === "confirmer");
		check(
			"the approval is audited once as allow",
			confirmerAudit.filter((entry) => entry.decision === "allow").length === 1 &&
				confirmerAudit.some((entry) => String(entry.reason).includes("operator approved")),
			confirmerAudit,
		);

		// 2. Deny: a tool error, no upstream call, ticket closed.
		const denyCall = ask("conf-deny", "confirm-deny");
		await waitFor(() => ticketsWithText("confirm-deny").length === 1);
		const denyTicket = ticketsWithText("confirm-deny")[0];
		if (!denyTicket) throw new Error("the deny ticket is missing");
		const writesBeforeDeny = confirmerWrites().length;
		writeDecision(confirmerDir, decisionFor(denyTicket, "deny") as Parameters<typeof writeDecision>[1]);
		const denied = await denyCall;
		check(
			"deny returns a tool error saying the operator refused",
			(denied.body.result as { isError?: boolean } | undefined)?.isError === true && textOf(denied.body).includes("denied by operator"),
			denied.body,
		);
		check("deny sends nothing upstream", confirmerWrites().length === writesBeforeDeny, confirmerWrites());
		check("the ticket is marked denied", readTicket(confirmerDir, denyTicket.ticketId)?.status === "denied", readTicket(confirmerDir, denyTicket.ticketId));

		// 3. TTL: the injected clock passes expiresAt, the ask returns an error.
		const expireCall = ask("conf-expire", "confirm-expire");
		await waitFor(() => ticketsWithText("confirm-expire").length === 1);
		const expireTicket = ticketsWithText("confirm-expire")[0];
		if (!expireTicket) throw new Error("the expiry ticket is missing");
		const writesBeforeExpiry = confirmerWrites().length;
		clockNow = expireTicket.expiresAt;
		// A bounded wait: a broken TTL rule must fail the check instead of hanging the
		// whole suite (the dangling ask settles once the server stops).
		const expired = await Promise.race([expireCall, delay(1_000).then(() => undefined)]);
		check(
			"an expired ticket returns a tool error and sends nothing",
			expired !== undefined &&
				(expired.body.result as { isError?: boolean } | undefined)?.isError === true &&
				textOf(expired.body).includes("expired") &&
				confirmerWrites().length === writesBeforeExpiry,
			expired?.body ?? "still waiting for a decision",
		);
		check("the ticket is marked expired", readTicket(confirmerDir, expireTicket.ticketId)?.status === "expired", readTicket(confirmerDir, expireTicket.ticketId));

		// 4. A repeated identical ask reuses the pending ticket and cannot send twice.
		const duplicateFirst = ask("conf-dup-1", "confirm-dup");
		await waitFor(() => ticketsWithText("confirm-dup").length === 1);
		const duplicateTicket = ticketsWithText("confirm-dup")[0];
		if (!duplicateTicket) throw new Error("the duplicate ticket is missing");
		const duplicateSecond = ask("conf-dup-2", "confirm-dup");
		await delay(60);
		check(
			"an identical ask reuses the one pending ticket",
			ticketsWithText("confirm-dup").length === 1 && ticketsWithText("confirm-dup")[0]?.ticketId === duplicateTicket.ticketId,
			ticketsWithText("confirm-dup"),
		);
		const writesBeforeDuplicate = confirmerWrites().length;
		writeDecision(confirmerDir, decisionFor(duplicateTicket, "approve") as Parameters<typeof writeDecision>[1]);
		// A broken dedup would create a second ticket; answer it too so the suite
		// fails on the write count instead of waiting for its TTL.
		for (const extra of ticketsWithText("confirm-dup")) {
			if (extra.ticketId !== duplicateTicket.ticketId) {
				writeDecision(confirmerDir, decisionFor(extra, "approve") as Parameters<typeof writeDecision>[1]);
			}
		}
		const [duplicateA, duplicateB] = await Promise.all([duplicateFirst, duplicateSecond]);
		check(
			"both waiters receive the same write result",
			textOf(duplicateA.body).startsWith("fake:telegram_write:111:confirm-dup") &&
				textOf(duplicateB.body).startsWith("fake:telegram_write:111:confirm-dup"),
			[duplicateA.body, duplicateB.body],
		);
		check(
			"a reused ticket still sends the write only once",
			confirmerWrites().length === writesBeforeDuplicate + 1 && confirmerWrites("confirm-dup").length === 1,
			confirmerWrites(),
		);

		// 5. Bad decisions are rejected without sending: corrupt, foreign, late.
		const corruptCall = ask("conf-corrupt", "confirm-corrupt");
		await waitFor(() => ticketsWithText("confirm-corrupt").length === 1);
		const corruptTicket = ticketsWithText("confirm-corrupt")[0];
		if (!corruptTicket) throw new Error("the corrupt-decision ticket is missing");
		fs.writeFileSync(decisionFilePath(confirmerDir, corruptTicket.ticketId), "{not-json", { mode: 0o600 });
		const corrupt = await corruptCall;
		check(
			"a corrupt decision is rejected and nothing is sent",
			(corrupt.body.result as { isError?: boolean } | undefined)?.isError === true &&
				textOf(corrupt.body).includes("decision rejected") &&
				confirmerWrites("confirm-corrupt").length === 0,
			corrupt.body,
		);

		const foreignCall = ask("conf-foreign", "confirm-foreign");
		await waitFor(() => ticketsWithText("confirm-foreign").length === 1);
		const foreignTicket = ticketsWithText("confirm-foreign")[0];
		if (!foreignTicket) throw new Error("the foreign-decision ticket is missing");
		const foreignDecision = { ...decisionFor(foreignTicket, "approve"), ticketId: "tgask_0000000000000000" };
		fs.writeFileSync(decisionFilePath(confirmerDir, foreignTicket.ticketId), `${JSON.stringify(foreignDecision)}\n`, { mode: 0o600 });
		const foreign = await foreignCall;
		check(
			"a decision for another ticket is rejected",
			(foreign.body.result as { isError?: boolean } | undefined)?.isError === true &&
				textOf(foreign.body).includes("another ticket") &&
				confirmerWrites("confirm-foreign").length === 0,
			foreign.body,
		);

		const nonceCall = ask("conf-nonce", "confirm-nonce");
		await waitFor(() => ticketsWithText("confirm-nonce").length === 1);
		const nonceTicket = ticketsWithText("confirm-nonce")[0];
		if (!nonceTicket) throw new Error("the nonce-mismatch ticket is missing");
		const nonceDecision = decisionFor(nonceTicket, "approve", { nonce: "wrong-nonce" });
		fs.writeFileSync(decisionFilePath(confirmerDir, nonceTicket.ticketId), `${JSON.stringify(nonceDecision)}\n`, { mode: 0o600 });
		const nonce = await nonceCall;
		check(
			"a decision with another nonce is rejected",
			(nonce.body.result as { isError?: boolean } | undefined)?.isError === true &&
				textOf(nonce.body).includes("nonce does not match") &&
				confirmerWrites("confirm-nonce").length === 0,
			nonce.body,
		);

		const lateCall = ask("conf-late", "confirm-late");
		await waitFor(() => ticketsWithText("confirm-late").length === 1);
		const lateTicket = ticketsWithText("confirm-late")[0];
		if (!lateTicket) throw new Error("the late-decision ticket is missing");
		const lateDecision = decisionFor(lateTicket, "approve", { decidedAt: lateTicket.expiresAt + 1 });
		fs.writeFileSync(decisionFilePath(confirmerDir, lateTicket.ticketId), `${JSON.stringify(lateDecision)}\n`, { mode: 0o600 });
		const late = await lateCall;
		check(
			"a decision written after the ticket expired is rejected",
			(late.body.result as { isError?: boolean } | undefined)?.isError === true &&
				textOf(late.body).includes("after the ticket expired") &&
				confirmerWrites("confirm-late").length === 0,
			late.body,
		);

		// 6. The ticket carries the sha256 of all canonical arguments.
		const hashArgs = { chat: "111", text: "confirm-hash", nested: { b: 2, a: 1 }, list: [1, { z: 0, a: 1 }] };
		const hashCall = call(confirmerToken, "conf-hash", "telegram_write", hashArgs);
		await waitFor(() => ticketsWithText("confirm-hash").length === 1);
		const hashTicket = ticketsWithText("confirm-hash")[0];
		if (!hashTicket) throw new Error("the hash ticket is missing");
		const reordered = { list: [1, { a: 1, z: 0 }], nested: { a: 1, b: 2 }, text: "confirm-hash", chat: "111" };
		check(
			"the ticket hash covers all arguments canonically (key order is irrelevant)",
			hashTicket.requestHash === telegramMcpRequestHash(hashArgs) &&
				hashTicket.requestHash === telegramMcpRequestHash(reordered) &&
				hashTicket.requestHash !== telegramMcpRequestHash({ ...hashArgs, text: "another" }),
			hashTicket.requestHash,
		);
		const wrongHashDecision = decisionFor(hashTicket, "approve", { requestHash: "0".repeat(64) });
		writeDecision(confirmerDir, wrongHashDecision as Parameters<typeof writeDecision>[1]);
		const wrongHash = await hashCall;
		check(
			"a decision with another request hash is rejected and nothing is sent",
			(wrongHash.body.result as { isError?: boolean } | undefined)?.isError === true &&
				textOf(wrongHash.body).includes("request hash") &&
				confirmerWrites("confirm-hash").length === 0,
			wrongHash.body,
		);

		// A ticket whose stored hash is not the hash of the request the proxy would
		// send: the decision matches the ticket, but the outbound re-hash refuses it.
		const tamperArgs = { chat: "111", text: "confirm-tamper" };
		const tamperedTicket = {
			...fixtureTicket("tgask_3333333333333333", clockNow, clockNow + 60_000, "pending"),
			text: "confirm-tamper",
			requestHash: "f".repeat(64),
			requestKey: telegramMcpTicketRequestKey("confirmer", "telegram_write", telegramMcpRequestHash(tamperArgs)),
		};
		writeTicket(confirmerDir, tamperedTicket);
		const tamperCall = ask("conf-tamper", "confirm-tamper");
		// Wait until the proxy has actually picked the pre-created ticket (the
		// audit entry is written in the same synchronous step as the lookup).
		check(
			"the proxy reuses the pre-created ticket",
			await waitFor(
				() =>
					readJsonl(auditFile).some(
						(entry) =>
							entry.decision === "ask" &&
							entry.tool === "telegram_write" &&
							String(entry.preview ?? "").includes("confirm-tamper"),
					) && ticketsWithText("confirm-tamper").length === 1,
			),
			ticketsWithText("confirm-tamper"),
		);
		writeDecision(confirmerDir, decisionFor(tamperedTicket, "approve") as Parameters<typeof writeDecision>[1]);
		const tampered = await tamperCall;
		check(
			"approve re-hashes the request about to be sent and refuses a mismatch",
			(tampered.body.result as { isError?: boolean } | undefined)?.isError === true &&
				textOf(tampered.body).includes("does not match the request about to be sent") &&
				confirmerWrites("confirm-tamper").length === 0,
			tampered.body,
		);

		// 7. A client that closes the request before the decision denies the ticket.
		const abortController = new AbortController();
		const abortWritesBefore = confirmerWrites().length;
		const abortedCall = fetch(`http://127.0.0.1:${server.port}/mcp`, {
			method: "POST",
			headers: { "content-type": "application/json", authorization: `Bearer ${confirmerToken}` },
			body: JSON.stringify({ jsonrpc: "2.0", id: "conf-abort", method: "tools/call", params: { name: "telegram_write", arguments: { chat: "111", text: "confirm-abort" } } }),
			signal: abortController.signal,
		}).catch(() => undefined);
		await waitFor(() => ticketsWithText("confirm-abort").length === 1);
		const abortTicket = ticketsWithText("confirm-abort")[0];
		if (!abortTicket) throw new Error("the abort ticket is missing");
		abortController.abort();
		await abortedCall;
		const abortClosed = await waitFor(
			() => readTicket(confirmerDir, abortTicket.ticketId)?.status === "denied",
		);
		check(
			"a client close before the deadline denies the ticket",
			abortClosed && String(readTicket(confirmerDir, abortTicket.ticketId)?.error).includes("client closed"),
			readTicket(confirmerDir, abortTicket.ticketId),
		);
		// A decision written after the client went away must not revive it.
		writeDecision(confirmerDir, decisionFor(abortTicket, "approve", { decidedAt: clockNow }) as Parameters<typeof writeDecision>[1]);
		await delay(150);
		check(
			"a decision after the client close is not accepted and nothing is sent",
			readTicket(confirmerDir, abortTicket.ticketId)?.status === "denied" &&
				confirmerWrites().length === abortWritesBefore &&
				confirmerWrites("confirm-abort").length === 0,
			{ ticket: readTicket(confirmerDir, abortTicket.ticketId), writes: confirmerWrites() },
		);

		// 8. The per-profile backlog is capped; beyond it the proxy denies up front.
		const backlogIds: string[] = [];
		for (let index = 0; index < 8; index += 1) {
			const ticketId = `tgask_${String(index).padStart(16, "a")}`;
			backlogIds.push(ticketId);
			writeTicket(confirmerDir, {
				...fixtureTicket(ticketId, clockNow, clockNow + 60_000, "pending"),
				text: `backlog-${index}`,
			});
		}
		const backlogCall = ask("conf-backlog", "confirm-backlog");
		const backlog = await Promise.race([backlogCall, delay(1_000).then(() => undefined)]);
		check(
			"the ninth pending ticket is denied with a backlog reason and not written",
			backlog !== undefined &&
				(backlog.body.result as { isError?: boolean } | undefined)?.isError === true &&
				textOf(backlog.body).includes("backlog") &&
				ticketsWithText("confirm-backlog").length === 0 &&
				listTickets(confirmerDir).filter((ticket) => ticket.status === "pending").length === 8,
			backlog?.body ?? "still waiting",
		);
		for (const ticketId of backlogIds) {
			fs.rmSync(ticketFilePath(confirmerDir, ticketId), { force: true });
		}
	}

	section("shutdown kills the upstream process group");
	{
		const starts = readJsonl(startLog) as Array<{ profile?: string; pid?: number }>;
		const running = new Map<string, number>();
		for (const entry of starts) if (entry.profile && typeof entry.pid === "number") running.set(entry.profile, entry.pid);
		await server!.stop();
		server = undefined;
		let terms = "";
		for (let i = 0; i < 40 && !terms.includes("term:"); i += 1) {
			await delay(50);
			terms = fs.existsSync(groupTermFile) ? fs.readFileSync(groupTermFile, "utf8") : "";
		}
		check("SIGTERM reached the child process groups", terms.includes("term:"), terms.trim());
		let allDead = true;
		let alive: number[] = [];
		for (let i = 0; i < 40; i += 1) {
			alive = [...running.values()].filter(pidAlive);
			allDead = alive.length === 0;
			if (allDead) break;
			await delay(50);
		}
		check("every upstream child is gone after shutdown", allDead, alive);
	}
} catch (error) {
	failures += 1;
	process.stdout.write(`\nFAIL  unexpected error: ${error instanceof Error ? (error.stack ?? error.message) : String(error)}\n`);
} finally {
	for (const [name, value] of savedEnv) {
		if (value === undefined) delete process.env[name];
		else process.env[name] = value;
	}
	if (server) await server.stop().catch(() => undefined);
	fs.rmSync(root, { recursive: true, force: true });
}

if (failures > 0) {
	process.stdout.write(`\n${failures} Telegram MCP check(s) failed\n`);
	process.exitCode = 1;
} else {
	process.stdout.write("\nall Telegram MCP checks passed\n");
}
