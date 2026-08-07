#!/usr/bin/env bash
# End-to-end container test: fresh ubuntu:24.04, NON-ROOT user, follows the README
# literally (Part 2 steps 1-4) and asserts each documented expectation.
set -u   # NOT pipefail: `cmd | grep -q` SIGPIPEs the writer on match
PASS=0; FAIL=0
ok(){ echo "PASS: $*"; PASS=$((PASS+1)); }
no(){ echo "FAIL: $*"; FAIL=$((FAIL+1)); }
chk(){ if eval "$2" >/dev/null 2>&1; then ok "$1"; else no "$1"; fi; }

echo "### environment"
whoami; id -u; echo "HOME=$HOME"; cd "$HOME"

echo "### README preconditions"
chk "apt-get present"   "command -v apt-get"
chk "systemctl present" "command -v systemctl"
chk "tmux present"      "command -v tmux"
chk "node >= 20"        '[ "$(node -p "process.versions.node.split(\".\")[0]")" -ge 20 ]'

echo "### Part 2 step 1 — clone + self-check"
cp -r /src harness && cd harness
git config --global --add safe.directory "$PWD" 2>/dev/null
chk "preflight ALL CLEAN" "./scripts/preflight.sh | tail -1 | grep -q 'ALL CLEAN'"

echo "### Part 2 step 2 — install (non-root, as a real adopter)"
./install.sh --claude --watchdogs --fleet --non-interactive > /tmp/inst.log 2>&1
chk "install.sh exit 0" "[ $? -eq 0 ]"
grep -q 'WARN' /tmp/inst.log && echo "  (WARN lines present, expected for unset optional vars)"

echo "### Part 2 step 3 — the README's own verification commands"
chk "CLAUDE.md installed"      "[ -f $HOME/.claude/CLAUDE.md ]"
chk "settings.json installed"  "[ -f $HOME/.claude/settings.json ]"
chk "mcp-interactive.json"     "[ -f $HOME/.claude/mcp-interactive.json ]"
chk "skills == 11"             '[ "$(ls $HOME/.claude/skills | wc -l)" = 11 ]'
chk "commands == 9"            '[ "$(ls $HOME/.claude/commands | wc -l)" = 9 ]'
chk "settings.json parses"     "python3 -m json.tool $HOME/.claude/settings.json"
chk "agents installed"         "[ -d $HOME/.claude/agents ]"
chk "rules installed"          "[ -f $HOME/.claude/rules/context7.md ]"
chk "watchdog: claude-health"      "[ -x $HOME/.local/bin/claude-health ]"
chk "watchdog: claude-mem-health"  "[ -x $HOME/.local/bin/claude-mem-health ]"
chk "watchdog: reap-idle-claude"   "[ -x $HOME/.local/bin/reap-idle-claude ]"
chk "watchdog: reap-mcp-orphans"   "[ -x $HOME/.local/bin/reap-mcp-orphans ]"
chk "watchdog: log-boot"           "[ -x $HOME/.local/bin/log-boot ]"
chk "watchdog: limit-shield"       "[ -x $HOME/bin/claude-limit-shield.sh ]"
chk "fleet: cc"                    "[ -x $HOME/.local/bin/cc ]"
chk "fleet: claude-rc"             "[ -x $HOME/.local/bin/claude-rc ]"
chk "fleet: claude-status"         "[ -x $HOME/.local/bin/claude-status ]"
chk "fleet: reset-claude-env"      "[ -x $HOME/.local/bin/reset-claude-env ]"

echo "### the scripts actually RUN (not just exist)"
export PATH="$HOME/.local/bin:$PATH"
chk "claude-health --once exits 0" "claude-health --once"
chk "claude-mem-health runs"       "claude-mem-health"
chk "reap-idle-claude runs"        "reap-idle-claude"
chk "reap-mcp-orphans runs"        "reap-mcp-orphans"
chk "log-boot runs"                "log-boot"
chk "limit-shield selftest"        "$HOME/bin/claude-limit-shield.sh selftest"
chk "cc --help works"              "cc --help | grep -q 'usage: cc'"
chk "cc --help lists default"      "cc --help | grep -q default"
chk "claude-rc help works"         "claude-rc help | grep -q status"
chk "claude-rc status runs"        "claude-rc status"
chk "claude-status runs"           "claude-status"
chk "claude-rc DRY_RUN start"      "DRY_RUN=1 claude-rc start default | grep -q 'DRY_RUN'"

