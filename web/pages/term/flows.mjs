// flows.mjs — the session's Workflow runs and background agents (2026-10-26). Claude's "Background tasks" panel does not render on the phone,
// and its /workflows overlay takes the terminal over, so this page asks the dashboard instead: /app/workflows.json
// (infra/dashboard/routes/workflows.mjs), every POLL while the page is visible. A badge on the key bar's ⋯ (term.mjs puts it there) counts
// what is running, or marks a run ended less than RECENT ago; ⋯ opens the menu sheet, whose top block (box) lists every run of the last day
// with its agents, then the background agents (Agent calls) with what each is doing. Not a pill over the terminal: that covered Claude's
// text (2026-10-26). A tap on an agent opens its detail in the same block, as the desktop's panel does: what it did, newest first, and
// its result once it ends (?agent=); the rest of the sheet steps aside (term.css) until ‹ or the next open (home). Touch only, like the sheet.
import { el } from './dom.mjs';

const POLL = 5000, RECENT = 15 * 60_000;
const MARK = { running: '●', done: '✓', failed: '✕', stale: '?' };
const ago = ms => (ms < 90_000 ? Math.round(ms / 1000) + 's' : ms < 5_400_000 ? Math.round(ms / 60_000) + 'm' : (ms / 3_600_000).toFixed(1) + 'h');
const kt = n => (n >= 1e6 ? (n / 1e6).toFixed(1) + 'M' : Math.round(n / 1e3) + 'k');

/** @param {(j: any, t0: number) => void} [on] each answer, whole, and when it was asked (term.mjs hands its `claude` to the composer) */
export function flows(on) {
  const args = new URLSearchParams(location.search).getAll('arg');
  const url = '/app/workflows.json?tab=' + (/^[0-9a-f]{8}$/.test(args[2] || '') ? args[2] : '00000000') + (args[0] === 'attach' ? '&s=' + encodeURIComponent(args[1] || '') : '');
  const badge = el('span', { id: 'ccwf', hidden: true });
  const box = el('div', { className: 'wf', hidden: true });
  /** @type {{ run: string, id: string } | null} */ let sel = null;
  let last = { runs: [], agents: [] }, log = null; // the feed's last answer; the open agent's

  const clock = t => { const d = new Date(t); return isNaN(+d) ? '' : d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', hour12: false }); };
  const detail = () => {
    const r = last.runs.find(x => x.id === sel.run), a = (r ? r.agents : last.agents).find(x => x.id === sel.id);
    const st = a ? a.state : '', sub = [st, r ? r.name : '', a?.phase || a?.desc || ''].filter(Boolean).join(' · ');
    box.replaceChildren(el('div', { className: 'dt' },
      el('div', { className: 'dh' }, el('button', { type: 'button', className: 'back', 'aria-label': 'back to the runs' }, '‹'),
        el('div', {}, el('b', {}, a ? a.label : sel.id), el('small', { className: st }, sub))),
      log?.result ? el('pre', { className: log.failed ? 'res failed' : 'res' }, log.result) : null,
      !log ? el('p', {}, 'Loading…') : log.steps.length ? el('ol', {}, ...log.steps.slice().reverse().map(x => el('li', { className: x.k }, el('small', {}, clock(x.t)), el('span', {}, x.s))))
      : el('p', {}, 'Nothing yet.')));
  };
  const more = () => fetch(`${url}&agent=${encodeURIComponent(sel.id)}${sel.run ? '&run=' + encodeURIComponent(sel.run) : ''}`).then(r => (r.ok ? r.json() : null))
    .then(j => { if (sel && j) { log = j.agent || { steps: [], result: '' }; detail(); } }, () => {});
  box.addEventListener('click', e => {
    const t = /** @type {HTMLElement} */ (e.target);
    if (t.closest('.back')) return home();
    const li = /** @type {HTMLElement | null} */ (t.closest('li[data-id]'));
    if (!li || sel) return;
    sel = { run: li.dataset.run || '', id: li.dataset.id || '' }; log = null; box.classList.add('detail'); detail(); more();
    box.closest('.pan')?.scrollTo(0, 0);
  });
  const home = () => { sel = null; log = null; box.classList.remove('detail'); render(last.runs, last.agents); };

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
    if (!sel) box.replaceChildren(...runs.map(r => el('div', { className: 'run ' + r.status },
      el('div', { className: 'rh' }, el('b', {}, r.name), el('small', {}, line(r))),
      el('ul', {}, ...r.agents.map(a => el('li', { className: a.state, 'data-run': r.id, 'data-id': a.id || '' }, el('i', {}, MARK[a.state] || '·'), el('span', {}, a.label), el('small', {}, a.phase)))))),
    agents.length ? el('div', { className: 'run ags' },
      el('div', { className: 'rh' }, el('b', {}, 'Agents'), el('small', {}, `${busy.length} running`)),
      el('ul', {}, ...agents.map(a => el('li', { className: a.state, title: a.desc, 'data-id': a.id }, el('i', {}, MARK[a.state] || '·'),
        el('span', {}, a.label, a.doing ? el('small', {}, a.doing) : null), el('small', {}, a.state === 'running' ? '' : ago(now - a.last))))))
    : null);
    if (sel) detail();
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
    fetch(url).then(r => (r.ok ? r.json() : null)).then(j => { if (j) on?.(j, t0); if (j) render(Array.isArray(j.runs) ? j.runs : [], Array.isArray(j.agents) ? j.agents : []); }, () => { /* offline: keep the last state */ });
    if (sel) more();
  };
  tick();
  setInterval(tick, POLL);
  document.addEventListener('visibilitychange', tick);
  return { badge, box, tick, home };
}
