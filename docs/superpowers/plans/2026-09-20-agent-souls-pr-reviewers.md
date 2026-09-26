# Agent Souls and PR Reviewers Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** One shared soul file referenced by several thin, scoped agent instances — injected on every run and chat turn — and three read-only PR reviewers (h4b-dev, ffwd-org, Paytix) built on it, runnable from the dashboard.

**Architecture:** `mows.soul: <path>` in an instance's frontmatter; `mows-agent-meta` validates it; `mows-agent` appends the file as `## Your role` in both `run_context()` and `chat_context()`, before memory. `mows.budget.chat_usd/chat_turns` override the global chat caps per agent. The soul and instances are files under `agents/souls/` and `agents/examples/`, installed by `install.sh --agents`. The dashboard shows the soul's name. The `mows-agent@.service` template is installed on the box so Run now works.

**Tech Stack:** bash + jq (`agents/bin/mows-agent`), Python 3 (`agents/bin/mows-agent-meta`), Node ESM (`infra/dashboard/*.mjs`), Preact+htm (`app/views/agents.mjs`), bash test harness with a stub `claude` (`scripts/e2e-agents.sh`).

**Spec:** `docs/superpowers/specs/2026-09-20-agent-souls-pr-reviewers-design.md`

## Global Constraints

- Soul: a regular file, non-empty, **≤ 16384 bytes**; path tilde-expanded like `workdir` (spec D3).
- Injection: `## Your role` + soul verbatim, placed **before** `## Your memory` in both contexts (spec §1).
- Chat budget keys: `chat_usd` number `0 < x ≤ 10`; `chat_turns` integer `1..40`; defaults unchanged (`0.25`, `6`) (spec D7).
- The reviewer soul text is spec §2 **verbatim**; instance bodies are scope only (spec D2, §3).
- Reviewer instances: `profile: work`, `tools: [Bash, Read, Glob, Grep]`, `disallowedTools: [Write, Edit, WebFetch, NotebookEdit]`, budget `2.00 / 40 / 6.00 / 20`, chat `1.00 / 12`, no triggers.
- No `/home/<user>` literal in any tracked file — use `~`. No live host literal anywhere.
- Every new behaviour gets a `chk` in `scripts/e2e-agents.sh`; every commit lands green (`preflight` ALL CLEAN, e2e-agents 0 failed).
- Commit trailer: `Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>` / `Claude-Session: https://claude.ai/code/session_01NrdcR8JQHSTudFBHJRT7BF`.

---

### Task 1: Linter — `mows.soul` and the chat budget keys

**Files:**
- Modify: `agents/bin/mows-agent-meta` (`MOWS_KEYS` line 29, `BUDGET_KEYS` line 30, `lint()` near the `workdir` check ~line 176 and the budget block ~lines 185–209)
- Modify: `scripts/e2e-agents.sh` (lint matrix, after `chk "lint: memory enum"`)

- [ ] **Step 1: Write the failing tests** — append after the `chk "lint: memory enum"` line:

