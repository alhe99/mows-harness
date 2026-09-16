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
export CLAUDE_MODE_FILE="$T/claude-mode" CLAUDE_ARGS_FILE="$T/claude-args" CURL_LOG="$T/curl.log" QUOTA_FILE="$T/quota.json" GH_LOG="$T/gh.log" SYSTEMCTL_LOG="$T/systemctl.log"
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
# (ok|budget|maxturns|error|noresult|hang). argv + CLAUDE_CONFIG_DIR land in $CLAUDE_ARGS_FILE.
[ "${1:-}" = --version ] && { echo "2.1.273 (Claude Code)"; exit 0; }
[ "${1:-}" = agents ] && { cat "${CLAUDE_AGENTS_JSON_FILE:-/dev/null}"; exit 0; }
{ printf '%s\n' "$@"; echo "CLAUDE_CONFIG_DIR=${CLAUDE_CONFIG_DIR:-}"; echo "PWD=$PWD"; } > "${CLAUDE_ARGS_FILE:-/dev/null}"
mode=$(cat "${CLAUDE_MODE_FILE:-/dev/null}" 2>/dev/null || echo ok)
sid=00000000-0000-4000-8000-000000000001
echo '{"type":"system","subtype":"init","session_id":"'$sid'"}'
echo '{"type":"assistant","message":{"role":"assistant","content":[{"type":"tool_use","id":"t1","name":"Read","input":{}}]},"session_id":"'$sid'"}'
echo '{"type":"assistant","message":{"role":"assistant","content":[{"type":"text","text":"stub says OK"}]},"session_id":"'$sid'"}'
res(){ echo '{"type":"result","subtype":"'$1'","is_error":'$2',"terminal_reason":"'$3'","num_turns":2,"session_id":"'$sid'","total_cost_usd":'$4',"permission_denials":[],"result":"'$5'"}'; }
case $mode in
  ok)       res success false completed 0.0123 "stub says OK";;
  budget)   res error_max_budget_usd true budget_exceeded 1.5 "";;
  maxturns) res error_max_turns true max_turns 0.5 "";;
  error)    res success true api_error 0 "Not logged in";;
  noresult) exit 1;;
  hang)     sleep 3600;;
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
chk "run hang: no leftover sleep"             '! pgrep -f "sleep 3600" -u "$(id -u)" >/dev/null || ! pgrep -P "$(jq -r .claude_pid "$S/last/status.json")" >/dev/null'
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
mkagent "$HOME/.claude-work/agents/wk.md" "$(sed 's/profile: default/profile: work/; s/budget: .*/budget: { usd_per_run: 1, max_turns: 5, quota_floor: 30 }/' <<<"$MOWS_BLOCK_OK")"
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
mkdir -p "$MOWS_AGENTS_STATE/short/runs/20200101-000000-1"; touch -d '40 days ago' "$MOWS_AGENTS_STATE/short/runs/20200101-000000-1"
mkdir -p "$MOWS_AGENTS_STATE/good/runs/20200102-000000-1";  touch -d '20 days ago' "$MOWS_AGENTS_STATE/good/runs/20200102-000000-1"
mows-agent prune >/dev/null 2>&1
chk "prune: 40d-old run gone (retention 5)"   '[ ! -d "$MOWS_AGENTS_STATE/short/runs/20200101-000000-1" ]'
chk "prune: 20d-old run kept (retention 30)"  '[ -d "$MOWS_AGENTS_STATE/good/runs/20200102-000000-1" ]'
chk "prune: last target never pruned"         '[ -d "$MOWS_AGENTS_STATE/short/$(readlink "$MOWS_AGENTS_STATE/short/last")" ]'
rm -rf "$MOWS_AGENTS_STATE/good/runs/20200102-000000-1"

echo; echo "e2e-agents: $PASS passed, $FAIL failed"
[ "$FAIL" -eq 0 ]
