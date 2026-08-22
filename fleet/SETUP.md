# Fleet layer — setup

This harness runs multiple Claude Code identities on one box in TWO different, unrelated
ways. Read this section before touching either — mixing them up is the most likely mistake.

## Profile model vs agent model — read this first

| | **Profile model** | **Agent model** |
|---|---|---|
| Tooling | `fleet/bin/{cc,claude-rc,claude-status,reset-claude-env}` | `fleet/add-agent.sh` |
| Shape | ONE Linux user (the admin), N `~/.claude`/`~/.claude-<suffix>` config dirs | N separate Linux user accounts, one per agent, each with its own `~/.claude` |
| Provenance | **Extracted from, and validated against, a real working reference box.** Every script's header documents the exact live behavior it replaced. | **Designed fresh for this repo. No live precedent.** Nothing here was extracted from anywhere, and — as of this task — it has never run for real, not even once, on the reference box. |
| Status | Proven | Unvalidated in production; validated only via `bash -n`/shellcheck, `DRY_RUN=1` transcripts, and rendered-copy `visudo -cf`/`systemd-analyze verify` (see `.superpowers/sdd/task-14-report.md` if you have it) |

**Say this plainly, don't paper over it:** if you are choosing between the two for a real
deployment, the profile model is the one with actual production mileage behind it. The agent
model is a reasonable, carefully-reasoned design — not a guess — but "carefully reasoned" and
"battle-tested" are different claims, and this file will not blur them.

They are also **not interchangeable** — a profile is a config directory under an account you
already trust with everything else on the box; an agent is its own account, its own home,
its own (optional) systemd unit. Pick per identity based on how much isolation you actually
want, not on which happens to be documented first below.

---

## Profile model: `cc` / `claude-rc` / `claude-status` / `reset-claude-env`

One Linux user (typically whoever administers the box) running several named Claude Code
*profiles* — `default` plus any `~/.claude-<suffix>` directory. Full behavioral detail lives
in each script's own header comment (all four are extensively self-documented); this is the
quick-start version.

**Creating a profile:** A profile directory comes to exist when you create its config dir and run Claude Code inside it once (the first run performs login):
```bash
mkdir -p ~/.claude-work && CLAUDE_CONFIG_DIR=~/.claude-work claude
```

Make sure `mkdir -p ~/Projects` (the default `PROJECTS_ROOT`) exists on the machine.

**Keep the `<suffix>` to `[A-Za-z0-9_-]`.** The sudoers grant's unit patterns
(`infra/os/sudoers.d/claude-harness.template`) are anchored POSIX-ERE on exactly that
character class — a profile suffix with a space, a dot, or anything else outside it won't
match, so `claude-rc` for that profile fails closed to a password prompt instead of the
intended NOPASSWD path.

- **`cc [profile] [dir] [-- <claude flags>]`** — launch Claude Code for a profile inside a
  named tmux session (`cc-<profile>-<slug>`), or `exec` directly when there's no tty (systemd,
  a nested shell). Bare `cc` = `default` profile, current directory. If that profile+directory
  already has a live session, `cc` asks — `[Enter]` re-attaches it, `[n]` starts a second
  session alongside it (`cc-<profile>-<slug>-2`, `-3` …), `[q]` backs out — so parallel
  sessions in one directory are a deliberate choice, never a silent re-attach.
  ```bash
  cc                      # default profile, here
  cc work ~/Projects/foo  # "work" profile (~/.claude-work), that directory
  cc work -- --resume     # pass flags through to claude itself
  ```
- **`claude-rc <subcommand>`** — manage/switch the profile's Remote Control systemd units
  (`claude-remote@<profile>.service` / `claude-remote-control@<profile>.service`). Run
  `claude-rc` (no args) or `claude-rc --help` for the full subcommand list — `status`,
  `start`/`stop`/`only`/`all`, `workdir`, `boot`, `logs`, `resume`, `set-effort`/`set-model`,
  `open`/`close`/`listeners` (per-project transient listeners), `switch` (re-host the
  *current* session onto new model/effort settings). `DRY_RUN=1 claude-rc ...` previews every
  `sudo systemctl` / `systemd-run --user` call it would make.
- **`reset-claude-env <profile>`** — recover a stuck/flapping remote-control unit: stop it,
  clear its cached env pointer, start it again. This is the *only* thing that should ever
  restart `claude-remote@<profile>`; `watchdogs/bin/claude-health`'s auto-recovery calls this
  script rather than restarting the unit itself. `DRY_RUN=1` previews.