echo "### multi-profile discovery (the fleet contract)"
mkdir -p "$HOME/.claude-alpha/projects" "$HOME/.claude-beta/projects"
chk "cc --help sees alpha"     "cc --help | grep -q alpha"
chk "claude-rc status 3 profiles" '[ "$(claude-rc status | grep -cE "^[[:space:]]*(default|alpha|beta)[[:space:]]")" -ge 3 ]'
chk "DRY_RUN only alpha"       "DRY_RUN=1 claude-rc only alpha | grep -q 'claude-remote@alpha'"

echo "### Part 2 step 4 — crontab recipe from the README"
{ crontab -l 2>/dev/null; sed "s|\$HOME|$HOME|g" watchdogs/crontab.example | grep -v '^#'; } | crontab -
chk "crontab took all 6 entries" '[ "$(crontab -l 2>/dev/null | grep -cE "^([*0-9@])")" -eq 6 ]'
chk "crontab has no literal \$HOME" '! crontab -l 2>/dev/null | grep -q "\\\$HOME"'

echo "### --infra with real values: renders with ZERO placeholders"
DOMAIN=example.test EXAMPLE_SUB=alpha ADMIN_EMAIL=admin@example.test \
OAUTH_CLIENT_ID=dummy-id OAUTH_CLIENT_SECRET=dummy-secret \
CONTEXT7_API_KEY=dummy-key VPS_HOST=example.test PROJECTS_ROOT="$HOME/Projects" \
  ./install.sh --infra --non-interactive > /tmp/infra.log 2>&1
chk "infra staging exit 0"        "[ $? -eq 0 ]"
chk "rendered/ populated"         '[ "$(ls rendered 2>/dev/null | wc -l)" -gt 5 ]'
chk "no placeholders in rendered" '! grep -rq "{{" rendered/'
chk "cookie secret generated"     '! grep -rq "COOKIE_SECRET" rendered/oauth2-proxy.cfg'
chk "no live services started"    '[ -z "$(systemctl list-units --state=running 2>/dev/null | grep -i claude)" ]'
chk "our caddy config NOT installed" "! grep -q claude-dashboard /etc/caddy/Caddyfile 2>/dev/null"
chk "our sudoers NOT installed"      "[ ! -f /etc/sudoers.d/claude-harness ]"

echo "### rendered artifacts are valid"
mkdir -p "$HOME/caddylog" && sed "s#/var/log/caddy#$HOME/caddylog#" rendered/Caddyfile > /tmp/cf.test
chk "caddy validates"       "caddy validate --config /tmp/cf.test --adapter caddyfile"
chk "sudoers parses"        "visudo -cf rendered/claude-harness.sudoers"
for u in rendered/*.service rendered/*.timer; do
  [ -f "$u" ] && out=$(systemd-analyze verify "$u" 2>&1); chk "systemd verify $(basename "$u")" '! grep -qE "Unknown|Invalid|syntax error" <<<"$out"'
done

echo "### plugin manifests"
chk "marketplace.json parses" "python3 -m json.tool .claude-plugin/marketplace.json"
chk "plugin.json parses"      "python3 -m json.tool claude/.claude-plugin/plugin.json"

echo "### idempotency — second run must not corrupt"
echo "# adopter customization" >> "$HOME/.claude/CLAUDE.md"
./install.sh --claude --non-interactive > /tmp/inst2.log 2>&1
chk "second install exit 0"    "[ $? -eq 0 ]"
chk "backup dir created"       '[ -n "$(ls -d $HOME/.claude.bak-* 2>/dev/null)" ]'
chk "backup kept customization" 'grep -rq "adopter customization" $HOME/.claude.bak-*/'
chk "live file restored clean"  '! grep -q "adopter customization" $HOME/.claude/CLAUDE.md'

echo "### blast radius — nothing escaped HOME"
chk "no writes to /etc/systemd" "[ -z \"\$(find /etc/systemd/system -newer /tmp/inst.log -type f 2>/dev/null)\" ]"
chk "no writes to /usr/local"   "[ -z \"\$(find /usr/local -newer /tmp/inst.log -type f 2>/dev/null)\" ]"
chk "no writes to /opt"         "[ -z \"\$(find /opt -newer /tmp/inst.log -type f 2>/dev/null)\" ]"

echo
echo "=============================="
echo "RESULT: $PASS passed, $FAIL failed"
echo "=============================="
[ "$FAIL" -eq 0 ]
