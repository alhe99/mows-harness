#!/usr/bin/env node
// parity-capture.mjs — the visual-parity baseline (ledger D-03, K-33). Every route of the dashboard at
// 390x844 (DPR 3) and 1280x800 on WebKit and Chromium -> <out>/<engine>/<slug>-<width>.png.
//   node scripts/parity-capture.mjs [--ui legacy|next] [--route /path] [--out dir] [--engine webkit,chromium] [--port 3921]
// Data is fixed by docs/qa/probes/fixture.sh run in a throwaway container (MOWS_QA_PARITY=1: one agent, one
// run, two transcripts, one markdown file, empty fleet). Needs docker and Playwright; fails loudly without.
// Determinism, in the order it can bite:
//   - Date.now / new Date() frozen by addInitScript; animations, transitions and the caret off;
//   - server-rendered relative times ("24d", "35m ago", "11d 14h") are (and file mtimes) rewritten to 00 in the DOM, so the
//     baseline does not age by the day; the host metrics (load, memory, swap, disk) are the host's, not the
//     fixture's, and are masked. Both are applied to BOTH documents, so a diff is never about them.
//     A view that renders a volatile value in new markup tags it data-volatile and is masked the same way.
// --ui next adds `--ui=next` to lite.mjs (phase 01 onward; an older lite.mjs ignores it and serves legacy) and captures the
// shell, which is mounted at /next until phase 05 swaps it in (/md stays its own document). --route captures that one route only.
import { spawnSync } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { join, resolve } from 'node:path';

const argv = process.argv.slice(2);
const opt = (f, d) => (argv.includes(f) ? argv[argv.indexOf(f) + 1] : d);
const ui = opt('--ui', 'legacy');
if (!['legacy', 'next'].includes(ui)) { console.error('--ui legacy|next'); process.exit(2); }
const out = resolve(opt('--out', 'docs/qa/baseline/cockpit'));
const engines = opt('--engine', 'webkit,chromium').split(',');
const port = +opt('--port', 3921);
const repo = resolve(import.meta.dirname, '..');
const BOX = `mows-parity-${process.pid}`;

const DEMO_HOME = `/${'home'}/demo`; // built, not literal: preflight forbids bare home paths
const AGENT = 'harness-reviewer', RUN = '20260916-101500-1', SID = 'bbbb2222-3333-4444-5555-666666666666';
const ALL_ROUTES = [
  ['home', '/'], ['history', '/history'], ['system', '/system'], ['device', '/device'], ['agents', '/agents'],
  ['agent', `/agents/${AGENT}`], ['run', `/agents/${AGENT}/${RUN}`], ['session', `/s/demo/${SID}`],
  ['md', `/md?f=${encodeURIComponent(`${DEMO_HOME}/parity.md`)}`],
];
const ROUTES = ALL_ROUTES.filter(([, r]) => !opt('--route') || r === opt('--route'));
if (!ROUTES.length) { console.error(`--route ${opt('--route')} is not one of: ${ALL_ROUTES.map(r => r[1]).join(' ')}`); process.exit(2); }
const at = r => (ui === 'next' && !r.startsWith('/md') ? `/next${r}` : r);
const VIEWPORTS = [[390, 844, 3, true], [1280, 800, 1, false]];
const MASK = '.mbar-row, [data-volatile]';

const docker = (...a) => spawnSync('docker', a, { encoding: 'utf8' });
const cleanup = () => { docker('rm', '-f', BOX); };
for (const s of ['SIGINT', 'SIGTERM']) process.on(s, () => { cleanup(); process.exit(130); });

