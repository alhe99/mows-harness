---
description: Implement a spec-driven workflow by dispatching tasks to specialist sub-agents
allowed-tools: Read, Glob, Bash, Task
argument-hint: [optional spec file path]
---

# /implement-spec

You are running the `/implement-spec` command. The user wants to execute a spec-driven workflow against the current project.

## Step 1 — Detect spec artifacts

If `$ARGUMENTS` is provided, treat it as the spec file path.

Otherwise, auto-discover:
```bash
ls spec.md plan.md tasks.md SPEC.md 2>/dev/null
find specs docs/specs -maxdepth 3 -name "*.md" 2>/dev/null | head -20
```

## Step 2 — Hand off to the orchestrator

Invoke `@spec-orchestrator` with the spec file paths as input. The orchestrator will return a structured dispatch plan.

## Step 3 — Execute the dispatch plan

The orchestrator returns a plan. You (the main conversation) are responsible for the actual dispatch via `Task`. For each phase:

1. Read the phase's specialist assignments.
2. For each specialist invocation, call `Task` (or `Agent`) with:
   - The specialist's name
   - The exact tasks from `tasks.md` they own
   - File paths to read (`tasks.md`, `architecture.md`, etc.)
   - File path to append to (`IMPL_REPORT.md`)
3. After the phase completes, invoke `@validator` with the phase identifier and target threshold.
4. If the validator passes, advance to the next phase. If it fails, re-dispatch with the validator's recommendations.

## Step 4 — Report

When all phases complete, summarize:
- Tasks completed
- Files changed (read `IMPL_REPORT.md`)
- Validator scores per phase
- Any deferred work or human-review items

## Constraints

- **Do not implement any tasks yourself.** Even if a task is trivial, dispatch it to a specialist so the audit trail is consistent.
- **Verify every dispatch.** After each specialist returns, confirm the expected files were actually written before moving on.
- **Trust the orchestrator's plan but verify the validator.** If the validator says PASS, sanity-check at least the file paths it claims to have verified.
