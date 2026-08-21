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
// Routes: /            paginated session list (filter: acct, q, page)
//         /s/<a>/<sid> paginated transcript (newest page first)
//         /healthz     index stats
//         /manifest.webmanifest /sw.js /icon-*.png   PWA (installable app)
// ponytail: no client JS by design — pagination/filtering are plain links, so
// the app works identically on 2G, with JS disabled, and in text browsers.
// (sole exception: a one-line service-worker registration; pure enhancement.)
import http from 'node:http';
import { promises as fsp, readdirSync, existsSync, readFileSync, statfsSync } from 'node:fs';
import { execFile } from 'node:child_process';
import { gzipSync, deflateSync } from 'node:zlib';
import path from 'node:path';
import net from 'node:net';
import os from 'node:os';

// ---------- same-origin guard for mutating POST routes (action/delSession/watchAction) ----------
function sameOrigin(req, host) {           // exact host match; substring checks are bypassable
  const o = req.headers.origin || req.headers.referer || '';
  if (!o) return true;                     // non-browser client: no Origin/Referer to compare (cookie auth still required upstream)
  try { return new URL(o).host === host; } catch { return false; }
}

const PALETTE = ['#58a6ff', '#bc8cff', '#f0883e', '#39c5cf', '#ff7b72', '#7aa2f7', '#9ece6a', '#e0af68'];
// One dashboard "account" = one Claude profile dir under one OS login: the
// login's default `.claude` plus any sibling `.claude-<suffix>` (e.g. a "work"
// profile) — siblings share the same OS login and, for humans, the same tmux
// server. Only directories that actually look like a Claude home (they have a
// projects/ subdir — the thing scanAcct() below reads) count: this box also has
// unrelated `.claude-*` dotfiles/dirs (a credentials file, a template cache, the
// claude-mem plugin's store) that must NOT show up as bogus extra accounts.
function scanLogin(base, user, out, seen) {
  const m = /^agent(?:-(.+))?$/.exec(user); // "agent" or "agent-<name>" = bot identity
  const agent = !!m, label = agent ? (m[1] || user) : user;
  const add = (id, lbl, dir) => {
    if (seen.has(dir) || !existsSync(path.join(dir, 'projects'))) return;
    seen.add(dir);
    out.push({ id, label: lbl, home: dir, user, agent });
  };
  add(user, label, path.join(base, '.claude'));
  let entries = [];
  try { entries = readdirSync(base); } catch {} // unreadable/missing base: no profiles from it
  for (const d of entries) {
    if (!d.startsWith('.claude-')) continue;
    const suffix = d.slice('.claude-'.length);
    add(`${user}-${suffix}`, `${label}/${suffix}`, path.join(base, d));
  }
}
function discoverAccounts() {
  const out = [], seen = new Set();
  if (existsSync('/home')) for (const u of readdirSync('/home')) scanLogin(`/home/${u}`, u, out, seen);
  // also scan the invoking user's own $HOME directly: root's home is /root,
  // NOT under /home, so the loop above can never see it by itself — yet this
  // dashboard runs AS root (see the service template) and root can have (and,
  // on a box with root-run automation, does have) its own real Claude
  // sessions. Same branch defensively covers any other layout where $HOME
  // isn't under /home at all (e.g. run by hand for local testing).
  const home = process.env.HOME;
  if (home && path.dirname(home) !== '/home') scanLogin(home, path.basename(home), out, seen);
  out.sort((a, b) => (a.agent !== b.agent ? (a.agent ? 1 : -1) : a.id.localeCompare(b.id)));
  const tmuxUser = (out.find(a => !a.agent) || {}).user;
  return out.map((a, i) => ({ ...a, color: PALETTE[i % PALETTE.length], term: !a.agent && a.user === tmuxUser }));
}
const ACCTS = discoverAccounts();
const BY_ID = Object.fromEntries(ACCTS.map(a => [a.id, a]));
// subdomain -> default account filter (legacy per-account hosts): each login's
// BASE (non-suffixed) profile, keyed by its short label — derived from ACCTS,
// not listed literally.
const HOST_ACCT = Object.fromEntries(ACCTS.filter(a => a.id === a.user).map(a => [a.label, a.id]));
// the one tmux server this dashboard drives (see scanLogin above): only its
// account(s) get the "resume in terminal" / pause / kill / attach affordances.
const TMUX_USER = (ACCTS.find(a => a.term) || {}).user || os.userInfo().username;
const TERM_IDS = new Set(ACCTS.filter(a => a.term).map(a => a.id));
// dynamic alternation for the /s/<id>/<sid> route — was a literal id list
const ACCT_ID_ALT = ACCTS.map(a => a.id.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|');
const SESSION_PATH_RE = new RegExp(`^/s/(${ACCT_ID_ALT})/([0-9a-f-]{8,64})$`);
const PAGE = 20, MSG_PAGE = 25;
const args = process.argv.slice(2);
const flag = (n, d) => { const i = args.indexOf(n); return i >= 0 ? args[i + 1] : d; };
const PORT = +flag('--port', 3005), HOST = flag('--host', '127.0.0.1');
// >_ resume affordance only for sessions active in the last N days (live tmux
// sessions always keep attach). Old transcripts stay browsable — just not
// one-tap resumable, so a stale context can't be retaken by accident.
const RESUME_DAYS = +flag('--resume-days', 7);
const canResume = (mt, live) => live || Date.now() - mt < RESUME_DAYS * 864e5;

// ---------- session index (in-memory, rebuilt in background) ----------
let index = [];            // [{a, sid, path, mt, sz, proj}] sorted by mt desc
let counts = {};           // account id -> n
let lastScan = 0, scanning = null;

async function scanAcct(acct) {
  const out = [], root = path.join(acct.home, 'projects');
  let dirs = [];
  try { dirs = await fsp.readdir(root, { withFileTypes: true }); } catch { return out; }
  for (const d of dirs) {
    if (!d.isDirectory()) continue;
    if (d.name.endsWith('-observer-sessions')) continue; // claude-mem observer agent, not working sessions
    const pdir = path.join(root, d.name);
    let files = [];
    try { files = await fsp.readdir(pdir); } catch { continue; }
    const jsonl = files.filter(f => f.endsWith('.jsonl'));
    const stats = await Promise.all(jsonl.map(f =>
      fsp.stat(path.join(pdir, f)).catch(() => null)));
    for (let i = 0; i < jsonl.length; i++) {
      const st = stats[i];
      if (!st || !st.size) continue;
      out.push({ a: acct.id, sid: jsonl[i].slice(0, -6), path: path.join(pdir, jsonl[i]),
                 mt: st.mtimeMs, sz: st.size, proj: d.name });
    }
  }
  return out;
}
async function scan() {
  const per = await Promise.all(ACCTS.map(scanAcct));
  const all = per.flat().sort((x, y) => y.mt - x.mt);
  counts = {}; for (const a of ACCTS) counts[a.id] = 0;
  for (const e of all) counts[e.a]++;
  index = all; lastScan = Date.now();
}
function freshen() { // serve stale, refresh in background
  if (Date.now() - lastScan > 15000 && !scanning)
    scanning = scan().catch(() => {}).finally(() => { scanning = null; });
}

// ---------- per-session title probe (first 64KB, cached by mtime) ----------
const titleCache = new Map(); // path -> {mt, title, ts}
async function titleOf(e) {
  const hit = titleCache.get(e.path);
  if (hit && hit.mt === e.mt) return hit;
  let title = '', ts = '';
  try {
    const fh = await fsp.open(e.path, 'r');
    const buf = Buffer.alloc(65536);
    const { bytesRead } = await fh.read(buf, 0, 65536, 0);
    await fh.close();
    const text = buf.toString('utf8', 0, bytesRead);
    const mts = text.match(/"timestamp":"([^"]+)"/); if (mts) ts = mts[1];
    for (const line of text.split('\n').slice(0, 40)) {
      try {
        const j = JSON.parse(line);
        if (j.type === 'summary' && j.summary) { title = j.summary; break; }
        if (j.type === 'user' && j.message) {
          const c = j.message.content;
          const t = typeof c === 'string' ? c
            : Array.isArray(c) ? (c.find(x => x.type === 'text') || {}).text : '';
          if (t && !t.startsWith('<')) { title = t; break; } // skip command/meta xml
        }
      } catch { // giant or cut first line: regex salvage
        const m = line.match(/"summary":"([^"\\]{4,150})/); if (m) { title = m[1]; break; }
      }
    }
  } catch {}
  title = title.replace(/\s+/g, ' ').trim().slice(0, 120);
  const v = { mt: e.mt, title, ts };
  if (titleCache.size > 4000) titleCache.clear();
  titleCache.set(e.path, v);
  return v;
}

// ---------- live tmux sessions (TMUX_USER's server) ----------
let tmuxCache = { t: 0, list: [] };
// 5s: the runuser+PAM+tmux chain can exceed 2s cold on this 2-core box right
// after a restart (seen 2026-07-07 under the sandbox rollout) — a timeout here
// silently blanks the live panel for 3s (cache), so keep headroom.
const sh = (cmd, args) => new Promise(r => execFile(cmd, args, { timeout: 5000 }, (e, out) => r(e ? '' : out)));
async function tmuxLive() {
  if (Date.now() - tmuxCache.t < 3000) return tmuxCache.list;
  const out = await sh('runuser', ['-u', TMUX_USER, '--', 'tmux', 'list-panes', '-a', '-F',
    '#{session_name}\t#{?session_attached,1,0}\t#{session_created}\t#{pane_pid}\t#{pane_current_path}']);
  const list = [];
  for (const l of out.trim().split('\n').filter(Boolean)) {
    const [name, att, created, pid, cwd] = l.split('\t');
    if (list.some(x => x.name === name)) continue; // first pane per session
    list.push({ name, attached: att === '1', created: +created * 1000, pid: +pid, cwd, paused: false });
  }
  if (list.length) { // paused = the leader's descendants (claude) are in state T
    const st = await sh('ps', ['-eo', 'pid=,ppid=,stat=']);
    const rows = st.trim().split('\n').map(l => l.trim().split(/\s+/));
    const kids = new Map(); // ppid -> [{pid,stat}]
    const stat = new Map();
    for (const [pid, ppid, s] of rows) { stat.set(+pid, s); (kids.get(+ppid) || kids.set(+ppid, []).get(+ppid)).push(+pid); }
    for (const x of list) { // any descendant stopped => paused
      const stack = [x.pid]; let paused = false;
      while (stack.length && !paused) for (const c of kids.get(stack.pop()) || []) {
        if (/T/.test(stat.get(c) || '')) { paused = true; break; }
        stack.push(c);
      }
      x.paused = paused;
    }
  }
  tmuxCache = { t: Date.now(), list };
  return list;
}

