// composer.mjs — the message field over the keys (2026-10-23). Return sends what is typed: a bracketed paste and, 60 ms later, a \r (the
// paste and the Enter must not land in one read). Shift+return breaks the line; an empty field sends nothing. Phone text, so autocorrect, dictation and the caret work as in any other field.
// While Claude Code's own input box is on screen and empty (claudebox.mjs), the composer stands in for it: the terminal is shifted down by
// the box's rows, so the box, Claude's status and mode lines and tmux's status line slide under the dock, and a tap on the terminal brings
// the keyboard up in the composer. The mode line comes back as the chip (tap = shift+tab). A box holding a draft, a permission dialog, a
// shell or a full-screen program: nothing is hidden and the terminal reads as it is. One input, always: the field shows only while it stands in
// for Claude's hidden box or answers a permission dialog; otherwise the terminal is the input, as before (2026-10-23, two inputs seen on the
// phone with a draft and after Attach). ?comp=off turns the composer off.
// ponytail: the shift wastes the hidden rows at the top of the screen (a blank band under the strip). Upgrade path: grow the pty by those
// rows instead, at the price of a resize whenever the box comes and goes.
import { claudeScreen } from './claudebox.mjs';
import { coarse, el, icon, off } from './dom.mjs';
import { mods } from './bar.mjs';

const SEND = '<path d="M12 19V5M5 12l7-7 7 7" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"/>';

export function composer(/** @type {import('@xterm/xterm').Terminal} */ term, /** @type {HTMLElement} */ tc) {
  if (!coarse() || off('comp')) return null;
  const ta = /** @type {HTMLTextAreaElement} */ (el('textarea', { id: 'ccmsg', rows: 1, placeholder: 'Message Claude…', enterKeyHint: 'send', 'aria-label': 'message to this session' }));
  for (const [k, v] of [['autocomplete', 'on'], ['autocorrect', 'on'], ['autocapitalize', 'sentences'], ['spellcheck', 'true']]) ta.setAttribute(k, v);
  const mode = el('button', { type: 'button', id: 'ccmode', hidden: true, 'aria-label': 'permission mode, tap to cycle' });
  const send = el('button', { type: 'submit', id: 'ccsend', 'aria-label': 'send' }, icon(SEND));
  const form = el('form', { id: 'cccomp', autocomplete: 'off', hidden: true }, ta, el('div', { className: 'cbar' }, mode, send));

  let hidden = -1, choice = 0; // hidden: the screen row of the top rule of Claude's box while it is hidden, else -1
  const grow = () => { ta.style.height = 'auto'; ta.style.height = Math.min(ta.scrollHeight, 120) + 'px'; form.classList.toggle('has', !!ta.value.trim()); };
  const submit = () => {
    scan(); // what is on screen right now, not 30 ms ago: a dialog that just appeared takes a digit, not a paste and an Enter
    const t = ta.value.replace(/\s+$/, '');
    ta.value = ''; grow();
    if (!t) return; // never a bare Enter: under the field is a hidden box or a dialog whose Enter would answer it
    if (choice && /^\d$/.test(t)) { term.input(t); return; } // a permission dialog: the digit picks, an Enter after it would land in the next prompt
    term.paste(t);
    setTimeout(() => term.input('\r'), 60);
  };
  form.addEventListener('submit', e => { e.preventDefault(); submit(); });
  ta.addEventListener('input', grow);
  ta.addEventListener('keydown', e => { if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) { e.preventDefault(); submit(); } });
  // a latched ctrl/alt turns the next typed character into a key for the terminal, not text for the field
  ta.addEventListener('beforeinput', (/** @type {any} */ e) => {
    if ((mods.Ctrl === 'off' && mods.Alt === 'off') || e.inputType !== 'insertText' || !e.data || [...e.data].length !== 1) return;
    e.preventDefault(); term.input(e.data);
  });
  mode.addEventListener('click', () => term.input('\x1b[Z'));

  // the screen, read after every write (coalesced: one scan per 30 ms burst)
  /** @type {any} */ let pend = 0;
  const scan = () => {
    clearTimeout(pend); pend = 0;
    const b = term.buffer.active, rows = [], typed = [], cell = b.getNullCell();
    for (let i = 0; i < term.rows; i++) {
      const l = b.getLine(b.viewportY + i);
      rows.push(l?.translateToString(true) ?? '');
      // only what Claude draws in the terminal's default colour, not dim, not its inverse cursor: typed text. Its hints are grey or dim.
      let t = '';
      if (l) for (let x = 0; x < l.length; x++) { const c = l.getCell(x, cell); if (!c || !c.getWidth()) continue; t += c.isFgDefault() && !c.isDim() && !c.isInverse() ? c.getChars() || ' ' : ' '; }
      typed.push(t);
    }
    const s = b.viewportY === b.baseY ? claudeScreen(rows, typed) : { box: null, mode: null, choice: 0 };
    // at most 12 rows (box, Claude's status and mode lines, a task list, tmux's line) and never from the first row: a misread screen cannot
    // swallow the conversation. Not a share of the rows: with the keyboard up on a small phone the box alone is two thirds of them.
    const top = s.box?.empty && s.box.top >= 1 && term.rows - s.box.top <= 12 ? s.box.top : -1;
    if (top !== hidden) {
      hidden = top;
      // the shift that puts the box's top rule just under the wrap's bottom edge (the screen sits 5 px into the container: .terminal's padding)
      const scr = document.querySelector('.xterm-screen'), wrap = tc.parentElement;
      const y = scr && wrap ? scr.getBoundingClientRect().top - tc.getBoundingClientRect().top + top * (scr.clientHeight / term.rows) : 0;
      tc.style.transform = top >= 0 && wrap ? `translateY(${Math.max(0, Math.ceil(wrap.clientHeight - y))}px)` : ''; // mid-refit the rule can already sit below the edge
      document.body.classList.toggle('ccclaude', top >= 0);
    }
    choice = s.choice;
    mode.hidden = !(top >= 0 && s.mode);
    if (s.mode) { mode.textContent = s.mode.label; mode.className = s.mode.cls; }
    ta.placeholder = choice ? `Type 1–${choice} to choose…` : 'Message Claude…';
    const show = top >= 0 || choice > 0;
    if (form.hidden === show) {
      form.hidden = !show;
      if (!show && document.activeElement === ta) term.focus(); // the keyboard carries on in the terminal, the one input left
    }
  };
  const later = () => { pend ||= setTimeout(scan, 30); };
  term.onWriteParsed(later); term.onScroll(later);
  // Claude's box is hidden: the keyboard belongs to the composer, so a tap on the terminal lands there
  term.textarea?.addEventListener('focus', () => { if (hidden >= 0) ta.focus(); });
  // a refit or a new wrap height (keyboard, second key row, a growing field) moves the rows: measure again
  const remeasure = () => { hidden = -2; later(); };
  term.onResize(remeasure);
  if (tc.parentElement) new ResizeObserver(remeasure).observe(tc.parentElement);
  /** text from attach or paste: it goes where the user types. true if taken */
  const insert = t => {
    if (form.hidden) return false; // the field is not the input right now
    ta.setRangeText(t, ta.selectionStart, ta.selectionEnd, 'end'); grow();
    return true;
  };
  return { el: form, typing: () => document.activeElement === ta, insert };
}
