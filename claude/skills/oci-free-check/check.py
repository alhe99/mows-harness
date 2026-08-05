#!/usr/bin/env python3
"""OCI Always Free compliance audit.

Exit: 0 = all clear, 1 = warnings to review, 2 = something billable / over limit.

Two independent constraints are checked, and they pull OPPOSITE ways:
  UPPER bound -- Always Free caps: 4 OCPU / 24 GB A1, 200 GB storage, 5 backups.
  LOWER bound -- idle reclamation: Oracle may reclaim an Always Free instance idle
    for 7 days, where idle = CPU P95 AND network AND memory (A1 only) ALL below
    20% *of what you allocated*. A BIGGER shape is therefore EASIER to fail:
    same workload on double the RAM halves your percentage.

Written in Python rather than shell on purpose: the audit needs to parse JSON and
build report lines, and nesting f-strings inside shell quoting silently produced
"0 GB of storage" on a box with a 130 GB volume. A false all-clear is worse than
no audit, so the quoting hazard is removed instead of worked around.
"""
import json
import os
import shutil
import subprocess
import sys
from datetime import datetime, timedelta, timezone

TENANCY = os.environ.get("OCI_TENANCY", "")
REGION = os.environ.get("OCI_REGION", "us-ashburn-1")
SSH_ALIAS = os.environ.get("OCI_SSH_ALIAS", "")

if not TENANCY:
    print("✗ OCI_TENANCY is not set. Set it to your tenancy OCID (OCI Console -> "
          "Profile menu -> Tenancy, or `oci iam compartment list --query \"data[0].\\\"compartment-id\\\"\"`).")
    sys.exit(2)

MAX_OCPU, MAX_MEM, MAX_STORAGE, MAX_BACKUPS, FREE_VPU = 4, 24, 200, 5, 10
HOURS_31 = 744          # worst-case month for allowance math
FREE_OCPU_HRS = 3000
FREE_GB_HRS = 18000
IDLE_PCT = 20

DEAD = {"TERMINATED", "TERMINATING", "DELETED", "FAILED"}
C = sys.stdout.isatty()
G, Y, R, B, X = (("\033[32m", "\033[33m", "\033[31m", "\033[1m", "\033[0m") if C else ("",) * 5)

fails: list[str] = []
warns: list[str] = []


def ok(m):   print(f"  {G}✓{X} {m}")
def warn(m): print(f"  {Y}!{X} {m}"); warns.append(m)
def bad(m):  print(f"  {R}✗{X} {m}"); fails.append(m)
def hdr(m):  print(f"\n{B}{m}{X}")
def info(m): print(f"     {m}")


def oci(*args, want_json=True):
    """Run the OCI CLI. Returns (data, error).

    The CLI prints NOTHING (not {"data": []}) for an empty list -- verified against
    the MCP API, which returns [] for the same query. So blank stdout means zero
    rows, and only a non-zero exit means we genuinely failed to look. Conflating
    those two is how an audit reports a false all-clear.
    """
    cmd = ["oci", *args, "--region", REGION]
    try:
        p = subprocess.run(cmd, capture_output=True, text=True, timeout=120)
    except subprocess.TimeoutExpired:
        return None, "timeout"
    except FileNotFoundError:
        return None, "oci CLI not found"
    if p.returncode != 0:
        err = (p.stderr or p.stdout).lower()
        if "no such command" in err or "unrecognized" in err:
            return None, "unsupported CLI subcommand"
        if "notauthor" in err or "forbidden" in err:
            return None, "not authorized"
        return None, (p.stderr or p.stdout).strip().splitlines()[-1][:90] if (p.stderr or p.stdout).strip() else "error"
    if not p.stdout.strip():
        return ([] if want_json else ""), None
    if not want_json:
        return p.stdout.strip(), None
    try:
        d = json.loads(p.stdout).get("data")
    except Exception as e:
        return None, f"unparseable: {e}"
    if d is None:
        return [], None
    if isinstance(d, dict):
        return d.get("items", d), None
    return d, None


def live(rows):
    return [r for r in rows if (r or {}).get("lifecycle-state") not in DEAD]


def iso(dt):
    return dt.strftime("%Y-%m-%dT%H:%M:%SZ")


print(f"═══ OCI ALWAYS FREE AUDIT — {iso(datetime.now(timezone.utc))} ═══")
print(f"tenancy: …{TENANCY[-12:]}   region: {REGION}")

