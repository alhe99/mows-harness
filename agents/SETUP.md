# agents layer — purpose-scoped agents (Layer 6)

What ships: `mows-agent` (the policy runner — lint, run, chat, list, last, logs, prune,
render, residents) and `mows-agent-meta` (the only validator an agent file gets; Claude Code itself
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

## Chat — a question to the agent, any time

`mows-agent chat <name> [--stream] <message…>` · `--history` · `--clear`

A chat turn is not a new run, and since 2026-09-19 it does not resume one either. Each turn is
a fresh, bounded `claude -p --agent <name>` whose system prompt is extended with the agent's
memory (see **Memory** below) and the last 12 entries of `chat.jsonl`, each cut at 2000
characters. The agent knows who it is and what was just said without any Claude session
surviving between turns — so nothing depends on Claude Code's 30-day transcript retention, and
nothing grows from turn to turn. It refuses only while a run is in flight (both would write
`memory.md` when they finish). An agent that has never run can be asked what it would do. Each
turn is capped at `$0.25` and 6 turns — a question, not a work session — and times out at 300 s.
The transcript `mows-agent` keeps is `~/.local/state/mows-agents/<name>/chat.jsonl`; `prune`
keeps its last 200 entries, and `--clear` deletes it and leaves `memory.md` untouched.
An agent may set `mows.budget.chat_usd` and `chat_turns` to raise its own chat caps; the
defaults stay `$0.25` and 6.

**`--stream`** makes the turn emit one compact JSON line per token delta (`{"seq":N,"delta":"…"}`)
and a final `{"end":true,…}`, instead of printing the finished reply as text. It is recognised
**only as the very first argument after `<name>`** — as positional as `--history` and `--clear`
are. `mows-agent chat x hello --stream` sends the literal text `hello --stream`, and a typo
(`--strem`) is likewise message text rather than an error. That is deliberate, not an oversight:
a chat message may legitimately begin with `--` (the dashboard passes a form field straight
through, and `mows-agent` guards it with a leading space and a `--` terminator so it can never be
read as a flag by `claude`), so a parser that rejected unrecognised leading `--tokens` here would
have to reject that too, reintroducing the hole the guard exists to close.

The dashboard's chat view is the only production caller of `--stream`; it spawns
`~/.local/bin/mows-agent` **by absolute path** and parses those lines into the SSE feed the
browser renders. Two consequences worth knowing before a deploy:

- **Unattended runs deliberately do not stream.** `mows-agent run` has no `--stream` and is not
  getting one. The flag is per-mode because streaming multiplies the lines written to
  `stream.jsonl` for no run-record value: a run is judged by its result, cost and turns, which
  the result record already carries, and a human is watching a chat turn but not a 3 a.m. timer.
- **A stale installed `mows-agent` un-streams chat silently.** A copy predating this flag treats
  `--stream` as the first word of the message — the agent is asked ` --stream <msg>` and
  `chat.jsonl` records that as your question — and returns the reply as plain text the dashboard
  cannot parse, so the view sits on "Thinking…" and the reply appears only on the next load. The
  only trace is `dropped N malformed stream line(s)` in `journalctl -u claude-dash-lite`. Check
  after any deploy: `grep -c -- --stream ~/.local/bin/mows-agent` (expect > 0). Deploying the
  dashboard and this CLI together is covered in "Deploying this change" in
  `../docs/architecture.md`.

## Memory

Each agent has one file: `~/.local/state/mows-agents/<name>/memory.md`. It is injected into
every run and every chat turn as a `## Your memory` section of the system prompt, and refreshed
from every reply: the agent ends with a fenced ```` ```mows-memory ```` block and `mows-agent`
stores the block as the **whole** file. No block leaves it untouched; an empty block clears it
(logged as `memory cleared by agent`). The agent never writes the file itself and needs no
`Write` tool for this — both shipped agents deny `Write`, and the alternative would be Bash
redirection, the exact thing the capability panel exists to warn about.

Hard cap **4096 bytes / 60 lines**, whichever first; overflow is cut at a line boundary, the
truncated file is still written, and `events.log` gets `memory truncated: <N> bytes / <M> lines
offered, cap 4096/60`. Every store is logged (`memory stored: <bytes> bytes, <lines> lines`), so
the Events disclosure on the dashboard is the memory's history. Read it with `cat`, edit it with
`$EDITOR`; the dashboard shows it read-only under **Memory**. `prune` never touches it.

**A memory can hold a wrong belief, and it will act on it.** Measured live: a turn whose Bash
command was refused wrote "bash is blocked, no approval surface" into its memory, and the next
turn read that first and did not try. That is the file doing its job on the wrong fact. When an
agent seems to have given up on something it can do, read `memory.md` before anything else — and
fix it there, or have the agent emit an empty `mows-memory` block to start clean.

Before this, `memory: user` in the frontmatter was assumed to make Claude Code persist a
per-agent memory. It does not — that field scopes Claude Code's *project* memory, keyed by
working directory — and `harness-reviewer` ran with no memory at all. The field stays (it is a
real Claude Code setting) but it is not what "your memory" refers to in an agent's task.

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
chat. See the design spec for what they review and in what order. Run now needs the shared
`mows-agent@.service` template installed (Triggers, above) — without it the button answers 409.

## State dir

`~/.local/state/mows-agents/<name>/`: `last` → symlink to the newest `runs/<run_id>`,
`runs/<run_id>/{status.json,result.json,stream.jsonl,stderr.log,merge.log}`, `events.log`
(refusals, stalls, prunes, merge outcomes, memory stores), `memory.md` (see **Memory**),
`chat.jsonl` (the chat transcript; `prune` keeps its last 200 entries). `list`/`last`/`logs`/`prune` only ever read this.

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

## The dashboard: `/agents` (server-rendered) and `/ui/agents` (the app)

Both ship. `/agents` is the HTML twin and is retired only after `/ui/agents` has run on the box
for a week; until then they read the same run records and either one is a correct answer. The
app adds two things the HTML twin cannot do: a chat transcript that streams token-by-token over
`GET /stream` instead of reloading the page per turn, and the capability panel below.

### The capability panel, and what it is careful not to say

It reports **effective** capability — what the agent's frontmatter actually grants, after the
deny list is subtracted — never the deny list as written. That distinction is the entire point,
and flattening it back into "shows what the agent can do" would undo the panel. Concretely:

- An agent with **no `tools:` key inherits every tool the main thread has, Bash included**. The
  file that looks most restricted is the least restricted, so the panel says "inherits" rather
  than rendering an empty, reassuring tool list.
- It names **kinds of authority**, not one boolean: `shell`, `subagent` and `command` reach past
  the tool list entirely (Bash runs anything; `Task` hands a subagent its own list; a slash
  command's frontmatter can carry `allowed-tools: Bash`), while `write` and `network` are real
  authority bounded by the list. `tools: [Read, Write, Edit, WebFetch]` is not quiet.
- It names **unknown reach instead of guessing**. An `mcp__*` tool reaches whatever its server
  reaches — the network, a filesystem, a production database — and none of that is knowable from
  the name, so it is reported as unknown rather than classified in either direction. Tools it
  does not recognise at all, and tool names that differ from a real one only in case
  (`tools: [read, bash]` names two tools that do not exist), are reported the same way.
- It says when a **deny list does nothing** (`disallowedTools` naming tools the allow list never
  granted — decoration, not safety work) and, the mirror case, when the agent looks quiet **only
  because** the deny list removed an authority tool.
- It states, rather than silently resolving, the things it cannot: `permissionMode` as declared
  (it cannot verify the CLI honours it), a disagreement between `maxTurns` and
  `mows.budget.max_turns` (which one binds is a CLI precedence question this page cannot answer),
  and whether a `WEBHOOK_SECRET_<NAME>` is configured — because `/wh/<name>` authenticates
  against that key alone and never reads the agent file, so a configured secret means an HTTP
  POST can start the agent whether or not its declared triggers say so.
- Unreadable input **rounds toward unrestricted, never toward restricted**. `tools: 42`,
  `tools: ''` and `tools: ['']` are all reported as unreadable rather than as "no tools". An
  explicit `tools: []` is a different statement and stays a real restriction.

`scripts/capability-check.mjs` gates all of this from `preflight.sh` and fails rather than skips
when it cannot run. **Not verified:** what the Claude Code CLI itself does with `tools: ''` —
nobody has measured it. The panel and `mows-agent-meta` are known to read it differently (the
panel calls it unreadable, the validator calls it the empty list); neither reads a *tool* out of
it, which is the property the gate asserts.

### What each page shows

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
- **The panel and the chat view** — gated from `scripts/preflight.sh`, which runs
  `scripts/capability-check.mjs` (the capability panel's honesty assertions) and
  `scripts/chat-view-check.mjs` (the chat renderer's XSS/rendering assertions). Both *fail*
  rather than skip when they cannot run.
- **In a real browser** — `docs/qa/probes/` is the scripted form of
  `docs/qa/journeys/agent-chat.md` and is where the **WebKit** evidence for `/ui/agents` comes
  from: streaming, scroll anchoring, a mid-turn SSE reconnect, and the CSP refusing an injected
  handler. Not a gate and deliberately not wired into preflight — it needs a Playwright install
  this repo does not own. Without one every probe SKIPs and prints the install command; see
  `../docs/qa/probes/README.md`, which also lists what the probes **cannot** show (a real
  on-screen keyboard, real Safari, a real agent turn, HTTP/2).
