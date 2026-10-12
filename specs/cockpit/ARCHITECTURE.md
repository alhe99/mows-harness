# ARCHITECTURE — the mows cockpit rebuild

Stage 3 output. The research decision (Preact 11 + signals, off-server esbuild with `dist/` committed, native CSS
tokens, one SSE stream, lazy heavy pages, CI size and Lighthouse gates) made concrete against `MAP.md` (Stage 1,
validated in Stage 2) with every `kept` row of `ledger.md` turned into a constraint `K-nn`. Nothing here re-opens the
stack; everything here is something a Builder can be held to and a Verifier can measure.

Owner decisions carried in (ledger, 2026-10-11): full SPA for every tab (O-1), fonts 80 kB (O-2), pinned-CDN mermaid
on `/md` (O-3), push + badge in this run (O-4), visual parity by screenshot diff (D-U3), `/term` rebuilt on xterm.js 6
and `/device` kept as an iframe document (D-U4).

## 1. Layout

```
web/                      source, unminified ESM (gates import from here — K-26)
  main.mjs                shell entry: router, store boot, tab bar, chrome
  store.mjs               signals + one EventSource (K-13, K-14, K-17)
  contract.d.ts           the one shared type file (this document §11)
  tokens.css              @layer tokens, base, components, views — one dark set (K-12)
  views/{sessions,history,system,device,agents,agent,run,session}.mjs   lazy routes
  pages/term/             separate document: xterm 6 client + ttyd protocol (§6)
  pages/md/               separate document: server-rendered markdown + pinned mermaid (§5)
  sw.mjs                  service worker source (§8)
  vendor/                 nothing — dependencies come from package-lock.json, built off-server
build.mjs                 esbuild 0.28.x pinned; entries: main, views/*, pages/term, pages/md, sw
dist/                     committed output: [name].[hash].mjs/.css, manifest.json (sha256 per file) — K-25, K-30
infra/dashboard/
  lite.mjs                boot + dispatcher only after phase 03 (K-27)
  routes/*.mjs            api, actions, documents
  sse.mjs                 /stream and /events
  static.mjs              serves dist/ names verbatim under /assets/ (K-11, K-32)
  legacy.mjs              the current inline dashboard behind --ui=legacy until Stage 8 step 4 (K-21, K-31)
```

Build rules (K-04, K-11, K-25, K-30): `format: esm, splitting: true, minify: true, target: es2022,
outExtension {'.js': '.mjs'}, entryNames/chunkNames '[name].[hash]', metafile: true`; a post-pass rewrites every raw
C0 byte inside string literals to `\xNN` and asserts zero control bytes in `dist/`; `dist/manifest.json` lists every
output with its sha256; `.map` files are never written to `dist/`. Two builds of the same lock file are byte-identical
(measured native arm64 vs x86 vs wasm — ledger A-04/M-4). CI runs `node build.mjs && git diff --exit-code -- dist/`.
Fallback line written here as the plan asked: if the phase 02 WebKit probes show a Preact 11 hydration or ref
regression, `build.mjs` aliases `preact` to `preact@10.29.x` (`alias: { preact: 'preact10' }`, one line) and
`@preact/signals` to its 1.x line; nothing else changes.

`/next` is the shell's mount while the current UI serves `/`; phase 05 swaps them (`--ui=next` default) and `/ui/*`
answers 301 into the shell routes (K-28).

## 2. Views (full SPA — O-1)

One shell document for every route under `/`: `/` Sessions, `/history`, `/system`, `/device`, `/agents`,
`/agents/<name>`, `/agents/<name>/<run>`, `/s/<acct>/<sid>`. Each view is a lazy `import()` and a route closure
with its own budget (K-02). `/term` and `/md` are separate documents and never enter the shell graph.

The first paint carries data (K-07): the shell HTML inlines `<script type="application/json" id="boot">` with the
fleet snapshot (and, per route, the history page / system panel / agent list it would otherwise fetch), so LCP needs
no fetch and no SSE round trip. Lighthouse baseline to beat: `/` = 1 652 ms (MAP §7.5).

