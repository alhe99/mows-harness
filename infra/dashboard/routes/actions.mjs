import { promises as fsp, statfsSync } from 'node:fs';
import { ACCTS, BY_ID, NAME_RE, RT, THEME_MAP, WEBTERM_SH, descendants, forgetSession, index, liveSid8, readBody, resetDiskCaches, runAs, runAsCode, sameOrigin, saveSettings, sh, tmuxCache, tmuxLive, userCmd } from '../core.mjs';


// The shell sends its two result-bearing forms (restart all, reclaim) with Accept: application/json and gets the result as JSON; a browser
// submitting the form as a form still gets the 303 and the result in the query of the page it lands on.
const wantsJson = req => (req.headers.accept || '').includes('application/json');
const replyJson = (res, o) => { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify(o)); };
export async function action(req, res, url) {
  // same-origin guard (oauth2 cookie is SameSite anyway; belt + suspenders — exact host match, substring checks are bypassable)
  const host = req.headers.host || '';
  if (!sameOrigin(req, host)) { res.writeHead(403); return res.end('bad origin'); }
  const b = await readBody(req);
  const name = b.name || '';
  const bk = b.back || '/'; // local paths only — "//host" is a protocol-relative redirect
  const back = bk.startsWith('/') && !bk.startsWith('//') ? bk : '/';
  if (!NAME_RE.test(name)) { res.writeHead(400); return res.end('bad name'); }
  tmuxCache.t = 0;
  const t = (await tmuxLive()).find(x => x.name === name);
  if (!t) { res.writeHead(404); return res.end('not live'); }
  const act = url.pathname.slice(3);
  if (act === 'kill') {
    await sh(...userCmd(['tmux', 'kill-session', '-t', '=' + name]));
  } else if (act === 'pause' || act === 'resume') {
    const sig = act === 'pause' ? '-STOP' : '-CONT';
    const kids = await descendants(t.pid);
    if (kids.length) await sh('kill', [sig, '--', ...kids.map(String)]);
  } else if (act === 'label') { // name a live session (empty = clear); tmux titles show it in browser tabs
    const label = (b.label || '').replace(/[\x00-\x1f\x7f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 60);
    // through ccname, not tmux directly: it also writes ~/.local/state/cc-labels/<name>, which is
    // what brings the label back after the tmux server dies (2026-08-25: twice in one night)
    await runAs([], 'ccname', ['-t', name, ...(label ? [label] : [])], 10000);
  } else { res.writeHead(404); return res.end(); }
  tmuxCache.t = 0;
  res.writeHead(303, { location: back }); res.end();
}


// ---------- /a/restartall: respawn every live pane in one press ----------
// The chore this kills: Claude Code prints "Update installed · Restart to update" and every
// live session has to be bounced by hand. Same move as the terminal's ⟳ key (70-ccrst) but
// server-side and for all of them — tmux re-runs each pane's ORIGINAL command.
//
// Plain respawn is only 1:1 for web-* panes, whose command already carries their session id.
// Bare cc/ccw panes were started with no -c/-r, so respawning them verbatim opens a FRESH
// chat — so those get `--resume <sid>` appended, pinned to their own transcript: freshest in
// the pane's cwd, same account, started since the pane did, and not a sid another pane owns
// (that last filter is what stops two panes landing on one conversation and interleaving it).
// ponytail: active pane per session only, exactly like ⟳; extra windows are left alone.
export async function restartAll(req, res) {
  const host = req.headers.host || '';
  if (!sameOrigin(req, host)) { res.writeHead(403); return res.end('bad origin'); }
  const b = await readBody(req);
  const bk = b.back || '/';
  const back = bk.startsWith('/') && !bk.startsWith('//') ? bk : '/';
  tmuxCache.t = 0;
  const live = await tmuxLive();
  const claimed = new Set(live.map(l => l.sid).filter(Boolean));
  // Pane id (%NN), not '=name': tmux resolves '=' for SESSION targets (kill-session above),
  // but respawn-pane wants a pane and answers "can't find pane: =<name>" for it.
  // #{pane_start_command} arrives wrapped in double quotes with inner ones backslash-escaped.
  // ponytail: string append, not an argv rebuild — the wrapper paths have no spaces in them.
  const panes = new Map();
  const raw = await sh(...userCmd(['tmux', 'list-panes', '-a', '-F', '#{session_name}\t#{pane_id}\t#{pane_start_command}']));
  for (const line of raw.trim().split('\n').filter(Boolean)) {
    const [name, id, ...rest] = line.split('\t');
    if (name && id && !panes.has(name)) panes.set(name, { id, cmd: rest.join('\t').replace(/^"|"$/g, '').replace(/\\(.)/g, '$1').trim() });
  }
  let n = 0;
  for (const l of live) {
    // a SIGSTOPped pane is continued first: SIGKILL would land either way, but its stopped
    // children would linger holding the cwd and the MCP sockets the fresh claude wants.
    if (l.paused) { const k = await descendants(l.pid); if (k.length) await sh('kill', ['-CONT', '--', ...k.map(String)]); }
    const pane = panes.get(l.name);
    if (!pane) continue; // vanished between the two tmux calls
    const cmd = pane.cmd;
    let arg = [];
    if (!l.sid && cmd && !/--resume|--continue|(?:^|\s)-[cr](?:\s|$)/.test(cmd)) {
      const cfg = (/CLAUDE_CONFIG_DIR=(\S+)/.exec(cmd) || [])[1];
      const acct = ACCTS.find(a => a.home === cfg);
      const proj = (l.cwd || '').replace(/[/.]/g, '-');
      const e = l.fsid ? { sid: l.fsid } : acct && index.filter(x => x.a === acct.id && x.proj === proj && x.mt >= l.created && !claimed.has(x.sid))
        .reduce((a, x) => (!a || x.mt > a.mt ? x : a), null);
      if (e) { claimed.add(e.sid); arg = [cmd + ' --resume ' + e.sid]; }
    }
    await sh(...userCmd(['tmux', 'respawn-pane', '-k', '-t', pane.id, ...arg]));
    n++;
  }
  tmuxCache.t = 0;
  if (wantsJson(req)) return replyJson(res, { rs: n });
  const u = new URL(back, 'http://x'); u.searchParams.set('rs', String(n)); // set, not append: re-presses don't stack rs=
  res.writeHead(303, { location: u.pathname + u.search }); res.end();
}


// ---------- delete one session transcript (list-row ✕, confirmed via <details>) ----------
export async function delSession(req, res) {
  const host = req.headers.host || '';
  if (!sameOrigin(req, host)) { res.writeHead(403); return res.end('bad origin'); }
  const b = await readBody(req);
  const bk = b.back || '/';
  const back = bk.startsWith('/') && !bk.startsWith('//') ? bk : '/';
  const a = b.a || '', sid = b.sid || '';
  if (!BY_ID[a] || !/^[0-9a-f-]{8,64}$/.test(sid)) { res.writeHead(400); return res.end('bad id'); }
  const e = index.find(x => x.a === a && x.sid === sid);
  if (!e) { res.writeHead(404); return res.end('not found'); }
  if ((await tmuxLive()).some(l => liveSid8(l) === sid.slice(0, 8))) {
    res.writeHead(409); return res.end('session is live — kill it first');
  }
  try { await fsp.unlink(e.path); } catch {}
  forgetSession(e);
  res.writeHead(303, { location: back }); res.end();
}


// ---------- /a/switch: tmux switch-client for the shell's single terminal iframe (§2) ----------
export async function switchAction(req, res) {
  const host = req.headers.host || '';
  if (!sameOrigin(req, host)) { res.writeHead(403); return res.end('bad origin'); }
  const b = await readBody(req);
  const tab = b.tab || '', to = b.to || '';
  const j = o => { res.writeHead(res.statusCode, { 'content-type': 'application/json' }); res.end(JSON.stringify(o)); };
  if (!/^[0-9a-f]{8}$/.test(tab)) { res.statusCode = 400; return j({ err: 'bad tab' }); }
  const live = await tmuxLive();
  if (!(live.some(l => l.name === to) || /^[0-9a-f]{8}$/.test(to))) { res.statusCode = 400; return j({ err: 'bad to' }); }
  const code = await runAsCode([], WEBTERM_SH, ['switch', tab, to], 20000);
  if (code === 0) { res.statusCode = 200; return j({ ok: true, current: to }); }
  if (code === 2) { res.statusCode = 409; return j({ err: 'tab not attached' }); }
  if (code === 3) { res.statusCode = 404; return j({ err: 'unknown session' }); }
  res.statusCode = 500; return j({ err: 'switch failed' });
}

// GET /a/tab?tab=<tabid> -> { session }: the tmux session that tab's ttyd client is attached to ('' while it sits in the picker). The grid's
// picker pane (web/views/grid.mjs) polls it to learn which session the picker ended up in, whichever way it got there (attach, resume, new).
export async function tabAction(req, res, url) {
  const tab = url.searchParams.get('tab') || '';
  const j = o => { res.writeHead(res.statusCode, { 'content-type': 'application/json', 'cache-control': 'no-store' }); res.end(JSON.stringify(o)); };
  if (!/^[0-9a-f]{8}$/.test(tab)) { res.statusCode = 400; return j({ err: 'bad tab' }); }
  const out = (await runAs([], WEBTERM_SH, ['tabsess', tab], 5000)).trim();
  return j({ session: NAME_RE.test(out) ? out : '' });
}

// ---------- /settings: global terminal theme configuration + live preview ----------
export async function termThemeAction(req, res) {
  const host = req.headers.host || '';
  if (!sameOrigin(req, host)) { res.writeHead(403); return res.end('bad origin'); }
  const chunks = [];
  let n = 0;
  for await (const c of req) {
    n += c.length;
    if (n > 4096) { res.writeHead(400); return res.end('too large'); }
    chunks.push(c);
  }
  let body;
  try { body = JSON.parse(Buffer.concat(chunks).toString('utf8')); }
  catch { res.writeHead(400); return res.end('invalid json'); }
  if (!body || typeof body.name !== 'string') { res.writeHead(400); return res.end('invalid body'); }
  const name = body.name;
  if (name !== '' && !Object.prototype.hasOwnProperty.call(THEME_MAP, name)) {
    res.writeHead(400); return res.end('unknown theme');
  }
  await saveSettings({ termTheme: name });
  res.writeHead(200, { 'content-type': 'application/json' });
  return res.end(JSON.stringify({ ok: true, name }));
}

export async function reclaimAction(req, res) {
  const host = req.headers.host || '';
  if (!sameOrigin(req, host)) { res.writeHead(403); return res.end('bad origin'); }
  let raw = '', n = 0;
  for await (const c of req) { n += c.length; if (n > 4096) { res.writeHead(413); return res.end('too large'); } raw += c; }
  const f = new URLSearchParams(raw);
  const ids = new Set(f.getAll('t'));
  const sel = RT.filter(t => ids.has(t.id));
  const b4 = statfsSync('/');
  for (const t of sel) { try { await t.run(); } catch { /* one dead target must not abort the rest */ } }
  const af = statfsSync('/');
  // back holds a full path+query now (fleet redesign: the panel lives on both '/' and
  // /history) — not a bare querystring like before. Same "/" guard as every other
  // POST action's back field: reject a protocol-relative "//host" redirect.
  const rawBack = f.get('back') || '/';
  const backPath = rawBack.startsWith('/') && !rawBack.startsWith('//') ? rawBack : '/';
  const u = new URL(backPath, 'http://x');
  const freed = Math.max(0, (af.bavail - b4.bavail) * af.bsize);
  resetDiskCaches(); // the disk meter must show the new number on the bounce
  if (wantsJson(req)) return replyJson(res, { freed, n: sel.length });
  u.searchParams.set('sys', '1');
  u.searchParams.set('freed', String(freed));
  u.searchParams.set('rn', String(sel.length));
  res.writeHead(303, { location: u.pathname + u.search }); res.end();
}

// The stored name of an upload. ccimg-v2 sends the real filename (URL-encoded) in x-name so a .md/.pdf keeps its name and extension;
// reduced to [A-Za-z0-9._-], no leading dot: nothing from the client can steer the path out of the shots dir. With no name the extension
// comes from the content type and is never guessed: the old "anything else is .jpg" fallback stored every nameless .md/.docx as .jpg
// (2026-09-17..10-11, while the deployed server had lost its x-name handler) and claude then read text as a broken image.
const SHOT_EXT = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/webp': 'webp', 'image/gif': 'gif', 'image/heic': 'heic', 'application/pdf': 'pdf',
  'text/markdown': 'md', 'text/plain': 'txt', 'text/csv': 'csv', 'text/html': 'html', 'application/json': 'json' };
