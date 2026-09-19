# Agent Memory and Identity Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give every mows agent a bounded, operator-readable memory file that survives months, and re-assert its identity on every call — run and chat — so nothing load-bearing lives in a Claude session.

**Architecture:** `mows-agent` owns `$STATE_ROOT/<name>/memory.md`. Both `run_context()` and a new `chat_context()` inject it through `--append-system-prompt`; `store_memory()` extracts the last ```` ```mows-memory ```` fence from each reply and writes the file atomically under a hard cap. Chat drops `--resume` and takes run mode's exact shape (`--agent` + appended context) with the last 12 `chat.jsonl` entries injected as text. `cmd_prune` caps `chat.jsonl`. The dashboard reads memory, never writes it.

**Tech Stack:** bash (`agents/bin/mows-agent`), jq, awk; Node ESM (`infra/dashboard/lite.mjs`), Preact+htm (`app/views/*.mjs`); bash test harness with a stub `claude` (`scripts/e2e-agents.sh`).

**Spec:** `docs/superpowers/specs/2026-09-19-agent-memory-and-identity-design.md`

## Global Constraints

- Memory cap: **4096 bytes / 60 lines**, whichever first; cut at a complete line; write the truncated file; event `memory truncated: <N> bytes / <M> lines offered, cap 4096/60` (spec D5, §1).
- Chat context: **last 12 `chat.jsonl` entries**, each text cut at **2000 chars** + `[…]` (spec §2.3).
- `chat.jsonl` ceiling: keep last **200** entries; event `chat.jsonl trimmed: <N> entries dropped` (spec §1.1).
- Every file write is `.tmp` + `mv` (spec §1).
- Extraction matches the **last** fence whose info string is exactly `mows-memory`; no block = leave file untouched, no event; empty block = clear file, event `memory cleared by agent` (spec §3).
- Chat passes `--agent "$n"` and `--append-system-prompt`, never `--resume`. Chat no longer requires a completed run. The mid-run refusal stays with new text (spec §2.4).
- `--` before `"$msg"` in `cmd_chat` is load-bearing and must be preserved.
- No `style=` attributes in `infra/dashboard/app/` (CSP). Fonts/vendor untouched.
- The live host must never appear in a tracked file or CI log.
- `mows-agent-meta` is untouched. `MOWS_KEYS` unchanged.
- Every new behaviour has a `chk` in `scripts/e2e-agents.sh`; the two live measurements go in `scripts/live-agents.sh` and never run in CI.
- Commit trailer: `Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>` and `Claude-Session: https://claude.ai/code/session_01NrdcR8JQHSTudFBHJRT7BF`.

---

### Task 1: `store_memory` — extraction, cap, atomic write

**Files:**
- Modify: `agents/bin/mows-agent` (constants near line 342; new functions after `event()` ~line 129)
- Modify: `scripts/e2e-agents.sh` (stub `claude` gains mode `memblock`; new section after `### chat --stream`)

**Interfaces:**
- Produces: `store_memory <name> <reply-text>` (bash function, no output, writes `$STATE_ROOT/<name>/memory.md`, events via `event()`); constants `MEM_MAX_BYTES=4096`, `MEM_MAX_LINES=60`.

- [ ] **Step 1: Teach the stub `claude` to emit a result whose text comes from a file**

In `scripts/e2e-agents.sh`, inside the `cat > "$T/shim/claude" <<'S'` heredoc, add a new env var to the header comment and a new mode. After the `res(){ … }` definition and before `case $mode in`, nothing changes; add to the `case`:

```bash
  # memblock: the result text is read verbatim from $CLAUDE_RESULT_FILE and JSON-encoded by
  # jq, so a test can hand over a reply containing a fenced mows-memory block (newlines,
  # backticks) without fighting the single-quoted interpolation res() uses.
  memblock)   jq -nc --arg sid "$sid" --rawfile r "${CLAUDE_RESULT_FILE:-/dev/null}" \
                '{type:"result",subtype:"success",is_error:false,terminal_reason:"completed",num_turns:2,session_id:$sid,total_cost_usd:0.0123,permission_denials:[],result:$r}';;
```

And export the variable with the others near the top: change the `export CLAUDE_MODE_FILE=…` line to also include `CLAUDE_RESULT_FILE="$T/claude-result"`.

- [ ] **Step 2: Write the failing tests**

Append to `scripts/e2e-agents.sh` immediately before the line `echo "### dashboard chat stream (Step 4 JS, no server/spawn needed — F2/F10)"`:

```bash
echo "### memory: store_memory via run"
M="$MOWS_AGENTS_STATE/good/memory.md"
memrun(){ printf '%s' "$1" > "$CLAUDE_RESULT_FILE"; echo memblock > "$CLAUDE_MODE_FILE"; mows-agent run good >/dev/null 2>&1; }
rm -f "$M"
memrun $'Report done.\n\n```mows-memory\nnewest: abc123\nopen: none\n```\n'
chk "memory: block stored as file body"        '[ "$(cat "$M")" = $'"'"'newest: abc123\nopen: none'"'"' ]'
chk "memory: stored event written"             'grep -q "memory stored: " "$MOWS_AGENTS_STATE/good/events.log"'
memrun $'Done.\n```mows-memory\nnewest: def456\n```\n'
chk "memory: second block replaces, not appends" '[ "$(cat "$M")" = "newest: def456" ]'
cp "$M" "$T/mem-before"; E0=$(grep -c "memory" "$MOWS_AGENTS_STATE/good/events.log")
memrun $'Nothing to remember this time.\n'
chk "memory: no block leaves file byte-identical" 'cmp -s "$M" "$T/mem-before"'
chk "memory: no block writes no memory event"     '[ "$(grep -c "memory" "$MOWS_AGENTS_STATE/good/events.log")" = "$E0" ]'
memrun $'Forget it.\n```mows-memory\n```\n'
chk "memory: empty block clears the file"      '[ -f "$M" ] && [ ! -s "$M" ]'
chk "memory: clear is logged"                  'grep -q "memory cleared by agent" "$MOWS_AGENTS_STATE/good/events.log"'
memrun $'My memory was:\n```mows-memory\nold: 1\n```\nNow updated:\n```mows-memory\nnew: 2\n```\n'
chk "memory: LAST block wins"                  '[ "$(cat "$M")" = "new: 2" ]'
memrun $'Quoting a doc:\n````\n```mows-memory\nnot me\n```\n````\n```mows-memory\nreal: yes\n```\n'
chk "memory: fence inside a wider fence is not the match" '[ "$(cat "$M")" = "real: yes" ]'
memrun $'```mows-memory\nreal: yes\n```\nLater I wrote ```mows-memory-notes``` too.\n'
chk "memory: info string must be exact, not a prefix" '[ "$(cat "$M")" = "real: yes" ]'
big=$(python3 -c 'print("\n".join("line %03d: " % i + "x"*60 for i in range(80)))')
memrun "$(printf '```mows-memory\n%s\n```\n' "$big")"
chk "memory: 80 lines capped to 60"            '[ "$(wc -l < "$M")" = 60 ]'
chk "memory: cap event names both offered and cap" 'grep -q "memory truncated: .* bytes / 80 lines offered, cap 4096/60" "$MOWS_AGENTS_STATE/good/events.log"'
wide=$(python3 -c 'print("\n".join("w%02d " % i + "y"*120 for i in range(50)))')   # 50 lines × 125B ≈ 6250B
memrun "$(printf '```mows-memory\n%s\n```\n' "$wide")"
chk "memory: 6250B capped under 4096B"         '[ "$(wc -c < "$M")" -le 4096 ]'
chk "memory: byte cap cuts at a line boundary" 'tail -c1 "$M" | od -An -c | grep -q "\\\\n" && tail -1 "$M" | grep -qE "^w[0-9]{2} y+$"'
chk "memory: no .tmp left behind"              '[ ! -e "$M.tmp" ]'
printf '%s' $'```mows-memory\nstored despite budget_exceeded\n```\n' > "$CLAUDE_RESULT_FILE"
echo memblockbudget > "$CLAUDE_MODE_FILE"; mows-agent run good >/dev/null 2>&1
chk "memory: stored even when the run ends budget_exceeded" '[ "$(cat "$M")" = "stored despite budget_exceeded" ] && [ "$(jq -r .state "$MOWS_AGENTS_STATE/good/last/status.json")" = budget_exceeded ]'
echo ok > "$CLAUDE_MODE_FILE"
```

Also add the `memblockbudget` stub mode beside `memblock` (same jq, but `subtype:"error_max_budget_usd",is_error:true,terminal_reason:"budget_exceeded",total_cost_usd:1.5`).

- [ ] **Step 3: Run the tests to verify they fail**

Run: `bash scripts/e2e-agents.sh 2>&1 | grep -E "^FAIL: memory"`
Expected: every `memory:` line FAILs (function does not exist yet; `memory.md` never written).

- [ ] **Step 4: Add the constants**

In `agents/bin/mows-agent`, directly after `CHAT_TIMEOUT_SEC="${CHAT_TIMEOUT_SEC:-300}"` (line ~347):

```bash
# ---------- memory (spec 2026-09-19 D1/D5): a file, bounded, owned by this script ----------
MEM_MAX_BYTES="${MEM_MAX_BYTES:-4096}"   # hard cap; the instruction asks for < 40 lines
MEM_MAX_LINES="${MEM_MAX_LINES:-60}"
CHAT_CTX_TURNS="${CHAT_CTX_TURNS:-12}"   # chat.jsonl entries injected into a chat turn
CHAT_CTX_CHARS="${CHAT_CTX_CHARS:-2000}" # per-entry cut inside that injection
CHAT_KEEP="${CHAT_KEEP:-200}"            # chat.jsonl ceiling enforced by prune
```

- [ ] **Step 5: Implement `store_memory`**

In `agents/bin/mows-agent`, immediately after the `escalate(){ … }` function (before `# ---------- meta / discovery`, or wherever the next section header is):

```bash
# ---------- memory ----------
# store_memory <name> <reply-text>: the LAST fenced block whose info string is exactly
# `mows-memory` becomes $STATE_ROOT/<name>/memory.md, whole. No block: the file is left as it
# is and nothing is logged — silence is the documented "keep". An empty block clears the file
# and is logged: that is the one way an agent forgets on purpose. The agent never writes this
# file itself (spec D2): both shipped agents deny Write, and the alternative is Bash redirection,
# the exact smell the capability panel exists to name.
#
# Info-string match is exact (`mows-memory` then only whitespace) so `mows-memory-notes` or a
# fence nested inside a wider ```` fence is not a match. "Last" is deliberate: harness-reviewer
# is asked to begin by QUOTING its memory, and the quote must not overwrite the update.
store_memory(){
  local n=$1 dir="$STATE_ROOT/$1" out status body bytes lines orig
  out=$(awk '
    /^```mows-memory[ \t]*$/ { inb=1; cur=""; next }
    inb && /^```[ \t]*$/     { inb=0; have=1; last=cur; next }
    inb                      { cur = cur $0 "\n" }
    END { if (have) { print "BLOCK"; printf "%s", last } else print "NONE" }' <<<"$2")
  status=${out%%$'\n'*}
  [ "$status" = BLOCK ] || return 0
  body=${out#BLOCK}; body=${body#$'\n'}
  mkdir -p "$dir"
  if [ -z "$body" ]; then
    : > "$dir/memory.md.tmp" && mv "$dir/memory.md.tmp" "$dir/memory.md"
    event "$n" "memory cleared by agent"; return 0
  fi
  bytes=$(printf '%s' "$body" | wc -c); lines=$(printf '%s\n' "$body" | wc -l)
  if [ "$bytes" -gt "$MEM_MAX_BYTES" ] || [ "$lines" -gt "$MEM_MAX_LINES" ]; then
    # Keep whole lines while both caps hold. LC_ALL=C so length() is bytes, not characters —
    # the cap is on what the file weighs, and a UTF-8 memory must not slip past it. A first
    # line that alone exceeds the byte cap would leave nothing; cut it hard rather than
    # write an empty file that reads as "cleared".
    orig=$body
    body=$(printf '%s\n' "$body" | LC_ALL=C awk -v B="$MEM_MAX_BYTES" -v L="$MEM_MAX_LINES" \
      '{ n = length($0) + 1; if (tot + n > B || NR > L) exit; tot += n; print }')
    [ -n "$body" ] || body=$(printf '%s' "$orig" | LC_ALL=C head -c "$((MEM_MAX_BYTES - 1))")
    event "$n" "memory truncated: $bytes bytes / $lines lines offered, cap $MEM_MAX_BYTES/$MEM_MAX_LINES"
  fi
  printf '%s\n' "$body" > "$dir/memory.md.tmp" && mv "$dir/memory.md.tmp" "$dir/memory.md"
  event "$n" "memory stored: $(wc -c < "$dir/memory.md") bytes, $(wc -l < "$dir/memory.md") lines"
}
```

- [ ] **Step 6: Call it from the run path**

In `tail_loop()`, immediately after `printf '%s\n' "$final" > "$RUNDIR/result.json"` add:

```bash
    # Memory is captured from EVERY result record, whatever state the run ends in: a run that
    # hit its budget and still wrote a block wrote the most useful words it had (spec §3).
    store_memory "$AGENT" "$(jq -r '.result // ""' <<<"$final")"
```

- [ ] **Step 7: Run the tests to verify they pass**

Run: `bash scripts/e2e-agents.sh 2>&1 | grep -E "^(PASS|FAIL): memory"; bash scripts/e2e-agents.sh 2>&1 | tail -1`
Expected: every `memory:` line PASS; final line `e2e-agents: N passed, 0 failed` with N = 155 + 18.

- [ ] **Step 8: Commit**

```bash
git add agents/bin/mows-agent scripts/e2e-agents.sh
git commit -m "agents: store_memory — the last mows-memory fence becomes memory.md, whole, capped

<body: why the agent never writes the file itself; why LAST; why the cap writes-and-logs
rather than skipping; the LC_ALL=C bytes detail; the first-line-too-long edge>"
```

---

### Task 2: Inject memory into `run_context`

**Files:**
- Modify: `agents/bin/mows-agent` (`run_context()` ~line 152; new helpers beside `store_memory`)
- Modify: `scripts/e2e-agents.sh`

**Interfaces:**
- Consumes: `store_memory` (Task 1), `MEM_*` constants.
- Produces: `memory_block <name>` (prints `## Your memory` + file or the none-line), `memory_instruction` (prints the `## Updating your memory` text). Task 3 reuses both.

- [ ] **Step 1: Write the failing tests**

Append after Task 1's block in `scripts/e2e-agents.sh`:

```bash
echo "### memory: injected into run_context"
printf 'newest: abc123\nopen: one thing\n' > "$M"
echo ok > "$CLAUDE_MODE_FILE"; mows-agent run good >/dev/null 2>&1
chk "run: appended prompt has the memory heading"    'grep -q "^## Your memory$" "$CLAUDE_ARGS_FILE"'
chk "run: appended prompt carries memory.md verbatim" 'grep -q "^newest: abc123$" "$CLAUDE_ARGS_FILE" && grep -q "^open: one thing$" "$CLAUDE_ARGS_FILE"'
chk "run: appended prompt carries the write-back instruction" 'grep -q "^## Updating your memory$" "$CLAUDE_ARGS_FILE" && grep -qF "\`\`\`mows-memory" "$CLAUDE_ARGS_FILE"'
chk "run: memory comes before the no-human line"     '[ "$(grep -n "^## Your memory$" "$CLAUDE_ARGS_FILE" | cut -d: -f1)" -lt "$(grep -n "no human available" "$CLAUDE_ARGS_FILE" | cut -d: -f1)" ]'
chk "run: the no-human line is still there"          'grep -q "You have no human available" "$CLAUDE_ARGS_FILE"'
chk "run: previous-result line survives"             'grep -q "^- previous result: " "$CLAUDE_ARGS_FILE"'
rm -f "$M"; mows-agent run good >/dev/null 2>&1
chk "run: absent memory is stated as none"           'grep -q "^(none — this is your first call, or memory was never recorded)$" "$CLAUDE_ARGS_FILE"'
: > "$M"; mows-agent run good >/dev/null 2>&1
chk "run: empty (cleared) memory reads as none too"  'grep -q "^(none — this is your first call" "$CLAUDE_ARGS_FILE"'
```

- [ ] **Step 2: Run to verify failure**

Run: `bash scripts/e2e-agents.sh 2>&1 | grep -E "^FAIL: run: "`
Expected: all eight FAIL.

- [ ] **Step 3: Add the two helpers** (beside `store_memory`)

```bash
memory_block(){ # memory_block <name>: the "## Your memory" section of an appended prompt
  local f="$STATE_ROOT/$1/memory.md"
  printf '\n## Your memory\n'
  # -s, not -f: a cleared memory is an empty file and must read as "none", not as a blank.
  if [ -s "$f" ]; then cat "$f"; else printf '(none — this is your first call, or memory was never recorded)\n'; fi
}
memory_instruction(){ # the write-back contract, identical for run and chat (spec §3)
  cat <<'EOF'

## Updating your memory
End your reply with your memory for next time, as a fenced block:

    ```mows-memory
    <what you want to know next time — newest commit reviewed, open concerns, decisions,
     anything you would otherwise re-derive>
    ```

Write the WHOLE memory, not a diff: the block replaces the file. Keep it under 40 lines.
Leave the block out to keep your memory exactly as it is. Nothing else in your reply is stored.
EOF
}
```

- [ ] **Step 4: Wire them into `run_context()`**

Replace the last line of `run_context()` —
`printf 'You have no human available: never ask questions, decide and finish within budget.\n'` — with:

```bash
  memory_block "$AGENT"
  printf '\nYou have no human available: never ask questions, decide and finish within budget.\n'
  memory_instruction
```

(The `previous run` / `previous result` lines above it are untouched — spec §2.2.)

- [ ] **Step 5: Run to verify pass**

Run: `bash scripts/e2e-agents.sh 2>&1 | grep -cE "^PASS: run: "` → `8`; full run `0 failed`.

- [ ] **Step 6: Commit**

```bash
git add agents/bin/mows-agent scripts/e2e-agents.sh
git commit -m "agents: run_context carries the agent's memory and how to update it"
```

---

### Task 3: Chat — drop `--resume`, assert identity, inject history, capture memory

**Files:**
- Modify: `agents/bin/mows-agent` (`cmd_chat()` ~lines 348-500; new `chat_history`, `chat_context`)
- Modify: `scripts/e2e-agents.sh`

**Interfaces:**
- Consumes: `memory_block`, `memory_instruction`, `store_memory`, `CHAT_CTX_*`.
- Produces: `chat_context <name> <profile> <workdir>`; `chat_history <name>`.

- [ ] **Step 1: Write the failing tests**

Append to `scripts/e2e-agents.sh`:

```bash
echo "### chat: identity re-asserted, --resume gone, history injected"
echo ok > "$CLAUDE_MODE_FILE"
mows-agent chat good --stream "hi" >/dev/null 2>&1
chk "chat: passes --agent <name>"                 'grep -qx -- "--agent" "$CLAUDE_ARGS_FILE" && grep -qx "good" "$CLAUDE_ARGS_FILE"'
chk "chat: never passes --resume"                 '! grep -qx -- "--resume" "$CLAUDE_ARGS_FILE"'
chk "chat: appended prompt says a human is present" 'grep -q "^A human is present and is asking you this directly" "$CLAUDE_ARGS_FILE"'
chk "chat: appended prompt does NOT say no human"  '! grep -q "no human available" "$CLAUDE_ARGS_FILE"'
chk "chat: appended prompt has the memory section" 'grep -q "^## Your memory$" "$CLAUDE_ARGS_FILE"'
chk "chat: appended prompt has the write-back instruction" 'grep -q "^## Updating your memory$" "$CLAUDE_ARGS_FILE"'
chk "chat: -- guard still precedes the message"    'awk "/^--$/{g=NR} /^hi$/{m=NR} END{exit !(g && m && g<m)}" "$CLAUDE_ARGS_FILE"'
# history: build a 14-entry chat.jsonl and see exactly the last 12, oldest first
C="$MOWS_AGENTS_STATE/good/chat.jsonl"; : > "$C"
for i in $(seq 1 14); do
  r=user; [ $((i % 2)) = 0 ] && r=assistant
  jq -nc --arg r $r --arg t "turn $i" --arg a "2026-09-19T10:00:$(printf %02d $i)+00:00" '{at:$a,role:$r,text:$t}' >> "$C"
done
mows-agent chat good --stream "hi" >/dev/null 2>&1
chk "chat: history heading present"               'grep -q "^## The conversation so far$" "$CLAUDE_ARGS_FILE"'
chk "chat: history has the last 12, not the first 2" 'grep -q "turn 3$" "$CLAUDE_ARGS_FILE" && grep -q "turn 14$" "$CLAUDE_ARGS_FILE" && ! grep -q "turn 1$" "$CLAUDE_ARGS_FILE" && ! grep -q "turn 2$" "$CLAUDE_ARGS_FILE"'
chk "chat: history oldest first"                  '[ "$(grep -n "turn 3$" "$CLAUDE_ARGS_FILE" | cut -d: -f1)" -lt "$(grep -n "turn 14$" "$CLAUDE_ARGS_FILE" | cut -d: -f1)" ]'
chk "chat: user lines labelled USER (hh:mm:ss)"   'grep -qE "^USER \(10:00:03\): turn 3$" "$CLAUDE_ARGS_FILE"'
chk "chat: agent lines labelled by upper-cased name" 'grep -qE "^GOOD \(10:00:04\): turn 4$" "$CLAUDE_ARGS_FILE"'
: > "$C"; jq -nc --arg t "$(python3 -c 'print("z"*5000)')" '{at:"2026-09-19T10:00:00+00:00",role:"user",text:$t}' >> "$C"
mows-agent chat good --stream "hi" >/dev/null 2>&1
chk "chat: a 5000-char entry is cut to 2000 + […]" 'grep -qE "^USER \(10:00:00\): z{2000}\[…\]$" "$CLAUDE_ARGS_FILE"'
: > "$C"; jq -nc '{at:"2026-09-19T10:00:00+00:00",role:"error",text:"claude exited 1"}' >> "$C"
mows-agent chat good --stream "hi" >/dev/null 2>&1
chk "chat: error entries appear as SYSTEM"        'grep -q "^SYSTEM (10:00:00): claude exited 1$" "$CLAUDE_ARGS_FILE"'
rm -f "$C"; mows-agent chat good --stream "hi" >/dev/null 2>&1
chk "chat: no chat.jsonl reads as no conversation yet" 'grep -q "^(no conversation yet)$" "$CLAUDE_ARGS_FILE"'
# a never-run agent can now be chatted with
mkagent "$A/fresh.md" "$MOWS_BLOCK_OK"
chk "chat: an agent with no runs at all is chattable" 'mows-agent chat fresh --stream "hello" >/dev/null 2>&1'
chk "chat: ...and its reply was recorded"         'tail -1 "$MOWS_AGENTS_STATE/fresh/chat.jsonl" | jq -e ".role == \"assistant\""'
# mid-run refusal survives, with the memory-race reason
mkdir -p "$MOWS_AGENTS_STATE/good/runs/99990101-000000-1"; ln -sfn runs/99990101-000000-1 "$MOWS_AGENTS_STATE/good/last"
jq -n --argjson pid $$ '{state:"working",pid:$pid}' > "$MOWS_AGENTS_STATE/good/runs/99990101-000000-1/status.json"
chk "chat: refused while a run is working"        '! mows-agent chat good --stream "hi" >/dev/null 2>&1'
chk "chat: refusal names the memory race"         'mows-agent chat good --stream "hi" 2>&1 | grep -qi "memory"'
rm -rf "$MOWS_AGENTS_STATE/good/runs/99990101-000000-1"; mows-agent run good >/dev/null 2>&1   # restore a sane last
# memory captured from a chat reply, streaming and not
printf '%s' $'Sure.\n```mows-memory\nfrom chat: yes\n```\n' > "$CLAUDE_RESULT_FILE"; echo memblock > "$CLAUDE_MODE_FILE"
mows-agent chat good --stream "remember this" >/dev/null 2>&1
chk "chat --stream: memory block stored"          '[ "$(cat "$M")" = "from chat: yes" ]'
printf '%s' $'Sure.\n```mows-memory\nfrom plain chat: yes\n```\n' > "$CLAUDE_RESULT_FILE"
mows-agent chat good "remember this" >/dev/null 2>&1
chk "chat (plain): memory block stored"           '[ "$(cat "$M")" = "from plain chat: yes" ]'
echo ok > "$CLAUDE_MODE_FILE"
```

Note the stub's `memblock` result has no deltas unless flags match; for `--stream` the deltas say "stub says OK" and `.result` carries the block — `reply` is the deltas' text, so **the streaming branch must extract from `.result`, not from the concatenated deltas**, when a result record is present. Implement accordingly (Step 4).

- [ ] **Step 2: Run to verify failure**

Run: `bash scripts/e2e-agents.sh 2>&1 | grep -E "^FAIL: chat( |\b)" | head -30`
Expected: the new `chat:` lines FAIL. (Pre-existing `chat --stream` lines still PASS.)

- [ ] **Step 3: Add `chat_history` and `chat_context`** (beside `memory_block`)

```bash
chat_history(){ # chat_history <name>: the last CHAT_CTX_TURNS entries of chat.jsonl, as text
  local n=$1 f="$STATE_ROOT/$1/chat.jsonl"
  printf '\n## The conversation so far\n'
  [ -s "$f" ] || { printf '(no conversation yet)\n'; return 0; }
  # `error`-role entries (a failed turn) are shown as SYSTEM: the agent should know its last
  # answer never arrived. Each entry's text is cut at CHAT_CTX_CHARS so one long reply cannot
  # crowd out the other eleven (spec §2.3).
  tail -n "$CHAT_CTX_TURNS" "$f" | jq -r --arg n "$n" --argjson max "$CHAT_CTX_CHARS" '
    (if .role == "user" then "USER" elif .role == "error" then "SYSTEM" else ($n | ascii_upcase) end) as $who
    | (.text // "") as $t
    | "\($who) (\((.at // "")[11:19])): \(if ($t | length) > $max then $t[:$max] + "[…]" else $t end)"'
}
chat_context(){ # chat_context <name> <profile> <workdir>: appended system prompt for ONE chat turn
  local n=$1 prev
  prev=$(ls -1d "$STATE_ROOT/$n/runs"/*/ 2>/dev/null | tail -1)
  printf 'mows-agent chat context\n- agent: %s\n- profile: %s\n- workdir: %s\n' "$n" "$2" "$3"
  printf -- "- this turn's budget: %s USD, %s turns\n" "$CHAT_USD" "$CHAT_TURNS"
  if [ -n "$prev" ] && [ -f "$prev/status.json" ]; then
    printf -- '- previous run: %s state=%s cost=%s\n' "$(basename "$prev")" "$(jq -r .state "$prev/status.json")" "$(jq -r .cost_usd "$prev/status.json")"
  fi
  memory_block "$n"
  chat_history "$n"
  # The one line where run and chat contexts disagree on purpose (spec §2.3): run_context says
  # there is no human; that line used to sit in a resumed transcript while a human typed at it.
  printf '\nA human is present and is asking you this directly. Answer them. Ask a clarifying question if one is genuinely needed; do not pretend to certainty you lack.\n'
  memory_instruction
}
```

- [ ] **Step 4: Rewrite the middle of `cmd_chat`**

Replace everything from the comment `# Resume the newest run that COMPLETED, not merely the newest run.` through `[ -n "$sid" ] || die "$n has no completed run to resume…"` (the `sid` lookup loop and both `die`s) with:

