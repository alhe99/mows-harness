# QA watch-stack — setup

On-demand, human-in-the-loop browser takeover for the `qa` skill's `watched` mode
(`claude/skills/qa/SKILL.md`): a virtual X display running a real Chrome with its remote
debugging port open, mirrored to noVNC so a person can watch or drive it, while agent MCP
tools drive the same Chrome over CDP. Nothing here runs unless something explicitly starts
it — see "Ships disabled" below.

## 1. Install the OS dependencies

```bash
sudo apt install -y xvfb fluxbox x11vnc websockify novnc xdotool
```

**None of these are installed by default** — confirmed directly on the reference box
(`dpkg -l` / `command -v` for all six: zero hits) before writing this file, so treat "apt
install this once" as a real, un-skippable step, not boilerplate.

### Chrome / Chromium

```
https://dl.google.com/linux/direct/google-chrome-stable_current_amd64.deb
```

That direct download is **amd64 only** — Google does not ship a Linux Chrome build for
arm64 at all (confirmed: no `google-chrome*` package or apt source exists for arm64 on the
reference box, and `apt-cache policy` shows no candidate). On an arm64 box, use Chromium
instead:

```bash
sudo apt install -y chromium-browser   # Ubuntu 24.04 arm64: pulls in the chromium SNAP
                                        # via a transitional package (confirmed on the
                                        # reference box — the apt candidate's version
                                        # string literally contains "snap1"); snapd itself
                                        # is preinstalled on stock Ubuntu, so this works
                                        # out of the box, but inherits snap's usual
                                        # confinement quirks (e.g. --user-data-dir must
                                        # resolve under a path the snap can actually write,
                                        # which $HOME/chrome-watch-profile satisfies).
```

`watch-browser.sh` tries `google-chrome`, `google-chrome-stable`, `chromium-browser`, then
`chromium` in that order and fails loudly (naming exactly what it tried) if none are found
— it does not hardcode one binary name, so either install path above works unmodified.

**Currently broken on the reference box specifically**: this box is arm64 and has *none*
of the six apt dependencies above nor any Chrome/Chromium binary installed — watched QA
mode will not start there until this section's steps are actually run. Flagging this so
"ships disabled" (below) isn't mistaken for "already working, just needs a start command."

## 2. Install the unit (ships disabled — do not enable)

```bash
sed "s/{{ADMIN_USER}}/<your-user>/g" infra/qa-watch/claude-qa-watch.service.template \
  | sudo tee /etc/systemd/system/claude-qa-watch.service >/dev/null
install -m 0755 infra/qa-watch/watch-browser.sh "$HOME/watch-browser.sh"
sudo systemctl daemon-reload
```

Deliberately **no** `systemctl enable` step. This unit ships disabled on purpose — see the
template's own header comment: the sudoers grant it depends on
(`infra/os/sudoers.d/claude-harness.template`) only covers `start`/`stop`, not
`enable`/`disable`, because a screen-sharing debug stack has no business auto-starting at
boot. The `qa` skill starts it on demand, exactly as:

```bash
sudo systemctl start claude-qa-watch      # note: no .service suffix, no extra args — the
sudo systemctl stop  claude-qa-watch      # sudoers grant for this unit is an EXACT-MATCH
                                           # line, not a glob; anything else falls through
                                           # to an interactive password prompt
```

Verify it actually came up:

```bash
sudo systemctl start claude-qa-watch
curl -s localhost:9222/json/version       # Chrome's own CDP handshake — a JSON blob back
                                           # means the whole stack (Xvfb, Chrome, its
                                           # debugging port) is alive
```

Logs: `journalctl -u claude-qa-watch` (this is a `Type=oneshot`/`RemainAfterExit=yes` unit
— it backgrounds five daemons and exits, so "active" here means "launched successfully,"
not "still running its own foreground process").

## 3. Ports (unchanged from the harvested source, kept literal — not identity-bearing)

- `127.0.0.1:9222` — Chrome's remote-debugging (CDP) port. Agent MCP tools attach here
  (below); never expose this port outside loopback.
- `127.0.0.1:6080` — websockify, proxying VNC over websocket for noVNC. Reached publicly
  only via Caddy's `/vnc/*` route (`infra/caddy/Caddyfile.template`'s `(vncproxy)` snippet
  — already shipped, gated behind the same Google-OAuth `(gauth)` snippet as everything
  else this harness exposes; nothing new to configure there for this task).

## 4. Watch-variant MCP servers — paste into `~/.claude/mcp-interactive.json`

`claude/mcp.template.json` intentionally ships without these two — its own `_comment`
field points here: "watch-mode variants (CDP :9222) intentionally not listed here - they
fail without the layer-3 qa stack. Copy them from infra/qa-watch/SETUP.md after installing
it." That's this section. Once the watch-stack above is actually running, add these two
entries to your **interactive** MCP config (`~/.claude/mcp-interactive.json`, per-profile,
never the base `mcp.template.json`) alongside the existing `chrome-devtools`/`playwright`
entries — same tool families, but attaching to the ALREADY-RUNNING Chrome over CDP instead
of each launching (and hiding) their own:

```json
{
  "mcpServers": {
    "chrome-devtools-watch": {
      "type": "stdio",
      "command": "npx",
      "args": ["-y", "chrome-devtools-mcp@latest", "--browser-url=http://127.0.0.1:9222", "--no-usage-statistics"]
    },
    "playwright-watch": {
      "type": "stdio",
      "command": "npx",
      "args": ["-y", "@playwright/mcp@latest", "--cdp-endpoint", "ws://127.0.0.1:9222"]
    }
  }
}
```

`--browser-url`/`--cdp-endpoint` are each package's own documented flag for attaching to
an already-running, already-debuggable browser instead of launching a fresh one (verified
against each project's own current CLI reference before writing this — `chrome-devtools-
mcp`'s `browserUrl`/`-u` option and `@playwright/mcp`'s `--cdp-endpoint`, both accepting a
bare `host:port` origin: the tooling does its own `/json/version` discovery from there, no
per-launch websocket UUID needed). Dropped every OTHER flag the non-watch entries carry
(`--headless`, `--isolated`, `--no-sandbox`, `--browser chromium`) — those all control how
each tool launches its **own** browser, which doesn't happen in this mode at all; kept
`--no-usage-statistics` since that's a telemetry opt-out unrelated to launch vs. attach.

The `qa` skill (`claude/skills/qa/SKILL.md`) selects `mcp__chrome-devtools-watch__*` /
`mcp__playwright-watch__*` by name for `mode: watched` journeys — the server names above
must match exactly.

## Dependencies recap

- `infra/os/sudoers.d/claude-harness.template` — the `start`/`stop` grant this unit needs
  (installed separately; see `infra/os/SETUP.md`).
- `infra/caddy/Caddyfile.template` — the `(vncproxy)` route that exposes noVNC publicly,
  behind Google OAuth (already shipped; nothing to add here).
- `claude/skills/qa/SKILL.md` — the only intended caller of `systemctl start/stop
  claude-qa-watch`; see its own "watched" mode steps for the end-to-end flow this stack
  serves.
