#!/usr/bin/env bash
# QA watch-stack: Xvfb (virtual display) + fluxbox (minimal WM) + x11vnc (VNC server) +
# websockify (VNC-over-websocket, for noVNC) + a real Chrome/Chromium with its remote
# debugging port open. Backgrounds all five and returns immediately — this is exactly
# what infra/qa-watch/claude-qa-watch.service.template's Type=oneshot/RemainAfterExit=yes
# unit expects (see that file's own header for why).
#
# Consumers: the `qa` skill's watched mode drives Chrome over CDP (127.0.0.1:9222,
# chrome-devtools-watch/playwright-watch in ~/.claude/mcp-interactive.json — snippet in
# infra/qa-watch/SETUP.md) while a human watches/acts through noVNC (127.0.0.1:6080,
# proxied at /vnc/ by infra/caddy/Caddyfile.template's (vncproxy) snippet, behind the same
# Google-OAuth gate as everything else this harness exposes).
#
# Already generic — $HOME (not a hardcoded home dir) was already used for the Chrome
# profile dir in the live source this was harvested from; nothing to template there.
set -euo pipefail
export DISPLAY=:99
pkill -f "Xvfb :99" 2>/dev/null || true
Xvfb :99 -screen 0 1920x1080x24 -ac -noreset &
sleep 1
fluxbox >/dev/null 2>&1 &
# -nopw: no VNC password. Safe here — x11vnc is -localhost (only websockify on the
# same box reaches it) and websockify is only exposed via Caddy behind Google OAuth,
# which is the real auth gate. Lets noVNC autoconnect with no password prompt.
x11vnc -display :99 -forever -shared -nopw -rfbport 5901 -localhost >/dev/null 2>&1 &
websockify --web=/usr/share/novnc/ 127.0.0.1:6080 127.0.0.1:5901 >/dev/null 2>&1 &

# Chrome binary name varies by distro/arch — Google ships google-chrome-stable (as the
# `google-chrome` binary) for amd64 only; there is no Google-built arm64 Linux Chrome, so
# an arm64 box needs chromium/chromium-browser instead (see SETUP.md for exactly what's
# available where). Try the common names in order rather than hardcoding one.
CHROME_BIN=""
for b in google-chrome google-chrome-stable chromium-browser chromium; do
  command -v "$b" >/dev/null 2>&1 && { CHROME_BIN="$b"; break; }
done
if [ -z "$CHROME_BIN" ]; then
  echo "watch-browser.sh: no Chrome/Chromium binary found on PATH (tried: google-chrome google-chrome-stable chromium-browser chromium) — see infra/qa-watch/SETUP.md" >&2
  exit 1
fi
"$CHROME_BIN" \
  --user-data-dir="$HOME/chrome-watch-profile" \
  --remote-debugging-port=9222 \
  --remote-debugging-address=127.0.0.1 \
  --no-first-run --disable-dev-shm-usage --start-maximized &
# Keep Chrome raised/mapped so a watcher never lands on a bare fluxbox desktop
# (it can get un-raised). Retry for ~20s while Chrome's window appears, then idle.
( command -v xdotool >/dev/null || exit 0
  for _ in $(seq 1 10); do
    wid=$(xdotool search --name "Google Chrome" 2>/dev/null | tail -1) || true
    [ -n "$wid" ] && { xdotool windowmap "$wid"; xdotool windowactivate "$wid"; xdotool windowraise "$wid"; } 2>/dev/null
    sleep 2
  done ) >/dev/null 2>&1 &
echo "Watch stack up. CDP on 127.0.0.1:9222, noVNC on 127.0.0.1:6080"
