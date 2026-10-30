# Architecture

Technical reference for the six layers this harness ships. Start with
[`README.md`](../README.md) for the "which layer do I need" overview; this document is the
detail underneath it — port map, the profile-vs-agent model, why the dashboard runs as root,
watchdog rationale, and the operational caveats worth knowing before you rely on any of it.

## Layer map

| Layer | Install flag | Key paths | What it is |
|---|---|---|---|
| 1. claude | `--claude` | `claude/{CLAUDE.md → global/,rules,agents,commands,skills}`, `claude/settings.template.json`, `claude/mcp.template.json` | The agentic config itself, copied into `~/.claude`; also loadable as a standalone plugin (`.claude-plugin/marketplace.json`, `claude/.claude-plugin/plugin.json`) |
| 2. watchdogs | `--watchdogs` | `watchdogs/bin/*`, `watchdogs/crontab.example`, `watchdogs/logrotate.d/` | Seven cron scripts supervising the host and remote-control fleet |
| 3. infra | `--infra` | `infra/{caddy,oauth2-proxy,dashboard,webconsole,qa-watch,droid,systemd,os}/` | Templates for the public web surface — staged into `./rendered/` for review, never installed/enabled/started by `install.sh` itself |
| 4. fleet | `--fleet` | `fleet/bin/{cc,ccname,ccswap,ccwt,claude-rc,claude-status,reset-claude-env}`, `fleet/add-agent.sh` | Multi-identity tooling: the profile model (one admin account, N config dirs) and the agent model (N Linux-user accounts), plus per-session helpers — `ccname` (label a session), `ccswap` (continue a quota-blocked session on the other account), `ccwt` (per-session git worktrees, created by `cc -w`) |
| 5. agy | `--agy` | `agy/bin/{ag,agy-run,claude-quota,agy-notify}`, `agy/config.example` | Antigravity (agy): `agy-run` sync wrapper (used by the Discord bridge to compose messages), `agy-notify` webhook poster, `ag` launcher; `claude-quota` is the per-account usage signal (SessionStart line, `mows-agent` quota floor) |
| 6. agents | `--agents` | `agents/bin/{mows-agent,mows-agent-meta}`, `agents/examples/`, `agents/config.example` | Purpose-scoped agents that run unattended: `mows-agent` owns policy (lint, per-run/per-day/account-quota budget, refusal, run records, escalation, pruning) over a plain Claude Code agent file with a `mows:` block (a mowa-kit `kit:` stage manifest instead is run by `kit run`, with `mows-agent` as its host); systemd timers/path units and HMAC-signed webhooks trigger a run, an `/agents` dashboard tab lists/controls them |

## Port map

| Port | Bound to | Service | Notes |
|---|---|---|---|
| 443 | public | Caddy | TLS termination + reverse proxy — the only thing this box exposes to the Internet and the only thing that terminates TLS |
| 3005 | 127.0.0.1 | dashboard (`infra/dashboard/lite.mjs`) | Reached only via Caddy; the PWA-installable **mows control** app — `/` Sessions (live fleet cards, pane-content state classifier, SSE updates, pull-to-refresh), `/history` (day-grouped, filterable, paginated), `/system` (metrics, environment, per-account usage/spend, `POST /sys/reclaim` behind a mandatory preview, restart-all), `/device` (Android emulator + QA-watch noVNC stages; old `/settings`, `/watch`, `/droid` URLs 302 here), `/agents` (Layer 6 agents: list, detail, per-run, and four actions), the global terminal theme endpoints (`/settings/term-theme{,.json}`, persisted to `/opt/claude-dashboard/settings.json`), `/term` companion, and the persistent shell — `GET /app`, `POST /a/switch`, `GET /app/live.json` (see caveat below). Every one of those pages is the cockpit shell (`--ui=next`, the default; `--ui=legacy` is the rollback) built from `web/` into `dist/` and served under `/assets/`; `/ui/*` and `/next/*` answer 301 into it. The same process serves `GET /api/*` (JSON, push included), `GET /stream` (one multiplexed SSE connection per tab) and `/sw.js`. See "One navigation model" below, and **read the deploy note there — `lite.mjs` is no longer a single file you can install on its own** |
| 7681 | 127.0.0.1 | `ttyd` (`/term`) | Only `/term/ws` and `/term/token` reach `ttyd` through Caddy's `reverse_proxy`; plain `GET /term` and `/term/` are intercepted earlier and served by Caddy's own `file_server` from `term-index.html` (see `infra/webconsole/make-term-index.sh`) |
| 4180 | 127.0.0.1 | oauth2-proxy | Caddy's `forward_auth` target for every protected route, plus a `reverse_proxy` for `/oauth2/*` |
| 2019 | 127.0.0.1, loopback-only | Caddy's admin API | Never configured by `infra/caddy/Caddyfile.template` at all — Caddy's own factory default is to bind its admin endpoint to `localhost:2019` and refuse non-loopback access; nothing in this repo changes that default, so it stays loopback-only for free |
| 6080 | 127.0.0.1, **on-demand** | websockify → noVNC | Only up while `claude-qa-watch` is running; reached publicly only through Caddy's `/vnc/*` route, behind the same Google OAuth gate as everything else |
| 9222 | 127.0.0.1, **on-demand** | Chrome remote debugging (CDP) | Only up while `claude-qa-watch` is running; never exposed outside loopback — agent MCP tools (`chrome-devtools-watch`, `playwright-watch`) attach here directly, a human never touches this port |
| 8000 | 127.0.0.1, optional | ws-scrcpy (`infra/droid/`) | Android web console; reached publicly only through Caddy's `/droidview/*` route and the optional `droid.<domain>` vhost, behind the same Google OAuth gate — absent entirely unless the droid stack is installed |
| 6555 | 127.0.0.1, optional | redroid's adb (Docker port map) | The Android container's adb endpoint, mapped outside adb's 5555+ emulator scan range so the device appears exactly once; loopback-only, adb/maestro/ws-scrcpy talk to it locally |

