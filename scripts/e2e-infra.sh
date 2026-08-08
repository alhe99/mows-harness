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
HOME=$DH node /r/infra/dashboard/lite.mjs --port 3005 --host 127.0.0.1 >/tmp/dash.log 2>&1 &
# ttyd on :7681, the /term upstream
ttyd --port 7681 --interface 127.0.0.1 --base-path /term --writable /bin/sh >/tmp/ttyd.log 2>&1 &
# oauth2-proxy on :4180 from the RENDERED config, dummy Google creds
cp rendered/oauth2-proxy.cfg /etc/oauth2-proxy.cfg
mkdir -p /etc/oauth2-proxy && echo "admin@example.test" > /etc/oauth2-proxy/emails.txt
oauth2-proxy --config /etc/oauth2-proxy.cfg >/tmp/oauth.log 2>&1 &
sleep 4
chk "dashboard listening :3005"    'curl -sf -o /dev/null http://127.0.0.1:3005/'
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

[ "$FAIL" -gt 0 ] && { echo "--- oauth.log ---"; tail -5 /tmp/oauth.log; }
caddy stop >/dev/null 2>&1
echo
echo "RESULT: $PASS passed, $FAIL failed"
[ "$FAIL" -eq 0 ]
