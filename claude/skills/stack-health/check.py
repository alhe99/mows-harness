#!/usr/bin/env python3
"""Stack-integrity health check for a self-hosted Claude Code harness box
(reference deployment: Oracle Cloud A1, aarch64).

Exit: 0 = healthy, 1 = warnings, 2 = something is down or broken.

Runs from your local machine on purpose: the HTTPS/TLS checks then come from a
genuinely external vantage point, while host-side checks go over one multiplexed SSH
connection. Billing/free-tier is a SEPARATE concern -- see the oci-free-check skill.

Written in Python, not shell: an earlier shell version of the sibling audit
silently reported "0 GB storage" on a box with a 130 GB volume because of nested
f-string quoting. A false all-clear is worse than no check.
"""
import json
import re
import shutil
import ssl
import socket
import subprocess
import sys
import os
from datetime import datetime, timezone

HOST = os.environ.get("HARNESS_SSH_HOST", "harness")
DOMAIN = os.environ.get("HARNESS_DOMAIN", "example.com")
SUBS = os.environ.get("HARNESS_SUBDOMAINS", "").split(",") if os.environ.get("HARNESS_SUBDOMAINS") else []
VHOSTS = [DOMAIN] + [f"{s}.{DOMAIN}" for s in SUBS if s]
# Discord bot instance names to look for in an extra service's gateway logs (comma-separated).
# Leave HARNESS_DISCORD_BOTS unset to skip this sub-check entirely.
DISCORD_BOTS = [b for b in os.environ.get("HARNESS_DISCORD_BOTS", "").split(",") if b]


def parse_extra_services(raw):
    """Parse HARNESS_EXTRA_SERVICES ("name:port,name2:port2") into [(name, port), ...].
    Blank input -> []. Malformed entries (no ':', non-numeric port) are skipped, not fatal.
    """
    out = []
    for entry in raw.split(","):
        entry = entry.strip()
        if not entry:
            continue
        name, _, port = entry.partition(":")
        name, port = name.strip(), port.strip()
        if name and port.isdigit():
            out.append((name, int(port)))
    return out


# Extra background services to health-check beyond the fixed set below, e.g. a Discord bot
# gateway, a webhook relay -- anything this box runs that ISN'T part of the harness itself.
# Empty by default: this repo ships no specific third-party service baked in. Format:
# "name:port,name2:port2". Each entry gets a listening-port check (section 3) and a local-
# HTTP-reachability check (section 4); section 2 additionally treats <name> as BOTH a root
# systemd --user unit name AND an npm package folder under
# /root/.nvm/versions/node/*/lib/node_modules/<name>/ -- if that layout doesn't match what
# you run, section 2's version/engine-compliance lines just report "?" and move on, the
# active-state/port/log checks still work regardless.
EXTRA_SERVICES = parse_extra_services(os.environ.get("HARNESS_EXTRA_SERVICES", ""))

SYS_UNITS = ["caddy", "oauth2-proxy", "claude-dash-lite", "claude-web-term",
             "shadcn-sandbox", "docker-user-fence", "fail2ban", "earlyoom",
             "docker", "cron", "claude-remote-work", "claude-remote-control-work"]
# ports that must be listening; 37777 is session-spawned so it's advisory only
PORTS_REQUIRED = {80: "caddy", 443: "caddy", 22: "sshd", 3005: "claude-dash-lite",
                  3111: "shadcn-sandbox", 4180: "oauth2-proxy", 7681: "ttyd"}
for _name, _port in EXTRA_SERVICES:
    PORTS_REQUIRED[_port] = _name
PORTS_ADVISORY = {37777: "claude-mem worker (spawned by a Claude session)"}
IDLE_PCT = 20

C = sys.stdout.isatty()
G, Y, R, B, X = (("\033[32m", "\033[33m", "\033[31m", "\033[1m", "\033[0m") if C else ("",) * 5)
fails, warns = [], []
def ok(m):   print(f"  {G}✓{X} {m}")
def warn(m): print(f"  {Y}!{X} {m}"); warns.append(m)
def bad(m):  print(f"  {R}✗{X} {m}"); fails.append(m)
def hdr(m):  print(f"\n{B}{m}{X}")
def info(m): print(f"     {m}")

SSH = ["ssh", "-o", "BatchMode=yes", "-o", "ConnectTimeout=10",
       "-o", "ControlMaster=auto", "-o", f"ControlPath=/tmp/.mh-%C", "-o", "ControlPersist=120"]


