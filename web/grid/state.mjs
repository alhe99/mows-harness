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

export const empty = mod => ({ sidebar: 256, sb: true, grouped: true, order: [], mod, active: '', n: 0, notice: '', tabs: [] }); // sb: the sidebar is shown; order: see placeRow

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
// a picker pane: the terminal picker (web-term.sh menu) in a tab of its own, named 'new:<tab n>' (a ':' is not a tmux name). The view
// polls /a/tab for the session it ends up in and renames the pane to that session; a reload drops picker panes silently (the tab id behind
// the picker is gone with the page). openTab's caps and notices apply.
export const isPicker = name => name.startsWith('new:');
export const newPane = s => openTab(s, 'new:' + (s.n + 1));
export function renamePane(s, from, to) {
  const at = find(s, from); if (!at || from === to) return s;
  const dup = find(s, to); if (dup) s = closePane(s, dup.tab, dup.i); // the session was open elsewhere: that pane goes, never a second socket
  const a = find(s, from);
  return upd({ ...s, active: a.tab }, a.tab, t => ({ ...t, panes: t.panes.map(n => (n === from ? to : n)) }));
}
export const focusPane = (s, id, i) => upd({ ...s, active: id }, id, t => ({ ...t, focus: clamp(i, 0, t.panes.length - 1) }));
export const setActive = (s, id) => (tabAt(s, id) < 0 ? s : { ...s, active: id, notice: '' });
export function stepTab(s, d) { const k = tabAt(s, s.active); if (k < 0 || s.tabs.length < 2) return s; return setActive(s, s.tabs[(k + d + s.tabs.length) % s.tabs.length].id); }
// while zoomed the zoom follows the focus: the pane that takes the keyboard (and a later close) is always the one on screen
export function stepPane(s, d) { const k = tabAt(s, s.active); if (k < 0) return s; const t = s.tabs[k], i = (t.focus + d + t.panes.length) % t.panes.length; return upd(s, t.id, x => ({ ...x, focus: i, zoom: x.zoom == null ? null : i })); }
export function toggleZoom(s) { const k = tabAt(s, s.active); if (k < 0) return s; return upd(s, s.active, t => ({ ...t, zoom: t.zoom == null ? t.focus : null })); }
// a tab dropped onto the panes of another: its panes join that tab (appended, even columns, the first of them focused) and it closes.
// ponytail: the moved panes' iframes change parent in the DOM and reload, the only DOM move the grid makes; a split + close would reload them too.
export function mergeTab(s, from, into) {
  const a = tabAt(s, from), b = tabAt(s, into); if (a < 0 || b < 0 || from === into) return s;
  const src = s.tabs[a];
  if (src.panes.length + s.tabs[b].panes.length > CAPS.panes) return { ...s, notice: `at most ${CAPS.panes} panes in a tab` };
  return upd({ ...s, tabs: s.tabs.filter(t => t.id !== from), active: into }, into, t => ({ ...t, panes: [...t.panes, ...src.panes], cols: [], focus: t.panes.length, zoom: null }));
}
// the opposite of a merge: pane i leaves its tab for a new tab of its own, placed right after it and made active (its iframe reloads, see mergeTab)
export function detachPane(s, id, i) {
  const k = tabAt(s, id); if (k < 0) return s;
  const t = s.tabs[k], name = t.panes[i]; if (t.panes.length < 2 || !name) return s;
  if (s.tabs.length >= CAPS.tabs) return { ...s, notice: `at most ${CAPS.tabs} tabs` };
  const nid = 't' + (s.n + 1), tabs = [...s.tabs]; tabs.splice(k + 1, 0, { id: nid, panes: [name], cols: [1], focus: 0, zoom: null });
  return upd({ ...s, n: s.n + 1, tabs, active: nid }, id, x => ({ ...x, panes: x.panes.filter((_, j) => j !== i), cols: [], focus: i < x.focus ? x.focus - 1 : x.focus, zoom: null }));
}
export function moveTab(s, from, to) { const tabs = [...s.tabs]; const [t] = tabs.splice(from, 1); tabs.splice(to, 0, t); return { ...s, tabs }; }
export const setCols = (s, id, cols) => upd(s, id, t => ({ ...t, cols: norm(cols) }));
export const setSidebar = (s, px) => ({ ...s, sidebar: clamp(Math.round(px), CAPS.sidebar[0], CAPS.sidebar[1]) });
export const setMod = (s, mod) => ({ ...s, mod });
export const setGrouped = (s, grouped) => ({ ...s, grouped });
export const toggleSidebar = s => ({ ...s, sb: !s.sb });
export const setOrder = (s, order) => ({ ...s, order });
// the sidebar's own order: `order` holds the agent rows' names as last dragged; a name not in it ranks after them (Infinity), in the
// default order, so a new session still lands at the bottom. rankOf(order)(name) is the sort key.
export const rankOf = order => { const m = new Map(order.map((n, i) => [n, i])); return n => m.get(n) ?? Infinity; };
// a sidebar row dropped on another: `list` is the rows top to bottom (names, or the row elements), grp(row) its project group (flat: the row itself). It takes
// the target's place: dragged down it lands after the target, up before it. Dropped in another group, its whole group moves past that group.
export function placeRow(list, from, to, grp = n => n) {
  const i = list.indexOf(from), j = list.indexOf(to); if (i < 0 || j < 0 || i === j) return list;
  const same = grp(to) === grp(from), of = x => list.filter(n => (same ? n === x : grp(n) === grp(x))), block = of(from), tg = of(to), rest = list.filter(n => !block.includes(n));
  rest.splice(rest.indexOf(j > i ? tg.at(-1) : tg[0]) + (j > i), 0, ...block);
  return rest;
}

