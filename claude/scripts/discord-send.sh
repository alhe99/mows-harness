#!/usr/bin/env bash
set -euo pipefail

SECRETS="${DISCORD_WEBHOOK_ENV:-$HOME/.claude/secrets/discord-webhook.env}"

message=""
key=""
thread_name=""
silent=0
dry_run=0
files=()

while [ $# -gt 0 ]; do
  case "$1" in
    -m)
      message="$2"
      shift 2
      ;;
    -k)
      key="$2"
      shift 2
      ;;
    -n)
      thread_name="$2"
      shift 2
      ;;
    --silent)
      silent=1
      shift
      ;;
    --dry-run)
      dry_run=1
      shift
      ;;
    --)
      shift
      while [ $# -gt 0 ]; do
        files+=("$1")
        shift
      done
      ;;
    -*)
      echo "Error: Unknown option $1" >&2
      exit 2
      ;;
    *)
      files+=("$1")
      shift
      ;;
  esac
done

if [ -z "$message" ] && [ ${#files[@]} -eq 0 ]; then
  echo "Error: Must provide a message (-m) or at least one file." >&2
  exit 2
fi

if [ -n "$key" ]; then
  key="$(printf '%s' "$key" | tr -cd 'a-zA-Z0-9._-')"
fi

attached_files=()
max_mb="${DISCORD_MAX_MB:-10}"
max_bytes=$(( max_mb * 1024 * 1024 ))

for f in "${files[@]}"; do
  if [ ! -f "$f" ]; then
    echo "Warning: '$f' is not a regular file, skipping." >&2
    continue
  fi

  size="$(stat -c%s "$f")"
  bname="$(basename "$f")"

  if [ "$size" -gt "$max_bytes" ]; then
    size_mb=$(( size / 1048576 ))
    gist_url="$(gh gist create "$f" 2>/dev/null | tail -1 || true)"
    if [ -n "$gist_url" ] && [[ "$gist_url" =~ ^https?:// ]]; then
      line="📎 ${bname} (${size_mb}MB > cap) → ${gist_url}"
    else
      line="⚠️ ${bname} (${size_mb}MB > cap) — gist upload failed"
    fi
    if [ -n "$message" ]; then
      message="${message}"$'\n'"${line}"
    else
      message="${line}"
    fi
  else
    if [ ${#attached_files[@]} -lt 10 ]; then
      attached_files+=("$f")
    else
      line="⚠️ ${bname} — dropped (>10 files limit)"
      if [ -n "$message" ]; then
        message="${message}"$'\n'"${line}"
      else
        message="${line}"
      fi
    fi
  fi
done

if [ -z "$message" ] && [ ${#attached_files[@]} -eq 0 ]; then
  echo "Error: No message content or valid attachments to send." >&2
  exit 2
fi

if [ ${#message} -gt 1990 ]; then
  message="${message:0:1990}"
fi

build_attachments_json() {
  local arr=()
  local idx=0
  for f in "${attached_files[@]}"; do
    local bn
    bn="$(basename "$f")"
    arr+=("$(jq -n --argjson id "$idx" --arg filename "$bn" '{id: $id, filename: $filename}')")
    idx=$((idx + 1))
  done
  local joined
  joined="$(IFS=,; echo "${arr[*]}")"
  echo "[$joined]"
}

build_payload() {
  local msg="$1"
  local t_name="$2"
  local is_silent="$3"

  local jq_args=(-n --arg content "$msg")

  if [ "$is_silent" -eq 1 ]; then
    jq_args+=(--argjson flags 4096)
  else
    jq_args+=(--argjson flags null)
  fi

  if [ -n "$t_name" ]; then
    jq_args+=(--arg thread_name "$t_name")
  else
    jq_args+=(--argjson thread_name null)
  fi

  if [ ${#attached_files[@]} -gt 0 ]; then
    local att_json
    att_json="$(build_attachments_json)"
    jq_args+=(--argjson attachments "$att_json")
  else
    jq_args+=(--argjson attachments null)
  fi

  jq -c '
    {content: $content}
    + (if $flags != null then {flags: $flags} else {} end)
    + (if $thread_name != null then {thread_name: $thread_name} else {} end)
    + (if $attachments != null then {attachments: $attachments} else {} end)
  ' "${jq_args[@]}"
}

if [ "$dry_run" -eq 1 ]; then
  dry_tname=""
  if [ -n "$key" ]; then
    state_file="$HOME/.claude/state/discord-threads/$key"
    if [ ! -f "$state_file" ]; then
      dry_tname="${thread_name:-cc · $key}"
      if [ ${#dry_tname} -gt 95 ]; then dry_tname="${dry_tname:0:95}"; fi
    fi
  elif [ -n "$thread_name" ]; then
    dry_tname="$thread_name"
    if [ ${#dry_tname} -gt 95 ]; then dry_tname="${dry_tname:0:95}"; fi
  fi

  payload="$(build_payload "$message" "$dry_tname" "$silent")"
  echo "Payload JSON:"
  echo "$payload"
  echo "Attached files:"
  if [ ${#attached_files[@]} -gt 0 ]; then
    for f in "${attached_files[@]}"; do
      echo " - $f"
    done
  else
    echo " (none)"
  fi
  exit 0
fi

if [ -f "$SECRETS" ]; then
  # shellcheck source=/dev/null
  source "$SECRETS"
fi

if [ -z "${DISCORD_WEBHOOK_URL:-}" ] || [[ "$DISCORD_WEBHOOK_URL" == *PASTE* ]]; then
  echo "Error: DISCORD_WEBHOOK_URL is unset or unconfigured in $SECRETS" >&2
  exit 3
fi

resp_file="$(mktemp)"
trap 'rm -f "$resp_file"' EXIT

send_http() {
  local req_url="$1"
  local p_json="$2"

  local curl_cmd=(curl --max-time 60 -s -w "%{http_code}" -o "$resp_file")

  if [ ${#attached_files[@]} -gt 0 ]; then
    # The JSON goes through a file, not inline. With an inline `-F name=value`,
    # curl treats `,` and `;` in the value as field separators, so any payload
    # with more than one JSON key arrived at Discord truncated -> HTTP 400
    # 'Expected "payload_json" to be a valid JSON string'. Text-only sends never
    # hit this because they use -d, which is why the hook path always worked.
    local pj_file
    pj_file="$(mktemp)"
    printf '%s' "$p_json" >"$pj_file"
    curl_cmd+=(-F "payload_json=<${pj_file};type=application/json")
    local idx=0
    for f in "${attached_files[@]}"; do
      curl_cmd+=(-F "files[${idx}]=@${f}")
      idx=$((idx + 1))
    done
  else
    curl_cmd+=(-H "Content-Type: application/json" -d "$p_json")
  fi

  curl_cmd+=("$req_url")
  local rc_out
  rc_out="$("${curl_cmd[@]}" || echo 000)"
  [ -n "${pj_file:-}" ] && rm -f "$pj_file"
  printf '%s' "$rc_out"
}

STATE_DIR="$HOME/.claude/state/discord-threads"
mkdir -p "$STATE_DIR"

url="${DISCORD_WEBHOOK_URL}?wait=true"
send_thread_name=""
state_file=""
creating_thread=0

if [ -n "$key" ]; then
  state_file="$STATE_DIR/$key"
  if [ -f "$state_file" ]; then
    st="$(cat "$state_file" 2>/dev/null || true)"
    if [ "$st" = "flat" ]; then
      :
    elif [ -n "$st" ]; then
      url="${url}&thread_id=${st}"
    fi
  else
    creating_thread=1
    send_thread_name="${thread_name:-cc · $key}"
    if [ ${#send_thread_name} -gt 95 ]; then
      send_thread_name="${send_thread_name:0:95}"
    fi
  fi
elif [ -n "$thread_name" ]; then
  send_thread_name="$thread_name"
  if [ ${#send_thread_name} -gt 95 ]; then
    send_thread_name="${send_thread_name:0:95}"
  fi
fi

payload="$(build_payload "$message" "$send_thread_name" "$silent")"
http_code="$(send_http "$url" "$payload")"

if [ "$http_code" -eq 429 ]; then
  retry_sec="$(jq -r '.retry_after // 2' "$resp_file" 2>/dev/null || echo 2)"
  sleep "$retry_sec"
  http_code="$(send_http "$url" "$payload")"
fi

if [ "$http_code" -eq 400 ] && [ "$creating_thread" -eq 1 ]; then
  if [ -n "$state_file" ]; then
    echo "flat" > "$state_file"
  fi
  creating_thread=0
  payload="$(build_payload "$message" "" "$silent")"
  http_code="$(send_http "$url" "$payload")"
  if [ "$http_code" -eq 429 ]; then
    retry_sec="$(jq -r '.retry_after // 2' "$resp_file" 2>/dev/null || echo 2)"
    sleep "$retry_sec"
    http_code="$(send_http "$url" "$payload")"
  fi
fi

if [ "$http_code" -ge 200 ] && [ "$http_code" -lt 300 ]; then
  msg_id="$(jq -r '.id // empty' "$resp_file" 2>/dev/null || true)"
  if [ "$creating_thread" -eq 1 ] && [ -n "$state_file" ]; then
    chan_id="$(jq -r '.channel_id // empty' "$resp_file" 2>/dev/null || true)"
    if [ -n "$chan_id" ]; then
      echo "$chan_id" > "$state_file"
    fi
  fi
  if [ -n "$key" ]; then
    echo "sent: message ${msg_id:-unknown} (thread ${key})"
  else
    echo "sent: message ${msg_id:-unknown}"
  fi
  exit 0
else
  echo "HTTP ${http_code}: $(cat "$resp_file")" >&2
  exit 1
fi