// ---------- session actions (kill / pause / resume a live tmux session) ----------
// pause = SIGSTOP every process BELOW the pane leader (claude + its node/MCP kids),
// never the leader itself: tmux babysits its pane leader and auto-SIGCONTs it, so
// signalling the leader is futile — but it leaves the leader's descendants alone.
// (root-caused 2026-07-07: bare-command panes couldn't be paused for this reason.)
// 64, not 40: cc-<profile>-<slug> already reaches ~40 for a long project directory, and
// cc's second-session suffix (-2, -3 …) pushes it over — a rejected name here means
// pause/kill answer 400 for exactly those sessions. Only the length moved; the character
// class is the guard, and the name is matched against the live session list below anyway.
const NAME_RE = /^[\w.:@-]{1,64}$/;
async function descendants(root) {
  const out = await sh('ps', ['-eo', 'pid=,ppid=']);
  const kids = new Map();
  for (const l of out.trim().split('\n')) {
    const [pid, ppid] = l.trim().split(/\s+/).map(Number);
    if (!kids.has(ppid)) kids.set(ppid, []);
    kids.get(ppid).push(pid);
  }
  const acc = [], stack = [root];
  while (stack.length) for (const c of kids.get(stack.pop()) || []) { acc.push(c); stack.push(c); }
  return acc; // excludes root
}
async function readBody(req) {
  let s = '';
  for await (const c of req) { s += c; if (s.length > 4096) break; }
  return Object.fromEntries(new URLSearchParams(s));
}
async function action(req, res, url) {
  // same-origin guard (oauth2 cookie is SameSite anyway; belt + suspenders — exact host match, substring checks are bypassable)
  const host = req.headers.host || '';
  if (!sameOrigin(req, host)) { res.writeHead(403); return res.end('bad origin'); }
  const b = await readBody(req);
  const name = b.name || '';
  const bk = b.back || '/'; // local paths only — "//host" is a protocol-relative redirect
  const back = bk.startsWith('/') && !bk.startsWith('//') ? bk : '/';
  if (!NAME_RE.test(name)) { res.writeHead(400); return res.end('bad name'); }
  tmuxCache.t = 0;
  const t = (await tmuxLive()).find(x => x.name === name);
  if (!t) { res.writeHead(404); return res.end('not live'); }
  const act = url.pathname.slice(3);
  if (act === 'kill') {
    await sh('runuser', ['-u', TMUX_USER, '--', 'tmux', 'kill-session', '-t', '=' + name]);
  } else if (act === 'pause' || act === 'resume') {
    const sig = act === 'pause' ? '-STOP' : '-CONT';
    const kids = await descendants(t.pid);
    if (kids.length) await sh('kill', [sig, '--', ...kids.map(String)]);
  } else { res.writeHead(404); return res.end(); }
  tmuxCache.t = 0;
  res.writeHead(303, { location: back }); res.end();
}

// ---------- delete one session transcript (list-row ✕, confirmed via <details>) ----------
async function delSession(req, res) {
  const host = req.headers.host || '';
  if (!sameOrigin(req, host)) { res.writeHead(403); return res.end('bad origin'); }
  const b = await readBody(req);
  const bk = b.back || '/';
  const back = bk.startsWith('/') && !bk.startsWith('//') ? bk : '/';
  const a = b.a || '', sid = b.sid || '';
  if (!BY_ID[a] || !/^[0-9a-f-]{8,64}$/.test(sid)) { res.writeHead(400); return res.end('bad id'); }
  const e = index.find(x => x.a === a && x.sid === sid);
  if (!e) { res.writeHead(404); return res.end('not found'); }
  if ((await tmuxLive()).some(l => l.name === 'web-' + sid.slice(0, 8))) {
    res.writeHead(409); return res.end('session is live — kill it first');
  }
  try { await fsp.unlink(e.path); } catch {}
  index = index.filter(x => x !== e);
  counts[a] = Math.max(0, (counts[a] || 1) - 1);
  titleCache.delete(e.path); parseCache.delete(e.path);
  res.writeHead(303, { location: back }); res.end();
}

// ---------- QA watch: noVNC view of the shared headless browser ----------
// watch-browser.sh runs Xvfb :99 + x11vnc + websockify(6080) + a real Chrome
// (CDP 9222) — normally localhost-only. Caddy now proxies /vnc/* -> 6080 behind
// the same Google login, so this page embeds it: you see what the agent drives
// and can click/type to take over (do an OTP login, or eyeball a UI change).
let watchCache = { t: 0, up: false };
function probe(port) {
  return new Promise(r => {
    const s = net.connect({ host: '127.0.0.1', port, timeout: 800 }, () => { s.destroy(); r(true); });
    const no = () => { s.destroy(); r(false); };
    s.on('error', no); s.on('timeout', no);
  });
}
async function watchLive() {
  if (Date.now() - watchCache.t < 3000) return watchCache.up;
  watchCache = { t: Date.now(), up: await probe(6080) };
  return watchCache.up;
}
async function watchAction(req, res, p) {
  const host = req.headers.host || '';
  if (!sameOrigin(req, host)) { res.writeHead(403); return res.end('bad origin'); }
  await readBody(req); // drain
  // The stack is its OWN systemd unit, NOT a child of this service — so redeploying
  // or OOM-restarting the dashboard never kills a live take-over browser. start is
  // idempotent (skip if already up); stop tears the whole cgroup down (frees ~0.5G).
  const ctl = v => new Promise(r => execFile('systemctl', [v, 'claude-qa-watch.service'], { timeout: 20000 }, () => r()));
  if (p === '/watch/start') { if (!(await probe(6080))) await ctl('start'); }
  else await ctl('stop');
  watchCache.t = 0;
  res.writeHead(303, { location: '/watch' }); res.end();
}
async function watchView(req, res) {
  const up = await watchLive();
  const startStop = up
    ? `<form class="af" method="post" action="/watch/stop"><button class="ab danger">■ stop</button></form>`
    : `<form class="af" method="post" action="/watch/start"><button class="ab ok">▶ start browser</button></form>`;
  let view = '', script = '';
  if (up) {
    // path=vnc/websockify: noVNC builds its WS URL as wss://host/<path> (root-relative,
    // NOT relative to /vnc/vnc.html), so the default 'websockify' would miss the /vnc/*
    // route and hit the dashboard. Prefixing routes the socket through strip_prefix.
    // Nav toolbar drives the remote with real key-injection so mobile users skip fiddly
    // gestures: scroll=PageUp/Dn, back/fwd=Alt+Arrow, reload=F5. We reach noVNC's live RFB
    // by re-importing ui.js in the same-origin iframe (ES-module singleton → same UI.rfb);
    // ⌨ keys clicks noVNC's own keyboard button to pop the phone keyboard.
    view = `<div class="watchwrap"><iframe id="vf" class="vnc" title="QA browser (noVNC remote view)" src="/vnc/vnc.html?autoconnect=1&amp;resize=scale&amp;reconnect=1&amp;path=vnc/websockify" allow="clipboard-read;clipboard-write"></iframe>
<div class="wbar"><button class="kbd" onclick="kb()">⌨ keys</button><button onclick="pst()">📋 paste</button><button onclick="k(0xff56,'PageDown')">⬇ scroll</button><button onclick="k(0xff55,'PageUp')">⬆ scroll</button><button onclick="nav(1)">⟵ back</button><button onclick="nav(0)">fwd ⟶</button><button onclick="k(0xffc2,'F5')">↻ reload</button><button onclick="k(0xff1b,'Escape')">Esc</button></div></div>`;
    script = `<script>
function _v(){return document.getElementById('vf')}
function _w(){return _v().contentWindow||{}}
function nb(i){try{_v().contentDocument.getElementById(i).click()}catch(e){}}
function k(s,c){var r=_w().rfb;if(r)r.sendKey(s,c)}
function nav(b){var r=_w().rfb;if(!r)return;var s=b?0xff51:0xff53,c=b?'ArrowLeft':'ArrowRight';r.sendKey(0xffe9,'AltLeft',true);r.sendKey(s,c,true);r.sendKey(s,c,false);r.sendKey(0xffe9,'AltLeft',false)}
function kb(){nb('noVNC_keyboard_button');try{var i=_v().contentDocument.getElementById('noVNC_keyboardinput');if(i)i.focus()}catch(e){}}
// paste device clipboard -> remote clipboard -> Ctrl+V into the focused remote field
function pv(r,t){r.clipboardPasteFrom(t);setTimeout(function(){r.sendKey(0xffe3,'ControlLeft',true);r.sendKey(0x76,'KeyV',true);r.sendKey(0x76,'KeyV',false);r.sendKey(0xffe3,'ControlLeft',false)},90)}
function fbk(r){var m=prompt('Paste text here, then OK — I will type it into the browser:');if(m)pv(r,m)}
function pst(){var r=_w().rfb;if(!r)return;if(navigator.clipboard&&navigator.clipboard.readText){navigator.clipboard.readText().then(function(t){t?pv(r,t):fbk(r)}).catch(function(){fbk(r)})}else fbk(r)}
function _x(){try{if(_w().rfb)return;var d=_v().contentDocument;var s=d.createElement('script');s.type='module';s.textContent="import UI from './app/ui.js';window.rfb=UI.rfb;";d.body.appendChild(s)}catch(e){}}
var _t=setInterval(function(){if(_w().rfb)clearInterval(_t);else _x()},1200);
</script>`;
  } else {
    view = `<div class="wblank"><p>the QA browser isn't running.</p><p class="muted">press start, then run a QA journey in <b>watched</b> mode — the agent brings this browser up and you share it.</p></div>`;
  }
  const body = `<h1><a href="/">← sessions</a> <span class="muted">· 🖥 watch</span></h1>
<div class="bar"><span class="chip${up ? ' on' : ''}"><span class="dot" style="background:${up ? '#34d399' : '#71717a'}"></span>browser ${up ? 'live' : 'idle'}</span>${startStop}<a class="chip" href="/watch">↻ refresh</a></div>
${view}
<div class="note" style="border-color:#3f3f46;color:#a1a1aa"><b>how it works</b> · run a QA journey in <b>watched</b> mode; when the agent needs you (a login/OTP, or an eyeball on a UI change) it pauses and the browser shows up here — take over right in the frame, then tell the agent <b>continue</b> in the <a href="/term/?v=3">terminal</a>. on a phone use the buttons under the view — <b>⌨ keys</b> to type, <b>⬆ ⬇ scroll</b>, <b>⟵ back</b>, <b>↻ reload</b> — no gestures needed; rotate to <b>landscape ↔</b> for a bigger view.</div>
${script}`;
  send(req, res, 200, page('watch · qa browser', body, up ? '' : '<meta http-equiv="refresh" content="4">', up ? 'watchlive' : '', 'watch'));
}

