#!/usr/bin/env bash
# Part 3 smoke: actually STAND UP the infra layer from the rendered templates and prove the
# auth chain works — Caddy route -> forward_auth -> oauth2-proxy -> Google redirect.
# Previously only "the templates parse" was tested; this runs them.
set -u
PASS=0; FAIL=0
ok(){ echo "PASS: $*"; PASS=$((PASS+1)); }
no(){ echo "FAIL: $*"; FAIL=$((FAIL+1)); }
chk(){ if eval "$2" >/dev/null 2>&1; then ok "$1"; else no "$1"; fi; }

cd /r
echo "### render the infra layer with real-shaped values"
DOMAIN=example.test EXAMPLE_SUB=alpha ADMIN_EMAIL=admin@example.test \
OAUTH_CLIENT_ID=1234567890-abcdefg.apps.googleusercontent.com \
OAUTH_CLIENT_SECRET=GOCSPX-dummydummydummydummy \
CONTEXT7_API_KEY=dummy VPS_HOST=example.test PROJECTS_ROOT=/root/Projects \
  ./install.sh --infra --non-interactive >/tmp/render.log 2>&1
chk "render exit 0"              '[ -f rendered/Caddyfile ]'
chk "no placeholders left"       '! grep -rq "{{" rendered/'

echo "### stand up the real upstreams the Caddyfile expects"
DEMO=demo; DH="/home/$DEMO"   # built, not literal: preflight forbids bare home paths
# dashboard on :3005, exactly as the template's reverse_proxy targets
mkdir -p $DH/.claude/projects/-demo-api
printf '{"type":"user","message":{"role":"user","content":"demo"},"timestamp":"2026-08-08T00:00:00Z"}\n' \
  > $DH/.claude/projects/-demo-api/aaaa1111-demo.jsonl
mkdir -p "$DH/.config/mows-agents"
{ echo 'WEBHOOK_SECRET_HARNESS_REVIEWER=s3cret'
  # same secret VALUE as harness-reviewer's, deliberately — see the a_b case below, which
  # depends on one signature being valid against both keys so the only variable is the name.
  echo 'WEBHOOK_SECRET_A_B=s3cret'; } > "$DH/.config/mows-agents/config"
