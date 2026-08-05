# ship-spec — Multi-Agent Feature Shipping Orchestrator

> Date: 2026-05-25
> Status: v0.1 (initial design)
> Author: harness maintainer (with Claude)

## Purpose

Take a spec file (or feature branch) and ship it through the entire pipeline autonomously: implement → QA (gates + visual + regression) → PR train → CI gates → merge → release PR → tag → production deploy → notify. Codifies the manual choreography developed while shipping example-feature into a reusable orchestration.

Sits on top of two existing skills:
- `~/.claude/skills/spec-driven-orchestration/` — defines the implement phase (planning + dispatch to specialist agents). We **reuse**, not replace.
- `~/.claude/skills/build-with-agent-team/` — defines TeamCreate + Task(team_name=…) plumbing for tmux-backed teammates. We **adopt** verbatim.

ship-spec adds two phases the above don't cover: **QA** (visual + regression + gates) and **Deploy** (gitflow + tag + production-monitor).

## Architectural rule (non-negotiable)

A SKILL.md cannot spawn sub-agents. Only the main conversation (or a slash command running in it) can call `Task` / `Agent` / `TeamCreate`. Sub-agents themselves cannot spawn sub-agents.

So the orchestrator (**Lead**) is the **main conversation**. The slash command `/ship-spec` is the entry point. Lead reads the spec, spawns teammates via `Task(team_name=…)`, relays contracts, and runs the lifecycle.

## Team composition

Four roles. Lead is the main conversation; the other three are spawned via `Task` into a single team created by `TeamCreate("ship-spec-<run-id>")`.

| Role | Owns | Forbidden | Spawned via |
|------|------|-----------|-------------|
| **Lead** | Spec parsing, team composition, message relay, state.json, AskUserQuestion gates, final PushNotification | Implementation, `gh` operations, `git push`, tag creation | (main conversation) |
| **Builder** | Code paths declared in spec (e.g. `src/features/X/**`, `internal/Y/**`); test commands; handoff JSON | `gh` CLI, `git push`, `git tag`, branches outside their scope | `Task(name="builder-fe" \| "builder-be" \| …)` |
| **QA** | Test gate reruns; visual QA via chrome-devtools MCP; regression walkthrough; QA report | Code edits (read-only), `gh`, deploy operations | `Task(name="qa")` |
| **Deploy** | All `gh` + `git push` + `git tag` operations; CI watching; gitflow promotion; production deploy monitoring; autonomous rollback | Code edits, test execution beyond `gh run watch` | `Task(name="deploy")` |

Hard rule: **Lead is the only message relay.** Agents send results to Lead via SendMessage; Lead verifies, then forwards to the next role. No agent-to-agent direct chats — that's where contract drift happens.

## Handoff protocol

Every phase is a contract Lead enforces. No phase advances until Lead receives a structured handoff and verifies it.

### Spec → Builder(s)

Lead reads spec, extracts numbered tasks, identifies stack split (FE/BE/data). For each stack, spawns one Builder with:
- Ownership path + "do not touch" list
- Exact test commands (`bun run typecheck && bun run lint && bun run test`, `go test ./...`, etc.)
- Required handoff format (see templates/builder-handoff.json)
- Forbidden tools list
- Invariants from CLAUDE.md / AGENTS.md (subset relevant to their stack)

### Builder → Lead

Builder writes `.agent-team/<run-id>/builder-<name>.json` matching the schema, then sends a SendMessage referencing the path. Lead refuses anything missing fields — structured only.

### Lead → QA

Only fires when **all Builders** have submitted valid handoffs. Lead forwards to QA:
- The spec
- All Builder handoff JSON paths
- The dev server start command(s)
- The deployed-URL-or-localhost pair to visually verify
- Required report format (see templates/qa-report.md)

### QA → Lead

QA writes `.agent-team/<run-id>/qa/report.md` with three sections (GATES, VISUAL, REGRESSION) plus a final VERDICT line (`ship` or `fix:[items]`). Sends SendMessage referencing the path.

If `fix:`, Lead extracts the specific items and loops back to the relevant Builder with **only those items** — no full rework. QA re-verifies only the flagged items on the second pass, not the whole flow.

### Lead → Deploy

Only fires on QA `ship` verdict. Lead hands Deploy:
- The feature branch name
- The commit-message draft (Lead drafts; QA artifacts inform the body)
- The gitflow targets (e.g., `develop` then `main` release)
- The repository(ies) involved
- The tag scheme (semver from spec or auto-bump)

### Deploy → Lead

Deploy executes autonomously through the gitflow, writing every operation to `.agent-team/<run-id>/deploy/timeline.md`. Two human-in-loop gates remain:
1. Before merging release PR to main
2. Before pushing the tag

