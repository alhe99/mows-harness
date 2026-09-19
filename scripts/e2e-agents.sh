#!/usr/bin/env bash
# e2e-agents — hermetic matrix for the agents layer (Layer 6). Stubs for claude, claude-quota,
# curl, gh, systemd-analyze, systemctl in a throwaway HOME; no network, no real state dir.
#   bash scripts/e2e-agents.sh                          # repo copies (agents/bin)
#   BIN_DIR=~/.local/bin bash scripts/e2e-agents.sh     # installed copies
set -u
cd "$(dirname "$0")/.."
REPO=$PWD
BIN_DIR=${BIN_DIR:-$REPO/agents/bin}
PASS=0; FAIL=0
ok(){ echo "PASS: $*"; PASS=$((PASS+1)); }
no(){ echo "FAIL: $*"; FAIL=$((FAIL+1)); }
chk(){ if eval "$2" >/dev/null 2>&1; then ok "$1"; else no "$1"; fi; }

T=$(mktemp -d); trap 'rm -rf "$T"' EXIT
unset TMUX
export HOME="$T/home"
mkdir -p "$HOME/.claude/agents" "$HOME/.claude-work/agents" "$HOME/.local/state" "$HOME/.config/mows-agents" "$T/shim" "$T/work"
export PATH="$T/shim:$BIN_DIR:$PATH"
export MOWS_AGENTS_STATE="$HOME/.local/state/mows-agents"
export MOWS_AGENT_META="$BIN_DIR/mows-agent-meta"
export CLAUDE_MODE_FILE="$T/claude-mode" CLAUDE_ARGS_FILE="$T/claude-args" CLAUDE_RESULT_FILE="$T/claude-result" CURL_LOG="$T/curl.log" QUOTA_FILE="$T/quota.json" GH_LOG="$T/gh.log" SYSTEMCTL_LOG="$T/systemctl.log"
export STALL_SEC=2
echo "DISCORD_WEBHOOK=https://discord.invalid/hook" > "$HOME/.config/mows-agents/config"

# ---------- stubs ----------
cat > "$T/shim/systemd-analyze" <<'S'
#!/usr/bin/env bash
# accepts anything containing a digit or '*'; rejects "bogus"
[ "$1" = calendar ] && [[ $2 != *bogus* ]] && exit 0; exit 1
S
cat > "$T/shim/gh" <<'S'
#!/usr/bin/env bash
echo "gh $*" >> "${GH_LOG:-/dev/null}"; exit 0
S
cat > "$T/shim/curl" <<'S'
#!/usr/bin/env bash
# capture the JSON body of a Discord post; never touch the network
for ((i=1;i<=$#;i++)); do [ "${!i}" = --data ] && { j=$((i+1)); echo "${!j}" >> "${CURL_LOG:-/dev/null}"; }; done; exit 0
S
cat > "$T/shim/claude-quota" <<'S'
#!/usr/bin/env bash
[ "$1" = --json ] && cat "${QUOTA_FILE}" && exit 0; exit 2
S
cat > "$T/shim/systemctl" <<'S'
#!/usr/bin/env bash
echo "systemctl $*" >> "${SYSTEMCTL_LOG:-/dev/null}"
[ "$1" = list-timers ] && echo "Tue 2026-09-16 06:00:00 UTC  7h left  -  -  mows-agent-t.timer  mows-agent@t.service"; exit 0
S
cat > "$T/shim/claude" <<'S'
#!/usr/bin/env bash
# stub claude: --version, `agents --json`, or a scripted -p run chosen by $CLAUDE_MODE_FILE
# (ok|budget|maxturns|error|noresult|hang|badtext|crashafter|nodelta). argv + CLAUDE_CONFIG_DIR land
# in $CLAUDE_ARGS_FILE.
[ "${1:-}" = --version ] && { echo "2.1.273 (Claude Code)"; exit 0; }
[ "${1:-}" = agents ] && { [ -n "${CLAUDE_AGENTS_HANG:-}" ] && sleep 3600; cat "${CLAUDE_AGENTS_JSON_FILE:-/dev/null}"; exit 0; }
{ printf '%s\n' "$@"; echo "CLAUDE_CONFIG_DIR=${CLAUDE_CONFIG_DIR:-}"; echo "PWD=$PWD"; } > "${CLAUDE_ARGS_FILE:-/dev/null}"
mode=$(cat "${CLAUDE_MODE_FILE:-/dev/null}" 2>/dev/null || echo ok)
sid=00000000-0000-4000-8000-000000000001
# badtext: the plain-text-notice-on-exit-0 failure the non-streaming path already guards
# against (agents/bin/mows-agent:355). Bypasses every JSON record below — must print ONLY
# the notice, so this has to run before the stream-delta case and the normal echoes.
[ "$mode" = badtext ] && { echo "No conversation found with session ID: $sid"; exit 0; }
# Delta records mirror the real CLI's own contract: --include-partial-messages ALONE is not
# enough to produce them (the real CLI also needs --output-format stream-json --verbose), so
# gate on all three the way the CLI does — gating on one flag only would stay green even if
# the streaming invocation silently downgraded to plain --output-format json, which produces
# no stream_event records at all against the real CLI (fix round 1, F5).
# nodelta additionally suppresses deltas regardless of flags (the flags are still present in
# argv — mode is what gates this, not argv) — a tool-only turn, or a CLI version that omits
# partial messages for some content type, still needs to succeed via the result record's own
# .result text alone (fix round 1, F7; re-review round 1, R2: the fallback shipped unasserted).
argv=" $* "
if [ "$mode" != nodelta ] && [[ $argv == *" --include-partial-messages "* \
   && $argv == *" --output-format "* && $argv == *" stream-json "* && $argv == *" --verbose "* ]]; then
  for w in "stub " "says " "OK"; do
    printf '{"type":"stream_event","event":{"type":"content_block_delta","delta":{"type":"text_delta","text":"%s"}}}\n' "$w"
  done
  # A delta that is itself just a paragraph break, and one that ends on a newline — the two
  # shapes a plain `t=$(jq -r … <<<"$line")` silently loses (command substitution strips ALL
  # trailing newlines from its capture): the first vanishes into "" and never even increments
  # seq, the second loses its trailing "\n". Neither is hypothetical (fix round 1, F1).
  # The \n below MUST be passed as a %s argument, not written into the format string: printf
  # interprets a literal \n IN THE FORMAT STRING as a real newline byte, which would split
  # this JSON record across multiple physical lines before `while read -r line` ever sees it
  # (caught empirically — the deltas silently failed to register at all the first time).
  printf '{"type":"stream_event","event":{"type":"content_block_delta","delta":{"type":"text_delta","text":"%s"}}}\n' '\n\n'
  printf '{"type":"stream_event","event":{"type":"content_block_delta","delta":{"type":"text_delta","text":"%s"}}}\n' 'Second paragraph.\n'
fi
echo '{"type":"system","subtype":"init","session_id":"'$sid'"}'
echo '{"type":"assistant","message":{"role":"assistant","content":[{"type":"tool_use","id":"t1","name":"Read","input":{}}]},"session_id":"'$sid'"}'
echo '{"type":"assistant","message":{"role":"assistant","content":[{"type":"text","text":"stub says OK"}]},"session_id":"'$sid'"}'
res(){ echo '{"type":"result","subtype":"'$1'","is_error":'$2',"terminal_reason":"'$3'","num_turns":2,"session_id":"'$sid'","total_cost_usd":'$4',"permission_denials":[],"result":"'$5'"}'; }
case $mode in
  ok)         res success false completed 0.0123 "stub says OK";;
  budget)     res error_max_budget_usd true budget_exceeded 1.5 "";;
  maxturns)   res error_max_turns true max_turns 0.5 "";;
  error)      res success true api_error 0 "Not logged in";;
  noresult)   exit 1;;
  hang)       sleep 3600;;
  # crashafter: a result record DOES arrive (sawres=1) and the process THEN exits non-zero —
  # the only shape that isolates the __mows_rc= sentinel's own half of the failure check
  # (`[ "$rc" != 0 ]`) from sawres's half, which alone already catches every other mode here
  # (fix round 1, F4).
  crashafter) res success false completed 0.0123 "stub says OK"; exit 1;;
  # nodelta: a result record with real text, but no deltas at all (suppressed above by mode,
  # not by argv — the streaming flags are still exactly what a real turn would send). Proves
  # the fallback to .result when the delta stream is empty (fix round 1, F7).
  nodelta)    res success false completed 0.0123 "reply via .result, no deltas arrived";;
  # memblock: the result text is read verbatim from $CLAUDE_RESULT_FILE and JSON-encoded by
  # jq, so a test can hand over a reply containing a fenced mows-memory block (newlines,
  # backticks) without fighting the single-quoted interpolation res() uses. memblockbudget is
  # the same text under a budget_exceeded result — memory must be stored whatever the state.
  memblock)   jq -nc --arg sid "$sid" --rawfile r "${CLAUDE_RESULT_FILE:-/dev/null}" \
                '{type:"result",subtype:"success",is_error:false,terminal_reason:"completed",num_turns:2,session_id:$sid,total_cost_usd:0.0123,permission_denials:[],result:$r}';;
  memblockbudget) jq -nc --arg sid "$sid" --rawfile r "${CLAUDE_RESULT_FILE:-/dev/null}" \
                '{type:"result",subtype:"error_max_budget_usd",is_error:true,terminal_reason:"budget_exceeded",num_turns:2,session_id:$sid,total_cost_usd:1.5,permission_denials:[],result:$r}';;
