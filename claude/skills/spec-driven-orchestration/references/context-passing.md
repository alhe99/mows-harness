# Passing Context Between Agents

The single biggest mistake people make with multi-agent orchestration on Claude Code: assuming sub-agents inherit conversation history. They don't. Anthropic's docs are explicit:

> *"Each subagent starts with a fresh, isolated context window. It does not see your conversation history, the skills you've already invoked, or the files Claude has already read."*

That means every cross-agent handoff has to pass context explicitly. Three patterns are in active use across the ecosystem.

## Pattern 1 — File-based handoff (cheapest, most popular)

**Used by:** zhsama, Agent OS, Conductor, Spec Kit.

Each phase writes a markdown artifact to a known path. The orchestrator passes the path to the next specialist as input.

```
spec-analyst writes:    requirements.md
spec-architect writes:  architecture.md, api-spec.md
spec-planner writes:    tasks.md, test-plan.md
backend-specialist reads: tasks.md, architecture.md, api-spec.md
                writes:   src/api/*.ts, tests/api/*.spec.ts, IMPL_REPORT.md
test-specialist reads:    IMPL_REPORT.md, tasks.md
                writes:   coverage report
```

**Pros:**
- Cheap. No state machine, no JSON schemas to maintain.
- Version-controllable — the artifacts live in git alongside the code.
- Auditable — you can read what each agent saw and wrote.
- Resumable — pick up after a crash by re-reading the files.

**Cons:**
- Path conventions become implicit contracts. If `spec-analyst` writes `docs/requirements.md` but `spec-architect` reads `requirements.md`, you have a silent bug.
- No schema validation. If `tasks.md` is malformed, the consumer just fails confusingly.

**Recommendation:** start here. Move to pattern 2 or 3 only if you outgrow it.

## Pattern 2 — Append-only progress log

**Used by:** the "theaistack" pattern, jeremylongshore variants.

A single `progress.md` (or `plans/<feature>/progress.md`) that every agent appends to. Each entry has a fixed header.

```markdown
## 2026-05-22 — spec-analyst
Artifacts:
- requirements.md
- user-stories.md
Next: spec-architect (review user stories, produce architecture.md)

## 2026-05-22 — spec-architect
Artifacts:
- architecture.md
- api-spec.md
Notes: Adopted hexagonal layering; deferred GraphQL layer to v2.
Next: spec-planner

## 2026-05-22 — spec-planner
Artifacts:
- tasks.md (47 tasks across backend/frontend/db/tests)
Next: spec-orchestrator (dispatch implementation phase)
```

**Pros:**
- Resumable across sessions — the orchestrator can re-read `progress.md` after a crash or context loss and figure out where it was.
- Cheap audit trail. Every agent's contribution is recorded.
- Plays well with pattern 1 (the log references the artifacts).

**Cons:**
- Append-only is a discipline — if one agent overwrites instead of appends, you've lost history.
- Conflict-prone in parallel dispatch — two specialists appending simultaneously can clobber each other on filesystems without atomic appends. Workaround: each specialist writes to its own `progress-<agent>.md` and the orchestrator merges.

**Recommendation:** add this once you've crossed multiple sessions on a single feature, or when the orchestrator starts forgetting what's done.

## Pattern 3 — Structured JSON contract

**Used by:** jeremylongshore's `claude-code-plugins-plus-skills`, PubNub's pipeline pattern.

Every phase sub-agent returns a strict JSON object back to the orchestrator. The orchestrator validates the schema before advancing to the next phase.

```json
{
  "phase": "planning",
  "status": "complete",
  "agent": "spec-planner",
  "artifacts": [
    {"path": "tasks.md", "kind": "task-list", "task_count": 47},
    {"path": "test-plan.md", "kind": "test-plan"}
  ],
  "phase_data": {
    "domains": ["backend", "frontend", "db", "tests"],
    "estimated_complexity": "medium",
    "blocked_on": []
  },
  "next_phase": "development",
  "quality_score": 96
}
```

**Pros:**
- Schema-enforced contracts. The orchestrator can refuse to advance if a field is missing.
- Quality gates become trivial (`if quality_score < 80, halt`).
- Machine-readable — you can build dashboards and metrics on top.

**Cons:**
- Heavyweight. Writing the schema, validating it, handling parse errors — all friction.
- The specialist sub-agents now need to know the schema. Drift between schema and prompt is a constant source of bugs.
- Markdown-loving developers will resist it.

**Recommendation:** add this only at Stage 3, and only if you've already hit pain with patterns 1/2. Don't lead with it.

## What DOES NOT work

**Relying on conversation history.** Bears repeating: sub-agents see none of the parent's history. Every input has to be in the prompt or in a file path the sub-agent is told to read.

**Implicit "the orchestrator knows."** The orchestrator's context window is also bounded. If a specialist's output exceeds a few KB, summarize before passing it back into the next dispatch. Otherwise the orchestrator's context fills with raw output instead of decisions.

**Letting specialists call other specialists.** Sub-agents cannot spawn sub-agents (Anthropic's rule). If a backend-specialist realizes it needs a db migration, it must return that to the orchestrator (or to the main conversation) and let *that* layer dispatch a `db-specialist`. Trying to chain specialist→specialist silently fails — the model will simulate the call in text instead of making it real.

**Trusting that artifacts exist without checking.** Add a `ls` or `Read` at the start of every specialist's prompt to verify its expected inputs are present. Otherwise the specialist will hallucinate content that "should" be in the missing file.

## Cross-pattern checklist

When you set up context passing, verify:

- [ ] Every specialist's prompt explicitly states which files to read.
- [ ] Every specialist's prompt explicitly states which files to write and where.
- [ ] The orchestrator validates artifacts after each phase (file exists, non-empty, parses).
- [ ] Quality gates are real (a script or a sub-agent check), not just narrative ("I'll now check quality").
- [ ] Failure modes are explicit: what does the orchestrator do if a specialist returns malformed output? (Re-dispatch with corrections? Halt? Skip?)

If you can answer all five, your context passing will hold up. If even one is fuzzy, you have a latent bug waiting for the wrong run to surface it.