```bash
# souls (spec 2026-09-20 D3): a path, tilde-expanded, that must be a non-empty regular file <= 16 KB
printf 'You are a test soul.\nSecond line.\n' > "$T/soul.md"
: > "$T/soul-empty.md"
python3 -c 'print("x" * 20000)' > "$T/soul-big.md"
mkagent "$A/souled.md"   "$(printf '%s\n  soul: %s' "$MOWS_BLOCK_OK" "$T/soul.md")"
mkagent "$A/soulmiss.md" "$(printf '%s\n  soul: %s' "$MOWS_BLOCK_OK" "$T/nope.md")"
mkagent "$A/soulempty.md" "$(printf '%s\n  soul: %s' "$MOWS_BLOCK_OK" "$T/soul-empty.md")"
mkagent "$A/soulbig.md"  "$(printf '%s\n  soul: %s' "$MOWS_BLOCK_OK" "$T/soul-big.md")"
mkagent "$A/souldir.md"  "$(printf '%s\n  soul: %s' "$MOWS_BLOCK_OK" "$T")"
chk "lint: soul present and readable"      'mows-agent lint souled'
chk "lint: soul absent is fine (optional)" 'mows-agent lint good'
chk "lint: soul missing file is an error"  'mows-agent lint soulmiss 2>&1 | grep -q "mows.soul.*does not exist"'
chk "lint: soul empty file is an error"    'mows-agent lint soulempty 2>&1 | grep -q "mows.soul.*empty"'
chk "lint: soul over 16 KB is an error"    'mows-agent lint soulbig 2>&1 | grep -q "16384"'
chk "lint: soul directory is an error"     'mows-agent lint souldir 2>&1 | grep -q "mows.soul.*regular file"'
# chat budget (spec D7)
mkagent "$A/chatb.md"  "$(sed 's/budget: .*/budget: { usd_per_run: 1.5, max_turns: 40, chat_usd: 1.00, chat_turns: 12 }/' <<<"$MOWS_BLOCK_OK")"
mkagent "$A/chatb0.md" "$(sed 's/budget: .*/budget: { usd_per_run: 1.5, max_turns: 40, chat_usd: 0 }/' <<<"$MOWS_BLOCK_OK")"
mkagent "$A/chatt0.md" "$(sed 's/budget: .*/budget: { usd_per_run: 1.5, max_turns: 40, chat_turns: 0 }/' <<<"$MOWS_BLOCK_OK")"
mkagent "$A/chattx.md" "$(sed 's/budget: .*/budget: { usd_per_run: 1.5, max_turns: 40, chat_turns: "x" }/' <<<"$MOWS_BLOCK_OK")"
chk "lint: chat budget accepted"           'mows-agent lint chatb'
chk "lint: chat_usd 0 rejected"            'mows-agent lint chatb0 2>&1 | grep -q "chat_usd"'
chk "lint: chat_turns 0 rejected"          'mows-agent lint chatt0 2>&1 | grep -q "chat_turns"'
chk "lint: chat_turns non-int rejected"    'mows-agent lint chattx 2>&1 | grep -q "chat_turns"'
```

- [ ] **Step 2: Run to verify failure** — `bash scripts/e2e-agents.sh 2>&1 | grep -E "^FAIL: lint: (soul|chat)"` → the `souled`/`chatb` cases FAIL (unknown key), the negative cases FAIL (wrong message).

- [ ] **Step 3: Implement** — in `mows-agent-meta`:

```python
MOWS_KEYS = {"profile", "workdir", "task", "budget", "triggers", "merge", "escalate", "retention_days", "soul"}
BUDGET_KEYS = {"usd_per_run", "max_turns", "usd_per_day", "quota_floor", "chat_usd", "chat_turns"}
SOUL_MAX_BYTES = 16384
```

after the `workdir` check:

```python
    # A soul (spec 2026-09-20 D1/D3): a shared role file appended to every run and chat turn. It
    # is optional; when named it must exist, be a regular file, be non-empty and stay under
    # SOUL_MAX_BYTES — a soul is a role, not a manual, and a missing one must fail here rather
    # than produce an agent that quietly does not know what it is.
    soul = mows.get("soul")
    if soul is not None:
        if not isinstance(soul, str) or not soul.strip():
            E.append("mows.soul must be a non-empty path string")
        else:
            sp = os.path.expanduser(soul)
            if not os.path.exists(sp):
                E.append(f"mows.soul does not exist: {soul}")
            elif not os.path.isfile(sp):
                E.append(f"mows.soul must be a regular file: {soul}")
            elif os.path.getsize(sp) == 0:
                E.append(f"mows.soul is empty: {soul}")
            elif os.path.getsize(sp) > SOUL_MAX_BYTES:
                E.append(f"mows.soul is {os.path.getsize(sp)} bytes; the limit is {SOUL_MAX_BYTES}")
```

inside the budget block, after the `quota_floor` check:

```python
        if "chat_usd" in b and not (is_num(b["chat_usd"]) and 0 < b["chat_usd"] <= 10):
            E.append("mows.budget.chat_usd must be a number in (0, 10]")
        if "chat_turns" in b and not (is_int(b["chat_turns"]) and 1 <= b["chat_turns"] <= 40):
            E.append("mows.budget.chat_turns must be an integer 1..40")
```

