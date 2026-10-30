// attach.mjs — image or file attach (MAP 4.2 B-40; ledger K-23): the menu's Attach file (photo library, camera or Files), a pasted file, a dropped file.
// All POST the bytes to /shot with the real name in x-name; the reply's path is pasted into the prompt, the way dropping a file on a native
// terminal types its path. On a desktop the composer's field takes it first, as a token in the text (composer.mjs attach). Claude then reads the file from that path (an image path becomes Claude's [Image #N]). Each image sent from this page
// is kept as a local blob URL in `recent`, in upload order: the composer's preview shows it with no download.
// Any other file's path goes in after `Attached file: `: a message that starts with `/` is a slash command to Claude, and it then adds none of a
// prompt's own extras, ultrathink's deeper reasoning among them (a .docx sent "please ultrathink" got none, 2026-10-26; checked live 2026-10-27)
import { el, say } from './dom.mjs';

/** @param {(path: string, f: File) => boolean} take the composer's field on a desktop (composer.mjs attach): true if it took the file */
export function attach(/** @type {import('@xterm/xterm').Terminal} */ term, take = (_path, _f) => false) {
  const put = t => term.paste(t);
  let busy = false;
  /** @type {{ url: string, name: string, path: string }[]} */
  const recent = [];
  const up = f => {
    if (!f || busy) return;
    busy = true; say('uploading ' + (f.name || 'file') + '…');
    fetch('/shot', { method: 'POST', body: f, headers: { 'content-type': f.type || 'application/octet-stream', 'x-name': encodeURIComponent(f.name || '') } })
      .then(r => { if (!r.ok) throw new Error('HTTP ' + r.status); return r.json(); })
      .then(j => { busy = false; say('attached ' + (f.name || 'file')); if (/^image\//.test(f.type)) recent.push({ url: URL.createObjectURL(f), name: f.name || '', path: j.path }); if (!take(j.path, f)) put((/\.(png|jpe?g|gif|webp)$/i.test(j.path) ? '' : 'Attached file: ') + j.path + ' '); },
        e => { busy = false; say('upload failed: ' + e.message); });
  };
  // no accept: iOS then offers the Photo Library, the Camera AND Files, in a menu it anchors to the TAP that opened it (not to this input: moving
  // the input changed nothing on the phone, 2026-10-24), which is why the composer's + opens it from the bottom bar
  const inp = el('input', { type: 'file', style: 'position:fixed;left:-9999px;width:1px;height:1px' });
  inp.addEventListener('change', () => { up(inp.files[0]); inp.value = ''; });
  document.body.append(inp);
  document.addEventListener('paste', e => {
    for (const it of e.clipboardData?.items || []) if (it.kind === 'file') { e.preventDefault(); e.stopImmediatePropagation(); up(it.getAsFile()); return; }
  }, true);
  document.addEventListener('dragover', e => e.preventDefault());
  document.addEventListener('drop', e => { e.preventDefault(); up(e.dataTransfer?.files?.[0]); });
  // called from a plain click (the menu's tile): the file picker needs a full user activation
  return { pick: () => inp.click(), recent };
}
