---
branch: feat/cockpit-02a-sessions
release: feature
repos:
  - path: .
    stack: frontend
phase: 2
depends_on: specs/cockpit/01-shell.md
outward: none
dev_server: node infra/dashboard/lite.mjs --port 3105 --host 127.0.0.1 --ui=next
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
manual_gates: []
---

# Phase 2a — The Sessions view at parity

Goal: The fleet view (`/`) in the shell: cards and rows at pixel parity, live over `fleet` events, every action and keyboard invariant preserved, prefetch and Back/Forward replacing prerender and bfcache.

Constraints (from ledger.md, kept):
- K-07 — see ARCHITECTURE.md §14 / ledger.md
- K-15 — see ARCHITECTURE.md §14 / ledger.md
- K-18 — see ARCHITECTURE.md §14 / ledger.md
- K-19 — see ARCHITECTURE.md §14 / ledger.md
- K-35 — see ARCHITECTURE.md §14 / ledger.md

Every task has three fixed sub-lines. **Evidence** is where the requirement comes from (a MAP.md row or
section, an ARCHITECTURE.md section, a ledger id). **Verify** is a shell command run from the repo root whose
exit code is the verdict — `scripts/verify-spec.mjs` runs them all and decides `ship` or `fix`. **Owner** is
`builder` (writes code) or `verifier` (runs checks, read-only). A task that cannot be verified by a command is
not a task; it is a `manual_gates` entry with an owner and a date.

`$DASH` is the dev instance (`dev_server` in the front-matter, default `http://127.0.0.1:3105`); `$RUN` is the
`.agent-team/<run-id>` directory. Both are exported by `verify-spec.mjs`.

## Tasks

1. `web/views/sessions.mjs`: rows (≥ 701 px) and cards (≤ 700 px) from the boot snapshot then `fleet` events; `data-state` and glyphs `◉ ● ⏸ ○`, words waiting/working/paused/idle, label = `label || proj || name`, sort needs-you < working < paused < idle then mtime, relative time re-rendered every 30 s, `#fleet-count`/`#fleet-empty`/`#pnav-live` semantics, reorder by moving nodes (keyed render).
   Evidence: MAP.md §2.3.1, §2.4 '/fleet.js internals'; contract.d.ts FleetItem
   Verify: node docs/qa/probes/sessions-check.mjs webkit render
   Owner: builder

2. Card menu: `<details name=fm>` exclusive menus, rename form (`/a/label`), pause/resume swap (`/a/pause`, `/a/resume`), kill confirm (`/a/kill`) — each a `<form method=post>` the view submits with `fetch` (same `back` field) and that still submits natively without JS; `form.busy` while in flight, cleared on response and on `pageshow`.
   Evidence: MAP.md §2.3.1 'Menu', §2.4 'Card menu behavior', §2.1 'Other base-script behaviors'; ledger K-19
   Verify: node docs/qa/probes/sessions-check.mjs webkit actions
   Owner: builder

3. Filter input (`[data-f=filter]`, substring over label+proj+snippet, `/` focuses it), digit keys 1–9 click the nth attach link (ignored inside inputs or with modifiers), `.fnum` badges on pointer:fine.
   Evidence: MAP.md §2.4 'Keys'; §2.2 @media L1534
   Verify: node docs/qa/probes/sessions-check.mjs chromium keys
   Owner: builder

4. Attach links: `termHref('attach', name)` mints a fresh 8-hex tabid per render, `data-nw=t-<name>` becomes `target` only in browser display-mode at ≥ 700 px with a fine pointer; the `+ New Session` card and the FAB use `termHref('menu','')`.
   Evidence: MAP.md §2.1 '.termfab', §4.5 termHref; infra/webconsole/mobile-journey.mjs:81-100 regex
   Verify: node docs/qa/probes/sessions-check.mjs chromium links
   Owner: builder

5. Standalone-only behaviours: pull-to-refresh (`#ptr`, 56 px threshold, `location.reload()`), the `vpfix` re-measure loop (≤ 6 toggles, one reload per 30 s), top-anchored `.tabs`/`.termfab`; `#envout` diagnostic and the `/z?t=dash3` + `/z?t=vpfix` beacons.
   Evidence: MAP.md §2.1 'Safe-area handling', §2.4 'Base script detail'
   Verify: node docs/qa/probes/sessions-check.mjs webkit standalone
   Owner: builder

6. Prefetch replaces prerender: on `pointerenter`/`touchstart` of a tab link the view's JSON (`/api/history?…`, `/api/system`, `/api/agents`) is fetched into the store, never for `/term*`, `fresh=1` or `reclaim=1` links; a later tap renders without a request.
   Evidence: MAP.md §2.1 'Speculation rules'; ledger B-07, K-35
   Verify: node docs/qa/probes/sessions-check.mjs chromium prefetch
   Owner: builder

7. Back/Forward replace bfcache: the store keeps the last list and scroll offset per route; `popstate` re-renders from the store with no request and restores the offset, including the scroll → Back → Forward → Back case the SPA left open.
   Evidence: infra/dashboard/app/main.mjs TODO (scroll-restore gap); docs/architecture.md 'Lost, accepted'; ledger K-35
   Verify: node docs/qa/probes/sessions-check.mjs webkit history
   Owner: builder

8. Accessibility parity: every `aria-label`, `aria-hidden`, `title` and focus-ring rule the legacy `/` carries is present; `scripts/a11y-check.mjs` diffs the attribute sets of legacy vs shell on the fixture.
   Evidence: MAP.md §8 M-13; §2.7 'Accessibility'
   Verify: node scripts/a11y-check.mjs --route /
   Owner: builder

9. `docs/qa/probes/sessions-check.mjs <engine> <mode>`: modes `render` (fixture fleet, injected `fleet` event patches and reorders without rebuild), `actions` (menus exclusive, forms post and 303, busy class), `keys`, `links`, `standalone` (display-mode stub), `prefetch` (network log), `history`.
   Evidence: docs/qa/probes/README.md conventions; MAP.md §6.3
   Verify: node docs/qa/probes/sessions-check.mjs webkit all
   Owner: builder

10. Parity: `/` at 390×844 and 1280×800 on both engines against the frozen baseline.
   Evidence: ledger K-33; ARCHITECTURE.md §4
   Verify: node scripts/parity-capture.mjs --ui next --route / --out .agent-team/$RUN/parity && node scripts/parity-diff.mjs docs/qa/baseline/cockpit .agent-team/$RUN/parity --route / --max 0.5
   Owner: verifier

11. The existing phone journey passes against the shell.
   Evidence: docs/qa/journeys/mobile-facelift.md
   Verify: node docs/qa/probes/mobile-facelift.mjs webkit .agent-team/$RUN/facelift --base $DASH/next
   Owner: verifier

12. View budget and Lighthouse.
   Evidence: ARCHITECTURE.md §9
   Verify: node scripts/budget.mjs --route sessions --max 15 && node scripts/lh-gate.mjs --url $DASH/next/ --lcp 2500 --tbt 200 --runs 3 --warn
   Owner: verifier

## Out of scope

Agents, History, System, Device, session transcript — later phases.

<!-- Generated by scripts/gen-cockpit-specs.mjs from specs/cockpit/phases.json — do not edit by hand. -->
