#!/usr/bin/env node
// lite.mjs — mows sessions dashboard, rebuilt for slow connections.
// Zero dependencies, zero client JS: every page is one small server-rendered
// HTML response (~4-12KB gzipped). Replaces the React claude-session-dashboard
// (5 node processes, ~500MB RSS, MB-scale hydration bundle) with one process.
// Accounts are discovered at startup, not hardcoded — see discoverAccounts()
// below: every OS login under /home with a .claude or .claude-<profile> dir
// (that actually has a projects/ subdir) becomes one dashboard "account".
// Logins named agent[-*] are treated as automation identities (no tmux/
// "resume in terminal" affordance — this dashboard only drives ONE tmux
// server, see TMUX_USER: the first non-agent login found).
// Routes: /            the fleet (live tmux sessions)
//         /history /system /device /agents   the other tabs; /s/<a>/<sid> a transcript (newest page first)
//                      all of them the cockpit shell (--ui=next, the default); --ui=legacy serves the server-rendered pages of legacy.mjs instead
//         /next /next/*  301 to the same path without the prefix (--ui=legacy: the shell stays mounted there, for comparison)
//         /ui /ui/*    301 into the shell's /agents routes (--ui=legacy: the old client-rendered app, /ui/assets/* from ./app/)
//         /healthz     index stats
//         /manifest.webmanifest /sw.js /icon-*.png   PWA (installable app)
//         /api/*       JSON for the app (and /api/push/*) · /stream  one multiplexed SSE per tab
// ponytail: the server-rendered routes above have no client JS by design —
// pagination/filtering are plain links, so they work identically on 2G, with
// JS disabled, and in text browsers. (Sole exception: a one-line service-worker
// registration; pure enhancement.) Their app-shell feel comes from the platform,
// not a framework: CSS view transitions pin the tab bar across navigations, a
// speculationrules block prerenders dashboard links on hover/touch (never /term*,
// ?fresh=1, ?reclaim=1 — those have side effects, and never /ui*, which owns its
// own navigation), bfcache makes back/forward instant (no-cache, never no-store).
//
// /ui IS client-rendered, and that is the one place the "zero client JS" rule above
// does not hold (2026-09-16). It exists because a streaming chat transcript and a
// live run list are state a page reload destroys. It is still zero-DEPENDENCY: four
// vendored ESM modules under ./app/vendor/ pinned by SHA256SUMS, no npm install, no
// bundler, no build step.
//
// TWO CEILINGS, and it takes both to cover the client. This used to read "preflight caps the
// whole client at 76,800 B gzipped", which was not true and overstated by a third (final
// review, M2):
//   preflight.sh 5b   every .mjs/.css under ./app/, gzip -9, summed   <= 76,800 B
//   e2e-infra.sh      the SERVED GET /ui document, gzipped            <= 20,480 B
// The second exists because 5b is a static file gate and cannot see the shell, which inlines
// the whole CSS constant below -- the SERVER-RENDERED dashboard's entire stylesheet, fleet rows
// and history and terminal included, of which /ui uses a fraction. That is a third again on top
// of the gated total, it is re-sent in full on every hard load (the shell is no-cache and its
// nonce changes per response, so it can never 304), and it grows every time somebody styles an
// unrelated server-rendered page -- the one direction D3 exists to police, and the one the
// static gate is blind to. Splitting the CSS is the real fix and is not this branch's; until
// then the served document is measured rather than assumed.
// DEPLOY NOTE: this file is boot + dispatcher + the --ui flag and nothing else (cockpit phase 03, K-27). It imports, at load:
//   core.mjs        accounts, the session index, tmux fleet, usage and host numbers, transcript parse, send() -- no markup
//   sse.mjs         /events and /stream, the chat replay buffer
//   routes/*.mjs    api (JSON), actions (POST + 303), agents, device, md, documents (the shell, manifest, icons, service worker)
//   legacy.mjs      the inline server-rendered dashboard: page(), pageChrome(), CSS, FLEET_JS and every *View (K-21, K-31)
//   static.mjs, chat-stream.mjs, capability.mjs
// and serves ./app/ and ./dist/ (the /next shell's build) at runtime -- install all of them together (scripts/deploy-dashboard.sh does)
// or the unit will not start (missing sibling) or /ui will answer 200 with a blank page (missing app/). HTML and CSS live in
// legacy.mjs and routes/documents.mjs only. See "Deploying this change" in docs/architecture.md.
import http from 'node:http';
import { assetView, swView } from './static.mjs';
import { BIG, HOST, PORT, SESSION_PATH_RE, THEME_MAP, args, classifyFleet, counts, crc32, flag, freshen, index, lastScan, loadSession, readSettings, scan, send, titleOf, usage } from './core.mjs';
import { chatBroadcast, chatEnd, eventsView, sseClients, startPushWatch, streamView } from './sse.mjs';
import { apiView } from './routes/api.mjs';
import { FLEET_JS, agentDetailView, agentRunView, agentsView, detailView, deviceView, errorPage, homeView, listView, loadUiAssets, mdHtml, notFoundPage, systemView, uiAssetView, uiTwinPath, uiView } from './legacy.mjs';
import { NEXT_BASE, TOUCHTEST, appView, hostAcct, iconPNG, liveJson, manifest, nextView } from './routes/documents.mjs';
import { agentAction, webhookView } from './routes/agents.mjs';
import { action, delSession, reclaimAction, restartAll, shotUpload, switchAction, termThemeAction } from './routes/actions.mjs';
import { droidAction, watchAction } from './routes/device.mjs';
import { mdView } from './routes/md.mjs';