esac
S
chmod +x "$T"/shim/*

# mkagent <file> [yaml-overrides...]: a valid agent file; each override is a full YAML line
# appended AFTER the base block (later keys win in PyYAML only for top-level scalars, so
# overrides that target nested keys are passed as whole blocks via mkagent_raw instead)
mkagent(){
  local f=$1; shift
  local name; name=$(basename "${f%.md}")
  {
    echo '---'
    echo "name: $name"
    echo "description: test agent"
    echo "model: sonnet"
    echo "tools: [Read, Grep]"
    echo "disallowedTools: [Write, Edit, WebFetch]"
    echo "maxTurns: 40"
    echo "memory: user"
    for l in "$@"; do echo "$l"; done
    echo '---'
    echo "You are a test agent."
  } > "$f"
}
MOWS_BLOCK_OK=$(cat <<EOF
mows:
  profile: default
  workdir: $T/work
  task: do the thing
  budget: { usd_per_run: 1.5, max_turns: 40 }
EOF
)

echo "### lint matrix"
A="$HOME/.claude/agents"
mkagent "$A/good.md" "$MOWS_BLOCK_OK"
chk "lint: valid agent passes"            'mows-agent lint good'
# The two turn limits in one agent file: `maxTurns` (which the CLI reads) and mows.budget.max_turns
# (which mows-agent passes as --max-turns). Measured: the flag binds, so a disagreeing maxTurns is a
# cap the operator believes in and does not have. Until now this validator range-checked each and
# compared them never, and the dashboard's capability panel was the only place the contradiction
# surfaced at all -- which meant an agent nobody opened there kept it forever.
mkagent "$A/turnclash.md" "$(sed 's/budget: .*/budget: { usd_per_run: 1.5, max_turns: 5 }/' <<<"$MOWS_BLOCK_OK")"
chk "lint: contradictory turn limits rejected" '! mows-agent lint turnclash && mows-agent lint turnclash 2>&1 | grep -q "disagree"'
chk "lint: matching turn limits accepted"      'mows-agent lint good'
chk "lint: json subcommand emits name"    '[ "$(mows-agent-meta json "$A/good.md" | jq -r .name)" = good ]'
mkagent "$A/badname.md" "$MOWS_BLOCK_OK"; sed -i 's/^name: badname/name: other/' "$A/badname.md"
chk "lint: name != stem is an error"      'mows-agent lint badname 2>&1 | grep -q "name must equal"'
mkagent "$A/nomows.md"
chk "lint: missing mows block"            'mows-agent lint nomows 2>&1 | grep -q "mows: block is required"'
mkagent "$A/badturns.md" "$MOWS_BLOCK_OK"; sed -i 's/^maxTurns: 40/maxTurns: "abc"/' "$A/badturns.md"
chk "lint: maxTurns string is an error"   'mows-agent lint badturns 2>&1 | grep -q "maxTurns must be"'
mkagent "$A/badmem.md" "$MOWS_BLOCK_OK"; sed -i 's/^memory: user/memory: nonsense/' "$A/badmem.md"
chk "lint: memory enum"                   'mows-agent lint badmem 2>&1 | grep -q "memory must be"'
mkagent "$A/bypass.md" "$MOWS_BLOCK_OK" "permissionMode: bypassPermissions"
chk "lint: bypassPermissions forbidden"   'mows-agent lint bypass 2>&1 | grep -q "bypassPermissions is forbidden"'
mkagent "$A/unknownkey.md" "$(printf '%s\n  bogus_key: 1' "$MOWS_BLOCK_OK")"
chk "lint: unknown mows key"              'mows-agent lint unknownkey 2>&1 | grep -q "mows.bogus_key: unknown key"'
mkagent "$A/badprofile.md" "$(sed 's/profile: default/profile: nope/' <<<"$MOWS_BLOCK_OK")"
chk "lint: unknown profile"               'mows-agent lint badprofile 2>&1 | grep -q "not a known profile"'
mkagent "$A/badwd.md" "$(sed "s|workdir: .*|workdir: $T/missing|" <<<"$MOWS_BLOCK_OK")"
chk "lint: missing workdir"               'mows-agent lint badwd 2>&1 | grep -q "workdir does not exist"'
mkagent "$A/nobudget.md" "$(sed '/budget:/d' <<<"$MOWS_BLOCK_OK")"
chk "lint: budget required"               'mows-agent lint nobudget 2>&1 | grep -q "mows.budget is required"'
mkagent "$A/badcron.md" "$(printf '%s\n  triggers: [{type: cron, spec: bogus}]' "$MOWS_BLOCK_OK")"
chk "lint: invalid OnCalendar spec"       'mows-agent lint badcron 2>&1 | grep -q "not valid OnCalendar"'
mkagent "$A/goodcron.md" "$(printf '%s\n  triggers: [{type: cron, spec: "*-*-* 06:00:00"}]' "$MOWS_BLOCK_OK")"
chk "lint: valid cron passes"             'mows-agent lint goodcron'
mkagent "$A/relpath.md" "$(printf '%s\n  triggers: [{type: path, path: relative/x}]' "$MOWS_BLOCK_OK")"
chk "lint: relative path trigger"         'mows-agent lint relpath 2>&1 | grep -q "must be an absolute path"'
mkagent "$A/prro.md" "$(printf '%s\n  merge: {policy: pr}' "$MOWS_BLOCK_OK")"
chk "lint: pr policy on read-only agent"  'mows-agent lint prro 2>&1 | grep -q "nothing to merge"'
# ---- how a tools: list is READ, both ways it can be written (Task 9 fix round 1) -------------
# as_list's two branches disagreed: the string form stripped and the list form did not, and the
# list form also handed whatever YAML produced straight through. Two consequences, both measured.
#
# (1) A STRAY COLON. `- Bash:` instead of `- Bash` is an ordinary typo and parses as a MAPPING.
# `set(tools)` on the can_write line then raised an unhandled TypeError: unhashable type: 'dict',
# so the operator got a Python traceback out of the one tool whose whole job is explaining what is
# wrong with their file. Note it takes BOTH halves to reach: the `or` short-circuits unless the
# deny list contains Write AND Edit, which mkagent's base block does — and which the repo's own
# example agent does too, so this was the normal shape, not an exotic one. It failed CLOSED
# (mows-agent refuses the run on a non-zero lint), which is why this is robustness and not safety.
mkagent "$A/toolmap.md" "$MOWS_BLOCK_OK"
sed -i 's/^tools: \[Read, Grep\]$/tools:\n  - Read\n  - Bash:/' "$A/toolmap.md"
chk "lint: a mapping inside tools: is a lint ERROR, not a traceback" \
  '! mows-agent lint toolmap && mows-agent lint toolmap 2>&1 | grep -q "tools must be a list or comma-separated string"'
