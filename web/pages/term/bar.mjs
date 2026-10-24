// bar.mjs — the key bar #cckb (MAP 4.2 B-10, B-20, B-30, B-45): the keys a phone keyboard lacks, touch scroll, the keyboard-aware fit. Two rows of
// seven: the main row always, the second behind the chevron. Every key goes through term.input()/term.paste() (public API), so the bytes on the
// wire are what term-check.mjs's `proto` mode asserts. Ctrl and Alt latch: one tap applies to the next key typed (the phone keyboard, the
// composer, an arrow), a second tap within 350 ms locks, a tap on a set latch clears it. The rest of the old bar (copy, paste, attach, size,
// theme, restart, detach, all sessions) lives in the menu sheet (menu.mjs), opened by the bar's first key ⋯. No session switching on a phone
// (the owner never used it: the pill, then the strip, are gone). The keys that type text (⇧⏎, /) type into the composer while it has the focus:
// the phone keyboard has no shift+return, so ⇧⏎ is the field's line break. 2026-10-23
import { el, icon, key, store } from './dom.mjs';

const DOTS = '<circle cx="5" cy="12" r="1.8" fill="currentColor"/><circle cx="12" cy="12" r="1.8" fill="currentColor"/><circle cx="19" cy="12" r="1.8" fill="currentColor"/>';

const CHEV = '<path d="M6 15l6-6 6 6" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>';
// the second row first in the DOM: the grid draws it above the main row
const MORE = { '^C': '^c', Alt: 'alt', LT: '←', RT: '→', PgUp: 'pg↑', PgDn: 'pg↓', NL: '⇧⏎', Slash: '/' };
const MAIN = { Menu: '', Esc: 'esc', 'S-Tab': '⇧tab', Tab: 'tab', Ctrl: 'ctrl', UP: '↑', DN: '↓', More: '' };
const ARROW = { UP: 'A', DN: 'B', RT: 'C', LT: 'D' };
const SEQ = { Esc: '\x1b', Tab: '\t', 'S-Tab': '\x1b[Z', '^C': '\x03' };

/** wheel notches on the screen: tmux and Claude Code read them as scrolling through mouse reporting */
const wheel = (dir, n = 1) => {
  const s = document.querySelector('.xterm-screen') || document.querySelector('.xterm');
  if (s) for (let i = 0; i < n; i++) s.dispatchEvent(new WheelEvent('wheel', { deltaY: dir * 57, deltaMode: 0, bubbles: true, cancelable: true }));
};

/** the latches: 'off' | 'armed' (the next key) | 'locked' */
export const mods = { Ctrl: 'off', Alt: 'off' };
const listeners = new Set();
const changed = () => listeners.forEach(f => f());
export const onMods = f => listeners.add(f);
const latched = () => mods.Ctrl !== 'off' || mods.Alt !== 'off';
const spend = () => { let c = false; for (const k in mods) if (mods[k] === 'armed') { mods[k] = 'off'; c = true; } if (c) changed(); };
/** one typed character through the latches: ctrl maps the letters and the symbols from at-sign to underscore onto C0 (space -> NUL, ? -> DEL), alt prefixes ESC. More than one character
 *  (a suggestion, a paste) passes as it is, and still spends a one-shot latch. */
export function latch(d) {
  if (!latched()) return d;
  let out = d;
  if ([...d].length === 1) {
    if (mods.Ctrl !== 'off') { const c = d.toUpperCase().charCodeAt(0); out = d === ' ' ? '\x00' : d === '?' ? '\x7f' : c >= 64 && c <= 95 ? String.fromCharCode(c - 64) : d; }
    if (mods.Alt !== 'off') out = '\x1b' + out;
  }
  spend();
  return out;
}

/** the keys of #cckb, the second row first. `typing()`: the composer holds the focus (a key must not take it away); `type(s)`: puts text in it;
 *  `menu()`: opens the menu sheet */
