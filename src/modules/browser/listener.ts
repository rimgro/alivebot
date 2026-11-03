import * as fs from "node:fs";
import * as http from "node:http";
import { connect } from "node:net";

/** Operator-facing `host:port`; IPv6 literals keep their brackets. */
export function formatListenAddress(host: string, port: number): string {
	return `${host.includes(":") && !host.startsWith("[") ? `[${host}]` : host}:${port}`;
}

/**
 * Binds the browser listener and returns the real port. Requesting port 0 is
 * the default: the OS assigns an ephemeral port, so several agents can start on
 * one machine without one of them owning a fixed port first.
 *
 * A failed bind rejects with an operator-facing error that names the address,
 * the requested port, the OS error and, where it can be determined, the process
 * that already holds the port. Nothing is left listening, so the module cannot
 * report `listening: false` as if the start had succeeded.
 */
export async function listenOn(server: http.Server, host: string, port: number, onError?: (error: Error) => void): Promise<number> {
	const addressText = formatListenAddress(host, port);
	try {
		await new Promise<void>((resolve, reject) => {
			const fail = (error: Error) => { server.off("listening", ready); reject(error); };
			const ready = () => { server.off("error", fail); resolve(); };
			server.once("error", fail);
			server.once("listening", ready);
			server.listen(port, host);
		});
	} catch (caught) {
		const code = (caught as NodeJS.ErrnoException).code ?? "UNKNOWN";
		const reason = caught instanceof Error ? caught.message : String(caught);
		const findings: string[] = [];
		if (code === "EADDRINUSE") {
			const accepting = await probeListeners(host, port);
			const holders = findPortHolders(port);
			if (holders.length) findings.push(`likely holder: ${holders.join(", ")}`);
			if (accepting === true) findings.push("the port is already accepting TCP connections");
			else if (accepting === false) findings.push("the address is in use, but a TCP probe found no accepting socket (reserved or filtered)");
			else findings.push("a TCP probe of that address did not answer in time");
		} else if (code === "EACCES") findings.push("this process is not allowed to bind that address or port");
		else if (code === "EADDRNOTAVAIL") findings.push("the configured host is not an address of this machine");
		const detail = findings.length ? ` ${findings.join("; ")}.` : "";
		const remedy = port === 0
			? " Check the configured host and listener permissions."
			: ` Close the other listener, pin another free port in modules.browser.port, or set it to 0 (the default) so the OS assigns an ephemeral port.`;
		throw new Error(`Browser listener failed for ${addressText}: ${code} (${reason}).${detail}${remedy}`);
	}
	const address = server.address();
	if (!server.listening || !address || typeof address === "string") {
		try { server.close(); } catch { /* already closed */ }
		throw new Error(`Browser listener for ${addressText} did not become listening after listen() resolved (${server.listening ? "no TCP address was assigned" : "the socket is not listening"}). Pin a free port in modules.browser.port, or set it to 0 (the default) so the OS assigns an ephemeral port.`);
	}
	// Keep runtime accept errors visible without an unhandled "error" event.
	if (onError) server.on("error", (error: Error) => onError(error));
	return address.port;
}

/** True/false when the probe gets a definite answer, undefined on timeout. */
async function acceptsConnections(host: string, port: number, timeoutMs = 750): Promise<boolean | undefined> {	return await new Promise((resolve) => {
		const socket = connect({ host, port });
		let settled = false;
		const finish = (value: boolean | undefined) => { if (settled) return; settled = true; socket.destroy(); resolve(value); };
		socket.setTimeout(timeoutMs, () => finish(undefined));
		socket.once("connect", () => finish(true));
		socket.once("error", () => finish(false));
	});
}

/** `localhost` may resolve to either loopback family, so probe both. */
async function probeListeners(host: string, port: number): Promise<boolean | undefined> {
	const candidates = host === "localhost" ? ["127.0.0.1", "::1"] : [host];
	let uncertain = false;
	for (const candidate of candidates) {
		const accepting = await acceptsConnections(candidate, port);
		if (accepting === true) return true;
		if (accepting === undefined) uncertain = true;
	}
	return uncertain ? undefined : false;
}

/**
 * Best-effort Linux lookup of the process holding a listening port. It only
 * reads `/proc` and is bounded; another user's descriptors, a container
 * namespace or a missing `/proc` simply produce no name.
 */
export function findPortHolders(port: number): string[] {
	if (process.platform !== "linux") return [];
	try {
		const inodes = listeningInodes(port);
		if (!inodes.size) return [];
		const holders = new Set<string>();
		const pids = fs.readdirSync("/proc").filter(name => /^\d+$/.test(name));
		// Own descriptors are always readable and cover a self-inflicted collision.
		pids.sort((a, b) => Number(b === String(process.pid)) - Number(a === String(process.pid)));
		let inspected = 0;
		for (const pid of pids) {
			if (holders.size >= 3 || inspected > 4_096) break;
			let descriptors: string[];
			try { descriptors = fs.readdirSync(`/proc/${pid}/fd`); } catch { continue; }
			for (const descriptor of descriptors) {
				if (++inspected > 4_096) break;
				let target: string;
				try { target = fs.readlinkSync(`/proc/${pid}/fd/${descriptor}`); } catch { continue; }
				const match = /^socket:\[(\d+)\]$/.exec(target);
				if (!match || !inodes.has(match[1])) continue;
				let command = "unknown";
				try { command = fs.readFileSync(`/proc/${pid}/comm`, "utf8").trim() || command; } catch { /* unreadable */ }
				holders.add(`pid ${pid} (${command})`);
				break;
			}
		}
		return [...holders];
	} catch {
		return [];
	}
}

/** Inodes of listening TCP sockets on `port`; state 0A is LISTEN. */
function listeningInodes(port: number): Set<string> {
	const hex = port.toString(16).toUpperCase().padStart(4, "0");
	const inodes = new Set<string>();
	for (const file of ["/proc/net/tcp", "/proc/net/tcp6"]) {
		let text: string;
		try { text = fs.readFileSync(file, "utf8"); } catch { continue; }
		for (const line of text.split("\n").slice(1)) {
			const fields = line.trim().split(/\s+/);
			if (fields.length < 10 || fields[3] !== "0A") continue;
			if (!fields[1].endsWith(`:${hex}`)) continue;
			inodes.add(fields[9]);
		}
	}
	return inodes;
}
