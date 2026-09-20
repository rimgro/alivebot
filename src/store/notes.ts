import * as path from "node:path";
import { readJson, writeJsonAtomic } from "../util.js";

/**
 * Small key/value scratchpad. This is working memory that is deliberately
 * *outside* the transcript: it survives compaction cheaply and is always
 * rendered into the wake prompt.
 */
export class NoteStore {
	private readonly file: string;

	constructor(stateDir: string) {
		this.file = path.join(stateDir, "notes.json");
	}

	all(): Record<string, string> {
		return readJson<Record<string, string>>(this.file, {});
	}

	get(key: string): string | undefined {
		return this.all()[key];
	}

	set(key: string, value: string): void {
		const notes = this.all();
		notes[key] = value;
		writeJsonAtomic(this.file, notes);
	}

	delete(key: string): boolean {
		const notes = this.all();
		if (!(key in notes)) return false;
		delete notes[key];
		writeJsonAtomic(this.file, notes);
		return true;
	}
}
