import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import * as http from "node:http";
import type { Page } from "playwright";
import { WebSocket } from "ws";
import { BrowserLive } from "../modules/browser/live.js";
import { StreamPolicy } from "../modules/browser/stream-policy.js";
import { sleep } from "../util.js";

class FakeCDP extends EventEmitter {
	commands: string[] = [];
	calls: Array<{ command: string; params?: Record<string, unknown> }> = [];
	async send(command: string, params?: Record<string, unknown>) {
		this.commands.push(command); this.calls.push({ command, params });
		if (command === "Page.captureScreenshot") {
			snapshotQualities.push(Number(params?.quality));
			return await new Promise<{ data: string }>(resolve => { finishSnapshot = data => resolve({ data: data.toString("base64") }); });
		}
	}
	async detach() { this.commands.push("detach"); }
	frame(value: number) { this.emit("Page.screencastFrame", { data: Buffer.from([0xff, 0xd8, value, 0xff, 0xd9]).toString("base64"), sessionId: value, metadata: { deviceWidth: 1760, deviceHeight: 1120 } }); }
}

// A fast receiver is still byte-limited; a stalled receiver lowers capture cost and recovers without reconnecting.
const budget = new StreamPolicy(0);
let transmitted = 0;
for (let now = 0; now <= 10_000; now += 5) if (budget.canSend(40_000, now)) { budget.spend(40_000, now); transmitted += 40_000; }
assert.ok(transmitted <= 160_000 * 10 + 80_000, "A fast receiver cannot exceed the sustained JPEG byte budget plus one bounded burst");
assert.ok(transmitted >= 160_000 * 9, "The limiter must use available bandwidth instead of freezing the viewer");
budget.observe(1500, 0, 10_001);
assert.equal(budget.profile.name, "economy");
for (let n = 0; n < 10; n++) budget.ack(80, 10_010 + n * 100);
assert.equal(budget.profile.name, "economy", "A few quick ACKs must not oscillate the capture profile");
for (let n = 0; n < 8; n++) budget.ack(80, 16_000 + n * 100);
assert.equal(budget.profile.name, "balanced", "Sustained healthy delivery restores quality without renewing the handoff");
budget.observe(0, 150 * 1024, 18_000);
assert.equal(budget.profile.name, "economy", "Transport congestion must also lower capture cost before the viewer times out");
const largeImages = new StreamPolicy(0);
for (let now = 0; now <= 200; now += 100) largeImages.frame(40_000, now);
assert.ok(largeImages.profile.quality < 42 && largeImages.profile.maxWidth < 900, "Large moving frames must compress before the byte budget reduces responsiveness");
const sparseImages = new StreamPolicy(0);
for (let now = 0; now <= 5000; now += 1000) sparseImages.frame(40_000, now);
assert.equal(sparseImages.profile.name, "balanced", "Occasional large stills must not lower the moving-image resolution");