# ── 1. region scope ────────────────────────────────────────────────────────────
hdr("1. REGION SCOPE  (Always Free applies ONLY in the home region)")
regs, err = oci("iam", "region-subscription", "list", "--tenancy-id", TENANCY)
if err:
    warn(f"could not list region subscriptions: {err}")
else:
    extra = 0
    for r in regs:
        home = r.get("is-home-region")
        info(("HOME  " if home else "EXTRA ") + str(r.get("region-name")))
        if not home:
            extra += 1
    if extra == 0:
        ok("only the home region is subscribed — nowhere for a paid resource to hide")
    else:
        warn(f"{extra} non-home region(s) subscribed — Always-Free-shaped resources there STILL BILL")

# ── 2. actual spend ────────────────────────────────────────────────────────────
hdr("2. ACTUAL SPEND  (the number that matters)")
now = datetime.now(timezone.utc)
m0 = now.replace(day=1, hour=0, minute=0, second=0, microsecond=0)
m1 = (m0 + timedelta(days=32)).replace(day=1)
cost, err = oci("usage-api", "usage-summary", "request-summarized-usages",
                "--tenant-id", TENANCY, "--granularity", "MONTHLY", "--query-type", "COST",
                "--time-usage-started", iso(m0), "--time-usage-ended", iso(m1))
if err:
    warn(f"could not read cost: {err}")
else:
    total = sum(i.get("computed-amount") or 0 for i in cost)
    cur = next((i.get("currency") for i in cost if i.get("currency")), "USD")
    if total <= 0.0001:
        ok(f"month-to-date cost: ${total:.4f} {cur}")
    else:
        bad(f"month-to-date cost: ${total:.4f} {cur} — SOMETHING IS BILLING")
        for i in cost:
            if i.get("computed-amount"):
                info(f"{i.get('service')}: {i['computed-amount']:.4f}")

# metering proves the audit is live rather than just missing data
use, err = oci("usage-api", "usage-summary", "request-summarized-usages",
               "--tenant-id", TENANCY, "--granularity", "DAILY", "--query-type", "USAGE",
               "--time-usage-started", iso(now - timedelta(days=3)),
               "--time-usage-ended", iso(now + timedelta(days=1)))
if not err:
    agg: dict[str, float] = {}
    for i in use:
        u = i.get("unit") or "?"
        agg[u] = agg.get(u, 0) + (i.get("computed-quantity") or 0)
    if agg:
        info("metered (last 3d): " + ", ".join(f"{v:.1f} {k}" for k, v in sorted(agg.items())))
    else:
        info("metering: no rows yet (billing lags ~24h)")

# ── 3. compute ─────────────────────────────────────────────────────────────────
hdr(f"3. COMPUTE  (A1 cap {MAX_OCPU} OCPU / {MAX_MEM} GB)")
inst, err = oci("compute", "instance", "list", "-c", TENANCY, "--all")
a1o = a1m = 0.0
if err:
    warn(f"could not list instances: {err}")
else:
    rows = live(inst)
    if not rows:
        info("(no instances)")
    for i in rows:
        sc = i.get("shape-config") or {}
        o = sc.get("ocpus") or 0
        m = sc.get("memory-in-gbs") or 0
        info(f"{str(i.get('display-name'))[:16]:<18}{str(i.get('shape')):<22}"
             f"{o:g} OCPU / {m:g} GB  {i.get('lifecycle-state')}")
        if "A1" in str(i.get("shape")):
            a1o += o
            a1m += m
    oh, mh = a1o * HOURS_31, a1m * HOURS_31
    info(f"A1 total: {a1o:g} OCPU / {a1m:g} GB")
    info(f"allowance: {oh:.0f}/{FREE_OCPU_HRS} OCPU-hrs ({oh/FREE_OCPU_HRS*100:.0f}%), "
         f"{mh:.0f}/{FREE_GB_HRS} GB-hrs ({mh/FREE_GB_HRS*100:.0f}%)  [31-day month]")
    if a1o <= MAX_OCPU and a1m <= MAX_MEM:
        ok("within A1 free limits")
    else:
        bad(f"A1 allocation {a1o:g} OCPU / {a1m:g} GB EXCEEDS free {MAX_OCPU}/{MAX_MEM}")
    if oh > FREE_OCPU_HRS or mh > FREE_GB_HRS:
        bad("24/7 run-rate would EXCEED the monthly OCPU/GB-hour allowance")
    elif oh > FREE_OCPU_HRS * 0.95:
        warn(f"run-rate is {oh/FREE_OCPU_HRS*100:.0f}% of the OCPU-hour allowance — under 5% margin")

