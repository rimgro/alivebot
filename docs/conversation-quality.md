# Slava: onboarding and answer quality

This slice addresses [#234](https://github.com/rimgro/alivebot/issues/234) and
[#233](https://github.com/rimgro/alivebot/issues/233), with broader context in
[#14](https://github.com/rimgro/alivebot/issues/14),
[#22](https://github.com/rimgro/alivebot/issues/22) and
[#80](https://github.com/rimgro/alivebot/issues/80).

## Conversation onboarding

The first task takes priority over setup. A greeting or `/start` invites a first
task; it does not launch a compulsory questionnaire. The agent can ask one
relevant question at a time. Personal intake is available only in private
Telegram conversations and operator console/TUI routes, never group chats.

The `onboarding` host tool stores explicit `language`, `tone`, `detail`, `updates`
and `focus` preferences. Values are limited to 300 characters each. Each saved
value carries an incoming event ID and sequence. Mutations require the latest
eligible human event and an exact supporting quotation from its original body
(not a quoted reply), or a successfully transcribed voice message. A failed
transcription cannot supply evidence. Forwarded and bot-authored messages cannot drive intake.
Legacy Telegram events without the original-body field need a fresh message for
mutations. Whether that quotation
actually supports the extracted preference remains an agent decision, not a
semantic guarantee made by the runtime.

States: absent → `pending`; first update → `active`; `complete` → `completed`;
`skip` → `skipped`. Completion requires no mandatory fields. Corrections preserve
completed/skipped status. `status` is read-only; `update` merges supplied fields;
`null` removes one field. `reset` removes these preferences and returns to pending.
It does **not** erase history, logs, backups or separately retained memories.

Examples of human requests: “пиши коротко”, “пропусти знакомство”, “что ты запомнил
о моём стиле?”, “удали предпочтение про тон”. These are interpreted by the agent;
they are not hard-coded Telegram commands.

Profiles live in `<stateDir>/onboarding/<sha256(thread)>.json`, with atomic writes
and mode `0600`. They survive context reset and process restart independently of
semantic memory. Awake, nudge, idle and interrupt inputs include only eligible threads
in the corresponding event batch. Profile text is labeled as data and passes
through configured secret masking; it is not installed in the system prefix.
A corrupt/unreadable profile is reported as unavailable in context; the task
continues without restarting intake or overwriting the file. The runtime still
uses one agent context across conversations: this scoped data projection does
not create separate model sessions or isolate older history/semantic memories.
A missing profile does not prove a person is new: the agent should consult
existing history before repeating questions.

New managed agents receive the default SOUL rather than copying the creator's
personal SOUL. Their role and responsibilities remain in their own CONTRACT.
Operators who need a custom shared character can edit the new agent's SOUL
explicitly. Existing agents and their files are not migrated.

## Anti-slop

The permanent prompt contains a compact answer-quality policy. It preserves
facts, useful uncertainty and the requested genre while removing empty framing,
repetition and unsupported embellishment. The default SOUL no longer imposes
punctuation/sentence quotas or asks the model to impersonate a person. Existing
custom SOUL files are not automatically overwritten.

For substantial editing, `writing_guide({"name":"anti-slop"})` returns
[`skills/anti-slop/SKILL.md`](../skills/anti-slop/SKILL.md). It reads one curated
resource, accepts no filesystem paths, and neither executes scripts nor loads
third-party skills. The same host tool works for sandboxed agents without
turning on ordinary host skill discovery. `npm run build` bundles its own copy
under `dist/skills/`, so a saved `dist.prev` retains the matching guide.

New configs allow both `onboarding` and `writing_guide`. Existing explicit
`tools.allowlist` values need these names added by the operator; they are not
silently granted. Both tools are discoverable through the compact catalog.
The prompt only requests a tool when it survived tool selection.

## Sources and decisions

Reviewed primary sources on 2026-11-11:

- [OpenClaw bootstrap](https://docs.openclaw.ai/start/bootstrapping) and
  [BOOTSTRAP template](https://docs.openclaw.ai/reference/templates/BOOTSTRAP):
  useful work before an optional first-run conversation and persistent progress.
  Slava does not adopt avatar generation or a plugin-selection ritual.
- [blader/humanizer](https://github.com/blader/humanizer): preserve claims and
  author voice, inspect structural padding, and avoid rewriting clean passages.
- [hardikpandya/stop-slop](https://github.com/hardikpandya/stop-slop): compact
  guidance and checking what a sentence adds. Slava does not adopt blanket bans
  on adverbs, punctuation or grammatical constructions.
- [Pi skill documentation](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/skills.md):
  skill discovery and loading are different steps. Sandbox delivery needs the
  curated tool rather than an inaccessible host-path catalog entry.

The bundled skill is original project guidance, not a vendored copy of these
repositories. No external skill installer or provider/model setting is changed.

## Verification and next evaluation

`npm run test:conversation` checks store/tool boundaries, durable transitions,
corrections, replay/stale events, group refusal, child isolation, default tool
selection and guide access. Existing onboarding, lifecycle, idle, runner,
module and config tests cover affected runtime paths. The skill validator checks
frontmatter. Build verification loads the guide from outside the checkout and
from a relocated runtime generation.

These are offline contract checks. They do not prove better language quality,
consistent tool choice by a live model or production acceptance.

Observed on 2026-11-11 (Node v26.7.0, macOS 25.6.0): typecheck, build,
conversation/onboarding/lifecycle/runner/idle/modules/config checks and skill
validation passed. Built and relocated `dist.prev` guide loading passed from
outside the checkout, including after changing the repository guide copy.
The default full suite stopped at the existing worker path-identity issue
[#235](https://github.com/rimgro/alivebot/issues/235). With
`TMPDIR=/private/tmp`, 47 test scripts completed successfully; the final
`git-integrity-test` failed while attempting to truncate a read-only temporary
Git object (`EACCES` at fixture setup). Those worker/integrity files were
unchanged from base `de7991a`. The full suite is therefore not reported as green.

For the next comparison, use [the fixed cases](../evals/conversation-quality.json).
Keep model/version, budget, tools and input state equal; change only the prompt
and guide policy. Save baseline and candidate outputs plus versions, tool traces,
latency and token counts. Randomize A/B labels before a reviewer sees them.
Score task completion, preservation of facts/limits, genre/voice and unnecessary
text from 0 to 2 each. Factual loss, an invented action/experience, a missed skip,
or cross-thread personalization vetoes a case regardless of style score.
Compare development cases first; review the held-out cases after fixing the
candidate, without tuning against them. Repeat runs to estimate variation.
Retain a candidate only if it improves blinded preferences without new vetoes;
otherwise revert the policy and log the result. No live model comparison has
been performed as part of this slice.

Source picker UI, draft approval with per-fact provenance, deletion of all facts
derived from a removed source, voluntary voice interviews and a style-training
pipeline remain outside this slice. Do not close their parent concept issues
based only on these changes.
