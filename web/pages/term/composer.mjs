// composer.mjs — the message field over the keys (2026-10-23). Return sends what is typed: a bracketed paste and, 60 ms later, a \r (the
// paste and the Enter must not land in one read). Shift+return breaks the line. Phone text, so autocorrect, dictation and the caret work as
// in any other field.
// In a Claude session the field stands in for Claude Code's own input box (claudebox.mjs): the terminal is made taller than the space it shows
// by exactly the rows of Claude's chrome (the box, its status and mode lines, a task list, tmux's status line), so the pty has those rows and
// they sit under the dock while every visible row is conversation; what a row's remainder leaves is closed by a shift of less than a row. A
// tap on the terminal brings the keyboard up in the field (from the touch itself: iOS ignores a focus moved inside a focus event). What Claude holds in its box (an attached image's [Image #1], a prompt recalled with ↑) shows as the draft chip, and send
// submits it with whatever is typed; with an empty field, send submits the draft alone. The mode line comes back as the mode chip (tap =
// shift+tab). A permission dialog: nothing is hidden, a bare digit picks. A shell or a full-screen program: no field, the terminal is the one
// input. ?comp=off turns the composer off.
// The layout must not depend on the screen from one frame to the next: showing the field resizes the terminal, Claude and tmux redraw, and
// mid-redraw the box is briefly gone (the phone, 2026-10-23: the field flashed on and off). So the field appears at once and goes only after
// Claude has been off the screen for LINGER ms, and the shift and the chips are kept through the same window.
// The hidden rows change only when Claude's chrome changes height (a dialog, an exit, a multi-line draft), never while a resize is settling
// (SETTLE ms): each change is one pty resize. (The first version shifted the terminal down instead: no resizes, but the hidden rows came
// back as a blank band at the top, and with the keyboard up on a small phone that band was most of the screen. 2026-10-23)
import { claudeScreen } from './claudebox.mjs';
import { coarse, el, icon, off } from './dom.mjs';
import { mods } from './bar.mjs';

const SEND = '<path d="M12 19V5M5 12l7-7 7 7" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"/>';
const LINGER = 1500, SETTLE = 400;

