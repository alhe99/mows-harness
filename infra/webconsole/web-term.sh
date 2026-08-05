#!/usr/bin/env bash
# ponytail: web-terminal session picker for the Claude dashboard (/term).
# Spawned by ttyd per browser connection, runs as the harness account. Start new Claude
# Code sessions or continue existing ones; claude always runs inside tmux (same
# convention as fleet/bin/cc) so closing the browser tab never kills work — reopen /term
# and attach again.
# Self-check: /opt/claude-dashboard/web-term.sh list
#
# Delta vs. the live reference script (full reconciliation in
# .superpowers/sdd/task-12-report.md): live hardcoded exactly 2 accounts (single-letter
# codes, both fixed under one specific /home/<user>) via two literal config-dir
# variables and a single-letter-code branch at every call site. This version discovers
# profiles dynamically — profiles()/cfg_for() below are BYTE-IDENTICAL to
# watchdogs/bin/claude-health's copy (same contract: `default` + every
# `~/.claude-<suffix>` dir) — so it works unmodified for any number of profiles,
# including exactly one.
#
# Session naming changed too: live named its own tmux sessions "web-<sid8>" (an 8-hex
# Claude session-id prefix), which never matched fleet/bin/reap-idle-claude's `^cc-` reap
# pattern — an abandoned web-terminal tmux session could never be idle-reaped, unlike a
# CLI-launched one. This version names its sessions "cc-<profile>-<slug-of-dir>", the
# exact convention fleet/bin/cc uses (see that script's own header comment: "the naming
# here is the contract [reap-idle-claude] depends on — do not change the
# cc-<profile>-<slug> shape"). Same inherited caveat as cc's own header: a profile name
# containing '-' can alias with a directory slug in the combined session name.
# Bonus effect, not just parity: opening /term for a project that already has a live CLI
# `cc` session on the same profile+directory now attaches to that SAME tmux session
# instead of spawning a second, competing one — `tmux new-session -AD` already does the
# right thing given a matching name.
#
# "new session" (do_new, below) now calls `cc <profile> <dir>` directly. fleet/bin/cc
# unifies what live split across two hardcoded-account binaries into one
# profile-parameterized launcher (Task 7). `cc` decides for itself whether to wrap in
# tmux — only when stdin is a tty and it isn't already inside one (see cc's own header) —
# and ttyd always hands its child a real pty, so that branch always fires here; the
# direct-exec fallback path is never taken from this script.
set -euo pipefail
export PATH="$HOME/.local/bin:/usr/local/bin:/usr/bin:/bin"
export LANG=C.UTF-8
cd "$HOME" || exit 1

CLAUDE=claude
PROJECTS_ROOT="${PROJECTS_ROOT:-$HOME/Projects}"

profiles() {            # prints: default + every suffix of ~/.claude-<suffix>
  echo default
  for d in "$HOME"/.claude-*; do [ -d "$d" ] && basename "$d" | sed 's/^\.claude-//'; done
}
cfg_for() { [ "$1" = default ] && echo "$HOME/.claude" || echo "$HOME/.claude-$1"; }
is_profile() { case " $(profiles | tr '\n' ' ') " in *" $1 "*) return 0 ;; *) return 1 ;; esac; }
slug() { basename "$1" | tr '[:upper:]' '[:lower:]' | tr -c 'a-z0-9\n' '-' | sed 's/^-*//;s/-*$//'; }

# sticky re-attach: remember the last tmux session this picker attached, so a
# reconnect (PWA backgrounded -> WS died -> fresh picker) can jump straight back
# instead of dumping the user on the menu. Auto-attach only if it's detached
# (never silently steals from another live device); menu Enter re-attaches always.
LAST="$HOME/.cache/webterm-last"
mark() { mkdir -p "${LAST%/*}"; printf '%s\n' "$1" >"$LAST"; }
lastn() { cat "$LAST" 2>/dev/null || true; }   # missing file is the normal first-ever-run case, not an error