// ---------- /droid/touchtest: on-device touch diagnostic (iOS debugging) ----------
const TOUCHTEST = `<!doctype html><html><head><meta charset="utf-8">
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
// ---------- /droid: Android emulator (redroid container + ws-scrcpy console) ----------
// Optional stack — see infra/droid/SETUP.md. With it absent this page still renders,
// reporting the emulator stopped (docker inspect on a missing container just fails).
const DROID_UDID = '127.0.0.1:6555';
async function droidState() {
  const run = (await sh('docker', ['inspect', '-f', '{{.State.Running}}', 'redroid'])).trim() === 'true';
  if (!run) return 'stopped';
  const boot = (await sh('adb', ['-s', DROID_UDID, 'shell', 'getprop', 'sys.boot_completed'])).trim();
  return boot === '1' ? 'live' : 'booting';
}
async function droidAction(req, res, p) {
  const host = req.headers.host || '';
  if (!sameOrigin(req, host)) { res.writeHead(403); return res.end('bad origin'); }
  await readBody(req); // drain
  const run = (cmd, args, t) => new Promise(r => execFile(cmd, args, { timeout: t }, () => r()));
  if (p === '/droid/start') {
    await run('docker', ['start', 'redroid'], 20000);
    await run('adb', ['connect', DROID_UDID], 5000); // put the device on the adb server so ws-scrcpy's tracker sees it
  } else {
    await run('adb', ['disconnect', DROID_UDID], 5000);
    await run('docker', ['stop', 'redroid'], 30000);
  }
  res.writeHead(303, { location: '/droid' }); res.end();
}
async function droidView(req, res) {
  const st = await droidState();
  const live = st === 'live';
  const btn = st === 'stopped'
    ? `<form class="af" method="post" action="/droid/start"><button class="ab ok">▶ start emulator</button></form>`
    : `<form class="af" method="post" action="/droid/stop"><button class="ab danger">■ stop</button></form>`;
  let view = '';
  if (live) {
    // stream via the same-origin /droidview/* proxy (Caddy strip_prefix -> ws-scrcpy :8000):
    // gauth cookie + frame-ancestors 'self' both hold, no cross-site iframe auth. tinyh264 =
    // wasm decoder, phone + desktop alike. ws endpoint rides the same proxy path (wss).
    const ws = encodeURIComponent(`wss://${req.headers.host || ''}/droidview/?action=proxy-adb&remote=${encodeURIComponent('tcp:8886')}&udid=${encodeURIComponent(DROID_UDID)}`);
    const streamUrl = `/droidview/#!action=stream&udid=${encodeURIComponent(DROID_UDID)}&player=tinyh264&fitToScreen=true&ws=${ws}`;
    // iOS/Safari ignores an IFRAME's <meta viewport>: it lays the inner document out at a
    // phantom 980px width and auto-expands the frame, so ws-scrcpy fits its canvas to a
    // viewport that isn't there and taps never line up (verified with Playwright WebKit —
    // 0 touch events in-frame, works top-level). Phones therefore get the stream full-page.
    const mobile = /iPhone|iPad|iPod|Android|Mobile|Silk/i.test(req.headers['user-agent'] || '');
    view = mobile
      ? `<a class="ab ok" style="display:block;text-align:center;padding:16px;font-size:1.05rem;text-decoration:none" href="${streamUrl}">▶ open screen (full page)</a>
<div class="note" style="border-color:#3f3f46;color:#a1a1aa">opens the device full-screen so touch maps correctly on iOS — use your browser's <b>back</b> to return here.</div>`
      : `<iframe class="vnc" title="Android emulator (redroid remote view)" style="background:#000" src="${streamUrl}"></iframe>`;
  } else if (st === 'booting') {
    view = `<div class="wblank"><p>android is booting… (~15 s)</p><p class="muted">this page refreshes itself and the screen appears here.</p></div>`;
  } else {
    view = `<div class="wblank"><p>the emulator isn't running.</p><p class="muted">press start — a containerized Android 15 (redroid) boots in ~15 s and its screen shows up here. tap, swipe and type right in the frame.</p></div>`;
  }
  const dot = live ? '#34d399' : st === 'booting' ? '#f59e0b' : '#71717a';
  const body = `<h1><a href="/">← sessions</a> <span class="muted">· 📱 android</span></h1>
<div class="bar"><span class="chip${live ? ' on' : ''}"><span class="dot" style="background:${dot}"></span>emulator ${st}</span>${btn}<a class="chip" href="/droid">↻ refresh</a><a class="chip" href="/droidview/" target="_blank" rel="noopener">⧉ console</a></div>
${view}
<div class="note" style="border-color:#3f3f46;color:#a1a1aa"><b>how it works</b> · an Android container (<b>redroid</b>, native-arch, no KVM) streams here through ws-scrcpy — interact directly in the frame; the slim toolbar inside it has power/volume/back/home and a keyboard toggle. install an apk from the <a href="/term/?v=3">terminal</a>: <b>adb -s ${DROID_UDID} install app.apk</b> · run a QA flow: <b>maestro --device ${DROID_UDID} test flow.yaml</b> · <b>⧉ console</b> opens the raw ws-scrcpy page (other video decoders, web adb shell, file browser).</div>`;
  send(req, res, 200, page('android · emulator', body, st === 'booting' ? '<meta http-equiv="refresh" content="4">' : '', live ? 'watchlive' : '', 'droid'));
}

// ---------- system + usage panel (host metrics, claude/agy limits, spend) ----------
// One-step visibility of the box the harness runs on. Host numbers are sync reads
// (/proc, statfs) cached 5s; usage numbers shell out (claude-quota, ccusage per
// account, agy handoff state) so they're collected in the background and cached
// 5 min — a page load NEVER waits on them (first load shows "collecting…").
// Optional dependencies, each degrading gracefully when absent: claude-quota
// (agy layer) -> limits render "?", ccusage (`sudo npm i -g ccusage`) -> spend
// cards say so, agy handoff state -> "no handoffs".
const GB = n => (n / 1073741824).toFixed(1);
let hostCache = { t: 0, h: null };
function hostInfo() {
  if (hostCache.h && Date.now() - hostCache.t < 5000) return hostCache.h;
  let mt = 0, ma = 0, st = 0, sf = 0;
  for (const ln of readFileSync('/proc/meminfo', 'utf8').split('\n')) {
    const [k, v] = ln.split(':'); const kb = parseInt(v, 10) * 1024;
    if (k === 'MemTotal') mt = kb; else if (k === 'MemAvailable') ma = kb;
    else if (k === 'SwapTotal') st = kb; else if (k === 'SwapFree') sf = kb;
  }
  const d = statfsSync('/');
  const h = { load: os.loadavg()[0], cores: os.cpus().length,
    memUsed: mt - ma, memTot: mt, swapUsed: st - sf, swapTot: st,
    dskUsed: (d.blocks - d.bavail) * d.bsize, dskTot: d.blocks * d.bsize, up: os.uptime() };
  hostCache = { t: Date.now(), h };
  return h;
}
// Priced usage is tracked for the tmux user's interactive profiles (term: true) —
// the human subscription accounts; agent identities ride those same subscriptions.
// claude-quota names the tmux user's default profile "personal" — map that label.
const UACCTS = ACCTS.filter(a => a.term).map(a =>
  ({ id: a.id, label: a.label, qkey: a.label === TMUX_USER ? 'personal' : a.label, dir: a.home }));
const TMUX_HOME = `/home/${TMUX_USER}`;
const RUN_PATH = `${TMUX_HOME}/.local/bin:/usr/local/bin:/usr/bin:/bin`;
const runAs = (envs, cmd, args, t = 30000) => new Promise(r =>
  execFile('runuser', ['-u', TMUX_USER, '--', 'env', 'HOME=' + TMUX_HOME, 'PATH=' + RUN_PATH, ...envs, cmd, ...args],
    { timeout: t, maxBuffer: 32e6 }, (e, out) => r(e ? '' : out)));
