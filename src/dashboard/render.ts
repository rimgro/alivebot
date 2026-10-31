/**
 * Inline HTML rendering for the dashboard.
 *
 * There is no build step and no client JavaScript: every page is a template
 * string with plain CSS (the settings page is a plain HTML form). Every value
 * that reaches a page goes through
 * `Masker.text()`, which applies the existing secret masking
 * (`src/secrets.ts`) and then HTML-escapes it. The finished document is masked
 * once more as a safety net, so a forgotten interpolation cannot leak a token.
 */
import { createMaskContext, maskSecrets, type MaskContext, type SecretsConfig } from "../secrets.js";
import { formatDuration, oneLine } from "../util.js";
import {
	MEMORY_MAX_TEXT_CHARS,
	type MemoryFactGroup,
	type MemoryFactView,
	type MemoryTextItem,
	type MemoryTextSection,
	type MemoryView,
} from "./memory.js";
import {
	TIMELINE_KINDS,
	formatCost,
	formatTimestamp,
	hasTimelineFilters,
	timelineQueryString,
	type AgentDetail,
	type AgentStatus,
	type AgentSummary,
	type RunDetail,
	type RunView,
	type SessionTurn,
	type TimelineItem,
	type TimelineKind,
	type TimelinePage,
	type TimelinePeriod,
	type TimelineQuery,
	type TimelineQueryOverrides,
	type ToolCallView,
} from "./state.js";
import type { SettingsView } from "./settings.js";

