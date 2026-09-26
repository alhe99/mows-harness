// Proves the spec §3 connection cap on /stream: SSE_MAX concurrent clients are accepted, the
// next one is refused with 503 + Retry-After, and the slots come back when clients disconnect.
//
// This lives in node rather than in e2e-infra.sh because the shell cannot express it: the cap is
// about SIMULTANEOUS connections, so the check needs SSE_MAX+1 sockets open at the same moment
// and then torn down deterministically before the rest of the suite runs. Backgrounded curls
// would leave slots occupied for however long their timeout had left, and every /stream
// assertion after this one would fail for reasons that have nothing to do with what it tests.
//
// Until this file existed, e2e-infra.sh asserted the cap with the shell builtin `true`, annotated
// "exercised by the node harness in Task 3 step 5". No harness exercised it.
import http from 'node:http';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const PORT = process.env.PORT || 3105;

// Read SSE_MAX out of lite.mjs instead of hardcoding 8. A copy here would silently stop testing
// the cap the day someone retunes it — the harness would keep opening 8 connections against a
// limit of 16 and report a green "cap works" having never reached the cap.
const LITE = fileURLToPath(new URL('../infra/dashboard/lite.mjs', import.meta.url));
const m = /^const SSE_MAX = (\d+);/m.exec(readFileSync(LITE, 'utf8'));
if (!m) {
  console.log(`FAIL: could not read SSE_MAX from ${LITE} — the cap check has lost its subject`);
  process.exit(1);
}
const SSE_MAX = Number(m[1]);

const open = (path) => new Promise((resolve, reject) => {
  const req = http.get({ port: PORT, path }, res => { res.resume(); resolve(res); });
  req.on('error', reject);
});
const sleep = ms => new Promise(r => setTimeout(r, ms));

// One attempt at filling every slot. Returns the accepted responses plus the status the
// (SSE_MAX+1)th connection got. Retried by the caller because an earlier assertion's curl may
// still be occupying a slot for the few milliseconds it takes the kernel to report its close —
// that is a dirty slate, not a broken cap, and retrying tells the two apart.
async function fill() {
  const held = [];
  for (let i = 0; i < SSE_MAX; i++) {
    const res = await open('/stream?topics=fleet');
    held.push(res);
    if (res.statusCode !== 200) return { held, short: i + 1, over: null };
  }
  const extra = await open('/stream?topics=fleet');
  return { held, short: null, over: extra };
}

let attempt = null;
for (let tries = 0; tries < 4; tries++) {
  attempt = await fill();
  if (!attempt.short) break;
  for (const r of attempt.held) r.destroy();
  await sleep(400);
}

const { held, short, over } = attempt;
let ok = true;
const fail = (msg) => { ok = false; console.log(`FAIL: ${msg}`); };

if (short) {
  fail(`connection ${short} of ${SSE_MAX} was refused (${attempt.held.at(-1).statusCode}) — the cap fires below SSE_MAX`);
} else {
  const code = over.statusCode;
  const retry = over.headers['retry-after'];
  if (code === 503) {
    console.log(`PASS: ${SSE_MAX} concurrent /stream clients accepted, the next got 503`);
    // Retry-After is the half clients act on: without it the dashboard's EventSource reconnects
    // as fast as the browser will let it and hammers a box that just said it was full.
    // Nested under the 503, not checked alongside it: a missing cap would otherwise also print
    // "the 503 has no Retry-After", which is a false statement about a 503 that never happened.
    if (retry) console.log(`PASS: the 503 carries Retry-After: ${retry}`);
    else fail('the 503 has no Retry-After header — a refused client is told nothing about when to return');
  } else {
    fail(`connection ${SSE_MAX + 1} got ${code}, expected 503 — the cap does not hold`);
  }
  over.destroy();
}

// Slots must be reclaimed on disconnect. If they leak, the cap turns into a permanent lockout
// after SSE_MAX page loads, and every /stream assertion after this one in the suite breaks.
for (const r of held) r.destroy();
await sleep(400);
const after = await open('/stream?topics=fleet');
if (after.statusCode === 200) console.log('PASS: slots are reclaimed on disconnect — a fresh client is accepted again');
else fail(`a fresh client got ${after.statusCode} after every connection closed — slots leak`);
after.destroy();

process.exit(ok ? 0 : 1);
