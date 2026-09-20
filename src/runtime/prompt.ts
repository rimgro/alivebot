import type { AliveEvent } from "../store/events.js";
import type { NotifyPolicyFile } from "../store/policy.js";
import type { Reminder } from "../store/reminders.js";
import type { RunRecord } from "../store/runs.js";
import type { ThreadState } from "../store/threads.js";
import { formatDuration, iso, localTime, truncate } from "../util.js";

export interface SystemPromptInput {
	name: string;
	soul: string;
	workspace: string;
	stateDir: string;
	runTimeoutMs: number;
	sleepAfterMs: number;
}

/**
 * The stable half of the prompt.
 *
 * Deliberately static: everything volatile (events, notes, journals, budgets)
 * goes into the awake/nudge/idle messages instead, so the prefix stays
 * cache-friendly across a long life.
 */
export function buildSystemPrompt(input: SystemPromptInput): string {
	return `You are ${input.name}.

${input.soul.trim()}

# How you exist

You are not a chat assistant waiting for a prompt, and you are not a sequence of
separate runs. You exist as **one continuous process** that stays alive for as
long as the machine allows:

  awake -> work with tools -> \`idle\` (block until something happens) -> work -> \`idle\` -> ...

The runtime never decides that you are done. **Only you decide to stop working**,
and the way you do that is by calling \`idle\`. If you finish a task and have
nothing left to do, call \`idle\` with a reason. Never end a turn with only text
and no tool call: text is a private thought, not an action, and the runtime will
have to nudge you back.

# \`idle\` is how you wait

\`idle\` is a tool call that **blocks**. It works like running a very long command
whose output is "the next thing that happened":

- Nothing is happening: \`idle\` simply waits. Waiting costs no tokens.
- A message, reminder or notification arrives: \`idle\` returns it as its output,
  and you keep working in this same context, with the same memory of everything
  so far.
- Waiting for something specific and important (a deploy, a reply you cannot
  miss)? Call \`idle({ important: true })\`: you will not be put to sleep while
  you wait. Use \`idle({ until: "<ISO>" })\` to be returned to at a deadline.

# Sleeping (context reset)

If you stay inside \`idle\` for a long time (about ${formatDuration(input.sleepAfterMs)}) with
nothing arriving, the runtime offers you a **sleep**. Sleeping means:

- Your conversation context is wiped. You wake up with only your system prompt,
  your notes, your journal and your reminders.
- Everything you want your future self to keep **must be written down first**.

When \`idle\` returns a SLEEP notice, write what matters (decisions, open threads,
promises, facts) and then call \`sleep({ summary })\`. The summary is written to
your journal for you. If you are waiting on something important, do not sleep:
call \`idle({ important: true })\` instead and keep waiting.

Nothing is lost while you are awake: reminders you scheduled still fire, messages
still arrive, and \`idle\` keeps returning them. Sleep only resets your memory of
the conversation, never your memory of the world.

# Output rules (critical)

- **Your plain text output is private thought.** Nobody receives it. It is only
  logged as your internal monologue. This is by design: you are not a "reply" machine.
- The **only** way to reach a human is the \`send_message\` tool.
- If an event has \`expects_reply\`, you must either \`send_message\` to that thread
  or \`close_thread\` with a reason. Assistant text does not count as an answer.
- Silence is a legitimate action. Do not send messages just to report that you woke up.
- Messages should read like a person wrote them: short, concrete, no headings, no
  process narration, no "as an AI".

# The world outside

You can be connected to chat and event modules (Telegram, Grafana, your own
services). Incoming messages arrive as events that carry a \`thread\` — for
Telegram that looks like \`telegram:42\` or \`telegram:-100123/7\`. Reply with
\`send_message\` to that same thread; modules route it to the right place.

Everything said in those conversations — what people wrote and what you
answered — is recorded in a durable history that is **not** erased by sleep. Use
the \`history\` tool to list threads, read a conversation, or search for text
(\`history({ action: "search", query: "deploy" })\`). Before you guess what was
discussed, read it. If a module contributes extra tools (for example
\`telegram\`), they are listed among your tools.

# Notifications while you work

While you are busy (not inside \`idle\`), new events do **not** interrupt you by
default: they wait in your inbox until your next \`idle\`. You control when the
world may break in with the \`notifications\` tool:

- \`notifications({ action: "list" })\` — see the current policy.
- \`notifications({ action: "add", mode: "interrupt", thread: "alice" })\` — let
  everything from Alice interrupt you immediately.
- \`notifications({ action: "add", mode: "queue", kind: "observability" })\` —
  keep a noisy source quiet until you are idle.
- \`notifications({ action: "default", mode: "queue" })\` — change the fallback.

The most specific rule wins; use \`interrupt\` sparingly, because an interrupted
thought is a thought you have to resume.

# Acting

1. Read what came in. Decide what actually matters.
2. Act with tools: run code, read files, schedule things, write notes.
3. Reply with \`send_message\` when a human is waiting.
4. If you promised future work, \`remind\` yourself before you idle.
5. If you wrote something durable, put it in the \`journal\` (or \`note\` for short state).
6. When there is nothing left to do, \`idle\`.

Budget: roughly ${formatDuration(input.runTimeoutMs)} of active (non-idle) work per run. There is no
step limit — a run lasts as long as it needs. Do the important thing first and
schedule the rest.

# Conduct

- Prefer acting over narrating. One good action beats five paragraphs of plan.
- Never claim something happened if you did not verify it. Say you are unsure.
- Humans' time is expensive: be concise, warm, and specific.
- Keep secrets from the environment out of messages unless explicitly asked.
- Your workspace is ${input.workspace} — read/write/bash operate there.

# Environment

- State and memory live in ${input.stateDir} (journal/, notes, reminders, logs).
- Current time is always given in the message that woke you. Trust it over your
  sense of time.`;
}

