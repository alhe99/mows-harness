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
  Visual reference (2026-10-12): the Figma frame "Mission Control Dashboard Redesign" (mows-control, node 52-2): 256 px sidebar, 24 px gutter, 38 px tab strip, 12 px-radius rows, Inter / JetBrains Mono, lucide strokes for the icons; css.mjs carries its measures.

Keyboard (2026-10-12): every action that picks a pane (a sidebar row, split, a pane header or its buttons, a tab, a chord) focuses
that pane's iframe, and the framed terminal document moves the focus on to xterm on its window's focus event; before, the row or
button kept the keyboard and typing went nowhere. Sidebar toggle: the strip's first button and Mod+B (from the shell or from inside a
pane) hide the session list for a screen share; `sb` in the stored state, the grid becomes one column. Probe: grid-focus-check.mjs.

Home page (2026-10-12): where the grid runs (a mouse, >= 1024 px, the installed app included) a session row on / routes to
`/grid?open=<name>` in the same tab; the grid opens that session as a tab (or brings its tab to the front), gives it the keyboard and
drops the query from the URL. Below 1024 px, on a phone or with a coarse pointer the row keeps the terminal document of its own
(sessions.mjs attach). Probes: sessions-check `links` 0a/0b and 8, grid-check `deeplink`.

