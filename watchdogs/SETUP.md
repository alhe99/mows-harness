# Layer 2 watchdogs — setup

Seven small, profile-agnostic cron scripts that keep the host and the Claude Code
remote-control fleet healthy: unit/wedge recovery, memory-capture verification, idle-session
reaping, orphaned MCP-server reaping, usage-limit auto-continue, a boot log, and an OS
patch-health monitor. All fleet-facing scripts discover profiles dynamically (`default` +
every `~/.claude-<suffix>` directory) — nothing here is hardcoded to a specific account
name, and every script is a no-op (exit 0) on a box with no matching profiles or units
configured yet.

## Install

```bash
install -m755 watchdogs/bin/claude-health watchdogs/bin/claude-mem-health \
  watchdogs/bin/reap-idle-claude watchdogs/bin/reap-mcp-orphans watchdogs/bin/log-boot \
  watchdogs/bin/patch-health \
  "$HOME/.local/bin/"
mkdir -p "$HOME/bin"
install -m755 watchdogs/bin/claude-limit-shield.sh "$HOME/bin/"
```

`claude-limit-shield.sh` installs to `~/bin/` (matching `crontab.example` below); the
other six go to `~/.local/bin/`.

## Crontab

```bash
crontab -l > /tmp/crontab.bak 2>/dev/null   # back up whatever's already there
cat watchdogs/crontab.example
crontab -e                                   # paste the lines in, then edit as below
```

`watchdogs/crontab.example` uses `$HOME` as a readable placeholder, but **cron does not
expand `$HOME`** (or any shell variable) — it runs each line through a minimal `/bin/sh`.
Replace every `$HOME` with your actual absolute home directory path before saving the
crontab, or the jobs will silently fail to find their scripts.

## Logrotate

```bash
sed "s|~|$HOME|g" watchdogs/logrotate.d/claude-harness > /tmp/claude-harness.rotate
sudo install -m644 /tmp/claude-harness.rotate /etc/logrotate.d/claude-harness
```

Same caveat as cron: the shipped file uses `~` as a readable placeholder — logrotate
config files don't expand it either. Render it to an absolute path before installing.

## Dependencies

- **sudoers**: `claude-health`'s auto-recovery path runs
  `sudo systemctl restart claude-remote@<profile>` when a unit is sustained-WEDGED for
  eight or more minutes. That needs a passwordless sudo rule scoped to the
  `claude-remote@*` units — see `infra/os/sudoers.d` (installed separately). Without it,
  recovery attempts just fail loudly into `claude-health.log`; the rest of the watchdog
  keeps running normally either way.
- **ss (iproute2)**: needed by `claude-health` to query established connections. If `ss` is
  absent, established connection count (`est`) is always evaluated as 0, which triggers false
  `WEDGED` states and unwarranted recovery restarts. Install via `sudo apt-get install -y iproute2`.
- **claude-mem**: no systemd service to install or start — claude-mem's own plugin hooks
  spawn its worker on `:37777` the first time a Claude Code session starts. `claude-mem-health`
  only *checks* that the worker is up and that every profile's plugin scope is still
  `user`; it never starts the worker itself.
- **agy-notify (optional)**: `patch-health` checks for `agy-notify` on PATH (from the
  `agy/` layer) to send Discord alerts when OS security updates stall. If absent, findings
  are logged to `~/.local/state/patch-health.log` and the script exits 0 without notifying.
  The script reads only world-readable files and runs `dpkg --audit` unprivileged — no sudo
  required.
- **ccusage / npx**: if `claude/settings.template.json`'s statusline
  (`npx -y ccusage@latest statusline`) is in use, its first invocation on a given machine
  fetches the package from the npm registry, which needs network access. Not a watchdog
  dependency, but a common gotcha on a freshly provisioned or offline box — the statusline
  looks broken until that one `npx` fetch succeeds.

## What each script does

| Script | Cron | Does |
|---|---|---|
| `claude-health` | `*/5 * * * *` | Per profile: is `claude-remote@<profile>` active? Any established backend connection? Sustained-WEDGED >=8min triggers `reset-claude-env` + a unit restart (rate-limited to once per 2h; disable entirely by touching `~/.local/state/claude-health.norecover`). |
| `claude-mem-health` | `*/10 * * * *` | Per profile: self-heals `installed_plugins.json` scope back to `user`; checks the shared memory worker on `:37777`; flags any transcript with real user turns that never produced a `sdk_sessions` row. |
| `reap-idle-claude` | `17 * * * *` | Kills detached tmux sessions (matching `cc-*`, `ccw-*`, `web-*`, `agy-*`) idle beyond `$IDLE` seconds (24h default) — spares any pane showing a usage-limit banner, since the shield will revive it once the reset passes. |
| `reap-mcp-orphans` | `*/15 * * * *` | Kills MCP server processes reparented to init (ppid==1, age>5min) — excludes tmux/claude/remote-control processes so a daemonized tmux server hosting a live session is never mistaken for an orphan. |
| `patch-health` | `23 4 * * *` | Detects stalled OS security updates: non-empty `dpkg --audit`, apt update stamp >3d old or missing, or reboot pending >7d. Logs findings to `patch-health.log`; optionally notifies via `agy-notify` (rate-limited to 1/day). |
| `claude-limit-shield.sh` | `*/5 * * * *` | Scans tmux panes for a stalled usage-limit banner past its parsed reset time and types a continue-nudge. Run `claude-limit-shield.sh selftest` any time to verify end-to-end behavior in a disposable throwaway session. |
| `log-boot` | `@reboot` | Appends one line per boot (kernel version + uptime) to `~/.local/state/boot-log.txt`. |

## Logs

Everything lands under `~/.local/state/`: `claude-health.log`, `claude-mem-health.log`
(plus `.alert` and `.seen`), `reap-idle-claude.log`, `reap-mcp-orphans.log`,
`patch-health.log`, `claude-limit-shield/shield.log`, and `boot-log.txt`. The first six are
covered by `logrotate.d/claude-harness`; `boot-log.txt` is small and append-only, so it isn't rotated.
