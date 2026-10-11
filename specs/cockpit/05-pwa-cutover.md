---
branch: feat/cockpit-05-pwa-cutover
release: feature
repos:
  - path: .
    stack: frontend
phase: 5
depends_on: specs/cockpit/04-heavy-pages.md
outward: none
dev_server: MOWS_TEST_HOOKS=1 node infra/dashboard/lite.mjs --port 3105 --host 127.0.0.1 --ui=next
gates:
  size_limit: fail
  lighthouse: fail
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
  - name: push + badge on iOS
    what: Home Screen install, one needs-you push received with the app closed, badge count equals the waiting sessions, Wake Lock held while a session is working
    owner: alhe99
    due: phase Gate 1
---

# Phase 5 — Service worker, badge, push, gates to fail, /next → /

Goal: The installed-app layer (shell-caching worker with an allowlist, badge and push on `needs-you`), every gate flipped to `fail`, the shell at `/` with the old UI one flag away, `/ui/*` retired by redirect.

Constraints (from ledger.md, kept):
- K-20 — see ARCHITECTURE.md §14 / ledger.md
- K-21 — see ARCHITECTURE.md §14 / ledger.md
- K-28 — see ARCHITECTURE.md §14 / ledger.md
- K-37 — see ARCHITECTURE.md §14 / ledger.md
- K-38 — see ARCHITECTURE.md §14 / ledger.md

Every task has three fixed sub-lines. **Evidence** is where the requirement comes from (a MAP.md row or
section, an ARCHITECTURE.md section, a ledger id). **Verify** is a shell command run from the repo root whose
exit code is the verdict — `scripts/verify-spec.mjs` runs them all and decides `ship` or `fix`. **Owner** is
`builder` (writes code) or `verifier` (runs checks, read-only). A task that cannot be verified by a command is
not a task; it is a `manual_gates` entry with an owner and a date.

`$DASH` is the dev instance (`dev_server` in the front-matter, default `http://127.0.0.1:3105`); `$RUN` is the
`.agent-team/<run-id>` directory. Both are exported by `verify-spec.mjs`.

## Tasks

1. `web/sw.mjs` → `/sw.js`: precache the shell document, `dist/` and `tokens.css` by manifest hash; answer navigations from cache only for `/`, `/history`, `/system`, `/device`, `/agents*`, `/s/*`; network-only for `/term*`, `/oauth2/*`, `/vnc/*`, `/droidview/*`, `/api/*`, `/stream`, `/events`, `/a/*`, `/md`; never cache a 3xx; the inline offline page kept; `skipWaiting` + `clients.claim` as today; `scripts/sw-check.mjs` loads the worker in a fake `ServiceWorkerGlobalScope` and asserts the allowlist, that a 3xx is never cached, that `/term/` is passed through, and the offline fallback body.
   Evidence: MAP.md §2.5 'Service worker'; ledger B-10, K-20
   Verify: node scripts/sw-check.mjs
   Owner: builder

2. Badge: `navigator.setAppBadge(n)` with `n` = `needs-you` sessions from the `fleet` signal, `clearAppBadge()` on `focus`; `navigator.wakeLock.request('screen')` while any session is `working` and the tab is visible.
   Evidence: contract.d.ts FleetItem; ledger O-4
   Verify: node docs/qa/probes/pwa-check.mjs chromium badge
   Owner: builder

3. Push server: VAPID key pair generated once into the settings directory, `GET /api/push/key`, `POST`/`DELETE /api/push/subscribe` (same-origin, ≤ 4 KB, stored as JSON), sender in `sse.mjs` on a `needs-you` transition (debounced 30 s per session) implementing RFC 8291 aes128gcm + RFC 8292 VAPID on `node:crypto` with the declarative payload `{web_push: 8030, notification, app_badge}`; `scripts/push-check.mjs` encrypts to a generated key and decrypts with WebCrypto.
   Evidence: contract.d.ts push section; ledger C-06, K-37
   Verify: node scripts/push-check.mjs && test "$(curl -s -o /dev/null -w '%{http_code}' $DASH/api/push/key)" = 200
   Owner: builder

4. Push client: a `Notifications` card on the System view (permission state, subscribe/unsubscribe, last delivery), subscription posted with the VAPID key; the worker's `push` handler shows the notification and `notificationclick` navigates.
   Evidence: MAP.md §2.3.4 System layout; ledger K-37
   Verify: node docs/qa/probes/pwa-check.mjs chromium push
   Owner: builder

