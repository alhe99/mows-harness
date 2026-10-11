# Grid view — many sessions in one browser tab (desktop)

Date: 2026-10-11 · Status: draft for review · Owner: alonso

## 1. Intent

The operator works three or more Claude Code sessions at once and today keeps one browser tab (a named window)
per session. The cockpit should give the desktop what the agent multiplexers (herdr, tuios, MulmoTerminal, Pane)
give a terminal: **one browser tab** with a status sidebar on the left and the live terminals on the right, where a
second session opens either **split beside** the current one or **as its own tab** in a strip above the panes, and
every edge is **draggable**.

In the operator's words: "by default sidebar left and session right side, and if I wanna open a second one, in
a single right side of the opened one, or in a single tab apart". Panes beyond two, tab drag-reorder and grouping
by project are in scope (asked for explicitly).

Success: on mows.me, open four live sessions in one browser tab, two tabs of two panes each, resize the split
and the sidebar, reload, and everything is where it was. Keys move between tabs and panes without the mouse.

## 2. Scope

In: a new shell route `/grid`, desktop only (fine pointer and ≥ 1024 px). Sidebar grouped by project, tab strip
with drag-reorder, 1–6 panes per tab in resizable columns, keyboard chords that work from inside a terminal,
layout persisted per browser, session-ended overlay, a Playwright probe and a manual gate.

Out: splitting a pane vertically into a tree (columns only; four or more panes wrap into two rows), moving a
pane between tabs by drag (close and reopen instead), any server-side layout, any change to tmux, ttyd, Caddy or
the push watcher, and the phone (`/grid` on a touch device is a link back to `/`).

## 3. What exists and is reused

- `store.fleet` (signal, boot-inlined, patched by `fleet` SSE events): `sid8, name, label, proj, state, rel, snippet`.
  The sidebar renders from it exactly as `views/sessions.mjs` rows do (glyph, label, meta, snippet).
- The terminal document `/term/?arg=attach&arg=<name>&arg=<tabid>&v=3` (`web/pages/term/`). One ttyd socket per
  document; `web-term.sh attach` runs `tmux attach -d`, which detaches other clients of **that** session only, so
  N panes on N sessions coexist, and a phone attaching the same session later takes it over as it does today.
- Caddy already sends `Content-Security-Policy: frame-ancestors 'self'`, so a same-origin iframe of `/term/` is
  allowed; `/droidview/` and `/vnc/` are framed the same way by `/device`.
- `pageChrome()` (legacy.mjs) renders the nav; `nextView()` (documents.mjs) picks the active tab from the path.
- `tokens.css` is at 10.4 KB gz of its 12 KB budget: the view brings its own stylesheet (`views/grid.css`,
  imported by the view, counted in the view's 15 KB closure by `budget.mjs`), tokens.css is not touched.

## 4. Layout

```
┌ header + nav (unchanged) ─────────────────────────────────────────────────────────┐
│ sidebar ║ tab strip: [● api] [◉ web ×] [○ data] [+]                                  │
│ ─────── ║ ┌──────────────────────┃┌──────────────────────┐                          │
│ ▸ alpha ║ │ api · working        ┃│ web · needs you       │  ← pane header: label,  │
│  ◉ api  ║ │ (iframe /term/…api)  ┃│ (iframe /term/…web)   │    state, ⤢ zoom, × close│
│  ● web  ║ │                      ┃│                       │  ┃ = drag handle          │
│ ▸ beta  ║ │                      ┃│                       │  ║ = sidebar drag handle  │
│  ○ data ║ └──────────────────────┃└──────────────────────┘                          │
└──────────────────────────────────────────────────────────────────────────────────┘
```

- **Sidebar** (default 260 px, drag 180–480 px, double-click the handle resets). Grouped by `proj`; each group is a
  `<details open>` with a count of needs-you sessions; groups ordered by their most urgent member, then name.
  A "grouped / flat" toggle in the sidebar head; flat is the sessions view order. The filter box from `/` is kept.
- **Tab strip**: one tab per open "layout tab"; title is the focused pane's label (two panes: `api | web`); a state
  dot that is the most urgent state of its panes; × on hover; `+` opens the picker (`termHref('menu','')`) in a new
  pane of a new tab. Tabs reorder by drag (pointer events on the tab; drop before or after another tab).
- **Panes**: a tab holds 1–6 panes as columns of a CSS grid, `grid-template-columns` from stored fractions;
  4–6 panes wrap to two rows (2×2, 3×2) with equal rows. A drag handle sits between adjacent columns. Each pane is
  a header plus an `<iframe>` of the terminal document with its own minted tab id. The focused pane has an accent
  border; a needs-you pane pulses its header (same colour tokens as the fleet glyphs).
- **Zoom**: ⤢ or the chord makes one pane fill the tab (the others stay mounted, hidden with `display:none`,
  so their sockets live on); again or Esc restores.

## 5. Interaction

Sidebar row:
- click → if the session is open anywhere, focus that tab and pane; else open it as a **new tab** (one pane).
- the row's `⫿ split` button, or Shift+click → add it **beside** the panes of the current tab (cap 6; at the cap the
  button is disabled with a title saying so). Already open in this tab → focus it.
- 1–9 on the sidebar (focus outside a terminal) → same as click on the nth visible row, as on `/`.

