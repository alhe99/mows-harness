---
branch: feat/cockpit-03-views
release: feature
repos:
  - path: .
    stack: frontend
phase: 3
depends_on: specs/cockpit/02b-agents.md
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
manual_gates: []
---

# Phase 3 — History, System, Device, transcript, and the server split

Goal: The remaining tabs in the shell at parity, live where data exists, and `lite.mjs` split into `routes/`, `sse.mjs`, `static.mjs` and `legacy.mjs` behind `--ui=legacy|next` with no behaviour change.

Constraints (from ledger.md, kept):
- K-13 — see ARCHITECTURE.md §14 / ledger.md
- K-21 — see ARCHITECTURE.md §14 / ledger.md
- K-27 — see ARCHITECTURE.md §14 / ledger.md
- K-31 — see ARCHITECTURE.md §14 / ledger.md
- K-35 — see ARCHITECTURE.md §14 / ledger.md

Every task has three fixed sub-lines. **Evidence** is where the requirement comes from (a MAP.md row or
section, an ARCHITECTURE.md section, a ledger id). **Verify** is a shell command run from the repo root whose
exit code is the verdict — `scripts/verify-spec.mjs` runs them all and decides `ship` or `fix`. **Owner** is
`builder` (writes code) or `verifier` (runs checks, read-only). A task that cannot be verified by a command is
not a task; it is a `manual_gates` entry with an owner and a date.

`$DASH` is the dev instance (`dev_server` in the front-matter, default `http://127.0.0.1:3105`); `$RUN` is the
`.agent-team/<run-id>` directory. Both are exported by `verify-spec.mjs`.

## Tasks

1. `GET /api/history?acct&q&d&s&page` and `GET /api/system[?reclaim=1]` return the `HistoryPage` and `SystemEvent + usage` shapes; `GET /api/session/<acct>/<sid>?page=` returns the paged transcript the detail view renders; `?fresh=1` becomes `POST /api/usage/refresh`.
   Evidence: MAP.md §2.3.2, §2.3.3, §2.3.4; contract.d.ts HistoryPage, BootSnapshot
   Verify: test "$(curl -s -o /dev/null -w '%{http_code}' "$DASH/api/history?d=7d")" = 200 && curl -s $DASH/api/system | grep -q '"load"'
   Owner: builder

2. `web/views/history.mjs`: the `details.flt` filter summary, account/range/live chips, search form, day groups, rows (`.t .acct .proj .ttl .sz .sid`, LIVE pill, attach/resume `.go` with `data-nw`, delete `<details class=kx del>` confirm → `/a/del`), pager; `/` key opens the filter.
   Evidence: MAP.md §2.3.2
   Verify: node docs/qa/probes/views-check.mjs webkit history
   Owner: builder

3. `web/views/system.mjs`: Metrics (`.mbars` 2×2 on phones with `b.mbar-pct`, warn states), Environment rows, Terminal card with the `Restart All` confirm → `/a/restartall`, Usage & Reclaim (refresh via `POST /api/usage/refresh` with the 4 s re-poll while collecting, reclaim preview checkboxes → `/sys/reclaim`), per-account limits/spend/breakdown; `usage` and `system` topics update it live.
   Evidence: MAP.md §2.3.4, §2.2 'System facelift'; contract.d.ts UsageEvent, SystemEvent
   Verify: node docs/qa/probes/views-check.mjs webkit system
   Owner: builder

4. `web/views/device.mjs`: Mobile/Web segments, info and control cards (`/droid/*`, `/watch/*` forms), remote-keys card driving the noVNC iframe via `window.rfb`, the phone-UA "Open Screen" link, `body.devfs` full-screen toggle; the iframe mounts on route enter and unmounts on leave or `visibilitychange: hidden`; booting state re-polls every 4 s.
   Evidence: MAP.md §2.3.5, §5.2, §5.5; ledger D-U4
   Verify: node docs/qa/probes/views-check.mjs chromium device
   Owner: builder

5. `web/views/session.mjs` (`/s/<acct>/<sid>`): meta grid, LIVE pill, attach/resume button, pause/resume/rename/kill forms when live, the 8 MB note, newest-first pages of 25 with `details` for long messages, tool/result/compaction disclosures.
   Evidence: MAP.md §2.3.3
   Verify: node docs/qa/probes/views-check.mjs webkit session
   Owner: builder

6. Split the server: `routes/{documents,api,actions,agents,device,md}.mjs`, `sse.mjs`, `static.mjs`, `legacy.mjs` (the inline dashboard: `page()`, `pageChrome()`, `CSS`, `FLEET_JS`, every `*View`), `lite.mjs` = boot + dispatcher + `--ui` flag; no HTML/CSS template literal outside `legacy.mjs` and `routes/documents.mjs`.
   Evidence: MAP.md §1.1, §1.6; ledger C-04, K-21, K-27, K-31
   Verify: ! grep -lE '<style|<div|class="' infra/dashboard/lite.mjs infra/dashboard/sse.mjs infra/dashboard/static.mjs infra/dashboard/routes/api.mjs && node infra/dashboard/lite.mjs --selftest
   Owner: builder

7. `--ui=legacy` serves exactly today's documents at `/` (byte-identical HTML for the fixture, modulo the nonce), `--ui=next` serves the shell; the service template gains the flag; `deploy-dashboard.sh` copies the new modules; `scripts/legacy-parity-check.mjs` fetches the fixture's `/`, `/history`, `/system`, `/device`, `/agents` under `--ui=legacy` and compares them with the pre-split HTML captured in phase 00 modulo the CSP nonce.
   Evidence: ledger B-11, K-21; MAP.md §1.6
   Verify: node scripts/legacy-parity-check.mjs
   Owner: builder

8. `docs/qa/probes/views-check.mjs <engine> <view>` for history, system, device, session: fixture data renders, filters/chips/pager navigate without a document load, forms post and the view updates, live topics patch the DOM.
   Evidence: docs/qa/probes/README.md conventions
   Verify: node docs/qa/probes/views-check.mjs webkit all
   Owner: builder

9. `e2e-infra` green on the split server (the 84 existing assertions plus phase 01's), `e2e-agents` green, preflight green.
   Evidence: MAP.md §6.1 G-23, G-25
   Verify: ./scripts/e2e-infra && bash scripts/e2e-agents.sh && PREFLIGHT_NO_LOCAL=1 ./scripts/preflight.sh
   Owner: verifier

10. Server budgets: total server JS ≤ 140 KB, no markup in server modules.
   Evidence: ledger K-27
   Verify: node scripts/budget.mjs --server --max 140
   Owner: verifier

11. View budgets and parity on `/history`, `/system`, `/device`, `/s/<fixture>` at both sizes, both engines.
   Evidence: ARCHITECTURE.md §9; ledger K-33
   Verify: for r in history system device session; do node scripts/budget.mjs --route $r --max 15 || exit 1; done && node scripts/parity-capture.mjs --ui next --out .agent-team/$RUN/parity && node scripts/parity-diff.mjs docs/qa/baseline/cockpit .agent-team/$RUN/parity --max 0.5
   Owner: verifier

## Out of scope

`/term`, `/md`, service worker, push, cutover.

<!-- Generated by scripts/gen-cockpit-specs.mjs from specs/cockpit/phases.json — do not edit by hand. -->
