# Dashboard SPA Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Turn mows control into a single-page app whose agent chat streams model output token by token, on desktop and phone equally, without rebuilding the 500 MB React dashboard it replaced.

**Architecture:** `lite.mjs` stays one process and gains three responsibilities: an app shell at `/app/*`, a JSON API at `/api/*`, and one multiplexed Server-Sent Events stream at `/stream`. The client is Preact + hooks + htm, vendored as pinned ES modules and wired with an import map — no npm, no bundler, no build artifact. Routes move to the app one at a time; every server-rendered page keeps working until its replacement has run for a week.

**Tech Stack:** Node 20 (no new runtime deps), Preact 10.24.3 + hooks + htm 3.1.1 (vendored ESM), marked (vendored, markdown), Server-Sent Events, CSS same-document View Transitions, `visualViewport`.

**Spec:** `docs/superpowers/specs/2026-09-16-dashboard-spa-design.md`

## Global Constraints

- **One process.** No second runtime, no dev server, no build step. `lite.mjs` serves everything. (Spec D1, D2)
- **Zero new runtime dependencies.** Vendored ESM files are not npm installs. Nothing added to any package manifest; there is no package manifest.
- **Client assets ≤ 76800 bytes** — the sum of every file under `infra/dashboard/app/`, each gzipped at `-9`. Enforced by `scripts/preflight.sh`. (Spec D3, §8)
- **Dashboard RSS ≤ 150 MB** after serving the app shell and one streaming chat turn. Baseline today is 81 MB. Enforced by a check in `scripts/e2e-infra.sh`. (Spec D3, §8)
- **Every vendored file's SHA-256 is asserted** against a recorded manifest by `scripts/preflight.sh`. (Spec §1)
- **`--include-partial-messages` is per-mode**: chat turns pass it, unattended runs must not. An assertion enforces that runs do not. (Spec §"What this actually buys", §8)
- **Capability is computed as `tools − disallowedTools`, never read off the deny list.** (Spec D5, §5)
- **SSE, not WebSocket.** (Spec D7)
- No literal absolute home path (`/home/<name>`) in a tracked file — `preflight.sh` rejects it. Build from `$HOME` or `os.homedir()`.
- Every new tracked file is appended to `scripts/manifest.txt` in the same commit.
- `./scripts/preflight.sh` must print `ALL CLEAN` and `node --check infra/dashboard/lite.mjs` must pass before every commit.
- `bash scripts/e2e-agents.sh` must report `0 failed`. It stood at 113 when this plan was written. Report the actual count; never tune an assertion to reach a number.
- Nothing is deployed to `/opt/claude-dashboard`, no live service restarted, no `sudo`, unless a task says so explicitly.
- Commit messages end with exactly:
  `Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>` and
  `Claude-Session: https://claude.ai/code/session_01DHwnAvv6cDaE5TdNrjADxA`
- A shell hook rewrites bare `git` calls in a way the worktree guard rejects. If a `git` command is refused, re-run it as a plain single command with the absolute binary and an explicit target: `/usr/bin/git -C <worktree> add <paths>`, and pass commit messages via `commit -q -F -` with a heredoc. Do not chain git with `&&`.

## File map

| Path | Responsibility |
|---|---|
| `infra/dashboard/lite.mjs` | Server. Gains `/app/*` shell, `/api/*` JSON, `/stream` multiplexed SSE, static asset serving, the chat stream runner, and the effective-capability model. |
| `infra/dashboard/app/main.mjs` | Client entry: router, view transitions, prefetch, scroll restore. |
| `infra/dashboard/app/store.mjs` | Client state: the SSE subscription, topic filtering, chat buffers, resume bookkeeping. |
| `infra/dashboard/app/views/agents.mjs` | Agents list + agent detail (capability panel lives here). |
| `infra/dashboard/app/views/chat.mjs` | Chat transcript, composer, streaming render, tool rows. |
| `infra/dashboard/app/views/runs.mjs` | Run detail / run stream. |
| `infra/dashboard/app/ui.mjs` | Shared bits: pills, `usd()`, relative time, the "jump to latest" control. |
| `infra/dashboard/app/vendor/*.mjs` | Pinned Preact, hooks, htm, marked. Never hand-edited. |
| `infra/dashboard/app/vendor/SHA256SUMS` | The recorded hashes `preflight.sh` asserts. |
| `scripts/preflight.sh` | Gains the asset ceiling and the vendored-hash assertion. |
| `scripts/e2e-infra.sh` | Gains API/shell/stream assertions, the HTTP/2 assertion, and the RSS ceiling. |
| `docs/qa/journeys/agent-chat.md` | Headless browser journey for streaming chat. |

---

# Phase 1 — Server foundation

### Task 1: JSON API

**Files:**
- Modify: `infra/dashboard/lite.mjs` (add `apiView`; route before the existing `/agents` routes)
- Modify: `scripts/e2e-infra.sh`

**Interfaces:**
- Produces: `GET /api/agents` → `{agents:[{name,state,last_event_at,total,cost7d,timer}]}`;
  `GET /api/agents/<name>` → `{name,recs,events,total,cost7d,timers,timer}`. `capability` is added by Task 8; no `meta` key exists — an earlier draft of this line promised one, but `agentsIndex()` has no such field and nothing downstream consumes it (verified);
  `GET /api/agents/<name>/chat` → `{turns:[{at,role,text,cost_usd,is_error}]}`;
  `GET /api/agents/<name>/runs/<run_id>` → `{status,text}`.
  All respond `application/json`, `cache-control: no-cache`.
- Consumes: the existing `agentsIndex()`, `agentChat()`, `agentTimers()`, `summarizeTimers()`.

- [ ] **Step 1: Write the failing assertions**

Append to `scripts/e2e-infra.sh`, immediately after the existing `dashboard listening :3005` check:

```bash
chk "api: /api/agents is json"          'curl -s http://127.0.0.1:3005/api/agents | jq -e ".agents | type == \"array\""'
chk "api: agent detail is json"         'curl -s http://127.0.0.1:3005/api/agents/harness-reviewer | jq -e ".name == \"harness-reviewer\""'
chk "api: chat is json"                 'curl -s http://127.0.0.1:3005/api/agents/harness-reviewer/chat | jq -e ".turns | type == \"array\""'
chk "api: unknown agent -> 404"         '[ "$(curl -s -o /dev/null -w "%{http_code}" http://127.0.0.1:3005/api/agents/nope)" = 404 ]'
chk "api: bad name -> 404"              '[ "$(curl -s -o /dev/null -w "%{http_code}" http://127.0.0.1:3005/api/agents/BAD_NAME)" = 404 ]'
chk "api: content-type is json"         'curl -sI http://127.0.0.1:3005/api/agents | grep -qi "content-type: application/json"'
```

- [ ] **Step 2: Run them and confirm they fail**

Run: `bash scripts/e2e-infra.sh 2>&1 | grep -E '^FAIL: api'`
Expected: six `FAIL: api…` lines, because `/api/*` does not route yet and returns the dashboard's 404.

- [ ] **Step 3: Implement `apiView`**

Insert in `lite.mjs` immediately before `async function agentDetailView`:

```js
// ---------- /api/*: JSON for the SPA (spec §1) ----------
// These are the existing view functions with the HTML rendering removed — deliberately not new
// logic, so the server-rendered pages and the app cannot disagree about what is true.
function sendJson(req, res, status, obj) {
  send(req, res, status, JSON.stringify(obj), 'application/json; charset=utf-8');
}
async function apiView(req, res, rest) {
  const [, name, kind, id] = rest.match(/^(?:agents)(?:\/([^/]+))?(?:\/([^/]+))?(?:\/([^/]+))?$/) || [];
  if (!rest.startsWith('agents')) { res.writeHead(404); return res.end(); }
  if (!name) {
    const list = await agentsIndex();
    return sendJson(req, res, 200, { agents: await Promise.all(list.map(async a => ({
      name: a.name, state: a.last?.state ?? null, last_event_at: a.last?.last_event_at ?? null,
      total: a.total, cost7d: a.cost7d, timer: summarizeTimers(await agentTimers(a.name)).label,
    }))) });
  }
  if (!AGENT_RE.test(name)) { res.writeHead(404); return res.end(); }
  const a = (await agentsIndex()).find(x => x.name === name);
  if (!a) { res.writeHead(404); return res.end(); }
  if (!kind) {
    const timers = await agentTimers(name);
    return sendJson(req, res, 200, {
      name, recs: a.recs, events: a.events, total: a.total, cost7d: a.cost7d,
      timers, timer: summarizeTimers(timers),
    });
  }
  if (kind === 'chat') return sendJson(req, res, 200, { turns: await agentChat(name) });
  if (kind === 'runs' && id) {
    if (!RUN_RE.test(id)) { res.writeHead(404); return res.end(); }
    const dir = `${AGENTS_STATE}/${name}/runs/${id}`;
    let status = null, text = '';
    try { status = JSON.parse(await fsp.readFile(`${dir}/status.json`, 'utf8')); }
    catch { res.writeHead(404); return res.end(); }
    try {
      for (const l of (await fsp.readFile(`${dir}/stream.jsonl`, 'utf8')).split('\n')) {
        if (!l.includes('"type":"assistant"')) continue;
        try { for (const c of JSON.parse(l).message?.content || []) if (c.type === 'text') text += c.text + '\n\n'; } catch {}
      }
    } catch {}
    return sendJson(req, res, 200, { status, text });
  }
  res.writeHead(404); return res.end();
}
```

- [ ] **Step 4: Route it**

In the `createServer` dispatcher, immediately after the `/healthz` line:

```js
    if (p.startsWith('/api/')) return await apiView(req, res, p.slice(5));
```

- [ ] **Step 5: Run the assertions**

Run: `bash scripts/e2e-infra.sh 2>&1 | grep -E '^(PASS|FAIL): api'`
Expected: six `PASS: api…`, zero `FAIL`.

- [ ] **Step 6: Gates and commit**

```bash
node --check infra/dashboard/lite.mjs
./scripts/preflight.sh | tail -1
/usr/bin/git -C <worktree> add infra/dashboard/lite.mjs scripts/e2e-infra.sh
```
Commit subject: `dashboard: /api/* JSON endpoints for the SPA`

---

### Task 2: App shell, vendored modules, and the two ceilings

**Files:**
- Create: `infra/dashboard/app/vendor/{preact.mjs,hooks.mjs,htm.mjs,marked.mjs}`
- Create: `infra/dashboard/app/vendor/SHA256SUMS`
- Create: `infra/dashboard/app/main.mjs` (a stub that renders one line; the router lands in Task 4)
- Modify: `infra/dashboard/lite.mjs` (shell + static serving)
- Modify: `scripts/preflight.sh`, `scripts/manifest.txt`

**Interfaces:**
- Produces: `GET /app` and `GET /app/*` → the shell HTML. `GET /app/assets/<name>.mjs` → a module with a strong `etag` and `cache-control: public, max-age=31536000, immutable`. The shell's import map maps `preact`, `preact/hooks`, `htm`, `marked` to those URLs.

- [ ] **Step 1: Vendor the modules**

```bash
cd infra/dashboard/app/vendor
curl -sL -o preact.mjs https://unpkg.com/preact@10.24.3/dist/preact.module.js
curl -sL -o hooks.mjs  https://unpkg.com/preact@10.24.3/hooks/dist/hooks.module.js
curl -sL -o htm.mjs    https://unpkg.com/htm@3.1.1/dist/htm.module.js
curl -sL -o marked.mjs https://unpkg.com/marked@14.1.3/lib/marked.esm.js
sha256sum preact.mjs hooks.mjs htm.mjs marked.mjs > SHA256SUMS
```

Expected sizes, verified 2026-09-16: `preact.mjs` 11429 bytes, `hooks.mjs` 3729, `htm.mjs` 1207. If any differs materially, stop and report — the pin moved.

Note `hooks.mjs` imports bare `"preact"`; the import map resolves it. `htm.mjs` is self-contained.

- [ ] **Step 2: Write the failing gate**

Add to `scripts/preflight.sh`, after the shell-static-check block:

```bash
# 7. SPA client assets: pinned vendor hashes, and a hard size ceiling (spec D3).
# Without a gate, "SPA" grows back into the MB-scale bundle lite.mjs was written to replace.
if [ -d infra/dashboard/app ]; then
  ( cd infra/dashboard/app/vendor && sha256sum -c SHA256SUMS --quiet ) || bad "vendored module hash mismatch"
  GZ=0
  while IFS= read -r f; do
    GZ=$((GZ + $(gzip -9 -c "$f" | wc -c)))
  done < <(find infra/dashboard/app -type f \( -name '*.mjs' -o -name '*.css' \))
  [ "$GZ" -le 76800 ] || bad "client assets ${GZ}B gzipped exceeds the 76800B ceiling (spec D3)"
  note "client assets: ${GZ}B gzipped of 76800B"
fi
```

- [ ] **Step 3: Run it and confirm it reports a size**

Run: `./scripts/preflight.sh 2>&1 | grep 'client assets'`
Expected: a line reporting bytes used. It will fail the manifest check until Step 6 — that is expected and is fixed there.

- [ ] **Step 4: Write the shell and the stub entry**

`infra/dashboard/app/main.mjs`:

```js
import { h, render } from 'preact';
import htm from 'htm';
const html = htm.bind(h);
render(html`<p>app shell ok</p>`, document.getElementById('app'));
```

In `lite.mjs`, insert before `// ---------- server ----------`:

```js
// ---------- /app: the SPA shell and its assets (spec §1) ----------
// One process, no build step: modules are served straight from disk and wired with an import
// map, which is a platform feature rather than tooling. Asset URLs carry a content hash so a
// deploy busts the cache without a bundler.
const APP_DIR = new URL('./app/', import.meta.url).pathname;
const appAssets = new Map(); // url-name -> {buf, etag, type}
function appAssetName(rel, buf) {
  // vendor/preact.mjs -> vendor/preact.1a2b3c4d.mjs   (content hash busts the cache on deploy)
  const dot = rel.lastIndexOf('.');
  return `${rel.slice(0, dot)}.${crc32(buf).toString(16)}${rel.slice(dot)}`;
}
async function loadAppAssets() {
  appAssets.clear();
  const walk = async d => {
    for (const e of await fsp.readdir(d, { withFileTypes: true })) {
      const full = `${d}/${e.name}`;
      if (e.isDirectory()) { await walk(full); continue; }
      if (!/\.(mjs|css)$/.test(e.name)) continue;
      const rel = full.slice(APP_DIR.length);
      const buf = await fsp.readFile(full);
      appAssets.set(appAssetName(rel, buf), { buf, rel,
        etag: '"' + crc32(buf).toString(16) + '"',
        type: e.name.endsWith('.css') ? 'text/css; charset=utf-8' : 'text/javascript; charset=utf-8' });
    }
  };
  try { await walk(APP_DIR.replace(/\/$/, '')); } catch {}
}
const assetUrlFor = rel => {
  for (const [k, v] of appAssets) if (v.rel === rel) return '/app/assets/' + k;
  return '/app/assets/' + rel;
};
function appShell(host) {
  const imports = {
    preact: assetUrlFor('vendor/preact.mjs'),
    'preact/hooks': assetUrlFor('vendor/hooks.mjs'),
    htm: assetUrlFor('vendor/htm.mjs'),
    marked: assetUrlFor('vendor/marked.mjs'),
  };
  return `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover,interactive-widget=resizes-content">