What the SPA must give back, each a numbered task with a probe (K-35, ledger O-1):
- prerender → prefetch of the route's JSON on `pointerenter`/`touchstart` of a tab link, same exclusions as today's
  speculation rules (never `/term*`, never `fresh=1`/`reclaim=1`);
- bfcache → the store keeps the last list per route and the scroll offset; Back/Forward re-render with no request;
- cross-document view transitions → `document.startViewTransition` around route changes, `.tabs` keeps
  `view-transition-name: tabs`;
- no-JS → ends with `legacy.mjs` (K-36). Until then POST actions still work as forms: every action button is a
  `<form method=post>` the shell intercepts with `fetch` and falls back to a normal submit.

Behavioural invariants, one task each (K-18, MAP §2 + §8 M-13): `a[data-nw]` named-window reuse on desktop; keys
1–9 attach and `/` focuses the filter; pull-to-refresh and the `vpfix` re-measure in standalone; `<details name=fm|am>`
exclusive menus; `form.busy` + clear on `pageshow`; `#envout` and `/z?t=` beacons; `termHref` mints a fresh 8-hex tabid
per render; `.termfab` top-anchoring in standalone; every `aria-label`/`aria-hidden`/`role=alert` the map lists.

## 3. State

One `EventSource` per tab on `GET /stream?topics=…` (K-13). Events and payloads are the four that exist today —
`fleet`, `agents`, `chat`, `chatend` — unchanged; `usage` and `system` are added as topics with the shapes in
`contract.d.ts`. Only `chat` carries `id:` (`<agent>:<turn>:<seq>`), so `Last-Event-ID` replay keeps working (K-14);
snapshot topics resync from the first tick. Heartbeat stays `: hb` every 25 s (ledger D-06).

Client (K-17): on `error` with `readyState === CLOSED` the store reopens with backoff (1 s doubling to 30 s, jitter);
on `visibilitychange: hidden` for 60 s it closes and reopens on `visible`; on reconnect after a `chatend` it missed,
it refetches `/api/agents/<n>/chat` and clears `busy` (K-34). Server: `/stream` cap raised to 16 with G-18 run at that
value and RSS recorded against C-3 (150 MB).

Caddy (K-16): `/stream` joins `@nosse` and the `(sse)` snippet (`flush_interval -1`) in both site blocks; phase 01
proves time-to-first-event < 3 s through Caddy with `curl -N`.

## 4. Styling

`web/tokens.css` is one stylesheet, `@layer tokens, base, components, views`, served as a hashed immutable file (not
inlined — today 46 753 B ship in every HTML response and never cache; MAP §2.6). Tokens are the 32 custom properties
of MAP §2.2 with the same values; the facelift blocks are reproduced rule for rule. One dark theme, `color-scheme:
dark`, no `light-dark()` (K-12). The 12 terminal themes stay terminal-only: `themes.json` is the single source,
`[data-theme]` blocks exist only in the `/term` document and feed `term.options.theme`.

Parity (D-U3, K-33): the baseline is recaptured in phase 00 against `docs/qa/probes/fixture.sh` with a frozen clock
and fixed fleet/usage/host data, animations off, every route at 390×844 (DPR 3) and 1280×800 on WebKit and Chromium,
then diffed per view with a threshold of 0.5 % differing pixels. Any intended deviation is a `kept` ledger row first.

## 5. Markdown

`marked` (pinned) with the existing `safeHref`, `renderer.html` and `tokenizer.tag` overrides moved from
`app/views/chat.mjs` unchanged, so G-15's 91 checks and 6 000-case fuzz keep their target (K-08). Streaming renders
per block: the live buffer is split on blank lines, closed blocks are memoised by content hash, only the open tail is
re-parsed per delta. `streaming-markdown` is not used (ledger A-08).

`/md` stays a separate document (`pages/md/`): the server renders `mdHtml` as today, the page loads mermaid only when
a `pre[data-lang=mermaid]` scrolls into view, from the CDN pinned to `mermaid@12.1.0` with an `integrity=` hash
(O-3), default ELK layout (K-09). Its CSP is BASE_CSP plus that one script source (K-10).

## 6. Terminal (D-U4)

