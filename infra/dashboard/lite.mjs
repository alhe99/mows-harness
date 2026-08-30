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
// The app-shell feel comes from the platform, not a framework: CSS view transitions pin
// the tab bar across navigations, a speculationrules block prerenders dashboard links on
// hover/touch (never /term*, ?fresh=1, ?reclaim=1 — those have side effects), bfcache
// makes back/forward instant (headers are no-cache, never no-store).
import http from 'node:http';
import { promises as fsp, readdirSync, existsSync, readFileSync, statfsSync } from 'node:fs';
import { execFile } from 'node:child_process';
import { gzipSync, deflateSync } from 'node:zlib';
import path from 'node:path';
import net from 'node:net';
import os from 'node:os';
import { randomBytes } from 'node:crypto';

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
const SETTINGS_FILE = flag('--settings-file', process.env.SETTINGS_FILE || '/opt/claude-dashboard/settings.json');

function loadThemeMap() {
  const dir = path.dirname(new URL(import.meta.url).pathname);
  const p1 = path.join(dir, 'themes.json');
  const p2 = path.join(dir, '../webconsole/themes.json');
  for (const p of [p1, p2]) {
    try {
      if (existsSync(p)) return JSON.parse(readFileSync(p, 'utf8'));
    } catch (e) {
      console.warn(`warning: failed to parse themes.json at ${p}:`, e.message);
    }
  }
  console.warn('warning: themes.json not found next to lite.mjs or at ../webconsole/themes.json');
  return {};
}
const THEME_MAP = loadThemeMap();

