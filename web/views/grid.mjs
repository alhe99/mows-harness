// grid.mjs — the /grid view (docs/superpowers/specs/2026-10-11-grid-view-design.md): sidebar of the fleet, a tab strip, 1–6 panes per tab,
// each pane ONE iframe of the terminal document mounted once and never re-inserted (moving an iframe in the DOM reloads it: pane wrappers
// keep creation order, only the strip reorders). Pure state in ../grid/state.mjs, chords in ../grid/keys.mjs. Desktop only.
import { h } from 'preact';
import { useEffect, useLayoutEffect, useState } from 'preact/hooks';
import { signal } from '@preact/signals';
import { store } from '../store.mjs';
import * as S from '../grid/state.mjs';
import { detectMod, MODS } from '../grid/keys.mjs';
import { CSS } from '../grid/css.mjs';

const GLYPH = { 'needs-you': '◉', working: '●', paused: '⏸', idle: '○' };
const WORD = { 'needs-you': 'waiting', working: 'working', paused: 'paused', idle: 'idle' };
const ORDER = { 'needs-you': 0, working: 1, paused: 2, idle: 3 };
const relStr = ms => { const s = (Date.now() - ms) / 1000; return s < 90 ? 'now' : s < 5400 ? (s / 60 | 0) + 'm' : s < 129600 ? (s / 3600 | 0) + 'h' : (s / 86400 | 0) + 'd'; };
const mint = () => [...crypto.getRandomValues(new Uint8Array(4))].map(b => b.toString(16).padStart(2, '0')).join('');
const desktop = () => matchMedia('(pointer:fine)').matches && innerWidth >= 1024;

const st = signal(/** @type {S.State|null} */ (null));
const filter = signal('');
const parked = signal(/** @type {Set<string>} */ (new Set()));
const tick = signal(0);
const tabids = new Map();   // session name -> this pane's 8-hex tab id, minted once per mount (never persisted: a reload is a new client)
let saveT = 0;
const dispatch = f => { const next = f(st.value); if (next !== st.value) st.value = next; };
const labelOf = (f, name) => (f ? f.label || f.proj || f.name : name.replace(/^cc-[^-]+-/, ''));
const fleetMap = () => new Map(store.fleet.value.map(f => [f.name, f]));
// a drag: pointer capture on the handle, every iframe ignores the pointer meanwhile (#grid.drag); onMove gets the pointer's x, which becomes
// the handle's left edge. It ends on pointerup, pointercancel or a lost capture (released off the window), whichever comes first.
const ENDS = ['pointerup', 'pointercancel', 'lostpointercapture'];
function drag(e, onMove) {
  if (e.button !== 0) return;
  const el = /** @type {HTMLElement} */ (e.currentTarget), g = document.getElementById('grid');
  el.setPointerCapture(e.pointerId);
  g?.classList.add('drag');
  const move = ev => onMove(ev.clientX);
  const end = () => { el.removeEventListener('pointermove', move); for (const n of ENDS) el.removeEventListener(n, end); g?.classList.remove('drag'); };
  el.addEventListener('pointermove', move); for (const n of ENDS) el.addEventListener(n, end);
  e.preventDefault();
}
const postMod = () => { for (const f of document.querySelectorAll('iframe.gfr')) /** @type {HTMLIFrameElement} */ (f).contentWindow?.postMessage({ t: 'grid-mod', mod: st.value.mod }, location.origin); };

function Row({ f, open }) {
  const s = st.value, tab = s.tabs.find(t => t.id === s.active), full = !!tab && tab.panes.length >= S.CAPS.panes && !tab.panes.includes(f.name);
  return h('div', { class: 'gr', 'data-name': f.name, 'data-state': f.state, 'data-open': open ? '1' : undefined, tabIndex: 0,
      onClick: e => dispatch(s => (e.shiftKey ? S.split(s, f.name) : S.openTab(s, f.name))),
      onKeyDown: e => { if (e.key === 'Enter') dispatch(s => S.openTab(s, f.name)); } },
    h('span', { class: `fli fli-${f.state}`, 'data-f': 'glyph', 'aria-hidden': 'true' }, GLYPH[f.state]),
    h('span', { class: 'lb', 'data-f': 'label' }, labelOf(f, f.name)),
    h('button', { class: 'gsplit', type: 'button', title: full ? `at most ${S.CAPS.panes} panes in a tab` : 'split beside the current panes', 'data-full': full ? '1' : undefined,
      onClick: e => { e.stopPropagation(); dispatch(s => S.split(s, f.name)); } }, '⫿ split'),
    h('span', { class: 'fst', 'data-f': 'meta' }, `${WORD[f.state]} ${relStr(f.rel)}`),
    f.snippet ? h('span', { class: 'fsnip', 'data-f': 'snip' }, f.snippet) : null);
}

