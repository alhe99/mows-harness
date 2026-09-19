# Agent memory and identity — design

**Builds on:** `2026-09-15-agents-layer-design.md` (Layer 6). Amends its D5 and §1 `memory:`.
**Code this touches:** `agents/bin/mows-agent` (`run_context`, `tail_loop`, `cmd_run`,
`cmd_chat`, `cmd_prune`), `infra/dashboard/lite.mjs` (`apiView` one field; `agentDetailView`
drops the chatable gate), `infra/dashboard/app/views/chat.mjs` (drops the chatable gate),
`infra/dashboard/app/views/agents.mjs` (Memory card), `scripts/e2e-agents.sh`,
`scripts/live-agents.sh`. `mows-agent-meta` is untouched.

## Problem

An agent is supposed to hold a standing responsibility for months and be called when needed.
Today it cannot, for three independent reasons, each verified on this box on 2026-09-18:

1. **Its memory is not written.** The Layer 6 spec (§1, line 59) assumed `memory: user` makes
   Claude Code persist `<cfgdir>/agent-memory/<name>/MEMORY.md`. It does not: `memory:` scopes
   Claude Code's *project* memory (`~/.claude/projects/<project>/memory/`), keyed by working
   directory, not by agent. `harness-reviewer` has run once (`done`, 19 turns, $0.41); no memory
   directory exists for `mows-harness`. Its task — *"review every commit since the newest commit
   recorded in your memory"* — re-reviews the same 24 hours forever. Observation 28627 (Sep 16)
   recorded the missing directory; nothing was built on it.
2. **Its continuity is a session that expires.** Chat is `claude -p --resume <session_id>`.
   Claude Code's `cleanupPeriodDays` defaults to 30 and is active here: the oldest transcript on
   the box is dated exactly 30 days back. On day 31 `--resume` fails "No conversation found".
   Before that, the resumed transcript grows without bound — `disk-watch` is at 860 KB after ~19
   turns. That is the curve that took claude-mem down on Sep 17 (404k chars, 14 retries, 638
   observations lost). Same failure, longer fuse.
3. **Its identity is inherited, not asserted.** Run mode passes `--agent <name>` and
   `--append-system-prompt "$(run_context)"`. Chat passes neither — `--agent` appears exactly
   once in `mows-agent`, line 276. In chat the soul exists only as history inside the resumed
   transcript, so (2) does not merely lose memory, it loses the agent. And `run_context`'s line
   *"You have no human available: never ask questions"* sits in that history while a human
   types at it.

The Capabilities panel also claims chat *"carries this same tool list (measured, not
assumed)"*, and the gate behind that claim is `/carries this same tool list/.test(joined)` —
it asserts the sentence is present. Nothing measures the behaviour. This spec includes the
measurement.

## Decisions locked

