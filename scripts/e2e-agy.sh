#!/usr/bin/env bash
# e2e-agy — hermetic ALL-scenario matrix for the agy delegation layer.
#
# Everything runs against stubs in a throwaway HOME on a PRIVATE tmux socket:
# no network, no real agy/claude, no touch of the real ~/.local/state or the
# default tmux server (unset TMUX + `tmux -L` shim; kill-server is allowed
# ONLY on the private socket). Safe on a live box; also invoked inside
# scripts/e2e-container.sh.
#
#   bash scripts/e2e-agy.sh                        # test the repo copies (agy/bin)
#   BIN_DIR=~/.local/bin bash scripts/e2e-agy.sh   # test installed copies
set -u
cd "$(dirname "$0")/.."
REPO=$PWD
BIN_DIR=${BIN_DIR:-$REPO/agy/bin}
REAP=${REAP:-$REPO/watchdogs/bin/reap-idle-claude}

PASS=0; FAIL=0
ok(){ echo "PASS: $*"; PASS=$((PASS+1)); }
no(){ echo "FAIL: $*"; FAIL=$((FAIL+1)); }
chk(){ if eval "$2" >/dev/null 2>&1; then ok "$1"; else no "$1"; fi; }

# ---------- isolated world ----------
REAL_TMUX=$(command -v tmux) || { echo "tmux required"; exit 1; }
T=$(mktemp -d)
SOCK="e2eagy-$$"
cleanup(){ "$REAL_TMUX" -L "$SOCK" kill-server 2>/dev/null; rm -rf "$T"; }
trap cleanup EXIT
unset TMUX   # never nest into, or act on, a real server

export HOME="$T/home"
mkdir -p "$HOME/.local/state" "$T/shim"

# tmux shim -> private socket (the shipped scripts call bare `tmux`)
printf '#!/bin/sh\nexec %s -L %s "$@"\n' "$REAL_TMUX" "$SOCK" > "$T/shim/tmux"

export ARGV_LOG="$T/argv.log"

# argv-recording stub agy
cat > "$T/shim/agy" <<'EOS'
#!/usr/bin/env bash
{ echo "AGY-CALL"; printf '%s\n' "$@"; } >> "${ARGV_LOG:-/dev/null}"
[ $# -eq 0 ] && exec sleep 300   # interactive launch (ag test): stay alive
echo '{"status":"SUCCESS","response":"r"}'
EOS
chmod +x "$T/shim/"*
export PATH="$T/shim:$BIN_DIR:$PATH"
export AGY_BIN="$T/shim/agy"

quota_cache(){ # quota_cache <personal_pct|null> <work_pct|null>  (fresh mtime = trusted, no network)
  jq -n --argjson p "$1" --argjson w "$2" \
    '{personal:{five_hour_pct:$p,weekly_pct:10,five_hour_resets_at:"x",weekly_resets_at:"x",source:(if $p==null then "unknown" else "api" end)},
      work:{five_hour_pct:$w,weekly_pct:10,five_hour_resets_at:"x",weekly_resets_at:"x",source:(if $w==null then "unknown" else "api" end)}}' \
    > "$HOME/.local/state/claude-quota.json"
}

echo "### selftests"
chk "claude-quota --selftest" "claude-quota --selftest"
chk "agy-run --selftest"      "agy-run --selftest"

echo "### claude-quota semantics (seeded caches)"
quota_cache 10 80
chk "check personal under -> 0"  "claude-quota --check personal"
chk "check work over -> 1"       "rc=0; claude-quota --check work || rc=\$?; [ \$rc -eq 1 ]"
quota_cache null null
chk "check unknown -> 2"         "rc=0; claude-quota --check personal || rc=\$?; [ \$rc -eq 2 ]"

echo "### reaper: idle agy- reaped (private socket)"
tmux new-session -d -s agy-reaptest 'sleep 300'
tmux new-session -d -s other-reaptest 'sleep 300'
sleep 2
IDLE=1 "$REAP" >/dev/null 2>&1
chk "idle agy- reaped"                "! tmux has-session -t '=agy-reaptest'"
chk "unrelated session spared"        "tmux has-session -t '=other-reaptest'"
tmux kill-session -t '=other-reaptest' 2>/dev/null

echo "### ag launcher (pty on the private socket)"
export TERM=${TERM:-xterm-256color}
mkdir -p "$T/projx"
printf '\n' | timeout 8 script -qec "ag $T/projx" /dev/null >/dev/null 2>&1; sleep 1
chk "ag created agy-projx"            "tmux has-session -t '=agy-projx'"
printf 'q\n' | timeout 8 script -qec "ag $T/projx" /dev/null 2>/dev/null | grep -q "already running" && ok "dup session prompts" || no "dup session prompts"
printf 'n\n' | timeout 8 script -qec "ag $T/projx" /dev/null >/dev/null 2>&1; sleep 1
chk "answer n -> agy-projx-2"         "tmux has-session -t '=agy-projx-2'"

echo "### agy-notify (webhook notifier)"
mkdir -p "$T/curlrec"
printf '#!/bin/sh\necho "$@" >> "$CURL_LOG"\nexit 0\n' > "$T/curlrec/curl"
chmod +x "$T/curlrec/curl"
export CURL_LOG="$T/curl.log"
chk "notify: no-op when webhook unset" "PATH=\"$T/curlrec:\$PATH\" agy-notify 'hello' && [ ! -s '$CURL_LOG' ]"
chk "notify: posts when webhook set" "PATH=\"$T/curlrec:\$PATH\" AGY_DISCORD_WEBHOOK=https://discord.test/hook agy-notify 'gate says hi' && grep -q 'gate says hi' '$CURL_LOG' && grep -q 'discord.test/hook' '$CURL_LOG'"
chk "notify: empty message is a no-op" ": > '$CURL_LOG'; PATH=\"$T/curlrec:\$PATH\" AGY_DISCORD_WEBHOOK=https://discord.test/hook agy-notify '' && [ ! -s '$CURL_LOG' ]"

echo
echo "=============================="
echo "RESULT: $PASS passed, $FAIL failed"
echo "=============================="
[ "$FAIL" -eq 0 ]