chk "lint: and the operator never sees a Python traceback for it" \
  '! mows-agent lint toolmap 2>&1 | grep -q "Traceback (most recent call last)"'
# (2) A TRAILING SPACE. `tools: [Read, "Bash "]` and `tools: "Read, Bash "` are the same
# declaration to anyone reading the file, and only the second used to be recognised: the first
# slipped past WRITE_CAPABLE_TOOLS and the agent linted as read-only, which is the permissive
# direction. Observed through the read-only warning, which is what can_write feeds.
mkagent "$A/padlist.md" "$(printf '%s\n  merge: {policy: pr}' "$MOWS_BLOCK_OK")"
sed -i 's/^tools: \[Read, Grep\]$/tools: [Read, "Bash "]/' "$A/padlist.md"
chk "lint: a padded tool name in a LIST is still read as the tool" \
  '! mows-agent lint padlist 2>&1 | grep -q "nothing to merge"'
mkagent "$A/padstr.md" "$(printf '%s\n  merge: {policy: pr}' "$MOWS_BLOCK_OK")"
sed -i 's/^tools: \[Read, Grep\]$/tools: "Read, Bash "/' "$A/padstr.md"
chk "lint: ...and the comma-string form of that same declaration agrees with it" \
  '! mows-agent lint padstr 2>&1 | grep -q "nothing to merge"'
# The control that keeps the pair above honest: a genuinely read-only agent must STILL warn, or
# all three would pass with can_write hard-wired true.
chk "lint: a genuinely read-only agent still warns (the control for the two above)" \
  'mows-agent lint prro 2>&1 | grep -q "nothing to merge"'
# ---- an ABSENT tools: key inherits everything, including Bash (Task 9 round 2, review F4) -----
# as_list(None) is [] for an absent key and for `tools: null` alike, so `set(tools or [])` was
# empty and can_write said "read-only" about an agent that inherits the shell. Two agents with
# identical capability got opposite verdicts, and the flattering one went to the file that says
# the least. The consequence is not cosmetic: it SUPPRESSED the warning below, which is about an
# untrusted external trigger on an agent that can run shell commands.
#
# Asserted through both consumers of can_write, because they fail in opposite directions: the
# webhook warning fails OPEN (silence about a real risk) and merge.policy: pr fails CLOSED (a
# spurious error). A fix that only moved one of them would look right from the other.
mkagent "$A/inheritwh.md" "$(printf '%s\n  triggers: [{type: webhook}]' "$MOWS_BLOCK_OK")"
sed -i '/^tools: \[Read, Grep\]$/d' "$A/inheritwh.md"
sed -i 's/^disallowedTools: .*/disallowedTools: [Write, Edit]/' "$A/inheritwh.md"
chk "lint: an agent with NO tools: key inherits Bash, so a webhook on it WARNs" \
  'mows-agent lint inheritwh 2>&1 | grep -q "webhook trigger"'
# ...and the control that keeps that honest: the same file with an explicit, genuinely read-only
# list must stay silent, or the assertion above would pass with the warning hard-wired on.
mkagent "$A/explicitwh.md" "$(printf '%s\n  triggers: [{type: webhook}]' "$MOWS_BLOCK_OK")"
sed -i 's/^disallowedTools: .*/disallowedTools: [Write, Edit]/' "$A/explicitwh.md"
chk "lint: ...while an explicit read-only list on the same trigger stays silent" \
  '! mows-agent lint explicitwh 2>&1 | grep -q "webhook trigger"'
# The other consumer, in the direction that fails closed: an inheriting agent has something to
# merge, so merge.policy: pr must not be refused for having nothing to write.
mkagent "$A/inheritpr.md" "$(printf '%s\n  merge: {policy: pr}' "$MOWS_BLOCK_OK")"
sed -i '/^tools: \[Read, Grep\]$/d' "$A/inheritpr.md"
sed -i 's/^disallowedTools: .*/disallowedTools: [Write, Edit]/' "$A/inheritpr.md"
chk "lint: an inheriting agent is not told it has nothing to merge" \
  '! mows-agent lint inheritpr 2>&1 | grep -q "nothing to merge"'
# `tools: null` is the same state written out longhand, and must read the same way.
mkagent "$A/nulltools.md" "$(printf '%s\n  triggers: [{type: webhook}]' "$MOWS_BLOCK_OK")"
sed -i 's/^tools: \[Read, Grep\]$/tools: null/' "$A/nulltools.md"
sed -i 's/^disallowedTools: .*/disallowedTools: [Write, Edit]/' "$A/nulltools.md"
chk "lint: an explicit tools: null reads as inheritance, exactly as an absent key does" \
  'mows-agent lint nulltools 2>&1 | grep -q "webhook trigger"'
mkagent "$A/trifecta.md" "$(printf '%s\n  triggers: [{type: webhook}]' "$MOWS_BLOCK_OK")"; sed -i 's/^disallowedTools: .*/disallowedTools: [WebFetch]/' "$A/trifecta.md"
chk "lint: webhook + write tools WARNs"   'mows-agent lint trifecta 2>&1 | grep -q "WARN: webhook trigger"'
chk "lint: WARN alone still exits 0"      'mows-agent lint trifecta'
mkagent "$A/badesc.md" "$(printf '%s\n  escalate: {via: pigeon}' "$MOWS_BLOCK_OK")"
chk "lint: escalate.via enum"             'mows-agent lint badesc 2>&1 | grep -q "escalate.via must be"'
mkagent "$HOME/.claude-work/agents/good.md" "$(sed 's/profile: default/profile: work/' <<<"$MOWS_BLOCK_OK")"
chk "lint: duplicate name across profiles dies" 'mows-agent lint good 2>&1 | grep -q "more than one profile"'
rm "$HOME/.claude-work/agents/good.md"
# regression: a profile dir symlinked to another profile's agents/ dir (a legitimate setup
# — e.g. two accounts sharing one agents directory) resolves to the SAME physical file and
# must be treated as one agent, not a duplicate; only genuinely distinct files sharing a
# name across profiles (asserted above) are a real duplicate. Restore the real directory
# afterward — later sections expect $HOME/.claude-work/agents to exist as its own dir.
rm -rf "$HOME/.claude-work/agents"
ln -s "$A" "$HOME/.claude-work/agents"
chk "lint: symlinked profile dir is not a duplicate" 'mows-agent lint good'
rm "$HOME/.claude-work/agents"
mkdir -p "$HOME/.claude-work/agents"
chk "lint --all reports each agent"       'mows-agent lint --all 2>&1 | grep -q "== good"'
chk "lint --all exits 1 with any error"   '! mows-agent lint --all'
rm "$A"/{badname,nomows,badturns,badmem,bypass,unknownkey,badprofile,badwd,nobudget,badcron,relpath,prro,trifecta,badesc}.md

