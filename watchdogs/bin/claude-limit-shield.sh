#!/usr/bin/env bash
# claude-limit-shield — auto-continue Claude Code tmux sessions after a usage-limit reset.
#
# Problem: when a session hits the usage/session limit, Claude Code prints
#   "You've hit your session limit · resets 2:40am (UTC)"
# and then sits idle FOREVER after the reset, until a human types something.
# This watchdog (cron, every 5 min, runs as your own user) scans the panes of your
# tmux server; a pane counts as BLOCKED only if:
#   1. a limit banner starts a line in the bottom 18 lines of the visible screen, and
#   2. the screen is unchanged since the previous scan (idle, not actively working).
# Once the parsed reset time has passed, it types a continue-nudge into that pane.
#
# Screen-grep heuristic, no TUI introspection — replace if Claude Code ever ships a native
# "limit cleared" hook. Known ceilings: a conversation that PRINTS a banner-quoting line at
# line-start near the bottom and then idles can still draw one spurious nudge; a banner first
# seen only after its reset passed resumes via the 6h no-date override instead of instantly.
set -euo pipefail
export LC_ALL=C.UTF-8

STATE="${SHIELD_STATE:-$HOME/.local/state/claude-limit-shield}"
ONLY_SESSION="${SHIELD_ONLY_SESSION:-}"   # selftest: restrict scan to one tmux session
MSG="The usage limit has reset — continue exactly where you left off and resume any interrupted or pending work (including background workflows) without asking."
MIN_GAP=1800        # never re-ping the same stuck banner within 30 min
FALLBACK_GAP=2700   # reset time unparseable: ping every 45 min instead

mkdir -p "$STATE"
find "$STATE" -type f -mtime +8 -delete 2>/dev/null || true

log() { logger -t claude-limit-shield -- "$*" 2>/dev/null || true; echo "$(date -Is) $*" >> "$STATE/shield.log"; }

# real banner rendering starts its line after box-drawing glyphs / NBSP / whitespace
# (observed: "⎿ \xc2\xa0You've hit your session limit · resets 9:20pm (UTC)") — so allow
# ANY non-alphanumeric prefix; quoted banners inside prose sit after words and don't match
BANNER_RE="^[^a-zA-Z0-9]*((you've|you have) )?(hit|reached) your [a-z0-9 -]*limit|^[^a-zA-Z0-9]*(claude )?usage limit reached|^[^a-zA-Z0-9]*your limit will reset"