View switch (2026-10-12): the grid is the fleet's other VIEW, not a page of its own: the header's pill nav has no Grid entry. A
`list | grid` switch sits beside the fleet filter on / (desktop only) and in the grid's strip nav in place of the Sessions link. The
choice is remembered per browser (`localStorage.mows.view`): landing on / with `grid` remembered routes to /grid in place (a replace
navigation, so Back does not bounce); the grid's `list` stores `list` and comes back to /. Probes: sessions-check `links` 0c-0f,
grid-check `deeplink` 5, shell-check 15 (five pills).
  A "grouped / flat" toggle in the sidebar head; flat is the sessions view order. No filter box (removed 2026-10-12 at the owner's request: the sidebar is sessions only).
- **Tab strip**: one tab per open "layout tab"; title is the focused pane's label (two panes: `api | web`); a state
  dot that is the most urgent state of its panes; × on hover; `+` opens the picker (`termHref('menu','')`) in a new
  pane of a new tab. Tabs reorder by drag (pointer events on the tab; drop before or after another tab). A tab dropped onto the panes merges: its panes join the tab on screen (at most 6, else a notice), the dragged tab closes, and those panes reload once (their iframes change parent; 2026-10-12). The way back is the pane header's ⧉ button (shown while the tab holds more than one pane): the pane moves to a new tab right after its old one.
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
forwards and that also works with focus outside a terminal. The chord's **modifier is a setting**, `Mod`:

| `Mod` | keys | default on |
|---|---|---|
| `mac` | ⌘ + Shift | macOS and iPadOS (`navigator.platform` starts with `Mac` or is `iPad`) |
| `win` | Ctrl + Shift | Windows, Linux, ChromeOS |
| `alt` | Alt (⌥) alone | never by default; for a keyboard where the two above collide |

Auto-detected on first run and set on `/system` (Shortcuts card, `⌘⇧ / Ctrl⇧ / Alt`, next to Notifications; 2026-10-12, it was a select in the sidebar head before); the choice is stored
with the layout. The parent posts `{ t: 'grid-mod', mod }` to every pane on mount and on change, so the forwarder
in the terminal page matches the same modifier.

| chord (with `Mod`) | action |
|---|---|
| Mod+1…9 | switch to tab n |
| Mod+← / → | focus previous / next pane in the tab |
| Mod+↑ / ↓ | previous / next tab |
| Mod+Z | zoom / unzoom the focused pane |
| Mod+X | close the focused pane (last pane closes the tab) |
| Mod+S | unassigned (2026-10-12: the filter box was removed) |

Letters were chosen against the browser's own bindings: ⌘⇧W / Ctrl⇧W close the window and cannot be intercepted,
so close is **X**; ⌘1–9 / Ctrl1–9 switch browser tabs, so every chord carries Shift (or is Alt). None are tmux or
Claude Code bindings (prefix is C-q).

The terminal page gets one `term.attachCustomKeyEventHandler` that, **only when framed** (`window.parent !==
window`), posts `{ t: 'grid-key', key }` to the parent for exactly these chords under the current `Mod` and swallows
them; every other key goes to the pty as today. Outside a terminal the shell also accepts plain `1–9`, `z`, `Esc`
and `/`, as `/` does.

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
{ "sidebar": 260, "grouped": true, "mod": "mac", "active": "t1",
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

New session (2026-10-12): the strip's `+` opens the terminal picker (`web-term.sh menu`) as a tab of the grid, never a browser tab.
The pane is named `new:<tab n>` (a `:` is not a tmux name), its iframe loads `/term/?arg=menu&arg=&arg=<tabid>`, the header reads
`new session · picker`, and the sidebar never lists it. Every 2 s the view asks `GET /a/tab?tab=<tabid>` (`web-term.sh tabsess`:
`tmux display-message -c <tty> '#{client_session}'` for the tty the tab registered) which session the picker's client sits in; once
it names a session the fleet knows, `state.renamePane` makes the pane that session (its iframe reloads into a plain attach, which takes
the client over from the picker's; a pane already showing that session closes first, never two sockets). A plain shell (`[s]`) stays a
picker pane. A reload drops picker panes silently (their tab ids died with the page). `scripts/deploy-dashboard.sh` installs
`web-term.sh` alongside the dashboard since this change, as it already did the settle helper.

## 8. Budgets, cost and leak control

Measured 2026-10-11 on this box (24 GB, earlyoom present) with headless Chromium 1920×1080, panes attached to six
throwaway tmux sessions each streaming 160 lines/s, sampled every 30 s, then every pane closed
(`.agent-team/live/grid-mem.mjs`, `grid-proxy.mjs`):

| what | 1 pane | 6 panes | after closing all |
|---|---|---|---|
| browser renderer RSS over the empty page (80 MB) | +40 MB | +65 MB (≈ +5 MB per extra pane; the first pays xterm + WebGL + fonts once, shared) | back within 30–40 MB of empty, no GC forced |
| server, per attached pane (`web-term.sh` + `tmux attach`) | 7 MB | 46 MB (7.7 MB each) | 0 processes: ttyd ends the child when the socket closes |
| ttyd | 5 MB | 5 MB | 5 MB |
| tmux server | 130 MB (the sessions' own scrollback, `history-limit 50000`; a client adds nothing measurable) | 131 MB | 131 MB |
| drift over 3 minutes of streaming | none (RSS fell 144 → 138 MB) | | |

Reference: the dashboard process is 82 MB, Caddy 43 MB, oauth2-proxy 22 MB. So six live panes cost the box about
50 MB and the browser about 65 MB; the tmux sessions themselves, not the panes, are where memory lives.
Rules that keep it bounded, each one a task and a probe assertion:

- **Live panes are only the visible tab's.** A tab that has been hidden for 10 minutes **parks** its panes: the
  iframes are removed (socket closed, tmux client detached, the session keeps running untouched) and the tab keeps
  only the names. Showing the tab remounts them (≈1 s to reattach, same as reopening a browser tab today). Caps:
  6 panes per tab, 9 tabs, so at most 12 sockets are live at once (the visible tab plus one still inside its
  10-minute grace). Closing a pane or tab removes its iframe at once.
- **One socket per pane, ever.** A pane mounts its iframe once; focus, zoom, resize and reorder move DOM nodes,
  never recreate them, so no second ttyd connection is opened for a session that already has one. The probe counts
  iframes and `web-term.sh` processes after each action.
- **Page hidden** (`visibilitychange`) for 10 minutes parks every tab; `pageshow` / visible remounts the active one.
  This is the laptop-lid case, and it matches what the phone already does.
- **Nothing accumulates in the shell:** listeners are attached once per mounted pane and removed with it; the state
  record holds names and fractions only; the per-tab client registry web-term.sh writes
  (`~/.cache/webterm-clients/<tabid>`) is one small file per mount, pruned after 24 h on every write (119 files
  today). The term page's xterm scrollback is 1 000 lines per pane, bounded.
- **Size:** `views/grid.mjs` + `grid.css` ≤ 15 KB gz; `tokens.css` ≤ 12 KB; the term closure is unchanged (the
  `grid-key` forwarder is a few lines and is counted by `budget.mjs --route term`).
- **Leak gate:** `grid-check.mjs leak` opens six panes against the stub, cycles focus / zoom / reorder / park /
  unmount 20 times and asserts the iframe count, listener count (via `getEventListeners` over CDP) and the DOM node
  count (`Memory.getDOMCounters`) return to their post-mount values. The manual gate repeats the 3-minute RSS watch on
  mows.me with real sessions (`ps` on the box, the browser's task manager on the laptop) before merge.

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
4. Keys: `Mod` setting (auto-detect + select), chord set in the shell; `grid-mod` / `grid-key` messages with `pages/term/term.mjs` when framed.
5. Tab drag-reorder; zoom; ended overlay; parking of hidden tabs and of the hidden page (10 min).
6. Probe `grid-check.mjs` including the `leak` mode, manifest, run.sh and CI wiring; budgets green.
7. ARCHITECTURE §2 route list and a ledger row; manual gate record; deploy from branch, verify live, merge.
