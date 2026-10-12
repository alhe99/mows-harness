#!/usr/bin/env node
// grid-logic-check.mjs — the grid view's pure state and chord logic (web/grid/), no DOM. Exit code is the verdict.
import * as S from '../web/grid/state.mjs';
let bad = 0;
const check = (id, ok, detail) => { if (!ok) bad++; console.log(`${ok ? 'PASS' : 'FAIL'} ${id}${detail === undefined ? '' : ' ' + JSON.stringify(detail)}`); };
const mem = () => { const m = new Map(); return { getItem: k => m.has(k) ? m.get(k) : null, setItem: (k, v) => m.set(k, String(v)), m }; };
const live = new Set(['cc-a', 'cc-b', 'cc-c', 'cc-d', 'cc-e', 'cc-f', 'cc-g']);

let s = S.empty('win');
check('1 empty: no tabs, sidebar 260, grouped, mod kept', s.tabs.length === 0 && s.sidebar === 260 && s.grouped && s.mod === 'win');
s = S.openTab(s, 'cc-a');
check('2 openTab: one tab, one pane, active, cols [1]', s.tabs.length === 1 && s.tabs[0].panes.join() === 'cc-a' && s.active === s.tabs[0].id && s.tabs[0].cols.join() === '1', s);
s = S.openTab(s, 'cc-b');
check('3 openTab again: second tab, active moves', s.tabs.length === 2 && s.active === s.tabs[1].id);
s = S.openTab(s, 'cc-a');
check('4 openTab of an open session focuses it, no new tab', s.tabs.length === 2 && s.active === s.tabs[0].id && S.find(s, 'cc-a').i === 0);
s = S.split(s, 'cc-c');
check('5 split: into the active tab, two equal columns, focus on the new pane', s.tabs[0].panes.join() === 'cc-a,cc-c' && s.tabs[0].cols.join() === '0.5,0.5' && s.tabs[0].focus === 1);
s = S.split(s, 'cc-a');
check('6 split of a pane already in the tab only focuses it', s.tabs[0].panes.length === 2 && s.tabs[0].focus === 0);
for (const n of ['cc-d', 'cc-e', 'cc-f', 'cc-g', 'cc-h']) s = S.split(s, n);
check('7 cap 6 panes: the 7th is refused with a notice; 6 panes = 3 columns', s.tabs[0].panes.length === 6 && s.tabs[0].cols.length === 3 && /6 panes/.test(s.notice), s.notice);
check('8 colsFor: 1,2,3 -> n, 4 -> 2, 5,6 -> 3', [1, 2, 3, 4, 5, 6].map(S.colsFor).join() === '1,2,3,2,3,3');
s = S.closePane(s, s.tabs[0].id, 5);
check('9 closePane keeps the others, cols follow (5 panes = 3 columns)', s.tabs[0].panes.length === 5 && s.tabs[0].cols.length === 3 && Math.abs(s.tabs[0].cols.reduce((a, b) => a + b, 0) - 1) < 1e-9);
let t = S.setActive(s, s.tabs[1].id); t = S.closePane(t, t.tabs[1].id, 0);
check('10 closing the last pane closes the tab and activates a neighbour', t.tabs.length === 1 && t.active === t.tabs[0].id);
s = S.setCols(s, s.tabs[0].id, [0.7, 0.2, 0.1]);
check('11 setCols stores normalised fractions', s.tabs[0].cols.map(c => c.toFixed(2)).join() === '0.70,0.20,0.10');
check('12 setSidebar clamps to 180..480', S.setSidebar(s, 50).sidebar === 180 && S.setSidebar(s, 900).sidebar === 480 && S.setSidebar(s, 300).sidebar === 300);
s = S.focusPane(s, s.tabs[0].id, 2);
check('13 stepPane wraps', S.stepPane(s, 1).tabs[0].focus === 3 && S.stepPane(S.focusPane(s, s.tabs[0].id, 4), 1).tabs[0].focus === 0 && S.stepPane(S.focusPane(s, s.tabs[0].id, 0), -1).tabs[0].focus === 4);
check('14 stepTab wraps', S.stepTab(s, 1).active === s.tabs[1].id && S.stepTab(S.setActive(s, s.tabs[1].id), 1).active === s.tabs[0].id);
check('15 toggleZoom sets the focused index, again clears it', S.toggleZoom(s).tabs[0].zoom === 2 && S.toggleZoom(S.toggleZoom(s)).tabs[0].zoom === null);
const z = S.stepPane(S.toggleZoom(s), 1), z2 = S.stepPane(z, -1);
check('15b stepPane while zoomed moves the zoom with the focus; unzoomed it stays null', z.tabs[0].focus === 3 && z.tabs[0].zoom === 3 && z2.tabs[0].focus === 2 && z2.tabs[0].zoom === 2 && S.stepPane(s, 1).tabs[0].zoom === null);
s = S.openTab(s, 'cc-g');
check('16 moveTab reorders', S.moveTab(s, 2, 0).tabs.map(x => x.id).join() === [s.tabs[2].id, s.tabs[0].id, s.tabs[1].id].join());
let c = S.empty('mac'); for (let i = 0; i < 9; i++) c = S.openTab(c, 'cc-' + i); const c10 = S.openTab(c, 'cc-x');
check('17 cap 9 tabs: the 10th is refused with a notice', c.tabs.length === 9 && c10.tabs.length === 9 && /9 tabs/.test(c10.notice));

