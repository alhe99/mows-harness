# Layer 6 — `agents/`: purpose-scoped agents on top of mows-harness

**Date:** 2026-09-15
**Status:** design approved in chat (full-plan-all-phases requested), pending spec review
**Scope:** new top-level `agents/` layer + `install.sh --agents`; additions to
`infra/dashboard/lite.mjs` (Phase 4/5), `infra/caddy/Caddyfile.template` (Phase 5),
`scripts/` test gates (every phase)
**Source brief:** gist `alhe99/5e2d817143463ee53072fe67de6e1aa7` (R&D, Sept 2026). This spec
is the buildable subset of that brief after re-verifying its claims on the reference box
(Claude Code 2.1.273) and pruning the parts that contradicted each other or that we chose
not to ship.

## Problem

mows-harness orchestrates **sessions**: a human opens one, works in it, and the harness keeps
it alive, restarts it, and shows its state. It has no notion of a standing responsibility that
runs *without* a human — "review every PR in this repo", "sweep this box nightly" — with its
own prompt, tools, budget, and schedule. Everything unattended today goes through cron scripts
or the agy delegation layer, neither of which is a Claude agent with memory and a purpose.

Claude Code itself now ships the primitives (verified on the box, 2.1.273): subagent definition
files with a rich frontmatter, `claude -p --agent <name>`, `--max-budget-usd`, `--max-turns`,
`--permission-prompts none`, `--restricted`, a stream-json `result` record with
`total_cost_usd` / `permission_denials` / `terminal_reason`, and `claude agents --json` scoped
per `CLAUDE_CONFIG_DIR`. What no one ships is **policy**: triggers, budgets, escalation, and a
cross-profile view. That is what Layer 6 adds. It never re-implements process supervision.

## Decisions locked

| # | Decision | Why |
|---|---|---|
| D1 | **One file per agent**: the agent *is* `<cfgdir>/agents/<name>.md` with a `mows:` block in its frontmatter. No `agent.yaml`, no `prompt.md`, no render step. | Gist Appendix A proved unknown frontmatter keys load silently and never reach the model. The brief's §5.1 yaml tree contradicted its own appendix; the appendix wins. |
| D2 | **`run` mode only.** One bounded `claude -p` per trigger. No `resident` mode; native background agents are only *surfaced* read-only (Phase 6). | Composes with cron, budgets and structured output. Resident = supervising a supervisor. |
| D3 | **Agent identity = fleet profile** (`CLAUDE_CONFIG_DIR`), never a new Linux user. | Memory, `agents/`, jobs, roster are all scoped per config dir already. `add-agent.sh` has never run for real; v1 does not depend on unproven code. |
| D4 | **Files for run records** under `~/.local/state/mows-agents/<name>/runs/<run_id>/`. No SQLite. | Repo identity is zero-dependency. Records are append-only, read newest-first, per agent. |
| D5 | **An agent owns a domain (usually a repo), not a task.** | Agent memory is keyed by agent name; it only accumulates over recurring territory. If it is not a standing responsibility, it is a `cc` session. |
| D6 | **No dependency on the agy layer.** `merge.policy` is `none` or `pr` (branch + `gh pr create`). `agy-gate`, `agy-handoff`, `agy-notify` are not called. | Owner decision this session: agy is out of scope for Layer 6. Discord posting is a 3-line curl inside `mows-agent`. |
| D7 | **Agent runs are systemd oneshot units, never tmux sessions.** | No human at a keyboard; structured output not a pane; avoids the `reap-idle-claude` prefix trap. |
| D8 | **Timers are staged into `rendered/` and enabled by the human**, same contract as every other layer. | Install never enables a unit. |
| D9 | **Implementation language: bash + jq + a python3 frontmatter helper.** | Matches `agy/bin/*`, `watchdogs/bin/*`. PyYAML ships on Ubuntu 24.04 server (cloud-init dep); install warns if absent. |
| D10 | **First agent shipped as the example: `harness-reviewer`**, a read-only reviewer of the mows-harness repo itself. | Cheapest, safest class (no Write/Edit, no secrets); dogfoods the layer on a public repo. Owner can point it at any repo by editing `mows.workdir`. |

