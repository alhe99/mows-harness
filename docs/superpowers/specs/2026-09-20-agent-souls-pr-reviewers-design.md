# Agent souls, and three PR reviewers — design

**Builds on:** `2026-09-15-agents-layer-design.md` (Layer 6) and `2026-09-19-agent-memory-and-identity-design.md`
(memory, chat as run mode's shape). Retires the latter's D6 deferral partway: not plugin-per-agent,
but the first shared definition.
**Code this touches:** `agents/bin/mows-agent` (`run_context`, `chat_context`, `cmd_chat` budget),
`agents/bin/mows-agent-meta` (two new keys), `infra/dashboard/capability.mjs` (one field),
`infra/dashboard/app/views/agents.mjs` (one telemetry row), `scripts/e2e-agents.sh`,
`agents/SETUP.md`, `install.sh` (soul install), new `agents/souls/pr-reviewer.md`, three new
instance files under `agents/examples/`.

## Problem

An agent today is one `.md` file carrying its whole body. Three reviewers with the same
responsibilities across three GitHub orgs would be three copies of the same soul, and nothing —
not the linter, not the dashboard — could tell they were meant to match. They would drift the
first time one was edited.

What is wanted is the opposite shape: **one soul, several scopes.** The responsibilities are
written once; each instance says only where it works, keeps its own memory, spends its own
budget, and can be added or removed without touching the others.

The first soul is a **PR reviewer**, and the three scopes are the GitHub orgs this box's `gh`
belongs to and that hold work: `h4b-dev` (22 PRs authored by the operator, 15 review-requested,
today), `ffwd-org` (3 authored), `Paytix` (0 today). Decided 2026-09-20 with the operator:

| | Decision |
|---|---|
| Scope | PRs the operator **authored or is review-requested on**, in the instance's org. Not every PR in the org. |
| Output | **Dashboard and memory only.** Nothing posted to GitHub. The operator reads, decides, comments. |
| Trigger | **Manual.** The dashboard's Run now, or chat. No cron, no webhook. |

## Decisions locked

| | Decision | Why |
|---|---|---|
| **D1** | **A soul is a Markdown file, referenced by path from an instance's frontmatter (`mows.soul`), and appended to the system prompt on every run and chat turn.** | It rides the injection path memory already uses (`--append-system-prompt`), so it is re-asserted every call and cannot live only in a transcript. One file, N references. |
| **D2** | **The instance body is scope only.** | If the body says anything a second instance would also need to say, it belongs in the soul. The test of a good instance file is that it fits on one screen. |
| **D3** | **Lint refuses a `mows.soul` that does not resolve to a non-empty regular file under 16 KB.** | A missing soul must fail the run before it starts, not produce an agent that quietly has no idea what it is. 16 KB bounds the injection — a soul is a role, not a manual. |
| **D4** | **The reviewer is read-only against GitHub, by instruction AND by measurement.** | The token has `repo` scope, so `gh pr review` would work. The soul forbids every write; the first live run records whether the unattended permission regime would even allow the reads. Output goes to the run result, memory and Discord. |
| **D5** | **A run reviews at most 5 PRs, most recently updated first, skipping any whose head SHA memory already holds.** | h4b-dev has 37 candidate PRs today. Unbounded, a first run would cost tens of dollars and blow the budget mid-review. Bounded, every run costs about the same, and memory carries the rest to the next. |
| **D6** | **Memory is one line per open PR: `owner/repo#n @sha7 verdict`.** Merged and closed PRs are dropped each run. | 37 lines fit the 60-line cap with room for a header and a few concerns. Anything wordier does not. |
| **D7** | **Chat gets a per-agent budget: `mows.budget.chat_usd` / `chat_turns`, defaulting to today's `$0.25 / 6`.** | "Look at #519" is a review, not a question; the global chat cap was sized for questions. The default is unchanged so no existing agent's chat changes. |
| **D8** | **`profile: work`.** | Company orgs on the company account (34% weekly at time of writing), not the operator's personal subscription. |
| **D9** | **The `mows-agent@.service` template gets installed on this box as part of this work.** | It never was here. Without it the dashboard's Run now — the trigger the operator chose — answers 409. |

## 1. Souls

`agents/souls/<name>.md` in the repo; installed to `~/.claude/agents/souls/<name>.md` by
`install.sh --agents` beside the agent files. Plain Markdown, no frontmatter. Not discovered as an
agent: `all_agents()` globs `agents/*.md`, not subdirectories, and a soul has no `mows:` key.

An instance references it as `mows.soul: ~/.claude/agents/souls/pr-reviewer.md` (tilde expanded,
same as `workdir`). Lint (D3) resolves the path, requires a regular file, non-empty, ≤ 16384 bytes.

**Injection.** Both `run_context()` and `chat_context()` gain, before the memory section:

```
## Your role
<soul file, verbatim>
```

The order in the appended prompt is therefore: run/chat facts → role → memory → (chat: history)
→ the human/no-human line → the memory contract. The instance body (what `--agent` loads as the
system prompt) comes first of all, so the model reads its scope, then its role, then what it
remembers.

An instance without `mows.soul` behaves exactly as today. Souls are optional; `disk-watch` and
`harness-reviewer` do not change.

## 2. The soul: `pr-reviewer`

`agents/souls/pr-reviewer.md`, verbatim:

```markdown
You are a standing pull-request reviewer for one GitHub organisation. Your instance file names
the organisation; nothing below is specific to any one org.

## What you review
Open pull requests in your org that the operator (`gh` is authenticated as them) either
authored or is requested to review. Find them with:

    gh search prs --owner <org> --state open --author @me --json repository,number,title,updatedAt
    gh search prs --owner <org> --state open --review-requested @me --json repository,number,title,updatedAt

Merge the two lists. For each PR read its head SHA (`gh pr view <n> --repo <owner/repo> --json
headRefOid,title,body,reviewDecision,additions,deletions,changedFiles,updatedAt`). **Skip any PR
whose `owner/repo#n @sha7` already appears in your memory** — you reviewed that exact head.
Of the rest, take the **five most recently updated**. Never more than five per run; the others
wait for the next run and your memory says so.

## How you review one PR
Read, in this order: the title and body (intent), `gh pr diff <n> --repo <owner/repo>` (what
actually changed), `gh pr checks <n> --repo <owner/repo>` (CI state). If a local checkout of the
repo exists under the working directory, read surrounding code there for context; do not clone.

Judge, in this order of severity:
1. **Correctness** — does the diff do what the description says? Edge cases, error paths,
   nulls, off-by-ones, races.
2. **Security and PCI** — these are payments organisations. Secrets or tokens in code or
   config; card data, PANs or credentials reaching a log, a database or a response; auth or
   permission checks removed or weakened; redaction bypassed. Any of these is **blocking**.
3. **Tests** — changed behaviour without a changed test; a test that cannot fail.
4. **CI** — failing or missing required checks (SonarCloud, Trivy, unit tests) and whether the
   failure is caused by this diff.
5. **Clarity** — naming, dead code, misleading comments. Nits, never blocking.

Report each finding as `path:line — what is wrong — why it matters`, then a one-word verdict per
PR: **blocking**, **should-fix**, **nits**, or **clean**. Say what you did NOT read (a diff you
truncated, a check you could not fetch). Prefer three precise findings to ten vague ones.

## What you never do
You are read-only against GitHub and the filesystem. Never `gh pr review`, `gh pr comment`,
`gh pr merge`, `gh pr edit`, `gh api` with a method other than GET, `git push`, `git commit`, or
any write. Never clone. Never approve or request changes on anyone's behalf — the operator reads
your findings on the dashboard and decides. If you cannot review something read-only, say so.

## Your memory
End every reply with a `mows-memory` block holding: one header line with the run date; then
**one line per open PR you have reviewed**, exactly `owner/repo#n @sha7 verdict`; then at most
five open concerns across PRs, one line each. Drop PRs that are merged or closed. Nothing else —
the block must stay under 40 lines, and it will be cut at 60.

## Escalation
A **blocking** finding on any PR is worth the operator's attention now: state it in the first
line of your reply, prefixed `BLOCKING:`, so the run's escalation can carry it.
```

## 3. The instances

Three files under `agents/examples/`, installed to `~/.claude/agents/`. `pr-reviewer-h4b.md`
verbatim; the other two differ only in `name`, `description`, and the org named in the body.

```markdown
---
name: pr-reviewer-h4b
description: Reviews the operator's open PRs in the h4b-dev GitHub org — read-only, on demand
model: sonnet
effort: high
tools: [Bash, Read, Glob, Grep]
disallowedTools: [Write, Edit, WebFetch, NotebookEdit]
permissionMode: default
maxTurns: 40
memory: user
mows:
  profile: work
  workdir: ~/Documents/Projects
  soul: ~/.claude/agents/souls/pr-reviewer.md
  task: >-
    Review my open pull requests in the h4b-dev organisation that are not yet in your memory,
    newest-updated first, at most five. Report findings and a verdict per PR, then update your
    memory.
  budget:
    usd_per_run: 2.00
    max_turns: 40
    usd_per_day: 6.00
    quota_floor: 20
    chat_usd: 1.00
    chat_turns: 12
  escalate:
    via: discord
  retention_days: 30
---
Your organisation is **h4b-dev**. Its repositories are payment processors, ledgers, issuing and
merchant systems; treat every diff as PCI-relevant until you have read it. Local checkouts of many
of its repositories are under the working directory, in `payments/` and `n1/`.
```

`pr-reviewer-ffwd`: org **ffwd-org**, checkouts under `paytix/` and `fun/`.
`pr-reviewer-paytix`: org **Paytix** (capital P, as GitHub spells it), checkouts under `paytix/`.

The body is three sentences. That is D2 holding.

## 4. Chat budget (D7)

`mows-agent-meta`: `BUDGET_KEYS` gains `chat_usd` (number, 0 < x ≤ 10) and `chat_turns`
(integer, 1..40). `cmd_chat` reads them from the agent's `mows.budget` and falls back to the
`CHAT_USD` / `CHAT_TURNS` environment defaults, which keep today's values. `chat_context()`'s
"this turn's budget" line prints the effective values.

## 5. Dashboard

`capability.mjs` `policy` gains `soul: <basename without .md> | null`. The Telemetry card gains a
**Soul** row when present (`pr-reviewer`), between Profile and Target. The chat header's hint line
is unchanged. No new endpoint.

## 6. Manual trigger (D9)

`mows-agent render --all`, then the documented install:

    sudo install -m644 rendered/mows-agent@.service /etc/systemd/system/
    sudo systemctl daemon-reload

No timers — these agents have no triggers. The dashboard's Run now (`/a/agent-run` →
`systemctl start mows-agent@<name>`) is the manual trigger, and chat is the other.

## 7. Test strategy

`scripts/e2e-agents.sh`, stub-driven unless marked **live**:

**Lint**
- `soul:` pointing at an existing non-empty file → clean.
- `soul:` absent → clean (optional).
- `soul:` pointing at a missing file → error names the path.
- `soul:` pointing at an empty file → error.
- `soul:` pointing at a 20 KB file → error names the 16384-byte limit.
- `soul:` pointing at a directory → error.
- `budget.chat_usd: 1.00`, `chat_turns: 12` → clean; `chat_usd: 0`, `chat_turns: 0`, `chat_turns: "x"` → errors.

**Injection**
- run with a soul → appended prompt contains `## Your role` followed by the soul's first line,
  and it precedes `## Your memory`.
- chat with a soul → same, and `## Your role` precedes `## The conversation so far`.
- run without a soul → no `## Your role`.

**Chat budget**
- agent with `chat_usd: 1.00 / chat_turns: 12` → chat argv has `--max-budget-usd 1.00`,
  `--max-turns 12`; the appended prompt's budget line says `1.00 USD, 12 turns`.
- agent without → argv has the defaults (`0.25`, `6`).

**Live** (`scripts/live-agents.sh`, never CI) — the measurement D4 needs:
1. `mows-agent run pr-reviewer-ffwd` on the real box (3 PRs, cheapest scope). Record: state,
   cost, `permission_denials` (does the unattended regime allow `gh search`/`gh pr view`/`gh pr
   diff`?), whether memory was written in the `owner/repo#n @sha7 verdict` shape, and whether any
   write-shaped `gh` call appeared in the stream (it must not).
2. Its result is written into this spec's addendum with the date and CLI version before
   `pr-reviewer-h4b` is run at all.

## 8. Not doing (explicitly)

- ~~**Posting to GitHub.**~~ Reversed the same day by the operator after reading the first run's
  verdicts — see the second addendum. The "separate switch" turned out to be the soul text itself.
- **Cron or webhook triggers.** Manual was the decision. Either is one frontmatter line later.
- **Cloning repositories.** Local checkouts under the workdir are context; `gh pr diff` is the
  review surface.
- **Instances for `fcdevx` and `po1nt-dev`.** Each is one copy of a three-sentence file when wanted.
- **Plugin-per-agent.** The soul file is the shared definition this repo needed; a plugin
  packaging step is still deferred to the first agent that needs a skill or an MCP server.
- **Souls for `disk-watch` and `harness-reviewer`.** They are single-scope and their bodies are
  their souls. Refactoring them buys nothing.

## Risks

- **The regime denies `gh` network reads unattended.** Then the reviewer cannot work from a
  scheduled or Run-now context at all, only from chat where a human is present to be asked. The
  live measurement (§7) settles this before the h4b instance exists; the fallback is documented
  as a known limit, not worked around with permission changes this spec does not own.
- **The first h4b run is expensive.** D5 caps it at five PRs; `usd_per_run: 2.00` caps it in
  dollars; memory carries the queue. Stated in the task text so the model does not try to be
  thorough across 37 PRs.
- **Memory outgrows 60 lines.** 37 open PRs + header + 5 concerns = 43 today. If h4b's open
  count passes ~50, the soul's "one line per PR" rule breaks the cap and truncation drops the
  oldest concerns — visible in Events as `memory truncated`. The fix then is to keep only PRs
  updated in the last 30 days, a one-line change to the soul.
- **Soul drift the other way.** One soul edit now changes three agents at once. That is the
  point, and also a blast radius: the soul file gets the same review discipline as `mows-agent`.
- **Token scope is wider than the soul.** `repo` scope can write. D4's instruction is the guard;
  the live run's stream is checked for write-shaped `gh` calls; a scoped read-only token is the
  operator's call and outside this spec.

## Addendum — measured 2026-09-20 (claude 2.1.277, unattended `mows-agent@.service`, user `defaultMode: auto`)

Each instance ran once from the dashboard's Run now (`POST /a/agent-run` → 303 → systemd unit).
No `gh` call in any stream was write-shaped (grep for `pr review|pr comment|pr merge|pr edit|
-X|--method|-f |-F |git push|git commit` over the three `stream.jsonl`: empty). The four `gh api`
calls were `repos/…/contents/…` GETs reading workflow files.

| instance | state | turns | cost | denials | gh subcommands | verdicts |
|---|---|---|---|---|---|---|
| pr-reviewer-paytix | done | 4 | $0.14 | 0 | `search prs`, `auth status` | none in scope; the one org PR is neither authored nor review-requested — correctly skipped |
| pr-reviewer-ffwd | done | 11 | $0.28 | 0 | `pr diff` ×10, `search prs` ×4, `pr view` ×4, `pr checks` ×2 | 1 blocking, 1 should-fix, 1 clean (3 PRs, all in scope) |
| pr-reviewer-h4b | done | 18 | $0.51 | 0 | `pr view` ×12, `run view` ×4, `api repos` ×4 (GET), `search prs` ×2, `pr diff` ×2 | 0 blocking, 2 should-fix, 3 clean (5 of the open PRs; memory carries the queue) |

**Regime:** unattended `gh search/pr view/pr diff/pr checks/run view/api GET` all execute with zero
permission denials — the §Risks worry about network reads being denied did not materialise.

**Memory shape:** all three wrote the `owner/repo#n @sha7 verdict` lines the soul specifies, plus a
dated header and ≤5 concerns; 10–11 lines, ~1 KB, far under the 60-line / 4096-byte cap. h4b's
memory records the PR it did not read (a 1,406-file branch promotion) and why.

**Two gaps found by the ffwd run, both fixed the same day:**
1. The reviewer copied a plaintext keystore password from the diff into its finding and its
   memory. The soul now carries "Never reproduce a secret's value" (`acc478f`); the memory on disk
   was scrubbed by hand. The run's `result.json`/`stream.jsonl` under the state dir still hold the
   value as evidence; the operator was told.
2. A `BLOCKING:` first line reached the result but nothing carried it further: `cmd_run` only
   escalated refusals. The runner now escalates a `BLOCKING:`-prefixed first line via the agent's
   `escalate.via` (`9c64cf0`, five e2e assertions on an agent with `via: discord`).

**Not measured:** a second run against the same heads (the skip-by-`@sha7` rule); a chat turn with
a reviewer (the run path was the question). Both are one Run now / one message when wanted.

## Addendum 2 — the reviewers post to GitHub (decided and measured 2026-09-20)

After reading the first run's verdicts the operator reversed §8's first item: every verdict is
posted to the PR as one GitHub review, and where GitHub allows it the review approves or requests
changes. Decided via one question: **blocking and should-fix → request changes; nits and clean →
approve.** Two exceptions are GitHub's, not ours: the operator's own PRs and drafts get a plain
comment review (GitHub returns 422 on self-approval). The change is soul text only — `gh pr review`
is the single write the soul permits; merge, edit, close, non-GET `gh api`, push and commit stay
forbidden. Memory lines gain a trailing `posted`; a line without it is a pending post the next run
retries, and it does not count against the five.

**Measured (claude 2.1.277, same regime as Addendum 1):**

| step | turns | cost | denials | writes |
|---|---|---|---|---|
| chat: "post your review of payments-backend#490" | — | $0.13 | 0 | 1 × `gh pr review --approve` (author is not the operator) |
| run #2, pr-reviewer-h4b | 35 | $1.13 | 0 | 10 × `gh pr review`: 8 `--comment` (own PRs), 1 `--approve`, 1 `--request-changes` (blocking, other author) |

Unattended `gh pr review` is allowed by the regime with zero denials. Each of the eleven PRs
carries exactly one review by the operator afterwards. A grep of the posted bodies, the result and
the memory for secret-shaped strings (connection strings with credentials, Twilio SIDs and keys,
bearer tokens) found nothing, although run #2 surfaced two pre-existing plaintext-secret exposures
in `h4b-dev/payments-backend` and `h4b-dev/sms` and named them by file only.

**Three gaps found, two fixed the same day:**
1. After posting one review in chat, the reviewer marked all seven memory lines `posted`. Soul
   now says: write `posted` only in the turn where your own `gh pr review` exited 0, and check
   `gh pr view --json reviews` for an existing operator review before posting. The false marks
   were scrubbed by hand; run #2 then posted the five real backlog items correctly.
2. Run #2 opened its reply with `## Summary`, a blank line, then `**BLOCKING:** …` on line 3, so
   the runner's first-line rule did not escalate. `cmd_run` now takes the first `BLOCKING:` line
   within the first ten (two more e2e assertions: line 3 under a heading posts, line 11 does not).
   Separately, `DISCORD_WEBHOOK` is unset in `~/.config/mows-agents/config` on this box, so an
   escalation would have only logged an event anyway — the operator's to fill in.
3. Run #2 silently dropped `creditum-backend#601` (reviewed in chat, never posted) from memory
   instead of carrying it as pending. Not fixed in the soul — one occurrence; recorded so a second
   one earns a rule. Posted by hand-asked chat turn afterwards.
