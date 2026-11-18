import assert from "node:assert/strict";
import { DEFAULT_CONTRACT } from "../config.js";
import { buildSystemPrompt } from "../runtime/prompt.js";
import { ASSISTANT_PRINCIPLES } from "../runtime/principles.js";

// Проверяем подключение правил, а не качество поведения модели.
const personalContract = "# Личный контракт\n\nГотовь черновики, отправляй только после подтверждения.";
for (const contract of [personalContract, undefined, "", "   "]) {
	const input = {
		name: "Slava",
		soul: "Помогай с исследованием.",
		contract,
		workspace: "/workspace/slava",
		stateDir: "/state/slava",
		runTimeoutMs: 60_000,
		runWarnMs: 0,
		sleepAfterMs: 600_000,
	};
	const prompt = buildSystemPrompt(input);
	const effectiveContract = contract?.trim() || DEFAULT_CONTRACT.trim();
	assert.ok(prompt.includes(effectiveContract), "Личный контракт или стандартный шаблон сохранён");
	assert.equal(prompt.split(ASSISTANT_PRINCIPLES).length - 1, 1, "Общие правила включены ровно один раз");
	assert.ok(prompt.indexOf(ASSISTANT_PRINCIPLES) > prompt.indexOf(effectiveContract), "Общие правила дополняют личный контракт");
	assert.equal(buildSystemPrompt(input), prompt, "Пересборка сохраняет стабильный системный префикс");
}

console.log("principles-test: ok (личный контракт, старый профиль, стандартный контракт, стабильная пересборка)");
