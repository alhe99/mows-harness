# The Ecosystem (May 2026)

Side-by-side of the projects you might mine for ideas, in rough order of fit for spec-driven orchestration.

## zhsama/claude-sub-agent — CLOSEST EXISTING MATCH

**What it ships:** seven `spec-*` agents in `agents/spec-agents/` (analyst, architect, planner, developer, tester, reviewer, validator) plus a `spec-orchestrator` coordinator and a `commands/agent-workflow.md` slash command.

**Flow (from its README):**
```
[Project Idea] → spec-orchestrator
  → Planning: spec-analyst → spec-architect → spec-planner → Quality Gate 1 (≥95)
  → Development: spec-developer → spec-tester → Quality Gate 2 (≥80)
  → Validation: spec-reviewer → spec-validator → Quality Gate 3 (≥85)
  → Production Ready
```

**Two modes:**
- From a project idea: `Use spec-orchestrator with quality threshold 95: Create an enterprise CRM ...`
- From existing requirements: `Use spec-orchestrator starting from requirements: Load requirements from ./docs/requirements.md and continue workflow`

**Notable fork:** `jakeashcraft/claude-sub-agent-workflow` adapts this for .NET / manufacturing compliance, adds context-awareness ("Analyzing existing project state..."), and a `/agent-workflow` slash command that branches on new project / bug fix / enhancement / refactor.

**What to copy:** the seven-role decomposition, the three quality gates, the `requirements.md` / `architecture.md` / `tasks.md` artifact names. The orchestrator agent is hardcoded to these names — preserve them or fork.

**What to skip:** zhsama's specialists are generic. Replace with domain-specific ones if your project's vocabulary differs.

## barkain/claude-code-workflow-orchestration — HOOK-ENFORCED DELEGATION

**What it ships:** a PreToolUse hook + `/workflow-orchestrator:delegate` command + 8 specialists (`tech-lead-architect`, `codebase-context-analyzer`, `task-completion-verifier`, `code-cleanup-optimizer`, `code-reviewer`, `devops-experience-architect`, `documentation-expert`, `dependency-manager`).

**The hook enforces** that the main agent must call `/delegate` before any direct write. No exceptions.

**`/delegate` flow (verbatim from README):**
1. Enters native plan mode (EnterPlanMode) for unified planning and orchestration.
2. Plan mode analyzes task complexity and decomposes into phases.
3. Performs dependency analysis to determine execution mode (sequential or parallel).
4. Assigns specialized agents via keyword matching (≥2 match threshold).
5. Creates wave assignments and execution plan.
6. Creates task list via TaskCreate.
7. Exits plan mode (ExitPlanMode) and executes phases as directed by the plan.

**Agent Teams integration:** when `CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS=1` is set, complex workflows automatically choose between isolated sub-agents and collaborative teams via `TeamCreate` + `Agent(team_name=...)` + `SendMessage`.

**What to copy:** the PreToolUse hook pattern (for Stage 3), the dual-mode isolated/teams logic, the plan-mode-before-execute gate.

**What to skip:** barkain's specialists are tuned for generic web dev. Re-scope to your domain.

## buildermethods/agent-os — RETIRED ITS ORCHESTRATION PHASE

**Notable history:** v2.1.x shipped `/orchestrate-tasks` with an `orchestration.yml` schema:
```yaml
task_groups:
  - name: authentication-system
    claude_code_subagent: backend-specialist
    standards: [all]
  - name: user-dashboard
    claude_code_subagent: frontend-specialist
    standards: [global/*, frontend/components.md, frontend/css.md]
```

**v3.0.0 (Jan 20, 2026) deliberately removed it.** Verbatim release note:
> *"Implementation orchestration — Frontier models manage and delegate tasks on their own now (but you can still direct them to use subagents as you like)."*

**The signal:** a respected practitioner judged that frontier-model coding quality had risen enough that orchestration overhead wasn't worth it for typical features. This is real evidence that orchestration's value scales with feature size — small features may genuinely be faster with plan mode + a single agent.

**Pushback:** Discussion #324 in their repo asks for orchestrate-tasks back as sub-agents-based. There's a real audience for it; just not majority.

**What to copy:** the `orchestration.yml` schema (still useful even though Agent OS abandoned it). The standards-injection pattern (each task group gets specific standards files loaded).

## github/spec-kit — METHODOLOGY BACKBONE, NOT A FAN-OUT SYSTEM

**What it ships:** `/speckit.specify → /speckit.plan → /speckit.tasks → /speckit.implement` slash commands. Produces `spec.md` / `plan.md` / `tasks.md` artifacts.

