// clip.mjs — the clipboard (MAP 4.2 B-00, B-60). OSC 52 from the terminal goes to navigator.clipboard through the parser, public API; a write the
// browser refuses is held until the next keydown or mousedown (a gesture). Copy-on-select after a drag or a double click. The copy overlay
// (the key ⧉) snapshots buffer.active with wrapped rows re-joined into a plain <pre>, where the OS selection handles and Copy menu work on a
// phone; the paste key (📋) reads the clipboard on pointerup and term.paste()s it. ?clip=off removes the two keys, not OSC 52.
import { el, flash, key, off } from './dom.mjs';

export function clipboard(/** @type {import('@xterm/xterm').Terminal} */ term) {
  let pending = '', toast = null;
  const say = m => {
    toast ??= document.body.appendChild(el('div', { id: 'cctoast' }));
    toast.textContent = m; toast.classList.add('on');
    clearTimeout(toast._t); toast._t = setTimeout(() => toast.classList.remove('on'), 1500);
  };
  const put = text => {
    if (!text) return;
    (navigator.clipboard?.writeText(text) ?? Promise.reject()).then(() => say(`copied ${text.length} chars`), () => { pending = text; say('copy blocked — click or press a key'); });
  };
  const flush = () => { if (pending) { const t = pending; pending = ''; put(t); } };
  document.addEventListener('keydown', flush, true);
  document.addEventListener('mousedown', flush, true);

  term.parser.registerOscHandler(52, data => {
    const b64 = data.slice(data.indexOf(';') + 1);
    if (b64 && b64 !== '?') { try { put(new TextDecoder().decode(Uint8Array.from(atob(b64), c => c.charCodeAt(0)))); } catch { /* not base64: nothing to copy */ } }
    return true;
  });

  let dx = 0, dy = 0;
  document.addEventListener('mousedown', e => { dx = e.clientX; dy = e.clientY; }, true);
  document.addEventListener('mouseup', e => {
    if (Math.abs(e.clientX - dx) + Math.abs(e.clientY - dy) >= 6 || e.detail >= 2) setTimeout(() => put(term.getSelection()), 0);
  }, true);

  if (off('clip')) return { keys: [] };
  const grab = () => {
    const b = term.buffer.active, out = [];
    for (let i = 0; i < b.length; i++) {
      const l = b.getLine(i);
      if (!l) continue;
      const s = l.translateToString(true);
      if (l.isWrapped && out.length) out[out.length - 1] += s; else out.push(s);
    }
    return out.join('\n').replace(/\n+$/, '');
  };
  const txt = el('pre', { id: 'ccclip-txt' });
  const all = el('button', { type: 'button', id: 'ccclip-all', textContent: 'copy all' });
  const ov = el('div', { id: 'ccclip' }, el('div', { id: 'ccclip-bar' }, all, el('button', { type: 'button', id: 'ccclip-x', textContent: 'close' }),
    el('span', { id: 'ccclip-hint' }, 'long-press to select', el('br'), 'scroll up first for history')), txt);
  document.body.append(ov);
  ov.querySelector('#ccclip-x').addEventListener('click', () => ov.classList.remove('on'));
  all.addEventListener('click', () => (navigator.clipboard?.writeText(txt.textContent) ?? Promise.reject()).then(() => flash(all, 'copied ✓'), () => flash(all, '✗ select manually')));
  return { keys: [
    key('⧉', () => { txt.textContent = grab(); ov.classList.add('on'); term.blur(); }, 'pointerup'), // drop the keyboard so the whole snapshot is visible
    key('📋', b => (navigator.clipboard?.readText ? navigator.clipboard.readText().then(x => (x ? term.paste(x) : flash(b, 'empty')), () => flash(b, '✗ blocked')) : flash(b, '✗')), 'pointerup'),
  ] };
}
