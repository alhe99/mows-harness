// workflows.mjs — GET /app/workflows.json?tab=<8 hex>[&s=<session>]: the Workflow runs and background agents of the session a terminal tab
// shows, for the phone's badge and sheet (web/pages/term/flows.mjs), and whether Claude is in front in its pane (for composer.mjs). Claude's own "Background tasks" panel does not render on the phone, so this reads what
// Claude writes to disk instead, next to the session's transcript <sid>.jsonl:
//   <sid>/subagents/workflows/<run>/journal.jsonl   live, one line per event: launched | started {agentId,label,phase} | result | failed
//   <sid>/workflows/<run>.json                      written once the run ends: status, durationMs, totalTokens, phases
//   <sid>/workflows/scripts/<name>-<run>.js         the script: the run's name, and its meta.phases while it is still running
//   <sid>/subagents/agent-<id>.meta.json            an Agent call (2026-10-26): name, description, "finished" once it is done
//   <sid>/subagents/agent-<id>.jsonl                its transcript: the last tool it called is what it is doing
// A run with no final file is running, or "stale" once nothing in its directory changed for STALE (Claude exited mid-run). Read-only; the
// paths come from the session index, never from the request. The dashboard runs as root and these files sit in the user's home, so the
// reading does not: `node workflows.mjs --runs <transcript>` runs as the tmux user (userCmd, as cmdscan.mjs does), and every file it reads
// must be a regular file opened without following a link, read up to CAP (security review 2026-10-26: a planted link, /dev/zero or a
// root-only file, was read by root). ponytail: one short node process per poll of an open terminal; a cache when many phones watch at once.
import { constants, promises as fsp } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const STALE = 30 * 60_000, KEEP = 24 * 3600_000, MAX = 5;
const RUN_RE = /^wf_[0-9a-f-]{6,}$/, AGENT_RE = /^agent-([\w-]{1,80})\.meta\.json$/, CAP = 4 << 20, TAIL = 64 << 10;

/** a regular file, never through a link, its last CAP bytes ('' for anything else) */
async function readCapped(p, cap = CAP) {
  let fh; try { fh = await fsp.open(p, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK); } catch { return ''; }
  try {
    const st = await fh.stat(); if (!st.isFile()) return '';
    const n = Math.min(st.size, cap), b = Buffer.alloc(n);
    await fh.read(b, 0, n, st.size - n);
    return b.toString('utf8');
  } catch { return ''; } finally { await fh.close(); }
}

