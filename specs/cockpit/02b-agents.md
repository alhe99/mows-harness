---
branch: feat/cockpit-02b-agents
release: feature
repos:
  - path: .
    stack: frontend
phase: 2
depends_on: specs/cockpit/02a-sessions.md
outward: none
dev_server: MOWS_TEST_HOOKS=1 node infra/dashboard/lite.mjs --port 3105 --host 127.0.0.1 --ui=next
gates:
  size_limit: warn
  lighthouse: warn
budgets:
  shell_js_kb: 30
  view_js_kb: 15
  md_vendor_kb: 25
  css_kb: 12
  fonts_kb: 80
  term_js_kb: 130
  server_js_kb: 140
  lcp_ms: 2500
  tbt_ms: 200
  parity_diff_pct: 0.5
manual_gates:
  - name: 10-minute heap
    what: heap delta after 10 min of agent streaming on one iPhone and one Android, screenshots of the memory panel
    owner: alhe99
    due: phase Gate 1
---

# Phase 2b — Agents, chat and runs at parity

Goal: The `/ui` app's three views ported to Preact 11 in the shell with streaming markdown that re-parses only the open block, the capability panel as a lazy chunk, and every existing chat gate and probe green against the new code.

Constraints (from ledger.md, kept):
- K-02 — see ARCHITECTURE.md §14 / ledger.md
- K-08 — see ARCHITECTURE.md §14 / ledger.md
- K-14 — see ARCHITECTURE.md §14 / ledger.md
- K-15 — see ARCHITECTURE.md §14 / ledger.md
- K-26 — see ARCHITECTURE.md §14 / ledger.md
- K-34 — see ARCHITECTURE.md §14 / ledger.md

Every task has three fixed sub-lines. **Evidence** is where the requirement comes from (a MAP.md row or
section, an ARCHITECTURE.md section, a ledger id). **Verify** is a shell command run from the repo root whose
exit code is the verdict — `scripts/verify-spec.mjs` runs them all and decides `ship` or `fix`. **Owner** is
`builder` (writes code) or `verifier` (runs checks, read-only). A task that cannot be verified by a command is
not a task; it is a `manual_gates` entry with an owner and a date.

`$DASH` is the dev instance (`dev_server` in the front-matter, default `http://127.0.0.1:3105`); `$RUN` is the
`.agent-team/<run-id>` directory. Both are exported by `verify-spec.mjs`.

## Tasks

1. `web/views/agents.mjs`: list (`a.agent.card`, pill, `<rel> · N runs · 7d $x`, empty string "No agents yet."), detail (the `.agwrap > .ag2` layout, five aside cards Telemetry / Capabilities / Recent Runs / Memory / Events with the exact copy and `runLabel` rule), `Run now` form; `ui.mjs` helpers `rel`, `usd`, `Pill` unchanged.
   Evidence: MAP.md §8 M-07; §3.5 S-07..S-09
   Verify: UI_SRC=web node scripts/capability-check.mjs
   Owner: builder

2. `web/views/capability.mjs` as its own lazy chunk: the `CapabilityPanel` render rules verbatim (text nodes only, `${' '}` trimming, the `quiet` condition, `money()`/`count()` wording).
   Evidence: MAP.md §8 M-08; scripts/capability-check.mjs
   Verify: UI_SRC=web node scripts/capability-check.mjs && node scripts/budget.mjs --route agent --max 15
   Owner: builder

3. `web/md.mjs`: marked with `safeHref`, `renderer.html`, `renderer.link/image`, `tokenizer.tag`, `renderer.code` (mows-memory details) and `renderPartial` moved verbatim from `app/views/chat.mjs`; block-level memoisation (split on blank lines, closed blocks cached by content hash, only the open tail re-parsed per delta); exports `renderPartial`, `reconcile` for the gate.
   Evidence: MAP.md §3.6; ledger A-08, K-08
   Verify: UI_SRC=web node scripts/chat-view-check.mjs
   Owner: builder

