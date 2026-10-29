/**
 * Inline HTML rendering for the read-only dashboard.
 *
 * There is no build step and no client JavaScript: every page is a template
 * string with plain CSS. Every value that reaches the page goes through
 * `Masker.text()`, which applies the existing secret masking
 * (`src/secrets.ts`) and then HTML-escapes it. The finished document is masked
 * once more as a safety net, so a forgotten interpolation cannot leak a token.
 */
import { createMaskContext, maskSecrets, type MaskContext, type SecretsConfig } from "../secrets.js";
import { formatDuration, oneLine } from "../util.js";
import {
	formatCost,
	formatTimestamp,
	type AgentDetail,
	type AgentStatus,
	type AgentSummary,
	type RunDetail,
	type RunView,
	type SessionTurn,
	type TimelineItem,
	type ToolCallView,
} from "./state.js";

export interface RenderContext {
	secrets: SecretsConfig;
	env: NodeJS.ProcessEnv;
	now: number;
}

class Masker {
	private readonly context: MaskContext = createMaskContext();

	constructor(
		private readonly secrets: SecretsConfig,
		private readonly env: NodeJS.ProcessEnv,
	) {}

	/** Mask first (so detectors see the raw token format), then escape for HTML. */
	text(value: unknown): string {
		const raw = value === undefined || value === null
			? ""
			: typeof value === "string"
				? value
				: String(value);
		return escapeHtml(maskSecrets(raw, this.secrets, this.env, this.context));
	}

	num(value: number): string {
		return this.text(Number.isFinite(value) ? value.toLocaleString("en-US") : "0");
	}

	json(value: unknown): string {
		try {
			return this.text(JSON.stringify(value, null, 2));
		} catch {
			return this.text("[unserializable]");
		}
	}

	/** Final safety net: no raw secret survives anywhere in the document. */
	finish(html: string): string {
		return maskSecrets(html, this.secrets, this.env, this.context);
	}
}

