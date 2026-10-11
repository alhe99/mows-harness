// Proves the spec §3 resumability claim: a client that reconnects with Last-Event-ID gets the
// deltas it missed, exactly once, in order. curl cannot express this, so it gets its own check.
import http from 'node:http';
// --chatend-gap: also run web/store.mjs against the live /stream through a real SSE client (the case below).
const GAP = process.argv.includes('--chatend-gap');
const PORT = process.env.PORT || 3105, AGENT = 'replaytest';
const get = (path, headers = {}) => new Promise(r => http.get({ port: PORT, path, headers }, r));
// Every delta this file injects goes through here, never through a bare get(). /_test/chat is
// gated on MOWS_TEST_HOOKS in the SERVER's env, and when that gate is shut the route 404s: the
// injections become no-ops and every assertion below that looks for the ABSENCE of something —
// the cross-agent leak check in particular — passes because nothing was ever there to leak.
// That is exactly how this file was run for its whole life (the harness was handed the env var
// instead of the dashboard), so the leak regression reported PASS while testing nothing. A
// non-204 here is a broken rig, not a result, and must never be reported as a pass.
const seed = async (path) => {
  const r = await get(path);
  r.resume();
  if (r.statusCode !== 204) {
    console.log(`FAIL: test hooks unavailable — ${path} returned ${r.statusCode}, expected 204.`);
    console.log('      MOWS_TEST_HOOKS=1 must be set on the DASHBOARD process, not on this one.');
    process.exit(1);
  }
};
const res1 = await get(`/stream?topics=chat:${AGENT}`);
const seen = [];
res1.on('data', b => { for (const l of String(b).split('\n')) if (l.startsWith('id: ')) seen.push(l.slice(4).trim()); });
await new Promise(r => setTimeout(r, 300));
await seed(`/_test/chat?agent=${AGENT}&turn=1&seq=1&delta=A`);
await seed(`/_test/chat?agent=${AGENT}&turn=1&seq=2&delta=B`);
await new Promise(r => setTimeout(r, 300));
res1.destroy();
await seed(`/_test/chat?agent=${AGENT}&turn=1&seq=3&delta=C`);
const res2 = await get(`/stream?topics=chat:${AGENT}`, { 'last-event-id': `${AGENT}:1:2` });
let replayed = '';
res2.on('data', b => { replayed += String(b); });
await new Promise(r => setTimeout(r, 400));
res2.destroy();
const gotC = /"delta":"C"/.test(replayed), gotB = /"delta":"B"/.test(replayed);
const replayOk = gotC && !gotB;
console.log(replayOk ? 'PASS: replay resumed at seq 3, no duplicate of seq 2'
                     : `FAIL: gotC=${gotC} gotB=${gotB}`);

// Regression: the replay path once read the agent name straight out of a client-supplied
// Last-Event-ID with no topic check — streamSend() gates live broadcasts on c.topics, but
// replay called streamWrite() directly and inherited no gating at all, so a client with
// NO chat subscription (or a subscription to a DIFFERENT agent) could spoof Last-Event-ID
// for any agent and read its in-flight turn verbatim. Proves cross-agent isolation on the
// replay path specifically, not just that replay works for the subscribed agent above.
const LEAK_AGENT = 'leaktest';
const seeder = await get(`/stream?topics=chat:${LEAK_AGENT}`);
seeder.resume(); // drain, uninterested in its data — it only exists to be a live subscriber
await new Promise(r => setTimeout(r, 300));
await seed(`/_test/chat?agent=${LEAK_AGENT}&turn=1&seq=1&delta=SECRET1`);
await seed(`/_test/chat?agent=${LEAK_AGENT}&turn=1&seq=2&delta=SECRET2`);
await new Promise(r => setTimeout(r, 300));
seeder.destroy();
// attacker: subscribes to an unrelated topic, spoofs Last-Event-ID for LEAK_AGENT
const attacker = await get('/stream?topics=fleet', { 'last-event-id': `${LEAK_AGENT}:1:0` });
let leakedBuf = '';
attacker.on('data', b => { leakedBuf += String(b); });
await new Promise(r => setTimeout(r, 400));
attacker.destroy();
const leaked = /SECRET1|SECRET2/.test(leakedBuf);
const isolationOk = !leaked;
console.log(isolationOk ? 'PASS: replay does not leak an unsubscribed agent\'s buffer to a spoofed Last-Event-ID'
                        : `FAIL: cross-agent replay leak — attacker with topics=fleet received:\n${leakedBuf}`);

// Regression: an early GATE FIX ATTEMPT rejected the replay with a bare `return` inside
// streamView, which exits the whole handler — headers already flushed, but no first tick, no
// heartbeat, no intervals ever armed. A client whose Last-Event-ID names an agent it isn't
// subscribed to (this attacker connection, above) must still get a perfectly normal stream
// afterwards: its own topics.has('fleet') tick still has to run. Reuses the SAME attacker
// connection/buffer from the isolation check above, so this also proves the fix didn't
// merely suppress the leak by killing the connection instead of skipping the replay.
const connectionAlive = /event: fleet/.test(leakedBuf);
console.log(connectionAlive ? 'PASS: a rejected replay does not kill the connection — fleet events still arrive'
                            : `FAIL: no fleet event reached the attacker connection — rejecting the replay killed it:\n${leakedBuf}`);


