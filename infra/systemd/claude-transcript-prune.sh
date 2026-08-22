#!/usr/bin/env bash
# claude-transcript-prune.sh — prune Claude Code transcripts idle >30 days.
#
# Discovers every account's config dir(s) under /home/* instead of a hardcoded
# account list: each user's default ~/.claude plus every ~/.claude-<profile>
# sibling — the same default/--suffix convention as profiles()/cfg_for()
# elsewhere in this harness (fleet/bin/claude-rc, watchdogs/bin/claude-health),
# generalized here across every system user's home dir since this script runs
# system-wide as root from claude-transcript-prune.timer, not as one account.
#
# Guard: ONE system-wide lsof pass up front — never delete a file some process
# still holds open, no matter which account's listener has it open.
#
# Runs as root (oneshot service triggered by the daily timer). Every pipeline
# below is guarded against "found nothing" (no open .jsonl per lsof, no stale
# .jsonl per find, no empty dirs per find) with `|| true` — under
# set -euo pipefail, grep/find legitimately exiting 1 on zero matches would
# otherwise abort a perfectly normal, no-op run (e.g. a freshly provisioned
# box, or one pruned <24h ago) instead of just... finding nothing to do.
set -euo pipefail
shopt -s nullglob

# Discover user profiles under /home/* only; root's own ~/.claude* is intentionally not globbed.
ROOTS=()
for d in /home/*/.claude /home/*/.claude-*; do
  [ -L "$d" ] && continue   # never follow a symlinked profile root (CWE-59)
  [ -d "$d/projects" ] || continue
  ROOTS+=("$d/projects")
done

if [ "${#ROOTS[@]}" -eq 0 ]; then
  echo "claude-transcript-prune: no */projects dirs found under /home/*/.claude*" >&2
  exit 0
fi

TMP=$(mktemp)
trap 'rm -f "$TMP"' EXIT

# ---- pruning body, ported verbatim from live (lsof guard + 30-day mtime cutoff) ----
lsof -Fn 2>/dev/null | sed -n 's/^n//p' | grep '\.jsonl$' | sort -u > "$TMP" || true
find "${ROOTS[@]}" -name '*.jsonl' -mtime +30 -print 2>/dev/null | grep -vxF -f "$TMP" | xargs -r rm -- || true
find "${ROOTS[@]}" -mindepth 1 -type d -empty -delete 2>/dev/null || true
