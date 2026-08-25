# infra layer — end-to-end VPS setup

`install.sh --infra` only ever *renders* this layer's templates into `./rendered/` for
review — it never installs, enables, or starts anything live (see its own header comment).
This document is the walkthrough for actually going live, in a safe order, on a fresh
Ubuntu 24.04 box. It sequences the per-module setup guides rather than duplicating them —
follow the links for full detail on any one step.

Throughout, `<domain>` means your own domain (the `{{DOMAIN}}` template variable),
`<your-user>` the non-root account this harness runs as (`{{ADMIN_USER}}`), and
`<sub>` one profile/agent subdomain label (`{{EXAMPLE_SUB}}`). Actual commands below use the
literal `{{ }}` tokens where a real `sed`/`render()` call needs them verbatim — see
[`infra/os/SETUP.md`](os/SETUP.md)'s own note on this convention.

## Order

1. DNS
2. apt installs (+ the OS baseline: [`infra/os/SETUP.md`](os/SETUP.md))
3. Google OAuth app
4. Cookie secret
5. Render + place configs
6. Enable order: caddy → oauth2-proxy → dashboard → web-term
7. Transcript prune timer
8. Linger
9. `systemd-journal` group
10. `/term`'s index page
11. QA watch-stack (optional, ships disabled)
12. Verify
13. Android web console (optional)

### 1. DNS A records

Point one A record (and AAAA, if the box has a v6 address) at this box for **the apex
domain**, plus one more for **every profile/agent subdomain** you intend to expose —
`infra/caddy/Caddyfile.template` needs a real, resolving hostname per site block before
Caddy's automatic HTTPS can issue it a certificate (ACME HTTP-01 proves ownership by
resolving the name to this box and answering on port 80/443 — see the Caddyfile template's
own "TLS" section for why this repo ships explicit per-hostname blocks instead of a
wildcard). Concretely: `<domain>` itself, plus `<sub>.<domain>` once per profile/agent
subdomain block you duplicate into the Caddyfile (`fleet/add-agent.sh --vhost=<domain>`
prints the exact block for a new agent). The `/vnc/*` QA-watch route lives on these same
hostnames — it needs no DNS entry of its own.

Do this first: every later step assumes it's already propagated, and Caddy will otherwise
sit there failing ACME challenges once it's live.

### 2. apt installs

OS baseline (tmux, firewall, fail2ban, unattended-upgrades, sshd hardening) —
**follow [`infra/os/SETUP.md`](os/SETUP.md) in full now**, through its own sudoers +
linger steps if you like, or come back to linger at step 7 below. This layer additionally
needs, none of which have their own `SETUP.md` (install steps are here, not duplicated
elsewhere):

```bash
sudo apt-get install -y caddy ttyd
sudo systemctl mask --now ttyd.service   # do this NOW, not later: Debian's ttyd package
                                          # auto-enables AND starts its own unauthenticated
                                          # unit on :7681 the moment it's installed — this
                                          # harness runs ttyd only via claude-web-term.service,
                                          # behind Caddy + oauth2-proxy
```

Node needs its own install step, not a plain `apt-get install nodejs`: Ubuntu 24.04's own
`nodejs` package is **18.19.1** — too old for `chrome-devtools-mcp` (see README.md's
Requirements note) — so pull a current release from NodeSource instead:

```bash
curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
sudo apt-get install -y nodejs
node -v   # expect v20.x
```

oauth2-proxy has **no apt package** — download the release binary matching `uname -m` from
<https://github.com/oauth2-proxy/oauth2-proxy/releases> to `/usr/local/bin/oauth2-proxy`
(see `infra/oauth2-proxy/oauth2-proxy.service`'s header for the exact prerequisites: a
dedicated `oauth2-proxy` system user, `/etc/oauth2-proxy` owned by it at `0750`).

QA watch-stack dependencies are separate — step 10 below.

### 3. Google OAuth app

In Google Cloud Console: **APIs & Services → OAuth consent screen** (External user type;
while the app stays in "Testing" status, only emails you explicitly add as test users can
complete the flow — that cap lifts once/if you submit for verification), then
**APIs & Services → Credentials → Create Credentials → OAuth client ID → Web application**.

