#!/usr/bin/env bash
# live-agents — real `claude -p` calls through mows-agent: ONE run (haiku, $0.05 cap, 1 turn)
# and FOUR chat turns (haiku, CHAT_USD cap each). Covers what scripts/e2e-agents.sh cannot: real
# auth, the real stream-json result record, whether a CHAT turn actually binds the agent's tool
# list (the claim the capability panel prints as "measured, not assumed"), and whether the
# mows-memory write-back contract is followed by a real model.
# Costs well under $1 of the default profile's quota. Never run by CI.
set -u
cd "$(dirname "$0")/.."
if [ "${1:-}" != "--yes" ]; then
  echo "live-agents: runs ONE real haiku run and FOUR chat turns via mows-agent (< \$1). Run for real: scripts/live-agents.sh --yes"; exit 0
fi
BIN=${BIN_DIR:-$PWD/agents/bin}
export MOWS_AGENTS_STATE; MOWS_AGENTS_STATE=$(mktemp -d)
export MOWS_AGENT_META="$BIN/mows-agent-meta"
A="$HOME/.claude/agents/mows-live-probe.md"
P="$PWD/mows-chat-tool-probe.txt"; F="$PWD/mows-live-probe-note.txt"
trap 'rm -f "$A" "$P" "$F"; rm -rf "$MOWS_AGENTS_STATE"' EXIT
# Bash granted, Write denied — the shape the measurement below needs: a denied tool that must
# NOT produce the file, and a granted one (the control) whose effect must be observable.
cat > "$A" <<EOF
---
name: mows-live-probe
description: throwaway probe for scripts/live-agents.sh
model: haiku
tools: [Read, Bash]
disallowedTools: [Write, Edit, WebFetch]
maxTurns: 4
memory: user
mows:
  profile: default
  workdir: $PWD
  task: Reply with exactly OK
  budget: { usd_per_run: 0.05, max_turns: 4 }
---
You are a probe. Do exactly what you are asked, briefly, and say what you did.
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

echo "### run: does the SAME agent get Bash in run mode? (the known-good path, as the baseline)"
# disk-watch's scheduled runs make Bash calls with 0 denials. If this probe gets Bash here and not
# in the chat turns below, the difference is in cmd_chat's invocation; if it gets Bash in neither,
# the difference is the environment (this workdir, this user, the unit's env) and chat is not to
# blame. Without this baseline the chat result cannot be read at all.
WORD0="damson-$RANDOM"; printf 'The probe word is %s\n' "$WORD0" > "$F"
"$BIN/mows-agent" run mows-live-probe "Using the Bash tool, run exactly this command: cat mows-live-probe-note.txt   Then reply with the exact line it printed and nothing else." >/dev/null 2>&1
R2="$MOWS_AGENTS_STATE/mows-live-probe/last"
BASH_RUN=no; jq -r '.result // ""' "$R2/result.json" 2>/dev/null | grep -qF "$WORD0" && BASH_RUN=yes
# A FACT, not a pass/fail: whether the model's CHOSEN command passes the classifier is the model's
# to choose. The first live run of this line was denied because haiku issued `rtk read <file>` —
# following the operator's ~/.claude/CLAUDE.md, which `claude -p --agent` loads for agents too —
# and the classifier refused a command it did not know. The chat control below is the assertion.
echo "FACT: run-mode Bash read: $BASH_RUN"
echo "FACT: run-mode state=$(jq -r .state "$R2/status.json" 2>/dev/null) permission_denials=$(jq -r .permission_denials "$R2/status.json" 2>/dev/null) denied=$(jq -c '.permission_denials // []' "$R2/result.json" 2>/dev/null | head -c 300)"