function Sidebar() {
  tick.value;
  const s = st.value, q = filter.value.trim().toLowerCase();
  const isOpen = name => !!S.find(s, name);
  const show = f => !q || `${labelOf(f, f.name)} ${f.proj} ${f.snippet}`.toLowerCase().includes(q);
  const sorted = [...store.fleet.value].sort((a, b) => ORDER[a.state] - ORDER[b.state] || b.rel - a.rel);
  let list;
  if (s.grouped) {
    const groups = new Map();
    for (const f of sorted) { const k = f.proj || 'other'; if (!groups.has(k)) groups.set(k, []); groups.get(k).push(f); }
    const gs = [...groups.entries()].sort((a, b) => ORDER[a[1][0].state] - ORDER[b[1][0].state] || a[0].localeCompare(b[0]));
    list = gs.map(([proj, fs]) => { const vis = fs.filter(show); if (!vis.length) return null; const needs = fs.filter(f => f.state === 'needs-you').length;
      return h('details', { class: 'gg', 'data-proj': proj, open: true, key: proj }, h('summary', null, needs ? `${proj} · ${needs}` : proj), vis.map(f => h(Row, { key: f.name, f, open: isOpen(f.name) }))); });
  } else list = sorted.filter(show).map(f => h(Row, { key: f.name, f, open: isOpen(f.name) }));
  return h('aside', { id: 'gsb' },
    h('div', { class: 'ghd' },
      h('input', { type: 'search', 'data-f': 'filter', placeholder: 'filter…', 'aria-label': 'filter sessions', autocomplete: 'off', value: filter.value, onInput: e => { filter.value = e.currentTarget.value; } }),
      h('button', { id: 'ggroup', type: 'button', title: 'group by project', onClick: () => dispatch(s => S.setGrouped(s, !s.grouped)) }, s.grouped ? 'flat' : 'grouped'),
      h('select', { id: 'gmod', 'aria-label': 'shortcut modifier', value: s.mod, onChange: e => { dispatch(s => S.setMod(s, e.currentTarget.value)); postMod(); } },
        Object.entries(MODS).map(([k, v]) => h('option', { value: k }, v)))),
    h('div', { class: 'glist' }, list));
}

function Pane({ tab, i, name, f, hiddenByZoom, cell }) {
  if (!tabids.has(name)) tabids.set(name, mint());
  const on = tab.focus === i, state = f ? f.state : 'ended';
  return h('div', { class: `gp${on ? ' on' : ''}${state === 'needs-you' ? ' needs' : ''}${f ? '' : ' ended'}`, 'data-name': name, style: hiddenByZoom ? 'display:none' : cell,
      onPointerDown: () => dispatch(s => S.focusPane(s, tab.id, i)) },
    h('header', { class: 'gph' }, h('b', null, labelOf(f, name)), h('span', null, f ? WORD[f.state] : 'ended'), h('span', { class: 'gsp' }),
      h('button', { class: 'gzoom', type: 'button', title: 'zoom', onClick: () => dispatch(s => S.toggleZoom(S.focusPane(s, tab.id, i))) }, tab.zoom === i ? '⤡' : '⤢'),
      h('button', { class: 'gclose', type: 'button', title: 'close pane', onClick: () => dispatch(s => S.closePane(s, tab.id, i)) }, '×')),
    h('iframe', { class: 'gfr', src: `/term/?arg=attach&arg=${encodeURIComponent(name)}&arg=${tabids.get(name)}&v=3`, title: name, onLoad: postMod }));
}

// the handle between columns k and k+1: the pointer's x as its new left edge sets column k's width, the pair keeps its sum, each stays >= minCol px
function colDrag(e, tab, k) {
  const g = /** @type {HTMLElement} */ (e.currentTarget).parentElement, n = tab.cols.length, W = g.clientWidth - 6 * (n - 1), left = g.getBoundingClientRect().left + g.clientLeft;
  const before = tab.cols.slice(0, k).reduce((a, b) => a + b, 0) * W, pair = (tab.cols[k] + tab.cols[k + 1]) * W, min = S.CAPS.minCol;
  drag(e, x => { const px = Math.min(Math.max(min, x - left - before - 6 * k), pair - min), cols = [...tab.cols]; cols[k] = px / W; cols[k + 1] = (pair - px) / W; dispatch(s => S.setCols(s, tab.id, cols)); });
}

// panes are placed by explicit grid cells and the handles come after every pane in the DOM: a handle appearing or going (the column count
// changes with the pane count) never shifts or reorders a pane wrapper, so no iframe is moved. Handles exist only while the tab is not zoomed.
function Tab({ tab, active, fm }) {
  const isParked = parked.value.has(tab.id), zoomed = tab.zoom != null, n = tab.cols.length, rows = Math.ceil(tab.panes.length / n) || 1;
  const cols = zoomed ? '1fr' : tab.cols.map(c => `minmax(${S.CAPS.minCol}px,${c}fr)`).join(' 6px ');
  return h('div', { class: 'gw', 'data-tab': tab.id, hidden: !active, style: `grid-template-columns:${cols};grid-template-rows:repeat(${zoomed ? 1 : rows},minmax(0,1fr))` },
    isParked ? h('div', { class: 'gpark' }, 'parked · click the tab to reattach') : [
      ...tab.panes.map((name, i) => h(Pane, { key: name, tab, i, name, f: fm.get(name), hiddenByZoom: zoomed && tab.zoom !== i, cell: zoomed ? '' : `grid-area:${(i / n | 0) + 1}/${2 * (i % n) + 1}` })),
      ...(zoomed ? [] : tab.cols.slice(1).map((_, k) => h('div', { class: 'gh', 'data-k': k, key: 'h' + k, style: `grid-column:${2 * k + 2}`, onPointerDown: e => colDrag(e, tab, k) })))]);
}