Set the **Authorized redirect URI** to exactly:

```
https://<domain>/oauth2/callback
```

One redirect URI is enough for every profile/agent subdomain — `infra/caddy/Caddyfile.template`'s
`(gauth)` snippet anchors the login flow at the apex domain regardless of which hostname a
request started on (see that template's own comment on `redir * https://{{DOMAIN}}/oauth2/start?rd=...`),
so oauth2-proxy's callback always lands on the apex, never on a subdomain.

Save the **client ID** (ends `.apps.googleusercontent.com`) and **client secret** (starts
`GOCSPX-` for a client created this way) — you'll supply them as `OAUTH_CLIENT_ID` /
`OAUTH_CLIENT_SECRET` in step 5. Add every Google account that should be allowed to sign in
to `infra/oauth2-proxy/emails.txt.template` (one per line) before rendering it.

### 4. Cookie secret

```bash
openssl rand -base64 32 | tr -- '+/' '-_'   # URL-safe; oauth2-proxy refuses a secret containing + or /
```

Feed the output in as `COOKIE_SECRET` in step 5 below. If you render through `install.sh
--infra` instead of by hand, you can skip this step entirely — `resolve_cookie_secret()`
auto-generates one for you whenever `COOKIE_SECRET` is unset, in both interactive and
`--non-interactive` mode, precisely because a missing `cookie_secret` is a hard startup
failure for oauth2-proxy, not a soft "fill this in later."

### 5. Render + place configs

```bash
DOMAIN=<domain> ADMIN_USER=<your-user> OAUTH_CLIENT_ID=<id> OAUTH_CLIENT_SECRET=<secret> \
  ./install.sh --infra --non-interactive
```

(Omit `--non-interactive` to be prompted instead, including for `COOKIE_SECRET` if you
didn't export it yourself; `ADMIN_USER` defaults to your own login either way.) This stages
every template this layer knows how to render into `./rendered/` and prints the exact
`sudo install`/`systemctl` commands for each file — it does not run any of them itself.
Work through those printed commands in the order `install.sh` prints them; the highlights,
in the enable order that matters:

- **Validate before installing anything live:**
  `caddy validate --config rendered/Caddyfile --adapter caddyfile`.
  **Never run `caddy fmt --overwrite` on `Caddyfile.template` or any rendered copy of it** —
  it mangles the `{{ }}` placeholders (`infra/caddy/Caddyfile.template`'s own header says
  so explicitly; repeated here because it's the kind of one-shot mistake you only make
  once, and once is enough to have to re-author the file from git history).
- Sudoers: `sudo visudo -cf rendered/claude-harness.sudoers` must print "parsed OK" before
  `sudo install -o root -g root -m0440 rendered/claude-harness.sudoers
  /etc/sudoers.d/claude-harness` — full grant rationale in
  [`infra/os/SETUP.md`](os/SETUP.md) §6.

### 6. Enable order: caddy → oauth2-proxy → dashboard → tmux → web-term

(ttyd's distro unit was already masked back in step 2 — nothing left to do for it here.)

```bash
sudo systemctl daemon-reload
sudo systemctl enable --now caddy
sudo systemctl enable --now oauth2-proxy
sudo systemctl enable --now claude-dash-lite
sudo systemctl enable --now claude-tmux       # infra/os/SETUP.md §1b — owns every live session
sudo systemctl enable --now claude-web-term   # Requires= the line above
```

`claude-tmux` before `claude-web-term` is not cosmetic: if ttyd's first `new-session` finds
no server it forks one inside ttyd's own cgroup, and from then on every restart of ttyd
kills every live session (see §1b in [`infra/os/SETUP.md`](os/SETUP.md) for the night
that taught us). Already running sessions the old way? Install and `enable` `claude-tmux`
without starting it, then one deliberate `sudo systemctl restart claude-web-term` at a
quiet moment migrates — the `Requires=` starts the server unit first.

Caddy first: it's the only thing that ever binds a public port, so nothing behind it is
reachable — or matters yet — until it's up. oauth2-proxy next, so Caddy's `forward_auth`
calls have something to answer once real traffic arrives. Dashboard and web-term last —
they're the actual content being proxied to, and coming up before Caddy/oauth2-proxy exist
would just mean requests to them fail differently (connection refused vs. an auth loop),
not more safely. `claude-remote@<profile>`/`claude-remote-control@<profile>` (the sessions
the dashboard and `/term` actually drive) are managed separately — see
[`fleet/SETUP.md`](../fleet/SETUP.md), never auto-enabled by this layer (make sure `mkdir -p ~/Projects`
exists beforehand, as `claude-remote@` sets it as `WorkingDirectory`).

Once up: on a desktop or tablet **browser** the dashboard's `attach` / `>_` buttons open
each session in its own named window (clicking the same session again reuses its window),
so the session list stays put; in the installed PWA and at phone widths there is no second
window to spend, and everything opens in place exactly as before. No-JS clients keep the
in-place links.

### 7. Transcript prune timer

Install and enable the daily transcript cleanup service and timer (prunes transcripts idle >30 days):

```bash
sudo install -m755 infra/systemd/claude-transcript-prune.sh /usr/local/sbin/claude-transcript-prune.sh
sudo install -m644 infra/systemd/claude-transcript-prune.service infra/systemd/claude-transcript-prune.timer /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now claude-transcript-prune.timer
```

#### The `⌫ reclaim` button

The system panel's `⌫ reclaim` chip is the interactive half of the same disk hygiene: the
prune timer handles transcripts on a schedule, this handles the caches nothing else ever
sweeps. Tapping it is a plain `GET` that only *measures* — one `du` pass, ~1-2 s — and
renders a per-target breakdown with a checkbox each; the delete happens on the `POST` to
`/sys/reclaim`, and the number reported afterwards is a real `statfs` delta, not the
estimate. Targets are literals in the `RT` table in `lite.mjs`; the POST only picks ids out
of that table, so no request input ever reaches an `rm`.

Checked by default (safe — everything here is re-downloaded or rebuilt on demand): the
systemd journal (vacuumed to 200M), the apt archive, the npm / go-build / uv / pip /
node-gyp caches, docker dangling layers and build cache (`docker image prune -f` +
`docker builder prune -f`, so every *tagged* image survives), `/opt/claude-dashboard/shots`
older than 7 days, and week-cold tool litter in `/tmp` — matched against a narrow
allowlist (`claude-*`, `mows-shots-*`, `MSBuild*`, bare-uuid dirs), never a wholesale
sweep of a directory the rest of the OS shares.

Unchecked, opt in per run: the Playwright/Puppeteer browser caches (the next QA journey
re-downloads ~1.3 G) and unused docker volumes (a volume can hold a dev database — no undo).

> **There is deliberately no "free memory" or "free CPU" action**, and adding one would be
> theatre. The panel's memory figure is `MemTotal - MemAvailable`, which already excludes
> the page cache, so `drop_caches` would release only what the kernel was lending back
> anyway — at the cost of re-reading everything hot. And the load average is the sessions
> you asked for; a button that shrinks it is a button that kills your own work. Disk is the
> only resource on this box that genuinely leaks.

The dashboard runs as `root` (see `infra/systemd/claude-dash-lite.service`), so no extra
sudoers grant is involved — which is exactly why the scope above is a fixed table and the
preview is mandatory.

### 8. Linger

```bash
sudo loginctl enable-linger <your-user>
```

Required for `claude-rc`'s non-sudo `open`/`switch` paths (`systemd-run --user` transient
units), which otherwise die the moment `<your-user>`'s last login session ends. Full
rationale: [`infra/os/SETUP.md`](os/SETUP.md) §7, repeated as its own step here because it's
easy to do everything else above and still miss this one — the first symptom is usually
`claude-rc: no systemd --user session`, well after the fact.

### 9. `systemd-journal` group

`claude-rc logs <profile>` runs a plain `journalctl -u <unit> -f` — no sudo wrapper — so
reading another account's unit logs without sudo is a group-membership question, not a sudo
one:

```bash
sudo usermod -aG systemd-journal <your-user>
```

Not granted by default (see [`fleet/SETUP.md`](../fleet/SETUP.md)'s "No extra groups, by
design" section for why) — add it only if `claude-rc logs` (or a bare `journalctl -u
claude-remote-<name>@default.service` run as an agent) actually reports permission denied.

### 10. `/term`'s index page

Caddy serves `/term` and `/term/` itself, from a static file — `ttyd`'s own `GET /` is
never what a browser sees (see `infra/webconsole/claude-web-term.service.template`'s "Serving
model" note). The generated page is ttyd's own bundle plus every self-authored addition
spliced in: the clipboard shim and the `infra/webconsole/blocks/` mobile UX (key bar, PWA
geometry, home key, photo attach, font size, **color themes**, keyboard suggestions +
reconnect, copy/paste overlay, restart-pane key, repaint-on-foreground — each block
documents itself; runtime kill switches: `/term/?ime=off`, `?clip=off`, `?rst=off`,
`?paint=off`, `?theme=off`). That file does not exist until you generate it:

```bash
infra/webconsole/make-term-index.sh
```

The unit runs ttyd with `-t rendererType=canvas`, which is load-bearing on phones: ttyd's
default WebGL renderer loses its GPU context whenever iOS backgrounds the PWA, and ttyd
1.7.4 never re-enables it for that page load, so the terminal comes back garbled and then
blank. The canvas renderer has no context to lose. See that flag's note in
`claude-web-term.service.template` before changing it.

`/opt/claude-dashboard` was created `root:root 0755` by `install.sh --infra`'s own printed
`sudo mkdir -p /opt/claude-dashboard` command back in step 5, so a plain non-root run of the
script above **cannot** write the result there directly — it detects that itself, keeps the
spliced page at a temp path instead of losing it, and prints the exact follow-up:

```bash
sudo install -D -m644 <tmp-path-it-printed> /opt/claude-dashboard/term-index.html
```

Idempotent either way — the script regenerates the page from scratch on every run (same
inputs, same output), so re-running after the `sudo install` above is safe, and re-running
after a repo update is exactly how the page picks up new or changed blocks. Skip both
steps and `/term` 404s for every visitor, indefinitely — it is not created by any of the
`systemctl enable` steps above.

Note: `/term`'s "new session" launcher flow relies on `fleet/bin/cc` (installed via `./install.sh --fleet`).

#### Terminal color themes

`blocks/46-cctheme.html` ships 12 xterm color schemes (Material family, Nord, Catppuccin
Mocha, TokyoNight, Rosé Pine, GitHub Dark/Light) converted from
[mbadolato/iTerm2-Color-Schemes](https://github.com/mbadolato/iTerm2-Color-Schemes) (MIT).
Three ways to pick one, in precedence order:

| Where | How | Scope |
|---|---|---|
| the `/term` key bar | the theme dropdown (mobile; the bar is hidden on desktop) | that browser, persisted in `localStorage` |
| `/term` URL or console | `/term/?theme=Nord`, `?theme=default` to clear, or `cctheme("Nord")` | same — writes the same `localStorage` key |
| the dashboard | `/settings` → **Global theme** → Save | every terminal tab on every device, picked up by open tabs within ~30 s |

A device-local pick always wins over the global one; "Auto (global)" in the key bar clears
it and follows the dashboard again. With nothing set anywhere, `ttyd`'s stock palette
applies. The canonical color map lives in `infra/webconsole/themes.json` (read by the
dashboard) and is mirrored inline in the block (the terminal page must theme itself before
any fetch resolves) — **keep the two in sync when adding a scheme.**

The dashboard persists the global choice to `/opt/claude-dashboard/settings.json`
(`--settings-file` overrides the path; created on first Save, `{"termTheme":"<name>"}`) and
serves it back at `GET /settings/term-theme.json`. Install `themes.json` next to `lite.mjs`
so the `/settings` preview and the validation of `POST /settings/term-theme` see the same
map:

```bash
sudo install -D -m644 infra/webconsole/themes.json /opt/claude-dashboard/themes.json
sudo systemctl restart claude-dash-lite
```

> **Never name a dashboard route `/term…`.** Caddy's `handle /term*` is a *prefix* matcher:
> it swallows every path starting with `/term`, so an endpoint called `/term-theme` reaches
> `ttyd` and 404s instead of reaching the dashboard. That is why these live under
> `/settings/*`. The trap is commented in `infra/caddy/Caddyfile.template` too.

### 11. QA watch-stack (optional — ships disabled)

Only if you want the `qa` skill's `watched` mode (human takeover of a headless browser via
noVNC). Full walkthrough, including the amd64-vs-arm64 Chrome/Chromium split:
[`infra/qa-watch/SETUP.md`](qa-watch/SETUP.md). In short:

```bash
sudo apt install -y xvfb fluxbox x11vnc websockify novnc xdotool
```

then install `claude-qa-watch.service` per that guide. **It ships disabled on purpose** —
the sudoers grant for it covers only `start`/`stop`, not `enable`/`disable`, because a
screen-sharing debug stack has no business auto-starting at boot. The `qa` skill (or the
dashboard's own `/watch` view, which runs as root and needs no sudo at all) starts and stops
it on demand:

```bash
sudo systemctl start claude-qa-watch   # no .service suffix, no extra args — see below
sudo systemctl stop  claude-qa-watch
```

### 12. Verify

```bash
curl -I https://<domain>/
```

Expect `HTTP/2 302` with a `location:` header pointing at
`https://<domain>/oauth2/start?rd=...` — Caddy's own `(gauth)` snippet redirecting an
unauthenticated request to oauth2-proxy's login-start endpoint, still on your own domain
(`infra/caddy/Caddyfile.template`'s `handle_response @bad` block). Follow one more hop and
you land on Google itself:

```bash
curl -IL https://<domain>/
```

The final hop's `location:` (or, without `-I`, the rendered page) is Google's own
login/consent screen. If the very first `curl` instead hangs, times out, or comes back with
anything other than a redirect, work backward through the enable order in step 6 — check
Caddy first (`sudo systemctl status caddy`, `sudo journalctl -u caddy -n 50`), since nothing
downstream of it can be reachable at all until it's actually up and its certificate issued.

Once that's clean:

```bash
sudo systemctl start claude-qa-watch
curl -s localhost:9222/json/version   # Chrome's own CDP handshake — a JSON blob back means
                                       # the whole watch-stack (Xvfb, Chrome, its debugging
                                       # port) came up; loopback-only, run this ON the box
```

### 13. Android web console (optional)

A containerized Android device (redroid) streamed and touch-controllable from the
dashboard's `/droid` page, for mobile QA (adb + maestro + APK installs from `/term`).
Fully optional — skip it and nothing else here cares. Full walkthrough, including the
binder kernel modules, the container run command, and the patched ws-scrcpy build:
[`infra/droid/SETUP.md`](droid/SETUP.md). The Caddy side (the `/droidview/*` route and the
`droid.<domain>` vhost) is already in `infra/caddy/Caddyfile.template` — delete that vhost
block if you skip this.

## What this file does not cover

Deliberately delegated, not duplicated:

- Profile/agent creation and day-to-day operation (`cc`, `claude-rc`, `add-agent.sh`):
  [`fleet/SETUP.md`](../fleet/SETUP.md).
- The seven cron watchdogs, their crontab, and logrotate: [`watchdogs/SETUP.md`](../watchdogs/SETUP.md).
- tmux, the firewall baseline, fail2ban, unattended-upgrades, sshd hardening, the scoped
  sudoers grant itself, and linger's full rationale: [`infra/os/SETUP.md`](os/SETUP.md).
- The full architecture — port map, the profile-vs-agent fidelity note, why the dashboard
  runs as root, watchdog rationale, known operational caveats:
  [`docs/architecture.md`](../docs/architecture.md).
