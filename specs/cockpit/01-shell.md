---
branch: feat/cockpit-01-shell
release: feature
repos:
  - path: .
    stack: frontend
phase: 1
depends_on: specs/cockpit/00-baseline.md
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
  - name: phone layout review
    what: the shell at 390×844 beside docs/qa/baseline/cockpit/webkit/home-390.png, screenshot pair attached
    owner: alhe99
    due: 2026-10-14
---

# Phase 1 — Shell, build and the data layer at /next

Goal: A Preact 11 shell with the chrome, tab bar and token stylesheet of the current UI, one signals store on one resumable EventSource, served at `/next` beside the current UI from a committed `dist/`, inside the shell budget, with the contract type-checked.

Constraints (from ledger.md, kept):
- K-04 — see ARCHITECTURE.md §14 / ledger.md
- K-07 — see ARCHITECTURE.md §14 / ledger.md
- K-11 — see ARCHITECTURE.md §14 / ledger.md
- K-12 — see ARCHITECTURE.md §14 / ledger.md
- K-13 — see ARCHITECTURE.md §14 / ledger.md
- K-14 — see ARCHITECTURE.md §14 / ledger.md
- K-17 — see ARCHITECTURE.md §14 / ledger.md
- K-25 — see ARCHITECTURE.md §14 / ledger.md
- K-30 — see ARCHITECTURE.md §14 / ledger.md
- K-32 — see ARCHITECTURE.md §14 / ledger.md

Every task has three fixed sub-lines. **Evidence** is where the requirement comes from (a MAP.md row or
section, an ARCHITECTURE.md section, a ledger id). **Verify** is a shell command run from the repo root whose
exit code is the verdict — `scripts/verify-spec.mjs` runs them all and decides `ship` or `fix`. **Owner** is
`builder` (writes code) or `verifier` (runs checks, read-only). A task that cannot be verified by a command is
not a task; it is a `manual_gates` entry with an owner and a date.

`$DASH` is the dev instance (`dev_server` in the front-matter, default `http://127.0.0.1:3105`); `$RUN` is the
`.agent-team/<run-id>` directory. Both are exported by `verify-spec.mjs`.

## Tasks

1. `package.json` + `package-lock.json`: `preact@11.0.1`, `@preact/signals@2.11.x`, `preact-iso@2.12.x`, `marked` (pinned), `esbuild@0.28.x` exact; devDependencies `typescript`, `lighthouse@13.5.0`, `pngjs`, `pixelmatch`. `npm ci --ignore-scripts` succeeds off-server; nothing is installed on the box by any script.
   Evidence: ARCHITECTURE.md §1; ledger D-07, M-4
   Verify: npm ci --ignore-scripts --no-audit --no-fund && node -e "const p=require('./package.json');process.exit(p.dependencies.preact==='11.0.1'?0:1)"
   Owner: builder

