#!/usr/bin/env python3
"""Full-copy a local project to a remote VPS at the same home-relative path.

Syncs three things:
  1. the project directory itself (rsync, sane excludes)
  2. its Claude Code history: ~/.claude/projects/<encoded>/ transcripts,
     re-encoded for the remote path AND with every per-line "cwd" field
     rewritten so resume on the VPS points at the VPS path, not the local one
  3. session todo files (~/.claude/todos/<session-id>*)
plus an additive push of ~/.claude/{skills,commands,agents}.

Usage: sync.py [project_dir] [--mirror] [--no-skills] [--dry-run] [--selftest]
Host override: VPS_HOST env var (default: vps).
Exit: 0 synced+verified, 1 synced with warnings, 2 failure.
"""
import argparse, json, os, shutil, subprocess, sys, tempfile
from pathlib import Path

# ponytail: .codegraph's index embeds absolute local paths -> re-run `codegraph init` on the VPS.
# node_modules/.venv hold OS-specific binaries -> reinstall on the VPS.
EXCLUDES = ['.DS_Store', 'node_modules', '.venv', 'venv', '__pycache__',
            '.next', '.turbo', '.pytest_cache', '.codegraph']

def ok(m):  print(f'  \033[32m✓\033[0m {m}')
def bad(m): print(f'  \033[31m✗\033[0m {m}')
def die(m): bad(m); sys.exit(2)

def enc(path):
    """Claude Code's projects-dir encoding: '/' and '.' both become '-'."""
    return path.replace('/', '-').replace('.', '-')

def rewrite_line(line, local, remote):
    """Rewrite the top-level cwd field of one transcript line. Returns (line, changed)."""
    try:
        d = json.loads(line)
    except (json.JSONDecodeError, UnicodeDecodeError):
        return line, False
    cwd = d.get('cwd') if isinstance(d, dict) else None
    if isinstance(cwd, str) and (cwd == local or cwd.startswith(local + '/')):
        d['cwd'] = remote + cwd[len(local):]
        return json.dumps(d, ensure_ascii=False, separators=(',', ':')) + '\n', True
    return line, False

def selftest():
    # Fixture paths below (laptop/desk/vps) are illustrative, not real accounts -- marked
    # individually because preflight's generic home-path check is a plain substring match.
    assert enc('/home/laptop/Documents/x') == '-home-laptop-Documents-x'  # preflight-allow
    assert enc('/home/desk/.claude-mem') == '-home-desk--claude-mem'  # preflight-allow
    l, c = rewrite_line('{"cwd":"/home/laptop/p","type":"user"}\n', '/home/laptop/p', '/home/vps/p')  # preflight-allow
    assert c and json.loads(l)['cwd'] == '/home/vps/p'  # preflight-allow
    l, c = rewrite_line('{"cwd":"/home/laptop/p2"}\n', '/home/laptop/p', '/home/vps/p')  # preflight-allow
    assert not c, 'prefix match must not cross path components'
    l, c = rewrite_line('not json\n', '/home/laptop/p', '/home/vps/p')  # preflight-allow
    assert not c and l == 'not json\n'
    print('selftest: OK')

def run(cmd, **kw):
    return subprocess.run(cmd, text=True, capture_output=True, **kw)

def ssh(host, script, **kw):
    return run(['ssh', '-o', 'ConnectTimeout=10', host, script], **kw)

def rsync(src, dst, delete=False, dry=False, excludes=()):
    cmd = ['rsync', '-a']
    if delete: cmd.append('--delete')
    if dry: cmd += ['-n', '-v']
    cmd += [f'--exclude={e}' for e in excludes] + [src, dst]
    return run(cmd)

COUNT_PY = """
import json, os, sys
root, excludes = sys.argv[1], set(json.loads(sys.argv[2]))
n = b = 0
for dp, dns, fns in os.walk(root):
    dns[:] = [d for d in dns if d not in excludes]
    for f in fns:
        if f in excludes: continue
        try: b += os.path.getsize(os.path.join(dp, f)); n += 1
        except OSError: pass
print(n, b)
"""

def count_tree(root, excludes):
    r = run(['python3', '-c', COUNT_PY, str(root), json.dumps(list(excludes))])
    return tuple(map(int, r.stdout.split())) if r.returncode == 0 else None

def count_remote(host, root, excludes):
    q = json.dumps(list(excludes)).replace("'", "'\\''")
    r = ssh(host, f"python3 -c '{COUNT_PY}' '{root}' '{q}'")
    return tuple(map(int, r.stdout.split())) if r.returncode == 0 and r.stdout.strip() else None