# Fixture for the capability panel (Task 8). The dashboard reads an agent's declared policy by
# shelling out to mows-agent-meta AS the tmux user, so all four of these have to be real: the OS
# account runuser switches to, the validator on its PATH, a genuine agent file to parse, and
# python3+PyYAML for the validator itself (installed by scripts/e2e-infra's apt line). The agent
# file is the repo's own example, NOT a fixture written here — a hand-written copy could drift
# into disagreeing with the file the repo actually ships.
useradd -M -d "$DH" -s /usr/sbin/nologin "$DEMO" 2>/dev/null || true
mkdir -p "$DH/.local/bin" "$DH/.claude/agents"
install -m755 /r/agents/bin/mows-agent-meta "$DH/.local/bin/mows-agent-meta"
install -m644 /r/agents/examples/harness-reviewer.md "$DH/.claude/agents/harness-reviewer.md"
# ...and the opposite fixture: an agent with state but no agent file anywhere (see the assertion
# that reads it, further down).
mkdir -p "$DH/.local/state/mows-agents/ghost"
# The dashboard's own systemctl calls (webhook trigger, run-now) need a real init system to
# succeed against, which this bare `docker run` container never boots (no PID 1 systemd) —
# confirmed directly: `systemctl start foo.service` here always fails with "System has not
# been booted with systemd as init system (PID 1). Can't operate.", regardless of whether the
# unit exists. That's not what the webhook checks below are testing (they're testing the HMAC
# accept/reject path), so stub systemctl the same way scripts/e2e-agents.sh does: a shim that
# logs its invocation and exits 0, put ahead of the real binary on PATH before the dashboard
# process starts — execFile resolves a bare command through PATH at spawn time, which is the
# env this script hands the node process (no per-call env override in lite.mjs).
mkdir -p /shim
cat > /shim/systemctl <<'S'
#!/usr/bin/env bash
echo "systemctl $*" >> /tmp/systemctl.log
# /shim/FAIL is a filesystem flag, not an env var: the dashboard is a long-running process
# started once below, so a later test that needs systemctl to start failing can't do it
# through an env var (the child's env is fixed at spawn) — but every systemctl call is a
# fresh execFile, so a file check here is live for the rest of this script.
[ -f /shim/FAIL ] && [ "${1:-}" = start ] && exit 1
exit 0
S
chmod +x /shim/systemctl
export PATH="/shim:$PATH"
# MOWS_TEST_HOOKS belongs on THIS process, not on the node harness that drives it: the gate
# (`process.env.MOWS_TEST_HOOKS === '1'`) is read inside lite.mjs's router, so it is the SERVER
# that must have it. Setting it on the client, as the replay check below used to, leaves
# /_test/chat a 404 and the check silently measures nothing. Still off by default everywhere
# else, so the injectors remain unreachable on the real dashboard.
HOME=$DH MOWS_TEST_HOOKS=1 node /r/infra/dashboard/lite.mjs --port 3005 --host 127.0.0.1 >/tmp/dash.log 2>&1 &
# Captured here, read at the very end of the script: the RSS ceiling is only meaningful once
# this process has served every request the suite makes, not four seconds after it booted.
DASH_PID=$!
# ttyd on :7681, the /term upstream
ttyd --port 7681 --interface 127.0.0.1 --base-path /term --writable /bin/sh >/tmp/ttyd.log 2>&1 &
# oauth2-proxy on :4180 from the RENDERED config, dummy Google creds
cp rendered/oauth2-proxy.cfg /etc/oauth2-proxy.cfg
mkdir -p /etc/oauth2-proxy && echo "admin@example.test" > /etc/oauth2-proxy/emails.txt
oauth2-proxy --config /etc/oauth2-proxy.cfg >/tmp/oauth.log 2>&1 &
sleep 4
chk "dashboard listening :3005"    'curl -sf -o /dev/null http://127.0.0.1:3005/'
# /api/* reads the same agentsIndex() the HTML views do, so it needs the same fixture: a
# real (if empty) directory under AGENTS_STATE named harness-reviewer. Without this, agent
# detail/chat would 404 for "no such agent" — a true statement about the fixture, not about
# the routing this task adds — and the assertions below couldn't tell the difference.
mkdir -p "$DH/.local/state/mows-agents/harness-reviewer"
chk "api: /api/agents is json"          'curl -s http://127.0.0.1:3005/api/agents | jq -e ".agents | type == \"array\""'
chk "api: agent detail is json"         'curl -s http://127.0.0.1:3005/api/agents/harness-reviewer | jq -e ".name == \"harness-reviewer\""'
chk "api: chat is json"                 'curl -s http://127.0.0.1:3005/api/agents/harness-reviewer/chat | jq -e ".turns | type == \"array\""'
# The capability panel (Task 8), end to end: the fixture agent above has
# tools: [Read, Glob, Grep, Bash] and disallowedTools: [Write, Edit, WebFetch, NotebookEdit], so
# Write must be absent from `effective` AND hasBroad must be true. That pair is the whole point —
# the deny list looks restrictive and is not, and a panel computed from it would say "read-only"
# about an agent that can write any file this account can reach.
chk "cap: computed, not the deny list"  'curl -s http://127.0.0.1:3005/api/agents/harness-reviewer | jq -e ".capability.effective | index(\"Write\") == null"'
chk "cap: Bash counts as broad"         'curl -s http://127.0.0.1:3005/api/agents/harness-reviewer | jq -e ".capability.hasBroad == true"'
chk "cap: policy is present"            'curl -s http://127.0.0.1:3005/api/agents/harness-reviewer | jq -e ".capability.policy.workdir | length > 0"'
# Not just "Write is absent" — a capability object that was empty for any reason would pass that.
chk "cap: effective is the allow list"  'curl -s http://127.0.0.1:3005/api/agents/harness-reviewer | jq -e ".capability.effective == [\"Read\",\"Glob\",\"Grep\",\"Bash\"]"'
chk "cap: the no-op deny list is named" 'curl -s http://127.0.0.1:3005/api/agents/harness-reviewer | jq -e ".capability.denyNoop | length == 4"'
chk "cap: budget reaches the response"  'curl -s http://127.0.0.1:3005/api/agents/harness-reviewer | jq -e ".capability.policy.budget.usd_per_run == 1.5"'
# The panel no longer answers "is it broad?" with one boolean — it names the KINDS of authority an
# agent holds, because several narrow-sounding tools add up and a boolean cannot say what they add
# up to. That shape has to survive the HTTP boundary intact, not just exist in the model: the
# assertions above would all still pass if `authorities` were dropped from the response entirely.
chk "cap: authorities name the kind and the tools that confer it" \
  'curl -s http://127.0.0.1:3005/api/agents/harness-reviewer | jq -e ".capability.authorities == [{\"kind\":\"shell\",\"beyondList\":true,\"tools\":[\"Bash\"]}]"'
