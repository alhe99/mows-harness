// flows.mjs — the session's Workflow runs (2026-10-26). Claude's "Background tasks" panel does not render on the phone, and its /workflows
// overlay takes the terminal over, so this page asks the dashboard instead: /app/workflows.json (infra/dashboard/routes/workflows.mjs), every
// POLL while the page is visible. A pill over the terminal while a run is going, or ended less than RECENT ago; its tap opens the menu sheet,
// whose top block (box) lists every run of the last day with its agents. Touch only, like the sheet.
import { el } from './dom.mjs';

const POLL = 5000, RECENT = 15 * 60_000;
const MARK = { running: '●', done: '✓', failed: '✕' };
const ago = ms => (ms < 90_000 ? Math.round(ms / 1000) + 's' : ms < 5_400_000 ? Math.round(ms / 60_000) + 'm' : (ms / 3_600_000).toFixed(1) + 'h');
const kt = n => (n >= 1e6 ? (n / 1e6).toFixed(1) + 'M' : Math.round(n / 1e3) + 'k');

/** @param {() => void} open the menu sheet */
export function flows(open) {
  const args = new URLSearchParams(location.search).getAll('arg');
  const url = '/app/workflows.json?tab=' + (/^[0-9a-f]{8}$/.test(args[2] || '') ? args[2] : '00000000') + (args[0] === 'attach' ? '&s=' + encodeURIComponent(args[1] || '') : '');
  const pill = el('button', { type: 'button', id: 'ccwf', hidden: true });
  pill.addEventListener('click', open);
  const box = el('div', { className: 'wf', hidden: true });

  /** @param {any[]} runs */
  const render = runs => {
    const now = Date.now();
    const line = r => {
      const done = r.agents.filter(a => a.state !== 'running').length, pi = r.phases.indexOf(r.phase);
      if (r.status === 'running') return `${r.phase || 'starting'}${pi >= 0 ? ` (${pi + 1}/${r.phases.length})` : ''} · ${done}/${r.agents.length} agents`;
      return `${r.status}${r.ms ? ' · ' + ago(r.ms) : ''}${r.tokens ? ' · ' + kt(r.tokens) + ' tokens' : ''} · ${ago(now - r.last)} ago`;
    };
    box.hidden = !runs.length;
    box.replaceChildren(...runs.map(r => el('div', { className: 'run ' + r.status },
      el('div', { className: 'rh' }, el('b', {}, r.name), el('small', {}, line(r))),
      el('ul', {}, ...r.agents.map(a => el('li', { className: a.state }, el('i', {}, MARK[a.state] || '·'), el('span', {}, a.label), el('small', {}, a.phase)))))));
    const live = runs.find(r => r.status === 'running') || runs.find(r => now - r.last < RECENT);
    pill.hidden = !live;
    if (live) { pill.className = live.status; pill.textContent = `${live.status === 'running' ? '⟳' : MARK[live.status === 'completed' ? 'done' : 'failed']} ${live.name} · ${line(live).split(' · ').slice(0, 2).join(' · ')}`; }
  };
  const tick = () => {
    if (document.hidden) return;
    fetch(url).then(r => (r.ok ? r.json() : null)).then(j => { if (j) render(Array.isArray(j.runs) ? j.runs : []); }, () => { /* offline: keep the last state */ });
  };
  tick();
  setInterval(tick, POLL);
  document.addEventListener('visibilitychange', tick);
  return { pill, box };
}
