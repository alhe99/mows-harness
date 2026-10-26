// /md?f=<abs path>: the file checks and the download. The renderer and the page chrome are legacy.mjs's. --ui=legacy answers with legacy.mjs's own
// document (inline styles, mermaid@12 floating, no script policy); --ui=next with the /md document of ARCHITECTURE section 5: the same body on the
// built tokens.css + md.css, and the CSP of K-10 (BASE_CSP + one script source: the pinned CDN and the hash of the loader below).
import { createHash } from 'node:crypto';
import { promises as fsp } from 'node:fs';
import path from 'node:path';
import { BASE_CSP, TMUX_HOME, send, sh, userCmd } from '../core.mjs';
import { DOC_META, footerHtml, mdDocument, mdNotice, mdParts, pageChrome } from '../legacy.mjs';
import { assetUrl } from '../static.mjs';

// Mermaid is never in dist/ (388 IPv4-shaped tokens trip the preflight; ledger A-03, O-3). The page loads this one pinned file from the CDN, with
// an integrity= hash, when the first diagram scrolls into view; a document without a diagram never contacts the CDN. securityLevel strict because
// docs come from anywhere. A diagram that fails to parse keeps its source visible, the error as its tooltip. Wide diagrams start fitted to the
// column; a tap toggles natural size, scrolled sideways inside the box. The layout is mermaid's default (K-09).
const MERMAID = { url: 'https://cdn.jsdelivr.net/npm/mermaid@12.1.0/dist/mermaid.min.js', sri: 'sha384-EbBpjO7rlR6eqZEcG7GaPpyk9H9WrMyPWX4d3KvPYltgt8Z8l0z6R56B1qP40pR4' };
const LOADER = `(function(){
var sel='.mdv pre[data-lang="mermaid"]',first=document.querySelector(sel);
if(!first||!window.IntersectionObserver)return;
async function draw(){
  var m=window.mermaid;m.initialize({startOnLoad:false,theme:'dark',securityLevel:'strict'});
  var n=0;
  for(var pre of document.querySelectorAll(sel)){
    var id='mmd'+n++;
    try{
      var r=await m.render(id,pre.textContent),d=document.createElement('div');d.className='mdmmd';d.innerHTML=r.svg;pre.replaceWith(d);
      var g=d.querySelector('svg'),w=g.viewBox.baseVal.width;
      d.onclick=function(d,g,w){return function(){var on=d.classList.toggle('full');g.style.maxWidth=on?'none':w+'px';g.style.width=on?w+'px':''}}(d,g,w);
    }catch(e){pre.title='mermaid: '+((e&&e.message)||e);var x=document.getElementById('d'+id);if(x)x.remove()}
  }
}
new IntersectionObserver(function(es,o){
  if(!es.some(function(e){return e.isIntersecting}))return;
  o.disconnect();
  var s=document.createElement('script');s.src='${MERMAID.url}';s.integrity='${MERMAID.sri}';s.crossOrigin='anonymous';
  s.onload=draw;s.onerror=function(){first.title='mermaid: could not load from the CDN'};
  document.head.appendChild(s);
}).observe(first);
})();`;
const MD_CSP = `${BASE_CSP}; script-src 'self' https://cdn.jsdelivr.net 'sha256-${createHash('sha256').update(LOADER).digest('base64')}'; style-src 'self' 'unsafe-inline'`;

function mdNextDocument(real, st, src, host) {
  const { title, body, mermaid } = mdParts(real, st, src);
  const { hdr, tabs, termFab } = pageChrome('', null, host, '/agents');
  const asset = (stem, ext) => assetUrl(stem, ext) || '/assets/missing-build';
  return `<!doctype html><html lang="en"><head><meta charset="utf-8">
${DOC_META}
<link rel="stylesheet" href="${asset('tokens', 'css')}"><link rel="stylesheet" href="${asset('md', 'css')}">
<title>${title.replace(/&/g, '&amp;').replace(/</g, '&lt;')}</title></head><body>${hdr}${termFab}${body}
${tabs}${footerHtml()}${mermaid ? `<script>${LOADER}</script>` : ''}
</body></html>`;
}

// An Archify page (an .html file inside a .archify/ folder of the tmux user's home, what /diagrams lists; any other .html is refused) is sent
// as it is, under a CSP sandbox WITHOUT allow-same-origin: the page gets an
// opaque origin, so it cannot read the dashboard's cookies or storage, and connect-src 'none' keeps it from calling anything. Its own inline
// scripts and styles run; exports download; a link opens a new tab that stays sandboxed (no allow-popups-to-escape-sandbox: a window it opens
// gets no origin either). A page that loads anything from the network renders without it. ponytail: same origin as the dashboard, isolated by
// the sandbox alone; a cookie-less subdomain for these files if they ever come from somewhere less trusted than this box's own home.
// COOP same-origin cuts it off from any window that opened it; no-referrer keeps the file path out of the sites its links open.
export const HTML_CSP = "sandbox allow-scripts allow-downloads allow-popups; default-src 'none'; " +
  "script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data: blob:; font-src data:; media-src data: blob:; worker-src blob:; " +
  "connect-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors 'self'";
