---
name: handoff
description: "Write a context-handoff brief (HANDOFF.md) into a target project directory so a NEW Claude Code session started there resumes with full context of the current work. Use when the user wants to move/switch/jump to another project or repo and continue where this session left off, or says things like 'move this session to <project>', 'continue this in <dir>', 'hand off to a new session there'."
trigger: /handoff
---

# /handoff — Session Context Handoff

A running Claude Code session's working directory is fixed at launch and cannot be relocated in place. This skill bridges that gap: it captures everything the *current* session knows about the active work and writes it as a `HANDOFF.md` into the **target** project, so a freshly launched session there picks up seamlessly.

## Usage

```
/handoff <target-path>            # write HANDOFF.md into target project, print launch command
/handoff <target-path> --open     # also print the exact `cd … && claude` command to start the new session
```

If no `<target-path>` is given, ask the user which project to hand off to.

## What this skill does NOT do

- It does **not** start an interactive session in the target dir. A skill runs inside the current session via tools; any `claude` it launches is detached from the user's TTY and unusable interactively. Launching the new session is always a shell action the **user** runs. This skill only prepares the handoff and prints the command.

## Steps

1. **Resolve the target path.** Expand `~`, make it absolute, and verify the directory exists (`ls -d <path>`). If it doesn't exist, stop and tell the user. If it's a multi-repo workspace, note the sub-projects.

2. **Read the target's own context** so the handoff is grounded: read its `CLAUDE.md` (and sub-project `CLAUDE.md`s if it's a workspace), and capture git state: `git -C <path> status -sb` and current branch.

3. **Gather the current session's context.** Summarize, honestly and specifically:
   - **Goal** — what the user is trying to accomplish (the through-line of this session).
   - **Work done** — concrete changes made this session: files created/edited (with paths), commands run, decisions reached. Do not invent; if little was done, say so.
   - **Current state** — what's working, what's broken, anything mid-flight or uncommitted.
   - **Next steps** — the concrete actions the new session should take first.
   - **Key facts & gotchas** — non-obvious constraints, credentials/feeds, env quirks, things already tried that failed.
   - **Open questions** — anything awaiting a user decision.

4. **Write `HANDOFF.md` into the target directory** using the template below. Use absolute paths. Stamp it with the current date from session context (do not call `date` if a current date is already known). If a `HANDOFF.md` already exists there, read it first and either supersede it (note the prior one) or append a new dated section — ask the user if unsure.

5. **Print the launch command** for the user to run in their terminal:
   ```bash
   cd <target-path> && claude
   ```
   Tell them: the first thing to do in the new session is `Read HANDOFF.md` (or just say "read the handoff"). Optionally suggest deleting `HANDOFF.md` once the new session has absorbed it.

## HANDOFF.md template

```markdown
# Session Handoff — <YYYY-MM-DD>

> Prepared by a Claude Code session running in `<source-cwd>`, handing off to work in `<target-path>`.
> **First action for the new session: read this file, confirm the plan, then delete it.**

## Goal
<one-paragraph through-line of what the user is trying to do>

## Target project
<path> — <one-line description>. Branch: `<branch>`. Git state: <clean | summary of dirty files>.

## Work done this session
- <file/command/decision, with absolute paths>

## Current state
<what works, what's broken, what's uncommitted/mid-flight>

## Next steps
1. <concrete first action>
2. ...

## Key facts & gotchas
- <non-obvious constraints, feeds, env quirks, dead ends already hit>

## Open questions
- <anything awaiting the user's decision>
```

## Notes

- Keep the handoff faithful: report what actually happened, including failures and skipped steps. A handoff that overstates progress is worse than none.
- Respect environment constraints noted in the project's CLAUDE.md (e.g. RAM/concurrency limits) — surface them in "Key facts" so the new session inherits them.
