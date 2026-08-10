---
name: agy-delegate
description: Delegate implementation work to the Antigravity CLI (agy) — automatically when the active Claude account is at ≥70% of its 5-hour or weekly limit (check with claude-quota), or whenever the user asks. Covers synchronous delegation (agy-run), fire-and-forget handoffs in isolated git worktrees (agy-handoff), the gate/review/merge policy (agy-gate), and resuming or reviewing parked branches.
---

# Delegating to Antigravity (agy)

## When

1. **Auto:** before sizeable implementation work, run `claude-quota --check`
   (exit 1 = active account ≥70%). Over threshold → delegate instead of
   implementing yourself. Exit 2 (unknown) → do NOT auto-delegate.
2. **Manual:** the user asks ("delegate this", "use agy", "fire a handoff").

## Synchronous (small/medium, you stay in the loop)

    agy-run [--fast] [--model SLUG] [--effort low|medium|high] [--timeout 10m] -- "PROMPT"

- stdout = the response. Exit 2 = agy quota exhausted (empty-response bug —
  report it, don't retry blindly). Exit 3 = agy needs re-login (`ag`).
- `--fast` uses the flash-tier slug from `~/.config/mows-agy/config` — use it
  for summaries/extraction/read-heavy work to preserve agy quota.
- Review the result yourself before integrating it. You are the review gate
  on this path.

## Fire-and-forget handoff (big work, zero further Claude tokens)

1. Write the contract file (this shape, verify block MANDATORY):

       # Handoff: <title>
       ## Task
       <what to build, file paths, constraints>
       ## Acceptance criteria
       - <objectively checkable bullets>
       ## Verification commands (must exit 0)
       ```verify
       <test/lint/build commands, one per line>
       ```

2. Start it (size `big` = >~3 files, >~150 LOC expected, or architectural —
   big gets a model review before merge; small merges on green verification):

       agy-handoff start --repo <abs-repo-path> --size big --task <contract-file>

3. It runs detached in tmux session `agyh-<id>`, visible in the web dashboard.
   The gate auto-runs when agy finishes: re-verification → (big) review by
   Claude-with-budget or agy on AGY_REVIEW_MODEL → auto-merge when green;
   anything red parks the branch and notifies.

## Model tiers

Pick a tier, never a hardcoded slug: default (no flag — implementation),
`--fast` (cheap sync tasks), review tier is the gate's job. Slugs live only
in `~/.config/mows-agy/config`.

## Session-start duty

If the quota context line shows an account ≥70%, or `agy-handoff list` shows
`parked`/`ready`/`STALE` entries, surface them to the user early. `ready` =
green but waiting on a manual merge; `parked` shows its reason; `STALE` =
session died (reboot?) — offer `agy-handoff resume <id>`. When you have
budget, review parked/ready branches: diff is `git -C <state>/wt diff
<base>...HEAD` (paths via `agy-handoff path <id>` and meta.json).
