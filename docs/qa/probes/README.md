# Browser probes for the dashboard SPA

The scripted form of `docs/qa/journeys/agent-chat.md`. These exist because the strongest evidence
about `/ui` — that it boots in **WebKit**, that the hand-written scroll anchoring works in the one
engine it was written for, that an SSE stream cut mid-turn recovers exactly once, that the CSP
refuses an injected handler — could otherwise only be reproduced by whoever happened to run it once.
A result nobody else can re-run is a claim, not a check.

## They are not a gate, and nothing depends on them

`scripts/preflight.sh` does not call these and must not. They need Playwright and a browser build,
neither of which this repo owns: the no-dependency rule is about what the dashboard **ships and
runs** — client assets, no build step, Node stdlib at runtime — and a probe a maintainer starts
deliberately is a different category. Keeping them out of preflight is what keeps that true.

**Without Playwright they SKIP and say so**, printing the install command, the same way the HTTP/2
assertion in `scripts/e2e-infra.sh` SKIPs without `MOWS_HOST`. A skip that names what it skipped is
honest; a skip that says nothing is just a green line.

## Install, once, outside this repo

```sh
mkdir -p ~/.cache/mows-qa && cd ~/.cache/mows-qa
npm i playwright && npx playwright install chromium webkit
```

WebKit is the one that matters most here and is the one the project's MCP browser server cannot
give you — it is pinned to `--browser chromium`, so a WebKit claim checked through it would be a
confident wrong answer.

## Run

From the repo root. `run.sh` stands up a throwaway dashboard in Docker with a fixture agent, puts a
cuttable TCP proxy in front of it, runs the probe, and tears both down.

```sh
export PLAYWRIGHT=~/.cache/mows-qa/node_modules/playwright/index.mjs

./docs/qa/probes/run.sh journey webkit    # the journey, steps 1-9: streaming, scroll anchoring,
                                          # mobile layout, two viewers, mid-turn reconnect, reload
./docs/qa/probes/run.sh lost chromium     # journey step 10: a message the agent never recorded
./docs/qa/probes/run.sh repeat chromium   # ...and the repeat of it, which is the harder half
./docs/qa/probes/run.sh csp chromium      # the /ui policy actually refuses injection
./docs/qa/probes/run.sh base chromium     # the server-rendered pages still work under their own
./docs/qa/probes/run.sh layout webkit     # geometry: nothing fixed covers the Send button, and
                                          # the right nav is RENDERED, at four viewports
./docs/qa/probes/run.sh all webkit        # every probe above
```

Needs `docker` and a network on first run (it pulls `node:20-slim`). Everything it creates is
named `mows-qa-*` and is removed on exit, including on Ctrl-C.

## `layout` is the one that catches what a grep cannot

`scripts/e2e-infra.sh` makes eleven assertions about `/ui`'s chrome and every one of them is a grep
over the served markup: they prove the right elements with the right hrefs are *in the document*.
They are structurally blind to where those elements land. The change that added the tab bar also
added a fixed terminal FAB, which covered the chat composer's Send button on every phone width in
both engines — `document.elementFromPoint()` at the button's own centre returned the FAB, so
**tapping Send opened the terminal** — and all eleven stayed green.

`layout` reads `getBoundingClientRect()` and `elementFromPoint()` after a real layout at 375×812,
414×896, 800×700, 1024×800 and 1400×900. It also asserts *which* nav is actually rendered at each
width, which the greps cannot: `.tabs` is `display:none` above 701px and the pill-nav header is
hidden below it, so a change to that media query would leave both navs in the markup, neither one
visible, and every grep green.

It asserts its own precondition first, because the first version of it did not and passed at all
four viewports against the broken code. The precondition changed with the 2026-09-19 card redesign:
the composer used to be a page-level `position:sticky` bar that only reached the FAB once its
containing block extended past the fold, and the probe asserted that sticky state. The composer is
now the static foot of a fixed-height chat card, so the precondition is the geometric guarantee each
regime's CSS is built to hold — on a phone the agent page hides the FAB outright (`html.agent-view`),
so nothing fixed exists to cover Send, and the tab bar stays (hiding only while the composer is
focused, `html.kb-open`, which the probe does not do); in the 701–860 single-column band the form
reserves the FAB's width so Send ends left of it; above 860 the composer is in the left column and
the FAB hangs over the right. The transcript is still grown through CSSOM
first, so a two-line fixture cannot make the card shorter than a real chat and pass by accident. That
precondition was red, unnoticed, for the day between the redesign and this rewrite: `layout` was the
one mode not run in that day's probe passes. Run `all`.

