# Antigravity (agy) Delegation & Sessions Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Claude delegates implementation work to Google's Antigravity CLI (`agy`) — automatically at ≥70% Claude quota, manually on request — with worktree isolation, mechanical + model review gates, auto-merge-when-green; plus a `cc`-style `ag` launcher whose tmux sessions appear in the existing web dashboard.

**Architecture:** Five bash tools in a new `agy/` layer of mows-harness (`claude-quota`, `agy-run`, `agy-handoff`, `agy-gate`, `ag`), a Claude-side skill + CLAUDE.md rule + SessionStart hook, and small extensions to the reaper, installer, docs, and e2e suite. No MCP server, no daemon: detached handoffs are tmux sessions whose command chain ends in `agy-gate`.

**Tech Stack:** bash + jq + git worktrees + tmux; agy headless mode (`-p --output-format json/stream-json`, `--json-schema`, `--conversation`); Claude Code print mode for reviews; existing e2e-container harness with a stub `agy` binary.

**Spec:** `docs/superpowers/specs/2026-08-10-antigravity-delegation-design.md`.
One deliberate deviation, applied to the spec in Task 1: handoff worktrees live under `~/.local/state/agy-handoffs/<id>/wt`, NOT `<repo>/.worktrees/` — target repos stay unpolluted (no `.gitignore` demands on every repo), and state/log/worktree live together.

## Global Constraints

