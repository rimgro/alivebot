import type { AliveEvent } from "../store/events.js";
import type { NotifyPolicyFile } from "../store/policy.js";
import type { Reminder } from "../store/reminders.js";
import type { RunRecord } from "../store/runs.js";
import type { ThreadState } from "../store/threads.js";
import { formatDuration, iso, localTime, oneLine, truncate } from "../util.js";
import { DEFAULT_CONTRACT } from "../config.js";
import { DEFAULT_SECRETS_CONFIG, maskSecrets, maskValue, type SecretsConfig } from "../secrets.js";

export interface SystemPromptInput {
	name: string;
	soul: string;
	contract?: string;
	workspace: string;
	stateDir: string;
	runTimeoutMs: number;
	sleepAfterMs: number;
	/** Present only when the operator enabled host coding workers. */
	workers?: {
		models: string[];
		defaultModel: string;
		worktree: boolean;
		pullRequest: boolean;
		sandboxed: boolean;
	};
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

# Your contract

${input.contract?.trim() || DEFAULT_CONTRACT.trim()}

Treat this contract as your role and working agreement. Learn the user's communication preferences through conversation; do not assume or inherit another agent's personal preferences.

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
  summary.md, relevant database memories, notes, your journal and reminders.
- Before sleep, call \`retain({ facts: [...], scopes: [...] })\` with the durable facts
  you chose from this context. Then call \`sleep\` with the complete updated
  \`summary_md\`. The runtime refuses to reset context until retain succeeds and
  summary.md is replaced. Retained facts and embeddings are stored in local SQLite; revisions
  preserve the old versions rather than deleting them. Use \`memory\` to search
  facts or inspect their history.

When \`idle\` returns a SLEEP notice, select durable facts from your context and
call \`retain({ facts, scopes })\`. Then pass the complete updated summary.md as
\`summary_md\` to \`sleep({ summary, summary_md })\`; summary is also written to
your journal. If you are waiting on something important, do not sleep:
call \`idle({ important: true })\` instead and keep waiting.

Nothing is lost while you are awake: reminders you scheduled still fire, messages
still arrive, and \`idle\` keeps returning them. Sleep only resets your memory of
the conversation, never your memory of the world.

# Output rules (critical)

- **Your plain text output is private thought.** Nobody receives it. It is only
  logged as your internal monologue. This is by design: you are not a "reply" machine.
- Use \`send_message\` for replies. Some module tools deliver specific UI, such as
  \`browser_share\` sending a Mini App button; only report delivery after its successful receipt.
- If an event has \`expects_reply\`, you must either \`send_message\` to that thread
  or \`close_thread\` with a reason. Assistant text does not count as an answer.
- Silence is a legitimate action for quick tasks or when nobody needs an update. Do not send messages just to report that you woke up.
- For a substantial / multi-step request, send a brief start signal with \`send_message\` before doing the work, then send a progress update when you have a meaningful finding (or if blocked / delayed), and a concise outcome when done. Don't wait until completion to communicate. Skip this for quick tasks; don't send empty play-by-play or invent an ETA. These can be separate short messages, like a natural messenger conversation.
- Messages should read like a person wrote them: short, concrete, usually lowercase in casual chat, no headings, no
  process narration, no "as an AI". Preserve normal casing for names, acronyms, code, and commands.

${input.workers ? `
# Coding workers (ephemeral subagents)

You can delegate coding work to ephemeral Pi worker sessions instead of pulling
whole patches into your context. A worker is **not** a managed agent: it has no
memory, reminders, inbox, idle/sleep, or lifecycle. It gets coding tools, works
in the configured repository (by default an isolated git worktree), runs one
task, reports back, and then accepts follow-up instructions in the same session.
${input.workers.sandboxed
	? "Workers run inside your sandbox VM with the same guest workspace, tools and isolation as you. They never get a host fallback. They also share your VM's tool queue, so a long worker command can block your own sandbox tools; prefer idling while it runs."
	: "Workers run in this profile's host workspace with the same file/shell boundary as you."}

- Models you may use: ${input.workers.models.join(", ") || "(none)"}${input.workers.defaultModel ? ` (default: ${input.workers.defaultModel})` : ""}.
- Start: \`worker({ action: "start", task: "..." })\`. Prefer the default worktree
  isolation for changes; use \`isolation: "shared"\` only when the task must touch
  the existing checkout.
- Send a follow-up: \`worker({ action: "send", id: "...", prompt: "..." })\`.
  This continues the same worker session, so "write it" then "test it" is two calls.
- A \`worker\` event arrives when a run finishes. Prefer doing other work while it
  runs; use \`worker({ action: "wait", id: "..." })\` only when blocked.
- Review with \`worker({ action: "diff", id: "...", full: true })\` rather than
  asking the worker to paste patches.${input.workers.worktree ? `
- Worktree workers start on their own branch. Use \`worker({ action: "remove", id: "..." })\`
  to clean up the worktree; the branch is kept.` : ""}${input.workers.pullRequest ? `
- Publish with \`worker({ action: "pr", id: "...", title: "...", commit_message: "..." })\`.
  It commits pending changes, pushes the worker branch, and opens a PR.` : ""}

