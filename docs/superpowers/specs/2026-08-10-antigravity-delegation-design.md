# Antigravity (agy) Delegation & Sessions — Design

Date: 2026-08-10
Status: approved for planning

## Motivation

Claude usage limits (5-hour window, weekly, per account) throttle work on this
box. The user has a Google AI Pro subscription whose Antigravity CLI (`agy`)
quota is idle. Two capabilities are wanted:

1. **Delegation bridge** — Claude delegates implementation work to agy,
   automatically when the active Claude account nears its limits, and manually
   whenever the user asks.
2. **agy sessions in the harness** — launch/attach agy interactive sessions
   with the same ergonomics as `cc`/`ccw`: tmux persistence, web dashboard
   pickup, multi-device access via the existing web terminal.

Existing art adopted instead of rebuilt where possible; community MCP bridges
(agy-bridge et al.) were evaluated and **not** adopted — they burn an MCP slot
in both curated profiles and still leave the custom 80% (quota trigger,
worktree handoffs, gates, merge policy) unbuilt. Everything ships as
mows-harness bash scripts, manifest-deployed to `~/.local/bin`, e2e-tested in
the container suite.

## Decisions (agreed)

| Decision | Choice |
|---|---|
| Scope | One spec, three phases (0, A, B) |
| Delegation triggers | Auto when active account ≥ **70%** of 5h or weekly window; manual anytime on user request |
| Supervision | Synchronous (Claude in the loop) for small/medium tasks; fire-and-forget detached sessions for big handoffs |
| Isolation | Every fire-and-forget handoff runs in a fresh git worktree + `agy/<id>` branch; `--dangerously-skip-permissions` is scoped to that worktree only |
| Review & merge | Auto-merge when green. Verification commands are always re-run by the harness. `big` handoffs additionally get a model review first: Claude if quota < 70%, else a second agy session on the smartest available model. Red/conflict/ambiguous → park branch + notify. agy never merges |
| Quota threshold | 70%, defined once in `claude-quota` |
| Multi-device for agy | Web terminal + tmux (no remote-control equivalent exists for agy) |

## Phase 0 — Foundation

- Install agy via the official installer (`curl -fsSL
  https://antigravity.google/cli/install.sh | bash`; universal, aarch64 OK).
  Record installed version in SETUP docs.
- Baseline permission allow-rules in `~/.gemini/antigravity-cli/settings.json`
  (git, common build/test commands; no blanket write outside worktrees).
- First login performed once by the user over SSH (agy's remote flow: URL +
  one-time code).