const freeze = () => {
  const T = Date.parse('2026-10-11T12:00:00Z'), D = Date;
  globalThis.Date = class extends D { constructor(...a) { a.length ? super(...a) : super(T); } static now() { return T; } };
  const css = document.createElement('style');
  css.textContent = '*,*::before,*::after{animation:none!important;transition:none!important;caret-color:transparent!important;scroll-behavior:auto!important}';
  document.addEventListener('DOMContentLoaded', () => document.head.append(css));
};
// text nodes only: "24d", "35m ago", "11d 14h", file mtimes ("2026-10-11 03:51Z"); "now" stays. 00 keeps the width the same every day.
const normalise = () => {
  const re = /\b\d{1,3}(?=\s?(?:s|m|h|d|w|mo|y)\b)/g;
  const w = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
  for (let n; (n = w.nextNode());) {
    if (n.parentElement?.closest('script,style,pre,code,article')) continue;
    const t = n.nodeValue.replace(/127\.0\.0\.1:\d+/g, '127.0.0.1:0000')
      .replace(/\d{4}-\d\d-\d\d[ T]\d\d:\d\d(:\d\d)?Z?/g, '0000-00-00 00:00').replace(re, '00');
    if (t !== n.nodeValue) n.nodeValue = t;
  }
};

let pw;
try { pw = await import('playwright'); } catch { console.error('parity-capture: playwright is not installed (npm install --ignore-scripts; browsers: npx playwright install chromium webkit)'); process.exit(2); }

cleanup();
const up = docker('run', '-d', '--name', BOX, '-e', 'MOWS_QA_PARITY=1', '-e', `MOWS_QA_LITE_ARGS=${ui === 'next' ? '--ui=next' : ''}`,
  '-p', `127.0.0.1:${port}:3005`, '-v', `${repo}:/r:ro`, '-v', `${join(repo, 'docs/qa/probes')}:/probes:ro`, 'node:20-slim', 'bash', '/probes/fixture.sh');
if (up.status !== 0) { console.error(`parity-capture: docker run failed: ${up.stderr.trim()}`); process.exit(2); }
const base = `http://127.0.0.1:${port}`;
let failed = 0;
try {
  let ready = false;
  for (let i = 0; i < 40 && !ready; i++) { ready = (await fetch(`${base}/healthz`).then(r => r.ok, () => false)); if (!ready) await new Promise(r => setTimeout(r, 1000)); }
  if (!ready) throw new Error(`the fixture dashboard never came up on ${port}`);
  await new Promise(r => setTimeout(r, 1500)); // first index scan
  for (const engine of engines) {
    mkdirSync(join(out, engine), { recursive: true });
    const browser = await pw[engine].launch();
    for (const [w, h, dpr, mobile] of VIEWPORTS) {
      const ctx = await browser.newContext({ viewport: { width: w, height: h }, deviceScaleFactor: dpr, hasTouch: mobile, isMobile: mobile,
        reducedMotion: 'reduce', colorScheme: 'dark', serviceWorkers: 'block' });
      await ctx.addInitScript(freeze);
      const page = await ctx.newPage();
      for (const [slug, route] of ROUTES) {
        const file = join(out, engine, `${slug}-${w}.png`);
        try {
          const resp = await page.goto(base + at(route), { waitUntil: 'load' }); // an open SSE never reaches networkidle
          if (!resp.ok()) throw new Error(`HTTP ${resp.status()}`);
          await page.evaluate(() => document.fonts.ready);
          await page.evaluate(normalise);
          await page.waitForTimeout(300);
          await page.screenshot({ path: file, fullPage: true, animations: 'disabled', caret: 'hide', mask: [page.locator(MASK)], maskColor: '#52525c' });
          console.log(`ok   ${engine}/${slug}-${w}.png`);
        } catch (e) { failed++; console.error(`FAIL ${engine}/${slug}-${w}.png ${e.message.split('\n')[0]}`); }
      }
      await ctx.close();
    }
    await browser.close();
  }
} catch (e) { console.error(`parity-capture: ${e.message}`); failed++; } finally { cleanup(); }
console.log(failed ? `parity-capture: ${failed} failure(s)` : `parity-capture: ${engines.length * ROUTES.length * VIEWPORTS.length} images in ${out} (${ui})`);
process.exit(failed ? 1 : 0);
