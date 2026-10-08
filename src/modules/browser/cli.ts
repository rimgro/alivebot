import { generateKeyPairSync } from "node:crypto";
import * as fs from "node:fs";
import * as http from "node:http";
import * as path from "node:path";
import { chromium } from "playwright";
import type { LoadedConfig } from "../../config.js";
import { ModuleHost } from "../../events/host.js";
import { Logger } from "../../log.js";
import { snapshotRuntime } from "../../runtime/daemon.js";
import { EventStore } from "../../store/events.js";
import { HistoryStore } from "../../store/history.js";
import { writeRuntimeState } from "../../store/runs.js";
import { sleep } from "../../util.js";
import { TelegramModule, resolveToken } from "../telegram/module.js";
import { TelegramApi } from "../telegram/client.js";
import { DEFAULT_BROWSER_CONFIG } from "./config.js";
import { BrowserIdentity } from "./identity.js";
import { BrowserModule } from "./module.js";
import { cancelBrowserPairing, readBrowserOperator, requestBrowserPairing, writePrivateJson } from "./operator.js";
import { startQuickTunnel, type QuickTunnel } from "./tunnel.js";

type Flags = Record<string, string | boolean>;
const stringFlag = (flags: Flags, name: string) => typeof flags[name] === "string" ? flags[name] as string : undefined;
const boolFlag = (flags: Flags, name: string) => flags[name] === true || flags[name] === "true";

function httpsOrigin(value: string): string {
	const url = new URL(value);
	if (url.protocol !== "https:" || url.username || url.password || url.pathname !== "/" || url.search || url.hash) throw new Error("Use an exact HTTPS origin, such as https://browser.example.com");
	return url.origin;
}

/** Writes only machine-local overrides, preserving existing permissions and secrets. */
export function setupBrowser(loaded: LoadedConfig, flags: Flags): string {
	const file = path.join(path.dirname(loaded.paths.configPath), "alive.config.local.json");
	const local = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, "utf8")) : {};
	const browser = { ...DEFAULT_BROWSER_CONFIG, ...loaded.config.modules.browser, enabled: true };
	const driver = stringFlag(flags, "driver");
	if (driver) {
		if (driver !== "patchright" && driver !== "playwright") throw new Error("Use --driver patchright or playwright");
		browser.driver = driver;
	}
	const channel = stringFlag(flags, "channel");
	if (channel) {
		if (channel !== "chrome" && channel !== "chromium") throw new Error("Use --channel chrome or chromium");
		browser.channel = channel;
	}
	if (flags.humanization !== undefined) browser.humanization = { ...DEFAULT_BROWSER_CONFIG.humanization, ...browser.humanization, enabled: boolFlag(flags, "humanization") };
	const publicUrl = stringFlag(flags, "public-url");
	if (publicUrl) browser.publicUrl = httpsOrigin(publicUrl);
	const identityUrl = stringFlag(flags, "identity-url");
	if (identityUrl) browser.signing = { ...browser.signing, agentUrl: httpsOrigin(identityUrl) };
	if (flags.headless !== undefined) browser.headless = boolFlag(flags, "headless");
	const origins = stringFlag(flags, "sign-origins");
	if (origins) {
		const agentUrl = browser.signing.agentUrl || browser.publicUrl;
		if (!agentUrl) throw new Error("Signing setup requires --identity-url or --public-url with the deployed identity origin");
		const permitted = origins.split(",").map(httpsOrigin);
		let keyFile = process.env[browser.signing.keyFileEnv];
		if (!keyFile) {
			keyFile = path.join(loaded.paths.modulesDir, "browser", "identity.pem");
			fs.mkdirSync(path.dirname(keyFile), { recursive: true, mode: 0o700 });
			if (!fs.existsSync(keyFile)) fs.writeFileSync(keyFile, generateKeyPairSync("ed25519").privateKey.export({ type: "pkcs8", format: "pem" }), { flag: "wx", mode: 0o600 });
			const envFile = path.join(path.dirname(loaded.paths.configPath), ".env");
			const existing = fs.existsSync(envFile) ? fs.readFileSync(envFile, "utf8") : "";
			if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(browser.signing.keyFileEnv)) throw new Error("Invalid signing key environment variable name");
			if (existing.split(/\r?\n/).some(line => line.trim().startsWith(`${browser.signing.keyFileEnv}=`))) throw new Error("Load the existing .env signing key before setup; it will not be overwritten");
			fs.writeFileSync(envFile, `${existing}${existing.endsWith("\n") || !existing ? "" : "\n"}${browser.signing.keyFileEnv}=${JSON.stringify(keyFile)}\n`, { mode: 0o600 });
			fs.chmodSync(envFile, 0o600);
			process.env[browser.signing.keyFileEnv] = keyFile;
		}
		browser.signing = { ...browser.signing, enabled: true, agentUrl, origins: permitted };
		new BrowserIdentity(browser.signing);
	}
	if (identityUrl && !browser.signing.enabled) throw new Error("Use --sign-origins when configuring a new signed identity");
	local.modules = { ...local.modules, browser: { ...local.modules?.browser, ...browser } };
	local.tools = { ...local.tools, allowlist: [...new Set([...loaded.config.tools.allowlist, "browser"])] };
	writePrivateJson(file, local);
	return file;
}

