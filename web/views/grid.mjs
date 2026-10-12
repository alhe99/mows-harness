// grid.mjs — the /grid view (docs/superpowers/specs/2026-10-11-grid-view-design.md): sidebar of the fleet, a tab strip, 1–6 panes per tab,
// each pane ONE iframe of the terminal document mounted once and never re-inserted (moving an iframe in the DOM reloads it: pane wrappers
// keep creation order, only the strip reorders). Pure state in ../grid/state.mjs, chords in ../grid/keys.mjs. Desktop only.
import { h } from 'preact';
import { useEffect, useLayoutEffect, useState } from 'preact/hooks';
import { signal } from '@preact/signals';
import { store } from '../store.mjs';
import { hid } from '../shared.mjs';
import * as S from '../grid/state.mjs';
import { chordOf, detectMod, MODS } from '../grid/keys.mjs';
import { CSS } from '../grid/css.mjs';
import { base } from '../shared.mjs';
// the shell's header is hidden on /grid (its row goes to the panes); these links at the strip's right end are the pill nav's, minus Grid
const NAV = [['Sessions', '/'], ['History', '/history'], ['System', '/system'], ['Device', '/device'], ['Agents', '/agents']];

// the Figma frame's icons (lucide strokes at 12/14 px), stroke colours as designed; hover brightens them in css.mjs
const svg = (sz, stroke, ds) => h('svg', { width: sz, height: sz, viewBox: `0 0 ${sz} ${sz}`, fill: 'none', 'aria-hidden': 'true' }, ds.map(d => h('path', { d, stroke, 'stroke-width': sz === 12 ? 1 : 1.16667, 'stroke-linecap': 'round', 'stroke-linejoin': 'round' })));
const GLYPH = { 'needs-you': '◉', working: '●', paused: '⏸', idle: '○' }; // the sidebar rows (tokens.css .fli-*)
const I = {
  x12: () => svg(12, '#52525C', ['M9 3L3 9', 'M3 3L9 9']),
  plus: () => svg(14, '#52525C', ['M2.91667 7H11.0833', 'M7 2.91667V11.0833']),
  expand: () => svg(14, '#858585', ['M8.75 1.75H12.25V5.25', 'M12.25 1.75L8.16667 5.83333', 'M1.75 12.25L5.83333 8.16667', 'M5.25 12.25H1.75V8.75']),
  shrink: () => svg(14, '#858585', ['M2.33333 8.16667H5.83333V11.6667', 'M11.6667 5.83333H8.16667V2.33333', 'M8.16667 5.83333L12.25 1.75', 'M1.75 12.25L5.83333 8.16667']),
  x14: () => svg(14, '#858585', ['M10.5 3.5L3.5 10.5', 'M3.5 3.5L10.5 10.5']),
  panel: () => svg(14, '#858585', ['M2.917 2.333h8.166a1.167 1.167 0 0 1 1.167 1.167v7a1.167 1.167 0 0 1-1.167 1.167H2.917A1.167 1.167 0 0 1 1.75 10.5v-7a1.167 1.167 0 0 1 1.167-1.167z', 'M5.25 2.333v9.334']),
};
const WORD = { 'needs-you': 'waiting', working: 'working', paused: 'paused', idle: 'idle' };
const ORDER = { 'needs-you': 0, working: 1, paused: 2, idle: 3 };
const relStr = ms => { const s = (Date.now() - ms) / 1000; return s < 90 ? 'now' : s < 5400 ? (s / 60 | 0) + 'm' : s < 129600 ? (s / 3600 | 0) + 'h' : (s / 86400 | 0) + 'd'; };
const mint = () => [...crypto.getRandomValues(new Uint8Array(4))].map(b => b.toString(16).padStart(2, '0')).join('');
const desktop = () => matchMedia('(pointer:fine)').matches && innerWidth >= 1024;

