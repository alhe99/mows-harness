# QA Report — run <run-id>

> Written by the QA teammate. Lead parses the `VERDICT:` line and either advances to DEPLOY (`ship`) or loops back to Builder with the listed fix items (`fix:`).

## GATES

| Gate | Command | Status | Duration | Notes |
|------|---------|--------|----------|-------|
| typecheck | `<exact cmd>` | PASS / FAIL | Ns | |
| lint | `<exact cmd>` | PASS / FAIL | Ns | |
| test | `<exact cmd>` | PASS / FAIL (N/M passing) | Ns | |
| build | `<exact cmd>` | PASS / FAIL | Ns | (optional) |

If Builder claimed PASS and QA's re-run shows FAIL, add a `Builder reported PASS but QA observed FAIL` row in Notes — Lead will flag.

## VISUAL

For each user-facing spec task:

- **Task N — `<title>`**: ✅ | ❌
  - Observation: `<one-line>`
  - Screenshot: `.agent-team/<run-id>/qa/screenshots/<task-N>-<state>.png`

Common findings to look for:
- Casing inconsistency ("severity" vs "Severity")
- Hardcoded HEX where a design token should be (`#FF0000` instead of `text-destructive`)
- Missing translations / raw IDs shown to users
- Spacing imbalance vs sibling components
- Empty states / loading states absent or flickering
- Modal/overlay z-index issues
- Keyboard focus rings missing
- aria-* attributes missing on interactive elements

## REGRESSION

For each surface area touched, walk one adjacent flow:

- **Adjacent flow — `<name>`**: ✅ | ❌
  - Observation: `<one-line>`
  - Screenshot: (only if regression found)

## CONSOLE

```
- No error-level messages.

OR

- ERROR: <message> at <url>:<line>
  - Introduced by this change? yes/no
  - Reproducer: <steps>
```

## NETWORK

(Optional — fill only if the change affected network behavior)

- New endpoints called: <list>
- Endpoints returning non-2xx: <list with status codes>
- Suspicious timing (>3s on a path that should be <1s): <list>

## VERDICT

```
VERDICT: ship
```

OR, if there are blockers:

```
VERDICT: fix:
- <file>:<line> — <issue, one line>
- <file>:<line> — <issue, one line>
```

OR, after 3 fix cycles still showing the same item:

```
VERDICT: stalled
```

(Lead will escalate to user.)

---

## Self-checks before writing this report

- [ ] All Builder-reported gates re-run by QA itself (not trusted)
- [ ] Every user-facing spec task has a corresponding VISUAL entry
- [ ] At least one REGRESSION flow walked per surface area
- [ ] Console messages inspected with `mcp__chrome-devtools__list_console_messages`
- [ ] Screenshots saved to `.agent-team/<run-id>/qa/screenshots/`
- [ ] VERDICT line is exactly `VERDICT: ship` or `VERDICT: fix:` followed by items, or `VERDICT: stalled`