# ── 4. storage ─────────────────────────────────────────────────────────────────
hdr(f"4. STORAGE  (boot + block combined cap {MAX_STORAGE} GB, VPU must be {FREE_VPU})")
ads, err = oci("iam", "availability-domain", "list", "-c", TENANCY)
total_gb = 0
vpu_bad = 0
if err or not ads:
    warn(f"could not list availability domains: {err or 'none returned'} — storage NOT verified")
else:
    seen = set()
    for ad in [a.get("name") for a in ads]:
        for kind in ("boot-volume", "volume"):
            vols, e = oci("bv", kind, "list", "-c", TENANCY, "--availability-domain", ad, "--all")
            if e:
                warn(f"could not list {kind} in {ad}: {e}")
                continue
            for v in live(vols):
                if v.get("id") in seen:
                    continue
                seen.add(v.get("id"))
                sz = v.get("size-in-gbs") or 0
                vpu = v.get("vpus-per-gb")
                total_gb += int(sz)
                if vpu is not None and int(vpu) != FREE_VPU:
                    vpu_bad += 1
                info(f"{kind:<12}{str(v.get('display-name'))[:30]:<32}{int(sz):>4} GB  VPU={vpu}")
    info(f"total: {total_gb} GB / {MAX_STORAGE} GB  (headroom {MAX_STORAGE - total_gb} GB)")
    if total_gb == 0:
        warn("storage total came back 0 GB — suspicious, verify manually")
    elif total_gb <= MAX_STORAGE:
        ok(f"storage within free limit ({total_gb}/{MAX_STORAGE} GB)")
    else:
        bad(f"storage {total_gb} GB EXCEEDS the {MAX_STORAGE} GB free allowance")
    if vpu_bad == 0:
        ok(f"all volumes at VPU {FREE_VPU} (free performance tier)")
    else:
        bad(f"{vpu_bad} volume(s) above VPU {FREE_VPU} — higher performance BILLS")

nb = 0
for sub in ("backup", "boot-volume-backup"):
    b, e = oci("bv", sub, "list", "-c", TENANCY, "--all")
    if e:
        warn(f"could not list {sub}: {e}")
    else:
        nb += len(live(b))
if nb <= MAX_BACKUPS:
    ok(f"volume backups: {nb} / {MAX_BACKUPS}")
else:
    bad(f"volume backups {nb} exceed the {MAX_BACKUPS} free")

# ── 5. billable services ───────────────────────────────────────────────────────
hdr("5. BILLABLE SERVICES  (all must be zero)")
CHECKS = [
    ("load balancers",      ["lb", "load-balancer", "list", "-c", TENANCY, "--all"]),
    ("network LBs",         ["nlb", "network-load-balancer", "list", "-c", TENANCY, "--all"]),
    ("NAT gateways",        ["network", "nat-gateway", "list", "-c", TENANCY, "--all"]),
    ("autonomous DBs",      ["db", "autonomous-database", "list", "-c", TENANCY, "--all"]),
    ("DB systems",          ["db", "system", "list", "-c", TENANCY, "--all"]),
    ("OKE clusters",        ["ce", "cluster", "list", "-c", TENANCY, "--all"]),
    ("reserved public IPs", ["network", "public-ip", "list", "-c", TENANCY, "--scope", "REGION", "--all"]),
]
# Object storage needs the namespace. Note the OCI MCP tool ignores its namespace
# argument and sends the tenancy OCID instead (404 NamespaceNotFound), so the CLI
# is the only reliable path here.
ns, nserr = oci("os", "ns", "get", "--query", "data", "--raw-output", want_json=False)
if ns and not nserr:
    CHECKS.append((f"object buckets (ns {ns})",
                   ["os", "bucket", "list", "--namespace", ns, "-c", TENANCY, "--all"]))
else:
    warn(f"object storage namespace lookup failed ({nserr}) — buckets NOT verified")

for label, args in CHECKS:
    rows, e = oci(*args)
    if e:
        warn(f"{label}: could not check ({e})")
    else:
        n = len(live(rows))
        ok(f"{label}: 0") if n == 0 else bad(f"{label}: {n} — THIS BILLS")

# ── 6. budget tripwire ─────────────────────────────────────────────────────────
hdr("6. BUDGET TRIPWIRE")
# The nesting here is genuinely inconsistent and both spellings are needed:
#   budgets budget budget list      <- budgets (TRIPLY nested)
#   budgets budget alert-rule list  <- alert rules (doubly nested)
# Neither shorter form exists; each errors in a way that resembles an empty list.
buds, err = oci("budgets", "budget", "budget", "list", "-c", TENANCY, "--all")
if err:
    warn(f"could not list budgets: {err}")