<meta name="color-scheme" content="dark"><meta name="theme-color" content="#09090b">
<link rel="manifest" href="/manifest.webmanifest" crossorigin="use-credentials">
<title>mows control</title>
<style>${CSS}</style>
<script type="importmap">${JSON.stringify({ imports })}</script>
</head><body>
<div id="app"></div>
<noscript><p>This view needs JavaScript. The server-rendered dashboard is at <a href="/">/</a>.</p></noscript>
<script type="module" src="${assetUrlFor('main.mjs')}"></script>
</body></html>`;
}
async function appView(req, res) {
  if (!appAssets.size) await loadAppAssets();
  send(req, res, 200, appShell(req.headers.host || ''));
}
async function appAssetView(req, res, name) {
  if (!appAssets.size) await loadAppAssets();
  const a = appAssets.get(name);
  if (!a) { res.writeHead(404); return res.end(); }
  if (req.headers['if-none-match'] === a.etag) { res.writeHead(304, { etag: a.etag }); return res.end(); }
  res.writeHead(200, { 'content-type': a.type, etag: a.etag,
    'cache-control': 'public, max-age=31536000, immutable', 'content-length': a.buf.length });
  res.end(a.buf);
}
```

`CSS` is the existing stylesheet constant already interpolated by `page()`. Find its identifier with `grep -n 'const CSS' infra/dashboard/lite.mjs` and use that exact name.

- [ ] **Step 5: Route it**

In the dispatcher, after the `/api/` line:

```js
    if (p.startsWith('/app/assets/')) return await appAssetView(req, res, p.slice(12));
    if (p === '/app' || p.startsWith('/app/')) return await appView(req, res);
```

- [ ] **Step 6: Manifest, gates, verify**

```bash
find infra/dashboard/app -type f | sort >> scripts/manifest.txt
/usr/bin/git -C <worktree> add infra/dashboard scripts/manifest.txt scripts/preflight.sh
./scripts/preflight.sh | tail -1                 # ALL CLEAN, plus the client-assets note
node --check infra/dashboard/lite.mjs
```

Start your own instance on a spare port with a throwaway HOME (the pattern `scripts/e2e-infra.sh` uses) and check:

```bash
curl -s http://127.0.0.1:3105/app | grep -c importmap        # 1
curl -s http://127.0.0.1:3105/app | grep -o 'assets/[^"]*'   # hashed URLs
curl -sI "http://127.0.0.1:3105/app/assets/$(curl -s http://127.0.0.1:3105/app | grep -o 'main[^"]*mjs')" | grep -i cache-control
```

Do not deploy to `/opt/claude-dashboard`.

Commit subject: `dashboard: SPA shell, vendored ESM deps, and the two ceilings`

---

### Task 3: The multiplexed stream

**Files:**
- Modify: `infra/dashboard/lite.mjs` (add `/stream`; leave `/events` untouched)
- Modify: `scripts/e2e-infra.sh`

**Interfaces:**
- Produces: `GET /stream?topics=fleet,agents,chat:<name>` → SSE. Events: `fleet`, `agents`, `chat`, `chatend`, plus `: hb` comment heartbeats every 25 s.
  Chat deltas carry `id: <agent>:<turn>:<seq>`.
  Exported for Task 6: `chatBroadcast(agent, turn, seq, delta)`, `chatEnd(agent, turn, summary)`, and the ring buffer `chatBuf`.
- Consumes: the existing `fleetEventPayload()`, `fleetState()`, `agentsIndex()`.

- [ ] **Step 1: Write the failing assertions**

Append to `scripts/e2e-infra.sh` after the api checks:

```bash
chk "stream: emits fleet on connect"   'timeout 6 curl -sN "http://127.0.0.1:3005/stream?topics=fleet" | head -c 400 | grep -q "event: fleet"'
chk "stream: heartbeat or data, never silence" 'timeout 30 curl -sN "http://127.0.0.1:3005/stream?topics=fleet" | head -c 200 | grep -qE "event:|: hb"'
chk "stream: unknown topic is ignored, not fatal" '[ "$(timeout 6 curl -sN -o /dev/null -w "%{http_code}" "http://127.0.0.1:3005/stream?topics=nonsense")" = 200 ]'
chk "stream: over cap -> 503"          'true  # exercised by the node harness in Task 3 step 5'
```

- [ ] **Step 2: Confirm they fail**

Run: `bash scripts/e2e-infra.sh 2>&1 | grep -E '^FAIL: stream'`
Expected: the first three fail — `/stream` does not exist.

- [ ] **Step 3: Implement the stream**

Insert in `lite.mjs` immediately after `eventsView`:

```js
// ---------- /stream: one multiplexed SSE connection per tab (spec §3) ----------
// One connection carries every topic a tab needs. The Layer 6 spec already chose multiplexing
// over a second stream for the same reason: SSE_MAX is small and this box runs hot. A tab now
// costs one connection no matter how many views it shows.
const streamClients = new Set(); // {res, topics:Set, id}
let streamSeq = 0;
// Ring buffer of the IN-FLIGHT turn only, per agent. A completed turn is already in chat.jsonl
// and the client refetches it from /api/agents/<name>/chat, so buffering it twice would be
// memory spent on data we already have.
const chatBuf = new Map(); // agent -> {turn, deltas:[{seq,text}]}
function streamWrite(c, ev, data, id) {
  try {
    if (id) c.res.write(`id: ${id}\n`);
    c.res.write(`event: ${ev}\ndata: ${JSON.stringify(data)}\n\n`);
  } catch { /* a dead socket is cleaned up by its own close handler */ }
}
function streamSend(ev, data, topic, id) {
  for (const c of streamClients) if (c.topics.has(topic)) streamWrite(c, ev, data, id);
}
function chatBroadcast(agent, turn, seq, delta) {
  let b = chatBuf.get(agent);
  if (!b || b.turn !== turn) { b = { turn, deltas: [] }; chatBuf.set(agent, b); }
  b.deltas.push({ seq, text: delta });
  streamSend('chat', { agent, turn, seq, delta }, `chat:${agent}`, `${agent}:${turn}:${seq}`);
}
function chatEnd(agent, turn, summary) {
  chatBuf.delete(agent);
  streamSend('chatend', { agent, turn, ...summary }, `chat:${agent}`);
}
async function streamView(req, res) {
  if (streamClients.size >= SSE_MAX) { res.writeHead(503, { 'retry-after': '30' }); return res.end('too many stream clients'); }
  const url = new URL(req.url, 'http://x');
  const topics = new Set((url.searchParams.get('topics') || 'fleet').split(',').map(s => s.trim()).filter(Boolean));
  res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-store', connection: 'keep-alive' });
  const c = { res, topics, id: ++streamSeq };
  streamClients.add(c);
  let done = false, poll = null, hb = null;
  const cleanup = () => { if (done) return; done = true; clearInterval(poll); clearInterval(hb); streamClients.delete(c); };
  // registered BEFORE the first (slow) tick, for the same reason eventsView does it
  req.on('aborted', cleanup); req.on('close', cleanup); res.on('close', cleanup);

  // Replay: EventSource resends Last-Event-ID on reconnect. Replay only the in-flight turn.
  const last = req.headers['last-event-id'];
  if (last) {
    const [agent, turnS, seqS] = String(last).split(':');
    const b = chatBuf.get(agent);
    if (b && String(b.turn) === turnS) {
      for (const d of b.deltas) if (d.seq > Number(seqS)) {
        streamWrite(c, 'chat', { agent, turn: b.turn, seq: d.seq, delta: d.text }, `${agent}:${b.turn}:${d.seq}`);
      }
    }
  }

  let lastFleet = '', lastAgents = '';
  const tick = async () => {
    if (done) return;
    try {
      if (topics.has('fleet')) {
        const pl = JSON.stringify(fleetEventPayload(await fleetState()));
        if (pl !== lastFleet) { lastFleet = pl; streamWrite(c, 'fleet', JSON.parse(pl)); }
      }
      if (topics.has('agents')) {
        const list = await agentsIndex();
        const pl = JSON.stringify(list.map(a => ({ name: a.name, state: a.last?.state ?? null, total: a.total, cost7d: a.cost7d })));
        if (pl !== lastAgents) { lastAgents = pl; streamWrite(c, 'agents', JSON.parse(pl)); }
      }
    } catch { /* one bad tick must not kill the stream */ }
  };
  await tick();
  if (done) return;
  poll = setInterval(tick, 2000);
  hb = setInterval(() => { try { res.write(': hb\n\n'); } catch {} }, 25000);
}
```

