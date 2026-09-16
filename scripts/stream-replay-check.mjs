// Proves the spec §3 resumability claim: a client that reconnects with Last-Event-ID gets the
// deltas it missed, exactly once, in order. curl cannot express this, so it gets its own check.
import http from 'node:http';
const PORT = process.env.PORT || 3105, AGENT = 'replaytest';
const get = (path, headers = {}) => new Promise(r => http.get({ port: PORT, path, headers }, r));
const res1 = await get(`/stream?topics=chat:${AGENT}`);
const seen = [];
res1.on('data', b => { for (const l of String(b).split('\n')) if (l.startsWith('id: ')) seen.push(l.slice(4).trim()); });
await new Promise(r => setTimeout(r, 300));
await get(`/_test/chat?agent=${AGENT}&turn=1&seq=1&delta=A`);
await get(`/_test/chat?agent=${AGENT}&turn=1&seq=2&delta=B`);
await new Promise(r => setTimeout(r, 300));
res1.destroy();
await get(`/_test/chat?agent=${AGENT}&turn=1&seq=3&delta=C`);
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
await get(`/_test/chat?agent=${LEAK_AGENT}&turn=1&seq=1&delta=SECRET1`);
await get(`/_test/chat?agent=${LEAK_AGENT}&turn=1&seq=2&delta=SECRET2`);
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

process.exit(replayOk && isolationOk ? 0 : 1);