- **preflight is the publish gate** (`scripts/preflight.sh`) — every commit must keep it ALL CLEAN:
  - `scripts/manifest.txt` must equal `git ls-files` in BOTH directions → every task that adds a file adds it to the manifest in the same commit (keep the list sorted the way preflight sorts: plain `sort`).
  - Forbidden content in files AND commit messages: absolute home-directory path literals, Linux or macOS (always write `~` or `$HOME`), Homebrew prefixes, credential prefixes, dotted-quad IPs (except 127.0.0.1/0.0.0.0/255.255.255.255). Note this plan itself must not spell the forbidden shapes out — preflight scans docs too.
  - Only sanctioned double-brace template placeholders (we introduce none; don't write that shape literally anywhere, including docs — this lint scans everything).
  - Every bash file must pass `bash -n` and `shellcheck -S error`.
- **Counts are pinned in three places** — README lines "9 commands, 11 skills" (×2), `expect 11`, and `scripts/e2e-container.sh` (`skills == 11`, `commands == 9`). Task 8 flips 11→12 everywhere in the same commit that adds the skill.
- The 70% threshold is defined ONCE, in `claude-quota` (`THRESHOLD=70`). No other file hardcodes it.
- tmux session-name contract: interactive agy sessions = `agy-<slug>`, handoff sessions = `agyh-<id>` (distinct prefix so the reaper can never touch a running handoff). `cc-`/`ccw-` naming untouched.
- install.sh layers never start/enable live services and never run the official agy installer themselves — print instructions instead (repo convention).
- Commit style: `feat(agy): …` / `fix(agy): …` / `docs(agy): …`, matching repo history.
- All new scripts take `AGY_BIN`/config overrides so tests run against a stub `agy` with zero network.

---

### Task 1: Manifest sync for docs + spec path fix (unblock preflight)

**STATUS: pre-applied at plan-commit time** — the spec was committed without a manifest entry (preflight BLOCKED), so the fix below was applied in the same commit that added this plan. Executor: just run Step 5's preflight check to confirm the green baseline, then move to Task 2.

**Files:**
- Modify: `scripts/manifest.txt`
- Modify: `docs/superpowers/specs/2026-08-10-antigravity-delegation-design.md`

**Interfaces:**
- Consumes: nothing.
- Produces: a preflight-green baseline every later task builds on.

- [ ] **Step 1: Confirm preflight is currently blocked**

Run: `cd ~/Documents/Projects/mows-harness && ./scripts/preflight.sh; echo "exit=$?"`
Expected: diff shows the spec file missing from manifest; `BLOCKED`, `exit=1`.

- [ ] **Step 2: Add both docs paths to the manifest**

Add these two lines to `scripts/manifest.txt` (then re-sort the non-comment body with `sort` to match preflight's comparison; comment header lines stay on top):

```
docs/superpowers/plans/2026-08-10-agy-delegation.md
docs/superpowers/specs/2026-08-10-antigravity-delegation-design.md
```

- [ ] **Step 3: Update the spec's worktree location**

In `docs/superpowers/specs/2026-08-10-antigravity-delegation-design.md`, replace:

```
  1. Creates worktree `<repo>/.worktrees/agy-<id>` on new branch `agy/<id>`.
```

with:

```
  1. Creates worktree `~/.local/state/agy-handoffs/<id>/wt` on new branch
     `agy/<id>` (state, log, and worktree live together; target repos stay
     unpolluted).
```

- [ ] **Step 4: Verify the spec contains no forbidden literals**

Run: `grep -nE '/(home|Users)/' docs/superpowers/specs/*.md docs/superpowers/plans/*.md || echo CLEAN`
Expected: `CLEAN`.

- [ ] **Step 5: Preflight green + commit**

Run: `./scripts/preflight.sh | tail -1`
Expected: `preflight: ALL CLEAN`

```bash
git add scripts/manifest.txt docs/
git commit -m "docs(agy): manifest-track spec+plan; handoff worktrees under ~/.local/state"
```

---

### Task 2: `claude-quota` — per-account usage signal

**Files:**
- Create: `agy/bin/claude-quota`
- Create: `agy/config.example`
- Modify: `scripts/manifest.txt`

**Interfaces:**
- Consumes: `~/.claude/.credentials.json` and `~/.claude-work/.credentials.json` (`.claudeAiOauth.accessToken`, `.expiresAt` ms-epoch); `https://api.anthropic.com/api/oauth/usage`.
- Produces (later tasks rely on these exactly):
  - `claude-quota --json` → `{"personal":{"five_hour_pct":N|null,"weekly_pct":N|null,"five_hour_resets_at":S|null,"weekly_resets_at":S|null,"source":"api"|"unknown"},"work":{…}}`
  - `claude-quota --line` → one human line (SessionStart hook).
  - `claude-quota --check [personal|work]` → exit 0 (<70), 1 (≥70), 2 (unknown). Default account: `work` if `CLAUDE_CONFIG_DIR` ends in `-work`, else `personal`.
  - `claude-quota --reviewer` → prints `personal` or `work` (first account <70) or nothing (exit 1) — used by `agy-gate` to pick a Claude reviewer.
  - `THRESHOLD=70` lives here only.

- [ ] **Step 1: Write `agy/config.example`**

```bash
# mows-agy config — sourced by agy-run / agy-handoff / agy-gate.
# Installed to ~/.config/mows-agy/config (only if absent; your edits are kept).
# Populate model slugs from:  agy models
AGY_BIN=agy
AGY_FAST_MODEL=            # flash-tier slug for cheap sync tasks (empty = agy default)
AGY_REVIEW_MODEL=          # smartest slug for big-handoff reviews (empty = agy default)
AGY_HANDOFF_TIMEOUT=120m   # --print-timeout for detached handoff runs
# Notification hook: a command that receives the message as its first argument
# (wire your Discord/openclaw sender here). Empty = log-only.
AGY_NOTIFY_CMD=
```

- [ ] **Step 2: Write `agy/bin/claude-quota` with an embedded `--selftest`**

```bash
#!/usr/bin/env bash
# claude-quota — per-account Claude usage signal for agy delegation.
# The 70% delegation threshold is defined HERE and nowhere else.
#   --json | --line | --check [personal|work] | --reviewer | --refresh | --selftest
# Exit codes for --check: 0 below threshold, 1 at/over, 2 unknown.
set -euo pipefail
THRESHOLD=70
CACHE="$HOME/.local/state/claude-quota.json"
TTL=300
USAGE_URL="https://api.anthropic.com/api/oauth/usage"

cfg_dir(){ [ "$1" = work ] && echo "$HOME/.claude-work" || echo "$HOME/.claude"; }

# parse_usage <raw-json>: normalize one account's API payload to
# {five_hour_pct,weekly_pct,five_hour_resets_at,weekly_resets_at,source}.
# Defensive: several field spellings tried; anything missing -> null/unknown.
parse_usage(){
  jq -c '{
    five_hour_pct:       (.five_hour.utilization // .five_hour.used_pct // null),
    weekly_pct:          (.seven_day.utilization // .seven_day.used_pct // .weekly.utilization // null),
    five_hour_resets_at: (.five_hour.resets_at // null),
    weekly_resets_at:    (.seven_day.resets_at // .weekly.resets_at // null)
  } + {source: (if (.five_hour.utilization // .five_hour.used_pct // null) == null
                then "unknown" else "api" end)}' 2>/dev/null \
  || echo '{"five_hour_pct":null,"weekly_pct":null,"five_hour_resets_at":null,"weekly_resets_at":null,"source":"unknown"}'
}

UNKNOWN='{"five_hour_pct":null,"weekly_pct":null,"five_hour_resets_at":null,"weekly_resets_at":null,"source":"unknown"}'

fetch_account(){ # -> normalized json on stdout, never fails
  local dir tok exp now raw
  dir=$(cfg_dir "$1")
  tok=$(jq -r '.claudeAiOauth.accessToken // empty' "$dir/.credentials.json" 2>/dev/null) || tok=""
  exp=$(jq -r '.claudeAiOauth.expiresAt // 0' "$dir/.credentials.json" 2>/dev/null) || exp=0
  now=$(( $(date +%s) * 1000 ))
  if [ -z "$tok" ] || [ "$exp" -le "$now" ]; then echo "$UNKNOWN"; return 0; fi
  # ponytail: no refresh-token flow — claude itself refreshes creds constantly;
  # a stale token just yields "unknown" (fail-safe: no auto-delegation).
  raw=$(curl -sf --max-time 10 "$USAGE_URL" \
        -H "Authorization: Bearer $tok" \
        -H "anthropic-beta: oauth-2025-04-20" 2>/dev/null) || { echo "$UNKNOWN"; return 0; }
  printf '%s' "$raw" | parse_usage
}

refresh(){
  mkdir -p "$(dirname "$CACHE")"
  jq -n --argjson p "$(fetch_account personal)" --argjson w "$(fetch_account work)" \
    '{personal:$p, work:$w}' > "$CACHE.tmp" && mv "$CACHE.tmp" "$CACHE"
}

ensure_cache(){
  local age=99999
  [ -f "$CACHE" ] && age=$(( $(date +%s) - $(stat -c %Y "$CACHE") ))
  [ "$age" -gt "$TTL" ] && refresh || true
}

pct_of(){ jq -r ".$1.five_hour_pct // \"?\", .$1.weekly_pct // \"?\"" "$CACHE"; }

check_account(){ # exit 0/1/2 per contract
  local fh wk
  fh=$(jq -r ".$1.five_hour_pct" "$CACHE"); wk=$(jq -r ".$1.weekly_pct" "$CACHE")
  [ "$fh" = null ] && exit 2
  if [ "${fh%.*}" -ge "$THRESHOLD" ] || { [ "$wk" != null ] && [ "${wk%.*}" -ge "$THRESHOLD" ]; }; then exit 1; fi
  exit 0
}

active_account(){
  case "${CLAUDE_CONFIG_DIR:-}" in *-work) echo work;; *) echo personal;; esac
}

selftest(){
  local t; t=$(mktemp -d); trap 'rm -rf "$t"' RETURN
  # 1. full payload parses
  echo '{"five_hour":{"utilization":42,"resets_at":"soon"},"seven_day":{"utilization":71,"resets_at":"later"}}' \
    | parse_usage | jq -e '.five_hour_pct==42 and .weekly_pct==71 and .source=="api"' >/dev/null || { echo "FAIL parse full"; return 1; }
  # 2. garbage -> unknown
  echo 'not json' | parse_usage | jq -e '.source=="unknown"' >/dev/null || { echo "FAIL parse garbage"; return 1; }
  # 3. --check against a crafted cache: work over threshold, personal under
  CACHE="$t/c.json"
  jq -n '{personal:{five_hour_pct:10,weekly_pct:20},work:{five_hour_pct:80,weekly_pct:20}}' > "$CACHE"
  (check_account personal); [ $? -eq 0 ] || { echo "FAIL check under"; return 1; }
  (check_account work);     [ $? -eq 1 ] || { echo "FAIL check over"; return 1; }
  jq -n '{personal:{five_hour_pct:null,weekly_pct:null},work:{}}' > "$CACHE"
  (check_account personal); [ $? -eq 2 ] || { echo "FAIL check unknown"; return 1; }
  echo "claude-quota selftest OK"
}

case "${1:---line}" in
  --selftest) selftest; exit $?;;
  --refresh)  refresh; exit 0;;
  --json)     ensure_cache; cat "$CACHE";;
  --line)     ensure_cache
              read -r pf pw < <(pct_of personal | paste -sd' '); read -r wf ww < <(pct_of work | paste -sd' ')
              echo "claude quota: personal 5h ${pf}% wk ${pw}% | work 5h ${wf}% wk ${ww}% (threshold ${THRESHOLD}%)";;
  --check)    ensure_cache; check_account "${2:-$(active_account)}";;
  --reviewer) ensure_cache
              for a in personal work; do
                if (check_account "$a") 2>/dev/null; then echo "$a"; exit 0; fi
              done; exit 1;;
  *) echo "usage: claude-quota [--json|--line|--check [personal|work]|--reviewer|--refresh|--selftest]" >&2; exit 64;;
esac
```

- [ ] **Step 3: Run the selftest to verify it fails before implementation is complete**

(If you wrote the file in one pass, this is your red→green proof instead: temporarily run with an empty `parse_usage` body if you want the red. Otherwise proceed.)

Run: `chmod +x agy/bin/claude-quota && agy/bin/claude-quota --selftest`
Expected: `claude-quota selftest OK`

- [ ] **Step 4: Static checks**

Run: `bash -n agy/bin/claude-quota && shellcheck -S error agy/bin/claude-quota && echo OK`
Expected: `OK`

- [ ] **Step 5: Manifest + commit**

Add to `scripts/manifest.txt` (sorted): `agy/bin/claude-quota`, `agy/config.example`.

```bash
./scripts/preflight.sh | tail -1   # expect: preflight: ALL CLEAN
git add agy scripts/manifest.txt
git commit -m "feat(agy): claude-quota per-account usage signal (70% threshold lives here)"
```

---

### Task 3: `agy-run` — synchronous delegation wrapper

**Files:**
- Create: `agy/bin/agy-run`
- Modify: `scripts/manifest.txt`

**Interfaces:**
- Consumes: `~/.config/mows-agy/config` (`AGY_BIN`, `AGY_FAST_MODEL`); an `agy` binary (stub in tests via `AGY_BIN`).
- Produces (agy-gate and the skill rely on these exactly):
  - `agy-run [--model M|--fast] [--effort low|medium|high] [--timeout 10m] [--schema '<json>'] [--conversation ID] [--json] [--] "PROMPT"`
  - stdout: `.response` text (or the full envelope with `--json`).
  - Exit codes: `0` ok · `1` agy/tool error · `2` empty-response quota bug · `3` auth error.

- [ ] **Step 1: Write `agy/bin/agy-run` with embedded `--selftest`**

```bash
#!/usr/bin/env bash
# agy-run — synchronous agy delegation with fail-loud semantics.
# agy's known quota bug: on 429 exhaustion, headless agy retries silently until
# --print-timeout then exits 0 with an EMPTY response. We turn that into exit 2.
# Exit: 0 ok · 1 agy error · 2 empty-response(quota) · 3 auth error · 64 usage.
set -uo pipefail
CFG="$HOME/.config/mows-agy/config"; [ -f "$CFG" ] && . "$CFG"
AGY=${AGY_BIN:-agy}

MODEL="" EFFORT="" TIMEOUT="5m" SCHEMA="" CONV="" RAWJSON=0
while [ $# -gt 0 ]; do case "$1" in
  --model) MODEL=$2; shift 2;;
  --fast)  MODEL=${AGY_FAST_MODEL:-}; shift;;
  --effort) EFFORT=$2; shift 2;;
  --timeout) TIMEOUT=$2; shift 2;;
  --schema) SCHEMA=$2; shift 2;;
  --conversation) CONV=$2; shift 2;;
  --json) RAWJSON=1; shift;;
  --selftest) SELFTEST=1; shift; break;;
  --) shift; break;;
  -*) echo "agy-run: unknown flag $1" >&2; exit 64;;
  *) break;;
esac; done

run(){
  local prompt=$1 err out rc
  err=$(mktemp)
  cmd=("$AGY" -p "$prompt" --output-format json --print-timeout "$TIMEOUT")
  [ -n "$MODEL" ]  && cmd+=(--model "$MODEL")
  [ -n "$EFFORT" ] && cmd+=(--effort "$EFFORT")
  [ -n "$SCHEMA" ] && cmd+=(--json-schema "$SCHEMA")
  [ -n "$CONV" ]   && cmd+=(--conversation "$CONV")
  out=$("${cmd[@]}" 2>"$err"); rc=$?
  if grep -qiE 'auth|sign.?in|log.?in|unauthorized|credential' "$err" && [ $rc -ne 0 ]; then
    echo "agy-run: agy auth error — run \`ag\` once and re-login" >&2; cat "$err" >&2; rm -f "$err"; return 3
  fi
  if [ $rc -ne 0 ]; then
    echo "agy-run: agy exited $rc" >&2; cat "$err" >&2; rm -f "$err"; return 1
  fi
  local status resp
  status=$(printf '%s' "$out" | jq -r '.status // empty' 2>/dev/null)
  resp=$(printf '%s' "$out" | jq -r '.response // empty' 2>/dev/null)
  if [ "$status" != "SUCCESS" ] || [ -z "$resp" ]; then
    if [ -z "$resp" ] && { [ "$status" = "SUCCESS" ] || [ -z "$status" ]; }; then
      echo "agy-run: empty response with success exit — agy quota likely exhausted (known 429-retry bug); stderr follows" >&2
      cat "$err" >&2; rm -f "$err"; return 2
    fi
    echo "agy-run: agy status=$status" >&2
    printf '%s' "$out" | jq -r '.error // empty' >&2; cat "$err" >&2; rm -f "$err"; return 1
  fi
  rm -f "$err"
  if [ "$RAWJSON" = 1 ]; then printf '%s\n' "$out"; else printf '%s\n' "$resp"; fi
}

selftest(){
  local t; t=$(mktemp -d); trap 'rm -rf "$t"' RETURN
  # stub agy with switchable behavior via AGY_STUB_MODE
  cat > "$t/agy" <<'STUB'
#!/usr/bin/env bash
case "${AGY_STUB_MODE:-ok}" in
  ok)      echo '{"conversation_id":"c-1","status":"SUCCESS","response":"pong","num_turns":1}';;
  empty)   echo '{"conversation_id":"c-2","status":"SUCCESS","response":""}';;
  autherr) echo "please sign in to continue" >&2; exit 1;;
  fail)    echo "boom" >&2; exit 7;;
esac
STUB
  chmod +x "$t/agy"; AGY="$t/agy"
  [ "$(AGY_STUB_MODE=ok run ping)" = "pong" ]            || { echo "FAIL ok-path"; return 1; }
  AGY_STUB_MODE=empty   run ping >/dev/null 2>&1; [ $? -eq 2 ] || { echo "FAIL empty->2"; return 1; }
  AGY_STUB_MODE=autherr run ping >/dev/null 2>&1; [ $? -eq 3 ] || { echo "FAIL auth->3"; return 1; }
  AGY_STUB_MODE=fail    run ping >/dev/null 2>&1; [ $? -eq 1 ] || { echo "FAIL err->1"; return 1; }
  echo "agy-run selftest OK"
}

if [ "${SELFTEST:-0}" = 1 ]; then selftest; exit $?; fi
[ $# -ge 1 ] || { echo "usage: agy-run [--model M|--fast] [--effort E] [--timeout T] [--schema J] [--conversation ID] [--json] [--] PROMPT" >&2; exit 64; }
run "$1"
```

- [ ] **Step 2: Run selftest**

Run: `chmod +x agy/bin/agy-run && agy/bin/agy-run --selftest`
Expected: `agy-run selftest OK`

- [ ] **Step 3: Static checks**

Run: `bash -n agy/bin/agy-run && shellcheck -S error agy/bin/agy-run && echo OK`
Expected: `OK`

- [ ] **Step 4: Manifest + commit**

Add `agy/bin/agy-run` to `scripts/manifest.txt` (sorted).

```bash
./scripts/preflight.sh | tail -1   # expect ALL CLEAN
git add agy/bin/agy-run scripts/manifest.txt
git commit -m "feat(agy): agy-run sync wrapper — fail-loud on the empty-response quota bug"
```

---

### Task 4: `agy-handoff` — worktree + detached session lifecycle

**Files:**
- Create: `agy/bin/agy-handoff`
- Modify: `scripts/manifest.txt`

**Interfaces:**
- Consumes: `~/.config/mows-agy/config`; git; tmux; `agy` (stub via `AGY_BIN`); `agy-gate` (Task 5 — until then, `--foreground` runs end at gate invocation failure, which Task 5's tests cover).
- Produces:
  - `agy-handoff start [--repo DIR] [--size small|big] [--no-merge] [--foreground] (--task FILE | --verify CMD [--verify CMD…] "PROMPT")` → prints the handoff `<id>` on stdout.
  - State dir `~/.local/state/agy-handoffs/<id>/`: `meta.json` `{id,repo,base,branch,size,auto_merge,status,created,reason?,conversation_id?}`, `HANDOFF.md`, `run.sh`, `run.ndjson`, `run.err`, `wt/` (git worktree on branch `agy/<id>`).
  - Statuses: `running → gated → merged|parked|ready`.
  - `agy-handoff list` · `agy-handoff path <id>` (prints state dir) · `agy-handoff resume <id>`.
  - HANDOFF.md contract: must contain a ```` ```verify ```` fenced block with ≥1 command; `start` refuses otherwise.
  - tmux session name: `agyh-<id>`.

- [ ] **Step 1: Write `agy/bin/agy-handoff`**

```bash
#!/usr/bin/env bash
# agy-handoff — fire-and-forget agy implementation runs, isolated in a git
# worktree, gated by agy-gate. State: ~/.local/state/agy-handoffs/<id>/
set -euo pipefail
CFG="$HOME/.config/mows-agy/config"; [ -f "$CFG" ] && . "$CFG"
ROOT="$HOME/.local/state/agy-handoffs"
TIMEOUT=${AGY_HANDOFF_TIMEOUT:-120m}

meta_set(){ # meta_set <id> key value  (string values)
  local f="$ROOT/$1/meta.json"
  jq --arg k "$2" --arg v "$3" '.[$k]=$v' "$f" > "$f.tmp" && mv "$f.tmp" "$f"
}

verify_block_ok(){ # file has a ```verify fence with >=1 non-empty line
  awk '/^```verify/{f=1;next} /^```/{f=0} f&&NF{n++} END{exit n?0:1}' "$1"
}

start(){
  local repo=$PWD size=small merge=true fg=0 task="" prompt="" verifies=()
  while [ $# -gt 0 ]; do case "$1" in
    --repo) repo=$2; shift 2;;
    --size) size=$2; shift 2;;
    --no-merge) merge=false; shift;;
    --foreground) fg=1; shift;;
    --task) task=$2; shift 2;;
    --verify) verifies+=("$2"); shift 2;;
    *) prompt=$1; shift;;
  esac; done
  repo=$(cd "$repo" && pwd)
  git -C "$repo" rev-parse --git-dir >/dev/null || { echo "agy-handoff: $repo is not a git repo" >&2; exit 1; }
  case "$size" in small|big) ;; *) echo "agy-handoff: --size must be small|big" >&2; exit 64;; esac

  local id state base
  id=$(date +%Y%m%d-%H%M%S)-$$
  state="$ROOT/$id"; mkdir -p "$state"
  base=$(git -C "$repo" symbolic-ref --short HEAD)

  if [ -n "$task" ]; then
    cp "$task" "$state/HANDOFF.md"
  else
    [ -n "$prompt" ] && [ ${#verifies[@]} -ge 1 ] || { echo "agy-handoff: need --task FILE, or PROMPT with >=1 --verify CMD" >&2; exit 64; }
    { echo "# Handoff $id"
      echo; echo "## Task"; echo "$prompt"
      echo; echo "## Acceptance criteria"; echo "- verification commands below all pass"
      echo; echo '## Verification commands (must exit 0)'; echo '```verify'
      printf '%s\n' "${verifies[@]}"; echo '```'
    } > "$state/HANDOFF.md"
  fi
  verify_block_ok "$state/HANDOFF.md" || { echo "agy-handoff: HANDOFF.md has no \`\`\`verify block with commands — refusing (the mechanical gate would be empty)" >&2; rm -rf "$state"; exit 64; }

  git -C "$repo" worktree add -b "agy/$id" "$state/wt" "$base" >/dev/null

  jq -n --arg id "$id" --arg repo "$repo" --arg base "$base" --arg size "$size" \
        --arg am "$merge" --arg created "$(date -Is)" \
    '{id:$id, repo:$repo, base:$base, branch:("agy/"+$id), size:$size,
      auto_merge:($am=="true"), status:"running", created:$created}' > "$state/meta.json"

  local agybin=${AGY_BIN:-agy}
  cat > "$state/run.sh" <<RUN
#!/usr/bin/env bash
cd "$state/wt" || exit 1
$(printf '%q' "$agybin") -p "You are executing handoff $id. Read $state/HANDOFF.md fully. Work ONLY in the current directory (a git worktree on branch agy/$id). Implement the task so every acceptance criterion holds and every command in the verify block exits 0. Commit all work to the current branch with clear messages. Never merge, push, or switch branches." \
  --dangerously-skip-permissions --output-format stream-json \
  --print-timeout "$TIMEOUT" > "$state/run.ndjson" 2> "$state/run.err"
echo "agy_exit=\$?" >> "$state/run.err"
exec agy-gate "$id"
RUN
  chmod +x "$state/run.sh"

  if [ "$fg" = 1 ]; then bash "$state/run.sh" || true
  else tmux new-session -d -s "agyh-$id" "bash $(printf '%q' "$state/run.sh")"
  fi
  echo "$id"
}

