#!/usr/bin/env node
// parity-diff.mjs — per-image differing-pixel percentage between two parity-capture directories
// (pngjs + pixelmatch, devDependencies installed off-server). Exit 1 if any image exceeds --max,
// --warn prints only. A size mismatch counts as 100 %: a view that grew a row is a parity failure.
//   node scripts/parity-diff.mjs <baseDir> <newDir> [--route <slug>] --max <pct> [--warn] [--engine e]
// Layout: <dir>/<engine>/<slug>-<width>.png; --route matches the slug (home, history, system, ...) or the one-segment path parity-capture takes (/ is home, /history is history).
// A baseline image with no counterpart in <newDir> is a failure; extra images in <newDir> are ignored.
import { readFileSync, readdirSync, existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { PNG } from 'pngjs';
import pixelmatch from 'pixelmatch';

const argv = process.argv.slice(2);
const opt = (f, d) => (argv.includes(f) ? argv[argv.indexOf(f) + 1] : d);
const flagsWithValue = new Set(['--route', '--max', '--engine', '--diff-out']);
const pos = argv.filter((a, i) => !a.startsWith('--') && !flagsWithValue.has(argv[i - 1]));
const [baseDir, newDir] = pos;
const max = +opt('--max', NaN), warn = argv.includes('--warn'), route = opt('--route')?.replace(/^\/$/, 'home').replace(/^\//, ''), only = opt('--engine'), diffOut = opt('--diff-out');
if (!baseDir || !newDir || !(max >= 0)) { console.error('usage: parity-diff.mjs <baseDir> <newDir> [--route slug] --max <pct> [--warn] [--diff-out dir]'); process.exit(2); }
if (!existsSync(baseDir)) { console.error(`parity-diff: no such directory ${baseDir}`); process.exit(2); }

const engines = readdirSync(baseDir, { withFileTypes: true }).filter(d => d.isDirectory() && (!only || d.name === only)).map(d => d.name);
let n = 0, over = 0;
for (const engine of engines) {
  for (const f of readdirSync(join(baseDir, engine)).filter(f => f.endsWith('.png') && (!route || f.startsWith(`${route}-`))).sort()) {
    n++;
    const a = PNG.sync.read(readFileSync(join(baseDir, engine, f)));
    const np = join(newDir, engine, f);
    let pct, note = '';
    if (!existsSync(np)) { pct = 100; note = ' (missing in new)'; }
    else {
      const b = PNG.sync.read(readFileSync(np));
      if (a.width !== b.width || a.height !== b.height) { pct = 100; note = ` (size ${a.width}x${a.height} vs ${b.width}x${b.height})`; }
      else {
        const d = new PNG({ width: a.width, height: a.height });
        const px = pixelmatch(a.data, b.data, d.data, a.width, a.height, { threshold: 0.1 });
        pct = (px / (a.width * a.height)) * 100;
        if (px && diffOut) { mkdirSync(join(diffOut, engine), { recursive: true }); writeFileSync(join(diffOut, engine, f), PNG.sync.write(d)); }
      }
    }
    const bad = pct > max;
    if (bad) over++;
    console.log(`${bad ? (warn ? 'WARN' : 'FAIL') : 'ok  '} ${engine}/${f} ${pct.toFixed(3)} %${note}`);
  }
}
if (!n) { console.error(`parity-diff: no images matched in ${baseDir}${route ? ` for route ${route}` : ''}`); process.exit(2); }
console.log(`${n} image(s), ${over} over ${max} %`);
process.exit(over && !warn ? 1 : 0);
