#!/usr/bin/env node
// build.mjs — web/ -> dist/ (ARCHITECTURE.md section 1). Off-server only: the dashboard imports node: builtins and never this.
//   node build.mjs          builds dist/ from web/ and package-lock.json; two builds of the same inputs are byte-identical.
// Rules (K-04, K-11, K-25, K-30): esm + splitting + minify + es2022, .mjs out, [name].[hash] names, metafile; every raw C0 byte
// in a string literal is rewritten to \xNN and dist/ is asserted free of them; dist/manifest.json lists every output with its
// sha256; no source map is ever written.
import { build } from 'esbuild';
import { createHash } from 'node:crypto';
import { mkdirSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { basename, join } from 'node:path';

const OUT = 'dist';
const entryPoints = [
  'web/main.mjs', 'web/tokens.css',
  { in: 'web/md.mjs', out: 'marked' }, // the markdown chunk gets its own budget (--chunk marked); chat.mjs imports it lazily
  ...readdirSync('web/views').filter(f => f.endsWith('.mjs')).sort().map(f => `web/views/${f}`),
];

const r = await build({
  entryPoints, outdir: OUT, bundle: true, format: 'esm', splitting: true, minify: true, target: 'es2022',
  outExtension: { '.js': '.mjs' }, entryNames: '[name].[hash]', chunkNames: '[name].[hash]', assetNames: '[name].[hash]',
  loader: { '.woff2': 'file' }, publicPath: '/assets', legalComments: 'none', sourcemap: false,
  metafile: true, write: false, logLevel: 'warning',
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
