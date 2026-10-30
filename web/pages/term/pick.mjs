// pick.mjs — Claude's pickers (/model and the like: claudePicker in claudebox.mjs) as a sheet in the page's own look, over Claude's drawing
// of them (the phone, 2026-10-24: the /model list in the terminal read badly). It holds nothing of its own: every scan hands it what Claude
// shows, and it answers with Claude's keys. A picker with keys of its own besides Enter and Esc (/model: `s to use this session only`): a tap
// moves Claude's highlight (arrows) and the sheet's buttons are those keys. Any other: a tap answers (the number, as typed in the terminal).
// The window of the list: a row past either end moves the highlight past it, and Claude scrolls. Esc (Cancel, the backdrop) closes it.
// Claude's questions (ask, 2026-10-26: they read as the old terminal UI): the question scrolls with the options, a tap answers (a number; on a
// multi-select one it ticks, and Submit is a button); the free option opens a field in the sheet, sent as Claude takes it: the highlight moved
// there with arrows (a digit would be typed once it is), what was typed before erased, the text, and Enter (on a multi-select one Enter would
// untick it: the text alone ticks it).
// Claude's permission dialogs (perm, claudePerm, 2026-10-27): the question is the title, every row above the options as Claude drew it (a diff's
// rows in its colours), scrolled to its end; a tap answers (the number; the folder-trust question's unnumbered options: arrows and Enter).
// Claude's other panels (panel, claudePanel, 2026-10-30: /mcp, /config, /resume … read as the old terminal UI): the rows above the list as
// Claude drew them, the list, a field for its search box (typed into Claude's as it changes), the keys of its keys line as buttons. A tap
// moves the highlight one arrow at a time until it is on that row (a header or a row of two in between is no count to get wrong): Claude
// stops on a row it skips, and the seeking with it. It never answers: Enter is a button.
import { coarse, dragToClose, el, icon } from './dom.mjs';

const KEYS = { Enter: '\r', Esc: '\x1b', Tab: '\t', Space: ' ' }, UP = '\x1b[A', DN = '\x1b[B';
const CHECK = '<path d="M5 12.5l4.5 4.5L19 7.5" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"/>';
// a letter is typed, Ctrl+A is ^A; an arrow named in a hint (`↓ to select`) is not a key here
const keyOf = k => KEYS[k] ?? (/^[a-z0-9]$/i.test(k) ? k : /^ctrl\+[a-z]$/i.test(k) ? String.fromCharCode(k.toUpperCase().charCodeAt(5) - 64) : '');
const cap = s => s.charAt(0).toUpperCase() + s.slice(1);

