// menu.mjs — the actions sheet behind the strip's ⋯ (2026-10-23): what the old key bar carried that is not a key. Copy text (the overlay),
// paste, attach a file; text size; the terminal theme; detach from tmux; restart the pane (two taps: whatever runs is killed); all sessions.
// Touch only. The backdrop or a chosen action closes it.
import { el, icon, say } from './dom.mjs';

const I = {
  copy: '<rect x="9" y="9" width="12" height="12" rx="2"/><path d="M5 15V5a2 2 0 0 1 2-2h10"/>',
  paste: '<rect x="6" y="4" width="12" height="17" rx="2"/><path d="M9 4V3h6v1"/>',
  attach: '<path d="M21 11.5l-8.6 8.6a5 5 0 0 1-7.1-7.1l8.6-8.6a3.4 3.4 0 0 1 4.8 4.8l-8.6 8.6a1.7 1.7 0 0 1-2.4-2.4l7.9-7.9"/>',
};
const ic = d => { const s = icon(d); s.setAttribute('fill', 'none'); s.setAttribute('stroke', 'currentColor'); s.setAttribute('stroke-width', '1.8'); s.setAttribute('stroke-linecap', 'round'); s.setAttribute('stroke-linejoin', 'round'); return s; };

/** @param {{ clip: any, att: { pick: () => void }, fonts: any, theme: any, detach: () => void, restart: () => void, title: () => { name: string, label: string } | null }} o */
export function menu({ clip, att, fonts, theme, detach, restart, title }) {
  const name = el('b'), sub = el('span');
  const tile = (d, label, fn) => { const b = el('button', { type: 'button', className: 'tile' }, ic(d), label); b.addEventListener('click', () => { close(); fn(); }); return b; };
  const row = (label, fn, cls = '', extra = null) => { const b = el('button', { type: 'button', className: 'ln ' + cls }, el('span', {}, label), extra); b.addEventListener('click', () => fn(b)); return b; };
  let armed = 0;
  const RESTART = 'Restart this pane';
  const restartRow = row(RESTART, b => {
    if (Date.now() - armed < 3000) { armed = 0; b.firstChild.textContent = RESTART; close(); restart(); say('restarting the pane'); return; }
    armed = Date.now(); b.firstChild.textContent = 'Tap again: the running program is killed';
    setTimeout(() => { if (armed && Date.now() - armed >= 3000) { armed = 0; b.firstChild.textContent = RESTART; } }, 3100);
  }, 'danger');
  fonts.down.setAttribute('aria-label', 'smaller text'); fonts.up.setAttribute('aria-label', 'larger text');
  const pan = el('div', { className: 'pan', role: 'dialog', 'aria-label': 'terminal actions' },
    el('div', { className: 'grab' }),
    el('div', { className: 'hd' }, name, sub),
    el('div', { className: 'tiles' },
      clip ? tile(I.copy, 'Copy text', clip.open) : null,
      clip ? tile(I.paste, 'Paste', clip.paste) : null,
      tile(I.attach, 'Attach file', att.pick)),
    el('div', { className: 'ln' }, el('span', {}, 'Text size'), el('span', { className: 'step' }, fonts.down, fonts.span, fonts.up)),
    theme.select ? el('div', { className: 'ln' }, el('label', { htmlFor: 'ccthemesel' }, 'Theme'), theme.select) : null,
    row('Detach from tmux', () => { close(); detach(); }, '', el('small', {}, '^Q d')),
    restartRow,
    row('All sessions', () => { location.href = '/'; }, '', el('small', {}, '›')));
  const sheet = el('div', { id: 'ccsheet' }, pan);
  sheet.addEventListener('click', e => { if (e.target === sheet) close(); });
  const open = () => {
    const t = title();
    name.textContent = t ? t.label || t.name : 'terminal'; sub.textContent = t ? 'tmux ' + t.name : '';
    armed = 0; restartRow.firstChild.textContent = RESTART;
    sheet.classList.add('open');
  };
  const close = () => sheet.classList.remove('open');
  document.body.append(sheet);
  return { open, close };
}
