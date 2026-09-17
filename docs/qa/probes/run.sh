#!/usr/bin/env bash
# Stand the fixture dashboard and the cuttable proxy up, run a probe, tear both down.
#
#   ./docs/qa/probes/run.sh <journey|lost|repeat|csp|base|all> [chromium|webkit]
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
  local mode=$1 seed=hello
  [ "$mode" = repeat ] && seed='status?'
  up "$seed" || return 1
  node "$HERE/probes.mjs" "$mode" "$ENGINE"
}

rc=0
if [ "$MODE" = all ]; then
  for m in journey lost repeat csp base; do
    echo "### $m"
    one "$m" || rc=1
  done
else
  one "$MODE" || rc=1
fi
exit "$rc"
