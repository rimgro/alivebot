/**
 * Tests for secret masking:
 *
 *   npx tsx src/dev/secrets-test.ts
 *
 * Covers every built-in pattern, environment-value fallback, config extra
 * patterns, the structured logger, agent-visible event rendering and the
 * Telegram outbound boundary against a fake Bot API.
 */
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { loadConfig, validateSecretsConfig } from "../config.js";
import { ModuleHost } from "../events/host.js";
import { Logger } from "../log.js";
import { TelegramModule } from "../modules/telegram/module.js";
import { maskSecrets, maskValue } from "../secrets.js";
import type { AliveEvent } from "../store/events.js";
import { EventStore } from "../store/events.js";
import { HistoryStore } from "../store/history.js";
import { Outbox } from "../store/outbox.js";
import { renderIdleEvents } from "../runtime/prompt.js";

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

function jsonResponse(value: unknown, status = 200): Response {
	return new Response(JSON.stringify(value), { status, headers: { "content-type": "application/json" } });
}

const telegramToken = `123456789:${"A".repeat(35)}`;
const githubToken = `ghp_${"a".repeat(36)}`;
const githubPat = `github_pat_${"A1".repeat(12)}`;
const openaiKey = `sk-proj-${"a".repeat(24)}`;
const anthropicKey = `sk-ant-api03-${"a".repeat(24)}`;
const groqKey = `gsk_${"a".repeat(24)}`;
const awsKey = "AKIAIOSFODNN7EXAMPLE";
const bearerToken = "abcDEF1234567890_xyz-TOKEN";
const jwt = "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U";
const urlPassword = "s3cr3t-password";
const privateKey = "-----BEGIN RSA PRIVATE KEY-----\nMIIEowIBAAKCAQEAfakefakefake\n-----END RSA PRIVATE KEY-----";

const positiveCases: Array<{ name: string; label: string; secret: string; text?: string }> = [
	{ name: "Telegram bot token", label: "telegram", secret: telegramToken },
	{ name: "GitHub token", label: "github", secret: githubToken },
	{ name: "GitHub fine-grained PAT", label: "github", secret: githubPat },
	{ name: "OpenAI-style key", label: "openai", secret: openaiKey },
	{ name: "Anthropic-style key", label: "anthropic", secret: anthropicKey },
	{ name: "Groq-style key", label: "groq", secret: groqKey },
	{ name: "AWS access key id", label: "aws", secret: awsKey },
	{ name: "bare Bearer token", label: "bearer", secret: bearerToken, text: `call with Bearer ${bearerToken}` },
	{
		name: "Authorization Bearer header",
		label: "bearer",
		secret: bearerToken,
		text: `Authorization: Bearer ${bearerToken}`,
	},
	{ name: "JWT", label: "jwt", secret: jwt },
	{ name: "PEM private key block", label: "pem", secret: privateKey },
	{
		name: "URL credentials",
		label: "url",
		secret: urlPassword,
		text: `clone https://alice:${urlPassword}@example.com/repo`,
	},
];

// ---------------------------------------------------------------------------
section("built-in patterns: positives and negatives");
{
	for (const entry of positiveCases) {
		const text = entry.text ?? `before ${entry.secret} after`;
		const masked = maskSecrets(text);
		check(`${entry.name} is masked`, !masked.includes(entry.secret), masked);
		check(`${entry.name} keeps a type label`, masked.includes(`[${entry.label}:`), masked);
	}

	const unchanged = [
		"the token is expired",
		"the key is under the mat",
		"https://example.com/path?q=1&x=2#fragment",
		"commit 9f86d081884c7d659a2feaa0c55ad015a3bf4f1b",
		"request 123e4567-e89b-12d3-a456-426614174000",
		"Bearer short",
		"plain 1234567890 number",
		"ghp_short",
		"-----BEGIN PUBLIC KEY-----\nnot a private key\n-----END PUBLIC KEY-----",
	];
	for (const text of unchanged) check(`unchanged: ${JSON.stringify(text)}`, maskSecrets(text) === text, maskSecrets(text));

	// Never keep more than the first 3 + last 2 characters of a value.
	const maskedGithub = maskSecrets(`token=${githubToken}`);
	const head = githubToken.slice(0, 3);
	const tail = githubToken.slice(-2);
	const middle = githubToken.slice(3, -2);
	check("the mask keeps the first 3 and last 2 characters", maskedGithub.includes(`${head}…${tail}`), maskedGithub);
	check("the middle of the secret is gone", !maskedGithub.includes(middle), maskedGithub);
}

