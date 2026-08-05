#!/usr/bin/env bash
# Asserts the cap branch: cap 0 must report BUSY (exit 1); a huge cap must report OK (exit 0).
set -uo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"; PC="$HERE/qa-precheck.sh"
out=$("$PC" 0); rc=$?
{ [ "$rc" -eq 1 ] && echo "$out" | grep -q BUSY; } || { echo "FAIL: cap 0 should be BUSY (rc=$rc): $out"; exit 1; }
out=$("$PC" 99); rc=$?
{ [ "$rc" -eq 0 ] && echo "$out" | grep -q OK; } || { echo "FAIL: cap 99 should be OK (rc=$rc): $out"; exit 1; }
echo "PASS: precheck cap branch enforced"
