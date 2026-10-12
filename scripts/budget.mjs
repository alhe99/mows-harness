#!/usr/bin/env node
// budget.mjs — size gates in the unit phones receive: gzip-9 per file, summed (K-06; same unit as
// preflight 5b / G-03). Exit-code decided: --max <kb> exits 1 over, --warn prints the overage and exits 0.
//   node scripts/budget.mjs --route <entry|shell>   entry + every chunk it statically imports (metafile)
//   node scripts/budget.mjs --chunk <name>          dist file(s) named <name>.<hash>.<ext>
//   node scripts/budget.mjs --file <name>           dist file <name> or <stem>.<hash>.<ext>
//   node scripts/budget.mjs --fonts                 identity bytes of the woff2 files
//   node scripts/budget.mjs --server                infra/dashboard/{lite.mjs,core.mjs,routes/*,sse.mjs,static.mjs} (core.mjs holds what the split took out of lite.mjs; legacy.mjs is the old UI and is not server code)
//   node scripts/budget.mjs --legacy-app            infra/dashboard/app (today's UI)
//   node scripts/budget.mjs --all [--warn]          every ARCHITECTURE section 9 budget in one run: shell, each web/views/*.mjs route, term, marked, tokens.css,
//                                                   fonts, the server, and "no mermaid in dist/"; exit 1 if any fails (what preflight and CI run)
//   node scripts/budget.mjs --self-test
// Options: --max <kb>  --warn  --dist <dir> (default dist)  --metafile <path> (default <dist>/metafile.json)
// kB here is 1000 B, as in the spec's "130 776 B".
// gzip is the `gzip` binary, `-9 -c <path>`: byte-for-byte what preflight 5b sums (the name header counts).
import { readFileSync, readdirSync, statSync, existsSync, mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { join, basename, extname } from 'node:path';
import { tmpdir } from 'node:os';

const argv = process.argv.slice(2);
const has = f => argv.includes(f);
const opt = (f, d) => (has(f) ? argv[argv.indexOf(f) + 1] : d);
const DIST = opt('--dist', 'dist');

const gz = p => {
  const r = spawnSync('gzip', ['-9', '-c', p], { maxBuffer: 1 << 28 });
  if (r.status !== 0) throw new Error(`gzip failed on ${p}`);
  return r.stdout.length;
};
const walk = (d, keep) => readdirSync(d, { withFileTypes: true }).flatMap(e =>
  e.isDirectory() ? walk(join(d, e.name), keep) : keep(e.name) ? [join(d, e.name)] : []);
const sum = (files, size) => files.reduce((n, f) => n + size(f), 0);
// `tokens.css` matches tokens.css and tokens.<hash>.css
const named = (dir, name) => {
  const ext = extname(name), stem = basename(name, ext);
  const re = new RegExp(`^${stem.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(\\.[A-Za-z0-9_-]+)?\\${ext}$`);
  return existsSync(dir) ? readdirSync(dir).filter(f => re.test(f)).map(f => join(dir, f)) : [];
};

// Route closure: the entry output plus every output reachable through kind=import-statement edges
// (dynamic import() is a different route and does not count). Keys of the metafile are build-relative
// paths; only the basename is compared, since that is what dist/ holds.
function closure(entry, dir, metaPath) {
  if (!existsSync(metaPath)) throw new Error(`no metafile at ${metaPath} (build.mjs writes it; phase 01)`);
  const outs = JSON.parse(readFileSync(metaPath, 'utf8')).outputs || {};
  const byBase = Object.fromEntries(Object.entries(outs).map(([k, v]) => [basename(k), v]));
  const want = { shell: 'main' }[entry] || entry;
  const unhashed = n => n.replace(/\.[A-Za-z0-9_-]{6,}(\.[a-z0-9]+)$/, '$1');
  const root = Object.entries(byBase).find(([n, v]) => v.entryPoint && (
    basename(v.entryPoint, extname(v.entryPoint)) === want || v.entryPoint.replace(/\.[a-z]+$/, '').endsWith(`/${want}`) ||
    basename(unhashed(n), extname(n)) === want))?.[0];
  if (!root) throw new Error(`no entry named "${entry}" in ${metaPath}`);
  const seen = new Set(), todo = [root];
  while (todo.length) {
    const n = todo.pop();
    if (seen.has(n)) continue;
    seen.add(n);
    for (const i of byBase[n]?.imports || []) if (i.kind === 'import-statement' && !i.external) todo.push(basename(i.path));
  }
  // the entry's own css bundle (esbuild emits it next to the entry) belongs to the route
  const css = byBase[root].cssBundle ? [basename(byBase[root].cssBundle)] : [];
  return [...seen, ...css].map(n => join(dir, n));
}

function measure() {
  if (has('--legacy-app')) return { label: 'legacy-app', files: walk('infra/dashboard/app', n => /\.(mjs|css|woff2)$/.test(n)), size: gz };
  if (has('--server')) {
    const d = 'infra/dashboard';
    const files = ['lite.mjs', 'core.mjs', 'sse.mjs', 'static.mjs'].map(f => join(d, f)).filter(existsSync)
      .concat(existsSync(join(d, 'routes')) ? walk(join(d, 'routes'), n => n.endsWith('.mjs')) : []);
    return { label: 'server', files, size: gz };
  }
  if (has('--fonts')) {
    // identity bytes: what the browser downloads once, before any transfer encoding
    const dir = existsSync(DIST) && readdirSync(DIST).some(f => f.endsWith('.woff2')) ? DIST : 'infra/dashboard/app/vendor';
    return { label: `fonts (${dir})`, files: walk(dir, n => n.endsWith('.woff2')), size: f => statSync(f).size };
  }
  if (has('--route')) {
    const e = opt('--route');
    return { label: `route ${e}`, files: closure(e, DIST, opt('--metafile', join(DIST, 'metafile.json'))), size: gz };
  }
  const which = has('--chunk') ? '--chunk' : has('--file') ? '--file' : null;
  if (which) {
    const n = opt(which), files = which === '--chunk'
      ? (existsSync(DIST) ? readdirSync(DIST).filter(f => f.startsWith(`${n}.`) && /\.(mjs|css)$/.test(f)).map(f => join(DIST, f)) : [])
      : named(DIST, n);
    if (!files.length) throw new Error(`no ${which.slice(2)} "${n}" in ${DIST}/`);
    return { label: `${which.slice(2)} ${n}`, files, size: gz };
  }
  throw new Error('usage: budget.mjs --route|--chunk|--file|--fonts|--server|--legacy-app|--all [--max kb] [--warn] | --self-test');
}

function report(label, bytes, files) {
  console.log(`${label}: ${bytes} B (${(bytes / 1000).toFixed(1)} kB) across ${files} file(s)`);
  if (!has('--max')) return 0;
  const max = +opt('--max'), over = bytes - max * 1000;
  if (!(max > 0)) { console.error('--max needs a positive number of kB'); return 2; }
  if (over <= 0) { console.log(`ok: within ${max} kB (${(-over / 1000).toFixed(1)} kB headroom)`); return 0; }
  console.log(`${has('--warn') ? 'WARN' : 'FAIL'}: ${(over / 1000).toFixed(1)} kB over the ${max} kB budget`);
  return has('--warn') ? 0 : 1;
}

// ARCHITECTURE section 9 / BUDGET in web/contract.d.ts, kB each; a view's budget is its route closure. The closure counts the shared
// preact + signals + store chunks (about 10 kB) that the shell already loaded, so a view's own code gets about 5 kB of the 15. The grid
// view (desktop only, its link hidden on phones) carries its own stylesheet and the pane / tab / sidebar machinery in one chunk: 20.
const VIEW_KB = { grid: 20 };
function all() {
  const views = existsSync('web/views') ? readdirSync('web/views').filter(f => f.endsWith('.mjs')).map(f => basename(f, '.mjs')).sort() : [];
  const runs = [['--route', 'shell', 30], ...views.map(v => ['--route', v, VIEW_KB[v] || 15]), ['--chunk', 'marked', 25], ['--file', 'tokens.css', 12], ['--fonts', '', 80], ['--route', 'term', 130], ['--server', '', 140]];
  let bad = 0;
  for (const [flag, name, kb] of runs) {
    const r = spawnSync('node', [process.argv[1], '--dist', DIST, flag, ...(name ? [name] : []), '--max', String(kb), ...(has('--warn') ? ['--warn'] : [])], { encoding: 'utf8' });
    process.stdout.write(r.stdout + r.stderr);
    if (r.status) bad++;
  }
  // mermaid is pinned-CDN on /md (O-3) and never enters dist/
  const hits = existsSync(DIST) ? readdirSync(DIST).filter(f => /\.(mjs|css|html|json)$/.test(f) && readFileSync(join(DIST, f), 'utf8').includes('mermaid')) : [];
  console.log(hits.length ? `FAIL: mermaid is in dist/ (${hits.join(', ')})` : 'ok: no mermaid in dist/');
  return bad + hits.length ? 1 : 0;
}

function selfTest() {
  const tmp = mkdtempSync(join(tmpdir(), 'budget-'));
  const run = (...a) => spawnSync('node', [process.argv[1], '--dist', tmp, ...a], { encoding: 'utf8' });
  let bad = 0;
  const ok = (name, c) => { console.log(`${c ? 'PASS' : 'FAIL'} ${name}`); if (!c) bad = 1; };
  try {
    const blob = n => Array.from({ length: n }, (_, i) => `x${(i * 2654435761) >>> 0};`).join('');
    for (const f of ['main.AAAA1111.mjs', 'shared.BBBB2222.mjs', 'view.CCCC3333.mjs', 'later.DDDD4444.mjs', 'tokens.EEEE5555.css', 'marked.FFFF6666.mjs'])
      writeFileSync(join(tmp, f), blob(f.startsWith('main') ? 800 : 400));
    writeFileSync(join(tmp, 'f1.woff2'), 'a'.repeat(1000));
    const out = (n, imports, entryPoint) => [`dist/${n}`, { imports: imports.map(([p, kind]) => ({ path: `dist/${p}`, kind })), ...(entryPoint ? { entryPoint } : {}) }];
    writeFileSync(join(tmp, 'metafile.json'), JSON.stringify({ outputs: Object.fromEntries([
      out('main.AAAA1111.mjs', [['shared.BBBB2222.mjs', 'import-statement'], ['later.DDDD4444.mjs', 'dynamic-import']], 'web/main.mjs'),
      out('shared.BBBB2222.mjs', []), out('later.DDDD4444.mjs', []),
      out('view.CCCC3333.mjs', [['shared.BBBB2222.mjs', 'import-statement']], 'web/views/sessions.mjs')]) }));
    const size = n => gz(join(tmp, n));
    const shell = size('main.AAAA1111.mjs') + size('shared.BBBB2222.mjs');
    ok('--route shell = entry + static imports, not dynamic', run('--route', 'shell').stdout.includes(`${shell} B`));
    ok('--route <view> resolves by entryPoint basename', run('--route', 'sessions').stdout.includes(`${size('view.CCCC3333.mjs') + size('shared.BBBB2222.mjs')} B`));
    ok('--chunk matches <name>.<hash>', run('--chunk', 'marked').stdout.includes(`${size('marked.FFFF6666.mjs')} B`));
    ok('--file matches a hashed name', run('--file', 'tokens.css').stdout.includes(`${size('tokens.EEEE5555.css')} B`));
    ok('--fonts counts identity bytes', run('--fonts').stdout.includes('1000 B'));
    ok('--max under budget exits 0', run('--route', 'shell', '--max', '100').status === 0);
    ok('--max over budget exits 1', run('--route', 'shell', '--max', '0.1').status === 1);
    const w = run('--route', 'shell', '--max', '0.1', '--warn');
    ok('--warn exits 0 and prints the overage', w.status === 0 && /WARN: .* over/.test(w.stdout));
    ok('unknown route is an error, not a pass', run('--route', 'nope', '--max', '100').status !== 0);
    ok('--legacy-app is the preflight 5b number', /: 130776 B/.test(spawnSync('node', [process.argv[1], '--legacy-app'], { encoding: 'utf8' }).stdout));
  } finally { rmSync(tmp, { recursive: true, force: true }); }
  console.log(bad ? 'SELF-TEST FAILED' : 'SELF-TEST OK');
  return bad;
}

try {
  if (has('--self-test')) process.exit(selfTest());
  if (has('--all')) process.exit(all());
  const m = measure();
  process.exit(report(m.label, sum(m.files, m.size), m.files.length));
} catch (e) { console.error(`budget: ${e.message}`); process.exit(2); }
