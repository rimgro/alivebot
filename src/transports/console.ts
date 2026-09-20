import * as readline from "node:readline";
import { term, stamp } from "../term.js";
import { truncate } from "../util.js";
import type { OutgoingMessage } from "../store/outbox.js";
import type { ChatTransport, TransportContext } from "./types.js";

/**
 * Terminal transport.
 *
 * Inbound: each line typed on stdin becomes a user message for thread "console".
 * Outbound: agent messages are printed with a clear sender marker so it is
 * obvious they arrived through the `send_message` tool and not as chat output.
 */
export class ConsoleTransport implements ChatTransport {
	readonly name = "console";
	private rl?: readline.Interface;

	constructor(private readonly options: { quiet?: boolean } = {}) {}

	async start(ctx: TransportContext): Promise<void> {
		if (process.stdin.isTTY && !process.env.ALIVE_NO_STDIN) {
			this.rl = readline.createInterface({ input: process.stdin, output: process.stderr, terminal: false });
			this.rl.on("line", (line) => {
				const text = line.trim();
				if (!text) return;
				if (text === "/quit" || text === "/exit") {
					process.kill(process.pid, "SIGTERM");
					return;
				}
				ctx.ingest({
					kind: "user_message",
					source: "console",
					priority: "normal",
					title: "message from console user",
					text,
					thread: "console",
					expectsReply: true,
					meta: { from: "console" },
				});
			});
			process.stderr.write(
				`${term.dim("[alive] type a message for the agent (one line), /quit to stop")}\n`,
			);
		}
	}

	async send(message: OutgoingMessage): Promise<void> {
		if (this.options.quiet) return;
		process.stderr.write(
			`\n${term.dim(stamp())} ${term.bold(term.magenta(`💬 ${message.thread}`))} ${term.gray(`(${message.id})`)}\n${truncate(message.text, 4000)}\n`,
		);
	}

	async stop(): Promise<void> {
		this.rl?.close();
		this.rl = undefined;
	}
}

/** Prints nothing; used for tests and for headless deployments with an HTTP/chat transport. */
export class NullTransport implements ChatTransport {
	readonly name = "null";
	async start(): Promise<void> {}
	async send(message: OutgoingMessage): Promise<void> {
		void message;
	}
	async stop(): Promise<void> {}
}