/** @param {import('@xterm/xterm').Terminal} term @param {{ typing?: () => boolean, type?: (s: string) => any, menu?: () => void }} [o] */
export function baseKeys(term, o = {}) {
  const typing = o.typing || (() => false), type = o.type || (() => {}), menu = o.menu || (() => {});
  const raw = term.input.bind(term);
  term.input = (d, u) => raw(latch(d), u); // the phone keyboard (ime.mjs) and every key below go through the latches
  const act = {
    NL: () => (typing() ? type('\n') : term.paste('\n')), Slash: () => (typing() ? type('/') : term.input('/')), PgUp: () => wheel(-1, 6), PgDn: () => wheel(1, 6),
  };
  let last = { k: '', t: 0 };
  const make = (k, label, row) => {
    if (k === 'Menu') {
      // a plain click, not the keys' pointerdown: the keyboard must drop (the sheet sits at the bottom, under it), and a sheet opened on
      // pointerdown would take this tap's click on its backdrop and close again
      const m = el('button', { type: 'button', 'aria-label': 'terminal actions' }, icon(DOTS));
      m.dataset.k = k;
      m.addEventListener('click', () => { (/** @type {any} */ (document.activeElement))?.blur?.(); menu(); });
      return m;
    }
    const b = key(label, (_b, e) => {
      if (k === 'Ctrl' || k === 'Alt') {
        const dbl = last.k === k && e.timeStamp - last.t < 350 && mods[k] === 'armed';
        mods[k] = dbl ? 'locked' : mods[k] === 'off' ? 'armed' : 'off';
        last = { k, t: e.timeStamp }; changed(); return;
      }
      last = { k, t: e.timeStamp };
      if (k === 'More') { b.parentElement?.classList.toggle('open'); b.setAttribute('aria-expanded', String(!!b.parentElement?.classList.contains('open'))); return; }
      if (!typing()) term.focus();
      if (act[k]) act[k]();
      else if (ARROW[k]) {
        // a latched arrow is xterm's modified CSI: 1;5 ctrl, 1;3 alt, 1;7 both
        const m = (mods.Ctrl !== 'off' ? 4 : 0) + (mods.Alt !== 'off' ? 2 : 0);
        if (m) { raw(`\x1b[1;${m + 1}${ARROW[k]}`); spend(); }
        else term.input((term.modes.applicationCursorKeysMode ? '\x1bO' : '\x1b[') + ARROW[k]);
      } else term.input(SEQ[k]);
    });
    b.dataset.k = k;
    if (row) b.classList.add('mr');
    if (k === 'More') { b.textContent = ''; b.append(icon(CHEV)); b.setAttribute('aria-label', 'more keys'); b.setAttribute('aria-expanded', 'false'); }
    if (k === 'Ctrl' || k === 'Alt') onMods(() => { b.dataset.mod = mods[k]; });
    return b;
  };
  return [...Object.entries(MORE).map(([k, l]) => make(k, l, true)), ...Object.entries(MAIN).map(([k, l]) => make(k, l, false))];
}

/** tmux's detach: the prefix (C-q, os/tmux.conf), then `d` 100 ms later, because tmux treats a burst as a paste and skips its bindings */
export const detach = term => { term.input('\x11'); setTimeout(() => term.input('d'), 100); };

/** the chip over the terminal that says a latch is set */
export function modChip() {
  const c = el('div', { id: 'ccmods', 'aria-live': 'polite' });
  onMods(() => {
    const on = Object.entries(mods).filter(([, v]) => v !== 'off');
    c.textContent = on.map(([k, v]) => `${k.toLowerCase()} ${v === 'locked' ? 'locked' : '+ next key'}`).join(' · ');
    c.classList.toggle('on', on.length > 0);
  });
  return c;
}

/** A- size A+: 8..22, kept per device. The server's own fontSize preference only counts while none is stored. */
export function fontKeys(term, fit) {
  const span = document.createElement('span');
  const show = () => { span.textContent = String(term.options.fontSize); };
  const apply = v => { term.options.fontSize = Math.min(22, Math.max(8, v)); store.set('ccfontsize', String(term.options.fontSize)); show(); fit(true); };
  const stored = parseInt(store.get('ccfontsize'), 10);
  if (stored >= 8 && stored <= 22) term.options.fontSize = stored;
  show();
  return { span, down: key('A−', () => apply((term.options.fontSize || 14) - 1)), up: key('A+', () => apply((term.options.fontSize || 14) + 1)), stored: () => store.get('ccfontsize') };
}

