---
name: spec-detector
description: Use whenever the user asks to implement a spec, run the plan, build the tasks, work through tasks.md, or mentions spec.md / plan.md / tasks.md / SPEC.md. Detects which spec artifacts exist in the repo and routes the conversation to @spec-orchestrator. Make sure to use this skill whenever spec/plan/tasks files come up, even if the user phrases the request casually (e.g., "let's build out the next batch of work" with a tasks.md present).
allowed-tools: Read, Glob, Bash
---

# Spec Detector

This skill is the "front door" for a spec-driven workflow. It detects which spec artifacts are present and hands the conversation off to the `@spec-orchestrator` sub-agent.

**This skill does NOT delegate to specialists directly.** Skills cannot fan out — only the main conversation (or a slash command) can call `Task` / `Agent` to spawn sub-agents. The skill's job is to detect and route; the orchestrator's job is to plan; the main conversation's job is to dispatch.

## Detect spec artifacts

!`ls spec.md plan.md tasks.md SPEC.md 2>/dev/null; find specs docs/specs -maxdepth 3 -name "*.md" 2>/dev/null | head -20`

## Instructions

Based on what was detected above:

**If one or more of `spec.md`, `plan.md`, `tasks.md`, `SPEC.md` exist (at repo root or under `specs/**`):**

1. Summarize what was found — file paths, what each file appears to contain (read the first ~30 lines of each).
2. Confirm with the user: "I see [files]. Do you want me to hand off to `@spec-orchestrator` to plan the implementation dispatch?"
3. On confirmation, invoke `@spec-orchestrator` with the artifact paths. Do NOT begin implementation yourself.

**If no spec artifacts exist:**

1. Ask the user what they want:
   - "Generate a spec first" → recommend invoking `@spec-analyst` to produce `requirements.md` from the user's intent.
   - "Just implement, no spec needed" → recommend skipping the orchestrator and using plan mode + direct implementation. For small features, this is often faster than orchestration.
2. Don't force the orchestrator on the user when the spec doesn't justify it.

**If multiple specs exist (e.g., `spec.md` AND `specs/auth-v2/spec.md`):**

1. Prefer the most recent by `mtime`.
2. If ambiguous, ask the user which one to target.

## What NOT to do

- Don't start implementing. You're the router, not the worker.
- Don't try to spawn sub-agents from the skill body. The instruction to invoke `@spec-orchestrator` will be carried out by the main conversation when this skill's body lands in context.
- Don't paraphrase the spec files. Read enough to confirm they exist and have content, then hand off.
