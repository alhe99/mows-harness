// state.mjs — the grid view's layout state, pure: every function returns a new state. Persisted as localStorage['grid.v1'] by the view
// (spec §6). Pane entries are tmux session names; tab ids are 't<n>' from the counter `n`. `notice` is a one-line message for the strip
// (a refused cap, dropped sessions) and is never stored.
export const KEY = 'grid.v1';
export const CAPS = { panes: 6, tabs: 9, sidebar: [180, 480], minCol: 160, park: 600000 };
export const colsFor = n => (n <= 3 ? n : n === 4 ? 2 : 3);
const even = k => Array.from({ length: k }, () => 1 / k);
const norm = cols => { const t = cols.reduce((a, b) => a + b, 0) || 1; return cols.map(c => c / t); };
const fit = tab => { const k = colsFor(tab.panes.length); return { ...tab, cols: tab.cols.length === k ? tab.cols : even(k), focus: Math.min(tab.focus, tab.panes.length - 1), zoom: tab.zoom != null && tab.zoom < tab.panes.length ? tab.zoom : null }; };
const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
const tabAt = (s, id) => s.tabs.findIndex(t => t.id === id);
const upd = (s, id, f) => ({ ...s, notice: '', tabs: s.tabs.map(t => (t.id === id ? fit(f(t)) : t)) });

export const empty = mod => ({ sidebar: 260, grouped: true, mod, active: '', n: 0, notice: '', tabs: [] });

export function find(s, name) {
  for (const t of s.tabs) { const i = t.panes.indexOf(name); if (i >= 0) return { tab: t.id, i }; }
  return null;
}
export function openTab(s, name) {
  const at = find(s, name);
  if (at) return upd({ ...s, active: at.tab }, at.tab, t => ({ ...t, focus: at.i }));
  if (s.tabs.length >= CAPS.tabs) return { ...s, notice: `at most ${CAPS.tabs} tabs` };
  const id = 't' + (s.n + 1);
  return { ...s, n: s.n + 1, active: id, notice: '', tabs: [...s.tabs, { id, panes: [name], cols: [1], focus: 0, zoom: null }] };
}
export function split(s, name) {
  if (!s.active) return openTab(s, name);
  const at = find(s, name);
  if (at && at.tab === s.active) return upd(s, at.tab, t => ({ ...t, focus: at.i }));
  if (at) return openTab(s, name); // open in another tab: go there, never a second socket
  const tab = s.tabs[tabAt(s, s.active)];
  if (tab.panes.length >= CAPS.panes) return { ...s, notice: `at most ${CAPS.panes} panes in a tab` };
  return upd(s, s.active, t => ({ ...t, panes: [...t.panes, name], cols: [], focus: t.panes.length, zoom: null }));
}
export function closePane(s, id, i) {
  const k = tabAt(s, id); if (k < 0) return s;
  const t = s.tabs[k];
  if (t.panes.length <= 1) {
    const tabs = s.tabs.filter(x => x.id !== id);
    const active = s.active === id ? (tabs[Math.min(k, tabs.length - 1)]?.id || '') : s.active;
    return { ...s, tabs, active, notice: '' };
  }
  return upd(s, id, x => ({ ...x, panes: x.panes.filter((_, j) => j !== i), cols: [], focus: i < x.focus ? x.focus - 1 : x.focus, zoom: null }));
}
export const focusPane = (s, id, i) => upd({ ...s, active: id }, id, t => ({ ...t, focus: clamp(i, 0, t.panes.length - 1) }));
export const setActive = (s, id) => (tabAt(s, id) < 0 ? s : { ...s, active: id, notice: '' });
export function stepTab(s, d) { const k = tabAt(s, s.active); if (k < 0 || s.tabs.length < 2) return s; return setActive(s, s.tabs[(k + d + s.tabs.length) % s.tabs.length].id); }
// while zoomed the zoom follows the focus: the pane that takes the keyboard (and a later close) is always the one on screen
export function stepPane(s, d) { const k = tabAt(s, s.active); if (k < 0) return s; const t = s.tabs[k], i = (t.focus + d + t.panes.length) % t.panes.length; return upd(s, t.id, x => ({ ...x, focus: i, zoom: x.zoom == null ? null : i })); }
export function toggleZoom(s) { const k = tabAt(s, s.active); if (k < 0) return s; return upd(s, s.active, t => ({ ...t, zoom: t.zoom == null ? t.focus : null })); }
export function moveTab(s, from, to) { const tabs = [...s.tabs]; const [t] = tabs.splice(from, 1); tabs.splice(to, 0, t); return { ...s, tabs }; }
export const setCols = (s, id, cols) => upd(s, id, t => ({ ...t, cols: norm(cols) }));
export const setSidebar = (s, px) => ({ ...s, sidebar: clamp(Math.round(px), CAPS.sidebar[0], CAPS.sidebar[1]) });
export const setMod = (s, mod) => ({ ...s, mod });
export const setGrouped = (s, grouped) => ({ ...s, grouped });

export function load(storage, live, mod) {
  let raw = null;
  try { raw = JSON.parse(storage.getItem(KEY) || 'null'); } catch { raw = null; }
  if (!raw || typeof raw !== 'object' || !Array.isArray(raw.tabs)) return { state: empty(['mac', 'win', 'alt'].includes(raw?.mod) ? raw.mod : mod), dropped: [] }; // /system may store the mod before any tab exists
  const dropped = [];
  const tabs = raw.tabs.filter(t => t && typeof t === 'object').map(t => {
    const panes = (Array.isArray(t.panes) ? t.panes : []).filter(n => { const ok = typeof n === 'string' && live.has(n); if (!ok && typeof n === 'string') dropped.push(n); return ok; });
    return fit({ id: String(t.id || ''), panes, cols: Array.isArray(t.cols) && t.cols.every(c => typeof c === 'number' && Number.isFinite(c) && c > 0) ? t.cols : [], focus: Math.max(0, Math.floor(Number(t.focus)) || 0), zoom: Number.isInteger(t.zoom) && t.zoom >= 0 ? t.zoom : null });
  }).filter(t => t.panes.length && /^t\d+$/.test(t.id));
  const n = Math.max(Number(raw.n) || 0, ...tabs.map(t => +t.id.slice(1)));
  const active = tabs.some(t => t.id === raw.active) ? raw.active : (tabs[0]?.id || '');
  const state = { sidebar: clamp(Number(raw.sidebar) || 260, CAPS.sidebar[0], CAPS.sidebar[1]), grouped: raw.grouped !== false, mod: ['mac', 'win', 'alt'].includes(raw.mod) ? raw.mod : mod, active, n, notice: '', tabs };
  return { state, dropped };
}
export function save(storage, s) {
  const { notice, ...rest } = s;
  try { storage.setItem(KEY, JSON.stringify(rest)); } catch { /* storage full or blocked: the layout is still on screen */ }
}