scan_server() { # <sock>
  local sock=$1 now pane sess screen bottom line scr hash key first last prev spec reset due entry panes
  panes=()
  mapfile -t panes < <(tmux -S "$sock" list-panes -a -F '#{pane_id} #{session_name}' 2>/dev/null)
  for entry in "${panes[@]}"; do
    [ -n "$entry" ] || continue
    pane=${entry%% *}; sess=${entry#* }
    [ -n "$ONLY_SESSION" ] && [ "$sess" != "$ONLY_SESSION" ] && continue
    now=$(date +%s)
    screen=$(tmux -S "$sock" capture-pane -p -t "$pane" 2>/dev/null) || continue
    # bottom of the pane's content = status area just above the input box
    bottom=$(awk 'NF{p=NR} {l[NR]=$0} END{for(i=(p>18?p-17:1);i<=p;i++)print l[i]}' <<<"$screen")
    line=$(grep -iE "$BANNER_RE" <<<"$bottom" | tail -1 || true)
    [ -n "$line" ] || continue

    # stability hash must ignore Claude's ticking status lines ("✻ Sautéed for 15h 9m 59s",
    # token counters) — a limit-blocked TUI keeps repainting those every second
    scr=$(grep -vE '[0-9]+h [0-9]+m|[0-9]+m [0-9]+s|for [0-9]+s\b|esc to interrupt|tokens' <<<"$screen" | md5sum | cut -c1-16 || true)
    hash=$(md5sum <<<"$sock $sess $pane $line" | cut -c1-16 || true)
    key="$STATE/$hash"
    first=$now last=0 prev=""
    if [ -f "$key" ]; then read -r first last prev < "$key" || true; fi
    if [ "$prev" != "$scr" ]; then
      # screen still changing → session active (or just became idle); wait a scan
      echo "$first $last $scr" > "$key"
      continue
    fi

    # extract "resets 2:40am (UTC)" / "reset at 4am" / "resets Jul 31 at 9am (UTC)"
    spec=$(grep -oiE "resets? (at )?[^·∙│|]*" <<<"$bottom" | tail -1 | \
           sed -E 's/^[Rr]esets? *(at )?//; s/[()]//g; s/ at / /; s/ *$//' || true)
    reset=""
    [ -n "$spec" ] && reset=$(date -d "$spec" +%s 2>/dev/null || true)

    due=0
    if [ -n "$reset" ]; then
      # time-of-day behind first-sighting usually means the NEXT day ("resets 2:40am" seen
      # at 11pm) — but only if that reading is ≤12h out; limits reset within hours, so a
      # farther "tomorrow" means the banner predates us and the reset already passed
      if [ "$reset" -lt $((first - 300)) ] && [ $((reset + 86400 - now)) -le 43200 ]; then
        reset=$((reset + 86400))
      fi
      [ "$now" -ge "$reset" ] && due=1
      # stuck >6h on a dateless spec → day-bump was probably wrong, go anyway
      if [ $((now - first)) -gt 21600 ] && \
         ! grep -qiE 'jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec|mon|tue|wed|thu|fri|sat|sun' <<<"$spec"; then
        due=1
      fi
    else
      [ $(( now - (last > first ? last : first) )) -ge "$FALLBACK_GAP" ] && due=1
    fi

    [ "$due" = 1 ] || continue
    [ $((now - last)) -lt "$MIN_GAP" ] && continue

    tmux -S "$sock" send-keys -t "$pane" -l "$MSG" 2>/dev/null || continue
    sleep 0.4
    tmux -S "$sock" send-keys -t "$pane" Enter 2>/dev/null || true
    echo "$first $now $scr" > "$key"
    log "pinged $sess $pane (banner: $(sed 's/^[[:space:]]*//' <<<"$line" | cut -c1-90))"
  done
}

selftest() { # throwaway tmux session with a fake overdue banner must receive the nudge
  local T=shieldtest$$ out=/tmp/claude-limit-shield.selftest.$$ f
  export SHIELD_STATE=$(mktemp -d) SHIELD_ONLY_SESSION=$T
  STATE=$SHIELD_STATE ONLY_SESSION=$T
  trap "tmux kill-session -t '$T' 2>/dev/null; rm -rf '$out' '$SHIELD_STATE'" EXIT
  tmux new-session -d -s "$T" \
    "printf '%s\n' \"You've hit your session limit · resets 12:01am (UTC)\"; exec cat > $out"
  sleep 1
  main; main                             # pass 1 records screen; pass 2 sees it stable
  f=$(find "$STATE" -type f ! -name shield.log ! -name '.last-run' | head -1)
  [ -n "$f" ] || { echo "SELFTEST FAIL: banner not detected"; exit 1; }
  read -r _ _ scr < "$f" || true; echo "86400 0 $scr" > "$f"   # backdate first_seen → due now
  main
  sleep 1
  grep -q "usage limit has reset" "$out" && echo "SELFTEST OK: nudge delivered" || { echo "SELFTEST FAIL: no nudge in pane"; exit 1; }
}

main() {
  local sock
  for sock in "/tmp/tmux-$(id -u)"/*; do
    [ -S "$sock" ] || continue
    scan_server "$sock"
  done
  touch "$STATE/.last-run"   # heartbeat: proves the cron entry actually executes
}

case "${1-}" in
  selftest) selftest ;;
  *) main ;;
esac