4. `web/views/chat.mjs`: turns + live buffer from the store, optimistic send to `/a/agent-chat` with withdrawal on failure, `reconcile` on `chatend` refetch, system dividers from events, `p.chint`, `button.sendb` states, `p.cherr[role=alert]`, the Cmd/Ctrl+Enter send.
   Evidence: MAP.md §3.6, §8 M-09
   Verify: docs/qa/probes/run.sh journey webkit --ui next && docs/qa/probes/run.sh lost chromium --ui next && docs/qa/probes/run.sh repeat chromium --ui next
   Owner: builder

5. Composer and keyboard: `visualViewport` sets `--kb`, `html.kb-open` hides the tab bar, hand-written bottom anchoring (< 40 px = at bottom), `Jump to latest`, placeholder switch at 500 px.
   Evidence: MAP.md §3.6 'Scroll anchoring', 'Composer / keyboard'
   Verify: docs/qa/probes/run.sh layout webkit --ui next
   Owner: builder

6. `web/views/run.mjs` and `web/views/session.mjs` stubs stay; `/agents/<n>/<run>` renders status JSON + assistant text as today.
   Evidence: MAP.md §3.2 R-01; §2.3.6 run page
   Verify: node docs/qa/probes/agents-check.mjs webkit run
   Owner: builder

7. `docs/qa/probes/run.sh --ui next` runs every existing probe mode against the shell routes (selectors updated where the markup moved, listed in the probe header); `csp` still proves injection is refused under the shell's nonce policy; `docs/qa/probes/agents-check.mjs <engine> run` renders the fixture run page and asserts the status block, cost and assistant text.
   Evidence: MAP.md §6.3, §6.5; ledger K-10
   Verify: docs/qa/probes/run.sh all webkit --ui next
   Owner: builder

8. The chatend-gap case: a turn that ends while the stream is cut → on reconnect the client refetches the transcript and `busy` clears; added to `stream-replay-check.mjs` and the `journey` probe.
   Evidence: ledger D-04, K-34
   Verify: PORT=3105 MOWS_TEST_HOOKS=1 node scripts/stream-replay-check.mjs --chatend-gap
   Owner: builder

9. Mutation coverage still bites: `chat-view-coverage.mjs` and `capability-coverage.mjs` run against `web/` with every mutation detected.
   Evidence: MAP.md §6.1 G-21, G-22; ledger K-26
   Verify: UI_SRC=web node scripts/chat-view-coverage.mjs && UI_SRC=web node scripts/capability-coverage.mjs
   Owner: verifier

10. Budgets: agents, agent, chat route closures ≤ 15 kB; marked chunk ≤ 25 kB.
   Evidence: ARCHITECTURE.md §9; ledger A-02, K-02
   Verify: node scripts/budget.mjs --route agents --max 15 && node scripts/budget.mjs --route agent --max 15 && node scripts/budget.mjs --chunk marked --max 25
   Owner: verifier

11. Parity on `/agents`, `/agents/<fixture>` and the run page at both sizes, both engines; Lighthouse on `/next/agents`.
   Evidence: ledger K-33; MAP.md §7.5 (`/ui/agents` 2 765 ms is the number to beat)
   Verify: node scripts/parity-capture.mjs --ui next --route /agents --out .agent-team/$RUN/parity && node scripts/parity-diff.mjs docs/qa/baseline/cockpit .agent-team/$RUN/parity --route /agents --max 0.5 && node scripts/lh-gate.mjs --url $DASH/next/agents --lcp 2500 --tbt 200 --runs 3 --warn
   Owner: verifier

## Out of scope

History, System, Device, transcript; the server-rendered `/agents` twin stays.

<!-- Generated by scripts/gen-cockpit-specs.mjs from specs/cockpit/phases.json — do not edit by hand. -->