`pages/term/` is a new document served by Caddy's `@termhtml` route in place of the generated `term-index.html`
(the old file is kept as `term-index.legacy.html`; rollback is the file swap — K-32). Assets load from `/assets/`,
never `/term/` (the `handle /term*` prefix goes to ttyd). The page builds its socket URL as `/term/ws` + the same
`?arg=` query and speaks ttyd 1.7.4's framing exactly as MAP §4.3 records it: `GET /term/token`, an unprefixed JSON
first frame `{AuthToken, columns, rows}`, then `'0'` input / `'1'` resize / `'2'` pause / `'3'` resume up, and
`'0'` output / `'1'` title / `'2'` prefs down with flow control 1e5 / 10 / 4. `'2'` prefs are applied through an
explicit allowlist (ledger D-08). All of this has a unit test with a fake socket (K-22) — today nothing asserts it.

xterm `@xterm/xterm@6.0.0` + `addon-fit` + `addon-unicode11` + `addon-web-links`; `addon-webgl` loads lazily on
Chromium with `onContextLoss` → DOM renderer fallback; WebKit uses the DOM renderer. The 12 blocks map as the ledger
sorted them (B-12): dropped (WebSocket wraps, font/theme guardians, `?u11` activation shim); ported on public API
(key bar via `term.input`, copy overlay via `buffer.active`, session pill/sheet, back key, image attach with the
deployed `ccimg-v2` + an `x-name` handler on `/shot` — K-23, restart key, font keys, theme picker); kept behind their
`?x=off` kill switches; and two that need a phone in hand — IME shadow-line and resume-after-sleep repaint — are a
manual gate (K-22). `window.term` stays exposed because `mobile-journey.mjs:110` reads
`term._core._renderService.dimensions.css.cell.width`. The `web-term.sh` picker renders inside the terminal and is
unchanged (MAP §8 M-01); the key set it expects is part of the term page's test fixture.

## 7. Device

`/device` is a shell route whose stage is the existing `/droidview/` (ws-scrcpy, tinyh264) or `/vnc/vnc.html`
(noVNC) iframe, exactly as today (D-U4); the remote-keys card, full-screen toggle and the phone-UA "Open Screen"
link port as-is. The iframe mounts on route enter and unmounts on leave or `visibilitychange: hidden`.

## 8. PWA

Manifest `id: '/'`, `start_url: '/app'`, `scope: '/'` stay byte-identical — installed apps cache them (K-20). A bare `/app`
answers 302 `/` when the shell owns `/` (O-5, 2026-10-11); `/app?s=`, `/app?open=` and `--ui=legacy` still 302 into the terminal. The
service worker caches the shell document, `dist/` files and `tokens.css` for an explicit navigation allowlist
(`/`, `/history`, `/system`, `/device`, `/agents*`, `/s/*`); everything else — `/term*`, `/oauth2/*`, `/vnc/*`,
`/droidview/*`, `/api/*`, `/stream`, `/events`, `/a/*`, any 302 — is network-only. Offline falls back to the inline
page the current `sw.js` already serves.

Badge (O-4): `navigator.setAppBadge(n)` with `n` = sessions in `needs-you` from the `fleet` event; cleared on
`focus`. Push (O-4, K-37): `GET /api/push/key` (VAPID public key), `POST`/`DELETE /api/push/subscribe` (subscription
JSON, same-origin guarded, stored under the settings directory); the sender runs in `sse.mjs` on a `needs-you`
transition and implements RFC 8291 (aes128gcm) + RFC 8292 (VAPID) on `node:crypto` — no npm dependency reaches the
box; payload is the declarative `{ web_push: 8030, notification: {...}, navigate }` form so iOS 18.4+ shows it without
waking the worker. iOS delivery, badge after install and Wake Lock while a session is `working` are a manual gate
with an owner and a date (K-38).

## 9. Budgets

All sizes **gzip-9** (K-06) — the encoding phones receive through Caddy, and the same unit as G-03 / C-2. Measured
from `dist/manifest.json` + the esbuild metafile (route closure = entry + every chunk it statically imports).

