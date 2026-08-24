#!/usr/bin/env bash
# discord-notify.sh — Claude Code Notification hook → Discord.
# Only "input" events notify (session blocked on the user). "stop" is a
# deliberate no-op kept as an accepted arg so sessions started before the
# Stop hook was removed exit silently instead of erroring.
# Never blocks a session: always exits 0.
set -uo pipefail

command -v jq >/dev/null 2>&1 || exit 0
[ "${1:-}" = "input" ] || exit 0
[ -t 0 ] && exit 0

input_json="$(cat)"
[ -n "$input_json" ] || exit 0
jq -e . >/dev/null 2>&1 <<< "$input_json" || exit 0

session_id="$(jq -r '.session_id // empty' <<< "$input_json")"
cwd="$(jq -r '.cwd // empty' <<< "$input_json")"
msg="$(jq -r '.message // empty' <<< "$input_json")"
transcript_path="$(jq -r '.transcript_path // empty' <<< "$input_json")"

if [ -n "$cwd" ]; then
  proj="$(basename "$cwd")"
elif [ -n "$transcript_path" ]; then
  proj="$(basename "$(dirname "$transcript_path")")"
else
  proj="?"
fi

sid8="${session_id:0:8}"
[ -n "$sid8" ] || sid8="unknown"
key="s-${sid8}"

# Session name (tmux @label, set via ccname or the dashboard ✎). The hook
# inherits $TMUX from the pane Claude runs in, so read it live each time.
label=""
if [ -n "${TMUX:-}" ] && command -v tmux >/dev/null 2>&1; then
  label="$(tmux display-message -p '#{@label}' 2>/dev/null || true)"
fi

state_dir="$HOME/.claude/state/discord-threads"
mkdir -p "$state_dir"

# Context = last assistant text in the transcript: the question/status the
# session is actually blocked on. Whitespace collapsed, capped in jq (700
# chars) so multibyte chars never get split.
ctx=""
if [ -n "$transcript_path" ] && [ -f "$transcript_path" ]; then
  ctx="$(tail -n 200 "$transcript_path" 2>/dev/null | jq -r '
    select(.type=="assistant")
    | [.message.content[]? | select(.type=="text") | .text]
    | join(" ")
    | gsub("[[:space:]]+"; " ")
    | select(length > 2)
    | .[0:700]' 2>/dev/null | tail -n 1)"
fi

if [ ${#msg} -gt 200 ]; then msg="${msg:0:200}..."; fi
head="${proj}"
[ -n "$label" ] && head="${label} · ${proj}"
text="⏸️ **${head}** (\`${sid8}\`) — ${msg:-needs your input}"
if [ -n "$ctx" ]; then
  text="${text}
>>> ${ctx}"
fi

out="$(timeout 10 "$HOME/.claude/scripts/discord-send.sh" \
  -k "$key" \
  -n "cc · ${head} · ${sid8}" \
  -m "$text" 2>&1)" || true
printf '%s input %s %s\n' "$(date '+%F %T')" "$key" "${out:-no-output}" \
  >> "$state_dir/notify.log" 2>/dev/null || true

exit 0
