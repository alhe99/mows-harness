---
name: sync-to-vps
description: Full-copy a local project from this machine to a remote VPS at the same home-relative path — project files, Claude Code history (transcripts with cwd rewritten for the VPS), session todos, plus an additive push of ~/.claude skills/commands/agents. Use when the user asks to sync/copy/move a project to a VPS, to a VM, or to a remote server, or wants to continue a local-only project (and its Claude sessions) on the remote host.
---

# sync-to-vps

Run the script. It's deterministic — don't re-derive the steps by hand.

```bash
~/.claude/skills/sync-to-vps/sync.py [project_dir]   # default: cwd
```

Flags: `--mirror` (rsync --delete — true mirror, clobbers VPS-side edits),
`--no-skills`, `--dry-run`, `--selftest`. Host override: `VPS_HOST=<alias>`
(default `vps`).

## What one run does

1. **Project files** → `$VPS_HOST:<remote-home>/<same relative path>` via rsync.
   Excluded: `.DS_Store node_modules .venv venv __pycache__ .next .turbo
   .pytest_cache .codegraph`.
2. **Claude history** → the project's `~/.claude/projects/<encoded>/` transcripts,
   staged with the remote encoding and every per-line `cwd` rewritten to the VPS
   path, then rsynced. Session todo files (`~/.claude/todos/<session-id>*`) ride
   along.
3. **`~/.claude/{skills,commands,agents}`** pushed additively (local machine wins
   on same-named files; VPS-only files are kept).
4. **Verify** — file count + byte totals compared local vs remote with the same
   exclude set. Prints the exact `ssh -t $VPS_HOST 'cd … && claude --resume <id>'`
   line to continue the latest session on the VPS.

## Exit codes

| Code | Meaning |
|------|---------|
| `0` | Synced and verified |
| `1` | Synced with warnings (e.g. no history dir, one side uncountable) |
| `2` | Failure — nothing should be trusted; read the ✗ line |

## Gotchas encoded — do not "simplify" these out

- **Home prefixes can differ between machines** (e.g. macOS's `/Users` tree vs
  Linux's `/home` tree), so "same path" means *home-relative*, not absolute.
  The script asks the VPS for `$HOME`; the project must live under the local
  home or there is no mapping.
- **The history dir name is not the only thing that encodes the path.** Every
  transcript line carries a top-level `cwd` field. Copying the `.jsonl` files
  without rewriting those leaves resumed sessions on the VPS believing they run
  under the local machine's path. Only the top-level `cwd` is rewritten —
  message *content* mentioning local paths is left untouched on purpose
  (rewriting content corrupts history).
- **Encoding is `/` AND `.` → `-`** (`/home/a/.claude-mem` → <!-- preflight-allow -->
  `-home-a--claude-mem`). Slash-only encoding breaks dotted paths.
- **`.codegraph` is excluded** because the index embeds absolute local paths — run
  `codegraph init` on the VPS instead. Same reason `node_modules`/`.venv` are
  excluded: OS-specific binaries; reinstall on the VPS.
- **No `--delete` by default.** The VPS is also a working machine; a silent
  mirror would destroy VPS-side edits. `--mirror` is opt-in and the verify step
  then requires exact equality.
- **macOS ships openrsync (protocol 29).** If syncing from a Mac, it negotiates
  fine with the VPS's rsync 3.x, but fancy flags (`--info`, `--itemize-changes`)
  are not portable — that's why verification counts files/bytes with python on
  both ends instead of parsing rsync output.
- **Not synced:** the claude-mem database (global sqlite, not per-project — the
  VPS runs its own observer) and the global `~/.claude/CLAUDE.md` (the VPS has
  its own).

## Reporting

Lead with the verdict and the local→remote path mapping. On success give the
one-line resume command the script printed. On exit 2, quote the ✗ line.

