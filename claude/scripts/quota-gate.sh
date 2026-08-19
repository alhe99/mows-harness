#!/usr/bin/env bash
# quota-gate.sh — UserPromptSubmit hook. Injects a delegation directive into
# context when the active account is at/over the claude-quota threshold.
# Silent when under threshold or unknown (exit 2 = no auto-delegation rule).
# Must never block a prompt: always exits 0. claude-quota has a 300s shared
# cache, so per-prompt calls across many sessions stay cheap.
set -uo pipefail
command -v claude-quota >/dev/null 2>&1 || exit 0
rc=0
timeout 5 claude-quota --check >/dev/null 2>&1 || rc=$?
if [ "$rc" -eq 1 ]; then
  line="$(timeout 3 claude-quota --line 2>/dev/null || true)"
  echo "⚠️ QUOTA GATE: active account ≥70% (${line:-quota line unavailable}). Sizeable implementation work MUST be delegated to agy per the agy-delegate skill: agy-run for small/medium tasks, agy-handoff for big ones. Trivial edits, answers, and reviews may proceed on Claude."
fi
exit 0
