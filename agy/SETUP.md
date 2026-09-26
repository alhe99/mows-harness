# agy layer — Antigravity sessions + Discord message bridge

What ships: `ag` (cc-style tmux launcher), `agy-run` (sync wrapper,
fail-loud — `claude/scripts/discord-via-agy.sh` uses `agy-run --fast` to
compose Discord messages), `agy-notify` (Discord webhook poster, used by
watchdogs such as `patch-health-check`), `claude-quota` (per-account usage
signal for the SessionStart line and `mows-agent`'s `quota_floor`; the 70%
threshold lives there).

The 70%-quota delegation flow (`agy-handoff`/`agy-gate`, the `agy-delegate`
skill, the `quota-gate` UserPromptSubmit hook) was removed 2026-09-26 — two
Claude accounts cover the headroom. Its original design stays in
`docs/superpowers/specs/2026-08-10-antigravity-delegation-design.md` for
history.

## One-time setup on a box

1. `./install.sh --agy`. Ensure `~/.local/bin` is on your `PATH`.
2. Install the antigravity CLI (the installer never does this for you):
   `curl -fsSL https://antigravity.google/cli/install.sh | bash`
3. Login once: run `agy` in a terminal — over SSH it prints a URL + one-time
   code. **Verify persistence:** open a NEW shell, run
   `agy -p "ping" --output-format json` — if it demands login again, the box
   lacks a freedesktop-secrets keyring (headless-Linux issue
   google-antigravity/antigravity-cli#57): install `gnome-keyring` + `dbus`
   and enable a user-session keyring, then re-login and re-verify:
   ```bash
   sudo apt-get install -y gnome-keyring dbus-x11
   # Start a session keyring:
   eval $(dbus-launch --sh-syntax)
   eval $(echo -n "" | gnome-keyring-daemon --daemonize --login)
   # Or run commands wrapped in dbus-run-session:
   # dbus-run-session -- agy ...
   ```
4. `agy models` → copy your preferred flash-tier slug into
   `~/.config/mows-agy/config` (`AGY_FAST_MODEL`).
5. Discord webhook for `agy-notify`: create one (channel settings →
   Integrations → Webhooks), paste its URL into `AGY_DISCORD_WEBHOOK` in
   `~/.config/mows-agy/config`, and `chmod 600` the file. Until then
   `agy-notify` is a silent no-op.

## Day-2

- Sessions: `ag [dir]` (interactive, reaped when idle+detached like cc).
- `agy-run` exit 2 = agy quota exhausted (empty response), exit 3 = needs
  re-login (`ag`). The Discord bridge falls back to a plain send when agy is
  unavailable.

## Live deployment record (2026-08-10, reference box)

- agy CLI **1.1.11** (official installer, aarch64) — installs to `~/.local/bin/agy`.
- **Keyring/token persistence: issue NOT present** on this version/box — auth
  survives fresh shells with no freedesktop-secrets daemon.
- `AGY_FAST_MODEL=gemini-3.6-flash-medium` (~6s round trip).
- Slugs with an embedded effort/thinking level (`*-high/-low/-thinking`)
  reject an additional `--effort` flag — silent exit 1.

## Testing

- **Hermetic matrix** — `bash scripts/e2e-agy.sh` (quota semantics,
  selftests, reaper, launcher, notifier against stubs in an isolated HOME on
  a private tmux socket; seconds, free, safe on a live box).
  `BIN_DIR=~/.local/bin` targets the installed copies. Also runs inside
  `scripts/e2e-container.sh` (CI).
- **Live check** — `scripts/live-agy.sh --yes` (real agy: auth persistence,
  model-table validity). Costs a little AI Pro quota; never run by CI.
