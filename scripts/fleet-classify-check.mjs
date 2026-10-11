#!/usr/bin/env node
// fleet-classify-check.mjs — classifyFleet against real pane tails, incl. the phone-width ones (2026-10-11: the status
// footer and the "esc to interrupt" hint are cut off on a 50-column pane, so ccw-alonso sat on idle and no push fired).
import { classifyFleet } from '../infra/dashboard/core.mjs';
const now = Date.now(), recent = now - 60_000, old = now - 20 * 60_000;
const cases = [
  ['phone working: spinner only', { tail: '✶ Wandering… (36s · ↓ 1.6k tokens)\n❯ \n  🤖 Fable 5.1 (high) | 💰 $133.64 session / $0.…\n  ⏵⏵ auto mode on (shift+tab to cycle) · ← 1 age…', mt: old }, 'working'],
  ['phone idle after a turn: footer only', { tail: '❯ \n  🤖 Fable 5.1 (high) | 💰 $133.64 session / $0.…\n  ⏵⏵ auto mode on (shift+tab to cycle) · ← 1 age…', mt: recent }, 'needs-you'],
  ['phone idle, turn long seen', { tail: '❯ \n  ⏵⏵ auto mode on (shift+tab to cycle) · ← 1 age…', mt: old }, 'idle'],
  ['desktop working', { tail: '✻ Thinking… (5s · esc to interrupt)\n❯ \n  ? for shortcuts', mt: recent }, 'working'],
  ['desktop idle after a turn', { tail: '❯ \n  ? for shortcuts', mt: recent }, 'needs-you'],
  ['dialog beats everything', { tail: 'Do you want to proceed?\n❯ 1. Yes\n  2. No', mt: old }, 'needs-you'],
  ['paused beats dialog', { paused: true, tail: 'Do you want to proceed?', mt: recent }, 'paused'],
  ['no transcript, no signals', { tail: '$ ', mt: 0 }, 'idle'],
];
let bad = 0;
for (const [name, input, want] of cases) {
  const got = classifyFleet(input);
  console.log(`${got === want ? 'PASS' : 'FAIL'} ${name} -> ${got}${got === want ? '' : ` (want ${want})`}`);
  if (got !== want) bad++;
}
process.exit(bad ? 1 : 0);
