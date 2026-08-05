# Staged Adoption: From Zero to Production

The ecosystem is six months old (Agent Skills launched Oct 16, 2025). Patterns are settling but not stable. The cheapest way to build is to start small, see what hurts, and only then add machinery. Three stages, with explicit triggers for advancing.

## Stage 1 — Adopt (this week)

**Goal:** see if any orchestration helps your project at all.

**What you do:**

1. Clone `zhsama/claude-sub-agent`.
2. Copy its seven `spec-*` agents into your `.claude/agents/`:
   ```
   cp -r zhsama-clone/agents/spec-agents/*.md .claude/agents/
   cp zhsama-clone/commands/agent-workflow.md .claude/commands/
   ```
3. Try it on a real spec: `/agent-workflow "implement spec.md"`.
4. Watch what happens for 3–5 runs.

**Why this stage:** zhsama is the closest existing match. You get all seven roles (analyst, architect, planner, developer, tester, reviewer, validator) plus a working slash command for the cost of a `cp -r`. If it fits, customize from there. If it doesn't fit, you've learned exactly what's wrong before building.

**Advance to Stage 2 when:**
- The orchestrator misroutes >20% of tasks across 5 runs (e.g., gives backend work to the frontend specialist).
- You need specialists zhsama doesn't ship (data eng, ML, mobile, etc.).
- Your domain vocabulary differs enough that the description-matching fails.

**Stop at Stage 1 when:**
- It just works. Don't add complexity for its own sake.
- Frontier-model plan mode + a single agent is faster for your typical feature size. Agent OS v3 retired orchestration for a reason — small features genuinely don't need fan-out.

## Stage 2 — Hybrid (next sprint)

**Goal:** keep the orchestrator shape, replace the specialists with your domain's roles, add a skill front door.

**What you do:**

1. Keep `spec-orchestrator.md` from zhsama (rename if you want).
2. Replace zhsama's developer/tester with domain specialists from `0xfurai/claude-code-subagents` or hand-written:
   - `backend-specialist.md` — your stack, your conventions
   - `frontend-specialist.md` — your framework, your component library
   - `db-specialist.md` — your migrations tool, your schema rules
   - `test-specialist.md` — your test framework
   - `docs-specialist.md` — your docs format
   - `security-specialist.md` (optional) — your threat model
3. Add a `spec-detector` SKILL.md that auto-triggers on "implement spec/plan/tasks" phrasing and emits `@spec-orchestrator`. **The skill does not delegate** — it just routes. (See `references/architectures.md` for why.)
4. Add CLAUDE.md routing rules (see `assets/claude-md-rules.md`) so the model knows to use the orchestrator when spec files exist.

**Why this stage:** you've proved orchestration helps, but generic specialists drift on your project's conventions. Domain-specific specialists with project-aware system prompts close that gap. The skill front door covers the case where users phrase the request naturally instead of typing the slash command.

**Advance to Stage 3 when:**
- You're on a team where some developers ignore the workflow and edit files directly.
- You need an audit trail of which specialist did what.
- You find yourself manually switching between isolated sub-agents and Agent Teams based on task complexity.

**Stop at Stage 2 when:**
- Solo or small team and everyone respects the workflow.
- The slash command + skill combo catches most invocations and the misses don't matter.

## Stage 3 — Production (next month, only if you need it)

**Goal:** enforce delegation, formalize routing, persist progress across sessions.

**What you add:**

1. **PreToolUse hook** (`barkain` style) that blocks direct `Edit` / `Write` calls in the main conversation. Forces all mutations through specialists. See `assets/claude-md-rules.md` for the hook setup snippet.
2. **`orchestration.yml`** (Agent OS v2 schema, still useful even though Agent OS itself retired it):
   ```yaml
   task_groups:
     - name: authentication-system
       claude_code_subagent: backend-specialist
       standards: [all]
     - name: user-dashboard
       claude_code_subagent: frontend-specialist
       standards: [global/*, frontend/components.md, frontend/css.md]
   ```
   The orchestrator reads this instead of (or in addition to) guessing routing from task descriptions.
3. **SubagentStop quality gates** — hooks that fire after each specialist completes and enforce thresholds. zhsama's defaults: ≥95 planning, ≥80 development, ≥85 validation.
4. **Append-only `progress.md`** — every specialist writes a `## YYYY-MM-DD-agent-name` block with `Artifacts:` and `Next:`. Lets the orchestrator resume across sessions. See `references/context-passing.md`.
5. **Agent Teams dual-mode** — set `CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS=1` and let the orchestrator pick between isolated sub-agents (cheap, fast, no cross-talk) and Agent Teams (`TeamCreate` + `SendMessage`, collaborative, expensive). barkain ships this; it's the most production-ready dual-mode pattern.

**Why this stage:** at this point you have multiple developers, real consequences for a wrong edit, and patterns that need to repeat across sessions reliably. The machinery is worth the friction.

**Don't go past Stage 3.** If you need more, you're building a framework, not using one. Either contribute upstream to barkain/zhsama or accept that your needs are unusual and design for them explicitly.

## Anti-patterns at every stage

- **Don't write a skill that tries to spawn sub-agents directly.** Architecturally impossible. (See `references/architectures.md`.)
- **Don't replicate Spec Kit's artifact format** if you already have your own. Adapt zhsama's `requirements.md` / `architecture.md` / `tasks.md` instead, since its orchestrator is hardcoded to those names.
- **Don't build per-language specialists from scratch.** Use `0xfurai/claude-code-subagents` — 100+ production-tested domain agents already exist.
- **Don't deploy without a verification gate.** Every project in production (PubNub, jeremylongshore, zhsama, barkain) has phase-end validation. Skip it and you'll silently merge bad output.
- **Don't trust the orchestrator's narration.** "I'll now dispatch to backend-specialist..." is text, not a tool call. Verify by reading the actual `Task` / `Agent` invocations in the transcript.
