#!/usr/bin/env node
// contract-check.mjs — a stub dashboard that emits one of each StreamEvent and answers each /api/* route with the shape
// web/contract.d.ts declares (ARCHITECTURE.md section 11). Every payload below is annotated with its contract type, so
// `npx tsc --noEmit -p web/tsconfig.json` is the check: change a field in the contract or here and it stops compiling. The
// executor cannot redefine the contract to make its own tests pass; a change to contract.d.ts is a reviewable diff.
//   node scripts/contract-check.mjs [--port N]     serve the stub (default: an ephemeral port, printed)
//   node scripts/contract-check.mjs --self-test    start it, fetch every route and read every event once, exit 0 when all of it arrives
import http from 'node:http';

/** @typedef {import('../web/contract').StreamEvent} StreamEvent */
/** @typedef {import('../web/contract').FleetItem} FleetItem */
/** @typedef {import('../web/contract').AgentItem} AgentItem */

/** @type {FleetItem[]} */
const fleet = [{ sid8: 'aaaa1111', name: 'web-aaaa1111', label: 'demo', proj: 'demo/app', state: 'working', rel: 1_760_000_000_000, snippet: 'running tests' }];
/** @type {AgentItem[]} */
const agents = [{ name: 'harness-reviewer', state: 'done', last_event_at: '2026-10-11T00:00:00Z', total: 3, cost7d: 0.42 }];

/** @type {StreamEvent[]} one of each event, in the order the real server emits them */
export const events = [
  { event: 'system', data: { load: 0.4, cores: 4, memUsed: 1e9, memTot: 8e9, swapUsed: 0, swapTot: 2e9, dskUsed: 5e10, dskTot: 1e11, up: 86400, version: '2.0.0' } },
  { event: 'usage', data: { quota: { personal: { h5: 8, wk: 18 } }, thr: 70,
    accts: { personal: { id: 'personal', label: 'personal', today: 1.2, week: 9.9, month: 40, block: { cost: 0.3, rate: 1.1 }, tokExp: null } } } },
  { event: 'fleet', data: fleet },
  { event: 'agents', data: agents },
  { event: 'chat', data: { agent: 'harness-reviewer', turn: 1, seq: 1, delta: 'hello' }, id: 'harness-reviewer:1:1' },
  { event: 'chatend', data: { agent: 'harness-reviewer', turn: 1, cost_usd: 0.01 } },
];

/** @type {Record<string, unknown>} path -> body; each annotated against its contract type */
const api = {
  '/api/agents': /** @type {import('../web/contract').ApiAgents} */ ({ agents }),
  '/api/agents/harness-reviewer': /** @type {import('../web/contract').ApiAgent} */ ({
    name: 'harness-reviewer', recs: [{ run_id: '20260916-101500-1', state: 'done' }], events: ['started', 'done'], total: 3, cost7d: 0.42,
    timers: [{ unit: 'harness-reviewer.timer', masked: false, next: null }], timer: { state: 'active', label: 'every 6h' }, capability: null, memory: null }),
  '/api/agents/harness-reviewer/chat': /** @type {import('../web/contract').ApiAgentChat} */ ({
    turns: [{ at: '2026-10-11T00:00:00Z', role: 'user', text: 'hi' }, { at: '2026-10-11T00:00:05Z', role: 'assistant', text: 'hello', cost_usd: 0.01 }] }),
  '/api/agents/harness-reviewer/runs/20260916-101500-1': /** @type {import('../web/contract').ApiAgentRun} */ ({ status: { state: 'done' }, text: 'done' }),
  '/api/push/key': /** @type {import('../web/contract').ApiPushKey} */ ({ key: 'BAAA' }),
};

/** @param {number} [port] */
export function startStub(port = 0) {
  const server = http.createServer((req, res) => {
    const p = new URL(req.url || '/', 'http://x').pathname;
    if (p === '/stream') {
      res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-store' });
      for (const e of events) res.write(`${'id' in e ? `id: ${e.id}\n` : ''}event: ${e.event}\ndata: ${JSON.stringify(e.data)}\n\n`);
      return;
    }
    if (p === '/api/push/subscribe' && (req.method === 'POST' || req.method === 'DELETE')) {
      /** @type {import('../web/contract').PushSubscribeReply} */
      const reply = { ok: true, id: 'sub-1' };
      res.writeHead(200, { 'content-type': 'application/json' });
      return res.end(JSON.stringify(reply));
    }
    if (p in api) { res.writeHead(200, { 'content-type': 'application/json' }); return res.end(JSON.stringify(api[p])); }
    res.writeHead(404); res.end();
  });
  return new Promise(resolve => server.listen(port, '127.0.0.1', () => resolve({ server, port: /** @type {import('node:net').AddressInfo} */ (server.address()).port })));
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const arg = process.argv.indexOf('--port');
  const { server, port } = await startStub(arg > 0 ? +process.argv[arg + 1] : 0);
  if (!process.argv.includes('--self-test')) console.log(`contract stub on http://127.0.0.1:${port}`);
  else {
    const base = `http://127.0.0.1:${port}`;
    let bad = 0;
    const check = (name, ok) => { if (!ok) bad++; console.log(`${ok ? 'PASS' : 'FAIL'}: ${name}`); };
    for (const p of Object.keys(api)) check(`GET ${p} answers its declared JSON`, JSON.stringify(await (await fetch(base + p)).json()) === JSON.stringify(api[p]));
    const sub = await fetch(`${base}/api/push/subscribe`, { method: 'POST', body: '{}' });
    check('POST /api/push/subscribe answers { ok: true, id }', (await sub.json()).ok === true);
    const text = new TextDecoder().decode((await (await fetch(`${base}/stream`)).body?.getReader().read())?.value);
    for (const e of events) check(`/stream emits ${e.event}`, text.includes(`event: ${e.event}\n`));
    check('only chat carries id:', (text.match(/^id: /gm) || []).length === 1 && text.includes('id: harness-reviewer:1:1\nevent: chat'));
    server.close(); server.closeAllConnections();
    process.exit(bad ? 1 : 0);
  }
}