Both surface via Lead's `AskUserQuestion`. After tag push, Deploy watches the production workflow and fires final SendMessage on success/failure.

## Cross-cutting concerns

Things no single agent owns but every agent must honor. Lead injects these into every spawn prompt.

**Invariants** (loaded from project's CLAUDE.md and AGENTS.md if present):
- Builder (Go): "MongoDB access through `repository.Repository` only. Never import `go.mongodb.org/...` in handlers."
- Builder (FE): "Package manager is `bun`. Never `npm/pnpm/yarn`."
- Builder (FE): "Brand violet `#7B3EFF`, Neue Plak typography. No hardcoded HEX."
- All agents: "Never log PII (response bodies, emails, full PANs)."
- Deploy: "Never force-push to main. Never `--no-verify`. Never amend published commits."

**Artifact storage** — `.agent-team/<run-id>/`:
```
.agent-team/<run-id>/
├── state.json              # lifecycle state, owned by Lead
├── spec.md                 # copy of the input spec
├── builder-fe.json         # Builder FE handoff
├── builder-be.json         # Builder BE handoff
├── qa/
│   ├── report.md
│   └── screenshots/*.png
└── deploy/
    └── timeline.md
```

The directory is git-ignored (Lead adds `.agent-team/` to `.gitignore` if missing). Survives agent death and gives an audit trail. Lead reads artifacts to verify rather than trusting messages alone.

**Idempotency** — every agent's first action is "check current state, decide if work remains." Builder re-spawned after a partial commit doesn't duplicate work; Deploy re-spawned after a merged PR doesn't try to re-merge. State is read from `state.json` and artifact files.

**Token budgeting** — each agent's context is its own. Risk: Builder reads 50 files and exhausts its window. Mitigation: Lead pre-computes the file list from spec + (if available) codegraph and includes it in Builder's spawn prompt. Builder doesn't explore.

**Failure recovery** — every retry surfaces in TaskList. No silent retries. See `references/failure-modes.md` for the five failure classes and recovery patterns.

## Lifecycle states

Tracked in `.agent-team/<run-id>/state.json`. Lead writes; QA and Deploy read.

1. `PLANNING` — spec read, team composition decided
2. `BUILDING` — Builder(s) running, handoffs not yet received
3. `QA` — Builder reports received, QA verifying
4. `FIXING` — QA found issues, looping with Builder
5. `READY` — QA shipped, awaiting Deploy spawn
6. `DEPLOYING` — feat→develop in flight, CI watching
7. `RELEASING` — develop→main release in flight
8. `DEPLOYED` — tag pushed, production workflow green
9. `FAILED:<class>` — surfaced to you with context

`/ship-resume <run-id>` re-reads `state.json` to pick up after a Claude Code restart.

## Done definition

A run is `DEPLOYED` (terminal success) when:
- All spec tasks marked `[x]` in the original spec file (Lead edits)
- All Builder test gates green (per QA's re-run, not Builder's self-report)
- All PRs merged in correct gitflow order
- Tag pushed, deploy-prod workflow successful
- PushNotification fired
- Run artifacts archived to `.agent-team/<run-id>/`

## Triggering

| Command | Phases run |
|---------|-----------|
| `/ship-spec [path]` | All four (implement → QA → deploy) |
| `/ship-branch [branch]` | Skip implement; QA + Deploy on existing branch |
| `/qa-only [branch]` | Only QA; no Deploy |
| `/ship-resume <run-id>` | Pick up from state.json |

v0.1 ships only `/ship-spec`. Others added when validated.

## Out of scope (deliberate, v0.1)

- **CI config changes** — Lead refuses spec items that modify `.github/workflows/*.yml`. Too risky for autonomous flow; comes back to user.
- **DB migrations applied to prod autonomously** — Builder writes the migration; applying stays manual.
- **Env var / secrets changes** — escalate immediately.
- **Multi-repo coordination beyond 2 repos** — single repo (FE-only or BE-only) or paired FE/BE. Three+ repos in one run is out of scope.
- **Cross-feature dependencies** — one spec, one feature. No fan-out to "and also fix this other thing."

## Validation plan

Before v0.1 is considered production-ready, validate against:
1. A trivial spec (single FE component change) → should ship in <5 minutes.
2. The pattern from example-feature (FE + BE + gitflow + tag) → should reproduce the manual flow.
3. A spec that intentionally fails at QA → confirms the fix loop works.
4. A spec that fails at CI → confirms Deploy agent's failure-classification + retry/escalate logic.

## Future iterations

- **v0.2**: `/ship-branch`, `/qa-only`, `/ship-resume`
- **v0.3**: Multi-breakpoint visual QA (parallel sub-agents within QA phase)
- **v0.4**: Auto-generation of release notes from QA artifacts
- **v0.5**: ArgoCD sync watching beyond the deploy-prod workflow exit