## 1. The manifest

`<cfgdir>/agents/<name>.md` — a normal Claude Code subagent file. Everything above the
`mows:` key is documented Claude Code frontmatter and is passed through untouched. Everything
under `mows:` is read only by `mows-agent`.

```yaml
---
name: harness-reviewer
description: Reviews recent commits on mows-harness for shell safety, secrets, and doc drift
model: sonnet
effort: high
tools: [Read, Glob, Grep, Bash]
disallowedTools: [Write, Edit, WebFetch]
permissionMode: default
maxTurns: 40
memory: user                     # -> <cfgdir>/agent-memory/harness-reviewer/MEMORY.md
mows:
  profile: default               # default | <suffix of ~/.claude-<suffix>>
  workdir: ~/Documents/Projects/mows-harness
  task: >-                       # the prompt given to each run when no task is passed on the CLI
    Review every commit on main since the last run recorded in your memory. Report
    shell-safety issues, leaked identifiers, and README/architecture drift. End with a
    one-paragraph verdict. Update your memory with the newest commit you reviewed.
  budget:
    usd_per_run: 1.50            # -> --max-budget-usd
    max_turns: 40                # -> --max-turns (repeat of maxTurns; the CLI flag wins)
    usd_per_day: 6.00            # enforced by mows-agent: sum of today's total_cost_usd
    quota_floor: 30              # refuse to start if claude-quota says < 30% headroom left
  triggers:
    - { type: cron, spec: "*-*-* 06:00:00" }      # systemd OnCalendar syntax, not crontab
    - { type: path, path: ~/Documents/Projects/mows-harness/.git/refs/heads/main }
    - { type: webhook }                           # Phase 5; secret lives in config, not here
  merge:
    policy: none                 # none | pr
    base: main
  escalate:
    via: discord                 # discord | none   (blocked/failed/budget/stalled always escalate)
  retention_days: 30
---
You are the standing reviewer for the mows-harness repository. ...prompt body...
```

Field rules (`mows-agent lint` enforces; Claude Code will not):

- Required: `name` (== filename stem), `description`, `mows.profile`, `mows.workdir`,
  `mows.task`, `mows.budget.usd_per_run`, `mows.budget.max_turns`.
- Claude fields type-checked: `maxTurns` int, `memory` ∈ `user|project|local`,
  `permissionMode` ∈ `default|acceptEdits|plan|dontAsk|bypassPermissions`, `isolation` ∈
  `worktree|none`, `model` ∈ `sonnet|opus|haiku|inherit` or a full model id, `tools` /
  `disallowedTools` lists.
- `mows.profile` must resolve to an existing config dir; `mows.workdir` must exist.
- `triggers[].type` ∈ `cron|path|webhook`; `cron.spec` validated with
  `systemd-analyze calendar`; `path.path` must be absolute after `~` expansion.
- `merge.policy: pr` requires `gh` on PATH and `Write`/`Edit` **not** in `disallowedTools`.
- `permissionMode: bypassPermissions` is a lint **error** (agents never run with it; see §7).
- Unknown keys under `mows:` are a lint error (typos must not pass silently).

## 2. Layout

```
agents/
  SETUP.md                          # layer doc (same voice as agy/SETUP.md)
  config.example                    # -> ~/.config/mows-agents/config (seeded once, never clobbered)
  bin/mows-agent                    # the CLI (bash)
  bin/mows-agent-meta               # python3: frontmatter -> JSON, plus lint of both namespaces
  examples/harness-reviewer.md      # D10; installed to <default cfgdir>/agents/ only if absent
  (no unit templates: `mows-agent render` emits the service/timer/path units from heredocs)
scripts/e2e-agents.sh               # hermetic matrix, stub claude, throwaway HOME
scripts/live-agents.sh              # one real haiku run, --yes gated, never in CI
```