- **Known risk — token persistence:** agy historically requires the
  freedesktop-secrets D-Bus API and fails to persist OAuth tokens on headless
  Linux (google-antigravity/antigravity-cli#57). Verify on current version
  first; only if it still fails, add a headless gnome-keyring systemd *user*
  service (dbus + `gnome-keyring-daemon`, auto-unlocked at boot). A live check
  asserts auth survives a fresh shell session.
- Deliverables: `install.sh` section, manifest entries, SETUP.md docs, e2e
  render checks.

## Phase A — Delegation bridge

```
claude-quota ──▶ Claude decides ──▶ agy-run   (sync, small/medium)
   (signal)      (skill + rule)  └▶ agy-handoff (detached, big) ──▶ agy-gate ──▶ merge / park
```

### `claude-quota`

- Prints JSON per account (`personal` = `~/.claude`, `work` =
  `~/.claude-work`): 5-hour %, weekly %, reset timestamps.
- Primary source: the OAuth usage endpoint Claude Code's own `/usage` reads,
  using each profile's stored credentials. Fallback if that endpoint proves
  unstable: transcript-based estimation (ccusage-style). Script interface is
  identical either way.
- Cached ~5 minutes (same pattern as `claude-status`).
- `--check [account]` exits 0 when < 70%, 1 when ≥ 70%, 2 when unknown.
  The 70% threshold is defined here and nowhere else.
- Unknown/unreachable ⇒ report `unknown`; policy treats unknown as
  "do not auto-delegate" (manual delegation unaffected).

### `agy-run` — synchronous delegation

- Wraps `agy -p "<prompt>" --output-format json [--model … --effort …
  --print-timeout …]`.
- **Fails loud on the empty-output quota bug**: agy exit 0 with empty
  `response` ⇒ our exit 1 with agy's stderr reason attached. Auth errors on
  stderr ⇒ exit with "run `ag` and re-login".
- Emits `.response` text (optional `--json` for the full envelope, including
  `conversation_id` for follow-ups via `--conversation`).
- Called by Claude through plain Bash; result reviewed/integrated by Claude in
  the same conversation. No MCP server.

### `agy-handoff` — fire-and-forget

- `agy-handoff start [--repo <path>] [--size small|big] [--no-merge]
  <task-file|-- prompt>`:
  1. Creates worktree `~/.local/state/agy-handoffs/<id>/wt` on new branch
     `agy/<id>` (state, log, and worktree live together; target repos stay
     unpolluted).
  2. Writes `HANDOFF.md` into the worktree: task, acceptance criteria,
     **runnable verification commands**, constraints, size class, merge
     policy. This file is the contract every later gate checks against.
  3. Spawns detached tmux session `agyh-<id>`: agy headless with
     `--dangerously-skip-permissions`, cwd = worktree, `--output-format
     stream-json` teed to `<worktree>/.agy/run.log`; command chain ends with
     `agy-gate <id>` so gating runs the moment agy exits. No daemon.
- `agy-handoff list` — in-flight / parked / merged, with age, branch, session,
  staleness after reboot.
- `agy-handoff resume <id>` — re-spawns the session continuing via
  `--conversation <id-from-log>`.

### `agy-gate` — merge policy engine

1. Re-run `HANDOFF.md` verification commands in the worktree (agy's own claim
   counts for nothing). Red → park + notify.
2. Size `big` → model review of `git diff main...agy/<id>` against the
   contract: `claude -p` review if `claude-quota --check` passes for either
   account, else `agy -p --model <REVIEW_MODEL> --effort high`. `REVIEW_MODEL`
   (smartest available, verified via `agy models` at install) is a single
   constant. Review red → park + notify.
3. All green → `git merge --no-ff agy/<id>` from the main checkout, clean up
   worktree, notify "merged". Conflict → park + notify.
4. Parked branches keep worktree, log, and `conversation_id` for resume.
5. Notifications: existing Discord gateway (openclaw); dashboard parked-list
   (`agy-handoff list`) as the always-available fallback.

### Model selection

Claude picks a **tier**; slugs live in one config table populated from
`agy models` at setup (recorded in SETUP.md):

| Tier | Used for | Mapping |
|---|---|---|
| `default` | Implementation handoffs | No `--model` flag — agy's own default; immune to slug renames |
| `fast` | Cheap sync tasks (summaries, extraction, read-heavy) via `agy-run` | Flash-tier slug, low/medium effort — preserves AI Pro quota |
| `review` | `big`-handoff review escalation | `REVIEW_MODEL`: smartest available slug (`--effort high` only when no slug is set — agy rejects effort overrides for slugs with embedded effort/thinking) |

agy fails fast on unknown model slugs; `agy-run` surfaces that as a loud
"update the model table" error — nothing silently downgrades.

### Claude-side policy

- Skill `claude/skills/agy-delegate/SKILL.md`: when to delegate, how to write
  handoff contracts (acceptance criteria + verification commands mandatory),
  size classification, model choice, reviewing agy results, resume flow.
- Global CLAUDE.md rule (both profiles): before sizeable implementation work,
  run `claude-quota --check`; ≥ 70% ⇒ delegate per the skill; also delegate
  whenever the user explicitly asks.
- SessionStart hook injects the cached quota line so every session starts
  knowing the state.

## Phase B — `ag` launcher & sessions

- `ag` in `~/.local/bin`, cloned from the `cc` pattern: bare / `-c` /
  `--continue` / `-r` / `--resume` starts get tmux session `agy-<dir-slug>`;
  duplicate-session prompt with the same `[Enter]/[n]/[q]` UX (`-2`, `-3`
  suffixes); anything else execs `agy` directly. Single Google account — no
  work/personal split.
- Dashboard: zero changes — `web-term.sh` live list already shows all tmux
  sessions; tab titles come free from global tmux `set-titles`.
- Reaper: `reap-idle-claude` pattern extended to idle interactive `agy-*`
  sessions; **never** `agyh-*` (running handoffs self-terminate via their
  command chain).

## Error handling

| Failure | Behavior |
|---|---|
| agy quota exhausted mid-run | Gate detects failed/empty result → park with worktree+log+conversation_id; resume after Google quota reset |
| Auth token lost (keyring) | Scripts detect auth error on stderr, fail loud: "run `ag` and re-login" |
| Quota endpoint broken | `claude-quota` reports unknown → no auto-delegation; manual still works |
| Reboot kills a handoff session | `agy-handoff list` marks it stale; `resume` re-attaches via `--conversation`. No systemd babysitting in v1 |
| Merge conflict | Park + notify; human or Claude resolves from the worktree |
| Claude ≥70% on both accounts AND agy dry | Park + notify; nothing merges silently |

## Testing

- **e2e-container** (stub `agy` binary emitting canned JSON): shellcheck +
  manifest/render checks; `agy-run` fails loud on empty-success and auth
  errors; `agy-handoff` creates worktree/branch/HANDOFF.md; `agy-gate`
  re-runs verification, parks on red, merges on green, escalates review for
  `big`; reaper never matches `agyh-*`.
- **Live smoke** (post-auth, on the box): `agy -p "ping" --output-format
  json`; auth persistence across fresh shells; one real handoff on a toy repo
  end-to-end through auto-merge.

## Out of scope (v1)

- Adopting agy-bridge or any MCP server (revisit only if the Bash sync path
  feels clunky in practice).
- Remote-control equivalent for agy (web terminal is the multi-device story).
- systemd supervision of handoff sessions; reboot recovery is manual resume.
- Multi-account agy.

## Risks

1. **Keyring/token persistence** on headless Linux — mitigation staged in
   Phase 0; verified before anything else builds on it.
2. **Quota endpoint is undocumented** — mitigated by the estimation fallback
   behind the same interface, and by fail-safe `unknown` semantics.
3. **agy flag drift** (young CLI; docs vs. observed flags already diverge in
   community reports) — mitigated by pinning the verified version in SETUP.md
   and the live smoke test catching breakage on upgrade.
