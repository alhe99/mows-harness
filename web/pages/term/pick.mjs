// pick.mjs — Claude's pickers (/model and the like: claudePicker in claudebox.mjs) as a sheet in the page's own look, over Claude's drawing
// of them (the phone, 2026-10-24: the /model list in the terminal read badly). It holds nothing of its own: every scan hands it what Claude
// shows, and it answers with Claude's keys. A picker with keys of its own besides Enter and Esc (/model: `s to use this session only`): a tap
// moves Claude's highlight (arrows) and the sheet's buttons are those keys. Any other: a tap answers (the number, as typed in the terminal).
// The window of the list: a row past either end moves the highlight past it, and Claude scrolls. Esc (Cancel, the backdrop) closes it.
import { el, icon } from './dom.mjs';

const KEYS = { Enter: '\r', Esc: '\x1b', Tab: '\t', Space: ' ' }, UP = '\x1b[A', DN = '\x1b[B';
const CHECK = '<path d="M5 12.5l4.5 4.5L19 7.5" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"/>';
const keyOf = k => KEYS[k] ?? (/^[a-z0-9]$/i.test(k) ? k : ''); // a letter is typed; an arrow named in a hint (`↓ to select`) is not a key here
const cap = s => s.charAt(0).toUpperCase() + s.slice(1);

/** @param {import('@xterm/xterm').Terminal} term */
export function picker(term) {
  const pan = el('div', { className: 'pan', role: 'dialog' }), wrap = el('div', { id: 'ccpick' }, pan);
  /** @type {any} */ let p = null;
  let shown = '';
  const press = k => { const s = p && p.keys.some(x => x.key === k) ? keyOf(k) : ''; if (s) term.input(s); };
  wrap.addEventListener('click', e => { if (e.target === wrap) press('Esc'); });
  document.body.append(wrap);
  const btn = (cls, label, fn, kids = []) => { const b = el('button', { type: 'button', className: cls }, label, ...kids); b.addEventListener('click', fn); return b; };

  /** what Claude shows now; null closes the sheet */
  function show(/** @type {any} */ next) {
    const k = next ? JSON.stringify(next) : '';
    if (k === shown) return;
    shown = k; p = next;
    if (!p) { wrap.classList.remove('open'); return; }
    if (!wrap.classList.contains('open')) /** @type {any} */ (document.activeElement)?.blur?.(); // the keyboard down: the sheet is the input
    const old = pan.querySelector('.opts'), scroll = old ? old.scrollTop : -1;
    const at = p.opts.find(o => o.on) || p.opts[0], first = p.opts[0], last = p.opts.at(-1);
    const move = n => term.input((n > at.n ? DN : UP).repeat(Math.abs(n - at.n)));
    const own = p.keys.some(x => x.key !== 'Enter' && x.key !== 'Esc' && keyOf(x.key));
    const opts = el('div', { className: 'opts', role: 'listbox', 'aria-label': p.title });
    if (first.up) opts.append(btn('more', 'Show earlier', () => move(first.n - 1)));
    for (const o of p.opts) {
      const b = btn('opt' + (o.on ? ' on' : '') + (o.cur ? ' cur' : ''), '', () => {
        if (own) { for (const x of opts.querySelectorAll('.opt')) x.classList.toggle('on', x === b); move(o.n); return; }
        if (o.n <= 9) term.input(String(o.n)); else { move(o.n); setTimeout(() => term.input('\r'), 60); }
      }, [el('span', { className: 'ol' }, o.label), o.desc ? el('span', { className: 'od' }, o.desc) : null, o.cur ? icon(CHECK) : null]);
      b.setAttribute('role', 'option'); b.setAttribute('aria-selected', String(o.on));
      opts.append(b);
    }
    if (last.down || p.more) opts.append(btn('more', ['Show', /^\+(\d+)/.exec(p.more)?.[1], 'more'].filter(Boolean).join(' '), () => move(last.n + 1)));
    const esc = p.keys.some(x => x.key === 'Esc');
    const acts = own ? p.keys.filter(x => x.key !== 'Esc' && keyOf(x.key)).sort((a, b) => +(a.key === 'Enter') - +(b.key === 'Enter'))
      .map(x => btn(x.key === 'Enter' ? 'pri' : '', cap(x.label), () => press(x.key))) : [];
    pan.setAttribute('aria-label', p.title);
    pan.replaceChildren(
      el('div', { className: 'grab' }),
      el('div', { className: 'hd' }, el('b', {}, p.title), esc ? btn('', 'Cancel', () => press('Esc')) : null),
      p.text ? el('p', { className: 'tx' }, p.text) : null,
      opts,
      p.adjust ? el('div', { className: 'adj' }, btn('', '‹', () => term.input('\x1b[D')), el('span', {}, p.adjust), btn('', '›', () => term.input('\x1b[C'))) : null,
      acts.length ? el('div', { className: 'acts' }, ...acts) : null);
    pan.querySelector('.adj button')?.setAttribute('aria-label', 'less');
    pan.querySelector('.adj button:last-child')?.setAttribute('aria-label', 'more');
    wrap.classList.add('open');
    // the list where it was, its highlighted row in view (on opening, or moved past the window)
    if (scroll >= 0) opts.scrollTop = scroll;
    opts.querySelector('.on')?.scrollIntoView({ block: 'nearest' });
  }
  return { show };
}
