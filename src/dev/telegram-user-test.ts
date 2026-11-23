/**
 * Telegram user-account (MTProto) infrastructure test (#248, step A):
 *
 *   npx tsx src/dev/telegram-user-test.ts
 *
 * Filesystem fixtures only: no network, no MTProto library, no bot token.
 * Covers `modules.telegram.user` validation, `api_hash`/session-path resolution,
 * readiness reporting, and the session store's permissions and atomicity.
 */
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { DEFAULT_CONFIG, validateTelegramConfig } from "../config.js";
import {
	DEFAULT_TELEGRAM_USER_CONFIG,
	resolveUserApiHash,
	resolveUserSessionFile,
	telegramUserReadiness,
	validateTelegramUserConfig,
	type TelegramUserConfig,
} from "../modules/telegram/user/config.js";
import { UserSessionStore } from "../modules/telegram/user/session-store.js";

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

/** Run `fn`, return its error message, and record whether it threw at all. */
function thrown(fn: () => unknown): string {
	try {
		fn();
	} catch (error) {
		return error instanceof Error ? error.message : String(error);
	}
	return "";
}

const SESSION_VALUE = "1BVtsOK4Bu0test-session-secret-value-9f8e7d6c";

const root = fs.mkdtempSync(path.join(os.tmpdir(), "alive-telegram-user-test-"));
const stateDir = path.join(root, ".alive");

