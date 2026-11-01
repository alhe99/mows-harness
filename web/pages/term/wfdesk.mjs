// wfdesk.mjs — a desktop's view of the session's workflow runs (2026-11-01, designs B + D of the "Workflows on desktop" proposals). A
// desktop has no key bar, so no ⋯ badge and no sheet (the phone's, flows.mjs): a chip in the composer's bar carries the run's progress (a
// ring and "2/7", its phase of its phases), a click opens a popover over it (B: the run's phases as a segmented bar, its agents, the
// subagents at work) and "Open run" a full view (D: the phases, a timeline of the agents from their first and last stamps, and the chosen
// agent's log and result, newest first, from the same ?agent= feed the phone reads). Loaded only on a desktop (term.mjs, import()), so a
// phone never fetches it and the /term budget never counts it. Esc closes the top one; a click outside closes the popover.
// No imports, and copies of the few helpers it shares with dom.mjs and flows.mjs: an import made them a chunk of their own that the phone's
// bundle loads too, and passing them in cost it as much (0.8 and 0.1 kB over the /term budget, 2026-11-01). Keep them in step by hand.
/** @returns {any} */
const el = (tag, props = {}, ...kids) => {
  const e = /** @type {any} */ (document.createElement(tag));
  for (const [k, v] of Object.entries(props)) k in e ? (e[k] = v) : e.setAttribute(k, v);
  e.append(...kids.filter(Boolean));
  return e;
};
const icon = d => { const s = document.createElementNS('http://www.w3.org/2000/svg', 'svg'); s.setAttribute('viewBox', '0 0 24 24'); s.setAttribute('aria-hidden', 'true'); s.innerHTML = d; return s; };
const MARK = { running: '●', done: '✓', failed: '✕', stale: '?' };
const tk = n => (n >= 1e6 ? (n / 1e6).toFixed(1) + 'M' : (n / 1e3).toFixed(1) + 'k');
const dur = ms => { const s = Math.max(0, Math.round(ms / 1000)); return s < 60 ? s + 's' : s < 3600 ? `${Math.floor(s / 60)}m${String(s % 60).padStart(2, '0')}s` : `${Math.floor(s / 3600)}h${String(Math.floor(s / 60) % 60).padStart(2, '0')}m`; };
const took = a => { const t0 = Date.parse(a.t0), t1 = a.state === 'running' ? Date.now() : Date.parse(a.t1); return t0 && t1 > t0 ? dur(t1 - t0) : ''; };
const clock = t => { const d = new Date(t); return isNaN(+d) ? '' : d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', hour12: false }); };
const rows = xs => xs.reduce((rs, x) => {
  const p = rs[rs.length - 1];
  if (x.k === 'tool' && p?.k === 'tool' && p.n === x.n && p.s === x.s) { p.c++; p.t = x.t; } else rs.push({ ...x, c: 1 });
  return rs;
}, []).reverse();

const STYLE = `
#ccflows{flex:none;display:inline-flex;align-items:center;gap:6px;height:28px;padding:0 10px;border:1px solid var(--c-line2);border-radius:8px;
background:var(--c-bg);color:var(--c-fg2);font:500 12px var(--c-mono);white-space:nowrap;cursor:pointer}
#ccflows[hidden],#wfpop[hidden],#wfrun[hidden]{display:none}
#ccflows.on{border-color:var(--c-ok-bd);background:var(--c-ok-bg);color:var(--c-ok)}
#ccflows svg{width:14px;height:14px;transform:rotate(-90deg)} #ccflows circle{fill:none;stroke-width:3.5}
#ccflows .bg{stroke:var(--c-line2)} #ccflows .rg{stroke:var(--c-ok)}
#wfpop{position:fixed;z-index:60;width:380px;max-height:min(70vh,560px);overflow:auto;box-sizing:border-box;padding:6px;background:var(--c-surface);
border:1px solid var(--c-line2);border-radius:10px;box-shadow:0 12px 32px rgba(0,0,0,.55);font:12px var(--c-sans);color:var(--c-fg)}
#wfpop section+section{border-top:1px solid var(--c-raised);margin-top:4px;padding-top:4px}
#wfpop .h{display:flex;align-items:center;gap:8px;padding:8px 10px 2px}
#wfpop .h b{flex:1;min-width:0;font:600 13px var(--c-sans);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
:is(#wfpop,#wfrun) small{font:11px var(--c-mono);color:var(--c-mut)}
.wfdot{width:6px;height:6px;border-radius:50%;background:var(--c-ok);flex:none}
.wfseg{display:flex;gap:3px;padding:8px 10px 6px} .wfseg i{flex:1;height:4px;border-radius:2px;background:var(--c-raised)}
.wfseg .ok{background:var(--c-ok)} .wfseg .on{background:var(--c-ok);opacity:.55}
#wfpop .ph{display:flex;justify-content:space-between;gap:8px;padding:0 10px 6px;color:var(--c-fg2)}
#wfpop button{display:flex;align-items:center;gap:8px;width:100%;min-height:30px;padding:0 10px;border:0;border-radius:6px;background:transparent;
color:var(--c-fg2);font:12px var(--c-mono);text-align:left;cursor:pointer}
#wfpop button:is(:hover,:focus-visible){background:var(--c-raised)}
#wfpop button span{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
#wfpop button.done,#wfpop button.failed{color:var(--c-mut)}
#wfpop .open{font:500 12px var(--c-sans);color:var(--c-fg)}
#wfpop .lb{padding:8px 10px 2px;font:600 11px var(--c-sans);letter-spacing:.04em;text-transform:uppercase;color:var(--c-mut)}
.wfm{width:12px;flex:none;text-align:center;font-style:normal;color:var(--c-mut)} .wfm.running,.wfm.done{color:var(--c-ok)} .wfm.failed{color:var(--c-bad)}
.wfm.stale{color:var(--c-warn)}
#wfrun{position:fixed;inset:0;z-index:65;display:flex;padding:24px;box-sizing:border-box;background:rgba(9,9,11,.82)}
#wfrun .pn{flex:1;max-width:1200px;margin:0 auto;display:flex;flex-direction:column;min-height:0;background:var(--c-surface);border:1px solid var(--c-raised);
border-radius:14px;box-shadow:0 24px 64px rgba(0,0,0,.6);overflow:hidden;font:13px var(--c-sans);color:var(--c-fg)}
#wfrun .hd{display:flex;align-items:flex-start;gap:12px;padding:16px 20px;border-bottom:1px solid var(--c-raised)}
#wfrun .hd>div{flex:1;min-width:0;display:flex;flex-direction:column;gap:4px} #wfrun .hd p{margin:0;font-size:12px;color:var(--c-mut)}
#wfrun .tt{display:flex;align-items:center;gap:10px} #wfrun .tt b{font:600 16px var(--c-sans)}
#wfrun .hd>small{padding-top:3px;font-size:12px}
.wfpill{display:inline-flex;align-items:center;height:20px;padding:0 8px;border-radius:999px;border:1px solid var(--c-ok-bd);background:var(--c-ok-bg);
color:var(--c-ok);font:500 11px var(--c-sans)}
.wfpill:is(.completed,.done){border-color:var(--c-line2);background:none;color:var(--c-mut)} .wfpill.failed{border-color:var(--c-bad);background:none;color:var(--c-bad)}
.wfpill.stale{border-color:var(--c-warn);background:none;color:var(--c-warn)}
#wfrun .x{width:30px;height:30px;flex:none;border:1px solid var(--c-line2);border-radius:8px;background:none;color:var(--c-mut);font-size:15px;cursor:pointer}
#wfrun .bd{flex:1;display:flex;min-height:0}
#wfrun nav{width:210px;flex:none;display:flex;flex-direction:column;gap:2px;padding:12px;border-right:1px solid var(--c-raised);overflow:auto}
#wfrun nav button{display:flex;align-items:center;gap:8px;min-height:30px;padding:0 8px;border:0;border-radius:6px;background:none;color:var(--c-mut);
font:12px var(--c-sans);text-align:left;cursor:pointer}
#wfrun nav button span{flex:1} #wfrun nav :is(.done,.failed){color:var(--c-fg2)} #wfrun nav .running{color:var(--c-fg);font-weight:600}
#wfrun nav .sel,#wfrun nav button:hover{background:var(--c-raised)}
#wfrun .tl{flex:1;min-width:0;display:flex;flex-direction:column;gap:6px;padding:16px 20px;overflow:auto}
#wfrun .ax{display:flex;justify-content:space-between;padding:0 0 4px 130px;font:11px var(--c-mono);color:var(--c-mut)}
#wfrun .tr{display:flex;align-items:center;gap:10px;padding:2px 0;border:0;background:none;color:var(--c-fg2);text-align:left;cursor:pointer}
#wfrun .tr .lb{width:120px;flex:none;font:12px var(--c-mono);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
#wfrun .tr .tk{position:relative;flex:1;height:22px}
#wfrun .bar{position:absolute;top:0;height:22px;min-width:6px;box-sizing:border-box;padding:0 8px;border-radius:4px;background:var(--c-raised);
border:1px solid var(--c-line2);font:11px/20px var(--c-mono);color:var(--c-fg2);white-space:nowrap;overflow:hidden}
#wfrun .bar:empty{padding:0}
#wfrun .out{position:absolute;top:0;font:11px/22px var(--c-mono);color:var(--c-mut);white-space:nowrap}
#wfrun .tr.running .bar{background:var(--c-ok-bg);border-color:var(--c-ok-bd);color:var(--c-ok)} #wfrun .tr.failed .bar{border-color:var(--c-bad);color:var(--c-bad)}
#wfrun .tr.sel .lb{color:var(--c-fg);font-weight:600} #wfrun .tr.sel .bar{box-shadow:0 0 0 1px var(--c-fg2)}
#wfrun .ft{display:flex;flex-wrap:wrap;gap:16px;margin-top:auto;padding-top:12px;border-top:1px solid var(--c-raised)}
#wfrun aside{width:360px;flex:none;display:flex;flex-direction:column;gap:8px;padding:16px;border-left:1px solid var(--c-raised);background:var(--c-bg);overflow:auto}
#wfrun .solo aside{width:auto;flex:1;border:0}
#wfrun .ah{display:flex;align-items:center;gap:8px} #wfrun .ah b{flex:1;min-width:0;font:600 13px var(--c-mono);overflow-wrap:anywhere}
#wfrun h3{margin:8px 0 0;font:600 11px var(--c-sans);letter-spacing:.04em;text-transform:uppercase;color:var(--c-mut)}
#wfrun aside ol{margin:0;padding:0;list-style:none;display:flex;flex-direction:column;gap:8px;font:12px/1.5 var(--c-mono)}
#wfrun aside li{display:flex;gap:8px} #wfrun aside li small{width:40px;flex:none}
#wfrun aside li p{margin:0;min-width:0;overflow-wrap:anywhere;white-space:pre-wrap;color:var(--c-fg2)} #wfrun aside li.say p{font-family:var(--c-sans);color:var(--c-mut)}
#wfrun aside pre{margin:0;white-space:pre-wrap;overflow-wrap:anywhere;font:12px/1.5 var(--c-mono);color:var(--c-fg2)} #wfrun aside pre.failed{color:var(--c-bad)}
#wfrun aside>p{margin:0;font-size:12px;color:var(--c-mut)}
@media (max-width:900px){#wfrun nav{display:none} #wfrun aside{width:280px}}
`;

/** a run's phases in order: the script's, then any an agent names that the script did not (a script whose phases could not be read) */
const phasesOf = r => [...new Set([...r.phases, ...r.agents.map(a => a.phase)])];
/** a phase's state from its agents: wait, running, failed or done */
const phState = as => (!as.length ? 'wait' : as.some(a => a.state === 'running') ? 'running' : as.some(a => a.state === 'failed') ? 'failed' : 'done');
const mark = s => el('i', { className: 'wfm ' + s }, MARK[s] || '·');
/** running ones first, then the newest */
/** a repaint every poll keeps the focused control (a keyboard user's place) by its data attribute */
const keepFocus = (box, paint) => {
  const f = /** @type {HTMLElement | null} */ (box.contains(document.activeElement) ? document.activeElement : null);
  const k = f && ['data-id', 'data-ph', 'data-run'].find(a => f.hasAttribute(a)), v = k ? f.getAttribute(k) : null, cls = f?.className.split(' ')[0];
  paint();
  if (k) /** @type {HTMLElement | null} */ (box.querySelector(`.${CSS.escape(cls || 'x')}[${k}="${CSS.escape(v || '')}"]`) || box.querySelector(`[${k}="${CSS.escape(v || '')}"]`))?.focus();
  else if (f?.classList.contains('x')) /** @type {HTMLElement | null} */ (box.querySelector('.x'))?.focus();
};
const order = as => [...as].sort((x, y) => (y.state === 'running') - (x.state === 'running') || (Date.parse(y.t0) || 0) - (Date.parse(x.t0) || 0));

/** @param {{ on: (fn: (d: any) => void) => void, url: string }} wf flows.mjs; the chip goes after Claude's agents chip, in the composer's bar */
export function deskFlows(wf) {
  document.head.append(el('style', {}, STYLE));
  const ring = icon('<circle class="bg" cx="12" cy="12" r="9"/><circle class="rg" cx="12" cy="12" r="9" stroke-dasharray="0 57"/>');
  const label = el('span');
  const chip = el('button', { type: 'button', id: 'ccflows', hidden: true, 'aria-haspopup': 'dialog', 'aria-expanded': 'false' }, ring, label);
  const pop = el('div', { id: 'wfpop', role: 'dialog', 'aria-label': 'Running workflows', hidden: true });
  const view = el('div', { id: 'wfrun', hidden: true });
  document.getElementById('ccagents')?.after(chip);
  document.body.append(pop, view);
  let d = { runs: [], agents: [] };
  /** @type {{ run: string, id: string, ph: string } | null} */ let at = null; // the full view: its run ('' a subagent), its agent, a phase filter
  /** @type {any} */ let log = null; let logId = '', aside = el('aside');

  const live = () => d.runs.filter(r => r.status === 'running'), busy = () => d.agents.filter(a => a.state === 'running');
  const runOf = id => d.runs.find(r => r.id === id);
  const fig = r => { const ps = phasesOf(r), i = ps.indexOf(r.phase), done = r.agents.filter(a => a.state !== 'running').length; return ps.length > 1 && i >= 0 ? { n: ps.length, i, txt: `${i + 1}/${ps.length}`, f: (i + 1) / ps.length } : { n: 0, i, txt: `${done}/${r.agents.length}`, f: r.agents.length ? done / r.agents.length : 0 }; };

  const paintChip = () => {
    const L = live(), B = busy();
    chip.hidden = !L.length && !B.length;
    if (chip.hidden) return closePop();
    const one = L.length === 1 ? fig(L[0]) : null;
    label.textContent = one ? one.txt : L.length ? `${L.length} runs` : `${B.length} subagent${B.length > 1 ? 's' : ''}`;
    ring.querySelector('.rg')?.setAttribute('stroke-dasharray', `${(57 * (one ? one.f : 0.25)).toFixed(1)} 57`);
    chip.classList.toggle('on', !pop.hidden);
    chip.setAttribute('aria-label', one ? `Workflow ${L[0].name}: ${one.n ? `phase ${one.i + 1} of ${one.n}` : `${one.txt} agents done`}` : label.textContent + ' running');
  };

  // B: the popover over the chip
  const agentBtn = (a, run) => el('button', { type: 'button', className: a.state, 'data-run': run, 'data-id': a.id }, mark(a.state), el('span', {}, a.label),
    el('small', {}, [a.tok ? tk(a.tok) : '', took(a)].filter(Boolean).join(' · ')));
  const paintPop = () => { if (!pop.hidden) keepFocus(pop, drawPop); };
  const drawPop = () => {
    const B = busy();
    pop.replaceChildren(...live().map(r => {
      const ps = phasesOf(r), f = fig(r);
      return el('section', {},
        el('div', { className: 'h' }, el('i', { className: 'wfdot' }), el('b', {}, r.name), el('small', {}, dur(Date.now() - r.start))),
        f.n ? el('div', { className: 'wfseg', 'aria-hidden': 'true' }, ...ps.map((_, i) => el('i', { className: i < f.i ? 'ok' : i === f.i ? 'on' : '' }))) : null,
        el('div', { className: 'ph' }, el('span', {}, r.phase || 'starting'), el('small', {}, f.n ? `phase ${f.txt}` : `${f.txt} agents`)),
        ...order(r.agents).slice(0, 6).map(a => agentBtn(a, r.id)),
        el('button', { type: 'button', className: 'open', 'data-run': r.id }, el('span', {}, 'Open run'), '→'));
    }), B.length ? el('section', {}, el('div', { className: 'lb' }, 'Subagents'),
      ...B.map(a => el('button', { type: 'button', className: a.state, 'data-run': '', 'data-id': a.id, title: a.desc }, mark(a.state), el('span', {}, a.label + (a.doing ? ' · ' + a.doing : ''))))) : '');
    const c = chip.getBoundingClientRect();
    pop.style.left = Math.max(8, Math.min(c.left, innerWidth - pop.offsetWidth - 8)) + 'px';
    pop.style.bottom = innerHeight - c.top + 8 + 'px';
  };
  const openPop = () => { pop.hidden = false; chip.setAttribute('aria-expanded', 'true'); paintPop(); paintChip(); pop.querySelector('button')?.focus(); };
  function closePop() { if (pop.hidden) return; pop.hidden = true; chip.setAttribute('aria-expanded', 'false'); chip.classList.remove('on'); }
  chip.addEventListener('click', () => (pop.hidden ? openPop() : closePop()));
  pop.addEventListener('click', e => {
    const b = /** @type {HTMLElement | null} */ (/** @type {HTMLElement} */ (e.target).closest('button[data-run]'));
    if (b) openRun(b.dataset.run || '', b.dataset.id || '');
  });
  document.addEventListener('pointerdown', e => { const t = /** @type {Node} */ (e.target); if (!pop.hidden && !pop.contains(t) && !chip.contains(t)) closePop(); });

  // D: the full view of a run (or of one subagent)
  const more = () => { const id = at?.id, run = at?.run || ''; if (!id) return; fetch(`${wf.url}&agent=${encodeURIComponent(id)}${run ? '&run=' + encodeURIComponent(run) : ''}`)
    .then(r => (r.ok ? r.json() : null)).then(j => { if (j && at?.id === id) { log = j.agent || { steps: [], result: '' }; logId = id; paintAside(); } }, () => {}); };
  const agentOf = () => (at?.run ? runOf(at.run)?.agents : d.agents)?.find(a => a.id === at?.id);
  function paintAside() {
    const a = agentOf(), L = logId === at?.id ? log : null, keep = aside.scrollTop;
    if (!a) { aside.replaceChildren(el('p', {}, at?.run ? 'Pick an agent in the timeline.' : 'This agent is no longer listed.')); return; }
    const t0 = L?.t0 || a.t0, end = a.state === 'running' ? Date.now() : Date.parse(a.t1 || L?.steps.at(-1)?.t || '');
    aside.replaceChildren(
      el('div', { className: 'ah' }, mark(a.state), el('b', {}, a.label), el('small', {}, a.model || '')),
      el('small', {}, [t0 ? 'started ' + clock(t0) : '', t0 && end > Date.parse(t0) ? dur(end - Date.parse(t0)) : '', a.tok ? tk(a.tok) + ' tokens' : ''].filter(Boolean).join(' · ')),
      el('h3', {}, 'What it did, newest first'),
      !L ? el('p', {}, 'Loading…') : L.steps.length ? el('ol', {}, ...rows(L.steps).map((x, i, xs) => el('li', { className: x.k },
        el('small', {}, i && clock(xs[i - 1].t) === clock(x.t) ? '' : clock(x.t)),
        x.k === 'say' ? el('p', {}, x.s) : el('p', {}, el('b', {}, x.n), x.s ? ' ' + x.s : '', x.c > 1 ? ' ×' + x.c : '')))) : el('p', {}, 'Nothing yet.'),
      el('h3', {}, 'Result'),
      L?.result ? el('pre', { className: L.failed ? 'failed' : '' }, L.result) : el('p', {}, a.state === 'running' ? 'Shown here once it ends.' : 'None.'));
    aside.scrollTop = keep;
  }
  const paintView = () => { if (view.hidden || !at) return; const keep = aside.scrollTop; keepFocus(view, drawView); aside.scrollTop = keep; };
  const drawView = () => {
    if (!at) return;
    const r = at.run ? runOf(at.run) : null, a = agentOf();
    if (at.run && !r) { view.replaceChildren(panel('Run ended', '', '', '', el('div', { className: 'bd' }, el('div', { className: 'tl' }, el('p', {}, 'This run is no longer in the feed.'))))); return; }
    if (!r) { paintAside(); view.replaceChildren(panel(a?.label || 'Subagent', a?.state || '', a?.desc || '', '', el('div', { className: 'bd solo' }, aside))); return; }
    const ps = phasesOf(r), f = fig(r), now = Date.now();
    const end = r.status === 'running' ? now : Math.max(r.last, ...r.agents.map(x => Date.parse(x.t1) || 0)), span = Math.max(1, end - r.start);
    const pct = t => Math.max(0, Math.min(100, ((t - r.start) / span) * 100));
    const shown = at.ph ? r.agents.filter(x => x.phase === at.ph) : r.agents, tok = r.tokens || r.agents.reduce((s, x) => s + (x.tok || 0), 0);
    const nav = el('nav', { 'aria-label': 'Phases' }, ...ps.map((p, i) => {
      const as = r.agents.filter(x => x.phase === p), st = phState(as);
      return el('button', { type: 'button', className: st + (at?.ph === p ? ' sel' : ''), 'data-ph': p, 'aria-pressed': String(at?.ph === p) },
        st === 'wait' ? el('i', { className: 'wfm' }, String(i + 1)) : mark(st), el('span', {}, p), as.length ? el('small', {}, `${as.filter(x => x.state === 'done').length}/${as.length}`) : null);
    }));
    const tl = el('section', { className: 'tl', 'aria-label': 'Timeline' },
      el('div', { className: 'ax' }, ...[0, 1, 2, 3, 4].map(k => el('span', {}, k === 4 && r.status === 'running' ? 'now' : clock(r.start + (span * k) / 4)))),
      ...shown.map(x => {
        const t0 = Date.parse(x.t0) || r.start, t1 = x.state === 'running' ? now : Date.parse(x.t1) || t0, l = pct(t0);
        const w = Math.max(0.5, pct(t1) - l), txt = [took(x), x.tok ? tk(x.tok) : ''].filter(Boolean).join(' · ');
        // a short bar cannot hold its figures: they go just past its end
        const bar = el('span', { className: 'bar' }, w >= 18 ? txt : ''), out = w < 18 && txt ? el('span', { className: 'out' }, txt) : null;
        bar.style.left = l + '%'; bar.style.width = w + '%';
        if (out) out.style.left = `calc(${l}% + max(${w}%, 6px) + 6px)`;
        return el('button', { type: 'button', className: 'tr ' + x.state + (x.id === at?.id ? ' sel' : ''), 'data-id': x.id, 'aria-pressed': String(x.id === at?.id) },
          el('span', { className: 'lb' }, x.label), el('span', { className: 'tk' }, bar, out));
      }),
      el('div', { className: 'ft' }, ...[[...new Set(r.agents.map(x => x.model).filter(Boolean))].join(', '), `${r.agents.filter(x => x.state !== 'running').length} of ${r.agents.length} agents done`,
        f.n ? `phase ${f.i + 1} of ${f.n}` : ''].filter(Boolean).map(t => el('small', {}, t))));
    paintAside();
    view.replaceChildren(panel(r.name, r.status, r.desc, [dur(span), tok ? tk(tok) + ' tokens' : ''].filter(Boolean).join(' · '), el('div', { className: 'bd' }, nav, tl, aside)));
  };
  const panel = (title, status, desc, figs, body) => el('div', { className: 'pn', role: 'dialog', 'aria-modal': 'true', 'aria-label': title },
    el('div', { className: 'hd' }, el('div', {}, el('div', { className: 'tt' }, el('b', {}, title), status ? el('span', { className: 'wfpill ' + status }, status) : null), desc ? el('p', {}, desc) : null),
      figs ? el('small', {}, figs) : null, el('button', { type: 'button', className: 'x', 'aria-label': 'Close' }, '×')), body);
  function openRun(run, id) {
    const r = run ? runOf(run) : null;
    closePop();
    at = { run, id: id || (r ? order(r.agents)[0]?.id || '' : ''), ph: '' }; log = null; logId = '';
    view.hidden = false; aside = el('aside', { 'aria-label': 'Agent' }); paintView(); more();
    /** @type {HTMLElement | null} */ (view.querySelector('.x'))?.focus();
  }
  const closeView = () => { if (view.hidden) return; view.hidden = true; at = null; view.replaceChildren(); if (!chip.hidden) chip.focus(); };
  view.addEventListener('click', e => {
    const t = /** @type {HTMLElement} */ (e.target);
    if (t === view || t.closest('.x')) return closeView();
    const row = /** @type {HTMLElement | null} */ (t.closest('.tr[data-id]')), ph = /** @type {HTMLElement | null} */ (t.closest('nav button[data-ph]'));
    if (row && at && row.dataset.id !== at.id) { at.id = row.dataset.id || ''; log = null; paintView(); more(); }
    if (ph && at) { at.ph = at.ph === ph.dataset.ph ? '' : ph.dataset.ph || ''; paintView(); }
  });
  // Esc: the view, else the popover; caught before the composer's field, whose Esc would interrupt Claude
  addEventListener('keydown', e => {
    if (e.key !== 'Escape' || (view.hidden && pop.hidden)) return;
    e.preventDefault(); e.stopPropagation();
    if (!view.hidden) closeView(); else { closePop(); chip.focus(); }
  }, true);

  wf.on(x => {
    d = x; paintChip(); paintPop();
    if (!view.hidden) { paintView(); if (agentOf()?.state === 'running' || !log) more(); }
  });
  return { chip, pop, view };
}
