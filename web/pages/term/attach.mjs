// attach.mjs — image or file attach (MAP 4.2 B-40; ledger K-23): the 📸 key (photo library, camera or Files), a pasted file, a dropped file.
// All POST the bytes to /shot with the real name in x-name; the reply's path is pasted into the prompt, the way dropping a file on a native
// terminal types its path. Claude then reads the file from that path.
import { el, flash } from './dom.mjs';

export function attach(/** @type {import('@xterm/xterm').Terminal} */ term) {
  let busy = false, btn;
  const up = f => {
    if (!f || busy) return;
    busy = true; if (btn) btn.textContent = '⌛';
    fetch('/shot', { method: 'POST', body: f, headers: { 'content-type': f.type || 'application/octet-stream', 'x-name': encodeURIComponent(f.name || '') } })
      .then(r => { if (!r.ok) throw new Error('HTTP ' + r.status); return r.json(); })
      .then(j => { busy = false; if (btn) btn.textContent = '📸'; term.paste(j.path + ' '); },
        () => { busy = false; if (btn) { btn.textContent = '📸'; flash(btn, '✗', 1800); } });
  };
  // no accept: iOS then offers the Photo Library, the Camera AND Files
  const inp = el('input', { type: 'file', style: 'position:fixed;left:-9999px;width:1px;height:1px' });
  inp.addEventListener('change', () => { up(inp.files[0]); inp.value = ''; });
  document.body.append(inp);
  document.addEventListener('paste', e => {
    for (const it of e.clipboardData?.items || []) if (it.kind === 'file') { e.preventDefault(); e.stopImmediatePropagation(); up(it.getAsFile()); return; }
  }, true);
  document.addEventListener('dragover', e => e.preventDefault());
  document.addEventListener('drop', e => { e.preventDefault(); up(e.dataTransfer?.files?.[0]); });
  // a plain click, with no pointerdown handling like the other keys have: the file picker needs a full user activation
  btn = el('button', { type: 'button', textContent: '📸' });
  btn.addEventListener('click', () => inp.click());
  return btn;
}