export async function browserCommand(loaded: LoadedConfig, action: string, flags: Flags): Promise<number> {
	switch (action) {
		case "setup":
			process.stdout.write(`Browser enabled in ${setupBrowser(loaded, flags)}\nNext: alive browser doctor\n`);
			return 0;
		case "doctor": return await doctor(loaded, boolFlag(flags, "online"));
		case "pair": return await pair(loaded);
		case "serve": return await serve(loaded, flags);
		default: throw new Error("usage: alive browser setup [--driver patchright|playwright] [--channel chrome|chromium] [--humanization true|false] [--public-url HTTPS_ORIGIN] [--identity-url HTTPS_ORIGIN] [--headless] [--sign-origins HTTPS_ORIGIN,...] | doctor [--online] | pair | serve [--url HTTP_URL] [--local] [--tunnel] [--cloudflared PATH]");
	}
}

async function doctor(loaded: LoadedConfig, online: boolean): Promise<number> {
	const browser = { ...DEFAULT_BROWSER_CONFIG, ...loaded.config.modules.browser };
	const telegram = loaded.config.modules.telegram;
	const token = resolveToken(telegram);
	const operator = readBrowserOperator(loaded.paths.modulesDir);
	const snapshot = snapshotRuntime(loaded.paths.stateDir);
	const engine = browser.driver === "patchright" ? (await import("patchright")).chromium : chromium;
	const candidates = browser.channel === "chromium" ? [engine.executablePath()] : process.platform === "darwin"
		? ["/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"]
		: process.platform === "win32" ? [path.join(process.env.PROGRAMFILES ?? "", "Google/Chrome/Application/chrome.exe"), path.join(process.env.LOCALAPPDATA ?? "", "Google/Chrome/Application/chrome.exe")]
		: ["/opt/google/chrome/chrome", "/usr/bin/google-chrome", "/usr/bin/google-chrome-stable"];
	const installed = candidates.some(file => fs.existsSync(file));
	if (!installed) process.stdout.write(`Install browser: npx ${browser.driver === "patchright" ? "patchright" : "playwright"} install ${browser.channel}\n`);
	const chat = browser.notifyChatId || operator?.chatId;
	const destinationAllowed = !!chat && (!telegram.allowedChatIds.length || telegram.allowedChatIds.map(String).includes(chat));
	process.stdout.write(`Host: ${process.platform}/${process.arch}; configuration: ${loaded.paths.configPath}\nRuntime: ${snapshot?.alive ? `running (pid ${snapshot.pid})` : "not running here"}\nBrowser: ${browser.enabled ? "enabled" : "disabled"}; ${browser.driver}/${browser.channel} ${installed ? "installed" : "not found"}; humanization ${browser.humanization.enabled ? "enabled" : "disabled"}\nPhone HTTPS address: ${browser.publicUrl || "not configured"}\nTelegram token: ${token ? "configured" : "missing"}\nOperator: ${chat ? `${chat}${destinationAllowed ? "" : " (denied by chat allowlist)"}` : "not paired"}\n`);
	if (browser.signing.enabled) {
		const identity = new BrowserIdentity(browser.signing);
		process.stdout.write(`Web Bot Auth: ${identity.agentUrl}; public key ID ${identity.keyId}\nRegistration: requires operator approval from Cloudflare; a local signature is not registration.\n`);
	} else process.stdout.write("Web Bot Auth: disabled\n");
	if (!token) process.stdout.write(`Next: obtain the project's bot token or create a bot in @BotFather; put ${telegram.tokenEnv || "ALIVE_TELEGRAM_TOKEN"}=... in the gitignored .env file. Do not share the token in chat.\n`);
	else if (!chat) process.stdout.write("Next: alive browser pair (the bot determines your private chat ID).\n");
	if (!browser.publicUrl) process.stdout.write("Phone test: install cloudflared, then alive browser serve --tunnel (a temporary HTTPS address is detected automatically). Production: configure a stable HTTPS proxy/tunnel and run alive browser setup --public-url https://YOUR_ADDRESS\n");
	if (online && token) {
		const bot = await new TelegramApi({ token, apiBase: telegram.apiBase }).getMe();
		process.stdout.write(`Telegram reachable: @${bot.username ?? bot.id}\n`);
	}
	if (online && browser.publicUrl) {
		const response = await fetch(`${browser.publicUrl}/browser`, { redirect: "error", signal: AbortSignal.timeout(10_000) });
		if (!response.ok) throw new Error(`Public browser endpoint returned HTTP ${response.status}`);
		process.stdout.write("Public phone HTTPS endpoint reachable\n");
	}
	if (online && browser.signing.enabled) {
		const identity = new BrowserIdentity(browser.signing);
		const response = await fetch(`${identity.agentUrl}/.well-known/http-message-signatures-directory`, { redirect: "error", signal: AbortSignal.timeout(10_000) });
		if (!response.ok) throw new Error(`Identity directory returned HTTP ${response.status}`);
		const directory = await response.json() as { keys?: Array<{ x?: string }> };
		const expected = JSON.parse(identity.directory().body) as { keys: Array<{ x: string }> };
		if (directory.keys?.[0]?.x !== expected.keys[0].x || !response.headers.get("signature")) throw new Error("Public directory does not match the configured identity");
		process.stdout.write("Public identity HTTPS directory reachable\n");
	}
	return browser.enabled && installed && token && destinationAllowed && browser.publicUrl ? 0 : 1;
}

