# Failure Modes & Recovery

Five failure classes the orchestrator must handle. Each has a defined response so Lead doesn't improvise.

## 1. Builder test gates red (the lie case)

**Symptom**: Builder's handoff JSON reports `tests.typecheck.exit: 0` but QA's re-run shows exit 1.

**Response**:
- Lead records the mismatch in TaskList.
- Lead extracts the actual failing output from QA's report.
- SendMessage that Builder: include the failing command output verbatim + "your handoff reported PASS but QA's re-run shows FAIL — fix and re-submit". One retry.
- On second failure: escalate to user via AskUserQuestion: "Builder claims FE tests pass; QA's re-run disagrees. View logs / abort / override?"

**Don't**: silently accept Builder's claim. Don't loop indefinitely; one retry then escalate.

## 2. QA visual regression / casing / spacing

**Symptom**: QA `VERDICT: fix:` with specific items (file:line + issue).

**Response**:
- Lead bucks the items by responsible Builder (FE items → builder-fe, BE items → builder-be).
- SendMessage each Builder with their bucket only: "QA flagged these items. Address them. Don't rework anything else."
- On re-handoff: Lead doesn't re-spawn QA — sends QA the updated handoff and a "re-verify ONLY these items + adjacent regression" instruction.
- Hard limit: 3 fix cycles. QA's 4th `VERDICT: fix:` becomes `VERDICT: stalled` and Lead escalates.

**Don't**: send Builder back with "QA found issues, fix them" without specifics. Don't have QA do a full re-verify each pass.

## 3. CI red on PR (feature or release)

**Symptom**: Deploy's `gh run watch` returns non-zero.

**Response**: Deploy classifies the failure from the workflow log. Categories:

| Category | Recovery |
|----------|----------|
| Lint / format only | Autonomous: fix via project's lint command, commit + push. (Class `release-pr-ci-red-recoverable`.) Up to 1 retry. |
| Test failure introduced by this branch | Route to Builder: "CI failing because of <test>: <output>". Builder fixes. Deploy re-runs CI on push. |
| Test failure NOT in this branch (flaky / pre-existing) | Document in timeline. SendMessage Lead: "CI red on pre-existing flaky test <name>. Re-run?". Lead asks user. |
| Build failure (compile / TypeScript / Go) | Route to Builder. |
| Workflow config error (`.github/workflows/*.yml` broken) | Halt. Out of autonomous scope. Lead escalates. |
| External dependency (package registry, secret expired) | Halt. Escalate to user. |

**Don't**: merge through red. Don't re-run CI more than once for the same reason.

## 4. Post-merge deploy fail (worst case)

**Symptom**: Code is on `main`, tag is pushed, but `deploy-prod` workflow exit ≠ 0.

**Response per the autonomous taxonomy** Lead granted Deploy in this session:

| Class | Recovery (autonomous) |
|-------|----------------------|
| `image-build-fail` | Revert PR + new tag (`v<X.Y.Z+1>-revert`). PushNotification to user with both URLs. |
| `gitops-tag-update-timeout` | Retry workflow up to 2x. Then escalate. |
| `argocd-sync-stuck` | Notify only. Ops-team call. |
| `release-pr-ci-red-recoverable` | Fix commit (lint-only), re-trigger CI. 1 retry. |

For ANY failure outside the taxonomy: Deploy stops, writes raw observation to `deploy/timeline.md`, SendMessage Lead, waits. Lead surfaces to user with both rollback and forward-fix options via AskUserQuestion.

**Don't**: try to deploy fixes by hand (no `kubectl`, no manual Cloudflare ops). Don't force-push to main. Don't tag a v0.3.1 hot-fix without going through develop first.

## 5. Agent context exhaustion

**Symptom**: An agent sends a message like "context low, summarizing state" or repeatedly fails to make progress (silent loops, repeating the same action).

**Response**:
- Lead reads that agent's artifact directory in `.agent-team/<run-id>/`.
- Lead extracts a summary of: what's done, what remains, what files are involved.
- Lead spawns a fresh agent of the same role (`Task` with same name appended `-v2`) and prompt that includes the summary + "resume from this state".
- Old agent terminates (Lead can use TaskStop / SendMessage to signal end).
- State.json records the agent swap.

**Don't**: keep pushing more context into an exhausted agent. Don't try to "summarize on their behalf" via SendMessage — context already exists in artifacts, just hand them off properly.

## Anything unknown

**Symptom**: Failure pattern not in the catalog above.

**Response**:
- Halt the lifecycle. Don't advance phases.
- Write the raw observation to `state.json` failure field + a freeform `unknown_failure.md` in the run dir.
- AskUserQuestion to user with the full context: "Unknown failure at phase X: <observation>. How should we proceed?"
- Options: (1) human-fix-then-resume, (2) abort run, (3) view artifacts and decide.

**Never improvise destructive operations** as a way to make an unknown failure go away. That's the worst class of bug — silent destruction of work in pursuit of "making the orchestrator look successful".

## Failure-class field naming

When recording failures, use the exact strings the schema expects:

```
builder-lie
qa-fix-cycles-exceeded
qa-stalled
ci-red-test
ci-red-build
ci-red-workflow-config
ci-red-external-dep
image-build-fail
gitops-tag-update-timeout
argocd-sync-stuck
release-pr-ci-red-recoverable
context-exhaustion
unknown
```

Consistent strings let dashboards / metrics aggregate later.
