// gridkeys.mjs — when this document is a pane of the shell's /grid view (framed, same origin), the grid chords (web/grid/keys.mjs) go up
// to the parent as { t: 'grid-key', key } and never reach the pty; everything else is the terminal's as before. The parent tells us the
// modifier with { t: 'grid-mod', mod } on load and on change. Not framed: no listener, no handler.
import { chordOf, detectMod } from '../../grid/keys.mjs';
export function gridKeys(term) {
  if (window.parent === window) return;
  let mod = detectMod();
  addEventListener('message', e => { if (e.origin === location.origin && e.data && e.data.t === 'grid-mod' && typeof e.data.mod === 'string') mod = e.data.mod; });
  term.attachCustomKeyEventHandler(e => {
    if (e.type !== 'keydown') return true;
    const key = chordOf(e, mod);
    if (!key) return true;
    e.preventDefault();
    parent.postMessage({ t: 'grid-key', key }, location.origin);
    return false;
  });
}
