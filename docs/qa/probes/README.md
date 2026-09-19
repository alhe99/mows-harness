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
414×896, 1024×800 and 1400×900. It also asserts *which* nav is actually rendered at each width,
which the greps cannot: `.tabs` is `display:none` above 701px and the pill-nav header is hidden
below it, so a change to that media query would leave both navs in the markup, neither one visible,
and every grep green.

It asserts its own precondition first, because the first version of it did not and passed at all
four viewports against the broken code: the composer is `position:sticky` and only reaches the FAB
once its containing block extends past the fold, which the two-line fixture transcript does not do.
The probe grows the transcript box to its own designed `max-height` through CSSOM and then asserts
that the composer really is in its sticky state before measuring anything.

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
