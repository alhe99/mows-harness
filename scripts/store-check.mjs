#!/usr/bin/env node
// store-check.mjs — web/store.mjs against a fake EventSource, fetch, document and timers (K-14, K-17, K-34). Exit code is the verdict.
//   node scripts/store-check.mjs
// Every case builds its own store and world, so one failing case cannot hide another.
import { createStore } from '../web/store.mjs';

let bad = 0;
const check = (name, ok, detail) => { if (!ok) bad++; console.log(`${ok ? 'PASS' : 'FAIL'}: ${name}${ok || detail === undefined ? '' : ' ' + JSON.stringify(detail)}`); };

// a world: one EventSource class that records every instance, a manual clock, a recording fetch and a document that can hide
function world({ chatReply = { turns: [] }, rand = 0.5 } = {}) {
  const w = { instances: [], fetched: [], now: 0, timers: [], hidden: false, listeners: [], atConstruct: [] };
  class ES {
    constructor(url) { this.url = url; this.readyState = 0; this.l = {}; w.instances.push(this); w.atConstruct.push(w.seed?.()); }
    addEventListener(t, f) { (this.l[t] ||= []).push(f); }
    close() { this.readyState = 2; this.closed = true; }
    emit(t, data, lastEventId = '') { for (const f of this.l[t] || []) f({ data: typeof data === 'string' ? data : JSON.stringify(data), lastEventId }); }
    open() { this.readyState = 1; this.emit('open', ''); }
    fail(state) { this.readyState = state; this.emit('error', ''); }
  }
  w.env = {
    EventSource: ES,
    fetch: url => { w.fetched.push(url); return Promise.resolve({ json: () => Promise.resolve(chatReply) }); },
    setTimeout: (f, ms) => { const t = { f, at: w.now + ms, ms }; w.timers.push(t); return t; },
    clearTimeout: t => { if (t) w.timers = w.timers.filter(x => x !== t); },
    document: { get visibilityState() { return w.hidden ? 'hidden' : 'visible'; },
      addEventListener: (t, f) => { w.listeners.push(f); }, removeEventListener: (t, f) => { w.listeners = w.listeners.filter(x => x !== f); } },
  };
  Math.random = () => rand;
  w.advance = ms => { w.now += ms; for (const t of w.timers.filter(t => t.at <= w.now).sort((a, b) => a.at - b.at)) { w.timers = w.timers.filter(x => x !== t); t.f(); } };
  w.setHidden = h => { w.hidden = h; for (const f of w.listeners) f(); };
  w.live = () => w.instances.filter(i => !i.closed && i.readyState !== 2);
  return w;
}
const flush = () => new Promise(r => setTimeout(r, 0));
const boot = { route: '/', fleet: [{ sid8: 'aaaa1111', name: 'a', label: '', proj: 'p', state: 'working', rel: 1, snippet: '' }], live: 1, indexed: 5, host: 'h',
  agents: [{ name: 'ag', state: 'done', last_event_at: null, total: 1, cost7d: 0 }],
  system: { load: 1, cores: 2, memUsed: 1, memTot: 2, swapUsed: 0, swapTot: 0, dskUsed: 1, dskTot: 2, up: 9, version: null, usage: { quota: {}, thr: 70, accts: {} } } };

