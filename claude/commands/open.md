---
description: Start a FRESH session in any project directory from your phone — spawns a per-project remote-control listener (the fix for new sessions being stuck at the base path)
argument-hint: <project name or path> | list | close <project>
---

You are handling `/open`. The user's argument string (may be empty) is: "$ARGUMENTS"

Remote-control sessions are born in their listener's fixed directory — there is no native way to pick a directory from the app. `claude-rc open` fixes this: it spawns a per-project listener, which appears as its own entry in the app's session picker; a NEW session started on it begins fresh in that directory (project CLAUDE.md, rules and skills all load correctly).

**If "$ARGUMENTS" is EMPTY** — run `ls -d {{PROJECTS_ROOT}}/*/ 2>/dev/null | head -20`, then print the directory basenames as a tappable list, one per line, formatted as `` `/open <name>` ``, followed by:

- `/open list` — show running listeners
- `/open close <project>` — stop one
- Nested paths work too: `/open acme/backend-api`

Then STOP.

**If "$ARGUMENTS" is `list`** — run `claude-rc listeners` and report its output verbatim.

**If "$ARGUMENTS" starts with `close`** — run `claude-rc close <rest of arguments>` and report its output verbatim.

**Otherwise** — resolve the argument to a directory:
1. If it is an absolute path or contains a `/`, use it as-is (relative resolves under `{{PROJECTS_ROOT}}/`).
2. Otherwise search: `find {{PROJECTS_ROOT}} -maxdepth 3 -type d -iname "*$ARGUMENTS*" -not -path '*/node_modules/*' -not -path '*/.git/*' 2>/dev/null | head -10`
   - Exactly one match → use it.
   - Multiple matches → print them as a tappable list of `` `/open <path relative to Projects>` `` lines and STOP.
   - No match → say so and suggest `/open` with no arguments to browse.

With the resolved directory, run ONLY:

    claude-rc open '<resolved-path>'

and report its output verbatim — it contains the exact phone instructions (refresh session list, pick the new listener). Do not run anything else.