- [ ] **Step 4: Run to verify pass** — all ten `lint:` lines PASS; full suite 0 failed.
- [ ] **Step 5: Commit** — `git commit -m "agents: lint knows a soul and a chat budget"` (body: why optional, why 16 KB, why the chat keys).

---

### Task 2: Runner — inject the soul; honour the chat budget

**Files:**
- Modify: `agents/bin/mows-agent` (`run_context`, `chat_context`, `cmd_run` globals, `cmd_chat` budget lines ~553 and ~582)
- Modify: `scripts/e2e-agents.sh`

**Interfaces:**
- Produces: `soul_block <soul-path-or-empty>` (prints `## Your role` + file, or nothing); globals `SOUL` (run) and `CHAT_USD_EFF`/`CHAT_TURNS_EFF` (chat).

- [ ] **Step 1: Failing tests** — append before `echo "### dashboard chat stream…"`:

```bash
echo "### souls: injected into run and chat (spec §1); chat budget per agent (D7)"
echo ok > "$CLAUDE_MODE_FILE"
mows-agent run souled >/dev/null 2>&1
chk "run: appended prompt has the role heading"        'grep -qx "## Your role" "$CLAUDE_ARGS_FILE"'
chk "run: soul text follows it verbatim"               'grep -qx "You are a test soul." "$CLAUDE_ARGS_FILE" && grep -qx "Second line." "$CLAUDE_ARGS_FILE"'
chk "run: role precedes memory"                        '[ "$(grep -nx "## Your role" "$CLAUDE_ARGS_FILE" | cut -d: -f1)" -lt "$(grep -nx "## Your memory" "$CLAUDE_ARGS_FILE" | cut -d: -f1)" ]'
mows-agent run good >/dev/null 2>&1
chk "run: no soul, no role heading"                    '! grep -qx "## Your role" "$CLAUDE_ARGS_FILE"'
mows-agent chat souled --stream "hi" >/dev/null 2>&1
chk "chat: appended prompt has the role heading"       'grep -qx "## Your role" "$CLAUDE_ARGS_FILE"'
chk "chat: role precedes the conversation"             '[ "$(grep -nx "## Your role" "$CLAUDE_ARGS_FILE" | cut -d: -f1)" -lt "$(grep -nx "## The conversation so far" "$CLAUDE_ARGS_FILE" | cut -d: -f1)" ]'
mows-agent chat chatb --stream "hi" >/dev/null 2>&1
chk "chat: per-agent chat_usd reaches argv"            'grep -A1 -x -- "--max-budget-usd" "$CLAUDE_ARGS_FILE" | grep -qx "1.00"'
chk "chat: per-agent chat_turns reaches argv"          'grep -A1 -x -- "--max-turns" "$CLAUDE_ARGS_FILE" | grep -qx "12"'
chk "chat: budget line in the prompt says so"          'grep -q "this turn.s budget: 1.00 USD, 12 turns" "$CLAUDE_ARGS_FILE"'
mows-agent chat good --stream "hi" >/dev/null 2>&1
chk "chat: no override -> defaults in argv"            'grep -A1 -x -- "--max-budget-usd" "$CLAUDE_ARGS_FILE" | grep -qx "0.25" && grep -A1 -x -- "--max-turns" "$CLAUDE_ARGS_FILE" | grep -qx "6"'
```

- [ ] **Step 2: Run to verify failure** — the soul and budget lines FAIL.

- [ ] **Step 3: Implement**

Beside `memory_block`:
```bash
soul_block(){ # soul_block <path-or-empty>: the "## Your role" section (spec 2026-09-20 §1). Nothing when unset.
  [ -n "$1" ] || return 0
  printf '\n## Your role\n'; cat "$(expand_tilde "$1")"; printf '\n'
}
```

In `cmd_run`, after `WORKDIR=…`: `SOUL=$(mget "$M" .mows.soul)`. In `run_context()`, before `memory_block "$AGENT"`: `soul_block "$SOUL"`.