const jp = s => { try { return JSON.parse(s); } catch { return null; } };
const mshort = m => String(m).replace(/^claude-/, '');
async function collectUsage() {
  const today = new Date().toISOString().slice(0, 10);
  const wk0iso = new Date(Date.now() - 6 * 86400e3).toISOString().slice(0, 10);
  const ymd = wk0iso.replace(/-/g, ''), ym1 = today.replace(/-/g, '').slice(0, 6) + '01';
  const qline = await runAs([], 'claude-quota', ['--line'], 15000);
  const quota = {}; // "personal 5h 8.0% wk 18.0% | work 5h 11.0% wk 44.0% (threshold 70%)"
  for (const m of qline.matchAll(/(\w+) 5h ([\d.?]+)% wk ([\d.?]+)%/g))
    quota[m[1]] = { h5: isNaN(parseFloat(m[2])) ? null : parseFloat(m[2]), wk: isNaN(parseFloat(m[3])) ? null : parseFloat(m[3]) };
  const thr = +(qline.match(/threshold (\d+)/) || [])[1] || 70;
  const accts = {};
  await Promise.all(UACCTS.map(async a => {
    const env = ['CLAUDE_CONFIG_DIR=' + a.dir];
    // one daily call covers today AND the week: per-day rows since 7 days ago + totals
    const [dj, mj, sj, bj] = await Promise.all([
      runAs(env, 'ccusage', ['daily', '--json', '--since', ymd, '--breakdown']),
      runAs(env, 'ccusage', ['monthly', '--json', '--since', ym1]),
      runAs(env, 'ccusage', ['session', '--json'], 60000),
      runAs(env, 'ccusage', ['blocks', '--json', '--active']),
    ].map(p => p.then(jp)));
    const rows = (dj && dj.daily) || [];
    const d0 = rows.find(r => r.period === today) || null;
    const models = (d0 && d0.modelBreakdowns || []).map(m => ({ name: m.modelName, cost: m.cost || 0 }))
      .sort((x, y) => y.cost - x.cost);
    const blk = (bj && bj.blocks && bj.blocks[0]) || null;
    const sess = (((sj && sj.session) || [])
      .filter(s => ((s.metadata && s.metadata.lastActivity) || '') >= wk0iso)
      .map(s => ({ sid: s.period || '', cost: s.totalCost || 0, models: (s.modelsUsed || []).map(mshort) }))
      .sort((x, y) => y.cost - x.cost).slice(0, 6));
    let tokExp = 0; // oauth expiry only — used to explain a "?" honestly; token itself never read
    try { tokExp = (JSON.parse(readFileSync(a.dir + '/.credentials.json', 'utf8')).claudeAiOauth || {}).expiresAt || 0; } catch { /* no creds file */ }
    accts[a.id] = { id: a.id, label: a.label, qkey: a.qkey, tokExp,
      cc: !!(dj || mj), // ccusage answered at all?
      today: (d0 && d0.totalCost) || 0,
      week: (dj && dj.totals && dj.totals.totalCost) || 0,
      month: (mj && mj.monthly && mj.monthly[0] && mj.monthly[0].totalCost) || 0,
      models,
      days: rows.map(r => ({ d: r.period || '', cost: r.totalCost || 0, models: (r.modelsUsed || []).map(mshort) })).reverse(),
      sess,
      block: blk ? { cost: blk.costUSD || 0, rate: (blk.burnRate && blk.burnRate.costPerHour) || 0 } : null };
  }));
  const agy = {};
  try {
    const hdir = TMUX_HOME + '/.local/state/agy-handoffs';
    for (const id of readdirSync(hdir)) {
      try {
        const st = JSON.parse(readFileSync(hdir + '/' + id + '/meta.json', 'utf8')).status;
        agy[st] = (agy[st] || 0) + 1;
      } catch { /* not a handoff dir */ }
    }
  } catch { /* no agy state on this box */ }
  let agyEv = null;
  try {
    const lines = readFileSync(TMUX_HOME + '/.local/state/agy-handoffs/events.log', 'utf8').trim().split('\n');
    const last = lines[lines.length - 1] || '';
    const sp = last.indexOf(' ');
    if (sp > 0) agyEv = { t: Date.parse(last.slice(0, sp)) || 0, msg: last.slice(sp + 1) };
  } catch { /* no events yet */ }
  return { quota, thr, accts, agy, agyEv };
}
let usageCache = { t: 0, d: null, busy: false };
function usage() {
  if (!usageCache.busy && Date.now() - usageCache.t > 300e3) {
    usageCache.busy = true;
    collectUsage().then(d => { usageCache = { t: Date.now(), d, busy: false }; })
      .catch(() => { usageCache.busy = false; usageCache.t = Date.now() - 240e3; }); // retry in 1 min
  }
  return usageCache.d;
}
usage(); // warm the cache at boot so the first visitor already sees numbers
function sysPanel() {
  const h = hostInfo(), u = usage();
  const pct = (x, t) => t ? Math.min(100, Math.round(x / t * 100)) : 0;
  const meter = (p, hot) => `<span class="meter"><i style="width:${Math.min(100, Math.max(0, p))}%${p >= (hot == null ? 101 : hot) ? ';background:var(--bad)' : p >= 50 ? ';background:var(--warn)' : ''}"></i></span>`;
  const money = n => '$' + (n >= 100 ? Math.round(n).toLocaleString('en-US') : n.toFixed(2));
  const days = Math.floor(h.up / 86400), hrs = Math.floor(h.up % 86400 / 3600);
  const cards = `<div class="statgrid">
<div class="stat"><span class="sl">load</span><b class="sv">${h.load.toFixed(2)}</b> <span class="muted">/ ${h.cores} cores</span>${meter(pct(h.load, h.cores), 90)}</div>
<div class="stat"><span class="sl">memory</span><b class="sv">${GB(h.memUsed)}</b> <span class="muted">/ ${GB(h.memTot)} G</span>${meter(pct(h.memUsed, h.memTot), 90)}</div>
<div class="stat"><span class="sl">swap</span><b class="sv">${GB(h.swapUsed)}</b> <span class="muted">/ ${GB(h.swapTot)} G</span>${meter(pct(h.swapUsed, h.swapTot), 90)}</div>
<div class="stat"><span class="sl">disk /</span><b class="sv">${GB(h.dskUsed)}</b> <span class="muted">/ ${GB(h.dskTot)} G</span>${meter(pct(h.dskUsed, h.dskTot), 90)}</div>
<div class="stat"><span class="sl">uptime</span><b class="sv">${days}d ${hrs}h</b></div></div>`;
  let ubody;
  if (!u) ubody = `<p class="muted" style="padding:4px 0 8px">collecting usage — first pass takes ~15 s, refresh in a moment…</p>`;
  else {
    const acards = Object.values(u.accts).map(a => {
      const q = u.quota[a.qkey] || u.quota[a.label] || {};
      const qrow = (lbl, v) => `<div class="qrow"><span>${lbl}</span>${meter(v == null ? 0 : v, u.thr)}<b>${v == null ? '?' : v + '%'}</b></div>`;
      let spend, breakdown = '';
      if (!a.cc) spend = `<div class="mlist muted">ccusage not installed — sudo npm i -g ccusage</div>`;
      else {
        spend = `<div class="qrow"><span>today</span><b>${money(a.today)}</b><span class="muted">· week ${money(a.week)} · month ${money(a.month)}</span></div>
${a.block ? `<div class="qrow"><span>5h block</span><b>${money(a.block.cost)}</b><span class="muted">· ${money(a.block.rate)}/h burn</span></div>` : ''}
<div class="mlist${a.models.length ? '' : ' muted'}">${a.models.length ? a.models.map(m => `${esc(mshort(m.name))} ${money(m.cost)}`).join(' · ') : 'no usage today'}</div>`;
        breakdown = `<details class="ubd"><summary>full breakdown · 7 days</summary>
<span class="sl" style="padding-top:8px">per day</span>
${a.days.length ? a.days.map(r => `<div class="qrow"><span>${esc(r.d.slice(5))}</span><b>${money(r.cost)}</b><span class="muted mlist" style="padding:0">${r.models.map(esc).join(', ')}</span></div>`).join('') : '<div class="mlist muted">no usage this week</div>'}
<span class="sl" style="padding-top:8px">sessions · lifetime spend</span>
${a.sess.length ? a.sess.map(t => `<div class="qrow"><a class="sid8" href="/s/${a.id}/${esc(t.sid)}">${esc(t.sid.slice(0, 8))}</a><b>${money(t.cost)}</b><span class="muted mlist" style="padding:0">${t.models.map(esc).join(', ')}</span></div>`).join('') : '<div class="mlist muted">none this week</div>'}
</details>`;
      }
      return `<div class="stat"><span class="sl">${esc(a.label)} · limits</span>${qrow('5h', q.h5)}${qrow('week', q.wk)}
<div class="mlist muted">${a.tokExp && a.tokExp < Date.now() && q.h5 == null ? `oauth token expired ${rel(a.tokExp)} ago — open any ${esc(a.label)} session and it refreshes` : `delegate to agy at ${u.thr}%`}</div></div>
<div class="stat"><span class="sl">${esc(a.label)} · spend</span>${spend}${breakdown}</div>`;
    }).join('');
    const ag = Object.keys(u.agy).length
      ? Object.entries(u.agy).map(([k, v]) => `${esc(k)} <b>${v}</b>`).join(' · ') : 'no handoffs';
    ubody = `<div class="statgrid u">${acards}
<div class="stat wide"><span class="sl">agy · antigravity</span>
<div class="qrow"><span style="width:72px">limits</span><span class="mlist" style="padding:0">antigravity's cli exposes no usage/quota api — delegation is gated by the claude limit bars above (${u.thr}%)</span></div>
<div class="qrow"><span style="width:72px">handoffs</span><span class="mlist" style="padding:0">${ag}</span></div>
${u.agyEv ? `<div class="qrow"><span style="width:72px">last event</span><span class="mlist" style="padding:0">${esc(u.agyEv.msg)} <span class="muted">· ${rel(u.agyEv.t)} ago</span></span></div>` : ''}
</div></div>`;
  }
  const sumToday = u ? Object.values(u.accts).reduce((s, a) => s + a.today, 0) : null;
  return `<details class="sys"><summary><span class="syst">📊 system</span><span class="syss">load <b>${h.load.toFixed(2)}</b> · mem <b>${GB(h.memUsed)}/${GB(h.memTot)}G</b> · disk <b>${GB(h.dskUsed)}/${GB(h.dskTot)}G</b> · up <b>${days}d</b>${sumToday == null ? '' : ` · today <b>${money(sumToday)}</b>`}</span></summary>
<div class="sysbody">${cards}${ubody}</div></details>`;
}

