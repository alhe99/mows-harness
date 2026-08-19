#!/usr/bin/env bash
set -u

AGY_RUN="${AGY_RUN:-agy-run}"
DISCORD_SEND="${DISCORD_SEND:-$HOME/.claude/scripts/discord-send.sh}"

has_key=0
key=""
has_name=0
thread_name=""
has_dry_run=0
intent=""
files=()

while [[ $# -gt 0 ]]; do
    case "$1" in
        -k)
            [[ $# -ge 2 ]] || { echo "Error: -k requires an argument" >&2; exit 2; }
            has_key=1
            key="$2"
            shift 2
            ;;
        -i)
            [[ $# -ge 2 ]] || { echo "Error: -i requires an argument" >&2; exit 2; }
            intent="$2"
            shift 2
            ;;
        -n)
            [[ $# -ge 2 ]] || { echo "Error: -n requires an argument" >&2; exit 2; }
            has_name=1
            thread_name="$2"
            shift 2
            ;;
        --dry-run)
            has_dry_run=1
            shift
            ;;
        --)
            shift
            files+=("$@")
            break
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

if [[ -z "$intent" && ${#files[@]} -eq 0 ]]; then
    echo "Error: Either an intent (-i) or at least one file must be provided." >&2
    exit 2
fi

# Build prompt string for agy-run
prompt="You write exactly one Discord message (max 3 lines, max 500 chars, plain text with light markdown, no code fences, no preamble, no quotes around the whole message) announcing output from a Claude Code session."
if [[ -n "$intent" ]]; then
    prompt+=$'\n'"Intent: ${intent}"
else
    prompt+=$'\n'"Intent: share the attached file(s)"
fi

text_excerpt_count=0
for f in "${files[@]}"; do
    bname="$(basename -- "$f")"
    if [[ -f "$f" ]]; then
        size="$(wc -c < "$f" 2>/dev/null | tr -d ' \t\n')"
        mime="$(file -b --mime-type -- "$f" 2>/dev/null || true)"
        if [[ ( "$mime" == text/* || "$mime" == "application/json" ) && "$text_excerpt_count" -lt 2 ]]; then
            excerpt="$(head -c 4000 -- "$f" 2>/dev/null || true)"
            prompt+=$'\n--- '"${bname}"' (excerpt) ---'$'\n'"${excerpt}"
            ((text_excerpt_count++))
        else
            prompt+=$'\n--- attached: '"${bname}"' ('"${size}"' bytes) ---'
        fi
    else
        prompt+=$'\n--- attached: '"${bname}"' (0 bytes) ---'
    fi
done

# Compose via LLM bridge
raw_msg="$("$AGY_RUN" --fast --timeout 3m -- "$prompt" 2>/dev/null)"
rc=$?

# Sanitize msg
msg="$(printf '%s' "$raw_msg" | tr -d '\r')"
shopt -s extglob
msg="${msg##+([[:space:]])}"
msg="${msg%%+([[:space:]])}"
msg="${msg:0:900}"

# Fallback check
is_fallback=0
if [[ $rc -ne 0 || -z "$msg" ]]; then
    is_fallback=1
    if [[ -n "$intent" ]]; then
        fallback_target="$intent"
    else
        basenames=()
        for f in "${files[@]}"; do
            basenames+=("$(basename -- "$f")")
        done
        fallback_target="files: ${basenames[*]}"
    fi
    fallback_msg="⚠️ (agy bridge unavailable rc=${rc} — direct send) ${fallback_target}"
    msg="${fallback_msg:0:900}"
fi

# Observability
if [[ $is_fallback -eq 0 ]]; then
    echo "via-agy: composed rc=${rc} len=${#msg}" >&2
else
    echo "via-agy: FALLBACK rc=${rc}" >&2
fi
echo "via-agy: msg=${msg:0:200}" >&2

# Delivery
send_args=()
if [[ $has_key -eq 1 ]]; then
    send_args+=("-k" "$key")
fi
if [[ $has_name -eq 1 ]]; then
    send_args+=("-n" "$thread_name")
fi
if [[ $has_dry_run -eq 1 ]]; then
    send_args+=("--dry-run")
fi
send_args+=("-m" "$msg")
if [[ ${#files[@]} -gt 0 ]]; then
    send_args+=("${files[@]}")
fi

exec "$DISCORD_SEND" "${send_args[@]}"
