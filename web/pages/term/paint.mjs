// paint.mjs — the screen not repainting after a phone comes back to a live session (MAP 4.2 B-80; ledger B-12). ?paint=off turns it off.
// Only public API: term.refresh(0, rows - 1) (+ clearTextureAtlas) on visibilitychange / pageshow / focus / the first content / a new socket /
// a timer that returned late (iOS fires none of the events when the screen locks). A resume also kicks the reconnect, which is a no-op on a
// live socket. Resize bursts are coalesced 150 ms in term.mjs's fit(). The boot ladder: a buffer with no non-empty line 4, 8 and 15 s after
// load means the first frame was lost, so repaint, then kick, then reload (at most 2 per tab, sessionStorage ccpaint-r).
// NOT ported, on purpose: the old block's 1 Hz watchdog that reached into xterm's private _writeBuffer to restart a dead write loop. That
// loop died in xterm 5 when a resize landed mid-parse; the coalesced fit() keeps resizes off the parser, and nothing private is touched now.
import { off } from './dom.mjs';

/** the page's own boot stages go to the /z access-log sink as /z?t=termdiag&e=<event>&d=<detail>&ms=<since boot> */
export function diag(e, d = '') {
  try {
    const u = `/z?t=termdiag&e=${e}&d=${encodeURIComponent(String(d).slice(0, 120))}&ms=${Math.floor(performance.now())}`;
    navigator.sendBeacon ? navigator.sendBeacon(u) : fetch(u, { keepalive: true });
  } catch { /* a beacon is best effort */ }
}

const lines = term => { const b = term.buffer.active; let n = 0; for (let i = 0; i < b.length; i++) if (b.getLine(i)?.translateToString(true).trim()) n++; return n; };

export function paint(/** @type {import('@xterm/xterm').Terminal} */ term, client) {
  addEventListener('error', e => diag('jserr', `${e.message || '?'} @${(e.filename || '').split('/').pop()}:${e.lineno}`));
  addEventListener('unhandledrejection', e => diag('reject', e.reason));
  for (const ms of [3000, 9000]) setTimeout(() => { try { diag('buf' + ms, lines(term) + 'L'); } catch { /* terminal gone */ } }, ms);
  if (off('paint')) return;

  const dbg = /[?&]paintdbg=1\b/.test(location.search);
  let n = 0;
  const repaint = why => {
    try { term.clearTextureAtlas(); } catch { /* the DOM renderer has none */ }
    try { term.refresh(0, term.rows - 1); } catch { /* terminal gone */ }
    if (dbg) console.log('[ccpaint] repaint', ++n, why);
  };
  const resume = why => { requestAnimationFrame(() => repaint(why)); setTimeout(() => repaint(why + '/late'), 300); setTimeout(client.kick, 400); };
  for (const ty of ['visibilitychange', 'pageshow', 'focus']) (ty === 'visibilitychange' ? document : window).addEventListener(ty, () => { if (document.visibilityState === 'visible') resume(ty); });
  document.addEventListener('webglcontextrestored', () => resume('ctxrestored'), true); // fires on the canvas and does not bubble

  // the empty -> content transition: repaint right then (and once more), the cure for a full buffer under a blank glyph layer
  let had = false;
  term.onWriteParsed(() => { if (!had && lines(term)) { had = true; repaint('first-content'); setTimeout(() => repaint('first-content/late'), 1000); } });

  [4000, 8000, 15000].forEach((ms, step) => setTimeout(() => {
    if (lines(term)) { if (step === 0) try { sessionStorage.removeItem('ccpaint-r'); } catch { /* storage blocked */ } return; }
    if (dbg) console.log(`[ccpaint] buffer empty at ${ms} ms, rung ${step}`);
    if (step === 0) { repaint('settle-empty'); return; }
    if (step === 1) { client.kick(); return; }
    try { const r = +(sessionStorage.getItem('ccpaint-r') || 0); if (r < 2) { sessionStorage.setItem('ccpaint-r', String(r + 1)); location.reload(); } } catch { /* storage blocked: never loop */ }
  }, ms));

  // a timer that returns late: the page was frozen (screen lock fires no event on iOS); a socket that is not the first: we were away
  let last = Date.now(), ws = null, first = true;
  setInterval(() => {
    const now = Date.now();
    if (now - last > 2500) resume('frozen-' + (now - last) + 'ms');
    last = now;
    const w = client.socket;
    if (!w || w === ws) return;
    ws = w;
    if (first) { first = false; return; }
    if (w.readyState === 1) resume('ws-new'); else w.addEventListener('open', () => resume('ws-open'));
  }, 1000);
}