def sh(cmd, timeout=90):
    """Run a command on the box. Returns (stdout, err)."""
    try:
        p = subprocess.run(SSH + [HOST, cmd], capture_output=True, text=True, timeout=timeout)
    except subprocess.TimeoutExpired:
        return "", "timeout"
    if p.returncode != 0 and not p.stdout.strip():
        return "", (p.stderr or "failed").strip().splitlines()[-1][:80]
    return p.stdout.strip(), None


print(f"═══ STACK HEALTH — {datetime.now(timezone.utc).strftime('%Y-%m-%dT%H:%M:%SZ')} ═══")

# ── reachability ───────────────────────────────────────────────────────────────
out, err = sh("echo ok; uname -m; uptime -p; hostname")
if err or "ok" not in out:
    print(f"  {R}✗ cannot reach '{HOST}' over SSH: {err}{X}")
    print("    set HARNESS_SSH_HOST to the right alias, or the box is down.")
    sys.exit(2)
lines = out.splitlines()
info(f"host={lines[3] if len(lines) > 3 else '?'}  arch={lines[1]}  {lines[2] if len(lines) > 2 else ''}")

# ── 1. systemd units ───────────────────────────────────────────────────────────
hdr("1. SYSTEMD SERVICES")
out, err = sh("for u in " + " ".join(SYS_UNITS) + "; do echo \"$u=$(systemctl is-active $u)\"; done")
states = dict(l.split("=", 1) for l in out.splitlines() if "=" in l)
for u in SYS_UNITS:
    s = states.get(u, "?")
    ok(f"{u:<28} {s}") if s == "active" else bad(f"{u:<28} {s}")

out, _ = sh("systemctl list-units --state=failed --no-legend --no-pager | awk '{print $1}'")
if out:
    for u in out.splitlines():
        bad(f"FAILED unit: {u}")
else:
    ok("no failed units")

# ── 2. extra services (optional, HARNESS_EXTRA_SERVICES) ───────────────────────
hdr("2. EXTRA SERVICES  (optional, HARNESS_EXTRA_SERVICES — root systemd --user units)")
if not EXTRA_SERVICES:
    info("HARNESS_EXTRA_SERVICES not set — no optional extra services configured, skipping")
else:
    out, _ = sh("loginctl show-user root -p Linger --value 2>/dev/null")
    linger = out.strip() or "?"
    ok("root linger enabled (its systemd --user units survive reboot)") if linger == "yes" \
        else bad(f"root linger={linger} — root's systemd --user units will NOT restart after reboot")

    for name, port in EXTRA_SERVICES:
        out, _ = sh(f"sudo XDG_RUNTIME_DIR=/run/user/0 systemctl --user is-active {name} 2>/dev/null; "
                    "sudo python3 -c \"import json,glob;p=glob.glob('/root/.nvm/versions/node/*/lib/node_modules/"
                    f"{name}/package.json');"
                    "print(json.load(open(sorted(p)[-1]))['version'] if p else '?')\" 2>/dev/null")
        p = out.splitlines()
        state = p[0] if p else "?"
        ver = p[1] if len(p) > 1 else "?"
        ok(f"{name} {state}") if state == "active" else bad(f"{name} {state}")
        info(f"{name} version: {ver}")

        # engine compliance -- this bit an upgrade once, for real: a Node package required
        # >=22.22.3 while the tree it ran under was v22.22.1, and it only worked because
        # /usr/bin happened to come first in the unit's PATH. Correct by luck isn't correct.
        out, _ = sh(f"PID=$(sudo ss -tlnp 2>/dev/null | grep {port} | grep -oE 'pid=[0-9]+' | head -1 | cut -d= -f2); "
                    "E=$(sudo readlink -f /proc/$PID/exe 2>/dev/null); echo \"$E\"; sudo $E --version 2>/dev/null; "
                    "sudo python3 -c \"import json,glob;p=glob.glob('/root/.nvm/versions/node/*/lib/node_modules/"
                    f"{name}/package.json');"
                    "print(json.load(open(sorted(p)[-1]))['engines']['node'] if p else '?')\" 2>/dev/null")
        q = out.splitlines()
        if len(q) >= 3:
            exe, nver, eng = q[0], q[1], q[2]
            info(f"{name} runs under {exe} {nver}")
            info(f"{name} engine requires {eng}")
            m = re.match(r"v(\d+)\.(\d+)\.(\d+)", nver or "")
            lo = re.search(r">=(\d+)\.(\d+)\.(\d+)", eng or "")
            if m and lo:
                cur = tuple(int(x) for x in m.groups())
                need = tuple(int(x) for x in lo.groups())
                ok(f"{name} node {nver} satisfies {eng.split('||')[0].strip()}") if cur >= need \
                    else bad(f"{name} node {nver} is BELOW the required {'.'.join(map(str, need))} — upgrade it")
        else:
            warn(f"could not determine {name}'s node/engine")

    # Discord bots, if configured -- checked against every configured extra service's
    # journal (cheap; a service with no bots in its logs just won't match anything).
    if DISCORD_BOTS:
        bot_alt = "|".join(DISCORD_BOTS)
        for name, _port in EXTRA_SERVICES:
            out, _ = sh(f"sudo journalctl --user-unit {name} --since '-30min' --no-pager 2>/dev/null "
                        f"| grep -oE '\\[({bot_alt})-bot\\].*probe resolved' | grep -oE '({bot_alt})' | sort -u")
            seen = set(out.split())
            for b in DISCORD_BOTS:
                ok(f"@{b} connected ({name})") if b in seen else warn(f"@{b} not seen in {name}'s last 30min of logs")
    else:
        info("HARNESS_DISCORD_BOTS not set — skipping per-bot presence check")

    for name, _port in EXTRA_SERVICES:
        out, _ = sh(f"sudo journalctl --user-unit {name} --since '-30min' --no-pager 2>/dev/null | grep -icE '\\[error\\]|fatal'")
        n = int(out or 0)
        ok(f"{name}: 0 errors in 30min") if n == 0 else warn(f"{name}: {n} error-ish log lines in the last 30min")

