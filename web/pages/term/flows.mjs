// flows.mjs — the session's Workflow runs and background agents (2026-10-26). Claude's "Background tasks" panel does not render on the phone,
// and its /workflows overlay takes the terminal over, so this page asks the dashboard instead: /app/workflows.json
// (infra/dashboard/routes/workflows.mjs), every POLL while the page is visible. A badge on the key bar's ⋯ (term.mjs puts it there) counts
// what is running, or marks a run ended less than RECENT ago; ⋯ opens the menu sheet, whose top block (box) lists every run of the last day
// with its agents, then the background agents (Agent calls) with what each is doing. Not a pill over the terminal: that covered Claude's
// text (2026-10-26). A tap goes deeper in the same block, Claude's /workflows view laid out for a phone: a run shows its description, its
// phases with their counts and under each its agents (model, tokens, time); an agent shows its result once it ends and what it did, newest
// first (?agent=). The rest of the sheet steps aside (term.css); ‹ goes back a level, the next open starts at the list (home). Touch only.
import { el } from './dom.mjs';

const POLL = 5000, RECENT = 15 * 60_000;
const MARK = { running: '●', done: '✓', failed: '✕', stale: '?' };
const ago = ms => (ms < 90_000 ? Math.round(ms / 1000) + 's' : ms < 5_400_000 ? Math.round(ms / 60_000) + 'm' : (ms / 3_600_000).toFixed(1) + 'h');
const kt = n => (n >= 1e6 ? (n / 1e6).toFixed(1) + 'M' : Math.round(n / 1e3) + 'k');
const tk = n => (n >= 1e6 ? (n / 1e6).toFixed(1) + 'M' : (n / 1e3).toFixed(1) + 'k'); // as /workflows prints it: 156.6k
/** a span as /workflows prints it: 42s, 4m20s, 1h40m */
const dur = ms => { const s = Math.max(0, Math.round(ms / 1000)); return s < 60 ? s + 's' : s < 3600 ? `${Math.floor(s / 60)}m${String(s % 60).padStart(2, '0')}s` : `${Math.floor(s / 3600)}h${String(Math.floor(s / 60) % 60).padStart(2, '0')}m`; };
/** how long an agent ran (or runs) */
const took = a => { const t0 = Date.parse(a.t0), t1 = a.state === 'running' ? Date.now() : Date.parse(a.t1); return t0 && t1 > t0 ? dur(t1 - t0) : ''; };

