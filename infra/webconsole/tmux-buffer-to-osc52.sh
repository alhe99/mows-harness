#!/usr/bin/env bash
# Re-emit the newest tmux buffer as OSC 52 to every attached client tty.
# Writing to the client tty bypasses tmux, so the sequence reaches ttyd raw,
# where the browser page clipboard shim (clipboard-shim.html, this same directory)
# decodes it onto the local clipboard.
#
# Not wired into any keybinding by this repo — invoke it from whatever tmux hook fits
# your own workflow, e.g. a copy-mode binding in ~/.tmux.conf:
#   bind-key -T copy-mode-vi Enter send-keys -X copy-selection-and-cancel \; run-shell "~/.local/bin/tmux-buffer-to-osc52.sh"
# (infra/os/tmux.conf ships no such binding — this script is deliberately standalone so
# it works no matter how you trigger it: a keybinding, a hook, or a manual call.)
set -euo pipefail
b64=$(tmux show-buffer 2>/dev/null | base64 | tr -d "\n") || exit 0
[ -n "$b64" ] || exit 0
for tty in $(tmux list-clients -F "#{client_tty}" 2>/dev/null); do
  [ -w "$tty" ] && printf "\033]52;c;%s\a" "$b64" > "$tty"
done
exit 0