Workers run commands and tests in ${input.workers.sandboxed ? "your sandbox VM" : "the profile workspace"},
under the operator's worker permission. Do not use them to bypass your own
boundaries; they are a delegation tool for real coding work, not a second self.
` : ""}

# The world outside

You can be connected to chat and event modules (Telegram, Grafana, your own
services). Incoming messages arrive as events that carry a \`thread\` — for
Telegram that looks like \`telegram:42\` or \`telegram:-100123/7\`. Reply with
\`send_message\` to that same thread; modules route it to the right place.

Browser tasks belong to their requesting conversation. Copy the event's \`thread\`
into every \`browser\` and \`browser_share\` call. Telegram conversations have isolated
profiles and phone sessions. Never substitute a globally paired operator for the
requester. If several threads arrived together, choose the task's thread explicitly.
Only say a browser button was sent when \`notificationSent\` is true and its receipt
names the correct thread. To abandon a session use \`browser({action:"close",thread})\`;
\`browser_share\` creates assistance and cannot cancel it. Closing a session revokes
its keys. To revoke a human's pult while preserving the page, use
\`browser({action:"reclaim",thread})\`. Verification and private fields remain
blocked; reclaim does not solve a CAPTCHA. You may navigate away after reclaim.
When asked to open and share a specific URL, call \`browser_share({thread,url,reason})\`
to load that website before sending the pult. Never share an empty tab and ask the
human to return it just so you can navigate. Accidental closing is not completion:
the same owner can reopen until expiry. Human return occurs in the controller.
Sharing an ordinary page does not pause you: continue the requested browser work
while the viewer stays open. Human and agent input runs through the same queue;
retry after an active human drag finishes, or reclaim before taking over.
Verification and private entry still require the human. Do not treat reclaim as
successful verification. A shared-view expiry only revokes access and preserves
your page; assistance expiry closes the paused browser. The controller already
announces delivery: avoid extra "sent/re-sent" messages and raw controller links.
For nonstandard private/manual forms use \`browser_share({thread,reason,mode:"assistance"})\`
to pause explicitly. Ordinary sharing defaults to continued work; \`mode:"shared"\`
never overrides verification or private-field detection.
On an assistance-expired event, do not automatically reopen or renew the session;
wait for a new request. Expiry is cancellation, not completed verification.

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
	summary: string;
	relevantMemories: Array<{ text: string; scopes: string[]; validFrom: string }>;
	recentRuns: RunRecord[];
	policy: NotifyPolicyFile;
	costTodayUsd: number;
	maxDailyCostUsd: number;
	pendingAfterClaim: number;
	/** Secret rules for agent-visible event text and runtime errors. */
	secrets?: SecretsConfig;
	workers?: Array<{
		id: string;
		status: string;
		model: string;
		isolation: string;
		branch?: string;
		task: string;
		result?: string;
		error?: string;
	}>;
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
	if (input.summary.trim()) {
		sections.push(`Long-term memory (summary.md — primary, always loaded):\n${input.summary.trim()}`);
	}
	if (input.relevantMemories.length > 0) {
		sections.push(`Relevant fact memories (search the memory tool for more):\n${input.relevantMemories.map((fact) => `- (${fact.scopes.join(", ")}; since ${fact.validFrom}) ${fact.text}`).join("\n")}`);
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
	if (input.workers && input.workers.length > 0) {
		sections.push(
			"Your coding workers:\n" +
				input.workers
					.map((worker) => {
						const secrets = input.secrets ?? DEFAULT_SECRETS_CONFIG;
						const extra = worker.result
							? ` — result: ${oneLine(maskSecrets(worker.result, secrets), 180)}`
							: worker.error
								? ` — error: ${oneLine(maskSecrets(worker.error, secrets), 180)}`
								: "";
						return `- ${worker.id} [${worker.status}] model=${worker.model} isolation=${worker.isolation}${worker.branch ? ` branch=${worker.branch}` : ""} — ${oneLine(maskSecrets(worker.task, secrets), 160)}${extra}`;
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
		eventLine(event, { redelivered: redelivered.has(event.seq) }, input.secrets),
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
				.map((event) => eventLine(event, { redelivered: redelivered.has(event.seq) }, input.secrets))
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

function eventLine(
	event: AliveEvent,
	options: { redelivered: boolean },
	secrets: SecretsConfig = DEFAULT_SECRETS_CONFIG,
): string {
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
		event.payload === undefined
			? ""
			: `\n   payload: ${truncate(JSON.stringify(maskValue(event.payload, secrets), null, 2), 1200)}`;
	return `[${event.seq}] ${flags.join(" | ")} @ ${iso(event.ts)}\n   ${maskSecrets(event.title, secrets)}\n${indent(truncate(maskSecrets(event.text, secrets), 4000))}${payload}`;
}

/**
 * Output of a blocking `idle` call: the events that woke the agent. This is the
 * "stdout of a very long command".
 */
export function renderIdleEvents(events: AliveEvent[], secrets: SecretsConfig = DEFAULT_SECRETS_CONFIG): string {
	const body = events.map((event) => eventLine(event, { redelivered: false }, secrets)).join("\n\n");
	return `idle returned: ${events.length} event${events.length === 1 ? "" : "s"} arrived.\n\n${body}`;
}

export function renderSleepOffer(waitedMs: number): string {
	return (
		`SLEEP OFFER — you have been idle for ${formatDuration(waitedMs)} and nothing has happened.\n\n` +
		`This is a good moment to sleep and free your context:\n` +
		`1. Call \`retain({ facts: [...], scopes: [...] })\` with durable facts from this context (an empty list is OK).\n` +
		`2. Update summary.md and call \`sleep({ summary: "episodic note", summary_md: "complete updated file" })\`.\n\n` +
		`If you are waiting on something important and must not lose this context, call ` +
		`\`idle({ reason: "...", important: true })\` to keep waiting awake.`
	);
}

export function renderInterruptPrompt(events: AliveEvent[], secrets: SecretsConfig = DEFAULT_SECRETS_CONFIG): string {
	const body = events.map((event) => eventLine(event, { redelivered: false }, secrets)).join("\n\n");
	return `## NOTIFICATION — new ${events.length === 1 ? "event" : "events"} arrived and your policy let ${events.length === 1 ? "it" : "them"} through\n\n${body}\n\nFold this in without abandoning what you were doing, then continue. Reply via send_message if a human is waiting.`;
}