/** @param {(j: any, t0: number) => void} [on] each answer, whole, and when it was asked (term.mjs hands its `claude` to the composer) */
export function flows(on) {
  const args = new URLSearchParams(location.search).getAll('arg');
  const url = '/app/workflows.json?tab=' + (/^[0-9a-f]{8}$/.test(args[2] || '') ? args[2] : '00000000') + (args[0] === 'attach' ? '&s=' + encodeURIComponent(args[1] || '') : '');
  const badge = el('span', { id: 'ccwf', hidden: true });
  const box = el('div', { className: 'wf', hidden: true });
  /** @type {{ run: string, id: string } | null} */ let sel = null; // null: the list; a run with no id: that run; an id: that agent
  let last = { runs: [], agents: [] }, log = null; // the feed's last answer; the open agent's

  const clock = t => { const d = new Date(t); return isNaN(+d) ? '' : d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', hour12: false }); };
  // what it did, newest first, as Claude's own transcript reads: what it said as text, each tool as its name and what for, a repeat folded
  // (×3), the time only where it changes
  const rows = xs => xs.reduce((rs, x) => {
    const p = rs[rs.length - 1];
    if (x.k === 'tool' && p?.k === 'tool' && p.n === x.n && p.s === x.s) { p.c++; p.t = x.t; } else rs.push({ ...x, c: 1 });
    return rs;
  }, []).reverse();
  const detail = () => {
    const r = last.runs.find(x => x.id === sel.run), a = (r ? r.agents : last.agents).find(x => x.id === sel.id);
    const st = a ? a.state : '', end = st === 'running' ? Date.now() : Date.parse(log?.steps.at(-1)?.t || '');
    const since = log?.t0 && end - Date.parse(log.t0) > 0 ? `since ${clock(log.t0)} · ${dur(end - Date.parse(log.t0))}` : '';
    const sub = [st, r ? r.name : '', a?.phase || a?.desc || ''].filter(Boolean).join(' · '), fig = [a?.model, a?.tok ? tk(a.tok) + ' tok' : '', since].filter(Boolean).join(' · ');
    box.replaceChildren(el('div', { className: 'dt' },
      el('div', { className: 'dh' }, el('button', { type: 'button', className: 'back', 'aria-label': 'back' }, '‹'),
        el('div', {}, el('b', {}, a ? a.label : sel.id), el('small', { className: st }, sub), fig ? el('small', {}, fig) : null)),
      log?.result ? el('pre', { className: log.failed ? 'res failed' : 'res' }, log.result) : null,
      !log ? el('p', {}, 'Loading…') : log.steps.length ? el('ol', {}, ...rows(log.steps).map((x, i, xs) => el('li', { className: x.k },
        el('small', {}, i && clock(xs[i - 1].t) === clock(x.t) ? '' : clock(x.t)),
        x.k === 'say' ? el('p', {}, x.s) : el('p', {}, el('b', {}, x.n), x.s ? ' ' + x.s : '', x.c > 1 ? el('i', {}, ' ×' + x.c) : null))))
      : el('p', {}, 'Nothing yet.')));
  };
  // a run: its phases in order, each with what is done of it and its agents under it (✓ done, ● running, its number while it waits)
  const runView = () => {
    const r = last.runs.find(x => x.id === sel.run);
    if (!r) return box.replaceChildren(el('div', { className: 'dt' }, el('div', { className: 'dh' }, el('button', { type: 'button', className: 'back', 'aria-label': 'back' }, '‹'), el('b', {}, 'Run ended'))));
    const n = r.agents.length, done = r.agents.filter(a => a.state !== 'running').length;
    const span = r.status === 'running' ? Date.now() - r.start : r.ms || r.last - r.start;
    const phases = [...new Set([...r.phases, ...r.agents.map(a => a.phase)])];
    box.replaceChildren(el('div', { className: 'dt rv' },
      el('div', { className: 'dh' }, el('button', { type: 'button', className: 'back', 'aria-label': 'back' }, '‹'),
        el('div', {}, el('b', {}, r.name), el('small', { className: r.status }, [r.status, `${done}/${n} agents`, span > 0 ? dur(span) : ''].filter(Boolean).join(' · ')))),
      r.desc ? el('p', { className: 'desc' }, r.desc) : null,
      ...phases.map((p, i) => {
        const as = r.agents.filter(a => a.phase === p), ok = as.filter(a => a.state === 'done').length;
        const st = !as.length ? 'wait' : as.some(a => a.state === 'running') ? 'running' : as.some(a => a.state === 'failed') ? 'failed' : 'done';
        return el('div', { className: 'ph ' + st },
          el('div', { className: 'phh' }, el('i', {}, st === 'wait' ? String(i + 1) : MARK[st]), el('b', {}, p), as.length ? el('small', {}, `${ok}/${as.length}`) : null),
          as.length ? el('ul', {}, ...as.map(a => el('li', { className: a.state, 'data-run': r.id, 'data-id': a.id || '' }, el('i', {}, MARK[a.state] || '·'),
            el('span', {}, a.label, el('small', {}, [a.model, a.tok ? tk(a.tok) + ' tok' : ''].filter(Boolean).join(' · '))), el('small', {}, took(a)), el('em', {}, '›')))) : null);
      })));
  };
  const show = () => (sel?.id ? detail() : sel ? runView() : render(last.runs, last.agents));
  const go = to => { sel = to; log = null; box.classList.toggle('detail', !!to); show(); if (to?.id) more(); box.closest('.pan')?.scrollTo(0, 0); };
  const more = () => fetch(`${url}&agent=${encodeURIComponent(sel.id)}${sel.run ? '&run=' + encodeURIComponent(sel.run) : ''}`).then(r => (r.ok ? r.json() : null))
    .then(j => { if (sel?.id && j) { log = j.agent || { steps: [], result: '' }; detail(); } }, () => {});
  box.addEventListener('click', e => {
    const t = /** @type {HTMLElement} */ (e.target);
    if (t.closest('.back')) return go(sel?.id && sel.run ? { run: sel.run, id: '' } : null);
    const li = /** @type {HTMLElement | null} */ (t.closest('li[data-id]:not([data-id=""])')), card = /** @type {HTMLElement | null} */ (t.closest('.run[data-run]'));
    if (li && (sel || !li.dataset.run)) return go({ run: li.dataset.run || '', id: li.dataset.id || '' });
    if (card && !sel) go({ run: card.dataset.run || '', id: '' });
  });
  const home = () => go(null);

  /** @param {any[]} runs @param {any[]} agents */
  const render = (runs, agents) => {
    last = { runs, agents };
    const now = Date.now();
    const line = r => {
      const done = r.agents.filter(a => a.state !== 'running').length, pi = r.phases.indexOf(r.phase);
      if (r.status === 'running') return `${r.phase || 'starting'}${pi >= 0 ? ` (${pi + 1}/${r.phases.length})` : ''} · ${done}/${r.agents.length} agents`;
      return `${r.status}${r.ms ? ' · ' + ago(r.ms) : ''}${r.tokens ? ' · ' + kt(r.tokens) + ' tokens' : ''} · ${ago(now - r.last)} ago`;
    };
    const busy = agents.filter(a => a.state === 'running');
    box.hidden = !sel && !runs.length && !agents.length;
    if (!sel) box.replaceChildren(...runs.map(r => el('div', { className: 'run ' + r.status, 'data-run': r.id, role: 'button' },
      el('div', { className: 'rh' }, el('b', {}, r.name, el('em', {}, '›')), el('small', {}, line(r))),
      el('ul', {}, ...r.agents.map(a => el('li', { className: a.state }, el('i', {}, MARK[a.state] || '·'), el('span', {}, a.label), el('small', {}, a.phase)))))),
    agents.length ? el('div', { className: 'run ags' },
      el('div', { className: 'rh' }, el('b', {}, 'Agents'), el('small', {}, `${busy.length} running`)),
      el('ul', {}, ...agents.map(a => el('li', { className: a.state, title: a.desc, 'data-id': a.id }, el('i', {}, MARK[a.state] || '·'),
        el('span', {}, a.label, a.doing ? el('small', {}, a.doing) : null), el('small', {}, a.state === 'running' ? '' : ago(now - a.last))))))
    : null);
    if (sel) show();
    const going = runs.filter(r => r.status === 'running').length + busy.length, ended = !going && runs.find(r => now - r.last < RECENT);
    badge.hidden = !going && !ended;
    badge.className = going ? 'running' : ended ? ended.status : '';
    badge.textContent = going ? String(going) : ended ? MARK[ended.status === 'completed' ? 'done' : 'failed'] : '';
    const say = going ? `${going} running` : ended ? `${ended.name} ${ended.status}` : '';
    badge.parentElement?.setAttribute('aria-label', 'terminal actions' + (say ? ', ' + say : ''));
  };
  const tick = () => {
    if (document.hidden) return;
    const t0 = Date.now(); // when it was asked: what it says is about the pane from then on
    fetch(url).then(r => (r.ok ? r.json() : null)).then(j => { if (j) on?.(j, t0); if (j && Array.isArray(j.runs)) render(j.runs, Array.isArray(j.agents) ? j.agents : []); }, () => { /* offline: keep the last state */ }); // runs null: the dashboard could not read them this time, same
    if (sel?.id) more();
  };
  tick();
  setInterval(tick, POLL);
  document.addEventListener('visibilitychange', tick);
  return { badge, box, tick, home };
}