list(){
  [ -d "$ROOT" ] || { echo "(no handoffs)"; return 0; }
  local d id st size created stale
  for d in "$ROOT"/*/; do
    [ -f "$d/meta.json" ] || continue
    id=$(jq -r .id "$d/meta.json"); st=$(jq -r .status "$d/meta.json")
    size=$(jq -r .size "$d/meta.json"); created=$(jq -r .created "$d/meta.json")
    stale=""
    if [ "$st" = running ] && ! tmux has-session -t "=agyh-$id" 2>/dev/null; then stale=" [STALE — session gone; resume or inspect]"; fi
    printf '%s  %-7s %-5s %s%s  %s\n' "$id" "$st" "$size" "$created" "$stale" "$(jq -r '.reason // ""' "$d/meta.json")"
  done
}

resume(){
  local id=$1 state cid
  state="$ROOT/$id"; [ -f "$state/meta.json" ] || { echo "agy-handoff: no such handoff $id" >&2; exit 1; }
  cid=$(grep -o '"conversation_id"[": ]*[a-zA-Z0-9-]*' "$state/run.ndjson" 2>/dev/null | head -1 | grep -oE '[a-zA-Z0-9-]+$' || true)
  local agybin=${AGY_BIN:-agy}
  cat > "$state/run.sh" <<RUN
#!/usr/bin/env bash
cd "$state/wt" || exit 1
$(printf '%q' "$agybin") -p "Continue handoff $id per $state/HANDOFF.md. Finish the task; every verify command must exit 0; commit to the current branch." \
  ${cid:+--conversation "$cid"} \
  --dangerously-skip-permissions --output-format stream-json \
  --print-timeout "$TIMEOUT" >> "$state/run.ndjson" 2>> "$state/run.err"
echo "agy_exit=\$?" >> "$state/run.err"
exec agy-gate "$id"
RUN
  chmod +x "$state/run.sh"
  meta_set "$id" status running
  tmux new-session -d -s "agyh-$id" "bash $(printf '%q' "$state/run.sh")"
  echo "$id resumed"
}

case "${1:-}" in
  start)  shift; start "$@";;
  list)   list;;
  path)   [ -n "${2:-}" ] && echo "$ROOT/$2";;
  resume) shift; resume "$@";;
  *) echo "usage: agy-handoff start|list|path|resume …" >&2; exit 64;;
esac
```

- [ ] **Step 2: Smoke-test start/list against a stub agy in a toy repo**

```bash
t=$(mktemp -d)
printf '#!/usr/bin/env bash\necho stub-ran > done.txt\ngit add -A && git commit -qm "stub work"\necho "{\\"conversation_id\\":\\"c-9\\",\\"status\\":\\"SUCCESS\\"}"\n' > "$t/agy"
chmod +x "$t/agy"
git -C "$t" init -qb main repo && cd "$t/repo" && git commit -qm init --allow-empty
HOME_STATE_BEFORE=$(ls ~/.local/state/agy-handoffs 2>/dev/null | wc -l)
id=$(AGY_BIN="$t/agy" PATH="$PWD:$PATH" agy-handoff start --repo "$t/repo" --foreground --verify "test -f done.txt" "create done.txt") || true
agy-handoff list | grep "$id"
```

Expected: `start` prints an id; `list` shows it (status will be `running` or the gate's outcome once Task 5 exists — before Task 5, `run.sh`'s final `exec agy-gate` fails, which is fine at this task's boundary). Verify the worktree exists: `ls ~/.local/state/agy-handoffs/<id>/wt/.git` → present. Verify refusal path: `agy-handoff start --repo "$t/repo" "no verify"` → exits 64 with the refusing message.

- [ ] **Step 3: Static checks**

Run: `bash -n agy/bin/agy-handoff && shellcheck -S error agy/bin/agy-handoff && echo OK`
Expected: `OK`

- [ ] **Step 4: Manifest + commit**

Add `agy/bin/agy-handoff` to `scripts/manifest.txt` (sorted).

```bash
./scripts/preflight.sh | tail -1   # expect ALL CLEAN
git add agy/bin/agy-handoff scripts/manifest.txt
git commit -m "feat(agy): agy-handoff worktree + detached tmux lifecycle (start/list/path/resume)"
```

---

### Task 5: `agy-gate` — verification, review escalation, merge policy

**Files:**
- Create: `agy/bin/agy-gate`
- Modify: `scripts/manifest.txt`

**Interfaces:**
- Consumes: state dir + `meta.json` from Task 4; `claude-quota --reviewer` (Task 2); `agy-run --schema` (Task 3); `AGY_REVIEW_MODEL`, `AGY_NOTIFY_CMD` from config; `claude` CLI when a Claude reviewer has budget.
- Produces: `agy-gate <id>` → exit `0` merged (or `ready` when `auto_merge=false`), `10` parked. meta `status` transitions + `reason`; notifications via `AGY_NOTIFY_CMD` (log-only fallback to `~/.local/state/agy-handoffs/events.log`).

- [ ] **Step 1: Write `agy/bin/agy-gate`**

```bash
#!/usr/bin/env bash
# agy-gate — the merge-policy engine for one handoff. Runs as the tail of the
# handoff session's command chain (or manually). agy's own claims count for
# nothing: verification commands are re-run HERE.
# Exit: 0 merged/ready · 10 parked · 64 usage.
set -uo pipefail
CFG="$HOME/.config/mows-agy/config"; [ -f "$CFG" ] && . "$CFG"
ROOT="$HOME/.local/state/agy-handoffs"

ID=${1:-}; [ -n "$ID" ] || { echo "usage: agy-gate <id>" >&2; exit 64; }
STATE="$ROOT/$ID"; META="$STATE/meta.json"
[ -f "$META" ] || { echo "agy-gate: no handoff $ID" >&2; exit 64; }

REPO=$(jq -r .repo "$META"); BASE=$(jq -r .base "$META")
BRANCH=$(jq -r .branch "$META"); SIZE=$(jq -r .size "$META")
AUTOMERGE=$(jq -r .auto_merge "$META"); WT="$STATE/wt"

meta_set(){ jq --arg k "$1" --arg v "$2" '.[$k]=$v' "$META" > "$META.tmp" && mv "$META.tmp" "$META"; }

notify(){
  local msg="agy handoff $ID: $*"
  echo "$(date -Is) $msg" >> "$ROOT/events.log"
  [ -n "${AGY_NOTIFY_CMD:-}" ] && "$AGY_NOTIFY_CMD" "$msg" 2>/dev/null || true
}

park(){ meta_set status parked; meta_set reason "$1"; notify "PARKED — $1"; exit 10; }

meta_set status gated

# record conversation_id for resume, best-effort
CID=$(grep -o '"conversation_id"[": ]*[a-zA-Z0-9-]*' "$STATE/run.ndjson" 2>/dev/null | head -1 | grep -oE '[a-zA-Z0-9-]+$' || true)
[ -n "$CID" ] && meta_set conversation_id "$CID"

# Gate 0: did agy commit anything at all? (catches the silent-quota empty run)
COMMITS=$(git -C "$WT" rev-list --count "$BASE..HEAD" 2>/dev/null || echo 0)
[ "$COMMITS" -gt 0 ] || park "no commits on $BRANCH — agy produced nothing (quota exhausted? see run.err)"

# Gate 1: re-run every verify command from HANDOFF.md
mapfile -t VERIFY < <(awk '/^```verify/{f=1;next} /^```/{f=0} f&&NF' "$STATE/HANDOFF.md")
[ ${#VERIFY[@]} -ge 1 ] || park "HANDOFF.md verify block is empty"
for c in "${VERIFY[@]}"; do
  if ! (cd "$WT" && timeout 900 bash -c "$c") >> "$STATE/gate.log" 2>&1; then
    park "verification failed: $c (see gate.log)"
  fi
done

# Gate 2: model review for big handoffs
if [ "$SIZE" = big ]; then
  DIFF=$(git -C "$WT" diff "$BASE...HEAD" | head -c 200000)
  PROMPT="Review this diff against the handoff contract. Contract:
$(cat "$STATE/HANDOFF.md")

Diff:
$DIFF

Judge ONLY: does the diff satisfy the contract without bugs, security issues, or scope creep?"
  REVIEWER=$(claude-quota --reviewer || true)
  APPROVED=""
  if [ -n "$REVIEWER" ] && command -v claude >/dev/null 2>&1; then
    DIRSUFFIX=""; [ "$REVIEWER" = work ] && DIRSUFFIX="-work"
    VERDICT=$(CLAUDE_CONFIG_DIR="$HOME/.claude$DIRSUFFIX" claude -p "$PROMPT
Reply with exactly APPROVE or REJECT: <reason> as your final line." 2>>"$STATE/gate.log" | tail -5)
    case "$VERDICT" in *APPROVE*) APPROVED=yes;; *REJECT*) APPROVED=no;; esac
  fi
  if [ -z "$APPROVED" ]; then   # no Claude budget (or no verdict) -> agy self-review, smartest model
    V=$(agy-run --model "${AGY_REVIEW_MODEL:-}" --effort high --timeout 15m --json \
        --schema '{"type":"object","properties":{"approve":{"type":"boolean"},"reason":{"type":"string"}},"required":["approve"]}' \
        -- "$PROMPT") || park "review run failed (agy-run exit $?)"
    if [ "$(printf '%s' "$V" | jq -r '.structured_output.approve')" = true ]; then APPROVED=yes
    else park "review rejected: $(printf '%s' "$V" | jq -r '.structured_output.reason // "no reason"')"; fi
  fi
  [ "$APPROVED" = yes ] || park "review rejected (see gate.log)"
fi

# Gate 3: merge — never agy's job; ours, with a busy-repo guard
[ "$AUTOMERGE" = true ] || { meta_set status ready; notify "green + reviewed — auto-merge disabled, branch $BRANCH ready"; exit 0; }
CUR=$(git -C "$REPO" symbolic-ref --short HEAD 2>/dev/null || echo DETACHED)
CLEAN=$(git -C "$REPO" status --porcelain)
if [ "$CUR" != "$BASE" ] || [ -n "$CLEAN" ]; then
  meta_set status ready
  notify "green but repo busy (on $CUR, dirty=$([ -n "$CLEAN" ] && echo yes || echo no)) — branch $BRANCH ready to merge manually"
  exit 0
fi
if git -C "$REPO" merge --no-ff -m "merge agy handoff $ID" "$BRANCH" >> "$STATE/gate.log" 2>&1; then
  git -C "$REPO" worktree remove "$WT" --force >> "$STATE/gate.log" 2>&1 || true
  git -C "$REPO" branch -d "$BRANCH" >> "$STATE/gate.log" 2>&1 || true
  meta_set status merged; notify "MERGED into $BASE"
  exit 0
else
  git -C "$REPO" merge --abort 2>/dev/null || true
  park "merge conflict with $BASE — resolve from $WT"
fi
```

- [ ] **Step 2: End-to-end happy path with the stub (small handoff → merged)**

```bash
t=$(mktemp -d)
cat > "$t/agy" <<'STUB'
#!/usr/bin/env bash
if [ "${1:-}" = "-p" ]; then
  case "$2" in
    *executing\ handoff*|*Continue\ handoff*)
      echo ok > done.txt; git add -A; git commit -qm "stub work"
      echo '{"conversation_id":"c-9","status":"SUCCESS"}';;
    *) echo '{"conversation_id":"c-r","status":"SUCCESS","response":"{\"approve\":true}","structured_output":{"approve":true}}';;
  esac
fi
STUB
chmod +x "$t/agy"
git init -qb main "$t/repo" && git -C "$t/repo" commit -qm init --allow-empty
id=$(AGY_BIN="$t/agy" agy-handoff start --repo "$t/repo" --foreground --verify "test -f done.txt" "create done.txt")
jq -r .status ~/.local/state/agy-handoffs/$id/meta.json
git -C "$t/repo" log --oneline -1
```

Expected: status `merged`; repo log shows `merge agy handoff <id>`.

- [ ] **Step 3: Park paths**

Same setup, but `--verify "test -f nope.txt"` → expect status `parked`, reason `verification failed…`, exit 10. And a stub with no commit (`echo` only) → expect reason `no commits…`. And a `--size big` run with the stub's review branch returning `"approve":false, "reason":"bad"` → expect `review rejected: bad`. And busy-repo: make the main repo dirty (`touch "$t/repo/x"`) before a green small handoff → expect status `ready` with "repo busy" in events.log.

- [ ] **Step 4: Static checks**

Run: `bash -n agy/bin/agy-gate && shellcheck -S error agy/bin/agy-gate && echo OK`
Expected: `OK`

- [ ] **Step 5: Manifest + commit**

Add `agy/bin/agy-gate` to `scripts/manifest.txt` (sorted).

```bash
./scripts/preflight.sh | tail -1   # expect ALL CLEAN
git add agy/bin/agy-gate scripts/manifest.txt
git commit -m "feat(agy): agy-gate — re-run verification, review escalation, auto-merge policy"
```

---

### Task 6: `ag` — interactive launcher (cc pattern, single account)

**Files:**
- Create: `agy/bin/ag`
- Modify: `scripts/manifest.txt`

**Interfaces:**
- Consumes: `agy` on PATH (or `AGY_BIN`); tmux.
- Produces: `ag [dir] [-- <agy flags…>]`; tmux session `agy-<slug>`, duplicate-session `[Enter]/[n]/[q]` prompt, `-2/-3` suffixes. Sessions appear in the web dashboard automatically (web-term.sh lists all tmux sessions).

- [ ] **Step 1: Write `agy/bin/ag`** (clone of `fleet/bin/cc` minus the profile machinery)

```bash
#!/usr/bin/env bash
# ag — launch Antigravity CLI (agy) in a named tmux session, cc-style.
# usage: ag [dir] [-- <agy flags...>]     (bare `ag` = current directory)
# tmux session: agy-<slug-of-dir-basename> (+ -2, -3 … for deliberate seconds).
# watchdogs/bin/reap-idle-claude reaps ^agy- when detached+idle but NEVER
# ^agyh- (running handoffs) — this naming is that contract; don't change it.
set -euo pipefail
CFG="$HOME/.config/mows-agy/config"; [ -f "$CFG" ] && . "$CFG"
AGY=${AGY_BIN:-agy}

case "${1-}" in
  -h|--help)
    cat <<'EOF'
usage: ag [dir] [-- <agy flags...>]

  ag                  antigravity CLI, current directory
  ag <dir>            antigravity CLI, in <dir>
  ag -- --continue    pass flags through to agy itself

Runs agy inside tmux session agy-<slug> when attached to a terminal, so a
dropped connection never kills the session; execs agy directly otherwise.
If that directory already has a live session, asks whether to work in it or
start a second one alongside it (agy-<slug>-2, -3 …).
EOF
    exit 0 ;;
esac

command -v "$AGY" >/dev/null 2>&1 || { echo "ag: '$AGY' not found — install: curl -fsSL https://antigravity.google/cli/install.sh | bash" >&2; exit 1; }

DIR=$PWD; if [ $# -ge 1 ] && [ "$1" != "--" ]; then DIR=$1; shift; fi; [ "${1-}" = "--" ] && shift
RUN=("$AGY" "$@")

if [ -z "${TMUX:-}" ] && [ -t 0 ]; then
  SLUG=$(basename "$DIR" | tr '[:upper:]' '[:lower:]' | tr -c 'a-z0-9\n' '-' | sed 's/^-*//;s/-*$//')
  SES="agy-$SLUG"
  if tmux has-session -t "=$SES" 2>/dev/null; then
    printf 'ag: an agy session is already running in %s\n' "$DIR"
    printf '    %s · %s\n' "$SES" \
      "$(tmux display -p -t "=$SES" '#{?session_attached,attached on another client,detached}' 2>/dev/null || echo live)"
    printf '  [Enter] work in that one   [n] new session, same directory   [q] quit\n'
    read -rp '  > ' ANS || ANS=q
    case "$ANS" in
      n|N|new) N=2
               while tmux has-session -t "=$SES-$N" 2>/dev/null; do N=$((N+1)); done
               SES="$SES-$N"; printf 'ag: starting %s\n' "$SES" ;;
      q|Q) exit 0 ;;
      *) exec tmux attach -d -t "=$SES" ;;
    esac
  fi
  exec tmux new-session -AD -s "$SES" -c "$DIR" "$(printf '%q ' "${RUN[@]}")"
