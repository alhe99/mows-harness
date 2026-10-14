import { claudeVersion, fleetKey, fleetState, hostInfo, usage, verCache } from './core.mjs';
import { agentsIndex } from './routes/agents.mjs';
import { pushAll, subCount } from './routes/webpush.mjs';


// ---------- /events: SSE fleet live-update stream (Fleet Redesign §3) ----------
// shape sent over the wire: [{sid8,name,label,proj,state,rel,snippet,kind,wins,born}] per the spec —
// "rel" carries the raw mt (ms epoch), not a preformatted "3m" string: fleet.js needs the
// epoch to tick the display every 30s on its own, without waiting on the next snapshot
// (which only arrives when something actually changes, not on a fixed clock).
export function fleetEventPayload(fleet) {
  return fleet.map(f => ({ sid8: fleetKey(f), name: f.name, label: f.label || '', proj: f.proj,
                            state: f.state, rel: f.mt, snippet: f.snippet, kind: f.kind, wins: f.wins, born: f.l.created }));
}

// The additive /stream topics (contract.d.ts UsageEvent, SystemEvent): projections of usage() and hostInfo(), nothing new is
// computed. usage() is null until the first background collection lands (nothing is sent until then). The claude version is
// refreshed in the background and read from its cache, so a missing `claude` binary can never delay a tick.
export const usageEvent = () => {
  const u = usage();
  return u && { quota: u.quota, thr: u.thr, accts: Object.fromEntries(Object.entries(u.accts).map(([k, a]) =>
    [k, { id: a.id, label: a.label, today: a.today, week: a.week, month: a.month, block: a.block, tokExp: a.tokExp }])) };
};

let verBusy = false;

function systemEvent() {
  if (!verBusy && Date.now() - verCache.t > 300e3) { verBusy = true; claudeVersion().finally(() => { verBusy = false; }); }
  return { ...hostInfo(), version: verCache.v };
}

// this box already runs hot (spec §3). PER ENDPOINT, not per box: two independent counters, sseClients for /events (the
// server-rendered pages' feed, capped by SSE_MAX) and streamClients.size for /stream (the SPA's, capped by STREAM_MAX_CLIENTS),
// so the 9th /events client or the 17th /stream client gets a 503. That split is ruling D4 and is deliberate: both navigation
// models run at once, and a shared counter would let a few server-rendered tabs lock the SPA out of its own stream.
// /stream was 8 until the cockpit shell (K-17, ARCHITECTURE section 3): one connection per tab, and the shell, an agent tab
// or two and a phone fit in 16; RSS at that count is what e2e-infra's 150 MB ceiling watches. /events stays 8 (K-13).
// scripts/stream-cap-check.mjs reads both constants by name.
const SSE_MAX = 8;

const STREAM_MAX_CLIENTS = 16;

export let sseClients = 0;