const st = mem(); S.save(st, s);
const back = S.load(st, live, 'alt');
check('18 save/load round-trips tabs, cols, focus, sidebar, grouped, mod; notice is not stored', JSON.stringify(back.state.tabs) === JSON.stringify(s.tabs) && back.state.mod === 'win' && back.state.notice === '' && back.dropped.length === 0);
const gone = S.load(st, new Set(['cc-a', 'cc-c']), 'win');
check('19 load drops names that are not live and reports them; a tab left empty goes; active stays valid', gone.state.tabs.every(x => x.panes.every(n => n === 'cc-a' || n === 'cc-c')) && gone.dropped.length > 0 && gone.state.tabs.some(x => x.id === gone.state.active), gone);
check('20 load of nothing / garbage is empty with the given mod', S.load(mem(), live, 'mac').state.mod === 'mac' && S.load({ getItem: () => '{nope' }, live, 'mac').state.tabs.length === 0);
const bad1 = j => S.load({ getItem: () => JSON.stringify(j) }, live, 'mac');
check('20b load skips non-object tabs instead of throwing', (() => { try { const r = bad1({ tabs: [null, 3, 'x', { id: 't1', panes: ['cc-a'] }] }); return r.state.tabs.length === 1 && r.state.tabs[0].id === 't1'; } catch { return false; } })());
check('20c load rejects non-finite or non-positive cols and falls back to even', [[['x'], 1], [['x', 'y'], 2], [[0, 1], 2], [[-1, 2], 2], [[null, null], 2]].every(([cols, k]) => { const t = bad1({ tabs: [{ id: 't1', panes: ['cc-a', 'cc-b'].slice(0, k), cols }] }).state.tabs[0]; return t.cols.length === (k === 1 ? 1 : 2) && t.cols.every(v => Number.isFinite(v) && v > 0) && Math.abs(t.cols.reduce((a, b) => a + b, 0) - 1) < 1e-9; }));
check('20d load clamps negative focus and zoom to a valid value', (() => { const t = bad1({ tabs: [{ id: 't1', panes: ['cc-a', 'cc-b'], focus: -3, zoom: -1 }] }).state.tabs[0]; return t.focus === 0 && t.zoom === null; })() && bad1({ tabs: [{ id: 't1', panes: ['cc-a', 'cc-b'], focus: 'x', zoom: 1.5 }] }).state.tabs[0].focus === 0);
check('21 setMod / setGrouped', S.setMod(s, 'alt').mod === 'alt' && S.setGrouped(s, false).grouped === false);

import { chordOf, detectMod, MODS } from '../web/grid/keys.mjs';
const ev = (code, m) => ({ code, ctrlKey: m.includes('c'), metaKey: m.includes('m'), shiftKey: m.includes('s'), altKey: m.includes('a') });
check('K1 detectMod: Mac and iPad -> mac, everything else -> win', detectMod('MacIntel') === 'mac' && detectMod('iPad') === 'mac' && detectMod('Win32') === 'win' && detectMod('Linux x86_64') === 'win');
check('K2 win: Ctrl+Shift+Digit3 -> tab:3, Ctrl+Digit3 alone -> null, ⌘+Shift -> null', chordOf(ev('Digit3', 'cs'), 'win') === 'tab:3' && chordOf(ev('Digit3', 'c'), 'win') === null && chordOf(ev('Digit3', 'ms'), 'win') === null);
check('K3 mac: ⌘+Shift+Digit1 -> tab:1, Ctrl+Shift -> null', chordOf(ev('Digit1', 'ms'), 'mac') === 'tab:1' && chordOf(ev('Digit1', 'cs'), 'mac') === null);
check('K4 alt: Alt+Digit9 -> tab:9, Alt+Shift -> null, Ctrl+Alt -> null', chordOf(ev('Digit9', 'a'), 'alt') === 'tab:9' && chordOf(ev('Digit9', 'as'), 'alt') === null && chordOf(ev('Digit9', 'ac'), 'alt') === null);
check('K5 arrows: left/right -> pane, up/down -> tabrel', ['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'].map(k => chordOf(ev(k, 'cs'), 'win')).join() === 'pane:-1,pane:1,tabrel:-1,tabrel:1');
check('K6 letters: Z zoom, X close, S filter, W is NOT a chord', ['KeyZ', 'KeyX', 'KeyS', 'KeyW'].map(k => chordOf(ev(k, 'cs'), 'win')).join() === 'zoom,close,filter,');
check('K7 Digit0 and a bare key are not chords', chordOf(ev('Digit0', 'cs'), 'win') === null && chordOf(ev('KeyZ', ''), 'win') === null);
check('K8 labels for the select', MODS.mac === '⌘⇧' && MODS.win === 'Ctrl⇧' && MODS.alt === 'Alt');

console.log(bad ? `grid-logic-check: ${bad} FAIL` : 'grid-logic-check: all pass');
process.exit(bad ? 1 : 0);