elif env -C / true 2>/dev/null; then
  exec env -C "$DIR" "${RUN[@]}"
else
  cd "$DIR" && exec "${RUN[@]}"
fi
```

- [ ] **Step 2: Behavior check with a stub agy** (same pattern as e2e's cc test)

```bash
t=$(mktemp -d); printf '#!/bin/sh\nexec sleep 300\n' > "$t/agy"; chmod +x "$t/agy"
mkdir -p "$t/projx"
export TERM=xterm-256color
printf '\n' | timeout 8 script -qec "AGY_BIN=$t/agy agy/bin/ag $t/projx" /dev/null >/dev/null 2>&1; sleep 1
tmux has-session -t '=agy-projx' && echo SESSION-OK
printf 'q\n' | timeout 8 script -qec "AGY_BIN=$t/agy agy/bin/ag $t/projx" /dev/null | grep -q 'already running' && echo PROMPT-OK
tmux kill-server 2>/dev/null
```

Expected: `SESSION-OK` then `PROMPT-OK`.

- [ ] **Step 3: Static checks + `ag --help`**

Run: `bash -n agy/bin/ag && shellcheck -S error agy/bin/ag && agy/bin/ag --help | grep -q 'usage: ag' && echo OK`
Expected: `OK`

- [ ] **Step 4: Manifest + commit**

Add `agy/bin/ag` to `scripts/manifest.txt` (sorted).

```bash
./scripts/preflight.sh | tail -1   # expect ALL CLEAN
git add agy/bin/ag scripts/manifest.txt
git commit -m "feat(agy): ag launcher — cc-style tmux sessions for antigravity"
```

---

### Task 7: Reaper awareness of agy sessions

**Files:**
- Modify: `watchdogs/bin/reap-idle-claude:18-19` (the `tmux ls | awk` pipeline)

**Interfaces:**
- Consumes: tmux session names from Tasks 4/6 (`agy-<slug>`, `agyh-<id>`).
- Produces: idle detached `agy-*` sessions reaped like `cc-*`; `agyh-*` NEVER matched.

- [ ] **Step 1: Extend the awk matcher**

Replace (in `watchdogs/bin/reap-idle-claude`):

```bash
mapfile -t sessions < <(tmux ls -F '#{session_name} #{session_attached} #{session_activity}' 2>/dev/null |
  awk -v now="$now" -v idle="$IDLE" '$1 ~ /^cc-/ && $2==0 && (now-$3) > idle {print $1}')
