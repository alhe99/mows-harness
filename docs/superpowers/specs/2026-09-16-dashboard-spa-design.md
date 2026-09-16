# mows control as an SPA — streaming agent chat, and an honest capability panel

**Date:** 2026-09-16
**Status:** design approved in chat; pending spec review
**Scope:** `infra/dashboard/lite.mjs` (server: app shell + JSON API + one multiplexed stream),
new `infra/dashboard/app/` (client modules, vendored deps), `infra/caddy/Caddyfile.template`
(no change expected — recorded here so the assumption is checked), `scripts/` gates.
**Supersedes:** the fleet-redesign spec's **direction B** (server-rendered + one island).
That spec named this move explicitly as **direction C** and reserved it for a single decision
point. This document is that decision, taken deliberately by the owner on 2026-09-16.

## Why this is being written at all

The dashboard is deliberately zero-dependency and server-rendered. `lite.mjs`'s own header
records what it replaced: *"a React build that cost 500 MB RSS and a MB-scale bundle"*, five
node processes reduced to one. `docs/architecture.md` goes further, with a section titled
**"The 'app' feel is platform features, not a framework"**, documenting that the installed-app
feel comes from cross-document View Transitions, Speculation Rules and bfcache rather than
from JavaScript.

Both facts were put to the owner before this design was accepted. The decision stands. This
spec's job is therefore narrow and specific: **build the SPA without rebuilding the failure.**
That failure had three named causes — five processes, a megabyte-scale hydration bundle, and a
build pipeline — and none of them is inherent to a single-page app.

Measured for this design, on this box:

| | old React dashboard | this design |
|---|---|---|
| processes | 5 | 1 (unchanged `lite.mjs`) |
| client runtime | MB-scale bundle | **6.6 KB gzipped** (preact + hooks + htm, measured) |
| build step | yes | none — ES modules + an import map |
| deploy artifact | built bundle | the same single file plus vendored modules |

## What this actually buys

Not navigation. Navigation is already good, and §2 keeps it. The genuine gap is **streaming**:
a chat reply takes 30–60 s of real model time, and today you POST, get a 303, and reload. No
amount of platform-feature polish makes a page reload feel like a conversation.

Verified on this box before designing (Claude Code 2.1.273):

```
claude -p --output-format stream-json --include-partial-messages
  -> stream_event / content_block_delta  with .event.delta.text   (incremental text)
  -> stream_event / thinking_delta       with .estimated_tokens   (a live thinking state)
```

Layer 6 deliberately does **not** pass `--include-partial-messages` for unattended runs, because
it multiplies stream lines for no run-record value. That judgement is correct and unchanged. The
flag becomes **per-mode**: chat turns pass it, runs do not.

## Decisions locked

| # | Decision | Why |
|---|---|---|
| D1 | **One process.** `lite.mjs` serves the app shell, the JSON API and the stream. No second runtime, no dev server. | The previous failure was five processes. This is the single most important constraint in the document. |
| D2 | **No build step.** Preact, hooks and htm are vendored as three pinned files, wired with `<script type="importmap">`. | Import maps are a platform feature, consistent with the repo's own stated philosophy. Keeps `git clone && install.sh` as the whole story. |
| D3 | **Hard ceilings with actual numbers, enforced by gates: 75 KB gzipped of client assets, and 150 MB RSS for the dashboard process.** | Without a gate, "SPA" grows back into the thing that was removed. A number in prose is not a constraint — see §8 for how each is measured, and the baselines they were derived from. |
| D4 | **One multiplexed stream**, not one per surface. | The Layer 6 spec already chose this for the same reason: "add an `agents` key to the diffed snapshot rather than a second stream (you're capped at 8 clients)". The owner runs many tabs. |
| D5 | **Capability is computed, never read off the deny list.** | An agent with `Bash` can write regardless of `disallowedTools`. A panel that renders "read-only" from the deny list would lie exactly when it matters. |
| D6 | **Incremental route takeover.** Server-rendered pages keep working until replaced. | No flag day, and every step is revertible. |
| D7 | **SSE, not WebSocket.** | Reuses the proxy, auth and reconnect stack already working. `EventSource` reconnects and resends `Last-Event-ID` natively. WebSocket only pays off for mid-stream client→server signals, which are not in scope. |

## 1. Server shape

`lite.mjs` keeps its current responsibilities and adds three:

- `GET /app/*` — the app shell: one small HTML document, the import map, and a module entry
  point. Identical for every SPA route; the client router reads the path.
- `GET /api/*` — JSON for what the views need: `agents`, `agents/<name>`, `agents/<name>/runs/<id>`,
  `agents/<name>/chat`, `fleet`, `system`. These are the existing view functions with the HTML
  rendering removed, not new logic.
- `GET /stream` — one Server-Sent Events endpoint, multiplexed (§3).

Existing server-rendered routes are untouched until §6 retires each one.

