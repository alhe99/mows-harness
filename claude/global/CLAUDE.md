## Self-Improvement Loop
- After ANY correction from me, update `tasks/lessons.md` with the pattern
- Write rules for yourself that prevent the same mistake
- Ruthlessly iterate on these lessons until mistake rate drops
- Review lessons at session start for relevant project

## When I say "init lessons"
- Create a `tasks/` folder in the current project if it doesn't exist
- Create `tasks/lessons.md` with a header `# Lessons Learned`
- Confirm it's ready

# Memory
- Use claude-mem Layer 1 (search index) first before drilling into full observations
- When finishing a task, summarize what was done, what was learned, and what's next
- Tag architectural decisions and non-obvious patterns explicitly
# graphify
- **graphify** (`~/.claude/skills/graphify/SKILL.md`) - any input to knowledge graph. Trigger: `/graphify`
When the user types `/graphify`, invoke the Skill tool with `skill: "graphify"` before doing anything else.

<!-- CODEGRAPH_START -->
## CodeGraph

In repositories indexed by CodeGraph (a `.codegraph/` directory exists at the repo root), reach for it BEFORE grep/find or reading files when you need to understand or locate code:

- **MCP tools** (when available): `codegraph_explore` answers most code questions in one call — the relevant symbols' verbatim source plus the call paths between them. `codegraph_node` returns one symbol's source + callers, or reads a whole file with line numbers. If the tools are listed but deferred, load them by name via tool search.
- **Shell** (always works): `codegraph explore "<symbol names or question>"` and `codegraph node <symbol-or-file>` print the same output.

If there is no `.codegraph/` directory, skip CodeGraph entirely — indexing is the user's decision.
<!-- CODEGRAPH_END -->

# Spec-Driven Development

## Natural-language trigger

When the user says any of the following (case-insensitive), treat it as an invocation of the `/implement-spec` command and follow that command's full protocol:

- "implement spec.md"
- "implement the spec"
- "implement [any filename ending in .md or .spec]"
- "build from the spec"
- "build from spec"
- "execute the spec"
- "work through the spec"
- "run the spec"
- "let's implement [filename]"
- "start implementing [filename]"
- "go through the spec"
- "implement [feature] spec"

Do NOT just answer the question — invoke the full spec-driven implementation flow described in `~/.claude/commands/implement-spec.md`.

## How spec-driven mode works

1. **Locate** — find the spec file (argument or default `spec.md` / `docs/spec.md` / `SPEC.md`).
2. **Plan** — read it fully, extract numbered tasks, print the plan before touching any code.
3. **Implement** — task by task, announcing each one, implementing it, verifying it.
4. **Report** — print a completion summary listing every task and any open items.

## Spec authoring convention

A spec file should be plain Markdown. Structure it with `##` sections per feature area and use `- [ ]` task checkboxes or numbered lists for discrete requirements. Example:

```markdown
# Auth Module Spec

## Registration
- [ ] POST /auth/register accepts email + password
- [ ] Password hashed with bcrypt, cost factor 12
- [ ] Returns 201 with `{ id, email, createdAt }`
- [ ] Returns 422 if email already exists

## Login
- [ ] POST /auth/login returns signed JWT (1 h expiry)
- [ ] Returns 401 on bad credentials
```

Claude will implement each checkbox in order.

# Browser QA Journeys (VPS)

On-demand, agent-driven end-to-end web QA. Works in any project.

- Run:   `/qa run <name>`   reads ./docs/qa/journeys/<name>.md in the current project
- Init:  `/qa init`         scaffolds docs/qa/ + cookbook skeleton in a new project
- List:  `/qa list`

## Use PROACTIVELY — don't wait for /qa

In EVERY session (and subagent), when the WIP task involves a webapp, invoke the `qa` skill
without being asked:

- **UI/flow work**: the task changes UI, routing, forms, rendering, or a user flow, and a
  runnable URL exists (local dev server, staging, or prod read-only) → after implementing,
  verify in a real browser with a journey — run the matching `docs/qa/journeys/*.md`, or
  write a minimal one (copy `example.md`) and run it headless. Never claim UI work is done
  from code reading alone when a browser check is possible.
- **Visual/flow bug reports**: reproduce in the browser via a journey BEFORE fixing, and
  re-run the same journey after the fix as the proof.
- **Definition of done for frontend changes** = typecheck/lint/tests AND a passing journey.
- If auth or a human step blocks headless, use `mode: watched` and involve the user only at
  the `⏸ HUMAN` pause. Skip QA only when no URL can run (then say so explicitly).

Journeys are markdown (NL steps) driven via the chrome-devtools / playwright MCP servers
(registered at user scope, and in `mcp-interactive.json` for remote-control sessions) —
present in every project, across phone/remote-control and interactive sessions alike.
Reports land in <project>/docs/qa/. If browser tools are missing from a session, see
Troubleshooting in ~/.claude/skills/qa/SKILL.md (npx exec-bit self-heal, *-watch reconnect).

Modes (journey frontmatter `mode:`):
- headless (default) — fully automated, no display. Cap 2 concurrent (qa-precheck guard).
- watched — needs a human step (login/OAuth/takeover). The skill starts the noVNC watch-stack;
  open the SSH tunnel + http://localhost:6080/vnc.html, do the step at a `⏸ HUMAN(novnc)` pause,
  say "continue", the agent resumes on the same browser.

Never write to prod Firestore; journeys target staging/deployed URLs via `target:`.