try {
	section("user config: defaults");
	{
		const parsed = validateTelegramUserConfig(DEFAULT_TELEGRAM_USER_CONFIG);
		check("default is a valid block", parsed.enabled === false && (parsed.allowedChatIds ?? []).length === 0, parsed);
		check("default api_hash variable is TELEGRAM_API_HASH", parsed.apiHashEnv === "TELEGRAM_API_HASH", parsed.apiHashEnv);
		check("default block carries no api_id, api_hash or session file", parsed.apiId === undefined && !("apiHash" in parsed) && parsed.sessionFile === undefined, parsed);
		check("DEFAULT_CONFIG ships the disabled user block", DEFAULT_CONFIG.modules.telegram.user?.enabled === false, DEFAULT_CONFIG.modules.telegram.user);
		check(
			"the default session file is under the state dir",
			resolveUserSessionFile(DEFAULT_CONFIG.modules.telegram.user as TelegramUserConfig, stateDir) === path.join(stateDir, "telegram-user", "session"),
			resolveUserSessionFile(DEFAULT_CONFIG.modules.telegram.user as TelegramUserConfig, stateDir),
		);
	}

	section("user config: valid values are normalised");
	{
		const parsed = validateTelegramUserConfig({
			enabled: true,
			apiId: 123456,
			apiHashEnv: "  MY_TELEGRAM_HASH  ",
			sessionFile: "  telegram-user/session  ",
			allowedChatIds: ["  123456789  ", "  @some_one  "],
		});
		check("api_id is kept", parsed.apiId === 123456, parsed.apiId);
		check("the api_hash variable is trimmed", parsed.apiHashEnv === "MY_TELEGRAM_HASH", parsed.apiHashEnv);
		check("there is no config api_hash field", !("apiHash" in parsed), Object.keys(parsed));
		check("session file is normalised", parsed.sessionFile === path.join("telegram-user", "session"), parsed.sessionFile);
		check("allowed chat ids are trimmed", (parsed.allowedChatIds ?? []).join(",") === "123456789,@some_one", parsed.allowedChatIds);
		const minimal = validateTelegramUserConfig({ enabled: false, allowedChatIds: [] });
		check("optional keys may be omitted", minimal.enabled === false && minimal.apiId === undefined, minimal);
		const noAllowlist = validateTelegramUserConfig({ enabled: true, apiId: 123 });
		check("an omitted allowlist is valid and means nobody", Array.isArray(noAllowlist.allowedChatIds) && noAllowlist.allowedChatIds.length === 0, noAllowlist);
	}

	section("user config: garbage is rejected loudly");
	{
		const cases: Array<[string, unknown]> = [
			["not an object", "yes"],
			["an array", []],
			["null", null],
			["enabled: \"yes\"", { enabled: "yes", allowedChatIds: [] }],
			["apiId: 0", { enabled: true, apiId: 0, allowedChatIds: [] }],
			["apiId: -1", { enabled: true, apiId: -1, allowedChatIds: [] }],
			["apiId: 1.5", { enabled: true, apiId: 1.5, allowedChatIds: [] }],
			["apiId: \"123\"", { enabled: true, apiId: "123", allowedChatIds: [] }],
			["empty apiHashEnv", { enabled: true, apiHashEnv: "   ", allowedChatIds: [] }],
			["a plaintext apiHash in the config", { enabled: true, apiHash: "plaintext-hash-value", allowedChatIds: [] }],
			["absolute sessionFile", { enabled: true, sessionFile: "/tmp/telegram-session", allowedChatIds: [] }],
			["sessionFile \"../evil\"", { enabled: true, sessionFile: "../evil", allowedChatIds: [] }],
			["sessionFile escaping through ..", { enabled: true, sessionFile: "telegram-user/../../evil", allowedChatIds: [] }],
			["empty sessionFile", { enabled: true, sessionFile: "  ", allowedChatIds: [] }],
			["allowedChatIds not an array", { enabled: true, allowedChatIds: "123456789" }],
			["allowedChatIds with an empty string", { enabled: true, allowedChatIds: ["123456789", "  "] }],
			["allowedChatIds with a number", { enabled: true, allowedChatIds: [123456789] }],
			["allowedChatIds with a duplicate", { enabled: true, allowedChatIds: ["123456789", " 123456789 "] }],
		];
		for (const [label, value] of cases) {
			const message = thrown(() => validateTelegramUserConfig(value));
			check(`${label} is rejected`, message.startsWith("modules.telegram.user"), message || "accepted");
		}
		const prefix = thrown(() => validateTelegramUserConfig({ enabled: true, apiId: 0, allowedChatIds: [] }, "custom.block"));
		check("a custom prefix is used in messages", prefix.startsWith("custom.block.apiId"), prefix);
		const hashMessage = thrown(() => validateTelegramUserConfig({ enabled: true, apiHash: 42, allowedChatIds: [] }));
		check(
			"a plaintext api_hash is rejected and points at the environment",
			hashMessage.startsWith("modules.telegram.user.apiHash is not supported") && hashMessage.includes("TELEGRAM_API_HASH"),
			hashMessage || "accepted",
		);
		check("the rejected api_hash value is never echoed", !hashMessage.includes("42") && !hashMessage.includes("plaintext-hash-value"), hashMessage);
		const customHashMessage = thrown(() =>
			validateTelegramUserConfig({ enabled: true, apiHashEnv: "MY_HASH", apiHash: "plaintext-hash-value", allowedChatIds: [] }),
		);
		check("the rejection names the configured variable", customHashMessage.includes("MY_HASH") && !customHashMessage.includes("plaintext-hash-value"), customHashMessage);
	}

	section("user config: wired into validateTelegramConfig");
	{
		const merged = validateTelegramConfig({
			...DEFAULT_CONFIG.modules.telegram,
			user: { enabled: true, apiId: 777, allowedChatIds: [" @owner "] },
		});
		check("a valid user block survives validation", merged.user?.enabled === true && merged.user?.apiId === 777, merged.user);
		check("user chat ids are normalised", (merged.user?.allowedChatIds ?? []).join(",") === "@owner", merged.user?.allowedChatIds);
		const noAllowlist = validateTelegramConfig({ ...DEFAULT_CONFIG.modules.telegram, user: { enabled: true, apiId: 777 } });
		check("a user block without an allowlist loads with []", noAllowlist.user?.allowedChatIds?.length === 0, noAllowlist.user);
		const message = thrown(() =>
			validateTelegramConfig({ ...DEFAULT_CONFIG.modules.telegram, user: { enabled: true, apiId: 0, allowedChatIds: [] } as never }),
		);
		check("an invalid user block fails the telegram block", message.startsWith("modules.telegram.user.apiId"), message || "accepted");
		const without = validateTelegramConfig({ ...DEFAULT_CONFIG.modules.telegram, user: undefined });
		check("an absent user block stays absent (never enabled by accident)", without.user === undefined, without.user);
	}

	section("resolveUserApiHash: environment only, trimmed");
	{
		const config = validateTelegramUserConfig({ enabled: true, apiHashEnv: "USER_HASH" });
		check("the environment value is used", resolveUserApiHash(config, { USER_HASH: " from-env " }) === "from-env", resolveUserApiHash(config, { USER_HASH: " from-env " }));
		check("an empty variable resolves to an empty string", resolveUserApiHash(config, { USER_HASH: "   " }) === "", resolveUserApiHash(config, { USER_HASH: "   " }));
		check("a missing variable resolves to an empty string", resolveUserApiHash(config, {}) === "");
		check("nothing configured resolves to an empty string", resolveUserApiHash({ enabled: true }, {}) === "", resolveUserApiHash({ enabled: true }, {}));
		check(
			"a block without apiHashEnv falls back to the default variable",
			resolveUserApiHash({ enabled: true }, { TELEGRAM_API_HASH: "default-var" }) === "default-var",
			resolveUserApiHash({ enabled: true }, { TELEGRAM_API_HASH: "default-var" }),
		);
	}

	section("resolveUserSessionFile: stays inside the state dir");
	{
		const base = resolveUserSessionFile({ enabled: true, allowedChatIds: [] }, stateDir);
		check("the default is <stateDir>/telegram-user/session", base === path.join(stateDir, "telegram-user", "session"), base);
		check("the default is inside the state dir", base.startsWith(path.resolve(stateDir) + path.sep), base);
		const relative = resolveUserSessionFile({ enabled: true, sessionFile: "secrets/session.txt", allowedChatIds: [] }, stateDir);
		check("a relative path is resolved against the state dir", relative === path.join(path.resolve(stateDir), "secrets/session.txt"), relative);
		const escaped = thrown(() => resolveUserSessionFile({ enabled: true, sessionFile: "../outside", allowedChatIds: [] }, stateDir));
		check("a parent-relative path outside the state dir is refused", escaped.includes("state directory"), escaped || "accepted");
		const absolute = thrown(() => resolveUserSessionFile({ enabled: true, sessionFile: "/tmp/outside", allowedChatIds: [] }, stateDir));
		check("an absolute path outside the state dir is refused", absolute.includes("state directory"), absolute || "accepted");
		check("the refusal names no session value", !escaped.includes(SESSION_VALUE) && !absolute.includes(SESSION_VALUE));
	}

	section("telegramUserReadiness: only names the missing setting");
	{
		const disabled = telegramUserReadiness({ enabled: false, apiId: 1, apiHashEnv: "USER_HASH" }, { USER_HASH: SESSION_VALUE });
		check("disabled is not ready", disabled.ok === false && Boolean(disabled.reason), disabled);
		const noId = telegramUserReadiness({ enabled: true }, {});
		check("a missing api_id is not ready", noId.ok === false && noId.reason?.includes("apiId") === true, noId);
		const noHash = telegramUserReadiness({ enabled: true, apiId: 123, apiHashEnv: "USER_HASH" }, {});
		check("a missing api_hash is not ready", noHash.ok === false && noHash.reason?.includes("USER_HASH") === true, noHash);
		const ready = telegramUserReadiness({ enabled: true, apiId: 123, apiHashEnv: "USER_HASH" }, { USER_HASH: "secret-hash" });
		check("enabled + api_id + api_hash is ready", ready.ok === true && ready.reason === undefined, ready);
		const reasons = [disabled.reason ?? "", noId.reason ?? "", noHash.reason ?? ""].join(" | ");
		check("reasons carry no secret values", !reasons.includes("secret-hash") && !reasons.includes(SESSION_VALUE), reasons);
	}

	section("UserSessionStore: 0600 file, 0700 directory, atomic replacement");
	{
		const file = path.join(stateDir, "telegram-user", "session");
		const dir = path.dirname(file);
		const store = new UserSessionStore(file);

		check("a missing session reads as undefined", (await store.read()) === undefined);
		check("a missing session describes as absent", (await store.describe()).present === false, await store.describe());

		await store.save(SESSION_VALUE);
		check("the session file exists", fs.existsSync(file));
		check("the session file is 0600", (fs.statSync(file).mode & 0o777) === 0o600, (fs.statSync(file).mode & 0o777).toString(8));
		check("the directory is 0700", (fs.statSync(dir).mode & 0o777) === 0o700, (fs.statSync(dir).mode & 0o777).toString(8));
		check("no temporary file is left behind", fs.readdirSync(dir).join(",") === "session", fs.readdirSync(dir));
		check("read returns exactly what was saved", (await store.read()) === SESSION_VALUE);

		const described = await store.describe();
		check("describe reports presence", described.present === true, described);
		check("describe reports the byte size", described.bytes === Buffer.byteLength(SESSION_VALUE), described);
		check("describe reports an mtime", typeof described.mtime === "string" && !Number.isNaN(Date.parse(described.mtime)), described);
		check("describe carries no session content", !JSON.stringify(described).includes(SESSION_VALUE), described);
		check("toString and JSON show only the path", !store.toString().includes(SESSION_VALUE) && !JSON.stringify(store).includes(SESSION_VALUE), { toString: store.toString(), json: JSON.stringify(store) });

		const emptyMessage = await (async (): Promise<string> => {
			try {
				await store.save("   ");
				return "";
			} catch (error) {
				return error instanceof Error ? error.message : String(error);
			}
		})();
		check("saving an empty session throws", emptyMessage.length > 0, emptyMessage || "accepted");
		check("a rejected empty save leaves the old session intact", (await store.read()) === SESSION_VALUE);

		const replacement = `${SESSION_VALUE}-v2`;
		await store.save(replacement);
		check("a second save overwrites the session", (await store.read()) === replacement);
		check("the replacement is still 0600", (fs.statSync(file).mode & 0o777) === 0o600, (fs.statSync(file).mode & 0o777).toString(8));
		check("a replacement leaves no temporary file", fs.readdirSync(dir).join(",") === "session", fs.readdirSync(dir));

		await store.save(`  ${SESSION_VALUE}  `);
		check("the stored value is trimmed", (await store.read()) === SESSION_VALUE);

		await store.remove();
		check("remove deletes the session", !fs.existsSync(file));
		check("a removed session reads as undefined", (await store.read()) === undefined);
		let secondRemoveFailed = false;
		try {
			await store.remove();
		} catch {
			secondRemoveFailed = true;
		}
		check("removing twice does not throw", !secondRemoveFailed);

		const tightFile = path.join(root, "precreated", "telegram-user", "session");
		const tightDir = path.dirname(tightFile);
		fs.mkdirSync(tightDir, { recursive: true, mode: 0o777 });
		fs.chmodSync(tightDir, 0o777);
		check("the pre-created directory starts wide open", (fs.statSync(tightDir).mode & 0o777) === 0o777, (fs.statSync(tightDir).mode & 0o777).toString(8));
		await new UserSessionStore(tightFile).save(SESSION_VALUE);
		check("save tightens an existing directory to 0700", (fs.statSync(tightDir).mode & 0o777) === 0o700, (fs.statSync(tightDir).mode & 0o777).toString(8));
		check("the session in a tightened directory is 0600", (fs.statSync(tightFile).mode & 0o777) === 0o600, (fs.statSync(tightFile).mode & 0o777).toString(8));

		const umaskFile = path.join(root, "umask-state", "telegram-user", "session");
		const umaskStore = new UserSessionStore(umaskFile);
		const previousUmask = process.umask(0o077);
		try {
			await umaskStore.save(SESSION_VALUE);
			check(
				"umask 0077 does not widen the session file",
				(fs.statSync(umaskFile).mode & 0o777) === 0o600,
				(fs.statSync(umaskFile).mode & 0o777).toString(8),
			);
		} finally {
			process.umask(previousUmask);
		}
		const previousOpenUmask = process.umask(0o000);
		try {
			await umaskStore.save(`${SESSION_VALUE}-open`);
			check(
				"umask 0000 does not open the session file",
				(fs.statSync(umaskFile).mode & 0o777) === 0o600,
				(fs.statSync(umaskFile).mode & 0o777).toString(8),
			);
		} finally {
			process.umask(previousOpenUmask);
		}
	}

	section("UserSessionStore: errors carry the path, never the content");
	{
		const file = path.join(root, "unwritable", "session");
		const store = new UserSessionStore(file);
		// A directory where the session file should be: every fs call fails, and the
		// error must mention the path without inventing or echoing any content.
		fs.mkdirSync(file, { recursive: true, mode: 0o700 });
		const readMessage = await (async (): Promise<string> => {
			try {
				await store.read();
				return "";
			} catch (error) {
				return error instanceof Error ? error.message : String(error);
			}
		})();
		check("a read failure names the path", readMessage.includes(file), readMessage || "no error");
		check("a read failure carries no session content", !readMessage.includes(SESSION_VALUE), readMessage);
	}
} finally {
	fs.rmSync(root, { recursive: true, force: true });
}

process.stdout.write(
	failures === 0 ? "\nALL TELEGRAM USER TESTS PASSED\n" : `\n${failures} TELEGRAM USER TEST(S) FAILED\n`,
);
process.exitCode = failures === 0 ? 0 : 1;
