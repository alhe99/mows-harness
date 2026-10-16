// gridkeys.mjs — xterm's one custom key handler. Shift+Enter is a line break, the same \n as Ctrl+J (xterm sends a plain \r for it, which
// submits). When this document is a pane of the shell's /grid view (framed, same origin), the grid chords (web/grid/keys.mjs) go up to the
// parent as { t: 'grid-key', key } and never reach the pty; the parent tells us the modifier with { t: 'grid-mod', mod } on load and on change.
import { chordOf, detectMod } from '../../grid/keys.mjs';
export function gridKeys(term) {
  const framed = window.parent !== window;
  let mod = detectMod();
  if (framed) addEventListener('message', e => { if (e.origin === location.origin && e.data && e.data.t === 'grid-mod' && typeof e.data.mod === 'string') mod = e.data.mod; });
  term.attachCustomKeyEventHandler(e => {
    if (e.key === 'Enter' && e.shiftKey && !e.ctrlKey && !e.altKey && !e.metaKey) { // all three event types, or the keypress still sends \r
      if (e.type === 'keydown') { e.preventDefault(); term.input('\n'); }
      return false;
    }
    if (!framed || e.type !== 'keydown') return true;
    const key = chordOf(e, mod);
    if (!key) return true;
    e.preventDefault();
    parent.postMessage({ t: 'grid-key', key }, location.origin);
    return false;
  });
}
