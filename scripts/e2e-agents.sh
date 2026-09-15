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
chk "lint --all reports each agent"       'mows-agent lint --all 2>&1 | grep -q "== good"'
chk "lint --all exits 1 with any error"   '! mows-agent lint --all'
rm "$A"/{badname,nomows,badturns,badmem,bypass,unknownkey,badprofile,badwd,nobudget,badcron,relpath,prro,trifecta,badesc}.md

echo; echo "e2e-agents: $PASS passed, $FAIL failed"
[ "$FAIL" -eq 0 ]
