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
STATE="$HOME/.local/state/agy-handoffs"
git config --global user.email t@t
git config --global user.name t
git config --global init.defaultBranch main

# tmux shim -> private socket (the shipped scripts call bare `tmux`)
printf '#!/bin/sh\nexec %s -L %s "$@"\n' "$REAL_TMUX" "$SOCK" > "$T/shim/tmux"

# stub behavior is FILE-driven (env vars don't reach processes spawned via the
# tmux server, whose environment is frozen at server start)
export STUB_MODE_FILE="$T/stub-mode"       # work|conflict|nocommit|autherr|sleep
export STUB_REVIEW_FILE="$T/stub-review"   # approve|reject
export CLAUDE_MODE_FILE="$T/claude-mode"   # approve|tricky|prose|hang
export ARGV_LOG="$T/argv.log"
stubmode(){ echo "$1" > "$STUB_MODE_FILE"; }
reviewmode(){ echo "$1" > "$STUB_REVIEW_FILE"; }
claudemode(){ echo "$1" > "$CLAUDE_MODE_FILE"; }
stubmode work; reviewmode approve; claudemode approve

# argv-recording stub agy
cat > "$T/shim/agy" <<'EOS'
#!/usr/bin/env bash
{ echo "AGY-CALL"; printf '%s\n' "$@"; } >> "${ARGV_LOG:-/dev/null}"
[ $# -eq 0 ] && exec sleep 300   # interactive launch (ag test): stay alive
mode=$(cat "${STUB_MODE_FILE:-/nonexistent}" 2>/dev/null || echo work)
review_envelope(){
  if [ "$(cat "${STUB_REVIEW_FILE:-/nonexistent}" 2>/dev/null || echo approve)" = reject ]; then
    echo '{"status":"SUCCESS","response":"r","structured_output":{"approve":false,"reason":"bad"}}'
  else
    echo '{"status":"SUCCESS","response":"r","structured_output":{"approve":true,"reason":"ok"}}'
  fi
}
if [ "${1:-}" = "-p" ]; then case "$2" in
  *"Review this diff"*)  # gate review prompt embeds the contract, which may
    review_envelope;;    # itself contain the word "handoff" — match FIRST
  *"handoff"*)
    case "$mode" in
      work)     echo "made by stub" > "stub-$$-$RANDOM.txt"; git add -A; git commit -qm "stub work";;
      conflict) echo "AGY" > topic.txt; git add -A; git commit -qm "stub conflict work"
                echo "MAIN" > "$CONFLICT_REPO/topic.txt"
                git -C "$CONFLICT_REPO" commit -qam "conflicting main edit";;
      nocommit) : ;;
      autherr)  echo "please sign in to continue" >&2; exit 1;;
      sleep)    sleep 300;;
    esac
    echo '{"conversation_id":"c-stub-1","status":"SUCCESS"}';;
  *) review_envelope;;
esac; fi
EOS

# verdict stub claude
cat > "$T/shim/claude" <<'EOS'
#!/usr/bin/env bash
echo "CLAUDE-CALL" >> "${ARGV_LOG:-/dev/null}"
case "$(cat "${CLAUDE_MODE_FILE:-/nonexistent}" 2>/dev/null || echo approve)" in
  approve) echo "Looks correct."; echo "APPROVE";;
  tricky)  echo "I cannot APPROVE this as-is; the criteria are unmet."; echo "REJECT: bad";;
  prose)   echo "Interesting diff, hard to say.";;
  hang)    sleep 10;;
esac
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
new_repo(){ local d="$T/$1"; rm -rf "$d"; git init -q "$d" >/dev/null; git -C "$d" commit -qm init --allow-empty; echo "$d"; }
hstatus(){ jq -r .status "$STATE/$1/meta.json"; }
hreason(){ jq -r '.reason // ""' "$STATE/$1/meta.json"; }