# permissionMode is read but never verified, and the panel says so; it must at least reach the page.
chk "cap: permissionMode crosses the wire" \
  'curl -s http://127.0.0.1:3005/api/agents/harness-reviewer | jq -e ".capability.policy.permissionMode == \"default\""'
# The residue fields: a tool this page cannot classify, and an MCP tool whose reach is unknowable.
# Both are empty for this fixture, and both must be PRESENT and empty rather than absent — absent
# and empty are the same to jq, which is the trap the ghost assertion below also had to dodge.
chk "cap: the unknown-reach fields are present, not merely falsy" \
  'curl -s http://127.0.0.1:3005/api/agents/harness-reviewer | jq -e "(.capability | has(\"mcpTools\") and has(\"unclassifiedTools\")) and .capability.mcpTools == [] and .capability.unclassifiedTools == []"'
# A WEBHOOK_SECRET_HARNESS_REVIEWER is configured above, so /wh/harness-reviewer can start this
# agent — a capability its triggers list (one cron entry) does not mention. The panel says so.
chk "cap: an armed webhook is disclosed" 'curl -s http://127.0.0.1:3005/api/agents/harness-reviewer | jq -e ".capability.policy.webhookArmed == true"'
# ...and saying so must never mean shipping the secret itself.
chk "cap: the webhook secret never leaves the box" '! curl -s http://127.0.0.1:3005/api/agents/harness-reviewer | grep -q s3cret'
# An agent with run records but no readable agent file. capability must be null — the view turns
# that into an explicit "unknown", where an empty object would render as a confident "no tools,
# no budget, no triggers". This is reachable in production: retention_days outlives the file.
# (Its state dir is created with the other fixtures above, before the dashboard starts: agentsIndex
# caches for 3s, so a directory created here would 404 for the first three seconds of its life and
# this assertion would fail for a reason that has nothing to do with what it is testing.)
# has("capability") is not redundant: jq yields null for an ABSENT key too, so ".capability == null"
# alone stays green if the field is dropped from the response entirely — the assertion would then
# be passing for a reason that has nothing to do with the honest-unknown path it is meant to prove.
chk "cap: no agent file -> null, not an empty capability" \
  'curl -s http://127.0.0.1:3005/api/agents/ghost | jq -e "has(\"capability\") and .capability == null"'
chk "cap: the panel module is actually served to the browser" \
  'curl -s http://127.0.0.1:3005/ui/ | grep -q "views/capability"'
