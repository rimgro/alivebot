import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { createAgent } from "../agents.js";
import { DEFAULT_CONFIG, DEFAULT_SOUL, loadConfig, writeDefaultConfig } from "../config.js";
import { createOnboardingTool } from "../runtime/onboarding.js";
import { buildSystemPrompt } from "../runtime/prompt.js";
import { selectAllowedTools } from "../runtime/session.js";
import { ALIVE_TOOL_NAMES } from "../runtime/tools.js";
import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import { createWritingGuideTool } from "../runtime/writing.js";
import type { AliveEvent } from "../store/events.js";
import { isOnboardingEvent, onboardingContext, OnboardingStore } from "../store/onboarding.js";

const root = fs.mkdtempSync(path.join(os.tmpdir(), "slava-conversation-test-"));
const call = (tool: ToolDefinition, params: unknown) => tool.execute("test", params as never, undefined, undefined, {} as never);
const event = (seq: number, thread = "telegram:42", text = "пиши по-русски и коротко"): AliveEvent => ({
	seq, id: `event-${seq}`, ts: 1_700_000_000_000 + seq,
	kind: "user_message", source: "telegram", priority: "normal", title: "Message", text, thread,
	expectsReply: true, meta: { chatType: "private" },
});
try {
	const store = new OnboardingStore(root);
	assert.equal(store.get("telegram:42").status, "pending");
	assert.equal(fs.existsSync(path.join(root, "onboarding")), false, "status is read-only");
	const first = store.change("telegram:42", "update", event(1), { language: "русский", detail: "коротко" });
	assert.equal(first.status, "active");
	assert.equal(first.preferences.language?.eventId, "event-1");
	assert.deepEqual(new OnboardingStore(root).get("telegram:42"), first, "restart restores partial intake");
	assert.deepEqual(store.change("telegram:42", "update", event(1), { language: "русский", detail: "коротко" }), first, "redelivery is idempotent");
	const skipped = store.change("telegram:42", "skip", event(2, "telegram:42", "пропусти знакомство"));
	assert.equal(new OnboardingStore(root).get("telegram:42").status, "skipped");
	assert.deepEqual(store.change("telegram:42", "skip", event(2)), skipped);
	const corrected = store.change("telegram:42", "update", event(3), { detail: "подробно", tone: "спокойно" });
	assert.equal(corrected.status, "skipped", "correction does not reopen intake");
	assert.equal(corrected.preferences.language?.value, "русский", "partial merge keeps other values");
	assert.equal(store.change("telegram:42", "update", event(4), { tone: null }).preferences.tone, undefined);
	assert.equal(store.change("telegram:42", "complete", event(5)).status, "completed");
	assert.equal(new OnboardingStore(root).get("telegram:42").status, "completed", "context reset needs no LLM memory");
	assert.throws(() => store.change("telegram:42", "update", event(2), { tone: "старое" }), /Stale/);
	assert.throws(() => store.change("telegram:42", "update", event(6), { tone: "x".repeat(301) }), /300/);
	assert.throws(() => store.change("telegram:42", "update", event(6), { unknown: "x" } as any), /Unknown/);
	assert.throws(() => store.change("telegram:42", "complete", event(6), { tone: "x" }), /only accepted/);
	for (const invalid of [event(6, "telegram:-42"), { ...event(6), meta: {} }, { ...event(6), kind: "heartbeat" as const }, { ...event(6), expectsReply: false }, event(6, "local:agent:worker")]) {
		assert.equal(isOnboardingEvent(invalid), false);
		assert.throws(() => store.change(invalid.thread!, "update", invalid, { tone: "x" }), /private human/);
	}
	assert.throws(() => store.change("telegram:43", "update", event(6), { tone: "x" }), /private human/);
	assert(!onboardingContext(root, [event(7, "telegram:43")]).includes("русский"), "no other conversation profile in context");
	assert(onboardingContext(root, [event(7)]).includes('"status":"completed"'));
	assert.equal(onboardingContext(root, [{ ...event(7), kind: "reminder" }]), "");
	assert.equal(onboardingContext(root, [event(7, "telegram:-42")]), "");
	for (const file of fs.readdirSync(path.join(root, "onboarding"))) {
		assert.equal(fs.statSync(path.join(root, "onboarding", file)).mode & 0o777, 0o600);
	}

	let current = [event(8)];
	const tool = createOnboardingTool({ stateDir: root, currentEvents: () => current });
	await assert.rejects(async () => call(tool, { action: "status", thread: "telegram:43" }), /current private/);
	await assert.rejects(async () => call(tool, { action: "update", thread: "telegram:42", event_id: "event-1", evidence: "коротко", preferences: { detail: "коротко" } }), /latest human/);
	await assert.rejects(async () => call(tool, { action: "update", thread: "telegram:42", event_id: "event-8", evidence: "несуществующая цитата", preferences: { detail: "коротко" } }), /exact quote/);
	await call(tool, { action: "update", thread: "telegram:42", event_id: "event-8", evidence: "коротко", preferences: { detail: "коротко" } });
	assert.equal(store.get("telegram:42").preferences.detail?.eventId, "event-8");
	current = [{ ...event(8), text: 'quoted reply: "пиши коротко"\nмой ответ: спасибо', payload: { module: "telegram", userText: "спасибо" } }];
	await assert.rejects(async () => call(tool, { action: "update", thread: "telegram:42", event_id: "event-8", evidence: "пиши коротко", preferences: { detail: "коротко" } }), /exact quote/, "a quoted reply is not the current person's preference");
	assert(!isOnboardingEvent({ ...event(8), payload: { forward: "someone else's message" } }));
	assert(!isOnboardingEvent({ ...event(8), payload: { author: { isBot: true } } }));
	current = [{ ...event(8), payload: { module: "telegram", userText: "(voice)", transcription: { status: "transcribed", text: "пиши подробнее" } } }];
	await call(tool, { action: "update", thread: "telegram:42", event_id: "event-8", evidence: "пиши подробнее", preferences: { detail: "подробнее" } });
	assert.equal(store.get("telegram:42").preferences.detail?.value, "подробнее", "successful voice transcript is eligible evidence");
	current = [{ ...event(8), payload: { module: "telegram", userText: "(voice)", transcription: { status: "failed", text: "пиши подробнее" } } }];
	await assert.rejects(async () => call(tool, { action: "update", thread: "telegram:42", event_id: "event-8", evidence: "пиши подробнее", preferences: { detail: "подробнее" } }), /exact quote/, "failed transcription cannot supply evidence");
	current = [];
	await assert.rejects(async () => call(tool, { action: "status", thread: "telegram:42" }), /current private/);
	assert.deepEqual(store.change("telegram:42", "reset", event(9)).preferences, {});
	assert.equal(store.get("telegram:42").status, "pending");
	store.change("telegram:42", "skip", event(10));
	store.change("telegram:42", "skip", event(20));
	assert.throws(() => store.change("telegram:42", "update", event(15), { tone: "stale" }), /Stale/, "new no-op events must advance the watermark");

	writeDefaultConfig(root);
	const base = loadConfig({ cwd: root });
	fs.writeFileSync(base.paths.soulPath, "My personal identity and private tone");
	const child = createAgent(base, "researcher", "Researcher");
	assert.equal(fs.readFileSync(path.join(child.directory, "SOUL.md"), "utf8"), DEFAULT_SOUL);
	assert.equal(new OnboardingStore(loadConfig({ cwd: root, configPath: child.configPath }).paths.stateDir).get("telegram:42").status, "pending");

	const prompt = buildSystemPrompt({ name: "Slava", soul: "Useful", workspace: root, stateDir: root, runTimeoutMs: 0, runWarnMs: 0, sleepAfterMs: 1000, onboardingAvailable: true, writingGuideAvailable: true });
	assert(prompt.includes("Do the first useful task before optional setup"));
	assert(prompt.includes("Conversation preferences arrive with current private human events"));
	assert(prompt.includes("writing_guide"));
	assert(!buildSystemPrompt({ name: "Slava", soul: "Useful", workspace: root, stateDir: root, runTimeoutMs: 0, runWarnMs: 0, sleepAfterMs: 1000 }).includes("# Getting acquainted"));
	assert(!DEFAULT_SOUL.includes("You're a person"));

	for (const isolated of [false, true]) {
		const allowed = selectAllowedTools({ allowlist: DEFAULT_CONFIG.tools.allowlist, builtins: isolated ? [] : DEFAULT_CONFIG.tools.builtin, alive: [...ALIVE_TOOL_NAMES], modules: [], sandbox: [], custom: [], toolRegistryAvailable: !isolated });
		assert(allowed.includes("writing_guide") && allowed.includes("onboarding"));
	}
	const guide = createWritingGuideTool();
	const result = await call(guide, { name: "anti-slop" });
	assert(result.content.some(block => block.type === "text" && block.text.includes("# Edit for substance")));
	await assert.rejects(async () => call(guide, { name: "../../.pi/agent/auth.json" }), /Unknown/);
	// Corruption must never silently restart onboarding and overwrite prior choices.
	const profile = fs.readdirSync(path.join(root, "onboarding"))[0]!;
	fs.writeFileSync(path.join(root, "onboarding", profile), "{broken");
	assert.throws(() => store.get("telegram:42"));
	assert(onboardingContext(root, [event(21)]).includes('"status":"unavailable"'), "corrupt optional profile cannot block the task or restart intake");
	console.log("conversation quality tests passed (offline contracts; no model quality claim)");
} finally {
	fs.rmSync(root, { recursive: true, force: true });
}
