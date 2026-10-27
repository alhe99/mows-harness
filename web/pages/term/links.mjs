// links.mjs — a tap on a link opens it. xterm opens a link from mouse events (the hover finds it, the click opens it); a finger has no hover,
// and while the composer is up its touchend cancels the tap (it takes the keyboard), so a link on the phone opened nothing (2026-10-27). Here
// the link under a tap is looked up from the touch itself, in the capture phase ahead of the composer, and opened from it (a user gesture,
// which window.open needs). Both kinds: an OSC 8 hyperlink (Claude's markdown links and URLs; tmux forwards them with the `hyperlinks`
// terminal feature, infra/os/tmux.conf) and a bare URL in the row's text. ?links=off is the kill switch.

const URL_RE = /https?:\/\/[^\s"'<>`│]+/g;
const TRAIL = /[.,;:!?)\]}'"]+$/;

/** the http(s) link at viewport point (x, y) of the terminal, or '' */
export function linkAt(term, x, y) {
  const scr = term.element?.querySelector('.xterm-screen'), cell = term._core?._renderService?.dimensions?.css?.cell;
  if (!scr || !cell?.width) return '';
  const r = scr.getBoundingClientRect(), col = Math.floor((x - r.left) / cell.width), row = Math.floor((y - r.top) / cell.height);
  if (col < 0 || row < 0 || col >= term.cols || row >= term.rows) return '';
  const line = term.buffer.active.getLine(term.buffer.active.viewportY + row);
  if (!line) return '';
  // OSC 8: the cell's link id, xterm-internal (6.0: CellData.extended.urlId, CoreTerminal._oscLinkService); a version that moves them
  // throws or finds nothing, and the bare-URL match below still works
  try {
    const c = /** @type {any} */ (line.getCell(col)), id = c?.hasExtendedAttrs?.() && c.extended.urlId;
    const uri = id && term._core._oscLinkService.getLinkData(id)?.uri;
    if (uri && /^https?:\/\//i.test(uri)) return uri;
  } catch { /* fall through */ }
  // a bare URL longer than the row wraps onto the next ones (isWrapped): match on the whole logical line, the tap at its offset in it
  const buf = term.buffer.active;
  let y0 = buf.viewportY + row, at = col;
  while (y0 > 0 && buf.getLine(y0)?.isWrapped) { y0--; at += term.cols; }
  let text = '';
  for (let y = y0, l = buf.getLine(y); l && (y === y0 || l.isWrapped); l = buf.getLine(++y)) text += l.translateToString(false);
  for (const m of text.matchAll(URL_RE)) {
    const u = m[0].replace(TRAIL, '');
    if (at >= m.index && at < m.index + u.length) return u;
  }
  return '';
}

// iOS, the home-screen app: its scope is this whole origin, so a link here opened inside the app, full screen, with no browser bar and no way
// back, and the share page (/p/) has no chrome of its own (2026-10-27). Share links go to Safari instead (x-safari-https:, iOS 17+): the
// address bar, its share button, and the app one swipe away. The dashboard's own pages stay in the app (Safari has none of its sign-in cookies).
export const open = uri => {
  const u = new URL(uri);
  if (/** @type {any} */ (navigator).standalone && u.origin === location.origin && u.pathname.startsWith('/p/')) location.href = 'x-safari-' + uri;
  else window.open(uri, '_blank', 'noopener');
};

export function tapLinks(term) {
  let sx = 0, sy = 0;
  document.addEventListener('touchstart', e => { sx = e.touches[0].clientX; sy = e.touches[0].clientY; }, { capture: true, passive: true });
  document.addEventListener('touchend', e => {
    const p = e.changedTouches[0];
    if (!p || e.touches.length || Math.abs(p.clientX - sx) + Math.abs(p.clientY - sy) > 10 || !term.element?.contains(/** @type {Node} */ (e.target))) return;
    const uri = linkAt(term, p.clientX, p.clientY);
    if (!uri) return;
    e.preventDefault(); e.stopImmediatePropagation(); // no composer focus, no emulated click for xterm to act on as well
    open(uri);
  }, { capture: true });
}
