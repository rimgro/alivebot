import * as fs from "node:fs";
import * as path from "node:path";
import { ensureDir, localDay, localTime } from "../util.js";

/**
 * The agent's diary. One markdown file per day, append-only.
 *
 * The transcript is working memory and gets compacted; the journal is durable
 * episodic memory the agent writes deliberately. The tail of it is rendered
 * into every wake prompt so recent history is always in context.
 */
export class Journal {
	private readonly dir: string;

	constructor(stateDir: string) {
		this.dir = path.join(stateDir, "journal");
		ensureDir(this.dir);
	}

	append(entry: string, ts = Date.now()): string {
		const file = path.join(this.dir, `${localDay(ts)}.md`);
		if (!fs.existsSync(file)) {
			fs.writeFileSync(file, `# Journal ${localDay(ts)}\n\n`, "utf8");
		}
		fs.appendFileSync(file, `## ${localTime(ts)} — ${entry.trim()}\n\n`, "utf8");
		return file;
	}

	tail(lines: number, ts = Date.now()): string[] {
		const today = path.join(this.dir, `${localDay(ts)}.md`);
		const yesterday = path.join(this.dir, `${localDay(ts - 86_400_000)}.md`);
		const files = [yesterday, today].filter((f) => fs.existsSync(f));
		const out: string[] = [];
		for (const file of files) {
			try {
				const content = fs.readFileSync(file, "utf8");
				out.push(...content.split("\n").filter((l) => l.trim().length > 0));
			} catch {
				// ignore
			}
		}
		return out.slice(-lines);
	}

	/** Most recent journal entries (headers only), newest last. */
	recentEntries(limit: number, ts = Date.now()): string[] {
		const tail = this.tail(400, ts);
		const headers = tail.filter((l) => l.startsWith("## "));
		return headers.slice(-limit);
	}
}