## Layer 6 contracts

The agents layer's whole design rests on a handful of boundaries that are easy to lose track
of once lint, budgets, triggers, and the dashboard are all layered on top. Stated plainly:

- **The agent file is the manifest.** There is no separate agents.yaml or database row — a
  plain Claude Code agent file (`~/.claude/agents/<name>.md`) with a `mows:` block (or a mowa-kit `kit:` block, run by `kit run`) on top of
  its ordinary frontmatter *is* the whole configuration: model, tools, budget, triggers,
  merge policy, escalation, all in one file, one source of truth, one thing to lint.
- **`mows-agent` owns policy; the Claude daemon owns processes.** `mows-agent` never manages
  a long-lived process of its own — it lints, decides whether a run is allowed, execs
  `claude -p` once, watches its stream-json output, and writes down what happened. The actual
  agentic work is a normal, bounded Claude Code invocation like any other; nothing here
  reimplements or wraps the agent loop itself.
- **Run records are files.** `~/.local/state/mows-agents/<name>/runs/<run_id>/` — no daemon,
  no database, no service that has to stay up for history to exist. `list`/`last`/`logs`/
  `prune` are just directory and `jq` operations, and the dashboard's `/agents` tab reads the
  same files a human would with `cat`.
- **Timers are staged only.** `mows-agent render` writes unit files into `./rendered/` and
  prints the exact `sudo install` / `sudo systemctl enable --now` lines — it never installs,
  enables, or starts anything itself, the same rule `--infra` follows everywhere else in this
  repo. A rendered timer sitting unenabled next to a real one is the expected steady state
  right after `install.sh --agents`.
- **The webhook body never reaches an agent.** `/wh/<name>` reads just enough of the request
  to verify its HMAC signature, then discards it; the run that follows always uses the
  agent's own configured `mows.task`, never anything from the payload. A webhook is strictly
  a trigger — an untrusted network caller cannot inject a prompt through it.
- **`/wh/*` is the one unauthenticated path on the whole site, and the HMAC signature is the
  entire gate.** `infra/caddy/Caddyfile.template`'s `(webhook)` snippet imports *before*
  `(gauth)` specifically to carve this route out from the Google OAuth wall every other route
  sits behind (see the Port map above) — a webhook caller has no browser to redirect through
  an OAuth flow. An unknown agent name and a known name with no configured secret both 404
  identically, so the endpoint never confirms which agents exist to an unauthenticated prober.

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

Seven cron scripts (`watchdogs/bin/*`), all profile-agnostic (fleet-facing ones discover
`default` + every `~/.claude-<suffix>` dir dynamically) and all no-ops on a box with nothing
matching yet:

