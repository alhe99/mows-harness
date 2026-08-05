# YAML Frontmatter Cheat Sheet

Every agent, skill, and command on Claude Code has YAML frontmatter that controls activation, tooling, and isolation. The exact fields matter — get them wrong and the file silently fails to load or load in the wrong context.

## Orchestrator sub-agent

```yaml
---
name: spec-orchestrator
description: Use PROACTIVELY when the user mentions implementing spec.md, plan.md, tasks.md, SPEC.md, or asks to "build the feature" or "run the spec". Coordinates planning, development, and validation phases by planning the dispatch routing to specialized spec-* sub-agents. MUST BE USED for any multi-domain feature work.
tools: Read, Glob, Grep, TodoWrite, Bash
model: opus
---
```

**Key fields:**
- `description` should be pushy ("Use PROACTIVELY", "MUST BE USED") because Claude under-triggers sub-agents the same way it under-triggers skills.
- `tools` for an orchestrator should NOT include `Edit` / `Write` — the orchestrator plans, it doesn't write code. Forcing this is the cheapest way to prevent it from drifting into implementation.
- `model: opus` because routing benefits from the smarter model. Specialists can use sonnet.
- Do NOT include `Task` / `Agent` in `tools` — sub-agents can't spawn sub-agents anyway, and including them invites the model to try and fail.

## Specialist sub-agent

```yaml
---
name: backend-specialist
description: Implements backend tasks from tasks.md — API routes, controllers, services, DB migrations. Use when the orchestrator routes tasks tagged [backend] or [api]. Follows team conventions from preloaded skills.
tools: Read, Edit, Write, Bash, Grep, Glob
skills: [api-conventions, error-handling-patterns, testing-conventions]
model: sonnet
---
```

**Key fields:**
- `tools` includes `Edit` / `Write` — specialists do the actual writing.
- `skills:` (list) preloads skills at sub-agent startup, fully expanded into context. Useful for project-specific conventions that should always be applied.
- `model: sonnet` is the default. Use opus only if the specialist genuinely needs the smarter model (rare; specialists do focused work).
- `description` should explicitly state what tasks the specialist handles so description-matching routing works.

## Trigger SKILL.md ("front door")

```yaml
---
name: spec-detector
description: Use when the user asks to implement a spec, run the plan, build the tasks, or work through tasks.md / spec.md / plan.md / SPEC.md. Detects the presence of these files and hands off to the spec-orchestrator agent. Make sure to use this skill whenever spec/plan/tasks files are mentioned in the conversation, even if the user phrases the request casually.
allowed-tools: Read, Glob, Bash
---
```

**Key fields:**
- `description` must be pushy. Skills under-trigger; explicit "make sure to use this skill" phrasing helps materially.
- `allowed-tools` restricts what tools the skill body can call. For a router skill, keep it read-only (`Read`, `Glob`, `Bash` for `ls`).
- Do NOT add `context: fork` or `agent:` here — those would make the skill run in a sub-agent's context, which defeats the routing purpose. The skill needs to stay in the main conversation to hand off to the orchestrator.

**Dynamic context injection** (the key trick for detector skills):

````markdown
## Detect spec artifacts
!`ls spec.md plan.md tasks.md SPEC.md docs/specs/* 2>/dev/null`

## Instructions
If any of spec.md / plan.md / tasks.md / SPEC.md exist:
1. Summarize what was found.
2. Invoke `@spec-orchestrator` with the full file list.
3. Do NOT begin implementation yourself.
````

The ``!`backticks` `` syntax runs the command at skill-load time and injects the output into context. That's how the skill can know what files exist without the model having to call tools first.

## Slash command

```markdown
---
description: Implements a spec by dispatching to specialist sub-agents
allowed-tools: Read, Glob, Bash, Task
argument-hint: [optional spec file path]
---

You are running the implement-spec command. The user wants to execute a spec-driven workflow.

1. Detect spec artifacts: $ARGUMENTS or auto-discover via `ls spec.md plan.md tasks.md SPEC.md 2>/dev/null`
2. Invoke `@spec-orchestrator` with the artifact paths.
3. Report back when each phase completes.
```

**Key fields:**
- `description` shows up in the slash command picker.
- `allowed-tools` for a command often includes `Task` since commands run in the main conversation and CAN dispatch sub-agents.
- `argument-hint` shows in the picker as placeholder text.
- `$ARGUMENTS` interpolates the user's arguments into the prompt.

## CLAUDE.md routing rules (not frontmatter — just a block)

Append to the project's `CLAUDE.md`:

```markdown
## Spec-Driven Workflow

If `spec.md`, `plan.md`, `tasks.md`, or `SPEC.md` exists at the repo root OR under `specs/**`:
- Do NOT write code directly in the main conversation.
- Invoke `@spec-orchestrator` with the spec file path(s).
- If multiple spec files exist, prefer the most recent by mtime.
- The orchestrator owns delegation to specialists; trust its routing.

## Sub-Agent Routing Rules

**Parallel dispatch** (ALL conditions must be met):
- 3+ unrelated tasks or independent domains
- No shared state between tasks
- Clear file boundaries with no overlap

**Sequential dispatch** (ANY condition triggers):
- Tasks have dependencies (B needs output from A)
- Shared files or state (merge conflict risk)
- Unclear scope (need to understand before proceeding)

If execution diverges from the approved plan, stop and re-enter Plan Mode.
```

## Quick reference table

| File type | Path | Frontmatter format | Key field |
|---|---|---|---|
| Sub-agent | `.claude/agents/<name>.md` | YAML | `tools`, `model`, `skills` (list) |
| Skill | `.claude/skills/<name>/SKILL.md` | YAML | `allowed-tools`, `context`, `agent` |
| Slash command | `.claude/commands/<name>.md` | YAML | `allowed-tools`, `argument-hint` |
| CLAUDE.md | project root | none (plain markdown) | section headers |

## Pitfalls

- **`name:` must match the filename** (minus `.md`). `name: spec-orchestrator` requires `spec-orchestrator.md`.
- **`tools:` is comma-separated, not a YAML list.** `tools: Read, Edit, Write` not `tools: [Read, Edit, Write]` for sub-agents. (Skills use the list form for `allowed-tools`.)
- **CLAUDE.md is NOT loaded by built-in Explore and Plan sub-agents.** It IS loaded by every custom sub-agent.
- **A sub-agent's `skills:` list expands at startup** — full content, not lazy. Don't list 20 skills "just in case."
- **A skill's `context: fork` + `agent: <name>` makes it run in that sub-agent's context.** One-shot fork, no fan-out. Useful for "use this skill but in an isolated context," not for orchestration.