{ // boot snapshot, one stream, topics
  const w = world(); const s = createStore(w.env);
  w.seed = () => ({ fleet: s.fleet.value.length, agents: s.agents.value.length, system: !!s.system.value, usage: !!s.usage.value });
  s.start(boot);
  check('the boot snapshot seeds fleet, agents, system and usage before the EventSource exists',
    JSON.stringify(w.atConstruct[0]) === '{"fleet":1,"agents":1,"system":true,"usage":true}', w.atConstruct[0]);
  check('exactly one EventSource, on /stream with the four default topics', w.instances.length === 1 && w.instances[0].url === '/stream?topics=fleet,agents,usage,system', w.instances.map(i => i.url));
  check('the seeded system signal carries no usage key (it has its own signal)', !('usage' in s.system.value));
}
{ // every StreamEvent reaches its signal
  const w = world(); const s = createStore(w.env); s.start(boot); const es = w.instances[0]; es.open();
  es.emit('fleet', [{ sid8: 'bbbb2222' }]); es.emit('agents', [{ name: 'x' }]); es.emit('usage', { thr: 1 }); es.emit('system', { load: 7 });
  es.emit('chat', { agent: 'ag', turn: 2, seq: 1, delta: 'hi' }, 'ag:2:1'); es.emit('chatend', { agent: 'ag', turn: 2 });
  check('fleet, agents, usage, system, chat and chatend each update their own signal',
    s.fleet.value[0].sid8 === 'bbbb2222' && s.agents.value[0].name === 'x' && s.usage.value.thr === 1 && s.system.value.load === 7
    && s.chat.value.delta === 'hi' && s.chatend.value.turn === 2);
  check('busy follows chat -> chatend', (() => { es.emit('chat', { agent: 'ag', turn: 3, seq: 1, delta: 'a' }, 'ag:3:1'); const on = s.busy.value.ag === 3; es.emit('chatend', { agent: 'ag', turn: 3 }); return on && !('ag' in s.busy.value); })());
}
{ // reconnect on error + CLOSED, jittered backoff 1 s -> 30 s, reset on open
  const w = world({ rand: 0.5 }); const s = createStore(w.env); s.start(boot);
  w.instances[0].fail(0); // CONNECTING: the browser retries by itself, the store must not
  w.advance(60000);
  check('error with readyState CONNECTING is left to the browser (no second EventSource)', w.instances.length === 1);
  const waits = [];
  for (let i = 0; i < 8; i++) { const es = w.instances.at(-1); es.fail(2); waits.push(w.timers.at(-1).ms); w.advance(w.timers.at(-1).ms); }
  check('CLOSED reopens after 1 s doubling to a 30 s ceiling (jitter 0.8-1.2x)', waits.join() === '1000,2000,4000,8000,16000,30000,30000,30000', waits);
  check('never more than one live EventSource while retrying', w.live().length === 1 && w.instances.length === 9);
  w.instances.at(-1).open();
  w.instances.at(-1).fail(2);
  check('a successful open resets the backoff to 1 s', w.timers.at(-1).ms === 1000, w.timers.at(-1).ms);
  const lo = world({ rand: 0 }); createStore(lo.env).start(boot); lo.instances[0].fail(2);
  const hi = world({ rand: 0.999 }); createStore(hi.env).start(boot); hi.instances[0].fail(2);
  check('jitter stays within 0.8x-1.2x of the step', lo.timers[0].ms === 800 && hi.timers[0].ms > 1190 && hi.timers[0].ms <= 1200, [lo.timers[0].ms, hi.timers[0].ms]);
}
{ // hidden for 60 s closes, visible reopens
  const w = world(); const s = createStore(w.env); s.start(boot); w.instances[0].open();
  w.setHidden(true); w.advance(59999);
  const early = w.instances[0].closed;
  w.advance(1);
  check('hidden for 59.999 s keeps the stream, 60 s closes it', !early && w.instances[0].closed === true);
  w.setHidden(false);
  check('visible again reopens exactly one new stream', w.instances.length === 2 && w.live().length === 1);
  const w2 = world(); createStore(w2.env).start(boot); w2.instances[0].open();
  w2.setHidden(true); w2.advance(30000); w2.setHidden(false); w2.advance(120000);
  check('visible before 60 s cancels the close', w2.instances.length === 1 && !w2.instances[0].closed);
}
{ // a reconnect that skipped a chatend refetches the transcript and clears busy
  const w = world({ chatReply: { turns: [{ role: 'user', text: 'q' }, { role: 'assistant', text: 'a' }] } }); const s = createStore(w.env); s.start(boot);
  const a = w.instances[0]; a.open(); a.emit('chat', { agent: 'ag', turn: 1, seq: 1, delta: 'x' }, 'ag:1:1');
  a.fail(2); w.advance(1000); // the chatend fires while we are away: nothing replays it
  const b = w.instances[1]; b.open(); await flush();
  check('the reopen after a dropped stream carries the last chat id for replay', b.url === '/stream?topics=fleet,agents,usage,system&lastEventId=ag%3A1%3A1', b.url);
  check('a reconnect refetches /api/agents/<n>/chat for each agent still busy', w.fetched.join() === '/api/agents/ag/chat', w.fetched);
  check('...and clears busy when the last recorded turn is the assistant\'s', !('ag' in s.busy.value) && s.chatLog.value.ag.length === 2, s.busy.value);
}
{
  const w = world({ chatReply: { turns: [{ role: 'user', text: 'q' }] } }); const s = createStore(w.env); s.start(boot);
  const a = w.instances[0]; a.open(); a.emit('chat', { agent: 'ag', turn: 1, seq: 1, delta: 'x' }, 'ag:1:1'); a.fail(2); w.advance(1000);
  w.instances[1].open(); await flush();
  check('...but keeps busy while the last recorded turn is still the user\'s', s.busy.value.ag === 1, s.busy.value);
}
{ // no gap, no fetch
  const w = world(); const s = createStore(w.env); s.start(boot); const a = w.instances[0]; a.open(); a.fail(2); w.advance(1000); w.instances[1].open(); await flush();
  check('a reconnect with nothing in flight fetches nothing', w.fetched.length === 0);
  const first = world(); createStore(first.env).start(boot); first.instances[0].open(); await flush();
  check('the very first open is not a reconnect', first.fetched.length === 0);
}
{ // stop
  const w = world(); const s = createStore(w.env); s.start(boot); w.instances[0].open(); s.stop();
  check('stop closes the stream and drops the visibility listener', w.instances[0].closed && w.listeners.length === 0);
}
console.log(bad ? `store-check: ${bad} FAILED` : 'store-check: all passed');
process.exit(bad ? 1 : 0);