// ---------------------------------------------------------------------------
section("environment-value masking");
{
	const previousToken = process.env.ALIVE_SECRETS_TEST_TOKEN;
	const previousPassword = process.env.ALIVE_SECRETS_TEST_PASSWORD;
	process.env.ALIVE_SECRETS_TEST_TOKEN = "env-secret-value-123";
	process.env.ALIVE_SECRETS_TEST_PASSWORD = "abc123";
	try {
		const masked = maskSecrets("prefix env-secret-value-123 suffix");
		check("an env value under a secret-looking name is masked", !masked.includes("env-secret-value-123"), masked);
		check("the env mask keeps a label", masked.includes("[env:"), masked);
		check("a short env value is not masked", maskSecrets("value abc123 here") === "value abc123 here");
		check(
			"maskEnv: false disables the env fallback",
			maskSecrets("prefix env-secret-value-123 suffix", { maskEnv: false, extraPatterns: [] }).includes("env-secret-value-123"),
		);
		const structured = maskValue({ value: "env-secret-value-123", nested: { value: "env-secret-value-123" } }) as {
			value: string;
			nested: { value: string };
		};
		check("maskValue masks nested env values", !structured.value.includes("env-secret-value-123") && !structured.nested.value.includes("env-secret-value-123"), structured);
	} finally {
		if (previousToken === undefined) delete process.env.ALIVE_SECRETS_TEST_TOKEN;
		else process.env.ALIVE_SECRETS_TEST_TOKEN = previousToken;
		if (previousPassword === undefined) delete process.env.ALIVE_SECRETS_TEST_PASSWORD;
		else process.env.ALIVE_SECRETS_TEST_PASSWORD = previousPassword;
	}
}

// ---------------------------------------------------------------------------
section("config extra patterns");
{
	const config = validateSecretsConfig({ maskEnv: false, extraPatterns: ["acme_[A-Za-z0-9]{16,}"] });
	const secret = `acme_${"Z".repeat(20)}`;
	const masked = maskSecrets(`project key ${secret}`, config);
	check("an extra pattern is applied", !masked.includes(secret) && masked.includes("[custom:") && masked.includes("…"), masked);

	let rejected: Error | undefined;
	try {
		validateSecretsConfig({ maskEnv: true, extraPatterns: ["("] });
	} catch (err) {
		rejected = err instanceof Error ? err : new Error(String(err));
	}
	check("an invalid extra pattern is rejected", rejected !== undefined && /not a valid RegExp/.test(rejected.message), rejected?.message);

	const goodRoot = fs.mkdtempSync(path.join(os.tmpdir(), "alive-secrets-config-good-"));
	const badRoot = fs.mkdtempSync(path.join(os.tmpdir(), "alive-secrets-config-bad-"));
	try {
		fs.writeFileSync(
			path.join(goodRoot, "alive.config.json"),
			JSON.stringify({ secrets: { maskEnv: false, extraPatterns: ["acme_[A-Za-z0-9]{16,}"] } }),
		);
		const loaded = loadConfig({ cwd: goodRoot });
		check(
			"extraPatterns load through the config file",
			loaded.config.secrets.maskEnv === false && loaded.config.secrets.extraPatterns.length === 1 && !maskSecrets(`key ${secret}`, loaded.config.secrets).includes(secret),
			loaded.config.secrets,
		);

		fs.writeFileSync(path.join(badRoot, "alive.config.json"), JSON.stringify({ secrets: { maskEnv: true, extraPatterns: ["("] } }));
		let configRejected = false;
		try {
			loadConfig({ cwd: badRoot });
		} catch {
			configRejected = true;
		}
		check("loadConfig rejects an invalid extra pattern", configRejected);
	} finally {
		fs.rmSync(goodRoot, { recursive: true, force: true });
		fs.rmSync(badRoot, { recursive: true, force: true });
	}
}

