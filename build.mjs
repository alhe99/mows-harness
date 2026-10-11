#!/usr/bin/env node
// build.mjs — web/ -> dist/ (ARCHITECTURE.md section 1). Off-server only: the dashboard imports node: builtins and never this.
//   node build.mjs          builds dist/ from web/ and package-lock.json; two builds of the same inputs are byte-identical.
// Rules (K-04, K-11, K-25, K-30): esm + splitting + minify + es2022, .mjs out, [name].[hash] names, metafile; every raw C0 byte
// in a string literal is rewritten to \xNN and dist/ is asserted free of them; dist/manifest.json lists every output with its
// sha256; no source map is ever written.
import { build } from 'esbuild';
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { basename, join } from 'node:path';

const OUT = 'dist';
// The /term document (web/pages/term/, ARCHITECTURE section 6) and the /md stylesheet (web/pages/md/): their own entries, never in the shell graph.
// themes.json is the one source of the terminal themes (K-12): the `themes:css` and `themes:names` modules below are generated from it here,
// so the [data-theme] blocks exist only in the term entry's stylesheet and no second copy of a theme lives in the tree.
const THEMES = JSON.parse(readFileSync('infra/webconsole/themes.json', 'utf8'));
const themes = {
  name: 'themes',
  setup(b) {
    b.onResolve({ filter: /^themes:(css|names)$/ }, a => ({ path: a.path, namespace: 'themes' }));
    b.onLoad({ filter: /.*/, namespace: 'themes' }, a => a.path === 'themes:names'
      ? { contents: `export default ${JSON.stringify(Object.keys(THEMES))}`, loader: 'js' }
      : { contents: Object.entries(THEMES).map(([n, t]) => `[data-theme=${JSON.stringify(n)}]{${Object.entries(t).map(([k, v]) => `--t-${k}:${v}`).join(';')}}`).join('\n'), loader: 'css' });
  },
};
const entryPoints = [
  'web/main.mjs', 'web/tokens.css',
  { in: 'web/pages/term/term.mjs', out: 'term' }, { in: 'web/pages/md/md.css', out: 'md' },
  { in: 'web/md.mjs', out: 'marked' }, // the markdown chunk gets its own budget (--chunk marked); chat.mjs imports it lazily
  ...readdirSync('web/views').filter(f => f.endsWith('.mjs')).sort().map(f => `web/views/${f}`),
];

const r = await build({
  entryPoints, outdir: OUT, bundle: true, format: 'esm', splitting: true, minify: true, target: 'es2022',
  outExtension: { '.js': '.mjs' }, entryNames: '[name].[hash]', chunkNames: '[name].[hash]', assetNames: '[name].[hash]',
  loader: { '.woff2': 'file' }, publicPath: '/assets', legalComments: 'none', sourcemap: false,
  metafile: true, write: false, logLevel: 'warning', plugins: [themes],
  // Fallback, one line (ARCHITECTURE section 1): if the phase 02 WebKit probes show a Preact 11 hydration or ref regression,
  // alias both to the 10.x / 1.x lines and change nothing else:  alias: { preact: 'preact10', '@preact/signals': 'signals1' },
});

// C0 post-pass: a raw control byte inside a minified string would survive esbuild and then break every proxy and gate that
// treats dist/ as text. \xNN is the same string. Anything left (or in a css file) is a build failure, not a quiet pass.
const C0 = /[\x00-\x08\x0B-\x1F\x7F]/g, hasC0 = /[\x00-\x08\x0B-\x1F\x7F]/;
const files = r.outputFiles.map(f => {
  let buf = Buffer.from(f.contents);
  const name = basename(f.path);
  if (name.endsWith('.mjs')) buf = Buffer.from(buf.toString('utf8').replace(C0, c => `\\x${c.charCodeAt(0).toString(16).padStart(2, '0')}`));
  if (name.endsWith('.map')) throw new Error(`build wrote a source map (${name}); dist/ never holds one`);
  if (/\.(mjs|css)$/.test(name) && hasC0.test(buf.toString('utf8'))) throw new Error(`${name} still holds a raw control byte`);
  return [name, buf];
});
// the /term document: one static page, the hashed names filled in; make-term-index.sh copies it to where Caddy serves /term
const out = ext => files.map(([n]) => n).find(n => n.startsWith('term.') && n.endsWith(ext));
files.push(['term.html', Buffer.from(readFileSync('web/pages/term/index.html', 'utf8').replace('%%TERM_JS%%', `/assets/${out('.mjs')}`).replace('%%TERM_CSS%%', `/assets/${out('.css')}`))]);
files.push(['metafile.json', Buffer.from(JSON.stringify(r.metafile) + '\n')]);

rmSync(OUT, { recursive: true, force: true });
mkdirSync(OUT, { recursive: true });
const manifest = { files: {} };
for (const [name, buf] of files.sort(([a], [b]) => (a < b ? -1 : 1))) {
  writeFileSync(join(OUT, name), buf);
  manifest.files[name] = { sha256: createHash('sha256').update(buf).digest('hex'), bytes: buf.length };
}
writeFileSync(join(OUT, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n');
console.log(`build: ${files.length} files in ${OUT}/`);
