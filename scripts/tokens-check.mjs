#!/usr/bin/env node
// tokens-check.mjs — web/tokens.css keeps every custom property of the legacy dashboard :root, same value (ledger B-01, K-12).
// Reads the legacy stylesheet out of infra/dashboard/legacy.mjs (the `const CSS` template) so the comparison target is the
// running server's own source, not a copy. Also pins the layer order and the single dark scheme.
//   node scripts/tokens-check.mjs
import { readFileSync } from 'node:fs';

const strip = css => css.replace(/\/\*[\s\S]*?\*\//g, '');
const norm = v => v.replace(/\s+/g, ' ').trim();
// every `--name: value` inside any `:root{...}` block (the legacy file has three, one inside a media query)
const rootVars = css => {
  const out = new Map();
  for (const [, body] of strip(css).matchAll(/:root\s*\{([^{}]*)\}/g))
    for (const [, k, v] of body.matchAll(/(--[\w-]+)\s*:\s*([^;]+?)\s*(?:;|$)/g)) out.set(k, norm(v));
  return out;
};

const lite = readFileSync(new URL('../infra/dashboard/legacy.mjs', import.meta.url), 'utf8');
const m = /^(?:export )?const CSS = `\n([\s\S]*?)\n`;$/m.exec(lite);
if (!m) { console.error('FAIL: could not find `const CSS` in legacy.mjs'); process.exit(1); }
const legacy = rootVars(m[1]);
const css = readFileSync(new URL('../web/tokens.css', import.meta.url), 'utf8');
const next = rootVars(css);

let bad = 0;
const fail = msg => { bad++; console.log(`FAIL: ${msg}`); };
for (const [k, v] of legacy) {
  if (!next.has(k)) fail(`${k} is in the legacy :root and missing from tokens.css`);
  else if (next.get(k) !== v) fail(`${k} differs: legacy ${v.slice(0, 60)} / tokens.css ${next.get(k).slice(0, 60)}`);
}
if (legacy.size !== 32) fail(`expected the 32 custom properties of MAP 2.2 in the legacy :root, found ${legacy.size}`);
if (!/^@layer tokens, base, components, views;$/m.test(css)) fail('tokens.css must declare "@layer tokens, base, components, views;"');
if (!/color-scheme:\s*dark/.test(css)) fail('tokens.css must set color-scheme: dark');
if (/light-dark\(|color-scheme:\s*(light|[^;}]*light)/.test(css)) fail('tokens.css is dark only (K-12): no light-dark(), no light scheme');
if (!bad) console.log(`PASS: ${legacy.size} legacy custom properties present in tokens.css with identical values; layers and dark scheme as specified`);
process.exit(bad ? 1 : 0);
