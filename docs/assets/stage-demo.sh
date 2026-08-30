#!/usr/bin/env bash
# stage-demo.sh — bring up a throwaway, entirely FAKE copy of the harness's web surface
# (dashboard + /term) so the README screenshots can be taken without ever pointing a camera
# at a live box. Nothing here touches the real dashboard, the real tmux server, the real
# Claude config dirs, or the real ttyd unit: it runs a patched copy of lite.mjs on its own
# port against a synthetic /home tree, with shimmed `runuser`/`tmux`/`ccusage`/`claude-quota`
# so every session, project path, account name and dollar figure on screen is invented.
#
#   ./docs/assets/stage-demo.sh            # start; prints the URLs, stays in foreground
#   PORT=3099 TTYD_PORT=7699 ...           # override ports
#
# Ctrl-C stops both processes and deletes the staging dir.
set -euo pipefail
cd "$(dirname "$0")/../.."
PORT=${PORT:-3099}
TTYD_PORT=${TTYD_PORT:-7699}
STAGE=$(mktemp -d -t mows-shots-XXXXXX)
trap 'kill ${NODE_PID:-} ${TTYD_PID:-} 2>/dev/null || true; rm -rf "$STAGE"' EXIT

H=$STAGE/hm/demo
mkdir -p "$H/.local/bin" "$STAGE/bin" "$STAGE/opt"

# ---- fake transcripts -------------------------------------------------------
# lite.mjs reads the FIRST user message of each .jsonl as the session's title, and takes
# the project label from the escaped-cwd directory name. Both are invented here.
mk() { # mk <config-dir> <project-dir> <uuid> <age-minutes> <first user message> [last assistant message]
  local d="$H/$1/projects/$2" f
  mkdir -p "$d"; f="$d/$3.jsonl"
  local ts; ts=$(date -u -d "-$4 minutes" +%Y-%m-%dT%H:%M:%S.000Z)
  { printf '{"type":"user","timestamp":"%s","message":{"role":"user","content":%s}}\n' "$ts" "$(python3 -c 'import json,sys;print(json.dumps(sys.argv[1]))' "$5")"
    for i in $(seq 1 40); do
      printf '{"type":"assistant","timestamp":"%s","message":{"role":"assistant","content":[{"type":"text","text":"working on it (%s)"}]}}\n' "$ts" "$i"
    done
    [ -n "${6:-}" ] && printf '{"type":"assistant","timestamp":"%s","message":{"role":"assistant","content":[{"type":"text","text":%s}]}}\n' "$ts" "$(python3 -c 'import json,sys;print(json.dumps(sys.argv[1]))' "$6")"
  } > "$f"
  touch -d "-$4 minutes" "$f"
}
mk .claude      -home-demo-Projects-ledger-api      7f3a1c20-5d4e-4b91-9a02-1c6d8e0f4b11  3  "the settlement job double-counts refunds when a batch retries — find out why" \
  "Found it: the retry path re-emits the refund event without the idempotency key. Writing the failing test now."
mk .claude      -home-demo-Projects-storefront-web  2b8e4d61-9c07-4a3f-8e15-7d20a9c3f602  26 "add a dark-mode toggle to the account page and persist the choice" \
  "Toggle wired to localStorage and the prefers-color-scheme fallback — running the visual checks."
mk .claude      -home-demo-Projects-mows-harness    9d1f6a83-3e52-4c7d-b06a-4f81e2c5a740  95 "implement spec.md — the terminal theme wave" \
  "Wave 2 done: Nord and Catppuccin Mocha converted and passing the contrast check. 4 themes left."
mk .claude-work -home-demo-Projects-ledger-api      4c2d9b17-8a63-4e50-9f1c-2e7b5d0a3c98  12 "write the migration for the new payouts table, then dry-run it" \
  "Migration drafted. I need a confirmation before running it against the dev database."