Keys. Inside a terminal the iframe owns the keyboard, so the shell has one chord set that the terminal page
forwards and that also works with focus outside a terminal:

| chord | action |
|---|---|
| Ctrl+Shift+1…9 | switch to tab n |
| Ctrl+Shift+← / → | focus previous / next pane in the tab |
| Ctrl+Shift+↑ / ↓ | previous / next tab |
| Ctrl+Shift+Z | zoom / unzoom the focused pane |
| Ctrl+Shift+W | close the focused pane (last pane closes the tab) |
| Ctrl+Shift+S | open the sidebar filter (focus leaves the terminal) |

The terminal page gets one `term.attachCustomKeyEventHandler` that, **only when framed** (`window.parent !==
window`), posts `{ t: 'grid-key', key }` to the parent for exactly these chords and swallows them; every other key
goes to the pty as today. None of these chords are tmux or Claude Code bindings (prefix is C-q). Outside a terminal
the shell also accepts plain `1–9`, `z`, `Esc` and `/`, as `/` does.

Focus tracking: the shell marks a pane focused on `pointerdown` in its header or iframe and on window `blur` when
`document.activeElement` is that iframe. Clicking a tab focuses its last focused pane and calls `focus()` on its
iframe, so typing starts at once.

Drag: handles are plain `<div>`s with `pointerdown` → `setPointerCapture` → `pointermove` writes the fractions
(min 160 px per column) → `pointerup` stores. While dragging, every iframe gets `pointer-events:none` so the
drag does not die when the pointer crosses one.

Session ends (gone from a `fleet` snapshot, or the iframe's socket closes): the pane header says `ended` and
shows a `close` button; the iframe stays (its own overlay says "connection closed" and Enter reconnects when the
session comes back, as on the phone).

## 6. State

`localStorage['grid.v1']`:

```json
{ "sidebar": 260, "grouped": true, "active": "t1",
  "tabs": [ { "id": "t1", "panes": ["cc-work-api", "cc-work-web"], "cols": [0.5, 0.5], "focus": 0, "zoom": null } ] }
```

Written on every change (debounced 250 ms), read on mount. Pane entries name the tmux session (`name`); a name
not in the boot fleet is dropped at mount and a one-line notice in the strip says `dropped 2 ended sessions`.
Each pane mints its own 8-hex tab id when mounted (never stored: web-term.sh keys its client registry by it and a
reload is a new client). Nothing is sent to the server.

## 7. Server

- `lite.mjs`: `/grid` → `nextView(req, res, url, '/grid')` next to the other shell routes (no boot data beyond
  the fleet snapshot every route already carries).
- `documents.mjs nextView`: the tab regex gains `grid`.
- `legacy.mjs pageChrome`: a `Grid` entry after `Sessions` in both `pnav` and `.tabs`, with class `desk` so the
  existing phone rules hide it (`@media (pointer:coarse)` → `display:none`; tokens.css gains that one rule).
- `/grid` on a touch device: the view renders "The grid is a desktop view" with a link to `/`.

## 8. Budgets and cost

- `views/grid.mjs` + `views/grid.css` ≤ 15 KB gz (the route rule); tokens.css stays ≤ 12 KB.
- Per pane: one ttyd websocket, one `web-term.sh` + tmux client, one xterm document (term closure cached after
  the first). Six panes on a 4 GB box is the same load as six browser tabs today. Cap: 6 panes per tab, 9 tabs.
- Hidden tabs keep their iframes mounted (sockets stay up, no reattach storm) but `display:none`; a fit happens
  when a tab is shown again (the term page already fits on `resize`).

## 9. Verification

`docs/qa/probes/grid-check.mjs <engine> <mode>` on the dev instance with the fixture fleet and `/term/*` routed
to a stub page (no ttyd): modes `open` (click → new tab; split → second column; cap at 6), `keys` (chords from
the parent and via a posted `grid-key` from the stub), `drag` (column and sidebar fractions change and persist),
`tabs` (reorder by drag, close, active follows), `groups` (grouping, order, toggle), `persist` (reload restores,
dropped names reported), `ended` (fleet snapshot without a pane's session → `ended` header), `phone` (touch
emulation → the link back). Listed in `scripts/manifest.txt`, run by `docs/qa/probes/run.sh grid` and in CI with
the other `--ui next` probes. `node scripts/budget.mjs --all`, preflight and `node build.mjs` as always.

Manual gate (desktop Chrome and Safari, mows.me): four real sessions, two tabs × two panes, resize both edges,
chords from inside a terminal, reload, phone attaches one of the sessions and the pane shows the takeover.
Recorded in `docs/qa/` like the mobile gates.

## 10. Tasks

1. Server: route, tab regex, nav entry with `desk` class, the one tokens.css rule.
2. `views/grid.mjs` + `grid.css`: sidebar (grouped/flat, filter), tab strip, pane grid, state in localStorage.
3. Resizing: column and sidebar handles.
4. Keys: chord set in the shell; `grid-key` forwarding in `pages/term/term.mjs` when framed.
5. Tab drag-reorder; zoom; ended overlay.
6. Probe `grid-check.mjs`, manifest, run.sh and CI wiring; budgets green.
7. ARCHITECTURE §2 route list and a ledger row; manual gate record; deploy from branch, verify live, merge.