2. `build.mjs`: esbuild per ARCHITECTURE §1 (`esm`, splitting, minify, `es2022`, `.mjs` output, `[name].[hash]`, metafile), the C0-escape post-pass, `dist/manifest.json` with sha256 per output, no `.map` in `dist/`; the Preact 10.29.x fallback alias present as a commented one-liner.
   Evidence: ARCHITECTURE.md §1; ledger A-04, A-11, K-04, K-11, K-25
   Verify: node build.mjs && test -f dist/manifest.json && ! grep -rlP --include='*.mjs' --include='*.css' --include='*.json' '[\x00-\x08\x0B-\x1F\x7F]' dist/ && ! ls dist/*.map 2>/dev/null
   Owner: builder

3. `web/tokens.css`: `@layer tokens, base, components, views`; the 32 custom properties of MAP §2.2 with identical values, the chrome, card, tab-bar, FAB, facelift and System-facelift rules reproduced; `color-scheme: dark` only. `scripts/tokens-check.mjs` asserts every `--var` of the legacy `:root` exists in `tokens.css` with the same value.
   Evidence: MAP.md §2.2 (tokens, @media table, facelift blocks); ledger B-01, K-12
   Verify: node scripts/tokens-check.mjs && node scripts/budget.mjs --file tokens.css --max 12
   Owner: builder

4. `infra/dashboard/static.mjs`: serves `dist/` names verbatim under `/assets/` with `cache-control: public, max-age=31536000, immutable`, ETag from `manifest.json`, 304 on match, types `mjs css woff2 json` only, never `.map`; `UI_ASSET_TYPES` and preflight G-02 updated together.
   Evidence: MAP.md §1.4; ledger A-11, K-11, K-32
   Verify: F=$(node -p "Object.keys(require('./dist/manifest.json').files).find(f=>f.endsWith('.mjs'))") && test "$(curl -s -o /dev/null -w '%{http_code}' $DASH/assets/$F)" = 200 && curl -sI $DASH/assets/$F | grep -qi immutable
   Owner: builder

5. `GET /next/*` returns the shell document: per-response nonce CSP (`script-src 'self' 'nonce-…'; style-src 'self' 'nonce-…'`), `<link rel=stylesheet href=/assets/tokens.<hash>.css>`, the chrome of `pageChrome()` (header, five tabs, FAB, footer) as markup, `<script type="application/json" id="boot">` with the `BootSnapshot` for the route, module script for `main.<hash>.mjs`; manifest link and meta tags byte-identical to `page()`.
   Evidence: MAP.md §2.1, §3.7; contract.d.ts BootSnapshot; ledger K-07, K-20
   Verify: curl -s $DASH/ | grep -q 'id="boot"' && curl -s $DASH/ | grep -q 'tokens\.' && test "$(curl -s -o /dev/null -w '%{http_code}' $DASH/history)" = 200
   Owner: builder

6. `web/main.mjs`: preact-iso router for the eight shell routes with lazy `import()` per view (stub views that render the route name), active tab from the path, `document.startViewTransition` around route changes with `.tabs{view-transition-name:tabs}`, `a[href]` interception that skips `/term*`, `/md`, `/oauth2/*`, `data-nw` links and modified clicks.
   Evidence: MAP.md §2.1 'Tab list', §3.2 R-04..R-07; ledger K-35
   Verify: node docs/qa/probes/shell-check.mjs webkit
   Owner: builder

7. `docs/qa/probes/shell-check.mjs <engine>`: at 390×844 the five `.tb` tabs render inside the safe area with no horizontal overflow, `.tabs` is fixed and floating (left ≥ 10, right ≤ 380), tapping a tab changes the route without a document load, `startViewTransition` was invoked when supported; at 1280×800 the header nav shows and the tab bar is hidden.
   Evidence: MAP.md §2.1; docs/qa/journeys/mobile-facelift.md
   Verify: node docs/qa/probes/shell-check.mjs webkit && node docs/qa/probes/shell-check.mjs chromium
   Owner: builder

8. `web/store.mjs`: one `EventSource` on `/stream?topics=…`, signals for `fleet`, `agents`, `chat`, `chatend`, `usage`, `system`; the boot snapshot seeds the signals before the stream opens; reconnect on `error`+`CLOSED` with 1 s→30 s jittered backoff; close after 60 s hidden, reopen on visible; after a reconnect that skipped a `chatend`, refetch `/api/agents/<n>/chat`. `scripts/store-check.mjs` drives it with a fake EventSource.
   Evidence: MAP.md §3.4; contract.d.ts StreamEvent; ledger B-06, K-14, K-17, K-34
   Verify: node scripts/store-check.mjs
   Owner: builder

9. Server: `/stream` emits the additive `usage` and `system` topics (shapes from `usage()` and `hostInfo()`), cap raised to 16 (`STREAM_MAX_CLIENTS`), `/events` unchanged; `stream-cap-check.mjs` reads the new constant.
   Evidence: MAP.md §1.2, §1.3; contract.d.ts; ledger K-13, K-17
   Verify: PORT=3105 node scripts/stream-cap-check.mjs && PORT=3105 MOWS_TEST_HOOKS=1 node scripts/stream-replay-check.mjs
   Owner: builder

10. `scripts/contract-check.mjs`: a stub server that emits one of each `StreamEvent` and answers each `/api/*` route with its declared shape; `web/tsconfig.json` with `checkJs` over `web/` and the stub; `tsc --noEmit` is the check.
   Evidence: ARCHITECTURE.md §11; web/contract.d.ts
   Verify: npx tsc --noEmit -p web/tsconfig.json
   Owner: builder

11. `/stream` reaches the browser unbuffered through Caddy: the `e2e-infra` suite's new `chk` passes inside the container.
   Evidence: ledger K-16; MAP.md §1.2 'Caddy handling'
   Verify: ./scripts/e2e-infra
   Owner: verifier

12. Shell budget and determinism.
   Evidence: ARCHITECTURE.md §9; ledger K-30
   Verify: node scripts/budget.mjs --route shell --max 30 && node build.mjs && git diff --exit-code -- dist/
   Owner: verifier

13. Lighthouse on `/next` (warn) and the parity screenshot pair for the phone layout review.
   Evidence: ARCHITECTURE.md §9, §13
   Verify: node scripts/lh-gate.mjs --url $DASH/next/ --lcp 2500 --tbt 200 --runs 3 --warn && node scripts/parity-capture.mjs --ui next --route / --out .agent-team/$RUN/parity
   Owner: verifier

## Out of scope

View content (every route renders its name only), terminal, device, markdown, push, service worker. The current UI at `/` is untouched.

<!-- Generated by scripts/gen-cockpit-specs.mjs from specs/cockpit/phases.json — do not edit by hand. -->
