// keys.mjs — the grid chords (spec §5), one decoder for the shell and for the terminal page's forwarder. `code`, not `key`: with Shift held
// `key` is '!' for the 1 key on a US layout. Close is X, never W: ⌘⇧W / Ctrl⇧W close the browser window and cannot be intercepted.
export const MODS = { mac: '⌘⇧', win: 'Ctrl⇧', alt: 'Alt' };
export const detectMod = (platform = navigator.platform) => (/^Mac|^iPad/.test(platform) ? 'mac' : 'win');
const held = (e, mod) => (mod === 'mac' ? e.metaKey && e.shiftKey && !e.ctrlKey && !e.altKey
  : mod === 'win' ? e.ctrlKey && e.shiftKey && !e.metaKey && !e.altKey
  : e.altKey && !e.ctrlKey && !e.metaKey && !e.shiftKey);
const CODES = { ArrowLeft: 'pane:-1', ArrowRight: 'pane:1', ArrowUp: 'tabrel:-1', ArrowDown: 'tabrel:1', KeyZ: 'zoom', KeyX: 'close' };
export function chordOf(e, mod) {
  if (!held(e, mod)) return null;
  const d = /^Digit([1-9])$/.exec(e.code);
  return d ? 'tab:' + d[1] : CODES[e.code] || null;
}