| budget | value | measurement command (the Verify line) |
|---|---|---|
| `shell_js_kb` | 30 | `node scripts/budget.mjs --route shell --max 30` |
| `view_js_kb` (each lazy route closure, excluding shared vendor chunks) | 15 | `node scripts/budget.mjs --route <view> --max 15` |
| `grid_js_kb` (the `/grid` route closure: desktop only, link hidden on phones, brings its own stylesheet through CSSOM; the shared chunks `budget.mjs` counts are about 10 kB of it) | 20 | `node scripts/budget.mjs --route grid --max 20` |
| `md_vendor_kb` (marked chunk) | 25 | `node scripts/budget.mjs --chunk marked --max 25` |
| `css_kb` (`tokens.css`) | 12 | `node scripts/budget.mjs --file tokens.css --max 12` |
| `fonts_kb` (identity bytes, two woff2) | 80 | `node scripts/budget.mjs --fonts --max 80` |
| `term_js_kb` (term entry closure + xterm.css; WebGL lazy and fonts excluded) | 130 | `node scripts/budget.mjs --route term --max 130` |
| mermaid in `dist/` | never | `! grep -rl mermaid dist/` |
| LCP / TBT (Lighthouse 13.5.0, default mobile profile, against the e2e-infra container behind Caddy, Playwright Chromium, `--max-wait-for-load=60000`, median of 3) | ≤ 2 500 ms / ≤ 200 ms | `node scripts/lh-gate.mjs --url /next/ --lcp 2500 --tbt 200` |
| dashboard RSS (C-3) | ≤ 150 MB | existing `e2e-infra.sh:448-450` |
| server JS total across `lite.mjs` + `routes/` + `sse.mjs` + `static.mjs` (K-27) | ≤ 140 KB | `node scripts/budget.mjs --server --max 140` |
| HTML/CSS in server modules (K-27) | none | `! grep -lE '<style|<div|class="' infra/dashboard/{lite.mjs,routes,sse.mjs,static.mjs}` |

Evidence the budgets are reachable (ledger, adversary M-1/M-2/M-8): shell = 7 571 B br measured for Preact 11 +
signals + store + fleet list; `tokens.css` = 9 091 B br for the entire current stylesheet; term bundle = 100 128 B
gz; `/` LCP 1 652 ms today with the same data inline.

