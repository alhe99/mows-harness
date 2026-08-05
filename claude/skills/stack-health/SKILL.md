---
name: stack-health
description: "Full stack-integrity health check for a self-hosted Claude Code harness box (reference deployment: Oracle Cloud A1, aarch64) — verifies every systemd service, any configured extra service (HARNESS_EXTRA_SERVICES, e.g. a Discord bot gateway) and its Node engine compliance, listening ports, local endpoints, external HTTPS + TLS cert expiry for your configured vhosts, toolchain/PATH integrity, MCP server resolvability, claude-mem capture, host resources, and pending updates. Use when the user asks whether the VM or stack is healthy, whether services are up, whether the site or Discord bots are working, after a reboot or upgrade, or asks to check on the server. For billing/free-tier questions use oci-free-check instead."
---

# stack health

Run the script. It's deterministic — don't re-derive the checks by hand.

```bash
~/.claude/skills/stack-health/check.py
```

Takes ~60s. Runs **from this machine**, not on the box, so the HTTPS/TLS checks
come from a genuinely external vantage point while host checks go over one
multiplexed SSH connection.

Configure it for your deployment via environment variables:

| Variable | Purpose | Default |
|----------|---------|---------|
| `HARNESS_SSH_HOST` | SSH alias for the box (define it in `~/.ssh/config`) | `harness` |
| `HARNESS_DOMAIN` | Primary vhost to check over HTTPS/TLS | `example.com` |
| `HARNESS_SUBDOMAINS` | Comma-separated subdomains, checked as `<sub>.<HARNESS_DOMAIN>` | (none) |
| `HARNESS_EXTRA_SERVICES` | Extra services to check, `name:port,name2:port2` — each gets a root systemd --user unit check (section 2), a listening-port check (section 3), and a local-endpoint check (section 4) | (none — section 2 skipped entirely) |
| `HARNESS_DISCORD_BOTS` | Comma-separated bot instance names to look for in an extra service's logs | (none — sub-check skipped) |
| `HARNESS_USER` | Unprivileged account running claude-mem, for the claude-mem check | (none — sub-check skipped) |

## Exit codes

| Code | Meaning | What to do |
|------|---------|------------|
| `0` | All healthy | Report briefly. Don't paste every green tick. |
| `1` | Healthy with warnings | Read each one. Often advisory (apt updates, reboot pending, a bot quiet in logs). |
| `2` | **Something is down or broken** | Lead with it, name the service, and offer the fix. |

## What it covers

1. **systemd services** — 12 units + any failed unit on the box
2. **extra services** (optional, `HARNESS_EXTRA_SERVICES`, skipped entirely if unset) —
   root *user* service state, linger (must survive reboot), version,
   **node engine compliance**, configured Discord bots (`HARNESS_DISCORD_BOTS`), error count
3. **Ports** — 7 required + any configured extra services; `:37777` is advisory (session-spawned, absent is normal)
4. **Local endpoints** — with per-port expected codes (`:4180` 302 and `:7681` 404-on-`/`
   are both *correct*, not faults)
5. **External HTTPS** — your configured vhosts (`HARNESS_DOMAIN` + `HARNESS_SUBDOMAINS`) +
   TLS expiry, warns under 14 days (Caddy renews at 30)
6. **Toolchain integrity** — PATH resolution and MCP resolvability
7. **claude-mem** — health verdict + DB write freshness
8. **Host** — memory (incl. the 20% idle-reclamation bar), disk, load, kernel,
   reboot-pending, apt

## Scope

Stack integrity only. **Billing and free-tier limits live in `oci-free-check`** —
don't duplicate that here. The one overlap is memory %, because it doubles as the
idle-reclamation signal.

## Gotchas encoded — do not "simplify" these out

Each caused a wrong answer when this was built:

- **`env PATH=... command -v x` is broken.** `command` is a shell *builtin*, so
  `env` tries to exec a binary named "command" and fails — making every probe
  report MISSING. The script exports PATH and uses the builtin directly. The first
  version of this check reported 7 false failures on a perfectly healthy box.
- **Parse `Environment=PATH=` with `sed -n 's/^Environment=PATH=//p'`, not
  `cut -d= -f2-`.** `cut` leaves a literal `PATH=` prefix, so the first directory
  becomes the invalid path `PATH=/home/<user>/.local/bin` and gets skipped —
  silently changing which binary appears to win.
- **A registered MCP server whose command doesn't resolve is a real failure.**
  That is exactly how codegraph broke after migration: `.claude.json` still had the
  registration, but the binary was gone.
- **fnm-scoped npm globals are a migration blind spot.** Packages installed with
  `npm i -g` while an *fnm* node was active live under `.local/share/fnm/...`, which
  is excluded as x86 during any arch migration. codegraph was lost this way.
- **Third-party apt repos are the other blind spot.** `gh` comes from
  cli.github.com, not Ubuntu main, so a base-package install misses it. Its absence
  is especially nasty: `.gitconfig` hardcodes
  `!/usr/bin/gh auth git-credential`, so git reports an *auth* failure rather than a
  missing binary, and `git status` still looks clean because it compares against a
  stale `origin/*` ref. This went unnoticed for **19 days**. Hence the explicit
  credential-helper check — verify the helper binary exists AND `gh auth status`
  passes, never just that git is installed.
- If a CLI goes missing, suspect those two categories first.
- **An extra service's node engine must be checked, not assumed.** One such
  service once required `>=22.22.3` while its tree sat under node v22.22.1, and
  worked only because `/usr/bin` happened to precede the nvm path in the unit's
  PATH. Correct by luck is not correct.
- **`:7681` serves under `--base-path /term`**, so `/` returning 404 is right.
  Probe `/term/`.

## Reporting

Lead with the verdict. On exit 0 keep it to a couple of lines. On exit 2, name what
is down and what it affects (e.g. caddy down = all six hostnames offline; a
configured extra service down = whatever depends on it, e.g. its Discord bots,
offline), then offer the fix.