```

with:

```bash
# agy- (interactive antigravity, from ag) is reaped like cc-; agyh- (running
# handoff sessions, from agy-handoff) is a DIFFERENT prefix on purpose and
# must never match — those terminate themselves via their command chain.
mapfile -t sessions < <(tmux ls -F '#{session_name} #{session_attached} #{session_activity}' 2>/dev/null |
  awk -v now="$now" -v idle="$IDLE" '($1 ~ /^cc-/ || $1 ~ /^agy-/) && $2==0 && (now-$3) > idle {print $1}')
```

Also update the header comment's first line to say `(cc-<profile>-* and agy-*)`.

- [ ] **Step 2: Live-logic test (no waiting: IDLE=1)**

```bash
tmux new-session -d -s agy-reaptest 'sleep 300'
tmux new-session -d -s agyh-reaptest 'sleep 300'
tmux new-session -d -s other-reaptest 'sleep 300'
sleep 2
IDLE=1 watchdogs/bin/reap-idle-claude
tmux has-session -t '=agy-reaptest'  2>/dev/null && echo "FAIL: agy- not reaped" || echo "OK: agy- reaped"
tmux has-session -t '=agyh-reaptest' 2>/dev/null && echo "OK: agyh- survived" || echo "FAIL: agyh- reaped"
tmux has-session -t '=other-reaptest' 2>/dev/null && echo "OK: other survived" || echo "FAIL: other reaped"
tmux kill-server 2>/dev/null
```

Expected: `OK: agy- reaped`, `OK: agyh- survived`, `OK: other survived`.

- [ ] **Step 3: Static checks + commit**

Run: `bash -n watchdogs/bin/reap-idle-claude && shellcheck -S error watchdogs/bin/reap-idle-claude && echo OK`
Expected: `OK`

```bash
./scripts/preflight.sh | tail -1   # expect ALL CLEAN
git add watchdogs/bin/reap-idle-claude
git commit -m "feat(agy): reap idle agy- sessions; agyh- handoffs are never touched"
```

---

### Task 8: Claude-side policy — skill, CLAUDE.md rule, SessionStart hook, counts

**Files:**
- Create: `claude/skills/agy-delegate/SKILL.md`
- Modify: `claude/global/CLAUDE.md` (append section)
- Modify: `claude/settings.template.json` (SessionStart hook)
- Modify: `README.md` (three count spots: "9 commands, 11 skills" ×2 and `# expect 11`)
- Modify: `scripts/e2e-container.sh:33` (`skills == 11` → `12`)
- Modify: `scripts/manifest.txt`