async function readSettings() {
  try {
    const raw = await fsp.readFile(SETTINGS_FILE, 'utf8');
    const data = JSON.parse(raw);
    return data && typeof data === 'object' ? data : {};
  } catch {
    return {};
  }
}
async function saveSettings(patch) {
  const cur = await readSettings();
  const next = { ...cur, ...patch };
  await fsp.mkdir(path.dirname(SETTINGS_FILE), { recursive: true }).catch(() => {});
  await fsp.writeFile(SETTINGS_FILE, JSON.stringify(next, null, 2) + '\n');
  return next;
}

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
let tmuxInflight = null; // in-flight dedup: /events runs up to SSE_MAX concurrent
// clients each on their own 2s setInterval, so a cache-miss moment is hit by several
// callers within a few ms of each other — share ONE recompute (same pattern as
// `scanning` above) instead of each firing its own runuser+tmux exec chain.
// 5s: the runuser+PAM+tmux chain can exceed 2s cold on this 2-core box right
// after a restart (seen 2026-07-07 under the sandbox rollout) — a timeout here
// silently blanks the live panel for 3s (cache), so keep headroom.
const sh = (cmd, args) => new Promise(r => execFile(cmd, args, { timeout: 5000 }, (e, out) => r(e ? '' : out)));
async function tmuxLive() {
  if (Date.now() - tmuxCache.t < 3000) return tmuxCache.list;
  if (tmuxInflight) return tmuxInflight;
  tmuxInflight = tmuxLiveCompute().finally(() => { tmuxInflight = null; });
  return tmuxInflight;
}
async function tmuxLiveCompute() {
  const out = await sh('runuser', ['-u', TMUX_USER, '--', 'tmux', 'list-panes', '-a', '-F',
    '#{session_name}\t#{?session_attached,1,0}\t#{session_created}\t#{session_activity}\t#{pane_pid}\t#{pane_current_path}\t#{pane_id}\t#{@sid}\t#{@label}']);
  const list = [];
  for (const l of out.trim().split('\n').filter(Boolean)) {
    const [name, att, created, activity, pid, cwd, paneId, sid, ...rest] = l.split('\t'); // @label last: user text may hold tabs
    if (list.some(x => x.name === name)) continue; // first pane per session
    // paneId (%NN) is what fleetState()'s capture-pane needs — NEVER '=name' for
    // capture-pane/display-message/respawn-pane, only for session-target commands
    // (kill-session, has-session, attach) — see tasks/lessons.md, three prior burns.
    // session_activity (bumped on any pane output) is fleetState()'s fallback "last seen"
    // signal — session_created (bug 2026-08-28: showed "idle 24h" for a session opened
    // yesterday but active 9m ago) is when the tmux session was FIRST opened, unrelated
    // to recent activity, and stays wrong for the session's entire lifetime.
    list.push({ name, sid, attached: att === '1', created: +created * 1000, activity: +activity * 1000, pid: +pid, cwd, paneId, label: rest.join(' ').trim(), paused: false });
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

// ---------- fleet snippet: "what is it doing now" (last 16KB, newest message, mtime-cached) ----------
// mirror of titleOf() above but reads the TAIL of the transcript, not the head — titleOf
// stays the session's opening ask (history rows); this is the fleet card/row snippet.
const tailCache = new Map(); // path -> {mt, text}
async function tailOf(e) {
  const hit = tailCache.get(e.path);
  if (hit && hit.mt === e.mt) return hit;
  let text = '';
  try {
    const fh = await fsp.open(e.path, 'r');
    const size = e.sz != null ? e.sz : (await fh.stat()).size;
    const WBYTES = 16384;
    const start = Math.max(0, size - WBYTES);
    const buf = Buffer.alloc(Math.min(WBYTES, size));
    await fh.read(buf, 0, buf.length, start);
    await fh.close();
    let raw = buf.toString('utf8');
    if (start > 0) raw = raw.slice(raw.indexOf('\n') + 1); // drop a partial first line
    const lines = raw.split('\n');
    for (let i = lines.length - 1; i >= 0; i--) { // newest line first
      if (!lines[i]) continue;
      let j; try { j = JSON.parse(lines[i]); } catch { continue; }
      if (j.type === 'assistant' && j.message) {
        const c = j.message.content;
        const t = Array.isArray(c) ? (c.find(x => x.type === 'text') || {}).text : (typeof c === 'string' ? c : '');
        if (t) { text = t; break; } // newest assistant text wins outright
      } else if (j.type === 'user' && j.message) {
        const c = j.message.content;
        const t = typeof c === 'string' ? c : Array.isArray(c) ? (c.find(x => x.type === 'text') || {}).text : '';
        if (t && !t.startsWith('<')) { text = t; break; } // skip command/meta xml, same rule as titleOf
      }
    }
  } catch {}
  text = text.replace(/\s+/g, ' ').trim().slice(0, 160);
  const v = { mt: e.mt, text };
  if (tailCache.size > 4000) tailCache.clear();
  tailCache.set(e.path, v);
  return v;
}

// ---------- fleet classification (Fleet Redesign §1) ----------
// Every regex the fleet state engine leans on lives HERE, in one place, commented as
// what it is: a heuristic tuned against Claude Code's TUI as of 2026-08. When the TUI's
// copy changes these degrade to working/idle — never crash — but will need updating.
const FLEET_RE = {
  // a permission/confirmation dialog waiting on the user, or a numbered-option list
  // (its selected row is prefixed with the "❯" cursor glyph)
  dialog: /Do you want\b|❯\s*\d+[.)]/,
  // the idle input box's footer hint — only rendered when nothing is running
  idlePrompt: /\?\s*for shortcuts/,
  // actively streaming a reply or running a tool
  working: /esc to interrupt/i,
  // a background Workflow-tool monitor screen (superpowers workflow-authoring) replaces
  // the normal prompt entirely while agents run — no "esc to interrupt" ever appears here,
  // but its own footer/banner are just as stable a busy-signal. Bug 2026-08-28: a live
  // multi-phase workflow rendered as idle because only `working` above was checked.
  workflowMonitor: /\bstop workflow\b|Waiting for \d+[^\n]*\bworkflow\b/i,
};
// pure classifier — no I/O, no closures over live state — so it's unit-testable in
// isolation (see the --selftest fixture block at the bottom of this file).
// First match wins, exactly per the spec table: paused > needs-you > working > idle.
function classifyFleet({ paused, tail = '', mt = 0 }) {
  if (paused) return 'paused';
  if (FLEET_RE.dialog.test(tail)) return 'needs-you';
  // idle prompt showing + the transcript's last turn finished < 10 min ago = work
  // completed but not yet seen. mt=0 (no transcript match) can never satisfy this —
  // sessions with no transcript row classify on pane signals alone, per spec.
  if (mt && Date.now() - mt < 600000 && FLEET_RE.idlePrompt.test(tail) && !FLEET_RE.working.test(tail)) return 'needs-you';
  if (FLEET_RE.working.test(tail) || FLEET_RE.workflowMonitor.test(tail) || (mt && Date.now() - mt < 45000)) return 'working';
  return 'idle';
}
let fleetCache = { t: 0, list: [] };
let fleetInflight = null; // in-flight dedup, same reason as tmuxInflight above: several
// /events clients' 2s ticks land in the same post-expiry window and must share one
// recompute (1 capture-pane exec per live session) instead of each starting its own.
// per live session: join its transcript (liveSid8 -> index row), a FRESH stat of that
// transcript (the 15s-stale index mtime is too coarse for "working right now"), and a
// pane tail via capture-pane -t <pane_id> (pane_id, never '=name' — see FLEET_RE block
// above and tasks/lessons.md). Sorted needs-you -> working -> paused -> idle, ties by
// mtime desc. Cached 3s, same policy as tmuxCache.
async function fleetState() {
  if (Date.now() - fleetCache.t < 3000) return fleetCache.list;
  if (fleetInflight) return fleetInflight;
  fleetInflight = fleetStateCompute().finally(() => { fleetInflight = null; });
  return fleetInflight;
}
async function fleetStateCompute() {
  const live = await tmuxLive();
  const list = await Promise.all(live.map(async l => {
    const sid8 = liveSid8(l);
    const row = sid8 ? index.find(e => TERM_IDS.has(e.a) && e.sid.startsWith(sid8)) : null;
    let mt = 0, sz = 0;
    if (row) {
      try { const st = await fsp.stat(row.path); mt = st.mtimeMs; sz = st.size; }
      catch { mt = row.mt; sz = row.sz; }
    }
    const tail = l.paneId
      ? await sh('runuser', ['-u', TMUX_USER, '--', 'tmux', 'capture-pane', '-p', '-S', '-12', '-t', l.paneId])
      : '';
    const state = classifyFleet({ paused: l.paused, tail, mt });
    const proj = row ? projName(row.proj) : (l.cwd || '').split('/').filter(Boolean).slice(-1)[0] || '';
    const snippet = row ? (await tailOf({ path: row.path, mt, sz })).text : '';
    // display "seen X ago" prefers the transcript write, else tmux's own last-activity
    // timestamp, else (no tmux report at all, shouldn't happen) session creation — NOT
    // session_created as the primary fallback, see the tmuxLive() comment on why.
    return { name: l.name, sid8, a: row ? row.a : '', label: l.label || '', proj, row,
             mt: mt || l.activity || l.created, state, paused: l.paused, attached: l.attached, snippet, l };
  }));
  const ORDER = { 'needs-you': 0, working: 1, paused: 2, idle: 3 };
  list.sort((x, y) => ORDER[x.state] - ORDER[y.state] || y.mt - x.mt);
  fleetCache = { t: Date.now(), list };
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
// which transcript a live session is: web-term.sh stamps @sid on the sessions it starts
// (2026-08-25; names are cc-<profile>-<dir> now, shared with the cc CLI). Sessions from
// before that are still named web-<sid8> — keep reading those until they are gone.
const liveSid8 = l => (l.sid || (l.name.startsWith('web-') ? l.name.slice(4) : '')).slice(0, 8);
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
  } else if (act === 'label') { // name a live session (empty = clear); tmux titles show it in browser tabs
    const label = (b.label || '').replace(/[\x00-\x1f\x7f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 60);
    // through ccname, not tmux directly: it also writes ~/.local/state/cc-labels/<name>, which is
    // what brings the label back after the tmux server dies (2026-08-25: twice in one night)
    await runAs([], 'ccname', ['-t', name, ...(label ? [label] : [])], 10000);
  } else { res.writeHead(404); return res.end(); }
  tmuxCache.t = 0;
  res.writeHead(303, { location: back }); res.end();
}

// ---------- /a/restartall: respawn every live pane in one press ----------
// The chore this kills: Claude Code prints "Update installed · Restart to update" and every
// live session has to be bounced by hand. Same move as the terminal's ⟳ key (70-ccrst) but
// server-side and for all of them — tmux re-runs each pane's ORIGINAL command.
//
// Plain respawn is only 1:1 for web-* panes, whose command already carries their session id.
// Bare cc/ccw panes were started with no -c/-r, so respawning them verbatim opens a FRESH
// chat — so those get `--resume <sid>` appended, pinned to their own transcript: freshest in
// the pane's cwd, same account, started since the pane did, and not a sid another pane owns
// (that last filter is what stops two panes landing on one conversation and interleaving it).
// ponytail: active pane per session only, exactly like ⟳; extra windows are left alone.
async function restartAll(req, res) {
  const host = req.headers.host || '';
  if (!sameOrigin(req, host)) { res.writeHead(403); return res.end('bad origin'); }
  const b = await readBody(req);
  const bk = b.back || '/';
  const back = bk.startsWith('/') && !bk.startsWith('//') ? bk : '/';
  tmuxCache.t = 0;
  const live = await tmuxLive();
  const claimed = new Set(live.map(l => l.sid).filter(Boolean));
  // Pane id (%NN), not '=name': tmux resolves '=' for SESSION targets (kill-session above),
  // but respawn-pane wants a pane and answers "can't find pane: =<name>" for it.
  // #{pane_start_command} arrives wrapped in double quotes with inner ones backslash-escaped.
  // ponytail: string append, not an argv rebuild — the wrapper paths have no spaces in them.
  const panes = new Map();
  const raw = await sh('runuser', ['-u', TMUX_USER, '--', 'tmux', 'list-panes', '-a', '-F', '#{session_name}\t#{pane_id}\t#{pane_start_command}']);
  for (const line of raw.trim().split('\n').filter(Boolean)) {
    const [name, id, ...rest] = line.split('\t');
    if (name && id && !panes.has(name)) panes.set(name, { id, cmd: rest.join('\t').replace(/^"|"$/g, '').replace(/\\(.)/g, '$1').trim() });
  }
  let n = 0;
  for (const l of live) {
    // a SIGSTOPped pane is continued first: SIGKILL would land either way, but its stopped
    // children would linger holding the cwd and the MCP sockets the fresh claude wants.
    if (l.paused) { const k = await descendants(l.pid); if (k.length) await sh('kill', ['-CONT', '--', ...k.map(String)]); }
    const pane = panes.get(l.name);
    if (!pane) continue; // vanished between the two tmux calls
    const cmd = pane.cmd;
    let arg = [];
    if (!l.sid && cmd && !/--resume|--continue|(?:^|\s)-[cr](?:\s|$)/.test(cmd)) {
      const cfg = (/CLAUDE_CONFIG_DIR=(\S+)/.exec(cmd) || [])[1];
      const acct = ACCTS.find(a => a.home === cfg);
      const proj = (l.cwd || '').replace(/[/.]/g, '-');
      const e = acct && index.filter(x => x.a === acct.id && x.proj === proj && x.mt >= l.created && !claimed.has(x.sid))
        .reduce((a, x) => (!a || x.mt > a.mt ? x : a), null);
      if (e) { claimed.add(e.sid); arg = [cmd + ' --resume ' + e.sid]; }
    }
    await sh('runuser', ['-u', TMUX_USER, '--', 'tmux', 'respawn-pane', '-k', '-t', pane.id, ...arg]);
    n++;
  }
  tmuxCache.t = 0;
  const u = new URL(back, 'http://x'); u.searchParams.set('rs', String(n)); // set, not append: re-presses don't stack rs=
  res.writeHead(303, { location: u.pathname + u.search }); res.end();
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
  if ((await tmuxLive()).some(l => liveSid8(l) === sid.slice(0, 8))) {
    res.writeHead(409); return res.end('session is live — kill it first');
  }
  try { await fsp.unlink(e.path); } catch {}
  index = index.filter(x => x !== e);
  counts[a] = Math.max(0, (counts[a] || 1) - 1);
  titleCache.delete(e.path); parseCache.delete(e.path);
  res.writeHead(303, { location: back }); res.end();
}

// ---------- /a/switch: tmux switch-client for the shell's single terminal iframe (§2) ----------
async function switchAction(req, res) {
  const host = req.headers.host || '';
  if (!sameOrigin(req, host)) { res.writeHead(403); return res.end('bad origin'); }
  const b = await readBody(req);
  const tab = b.tab || '', to = b.to || '';
  const j = o => { res.writeHead(res.statusCode, { 'content-type': 'application/json' }); res.end(JSON.stringify(o)); };
  if (!/^[0-9a-f]{8}$/.test(tab)) { res.statusCode = 400; return j({ err: 'bad tab' }); }
  const live = await tmuxLive();
  if (!(live.some(l => l.name === to) || /^[0-9a-f]{8}$/.test(to))) { res.statusCode = 400; return j({ err: 'bad to' }); }
  const code = await runAsCode([], WEBTERM_SH, ['switch', tab, to], 20000);
  if (code === 0) { res.statusCode = 200; return j({ ok: true, current: to }); }
  if (code === 2) { res.statusCode = 409; return j({ err: 'tab not attached' }); }
  if (code === 3) { res.statusCode = 404; return j({ err: 'unknown session' }); }
  res.statusCode = 500; return j({ err: 'switch failed' });
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
  res.writeHead(303, { location: '/device?dv=web' }); res.end();
}

// ---------- Device tab: lucide-style inline icon set (spec ADDENDUM 36:852) ----------
// Hand-inlined (no icon font/webfont/download): stroke=currentColor, 2px stroke, viewBox
// 0 0 24 24, ~2-3 paths each — per spec, unicode glyphs are not acceptable here. Only
// icons with a REAL control behind them are drawn: camera/video/rotate/volume-±/power/home
// (the mock's android "hardware keys") have no backing dashboard action — ws-scrcpy's own
// in-frame toolbar already covers power/volume/back/home — so per the "don't fabricate
// controls for pixel parity" rule those are intentionally not implemented here.
const ICO = {
  smartphone: `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="6" y="2" width="12" height="20" rx="2"/><path d="M11 18h2"/></svg>`,
  monitor: `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="2" y="4" width="20" height="13" rx="2"/><path d="M8 21h8M12 17v4"/></svg>`,
  refresh: `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M21 12a9 9 0 1 1-3-6.7"/><path d="M21 3v6h-6"/></svg>`,
  arrowLeft: `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M19 12H5"/><path d="M12 19l-7-7 7-7"/></svg>`,
  square: `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="5" y="5" width="14" height="14" rx="2"/></svg>`,
  cast: `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M2 12a9 9 0 0 1 8 8"/><path d="M2 8a13 13 0 0 1 12 12"/><circle cx="2.5" cy="19.5" r="1" fill="currentColor" stroke="none"/></svg>`,
  play: `<svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor" stroke="none" aria-hidden="true"><path d="M6 4l14 8-14 8z"/></svg>`,
  keyboard: `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="2" y="6" width="20" height="12" rx="2"/><path d="M6 14h12M6 10h.01M10 10h.01M14 10h.01M18 10h.01"/></svg>`,
  clipboard: `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="8" y="2" width="8" height="4" rx="1"/><path d="M8 4H6a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V6a2 2 0 0 0-2-2h-2"/></svg>`,
  chevronUp: `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M18 15l-6-6-6 6"/></svg>`,
  chevronDown: `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M6 9l6 6 6-6"/></svg>`,
  chevronLeft: `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M15 18l-6-6 6-6"/></svg>`,
  chevronRight: `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M9 18l6-6-6-6"/></svg>`,
  chevronsLeft: `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M11 17l-5-5 5-5"/><path d="M18 17l-5-5 5-5"/></svg>`,
  chevronsRight: `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M6 17l5-5-5-5"/><path d="M13 17l5-5-5-5"/></svg>`,
  history: `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M3 12a9 9 0 1 0 9-9 9.75 9.75 0 0 0-6.74 2.74L3 8"/><path d="M3 3v5h5"/><path d="M12 7v5l4 2"/></svg>`,
  activity: `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M22 12h-4l-3 9L9 3l-3 9H2"/></svg>`,
  list: `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M8 6h13M8 12h13M8 18h13M3 6h.01M3 12h.01M3 18h.01"/></svg>`,
  monitorSmartphone: `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M18 8V6a2 2 0 0 0-2-2H4a2 2 0 0 0-2 2v7a2 2 0 0 0 2 2h8"/><path d="M7 19h5"/><rect x="16" y="12" width="6" height="10" rx="2"/></svg>`,
  x: `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M18 6 6 18M6 6l12 12"/></svg>`,
  pencil: `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M17 3a2.85 2.83 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5Z"/></svg>`,
  pause: `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="6" y="4" width="4" height="16" rx="1"/><rect x="14" y="4" width="4" height="16" rx="1"/></svg>`,
  ellipsis: `<svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor" stroke="none" aria-hidden="true"><circle cx="5" cy="12" r="1.6"/><circle cx="12" cy="12" r="1.6"/><circle cx="19" cy="12" r="1.6"/></svg>`,
  trash: `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M3 6h18"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6"/><path d="M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/></svg>`,
  terminal: `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m4 17 6-6-6-6"/><path d="M12 19h8"/></svg>`,
  plus: `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 5v14M5 12h14"/></svg>`,
  wrench: `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M14.7 6.3a1 1 0 0 0 0 1.4l1.6 1.6a1 1 0 0 0 1.4 0l3.77-3.77a6 6 0 0 1-7.94 7.94l-6.91 6.91a2.12 2.12 0 0 1-3-3l6.91-6.91a6 6 0 0 1 7.94-7.94l-3.76 3.76z"/></svg>`,
  search: `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="11" cy="11" r="8"/><path d="m21 21-4.35-4.35"/></svg>`,
};
// spec empty-state / stage helper (icon box + mono message + dim caption, node 36:651)
function stageEmpty(icon, msg, cap) {
  return `<div class="stageempty"><div class="stageicon">${icon}</div><div class="stagemsg">${esc(msg)}</div><p class="stagecap">${cap}</p></div>`;
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
  if (!run) return { state: 'stopped', res: '' };
  const boot = (await sh('adb', ['-s', DROID_UDID, 'shell', 'getprop', 'sys.boot_completed'])).trim();
  if (boot !== '1') return { state: 'booting', res: '' };
  const wm = (await sh('adb', ['-s', DROID_UDID, 'shell', 'wm', 'size'])).trim(); // "Physical size: 1080x1920"
  const m = /(\d+)x(\d+)/.exec(wm);
  return { state: 'live', res: m ? `${m[1]}×${m[2]}` : '' };
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
  res.writeHead(303, { location: '/device?dv=mobile' }); res.end();
}
// ---------- Device tab, Mobile (Android) rail + stage — spec 36:651 ----------
// device info card: real facts only (state, resolution via `adb shell wm size` when
// live, target udid) — a disconnected device shows no LIVE badge (spec's own rule).
function androidInfoCard(st) {
  const live = st.state === 'live';
  const label = live ? 'RUNNING' : st.state === 'booting' ? 'BOOTING' : 'STOPPED';
  const badge = live ? `<span class="lvb2"><i></i>LIVE</span>` : '';
  return `<div class="devcard">
<div class="devhead"><div><div class="devname">Android Emulator</div><div class="devsub">redroid · ${esc(DROID_UDID)}</div></div>${badge}</div>
<div class="devrows">
<div class="devrow"><span>STATE</span><span class="${live ? 'good' : ''}">${label}</span></div>
${st.res ? `<div class="devrow"><span>RESOLUTION</span><span>${esc(st.res)}</span></div>` : ''}
<div class="devrow"><span>TARGET</span><span>${esc(DROID_UDID)}</span></div>
</div></div>`;
}
function androidControlCard(st) {
  const live = st.state === 'live';
  const primary = live
    ? `<form class="af ctlform" method="post" action="/droid/stop"><button class="ctlbtn wide danger" type="submit">${ICO.square}Stop Emulator</button></form>`
    : `<form class="af ctlform" method="post" action="/droid/start"><button class="ctlbtn wide ok" type="submit">${ICO.play}Start Emulator</button></form>`;
  return `<div class="devcard">
<div class="ctlhead">Emulator</div>
<div class="ctlgrid">
${primary}
<a class="ctlbtn" href="/device?dv=mobile">${ICO.refresh}Refresh</a>
<a class="ctlbtn" href="/droidview/" target="_blank" rel="noopener">${ICO.cast}Console</a>
</div>
<p class="dangercap">redroid (native-arch Android 15, no KVM) streams here via ws-scrcpy — interact directly in the frame on the right; its own slim in-frame toolbar has power/volume/back/home. install an apk from the <a href="${termHref('menu', '')}">terminal</a>: <b>adb -s ${esc(DROID_UDID)} install app.apk</b> · run a QA flow: <b>maestro --device ${esc(DROID_UDID)} test flow.yaml</b>.</p>
</div>`;
}
function androidStage(req, st) {
  if (st.state === 'live') {
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
    if (mobile) {
      return { html: `<div class="stageempty"><a class="ctlbtn ok stagecta" href="${streamUrl}">${ICO.play}Open Screen (full page)</a>
<p class="stagecap">opens the device full-screen so touch maps correctly on iOS — use your browser's back to return here.</p></div>`, fill: false };
    }
    return { html: `<iframe class="vnc" title="Android emulator (redroid remote view)" src="${streamUrl}"></iframe>`, fill: true };
  }
  if (st.state === 'booting') {
    return { html: stageEmpty(ICO.smartphone, 'Awaiting stream…', 'android is booting (~15s) — a containerized Android 15 (redroid). this page refreshes itself.'), fill: false };
  }
  return { html: stageEmpty(ICO.smartphone, 'Awaiting stream…', 'press <b>start emulator</b> — a containerized Android 15 (redroid, native-arch, no KVM) boots in ~15s and its screen appears here.'), fill: false };
}

// ---------- /settings: global terminal theme configuration + live preview ----------
async function termThemeAction(req, res) {
  const host = req.headers.host || '';
  if (!sameOrigin(req, host)) { res.writeHead(403); return res.end('bad origin'); }
  const chunks = [];
  let n = 0;
  for await (const c of req) {
    n += c.length;
    if (n > 4096) { res.writeHead(400); return res.end('too large'); }
    chunks.push(c);
  }
  let body;
  try { body = JSON.parse(Buffer.concat(chunks).toString('utf8')); }
  catch { res.writeHead(400); return res.end('invalid json'); }
  if (!body || typeof body.name !== 'string') { res.writeHead(400); return res.end('invalid body'); }
  const name = body.name;
  if (name !== '' && !Object.prototype.hasOwnProperty.call(THEME_MAP, name)) {
    res.writeHead(400); return res.end('unknown theme');
  }
  await saveSettings({ termTheme: name });
  res.writeHead(200, { 'content-type': 'application/json' });
  return res.end(JSON.stringify({ ok: true, name }));
}

// ---------- Device tab, Web (noVNC) rail + stage — spec 36:651 ----------
function browserInfoCard(up) {
  const badge = up ? `<span class="lvb2"><i></i>LIVE</span>` : '';
  return `<div class="devcard">
<div class="devhead"><div><div class="devname">QA Browser</div><div class="devsub">Xvfb :99 · Chrome (noVNC)</div></div>${badge}</div>
<div class="devrows">
<div class="devrow"><span>STATE</span><span class="${up ? 'good' : ''}">${up ? 'LIVE' : 'IDLE'}</span></div>
<div class="devrow"><span>PORT</span><span>6080</span></div>
</div></div>`;
}
function browserControlCard(up) {
  const primary = up
    ? `<form class="af ctlform" method="post" action="/watch/stop"><button class="ctlbtn wide danger" type="submit">${ICO.square}Stop Browser</button></form>`
    : `<form class="af ctlform" method="post" action="/watch/start"><button class="ctlbtn wide ok" type="submit">${ICO.play}Start Browser</button></form>`;
  return `<div class="devcard">
<div class="ctlhead">Browser</div>
<div class="ctlgrid">
${primary}
<a class="ctlbtn wide" href="/device?dv=web">${ICO.refresh}Refresh</a>
</div>
<p class="dangercap">run a QA journey in <b>watched</b> mode; when the agent needs you (a login/OTP, or an eyeball on a UI change) it pauses and the browser shows up on the right — take over right in the frame, then tell the agent <b>continue</b> in the <a href="${termHref('menu', '')}">terminal</a>.</p>
</div>`;
}
// remote-keys card: the old .wbar toolbar's real key-injection buttons, restyled as an
// icon-only ControlButton grid (spec: "icon-only buttons for hardware keys"). Only
// rendered when the browser is actually live — same gate the old .wbar had, since these
// onclick handlers reach into the live iframe's RFB session.
function remoteKeysCard() {
  return `<div class="devcard">
<div class="ctlhead">Remote keys</div>
<div class="ctlgrid icons4">
<button class="ctlbtn" type="button" onclick="kb()" title="show keyboard" aria-label="show keyboard">${ICO.keyboard}</button>
<button class="ctlbtn" type="button" onclick="pst()" title="paste clipboard" aria-label="paste clipboard">${ICO.clipboard}</button>
<button class="ctlbtn" type="button" onclick="k(0xff55,'PageUp')" title="scroll up" aria-label="scroll up">${ICO.chevronUp}</button>
<button class="ctlbtn" type="button" onclick="k(0xff56,'PageDown')" title="scroll down" aria-label="scroll down">${ICO.chevronDown}</button>
<button class="ctlbtn" type="button" onclick="nav(1)" title="back" aria-label="back">${ICO.arrowLeft}</button>
<button class="ctlbtn icoflip" type="button" onclick="nav(0)" title="forward" aria-label="forward">${ICO.arrowLeft}</button>
<button class="ctlbtn" type="button" onclick="k(0xffc2,'F5')" title="reload" aria-label="reload">${ICO.refresh}</button>
<button class="ctlbtn" type="button" onclick="k(0xff1b,'Escape')" title="escape" aria-label="escape">${ICO.square}</button>
</div>
</div>`;
}
function remoteKeysScript() {
  // path=vnc/websockify: noVNC builds its WS URL as wss://host/<path> (root-relative, NOT
  // relative to /vnc/vnc.html), so the default 'websockify' would miss the /vnc/* route and
  // hit the dashboard. We reach noVNC's live RFB by re-importing ui.js in the same-origin
  // iframe (ES-module singleton → same UI.rfb); the keyboard button pops the phone keyboard.
  return `<script>
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
}
function browserStage(up) {
  if (up) {
    return { html: `<iframe id="vf" class="vnc" title="QA browser (noVNC remote view)" src="/vnc/vnc.html?autoconnect=1&amp;resize=scale&amp;reconnect=1&amp;quality=9&amp;compression=6&amp;path=vnc/websockify" allow="clipboard-read;clipboard-write"></iframe>`, fill: true };
  }
  return { html: stageEmpty(ICO.monitor, 'Awaiting stream…', 'press <b>start browser</b>, then run a QA journey in <b>watched</b> mode — the agent brings this browser up and you share it.'), fill: false };
}

// ---------- /device: consolidated device/terminal-level controls (gap #3) ----------
// One tab instead of three (settings/android/watch): the redroid Android emulator, the
// QA-watch noVNC takeover browser, and terminal theme + bulk restart, laid out per the
// figma-make addendum (node 36:651) — 320px left rail (segmented Mobile|Web toggle +
// device-info card + control cards) + a dashed right stage hosting the real stream.
// bodyClass stays 'watchlive' whenever either remote-video section is actually live
// (hides the floating terminal FAB so it never overlaps the stream).
async function deviceView(req, res) {
  const url = new URL(req.url, 'http://x');
  const [droidSt, watchUp] = await Promise.all([droidState(), watchLive()]);
  const dvParam = url.searchParams.get('dv');
  // default: whichever device is actually doing something; else Mobile.
  const sel = dvParam === 'web' ? 'web' : dvParam === 'mobile' ? 'mobile'
    : (droidSt.state !== 'stopped' ? 'mobile' : watchUp ? 'web' : 'mobile');
  const toggle = `<div class="segtoggle">
<a class="segbtn${sel === 'mobile' ? ' on' : ''}" href="/device?dv=mobile">${ICO.smartphone}Mobile</a>
<a class="segbtn${sel === 'web' ? ' on' : ''}" href="/device?dv=web">${ICO.monitor}Web</a>
</div>`;
  let infoCard, ctlCards, stageObj, script = '';
  if (sel === 'mobile') {
    infoCard = androidInfoCard(droidSt);
    ctlCards = androidControlCard(droidSt);
    stageObj = androidStage(req, droidSt);
  } else {
    infoCard = browserInfoCard(watchUp);
    ctlCards = browserControlCard(watchUp) + (watchUp ? remoteKeysCard() : '');
    stageObj = browserStage(watchUp);
    if (watchUp) script = remoteKeysScript();
  }
  const rail = `<aside class="devrail">
${toggle}
${infoCard}
${ctlCards}
</aside>`;
  const stage = `<div class="devstage${stageObj.fill ? ' live' : ''}">${stageObj.html}</div>`;
  const bodyClass = (droidSt.state === 'live' || watchUp) ? 'watchlive' : '';
  const head = droidSt.state === 'booting' ? '<meta http-equiv="refresh" content="4">' : '';
  const body = `<h1><a href="/">← sessions</a> <span class="muted">· device</span></h1>
<div class="devlayout">${rail}${stage}</div>
${script}`;
  send(req, res, 200, page('device · mows sessions', body, head, bodyClass, 'device', false, null, req.headers.host));
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
// runAs swallows the exit code (needed by callers that only want stdout-or-empty); /a/switch
// needs the real code to tell "tab not attached" (2) from "unknown session" (3) apart.
const runAsCode = (envs, cmd, args, t = 30000) => new Promise(r =>
  execFile('runuser', ['-u', TMUX_USER, '--', 'env', 'HOME=' + TMUX_HOME, 'PATH=' + RUN_PATH, ...envs, cmd, ...args],
    { timeout: t, maxBuffer: 32e6 }, (e) => r(e ? (typeof e.code === 'number' ? e.code : 1) : 0)));
// terminal-shell page (§1/§2 of the persistent-terminal-shell design): all switching logic
// lives in this one script, called the same way every other tmux-mutating action is.
const WEBTERM_SH = process.env.WEBTERM_SH || '/opt/claude-dashboard/web-term.sh';
const jp = s => { try { return JSON.parse(s); } catch { return null; } };
const mshort = m => String(m).replace(/^claude-/, '');
async function collectUsage(force) {
  // force: the panel's ↻ button — bust claude-quota's own 5-min cache too, so
  // the limit bars re-fetch from the API instead of echoing its cached numbers
  if (force) await runAs([], 'claude-quota', ['--refresh'], 20000);
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
let usageCache = { t: 0, d: null, busy: false, p: null };
function usage(force) {
  if (!usageCache.busy && (force || Date.now() - usageCache.t > 300e3)) {
    usageCache.busy = true;
    usageCache.p = collectUsage(force)
      .then(d => { usageCache = { t: Date.now(), d, busy: false, p: null }; })
      .catch(() => { usageCache.busy = false; usageCache.t = Date.now() - 240e3; }); // retry in 1 min
  }
  return usageCache.d;
}
usage(); // warm the cache at boot so the first visitor already sees numbers
// /system's Environment card VERSION row: `claude --version`, cached 5 min (a fork per
// page load would be wasteful and this never changes between deploys of the CLI itself).
let verCache = { t: 0, v: null };
async function claudeVersion() {
  if (verCache.v != null && Date.now() - verCache.t < 300000) return verCache.v;
  const out = await runAs([], 'claude', ['--version'], 8000);
  const v = out.trim().split('\n')[0] || null; // null -> "?" rendered, same degrade as ccusage-absent elsewhere
  verCache = { t: Date.now(), v };
  return v;
}
// ---------- reclaim: measured, opt-in disk prune (the ⌫ chip in the system panel) ----------
// Memory and CPU are deliberately NOT prunable here, and that is not laziness: the panel's
// memory figure is MemTotal-MemAvailable, which ALREADY excludes the page cache, so
// drop_caches would "free" only bytes the kernel was lending back anyway — and cost a
// re-read of everything hot. The load average is the sessions you asked for. Disk is the
// one resource on a box like this that genuinely leaks: package and build caches grow
// forever and nothing ever prunes them.
// Every target measures itself BEFORE it runs, so the preview never promises bytes it
// cannot free, and the number reported afterwards is a real statfs delta, not the estimate.
// Paths are literals in this table and the POST only picks ids out of it — no request
// input ever reaches an rm. Groups: '' = safe (pre-checked), anything else is opt-in.
const HB = n => n >= 1073741824 ? (n / 1073741824).toFixed(1) + ' G'
  : n >= 1048576 ? (n / 1048576).toFixed(0) + ' M' : (n / 1024).toFixed(0) + ' K';
const bytesOf = s => { // "451.8MB", "874.0M", "33592336" -> bytes
  const m = /^([\d.]+)\s*([kKMGT])?i?[bB]?/.exec(String(s).trim());
  return m ? Math.round(+m[1] * ({ k: 1024, K: 1024, M: 1048576, G: 1073741824, T: 1099511627776 }[m[2]] || 1)) : 0;
};
const rrun = (cmd, args, t = 120000) => new Promise(r =>
  execFile(cmd, args, { timeout: t, maxBuffer: 8e6 }, (e, out) => r(e ? '' : out)));
const du = async p => existsSync(p) ? parseInt(await rrun('du', ['-sbx', p], 60000), 10) || 0 : 0;
const rmrf = p => fsp.rm(p, { recursive: true, force: true });
let dfCache = { t: 0, d: null };
async function dockerDf() { // one `docker system df` serves both docker targets in a scan
  if (dfCache.d && Date.now() - dfCache.t < 10000) return dfCache.d;
  const d = {};
  for (const ln of (await rrun('docker', ['system', 'df', '--format', '{{json .}}'], 20000)).trim().split('\n')) {
    const j = jp(ln); if (j) d[j.Type] = bytesOf(j.Reclaimable);
  }
  dfCache = { t: Date.now(), d };
  return d;
}
const OLD = 7 * 864e5;
// /tmp is shared with the whole OS, so this NEVER sweeps it wholesale — only entries
// matching known tool litter (harness scratchpads, staged-demo trees, MSBuild temps,
// bare-uuid dirs) and only once they are a week cold. Mostly empty dirs: the win is
// 2000 fewer dirents, so the row reports the count, not bytes.
const TMP_LITTER = /^(claude-|mows-shots-|MSBuild\d|[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-)/;
async function tmpStale(kill) {
  let n = 0, b = 0, cut = Date.now() - OLD;
  for (const f of await fsp.readdir('/tmp')) {
    if (!TMP_LITTER.test(f)) continue;
    try {
      const st = await fsp.stat('/tmp/' + f);
      if (st.mtimeMs > cut) continue;
      n++; b += st.size;
      if (kill) await rmrf('/tmp/' + f);
    } catch { /* vanished or not ours */ }
  }
  return { b, extra: n ? n + ' entries' : '' }; // no entries -> no row in the preview
}
async function oldFiles(dir, kill) {
  let n = 0, b = 0, cut = Date.now() - OLD;
  for (const f of await fsp.readdir(dir).catch(() => [])) {
    try {
      const st = await fsp.stat(dir + '/' + f);
      if (st.mtimeMs > cut) continue;
      n++; b += st.size;
      if (kill) await rmrf(dir + '/' + f);
    } catch { /* vanished */ }
  }
  return { b, extra: n ? n + ' files' : '' };
}
const RT = [
  { id: 'journal', label: 'systemd journal', note: 'vacuum down to 200M',
    size: async () => Math.max(0, bytesOf((/take up ([\d.]+\s*[kKMGT]?)/.exec(await rrun('journalctl', ['--disk-usage'])) || [])[1]) - 200 * 1048576),
    run: () => rrun('journalctl', ['--vacuum-size=200M']) },
  { id: 'apt', label: 'apt package cache', note: 're-downloaded on demand',
    size: () => du('/var/cache/apt/archives'), run: () => rrun('apt-get', ['clean']) },
  { id: 'npm', label: 'npm cache', note: '.npm/_cacache',
    size: () => du(`${TMUX_HOME}/.npm/_cacache`), run: () => rmrf(`${TMUX_HOME}/.npm/_cacache`) },
  { id: 'go', label: 'go build cache', note: '.cache/go-build',
    size: () => du(`${TMUX_HOME}/.cache/go-build`), run: () => rmrf(`${TMUX_HOME}/.cache/go-build`) },
  { id: 'uv', label: 'uv python cache', note: '.cache/uv',
    size: () => du(`${TMUX_HOME}/.cache/uv`), run: () => rmrf(`${TMUX_HOME}/.cache/uv`) },
  { id: 'pip', label: 'pip wheel cache', note: '.cache/pip',
    size: () => du(`${TMUX_HOME}/.cache/pip`), run: () => rmrf(`${TMUX_HOME}/.cache/pip`) },
  { id: 'gyp', label: 'node-gyp headers', note: '.cache/node-gyp',
    size: () => du(`${TMUX_HOME}/.cache/node-gyp`), run: () => rmrf(`${TMUX_HOME}/.cache/node-gyp`) },
  { id: 'docker', label: 'docker dangling layers', note: 'every tagged image is kept',
    size: async () => { const d = await dockerDf(); return (d.Images || 0) + (d['Build Cache'] || 0); },
    run: async () => { await rrun('docker', ['image', 'prune', '-f'], 90000); await rrun('docker', ['builder', 'prune', '-f'], 90000); } },
  { id: 'shots', label: 'terminal screenshots', note: 'older than 7 days',
    size: () => oldFiles('/opt/claude-dashboard/shots'), run: () => oldFiles('/opt/claude-dashboard/shots', true) },
  { id: 'tmp', label: 'stale /tmp scratch dirs', note: 'tool litter, 7 days cold',
    size: () => tmpStale(), run: () => tmpStale(true) },
  { id: 'browsers', g: 'qa', label: 'playwright + puppeteer browsers', note: 'next QA journey re-downloads ~1.3 G',
    size: async () => (await du(`${TMUX_HOME}/.cache/ms-playwright`)) + (await du(`${TMUX_HOME}/.cache/puppeteer`)),
    run: async () => { await rmrf(`${TMUX_HOME}/.cache/ms-playwright`); await rmrf(`${TMUX_HOME}/.cache/puppeteer`); } },
  { id: 'vol', g: 'data', label: 'unused docker volumes', note: 'a volume can hold a dev database — no undo',
    size: async () => (await dockerDf())['Local Volumes'] || 0,
    run: () => rrun('docker', ['volume', 'prune', '-f'], 60000) },
];
async function reclaimScan() { // ~1-2 s of du, so only ever on the explicit preview request
  return Promise.all(RT.map(async t => {
    let v = 0; try { v = await t.size(); } catch { /* tool absent -> 0 */ }
    const o = typeof v === 'number' ? { b: v, extra: '' } : v;
    return { ...t, b: o.b || 0, extra: o.extra };
  }));
}
async function reclaimAction(req, res) {
  const host = req.headers.host || '';
  if (!sameOrigin(req, host)) { res.writeHead(403); return res.end('bad origin'); }
  let raw = '', n = 0;
  for await (const c of req) { n += c.length; if (n > 4096) { res.writeHead(413); return res.end('too large'); } raw += c; }
  const f = new URLSearchParams(raw);
  const ids = new Set(f.getAll('t'));
  const sel = RT.filter(t => ids.has(t.id));
  const b4 = statfsSync('/');
  for (const t of sel) { try { await t.run(); } catch { /* one dead target must not abort the rest */ } }
  const af = statfsSync('/');
  // back holds a full path+query now (fleet redesign: the panel lives on both '/' and
  // /history) — not a bare querystring like before. Same "/" guard as every other
  // POST action's back field: reject a protocol-relative "//host" redirect.
  const rawBack = f.get('back') || '/';
  const backPath = rawBack.startsWith('/') && !rawBack.startsWith('//') ? rawBack : '/';
  const u = new URL(backPath, 'http://x');
  u.searchParams.set('sys', '1');
  u.searchParams.set('freed', String(Math.max(0, (af.bavail - b4.bavail) * af.bsize)));
  u.searchParams.set('rn', String(sel.length));
  hostCache = { t: 0, h: null }; // the disk meter must show the new number on the bounce
  dfCache = { t: 0, d: null };
  res.writeHead(303, { location: u.pathname + u.search }); res.end();
}
function recForm(rec) {
  const rows = rec.scan.filter(t => t.b > 0 || t.extra);
  const safe = rows.filter(t => !t.g).reduce((s, t) => s + t.b, 0);
  const row = t => `<label class="rrow"><input type="checkbox" name="t" value="${t.id}"${t.g ? '' : ' checked'}>
<span class="rl">${esc(t.label)}</span><b>${HB(t.b)}</b>
<span class="muted">${esc(t.extra ? t.extra + ' · ' + t.note : t.note)}</span></label>`;
  return `<div class="statgrid"><div class="stat wide"><span class="sl">reclaim · measured just now</span>
<form class="rf" method="post" action="/sys/reclaim"><input type="hidden" name="back" value="${esc(rec.back || '')}">
${rows.length ? rows.map(row).join('') : '<div class="mlist muted">nothing to reclaim — every cache here is already empty</div>'}
${rows.length ? `<div class="rrow tot"><span class="rl">checked by default</span><b>${HB(safe)}</b><button class="ab danger">${ICO.trash}Reclaim Selected</button></div>
<div class="mlist muted">runs as root · no undo. memory and cpu are missing on purpose: the mem bar above already
excludes the page cache, so there is nothing there to free, and the load is your own sessions.</div>` : ''}
</form></div></div>`;
}
function sysPanel(fhref, open, rec, flat, extra) {
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
  const age = usageCache.t ? (rel(usageCache.t) === 'now' ? 'now' : rel(usageCache.t) + ' ago') : '—';
  const rchip = rec ? `<a class="chip" href="${esc(rec.href)}">${rec.scan ? ICO.x + 'Close' : ICO.trash + 'Reclaim'}</a>` : '';
  const rflash = rec && rec.freed != null
    ? `<span class="chip ok">reclaimed <b>${HB(rec.freed)}</b> · ${rec.n} target${rec.n === 1 ? '' : 's'}</span>` : '';
  const urow = `<div class="bar"><span class="chip">usage updated <b>${age}</b>${usageCache.busy ? ' · refreshing…' : ''}</span><a class="chip" href="${fhref || '/?fresh=1'}">${ICO.refresh}Refresh</a>${rchip}${rflash}</div>`;
  const rblk = rec && rec.scan ? recForm(rec) : '';
  // flat: /system's own dedicated page — always expanded, no <details>/summary collapse
  // (the page's h1 already says "system", so no repeated header line here).
  // figma-make System view (node 36:852): two 464px columns (Metrics | Environment +
  // Terminal), pixel spec below; everything the OLD flat panel showed (per-account
  // limits/spend, agy handoffs, disk reclaim) survives underneath in .sysextra — the
  // addendum's 3-card anatomy has no slot for it, but the hard rule is "never remove
  // functionality", so it keeps the same cards/classes, just re-headed to read as part
  // of this page instead of a collapsible strip.
  if (flat) {
    const ex = extra || {};
    const loadPct = pct(h.load, h.cores), loadWarn = h.load > h.cores;
    const memPct = pct(h.memUsed, h.memTot), memWarn = memPct > 85;
    const swapPct = h.swapTot ? pct(h.swapUsed, h.swapTot) : 0, swapWarn = swapPct > 85;
    const diskPct = pct(h.dskUsed, h.dskTot), diskWarn = diskPct > 85;
    const bar = (label, val, p, warn) => `<div class="mbar">
<div class="mbar-row"><span class="mbar-label">${esc(label)}</span><span class="mbar-val">${esc(val)}</span></div>
<div class="mbar-track"><div class="mbar-fill${warn ? ' warn' : ''}" style="width:${Math.min(100, Math.max(0, p))}%"></div></div>
</div>`;
    const metricsHtml = `<section class="sysleft">
<div class="sechead"><h2>Metrics</h2><p>Live utilization of host resources.</p></div>
<div class="mbars">
${bar('Load average', `${h.load.toFixed(2)} / ${h.cores} cores`, loadPct, loadWarn)}
${bar('Memory', `${GB(h.memUsed)} / ${GB(h.memTot)} G`, memPct, memWarn)}
${bar('Swap', h.swapTot ? `${GB(h.swapUsed)} / ${GB(h.swapTot)} G` : 'not configured', swapPct, swapWarn)}
${bar('Disk /', `${GB(h.dskUsed)} / ${GB(h.dskTot)} G`, diskPct, diskWarn)}
</div></section>`;

    const ver = ex.ver || '?';
    const deployTxt = ex.deployMt ? (rel(ex.deployMt) === 'now' ? 'just now' : `${rel(ex.deployMt)} ago`) : '?';
    const deployTitle = ex.deployMt ? abs(ex.deployMt) : '';
    const erow = (k, v, cls) => `<div class="envrow"><span class="envkey">${esc(k)}</span><span class="envval${cls ? ' ' + cls : ''}">${v}</span></div>`;
    const envHtml = `<section class="sysright-item">
<div class="sechead"><h2>Environment</h2><p>System configuration and status.</p></div>
<div class="envcard"><div class="envrows">
${erow('STATUS', '<span class="edot"></span>ONLINE', 'ok')}
${erow('VERSION', esc(ver))}
<div class="envdiv"></div>
${erow('UPTIME', `${days}d ${hrs}h`)}
${erow('LAST_DEPLOY', `<span title="${esc(deployTitle)}">${esc(deployTxt)}</span>`)}
<div class="envdiv"></div>
${erow('NODE', esc(process.version))}
${erow('OS', esc(`${os.platform()}/${os.arch()}`))}
</div></div></section>`;

    // Terminal card: no 3-option setting exists anywhere in this app (the terminal theme
    // is picked per-browser from the /term key bar; the global default is settings.json,
    // served at /settings/term-theme.json, POST /settings/term-theme — no dashboard UI) —
    // per spec that means the TERMINAL THEME block is omitted rather than faked into a
    // 3-button grid. The danger button maps to the one real host-wide destructive action
    // that already exists with its own confirm: /a/restartall ("restart every live
    // session"), which already lives on /device — reused here verbatim (same endpoint,
    // same confirm copy), not a new endpoint.
    const live = ex.live || [];
    const liveN = live.length;
    const ICO_RESTART = `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M21 12a9 9 0 1 1-3-6.7"/><path d="M21 3v6h-6"/></svg>`;
    const restartCtl = liveN
      ? `<details class="kx"><summary class="dangerbtn">${ICO_RESTART}Restart All Sessions${liveN > 1 ? ` (${liveN})` : ''}</summary><div class="kc"><div>restart all <b>${liveN}</b> live session${liveN > 1 ? 's' : ''}?</div><span class="muted">whatever is running right now is killed — including the session you are reading this from.</span><form class="af" method="post" action="/a/restartall"><input type="hidden" name="back" value="/system"><button class="ab danger">Restart Them</button></form></div></details>`
      : `<div class="dangerbtn off" aria-disabled="true">${ICO_RESTART}restart all sessions</div>`;
    const rsChip = ex.rsN ? `<span class="chip on"><span class="dot" style="background:var(--ok)"></span>restarted ${ex.rsN}</span>` : '';
    const termHtml = `<section class="sysright-item">
<div class="sechead"><h2>Terminal</h2><p>Master process and theming.</p></div>
<div class="termcard set">
<div class="seclabel">Master process</div>
${restartCtl}
<p class="dangercap">${liveN ? 'Restarts every live terminal session on this host — including the one you’re reading this from. Transcripts stay on disk; nothing is deleted.' : 'No live sessions right now — nothing to restart.'}</p>
${rsChip}
</div></section>`;

    const grid = `<div class="sysgrid">${metricsHtml}<div class="sysright">${envHtml}${termHtml}</div></div>`;
    const extraHtml = `<div class="sysextra"><div class="sechead"><h2>Usage &amp; Reclaim</h2><p>Claude account limits, daily spend, and disk reclaim.</p></div>
${urow}${rblk}${ubody}</div>`;
    return `<div class="sysview">${grid}${extraHtml}</div>`;
  }
  return `<details class="sys"${open ? ' open' : ''}><summary><span class="syst">📊 system</span><span class="syss">load <b>${h.load.toFixed(2)}</b> · mem <b>${GB(h.memUsed)}/${GB(h.memTot)}G</b> · disk <b>${GB(h.dskUsed)}/${GB(h.dskTot)}G</b> · up <b>${days}d</b>${sumToday == null ? '' : ` · today <b>${money(sumToday)}</b>`}</span></summary>
<div class="sysbody">${cards}${urow}${rblk}${ubody}</div></details>`;
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
  return (l.paused ? f('resume', ICO.play + 'Resume', 'ok') : f('pause', ICO.pause + 'Pause'))
    + `<details class="kx" name="am"><summary class="ab" title="name this session">${ICO.pencil}</summary><div class="kc"><form class="af lf" method="post" action="/a/label"><input type="hidden" name="name" value="${esc(l.name)}"><input type="hidden" name="back" value="${esc(back)}"><span class="klbl">Rename</span><input class="li2" name="label" value="${esc(l.label || '')}" maxlength="60" placeholder="session name" aria-label="session name"><button class="ab ok">Save</button></form></div></details>`
    + `<details class="kx" name="am"><summary class="ab danger">${ICO.x}Kill</summary><div class="kc"><div>stop <b>${esc(l.name)}</b>?</div><span class="muted">the process ends now — the transcript stays on disk, resume anytime.</span>${f('kill', 'Kill It', 'danger')}</div></details>`;
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
/* mows-control token layer (figma-make reskin, 2026-08-29): exact spec palette —
   zinc bg/surfaces + emerald accent. Component CSS below reads these vars, so this
   block is the single place the whole app's look shifts from. */
--bg:#09090b;--card:rgba(24,24,27,.3);--card2:#18181b;--pop:#27272a;
--navbg:rgba(24,24,27,.6);--navbd:rgba(39,39,42,.8);
--fg:#f4f4f5;--fg2:#d4d4d8;--title:#e4e4e7;--mut:#9f9fa9;--dim:#71717b;--dimmer:#52525c;
--bd:rgba(39,39,42,.6);--bd2:rgba(39,39,42,.8);--hair:#18181b;
--ring:rgba(161,161,170,.8);
--ok:#00d492;--ok-bg:rgba(0,212,146,.1);--ok-bd:rgba(0,212,146,.4);
--warn:#fbbf24;--bad:#f87171;
--r:10px;--r-lg:16px;
--sans:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,'Helvetica Neue',Arial,sans-serif;
--mono:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace}
*{margin:0;padding:0;box-sizing:border-box;-webkit-tap-highlight-color:transparent}
html{background:var(--bg)}
body{background:var(--bg);color:var(--fg);font:14px/1.5 var(--sans);padding:12px;max-width:1100px;margin:0 auto;position:relative}
/* desktop content column (spec: max-width 1024, 48px page padding) — mobile keeps its
   own tighter padding via the max-width:700px block below. */