export function escapeHtml(value: string): string {
	return value
		.replace(/&/g, "&amp;")
		.replace(/</g, "&lt;")
		.replace(/>/g, "&gt;")
		.replace(/"/g, "&quot;")
		.replace(/'/g, "&#39;");
}

const CSS = `
:root {
  color-scheme: dark;
  --bg: #0c0c0b;
  --panel: #111110;
  --text: #d8d4cb;
  --muted: #89857c;
  --line: #24231f;
  --link: #d9c9a3;
  --working: #d3a552;
  --waiting: #9b988f;
  --sleeping: #6e6b64;
  --error: #d08080;
  --sleep: #a8a08a;
  --mono: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
}
* { box-sizing: border-box; }
html, body { margin: 0; padding: 0; }
body {
  background: var(--bg);
  color: var(--text);
  font: 14px/1.5 system-ui, -apple-system, "Segoe UI", sans-serif;
}
a { color: var(--link); text-decoration: underline; text-underline-offset: 2px; }
a:hover { color: #f2ead6; }
header {
  border-bottom: 1px solid var(--line);
  padding: 14px 22px;
  display: flex;
  align-items: baseline;
  gap: 14px;
  flex-wrap: wrap;
}
header .brand { font-weight: 600; letter-spacing: .04em; }
header nav { color: var(--muted); font-size: 13px; }
header .tag {
  margin-left: auto;
  color: var(--muted);
  font-size: 12px;
  border: 1px solid var(--line);
  padding: 2px 8px;
}
main { max-width: 1080px; margin: 0 auto; padding: 26px 22px 60px; }
h1 { font-size: 20px; font-weight: 600; margin: 0 0 4px; }
h2 { font-size: 13px; font-weight: 600; text-transform: uppercase; letter-spacing: .08em; color: var(--muted); margin: 34px 0 10px; }
h3 { font-size: 13px; font-weight: 600; margin: 22px 0 6px; }
p { margin: 0 0 10px; }
.sub { color: var(--muted); font-size: 12px; }
.note { color: var(--muted); font-size: 12px; border-left: 1px solid var(--line); padding-left: 10px; }
.empty { color: var(--muted); font-style: italic; }
table { width: 100%; border-collapse: collapse; margin: 0 0 14px; }
th, td { text-align: left; padding: 7px 10px 7px 0; vertical-align: top; border-bottom: 1px solid var(--line); }
thead th { font-size: 11px; text-transform: uppercase; letter-spacing: .08em; color: var(--muted); font-weight: 600; border-bottom-color: #33312b; }
td.num, th.num { text-align: right; font-family: var(--mono); }
table.kv th { color: var(--muted); font-weight: 500; white-space: nowrap; width: 1%; padding-right: 12px; }
table.kv td { padding-right: 22px; }
table.mini { margin: 8px 0 0; }
table.mini th, table.mini td { padding: 3px 10px 3px 0; font-size: 12px; border-bottom: none; }
table.mini th { color: var(--muted); font-weight: 500; white-space: nowrap; }
.mono { font-family: var(--mono); }
.st { font-size: 12px; border: 1px solid currentColor; padding: 1px 7px; }
.st.working { color: var(--working); }
.st.waiting { color: var(--waiting); }
.st.sleeping { color: var(--sleeping); }
.outcome.sleep { color: var(--sleep); }
.outcome.idle { color: var(--waiting); }
.outcome.error { color: var(--error); }
.badge { font-family: var(--mono); font-size: 11px; color: var(--muted); border: 1px solid var(--line); padding: 1px 6px; }
.feed { list-style: none; margin: 0; padding: 0 0 0 16px; border-left: 1px solid var(--line); }
.feed > li { position: relative; padding: 0 0 20px 16px; }
.feed > li::before {
  content: "";
  position: absolute;
  left: -20px;
  top: 7px;
  width: 6px;
  height: 6px;
  border: 1px solid #5a564c;
  background: var(--bg);
  border-radius: 50%;
}
.feed .feed-head { display: flex; gap: 10px; align-items: baseline; flex-wrap: wrap; }
.feed time { color: var(--muted); font-family: var(--mono); font-size: 11px; }
.feed .feed-title { margin: 3px 0 2px; }
.feed .feed-detail { color: var(--muted); font-size: 12px; margin: 0; }
pre { font-family: var(--mono); font-size: 12px; line-height: 1.55; background: var(--panel); border: 1px solid var(--line); padding: 14px; overflow-x: auto; white-space: pre-wrap; word-break: break-word; margin: 0 0 14px; }
pre.prompt { max-height: 70vh; overflow-y: auto; }
details { border: 1px solid var(--line); padding: 10px 14px; margin: 0 0 14px; background: var(--panel); }
details > summary { cursor: pointer; color: var(--muted); font-size: 12px; }
ul.errors { margin: 0 0 14px; padding-left: 18px; }
ul.errors li { color: var(--error); font-family: var(--mono); font-size: 12px; margin-bottom: 4px; }
footer { border-top: 1px solid var(--line); color: var(--muted); font-size: 11px; padding: 14px 22px; }
code { font-family: var(--mono); font-size: 12px; }
`;

function layout(masker: Masker, title: string, body: string, nav: string[] = []): string {
	const navHtml = nav.length > 0 ? `<nav>${nav.join(" / ")}</nav>` : "";
	return masker.finish(`<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="color-scheme" content="dark">
<title>${masker.text(title)} · alive</title>
<style>${CSS}</style>
</head>
<body>
<header>
<span class="brand">alive</span>
${navHtml}
<span class="tag">read-only · 127.0.0.1</span>
</header>
<main>
${body}
</main>
<footer>read-only snapshot of on-disk agent state — no actions are exposed, every route is a GET.</footer>
</body>
</html>`);
}

function statusLabel(status: AgentStatus): string {
	return status;
}

/** Ids come from disk, so they go through masking and escaping like every other string. */
function agentHref(id: string, masker: Masker): string {
	return `/agent/${masker.text(encodeURIComponent(id))}`;
}

function renderStatus(summary: AgentSummary, masker: Masker): string {
	return `<span class="st ${summary.status}">${masker.text(statusLabel(summary.status))}</span>` +
		(summary.statusNote ? ` <span class="sub">${masker.text(summary.statusNote)}</span>` : "");
}

function renderRunFacts(run: RunView, masker: Masker): string {
	return `<table class="mini">
<tr><th>duration</th><td class="mono">${masker.text(formatDuration(run.durationMs))}</td><th>active</th><td class="mono">${masker.text(formatDuration(run.activeMs))}</td><th>idle</th><td class="mono">${masker.text(formatDuration(run.idleMs))}</td></tr>
<tr><th>tokens</th><td colspan="5" class="mono">in ${masker.num(run.usage.input)} · out ${masker.num(run.usage.output)} · cacheRead ${masker.num(run.usage.cacheRead)} · cacheWrite ${masker.num(run.usage.cacheWrite)}</td></tr>
<tr><th>cost</th><td class="mono">${masker.text(formatCost(run.usage.cost))}</td><th>turns</th><td class="mono">${masker.num(run.turns)}</td><th>result</th><td class="outcome ${run.outcome.key}">${masker.text(run.outcome.label)}</td></tr>
</table>`;
}

function renderTimeline(items: TimelineItem[], masker: Masker): string {
	if (items.length === 0) return `<p class="empty">No runs, sleeps, reminders or key events recorded yet.</p>`;
	const rows = items.map((item) => {
		const when = `<time datetime="${masker.text(Number.isFinite(item.at) ? new Date(item.at).toISOString() : "")}">${masker.text(formatTimestamp(item.at))}</time>`;
		const badge = `<span class="badge">${masker.text(item.badge)}</span>`;
		const link = item.href ? ` <a href="${masker.text(item.href)}">run details</a>` : "";
		const detail = item.detail ? `<p class="feed-detail">${masker.text(item.detail)}</p>` : "";
		const facts = item.kind === "run" && item.run ? renderRunFacts(item.run, masker) : "";
		return `<li class="feed-item ${item.kind}">
<div class="feed-head">${when}${badge}${link}</div>
<div class="feed-title">${masker.text(item.title)}</div>
${detail}${facts}
</li>`;
	});
	return `<ol class="feed">\n${rows.join("\n")}\n</ol>`;
}

export function renderIndexPage(agents: AgentSummary[], context: RenderContext): string {
	const masker = new Masker(context.secrets, context.env);
	const rows = agents.map((agent) => `<tr>
<td><a href="${agentHref(agent.id, masker)}">${masker.text(agent.name)}</a><div class="sub mono">${masker.text(agent.id)}</div></td>
<td>${renderStatus(agent, masker)}</td>
<td class="mono">${masker.text(agent.model)}</td>
<td>${masker.text(agent.currentRun)}</td>
<td class="num">${masker.text(formatCost(agent.spendTodayUsd))}<div class="sub">${masker.num(agent.runsToday)} runs</div></td>
</tr>`);
	const body = `<h1>agents</h1>
<p class="sub">${masker.num(agents.length)} profile${agents.length === 1 ? "" : "s"} · spend today from usage.json, falling back to today's run records</p>
<table>
<thead><tr><th>agent</th><th>status</th><th>model</th><th>current run</th><th class="num">spend today</th></tr></thead>
<tbody>
${rows.join("\n")}
</tbody>
</table>`;
	return layout(masker, "agents", body);
}

export function renderAgentPage(detail: AgentDetail, context: RenderContext): string {
	const masker = new Masker(context.secrets, context.env);
	const { summary } = detail;
	const pending = detail.reminders.filter((reminder) => reminder.state === "pending");
	const reminderRows = pending.map((reminder) => `<tr>
<td class="mono">${masker.text(formatTimestamp(reminder.dueAt))}</td>
<td>${masker.text(reminder.text)}</td>
<td class="mono">${masker.text(reminder.id)}</td>
</tr>`).join("\n");
	const body = `<h1>${masker.text(summary.name)}</h1>
<p class="sub mono">${masker.text(summary.id)} · ${masker.text(summary.stateDir)}</p>

<h2>status</h2>
<table class="kv">
<tr><th>status</th><td>${renderStatus(summary, masker)}</td><th>model</th><td class="mono">${masker.text(summary.model)}</td></tr>
<tr><th>current run</th><td>${masker.text(summary.currentRun)}</td><th>spend today</th><td class="mono">${masker.text(formatCost(summary.spendTodayUsd))}</td></tr>
<tr><th>runs recorded</th><td class="mono">${masker.num(detail.totals.runs)}</td><th>lifetime cost</th><td class="mono">${masker.text(formatCost(detail.totals.cost))}</td></tr>
<tr><th>pid</th><td class="mono">${summary.pid === undefined ? "—" : masker.num(summary.pid)}</td><th>config</th><td class="mono">${masker.text(summary.configPath)}</td></tr>
</table>

<h2>timeline (newest first)</h2>
<p class="note">key events are inbox events with high/interrupt priority, or runtime system/worker events; normal chat messages appear as run triggers</p>
${renderTimeline(detail.timeline, masker)}

<h2>pending reminders</h2>
${pending.length === 0 ? `<p class="empty">No pending reminders.</p>` : `<table>
<thead><tr><th>due</th><th>text</th><th>id</th></tr></thead>
<tbody>
${reminderRows}
</tbody>
</table>`}`;
	return layout(masker, summary.name, body, [
		`<a href="/">agents</a>`,
		`<span class="mono">${masker.text(summary.id)}</span>`,
	]);
}

function renderToolCalls(calls: ToolCallView[], masker: Masker): string {
	if (calls.length === 0) return `<p class="empty">No tool calls recorded in this run's session transcript.</p>`;
	const rows = calls.map((call, index) => `<tr>
<td class="mono">${masker.num(index + 1)}</td>
<td class="mono">${masker.text(call.name)}</td>
<td class="mono sub">${masker.text(oneLine(call.args, 200))}</td>
<td class="mono">${call.durationMs === undefined ? "—" : masker.text(formatDuration(call.durationMs))}</td>
<td class="${call.isError ? "outcome error" : "mono"}">${masker.text(call.pending ? "(no result recorded)" : oneLine(call.result, 240) || "(empty result)")}</td>
</tr>`);
	return `<table>
<thead><tr><th>#</th><th>tool</th><th>arguments</th><th>duration</th><th>result</th></tr></thead>
<tbody>
${rows.join("\n")}
</tbody>
</table>`;
}

function renderTurn(turn: SessionTurn, masker: Masker): string {
	const calls = turn.toolCalls?.length
		? `\n${turn.toolCalls.map((call) => `→ ${call.name} ${oneLine(call.args, 400)}`).join("\n")}`
		: "";
	const body = [
		turn.text,
		turn.thinking ? `[thinking]\n${turn.thinking}` : "",
		turn.errorMessage ? `[error] ${turn.errorMessage}` : "",
		calls,
	].filter(Boolean).join("\n").trim();
	return `<h3>${masker.text(turn.role)} @ ${masker.text(formatTimestamp(turn.at))}</h3>
<pre>${masker.text(body || "(no text content)")}</pre>`;
}

export function renderRunPage(detail: RunDetail, context: RenderContext): string {
	const masker = new Masker(context.secrets, context.env);
	const { run } = detail;
	const triggerRows = run.triggers.length > 0
		? run.triggers.map((trigger) => `<tr>
<td class="mono">${masker.num(trigger.seq)}</td>
<td>${masker.text(trigger.kind)}</td>
<td class="mono">${masker.text(trigger.thread ?? "—")}</td>
<td>${masker.text(trigger.title)}${trigger.redelivered ? ` <span class="sub">(redelivered)</span>` : ""}</td>
</tr>`).join("\n")
		: `<tr><td colspan="4" class="sub">No events started this run.</td></tr>`;
	const errors = detail.errors.length > 0
		? `<ul class="errors">${detail.errors.map((error) => `<li>${masker.text(error)}</li>`).join("")}</ul>`
		: `<p class="empty">No errors recorded.</p>`;
	const promptTurns = detail.promptTurns.length > 0
		? detail.promptTurns.map((turn, index) => `<h3>prompt ${masker.num(index + 1)} · ${masker.text(formatTimestamp(turn.at))}</h3>
<pre class="prompt">${masker.text(turn.text || "(empty)")}</pre>`).join("\n")
		: `<p class="empty">${masker.text(detail.promptAvailable ? "No prompt text available." : "The prompt text for this run is not available on disk.")}</p>`;
	const notes = detail.notes.map((note) => `<p class="note">${masker.text(note)}</p>`).join("");
	const sessionFiles = detail.sessionFiles.length > 0
		? `<p class="sub mono">session: ${detail.sessionFiles.map((file) => masker.text(file)).join(", ")}</p>`
		: "";
	const transcript = detail.transcript.length > 0
		? `<details>
<summary>full session transcript in this run's time window (${masker.num(detail.transcript.length)} messages)</summary>
${detail.transcript.map((turn) => renderTurn(turn, masker)).join("\n")}
</details>`
		: `<p class="empty">No session transcript found for this run's time window.</p>`;

	const body = `<h1>run #${masker.num(run.index)}</h1>
<p class="sub"><a href="${agentHref(detail.agent.id, masker)}">${masker.text(detail.agent.name)}</a> ·
run ${masker.text(run.id)} · ${masker.text(formatTimestamp(run.startedAt))} → ${masker.text(formatTimestamp(run.finishedAt))} ·
<span class="outcome ${run.outcome.key}">${masker.text(run.outcome.label)}</span></p>

<h2>totals</h2>
<table class="kv">
<tr><th>duration</th><td class="mono">${masker.text(formatDuration(run.durationMs))}</td><th>active</th><td class="mono">${masker.text(formatDuration(run.activeMs))}</td><th>idle</th><td class="mono">${masker.text(formatDuration(run.idleMs))}</td></tr>
<tr><th>tokens</th><td class="mono" colspan="5">input ${masker.num(run.usage.input)} · output ${masker.num(run.usage.output)} · cacheRead ${masker.num(run.usage.cacheRead)} · cacheWrite ${masker.num(run.usage.cacheWrite)} · total ${masker.num(run.usage.total)}</td></tr>
<tr><th>cost</th><td class="mono">${masker.text(formatCost(run.usage.cost))}</td><th>turns</th><td class="mono">${masker.num(run.turns)}</td><th>prompt chars</th><td class="mono">${masker.num(run.promptChars)}</td></tr>
<tr><th>nudges</th><td class="mono">${masker.num(run.nudges)}</td><th>idle returns</th><td class="mono">${masker.num(run.idleReturns)}</td><th>interrupts</th><td class="mono">${masker.num(run.interruptDeliveries)}</td></tr>
<tr><th>outbound</th><td class="mono">${masker.num(run.outboundCount)}</td><th>reminders created</th><td class="mono">${masker.num(run.remindersCreated.length)}</td><th>journal entries</th><td class="mono">${masker.num(run.journalEntries)}</td></tr>
${run.sleep ? `<tr><th>sleep</th><td class="mono" colspan="5">${masker.text(run.sleep.forced ? "forced by the runtime" : "requested by the agent")} · summary ${masker.num(run.sleep.summaryChars)} chars</td></tr>` : ""}
</table>

<h2>trigger</h2>
<table>
<thead><tr><th>seq</th><th>kind</th><th>thread</th><th>title</th></tr></thead>
<tbody>
${triggerRows}
</tbody>
</table>

<h2>tool calls</h2>
<p class="note">duration is the gap between the assistant tool-call message and its tool result in the session transcript; the result is shortened for this table</p>
${renderToolCalls(detail.toolCalls, masker)}

<h2>errors</h2>
${errors}

<h2>system prompt (reconstructed)</h2>
<p class="note">${masker.text(detail.systemPrompt.notes.join(" · "))}</p>
<pre class="prompt">${masker.text(detail.systemPrompt.text)}</pre>

<h2>turn messages</h2>
${notes}
${sessionFiles}
${promptTurns}

<h2>transcript</h2>
${transcript}`;
	return layout(masker, `run #${run.index}`, body, [
		`<a href="/">agents</a>`,
		`<a href="${agentHref(detail.agent.id, masker)}">${masker.text(detail.agent.name)}</a>`,
		`<span class="mono">run #${masker.num(run.index)}</span>`,
	]);
}

export function renderErrorPage(status: number, message: string, context: RenderContext): string {
	const masker = new Masker(context.secrets, context.env);
	const body = `<h1>${masker.num(status)}</h1>
<p>${masker.text(message)}</p>
<p><a href="/">back to agents</a></p>`;
	return layout(masker, `error ${status}`, body);
}
