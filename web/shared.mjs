// shared.mjs — what all four of the History, System, Device and Session views share: the icon element, the action-form handler, the API hook
// and the formatters the legacy page had inline. Nothing here touches the document at load.
import { h } from 'preact';
import { useState, useEffect, useRef } from 'preact/hooks';
import { store } from './store.mjs';

// the legacy ICO glyphs are path data (24 grid, 2 px round strokes); each view keeps the ones it draws, the 14 px ones sized by the caller
export const Icon = ({ d, size = 16, solid = false }) => h('svg', { width: size, height: size, viewBox: '0 0 24 24', 'aria-hidden': 'true',
  ...(solid ? { fill: 'currentColor', stroke: 'none' } : { fill: 'none', stroke: 'currentColor', 'stroke-width': 2, 'stroke-linecap': 'round', 'stroke-linejoin': 'round' }),
  dangerouslySetInnerHTML: { __html: d } });

/** '/next' while the current UI still serves '/'; '' once phase 05 swaps them. */
export const base = () => document.documentElement.dataset.base || '';
export const relS = (ms, now = Date.now()) => { const s = (now - ms) / 1000; return s < 90 ? 'now' : s < 5400 ? (s / 60 | 0) + 'm' : s < 129600 ? (s / 3600 | 0) + 'h' : (s / 86400 | 0) + 'd'; };
export const abs = t => t ? new Date(t).toISOString().slice(0, 16).replace('T', ' ') + 'Z' : '—';

/** Every action is a real <form method=post> that PRG-redirects and works as one without script. This sends it with fetch instead, so the view
 *  keeps its place, then calls after(). With json the server answers with its result as JSON instead of the 303 (the reclaim and restart forms
 *  carry theirs there) and after() gets it. */
export const act = (after, json = false) => async e => {
  const f = /** @type {HTMLFormElement} */ (e.currentTarget);
  e.preventDefault();
  if (f.classList.contains('busy')) return;
  f.classList.add('busy');
  try {
    const r = await fetch(f.action, { method: 'POST', body: new URLSearchParams(/** @type {any} */ (new FormData(f))), redirect: 'manual', headers: json ? { accept: 'application/json' } : {} });
    f.closest('details')?.removeAttribute('open');
    await after?.(json ? await r.json() : null);
  } catch { /* offline: the busy state clears and the form stays for another try */ }
  f.classList.remove('busy');
};
export const hid = (name, value) => h('input', { type: 'hidden', name, value });

/** GET url through the store's cache (the boot snapshot and a tab link's prefetch seed it, so a first frame has data); reload() refetches past
 *  it. The data of the previous url stays on screen until the next one arrives. Returns [data, reload, error]. */
export function useApi(url) {
  const [st, set] = useState(() => ({ d: store.peek(url), e: '' }));
  const cur = useRef(url);
  cur.current = url;
  const reload = (force = true) => store.getJson(url, force).then(
    d => { if (cur.current === url) set({ d, e: '' }); return d; },
    e => { if (cur.current === url) set(s => ({ ...s, e: String(e.message || e) })); });
  useEffect(() => { reload(false); }, [url]);
  return [st.d, reload, st.e];
}

/** True once the signal has changed since `data` was read: from then on the stream's value, not the fetched page's own, is the newer one. */
export function usePatched(data, sig) {
  const seen = useRef(/** @type {any} */ (null));
  if (!seen.current || seen.current.d !== data) seen.current = { d: data, v: sig.peek() };
  return sig.value !== seen.current.v;
}
