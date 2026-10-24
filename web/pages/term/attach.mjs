// attach.mjs — image or file attach (MAP 4.2 B-40; ledger K-23): the menu's Attach file (photo library, camera or Files), a pasted file, a dropped file.
// All POST the bytes to /shot with the real name in x-name; the reply's path is pasted into the prompt, the way dropping a file on a native
// terminal types its path. Claude then reads the file from that path (an image path becomes Claude's [Image #N]). Each image sent from this page
// is kept as a local blob URL in `recent`, in upload order: the composer's preview shows it with no download.
import { el, say } from './dom.mjs';

export function attach(/** @type {import('@xterm/xterm').Terminal} */ term, put = t => term.paste(t)) {
  let busy = false;
  /** @type {{ url: string, name: string, path: string }[]} */
  const recent = [];
  const up = f => {
    if (!f || busy) return;
    busy = true; say('uploading ' + (f.name || 'file') + '…');
    fetch('/shot', { method: 'POST', body: f, headers: { 'content-type': f.type || 'application/octet-stream', 'x-name': encodeURIComponent(f.name || '') } })
      .then(r => { if (!r.ok) throw new Error('HTTP ' + r.status); return r.json(); })
      .then(j => { busy = false; say('attached ' + (f.name || 'file')); if (/^image\//.test(f.type)) recent.push({ url: URL.createObjectURL(f), name: f.name || '', path: j.path }); put(j.path + ' '); },
        e => { busy = false; say('upload failed: ' + e.message); });
  };
  // no accept: iOS then offers the Photo Library, the Camera AND Files. iOS draws that menu at the input's place, so the input is not parked off
  // screen (the menu then floated over the middle of the conversation, the phone 2026-10-24): it is put on the control the user came from
  // (the key bar's ⋯) before it opens, invisible and untouchable
  const inp = el('input', { type: 'file', id: 'ccfile', style: 'position:fixed;left:0;bottom:0;width:1px;height:1px;opacity:0;pointer-events:none' });
  inp.addEventListener('change', () => { up(inp.files[0]); inp.value = ''; });
  document.body.append(inp);
  document.addEventListener('paste', e => {
    for (const it of e.clipboardData?.items || []) if (it.kind === 'file') { e.preventDefault(); e.stopImmediatePropagation(); up(it.getAsFile()); return; }
  }, true);
  document.addEventListener('dragover', e => e.preventDefault());
  document.addEventListener('drop', e => { e.preventDefault(); up(e.dataTransfer?.files?.[0]); });
  // called from a plain click (the menu's tile): the file picker needs a full user activation
  const pick = () => {
    const r = document.querySelector('#cckb > button[data-k="Menu"]')?.getBoundingClientRect();
    if (r) Object.assign(inp.style, { left: Math.round(r.left + r.width / 2) + 'px', top: Math.round(r.top) + 'px', bottom: '' });
    inp.click();
  };
  return { pick, recent };
}
