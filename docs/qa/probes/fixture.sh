#!/usr/bin/env bash
# Runs INSIDE the throwaway container. Builds the same shape of fixture scripts/e2e-infra.sh uses —
# a demo login with one agent, one finished run and a short transcript — then leaves the dashboard
# listening so a browser on the host can drive the real SPA.
#
# The container has no `runuser` and no mows-agent, which is deliberate: it makes every chat send
# take the EARLY-EXIT path (POST answers 303, the child dies at once, chatEnd fires with
# closed:true, and the refetched transcript has no user turn). That is the production shape behind
# journey step 10 — no completed run to resume, a lint refusal, a bad name, the unit missing — and
# here it is reached on every send instead of occasionally.
set -e
DEMO=demo; DH="/home/$DEMO"   # built, not literal: preflight forbids bare home paths
mkdir -p "$DH/.claude/projects/-demo-api" "$DH/.claude/agents" "$DH/.config/mows-agents"
printf '{"type":"user","message":{"role":"user","content":"demo"},"timestamp":"2026-08-08T00:00:00Z"}\n' \
  > "$DH/.claude/projects/-demo-api/aaaa1111-demo.jsonl"
install -m644 /r/agents/examples/harness-reviewer.md "$DH/.claude/agents/harness-reviewer.md"

RUN=20260916-101500-1
STATE="$DH/.local/state/mows-agents/harness-reviewer"
mkdir -p "$STATE/runs/$RUN"
cat > "$STATE/runs/$RUN/status.json" <<J
{"state":"done","started_at":"2026-09-16T10:15:00Z","last_event_at":"2026-09-16T10:17:00Z","cost_usd":0.21,"turns":4,"run_id":"$RUN"}
J
printf 'ok\n' > "$STATE/runs/$RUN/out.txt"
# A short saved transcript, so the chat view has something to render before any streaming starts.
# MOWS_QA_SEED replaces the user turn's text: the repeat probe needs a transcript that ALREADY
# CONTAINS the message it is about to send, which is the only shape that can tell membership
# matching from counting.
SEED=${MOWS_QA_SEED:-hello}
{ printf '{"at":"2026-09-16T10:18:00Z","role":"user","text":"%s"}\n' "$SEED"
  printf '{"at":"2026-09-16T10:18:04Z","role":"assistant","text":"Hi. Ask me about the last run.","cost_usd":0.01}\n'; } \
  > "$STATE/chat.jsonl"

# MOWS_QA_PARITY=1 (scripts/parity-capture.mjs): the routes the probes never visit need data too. /s/<acct>/<sid>
# only matches a hex sid (aaaa1111-demo above is not one) and /md only serves files under /home. Off by
# default so every existing probe keeps seeing exactly one session.
if [ "${MOWS_QA_PARITY:-}" = 1 ]; then
  { printf '{"type":"user","message":{"role":"user","content":"What changed in the last run?"},"timestamp":"2026-09-16T10:20:00Z"}\n'
    printf '{"type":"assistant","message":{"role":"assistant","model":"claude-sonnet-4","content":[{"type":"text","text":"Nothing yet. The run finished clean."}]},"timestamp":"2026-09-16T10:20:03Z"}\n'; } \
    > "$DH/.claude/projects/-demo-api/bbbb2222-3333-4444-5555-666666666666.jsonl"
  printf '# Parity fixture\n\nA short note with `code`, a list and a link.\n\n- one\n- two\n\n[home](/)\n' > "$DH/parity.md"
fi

# MOWS_TEST_HOOKS belongs on the SERVER: the gate is read inside lite.mjs's router, so /_test/chat
# and /_test/chatend are 404 without it and every streaming assertion would silently measure nothing.
exec env HOME="$DH" MOWS_TEST_HOOKS=1 node /r/infra/dashboard/lite.mjs --port 3005 --host 0.0.0.0 ${MOWS_QA_LITE_ARGS:-}