echo "### run: state table"
S="$MOWS_AGENTS_STATE/good"
echo ok > "$CLAUDE_MODE_FILE"
mows-agent run good >/dev/null 2>&1; RC=$?
chk "run ok: exit 0"                          '[ "$RC" = 0 ]'
chk "run ok: status.json state=done"          '[ "$(jq -r .state "$S/last/status.json")" = done ]'
chk "run ok: result.json saved verbatim"      '[ "$(jq -r .result "$S/last/result.json")" = "stub says OK" ]'
chk "run ok: cost copied from result"         '[ "$(jq -r .cost_usd "$S/last/status.json")" = 0.0123 ]'
chk "run ok: turns from result"               '[ "$(jq -r .turns "$S/last/status.json")" = 2 ]'
chk "run ok: tool_calls counted"              '[ "$(jq -r .tool_calls "$S/last/status.json")" = 1 ]'
chk "run ok: session_id captured"             '[ "$(jq -r .session_id "$S/last/status.json")" = 00000000-0000-4000-8000-000000000001 ]'
chk "run ok: run_id shape"                    'jq -r .run_id "$S/last/status.json" | grep -qE "^[0-9]{8}-[0-9]{6}-[0-9]+$"'
chk "run ok: last -> runs/<id>"               '[ "$(readlink "$S/last")" = "runs/$(jq -r .run_id "$S/last/status.json")" ]'
chk "run ok: stream.jsonl kept"               'grep -q "\"type\":\"result\"" "$S/last/stream.jsonl"'
chk "run ok: no event on success"             '[ ! -s "$S/events.log" ]'
chk "run ok: no discord post on success"      '[ ! -s "$CURL_LOG" ]'
chk "args: --agent good"                      'grep -qx -- "--agent" "$CLAUDE_ARGS_FILE" && grep -qx good "$CLAUDE_ARGS_FILE"'
chk "args: --permission-prompts none"         'grep -A1 -x -- "--permission-prompts" "$CLAUDE_ARGS_FILE" | grep -qx none'
chk "args: --max-budget-usd 1.5"              'grep -A1 -x -- "--max-budget-usd" "$CLAUDE_ARGS_FILE" | grep -qx 1.5'
chk "args: --max-turns 40"                    'grep -A1 -x -- "--max-turns" "$CLAUDE_ARGS_FILE" | grep -qx 40'
chk "args: --strict-mcp-config, no mcp file"  'grep -qx -- "--strict-mcp-config" "$CLAUDE_ARGS_FILE" && ! grep -qx -- "--mcp-config" "$CLAUDE_ARGS_FILE"'
chk "args: never --dangerously-skip"          '! grep -q dangerously "$CLAUDE_ARGS_FILE"'
chk "args: task is the manifest task"         'grep -qx "do the thing" "$CLAUDE_ARGS_FILE"'
chk "args: run context appended"              'grep -q "run_id:" "$CLAUDE_ARGS_FILE" && grep -q "never ask questions" "$CLAUDE_ARGS_FILE"'
chk "env: CLAUDE_CONFIG_DIR = profile dir"    'grep -qx "CLAUDE_CONFIG_DIR=$HOME/.claude" "$CLAUDE_ARGS_FILE"'
chk "env: cwd = workdir"                      'grep -qx "PWD=$T/work" "$CLAUDE_ARGS_FILE"'
mows-agent run good "custom task text" >/dev/null 2>&1
chk "args: CLI task overrides manifest"       'grep -qx "custom task text" "$CLAUDE_ARGS_FILE"'
chk "run context names previous run"          'grep -q "previous run:" "$CLAUDE_ARGS_FILE"'

echo budget > "$CLAUDE_MODE_FILE"; mows-agent run good >/dev/null 2>&1; RC=$?
chk "run budget: exit 4"                      '[ "$RC" = 4 ]'
chk "run budget: state budget_exceeded"       '[ "$(jq -r .state "$S/last/status.json")" = budget_exceeded ]'
chk "run budget: event logged"                'grep -q budget_exceeded "$S/events.log"'
chk "run budget: no discord (via unset)"      '[ ! -s "$CURL_LOG" ]'
echo maxturns > "$CLAUDE_MODE_FILE"; mows-agent run good >/dev/null 2>&1; RC=$?
chk "run maxturns: exit 3 failed"             '[ "$RC" = 3 ] && [ "$(jq -r .state "$S/last/status.json")" = failed ]'
echo error > "$CLAUDE_MODE_FILE"; mows-agent run good >/dev/null 2>&1; RC=$?
chk "run api error: exit 3 failed"            '[ "$RC" = 3 ] && [ "$(jq -r .state "$S/last/status.json")" = failed ]'
echo noresult > "$CLAUDE_MODE_FILE"; mows-agent run good >/dev/null 2>&1; RC=$?
chk "run no result record: exit 3 failed"     '[ "$RC" = 3 ] && [ "$(jq -r .state "$S/last/status.json")" = failed ]'
chk "run no result: no result.json"           '[ ! -f "$S/last/result.json" ]'
echo hang > "$CLAUDE_MODE_FILE"; T0=$(date +%s); mows-agent run good >/dev/null 2>&1; RC=$?; T1=$(date +%s)
chk "run hang: exit 5 stalled"                '[ "$RC" = 5 ] && [ "$(jq -r .state "$S/last/status.json")" = stalled ]'
chk "run hang: killed within 15s"             '[ $((T1 - T0)) -lt 15 ]'
# the `||` this replaced let the check pass whether or not the leak existed: its second half
# (pgrep -P against the ORIGINAL claude_pid) still "passes" once that pid is dead and its
# child got reparented to init, since pgrep -P no longer finds it as a child of that pid
# either way — non-discriminating either direction. A single system-wide check for the
# stub's own "sleep 3600" is what actually distinguishes a leaked child from a fully killed
# process group.
chk "run hang: no leftover sleep"             '! pgrep -f "sleep 3600" -u "$(id -u)" >/dev/null'
echo ok > "$CLAUDE_MODE_FILE"

echo "### run: escalation via discord"
mkagent "$A/loud.md" "$(printf '%s\n  escalate: {via: discord}' "$MOWS_BLOCK_OK")"
echo budget > "$CLAUDE_MODE_FILE"; mows-agent run loud >/dev/null 2>&1
chk "discord: exactly one post"               '[ "$(wc -l < "$CURL_LOG")" = 1 ]'
chk "discord: names agent + state"            'grep -q "loud" "$CURL_LOG" && grep -q budget_exceeded "$CURL_LOG"'
echo ok > "$CLAUDE_MODE_FILE"; : > "$CURL_LOG"

echo "### run: refusals"
mkagent "$A/broken.md" "$MOWS_BLOCK_OK"; sed -i 's/^maxTurns: 40/maxTurns: "abc"/' "$A/broken.md"
mows-agent run broken >/dev/null 2>&1; RC=$?
chk "refuse: lint error -> exit 6, no run dir" '[ "$RC" = 6 ] && [ ! -d "$MOWS_AGENTS_STATE/broken/runs" ]'
# a lint refusal happens before the manifest is ever read, so escalate.via is unknowable;
# DISCORD_WEBHOOK is set globally for this whole suite (top of file), which is exactly the
# case a lint-error refusal should still notify on (fix round 2, finding 7).
chk "refuse: lint error still posts to discord" 'grep -q broken "$CURL_LOG" && grep -q "lint errors" "$CURL_LOG"'
: > "$CURL_LOG"
chk "refuse: no agent named -> 64"             'mows-agent run nosuch >/dev/null 2>&1; [ $? = 64 ]'