// The chatend gap (ledger D-04, K-34). A `chatend` carries no id: and is never replayed (K-14), so a client whose stream was cut while
// a turn ended cannot learn it from the stream at all. The shell's store (web/store.mjs, run here unchanged) must notice on reconnect
// that an agent it still holds as busy has gone quiet, refetch that agent's transcript, and clear busy when the last turn recorded
// is the agent's. This is the whole path against the real server: a real EventSource-shaped client over http, the store's own
// reconnect backoff, the server's real replay logic. Only the transcript endpoint is answered here, because a dev instance has no
// agent by this name and a probe must not write into a real agent's chat.jsonl.
let gapOk = true;
if (GAP) {
  const { createStore } = await import('../web/store.mjs');
  const GAP_AGENT = 'gapagent', GAP_TURN = 7;
  const gapCheck = (name, ok, detail) => { if (!ok) gapOk = false; console.log(`${ok ? 'PASS' : 'FAIL'}: ${name}${ok || detail === undefined ? '' : ' ' + JSON.stringify(detail)}`); };
  const opened = [], fetched = [];
  let current = null;
  class SseClient { // the browser's EventSource as far as the store uses it: addEventListener, close, readyState, and CLOSED on a dead socket
    constructor(url) {
      this.url = url; this.readyState = 0; this.l = {}; opened.push(url); current = this;
      const u = new URL(url, 'http://x');
      this.req = http.get({ port: PORT, path: u.pathname + u.search, headers: { accept: 'text/event-stream' } }, res => {
        this.res = res; this.readyState = 1; this.emit('open', '');
        let buf = '';
        res.setEncoding('utf8');
        res.on('data', d => {
          buf += d;
          for (let i; (i = buf.indexOf('\n\n')) >= 0;) {
            const rec = { event: 'message', data: '', id: '' };
            for (const line of buf.slice(0, i).split('\n')) {
              if (line.startsWith('event: ')) rec.event = line.slice(7); else if (line.startsWith('data: ')) rec.data += line.slice(6); else if (line.startsWith('id: ')) rec.id = line.slice(4);
            }
            buf = buf.slice(i + 2);
            if (rec.data) this.emit(rec.event, rec.data, rec.id);
          }
        });
        res.on('close', () => this.dead());
      });
      this.req.on('error', () => this.dead());
    }
    addEventListener(t, f) { (this.l[t] ||= []).push(f); }
    emit(t, data, lastEventId = '') { for (const f of this.l[t] || []) f({ data, lastEventId }); }
    dead() { if (this.readyState !== 2) { this.readyState = 2; this.emit('error', ''); } }
    close() { this.readyState = 2; this.req.destroy(); }
    cut() { this.res.destroy(); } // what a phone losing signal does to the socket
  }
  const env = {
    EventSource: SseClient, setTimeout, clearTimeout,
    document: { visibilityState: 'visible', addEventListener() {}, removeEventListener() {} },
    fetch: url => {
      fetched.push(url);
      return Promise.resolve({ ok: true, json: () => Promise.resolve({ turns: [
        { at: '2026-10-11T10:00:00Z', role: 'user', text: 'a question' }, { at: '2026-10-11T10:00:09Z', role: 'assistant', text: 'ABC, finished while the stream was down' }] }) });
    },
  };
  const until = async (fn, ms) => { for (let t = 0; t < ms && !fn(); t += 50) await new Promise(r => setTimeout(r, 50)); return fn(); };
  const store = createStore(env);
  store.start({ route: '/agents', fleet: [], live: 0, indexed: 0, host: 'x' });
  const release = store.watch(`chat:${GAP_AGENT}`);
  await until(() => current && current.readyState === 1 && current.url.includes(`chat:${GAP_AGENT}`), 3000);
  gapCheck('the store holds the chat topic on its one stream', !!current && current.url.includes(`,chat:${GAP_AGENT}`), opened);
  await seed(`/_test/chat?agent=${GAP_AGENT}&turn=${GAP_TURN}&seq=1&delta=ABC`);
  await seed(`/_test/chat?agent=${GAP_AGENT}&turn=${GAP_TURN}&seq=2&delta=DEF`);
  gapCheck('a delta marks the agent busy', await until(() => store.busy.value[GAP_AGENT] === GAP_TURN && store.chat.value && store.chat.value.seq === 2, 3000), store.busy.value);
  const before = opened.length;
  current.cut();
  await new Promise(r => setTimeout(r, 200));
  await seed(`/_test/chatend?agent=${GAP_AGENT}&turn=${GAP_TURN}&cost_usd=0.01`); // the turn ends while no client is connected
  gapCheck('the stream is down when the turn ends (nothing reconnected in the meantime)', opened.length === before, { before, now: opened.length });
  gapCheck('after the reconnect the transcript was refetched and busy cleared', await until(() => !(GAP_AGENT in store.busy.value), 15000),
    { busy: store.busy.value, opened: opened.length });
  gapCheck('...the chatend itself never arrived (it is not replayed), so it was the refetch that did it',
    store.chatend.value === null && fetched.length === 1 && fetched[0] === `/api/agents/${GAP_AGENT}/chat`, { chatend: store.chatend.value, fetched });
  gapCheck('...the refetched transcript is handed to the views (chatLog) for the chat to settle from',
    (store.chatLog.value[GAP_AGENT] || []).length === 2 && store.chatLog.value[GAP_AGENT][1].role === 'assistant', store.chatLog.value);
  gapCheck('the reopened stream carried the last chat id and the chat topic', /lastEventId=gapagent%3A7%3A2/.test(opened[opened.length - 1]) && /,chat:gapagent/.test(opened[opened.length - 1]), opened.slice(-1));
  release();
  store.stop();
  current && current.close();
}

process.exit(replayOk && isolationOk && connectionAlive && gapOk ? 0 : 1);