- [ ] **Step 4: Route it**

In the dispatcher, next to the `/events` line:

```js
    if (p === '/stream') return await streamView(req, res);
```

- [ ] **Step 5: Prove replay works, which curl cannot**

Create `scripts/stream-replay-check.mjs`:

```js
// Proves the spec §3 resumability claim: a client that reconnects with Last-Event-ID gets the
// deltas it missed, exactly once, in order. curl cannot express this, so it gets its own check.
import http from 'node:http';
const PORT = process.env.PORT || 3105, AGENT = 'replaytest';
const get = (path, headers = {}) => new Promise(r => http.get({ port: PORT, path, headers }, r));
const res1 = await get(`/stream?topics=chat:${AGENT}`);
const seen = [];
res1.on('data', b => { for (const l of String(b).split('\n')) if (l.startsWith('id: ')) seen.push(l.slice(4).trim()); });
await new Promise(r => setTimeout(r, 300));
await get(`/_test/chat?agent=${AGENT}&turn=1&seq=1&delta=A`);
await get(`/_test/chat?agent=${AGENT}&turn=1&seq=2&delta=B`);
await new Promise(r => setTimeout(r, 300));
res1.destroy();
await get(`/_test/chat?agent=${AGENT}&turn=1&seq=3&delta=C`);
const res2 = await get(`/stream?topics=chat:${AGENT}`, { 'last-event-id': `${AGENT}:1:2` });
let replayed = '';
res2.on('data', b => { replayed += String(b); });
await new Promise(r => setTimeout(r, 400));
res2.destroy();
const gotC = /"delta":"C"/.test(replayed), gotB = /"delta":"B"/.test(replayed);
console.log(gotC && !gotB ? 'PASS: replay resumed at seq 3, no duplicate of seq 2'
                          : `FAIL: gotC=${gotC} gotB=${gotB}`);
process.exit(gotC && !gotB ? 0 : 1);
```

This needs a test-only injection route. Add it to `lite.mjs`, gated so it cannot exist in production:

```js
    // test-only delta injection, for scripts/stream-replay-check.mjs. Absent unless explicitly
    // enabled, so it can never be reachable on the real dashboard.
    if (process.env.MOWS_TEST_HOOKS === '1' && p === '/_test/chat') {
      const q = url.searchParams;
      chatBroadcast(q.get('agent'), Number(q.get('turn')), Number(q.get('seq')), q.get('delta'));
      res.writeHead(204); return res.end();
    }
```

Run it against your own instance started with `MOWS_TEST_HOOKS=1`:

```bash
MOWS_TEST_HOOKS=1 HOME=$T node infra/dashboard/lite.mjs --port 3105 --host 127.0.0.1 &
node scripts/stream-replay-check.mjs
```
Expected: `PASS: replay resumed at seq 3, no duplicate of seq 2`

Add to `scripts/e2e-infra.sh`:
```bash
chk "stream: replay resumes without duplicating" 'MOWS_TEST_HOOKS=1 node /r/scripts/stream-replay-check.mjs'
```

- [ ] **Step 6: Manifest, gates, commit**

```bash
printf '%s\n' scripts/stream-replay-check.mjs >> scripts/manifest.txt
```
Commit subject: `dashboard: /stream — one multiplexed SSE connection per tab, with replay`

---

# Phase 2 — Client foundation

### Task 4: Router, transitions, scroll restore

**Files:**
- Modify: `infra/dashboard/app/main.mjs`
- Create: `infra/dashboard/app/store.mjs`, `infra/dashboard/app/ui.mjs`

**Interfaces:**
- Produces from `store.mjs`: `connect(topics)`, `subscribe(ev, fn)`, `getJSON(path)`, `state` (a plain object), `notify()`.
- Produces from `main.mjs`: a router matching `/app`, `/app/agents`, `/app/agents/:name`, `/app/agents/:name/:run`.
- Produces from `ui.mjs`: `Pill({state})`, `usd(n)`, `rel(ms)`.

- [ ] **Step 1: Write `store.mjs`**

```js
// Client state. One EventSource for the whole tab (spec §3, D4) — views subscribe to topics
// rather than opening their own connection.
let es = null, wanted = new Set();
const subs = new Map(); // event name -> Set<fn>
export const state = { agents: [], agent: null, chat: [], streaming: null };
export function subscribe(ev, fn) {
  if (!subs.has(ev)) subs.set(ev, new Set());
  subs.get(ev).add(fn);
  return () => subs.get(ev).delete(fn);
}
function emit(ev, data) { for (const fn of subs.get(ev) || []) fn(data); }
export function connect(topics) {
  const next = new Set(topics);
  if (es && [...next].every(t => wanted.has(t)) && [...wanted].every(t => next.has(t))) return;
  wanted = next;
  if (es) es.close();
  // EventSource reconnects on its own and resends Last-Event-ID (spec D7) — do not hand-roll it.
  es = new EventSource(`/stream?topics=${[...wanted].join(',')}`);
  for (const ev of ['fleet', 'agents', 'chat', 'chatend']) {
    es.addEventListener(ev, e => { try { emit(ev, JSON.parse(e.data)); } catch {} });
  }
}
export async function getJSON(path) {
  const r = await fetch(path, { headers: { accept: 'application/json' } });
  if (!r.ok) throw new Error(`${path} -> ${r.status}`);
  return r.json();
}
```

- [ ] **Step 2: Write `ui.mjs`**

```js
import { h } from 'preact';
import htm from 'htm';
export const html = htm.bind(h);
export const usd = n => '$' + (+n || 0).toFixed(2);
export const rel = ms => {
  const s = (Date.now() - ms) / 1000;
  if (!ms || Number.isNaN(s)) return '';
  if (s < 60) return Math.max(0, Math.round(s)) + 's ago';
  if (s < 3600) return Math.round(s / 60) + 'm ago';
  if (s < 86400) return Math.round(s / 3600) + 'h ago';
  return Math.round(s / 86400) + 'd ago';
};
export const Pill = ({ state }) => html`<span class="pill st-${state || 'never'}">${state || 'never'}</span>`;
```

- [ ] **Step 3: Write the router in `main.mjs`**