export interface RenderContext {
	secrets: SecretsConfig;
	env: NodeJS.ProcessEnv;
	now: number;
	/**
	 * Present on an authenticated render. The token is a per-render,
	 * single-use CSRF token for the header logout form; the session token
	 * itself never reaches a page.
	 */
	auth?: { logoutCsrfToken?: string };
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
.filters {
  position: sticky;
  top: 0;
  z-index: 5;
  background: var(--bg);
  border: 1px solid var(--line);
  padding: 10px 14px;
  margin: 0 0 18px;
}
.filters .filter-row { display: flex; flex-wrap: wrap; gap: 6px; align-items: baseline; margin: 0 0 6px; }
.filters .filter-label { color: var(--muted); font-size: 11px; text-transform: uppercase; letter-spacing: .08em; min-width: 62px; }
.filters .chip {
  font-family: var(--mono);
  font-size: 11px;
  color: var(--link);
  border: 1px solid var(--line);
  padding: 1px 8px;
  text-decoration: none;
}
.filters .chip.active { border-color: #5a564c; color: var(--text); background: var(--panel); }
.filters form.filter-search { display: flex; flex-wrap: wrap; gap: 8px; align-items: center; margin: 6px 0 2px; }
.filters form.filter-search input[type=text] { flex: 1; min-width: 220px; width: auto; }
.filters .filter-count { margin-left: auto; color: var(--muted); font-family: var(--mono); font-size: 12px; white-space: nowrap; }
.filters .filter-active { color: var(--muted); font-size: 12px; margin: 6px 0 0; }
.filters .filter-active .reset { margin-left: 8px; }
.feed .feed-row { display: flex; gap: 10px; align-items: baseline; }
.feed .feed-row .feed-summary { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.feed .feed-row .feed-meta { color: var(--muted); font-size: 11px; white-space: nowrap; }
.feed details.feed-full { margin: 6px 0 0; padding: 0 0 0 12px; border: none; border-left: 1px solid var(--line); background: transparent; }
.feed details.feed-full > summary { color: var(--muted); font-size: 11px; }
.feed details.feed-full .feed-detail { margin: 6px 0; }
.more { margin: 16px 0 0; }
pre { font-family: var(--mono); font-size: 12px; line-height: 1.55; background: var(--panel); border: 1px solid var(--line); padding: 14px; overflow-x: auto; white-space: pre-wrap; word-break: break-word; margin: 0 0 14px; }
pre.prompt { max-height: 70vh; overflow-y: auto; }
details { border: 1px solid var(--line); padding: 10px 14px; margin: 0 0 14px; background: var(--panel); }
details > summary { cursor: pointer; color: var(--muted); font-size: 12px; }
ul.errors { margin: 0 0 14px; padding-left: 18px; }
ul.errors li { color: var(--error); font-family: var(--mono); font-size: 12px; margin-bottom: 4px; }
footer { border-top: 1px solid var(--line); color: var(--muted); font-size: 11px; padding: 14px 22px; }
code { font-family: var(--mono); font-size: 12px; }
.memory-item { border: 1px solid var(--line); background: var(--panel); padding: 12px 14px; margin: 0 0 14px; }
.memory-item .memory-head { display: flex; gap: 10px; align-items: baseline; flex-wrap: wrap; margin-bottom: 6px; }
.memory-item .memory-title { font-weight: 600; }
.memory-item pre { margin: 8px 0 0; border: none; background: transparent; padding: 0; }
.fact.current { border-color: #3a362e; }
.fact.historical { opacity: .82; }
.fact .fact-text { white-space: pre-wrap; word-break: break-word; margin: 6px 0 8px; }
.scopes { display: flex; gap: 6px; flex-wrap: wrap; margin: 6px 0; }
.scope { font-family: var(--mono); font-size: 11px; color: var(--link); border: 1px solid var(--line); padding: 1px 6px; }
.revision { border-top: 1px solid var(--line); margin-top: 10px; padding-top: 10px; color: var(--muted); }
.revision .fact-text { color: var(--text); }
.search { border: 1px solid var(--line); background: var(--panel); padding: 10px 14px; margin: 0 0 14px; }
.search .term { font-family: var(--mono); color: var(--link); }
form.settings { border: 1px solid var(--line); background: var(--panel); padding: 14px 16px; margin: 0 0 18px; }
form.settings fieldset { border: none; margin: 0 0 18px; padding: 0; }
form.settings legend { color: var(--muted); font-size: 11px; text-transform: uppercase; letter-spacing: .08em; padding: 0 0 8px; }
label.field { display: block; margin: 0 0 14px; }
label.field .label { display: block; color: var(--muted); font-size: 12px; margin-bottom: 4px; }
label.field .path { display: block; color: var(--muted); font-family: var(--mono); font-size: 11px; margin-top: 3px; word-break: break-all; }
textarea, input[type=text] {
  width: 100%;
  background: var(--bg);
  color: var(--text);
  border: 1px solid var(--line);
  font-family: var(--mono);
  font-size: 12px;
  line-height: 1.5;
  padding: 8px 10px;
}
textarea { min-height: 140px; resize: vertical; }
textarea:disabled, input:disabled { opacity: .55; }
button {
  background: var(--bg);
  color: var(--link);
  border: 1px solid #5a564c;
  padding: 6px 18px;
  font: inherit;
  cursor: pointer;
}
button:hover { color: #f2ead6; border-color: var(--link); }
button:disabled { color: var(--muted); border-color: var(--line); cursor: not-allowed; }
.saved { border: 1px solid #3d5340; color: #a9cfa9; padding: 8px 12px; margin: 0 0 16px; }
.disabled { border: 1px solid #5a3f3f; color: var(--error); padding: 8px 12px; margin: 0 0 16px; }
header form.logout { margin: 0; }
header form.logout button { padding: 2px 10px; font-size: 12px; }
.login { max-width: 420px; margin: 8vh auto 0; }
.login form { border: 1px solid var(--line); background: var(--panel); padding: 18px; }
.login label { display: block; margin: 0 0 14px; }
.login .label { display: block; color: var(--muted); font-size: 12px; margin-bottom: 5px; }
.login input[type=password] { width: 100%; background: var(--bg); color: var(--text); border: 1px solid var(--line); font: inherit; padding: 8px 10px; }
.login .error { border: 1px solid #5a3f3f; color: var(--error); padding: 8px 12px; margin: 0 0 14px; }
`;

interface LayoutOptions {
	/** When set, the header carries a POST /logout form with this CSRF token. */
	logoutCsrfToken?: string;
}

function layout(masker: Masker, title: string, body: string, nav: string[] = [], options: LayoutOptions = {}): string {
	const navHtml = nav.length > 0 ? `<nav>${nav.join(" / ")}</nav>` : "";
	const logout = options.logoutCsrfToken
		? `<form class="logout" method="post" action="/logout"><input type="hidden" name="csrf" value="${masker.text(options.logoutCsrfToken)}"><button type="submit">log out</button></form>`
		: "";
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
${logout}
<span class="tag">127.0.0.1 · read-only unless settings</span>
</header>
<main>
${body}
</main>
<footer>read-only snapshot of on-disk agent state — the only write route is /agent/[id]/settings (loopback, CSRF-protected, backups kept).</footer>
</body>
</html>`);
}

function logoutOptions(context: RenderContext): LayoutOptions {
	return { logoutCsrfToken: context.auth?.logoutCsrfToken };
}

function statusLabel(status: AgentStatus): string {
	return status;
}

/** Ids come from disk, so they go through masking and escaping like every other string. */
function agentHref(id: string, masker: Masker): string {
	return `/agent/${masker.text(encodeURIComponent(id))}`;
}

function memoryHref(id: string, masker: Masker): string {
	return `${agentHref(id, masker)}/memory`;
}

function settingsHref(id: string, masker: Masker): string {
	return `${agentHref(id, masker)}/settings`;
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

const TIMELINE_KIND_LABELS: Record<TimelineKind, string> = {
	run: "run",
	sleep: "sleep",
	reminder: "reminder",
	event: "key event",
};

const TIMELINE_PERIOD_LABELS: Array<{ period: TimelinePeriod; label: string }> = [
	{ period: "today", label: "today" },
	{ period: "7d", label: "7d" },
	{ period: "all", label: "all" },
];

/** `/agent/<id>` plus the canonical filter query string. */
function timelineHref(
	agentId: string,
	query: TimelineQuery,
	overrides: TimelineQueryOverrides,
	masker: Masker,
): string {
	return `${agentHref(agentId, masker)}${masker.text(timelineQueryString(query, overrides))}`;
}

/**
 * The sticky filter panel: kind/period links, a plain GET search form and the
 * "shown N of M" counter. Every control is a URL, so no client JS is needed.
 */
function renderTimelineFilters(page: TimelinePage, agentId: string, masker: Masker): string {
	const { query } = page;
	const noneActive = query.kinds.length === 0;
	const kindChips = [
		`<a class="chip${noneActive ? " active" : ""}" href="${timelineHref(agentId, query, { kinds: [], page: 1 }, masker)}">все</a>`,
		...TIMELINE_KINDS.map((kind) => {
			const active = query.kinds.includes(kind);
			const kinds = active
				? query.kinds.filter((candidate) => candidate !== kind)
				: TIMELINE_KINDS.filter((candidate) => candidate === kind || query.kinds.includes(candidate));
			return `<a class="chip${active ? " active" : ""}" href="${timelineHref(agentId, query, { kinds, page: 1 }, masker)}">${masker.text(TIMELINE_KIND_LABELS[kind])}</a>`;
		}),
	].join("");
	const periodChips = TIMELINE_PERIOD_LABELS.map(({ period, label }) => {
		const active = query.period === period;
		return `<a class="chip${active ? " active" : ""}" href="${timelineHref(agentId, query, { period, page: 1 }, masker)}">${masker.text(label)}</a>`;
	}).join("");
	const hidden = [
		...query.kinds.map((kind) => `<input type="hidden" name="kind" value="${masker.text(kind)}">`),
		query.period === "all" ? "" : `<input type="hidden" name="period" value="${masker.text(query.period)}">`,
	].join("");
	const active: string[] = [];
	if (query.kinds.length > 0) {
		active.push(`тип: ${query.kinds.map((kind) => TIMELINE_KIND_LABELS[kind]).join(", ")}`);
	}
	if (query.period !== "all") active.push(`период: ${query.period}`);
	if (query.q) active.push(`поиск: «${query.q}»`);
	const activeText = active.length > 0 ? active.join(" · ") : "не заданы — показаны все события";
	const pageText = page.pageCount > 1
		? ` · страница ${masker.num(page.page)} из ${masker.num(page.pageCount)}`
		: "";
	return `<section class="filters" aria-label="фильтры таймлайна">
<div class="filter-row"><span class="filter-label">тип</span>${kindChips}</div>
<div class="filter-row"><span class="filter-label">период</span>${periodChips}</div>
<form class="filter-search" method="get" action="${agentHref(agentId, masker)}">
${hidden}<input type="text" name="q" value="${masker.text(query.q)}" placeholder="поиск: заголовок, текст, триггер" aria-label="поиск по событиям">
<button type="submit">найти</button>
<span class="filter-count">показано ${masker.num(page.shown)} из ${masker.num(page.total)}${pageText}</span>
</form>
<p class="filter-active">активные фильтры: ${masker.text(activeText)} <a class="reset" href="${agentHref(agentId, masker)}">сбросить</a></p>
</section>`;
}

/** One compact line per event; the old per-run table moves behind `<details>`. */
function renderTimelineItem(item: TimelineItem, masker: Masker): string {
	const when = `<time datetime="${masker.text(Number.isFinite(item.at) ? new Date(item.at).toISOString() : "")}">${masker.text(formatTimestamp(item.at))}</time>`;
	const badge = `<span class="badge">${masker.text(item.badge)}</span>`;
	const meta = item.run
		? `<span class="feed-meta mono">${masker.text(formatCost(item.run.usage.cost))} · ${masker.num(item.run.usage.total)} tok</span>`
		: "";
	const detail = item.detail ? `<p class="feed-detail">${masker.text(item.detail)}</p>` : "";
	const facts = item.kind === "run" && item.run ? renderRunFacts(item.run, masker) : "";
	const runSummary = item.kind === "run" && item.run
		? `<p class="feed-detail">${masker.text(
			`${formatDuration(item.run.durationMs)} · ${item.run.turns} turns · ${item.run.triggers.length} events · ${item.run.outcome.label}`,
		)}</p>`
		: "";
	const link = item.href ? `<p class="sub"><a href="${masker.text(item.href)}">run details →</a></p>` : "";
	const full = `${runSummary}${detail}${facts}${link}`;
	const details = full
		? `<details class="feed-full"><summary>подробности</summary>${full}</details>`
		: "";
	return `<li class="feed-item ${item.kind}">
<div class="feed-row">${when}${badge}<span class="feed-summary">${masker.text(item.title)}</span>${meta}</div>
${details}
</li>`;
}

function renderTimeline(page: TimelinePage, agentId: string, masker: Masker): string {
	if (page.total === 0) {
		return hasTimelineFilters(page.query)
			? `<p class="empty">по фильтрам ничего не найдено</p>`
			: `<p class="empty">No runs, sleeps, reminders or key events recorded yet.</p>`;
	}
	const rows = page.items.map((item) => renderTimelineItem(item, masker));
	const remaining = page.total - page.offset - page.shown;
	const more = page.hasMore && page.nextPage !== undefined
		? `<p class="more"><a href="${timelineHref(agentId, page.query, { page: page.nextPage }, masker)}">показать ещё</a> <span class="sub">осталось ${masker.num(remaining)}</span></p>`
		: "";
	return `<ol class="feed">\n${rows.join("\n")}\n</ol>\n${more}`;
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
	return layout(masker, "agents", body, [], logoutOptions(context));
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
<p class="sub"><a href="${memoryHref(summary.id, masker)}">memory, notes, journal and summary →</a> · <a href="${settingsHref(summary.id, masker)}">settings →</a> (the only page that can write)</p>

<h2>status</h2>
<table class="kv">
<tr><th>status</th><td>${renderStatus(summary, masker)}</td><th>model</th><td class="mono">${masker.text(summary.model)}</td></tr>
<tr><th>current run</th><td>${masker.text(summary.currentRun)}</td><th>spend today</th><td class="mono">${masker.text(formatCost(summary.spendTodayUsd))}</td></tr>
<tr><th>runs recorded</th><td class="mono">${masker.num(detail.totals.runs)}</td><th>lifetime cost</th><td class="mono">${masker.text(formatCost(detail.totals.cost))}</td></tr>
<tr><th>pid</th><td class="mono">${summary.pid === undefined ? "—" : masker.num(summary.pid)}</td><th>config</th><td class="mono">${masker.text(summary.configPath)}</td></tr>
</table>

<h2>timeline (newest first)</h2>
<p class="note">key events are inbox events with high/interrupt priority, or runtime system/worker events; normal chat messages appear as run triggers. filters are plain GET parameters (kind, period, q, page), no JavaScript.</p>
${renderTimelineFilters(detail.timelinePage, summary.id, masker)}
${renderTimeline(detail.timelinePage, summary.id, masker)}

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
	], logoutOptions(context));
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
	], logoutOptions(context));
}

// ---------------------------------------------------------------------------
// memory page
// ---------------------------------------------------------------------------

function memoryTimestamp(value: string | undefined): string {
	if (!value) return "—";
	return formatTimestamp(Date.parse(value));
}

function renderTruncation(item: { truncated: boolean; originalChars: number }, masker: Masker): string {
	if (!item.truncated) return "";
	return `<p class="note">truncated: showing the first ${masker.num(MEMORY_MAX_TEXT_CHARS)} of ${masker.num(item.originalChars)} characters</p>`;
}

function renderScopes(scopes: string[], masker: Masker): string {
	if (scopes.length === 0) return `<span class="sub">no scopes</span>`;
	return `<div class="scopes">${scopes.map((scope) => `<span class="scope">${masker.text(scope)}</span>`).join("")}</div>`;
}

function renderFactText(fact: MemoryFactView, masker: Masker): string {
	const validTo = fact.validTo ? ` → ${memoryTimestamp(fact.validTo)}` : " → present";
	return `<div class="fact-text">${masker.text(fact.text)}</div>
${renderScopes(fact.scopes, masker)}
<div class="sub mono">created ${masker.text(memoryTimestamp(fact.createdAt))} · valid ${masker.text(memoryTimestamp(fact.validFrom))}${masker.text(validTo)} · id ${masker.text(fact.id)}</div>
${renderTruncation(fact, masker)}`;
}

function renderFactGroup(group: MemoryFactGroup, masker: Masker): string {
	if (!group.current) {
		const fact = group.revisions[0];
		if (!fact) return "";
		return `<article class="memory-item fact historical">
<div class="memory-head"><span class="badge">superseded</span><span class="sub">current revision not in this result</span></div>
${renderFactText(fact, masker)}
</article>`;
	}
	const revisions = group.revisions.length === 0
		? ""
		: `<details class="revisions">
<summary>${masker.num(group.revisions.length)} older revision${group.revisions.length === 1 ? "" : "s"} (superseded)</summary>
${group.revisions.map((revision) => `<div class="revision">${renderFactText(revision, masker)}</div>`).join("\n")}
</details>`;
	return `<article class="memory-item fact current">
<div class="memory-head"><span class="badge">current</span><span class="sub">${masker.num(1 + group.revisions.length)} revision${group.revisions.length === 0 ? "" : "s"} in this chain</span></div>
${renderFactText(group.current, masker)}
</article>
${revisions}`;
}

function renderTextSection(
	section: MemoryTextSection,
	one: string,
	many: string,
	query: string,
	emptyText: string,
	masker: Masker,
): string {
	const label = section.total === 1 ? one : many;
	const counts = `<p class="sub">showing ${masker.num(section.shown)} of ${masker.num(section.total)} ${label}</p>`;
	const note = section.note ? `<p class="note">${masker.text(section.note)}</p>` : "";
	if (section.items.length === 0) {
		return `${counts}${note}<p class="empty">${masker.text(query ? `no ${many} match the search term` : emptyText)}</p>`;
	}
	const items = section.items.map((item: MemoryTextItem) => `<article class="memory-item">
<div class="memory-head"><span class="memory-title">${masker.text(item.title)}</span>${item.meta ? `<span class="sub">${masker.text(item.meta)}</span>` : ""}${item.source ? `<span class="sub mono">${masker.text(item.source)}</span>` : ""}</div>
<pre>${masker.text(item.text)}</pre>
${renderTruncation(item, masker)}
</article>`).join("\n");
	return `${counts}${note}\n${items}`;
}

export function renderMemoryPage(view: MemoryView, context: RenderContext): string {
	const masker = new Masker(context.secrets, context.env);
	const search = view.query
		? `<div class="search">
<p>search <span class="term">${masker.text(view.query)}</span> — case-insensitive substring over facts, notes, journal and summary</p>
<p class="sub">matches: facts ${masker.num(view.facts.matches)} · notes ${masker.num(view.notes.matches)} · journal ${masker.num(view.journal.matches)} · summary ${masker.num(view.summary.matches)}</p>
</div>`
		: `<p class="note">search: append <code>?q=term</code> to this page's URL (case-insensitive substring). Only GET is supported.</p>`;
	const currentFacts = view.facts.groups.filter((group) => group.current).length;
	const factsCounts = `<p class="sub">showing ${masker.num(view.facts.shown)} of ${masker.num(view.facts.total)} fact revision${view.facts.total === 1 ? "" : "s"} · ${masker.num(currentFacts)} current fact${currentFacts === 1 ? "" : "s"}</p>`;
	const factsNote = view.facts.note ? `<p class="note">${masker.text(view.facts.note)}</p>` : "";
	const facts = view.facts.groups.length === 0
		? `${factsCounts}${factsNote}<p class="empty">${masker.text(view.query ? "no facts match the search term" : "no facts retained yet")}</p>`
		: `${factsCounts}${factsNote}<p class="note">revisioned facts: the current revision is shown first, superseded revisions are collapsed. search matches individual revisions.</p>\n${view.facts.groups.map((group) => renderFactGroup(group, masker)).join("\n")}`;
	const summary = view.summary.item
		? `<article class="memory-item">
<div class="memory-head"><span class="memory-title">summary.md</span><span class="sub mono">${masker.text(view.summary.item.source ?? "")}</span></div>
<pre>${masker.text(view.summary.item.text)}</pre>
${renderTruncation(view.summary.item, masker)}
</article>`
		: `<p class="empty">${masker.text(view.summary.note ?? "no summary.md")}</p>`;

	const body = `<h1>${masker.text(view.agent.name)} · memory</h1>
<p class="sub mono">${masker.text(view.agent.id)} · ${masker.text(view.databasePath)}</p>
<p class="sub"><a href="${agentHref(view.agent.id, masker)}">← back to agent</a> · read-only: this page never writes to memory</p>

${search}

<h2>facts</h2>
${facts}

<h2>summary</h2>
${summary}

<h2>notes</h2>
${renderTextSection(view.notes, "note", "notes", view.query, "no notes", masker)}

<h2>journal (newest first)</h2>
${renderTextSection(view.journal, "journal entry", "journal entries", view.query, "the journal is empty", masker)}`;
	return layout(masker, `${view.agent.name} memory`, body, [
		`<a href="/">agents</a>`,
		`<a href="${agentHref(view.agent.id, masker)}">${masker.text(view.agent.name)}</a>`,
		`<span class="mono">memory</span>`,
	], logoutOptions(context));
}

export interface SettingsRenderOptions {
	/** Per-render CSRF token, stored in the server's in-memory table. */
	csrfToken: string;
	/** Set after a successful POST redirect (`?saved=1`). */
	saved?: boolean;
}

function renderBackupList(view: SettingsView, masker: Masker): string {
	if (view.backups.length === 0) {
		return `<p class="empty">No backups yet — one is written before every save.</p>`;
	}
	const rows = view.backups.map((backup) => `<tr>
<td class="mono">${masker.text(backup.name)}</td>
<td>${masker.text(backup.originalName)}</td>
<td class="num">${masker.num(backup.size)}</td>
<td class="mono">${masker.text(formatTimestamp(backup.mtimeMs))}</td>
</tr>`);
	return `<table>
<thead><tr><th>backup</th><th>file</th><th class="num">bytes</th><th>written</th></tr></thead>
<tbody>
${rows.join("\n")}
</tbody>
</table>`;
}

/**
 * The settings page: a plain HTML form, no client JavaScript.
 *
 * Every value (current config, prompt bodies, paths, the CSRF token) goes
 * through the masker, and the finished document is masked once more by
 * `layout`. Prompt files that hold a secret therefore render as `[label#n]`;
 * the page says so, because saving that text would write the placeholder.
 */
export function renderSettingsPage(
	view: SettingsView,
	context: RenderContext,
	options: SettingsRenderOptions,
): string {
	const masker = new Masker(context.secrets, context.env);
	const disabled = view.disabledReason !== undefined;
	const disabledNote = view.disabledReason
		? `<p class="disabled">editing is disabled: ${masker.text(view.disabledReason)}</p>`
		: "";
	const configDisabled = disabled || view.configDisabledReason !== undefined;
	const configNote = view.configDisabledReason
		? `<p class="note">config is read-only here: ${masker.text(view.configDisabledReason)}</p>`
		: "";
	const savedNote = options.saved
		? `<p class="saved">saved. The previous version of every changed file was copied to <span class="mono">${masker.text(view.backupsDir)}</span> (the newest 20 per file are kept).</p>`
		: "";
	const flags = view.flags.map((flag) => `<tr>
<th class="mono">${masker.text(flag.path)}</th>
<td>${masker.text(flag.label)}</td>
<td class="mono">${masker.text(flag.value ? "on" : "off")}</td>
</tr>`).join("\n");
	const promptFields = view.prompts.map((prompt) => {
		const missing = prompt.exists ? "" : `<div class="note">this file does not exist yet; saving creates it</div>`;
		const outside = prompt.insideProfile
			? ""
			: `<div class="note">this path is outside the profile directory, so saving it is refused</div>`;
		const truncated = prompt.truncated
			? `<div class="note">showing the first ${masker.num(prompt.content.length)} of ${masker.num(prompt.originalChars)} characters; saving this text would truncate the file</div>`
			: "";
		const rows = Math.min(Math.max(prompt.content.split("\n").length + 2, 8), 30);
		return `<label class="field">
<span class="label">${masker.text(prompt.label)}</span>
<textarea name="${masker.text(prompt.field)}" rows="${rows}" spellcheck="false"${disabled ? " disabled" : ""}>${masker.text(prompt.content)}</textarea>
<span class="path">${masker.text(prompt.path)}</span>
${missing}${outside}${truncated}
</label>`;
	}).join("\n");
	const body = `<h1>${masker.text(view.agent.name)} · settings</h1>
<p class="sub mono">${masker.text(view.agent.id)} · ${masker.text(view.agent.profileDir)}</p>
<p class="sub"><a href="${agentHref(view.agent.id, masker)}">← back to agent</a> · this is the dashboard's only write path</p>
${savedNote}${disabledNote}

<h2>effective permissions</h2>
<table class="kv">
<tr><th>model</th><td class="mono">${masker.text(view.model || "(default from pi settings)")}</td></tr>
<tr><th>tool allowlist</th><td class="mono">${masker.text(view.allowlist.join(", ") || "(empty)")}</td></tr>
</table>
<table class="mini">
${flags}
</table>

<h2>config</h2>
<p class="note">the JSON below is the editable subset of <span class="mono">${masker.text(view.agent.configPath)}</span>: only fields that differ from the effective config are written. Unknown fields are rejected. Secrets (tokens, API keys) are never editable here — keep them in <span class="mono">.env</span> next to the config and reference them with <span class="mono">*Env</span> field names.</p>

<h2>prompt files</h2>
<p class="note">paths are resolved from the profile config; a file outside the profile directory is refused. Values that look like secrets are shown masked (<span class="mono">[label#n]</span>) — do not paste secrets into these files.</p>

<form class="settings" method="post" action="${settingsHref(view.agent.id, masker)}">
<input type="hidden" name="csrf" value="${masker.text(options.csrfToken)}">
<fieldset>
<legend>config · ${masker.text(baseName(view.agent.configPath))}</legend>
<label class="field">
<span class="label">editable config (JSON): model, tools, workers, sandbox, modules.browser</span>
<textarea name="config" rows="24" spellcheck="false"${configDisabled ? " disabled" : ""}>${masker.text(view.configJson)}</textarea>
${configNote}
</label>
</fieldset>
<fieldset>
<legend>prompt files</legend>
${promptFields}
</fieldset>
<button type="submit"${disabled ? " disabled" : ""}>save settings</button>
</form>

<h2>backups</h2>
<p class="note">before every write the previous version is copied to <span class="mono">${masker.text(view.backupsDir)}</span>; the newest 20 backups per file are kept. The newest 10 are listed here.</p>
${renderBackupList(view, masker)}`;
	return layout(masker, `${view.agent.name} settings`, body, [
		`<a href="/">agents</a>`,
		`<a href="${agentHref(view.agent.id, masker)}">${masker.text(view.agent.name)}</a>`,
		`<span class="mono">settings</span>`,
	], logoutOptions(context));
}

/** A rejected edit: what went wrong, and that nothing was written. */
export function renderSettingsErrorPage(
	agent: { id: string; name: string },
	status: number,
	messages: string[],
	context: RenderContext,
): string {
	const masker = new Masker(context.secrets, context.env);
	const body = `<h1>settings not saved (${masker.num(status)})</h1>
<ul class="errors">${messages.map((message) => `<li>${masker.text(message)}</li>`).join("")}</ul>
<p>No file was changed. Fix the problem and submit the form again.</p>
<p><a href="${settingsHref(agent.id, masker)}">← back to settings</a> · <a href="${agentHref(agent.id, masker)}">agent</a></p>`;
	return layout(masker, `settings error ${status}`, body, [
		`<a href="/">agents</a>`,
		`<a href="${agentHref(agent.id, masker)}">${masker.text(agent.name)}</a>`,
		`<span class="mono">settings</span>`,
	], logoutOptions(context));
}

/** Local, masked basename: the renderer must not import `node:path` just for this. */
function baseName(file: string): string {
	const index = Math.max(file.lastIndexOf("/"), file.lastIndexOf("\\"));
	return index >= 0 ? file.slice(index + 1) : file;
}

export function renderErrorPage(status: number, message: string, context: RenderContext): string {
	const masker = new Masker(context.secrets, context.env);
	const body = `<h1>${masker.num(status)}</h1>
<p>${masker.text(message)}</p>
<p><a href="/">back to agents</a></p>`;
	return layout(masker, `error ${status}`, body, [], logoutOptions(context));
}

/**
 * The password page. There is intentionally one error string for every bad
 * credential, and the password input is never repopulated.
 */
export function renderLoginPage(context: RenderContext, error?: string): string {
	const masker = new Masker(context.secrets, context.env);
	const errorHtml = error ? `<p class="error">${masker.text(error)}</p>` : "";
	const body = `<div class="login">
<h1>sign in</h1>
<p class="sub">This dashboard is exposed through a temporary HTTPS tunnel. Enter the dashboard password set with <span class="mono">alive dashboard --set-password</span>.</p>
${errorHtml}
<form method="post" action="/login">
<label>
<span class="label">password</span>
<input type="password" name="password" autocomplete="current-password" autofocus required>
</label>
<button type="submit">sign in</button>
</form>
</div>`;
	return layout(masker, "sign in", body);
}
