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
check('21 setMod / setGrouped', S.setMod(s, 'alt').mod === 'alt' && S.setGrouped(s, false).grouped === false);

console.log(bad ? `grid-logic-check: ${bad} FAIL` : 'grid-logic-check: all pass');
process.exit(bad ? 1 : 0);