mk .claude-work -home-demo-Projects-infra-runbooks  6e0b3f45-1d29-4c86-a37e-95c4f7b21d03  240 "draft the on-call runbook for a wedged deploy"
mk .claude      -home-demo-Projects-storefront-web  8a4c2e96-7b31-4d58-a92f-6c05d1e8b374  1560 "profile the checkout page — LCP regressed after the banner change"
mk .claude-work -home-demo-Projects-ledger-api      3f7d9c25-4e81-4a06-b53c-8d29f0a67e12  2980 "reconcile last week's chargeback file against the ledger"

# ---- shims ------------------------------------------------------------------
# lite.mjs shells out through `runuser -u <user> -- env HOME=.. PATH=.. <cmd>`; that needs
# root and a real login. The shim drops the privilege dance and runs the command directly,
# which lands on the fake tmux/ccusage/claude-quota below.
cat > "$STAGE/bin/runuser" <<'EOF'
#!/usr/bin/env bash
shift 3   # -u <user> --
exec "$@"
EOF
# canned tmux: the fleet page runs `list-panes -a -F` with the 9-field format
# (name, attached, created, activity, pane_pid, cwd, pane_id, @sid, @label) and then one
# `capture-pane -t %N` per live session to classify it (working / needs-you / idle) —
# each fake pane tail below is crafted to land in a different state, and each @sid points
# at one of the fake transcripts above so cards pick up real titles/projects/snippets.
cat > "$STAGE/bin/tmux" <<EOF
#!/usr/bin/env bash
now=\$(date +%s)
case "\${1:-}" in
  list-panes)
    for last; do :; done
    if [[ "\$last" == *session_attached* ]]; then
      printf 'cc-demo-ledger-api\t1\t%s\t%s\t424242\t/demo/Projects/ledger-api\t%%1\t7f3a1c20-5d4e-4b91-9a02-1c6d8e0f4b11\trefund double-count\n' \$((now-1080)) \$((now-8))
      printf 'cc-work-payouts\t0\t%s\t%s\t424243\t/demo/Projects/ledger-api\t%%2\t4c2d9b17-8a63-4e50-9f1c-2e7b5d0a3c98\tpayouts migration\n' \$((now-780)) \$((now-95))
      printf 'cc-demo-storefront-web\t0\t%s\t%s\t424244\t/demo/Projects/storefront-web\t%%3\t2b8e4d61-9c07-4a3f-8e15-7d20a9c3f602\t\n' \$((now-1620)) \$((now-1520))
      printf 'cc-demo-mows-harness\t0\t%s\t%s\t424245\t/demo/Projects/mows-harness\t%%4\t9d1f6a83-3e52-4c7d-b06a-4f81e2c5a740\tterminal theme wave\n' \$((now-5400)) \$((now-2400))
    fi
    ;;
  capture-pane)
    for last; do :; done
    case "\$last" in
      %1) printf 'Diffing the retry path in settlement.go\n* Simmering... (esc to interrupt)\n' ;;
      %2) printf 'Do you want to run this migration against the dev database?\n> 1. Yes\n  2. No\n' ;;
      %3) printf '> \n? for shortcuts\n' ;;
    esac
    ;;
esac
exit 0
EOF
# the fleet classifier marks a session "paused" when `ps -eo pid=,ppid=,stat=` shows a
# stopped (stat T) descendant of the pane leader — give pid 424245 one so the fourth demo
# card renders the paused state; every other ps invocation falls through to the real ps.
cat > "$STAGE/bin/ps" <<'EOF'
#!/usr/bin/env bash
if [ "${1:-}" = "-eo" ]; then
  printf '424242 1 S\n424243 1 S\n424244 1 S\n424245 1 S\n524245 424245 T\n'
else
  exec /usr/bin/ps "$@"