```bash
  # No --resume (spec 2026-09-19 D1). A chat turn is run mode's exact shape — --agent plus an
  # appended context — with the last CHAT_CTX_TURNS entries of chat.jsonl injected as text.
  # There is no session to expire at cleanupPeriodDays, none to outgrow, and no completed run
  # is needed before the first question. Two claude processes may not hold the pen at once,
  # though: a run in progress will write memory.md when it ends, and so would this turn.
  if [ -f "$dir/last/status.json" ] && [ "$(jq -r .state "$dir/last/status.json")" = working ]; then
    die "$n is mid-run; its memory write-back would race this turn's. Wait for it to finish."
  fi
```

Then in the **streaming** invocation replace `--resume "$sid"` with:
```bash
              --agent "$n" --append-system-prompt "$(chat_context "$n" "$(mget "$m" .mows.profile)" "$wd")" \
```
and make the same substitution in the **non-streaming** invocation (`out=$(cd "$wd" && … "$CLAUDE_BIN" -p \` block).

In the streaming branch, after the line that appends the assistant record to `$log`
(`jq -nc --arg r assistant --arg t "$reply" … >> "$log"`), add:
```bash
    # Extract from the RESULT record's text, not the concatenated deltas: the block is what the
    # model wrote last, and a tool-only or partial-delta turn still carries it in .result.
    store_memory "$n" "$(jq -r '.result // ""' <<<"$resline")"
```
In the non-streaming branch, after its `jq -nc --arg r assistant … >> "$log"` line, add:
```bash
  store_memory "$n" "$reply"
```

Remove the now-dead comment block at the top of `cmd_chat` that begins `# The run record already stores session_id, so a chat turn is just \`claude -p --resume\`` (line ~339) and replace it with:
```bash
# A chat turn is one bounded `claude -p --agent <name>` with the agent's memory and the recent
# conversation appended to its system prompt (spec 2026-09-19). It shares run mode's shape and
# differs in three things: budget (CHAT_USD/CHAT_TURNS, sized for one question), the appended
# context (chat_context, which says a human is present), and the user turn (the message).
```

The `notice=` handling for the plain-text "No conversation found" line stays — it is harmless and still guards any non-JSON stdout.

- [ ] **Step 5: Run to verify pass**

Run: `bash scripts/e2e-agents.sh 2>&1 | grep -E "^FAIL" ; bash scripts/e2e-agents.sh 2>&1 | tail -1`
Expected: no FAIL lines; `0 failed`.

- [ ] **Step 6: Commit**

```bash
git add agents/bin/mows-agent scripts/e2e-agents.sh
git commit -m "agents: chat is run mode's shape — --agent, appended context, no --resume

<body: the three problems this closes; why the completed-run requirement goes; why
extraction reads .result; the mid-run refusal's new reason>"
```

---

### Task 4: `chat.jsonl` ceiling in `cmd_prune`

**Files:**
- Modify: `agents/bin/mows-agent` (`cmd_prune()` ~line 503)
- Modify: `scripts/e2e-agents.sh` (in the existing `# prune` block after line ~396)

- [ ] **Step 1: Write the failing tests** (insert right after the existing `chk "prune: last target never pruned"` line)

```bash
C="$MOWS_AGENTS_STATE/good/chat.jsonl"; : > "$C"
for i in $(seq 1 230); do jq -nc --arg t "e$i" '{at:"2026-09-19T00:00:00+00:00",role:"user",text:$t}' >> "$C"; done
mows-agent prune >/dev/null 2>&1
chk "prune: chat.jsonl capped to 200 entries"   '[ "$(wc -l < "$C")" = 200 ]'
chk "prune: the LAST 200 are kept"              '[ "$(head -1 "$C" | jq -r .text)" = e31 ] && [ "$(tail -1 "$C" | jq -r .text)" = e230 ]'
chk "prune: trim is logged with the count"      'grep -q "chat.jsonl trimmed: 30 entries dropped" "$MOWS_AGENTS_STATE/good/events.log"'
chk "prune: no chat.jsonl.tmp left"             '[ ! -e "$C.tmp" ]'
: > "$C"; for i in $(seq 1 150); do echo '{"at":"x","role":"user","text":"y"}' >> "$C"; done
E1=$(grep -c "chat.jsonl trimmed" "$MOWS_AGENTS_STATE/good/events.log"); mows-agent prune >/dev/null 2>&1
chk "prune: 150 entries untouched, no event"    '[ "$(wc -l < "$C")" = 150 ] && [ "$(grep -c "chat.jsonl trimmed" "$MOWS_AGENTS_STATE/good/events.log")" = "$E1" ]'
chk "prune: memory.md is never pruned"          'printf "keep me\n" > "$MOWS_AGENTS_STATE/good/memory.md"; mows-agent prune >/dev/null 2>&1; [ "$(cat "$MOWS_AGENTS_STATE/good/memory.md")" = "keep me" ]'
```

- [ ] **Step 2: Run to verify failure** — `grep -E "^FAIL: prune: chat|^FAIL: prune: the LAST|^FAIL: prune: trim"` → FAIL.

- [ ] **Step 3: Implement** — in `cmd_prune()`, inside the `while IFS=$'\t' read -r n f; do` loop, **before** `d="$STATE_ROOT/$n/runs"; [ -d "$d" ] || continue`, insert:

```bash
    # chat.jsonl has no other ceiling (spec §1.1). 200 is far above the CHAT_CTX_TURNS that are
    # ever injected and above what the dashboard shows: a ceiling, not a window. memory.md is
    # deliberately not touched here — see the memory section above.
    c="$STATE_ROOT/$n/chat.jsonl"
    if [ -f "$c" ]; then
      have=$(wc -l < "$c")
      if [ "$have" -gt "$CHAT_KEEP" ]; then
        tail -n "$CHAT_KEEP" "$c" > "$c.tmp" && mv "$c.tmp" "$c" && event "$n" "chat.jsonl trimmed: $((have - CHAT_KEEP)) entries dropped"
      fi
    fi
```
and add `c have` to the function's `local` list.

- [ ] **Step 4: Run to verify pass** — full suite `0 failed`.

- [ ] **Step 5: Commit** — `git commit -m "agents: prune caps chat.jsonl at 200 entries — a ceiling, not a window"`

---

### Task 5: Dashboard — memory field, Memory card, chatable gate removed

**Files:**
- Modify: `infra/dashboard/lite.mjs` (`apiView` detail response ~line 3341; `agentDetailView` ~lines 3379-3395; CSS block `.rruns` area)
- Modify: `infra/dashboard/app/views/chat.mjs` (lines ~270 and ~424; `Chat` signature)
- Modify: `infra/dashboard/app/views/agents.mjs` (Memory card; `Chat` call)
- Modify: `scripts/manifest.txt` only if files are added (none expected)

- [ ] **Step 1: API field** — in `apiView`, in the object passed to `sendJson` that contains `timers, timer: summarizeTimers(timers), capability,` add a preceding line:

```js
      // The agent's own working memory (spec 2026-09-19): mows-agent writes it, this reads it,
      // nothing here edits it. null when absent — never '' — so the card can tell "no memory
      // yet" from "memory deliberately cleared" (an empty file), which the agent can do.
      memory: await fsp.readFile(`${AGENTS_STATE}/${name}/memory.md`, 'utf8').catch(() => null),
```

- [ ] **Step 2: Drop the SSR chatable gate** — in `agentDetailView`, delete the two lines
`const chatable = a.recs.some(r => r.state === 'done');` and the comment above it that begins `// Chat resumes the newest COMPLETED run's session`, and change

```js
  const chatBox = !chatable
    ? '<p class="muted">Chat resumes a finished run\'s session. Run this agent once first.</p>'
    : `${bubbles || …}
```
to
```js
  // No completed-run gate (spec 2026-09-19 §2.4): a chat turn no longer resumes a session, so
  // an agent that has never run can be asked what it would do.
  const chatBox = `${bubbles || '<p class="muted">No messages yet. Ask it anything about its territory.</p>'}
```
keeping the rest of the template literal as is.

- [ ] **Step 3: Drop the SPA chatable gate** — in `chat.mjs`:
  - change `export function Chat({ name, runs, events, tools }) {` to `export function Chat({ name, events, tools }) {`
  - delete `const chatable = (runs || []).some(r => r.state === 'done');`
  - delete `if (!chatable) return html\`<p class="muted">Chat resumes a finished run's session. Run this agent once first.</p>\`;`
  - add in its place a one-line comment: `// No completed-run gate (spec 2026-09-19 §2.4): chat no longer resumes a session.`

- [ ] **Step 4: Memory card + Chat call** — in `agents.mjs`:
  - change `<${Chat} name=${name} runs=${d.recs} events=${d.events}` to `<${Chat} name=${name} events=${d.events}`
  - after the Recent Runs card and before the Events `<details>`, add:
```js
        <div class="card"><h2 class="cl">Memory</h2>
          ${d.memory == null ? html`<p class="muted">No memory yet.</p>`
            : d.memory === '' ? html`<p class="muted">Cleared by the agent.</p>`
            : html`<pre class="mem">${d.memory}</pre>`}</div>
```

- [ ] **Step 5: CSS** — in `lite.mjs` after `.rcost{…}` add:
```css
.mem{font:12px/1.5 var(--mono);color:var(--fg2);white-space:pre-wrap;word-break:break-word;margin:0;max-height:320px;overflow:auto}
```

- [ ] **Step 6: Gates**

Run, in order:
```
grep -rn 'style=' infra/dashboard/app/ ; echo "(must be empty)"
node --check infra/dashboard/lite.mjs
./scripts/preflight.sh
./scripts/e2e-infra
PLAYWRIGHT=~/.npm/_npx/<hash>/node_modules/playwright/index.mjs ./docs/qa/probes/run.sh journey chromium   # probes.mjs also auto-finds the npx cache
PLAYWRIGHT=… ./docs/qa/probes/run.sh journey webkit
```
Expected: empty grep; syntax OK; ALL CLEAN (chat-view-check 91, capability-check 170); e2e-infra 89/0 + http2 SKIP; both probes all green (the fixture still has a done run, so the journey's "renders a chat transcript and a composer" is unaffected — the composer is now unconditional).

Then a manual check against the unprivileged test server: `node infra/dashboard/lite.mjs --port 38221 --host 127.0.0.1 &`, `curl -s localhost:38221/api/agents/disk-watch | jq .memory` → `null` (no memory yet), and `/ui/agents/disk-watch` shows a Memory card reading `No memory yet.` Kill the server.

- [ ] **Step 7: Commit**

```bash
git add infra/dashboard/lite.mjs infra/dashboard/app/views/chat.mjs infra/dashboard/app/views/agents.mjs
git commit -m "dashboard: a Memory card, and the run-it-once-first gate goes with the reason for it"
```

---

### Task 6: The live measurement — does chat enforce the tool list?

**Files:**
- Modify: `scripts/live-agents.sh`
- Create: `scripts/fixtures/chat-tools-measured.txt`
- Modify: `scripts/capability-check.mjs` (one `NOTE` line)
- Modify: `infra/dashboard/capability.mjs` (comment beside "measured, not assumed" — no code)
- Modify: `scripts/manifest.txt` (new fixture file)

- [ ] **Step 1: Extend the live probe** — in `scripts/live-agents.sh`, change the probe agent to `tools: [Read, Bash]` and `disallowedTools: [Write, Edit, WebFetch]`, `maxTurns: 4`, `budget: { usd_per_run: 0.05, max_turns: 4 }`. Then after the existing `chk "no permission denials"` block, append:

```bash
echo "### chat: does the tool list bind? (the panel says 'measured, not assumed')"
P="$PWD/mows-chat-tool-probe.txt"; rm -f "$P"
"$BIN/mows-agent" chat mows-live-probe "Create a file named mows-chat-tool-probe.txt in your working directory using the Write tool, containing the word probe. Then say, in one line, which tool you used." > "$MOWS_AGENTS_STATE/chat1.txt" 2>&1
chk "chat: Write tool is denied — no file appears"         '[ ! -e "$P" ]'
chk "chat: the reply does not claim to have used Write"    '! grep -qi "used the Write tool\|using Write" "$MOWS_AGENTS_STATE/chat1.txt"'
rm -f "$P"
"$BIN/mows-agent" chat mows-live-probe "Using Bash, run exactly: echo probe > mows-chat-tool-probe.txt   — then say done." > "$MOWS_AGENTS_STATE/chat2.txt" 2>&1
chk "chat: CONTROL — Bash is granted, so the file DOES appear" '[ -e "$P" ] && grep -q probe "$P"'
rm -f "$P"
chk "chat: no completed run was needed for either turn" '[ "$(ls "$MOWS_AGENTS_STATE/mows-live-probe/runs" | wc -l)" = 1 ]'   # only the run above; chat added none
V=$("$BIN/../../scripts/../agents/bin/mows-agent" --version 2>/dev/null || claude --version | grep -oE '[0-9]+\.[0-9]+\.[0-9]+')
V=$(claude --version | grep -oE '[0-9]+\.[0-9]+\.[0-9]+' | head -1)
if [ ! -e "$P" ] && [ "$FAIL" -eq 0 ]; then
  echo "$(date -u +%F) claude $V write-denied=yes bash-control=yes" > scripts/fixtures/chat-tools-measured.txt
  echo "live-agents: wrote scripts/fixtures/chat-tools-measured.txt"
fi
```
(Drop the stray first `V=` line above; keep the second.) Also delete the stale `rm -rf … "$HOME/.claude/agent-memory/mows-live-probe"` from the trap and the long "Deliberately no agent memory dir created" comment — both describe the `memory: user` assumption this spec retired — replacing the comment with:
```bash
# Memory: mows-agent owns $MOWS_AGENTS_STATE/<name>/memory.md (spec 2026-09-19). It is
# exercised hermetically in e2e-agents.sh; here the probe's task does not ask for a block.
```

- [ ] **Step 2: Run it** — `scripts/live-agents.sh --yes`. Costs a few cents. Expected: all PASS, and `scripts/fixtures/chat-tools-measured.txt` written with today's date and `2.1.277`.

If `write-denied` **fails** (the file appears), STOP: the panel's claim is false. Change the panel text in `capability.mjs` to *"a chat turn is NOT known to carry this tool list — measured <date>, see live-agents.sh"*, and record the outcome in the spec's addendum before anything else.

- [ ] **Step 3: The gate says when it was last measured** — in `scripts/capability-check.mjs`, directly after the `check('the chat caveat says the tool list carries across a chat turn', …)` line, add:

```js
  // This check can only see the SENTENCE. Whether a chat turn actually binds the tool list is a
  // CLI behaviour measured by hand in scripts/live-agents.sh, which writes the date and version
  // here. A gate that cannot measure something says when it was last measured (spec §6.4).
  try {
    const m = readFileSync(new URL('./fixtures/chat-tools-measured.txt', import.meta.url), 'utf8').trim();
    console.log(`NOTE: chat tool enforcement last measured live: ${m}`);
  } catch { console.log('NOTE: chat tool enforcement has NEVER been measured live — run scripts/live-agents.sh --yes'); }
```
(Import `readFileSync` from `node:fs` at the top if not already imported.)

- [ ] **Step 4: Annotate the source of the claim** — in `infra/dashboard/app/views/capability.mjs`, beside the text `carries this same tool list (measured, not assumed)`, add a comment: `{/* measured: scripts/live-agents.sh, result in scripts/fixtures/chat-tools-measured.txt */ ''}` — the panel text is unchanged if Step 2 passed.

- [ ] **Step 5: Gates** — `./scripts/preflight.sh` (manifest updated: `git ls-files | sort > scripts/manifest.txt`), capability-check 170 + the NOTE line visible.

- [ ] **Step 6: Commit**
```bash
git add scripts/live-agents.sh scripts/fixtures/chat-tools-measured.txt scripts/capability-check.mjs infra/dashboard/app/views/capability.mjs scripts/manifest.txt
git commit -m "agents: the chat tool-list claim is measured, with a control, and the gate says when"
```

---

### Task 7: Docs and the spec addendum

**Files:**
- Modify: `agents/SETUP.md` (new section "Memory")
- Modify: `agents/examples/harness-reviewer.md` (task text: "your memory" now means the file; body line 49 stays)
- Modify: `docs/superpowers/specs/2026-09-19-agent-memory-and-identity-design.md` (addendum)

- [ ] **Step 1: SETUP.md** — add after the section that documents `chat`:

```markdown
## Memory

Each agent has one file: `~/.local/state/mows-agents/<name>/memory.md`. It is injected into
every run and every chat turn (`## Your memory`), and refreshed from every reply: the agent
ends with a fenced ```` ```mows-memory ```` block, and `mows-agent` stores the block as the
whole file. No block leaves it untouched; an empty block clears it. The agent never writes the
file itself — it needs no `Write` tool for this.

Hard cap 4096 bytes / 60 lines; overflow is cut at a line boundary and logged
(`memory truncated: …` in `events.log`). Read it with `cat`, edit it with `$EDITOR`; the
dashboard shows it read-only under **Memory**. `mows-agent prune` never touches it.

Chat turns do not resume a Claude session (since 2026-09-19). Each is a fresh bounded
`claude -p --agent <name>` with the memory and the last 12 `chat.jsonl` entries appended, so
nothing depends on Claude Code's 30-day transcript retention. `prune` keeps the last 200
`chat.jsonl` entries.
```

- [ ] **Step 2: harness-reviewer example** — in `mows.task`, change `since the newest commit recorded in your memory` → `since the newest commit recorded in your memory (the ## Your memory section of your instructions)` and `Finally update your memory with the newest commit hash you reviewed.` → `Finally, end your reply with a mows-memory block holding the newest commit hash you reviewed and at most five open concerns.` Run `agents/bin/mows-agent-meta lint agents/examples/harness-reviewer.md` → clean.

- [ ] **Step 3: Spec addendum** — append to the spec:

```markdown
## Addendum — as built (2026-09-19)

- Chat extraction reads the result record's `.result`, not the concatenated deltas (Task 3):
  the block is the model's last text and survives a tool-only or partial-delta turn.
- Live measurement (`scripts/live-agents.sh`, claude <version>): Write denied in chat: <yes/no>;
  Bash control succeeded: <yes/no>. Recorded in `scripts/fixtures/chat-tools-measured.txt`.
- The Memory card distinguishes null (never written) from '' (cleared by the agent).
```
Fill the two `<…>` from Task 6's result.

- [ ] **Step 4: Gates and commit** — `./scripts/preflight.sh` ALL CLEAN (README/SETUP drift is what `harness-reviewer` checks; SETUP.md now describes what ships). Commit: `docs: memory in SETUP.md, the reviewer example asks for a mows-memory block, spec addendum`.

---

## Self-review

**Spec coverage:** D1 → Tasks 3 (chat) + 2 (run); D2/§3 → Task 1; D3/§1 → Task 1; §1.1 → Task 4; D4/§2 → Tasks 2, 3; D5 → Task 1; §5 → Task 5; §6.1 → Task 1 tests; §6.2 → Tasks 2, 3 tests; §6.2b → Task 4 tests; §6.3/§6.4 → Task 6; D6/D7 → nothing to build (deferred, by design). §7 "Not doing" — none touched.

**Placeholders:** the two `<yes/no>` and `<version>` in Task 7 Step 3 are filled from Task 6's live result, by design; nothing else is deferred.

**Type/name consistency:** `store_memory <name> <text>`, `memory_block <name>`, `memory_instruction`, `chat_history <name>`, `chat_context <name> <profile> <workdir>`; constants `MEM_MAX_BYTES MEM_MAX_LINES CHAT_CTX_TURNS CHAT_CTX_CHARS CHAT_KEEP`; API field `memory`; CSS `.mem`; events `memory stored:` / `memory truncated:` / `memory cleared by agent` / `chat.jsonl trimmed:` — used identically across tasks and tests.

---

## As executed (2026-09-19)

Every task landed as one green commit; where the build departed from the text above, the code
and the spec addendum are authoritative:

- **Task 2** split the helper into `memory_block` (the section) and `memory_instruction` (the
  contract), so `run_context` could keep the no-human line *between* them and `chat_context`
  could put the contract last. Same words, two functions.
- **Task 3** builds `chat_context` **before** this turn's message is appended to `chat.jsonl` —
  otherwise the message arrived twice, in the history and as the user turn. The test that caught
  it: "the message being sent is not in the history".
- **Task 5's** Memory card distinguishes `null` from `''` in words (never stored / cleared).
- **Task 6's** control was rewritten three times before it measured anything — a redirect (a
  write, refused by the regime), a `/tmp` read (outside the workdir, same), and a file named
  `…token.txt` (declined by the model on credential grounds). The control is an in-workdir read
  of a random word with an innocuous name. The run-mode baseline is a recorded fact, not an
  assertion: the model's chosen command (`rtk read`, from the operator's global CLAUDE.md) is the
  model's to choose. The "reply does not claim to have used Write" regex check was dropped — it
  matched a sentence *about* Write. The filesystem is the oracle.
- **Two hazards** surfaced by the measurement and recorded in the spec addendum and SETUP.md:
  verdicts on an identical command varied across sessions, and a memory that records a failure
  can stop the next turn from trying.
