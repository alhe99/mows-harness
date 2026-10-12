#!/usr/bin/env bash
# deploy-dashboard.sh — install the dashboard onto this box and restart it (K-24: the deploy is a script, not an echo).
#   scripts/deploy-dashboard.sh [--dry-run]
# Installs, whichever exist in the checkout: lite.mjs core.mjs chat-stream.mjs capability.mjs sse.mjs static.mjs legacy.mjs,
# routes/, dist/ (and app/ while the legacy /ui client still ships), themes.json, webterm-settle.sh and the /term page (dist/term.html,
# installed by make-term-index.sh, which keeps the page it replaces as term-index.legacy.html: the rollback is a file swap)
# into $DEST (default /opt/claude-dashboard); restarts claude-dash-lite; smokes /healthz. The restart is not optional:
# the client assets are walked once per process. It also sets the unit's --ui= flag (K-21; the cutover of cockpit phase 05 is this flip):
# UI=next (default) serves the cockpit shell at /, UI=legacy is the rollback (one word and a restart). --dry-run prints every command and changes nothing.
# Env: DEST, UNIT, PORT, UI. Run from anywhere; needs sudo unless already root. Never run against a box you are not on.
set -euo pipefail
cd "$(dirname "$0")/.."

DRY=0
case "${1:-}" in
  --dry-run) DRY=1 ;;
  "") ;;
  *) echo "usage: $0 [--dry-run]" >&2; exit 2 ;;
esac
DEST=${DEST:-/opt/claude-dashboard}
UNIT=${UNIT:-claude-dash-lite}
PORT=${PORT:-3005}
UI=${UI:-next}
case "$UI" in next|legacy) ;; *) echo "deploy: UI is next or legacy, not '$UI'" >&2; exit 2 ;; esac
UNITFILE=${UNITFILE:-/etc/systemd/system/$UNIT.service}
SUDO=""; [ "$(id -u)" = 0 ] || SUDO="sudo"

run() { if [ "$DRY" = 1 ]; then echo "+ $*"; else "$@"; fi; }

# the server and the modules it imports at load, plus the split server of phase 03 (only those that exist)
FILES=()
for f in lite.mjs core.mjs chat-stream.mjs capability.mjs sse.mjs static.mjs legacy.mjs; do
  [ -f "infra/dashboard/$f" ] && FILES+=("infra/dashboard/$f")
done
[ "${#FILES[@]}" -gt 0 ] || { echo "deploy: infra/dashboard/lite.mjs not found" >&2; exit 1; }

[ "$DRY" = 1 ] || node --check infra/dashboard/lite.mjs

run $SUDO install -d -m755 "$DEST"
run $SUDO install -m644 "${FILES[@]}" "$DEST/"
for d in infra/dashboard/routes dist infra/dashboard/app; do
  if [ -d "$d" ]; then
    t="$DEST/$(basename "$d")"
    run $SUDO rm -rf "$t"
    run $SUDO cp -r "$d" "$t"
  fi
done
run $SUDO install -m644 infra/webconsole/themes.json "$DEST/themes.json"
run $SUDO install -m755 infra/webconsole/webterm-settle.sh "$DEST/webterm-settle.sh"
# the picker/attach script ttyd spawns per connection: install unlinks first, so a bash already running it keeps its old inode
run $SUDO install -m755 infra/webconsole/web-term.sh "$DEST/web-term.sh"
# the term page: dist/term.html copied to $DEST/term-index.html, the previous one kept as term-index.legacy.html (it prints its own sudo line if DEST is not writable)
run $SUDO infra/webconsole/make-term-index.sh "$DEST/term-index.html"

# the flag flip: replace the unit's --ui=... on its ExecStart line (or add it), then reload systemd so the restart below runs the new command line
if [ "$DRY" = 1 ] || grep -q '^ExecStart=.*lite\.mjs' "$UNITFILE" 2>/dev/null; then
  run $SUDO sed -i -E "/^ExecStart=.*lite\.mjs/{s/ --ui=[a-z]+//;s/\$/ --ui=$UI/}" "$UNITFILE"
  run $SUDO systemctl daemon-reload
fi
run $SUDO systemctl restart "$UNIT"
if [ "$DRY" = 1 ]; then
  echo "+ smoke: curl -sf http://127.0.0.1:$PORT/healthz (retry 15 s)"
  exit 0
fi
for _ in $(seq 1 15); do
  if curl -sf "http://127.0.0.1:$PORT/healthz" >/dev/null; then echo "deploy: /healthz ok on :$PORT"; exit 0; fi
  sleep 1
done
echo "deploy: /healthz did not answer on :$PORT after restarting $UNIT (journalctl -u $UNIT -n 50)" >&2
exit 1