## Against the cockpit shell: `--ui next`

```sh
./docs/qa/probes/run.sh all webkit --ui next      # every mode above, against the shell at / on the same fixture (default since phase 05)
./docs/qa/probes/run.sh all webkit                # ...and against the old /ui app (the dashboard is started with --ui=legacy)
node docs/qa/probes/agents-check.mjs webkit all   # the agent pages around the chat: list, detail, run (fixture data, no docker)
```

`--ui next` starts the fixture dashboard with `--ui=next`, gives the probe `MOWS_QA_UI=next`, and the probe uses the agent routes
at `/agents/...` instead of `/ui/agents/...` (until the cutover of phase 05 the shell was mounted at `/next`; that prefix now answers 301). **No selector moved**: the shell's agent pages keep `.chatbox`, `.m.me` / `.m.claude`
(`.streaming`), `.chat .chatf`, `.cherr`, `button.jump`, `.agchat`, `.agback-in`, `.termfab`, `nav.tabs`, `header.hdr`, so the
same assertions hold, and the probe header lists them. Three things are different on purpose:

- **`csp`** proves the shell's nonce policy refuses an injected handler, an inline `<script>` and a foreign script (the policy
  also admits `'self'` stylesheets, which is how the shell links `tokens.css`).
- **`journey`** seeds the user's question into the saved transcript before the first delta, as `mows-agent` does (`cmd_chat`
  appends it before it spawns claude). The store decides after a reconnect whether a turn is still running from the last saved
  turn's role, so a fixture with an agent turn last would read as an ended turn. It also saves the reply as the raw text it
  injected, not the rendered `innerText`: WebKit's `innerText` has one newline between paragraphs where the deltas have two, so the
  old probe's reply missed the view's `includes` salvage rule and showed twice. That made `webkit/journey` red on `/ui` as well.
- **`journey` ends with the chatend gap** (`--ui next` only; ledger D-04, K-34): the stream is cut mid-turn, the turn ends while
  nobody is connected, and after the reconnect the saved reply must be on screen once, the live bubble gone and the composer
  usable. `/ui` has no such recovery. `scripts/stream-replay-check.mjs --chatend-gap` runs the same case against the server with
  `web/store.mjs`.

## The History, System, Device and Session views: `views-check`

```sh
node docs/qa/probes/views-check.mjs webkit all        # history, system, device, session
node docs/qa/probes/views-check.mjs chromium device   # one view, one engine
```

Needs the dev instance (`MOWS_TEST_HOOKS=1 node infra/dashboard/lite.mjs --port 3105 --host 127.0.0.1 --ui=next`, or `DASH=...`); no docker.
Like `sessions-check`, it runs against the shell with **fixture data**: the boot snapshot is rewritten in flight, `EventSource` is a fake that
`window.__emit(name, data)` drives, and every `/api/*`, `/a/*`, `/droid/*`, `/watch/*` and `/sys/*` request is answered by the probe, so nothing it does
reaches a real session, container or disk. The fixture filters, pages and mutates its rows the way `routes/api.mjs` does, so a chip, a pager link or a
form has an observable effect. What each view is held to: the fixture renders; chips, the search form and the pager navigate in the same document
(`window.__doc` survives); a form posts the right fields and the view updates; a `fleet`, `system` or `usage` event patches the DOM in place.
Device adds the iframe lifecycle (mounted on route enter, removed on leave and on `visibilitychange: hidden`), the remote keys against a stub `window.rfb`
and the phone-UA "Open Screen" link.

`scripts/legacy-parity-check.mjs` is the server half of the same phase: `--ui=legacy` must still serve today's documents. It starts the fixture in
docker with `--ui=legacy`, fetches ten pages and compares them with `docs/qa/baseline/cockpit/legacy-html/` (captured from the pre-split server with
`--capture --ref <commit>`); stylesheets and scripts byte for byte, the volatile text of the markup (digits, tab ids, home paths) masked on both sides.

## The terminal and the markdown document: `term-check`, `md-check` (cockpit phase 04)