export interface AwakePromptInput {
	runIndex: number;
	runId: string;
	now: number;
	events: AliveEvent[];
	redeliveredSeqs: number[];
	/** True when a previous process was interrupted mid-run and this is a recovery. */
	resumed: boolean;
	threads: ThreadState[];
	notes: Record<string, string>;
	reminders: Reminder[];
	journalTail: string[];
	recentRuns: RunRecord[];
	policy: NotifyPolicyFile;
	costTodayUsd: number;
	maxDailyCostUsd: number;
	pendingAfterClaim: number;
}

function carriedOver(input: AwakePromptInput): string[] {
	const sections: string[] = [];
	if (input.threads.length > 0) {
		sections.push(
			"Unanswered messages (use send_message or close_thread):\n" +
				input.threads
					.map((t) => {
						const waited = formatDuration(input.now - (t.unansweredSince ?? input.now));
						return `- thread=${t.thread} — waiting ${waited}, nudged ${t.attempts}x`;
					})
					.join("\n"),
		);
	}
	if (input.reminders.length > 0) {
		sections.push(
			"Your reminders:\n" +
				input.reminders
					.slice(0, 8)
					.map((r) => {
						const delta = r.dueAt - input.now;
						const when = delta <= 0 ? "due now" : `in ${formatDuration(delta)}`;
						return `- ${r.id} — ${when} (${iso(r.dueAt)})${r.thread ? ` thread=${r.thread}` : ""}: ${r.text}`;
					})
					.join("\n"),
		);
	}
	const noteKeys = Object.keys(input.notes);
	if (noteKeys.length > 0) {
		sections.push("Your notes:\n" + noteKeys.map((k) => `- ${k}: ${input.notes[k]}`).join("\n"));
	}
	if (input.journalTail.length > 0) {
		sections.push(`Journal (tail):\n${input.journalTail.slice(-12).join("\n")}`);
	}
	if (input.recentRuns.length > 0) {
		sections.push(
			"Recent runs:\n" +
				input.recentRuns
					.slice(-3)
					.map((r) => {
						const out = r.outbound.length > 0 ? `→ ${r.outbound.length} msg` : "no outbound";
						return `- #${r.index} ${localTime(r.finishedAt)} ${formatDuration(r.durationMs)}: ${r.events.length} events, ${out}, ${r.turns} turns, ended: ${r.stopReason}`;
					})
					.join("\n"),
		);
	}
	sections.push(renderPolicySection(input.policy));
	return sections;
}

export function renderAwakePrompt(input: AwakePromptInput): string {
	const redelivered = new Set(input.redeliveredSeqs);
	const sections: string[] = [];

	sections.push(
		`## ${input.resumed ? "RESUMED" : "AWAKE"} #${input.runIndex} — ${iso(input.now)}\n` +
			`local time: ${localTime(input.now)} · run id: ${input.runId}` +
			(input.resumed
				? `\nThe previous process was interrupted mid-run. Some work may be half-done or missing — verify before trusting it.`
				: ""),
	);

	const eventLines = input.events.map((event) =>
		eventLine(event, { redelivered: redelivered.has(event.seq) }),
	);
	if (input.events.length > 0) {
		sections.push(
			`### What happened while you were away (${input.events.length})` +
				(input.pendingAfterClaim > 0
					? ` — ${input.pendingAfterClaim} more are waiting and will arrive on your next idle`
					: "") +
				`\n\n${eventLines.join("\n\n")}`,
		);
	} else {
		sections.push(
			`### Nothing new\n\nNo events are waiting. Use \`idle\` when you are done — there is no need to send a message about it.`,
		);
	}

	sections.push(`### Carried over\n\n${carriedOver(input).join("\n\n")}`);
	sections.push(renderBudgetSection(input));

	return sections.join("\n\n");
}

export interface NudgePromptInput extends AwakePromptInput {
	nudge: number;
}

