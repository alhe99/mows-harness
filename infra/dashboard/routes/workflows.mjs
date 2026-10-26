// workflows.mjs — GET /app/workflows.json?tab=<8 hex>[&s=<session>]: the Workflow runs of the session a terminal tab shows, for the phone's
// workflow pill and sheet (web/pages/term/flows.mjs). Claude's own "Background tasks" panel does not render on the phone, so this reads what
// Claude writes to disk instead, next to the session's transcript <sid>.jsonl:
//   <sid>/subagents/workflows/<run>/journal.jsonl   live, one line per event: launched | started {agentId,label,phase} | result | failed
//   <sid>/workflows/<run>.json                      written once the run ends: status, durationMs, totalTokens, phases
//   <sid>/workflows/scripts/<name>-<run>.js         the script: the run's name, and its meta.phases while it is still running
// A run with no final file is running, or "stale" once nothing in its directory changed for STALE (Claude exited mid-run). Read-only; the
// paths come from the session index, never from the request.
import { promises as fsp } from 'node:fs';
import path from 'node:path';
import { fleetState, tmuxLive } from '../core.mjs';
import { tabSession } from './commands.mjs';

const STALE = 30 * 60_000, KEEP = 24 * 3600_000, MAX = 5;
const RUN_RE = /^wf_[0-9a-f-]{6,}$/;

/** one run, from its journal (+ the final file and the script when present) */
export async function readRun(sdir, id) {
  const jdir = path.join(sdir, 'subagents', 'workflows', id);
  const [jtxt, ftxt, scripts, names] = await Promise.all([
    fsp.readFile(path.join(jdir, 'journal.jsonl'), 'utf8').catch(() => ''),
    fsp.readFile(path.join(sdir, 'workflows', id + '.json'), 'utf8').catch(() => ''),
    fsp.readdir(path.join(sdir, 'workflows', 'scripts')).catch(() => []),
    fsp.readdir(jdir).catch(() => []),
  ]);
  const agents = new Map(); // agentId -> { label, phase, state }
  for (const l of jtxt.split('\n')) {
    let e; try { e = JSON.parse(l); } catch { continue; }
    if (e.type === 'started') agents.set(e.agentId, { label: String(e.label || ''), phase: String(e.phase || ''), state: 'running' });
    else if ((e.type === 'result' || e.type === 'failed') && agents.has(e.agentId)) agents.get(e.agentId).state = e.type === 'result' ? 'done' : 'failed';
  }
  let fin = null; try { fin = ftxt ? JSON.parse(ftxt) : null; } catch {}
  const script = scripts.find(f => f.endsWith('-' + id + '.js'));
  let phases = Array.isArray(fin?.phases) ? fin.phases.map(p => String(p.title || '')) : [];
  if (!phases.length && script) { // ponytail: a regex over meta, not an eval; a script whose phases are not plain quoted titles shows none
    const m = /phases\s*:\s*\[([\s\S]*?)\]\s*,?\s*\}/.exec(await fsp.readFile(path.join(sdir, 'workflows', 'scripts', script), 'utf8').catch(() => ''));
    if (m) phases = [...m[1].matchAll(/title\s*:\s*(['"`])(.*?)\1/g)].map(x => x[2]);
  }
  const mts = await Promise.all(['journal.jsonl', ...names].map(f => fsp.stat(path.join(jdir, f)).then(s => s.mtimeMs, () => 0)));
  const last = Math.max(0, ...mts);
  const list = [...agents.values()];
  return {
    id, name: String(fin?.workflowName || (script ? script.slice(0, -(id.length + 4)) : id)),
    status: fin ? String(fin.status || 'completed') : Date.now() - last > STALE ? 'stale' : 'running',
    phase: list.length ? list[list.length - 1].phase : '', phases, agents: list, last,
    ms: fin?.durationMs || 0, tokens: fin?.totalTokens || 0,
  };
}

/** the session's runs of the last KEEP, newest first */
export async function runsOf(transcript) {
  const sdir = transcript.replace(/\.jsonl$/, ''), root = path.join(sdir, 'subagents', 'workflows');
  const ids = (await fsp.readdir(root).catch(() => [])).filter(d => RUN_RE.test(d));
  const runs = await Promise.all(ids.map(id => readRun(sdir, id)));
  return runs.filter(r => Date.now() - r.last < KEEP).sort((x, y) => y.last - x.last).slice(0, MAX);
}

export async function workflowsJson(req, res, url) {
  const tab = url.searchParams.get('tab') || '', want = url.searchParams.get('s') || '';
  let name = /^[0-9a-f]{8}$/.test(tab) ? await tabSession(tab) : '';
  if (!name && (await tmuxLive()).some(l => l.name === want)) name = want;
  const row = name ? (await fleetState()).find(f => f.name === name) : null;
  const runs = row?.row?.path ? await runsOf(row.row.path) : [];
  const buf = Buffer.from(JSON.stringify({ session: name, runs }));
  res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store', 'content-length': buf.length });
  res.end(buf);
}

// node routes/workflows.mjs --check: the parser against a fixture run (running, then finished)
if (process.argv[1] === new URL(import.meta.url).pathname && process.argv[2] === '--check') {
  const assert = (await import('node:assert')).strict, os = await import('node:os');
  const sdir = await fsp.mkdtemp(path.join(os.tmpdir(), 'wf-')), id = 'wf_0123abcd-ef0';
  await fsp.mkdir(path.join(sdir, 'subagents', 'workflows', id), { recursive: true });
  await fsp.mkdir(path.join(sdir, 'workflows', 'scripts'), { recursive: true });
  await fsp.writeFile(path.join(sdir, 'workflows', 'scripts', `my-build-${id}.js`), "export const meta = {\n name: 'my-build',\n phases: [\n { title: 'Build', detail: 'x' },\n { title: \"Review\" },\n ],\n}\n");
  await fsp.writeFile(path.join(sdir, 'subagents', 'workflows', id, 'journal.jsonl'), [
    { type: 'launched' }, { type: 'started', agentId: 'a1', label: 'build:one', phase: 'Build' }, { type: 'result', agentId: 'a1', result: {} },
    { type: 'started', agentId: 'a2', label: 'build:two', phase: 'Build' }, { type: 'failed', agentId: 'a2' },
    { type: 'started', agentId: 'a3', label: 'review:all', phase: 'Review' }].map(e => JSON.stringify(e)).join('\n') + '\nnot json\n');
  let [r] = await runsOf(sdir + '.jsonl');
  assert.equal(r.name, 'my-build'); assert.equal(r.status, 'running'); assert.equal(r.phase, 'Review');
  assert.deepEqual(r.phases, ['Build', 'Review']);
  assert.deepEqual(r.agents.map(a => a.state), ['done', 'failed', 'running']);
  await fsp.writeFile(path.join(sdir, 'workflows', id + '.json'), JSON.stringify({ status: 'completed', workflowName: 'my-build', durationMs: 5, totalTokens: 9, phases: [{ title: 'Build' }] }));
  [r] = await runsOf(sdir + '.jsonl');
  assert.equal(r.status, 'completed'); assert.equal(r.tokens, 9); assert.deepEqual(r.phases, ['Build']);
  await fsp.rm(sdir, { recursive: true });
  console.log('workflows.mjs: ok');
}
