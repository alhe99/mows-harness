import { promises as fsp, readdirSync, existsSync, readFileSync, statfsSync } from 'node:fs';
import { execFile } from 'node:child_process';
import { gzipSync } from 'node:zlib';
import path from 'node:path';
import os from 'node:os';
import { randomBytes } from 'node:crypto';


// ---------- same-origin guard for mutating POST routes (action/delSession/watchAction) ----------
export function sameOrigin(req, host) {           // exact host match; substring checks are bypassable
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

export const ACCTS = discoverAccounts();

export const BY_ID = Object.fromEntries(ACCTS.map(a => [a.id, a]));

// subdomain -> default account filter (legacy per-account hosts): each login's
// BASE (non-suffixed) profile, keyed by its short label — derived from ACCTS,
// not listed literally.
export const HOST_ACCT = Object.fromEntries(ACCTS.filter(a => a.id === a.user).map(a => [a.label, a.id]));

// the one tmux server this dashboard drives (see scanLogin above): only its
// account(s) get the "resume in terminal" / pause / kill / attach affordances.
export const TMUX_USER = (ACCTS.find(a => a.term) || {}).user || os.userInfo().username;

const TERM_IDS = new Set(ACCTS.filter(a => a.term).map(a => a.id));

// dynamic alternation for the /s/<id>/<sid> route — was a literal id list
const ACCT_ID_ALT = ACCTS.map(a => a.id.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|');

export const SESSION_PATH_RE = new RegExp(`^/s/(${ACCT_ID_ALT})/([0-9a-f-]{8,64})$`);

export const PAGE = 20, MSG_PAGE = 25;

export const args = process.argv.slice(2);

export const flag = (n, d) => { const i = args.indexOf(n); return i >= 0 ? args[i + 1] : d; };

export const PORT = +flag('--port', 3005), HOST = flag('--host', '127.0.0.1');

// >_ resume affordance only for sessions active in the last N days (live tmux
// sessions always keep attach). Old transcripts stay browsable — just not
// one-tap resumable, so a stale context can't be retaken by accident.
export const RESUME_DAYS = +flag('--resume-days', 7);

export const canResume = (mt, live) => live || Date.now() - mt < RESUME_DAYS * 864e5;

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

export const THEME_MAP = loadThemeMap();


export async function readSettings() {
  try {
    const raw = await fsp.readFile(SETTINGS_FILE, 'utf8');
    const data = JSON.parse(raw);
    return data && typeof data === 'object' ? data : {};
  } catch {
    return {};
  }
}

export async function saveSettings(patch) {
  const cur = await readSettings();
  const next = { ...cur, ...patch };
  await fsp.mkdir(path.dirname(SETTINGS_FILE), { recursive: true }).catch(() => {});
  await fsp.writeFile(SETTINGS_FILE, JSON.stringify(next, null, 2) + '\n');
  return next;
}


// ---------- session index (in-memory, rebuilt in background) ----------
export let index = [];
            // [{a, sid, path, mt, sz, proj}] sorted by mt desc
export let counts = {};
           // account id -> n
export let lastScan = 0, scanning = null;


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

export async function scan() {
  const per = await Promise.all(ACCTS.map(scanAcct));
  const all = per.flat().sort((x, y) => y.mt - x.mt);
  counts = {}; for (const a of ACCTS) counts[a.id] = 0;
  for (const e of all) counts[e.a]++;
  index = all; lastScan = Date.now();
}

// a transcript deleted by /a/del: out of the index, the counts and both caches at once
export function forgetSession(e) {
  index = index.filter(x => x !== e);
  counts[e.a] = Math.max(0, (counts[e.a] || 1) - 1);
  titleCache.delete(e.path); parseCache.delete(e.path);
}
export function freshen() { // serve stale, refresh in background
  if (Date.now() - lastScan > 15000 && !scanning)
    scanning = scan().catch(() => {}).finally(() => { scanning = null; });
}


// ---------- per-session title probe (first 64KB, cached by mtime) ----------
const titleCache = new Map(); // path -> {mt, title, ts}
export async function titleOf(e) {
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
export let tmuxCache = { t: 0, list: [] };

let tmuxInflight = null; // in-flight dedup: /events runs up to SSE_MAX concurrent
// clients each on their own 2s setInterval, so a cache-miss moment is hit by several
// callers within a few ms of each other — share ONE recompute (same pattern as
// `scanning` above) instead of each firing its own runuser+tmux exec chain.
// 5s: the runuser+PAM+tmux chain can exceed 2s cold on this 2-core box right
// after a restart (seen 2026-07-07 under the sandbox rollout) — a timeout here
// silently blanks the live panel for 3s (cache), so keep headroom.
export const sh = (cmd, args) => new Promise(r => execFile(cmd, args, { timeout: 5000 }, (e, out) => r(e ? '' : out)));

// sh() collapses "errored" and "succeeded with empty stdout" to the same '' — fine for the
// read-only callers above, but a caller that needs to know whether the command actually
// worked (e.g. `systemctl start` on a unit that was never installed) needs the real result.
export const shOk = (cmd, args) => new Promise(r => execFile(cmd, args, { timeout: 5000 }, e => r(!e)));

export async function tmuxLive() {
  if (Date.now() - tmuxCache.t < 3000) return tmuxCache.list;
  if (tmuxInflight) return tmuxInflight;
  tmuxInflight = tmuxLiveCompute().finally(() => { tmuxInflight = null; });
  return tmuxInflight;
}

async function tmuxLiveCompute() {
  const out = await sh(...userCmd(['tmux', 'list-panes', '-a', '-F',
    '#{session_name}\t#{?session_attached,1,0}\t#{session_created}\t#{session_activity}\t#{pane_pid}\t#{pane_current_path}\t#{pane_id}\t#{@sid}\t#{@label}']));
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
export function classifyFleet({ paused, tail = '', mt = 0 }) {
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
export async function fleetState() {
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
      ? await sh(...userCmd(['tmux', 'capture-pane', '-p', '-S', '-12', '-t', l.paneId]))
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
export const NAME_RE = /^[\w.:@-]{1,64}$/;

// which transcript a live session is: web-term.sh stamps @sid on the sessions it starts
// (2026-08-25; names are cc-<profile>-<dir> now, shared with the cc CLI). Sessions from
// before that are still named web-<sid8> — keep reading those until they are gone.
export const liveSid8 = l => (l.sid || (l.name.startsWith('web-') ? l.name.slice(4) : '')).slice(0, 8);

export async function descendants(root) {
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

export async function readBody(req) {
  let s = '';
  for await (const c of req) { s += c; if (s.length > 4096) break; }
  return Object.fromEntries(new URLSearchParams(s));
}


// ---------- system + usage panel (host metrics, claude limits, spend) ----------
// One-step visibility of the box the harness runs on. Host numbers are sync reads
// (/proc, statfs) cached 5s; usage numbers shell out (claude-quota, ccusage per
// account) so they're collected in the background and cached
// 5 min — a page load NEVER waits on them (first load shows "collecting…").
// Optional dependencies, each degrading gracefully when absent: claude-quota
// (agy layer) -> limits render "?", ccusage (`sudo npm i -g ccusage`) -> spend
// cards say so.
export const GB = n => (n / 1073741824).toFixed(1);

let hostCache = { t: 0, h: null };

export function hostInfo() {
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

// TMUX_USER's tmux server: wrap in runuser unless we already are that user (non-root dev box)
export const userCmd = argv => os.userInfo().username === TMUX_USER ? [argv[0], argv.slice(1)] : ['runuser', ['-u', TMUX_USER, '--', ...argv]];

export const TMUX_HOME = `/home/${TMUX_USER}`;

export const RUN_PATH = `${TMUX_HOME}/.local/bin:/usr/local/bin:/usr/bin:/bin`;

export const runAs = (envs, cmd, args, t = 30000) => new Promise(r =>
  execFile(...userCmd(['env', 'HOME=' + TMUX_HOME, 'PATH=' + RUN_PATH, ...envs, cmd, ...args]),
    { timeout: t, maxBuffer: 32e6 }, (e, out) => r(e ? '' : out)));

// runAs swallows the exit code (needed by callers that only want stdout-or-empty); /a/switch
// needs the real code to tell "tab not attached" (2) from "unknown session" (3) apart.
export const runAsCode = (envs, cmd, args, t = 30000) => new Promise(r =>
  execFile(...userCmd(['env', 'HOME=' + TMUX_HOME, 'PATH=' + RUN_PATH, ...envs, cmd, ...args]),
    { timeout: t, maxBuffer: 32e6 }, (e) => r(e ? (typeof e.code === 'number' ? e.code : 1) : 0)));

// terminal-shell page (§1/§2 of the persistent-terminal-shell design): all switching logic
// lives in this one script, called the same way every other tmux-mutating action is.
export const WEBTERM_SH = process.env.WEBTERM_SH || '/opt/claude-dashboard/web-term.sh';

const jp = s => { try { return JSON.parse(s); } catch { return null; } };

export const mshort = m => String(m).replace(/^claude-/, '');

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
  return { quota, thr, accts };
}

export let usageCache = { t: 0, d: null, busy: false, p: null };

export function usage(force) {
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
export let verCache = { t: 0, v: null };

export async function claudeVersion() {
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
export const HB = n => n >= 1073741824 ? (n / 1073741824).toFixed(1) + ' G'
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
// after /sys/reclaim: the disk meter and the docker sizes must be re-read, not served from their 5-10 s caches
export function resetDiskCaches() { hostCache = { t: 0, h: null }; dfCache = { t: 0, d: null }; }

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

export const RT = [
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

export async function reclaimScan() { // ~1-2 s of du, so only ever on the explicit preview request
  return Promise.all(RT.map(async t => {
    let v = 0; try { v = await t.size(); } catch { /* tool absent -> 0 */ }
    const o = typeof v === 'number' ? { b: v, extra: '' } : v;
    return { ...t, b: o.b || 0, extra: o.extra };
  }));
}


// ---------- transcript parse (LRU 3 files; >25MB -> tail 8MB window) ----------
const parseCache = new Map(); // path -> {mt, sz, msgs, meta}
export const BIG = 25 * 1048576, WINDOW = 8 * 1048576;

function pushText(msgs, role, ts, text) {
  if (text && text.trim()) msgs.push({ role, ts, text: text.slice(0, 30000) });
}

export async function loadSession(e) {
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

export const projName = (raw) => { // "-home-demo-Documents-Projects-fun-backend" -> "fun/backend"
  const parts = raw.replace(/^-/, '').split('-').filter(Boolean);
  return parts.length <= 2 ? parts.join('/') : parts.slice(-2).join('/');
};

// The directives that cost NOTHING on a page full of inline styles and inline scripts, applied to
// every HTML response this server makes (Task 9 review, F7).
//
// uiCsp below is the strict policy, and it is scoped to /ui because the server-rendered pages carry
// dozens of inline style="" attributes and several inline <script> blocks, and CSP3 ignores
// 'unsafe-inline' the moment a nonce is present — so a script-src/style-src there would break those
// pages rather than harden them. That argument covers script-src and style-src. It does NOT cover
// these four, which say nothing about inline anything:
//
//   base-uri 'none'        an injected <base> re-points every relative URL on the page
//   object-src 'none'      <object>/<embed>, which nothing here uses
//   form-action 'self'     every form on these pages posts to /a/… or /droid/…, all same-origin
//   frame-ancestors 'self' clickjacking. /app is the persistent terminal launcher, which is the
//                          page on this site where that is actually interesting. 'self' and not
//                          'none': the dashboard embeds /vnc/ and the device stream in iframes, and
//                          while no dashboard PAGE is framed today, matching Caddy's own site-wide
//                          posture cannot break a same-origin embed if one appears.
//
// Deliberately absent: frame-src, which WOULD break those iframes, and img-src, which would break
// the account avatars and the device stage.
export const BASE_CSP = "base-uri 'none'; object-src 'none'; form-action 'self'; frame-ancestors 'self'";

export function send(req, res, status, html, type = 'text/html; charset=utf-8', extra = null) {
  const buf = Buffer.from(html);
  const h = { 'content-type': type, 'cache-control': 'no-cache' };
  // HTML only: a CSP on the /healthz JSON would be noise. `extra` is applied last so /ui's strict
  // policy REPLACES this baseline rather than being appended to it — two Content-Security-Policy
  // headers are enforced as an intersection, and an intersection is far harder to reason about
  // than one policy that says everything.
  if (/^text\/html/.test(type)) h['content-security-policy'] = BASE_CSP;
  Object.assign(h, extra || {});
  if (buf.length > 1024 && /gzip/.test(req.headers['accept-encoding'] || '')) {
    const gz = gzipSync(buf); h['content-encoding'] = 'gzip'; h['content-length'] = gz.length;
    res.writeHead(status, h); res.end(gz);
  } else { h['content-length'] = buf.length; res.writeHead(status, h); res.end(buf); }
}

export const qs = o => { const p = new URLSearchParams();
  for (const [k, v] of Object.entries(o)) if (v) p.set(k, v);
  const s = p.toString(); return s ? '?' + s : ''; };


// ---------- /app: entry point of the persistent terminal (spec 2026-08-25, execution v2) ----------
// v1 wrapped /term in an iframe. On iOS that broke every keyboard / safe-area trick in
// infra/webconsole/blocks (they assume the terminal is the top-level document): keyboard over
// the input line, lag on every key. Now /term IS the shell — blocks/35-ccsess.html draws the
// session row and the ≡ drawer inside the terminal page — and /app only mints the tabid (the
// key web-term.sh uses to find this browser tab's tmux client) and redirects.
const tabid = () => randomBytes(4).toString('hex');

export const termHref = (kind, name) => `/term/?arg=${kind}&arg=${encodeURIComponent(name)}&arg=${tabid()}&v=3`;


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

export const crc32 = b => { let c = -1;
  for (let i = 0; i < b.length; i++) c = crcT[(c ^ b[i]) & 255] ^ (c >>> 8);
  return (c ^ -1) >>> 0; };

// stable per-item identity for data-sid: sid8 when the live session joined a transcript,
// else the tmux name (fleetState() can return sid8:'' for a pane with no transcript match
// yet) — either way unique across the fleet and unchanging for the session's lifetime.
export const fleetKey = f => f.sid8 || f.name;


// ---------- /api/*: JSON for the SPA (spec §1) ----------
// These are the existing view functions with the HTML rendering removed — deliberately not new
// logic, so the server-rendered pages and the app cannot disagree about what is true.
export function sendJson(req, res, status, obj) {
  send(req, res, status, JSON.stringify(obj), 'application/json; charset=utf-8');
}

// ---------- Content-Security-Policy for /ui ----------
//
// SCOPED TO /ui DELIBERATELY, and this is the whole reason it is cheap. The server-rendered pages
// at / carry dozens of inline style="" attributes and several inline <script> blocks written over
// many months; policing them would mean either 'unsafe-inline' (which buys nothing) or hashing
// every one, and CSP3 ignores 'unsafe-inline' the moment a nonce is present, so a half-measure
// there would BREAK those pages rather than harden them. The SPA is the surface that renders
// agent replies — the stored-XSS path this branch actually shipped and fixed — and it was
// measured to contain no inline style attribute at all (`grep -rn 'style=' infra/dashboard/app/`
// is empty), so it takes a strict policy with no exceptions: ONE nonce, minted per response and
// named by both script-src and style-src (not two independent values — an attacker who can read
// one out of the markup can read the other, so separate values would buy nothing).
//
// What each directive is holding up, so nobody loosens one without knowing what they are paying:
//   default-src 'none'   nothing loads unless a directive below says so; that is what makes the
//                        absence of a directive a refusal rather than a silence.
//   script-src           'self' for the hashed module assets, plus the nonce for the ONE inline
//                        script: the import map. There is no 'unsafe-inline' and no
//                        'unsafe-eval', so an injected <script> or an onerror= attribute does not
//                        run even if the escaping in views/chat.mjs is defeated again. That is
//                        the defence-in-depth this branch was missing when the C1 XSS shipped.
//   style-src            the nonce only, for the one inline <style>. The view's --kb keyboard
//                        handler sets a custom property through CSSOM (element.style.setProperty),
//                        which CSP does not govern, so it is unaffected — verified in both
//                        engines, not assumed.
//   img-src              'self' data: https: — markdown replies legitimately carry images, and
//                        safeHref already restricts their scheme to http/https/mailto.
//   connect-src 'self'   the EventSource on /stream and every fetch to /api and /a/*.
//   base-uri 'none'      an injected <base> would re-point every relative import in the map at an
//                        attacker's origin; nothing on this page needs one.
//   frame-ancestors      the dashboard is never framed, and this is the clickjacking answer that
//                        does not need a second header.
//
// The nonce is minted per RESPONSE, not per process: a constant nonce is worth roughly nothing,
// since an attacker who can inject markup can also copy it out of the page. send() sets
// cache-control: no-cache, so a stored copy is revalidated rather than replayed with a stale one.
// frames: the /next shell's Device view embeds the same-origin /droidview/ and /vnc/ streams, which `default-src 'none'` would refuse; /ui has none
export const uiCsp = (nonce, styleSelf = '', frames = false) => [
  "default-src 'none'",
  `script-src 'self' 'nonce-${nonce}'`,
  `style-src ${styleSelf}'nonce-${nonce}'`, // the /next shell adds 'self' for its linked stylesheet; /ui inlines its CSS
  "img-src 'self' data: https:",
  "font-src 'self'",
  "connect-src 'self'",
  "manifest-src 'self'",
  "base-uri 'none'",
  "form-action 'self'",
  "frame-ancestors 'none'",
  "object-src 'none'",
  ...(frames ? ["frame-src 'self'"] : []),
].join('; ');
