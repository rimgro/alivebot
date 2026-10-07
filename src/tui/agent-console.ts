import * as readline from "node:readline";
import type { HistoryRecord } from "../store/history.js";

export interface AgentConsoleEntry {
	id: string;
	name: string;
	enabled: boolean;
	running: boolean;
}

export interface AgentConsoleState {
	agents: AgentConsoleEntry[];
	selectedIndex: number;
	messages: HistoryRecord[];
	input: string;
	/** Number of rendered transcript lines to scroll back from the latest message. */
	scrollBack: number;
	notice: string;
}

export type AgentConsoleAction =
	| { type: "exit" }
	| { type: "select"; index: number }
	| { type: "send"; text: string }
	| { type: "start"; agentId: string }
	| { type: "stop"; agentId: string }
	| { type: "none" };

export interface AgentConsoleKey {
	name: string;
	text?: string;
	ctrl?: boolean;
	meta?: boolean;
}

export function initialAgentConsoleState(agents: AgentConsoleEntry[] = []): AgentConsoleState {
	return { agents, selectedIndex: 0, messages: [], input: "", scrollBack: 0, notice: "" };
}

export function selectedAgent(state: AgentConsoleState): AgentConsoleEntry | undefined {
	return state.agents[state.selectedIndex];
}

/** Apply one parsed keypress. Kept pure so navigation and controls are testable without a TTY. */
export function reduceAgentConsoleKey(state: AgentConsoleState, key: AgentConsoleKey): AgentConsoleAction {
	if ((key.ctrl && key.name === "c") || key.name === "escape") return { type: "exit" };
	const selected = selectedAgent(state);
	if (key.meta && key.name.toLowerCase() === "s") {
		return selected ? { type: "start", agentId: selected.id } : { type: "none" };
	}
	if (key.meta && key.name.toLowerCase() === "x") {
		return selected ? { type: "stop", agentId: selected.id } : { type: "none" };
	}
	if (key.name === "up" && !key.ctrl) {
		if (state.agents.length) state.selectedIndex = (state.selectedIndex - 1 + state.agents.length) % state.agents.length;
		state.scrollBack = 0;
		return state.agents.length ? { type: "select", index: state.selectedIndex } : { type: "none" };
	}
	if (key.name === "down" && !key.ctrl) {
		if (state.agents.length) state.selectedIndex = (state.selectedIndex + 1) % state.agents.length;
		state.scrollBack = 0;
		return state.agents.length ? { type: "select", index: state.selectedIndex } : { type: "none" };
	}
	if (key.name === "pageup") {
		state.scrollBack = Math.min(state.scrollBack + 8, Math.max(0, state.messages.length * 3));
		return { type: "none" };
	}
	if (key.name === "pagedown") {
		state.scrollBack = Math.max(0, state.scrollBack - 8);
		return { type: "none" };
	}
	if (key.ctrl && key.name === "j") {
		state.input += "\n";
		return { type: "none" };
	}
	if (key.name === "return" || key.name === "enter") {
		const text = state.input.trim();
		if (!selected || !text) return { type: "none" };
		state.input = "";
		state.scrollBack = 0;
		return { type: "send", text };
	}
	if (key.name === "backspace" || key.name === "delete") {
		state.input = [...state.input].slice(0, -1).join("");
		return { type: "none" };
	}
	if (!key.ctrl && !key.meta && key.text && key.name !== "tab") {
		state.input += sanitizeTerminalText(key.text);
		return { type: "none" };
	}
	return { type: "none" };
}