In `cmd_chat`, after `local wd; wd=…`:
```bash
  # Per-agent chat budget (spec D7); the env constants stay the defaults so no other agent changes.
  CHAT_USD_EFF=$(mget "$m" .mows.budget.chat_usd); CHAT_USD_EFF=${CHAT_USD_EFF:-$CHAT_USD}
  CHAT_TURNS_EFF=$(mget "$m" .mows.budget.chat_turns); CHAT_TURNS_EFF=${CHAT_TURNS_EFF:-$CHAT_TURNS}
  local soul; soul=$(mget "$m" .mows.soul)
```
Both claude invocations: `--max-turns "$CHAT_TURNS_EFF" --max-budget-usd "$CHAT_USD_EFF"`. `chat_context` gains a 4th arg (soul path): call `soul_block "$4"` before `memory_block "$n"`, and its budget line prints `"$CHAT_USD_EFF" "$CHAT_TURNS_EFF"`. The `ctx=$(chat_context "$n" … "$wd" "$soul")` call passes it. Note: jq prints `1` for `1.00`; format with `printf '%.2f'` when the value came from the file so argv reads `1.00` (the test asserts the string); the env default `0.25` is already a string.

- [ ] **Step 4: Run to verify pass** — full suite 0 failed. `shellcheck -S error agents/bin/mows-agent` clean.
- [ ] **Step 5: Commit** — `git commit -m "agents: a soul is appended to every run and chat turn; chat budget per agent"`.

---

### Task 3: The soul, the three instances, and install

**Files:**
- Create: `agents/souls/pr-reviewer.md` (spec §2 verbatim)
- Create: `agents/examples/pr-reviewer-h4b.md`, `pr-reviewer-ffwd.md`, `pr-reviewer-paytix.md` (spec §3)
- Modify: `install.sh` (~lines 451–460)
- Modify: `scripts/manifest.txt`

- [ ] **Step 1: Write the files** exactly as the spec gives them. The ffwd body: *"Your organisation is **ffwd-org**. Its repositories are the ticketing platform's buyer and admin backends and frontends; treat payment and checkout paths as PCI-relevant. Local checkouts are under the working directory in `paytix/` and `fun/`."* The paytix body: *"Your organisation is **Paytix** (capitalised as GitHub spells it). Its repositories are payment infrastructure — hosted PSP flows, crypto rails, 3DS; treat every diff as PCI-relevant until you have read it. Local checkouts are under the working directory in `paytix/`."*

- [ ] **Step 2: Lint them the way the runner will** —
`MOWS_PROFILES_JSON=$(jq -nc --arg d "$HOME/.claude" --arg w "$HOME/.claude-work" '{default:$d,work:$w}') agents/bin/mows-agent-meta lint agents/examples/pr-reviewer-h4b.md` — but the soul path in the file is `~/.claude/agents/souls/pr-reviewer.md`, which does not exist until Step 4 installs it. Run Step 4 first on this box, then lint all three: clean.

- [ ] **Step 3: install.sh** — after the `mkdir -p … "$HOME/.claude/agents"` line add `"$HOME/.claude/agents/souls"` to the list; after the harness-reviewer seed block:

```bash
  # Souls are shared role files (spec 2026-09-20): versioned here, installed ALWAYS — a soul is
  # code, not a per-box setting, and an edit must reach every instance that names it.
  install -m644 agents/souls/*.md "$HOME/.claude/agents/souls/"
  echo "installed souls: $(ls agents/souls | tr '\n' ' ')"
  # Instances are seeded only when absent, like harness-reviewer: their frontmatter is the
  # operator's to tune (budget, profile) and must not be overwritten by a reinstall.
  for f in agents/examples/pr-reviewer-*.md; do
    b=$(basename "$f")
    [ -f "$HOME/.claude/agents/$b" ] || { install -m644 "$f" "$HOME/.claude/agents/$b"; echo "seeded ~/.claude/agents/$b"; }
  done
```
Update the header comment (lines 18–20, 46–48) to mention souls and the three reviewers.

- [ ] **Step 4: Install on this box** — `./install.sh --agents` (or the equivalent `install` lines), then `ls ~/.claude/agents/souls/ ~/.claude/agents/pr-reviewer-*.md`, then `mows-agent lint --all` → clean, `mows-agent list` shows the three.

