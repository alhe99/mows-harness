// sess.mjs — the session pill and its bottom sheet (MAP 4.2 B-75; ledger K-23, B-12). Touch only (a desktop browser uses one window per session).
// ?arg= carries the tab id (args[2], 8 hex, minted by /app or a dashboard link; web-term.sh wrote this tab's tty under it) and, for `attach`,
// the session. The pill shows the current session. Choosing a row POSTs /a/switch (tmux switch-client on this tab's client): the terminal
// repaints in place, no reload, no second websocket. A refusal or no tab id falls back to ONE reload into attach with a minted tab id, never
// a dead end. "new session" -> /term/?v=3, "all sessions" -> / (a plain navigation). The list is /app/live.json, polled every 10 s, on open
// and on visibilitychange.
import { coarse, el } from './dom.mjs';

export function sessions() {
  if (!coarse()) return null;
  const args = new URLSearchParams(location.search).getAll('arg');
  const TAB = /^[0-9a-f]{8}$/.test(args[2] || '') ? args[2] : '';
  let cur = args[0] === 'attach' ? args[1] || '' : '', list = [];
  const mint = () => [...crypto.getRandomValues(new Uint8Array(4))].map(b => b.toString(16).padStart(2, '0')).join('');
  const go = (kind, to) => { location.href = `/term/?arg=${kind}&arg=${encodeURIComponent(to)}&arg=${TAB || mint()}&v=3`; };
  const fallback = to => go(/^[0-9a-f]{8}$/.test(to) ? 'open' : 'attach', to);
  const short = n => n.replace(/^cc-[^-]+-/, '').replace(/^web-/, '');
  const label = s => s.label || short(s.name);

  const pill = el('button', { type: 'button', id: 'ccsess-pill', textContent: cur ? short(cur) : 'sessions' });
  const pan = el('div', { className: 'pan' });
  const sheet = el('div', { id: 'ccsheet' }, pan);
  sheet.addEventListener('click', e => { if (e.target === sheet) close(); });
  const row = (txt, sub, cls, fn) => {
    const nm = el('span', { className: 'nm' }, txt, ...(sub ? [el('small', {}, sub)] : []));
    const r = el('div', { className: 'row' + (cls ? ' ' + cls : ''), role: 'button' }, nm);
    r.addEventListener('click', fn);
    return r;
  };
  const render = () => {
    pan.textContent = '';
    pan.append(el('div', { className: 'hd' }, 'live sessions'));
    if (!list.length) pan.append(row('none running', '', 'act', close));
    for (const s of list) pan.append(row(label(s), s.label ? s.name : '', s.name === cur ? 'on' : '', () => pick(s.name)));
    pan.append(el('div', { className: 'sep' }), row('＋  new session', '', 'act', () => { location.href = '/term/?v=3'; }),
      row('all sessions, system, settings  ›', '', 'act', () => { location.href = '/'; }));
  };
  const open = () => { render(); sheet.classList.add('open'); poll(); };
  const close = () => sheet.classList.remove('open');
  const pick = to => {
    close();
    if (to === cur) return;
    if (!TAB) { go('attach', to); return; } // the menu page has no tab id: one reload, persistent from then on
    fetch('/a/switch', { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ tab: TAB, to }) })
      .then(r => { if (r.ok) { cur = to; pill.textContent = label(list.find(s => s.name === to) || { name: to }); poll(); } else fallback(to); }, () => fallback(to));
  };
  function poll() {
    if (document.visibilityState !== 'visible') return;
    fetch('/app/live.json?tab=' + (TAB || '00000000')).then(r => r.json()).then(l => {
      list = l;
      const c = l.find(s => s.current);
      if (c) cur = c.name;
      const me = l.find(s => s.name === cur);
      pill.textContent = me ? label(me) : cur ? short(cur) : 'sessions';
      if (sheet.classList.contains('open')) render();
    }).catch(() => {});
  }
  pill.addEventListener('click', open); // a plain click: the keyboard may close, choosing a session is a break from typing anyway
  document.body.append(sheet);
  poll(); setInterval(poll, 10000); document.addEventListener('visibilitychange', poll);
  return pill;
}