**Critical limitation:** `/speckit.implement` is a single-agent template. It does not invoke named specialists. Issue #1008 notes verbatim that it "executes all tasks at once" and requests an incremental variant.

**What to copy:** the artifact format (`spec.md` / `plan.md` / `tasks.md` is becoming a de facto standard). The four-stage methodology (Specify → Plan → Tasks → Implement) is solid.

**What to skip:** the implementation phase. If you use Spec Kit's artifacts, layer your own orchestrator on top.

**Integration play:** the artifact format pairs cleanly with a zhsama-style orchestrator. You get Spec Kit's quality methodology AND fan-out execution.

## wshobson/agents (Conductor plugin) — CONTEXT → SPEC & PLAN → IMPLEMENT

**What it ships:** Context-driven development workflow. `/conductor:new-track` generates per-feature folders with `spec.md` + phased `plan.md`. `/conductor:implement` executes with TDD red-green-refactor and verification checkpoints.

**The broader `wshobson/agents` repo** describes itself verbatim:
> *"A comprehensive production-ready system combining 185 specialized AI agents, 16 multi-agent workflow orchestrators, 153 agent skills, and 100 commands organized into 80 focused, single-purpose plugins for Claude Code."*

**What to copy:** the per-track folder structure (each feature gets `tracks/<feature>/spec.md` and `tracks/<feature>/plan.md`). The TDD checkpoint pattern in `/conductor:implement`. The 4-agent / 7-command / 3-skill bundling for clean install.

**What to skip:** the broader 185-agent marketplace is overwhelming; cherry-pick from Conductor specifically.

## 0xfurai/claude-code-subagents — SPECIALIST LIBRARY

**What it ships:** 100+ specialized sub-agents. Verbatim self-description:
> *"100+ specialized subagents that extend Claude Code's capabilities. Each subagent is an expert in a specific domain, automatically invoked based on context or explicitly called when needed"* — `python-expert`, `fastapi-expert`, `terraform-expert`, `playwright-expert`, etc.

**What to copy:** drop relevant specialists into `.claude/agents/`. They're production-tested and have good descriptions for routing-by-matching.

**What to skip:** their orchestration is implicit (description-matching from the main conversation). If you want explicit orchestration, pair these with zhsama's `spec-orchestrator`.

## iannuttall/claude-agents — PLANNING HALF OF THE LOOP

**What it ships:** lighter than 0xfurai. Includes a `prd-writer` and a `project-task-planner` that converts a PRD into `plan.md`.

**Important constraint:** the `project-task-planner` explicitly does NOT execute. Its frontmatter says verbatim: *"You are not responsible or allowed to action any of the tasks."*

**What to copy:** these are the "planning sub-agents that generate a spec" half of your pattern. Pair with zhsama's developer/tester for the implementation half.

## Other notable mentions

- **`jeremylongshore/claude-code-plugins-plus-skills`** — formal Input/Output JSON contracts per phase. Cleanest contract design I found. Read if you want to do pattern 3 (structured JSON contract) properly.
- **`tomas-rampas` gist (GitHub)** — canonical CLAUDE.md routing rules. Drop-in block for Stage 2.
- **`claudefa.st`** — sub-agent routing rules (parallel vs sequential dispatch criteria). Good for Stage 2 CLAUDE.md.
- **`alexop.dev`** — real-world walkthroughs. SQLite→IndexedDB migration with parallel research sub-agents + written specs. TDD red-green-refactor with skill+sub-agent delegation.
- **PubNub blog** — three-stage `pm-spec → architect-review → implementer-tester` pipeline with status fields (READY_FOR_ARCH, READY_FOR_BUILD, DONE) and a queue-watcher hook. State machine over markdown — practical and lightweight.

## When the user mentions a specific project

| User mentions | Point them to |
|---|---|
| "the spec→delegate pattern" | zhsama (closest match) |
| "PreToolUse hook" or "enforced delegation" | barkain |
| "orchestration.yml" or "task groups" | Agent OS v2 (artifact format, but the project itself moved on) |
| "spec.md / plan.md / tasks.md format" | github/spec-kit (artifacts), zhsama (orchestrator on top) |
| "per-feature track folders" | Conductor (`wshobson/agents`) |
| "I need a Python/Rust/Terraform specialist" | 0xfurai (drop their agent file in) |
| "PRD writer" or "spec generator" | iannuttall |
| "JSON contract between agents" | jeremylongshore |
| "CLAUDE.md routing rules" | tomas-rampas gist + claudefa.st |

Pick the closest match, copy what works, skip what doesn't.