export function load(storage, live, mod) {
  let raw = null;
  try { raw = JSON.parse(storage.getItem(KEY) || 'null'); } catch { raw = null; }
  if (!raw || typeof raw !== 'object' || !Array.isArray(raw.tabs)) return { state: empty(['mac', 'win', 'alt'].includes(raw?.mod) ? raw.mod : mod), dropped: [] }; // /system may store the mod before any tab exists
  const dropped = [];
  const tabs = raw.tabs.filter(t => t && typeof t === 'object').map(t => {
    const panes = (Array.isArray(t.panes) ? t.panes : []).filter(n => { if (typeof n !== 'string' || isPicker(n)) return false; const ok = live.has(n); if (!ok) dropped.push(n); return ok; });
    return fit({ id: String(t.id || ''), panes, cols: Array.isArray(t.cols) && t.cols.every(c => typeof c === 'number' && Number.isFinite(c) && c > 0) ? t.cols : [], focus: Math.max(0, Math.floor(Number(t.focus)) || 0), zoom: Number.isInteger(t.zoom) && t.zoom >= 0 ? t.zoom : null });
  }).filter(t => t.panes.length && /^t\d+$/.test(t.id));
  const n = Math.max(Number(raw.n) || 0, ...tabs.map(t => +t.id.slice(1)));
  const active = tabs.some(t => t.id === raw.active) ? raw.active : (tabs[0]?.id || '');
  const state = { sidebar: clamp(Number(raw.sidebar) || 256, CAPS.sidebar[0], CAPS.sidebar[1]), sb: raw.sb !== false, grouped: raw.grouped !== false, order: Array.isArray(raw.order) ? raw.order.filter(n => typeof n === 'string') : [], mod: ['mac', 'win', 'alt'].includes(raw.mod) ? raw.mod : mod, active, n, notice: '', tabs };
  return { state, dropped };
}
export function save(storage, s) {
  const { notice, ...rest } = s;
  try { storage.setItem(KEY, JSON.stringify(rest)); } catch { /* storage full or blocked: the layout is still on screen */ }
}
