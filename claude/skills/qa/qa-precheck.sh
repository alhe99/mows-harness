#!/usr/bin/env bash
# ponytail: advisory pre-launch guard, NOT a hard lock. Prevents too-many-Chromes OOM under
# on-demand use; --isolated already prevents profile clashes; swap absorbs spikes.
# Upgrade to real flock slot-locking only if accounts actually contend. Shared across accounts.
# usage: qa-precheck.sh [cap]   (default 2)  -> prints status; exit 0 OK / 1 BUSY|LOWMEM
set -uo pipefail
cap="${1:-2}"
# ponytail: count only real headless browser MAIN processes — exclude chrome --type= children
# and MCP node/npx wrapper cmdlines (they carry --headless too and caused false BUSY at cap 2).
running=$(pgrep -af -- '--headless|headless_shell' 2>/dev/null | grep -vc -e '--type=' -e 'node ' -e 'npm exec' -e 'sh -c' || true); running="${running:-0}"
avail_mb=$(free -m | awk '/^Mem:/{print $7}'); avail_mb="${avail_mb:-0}"
echo "headless_chromes=$running avail_mem_mb=$avail_mb cap=$cap"
if [ "$running" -ge "$cap" ]; then echo "BUSY: $running headless Chromes running (cap $cap) — wait or close one"; exit 1; fi
if [ "$avail_mb" -lt 800 ]; then echo "LOWMEM: ${avail_mb}MB available — wait before launching"; exit 1; fi
echo OK