elif not buds:
    warn("no budget configured — create one so any real spend alerts you")
else:
    for b in buds:
        info(f"{b.get('display-name')}: ${b.get('amount'):g}/{b.get('reset-period')} "
             f"state={b.get('lifecycle-state')} spend={b.get('actual-spend')}")
        # The command is `budgets budget alert-rule` -- doubly nested.
        # `oci budgets alert-rule` does not exist and its error is easy to mistake
        # for an empty list, which would hide a budget that has no tripwire at all.
        rules, e = oci("budgets", "budget", "alert-rule", "list", "--budget-id", b["id"], "--all")
        if e:
            warn(f"could not read alert rules: {e}")
        elif not rules:
            bad(f"budget '{b.get('display-name')}' has NO alert rule — it will never warn you")
        else:
            for a in rules:
                pct = a.get("threshold-type") == "PERCENTAGE"
                thr = a.get("threshold")
                fires = f"${thr/100*float(b.get('amount') or 0):.2f}" if pct else f"${thr:.2f}"
                info(f"rule {a.get('display-name')}: {a.get('type')} @ "
                     f"{thr:g}{'%' if pct else ' USD'} → fires at {fires}")
                rec = (a.get("recipients") or "").strip()
                if rec:
                    ok(f"recipients: {rec}")
                else:
                    bad("alert rule has NO recipients — the alarm fires into the void")

# ── 7. idle reclamation ────────────────────────────────────────────────────────
hdr(f"7. IDLE-RECLAMATION RISK  (need ONE metric >{IDLE_PCT}% of allocation, 7-day window)")
info(f"Oracle reclaims Always Free instances idle 7d where CPU-P95 AND network AND")
info(f"memory (A1 only) are ALL under {IDLE_PCT}%. Clearing any single one is enough.")
if not shutil.which("ssh"):
    warn("ssh not available — skipped live utilization check")
elif not SSH_ALIAS:
    warn("OCI_SSH_ALIAS not set — skipped live utilization check")
else:
    probe = ("free -m | awk 'NR==2{print $3, $2}'; "
             "awk '{print $1}' /proc/loadavg; nproc")
    try:
        p = subprocess.run(["ssh", "-o", "BatchMode=yes", "-o", "ConnectTimeout=8",
                            SSH_ALIAS, probe],
                           capture_output=True, text=True, timeout=30)
    except Exception as e:
        p = None
        warn(f"ssh probe failed: {e}")
    if p and p.returncode == 0:
        try:
            lines = p.stdout.split()
            mu, mt, load, nc = float(lines[0]), float(lines[1]), float(lines[2]), float(lines[3])
            mpct, cpct = mu / mt * 100, load / nc * 100
            info(f"memory : {mu:.0f} MB / {mt:.0f} MB = {mpct:.0f}%   (bar {mt*IDLE_PCT/100:.0f} MB)")
            info(f"cpu now: load {load:g} on {nc:.0f} core(s) = {cpct:.0f}%   (instantaneous, not P95)")
            if mpct > IDLE_PCT or cpct > IDLE_PCT:
                which = "memory" if mpct > IDLE_PCT else "cpu"
                ok(f"clears the {IDLE_PCT}% bar on {which} — not idle")
            else:
                warn(f"every metric is under {IDLE_PCT}% — reclamation risk after 7 idle days. "
                     f"Keep >{mt*IDLE_PCT/100:.0f} MB resident, or add real load")
        except Exception as e:
            warn(f"could not parse utilization: {e}")
    elif p:
        warn(f"ssh alias '{SSH_ALIAS}' unreachable — skipped live check (set OCI_SSH_ALIAS)")

# ── verdict ────────────────────────────────────────────────────────────────────
hdr("VERDICT")
if fails:
    print(f"  {R}{len(fails)} FAILURE(S), {len(warns)} warning(s) — "
          f"something is billable or over limit{X}")
    for f in fails:
        print(f"    ✗ {f}")
    sys.exit(2)
if warns:
    print(f"  {Y}ALL FREE, with {len(warns)} warning(s) to review{X}")
    for w in warns:
        print(f"    ! {w}")
    sys.exit(1)
print(f"  {G}ALL CLEAR — everything inside Always Free, $0.00, not idle{X}")
sys.exit(0)
