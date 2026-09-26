#!/usr/bin/env bash
# live-agy — the REAL-agy scenario matrix. Costs real Google AI Pro quota and
# needs a logged-in agy; therefore it NEVER runs in CI and never runs without
# an explicit --yes. Re-run after every agy upgrade or model-table change.
#
# Covers what the hermetic matrix (scripts/e2e-agy.sh) cannot: real auth
# persistence and real model slugs.
set -u
cd "$(dirname "$0")/.."

if [ "${1:-}" != "--yes" ]; then
  cat <<'EOF'
live-agy: runs a REAL agy ping — costs a small amount of AI Pro quota and
requires a completed `agy` login. Never run by CI.

Scenarios: auth persistence · model table validity.

Run for real:  scripts/live-agy.sh --yes
EOF
  exit 0
fi

PASS=0; FAIL=0
ok(){ echo "PASS: $*"; PASS=$((PASS+1)); }
no(){ echo "FAIL: $*"; FAIL=$((FAIL+1)); }
chk(){ if eval "$2" >/dev/null 2>&1; then ok "$1"; else no "$1"; fi; }

CFG="$HOME/.config/mows-agy/config"; [ -f "$CFG" ] && . "$CFG"
T=$(mktemp -d)
cleanup(){ rm -rf "$T"; }
trap cleanup EXIT

echo "### auth persistence (fresh process, no login prompt)"
PING=$(agy -p "Reply with exactly: pong" --output-format json --print-timeout 3m 2>"$T/ping.err") || {
  echo "FAIL: agy call failed — not logged in? stderr:"; cat "$T/ping.err"; exit 1; }
chk "headless ping succeeds"    "printf '%s' \"\$PING\" | jq -e '.status==\"SUCCESS\"'"
chk "auth stderr clean"         "! grep -qiE 'auth|sign.?in|unauthorized' $T/ping.err"

echo "### model table matches reality"
MODELS=$(agy models 2>/dev/null)
for v in AGY_FAST_MODEL; do
  s=${!v:-}
  if [ -n "$s" ]; then
    chk "$v ($s) exists upstream" "grep -q \"^$s\b\" <<<\"\$MODELS\""
  else
    ok "$v unset (agy default tier) — nothing to validate"
  fi
done
echo
echo "=============================="
echo "RESULT: $PASS passed, $FAIL failed"
echo "=============================="
[ "$FAIL" -eq 0 ]
