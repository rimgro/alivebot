import { execFile } from "node:child_process";
import { createRequire } from "node:module";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { BrowserContext, Page } from "playwright";
import { AgentCdpBridge } from "./agent-cdp.js";

/** Native agent-browser performs agent navigation, snapshots and interaction.
 * SDK objects are retained only for isolation, persistence and the human pult.
 * No arbitrary argv/connection/profile overrides are accepted from the model.
 */
export class ConversationAgentBrowser {
	private readonly bridge: AgentCdpBridge;
	private readonly directory = fs.mkdtempSync(path.join(os.tmpdir(), "alive-ab-"));
	private endpoint = "";
	private started = false;
	private closed = false;
	private closing?: Promise<void>;
	private readonly cli: string;
	constructor(context: BrowserContext, select: (page: Page) => void, private readonly timeoutMs: number) {
		this.bridge = new AgentCdpBridge(context, select);
		const require = createRequire(import.meta.url);
		this.cli = path.join(path.dirname(require.resolve("agent-browser/package.json")), "bin", "agent-browser.js");
	}
	async run(args: string[], signal?: AbortSignal, timeoutMs = this.timeoutMs): Promise<Record<string, unknown>> {
		if (this.closed) throw new Error("Conversation agent-browser is closed");
		signal?.throwIfAborted();
		if (!this.endpoint) this.endpoint = await this.bridge.start();
		this.started = true;
		try { return await this.execute(args, signal, timeoutMs); }
		catch (error) { if (signal?.aborted) await this.close(); throw error; }
	}
	private async execute(args: string[], signal?: AbortSignal, timeoutMs = this.timeoutMs): Promise<Record<string, unknown>> {
		const output = await new Promise<string>((resolve, reject) => {
			execFile(process.execPath, [this.cli, "--session", "conversation", "--cdp", this.endpoint, "--json", ...args], {
				cwd: this.directory, timeout: timeoutMs + 5000, maxBuffer: 4 * 1024 * 1024, signal,
				// No user/project agent-browser config, saved profiles, providers or
				// inherited browser credentials may change this connection policy.
				env: { PATH: process.env.PATH, SystemRoot: process.env.SystemRoot, HOME: this.directory, USERPROFILE: this.directory,
					AGENT_BROWSER_SOCKET_DIR: this.directory, AGENT_BROWSER_DEFAULT_TIMEOUT: String(timeoutMs), AGENT_BROWSER_IDLE_TIMEOUT_MS: "60000" },
			}, (error, stdout) => {
				if (signal?.aborted) { reject(signal.reason); return; }
				if (error && !stdout) { reject(new Error("Conversation agent-browser failed; no dedicated browser was started")); return; }
				resolve(stdout);
			});
		});
		let response: { success?: boolean; data?: Record<string, unknown>; error?: string };
		try { response = JSON.parse(output); } catch { throw new Error("Invalid agent-browser response"); }
		if (!response.success) throw new Error(String(response.error || "agent-browser command failed").replaceAll(this.endpoint, "[conversation browser]"));
		return response.data || {};
	}
	async screenshot(signal?: AbortSignal): Promise<Buffer> {
		const file = path.join(this.directory, "frame.png");
		try { await this.run(["screenshot", file], signal); return fs.readFileSync(file); }
		finally { fs.rmSync(file, { force: true }); }
	}
	get isClosed(): boolean { return this.closed; }
	close(): Promise<void> { return this.closing ??= this.dispose(); }
	private async dispose(): Promise<void> {
		this.closed = true;
		// Revoke the daemon's page connection first, including on cancellation.
		// Killing only the short-lived CLI would leave its daemon executing input.
		try { await this.bridge.close(); if (this.started) await this.execute(["close"], undefined, 2000).catch(() => {}); }
		finally { fs.rmSync(this.directory, { recursive: true, force: true }); }
	}
}
