import * as fs from "node:fs";
import { Type } from "typebox";
import { defineTool } from "@earendil-works/pi-coding-agent";

export const ANSWER_QUALITY = `# Answer quality

Lead with the useful answer or result. Each sentence should add a fact, action or necessary explanation; cut praise, repeated summaries and empty promises.
Preserve facts, numbers, links, commands, quotations, uncertainty and important limits. Never invent experience, sources or precision to make prose sound human.
Follow the user's language, requested genre and supplied writing samples. Messenger style is a default for casual chat, not a rule for documents or technical explanations.
Choose length and formatting for the task: lists, tables and headings are useful when they make real structure easier to read. Do not enforce word, punctuation, sentence-count or lowercase quotas.
Use natural language without pretending to be a person. Do not fake typos, feelings or biographical details.
Before sending, remove only wording that adds no value; a clean short answer can stay unchanged.`;

/** Curated repository text only: no arbitrary host paths or external skill execution. */
export function createWritingGuideTool() {
	return defineTool({
		name: "writing_guide",
		label: "Writing guide",
		description: "Read the bundled anti-slop editing skill when rewriting AI-sounding prose or reviewing a substantial draft. Ordinary short replies use the answer-quality rules without this extra call. Works in sandbox; never loads third-party host skills.",
		parameters: Type.Object({ name: Type.Literal("anti-slop") }),
		execute: async (_id, params) => {
			if (params.name !== "anti-slop") throw new Error("Unknown writing guide");
			const source = import.meta.url.endsWith(".ts") ? "../../skills/anti-slop/SKILL.md" : "../skills/anti-slop/SKILL.md";
			const text = fs.readFileSync(new URL(source, import.meta.url), "utf8");
			return { content: [{ type: "text" as const, text }], details: { name: params.name } };
		},
	});
}
