# Grid view — manual gate (2026-10-12)

The one live check the spec (section 9) assigns to the owner, on the live dashboard, on sessions the owner runs; everything else is automated (`scripts/grid-logic-check.mjs` in preflight, `docs/qa/probes/grid-check.mjs` all modes in Chromium and WebKit, budgets, preflight, e2e-infra). Deployed from branch `feat/grid-view` before the merge.

| item | result | evidence |
|---|---|---|
| open `/grid`, four own sessions as two tabs of two panes | pending | |
| resize both edges (column handle, sidebar handle) | pending | |
| chords from inside a terminal (Mod+1-9, Mod+arrows, Mod+Z, Mod+X, Mod+S) with the Mod the owner uses | pending | |
| reload: the layout comes back, no pane reloads twice | pending | |
| attach one of the sessions from the phone: the pane shows ttyd's "connection closed", the fleet state keeps updating | pending | |
| memory, 3 minutes, server side (`ps` sum of `web-term.sh attach` + `ttyd`) | pending | |
| memory, 3 minutes, browser task manager (Shift+Esc in Chrome) | pending | |
| close every pane: zero `web-term.sh attach` processes for those sessions | pending | |