State on the box (all gitignored, all under the invoking user):

```
~/.config/mows-agents/config                       # DISCORD_WEBHOOK, WEBHOOK_SECRET_<NAME>, STALL_MIN
~/.local/state/mows-agents/<name>/
  runs/<run_id>/stream.jsonl                       # raw stream-json, tee'd
  runs/<run_id>/status.json                        # live, rewritten by the tailer per event
  runs/<run_id>/result.json                        # the final `result` record, verbatim
  runs/<name>/runs/<run_id>/stderr.log
  last -> runs/<run_id>                            # symlink, updated at run start
  events.log                                       # one line per escalation / refusal
```

`run_id` = `YYYYMMDD-HHMMSS-<pid>` (same shape as agy handoff ids; sorts by time).

## 3. `mows-agent` CLI

```
mows-agent list                     # every agent across every profile: name profile last-state last-run next-trigger
mows-agent lint  <name>|--all       # exit 0 clean, 1 errors (printed one per line)
mows-agent run   <name> [task...]   # one bounded run; exit 0 done, 3 failed, 4 budget, 5 stalled, 6 refused
mows-agent last  <name>             # pretty-print last status.json + result summary
mows-agent logs  <name> [run_id]    # cat stream.jsonl assistant text (or --raw)
mows-agent render <name>|--all      # timers/path units -> rendered/ (Phase 3)
mows-agent prune                    # delete runs older than retention_days (Phase 2)
mows-agent residents                # claude agents --json per profile, background kind only (Phase 6)
```

Discovery: `profiles()` is the same rule as `fleet/bin/cc`: `default` = `~/.claude`, plus every
`~/.claude-<suffix>`. An agent is any `<cfgdir>/agents/*.md` whose frontmatter has a `mows:` key.
Duplicate names across profiles are a lint error.

### 3.1 `run`, exactly

1. `lint` the agent; refuse (exit 6) on error.
2. Refuse (exit 6, event logged, escalated) if:
   - today's summed `total_cost_usd` over `runs/*/result.json` ≥ `usd_per_day`;
   - `claude-quota --json` reports the profile's account at `> 100 - quota_floor` % on
     either window (5h or weekly). Unknown quota (exit 2) does **not** refuse.
   - a `status.json` with `state: working` exists for this agent and its `pid` is alive
     (one thread per agent, D5).
3. Create the run dir, point `last` at it, write `status.json` with `state: working`.
4. Exec, in `mows.workdir`, with `CLAUDE_CONFIG_DIR=<profile dir>`:

```bash
claude -p --agent "$name" \
  --output-format stream-json --verbose \
  --permission-prompts none \
  --max-budget-usd "$usd_per_run" --max-turns "$max_turns" \
  --strict-mcp-config ${MCP_CONFIG:+--mcp-config "$MCP_CONFIG"} \
  --append-system-prompt "$(run_context)" \
  "$task" > "$rundir/stream.jsonl" 2> "$rundir/stderr.log" &
tail -n +1 -f --pid=$! "$rundir/stream.jsonl" | tail_loop "$rundir" $!
```

`MCP_CONFIG` comes from `~/.config/mows-agents/config` and is empty by default: with
`--strict-mcp-config` and no config file an agent run loads **no** MCP servers (the interactive
profile's `mcp-interactive.json` spawns a dozen processes per run, which a read-only reviewer
never needs). `--include-partial-messages` is deliberately not passed: it multiplies stream
lines for no run-record value. Claude runs in the background so the tailer knows its pid
(stall kill, `Stop` action); `tail --pid` ends the pipe when claude exits.

`run_context` is a short text block: run id, agent name, profile, workdir, budget, the last
run's state and its result summary. It is appended to the system prompt, never written into
the agent file.

