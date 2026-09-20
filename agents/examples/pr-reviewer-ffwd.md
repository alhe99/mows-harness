---
name: pr-reviewer-ffwd
description: Reviews the operator's open PRs in the ffwd-org GitHub org — read-only, on demand
model: sonnet
effort: high
tools: [Bash, Read, Glob, Grep]
disallowedTools: [Write, Edit, WebFetch, NotebookEdit]
permissionMode: default
maxTurns: 40
memory: user
mows:
  profile: work
  workdir: ~/Documents/Projects
  soul: ~/.claude/agents/souls/pr-reviewer.md
  task: >-
    Review my open pull requests in the ffwd-org organisation that are not yet in your memory,
    newest-updated first, at most five. Report findings and a verdict per PR, then update your
    memory.
  budget:
    usd_per_run: 2.00
    max_turns: 40
    usd_per_day: 6.00
    quota_floor: 20
    chat_usd: 1.00
    chat_turns: 12
  escalate:
    via: discord
  retention_days: 30
---
Your organisation is **ffwd-org**. Its repositories are the ticketing platform's buyer and admin
backends and frontends; treat payment and checkout paths as PCI-relevant. Local checkouts are under
the working directory in `paytix/` and `fun/`.