- [ ] **Step 5: manifest, preflight, commit** — `git add -A agents/souls agents/examples install.sh && git ls-files | sort > scripts/manifest.txt`; preflight ALL CLEAN (bash -n + shellcheck on install.sh). Commit: `agents: the pr-reviewer soul and three scoped instances`.

---

### Task 4: Dashboard — the soul's name in Telemetry

**Files:**
- Modify: `infra/dashboard/capability.mjs` (`policy` object)
- Modify: `infra/dashboard/app/views/agents.mjs` (`Telemetry`)

- [ ] **Step 1: `capability.mjs`** — in `policy`, after `model:`:
```js
      // The shared role file this agent names (spec 2026-09-20), as its basename without .md, or
      // null. A name, not the path: the panel says which soul, the operator knows where they live.
      soul: typeof m.soul === 'string' ? m.soul.replace(/^.*\//, '').replace(/\.md$/, '') : null,
```
- [ ] **Step 2: `agents.mjs`** — in `Telemetry`, between Profile and Target: `<${Row} k="Soul" v=${policy.soul} />` (a null soul renders no row — `Row` already does that).
- [ ] **Step 3: Gates** — `node scripts/capability-check.mjs` (170 still), `node scripts/chat-view-check.mjs` (91), preflight ALL CLEAN. Against the live server after Task 5's deploy: `/api/agents/pr-reviewer-h4b | jq .capability.policy.soul` → `"pr-reviewer"`, and the Telemetry card shows a Soul row.
- [ ] **Step 4: Commit** — `dashboard: the Telemetry card names the agent's soul`.

---

### Task 5: The box — unit template, runner, dashboard deploy

**Files:** none in the repo (deployment).

- [ ] **Step 1: Runner + dashboard** — `install -m755 agents/bin/mows-agent agents/bin/mows-agent-meta ~/.local/bin/`; `sudo install -m644 infra/dashboard/lite.mjs infra/dashboard/chat-stream.mjs infra/dashboard/capability.mjs /opt/claude-dashboard/ && sudo cp -r infra/dashboard/app/. /opt/claude-dashboard/app/ && sudo systemctl restart claude-dash-lite`. Back up first as before (`*.bak.pre-souls`).
- [ ] **Step 2: Unit template (spec D9)** — `~/.local/bin/mows-agent render --all` → `rendered/mows-agent@.service` exists; `sudo install -m644 rendered/mows-agent@.service /etc/systemd/system/ && sudo systemctl daemon-reload`; `systemctl cat mows-agent@.service | head -5` prints it. No timers (no triggers).
- [ ] **Step 3: Verify the manual trigger path without spending** — `curl -s -o /dev/null -w '%{http_code}\n' -X POST -H "Origin: http://127.0.0.1:3005" -d 'name=pr-reviewer-paytix&back=/ui/agents/pr-reviewer-paytix' http://127.0.0.1:3005/a/agent-run` → **303**, not 409 (Paytix has 0 PRs, so the run it starts costs one short turn). `journalctl -u mows-agent@pr-reviewer-paytix --no-pager | tail -5` shows the run; `mows-agent last pr-reviewer-paytix` → done.
- [ ] **Step 4:** `/ui/agents` lists three reviewers; `/ui/agents/pr-reviewer-h4b` renders Telemetry with Profile `work`, Soul `pr-reviewer`, Budget `$2.00 / 40 turns`, Daily Cap `$6.00 per day`.

---

### Task 6: The live measurement (spec §7, D4)

**Files:**
- Modify: `docs/superpowers/specs/2026-09-20-agent-souls-pr-reviewers-design.md` (addendum)

