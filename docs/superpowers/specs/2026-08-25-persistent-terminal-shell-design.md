# Persistent terminal shell (`/app`) — design

**Date:** 2026-08-25 · **Status:** approved in chat, ready for planning
**Scope:** `infra/dashboard/lite.mjs`, `infra/webconsole/web-term.sh`,
`infra/webconsole/blocks/30-cchome.html`, docs.

## Problem

On a phone or in the installed PWA, moving between the session list and a
terminal — or between two live sessions — is a full page swap each way. The
list itself is cheap (9.7 KB, prerendered since `243bdda`); the terminal is
not: `/term` re-parses and boots ttyd's 763 KB xterm.js bundle and reopens the
WebSocket on every visit (the HTML is ETag-revalidated, the *work* is repeated).
Every bounce also detaches the tmux client and re-attaches it. The result reads
as "web page", not "app".

Desktop browsers do not have this problem: the dashboard already opens each
session in its own named window (`data-nw`). This design is for the PWA and
phone-width layouts; desktop behaviour is unchanged.

## Decision

**One terminal; tmux does the switching.** The browser keeps a single `/term`
iframe alive for the life of the shell page. Changing session is a server-side
`tmux switch-client` on *that* browser tab's tmux client — tmux repaints the
same terminal in milliseconds, scrollback and all. No second WebSocket, no
xterm re-boot, no new ttyd process. Every existing `/term` block (keyboard
bar, IME, clipboard, theme, paint fix) is untouched because the terminal page
itself does not change.

Rejected: one hidden iframe per session (3× phone memory, three tmux clients
fighting `attach -d`); an in-house xterm.js client (re-learns every iOS quirk
`blocks/` already encodes — weeks).

## §1 The shell page — `GET /app`

Served by `lite.mjs`. Route deliberately not under `/term` (Caddy's `/term*`
prefix goes to ttyd).

```
┌──────────────────────────────────────────────┐ 28 px strip
│ ≡  [base harness] [payments]  +              │  chips = live sessions, current lit
├──────────────────────────────────────────────┤
│                                              │
│  <iframe id=t src="/term/?arg=attach         │  the only terminal, never reloaded
│         &arg=<S>&arg=<tabid>&v=3">           │  by a switch
│                                              │
└──────────────────────────────────────────────┘
   drawer (off-canvas, loaded on first ≡):
   <iframe id=d src="/?embed=1">   ← the existing dashboard
```

- **S** (initial session): `?s=<name>` if given and live; else the name in
  `~/.cache/webterm-last` if live; else the first live session; else no
  `arg=` at all → ttyd shows web-term.sh's menu.
- **tabid**: 8 hex chars, generated server-side per shell render, embedded in
  the iframe URL and in the page. It is the key the server later uses to find
  *this* tab's tmux client (§2). Two shell tabs on one device get two ids.
- **Chips**: one per live session (`@label` or name), the current one
  highlighted. Tap → `switch(name)`. `+` → `t.src = '/term/?v=3'` (the ttyd
  menu; the one deliberate reload, for brand-new sessions).
- **Drawer**: `≡` toggles a translated-in panel holding the dashboard iframe,
  created lazily. Filters, transcripts, settings, reclaim all work as normal
  navigations inside the drawer (view transitions included).
- **Shell JS** (~40 lines, inline, no deps):
  - `switch(to)`: `fetch('/a/switch', {method:'POST', body: form(tab,to)})`
    → 200: light the chip, close the drawer. 409/404 (§5): fall back to
    `t.src = '/term/?arg=open&arg=' + to + '&arg=' + tab + '&v=3'`.
  - `message` listener: `{sw: name|sid8}` from the drawer → `switch`;
    `{home: 1}` from the terminal → open the drawer.
  - `GET /app/live.json?tab=` every 10 s while `document.visibilityState ===
    'visible'` and on `visibilitychange` → re-render chips; if the current
    session vanished, re-point the iframe to the best live one (`arg=attach`).
- CSS: strip uses the dashboard palette; iframe `height: 100dvh - 28px`;
  safe-area insets on the strip (`viewport-fit=cover` is already on).

## §2 Switching — `POST /a/switch` and `web-term.sh switch`

**`web-term.sh attach <name> [tabid]`** and **`open <sid8> [tabid]`**: when a
tabid is present, write `$(tty)` to `~/.cache/webterm-clients/<tabid>` before
attaching. Files older than a day are pruned on each write
(`find … -mmin +1440 -delete`). A ttyd reconnect spawns a fresh web-term.sh
under the same URL → same tabid, new tty → the file is overwritten. The
mapping self-heals.

**`web-term.sh switch <tabid> <to>`** (all switching logic lives in bash, one
place):

1. `tty=$(cat ~/.cache/webterm-clients/<tabid>)` — missing → exit 2.
2. Resolve `to`: if `tmux has-session -t "=$to"` → live name. Else treat as a
   sid8: `resolve` (existing) → `ensure_session p cwd sid`, which is today's
   `do_resume` minus the attach — `tmux new-session -d -s "$n" -c "$cwd"
   "$0 run p cwd sid"`. Unresolvable → exit 3.
3. `tmux detach-client -s "=$to"` — keeps today's take-over semantics (the
   device that switches owns the session, same as `attach -d`).
