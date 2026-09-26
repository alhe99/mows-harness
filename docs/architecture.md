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
| 6. agents | `--agents` | `agents/bin/{mows-agent,mows-agent-meta}`, `agents/examples/`, `agents/config.example` | Purpose-scoped agents that run unattended: `mows-agent` owns policy (lint, per-run/per-day/account-quota budget, refusal, run records, escalation, pruning) over a plain Claude Code agent file with a `mows:` block; systemd timers/path units and HMAC-signed webhooks trigger a run, an `/agents` dashboard tab lists/controls them |

## Port map

| Port | Bound to | Service | Notes |
|---|---|---|---|
| 443 | public | Caddy | TLS termination + reverse proxy — the only thing this box exposes to the Internet and the only thing that terminates TLS |
| 3005 | 127.0.0.1 | dashboard (`infra/dashboard/lite.mjs`) | Reached only via Caddy; the PWA-installable **mows control** app — `/` Sessions (live fleet cards, pane-content state classifier, SSE updates, pull-to-refresh), `/history` (day-grouped, filterable, paginated), `/system` (metrics, environment, per-account usage/spend, `POST /sys/reclaim` behind a mandatory preview, restart-all), `/device` (Android emulator + QA-watch noVNC stages; old `/settings`, `/watch`, `/droid` URLs 302 here), `/agents` (Layer 6 agents: list, detail, per-run, and four actions), the global terminal theme endpoints (`/settings/term-theme{,.json}`, persisted to `/opt/claude-dashboard/settings.json`), `/term` companion, and the persistent shell — `GET /app`, `POST /a/switch`, `GET /app/live.json` (see caveat below). Since 2026-09-16 the same process also serves the client-rendered `/ui/*` app and what it runs on: `/ui/assets/*` (content-hashed modules from `infra/dashboard/app/`), `GET /api/*` (JSON), and `GET /stream` (one multiplexed SSE connection per tab). See "Two navigation models" below, and **read the deploy note there — `lite.mjs` is no longer a single file you can install on its own** |
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
  plain Claude Code agent file (`~/.claude/agents/<name>.md`) with a `mows:` block on top of
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
no reload, no second WebSocket, no xterm re-boot, none of the `blocks/` viewport machinery
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
### Two navigation models: platform features at `/`, a small SPA at `/ui`

Until 2026-09-16 there was one answer here and it was "platform features, not a framework". That
is still true of every server-rendered route, and it is no longer the whole truth: `/ui/*` is a
client-rendered app. Both models ship, on purpose, and the twins are retired one at a time only
after the replacement has run on the box for a week (spec §6) — so `/agents` still serves HTML
while `/ui/agents` exists beside it.

#### The server-rendered routes — `/`, `/history`, `/system`, `/device`, `/s/*`, `/agents`

No client framework (see the header of `infra/dashboard/lite.mjs` — that replaced a React build
that cost 500 MB RSS and a MB-scale bundle). They feel like an installed app because the
platform does the work:

- **cross-document View Transitions** (`@view-transition { navigation: auto }`): the tab bar is
  named `tabs` so it stays pinned while the content crossfades. Chrome 126+, Safari 18.2+;
  anything older just navigates.
- **Speculation Rules** (`<script type="speculationrules">`, `eagerness: moderate`): dashboard
  links are prerendered on hover/touch-start, so the tap lands on a page that already exists.
  The rule lists `/`, `/?*`, `/history`, `/history?*`, `/system`, `/device`, `/s/*`, `/agents`,
  `/agents?*` and `/agents/*` only — never `/term*` (a prerender would spawn a ttyd → tmux
  attach), and links carrying `fresh=1` (20 s quota refresh) or `reclaim=1` (disk scan) are
  excluded by
  selector. **`/ui*` is excluded by that same selector**, because the SPA owns its own
  navigation: prerendering runs the page's scripts, so a prerendered `/ui` boots a whole second
  copy of the app — including its `EventSource` on `/stream`, against a cap of 8 concurrent
  clients per dashboard process — for a tap that may never come. Chrome only; Safari relies on
  bfcache.
- **bfcache**: pages send `cache-control: no-cache` (never `no-store`) and register no `unload`
  handlers, so back/forward restore instantly.