const MD_ROOT = '/home';
export async function mdView(req, res, url, next = false) {
  const f = url.searchParams.get('f') || '';
  const oops = (code, m) => send(req, res, code, mdNotice(m));
  if (!f.startsWith('/')) return oops(400, 'usage: /md?f=/home/<user>/path/to/file.md');
  const html = /\.html?$/i.test(f);
  if (!html && !/\.(md|markdown|txt)$/i.test(f)) return oops(400, 'only .md, .markdown, .txt and .html files can be previewed.');
  let real, st;
  try { real = await fsp.realpath(f); st = await fsp.stat(real); } catch { return oops(404, `not found: ${f}`); }
  if (!real.startsWith(MD_ROOT + '/')) return oops(403, 'only files under /home are viewable.');
  const cap = html ? 16 : 2; // MB; an Archify page carries its viewer and fonts inline (~1 MB)
  if (!st.isFile() || st.size > cap * 1024 * 1024) return oops(403, `not a regular file under ${cap} MB.`);
  if (html && !(real.startsWith(TMUX_HOME + '/') && real.includes('/.archify/'))) return oops(403, 'only Archify pages (an .html under a .archify/ folder of the home) are viewable.');
  if (html && !url.searchParams.get('dl')) return send(req, res, 200, await fsp.readFile(real), 'text/html; charset=utf-8',
    { 'content-security-policy': HTML_CSP, 'cross-origin-opener-policy': 'same-origin', 'referrer-policy': 'no-referrer' });
  const src = await fsp.readFile(real, 'utf8');
  // ?dl=1 -> the raw file as a download (phones can't reach the VPS disk any other way)
  if (url.searchParams.get('dl')) {
    res.writeHead(200, { 'Content-Type': html ? 'application/octet-stream' : 'text/markdown; charset=utf-8', 'Cache-Control': 'no-store',
      'Content-Disposition': `attachment; filename*=UTF-8''${encodeURIComponent(path.basename(real))}` });
    return res.end(src);
  }
  if (next) return send(req, res, 200, mdNextDocument(real, st, src, req.headers.host || ''), 'text/html; charset=utf-8', { 'content-security-policy': MD_CSP });
  send(req, res, 200, mdDocument(real, st, src, req.headers.host));
}

// ---------- /diagrams: every Archify page under the user's home, newest first, each opening in /md above ----------
// Archify writes <cwd>/.archify/<type>-<slug>-<time>/<slug>.html, and sessions run in the home or a project up to three levels below it, so a
// glob at those depths finds them (~30 ms; a find over the home took 3 s). The glob, the stat and the <title> read run as the tmux user,
// never root, and skip links. ponytail: a project deeper than three levels is not listed; add a depth to the glob when one is.
const DIAGRAMS_SH = `cd "$1" || exit 0
for f in .archify/*/*.html */.archify/*/*.html */*/.archify/*/*.html */*/*/.archify/*/*.html; do
  [ -f "$f" ] && [ ! -L "$f" ] || continue
  t=$(head -c 8192 -- "$f" | tr '\\n\\t' '  ' | grep -o '<title>[^<]*' | head -1)
  printf '%s\\t%s\\t%s\\t%s\\n' "$(stat -c %Y -- "$f")" "$(stat -c %s -- "$f")" "\${t#<title>}" "$f"
done`;
const unent = s => s.replace(/&(lt|gt|quot|#39|amp);/g, (_, e) => ({ lt: '<', gt: '>', quot: '"', '#39': "'", amp: '&' })[e]);
/** the glob's lines -> [{ mt, size, title, path, project, kind }], newest first; a line that does not parse is dropped */
export function diagramRows(out, home) {
  return out.split('\n').map(l => l.split('\t')).filter(c => c.length === 4 && /^\d+$/.test(c[0]) && /\.html?$/.test(c[3])).map(([mt, size, title, rel]) => {
    const [proj, dir] = rel.split('/.archify/').length === 2 ? rel.split('/.archify/') : ['', rel.replace(/^\.archify\//, '')];
    return { mt: +mt * 1000, size: +size, path: home + '/' + rel, project: proj || '~', kind: dir.split('-')[0],
      title: unent(title).replace(/\s+Diagram$/, '').trim() || path.basename(rel, path.extname(rel)) };
  }).sort((a, b) => b.mt - a.mt);
}
export async function diagramsView(req, res) {
  const rows = diagramRows(await sh(...userCmd(['bash', '-O', 'nullglob', '-c', DIAGRAMS_SH, 'diagrams', TMUX_HOME])), TMUX_HOME);
  const e = s => String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
  const ago = ms => (ms < 3_600_000 ? Math.max(1, Math.round(ms / 60_000)) + 'm' : ms < 172_800_000 ? Math.round(ms / 3_600_000) + 'h' : Math.round(ms / 86_400_000) + 'd') + ' ago';
  const { hdr, tabs, termFab } = pageChrome('', null, req.headers.host || '', '/agents');
  const asset = (stem, ext) => assetUrl(stem, ext) || '/assets/missing-build';
  const list = rows.length ? `<ul class="dgl">${rows.map(r => `<li><a href="/md?f=${encodeURIComponent(r.path)}"><b>${e(r.title)}</b>` +
    `<span>${e(r.project)} · ${e(r.kind)} · ${ago(Date.now() - r.mt)} · ${Math.round(r.size / 1024)} KB</span></a></li>`).join('')}</ul>`
    : '<p>No Archify diagrams yet. Ask any session to "explain" or "diagram" something; the reply links the page here.</p>';
  send(req, res, 200, `<!doctype html><html lang="en"><head><meta charset="utf-8">
${DOC_META}
<link rel="stylesheet" href="${asset('tokens', 'css')}"><link rel="stylesheet" href="${asset('md', 'css')}">
<style>.mdv .dgl{list-style:none;padding:0;margin:0}.mdv .dgl li{margin:0;border-bottom:1px solid var(--bd2)}.dgl a{display:block;padding:12px 2px;text-decoration:none}
.dgl b{display:block;color:var(--title);font-size:15px}.dgl span{color:var(--dim);font:12px var(--mono)}</style>
<title>Diagrams</title></head><body>${hdr}${termFab}<main class="mdv"><h1>Diagrams</h1>${list}</main>
${tabs}${footerHtml()}</body></html>`);
}