| | Decision | Why |
|---|---|---|
| **D1** | **The unit of continuity is a memory file, not a session.** A fresh bounded `claude -p` per call — run *and chat* — with the memory injected at start and captured at end. **Chat drops `--resume`.** Its conversational context is the last 12 turns of `chat.jsonl`, injected as text. | Immune to `cleanupPeriodDays`, immune to context growth, costs a bounded ~7k tokens per call instead of a transcript that reaches 860 KB. There is no session to expire, sweep, or outgrow. What a resumed session carried beyond 12 turns is exactly what the memory file is for. |
| **D2** | **`mows-agent` owns the file; the agent never writes it.** The agent ends its reply with a fenced `mows-memory` block; `mows-agent` extracts and stores it. | `disk-watch` and `harness-reviewer` both deny `Write`/`Edit`. "The agent writes its own memory" contradicts their tool policy and would need Bash redirection — the exact smell the capability panel exists to name. Extraction keeps the policy intact and gives the operator one file to read, diff and edit. |
| **D3** | **The file lives at `$STATE_ROOT/<name>/memory.md`**, beside `runs/`, `chat.jsonl` and `events.log`. | Outside anything Claude Code prunes. Already the per-agent directory `mows-agent` owns. `cmd_prune` touches only `runs/` and cannot reach it. |
| **D4** | **Identity is re-asserted on every call, run and chat alike**, through `--append-system-prompt`. Chat gets a chat-shaped context, not run's. | Nothing load-bearing may live only inside a transcript. The one line that differs is the one that was wrong: chat says a human is present. |
| **D5** | **Memory is bounded: 4096 bytes / 60 lines, hard.** The instruction asks for less; the cap enforces it; overflow is truncated at a line boundary and logged as an event. | A memory that grows is (2) again with a different filename. The whole value of D1 is that the injected context is small and stays small. |
| **D6** | **Plugin-per-agent is deferred.** Trigger: the first agent that needs a skill, an MCP server, or a hook of its own. | Every current agent is `tools: [Bash, Read, Glob, Grep]` in a workdir. Plugin packaging renames the agent to `<plugin>:<name>`, changes resolution in `agent_file()`, `lite.mjs agentFile()`, `mows-agent-meta` and `install.sh`, and buys nothing an existing agent uses. The 2026-09-18 conversation proposed it as step 1; on writing it up it does not survive the first rung of the ladder. The state directory is already "a folder per agent". |
| **D7** | **The mods hooks API is not a dependency.** `prompt.context` in `anthropics/claude-code/mods/` is the right long-term injection point; it is not in 2.1.277. | `--append-system-prompt` does the same job today. When the CLI gains the API, the injection moves; the file, the format and the cap do not change. |

## 1. The memory file

`$STATE_ROOT/<name>/memory.md`. Plain Markdown, agent-authored, operator-readable. No
frontmatter, no schema: what the agent decides is worth carrying. The instruction (§3) tells it
what that usually is.

Absent on first run. `mows-agent` never creates an empty one — an absent file is the honest
signal "no memory yet" and the agent is told so in those words (§3), which is what makes
`harness-reviewer`'s own tripwire ("state whether a memory record was found") fire correctly.

**Cap (D5):** 4096 bytes and 60 lines, whichever is hit first, enforced in `store_memory()`.
Overflow is cut at the last complete line inside the cap, and an event is written:
`memory truncated: <N> bytes / <M> lines offered, cap 4096/60`. The truncated file is still
written — a memory that lost its tail is better than no memory and a silent skip, and the event
is what makes the loss visible.

**Atomic:** write to `memory.md.tmp`, `mv` over. A run killed mid-write leaves the previous
memory, never a half file.

**Never pruned.** `cmd_prune` walks `runs/` only. Stated here so a future retention change
knows the file is deliberate.

### 1.1 `chat.jsonl` gets a ceiling too

Every chat turn appends to `chat.jsonl` and nothing has ever pruned it. It is not injected into
the model, so it cannot blow the context — but it is a file on the box with no ceiling, and this
spec's whole premise is that nothing an agent produces grows without one. `cmd_prune` gains one
step: keep the last **200** entries of each agent's `chat.jsonl`, drop the rest, event
`chat.jsonl trimmed: <N> entries dropped`. 200 is far more than the 12 that are ever injected
(§2.3) and far more than the dashboard shows; it is a ceiling, not a window. Atomic, same
`.tmp` + `mv` as the memory file.

## 2. Injection — `run_context` and `chat_context`

`run_context()` (`mows-agent:152`) already builds the appended system prompt for a run. It gains
a memory section. A new `chat_context()` does the same for chat, differing where chat differs.

### 2.1 What both inject

```
## Your memory
<contents of memory.md verbatim>
```
or, when the file is absent:
```
## Your memory
(none — this is your first call, or memory was never recorded)
```

followed by the write-back instruction (§3).

### 2.2 `run_context()` — unchanged lines stay

