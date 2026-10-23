// strip.mjs — the strip across the top (MAP 4.2 B-75; ledger K-23, B-12; replaced the session pill and its sheet 2026-10-23): back, one tab per
// live session with its fleet state (working, needs you, paused, idle: /app/live.json's `state`, the same classifier the push uses), new
// session, the menu. Touch only (a desktop browser uses one window per session).
// ?arg= carries the tab id (args[2], 8 hex, minted by /app or a dashboard link; web-term.sh wrote this tab's tty under it) and, for `attach`,
// the session. Tapping a tab POSTs /a/switch (tmux switch-client on this tab's client): the terminal repaints in place, no reload, no second
// websocket. A refusal or no tab id falls back to ONE reload into attach with a minted tab id, never a dead end. The list is polled every
// 5 s, on visibilitychange and after a switch.
import { coarse, el, icon, key } from './dom.mjs';

const BACK = '<path d="M15 18l-6-6 6-6" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>';
const DOTS = '<circle cx="5" cy="12" r="1.8" fill="currentColor"/><circle cx="12" cy="12" r="1.8" fill="currentColor"/><circle cx="19" cy="12" r="1.8" fill="currentColor"/>';
const WORD = { 'needs-you': 'needs you', working: 'working', paused: 'paused', idle: 'idle' };

export function strip(/** @type {() => void} */ openMenu) {
  if (!coarse()) return null;
  const args = new URLSearchParams(location.search).getAll('arg');
  const TAB = /^[0-9a-f]{8}$/.test(args[2] || '') ? args[2] : '';
  let cur = args[0] === 'attach' ? args[1] || '' : '', list = [];
  const mint = () => [...crypto.getRandomValues(new Uint8Array(4))].map(b => b.toString(16).padStart(2, '0')).join('');
  const go = (kind, to) => { location.href = `/term/?arg=${kind}&arg=${encodeURIComponent(to)}&arg=${TAB || mint()}&v=3`; };
  const fallback = to => go(/^[0-9a-f]{8}$/.test(to) ? 'open' : 'attach', to);
  const short = n => n.replace(/^cc-[^-]+-/, '').replace(/^web-/, '');
  const label = s => s.label || short(s.name);

  const back = key('', () => { location.href = '/'; });
  back.id = 'ccback'; back.className = 'ib'; back.append(icon(BACK)); back.setAttribute('aria-label', 'all sessions');
  const more = el('button', { type: 'button', id: 'ccmenu-btn', className: 'ib', 'aria-label': 'terminal actions' }, icon(DOTS));
  more.addEventListener('click', openMenu);
  const tabs = el('nav', { id: 'cctabs', 'aria-label': 'live sessions' });
  const bar = el('header', { id: 'ccstrip' }, back, tabs, more);

  const render = () => {
    tabs.textContent = '';
    const shown = list.length || !cur ? list : [{ name: cur, label: '', state: 'idle' }];
    for (const s of shown) {
      const on = s.name === cur, st = s.state || 'idle';
      const b = el('button', { type: 'button', className: `tab s-${st}`, 'aria-current': String(on) },
        el('span', { className: 'dot', 'aria-hidden': 'true' }), el('span', { className: 'nm' }, label(s)),
        on || st === 'needs-you' ? el('span', { className: 'st' }, WORD[st] || st) : null);
      b.dataset.s = s.name;
      b.title = s.name;
      b.addEventListener('click', () => pick(s.name));
      tabs.append(b);
    }
    const add = el('button', { type: 'button', className: 'tab new', 'aria-label': 'new session', textContent: '＋' });
    add.addEventListener('click', () => { location.href = '/term/?v=3'; });
    tabs.append(add);
    tabs.querySelector('[aria-current="true"]')?.scrollIntoView?.({ inline: 'nearest', block: 'nearest' });
  };
  const pick = to => {
    if (to === cur) return;
    if (!TAB) { go('attach', to); return; } // the menu page has no tab id: one reload, persistent from then on
    fetch('/a/switch', { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ tab: TAB, to }) })
      .then(r => { if (r.ok) { cur = to; render(); poll(); } else fallback(to); }, () => fallback(to));
  };
  function poll() {
    if (document.visibilityState !== 'visible') return;
    fetch('/app/live.json?tab=' + (TAB || '00000000')).then(r => r.json()).then(l => {
      list = l;
      const c = l.find(s => s.current);
      if (c) cur = c.name;
      render();
    }).catch(() => {});
  }
  render(); poll(); setInterval(poll, 5000); document.addEventListener('visibilitychange', poll);
  return { el: bar, cur: () => (cur ? { name: cur, label: label(list.find(s => s.name === cur) || { name: cur, label: '' }) } : null) };
}