/** @param {{ url: string, name: string, path: string }[]} uploads images sent from this page, in order (attach.mjs) */
export function composer(/** @type {import('@xterm/xterm').Terminal} */ term, /** @type {HTMLElement} */ tc, fit = () => {}, uploads = []) {
  if (!coarse() || off('comp')) return null;
  const ta = /** @type {HTMLTextAreaElement} */ (el('textarea', { id: 'ccmsg', rows: 1, placeholder: 'Message Claude…', enterKeyHint: 'send', 'aria-label': 'message to this session' }));
  for (const [k, v] of [['autocomplete', 'on'], ['autocorrect', 'on'], ['autocapitalize', 'sentences'], ['spellcheck', 'true']]) ta.setAttribute(k, v);
  const mode = el('button', { type: 'button', id: 'ccmode', hidden: true, 'aria-label': 'permission mode, tap to cycle' });
  // the draft chip: what Claude's box holds. Tap it to see it (the attached images, from this phone's own copy); × clears it (one ctrl+c:
  // Claude clears a non-empty input with it and stays; checked on Claude Code 2026-10-24)
  const draftText = el('button', { type: 'button', id: 'ccdraft', 'aria-label': "show what is attached" });
  const clear = el('button', { type: 'button', id: 'ccclear', 'aria-label': 'remove it from the message', textContent: '×' });
  const draft = el('span', { className: 'dchip', hidden: true }, draftText, clear);
  const send = el('button', { type: 'submit', id: 'ccsend', 'aria-label': 'send' }, icon(SEND));
  const form = el('form', { id: 'cccomp', autocomplete: 'off', hidden: true }, ta, el('div', { className: 'cbar' }, mode, draft, send));

  let top = -1, shift = '', choice = 0, held = '', seen = 0; // top: the row of the box's top rule while it is hidden; seen: Claude last on screen
  // the field fits its text, one to five lines. Measured only while it is laid out: a field that is not (hidden, or the page not rendered under the
  // iOS file picker) measures 0, and a 0 px field stayed collapsed after an attach (the phone, 2026-10-24); term.css keeps a one-line minimum
  const grow = () => {
    form.classList.toggle('has', !!ta.value.trim() || !!held);
    if (!ta.offsetParent) return;
    ta.style.height = 'auto';
    const h = ta.scrollHeight;
    ta.style.height = h ? Math.min(h, 120) + 'px' : '';
  };
  // a field resized while it could not be measured is measured again once it can
  new ResizeObserver(() => { if (ta.offsetParent && ta.style.height === '') grow(); }).observe(form);
  const submit = () => {
    scan(); // what is on screen right now, not 30 ms ago: a dialog that just appeared takes a digit, not a paste and an Enter
    const t = ta.value.replace(/\s+$/, '');
    ta.value = ''; grow();
    if (choice) { if (/^\d$/.test(t)) term.input(t); return; } // a permission dialog: a digit picks, and nothing else is sent into it
    if (!t) { if (held) term.input('\r'); return; } // the draft alone (an attached image, a recalled prompt): it is on screen, in the chip
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

  // the cell height: a DOM row's (the renderer iOS uses), else the screen's height over the rows. Right after a resize the screen keeps its
  // old height until xterm renders, so that ratio is stale for a frame: the rAF pass after a resize corrects it
  const cellH = () => { const r0 = /** @type {HTMLElement | null} */ (document.querySelector('.xterm-rows > div')), scr = document.querySelector('.xterm-screen'); return r0?.offsetHeight || (scr ? scr.clientHeight / term.rows : 0); };
  const place = (/** @type {number} */ t) => {
    // the shift that puts the box's top rule just under the wrap's bottom edge (the screen sits a padding into the container): with the rows
    // hidden by height, what is left is a row's remainder
    const scr = document.querySelector('.xterm-screen'), wrap = tc.parentElement;
    if (t < 0 || !scr || !wrap) return '';
    // measured from the top of the space shown: the box starts a row above it (its margin, the row standing over the top edge), and both
    // rects carry the current shift, which cancels out
    const y = tc.offsetTop + scr.getBoundingClientRect().top - tc.getBoundingClientRect().top + t * cellH();
    // up as well as down: while tmux has cut the pane (the lines under the cursor go first) and Claude has not redrawn, the box's top rule sits
    // higher than the rows hidden under the dock, and the newest lines with it; moving up, at most by those rows, keeps them in view
    return `translateY(${Math.max(-extraPx, Math.ceil(wrap.clientHeight - y))}px)`;
  };
  // rows hidden under the dock by height: the container grows by them, the pty gets them (one resize per change)
  let extra = 0, extraPx = 0, resized = 0, cellSet = 0;
  const hide = (/** @type {number} */ n) => {
    // the rows, and the terminal's bottom padding under them, so the box's top rule lands on the dock's edge with no shift (a shift down would
    // open a strip at the top)
    const pad = n && term.element ? parseFloat(getComputedStyle(term.element).paddingBottom) || 0 : 0;
    const px = n ? Math.ceil(n * cellH() + pad) : 0;
    if (n === extra && px === extraPx) return;
    extra = n; extraPx = px;
    tc.style.setProperty('--cc-hid', px + 'px');
    fit();
  };
  // the screen, read in the same write that changed it (before the frame is painted: the shift and the content move together), and after
  // every resize
  /** @type {any} */ let pend = 0;
  /** @type {any} */ let linger = 0;
  /** @type {any} */ let settle = 0;
  const scan = () => {
    clearTimeout(pend); pend = 0;
    const b = term.buffer.active;
    if (b.viewportY !== b.baseY) return; // scrolled back in xterm's own history: nothing to read, nothing changes
    const rows = [], typed = [], cell = b.getNullCell();
    for (let i = 0; i < term.rows; i++) {
      const l = b.getLine(b.viewportY + i);
      rows.push(l?.translateToString(true) ?? '');
      // only what Claude draws in the terminal's default colour, not dim, not its inverse cursor: typed text. Its hints are grey or dim.
      let t = '';
      if (l) for (let x = 0; x < l.length; x++) { const c = l.getCell(x, cell); if (!c || !c.getWidth()) continue; t += c.isFgDefault() && !c.isDim() && !c.isInverse() ? c.getChars() || ' ' : ' '; }
      typed.push(t);
    }
    // one row more than fits, standing above the top edge (term.css): the screen sits on the bottom of its box, so without it the part of a row
    // that does not fit was a blank strip under the status bar (the phone, 2026-10-23); with it the top is always text, faded
    const ch = Math.ceil(cellH());
    if (ch && ch !== cellSet) { cellSet = ch; tc.style.setProperty('--cc-cell', ch + 'px'); fit(); }
    const s = claudeScreen(rows, typed), now = Date.now();
    // at most 16 rows holding something (box, Claude's status and mode lines, a task list, tmux's line; blank rows a redraw has not reached
    // yet do not count): a misread screen cannot swallow the conversation. Not a share of the rows: with the keyboard up on a small phone the
    // box alone is two thirds of them, and on an SE with the second key row open it starts on the first row.
    const ok = r => r >= 0 && rows.slice(r).filter(x => x.trim()).length <= 16;
    let t = s.box && ok(s.box.top) ? s.box.top : -1;
    const recent = now - seen < LINGER;
    if (t >= 0 || s.choice) seen = now;
    else if (recent && ok(s.edge)) t = s.edge; // a redraw in flight: the box's top rule and prompt are there, its bottom is not yet
    choice = s.choice;
    clearTimeout(linger);
    if (t >= 0) {
      // Claude's chrome, from the box's top rule down: those rows go under the dock (a cut box, mid-redraw, changes nothing; nor does a resize
      // still settling)
      if (s.box && now - resized > SETTLE) hide(Math.min(16, term.rows - t));
      else if (s.box) { clearTimeout(settle); settle = setTimeout(scan, SETTLE - (now - resized) + 10); } // look again once the resize has settled
      top = t; shift = place(t);
      if (s.box) { // the whole box: its draft and mode are current; a cut one keeps what was read last
        held = s.box.draft || '';
        mode.hidden = !s.mode;
        if (s.mode) { mode.textContent = s.mode.label; mode.className = s.mode.cls; }
      }
    } else if (choice || !recent) { top = -1; held = ''; shift = ''; mode.hidden = true; hide(0); } // a dialog shows at once; the rest after LINGER without Claude
    else linger = setTimeout(scan, LINGER - (now - seen) + 10); // a redraw in flight: keep the last shift and chips, look again when the window ends
    if (tc.style.transform !== shift) tc.style.transform = shift;
    document.body.classList.toggle('ccclaude', top >= 0);
    if (draftText.textContent !== held) { draft.hidden = !held; draftText.textContent = held; grow(); match(); } // only on a change: grow() moves the layout
    const ph = choice ? `Type 1–${choice} to choose…` : held ? 'Add a message, or send as it is…' : 'Message Claude…';
    if (ta.placeholder !== ph) ta.placeholder = ph;
    const show = top >= 0 || choice > 0 || recent;
    if (form.hidden === show) {
      form.hidden = !show;
      if (!show && document.activeElement === ta) term.focus(); // the keyboard carries on in the terminal, the one input left
    }
    // while the field is the input, xterm's own input is disabled: nothing can type into Claude's box behind it, not a tap, not the iOS
    // keyboard bar's ^/v (which walks the page's text fields), not a focus from anywhere else (the phone, 2026-10-24: a message landed in
    // Claude's box). The bar's keys do not need it: they write through term.input().
    const x = term.textarea;
    if (x && x.disabled !== show) {
      const had = document.activeElement === x;
      x.disabled = show;
      if (show && had) ta.focus();
      if (!show && document.activeElement === ta) term.focus();
    }
  };
  const later = () => { pend ||= setTimeout(scan, 30); };
  term.onWriteParsed(scan); term.onScroll(later);
  // Claude's box is hidden: the keyboard belongs to the composer, so a tap on the terminal lands there. From the touch itself (a user gesture,
  // which iOS needs to raise the keyboard), cancelled so xterm never takes the focus; a drag is a scroll, not a tap. The focus redirect stays
  // for any other way xterm gets the focus.
  let tx = 0, ty = 0;
  tc.parentElement?.addEventListener('touchstart', e => { tx = e.touches[0].clientX; ty = e.touches[0].clientY; }, { passive: true });
  tc.parentElement?.addEventListener('touchend', e => {
    const p = e.changedTouches[0];
    if (top < 0 || form.hidden || !p || Math.abs(p.clientX - tx) + Math.abs(p.clientY - ty) > 10) return;
    e.preventDefault(); ta.focus();
  });
  term.textarea?.addEventListener('focus', () => { if (!form.hidden) ta.focus(); });
  // a tap the touch handler did not see (a mouse, an accessibility tap): the click is a gesture too
  tc.parentElement?.addEventListener('click', () => { if (!form.hidden && document.activeElement !== ta) ta.focus(); });
  // a refit or a new wrap height (keyboard, second key row, a growing field) moves the rows: place the shift again
  // xterm can leave its viewport off the bottom after a resize that pushed rows into its scrollback, showing an older view until the next
  // output; under tmux that scrollback is never read (the finger scrolls tmux), so the view goes back to the bottom at once
  term.onResize(() => { resized = Date.now(); term.scrollToBottom(); scan(); requestAnimationFrame(() => scan()); });
  // from the observer: the shift is placed at once (a transform: it cannot resize what is observed, and the frame paints with it), the full
  // scan a tick later (it can show or hide the field, which inside the callback would be a ResizeObserver loop: WebKit reports it)
  if (tc.parentElement) new ResizeObserver(() => { if (top >= 0) tc.style.transform = shift = place(top); clearTimeout(pend); pend = setTimeout(scan, 0); }).observe(tc.parentElement);
  // [Image #N] in the draft -> the upload it came from: each new token takes the next upload not yet matched, in order
  const imgOf = new Map();
  let nextUp = 0;
  const match = () => {
    for (const [tok] of held.matchAll(/\[Image #\d+\]/g)) if (!imgOf.has(tok) && nextUp < uploads.length) imgOf.set(tok, uploads[nextUp++]);
  };
  // the preview: every image of the draft, and the draft's text
  const prevBody = el('div', { className: 'pv-body' });
  const prev = el('div', { id: 'ccprev', role: 'dialog', 'aria-label': 'attached to your message' },
    el('div', { className: 'pv-bar' }, el('span', { className: 'pv-t' }, 'In your message'),
      el('button', { type: 'button', className: 'pv-rm', textContent: 'Remove' }), el('button', { type: 'button', className: 'pv-x', textContent: 'Close' })), prevBody);
  document.body.append(prev);
  const closePrev = () => prev.classList.remove('on');
  const remove = () => { closePrev(); scan(); if (held && !choice) term.input('\x03'); };
  draftText.addEventListener('click', () => {
    prevBody.textContent = '';
    for (const [tok] of held.matchAll(/\[Image #\d+\]/g)) {
      const u = imgOf.get(tok);
      prevBody.append(el('figure', {}, u ? el('img', { src: u.url, alt: tok }) : el('div', { className: 'pv-none', textContent: 'No preview: attached before this page was opened' }), el('figcaption', { textContent: tok + (u?.name ? ' · ' + u.name : '') })));
    }
    const rest = held.replace(/\[Image #\d+\]/g, '').trim();
    if (rest) prevBody.append(el('p', { className: 'pv-text', textContent: rest }));
    prev.classList.add('on');
  });
  prev.querySelector('.pv-x')?.addEventListener('click', closePrev);
  prev.querySelector('.pv-rm')?.addEventListener('click', remove);
  clear.addEventListener('click', remove);
  /** text from the menu's Paste: it goes where the user types. true if taken */
  const insert = t => {
    if (form.hidden || choice) return false;
    ta.setRangeText(t, ta.selectionStart, ta.selectionEnd, 'end'); grow();
    return true;
  };
  return { el: form, typing: () => document.activeElement === ta, insert };
}
