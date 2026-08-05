# Deploy Timeline — run <run-id>

> Deploy teammate appends one line per operation. Lead reads this to verify Deploy's reported state without trusting messages alone.

## Format

Each entry: `- <ISO timestamp> — <operation> — <result>`

Operation should be the exact bash command or `gh` invocation. Result should be: `ok`, error code + first line of stderr, or the artifact URL (PR URL, workflow URL, SHA).

## Example

```
- 2026-05-25T23:14:02Z — `git push -u origin feat/example-feature` — ok
- 2026-05-25T23:14:08Z — `gh pr create --base develop --head feat/example-feature` — PR #42 https://github.com/acme/example-api/pull/42
- 2026-05-25T23:14:12Z — `gh run watch 18234567` — running
- 2026-05-25T23:15:31Z — `gh run watch 18234567` — green (1m 19s)
- 2026-05-25T23:15:36Z — `gh pr merge 42 --squash --delete-branch` — merged at abc1234
- 2026-05-25T23:15:40Z — SendMessage to Lead — "develop merged at abc1234"
- 2026-05-25T23:18:00Z — Lead approved gate 1 — proceeding
- 2026-05-25T23:18:04Z — `gh pr create --base main --head develop --title "Release v0.3.0"` — PR #43 https://github.com/acme/example-api/pull/43
- 2026-05-25T23:18:08Z — `gh run watch 18234580` — running
- 2026-05-25T23:19:42Z — `gh run watch 18234580` — green (1m 34s)
- 2026-05-25T23:19:48Z — `gh pr merge 43 --merge` — merged at def5678
- 2026-05-25T23:19:52Z — SendMessage to Lead — "main merged at def5678, awaiting gate 2"
- 2026-05-25T23:22:14Z — Lead approved gate 2 — version v0.3.0
- 2026-05-25T23:22:20Z — `git tag v0.3.0 -m "Release v0.3.0" && git push origin v0.3.0` — ok
- 2026-05-25T23:22:25Z — `gh run watch 18234599` — running (deploy-prod.yml)
- 2026-05-25T23:23:49Z — `gh run watch 18234599` — green (1m 24s)
- 2026-05-25T23:23:54Z — SendMessage to Lead — "DEPLOYED. https://github.com/.../actions/runs/18234599"
```

## On failure

When a step fails, the line shows the exit code and Deploy adds a follow-up:

```
- 2026-05-25T23:23:49Z — `gh run watch 18234599` — failed (exit 1, build-image step)
- 2026-05-25T23:23:51Z — Deploy classified as `image-build-fail` (per autonomous taxonomy)
- 2026-05-25T23:23:55Z — `gh pr create --base main --head revert-release-v0.3.0` — PR #44
- 2026-05-25T23:24:10Z — `gh pr merge 44 --merge` — merged
- 2026-05-25T23:24:14Z — `git tag v0.3.1-revert && git push origin v0.3.1-revert` — ok
- 2026-05-25T23:25:30Z — `gh run watch 18234620` — green (1m 12s)
- 2026-05-25T23:25:34Z — SendMessage to Lead — "Rolled back v0.3.0 → v0.3.1-revert. Image build failure recorded."
```

## What to log

Every:
- `git` operation
- `gh` operation
- SendMessage you sent to Lead
- Decision point (autonomous classification, gate approval received)

## What NOT to log

- Internal thinking
- Reads (don't log `gh pr view`, `gh run list` — only operations that mutate state)
- Tool call retries that succeeded on the second attempt (just log the success)
