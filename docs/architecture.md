# Architecture

Technical reference for the five layers this harness ships. Start with
[`README.md`](../README.md) for the "which layer do I need" overview; this document is the
detail underneath it — port map, the profile-vs-agent model, why the dashboard runs as root,
watchdog rationale, and the operational caveats worth knowing before you rely on any of it.

## Layer map

| Layer | Install flag | Key paths | What it is |
|---|---|---|---|
| 1. claude | `--claude` | `claude/{CLAUDE.md → global/,rules,agents,commands,skills}`, `claude/settings.template.json`, `claude/mcp.template.json` | The agentic config itself, copied into `~/.claude`; also loadable as a standalone plugin (`.claude-plugin/marketplace.json`, `claude/.claude-plugin/plugin.json`) |
| 2. watchdogs | `--watchdogs` | `watchdogs/bin/*`, `watchdogs/crontab.example`, `watchdogs/logrotate.d/` | Six cron scripts supervising the remote-control fleet |
| 3. infra | `--infra` | `infra/{caddy,oauth2-proxy,dashboard,webconsole,qa-watch,droid,systemd,os}/` | Templates for the public web surface — staged into `./rendered/` for review, never installed/enabled/started by `install.sh` itself |
| 4. fleet | `--fleet` | `fleet/bin/{cc,claude-rc,claude-status,reset-claude-env}`, `fleet/add-agent.sh` | Multi-identity tooling: the profile model (one admin account, N config dirs) and the agent model (N Linux-user accounts) |
| 5. agy | `--agy` | `agy/bin/{ag,agy-run,agy-handoff,agy-gate,claude-quota}`, `agy/config.example` | Antigravity (agy) delegation bridge: synchronous (`agy-run`) and fire-and-forget worktree handoffs (`agy-handoff`/`agy-gate`) with re-run verification, review escalation, and auto-merge policy; `claude-quota` is the 70% delegation-trigger signal |

## Port map

| Port | Bound to | Service | Notes |
|---|---|---|---|
| 443 | public | Caddy | TLS termination + reverse proxy — the only thing this box exposes to the Internet and the only thing that terminates TLS |
| 3005 | 127.0.0.1 | dashboard (`infra/dashboard/lite.mjs`) | Reached only via Caddy; PWA-installable session list, `/term` companion, QA-watch view |
| 7681 | 127.0.0.1 | `ttyd` (`/term`) | Only `/term/ws` and `/term/token` reach `ttyd` through Caddy's `reverse_proxy`; plain `GET /term` and `/term/` are intercepted earlier and served by Caddy's own `file_server` from `term-index.html` (see `infra/webconsole/make-term-index.sh`) |
| 4180 | 127.0.0.1 | oauth2-proxy | Caddy's `forward_auth` target for every protected route, plus a `reverse_proxy` for `/oauth2/*` |
| 2019 | 127.0.0.1, loopback-only | Caddy's admin API | Never configured by `infra/caddy/Caddyfile.template` at all — Caddy's own factory default is to bind its admin endpoint to `localhost:2019` and refuse non-loopback access; nothing in this repo changes that default, so it stays loopback-only for free |
| 6080 | 127.0.0.1, **on-demand** | websockify → noVNC | Only up while `claude-qa-watch` is running; reached publicly only through Caddy's `/vnc/*` route, behind the same Google OAuth gate as everything else |
| 9222 | 127.0.0.1, **on-demand** | Chrome remote debugging (CDP) | Only up while `claude-qa-watch` is running; never exposed outside loopback — agent MCP tools (`chrome-devtools-watch`, `playwright-watch`) attach here directly, a human never touches this port |
| 8000 | 127.0.0.1, optional | ws-scrcpy (`infra/droid/`) | Android web console; reached publicly only through Caddy's `/droidview/*` route and the optional `droid.<domain>` vhost, behind the same Google OAuth gate — absent entirely unless the droid stack is installed |
| 6555 | 127.0.0.1, optional | redroid's adb (Docker port map) | The Android container's adb endpoint, mapped outside adb's 5555+ emulator scan range so the device appears exactly once; loopback-only, adb/maestro/ws-scrcpy talk to it locally |

## Profile model vs. agent model

Two unrelated ways to run more than one Claude Code identity on the same box:

- **Profile model** (`fleet/bin/{cc,claude-rc,claude-status,reset-claude-env}`) — **one**
  Linux user (typically the admin) running N named *profiles*: `default` (`~/.claude`) plus
  any `~/.claude-<suffix>` directory.
- **Agent model** (`fleet/add-agent.sh`) — **N separate Linux user accounts**, one per
  agent, each with its own home and its own real `~/.claude` copy.

### Fidelity, stated plainly

