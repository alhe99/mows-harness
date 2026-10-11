---
mode: headless
target: http://127.0.0.1:3005
driver: playwright
---
# Mobile facelift (2026-10-10) — the live-patched UI, now in the repo

Proves the four surfaces the deployed `lite.mjs` carried ahead of the repo render from the
committed file. Phone viewport throughout: 390×844, device scale 3, touch.

1. Open `/`. Expect `h1` text to start with "mows" (not "sessions"). Screenshot `home-390`.
2. Expect the tab bar `.tabs` to be `position: fixed`, narrower than the viewport on both sides
   (`getBoundingClientRect().left >= 10 && right <= 380`), with a non-zero `backdrop-filter`
   — the floating glass pill. Expect five `.tb` tabs and `document.scrollingElement.scrollWidth <= 390`.
3. Expect at least one `.fleet-cards .lp` card with `border-radius` of `22px` and a
   `data-state` attribute. ✅ assert the card's `.lb` title font-size is ≥ 16px.
4. Open `/system`. Expect `h1` to contain "mows" and "system". Expect the metric rows `.mbar-row`
   to lay out as a 2-column grid (two rows share the same `offsetTop`) and each to contain a
   `b.mbar-pct` percentage. Screenshot `system-390`.
5. Open `/md?f=$HOME/Documents/Projects/mows-harness/README.md` (the dashboard's own README,
   under the operator's home — `/md` only serves files under a home). Expect HTTP 200, a
   download control (an `a[download]` or a link whose href contains `raw=1`) and the rendered
   README `h1`. Screenshot `md-390`.
6. Resize to 1280×800. Open `/`. Expect the desktop layout unchanged: `.tabs` no longer floating
   (`left <= 1px` or not fixed) and `h1` font-size < 26px. Screenshot `home-1280`.
7. Read the console: expect zero error-level messages across steps 1–6, ignoring WebKit's
   `Viewport argument key "interactive-widget" not recognized` — that key is Chromium-only and
   WebKit logs the rejection at error level by design.