const cdp = new FakeCDP();
let credential = "c".repeat(43), expiresAt = Date.now() + 60_000, fallback = false, releaseCount = 0;
let finishSnapshot: ((data: Buffer) => void) | undefined;
const snapshotQualities: number[] = [];
const inputs: unknown[] = [];
const page = {
	bringToFront: async () => {},
	isClosed: () => false, viewportSize: () => ({ width: 1760, height: 1120 }),
	context: () => ({ newCDPSession: async () => { if (fallback) throw Error("Unsupported screencast"); return cdp; } }),
	screenshot: (options: { quality: number }) => new Promise<Buffer>(resolve => { snapshotQualities.push(options.quality); finishSnapshot = resolve; }),
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
	assert.ok(Number(cdp.calls.find(call => call.command === "Page.startScreencast")!.params!.quality) < 60, "Moving frames must use less expensive native JPEG encoding");
	cdp.frame(1);
	await until(() => messages.some(m => m.binary), "Binary frame received");
	const first = messages.find(m => m.binary)!.data;
	assert.equal(first.readUInt32BE(0), 0x414c4956);
	assert.equal(first.readUInt32BE(8), 1760); assert.equal(first.readUInt32BE(12), 1120);
	assert.equal(first[18], 1);
	cdp.frame(1); await sleep(130);
	assert.equal(messages.filter(m => m.binary).length, 1, "Identical JPEGs must not consume viewer bandwidth");
	cdp.frame(2); await until(() => messages.filter(m => m.binary).length === 2, "Second pipelined frame");
	cdp.frame(3); await until(() => messages.filter(m => m.binary).length === 3, "Third pipelined frame");
	cdp.frame(4); cdp.frame(5); await sleep(130);
	assert.equal(messages.filter(m => m.binary).length, 3, "A slow viewer has at most three frames in flight");
	packet(socket, { type: "frame_ack", id: 9999 }); await sleep(80);
	assert.equal(messages.filter(m => m.binary).length, 3, "Future ACKs must not free frame credits");
	const began = Date.now();
	packet(socket, { type: "input", id: 1, body: { type: "down", x: 10, y: 20 } });
	packet(socket, { type: "input", id: 2, body: { type: "up", x: 10, y: 20 } });
	await until(() => messages.filter(m => !m.binary && JSON.parse(m.data.toString()).type === "ack").length === 2, "Input acknowledged while frame ACK is withheld");
	assert.deepEqual(inputs.map(x => (x as { type: string }).type), ["down", "up"]);
	assert.ok(Date.now() - began < 500, "A stalled screen must not stall input");
	packet(socket, { type: "frame_ack", id: first.readUInt32BE(4) });
	await until(() => messages.filter(m => m.binary).length === 4, "Next frame received");
	assert.equal(messages.filter(m => m.binary)[3].data[18], 5, "Only the latest frame survives backpressure");
	packet(socket, { type: "frame_ack", id: messages.filter(m => m.binary)[3].data.readUInt32BE(4) });
	await sleep(30);
	const beforeBenchmark = messages.filter(m => m.binary).length;
	const timers: ReturnType<typeof setTimeout>[] = [];
	const delayedAck = (data: Buffer, binary: boolean) => { if (binary) timers.push(setTimeout(() => { if (socket.readyState === WebSocket.OPEN) packet(socket, { type: "frame_ack", id: data.readUInt32BE(4) }); }, 240)); };
	socket.on("message", delayedAck);
	let value = 10;
	const frames = setInterval(() => cdp.frame(value++), 20);
	await sleep(1800); clearInterval(frames); socket.off("message", delayedAck); for (const timer of timers) clearTimeout(timer);
	const delivered = messages.filter(m => m.binary).length - beforeBenchmark;
	assert.ok(delivered >= 16, `240ms ACK delay must not force stop-and-wait frame delivery: ${delivered} frames`);
	console.log(`browser-live latency fixture: ${delivered} frames in 1.8s with 240ms display-ACK delay; bounded to three in flight`);
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
	finishSnapshot = undefined;
	const seeded = open(); await until(() => seeded.socket.readyState === WebSocket.OPEN, "Unchanged surface socket opened");
	packet(seeded.socket, { type: "auth", credential });
	await until(() => !!finishSnapshot, "A surface without CDP frames must seed a bounded screenshot");
	packet(seeded.socket, { type: "input", id: 5, body: { type: "key", key: "Tab" } });
	await until(() => has(seeded.messages, "ack"), "Initial screenshot capture must not block native input");
	finishSnapshot!(Buffer.from([0xff, 0xd8, 0xff, 0xd9]));
	await until(() => seeded.messages.some(m => m.binary), "The unchanged surface must show an initial frame");
	seeded.socket.close(); await until(() => seeded.socket.readyState === WebSocket.CLOSED, "Seed viewer closed");
	finishSnapshot = undefined;
	const clarity = open(); await until(() => clarity.socket.readyState === WebSocket.OPEN, "Clarity viewer opened");
	packet(clarity.socket, { type: "auth", credential });
	await until(() => has(clarity.messages, "ready"), "Clarity capture ready");
	cdp.frame(200);
	await until(() => clarity.messages.some(m => m.binary), "Moving image delivered");
	packet(clarity.socket, { type: "frame_ack", id: clarity.messages.find(m => m.binary)!.data.readUInt32BE(4) });
	await until(() => !!finishSnapshot, "Motion settling requests one readable still");
	assert.equal(snapshotQualities.at(-1), 70);
	const stale = finishSnapshot!; finishSnapshot = undefined;
	cdp.frame(201); stale(Buffer.from([0xff, 0xd8, 220, 0xff, 0xd9]));
	await until(() => clarity.messages.filter(m => m.binary).length === 2, "New motion invalidates the pending still");
	assert.equal(clarity.messages.filter(m => m.binary)[1].data[18], 201, "A stale high-quality capture must never replace a newer page state");
	packet(clarity.socket, { type: "frame_ack", id: clarity.messages.filter(m => m.binary)[1].data.readUInt32BE(4) });
	await until(() => !!finishSnapshot, "The new settled state gets a readable still");
	finishSnapshot!(Buffer.from([0xff, 0xd8, 221, 0xff, 0xd9])); finishSnapshot = undefined;
	await until(() => clarity.messages.filter(m => m.binary).length === 3, "Readable still delivered");
	assert.equal(clarity.messages.filter(m => m.binary)[2].data[18], 221);
	packet(clarity.socket, { type: "frame_ack", id: clarity.messages.filter(m => m.binary)[2].data.readUInt32BE(4) });
	cdp.frame(201); await sleep(160);
	assert.equal(clarity.messages.filter(m => m.binary).length, 3, "An unchanged native JPEG must not replace the clearer settled image");
	cdp.frame(202);
	await until(() => clarity.messages.filter(m => m.binary).length === 4, "Motion resumes without reconnecting");
	await until(() => live.status().profile === "economy", "A receiver withholding ACKs switches native encoding to the economy profile");
	assert.ok(cdp.calls.some(call => call.command === "Page.startScreencast" && call.params?.quality === 32));
	clarity.socket.close(); await until(() => clarity.socket.readyState === WebSocket.CLOSED, "Clarity viewer closed");
	const returned = open(); await until(() => returned.socket.readyState === WebSocket.OPEN, "Return socket opened");
	packet(returned.socket, { type: "auth", credential });
	await until(() => has(returned.messages, "authenticated"), "Return socket authenticated");
	packet(returned.socket, { type: "resume", id: 4 });
	await until(() => returned.socket.readyState === WebSocket.CLOSED, "Explicit return closes the socket");
	assert.ok(returned.messages.some(m => !m.binary && JSON.parse(m.data.toString()).id === 4 && JSON.parse(m.data.toString()).ok === true), "Return must be acknowledged before closing");
	assert.equal(has(returned.messages, "error"), false, "Successful return must not look like lost authorization");
	assert.equal(credential, "returned");
	console.log("browser-live: adaptive byte budget, duplicate suppression, bounded frame pipeline, cumulative ACKs, independent input, origin/auth/revocation and slow-capture fallback passed");
} finally {
	live.close(); for (const socket of sockets) socket.terminate();
	finishSnapshot?.(Buffer.from([0xff, 0xd8, 0xff, 0xd9]));
	await new Promise<void>(resolve => server.close(() => resolve()));
}
