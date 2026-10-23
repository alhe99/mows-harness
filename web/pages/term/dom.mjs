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
