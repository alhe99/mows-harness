// bar.mjs — the key bar #cckb (MAP 4.2 B-10, B-20, B-30, B-45): the base keys, touch scroll, the keyboard-aware fit. Every key goes through
// term.input()/term.paste() (public API), so bytes on the wire are what term-check.mjs's `proto` mode asserts. The other keys of the bar
// (back, pill, attach, copy, paste, restart, theme) are made by their own modules; term.mjs lays them out in the final child order.
import { key, store } from './dom.mjs';

// S-Tab sits next to Esc, on the first screen of the bar: it cycles Claude's permission mode (2026-10-17)
const L = { Esc: 'Esc', 'S-Tab': '⇧⇥', NL: '\\⏎', IND: '␣␣', Tab: 'Tab', UP: '↑', DN: '↓', LT: '←', RT: '→',
  PgUp: '⇞', PgDn: '⇟', '^C': '^C', '^Bd': '^Q d', KB: '⌨' };
const ARROW = { UP: 'A', DN: 'B', RT: 'C', LT: 'D' };
const SEQ = { Esc: '\x1b', Tab: '\t', 'S-Tab': '\x1b[Z', '^C': '\x03' };

/** wheel notches on the screen: tmux and Claude Code read them as scrolling through mouse reporting */
const wheel = (dir, n = 1) => {
  const s = document.querySelector('.xterm-screen') || document.querySelector('.xterm');
  if (s) for (let i = 0; i < n; i++) s.dispatchEvent(new WheelEvent('wheel', { deltaY: dir * 57, deltaMode: 0, bubbles: true, cancelable: true }));
};

/** Esc S-Tab NL IND Tab UP DN LT RT PgUp PgDn ^C ^Bd KB, in that order */
export function baseKeys(/** @type {import('@xterm/xterm').Terminal} */ term) {
  const act = {
    NL: () => term.paste('\n'), IND: () => term.paste('  '), PgUp: () => wheel(-1, 6), PgDn: () => wheel(1, 6),
    // tmux's prefix is C-q (os/tmux.conf); the `d` follows later because tmux treats a burst as a paste and skips its bindings
    '^Bd': () => { term.input('\x11'); setTimeout(() => term.input('d'), 100); },
    KB: () => {},
  };
  return Object.keys(L).map(k => {
    const b = key(L[k], () => {
      term.focus();
      if (act[k]) act[k]();
      else if (ARROW[k]) term.input((term.modes.applicationCursorKeysMode ? '\x1bO' : '\x1b[') + ARROW[k]);
      else term.input(SEQ[k]);
    });
    b.dataset.k = k;
    return b;
  });
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

/** The OS keyboard: iOS keeps the layout viewport full-size under it and hides the input line and the bar, so both are pinned to the visual
 *  viewport and refitted (Android resizes the layout itself, interactive-widget=resizes-content). Debounced 120 ms, plus one settle pass at
 *  520 ms: the last viewport event fires mid keyboard-dismiss, so a single early pass sees transitional geometry. */
export function viewportFit(bar, fit) {
  const vv = window.visualViewport;
  if (!vv) return;
  const run = () => {
    if (!matchMedia('(pointer:coarse)').matches) return;
    const tc = document.getElementById('terminal-container');
    if (!tc) return;
    if (window.innerHeight - vv.height > 60 || vv.offsetTop > 2) {
      bar.style.paddingBottom = '5px';
      const bh = bar.offsetHeight || 46;
      tc.style.height = (vv.height - bh - tc.getBoundingClientRect().top) + 'px'; // the safe-area top offset, or the box overshoots the pinned bar
      bar.style.bottom = 'auto'; bar.style.top = (vv.offsetTop + vv.height - bh) + 'px';
    } else {
      tc.style.height = ''; bar.style.top = ''; bar.style.bottom = '0'; bar.style.paddingBottom = '';
    }
    window.scrollTo(0, 0); // iOS can leave a stale viewport offset after the keyboard hides
    fit(true);
  };
  /** @type {any} */ let a = 0;
  /** @type {any} */ let b = 0;
  const go = () => { clearTimeout(a); a = setTimeout(run, 120); clearTimeout(b); b = setTimeout(run, 520); };
  vv.addEventListener('resize', go); vv.addEventListener('scroll', go);
}
