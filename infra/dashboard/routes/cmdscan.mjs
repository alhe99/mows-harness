// cmdscan.mjs — the slash-command discovery of the "/" menu (routes/commands.mjs), in a module of its own so it runs as the tmux user, not
// as root: commands.mjs starts it as a child process under runuser (core.mjs userCmd), so it can read only what that user can, and no link
// or race in a skills folder can make root read elsewhere (security review 2026-10-24). It imports nothing but node: builtins.
//   node cmdscan.mjs --scan <account home> <pane dir> <root>     prints the found commands as JSON: [[name, hint, description, kind], ...]
// Read the way Claude reads them: <home>/skills/*/SKILL.md, <home>/commands/**/*.md, .claude/ in the pane's directory and its parents up to
// the root, and the account's enabled plugins (plugin:name); names, argument hints and descriptions only, from the frontmatter; a skill
// marked user-invocable: false is left out. Defence in depth on top of the user's own permissions: every path is resolved (links followed,
// .. folded) and used only under <root>; only regular files are opened (no FIFO to hang on); a scan stops at a 3 s deadline. All of that
// state is per scan (one context object), not module-wide.
import { constants, promises as fsp } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const NAME = /^[a-z0-9][\w.:-]{0,80}$/i;
/** the YAML frontmatter's flat keys (a folded or literal block value is joined into one line) */
export function front(text) {
  const m = /^---\r?\n([\s\S]*?)\r?\n---/.exec(text);
  const out = {};
  if (!m) return out;
  const lines = m[1].split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const kv = /^([A-Za-z][\w-]*):\s*(.*)$/.exec(lines[i]);
    if (!kv) continue;
    let v = kv[2].trim();
    if (/^[>|][-+]?$/.test(v)) { const more = []; while (i + 1 < lines.length && /^\s+\S/.test(lines[i + 1])) more.push(lines[++i].trim()); v = more.join(' '); }
    out[kv[1]] = v.replace(/^(["'])(.*)\1$/, '$2');
  }
  return out;
}
const short = s => { const d = String(s || '').replace(/\s+/g, ' ').trim(); return d.length > 110 ? d.slice(0, 108).replace(/\s+\S*$/, '') + '…' : d; };

/** the commands found for one account home and pane directory, reading only under `root` */
export async function discover(home, cwd, root) {
  const c = { root: path.resolve(root), deadline: Date.now() + 3000 };
  const inside = p => p === c.root || p.startsWith(c.root + '/');
  const late = () => Date.now() > c.deadline;
  /** the real path (links followed, .. folded), or null when it does not exist or lies outside the root */
  const real = async p => { try { const r = await fsp.realpath(path.resolve(p)); return inside(r) ? r : null; } catch { return null; } };
  /** the first `max` bytes of a regular file under the root (4 KB: a frontmatter) */
  const head = async (f, max = 4096) => {
    const r = await real(f);
    if (!r || late()) return '';
    let h;
    try {
      h = await fsp.open(r, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
      if (!(await h.stat()).isFile()) return ''; // checked on the open descriptor, not the path
      const b = Buffer.alloc(max), { bytesRead } = await h.read(b, 0, max, 0);
      return b.subarray(0, bytesRead).toString('utf8');
    } catch { return ''; } finally { await h?.close().catch(() => {}); }
  };
  /** a directory's entries under the root, each with its real path and kind (skills are often linked in from elsewhere) */
  const list = async d => {
    const r = await real(d);
    if (!r || late()) return [];
    let names = [];
    try { names = await fsp.readdir(r); } catch { return []; }
    const out = [];
    for (const n of names.slice(0, 400)) {
      const p = await real(path.join(r, n));
      if (!p) continue;
      const st = await fsp.stat(p).catch(() => null);
      if (st) out.push({ n, p, dir: st.isDirectory(), file: st.isFile() });
    }
    return out;
  };
  const found = [];
  /** skills/<name>/SKILL.md and commands/**\/*.md under one .claude-like directory; `pre` names a plugin's */
  const scan = async (dir, kind, pre) => {
    for (const e of (await list(path.join(dir, 'skills'))).filter(x => x.dir)) {
      const fm = front(await head(path.join(e.p, 'SKILL.md')));
      if (!fm.name && !fm.description) continue;
      if (String(fm['user-invocable']) === 'false') continue;
      const n = pre + (fm.name || e.n);
      if (NAME.test(n)) found.push([n, fm['argument-hint'] || '', short(fm.description), kind]);
    }
    const walk = async (d, ns, depth) => {
      for (const e of await list(d)) {
        if (found.length > 600 || late()) return;
        if (e.dir && depth < 3) await walk(e.p, ns + e.n + ':', depth + 1);
        else if (e.file && e.n.endsWith('.md')) {
          const fm = front(await head(e.p));
          const n = pre + ns + e.n.slice(0, -3);
          if (NAME.test(n)) found.push([n, fm['argument-hint'] || '', short(fm.description), kind]);
        }
      }
    };
    await walk(path.join(dir, 'commands'), '', 0);
  };
  await scan(home, 'skill', '');
  // the project: .claude/ in the pane's directory and its parents, up to the root
  const cw = path.resolve(cwd);
  if (inside(cw)) for (let d = cw; inside(d); d = path.dirname(d)) {
    if (path.join(d, '.claude') !== path.resolve(home)) await scan(path.join(d, '.claude'), 'project', '');
    if (d === c.root) break;
  }
  // the account's enabled plugins
  let inst = {}, enabled = {};
  try { inst = JSON.parse(await head(path.join(home, 'plugins', 'installed_plugins.json'), 1 << 20) || '{}'); } catch {}
  try { enabled = JSON.parse(await head(path.join(home, 'settings.json'), 1 << 20) || '{}').enabledPlugins || {}; } catch {}
  for (const [id, v] of Object.entries(inst.plugins || inst)) {
    if (enabled[id] === false || late()) continue;
    for (const p of [].concat(v)) {
      if (!p || typeof p.installPath !== 'string') continue;
      const ip = await real(p.installPath); // resolved: no .. or link can lead the scan out of the root
      if (!ip) continue;
      if (p.scope === 'project' && typeof p.projectPath === 'string' && !(cw + '/').startsWith(path.resolve(p.projectPath) + '/')) continue;
      await scan(ip, 'plugin', id.split('@')[0] + ':');
      break;
    }
  }
  return found;
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href && process.argv[2] === '--scan') {
  const [home, cwd, root] = process.argv.slice(3);
  discover(home, cwd, root).then(f => process.stdout.write(JSON.stringify(f)), () => process.stdout.write('[]'));
}