@media(min-width:701px){body{max-width:1024px;padding:48px}
/* a live device stream deserves the whole monitor, not the 1024px reading column */
body.watchlive{max-width:1720px}
/* the new .hdr replaces the mobile compact <h1> on desktop; every view's body string
   still starts with <h1> for the mobile header, so a plain child selector hides it here
   without touching each view. */
body>h1{display:none}}
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
/* .sel is the neutral "this filter pill is selected" state (account/time-range chips in
   /history) — mirrors .pnav a.on. .on stays reserved for a genuinely live/positive state
   (the "live N" chip, browser/emulator status, restart count). */
.chip.sel{background:var(--pop);border-color:var(--bd2);color:var(--fg)}
.chip b{font-weight:600;font-variant-numeric:tabular-nums}
.dot{width:7px;height:7px;border-radius:50%;display:inline-block;flex-shrink:0}
input[type=search]{background:rgba(255,255,255,.04);border:1px solid var(--bd2);border-radius:var(--r);color:var(--fg);padding:6px 12px;font:13px var(--sans);width:190px;min-height:34px}
input[type=search]::placeholder{color:var(--dim)}
button{background:var(--card2);border:1px solid var(--bd);border-radius:var(--r);color:var(--fg2);padding:6px 12px;font:13px var(--sans);min-height:34px;cursor:pointer}
button:hover{background:var(--pop);border-color:var(--bd2)}
.lp{background:var(--card);border:1px solid var(--bd);border-radius:var(--r-lg);padding:10px 12px;margin:4px 0 14px;display:flex;flex-direction:column;gap:10px;min-width:0;max-width:100%}
.lr{display:flex;flex-wrap:wrap;gap:6px 10px;align-items:center;min-height:36px}
/* settings groups: every top-level group gets a .sect label, so a group's own
   sub-parts (the live preview) can't read as a sibling group of their own. */