echo "### selftests"
chk "claude-quota --selftest" "claude-quota --selftest"
chk "agy-run --selftest"      "agy-run --selftest"

echo "### claude-quota semantics (seeded caches)"
quota_cache 10 80
chk "check personal under -> 0"  "claude-quota --check personal"
chk "check work over -> 1"       "rc=0; claude-quota --check work || rc=\$?; [ \$rc -eq 1 ]"
chk "reviewer picks personal"    "[ \"\$(claude-quota --reviewer)\" = personal ]"
quota_cache null null
chk "check unknown -> 2"         "rc=0; claude-quota --check personal || rc=\$?; [ \$rc -eq 2 ]"
chk "reviewer none -> exit 1"    "rc=0; claude-quota --reviewer || rc=\$?; [ \$rc -eq 1 ]"

echo "### handoff refusals"
R=$(new_repo r-refuse)
chk "no-verify prompt -> 64"     "rc=0; agy-handoff start --repo $R 'x' 2>/dev/null || rc=\$?; [ \$rc -eq 64 ]"
chk "refusal leaves no state"    "[ -z \"\$(ls $STATE 2>/dev/null)\" ]"
printf '# H\n## Task\nx\n' > "$T/noverify.md"
chk "task file w/o fence -> 64"  "rc=0; agy-handoff start --repo $R --task $T/noverify.md 2>/dev/null || rc=\$?; [ \$rc -eq 64 ]"

echo "### small green -> merged"
R=$(new_repo r-green)
id=$(agy-handoff start --repo "$R" --foreground --verify "ls stub-*.txt" "handoff: make a file" 2>/dev/null)
chk "status merged"              "[ \"\$(hstatus $id)\" = merged ]"
chk "merge commit on main"       "git -C $R log --oneline | grep -q 'agy handoff'"
chk "worktree cleaned up"        "[ ! -d $STATE/$id/wt ]"
chk "branch deleted"             "! git -C $R rev-parse -q --verify agy/$id"
chk "events.log MERGED"          "grep -q \"$id: MERGED\" $STATE/events.log"
chk "conversation_id captured"   "[ \"\$(jq -r .conversation_id $STATE/$id/meta.json)\" = c-stub-1 ]"

echo "### verify-fail -> parked"
R=$(new_repo r-red)
id=$(agy-handoff start --repo "$R" --foreground --verify "test -f nope.txt" "handoff: irrelevant" 2>/dev/null)
chk "status parked"              "[ \"\$(hstatus $id)\" = parked ]"
chk "reason names the command"   "hreason $id | grep -q 'verification failed'"
chk "worktree kept for debug"    "[ -d $STATE/$id/wt ]"

echo "### no-commits and auth parks (Gate 0)"
R=$(new_repo r-none)
stubmode nocommit
id=$(agy-handoff start --repo "$R" --foreground --verify "true" "handoff: do nothing" 2>/dev/null)
chk "no-commits -> parked"       "hreason $id | grep -q 'no commits'"
stubmode autherr
id=$(agy-handoff start --repo "$R" --foreground --verify "true" "handoff: auth dies" 2>/dev/null)
chk "auth error -> auth park"    "hreason $id | grep -q 'auth error'"
stubmode work

