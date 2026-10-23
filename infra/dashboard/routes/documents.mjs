import { promises as fsp } from 'node:fs';
import { deflateSync } from 'node:zlib';
import path from 'node:path';
import os from 'node:os';
import { randomBytes } from 'node:crypto';
import { assetUrl } from '../static.mjs';
import { BY_ID, HOST_ACCT, SESSION_PATH_RE, TMUX_HOME, crc32, fleetState, freshen, index, send, sh, termHref, tmuxLive, uiCsp, userCmd } from '../core.mjs';
import { fleetEventPayload } from '../sse.mjs';
import { agentsIndex } from './agents.mjs';
import { devicePage, historyPage, sessionPage, systemPage } from './api.mjs';
import { DOC_META, footerHtml, pageChrome } from '../legacy.mjs';


// ---------- /droid/touchtest: on-device touch diagnostic (iOS debugging) ----------
export const TOUCHTEST = `<!doctype html><html><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">
<meta name="color-scheme" content="dark"><title>touch test</title><style>
body{margin:0;background:#0a0a0a;color:#e4e4e7;font:13px/1.45 ui-monospace,Menlo,monospace;padding:10px}
h1{font-size:15px;margin:0 0 8px}b{color:#34d399}
.pad{width:100%;height:150px;border:2px solid #3f3f46;border-radius:8px;background:#18181b;display:block;margin:6px 0}
#a{touch-action:none}
pre{white-space:pre-wrap;word-break:break-all;background:#18181b;border:1px solid #27272a;border-radius:8px;padding:8px;font-size:12px;margin:6px 0}
</style></head><body>
<h1>touch diagnostic</h1>
<pre id="env"></pre>
<div><b>A</b> — touch-action:none (the fix)</div><canvas id="a" class="pad"></canvas>
<div><b>B</b> — no touch-action (old behaviour)</div><canvas id="b" class="pad"></canvas>
<pre id="log">tap and drag inside A, then B</pre>
<script>
var E=document.getElementById('env'),L=document.getElementById('log'),lines=[];
var vv=window.visualViewport||{};
E.textContent='viewport '+innerWidth+'x'+innerHeight+' dpr '+devicePixelRatio
 +'\\nvisual '+Math.round(vv.width||0)+'x'+Math.round(vv.height||0)+' scale '+(vv.scale||'?')
 +'\\nTouchEvent '+(typeof window.TouchEvent)+' maxTouchPoints '+navigator.maxTouchPoints
 +'\\n'+navigator.userAgent;
function hook(c,name){
  ['touchstart','touchmove','touchend','touchcancel'].forEach(function(t){
    c.addEventListener(t,function(e){
      var x=e.changedTouches[0]||{},r=c.getBoundingClientRect();
      if(e.cancelable)e.preventDefault();
      lines.unshift(name+' '+t+' force='+x.force+' at '+Math.round(x.clientX-r.left)+','
        +Math.round(x.clientY-r.top)+' cancelable='+e.cancelable+' prevented='+e.defaultPrevented
        +' targetOk='+(x.target===c));
      lines=lines.slice(0,10);L.textContent=lines.join('\\n');
    },{passive:false});
  });
}
hook(document.getElementById('a'),'A');hook(document.getElementById('b'),'B');
</script></body></html>`;

// initial session S: ?s= if live, else the last one web-term.sh marked if live, else the
// first live session; else '' (no attach — ttyd shows web-term.sh's own menu).
async function initialSession(url, live, liveNames) {
  const req = url.searchParams.get('s') || '';
  if (liveNames.has(req)) return req;
  let last = '';
  try { last = (await fsp.readFile(path.join(TMUX_HOME, '.cache', 'webterm-last'), 'utf8')).trim(); } catch {}
  if (liveNames.has(last)) return last;
  return (live[0] || {}).name || '';
}