// ---------- transcript parse (LRU 3 files; >25MB -> tail 8MB window) ----------
const parseCache = new Map(); // path -> {mt, sz, msgs, meta}
const BIG = 25 * 1048576, WINDOW = 8 * 1048576;
function pushText(msgs, role, ts, text) {
  if (text && text.trim()) msgs.push({ role, ts, text: text.slice(0, 30000) });
}
async function loadSession(e) {
  const hit = parseCache.get(e.path);
  if (hit && hit.mt === e.mt && hit.sz === e.sz) return hit;
  let raw, truncated = false;
  if (e.sz > BIG) { // ponytail: tail window; full lazy-load if ever needed
    const fh = await fsp.open(e.path, 'r');
    const buf = Buffer.alloc(WINDOW);
    await fh.read(buf, 0, WINDOW, e.sz - WINDOW);
    await fh.close();
    raw = buf.toString('utf8');
    raw = raw.slice(raw.indexOf('\n') + 1);
    truncated = true;
  } else {
    raw = await fsp.readFile(e.path, 'utf8');
  }
  const msgs = [], meta = { cwd: '', model: '', firstTs: '', tools: 0 };
  for (const line of raw.split('\n')) {
    if (!line) continue;
    let j; try { j = JSON.parse(line); } catch { continue; }
    if (!meta.cwd && j.cwd) meta.cwd = j.cwd;
    if (!meta.firstTs && j.timestamp) meta.firstTs = j.timestamp;
    const ts = j.timestamp || '';
    if (j.type === 'summary' && j.summary) {
      msgs.push({ role: 'sum', ts, text: j.summary.slice(0, 4000) });
    } else if (j.type === 'user' && j.message) {
      const c = j.message.content;
      if (typeof c === 'string') { pushText(msgs, 'user', ts, c); continue; }
      if (!Array.isArray(c)) continue;
      for (const it of c) {
        if (it.type === 'text') pushText(msgs, 'user', ts, it.text);
        else if (it.type === 'tool_result') {
          const t = typeof it.content === 'string' ? it.content
            : Array.isArray(it.content) ? it.content.filter(x => x.type === 'text').map(x => x.text).join('\n') : '';
          msgs.push({ role: 'res', ts, text: (t || '(no output)').slice(0, 2000) });
        }
      }
    } else if (j.type === 'assistant' && j.message) {
      if (j.message.model) meta.model = j.message.model;
      const c = j.message.content;
      if (!Array.isArray(c)) continue;
      for (const it of c) {
        if (it.type === 'text') pushText(msgs, 'claude', ts, it.text);
        else if (it.type === 'tool_use') {
          meta.tools++;
          msgs.push({ role: 'tool', ts, name: it.name,
                      text: JSON.stringify(it.input || {}, null, 1).slice(0, 2000) });
        }
      }
    }
  }
  const v = { mt: e.mt, sz: e.sz, msgs, meta, truncated };
  if (parseCache.size >= 3) parseCache.delete(parseCache.keys().next().value);
  parseCache.set(e.path, v);
  return v;
}