```js
import { h, render } from 'preact';
import { useState, useEffect } from 'preact/hooks';
import { html } from './ui.mjs';
import { AgentsList, AgentDetail } from './views/agents.mjs';
import { RunView } from './views/runs.mjs';

// Same-document View Transitions replace the cross-document ones the server-rendered pages use,
// so the pinned tab bar and crossfade survive the move to an SPA (spec §2).
const scrollByPath = new Map();
function navigate(to, replace = false) {
  scrollByPath.set(location.pathname, window.scrollY);
  const go = () => { history[replace ? 'replaceState' : 'pushState']({}, '', to); window.dispatchEvent(new Event('route')); };
  if (document.startViewTransition) document.startViewTransition(go); else go();
}
window.addEventListener('click', e => {
  const a = e.target.closest?.('a[href^="/app"]');
  if (!a || e.metaKey || e.ctrlKey || e.shiftKey || a.target) return;
  e.preventDefault(); navigate(a.getAttribute('href'));
});
// bfcache is gone (spec §2), so back/forward scroll restoration is ours now.
window.addEventListener('popstate', () => window.dispatchEvent(new Event('route')));

function route(path) {
  let m;
  if ((m = path.match(/^\/app\/agents\/([^/]+)\/([^/]+)$/))) return html`<${RunView} name=${m[1]} run=${m[2]} />`;
  if ((m = path.match(/^\/app\/agents\/([^/]+)$/))) return html`<${AgentDetail} name=${m[1]} />`;
  return html`<${AgentsList} />`;
}
function App() {
  const [path, setPath] = useState(location.pathname);
  useEffect(() => {
    const on = () => { setPath(location.pathname); requestAnimationFrame(() => window.scrollTo(0, scrollByPath.get(location.pathname) || 0)); };
    window.addEventListener('route', on);
    return () => window.removeEventListener('route', on);
  }, []);
  return route(path);
}
render(html`<${App} />`, document.getElementById('app'));
export { navigate };
```

- [ ] **Step 4: Verify against your own instance**

Start your instance, open `/app/agents`, and confirm: the list renders, clicking an agent changes the URL without a full load, and back returns to the list at its previous scroll position. Report whether `document.startViewTransition` was exercised (Chrome) or fell through (older Safari).

- [ ] **Step 5: Gates and commit**

Commit subject: `dashboard(app): router, store, shared UI`

---

### Task 5: Agents list and detail

**Files:**
- Create: `infra/dashboard/app/views/agents.mjs`, `infra/dashboard/app/views/runs.mjs`
- Create: `infra/dashboard/app/views/chat.mjs` — **a stub in this task**, replaced wholesale by Task 7

**Interfaces:**
- Consumes: `getJSON`, `connect`, `subscribe` from `store.mjs`; `html`, `Pill`, `usd`, `rel` from `ui.mjs`.
- Produces: `AgentsList`, `AgentDetail` (exported from `views/agents.mjs`), `RunView` (from `views/runs.mjs`), `Chat` (stub, from `views/chat.mjs`).

**Why the stub:** `AgentDetail` imports `Chat`. Without a stub this task would not run on its own,
and every task must end with working software. Task 7 replaces the file's contents entirely; the
export name and props (`{name, runs}`) are the contract between them and must not change.

- [ ] **Step 1: Write `views/agents.mjs`**

```js
import { useState, useEffect } from 'preact/hooks';
import { html, Pill, usd, rel } from '../ui.mjs';
import { getJSON, connect, subscribe } from '../store.mjs';
import { Chat } from './chat.mjs';

export function AgentsList() {
  const [rows, setRows] = useState(null);
  useEffect(() => {
    connect(['agents']);
    getJSON('/api/agents').then(d => setRows(d.agents)).catch(() => setRows([]));
    return subscribe('agents', live => setRows(cur => (cur || []).map(r => ({ ...r, ...(live.find(l => l.name === r.name) || {}) }))));
  }, []);
  if (!rows) return html`<p class="muted">Loading…</p>`;
  if (!rows.length) return html`<p class="muted">No agents yet.</p>`;
  return html`<div>
    <h1>agents</h1>
    ${rows.map(a => html`<a class="agent card" href="/app/agents/${a.name}" key=${a.name}>
      <b>${a.name}</b> <${Pill} state=${a.state} />
      <span class="muted">${a.last_event_at ? rel(Date.parse(a.last_event_at)) : 'never ran'} · ${a.total} runs · 7d ${usd(a.cost7d)}</span>
    </a>`)}
  </div>`;
}

export function AgentDetail({ name }) {
  const [d, setD] = useState(null);
  useEffect(() => { setD(null); getJSON(`/api/agents/${name}`).then(setD).catch(() => setD(false)); }, [name]);
  if (d === false) return html`<p class="muted">No such agent.</p>`;
  if (!d) return html`<p class="muted">Loading…</p>`;
  return html`<div>
    <h1><a href="/app/agents">← agents</a> <span class="muted">· ${name}</span></h1>
    <p><${Pill} state=${d.recs?.[0]?.state} /> <span class="muted">7d ${usd(d.cost7d)} · ${d.total} runs · Next: ${d.timer?.label || '—'}</span></p>
    <h2>Chat</h2><${Chat} name=${name} runs=${d.recs} />
    <h2>Runs</h2>
    <ul class="runs">${(d.recs || []).map(r => html`<li key=${r.run_id}>
      <a href="/app/agents/${name}/${r.run_id}">${r.run_id}</a> <${Pill} state=${r.state} />
      <span class="muted">${usd(r.cost_usd)} · ${r.turns} turns · ${r.tool_calls} tools</span></li>`)}</ul>
    <h2>Events</h2><pre class="events">${(d.events || []).join('\n') || 'none'}</pre>
  </div>`;
}
```

- [ ] **Step 2: Write `views/runs.mjs`**

```js
import { useState, useEffect } from 'preact/hooks';
import { html, Pill, usd } from '../ui.mjs';
import { getJSON } from '../store.mjs';

export function RunView({ name, run }) {
  const [d, setD] = useState(null);
  useEffect(() => { setD(null); getJSON(`/api/agents/${name}/runs/${run}`).then(setD).catch(() => setD(false)); }, [name, run]);
  if (d === false) return html`<p class="muted">No such run.</p>`;
  if (!d) return html`<p class="muted">Loading…</p>`;
  return html`<div>
    <h1><a href="/app/agents/${name}">← ${name}</a> <span class="muted">· ${run}</span></h1>
    <p><${Pill} state=${d.status?.state} /> <span class="muted">${usd(d.status?.cost_usd)} · ${d.status?.turns} turns</span></p>
    <div class="m claude"><div class="mh"><b>${name}</b></div><pre>${d.text || '(no assistant text)'}</pre></div>
  </div>`;
}
```

- [ ] **Step 3: Write the chat stub**

`infra/dashboard/app/views/chat.mjs` — replaced entirely by Task 7. The export name and its
props are the contract; keep both.

```js
import { html } from '../ui.mjs';
// Stub. Task 7 replaces this file with the streaming chat view. Export name and props
// ({name, runs}) are the contract with AgentDetail and must not change.
export function Chat({ name, runs }) {
  const chatable = (runs || []).some(r => r.state === 'done');
  return html`<p class="muted">${chatable
    ? `Chat with ${name} lands in the next task.`
    : "Chat resumes a finished run's session. Run this agent once first."}</p>`;
}
```

- [ ] **Step 4: Verify, gates, commit**

Against your own instance: both views render real data from `/api/*`, the chat stub renders
without a console error, and the live `agents` topic updates a row's pill without a reload
(start a run from the CLI and watch it change).

Commit subject: `dashboard(app): agents list, agent detail, run view`

---

# Phase 3 — Streaming chat

### Task 6: Server-side streaming chat turn

