#!/usr/bin/env bash
# discord-notify.sh — Claude Code Notification hook → Discord.
# Two modes, wired via Notification hook matchers in settings.json:
#   input — permission_prompt / elicitation_dialog / agent_needs_input:
#           the session is hard-blocked on the user → always notify.
#   idle  — idle_prompt fires ~60s after EVERY finished turn; only a turn
#           that ends asking something is worth a ping, so notify only when
#           the last assistant text ends with a question mark. Finished-work
#           summaries stay silent.
# Any other arg ("stop", legacy) is a deliberate no-op.
# Never blocks a session: always exits 0.
set -uo pipefail

command -v jq >/dev/null 2>&1 || exit 0
mode="${1:-}"
case "$mode" in input|idle) ;; *) exit 0 ;; esac
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
# session is actually blocked on. Whitespace collapsed; the display copy is
# capped in jq (700 chars) so multibyte chars never get split, but the idle
# question check runs on the FULL text — the question sits at the end.
ctx=""
full=""
if [ -n "$transcript_path" ] && [ -f "$transcript_path" ]; then
  full="$(tail -n 200 "$transcript_path" 2>/dev/null | jq -r '
    select(.type=="assistant")
    | [.message.content[]? | select(.type=="text") | .text]
    | join(" ")
    | gsub("[[:space:]]+"; " ")
    | select(length > 2)' 2>/dev/null | tail -n 1)"
  ctx="$(jq -rn --arg t "$full" '$t[0:700]' 2>/dev/null)"
fi

if [ "$mode" = "idle" ]; then
  # ponytail: trailing-? heuristic; upgrade to an LLM classifier if it misses.
  printf '%s' "$full" | grep -qE '\?["*_)`. ]*$' || exit 0
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
printf '%s %s %s %s\n' "$(date '+%F %T')" "$mode" "$key" "${out:-no-output}" \
  >> "$state_dir/notify.log" 2>/dev/null || true

exit 0
