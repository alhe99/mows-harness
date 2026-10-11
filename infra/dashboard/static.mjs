// static.mjs — serves the committed build output under /assets/ (ARCHITECTURE.md section 10; K-11, K-32).
// dist/ names are esbuild's own ([name].[hash].ext) and are served verbatim, immutable, with an ETag taken from
// dist/manifest.json. Only names the manifest lists are served, so a stray file or a `.map`
// can never become a route. Node builtins only: this runs on the box, the build does not.
import { existsSync, readFileSync, statSync, promises as fsp } from 'node:fs';

// COUPLED TO scripts/preflight.sh (asset extensions agree): the ceiling there measures exactly these. Change both or neither.
export const ASSET_TYPES = {
  mjs: 'text/javascript; charset=utf-8',
  css: 'text/css; charset=utf-8',
  woff2: 'font/woff2',
  json: 'application/json',
};

// next to this file when deployed ($DEST/dist), two levels up in a checkout
const here = new URL('.', import.meta.url);
const DIST = [new URL('dist/', here), new URL('../../dist/', here)].map(u => u.pathname).find(p => existsSync(p + 'manifest.json'));
const MANIFEST = DIST && DIST + 'manifest.json';

let seen = 0, files = new Map(); // name -> { type, etag, sha }
function load() {
  if (!MANIFEST) return files;
  const mt = statSync(MANIFEST).mtimeMs;
  if (mt === seen) return files;
  seen = mt;
  files = new Map();
  for (const [name, v] of Object.entries(JSON.parse(readFileSync(MANIFEST, 'utf8')).files || {})) {
    const type = ASSET_TYPES[name.slice(name.lastIndexOf('.') + 1)];
    if (type) files.set(name, { type, etag: `"${v.sha256}"`, sha: v.sha256 });
  }
  return files;
}

/** '/assets/<name>' of the one dist file named <stem>.<hash>.<ext>, or null when the build is absent. */
export const assetUrl = (stem, ext) => {
  const re = new RegExp(`^${stem}\\.[A-Za-z0-9_-]+\\.${ext}$`);
  for (const name of load().keys()) if (re.test(name)) return '/assets/' + name;
  return null;
};

export async function assetView(req, res, name) {
  const a = load().get(name);
  if (!a) { res.writeHead(404); return res.end(); }
  const h = { etag: a.etag, 'cache-control': 'public, max-age=31536000, immutable' };
  if (req.headers['if-none-match'] === a.etag) { res.writeHead(304, h); return res.end(); }
  const buf = await fsp.readFile(DIST + name);
  res.writeHead(200, { ...h, 'content-type': a.type, 'content-length': buf.length });
  res.end(buf);
}

// What the worker precaches: the shell's own files. The /term and /md documents are network-only, so their assets, the build's metafile and the
// worker itself stay out.
const PRECACHE_SKIP = /^(sw|term|md|addon-webgl|metafile)\./;

/** GET /sw.js: the built worker (dist/sw.<hash>.mjs) behind the list of files to precache, so its bytes change whenever the build does and the browser
 *  installs the new one (web/sw.mjs). Not immutable and not hashed in its URL: a worker is fetched by the browser at a fixed path and revalidated. */
export async function swView(req, res) {
  const all = load(), sw = [...all.keys()].find(n => /^sw\.[A-Za-z0-9_-]+\.mjs$/.test(n));
  if (!sw) { res.writeHead(404); return res.end(); }
  const list = Object.fromEntries([...all].filter(([n]) => !PRECACHE_SKIP.test(n)).map(([n, a]) => [n, a.sha]));
  const buf = Buffer.concat([Buffer.from(`self.PRECACHE=${JSON.stringify({ files: list })};\n`), await fsp.readFile(DIST + sw)]);
  res.writeHead(200, { 'content-type': 'text/javascript; charset=utf-8', 'cache-control': 'no-cache', 'content-length': buf.length });
  res.end(buf);
}
