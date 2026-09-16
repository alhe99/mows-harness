# agents layer — purpose-scoped agents (Layer 6)

What ships: `mows-agent` (the policy runner — lint, run, list, last, logs, prune, render,
residents) and `mows-agent-meta` (the only validator an agent file gets; Claude Code itself
type-checks nothing in file-based frontmatter). An **agent** is a plain Claude Code agent file
(`~/.claude/agents/<name>.md`, or `~/.claude-<profile>/agents/<name>.md`) with a top-level
`mows:` policy block added on top. The Claude daemon owns the *process*; `mows-agent` owns
everything else — budget, refusal, run records, escalation, triggers. Design:
`docs/superpowers/specs/2026-09-15-agents-layer-design.md`.

## One-time setup on a box

1. `./install.sh --agents` (plus `--claude` if you haven't). Installs `mows-agent` and
   `mows-agent-meta` to `~/.local/bin`; seeds `~/.config/mows-agents/config` (mode 600 — it can
   hold webhook secrets) and a real working example, `~/.claude/agents/harness-reviewer.md`.
   `jq` and `python3-yaml` are required; the installer WARNs, not fails, if either is missing —
   `mows-agent` will refuse every lint/run until they're there.
2. Edit `mows.workdir` in `harness-reviewer.md` if this repo doesn't live at
   `~/Documents/Projects/mows-harness`.
3. `mows-agent lint --all` and fix every `ERROR:` line — this is the *only* check an agent file
   gets. `WARN:` lines (e.g. a webhook trigger on an agent that can also write) are advisory.
4. `mows-agent run harness-reviewer` — one bounded run end to end (~$1.50 cap). `mows-agent
   last harness-reviewer` shows the result.

## Manifest — the `mows:` block

| Key | Default | Notes |
|---|---|---|
| `profile` | *(required)* | `default` (`~/.claude`) or any `~/.claude-<suffix>` |
| `workdir` | *(required)* | `cd` target for the run; must already exist |
| `task` | *(required)* | default prompt; a CLI arg to `run` overrides it for that run only |
| `budget.usd_per_run` | *(required)* | → `--max-budget-usd` |
| `budget.max_turns` | *(required)* | → `--max-turns` |
| `budget.usd_per_day` | none | daily spend cap across all runs of this agent |
| `budget.quota_floor` | none | minimum account-quota headroom, 0–100 |
| `triggers[]` | `[]` | `cron` (OnCalendar spec), `path` (absolute path), `webhook` (no extra keys) |
| `merge.policy` | `none` | `pr` pushes the run's branch and opens a PR via `gh` |
| `merge.base` | `main` | base branch for `pr` |
| `escalate.via` | `none` | `discord` posts refusals/failures to `DISCORD_WEBHOOK` |
| `retention_days` | `30` | `mows-agent prune` deletes older run dirs (never `last`) |

## Run lifecycle and exit codes

`mows-agent run <name> [task…]`: lint → refuse if already running / daily cap reached / quota
below floor → `claude -p --agent <name> --permission-prompts none --max-budget-usd …
--max-turns … --strict-mcp-config …` (never `--dangerously-skip-permissions`) → stream-json
parsed live into a status record → on success, `merge.policy: pr` runs if configured.

Exit: `0` done · `3` failed · `4` budget_exceeded · `5` stalled (no stream event for
`STALL_MIN` minutes, default 10 — the whole `claude` process group is killed) · `6` refused
(lint error / already running / daily cap / quota floor) · `64` usage error.

## State dir

`~/.local/state/mows-agents/<name>/`: `last` → symlink to the newest `runs/<run_id>`,
`runs/<run_id>/{status.json,result.json,stream.jsonl,stderr.log,merge.log}`, `events.log`
(refusals, stalls, prunes, merge outcomes). `list`/`last`/`logs`/`prune` only ever read this.

## Budget tiers — what each actually enforces

1. **Per run** (`usd_per_run`/`max_turns`) — passed straight to `claude -p`; always enforced.
2. **Per day** (`usd_per_day`) — summed from today's `result.json` costs before a new run
   starts; refuses (exit 6) once the sum reaches the cap.
3. **Account quota** (`quota_floor`) — checked against `claude-quota --json`'s five-hour/weekly
   percentage for the agent's profile. **Skipped entirely when `claude-quota` isn't installed**
   — a missing optional dependency drops this one guard silently rather than blocking every
   agent on the box.

## Triggers

`mows-agent render <name>|--all` writes systemd units into `./rendered/` — it never installs,
enables, or starts anything. Review, then, by hand:

    sudo install -m644 rendered/mows-agent@.service rendered/mows-agent-*.timer rendered/mows-agent-*.path /etc/systemd/system/
    sudo systemctl daemon-reload
    sudo systemctl enable --now mows-agent-<name>.timer   # or *.path for a path trigger
    systemctl list-timers 'mows-agent-*'                  # confirm NEXT; `mows-agent list` shows it too

A `webhook` trigger needs no timer or path unit at all — only the shared
`mows-agent@.service` installed above — because the dashboard starts that instance directly.

## Webhook setup

1. Add `{ type: webhook }` to the agent's `triggers:` (lint rejects any other key there — the
   secret lives in config, never in the manifest, so it can't leak through a shared repo).
2. Set `WEBHOOK_SECRET_<NAME>` in `~/.config/mows-agents/config` (name upper-cased, `-`→`_`,
   e.g. `WEBHOOK_SECRET_HARNESS_REVIEWER`), mode 600.
3. Install (don't enable a timer for) the shared unit, per Triggers above.
4. On GitHub: repo Settings → Webhooks → Add webhook, payload URL `https://<domain>/wh/<name>`,
   content type `application/json`, secret = the value from step 2.
5. `/wh/<name>` sits **outside** the dashboard's Google OAuth gate on purpose — it's the only
   unauthenticated path on the whole site, because a webhook caller has no browser to redirect
   through an auth flow. The HMAC signature (`X-Hub-Signature-256` from GitHub, or a bare
   `X-Mows-Signature` for anything else — both `sha256=<hex-hmac-of-the-raw-body>`) is its
   *only* authentication. An unknown name and a name with no configured secret both 404
   identically, so a prober can't tell "wrong secret" from "no such agent" from the response.
   The request body is read only to verify the signature and is then discarded — a valid
   signature triggers the agent's own configured `mows.task`, never anything from the payload.

## The `/agents` dashboard tab

List — state, last run, 7-day spend, and a read-only fold of the Claude daemon's own native
background sessions (never mows-agent's; this is display-only, never an action surface).
Detail — recent runs with cost/turns/tools, events, and timer status rolled up from every
`mows-agent-<name>(-N)?.timer` unit (a multi-timer agent reports "mixed" rather than a state
that's only half true). Per-run — status.json plus the run's assistant text. Four actions: run
(`systemctl start --no-block`), pause/resume (mask/unmask *every* timer belonging to the
agent, together, never just the bare one), stop (SIGTERM straight to `-claude_pid`, the
recorded `claude` process's own group — *not* to the runner pid: `mows-agent`'s own `TERM`
trap can't fire while it's blocked reading the stream in the foreground, so signalling the
runner only stops it once `claude` has already exited on its own; the dashboard kills the
`claude` group directly instead). The index is cached 3s per dashboard process.

## Safety posture — read this before trusting "read-only"

- `permissionMode: bypassPermissions` is a hard lint **error**, and `mows-agent run` never
  passes `--dangerously-skip-permissions` regardless of what an agent file asks for.
- Listing `tools: [Bash]` (or any shell-capable tool) makes `disallowedTools: [Write, Edit]`
  advisory, not enforced — a shell can always write via redirection (`echo x > f`).
  **"Read-only" is a property of the agent's own tool list and prompt, not something the linter
  or the runner can guarantee.** Lint only WARNs when a `webhook` trigger (untrusted, no human
  in the loop) is paired with write tools; it has no way to warn about Bash-as-write at all.
- **Precondition, not a caveat: an agent with shell capability that reads a repository
  accepting outside contributions needs a `PreToolUse` write-deny hook, configured before the
  agent ever runs.** The exposure is untrusted content landing in the working directory —
  commit messages, PR bodies, issue text the agent reaches with `git log`/`git show`/`gh`/
  grep — not the trigger type: a `webhook` trigger's request body is authenticated and then
  discarded (see Webhook setup), so it is never fed to the agent and is not the input channel
  at all. A plain `cron`-triggered agent pointed at the same repo carries the identical
  exposure. The lint WARN above (webhook trigger + write tools) is advisory and does not fire
  for the cron case — do not rely on it to catch this.
- `merge.policy: pr` only ever pushes the run's own branch and opens a PR — never merges — and
  lint refuses it up front unless `gh auth status` already passes for this user.
- The quota guard fails **open**: absent or unparseable `claude-quota` output never blocks a
  run. Repeated here because it's the one guard that silently does nothing instead of silently
  refusing.

## Troubleshooting

- `mows-agent last <name>` — state, result text, and the last few events, fastest first look.
- `journalctl -u mows-agent@<name>.service` — once the shared unit is installed, this is the
  systemd side of a run; exit `4`/`6` are policy outcomes (`SuccessExitStatus=4 6`), not unit
  failures, and won't show up as a failed unit.
- `mows-agent logs <name> [run_id] [--raw]` — assistant text only, or `--raw` for the full
  stream-json.
- Lint is the only validator an agent file gets — `mows-agent lint <name>` first for anything
  that looks wrong; Claude Code itself silently accepts a broken `maxTurns` or `memory` value.

## Testing

- **Hermetic matrix** — `bash scripts/e2e-agents.sh` (repo copies) or `BIN_DIR=~/.local/bin
  bash scripts/e2e-agents.sh` (installed copies — run this after every deploy, it catches a
  stale install). Also runs inside `scripts/e2e-container.sh`.
- **Live** — `scripts/live-agents.sh --yes` — one real `claude -p` call against the shipped
  example; costs a little quota, never run by CI.