// ---------- html helpers ----------
const esc = s => String(s).replace(/[&<>"']/g, c =>
  ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const fmtSz = n => n < 1024 ? n + 'B' : n < 1048576 ? (n / 1024 | 0) + 'K'
  : (n / 1048576).toFixed(1) + 'M';
const rel = ms => { const s = (Date.now() - ms) / 1000;
  return s < 90 ? 'now' : s < 5400 ? (s / 60 | 0) + 'm' : s < 129600 ? (s / 3600 | 0) + 'h' : (s / 86400 | 0) + 'd'; };
const dayLbl = ms => { const d = new Date(ms).toISOString().slice(0, 10);
  const t = new Date().toISOString().slice(0, 10), y = new Date(Date.now() - 86400e3).toISOString().slice(0, 10);
  return d === t ? 'today' : d === y ? 'yesterday' : new Date(ms).toUTCString().slice(5, 16); };
// pause/resume + kill (with no-JS <details> confirm) for one live tmux session
function actForms(l, back) {
  const f = (act, label, cls) => `<form class="af" method="post" action="/a/${act}"><input type="hidden" name="name" value="${esc(l.name)}"><input type="hidden" name="back" value="${esc(back)}"><button class="ab${cls ? ' ' + cls : ''}">${label}</button></form>`;
  return (l.paused ? f('resume', '▶ resume', 'ok') : f('pause', '⏸ pause'))
    + `<details class="kx"><summary class="ab danger">✕ kill</summary><div class="kc"><div>stop <b>${esc(l.name)}</b>?</div><span class="muted">the process ends now — the transcript stays on disk, resume anytime.</span>${f('kill', 'kill it', 'danger')}</div></details>`;
}
const abs = t => t ? new Date(t).toISOString().slice(0, 16).replace('T', ' ') + 'Z' : '—';
const projName = (raw) => { // "-home-demo-Documents-Projects-fun-backend" -> "fun/backend"
  const parts = raw.replace(/^-/, '').split('-').filter(Boolean);
  return parts.length <= 2 ? parts.join('/') : parts.slice(-2).join('/');
};
// shadcn design system (dark, zinc + emerald), applied 2026-07-13: token layer
// below, component recipes after. Same markup/classes; sans UI + mono data.
const CSS = `
:root{color-scheme:dark;
--bg:#0a0a0a;--card:#141416;--card2:#1b1b1e;--pop:#202024;
--fg:#fafafa;--fg2:#d4d4d8;--mut:#a1a1aa;--dim:#71717a;
--bd:rgba(255,255,255,.09);--bd2:rgba(255,255,255,.16);--hair:rgba(255,255,255,.055);
--ring:rgba(161,161,170,.8);
--ok:#34d399;--ok-bg:rgba(52,211,153,.1);--ok-bd:rgba(52,211,153,.4);
--warn:#fbbf24;--bad:#f87171;
--r:10px;--r-lg:14px;
--sans:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,'Helvetica Neue',Arial,sans-serif;
--mono:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace}
*{margin:0;padding:0;box-sizing:border-box;-webkit-tap-highlight-color:transparent}
html{background:var(--bg)}
body{background:var(--bg);color:var(--fg);font:14px/1.5 var(--sans);padding:12px;max-width:1100px;margin:0 auto}
a,button,summary,input{touch-action:manipulation}
a{color:inherit;text-decoration:none}
:is(a,button,summary,input):focus-visible{outline:2px solid var(--ring);outline-offset:2px;border-radius:6px}
@media(prefers-reduced-motion:no-preference){a,button,summary{transition:background-color .15s,border-color .15s,color .15s}}
.tabs{display:none}
h1{font-size:16px;font-weight:650;letter-spacing:-.01em;padding:4px 0 12px;display:flex;align-items:center;gap:9px;flex-wrap:wrap}
h1::before{content:'>_';color:var(--ok);font:700 12px/1 var(--mono);background:var(--ok-bg);border:1px solid var(--ok-bd);padding:6px 7px;border-radius:9px}
h1 a{color:var(--fg)}
h1 .muted{font-weight:400;font-size:13px}
.bar{display:flex;flex-wrap:wrap;gap:6px;align-items:center;padding:2px 0 10px}
.chip{display:inline-flex;align-items:center;gap:6px;border:1px solid var(--bd);background:var(--card);border-radius:999px;padding:5px 12px;min-height:30px;color:var(--mut);white-space:nowrap;font-size:13px}
a.chip:hover{background:var(--card2);border-color:var(--bd2);color:var(--fg2)}
.chip.on{border-color:var(--ok-bd);color:var(--fg);background:var(--ok-bg)}
.chip b{font-weight:600;font-variant-numeric:tabular-nums}
.dot{width:7px;height:7px;border-radius:50%;display:inline-block;flex-shrink:0}
input[type=search]{background:rgba(255,255,255,.04);border:1px solid var(--bd2);border-radius:var(--r);color:var(--fg);padding:6px 12px;font:13px var(--sans);width:190px;min-height:34px}
input[type=search]::placeholder{color:var(--dim)}
button{background:var(--card2);border:1px solid var(--bd);border-radius:var(--r);color:var(--fg2);padding:6px 12px;font:13px var(--sans);min-height:34px;cursor:pointer}
button:hover{background:var(--pop);border-color:var(--bd2)}
.lp{background:var(--card);border:1px solid var(--bd);border-radius:var(--r-lg);padding:10px 12px;margin:4px 0 14px;display:flex;flex-direction:column;gap:10px}
.lr{display:flex;flex-wrap:wrap;gap:6px 10px;align-items:center;min-height:36px}
.ln a,.ln span{color:var(--ok);font:600 13px var(--mono)}
.la{display:flex;gap:6px;align-items:center;margin-left:auto;flex-wrap:wrap}
.af{display:inline;margin:0}
.ab{display:inline-flex;align-items:center;gap:5px;border:1px solid var(--bd);border-radius:var(--r);padding:5px 12px;min-height:34px;background:var(--card2);color:var(--fg2);font:13px var(--sans);cursor:pointer;list-style:none}
.ab:hover{background:var(--pop);border-color:var(--bd2)}
.ab.danger{color:var(--bad)}
.ab.danger:hover{background:rgba(248,113,113,.1);border-color:rgba(248,113,113,.35)}
.ab.ok{color:var(--ok)}
.ab.ok:hover{background:var(--ok-bg);border-color:var(--ok-bd)}
.kx{position:relative;margin:0}
.kx summary::-webkit-details-marker{display:none}
.kc{position:absolute;right:0;top:42px;z-index:9;background:var(--pop);border:1px solid var(--bd2);border-radius:var(--r-lg);padding:12px;width:250px;display:flex;flex-direction:column;gap:10px;box-shadow:0 12px 32px rgba(0,0,0,.55);font-size:13px}
.day{color:var(--dim);font:600 11px/1 var(--sans);padding:18px 4px 8px;text-transform:uppercase;letter-spacing:.08em}
.li{display:flex;align-items:stretch;border-bottom:1px solid var(--hair)}
.li:hover,.li:active{background:var(--card)}
.row{flex:1;display:flex;flex-wrap:wrap;gap:4px 10px;align-items:center;padding:10px 6px;min-height:46px;min-width:0}
.t{color:var(--dim);width:36px;flex-shrink:0;font:12px var(--mono);font-variant-numeric:tabular-nums}
.acct{font:600 12px var(--sans);flex-shrink:0}
.proj{font:600 12.5px var(--mono);color:var(--fg2);overflow:hidden;text-overflow:ellipsis;white-space:nowrap;max-width:38%}
.ttl{color:var(--mut);flex:1;min-width:130px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.sz{color:var(--dim);font:12px var(--mono);font-variant-numeric:tabular-nums;flex-shrink:0}
.sid{color:var(--dim);font:12px var(--mono);flex-shrink:0}
.go{display:flex;align-items:center;padding:0 14px;color:var(--ok);border-left:1px solid var(--hair);font:700 13px var(--mono)}
.go:hover{background:var(--ok-bg)}
.kx.del{display:flex;align-items:stretch}
.dx{display:flex;align-items:center;padding:0 13px;color:var(--dim);border-left:1px solid var(--hair);cursor:pointer;font-size:13px;min-height:44px}
.dx:hover{background:rgba(248,113,113,.08);color:var(--bad)}
.pg{display:flex;gap:6px;align-items:center;justify-content:center;padding:16px 0;flex-wrap:wrap;font-size:13px}
.pg a,.pg span{border:1px solid var(--bd);border-radius:var(--r);padding:8px 14px;min-height:40px;display:inline-flex;align-items:center;color:var(--mut)}
.pg a:hover{background:var(--card2);color:var(--fg)}
.pg .cur{border-color:var(--ok-bd);color:var(--ok);background:var(--ok-bg);font-variant-numeric:tabular-nums}
.pg .muted{border:none;padding:8px 4px}
.pg .off{color:#3f3f46;border-color:rgba(255,255,255,.04)}
.muted{color:var(--mut)}
.meta{background:var(--card);border:1px solid var(--bd);border-radius:var(--r-lg);padding:14px;margin:8px 0 14px;display:grid;grid-template-columns:auto 1fr;gap:6px 16px;word-break:break-all;font-size:13px}
.meta div:nth-child(odd){color:var(--dim)}
.meta div:nth-child(even){font:12.5px var(--mono)}
.btn{display:inline-flex;align-items:center;gap:8px;background:var(--ok);color:#052018;border-radius:var(--r);padding:9px 16px;font:650 14px var(--sans);min-height:42px}
.btn:hover{background:#4ade9e}
.m{background:var(--card);border:1px solid var(--bd);border-left-width:3px;border-radius:var(--r-lg);padding:10px 12px;margin:10px 0}
.m.user{border-left-color:#60a5fa}.m.claude{border-left-color:var(--ok)}
.mh{font:600 11px/1 var(--sans);color:var(--dim);padding-bottom:6px;text-transform:uppercase;letter-spacing:.06em}
.m.user .mh b{color:#60a5fa}.m.claude .mh b{color:var(--ok)}
pre{white-space:pre-wrap;word-break:break-word;font:13px/1.55 var(--mono)}
details{margin:8px 0}
summary{cursor:pointer;color:var(--mut);min-height:32px;display:flex;align-items:center;gap:6px;font-size:13px}
summary:hover{color:var(--fg2)}
details pre{background:#050506;border:1px solid var(--bd);border-radius:var(--r);padding:10px;margin-top:6px;font-size:12px;max-height:340px;overflow:auto}
.note{border:1px solid rgba(251,191,36,.35);background:rgba(251,191,36,.06);border-radius:var(--r);color:var(--warn);padding:9px 12px;margin:8px 0;font-size:13px}
.vnc{width:100%;height:72vh;border:1px solid var(--bd);border-radius:var(--r-lg);background:#050506;margin:2px 0;display:block}
.wbar{display:none}
.wblank{border:1px dashed var(--bd2);border-radius:var(--r-lg);padding:44px 16px;text-align:center;display:flex;flex-direction:column;gap:6px;color:var(--mut);margin:2px 0}
footer{padding:18px 0;color:var(--dim);display:flex;gap:14px;flex-wrap:wrap;font-size:12.5px}
footer a{color:var(--mut)}
footer a:hover{color:var(--fg2)}
@media(max-width:700px){body{padding:max(8px,env(safe-area-inset-top,8px)) 8px calc(72px + env(safe-area-inset-bottom,0))}.proj{max-width:55%}.ttl{flex-basis:100%;order:9}.sid{display:none}input[type=search]{width:140px}
/* app-mode nav: fixed bottom tab bar (the footer links + header chips it
   duplicates hide via .navdup). installed PWA has no browser chrome, so this
   IS the navigation; safe-area padding clears the iPhone home indicator. */
.tabs{position:fixed;bottom:0;left:0;right:0;z-index:20;display:flex;background:rgba(10,10,10,.88);backdrop-filter:blur(14px);-webkit-backdrop-filter:blur(14px);border-top:1px solid var(--bd);padding:5px 0 calc(5px + env(safe-area-inset-bottom,0))}
.tb{flex:1;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:2px;min-height:48px;color:var(--dim);font-size:11px}
.tb .ti{font-size:18px;line-height:1.2}
.tb.on{color:var(--ok)}
.tb:active{color:var(--fg)}
.navdup{display:none}
/* installed app: content scrolls under the translucent status bar — back it
   with a blur strip (tab bar's top counterpart). 0-height in browser tabs. */
body::before{content:'';position:fixed;top:0;left:0;right:0;height:env(safe-area-inset-top,0px);background:rgba(10,10,10,.88);backdrop-filter:blur(14px);-webkit-backdrop-filter:blur(14px);z-index:20;pointer-events:none}
.watchwrap{display:flex;flex-direction:column;gap:6px}
/* portrait: iframe hugs the 16:9 remote so there are no dead black bars, leaving
   room below for the key toolbar + hint. landscape (below) goes immersive. */
.watchwrap .vnc{width:100%;aspect-ratio:16/9;height:auto;min-height:170px;margin:0}
.wbar{display:flex;flex-wrap:wrap;gap:6px}
.wbar button{flex:0 0 auto;min-width:56px;min-height:46px;padding:6px 10px}
.wbar .kbd{background:#059669;border-color:#059669;color:#fff;font-weight:600}}
@media(max-width:700px) and (orientation:landscape){body.watchlive h1,body.watchlive>.bar,body.watchlive>.note,body.watchlive footer,body.watchlive .tabs{display:none}body.watchlive{padding:4px}.watchwrap .vnc{aspect-ratio:auto;height:calc(100dvh - 74px)}}
/* system + usage panel */
.sys{margin:2px 0 12px;border:1px solid var(--bd);border-radius:var(--r-lg);background:var(--card)}
.sys > summary{position:relative;display:flex;flex-wrap:wrap;gap:4px 10px;align-items:center;padding:9px 34px 9px 12px;cursor:pointer;list-style:none;font-size:13px;color:var(--mut)}
.sys summary::-webkit-details-marker{display:none}
.sys > summary::after{content:'▾';position:absolute;right:13px;top:9px;color:var(--dim)}
.sys[open] > summary::after{content:'▴'}
.sys > summary:hover{color:var(--fg2)}
.syst{color:var(--fg2);font-weight:600}
.syss{overflow-wrap:anywhere;min-width:0}
.syss b{color:var(--fg);font-weight:600;font-variant-numeric:tabular-nums}
.sysbody{padding:0 12px 12px;border-top:1px solid var(--hair)}
.statgrid{display:grid;grid-template-columns:repeat(auto-fit,minmax(140px,1fr));gap:6px;padding-top:10px}
.statgrid.u{grid-template-columns:repeat(auto-fit,minmax(240px,1fr))}
.stat{background:var(--card2);border:1px solid var(--bd);border-radius:var(--r);padding:8px 10px;min-width:0}
.stat.wide{grid-column:1/-1}
.sl{display:block;font-size:10px;letter-spacing:.08em;text-transform:uppercase;color:var(--dim);padding-bottom:4px;white-space:nowrap}
.sv{font-size:16px;font-weight:650;font-variant-numeric:tabular-nums}
.meter{display:block;height:4px;border-radius:2px;background:rgba(255,255,255,.07);margin-top:7px;overflow:hidden}
.meter i{display:block;height:100%;background:var(--ok);border-radius:2px}
.qrow{display:flex;gap:8px;align-items:center;font-size:12px;color:var(--mut);padding:2px 0;min-width:0}
.qrow .meter{flex:1;margin:0}
.qrow b{color:var(--fg);font-variant-numeric:tabular-nums;flex-shrink:0}
.qrow>span:first-child{width:52px;flex-shrink:0}
.qrow .sid8{font-family:var(--mono);font-size:11px;color:var(--fg2);text-decoration:underline;text-decoration-color:var(--bd2)}
.mlist{font-size:11px;color:var(--mut);padding-top:4px;overflow-wrap:anywhere;min-width:0}
.ubd{margin-top:8px;border-top:1px solid var(--hair);padding-top:6px}
.ubd summary{cursor:pointer;list-style:none;font-size:11px;color:var(--fg2);min-height:26px;display:flex;align-items:center}
.ubd summary::-webkit-details-marker{display:none}
.ubd summary::before{content:'▸';color:var(--dim);margin-right:6px}
.ubd[open] summary::before{content:'▾'}
@media(max-width:700px){.sys > summary{font-size:12px;padding:8px 30px 8px 10px}.sysbody{padding:0 8px 8px}}
`;
function page(title, body, head = '', bodyClass = '', tab = '') {
  const tabs = `<nav class="tabs">
<a class="tb${tab === 'sessions' ? ' on' : ''}" href="/"><span class="ti">▤</span>sessions</a>
<a class="tb" href="/term/?v=3"><span class="ti">⌨</span>terminal</a>
<a class="tb${tab === 'watch' ? ' on' : ''}" href="/watch"><span class="ti">🖥</span>watch</a>
<a class="tb${tab === 'droid' ? ' on' : ''}" href="/droid"><span class="ti">📱</span>android</a></nav>`;
  return `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1,maximum-scale=1,user-scalable=no,viewport-fit=cover,interactive-widget=resizes-content">
<meta name="color-scheme" content="dark"><meta name="theme-color" content="#0a0a0a">
<link rel="manifest" href="/manifest.webmanifest" crossorigin="use-credentials">
<link rel="icon" href="/favicon.png"><link rel="apple-touch-icon" href="/apple-touch-icon.png">
<meta name="mobile-web-app-capable" content="yes"><meta name="apple-mobile-web-app-capable" content="yes">
<meta name="apple-mobile-web-app-status-bar-style" content="black-translucent">${head}
<title>${esc(title)}</title><style>${CSS}</style></head><body class="${bodyClass}">${body}
${tabs}<footer><a class="navdup" href="/">sessions</a><a class="navdup" href="/term/?v=3">terminal</a><a class="navdup" href="/watch">watch</a><a class="navdup" href="/droid">android</a><a href="/oauth2/sign_out">sign out</a><span>lite · no-js · ${index.length} indexed</span><span id="envout"></span></footer>
<script>if('serviceWorker' in navigator)navigator.serviceWorker.register('/sw.js');
/* attach / >_ open the session in its OWN window on a desktop or tablet BROWSER, so the
   dashboard stays put and pause/kill/the other sessions stay one click away. NOT in the
   installed PWA: there is no second window there, and target=_blank throws the user out to
   the system browser and off the app — same reason phone-width (<700px, the layout
   breakpoint this file uses everywhere) stays in place. The target is named per session
   (data-nw), so clicking one twice reuses its window instead of opening a rival tmux
   client, which would detach the first (attach -d). Deliberately no rel=noopener: with
   it the spec ignores the window name and every click spawns another window, and the page
   opened is our own /term on this origin. JS off => in place, exactly as before. */
if(matchMedia('(display-mode: browser)').matches&&innerWidth>=700)
  document.querySelectorAll('a[data-nw]').forEach(function(a){a.target=a.dataset.nw});
/* ccdiag: install-mode + safe-area readout in the footer (e.g. "app · sat59 sab34")
   so device rendering issues can be diagnosed without guessing */
(function(){var o=document.getElementById('envout');if(!o)return;
var p=document.createElement('div');
p.style.cssText='position:fixed;visibility:hidden;pointer-events:none;padding:env(safe-area-inset-top,0px) 0 env(safe-area-inset-bottom,0px)';
document.body.appendChild(p);var s=getComputedStyle(p);
/* measure AFTER layout settles — env() reads 0 too early on iOS cold start */
setTimeout(function(){requestAnimationFrame(function(){
var s2=getComputedStyle(p);
var m=(matchMedia('(display-mode: standalone)').matches?'app':'tab'),t=parseFloat(s2.paddingTop)|0,b=parseFloat(s2.paddingBottom)|0;
o.textContent=m+' · sat'+t+' sab'+b;
var u=document.createElement('div');
u.style.cssText='position:fixed;visibility:hidden;pointer-events:none;top:0;left:0;width:1px;height:100lvh';
document.body.appendChild(u);var lvh=u.getBoundingClientRect().height|0;
u.style.height='100dvh';var dvh=u.getBoundingClientRect().height|0;u.remove();
p.remove();var vv=window.visualViewport;
fetch('/z?t=dash3&m='+m+'&sat='+t+'&sab='+b+'&ih='+innerHeight+'&sh='+screen.height+'&oh='+outerHeight+'&sy='+(window.screenY|0)+'&vh='+(vv?vv.height|0:0)+'&dh='+document.documentElement.clientHeight+'&lvh='+lvh+'&dvh='+dvh).catch(function(){})
})},700)})()</script>
</body></html>`;
}
function send(req, res, status, html, type = 'text/html; charset=utf-8') {
  const buf = Buffer.from(html);
  const h = { 'content-type': type, 'cache-control': 'no-cache' };
  if (buf.length > 1024 && /gzip/.test(req.headers['accept-encoding'] || '')) {
    const gz = gzipSync(buf); h['content-encoding'] = 'gzip'; h['content-length'] = gz.length;
    res.writeHead(status, h); res.end(gz);
  } else { h['content-length'] = buf.length; res.writeHead(status, h); res.end(buf); }
}
const qs = o => { const p = new URLSearchParams();
  for (const [k, v] of Object.entries(o)) if (v) p.set(k, v);
  const s = p.toString(); return s ? '?' + s : ''; };

// ---------- PWA: manifest + drawn icons + minimal service worker ----------
// note: every /term link carries v=3 — a cache-key bust of phone HTTP caches (bump when a term fix must land NOW)
// that hold the pre-safe-area term page under max-age=86400 (2026-07-07).
// /term is no-cache+ETag via Caddy file_server now; safe to drop v=3 later.
// viewport uses maximum-scale=1,user-scalable=no: measured on iPhone 17 Pro Max
// (iOS 26) via the /z beacon — WITHOUT those flags the standalone app letterboxes
// the page (env sat=0, iOS paints a dead black status band); WITH them it goes
// true edge-to-edge (sat=62 sab=34). iOS ignores the no-zoom flags for a11y
// pinch anyway, so the cost is nominal.
// Installable on phones/desktops. Icons are rendered right here (zero deps,
// zero asset files): the >_ prompt glyph on the house dark bg, tinted with the
// account color on the per-account hosts so home-screen icons tell apart.
const crcT = (() => { const t = new Int32Array(256);
  for (let n = 0; n < 256; n++) { let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c; } return t; })();
const crc32 = b => { let c = -1;
  for (let i = 0; i < b.length; i++) c = crcT[(c ^ b[i]) & 255] ^ (c >>> 8);
  return (c ^ -1) >>> 0; };
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
function iconPNG(size, color) {
  const key = size + color;
  if (iconCache.has(key)) return iconCache.get(key);
  const bg = hexRGB('#0a0a0a'), fg = hexRGB(color), W = 0.052;
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
const hostAcct = req => BY_ID[HOST_ACCT[(req.headers.host || '').split('.')[0]]] || null;
function manifest(req, res) {
  const a = hostAcct(req);
  send(req, res, 200, JSON.stringify({
    id: '/', name: a ? `mows · ${a.label}` : 'mows sessions',
    short_name: a ? a.label : 'mows',
    start_url: '/', scope: '/', display: 'standalone',
    background_color: '#0a0a0a', theme_color: '#0a0a0a',
    description: 'mows harness: agent sessions, web terminal, QA watch, android console',
    icons: [
      { src: '/icon-192.png', sizes: '192x192', type: 'image/png' },
      { src: '/icon-512.png', sizes: '512x512', type: 'image/png' },
      { src: '/icon-512.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' }],
  }), 'application/manifest+json');
}
// ponytail: no caching in the SW — every page is live data and ~4KB; an offline
// console is useless, so offline just says so instead of the browser dino.
const SW = `self.addEventListener('install',()=>self.skipWaiting());
self.addEventListener('activate',e=>e.waitUntil(self.clients.claim()));
const OFF='<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>offline</title><body style="background:#0a0a0a;color:#a1a1aa;font:14px/1.5 ui-monospace,SFMono-Regular,Menlo,monospace;margin:0;display:flex;min-height:100vh;align-items:center;justify-content:center;text-align:center"><div><div style="color:#34d399;font-size:26px;padding-bottom:10px">&gt;_</div>offline — the console needs a connection.<br><br><a style="color:#34d399" href="/">retry</a></div>';
self.addEventListener('fetch',e=>{
  if(e.request.mode==='navigate')
    e.respondWith(fetch(e.request).catch(()=>new Response(OFF,{headers:{'content-type':'text/html; charset=utf-8'}})));
});
`;

// ---------- views ----------
function pager(base, params, cur, max, extra = '') {
  const link = (p, txt, cls = '') => p >= 1 && p <= max && p !== cur
    ? `<a class="${cls}" href="${base}${qs({ ...params, page: p > 1 ? p : '' })}">${txt}</a>`
    : `<span class="off">${txt}</span>`;
  return `<nav class="pg">${link(1, '«')}${link(cur - 1, '‹ prev')}
<span class="cur">${cur} / ${max}</span>${extra}
${link(cur + 1, 'next ›')}${link(max, '»')}</nav>`;
}
async function listView(req, res, url) {
  freshen();
  const sub = (req.headers.host || '').split('.')[0];
  const acct = url.searchParams.get('acct') || HOST_ACCT[sub] || '';
  const q = (url.searchParams.get('q') || '').toLowerCase().slice(0, 80);
  const d = url.searchParams.get('d') || '';
  const s = url.searchParams.get('s') || '';
  const live = await tmuxLive();
  const liveNames = new Set(live.map(l => l.name));
  let rows = index;
  if (acct && BY_ID[acct]) rows = rows.filter(e => e.a === acct);
  if (q) rows = rows.filter(e => e.proj.toLowerCase().includes(q) || e.sid.startsWith(q));
  const CUT = { today: new Date(new Date().toISOString().slice(0, 10)).getTime(),
    '7d': Date.now() - 7 * 86400e3, '30d': Date.now() - 30 * 86400e3 };
  if (CUT[d]) rows = rows.filter(e => e.mt >= CUT[d]);
  if (s === 'live') rows = rows.filter(e => liveNames.has('web-' + e.sid.slice(0, 8)));
  const max = Math.max(1, Math.ceil(rows.length / PAGE));
  const cur = Math.min(max, Math.max(1, +(url.searchParams.get('page') || 1) || 1));
  const slice = rows.slice((cur - 1) * PAGE, cur * PAGE);
  const titles = await Promise.all(slice.map(titleOf));
  const P = { acct, q, d, s };
  const back = url.pathname + url.search;

  const chip = (over, label, on) => `<a class="chip${on ? ' on' : ''}" href="/${qs({ ...P, ...over })}">${label}</a>`;
  const chips = [chip({ acct: '' }, `all <b>${index.length}</b>`, !acct)]
    .concat(ACCTS.map(a => chip({ acct: a.id },
      `<span class="dot" style="background:${a.color}"></span>${a.label} <b>${counts[a.id] || 0}</b>`, acct === a.id))).join('');
  const dchips = [['', 'all time'], ['today', 'today'], ['7d', '7 days'], ['30d', '30 days']]
    .map(([v, l]) => chip({ d: v }, l, d === v)).join('')
    + chip({ s: s === 'live' ? '' : 'live' },
      `<span class="dot" style="background:#34d399"></span>live <b>${live.filter(l => l.name.startsWith('web-')).length}</b>`, s === 'live');

  const liveHtml = live.length ? `<div class="lp">` + live.map(l => {
    const sid8 = l.name.startsWith('web-') ? l.name.slice(4, 12) : '';
    const row = sid8 ? index.find(e => TERM_IDS.has(e.a) && e.sid.startsWith(sid8)) : null;
    const nm = row ? `<a href="/s/${row.a}/${row.sid}">${esc(l.name)}</a>` : `<span style="color:#34d399">${esc(l.name)}</span>`;
    const proj = row ? projName(row.proj) : (l.cwd || '').split('/').filter(Boolean).slice(-1)[0] || '';
    return `<div class="lr"><span class="dot" style="background:${l.paused ? '#fbbf24' : '#34d399'}"></span>
<span class="ln">${nm}</span><span class="muted">${esc(proj)} · ${l.paused ? 'paused' : l.attached ? 'attached' : 'detached'} · ${rel(l.created)}</span>
<span class="la"><a class="ab" data-nw="t-${esc(l.name)}" href="/term/?arg=attach&amp;arg=${esc(l.name)}&amp;v=3">attach</a>${actForms(l, back)}</span></div>`;
  }).join('') + `</div>` : '';

  let lastDay = '', items = '';
  slice.forEach((e, i) => {
    const dl = dayLbl(e.mt);
    if (dl !== lastDay) { items += `<div class="day">${dl}</div>`; lastDay = dl; }
    const a = BY_ID[e.a], sid8 = e.sid.slice(0, 8);
    const isLive = liveNames.has('web-' + sid8);
    const t = titles[i].title;
    const go = a.term && canResume(e.mt, isLive) ? `<a class="go" data-nw="t-${sid8}" href="/term/?arg=open&amp;arg=${sid8}&amp;v=3" title="${isLive ? 'attach (live)' : 'resume in terminal'}" aria-label="${isLive ? 'attach in terminal (live)' : 'resume in terminal'}">&gt;_</a>` : '';
    // delete = same no-JS <details> confirm as kill; hidden on live sessions (kill first)
    const del = isLive ? '' : `<details class="kx del"><summary class="dx" title="delete transcript" aria-label="delete transcript ${sid8}">✕</summary><div class="kc"><div>delete <b>${sid8}</b>?</div><span class="muted">removes the transcript from disk — no undo.</span><form class="af" method="post" action="/a/del"><input type="hidden" name="a" value="${e.a}"><input type="hidden" name="sid" value="${esc(e.sid)}"><input type="hidden" name="back" value="${esc(back)}"><button class="ab danger">delete it</button></form></div></details>`;
    items += `<div class="li"><a class="row" href="/s/${e.a}/${e.sid}">
<span class="t">${rel(e.mt)}</span>
<span class="acct" style="color:${a.color}">${a.label}</span>
<span class="proj">${esc(projName(e.proj))}</span>
<span class="ttl">${isLive ? '<b style="color:#34d399">● live</b> ' : ''}${esc(t) || '<span class="muted">(no title)</span>'}</span>
<span class="sz">${fmtSz(e.sz)}</span><span class="sid">${sid8}</span></a>${go}${del}</div>`;
  });

  const label = HOST_ACCT[sub] ? sub : '';
  const body = `<h1><a href="/">mows sessions</a>${label ? ` <span class="muted">· ${esc(label)}</span>` : ''}</h1>
<div class="bar">${chips}</div>
<div class="bar">${dchips}
<form action="/" method="get">${['acct', 'd', 's'].map(k => P[k] ? `<input type="hidden" name="${k}" value="${esc(P[k])}">` : '').join('')}
<input type="search" name="q" value="${esc(q)}" placeholder="filter path / id…" aria-label="Filter by project path or session id"></form>
<a class="chip navdup" href="/term/?v=3">⌨ terminal</a><a class="chip navdup" href="/watch">🖥 watch</a><a class="chip navdup" href="/droid">📱 android</a></div>
${sysPanel()}
${liveHtml}
${items || '<p class="muted" style="padding:20px 0">no sessions match.</p>'}
${pager('/', P, cur, max, `<span class="muted">${rows.length}</span>`)}`;
  send(req, res, 200, page('mows sessions', body, '', '', 'sessions'));
}

async function detailView(req, res, a, sid) {
  freshen();
  const e = index.find(x => x.a === a && x.sid === sid);
  if (!e) return send(req, res, 404, page('not found', '<p>session not found. <a href="/">← back</a></p>'));
  let s;
  try { s = await loadSession(e); }
  catch (err) { return send(req, res, 500, page('error', `<p>could not read transcript: ${esc(err.message)}</p>`)); }
  const acct = BY_ID[a], sid8 = sid.slice(0, 8);
  const n = s.msgs.length, max = Math.max(1, Math.ceil(n / MSG_PAGE));
  const cur = Math.min(max, Math.max(1, +(new URL(req.url, 'http://x').searchParams.get('page') || 1) || 1));
  // page 1 = newest slice; render chronologically within the page
  const end = n - (cur - 1) * MSG_PAGE, start = Math.max(0, end - MSG_PAGE);
  const lv = (await tmuxLive()).find(l => l.name === 'web-' + sid8);
  const live = !!lv;

  const msgs = s.msgs.slice(start, end).map(m => {
    if (m.role === 'tool') return `<details><summary>⚙ ${esc(m.name)}</summary><pre>${esc(m.text)}</pre></details>`;
    if (m.role === 'res') return `<details><summary>↳ result</summary><pre>${esc(m.text)}</pre></details>`;
    if (m.role === 'sum') return `<details><summary>⟲ compaction summary</summary><pre>${esc(m.text)}</pre></details>`;
    const who = m.role === 'user' ? 'you' : 'claude';
    const big = m.text.length > 2500;
    const body = big
      ? `<details><summary>${esc(m.text.slice(0, 200))}…</summary><pre>${esc(m.text)}</pre></details>`
      : `<pre>${esc(m.text)}</pre>`;
    return `<div class="m ${m.role}"><div class="mh"><b>${who}</b> · ${m.ts ? esc(m.ts.slice(11, 19)) : ''}</div>${body}</div>`;
  }).join('');

  const term = acct.term
    ? (canResume(e.mt, live)
      ? `<div class="la" style="justify-content:flex-start"><a class="btn" data-nw="t-${sid8}" href="/term/?arg=open&amp;arg=${sid8}&amp;v=3">&gt;_ ${live ? (lv.paused ? 'attach — paused' : 'attach — live now') : 'open in terminal'}</a>${lv ? actForms(lv, `/s/${a}/${sid}`) : ''}</div>`
      : `<p class="muted" style="margin:8px 0">resume disabled — idle ${rel(e.mt)} (cutoff ${RESUME_DAYS}d). transcript stays readable; resume manually with <span style="font-family:var(--mono)">cc -r</span> if you really need it.</p>`)
    : '';
  const pgr = pager(`/s/${a}/${sid}`, {}, cur, max,
    `<span class="muted">${n} items · newest first</span>`);
  const body = `<h1><a href="/">← sessions</a></h1>
<div class="meta">
<div>session</div><div>${esc(sid)} ${live ? '<b style="color:#34d399">● live</b>' : ''}</div>
<div>account</div><div style="color:${acct.color}">${acct.label}</div>
<div>project</div><div>${esc(s.meta.cwd || projName(e.proj))}</div>
<div>started</div><div>${abs(s.meta.firstTs)}</div>
<div>last</div><div>${abs(e.mt)} (${rel(e.mt)} ago)</div>
<div>size</div><div>${fmtSz(e.sz)} · ${n} items · ${s.meta.tools} tool calls${s.meta.model ? ' · ' + esc(s.meta.model) : ''}</div>
</div>
${term}
${s.truncated ? '<div class="note">large transcript — showing the most recent 8MB window.</div>' : ''}
${pgr}${msgs || '<p class="muted">no displayable messages.</p>'}${pgr}`;
  send(req, res, 200, page(`${sid8} · ${projName(e.proj)}`, body, '', '', 'sessions'));
}

// ---------- server ----------
const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, 'http://x');
    const p = url.pathname;
    if (p === '/healthz') return send(req, res, 200,
      JSON.stringify({ ok: true, sessions: index.length, scannedAgo: Math.round((Date.now() - lastScan) / 1000) }), 'application/json');
    if (p === '/z') { res.writeHead(204); return res.end(); } // geometry beacon sink — the query lands in the access log
    if (p === '/shot') { // image uploads from the terminal's 📸 key -> disk, so claude can look at them
      if (req.method === 'POST') {
        const chunks = []; let n = 0;
        for await (const c of req) { n += c.length; if (n > 15e6) { res.writeHead(413); return res.end('too big'); } chunks.push(c); }
        const dir = '/opt/claude-dashboard/shots';
        await fsp.mkdir(dir, { recursive: true });
        // retention: uploads are transient "look at this" attachments — prune >7d on
        // each upload (rare enough that a cron would be more machinery for the same result)
        try { for (const f of await fsp.readdir(dir)) {
          if (Date.now() - (await fsp.stat(`${dir}/${f}`)).mtimeMs > 7 * 864e5) await fsp.unlink(`${dir}/${f}`);
        } } catch {}
        const ct = req.headers['content-type'] || '';
        const ext = { 'image/png': 'png', 'image/webp': 'webp', 'image/gif': 'gif' }[ct] || (ct.includes('png') ? 'png' : 'jpg');
        const path = `${dir}/shot-${Date.now()}.${ext}`;
        await fsp.writeFile(path, Buffer.concat(chunks));
        // path goes back to the caller: the terminal's 📸 key pastes it into the prompt
        res.writeHead(200, { 'content-type': 'application/json' }); return res.end(JSON.stringify({ ok: true, path }));
      }
      // old standalone upload page retired — the 📸 key in /term replaced it
      res.writeHead(302, { location: '/' }); return res.end();
    }
    if (p === '/a/del') {
      if (req.method !== 'POST') { res.writeHead(405); return res.end('POST only'); }
      return await delSession(req, res);
    }
    if (p.startsWith('/a/')) {
      if (req.method !== 'POST') { res.writeHead(405); return res.end('POST only'); }
      return await action(req, res, url);
    }
    if (p === '/watch') return await watchView(req, res);
    if (p === '/droid') return await droidView(req, res);
    if (p === '/droid/touchtest') return send(req, res, 200, TOUCHTEST);
    if (p === '/droid/start' || p === '/droid/stop') {
      if (req.method !== 'POST') { res.writeHead(405); return res.end('POST only'); }
      return await droidAction(req, res, p);
    }
    if (p === '/watch/start' || p === '/watch/stop') {
      if (req.method !== 'POST') { res.writeHead(405); return res.end('POST only'); }
      return await watchAction(req, res, p);
    }
    if (p === '/' ) return await listView(req, res, url);
    if (p === '/sessions' || p === '/projects') { res.writeHead(302, { location: '/' }); return res.end(); }
    const m = p.match(SESSION_PATH_RE);
    if (m) return await detailView(req, res, m[1], m[2]);
    if (p === '/manifest.webmanifest') return manifest(req, res);
    if (p === '/sw.js') return send(req, res, 200, SW, 'text/javascript; charset=utf-8');
    const isz = { '/icon-192.png': 192, '/icon-512.png': 512, '/apple-touch-icon.png': 180,
                  '/favicon.png': 48, '/favicon.ico': 48 }[p];
    if (isz) {
      const a = hostAcct(req);
      const buf = iconPNG(isz, (a && a.color) || '#34d399');
      res.writeHead(200, { 'content-type': 'image/png', 'content-length': buf.length,
        'cache-control': 'public, max-age=86400' });
      return res.end(buf);
    }
    send(req, res, 404, page('404', '<p>not found. <a href="/">← sessions</a></p>'));
  } catch (err) {
    try { send(req, res, 500, page('error', `<p>error: ${esc(err.message)}</p>`)); } catch {}
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
  console.log(`parsed ${s.msgs.length} items OK — selftest PASS`);
  process.exit(0);
}
await scan().catch(e => console.error('initial scan:', e.message));
setInterval(freshen, 30000).unref();
server.listen(PORT, HOST, () => console.log(`lite dashboard on http://${HOST}:${PORT} — ${index.length} sessions`));