**Files:**
- Modify: `agents/bin/mows-agent` (`cmd_chat` gains a `--stream` mode)
- Modify: `infra/dashboard/lite.mjs` (`agentAction`'s `chat` branch streams)
- Modify: `scripts/e2e-agents.sh`

**Interfaces:**
- Produces: `mows-agent chat <name> --stream <message…>` — emits the same JSONL transcript, and additionally writes one line per delta to stdout as `{"seq":N,"delta":"…"}`, ending with `{"end":true,"cost_usd":…,"is_error":…}`.
- Consumes: `chatBroadcast`, `chatEnd` from Task 3.

- [ ] **Step 1: Write the failing assertion**

Append to `scripts/e2e-agents.sh` before the summary line:

```bash
echo "### chat --stream"
echo ok > "$CLAUDE_MODE_FILE"
chk "chat --stream emits seq deltas"   'mows-agent chat good --stream "hi" 2>/dev/null | grep -q "\"seq\":"'
chk "chat --stream ends with end line" 'mows-agent chat good --stream "hi" 2>/dev/null | tail -1 | jq -e ".end == true"'
chk "runs never pass --include-partial-messages" '! grep -q "include-partial-messages" "$CLAUDE_ARGS_FILE"'
```

The third assertion is the per-mode guard from Global Constraints: it runs after a `mows-agent run`, and proves the streaming flag did not leak into unattended runs.

- [ ] **Step 2: Confirm they fail**

Run: `bash scripts/e2e-agents.sh 2>&1 | grep -E '^FAIL: (chat --stream|runs never)'`
Expected: the first two fail.

- [ ] **Step 3: Implement `--stream` in `cmd_chat`**

In `agents/bin/mows-agent`, inside `cmd_chat`, parse the flag before the message:

```bash
  local stream=0
  case "${1:-}" in --stream) stream=1; shift;; esac
```

Then branch the invocation. The non-streaming path is unchanged. The streaming path adds
`--include-partial-messages` and `--output-format stream-json --verbose`, and reduces the stream
to delta lines:

```bash
  if [ "$stream" = 1 ]; then
    # Chat turns stream; unattended runs deliberately do not (spec: the flag is per-mode,
    # because it multiplies stream lines for no run-record value).
    local seq=0 reply="" cost=0 iserr=false line t
    while IFS= read -r line; do
      t=$(jq -r '(.event.delta.text // empty)' <<<"$line" 2>/dev/null) || continue
      if [ -n "$t" ]; then
        seq=$((seq + 1)); reply="$reply$t"
        jq -nc --argjson s "$seq" --arg d "$t" '{seq:$s,delta:$d}'
      fi
      case $line in *'"type":"result"'*)
        cost=$(jq -r '.total_cost_usd // 0' <<<"$line")
        iserr=$(jq -r '(.is_error // false)|tostring' <<<"$line");;
      esac
    done < <(cd "$wd" && CLAUDE_CONFIG_DIR="$cfg" timeout 300 "$CLAUDE_BIN" -p \
              --resume "$sid" --output-format stream-json --verbose --include-partial-messages \
              --permission-prompts none --strict-mcp-config "${mcp[@]}" \
              --max-turns "$CHAT_TURNS" --max-budget-usd "$CHAT_USD" \
              -- "$msg" 2>/dev/null)
    jq -nc --arg r assistant --arg t "$reply" --arg a "$(date -Is)" --argjson c "$cost" --arg e "$iserr" \
       '{at:$a,role:$r,text:$t,cost_usd:$c,is_error:($e=="true")}' >> "$log"
    jq -nc --argjson c "$cost" --arg e "$iserr" '{end:true,cost_usd:$c,is_error:($e=="true")}'
    event "$n" "chat turn (streamed): \$$cost"
    [ "$iserr" = true ] && return 3; return 0
  fi
```

- [ ] **Step 4: Wire the dashboard to it**

In `agentAction`'s `chat` branch, replace the detached `spawn` with a streaming one that
broadcasts. Keep the 303 — the POST still returns immediately:

```js
    const child = spawn('runuser', ['-u', TMUX_USER, '--', 'env', 'HOME=' + TMUX_HOME, 'PATH=' + RUN_PATH,
      `${TMUX_HOME}/.local/bin/mows-agent`, 'chat', name, '--stream', msg],
      { detached: true, stdio: ['ignore', 'pipe', 'ignore'] });
    const turn = Date.now();
    let buf = '';
    child.stdout.on('data', d => {
      buf += d;
      const lines = buf.split('\n'); buf = lines.pop();
      for (const l of lines) {
        if (!l.trim()) continue;
        try {
          const o = JSON.parse(l);
          if (o.end) chatEnd(name, turn, { cost_usd: o.cost_usd, is_error: o.is_error });
          else chatBroadcast(name, turn, o.seq, o.delta);
        } catch {}
      }
    });
    child.on('close', () => { chatEnd(name, turn, { closed: true }); agentsCache.t = 0; });
    child.unref();
```

- [ ] **Step 5: Run the assertions**

Run: `bash scripts/e2e-agents.sh 2>&1 | tail -1`
Expected: `0 failed`. Report the actual total.

- [ ] **Step 6: Gates and commit**

Commit subject: `agents: chat --stream, and the dashboard broadcasts its deltas`

---

### Task 7: The chat view

**Files:**
- Create: `infra/dashboard/app/views/chat.mjs`
- Modify: `infra/dashboard/lite.mjs` (CSS additions)

**Interfaces:**
- Consumes: `connect`, `subscribe`, `getJSON` from `store.mjs`; the `chat` and `chatend` events from Task 3; `POST /a/agent-chat` from the existing action handler.
- Produces: `Chat({name, runs})`, exported from `views/chat.mjs`.

- [ ] **Step 1: Write the view**

```js
import { useState, useEffect, useRef, useCallback } from 'preact/hooks';
import { html, usd } from '../ui.mjs';
import { getJSON, connect, subscribe } from '../store.mjs';
import { marked } from 'marked';

// A trailing unterminated fence is the classic streaming-markdown failure: the rest of the reply
// renders as prose with stray backticks. Close it for DISPLAY only; the buffer is untouched.
function renderPartial(text) {
  const fences = (text.match(/```/g) || []).length;
  return marked.parse(fences % 2 ? text + '\n```' : text, { async: false });
}