- [ ] **Step 1: Run the cheapest scope for real** — from the dashboard's Run now on `pr-reviewer-ffwd` (3 authored PRs), or `~/.local/bin/mows-agent run pr-reviewer-ffwd`. Wait for `done` (`mows-agent last pr-reviewer-ffwd`).
- [ ] **Step 2: Record** — from `~/.local/state/mows-agents/pr-reviewer-ffwd/last/`: `status.json` (state, cost, turns, permission_denials), `result.json` `.permission_denials` (which `gh` calls, if any, were denied), the reply's verdicts, and `memory.md` (is it `owner/repo#n @sha7 verdict` lines?). Grep `stream.jsonl` for write-shaped calls: `grep -oE '"command":"[^"]*gh (pr (review|comment|merge|edit)|api[^"]*-X (POST|PUT|PATCH|DELETE))[^"]*"' stream.jsonl` → must be empty.
- [ ] **Step 3: Decide** — if `gh` reads were **denied**: the reviewers work only from chat (a human present); write that into the spec addendum and SETUP.md as the known limit, and stop before running h4b. If **allowed**: run `pr-reviewer-h4b` once (≤ 5 PRs, ≤ $2) and record the same facts.
- [ ] **Step 4: Addendum** — append to the spec: date, CLI version, per-instance state/cost/denials, memory shape observed, write-call grep result, verdict summary (counts per class, no PR contents). Commit: `spec: souls addendum — first live runs`.

---

### Task 7: Docs

**Files:**
- Modify: `agents/SETUP.md` (new **Souls** section after **Memory**; chat budget sentence in **Chat**)

- [ ] **Step 1: Souls section:**

```markdown
## Souls

A soul is a shared role file: `~/.claude/agents/souls/<name>.md`, plain Markdown, referenced from
an agent's frontmatter as `mows.soul: ~/.claude/agents/souls/<name>.md`. `mows-agent` appends it to
the system prompt as `## Your role` on every run and chat turn, before the agent's memory, so
several agents can carry the same responsibilities with different scopes — the instance body says
only where it works. Lint refuses a soul that is missing, empty, not a regular file, or over 16 KB.
`install.sh --agents` installs every soul in `agents/souls/` (always — a soul is code) and seeds the
example instances only when absent (their budgets are yours to tune).

The first soul is `pr-reviewer`, with three instances: `pr-reviewer-h4b`, `pr-reviewer-ffwd`,
`pr-reviewer-paytix`. Read-only against GitHub by instruction; findings go to the run result, the
agent's memory and Discord, never to the PR. Run them from the dashboard's Run now, or ask them in
chat. See the design spec for what they review and in what order.
```
- [ ] **Step 2: Chat section** — add: *"An agent may set `mows.budget.chat_usd` and `chat_turns` to raise its own chat caps; the defaults stay `$0.25` and 6."*
- [ ] **Step 3:** preflight ALL CLEAN; commit `docs: souls, and the reviewers' chat budget`.

---

## Self-review

**Spec coverage:** D1/§1 → Task 2; D2/§3 → Task 3; D3 → Task 1; D4/§7 live → Task 6; D5/D6 → soul text (Task 3) + observed in Task 6; D7/§4 → Tasks 1–2; D8 → instance files; D9/§6 → Task 5; §5 → Task 4; §8 not-doing — nothing here builds any of it.

**Placeholders:** none. Task 6's addendum is filled from the run, by design.

**Names:** `soul_block <path>`, globals `SOUL`, `CHAT_USD_EFF`, `CHAT_TURNS_EFF`; linter constant `SOUL_MAX_BYTES = 16384`; keys `mows.soul`, `mows.budget.chat_usd`, `mows.budget.chat_turns`; API field `capability.policy.soul`; prompt heading `## Your role` — identical across tasks and tests.

## As executed (2026-09-20)

Tasks 1–7 done in order; e2e 233/0 at the end. Two unplanned commits came out of Task 6's live
runs: `acc478f` (soul: never reproduce a secret's value) and `9c64cf0` (runner: `BLOCKING:` first
line escalates). Task 6 ran all three instances, not only ffwd — the ffwd facts were recorded first,
as the spec required, and h4b ran last at $0.51 under its $2 cap. The measured facts are in the
spec's addendum.

**Same day, after the plan:** the operator reversed the read-only decision; the reviewers now post
one GitHub review per PR (spec Addendum 2). Soul text + instance descriptions + a ten-line
`BLOCKING:` window in `cmd_run` (e2e 235/0). No new plan — a bounded change to the existing flow.
