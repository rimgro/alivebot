import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import * as http from "node:http";
import type { Page } from "playwright";
import { WebSocket } from "ws";
import { BrowserLive } from "../modules/browser/live.js";
import { sleep } from "../util.js";

class FakeCDP extends EventEmitter {
	commands: string[] = [];
	async send(command: string) { this.commands.push(command); }
	async detach() { this.commands.push("detach"); }
	frame(value: number) { this.emit("Page.screencastFrame", { data: Buffer.from([0xff, 0xd8, value, 0xff, 0xd9]).toString("base64"), sessionId: value, metadata: { deviceWidth: 1760, deviceHeight: 1120 } }); }
}

const cdp = new FakeCDP();
let credential = "c".repeat(43), expiresAt = Date.now() + 60_000, fallback = false, releaseCount = 0;
let finishSnapshot: ((data: Buffer) => void) | undefined;
const inputs: unknown[] = [];
const page = {
	bringToFront: async () => {},
	isClosed: () => false, viewportSize: () => ({ width: 1760, height: 1120 }),
	context: () => ({ newCDPSession: async () => { if (fallback) throw Error("Unsupported screencast"); return cdp; } }),
	screenshot: () => new Promise<Buffer>(resolve => { finishSnapshot = resolve; }),
} as unknown as Page;
const server = http.createServer((_req, res) => { res.writeHead(404); res.end(); });
let origin = "";
const live = new BrowserLive(server, {
	origin: () => origin, page: () => page, busy: () => false,
	authorize: value => { if (value !== credential) throw { status: 401, message: "Invalid access key" }; if (Date.now() >= expiresAt) throw { status: 410, message: "Link expired. Request a new handoff." }; return { expiresAt }; },
	input: async body => { inputs.push(body); }, release: async () => { releaseCount++; }, resume: async () => { credential = "returned"; },
});
const sockets: WebSocket[] = [];
function open(requestOrigin = origin, suffix = "") {
	const socket = new WebSocket(origin.replace("http", "ws") + "/browser/live" + suffix, { origin: requestOrigin });
	sockets.push(socket); const messages: Array<{ binary: boolean; data: Buffer }> = [];
	socket.on("error", () => {});
	socket.on("message", (data, binary) => messages.push({ binary, data: data as Buffer }));
	return { socket, messages };
}
async function until(test: () => boolean, label: string) {
	const deadline = Date.now() + 3000;
	while (!test() && Date.now() < deadline) await sleep(10);
	assert.ok(test(), label);
}
function packet(socket: WebSocket, body: unknown) { socket.send(JSON.stringify(body)); }
function has(messages: Array<{ binary: boolean; data: Buffer }>, type: string) { return messages.some(m => !m.binary && JSON.parse(m.data.toString()).type === type); }
try {
	await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
	const address = server.address() as { port: number }; origin = `http://127.0.0.1:${address.port}`;
	const foreign = open("https://foreign.test");
	await until(() => foreign.socket.readyState === WebSocket.CLOSED, "Foreign origins must be rejected");
	assert.equal(foreign.messages.length, 0);
	const query = open(origin, "?credential=must-not-be-accepted");
	await until(() => query.socket.readyState === WebSocket.CLOSED, "Credentials in query parameters must not be accepted");
	const { socket, messages } = open();
	await until(() => socket.readyState === WebSocket.OPEN, "Socket opened");
	await sleep(100); assert.equal(messages.length, 0, "An unauthenticated socket receives no page data");
	packet(socket, { type: "auth", credential });
	await until(() => cdp.commands.includes("Page.startScreencast"), "Native screencast started");
	cdp.frame(1);
	await until(() => messages.some(m => m.binary), "Binary frame received");
	const first = messages.find(m => m.binary)!.data;
	assert.equal(first.readUInt32BE(0), 0x414c4956);
	assert.equal(first.readUInt32BE(8), 1760); assert.equal(first.readUInt32BE(12), 1120);
	assert.equal(first[18], 1);
	cdp.frame(2); cdp.frame(3); await sleep(130);
	assert.equal(messages.filter(m => m.binary).length, 1, "A slow viewer can have only one frame in flight");
	const began = Date.now();
	packet(socket, { type: "input", id: 1, body: { type: "down", x: 10, y: 20 } });
	packet(socket, { type: "input", id: 2, body: { type: "up", x: 10, y: 20 } });
	await until(() => messages.filter(m => !m.binary && JSON.parse(m.data.toString()).type === "ack").length === 2, "Input acknowledged while frame ACK is withheld");
	assert.deepEqual(inputs.map(x => (x as { type: string }).type), ["down", "up"]);
	assert.ok(Date.now() - began < 500, "A stalled screen must not stall input");
	packet(socket, { type: "frame_ack", id: first.readUInt32BE(4) });
	await until(() => messages.filter(m => m.binary).length === 2, "Next frame received");
	assert.equal(messages.filter(m => m.binary)[1].data[18], 3, "Only the latest frame survives backpressure");
	const duplicate = open(); await until(() => duplicate.socket.readyState === WebSocket.OPEN, "Second socket opened");
	packet(duplicate.socket, { type: "auth", credential });
	await until(() => duplicate.socket.readyState === WebSocket.CLOSED, "Duplicate viewer rejected");
	credential = "n".repeat(43);
	await until(() => socket.readyState === WebSocket.CLOSED, "Revoked credentials immediately stop streaming");
	assert.ok(cdp.commands.includes("Page.stopScreencast"));

	fallback = true;
	const compatible = open(); await until(() => compatible.socket.readyState === WebSocket.OPEN, "Fallback socket opened");
	packet(compatible.socket, { type: "auth", credential });
	await until(() => !!finishSnapshot, "Fallback screenshot is in flight");
	packet(compatible.socket, { type: "input", id: 3, body: { type: "text", text: "fixture" } });
	await until(() => has(compatible.messages, "ack"), "Fallback input must be acknowledged before slow capture finishes");
	assert.equal(compatible.messages.some(m => m.binary), false);
	finishSnapshot!(Buffer.from([0xff, 0xd8, 0xff, 0xd9]));
	await until(() => compatible.messages.some(m => m.binary), "Fallback binary frame arrived");
	expiresAt = Date.now() - 1;
	await until(() => compatible.socket.readyState === WebSocket.CLOSED, "Expired credentials close the viewer");
	assert.ok(releaseCount >= 2, "Disconnects release the native pointer");
	expiresAt = Date.now() + 60_000; fallback = false;
	const returned = open(); await until(() => returned.socket.readyState === WebSocket.OPEN, "Return socket opened");
	packet(returned.socket, { type: "auth", credential });
	await until(() => has(returned.messages, "authenticated"), "Return socket authenticated");
	packet(returned.socket, { type: "resume", id: 4 });
	await until(() => returned.socket.readyState === WebSocket.CLOSED, "Explicit return closes the socket");
	assert.ok(returned.messages.some(m => !m.binary && JSON.parse(m.data.toString()).id === 4 && JSON.parse(m.data.toString()).ok === true), "Return must be acknowledged before closing");
	assert.equal(has(returned.messages, "error"), false, "Successful return must not look like lost authorization");
	assert.equal(credential, "returned");
	console.log("browser-live: binary frames, latest-frame backpressure, independent input, origin/auth/revocation and slow-capture fallback passed");
} finally {
	live.close(); for (const socket of sockets) socket.terminate();
	finishSnapshot?.(Buffer.from([0xff, 0xd8, 0xff, 0xd9]));
	await new Promise<void>(resolve => server.close(() => resolve()));
}