- **`claude-status`** — one glance at every profile: unit state, live `cc` tmux session
  presence, and the cached `claude-health` snapshot (regenerated if stale).

### Needs

1. **Sudoers grant** (installed by `infra/os/SETUP.md`, not repeated here): the sudoers grant in
   `infra/os/sudoers.d/claude-harness.template`, scoped to exactly the `claude-remote@*` /
   `claude-remote-control@*` unit families — see below for the two group/permission notes that
   apply to this model.
2. **Systemd units**: render and install the two remote-control units (`claude-remote@.service` and `claude-remote-control@.service`):
   ```bash
   ./install.sh --infra --non-interactive
   sudo install -m644 rendered/claude-remote@.service rendered/claude-remote-control@.service /etc/systemd/system/
   sudo systemctl daemon-reload
   ```

---

## Agent model: `fleet/add-agent.sh` walkthrough

```
sudo fleet/add-agent.sh <name> [--remote-control] [--vhost[=<domain>]]
```

**`<name>` must be exactly `agent` or `agent-<label>`** (label: `[a-z0-9_-]+`) — enforced by
the script via an anchored `[[ =~ ]]` regex (`^agent(-[a-z0-9_-]+)?$`), not just a suggestion
and not a `case`/glob (a glob's `[...]`/`*` don't anchor "and nothing else follows" — see the
script's own "FIX D" header note). `infra/dashboard/lite.mjs`'s `discoverAccounts()` (Task 13)
only recognizes logins matching `/^agent(?:-(.+))?$/` as automation identities; anything else
gets treated as a human profile-model account, which can silently make a fleet agent eligible
to become the dashboard's tmux owner in the admin's place. Pick a label, don't invent your own
prefix.

1. **Create the account** (idempotent — safe to re-run):
   ```bash
   sudo fleet/add-agent.sh agent-alpha
   ```
   Creates the Linux user (skipped if it already exists and isn't a pre-existing system
   account), copies the repo's `claude/global/CLAUDE.md` plus
   `claude/{rules,agents,commands,skills}` into `~agent-alpha/.claude` as a **real copy** (cross-user symlinks don't resolve — a symlink
   into another user's home usually can't even be traversed, and even where it could, sharing
   inodes across trust boundaries defeats the point of separate accounts), copies
   `claude/mcp.template.json` to `~agent-alpha/.claude/mcp-interactive.json.template`, and
   locks the home down (`chown -R agent-alpha:agent-alpha ~agent-alpha/.claude
   ~agent-alpha/Projects`, plus `chmod 750 ~agent-alpha` — but only when this run is the one
   that actually created the account; see point 2 below for what happens to a pre-existing
   home instead).
   Re-running the same command **re-syncs**, it doesn't just merge: each of the five config
   items is removed and recopied fresh, so a file dropped from the repo since your last run
   actually disappears from the agent's copy too.
2. **Won't silently adopt a pre-existing account.** The guard fires for ANY account that
   already existed before this run — whether or not `~agent-alpha/.claude` happens to exist
   yet — unless it already carries the `.mows-harness-agent` marker file (proof either a
   previous run of this same script created/adopted it, or you opted in by hand — see below).
   A brand-new account (created by *this* run) always proceeds normally and gets the marker
   written for you. This exists because a box can already be running *other* automation that
   provisions one Linux user per bot identity, for reasons that have nothing to do with this
   harness — `uid >= 1000` alone proves an account isn't a *system* account, it does not prove
   it's *ours*, and that's true whether or not it happens to have a `~/.claude` yet. If you hit
   this and are certain the account should become a fleet agent, opt in explicitly first, then
   re-run:
   ```bash
   sudo -u agent-alpha mkdir -p ~agent-alpha/.claude && sudo -u agent-alpha touch ~agent-alpha/.claude/.mows-harness-agent
   ```
   Relatedly: this script only ever `chmod 750`s a home it created itself in *this* run — a
   pre-existing home's permissions (marker or not) are left exactly as they were.
3. **Optionally add Remote Control** (`--remote-control`): installs
   `claude-remote-<name>@.service` (rendered from `infra/systemd/claude-remote@.service`,
   `User=<name>`) plus a sudoers file scoped to *only* that unit family — see "Why a
   per-agent unit and a per-agent sudoers file" below. Neither is enabled or started; a brand
   new account has no Claude Code OAuth session yet, so starting immediately would just
   crash-loop. Once `<name>` has actually logged in interactively at least once (so a real
   OAuth token exists under `~<name>/.claude`):
   ```bash
   sudo systemctl enable --now claude-remote-agent-alpha@default.service
   ```
4. **Optionally print a Caddy vhost snippet** (`--vhost` / `--vhost=<domain>`): see "Vhost
   snippet" below.
5. **Render the MCP config.** The script ships only `mcp-interactive.json.template`
   (placeholders, no secrets — never a real key). Before the agent's first session:
   ```bash
   cp ~agent-alpha/.claude/mcp-interactive.json.template ~agent-alpha/.claude/mcp-interactive.json
   # then edit in a real value for {{CONTEXT7_API_KEY}} etc.
   ```
6. **Give it a way to log in.** `add-agent.sh` does not touch SSH access — the account is
   created password-locked, as `useradd -m` leaves it by default (matches this harness's own
   `PasswordAuthentication no` posture from `infra/os/SETUP.md`). Add a key yourself, then fix
   ownership/perms explicitly — `sudo mkdir -p`/`sudo tee` both write as root, so skipping the
   `chown`/`chmod` step leaves `~agent-alpha/.ssh` root-owned and unusable for that account's
   own SSH login (nothing else fixes this for you; it is not enforced by the script):
   ```bash
   sudo mkdir -p ~agent-alpha/.ssh && sudo tee ~agent-alpha/.ssh/authorized_keys < your_key.pub
   sudo chown -R agent-alpha:agent-alpha ~agent-alpha/.ssh && sudo chmod 700 ~agent-alpha/.ssh && sudo chmod 600 ~agent-alpha/.ssh/authorized_keys
   ```
   (or provision however your box normally grants SSH access to a new account).

Preview any of the above without changing anything:
```bash
DRY_RUN=1 sudo fleet/add-agent.sh agent-alpha --remote-control --vhost=example.com
```
Every mutating step (`useradd`, `mkdir`, `rm`, `cp`, `chown`, `chmod`, the unit/sudoers
install, `daemon-reload`) prints `DRY_RUN: <command>` instead of running it. The two
validation steps — `systemd-analyze verify` on the rendered unit, `visudo -cf` on the
rendered sudoers file — still run for real even under `DRY_RUN`, since neither touches
persistent system state; that's what lets a dry run prove the rendered content is actually
valid, not merely describe what it would have installed.

### Why a per-agent unit and a per-agent sudoers file, not the canonical ones

`infra/systemd/claude-remote@.service` hardcodes `User={{ADMIN_USER}}` — one rendered unit
file can only ever run as one Linux user, and the profile model's admin account already owns
the canonical `claude-remote@`/`claude-remote-control@` names plus the matching grant in
`infra/os/sudoers.d/claude-harness.template`. An agent is a *different* Linux user, so it can
reuse neither. `add-agent.sh` installs the agent's unit under a name-carrying family instead
— `claude-remote-<name>@.service` — with a matching **per-agent** sudoers file (rendered from
the new `infra/os/sudoers.d/claude-harness-agent.template`) that grants `<name>` (not the
admin) NOPASSWD rights over *only* `claude-remote-<name>@*`, using the same anchored-POSIX-ERE
style as the admin's own template (verb inside the `^...$` anchors — see either template's
header for the full glob-vs-regex rationale, and `infra/os/sudoers.d/claude-harness.template`
specifically for the real vulnerability class this closes: a bare `@*` glob matches sudoers
arguments as one concatenated string, so it also matches a trailing extra argument — e.g. an
absolute path to an attacker-placed unit file).