/** @param {import('@xterm/xterm').Terminal} term */
export function picker(term) {
  const pan = el('div', { className: 'pan', role: 'dialog' }), wrap = el('div', { id: 'ccpick' }, pan);
  /** @type {any} */ let p = null;
  let shown = '', free = /** @type {string | null} */ (null), focusFree = false; // the free option's field: null shut, else what is typed in it (kept across redraws)
  /** @type {any} */ let seek = null;
  let sought = ''; // what the search field typed into Claude's
  const step = () => { // one arrow on toward the row sought; done on it, past it (Claude skipped it) or when the highlight did not move
    const i = p.opts.findLastIndex(o => o.on), t = p.opts.findIndex(o => o.label === seek.l && o.desc === seek.d), d = Math.sign(t - i);
    if (t < 0 || !d || i === seek.i || seek.dir && d !== seek.dir) { seek = null; return; }
    seek.i = i; seek.dir = d; term.input(d > 0 ? DN : UP);
  };
  const press = k => { const s = p && p.keys.some(x => x.key === k) ? keyOf(k) : ''; if (s) term.input(s); };
  wrap.addEventListener('click', e => { if (e.target === wrap) press('Esc'); });
  // a swipe down closes it, as a native sheet: Claude's esc, as Cancel (the phone, 2026-10-27). It goes at once and stays shut for SHUT ms
  // while Claude takes its dialog away: a scan before Claude redraws must not bring it back. ponytail: one Claude ignores the esc reopens on
  // its next redraw after that
  const SHUT = 1000;
  let shut = 0;
  dragToClose(wrap, pan, () => { wrap.classList.remove('open'); shown = ''; free = null; shut = Date.now(); term.input('\x1b'); });
  document.body.append(wrap);
  const btn = (cls, label, fn, kids = []) => { const b = el('button', { type: 'button', className: cls }, label, ...kids); b.addEventListener('click', fn); return b; };

  /** what Claude shows now; null closes the sheet */
  function show(/** @type {any} */ next) {
    if (next && Date.now() - shut < SHUT) return;
    const k = next ? JSON.stringify(next) : '';
    if (k === shown) return;
    shown = k; p = next;
    if (!p) { wrap.classList.remove('open'); free = null; seek = null; sought = ''; return; }
    if (seek) step();
    // a phone's keyboard down: the sheet is the input. A desktop's field keeps the focus and sends Claude its keys (composer.mjs)
    if (!wrap.classList.contains('open') && coarse()) /** @type {any} */ (document.activeElement)?.blur?.();
    const old = pan.querySelector('.opts'), scroll = old ? old.scrollTop : -1;
    const at = p.opts.find(o => o.on) || p.opts[0], first = p.opts[0], last = p.opts.at(-1);
    // the highlight's order: on a multi-select question the Submit row sits after the free option, before `Chat about this`
    const fr = p.opts.find(o => o.free), rank = n => (p.submit && fr && n > fr.n ? n + 1 : n), from = p.submit?.on && fr ? fr.n + 1 : rank(at?.n ?? 1); // a panel with no list (/status): no row
    const go = to => term.input((to > from ? DN : UP).repeat(Math.abs(to - from)));
    const move = n => go(rank(n));
    const own = p.panel || !p.perm && p.keys.some(x => x.key !== 'Enter' && x.key !== 'Esc' && keyOf(x.key));
    const opts = el('div', { className: 'opts', role: 'listbox', 'aria-label': p.title });
    if (p.ask && p.text) opts.append(el('p', { className: 'q' }, p.text)); // the question is what is answered: whole, scrolling with the options
    if (p.body?.length) opts.append(el('pre', { className: 'pv' }, ...p.body.map(r => el('span', { className: /^\s*\d+ -/.test(r) ? 'del' : /^\s*\d+ \+/.test(r) ? 'add' : '' }, r + '\n'))));
    if (first?.up) opts.append(btn('more', 'Show earlier', () => move(first.n - 1)));
    const typed = o => o.free && !/^Type something\.?$/.test(o.label);
    const send = o => {
      const t = (free || '').replace(/\s+/g, ' ').trim(); if (!t) return;
      free = null; move(o.n);
      term.input('\x7f'.repeat(typed(o) ? o.label.length : 0) + t + (o.box ? '' : '\r'));
    };
    for (const o of p.opts) {
      const b = btn('opt' + (o.on ? ' on' : '') + (o.cur ? ' cur' : '') + (o.box ? ' box' : '') + (o.free && !typed(o) ? ' ph' : ''), '', () => {
        if (o.free) { free = free === null ? (typed(o) ? o.label : '') : null; focusFree = true; const k = shown; shown = ''; show(JSON.parse(k)); return; } // the field, open or shut
        if (p.panel) { seek = { l: o.label, d: o.desc, i: -2, dir: 0 }; step(); return; }
        if (own) { for (const x of opts.querySelectorAll('.opt')) x.classList.toggle('on', x === b); move(o.n); return; }
        if (o.n <= 9 && !p.arrows) term.input(String(o.n)); else { move(o.n); setTimeout(() => term.input('\r'), 60); }
      }, [el('span', { className: 'ol' }, o.free && !typed(o) ? 'Type something…' : o.label), o.desc ? el('span', { className: 'od' }, o.desc) : null,
        o.box ? el('span', { className: 'ck' }, o.cur ? icon(CHECK) : null) : o.cur ? icon(CHECK) : null]);
      b.setAttribute('role', 'option'); b.setAttribute('aria-selected', String(o.box ? o.cur : o.on));
      opts.append(b);
      if (o.free && free !== null) {
        const ta = /** @type {HTMLTextAreaElement} */ (el('textarea', { rows: 2, placeholder: 'Your answer', enterKeyHint: 'send', 'aria-label': 'your answer' }));
        ta.value = free;
        ta.addEventListener('input', () => { free = ta.value; });
        ta.addEventListener('keydown', e => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send(o); } });
        opts.append(el('div', { className: 'free' }, ta, btn('pri', 'Send', () => send(o))));
      }
    }
    if (last?.down || p.more) opts.append(btn('more', ['Show', /^\+(\d+)/.exec(p.more)?.[1], 'more'].filter(Boolean).join(' '), () => move(last.n + 1)));
    const esc = p.keys.find(x => x.key === 'Esc'), acts0 = [];
    let srch = null;
    if (p.search !== null && p.search !== undefined) {
      const q = /** @type {HTMLInputElement} */ (el('input', { type: 'search', placeholder: p.search, value: sought, 'aria-label': p.search, enterKeyHint: 'search' }));
      q.addEventListener('input', () => { // what changed, as keys: the common start kept, the rest erased, the new rest typed
        let c = 0; while (c < sought.length && sought[c] === q.value[c]) c++;
        term.input('\x7f'.repeat(sought.length - c) + q.value.slice(c)); sought = q.value;
      });
      srch = el('div', { className: 'free' }, q);
    }
    if (p.submit) acts0.push(btn('pri', 'Submit', () => { go(fr ? fr.n + 1 : rank(last.n) + 1); term.input('\r'); }));
    const acts = own ? p.keys.filter(x => x.key !== 'Esc' && keyOf(x.key)).sort((a, b) => +(a.key === 'Enter') - +(b.key === 'Enter'))
      .map(x => btn(x.key === 'Enter' ? 'pri' : '', cap(x.label), () => press(x.key))) : acts0;
    pan.setAttribute('aria-label', p.title);
    pan.classList.toggle('ask', !!(p.ask || p.perm || p.panel));
    const had = document.activeElement?.closest?.('#ccpick .free'), hadQ = document.activeElement?.matches?.('#ccpick input'); // typing in the field when Claude redrew: it stays where it was
    pan.replaceChildren(...[ // replaceChildren writes a null as the text "null"
      el('div', { className: 'grab' }),
      el('div', { className: 'hd' }, el('b', {}, p.title), esc ? btn('', cap(esc.label), () => press('Esc')) : null),
      p.text && !p.ask ? el('p', { className: 'tx' }, p.text) : null,
      srch, opts,
      p.adjust ? el('div', { className: 'adj' }, btn('', '‹', () => term.input('\x1b[D')), el('span', {}, p.adjust), btn('', '›', () => term.input('\x1b[C'))) : null,
      acts.length ? el('div', { className: 'acts' }, ...acts) : null].filter(x => x));
    pan.querySelector('.adj button')?.setAttribute('aria-label', 'less');
    pan.querySelector('.adj button:last-child')?.setAttribute('aria-label', 'more');
    wrap.classList.add('open');
    // the list where it was, its highlighted row in view (on opening, or moved past the window)
    if (scroll >= 0) opts.scrollTop = scroll;
    else if (p.perm) opts.scrollTop = opts.scrollHeight; // a dialog opens on its end: the command or the diff, the options
    const fta = /** @type {HTMLTextAreaElement | null} */ (opts.querySelector('.free textarea'));
    const fq = /** @type {HTMLInputElement | null} */ (pan.querySelector('.free input'));
    if (fq && hadQ) fq.focus();
    else if (fta && (had || focusFree)) { fta.focus(); fta.setSelectionRange(fta.value.length, fta.value.length); fta.scrollIntoView({ block: 'nearest' }); }
    else opts.querySelector('.on')?.scrollIntoView({ block: 'nearest' });
    focusFree = false;
  }
  return { show };
}
