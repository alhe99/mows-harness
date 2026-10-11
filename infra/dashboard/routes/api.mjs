import { promises as fsp } from 'node:fs';
import os from 'node:os';
import { agentCapability } from '../capability.mjs';
import { ACCTS, BY_ID, HOST_ACCT, MSG_PAGE, PAGE, RESUME_DAYS, canResume, claudeVersion, counts, freshen, hostInfo, index, liveSid8, loadSession,
  projName, reclaimScan, sameOrigin, sendJson, titleOf, tmuxLive, usage, usageCache } from '../core.mjs';
import { DROID_UDID, droidState, watchLive } from './device.mjs';
import { AGENTS_STATE, AGENT_RE, RUN_RE, agentChat, agentFrontmatter, agentTimers, agentsConfig, agentsIndex, summarizeTimers, webhookKey } from './agents.mjs';


// the filter + page of /history, shared by listView and the /next shell's boot snapshot so the two can never disagree
export async function historyQuery(url, host) {
  const sub = (host || '').split('.')[0];
  const acct = url.searchParams.get('acct') || HOST_ACCT[sub] || '';
  const q = (url.searchParams.get('q') || '').toLowerCase().slice(0, 80);
  const d = url.searchParams.get('d') || '';
  const s = url.searchParams.get('s') || '';
  const live = await tmuxLive();
  const liveBySid = new Map(live.map(l => [liveSid8(l), l]).filter(([k]) => k)); // sid8 -> live session
  let rows = index;
  if (acct && BY_ID[acct]) rows = rows.filter(e => e.a === acct);
  if (q) rows = rows.filter(e => e.proj.toLowerCase().includes(q) || e.sid.startsWith(q));
  const CUT = { today: new Date(new Date().toISOString().slice(0, 10)).getTime(),
    '7d': Date.now() - 7 * 86400e3, '30d': Date.now() - 30 * 86400e3 };
  if (CUT[d]) rows = rows.filter(e => e.mt >= CUT[d]);
  if (s === 'live') rows = rows.filter(e => liveBySid.has(e.sid.slice(0, 8)));
  const max = Math.max(1, Math.ceil(rows.length / PAGE));
  const cur = Math.min(max, Math.max(1, +(url.searchParams.get('page') || 1) || 1));
  const slice = rows.slice((cur - 1) * PAGE, cur * PAGE);
  const titles = await Promise.all(slice.map(titleOf));
  return { sub, acct, q, d, s, live, liveBySid, rows, max, cur, slice, titles };
}

// The four pages of the shell that have JSON (contract.d.ts): each builder is shared by GET /api/<name> and by the boot snapshot
// routes/documents.mjs inlines in the shell document, so the first paint and a later fetch can never disagree.
export async function historyPage(url, host) {
  const { sub, acct, rows, cur, max, slice, titles, liveBySid } = await historyQuery(url, host);
  return { page: cur, pages: max, total: rows.length, live: liveBySid.size, indexed: index.length, acct, label: HOST_ACCT[sub] ? sub : '',
    rows: slice.map((e, i) => ({ a: e.a, sid: e.sid, sid8: e.sid.slice(0, 8), proj: e.proj, mt: e.mt, sz: e.sz, title: titles[i].title ?? null,
      live: liveBySid.has(e.sid.slice(0, 8)), canResume: canResume(e.mt, liveBySid.has(e.sid.slice(0, 8))), acctColor: BY_ID[e.a].color })),
    accts: ACCTS.map(a => ({ id: a.id, label: a.label, color: a.color, n: counts[a.id] || 0, term: !!a.term })), resumeDays: RESUME_DAYS };
}

// the host numbers of the `system` topic, the whole usage collection (the `usage` topic carries a projection of it), and what the
// Environment and Terminal cards show; ?reclaim=1 adds the measured disk-reclaim preview (~1-2 s of du, so only when asked for)
export async function systemPage(url) {
  const [live, version, deploy] = await Promise.all([tmuxLive(), claudeVersion(), fsp.stat(new URL('../lite.mjs', import.meta.url)).catch(() => null)]);
  const out = { ...hostInfo(), version, usage: usage(), now: Date.now(), usageAt: usageCache.t, busy: usageCache.busy, live: live.length,
    deployed: deploy ? deploy.mtimeMs : null, node: process.version, platform: `${os.platform()}/${os.arch()}` };
  if (url.searchParams.get('reclaim')) out.reclaim = (await reclaimScan()).map(t => ({ id: t.id, label: t.label, note: t.note, g: t.g || '', b: t.b, extra: t.extra }));
  return out;
}

// one page of a transcript, newest page first, chronological inside the page (detailView's slicing); null when the session is unknown
export async function sessionPage(a, sid, pageParam) {
  freshen();
  const e = index.find(x => x.a === a && x.sid === sid);
  if (!e) return null;
  const s = await loadSession(e);
  const acct = BY_ID[a], n = s.msgs.length, max = Math.max(1, Math.ceil(n / MSG_PAGE));
  const cur = Math.min(max, Math.max(1, +pageParam || 1));
  const end = n - (cur - 1) * MSG_PAGE, start = Math.max(0, end - MSG_PAGE);
  const lv = (await tmuxLive()).find(l => liveSid8(l) === sid.slice(0, 8));
  return { a, sid, sid8: sid.slice(0, 8), acct: { label: acct.label, color: acct.color, term: !!acct.term }, proj: s.meta.cwd || projName(e.proj),
    started: s.meta.firstTs, mt: e.mt, sz: e.sz, items: n, tools: s.meta.tools, model: s.meta.model, truncated: !!s.truncated,
    live: lv ? { name: lv.name, paused: !!lv.paused, label: lv.label || '' } : null, canResume: canResume(e.mt, !!lv), resumeDays: RESUME_DAYS,
    page: cur, pages: max, msgs: s.msgs.slice(start, end) };
}

