# CLAUDE.md Routing Rules — Append This Block

Append the following block to your project's `CLAUDE.md` (or `~/.claude/CLAUDE.md` for user-scoped). It tells the main conversation how to behave when spec artifacts exist.

---

## Spec-Driven Workflow

If `spec.md`, `plan.md`, `tasks.md`, or `SPEC.md` exists at the repo root OR under `specs/**` OR `docs/specs/**`:

- Do NOT write code directly in the main conversation.
- Invoke `@spec-orchestrator` with the spec file path(s).
- If multiple spec files exist, prefer the most recent by `mtime`.
- The orchestrator owns delegation planning; trust its routing but verify each specialist's output before advancing.

## Sub-Agent Routing Rules

**Parallel dispatch** (ALL conditions must be met):
- 3+ unrelated tasks across independent domains
- No shared state between tasks
- Clear file boundaries with no overlap

**Sequential dispatch** (ANY condition triggers):
- Tasks have dependencies (B needs output from A)
- Shared files or state (merge conflict risk)
- Unclear scope (need to understand before proceeding)

## Plan Mode Reentry

If execution diverges from the orchestrator's approved plan, stop and re-enter Plan Mode. Don't keep going off-plan in the hope it'll converge.

## Specialist Assignment

- `@db-specialist` — migrations, indexes, seed data, schema changes
- `@backend-specialist` — API routes, controllers, services, business logic
- `@frontend-specialist` — UI components, state, routing, client logic
- `@test-specialist` — unit, integration, E2E tests, coverage
- `@validator` — quality gates after each phase
- `@spec-analyst` — turns intent into `requirements.md` + `user-stories.md`
- `@spec-architect` — turns requirements into `architecture.md` + `api-spec.md`
- `@spec-planner` — turns architecture into tagged `tasks.md` + `test-plan.md`
- `@spec-orchestrator` — coordinates dispatch across phases

---

# (Stage 3 only) PreToolUse Hook Snippet

If you're enforcing delegation via a hook, add this to `.claude/settings.json`:

```json
{
  "hooks": {
    "PreToolUse": [
      {
        "match": "Edit|Write|MultiEdit",
        "exec": ".claude/hooks/enforce-delegation.sh"
      }
    ]
  }
}
```

And create `.claude/hooks/enforce-delegation.sh`:

```bash
#!/usr/bin/env bash
# Block direct Edit/Write/MultiEdit in the main conversation
# unless invoked by a designated specialist sub-agent.

if [[ "$CLAUDE_AGENT_NAME" == "backend-specialist" \
   || "$CLAUDE_AGENT_NAME" == "frontend-specialist" \
   || "$CLAUDE_AGENT_NAME" == "db-specialist" \
   || "$CLAUDE_AGENT_NAME" == "test-specialist" \
   || "$CLAUDE_AGENT_NAME" == "spec-analyst" \
   || "$CLAUDE_AGENT_NAME" == "spec-architect" \
   || "$CLAUDE_AGENT_NAME" == "spec-planner" ]]; then
  exit 0
fi

echo "Direct edits are disabled. Use /implement-spec or invoke a specialist sub-agent." >&2
exit 2
```

Make it executable: `chmod +x .claude/hooks/enforce-delegation.sh`.

Heads up: Anthropic's hook environment variables (e.g., `CLAUDE_AGENT_NAME`) may evolve. Verify against the current docs at `code.claude.com/docs/en/hooks` before relying on this — the names are accurate to the May 2026 hook ABI but not guaranteed forward-compatible.
