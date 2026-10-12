# Ledger — kept / rejected findings for the cockpit rebuild

Append-only. A `kept` finding becomes a constraint line in `ARCHITECTURE.md` and cannot be dropped later; a `rejected`
finding stays here with its reason. `open` means the owner decides (listed at the bottom with the recommendation);
it is closed by appending a row, never by editing one. Sources: `$SCRATCH/validate/{v1a,v1b,v2,v3,adversary}.md`
(session 2026-10-11); the adversary's measurements are reproduced in the `M-` table it left and summarised in
MAP.md §8.5 once this ledger is approved.

## Stage 2 — validators (2026-10-11)

| id | source | finding | verdict | action |
|---|---|---|---|---|
| L-01 | V1a | 44 line citations in MAP §1–§2 off by 1–6 lines; 7 claims false (no `/themes.json` consumer, `appView` never emits `menu`, 57 not 56 rows, 30 not 31 ICO glyphs, CSS const ends L2217, two dynamic-size rows) | kept | all applied in MAP.md in place, marked `[V1a]` where the claim changed |
| L-02 | V1b | 27 line citations in MAP §3–§7 off; 5 claims false (term page 907 lines / 701 377 B line 3, 10 sanctioned placeholders, 84 and 223 `chk` invocations, ttyd overlay reads `Press ⏎ to Reconnect`); the §3 "−92 offset" warning is moot | kept | applied in place; §3 note replaced |
| L-03 | V2 | 14 inventory rows missing (M-01…M-14) and 10 thinner-than-code rows; count deltas 41 vs 42 dispatcher branches, 84 vs 85 `chk` | kept | merged verbatim as MAP §8; count deltas recorded there, code wins |
| L-04 | V3 | 120 numbers re-measured, 115 within 5 %, 97 byte-exact; 5 flagged: `/` raw and `style=""` counts are live-content drift, CSS anchor L2217, RSS between the map's two samples | kept | anchor fixed; drift rows annotated as one-sample dynamic values |
| L-05 | merge | Lighthouse baseline added to MAP §7.5 (`/` 1 652 ms, `/history` 1 500, `/system` 1 802, `/ui/agents` **2 765** LCP); `/opt/google/chrome` is x86-64, Playwright's arm64 Chromium is the runner | kept | MAP §7.5 rewritten; the adversary's independent run (M-7) agrees within 2 % |

## Stage 2 — adversary (2026-10-11)

Severity as the adversary set it. "Constraint" is the sentence `ARCHITECTURE.md` carries as `K-nn`.

