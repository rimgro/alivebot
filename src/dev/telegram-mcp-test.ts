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
import { normalizeToolCall, upstreamToolArguments } from "../modules/telegram/mcp/normalize.js";
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
const callLog = path.join(root, "calls.jsonl");
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
		FAKE_CALL_LOG: callLog,
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
				{ name: "telegram_write", description: "write", inputSchema: { type: "object", properties: {} } },
				{ name: "telegram_setup", description: "setup", inputSchema: { type: "object", properties: {} } }
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
		// Real better-tg-cli 0.41.2 schema only: {args: string[], stdin?: string}.
		const argv = Array.isArray(args.args) ? args.args : [];
		const stdin = typeof args.stdin === "string" ? args.stdin : undefined;
		const command = argv[0];
		let chat = typeof argv[1] === "string" ? argv[1] : "";
		let text = "";
		if (command === "search") {
			const chatFlag = argv.indexOf("--chat");
			chat = chatFlag >= 0 ? String(argv[chatFlag + 1] || "") : "";
			text = typeof argv[1] === "string" ? argv[1] : "";
		} else if (stdin !== undefined) {
			text = stdin;
		} else if (command === "reply" || command === "edit") {
			text = argv.slice(3).join(" ");
		} else {
			text = argv.slice(2).join(" ");
		}
		if (process.env.FAKE_CALL_LOG) {
			fs.appendFileSync(process.env.FAKE_CALL_LOG, JSON.stringify({ profile, name, argv, stdin, args }) + "\n");
		}
		if (text.includes("crash-once") && process.env.FAKE_CRASH_MARKER && !fs.existsSync(process.env.FAKE_CRASH_MARKER)) {
			fs.writeFileSync(process.env.FAKE_CRASH_MARKER, "1");
			process.exit(1);
		}
		if (process.env.FAKE_WRITE_LOG && name === "telegram_write") {
			fs.appendFileSync(process.env.FAKE_WRITE_LOG, JSON.stringify({ profile, args, argv, stdin, command, chat, text }) + "\n");
		}
		if (argv.includes("server-request")) {
			const id = "srv-" + String(message.id);
			serverRequest = { id, original: message };
			respond({ jsonrpc: "2.0", id, method: "sampling/createMessage", params: {} });
			continue;
		}
		const wait = argv.includes("slow-call") ? 80 : 5;
		setTimeout(() => respond({ jsonrpc: "2.0", id: message.id, result: {
			content: [{ type: "text", text: "fake:" + name + ":" + chat + ":" + text }],
			structuredContent: { name, chat, text }
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
let argvWriterToken = "";
let argvLimitToken = "";
let argvAskerToken = "";
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
		{ name: "reader", mode: "read", allowChats: ["111", "@test"], writeTtlMs: 60_000, writeLimitPerHour: 2, command: process.execPath, args: [fakePath], env: profileEnv("reader", { PROFILE_ONLY: "from-profile", LANG: "profile-lang" }) },
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
		{ name: "argvwriter", mode: "write:auto", allowChats: ["@test", "111"], writeTtlMs: 60_000, writeLimitPerHour: 20, command: process.execPath, args: [fakePath], env: profileEnv("argvwriter") },
		{ name: "argvlimit", mode: "write:auto", allowChats: ["@test"], writeTtlMs: 60_000, writeLimitPerHour: 2, command: process.execPath, args: [fakePath], env: profileEnv("argvlimit") },
		{
			name: "argvasker",
			mode: "write:ask",
			allowChats: ["@test", "111"],
			writeTtlMs: 60_000,
			writeLimitPerHour: 5,
			confirmation: { ticketDir: confirmationDir, ttlMs: 60_000 },
			command: process.execPath,
			args: [fakePath],
			env: profileEnv("argvasker"),
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
		const unresolved = decideTelegramMcpCall({ profile, tool: "telegram_write", args: { text: "hi" }, now: clockNow, limits: open });
		check(
			"write with allowChats and an unresolved chat is denied",
			unresolved.decision === "deny" && unresolved.reason.includes("cannot resolve target chat") && unresolved.reason.includes('"111"'),
			unresolved,
		);
		const objectChat = decideTelegramMcpCall({
			profile,
			tool: "telegram_write",
			args: { chat: { id: "111" }, text: "hi" },
			now: clockNow,
			limits: open,
		});
		check("write with a nested chat object is denied, not guessed", objectChat.decision === "deny" && objectChat.reason.includes("cannot resolve target chat"), objectChat);
		for (const [label, args] of [
			["numeric chat", { chat: 111, text: "hi" }],
			["to string", { to: "111", text: "hi" }],
			["recipient string", { recipient: "111", text: "hi" }],
		] as const) {
			const decision = decideTelegramMcpCall({ profile, tool: "telegram_write", args, now: clockNow, limits: open });
			check(`write resolves ${label}`, decision.decision === "allow" && decision.chat === "111", decision);
		}
		const unrestricted = decideTelegramMcpCall({
			profile: { ...profile, allowChats: [] },
			tool: "telegram_write",
			args: { text: "hi" },
			now: clockNow,
			limits: open,
		});
		check("an empty allowChats keeps the old write behaviour", unrestricted.decision === "allow", unrestricted);
		const nonMatchingWrite = { ...profile, allowChats: ["123"] };
		for (const [label, args] of [
			["chat", { chat: "999", text: "hi" }],
			["to", { to: "999", text: "hi" }],
			["recipient", { recipient: "999", text: "hi" }],
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

	section("normalize: argv grammar and flat compatibility");
	{
		const view = (tool: string, args: Record<string, unknown>) => {
			const result = normalizeToolCall(tool, args);
			return result.ok ? result.view : undefined;
		};
		const reason = (tool: string, args: Record<string, unknown>): string => {
			const result = normalizeToolCall(tool, args);
			return result.ok ? "" : result.reason;
		};
		const open = { windowActive: true, windowExpiresAt: clockNow + 60_000, writesThisHour: 0 };

		const read = view("telegram_read", { args: ["read", "@test"] });
		check(
			"argv read keeps the original argv and finds the chat",
			read?.command === "read" && read.chat === "@test" && read.argv.join(" ") === "read @test" && read.write === false,
			read,
		);
		const sendMany = reason("telegram_write", { args: ["send", "@test", "hello", "world"] });
		check(
			"send with two text positionals is denied (multi-word text needs stdin)",
			sendMany.includes("positional") && sendMany.includes("stdin"),
			sendMany,
		);
		const sendOne = view("telegram_write", { args: ["send", "@test", "hello"] });
		check("argv send takes one positional text token", sendOne?.write === true && sendOne.chat === "@test" && sendOne.text === "hello", sendOne);
		const flags = view("telegram_read", { args: ["read", "@test", "-n", "20", "--json"] });
		check(
			"known flags keep their values out of the positionals",
			flags?.chat === "@test" && flags.argv.join(" ") === "read @test -n 20 --json",
			flags,
		);

		const stdinSend = view("telegram_write", { args: ["send", "@test", "-"], stdin: "from stdin" });
		check("send - takes its text from stdin", stdinSend?.text === "from stdin" && stdinSend.argv[2] === "-", stdinSend);
		const reply = view("telegram_write", { args: ["reply", "@test", "5", "-"], stdin: "reply text" });
		check("reply - takes its text from stdin after the message id", reply?.chat === "@test" && reply.text === "reply text", reply);
		const edit = view("telegram_write", { args: ["edit", "@test", "5", "-"], stdin: "edit text" });
		check("edit - takes its text from stdin after the message id", edit?.chat === "@test" && edit.text === "edit text", edit);
		const noStdin = reason("telegram_write", { args: ["send", "@test", "-"] });
		check("send - without stdin is denied", noStdin.includes("no stdin"), noStdin);

		const positionalDenials: Array<[string, "telegram_read" | "telegram_write", string[]]> = [
			["edit with a literal text instead of stdin", "telegram_write", ["edit", "@test", "5", "6"]],
			["read with an extra positional", "telegram_read", ["read", "@test", "extra"]],
			["react without an emoji", "telegram_write", ["react", "@test", "5"]],
			["pin without a message id", "telegram_write", ["pin", "@test"]],
			["get without a message id", "telegram_read", ["get", "@test"]],
			["unpin with too many positionals", "telegram_write", ["unpin", "@test", "5", "6"]],
			["help with a positional", "telegram_read", ["help", "read"]],
		];
		for (const [label, tool, args] of positionalDenials) {
			const denied = reason(tool, { args });
			check(`${label} is denied by the positional count`, denied.includes("positional") || denied.includes("stdin"), denied);
		}

		const successCases: Array<[string, "telegram_read" | "telegram_write", Record<string, unknown>]> = [
			["read @test with -n 20 --json", "telegram_read", { args: ["read", "@test", "-n", "20", "--json"] }],
			["get @test 1 2", "telegram_read", { args: ["get", "@test", "1", "2"] }],
			["react @test 5 👍", "telegram_write", { args: ["react", "@test", "5", "👍"] }],
			["pin @test 5", "telegram_write", { args: ["pin", "@test", "5"] }],
			["unpin @test", "telegram_write", { args: ["unpin", "@test"] }],
			["unpin @test 5", "telegram_write", { args: ["unpin", "@test", "5"] }],
			["vote @test 5 2", "telegram_write", { args: ["vote", "@test", "5", "2"] }],
			["reply @test 5 - with stdin", "telegram_write", { args: ["reply", "@test", "5", "-"], stdin: "reply text" }],
			["edit @test 5 - with stdin", "telegram_write", { args: ["edit", "@test", "5", "-"], stdin: "edit text" }],
			["search q --chat @test", "telegram_read", { args: ["search", "q", "--chat", "@test"] }],
		];
		for (const [label, tool, args] of successCases) {
			const result = view(tool, args);
			check(`success: ${label}`, result !== undefined, result ?? reason(tool, args));
		}

		const search = view("telegram_read", { args: ["search", "query", "--chat", "@test"] });
		check(
			"search takes its chat only from --chat and does not treat the query as a chat",
			search?.chat === "@test" && search.argv.join(" ") === "search query --chat @test",
			search,
		);
		const searchNoChat = view("telegram_read", { args: ["search", "query"] });
		check("search without --chat has no chat for the policy to reject", searchNoChat !== undefined && searchNoChat.chat === undefined, searchNoChat);
		const searchDenied = decideTelegramMcpCall({
			profile: profiles[0]!,
			tool: "telegram_read",
			args: { args: ["search", "query"] },
			now: clockNow,
			limits: open,
		});
		check("search without --chat is denied by the policy", searchDenied.decision === "deny", searchDenied);
		for (const command of [["whoami"], ["check"], ["help"], ["help-all"], ["write-access"]]) {
			const decision = decideTelegramMcpCall({
				profile: profiles[0]!,
				tool: "telegram_read",
				args: { args: command },
				now: clockNow,
				limits: open,
			});
			check(`no-chat read ${command[0]} is allowed`, decision.decision === "allow", decision);
		}
		const readWithoutChat = decideTelegramMcpCall({
			profile: profiles[0]!,
			tool: "telegram_read",
			args: { args: ["read"] },
			now: clockNow,
			limits: open,
		});
		check("a chat command without its chat stays denied", readWithoutChat.decision === "deny" && readWithoutChat.reason.includes("chat argument"), readWithoutChat);
		check("--chat=@test is parsed on search", view("telegram_read", { args: ["search", "q", "--chat=@test"] })?.chat === "@test");

		check("an unknown command is denied", reason("telegram_read", { args: ["frobnicate", "x"] }).includes("unknown telegram command"));
		for (const command of ["delete", "forward", "send-file", "api"]) {
			const denied = reason("telegram_write", { args: [command, "@test"] });
			check(`${command} is denied as a command`, denied.includes("denied"), denied);
		}
		const click = reason("telegram_write", { args: ["click", "@test", "5", "Catalog"] });
		check(
			"click is denied because the button belongs to the bot owner",
			click.includes("pressing buttons is not allowed") && click.includes("bot owner"),
			click,
		);

		check(
			"two positional chats are denied as a mass send",
			reason("telegram_read", { args: ["get", "@test", "@other"] }).includes("mass send"),
		);
		check(
			"a second negative-id chat is denied as a mass send",
			reason("telegram_read", { args: ["get", "@test", "-1004003"] }).includes("mass send"),
		);
		check(
			"two chats in a write are denied as a mass send",
			reason("telegram_write", { args: ["send", "@test", "@other"] }).includes("mass send"),
		);
		check(
			"a conflicting --chat is denied",
			reason("telegram_write", { args: ["send", "--chat", "@other", "@test", "hi"] }).includes("mass send"),
		);

		const unknownFlag = reason("telegram_write", { args: ["send", "@test", "hi", "--frobnicate"] });
		check("an unknown flag is denied", unknownFlag.includes("unknown flag"), unknownFlag);
		const missingFlagValue = reason("telegram_read", { args: ["read", "@test", "--chat"] });
		check("a value flag without a value is denied", missingFlagValue.includes("requires a value"), missingFlagValue);
		check(
			"--chat on a non-search command is denied",
			reason("telegram_read", { args: ["whoami", "--chat", "@a"] }).includes("only supported by"),
		);

		const valuedFlags = [
			"-n",
			"--topic",
			"--thread",
			"--reply-to",
			"--schedule",
			"--max-text",
			"--preview",
			"--since",
			"--until",
			"--before",
			"--after",
			"--from",
			"--type",
			"--correct",
			"--message",
			"--grep",
			"-q",
			"-g",
			"-c",
		];
		for (const flag of valuedFlags) {
			check(`known value flag ${flag} is accepted`, view("telegram_read", { args: ["read", "@test", flag, "v"] }) !== undefined);
		}
		const booleanFlags = [
			"--json",
			"--html",
			"--markdown",
			"--silent",
			"--unread",
			"--asc",
			"--just-me",
			"--full",
			"--stats",
			"--multiple",
			"--quiz",
			"--drop-author",
			"--revoke",
			"--notify",
			"--requests",
			"--include-archived",
			"--unmuted",
			"--no-bots",
			"--help",
		];
		for (const flag of booleanFlags) {
			check(`known boolean flag ${flag} is accepted`, view("telegram_read", { args: ["read", "@test", flag] }) !== undefined);
		}

		check("empty argv is denied", reason("telegram_write", { args: [] }).includes("non-empty array"));
		check("non-string argv is denied", reason("telegram_write", { args: ["send", 111, "hi"] }).includes("only non-empty strings"));
		check(
			"mixed shapes with a different chat are denied",
			reason("telegram_write", { args: ["send", "@test", "hi"], chat: "@other" }).includes("mixed argument shapes"),
		);
		check(
			"mixed shapes with matching values are allowed",
			view("telegram_write", { args: ["send", "@test", "hi"], chat: "@test", text: "hi" })?.text === "hi",
		);
		check(
			"stdin with a positional text is a mixed shape",
			reason("telegram_write", { args: ["send", "@test", "hi"], stdin: "x" }).includes("mixed argument shapes"),
		);
		check(
			"stdin on a read is a mixed shape",
			reason("telegram_read", { args: ["read", "@test"], stdin: "x" }).includes("mixed argument shapes"),
		);

		const flatWrite = view("telegram_write", { chat: "111", text: "hi" });
		check(
			"the flat write still maps to send",
			flatWrite?.command === "send" && flatWrite.chat === "111" && flatWrite.text === "hi" && flatWrite.write === true,
			flatWrite,
		);
		const flatRead = view("telegram_read", { chat: "111" });
		check("the flat read still maps to read", flatRead?.command === "read" && flatRead.chat === "111" && flatRead.write === false, flatRead);
		// A flat write without text would reach the upstream as `send <chat>` and
		// fail there after the write slot was already reserved.
		const flatNoText = reason("telegram_write", { chat: "@test" });
		check("a flat write without text is denied", flatNoText.includes("requires non-empty text"), flatNoText);
		const flatEmptyText = reason("telegram_write", { chat: "@test", text: "   " });
		check("a flat write with blank text is denied", flatEmptyText.includes("requires non-empty text"), flatEmptyText);
		check(
			"a flat write without text is never forwarded as a bare argv",
			JSON.stringify(upstreamToolArguments("telegram_write", { chat: "@test" })) === JSON.stringify({ chat: "@test" }),
			upstreamToolArguments("telegram_write", { chat: "@test" }),
		);
		check("a flat action is honoured", view("telegram_write", { action: "mark-read", chat: "111" })?.command === "mark-read");
		check("flat delete_chat is denied", reason("telegram_write", { action: "delete_chat", chat: "111" }).includes("deleting"));
		check("flat recipient lists are mass-send denied", reason("telegram_write", { recipients: ["1", "2"] }).includes("mass send"));
		check(
			"a nested chat object is not guessed",
			reason("telegram_write", { chat: { id: "111" } }).includes("cannot resolve target chat"),
		);

		check(
			"a write command on telegram_read is denied",
			reason("telegram_read", { args: ["send", "@test", "hi"] }).includes("call it through telegram_write"),
		);
		check(
			"a read command on telegram_write is denied",
			reason("telegram_write", { args: ["read", "@test"] }).includes("call it through telegram_read"),
		);
		check("write-access without a mode is allowed", view("telegram_read", { args: ["write-access"] })?.command === "write-access");
		check(
			"write-access with a mode is denied",
			reason("telegram_read", { args: ["write-access", "ask"] }).includes("write mode"),
		);
		check(
			"write-access --for is denied",
			reason("telegram_read", { args: ["write-access", "--for", "2h"] }).includes("write mode"),
		);
		check(
			"join in argv is denied",
			reason("telegram_write", { args: ["send", "@test", "join the call"] }).includes("inviting or joining"),
		);
		check("broadcast in argv is denied", reason("telegram_read", { args: ["read", "broadcast"] }).includes("broadcast"));
		check("help-all with -g is allowed", view("telegram_read", { args: ["help-all", "-g", "thread"] })?.command === "help-all");

		// The real upstream takes `{args, stdin}` only, so a legacy flat call is
		// rewritten before it leaves the proxy (#274).
		const flatUpstream = upstreamToolArguments("telegram_write", { chat: "111", text: "flat hi" });
		check(
			"a flat write becomes argv plus stdin",
			JSON.stringify(flatUpstream) === JSON.stringify({ args: ["send", "111", "-"], stdin: "flat hi" }),
			flatUpstream,
		);
		const flatReadUpstream = upstreamToolArguments("telegram_read", { chat: "111" });
		check(
			"a flat read becomes argv",
			JSON.stringify(flatReadUpstream) === JSON.stringify({ args: ["read", "111"] }),
			flatReadUpstream,
		);
		const argvArgs = { args: ["send", "@test", "-"], stdin: "same" };
		check("the argv shape is forwarded untouched", upstreamToolArguments("telegram_write", argvArgs) === argvArgs, argvArgs);
		const helpArgs = { args: ["read", "@test"] };
		check("non telegram tools are untouched", upstreamToolArguments("telegram_help", helpArgs) === helpArgs, helpArgs);
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
		limits.openWindow("argvwriter", 60_000, clockNow);
		limits.openWindow("argvlimit", 60_000, clockNow);
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
		argvWriterToken = tokens.issue("argvwriter");
		argvLimitToken = tokens.issue("argvlimit");
		argvAskerToken = tokens.issue("argvasker");
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
		check(
			"tools/list hides telegram_setup and keeps only the allowed tools",
			tools.map((tool) => tool.name).join(",") === "telegram_help,telegram_read,telegram_write",
			tools,
		);
		const hiddenCall = await call(readerToken, "hidden-1", "telegram_setup", {});
		check(
			"calling the hidden telegram_setup tool is denied",
			decisionOf(hiddenCall.body) === "deny" && textOf(hiddenCall.body).includes("not allowed"),
			hiddenCall.body,
		);

		const readAllowed = await call(readerToken, "read-1", "telegram_read", { args: ["read", "111"] });
		check("telegram_read inside allowChats is forwarded", textOf(readAllowed.body).startsWith("fake:telegram_read:111:"), readAllowed.body);
		const readDenied = await call(readerToken, "read-2", "telegram_read", { args: ["read", "222"] });
		check(
			"telegram_read outside allowChats is denied with a clear reason",
			decisionOf(readDenied.body) === "deny" && textOf(readDenied.body).includes("allowChats") && textOf(readDenied.body).includes('"111"'),
			readDenied.body,
		);
		const readNoChat = await call(readerToken, "read-3", "telegram_read", { args: ["read"] });
		check("telegram_read without a chat is denied", decisionOf(readNoChat.body) === "deny" && textOf(readNoChat.body).includes("chat argument"), readNoChat.body);

		const readModeWrite = await call(readerToken, "rw-1", "telegram_write", { args: ["send", "111", "nope"] });
		check("telegram_write in mode read is denied", decisionOf(readModeWrite.body) === "deny" && textOf(readModeWrite.body).includes("read-only"), readModeWrite.body);

		const asked = await call(askerToken, "ask-1", "telegram_write", { args: ["send", "111", "-"], stdin: longWriteText });
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
		const numericChat = await call(resolverToken, "res-number", "telegram_write", { args: ["send", "111", "numeric"] });
		const toChat = await call(resolverToken, "res-to", "telegram_write", { args: ["send", "111", "to-string"] });
		const recipientChat = await call(resolverToken, "res-recipient", "telegram_write", { args: ["send", "111", "recipient-string"] });
		check(
			"three allowed argv writes are forwarded",
			textOf(numericChat.body).startsWith("fake:telegram_write:111:numeric") &&
				textOf(toChat.body).startsWith("fake:telegram_write:111:to-string") &&
				textOf(recipientChat.body).startsWith("fake:telegram_write:111:recipient-string"),
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

		const unopened = await call(unopenedToken, "auto-0", "telegram_write", { args: ["send", "111", "no window"] });
		check(
			"write:auto without an open TTL window is denied",
			decisionOf(unopened.body) === "deny" && textOf(unopened.body).includes("write window"),
			unopened.body,
		);
		const outsideWrite = await call(autoToken, "auto-outside", "telegram_write", { args: ["send", "222", "elsewhere"] });
		check(
			"telegram_write outside allowChats is denied",
			decisionOf(outsideWrite.body) === "deny" && textOf(outsideWrite.body).includes("allowChats"),
			outsideWrite.body,
		);
		const auto1 = await call(autoToken, "auto-1", "telegram_write", { args: ["send", "111", "one"] });
		const auto2 = await call(autoToken, "auto-2", "telegram_write", { args: ["send", "111", "two"] });
		check("write:auto allows writes within the limit", textOf(auto1.body).startsWith("fake:telegram_write:111:one") && textOf(auto2.body).startsWith("fake:telegram_write:111:two"), [auto1.body, auto2.body]);
		const auto3 = await call(autoToken, "auto-3", "telegram_write", { args: ["send", "111", "three"] });
		check(
			"write:auto denies the write over the hourly limit",
			decisionOf(auto3.body) === "deny" && textOf(auto3.body).includes("write limit"),
			auto3.body,
		);
		const autoWrites = readJsonl(writeLog).filter((entry) => entry.profile === "autowriter");
		check("only the two allowed auto writes reached the upstream", autoWrites.length === 2, autoWrites.length);

		const burst = await Promise.all(
			Array.from({ length: 4 }, (_, index) =>
				call(burstToken, `burst-${index}`, "telegram_write", { args: ["send", "111", `burst-${index}`] }),
			),
		);
		const burstAllowed = burst.filter((response) => textOf(response.body).startsWith("fake:telegram_write:")).length;
		const burstDenied = burst.filter((response) => decisionOf(response.body) === "deny").length;
		check("parallel auto writes reserve exactly the free slots", burstAllowed === 3 && burstDenied === 1, { burstAllowed, burstDenied });
		const burstWrites = readJsonl(writeLog).filter((entry) => entry.profile === "burst");
		check("the parallel burst sent exactly three writes upstream", burstWrites.length === 3, burstWrites.length);

		const expired = await call(expiredToken, "expired-1", "telegram_write", { args: ["send", "111", "late"] });
		check(
			"an expired TTL window closes write:auto",
			decisionOf(expired.body) === "deny" && textOf(expired.body).includes("expired"),
			expired.body,
		);

		for (const [label, args] of [
			["mass send", { args: ["send", "111", "@other"] }],
			["invite", { args: ["send", "111", "join"] }],
			["delete chat", { args: ["delete", "111"] }],
		] as const) {
			const denied = await call(autoToken, `black-${label}`, "telegram_write", args);
			check(`${label} is denied in any mode`, decisionOf(denied.body) === "deny", denied.body);
		}

		const serverRequest = await call(readerToken, "srv-1", "telegram_read", { args: ["get", "111", "server-request"] });
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
		const slow = call(readerToken, "same-id", "telegram_read", { args: ["get", "111", "slow-call"] }, "conn-a");
		await delay(15);
		const fast = call(readerToken, "same-id", "telegram_read", { args: ["get", "111", "fast-call"] }, "conn-b");
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
		const crashed = await call(crasherToken, "crash-1", "telegram_read", { args: ["get", "111", "crash-once"] });
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
			command?: string;
			chat?: string;
			decision?: string;
			reason?: string;
			bytes?: number;
			preview?: string;
		}>;
		check("the audit records allow and deny decisions", audit.some((entry) => entry.decision === "allow") && audit.some((entry) => entry.decision === "deny"), audit.length);
		const deniedRead = audit.find((entry) => entry.tool === "telegram_read" && entry.chat === "222");
		check("the denied read has profile, reason and decision", deniedRead?.profile === "reader" && deniedRead?.decision === "deny" && (deniedRead?.reason ?? "").includes("allowChats"), deniedRead);
		check("the audit records the command name", deniedRead?.command === "read", deniedRead);
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
			call(confirmerToken, id, "telegram_write", { args: ["send", "111", text], ...extra });
		const confirmerWrites = (text?: string) =>
			readJsonl(writeLog).filter(
				(entry) => entry.profile === "confirmer" && (text === undefined || entry.text === text),
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
		const hashArgs = { args: ["send", "111", "confirm-hash"], nested: { b: 2, a: 1 }, list: [1, { z: 0, a: 1 }] };
		const hashCall = call(confirmerToken, "conf-hash", "telegram_write", hashArgs);
		await waitFor(() => ticketsWithText("confirm-hash").length === 1);
		const hashTicket = ticketsWithText("confirm-hash")[0];
		if (!hashTicket) throw new Error("the hash ticket is missing");
		const reordered = { list: [1, { a: 1, z: 0 }], nested: { a: 1, b: 2 }, args: ["send", "111", "confirm-hash"] };
		check(
			"the ticket hash covers all arguments canonically (key order is irrelevant)",
			hashTicket.requestHash === telegramMcpRequestHash(hashArgs) &&
				hashTicket.requestHash === telegramMcpRequestHash(reordered) &&
				hashTicket.requestHash !== telegramMcpRequestHash({ ...hashArgs, args: ["send", "111", "another"] }),
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
		const tamperArgs = { args: ["send", "111", "confirm-tamper"] };
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
			body: JSON.stringify({ jsonrpc: "2.0", id: "conf-abort", method: "tools/call", params: { name: "telegram_write", arguments: { args: ["send", "111", "confirm-abort"] } } }),
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

	section("server: argv tool calls, stdin, modes and limits");
	{
		// The confirmation section advanced the injected clock; reopen the windows.
		limits!.openWindow("argvwriter", 60_000, clockNow);
		limits!.openWindow("argvlimit", 60_000, clockNow);
		const callLogEntries = (profile: string) => readJsonl(callLog).filter((entry) => entry.profile === profile);

		const argvRead = await call(readerToken, "argv-read-allow", "telegram_read", { args: ["read", "@test"] });
		check("argv read inside allowChats is forwarded", textOf(argvRead.body).startsWith("fake:telegram_read:@test:"), argvRead.body);
		const argvReadDenied = await call(readerToken, "argv-read-deny", "telegram_read", { args: ["read", "@other"] });
		check(
			"argv read outside allowChats is denied",
			decisionOf(argvReadDenied.body) === "deny" && textOf(argvReadDenied.body).includes("allowChats"),
			argvReadDenied.body,
		);

		const sendArgv = await call(argvWriterToken, "argv-send", "telegram_write", { args: ["send", "@test", "hello"] });
		check("argv send with positional text is forwarded", textOf(sendArgv.body).startsWith("fake:telegram_write:@test:hello"), sendArgv.body);
		const sendCall = callLogEntries("argvwriter").find(
			(entry) => Array.isArray(entry.argv) && (entry.argv as string[])[0] === "send" && (entry.argv as string[])[2] === "hello",
		);
		check(
			"the upstream receives the exact argv",
			Array.isArray(sendCall?.argv) && (sendCall!.argv as string[]).join(" ") === "send @test hello",
			sendCall,
		);

		const sendStdin = await call(argvWriterToken, "argv-send-stdin", "telegram_write", { args: ["send", "@test", "-"], stdin: "line from stdin" });
		check("argv send - forwards stdin", textOf(sendStdin.body).includes("line from stdin"), sendStdin.body);
		const stdinCall = callLogEntries("argvwriter").find((entry) => entry.stdin === "line from stdin");
		check(
			"the upstream receives stdin separately from argv",
			Array.isArray(stdinCall?.argv) && (stdinCall!.argv as string[]).join(" ") === "send @test -",
			stdinCall,
		);

		const replyStdin = await call(argvWriterToken, "argv-reply-stdin", "telegram_write", { args: ["reply", "@test", "5", "-"], stdin: "reply text" });
		check("argv reply - forwards stdin", textOf(replyStdin.body).includes("reply text"), replyStdin.body);
		const editStdin = await call(argvWriterToken, "argv-edit-stdin", "telegram_write", { args: ["edit", "@test", "5", "-"], stdin: "edit text" });
		check("argv edit - forwards stdin", textOf(editStdin.body).includes("edit text"), editStdin.body);

		// A legacy flat call must leave the proxy in the real argv shape: the
		// upstream console has spoken `{args, stdin}` only since #274.
		const flatWrite = await call(argvWriterToken, "flat-send", "telegram_write", { chat: "@test", text: "flat path text" });
		check("a flat write is forwarded", textOf(flatWrite.body).includes("flat path text"), flatWrite.body);
		const flatWriteCall = callLogEntries("argvwriter").find((entry) => entry.stdin === "flat path text");
		check(
			"a flat write reaches the upstream as argv plus stdin",
			Array.isArray(flatWriteCall?.argv) && (flatWriteCall!.argv as string[]).join(" ") === "send @test -",
			flatWriteCall,
		);
		const flatRead = await call(readerToken, "flat-read", "telegram_read", { chat: "@test" });
		check("a flat read is forwarded", textOf(flatRead.body).startsWith("fake:telegram_read:@test:"), flatRead.body);
		const flatReadCall = callLogEntries("reader").find(
			(entry) => Array.isArray(entry.argv) && (entry.argv as string[]).join(" ") === "read @test",
		);
		check("a flat read reaches the upstream as argv", flatReadCall !== undefined, flatReadCall);

		const search = await call(readerToken, "argv-search", "telegram_read", { args: ["search", "query", "--chat", "@test"] });
		check("argv search with --chat is forwarded", textOf(search.body).startsWith("fake:telegram_read:@test:query"), search.body);
		const searchNoChat = await call(readerToken, "argv-search-no-chat", "telegram_read", { args: ["search", "query"] });
		check("argv search without --chat is denied", decisionOf(searchNoChat.body) === "deny", searchNoChat.body);
		const writeAccessStatus = await call(readerToken, "argv-write-access", "telegram_read", { args: ["write-access"] });
		check(
			"argv write-access status read is allowed without a chat",
			textOf(writeAccessStatus.body).startsWith("fake:telegram_read::"),
			writeAccessStatus.body,
		);

		const unknown = await call(readerToken, "argv-unknown", "telegram_read", { args: ["frobnicate", "x"] });
		check(
			"argv unknown command is denied",
			decisionOf(unknown.body) === "deny" && textOf(unknown.body).includes("unknown telegram command"),
			unknown.body,
		);
		for (const command of ["delete", "forward", "send-file", "api"]) {
			const denied = await call(argvWriterToken, `argv-deny-${command}`, "telegram_write", { args: [command, "@test"] });
			check(`argv ${command} is denied`, decisionOf(denied.body) === "deny", denied.body);
		}
		const clickDenied = await call(argvWriterToken, "argv-click", "telegram_write", { args: ["click", "@test", "5", "Catalog"] });
		const clickCalls = callLogEntries("argvwriter").filter(
			(entry) => Array.isArray(entry.argv) && (entry.argv as string[])[0] === "click",
		);
		check(
			"argv click is a tool error and never reaches the upstream",
			(clickDenied.body.result as { isError?: boolean } | undefined)?.isError === true &&
				textOf(clickDenied.body).includes("pressing buttons is not allowed") &&
				clickCalls.length === 0,
			{ body: clickDenied.body, calls: clickCalls },
		);
		const twoChats = await call(argvWriterToken, "argv-two-chats", "telegram_write", { args: ["send", "@test", "@other"] });
		check(
			"argv two chats are denied",
			decisionOf(twoChats.body) === "deny" && textOf(twoChats.body).includes("mass send"),
			twoChats.body,
		);
		const unknownFlag = await call(argvWriterToken, "argv-unknown-flag", "telegram_write", { args: ["send", "@test", "hi", "--frobnicate"] });
		check(
			"argv unknown flag is denied",
			decisionOf(unknownFlag.body) === "deny" && textOf(unknownFlag.body).includes("unknown flag"),
			unknownFlag.body,
		);
		const emptyArgv = await call(argvWriterToken, "argv-empty", "telegram_write", { args: [] });
		check("empty argv is denied", decisionOf(emptyArgv.body) === "deny", emptyArgv.body);
		const nonString = await call(argvWriterToken, "argv-non-string", "telegram_write", { args: ["send", 111, "hi"] });
		check("non-string argv is denied", decisionOf(nonString.body) === "deny", nonString.body);
		const mixed = await call(argvWriterToken, "argv-mixed", "telegram_write", { args: ["send", "@test", "hi"], chat: "@other" });
		check(
			"argv plus a different flat chat is denied",
			decisionOf(mixed.body) === "deny" && textOf(mixed.body).includes("mixed argument shapes"),
			mixed.body,
		);
		const dashNoStdin = await call(argvWriterToken, "argv-dash-no-stdin", "telegram_write", { args: ["send", "@test", "-"] });
		check(
			"argv - without stdin is denied",
			decisionOf(dashNoStdin.body) === "deny" && textOf(dashNoStdin.body).includes("stdin"),
			dashNoStdin.body,
		);
		const readMode = await call(readerToken, "argv-read-mode", "telegram_write", { args: ["send", "@test", "hi"] });
		check(
			"argv write in mode read is denied",
			decisionOf(readMode.body) === "deny" && textOf(readMode.body).includes("read-only"),
			readMode.body,
		);

		// write:ask with argv and stdin.
		const askCall = call(argvAskerToken, "argv-ask", "telegram_write", { args: ["send", "@test", "-"], stdin: "confirm argv text" });
		let askSettled = false;
		void askCall.then(() => {
			askSettled = true;
		});
		const argvAskDir = profileTicketDir(confirmationDir, "argvasker");
		const askReady = await waitFor(() => listTickets(argvAskDir).some((ticket) => ticket.text === "confirm argv text"));
		const askTicket = listTickets(argvAskDir).find((ticket) => ticket.text === "confirm argv text");
		check("argv write:ask creates a pending ticket", askReady && askTicket?.status === "pending", askTicket);
		check('the ticket carries argv.join(" ") as command', askTicket?.command === "send @test -", askTicket);
		await delay(50);
		check("the argv ask blocks before sending", !askSettled && callLogEntries("argvasker").length === 0, askSettled);
		if (!askTicket) throw new Error("the argv ask ticket is missing");
		writeDecision(argvAskDir, decisionFor(askTicket, "approve") as Parameters<typeof writeDecision>[1]);
		const askApproved = await askCall;
		check("argv write:ask approval forwards the exact argv and stdin", textOf(askApproved.body).includes("confirm argv text"), askApproved.body);
		const askForward = callLogEntries("argvasker").find((entry) => Array.isArray(entry.argv));
		check(
			"the approved argv write reaches the upstream unchanged",
			Array.isArray(askForward?.argv) && (askForward!.argv as string[]).join(" ") === "send @test -" && askForward?.stdin === "confirm argv text",
			askForward,
		);
		check("the argv ask ticket is marked sent", readTicket(argvAskDir, askTicket.ticketId)?.status === "sent", readTicket(argvAskDir, askTicket.ticketId));

		// write:auto limits on argv calls.
		const limit1 = await call(argvLimitToken, "argv-limit-1", "telegram_write", { args: ["send", "@test", "one"] });
		const limit2 = await call(argvLimitToken, "argv-limit-2", "telegram_write", { args: ["send", "@test", "two"] });
		const limit3 = await call(argvLimitToken, "argv-limit-3", "telegram_write", { args: ["send", "@test", "three"] });
		check(
			"argv write:auto honours the hourly limit",
			textOf(limit1.body).startsWith("fake:telegram_write:@test:one") &&
				textOf(limit2.body).startsWith("fake:telegram_write:@test:two") &&
				decisionOf(limit3.body) === "deny" &&
				textOf(limit3.body).includes("write limit"),
			[limit1.body, limit2.body, limit3.body],
		);

		const argvAudit = readJsonl(telegramMcpAuditFile(stateDir)) as unknown as Array<{ profile?: string; command?: string; tool?: string }>;
		check(
			"the audit records the argv command",
			argvAudit.some((entry) => entry.profile === "argvwriter" && entry.tool === "telegram_write" && entry.command === "send"),
			argvAudit.filter((entry) => entry.profile === "argvwriter"),
		);
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