// `home` (lite.mjs passes --ui=next): a bare /app, which is what the installed app launches, opens the cockpit home — owner decision
// 2026-10-11 (ledger O-5): the fleet first, the terminal one tap away. `?s=` / `?open=` and --ui=legacy keep landing in the terminal,
// so every existing link and the rollback flag behave as before; the manifest stays byte-identical (K-20).
export async function appView(req, res, url, home = false) {
  const live = await tmuxLive();
  const openSid = url.searchParams.get('open') || '';
  let to;
  if (/^[0-9a-f]{8}$/.test(openSid)) to = termHref('open', openSid);
  else if (home && !url.searchParams.has('s')) to = '/';
  else { const s = await initialSession(url, live, new Set(live.map(l => l.name))); to = s ? termHref('attach', s) : '/term/?v=3'; }
  res.writeHead(302, { location: to, 'cache-control': 'no-store' }); res.end();
}

// GET /app/live.json?tab= (§2): the session strip this tab's poll refreshes itself with; `state` is the fleet's (working, needs-you, paused, idle).
export async function liveJson(req, res, url) {
  const tab = url.searchParams.get('tab') || '';
  // no-store, not send()'s usual no-cache: this must never be revalidated, only re-fetched
  if (!/^[0-9a-f]{8}$/.test(tab)) {
    res.writeHead(400, { 'content-type': 'application/json', 'cache-control': 'no-store' });
    return res.end(JSON.stringify({ err: 'bad tab' }));
  }
  const [live, fleet] = await Promise.all([tmuxLive(), fleetState()]);
  const state = new Map(fleet.map(f => [f.name, f.state]));
  let tty = '';
  try { tty = (await fsp.readFile(path.join(TMUX_HOME, '.cache', 'webterm-clients', tab), 'utf8')).trim(); } catch {}
  let cur = '';
  if (tty) {
    const out = await sh(...userCmd(['tmux', 'list-clients', '-F', '#{client_tty}\t#{session_name}']));
    for (const l of out.trim().split('\n')) { const [t, n] = l.split('\t'); if (t === tty) { cur = n; break; } }
  }
  const buf = Buffer.from(JSON.stringify(live.map(l => ({ name: l.name, label: l.label || '', current: l.name === cur, state: state.get(l.name) || 'idle' }))));
  res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store', 'content-length': buf.length });
  res.end(buf);
}

function pngChunk(type, data) {
  const b = Buffer.alloc(12 + data.length);
  b.writeUInt32BE(data.length, 0); b.write(type, 4); data.copy(b, 8);
  b.writeUInt32BE(crc32(b.subarray(4, 8 + data.length)), 8 + data.length);
  return b;
}

const hexRGB = c => [1, 3, 5].map(i => parseInt(c.slice(i, i + 2), 16));

function segD(px, py, ax, ay, bx, by) { // point→segment distance (chevron strokes)
  const dx = bx - ax, dy = by - ay;
  const t = Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / (dx * dx + dy * dy)));
  return Math.hypot(ax + t * dx - px, ay + t * dy - py);
}

const iconCache = new Map(); // `${size}${color}` -> png Buffer (a few KB each)
export function iconPNG(size, color) {
  const key = size + color;
  if (iconCache.has(key)) return iconCache.get(key);
  const bg = hexRGB('#09090b'), fg = hexRGB(color), W = 0.052;
  const cov = (u, v) => // >_ glyph, inside the maskable safe zone (inner 60%)
    segD(u, v, 0.30, 0.33, 0.485, 0.50) < W || segD(u, v, 0.30, 0.67, 0.485, 0.50) < W ||
    (u >= 0.56 && u <= 0.78 && v >= 0.635 && v <= 0.715) ? 1 : 0;
  const rows = [], row = Buffer.alloc(1 + size * 3);
  for (let y = 0; y < size; y++) {
    row[0] = 0; // filter: none
    for (let x = 0; x < size; x++) {
      let a = 0; // 3x3 supersample so the diagonals don't stair-step
      for (let sy = 0; sy < 3; sy++) for (let sx = 0; sx < 3; sx++)
        a += cov((x + (sx + 0.5) / 3) / size, (y + (sy + 0.5) / 3) / size);
      a /= 9;
      for (let c = 0; c < 3; c++) row[1 + x * 3 + c] = Math.round(bg[c] + (fg[c] - bg[c]) * a);
    }
    rows.push(Buffer.from(row));
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0); ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; ihdr[9] = 2; // 8-bit RGB
  const png = Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    pngChunk('IHDR', ihdr), pngChunk('IDAT', deflateSync(Buffer.concat(rows))),
    pngChunk('IEND', Buffer.alloc(0))]);
  iconCache.set(key, png);
  return png;
}