export function shotName(ct, xname, ms) {
  let xn = ''; try { xn = decodeURIComponent(xname || ''); } catch {}
  xn = xn.replace(/[^A-Za-z0-9._-]/g, '_').replace(/^\.+/, '').slice(-80);
  return `shot-${ms}${xn ? '-' + xn : '.' + (SHOT_EXT[String(ct || '').split(';')[0].trim().toLowerCase()] || 'bin')}`;
}

// POST /shot: image and file uploads from the terminal's camera key, stored so claude can look at them; answers { ok, path }.
export async function shotUpload(req, res) {
  const chunks = []; let n = 0;
  for await (const c of req) { n += c.length; if (n > 15e6) { res.writeHead(413); return res.end('too big'); } chunks.push(c); }
  const dir = '/opt/claude-dashboard/shots';
  await fsp.mkdir(dir, { recursive: true });
  // retention: uploads are transient "look at this" attachments — prune >7d on
  // each upload (rare enough that a cron would be more machinery for the same result)
  try { for (const f of await fsp.readdir(dir)) {
    if (Date.now() - (await fsp.stat(`${dir}/${f}`)).mtimeMs > 7 * 864e5) await fsp.unlink(`${dir}/${f}`);
  } } catch {}
  const path = `${dir}/${shotName(req.headers['content-type'], req.headers['x-name'], Date.now())}`;
  await fsp.writeFile(path, Buffer.concat(chunks));
  // path goes back to the caller: the terminal's 📸 key pastes it into the prompt
  res.writeHead(200, { 'content-type': 'application/json' }); return res.end(JSON.stringify({ ok: true, path }));
}
