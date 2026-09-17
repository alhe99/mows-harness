#!/usr/bin/env bash
# Stand the fixture dashboard and the cuttable proxy up, run a probe, tear both down.
#
#   ./docs/qa/probes/run.sh <journey|lost|repeat|csp|base|layout|all> [chromium|webkit]
#
# See README.md in this directory. Needs docker; needs Playwright only for the probe itself, which
# SKIPs loudly without it rather than failing.
set -uo pipefail
MODE=${1:-journey}
ENGINE=${2:-chromium}
HERE=$(cd "$(dirname "$0")" && pwd)
REPO=$(cd "$HERE/../../.." && pwd)

# Ports well clear of a real dashboard (3005) or a dev one (3105) on the same box.
UI_PORT=3905; PROXY_PORT=3906; CUT_PORT=3907
BOX=mows-qa-ui
export MOWS_QA_DIRECT="http://127.0.0.1:$UI_PORT"
export MOWS_QA_BASE="http://127.0.0.1:$PROXY_PORT"
export MOWS_QA_CUT="http://127.0.0.1:$CUT_PORT"
export MOWS_QA_CONTAINER="$BOX"

PROXY_PID=""
cleanup() {
  [ -n "$PROXY_PID" ] && kill "$PROXY_PID" 2>/dev/null
  docker rm -f "$BOX" >/dev/null 2>&1
}
trap cleanup EXIT INT TERM

up() {
  # $1 is the transcript's first user turn. The repeat probe needs one that ALREADY contains the
  # message it is about to send; every other probe wants the neutral fixture.
  cleanup
  docker run -d --name "$BOX" -e "MOWS_QA_SEED=$1" -p "127.0.0.1:$UI_PORT:3005" \
    -v "$REPO":/r:ro -v "$HERE":/probes:ro node:20-slim bash /probes/fixture.sh >/dev/null || return 1
  node "$HERE/proxy.mjs" "$PROXY_PORT" "$UI_PORT" "$CUT_PORT" >/dev/null 2>&1 &
  PROXY_PID=$!
  for _ in $(seq 1 30); do
    curl -sf -o /dev/null "http://127.0.0.1:$PROXY_PORT/ui" && return 0
    sleep 1
  done
  echo "the fixture dashboard never came up on $UI_PORT" >&2
  return 1
}

one() {
  local mode=$1 seed=hello rc out
  [ "$mode" = repeat ] && seed='status?'
  up "$seed" || return 1
  # Tee rather than plain run, so the output is still live AND can be checked. probes.mjs prints
  # exactly one RESULT[...] line per run, at the end, in every terminating path including SKIP.
  # Its ABSENCE means the probe died before reaching it — a syntax error at import time, a crash in
  # the harness, an OOM — and that is the one outcome a reader scanning for RESULT/FAIL lines does
  # not see, because it produces neither. Caught here rather than trusted: this exact shape bit
  # during the round that added the `layout` mode, where an identifier collision killed all six
  # modes in both engines and the run's summary lines were simply missing.
  out=$(node "$HERE/probes.mjs" "$mode" "$ENGINE" 2>&1); rc=$?
  printf '%s\n' "$out"
  if ! grep -q 'RESULT\[' <<<"$out"; then
    echo "FAIL: [$ENGINE] $mode printed no RESULT line — it died before finishing (exit $rc)" >&2
    return 1
  fi
  return "$rc"
}

rc=0
if [ "$MODE" = all ]; then
  for m in journey lost repeat csp base layout; do
    echo "### $m"
    one "$m" || rc=1
  done
else
  one "$MODE" || rc=1
fi
exit "$rc"