export const hostAcct = req => BY_ID[HOST_ACCT[(req.headers.host || '').split('.')[0]]] || null;

export function manifest(req, res) {
  const a = hostAcct(req);
  send(req, res, 200, JSON.stringify({
    id: '/', name: a ? `mows · ${a.label}` : 'mows sessions',
    short_name: a ? a.label : 'mows',
    start_url: '/app', scope: '/', display: 'standalone',
    background_color: '#09090b', theme_color: '#09090b',
    description: 'mows harness: agent sessions, web terminal, QA watch, android console',
    icons: [
      { src: '/icon-192.png', sizes: '192x192', type: 'image/png' },
      { src: '/icon-512.png', sizes: '512x512', type: 'image/png' },
      { src: '/icon-512.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' }],
  }), 'application/manifest+json');
}

// ---------- /next: the cockpit shell (cockpit phase 01) ----------
// One document for every route of the UI: `/` since the cutover (phase 05); --ui=legacy keeps it mounted at /next beside the old pages. The chrome is the
// SAME pageChrome() markup as every other page (hrefs prefixed with NEXT_BASE); the view, the tab state and the stream are the
// client's (web/main.mjs, web/store.mjs, built into dist/ and served by static.mjs). The first paint carries data (K-07): the
// BootSnapshot for the route is inlined, so LCP needs no fetch and no SSE round trip.
export const NEXT_BASE = '/next';

const agentItem = a => ({ name: a.name, state: a.last?.state ?? null, last_event_at: a.last?.last_event_at ?? null, total: a.total, cost7d: a.cost7d });

async function nextBoot(req, url, route) {
  freshen();
  const fleet = fleetEventPayload(await fleetState());
  const host = req.headers.host || '';
  const boot = { route, fleet, live: fleet.length, indexed: index.length, host: host || os.hostname() };
  if (route.startsWith('/agents')) boot.agents = (await agentsIndex()).map(agentItem);
  if (route === '/history') boot.history = await historyPage(url, host);
  if (route === '/system') boot.system = await systemPage(url);
  if (route === '/device') boot.device = await devicePage(url.searchParams.get('dv'));
  const s = SESSION_PATH_RE.exec(route);
  if (s) boot.session = await sessionPage(s[1], s[2], url.searchParams.get('page')).catch(() => null);
  return boot;
}

// base is NEXT_BASE while --ui=legacy owns `/`, and '' when the shell answers there (the default)
export async function nextView(req, res, url, p, base = NEXT_BASE) {
  const route = p.slice(base.length).replace(/\/+$/, '') || '/';
  const boot = await nextBoot(req, url, route);
  const nonce = randomBytes(16).toString('base64url');
  const tab = route === '/' ? 'sessions' : (/^\/(grid|history|system|device|agents)(\/|$)/.exec(route) || [])[1] || '';
  const { hdr, tabs, termFab } = pageChrome(tab, boot.live, boot.host, base + '/agents', base);
  const asset = (stem, ext) => assetUrl(stem, ext) || '/assets/missing-build';
  // '</' and U+2028/9 cannot end the JSON data block early, whatever a session label or snippet holds
  const json = JSON.stringify(boot).replace(/</g, '\\u003c').replace(/\u2028/g, '\\u2028').replace(/\u2029/g, '\\u2029');
  send(req, res, 200, `<!doctype html><html lang="en" data-base="${base}"><head><meta charset="utf-8">
${DOC_META}
<link rel="stylesheet" href="${asset('tokens', 'css')}">
<title>mows control</title></head><body>${hdr}${termFab}
<div id="app"></div>
${tabs}${footerHtml()}
<script type="application/json" id="boot" nonce="${nonce}">${json}</script>
<script type="module" nonce="${nonce}" src="${asset('main', 'mjs')}"></script>
</body></html>`, 'text/html; charset=utf-8', { 'content-security-policy': uiCsp(nonce, "'self' ", true) });
}
