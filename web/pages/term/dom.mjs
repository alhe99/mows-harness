// dom.mjs — the few DOM helpers every key of the bar uses. No document access at load.

/** createElement with properties (or attributes when the name is not a property) and children */
export const el = (tag, props = {}, ...kids) => {
  const e = /** @type {any} */ (document.createElement(tag));
  for (const [k, v] of Object.entries(props)) k in e ? (e[k] = v) : e.setAttribute(k, v);
  e.append(...kids.filter(Boolean)); // a feature that is off (no pill on a desktop, no theme picker) passes null
  return e;
};
export const coarse = () => matchMedia('(pointer:coarse)').matches;
export const param = name => new URLSearchParams(location.search).get(name);
/** ?name=off is the kill switch of a feature that intercepts input */
export const off = name => param(name) === 'off';
export const store = {
  get: k => { try { return localStorage.getItem(k) || ''; } catch { return ''; } },
  set: (k, v) => { try { v ? localStorage.setItem(k, v) : localStorage.removeItem(k); } catch { /* storage blocked: the setting lasts until reload */ } },
};
/** a key of the bar: pointerdown is cancelled, which keeps the terminal's focus (and the on-screen keyboard); `act` runs on pointerdown, or on pointerup */
export const key = (label, act, on = 'pointerdown') => {
  const b = el('button', { type: 'button', textContent: label });
  b.addEventListener('pointerdown', e => { e.preventDefault(); e.stopPropagation(); if (on === 'pointerdown') act(b, e); });
  if (on === 'pointerup') b.addEventListener('pointerup', e => act(b, e));
  return b;
};
/** show `s` on a key for a moment, then restore its label */
export const flash = (b, s, ms = 1400) => {
  if (!b.dataset.l) b.dataset.l = b.textContent;
  b.textContent = s;
  clearTimeout(b._fl);
  b._fl = setTimeout(() => { b.textContent = b.dataset.l; }, ms);
};
/** a short status line over the terminal (#cctoast): what was copied, sent, uploaded */
export const say = m => {
  const t = document.getElementById('cctoast') || document.body.appendChild(el('div', { id: 'cctoast', role: 'status' }));
  t.textContent = m; t.classList.add('on');
  clearTimeout(t._t); t._t = setTimeout(() => t.classList.remove('on'), 1500);
};
/** an inline SVG icon from path data (24-unit box, stroked) */
export const icon = d => { const s = document.createElementNS('http://www.w3.org/2000/svg', 'svg'); s.setAttribute('viewBox', '0 0 24 24'); s.setAttribute('aria-hidden', 'true'); s.innerHTML = d; return s; };
/** a bottom sheet that follows the finger down, as a native one does: a drag that starts on the grab or header, or anywhere while nothing
 *  under the finger is scrolled, moves the panel and lightens the backdrop; let go past a quarter of its height, or flicked (0.5 px/ms), it
 *  closes (the CSS slide carries on from where it is), else it springs back. The flick is the speed over the last 100 ms, none when the
 *  finger rested before it let go. Up, sideways, or inside scrolled content: the content scrolls. */
export function dragToClose(sheet, pan, close) {
  let y0 = 0, x0 = 0, dy = 0, mode = '', trail = []; // mode: '' undecided, 'drag', 'no'; trail: the last 100 ms of [time, dy]
  const scrolled = el => { for (let n = el; n && n !== sheet; n = n.parentElement) if (n.scrollTop > 0) return true; return false; };
  const set = (y, anim) => {
    pan.style.transition = anim ? 'transform .25s cubic-bezier(.32,.72,0,1)' : 'none';
    pan.style.transform = y ? `translateY(${y}px)` : '';
    sheet.style.backgroundColor = y ? `rgba(0,0,0,${(0.6 * Math.max(0, 1 - y / pan.offsetHeight)).toFixed(3)})` : '';
  };
  pan.addEventListener('touchstart', e => {
    const p = e.touches[0]; y0 = p.clientY; x0 = p.clientX; dy = 0; trail = [];
    mode = e.touches.length > 1 ? 'no' : e.target.closest('.grab,.hd,.dh') || !scrolled(e.target) ? '' : 'no';
  }, { passive: true });
  pan.addEventListener('touchmove', e => {
    if (mode === 'no') return;
    const p = e.touches[0], d = p.clientY - y0;
    if (!mode) { if (Math.abs(d) < 6 && Math.abs(p.clientX - x0) < 6) return; mode = d > 0 && Math.abs(d) > Math.abs(p.clientX - x0) ? 'drag' : 'no'; if (mode === 'no') return; }
    e.preventDefault(); // the panel moves, not its content, nor the page
    dy = Math.max(0, d); trail = [...trail.filter(([tt]) => e.timeStamp - tt < 100), [e.timeStamp, dy]]; set(dy, false);
  }, { passive: false });
  const end = e => {
    if (mode !== 'drag') { mode = ''; return; }
    mode = '';
    const [a, z] = [trail[0], trail[trail.length - 1]], v = z && e.timeStamp - z[0] < 100 && z[0] > a[0] ? (z[1] - a[1]) / (z[0] - a[0]) : 0;
    if (dy > pan.offsetHeight / 4 || v > 0.5) { // at once, not a frame later (WebKit under load left the panel 400 px down for the next open): the slide starts from the painted spot
      pan.style.transition = ''; pan.style.transform = ''; close(); setTimeout(() => { sheet.style.backgroundColor = ''; }, 300); // the backdrop fades from where it is
    }
    else { set(0, true); setTimeout(() => { if (!mode) pan.style.transition = ''; }, 260); }
  };
  pan.addEventListener('touchend', end);
  pan.addEventListener('touchcancel', end);
}