function runtimeAvailable(loaded: LoadedConfig): void {
	const active = snapshotRuntime(loaded.paths.stateDir);
	if (active?.alive && !active.cleanStop) throw new Error(`Another Alive process owns this state directory (pid ${active.pid}). Stop it before standalone browser serve.`);
}

function hostFor(loaded: LoadedConfig, modules: Array<BrowserModule | TelegramModule>): ModuleHost {
	const events = EventStore.open(loaded.paths.stateDir);
	return new ModuleHost({ config: loaded, log: new Logger({ console: true, level: "info", file: loaded.paths.logFile }), transports: [], modules, ingest: e => events.append(e), outbox: () => [], history: HistoryStore.open(loaded.paths.stateDir), runtimeStatus: () => ({ standaloneBrowser: true }) });
}

async function withStandalone(loaded: LoadedConfig, host: ModuleHost, task: (signal: AbortSignal) => Promise<number>): Promise<number> {
	runtimeAvailable(loaded);
	const abort = new AbortController();
	const cancel = () => abort.abort();
	for (const name of ["SIGINT", "SIGTERM", "SIGHUP"] as const) process.on(name, cancel);
	const startedAt = Date.now();
	const write = (status: "idle" | "stopped") => writeRuntimeState(loaded.paths.stateDir, { pid: process.pid, startedAt, lastTickAt: Date.now(), status, runIndex: 0, pending: 0, openThreads: 0, sleeps: 0, mode: "foreground" });
	write("idle");
	const heartbeat = setInterval(() => write("idle"), 1000);
	try { await host.init(); return await task(abort.signal); }
	finally {
		clearInterval(heartbeat);
		await host.stop();
		write("stopped");
		for (const name of ["SIGINT", "SIGTERM", "SIGHUP"] as const) process.off(name, cancel);
	}
}

async function pair(loaded: LoadedConfig): Promise<number> {
	const telegram = loaded.config.modules.telegram;
	const token = resolveToken(telegram);
	if (!telegram.enabled || !token) throw new Error(`Configure the enabled Telegram module and ${telegram.tokenEnv || "ALIVE_TELEGRAM_TOKEN"} in .env first. Your private chat ID will be detected automatically.`);
	const bot = await new TelegramApi({ token, apiBase: telegram.apiBase }).getMe();
	const request = requestBrowserPairing(loaded.paths.modulesDir);
	process.stdout.write(`Send this command to @${bot.username ?? bot.id} in a PRIVATE chat within 10 minutes:\n/browser_pair ${request.code}\nKeep this one-time pairing command private. Waiting for your message...\n`);
	const wait = async (signal: AbortSignal) => {
		while (!signal.aborted && Date.now() < request.expiresAt) {
			const operator = readBrowserOperator(loaded.paths.modulesDir);
			const pending = path.join(loaded.paths.modulesDir, "browser", "pairing.json");
			if (operator && !fs.existsSync(pending)) { process.stdout.write(`Paired private chat: ${operator.chatId}\n`); return 0; }
			await sleep(250, signal);
		}
		return 1;
	};
	try {
		const active = snapshotRuntime(loaded.paths.stateDir);
		if (active?.alive && !active.cleanStop) {
			if (active.suspended) throw new Error("The running Alive process is suspended; resume it before pairing");
			const abort = new AbortController();
			const cancel = () => abort.abort();
			process.on("SIGINT", cancel); process.on("SIGTERM", cancel);
			try { return await wait(abort.signal); }
			finally { process.off("SIGINT", cancel); process.off("SIGTERM", cancel); }
		}
		return await withStandalone(loaded, hostFor(loaded, [new TelegramModule(telegram)]), wait);
	} finally { cancelBrowserPairing(loaded.paths.modulesDir, request.code); }
}