const st = signal(/** @type {S.State|null} */ (null));
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
const focusPaneFrame = () => setTimeout(() => /** @type {HTMLElement|null} */ (document.querySelector('.gw:not([hidden]) .gp.on iframe'))?.focus(), 0);
// a click that picks a pane (a row, split, a pane header or its buttons, a tab) hands it the keyboard: the button or row that was clicked
// would keep the focus otherwise and typing would go nowhere (2026-10-12). The frame's own document moves it on to xterm (term.mjs).
const go = f => { dispatch(f); focusPaneFrame(); };
// a decoded chord (keys.mjs), from this document or from a pane. A chord that moves the focus (tab, pane, close) hands the keyboard to the
// newly focused terminal: typing resumes there, and its forwarder sends the next chord from the right pane
const act = key => {
  dispatch(s => {
    const m = /^tab:(\d)$/.exec(key);
    if (m) return s.tabs[+m[1] - 1] ? S.setActive(s, s.tabs[+m[1] - 1].id) : s;
    if (key === 'pane:-1' || key === 'pane:1') return S.stepPane(s, +key.slice(5));
    if (key === 'tabrel:-1' || key === 'tabrel:1') return S.stepTab(s, +key.slice(7));
    if (key === 'zoom') return S.toggleZoom(s);
    if (key === 'sidebar') return S.toggleSidebar(s);
    if (key === 'close') { const t = s.tabs.find(t => t.id === s.active); return t ? S.closePane(s, t.id, t.focus) : s; }
    return s;
  });
  if (/^(tab|tabrel|pane):|^close$/.test(key)) focusPaneFrame();
};
const typing = () => { const t = document.activeElement; return !!t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.tagName === 'SELECT' || /** @type {HTMLElement} */ (t).isContentEditable); };
function onKey(e) {
  if (e.defaultPrevented || !st.value) return;
  const key = chordOf(e, st.value.mod);
  if (key) { if (typing()) return; e.preventDefault(); act(key); return; }
  if (typing() || e.altKey || e.ctrlKey || e.metaKey) return;
  if (/^[1-9]$/.test(e.key)) { const r = document.querySelectorAll('#gsb .gr'); const el = /** @type {HTMLElement} */ (r[+e.key - 1]); if (el && el.getClientRects().length) { e.preventDefault(); el.click(); } }
  else if (e.key === 'z') { e.preventDefault(); act('zoom'); }
  else if (e.key === 'Escape') { if (st.value.tabs.find(t => t.id === st.value.active)?.zoom != null) act('zoom'); }
}
function onMsg(e) {
  if (e.origin !== location.origin || !e.data || e.data.t !== 'grid-key' || typeof e.data.key !== 'string') return;
  const f = [...document.querySelectorAll('iframe.gfr')].find(x => /** @type {HTMLIFrameElement} */ (x).contentWindow === e.source);
  const name = f?.closest('.gp')?.getAttribute('data-name');
  if (name) { const at = S.find(st.value, name); if (at) dispatch(s => S.focusPane(s, at.tab, at.i)); }
  act(e.data.key);
}
// an iframe taking focus is the one event the parent sees of a click inside a terminal
// (and the one that follows our own focusPaneFrame: that pane is the focused one already, so nothing is dispatched, which also keeps a notice
// such as a refused split on the strip instead of clearing it with the no-op update)
function onBlur() { setTimeout(() => { const a = document.activeElement; if (a && a.classList.contains('gfr')) { const name = a.closest('.gp')?.getAttribute('data-name'); const s = st.value, at = name && s && S.find(s, name); if (at && (at.tab !== s.active || s.tabs.find(t => t.id === at.tab)?.focus !== at.i)) dispatch(x => S.focusPane(x, at.tab, at.i)); } }, 0); }
// parking (spec: 10 min hidden): a tab off screen for S.CAPS.park ms unmounts its panes (their sockets close) and shows the .gpark
// placeholder until clicked. The page hidden that long parks every tab, the one on screen included (a background browser tab holds no
// sockets); back on screen, that one remounts at once and the others stay parked until clicked. Swept every minute and on every state
// change (an active-tab change starts or clears a tab's hidden clock at once)
const hiddenAt = new Map(); // tab id -> ms it was last hidden (runtime only)
let pageHiddenAt = 0;
function sweep() {
  const s = st.value; if (!s) return;
  const now = Date.now(), p = new Set(parked.value), away = pageHiddenAt > 0 && now - pageHiddenAt >= S.CAPS.park;
  for (const t of s.tabs) {
    if (away) { p.add(t.id); continue; }
    if (t.id === s.active) { hiddenAt.delete(t.id); p.delete(t.id); continue; }
    if (!hiddenAt.has(t.id)) hiddenAt.set(t.id, now);
    else if (now - hiddenAt.get(t.id) >= S.CAPS.park) p.add(t.id);
  }
  for (const id of p) if (!s.tabs.some(t => t.id === id)) p.delete(id);
  if (p.size !== parked.value.size || [...p].some(x => !parked.value.has(x))) parked.value = p;
}
function onVis() {
  if (document.visibilityState === 'hidden') { pageHiddenAt = Date.now(); return; }
  if (pageHiddenAt && Date.now() - pageHiddenAt >= S.CAPS.park && st.value) {
    // the sweep parked every tab if it ran meanwhile (a suspended laptop runs none): all but the one on screen stay parked, that one remounts
    parked.value = new Set(st.value.tabs.map(t => t.id).filter(id => id !== st.value.active));
    for (const t of st.value.tabs) hiddenAt.set(t.id, Date.now());
  }
  pageHiddenAt = 0;
}

