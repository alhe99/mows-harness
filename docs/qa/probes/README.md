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
./docs/qa/probes/run.sh all webkit        # every probe above
```

Needs `docker` and a network on first run (it pulls `node:20-slim`). Everything it creates is
named `mows-qa-*` and is removed on exit, including on Ctrl-C.

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