// ---------------------------------------------------------------------------
section("structured values");
{
	const masked = maskValue({
		token: githubToken,
		nested: { keys: [openaiKey, { aws: awsKey }] },
		error: new Error(`failed with ${telegramToken}`),
		plain: 42,
		flag: true,
	}) as {
		token: string;
		nested: { keys: Array<string | { aws: string }> };
		error: { message: string; stack?: string };
		plain: number;
		flag: boolean;
	};
	check("maskValue masks top-level strings", !masked.token.includes(githubToken), masked.token);
	check("maskValue masks nested arrays", !masked.nested.keys.some((entry) => JSON.stringify(entry).includes(openaiKey)), masked.nested);
	check("maskValue masks Error messages", !masked.error.message.includes(telegramToken), masked.error.message);
	check("maskValue leaves numbers and booleans alone", masked.plain === 42 && masked.flag === true);
}

// ---------------------------------------------------------------------------
section("logger integration");
{
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "alive-secrets-log-"));
	const file = path.join(root, "alive.jsonl");
	const logger = new Logger({ file, console: false, level: "debug" });
	const error = new Error(`provider rejected ${githubToken}`);
	logger.info(`login with ${telegramToken}`, {
		token: githubToken,
		nested: { aws: awsKey, list: [openaiKey], error },
		short: "not-a-secret",
	});

	const line = fs.readFileSync(file, "utf8").trim().split("\n").at(-1) ?? "";
	const record = JSON.parse(line) as {
		msg: string;
		data: { token: string; nested: { aws: string; list: string[]; error: { message: string } }; short: string };
	};
	check("the log line carries no raw secret", !line.includes(telegramToken) && !line.includes(githubToken) && !line.includes(openaiKey) && !line.includes(awsKey), line);
	check("the log message is masked", record.msg.includes("[telegram:"), record.msg);
	check("the top-level field is masked", record.data.token.includes("[github:") && !record.data.token.includes(githubToken), record.data.token);
	check("nested fields are masked", record.data.nested.aws.includes("[aws:") && record.data.nested.list[0]?.includes("[openai:"), record.data.nested);
	check("the nested Error message is masked", record.data.nested.error.message.includes("[github:"), record.data.nested.error.message);
	check("unrelated short text survives", record.data.short === "not-a-secret", record.data.short);

	fs.rmSync(root, { recursive: true, force: true });
}

// ---------------------------------------------------------------------------
section("agent-visible event text");
{
	const event: AliveEvent = {
		seq: 1,
		id: "event-1",
		ts: Date.now(),
		kind: "observability",
		source: "test",
		priority: "high",
		title: `alert with ${githubToken}`,
		text: `body contains ${telegramToken}`,
		payload: { nested: { key: openaiKey, error: `bad ${awsKey}` } },
	};
	const rendered = renderIdleEvents([event]);
	check("agent-visible event title is masked", !rendered.includes(githubToken) && rendered.includes("[github:"), rendered);
	check("agent-visible event text is masked", !rendered.includes(telegramToken) && rendered.includes("[telegram:"), rendered);
	check("agent-visible event payload is masked", !rendered.includes(openaiKey) && !rendered.includes(awsKey) && rendered.includes("[openai:"), rendered);
}

