// /md?f=<abs path>: the file checks and the download. The renderer and the page chrome are legacy.mjs's. --ui=legacy answers with legacy.mjs's own
// document (inline styles, mermaid@12 floating, no script policy); --ui=next with the /md document of ARCHITECTURE section 5: the same body on the
// built tokens.css + md.css, and the CSP of K-10 (BASE_CSP + one script source: the pinned CDN and the hash of the loader below).
import { createHash } from 'node:crypto';
import { promises as fsp } from 'node:fs';
import path from 'node:path';
import { BASE_CSP, send } from '../core.mjs';
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

const MD_ROOT = '/home';
export async function mdView(req, res, url, next = false) {
  const f = url.searchParams.get('f') || '';
  const oops = (code, m) => send(req, res, code, mdNotice(m));
  if (!f.startsWith('/')) return oops(400, 'usage: /md?f=/home/<user>/path/to/file.md');
  if (!/\.(md|markdown|txt)$/i.test(f)) return oops(400, 'only .md, .markdown and .txt files can be previewed.');
  let real, st;
  try { real = await fsp.realpath(f); st = await fsp.stat(real); } catch { return oops(404, `not found: ${f}`); }
  if (!real.startsWith(MD_ROOT + '/')) return oops(403, 'only files under /home are viewable.');
  if (!st.isFile() || st.size > 2 * 1024 * 1024) return oops(403, 'not a regular file under 2 MB.');
  const src = await fsp.readFile(real, 'utf8');
  // ?dl=1 -> the raw file as a download (phones can't reach the VPS disk any other way)
  if (url.searchParams.get('dl')) {
    res.writeHead(200, { 'Content-Type': 'text/markdown; charset=utf-8', 'Cache-Control': 'no-store',
      'Content-Disposition': `attachment; filename*=UTF-8''${encodeURIComponent(path.basename(real))}` });
    return res.end(src);
  }
  if (next) return send(req, res, 200, mdNextDocument(real, st, src, req.headers.host || ''), 'text/html; charset=utf-8', { 'content-security-policy': MD_CSP });
  send(req, res, 200, mdDocument(real, st, src, req.headers.host));
}