echo "### big handoffs — agy self-review branch (no Claude budget)"
quota_cache null null
R=$(new_repo r-big)
: > "$ARGV_LOG"
export AGY_REVIEW_MODEL=slug-x
id=$(agy-handoff start --repo "$R" --size big --foreground --verify "ls stub-*.txt" "handoff: big work" 2>/dev/null)
chk "self-review approve -> merged"   "[ \"\$(hstatus $id)\" = merged ]"
chk "review argv has --model slug-x"  "grep -qx -- '--model' $ARGV_LOG && grep -qx -- 'slug-x' $ARGV_LOG"
chk "review argv has no --effort"     "! grep -qx -- '--effort' $ARGV_LOG"
unset AGY_REVIEW_MODEL
: > "$ARGV_LOG"
id=$(agy-handoff start --repo "$R" --size big --foreground --verify "ls stub-*.txt" "handoff: big default-model" 2>/dev/null)
chk "unset slug -> merged"            "[ \"\$(hstatus $id)\" = merged ]"
chk "default-model review argv has --effort high" "grep -qx -- '--effort' $ARGV_LOG && grep -qx -- 'high' $ARGV_LOG"
reviewmode reject
id=$(agy-handoff start --repo "$R" --size big --foreground --verify "ls stub-*.txt" "handoff: big rejected" 2>/dev/null)
chk "self-review reject -> parked"    "hreason $id | grep -q 'review rejected: bad'"
reviewmode approve

echo "### big handoffs — Claude reviewer branch (seeded budget + stub claude)"
quota_cache 10 10
R=$(new_repo r-claude)
claudemode approve
id=$(agy-handoff start --repo "$R" --size big --foreground --verify "ls stub-*.txt" "handoff: claude approves" 2>/dev/null)
chk "claude APPROVE -> merged"        "[ \"\$(hstatus $id)\" = merged ]"
claudemode tricky
id=$(agy-handoff start --repo "$R" --size big --foreground --verify "ls stub-*.txt" "handoff: claude tricky reject" 2>/dev/null)
chk "'cannot APPROVE...REJECT' -> parked (fail-open regression)" "[ \"\$(hstatus $id)\" = parked ]"
claudemode prose
: > "$ARGV_LOG"
id=$(agy-handoff start --repo "$R" --size big --foreground --verify "ls stub-*.txt" "handoff: prose verdict" 2>/dev/null)
chk "prose verdict -> self-review fallthrough -> merged" "[ \"\$(hstatus $id)\" = merged ]"
chk "fallthrough hit claude then agy"  "grep -q CLAUDE-CALL $ARGV_LOG && [ \$(grep -c AGY-CALL $ARGV_LOG) -ge 2 ]"
claudemode hang
id=$(CLAUDE_REVIEW_TIMEOUT=2 agy-handoff start --repo "$R" --size big --foreground --verify "ls stub-*.txt" "handoff: hung reviewer" 2>/dev/null)
chk "hung reviewer -> timeout -> fallthrough -> merged" "[ \"\$(hstatus $id)\" = merged ]"
claudemode approve

echo "### ready states"
R=$(new_repo r-busy)
touch "$R/dirty-file"
id=$(agy-handoff start --repo "$R" --foreground --verify "ls stub-*.txt" "handoff: busy repo" 2>/dev/null)
chk "dirty repo -> ready, not merged" "[ \"\$(hstatus $id)\" = ready ]"
R=$(new_repo r-nomerge)
id=$(agy-handoff start --repo "$R" --no-merge --foreground --verify "ls stub-*.txt" "handoff: no-merge" 2>/dev/null)
chk "--no-merge green -> ready"       "[ \"\$(hstatus $id)\" = ready ]"

echo "### merge conflict -> parked, main untouched"
R=$(new_repo r-conflict)
echo BASE > "$R/topic.txt"; git -C "$R" add -A; git -C "$R" commit -qm base
export CONFLICT_REPO="$R"
stubmode conflict
id=$(agy-handoff start --repo "$R" --foreground --verify "grep -q AGY topic.txt" "handoff: conflict me" 2>/dev/null)
chk "conflict -> parked"              "hreason $id | grep -q 'merge conflict'"
chk "main kept its own version"       "grep -q MAIN $R/topic.txt"
chk "no half-merge left behind"       "! git -C $R rev-parse -q --verify MERGE_HEAD"
chk "worktree kept for resolution"    "[ -d $STATE/$id/wt ]"
stubmode work
unset CONFLICT_REPO