Gates run in `warn` mode (`gates.size_limit`, `gates.lighthouse` in each phase's front-matter) until phase 05 flips
them to `fail`; a warn-mode trip is copied into the Builder handoff `notes` so Gate 1 shows it.

## 10. Server

`lite.mjs` keeps every route of MAP §1.1 and the SSE/API contract; phase 03 splits it into `routes/`, `sse.mjs`,
`static.mjs`, `legacy.mjs` with no behaviour change (`--selftest` and `e2e-infra` are the proof). `static.mjs` serves
`dist/` names verbatim with `cache-control: public, max-age=31536000, immutable` and an ETag from `manifest.json`;
`UI_ASSET_TYPES` grows to `mjs css woff2 json` and preflight G-02 is updated in the same commit (K-11). `/next` and
`--ui=legacy|next` select which document `/` returns; nothing is mounted at `/legacy` (K-21).

Deploy is a script, not an echo (K-24): `scripts/deploy-dashboard.sh` installs `lite.mjs` + `routes/` + `sse.mjs` +
`static.mjs` + `legacy.mjs` + `dist/` + `themes.json` + the term page, restarts `claude-dash-lite`, and smokes
`/healthz`; the Stage 8 table calls it. `webterm-settle.sh` joins its copy list (MAP §8 M-03).

## 11. The contract file

`web/contract.d.ts` is imported by Builders and Verifiers alike: the SSE event union, every `/api/*` response, the
push endpoints, the budget constants. A change to it is a reviewable diff — the executor cannot redefine the contract
to make its own tests pass. It type-checks against `scripts/contract-check.mjs`, a stub server that emits one of each
event and answers each endpoint with its declared shape (`tsc --noEmit` on the stub is the Verify line).

## 12. Gates and verification

Existing gates are re-pointed, not rewritten (K-26): G-05/G-15/G-16/G-21/G-22 take `UI_SRC` (default `web/`), G-07
checks `web/views/capability.mjs`, G-01 becomes `npm ci --ignore-scripts` lockfile integrity in CI, G-03 is replaced
by the per-route budgets above, G-02 follows the loader. G-23's `/ui` assertions are rewritten in phase 05 and listed
there one by one (K-28). New gates: `scripts/budget.mjs`, `scripts/lh-gate.mjs`, `scripts/term-proto-check.mjs`,
`scripts/parity-diff.mjs`, `scripts/push-check.mjs`, `scripts/contract-check.mjs` — each exit-code decided.

The verdict for a phase is decided by `scripts/verify-spec.mjs <spec>`: it runs every task's **Verify** line, writes
raw stdout/exit codes to `.agent-team/<run-id>/verify/<task>.log`, and prints `VERDICT: ship` or
`VERDICT: fix:[ids]`. `prompts/qa.md` for these runs calls it and attaches the logs; the Verifier does not narrate.

## 13. Design and manual gates (owner, date)

| gate | what is signed | owner | due |
|---|---|---|---|
| phone layout review | the phase 01 shell at 390×844 beside `baseline/`, screenshot pair | alhe99 | 2026-10-14 |
| real-device terminal | IME shadow-line, resume after sleep, key bar on an iPhone and one Android | alhe99 | phase 04 Gate 1 |
| push + badge on iOS | Home Screen install, one `needs-you` push received, badge count matches | alhe99 | phase 05 Gate 1 |
| 10-minute heap | heap delta after 10 min of agent streaming on one iPhone and one Android | alhe99 | phase 02b Gate 1 |

## 14. Constraints (every `kept` ledger row → one line)

K-02 budgets per route closure · K-04 C0 escape pass · K-05 term 130 kB gz · K-06 gzip-9 everywhere · K-07 boot
snapshot inline · K-08 marked, no smd · K-09 mermaid default layout, pinned · K-10 CSP per document · K-11 esbuild
names served verbatim · K-12 one dark token set, themes terminal-only · K-13 four events unchanged + two topics ·
K-14 `id:` on chat only · K-15 phase 02 = sessions + agents · K-16 `/stream` flush-excluded · K-17 store
reconnect + cap 16 · K-18 one task per invariant · K-19/K-36 no-JS ends with legacy.mjs · K-20 manifest
byte-identical, SW allowlist · K-21 `--ui` flag is the rollback · K-22 term protocol tests + phone gate · K-23 ccimg
v2 + x-name · K-24 deploy script · K-25 dist/manifest.json · K-26 gates re-pointed · K-27 server gates · K-28 `/ui`
301 · K-29 Lighthouse in the container · K-30 dist matches web · K-31 legacy.mjs in phase 03 · K-32 `/assets/`,
term-index.legacy.html · K-33 frozen parity baseline · K-34 chatend-gap case · K-35 platform-feature replacements ·
K-37 push contract · K-38 manual gates dated.

## 15. Phase map

| spec | proves | gate to next |
|---|---|---|
| `00-baseline` | numbers and tooling exist; gates run in warn mode; parity baseline frozen; deploy is a script | `budget.mjs`, `lh-gate.mjs`, `parity-diff.mjs` green in warn mode on the current UI |
| `01-shell` | shell + store at `/next` within budget, tokens stylesheet, contract type-checks | shell ≤ 30 kB gz, `/stream` first event < 3 s through Caddy, phone layout review signed |
| `02a-sessions` | the Sessions view at parity with every invariant | parity diff ≤ 0.5 % on `/`, probes green on WebKit |
| `02b-agents` | agents list / detail / chat / run with streaming at parity | G-15 + replay probes green, heap gate signed |
| `03-views` | History, System, Device, `/s/*` in the shell; server split; `--ui` flag | `--selftest` + `e2e-infra` green on the split server; parity on all four |
| `04-heavy-pages` | `/term` on xterm 6, `/md` with pinned mermaid | term ≤ 130 kB gz, protocol tests green, device gate signed |
| `05-pwa-cutover` | SW, badge, push, gates to `fail`, `/next` → `/`, `/ui` 301 | all gates `fail`-mode green, push gate signed, `/` serves `dist/` |