# newest sessions across every profile: "mtime<TAB>profile<TAB>sid<TAB>cwd"
# ponytail: fully capture find|sort, cap inside the loop — a trailing head on the
# pipeline SIGPIPEs sort/printf and sprays "Broken pipe" into the terminal.
# Every per-profile pipeline below ends in `|| true`: under set -e -o pipefail, a
# profile with an empty/not-yet-created projects dir (find exits 1 on a missing start
# path even with 2>/dev/null) would otherwise abort the whole script the first time any
# profile has never run claude — that's the normal, expected state for a fresh profile,
# not a real error.
recent() {
  local all ts p f sid cwd n=0
  all=$(
    for p in $(profiles); do
      find "$(cfg_for "$p")/projects" -maxdepth 2 -name '*.jsonl' -not -path '*-observer-sessions/*' -printf '%T@\t%p\n' 2>/dev/null | sed "s/\t/\t$p\t/" || true
    done | sort -rn
  )
  while IFS=$'\t' read -r ts p f; do
    [ "$n" -ge 12 ] && break
    sid=$(basename "$f" .jsonl)
    # FIRST cwd = session start dir = project dir it resumes from (see resolve())
    cwd=$(grep -o -m1 '"cwd":"[^"]*"' "$f" 2>/dev/null | cut -d'"' -f4) || true
    [ -n "$cwd" ] || continue
    printf '%s\t%s\t%s\t%s\n' "${ts%.*}" "$p" "$sid" "$cwd"
    n=$((n + 1))
  done <<<"$all"
}

