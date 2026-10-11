// /md?f=<abs path>: the file checks and the download. The markup (page chrome, renderer, stylesheet, mermaid loader) is legacy.mjs's.
import { promises as fsp } from 'node:fs';
import path from 'node:path';
import { send } from '../core.mjs';
import { mdDocument, mdNotice } from '../legacy.mjs';

const MD_ROOT = '/home';
export async function mdView(req, res, url) {
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
  send(req, res, 200, mdDocument(real, st, src, req.headers.host));
}