**Interfaces:**
- Consumes: script contracts from Tasks 2-5 (exact flags as defined there).
- Produces: the skill Claude loads to delegate; the always-on quota context line.

- [ ] **Step 1: Write `claude/skills/agy-delegate/SKILL.md`**

```markdown
---
name: agy-delegate
description: Delegate implementation work to the Antigravity CLI (agy) — automatically when the active Claude account is at ≥70% of its 5-hour or weekly limit (check with claude-quota), or whenever the user asks. Covers synchronous delegation (agy-run), fire-and-forget handoffs in isolated git worktrees (agy-handoff), the gate/review/merge policy (agy-gate), and resuming or reviewing parked branches.
---

# Delegating to Antigravity (agy)

## When

1. **Auto:** before sizeable implementation work, run `claude-quota --check`
   (exit 1 = active account ≥70%). Over threshold → delegate instead of
   implementing yourself. Exit 2 (unknown) → do NOT auto-delegate.
2. **Manual:** the user asks ("delegate this", "use agy", "fire a handoff").

## Synchronous (small/medium, you stay in the loop)

    agy-run [--fast] [--model SLUG] [--effort low|medium|high] [--timeout 10m] -- "PROMPT"

- stdout = the response. Exit 2 = agy quota exhausted (empty-response bug —
  report it, don't retry blindly). Exit 3 = agy needs re-login (`ag`).
- `--fast` uses the flash-tier slug from `~/.config/mows-agy/config` — use it
  for summaries/extraction/read-heavy work to preserve agy quota.
- Review the result yourself before integrating it. You are the review gate
  on this path.

## Fire-and-forget handoff (big work, zero further Claude tokens)

1. Write the contract file (this shape, verify block MANDATORY):

       # Handoff: <title>
       ## Task
       <what to build, file paths, constraints>
       ## Acceptance criteria
       - <objectively checkable bullets>
       ## Verification commands (must exit 0)
       ```verify
       <test/lint/build commands, one per line>
       ```

2. Start it (size `big` = >~3 files, >~150 LOC expected, or architectural —
   big gets a model review before merge; small merges on green verification):

       agy-handoff start --repo <abs-repo-path> --size big --task <contract-file>

3. It runs detached in tmux session `agyh-<id>`, visible in the web dashboard.
   The gate auto-runs when agy finishes: re-verification → (big) review by
   Claude-with-budget or agy on AGY_REVIEW_MODEL → auto-merge when green;
   anything red parks the branch and notifies.

## Model tiers

Pick a tier, never a hardcoded slug: default (no flag — implementation),
`--fast` (cheap sync tasks), review tier is the gate's job. Slugs live only
in `~/.config/mows-agy/config`.

## Session-start duty

If the quota context line shows an account ≥70%, or `agy-handoff list` shows
`parked`/`ready`/`STALE` entries, surface them to the user early. `ready` =
green but waiting on a manual merge; `parked` shows its reason; `STALE` =
session died (reboot?) — offer `agy-handoff resume <id>`. When you have
budget, review parked/ready branches: diff is `git -C <state>/wt diff
<base>...HEAD` (paths via `agy-handoff path <id>` and meta.json).
```

