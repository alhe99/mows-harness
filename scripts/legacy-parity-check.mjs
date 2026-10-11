#!/usr/bin/env node
// legacy-parity-check.mjs — `--ui=legacy` serves today's documents (ledger B-11, K-21; specs/cockpit/03-views.md task 7).
//   node scripts/legacy-parity-check.mjs                      compare the working tree with the stored pre-split HTML
//   node scripts/legacy-parity-check.mjs --capture [--ref R]  write that HTML from git ref R (default HEAD) into the baseline dir
// The fixture is docs/qa/probes/fixture.sh in a throwaway container (MOWS_QA_PARITY=1: one agent, one run, two transcripts, one markdown
// file, empty fleet), started with --ui=legacy. Needs docker; fails loudly without it.
// What "identical" means: every <style> and <script> block (the whole stylesheet, FLEET_JS, the base script, the offline page) and the
// status line and policy headers are compared byte for byte; the CSP nonce is masked. The markup between them has its volatile parts
// masked on both sides: digit runs (relative times, host load/memory/uptime, widths of the meters), the 8-hex terminal tab id and the
// LAST_DEPLOY row (the age of the checked-out files, which a captured commit and a working tree do not share).
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync, existsSync, rmSync, readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';

const argv = process.argv.slice(2);
const has = f => argv.includes(f);
const opt = (f, d) => (has(f) ? argv[argv.indexOf(f) + 1] : d);
const repo = resolve(import.meta.dirname, '..');
const OUT = resolve(opt('--out', join(repo, 'docs/qa/baseline/cockpit/legacy-html')));
const port = +opt('--port', 3922);
const BOX = `mows-legacy-parity-${process.pid}`;
const SID = 'bbbb2222-3333-4444-5555-666666666666', AGENT = 'harness-reviewer', RUN = '20260916-101500-1';
const DEMO_HOME = `/${'home'}/demo`; // built, not literal: preflight forbids bare home paths
const PAGES = [
  ['home', '/'], ['history', '/history'], ['system', '/system'], ['device', '/device'], ['agents', '/agents'],
  ['agent', `/agents/${AGENT}`], ['run', `/agents/${AGENT}/${RUN}`], ['session', `/s/demo/${SID}`],
  ['md', `/md?f=${encodeURIComponent(`${DEMO_HOME}/parity.md`)}`], ['ui', '/ui'],
];

// home directories are masked so the stored pages hold no absolute path (preflight forbids them), built so this file holds none either
const HOMES = new RegExp('/' + 'home' + '/[\\w.-]+', 'g');
export function normalise(status, headers, body) {
  body = body.replace(HOMES, '$HOME');
  const keep = /(<style[^>]*>[\s\S]*?<\/style>|<script[^>]*>[\s\S]*?<\/script>)/g;
  const nonce = s => s.replace(/nonce[-=]['"]?[A-Za-z0-9_-]{16,}['"]?/g, 'nonce=N').replace(/'nonce-[A-Za-z0-9_-]+'/g, "'nonce-N'");
  const parts = body.split(keep).map((s, i) => (i % 2 ? nonce(s) : nonce(s).replace(/arg=[0-9a-f]{8}(&amp;|&)v=3/g, 'arg=TAB$1v=3').replace(/(LAST_DEPLOY<\/span><span class="envval"><span title=")[^"]*(">)[^<]*/g, '$1T$2T').replace(/\d+/g, '#')));
  const h = ['content-type', 'cache-control', 'content-security-policy'].map(k => `${k}: ${nonce(headers[k] || '')}`);
  return `${status}\n${h.join('\n')}\n\n${parts.join('')}`;
}

const sh = (...a) => spawnSync(a[0], a.slice(1), { encoding: 'utf8', maxBuffer: 1 << 28 });
const cleanup = () => { sh('docker', 'rm', '-f', BOX); };
for (const s of ['SIGINT', 'SIGTERM']) process.on(s, () => { cleanup(); process.exit(130); });

let tree = repo, tmp = '';
if (has('--capture')) { // the tree of a past commit, so the baseline is the PRE-split server, not whatever is checked out
  tmp = mkdtempSync(join(tmpdir(), 'legacy-parity-'));
  const ar = spawnSync('bash', ['-c', `git -C '${repo}' archive '${opt('--ref', 'HEAD')}' | tar -x -C '${tmp}'`], { encoding: 'utf8' });
  if (ar.status !== 0) { console.error(`legacy-parity-check: git archive failed: ${ar.stderr}`); process.exit(2); }
  tree = tmp;
}
cleanup();
const up = sh('docker', 'run', '-d', '--name', BOX, '-e', 'MOWS_QA_PARITY=1', '-e', 'MOWS_QA_LITE_ARGS=--ui=legacy',
  '-p', `127.0.0.1:${port}:3005`, '-v', `${tree}:/r:ro`, '-v', `${join(repo, 'docs/qa/probes')}:/probes:ro`, 'node:20-slim', 'bash', '/probes/fixture.sh');
if (up.status !== 0) { console.error(`legacy-parity-check: docker run failed: ${up.stderr.trim()}`); process.exit(2); }
let bad = 0;
try {
  const base = `http://127.0.0.1:${port}`;
  let ready = false;
  for (let i = 0; i < 40 && !ready; i++) { ready = await fetch(`${base}/healthz`).then(r => r.ok, () => false); if (!ready) await new Promise(r => setTimeout(r, 1000)); }
  if (!ready) throw new Error(`the fixture dashboard never came up on ${port}`);
  await new Promise(r => setTimeout(r, 2500)); // first index scan and the first usage pass
  mkdirSync(OUT, { recursive: true });
  for (const [slug, route] of PAGES) {
    const r = await fetch(base + route, { redirect: 'manual', headers: { 'accept-encoding': 'identity' } });
    const got = normalise(r.status, Object.fromEntries(r.headers), await r.text());
    const file = join(OUT, `${slug}.html`);
    if (has('--capture')) { writeFileSync(file, got); console.log(`captured ${slug} (${got.length} B)`); continue; }
    if (!existsSync(file)) { bad++; console.log(`FAIL ${slug}: no stored baseline ${file}`); continue; }
    const want = readFileSync(file, 'utf8');
    if (got === want) { console.log(`PASS ${slug}`); continue; }
    bad++;
    let i = 0; while (i < got.length && got[i] === want[i]) i++;
    const ctx = s => JSON.stringify(s.slice(Math.max(0, i - 60), i + 100));
    console.log(`FAIL ${slug}: first difference at byte ${i}\n  stored ${ctx(want)}\n  served ${ctx(got)}`);
  }
} catch (e) { console.error(`legacy-parity-check: ${e.message}`); bad++; } finally { cleanup(); if (tmp) rmSync(tmp, { recursive: true, force: true }); }
console.log(bad ? `legacy-parity-check: ${bad} difference(s)` : has('--capture') ? `legacy-parity-check: ${PAGES.length} pages stored in ${OUT}` : `legacy-parity-check: ${PAGES.length} pages identical`);
process.exit(bad ? 1 : 0);