5. Cutover: `--ui=next` is the default, `/` serves the shell, `GET /next/*` 301s to the same path without the prefix, `GET /ui/*` 301s into the shell routes via `uiTwinPath`'s inverse, the manifest is byte-identical, `start_url: /app` still 302s to `/term/`.
   Evidence: MAP.md §1.1 S-04, S-29, S-38; ledger K-20, K-28
   Verify: test "$(curl -s -o /dev/null -w '%{http_code}' $DASH/)" = 200 && curl -s $DASH/ | grep -q 'id="boot"' && test "$(curl -s -o /dev/null -w '%{http_code}' $DASH/ui/agents)" = 301 && curl -s $DASH/manifest.webmanifest | grep -q '"start_url":"/app"'
   Owner: builder

6. `e2e-infra.sh`: the `/ui` assertions (lines 195–234, 259–323: chrome greps, the 20 480 B document ceiling, `views/capability` import-map grep, the 3-nonce rule, `<noscript>` twin) are rewritten for `/` + `/assets/` one by one, each listed in the commit message; the `<noscript>` twin check stays until Stage 8 step 4.
   Evidence: MAP.md §6.1 G-23, §6 'would break' #7; ledger C-05, K-28, K-36
   Verify: ./scripts/e2e-infra
   Owner: builder

7. Gates to `fail`: `budget.mjs`, `lh-gate.mjs`, `parity-diff.mjs` and `git diff --exit-code -- dist/` run in `ci.yml` without `--warn`; `preflight.sh` runs `budget.mjs` for every route.
   Evidence: ARCHITECTURE.md §9, §12; ledger K-30
   Verify: grep -q 'budget.mjs' .github/workflows/ci.yml && grep -q 'lh-gate' .github/workflows/e2e-infra.yml && grep -q 'budget.mjs' scripts/preflight.sh
   Owner: builder

8. README screenshots regenerated from the new UI by `docs/assets/stage-demo.sh` (its `'/home'` literal hooks moved to `legacy.mjs`/`routes/documents.mjs`); `docs/architecture.md` 'Two navigation models' rewritten for one model + the `--ui=legacy` flag.
   Evidence: MAP.md §8 M-05, M-10; docs/architecture.md:256-372
   Verify: bash -n docs/assets/stage-demo.sh && ! grep -q 'Two navigation models' docs/architecture.md
   Owner: builder

9. `docs/qa/probes/pwa-check.mjs <engine> <mode>`: `badge` (fixture fleet with one needs-you → `setAppBadge(1)` observed via a stub), `push` (subscribe posts the key, the worker's handler shows a notification from a `push` event dispatched in-page), `sw` (allowlisted navigation served from cache offline; `/term/` not intercepted).
   Evidence: docs/qa/probes/README.md conventions
   Verify: node docs/qa/probes/pwa-check.mjs chromium all
   Owner: builder

10. All gates in fail mode on `/`: every route budget, Lighthouse on `/`, `/history`, `/system`, `/agents` inside the e2e-infra container, parity on every route, `dist/` determinism, preflight.
   Evidence: ARCHITECTURE.md §9
   Verify: node scripts/budget.mjs --all && node scripts/lh-gate.mjs --url $DASH/ --lcp 2500 --tbt 200 --runs 3 && node scripts/parity-capture.mjs --ui next --out .agent-team/$RUN/parity && node scripts/parity-diff.mjs docs/qa/baseline/cockpit .agent-team/$RUN/parity --max 0.5 && node build.mjs && git diff --exit-code -- dist/ && PREFLIGHT_NO_LOCAL=1 ./scripts/preflight.sh
   Owner: verifier

11. Deploy dry-run for Stage 8 step 3 and the rollback line: `deploy-dashboard.sh --dry-run` lists the flag flip, and `--ui=legacy` on the dev instance serves the old `/`.
   Evidence: ledger K-21, K-24; ARCHITECTURE.md §10
   Verify: scripts/deploy-dashboard.sh --dry-run | grep -q 'claude-dash-lite' && node scripts/legacy-parity-check.mjs
   Owner: verifier

## Out of scope

Removing `legacy.mjs`, the `/agents` twin and the `<noscript>` checks — Stage 8 step 4, one release later, its own spec.

<!-- Generated by scripts/gen-cockpit-specs.mjs from specs/cockpit/phases.json — do not edit by hand. -->