.sect{font:600 11px var(--sans);color:var(--dim);text-transform:uppercase;letter-spacing:.08em;margin:22px 4px 8px}
.sect:first-of-type{margin-top:6px}
.cardh{font-weight:600;font-size:14px;color:var(--fg)}
.subl{font-size:12px;color:var(--dim);margin:2px 0 -4px}
.ln a,.ln span{color:var(--ok);font:600 13px var(--mono)}
.la{display:flex;gap:6px;align-items:center;margin-left:auto;flex-wrap:wrap}
.lt{flex-basis:100%;margin:-2px 0 0 18px;font-size:12px;color:var(--mut);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.lb{font:600 14px var(--sans);color:var(--fg)}
.af.lf{display:flex;gap:8px;align-items:center}
/* a text FIELD, not a pill: tighter radius than the buttons, visible outline, inset well,
   and the .klbl micro-label above it — the trio is what reads as "type here". */
.li2{background:rgba(9,9,11,.7);border:1px solid #3f3f47;border-radius:6px;color:var(--fg);padding:6px 10px;font:13px var(--sans);flex:1;min-width:0;min-height:32px;box-shadow:inset 0 1px 2px rgba(0,0,0,.4)}
.li2::placeholder{color:var(--dimmer)}
.li2:focus{outline:none;border-color:#71717b;background:rgba(9,9,11,.9)}
.klbl{width:100%;font:700 10px var(--sans);color:var(--dimmer);letter-spacing:.1em;text-transform:uppercase;line-height:1}
.af{display:inline;margin:0}
.ab{display:inline-flex;align-items:center;gap:5px;border:1px solid var(--bd);border-radius:var(--r);padding:5px 12px;min-height:34px;background:var(--card2);color:var(--fg2);font:13px var(--sans);cursor:pointer;list-style:none}
/* inline lucide icons: size per context (ICO svgs default to 16px attrs) */
.ab svg,.chip svg,.dx svg{width:14px;height:14px;flex-shrink:0}
.ti svg{width:20px;height:20px}
.termfab svg{width:22px;height:22px}
.hnew svg{width:16px;height:16px}
.pg a svg,.pg .off svg{width:16px;height:16px}
.syst svg{width:14px;height:14px;vertical-align:-2px;margin-right:6px}
.fico svg{width:14px;height:14px;display:block}
.ab:hover{background:var(--pop);border-color:var(--bd2)}
.ab.danger{color:var(--bad)}
.ab.danger:hover{background:rgba(248,113,113,.1);border-color:rgba(248,113,113,.35)}
.ab.ok{color:var(--ok)}
.ab.ok:hover{background:var(--ok-bg);border-color:var(--ok-bd)}
/* mobile fleet card attach: ghost it (text only, no border/bg) so it reads as a trailing
   action instead of a second boxed control — card's weight stays on title/snippet. Scoped
   to #fleet-cards so settings/live-session .lp .ab.ok buttons keep their normal chrome. */
.fleet-cards .ab.ok{background:transparent;border-color:transparent}
.fleet-cards .ab.ok:hover{background:transparent;border-color:transparent}
.kx{position:relative;margin:0}
.kx summary::-webkit-details-marker{display:none}
.kc{position:absolute;right:0;top:42px;z-index:9;background:var(--pop);border:1px solid var(--bd2);border-radius:var(--r-lg);padding:12px;width:250px;display:flex;flex-direction:column;gap:10px;box-shadow:0 12px 32px rgba(0,0,0,.55);font-size:13px}
/* dropdown menu anatomy (2026-08-29): hairline-divided header and danger zone, full-width
   left-aligned action rows — the panel reads as a menu, not a pile of pills. */
.kc .tname{padding-bottom:10px;border-bottom:1px solid var(--bd)}
.kc form.af{width:100%;display:flex}
.kc .af .ab{width:100%;justify-content:flex-start}
.kc .af.lf{flex-wrap:wrap;gap:6px 8px;align-items:center}
.kc .af.lf .ab{width:auto;flex-shrink:0}
.kc > .kx{width:100%;padding-top:10px;border-top:1px solid var(--bd)}
.kc > .kx .ab{width:100%;justify-content:flex-start}
.day{color:var(--dimmer);font:700 12px/1 var(--sans);padding:0 8px;margin:32px 0 12px;text-transform:uppercase;letter-spacing:.6px}
.day:first-child{margin-top:0}
.li{display:flex;align-items:stretch;border-bottom:1px solid var(--hair)}
.li:hover,.li:active{background:var(--card)}
.row{flex:1;display:flex;flex-wrap:wrap;gap:4px 16px;align-items:center;padding:10px 6px;min-height:46px;min-width:0}
/* mock's history rows are a denser, more table-like list than the 46px default —
   tighten on desktop only; mobile keeps the roomier touch-target height. */
@media(min-width:701px){.row{padding:8px 12px;min-height:36px}}
.t{color:var(--dimmer);width:32px;flex-shrink:0;font:12px var(--mono);font-variant-numeric:tabular-nums}
.acct{font:700 12px var(--sans);flex-shrink:0}
.proj{font:400 14px var(--mono);color:var(--mut);overflow:hidden;text-overflow:ellipsis;white-space:nowrap;max-width:50%}
.ttl{color:var(--title);flex:1;min-width:130px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.sz{color:var(--dimmer);font:12px var(--mono);font-variant-numeric:tabular-nums;flex-shrink:0}
.sid{color:var(--dim);font:12px var(--mono);flex-shrink:0}
.go{display:flex;align-items:center;padding:0 14px;color:var(--ok);border-left:1px solid var(--hair);font:700 13px var(--mono)}
.go:hover{background:var(--ok-bg)}
/* .kc is a right-anchored popover, which works where it hangs off a button at the RIGHT
   edge of a wide session row. A settings card puts its button at the LEFT edge, so right:0
   threw a 250px panel to x=-116 on a phone — off-screen. In cards the confirm opens INLINE
   instead: it's a <details> disclosure, the column is full-width, and it cannot overflow. */
.set .kc{position:static;width:auto;background:var(--card2);box-shadow:none;margin-top:2px}
/* fleet (Fleet Redesign §2): adaptive at the same 700px breakpoint everywhere else in
   this file — dense .li/.row rows on desktop, .lp cards on phones. Same markup always
   renders; the media query below picks which block is visible, same trick .tabs/.navdup
   already use. fleet-rows reuses .li/.row (border+hairline list, like the history rows);
   fleet-cards reuses .lp (the settings/live-session card token). */
.fleet-rows{background:transparent;border:none;display:flex;flex-direction:column;gap:12px;margin:4px 0 18px}
/* spec Sessions card: bg/border/radius16 from the token layer, padding16, title(fr1)
   line + a snippet line 4px below; status word at the right edge of fr1; .fr2 dim mono
   snippet + project bottom-right. .hlist (history) keeps the dense hairline-list look. */
.fleet-rows .li{background:var(--card);border:1px solid var(--bd);border-radius:16px;padding:16px}
.frow{flex:1;display:flex;flex-direction:column;gap:4px;min-width:0}
.fr1{display:flex;align-items:center;gap:10px;min-width:0}
.fr1 .lb{font:400 16px/24px var(--sans);color:var(--fg);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.fst{font:400 12px/16px var(--mono);color:var(--dim);flex-shrink:0;margin-left:2px}
.fact{display:flex;align-items:center;gap:4px;margin-left:auto;flex-shrink:0}
.fact .go{border:1px solid var(--bd);border-radius:8px;padding:5px 10px;min-height:30px}
@media(pointer:fine){.fact{opacity:0;transition:opacity .15s}
.fleet-rows .li:hover .fact,.fleet-rows .li:focus-within .fact,.fact:has(details[open]){opacity:1}}
.fr1 .proj{max-width:28%;margin-top:2px;color:var(--dimmer);font-size:12px}
/* spec: "the state glyph may be dropped or kept tiny-dim — status word now carries the
   color" — shrink it to a quiet marker in the row layout only (cards keep it as-is). */
.fleet-rows .fli{font-size:10px;opacity:.55}
.fleet-cards{display:none}
.fleet-cards .lp{background:var(--card);gap:6px;padding:16px}
.fchd{flex-wrap:nowrap}
.fcact{display:flex;align-items:center;gap:2px;flex-shrink:0;min-width:0}
/* fleet.js empties a container by removing its last child (session ended) or fills it by
   appending one (session appeared) — :empty hides the bordered box with no JS bookkeeping. */
.fleet-rows:empty,.fleet-cards:empty{display:none}
/* mock's dashed "new session" affordance under the fleet — mapped to the existing
   terminal picker, not a new spawn-agent feature (still out of scope). */
.newcard{display:flex;align-items:center;justify-content:center;gap:8px;border:1px dashed var(--bd2);border-radius:var(--r-lg);padding:18px;margin:4px 0 18px;color:var(--mut);font-size:13px}
.newcard:hover{color:var(--fg2);border-color:var(--bd2);background:var(--card)}
.fli{font:14px/1 var(--mono);width:16px;flex-shrink:0;text-align:center}
.fli-needs-you,.fli-paused{color:var(--warn)}
.fli-working{color:var(--ok)}
.fli-idle{color:var(--dim)}
/* keyboard-nav badges (Fleet Redesign §3 phase 3): fleet.js's keydown handler sends
   digit 1-9 to the nth fleet row's attach link; these are the on-screen hint for that.
   Desktop-only affordance — hidden on touch even at a wide viewport (a landscape tablet
   has no keyboard to act on the hint), same pointer:fine reasoning the data-nw window-reuse
   script uses below. fleet-rows is already display:none under 700px so the width half of
   this gate is redundant there, kept explicit for a wide touch device that still renders
   the row layout. */
.fnum{display:none}
@media(min-width:700px) and (pointer:fine){.fnum{display:inline-flex;align-items:center;justify-content:center;width:14px;height:14px;flex-shrink:0;font:10px var(--mono);color:var(--dim);border:1px solid var(--bd);border-radius:3px;margin-right:1px}}
/* card variant (white-space:normal inline override in fleetCardHtml) wraps at spaces by
   default, but a snippet pulled from a transcript tail can contain one long unbreakable
   run (a path, a URL, a command with no spaces) — without overflow-wrap that run forces
   .lp/.fleet-cards wider than the viewport (925px measured at 390px), a horizontal-scroll
   regression. min-width:0 lets the flex item (.lp's column-flex child) actually shrink to
   the card's width instead of sizing to its own min-content. */
.fsnip{color:var(--dim);overflow:hidden;text-overflow:ellipsis;white-space:nowrap;overflow-wrap:anywhere;word-break:break-word;min-width:0;max-width:100%}
.tname{font:12px var(--mono);color:var(--dim);word-break:break-all}
/* the ⋯ menu on a phone card floats like the desktop popover (base .kc: absolute,
   right-anchored off the button) instead of inlining and growing the card (user request
   2026-08-29). The 250px panel fits right-aligned even at 320px (8px page + 16px card
   padding leaves 46px slack); the max-width is a guard for anything narrower. */
.fleet-cards .kc{max-width:calc(100vw - 48px);z-index:30}
/* whole card = tap target on phones (user request 2026-08-29): stretch the attach link's
   hit area over the card (stretched-link ::after); the ⋯ menu stacks above so it stays
   its own tap. :active repaint gives the tap visible feedback. */
.fleet-cards .lp{position:relative}
.fleet-cards [data-f=attach]::after{content:'';position:absolute;inset:0;border-radius:var(--r-lg)}
.fleet-cards .kx{z-index:2}
/* the open menu must paint over the NEXT card's controls too — the .kc's own z-index:30 is
   capped by its .kx stacking context (z:2), which later siblings (also z:2) beat by DOM order */
.fleet-cards .kx[open]{z-index:31}
.fleet-cards .lp:has([data-f=attach]:active){background:var(--card2)}
/* figma-make reskin (2026-08-29): full desktop header (logo+title, centered pill nav,
   "+ new session" button), LIVE pill, hover-revealed row actions, recessed snippets,
   state-colored status words. Mobile keeps its compact <h1> + bottom tab bar — .hdr
   carries .navdup so the <700px rule (below) hides it exactly like the old pill nav did. */
.hdr{display:flex;align-items:center;justify-content:space-between;gap:16px;height:50px;margin:0 0 48px}
.hdl{display:flex;align-items:center;gap:16px;min-width:0}
.hlogo{width:32px;height:32px;flex-shrink:0;border-radius:8px;background:var(--fg);color:var(--bg);display:flex;align-items:center;justify-content:center;font:700 18px/1 var(--mono)}
.hcol{min-width:0}
.htitle{font:500 16px/1.2 var(--sans);color:var(--fg);letter-spacing:-.4px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.hsub{font:12px var(--mono);color:var(--mut);opacity:.6;margin-top:2px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.hnew{display:inline-flex;align-items:center;gap:8px;flex-shrink:0;background:var(--fg);color:var(--bg);padding:10px 20px;border-radius:999px;font:500 14px var(--sans);white-space:nowrap}
.hnew:hover{background:#e4e4e7}
.pnav{display:inline-flex;gap:2px;background:var(--navbg);border:1px solid var(--navbd);border-radius:999px;padding:6px;height:50px;box-sizing:border-box;flex-shrink:0}
.pnav a{padding:8px 20px;border-radius:999px;color:var(--mut);font:500 14px var(--sans);display:inline-flex;align-items:center;gap:6px;white-space:nowrap}
.pnav a:hover{color:var(--fg2);background:var(--card2)}
.pnav a.on{background:var(--pop);color:var(--fg);box-shadow:0 1px 3px rgba(0,0,0,.4)}
.pbdg{background:var(--bg);border-radius:999px;padding:2px 6px;font:500 12px/1 var(--mono);color:#d4d4d8}
/* tablet gap (701-920px, e.g. 768/844/900): .pnav + .hnew hold fixed content width and
   .hdl is the only shrinkable flex child, so it was absorbing the whole deficit and
   ellipsis-truncating both title and subtitle. Reclaim the width instead of shrinking
   text: drop the subtitle and collapse "+ New Session" to an icon-only button — same
   two moves the mobile <700px layout already makes (compact header, icon-first nav). */
@media(max-width:920px){.hsub{display:none}.hnew{padding:10px;gap:0}.hnew-lbl{display:none}}
/* persistent terminal FAB (gap #5): reachable at every width without inflating the 4-tab nav */
.termfab{position:fixed;right:14px;bottom:calc(70px + env(safe-area-inset-bottom,0px));z-index:21;width:46px;height:46px;border-radius:50%;background:var(--ok);color:#052018;display:flex;align-items:center;justify-content:center;font-size:19px;box-shadow:0 6px 18px rgba(0,0,0,.45)}
.termfab:hover{background:#4ade9e}
@media(min-width:701px){.termfab{bottom:14px}}
body.watchlive .termfab{display:none}
/* pull-to-refresh chip — created by fleet.js in the installed app only; hidden above the
   viewport until the pull drags it in (transform is JS-driven, so only opacity animates) */
#ptr{position:fixed;left:50%;top:calc(env(safe-area-inset-top,0px) - 44px);z-index:25;width:36px;height:36px;border-radius:50%;background:var(--pop);border:1px solid var(--bd2);box-shadow:0 6px 18px rgba(0,0,0,.45);display:flex;align-items:center;justify-content:center;color:var(--mut);opacity:0;pointer-events:none;transition:opacity .12s}
#ptr.go{color:var(--ok)}
#ptr svg{width:16px;height:16px}
#ptr.spin svg{animation:ptrspin .7s linear infinite}
@keyframes ptrspin{to{transform:rotate(360deg)}}
/* spec LIVE badge: tinted pill (bg = accent @10%), a real 6px dot (reuses the .dot
   token, not a text glyph) + tracked-out label — not a bare colored word. */
.lvb{display:inline-flex;align-items:center;gap:6px;color:var(--ok);background:var(--ok-bg);border:none;border-radius:4px;font:500 12px/1 var(--sans);letter-spacing:.3px;padding:2px 6px;margin-right:2px;vertical-align:1px}
.lvbd{width:6px;height:6px;border-radius:50%;background:var(--ok);opacity:.68;animation:lvpulse 1.6s ease-in-out infinite}
@keyframes lvpulse{0%,100%{opacity:.68}50%{opacity:.3}}
/* history/today rows: actions appear on hover (mock) — pointer:fine only, touch keeps
   them always visible; focus-within + [open] keep keyboard nav and open confirms shown */
@media(pointer:fine){
.hlist .go,.hlist .kx.del{opacity:0;transition:opacity .15s}
.hlist .li:hover :is(.go,.dx),.hlist .li:focus-within :is(.go,.dx),.hlist .li:hover .kx.del,.hlist .li:focus-within .kx.del,.hlist .kx.del[open]{opacity:1}
}
/* spec: history rows carry a hairline only on the FIRST row of each day group (the
   .day header's very next sibling); the rest of a group's rows are borderless. */
.hlist .li{border-bottom:none;border-left:2px solid transparent}
.hlist .day+.li{border-left-color:var(--hair);border-bottom:1px solid var(--hair)}
/* desktop snippet: plain dim mono line, exactly like the mock's card subtitle */
.fleet-rows .fsnip{font:14px/20px var(--mono);color:var(--dim)}
.fleet-cards .fsnip{font:12px var(--mono)}
/* status word takes the state color (glyph already does via .fli-*) */
[data-state=needs-you] .ttl[data-f=meta],[data-state=needs-you] span[data-f=meta]{color:var(--warn)}
[data-state=working] .ttl[data-f=meta],[data-state=working] span[data-f=meta]{color:var(--ok)}
[data-state=paused] .ttl[data-f=meta],[data-state=paused] span[data-f=meta]{color:var(--warn)}
.kx.del{display:flex;align-items:stretch}
.dx{display:flex;align-items:center;padding:0 13px;color:var(--dim);border-left:1px solid var(--hair);cursor:pointer;font-size:13px;min-height:44px}
.dx:hover{background:rgba(248,113,113,.08);color:var(--bad)}
/* spec pagination: four 32×32 icon buttons (no border), a mono "N / max" page readout,
   and a dim@60% trailing total — .pgnum/.pgtot below split what used to be one .cur span. */
.pg{display:flex;gap:16px;align-items:center;justify-content:center;padding:32px 0;flex-wrap:wrap;font:14px var(--mono)}
.pg a,.pg .off{display:inline-flex;align-items:center;justify-content:center;width:32px;height:32px;border-radius:8px;color:var(--mut);font-size:16px}
.pg a:hover{background:var(--card2);color:var(--fg)}
.pg .off{color:#3f3f46}
.pgnum{display:inline-flex;align-items:center;gap:4px}
.pg .cur{color:var(--fg);font-weight:400;font-variant-numeric:tabular-nums}
.pg .muted{color:var(--mut)}
.pgtot{color:var(--dim);opacity:.6}
.muted{color:var(--mut)}
.notitle{font-style:italic;color:var(--dimmer)}
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
/* device stage media (android iframe / noVNC iframe, node 36:651): a fixed-AR remote
   (16:9) that fills the dashed .devstage box at its own width — see the Device view
   CSS block below for .devstage/.stageempty. */
.vnc{width:100%;aspect-ratio:16/9;height:auto;max-height:100%;border:0;background:#000;display:block}
footer{padding:18px 0;color:var(--dim);display:flex;gap:14px;flex-wrap:wrap;font-size:12.5px}
footer a{color:var(--mut)}
footer a:hover{color:var(--fg2)}
/* mobile .row wrap: .sid must never land alone on a wrapped line (order sits it right after
   .t/.acct, both always narrow enough to share a line — .proj is bumped after it so a long
   project name wraps to its OWN line instead of stranding .sid in the gap before .ttl).
   .li2 (rename input) bumped to 16px here too — anything under 16px forces an iOS Safari
   auto-zoom on focus; input[type=search] gets the same treatment in the /system mobile block. */
@media(max-width:700px){body{padding:max(8px,env(safe-area-inset-top,8px)) 8px calc(72px + env(safe-area-inset-bottom,0))}.chip{min-height:40px}.proj{max-width:55%;order:1}.ttl{flex-basis:100%;order:9}.sz{display:none}.sid{margin-left:auto}.pg a,.pg .off{width:40px;height:40px}input[type=search]{width:140px}.li2{font-size:16px}
.fleet-rows{display:none}.fleet-cards{display:flex;flex-direction:column;gap:12px;margin:4px 0 14px}
/* touch targets: .ab covers every button/summary/anchor styled as a pill (⋯ toggle,
   pause/resume/save/kill, the card's >_ attach link) — 34px (desktop mouse density) is
   under the 40px mobile minimum; bump on touch viewports only, desktop stays dense. */
.ab{min-height:40px}
/* app-mode nav: fixed bottom tab bar (the footer links + header chips it
   duplicates hide via .navdup). installed PWA has no browser chrome, so this
   IS the navigation; safe-area padding clears the iPhone home indicator. */
.tabs{position:fixed;bottom:0;left:0;right:0;z-index:20;display:flex;background:rgba(9,9,11,.88);backdrop-filter:blur(14px);-webkit-backdrop-filter:blur(14px);border-top:1px solid var(--bd);padding:5px 0 calc(5px + env(safe-area-inset-bottom,0))}
.tb{flex:1;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:2px;min-height:48px;color:var(--dim);font-size:11px}
.tb .ti{font-size:18px;line-height:1.2}
.tb.on{color:var(--ok)}
.tb:active{color:var(--fg)}
.navdup{display:none}
/* installed app: content scrolls under the translucent status bar — back it
   with a blur strip (tab bar's top counterpart). 0-height in browser tabs. */
body::before{content:'';position:fixed;top:0;left:0;right:0;height:env(safe-area-inset-top,0px);background:rgba(9,9,11,.88);backdrop-filter:blur(14px);-webkit-backdrop-filter:blur(14px);z-index:20;pointer-events:none}}
/* iOS standalone bug (measured via /z dash3 beacons 2026-08-29): after an app-switch /
   keyboard cycle WebKit sometimes relays the layout viewport short by exactly the top
   safe-area inset (ih=894 vs screen 956, sat=62), so fixed bottom:0 floats 62pt above the
   real screen bottom. 100lvh still reads the true screen height in that state, so in the
   installed app anchor the bar and FAB from the TOP off 100lvh instead — identical
   geometry when the viewport is sane. But dash3 also shows vh=894 in that state: nothing
   paints below the short layout viewport, so a bare 100lvh anchor hangs the bar's bottom
   62pt past the paintable area and clips the labels off the launch page (the fleet page
   is the PWA start page, so it's the one always seen in that state). min(100lvh,100%)
   clamps to the layout viewport (100% of a fixed element = its height): sane state
   unchanged, short state degrades to the old visible float instead of clipping.
   Browser tabs keep bottom:0 (Safari's collapsing toolbar makes lvh the wrong anchor
   there). .tabs box height = 1px border + 5px pad + 48px .tb + 5px pad + sab. */
@media(display-mode:standalone) and (max-width:700px){@supports(height:100lvh){
.tabs{bottom:auto;top:calc(min(100lvh,100%) - 59px - env(safe-area-inset-bottom,0px))}
.termfab{bottom:auto;top:calc(min(100lvh,100%) - 116px - env(safe-area-inset-bottom,0px))}
/* the stuck-short state (dash3 ih=894) hits the fleet page — the only page whose
   content doesn't fill the screen; give the document full height so WebKit has no
   short-document excuse to letterbox. border-box so it fills exactly, no dead scroll. */
body{min-height:100lvh;box-sizing:border-box}
}}
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
.rrow{display:flex;flex-wrap:wrap;gap:8px;align-items:center;font-size:12px;color:var(--mut);padding:3px 0;min-width:0;cursor:pointer}
.rrow .rl{color:var(--fg);flex:0 0 auto}
.rrow b{color:var(--fg);font-variant-numeric:tabular-nums;margin-left:auto;flex-shrink:0}
.rrow>.muted{flex:0 0 100%;padding:0 0 0 24px;font-size:11px}
.rrow input{width:16px;height:16px;accent-color:var(--warn);flex-shrink:0}
.rrow.tot{border-top:1px solid var(--hair);margin-top:6px;padding-top:9px;cursor:default}
.rf{margin:0}
.chip.ok{border-color:var(--ok-bd);color:var(--ok)}
.qrow b{color:var(--fg);font-variant-numeric:tabular-nums;flex-shrink:0}
.qrow>span:first-child{width:52px;flex-shrink:0}
.qrow .sid8{font-family:var(--mono);font-size:11px;color:var(--fg2);text-decoration:underline;text-decoration-color:var(--bd2)}
.mlist{font-size:11px;color:var(--mut);padding-top:4px;overflow-wrap:anywhere;min-width:0}
.ubd{margin-top:8px;border-top:1px solid var(--hair);padding-top:6px}
.ubd summary{cursor:pointer;list-style:none;font-size:11px;color:var(--fg2);min-height:26px;display:flex;align-items:center}
.ubd summary::-webkit-details-marker{display:none}
.ubd summary::before{content:'▸';color:var(--dim);margin-right:6px}
.ubd[open] summary::before{content:'▾'}
.flt form{flex:1;min-width:150px;flex-basis:100%}
.flt .fsw{position:relative;width:100%}
.flt .fico{position:absolute;left:12px;top:50%;transform:translateY(-50%);font-size:13px;color:var(--dim);pointer-events:none}
.flt input[type=search]{width:100%;padding:10px 14px 10px 34px;min-height:40px}
/* spec filter bar (closed state): 54px card, mono content — "🔍 filter" in dim, the
   " — all · all time · N sessions" summary in muted, a 16px chevron at the right edge. */
.flt > summary{min-height:54px;padding:0 16px;font-family:var(--mono);font-size:14px}
.flt > summary::after{font-size:16px;right:16px;top:50%;transform:translateY(-50%)}
.flt .syst{color:var(--dim);font-weight:400}
.flt .syss{color:var(--mut)}
.flt .syss::before{content:' — '}
summary:focus-visible{outline:2px solid var(--ok-bd);outline-offset:2px;border-radius:6px}
/* /system page redesign (figma-make addendum, node 36:852): two 464px columns,
   96px gap, at desktop; Metrics (bare bars, no card) | Environment + Terminal
   (both bordered cards). .sysextra below keeps the pre-existing usage/spend/reclaim
   panel (own header, same .statgrid/.stat tokens as before — untouched). */
.sysgrid{display:grid;grid-template-columns:464px 464px;column-gap:96px;align-items:start}
.sysright{display:flex;flex-direction:column;gap:32px}
.sechead{margin:0 0 32px}
.sechead h2{font:500 20px/28px var(--sans);color:var(--fg);letter-spacing:-.5px}
.sechead p{font:14px/20px var(--sans);color:var(--dim);padding-top:4px}
.mbars{display:flex;flex-direction:column;gap:24px}
.mbar{display:flex;flex-direction:column;gap:8px}
.mbar-row{display:flex;justify-content:space-between;align-items:baseline;gap:12px}
.mbar-label{font:500 14px var(--sans);color:var(--fg2)}
.mbar-val{font:14px var(--mono);color:var(--fg);font-variant-numeric:tabular-nums;white-space:nowrap}
.mbar-track{width:100%;height:6px;border-radius:999px;background:var(--hair);overflow:hidden}
.mbar-fill{height:6px;border-radius:999px;background:var(--fg)}
.mbar-fill.warn{background:#fef3c6}
.envcard,.termcard{background:var(--card);border:1px solid var(--bd2);border-radius:var(--r-lg);padding:24px}
.envrows{display:flex;flex-direction:column;gap:16px}
.envrow{display:flex;justify-content:space-between;align-items:baseline;gap:16px;min-width:0}
.envkey{font:14px var(--mono);color:var(--dimmer);white-space:nowrap}
.envval{font:14px var(--mono);color:var(--fg2);text-align:right;overflow:hidden;text-overflow:ellipsis;min-width:0}
.envval.ok{color:var(--ok);display:inline-flex;align-items:center;gap:8px;white-space:nowrap}
.edot{width:6px;height:6px;border-radius:50%;background:var(--ok);display:inline-block;flex-shrink:0}
.envdiv{height:1px;background:rgba(39,39,42,.5)}
.seclabel{font:700 10px var(--sans);color:var(--dim);letter-spacing:.1em;text-transform:uppercase;line-height:15px;margin:0 0 12px}
.dangerbtn{width:100%;display:flex;align-items:center;justify-content:center;gap:8px;height:46px;border-radius:12px;background:rgba(251,44,54,.1);border:1px solid rgba(130,24,26,.5);color:#ff6467;font:500 14px var(--sans);cursor:pointer;list-style:none}
.dangerbtn::-webkit-details-marker{display:none}
.dangerbtn:hover{background:rgba(251,44,54,.16)}
.dangerbtn.off{opacity:.45;cursor:default;pointer-events:none}
.dangercap{font-size:12px;color:var(--dimmer);line-height:19.5px;padding-top:12px}
.sysextra{margin-top:48px}
.sysextra .sechead{margin-bottom:16px}
@media(max-width:700px){.sys > summary{font-size:12px;padding:8px 30px 8px 10px}.sysbody{padding:0 8px 8px}input[type=search]{font-size:16px}
.sysgrid{display:block}.sysleft{margin-bottom:32px}.sysright{gap:24px}
.envcard,.termcard{padding:20px}.sechead{margin-bottom:24px}}
/* Device view (figma-make addendum, node 36:651): 320px left rail (segmented toggle +
   device-info card + uppercase-headed control cards) + flex-1 dashed stage. .devcard
   mirrors .envcard/.termcard's own bg/border/radius tokens above (same card language,
   just 20px padding per the addendum instead of 24). Mobile: rail-stacks-above-stage
   lives in the shared 700px block above (.devlayout/.devrail/.devstage there). */
.devlayout{display:flex;gap:48px;align-items:flex-start}
.devrail{width:320px;flex-shrink:0;display:flex;flex-direction:column;gap:24px;min-width:0}
.devcard{background:var(--card);border:1px solid var(--bd);border-radius:var(--r-lg);padding:20px}
.devhead{display:flex;justify-content:space-between;align-items:flex-start;gap:8px}
.devname{font:500 16px var(--sans);color:var(--fg);letter-spacing:-.4px}
.devsub{font:12px var(--mono);color:var(--dim);padding-top:2px}
.devrows{display:flex;flex-direction:column;gap:12px;padding-top:20px}
.devrow{display:flex;justify-content:space-between;gap:12px;font:12px var(--mono)}
.devrow span:first-child{color:var(--dim)}
.devrow span:last-child{color:var(--fg2);text-align:right;overflow:hidden;text-overflow:ellipsis;min-width:0}
.devrow span.good{color:var(--ok)}
/* LIVE badge: same tinted-pill anatomy as the history .lvb badge (bg=accent@10%, real
   dot not a glyph), just the card-header size from the addendum (px8 py4). */
.lvb2{display:inline-flex;align-items:center;gap:6px;color:var(--ok);background:var(--ok-bg);border-radius:4px;padding:4px 8px;font:500 12px var(--mono);flex-shrink:0}
.lvb2 i{width:6px;height:6px;border-radius:50%;background:var(--ok);display:inline-block;flex-shrink:0}
.segtoggle{display:flex;gap:4px;padding:4px;border-radius:12px;background:rgba(24,24,27,.5);border:1px solid var(--bd)}
.segbtn{flex:1;display:flex;align-items:center;justify-content:center;gap:8px;padding:10px 0;border-radius:8px;font:500 12px var(--sans);color:var(--dim)}
.segbtn.on{background:var(--pop);color:var(--fg);box-shadow:0 1px 3px rgba(0,0,0,.4)}
.segbtn:hover{color:var(--fg2)}
.ctlhead{font:700 10px var(--sans);color:var(--dimmer);letter-spacing:.1em;text-transform:uppercase;line-height:15px;margin:0 0 12px}
.ctlgrid{display:grid;grid-template-columns:1fr 1fr;gap:8px}
.ctlgrid.icons4{grid-template-columns:repeat(4,1fr)}
/* a POST form wrapping a ControlButton needs the BUTTON to be the actual grid item
   (grid-column:1/-1 on .wide has to land on the participating item) — display:contents
   drops the <form> itself out of layout/grid participation, same trick used for the
   icon-flip wrapper below. .af{display:inline} (global) is overridden by source order. */
.ctlform{display:contents}
.ctlbtn{display:flex;align-items:center;justify-content:center;gap:8px;height:38px;width:100%;border-radius:12px;background:rgba(24,24,27,.4);border:1px solid var(--bd2);color:var(--mut);font:500 12px var(--sans);cursor:pointer}
.ctlbtn:hover{background:var(--pop);color:var(--fg2)}
.ctlbtn.wide{grid-column:1/-1}
.ctlbtn.ok{color:var(--ok)}
.ctlbtn.ok:hover{background:var(--ok-bg);border-color:var(--ok-bd)}
.ctlbtn.danger{color:#ff6467}
.ctlbtn.danger:hover{background:rgba(251,44,54,.1);border-color:rgba(130,24,26,.5)}
.ctlbtn.stagecta{width:auto;min-width:220px;padding:0 20px}
.icoflip svg{transform:scaleX(-1)}
.themesel{width:100%;height:34px;background:var(--card2);border:1px solid var(--bd);border-radius:var(--r);color:var(--fg);padding:0 8px;font:13px var(--sans);margin-top:8px}
.themerow{margin-top:10px}
.savemsg{font-size:13px;transition:opacity .2s;opacity:0}
.finemuted{font-size:12.5px;margin-top:2px}
.themeprev{border:1px solid var(--bd);border-radius:var(--r);padding:14px 16px;font:13px/1.5 var(--mono);transition:background .15s,color .15s;margin-top:8px}
.tpline{margin-bottom:6px}
.tpdim{opacity:.9;margin-bottom:8px}
.tpnorm{display:flex;gap:4px;margin-bottom:4px}
.tpbright{display:flex;gap:4px;margin-bottom:10px}
.tpcursor{display:inline-block;width:8px;height:15px;vertical-align:-2px}
.devstage{flex:1;min-width:0;min-height:600px;border-radius:24px;background:rgba(24,24,27,.2);border:1px dashed var(--bd);overflow:hidden;display:flex;align-items:center;justify-content:center}
/* live on desktop: stage fills the viewport height and the stream fills the stage
   (noVNC/ws-scrcpy scale the remote framebuffer inside the iframe themselves) */
@media(min-width:701px){
.devstage.live{height:calc(100dvh - 210px);min-height:600px}
.devstage.live .vnc{height:100%;max-height:none;aspect-ratio:auto}
}
.stageempty{display:flex;flex-direction:column;align-items:center;text-align:center;padding:32px}
.stageicon{width:64px;height:64px;border-radius:16px;border:1px solid var(--pop);background:rgba(24,24,27,.8);display:flex;align-items:center;justify-content:center;color:var(--dim);margin-bottom:16px}
.stageicon svg{width:28px;height:28px}
.stagemsg{font:14px var(--mono);color:var(--fg2)}
.stagecap{font:12px var(--sans);color:var(--dimmer);opacity:.6;max-width:256px;line-height:19.5px;margin-top:8px}
/* device rail+stage stacking (node 36:651) — placed AFTER the unconditional rules above
   so it wins the cascade at <700px (media queries don't add specificity: a later plain
   rule otherwise clobbers an earlier @media one at equal specificity — this bit us once
   already, keep new mobile overrides for these classes below their desktop declaration). */
@media(max-width:700px){
.devlayout{flex-direction:column;gap:24px;align-items:stretch}
.devrail{width:100%}
.devstage{min-height:220px}
/* live stream on phones: no desktop-style forced height (that's gated at 701px above),
   so drop the empty-state min-height and let the box hug the 16:9 .vnc iframe exactly —
   otherwise flex-centering strands ~25px of dead padding above/below the video. */
.devstage.live{min-height:0}
}
/* app-shell feel (2026-08-25): cross-document view transitions keep the tab bar pinned and
   crossfade only the content, so a navigation reads as a screen change, not a page reload.
   Chrome 126+/Safari 18.2+; older browsers just navigate. */
@view-transition{navigation:auto}
.tabs{view-transition-name:tabs}
::view-transition-old(root){animation:.12s ease both vt-out}
::view-transition-new(root){animation:.18s cubic-bezier(.2,.7,.3,1) both vt-in}
@keyframes vt-out{to{opacity:0}}
@keyframes vt-in{from{opacity:0;transform:translateY(6px)}}
@media(prefers-reduced-motion:reduce){::view-transition-group(*),::view-transition-old(*),::view-transition-new(*){animation:none!important}}
form.busy{pointer-events:none}form.busy button,form.busy summary{animation:busy 1s ease-in-out infinite}
@keyframes busy{50%{opacity:.35}}
/* motion pass (2026-08-26): press feedback + content entrances. transform/opacity ONLY — nothing
   here can trigger layout — and all of it behind prefers-reduced-motion (view transitions are
   already killed for reduce above). The new screen rises 6px under the pinned tab bar, so a
   navigation reads as content sliding into place, not a repaint. */
@media(prefers-reduced-motion:no-preference){
:is(button,summary,.chip,.tabs a){transition:background-color .15s,border-color .15s,color .15s,transform .1s ease,opacity .1s ease}
:is(button,summary,.chip,.tabs a):active{transform:scale(.96)}
details>*:not(summary){transform-origin:top center}
details[open]>*:not(summary){animation:pop-in .18s ease}
@keyframes pop-in{from{opacity:0;transform:translateY(-4px)}}
}
`;
// fleetJs: '/' (fleet-first home) and '/history' load the tag — /history needs it too,
// phase 3 on, so its keydown handler can focus the search input (fleet.js's hasFleet
// check means /history never opens an /events connection: no fleet-rows/fleet-cards on
// that page, so it costs nothing beyond the deferred script fetch). Every other page
// still skips the tag outright — nothing there for the handler to do.
// ---------- /md: rendered markdown preview ----------
// Any session (or the user) prints `mdv <file>` → https://<host>/md?f=<abs path>; the URL
// is clickable in /term (ttyd's xterm ships the web-links addon) and opens the doc
// rendered inside the dashboard shell, phone and desktop alike. Server-side
// mini-renderer, GitHub-basics only: headings, fenced code, lists+task boxes, tables,
// quotes, hr, inline marks, autolinks. The whole source is HTML-escaped FIRST and only
// then transformed, so file content can never inject markup.
// ponytail: not CommonMark — swap in a real parser only when real docs visibly break.
const MD_ROOT = '/home';
const MD_CSS = `.mdhead{display:flex;flex-wrap:wrap;gap:4px 12px;align-items:baseline;margin:6px 0 14px;padding-bottom:10px;border-bottom:1px solid var(--bd2)}
.mdhead b{color:var(--title);font-size:16px}
.mdhead span{color:var(--dim);font:12px var(--mono);word-break:break-all}
.mdv{line-height:1.65;color:var(--fg2);padding-bottom:24px}
.mdv h1,.mdv h2,.mdv h3,.mdv h4,.mdv h5,.mdv h6{color:var(--title);margin:1.3em 0 .5em;line-height:1.25}
.mdv h1{font-size:23px;border-bottom:1px solid var(--bd2);padding-bottom:8px}
.mdv h2{font-size:18px;border-bottom:1px solid var(--bd);padding-bottom:6px}
.mdv h3{font-size:15.5px}
.mdv p,.mdv ul,.mdv ol,.mdv blockquote,.mdv pre,.mdtbl{margin:0 0 12px}
.mdv ul,.mdv ol{padding-left:22px}.mdv li{margin:3px 0}
.mdv li.task{list-style:none;margin-left:-18px}
.mdv a{color:var(--ok);text-decoration:none}.mdv a:hover{text-decoration:underline}
.mdv code{font:12.5px var(--mono);background:var(--pop);padding:2px 5px;border-radius:5px}
.mdv pre{background:var(--card2);border:1px solid var(--bd2);border-radius:var(--r);padding:12px 14px;overflow-x:auto;position:relative}
.mdv pre code{background:none;padding:0;display:block;line-height:1.55}
.mdv pre[data-lang]::after{content:attr(data-lang);position:absolute;top:6px;right:10px;color:var(--dimmer);font:11px var(--mono)}
.mdv blockquote{border-left:3px solid var(--ok-bd);padding:2px 14px;color:var(--mut)}
.mdv hr{border:0;border-top:1px solid var(--bd2);margin:20px 0}
.mdtbl{overflow-x:auto}
.mdv table{border-collapse:collapse;font-size:13.5px}
.mdv th,.mdv td{border:1px solid var(--bd2);padding:6px 10px;text-align:left}
.mdv th{background:var(--card2);color:var(--title)}
.mdv img{max-width:100%;border-radius:var(--r)}`;
function mdInline(s) { // s is already HTML-escaped; stash code spans so marks inside stay literal
  const keep = [];
  s = s.replace(/`([^`]+)`/g, (_, c) => (keep.push(`<code>${c}</code>`), `\x00${keep.length - 1}\x00`));
  // scheme allowlist: markdown files come from anywhere (cloned repos, downloads) — a
  // [link](javascript:…) must not become a live URI. Relative paths stay allowed (the
  // /md?f= rewrite in mdView picks them up).
  const safeUrl = u => /^(https?:|mailto:|#|\.{0,2}\/|[^:]+$)/i.test(u) ? u : '#';
  s = s
    .replace(/!\[([^\]]*)\]\(([^)\s]+)\)/g, (_, a, u) => `<img alt="${a}" src="${safeUrl(u)}">`)
    .replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, (_, t, u) => `<a href="${safeUrl(u)}">${t}</a>`)
    .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
    .replace(/(^|[\s(])\*([^*\s][^*]*)\*/g, '$1<em>$2</em>')
    .replace(/~~([^~]+)~~/g, '<del>$1</del>')
    .replace(/(^|[\s(])(https?:\/\/[^\s<)]+)/g, '$1<a href="$2">$2</a>');
  return s.replace(/\x00(\d+)\x00/g, (_, i) => keep[i]);
}
function mdList(items) { // ponytail: one nesting level (indent >= 2), enough for real docs
  const li = t => { const task = t.match(/^\[( |x|X)\]\s+(.*)/);
    return task ? `<li class="task"><input type="checkbox" disabled${task[1] === ' ' ? '' : ' checked'}> ${mdInline(task[2])}</li>`
                : `<li>${mdInline(t)}</li>`; };
  const base = items[0].ind, ord = items[0].ord;
  let html = '', sub = [], subOrd = false;
  const closeSub = () => { if (sub.length) {
    html = html.replace(/<\/li>$/, `<${subOrd ? 'ol' : 'ul'}>${sub.join('')}</${subOrd ? 'ol' : 'ul'}></li>`); sub = []; } };
  for (const it of items) {
    if (it.ind > base && html) { subOrd = it.ord; sub.push(li(it.text)); }
    else { closeSub(); html += li(it.text); }
  }
  closeSub();
  return `<${ord ? 'ol' : 'ul'}>${html}</${ord ? 'ol' : 'ul'}>`;
}
function mdHtml(src) {
  const lines = esc(src.replace(/\r\n?/g, '\n')).split('\n');
  const out = []; let para = [], i = 0;
  const flush = () => { if (para.length) { out.push(`<p>${mdInline(para.join(' '))}</p>`); para = []; } };
  while (i < lines.length) {
    const l = lines[i];
    const fence = l.match(/^```(\w*)/);
    if (fence) {
      const buf = []; i++;
      while (i < lines.length && !/^```/.test(lines[i])) buf.push(lines[i++]);
      i++; flush();
      out.push(`<pre${fence[1] ? ` data-lang="${fence[1]}"` : ''}><code>${buf.join('\n')}</code></pre>`);
      continue;
    }
    const h = l.match(/^(#{1,6})\s+(.*)/);
    if (h) { flush(); const n = h[1].length; out.push(`<h${n}>${mdInline(h[2])}</h${n}>`); i++; continue; }
    if (/^ {0,3}(-{3,}|_{3,}|\*{3,})\s*$/.test(l)) { flush(); out.push('<hr>'); i++; continue; }
    if (/^(\s*)([-*+]|\d+[.)])\s+/.test(l)) {
      flush(); const items = [];
      while (i < lines.length) {
        const m = lines[i].match(/^(\s*)([-*+]|\d+[.)])\s+(.*)$/);
        if (m) { items.push({ ind: m[1].length, ord: /\d/.test(m[2]), text: m[3] }); i++; }
        else if (/^\s{2,}\S/.test(lines[i])) { items[items.length - 1].text += ' ' + lines[i++].trim(); }
        else break;
      }
      out.push(mdList(items)); continue;
    }
    if (/^&gt;\s?/.test(l)) { // '>' arrives escaped
      flush(); const buf = [];
      while (i < lines.length && /^&gt;\s?/.test(lines[i])) buf.push(lines[i++].replace(/^&gt;\s?/, ''));
      out.push(`<blockquote>${buf.join('\n').split(/\n{2,}|\n(?=\s*$)/).filter(x => x.trim())
        .map(x => `<p>${mdInline(x.replace(/\n/g, ' '))}</p>`).join('')}</blockquote>`);
      continue;
    }
    if (l.includes('|') && i + 1 < lines.length && /-/.test(lines[i + 1]) && /^\s*\|?[-: |]+\|[-: |]*\s*$/.test(lines[i + 1])) {
      flush();
      const cells = r => r.replace(/^\s*\|/, '').replace(/\|\s*$/, '').split('|').map(c => mdInline(c.trim()));
      const head = cells(l); i += 2; const rows = [];
      while (i < lines.length && lines[i].includes('|')) rows.push(cells(lines[i++]));
      out.push(`<div class="mdtbl"><table><thead><tr>${head.map(c => `<th>${c}</th>`).join('')}</tr></thead><tbody>${
        rows.map(r => `<tr>${r.map(c => `<td>${c}</td>`).join('')}</tr>`).join('')}</tbody></table></div>`);
      continue;
    }
    if (!l.trim()) { flush(); i++; continue; }
    para.push(l.trim()); i++;
  }
  flush();
  return out.join('\n');
}
async function mdView(req, res, url) {
  const f = url.searchParams.get('f') || '';
  const oops = (code, m) => send(req, res, code, page('markdown', `<h1><a href="/">mows sessions</a></h1><p style="margin:18px 0">${esc(m)}</p><p><a href="/">← sessions</a></p>`));
  if (!f.startsWith('/')) return oops(400, 'usage: /md?f=/home/<user>/path/to/file.md');
  if (!/\.(md|markdown|txt)$/i.test(f)) return oops(400, 'only .md, .markdown and .txt files can be previewed.');
  let real, st;
  try { real = await fsp.realpath(f); st = await fsp.stat(real); } catch { return oops(404, `not found: ${f}`); }
  if (!real.startsWith(MD_ROOT + '/')) return oops(403, 'only files under /home are viewable.');
  if (!st.isFile() || st.size > 2 * 1024 * 1024) return oops(403, 'not a regular file under 2 MB.');
  const src = await fsp.readFile(real, 'utf8');
  let art = /\.txt$/i.test(real) ? `<pre>${esc(src)}</pre>` : mdHtml(src);
  // cross-references between docs stay browsable: relative links resolve through /md too
  art = art.replace(/href="(?!https?:|mailto:|#|\/)([^"]+)"/g,
    (_, rl) => `href="/md?f=${encodeURIComponent(path.resolve(path.dirname(real), rl))}"`);
  const kb = st.size < 1024 ? `${st.size} B` : `${(st.size / 1024).toFixed(1)} KB`;
  const when = rel(st.mtimeMs) === 'now' ? 'just now' : `${rel(st.mtimeMs)} ago`;
  const body = `<h1><a href="/">mows sessions</a></h1>
<div class="mdhead"><b>${esc(path.basename(real))}</b><span>${esc(real)}</span><span>${kb} · updated ${when}</span></div>
<article class="mdv">${art}</article>`;
  send(req, res, 200, page(`${path.basename(real)} · mows`, body, `<style>${MD_CSS}</style>`, '', '', false, null, req.headers.host));
}

function page(title, body, head = '', bodyClass = '', tab = '', fleetJs = false, liveN = null, host = '') {
  // desktop header (mock 2026-08-29): logo+title/subtitle, centered pill nav, "+ new
  // session" button; .navdup hides the whole thing <700px where the mobile <h1> + tab
  // bar rule instead (see body>h1 in CSS). liveN: live-session count badge — only pages
  // that already computed tmuxLive pass it; fleet.js keeps it fresh (id=pnav-live) on
  // pages that carry the island. host: real request Host header — SPEC text mapping
  // ("connected · <host>"), never a hardcoded/placeholder address.
  const pnav = `<nav class="pnav">
<a class="${tab === 'sessions' ? 'on' : ''}" href="/">Sessions${liveN != null ? ` <b class="pbdg" id="pnav-live"${liveN ? '' : ' hidden'}>${liveN}</b>` : ''}</a>
<a class="${tab === 'history' ? 'on' : ''}" href="/history">History</a>
<a class="${tab === 'system' ? 'on' : ''}" href="/system">System</a>
<a class="${tab === 'device' ? 'on' : ''}" href="/device">Device</a></nav>`;
  const hdr = `<header class="hdr navdup">
<div class="hdl"><span class="hlogo" aria-hidden="true">&gt;_</span><div class="hcol"><div class="htitle">mows control</div><div class="hsub">Connected · ${esc(host || os.hostname())}</div></div></div>
${pnav}
<a class="hnew" href="${termHref('menu', '')}">${ICO.plus}<span class="hnew-lbl">New Session</span></a></header>`;
  const tabs = `<nav class="tabs">
<a class="tb${tab === 'sessions' ? ' on' : ''}" href="/"><span class="ti">${ICO.list}</span>Sessions</a>
<a class="tb${tab === 'history' ? ' on' : ''}" href="/history"><span class="ti">${ICO.history}</span>History</a>
<a class="tb${tab === 'system' ? ' on' : ''}" href="/system"><span class="ti">${ICO.activity}</span>System</a>
<a class="tb${tab === 'device' ? ' on' : ''}" href="/device"><span class="ti">${ICO.monitorSmartphone}</span>Device</a></nav>`;
  // terminal is an ACTION (opens the ttyd session picker), not a content page — kept as a
  // persistent floating utility button (every tab, every width) instead of a 5th nav tab
  // (gap #5: nav must read sessions·history·system·device, exactly 4).
  const termFab = `<a class="termfab" href="${termHref('menu', '')}" title="open terminal" aria-label="open terminal">${ICO.terminal}</a>`;
  return `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1,maximum-scale=1,user-scalable=no,viewport-fit=cover,interactive-widget=resizes-content">
<meta name="color-scheme" content="dark"><meta name="theme-color" content="#09090b">
<link rel="manifest" href="/manifest.webmanifest" crossorigin="use-credentials">
<link rel="icon" href="/favicon.png"><link rel="apple-touch-icon" href="/apple-touch-icon.png">
<meta name="mobile-web-app-capable" content="yes"><meta name="apple-mobile-web-app-capable" content="yes">
<meta name="apple-mobile-web-app-status-bar-style" content="black-translucent">${head}
<script type="speculationrules">{"prerender":[{"where":{"and":[{"href_matches":["/","/?*","/history","/history?*","/system","/device","/s/*"]},{"not":{"selector_matches":"a[href*='fresh=1'],a[href*='reclaim=1']"}}]},"eagerness":"moderate"}]}</script>
<title>${esc(title)}</title><style>${CSS}</style></head><body class="${bodyClass}">${hdr}${termFab}${body}
${tabs}<footer><a href="/oauth2/sign_out">sign out</a><span>lite · no-js · ${index.length} indexed</span><span id="envout"></span></footer>
<script>if('serviceWorker' in navigator)navigator.serviceWorker.register('/sw.js');
/* a POST-redirect-GET action shows its work while it runs (docker prune can take 8 s); bfcache restore clears it */
document.addEventListener('submit',function(e){e.target.classList.add('busy')});
addEventListener('pageshow',function(){document.querySelectorAll('form.busy').forEach(function(f){f.classList.remove('busy')})});
/* attach / >_ open the session in its OWN window on a desktop or tablet BROWSER, so the
   dashboard stays put and pause/kill/the other sessions stay one click away. NOT in the
   installed PWA: there is no second window there, and target=_blank throws the user out to
   the system browser and off the app — same reason phone-width (<700px, the layout
   breakpoint this file uses everywhere) stays in place. The target is named per session
   (data-nw), so clicking one twice reuses its window instead of opening a rival tmux
   client, which would detach the first (attach -d). Deliberately no rel=noopener: with
   it the spec ignores the window name and every click spawns another window, and the page
   opened is our own /term on this origin. JS off => in place, exactly as before. Embed mode
   JS off => in place, exactly as before. */
if(matchMedia('(display-mode: browser)').matches&&innerWidth>=700&&matchMedia('(pointer:fine)').matches)
  document.querySelectorAll('a[data-nw]').forEach(function(a){a.target=a.dataset.nw});
/* pointer:fine is load-bearing, not decoration: a phone in landscape is >=700px wide, and without
   it the attach link there opened a second window instead of navigating, so the session looked
   unreachable (found by mobile-journey.mjs's landscape case, 2026-08-26). Named windows are a
   mouse affordance; a touch device has no second window to put them in. */
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
})},700)})();
/* vpfix: iOS standalone can launch/resume with the layout viewport short by the top
   safe-area inset (dash3 measured ih=894 vs sh=956, vh=894 — nothing paints below it,
   so the bottom tab bar either clips or floats above the real screen bottom; a
   navigation sometimes snaps it back, which is why other tabs looked fine). Viewport-meta
   rewrites are IGNORED in standalone (tried 2026-08-30: beacons show ok=0 n=6 ih=894);
   the workaround that works (dev.to/cederhook, same bug) is a synchronous display:none →
   reflow → restore on the full-height element — WebKit re-measures the viewport, no
   visible flash since it's all within one frame. Portrait-only: iOS screen.height is
   portrait-fixed, so landscape always reads "short". Beacons the outcome to /z. */
(function(){
if(!matchMedia('(display-mode: standalone)').matches)return;
var n=0;
function short(){return matchMedia('(orientation: portrait)').matches&&innerHeight+4<screen.height}
function heal(){
  if(!short())return;
  if(n>=6){
    /* in-page re-measures exhausted — a real navigation is the one thing measured to
       snap the viewport back (dash3 mixes 894 and 956 loads; tapping another tab fixed
       it). One reload per 30s, visible pages only, so a stubborn state can't loop. */
    var r=+sessionStorage.vpr||0;
    if(Date.now()-r>30000&&document.visibilityState==='visible'){sessionStorage.vpr=Date.now();return location.reload()}
    return fetch('/z?t=vpfix&ok=0&r=1&n='+n+'&ih='+innerHeight+'&p='+encodeURIComponent(location.pathname)).catch(function(){});
  }
  n++;
  var y=scrollY,b=document.body;
  b.style.display='none';void b.offsetHeight;b.style.display='';
  scrollTo(0,y);
  setTimeout(function(){
    if(short())heal();
    else fetch('/z?t=vpfix&ok=1&n='+n+'&ih='+innerHeight+'&p='+encodeURIComponent(location.pathname)).catch(function(){})
  },250);
}
addEventListener('pageshow',function(){n=0;setTimeout(heal,80)});
document.addEventListener('visibilitychange',function(){if(!document.hidden){n=0;setTimeout(heal,80)}});
addEventListener('resize',function(){n=0;setTimeout(heal,80)});
setTimeout(heal,120);
})()</script>${fleetJs ? '<script defer src="/fleet.js"></script>' : ''}
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

// ---------- /app: entry point of the persistent terminal (spec 2026-08-25, execution v2) ----------
// v1 wrapped /term in an iframe. On iOS that broke every keyboard / safe-area trick in
// infra/webconsole/blocks (they assume the terminal is the top-level document): keyboard over
// the input line, lag on every key. Now /term IS the shell — blocks/35-ccsess.html draws the
// session row and the ≡ drawer inside the terminal page — and /app only mints the tabid (the
// key web-term.sh uses to find this browser tab's tmux client) and redirects.
const tabid = () => randomBytes(4).toString('hex');
const termHref = (kind, name) => `/term/?arg=${kind}&arg=${encodeURIComponent(name)}&arg=${tabid()}&v=3`;
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
async function appView(req, res, url) {
  const live = await tmuxLive();
  const openSid = url.searchParams.get('open') || '';
  let to;
  if (/^[0-9a-f]{8}$/.test(openSid)) to = termHref('open', openSid);
  else { const s = await initialSession(url, live, new Set(live.map(l => l.name))); to = s ? termHref('attach', s) : '/term/?v=3'; }
  res.writeHead(302, { location: to, 'cache-control': 'no-store' }); res.end();
}
// GET /app/live.json?tab= (§2): the chip list this tab's poll refreshes itself with.
async function liveJson(req, res, url) {
  const tab = url.searchParams.get('tab') || '';
  // no-store, not send()'s usual no-cache: this must never be revalidated, only re-fetched
  if (!/^[0-9a-f]{8}$/.test(tab)) {
    res.writeHead(400, { 'content-type': 'application/json', 'cache-control': 'no-store' });
    return res.end(JSON.stringify({ err: 'bad tab' }));
  }
  const live = await tmuxLive();
  let tty = '';
  try { tty = (await fsp.readFile(path.join(TMUX_HOME, '.cache', 'webterm-clients', tab), 'utf8')).trim(); } catch {}
  let cur = '';
  if (tty) {
    const out = await sh('runuser', ['-u', TMUX_USER, '--', 'tmux', 'list-clients', '-F', '#{client_tty}\t#{session_name}']);
    for (const l of out.trim().split('\n')) { const [t, n] = l.split('\t'); if (t === tty) { cur = n; break; } }
  }
  const buf = Buffer.from(JSON.stringify(live.map(l => ({ name: l.name, label: l.label || '', current: l.name === cur }))));
  res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store', 'content-length': buf.length });
  res.end(buf);
}

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
const hostAcct = req => BY_ID[HOST_ACCT[(req.headers.host || '').split('.')[0]]] || null;
function manifest(req, res) {
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
// ponytail: no caching in the SW — every page is live data and ~4KB; an offline
// console is useless, so offline just says so instead of the browser dino.
const SW = `self.addEventListener('install',()=>self.skipWaiting());
self.addEventListener('activate',e=>e.waitUntil(self.clients.claim()));
const OFF='<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>offline</title><body style="background:#09090b;color:#9f9fa9;font:14px/1.5 ui-monospace,SFMono-Regular,Menlo,monospace;margin:0;display:flex;min-height:100vh;align-items:center;justify-content:center;text-align:center"><div><div style="color:#00d492;font-size:26px;padding-bottom:10px">&gt;_</div>offline — the console needs a connection.<br><br><a style="color:#00d492" href="/">retry</a></div>';
self.addEventListener('fetch',e=>{
  if(e.request.mode==='navigate')
    e.respondWith(fetch(e.request).catch(()=>new Response(OFF,{headers:{'content-type':'text/html; charset=utf-8'}})));
});
`;

// ---------- /events: SSE fleet live-update stream (Fleet Redesign §3) ----------
// shape sent over the wire: [{sid8,name,label,proj,state,rel,snippet}] per the spec —
// "rel" carries the raw mt (ms epoch), not a preformatted "3m" string: fleet.js needs the
// epoch to tick the display every 30s on its own, without waiting on the next snapshot
// (which only arrives when something actually changes, not on a fixed clock).
function fleetEventPayload(fleet) {
  return fleet.map(f => ({ sid8: fleetKey(f), name: f.name, label: f.label || '', proj: f.proj,
                            state: f.state, rel: f.mt, snippet: f.snippet }));
}
const SSE_MAX = 8; // this box already runs hot (spec §3) — 9th concurrent client gets 503
let sseClients = 0;
async function eventsView(req, res) {
  if (sseClients >= SSE_MAX) { res.writeHead(503, { 'retry-after': '30' }); return res.end('too many /events clients'); }
  sseClients++;
  res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-store', connection: 'keep-alive' });
  let last = '', done = false, poll = null, hb = null;
  const cleanup = () => { // several of these can fire for one disconnect — only decrement once
    if (done) return; done = true;
    clearInterval(poll); clearInterval(hb); sseClients = Math.max(0, sseClients - 1);
  };
  // registered BEFORE the first (slow) tick: that tick's first fleetState() call can be a
  // cache miss doing tmux list-panes + ps + one capture-pane per live session (execFile,
  // up to 5s timeout each) — genuinely slow on this box. A client that disconnects during
  // that window fires req 'aborted' with zero listeners if registered after, and the
  // poll/hb intervals below then run forever for a gone client (the exact leak class this
  // file's 2026-08-28 lessons.md entry already fixed at the steady-state boundary).
  // 'close' on req/res is the documented event, but empirically (Node 22, this box) it never
  // fires for a mid-stream client disconnect on a GET — only 'aborted' does, confirmed with a
  // throwaway repro server (curl killed by SIGTERM, and curl's own --max-time, both only ever
  // raised 'aborted'). Keep 'close' too — cheap insurance if a future Node/proxy combination
  // actually fires it instead.
  req.on('aborted', cleanup); req.on('close', cleanup); res.on('close', cleanup);
  const tick = async () => {
    if (done) return; // disconnected mid-tick (e.g. during the slow first tick) — drop it
    try {
      const payload = JSON.stringify(fleetEventPayload(await fleetState()));
      if (payload !== last) { last = payload; res.write(`event: fleet\ndata: ${payload}\n\n`); }
    } catch { /* one bad tick must not kill the stream — next tick tries again */ }
  };
  await tick(); // the client's first paint must not wait a full 2s for the initial snapshot
  if (done) return; // disconnected during that first tick — cleanup already ran, don't arm timers
  poll = setInterval(tick, 2000);
  hb = setInterval(() => { try { res.write(': hb\n\n'); } catch {} }, 25000); // comment heartbeat, keeps idle proxies from closing the connection
}
// ---------- /fleet.js: dashboard live-update client island (Fleet Redesign §3) ----------
// One hand-written file, zero deps, ~200 lines. EventSource + reconnect; patches the
// server-rendered rows/cards in place by data-sid (see fleetRowHtml/fleetCardHtml/
// fleetMenu above — every element this file touches carries a data-f hook there, and
// changing one side without the other is the only way this can silently break).
// phase 3 (spec §3 tail): 1-9 attach the nth fleet row, '/' focuses the fleet filter if
// one exists else the /history search — both live in the keydown handler at the bottom,
// which runs on EVERY page fleet.js loads (not gated on hasFleet below), since '/' on
// /history must work with no fleet-rows/cards on the page at all.
const FLEET_JS = `(function(){
'use strict';
var rowsC=document.getElementById('fleet-rows'),cardsC=document.getElementById('fleet-cards');
// hasFleet, not an early return: this page may still need the keydown handler below
// (e.g. /history, which has neither container) even with nothing here to live-patch.
var hasFleet=!!(rowsC&&cardsC&&typeof EventSource!=='undefined');
var emptyEl=hasFleet&&document.getElementById('fleet-empty');
if(hasFleet){
var GLYPH={'needs-you':'\\u25c9',working:'\\u25cf',paused:'\\u23f8',idle:'\\u25cb'};
var WORD={'needs-you':'waiting',working:'working',paused:'paused',idle:'idle'};
function esc(s){return String(s).replace(/[&<>"']/g,function(c){return{'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]})}
// mirrors the server's rel() exactly (lite.mjs) — same thresholds, same output shape
function relStr(ms){var s=(Date.now()-ms)/1000;return s<90?'now':s<5400?(s/60|0)+'m':s<129600?(s/3600|0)+'h':(s/86400|0)+'d'}
// mirrors fleetMetaHtml() server-side: status word + relative time (snippet is its own
// [data-f=snip] node in both layouts since the mock reskin)
function metaHtml(state,mt){return WORD[state]+' '+relStr(mt)}
function tabid(){var b=crypto.getRandomValues(new Uint8Array(4)),h='';for(var i=0;i<4;i++)h+=b[i].toString(16).padStart(2,'0');return h}
function attachHref(name){return '/term/?arg=attach&arg='+encodeURIComponent(name)+'&arg='+tabid()+'&v=3'}
// every field a live update can touch — glyph class/char, label, proj, meta line (word +
// time + snippet), the attach link, and the ⋯ menu's forms (pause<->resume swap, the
// name shown in it, the rename input's current value). Row order is NOT handled here —
// the caller appendChild()s the returned/patched node into place.
function patch(node,f){
  node.dataset.sid=f.sid8; node.dataset.state=f.state; node.dataset.mt=f.rel;
  var g=node.querySelector('[data-f=glyph]'); if(g){g.className='fli fli-'+f.state;g.textContent=GLYPH[f.state]}
  var lb=node.querySelector('[data-f=label]'); if(lb)lb.textContent=f.label||f.proj||f.name;
  var pj=node.querySelector('[data-f=proj]'); if(pj)pj.textContent=f.proj;
  var mt=node.querySelector('[data-f=meta]'); if(mt)mt.textContent=metaHtml(f.state,f.rel);
  var sn=node.querySelector('[data-f=snip]'); if(sn){sn.textContent=f.snippet;sn.style.display=f.snippet?'':'none'}
  var at=node.querySelector('[data-f=attach]'); if(at){at.href=attachHref(f.name);at.dataset.nw='t-'+f.name}
  var nl=node.querySelectorAll('[data-f=nameinput]'); for(var i=0;i<nl.length;i++)nl[i].value=f.name;
  var tn=node.querySelector('[data-f=tname]'); if(tn)tn.textContent=f.name;
  var kn=node.querySelector('[data-f=killname]'); if(kn)kn.textContent=f.name;
  var li=node.querySelector('[data-f=labelinput]'); if(li)li.value=f.label||'';
  var pf=node.querySelector('[data-f=pauseform]'),pb=node.querySelector('[data-f=pausebtn]');
  if(pf&&pb){
    if(f.state==='paused'){pf.action='/a/resume';pb.className='ab ok';pb.innerHTML='${ICO.play}Resume'}
    else{pf.action='/a/pause';pb.className='ab';pb.innerHTML='${ICO.pause}Pause'}
  }
}
function instantiate(tplId,f){
  var node=document.getElementById(tplId).content.firstElementChild.cloneNode(true);
  patch(node,f); return node;
}
// text filter (spec §3 phase 3, '/' focus target on '/'): matches label/proj/snippet,
// substring, case-insensitive. Toggled via style.display, not the hidden attribute —
// .li/.lp both carry their own display:flex, which an author rule always beats the UA
// default for [hidden]; see sn.style.display above for the same pattern in this file.
var filterEl=document.querySelector('[data-f=filter]');
function rowMatches(node,term){
  if(!term)return true;
  var lb=node.querySelector('[data-f=label]'),pj=node.querySelector('[data-f=proj]'),sn=node.querySelector('[data-f=snip]');
  var text=((lb?lb.textContent:'')+' '+(pj?pj.textContent:'')+' '+(sn?sn.textContent:'')).toLowerCase();
  return text.indexOf(term)!==-1;
}
function applyFilter(){
  var term=filterEl?filterEl.value.trim().toLowerCase():'';
  Array.prototype.forEach.call(rowsC.children,function(el){el.style.display=rowMatches(el,term)?'':'none'});
  Array.prototype.forEach.call(cardsC.children,function(el){el.style.display=rowMatches(el,term)?'':'none'});
}
if(filterEl)filterEl.addEventListener('input',applyFilter);
function render(list){
  var seen={};
  list.forEach(function(f){
    seen[f.sid8]=true;
    var sel='[data-sid="'+CSS.escape(f.sid8)+'"]';
    var r=rowsC.querySelector(sel); if(r)patch(r,f); else r=instantiate('fleet-row-tpl',f);
    rowsC.appendChild(r); // already-attached node: appendChild MOVES it — this is the reorder, no rebuild
    var c=cardsC.querySelector(sel); if(c)patch(c,f); else c=instantiate('fleet-card-tpl',f);
    cardsC.appendChild(c);
  });
  Array.prototype.filter.call(rowsC.children,function(el){return !seen[el.dataset.sid]}).forEach(function(el){el.remove()});
  Array.prototype.filter.call(cardsC.children,function(el){return !seen[el.dataset.sid]}).forEach(function(el){el.remove()});
  if(emptyEl)emptyEl.hidden=list.length>0;
  var cnt=document.getElementById('fleet-count'); if(cnt){cnt.textContent=list.length;cnt.hidden=list.length===0}
  var pb=document.getElementById('pnav-live'); if(pb){pb.textContent=list.length;pb.hidden=list.length===0}
  updateNums();
  applyFilter(); // keep the current filter applied across live patches/inserts/removals
}
// keeps the 1-9 keyboard badges (data-f=num, rows only) matching each row's CURRENT
// position after a reorder — the server only numbers the first render, every later
// number comes from here. Cards never carry a [data-f=num] node so querySelector below
// is just a no-op for them.
function updateNums(){
  var rows=rowsC.children;
  for(var i=0;i<rows.length;i++){
    var n=rows[i].querySelector('[data-f=num]'); if(n)n.textContent=i<9?String(i+1):'';
  }
}
// tick relative times every 30s locally, between snapshots — reads back the mt this node
// was last patched with (dataset.mt); skip nodes never patched yet (server markup carries
// no data-mt, and +undefined is NaN — relStr(NaN) would render "NaNd" if SSE never connects)
function tick(){
  var hosts=document.querySelectorAll('[data-sid]');
  for(var i=0;i<hosts.length;i++){
    var host=hosts[i],m=host.querySelector('[data-f=meta]'); if(!m||!host.dataset.mt)continue;
    m.textContent=metaHtml(host.dataset.state,+host.dataset.mt);
  }
}
setInterval(tick,30000);
var retry=1000;
function connect(){
  var es=new EventSource('/events');
  es.addEventListener('fleet',function(e){retry=1000;try{render(JSON.parse(e.data))}catch(err){}});
  es.onerror=function(){es.close();setTimeout(connect,retry+Math.random()*400);retry=Math.min(retry*2,30000)};
}
connect();
} // end if(hasFleet)
// desktop keys (spec §3 phase 3): 1-9 attach the nth fleet row (rows only — that is
// what the on-screen 1-9 badges number; cards have no keyboard affordance and no
// number), '/' focuses a fleet filter if the page has one, else the /history search
// when this page IS /history. Both branches no-op harmlessly on any other page.
document.addEventListener('keydown',function(e){
  if(e.defaultPrevented||e.altKey||e.ctrlKey||e.metaKey)return;
  var t=e.target,tag=t&&t.tagName;
  if(tag==='INPUT'||tag==='TEXTAREA'||(t&&t.isContentEditable))return; // never hijack typing
  if(e.key>='1'&&e.key<='9'){
    if(!rowsC)return; // this page has no fleet rows to number (e.g. /history)
    var row=rowsC.children[+e.key-1]; if(!row)return;
    var a=row.querySelector('[data-f=attach]'); if(!a)return;
    e.preventDefault(); a.click(); // click, not location=... : respects data-nw window-reuse as-is
    return;
  }
  if(e.key==='/'){
    var ff=document.querySelector('[data-f=filter]');
    if(ff){e.preventDefault();ff.focus();return}
    if(location.pathname==='/history'){
      // the filter lives inside a collapsed <details> (folded by default, see fOn in
      // listView) — a closed <details> refuses to focus its content in every browser,
      // so open it first (QA 2026-08-28: '/' left focus on BODY on first load).
      var det=document.querySelector('details.flt');
      var q=det&&det.querySelector('input[name=q]');
      if(q){det.open=true;e.preventDefault();q.focus();if(q.select)q.select()}
    }
  }
});
/* pull-to-refresh — installed app only: a browser tab already has it natively, and a
   custom one there would fight the built-in gesture. Never preventDefault (passive
   listeners), so scrolling stays untouched; the chip arms at a 60px pull. */
if(matchMedia('(display-mode: standalone)').matches&&'ontouchstart' in window){
  var ptr=document.createElement('div');ptr.id='ptr';ptr.innerHTML='${ICO.refresh}';document.body.appendChild(ptr);
  var y0=0,armed=false;
  addEventListener('touchstart',function(e){armed=scrollY<=0;y0=e.touches[0].clientY},{passive:true});
  addEventListener('touchmove',function(e){
    if(!armed)return;
    var pull=e.touches[0].clientY-y0;
    if(pull>8&&scrollY<=0){var p=Math.min(pull/2,72);
      ptr.style.transform='translate(-50%,'+p+'px) rotate('+p*3+'deg)';
      ptr.style.opacity=Math.min(p/56,1);ptr.classList.toggle('go',p>=56)}
    else{ptr.style.opacity=0;ptr.classList.remove('go')}
  },{passive:true});
  addEventListener('touchend',function(){
    if(!armed)return;armed=false;
    if(ptr.classList.contains('go')){ptr.classList.add('spin');location.reload()}
    else{ptr.style.transform='';ptr.style.opacity=0}
  },{passive:true});
}
})();
`;

// ---------- views ----------
// one transcript row — shared by /history's day-grouped list and /'s "today" strip.
function sessionRowHtml(e, title, liveBySid, back) {
  const a = BY_ID[e.a], sid8 = e.sid.slice(0, 8);
  const isLive = liveBySid.has(sid8);
  const go = a.term && canResume(e.mt, isLive) ? `<a class="go" data-nw="t-${sid8}" href="${esc(isLive ? termHref('attach', liveBySid.get(sid8).name) : termHref('open', sid8))}" title="${isLive ? 'attach (live)' : 'resume in terminal'}" aria-label="${isLive ? 'attach in terminal (live)' : 'resume in terminal'}">&gt;_</a>` : '';
  const del = isLive ? '' : `<details class="kx del"><summary class="dx" title="delete transcript" aria-label="delete transcript ${sid8}">${ICO.x}</summary><div class="kc"><div>delete <b>${sid8}</b>?</div><span class="muted">removes the transcript from disk — no undo.</span><form class="af" method="post" action="/a/del"><input type="hidden" name="a" value="${e.a}"><input type="hidden" name="sid" value="${esc(e.sid)}"><input type="hidden" name="back" value="${esc(back)}"><button class="ab danger">Delete It</button></form></div></details>`;
  return `<div class="li"><a class="row" href="/s/${e.a}/${e.sid}">
<span class="t">${rel(e.mt)}</span>
<span class="acct" style="color:${a.color}">${a.label}</span>
<span class="proj">${esc(projName(e.proj))}</span>
<span class="ttl">${isLive ? '<span class="lvb"><span class="lvbd" aria-hidden="true"></span>LIVE</span> ' : ''}${esc(title) || '<span class="notitle">(no title)</span>'}</span>
<span class="sz">${fmtSz(e.sz)}</span><span class="sid">${sid8}</span></a>${go}${del}</div>`;
}
// ---------- fleet item rendering (Fleet Redesign §2, live-patched by fleet.js §3) ----------
// state glyph + word, per the spec table; colors are CSS classes now (.fli-<state>), not
// inline style — fleet.js flips the class on a live patch instead of touching style.color.
const FLEET_GLYPH = { 'needs-you': '◉', working: '●', paused: '⏸', idle: '○' };
const FLEET_WORD = { 'needs-you': 'waiting', working: 'working', paused: 'paused', idle: 'idle' };
const fleetWhen = mt => { const r = rel(mt); return r === 'now' ? 'now' : r; };
// stable per-item identity for data-sid: sid8 when the live session joined a transcript,
// else the tmux name (fleetState() can return sid8:'' for a pane with no transcript match
// yet) — either way unique across the fleet and unchanging for the session's lifetime.
const fleetKey = f => f.sid8 || f.name;
// word + relative time (mock reskin: the snippet is its own [data-f=snip] node in BOTH
// layouts now — rows line 2, cards below the meta line — so meta is just the status).
function fleetMetaHtml(f) {
  return `${FLEET_WORD[f.state]} ${fleetWhen(f.mt)}`;
}
// pause/resume + rename + kill folded behind ONE ⋯ popover (spec §2) — the tmux name
// (mono, copyable) lives in here too, demoted off the primary label. data-f hooks are
// fleet.js's ONLY contract with this markup: it clones this exact HTML from a <template>
// (see fleetTemplates() below) and never re-derives it, so a change here needs no client change.
function fleetMenu(f, back) {
  const l = f.l;
  const hid = (n, v, df = '') => `<input type="hidden" name="${n}" value="${esc(v)}"${df ? ` data-f="${df}"` : ''}>`;
  const pr = l.paused
    ? `<form class="af" method="post" action="/a/resume" data-f="pauseform">${hid('name', l.name, 'nameinput')}${hid('back', back)}<button class="ab ok" data-f="pausebtn">${ICO.play}Resume</button></form>`
    : `<form class="af" method="post" action="/a/pause" data-f="pauseform">${hid('name', l.name, 'nameinput')}${hid('back', back)}<button class="ab" data-f="pausebtn">${ICO.pause}Pause</button></form>`;
  const rn = `<form class="af lf" method="post" action="/a/label">${hid('name', l.name, 'nameinput')}${hid('back', back)}<span class="klbl">Rename</span><input class="li2" name="label" value="${esc(l.label || '')}" maxlength="60" placeholder="session name" aria-label="session name" data-f="labelinput"><button class="ab ok">Save</button></form>`;
  const kl = `<details class="kx"><summary class="ab danger">${ICO.x}Kill</summary><div class="kc"><div>stop <b data-f="killname">${esc(l.name)}</b>?</div><span class="muted">the process ends now — the transcript stays on disk, resume anytime.</span><form class="af" method="post" action="/a/kill">${hid('name', l.name, 'nameinput')}${hid('back', back)}<button class="ab danger">Kill It</button></form></div></details>`;
  return `<details class="kx" name="fm"><summary class="ab" title="more actions">${ICO.ellipsis}</summary><div class="kc">
<div class="tname" data-f="tname">${esc(l.name)}</div>${pr}${rn}${kl}</div></details>`;
}
// mock's Sessions card (2026-08-29): two lines — big title + colored status word at the
// right edge, snippet in dim mono below with the project tucked bottom-right. Actions
// (attach, ⋯, kbd badge) sit before the status word and fade in on hover (pointer:fine),
// like the history rows; opacity-only so nothing shifts when they appear.
function fleetRowHtml(f, back, idx) {
  const label = esc(f.label || f.proj || f.name);
  return `<div class="li" data-sid="${esc(fleetKey(f))}" data-state="${f.state}"><div class="frow">
<div class="fr1">
<span class="fli fli-${f.state}" aria-hidden="true" data-f="glyph">${FLEET_GLYPH[f.state]}</span>
<span class="lb" data-f="label">${label}</span>
<span class="proj" data-f="proj">${esc(f.proj)}</span>
<span class="fact"><span class="fnum" data-f="num" aria-hidden="true">${idx != null && idx < 9 ? idx + 1 : ''}</span><a class="go" data-nw="t-${esc(f.name)}" data-f="attach" href="${esc(termHref('attach', f.name))}" title="attach" aria-label="attach ${esc(f.name)}">&gt;_</a>${fleetMenu(f, back)}</span>
<span class="fst" data-f="meta">${fleetMetaHtml(f)}</span>
</div>
<span class="fsnip" data-f="snip"${f.snippet ? '' : ' style="display:none"'}>${esc(f.snippet)}</span>
</div></div>`;
}
function fleetCardHtml(f, back) {
  const label = esc(f.label || f.proj || f.name);
  return `<div class="lp" data-sid="${esc(fleetKey(f))}" data-state="${f.state}">
<div class="lr fchd" style="justify-content:space-between">
<span class="lb"><span class="fli fli-${f.state}" aria-hidden="true" data-f="glyph">${FLEET_GLYPH[f.state]}</span> <span data-f="label">${label}</span></span>
<span class="fcact"><a class="ab ok" data-nw="t-${esc(f.name)}" data-f="attach" href="${esc(termHref('attach', f.name))}" title="attach" aria-label="attach ${esc(f.name)}" style="font:700 13px var(--mono)">&gt;_</a>${fleetMenu(f, back)}</span>
</div>
<div class="muted" style="font-size:12.5px"><span data-f="proj">${esc(f.proj)}</span> · <span data-f="meta">${FLEET_WORD[f.state]} ${fleetWhen(f.mt)}</span></div>
<div class="fsnip" data-f="snip" style="font-size:12.5px${f.snippet ? '' : ';display:none'}">${esc(f.snippet)}</div>
</div>`;
}
// hidden <template>s fleet.js clones to insert a session that wasn't on the page yet — built
// from the SAME fleetRowHtml/fleetCardHtml/fleetMenu functions real rows use (a placeholder
// object, values irrelevant: every data-f node gets overwritten on instantiation), so the
// template can never drift from what a fresh page load would have rendered for that row.
function fleetTemplates(back) {
  const ph = { name: 'x', sid8: 'x', label: '', proj: '', state: 'idle', mt: Date.now(), snippet: 'x',
               l: { name: 'x', paused: false, label: '' } };
  return `<template id="fleet-row-tpl">${fleetRowHtml(ph, back)}</template><template id="fleet-card-tpl">${fleetCardHtml(ph, back)}</template>`;
}
function renderFleet(fleet, back) {
  // idx feeds fleetRowHtml's 1-9 keyboard-nav badge (§3 phase 3) — cards never show it,
  // so no idx there.
  const rows = fleet.map((f, i) => fleetRowHtml(f, back, i)).join('');
  const cards = fleet.map(f => fleetCardHtml(f, back)).join('');
  // the two list containers always render (even empty) so fleet.js has a stable place to
  // append into without a reload; CSS hides an empty one (.fleet-rows:empty), and the
  // "no live sessions" line toggles via the plain `hidden` attribute, not display juggling
  // that would fight the responsive rows/cards breakpoint rule.
  return `<p class="muted" id="fleet-empty"${fleet.length ? ' hidden' : ''} style="padding:8px 4px 16px">no live sessions.</p>
<div class="fleet-rows" id="fleet-rows">${rows}</div>
<div class="fleet-cards" id="fleet-cards">${cards}</div>
${fleetTemplates(back)}`;
}
// ---------- /: fleet-first home (Fleet Redesign §2, reskin 2026-08-29) ----------
// h1 + fleet only — matches the mock's Sessions tab exactly: no system stats, no today
// list. System metrics now have their own tab (/system) and recent-session browsing lives
// entirely on /history (which already groups by day) — see the server routing block for
// the old-link redirects that keep both moved flows reachable.
async function homeView(req, res, url) {
  freshen();
  const fleet = await fleetState();
  const body = `<h1><a href="/">mows sessions</a></h1>
<div class="sect">fleet <b id="fleet-count"${fleet.length ? '' : ' hidden'}>${fleet.length}</b><input type="search" data-f="filter" placeholder="filter…" aria-label="filter fleet sessions" autocomplete="off" style="margin-left:8px;width:120px;min-height:0;padding:3px 8px;vertical-align:middle"></div>
${renderFleet(fleet, '/')}
<a class="newcard" href="${termHref('menu', '')}">+ New Session · open terminal picker</a>`;
  send(req, res, 200, page('mows sessions', body, '', '', 'sessions', true, fleet.length, req.headers.host));
}
// ---------- /system: host + usage metrics as their own page (gap #2) ----------
// Same sysPanel the strip used to render on '/', now flat/always-expanded on its own tab.
// ?fresh=1 / reclaim=1 / freed=&rn= keep working exactly as before, just targeting /system.
async function systemView(req, res, url) {
  const rec = { href: '/system?reclaim=1', back: '/system' };
  if (url.searchParams.get('reclaim')) { rec.scan = await reclaimScan(); rec.href = '/system'; }
  if (url.searchParams.get('freed')) {
    rec.freed = +url.searchParams.get('freed') || 0;
    rec.n = +url.searchParams.get('rn') || 0;
  }
  const [live, ver, deployStat] = await Promise.all([
    tmuxLive(), claudeVersion(), fsp.stat(new URL(import.meta.url)).catch(() => null),
  ]);
  const extra = { live, ver, deployMt: deployStat ? deployStat.mtimeMs : null,
    rsN: +url.searchParams.get('rs') || 0 };
  const body = `<h1><a href="/">← sessions</a> <span class="muted">· system</span></h1>
${sysPanel('/system?fresh=1', true, rec, true, extra)}`;
  send(req, res, 200, page('system · mows sessions', body,
    usageCache.busy ? '<meta http-equiv="refresh" content="4">' : '', '', 'system', false, null, req.headers.host));
}
function pager(base, params, cur, max, extra = '') {
  // spec: four icon-only 32×32 buttons — same first/prev/next/last targets as before,
  // just chevron glyphs instead of "prev"/"next" text; aria-label keeps them a11y-named.
  const link = (p, txt, label) => p >= 1 && p <= max && p !== cur
    ? `<a href="${base}${qs({ ...params, page: p > 1 ? p : '' })}" aria-label="${label}" title="${label}">${txt}</a>`
    : `<span class="off" aria-hidden="true">${txt}</span>`;
  return `<nav class="pg">${link(1, ICO.chevronsLeft, 'first page')}${link(cur - 1, ICO.chevronLeft, 'previous page')}
<span class="pgnum"><span class="cur">${cur}</span><span class="muted">/ ${max}</span></span>${extra}
${link(cur + 1, ICO.chevronRight, 'next page')}${link(max, ICO.chevronsRight, 'last page')}</nav>`;
}
async function listView(req, res, url) {
  freshen();
  const sub = (req.headers.host || '').split('.')[0];
  const acct = url.searchParams.get('acct') || HOST_ACCT[sub] || '';
  const q = (url.searchParams.get('q') || '').toLowerCase().slice(0, 80);
  const d = url.searchParams.get('d') || '';
  const s = url.searchParams.get('s') || '';
  const live = await tmuxLive();
  const liveBySid = new Map(live.map(l => [liveSid8(l), l]).filter(([k]) => k)); // sid8 -> live session
  let rows = index;
  if (acct && BY_ID[acct]) rows = rows.filter(e => e.a === acct);
  if (q) rows = rows.filter(e => e.proj.toLowerCase().includes(q) || e.sid.startsWith(q));
  const CUT = { today: new Date(new Date().toISOString().slice(0, 10)).getTime(),
    '7d': Date.now() - 7 * 86400e3, '30d': Date.now() - 30 * 86400e3 };
  if (CUT[d]) rows = rows.filter(e => e.mt >= CUT[d]);
  if (s === 'live') rows = rows.filter(e => liveBySid.has(e.sid.slice(0, 8)));
  const max = Math.max(1, Math.ceil(rows.length / PAGE));
  const cur = Math.min(max, Math.max(1, +(url.searchParams.get('page') || 1) || 1));
  const slice = rows.slice((cur - 1) * PAGE, cur * PAGE);
  const titles = await Promise.all(slice.map(titleOf));
  const P = { acct, q, d, s };
  const back = url.pathname + url.search;

  // .sel is the neutral "this is the selected filter" pill (mirrors .pnav a.on); .on
  // stays reserved for the genuinely-live "live N" chip below, styled green.
  const chip = (over, label, on, cls = 'sel') => `<a class="chip${on ? ' ' + cls : ''}" href="/history${qs({ ...P, ...over })}">${label}</a>`;
  const chips = [chip({ acct: '' }, `all <b>${index.length}</b>`, !acct)]
    .concat(ACCTS.map(a => chip({ acct: a.id },
      `<span class="dot" style="background:${a.color}"></span>${a.label} <b>${counts[a.id] || 0}</b>`, acct === a.id))).join('');
  const dchips = [['', 'all time'], ['today', 'today'], ['7d', '7 days'], ['30d', '30 days']]
    .map(([v, l]) => chip({ d: v }, l, d === v)).join('')
    + chip({ s: s === 'live' ? '' : 'live' },
      `<span class="dot" style="background:var(--ok)"></span>live <b>${liveBySid.size}</b>`, s === 'live', 'on');

  // no live-fleet panel or system strip here anymore (reskin 2026-08-29): the home
  // page owns those; /history is purely the archive — filter + day-grouped list + pager.
  let lastDay = '', items = '';
  slice.forEach((e, i) => {
    const dl = dayLbl(e.mt);
    if (dl !== lastDay) { items += `<div class="day">${dl}</div>`; lastDay = dl; }
    items += sessionRowHtml(e, titles[i].title, liveBySid, back);
  });

  const label = HOST_ACCT[sub] ? sub : '';
  // filters are power-user controls — folded away by default; auto-open (and
  // summarized) whenever the URL carries one so active state is never hidden
  const fOn = !!(url.searchParams.get('acct') || d || s || q);
  const fState = [acct && BY_ID[acct] ? BY_ID[acct].label : 'all',
    ({ today: 'today', '7d': '7 days', '30d': '30 days' })[d] || 'all time']
    .concat(s === 'live' ? ['live'] : [], q ? ['“' + esc(q) + '”'] : []).join(' · ');
  const body = `<h1><a href="/">mows sessions</a> <span class="muted">· history</span>${label ? ` <span class="muted">· ${esc(label)}</span>` : ''}</h1>
<details class="sys flt"${fOn ? ' open' : ''}><summary><span class="syst">${ICO.search}filter</span><span class="syss">${fState} · <b>${rows.length}</b>${fOn ? ` of ${index.length}` : ''} sessions</span></summary>
<div class="sysbody"><div class="bar">${chips}</div>
<div class="bar">${dchips}
<form action="/history" method="get">${['acct', 'd', 's'].map(k => P[k] ? `<input type="hidden" name="${k}" value="${esc(P[k])}">` : '').join('')}
<div class="fsw"><span class="fico" aria-hidden="true">${ICO.search}</span><input type="search" name="q" value="${esc(q)}" placeholder="filter path / id…" aria-label="Filter by project path or session id"></div></form></div></div></details>
${items ? `<div class="hlist">${items}</div>` : '<p class="muted" style="padding:20px 0">no sessions match.</p>'}
${pager('/history', P, cur, max, `<span class="pgtot">${rows.length} total</span>`)}`;
  send(req, res, 200, page('history · mows sessions', body, '', '', 'history', true, live.length, req.headers.host));
}

async function detailView(req, res, a, sid) {
  freshen();
  const e = index.find(x => x.a === a && x.sid === sid);
  if (!e) return send(req, res, 404, page('not found', '<p>session not found. <a href="/">← back</a></p>'));
  let s;
  try { s = await loadSession(e); }
  catch (err) { return send(req, res, 500, page('error', `<p>could not read transcript: ${esc(err.message)}</p>`)); }
  const acct = BY_ID[a], sid8 = sid.slice(0, 8);
  const url = new URL(req.url, 'http://x');
  const n = s.msgs.length, max = Math.max(1, Math.ceil(n / MSG_PAGE));
  const cur = Math.min(max, Math.max(1, +(url.searchParams.get('page') || 1) || 1));
  // page 1 = newest slice; render chronologically within the page
  const end = n - (cur - 1) * MSG_PAGE, start = Math.max(0, end - MSG_PAGE);
  const lv = (await tmuxLive()).find(l => liveSid8(l) === sid8);
  const live = !!lv;

  const msgs = s.msgs.slice(start, end).map(m => {
    if (m.role === 'tool') return `<details><summary>${ICO.wrench} ${esc(m.name)}</summary><pre>${esc(m.text)}</pre></details>`;
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
      ? `<div class="la" style="justify-content:flex-start"><a class="btn" data-nw="t-${sid8}" href="${esc(live ? termHref('attach', lv.name) : termHref('open', sid8))}">&gt;_ ${live ? (lv.paused ? 'attach — paused' : 'attach — live now') : 'open in terminal'}</a>${lv ? actForms(lv, `/s/${a}/${sid}`) : ''}</div>`
      : `<p class="muted" style="margin:8px 0">resume disabled — idle ${rel(e.mt)} (cutoff ${RESUME_DAYS}d). transcript stays readable; resume manually with <span style="font-family:var(--mono)">cc -r</span> if you really need it.</p>`)
    : '';
  const pgr = pager(`/s/${a}/${sid}`, {}, cur, max,
    `<span class="pgtot">${n} items · newest first</span>`);
  const body = `<h1><a href="/">← sessions</a></h1>
<div class="meta">
<div>session</div><div>${esc(sid)} ${live ? '<span class="lvb"><span class="lvbd" aria-hidden="true"></span>LIVE</span>' : ''}</div>
<div>account</div><div style="color:${acct.color}">${acct.label}</div>
<div>project</div><div>${esc(s.meta.cwd || projName(e.proj))}</div>
<div>started</div><div>${abs(s.meta.firstTs)}</div>
<div>last</div><div>${abs(e.mt)} (${rel(e.mt)} ago)</div>
<div>size</div><div>${fmtSz(e.sz)} · ${n} items · ${s.meta.tools} tool calls${s.meta.model ? ' · ' + esc(s.meta.model) : ''}</div>
</div>
${term}
${s.truncated ? '<div class="note">large transcript — showing the most recent 8MB window.</div>' : ''}
${pgr}${msgs || '<p class="muted">no displayable messages.</p>'}${pgr}`;
  send(req, res, 200, page(`${sid8} · ${projName(e.proj)}`, body, '', 'sessions', '', false, null, req.headers.host));
}

// ---------- server ----------
const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, 'http://x');
    const p = url.pathname;
    if (p === '/healthz') return send(req, res, 200,
      JSON.stringify({ ok: true, sessions: index.length, scannedAgo: Math.round((Date.now() - lastScan) / 1000), sseClients }), 'application/json');
    if (p === '/events') return await eventsView(req, res);
    if (p === '/fleet.js') {
      const buf = Buffer.from(FLEET_JS);
      const etag = '"' + crc32(buf).toString(16) + '"';
      if (req.headers['if-none-match'] === etag) { res.writeHead(304, { etag }); return res.end(); }
      res.writeHead(200, { 'content-type': 'text/javascript; charset=utf-8', 'cache-control': 'public, max-age=300', etag });
      return res.end(buf);
    }
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
    if (p === '/app') return await appView(req, res, url);
    if (p === '/app/live.json') return await liveJson(req, res, url);
    if (p === '/device') return await deviceView(req, res);
    if (p === '/md') return await mdView(req, res, url);
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
    if (p === '/sw.js') return send(req, res, 200, SW, 'text/javascript; charset=utf-8');
    const isz = { '/icon-192.png': 192, '/icon-512.png': 512, '/apple-touch-icon.png': 180,
                  '/favicon.png': 48, '/favicon.ico': 48 }[p];
    if (isz) {
      const a = hostAcct(req);
      const buf = iconPNG(isz, (a && a.color) || '#00d492');
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
setInterval(freshen, 30000).unref();
server.listen(PORT, HOST, () => console.log(`lite dashboard on http://${HOST}:${PORT} — ${index.length} sessions`));
