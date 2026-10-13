import { spawn, type ChildProcess } from "node:child_process";
import { once } from "node:events";

export interface QuickTunnel { origin: string; stop(): Promise<void> }

/** A development-only HTTPS tunnel. Stable identity hosting uses a named tunnel/proxy. */
export async function startQuickTunnel(url: string, signal: AbortSignal, executable = "cloudflared", onExit: () => void = () => {}): Promise<QuickTunnel> {
	const child: ChildProcess = spawn(executable, ["tunnel", "--url", url, "--no-autoupdate", "--protocol", "http2"], { stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
	let stopped = false;
	const stop = async () => {
		if (stopped) return;
		stopped = true;
		if (child.exitCode !== null || child.signalCode !== null || !child.pid) return;
		const exited = once(child, "exit").catch(() => {});
		child.kill("SIGTERM");
		const timer = setTimeout(() => child.kill("SIGKILL"), 3000);
		try { await exited; } finally { clearTimeout(timer); signal.removeEventListener("abort", cancel); }
	};
	const cancel = () => { void stop(); };
	signal.addEventListener("abort", cancel, { once: true });
	try {
		const origin = await new Promise<string>((resolve, reject) => {
			let output = "";
			let address: string | undefined;
			let connected = false;
			const timer = setTimeout(() => fail(new Error("HTTPS tunnel did not become ready within 45 seconds. Check cloudflared/network access.")), 45_000);
			const cleanup = () => { clearTimeout(timer); child.stdout?.off("data", parse); child.stderr?.off("data", parse); signal.removeEventListener("abort", abort); };
			const fail = (error: Error) => { cleanup(); reject(error); };
			const abort = () => fail(new Error("HTTPS tunnel startup cancelled"));
			const parse = (chunk: Buffer) => {
				output = (output + chunk.toString("utf8")).slice(-16_384);
				const match = output.match(/https:\/\/[a-z0-9-]+\.trycloudflare\.com\b/);
				if (match) address = match[0];
				connected ||= output.includes("Registered tunnel connection");
				if (address && connected) { cleanup(); resolve(address); }
				else if (output.includes("Allow outbound TCP on port 7844")) fail(new Error("Cloudflare Tunnel cannot connect: outbound TCP port 7844 is blocked or unreachable. Check the network/VPN, or run Alive on a server with outbound access."));
			};
			child.stdout?.on("data", parse); child.stderr?.on("data", parse);
			child.once("error", () => fail(new Error("cloudflared could not start. Install it using Cloudflare's instructions, or pass --cloudflared /path/to/cloudflared.")));
			child.once("exit", () => { if (!stopped) onExit(); fail(new Error("HTTPS tunnel exited")); });
			signal.addEventListener("abort", abort, { once: true });
			if (signal.aborted) abort();
		});
		// Drain subsequent process output without persisting it or letting pipes fill.
		child.stdout?.resume(); child.stderr?.resume();
		return { origin, stop };
	} catch (error) { await stop(); throw error; }
}