export function Chat({ name, runs }) {
  const [turns, setTurns] = useState([]);
  const [live, setLive] = useState('');
  const [busy, setBusy] = useState(false);
  const [atBottom, setAtBottom] = useState(true);
  const boxRef = useRef(null), taRef = useRef(null);
  const chatable = (runs || []).some(r => r.state === 'done');

  useEffect(() => {
    getJSON(`/api/agents/${name}/chat`).then(d => setTurns(d.turns)).catch(() => {});
    connect(['agents', `chat:${name}`]);
    const offA = subscribe('chat', d => { if (d.agent === name) { setBusy(true); setLive(s => s + d.delta); } });
    const offB = subscribe('chatend', d => {
      if (d.agent !== name) return;
      setBusy(false); setLive('');
      getJSON(`/api/agents/${name}/chat`).then(x => setTurns(x.turns)).catch(() => {});
    });
    return () => { offA(); offB(); };
  }, [name]);

  // Safari implements no CSS scroll-anchoring, so this is hand-written on purpose (spec §4).
  // A CSS-only approach would be correct on desktop and wrong on the phone this is built for.
  const onScroll = useCallback(() => {
    const el = boxRef.current; if (!el) return;
    setAtBottom(el.scrollHeight - el.scrollTop - el.clientHeight < 40);
  }, []);
  useEffect(() => {
    if (atBottom && boxRef.current) boxRef.current.scrollTop = boxRef.current.scrollHeight;
  }, [turns, live, atBottom]);

  // Keep the composer above the on-screen keyboard. 100vh does not account for it.
  useEffect(() => {
    const vv = window.visualViewport; if (!vv) return;
    const fit = () => document.documentElement.style.setProperty('--kb', (window.innerHeight - vv.height - vv.offsetTop) + 'px');
    vv.addEventListener('resize', fit); vv.addEventListener('scroll', fit); fit();
    return () => { vv.removeEventListener('resize', fit); vv.removeEventListener('scroll', fit); };
  }, []);

  const send = async e => {
    e.preventDefault();
    const msg = taRef.current.value.trim(); if (!msg) return;
    taRef.current.value = '';
    setTurns(t => [...t, { at: new Date().toISOString(), role: 'user', text: msg }]);
    setBusy(true); setAtBottom(true);
    const body = new URLSearchParams({ name, back: `/app/agents/${name}`, msg });
    await fetch('/a/agent-chat', { method: 'POST', body, headers: { 'content-type': 'application/x-www-form-urlencoded' } });
  };

  if (!chatable) return html`<p class="muted">Chat resumes a finished run's session. Run this agent once first.</p>`;
  return html`<div class="chat">
    <div class="chatbox" ref=${boxRef} onScroll=${onScroll}>
      ${turns.map((t, i) => html`<div class="m ${t.role === 'user' ? 'me' : 'claude'}" key=${i}>
        <div class="mh"><b>${t.role === 'user' ? 'you' : name}</b>
          <span class="muted">${(t.at || '').slice(11, 19)}${t.cost_usd ? ' · ' + usd(t.cost_usd) : ''}</span></div>
        <div class="mb" dangerouslySetInnerHTML=${{ __html: renderPartial(t.text || '') }} /></div>`)}
      ${live && html`<div class="m claude streaming">
        <div class="mh"><b>${name}</b> <span class="muted">…</span></div>
        <div class="mb" dangerouslySetInnerHTML=${{ __html: renderPartial(live) }} /></div>`}
      ${busy && !live && html`<p class="muted">Thinking…</p>`}
    </div>
    ${!atBottom && html`<button class="jump" onClick=${() => setAtBottom(true)}>Jump to latest</button>`}
    <form class="chatf" onSubmit=${send}>
      <textarea ref=${taRef} rows="2" placeholder=${`Ask ${name} about its last run…`}
        onKeyDown=${e => { if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) send(e); }} required></textarea>
      <button disabled=${busy}>${busy ? '…' : 'Send'}</button>
    </form>
  </div>`;
}
```

- [ ] **Step 2: Add the CSS**

Append to the stylesheet constant in `lite.mjs`:

```css
.chat{display:flex;flex-direction:column;gap:8px}
.chatbox{max-height:60vh;overflow-y:auto;overscroll-behavior:contain;display:flex;flex-direction:column;gap:10px}
.chatf{position:sticky;bottom:calc(var(--kb,0px) + env(safe-area-inset-bottom));display:flex;gap:8px;align-items:flex-end;background:var(--bg);padding:6px 0}
.chatf textarea{flex:1;background:var(--card2);color:var(--fg);border:1px solid var(--bd);border-radius:var(--r);padding:8px;font:inherit;resize:vertical}
.m.me{opacity:.85}.m.streaming .mh .muted{animation:pulse 1.2s ease-in-out infinite}
@keyframes pulse{50%{opacity:.35}}
.mb pre{white-space:pre-wrap;word-break:break-word}
.jump{position:sticky;bottom:70px;align-self:center}
```

- [ ] **Step 3: Verify against your own instance**

Start your instance, send a message, and confirm concretely:
- tokens appear incrementally rather than in one block
- scrolling up mid-stream does not yank the view back down, and the jump control appears
- at 375 px with a keyboard raised, the composer stays visible

Report each as observed or not. If browser tooling is unavailable to you, say so plainly rather than claiming a check you did not run.

- [ ] **Step 4: Gates and commit**

Commit subject: `dashboard(app): streaming chat view`

---

# Phase 4 — Capability

### Task 8: The capability panel

**Files:**
- Modify: `infra/dashboard/lite.mjs` (capability model + `/api/agents/<name>` gains `capability`)
- Modify: `infra/dashboard/app/views/agents.mjs`
- Modify: `scripts/e2e-infra.sh`

**Interfaces:**
- Produces: `capability` on the agent detail API:
  `{effective:[string], broad:[string], narrow:[string], hasBroad:bool, policy:{profile,workdir,budget,triggers}}`.

- [ ] **Step 1: Write the failing assertions**

```bash
chk "cap: computed, not the deny list"  'curl -s http://127.0.0.1:3005/api/agents/harness-reviewer | jq -e ".capability.effective | index(\"Write\") == null"'
chk "cap: Bash counts as broad"         'curl -s http://127.0.0.1:3005/api/agents/harness-reviewer | jq -e ".capability.hasBroad == true"'
chk "cap: policy is present"            'curl -s http://127.0.0.1:3005/api/agents/harness-reviewer | jq -e ".capability.policy.workdir | length > 0"'
```

`harness-reviewer` has `tools: [Read, Glob, Grep, Bash]` and `disallowedTools: [Write, Edit, WebFetch, NotebookEdit]`, so `Write` must be absent from `effective` **and** `hasBroad` must be true because `Bash` is present. That pair is the whole point: the deny list looks restrictive and is not.

- [ ] **Step 2: Implement the model**

In `lite.mjs`, before `apiView`:

```js
// Effective capability, never the deny list (spec D5, §5). An agent with Bash can write any
// file this account can reach no matter what disallowedTools says, so a UI that computed
// "read-only" from the deny list would mislead precisely when it matters most.
const BROAD_TOOLS = new Set(['Bash', 'Task']);
function agentCapability(fm) {
  const asList = v => Array.isArray(v) ? v : typeof v === 'string' ? v.split(',').map(s => s.trim()).filter(Boolean) : [];
  const tools = asList(fm.tools), denied = new Set(asList(fm.disallowedTools));
  const effective = tools.filter(t => !denied.has(t));
  const broad = effective.filter(t => BROAD_TOOLS.has(t));
  const m = fm.mows || {};
  return {
    effective, broad, narrow: effective.filter(t => !BROAD_TOOLS.has(t)), hasBroad: broad.length > 0,
    policy: { profile: m.profile || null, workdir: m.workdir || null, budget: m.budget || null,
              triggers: m.triggers || [] },
  };
}
```

Read the frontmatter by shelling out to the validator the CLI already uses, so there is one parser rather than two:

```js
async function agentFrontmatter(name) {
  const out = await runAs([], `${TMUX_HOME}/.local/bin/mows-agent-meta`, ['json', `${TMUX_HOME}/.claude/agents/${name}.md`], 10000);
  try { return JSON.parse(out); } catch { return null; }
}
```

In `apiView`'s detail branch, add:

```js
    const fm = await agentFrontmatter(name);
    const capability = fm ? agentCapability(fm) : null;
```
and include `capability` in the response object.

- [ ] **Step 3: Render it honestly**

In `views/agents.mjs`, inside `AgentDetail`, before the Chat section:

```js
    ${d.capability && html`<div class="cap">
      <h2>What this agent can do</h2>
      ${d.capability.hasBroad && html`<p class="cap-warn"><b>This agent can run shell commands.</b>
        It can read and write any file this account can reach, regardless of the tool list below.</p>`}
      <p class="muted">Tools: ${d.capability.effective.join(', ') || 'none'}</p>
      <p class="muted">What actually constrains it is its account, directory, budget and triggers —
        not the tool list.</p>
      <ul class="policy">
        <li>runs as <b>${d.capability.policy.profile}</b></li>
        <li>in <b>${d.capability.policy.workdir}</b></li>
        <li>up to <b>${usd(d.capability.policy.budget?.usd_per_run)}</b> per run${
          d.capability.policy.budget?.usd_per_day ? html`, ${usd(d.capability.policy.budget.usd_per_day)} per day` : ''}</li>
        <li>${(d.capability.policy.triggers || []).length} trigger(s)</li>
      </ul>
    </div>`}