- **motion is CSS-only and compositor-only** (2026-08-26): the new screen rises 6 px under the
  pinned tab bar (`vt-in`), every control shrinks to `scale(.96)` on `:active`, `<details>`
  content fades in, and the terminal's session sheet slides up/down via `transition-behavior:
  allow-discrete` + `@starting-style` (`blocks/75-ccsess.html`). Only `transform` and `opacity`
  are ever animated — nothing triggers layout, no JS timers — and every rule sits behind
  `prefers-reduced-motion: no-preference`. Browsers without `allow-discrete` drop those
  declarations and toggle instantly, which is exactly the pre-motion behavior.

Actions stay POST → 303 → GET; a two-line `submit` listener marks the form `.busy` while it runs
and `pageshow` clears it on a bfcache restore. Proof under automation stops at the prerender
*request* — Chrome reports `PrerenderingDisabledByDevTools` whenever CDP is attached, so
activation can only be seen in a real browser.

#### `/ui/*` — the SPA, and what the move cost

`/ui` serves a shell (`uiShellHtml` in `lite.mjs`) holding an import map and one module entry
point; everything under `infra/dashboard/app/` is served from `/ui/assets/` under a
content-hashed name and cached `immutable`. It exists because a chat transcript that streams
token-by-token, a capability panel and a live run list are state a page reload destroys, and
POST → 303 → GET destroys it on every turn.

**Kept, by a different mechanism.** Same-document View Transitions replace the cross-document
ones: `navigate()` in `app/main.mjs` wraps the `history.pushState` in `document.startViewTransition`,
and the tab bar keeps its `view-transition-name: tabs`, so the pinned-bar crossfade survives.
A browser without `startViewTransition` takes the `else` branch and navigates without animation.

That bar is **the same bar**, not a copy of it: `pageChrome()` in `lite.mjs` builds the header,
the tab bar and the terminal FAB once, and both `page()` (every server-rendered route) and
`uiShellHtml()` (the SPA) call it. One parameter differs — the Agents tab points at `/ui/agents`
from inside the app and at `/agents` from outside, so tapping the tab you are on does not eject
you to the twin you navigated away from. Every other tab is an ordinary cross-document
navigation, because `main.mjs`'s click handler only intercepts `a[href^="/ui"]`.

This is worth spelling out because **for the whole of this branch there was no bar on `/ui` at
all.** The shell was `<div id="app">` and a `<noscript>`, so with JavaScript on there was no link
from the app to `/`, `/history`, `/system`, `/device` or `/agents` — the way back was the Back
button or typing a URL. `scripts/e2e-infra.sh` now asserts both navs link to all four siblings,
by href and by label: `.tabs` is `display:none` above 701px and `.pnav` is hidden below it, so
each is the *only* navigation at its width and asserting one would leave the other green and
unnavigable. One consequence to know before touching the chat view's CSS: the composer and the
jump button are `position:sticky`, and a sticky element sticks to the scrollport rather than to
the end of the document, so `body`'s bottom padding does not lift them clear of a fixed bar —
they carry their own clearance, in a `max()` that collapses when the on-screen keyboard is up.

One deliberate difference from the server-rendered pages: those hide their `<h1>` above 701px
(`body>h1{display:none}`, because the desktop header replaces it), and the SPA's does **not** —
its `<h1>` is inside `#app`, so the selector does not reach it, and that is left alone rather than
extended. The SPA's `<h1>` is not a title, it is the back link: `← <name>` on a run view goes to
that agent's page and nothing else on the page does. Hiding it to match would cost the only way
back from a run view on a desktop, so a slightly duplicated heading is the cheaper trade.

**Lost, accepted, and written down here rather than discovered later:**

- **bfcache.** Back and forward are the client's job now. `app/main.mjs` keeps a
  `scrollByPath` map and restores the offset for the incoming path on the next frame.
  **This is not complete, and the gap is marked in the source:** `navigate()` saves the outgoing
  scroll position and the `popstate` handler does not, so scroll → Back → Forward → Back lands
  on the offset from the last click-navigation rather than the one you just set. The `TODO` in
  `app/main.mjs` carries the fix and the reason it is not a one-liner.
- **The no-JS fallback.** `GET /ui/*` serves a `<noscript>` block naming **that route's own**
  server-rendered twin — `/agents/<name>` from `/ui/agents/<name>`, not a constant `/` — and that
  is the whole fallback. The mapping is an allow-list (`uiTwinPath`) rather than string surgery on
  the path: the value goes into an `href`, and the SPA's router falls through to the agents list
  for any unmatched path, so anything unrecognised resolves to `/agents`, which is the twin of
  what the app will actually render. When a twin is retired, that `<noscript>` stops being a
  fallback and becomes a dead end; retiring a twin means revisiting `uiTwinPath` in the same
  change, and the per-route link is what makes that obvious rather than easy to miss.
- **Speculation Rules, with nothing yet in their place.** Spec §2 called for prefetch on hover
  to replace them for app routes. **It was specified and not built** — there is no prefetch,
  preload or hover handler anywhere in `infra/dashboard/app/`. A first tap on `/ui/agents/<name>`
  pays its `GET /api/agents/<name>` round trip; the multiplexed `/stream` keeps the *list* live
  but pre-warms no detail route. Of the three losses on this list it is the only one with no
  replacement at all, and the only one with a straightforward path back.

**The ceilings that replaced them.** A framework-free page needs no budget; a client-rendered one
does, or it grows back into the bundle `lite.mjs` was written to delete. Five gates, all blocking:

| Gate | Where | What it holds | Measured now |
|---|---|---|---|
| client-asset ceiling | preflight 5b | every `.mjs`/`.css` under `app/`, gzip -9, summed | 45,494 B of 76,800 B |
| **served-document ceiling** | `e2e-infra.sh` | the real `GET /ui` response, at gzip -9 | **~16,750 B of 20,480 B** |
| vendored-module hashes | preflight 5b | `app/vendor/SHA256SUMS`, checked with `sha256sum -c` | 4 modules pinned |
| chat-view XSS gate | preflight 5c | `scripts/chat-view-check.mjs` over the renderer | 91 assertions |
| capability honesty gate | preflight 5d | `scripts/capability-check.mjs` over the panel | 170 assertions |

**It takes both ceilings to cover the client, and for most of this branch only the first existed
and `lite.mjs` claimed it covered everything.** 5b is a static file gate and cannot see the shell,
which inlines the whole `CSS` constant — the *server-rendered* dashboard's entire stylesheet,
fleet rows and history and terminal included, of which `/ui` uses a fraction. That is roughly a
third again on top of the gated total; it is re-sent in full on every hard load (the shell is
`no-cache` and its nonce changes per response, so it can never 304); and it grows every time
somebody styles an unrelated server-rendered page, which is precisely the direction the ceiling
exists to police and precisely the one the static gate is blind to. Splitting the stylesheet so
`/ui` ships only what it uses is the real fix and is not done. Until then the served document is
measured rather than assumed — proved able to fail by planting ~40 KB of extra rules in the `CSS`
constant, which takes the response to 27,054 B gzipped and turns the assertion red. (The figure
is written approximate because it is not byte-stable: gzip output varies by a few bytes between
runs. The ceiling is what is exact, and it is an integer compared with `-le`, so that variance
cannot flip it against ~3,700 B of headroom. The check re-compresses at `-9` to match 5b's
convention; `send()` ships `gzipSync` at zlib's default, which measures about 0.6 % more on the
wire — so the label says "at gzip -9" rather than "as served", which would be describing something
adjacent to what it measures.)

The served-document ceiling lives in `e2e-infra.sh` rather than preflight because it needs a
running dashboard to `GET`, and preflight is a static gate that must not boot a server. That makes
it weaker than 5b — it runs on the path-filtered push job and nightly, not on every preflight —
and that is the trade, stated rather than glossed.

5b *fails* rather than skips when `infra/dashboard/app` is absent, and 5c/5d fail rather than
skip when Node or PyYAML is missing — a gate that quietly skips itself reports green while
guarding nothing, which is the failure this branch hit four separate times.

`/ui` also carries a Content-Security-Policy that the server-rendered pages cannot: `default-src
'none'`, no `unsafe-inline`, and one nonce minted per response (not per process) admitting
exactly the one inline `<style>` and the one inline import map. It is scoped to `/ui` because the
pages at `/` carry dozens of inline `style=""` attributes written over many months, and CSP3
ignores `'unsafe-inline'` the moment a nonce is present — so the same policy applied there would
break those pages rather than harden them. The reasoning is in `uiCsp`'s own header comment,
directive by directive.

**The capability panel is the other thing `/ui` adds**, and what it is careful *not* to say is the
point of it. It reports **effective** capability — what the frontmatter actually grants once the
deny list is subtracted — and names **unknown reach** instead of guessing at it: an agent with no
`tools:` key inherits everything including Bash and is reported as inheriting, not as empty; an
`mcp__*` tool reaches whatever its server reaches and is reported as unknown rather than
classified; unreadable input rounds toward unrestricted, never toward restricted. "Shows what the
agent can do" is the summary that undoes it. Field by field, with the gaps it declares, in
[`agents/SETUP.md`](../agents/SETUP.md).

**What is not verified.** Stated here rather than left for someone to discover:

- **A real on-screen keyboard.** Playwright raises none, in any engine. The composer's `--kb`
  handler is exercised against `visualViewport` at a 375×812 viewport, which is not the same
  thing — and WebKit ignores `interactive-widget=resizes-content`, which makes that handler the
  only thing carrying iOS. This one needs a physical phone and nobody has run it on one.
- **Real Safari**, as opposed to WebKit the engine: no iOS quirks, no Safari chrome, no bfcache.
- **A real agent turn through `/ui`.** Every streaming assertion drives the server's own
  `MOWS_TEST_HOOKS` delta injector; a real `claude -p` turn costs money and needs systemd.
- **What the Claude Code CLI does with `tools: ''`.** The panel calls it unreadable and rounds
  toward unrestricted; `mows-agent-meta` calls it the empty list. Neither reads a *tool* out of
  it, which is what the gate asserts, but which one matches the CLI is unmeasured.
- **Prerender *activation*.** Chrome reports `PrerenderingDisabledByDevTools` whenever CDP is
  attached, so automation can only see the prerender request, never the activation.
- **The chrome's geometry with a keyboard up, and on a real device.** This was previously listed
  here as unverified *in full*, and the defect was inside the caveat: the terminal FAB covered the
  Send button at every phone width, in both engines, and eleven grep-over-markup assertions could
  not see it. The geometry that can be measured now is — `docs/qa/probes/probes.mjs`'s `layout`
  mode reads `getBoundingClientRect()` and `elementFromPoint()` at four viewports in Chromium and
  WebKit, and asserts its own sticky-state precondition first, because its first version passed at
  all four against the broken code. What remains unverified is narrower and honest: the
  keyboard-up half (Playwright raises no keyboard in any engine, so the `max()` collapse is still
  reasoned from `resizes-content` semantics) and a physical device.

The scripted browser evidence that *does* exist, including the WebKit runs, is in
`docs/qa/probes/` — SKIP-gated on a Playwright install, with the install command in its README
and in the skip output. **A skip is not a result**: that SKIP was once believed rather than
checked, on a box where Playwright was in fact installed at the exact path the loader searches,
and the cost of believing it was a High-severity layout defect shipping. If a probe skips, find
out why before treating the run as evidence of anything. HTTP/2 against a live host is not in that
set; it is the `MOWS_HOST` assertion below.

**What was specified and never built** is a different list and is kept with the spec, not here:
see the ADDENDUM at the end of
[`docs/superpowers/specs/2026-09-16-dashboard-spa-design.md`](superpowers/specs/2026-09-16-dashboard-spa-design.md)
— prefetch, `/api/fleet` and `/api/system`, the chat view's tool rows and thinking indicator, and
the store-backed transcript restore. The plan's own self-review recorded several of those as
covered, which is why the list lives beside the requirements it belongs to.

#### Deploying this change — the dashboard is no longer one file

Before 2026-09-16 the dashboard was one file and deploying it was one `install`. It is not any
more, and every way of getting this wrong is quiet in a different way. The whole deploy set:

| Source | Destination | What it is |
|---|---|---|
| `infra/dashboard/lite.mjs` | `/opt/claude-dashboard/lite.mjs` | the server |
| `infra/dashboard/chat-stream.mjs` | `/opt/claude-dashboard/` | imported by `lite.mjs` at load |
| `infra/dashboard/capability.mjs` | `/opt/claude-dashboard/` | imported by `lite.mjs` at load |
| `infra/dashboard/app/` (whole tree) | `/opt/claude-dashboard/app/` | the client the shell loads |
| `agents/bin/mows-agent`, `mows-agent-meta` | `~/.local/bin/` (`install.sh --agents`) | the CLI the dashboard **spawns by absolute path** |

Install them together, in one go, and restart the unit:

```sh
sudo install -m644 infra/dashboard/lite.mjs infra/dashboard/chat-stream.mjs \
                   infra/dashboard/capability.mjs /opt/claude-dashboard/
sudo mkdir -p /opt/claude-dashboard/app
sudo cp -r infra/dashboard/app/. /opt/claude-dashboard/app/
./install.sh --agents            # mows-agent + mows-agent-meta into ~/.local/bin
sudo systemctl restart claude-dash-lite
```

The restart is not optional and not just for the server: `loadUiAssets()` walks `app/` once, on
the first `/ui` request, and caches the hashed names for the life of the process. A running
dashboard keeps serving the previous client until it is restarted. (Files left behind from an
older `app/` are harmless — every asset URL is content-hashed, so nothing references them.)

**The ways to get this wrong, each reproduced rather than reasoned about:**

- **`lite.mjs` without its two sibling modules.** The unit does not come up at all:
  `Error [ERR_MODULE_NOT_FOUND]: Cannot find module '/opt/claude-dashboard/chat-stream.mjs'
  imported from /opt/claude-dashboard/lite.mjs`. The whole dashboard is down, `systemctl status`
  says so, and this is the *good* failure — it is the only one of the three you cannot miss.
- **The server files without `app/`.** `GET /ui` answers **200** with a perfectly well-formed
  shell — correct CSP, correct import map, correct nonces — and `GET /ui/assets/main.mjs` answers
  **404**. The result is a blank page. The `<noscript>` fallback is not shown, because JavaScript
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
- **The mirror case — a stale dashboard beside a new `mows-agent` — is the loud one.** `/ui`,
  `/api/*` and `/stream` all 404 while `/agents` keeps serving HTML, so chat works exactly as it
  did before and nothing is corrupted. Worth knowing only so that "the app is 404ing" is read as
  "the dashboard was not deployed" rather than as a routing problem in Caddy.

**Verify the deploy landed, in three commands.** Run them after every dashboard deploy; the
third is the one that would otherwise go unnoticed for months.

```sh
curl -s -o /dev/null -w '/ui %{http_code}\n' http://127.0.0.1:3005/ui       # expect 200
# the module the shell actually asks for — take it from src=, not from the import map,
# which also names the unhashed path as a KEY and would give you a URL that 404s by design
M=$(curl -s http://127.0.0.1:3005/ui | grep -o 'src="/ui/assets/[^"]*"' | cut -d'"' -f2)
curl -s -o /dev/null -w "$M %{http_code}\n" "http://127.0.0.1:3005$M"      # expect 200, not 404
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
- **`/ui/<anything>` renders the agents list with a 200.** The SPA router falls through to
  `AgentsList` for every unmatched path, which is better than a blank page and worse than a
  refusal for `/ui/system` and `/ui/fleet` — paths spec §6 names as future routes. A user who
  types one gets a different page and no indication anything is wrong.
- **The asset content hash is CRC32.** Fine as a cache key, and the spec only asks for "a content
  hash" — but assets are served `immutable, max-age=31536000`, so a CRC32 collision between two
  *versions of the same file* would pin a stale body in every client cache for a year with no
  recovery short of renaming the file. Negligible per deploy; unbounded and undiagnosable if it
  ever happens.
- **The vendored-hash gate covers the files `SHA256SUMS` lists.** A fifth module dropped into
  `app/vendor/` is not pinned by it. Preflight's bidirectional manifest diff means such a file
  cannot arrive without a visible `scripts/manifest.txt` line, so nothing sneaks in — but "each
  vendored file is pinned" is held up by the manifest, not by the hash check.