// the Device tab's two devices: the redroid emulator (docker + adb) and the QA browser (noVNC on :6080); dv is the one to show
export async function devicePage(dvParam) {
  const [droid, web] = await Promise.all([droidState(), watchLive()]);
  const dv = dvParam === 'web' ? 'web' : dvParam === 'mobile' ? 'mobile' : droid.state !== 'stopped' ? 'mobile' : web ? 'web' : 'mobile';
  return { dv, droid: { ...droid, udid: DROID_UDID }, web: { live: web, port: 6080 } };
}

export async function apiView(req, res, rest) {
  // rest is p.slice(5) from a path that starts '/api/' — e.g. "agents", "agents/<name>",
  // "agents/<name>/chat", "agents/<name>/runs/<run_id>". Parsed explicitly into segments
  // rather than one four-group regex: the regex the brief for this task shipped destructured
  // four capture groups from a three-group pattern (the fourth only ever coming from a
  // never-added fourth path segment) and needed a separate rest.startsWith('agents') guard
  // to reject non-agents paths — a guard the regex itself could express directly. Splitting
  // makes every segment's role explicit and drops the redundant check.
  const [section, name, kind, id] = rest.split('/').filter(Boolean);
  const url = new URL(req.url, 'http://x');
  const need = method => req.method === method || (res.writeHead(405, { allow: method }), res.end(), false);
  if (section === 'history') return need('GET') && sendJson(req, res, 200, await historyPage(url, req.headers.host));
  if (section === 'system') return need('GET') && sendJson(req, res, 200, await systemPage(url));
  if (section === 'device') return need('GET') && sendJson(req, res, 200, await devicePage(url.searchParams.get('dv')));
  if (section === 'session') {
    if (!need('GET')) return;
    if (!BY_ID[name] || !/^[0-9a-f-]{8,64}$/.test(kind || '')) { res.writeHead(404); return res.end(); }
    let pg;
    try { pg = await sessionPage(name, kind, url.searchParams.get('page')); } catch { res.writeHead(500); return res.end(); }
    if (!pg) { res.writeHead(404); return res.end(); }
    return sendJson(req, res, 200, pg);
  }
  // the old GET ?fresh=1: re-collect usage now (claude-quota's own cache too), in the background; the view polls /api/system until it lands
  if (section === 'usage' && name === 'refresh') {
    if (!need('POST')) return;
    if (!sameOrigin(req, req.headers.host || '')) { res.writeHead(403); return res.end('bad origin'); }
    usage(true);
    return sendJson(req, res, 202, { ok: true });
  }
  if (section !== 'agents') { res.writeHead(404); return res.end(); }
  if (!name) {
    // Deliberately no per-agent timer lookup here: agentTimers() spawns systemctl per agent and
    // is uncached, and the list renders no next-fire time. The detail endpoint does it once,
    // for the one agent being viewed.
    const list = await agentsIndex();
    return sendJson(req, res, 200, { agents: list.map(a => ({
      name: a.name, state: a.last?.state ?? null, last_event_at: a.last?.last_event_at ?? null,
      total: a.total, cost7d: a.cost7d,
    })) });
  }
  if (!AGENT_RE.test(name)) { res.writeHead(404); return res.end(); }
  const a = (await agentsIndex()).find(x => x.name === name);
  if (!a) { res.writeHead(404); return res.end(); }
  if (!kind) {
    const timers = await agentTimers(name);
    // capability is null — NOT an empty capability — whenever the agent file could not be read or
    // did not parse. The view renders that as "unknown"; an empty object would render as a very
    // confident "no tools, no budget, no triggers", which is the exact failure this task exists to
    // prevent. A run record can outlive its agent file (retention_days keeps the record, the file
    // can be deleted), so this is a reachable state, not a theoretical one.
    const fm = await agentFrontmatter(name);
    const capability = fm
      ? agentCapability(fm, { webhookArmed: !!agentsConfig()[webhookKey(name)] })
      : null;
    return sendJson(req, res, 200, {
      name, recs: a.recs, events: a.events, total: a.total, cost7d: a.cost7d,
      timers, timer: summarizeTimers(timers), capability,
      // The agent's own working memory (spec 2026-09-19): mows-agent writes it, this reads it,
      // nothing here edits it. null when absent — never '' — so the card can tell "no memory
      // yet" from "memory deliberately cleared" (an empty file), which the agent can do.
      memory: await fsp.readFile(`${AGENTS_STATE}/${name}/memory.md`, 'utf8').catch(() => null),
    });
  }
  if (kind === 'chat') return sendJson(req, res, 200, { turns: await agentChat(name) });
  if (kind === 'runs' && id) {
    if (!RUN_RE.test(id)) { res.writeHead(404); return res.end(); }
    const dir = `${AGENTS_STATE}/${name}/runs/${id}`;
    let status = null, text = '';
    try { status = JSON.parse(await fsp.readFile(`${dir}/status.json`, 'utf8')); }
    catch { res.writeHead(404); return res.end(); }
    try {
      for (const l of (await fsp.readFile(`${dir}/stream.jsonl`, 'utf8')).split('\n')) {
        if (!l.includes('"type":"assistant"')) continue;
        try { for (const c of JSON.parse(l).message?.content || []) if (c.type === 'text') text += c.text + '\n\n'; } catch {}
      }
    } catch {}
    return sendJson(req, res, 200, { status, text });
  }
  res.writeHead(404); return res.end();
}