The profile model was **extracted from, and validated against, a real working reference
box** — every script under `fleet/bin/` carries a header comment documenting the exact live
behavior it replaced. The agent model was **designed fresh for this repo. No live
precedent.** As of this writing it has never run for real, not even once, on the reference
box — validated only via `bash -n`/`shellcheck`, `DRY_RUN=1` transcripts, and rendered-copy
`visudo -cf`/`systemd-analyze verify`.

Both are reasonable, carefully-reasoned designs. Only one of them has production mileage
behind it, and "carefully reasoned" and "battle-tested" are different claims — this document
will not blur them. If you're choosing between the two for a real deployment, that
difference should drive the choice, not which one happens to be documented first.

They are also **not interchangeable**: a profile is a config directory under an account you
already trust with everything else on the box; an agent is its own account, its own home,
its own optional systemd unit. Pick per identity based on how much isolation you actually
want. Full walkthrough, including why each model needs its own systemd-unit family and its
own sudoers file: [`fleet/SETUP.md`](../fleet/SETUP.md).

### Symlinks stop at every profile/agent boundary, on purpose

Two independent guards enforce the same rule from different directions:

- `infra/systemd/claude-transcript-prune.sh` explicitly skips any discovered profile root
  that turns out to be a symlink (`[ -L "$d" ] && continue` — a CWE-59 guard) so a symlinked
  profile directory can never trick the pruner into operating outside its intended
  boundary, or double-acting on one real target reached through two apparent profile paths.