- [ ] **Step 2: Append the rule to `claude/global/CLAUDE.md`**

```markdown

# Antigravity delegation (agy)

Before starting sizeable implementation work, run `claude-quota --check`. If
the active account is at ≥70% of its 5-hour or weekly limit (exit 1), don't
burn the remainder — delegate per the `agy-delegate` skill (synchronous
`agy-run` for small tasks, `agy-handoff` worktree handoffs for big ones).
Also delegate whenever the user explicitly asks. `unknown` quota (exit 2)
means no auto-delegation. At session start, surface any `parked`/`ready`
handoffs from `agy-handoff list`.
```

- [ ] **Step 3: Add the SessionStart hook to `claude/settings.template.json`**

Add this top-level key (alongside `"statusLine"`):

```json
"hooks": {
  "SessionStart": [
    {"hooks": [{"type": "command", "command": "command -v claude-quota >/dev/null 2>&1 && claude-quota --line || true"}]}
  ]
},
```

- [ ] **Step 4: Flip the pinned counts**

- `README.md`: both `9 commands, 11 skills` → `9 commands, 12 skills`; the `ls ~/.claude/skills | wc -l            # expect 11` line → `# expect 12`.
- `scripts/e2e-container.sh:33`: `chk "skills == 11"             '[ "$(ls $HOME/.claude/skills | wc -l)" = 11 ]'` → `12` in both spots (label and test).

- [ ] **Step 5: Verify template parses and hook survives render**

Run: `python3 -m json.tool claude/settings.template.json >/dev/null && echo JSON-OK`
Expected: `JSON-OK`

Run: `TH=$(mktemp -d); HOME="$TH" ./install.sh --claude --non-interactive >/dev/null && python3 -m json.tool "$TH/.claude/settings.json" >/dev/null && ls "$TH/.claude/skills" | wc -l && grep -c claude-quota "$TH/.claude/settings.json"; rm -rf "$TH"`
Expected: `12` skills and `1` hook occurrence.

- [ ] **Step 6: Manifest + commit**

Add `claude/skills/agy-delegate/SKILL.md` to `scripts/manifest.txt` (sorted).

```bash
./scripts/preflight.sh | tail -1   # expect ALL CLEAN
git add claude/ README.md scripts/e2e-container.sh scripts/manifest.txt
git commit -m "feat(agy): agy-delegate skill, CLAUDE.md rule, quota SessionStart hook (skills 11->12)"
```

---

### Task 9: Installer layer `--agy`, SETUP docs, e2e coverage

**Files:**
- Create: `agy/SETUP.md`
- Modify: `install.sh` (usage text, flag parsing, picker, `layer_agy()`, dispatch)
- Modify: `scripts/e2e-container` (add `jq` to the apt install line)
- Modify: `scripts/e2e-container.sh` (install `--agy`; new checks)
- Modify: `README.md` (layers table row + layer list line)
- Modify: `scripts/manifest.txt`

**Interfaces:**
- Consumes: all `agy/bin/*` scripts and `agy/config.example`.
- Produces: `./install.sh --agy` → scripts in `~/.local/bin`, config seeded at `~/.config/mows-agy/config` (never clobbered), state dir created; `--all` includes it.

- [ ] **Step 1: install.sh — usage, flags, picker, dispatch**

In the `usage()` heredoc add: `  --agy             antigravity delegation CLIs (ag, agy-run, agy-handoff, agy-gate, claude-quota) -> ~/.local/bin`. Extend the arg loop: `--agy) L_AGY=1;;`, add `L_AGY=0` to the init line, add `L_AGY=1` to `--all`, add picker option `5) agy` (`[[ $ans == *5* ]] && L_AGY=1`, and include in the zero-selected sum checks). Add to the dispatch block at the bottom: `[ "$L_AGY" = 1 ] && layer_agy`.

- [ ] **Step 2: install.sh — `layer_agy()`** (insert after `layer_fleet()`)

```bash
layer_agy(){
  echo "== agy (antigravity delegation) =="
  mkdir -p "$HOME/.local/bin" "$HOME/.config/mows-agy" "$HOME/.local/state/agy-handoffs"
  install -m755 agy/bin/ag agy/bin/agy-run agy/bin/agy-handoff agy/bin/agy-gate \
    agy/bin/claude-quota "$HOME/.local/bin/"
  # config is user-owned after first install: seed only if absent, never clobber
  if [ ! -f "$HOME/.config/mows-agy/config" ]; then
    install -m644 agy/config.example "$HOME/.config/mows-agy/config"
    echo "seeded ~/.config/mows-agy/config — set model slugs there after running: agy models"
  fi
  echo "installed: ag agy-run agy-handoff agy-gate claude-quota -> ~/.local/bin"
  if ! command -v agy >/dev/null 2>&1; then
    echo "antigravity CLI (agy) not found — install it yourself when ready (never run by this script):"
    echo "  curl -fsSL https://antigravity.google/cli/install.sh | bash"
    echo "then login once over SSH (agy prints a URL + one-time code) and see agy/SETUP.md"
  fi
}
```

- [ ] **Step 3: Write `agy/SETUP.md`**

```markdown
# agy layer — Antigravity delegation + sessions

What ships: `ag` (cc-style tmux launcher), `agy-run` (sync delegation,
fail-loud), `agy-handoff`/`agy-gate` (worktree handoffs with verification →
review → auto-merge policy), `claude-quota` (per-account usage signal; the
70% threshold lives there). Design:
`docs/superpowers/specs/2026-08-10-antigravity-delegation-design.md`.

## One-time setup on a box

1. `./install.sh --agy` (plus `--claude` for the skill/rule/hook).
2. Install the antigravity CLI (the installer never does this for you):
   `curl -fsSL https://antigravity.google/cli/install.sh | bash`
3. Login once: run `agy` in a terminal — over SSH it prints a URL + one-time
   code. **Verify persistence:** open a NEW shell, run
   `agy -p "ping" --output-format json` — if it demands login again, the box
   lacks a freedesktop-secrets keyring (headless-Linux issue
   google-antigravity/antigravity-cli#57): install `gnome-keyring` + `dbus`
   and enable a user-session keyring, then re-login and re-verify.
4. `agy models` → copy your preferred slugs into
   `~/.config/mows-agy/config` (`AGY_FAST_MODEL`, `AGY_REVIEW_MODEL`).
   Record the agy version here when you deploy: `agy --version`.
5. Optional notifications: set `AGY_NOTIFY_CMD` in the config to any command
   taking the message as `$1` (e.g. a Discord/openclaw send wrapper).
   Fallback is always `~/.local/state/agy-handoffs/events.log` +
   `agy-handoff list`.

## Live smoke (proves the whole chain)

    t=$(mktemp -d) && git init -qb main "$t/r" && git -C "$t/r" commit -qm init --allow-empty
    agy-handoff start --repo "$t/r" --size small --verify "test -f hello.txt" \
      "Create hello.txt containing the word hello, commit it."
    # watch: tmux attach -t agyh-<id>   or the /term dashboard
    agy-handoff list          # expect: merged
    git -C "$t/r" log --oneline   # expect the merge commit

## Day-2

- Sessions: `ag [dir]` (interactive, reaped when idle+detached like cc);
  handoffs run as `agyh-<id>` (never reaped).
- `agy-handoff list` states: running / gated / parked(reason) / ready
  (green, waiting for a manual merge) / merged. `STALE` marks a dead session
  (e.g. reboot) — `agy-handoff resume <id>` continues it via agy's
  `--conversation`.
- agy quota exhausted mid-run shows up as a park with "no commits" or a
  verification failure — resume after Google's reset.
```

- [ ] **Step 4: e2e wrapper — add jq**

In `scripts/e2e-container`, extend the apt line to include `jq`:
`apt-get install -y -qq git curl systemd tmux cron sudo python3 shellcheck ca-certificates gnupg jq >/dev/null 2>&1`

- [ ] **Step 5: e2e-container.sh — install `--agy` and add checks**

Change the install line (step 2 section) to:
`./install.sh --claude --watchdogs --fleet --agy --non-interactive > /tmp/inst.log 2>&1`

Append a new section before the crontab section:

```bash
echo "### agy layer"
chk "agy: ag"           "[ -x $HOME/.local/bin/ag ]"
chk "agy: agy-run"      "[ -x $HOME/.local/bin/agy-run ]"
chk "agy: agy-handoff"  "[ -x $HOME/.local/bin/agy-handoff ]"
chk "agy: agy-gate"     "[ -x $HOME/.local/bin/agy-gate ]"
chk "agy: claude-quota" "[ -x $HOME/.local/bin/claude-quota ]"
chk "agy: config seeded"    "[ -f $HOME/.config/mows-agy/config ]"
chk "agy: ag --help"        "ag --help | grep -q 'usage: ag'"
chk "claude-quota selftest" "claude-quota --selftest"
chk "agy-run selftest"      "agy-run --selftest"

# full handoff chain against a stub agy that commits work then approves reviews
mkdir -p "$HOME/stubagy"
cat > "$HOME/stubagy/agy" <<'STUB'
#!/usr/bin/env bash
if [ "${1:-}" = "-p" ]; then case "$2" in
  *"executing handoff"*|*"Continue handoff"*)
    echo ok > done.txt; git add -A; git commit -qm "stub work"
    echo '{"conversation_id":"c-9","status":"SUCCESS"}';;
  *) echo '{"status":"SUCCESS","response":"r","structured_output":{"approve":true}}';;
