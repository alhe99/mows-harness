// Proves the spec §3 resumability claim: a client that reconnects with Last-Event-ID gets the
// deltas it missed, exactly once, in order. curl cannot express this, so it gets its own check.
import http from 'node:http';
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

process.exit(replayOk && isolationOk && connectionAlive ? 0 : 1);