- `fleet/add-agent.sh` never symlinks an agent's config from the repo or from another
  account. Cross-user symlinks generally don't even resolve, and where they technically
  could, sharing inodes across a trust boundary defeats the point of a separate account —
  so it always does a real, re-synced copy instead (removed and recopied each run, so a
  file dropped upstream actually disappears from the agent's copy too).

Net effect: nothing in this harness ever shares config across a profile or agent boundary
via symlink. Every profile and every agent gets its own real files, always.

## The dashboard runs as root, by design

`claude-dash-lite.service.template` sets `User=root` deliberately, not as an oversight.
`infra/dashboard/lite.mjs` reads Claude session transcripts under **every discovered
account's** home directory (`discoverAccounts()`, scanned once at process start) — including
other Linux logins' `0700`/`0750` homes, which only root can traverse. Running the unit as
any single one of those accounts would silently drop every *other* account from the
dashboard (its own profile visible, everyone else's missing) — this is the shipped design,
verified on a real multi-account box, not an accident.

**What this exposes:** root's own `~/.claude` sessions become visible to every authenticated
dashboard viewer, the same as any other discovered account. Anyone who passes the Google
OAuth gate in front of the dashboard can browse every account's session transcripts,
resume/pause/kill anyone's live tmux session (on the one tmux server the dashboard drives —
see `TMUX_USER` below), and reach the QA watch-browser takeover view. That is the tradeoff
of a single-process, zero-client-JS dashboard that needs visibility across account
boundaries in the first place — narrow who can pass the OAuth gate
(`infra/oauth2-proxy/emails.txt.template`) accordingly; there is no per-account visibility
control inside the dashboard itself.

Three consequences worth internalizing:

- **Discovery is startup-only.** `discoverAccounts()` scans `/home/*` (plus root's own
  `$HOME`, since `/root` isn't under `/home` at all) exactly once, at process start.
  Provisioning a new profile or agent does not make it appear until the dashboard unit
  restarts: `sudo systemctl restart claude-dash-lite` (unit name per
  `claude-dash-lite.service.template`).
- **A profile/agent needs a `projects/` directory to appear in the dashboard at all**, and
  that directory doesn't exist until the account's first real Claude Code session creates
  it. This is the same filter that keeps unrelated `.claude-*` dotfiles/caches (a
  credentials file, a template cache, the claude-mem plugin's store) from showing up as
  bogus accounts — not a bug, but it does mean "restart the dashboard" alone isn't enough
  for an account that has never actually run a session yet.
- **One tmux server, one `TMUX_USER`.** The dashboard drives exactly one tmux server — the
  first non-agent (human, profile-model) login discovered — so only that account's sessions
  get the "resume in terminal"/pause/kill/attach affordances. Agent-model accounts
  (`agent`/`agent-<label>`) are display-only in the dashboard for the same reason they're
  excluded from `TMUX_USER` contention.

## Watchdog rationale

Six cron scripts (`watchdogs/bin/*`), all profile-agnostic (discover `default` + every
`~/.claude-<suffix>` dir dynamically) and all no-ops on a box with nothing matching yet:

| Watchdog | Watches | Cadence | Recovery action |
|---|---|---|---|
| `claude-health` | Is `claude-remote@<profile>` active? Any established backend connection? | `*/5 * * * *` | Sustained-WEDGED ≥8min → `reset-claude-env <profile>` + unit restart, rate-limited to once per 2h (disable per-profile via `~/.local/state/claude-health.norecover`) |
| `claude-mem-health` | claude-mem's shared memory worker on `:37777`; each profile's `installed_plugins.json` scope; transcripts with real user turns that never produced an `sdk_sessions` row | `*/10 * * * *` | Self-heals plugin scope back to `user`; flags worker/transcript anomalies (does **not** start the worker itself — claude-mem's own plugin hooks own that) |
| `reap-idle-claude` | Detached `cc-<profile>-*` tmux sessions | `17 * * * *` | Kills sessions idle beyond `$IDLE` seconds (24h default) — spares any pane showing a usage-limit banner, since the shield revives it once the reset passes |
| `reap-mcp-orphans` | MCP server processes reparented to init (`ppid==1`, age > 5 min) | `*/15 * * * *` | Kills the orphan — excludes tmux/claude/remote-control processes so a daemonized tmux server hosting a live session is never mistaken for one |
| `claude-limit-shield.sh` | tmux panes stalled on a usage-limit banner past its own parsed reset time | `*/5 * * * *` | Types a continue-nudge into the pane; `claude-limit-shield.sh selftest` runs an end-to-end check in a disposable session any time |
| `log-boot` | Boot events | `@reboot` | Appends one line (kernel version + uptime) to `~/.local/state/boot-log.txt` — pure logging, no recovery action |

Dependencies, log locations, and logrotate detail: [`watchdogs/SETUP.md`](../watchdogs/SETUP.md).

## Known operational caveats

- **Dashboard discovery is startup-only** (see above) — restart `claude-dash-lite` after
  provisioning a new profile or agent, or after its first real session finally creates a
  `projects/` directory.
- **A profile/agent needs a `projects/` dir to appear** in the dashboard at all — it doesn't
  exist until that account's first real Claude Code session.
- **`reset-claude-env` reads the *static* `WorkingDirectory=`, which can go stale relative
  to a live `claude-rc workdir --now` repoint.** `claude-remote@.service`'s `ExecStart`
  re-roots each *new* session at the path in `$HOME/.config/claude-rc/<profile>.workdir`
  when that hint file exists (written by `claude-rc workdir <profile> <path>`), falling back
  to the unit's own `WorkingDirectory=` otherwise. But `WorkingDirectory=` itself is a
  static property of the installed unit file — `systemctl show -p WorkingDirectory`, which
  `fleet/bin/reset-claude-env` reads for its cached-env-pointer recovery, only ever reflects
  what was rendered into the unit at install time, never a later `workdir --now` repoint.
  Concretely: repoint a profile's live session elsewhere with
  `claude-rc workdir <profile> <path> --now`, then let a wedge later trigger
  `reset-claude-env` — its recovery path is reasoning from the *original*, not the
  *current*, working directory. This is inherent to the hint-file design, not a bug to
  patch; know it before relying on `reset-claude-env`'s auto-recovery for a profile you've
  actively repointed.
- **`claude-remote-control@.service` never reads a workdir hint at all**, unlike
  `claude-remote@.service` — it's fixed at the account's home root by design (control-plane
  sessions have no reason to move), so `claude-rc workdir <p> <path> --control` still writes
  a hint file, purely for interface symmetry; nothing ever reads it back.
- **Watch-mode MCP server entries are not in `claude/mcp.template.json`.** The
  `chrome-devtools-watch`/`playwright-watch` variants — attaching to the qa-watch stack's
  already-running Chrome over CDP `:9222`, instead of each launching and hiding their own —
  only work once that stack is installed and running; shipping them in the base template
  would just be two dead MCP server entries on every box that never installs `--infra`.
  They're documented, with the exact JSON to paste into your own
  `~/.claude/mcp-interactive.json`, in `infra/qa-watch/SETUP.md` §4.
- **Session naming is a load-bearing contract, not cosmetic.** Every interactive session
  this harness launches — CLI (`cc`) or web (`web-term.sh`) — names its tmux session
  `cc-<profile>-<slug-of-dir>`. `reap-idle-claude` only recognizes that `^cc-` prefix; a
  session named anything else is invisible to idle-reaping (this is exactly the bug the
  live reference deployment's own web terminal had, and this harness's `web-term.sh`
  deliberately does not repeat it).
- **Sudoers grants for `claude-qa-watch` and `caddy` are exact-argument matches, not
  globs.** Call them as anything other than `systemctl start claude-qa-watch` / `systemctl
  stop claude-qa-watch` / `systemctl reload caddy` — a `.service` suffix, an extra flag,
  anything — and the rule simply doesn't match, falling through to an interactive password
  prompt (fail closed, not open).
