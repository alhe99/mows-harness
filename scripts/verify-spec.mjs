#!/usr/bin/env node
// verify-spec.mjs — the script-decided verdict. Runs every task's `Verify:` line of a spec written in
// the templates/spec.md shape, logs raw output + exit code per task, prints one VERDICT line.
//   node scripts/verify-spec.mjs <spec.md> [--dry-run] [--only 3,7] [--owner builder|verifier]
// Env: DASH (default http://127.0.0.1:3105), RUN (default .agent-team/local-<timestamp>).
// ponytail: sequential, no timeouts beyond 20 min per task; parallelism when a phase needs it.
import { readFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { join, basename } from 'node:path';

const args = process.argv.slice(2);
const spec = args.find(a => !a.startsWith('--'));
if (!spec) { console.error('usage: verify-spec.mjs <spec.md> [--dry-run] [--only ids] [--owner o]'); process.exit(2); }
const dry = args.includes('--dry-run');
const only = args.includes('--only') ? args[args.indexOf('--only') + 1].split(',').map(Number) : [];
const owner = args.includes('--owner') ? args[args.indexOf('--owner') + 1] : null;

const text = readFileSync(spec, 'utf8');
const tasks = [];
const re = /^(\d+)\. ([\s\S]*?)\n\s+Evidence: (.*)\n\s+Verify: (.*)\n\s+Owner: (\w+)/gm;
for (let m; (m = re.exec(text));) tasks.push({ id: +m[1], title: m[2].split('\n')[0], verify: m[4].trim(), owner: m[5] });
if (!tasks.length) { console.error('no tasks with Evidence/Verify/Owner sub-lines found'); process.exit(2); }

const env = { ...process.env, DASH: process.env.DASH || 'http://127.0.0.1:3105',
  RUN: process.env.RUN || `.agent-team/local-${Date.now()}` };
const logDir = join(env.RUN, 'verify'); if (!dry) mkdirSync(logDir, { recursive: true });

const fails = [];
for (const t of tasks) {
  if (only.length && !only.includes(t.id)) continue;
  if (owner && t.owner !== owner) continue;
  if (dry) { console.log(`${t.id}\t${t.owner}\t${t.verify}`); continue; }
  const started = Date.now();
  const r = spawnSync('bash', ['-eo', 'pipefail', '-c', t.verify], { env, encoding: 'utf8', timeout: 20 * 60_000 });
  const code = r.status ?? 124;
  writeFileSync(join(logDir, `${basename(spec, '.md')}-task-${t.id}.log`),
    `# ${t.title}\n$ ${t.verify}\n# exit ${code} in ${((Date.now() - started) / 1000).toFixed(1)}s\n${r.stdout || ''}${r.stderr || ''}`);
  console.log(`${code === 0 ? 'PASS' : 'FAIL'} ${t.id} ${t.title.slice(0, 80)}`);
  if (code !== 0) fails.push(t.id);
}
if (dry) process.exit(0);
console.log(fails.length ? `VERDICT: fix:[${fails.join(',')}]` : 'VERDICT: ship');
process.exit(fails.length ? 1 : 0);
