// flows.mjs — the session's Workflow runs and background agents (2026-10-26). Claude's "Background tasks" panel does not render on the phone,
// and its /workflows overlay takes the terminal over, so this page asks the dashboard instead: /app/workflows.json
// (infra/dashboard/routes/workflows.mjs), every POLL while the page is visible. A badge on the key bar's ⋯ (term.mjs puts it there) counts
// what is running, or marks a run ended less than RECENT ago; ⋯ opens the menu sheet, whose top block (box) lists every run of the last day
// with its agents, then the background agents (Agent calls) with what each is doing. Not a pill over the terminal: that covered Claude's
// text (2026-10-26). Touch only, like the sheet.
import { el } from './dom.mjs';

const POLL = 5000, RECENT = 15 * 60_000;
const MARK = { running: '●', done: '✓', failed: '✕', stale: '?' };
const ago = ms => (ms < 90_000 ? Math.round(ms / 1000) + 's' : ms < 5_400_000 ? Math.round(ms / 60_000) + 'm' : (ms / 3_600_000).toFixed(1) + 'h');
const kt = n => (n >= 1e6 ? (n / 1e6).toFixed(1) + 'M' : Math.round(n / 1e3) + 'k');

export function flows() {
  const args = new URLSearchParams(location.search).getAll('arg');
  const url = '/app/workflows.json?tab=' + (/^[0-9a-f]{8}$/.test(args[2] || '') ? args[2] : '00000000') + (args[0] === 'attach' ? '&s=' + encodeURIComponent(args[1] || '') : '');
  const badge = el('span', { id: 'ccwf', hidden: true });
  const box = el('div', { className: 'wf', hidden: true });

  /** @param {any[]} runs @param {any[]} agents */
  const render = (runs, agents) => {
    const now = Date.now();
    const line = r => {
      const done = r.agents.filter(a => a.state !== 'running').length, pi = r.phases.indexOf(r.phase);
      if (r.status === 'running') return `${r.phase || 'starting'}${pi >= 0 ? ` (${pi + 1}/${r.phases.length})` : ''} · ${done}/${r.agents.length} agents`;
      return `${r.status}${r.ms ? ' · ' + ago(r.ms) : ''}${r.tokens ? ' · ' + kt(r.tokens) + ' tokens' : ''} · ${ago(now - r.last)} ago`;
    };
    const busy = agents.filter(a => a.state === 'running');
    box.hidden = !runs.length && !agents.length;
    box.replaceChildren(...runs.map(r => el('div', { className: 'run ' + r.status },
      el('div', { className: 'rh' }, el('b', {}, r.name), el('small', {}, line(r))),
      el('ul', {}, ...r.agents.map(a => el('li', { className: a.state }, el('i', {}, MARK[a.state] || '·'), el('span', {}, a.label), el('small', {}, a.phase)))))),
    agents.length ? el('div', { className: 'run ags' },
      el('div', { className: 'rh' }, el('b', {}, 'Agents'), el('small', {}, `${busy.length} running`)),
      el('ul', {}, ...agents.map(a => el('li', { className: a.state, title: a.desc }, el('i', {}, MARK[a.state] || '·'),
        el('span', {}, a.label, a.doing ? el('small', {}, a.doing) : null), el('small', {}, a.state === 'running' ? '' : ago(now - a.last))))))
    : null);
    const going = runs.filter(r => r.status === 'running').length + busy.length, ended = !going && runs.find(r => now - r.last < RECENT);
    badge.hidden = !going && !ended;
    badge.className = going ? 'running' : ended ? ended.status : '';
    badge.textContent = going ? String(going) : ended ? MARK[ended.status === 'completed' ? 'done' : 'failed'] : '';
    const say = going ? `${going} running` : ended ? `${ended.name} ${ended.status}` : '';
    badge.parentElement?.setAttribute('aria-label', 'terminal actions' + (say ? ', ' + say : ''));
  };
  const tick = () => {
    if (document.hidden) return;
    fetch(url).then(r => (r.ok ? r.json() : null)).then(j => { if (j) render(Array.isArray(j.runs) ? j.runs : [], Array.isArray(j.agents) ? j.agents : []); }, () => { /* offline: keep the last state */ });
  };
  tick();
  setInterval(tick, POLL);
  document.addEventListener('visibilitychange', tick);
  return { badge, box };
}
