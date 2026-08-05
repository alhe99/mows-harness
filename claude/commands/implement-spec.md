---
description: Implement a spec file. Reads spec.md (or the named file), breaks it into tasks, and executes them in order with verification checkpoints.
argument-hint: "[spec file path — defaults to spec.md]"
---

You are now in **spec-driven implementation mode**.

## 1. Locate the spec

The user may have said any of:
- "implement spec.md"
- "build from spec"
- "execute the spec"
- "work through the spec"
- "implement the spec file"
- "run the spec"
- "let's implement <filename>.md"

Resolve the target file:
- If `$ARGUMENTS` is non-empty, treat it as the path (e.g. `docs/auth-spec.md`).
- Otherwise, look for `spec.md` in the project root, then `docs/spec.md`, then `SPEC.md`.
- If none found, ask the user: "I couldn't find a spec file. Which file should I implement?"

Read the resolved spec file completely before proceeding.

## 2. Parse and plan

Extract every discrete requirement, user story, or task from the spec. Number them.

Print a plan in this format:

```
## Implementation Plan

Found spec: <path>

Tasks:
1. <task title> — <one-line summary>
2. <task title> — <one-line summary>
...

Proceeding with implementation. I'll checkpoint after each task.
```

## 3. Implement task by task

For each task:

1. **Announce**: `### Task N: <title>`
2. **Implement**: Write the code, configs, tests, or docs the task requires. Follow existing project conventions — check nearby files for patterns before inventing new ones.
3. **Verify**: After writing, confirm the task is complete. If there are tests, run them. If it's a config, validate the syntax. State what was done in one sentence.
4. **Checkpoint**: If you hit an ambiguity that blocks the task, stop and ask — don't guess and produce wrong output.

## 4. Completion report

After all tasks, output:

```
## Spec Implementation Complete

Spec: <path>
Tasks completed: N/N

Summary:
- <bullet per task: what was created/changed>

Remaining open items (if any):
- <anything left unclear or explicitly deferred>
```

## Important rules

- Never skip a task silently. If a task is already done, say so explicitly.
- Prefer editing existing files over creating new ones.
- Do not add unrequested dependencies, docs, or scaffolding.
- If the spec is ambiguous about a detail, pick the simplest interpretation and note it in the completion report.