```sh
node scripts/term-proto-check.mjs                    # the ttyd 1.7.4 client against a fake socket: no browser, no server
node docs/qa/probes/term-check.mjs webkit all        # proto keybar ime clipboard sheet paint theme
node docs/qa/probes/term-check.mjs chromium sheet    # one mode, one engine
node docs/qa/probes/md-check.mjs chromium            # /md: download, CSP, lazy pinned mermaid, tap to toggle
```

`term-check` serves `dist/term.html` in place of `/term/` on the dev instance's origin (only `/assets/` comes from the server) and plays ttyd
itself in the browser context: `/term/token`, the `/term/ws` socket (every frame the page sends is recorded, the probe answers with `0` output
frames), `/app/live.json`, `/a/switch`, `/shot`, `/z` and `/settings/term-theme.json` are answered by the probe, so nothing reaches ttyd, tmux or the
disk. Run `node build.mjs` first: it tests the built page. `proto` is the bytes on the wire per key; `keybar` the key order, geometry, touch scroll and
the keyboard-aware fit (a stand-in `visualViewport`, since no engine raises an on-screen keyboard); `ime` the shadow line (value diff replayed as
`\x7f` x N + tail, a Chromium-only trusted paste through CDP, the reconnect kick); `clipboard` OSC 52, the pending-until-gesture retry, copy on select,
the overlay and the paste key (the system clipboard itself is read back on Chromium only); `sheet` the session pill and bottom sheet, attach by key,
paste and drop, the back key and the geometry beacon; `paint` repaint on foreground, resize coalescing and the 4/8/15 s boot ladder on Playwright's
fake clock; `theme` every theme of `themes.json` applied from the built `[data-theme]` CSS, the precedence and the 30 s poll.