def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('project', nargs='?', default='.')
    ap.add_argument('--mirror', action='store_true', help='rsync --delete (true mirror; clobbers VM-side edits)')
    ap.add_argument('--no-skills', action='store_true', help="skip the ~/.claude/{skills,commands,agents} push")
    ap.add_argument('--dry-run', action='store_true')
    ap.add_argument('--selftest', action='store_true')
    a = ap.parse_args()
    if a.selftest: selftest(); return 0

    host = os.environ.get('VPS_HOST', 'vps')
    warn = 0

    local = Path(a.project).resolve()
    home = Path.home()
    if not local.is_dir(): die(f'not a directory: {local}')
    try:
        rel = local.relative_to(home)
    except ValueError:
        die(f'{local} is not under {home} -- no home-relative mapping to the VM')

    r = ssh(host, 'printf %s "$HOME"')
    if r.returncode != 0 or not r.stdout.startswith('/'):
        die(f'cannot reach {host}: {r.stderr.strip() or r.stdout.strip()}')
    rhome = r.stdout.strip()
    rpath = f'{rhome}/{rel}'
    print(f'=== {local}  ->  {host}:{rpath} ===')

    print('--- 1. project files ---')
    ssh(host, f"mkdir -p '{os.path.dirname(rpath)}'")
    r = rsync(f'{local}/', f'{host}:{rpath}/', delete=a.mirror, dry=a.dry_run, excludes=EXCLUDES)
    if r.returncode != 0: die(f'project rsync failed: {r.stderr.strip()}')
    ok(f"project synced{' (dry-run)' if a.dry_run else ''}{' (mirror)' if a.mirror else ''}")

    print('--- 2. claude history ---')
    ldir = home / '.claude' / 'projects' / enc(str(local))
    sessions = []
    if not ldir.is_dir():
        bad(f'no history at {ldir} -- skipped'); warn = 1
    else:
        renc = enc(rpath)
        stage = Path(tempfile.mkdtemp(prefix='vps-sync-'))
        rewrites = 0
        for f in sorted(ldir.iterdir()):
            if f.suffix == '.jsonl' and f.is_file():
                sessions.append(f.stem)
                with open(f, encoding='utf-8') as src, open(stage / f.name, 'w', encoding='utf-8') as dst:
                    for line in src:
                        out, ch = rewrite_line(line, str(local), rpath)
                        rewrites += ch
                        dst.write(out)
                shutil.copystat(f, stage / f.name)
            elif f.is_file():
                shutil.copy2(f, stage / f.name)
        if not a.dry_run:
            ssh(host, f"mkdir -p '{rhome}/.claude/projects/{renc}'")
            r = rsync(f'{stage}/', f'{host}:.claude/projects/{renc}/')
            if r.returncode != 0: die(f'history rsync failed: {r.stderr.strip()}')
        ok(f'{len(sessions)} session(s), {rewrites} cwd fields rewritten -> {renc}')

        todos = [p for s in sessions for p in (home / '.claude' / 'todos').glob(f'{s}*')]
        if todos and not a.dry_run:
            ssh(host, "mkdir -p '.claude/todos'")
            r = run(['rsync', '-a'] + [str(t) for t in todos] + [f'{host}:.claude/todos/'])
            ok(f'{len(todos)} todo file(s)') if r.returncode == 0 else (bad('todos rsync failed'), )
        elif not todos:
            print('      no todo files for these sessions')

    print('--- 3. skills/commands/agents (additive) ---')
    if a.no_skills:
        print('      skipped (--no-skills)')
    else:
        for d in ('skills', 'commands', 'agents'):
            src = home / '.claude' / d
            if not src.is_dir(): continue
            if a.dry_run: print(f'      would push {d}/'); continue
            r = rsync(f'{src}/', f'{host}:.claude/{d}/')
            ok(f'{d}/ pushed') if r.returncode == 0 else (bad(f'{d}/ push failed: {r.stderr.strip()}'),)

    if a.dry_run:
        print('dry-run: nothing verified'); return warn

    print('--- 4. verify ---')
    lc = count_tree(local, EXCLUDES)
    rc = count_remote(host, rpath, EXCLUDES)
    if not lc or not rc:
        bad('could not count one side -- unverified'); warn = 1
    elif a.mirror and lc != rc:
        die(f'mirror mismatch: local {lc[0]} files/{lc[1]}B vs remote {rc[0]}/{rc[1]}B')
    elif rc[0] < lc[0] or rc[1] < lc[1]:
        die(f'remote is missing content: local {lc[0]} files/{lc[1]}B vs remote {rc[0]}/{rc[1]}B')
    else:
        extra = '' if lc == rc else f' (remote has {rc[0]-lc[0]} extra file(s); use --mirror to prune)'
        ok(f'{lc[0]} files / {lc[1]:,} bytes present on remote{extra}')

    if sessions:
        print(f"\n  open on the VM:  ssh -t {host} 'cd {rpath} && claude --resume {sessions[-1]}'")
    return warn

if __name__ == '__main__':
    sys.exit(main())
