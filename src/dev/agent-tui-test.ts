import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
	initialAgentConsoleState,
	renderAgentConsole,
	reduceAgentConsoleKey,
	runAgentConsole,
	sanitizeTerminalText,
} from "../tui/agent-console.js";
import { operatorAgentThread, recordOperatorAgentReply } from "../runtime/agent-messaging.js";
import { createAgent } from "../agents.js";
import { loadConfig, writeDefaultConfig } from "../config.js";
import { HistoryStore } from "../store/history.js";

const state = initialAgentConsoleState([
	{ id: "admin", name: "Admin", enabled: true, running: true },
	{ id: "writer", name: "Writer", enabled: true, running: false },
]);
assert.equal(reduceAgentConsoleKey(state, { name: "down" }).type, "select");
assert.equal(state.agents[state.selectedIndex]?.id, "writer", "arrow navigation selects another agent");
assert.deepEqual(reduceAgentConsoleKey(state, { name: "s", meta: true }), { type: "start", agentId: "writer" });
assert.deepEqual(reduceAgentConsoleKey(state, { name: "x", meta: true }), { type: "stop", agentId: "writer" });
reduceAgentConsoleKey(state, { name: "h", text: "h" });
reduceAgentConsoleKey(state, { name: "i", text: "i" });
reduceAgentConsoleKey(state, { name: "j", ctrl: true });
assert.equal(state.input, "hi\n", "Ctrl+J inserts a newline into the composer");
assert.deepEqual(reduceAgentConsoleKey(state, { name: "return" }), { type: "send", text: "hi" });
assert.equal(state.input, "", "sending clears the composer");
assert.deepEqual(reduceAgentConsoleKey(state, { name: "escape" }), { type: "exit" });
assert.equal(sanitizeTerminalText("first\r\nsecond\u001b[31mred\u001b[0m\u001b]0;title\u0007\u009b2J"), "first\nsecondred");
const pasted = initialAgentConsoleState();
reduceAgentConsoleKey(pasted, { name: "x", text: "\u001b[2Jsafe\u001b]52;c;clipboard\u0007" });
assert.equal(pasted.input, "safe", "pasted terminal escape payloads are removed before display or send");
assert.equal(operatorAgentThread("writer"), "local:agent:writer:operator", "TUI conversation thread matches local messenger routing");

const root = fs.mkdtempSync(path.join(os.tmpdir(), "alive-agent-tui-"));
try {
	writeDefaultConfig(root);
	const base = loadConfig({ cwd: root });
	const profile = createAgent(base, "writer", "Writer");
	const loaded = loadConfig({ cwd: root, configPath: profile.configPath });
	const history = HistoryStore.open(loaded.paths.stateDir);
	history.append({ id: "operator-in", thread: operatorAgentThread("writer"), module: "local", direction: "inbound", ts: 1, author: "Operator", authorId: "operator", text: "hello" });
	assert.equal(recordOperatorAgentReply(history, loaded, operatorAgentThread("writer"), { id: "writer-out", text: "hi there", ts: 2 }), true);
	assert.equal(recordOperatorAgentReply(history, loaded, "telegram:123", { id: "not-local", text: "ignored", ts: 3 }), false);
	const transcript = history.query({ module: "local", thread: operatorAgentThread("writer"), order: "asc" });
	assert.deepEqual(transcript.map((message) => message.direction), ["inbound", "outbound"]);
	assert.equal(transcript[1]?.text, "hi there", "agent send_message replies are visible in the operator's TUI thread");
} finally {
	fs.rmSync(root, { recursive: true, force: true });
}

const rendered = renderAgentConsole({
	...initialAgentConsoleState([{ id: "writer", name: "Writer", enabled: true, running: true }]),
	messages: [{ id: "m1", thread: "local:agent:writer:operator", module: "local", direction: "inbound", ts: 0, author: "Operator", text: "hello" }],
}, 90, 20);
assert.match(rendered, /Alive Agent Console/);
assert.match(rendered, /writer/);
assert.match(rendered, /hello/);
assert.match(renderAgentConsole(initialAgentConsoleState(), 40, 8), /Terminal too small/);
const hostile = initialAgentConsoleState([{
	id: "writer",
	name: "Writer\u001b]0;owned title\u0007\u001b[31mRED",
	enabled: true,
	running: true,
}]);
hostile.notice = "oops\u001b[2J\u001b]52;c;owned clipboard\u0007\u009b1;2H";
hostile.input = "draft\u001b[?1049h";
hostile.messages = [{
	id: "hostile", thread: "local:operator", module: "local", direction: "inbound", ts: 0,
	author: "User\u001b[31m", text: "first\nsecond\u001b]8;;https://evil.invalid\u0007click\u001b]8;;\u0007\u009b2J",
}];
const safeRender = renderAgentConsole(hostile, 90, 20);
assert.equal(/\u001B|\u009B|[\u0000-\u0008\u000B-\u001F\u007F-\u009F]/.test(safeRender), false, "render output contains no terminal control characters");
assert.match(safeRender, /first/);
assert.match(safeRender, /second/);
await assert.rejects(() => runAgentConsole({
	listAgents: async () => [], listMessages: async () => [], send: async () => {}, start: async () => {}, stop: async () => {},
}), /requires an interactive terminal/);

console.log("agent tui tests passed");