5. `tail_loop` reads stream lines with `read -t $((STALL_MIN*60))`. Per line it updates
   `status.json` `{agent, run_id, session_id, state, started_at, last_event_at, turns,
   cost_usd, tool_calls, permission_denials, pid}`. On read timeout it kills the claude
   process group and sets `state: stalled`. On the `result` record it writes `result.json`
   and sets the final state:

| condition (first match) | state | exit |
|---|---|---|
| `subtype == "success"` and `is_error == false` | `done` | 0 |
| `subtype` or `terminal_reason` contains `budget` | `budget_exceeded` | 4 |
| `subtype` or `terminal_reason` contains `max_turns` | `failed` | 3 |
| read timeout | `stalled` | 5 |
| anything else (`is_error`, api error, no result record) | `failed` | 3 |

6. Any non-`done` state appends to `events.log` and escalates (§5).
7. `merge.policy: pr` (Phase 2): if the workdir is a git repo on a branch other than `base`
   with commits ahead, `git push -u origin HEAD && gh pr create --fill --base "$base"`.
   Anything else is a no-op with a logged event. Agents never commit to `base` directly; the
   example agent's prompt and its `disallowedTools` make it read-only anyway.

### 3.2 Why no `--bare`

`--bare` skips agent discovery and, on this box, OAuth (verified: "Not logged in" under
`--bare`, fine without it). The runner needs `--agent`, so it never passes `--bare`.

## 4. Budget — three tiers

1. **Per run** — `--max-budget-usd` + `--max-turns`. Enforced by the CLI; subagent spend counts.
2. **Per agent per day** — `mows-agent run` sums `total_cost_usd` from today's `result.json`
   files before launching. The one tier no vendor provides.
3. **Per account** — `quota_floor` via the existing `claude-quota --json` (agy layer script,
   read-only reuse of the *binary* if installed; if `claude-quota` is absent the check is
   skipped with a WARN line — D6 forbids a hard dependency). Its JSON is keyed
   `personal` / `work`; profile `default` maps to `personal`, any other profile to its own name.

## 5. Escalation

`escalate.via: discord` posts `{"content": "<name> <run_id>: <state> — <one-line reason> · <cost>"}`
to `DISCORD_WEBHOOK` from `~/.config/mows-agents/config` with one `curl -fsS --max-time 10`.
Silent no-op when the webhook is unset; `events.log` is written regardless. Escalates on:
`failed`, `budget_exceeded`, `stalled`, every `refused` reason. `done` is silent.

## 6. Triggers (Phase 3, Phase 5)

- **cron** → `rendered/mows-agent-<name>.timer` (`OnCalendar=<spec>`, `Persistent=true`,
  `RandomizedDelaySec=2m`) + one shared `rendered/mows-agent@.service`
  (`Type=oneshot`, `User={{ADMIN_USER}}`, `ExecStart=/home/{{ADMIN_USER}}/.local/bin/mows-agent run %i`,
  `TimeoutStartSec=` from `max_turns * 3min`, `UnsetEnvironment=ANTHROPIC_API_KEY`).
  Install prints the `sudo install … && systemctl daemon-reload && systemctl enable --now …`
  line and does nothing itself, same as `claude-remote@.service`.