This is deliberately **not** one wildcarded "any agent" pattern shared across every agent (or
folded into the admin's own grant) — that shape would let one agent start/stop/enable/disable
every *other* agent's listener too, trading a real cross-account interference surface for a
few characters of regex convenience. Splicing each agent's own already-validated name into
its own pattern instead costs nothing and closes that off completely: `agent-alpha` can only
ever touch `claude-remote-agent-alpha@*` — not `claude-remote-agent-bravo@*`, and not the
admin's own `claude-remote@*`.

**Scope note — no `claude-rc` for agents yet.** `add-agent.sh` does not copy
`fleet/bin/{cc,claude-rc,claude-status,reset-claude-env}` into the agent's home. Even if it
did, `claude-rc`'s own unit lookup is hardcoded to the *canonical* `claude-remote@`/
`claude-remote-control@` family — it has no idea the per-agent `claude-remote-<name>@` family
exists, so it would manage the wrong unit. Today, agent self-service is a plain
`sudo systemctl {start,stop,restart,enable,disable} claude-remote-<name>@default.service`
(matches the sudoers grant `add-agent.sh` installs); a `claude-rc`-equivalent for the agent
model is future work.

### Vhost snippet

`--vhost` (bare) reads `$HARNESS_DOMAIN`; `--vhost=<domain>` sets one inline; with neither, it
prints the same Caddy block with a literal `{{DOMAIN}}` placeholder and says so plainly — it
never silently emits something you'd paste unchecked. The printed subdomain label drops the
`agent-` prefix (`agent-alpha` → `alpha.<domain>`) for a cleaner public hostname. Note
space-separated `--vhost <domain>` is **not** supported on purpose: `add-agent.sh --vhost
agent-alpha` would be ambiguous between "no domain, name agent-alpha" and "domain agent-alpha,
name missing" — `=` removes the ambiguity instead of guessing. Paste the printed block into
`infra/caddy/Caddyfile` (or your rendered copy), `caddy validate --config <file> --adapter
caddyfile`, then `sudo systemctl reload caddy`.

---

## Linger (`sudo loginctl enable-linger <user>`)

Covered in full in `infra/os/SETUP.md` §7 — repeated here because it's easy to miss if you
only ever read this file. `claude-rc`'s `open`/`switch` machinery (profile model) spawns
`systemd-run --user` transient units instead of using sudo; those die the moment the account's
last login session ends unless lingering is enabled for it, one time:
```bash
sudo loginctl enable-linger <the account claude-rc runs as>
```
Without it, expect `claude-rc: no systemd --user session` right after the SSH session that ran
`open`/`switch` closes. **This applies to the profile model's account.** Agent accounts don't
need it today — they get no `claude-rc`-equivalent tooling in this task (see the scope note
above) — but if you ever give an agent its own `--user`-scope automation, the same requirement
follows it.

## `systemd-journal` group (read-without-sudo journal access)

`claude-rc logs <profile>` runs plain `journalctl -u <unit> -f` — no sudo wrapper (see
`claude-rc`'s own header comment). Reading another account's unit logs without sudo is a
group-membership concern, not a sudo one: add whichever account needs it to `systemd-journal`
(`sudo usermod -aG systemd-journal <user>`) if `logs` — or a bare `journalctl -u
claude-remote-<name>@default.service` run as an agent itself — reports permission denied. Not
granted by default; see the next section for why.

## No extra groups, by design

`add-agent.sh` creates every agent with a plain `useradd -m -s /bin/bash <name>` — no `-G`
flag, ever. No `sudo`, no `docker`, no `systemd-journal`, nothing beyond the account's own
primary group. This is deliberate, not an oversight: an agent's entire footprint on the box is
its own home directory plus the one narrowly-scoped sudoers grant `--remote-control` installs
for its own unit family — nothing wider. If you need `systemd-journal` for a specific agent,
add it by hand (previous section); don't change the script's defaults to do it for everyone.

## Dashboard discovery is automatic — but only at its own startup

`infra/dashboard/lite.mjs`'s `discoverAccounts()` (Task 13) scans `/home/*` at process start
for any `.claude`/`.claude-<suffix>` directory that has a `projects/` subdirectory, and picks
up every agent this script creates automatically — nothing to register or configure. Two
consequences worth knowing before you wonder why a new agent "isn't showing up":

- **A brand new agent has no `projects/` dir until its first real session.** The dashboard
  won't list it before that, even if the dashboard restarts in between — this is the same
  filter that keeps unrelated `.claude-*` dotfiles/caches from appearing as bogus accounts,
  not a bug.
- **Discovery runs once, at startup, full stop.** Restart the dashboard unit after
  provisioning a new agent (or after its first session finally creates that `projects/` dir)
  or it stays invisible until the next restart:
  ```bash
  sudo systemctl restart claude-dash-lite     # unit name per claude-dash-lite.service.template
  ```

Names matching `agent`/`agent-<label>` get the dashboard's "automation identity" treatment
(no tmux "resume in terminal" affordance, sorted after human profile accounts) — the whole
reason `add-agent.sh` enforces that naming shape in the first place; see the walkthrough
above.