/** one run, from its journal (+ the final file and the script when present) */
export async function readRun(sdir, id) {
  const jdir = path.join(sdir, 'subagents', 'workflows', id);
  const [jtxt, ftxt, scripts, names] = await Promise.all([
    readCapped(path.join(jdir, 'journal.jsonl')),
    readCapped(path.join(sdir, 'workflows', id + '.json')),
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
    const m = /phases\s*:\s*\[([\s\S]*?)\]\s*,?\s*\}/.exec(await readCapped(path.join(sdir, 'workflows', 'scripts', script)));
    if (m) phases = [...m[1].matchAll(/title\s*:\s*(['"`])(.*?)\1/g)].map(x => x[2]);
  }
  const mts = await Promise.all(['journal.jsonl', ...names].map(f => fsp.lstat(path.join(jdir, f)).then(s => s.mtimeMs, () => 0)));
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

/** the last tool call in a transcript's tail, as "Tool: what for" */
function doing(tail) {
  const ls = tail.split('\n');
  for (let i = ls.length - 1; i > 0; i--) { // line 0 is cut at the tail's start
    let e; try { e = JSON.parse(ls[i]); } catch { continue; }
    const u = Array.isArray(e?.message?.content) ? e.message.content.findLast(c => c?.type === 'tool_use') : null;
    if (u) { const why = u.input?.description || u.input?.command || u.input?.file_path || u.input?.pattern || ''; return (String(u.name) + (why ? ': ' + String(why) : '')).replace(/\s+/g, ' ').slice(0, 120); }
  }
  return '';
}

/** the session's background agents (Agent calls) active in the last KEEP, newest first */
export async function agentsOf(transcript) {
  const dir = path.join(transcript.replace(/\.jsonl$/, ''), 'subagents');
  const ids = (await fsp.readdir(dir).catch(() => [])).map(f => AGENT_RE.exec(f)?.[1]).filter(Boolean);
  const all = await Promise.all(ids.map(async id => {
    const log = path.join(dir, `agent-${id}.jsonl`), last = await fsp.lstat(log).then(s => s.mtimeMs, () => 0);
    if (Date.now() - last > KEEP) return null;
    let m; try { m = JSON.parse(await readCapped(path.join(dir, `agent-${id}.meta.json`), TAIL)); } catch { return null; }
    const state = m.finished ? 'done' : Date.now() - last > STALE ? 'stale' : 'running';
    return { id, label: String(m.name || m.description || id), desc: String(m.description || ''), state, last, doing: state === 'running' ? doing(await readCapped(log, TAIL)) : '' };
  }));
  return all.filter(Boolean).sort((x, y) => (y.state === 'running') - (x.state === 'running') || y.last - x.last).slice(0, MAX);
}

const SELF = fileURLToPath(import.meta.url);
export async function workflowsJson(req, res, url) {
  const { fleetState, tmuxLive, sh, userCmd } = await import('../core.mjs'), { tabSession } = await import('./commands.mjs'); // not at load: --runs needs neither
  const tab = url.searchParams.get('tab') || '', want = url.searchParams.get('s') || '';
  let name = /^[0-9a-f]{8}$/.test(tab) ? await tabSession(tab) : '';
  const live = await tmuxLive();
  if (!name && live.some(l => l.name === want)) name = want;
  // claude: Claude is the program in front in the pane the tab shows, the session's active pane (a `claude` in its tty's foreground process
  // group, ps's `+`). The page trusts a question Claude draws that was already up when it opened on this word (composer.mjs); a shell
  // printing one is not Claude. Fails closed: no pane, no tty, ps failing all read false. (security review 2026-10-26: the first pane is
  // not the one on screen in a session of several)
  // Only a window showing that one pane: the page reads the whole window, so with a split one Claude's pane would vouch for its neighbour's
  const panes = name ? await sh(...userCmd(['tmux', 'list-panes', '-s', '-t', '=' + name, '-F', '#{window_active}#{pane_active} #{window_panes} #{window_zoomed_flag} #{pane_tty}'])) : '';
  const tty = (/^11 (?:1 \d|\d+ 1) (\S+)$/m.exec(panes) || [])[1] || '';
  const claude = /^\/dev\/pts\/\d+$/.test(tty) && (await sh('ps', ['-o', 'stat=,comm=', '-t', tty.slice(5)])).split('\n').some(l => /^\S*\+\S*\s+claude$/.test(l.trim()));
  const row = name ? (await fleetState()).find(f => f.name === name) : null;
  let runs = [], agents = [];
  if (row?.row?.path) try { ({ runs = [], agents = [] } = JSON.parse(await sh(...userCmd([process.execPath, SELF, '--runs', row.row.path])) || '{}')); } catch {}
  const buf = Buffer.from(JSON.stringify({ session: name, runs, agents, claude }));
  res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store', 'content-length': buf.length });
  res.end(buf);
}

const main = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
// node routes/workflows.mjs --runs <transcript>: { runs, agents } as JSON, for workflowsJson (as the tmux user)
if (main && process.argv[2] === '--runs') { const t = String(process.argv[3] || ''); process.stdout.write(JSON.stringify({ runs: await runsOf(t), agents: await agentsOf(t) })); }
// node routes/workflows.mjs --check: the parser against a fixture run (running, then finished), and a link is never followed
if (main && process.argv[2] === '--check') {
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
  const fin = path.join(sdir, 'workflows', id + '.json'), other = path.join(sdir, 'other.json');
  await fsp.rename(fin, other); await fsp.symlink(other, fin); // a final file that is a link: not read, the run reads as unfinished
  [r] = await runsOf(sdir + '.jsonl');
  assert.equal(r.status, 'running'); assert.equal(r.tokens, 0);
  await fsp.rm(fin); await fsp.symlink('/dev/zero', fin); // nor a device behind one
  [r] = await runsOf(sdir + '.jsonl');
  assert.equal(r.status, 'running');
  const sub = path.join(sdir, 'subagents'), w = (f, o) => fsp.writeFile(path.join(sub, f), typeof o === 'string' ? o : JSON.stringify(o));
  await w('agent-a1.meta.json', { name: 'dev-ladder', description: 'Dev ladder' });
  await w('agent-a1.jsonl', 'cut{\n' + [{ message: { content: [{ type: 'tool_use', name: 'Bash', input: { command: 'ls', description: 'Run E23\n tests' } }] } }, { message: { content: [{ type: 'tool_result' }] } }].map(e => JSON.stringify(e)).join('\n') + '\n');
  await w('agent-a2.meta.json', { description: 'Old one', finished: true }); await w('agent-a2.jsonl', '');
  await fsp.symlink('/dev/zero', path.join(sub, 'agent-a3.meta.json')); await w('agent-a3.jsonl', ''); // a planted link: skipped
  const ag = await agentsOf(sdir + '.jsonl');
  assert.deepEqual(ag.map(a => [a.label, a.state, a.doing]), [['dev-ladder', 'running', 'Bash: Run E23 tests'], ['Old one', 'done', '']]);
  await fsp.rm(sdir, { recursive: true });
  console.log('workflows.mjs: ok');
}
