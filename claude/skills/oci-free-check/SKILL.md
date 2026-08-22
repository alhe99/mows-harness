---
name: oci-free-check
description: Audit the Oracle Cloud tenancy to confirm everything is still Always Free and $0.00 — checks actual spend, A1 OCPU/RAM limits, the 200 GB storage cap, volume VPU tier, backups, every billable service type, the budget tripwire, and idle-reclamation risk. Use when the user asks whether their OCI VM is still free, whether anything is billing, whether they might get charged, or asks for a free-tier / billing / cost check on Oracle Cloud.
---

# OCI Always Free audit

Run the script. It does the whole audit deterministically — don't re-derive the
checks by hand, and don't substitute ad-hoc `oci` calls.

```bash
~/.claude/skills/oci-free-check/check.py
```

Takes ~40s (it makes ~20 OCI API calls plus one SSH probe). Prerequisite: the `oci` CLI must be installed and authenticated (`oci setup config`).

## Exit codes

| Code | Meaning | What to do |
|------|---------|------------|
| `0` | All clear — inside every limit, $0.00, not idle | Report the summary. Done. |
| `1` | Free, but warnings | Read each warning. Usually an un-verifiable check (missing permission, unreachable SSH), not a real cost. Say which. |
| `2` | **Something is billable or over limit** | Lead with this. Name the specific resource and what it costs. Do not bury it under the passing checks. |

## Config (env vars)

- `OCI_TENANCY` — **required**, your tenancy OCID; the script exits immediately if unset
- `OCI_REGION` — optional, defaults `us-ashburn-1` (a common Always Free home region; override if yours differs)
- `OCI_SSH_ALIAS` — optional, SSH alias for the live utilization probe (define it in `~/.ssh/config`); the probe is skipped if unset

## The two constraints, and why they oppose each other

This is the part that's easy to get backwards:

- **Always Free caps** are an *upper* bound on allocation: 4 OCPU / 24 GB for A1,
  200 GB combined boot+block storage, 5 volume backups, VPU 10.
- **Idle reclamation** is a *lower* bound on utilization. Oracle may reclaim an
  Always Free instance idle for 7 days, where idle means CPU P95 **and** network
  **and** memory (A1 shapes only) are **all** below 20% **of what you allocated**.

Because the idle threshold is a percentage of allocation, **upsizing makes
reclamation more likely.** The same workload on 24 GB instead of 12 GB halves its
memory percentage. So "upgrade to use more of the free tier" is usually the wrong
advice — it can push a healthy instance under the idle bar.

It is an AND across the three metrics, so clearing **any single one** is enough.

Storage is *not* an idle metric, so growing storage is the one upgrade with no
reclamation downside.

## Gotchas already encoded in the script

Don't "simplify" these back out — each one caused a wrong answer during the
original audit:

- **Empty stdout ≠ error.** The OCI CLI prints *nothing* (not `{"data":[]}`) for an
  empty list. Conflating that with a failed call produces a false all-clear. The
  script only treats a non-zero exit as "couldn't look", and reports that as a
  warning rather than a pass.
- **Budget commands are inconsistently nested.** `oci budgets budget budget list`
  (triply) for budgets, but `oci budgets budget alert-rule list` (doubly) for rules.
  Shorter spellings error in a way that resembles an empty list.
- **The OCI MCP `list_buckets` tool is broken** — it ignores its `namespace`
  argument and sends the tenancy OCID, returning 404 NamespaceNotFound. Always get
  the namespace via `oci os ns get` and list buckets through the CLI.
- **Boot volumes are per-AD**, so the script iterates every availability domain and
  de-duplicates by OCID. Querying one AD silently undercounts storage.
- **An alert rule with empty `recipients` is a real failure**, not cosmetic — the
  budget fires into the void. This was the actual state when first audited.
- **Service limits are not the free tier.** `oci limits value list` reports the
  *region's* capacity (e.g. 750 A1 cores), which says nothing about your Always
  Free entitlement. Never cite it as proof of tier.

## What the script cannot determine

**Account tier (Free Tier vs Pay As You Go).** The subscription APIs aren't exposed
to this API user. This matters, because on a non-upgraded account Oracle has no
authorization to charge the card at all — the failure mode is resource suspension,
not a bill. A charge only becomes possible after an explicit PAYG upgrade.

If the user wants certainty on tier, they must check the Console:
**Billing → Upgrade and Payment**. Don't claim to have verified it from the API.

## Reporting

Lead with the verdict and the spend figure. Keep it short when it's clean — the
value is the check having run, not a wall of green ticks. On exit 2, name the
offending resource, say what it bills, and offer to remove it.

Mention the metered-usage line when present: it proves metering is live and priced
at zero, which is much stronger evidence than an absent cost row (which could just
mean the ~24h billing lag hasn't caught up).
