---
name: spec-driven-orchestration
description: Use this skill whenever the user wants to set up spec-driven or plan-driven agent orchestration in a Claude Code project — building a workflow where a spec.md / plan.md / tasks.md / SPEC.md file gets fanned out to specialist sub-agents. Trigger on phrases like "set up an orchestrator", "build a spec→delegate workflow", "make a skill that reads spec.md and dispatches to specialists", "how do I orchestrate sub-agents", "implement tasks.md across backend/frontend/db specialists", "can a SKILL.md spawn sub-agents", "orchestrator pattern", or any mention of zhsama/claude-sub-agent, barkain/claude-code-workflow-orchestration, Agent OS orchestrate-tasks, Spec Kit `/speckit.implement`, or Conductor. Also trigger when the user is confused about whether a skill can fan out to sub-agents (it cannot — only sub-agents and slash commands can) and needs the corrected architecture. The skill advises on the right architecture for the user's stage, then scaffolds the matching `.claude/` files (agents, slash command, trigger skill, CLAUDE.md rules) from bundled templates.
---

# Spec-Driven Agent Orchestration

This skill helps users build a workflow on Claude Code where a written spec (`spec.md`, `plan.md`, `tasks.md`, `SPEC.md`) is read by an orchestrator, decomposed into per-domain task groups, and dispatched to specialist sub-agents. Two-mode skill: **advise** first (figure out the right shape for the project), then **scaffold** (drop template files into `.claude/`).

## The one architectural rule everyone gets wrong