echo "### resume guards + STALE display"
R=$(new_repo r-resume)
stubmode sleep
id=$(agy-handoff start --repo "$R" --verify "true" "handoff: long sleeper" 2>/dev/null)
sleep 1
chk "detached session live"           "tmux has-session -t '=agyh-$id'"
chk "resume of live run refused"      "rc=0; agy-handoff resume $id >/dev/null 2>&1 || rc=\$?; [ \$rc -eq 1 ]"
chk "running not STALE while live"    "! agy-handoff list | grep \"$id\" | grep -q STALE"
tmux kill-session -t "=agyh-$id"
chk "dead tmux run shows STALE"       "agy-handoff list | grep \"$id\" | grep -q STALE"
agy-handoff resume "$id" >/dev/null 2>&1
sleep 1
chk "resume respawns session"         "tmux has-session -t '=agyh-$id'"
chk "resume flips mode to tmux"       "[ \"\$(jq -r .mode $STATE/$id/meta.json)\" = tmux ]"
tmux kill-session -t "=agyh-$id" 2>/dev/null
stubmode work
RESUMED_ID=$id

echo "### fg-mode never STALE (crafted fixtures, no timing)"
mkdir -p "$STATE/fixture-fg" "$STATE/fixture-tm"
jq -n '{id:"fixture-fg",repo:"/x",base:"main",branch:"agy/fixture-fg",size:"small",auto_merge:true,status:"running",mode:"fg",created:"t"}'   > "$STATE/fixture-fg/meta.json"
jq -n '{id:"fixture-tm",repo:"/x",base:"main",branch:"agy/fixture-tm",size:"small",auto_merge:true,status:"running",mode:"tmux",created:"t"}' > "$STATE/fixture-tm/meta.json"
chk "running fg w/o session: no STALE"   "! agy-handoff list | grep fixture-fg | grep -q STALE"
chk "running tmux w/o session: STALE"    "agy-handoff list | grep fixture-tm | grep -q STALE"
rm -rf "$STATE/fixture-fg" "$STATE/fixture-tm"

echo "### corrupt meta tolerance"
: > "$STATE/$RESUMED_ID/meta.json"
chk "list survives corrupt meta"      "agy-handoff list"
chk "corrupt entry labeled"           "agy-handoff list | grep -q 'unreadable meta.json'"

echo "### reaper: agy- reaped, agyh- spared (private socket)"
tmux new-session -d -s agy-reaptest 'sleep 300'
tmux new-session -d -s agyh-reaptest 'sleep 300'
tmux new-session -d -s other-reaptest 'sleep 300'
sleep 2
IDLE=1 "$REAP" >/dev/null 2>&1
chk "idle agy- reaped"                "! tmux has-session -t '=agy-reaptest'"
chk "agyh- never reaped"              "tmux has-session -t '=agyh-reaptest'"
chk "unrelated session spared"        "tmux has-session -t '=other-reaptest'"
tmux kill-session -t '=agyh-reaptest' 2>/dev/null
tmux kill-session -t '=other-reaptest' 2>/dev/null

echo "### ag launcher (pty on the private socket)"
export TERM=${TERM:-xterm-256color}
mkdir -p "$T/projx"
printf '\n' | timeout 8 script -qec "ag $T/projx" /dev/null >/dev/null 2>&1; sleep 1
chk "ag created agy-projx"            "tmux has-session -t '=agy-projx'"
printf 'q\n' | timeout 8 script -qec "ag $T/projx" /dev/null 2>/dev/null | grep -q "already running" && ok "dup session prompts" || no "dup session prompts"
printf 'n\n' | timeout 8 script -qec "ag $T/projx" /dev/null >/dev/null 2>&1; sleep 1
chk "answer n -> agy-projx-2"         "tmux has-session -t '=agy-projx-2'"

echo
echo "=============================="
echo "RESULT: $PASS passed, $FAIL failed"
echo "=============================="
[ "$FAIL" -eq 0 ]