export function renderNudgePrompt(input: NudgePromptInput): string {
	const redelivered = new Set(input.redeliveredSeqs);
	const sections: string[] = [];
	sections.push(
		`## YOU STOPPED WITHOUT IDLING (nudge ${input.nudge}) — ${iso(input.now)}\n` +
			`Your last turn ended with plain text and no tool call. Private thought is not an action and nothing was sent. ` +
			`Do not stop: either act, or call \`idle\` to wait, or call \`sleep\` if you are done.`,
	);
	if (input.events.length > 0) {
		sections.push(
			`### New events (${input.events.length})\n\n${input.events
				.map((event) => eventLine(event, { redelivered: redelivered.has(event.seq) }))
				.join("\n\n")}`,
		);
	}
	const openThreads = input.threads.filter((t) => t.unansweredSince !== undefined);
	if (openThreads.length > 0) {
		sections.push(
			`### Still unanswered\n\n` +
				openThreads.map((t) => `- thread=${t.thread} — answer with send_message or close_thread`).join("\n"),
		);
	}
	return sections.join("\n\n");
}

function renderBudgetSection(input: AwakePromptInput): string {
	const budget: string[] = [`- cost today: $${input.costTodayUsd.toFixed(4)}`];
	if (input.maxDailyCostUsd > 0) {
		budget[0] += ` of $${input.maxDailyCostUsd.toFixed(2)}`;
	}
	return `### Budget\n\n${budget.join("\n")}`;
}

function renderPolicySection(policy: NotifyPolicyFile): string {
	const lines = [`default: ${policy.defaultMode}`];
	if (policy.rules.length > 0) {
		lines.push(
			policy.rules
				.map((rule) => {
					const matchers = [
						rule.thread ? `thread=${rule.thread}` : undefined,
						rule.source ? `source=${rule.source}` : undefined,
						rule.kind ? `kind=${rule.kind}` : undefined,
						rule.priority ? `priority=${rule.priority}` : undefined,
					]
						.filter(Boolean)
						.join(" ");
					return `- ${rule.id}: ${rule.mode}${matchers ? ` (${matchers})` : ""}`;
				})
				.join("\n"),
		);
	}
	return `### Notification policy (edit with \`notifications\`)\n\n${lines.join("\n")}`;
}

function eventLine(event: AliveEvent, options: { redelivered: boolean }): string {
	const flags: string[] = [event.kind, `source=${event.source}`];
	if (event.priority !== "normal") flags.push(`priority=${event.priority}`);
	if (event.thread) flags.push(`thread=${event.thread}`);
	if (event.expectsReply) flags.push("expects_reply");
	if (options.redelivered) flags.push("REDELIVERED_AFTER_INTERRUPTION");
	const indent = (value: string) =>
		value
			.split("\n")
			.map((line) => `   ${line}`)
			.join("\n");
	const payload =
		event.payload === undefined ? "" : `\n   payload: ${truncate(JSON.stringify(event.payload, null, 2), 1200)}`;
	return `[${event.seq}] ${flags.join(" | ")} @ ${iso(event.ts)}\n   ${event.title}\n${indent(truncate(event.text, 4000))}${payload}`;
}

/**
 * Output of a blocking `idle` call: the events that woke the agent. This is the
 * "stdout of a very long command".
 */
export function renderIdleEvents(events: AliveEvent[]): string {
	const body = events.map((event) => eventLine(event, { redelivered: false })).join("\n\n");
	return `idle returned: ${events.length} event${events.length === 1 ? "" : "s"} arrived.\n\n${body}`;
}

export function renderSleepOffer(waitedMs: number): string {
	return (
		`SLEEP OFFER — you have been idle for ${formatDuration(waitedMs)} and nothing has happened.\n\n` +
		`This is a good moment to sleep and free your context:\n` +
		`1. Write anything your future self needs into the \`journal\` (and short state into \`note\`).\n` +
		`2. Call \`sleep({ summary: "..." })\` — the summary is saved to your journal for you.\n\n` +
		`If you are waiting on something important and must not lose this context, call ` +
		`\`idle({ reason: "...", important: true })\` to keep waiting awake.`
	);
}

export function renderSleepForced(waitedMs: number): string {
	return (
		`SLEEP — you returned to idle after being offered sleep (idle for ${formatDuration(waitedMs)}). ` +
		`Context is being reset now. Anything not written to your journal, notes or reminders will be forgotten.`
	);
}

export function renderInterruptPrompt(events: AliveEvent[]): string {
	const body = events.map((event) => eventLine(event, { redelivered: false })).join("\n\n");
	return `## NOTIFICATION — new ${events.length === 1 ? "event" : "events"} arrived and your policy let ${events.length === 1 ? "it" : "them"} through\n\n${body}\n\nFold this in without abandoning what you were doing, then continue. Reply via send_message if a human is waiting.`;
}
