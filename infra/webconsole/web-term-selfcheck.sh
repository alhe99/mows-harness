#!/usr/bin/env bash
# ponytail: self-check for web-term.sh's `switch` subcommand (design doc §6, §2). Creates
# two throwaway tmux sessions named wt-selfcheck-* (never web-*/cc-* — the user's real
# sessions are never touched), attaches a REAL tmux client to one via `script` (a pty, so
# tmux sees a genuine client_tty — a scripted `tmux attach &` with no pty would not),
# registers that client's tty under a test tabid the same way web-term.sh's own
# attach/open would, then exercises `switch` end-to-end plus its two failure exits.
# Always cleans up (trap), safe to re-run on this box.
set -uo pipefail   # not -e: the assertions below check exit codes themselves
export LANG=C.UTF-8

SELF_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
WT="$SELF_DIR/web-term.sh"
CLIENTS_DIR="$HOME/.cache/webterm-clients"
TAB=deadbeef
SESS_A=wt-selfcheck-a
SESS_B=wt-selfcheck-b
CLIENT_PID=""
fail=0

cleanup() {
  [ -n "$CLIENT_PID" ] && kill "$CLIENT_PID" 2>/dev/null
  tmux kill-session -t "=$SESS_A" 2>/dev/null
  tmux kill-session -t "=$SESS_B" 2>/dev/null
  rm -f "$CLIENTS_DIR/$TAB"
}
trap cleanup EXIT

ok()  { printf 'ok   - %s\n' "$1"; }
bad() { printf 'FAIL - %s\n' "$1"; fail=1; }

# pre-clean: a previous run that died mid-way can leave these behind
tmux kill-session -t "=$SESS_A" 2>/dev/null || true
tmux kill-session -t "=$SESS_B" 2>/dev/null || true
rm -f "$CLIENTS_DIR/$TAB"

tmux new-session -d -s "$SESS_A" "sleep 600" || { bad "create $SESS_A"; exit 1; }
tmux new-session -d -s "$SESS_B" "sleep 600" || { bad "create $SESS_B"; exit 1; }
ok "created $SESS_A and $SESS_B"

# a real pty client, the way ttyd hands web-term.sh one — `tmux attach &` with no pty
# would leave client_tty empty and switch-client would have nothing to repoint.
script -qfc "tmux attach -t =$SESS_A" /dev/null &
CLIENT_PID=$!

tty=""
for _ in $(seq 1 50); do
  tty=$(tmux list-clients -F '#{client_tty} #{client_session}' 2>/dev/null | awk -v s="$SESS_A" '$2==s{print $1}')
  [ -n "$tty" ] && break
  sleep 0.1
done
if [ -z "$tty" ]; then bad "no client attached to $SESS_A within 5s"; exit 1; fi
ok "client attached to $SESS_A on $tty"

mkdir -p "$CLIENTS_DIR"
printf '%s' "$tty" >"$CLIENTS_DIR/$TAB"

out=$("$WT" switch "$TAB" "$SESS_B"); rc=$?
if [ "$rc" -eq 0 ] && [ "$out" = "$SESS_B" ]; then
  ok "switch $TAB $SESS_B -> exit 0, printed '$out'"
else
  bad "switch $TAB $SESS_B -> exit $rc, printed '$out' (want exit 0, '$SESS_B')"
fi

now=$(tmux list-clients -F '#{client_tty} #{client_session}' 2>/dev/null | awk -v t="$tty" '$1==t{print $2}')
if [ "$now" = "$SESS_B" ]; then
  ok "list-clients shows $tty attached to $SESS_B"
else
  bad "list-clients shows '$now' for $tty (want $SESS_B)"
fi

"$WT" switch ffffffff "$SESS_B" >/dev/null 2>&1; rc=$?
if [ "$rc" -eq 2 ]; then ok "unknown tabid -> exit 2"; else bad "unknown tabid -> exit $rc (want 2)"; fi

"$WT" switch "$TAB" zzz-not-a-session >/dev/null 2>&1; rc=$?
if [ "$rc" -eq 3 ]; then ok "unresolvable target -> exit 3"; else bad "unresolvable target -> exit $rc (want 3)"; fi

if [ "$fail" -eq 0 ]; then echo "ALL CLEAN"; exit 0; else echo "FAILURES ABOVE"; exit 1; fi