function Row({ f, open }) {
  const s = st.value, tab = s.tabs.find(t => t.id === s.active), full = !!tab && tab.panes.length >= S.CAPS.panes && !tab.panes.includes(f.name);
  const [ren, setRen] = useState(false); // rename: the pencil (shown on hover, like split) turns the label into an input; Enter posts /a/label, the fleet stream brings the new label; Escape or blur cancels
  return h('div', { class: 'gr', 'data-name': f.name, 'data-state': f.state, 'data-open': open ? '1' : undefined, tabIndex: 0,
      onClick: e => go(s => (e.shiftKey ? S.split(s, f.name) : S.openTab(s, f.name))),
      onKeyDown: e => { if (e.key === 'Enter') go(s => S.openTab(s, f.name)); } },
    h('span', { class: `fli fli-${f.state}`, 'data-f': 'glyph', 'aria-hidden': 'true' }, GLYPH[f.state]),
    ren ? h('form', { class: 'grn', method: 'post', action: '/a/label', onSubmit: e => { e.preventDefault(); const f = e.currentTarget; fetch(f.action, { method: 'POST', body: new URLSearchParams(/** @type {any} */ (new FormData(f))), redirect: 'manual' }).catch(() => {}); setRen(false); } /* not shared.mjs act(): that closes the nearest <details>, here the project group */, onClick: e => e.stopPropagation(), onKeyDown: e => { e.stopPropagation(); if (e.key === 'Escape') setRen(false); } },
        hid('name', f.name), h('input', { name: 'label', value: f.label || '', maxlength: 60, placeholder: 'session name', 'aria-label': 'session name', autocomplete: 'off', ref: el => el && requestAnimationFrame(() => { el.focus(); el.select(); }), onBlur: () => setRen(false) }))
      : h('span', { class: 'lb', 'data-f': 'label' }, labelOf(f, f.name)),
    ren ? null : h('button', { class: 'gren', type: 'button', title: 'rename', 'aria-label': 'rename session', onClick: e => { e.stopPropagation(); setRen(true); } }, '✎'),
    ren ? null : h('button', { class: 'gsplit', type: 'button', title: full ? `at most ${S.CAPS.panes} panes in a tab` : 'split beside the current panes', 'data-full': full ? '1' : undefined,
      onClick: e => { e.stopPropagation(); go(s => S.split(s, f.name)); } }, '⫿ split'),
    h('span', { class: 'fst', 'data-f': 'meta' }, `${WORD[f.state]} ${relStr(f.rel)}`),
    f.snippet ? h('span', { class: 'fsnip', 'data-f': 'snip' }, f.snippet) : null);
}

function Sidebar() {
  tick.value;
  const s = st.value;
  const isOpen = name => !!S.find(s, name);
  const sorted = [...store.fleet.value].sort((a, b) => ORDER[a.state] - ORDER[b.state] || b.rel - a.rel);
  let list;
  if (s.grouped) {
    const groups = new Map();
    for (const f of sorted) { const k = f.proj || 'other'; if (!groups.has(k)) groups.set(k, []); groups.get(k).push(f); }
    const gs = [...groups.entries()].sort((a, b) => ORDER[a[1][0].state] - ORDER[b[1][0].state] || a[0].localeCompare(b[0]));
    list = gs.map(([proj, fs]) => { const vis = fs; if (!vis.length) return null; const needs = fs.filter(f => f.state === 'needs-you').length;
      return h('details', { class: 'gg', 'data-proj': proj, open: true, key: proj }, h('summary', null, needs ? `${proj} · ${needs}` : proj), vis.map(f => h(Row, { key: f.name, f, open: isOpen(f.name) }))); });
  } else list = sorted.map(f => h(Row, { key: f.name, f, open: isOpen(f.name) }));
  return h('aside', { id: 'gsb' },
    h('div', { class: 'ghd' },
      h('button', { id: 'ggroup', type: 'button', title: 'group by project', onClick: () => dispatch(s => S.setGrouped(s, !s.grouped)) }, s.grouped ? 'flat' : 'grouped')), // the chord modifier is set on /system (Shortcuts card); the sidebar is sessions only
    h('div', { class: 'glist' }, list));
}