export async function eventsView(req, res) {
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

// ---------- /stream: one multiplexed SSE connection per tab (spec §3) ----------
// One connection carries every topic a tab needs. The Layer 6 spec already chose multiplexing
// over a second stream for the same reason: SSE_MAX is small and this box runs hot. A tab now
// costs one connection no matter how many views it shows.
const streamClients = new Set(); // {res, topics:Set, id}
let streamSeq = 0;

// Replay buffer for the IN-FLIGHT turn only, per agent. A completed turn is already in chat.jsonl
// and the client refetches it from /api/agents/<name>/chat, so buffering it twice would be
// memory spent on data we already have.
//
// NOT a ring buffer, which is what this comment used to call it (final review, L1). It is an
// append-only array with no cap and no eviction: `b.deltas.push(...)` below runs once per delta
// and nothing ever trims it. Spec §3's "capped at the turn's own token count" is satisfied, but
// by ARITHMETIC rather than by code -- a chat turn is bounded to $0.25 and six turns by
// mows-agent, so the array cannot grow past what that buys. Calling it a ring is what stops the
// next reader going to look for the cap and finding there isn't one. Two consequences follow from
// the same fact and are worth knowing before anyone raises those budget numbers: the entry lives
// for the life of the process if a turn never produces a chatEnd for its own turn number, and a
// SECOND concurrent turn on one agent resets the buffer (see the turn check below), discarding the
// first turn's replay data -- see "Known and unguarded" in docs/architecture.md.
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

export function chatBroadcast(agent, turn, seq, delta) {
  let b = chatBuf.get(agent);
  if (!b || b.turn !== turn) { b = { turn, deltas: [] }; chatBuf.set(agent, b); }
  b.deltas.push({ seq, text: delta });
  streamSend('chat', { agent, turn, seq, delta }, `chat:${agent}`, `${agent}:${turn}:${seq}`);
}

export function chatEnd(agent, turn, summary) {
  // Only clear the buffer if it's still THIS turn's. Task 6 made a late second chatEnd call
  // for the same turn routine (an authoritative `end` line plus a `close` fallback — see
  // agentAction's chat branch), and an unconditional delete would wipe a NEWER turn's
  // in-flight replay buffer if that second call arrives after the next turn has already
  // started (fix round 1, F8).
  const b = chatBuf.get(agent);
  if (b && b.turn === turn) chatBuf.delete(agent);
  streamSend('chatend', { agent, turn, ...summary }, `chat:${agent}`);
}

export async function streamView(req, res) {
  if (streamClients.size >= STREAM_MAX_CLIENTS) { res.writeHead(503, { 'retry-after': '30' }); return res.end('too many stream clients'); }
  const url = new URL(req.url, 'http://x');
  const topics = new Set((url.searchParams.get('topics') || 'fleet').split(',').map(s => s.trim()).filter(Boolean));
  res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-store', connection: 'keep-alive' });
  // writeHead() only QUEUES the status line/headers — Node doesn't put them on the wire until
  // the first write()/end(). eventsView never needs this: its `last = ''` sentinel never equals
  // the real payload, so its first tick always writes, flushing headers as a side effect. Here
  // a topic set with no eager producer (chat-only, or unknown) writes NOTHING until the 25s
  // heartbeat, so without this call the client gets no response — not even the 200 — for up to
  // 25s. Found live: the chat view's own subscription is chat-only, so this is the common case.
  res.flushHeaders();
  const c = { res, topics, id: ++streamSeq };
  streamClients.add(c);
  let done = false, poll = null, hb = null;
  const cleanup = () => { if (done) return; done = true; clearInterval(poll); clearInterval(hb); streamClients.delete(c); };
  // registered BEFORE the first (slow) tick, for the same reason eventsView does it
  req.on('aborted', cleanup); req.on('close', cleanup); res.on('close', cleanup);

  // Replay: EventSource resends Last-Event-ID on reconnect. Replay only the in-flight turn.
  // a client that opened a NEW EventSource (reconnect after CLOSED, or after a long hidden spell) cannot set the header, so
  // web/store.mjs sends the same value as ?lastEventId=; replay is gated on the topic check below either way
  const last = req.headers['last-event-id'] || url.searchParams.get('lastEventId');
  if (last) {
    const [agent, turnS, seqS] = String(last).split(':');
    // Gate replay on the SAME topic check the live path uses. streamSend() enforces this for
    // broadcasts, but replay calls streamWrite() directly and so inherits nothing — a client
    // could name any agent in Last-Event-ID and read its in-flight turn without subscribing.
    if (agent && topics.has(`chat:${agent}`)) {
      const b = chatBuf.get(agent);
      if (b && String(b.turn) === turnS) {
        for (const d of b.deltas) if (d.seq > Number(seqS)) {
          streamWrite(c, 'chat', { agent, turn: b.turn, seq: d.seq, delta: d.text }, `${agent}:${b.turn}:${d.seq}`);
        }
      }
    }
  }

  let lastFleet = '', lastAgents = '';
  const sent = {};
  const push = (ev, data) => { // usage and system: sent when they change, never as an empty first event
    const pl = data == null ? null : JSON.stringify(data);
    if (pl != null && pl !== sent[ev]) { sent[ev] = pl; streamWrite(c, ev, data); }
  };
  const tick = async () => {
    if (done) return;
    try {
      if (topics.has('system')) push('system', systemEvent()); // synchronous, so it goes out ahead of the slower fleet scan
      if (topics.has('usage')) push('usage', usageEvent());
      if (topics.has('fleet')) {
        const pl = JSON.stringify(fleetEventPayload(await fleetState()));
        if (pl !== lastFleet) { lastFleet = pl; streamWrite(c, 'fleet', JSON.parse(pl)); }
      }
      if (topics.has('agents')) {
        const list = await agentsIndex();
        const pl = JSON.stringify(list.map(a => ({ name: a.name, state: a.last?.state ?? null, last_event_at: a.last?.last_event_at ?? null, total: a.total, cost7d: a.cost7d })));
        if (pl !== lastAgents) { lastAgents = pl; streamWrite(c, 'agents', JSON.parse(pl)); }
      }
    } catch { /* one bad tick must not kill the stream */ }
  };
  await tick();
  if (done) return;
  poll = setInterval(tick, 2000);
  hb = setInterval(() => { try { res.write(': hb\n\n'); } catch {} }, 25000);
}

// ---------- push on needs-you (K-37) ----------
// The one sender: it watches the fleet itself, not through a client's stream, because the app being closed is the case a push is for. Nothing is scanned
// while no one is subscribed. A session already waiting when a subscription appears (or the server starts) does not ring; a transition into
// `needs-you` does, once per session per 30 s, and the payload carries the number now waiting as the app badge.
const PUSH_POLL = 5000, PUSH_DEBOUNCE = 30000;

export function startPushWatch() {
  let prev = null, busy = false;
  const sentAt = new Map();
  setInterval(async () => {
    if (busy) return;
    busy = true;
    try {
      if (!(await subCount())) { prev = null; return; }
      const fleet = await fleetState(), now = Date.now(), waiting = fleet.filter(f => f.state === 'needs-you');
      for (const [k, t] of sentAt) if (now - t > PUSH_DEBOUNCE) sentAt.delete(k);
      for (const f of waiting) {
        const k = fleetKey(f);
        if (!prev || prev.get(k) === 'needs-you' || sentAt.has(k)) continue;
        sentAt.set(k, now);
        await pushAll({ web_push: 8030, notification: { title: `${f.label || f.name} needs you`, body: String(f.snippet || f.proj || '').slice(0, 140), navigate: '/', tag: k }, app_badge: waiting.length });
      }
      prev = new Map(fleet.map(f => [fleetKey(f), f.state]));
    } catch { /* the next poll tries again */ } finally { busy = false; }
  }, PUSH_POLL).unref();
}
