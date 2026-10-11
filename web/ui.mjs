// ui.mjs — helpers the agent views share. Same output as the /ui app's ui.mjs (rel, usd, Pill), written with h() instead of htm.
// No document access at module load: scripts/capability-check.mjs imports views that import this in Node.
import { h } from 'preact';
import { useEffect } from 'preact/hooks';

/** '/next' while the current UI still serves '/'; '' once phase 05 swaps them. */
export const base = () => (typeof document === 'undefined' ? '' : document.documentElement.dataset.base || '');
export async function getJSON(path) {
  const r = await fetch(path, { headers: { accept: 'application/json' } });
  if (!r.ok) throw new Error(`${path} -> ${r.status}`);
  return r.json();
}
export const usd = n => '$' + (+n || 0).toFixed(2);
export const rel = ms => {
  const s = (Date.now() - ms) / 1000;
  if (!ms || Number.isNaN(s)) return '';
  if (s < 60) return Math.max(0, Math.round(s)) + 's ago';
  if (s < 3600) return Math.round(s / 60) + 'm ago';
  if (s < 86400) return Math.round(s / 3600) + 'h ago';
  return Math.round(s / 86400) + 'd ago';
};
export const Pill = ({ state }) => h('span', { class: `pill st-${state || 'never'}` }, state || 'never');

/** The /ui pages carried body.uiapp (1088 px column, the chat card metrics); the shell's body is shared, so an agent view sets it while mounted. */
export function useUiapp(html = '') {
  useEffect(() => {
    document.body.classList.add('uiapp');
    if (html) document.documentElement.classList.add(html);
    return () => { document.body.classList.remove('uiapp'); if (html) document.documentElement.classList.remove(html); };
  }, []);
}