The existing block is kept exactly: agent, run_id, profile, workdir, budget, previous run
state/cost/600-char result, and `You have no human available: never ask questions, decide and
finish within budget.` The memory section is appended after `previous result` and before the
no-human line. The 600-char `previous result` stays — it is what ran *last time*; memory is what
the agent chose to *keep*. Different things.

### 2.3 `chat_context()` — new

```
mows-agent chat context
- agent: <name>
- profile: <profile>
- workdir: <workdir>
- this turn's budget: <CHAT_USD> USD, <CHAT_TURNS> turns
- previous run: <run_id> state=<state> cost=<cost>        (same lookup run_context uses)

## Your memory
<as §2.1>

## The conversation so far
<the last 12 entries of chat.jsonl, oldest first, as `USER (hh:mm:ss): text` /
 `<NAME> (hh:mm:ss): text`, each entry's text cut at 2000 characters with `[…]`>

A human is present and is asking you this directly. Answer them. Ask a clarifying question if
one is genuinely needed; do not pretend to certainty you lack.
```

The conversation block replaces what `--resume` used to carry. Twelve entries is six exchanges;
2000 characters per entry keeps one long reply from crowding out the rest. Worst case ≈ 24 KB
≈ 6k tokens, plus ≤ 1k for memory: bounded per turn, by construction, forever. An agent with no
`chat.jsonl` gets `(no conversation yet)`. `error`-role entries (a failed turn's record) are
included as `SYSTEM (hh:mm:ss): text` — the agent should know its last answer never arrived.

The last paragraph is the correction to problem (3). It is the only place the two contexts
disagree on purpose.

### 2.4 The chat invocation, after

```
cd "$wd" && CLAUDE_CONFIG_DIR="$cfg" timeout "$CHAT_TIMEOUT_SEC" claude -p \
  --agent "$n" \
  --append-system-prompt "$(chat_context)" \
  --output-format stream-json --verbose --include-partial-messages \
  --permission-prompts none --strict-mcp-config "${mcp[@]}" \
  --max-turns "$CHAT_TURNS" --max-budget-usd "$CHAT_USD" \
  -- "$msg"
```

`--resume "$sid"` is gone; `--agent "$n"` and `--append-system-prompt` are added. This is
**run mode's exact shape** with a different appended context and a different user turn — a
shape that is already exercised on every scheduled run, so nothing here is a new CLI behaviour
to measure. The non-streaming branch (`mows-agent:475`) changes identically.

**What `cmd_chat` loses with `--resume`, deliberately:**
- the `session_id` lookup loop (`mows-agent:381-388`) and the two `die`s around it — chat no
  longer needs a completed run. An agent that has never run can be asked what it would do, and
  gets `(none — this is your first call…)` for memory and `(no conversation yet)` for history.
- therefore the dashboard's `chatable` gate (`chat.mjs`, `runs.some(r => r.state === 'done')`)
  and its message *"Chat resumes a finished run's session. Run this agent once first."*, and the
  same gate and message in the server-rendered `agentDetailView`. Both were true; both become
  false; a gate whose reason has gone is the pattern this repo keeps cataloguing. Removed in the
  same task, not left as "harmless extra strictness".

**What it keeps:** the mid-run refusal (`$n is mid-run…`). Its reason changes — not
"interleaving a live session" but *"a run is in progress; its memory write-back would race
yours"* — and so does its text. Two `claude` processes for one agent may not both hold the pen.

## 3. Write-back — the `mows-memory` block

Appended to both contexts:

```
## Updating your memory
End your reply with your memory for next time, as a fenced block:

    ```mows-memory
    <what you want to know next time — newest commit reviewed, open concerns, decisions,
     anything you would otherwise re-derive>
    ```

Write the WHOLE memory, not a diff: the block replaces the file. Keep it under 40 lines.
Leave the block out to keep your memory exactly as it is. Nothing else in your reply is stored.
```

**Extraction, `store_memory <name> <text>`:** the *last* fenced block whose info string is
exactly `mows-memory` — last, so an agent that quotes its own memory earlier in the reply (which
`harness-reviewer` is asked to do: "begin your report by stating… whether a memory record was
found") does not overwrite it with the quote. A reply with no such block leaves the file
untouched and writes no event: silence is the documented "keep as is", not an error. A block
that is present and empty **clears** the file — that is the one way an agent forgets on purpose,
and it is logged: `memory cleared by agent`.

Where the text comes from:
- **run:** `result.json`'s `.result` (the final assistant text), in `tail_loop` after
  `result.json` is written and before `write_status`. The run's state does not gate it — a
  `budget_exceeded` run that still produced a memory block gets it stored; the agent's last
  words are the most useful ones when it ran out.
- **chat:** `$reply` in both branches of `cmd_chat`, after it is appended to `chat.jsonl`.

The block stays in the transcript and in `chat.jsonl` as written. The dashboard renders it as a
code block. That is a feature: the operator sees, in the conversation, exactly what the agent
chose to remember.

Event on store: `memory stored: <bytes> bytes, <lines> lines` — one line per write, so the
`Events` disclosure shows the memory's history without opening the file.

## 4. `mows-agent-meta` — unchanged

No new subcommand, no frontmatter changes. `MOWS_KEYS` is unchanged — memory is not configured,
it exists. (An earlier draft added `body <file>` for a `--resume` fallback; D1 removed the need.)

## 5. Dashboard

`/api/agents/<name>` gains one field: `memory: <string|null>` — the file's contents, or null when
absent. `agents.mjs` renders it as a fourth right-column card, **Memory**, under Recent Runs: a
`<pre>` of the text, or `No memory yet.` The Events disclosure already shows the store/truncate
lines. No new endpoint, no write path — the dashboard reads memory, it never edits it. Editing
is `$EDITOR memory.md`, on purpose.

## 6. Test strategy

`scripts/e2e-agents.sh` drives `mows-agent` against a stub `claude` selected by
`$CLAUDE_MODE_FILE`; every assertion below is a `chk` there unless marked **live**.

### 6.1 Storage
- run with a stub reply carrying a `mows-memory` block → `memory.md` exists, content is the
  block's body exactly (no fence, no trailing blank).
- run again with a *different* block → file replaced, not appended.
- run with **no** block → file unchanged (byte-compare), no `memory` event written.
- run with an **empty** block → file is empty, event `memory cleared by agent`.
- reply containing two `mows-memory` blocks → the **last** one is stored.
- reply where the block is inside a larger ```` ``` ```` quote → not matched (info string
  must be exactly `mows-memory`, not a substring).
- 5000-byte block → file is ≤ 4096 bytes, ends at a line boundary, event `memory truncated:
  5000 bytes / N lines offered, cap 4096/60`.
- 80 one-line entries → file has 60 lines, same event shape.
- kill the stub mid-run → `memory.md` is the previous content, no `.tmp` left behind.
- `mows-agent prune` with `retention_days: 0` → `memory.md` survives.
- state `budget_exceeded` with a block → stored anyway.

### 6.2 Injection
- stub records its `--append-system-prompt` argument to a file. Run with memory present → the
  argument contains `## Your memory` followed by the file's text verbatim.
- run with memory absent → contains `(none — this is your first call`.
- chat (stub) → argument contains `A human is present` and does **not** contain `no human
  available`.
- run → argument contains `no human available` and does **not** contain `A human is present`.
- chat → argv contains `--agent <name>` and does **not** contain `--resume`.
- chat with a 14-entry `chat.jsonl` → the argument contains exactly the last 12, oldest first,
  and not the first two.
- chat with one 5000-char entry → that entry appears cut to 2000 chars ending `[…]`.
- chat with no `chat.jsonl` → contains `(no conversation yet)`.
- chat with an `error`-role entry → it appears as `SYSTEM (`.
- chat against an agent with **no runs at all** → exit 0, reply recorded (the old `die` is gone).
- chat while `last/status.json` says `working` → refused, message names the memory race.

### 6.2b `chat.jsonl` ceiling
- 230-entry `chat.jsonl`, `mows-agent prune` → 200 entries remain, the **last** 200, event
  `chat.jsonl trimmed: 30 entries dropped`. 150 entries → untouched, no event.

### 6.3 The measurement (live, `scripts/live-agents.sh`, never CI)
Costs cents.
1. **Does chat enforce the tool list?** Against `disk-watch` (`tools: [Bash, Read, Glob, Grep]`,
   `disallowedTools: [Write, Edit, …]`): chat *"Create a file named
   mows-chat-tool-probe.txt in your working directory using the Write tool, then say which tool
   you used."* Assert: the file does **not** exist afterwards, and the reply does not claim
   `Write`. Then the control: same request via Bash redirection — the file **does** exist,
   because Bash is granted. The pair is what makes the result a measurement: a probe that only
   ever fails cannot tell "enforced" from "broken". With chat now passing `--agent` this is
   expected to hold; it is measured anyway, because the panel says it was.
2. Record both outcomes in `capability.mjs`'s comment beside the "measured, not assumed" text,
   **with the date and CLI version**, and change the panel text if (1) fails.

### 6.4 The gate that was hollow
`scripts/capability-check.mjs`'s `'the chat caveat says the tool list carries across a chat
turn'` stays — it is honestly named; it checks the sentence. Add beside it a `NOTE` printed at
run time: `chat tool enforcement was last measured <date> on claude <ver> — see
live-agents.sh`, read from a one-line file `scripts/fixtures/chat-tools-measured.txt` that §6.3
step 3 writes. A gate that cannot measure something says when it was last measured by hand.

## 7. Not doing (explicitly)

- **Plugin-per-agent** (D6). Revisit when an agent needs a skill, MCP server or hook.
- **Memory schema, sections, or JSON.** The agent decides what to keep. A schema is a guess
  about what every future agent needs to remember.
- **Memory edits from the dashboard.** Read-only. The file is the interface.
- **Sharing memory between agents.** Keyed by name, on purpose (Layer 6 D5).
- **Keeping `--resume` as an option.** An earlier draft kept it and called removal "a
  one-line change later". Asked whether anything could still grow without control, the honest
  answer was: yes, the resumed transcript, exactly as today. So it goes now (D1), not later.
- **Migrating claude-mem's observations into agent memory.** Different thing: claude-mem is an
  observer log of *sessions*; this is an agent's working notes. They can point at each other;
  they are not the same store.
- **Touching `memory:` in frontmatter.** Left as a Claude Code field, linted as today. It does
  something real for interactive use; it just was never the agent's memory.

## Risks

- **The agent ignores the instruction and never writes a block.** Then nothing changes from
  today, visibly: the Memory card says `No memory yet.` after every run. That is the correct
  failure — loud, and the fix is prompt wording, not code.
- **The agent stuffs the block.** D5 caps it and logs the cut. The operator sees `memory
  truncated` in Events and tightens the wording.
- **A fresh session per chat turn loses nuance a resumed one carried.** Beyond the last 12
  entries, yes — and that is the memory file's job. If an agent keeps re-deriving something
  from the conversation, the fix is that it should be writing that thing into its memory, and
  the visible `mows-memory` block in the transcript shows whether it is.
- **A block inside quoted output is mis-extracted.** Info string must be exactly `mows-memory`;
  §6.1 tests the nested-fence case. If a real reply still fools it, the stored memory is visible
  in the transcript and the card, so the mistake is seen the same day.
- **Cost.** Memory ≤ 4 KB ≈ 1k tokens per call, run and chat. Bounded by construction; the
  live test records the actual delta.