// --ui=next|legacy (ARCHITECTURE section 10, K-21; the rollback is this flag, not a second mount): which document answers `/` and the
// tab routes. `next` is the cockpit shell and the default since the cutover (phase 05); `legacy` is the old server-rendered dashboard
// (legacy.mjs), one flag and a restart away until Stage 8 step 4 deletes it. Anything else is refused at boot, so a typo cannot silently roll back.
const UI = (args.find(a => a.startsWith('--ui=')) || '').slice(5) || flag('--ui', 'next');
if (UI !== 'legacy' && UI !== 'next') { console.error(`lite: --ui is legacy or next, not "${UI}"`); process.exit(2); }
// the routes the shell owns when it answers at `/` (web/main.mjs routes, MAP 3.2)
const SHELL_RE = /^\/(grid|history|system|device|agents(\/[^/]+){0,2}|s\/[^/]+\/[^/]+)?$/;

// ---------- server ----------
const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, 'http://x');
    const p = url.pathname;
    if (p === '/healthz') return send(req, res, 200,
      JSON.stringify({ ok: true, sessions: index.length, scannedAgo: Math.round((Date.now() - lastScan) / 1000), sseClients }), 'application/json');
    if (p.startsWith('/api/')) return await apiView(req, res, p.slice(5));
    // /app (below) is the persistent terminal launcher and the PWA start_url — untouched.
    if (UI === 'legacy' && p.startsWith('/ui/assets/')) return await uiAssetView(req, res, p.slice(11));
    if (p.startsWith('/assets/')) return await assetView(req, res, p.slice(8));
    // the cutover (K-28): the shell lives at `/`, so its old mount and the retired /ui client answer 301 into it, query kept
    if (UI === 'next' && (p === NEXT_BASE || p.startsWith(NEXT_BASE + '/'))) { res.writeHead(301, { location: '/' + p.slice(NEXT_BASE.length).replace(/^\/+/, '') + url.search }); return res.end(); }
    if (UI === 'next' && (p === '/ui' || p.startsWith('/ui/'))) { res.writeHead(301, { location: uiTwinPath(p) + url.search }); return res.end(); }
    if (p === NEXT_BASE || p.startsWith(NEXT_BASE + '/')) return await nextView(req, res, url, p);
    // GET ?fresh= and ?reclaim= are side-effect links of the server-rendered pages; the shell uses POST /api/usage/refresh instead
    if (UI === 'next' && req.method === 'GET' && SHELL_RE.test(p) && !['fresh', 'reclaim'].some(k => url.searchParams.has(k))) return await nextView(req, res, url, p, '');
    if (p === '/ui' || p.startsWith('/ui/')) return await uiView(req, res, p);
    if (p === '/events') return await eventsView(req, res);
    if (p === '/stream') return await streamView(req, res);
    // test-only delta injection, for scripts/stream-replay-check.mjs. Absent unless explicitly
    // enabled, so it can never be reachable on the real dashboard.
    if (process.env.MOWS_TEST_HOOKS === '1' && p === '/_test/chat') {
      const q = url.searchParams;
      chatBroadcast(q.get('agent'), Number(q.get('turn')), Number(q.get('seq')), q.get('delta'));
      res.writeHead(204); return res.end();
    }
    // The symmetric end injector. Task 7's client guard — ignore a `chatend` whose turn is
    // older than the one currently streaming — only fires when a DEAD turn's `closed:true`
    // fallback lands AFTER a newer turn has started. Racing two real chat turns to reproduce
    // that costs money and is flaky; this makes it a deterministic two-request sequence.
    // Same MOWS_TEST_HOOKS gate as above, so it is absent on the real dashboard.
    if (process.env.MOWS_TEST_HOOKS === '1' && p === '/_test/chatend') {
      const q = url.searchParams;
      const summary = {};
      if (q.get('closed')) summary.closed = true;
      if (q.get('cost_usd')) summary.cost_usd = Number(q.get('cost_usd'));
      chatEnd(q.get('agent'), Number(q.get('turn')), summary);
      res.writeHead(204); return res.end();
    }
    if (p.startsWith('/wh/')) return await webhookView(req, res, p.slice(4));
    if (p === '/agents') return await agentsView(req, res);
    if (p.startsWith('/agents/')) {
      const [name, run] = p.slice(8).split('/');
      return run ? await agentRunView(req, res, name, run) : await agentDetailView(req, res, name);
    }
    if (p.startsWith('/a/agent-')) return await agentAction(req, res, p.slice(9));
    if (p === '/fleet.js') {
      const buf = Buffer.from(FLEET_JS);
      const etag = '"' + crc32(buf).toString(16) + '"';
      if (req.headers['if-none-match'] === etag) { res.writeHead(304, { etag }); return res.end(); }
      res.writeHead(200, { 'content-type': 'text/javascript; charset=utf-8', 'cache-control': 'public, max-age=300', etag });
      return res.end(buf);
    }
    if (p === '/z') { res.writeHead(204); return res.end(); } // geometry beacon sink — the query lands in the access log
    if (p === '/shot') { // image uploads from the terminal's camera key -> disk, so claude can look at them
      if (req.method === 'POST') return await shotUpload(req, res);
      // old standalone upload page retired — the camera key in /term replaced it
      res.writeHead(302, { location: '/' }); return res.end();
    }
    if (p === '/a/del') {
      if (req.method !== 'POST') { res.writeHead(405); return res.end('POST only'); }
      return await delSession(req, res);
    }
    if (p === '/a/restartall') {
      if (req.method !== 'POST') { res.writeHead(405); return res.end('POST only'); }
      return await restartAll(req, res);
    }
    if (p === '/a/switch') {
      if (req.method !== 'POST') { res.writeHead(405); return res.end('POST only'); }
      return await switchAction(req, res);
    }
    if (p.startsWith('/a/')) {
      if (req.method !== 'POST') { res.writeHead(405); return res.end('POST only'); }
      return await action(req, res, url);
    }
    // /watch, /droid, /settings are now sections of /device (gap #3) — old
    // bookmarks/links bounce there so nothing is dropped, just moved.
    if (p === '/watch' || p === '/droid' || p === '/settings') {
      res.writeHead(302, { location: '/device' }); return res.end();
    }
    if (p === '/droid/touchtest') return send(req, res, 200, TOUCHTEST);
    if (p === '/droid/start' || p === '/droid/stop') {
      if (req.method !== 'POST') { res.writeHead(405); return res.end('POST only'); }
      return await droidAction(req, res, p);
    }
    if (p === '/watch/start' || p === '/watch/stop') {
      if (req.method !== 'POST') { res.writeHead(405); return res.end('POST only'); }
      return await watchAction(req, res, p);
    }
    if (p === '/themes.json') return send(req, res, 200, JSON.stringify(THEME_MAP), 'application/json');
    if (p === '/settings/term-theme.json') {
      const s = await readSettings();
      const name = typeof s.termTheme === 'string' ? s.termTheme : '';
      const theme = THEME_MAP[name] || null;
      return send(req, res, 200, JSON.stringify({ name, theme }), 'application/json');
    }
    if (p === '/settings/term-theme') {
      if (req.method !== 'POST') { res.writeHead(405); return res.end('POST only'); }
      return await termThemeAction(req, res);
    }
    if (p === '/sys/reclaim') {
      if (req.method !== 'POST') { res.writeHead(405); return res.end('POST only'); }
      return await reclaimAction(req, res);
    }
    if (p === '/app') return await appView(req, res, url, UI === 'next');
    if (p === '/app/live.json') return await liveJson(req, res, url);
    if (p === '/device') return await deviceView(req, res);
    if (p === '/md') return await mdView(req, res, url, UI === 'next');
    // ↻ button: force usage re-collect, then bounce back to the same page (PRG) with
    // sys=1 so the panel re-opens already showing the refresh in progress. Only /system
    // renders the system+usage panel now (moved off '/' — gap #1/#2).
    const bounceFresh = base => {
      usage(true); // runs in background — the sys=1 page auto-reloads until it lands
      url.searchParams.delete('fresh'); url.searchParams.set('sys', '1');
      res.writeHead(303, { location: base + '?' + url.searchParams }); res.end();
      return true;
    };
    if (p === '/system') {
      if (url.searchParams.get('fresh')) return bounceFresh('/system');
      return await systemView(req, res, url);
    }
    if (p === '/') {
      // Fleet Redesign §2: '/' is fleet-first now — the old filters/search/day-groups
      // list lives at /history. A request carrying any of its params redirects there
      // (with the same params) so old bookmarks/links keep working.
      if (['q', 'acct', 'd', 's', 'page'].some(k => url.searchParams.has(k))) {
        res.writeHead(302, { location: '/history' + url.search }); return res.end();
      }
      // system panel moved off '/' onto its own tab (gap #1/#2) — old ?fresh=1/?sys=1/
      // ?reclaim=1 links to it bounce to /system instead of silently doing nothing.
      if (['fresh', 'sys', 'reclaim'].some(k => url.searchParams.has(k))) {
        res.writeHead(302, { location: '/system' + url.search }); return res.end();
      }
      return await homeView(req, res, url);
    }
    if (p === '/history') {
      if (url.searchParams.get('fresh')) return bounceFresh('/history');
      return await listView(req, res, url);
    }
    if (p === '/sessions' || p === '/projects') { res.writeHead(302, { location: '/history' }); return res.end(); }
    const m = p.match(SESSION_PATH_RE);
    if (m) return await detailView(req, res, m[1], m[2]);
    if (p === '/manifest.webmanifest') return manifest(req, res);
    if (p === '/sw.js') return await swView(req, res);
    const isz = { '/icon-192.png': 192, '/icon-512.png': 512, '/apple-touch-icon.png': 180,
                  '/favicon.png': 48, '/favicon.ico': 48 }[p];
    if (isz) {
      const a = hostAcct(req);
      const buf = iconPNG(isz, (a && a.color) || '#00d492');
      res.writeHead(200, { 'content-type': 'image/png', 'content-length': buf.length,
        'cache-control': 'public, max-age=86400' });
      return res.end(buf);
    }
    send(req, res, 404, notFoundPage());
  } catch (err) {
    try { send(req, res, 500, errorPage(err.message)); } catch {}
  }
});


