import { promises as fsp, readFileSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { createHmac, timingSafeEqual } from 'node:crypto';
import { wireChatStream } from '../chat-stream.mjs';
import { RUN_PATH, TMUX_HOME, TMUX_USER, readBody, runAs, sameOrigin, sh, shOk } from '../core.mjs';
import { chatBroadcast, chatEnd } from '../sse.mjs';


// ---------- /agents: Layer 6 purpose-scoped agents (spec 2026-09-15 §8) ----------
// Data = the run records mows-agent writes; rescanned per request behind a 3s cache, NEVER
// at startup (discoverAccounts() is startup-only and the spec calls that staleness out).
export const AGENTS_STATE = TMUX_HOME + '/.local/state/mows-agents';

// Mirrors agents/bin/mows-agent-meta's AGENT_NAME_RE exactly — the name doubles as a systemd
// instance name, a unit filename, a config key (WEBHOOK_SECRET_<NAME>) and this URL path
// segment. Widening either pattern without the other breaks injectivity of the config-key
// mapping (webhookView below computes it as name.upper().replace('-','_')): admitting
// underscores would make "a-b" and "a_b" collide on WEBHOOK_SECRET_A_B, letting one agent's
// webhook secret authenticate another agent's webhook. Keep both patterns identical.
export const AGENT_RE = /^[a-z0-9][a-z0-9-]{0,63}$/;

export const RUN_RE = /^\d{8}-\d{6}-\d+$/;

const AGENT_BAD = new Set(['stalled', 'failed', 'budget_exceeded']);

const agentsCache = { t: 0, v: [] };

export async function agentsIndex() {
  if (Date.now() - agentsCache.t < 3000) return agentsCache.v;
  const out = [];
  let names = []; try { names = await fsp.readdir(AGENTS_STATE); } catch {}
  for (const name of names) {
    if (!AGENT_RE.test(name)) continue;
    const dir = `${AGENTS_STATE}/${name}`;
    let runs = []; try { runs = (await fsp.readdir(`${dir}/runs`)).filter(r => RUN_RE.test(r)).sort().reverse(); } catch {}
    const recs = [];
    for (const r of runs.slice(0, 20)) {
      try { recs.push({ ...JSON.parse(await fsp.readFile(`${dir}/runs/${r}/status.json`, 'utf8')), run_id: r }); } catch {}
    }
    const last = recs[0] || null;
    // a `working` record whose runner pid is gone is a crash, not a live run
    if (last && last.state === 'working' && last.pid) { try { process.kill(last.pid, 0); } catch { last.state = 'failed'; last.crashed = true; } }
    const week = Date.now() - 7 * 864e5;
    const cost7d = recs.filter(x => Date.parse(x.started_at) > week).reduce((a, x) => a + (+x.cost_usd || 0), 0);
    let events = []; try { events = readFileSync(`${dir}/events.log`, 'utf8').trim().split('\n').slice(-5); } catch {}
    out.push({ name, last, recs, cost7d, total: runs.length, events });
  }
  const rank = s => s === 'working' ? 0 : AGENT_BAD.has(s) ? 1 : 2;
  out.sort((a, b) => rank(a.last?.state) - rank(b.last?.state)
    || (Date.parse(b.last?.last_event_at || 0) || 0) - (Date.parse(a.last?.last_event_at || 0) || 0));
  agentsCache.t = Date.now(); agentsCache.v = out; return out;
}

// Task 7's render_service (agents/bin/mows-agent cmd_render) emits ONE timer unit per cron
// trigger: the first is the bare `mows-agent-<name>.timer`, the second+ are suffixed
// `-2`, `-3`, ... with NO delimiter before the digits (see its `sfx="-$ci"` logic) — an agent
// can genuinely have several. Pausing/resuming/reporting against only the bare unit (the
// fix's original shape) is wrong for any multi-timer agent: mask would silently leave the
// second timer armed while the page claimed "paused". agentTimers() enumerates every unit
// that belongs to this agent instead of guessing one name.
//
// Known, inherited limitation: because Task 7 uses no delimiter, an agent LITERALLY named
// "<name>-2" is structurally indistinguishable from "<name>"'s second cron timer — that
// ambiguity is in the render script's own naming scheme, not introduced here, and this
// dashboard has no information (short of re-parsing every agent's own trigger count) that
// could resolve it. Fine for the common case; flagged rather than silently swept under.
export async function agentTimers(name) { // -> [{unit, masked, next}], bare unit first then -2, -3, ...
  const esc_re = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const ownRe = new RegExp(`^mows-agent-${esc_re}(-\\d+)?\\.timer$`);
  // `list-unit-files` (unlike `list-timers` or `is-enabled`) reliably reports a MASKED unit's
  // state in its own STATE column and always exits 0 — verified live against this box's own
  // masked ttyd.service (`systemctl list-unit-files 'ttyd*' --no-legend` -> "ttyd.service
  // masked enabled", exit 0). One call gives us both "does this unit exist" and "is it
  // masked" without the exit-code trap `sh()`'s error-swallowing set for the single-timer
  // version of this fix (`is-enabled` exits 1 for the perfectly normal "masked" state).
  const out = await sh('systemctl', ['list-unit-files', `mows-agent-${name}*.timer`, '--no-legend']);
  const units = (out || '').trim().split('\n').filter(Boolean)
    .map(l => l.trim().split(/\s+/))
    .filter(([u]) => ownRe.test(u))
    .map(([u, state]) => ({ unit: u, masked: state === 'masked', next: '' }))
    // bare unit first, then -2, -3, ... by NUMBER — a plain string sort puts "-2.timer" before
    // ".timer" (ASCII '-' < '.'), which put the wrong timer's NEXT first when this was tried
    // live against a real multi-timer fixture; extract the suffix (0 for the bare unit) instead.
    .sort((a, b) => (+(a.unit.match(/-(\d+)\.timer$/)?.[1] || 0)) - (+(b.unit.match(/-(\d+)\.timer$/)?.[1] || 0)));
  for (const t of units) {
    if (t.masked) continue; // masked: no schedule to report, and list-timers may not show it anyway
    const lt = await sh('systemctl', ['list-timers', '--all', '--no-legend', t.unit]);
    const l = (lt || '').trim().split('\n')[0] || '';
    t.next = l ? l.split(/\s+/).slice(0, 4).join(' ') : '';
  }
  return units;
}

// Collapses N timer rows into one honest status. 'mixed' exists specifically so the page
// can never claim a clean paused/active state when the timers disagree (spec ruling,
// review round 1) — showing "N/M paused" instead of picking a side that's half true.
export function summarizeTimers(timers) {
  if (!timers.length) return { state: 'none', label: 'no timer' };
  const pausedN = timers.filter(t => t.masked).length;
  if (pausedN === timers.length) return { state: 'paused', label: timers.length > 1 ? `paused (${timers.length} timers)` : 'paused' };
  if (pausedN === 0) {
    const next = (timers.find(t => t.next) || timers[0]).next || '—';
    return { state: 'active', label: timers.length > 1 ? `${next} (+${timers.length - 1} more)` : next };
  }
  return { state: 'mixed', label: `mixed — ${pausedN}/${timers.length} timers paused` };
}

// Chat transcript for one agent. mows-agent writes it as JSONL, one object per turn, so a
// half-written last line (a turn landing mid-read) drops that line rather than the whole file.
const CHAT_MAX = 40; // newest N turns; the file is append-only and never truncated by the dashboard
export async function agentChat(name) {
  const out = [];
  try {
    const raw = await fsp.readFile(`${AGENTS_STATE}/${name}/chat.jsonl`, 'utf8');
    for (const l of raw.split('\n')) { if (!l.trim()) continue; try { out.push(JSON.parse(l)); } catch {} }
  } catch {}
  return out.slice(-CHAT_MAX);
}

// ---------- an agent's declared policy: its frontmatter, read by the ONE parser ----------
// Shelling out to mows-agent-meta rather than parsing YAML here is the point: that script is the
// validator the CLI already runs (`mows-agent run` refuses a file it lints red), it is the
// authority on what every mows.* field means, and a second parser in this file would be free to
// disagree with it about a file that had already been admitted.
//
// The agent file is looked up across EVERY profile dir, not just ~/.claude/agents: an agent whose
// `mows.profile` is `work` lives under ~/.claude-work/agents, and there is no way to read the
// profile without first finding the file. Same discovery rule as mows-agent's own profiles_json
// (the default .claude plus every .claude-<suffix>), so the dashboard and the runner look in the
// same places.
async function agentFile(name) { // -> absolute path, or null if not found / ambiguous
  let entries = [];
  try { entries = await fsp.readdir(TMUX_HOME); } catch { return null; }
  const dirs = entries.filter(d => d === '.claude' || d.startsWith('.claude-'));
  const hits = [];
  for (const d of dirs) {
    const f = `${TMUX_HOME}/${d}/agents/${name}.md`;
    // Resolve before de-duplicating: ~/.claude-work/agents symlinked to ~/.claude/agents is a
    // legitimate setup and finds the same physical file twice — one agent, not an ambiguity.
    // mows-agent's agent_file() dedupes exactly this way and dies on what is left.
    try { const r = await fsp.realpath(f); if (!hits.includes(r)) hits.push(r); } catch {}
  }
  // Genuinely two files: mows-agent refuses to run such an agent at all, so this page must not
  // pick one and present its policy as the truth. null becomes an honest "unknown" on the panel.
  return hits.length === 1 ? hits[0] : null;
}

export async function agentFrontmatter(name) {
  const f = await agentFile(name);
  if (!f) return null;
  const out = await runAs([], `${TMUX_HOME}/.local/bin/mows-agent-meta`, ['json', f], 10000);
  try { return JSON.parse(out); } catch { return null; } // '' on any error, including a timeout
}

export async function agentAction(req, res, act) {
  if (req.method !== 'POST') { res.writeHead(405); return res.end('POST only'); }
  // same-origin guard, same as every other mutating POST route (see line ~32)
  const host = req.headers.host || '';
  if (!sameOrigin(req, host)) { res.writeHead(403); return res.end('bad origin'); }
  const b = await readBody(req);
  const name = b.name || '';
  const bk = b.back || '/agents';
  const back = bk.startsWith('/') && !bk.startsWith('//') ? bk : '/agents';
  if (!AGENT_RE.test(name)) { res.writeHead(400); return res.end('bad name'); }
  if (act === 'chat') {
    // A chat turn is a resumed `claude -p` and takes tens of seconds, so it must not be
    // awaited inside the request — the dashboard is single-process and would stall every
    // other page. Fire it detached and redirect; mows-agent appends the user's message to
    // chat.jsonl BEFORE calling claude, so the page shows the question immediately and the
    // answer appears on the next load. That trailing user turn is what renders "Thinking…".
    const msg = (b.msg || '').slice(0, 4000).trim();
    if (!msg) { res.writeHead(400); return res.end('empty message'); }
    const child = spawn('runuser', ['-u', TMUX_USER, '--', 'env', 'HOME=' + TMUX_HOME, 'PATH=' + RUN_PATH,
      `${TMUX_HOME}/.local/bin/mows-agent`, 'chat', name, '--stream', msg],
      { detached: true, stdio: ['ignore', 'pipe', 'pipe'] });
    const turn = Date.now();
    // The `end` line, when it arrives, is authoritative (it carries the real is_error); the
    // `close` handler below is only a fallback for a process that died without ever writing
    // one. The FIRST end wins, not the last — a naive "close always calls chatEnd" would let
    // the neutral close-triggered summary (no is_error) overwrite a real failure, discarding
    // it (fix round 1, F8).
    let ended = false;
    const stream = wireChatStream(child.stdout,
      o => chatBroadcast(name, turn, o.seq, o.delta),
      o => { ended = true; chatEnd(name, turn, { cost_usd: o.cost_usd, is_error: o.is_error }); });
    // mows-agent's own operator-visible failure line (`mows-agent: chat turn failed: …`) only
    // reached events.log before this — stdio was ['ignore','pipe','ignore'], so on the one
    // production caller of the streaming path it was discarded outright (fix round 1, F11).
    child.stderr.on('data', d => process.stderr.write(d));
    child.on('close', () => {
      if (!ended) chatEnd(name, turn, { closed: true });
      const drops = stream.drops();
      if (drops) console.error(`chat ${name}:${turn}: dropped ${drops} malformed stream line(s)`);
      agentsCache.t = 0;
    });
    child.unref();
    res.writeHead(303, { location: back }); return res.end();
  }
  if (act === 'run') {
    // Honest failure, not a silent redirect that looks like success: the shared
    // mows-agent@.service unit may never have been installed (SETUP.md's Triggers step is a
    // manual `sudo install`), and `systemctl start` on a missing unit fails immediately.
    if (!(await shOk('systemctl', ['start', '--no-block', `mows-agent@${name}.service`]))) {
      res.writeHead(409); return res.end('could not start mows-agent@' + name + '.service — is the unit installed? see agents/SETUP.md Triggers');
    }
  }
  else if (act === 'pause' || act === 'resume') {
    // every timer belonging to this agent (bare + -2, -3, ...), not just the bare unit —
    // see agentTimers()'s header comment (review round 1: pause/resume ignored suffixed
    // timers, so a 2-schedule agent kept running under a page that claimed it was paused).
    // Fallback to the bare unit name if enumeration finds nothing: mask/unmask on a unit
    // with no on-disk file is a harmless no-op, and it's a safety net if `list-unit-files`
    // ever comes back empty for a unit that genuinely exists.
    const timers = await agentTimers(name);
    const units = timers.length ? timers.map(t => t.unit) : [`mows-agent-${name}.timer`];
    for (const u of units) {
      if (act === 'pause') await sh('systemctl', ['mask', '--now', u]);
      else { await sh('systemctl', ['unmask', u]); await sh('systemctl', ['start', u]); }
    }
  }
  else if (act === 'stop') {
    const a = (await agentsIndex()).find(x => x.name === name);
    // Kill claude's own process group directly (claude_pid is its own group leader, per
    // mows-agent's `setsid`) — SIGTERM to the runner pid does NOT work: mows-agent's `trap
    // … TERM` only runs between commands, and the runner sits foreground in `tail | tail_loop`
    // for the whole run, so the trap never gets scheduled until claude has already exited on
    // its own (verified: after signalling exactly this way, claude was still alive and the
    // record still said "working"). Killing the runner pid too is a harmless, no-op-once-dead
    // secondary signal, not what actually stops the run.
    if (a?.last?.state === 'working' && a.last.claude_pid > 0) { try { process.kill(-a.last.claude_pid, 'SIGTERM'); } catch {} }
    if (a?.last?.state === 'working' && a.last.pid) { try { process.kill(a.last.pid, 'SIGTERM'); } catch {} }
  } else { res.writeHead(404); return res.end(); }
  agentsCache.t = 0;
  res.writeHead(303, { location: back }); res.end();
}


// ---------- /wh/<name>: webhook trigger (spec §6). HMAC is the auth; the body is discarded. ----------
const AGENTS_CFG = TMUX_HOME + '/.config/mows-agents/config';

export function agentsConfig() { // KEY=value lines only; values may be quoted. Read per request: secrets rotate.
  const out = {};
  try { for (const l of readFileSync(AGENTS_CFG, 'utf8').split('\n')) { const m = l.match(/^([A-Z0-9_]+)=(.*)$/); if (m) out[m[1]] = m[2].trim().replace(/^(["'])(.*)\1$/, '$2'); } } catch {}
  return out;
}

// The one place the agent name -> config key mapping is written down. AGENT_RE's header explains
// why that mapping has to stay injective; the capability panel reads the same key to tell the
// operator whether a POST to /wh/<name> can start this agent, and two spellings of it could drift
// into the panel reporting a trigger armed against a key this route never consults.
export const webhookKey = name => 'WEBHOOK_SECRET_' + name.toUpperCase().replace(/-/g, '_');

export async function webhookView(req, res, name) {
  if (req.method !== 'POST') { res.writeHead(405); return res.end(); }
  if (!AGENT_RE.test(name)) { res.writeHead(404); return res.end(); }
  const secret = agentsConfig()[webhookKey(name)];
  if (!secret) { res.writeHead(404); return res.end(); } // same response as a bad name: no agent enumeration
  const chunks = []; let n = 0;
  for await (const c of req) { n += c.length; if (n > 1e6) { res.writeHead(413); return res.end(); } chunks.push(c); }
  const want = Buffer.from('sha256=' + createHmac('sha256', secret).update(Buffer.concat(chunks)).digest('hex'));
  const got = Buffer.from(String(req.headers['x-mows-signature'] || req.headers['x-hub-signature-256'] || ''));
  if (got.length !== want.length || !timingSafeEqual(got, want)) { res.writeHead(401); return res.end('bad signature'); }
  // one in-flight run per agent is enforced by mows-agent itself (refuses with exit 6); the unit's
  // SuccessExitStatus covers that, so a burst of webhooks is safe.
  // A valid signature is not the same thing as a working trigger: the shared unit may never
  // have been installed (SETUP.md's Triggers step is a manual `sudo install`), and answering
  // 202 regardless would tell a caller (GitHub, retrying webhooks) that the run was queued
  // when nothing happened at all.
  if (!(await shOk('systemctl', ['start', '--no-block', `mows-agent@${name}.service`]))) {
    res.writeHead(503, { 'content-type': 'text/plain' }); return res.end('agent unit not installed');
  }
  res.writeHead(202, { 'content-type': 'text/plain' }); res.end('queued');
}
