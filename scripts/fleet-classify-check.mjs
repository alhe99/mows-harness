#!/usr/bin/env node
// fleet-classify-check.mjs — classifyFleet against real pane tails, incl. the phone-width ones (2026-10-11: the status
// footer and the "esc to interrupt" hint are cut off on a 50-column pane, so ccw-alonso sat on idle and no push fired).
import { classifyFleet, tagSessions } from '../infra/dashboard/core.mjs';
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
const ses = (name, ...pids) => ({ name, pid: pids[0], pids, wins: [] });
const tagged = Object.fromEntries(tagSessions([ses('leader-bash', 100), ses('deep', 200), ses('svc', 300, 301), ses('leader-claude', 400), ses('stopped', 500)], PS).map(x => [x.name, x]));
const tcases = [
  ['claude under a bash leader', tagged['leader-bash'].claude, true],
  ['claude two levels below the leader', tagged.deep.claude, true],
  ['servers in every pane, no claude', tagged.svc.claude, false],
  ['claude is the pane leader', tagged['leader-claude'].claude, true],
  ['stopped claude: still claude, and paused', tagged.stopped.claude && tagged.stopped.paused, true],
  ['ps failed: nothing becomes a service', tagSessions([ses('x', 1)], '')[0].claude !== false, true],
];
for (const [name, got, want] of tcases) {
  console.log(`${got === want ? 'PASS' : 'FAIL'} tagSessions: ${name} -> ${got}`);
  if (got !== want) bad++;
}
process.exit(bad ? 1 : 0);