chk "api: unknown agent -> 404"         '[ "$(curl -s -o /dev/null -w "%{http_code}" http://127.0.0.1:3005/api/agents/nope)" = 404 ]'
chk "api: bad name -> 404"              '[ "$(curl -s -o /dev/null -w "%{http_code}" http://127.0.0.1:3005/api/agents/BAD_NAME)" = 404 ]'
chk "api: content-type is json"         'curl -sI http://127.0.0.1:3005/api/agents | grep -qi "content-type: application/json"'
chk "stream: emits fleet on connect"   'timeout 6 curl -sN "http://127.0.0.1:3005/stream?topics=fleet" | head -c 400 | grep -q "event: fleet"'
chk "stream: heartbeat or data, never silence" 'timeout 30 curl -sN "http://127.0.0.1:3005/stream?topics=fleet" | head -c 200 | grep -qE "event:|: hb"'
# --max-time, NOT `timeout`. An SSE response never ends, so the curl has to be cut short either
# way — but `timeout` cuts it short with SIGTERM from outside, and a SIGTERMed curl dies before
# it ever emits --write-out. The command substitution therefore expanded to the empty string and
# this compared "" = 200, which is false no matter what the server does: verified by pointing the
# same idiom at topics=fleet, a stream that demonstrably works (117/118 pass against it), and
# getting the identical empty result. It could not pass, so it never tested anything. curl's own
# --max-time aborts from the inside instead: exit code 28, but %{http_code} is still written.
# The neighbours above sidestep the whole problem by piping into head rather than asking curl
# for --write-out; --max-time is the equivalent for a check that wants the status code itself.
chk "stream: unknown topic is ignored, not fatal" '[ "$(curl -sN --max-time 3 -o /dev/null -w "%{http_code}" "http://127.0.0.1:3005/stream?topics=nonsense")" = 200 ]'
# This was `true  # exercised by the node harness in Task 3 step 5` — a check whose body is the
# `true` builtin passes unconditionally and proves nothing, and the delegation it claimed was not
# real: stream-replay-check.mjs never touched SSE_MAX. Now delegated for real, to a harness that
# needs a client the shell cannot express (SSE_MAX+1 simultaneous live connections, then a
# deterministic teardown so the slots are free again for everything below).
chk "stream: over cap -> 503"          'PORT=3005 node /r/scripts/stream-cap-check.mjs'
# PORT=3005: the harness defaults to 3105 and the dashboard here is on 3005, so unfixed it
# connected to nothing and died on ECONNREFUSED. MOWS_TEST_HOOKS moved to the server at the
# spawn above, which is the process that reads it.
chk "stream: replay resumes without duplicating" 'PORT=3005 node /r/scripts/stream-replay-check.mjs'
# desktop/tablet browsers open sessions in their own named windows (client-side, so just
# prove the wiring is served: the per-session data-nw attr and the gate that applies it)
# /history, not /. This assertion used to curl '/' and had failed since the 2026-08-29 fleet
# reskin, which made the home page fleet-first — "no system stats, no today list" (homeView's
# own header comment) — and moved session browsing entirely to /history. sessionRowHtml() is
# where data-nw is emitted and listView() is its ONLY caller, so the attribute has not appeared
# on '/' since that reskin; the check outlived its subject by pointing at a page that had
# deliberately stopped rendering the thing it looks for. Verified by dumping both pages against
# this exact fixture: '/' contains "aaaa1111" 0 times, /history 7, including data-nw="t-aaaa1111".
chk "dashboard: >_ carries data-nw"   'curl -s http://127.0.0.1:3005/history | grep -q "data-nw=\"t-aaaa1111\""'
# stays on '/': the window-target gate lives in the base page script, served on every page.
chk "dashboard: window-target script" 'curl -s http://127.0.0.1:3005/ | grep -q "a.target=a.dataset.nw"'
chk "dashboard: /agents renders" 'curl -sf http://127.0.0.1:3005/agents | grep -q "· agents"'
SIG="sha256=$(printf '{"ref":"refs/heads/main"}' | openssl dgst -sha256 -hmac s3cret | awk '{print $NF}')"
chk "webhook: good HMAC -> 202"      '[ "$(curl -s -o /dev/null -w "%{http_code}" -X POST -H "X-Mows-Signature: $SIG" --data-binary "{\"ref\":\"refs/heads/main\"}" http://127.0.0.1:3005/wh/harness-reviewer)" = 202 ]'
chk "webhook: GitHub header accepted" '[ "$(curl -s -o /dev/null -w "%{http_code}" -X POST -H "X-Hub-Signature-256: $SIG" --data-binary "{\"ref\":\"refs/heads/main\"}" http://127.0.0.1:3005/wh/harness-reviewer)" = 202 ]'
chk "webhook: bad HMAC -> 401"       '[ "$(curl -s -o /dev/null -w "%{http_code}" -X POST -H "X-Mows-Signature: sha256=00" --data-binary "{}" http://127.0.0.1:3005/wh/harness-reviewer)" = 401 ]'
chk "webhook: no secret -> 404"      '[ "$(curl -s -o /dev/null -w "%{http_code}" -X POST --data-binary "{}" http://127.0.0.1:3005/wh/nobody)" = 404 ]'
chk "webhook: GET -> 405"            '[ "$(curl -s -o /dev/null -w "%{http_code}" http://127.0.0.1:3005/wh/harness-reviewer)" = 405 ]'
# name-gate regression (Task 9 coverage gap, fix round 1): AGENT_RE must reject anything
# that isn't ^[a-z0-9][a-z0-9-]{0,63}$ *before* the name is ever used to build a unit name
# or a config key. The endpoint returns a byte-identical 404 for "no such agent" and for
# "agent exists, no secret configured" (deliberate anti-enumeration, verified in Task 9) —
# which means a malformed name with NO secret configured can never prove the gate did
# anything: the same 404 would come back with AGENT_RE deleted outright. To actually
# discriminate, the malformed name below has ITS OWN configured secret with the SAME
# secret VALUE as harness-reviewer's, so $SIG (already computed above) is a byte-for-byte
# valid signature against both keys — the only thing that can differ between the two
# requests is whether AGENT_RE accepts the name.
#
# /wh/../etc is NOT a case of this: a WHATWG URL collapses ".." during parsing, so Node's
# `new URL(req.url, 'http://x')` normalizes the path to /etc before routing ever sees
# "/wh/" — confirmed directly: `node -e "console.log(new URL('/wh/../etc','http://x').pathname)"`
# prints /etc. That 404 comes from the generic route fallback, not from AGENT_RE, so it is
# a real defense (traversal never reaches webhookView) but not evidence about the pattern
# gate specifically — recorded here, not asserted as a gate test.
chk "webhook: malformed name (_) rejected despite a valid secret+signature" \
  '[ "$(curl -s -o /dev/null -w "%{http_code}" -X POST -H "X-Mows-Signature: $SIG" --data-binary "{\"ref\":\"refs/heads/main\"}" http://127.0.0.1:3005/wh/a_b)" = 404 ]'