echo "### list / last / logs"
echo ok > "$CLAUDE_MODE_FILE"; mows-agent run good >/dev/null 2>&1
chk "list: header"                            'mows-agent list | head -1 | grep -q "^NAME"'
chk "list: good row with state done"          'mows-agent list | grep -E "^good +default +done"'
chk "list: loud row shows budget_exceeded"    'mows-agent list | grep -E "^loud +default +budget_exceeded"'
chk "list: NEXT from systemctl list-timers"   'mows-agent list | grep -E "^good" | grep -q "2026-09-16"'
chk "last: prints state + cost"               'mows-agent last good | grep -q "\"state\": \"done\"" && mows-agent last good | grep -q "stub says OK"'
chk "logs: assistant text only"               '[ "$(mows-agent logs good)" = "stub says OK" ]'
chk "logs --raw: the stream"                  'mows-agent logs good --raw | grep -q "\"type\":\"system\""'
chk "logs <run_id>: explicit run"             '[ "$(mows-agent logs good "$(jq -r .run_id "$S/last/status.json")")" = "stub says OK" ]'

echo "### budget tiers + concurrency + prune"
mkagent "$A/capped.md" "$(sed 's/budget: .*/budget: { usd_per_run: 1.5, max_turns: 40, usd_per_day: 0.01, quota_floor: 30 }/' <<<"$MOWS_BLOCK_OK")"
echo '{"personal":{"five_hour_pct":10,"weekly_pct":5},"work":{"five_hour_pct":90,"weekly_pct":5}}' > "$QUOTA_FILE"
echo ok > "$CLAUDE_MODE_FILE"
# stub run costs 0.0123; cap 0.01 -> run 1 allowed (spend was 0), run 2 refused (0.0123 >= 0.01)
chk "cap: first run allowed (spend was 0)"    'mows-agent run capped'
chk "cap: second run refused, exit 6"         'mows-agent run capped >/dev/null 2>&1; [ $? = 6 ]'
chk "cap: refusal logged"                     'grep -q "daily cap" "$MOWS_AGENTS_STATE/capped/events.log"'
chk "cap: refusal made no second run dir"     '[ "$(ls "$MOWS_AGENTS_STATE/capped/runs" | wc -l)" = 1 ]'
echo '{"personal":{"five_hour_pct":75,"weekly_pct":5}}' > "$QUOTA_FILE"
mkagent "$A/floored.md" "$(sed 's/budget: .*/budget: { usd_per_run: 1.5, max_turns: 40, quota_floor: 30 }/' <<<"$MOWS_BLOCK_OK")"
mows-agent run floored >/dev/null 2>&1; RC=$?
chk "quota: 75% used > 70% ceiling -> refuse 6" '[ "$RC" = 6 ] && grep -q "quota below 30%" "$MOWS_AGENTS_STATE/floored/events.log"'
echo '{"personal":{"five_hour_pct":60,"weekly_pct":5}}' > "$QUOTA_FILE"
chk "quota: 60% used passes floor 30"         'mows-agent run floored'
echo '{"personal":{"five_hour_pct":null,"weekly_pct":null,"source":"unknown"}}' > "$QUOTA_FILE"
chk "quota: unknown never refuses"            'mows-agent run floored'
# max_turns matches mkagent's own `maxTurns: 40`: mows-agent-meta now ERRORS when the two turn
# limits in one file disagree, because only the mows one binds (measured) and the Claude-namespace
# one silently does nothing. This fixture used to carry 5 against 40 and so tripped the new rule.
mkagent "$HOME/.claude-work/agents/wk.md" "$(sed 's/profile: default/profile: work/; s/budget: .*/budget: { usd_per_run: 1, max_turns: 40, quota_floor: 30 }/' <<<"$MOWS_BLOCK_OK")"
echo '{"personal":{"five_hour_pct":0},"work":{"five_hour_pct":95}}' > "$QUOTA_FILE"
chk "quota: work profile reads .work"         'mows-agent run wk >/dev/null 2>&1; [ $? = 6 ]'
chk "quota: work profile CLAUDE_CONFIG_DIR"   'echo "{}" > "$QUOTA_FILE"; mows-agent run wk && grep -qx "CLAUDE_CONFIG_DIR=$HOME/.claude-work" "$CLAUDE_ARGS_FILE"'
# concurrency: a live `working` record with a real pid refuses a second run
sleep 300 & SP=$!
mkdir -p "$MOWS_AGENTS_STATE/good/runs/fake"; ln -sfn runs/fake "$MOWS_AGENTS_STATE/good/last"
jq -n --argjson p "$SP" '{state:"working",pid:$p}' > "$MOWS_AGENTS_STATE/good/runs/fake/status.json"
mows-agent run good >/dev/null 2>&1; RC=$?
chk "concurrency: live working run refuses"   '[ "$RC" = 6 ] && grep -q "still working" "$MOWS_AGENTS_STATE/good/events.log"'
kill $SP; wait $SP 2>/dev/null
chk "concurrency: dead pid does not block"    'mows-agent run good'
rm -rf "$MOWS_AGENTS_STATE/good/runs/fake"
# prune
mkagent "$A/short.md" "$(printf '%s\n  retention_days: 5' "$MOWS_BLOCK_OK")"
mows-agent run short >/dev/null 2>&1
# age the `last` target itself past retention so the delete-candidate set actually includes
# it -- otherwise the exemption in cmd_prune is never exercised (it would "pass" even if
# the exemption were deleted, since a fresh run dir is never a delete candidate anyway).
touch -d '40 days ago' "$MOWS_AGENTS_STATE/short/$(readlink "$MOWS_AGENTS_STATE/short/last")"
mkdir -p "$MOWS_AGENTS_STATE/short/runs/20200101-000000-1"; touch -d '40 days ago' "$MOWS_AGENTS_STATE/short/runs/20200101-000000-1"
mkdir -p "$MOWS_AGENTS_STATE/good/runs/20200102-000000-1";  touch -d '20 days ago' "$MOWS_AGENTS_STATE/good/runs/20200102-000000-1"
mows-agent prune >/dev/null 2>&1
chk "prune: 40d-old run gone (retention 5)"   '[ ! -d "$MOWS_AGENTS_STATE/short/runs/20200101-000000-1" ]'
chk "prune: 20d-old run kept (retention 30)"  '[ -d "$MOWS_AGENTS_STATE/good/runs/20200102-000000-1" ]'
chk "prune: last target never pruned"         '[ -d "$MOWS_AGENTS_STATE/short/$(readlink "$MOWS_AGENTS_STATE/short/last")" ]'
rm -rf "$MOWS_AGENTS_STATE/good/runs/20200102-000000-1"

echo "### merge.policy pr"
git init -q "$T/repo" && git -C "$T/repo" -c user.email=t@t -c user.name=t commit -q --allow-empty -m base
git -C "$T/repo" branch -M main; git -C "$T/repo" checkout -q -b agent/fix
git -C "$T/repo" -c user.email=t@t -c user.name=t commit -q --allow-empty -m "agent change"
git init -q --bare "$T/origin.git"; git -C "$T/repo" remote add origin "$T/origin.git"
# mkagent overrides are YAML lines appended after the base block: indent two spaces to land inside mows:
mkagent "$A/prbot.md" "$(sed "s|workdir: .*|workdir: $T/repo|" <<<"$MOWS_BLOCK_OK")" "  merge: { policy: pr, base: main }"
sed -i 's/^disallowedTools: .*/disallowedTools: [WebFetch]/' "$A/prbot.md"
echo ok > "$CLAUDE_MODE_FILE"
chk "pr: lint passes with stub gh"           'mows-agent lint prbot'
chk "pr: run done"                            'mows-agent run prbot'
chk "pr: branch pushed to origin"             'git -C "$T/origin.git" rev-parse --verify agent/fix'
chk "pr: gh pr create --base main called"     'grep -q "pr create --fill --base main" "$GH_LOG"'
chk "pr: event logged"                        'grep -q "PR opened from agent/fix" "$MOWS_AGENTS_STATE/prbot/events.log"'
git -C "$T/repo" checkout -q main
chk "pr: on base branch is a logged no-op"    'mows-agent run prbot && grep -q "still on main" "$MOWS_AGENTS_STATE/prbot/events.log"'
# regression (fix round 2, finding 6): a failed push/PR must not still exit 0. merge_step's
# success path returns via event() (always exit 0) and, before this fix, its failure path
# fell through the same way via escalate() (ALSO always exit 0 — it swallows curl's result)
# -- so `done) merge_step; exit 0;;` could never tell the two apart no matter what the call
# site checked. Break the push by pointing origin somewhere that doesn't exist.
git -C "$T/repo" checkout -q agent/fix
git -C "$T/repo" remote set-url origin "$T/no-such-origin.git"
mows-agent run prbot >/dev/null 2>&1; RC=$?
chk "pr: failed push/PR -> exit 3, not 0"     '[ "$RC" = 3 ]'
chk "pr: failure event logged"                'grep -q "PR creation failed" "$MOWS_AGENTS_STATE/prbot/events.log"'
git -C "$T/repo" remote set-url origin "$T/origin.git"

