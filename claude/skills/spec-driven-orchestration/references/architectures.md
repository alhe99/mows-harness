# The Three Viable Architectures

Skills cannot fan out to sub-agents. Sub-agents cannot spawn sub-agents. Only the main conversation (or a slash command running in it) can call `Task` / `Agent` to dispatch in parallel. That constraint funnels every real orchestration shape into one of these three.

## (A) Slash command + orchestrator sub-agent — MOST COMMON

**Shape:**
```
User types /implement-spec
  → .claude/commands/implement-spec.md runs in main conversation
  → main conversation calls @spec-orchestrator (a sub-agent)
  → spec-orchestrator returns a task plan + dispatches phase 1 specialists
    (but the dispatch is actually executed back in the main conversation —
     the orchestrator's role is to plan the routing, not to call Task directly)
```

**Why this works:** the slash command sits in the user's hands as a deterministic entry point. The orchestrator owns the *planning* of dispatch (which specialist gets which tasks) but the *act* of dispatch happens in the main conversation because sub-agents can't spawn sub-agents. This is zhsama/claude-sub-agent's actual shape, despite its README diagrams looking like the orchestrator dispatches directly.

**Pros:**
- User invocation is explicit and deterministic — no skill under-triggering.
- The orchestrator's plan is an artifact the user can review before execution.
- Works with both fresh specs (planning phase first) and existing tasks.md (skip to execution).

**Cons:**
- Two-step indirection (slash command → orchestrator plan → main-conversation dispatch) is harder to debug than a single agent.
- Requires the user to know the slash command exists. Discoverability is a real problem.

**Use when:** the team is small, the workflow is deliberate, and you want the entry point under the user's finger.

## (B) Orchestrator-as-main-agent (CLAUDE.md routing rules)

**Shape:**
```
CLAUDE.md contains:
  "If spec.md / plan.md / tasks.md exists at repo root, behave as orchestrator:
   1. Read the spec file.
   2. Parse tasks into domain groups (backend, frontend, db, tests, docs).
   3. Dispatch each group to the matching specialist sub-agent via Task.
   4. Apply quality gates after each phase."
```

Specialist sub-agents are still in `.claude/agents/` and selected by description-matching.

**Why this works:** CLAUDE.md is read by every Claude Code session. If the user opens the project and asks "implement the spec," the main conversation already knows what to do.

**Pros:**
- Zero ceremony — open the project, type the request, it happens.
- Maximum discoverability — anyone who reads CLAUDE.md sees the workflow.
- Plays nicely with the model improvements that drove Agent OS v3 to retire its own orchestration phase. The frontier model genuinely can dispatch on its own when told how.

**Cons:**
- Less deterministic than a slash command — depends on the main conversation actually following the CLAUDE.md rule.
- Harder to "turn off" if the user wants direct edits sometimes and orchestration other times.
- The main conversation context fills up with the orchestrator's reasoning *and* the specialists' summaries.

**Use when:** the team is small enough that everyone reads CLAUDE.md, the workflow is the default behavior (not an opt-in), and you want zero overhead.

## (C) Hook-enforced delegation (PreToolUse hook)

**Shape:**
```
.claude/hooks/pre-write.sh runs on every Edit/Write tool call.
If the caller is NOT a designated specialist sub-agent, block the call
and emit a message: "Direct edits disabled. Use /delegate or @spec-orchestrator."
```

barkain/claude-code-workflow-orchestration's actual implementation.

**Why this works:** the hook is enforced by the harness, not the model. The model can't talk its way around it. If you require that every line of code go through a specialist (for audit reasons, for example), this is the only architecture that delivers.

**Pros:**
- Strongest guarantee. The model cannot bypass delegation by deciding to "just do this one thing."
- Forces good habits — newcomers can't fall into anti-patterns.
- Auditable: every change has a specialist's name attached.

**Cons:**
- Heavy. Setting up the hook, debugging false positives, handling the "I just want to fix a typo" case — all friction.
- Couples your workflow to the harness's hook implementation, which Anthropic could change.
- Can be infuriating during exploratory work when you don't yet know which specialist owns what.

**Use when:** multi-developer team, compliance or audit requirements, or you've tried (A) or (B) and the model keeps skipping delegation.

## A non-architecture: SKILL.md that spawns sub-agents

This doesn't work. Skills run in the main conversation when description-matching fires; they're context injection, not control flow. A skill body can *suggest* that the main conversation invoke `@spec-orchestrator`, and the main conversation may or may not do that depending on how clearly the skill phrases the instruction. But the skill itself has no `Task` or `Agent` tool call ability except indirectly through the conversation it lives in.

If the user asks "can I make a SKILL.md that reads spec.md and dispatches to specialists," the honest answer is: the skill can detect the spec file and instruct the main conversation to delegate, but the act of delegation happens one level up. So you build a thin trigger skill (`spec-detector`) that emits the instruction, plus an orchestrator sub-agent (`spec-orchestrator`) that plans the dispatch. Two files, not one. That's architecture (A) with a skill front door instead of a slash command.

## Picking between (A), (B), (C)

| Question | If yes → | If no → |
|---|---|---|
| Strict compliance / audit needed? | (C) | continue |
| Solo developer or 2-3 person team? | (B) | continue |
| Want explicit user invocation? | (A) | (B) |

The default recommendation for most projects is **(A) with a skill front door** — slash command for explicit invocation, plus a `spec-detector` skill that nudges the conversation when the user uses natural language ("implement the tasks") instead of typing `/implement-spec`. Belt and braces.