chk "webhook: the exact same signature IS valid for a well-formed name" \
  '[ "$(curl -s -o /dev/null -w "%{http_code}" -X POST -H "X-Mows-Signature: $SIG" --data-binary "{\"ref\":\"refs/heads/main\"}" http://127.0.0.1:3005/wh/harness-reviewer)" = 202 ]'
# @ is outside AGENT_RE too, but WEBHOOK_SECRET_A@B can never parse as a config key under
# agentsConfig()'s own ^([A-Z0-9_]+)=(.*)$ — no secret can be provisioned for it, so this
# can only ever prove "an unconfigured bad name still 404s", the same thing AGENT_RE
# deleted would also do. Left as a sanity check, not gate evidence.
chk "webhook: name with @ -> 404 (sanity only, not gate evidence)" \
  '[ "$(curl -s -o /dev/null -w "%{http_code}" -X POST --data-binary "{}" "http://127.0.0.1:3005/wh/a@b")" = 404 ]'
# finding-8 proof: a valid signature must not still get 202 once systemctl actually fails —
# otherwise the fix that made the dashboard stop lying about `systemctl start` is itself
# unproven by this suite (this branch has already found four assertions that passed against
# the defect they were meant to catch; this one must not be a fifth). Same request as the
# "good HMAC -> 202" check above; only the shim's behavior changes.
touch /shim/FAIL
chk "webhook: systemctl failure -> honest 503, never 202" \
  '[ "$(curl -s -o /dev/null -w "%{http_code}" -X POST -H "X-Mows-Signature: $SIG" --data-binary "{\"ref\":\"refs/heads/main\"}" http://127.0.0.1:3005/wh/harness-reviewer)" = 503 ]'
rm -f /shim/FAIL
chk "ttyd listening :7681"         'curl -s -o /dev/null -w "%{http_code}" http://127.0.0.1:7681/term/ | grep -q "200"'
chk "oauth2-proxy listening :4180" 'curl -s -o /dev/null http://127.0.0.1:4180/ping'
chk "oauth2-proxy /ping healthy"   '[ "$(curl -s http://127.0.0.1:4180/ping)" = "OK" ]'
# regression guard: plain `openssl rand -base64 32` yields a secret oauth2-proxy cannot
# decode ~3 runs in 4, and the failure is a refusal to start, not a warning.
chk "cookie_secret is URL-safe"    '! grep -E "^cookie_secret = \"[^\"]*[+/]" rendered/oauth2-proxy.cfg'

echo "### run Caddy from the rendered Caddyfile (TLS off; no DNS/ACME in a container)"
# only change: serve plain :80 instead of the real hostname, so no ACME is attempted.
# Every route, snippet, matcher and forward_auth line is the rendered file's own.
{ echo "{"; echo "  auto_https off"; echo "}"; sed -e 's#^example\.test {#:80 {#' -e '/^alpha\.example\.test {/,/^}/d' rendered/Caddyfile; } > /tmp/Caddyfile.test
sed -i 's#/var/log/caddy#/tmp#' /tmp/Caddyfile.test
chk "rendered Caddyfile adapts"  'caddy validate --config /tmp/Caddyfile.test --adapter caddyfile'
caddy start --config /tmp/Caddyfile.test --adapter caddyfile >/tmp/caddy.log 2>&1
sleep 3
chk "caddy listening :80" 'curl -s -o /dev/null http://127.0.0.1:80/'
chk "caddy: /wh/* bypasses the auth gate" '[ "$(curl -s -o /dev/null -w "%{http_code}" -X POST --data-binary "{}" http://127.0.0.1/wh/nobody)" = 404 ]'