export function renderAgentConsole(state: AgentConsoleState, columns: number, rows: number): string {
	const width = Math.max(1, columns);
	const height = Math.max(1, rows);
	if (width < 56 || height < 10) {
		return ["Alive Agent Console", `Terminal too small (${width}x${height}); resize to at least 56x10.`, "Esc or Ctrl+C to quit"].slice(0, height).join("\n");
	}
	const sidebarWidth = Math.min(28, Math.max(18, Math.floor(width * 0.25)));
	const separator = " │ ";
	const chatWidth = width - sidebarWidth - separator.length;
	const title = `Alive Agent Console  ↑/↓ agent · Alt+S start · Alt+X stop · Esc quit`;
	const lines: string[] = [fit(title, width)];
	lines.push(fit(`${pad("AGENTS", sidebarWidth)}${separator}CHAT · ${selectedAgent(state)?.name ?? "no agent selected"}`, width));

	const inputLines = Math.max(2, Math.min(4, state.input.split("\n").length + 1));
	const transcriptHeight = Math.max(1, height - inputLines - 4);
	const sidebarRows = Math.max(0, transcriptHeight);
	for (let index = 0; index < sidebarRows; index++) {
		const agent = state.agents[index];
		const selected = index === state.selectedIndex;
		const marker = selected ? "›" : " ";
		const row = agent
			? `${marker}${agent.running ? "●" : "○"} ${agent.id} ${agent.enabled ? "on" : "off"}`
			: "";
		lines.push(`${fit(row, sidebarWidth)}${separator}${fit(chatLines(state, chatWidth, transcriptHeight)[index] ?? "", chatWidth)}`);
	}

	lines.push(fit("─".repeat(width), width));
	const composedLines = wrapText(state.input, Math.max(1, width - 2)).slice(-inputLines);
	lines.push(fit(`> ${composedLines[0] ?? ""}`, width));
	for (const line of composedLines.slice(1)) lines.push(fit(`  ${line}`, width));
	while (lines.length < height - 1) lines.push("");
	lines.push(fit(state.notice || "Enter send · Ctrl+J newline · PageUp/PageDown scroll · ● running / ○ stopped", width));
	return lines.slice(0, height).join("\n");
}

function chatLines(state: AgentConsoleState, width: number, limit: number): string[] {
	const lines: string[] = [];
	for (const message of state.messages) {
		const time = new Date(message.ts).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
		const author = message.direction === "outbound" ? "agent" : (message.author ?? message.authorId ?? "operator");
		lines.push(...wrapText(`${time} ${author}: ${message.text}`, width));
	}
	const end = Math.max(0, lines.length - state.scrollBack);
	return lines.slice(Math.max(0, end - limit), end);
}

export function sanitizeTerminalText(text: string): string {
	return text
		.replace(/\r\n?/g, "\n")
		.replace(/\u001B\][^\u0007]*(?:\u0007|\u001B\\)/g, "")
		.replace(/\u001B[PX^_][\s\S]*?\u001B\\/g, "")
		.replace(/\u001B\[[0-?]*[ -/]*[@-~]/g, "")
		.replace(/\u001B[@-_]/g, "")
		.replace(/\u009B[0-?]*[ -/]*[@-~]/g, "")
		.replace(/\u009D[^\u0007\u009C]*(?:\u0007|\u009C)/g, "")
		.replace(/[\u0090\u0098\u009E\u009F][\s\S]*?\u009C/g, "")
		.replace(/[\u0000-\u0008\u000B-\u001F\u007F-\u009F]/g, "");
}

function wrapText(text: string, width: number): string[] {
	text = sanitizeTerminalText(text);
	const result: string[] = [];
	for (const paragraph of text.split("\n")) {
		if (!paragraph) { result.push(""); continue; }
		let remaining = paragraph;
		while (remaining.length > width) {
			let split = remaining.lastIndexOf(" ", width);
			if (split <= 0) split = width;
			result.push(remaining.slice(0, split));
			remaining = remaining.slice(split).trimStart();
		}
		result.push(remaining);
	}
	return result;
}

function pad(value: string, width: number): string { return value.length >= width ? value.slice(0, width) : value + " ".repeat(width - value.length); }
function fit(value: string, width: number): string { return pad(sanitizeTerminalText(value).replace(/\n/g, " "), width); }

export interface AgentConsoleController {
	listAgents(): Promise<AgentConsoleEntry[]>;
	listMessages(agentId: string): Promise<HistoryRecord[]>;
	send(agentId: string, text: string): Promise<void>;
	start(agentId: string): Promise<void>;
	stop(agentId: string): Promise<void>;
}

