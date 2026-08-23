#!/usr/bin/env bash
# webterm-settle.sh — the delayed payload of tmux's client-attached / client-resized hooks
# (set in infra/os/tmux.conf; invoked ~2s after the event so the reattach storm settles).
#
#   Repaints the client from tmux's model after the event settles. The size wiggle this
#   script once did is gone: the real bug was client-side (xterm's parser/resize race killing
#   its write loop — see blocks/80-ccpaint.html), refresh-client works fine once that loop is
#   alive, and the wiggle's extra SIGWINCHes only fed the very churn that triggered the race.
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
sleep 0.3
tmux capture-pane -p -t "$sess" 2>>"$L" | tail -4 | sed 's/^/  cap| /' >> "$L" || true