# ── 3. ports ───────────────────────────────────────────────────────────────────
hdr("3. LISTENING PORTS")
out, _ = sh("sudo ss -tln 2>/dev/null | awk 'NR>1{print $4}'")
listening = set()
for a in out.split():
    if ":" in a:
        try:
            listening.add(int(a.rsplit(":", 1)[1]))
        except ValueError:
            pass
for port, svc in sorted(PORTS_REQUIRED.items()):
    ok(f":{port:<6} {svc}") if port in listening else bad(f":{port:<6} {svc} NOT LISTENING")
for port, svc in sorted(PORTS_ADVISORY.items()):
    ok(f":{port:<6} {svc}") if port in listening else info(f":{port} absent — {svc}")

# ── 4. local endpoints ─────────────────────────────────────────────────────────
hdr("4. LOCAL HTTP ENDPOINTS")
BASE_HTTP_PORTS = [3005, 3111, 4180]  # 7681 (ttyd) is probed separately below -- needs /term/
extra_ports = [port for _, port in EXTRA_SERVICES]
probe_ports = " ".join(str(p) for p in BASE_HTTP_PORTS + extra_ports)
probe = (f"for p in {probe_ports}; do "
         "echo \"$p=$(curl -s -o /dev/null -w '%{http_code}' --max-time 8 http://127.0.0.1:$p/ 2>/dev/null)\"; done; "
         "echo \"7681=$(curl -s -o /dev/null -w '%{http_code}' --max-time 8 http://127.0.0.1:7681/term/ 2>/dev/null)\"")
out, _ = sh(probe)
codes = dict(l.split("=", 1) for l in out.splitlines() if "=" in l)
# oauth2-proxy 302 on / is correct; ttyd only serves under its --base-path
EXPECT = {"3005": {"200"}, "3111": {"200"}, "4180": {"200", "302", "401", "403"}, "7681": {"200"}}
for port in extra_ports:
    EXPECT.setdefault(str(port), None)  # unconfigured expectation for a third-party service -- just confirm it answers at all
for p, want in EXPECT.items():
    got = codes.get(p, "000")
    good = got != "000" if want is None else got in want
    expected = "some HTTP response" if want is None else "/".join(sorted(want))
    ok(f"127.0.0.1:{p:<6} HTTP {got}") if good else bad(f"127.0.0.1:{p:<6} HTTP {got} (expected {expected})")

# ── 5. external HTTPS + TLS ────────────────────────────────────────────────────
hdr("5. EXTERNAL HTTPS + TLS  (checked from this machine)")
if not shutil.which("curl"):
    warn("curl unavailable locally — skipped external checks")
else:
    for h in VHOSTS:
        try:
            r = subprocess.run(["curl", "-s", "-o", "/dev/null", "-w", "%{http_code}",
                                "--max-time", "20", f"https://{h}/"],
                               capture_output=True, text=True, timeout=30)
            code = r.stdout.strip()
        except Exception:
            code = "000"
        # 302 is correct: the Google OAuth gate redirecting an anonymous request
        good = code in {"200", "302", "403"}
        days = None
        try:
            ctx = ssl.create_default_context()
            with socket.create_connection((h, 443), timeout=10) as s:
                with ctx.wrap_socket(s, server_hostname=h) as ss_:
                    exp = datetime.strptime(ss_.getpeercert()["notAfter"], "%b %d %H:%M:%S %Y %Z")
                    days = (exp.replace(tzinfo=timezone.utc) - datetime.now(timezone.utc)).days
        except Exception:
            pass
        label = f"{h:<26} HTTPS {code}" + (f"  cert {days}d left" if days is not None else "  cert ?")
        if not good:
            bad(label)
        elif days is not None and days < 14:
            warn(label + "  — RENEWAL OVERDUE, Caddy should renew at 30d")
        else:
            ok(label)