/** one finger on the screen scrolls: 14 px per notch, flick inertia (tau 300 ms, speed capped at 2.5 px/ms), at most 3 notches per frame */
export function touchScroll() {
  let y = null, acc = 0, v = 0, t0 = 0, raf = 0;
  const inScreen = t => { const s = document.querySelector('.xterm-screen') || document.querySelector('.xterm'); return !!s && s.contains(t); };
  const notch = a => {
    let n = 0;
    while (a >= 14 && n < 3) { wheel(1); a -= 14; n++; }
    while (a <= -14 && n < 3) { wheel(-1); a += 14; n++; }
    return Math.max(-42, Math.min(42, a));
  };
  document.addEventListener('touchstart', e => {
    cancelAnimationFrame(raf);
    if (!inScreen(e.target)) { y = null; return; }
    y = e.touches[0].clientY; acc = 0; v = 0; t0 = e.timeStamp;
  }, { passive: true });
  document.addEventListener('touchmove', e => {
    if (y === null) return;
    const ny = e.touches[0].clientY, dy = y - ny, dt = e.timeStamp - t0;
    y = ny; t0 = e.timeStamp;
    if (dt > 0 && dt < 120) v = 0.6 * v + 0.4 * Math.max(-2.5, Math.min(2.5, dy / dt));
    acc = notch(acc + dy);
    e.preventDefault();
  }, { passive: false });
  document.addEventListener('touchend', () => {
    if (y === null) return;
    y = null;
    if (Math.abs(v) < 0.25) return;
    let carry = acc, last = performance.now(), sp = v;
    const step = t => { const dt = Math.max(0, t - last); // an rAF stamp can precede the performance.now() taken in this handler
      last = t; carry = notch(carry + sp * dt); sp *= Math.exp(-dt / 300); if (Math.abs(sp) > 0.06) raf = requestAnimationFrame(step); };
    raf = requestAnimationFrame(step);
  }, { passive: true });
  document.addEventListener('touchcancel', () => { y = null; v = 0; }, { passive: true });
}

/** The OS keyboard: iOS keeps the layout viewport full-size under it, so the page (a fixed column: terminal, dock) is pinned to the visual
 *  viewport: body top = its offset, body height = its height (Android resizes the layout itself, interactive-widget=resizes-content). The
 *  terminal is refitted by term.mjs's ResizeObserver. Pinned in the viewport event itself, every one: a pin left for later (it was debounced
 *  120 ms) showed the page where iOS had panned it a moment before, a keyboard-tall black band at the top and the field under the keyboard
 *  (the phone, 2026-10-24). No scroll to the top while the keyboard is up: on iOS that takes the pan back, under a page pinned to it. One
 *  more pass at 520 ms: the last viewport event can fire mid keyboard-dismiss, with transitional geometry. */
export function viewportFit(fit) {
  const vv = window.visualViewport;
  if (!vv) return;
  let pin = '';
  const run = () => {
    if (!matchMedia('(pointer:coarse)').matches) return;
    const b = document.body, up = window.innerHeight - vv.height > 60 || vv.offsetTop > 2;
    const next = up ? `${Math.round(vv.offsetTop)} ${Math.round(vv.height)}` : '';
    if (next === pin) return;
    pin = next;
    b.classList.toggle('kbup', up);
    b.style.top = up ? Math.round(vv.offsetTop) + 'px' : ''; b.style.height = up ? Math.round(vv.height) + 'px' : '';
    if (!up) window.scrollTo(0, 0); // iOS can leave a stale viewport offset after the keyboard hides
    fit(true);
  };
  /** @type {any} */ let c = 0;
  const go = () => { run(); clearTimeout(c); c = setTimeout(run, 520); };
  vv.addEventListener('resize', go); vv.addEventListener('scroll', go);
}