echo "### THE ACTUAL CLAIM: everything is gated behind Google sign-in"
LOC=$(curl -s -o /dev/null -w '%{redirect_url}' http://127.0.0.1/)
echo "  apex redirect -> ${LOC:-<none>}"
chk "apex 302s to the auth gate"     '[ "$(curl -s -o /dev/null -w "%{http_code}" http://127.0.0.1/)" = "302" ]'
chk "apex redirect targets oauth2"   'grep -q "/oauth2/start" <<<"$LOC"'
LOC2=$(curl -s -o /dev/null -w '%{redirect_url}' "http://127.0.0.1/oauth2/start?rd=%2F")
echo "  /oauth2/start -> $(cut -c1-60 <<<"$LOC2")..."
chk "oauth2/start -> accounts.google.com" 'grep -q "accounts.google.com" <<<"$LOC2"'
chk "client_id reaches Google"            'grep -q "apps.googleusercontent.com" <<<"$LOC2"'
chk "/term is gated too"        '[ "$(curl -s -o /dev/null -w "%{http_code}" http://127.0.0.1/term)" = "302" ]'
chk "dashboard NOT reachable unauthenticated" '! curl -s http://127.0.0.1/ | grep -q "claude sessions"'
chk "PWA statics bypass by design" '[ "$(curl -s -o /dev/null -w "%{http_code}" http://127.0.0.1/manifest.webmanifest)" = "200" ]'
chk "open-redirect blocked"     '! curl -s -o /dev/null -w "%{redirect_url}" "http://127.0.0.1/oauth2/start?rd=https://evil.test" | grep -q "evil.test"'

echo "### the two resource facts a browser depends on and nothing else here measures"
# HTTP/2 matters on the LIVE host, which is the only place a browser negotiates it. An || of two
# weak local checks would pass vacuously — SKIP loudly instead of inventing a pass.
#
# Why it is load-bearing and silent if it regresses: over HTTP/1.1 the browser caps SSE at six
# connections PER ORIGIN, ACROSS ALL TABS, which is exactly this owner's usage pattern (a phone
# with the dashboard, an agent and a run open at once). Nothing in the UI reports the cap being
# hit — the seventh tab simply never receives a token, forever, and looks like a hung agent.
# --max-time and NOT `timeout N curl`: see preflight 5e (b). This one would survive either way
# (a TLS handshake is not an endless stream), but the wrong idiom is the thing that spreads.
MOWS_HOST="${MOWS_HOST:-}"
if [ -n "$MOWS_HOST" ]; then
  HV=$(curl -s --max-time 15 -o /dev/null -w '%{http_version}' "https://$MOWS_HOST/" 2>/dev/null)
  echo "  negotiated HTTP version on $MOWS_HOST: ${HV:-<none>}"
  chk "http2 negotiated on $MOWS_HOST (spec §3)" '[ "$HV" = 2 ]'
else
  echo "SKIP: http2 check — set MOWS_HOST to the live host to run it (spec §3, load-bearing)"
fi

# The RSS check requires DASH_PID to be non-empty; an unset variable would make `-le` compare
# nothing and pass. That is the same failure shape as the HTTP/2 check above, so it is guarded
# too. `ps` is present in ubuntu:24.04 without extra packages (verified), so an empty RSS_KB here
# means a dead dashboard, which is a real failure and should read as one.
RSS_KB=$(ps -o rss= -p "$DASH_PID" | tr -d ' ')
chk "dashboard RSS <= 150MB (spec D3)" '[ -n "$RSS_KB" ] && [ "$RSS_KB" -le 153600 ]'
echo "  dashboard RSS: $((RSS_KB / 1024))MB of 150MB ceiling"

[ "$FAIL" -gt 0 ] && { echo "--- oauth.log ---"; tail -5 /tmp/oauth.log; }
caddy stop >/dev/null 2>&1
echo
echo "RESULT: $PASS passed, $FAIL failed"
[ "$FAIL" -eq 0 ]