echo "### render"
export RENDER_DIR="$T/rendered"
mkagent "$A/timed.md" "$(printf '%s\n  triggers:\n    - {type: cron, spec: "*-*-* 06:00:00"}\n    - {type: cron, spec: "Mon *-*-* 09:00:00"}\n    - {type: path, path: %s/work/.git/refs/heads/main}' "$MOWS_BLOCK_OK" "$T")"
chk "render: exits 0"                          'mows-agent render timed'
chk "render: service template once"            'grep -q "^ExecStart=$HOME/.local/bin/mows-agent run %i" "$RENDER_DIR/mows-agent@.service"'
chk "render: service is oneshot as this user"  'grep -q "^Type=oneshot" "$RENDER_DIR/mows-agent@.service" && grep -q "^User=$(id -un)" "$RENDER_DIR/mows-agent@.service"'
chk "render: service unsets API key"           'grep -q "^UnsetEnvironment=ANTHROPIC_API_KEY" "$RENDER_DIR/mows-agent@.service"'
chk "render: TimeoutStartSec = max_turns*3min" 'grep -q "^TimeoutStartSec=7200" "$RENDER_DIR/mows-agent@.service"'
chk "render: first timer"                      'grep -q "^OnCalendar=\*-\*-\* 06:00:00" "$RENDER_DIR/mows-agent-timed.timer" && grep -q "^Persistent=true" "$RENDER_DIR/mows-agent-timed.timer"'
chk "render: second timer suffixed -2"         'grep -q "^OnCalendar=Mon" "$RENDER_DIR/mows-agent-timed-2.timer"'
chk "render: timer points at the instance"     'grep -q "^Unit=mows-agent@timed.service" "$RENDER_DIR/mows-agent-timed.timer"'
chk "render: path unit"                        'grep -q "^PathChanged=$T/work/.git/refs/heads/main" "$RENDER_DIR/mows-agent-timed.path" && grep -q "^Unit=mows-agent@timed.service" "$RENDER_DIR/mows-agent-timed.path"'
chk "render: prints sudo lines, enables nothing" 'mows-agent render timed | grep -q "sudo install" && ! grep -q "enable" "$SYSTEMCTL_LOG"'
chk "render --all covers timed"                'rm -rf "$RENDER_DIR"; mows-agent render --all >/dev/null && [ -f "$RENDER_DIR/mows-agent-timed.timer" ]'
# regression (fix round 2, finding 13): two DIFFERENT agents rendering the SAME unit
# filename must refuse loudly, not silently clobber. "clash"'s SECOND cron trigger and
# "clash-2"'s FIRST (only, so unsuffixed) cron trigger both render mows-agent-clash-2.timer —
# exactly the no-delimiter collision the render naming scheme allows.
mkagent "$A/clash.md" "$(printf '%s\n  triggers:\n    - {type: cron, spec: "*-*-* 06:00:00"}\n    - {type: cron, spec: "Mon *-*-* 09:00:00"}' "$MOWS_BLOCK_OK")"
mkagent "$A/clash-2.md" "$(printf '%s\n  triggers: [{type: cron, spec: "*-*-* 07:00:00"}]' "$MOWS_BLOCK_OK")"
rm -rf "$RENDER_DIR"
mows-agent render --all >/dev/null 2>"$T/render-collide.err"; RC=$?
chk "render: filename collision refused, not exit 0" '[ "$RC" != 0 ]'
chk "render: collision message names both agents"    'grep -q "mows-agent-clash-2.timer" "$T/render-collide.err" && grep -q "clash," "$T/render-collide.err" && grep -q "clash-2" "$T/render-collide.err"'
chk "render: collision writes NOTHING, not even the service template" '[ ! -f "$RENDER_DIR/mows-agent@.service" ] && [ ! -f "$RENDER_DIR/mows-agent-timed.timer" ]'
rm "$A/clash.md" "$A/clash-2.md"

echo "### residents"
export CLAUDE_AGENTS_JSON_FILE="$T/agents.json"
cat > "$CLAUDE_AGENTS_JSON_FILE" <<EOF
[{"id":"a517ab4b","cwd":"$HOME","kind":"background","name":"web harness autocomplete","state":"blocked","waitingFor":"permission prompt","sessionId":"x"},
 {"pid":1,"cwd":"$HOME/.claude-mem/observer-sessions/293","kind":"background","id":"obs1","name":"293-86","state":"working"},
 {"pid":2,"cwd":"$HOME","kind":"interactive","name":"alonso-c0","sessionId":"y"}]
EOF
chk "residents: background record listed"      'mows-agent residents | grep -q "a517ab4b .*blocked .*permission prompt"'
chk "residents: interactive records dropped"   '! mows-agent residents | grep -q alonso-c0'
chk "residents: claude-mem observers dropped"  '! mows-agent residents | grep -q obs1'
chk "residents --json: array per profile"      '[ "$(mows-agent residents --json | jq -r ".[0].profile")" = default ]'
chk "residents: work profile also polled"      '[ "$(mows-agent residents --json | jq length)" = 2 ]'
# regression: a stalled `claude agents --json` must never make the WHOLE residents call run
# unbounded — cmd_residents' per-profile timeout must shrink with the profile count so 2
# hung profiles still finish comfortably inside the dashboard's runAs ceiling (20s).
export CLAUDE_AGENTS_HANG=1
T0=$(date +%s); mows-agent residents --json >"$T/residents-hang.json" 2>&1; RC=$?; T1=$(date +%s)
chk "residents: bounded total time despite a hung claude" '[ $((T1 - T0)) -lt 18 ]'
chk "residents: still valid JSON when every profile hangs" '[ "$(jq length < "$T/residents-hang.json")" = 2 ] && [ "$(jq "[.[].agents[]] | length" < "$T/residents-hang.json")" = 0 ]'
unset CLAUDE_AGENTS_HANG

echo "### chat --stream"
echo ok > "$CLAUDE_MODE_FILE"
mows-agent run good >/dev/null 2>&1 || true
cp "$CLAUDE_ARGS_FILE" "$T/run-args.txt"
chk "runs never pass --include-partial-messages" '! grep -q "include-partial-messages" "$T/run-args.txt"'
chk "chat --stream emits seq deltas"   'mows-agent chat good --stream "hi" 2>/dev/null | grep -q "\"seq\":"'
chk "chat --stream ends with end line" 'mows-agent chat good --stream "hi" 2>/dev/null | tail -1 | jq -e ".end == true"'
chk "chat --stream passes the flag"    'grep -q "include-partial-messages" "$CLAUDE_ARGS_FILE"'
# F1 (fix round 1): a delta that is purely a paragraph break, and one that ends on a
# newline, must both survive into the persisted transcript — this is the exact shape that
# a plain `$(jq -r …)` extraction silently destroys (dropped entirely / trailing \n lost).
mows-agent chat good --stream "hi" >/dev/null 2>&1
chk "chat --stream preserves newline-bearing deltas in the transcript" \
  'grep -qF "stub says OK\n\nSecond paragraph.\n" "$MOWS_AGENTS_STATE/good/chat.jsonl"'