fi
EOF
# /system's Environment card runs `claude --version` (via RUN_PATH = ~/.local/bin:…)
cat > "$H/.local/bin/claude" <<'EOF'
#!/usr/bin/env bash
echo "3.6.2 (Claude Code)"
EOF
cat > "$H/.local/bin/claude-quota" <<'EOF'
#!/usr/bin/env bash
[ "${1:-}" = "--line" ] && echo "personal 5h 21.0% wk 34.0% | work 5h 46.0% wk 58.0% (threshold 70%)"
exit 0
EOF
cat > "$H/.local/bin/ccusage" <<'EOF'
#!/usr/bin/env python3
import sys, json, datetime
sub = sys.argv[1] if len(sys.argv) > 1 else ''
today = datetime.date.today()
day = lambda n: (today - datetime.timedelta(days=n)).isoformat()
mods = [{"modelName": "claude-opus-5", "cost": 4.11}, {"modelName": "claude-haiku-4-5", "cost": 0.37}]
if sub == 'daily':
    rows = [{"period": day(n), "totalCost": c, "modelsUsed": ["claude-opus-5"], "modelBreakdowns": mods}
            for n, c in enumerate([4.48, 6.02, 3.17, 7.91, 2.44, 5.63, 1.98])]
    print(json.dumps({"daily": rows, "totals": {"totalCost": round(sum(r["totalCost"] for r in rows), 2)}}))
elif sub == 'monthly':
    print(json.dumps({"monthly": [{"totalCost": 118.42}]}))
elif sub == 'session':
    print(json.dumps({"session": [
        {"period": "ledger-api", "totalCost": 12.80, "modelsUsed": ["claude-opus-5"],
         "metadata": {"lastActivity": day(0)}},
        {"period": "storefront-web", "totalCost": 6.35, "modelsUsed": ["claude-opus-5", "claude-haiku-4-5"],
         "metadata": {"lastActivity": day(1)}},
        {"period": "mows-harness", "totalCost": 3.02, "modelsUsed": ["claude-opus-5"],
         "metadata": {"lastActivity": day(2)}}]}))
elif sub == 'blocks':
    print(json.dumps({"blocks": [{"costUSD": 2.41, "burnRate": {"costPerHour": 1.87}}]}))
EOF
chmod +x "$STAGE/bin/"* "$H/.local/bin/"*

# ---- patched lite.mjs -------------------------------------------------------
# Only the roots move: the /home scan root and TMUX_HOME. Everything rendered is the real
# code path, so a screenshot taken here is a faithful picture of the real UI.
sed -e "s|'/home'|'$STAGE/hm'|g" -e "s|\`/home/|\`$STAGE/hm/|g" \
    infra/dashboard/lite.mjs > "$STAGE/lite.mjs"
cp infra/webconsole/themes.json "$STAGE/themes.json"
echo '{"termTheme":"Material Ocean"}' > "$STAGE/settings.json"

PATH="$STAGE/bin:$PATH" HOME="$H" node "$STAGE/lite.mjs" \
  --port "$PORT" --settings-file "$STAGE/settings.json" >"$STAGE/dash.log" 2>&1 &
NODE_PID=$!

# ---- throwaway ttyd ---------------------------------------------------------
# Serves the SAME generated /term page (all blocks, theme picker included) against a
# scripted fake session instead of a real shell.
TERM_INDEX=${TERM_INDEX:-/opt/claude-dashboard/term-index.html}
if [ -r "$TERM_INDEX" ]; then
  cp "$TERM_INDEX" "$STAGE/term-index.html"
  cp docs/assets/demo-session.sh "$STAGE/demo-session.sh"
  chmod +x "$STAGE/demo-session.sh"
  ttyd --port "$TTYD_PORT" --interface 127.0.0.1 --base-path /term --writable --url-arg \
    -t fontSize=14 -t rendererType=canvas -I "$STAGE/term-index.html" \
    "$STAGE/demo-session.sh" >"$STAGE/ttyd.log" 2>&1 &
  TTYD_PID=$!
else
  echo "note: $TERM_INDEX unreadable — /term shot skipped (run infra/webconsole/make-term-index.sh first)" >&2
fi

sleep 2
echo "staged demo up (all data fake):"
echo "  dashboard  http://127.0.0.1:$PORT/"
echo "  settings   http://127.0.0.1:$PORT/settings"
[ -n "${TTYD_PID:-}" ] && echo "  terminal   http://127.0.0.1:$TTYD_PORT/term/?theme=Material%20Ocean"
echo "  staging    $STAGE"
wait