Before anything else, internalize this: **a SKILL.md cannot fan out to multiple sub-agents.** Skills are model-invoked context injection — they load into the main conversation when description-matching fires. Only the **main conversation** (or a slash command running in it) can call `Task` / `Agent` to spawn multiple sub-agents in parallel. And sub-agents themselves cannot spawn other sub-agents (Anthropic's docs are explicit: *"Subagents cannot spawn other subagents. If your workflow requires nested delegation, use Skills or chain subagents from the main conversation."*).

So if the user says "I want a SKILL.md that reads spec.md and delegates to specialists," they have the wrong mental model. The right shape is one of:

- **(A) Slash command + orchestrator sub-agent.** `/implement-spec` lives in `.claude/commands/`, runs in the main conversation, calls `@spec-orchestrator` which fans out. *Most common, easiest to reason about.*
- **(B) Orchestrator-as-main-agent.** CLAUDE.md tells the main conversation to behave as orchestrator when spec files exist and to delegate by description-matching to specialists. *No slash command needed; the routing is rule-based.*
- **(C) Hook-enforced delegation.** A `PreToolUse` hook blocks direct file edits unless they came from a designated specialist sub-agent (barkain's approach). *Heaviest, most rigid; good for teams that don't trust the model to delegate voluntarily.*

A skill **can** be the "front door" that explains the user's intent to Claude and emits an `@orchestrator` invocation — but the skill itself is not the orchestrator. That distinction matters.

## What to do when this skill triggers

### Step 1 — Diagnose where the user is

Ask the user (or infer from the conversation):

1. **Do you have a `spec.md` / `plan.md` / `tasks.md` / `SPEC.md` file already?** If yes, the orchestrator needs to read it. If no, you need a planning phase first (`spec-analyst` → `spec-architect` → `spec-planner`).
2. **How many domains does the project span?** Backend-only? Backend + frontend + db + tests? The number of specialists scales here. Solo-domain projects often don't need orchestration at all — frontier model + plan mode is faster and cheaper.
3. **Are you starting from zero or do you have agents already?** Reuse what's there; don't replace.
4. **How strict do you need delegation to be?** "Recommended" via CLAUDE.md rules, or "enforced" via PreToolUse hook?

Read `references/adoption-stages.md` to map the answers to a stage:

- **Stage 1 (adopt):** No existing orchestration → install zhsama/claude-sub-agent's seven `spec-*` agents wholesale and customize later.
- **Stage 2 (hybrid):** Some specialists exist or domain is unusual → keep zhsama's orchestrator shape but rename/re-scope specialists per `0xfurai/claude-code-subagents`. Add a `spec-detector` SKILL.md as the front door.
- **Stage 3 (production):** Multiple developers, strict process, audit trail needed → add barkain's PreToolUse hook, Agent OS's `orchestration.yml` task routing, SubagentStop quality gates, append-only `progress.md`.

If the user wants to discuss tradeoffs first rather than scaffold, read `references/architectures.md` and walk through (A) / (B) / (C). If they want to compare existing tools, read `references/ecosystem.md` for a side-by-side of zhsama, barkain, Agent OS, Spec Kit, Conductor.

### Step 2 — Recommend, don't dictate

Be explicit about the tradeoffs. Two real signals from the ecosystem the user should hear:

- **Agent OS v3 (Jan 2026) retired its orchestration phase** with the verbatim release note: *"Implementation orchestration — Frontier models manage and delegate tasks on their own now (but you can still direct them to use subagents as you like)."* That's a respected practitioner saying the marginal value of fan-out has shrunk as model quality rose. If the user's features routinely touch fewer than 5 files or 2 domains, plan mode + a single agent may beat any orchestrator.
- **Skills under-trigger.** Anthropic's own skill-creator carries this warning: *"Note: currently Claude has a tendency to 'undertrigger' skills -- to not use them when they'd be useful."* Description-only routing isn't deterministic. If the user needs the workflow to fire *every* time, use a slash command (user-invoked) or a CLAUDE.md rule, not a trigger skill.

State the user's stage recommendation in one sentence, list the tradeoffs in two, and then ask if they want to scaffold.

### Step 3 — Scaffold (only after the user confirms)

Confirm the target path (default `.claude/` at repo root, or `~/.claude/` for user-scoped). Then copy the relevant templates from `assets/` into the user's repo, customizing names where appropriate.

**Minimum viable scaffold (Stage 1 / 2):**

```
.claude/
├── agents/
│   ├── spec-orchestrator.md       # from assets/agents/spec-orchestrator.md
│   ├── spec-analyst.md            # planning role — requirements.md
│   ├── spec-architect.md          # planning role — architecture.md, api-spec.md
│   ├── spec-planner.md            # planning role — tasks.md
│   ├── backend-specialist.md      # implementation role
│   ├── frontend-specialist.md     # implementation role
│   ├── db-specialist.md           # implementation role
│   ├── test-specialist.md         # validation role
│   └── validator.md               # final quality gate
├── commands/
│   └── implement-spec.md          # slash command entry: /implement-spec
└── skills/
    └── spec-detector/
        └── SKILL.md               # auto-triggers on spec/plan/tasks files
```

Plus a snippet to append to the project's `CLAUDE.md` (see `assets/claude-md-rules.md`).

**Stage 3 additions:**
- `.claude/hooks/post-phase-gate.sh` — SubagentStop hook enforcing quality thresholds (95 planning / 80 development / 85 validation, zhsama's defaults).
- `.claude/orchestration.yml` — task-group → specialist routing config, Agent OS v2 schema (still useful; see `references/architectures.md`).
- `plans/progress.md` — append-only log every specialist writes to. See `references/context-passing.md`.

**Reading order for the user:** point them at `references/ecosystem.md` first if they want to know *why* you chose this shape, or `assets/agents/spec-orchestrator.md` first if they want to start customizing immediately.

### Step 4 — Verify before claiming done

After scaffolding, tell the user the explicit verification steps:

1. Run `ls -la .claude/agents/` to confirm the files landed.
2. Test the trigger skill: in a new Claude Code session, ask "implement the tasks in tasks.md" with a real `tasks.md` present. The skill should fire and call `@spec-orchestrator`.
3. Watch the orchestrator's first dispatch: does it parse the tasks file correctly? Does each specialist receive only the tasks for its domain?

Don't claim the setup works until you've seen it actually delegate at least once. The most common failure is the orchestrator narrating delegation in text instead of actually calling `Task` / `Agent`.

## What this skill is NOT

- **Not a replacement for Spec Kit or Agent OS.** If the user already uses those, this skill helps add the dispatch layer that Spec Kit's `/speckit.implement` lacks and that Agent OS v3 explicitly removed. The artifact format stays theirs.
- **Not an attempt to make a skill spawn sub-agents.** That's architecturally impossible on Claude Code as of May 2026. If the user insists they want one skill that does it all, gently explain why it can't work and route them to (A) or (B).
- **Not a one-size-fits-all template.** The seven-role decomposition is zhsama's; some projects want fewer (just an orchestrator + 3 specialists), some want more (separate security, perf, docs). Adjust the scaffold during the conversation.

## Reference index

When you need depth, load these:

- `references/architectures.md` — the three viable architectures (slash command + orchestrator / orchestrator-as-main / hook-enforced) with pros, cons, and concrete examples.
- `references/adoption-stages.md` — Stage 1 / 2 / 3 progression, when to advance, when to stop.
- `references/context-passing.md` — file-based handoff, append-only progress log, structured JSON contract — and why conversation history *never* works across sub-agents.
- `references/ecosystem.md` — side-by-side of zhsama, barkain, Agent OS, Spec Kit, Conductor, 0xfurai, iannuttall, with what to copy from each.
- `references/frontmatter-patterns.md` — YAML frontmatter cheat sheet for orchestrators, specialists, trigger skills, and slash commands.

When you need to scaffold, load these:

- `assets/agents/*.md` — drop-in templates for each role. Rename and re-scope freely.
- `assets/skills/spec-detector/SKILL.md` — the front-door trigger skill.
- `assets/commands/implement-spec.md` — the slash command alternative.
- `assets/claude-md-rules.md` — block to append to the project's CLAUDE.md.