| Watchdog | Watches | Cadence | Recovery action |
|---|---|---|---|
| `claude-health` | Is `claude-remote@<profile>` active? Any established backend connection? | `*/5 * * * *` | Sustained-WEDGED ≥8min → `reset-claude-env <profile>` + unit restart, rate-limited to once per 2h (disable per-profile via `~/.local/state/claude-health.norecover`) |
| `claude-mem-health` | claude-mem's shared memory worker on `:37777`; each profile's `installed_plugins.json` scope; transcripts with real user turns that never produced an `sdk_sessions` row | `*/10 * * * *` | Self-heals plugin scope back to `user`; flags worker/transcript anomalies (does **not** start the worker itself — claude-mem's own plugin hooks own that) |
| `reap-idle-claude` | Detached tmux sessions (matching `cc-*`, `ccw-*`, `web-*`, `agy-*`) | `17 * * * *` | Kills sessions idle beyond `$IDLE` seconds (24h default) — spares any pane showing a usage-limit banner, since the shield revives it once the reset passes |
| `reap-mcp-orphans` | MCP server processes reparented to init (`ppid==1`, age > 5 min) | `*/15 * * * *` | Kills the orphan — excludes tmux/claude/remote-control processes so a daemonized tmux server hosting a live session is never mistaken for one |
| `patch-health` | Stalled OS security updates (`dpkg --audit`, apt update stamp >3d old or missing, reboot pending >7d) | `23 4 * * *` | Logs findings to `~/.local/state/patch-health.log`; optionally notifies via `agy-notify` (rate-limited to 1/day) |
| `claude-limit-shield.sh` | tmux panes stalled on a usage-limit banner past its own parsed reset time | `*/5 * * * *` | Types a continue-nudge into the pane; `claude-limit-shield.sh selftest` runs an end-to-end check in a disposable session any time |
| `log-boot` | Boot events | `@reboot` | Appends one line (kernel version + uptime) to `~/.local/state/boot-log.txt` — pure logging, no recovery action |

Dependencies, log locations, and logrotate detail: [`watchdogs/SETUP.md`](../watchdogs/SETUP.md).

## Specs and verification

Use `templates/spec.md` when a change is big enough to need phases, owners and a verdict that is not an opinion: it
fixes the front-matter (`gates`, `budgets`, `outward`, `manual_gates`, `dev_server`) and gives every task the same three
sub-lines, **Evidence**, **Verify** (a shell command whose exit code is the answer) and **Owner**. Then run
`node scripts/verify-spec.mjs <spec.md>`: it runs every Verify line from the repo root with `DASH` and `RUN` exported, logs
the raw output and exit code per task under `$RUN/verify/`, and prints `VERDICT: ship` or `VERDICT: fix:[ids]`.
`--dry-run` lists the commands, `--only 3,7` and `--owner builder|verifier` narrow the run. A requirement with no command
that can fail is not a task; it goes in `manual_gates` with an owner and a date. The cockpit rebuild (`specs/cockpit/`)
is the worked example, and its size, Lighthouse and parity gates (`scripts/budget.mjs`, `scripts/lh-gate.mjs`,
`scripts/parity-diff.mjs`) are the first Verify lines that call tooling installed off the server (`npm install
--ignore-scripts`; the server itself imports `node:` builtins only).

## Known operational caveats

### The tmux server owns the sessions — keep it out of ttyd's cgroup

`claude-tmux.service` (`tmux -D`, foreground, its own cgroup) is the process every live
Claude Code session lives in; ttyd and `cc` only attach. Without that unit the first web
client forks the server inside `claude-web-term.service`, and since that unit is
`KillMode=control-group`, every ttyd restart — manual, or `needrestart` after a routine
security update — takes every session and every `ccname` label with it. `claude-web-term`
`Requires=` the tmux unit so the order cannot be wrong on a fresh box, and
`infra/os/needrestart-claude.conf` exempts the tmux unit from needrestart, because a
restart of *that* unit is by definition "kill every session". Labels are additionally
persisted to `~/.local/state/cc-labels/` and re-applied by a `session-created` hook, so a
reboot loses the sessions but not their names.


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
  `cc-<profile>-<slug-of-dir>` (or `ccw-`, `web-`, `agy-`). `reap-idle-claude` matches
  `cc-`, `ccw-`, `web-`, and `agy-` prefixes; a session named anything else is invisible
  to idle-reaping (this is exactly the bug the live reference deployment's own web terminal
  had, and this harness's `web-term.sh` deliberately does not repeat it).
- **Sudoers grants for `claude-qa-watch` and `caddy` are exact-argument matches, not
  globs.** Call them as anything other than `systemctl start claude-qa-watch` / `systemctl
  stop claude-qa-watch` / `systemctl reload caddy` — a `.service` suffix, an extra flag,
  anything — and the rule simply doesn't match, falling through to an interactive password
  prompt (fail closed, not open).

### One terminal, tmux switches it — and no iframe anywhere

Switching sessions on a phone never reloads the terminal, but the console is a plain page.

`GET /app` mints an 8-hex `tabid` and 302s into `/term/?arg=attach&arg=<session>&arg=<tabid>`;
every dashboard attach/resume link carries its own freshly minted tabid. `web-term.sh
attach|open` writes `$(tty)` to `~/.cache/webterm-clients/<tabid>` before attaching — that
file is the only link between a browser tab and its tmux client (files older than a day are
pruned on write; a ttyd reconnect overwrites it, self-healing). The `75-ccsess.html` block
draws a pill with the current session's name in the key bar; it opens a bottom sheet, and
choosing a session posts `/a/switch`, which reads the tty back out and runs `tmux
switch-client -c "$tty" -t "=<to>"`. tmux repaints the *same* client onto another session:
no reload, no second WebSocket, no xterm re-boot, none of the terminal page's viewport machinery
disturbed. `web-term.sh switch` first runs `tmux detach-client -s "=<to>"` — the take-over
semantics `attach -d` already has — **unless the client is already on that session**, where
detaching would kill the client we are about to switch (a 409 and a pointless reload). A
missing tab file (409) or unresolvable target (404) fall back to exactly one `/term` reload.

The `‹` key and the sheet's last row **navigate** to `/`. Earlier versions put `/term` in an
iframe (v1), then the dashboard in an iframe "drawer" (v2–v4); on iOS the frame and the page
never agreed about `env(safe-area-*)` in either direction — keyboard over the input line,
a 150 px-tall dashboard, dead bands, compacted content. There is now exactly one dashboard
and it is never framed, so there is no second layout to keep consistent. Getting back into a
session is `attach` on a row: a normal page load, which works even when that tab is already
attached to it. `infra/webconsole/mobile-journey.mjs` asserts this geometrically (measured
edges, not element presence) across four phone geometries; run it before any deploy that
touches the terminal page or the dashboard.
### One navigation model: the cockpit shell at `/`, and `--ui=legacy` one flag away

Since the cockpit cutover (phase 05 of `specs/cockpit/`) there is **one** UI. `/`, `/history`, `/system`,
`/device`, `/agents`, `/agents/<name>`, `/agents/<name>/<run>` and `/s/<acct>/<sid>` are all the same
document: a shell (`routes/documents.mjs`, `nextView`) holding the header, the tab bar and the terminal FAB
as markup, an inline `<script type="application/json" id="boot">` with the first paint's data (K-07), and
one module entry. Preact 11 and signals, bundled off-server by `build.mjs` from `web/` into the committed
`dist/` (one hashed file per view, every view a lazy `import()`), served by `static.mjs` under `/assets/` as
`immutable`. `/term` and `/md` stay separate documents. `/api/*` and `/stream` are the contract in
`web/contract.d.ts`. The long argument for this stack is `specs/cockpit/ARCHITECTURE.md`; what follows is
what an operator needs to know.

**The flag.** `lite.mjs --ui=next` is the default; `--ui=legacy` serves the previous server-rendered pages
(`legacy.mjs`) at `/` and the old client-rendered app at `/ui`, with the shell still mounted at `/next` for
comparison. The rollback is that one word and a restart (`UI=legacy scripts/deploy-dashboard.sh`, which also
rewrites the unit's `ExecStart`); there is no `/legacy` mount and no proxy flip. `legacy.mjs`, the `/agents`
twin and the `<noscript>` checks are deleted in Stage 8 step 4, one release after the cutover, in their own
spec. Until then `scripts/legacy-parity-check.mjs` holds `--ui=legacy` to the documents it served before the
split and `scripts/e2e-infra.sh` runs a second dashboard with the flag.

**Retired routes.** With the default, `GET /next/*` answers `301` to the same path without the prefix and
`GET /ui/*` answers `301` into the shell (`/ui/agents/<name>[/<run>]` to the same route, anything else to
`/agents`, via `uiTwinPath`'s allow-list; the query string is kept). The manifest is unchanged byte for byte
(`id: /`, `start_url: /app`, `scope: /`): installed apps cache it, and `/app` still 302s to `/term/`.

**Platform features, replaced.** The server-rendered pages got their app feel from cross-document view
transitions, speculation rules and bfcache. A single-page shell cannot use those, so each has a counterpart in
`web/main.mjs`: `document.startViewTransition` around route changes with `.tabs` keeping
`view-transition-name: tabs`; a prefetch of the target route's JSON on `pointerenter`/`touchstart` of a tab
link (never `/term*`, `fresh=1`, `reclaim=1`); the store keeps each route's scroll offset and the last list, so
Back and Forward re-render with no request. Actions are still `<form method=post>` elements the shell
intercepts with `fetch` and that fall back to a normal POST, 303, GET.

**The installed app.** `web/sw.mjs`, served as `/sw.js` behind a precache list of `dist/` by sha256
(`static.mjs`, `swView`; the bytes change exactly when the build does), answers from its cache only the
navigation allowlist `/`, `/history`, `/system`, `/device`, `/agents*`, `/s/*`, network first. `/term*`,
`/oauth2/*`, `/vnc/*`, `/droidview/*`, `/api/*`, `/stream`, `/events`, `/a/*`, `/md` are not intercepted at
all, and a 3xx or a followed redirect is never cached (the installed app is scoped to `/`, so the worker sees
all of them; ledger B-10). `scripts/sw-check.mjs` holds that. **Badge and Wake Lock**: `navigator.setAppBadge(n)`
with `n` the sessions in `needs-you` in the `fleet` signal, cleared on focus; `navigator.wakeLock` held while a
session is `working` and the tab is visible (`web/pwa.mjs`). **Push**: `GET /api/push/key` is the VAPID public
key; `POST` and `DELETE /api/push/subscribe` store a subscription (same-origin, JSON, at most 4 KB, an https
endpoint on a named host). The key pair and `push-subs.json` live next to `settings.json` (`0600`; a dev
instance that cannot write there keeps them in memory). `sse.mjs` watches the fleet itself, only while someone
is subscribed, and sends on a session's transition into `needs-you`, once per session per 30 s, a declarative
payload `{ web_push: 8030, notification, app_badge }` encrypted per RFC 8291 (aes128gcm) and signed per RFC 8292
with `node:crypto` only (`routes/webpush.mjs`; `scripts/push-check.mjs` decrypts it with WebCrypto). The
System view's Notifications card subscribes and unsubscribes. Delivery to an installed iPhone is a manual gate
(owner and date in `specs/cockpit/ARCHITECTURE.md` section 13): no automation can receive a real push.

**The gates.** The budgets are gzip-9 per route closure, not one ceiling for the client, and they are in fail
mode:

| Gate | Where | What it holds |
|---|---|---|
| per-route budgets | preflight, `scripts/budget.mjs --all` | shell 30 kB, each view 15 kB, marked 25 kB, `tokens.css` 12 kB, fonts 80 kB, `/term` 132 kB (owner decision O-7), server 140 kB, no mermaid in `dist/` |
| `dist/` is the build | preflight (manifest check) and CI (`node build.mjs && git diff --exit-code -- dist/`) | every committed file hashed in `dist/manifest.json`, two builds byte-identical |
| served-document ceiling | `e2e-infra.sh` | the real `GET /` response at gzip -9, 20,480 B, with the container's fleet |
| Lighthouse, parity | `scripts/lh-gate.mjs`, `scripts/parity-diff.mjs` | LCP 2,500 ms and TBT 200 ms on `/`; screenshots within 0.5 % of the frozen baseline |
| service worker, push | preflight | `scripts/sw-check.mjs`, `scripts/push-check.mjs` |
| chat-view XSS, capability honesty | preflight 5c, 5d | 91 and 170 assertions over the renderer and the panel |

The first two rows replaced the old client-asset ceiling over `infra/dashboard/app/` (preflight 5b still
checks that tree while `--ui=legacy` ships it). Every gate fails rather than skips when it cannot run: a gate
that quietly skips itself reports green while guarding nothing, which is the failure the previous branch hit
four separate times.

The shell carries a Content-Security-Policy of its own: `default-src 'none'`, no `unsafe-inline`, one nonce
minted per response admitting the boot snapshot and the module script, and `'self'` for the linked
stylesheet. The legacy pages carry dozens of inline `style=""` attributes and several inline scripts, and CSP3
ignores `'unsafe-inline'` the moment a nonce is present, so they take only the directives that say nothing
about inline code (`BASE_CSP`). The reasoning is in `uiCsp`'s header comment in `core.mjs`; `e2e-infra.sh`
asserts both policies and that exactly one header is sent.

**The capability panel** (`web/views/capability.mjs`) reports **effective** capability: what the frontmatter
grants once the deny list is subtracted, and it names **unknown reach** instead of guessing: an agent with no
`tools:` key inherits everything including Bash and is reported as inheriting, not as empty; an `mcp__*` tool
reaches whatever its server reaches and is reported as unknown rather than classified; unreadable input rounds
toward unrestricted, never toward restricted. "Shows what the agent can do" is the summary that undoes it.
Field by field, with the gaps it declares, in [`agents/SETUP.md`](../agents/SETUP.md).

**What is not verified.** Stated here rather than left for someone to discover:

- **A real on-screen keyboard.** Playwright raises none, in any engine. The composer's `--kb` handler is
  exercised against `visualViewport`, which is not the same thing, and WebKit ignores
  `interactive-widget=resizes-content`, which makes that handler the only thing carrying iOS.
- **Real Safari**, as opposed to WebKit the engine: no iOS quirks, no Safari chrome, no bfcache.
- **A real push.** `docs/qa/probes/pwa-check.mjs` drives the real worker with a `push` event and stubs the browser's
  push service; whether APNs or FCM deliver to a Home Screen install, and whether the badge matches, is the
  manual gate. Playwright's WebKit has no Push API.
- **A real agent turn.** Every streaming assertion drives the server's own `MOWS_TEST_HOOKS` delta injector; a
  real `claude -p` turn costs money and needs systemd.
- **What the Claude Code CLI does with `tools: ''`.** The panel calls it unreadable and rounds toward
  unrestricted; `mows-agent-meta` calls it the empty list. Which one matches the CLI is unmeasured.
- **The terminal on a device.** `/term` (xterm.js 6 and the ttyd 1.7.4 protocol) is tested against a fake
  socket; the IME shadow line, resume after sleep and the key bar against a real home indicator are the
  `real-device terminal` manual gate.

The scripted browser evidence that does exist, including the WebKit runs, is in `docs/qa/probes/`, SKIP-gated
on a Playwright install, with the install command in its README and in the skip output. **A skip is not a
result**: that SKIP was once believed rather than checked, on a box where Playwright was in fact installed at
the exact path the loader searches, and the cost of believing it was a High-severity layout defect shipping. If
a probe skips, find out why before treating the run as evidence of anything. HTTP/2 against a live host is not
in that set; it is the `MOWS_HOST` assertion below.

#### Deploying this change — the dashboard is no longer one file

Before 2026-09-16 the dashboard was one file and deploying it was one `install`. It is not any
more, and every way of getting this wrong is quiet in a different way. The whole deploy set:

| Source | Destination | What it is |
|---|---|---|
| `infra/dashboard/{lite,core,sse,static,legacy,chat-stream,capability}.mjs` | `/opt/claude-dashboard/` | the server and the modules it imports at load |
| `infra/dashboard/routes/` | `/opt/claude-dashboard/routes/` | `api`, `actions`, `agents`, `device`, `documents`, `md`, `push`, `webpush` |
| `dist/` | `/opt/claude-dashboard/dist/` | the shell's build, served under `/assets/`, and `/sw.js`'s precache list |
| `infra/dashboard/app/` (whole tree) | `/opt/claude-dashboard/app/` | the old client, only while `--ui=legacy` still ships it |
| `infra/webconsole/themes.json`, `webterm-settle.sh`, `dist/term.html` | `/opt/claude-dashboard/` | the terminal themes, the settle script and the `/term` page (`term-index.html`) |
| `agents/bin/mows-agent`, `mows-agent-meta` | `~/.local/bin/` (`install.sh --agents`) | the CLI the dashboard **spawns by absolute path** |

`scripts/deploy-dashboard.sh` does all of this (add `--dry-run` to print the commands): it installs every file that
exists in the checkout, points the unit's `ExecStart` at `--ui=next` (`UI=legacy` for the rollback), restarts
`claude-dash-lite` and smokes `/healthz`. The restart is not optional: the server reads `dist/manifest.json` when
its mtime changes but the modules it imports are loaded once, and `legacy.mjs` walks `app/` once, so a running
dashboard keeps serving the previous server code until it is restarted. (Files left behind from an older `dist/`
are harmless: every asset URL is content-hashed and only names listed in `dist/manifest.json` are served.)
`rm -rf` on `dist/` happens before the copy, so a half-installed build cannot mix hashes.

**The ways to get this wrong, each reproduced rather than reasoned about:**

- **`lite.mjs` without its two sibling modules.** The unit does not come up at all:
  `Error [ERR_MODULE_NOT_FOUND]: Cannot find module '/opt/claude-dashboard/chat-stream.mjs'
  imported from /opt/claude-dashboard/lite.mjs`. The whole dashboard is down, `systemctl status`
  says so, and this is the *good* failure — it is the only one of the three you cannot miss.
- **The server files without `dist/`.** `GET /` answers **200** with a perfectly well-formed
  shell — correct CSP, correct nonces — whose script and stylesheet are `/assets/missing-build`, which
  answers **404**. The result is a blank page. The `<noscript>` fallback is not shown, because JavaScript
  is enabled and did load; it just had nothing to load. Nothing is logged, server-side or in the
  browser beyond a failed subresource. Every other route keeps working normally, so a spot check
  of `/` reports the deploy healthy.
- **A new dashboard beside a stale `mows-agent`.** This is the one the deploy set exists for.
  `POST /a/agent-chat` spawns `<home>/.local/bin/mows-agent chat <name> --stream <msg>` — an
  **absolute path**, so it is the *installed* CLI that runs, never the copy in this repo, and a
  `git pull` alone changes nothing. A `mows-agent` older than Task 6 has no `--stream` case, so:
  - `--stream` is not a flag there; it becomes the first word of the message. The agent is asked
    ` --stream <msg>` and `chat.jsonl` records that as the operator's own question.
  - the reply comes back as plain text on stdout, `wireChatStream()` cannot parse it as JSON, and
    **no delta ever reaches `/stream`**. The view shows "Thinking…" for the length of the turn,
    then the reply appears only on the next load — the exact pre-streaming behaviour, arrived at
    by accident.
  - the one trace is in the dashboard's own journal, and you have to know to look for it:
    `journalctl -u claude-dash-lite` carries `chat <name>:<turn>: dropped N malformed stream
    line(s)`. There is nothing in the browser, nothing in `mows-agent`'s `events.log`, and no
    failed status anywhere.
- **The mirror case — a stale dashboard beside a new `mows-agent` — is the loud one.**
  `/api/*` and `/stream` all 404 while the pages keep serving HTML, so chat works exactly as it
  did before and nothing is corrupted. Worth knowing only so that "the app is 404ing" is read as
  "the dashboard was not deployed" rather than as a routing problem in Caddy.

**Verify the deploy landed, in three commands.** Run them after every dashboard deploy; the
third is the one that would otherwise go unnoticed for months.

```sh
curl -s -o /dev/null -w '/ %{http_code}\n' http://127.0.0.1:3005/            # expect 200
# the module the shell actually asks for, taken from its src=
M=$(curl -s http://127.0.0.1:3005/ | grep -o 'src="/assets/[^"]*"' | cut -d'"' -f2)
curl -s -o /dev/null -w "$M %{http_code}\n" "http://127.0.0.1:3005$M"        # expect 200, not 404
grep -c -- --stream ~/.local/bin/mows-agent                                 # expect > 0
```

**HTTP/2 on the live host** is not something the container suite can prove — it has neither DNS
nor a certificate — so `scripts/e2e-infra.sh` SKIPs that assertion loudly unless you give it the
host:

```sh
MOWS_HOST=<your dashboard hostname> ./scripts/e2e-infra
```

A pass prints the negotiated version and `PASS: http2 negotiated on <host> (spec §3)`, and the
suite ends `RESULT: 90 passed, 0 failed`. A fail prints `negotiated HTTP version on <host>: 1.1`
(or `<none>` if the host was unreachable, which is a failure for a different reason) and the
suite ends 89/1 — non-zero exit either way. Without `MOWS_HOST` the suite runs 89 assertions and
prints `SKIP: http2 check` instead. **Run against the reference box's live host on 2026-09-17:
HTTP/2 negotiated, 90 passed, 0 failed.**

**And here is the tension, stated rather than glossed, because it has no cheap answer.** The spec
singles out HTTP/2 regression as the *silent* risk — over HTTP/1.1 the browser caps SSE at six
connections per origin across all tabs, so the seventh tab simply never receives a token and
looks like a hung agent — and asserts it in `e2e-infra.sh` for exactly that reason. But the
hostname cannot live in this repository: `preflight.sh` treats a real domain as a leaked
identifier and blocks the publish, which is why the suite reads it from the environment. So the
one gate against the silent risk was, for the whole branch, guarded by a maintainer remembering
to type a variable — it ran exactly once, by hand, in Task 10.

`.github/workflows/e2e-infra.yml` passes `MOWS_HOST: ${{ secrets.MOWS_HOST }}`. A **secret**, not
a repository variable, and the distinction is the whole point: GitHub masks `secrets.*` in Actions
logs and does **not** mask `vars.*`, so the first version of this line would have published the
hostname into a public log the moment anyone set it — routing around the very gate that keeps it
out of the tree. Belt and braces, because a mask is not a plan: `e2e-infra.sh` no longer
interpolates the host into its echo or its `chk` label either, so the assertion carries the same
meaning without naming the host anywhere. Set the secret once and the nightly job covers the
check; leave it unset — every fork, every clone — and it expands to the empty string and the check
SKIPs loudly exactly as before.

That closes the gap for whoever sets it and closes nothing for anyone who does not, which is the
honest description: the tension between "assert it in CI" and "never commit the domain" is not
resolved, only reduced to one repository setting.

#### Known and unguarded — read before raising a budget or adding a caller

These are not bugs found and left; they are properties that hold today because of a number
somewhere else, and the number is the only thing holding them. Each would become a real defect the
moment somebody changed the thing it rests on, and none of them has a gate.

- **Two chat turns on one agent run concurrently, with no lock.** `mows-agent chat` refuses to
  start while a *run* is live, and says why — *"resuming a live session would interleave with
  it"* — and then permits a second *chat* on the same `--resume <session>` with no `flock`
  anywhere. `POST /a/agent-chat` spawns detached and 303s immediately without serialising. It is
  reachable without doing anything unusual: two browser tabs (the composer's disable is
  per-component state), two operators, or the server-rendered `/agents/<name>` page open beside a
  `/ui` tab. Both children append to the same `chat.jsonl`, and on the dashboard side the second
  turn's first delta resets that agent's replay buffer, so a reconnect during *either* turn
  recovers nothing. **Deliberately not fixed here:** the missing guard is verified, the
  consequence of two genuinely racing turns is reasoned and was never driven with real money, and
  a lock written against a reasoned consequence is how you ship the wrong lock. Documented so the
  next person starts from "this is known" rather than rediscovering it.
- **The chat replay buffer is bounded by a budget, not by code.** `chatBuf` is append-only with no
  cap and no eviction; what keeps it small is that `mows-agent` caps a chat turn at `$0.25` and
  six turns. Raise either and this becomes unbounded per in-flight turn, with nothing to notice.
- **`/ui/<anything>` redirects to the agents list.** With the default `--ui=next`, `uiTwinPath` sends every
  unrecognised `/ui/*` path to `/agents` with a 301, which is better than a blank page and worse than a
  refusal for `/ui/system` and `/ui/fleet`. A user who types one gets a different page and no indication
  anything is wrong. The route is deleted with `legacy.mjs` in Stage 8 step 4.
- **The asset content hash is CRC32.** Fine as a cache key, and the spec only asks for "a content
  hash" — but assets are served `immutable, max-age=31536000`, so a CRC32 collision between two
  *versions of the same file* would pin a stale body in every client cache for a year with no
  recovery short of renaming the file. Negligible per deploy; unbounded and undiagnosable if it
  ever happens.
- **The vendored-hash gate covers the files `SHA256SUMS` lists.** A fifth module dropped into
  `app/vendor/` is not pinned by it. Preflight's bidirectional manifest diff means such a file
  cannot arrive without a visible `scripts/manifest.txt` line, so nothing sneaks in — but "each
  vendored file is pinned" is held up by the manifest, not by the hash check.
