#!/usr/bin/env node
// lh-gate.mjs — Lighthouse 13.5.0 performance gate. Exit 1 if the median LCP > --lcp or median TBT > --tbt;
// --warn prints the overage and exits 0 (phases 00-04); exit 2 means "could not measure", never a pass.
//   node scripts/lh-gate.mjs --url <url> [--lcp 2500] [--tbt 200] [--runs 3] [--warn] [--out <dir>]
// Default mobile profile (--form-factor=mobile, simulated throttling), performance category only.
// CHROME_PATH is Playwright's Chromium: /opt/google/chrome is x86-64 and will not run on this box.
// A page holding an SSE open never reaches network idle, hence --max-wait-for-load=60000 and a retry
// on NO_FCP (the first run against `/` returned it). The raw JSON of every run is kept next to the log.
import { spawnSync } from 'node:child_process';
import { readFileSync, mkdirSync, existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';

const argv = process.argv.slice(2);
const opt = (f, d) => (argv.includes(f) ? argv[argv.indexOf(f) + 1] : d);
const url = opt('--url');
if (!url) { console.error('usage: lh-gate.mjs --url <url> [--lcp ms] [--tbt ms] [--runs n] [--warn] [--out dir]'); process.exit(2); }
const lcpMax = +opt('--lcp', 2500), tbtMax = +opt('--tbt', 200), runs = +opt('--runs', 3), warn = argv.includes('--warn');
const out = opt('--out', join(process.env.RUN || '.agent-team/local', 'verify'));
mkdirSync(out, { recursive: true });

async function chromePath() {
  if (process.env.CHROME_PATH && !process.env.CHROME_PATH.startsWith('/opt/google/')) return process.env.CHROME_PATH;
  try { const p = (await import('playwright')).chromium.executablePath(); if (existsSync(p)) return p; } catch {}
  const root = join(process.env.HOME || homedir(), '.cache/ms-playwright');
  const found = existsSync(root) ? readdirSync(root).filter(d => /^chromium-\d+$/.test(d)).sort()
    .flatMap(d => readdirSync(join(root, d)).filter(s => /^chrome-linux/.test(s)).map(s => join(root, d, s, 'chrome'))).filter(existsSync) : [];
  if (!found.length) throw new Error("no Playwright Chromium found (npm install; npx playwright install chromium)");
  return found.at(-1);
}

const median = a => { const s = [...a].sort((x, y) => x - y); return s[Math.floor((s.length - 1) / 2)]; };
const slug = url.replace(/^https?:\/\//, '').replace(/[^A-Za-z0-9]+/g, '_').replace(/^_|_$/g, '');
const lh = join(import.meta.dirname, '..', 'node_modules', '.bin', 'lighthouse');
if (!existsSync(lh)) { console.error('lighthouse is not installed (npm install --ignore-scripts)'); process.exit(2); }
const CHROME_PATH = await chromePath();

function once(n, attempt) {
  const file = join(out, `lh-${slug}-${n}${attempt ? `-retry${attempt}` : ''}.json`);
  const r = spawnSync(lh, [url, '--form-factor=mobile', '--only-categories=performance', '--max-wait-for-load=60000',
    '--output=json', `--output-path=${file}`, '--quiet', '--chrome-flags=--headless=new --no-sandbox --disable-gpu'],
    { env: { ...process.env, CHROME_PATH }, encoding: 'utf8', timeout: 5 * 60_000 });
  if (r.status !== 0 || !existsSync(file)) return { err: (r.stderr || r.stdout || `exit ${r.status}`).trim().split('\n').slice(-2).join(' | '), file };
  const j = JSON.parse(readFileSync(file, 'utf8'));
  if (j.runtimeError) return { err: `${j.runtimeError.code}: ${j.runtimeError.message}`, file };
  const a = j.audits;
  return { lcp: a['largest-contentful-paint'].numericValue, tbt: a['total-blocking-time'].numericValue, file };
}

const lcps = [], tbts = [];
for (let n = 1; n <= runs; n++) {
  let r;
  for (let attempt = 0; attempt < 3; attempt++) {
    r = once(n, attempt);
    if (!r.err) break;
    console.error(`run ${n} attempt ${attempt + 1}: ${r.err}`);
  }
  if (r.err) { console.error(`lh-gate: could not measure ${url} (run ${n})`); process.exit(2); }
  console.log(`run ${n}: LCP ${r.lcp.toFixed(0)} ms  TBT ${r.tbt.toFixed(0)} ms  (${r.file})`);
  lcps.push(r.lcp); tbts.push(r.tbt);
}
const lcp = median(lcps), tbt = median(tbts);
console.log(`${url} median of ${runs}: LCP ${lcp.toFixed(0)} ms (max ${lcpMax})  TBT ${tbt.toFixed(0)} ms (max ${tbtMax})`);
const over = [];
if (lcp > lcpMax) over.push(`LCP ${(lcp - lcpMax).toFixed(0)} ms over`);
if (tbt > tbtMax) over.push(`TBT ${(tbt - tbtMax).toFixed(0)} ms over`);
if (!over.length) { console.log('ok'); process.exit(0); }
console.log(`${warn ? 'WARN' : 'FAIL'}: ${over.join(', ')}`);
process.exit(warn ? 0 : 1);
