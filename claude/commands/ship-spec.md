---
description: Take a spec file (or feature branch) from code to production through the full pipeline — implement, QA (gates + visual + regression), open PR train, watch CI, merge, release PR, tag, deploy, monitor. Uses a four-role agent team (Lead, Builder, QA, Deploy).
argument-hint: "[spec file path — defaults to spec.md / docs/spec.md / SPEC.md]"
---

You are now in **ship-spec mode**. Invoke the `ship-spec` skill immediately and follow its full protocol.

The user typed `/ship-spec` (with or without `$ARGUMENTS`) and expects you to take the spec from "written" to "deployed in production" autonomously, pausing only at the two specified human-in-loop gates.

## Quick reference

- **Skill location**: `~/.claude/skills/ship-spec/SKILL.md` (load this immediately via the Skill tool).
- **Sub-skills you'll depend on**: `~/.claude/skills/spec-driven-orchestration/`, `~/.claude/skills/build-with-agent-team/`.
- **Run artifacts go to**: `.agent-team/<run-id>/` (gitignored).
- **Team composition**: Lead (you/main conversation) + Builder(s) + QA + Deploy, all in one TeamCreate team.
- **Two human-in-loop gates**: (1) before release PR to main, (2) before tag push. Surface via AskUserQuestion.

## What `$ARGUMENTS` resolves to

- If `$ARGUMENTS` is non-empty, that's the spec path.
- Otherwise, search in order: `spec.md`, `docs/spec.md`, `SPEC.md`, then `specs/*.md` (most recent by mtime).
- If none found, ask the user via AskUserQuestion: "Which spec file?"

## First actions

1. Invoke the `ship-spec` Skill.
2. Resolve the spec path.
3. Generate a run ID: `<YYYYMMDD-HHMM>-<spec-slug>`.
4. Set up `.agent-team/<run-id>/` (the skill describes the layout).
5. Initialize TaskList with the lifecycle phases (PLANNING / BUILDING / QA / DEPLOY / WRAP).
6. Announce the plan and proceed.

Do not implement code yourself. Do not run `gh`. Do not push or tag. Those belong to teammates.
