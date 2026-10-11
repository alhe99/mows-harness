# Mobile facelift — QA Report (2026-10-11)

Driver: playwright (script, `docs/qa/probes/mobile-facelift.mjs`) · Mode: headless · Target: the live dashboard on loopback (`127.0.0.1:3005`), serving the `lite.mjs` this branch commits

Why a script and not the MCP driver: the MCP server shipped without its Chromium build on this box; the probe script runs the same seven steps on WebKit **and** Chromium, writes the screenshots, and decides the verdict by exit code — the shape every later cockpit-rebuild verification uses.

## Tool calls
| Tool | Count | Purpose |
|---|---|---|
| `node docs/qa/probes/mobile-facelift.mjs webkit` | 1 | journey steps 1–7, WebKit 390×844 @3x + 1280×800 |
| `node docs/qa/probes/mobile-facelift.mjs chromium` | 1 | same, Chromium |

## Run(s)
### webkit + chromium (2026-10-11, ~5 min)
- ✅ 1 `h1` starts with "mows" — `innerText` = `mows` (both engines)
- ✅ 2 floating glass pill tab bar — `.tabs` `position: fixed`, left 12 / right 378 of 390, `backdrop-filter: blur(20px) saturate(1.6)`, 5 `.tb`, `scrollWidth` 390 → `baseline/2026-10-11-mobile-facelift/home-390.png`
- ✅ 3 facelift card — `.fleet-cards .lp` `border-radius: 22px`, `data-state="idle"`, `.lb` 17 px
- ✅ 4 System 2×2 tiles — 4 `.mbar-row`, first two share `offsetTop`, every row has `b.mbar-pct` → `system-390.png`
- ✅ 5 `/md` download control — HTTP 200, `a[download]` present, README `h1` rendered → `md-390.png`
- ✅ 6 desktop unchanged at 1280×800 — `.tabs` `position: static`, `h1` 16 px → `home-1280.png`
- ✅ 7 zero console errors — after allow-listing WebKit's `interactive-widget` viewport-key rejection (Chromium-only key; pre-existing, not from this change). Chromium: zero without the allow-list.

Raw assertion output: `baseline/2026-10-11-mobile-facelift/results-{webkit,chromium}.json`.

## Net outcome
| Item | Result |
|---|---|
| Journey `mobile-facelift` | **VERDICT: ship** on WebKit and Chromium |
| Screenshots | 4, kept as the visual-parity baseline the cockpit rebuild diffs against |
| Known noise | WebKit logs the `interactive-widget` viewport key at error level — allow-listed in step 7 |

**Method note:** observe, don't theorize — every claim backed by a screenshot, a network request, or a real status.