/** Run the interactive, polling terminal UI. All lifecycle operations are supplied by the host/operator. */
export async function runAgentConsole(controller: AgentConsoleController): Promise<void> {
	if (!process.stdin.isTTY || !process.stdout.isTTY || typeof process.stdin.setRawMode !== "function") {
		throw new Error("alive agents tui requires an interactive terminal (TTY) on stdin and stdout");
	}
	const input = process.stdin;
	const output = process.stdout;
	const previousRawMode = input.isRaw;
	let state = initialAgentConsoleState();
	let refreshing = false;
	let closed = false;
	let operation = Promise.resolve();
	const draw = () => {
		output.write("\x1b[H\x1b[2J" + renderAgentConsole(state, output.columns ?? 80, output.rows ?? 24));
	};
	const refresh = async () => {
		if (refreshing || closed) return;
		refreshing = true;
		try {
			const previousId = selectedAgent(state)?.id;
			state.agents = await controller.listAgents();
			const nextIndex = previousId ? state.agents.findIndex((agent) => agent.id === previousId) : -1;
			state.selectedIndex = nextIndex >= 0 ? nextIndex : Math.min(state.selectedIndex, Math.max(0, state.agents.length - 1));
			const selected = selectedAgent(state);
			state.messages = selected ? await controller.listMessages(selected.id) : [];
			draw();
		} catch (error) {
			state.notice = errorMessage(error);
			draw();
		} finally {
			refreshing = false;
		}
	};
	const finish = () => {
		if (closed) return;
		closed = true;
		clearInterval(timer);
		input.off("keypress", onKeypress);
		input.off("end", onInputEnd);
		process.off("SIGWINCH", onResize);
		process.off("SIGINT", onSignal);
		process.off("SIGTERM", onSignal);
		if (!previousRawMode) input.setRawMode(false);
		input.pause();
		output.write("\x1b[?1049l\x1b[?25h\n");
	};
	const perform = async (action: AgentConsoleAction) => {
		if (action.type === "exit") { finish(); return; }
		if (action.type === "send") {
			const agent = selectedAgent(state);
			if (!agent) return;
			state.notice = `sending to ${agent.name}…`;
			try { await controller.send(agent.id, action.text); state.notice = `sent to ${agent.name}`; }
			catch (error) { state.notice = errorMessage(error); }
			await refresh();
			return;
		}
		if (action.type === "start" || action.type === "stop") {
			state.notice = `${action.type === "start" ? "starting" : "stopping"} ${action.agentId}…`;
			draw();
			try {
				await controller[action.type](action.agentId);
				state.notice = `${action.agentId} ${action.type === "start" ? "started" : "stopped"}`;
			} catch (error) { state.notice = errorMessage(error); }
			await refresh();
			return;
		}
		if (action.type === "select") {
			state.scrollBack = 0;
			await refresh();
		}
	};
	const onKeypress = (text: string, key: readline.Key) => {
		if (closed) return;
		const keyName = key.name ?? text;
		const action = reduceAgentConsoleKey(state, { name: keyName, text, ctrl: key.ctrl, meta: key.meta });
		if (action.type !== "none") {
			operation = operation.then(() => perform(action)).catch((error) => { state.notice = errorMessage(error); draw(); });
		} else draw();
	};
	const onResize = () => draw();
	const onSignal = () => finish();
	const onInputEnd = () => finish();
	readline.emitKeypressEvents(input);
	input.setRawMode(true);
	input.resume();
	input.on("keypress", onKeypress);
	input.once("end", onInputEnd);
	process.on("SIGWINCH", onResize);
	process.on("SIGINT", onSignal);
	process.on("SIGTERM", onSignal);
	output.write("\x1b[?1049h\x1b[?25h");
	const timer = setInterval(() => { void refresh(); }, 600);
	await refresh();
	await new Promise<void>((resolve) => {
		const check = setInterval(() => { if (closed) { clearInterval(check); resolve(); } }, 20);
	});
}

function errorMessage(error: unknown): string { return error instanceof Error ? error.message : String(error); }
