#!/usr/bin/env bash
# live-agents — ONE real `claude -p` run through mows-agent (haiku, $0.05 cap, 1 turn).
# Covers what scripts/e2e-agents.sh cannot: real auth, the real stream-json result record.
# Costs ~$0.05 of the default profile's quota. Never run by CI.
set -u
cd "$(dirname "$0")/.."
if [ "${1:-}" != "--yes" ]; then
  echo "live-agents: runs ONE real haiku call via mows-agent (~\$0.05). Run for real: scripts/live-agents.sh --yes"; exit 0
fi
BIN=${BIN_DIR:-$PWD/agents/bin}
export MOWS_AGENTS_STATE; MOWS_AGENTS_STATE=$(mktemp -d)
export MOWS_AGENT_META="$BIN/mows-agent-meta"
A="$HOME/.claude/agents/mows-live-probe.md"
trap 'rm -f "$A"; rm -rf "$MOWS_AGENTS_STATE" "$HOME/.claude/agent-memory/mows-live-probe"' EXIT
cat > "$A" <<EOF
---
name: mows-live-probe
description: throwaway probe for scripts/live-agents.sh
model: haiku
tools: [Read]
disallowedTools: [Write, Edit, Bash, WebFetch]
maxTurns: 1
memory: user
mows:
  profile: default
  workdir: $PWD
  task: Reply with exactly OK
  budget: { usd_per_run: 0.05, max_turns: 1 }
---
You are a probe. Reply with exactly OK and nothing else.
EOF
PASS=0; FAIL=0; ok(){ echo "PASS: $*"; PASS=$((PASS+1)); }; no(){ echo "FAIL: $*"; FAIL=$((FAIL+1)); }
chk(){ if eval "$2" >/dev/null 2>&1; then ok "$1"; else no "$1"; fi; }
chk "lint clean" "$BIN/mows-agent lint mows-live-probe"
"$BIN/mows-agent" run mows-live-probe; RC=$?
S="$MOWS_AGENTS_STATE/mows-live-probe/last"
chk "run exit 0"                 '[ "$RC" = 0 ]'
chk "state done"                 '[ "$(jq -r .state "$S/status.json")" = done ]'
chk "real cost > 0"              'jq -e ".cost_usd > 0" "$S/status.json"'
chk "result says OK"             'jq -r .result "$S/result.json" | grep -q OK'
chk "no permission denials"      '[ "$(jq -r .permission_denials "$S/status.json")" = 0 ]'
# Deliberately no "agent memory dir created" assertion: <cfgdir>/agent-memory/<name>/MEMORY.md
# is created lazily by the claude CLI itself (mows-agent only passes `memory: user` through
# in frontmatter — it never creates, reads, or writes that path), and a one-turn, no-tool-use
# "reply OK" probe gives the CLI nothing to persist. Do not re-add this: proving it needs a
# multi-turn agent that actually writes memory, which costs real money for no gain in a smoke
# test. Left as an open, unverified claim for the final review — the first real scheduled run
# of harness-reviewer after merge is what will confirm or refute agent-memory creation.
echo "live-agents: $PASS passed, $FAIL failed"; [ "$FAIL" -eq 0 ]
