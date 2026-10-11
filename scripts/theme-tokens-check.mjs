#!/usr/bin/env node
// theme-tokens-check.mjs — infra/webconsole/themes.json is the single source of the terminal themes (ledger B-01, K-12): build.mjs turns it into one
// [data-theme="<Name>"] block per theme in the /term stylesheet, as --t-<key> custom properties, and nothing else may carry a copy.
//   node scripts/theme-tokens-check.mjs [--dist dist]
// Asserts: every theme and every one of its 20 keys appears in the generated [data-theme] CSS with the same colour (read from the built
// dist/term.<hash>.css, so a stale build fails here), the CSS holds no theme that is not in themes.json, and no second copy of the themes lives in
// the tree (a file other than themes.json holding the background colours of six or more themes: the inline copy 46-cctheme.html used to be).
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

const dist = process.argv.includes('--dist') ? process.argv[process.argv.indexOf('--dist') + 1] : 'dist';
const SRC = 'infra/webconsole/themes.json';
const THEMES = JSON.parse(readFileSync(SRC, 'utf8'));
let bad = 0;
const check = (id, ok, detail) => { if (!ok) bad++; console.log(`${ok ? 'PASS' : 'FAIL'} ${id}${ok || detail === undefined ? '' : ' ' + JSON.stringify(detail)}`); };

// #rgb -> #rrggbb, lower case: a minifier may shorten a colour, it may not change one
const norm = v => { v = v.trim().toLowerCase(); return /^#[0-9a-f]{3}$/.test(v) ? '#' + [...v.slice(1)].map(c => c + c).join('') : v; };

const names = readdirSync(dist).filter(f => /^term\.[A-Za-z0-9_-]+\.css$/.test(f));
check('dist holds exactly one term.<hash>.css', names.length === 1, names);
const css = names.length ? readFileSync(join(dist, names[0]), 'utf8') : '';
const blocks = new Map();
for (const m of css.matchAll(/\[data-theme=(?:"([^"]+)"|([^\]"]+))\]\s*\{([^}]*)\}/g)) {
  const props = new Map();
  for (const d of m[3].split(';')) { const i = d.indexOf(':'); if (i > 0) props.set(d.slice(0, i).trim(), d.slice(i + 1).trim()); }
  blocks.set(m[1] ?? m[2], props);
}
check(`the stylesheet has ${Object.keys(THEMES).length} [data-theme] blocks, one per theme and no other`, blocks.size === Object.keys(THEMES).length && Object.keys(THEMES).every(n => blocks.has(n)), [...blocks.keys()]);
let keys = 0;
for (const [name, t] of Object.entries(THEMES)) {
  const props = blocks.get(name);
  const want = Object.keys(t);
  const missing = want.filter(k => !props || !props.has(`--t-${k}`));
  const wrong = want.filter(k => props && props.has(`--t-${k}`) && norm(props.get(`--t-${k}`)) !== norm(t[k]));
  keys += want.length - missing.length;
  if (want.length !== 20 || missing.length || wrong.length) check(`theme ${name}: its ${want.length} keys are in the CSS with the same colours`, false, { missing, wrong });
}
check(`all ${keys} keys (12 themes x 20) are present with the colours of themes.json`, keys === 12 * 20 && !bad, keys);

// no second copy: walk the tree
const SKIP = new Set(['node_modules', '.git', '.codegraph', '.agent-team', 'dist', 'screenshots']);
const bgs = Object.values(THEMES).map(t => t.background.toLowerCase());
const copies = [];
const walk = d => { for (const e of readdirSync(d, { withFileTypes: true })) {
  if (SKIP.has(e.name)) continue;
  const p = join(d, e.name);
  if (e.isDirectory()) { walk(p); continue; }
  if (p === SRC || !e.isFile() || statSync(p).size > 2e6 || /\.(png|jpg|woff2|gz|ico)$/.test(e.name)) continue;
  let text; try { text = readFileSync(p, 'utf8').toLowerCase(); } catch { continue; }
  if (bgs.filter(b => text.includes(b)).length >= 6) copies.push(p);
} };
walk('.');
check('no second copy of the themes in the tree (themes.json is the only file holding them)', copies.length === 0, copies);
console.log(bad ? `theme-tokens-check: ${bad} FAILED` : 'theme-tokens-check: ALL PASS');
process.exit(bad ? 1 : 0);