function Strip({ fm }) {
  const s = st.value;
  const worst = t => t.panes.reduce((w, n) => { const k = fm.get(n)?.state || 'idle'; return ORDER[k] < ORDER[w] ? k : w; }, 'idle');
  return h('nav', { id: 'gtabs' },
    s.tabs.map((t, k) => h('div', { class: `gt${t.id === s.active ? ' on' : ''}`, 'data-id': t.id, key: t.id, onClick: () => { parked.value = new Set([...parked.value].filter(x => x !== t.id)); dispatch(s => S.setActive(s, t.id)); } },
      h('span', { class: 'gdot', 'data-state': worst(t) }), t.panes.map(n => labelOf(fm.get(n), n)).join(' | '),
      h('button', { class: 'gx', type: 'button', 'aria-label': 'close tab', onClick: e => { e.stopPropagation(); dispatch(s => { let x = s; for (let i = t.panes.length - 1; i >= 0; i--) x = S.closePane(x, t.id, i); return x; }); } }, '×'))),
    h('a', { class: 'gnew', href: `/term/?arg=menu&arg=&arg=${mint()}&v=3`, target: 't-menu', 'data-nw': 't-menu', title: 'new session (terminal picker)' }, '+'),
    h('span', { id: 'gnotice', hidden: !s.notice }, s.notice));
}

export default function Grid() {
  // desktop-ness is decided at mount and only ever turns on: a desktop window narrowed for a moment (snapped to half a screen) keeps its
  // panes, since unmounting them would drop every socket and reload every terminal; a window opened narrow mounts the grid once widened
  const [ok, setOk] = useState(desktop);
  useEffect(() => {
    if (ok) return;
    const on = () => { if (desktop()) setOk(true); }, mq = matchMedia('(pointer:fine)');
    addEventListener('resize', on); mq.addEventListener('change', on);
    return () => { removeEventListener('resize', on); mq.removeEventListener('change', on); };
  }, [ok]);
  useLayoutEffect(() => {
    if (!ok) return;
    const sheet = new CSSStyleSheet(); sheet.replaceSync(CSS);
    document.adoptedStyleSheets = [...document.adoptedStyleSheets, sheet];
    document.body.classList.add('gridv');
    const live = new Set(store.fleet.value.map(f => f.name));
    const { state, dropped } = S.load(localStorage, live, detectMod());
    st.value = dropped.length ? { ...state, notice: `dropped ${dropped.length} ended session${dropped.length === 1 ? '' : 's'}` } : state;
    /** @type {any} */ (window).__grid = { state: () => st.value, dispatch, fleet: () => store.fleet.value };
    return () => { document.adoptedStyleSheets = document.adoptedStyleSheets.filter(x => x !== sheet); document.body.classList.remove('gridv'); st.value = null; tabids.clear(); parked.value = new Set(); delete (/** @type {any} */ (window)).__grid; };
  }, [ok]);
  useEffect(() => {
    if (!ok) return;
    const un = st.subscribe(s => { if (!s) return; clearTimeout(saveT); saveT = setTimeout(() => S.save(localStorage, s), 250); });
    const t = setInterval(() => { tick.value++; }, 30000);
    return () => { un(); clearInterval(t); clearTimeout(saveT); };
  }, [ok]);
  if (!ok) return h('div', { 'data-view': 'grid-phone' }, 'The grid is a desktop view (a mouse and a window at least 1024 px wide). ', h('a', { href: '/' }, 'Back to sessions'));
  const s = st.value;
  if (!s) return null;
  const fm = fleetMap();
  return h('div', { id: 'grid', style: `--gsb:${s.sidebar}px` },
    h(Sidebar, null),
    h('div', { id: 'gh-sb', title: 'drag to resize · double-click to reset',
      onPointerDown: e => { const left = document.getElementById('grid').getBoundingClientRect().left; drag(e, x => dispatch(s => S.setSidebar(s, x - left))); },
      onDblClick: () => dispatch(s => S.setSidebar(s, 260)) }),
    h('main', { id: 'gmain' },
      h(Strip, { fm }),
      s.tabs.length ? s.tabs.map(t => h(Tab, { key: t.id, tab: t, active: t.id === s.active, fm })) : h('div', { class: 'gempty' }, 'Click a session on the left to open it here; "split" puts it beside the current panes.')));
}