echo badtext > "$CLAUDE_MODE_FILE"
chk "chat --stream fails loudly on plain-text notice" 'mows-agent chat good --stream "hi" >/dev/null 2>&1; [ $? = 64 ]'
chk "chat --stream logs role:error"    'tail -1 "$MOWS_AGENTS_STATE/good/chat.jsonl" | jq -e ".role == \"error\""'
# F3 (fix round 1): the failure path's fourth obligation — an `end` line carrying
# is_error:true — is the only viewer-visible effect of a failed streaming turn. Deleting it
# left the suite green before this assertion existed.
chk "chat --stream failure end line carries is_error:true" \
  'mows-agent chat good --stream "hi" 2>/dev/null | tail -1 | jq -e ".end == true and .is_error == true"'
# F4 (fix round 1): `crashafter` isolates the `rc` half of `[ "$rc" != 0 ] || [ "$sawres" =
# 0 ]` specifically — it emits a result record (sawres=1) and then exits 1, the one shape
# where `sawres` alone would report success. The `hang` timeout test below does NOT isolate
# the __mows_rc= sentinel the way an earlier version of this comment claimed: `hang` never
# emits a result record, so `sawres=0` already fails it on its own, with or without the
# sentinel working (re-review round 1, R1 — confirmed by mutation: both halves of the
# condition, tested independently, leave this assertion passing). What it DOES prove is that
# a real `timeout` kill surfaces as exit 64 within the harness's own bound rather than
# hanging or misreporting success — and, per the implementer's own F4b mutation, that removing
# `timeout` from the invocation entirely makes this specific assertion fail (the outer
# `timeout 10` safety net then kills `mows-agent` itself, for a non-64 exit).
echo crashafter > "$CLAUDE_MODE_FILE"
chk "chat --stream fails when claude exits non-zero despite a result record" \
  'mows-agent chat good --stream "hi" >/dev/null 2>&1; [ $? = 64 ]'
echo hang > "$CLAUDE_MODE_FILE"
chk "chat --stream real timeout kill surfaces as exit 64, not a hang" \
  'CHAT_TIMEOUT_SEC=1 timeout 10 mows-agent chat good --stream "hi" >/dev/null 2>&1; [ $? = 64 ]'
# F7 / R2 (fix round 1 / re-review round 1): a turn that succeeds with no deltas at all must
# still persist real text, via the .result fallback, not a silent empty "success".
echo nodelta > "$CLAUDE_MODE_FILE"
mows-agent chat good --stream "hi" >/dev/null 2>&1
chk "chat --stream falls back to .result when no deltas arrive" \
  'tail -1 "$MOWS_AGENTS_STATE/good/chat.jsonl" | jq -e ".text == \"reply via .result, no deltas arrived\""'
echo ok > "$CLAUDE_MODE_FILE"

echo "### memory: store_memory via run (spec 2026-09-19 D2/D5, §3)"
M="$MOWS_AGENTS_STATE/good/memory.md"
memrun(){ printf '%s' "$1" > "$CLAUDE_RESULT_FILE"; echo memblock > "$CLAUDE_MODE_FILE"; mows-agent run good >/dev/null 2>&1; }
rm -f "$M"
memrun $'Report done.\n\n```mows-memory\nnewest: abc123\nopen: none\n```\n'
chk "memory: block stored as the file body"     '[ "$(cat "$M")" = "$(printf "newest: abc123\nopen: none")" ]'
chk "memory: stored event written"              'grep -q "memory stored: " "$MOWS_AGENTS_STATE/good/events.log"'
memrun $'Done.\n```mows-memory\nnewest: def456\n```\n'
chk "memory: second block replaces, not appends" '[ "$(cat "$M")" = "newest: def456" ]'
cp "$M" "$T/mem-before"; E0=$(grep -c "memory" "$MOWS_AGENTS_STATE/good/events.log")
memrun $'Nothing to remember this time.\n'
chk "memory: no block leaves the file byte-identical" 'cmp -s "$M" "$T/mem-before"'
chk "memory: no block writes no memory event"   '[ "$(grep -c "memory" "$MOWS_AGENTS_STATE/good/events.log")" = "$E0" ]'
memrun $'Forget it.\n```mows-memory\n```\n'
chk "memory: empty block clears the file"       '[ -f "$M" ] && [ ! -s "$M" ]'
chk "memory: clear is logged"                   'grep -q "memory cleared by agent" "$MOWS_AGENTS_STATE/good/events.log"'
memrun $'My memory was:\n```mows-memory\nold: 1\n```\nNow updated:\n```mows-memory\nnew: 2\n```\n'
chk "memory: the LAST block wins"               '[ "$(cat "$M")" = "new: 2" ]'
memrun $'Quoting a doc:\n````\n```mows-memory\nnot me\n```\n````\n```mows-memory\nreal: yes\n```\n'
chk "memory: a fence inside a wider fence is not the match" '[ "$(cat "$M")" = "real: yes" ]'
memrun $'```mows-memory\nreal: yes\n```\nLater I wrote ```mows-memory-notes``` too.\n'
chk "memory: info string must be exact, not a prefix" '[ "$(cat "$M")" = "real: yes" ]'
# 80 lines × 51 bytes = 4080 B: under the byte cap, so the LINE cap is what bites.
big=$(python3 -c 'print("\n".join("line %03d: " % i + "x"*40 for i in range(80)))')
memrun "$(printf '```mows-memory\n%s\n```\n' "$big")"
chk "memory: 80 lines capped to 60"             '[ "$(wc -l < "$M")" = 60 ]'
chk "memory: cap event names both offered and cap" 'grep -q "memory truncated: .* bytes / 80 lines offered, cap 4096/60" "$MOWS_AGENTS_STATE/good/events.log"'
# 50 lines × 125 bytes = 6250 B: under the line cap, so the BYTE cap is what bites (32 lines = 4000 B).
wide=$(python3 -c 'print("\n".join("w%02d " % i + "y"*120 for i in range(50)))')
memrun "$(printf '```mows-memory\n%s\n```\n' "$wide")"
chk "memory: 6250 B capped under 4096 B"        '[ "$(wc -c < "$M")" -le 4096 ]'
chk "memory: byte cap cuts at a line boundary"  '[ "$(wc -l < "$M")" = 32 ] && tail -1 "$M" | grep -qE "^w[0-9]{2} y{120}$"'
chk "memory: no .tmp left behind"               '[ ! -e "$M.tmp" ]'
printf '%s' $'```mows-memory\nstored despite budget_exceeded\n```\n' > "$CLAUDE_RESULT_FILE"
echo memblockbudget > "$CLAUDE_MODE_FILE"; mows-agent run good >/dev/null 2>&1
chk "memory: stored even when the run ends budget_exceeded" '[ "$(cat "$M")" = "stored despite budget_exceeded" ] && [ "$(jq -r .state "$MOWS_AGENTS_STATE/good/last/status.json")" = budget_exceeded ]'
echo ok > "$CLAUDE_MODE_FILE"