`md-check` runs against the real `/md` of the dev instance for the repo's `README.md`: the download link, the CSP (BASE_CSP + the CDN origin + the hash
of the one inline loader), no request to the CDN until the first ` ```mermaid ` fence scrolls into view, then one request for the pinned
`mermaid@12.1.0` file whose `<script>` carries `integrity=` (a rendered diagram proves the hash matches what the CDN serves, so the run needs the
network), and tap-to-toggle full size. A file with no diagram never contacts the CDN.

What none of it can tell you (the `real-device terminal` manual gate): the iOS keyboard and its shadow-line word suggestions, resume after a screen
lock, the key bar geometry against a real home indicator, and one Android. Try `?ime=off` and `?paint=off` on the device.

## The installed-app layer: `pwa-check` (cockpit phase 05)

```sh
node docs/qa/probes/pwa-check.mjs chromium all       # badge push sw
node docs/qa/probes/pwa-check.mjs webkit badge       # the badge and the Wake Lock run on WebKit too; push and sw SKIP there, loudly
node scripts/sw-check.mjs && node scripts/push-check.mjs   # the worker and the Web Push implementation with no browser at all
```

Needs the dev instance, like `views-check`; no docker. `badge` runs the shell with a fixture fleet (the boot snapshot is rewritten, `EventSource` is a fake
`window.__emit` drives) and stubs for `navigator.setAppBadge`, `clearAppBadge` and `wakeLock`: one needs-you sets the badge to 1, the count follows the fleet
event, focus clears it, the Wake Lock is requested while a session is working and the tab is visible, released when none is or the tab hides, taken again on
return. `push` drives the real `/sw.js` in Chromium (its **new headless mode**: the headless shell reports every notification permission as denied and cannot
show one): the System view's Notifications card shows permission, subscription and last delivery; "Turn on" posts the subscription made with the VAPID key
`/api/push/key` returned (`PushManager.subscribe` is a stub and the two endpoints are the probe's, so nothing reaches a push service or the server's store); a
`push` event dispatched into the worker shows the declarative notification; a `notificationclick` brings the open window to its route; "Turn off" deletes
the subscription by the id the server gave. `sw` runs the real worker against the dev instance: it installs and precaches, and offline an allowlisted route
is served from its cache while `/term/` and `/oauth2/*` are not intercepted (the browser's own network error, no offline page).

What none of it can tell you (the `push + badge on iOS` manual gate): that APNs or FCM deliver to a Home Screen install with the app closed, that the badge on
the icon equals the sessions waiting, and that the Wake Lock keeps an iPhone awake.

## `grid-check.mjs`: the desktop grid view

```sh
MOWS_TEST_HOOKS=1 node infra/dashboard/lite.mjs --port 3105 --host 127.0.0.1 --ui=next   # the dev instance, in another shell
node docs/qa/probes/grid-check.mjs chromium all     # open groups persist ended phone drag keys tabs park leak
node docs/qa/probes/grid-check.mjs webkit all       # leak SKIPs there, loudly
```

It drives `/grid` on the dev instance with a fixture fleet (the boot snapshot is rewritten in flight and `EventSource` is a fake) and stubs `/term/**` with a
page that speaks the `grid-mod` / `grid-key` messages, so no pane ever reaches ttyd or a real tmux session. The modes: `open` (panes, tabs, caps), `groups`
(sidebar grouping), `persist` (a stored layout naming a gone session is dropped, and says so), `ended` (a pane whose session ends), `phone` (a touch or narrow device gets a note and a link to `/`, not the grid), `drag` (column and sidebar handles stay normalised), `keys` (chords, including from the framed terminal page), `tabs` (drag-reorder), `park`
(hidden tabs close their sockets after 10 minutes and come back on click; the page hidden that long parks every tab, the one on screen included, and remounts that one on return), `leak` (20 cycles of chords, parking and reordering with six panes: the same six
iframes, listeners within +20 and DOM nodes within +200 of the start, and, once every tab is closed, no iframe and listeners within +20 and DOM nodes within +60 of the empty grid counted before the first tab opened). `leak` reads Chromium's DevTools counters
(`Memory.getDOMCounters`), so it is Chromium-only. The pure layout state has its own browser-less check, `node scripts/grid-logic-check.mjs`, run by preflight.

## Known red

- **`sessions-check.mjs chromium history`, check 3** (`scroll -> Back -> Forward -> Back lands on the offset just set (700)`): fails with `{"back2":300}`.
  Not caused by the grid view: a clean detached worktree of `main` (e618bb2, before `feat/grid-view`) fails identically, 3 runs of 3, so it predates this
  branch (the branch diff touches no scroll restoration). Owner: alonso, the shell's history/scroll restoration, to be fixed on its own branch. Until then
  `sessions-check chromium all` is expected to end `1 FAILED` on this one check and nothing else; any other FAIL there is new.

## What they cannot tell you

- **A real on-screen keyboard.** Playwright raises none, in any engine. The composer's `--kb`
  handler is exercised against `visualViewport` and a 375×812 viewport, and that is not the same
  thing. WebKit ignores `interactive-widget=resizes-content` outright, which makes that handler the
  only thing carrying iOS — so this gap is the one that most wants a physical phone.
- **Real Safari.** Playwright's WebKit is the engine, not the browser: no iOS quirks, no Safari
  chrome, no bfcache.
- **A real agent turn.** Every streaming assertion drives the server's own `MOWS_TEST_HOOKS` delta
  injectors. A real `claude -p` turn costs money and needs systemd.
- **HTTP/2.** Needs a live TLS host; see the `MOWS_HOST` assertion in `scripts/e2e-infra.sh`.

## One expected engine message, and why it is a NOTE rather than a failure

WebKit does not implement the `interactive-widget` viewport key, says so once per page load, and
reports it on the console channel Playwright classifies as an error. `journey` matches that one
message by its exact text and reports it as a NOTE.

That is not a filter added to turn a red line green. It made `webkit/journey` red **from the day
these probes were written** — verified by running the probe against the tree as it stood before the
filter existed, where it fails identically — which means the WebKit half of this repo's strongest
client-side evidence had never once been green and nobody had noticed, because nobody had run it.
The message is also not incidental: WebKit ignoring `interactive-widget` is precisely the
divergence the chat view's hand-written `--kb` handler exists to compensate for. A check labelled
"no uncaught JS errors" failing on it is measuring something other than its own name. A *different*
viewport warning still fails.

## Cockpit parity baseline: agents, agent, run (re-baselined in phase 02b)

`docs/qa/baseline/cockpit/{chromium,webkit}/{agents,agent,run}-{390,1280}.png` were re-captured from the `/ui` SPA, not from the server-rendered twin, because the SPA is what the shell ports (ledger K-33). Command per route: `node scripts/parity-capture.mjs --route /agents/<fixture> --as /ui/agents/<fixture> --out docs/qa/baseline/cockpit` (likewise `/agents` as `/ui/agents`, and the run page). The chat screens (`agent`, `run`) hide the server footer in the shell, as `/ui` has none; the footer's fate is a phase 05 decision.