- **path** → `rendered/mows-agent-<name>.path` with `PathChanged=` and `Unit=mows-agent@<name>.service`.
- **webhook** → `POST /wh/<name>` on the dashboard (`lite.mjs`), verified with
  `X-Mows-Signature: sha256=<hmac>` (or GitHub's `X-Hub-Signature-256`, same format) over the
  raw body against `WEBHOOK_SECRET_<NAME>` (config, upper-cased name, `-`→`_`). Constant-time
  compare. On success it runs `systemctl start --no-block mows-agent@<name>.service` (the
  Phase 3 unit; the dashboard runs as root) and replies 202;
  the body is **never** passed to the agent (untrusted input; the agent reads state from its
  workdir instead). Caddy: a `handle /wh/*` before `forward_auth` so GitHub can reach it
  without Google login; the HMAC is the auth. Rate limit: one in-flight run per agent (§3.1
  step 2 already refuses a second).

## 7. Safety posture

- Every run: `--permission-prompts none` (denied, not skipped), `--strict-mcp-config`,
  `UnsetEnvironment=ANTHROPIC_API_KEY`. Never `--dangerously-skip-permissions`; lint rejects
  `bypassPermissions`.
- Read-only agents (the shipped example): `disallowedTools: [Write, Edit, WebFetch]`. The
  lint prints a WARN when an agent has both a write tool and a webhook trigger (lethal
  trifecta: untrusted trigger + write capability).
- Webhook payloads are authenticated and then discarded.
- Agent runs inherit the profile's OAuth credentials, so the profile is the trust boundary.
  Running an agent for a repo you would not open interactively in that profile is the wrong
  profile.
- The `Stop` hook kill switch and containers are **not** in v1; `_tail`'s stall kill and the
  CLI's own turn/budget caps are the enforcement.

## 8. Dashboard `/agents` (Phase 4)

- Fifth tab in both nav variants (`lite.mjs:2014-2025`). **Note:** the fleet-redesign spec
  pinned the nav at exactly four content tabs (terminal is a FAB, not a tab). Agents is a
  content page with its own data, so it becomes the fifth; the mobile tab bar must be checked
  at 375 px in the qa journey. If it does not fit, Agents nests under System instead. Routes: `/agents` (list),
  `/agents/<name>` (manifest summary, last 20 runs, cost total 7d, next timer via
  `systemctl list-timers --all mows-agent-<name>.timer`), `/agents/<name>/<run_id>` (rendered
  assistant text from `stream.jsonl`, plus `status.json`).
- Actions, POST → 303 like `/a/*`: **Run now** (`systemctl start --no-block mows-agent@<name>`),
  **Pause** / **Resume** (`systemctl mask|unmask mows-agent-<name>.timer`), **Stop**
  (`kill -TERM -<pgid>` from `status.json.pid`).
- Data: read `~/.local/state/mows-agents/*/` on request with a 3 s cache. No new SSE stream;
  an `agents` key is added to the existing `/events` snapshot only if the list page is open
  (`fleet.js` ignores it elsewhere).
- Add `/agents` and `/agents/*` to the speculation rules; exclude `/agents/*/*` (run stream).
- Sort: `working` first, then `stalled|failed|budget_exceeded`, then `done`, ties by
  `last_event_at` desc. Same "needs you floats up" rule as Sessions.
- Residents (Phase 6): `mows-agent residents` output rendered under a collapsed
  "Native background sessions" fold, filtered: drop records whose `cwd` starts with
  `~/.claude-mem/observer-sessions`.

## 9. Install contract

`install.sh --agents` (and `--all`): installs `agents/bin/*` to `~/.local/bin`, seeds
`~/.config/mows-agents/config` if absent, seeds `~/.claude/agents/harness-reviewer.md` if absent
(never overwrites a user-edited agent), creates `~/.local/state/mows-agents`, renders the
service template into `rendered/`, prints the sudo lines, warns if `jq`, `python3 -c 'import yaml'`,
or `gh` are missing. Idempotent, backs up like every other layer.

## 10. Test strategy (every phase has a gate; Phase 7 is the integration gate)

- **`scripts/e2e-agents.sh`** — hermetic, safe on a live box, also called from
  `e2e-container.sh`. Throwaway `HOME`, a **stub `claude`** on PATH that emits a scripted
  stream-json transcript chosen by `CLAUDE_MODE_FILE` (`ok | budget | maxturns | error |
  hang`), a stub `claude-quota` (`QUOTA_PCT_FILE`), a stub `curl` capturing Discord posts, a
  stub `systemd-analyze`. Asserts: lint matrix (each rule above, positive and negative), run
  state table (all five rows), daily-cap refusal, quota-floor refusal, concurrent-run refusal,
  stall kill, escalation posted exactly once, run_context contents, `render` output shape,
  `prune`, `list` columns, webhook HMAC accept/reject (Phase 5, against a spawned `lite.mjs`
  with `MOWS_AGENT_BIN` stubbed).
- **`scripts/live-agents.sh --yes`** — one real `haiku` run of a throwaway agent with
  `usd_per_run: 0.05`, `max_turns: 1`, task "Reply with exactly OK". Asserts `state: done`,
  `total_cost_usd > 0`, memory dir created. Costs ~$0.05. Never in CI.
- **`scripts/e2e-container.sh`** — add `--agents` to the install line; replace the hardcoded
  `skills == 13` / `commands == 9` asserts with counts derived from the repo tree; assert
  `mows-agent list` shows `harness-reviewer` and `mows-agent lint --all` is clean.
- **`scripts/preflight.sh`** — unchanged logic; every new file is listed in
  `scripts/manifest.txt`; `shellcheck` on the new bash if it is already run there.
- **Dashboard** (Phase 4/5): a headless journey `docs/qa/journeys/agents-tab.md` per the qa
  skill: tab visible, list renders the example agent, detail opens, run-now returns 303, a
  bad-HMAC webhook returns 401.

## 11. Phases and gates

| Phase | Deliverable | Gate to pass before the next |
|---|---|---|
| 1 | `mows-agent lint/run/list/last/logs`, `_tail`, run records, example agent, `install.sh --agents`, `e2e-agents.sh` core matrix | e2e green; one real run by hand (`live-agents.sh --yes`) shows `done` |
| 2 | Budget tiers 2+3, `prune`, escalation, `merge.policy: pr` | e2e: refusal + escalation cases green; a manual over-budget run refuses and posts |
| 3 | `render` → timers / path units, service template, install prints sudo lines | one timer enabled on the box fires `harness-reviewer` unattended for 3 days with no human input |
| 4 | `/agents` tab: list, detail, run stream, run-now, pause, stop | qa journey green; tab shows the 3-day history from Phase 3 |
| 5 | Webhook ingress + Caddy carve-out | a GitHub push webhook on the harness repo triggers one run; bad signature is 401 |
| 6 | `residents` + the dashboard fold | e2e: filter drops observer sessions; fold renders the work profile's blocked job |
| 7 | **Test & release**: e2e-container update, README + `docs/architecture.md` layer 6 section, `agents/SETUP.md`, tag | `preflight ALL CLEAN`, `e2e-container.sh` green, README quickstart mentions `--agents` |

## 12. Not doing (explicitly)

- `mode: resident`, a supervisor, restart-on-crash, `attach` — the daemon's job.
- SQLite, an OTLP exporter, tracing.
- Containers / `sandbox-runtime`. Revisit only for an agent that must take untrusted input
  *and* write.
- The agent-per-Linux-user model.
- Any change to `agy/*`.
- Passing webhook bodies to agents.

## Risks

- **Claude Code flag drift.** `--permission-prompts`, `--max-budget-usd`, the `result`
  record shape are 2.1.2xx features. `lint` checks `claude --version >= 2.1.217` once and
  `e2e-agents.sh` pins the stub's record shape to what 2.1.273 emits (captured this session:
  `subtype`, `is_error`, `terminal_reason`, `num_turns`, `session_id`, `total_cost_usd`,
  `permission_denials`, `result`). `live-agents.sh` is the canary after upgrades.
- **Frontmatter is not validated by Claude Code.** Mitigated entirely by `lint`, which runs at
  the top of every `run`.
- **Profile staleness in the dashboard.** `discoverAccounts()` runs once at startup
  (`lite.mjs:79`); the agents index must rescan the state dir per request (cached 3 s), not
  at startup, or new agents look missing until a restart.
- **Timers on a rebooted box.** `Persistent=true` fires missed runs on boot; combined with
  the daily cap this is bounded.
- **`gh` auth in a oneshot unit.** `merge.policy: pr` needs `gh auth status` to pass as the
  admin user with no TTY; lint checks it when the policy is `pr`.