echo "### memory: injected into run_context (spec §2.1, §2.2)"
printf 'newest: abc123\nopen: one thing\n' > "$M"
echo ok > "$CLAUDE_MODE_FILE"; mows-agent run good >/dev/null 2>&1
chk "run: appended prompt has the memory heading"     'grep -qx "## Your memory" "$CLAUDE_ARGS_FILE"'
chk "run: appended prompt carries memory.md verbatim" 'grep -qx "newest: abc123" "$CLAUDE_ARGS_FILE" && grep -qx "open: one thing" "$CLAUDE_ARGS_FILE"'
chk "run: appended prompt carries the write-back instruction" 'grep -qx "## Updating your memory" "$CLAUDE_ARGS_FILE" && grep -qF "\`\`\`mows-memory" "$CLAUDE_ARGS_FILE"'
chk "run: memory comes before the no-human line"      '[ "$(grep -nx "## Your memory" "$CLAUDE_ARGS_FILE" | cut -d: -f1)" -lt "$(grep -n "no human available" "$CLAUDE_ARGS_FILE" | cut -d: -f1)" ]'
chk "run: the no-human line is still there"           'grep -q "You have no human available" "$CLAUDE_ARGS_FILE"'
chk "run: previous-result line survives"              'grep -q "^- previous result: " "$CLAUDE_ARGS_FILE"'
rm -f "$M"; mows-agent run good >/dev/null 2>&1
chk "run: absent memory is stated as none"            'grep -qx "(none — this is your first call, or memory was never recorded)" "$CLAUDE_ARGS_FILE"'
: > "$M"; mows-agent run good >/dev/null 2>&1
chk "run: empty (cleared) memory reads as none too"   'grep -q "^(none — this is your first call" "$CLAUDE_ARGS_FILE"'
rm -f "$M"

echo "### dashboard chat stream (Step 4 JS, no server/spawn needed — F2/F10)"
chk "chat stream: multi-byte UTF-8 boundary and malformed-line handling" \
  'node scripts/chat-stream-utf8-check.mjs'
# Task 7 re-review R1: this sat beside its sibling above for two rounds with no caller anywhere
# in the tree -- the branch's entire XSS regression gate, run only when a human typed the command.
# preflight.sh runs it too (that is what reaches CI); this is the suite-local copy, matching the
# line above exactly.
chk "chat view: hostile replies render inert, ordinary markdown unchanged" \
  'node scripts/chat-view-check.mjs'

echo "### discovery filter agrees with the validator (final review, M3)"
# There are two frontmatter readers: mows-agent's has_mows (awk, the fast discovery filter used by
# all_agents) and mows-agent-meta's frontmatter() (Python + PyYAML, the real parse). Four shapes
# used to diverge, every one of them silently: a file the validator reads as a perfectly good agent
# was dropped by the filter, so `render --all` never generated ITS TIMERS, `lint --all` never
# linted it, `list` never showed it and retention never pruned it -- while `run <name>` worked,
# because agent_file() deliberately does not filter. An agent that silently never fires.
#
# Each shape is asserted through the PUBLIC surface (`mows-agent list`, i.e. through all_agents)
# and against the REAL validator on the same file, so the two cannot drift apart again without a
# red line here. Proved able to fail: restoring the previous one-liner --
#   awk 'NR==1&&$0!="---"{bad=1} NR>1&&$0=="---"{done=1} !done&&NR>1&&/^mows:/{f=1} END{exit !(f&&!bad)}'
# -- turns fm-opensp, fm-opentab and fm-crlf red (the filter drops them, the validator does not)
# and fm-noclose red the other way (the filter sweeps in a file that has no frontmatter at all).
FM="$T/fm"; mkdir -p "$FM"
fm_body(){ printf 'name: %s\nmows:\n  profile: default\n  workdir: %s\n  task: t\n  budget: { usd_per_run: 1, max_turns: 2 }\n' "$1" "$T/work"; }
# opening delimiter with a trailing space, then a tab: mows-agent-meta's regex allows [ \t]* there.
{ printf -- '--- \n'; fm_body fm-opensp; printf -- '---\nbody\n'; } > "$A/fm-opensp.md"
{ printf -- '---\t\n'; fm_body fm-opentab; printf -- '---\nbody\n'; } > "$A/fm-opentab.md"
# CRLF throughout: Python opens in text mode, so it never sees the CR; awk did.
{ printf -- '--- \n'; fm_body fm-crlf; printf -- '---\nbody\n'; } | sed 's/$/\r/' > "$A/fm-crlf.md"
# ...and the divergence in the other direction: an opening delimiter and a mows: line with NO
# closing delimiter is not frontmatter at all to the validator, and must not be swept in.
{ printf -- '---\n'; fm_body fm-noclose; } > "$A/fm-noclose.md"
# R3: two more shapes that went the same silent way -- a QUOTED top-level key and a space before
# the colon are both ordinary YAML that PyYAML reads as a `mows` key, and a bare /^mows:/ matched
# neither.
{ printf -- '---\n'; printf 'name: fm-quoted\n"mows":\n'; printf '  profile: default\n  workdir: %s\n  task: t\n  budget: { usd_per_run: 1, max_turns: 2 }\n' "$T/work"; printf -- '---\nbody\n'; } > "$A/fm-quoted.md"
{ printf -- '---\n'; printf 'name: fm-spacecolon\nmows :\n'; printf '  profile: default\n  workdir: %s\n  task: t\n  budget: { usd_per_run: 1, max_turns: 2 }\n' "$T/work"; printf -- '---\nbody\n'; } > "$A/fm-spacecolon.md"
# ...and the three the pattern must keep REFUSING. Widening a regex trades a false negative for a
# false positive unless you say where the new edge is, so the edge is asserted, not assumed:
# a DIFFERENT key that merely starts with the same letters, a nested `mows:` under another key,
# and the literal text "mows:" inside a quoted string VALUE.
{ printf -- '---\nname: fm-mowsy\nmowsy: 1\n---\nbody\n'; } > "$A/fm-mowsy.md"
{ printf -- '---\nname: fm-nested\nouter:\n  mows: 1\n---\nbody\n'; } > "$A/fm-nested.md"
{ printf -- '---\nname: fm-quotedval\ndesc: "mows: not a key"\n---\nbody\n'; } > "$A/fm-quotedval.md"
for shape in opensp opentab crlf quoted spacecolon; do
  chk "discovery: '$shape' frontmatter reaches \`list\` (the filter does not drop it)" \
    "mows-agent list | grep -qE '^fm-$shape '"
  chk "discovery: '$shape' — and the validator reads a mows: block out of the same file" \
    "mows-agent-meta json \"\$A/fm-$shape.md\" | jq -e 'has(\"mows\")'"
done
# NOT asserted through `list`: cmd_list drops a row whose `meta "$f"` fails (`|| continue`), so a
# list-based check here would be green against BOTH detectors and would be testing that second
# filter, not this one. `lint --all` echoes "== <name>" straight out of all_agents with nothing in
# between, so it is the surface that actually moves when has_mows does.
chk "discovery: no closing delimiter is not frontmatter, and \`lint --all\` does not sweep it in" \
  '! mows-agent lint --all 2>&1 | grep -q "^== fm-noclose$"'
chk "discovery: 'noclose' — and the validator reads no frontmatter out of it either" \
  '! mows-agent-meta json "$A/fm-noclose.md" 2>/dev/null | jq -e "has(\"mows\")" >/dev/null 2>&1'
for shape in mowsy nested quotedval; do
  chk "discovery: '$shape' is NOT a mows agent, and \`lint --all\` does not sweep it in" \
    "! mows-agent lint --all 2>&1 | grep -q '^== fm-$shape\$'"
  chk "discovery: '$shape' — and the validator reads no top-level mows key out of it either" \
    "! mows-agent-meta json \"\$A/fm-$shape.md\" 2>/dev/null | jq -e 'has(\"mows\")' >/dev/null 2>&1"
done
rm -f "$A"/fm-*.md

echo; echo "e2e-agents: $PASS passed, $FAIL failed"
[ "$FAIL" -eq 0 ]