# ── 6. stack integrity (the fnm blind spot) ────────────────────────────────────
hdr("6. TOOLCHAIN INTEGRITY")
# Global npm packages installed under an *fnm* node were missed during migration
# (.local/share/fnm is excluded as x86), which is how codegraph vanished while its
# MCP registration survived. Anything registered must actually resolve on PATH.
# ponytail: export PATH then use the `command -v` builtin directly. Do NOT write
# `env PATH=... command -v x` -- env execs a *binary* named "command", which does
# not exist, so every probe reports MISSING and the check cries wolf.
PROBE_PATH = ("P=$(sed -n 's/^Environment=PATH=//p' "
              "/etc/systemd/system/claude-remote-work.service | head -1); export PATH=\"$P\"; ")
out, _ = sh(PROBE_PATH + "for c in codegraph claude uv doppler bun node gh git docker; do "
                         "echo \"$c=$(command -v $c || echo MISSING)\"; done")
resolv = dict(l.split("=", 1) for l in out.splitlines() if "=" in l)
for c, p in resolv.items():
    ok(f"{c:<10} {p}") if p != "MISSING" else bad(f"{c:<10} NOT on the systemd PATH")

# every MCP server registered in .claude.json must be executable
out, _ = sh("python3 -c \"import json,os;d=json.load(open(os.path.expanduser('~/.claude.json')));"
            "[print(k+'|'+(v.get('command') or '')) for k,v in (d.get('mcpServers') or {}).items()]\" 2>/dev/null")
for line in out.splitlines():
    if "|" not in line:
        continue
    name, cmd = line.split("|", 1)
    if not cmd.strip():
        warn(f"MCP '{name}' has no command field")
        continue
    r, _ = sh(PROBE_PATH + f"command -v {cmd} >/dev/null 2>&1 && echo OK || echo MISSING")
    ok(f"MCP '{name}' → {cmd} resolvable") if r == "OK" else bad(f"MCP '{name}' → '{cmd}' NOT FOUND (registered but missing)")

# Git/GitHub auth. .gitconfig hardcodes `!/usr/bin/gh auth git-credential`, so if
# gh is absent every fetch/push fails -- and git reports it as an auth error, not a
# missing binary. That went unnoticed for 19 days after the migration: the repo
# looked "in sync" because it was comparing against a stale origin ref.
out, _ = sh("H=$(git config --global --get-regexp credential 2>/dev/null | grep -oE '/[^ ]*/gh' | head -1); "
            "echo \"helper=${H:-none}\"; "
            "echo \"present=$([ -n \"$H\" ] && [ -x \"$H\" ] && echo yes || echo no)\"; "
            "gh auth status >/dev/null 2>&1 && echo authed=yes || echo authed=no")
gd = dict(l.split("=", 1) for l in out.splitlines() if "=" in l)
helper = gd.get("helper", "none")
if helper == "none":
    info("no gh credential helper configured in .gitconfig")
elif gd.get("present") != "yes":
    bad(f"git credential helper points at {helper} but it is MISSING — all GitHub fetch/push will fail")
elif gd.get("authed") != "yes":
    bad(f"gh present at {helper} but NOT authenticated — run: gh auth login")
else:
    ok(f"git/GitHub auth working via {helper}")

# x86 binaries would silently fail to exec on aarch64
out, _ = sh("sudo find \"$HOME\"/.local/bin /usr/local/bin /root/.nvm/versions/node/*/bin "
            "-maxdepth 1 -type f -perm -u+x -size +50k 2>/dev/null | while read f; do "
            "case \"$(file -Lb \"$f\" 2>/dev/null)\" in *x86-64*) echo \"$f\";; esac; done", timeout=180)
if out:
    for f in out.splitlines():
        bad(f"x86 binary on aarch64 host: {f}")
else:
    ok("no x86-64 binaries in the active bin dirs")

# ── 7. claude-mem ──────────────────────────────────────────────────────────────
hdr("7. CLAUDE-MEM")
BOX_USER = os.environ.get("HARNESS_USER", "")
if not BOX_USER:
    warn("HARNESS_USER not set — skipping claude-mem check (set it to the unprivileged account running claude-mem)")