function Pane({ tab, i, name, f, hiddenByZoom, cell }) {
  if (!tabids.has(name)) tabids.set(name, mint());
  const on = tab.focus === i, state = f ? f.state : 'ended';
  return h('div', { class: `gp${on ? ' on' : ''}${state === 'needs-you' ? ' needs' : ''}${f ? '' : ' ended'}`, 'data-name': name, style: hiddenByZoom ? 'display:none' : cell,
      onPointerDown: () => go(s => S.focusPane(s, tab.id, i)) },
    h('header', { class: 'gph' }, h('b', null, labelOf(f, name)), h('span', null, f ? WORD[f.state] : 'ended'), h('span', { class: 'gsp' }),
      tab.panes.length > 1 ? h('button', { class: 'gown', type: 'button', title: 'move to its own tab', onClick: () => go(s => S.detachPane(s, tab.id, i)) }, '⧉') : null,
      h('button', { class: 'gzoom', type: 'button', title: 'zoom', onClick: () => go(s => S.toggleZoom(S.focusPane(s, tab.id, i))) }, tab.zoom === i ? I.shrink() : I.expand()),
      h('button', { class: 'gclose', type: 'button', title: 'close pane', onClick: () => go(s => S.closePane(s, tab.id, i)) }, I.x14())),
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
  useEffect(() => { document.querySelector('#gtabs .gt.on')?.scrollIntoView({ inline: 'nearest', block: 'nearest' }); }, [s.active]); // the tabs box scrolls: keep the active tab in it
  const worst = t => t.panes.reduce((w, n) => { const k = fm.get(n)?.state || 'idle'; return ORDER[k] < ORDER[w] ? k : w; }, 'idle');
  return h('nav', { id: 'gtabs' },
    h('button', { class: 'gsbt', type: 'button', title: `${s.sb ? 'hide' : 'show'} the sidebar (${MODS[s.mod]}B)`, 'aria-label': 'toggle sidebar', 'aria-pressed': s.sb ? 'true' : 'false', onClick: () => go(S.toggleSidebar) }, I.panel()), // sharing a screen: the session list off
    h('div', { class: 'gts' }, // the tabs scroll in their own box (no scrollbar), so + and the nav never leave the strip
    s.tabs.map((t, k) => h('div', { class: `gt${t.id === s.active ? ' on' : ''}`, 'data-id': t.id, key: t.id, onClick: () => { parked.value = new Set([...parked.value].filter(x => x !== t.id)); dispatch(s => S.setActive(s, t.id)); focusPaneFrame(); },
      // a press that travels more than 6 px is a drag: released over another tab, this one lands before or after it (by the half it is
      // released over). Only the strip reorders; the pane wrappers keep creation order (Grid), so no iframe moves
      onPointerDown: e => {
        if (e.button || /** @type {HTMLElement} */ (e.target).closest('.gx')) return; // pointer capture would retarget the close button's click to the tab
        const el = /** @type {HTMLElement} */ (e.currentTarget), x0 = e.clientX; let moved = false;
        el.setPointerCapture(e.pointerId);
        const grid = document.getElementById('grid');
        const move = ev => { if (Math.abs(ev.clientX - x0) > 6 || Math.abs(ev.clientY - e.clientY) > 6) { moved = true; el.classList.add('dragging'); grid?.classList.add('drag', 'tabdrag'); } }; // drag: iframes ignore the pointer, the panes show the drop target
        const end = () => { el.removeEventListener('pointermove', move); el.removeEventListener('pointerup', up); el.removeEventListener('pointercancel', end); el.classList.remove('dragging'); grid?.classList.remove('drag', 'tabdrag'); };
        const up = ev => {
          end();
          if (!moved) return;
          const at = /** @type {HTMLElement|null} */ (document.elementFromPoint(ev.clientX, ev.clientY));
          if (at?.closest('.gw')) { dispatch(s => S.mergeTab(s, t.id, s.active)); return; } // dropped onto the panes: this tab's panes join the tab on screen
          const over = at?.closest('.gt');
          if (!over || over === el) return;
          const r = over.getBoundingClientRect(), ids = st.value.tabs.map(t => t.id), from = ids.indexOf(t.id);
          let to = ids.indexOf(over.dataset.id); if (ev.clientX > r.left + r.width / 2) to++; if (to > from) to--;
          dispatch(s => S.moveTab(s, from, to));
        };
        el.addEventListener('pointermove', move); el.addEventListener('pointerup', up); el.addEventListener('pointercancel', end);
      } },
      h('span', { class: 'gdot', 'data-state': worst(t) }), h('span', { class: 'gtl' }, t.panes.map(n => labelOf(fm.get(n), n)).join(' | ')),
      h('button', { class: 'gx', type: 'button', 'aria-label': 'close tab', onClick: e => { e.stopPropagation(); dispatch(s => { let x = s; for (let i = t.panes.length - 1; i >= 0; i--) x = S.closePane(x, t.id, i); return x; }); } }, I.x12()))),
    h('a', { class: 'gnew', href: `/term/?arg=menu&arg=&arg=${mint()}&v=3`, target: 't-menu', 'data-nw': 't-menu', title: 'new session (terminal picker)' }, I.plus())),
    h('span', { id: 'gnotice', hidden: !s.notice }, s.notice),
    h('nav', { class: 'gnav', 'aria-label': 'cockpit' }, NAV.map(([t, p]) => h('a', { href: base() + p }, t))));
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
    // /grid?open=<session>: a row of the home page (sessions.mjs attach) lands here; that session becomes a tab (or its tab comes to the
    // front), the keyboard goes to it, and the query leaves the URL so a reload is the plain grid
    const open = new URLSearchParams(location.search).get('open');
    if (open && live.has(open)) { st.value = { ...S.openTab(st.value, open), notice: st.value.notice }; history.replaceState(history.state, '', location.pathname); focusPaneFrame(); }
    /** @type {any} */ (window).__grid = { state: () => st.value, dispatch, fleet: () => store.fleet.value, sweep, parked: () => [...parked.value] };
    return () => { document.adoptedStyleSheets = document.adoptedStyleSheets.filter(x => x !== sheet); document.body.classList.remove('gridv'); st.value = null; tabids.clear(); parked.value = new Set(); hiddenAt.clear(); pageHiddenAt = 0; delete (/** @type {any} */ (window)).__grid; };
  }, [ok]);
  useEffect(() => {
    if (!ok) return;
    const un = st.subscribe(s => { if (!s) return; clearTimeout(saveT); saveT = setTimeout(() => S.save(localStorage, s), 250); sweep(); });
    const t = setInterval(() => { tick.value++; }, 30000), sw = setInterval(sweep, 60000);
    document.addEventListener('keydown', onKey); addEventListener('message', onMsg); addEventListener('blur', onBlur); document.addEventListener('visibilitychange', onVis); addEventListener('pageshow', onVis); // spec s8: pageshow / visible both remount
    return () => { un(); clearInterval(t); clearInterval(sw); clearTimeout(saveT); document.removeEventListener('keydown', onKey); removeEventListener('message', onMsg); removeEventListener('blur', onBlur); document.removeEventListener('visibilitychange', onVis); removeEventListener('pageshow', onVis); };
  }, [ok]);
  if (!ok) return h('div', { 'data-view': 'grid-phone' }, 'The grid is a desktop view (a mouse and a window at least 1024 px wide). ', h('a', { href: '/' }, 'Back to sessions'));
  const s = st.value;
  if (!s) return null;
  const fm = fleetMap();
  return h('div', { id: 'grid', class: s.sb ? undefined : 'nosb', style: `--gsb:${s.sidebar}px` },
    h(Sidebar, null),
    h('div', { id: 'gh-sb', title: 'drag to resize · double-click to reset',
      onPointerDown: e => { const left = document.getElementById('gsb').getBoundingClientRect().left; drag(e, x => dispatch(s => S.setSidebar(s, x - left))); }, // the card's own left edge: the grid pads 8 px before it
      onDblClick: () => dispatch(s => S.setSidebar(s, 256)) }),
    h('main', { id: 'gmain' },
      h(Strip, { fm }),
      s.tabs.length ? [...s.tabs].sort((a, b) => +a.id.slice(1) - +b.id.slice(1)).map(t => h(Tab, { key: t.id, tab: t, active: t.id === s.active, fm })) : h('div', { class: 'gempty' }, 'Click a session on the left to open it here; "split" puts it beside the current panes.')));
}
