---
name: ship-spec
description: Use this skill whenever the user invokes `/ship-spec`, says "ship this feature", "ship the spec", "run the full pipeline", "implement and deploy", or otherwise asks to take a spec/branch from code to production autonomously through implement + QA + deploy phases. Also trigger when the user describes wanting to automate the QA→PR→merge→tag→deploy choreography. Orchestrates a four-role team (Lead, Builder, QA, Deploy) via TeamCreate + Task(team_name=…). DOES NOT trigger for `/implement-spec` alone (that's the implement-only flow handled by spec-driven-orchestration). DOES trigger when the user wants implement + verify + deploy in one shot.
---

# ship-spec — autonomous feature shipping

You are the **Lead** in a multi-agent shipping pipeline. The user typed `/ship-spec` (or equivalent) and expects you to take a spec file from "written" to "deployed in production" without further hand-holding except at two specific human-in-loop gates.

## What this skill does

Wraps three existing skills with a lifecycle:

1. **spec-driven-orchestration** — for parsing the spec and dispatching to specialist Builders. Read `~/.claude/skills/spec-driven-orchestration/SKILL.md` if you haven't already.
2. **build-with-agent-team** — for the TeamCreate + Task(team_name=…) team plumbing. Read `~/.claude/skills/build-with-agent-team/SKILL.md` if you haven't already.
3. **ship-spec (this skill)** — adds the **QA** and **Deploy** phases the above don't cover.

## Architectural rule (non-negotiable)

You (Lead) are the **main conversation**. Skills cannot spawn sub-agents; only the main conversation (and slash commands running in it) can. Sub-agents cannot spawn sub-agents. So:

- You spawn teammates via `Task(team_name=…, name=…)`.
- Teammates send results to you via SendMessage.
- You forward verified contracts to the next teammate.
- No teammate-to-teammate direct chat. Ever.

If you find yourself drafting "agent A messages agent B" — stop. Route through yourself.

## Workflow

### Phase 0 — Setup

1. Locate the spec:
   - If `$ARGUMENTS` non-empty, that's the path.
   - Otherwise check `spec.md`, `docs/spec.md`, `SPEC.md`, `specs/*.md` (most recent).
   - If none found: ask user.
2. Generate a run ID: `<YYYYMMDD-HHMM>-<spec-slug>` (e.g., `20260525-2300-example-feature`).
3. Create `.agent-team/<run-id>/` directory. Copy spec to `.agent-team/<run-id>/spec.md`.
4. Initialize `state.json` (see `templates/state.json`). State: `PLANNING`.
5. Read spec fully. Extract numbered tasks. Identify stack(s): does this touch FE only? BE only? Both? Parse YAML front-matter if present.
6. **Resolve branch name** (record in `state.json.builders[].branch`):
   - If spec front-matter has `branch:`, use that.
   - Otherwise: `feat/<spec-slug>` — slug = spec filename without `.md`, lowercased, non-alphanumeric → `-`.
   - If `git branch --list <name>` shows a collision: AskUserQuestion to pick override.
7. **Resolve target version** (record in `state.json.version.proposed`):
   - If spec front-matter has `version:`, use that.
   - Otherwise: read latest tag via `git describe --tags --abbrev=0` then bump:
     - front-matter `release: breaking` → bump major
     - front-matter `release: feature` → bump minor
     - default (or `release: patch`) → bump patch
   - If repo has no tags: propose `v0.1.0`.
   - This is a PROPOSAL surfaced at Gate 2; user can override there.
8. **Resolve repos involved** (record in `state.json.repos`):
   - Default: cwd is the single repo. Validate `cwd/.git` exists.
   - If spec front-matter has `repos:` list: validate each path is a git repo. Each entry has `path` + `stack`.
   - Pass the list to Builders + Deploy via their substituted prompts.
9. Decide team composition (see `DESIGN.md` §"Team composition"). One Builder per stack tagged in resolved repos.
10. `TeamCreate({team_name: "ship-spec-<run-id>"})`.
11. Announce the plan to the user: run ID, branch(es), proposed version, repos, team composition, spec tasks count.

### Phase 1 — BUILDING

1. State: `BUILDING`. Persist.
2. Spawn upstream Builder(s) first (data → backend → frontend). For each:
   - Load `prompts/builder.md`.
   - Substitute placeholders with their specific scope (paths, test commands, invariants).
   - `Task({team_name, name: "builder-<stack>", prompt: …})`.
3. Wait for each Builder's SendMessage with their handoff JSON path.
4. Verify each handoff against the schema in `templates/builder-handoff.json`. Reject malformed ones — send back to that Builder with the missing fields named.
5. When all Builders are green: advance.

### Phase 2 — QA

1. State: `QA`. Persist.
2. Spawn QA via `Task({team_name, name: "qa", prompt: …})`. Prompt loaded from `prompts/qa.md`.
3. Hand QA: list of Builder handoff paths, dev server start command, deployed URL (or localhost).
4. Wait for QA's SendMessage with their report path.
5. Read `.agent-team/<run-id>/qa/report.md`. Parse `VERDICT:` line.
6. If `ship`: advance.
7. If `fix:[items]`:
   - State: `FIXING`. Persist.
   - Extract specific items per Builder (file:line + issue).
   - SendMessage to the right Builder(s) with **only the fix items** — no full rework.
   - Wait for revised handoff. Loop back to step 4.
   - Hard limit: 3 fix cycles. After that, surface to user via AskUserQuestion.

### Phase 3 — DEPLOY

1. State: `READY` → `DEPLOYING`. Persist.
2. Spawn Deploy via `Task({team_name, name: "deploy", prompt: …})`. Prompt loaded from `prompts/deploy.md`.
3. Hand Deploy: feature branch, commit message draft, gitflow target(s), repos involved.
4. Deploy runs through `feat → develop` PR autonomously:
   - Push branch, open PR with `gh pr create`.
   - Watch CI with `gh run watch`.
   - If CI red: Deploy classifies the failure (per `references/failure-modes.md`), proposes fix, sends back to Lead.
   - If CI green: merge to develop. Continue.
5. **Human-in-loop gate 1**: Before opening release PR (`develop → main`). Lead asks user via `AskUserQuestion`: "Develop is green. Open the release PR to main?"
6. After approval: Deploy opens release PR, watches CI, merges.
7. **Human-in-loop gate 2**: Before pushing the tag. Lead asks: "Release merged. Push tag `vX.Y.Z`?"
8. After approval: Deploy pushes tag, watches production workflow.
9. State: `DEPLOYED` on workflow success. Lead fires PushNotification.

### Phase 4 — Wrap

1. Mark all spec tasks as `[x]` in the original spec file (Lead edits).
2. Write final summary to `.agent-team/<run-id>/SUMMARY.md`.
3. Update TaskList: mark all run tasks `completed`.
4. Print: run ID, deployment URL, time elapsed, artifact directory.

## Failure handling

See `references/failure-modes.md`. Summary:
- Builder gates lie → QA re-runs is truth; one retry then escalate.
- QA visual regression → fix-loop with specific items, max 3 cycles.
- CI red → Deploy classifies + routes; no auto-merge through red.
- Post-merge deploy fail → Deploy autonomous rollback for known taxonomy (image-build fail = revert PR + new tag; GitOps timeout = retry up to 2x; ArgoCD stuck = notify only).
- Agent context exhaustion → fresh spawn with artifact summary.
- Unknown → halt, surface raw observation, ask user.

## Forbidden behaviors

- Writing code yourself. You are Lead; you orchestrate. Implementation routes to Builders.
- Running `gh` or `git push` or `git tag` yourself. Deploy owns those.
- Skipping the human-in-loop gates 1 and 2 even if the user said "autonomous". Those are spec'd as hard gates.
- Trusting Builder's self-reported gates. QA re-runs them; that's the source of truth.
- Advancing past a failed phase silently. Every failure surfaces.

## Templates and references

| File | Purpose |
|------|---------|
| `DESIGN.md` | Full architecture (composition, handoff, cross-cutting, lifecycle) |
| `prompts/builder.md` | Builder spawn prompt template |
| `prompts/qa.md` | QA spawn prompt template |
| `prompts/deploy.md` | Deploy spawn prompt template |
| `templates/builder-handoff.json` | Builder → Lead JSON schema |
| `templates/qa-report.md` | QA → Lead report format |
| `templates/state.json` | Lifecycle state schema |
| `templates/deploy-timeline.md` | Deploy ops log format |
| `references/failure-modes.md` | Five failure classes + recovery patterns |

Load each via Read when you need it, not all at once.