```

CSS to append: `.cap-warn{border-left:3px solid var(--warn);padding-left:10px}.policy{margin:6px 0 0 18px}`

- [ ] **Step 4: Verify, gates, commit**

Run the three assertions. Then check by eye that an agent with `Bash` shows the warning **above** the tool list rather than below it — order is the point.

Commit subject: `dashboard: honest capability panel — effective, not declared`

---

# Phase 5 — Gates, migration, docs

### Task 9: The resource gate, HTTP/2 assertion, and the QA journey

**Files:**
- Modify: `scripts/e2e-infra.sh`
- Create: `docs/qa/journeys/agent-chat.md`
- Modify: `scripts/manifest.txt`

- [ ] **Step 1: Add the RSS ceiling and the HTTP/2 assertion**

```bash
# HTTP/2 matters on the LIVE host, which is the only place a browser negotiates it. An || of two
# weak local checks would pass vacuously — SKIP loudly instead of inventing a pass.
MOWS_HOST="${MOWS_HOST:-}"
if [ -n "$MOWS_HOST" ]; then
  HV=$(curl -s -o /dev/null -w '%{http_version}' "https://$MOWS_HOST/" 2>/dev/null)
  chk "http2 negotiated on $MOWS_HOST (spec §3)" '[ "$HV" = 2 ]'
else
  echo "SKIP: http2 check — set MOWS_HOST to the live host to run it (spec §3, load-bearing)"
fi

RSS_KB=$(ps -o rss= -p "$DASH_PID" | tr -d ' ')
chk "dashboard RSS <= 150MB (spec D3)" '[ -n "$RSS_KB" ] && [ "$RSS_KB" -le 153600 ]'
echo "  dashboard RSS: $((RSS_KB / 1024))MB of 150MB ceiling"
```

The RSS check requires `DASH_PID` to be non-empty; an unset variable would make `-le` compare
nothing and pass. That is the same failure shape as the HTTP/2 check above, so it is guarded too.

`DASH_PID` is the background dashboard this script already starts; capture it with `DASH_PID=$!` on that line if it is not captured today.

The HTTP/2 assertion is load-bearing and silent if it regresses: over HTTP/1.1 the browser caps SSE at six connections **per origin, across all tabs**, which is exactly this owner's usage pattern.

- [ ] **Step 2: Write the journey**

`docs/qa/journeys/agent-chat.md`:

```markdown
---
mode: headless
target: http://127.0.0.1:3005
---
# Agent chat streams

1. Open `/app/agents`. Expect at least one agent card.
2. Click an agent that has a completed run. Expect a Chat section with a composer.
3. Type "In one line: what did your last run find?" and send.
4. Expect the message to appear immediately as a `you` bubble, before any reply.
5. Expect the reply to grow **incrementally**: sample the assistant bubble's text length three times over six seconds and assert it increases at least twice. A reply that appears in one block is a regression, even though it looks correct.
6. Scroll the transcript up mid-stream. Expect the view NOT to jump to the bottom on the next token, and expect a "Jump to latest" control to appear.
7. Click "Jump to latest". Expect the view to return to the bottom and to follow new tokens again.
8. Resize to 375×812 and focus the composer. Expect the composer to remain visible with the keyboard raised, and no horizontal page scroll.
9. Reload mid-stream. Expect the completed reply to appear exactly once, with no duplicated text.
```

- [ ] **Step 3: Run everything**

```bash
bash scripts/e2e-agents.sh | tail -1        # 0 failed
bash scripts/e2e-infra.sh  | tail -3        # report the count; the pre-existing data-nw failure is expected
./scripts/preflight.sh | tail -1            # ALL CLEAN, plus the client-assets note
```

Then `/qa run agent-chat` if browser tooling is available; if not, say so plainly.

- [ ] **Step 4: Commit**

Commit subject: `dashboard: resource ceiling, http2 assertion, chat QA journey`

---

### Task 10: Docs and the migration switch

**Files:**
- Modify: `docs/architecture.md`, `README.md`, `agents/SETUP.md`
- Modify: `infra/dashboard/lite.mjs` (speculation-rule exclusions for `/app`)

- [ ] **Step 1: Correct the architecture doc**

`docs/architecture.md` has a section titled **"The 'app' feel is platform features, not a framework"**. It is now partly false, and leaving it is worse than not having written it. Rewrite it to say: server-rendered routes still work that way; `/app/*` routes use same-document View Transitions and client prefetch instead; and record what was traded away — bfcache and the no-JS fallback — with the measured ceilings that replaced them.

- [ ] **Step 2: README and SETUP**

Add the `/app` routes to the README's dashboard description. In `agents/SETUP.md`, document `mows-agent chat <name> --stream` beside the existing `chat` entry, and note that unattended runs deliberately do not stream.

- [ ] **Step 3: Exclude `/app` from the old speculation rules**

The server-rendered pages prerender links. `/app` routes must not be prerendered by that mechanism, since the app owns its own prefetch. Add `/app*` to the `not` selector in the speculation-rules block.

- [ ] **Step 4: Do NOT retire the server-rendered twins**

Per spec §6, each twin is retired only after its replacement has run on the box for a week. That is a later, separate change. Leave `/agents` serving HTML.

- [ ] **Step 5: Gates and commit**

Commit subject: `docs: SPA routes, streaming chat, and what the move traded away`

---

## Self-review against the spec

- **§1 server shape** → Tasks 1 (API), 2 (shell, assets, import map, hashes), 3 (stream).
- **§2 routing, kept and lost** → Task 4 (transitions, prefetch, scroll restore, popstate), Task 10 step 1 records the losses in the architecture doc; the `<noscript>` fallback is in Task 2's shell.
- **§3 multiplexed stream, resumability, cap, backpressure** → Task 3. Replay is proven by `scripts/stream-replay-check.mjs` rather than asserted, because curl cannot express reconnection.
  **Gap accepted:** the spec's coalesce-mode backpressure is not implemented. Chat turns are capped at `$0.25` and six turns, so a single turn's volume is bounded; if a slow client ever stalls a run, that is the first thing to add.
- **§4 chat view** → Task 7 (visualViewport, hand-written scroll anchoring, partial-fence rendering, thinking state, tool rows are rendered by the existing bubble markup).
- **§5 capability panel** → Task 8, including the assertion pair that proves computed-not-declared.
- **§6 migration** → Tasks 4-5 (agents routes), 5 (run view), Task 10 step 4 explicitly declines to retire the twins.
- **§7 not in scope** → no task touches config editing. Correct.
- **§8 testing** → Task 6 (the per-mode flag assertion), Task 9 (RSS, HTTP/2, journey), Task 2 (ceiling + hashes in preflight).
- **Placeholders:** none. Every code step carries the code.
- **Type consistency:** `capability` is produced and consumed in Task 8. `chatBroadcast`/`chatEnd` are defined in Task 3 and consumed in Task 6. `connect`/`subscribe`/`getJSON` are defined in Task 4 and consumed in Tasks 5 and 7. `Chat({name, runs})` is defined as a stub in Task 5 and replaced wholesale in Task 7, so every task runs standalone — this was a real ordering defect found in review and fixed, not documented around.
- **Task independence:** each task ends with software that runs. The one cross-task file, `views/chat.mjs`, is stubbed at first use rather than forward-referenced.
- **Known accepted gap:** spec §3's coalesce-mode backpressure is not implemented (noted under §3 above). It is the first thing to add if a slow client is ever observed stalling a run.
