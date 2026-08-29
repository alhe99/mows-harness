# Fleet Redesign — dashboard home reorganized around live sessions

**Date:** 2026-08-28
**Status:** approved direction (option B of B/A/C), pending spec review
**Scope:** `infra/dashboard/lite.mjs` (+ one new static `fleet.js`), deployed to `claude-dash-lite.service`

## Problem

The home page is organized around transcript **history** (295 archived sessions,
day-grouped, paged) with live sessions as a panel bolted on top. The real
workflow is the opposite: 6–8 **live** Claude sessions being rotated between,
history visited occasionally. Concrete frictions:

1. The dashboard answers "where is the tmux client" (`attached/detached · 25h`)
   but never "**which session needs me**" — knowing whether a session finished
   or is blocked on a permission prompt requires attaching to it. ×7 sessions.
2. Wrong data is loud: the `cc-…` tmux name (mono, green, first) outshouts the
   human label; project paths repeat; the pause/rename/kill button row costs
   ~40% of every row for rare actions.
3. Stale by design: no live updates; a page loaded 5 minutes ago lies.
4. History and fleet share one long scroll, worst on mobile.
5. Switching sessions is navigational: back → scroll → attach.

## Direction chosen

**B — keep the zero-dependency server-rendered architecture, add one small
vanilla-JS island + one SSE endpoint.** Progressive enhancement: with JS off
the page degrades to a correct no-JS fleet view (direction A).
**Fallback:** if, after Phase 2 below, heavy multi-session switching still
feels slow or muddled, stop polishing B and rewrite as an SPA (direction C).
That decision is made once, at the Phase 2 gate — not re-litigated per tweak.

Fleet layout: **adaptive** — dense status rows ≥700px, cards <700px (the
existing single breakpoint used everywhere in `lite.mjs`).

## 1. Session state engine (server)

New `fleetState()` beside `tmuxLive()`. For each live session:

- join to its transcript via `liveSid8()` → index row
- fresh `stat()` of that transcript path (≤10 files; the 15s-stale index
  mtime is too coarse for "working right now")
- `tmux capture-pane -p -S -12 -t <pane_id>` — pane tail, ~12 lines.
  `#{pane_id}` added to the `tmuxLive()` list-panes format. **Never `=name`**
  for capture-pane (see tasks/lessons.md, three prior burns).

Classification, first match wins:

| state | signal |
|---|---|
| `paused` ⏸ | existing descendant-SIGSTOP detection, unchanged |
| `needs-you` ◉ | pane tail shows a permission/question dialog (`Do you want`, `❯ 1.` numbered options), or an idle input prompt with the last transcript turn completed < 10 min ago (finished work not yet seen) |
| `working` ● | pane tail shows `esc to interrupt`, or transcript mtime < 45 s |
| `idle` ○ | none of the above |

Sort order: needs-you → working → paused → idle; ties by transcript mtime desc.
Result cached 3 s (same policy as `tmuxCache`). The pane-signal regexes live in
one place with a comment naming them as heuristics tuned against Claude Code's
TUI — they will need occasional updating when the TUI changes.

New `tailOf(e)`: mirror of `titleOf()` but reads the **last** 16 KB and
extracts the newest meaningful message (assistant text preferred, else user
prompt), cached by mtime. This is the fleet snippet: "what is it doing now",
not the session's opening ask (`titleOf` remains for history rows).

## 2. Fleet-first home

`/` becomes: `h1` + system strip (unchanged, collapsed) + **fleet** + "today"
(first ~8 transcript rows of today, current row markup) + `history →` link.

The current list view — filter chips, search, day groups, pager, delete —
moves intact to **`/history`** and joins the tab bar / footer nav. All
existing query params keep working there; `/` redirects param-carrying
requests (`?q=`, `?acct=`, `?d=`, `?s=`, `?page=`) to `/history` so old links
survive.

Fleet item content (both layouts, same data):
- state glyph + color: ◉ amber, ● green, ○ dim, ⏸ yellow
- **label first** (bold, sans; the `✎` label, else `projName()` fallback) —
  the `cc-…` tmux name demotes to the ⋯ menu (mono, copyable)
- project, state word + relative time (`waiting 3m`, `working now`)
- snippet from `tailOf()` (cards: always visible; rows: truncated single line)
- primary action **attach** (`>_`, existing `data-nw` window-reuse behavior);
  pause/resume, rename, kill fold behind one ⋯ `<details>` popover
  (right-anchored on desktop, inline on mobile — same rule the settings fix
  established)

Desktop rows reuse the `.li/.row` density; cards reuse `.lp` card tokens.
No new design system — same shadcn token layer.

## 3. Live updates: `/events` + `fleet.js`

**Server** — `GET /events` (`text/event-stream`, no-store):
- every 2 s compute the fleet snapshot (state engine above; all cached calls)
- emit `event: fleet` with JSON `[{sid8, name, label, proj, state, rel, snippet}]`
  **only when the snapshot differs** from the last one sent to that client
- comment heartbeat every 25 s; hard cap **8 concurrent clients** (9th gets
  503) — this box already runs hot
- client disconnect tears down the interval (no leaked timers)

**Client** — `/fleet.js`, one hand-written vanilla file (~200 lines), served
by lite.mjs with etag/max-age, `<script defer>` on dashboard pages only:
- `EventSource('/events')`, reconnect with backoff (browser-native + jitter)
- patch in place by `data-sid`: glyph class, state text, snippet text, and
  row **order** (appendChild reorder — no rebuild, no flicker)
- session appears/disappears → insert row from a `<template>` / remove
- tick relative times every 30 s locally
- desktop keys: `1–9` attach the nth fleet session, `/` focuses the filter
- zero dependencies, no build step; total added JS budget < 6 KB

JS off / EventSource failure ⇒ the server-rendered page is already correct;
freshness returns to reload (plus the existing prerender rules).

## 4. Not doing (explicitly)

- No framework, no bundler, no JSON-API-for-everything — only `/events`.
- No fleet strip inside `/term` v1 — the in-terminal drawer already switches
  sessions there.
- `/history` view redesign — it moves, it does not change.
- Read/unread tracking per session ("seen" state) — the <10 min completed-turn
  window approximates it; revisit only if it misleads in practice.

## 5. Rollout & test gates

| phase | ships | gate |
|---|---|---|
| 1 | state engine + `tailOf` + fleet home + `/history` split (no new JS) | selftest extended: state classifier unit-checked against captured pane fixtures; browser journey (mobile 390px + desktop) passes; deploy; user lives with it |
| 2 | `/events` + `fleet.js` | state flip visible < 3 s without reload (journey asserts via two sessions, one scripted to finish); reorder without flicker; JS-off page identical to phase 1. **B-vs-C decision here.** |
| 3 | keys `1–9`, `/` filter focus, polish | journey re-run; only if B survived |

Each phase: `node lite.mjs --selftest`, `scripts/preflight.sh`, journey run,
then deploy. Commits/pushes only on explicit request (standing rule).

## Risks

- **Pane-signal heuristics drift** when Claude Code's TUI changes → states
  degrade to working/idle, never crash; regexes centralized and fixture-tested.
- **capture-pane cost** (≤10 execs / 3 s): measured in phase 1; if it shows in
  load, batch behind a single `runuser` invocation.
- **SSE through Caddy/oauth2-proxy**: needs `flushInterval -1`/no buffering for
  the route; verified in phase 2 before any client work lands on it.
