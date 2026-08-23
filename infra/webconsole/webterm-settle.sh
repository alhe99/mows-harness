#!/usr/bin/env bash
# webterm-settle.sh — the delayed payload of tmux's client-attached / client-resized hooks
# (set in infra/os/tmux.conf; invoked ~2s after the event so the reattach storm settles).
#
#   attached: repaint the client AND force the pane app through a real size change — shrink
#             the window one row, then unset window-size, which restores client-tracking and
#             snaps the dims back. Two genuine SIGWINCHes = a full TUI re-layout, i.e. what a
#             tap on the phone screen did by opening the keyboard. Wiggling ONLY on attach is
#             deliberate: doing it on every client-resized (keyboard open/close fires one each
#             time) made Claude-style TUIs orphan a frame per wiggle — a trail of input-box
#             borders tiling the screen (seen live 2026-08-23 01:43).
#   resized:  repaint the client only. The resize itself already SIGWINCHed the app.
#
# Every run appends ground truth to ~/.cache/webterm-hook.log — timestamp, event, client,
# size, and the last lines of the pane AS TMUX SEES THEM. Next time the phone shows garbage,
# that log says whether tmux's model held garbage (app/model layer) or clean content (client/
# render layer) at that exact moment, ending the screenshot-forensics loop.
# ponytail: 200KB self-truncating log, no rotation machinery.
set -u
kind=${1-?} client=${2-} sess=${3-} size=${4-}
L=~/.cache/webterm-hook.log
[ -f "$L" ] && [ "$(stat -c%s "$L" 2>/dev/null || echo 0)" -gt 200000 ] && : > "$L"
printf '%s %s client=%s sess=%s %s\n' "$(date '+%F %T')" "$kind" "$client" "$sess" "$size" >> "$L"
tmux refresh-client -t "$client" 2>>"$L" || true
if [ "$kind" = attached ]; then
  tmux resize-window -t "$sess" -U 1 2>>"$L" || true
  sleep 0.5
  tmux set -w -t "$sess" -u window-size 2>>"$L" || true
fi
sleep 0.3
tmux capture-pane -p -t "$sess" 2>>"$L" | tail -4 | sed 's/^/  cap| /' >> "$L" || true