else:
    out, _ = sh(f"sudo -u {BOX_USER} env HOME=/home/{BOX_USER} PATH=/home/{BOX_USER}/.local/bin:/home/{BOX_USER}/.bun/bin:/usr/bin:/bin "
                f"/home/{BOX_USER}/.local/bin/claude-mem-health --once 2>&1 | tail -3; "
                f"stat -c '%Y %s' /home/{BOX_USER}/.claude-mem/claude-mem.db 2>/dev/null")
    txt = out.splitlines()
    health = " ".join(t for t in txt if "OK" in t or "ALERT" in t or "claude-mem-health" in t)
    if "OK" in health:
        ok(health.strip()[:110])
    elif health:
        warn(health.strip()[:110])
    else:
        warn("claude-mem-health produced no verdict")
    m = re.search(r"^(\d+) (\d+)$", txt[-1]) if txt else None
    if m:
        age_h = (datetime.now(timezone.utc).timestamp() - int(m.group(1))) / 3600
        sz = int(m.group(2)) / 1048576
        info(f"db {sz:.0f} MB, last written {age_h:.1f}h ago")
        if age_h > 48:
            warn(f"claude-mem db not written in {age_h:.0f}h — capture may be stalled")

# ── 8. host resources + pending updates ────────────────────────────────────────
hdr("8. HOST RESOURCES + UPDATES")
out, _ = sh("free -m | awk 'NR==2{print \"MEM\", $3, $2}'; "
            "free -m | awk 'NR==3{print \"SWAP\", $3, $2}'; "
            "df -BG / | awk 'NR==2{gsub(/G/,\"\"); print \"DISK\", $3, $2}'; "
            "awk '{print \"LOAD\", $1}' /proc/loadavg; nproc | awk '{print \"CORES\", $1}'; "
            "echo \"REBOOT $([ -f /var/run/reboot-required ] && echo yes || echo no)\"; "
            "echo \"APT $(apt list --upgradable 2>/dev/null | grep -c upgradable)\"; "
            "echo \"KERNEL $(uname -r)\"")
d = {}
for line in out.splitlines():
    parts = line.split()
    if parts:
        d[parts[0]] = parts[1:]
if "MEM" in d:
    mu, mt = float(d["MEM"][0]), float(d["MEM"][1])
    pct = mu / mt * 100
    info(f"memory {mu:.0f}/{mt:.0f} MB ({pct:.0f}%)   swap {d.get('SWAP',['?','?'])[0]}/{d.get('SWAP',['?','?'])[1]} MB")
    # relevant to Always Free idle reclamation: bigger shapes make this HARDER
    if pct > IDLE_PCT:
        ok(f"memory {pct:.0f}% clears the {IDLE_PCT}% idle-reclamation bar")
    else:
        warn(f"memory {pct:.0f}% is under the {IDLE_PCT}% idle bar — see oci-free-check")
if "DISK" in d:
    du, dt = float(d["DISK"][0]), float(d["DISK"][1])
    pct = du / dt * 100
    info(f"disk {du:.0f}/{dt:.0f} GB ({pct:.0f}%)")
    if pct > 85:
        bad(f"disk {pct:.0f}% full")
    elif pct > 75:
        warn(f"disk {pct:.0f}% full — 200 GB free-tier cap allows growing the volume")
    else:
        ok(f"disk {pct:.0f}% used")
if "LOAD" in d and "CORES" in d:
    info(f"load {d['LOAD'][0]} on {d['CORES'][0]} cores")
info(f"kernel {d.get('KERNEL',['?'])[0]}")
reboot = d.get("REBOOT", ["?"])[0]
ok("no reboot pending") if reboot == "no" else warn("reboot pending (kernel/libc updated)")
apt_n = int(d.get("APT", ["0"])[0] or 0)
ok("apt fully up to date") if apt_n == 0 else warn(f"{apt_n} apt package(s) upgradable")

# ── verdict ────────────────────────────────────────────────────────────────────
hdr("VERDICT")
if fails:
    print(f"  {R}{len(fails)} FAILURE(S), {len(warns)} warning(s){X}")
    for f in fails:
        print(f"    ✗ {f}")
    sys.exit(2)
if warns:
    print(f"  {Y}HEALTHY, with {len(warns)} warning(s){X}")
    for w in warns:
        print(f"    ! {w}")
    sys.exit(1)
print(f"  {G}ALL HEALTHY — every service up, TLS valid, toolchain intact{X}")
sys.exit(0)
