// ime.mjs — mobile keyboard word suggestions that track the typed line (MAP 4.2 B-50). Touch only; ?ime=off turns it off. Shadow-line mode: the hidden
// textarea RETAINS the current line so the IME has real prediction context; trusted key, input and composition events are stopped at
// document-capture before xterm sees them, and the value diff is replayed to the pty as \x7f x N + the retyped tail through term.input().
// Untrusted events (a synthetic Enter) still reach xterm. Enter is a synthetic keydown, so xterm's own key path runs: connected -> one \r;
// disconnected -> onKey fires and ttyd.mjs reconnects. historyUndo/historyRedo are swallowed (iOS shake-to-undo would revert the field and
// make the diff fire backspaces at the pty). A paste is xterm's own single bracketed paste, never a second copy through the diff. The reconnect kick on return to the foreground is
// ttydClient.kick(). Needs a phone to judge (manual gate real-device terminal): the probe asserts the wire bytes, not the keyboard.
// ponytail: the diff counts code points, not grapheme clusters; a ZWJ emoji sequence may need extra backspaces.
import { coarse, off } from './dom.mjs';

export function ime(/** @type {import('@xterm/xterm').Terminal} */ term, client) {
  if (!coarse() || off('ime')) return;
  const ta = () => /** @type {HTMLTextAreaElement | null} */ (term.textarea ?? null);
  const isTA = e => e.target === ta();
  const enterKey = () => ta()?.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', keyCode: 13, which: 13, bubbles: true, cancelable: true }));
  // The field always starts with the sentinel S: iOS repeats a held delete only while the field has text, so on an empty shadow line (after Enter,
  // a paste, a bar key, text typed before the page) holding delete sent one \x7f and stopped. Deleting S is a delete into the older terminal text:
  // one \x7f, or ^W once iOS has sped up to whole words; S goes straight back. ponytail: a plain space; the textarea is invisible.
  const S = ' ';
  const strip = v => (v.startsWith(S) ? v.slice(1) : v);
  const seed = t => { if (t && !t.value.startsWith(S)) t.value = S + t.value; }; // setting value puts the caret at the end
  let prev = '', saved = '', lastType = '', /** @type {any} */ rs = 0;
  const resync = () => { clearTimeout(rs); rs = setTimeout(() => { const t = ta(); if (t) { seed(t); prev = saved = t.value; } }, 50); };
  const submit = t => { t.value = S; prev = saved = S; enterKey(); };
  const diff = t => {
    // the caret sat before S (iOS can leave it at 0): the text went in front of the line; move it behind, or S itself is sent ("s er")
    if (prev && !t.value.startsWith(S) && t.value.length > prev.length && t.value.endsWith(prev)) t.value = prev + t.value.slice(0, -prev.length);
    const lost = !t.value.startsWith(S), a = Array.from(strip(prev)), b = Array.from(strip(t.value));
    let p = 0;
    while (p < a.length && p < b.length && a[p] === b[p]) p++;
    let out = '\x7f'.repeat(a.length - p) + b.slice(p).join('');
    if (lost && !out) out = lastType === 'deleteWordBackward' ? '\x17' : '\x7f';
    seed(t);
    prev = saved = t.value;
    if (out) term.input(out);
  };
  const fix = t => {
    if (!t || t.getAttribute('autocorrect') === 'on') return;
    for (const [k, v] of [['autocomplete', 'on'], ['autocorrect', 'on'], ['spellcheck', 'true'], ['enterkeyhint', 'send']]) t.setAttribute(k, v);
    if (document.activeElement === t) { t.blur(); t.focus(); } // make the IME re-read the flags
  };
  fix(ta()); seed(ta());
  // xterm empties the field on every blur (app switch, keyboard hidden). Registered after xterm's own listener, so this runs right after it and
  // puts the line back: an IME edit that lands while the field is empty would be diffed against '' and backspace the whole typed line in the pty.
  ta()?.addEventListener('blur', () => { const t = ta(); if (t && t.value === '' && prev) t.value = prev; });

  for (const type of ['keydown', 'keyup', 'keypress']) document.addEventListener(type, (/** @type {any} */ e) => {
    if (!isTA(e)) return;
    if (!e.isTrusted) { resync(); return; } // the bar's keys: xterm handles them and may clear the field
    const k = e.key;
    if (type === 'keydown') {
      if (k === 'Enter' && !e.shiftKey) { e.preventDefault(); e.stopPropagation(); submit(e.target); return; }
      if (k === 'Backspace' && e.target.selectionStart === 0 && e.target.selectionEnd === 0) { e.stopPropagation(); term.input('\x7f'); return; } // empty shadow at caret 0: delete into older terminal text
      if (e.ctrlKey || e.altKey || e.metaKey || (k.length > 1 && k !== 'Backspace' && k !== 'Delete' && k !== 'Process' && k !== 'Unidentified')) { e.preventDefault(); resync(); return; } // a terminal key: xterm's
    }
    e.stopPropagation(); // an editing key: the native edit proceeds, the input diff mirrors it
  }, true);
  // A paste is xterm's own (the paste event: one bracketed paste, newlines as \r). The native insertion into the shadow line is cancelled, or the
  // input diff would send the same text a second time. An engine that raises beforeinput(insertFromPaste) without a paste event first gets the same.
  let lastPaste = 0;
  document.addEventListener('paste', e => { if (isTA(e) && e.isTrusted) { e.preventDefault(); lastPaste = Date.now(); } resync(); }, true);
  document.addEventListener('beforeinput', (/** @type {any} */ e) => {
    if (!isTA(e) || !e.isTrusted) return;
    lastType = e.inputType;
    if (e.inputType === 'insertLineBreak') { e.preventDefault(); e.stopPropagation(); submit(e.target); return; }
    if (e.inputType === 'historyUndo' || e.inputType === 'historyRedo') { e.preventDefault(); e.stopPropagation(); resync(); return; }
    if (e.inputType === 'insertFromPaste') {
      e.preventDefault(); e.stopPropagation();
      const d = e.data || e.dataTransfer?.getData('text/plain') || '';
      if (d && Date.now() - lastPaste > 200) term.paste(d);
    }
  }, true);
  document.addEventListener('input', (/** @type {any} */ e) => {
    if (!isTA(e)) return;
    if (!e.isTrusted) { resync(); return; }
    e.stopPropagation();
    if (e.inputType === 'insertLineBreak') { e.target.value = prev; return; }
    diff(e.target);
  }, true);
  for (const type of ['compositionstart', 'compositionupdate', 'compositionend']) document.addEventListener(type, e => { if (isTA(e) && e.isTrusted) e.stopPropagation(); }, true);
  document.addEventListener('focusin', (/** @type {any} */ e) => {
    if (!isTA(e)) return;
    const t = e.target;
    fix(t); client.kick();
    if (t.value === '' && saved) t.value = saved; // xterm clears on blur; restore so the IME keeps its context
    seed(t);
    prev = t.value;
  }, true);
  for (const type of ['visibilitychange', 'pageshow', 'online']) (type === 'visibilitychange' ? document : window).addEventListener(type, () => {
    if (document.visibilityState === 'visible') { setTimeout(client.kick, 300); setTimeout(client.kick, 1500); } // the close event often lands only after foregrounding
  });
}
