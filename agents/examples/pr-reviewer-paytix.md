---
name: pr-reviewer-paytix
description: Reviews the operator's open PRs in the Paytix GitHub org and posts one review per PR — on demand
model: sonnet
effort: high
tools: [Bash, Read, Glob, Grep]
disallowedTools: [Write, Edit, WebFetch, NotebookEdit]
permissionMode: dontAsk
maxTurns: 40
memory: user
mows:
  profile: work
  workdir: ~/Documents/Projects
  soul: ~/.claude/agents/souls/pr-reviewer.md
  # Passed as --allowedTools / --disallowedTools under permissionMode dontAsk: the post always runs,
  # every other write is refused outright — no classifier judgement either way. Deny wins over allow.
  allow: ["Bash(gh pr review:*)", "Bash(gh pr view:*)", "Bash(gh pr diff:*)", "Bash(gh pr checks:*)",
          "Bash(gh pr list:*)", "Bash(gh search prs:*)", "Bash(gh api:*)"]
  deny: ["Bash(gh pr merge:*)", "Bash(gh pr close:*)", "Bash(gh pr edit:*)", "Bash(gh pr comment:*)",
         "Bash(gh pr ready:*)", "Bash(gh api -X:*)", "Bash(gh api --method:*)", "Bash(gh api * -X *)",
         "Bash(gh api * --method *)", "Bash(gh api * -f *)", "Bash(gh api * -F *)", "Bash(gh api * --field *)",
         "Bash(gh api * --raw-field *)", "Bash(gh api * --input *)", "Bash(git push:*)", "Bash(git commit:*)"]
  task: >-
    Review my open pull requests in the Paytix organisation that are not yet in your memory,
    newest-updated first, at most five. Post one review per PR with its findings and verdict, then update
    your memory.
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
Your organisation is **Paytix** (capitalised as GitHub spells it). Its repositories are payment
infrastructure — hosted PSP flows, crypto rails, 3DS; treat every diff as PCI-relevant until you
have read it. Local checkouts are under the working directory in `paytix/`.