**Static assets.** `infra/dashboard/app/` holds the client modules and `app/vendor/` the three
pinned dependency files plus the markdown renderer. `lite.mjs` serves them with a strong
`etag` and `cache-control: public, max-age=31536000, immutable`, keyed by a content hash in the
URL so a deploy busts the cache without a build step.

**Vendored files, pinned by version and hash** (measured 2026-09-16):

| file | source | bytes |
|---|---|---|
| `preact.mjs` | preact@10.24.3 `dist/preact.module.js` | 11,429 |
| `hooks.mjs` | preact@10.24.3 `hooks/dist/hooks.module.js` | 3,729 |
| `htm.mjs` | htm@3.1.1 `dist/htm.module.js` | 1,207 |
| `marked.mjs` | marked, pinned | ~12 KB gzipped |

`hooks.mjs` imports bare `"preact"`; the import map resolves it. Verified: `htm.mjs` is
self-contained. `preflight.sh` asserts each vendored file's SHA-256 against a recorded manifest,
so a vendored dependency cannot change without a visible diff.

## 2. Routing, and what we keep and lose

**Kept.** Same-document View Transitions replace the cross-document ones. The tab bar keeps its
`view-transition-name: tabs` so it stays pinned while content crossfades — the same effect by a
different mechanism. Prefetch on hover replaces Speculation Rules for app routes, with the same
exclusions the current rules carry: never `/term*`, never a run-stream route, never a link
carrying `fresh=1` or `reclaim=1`.

**Lost, accepted, and written down rather than discovered:**

- **bfcache.** Back and forward become the client's responsibility. The router restores scroll
  position per route and the chat view restores its transcript from the store, not the network.
- **The no-JS fallback.** The fleet spec deliberately preserved a correct no-JavaScript view.
  This design ends that for app routes. `GET /app/*` serves a `<noscript>` block linking to the
  server-rendered equivalent for as long as one exists (§6).
- **Two navigation models during migration**, until §6 completes.

## 3. The multiplexed stream

One `EventSource` per tab, carrying every live topic:

```
event: fleet     data: {…}                     # the existing diffed snapshot
event: agents    data: {…}                     # agent index rows
event: chat      id: <agent>:<turn>:<seq>
                 data: {"agent":"…","turn":17,"seq":42,"delta":"…"}
event: chatend   data: {"agent":"…","turn":17,"state":"done","cost_usd":0.04}
```

The client subscribes by filtering; the server sends a topic only if at least one client asked
for it, via a `?topics=` query on connect.

**Resumability.** Each chat delta carries `id: <agent>:<turn>:<seq>`. The server keeps an
in-memory ring buffer of the **in-flight turn only**, per agent, capped at the turn's own token
count. On reconnect `EventSource` sends `Last-Event-ID`; the server replays from `seq+1`. A
completed turn is not buffered — it is already in `chat.jsonl` and the client refetches it from
`/api/agents/<name>/chat`. This is what makes a phone locking for 40 s recoverable rather than
producing a duplicated or truncated message.

**Cap.** `SSE_MAX` stays, but the binding constraint moves: one stream per tab rather than one
per surface means a tab costs one connection no matter how many views it shows. HTTP/2 is
confirmed on the live host (`curl` reports `protocol=2`), so the browser's 6-connection-per-origin
limit for HTTP/1.1 does not apply. **That is load-bearing and silent if it regresses**, so
`e2e-infra.sh` asserts HTTP/2 negotiation.

**Backpressure.** A slow client must not stall the run. The writer drops to "coalesce mode" for
a client whose socket is not draining: it stops sending individual deltas and sends the latest
accumulated text on the next tick. The run itself never blocks on a browser.

## 4. Chat view

**Layout.** Transcript scrolls; composer is fixed to the bottom. The composer's offset is driven
by `visualViewport` (`resize` + `scroll`), not by `100vh`, so the on-screen keyboard does not
cover it. Safe-area insets via `env(safe-area-inset-bottom)` for the installed PWA.

**Scroll anchoring is hand-written.** Safari implements no CSS scroll-anchoring, so a CSS-only
approach would be correct on desktop and wrong on the owner's phone. The rule: before appending
a delta, record whether the user is within 40 px of the bottom; after appending, restore scroll
only if they were. When they are not, show a "jump to latest" affordance with a count.

**Streaming render.** Deltas append to a plain-text buffer. Markdown is rendered from that buffer
on a rAF-throttled tick, not per token. A trailing unterminated code fence is closed for display
only, so a half-arrived fence renders as code rather than leaking backticks into prose. The
final render happens once on `chatend` against the authoritative text.

**Tool use.** A tool call inside a turn renders as a collapsed row (`name` + duration), expanding
to its input on tap. Long-running tools show elapsed time, so a 40 s gap looks like work rather
than a hang.

**Thinking.** `thinking_delta` drives a live indicator with its `estimated_tokens`, replaced by
the answer when the first `content_block_delta` arrives.

## 5. The capability panel

The panel answers one question honestly: *what can this agent actually do to my machine?*

**Effective capability, computed:** `tools − disallowedTools`. Never the deny list alone.