if (args.includes('--selftest')) {
  await scan();
  console.log(`index: ${index.length} sessions`, counts);
  if (!index.length) { console.error('FAIL: empty index'); process.exit(1); }
  const first = index[0]; // index is sorted newest-first across every discovered account
  const t = await titleOf(first);
  console.log('newest:', first.a, first.sid.slice(0, 8), JSON.stringify(t.title.slice(0, 60)));
  const s = await loadSession(index.filter(e => e.sz < BIG)[0]);
  if (!s.msgs.length) { console.error('FAIL: no msgs parsed'); process.exit(1); }
  console.log(`parsed ${s.msgs.length} items OK`);

  // fleet classifier check (Fleet Redesign §5 gate): fixture pane-tails + mtimes ->
  // expected state, run through the real classifyFleet() — not a copy of its logic.
  const now = Date.now();
  const FLEET_FIXTURES = [
    { name: 'working: esc-to-interrupt hint in pane', tail: 'Bash(npm test) (esc to interrupt)', mt: now - 500000, paused: false, want: 'working' },
    { name: 'working: fresh transcript write, no clear pane signal', tail: '⚙ Bash(npm test)…', mt: now - 2000, paused: false, want: 'working' },
    { name: 'needs-you: permission dialog', tail: 'Do you want to proceed?\n❯ 1. Yes\n  2. No', mt: now - 500000, paused: false, want: 'needs-you' },
    { name: 'needs-you: idle prompt, transcript finished 2m ago', tail: '│ >                          │\n? for shortcuts', mt: now - 120000, paused: false, want: 'needs-you' },
    { name: 'paused wins over a pending dialog', tail: 'Do you want to proceed?', mt: now - 1000, paused: true, want: 'paused' },
    { name: 'idle: quiet pane, transcript over an hour cold', tail: '│ >                          │\n? for shortcuts', mt: now - 3600000, paused: false, want: 'idle' },
    { name: 'idle: no transcript match at all (pane signals only)', tail: '$ ', mt: 0, paused: false, want: 'idle' },
    { name: 'idle: resumed just now (transcript touched by bookkeeping), last turn an hour cold', tail: '❯ \n  ⏵⏵ auto mode on (shift+tab to cycle)', mt: now - 60000, turn: now - 3600000, paused: false, want: 'idle' },
    { name: 'working: background /workflows monitor overlay, no esc-to-interrupt text', tail: '✻ Waiting for 1 dynamic workflow to finish\n↑↓ select · x stop workflow · p pause · esc back · s save', mt: 0, paused: false, want: 'working' },
  ];
  let fleetFail = 0;
  for (const fx of FLEET_FIXTURES) {
    const got = classifyFleet(fx);
    if (got !== fx.want) { console.error(`FAIL: fleet classify "${fx.name}": want ${fx.want}, got ${got}`); fleetFail++; }
  }
  if (fleetFail) { console.error(`FAIL: ${fleetFail}/${FLEET_FIXTURES.length} fleet classifier fixture(s) failed`); process.exit(1); }

  // /md renderer smoke: one fixture exercising every block type through the real mdHtml()
  const mdOut = mdHtml('# T\n\n- [x] done\n- item <b>\n\n```js\nconst a = 1 < 2;\n```\n\n| a | b |\n|---|---|\n| 1 | 2 |\n\n> q **b** [l](https://x/) [j](javascript:alert(1))');
  for (const frag of ['<h1>T</h1>', ' checked>', '<li>item &lt;b&gt;</li>', '1 &lt; 2', '<td>2</td>',
                      '<blockquote>', '<strong>b</strong>', '<a href="https://x/">l</a>', '<a href="#">j</a>'])
    if (!mdOut.includes(frag)) { console.error(`FAIL: md renderer missing ${JSON.stringify(frag)} in ${JSON.stringify(mdOut)}`); process.exit(1); }
  console.log('md renderer: OK');
  console.log(`fleet classifier: ${FLEET_FIXTURES.length} fixtures OK — selftest PASS`);
  process.exit(0);
}

await scan().catch(e => console.error('initial scan:', e.message));

// Before listen(), not lazily on first /ui hit: cssText() resolves the @font-face urls out of
// this map synchronously, and every server-rendered page needs them too — not just /ui.
await loadUiAssets();

setInterval(freshen, 30000).unref();
startPushWatch();

server.listen(PORT, HOST, () => console.log(`lite dashboard on http://${HOST}:${PORT} — ${index.length} sessions`));