| id | sev | finding (short) | verdict | reason / constraint |
|---|---|---|---|---|
| A-01 | blocker | fonts ≤ 60 kB cannot hold: the two vendored faces are 79 688 B and incompressible; only a narrower subset fits | **open → see O-2** | recommendation: raise `fonts_kb` to 80 — D-U3 parity means the glyph coverage must not change |
| A-02 | blocker | per-view ≤ 15 kB fails for the Agents/chat view (19 065 B today before markdown; marked alone 12 528 B br) | kept | K-02: budgets are per **route closure** from the esbuild metafile; shared vendor chunks have their own line (`md_vendor_kb`), capability panel is a lazy chunk |
| A-03 | blocker | bundling mermaid 12 into a committed `dist/` trips G-10 (388 IPv4-shaped tokens) and G-03 (10×); CDN mermaid is blocked by the nonce CSP | **open → see O-3** | recommendation: `/md` stays its own document on BASE_CSP with CDN mermaid pinned to an exact version + SRI; mermaid is never in `dist/` |
| A-04 | blocker | a committed xterm 6 bundle carries 23 raw C0 bytes and fails G-11 | kept | K-04: `build.mjs` post-pass rewrites C0 bytes inside string literals to `\xNN` and asserts zero control bytes in `dist/`; no gate exemption |
| A-05 | major | "term page ≤ 120 kB" has no unit or scope; xterm+fit+u11+links+css = 88 kB br / 100 kB gz before the blocks | kept | K-05: term budget is the term entry closure + CSS, **gzip-9, 130 kB**, lazy WebGL and fonts excluded (the terminal keeps the system mono stack it has today) |
| A-06 | major | Brotli budgets measure an encoding no client receives (origin sends identity, Caddy does zstd/gzip, iOS takes gzip) | kept | K-06: every budget is gzip-9, the same unit as G-03/C-2; Lighthouse runs behind a compressing proxy (C-07) |
| A-07 | major | LCP ≤ 2.5 s is already failed by the client-rendered `/ui/agents` (2 713–2 765 ms); a client-rendered `/` is at risk | kept | K-07: the first fleet snapshot ships inside the HTML (inline JSON the shell adopts); no fetch or SSE round trip before LCP; baseline `/` = 1 652 ms is the comparison target |
| A-08 | major | `streaming-markdown` is unmaintained (2025-05) and emits `javascript:` hrefs live | kept | K-08: dropped; marked + the existing `safeHref`/renderer overrides stay; streaming cost fixed by per-block memoisation; G-15 corpus drives the streaming path |
| A-09 | major | `layout: 'dagre'` changes today's ELK rendering, so `/md` fails parity | kept | K-09: mermaid keeps its default layout; version pinned exactly (the CDN `@12` floats today) |
| A-10 | major | xterm 6 and mermaid inject `<style>`; a nonce-only `style-src` blocks them | kept | K-10: CSP is per document — shell keeps the nonce policy; `/term` and `/md` carry `style-src 'self' 'unsafe-inline'`; G-20/C-6 run per document |
| A-11 | major | esbuild's split output (`chunk.X.js`) cannot be served by today's loader (`UI_ASSET_TYPES`, crc32 rename, 3-nonce rule) | kept | K-11: `outExtension .js→.mjs`, esbuild's `[name].[hash]` is the only hash, `static.mjs` serves `dist/` names verbatim; G-02 updated with the loader |
| B-01 | blocker | "12 themes feeding UI tokens" + `light-dark()` contradicts D-U3 (the UI is single-theme dark; themes skin only the terminal; one theme is GitHub Light) | kept | K-12: UI tokens stay one dark set; `[data-theme]` lives only in `/term` and feeds `term.options.theme`; no `light-dark()`; `themes.json` is the single source (the inline copy in 46-cctheme goes) |
| B-02 | blocker | the plan states two SSE contracts (`session/chunk/usage/system` vs today's `fleet/agents/chat/chatend`) | kept | K-13: the four existing events and payloads are unchanged; `usage` and `system` are **additive** topics declared in `contract.d.ts` |
| B-03 | major | `id:` on every event breaks chat replay (last-event-id is one buffer per EventSource) | kept | K-14: only `chat` carries `id:`; snapshot topics resync on the first tick; G-19 gains "fleet event interleaved before the cut" |
| B-04 | blocker | phase 02 "Sessions view + streaming chunks" has no data source — chunks exist only for agent chat | kept | K-15: phase 02 = Sessions (fleet) **and** Agents/chat; journeys 2–4 target agent chat; no transcript-tail topic in this run |
| B-05 | major | `/stream` is buffered by Caddy `encode` (only `/events` is excluded) | kept | K-16: `/stream` joins `@nosse` and the `(sse)` snippet in both site blocks; phase 01 verifies time-to-first-event < 3 s through Caddy |
| B-06 | major | SSE_MAX 8 + one EventSource per tab leaves the 9th tab dead with no `onerror` | kept | K-17: store reopens with backoff on `error`/`CLOSED`, closes after 60 s hidden; `/stream` cap raised to 16 with G-18 run at the new value and RSS recorded |
| B-07 | major | an SPA shell forfeits prerender, bfcache and cross-document transitions; the last SPA spec never built the replacements | **open → see O-1** | recommendation: hybrid — Sessions and Agents live in the shell; History, System, Device, `/s/*`, `/md` stay server-rendered documents on the shared token stylesheet |
| B-08 | major | the current UI's behavioural invariants (data-nw, 1-9 and `/` keys, PTR, vpfix, `<details name>` menus, form.busy, beacons, termHref tabid, FAB top-anchor) have no task | kept | K-18: one task per invariant, each with a probe Verify in `docs/qa/probes/` |
| B-09 | major | removing `/legacy` ends the no-JS path silently | kept (resolved by O-1) | K-19: server-rendered documents keep PRG forms and `<details>` confirmations; the Sessions shell renders its first paint and forms server-side, so actions work without JS; `/agents` twin stays until the legacy flag is removed |
| B-10 | major | `start_url: /app` opens the terminal, not the dashboard; a scope-`/` SW would capture `/term/`, `/oauth2/*`, `/vnc/` | kept | K-20: manifest `id`/`start_url`/`scope` byte-identical; journey 1 targets `/app` → `/term/`; the SW answers from cache only an explicit navigation allowlist and never caches a 302 |
| B-11 | major | `/legacy` pages link and post to absolute new routes; "Caddy route flip" rollback does not exist (both are lite.mjs) | kept | K-21: no `/legacy` path mount — the old UI is a `--ui=legacy` flag on `lite.mjs` (code in `legacy.mjs`), rollback = flag + restart; Stage 8 table rewritten |
| B-12 | major | the 12 blocks are three classes: unnecessary under a custom client (shim WS wrap, font/theme guardians), portable on public API (`term.input`, `buffer.active`), and needing private API or a real device (ccpaint, IME) | kept | K-22: phase 04 carries a ttyd protocol client with framing tests, a manual iPhone gate (IME, resume-freeze) with owner+date, the `?x=off` kill switches, and `window.term` exposed for `mobile-journey.mjs` |
| B-13 | minor | `ccimg` v1 in repo vs v2 deployed with no server counterpart | kept | K-23: port v2 (what users have) and add the `x-name` handler to `/shot` |
| C-01 | major | `install.sh --all` only echoes the dashboard/term install lines; "nothing hand-edited" is false today | kept | K-24: `scripts/deploy-dashboard.sh` performs the install (modules, `dist/`, term page, restart, `/healthz` smoke); phase 00 |
| C-02 | major | a committed hashed `dist/` churns `scripts/manifest.txt` every build | kept | K-25: preflight accepts `dist/` as one manifest line verified against `dist/manifest.json` (sha256 per file, written by `build.mjs`); esbuild pinned exactly |
| C-03 | major | moving source to `web/` breaks G-05/G-07/G-15/G-16/G-21/G-22 fixed import paths | kept | K-26: phase 00 re-points every gate at `web/` (unminified ESM); G-03 moves to per-route `dist/` budgets; G-01 becomes lockfile integrity; no gate deleted without a ledger row |
| C-04 | major | "`lite.mjs` < 60 KB" proves nothing once code moves to other files (server code alone is ~118 KB) | kept | K-27: replaced by (a) no HTML/CSS template literals in server modules, (b) server JS total ≤ 140 KB across files, (c) `--selftest` passes |
| C-05 | major | the plan never says what happens to `/ui`, which G-23 and the probes assert | kept | K-28: `/ui/*` 301s into the shell routes at cutover (phase 05); the G-23 and probe assertions being rewritten are listed in that phase |
| C-06 | major | push + badge need new endpoints (VAPID, subscription store) — contradicts "contract unchanged" and needs a Home Screen install on iOS | **open → see O-4** | recommendation: push out of scope; `setAppBadge` from the open stream only |
| C-07 | major | the Lighthouse gate cannot reach production from CI (oauth) and MAP's command named an x86 Chrome | kept | K-29: Lighthouse runs against the `e2e-infra` container (Caddy in front, no auth, `MOWS_TEST_HOOKS=1`) with Playwright's Chromium; `lighthouse@13.5.0` pinned |
| C-08 | major | nothing checks that the committed `dist/` matches `web/` | kept | K-30: CI step `node build.mjs && git diff --exit-code -- dist/` |
| D-01 | blocker | phase 03 deletes the inline dashboard that Stage 8 still serves | kept | K-31: phase 03 moves it to `legacy.mjs` behind the flag; deletion is Stage 8 step 4 |
| D-02 | blocker | `/term-legacy` and any asset under `/term/` go to ttyd (`handle /term*`) | kept | K-32: new assets live under `/assets/`, never `/term/`; the old page is kept as `term-index.legacy.html` and rollback is the file swap; the new page builds its ws URL as `/term/ws?<same query>` |
| D-03 | blocker | the parity baseline is 4 live screenshots with clocks, counts and session names in them — not diffable | kept | K-33: phase 00 recaptures the baseline against `fixture.sh` with a frozen `Date.now`, fixed fleet/usage/host data and animations off, every view at 390×844 and 1280×800 on WebKit and Chromium, per-view diff threshold |
| D-04 | major | journey 3 misses "turn ended while asleep" (`chatBuf` cleared on `chatend`, nothing replays) | kept | K-34: G-19 and the probe gain that case: client refetches `/api/agents/<n>/chat` on reconnect, no stuck `busy` |
| D-05 | minor | template Verify lines use port 7680 and `grep -q 200` | kept | generator emits `curl -s -o /dev/null -w '%{http_code}'` compared to `200` against `127.0.0.1:3005` |
| D-06 | minor | heartbeat 25 s → 20 s with no reason | kept | stays 25 s |
| D-07 | minor | Preact 11 is 11 days old | kept | pin `preact@11.0.1`; fallback line `10.29.x` written into `build.mjs` |
| D-08 | minor | ttyd still pushes `'2'` prefs (`rendererType`, `fontSize`) | kept | the new client applies `'2'` through an explicit allowlist |

## Open decisions (owner)

| id | question | recommendation | closes |
|---|---|---|---|
| O-1 | Full SPA shell for every tab, or hybrid: Sessions + Agents live in the Preact shell, History / System / Device / `/s/*` / `/md` stay server-rendered on the shared token stylesheet? | **hybrid** — those documents already pass LCP (1.5–1.8 s), keep prerender/bfcache/no-JS for free, and parity is a stylesheet move instead of a rewrite; it halves the task count | B-07, B-09, B-04 |
| O-2 | Fonts: raise `fonts_kb` to 80 (today's exact glyph coverage), or subset to 55 kB and accept system-font fallback for € ™ − and the rest of latin-1? | **80** — parity; fonts are cached immutable so it is a one-time cost | A-01 |
| O-3 | Mermaid on `/md`: pinned CDN + SRI on a BASE_CSP document (as today), or vendor it outside the scanned tree? | **pinned CDN + SRI** — keeps `dist/` 5 MB smaller and the gates untouched; `/md` is auth-gated already | A-03 |
| O-4 | Push + badge: in this run (new endpoints, VAPID, manual iOS gate) or out (badge from the open stream only)? | **out** — badge-only now, push as its own spec after cutover | C-06 |

## Owner decisions (2026-10-11, closes O-1…O-4)

| id | decision | consequence |
|---|---|---|
| O-1 | **Full SPA, every tab** (not hybrid) | B-07 kept as K-35: each lost platform feature gets a numbered task with a probe Verify — prefetch on hover/touchstart for route data, store-restored list + scroll on Back/Forward, same-document view transitions with the pinned tab bar. B-09 kept as K-36: the no-JS path ends when `legacy.mjs` is removed (Stage 8 step 4); until then `--ui=legacy` serves it, and the G-23 `<noscript>` assertions are deleted in that same step, deliberately. Phase 02 splits into `02a-sessions` and `02b-agents` to stay under 15 tasks. |
| O-2 | **fonts_kb = 80** | A-01 closed: budget line reads `fonts_kb: 80` (identity bytes; woff2 is already compressed), glyph coverage unchanged. |
| O-3 | **pinned CDN mermaid + SRI on `/md`** | A-03 closed: `/md` stays a separate document on BASE_CSP + `script-src` allowing the one CDN origin by hash; mermaid pinned `12.1.0` with `integrity=`; never in `dist/`; G-20 runs per document (K-10). |
| O-4 | **push + badge both in this run** | C-06 closed as K-37: `contract.d.ts` gains `POST /api/push/subscribe`, `DELETE /api/push/subscribe`, the VAPID public key at `GET /api/push/key`, and the server-side sender (RFC 8291 aes128gcm + RFC 8292 VAPID on `node:crypto`, no npm dependency on the box); keys live next to `settings.json`; the trigger is a session entering `needs-you`; iOS delivery is a manual gate with owner and date (K-38). Badge = `navigator.setAppBadge(n)` from the stream's `needs-you` count, cleared on focus. |
| O-5 | **the installed app opens the cockpit home** (2026-10-11, after the first phone week) | B-10 / K-20 narrowed, not reversed: the manifest stays byte-identical; a bare `/app` under `--ui=next` answers 302 `/`, while `/app?s=` / `/app?open=` and `--ui=legacy` still 302 into the terminal, so every existing link and the rollback keep their behaviour. e2e-infra and mobile-journey assert both. |
| O-6 | **grid view** (2026-10-12, desktop multi-session) | `/grid` is a shell route whose panes are iframes of the unchanged `/term` document; no tmux, ttyd, Caddy or push change. Measured: ≈ 5 MB browser and ≈ 8 MB server per extra pane, zero server processes after close. Hidden tabs park after 10 min (sockets closed), and the page hidden 10 min parks every tab (the one on screen remounts on return); ≤ 12 live sockets. Probe `docs/qa/probes/grid-check.mjs` (incl. `leak`), check `scripts/grid-logic-check.mjs` in preflight. | kept | ARCHITECTURE §2 lists the route. Known red, not from this change: `sessions-check chromium history` check 3 (`back2` 300, not 700) fails identically on `main` e618bb2; owner alonso, see `docs/qa/probes/README.md` Known red |