**Two tiers, after Android's runtime-permission versus special-access split** — a split Android
made because its own documentation concedes that granting Accessibility makes the rest of the
permission dialog irrelevant, since it can approve future prompts itself. The same is true here:

- **Broad authority** — `Bash`, `Task`, and any MCP tool with shell, filesystem-write or network
  reach. If any is present, the panel leads with one blunt line: *"This agent can run shell
  commands. It can read and write any file this account can reach, regardless of the tool list
  below."* No green badge, no checklist implying constraint.
- **Narrow tools** — `Read`, `Glob`, `Grep`, `WebFetch`, listed plainly underneath.

**The real boundary is stated, not implied.** The panel says in words that what actually
constrains an agent is its account, its working directory, its budget and its triggers — the
Operating Policy — and shows those with equal weight. A tool list alone constrains nothing once
broad authority is present.

**Prompt.** Shown read-only, collapsed to ~6 lines with an expand. It is the largest part of the
file and would otherwise dominate the layout.

**Editing is out of scope for this spec** (§7). The panel is read-only here.

## 6. Migration

One route at a time, each independently revertible:

1. `/app/agents` and `/app/agents/<name>` — including chat. The reason for the whole change.
2. `/app/agents/<name>/<run_id>` — the run stream.
3. `/app/` (fleet) and `/app/system`.
4. Retire each server-rendered twin only after its replacement has run on the box for a week.

`/agents` keeps serving server-rendered HTML throughout step 1–3 and redirects to `/app/agents`
only at step 4. Reverting is deleting a redirect.

## 7. Not in this spec

- **Editing agent configuration.** It needs comment-preserving YAML round-tripping, conflict
  handling when the file changed on disk, and a decision about what is safe to edit from a
  phone. Bundling it here would ship a security-sensitive surface under UI deadline pressure,
  which is how the read-only gap shipped in the first place. Its own spec.
- Multi-user auth changes, offline support, push notifications, mid-stream steering
  (the WebSocket case in D7).

## 8. Testing

- **`scripts/e2e-agents.sh`** — unchanged; the CLI is untouched except for the per-mode
  `--include-partial-messages` flag, which gets an assertion that runs do **not** pass it.
- **`scripts/e2e-infra.sh`** — asserts: the app shell serves, the import map resolves, each
  `/api/*` endpoint returns valid JSON, the stream emits and replays correctly from a
  `Last-Event-ID`, and **HTTP/2 is negotiated** (§3).
- **`scripts/preflight.sh`** — asserts each vendored file's SHA-256 against the recorded
  manifest (§1), and **the 75 KB gzipped client-asset ceiling** (D3): the sum of every file
  under `infra/dashboard/app/`, each gzipped at `-9`, must not exceed 76800 bytes.

  Baselines this number comes from, measured on this box 2026-09-16: the current island is
  **3,772 bytes gzipped** (8,870 raw) for 140 lines; the vendored runtime is **6,601 bytes
  gzipped** for preact + hooks + htm; the markdown renderer adds roughly 12 KB gzipped. A
  1,000–1,500 line app is therefore expected to land near 55 KB, and 75 KB is deliberate
  headroom — while still being about two orders of magnitude below the "MB-scale bundle" this
  design exists to avoid. If a change needs the ceiling raised, that is a conversation, which
  is the entire point of having it.
- **`docs/qa/journeys/agent-chat.md`** — a headless journey: send a message, observe tokens
  arriving incrementally rather than in one block, kill the connection mid-stream and confirm
  the reply completes without duplication, then repeat at 375 px with the keyboard raised.
- **Resource regression.** The failure being avoided is measurable, so measure it. A check
  reads the dashboard process's RSS after serving the app shell and one streaming chat turn,
  and **fails above 150 MB**.

  Baseline: `claude-dash-lite` is **81 MB RSS** today (measured 2026-09-16, one process). The
  old React dashboard cost ~500 MB across five. 150 MB leaves this design room to hold stream
  buffers and still be more than three times better than what was removed — and if it ever
  approaches that number, the design has failed on the exact axis it was written to protect,
  and §Risks' fallback applies.

## Risks

- **Bundle creep.** The mechanism that failed last time was gradual. D3's gate is the only real
  defence; if it is ever disabled, this design has lost its main safety property.
- **HTTP/2 regression.** Silent, and it would reintroduce a browser-wide 6-connection cap across
  all tabs — the owner's stated usage pattern. Asserted in `e2e-infra.sh` for that reason.
- **Streaming cost.** `--include-partial-messages` multiplies stream volume. Chat turns are
  short and capped at $0.25, so the volume is bounded, but the per-mode split must not leak into
  unattended runs.
- **Two navigation models** during §6. Bounded by completing the migration rather than leaving
  it half-done, which is the standing temptation.
- **The owner is overruling two recorded decisions** — direction B, and "the app feel is platform
  features, not a framework". If this design disappoints, the honest fallback is reverting to
  server-rendered pages plus the §3 stream for chat alone, which is approach A from the
  discussion and remains available because of D6.