4. `tmux switch-client -c "$tty" -t "=$to"` — failure (client gone) → exit 2.
5. `mark "$to"` so a fresh connection re-attaches here.

`do_resume` becomes `ensure_session` + `tmux attach -d`; behaviour of the
existing `open` path is unchanged.

**`POST /a/switch`** (`lite.mjs`, before the `/settings` routes):
`sameOrigin` guard (existing); body `tab` must match `/^[0-9a-f]{8}$/`, `to`
must be a current `tmux ls` name or match `/^[0-9a-f]{8}$/` — anything else
is 400 before bash is involved. Runs `runAs([], 'web-term.sh', ['switch',
tab, to], 20000)`. Exit 0 → 200 `{ok:true, current:to}`; exit 2 → 409
`{err:'tab not attached'}`; exit 3 → 404. Not a form/303 flow: the shell is
the one place client JS is the whole point.

**`GET /app/live.json?tab=`**: `tmux list-sessions -F '#S'` + `@label` per
session (existing live-session helper) + `current` = the session of the
client whose `#{client_tty}` equals the tab file's content. `cache-control:
no-store`.

## §3 Embed mode of the dashboard — `/?embed=1`

- Every page rendered with `embed=1` adds `class="embed"` to `<body>`; CSS
  hides `.tabs`, `footer` and the ↻/⌫ chips' `.navdup`, tightens padding.
  `embed=1` is carried through `qs()` so filter/page links stay embedded.
- `attach` (`/term/?arg=attach&arg=NAME`) and `>_`
  (`/term/?arg=open&arg=SID8`) links additionally get `data-sw="NAME|SID8"`.
  Three lines of inline script in embed mode: click on `a[data-sw]` →
  `preventDefault(); parent.postMessage({sw: a.dataset.sw}, location.origin)`.
- Speculation rules are emitted unchanged (they already exclude `/term*`).
- `30-cchome.html`: `⌂` posts `{home:1}` to `parent` when
  `window.parent !== window`, else `location.href = '/'` as today.
  `make-term-index.sh` regenerates `term-index.html`.

## §4 Entry points

- `manifest.webmanifest`: `start_url: '/app'` (approved). `scope` stays `/`.
- The nav's **terminal** tab (`.tabs` and `footer .navdup`) → `/app`.
- Session rows on desktop browsers keep `data-nw` named windows to `/term/…`
  — unchanged. On phone width / PWA they navigate in place today; after this
  change they navigate to `/app?s=<name>` (or `/app?open=<sid8>`) so the user
  lands in the shell. `/term/?arg=…` deep links keep working verbatim.
- The `/app` page and `/a/switch` need no new Caddy or sudoers rules: the
  dashboard already runs as root and drives tmux through `runAs` as
  `TMUX_USER`.

## §5 Failure modes

| Situation | Behaviour |
|---|---|
| Tab file missing (ttyd never attached, or pruned) | `409`; shell reloads the iframe with `arg=open&arg=<to>&arg=<tab>` — one reload, never a dead end. |
| Session destroyed while shown | tmux detaches the client → ttyd's client reconnects to the same URL → `attach` fails → web-term.sh menu. The 10 s poll sees the session gone and re-points the iframe to the best live session. |
| `to` unknown | `404`; chip list refreshes. |
| Another device attaches the same session | Same as today: last attacher wins (`attach -d` / `detach-client -s`). |
| Two shell tabs, same device | Independent tabids; switching one never touches the other unless both target the same session (then take-over, as above). |
| JS disabled | `/app` still renders the iframe attached to S; chips are plain links to `/app?s=…` (a reload — degraded, not broken). |

Security: `/a/switch` and `/app/live.json` sit behind oauth2-proxy like every
dashboard route; the same-origin guard applies to the POST; `tab` and `to`
are validated by regex / against `tmux ls` before reaching bash, so no path
or argument injection surface exists; the tab file holds only a tty path.

## §6 Verification

- **Bash self-check** (`infra/webconsole/web-term-selfcheck.sh`, throwaway
  sessions named `wt-selfcheck-*`, never the user's): create two detached
  sessions; start a real client on the first under `script -qfc` (a pty);
  register its tty under a test tabid; run `switch` to the second; assert
  `tmux list-clients -F '#{client_tty} #{client_session}'` shows the client
  on the second session; assert exit 2 for an unknown tabid and 3 for an
  unresolvable target; clean up.
- **Headless journey** (Playwright, chromium-1237, 390×844): `/app` renders
  the strip and an iframe whose `src` carries `arg=attach` and a hex tabid;
  tapping a chip → `POST /a/switch` 200 and the iframe `src` is byte-identical
  afterwards (no reload); `≡` opens the drawer; a `data-sw` click inside it
  triggers the same POST and closes the drawer. Runs against a `--port 3099`
  instance and throwaway tmux sessions.
- **Live smoke** after deploy: `curl /app` 200 and `/app/live.json` lists the
  real sessions with the right `current` for a freshly opened shell.
- Deploy touches `claude-dash-lite` and `term-index.html` only — never
  `claude-tmux` or `claude-web-term`.

## Out of scope (add when the switch is proven in daily use)

Unread/activity badges on chips, side-by-side terminals, swipe-to-switch,
desktop windows adopting the shell.
