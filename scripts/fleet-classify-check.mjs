#!/usr/bin/env node
// fleet-classify-check.mjs — classifyFleet against real pane tails, incl. the phone-width ones (2026-10-11: the status
// footer and the "esc to interrupt" hint are cut off on a 50-column pane, so ccw-alonso sat on idle and no push fired).
import { classifyFleet, svcPlan, tagSessions } from '../infra/dashboard/core.mjs';
const now = Date.now(), recent = now - 60_000, old = now - 20 * 60_000;
const cases = [
  ['phone working: spinner only', { tail: '✶ Wandering… (36s · ↓ 1.6k tokens)\n❯ \n  🤖 Fable 5.1 (high) | 💰 $133.64 session / $0.…\n  ⏵⏵ auto mode on (shift+tab to cycle) · ← 1 age…', mt: old }, 'working'],
  ['phone working for minutes: spinner with m+s', { tail: '✢ Wandering… (5m 16s · ↓ 13.8k tokens)\n❯ \n  ⏵⏵ auto mode on (shift+tab to cycle) · ← 1 age…', mt: 0 }, 'working'],
  ['phone idle after a turn: footer only', { tail: '❯ \n  🤖 Fable 5.1 (high) | 💰 $133.64 session / $0.…\n  ⏵⏵ auto mode on (shift+tab to cycle) · ← 1 age…', mt: recent }, 'needs-you'],
  ['phone idle, turn long seen', { tail: '❯ \n  ⏵⏵ auto mode on (shift+tab to cycle) · ← 1 age…', mt: old }, 'idle'],
  ['desktop working', { tail: '✻ Thinking… (5s · esc to interrupt)\n❯ \n  ? for shortcuts', mt: recent }, 'working'],
  ['desktop idle after a turn', { tail: '❯ \n  ? for shortcuts', mt: recent }, 'needs-you'],
  ['dialog beats everything', { tail: 'Do you want to proceed?\n❯ 1. Yes\n  2. No', mt: old }, 'needs-you'],
  ['paused beats dialog', { paused: true, tail: 'Do you want to proceed?', mt: recent }, 'paused'],
  ['no transcript, no signals', { tail: '$ ', mt: 0 }, 'idle'],
  ['resumed from the grid: bookkeeping touched the transcript, last turn long ago (2026-10-12)', { tail: '❯ \n  ⏵⏵ auto mode on (shift+tab to cycle) · ← 1 agent', mt: recent, turn: old }, 'idle'],
  ['resumed, no assistant entry in the tail at all', { tail: '❯ \n  ⏵⏵ auto mode on (shift+tab to cycle)', mt: recent, turn: 0 }, 'idle'],
];
let bad = 0;
for (const [name, input, want] of cases) {
  const got = classifyFleet(input);
  console.log(`${got === want ? 'PASS' : 'FAIL'} ${name} -> ${got}${got === want ? '' : ` (want ${want})`}`);
  if (got !== want) bad++;
}
// tagSessions: which tmux sessions run claude (2026-10-14: links-cec's service stack `cecqa` showed as a second session)
const PS = `100 1 Ss bash
101 100 Sl claude
200 1 Ss bash
201 200 S bash
202 201 Sl claude
300 1 Ss bash
301 1 Ss bash
302 301 S bash
303 302 Sl dotnet
400 1 Sl claude
500 1 Ss bash
501 500 Tl claude`;
const ses = (name, ...pids) => ({ name, pid: pids[0], panes: pids.map((pid, i) => ({ pid, win: 'w' + i, dead: false })) });
const tagged = Object.fromEntries(tagSessions([ses('leader-bash', 100), ses('deep', 200), ses('svc', 300, 301), ses('leader-claude', 400), ses('stopped', 500)], PS).map(x => [x.name, x]));
const failed = tagSessions([ses('x', 1)], '')[0];
const tcases = [
  ['claude under a bash leader', tagged['leader-bash'].claude, true],
  ['claude two levels below the leader', tagged.deep.claude, true],
  ['servers in every pane, no claude', tagged.svc.claude, false],
  ['claude is the pane leader', tagged['leader-claude'].claude, true],
  ['stopped claude: still claude, and paused', tagged.stopped.claude && tagged.stopped.paused, true],
  ['ps failed: nothing becomes a service', failed.claude !== false, true],
  ['window up/down: a bare prompt is down, a shell with a server under it is up', JSON.stringify(tagged.svc.wins), '[{"n":"w0","up":false},{"n":"w1","up":true}]'],
  ['ps failed: every window counts as up (never drawn stopped, never closed)', failed.wins.every(w => w.up), true],
  ['a dead pane is down', tagSessions([{ name: 'd', pid: 301, panes: [{ pid: 301, win: 'x', dead: true }] }], PS)[0].wins[0].up, false],
];
// svcPlan: when a service session auto-closes. G = grace; the same seen-map across calls, like the reaper's.
const G = 1000, svc = (name, up, o = {}) => ({ name, created: 1, claude: false, attached: false, keep: false, wins: [{ n: 'a', up }], ...o });
const seen = new Map();
const step = (t, l) => svcPlan(l, seen, t, G).join();
const plan = [
  ['never ran (your own plain shell): never closes', step(0, [svc('plain', false)]) + step(5000, [svc('plain', false)]), ''],
  ['running: no close', step(0, [svc('qa', true)]), ''],
  ['stopped: not yet at G', step(100, [svc('qa', false)]) + step(1000, [svc('qa', false)]), ''],
  ['stopped for G: due', step(1100, [svc('qa', false)]), 'qa'],
];
seen.clear(); step(0, [svc('qa', true)]); step(10, [svc('qa', false)]);
plan.push(['attached resets the clock', step(5000, [svc('qa', false, { attached: true })]) + step(5500, [svc('qa', false)]), '']);
plan.push(['...and it is due G after the client left', step(6600, [svc('qa', false)]), 'qa']);
seen.clear(); step(0, [svc('k', true)]);
plan.push(['@keep never closes', step(10, [svc('k', false, { keep: true })]) + step(99999, [svc('k', false, { keep: true })]), '']);
seen.clear(); step(0, [svc('c', true, { claude: true })]);
plan.push(['a claude session never closes', step(99999, [svc('c', false, { claude: true })]), '']);
const cl = [svc('qa', false)]; seen.clear(); step(0, [svc('qa', true)]); svcPlan(cl, seen, 500, G);
plan.push(['closeAt is when it stopped + G (the sidebar countdown)', String(cl[0].closeAt), '1500']);
for (const [name, got, want] of plan) tcases.push([`svcPlan: ${name}`, got, want]);
for (const [name, got, want] of tcases) {
  console.log(`${got === want ? 'PASS' : 'FAIL'} tagSessions: ${name} -> ${got}`);
  if (got !== want) bad++;
}
process.exit(bad ? 1 : 0);
