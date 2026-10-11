---
branch: feat/cockpit-04-heavy-pages
release: feature
repos:
  - path: .
    stack: frontend
phase: 4
depends_on: specs/cockpit/03-views.md
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
manual_gates:
  - name: real-device terminal
    what: IME shadow-line typing, resume after screen lock, key bar geometry on one iPhone and one Android; `?ime=off` and `?paint=off` tried
    owner: alhe99
    due: phase Gate 1
---

# Phase 4 — /term on xterm.js 6 and /md as a lazy document

Goal: The terminal page rebuilt as our own document over the same ttyd socket with a tested protocol client and the key-bar behaviours ported, themed from `themes.json`; `/md` as a separate document with pinned mermaid loaded only when a diagram scrolls in.

Constraints (from ledger.md, kept):
- K-05 — see ARCHITECTURE.md §14 / ledger.md
- K-09 — see ARCHITECTURE.md §14 / ledger.md
- K-10 — see ARCHITECTURE.md §14 / ledger.md
- K-22 — see ARCHITECTURE.md §14 / ledger.md
- K-23 — see ARCHITECTURE.md §14 / ledger.md
- K-32 — see ARCHITECTURE.md §14 / ledger.md

Every task has three fixed sub-lines. **Evidence** is where the requirement comes from (a MAP.md row or
section, an ARCHITECTURE.md section, a ledger id). **Verify** is a shell command run from the repo root whose
exit code is the verdict — `scripts/verify-spec.mjs` runs them all and decides `ship` or `fix`. **Owner** is
`builder` (writes code) or `verifier` (runs checks, read-only). A task that cannot be verified by a command is
not a task; it is a `manual_gates` entry with an owner and a date.

`$DASH` is the dev instance (`dev_server` in the front-matter, default `http://127.0.0.1:3105`); `$RUN` is the
`.agent-team/<run-id>` directory. Both are exported by `verify-spec.mjs`.

## Tasks

1. `web/pages/term/ttyd.mjs`: the ttyd 1.7.4 client — `GET /term/token`, ws to `/term/ws` + the page's `?arg=` query with subprotocol `tty` and `arraybuffer`, unprefixed JSON first frame `{AuthToken, columns, rows}`, `'0'` input / `'1'` resize / `'2'` pause / `'3'` resume up, `'0'` output / `'1'` title / `'2'` prefs (allowlist: `fontSize`, `disableLeaveAlert`, `disableResizeOverlay`, `disableReconnect`, `titleFixed`) down, flow control 1e5 / 10 / 4, reconnect: close code 1000 → `Press ⏎ to Reconnect`, else auto after a fresh token. `scripts/term-proto-check.mjs` drives it with a fake socket.
   Evidence: MAP.md §4.3; ledger D-08, K-22
   Verify: node scripts/term-proto-check.mjs
   Owner: builder

2. `web/pages/term/index.html` + `term.mjs`: `@xterm/xterm@6.0.0`, `addon-fit`, `addon-unicode11` (`unicode.activeVersion='11'`), `addon-web-links`; DOM renderer by default, `addon-webgl` lazy on Chromium with `onContextLoss` → DOM; `window.term` exposed; the mobile head set (viewport, `<!--cc-pwa-->` metas, manifest `use-credentials`) reproduced; assets from `/assets/`, never `/term/`.
   Evidence: MAP.md §4.1, §4.3 defaults, §4.7 mobile-journey:110; ledger K-32
   Verify: node scripts/budget.mjs --route term --max 130 && curl -s $DASH/assets/$(node -p "Object.keys(require('./dist/manifest.json').files).find(f=>f.startsWith('term.'))") -o /dev/null -w '%{http_code}' | grep -qx 200
   Owner: builder

3. Themes: the `[data-theme]` blocks generated from `themes.json` at build time (the inline copy in `46-cctheme.html` goes), picker in the key bar + `?theme=<Name>` + `window.cctheme()`, precedence `localStorage.cctheme` → global `/settings/term-theme.json` (polled 30 s) → default; applies `term.options.theme`, body background and `theme-color`; `scripts/theme-tokens-check.mjs` asserts every theme and every one of its 20 keys from `themes.json` appears in the generated `[data-theme]` CSS, and that no second copy of the themes exists in the tree.
   Evidence: MAP.md §4.4; ledger B-01, K-12
   Verify: node scripts/theme-tokens-check.mjs && node docs/qa/probes/term-check.mjs chromium theme
   Owner: builder

4. Key bar (`#cckb`): the same keys in the same order (`‹`, pill, 📸, ⧉, 📋, ⟳, Esc NL IND Tab S-Tab UP DN LT RT PgUp PgDn ^C ^Bd KB, A- size A+, theme select) via `term.input()`; touch-scroll to wheel notches; `visualViewport` fit with the 120/520 ms debounce; `body.nozone`; standalone geometry CSS.
   Evidence: MAP.md §4.2 B-10, B-20, B-30, B-45, B-70; 'Key-bar final child order'
   Verify: node docs/qa/probes/term-check.mjs webkit keybar
   Owner: builder