// ---------------------------------------------------------------------------
section("telegram outbound against a fake Bot API");
{
	const moduleRoot = fs.mkdtempSync(path.join(os.tmpdir(), "alive-secrets-telegram-"));
	const loaded = loadConfig({ cwd: moduleRoot });
	loaded.config.modules.telegram = {
		...loaded.config.modules.telegram,
		enabled: true,
		token: "test-token",
		tokenEnv: "ALIVE_TEST_SECRETS_TELEGRAM_TOKEN_UNSET",
		allowedUserIds: ["7"],
		allowedChatIds: [],
		allowedBotIds: [],
		requireMentionInGroups: false,
		pollTimeoutSec: 0,
		allowedUpdates: ["message"],
		parseMode: "",
		linkPreview: true,
		typingIndicator: false,
		ackReaction: "",
		ingestEdits: true,
		historyLimitPerThread: 0,
		maxMessageChars: 4096,
	};
	const store = EventStore.open(loaded.paths.stateDir);
	const history = HistoryStore.open(loaded.paths.stateDir);
	const outbox = new Outbox(loaded.paths.stateDir);
	fs.mkdirSync(loaded.paths.workspaceDir, { recursive: true });
	fs.writeFileSync(path.join(loaded.paths.workspaceDir, "report.txt"), "secret report\n");

	const calls: Array<{ method: string; params: Record<string, unknown>; form?: Record<string, unknown> }> = [];
	const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
		const url = String(input);
		const method = url.slice(url.lastIndexOf("/") + 1);
		if (method === "getUpdates") {
			return new Promise<Response>((_resolve, reject) => {
				const signal = init?.signal;
				if (!signal) return reject(new Error("getUpdates: missing abort signal"));
				const fail = () => reject(signal.reason instanceof Error ? signal.reason : new Error("getUpdates aborted"));
				if (signal.aborted) return fail();
				signal.addEventListener("abort", fail, { once: true });
			});
		}
		const isForm = init?.body instanceof FormData;
		const form = isForm
			? Object.fromEntries(
					[...(init!.body as FormData).entries()].map(([key, value]) => [
						key,
						typeof value === "string" ? value : { name: value.name, type: value.type, size: value.size },
					]),
			  )
			: undefined;
		const params = isForm
			? { __multipart: [...(init!.body as FormData).keys()] }
			: init?.body
				? (JSON.parse(String(init.body)) as Record<string, unknown>)
				: {};
		calls.push({ method, params, form });
		if (method === "getMe") return jsonResponse({ ok: true, result: { id: 999, is_bot: true, first_name: "Alive", username: "alive_bot" } });
		if (method === "deleteWebhook") return jsonResponse({ ok: true, result: true });
		if (method === "sendMessage" || method === "sendDocument" || method === "sendPhoto") {
			return jsonResponse({ ok: true, result: { message_id: 100 + calls.length, date: 1, chat: { id: 42, type: "private" } } });
		}
		return jsonResponse({ ok: true, result: true });
	}) as unknown as typeof fetch;

	const telegram = new TelegramModule(loaded.config.modules.telegram);
	const realFetch = globalThis.fetch;
	globalThis.fetch = fetchImpl;
	let host: ModuleHost | undefined;
	try {
		host = new ModuleHost({
			config: loaded,
			log: new Logger({ console: false, level: "error", scope: "secrets-telegram" }),
			transports: [],
			modules: [telegram],
			ingest: (event) => store.append(event),
			outbox: (limit) => outbox.list(limit),
			history,
			runtimeStatus: () => ({}),
			workspaceFiles: {
				rootDir: loaded.paths.workspaceDir,
				readFile: async (file) => fs.readFileSync(file),
				writeFile: async (file, data) => {
					fs.mkdirSync(path.dirname(file), { recursive: true });
					fs.writeFileSync(file, data);
					return file;
				},
			},
		});
		await host.init();
		await new Promise((resolve) => setTimeout(resolve, 40));

		const deliver = (id: string, text: string, attachments?: Array<{ path: string; kind?: "document" }>) =>
			host!.deliver({
				id,
				runId: "run",
				thread: "telegram:42",
				text,
				ts: Date.now(),
				...(attachments ? { attachments } : {}),
			});

		await deliver("secret_text", `here is the token ${githubToken}`);
		const textCall = calls.filter((call) => call.method === "sendMessage").at(-1);
		const sentText = textCall?.params.text;
		check("send_message text arrives masked", typeof sentText === "string" && !sentText.includes(githubToken) && sentText.includes("[github:"), sentText);

		await deliver("secret_caption", `caption ${telegramToken}`, [{ path: "report.txt" }]);
		const captionCall = calls.filter((call) => call.method === "sendDocument").at(-1);
		const sentCaption = captionCall?.form?.caption;
		check("an attachment caption arrives masked", typeof sentCaption === "string" && !sentCaption.includes(telegramToken) && sentCaption.includes("[telegram:"), sentCaption);

		const beforeFollowUp = calls.length;
		await deliver("secret_followup", `${"a".repeat(1200)} ${openaiKey}`, [{ path: "report.txt" }]);
		const followUps = calls.slice(beforeFollowUp).filter((call) => call.method === "sendMessage");
		const followUpText = followUps.map((call) => String(call.params.text ?? "")).join("\n");
		check("the caption follow-up text arrives masked", !followUpText.includes(openaiKey) && followUpText.includes("[openai:"), followUpText);
	} finally {
		await host?.stop();
		globalThis.fetch = realFetch;
		fs.rmSync(moduleRoot, { recursive: true, force: true });
	}
}

process.stdout.write(failures === 0 ? "\nALL SECRET TESTS PASSED\n" : `\n${failures} SECRET TEST(S) FAILED\n`);
process.exitCode = failures === 0 ? 0 : 1;