async function serve(loaded: LoadedConfig, flags: Flags): Promise<number> {
	runtimeAvailable(loaded);
	if (boolFlag(flags, "local")) {
		loaded = { ...loaded, config: { ...loaded.config, modules: { ...loaded.config.modules, telegram: { ...loaded.config.modules.telegram, enabled: false }, browser: { ...DEFAULT_BROWSER_CONFIG, ...loaded.config.modules.browser, publicUrl: "", notifyChatId: "", signing: { ...DEFAULT_BROWSER_CONFIG.signing } } } } };
	}
	const browser = new BrowserModule({ ...DEFAULT_BROWSER_CONFIG, ...loaded.config.modules.browser, ...(flags.headless !== undefined ? { headless: boolFlag(flags, "headless") } : {}) });
	const browserConfig = { ...DEFAULT_BROWSER_CONFIG, ...loaded.config.modules.browser };
	if (boolFlag(flags, "tunnel") && ((browserConfig.signing.enabled && browserConfig.signing.agentUrl === browserConfig.publicUrl) || !["127.0.0.1", "localhost", "::1"].includes(browserConfig.host) || browserConfig.port === 0)) throw new Error("Quick tunnels require a fixed loopback port. Web Bot Auth needs a separately hosted stable HTTPS identity origin.");
	const telegram = loaded.config.modules.telegram;
	const host = hostFor(loaded, [browser, ...(telegram.enabled && resolveToken(telegram) ? [new TelegramModule(telegram)] : [])]);
	let fixture: http.Server | undefined;
	let tunnel: QuickTunnel | undefined;
	let url = stringFlag(flags, "url");
	if (!url) {
		fixture = http.createServer((_req, res) => {
			res.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" });
			res.end('<!doctype html><html lang="ru"><meta charset="utf-8"><title>Alive: проверка ручного управления</title><style>body{padding:36px;font:20px system-ui;background:#fafaf6;color:#183623}input,button{font:inherit;padding:12px;margin:12px 0}label{display:block}</style><h1>Проверка связи с браузером</h1><p>Введите текст и нажмите кнопку. Это локальная демонстрация.</p><label>Текст <input id="text"></label><button onclick="document.querySelector(\'output\').textContent=document.querySelector(\'input\').value">Подтвердить</button><p><output></output></p></html>');
		});
		await new Promise<void>(resolve => fixture!.listen(0, "127.0.0.1", resolve));
		url = `http://127.0.0.1:${(fixture.address() as { port: number }).port}/`;
	}
	try {
		return await withStandalone(loaded, host, async signal => {
			if (boolFlag(flags, "tunnel")) {
				const targetHost = browserConfig.host.includes(":") ? `[${browserConfig.host}]` : browserConfig.host;
				tunnel = await startQuickTunnel(`http://${targetHost}:${browserConfig.port}`, signal, stringFlag(flags, "cloudflared"), () => process.kill(process.pid, "SIGTERM"));
				browser.setPublicOrigin(tunnel.origin);
				process.stdout.write(`Temporary HTTPS address: ${tunnel.origin} (testing only; expires when this process stops)\n`);
			}
			await browser.command({ action: "navigate", url });
			const handoff = await browser.command({ action: "handoff", reason: "Проверка ручного управления браузером" });
			if (handoff.details.operatorUrl) process.stdout.write(`Open the single-use operator link:\n${handoff.details.operatorUrl}\n`);
			else process.stdout.write(`Operator notification: ${handoff.details.notificationFailed ? "FAILED (run alive browser doctor)" : "sent"}\n`);
			process.stdout.write("Browser serve is running without an LLM. Press Ctrl+C to close it.\n");
			while (!signal.aborted) await sleep(1000, signal);
			return 0;
		});
	} finally { await tunnel?.stop(); fixture?.closeAllConnections(); await new Promise<void>(resolve => fixture ? fixture.close(() => resolve()) : resolve()); }
}
