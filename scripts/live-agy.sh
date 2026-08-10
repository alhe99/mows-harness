#!/usr/bin/env bash
# live-agy — the REAL-agy scenario matrix. Costs real Google AI Pro quota and
# needs a logged-in agy; therefore it NEVER runs in CI and never runs without
# an explicit --yes. Re-run after every agy upgrade or model-table change.
#
# Covers what the hermetic matrix (scripts/e2e-agy.sh) cannot: real auth
# persistence, real model slugs, real structured output on the review tier,
# and three end-to-end handoffs (merge / real review / conflict park) against
# a throwaway repo.
set -u
cd "$(dirname "$0")/.."

if [ "${1:-}" != "--yes" ]; then
  cat <<'EOF'
live-agy: runs REAL agy calls (2 pings, 1 structured-output probe, 3 handoffs
of which one takes a model review) — costs a small amount of AI Pro quota and
requires a completed `agy` login. Never run by CI.

Scenarios: auth persistence · model table validity · review-tier structured
output · small handoff -> auto-merge · big handoff -> model review -> merge ·
provoked merge conflict -> park with clean target repo.

Run for real:  scripts/live-agy.sh --yes
EOF
  exit 0
fi

PASS=0; FAIL=0
ok(){ echo "PASS: $*"; PASS=$((PASS+1)); }
no(){ echo "FAIL: $*"; FAIL=$((FAIL+1)); }
chk(){ if eval "$2" >/dev/null 2>&1; then ok "$1"; else no "$1"; fi; }

CFG="$HOME/.config/mows-agy/config"; [ -f "$CFG" ] && . "$CFG"
STATE="$HOME/.local/state/agy-handoffs"
T=$(mktemp -d); CLEAN_IDS=()
cleanup(){
  local i
  for i in "${CLEAN_IDS[@]:-}"; do
    [ -n "$i" ] || continue
    git -C "$T/repo" worktree remove --force "$STATE/$i/wt" 2>/dev/null
    tmux kill-session -t "=agyh-$i" 2>/dev/null
    rm -rf "${STATE:?}/$i"
  done
  rm -rf "$T"
}
trap cleanup EXIT

echo "### auth persistence (fresh process, no login prompt)"
PING=$(agy -p "Reply with exactly: pong" --output-format json --print-timeout 3m 2>"$T/ping.err") || {
  echo "FAIL: agy call failed — not logged in? stderr:"; cat "$T/ping.err"; exit 1; }
chk "headless ping succeeds"    "printf '%s' \"\$PING\" | jq -e '.status==\"SUCCESS\"'"
chk "auth stderr clean"         "! grep -qiE 'auth|sign.?in|unauthorized' $T/ping.err"

echo "### model table matches reality"
MODELS=$(agy models 2>/dev/null)
for v in AGY_FAST_MODEL AGY_REVIEW_MODEL; do
  s=${!v:-}
  if [ -n "$s" ]; then
    chk "$v ($s) exists upstream" "grep -q \"^$s\b\" <<<\"\$MODELS\""
  else
    ok "$v unset (agy default tier) — nothing to validate"
  fi
done
if [ -n "${AGY_REVIEW_MODEL:-}" ]; then
  chk "review tier supports --json-schema" \
    "agy-run --model \"$AGY_REVIEW_MODEL\" --timeout 3m --json --schema '{\"type\":\"object\",\"properties\":{\"approve\":{\"type\":\"boolean\"}},\"required\":[\"approve\"]}' -- 'Return approve=true.' | jq -e '.structured_output.approve==true'"
fi

echo "### smoke repo"
git init -qb main "$T/repo"
git -C "$T/repo" config commit.gpgsign false
git -C "$T/repo" commit -qm init --allow-empty

wait_done(){ # wait_done <id> [tries]  -> echoes final status
  local i st
  for i in $(seq 1 "${2:-60}"); do
    st=$(jq -r .status "$STATE/$1/meta.json" 2>/dev/null || echo missing)
    case "$st" in running|gated) sleep 10;; *) break;; esac
  done
  echo "$st"
}

echo "### small handoff -> auto-merge"
id=$(agy-handoff start --repo "$T/repo" --size small \
      --verify "test -f hello.txt" --verify "grep -q hello hello.txt" \
      "Create a file hello.txt containing exactly the word: hello")
CLEAN_IDS+=("$id")
st=$(wait_done "$id")
chk "small handoff merged"      "[ \"$st\" = merged ]"
chk "merge commit landed"       "git -C $T/repo log --oneline | grep -q 'agy handoff $id'"
chk "conversation_id captured"  "jq -e '.conversation_id | length > 0' $STATE/$id/meta.json"

echo "### big handoff -> model review -> merge"
REVIEWER=$(claude-quota --reviewer 2>/dev/null || echo "none (agy self-review)")
echo "  (review branch in play: $REVIEWER)"
id=$(agy-handoff start --repo "$T/repo" --size big \
      --verify "bash greet.sh World | grep -q 'Hello, World'" \
      "Add greet.sh: a bash script printing 'Hello, <name>!' for the name in \$1. Minimal.")
CLEAN_IDS+=("$id")
st=$(wait_done "$id" 90)
chk "big handoff merged after review" "[ \"$st\" = merged ]"

echo "### provoked merge conflict -> park, target repo untouched"
echo "MAIN-BASE" > "$T/repo/topic.txt"
git -C "$T/repo" add topic.txt && git -C "$T/repo" commit -qm "base topic"
id=$(agy-handoff start --repo "$T/repo" --size small \
      --verify "grep -q AGY-VERSION topic.txt" \
      "Replace the entire content of topic.txt with exactly: AGY-VERSION")
CLEAN_IDS+=("$id")
echo "MAIN-CONFLICT" > "$T/repo/topic.txt"
git -C "$T/repo" commit -qam "conflicting main edit"
st=$(wait_done "$id")
chk "conflict handoff parked"   "[ \"$st\" = parked ]"
chk "park reason is the merge"  "jq -r .reason $STATE/$id/meta.json | grep -q 'merge conflict'"
chk "main kept its own edit"    "grep -q MAIN-CONFLICT $T/repo/topic.txt"
chk "no half-merge left"        "! git -C $T/repo rev-parse -q --verify MERGE_HEAD"

echo
echo "=============================="
echo "RESULT: $PASS passed, $FAIL failed"
echo "=============================="
[ "$FAIL" -eq 0 ]