resolve() { # sid-prefix -> "profile<TAB>cwd<TAB>fullsid" (newest match; 8 hex chars ~never collide)
  local f p path sid cwd
  f=$(
    for p in $(profiles); do
      ls -t "$(cfg_for "$p")"/projects/*/"$1"*.jsonl 2>/dev/null | sed "s|^|$p\t|" || true
    done | head -1
  )
  [ -n "$f" ] || return 1
  p="${f%%$'\t'*}"; path="${f#*$'\t'}"
  sid=$(basename "$path" .jsonl)
  # FIRST cwd = where the session started = the project dir it lives in. `claude
  # --resume` locates a session by $PWD's project hash, so we must launch from the
  # start dir, NOT wherever the session later cd'd to (that fails "No conversation
  # found").
  cwd=$(grep -o -m1 '"cwd":"[^"]*"' "$path" 2>/dev/null | cut -d'"' -f4) || true
  printf '%s\t%s\t%s\n' "$p" "${cwd:-$HOME}" "$sid"
}

do_resume() { # profile cwd sid — own tmux name so it never hijacks an unrelated session
  local cfg n
  cfg=$(cfg_for "$1")
  n="cc-$1-$(slug "$2")"
  # already live -> ATTACH. A second `claude --resume` of the same session steals
  # it and kills the first one's in-flight work.
  mark "$n"
  if tmux has-session -t "=$n" 2>/dev/null; then
    tmux attach -d -t "=$n" || true
    return
  fi
  (
    cd "$2" 2>/dev/null || cd "$HOME"
    # window runs our `run` wrapper: if claude dies (phone/claude.ai takeover, OOM
    # kill, crash) the pane stays up with an explanation + one-key take-back
    # instead of dropping the user to the picker.
    tmux new-session -AD -s "$n" "$(printf '%q ' "$0" run "$1" "$2" "$3")"
  ) || true
}

run_session() { # profile cwd sid — in-pane runner, lives INSIDE the tmux window
  local cfg rc a
  cfg=$(cfg_for "$1")
  cd "$2" 2>/dev/null || cd "$HOME"
  local mcp=(); [ -f "$cfg/mcp-interactive.json" ] && mcp=(--strict-mcp-config --mcp-config "$cfg/mcp-interactive.json")
  while :; do
    env CLAUDE_CONFIG_DIR="$cfg" "$CLAUDE" "${mcp[@]}" --resume "$3" && rc=0 || rc=$?
    [ "$rc" -eq 0 ] && exit 0   # normal /exit — close the window
    printf '\n\033[1;33m ⚠ session %s ended unexpectedly (exit %s) at %s\033[0m\n' "${3:0:8}" "$rc" "$(date '+%H:%M:%S')"
    printf ' likely: taken over by another device (phone / claude.ai) or killed by the system.\n'
    printf ' nothing is lost — the transcript is on disk.\n'
    read -rp ' [r] resume here again (takes the session back) · anything else closes: ' a || exit 0
    [ "$a" = r ] || exit 0
  done
}

do_new() {
  local p d w
  read -rp " profile ($(profiles | tr '\n' ' ')) (default: default): " p || return; p=${p:-default}
  is_profile "$p" || { echo " unknown profile '$p'"; sleep 2; return; }
  read -rp " directory (abs path, or name under $PROJECTS_ROOT; empty = ~): " d || return
  case "$d" in
    "") d="$HOME" ;;
    /*) ;;
    *) d="$PROJECTS_ROOT/$d" ;;
  esac
  if [ ! -d "$d" ]; then
    read -rp " $d does not exist — create it? [y/N] " w || return
    [ "$w" = y ] || return
    mkdir -p "$d" || return
  fi
  # cc wraps itself in tmux (cc-<profile>-<slug>) and reattaches if already running —
  # ttyd always hands us a pty, so that branch always fires (see header comment).
  cc "$p" "$d" || echo " cc exited nonzero — check the profile/directory and try again"
}

menu() {
  echo
  printf '\033[1;32m Claude Code — %s\033[0m  (tmux everywhere: Ctrl+b d detaches, tab close is safe)\n' "$(hostname)"
  echo " ─────────────────────────────────────────────────────────────"
  local live=() rec=() i ts p sid cwd tag
  mapfile -t live < <(tmux ls -F $'#{session_name}\t#{session_windows}w #{?session_attached,attached,detached}' 2>/dev/null)
  if [ ${#live[@]} -gt 0 ]; then
    echo " LIVE terminals (attach):"
    for i in "${!live[@]}"; do printf '   [a%d] %s\n' "$i" "$(echo "${live[$i]}" | tr '\t' ' ')"; done
  fi
  mapfile -t rec < <(recent)
  if [ ${#rec[@]} -gt 0 ]; then
    echo " RECENT Claude sessions (resume):"
    for i in "${!rec[@]}"; do
      IFS=$'\t' read -r ts p sid cwd <<<"${rec[$i]}"
      tag=""; tmux has-session -t "=cc-$p-$(slug "$cwd")" 2>/dev/null && tag="  <- LIVE, re-attaches"
      printf '   [%2d] %s %-10s %-30s %s%s\n' "$i" "$(date -d "@$ts" '+%b%d %H:%M')" "$p" "$(basename "$cwd")" "${sid:0:8}" "$tag"
    done
  fi
  local ln; ln=$(lastn)
  if [ -n "$ln" ] && tmux has-session -t "=$ln" 2>/dev/null; then
    printf '   [Enter] re-attach %s    [n] new    [s] shell    [q] quit\n' "$ln"
  else
    echo "   [n] new session    [s] plain shell    [q] quit"
  fi
  read -rp " > " ch || exit 0
  case "$ch" in
    "") [ -n "$ln" ] && tmux has-session -t "=$ln" 2>/dev/null && { mark "$ln"; tmux attach -d -t "=$ln"; } || true ;;
    a[0-9]|a[0-9][0-9]) i=${ch#a}; [ -n "${live[$i]:-}" ] && { mark "${live[$i]%%$'\t'*}"; tmux attach -d -t "${live[$i]%%$'\t'*}"; } || true ;;
    [0-9]|[0-9][0-9]) [ -n "${rec[$ch]:-}" ] && { IFS=$'\t' read -r ts p sid cwd <<<"${rec[$ch]}"; do_resume "$p" "$cwd" "$sid"; } ;;
    n) do_new ;;
    s) bash -l ;;
    q) exit 0 ;;
  esac
}

# deep links via ttyd --url-arg (/term/?arg=attach&arg=<tmux-name> etc.) + self-check
case "${1-}" in
  run) run_session "${2-default}" "${3-$HOME}" "${4-}"; exit 0 ;;
  list) recent | while IFS=$'\t' read -r ts p sid cwd; do printf '%s %s %s %s\n' "$(date -d "@$ts" '+%F %H:%M')" "$p" "${sid:0:8}" "$cwd"; done; exit 0 ;;
  attach) [ -n "${2-}" ] && mark "$2"; tmux attach -d -t "${2-}" 2>/dev/null || true ;;
  resume) [ -n "${4-}" ] && do_resume "${2-default}" "${3-$HOME}" "${4}" ;;
  resolve) resolve "${2-}"; exit $? ;;
  open) # dashboard deep link: /term/?arg=open&arg=<sid8>
    if r=$(resolve "${2-}"); then
      IFS=$'\t' read -r p cwd sid <<<"$r"
      do_resume "$p" "$cwd" "$sid"
    else
      printf ' no session matches "%s"\n' "${2-}"; sleep 2
    fi ;;
esac

# fresh interactive connection: if the last session is alive and detached
# (typical after a PWA background/reconnect), jump straight back in.
if [ -z "${1-}" ]; then
  _n=$(lastn)
  if [ -n "$_n" ] && tmux has-session -t "=$_n" 2>/dev/null; then
    _att=$(tmux display -p -t "$_n" '#{session_attached}' 2>/dev/null) || true
    if [ "${_att:-0}" = "0" ]; then
      printf '\n \033[1;32m↩ re-attaching %s\033[0m — press any key for the menu… ' "$_n"
      if ! read -t 2 -n 1 -s -r; then echo; tmux attach -d -t "=$_n" || true; else echo; fi
    fi
  fi
fi
while true; do menu; done
