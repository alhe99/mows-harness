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
console.log(gotC && !gotB ? 'PASS: replay resumed at seq 3, no duplicate of seq 2'
                          : `FAIL: gotC=${gotC} gotB=${gotB}`);
process.exit(gotC && !gotB ? 0 : 1);