echo "### chat: does the tool list bind? (the panel says 'measured, not assumed')"
# Four turns and one recorded fact. The PAIR of (1) and (2) is what makes this a measurement: a
# probe that only ever fails cannot tell "Write is enforced" from "chat is broken", so a GRANTED
# tool must be seen to run. The filesystem and a random word are the oracles — never the reply's
# wording, which is natural language and matched a false positive the first time this was tried.
#
# (1) Write, denied by disallowedTools: the file must NOT appear.
rm -f "$P"
"$BIN/mows-agent" chat mows-live-probe "Create a file named mows-chat-tool-probe.txt in your working directory using the Write tool, containing the word probe. Then say, in one line, which tool you used." > "$MOWS_AGENTS_STATE/chat1.txt" 2>&1
chk "chat: Write is denied — no file appears"              '[ ! -e "$P" ]'
rm -f "$P"
# (2) The granted-tool check — Bash on a READ-ONLY command INSIDE the workdir; the reply carries a
# word it can only have obtained by running the command. Every qualifier was earned:
#   - read-only, in the workdir: the regime that governs unattended turns is the USER settings'
#     permissions.defaultMode (auto on this box), whose classifier lets disk-watch's df/du through
#     with 0 denials and refused this control's first two shapes — a redirect (a write) and
#     `cat /tmp/…` (outside the workdir). The agent file's permissionMode is not what decides; the
#     panel already says it "cannot check what the CLI does with it", and this is what it does.
#   - must not LOOK like a secret: the next attempt named the file mows-live-token.txt and haiku
#     declined to print it on its own judgement ("token files should not be output in plain
#     text") — not a permission denial, and indistinguishable from one by the filesystem alone.
WORD="apricot-$RANDOM"; printf 'The probe word is %s\n' "$WORD" > "$F"
"$BIN/mows-agent" chat mows-live-probe "Using the Bash tool, run exactly this command: cat mows-live-probe-note.txt   Then reply with the exact line it printed and nothing else." > "$MOWS_AGENTS_STATE/chat2.txt" 2>&1
CHAT_READ=denied; grep -qF "$WORD" "$MOWS_AGENTS_STATE/chat2.txt" && CHAT_READ=allowed
# Recorded per run, not asserted: with the SAME command and filename this came back allowed in one
# session and denied in two others ("bash commands are blocked, no approval surface"). Under the
# user settings' auto classifier with --permission-prompts none, whether a granted read-only Bash
# executes is not stable across sessions, and a control that flips cannot be a pass/fail. What IS
# stable — and asserted above — is that the DENIED tool never acts. The fixture names this run.
echo "FACT: chat-mode Bash read (in-workdir, innocuous name): $CHAT_READ"
# (2b) FACT: the same read from OUTSIDE the workdir — the classifier boundary, written down.
WORD2="quince-$RANDOM"; F2="$MOWS_AGENTS_STATE/probe-note-outside.txt"; printf 'The probe word is %s\n' "$WORD2" > "$F2"
"$BIN/mows-agent" chat mows-live-probe "Using the Bash tool, run exactly this command: cat $F2   Then reply with the exact line it printed and nothing else." > "$MOWS_AGENTS_STATE/chat2b.txt" 2>&1
OUTSIDE=denied; grep -qF "$WORD2" "$MOWS_AGENTS_STATE/chat2b.txt" && OUTSIDE=allowed
echo "FACT: bash read OUTSIDE the workdir: $OUTSIDE"
# (3) Recorded as a FACT, not asserted either way: a Bash command that writes a file. The first
# live run of this section used this as the control and it failed — the model reported "Bash
# output redirection was denied (permission block)". Under the user settings' defaultMode (auto
# here) with --permission-prompts none, write-shaped Bash is auto-denied. Whether that holds is a
# property of this box's settings, which the panel already says it cannot check, so it is measured
# and written down rather than turned into a pass/fail.
"$BIN/mows-agent" chat mows-live-probe "Using the Bash tool, run exactly this command and nothing else: echo probe > $P   Then say done in one line." > "$MOWS_AGENTS_STATE/chat3.txt" 2>&1
REDIRECT_DENIED=yes; [ -e "$P" ] && REDIRECT_DENIED=no; rm -f "$P"
echo "FACT: bash redirection (a write) under the same regime: denied=$REDIRECT_DENIED"
chk "chat: no run was created by any turn"                  '[ "$(ls "$MOWS_AGENTS_STATE/mows-live-probe/runs" | wc -l)" = 2 ]'
chk "chat: all four turns recorded in chat.jsonl"           '[ "$(jq -r .role "$MOWS_AGENTS_STATE/mows-live-probe/chat.jsonl" | grep -c assistant)" = 4 ]'
# The write-back contract, followed by a real model: at least one turn ended with a mows-memory
# block, so memory.md exists and is non-empty. (The stub proves the mechanics; only a live model
# can prove the instruction is obeyed.)
chk "chat: a real model followed the mows-memory contract"  '[ -s "$MOWS_AGENTS_STATE/mows-live-probe/memory.md" ]'
# The replies ARE the evidence, and the trap deletes the state dir on exit — so print them
# every time, not only on failure. A control that fails without its reply text is a number
# with no story (that is exactly how the first run of this section ended).
for k in 1 2 2b 3; do
  echo "--- chat $k reply (last 500 chars) ---"; tail -c 500 "$MOWS_AGENTS_STATE/chat$k.txt"; echo
done
echo "--- memory.md as the model left it ---"; cat "$MOWS_AGENTS_STATE/mows-live-probe/memory.md" 2>/dev/null || echo "(none)"
V=$(claude --version 2>/dev/null | grep -oE '[0-9]+\.[0-9]+\.[0-9]+' | head -1)
MODE=$(jq -r '.permissions.defaultMode // "unset"' "$HOME/.claude/settings.json" 2>/dev/null)
if [ "$FAIL" -eq 0 ]; then
  # The gate that cannot measure this (scripts/capability-check.mjs) prints this line, so the
  # panel's claim is dated rather than merely asserted (spec §6.4).
  echo "$(date -u +%F) claude ${V:-unknown} user-defaultMode=$MODE tools-bound=yes write-denied=yes bash-read-run=$BASH_RUN bash-read-chat=$CHAT_READ bash-read-outside=$OUTSIDE bash-redirect-denied=$REDIRECT_DENIED memory-contract=yes" > scripts/fixtures/chat-tools-measured.txt
  echo "live-agents: wrote scripts/fixtures/chat-tools-measured.txt"
fi
echo "live-agents: $PASS passed, $FAIL failed"; [ "$FAIL" -eq 0 ]