esac; fi
STUB
chmod +x "$HOME/stubagy/agy"
git init -qb main "$HOME/agyrepo" && git -C "$HOME/agyrepo" -c user.email=t@t -c user.name=t commit -qm init --allow-empty
hid=$(AGY_BIN="$HOME/stubagy/agy" agy-handoff start --repo "$HOME/agyrepo" --foreground \
      --verify "test -f done.txt" "create done.txt" 2>/dev/null) || true
chk "handoff merged on green"  "jq -e '.status==\"merged\"' $HOME/.local/state/agy-handoffs/$hid/meta.json"
chk "merge commit in repo"     "git -C $HOME/agyrepo log --oneline | grep -q 'agy handoff'"
hid2=$(AGY_BIN="$HOME/stubagy/agy" agy-handoff start --repo "$HOME/agyrepo" --foreground \
       --verify "test -f nope.txt" "park me" 2>/dev/null) || true
chk "handoff parks on red"     "jq -e '.status==\"parked\"' $HOME/.local/state/agy-handoffs/$hid2/meta.json"
chk "handoff refuses no-verify" "! agy-handoff start --repo $HOME/agyrepo \"no verify\""

echo "### reaper: agy- reaped, agyh- never"
tmux new-session -d -s agy-e2e 'sleep 300'; tmux new-session -d -s agyh-e2e 'sleep 300'; sleep 2
IDLE=1 reap-idle-claude
chk "idle agy- reaped"    "! tmux has-session -t '=agy-e2e'"
chk "agyh- never reaped"  "tmux has-session -t '=agyh-e2e'"
tmux kill-server 2>/dev/null || true
```

(Note: the container has no git identity — hence the `-c user.email/-c user.name` on the init commit; the stub's commits inherit the worktree repo config, so also run `git config --global user.email t@t; git config --global user.name t` at the top of this section to keep the stub's `git commit` working.)

- [ ] **Step 6: README — document the layer**

Add to the layer list (line ~21 area): `- **agy** — antigravity delegation: \`ag\` launcher, \`agy-run\`, \`agy-handoff\`/\`agy-gate\`, \`claude-quota\` → \`~/.local/bin\``. Add a row to the layers table (line ~62 area): `| **agy** | \`--agy\` | \`ag\`, \`agy-run\`, \`agy-handoff\`, \`agy-gate\`, \`claude-quota\` → \`~/.local/bin\`; config seeded at \`~/.config/mows-agy/config\` | No — config never clobbered |`.

- [ ] **Step 7: Manifest, static checks, preflight, commit**

Add `agy/SETUP.md` to `scripts/manifest.txt` (sorted).

Run: `bash -n install.sh && shellcheck -S error install.sh && ./scripts/preflight.sh | tail -1`
Expected: `preflight: ALL CLEAN`

```bash
git add install.sh agy/SETUP.md scripts/ README.md
git commit -m "feat(agy): --agy install layer, SETUP walkthrough, e2e coverage"
```

---

### Task 10: Full validation + ship

**Files:** none new — this is the gate.

- [ ] **Step 1: Full e2e container run**

Run: `./scripts/e2e-container 2>&1 | tail -15`
Expected: `RESULT: <N> passed, 0 failed` (N ≈ 90: the prior 71 plus the new agy/reaper checks and count changes). Any FAIL → fix before proceeding, re-run until 0 failed.

- [ ] **Step 2: Push + CI**

```bash
git push origin main
gh run watch "$(gh run list --limit 1 --json databaseId -q '.[0].databaseId')" --exit-status
```

Expected: CI `completed / success`.

---

### Task 11: LIVE deploy on the box (needs the user for login)

**Files:** none in-repo (live-box actions + one follow-up docs commit).

- [ ] **Step 1: Deploy the layers**

Run (repo root): `./install.sh --agy` then `./install.sh --claude` (refreshes skill/rule/hook; backups land in `~/.claude.bak-<ts>`). Mirror the CLAUDE.md/settings changes into `~/.claude-work/` too (that profile is hand-managed): append the CLAUDE.md section and the hook to its settings, matching what `--claude` did for `~/.claude`.

- [ ] **Step 2: Install + login agy (USER STEP)**

Run: `curl -fsSL https://antigravity.google/cli/install.sh | bash`, then `agy` — user completes the URL + one-time-code login with their Google AI Pro account.

- [ ] **Step 3: Auth persistence check**

Run in a NEW shell: `agy -p "ping" --output-format json | jq .status`
Expected: `"SUCCESS"` with no login prompt. If it re-asks: `sudo apt-get install -y gnome-keyring dbus-user-session`, re-login, re-verify (issue #57 mitigation), and document what was needed in `agy/SETUP.md`.

- [ ] **Step 4: Record reality into config + SETUP**

Run: `agy --version && agy models`. Set `AGY_FAST_MODEL`/`AGY_REVIEW_MODEL` in `~/.config/mows-agy/config`; note version + chosen slugs in `agy/SETUP.md`. Check `claude-quota --line` returns real percentages for both accounts (this validates the usage endpoint — if it returns `?`, run `claude-quota --refresh` and inspect; if the endpoint shape differs, fix `parse_usage` accordingly and add the real payload shape as a selftest fixture).

- [ ] **Step 5: Wire notifications**

Inspect `openclaw --help` for a send/message subcommand; wrap it as `AGY_NOTIFY_CMD` in the config (a one-line wrapper script in `~/.local/bin` if it needs fixed args). If nothing suitable, leave log-only.

- [ ] **Step 6: Live smoke — real handoff end-to-end**

Run the "Live smoke" block from `agy/SETUP.md` (toy repo → real agy → merged). Watch via `tmux attach -t agyh-<id>` or the /term dashboard; confirm the dashboard lists the `agyh-*` session and `ag ~` shows up as `agy-<slug>`.
Expected: `agy-handoff list` ends at `merged`; merge commit present.

- [ ] **Step 7: Commit any SETUP/parse fixes discovered live**

```bash
./scripts/preflight.sh | tail -1   # ALL CLEAN
git add -A && git commit -m "docs(agy): record live agy version/models/keyring findings" && git push
```

---

## Self-Review (done at plan-writing time)

- **Spec coverage:** Phase 0 → Tasks 9 (layer/SETUP) + 11 (install/login/keyring/persistence). claude-quota → T2. agy-run → T3. agy-handoff → T4. agy-gate (incl. review escalation, busy-repo guard, notifications) → T5. Model-selection tier table → config (T2) + skill (T8). Claude-side policy (skill/rule/hook) → T8. `ag` launcher → T6. Dashboard pickup → zero-change (verified live in T11.6). Reaper → T7. Error handling table → T3 exit codes, T5 park paths, T4 list/STALE/resume, quota-unknown semantics in T2. Testing section → selftests per script + T9 e2e + T11 live smoke. One deviation (worktree location) applied to the spec in T1.
- **Placeholder scan:** no TBDs; every code step carries the actual code; the two "expected" ambiguities (usage-endpoint payload shape, openclaw send syntax) are explicitly probe-and-record live steps, not placeholders.
- **Type consistency:** exit-code contracts (agy-run 0/1/2/3; --check 0/1/2; gate 0/10), meta.json fields, state-dir layout, session prefixes (`agy-`/`agyh-`), and flag names cross-checked across T2-T9 and the skill text.
