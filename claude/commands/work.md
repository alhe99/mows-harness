---
description: Work in a project directory over remote control — the absolute-path substitute for /cd (which doesn't work on mobile)
argument-hint: <project path under Projects, e.g. acme/backend-api>
---

The user wants to work in this project: "$ARGUMENTS"

`/cd` does not work over remote control and the session root cannot move. Instead, ADOPT this directory as your working context for the rest of the session, using absolute paths. Do NOT run a bare `cd` to "switch" and do NOT claim the working directory changed.

(If the user would be better served by a session actually ROOTED in that directory — project CLAUDE.md, rules, git status all native — mention once that `/open $ARGUMENTS` starts a fresh session there, then continue with the steps below.)

Steps:
1. Resolve "$ARGUMENTS" to an absolute path under `{{PROJECTS_ROOT}}/`. If it's already absolute, use it as-is; otherwise prepend the Projects root. Call this TARGET.
2. Confirm TARGET exists. If it has a `CLAUDE.md` (and/or `.claude/rules/*.md`), read it to load that project's context, and briefly summarize the project — stack and how to build/run — from what you find.
3. For the rest of this session, treat TARGET as the working directory:
   - use absolute paths under TARGET for all Read / Edit / Glob / Grep,
   - run shell commands as `cd <TARGET> && <cmd>` inside a single Bash call (a bare `cd` does not persist across calls, so always chain it).
4. Reply with one clear line: `Working in <TARGET> — session root is unchanged; using absolute paths.` then ask what they'd like to do, or proceed if they already said.

If TARGET does not exist, say so and list the sibling directories so the user can fix the path. Keep output tight.