5. IME shadow-line (`?ime=off`): capture-phase interception on coarse pointers, value diff replayed as `\x7f`×N + tail via `term.input`, Enter as a synthetic keydown, `enterkeyhint=send`, multiline paste → bracketed paste; reconnect kick on `visibilitychange`/`pageshow`/`online`.
   Evidence: MAP.md §4.2 B-50
   Verify: node docs/qa/probes/term-check.mjs webkit ime
   Owner: builder

6. Clipboard: OSC 52 via `term.parser.registerOscHandler(52, …)` → `navigator.clipboard.writeText` with the pending-until-gesture fallback; copy-on-select; the `⧉` overlay from `buffer.active` (wrapped rows re-joined) and the `📋` paste key; `?clip=off`.
   Evidence: MAP.md §4.2 B-00, B-60
   Verify: node docs/qa/probes/term-check.mjs chromium clipboard
   Owner: builder

7. Image/file attach (📸, paste, drop) → `POST /shot` with `x-name`, reply path pasted into the terminal; the session pill + bottom sheet (`/app/live.json?tab=`, `POST /a/switch`, mint-and-reload fallback, `allow-discrete` motion); back key; the `/z?t=term-v8` beacon.
   Evidence: MAP.md §4.2 B-40, B-75, B-30; §4.5; ledger K-23
   Verify: node docs/qa/probes/term-check.mjs webkit sheet
   Owner: builder

8. Repaint on foreground (`?paint=off`): `term.refresh(0, rows-1)` on `visibilitychange`/`pageshow`/`focus`/first content, resize coalesced 150 ms, the boot ladder (repaint → kick → reload ≤ 2), `/z?t=termdiag` beacons; the private `_writeBuffer` unjam watchdog is dropped and its absence noted in the page header.
   Evidence: MAP.md §4.2 B-80; ledger B-12
   Verify: node docs/qa/probes/term-check.mjs chromium paint
   Owner: builder

9. Caddy `@termhtml` serves `/opt/claude-dashboard/term-index.html` = the new document; `make-term-index.sh` now copies `dist/term.html` and keeps the previous file as `term-index.legacy.html`; `deploy-dashboard.sh` does both; `/term/__shim` pings removed.
   Evidence: MAP.md §4.6, §4.7 make-term-index self-checks; ledger D-02, K-32
   Verify: bash -n infra/webconsole/make-term-index.sh && infra/webconsole/make-term-index.sh --dry-run | grep -q legacy
   Owner: builder

10. `web/pages/md/`: the `/md` document — server `mdHtml` output, `.mdhead` with download, `article.mdv`, CSP = BASE_CSP + `script-src 'self' https://cdn.jsdelivr.net 'sha256-…'` for the one pinned `mermaid@12.1.0` module with `integrity=`, loaded by `IntersectionObserver` when the first `pre[data-lang=mermaid]` enters the viewport, default layout, tap-to-toggle full size; shares `tokens.css`; `docs/qa/probes/md-check.mjs <engine>` asserts the download link, the rendered README, mermaid absent from the network log until a diagram scrolls in, then one pinned CDN request with `integrity`, and tap-to-toggle.
   Evidence: MAP.md §2.3.7, §2.4 'mermaid loader'; ledger A-03, A-09, K-09, K-10, O-3
   Verify: node docs/qa/probes/md-check.mjs chromium && ! grep -rl mermaid dist/
   Owner: builder

11. `docs/qa/probes/term-check.mjs <engine> <mode>` (fake ttyd via `MOWS_TEST_HOOKS` ws echo) and `md-check.mjs`: the modes named above plus `proto` (bytes on the wire for each key).
   Evidence: MAP.md §4.7 'Not asserted anywhere'
   Verify: node docs/qa/probes/term-check.mjs webkit all && node docs/qa/probes/term-check.mjs chromium all
   Owner: builder

12. `mobile-journey.mjs` and `web-term-selfcheck.sh` pass against the new page (journey fixed to read `TERM_PAGE`, not `TERM`).
   Evidence: MAP.md §4.7; §6.1 G-30, G-31
   Verify: TERM_PAGE=dist/term.html DASH=$DASH node infra/webconsole/mobile-journey.mjs && infra/webconsole/web-term-selfcheck.sh
   Owner: verifier

13. Per-document CSP: `csp-admits.mjs` run on `/next/`, `/term/` and `/md` with each document's expected policy; term budget; parity of `/md` at both sizes.
   Evidence: ledger K-10, K-05; MAP.md §6.2 C-6
   Verify: node scripts/csp-admits.mjs $DASH/next/ --expect nonce && node scripts/csp-admits.mjs $DASH/md?f=$HOME/Documents/Projects/mows-harness/README.md --expect inline-style && node scripts/budget.mjs --route term --max 130 && node scripts/parity-capture.mjs --ui next --route /md --out .agent-team/$RUN/parity && node scripts/parity-diff.mjs docs/qa/baseline/cockpit .agent-team/$RUN/parity --route /md --max 0.5
   Owner: verifier

## Out of scope

Service worker, push, badge, cutover; the ttyd unit and `web-term.sh` are unchanged.

<!-- Generated by scripts/gen-cockpit-specs.mjs from specs/cockpit/phases.json — do not edit by hand. -->
