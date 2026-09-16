# Layer 6 `agents/` Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a sixth layer to mows-harness that runs purpose-scoped Claude Code agents unattended, with budgets, triggers, escalation, run records and a dashboard tab, without re-implementing process supervision.

**Architecture:** An agent is one Claude Code subagent file (`<cfgdir>/agents/<name>.md`) carrying a `mows:` policy block. `mows-agent run <name>` lints it, applies budget/quota/concurrency refusals, execs `claude -p --agent <name>` with the CLI's own caps, tails the stream-json into a `status.json` run record, and escalates non-`done` outcomes to Discord. systemd timers/path units (staged into `rendered/`) and an HMAC webhook route on the dashboard are the triggers. The dashboard reads the run records and renders `/agents`.

**Tech Stack:** bash + jq (runner), python3 + PyYAML (frontmatter lint), systemd (triggers), node 20 zero-dependency `lite.mjs` (dashboard, webhook), Claude Code CLI ≥ 2.1.217.

**Spec:** `docs/superpowers/specs/2026-09-15-agents-layer-design.md`

## Global Constraints

- Zero new runtime dependencies. Allowed: `bash`, `jq`, `python3` + `yaml`, `curl`, `systemd`, `gh` (only when `merge.policy: pr`), `node` ≥ 20.
- Never `--dangerously-skip-permissions`; every run passes `--permission-prompts none` and `--strict-mcp-config`.
- `install.sh` never enables, starts or installs a unit; units go to `./rendered/` with printed sudo lines.
- Nothing in `agy/` is modified or called except read-only use of an installed `claude-quota` binary when present.
- Every new tracked file is appended to `scripts/manifest.txt` in the same commit (preflight diffs tree vs manifest).
- New bash passes `shellcheck -S error` (preflight runs it on tracked scripts when shellcheck is installed).
- Test scripts run in a throwaway `HOME`, `unset TMUX`, never touch `~/.local/state`, and never talk to the network (`e2e-agents.sh`). Only `live-agents.sh --yes` spends money (≈ $0.05).
- Commit message trailer on every commit:
  `Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>` and
  `Claude-Session: https://claude.ai/code/session_01DHwnAvv6cDaE5TdNrjADxA`.
- Exit codes of `mows-agent run`: 0 done · 3 failed · 4 budget_exceeded · 5 stalled · 6 refused · 64 usage.

## File map

| Path | Responsibility |
|---|---|
| `agents/bin/mows-agent-meta` | python3: frontmatter → JSON; lint of Claude + `mows:` namespaces |
| `agents/bin/mows-agent` | bash CLI: `lint run list last logs prune render residents` |
| `agents/examples/harness-reviewer.md` | the shipped first agent (read-only reviewer of this repo) |
| `agents/config.example` | `~/.config/mows-agents/config` seed |
| `agents/SETUP.md` | layer doc |
| `scripts/e2e-agents.sh` | hermetic matrix with stubs (claude, claude-quota, curl, gh, systemd-analyze, systemctl) |
| `scripts/live-agents.sh` | one real haiku run, `--yes` gated |
| `install.sh` | `layer_agents()` + `--agents` / `--all` |
| `scripts/e2e-container.sh` | dynamic counts, `--agents` install, agents asserts |
| `infra/dashboard/lite.mjs` | `/agents*` views, `/a/agent-*` actions, `/wh/<name>` webhook, nav tab |
| `infra/caddy/Caddyfile.template` | `/wh/*` carve-out before `forward_auth` |
| `docs/qa/journeys/agents-tab.md` | headless browser journey for the tab |
| `README.md`, `docs/architecture.md` | layer 6 rows/sections |

---

# Phase 1 — CLI core: lint, run, records

### Task 1: `mows-agent-meta` (frontmatter JSON + lint)

**Files:**
- Create: `agents/bin/mows-agent-meta`
- Create: `scripts/e2e-agents.sh` (skeleton + lint matrix; later tasks append sections)
- Modify: `scripts/manifest.txt` (add both paths)

**Interfaces:**
- Produces: `mows-agent-meta json <file>` → frontmatter JSON on stdout, exit 2 if none.
  `mows-agent-meta lint <file>` → `ERROR: …` / `WARN: …` lines on stdout, exit 1 iff any ERROR.
  Reads env `MOWS_PROFILES_JSON` = `{"default":"/abs/.claude","work":"/abs/.claude-work"}`.

- [ ] **Step 1: Write the failing test skeleton**

Create `scripts/e2e-agents.sh`:

```bash
#!/usr/bin/env bash
# e2e-agents — hermetic matrix for the agents layer (Layer 6). Stubs for claude, claude-quota,
# curl, gh, systemd-analyze, systemctl in a throwaway HOME; no network, no real state dir.
#   bash scripts/e2e-agents.sh                          # repo copies (agents/bin)
#   BIN_DIR=~/.local/bin bash scripts/e2e-agents.sh     # installed copies
set -u
cd "$(dirname "$0")/.."
REPO=$PWD
BIN_DIR=${BIN_DIR:-$REPO/agents/bin}
PASS=0; FAIL=0
ok(){ echo "PASS: $*"; PASS=$((PASS+1)); }
no(){ echo "FAIL: $*"; FAIL=$((FAIL+1)); }
chk(){ if eval "$2" >/dev/null 2>&1; then ok "$1"; else no "$1"; fi; }

T=$(mktemp -d); trap 'rm -rf "$T"' EXIT
unset TMUX
export HOME="$T/home"
mkdir -p "$HOME/.claude/agents" "$HOME/.claude-work/agents" "$HOME/.local/state" "$HOME/.config/mows-agents" "$T/shim" "$T/work"
export PATH="$T/shim:$BIN_DIR:$PATH"
export MOWS_AGENTS_STATE="$HOME/.local/state/mows-agents"
export MOWS_AGENT_META="$BIN_DIR/mows-agent-meta"
export CLAUDE_MODE_FILE="$T/claude-mode" CLAUDE_ARGS_FILE="$T/claude-args" CURL_LOG="$T/curl.log" QUOTA_FILE="$T/quota.json" GH_LOG="$T/gh.log" SYSTEMCTL_LOG="$T/systemctl.log"
export STALL_SEC=2
echo "DISCORD_WEBHOOK=https://discord.invalid/hook" > "$HOME/.config/mows-agents/config"

# ---------- stubs ----------
cat > "$T/shim/systemd-analyze" <<'S'
#!/usr/bin/env bash
# accepts anything containing a digit or '*'; rejects "bogus"
[ "$1" = calendar ] && [[ $2 != *bogus* ]] && exit 0; exit 1
S
cat > "$T/shim/gh" <<'S'
#!/usr/bin/env bash
echo "gh $*" >> "${GH_LOG:-/dev/null}"; exit 0
S
cat > "$T/shim/curl" <<'S'
#!/usr/bin/env bash
# capture the JSON body of a Discord post; never touch the network
for ((i=1;i<=$#;i++)); do [ "${!i}" = --data ] && { j=$((i+1)); echo "${!j}" >> "${CURL_LOG:-/dev/null}"; }; done; exit 0
S
cat > "$T/shim/claude-quota" <<'S'
#!/usr/bin/env bash
[ "$1" = --json ] && cat "${QUOTA_FILE}" && exit 0; exit 2
S
cat > "$T/shim/systemctl" <<'S'
#!/usr/bin/env bash
echo "systemctl $*" >> "${SYSTEMCTL_LOG:-/dev/null}"
[ "$1" = list-timers ] && echo "Tue 2026-09-16 06:00:00 UTC  7h left  -  -  mows-agent-t.timer  mows-agent@t.service"; exit 0
S
cat > "$T/shim/claude" <<'S'
#!/usr/bin/env bash
# stub claude: --version, `agents --json`, or a scripted -p run chosen by $CLAUDE_MODE_FILE
# (ok|budget|maxturns|error|noresult|hang). argv + CLAUDE_CONFIG_DIR land in $CLAUDE_ARGS_FILE.
[ "${1:-}" = --version ] && { echo "2.1.273 (Claude Code)"; exit 0; }
[ "${1:-}" = agents ] && { cat "${CLAUDE_AGENTS_JSON_FILE:-/dev/null}"; exit 0; }
{ printf '%s\n' "$@"; echo "CLAUDE_CONFIG_DIR=${CLAUDE_CONFIG_DIR:-}"; echo "PWD=$PWD"; } > "${CLAUDE_ARGS_FILE:-/dev/null}"
mode=$(cat "${CLAUDE_MODE_FILE:-/dev/null}" 2>/dev/null || echo ok)
sid=00000000-0000-4000-8000-000000000001
echo '{"type":"system","subtype":"init","session_id":"'$sid'"}'
echo '{"type":"assistant","message":{"role":"assistant","content":[{"type":"tool_use","id":"t1","name":"Read","input":{}}]},"session_id":"'$sid'"}'
echo '{"type":"assistant","message":{"role":"assistant","content":[{"type":"text","text":"stub says OK"}]},"session_id":"'$sid'"}'
res(){ echo '{"type":"result","subtype":"'$1'","is_error":'$2',"terminal_reason":"'$3'","num_turns":2,"session_id":"'$sid'","total_cost_usd":'$4',"permission_denials":[],"result":"'$5'"}'; }
case $mode in
  ok)       res success false completed 0.0123 "stub says OK";;
  budget)   res error_max_budget_usd true budget_exceeded 1.5 "";;
  maxturns) res error_max_turns true max_turns 0.5 "";;
  error)    res success true api_error 0 "Not logged in";;
  noresult) exit 1;;
  hang)     sleep 3600;;
esac
S
chmod +x "$T"/shim/*

# mkagent <file> [yaml-overrides...]: a valid agent file; each override is a full YAML line
# appended AFTER the base block (later keys win in PyYAML only for top-level scalars, so
# overrides that target nested keys are passed as whole blocks via mkagent_raw instead)
mkagent(){
  local f=$1; shift
  local name; name=$(basename "${f%.md}")
  {
    echo '---'
    echo "name: $name"
    echo "description: test agent"
    echo "model: sonnet"
    echo "tools: [Read, Grep]"
    echo "disallowedTools: [Write, Edit, WebFetch]"
    echo "maxTurns: 40"
    echo "memory: user"
    for l in "$@"; do echo "$l"; done
    echo '---'
    echo "You are a test agent."
  } > "$f"
}
MOWS_BLOCK_OK=$(cat <<EOF
mows:
  profile: default
  workdir: $T/work
  task: do the thing
  budget: { usd_per_run: 1.5, max_turns: 40 }
EOF
)

echo "### lint matrix"
A="$HOME/.claude/agents"
mkagent "$A/good.md" "$MOWS_BLOCK_OK"
chk "lint: valid agent passes"            'mows-agent lint good'
chk "lint: json subcommand emits name"    '[ "$(mows-agent-meta json "$A/good.md" | jq -r .name)" = good ]'
mkagent "$A/badname.md" "$MOWS_BLOCK_OK"; sed -i 's/^name: badname/name: other/' "$A/badname.md"
chk "lint: name != stem is an error"      'mows-agent lint badname 2>&1 | grep -q "name must equal"'
mkagent "$A/nomows.md"
chk "lint: missing mows block"            'mows-agent lint nomows 2>&1 | grep -q "mows: block is required"'
mkagent "$A/badturns.md" "$MOWS_BLOCK_OK"; sed -i 's/^maxTurns: 40/maxTurns: "abc"/' "$A/badturns.md"
chk "lint: maxTurns string is an error"   'mows-agent lint badturns 2>&1 | grep -q "maxTurns must be"'
mkagent "$A/badmem.md" "$MOWS_BLOCK_OK"; sed -i 's/^memory: user/memory: nonsense/' "$A/badmem.md"
chk "lint: memory enum"                   'mows-agent lint badmem 2>&1 | grep -q "memory must be"'
mkagent "$A/bypass.md" "$MOWS_BLOCK_OK" "permissionMode: bypassPermissions"
chk "lint: bypassPermissions forbidden"   'mows-agent lint bypass 2>&1 | grep -q "bypassPermissions is forbidden"'
mkagent "$A/unknownkey.md" "$(printf '%s\n  bogus_key: 1' "$MOWS_BLOCK_OK")"
chk "lint: unknown mows key"              'mows-agent lint unknownkey 2>&1 | grep -q "mows.bogus_key: unknown key"'
mkagent "$A/badprofile.md" "$(sed 's/profile: default/profile: nope/' <<<"$MOWS_BLOCK_OK")"
chk "lint: unknown profile"               'mows-agent lint badprofile 2>&1 | grep -q "not a known profile"'
mkagent "$A/badwd.md" "$(sed "s|workdir: .*|workdir: $T/missing|" <<<"$MOWS_BLOCK_OK")"
chk "lint: missing workdir"               'mows-agent lint badwd 2>&1 | grep -q "workdir does not exist"'
mkagent "$A/nobudget.md" "$(sed '/budget:/d' <<<"$MOWS_BLOCK_OK")"
chk "lint: budget required"               'mows-agent lint nobudget 2>&1 | grep -q "mows.budget is required"'
mkagent "$A/badcron.md" "$(printf '%s\n  triggers: [{type: cron, spec: bogus}]' "$MOWS_BLOCK_OK")"
chk "lint: invalid OnCalendar spec"       'mows-agent lint badcron 2>&1 | grep -q "not valid OnCalendar"'
mkagent "$A/goodcron.md" "$(printf '%s\n  triggers: [{type: cron, spec: "*-*-* 06:00:00"}]' "$MOWS_BLOCK_OK")"
chk "lint: valid cron passes"             'mows-agent lint goodcron'
mkagent "$A/relpath.md" "$(printf '%s\n  triggers: [{type: path, path: relative/x}]' "$MOWS_BLOCK_OK")"
chk "lint: relative path trigger"         'mows-agent lint relpath 2>&1 | grep -q "must be an absolute path"'
mkagent "$A/prro.md" "$(printf '%s\n  merge: {policy: pr}' "$MOWS_BLOCK_OK")"
chk "lint: pr policy on read-only agent"  'mows-agent lint prro 2>&1 | grep -q "nothing to merge"'
mkagent "$A/trifecta.md" "$(printf '%s\n  triggers: [{type: webhook}]' "$MOWS_BLOCK_OK")"; sed -i 's/^disallowedTools: .*/disallowedTools: [WebFetch]/' "$A/trifecta.md"
chk "lint: webhook + write tools WARNs"   'mows-agent lint trifecta 2>&1 | grep -q "WARN: webhook trigger"'
chk "lint: WARN alone still exits 0"      'mows-agent lint trifecta'
mkagent "$A/badesc.md" "$(printf '%s\n  escalate: {via: pigeon}' "$MOWS_BLOCK_OK")"
chk "lint: escalate.via enum"             'mows-agent lint badesc 2>&1 | grep -q "escalate.via must be"'
mkagent "$HOME/.claude-work/agents/good.md" "$(sed 's/profile: default/profile: work/' <<<"$MOWS_BLOCK_OK")"
chk "lint: duplicate name across profiles dies" 'mows-agent lint good 2>&1 | grep -q "more than one profile"'
rm "$HOME/.claude-work/agents/good.md"
chk "lint --all reports each agent"       'mows-agent lint --all 2>&1 | grep -q "== good"'
chk "lint --all exits 1 with any error"   '! mows-agent lint --all'
rm "$A"/{badname,nomows,badturns,badmem,bypass,unknownkey,badprofile,badwd,nobudget,badcron,relpath,prro,trifecta,badesc}.md

echo; echo "e2e-agents: $PASS passed, $FAIL failed"
[ "$FAIL" -eq 0 ]
```

- [ ] **Step 2: Run it to verify it fails**

Run: `bash scripts/e2e-agents.sh 2>&1 | tail -3`
Expected: every `lint:` line FAIL (no `mows-agent`, no `mows-agent-meta` yet), non-zero exit.

- [ ] **Step 3: Write `agents/bin/mows-agent-meta`**

```python
#!/usr/bin/env python3
"""mows-agent-meta — the only validator an agent file gets.

Claude Code type-checks NOTHING in file-based agent frontmatter (verified 2.1.273:
maxTurns: "abc" and memory: nonsense both load silently), so both namespaces are checked here.

  mows-agent-meta json <agent.md>   frontmatter as JSON on stdout (exit 2 if none)
  mows-agent-meta lint <agent.md>   ERROR:/WARN: lines on stdout; exit 1 iff any ERROR

Env: MOWS_PROFILES_JSON = {"default":"<HOME>/.claude","work":"<HOME>/.claude-work"}
"""
import json
import os
import re
import shutil
import subprocess
import sys

try:
    import yaml
except ImportError:  # python3-yaml is a cloud-init dependency on Ubuntu server; absent on minimal images
    print("mows-agent-meta: python3 yaml module missing: sudo apt-get install -y python3-yaml", file=sys.stderr)
    sys.exit(2)

PERM = {"default", "acceptEdits", "plan", "dontAsk", "bypassPermissions"}
MEM = {"user", "project", "local"}
ISO = {"worktree", "none"}
MODEL_ALIAS = {"sonnet", "opus", "haiku", "inherit"}
MOWS_KEYS = {"profile", "workdir", "task", "budget", "triggers", "merge", "escalate", "retention_days"}
BUDGET_KEYS = {"usd_per_run", "max_turns", "usd_per_day", "quota_floor"}
TRIGGER_TYPES = {"cron", "path", "webhook"}


def frontmatter(path):
    text = open(path, encoding="utf-8").read()
    m = re.match(r"^---[ \t]*\n(.*?)\n---[ \t]*(\n|$)", text, re.S)
    if not m:
        return None
    try:
        data = yaml.safe_load(m.group(1))
    except yaml.YAMLError as e:
        return {"__yaml_error__": str(e).splitlines()[0]}
    return data if isinstance(data, dict) else None


def as_list(v):
    """Claude accepts `tools: Read, Grep` (string) and `tools: [Read, Grep]` (list)."""
    if v is None:
        return []
    if isinstance(v, str):
        return [t.strip() for t in v.split(",") if t.strip()]
    return list(v) if isinstance(v, list) else None


def is_int(v):
    return isinstance(v, int) and not isinstance(v, bool)


def is_num(v):
    return isinstance(v, (int, float)) and not isinstance(v, bool)


def lint(path):
    E, W = [], []
    fm = frontmatter(path)
    if fm is None:
        return ["no YAML frontmatter (file must start with ---)"], []
    if "__yaml_error__" in fm:
        return ["frontmatter is not valid YAML: " + fm["__yaml_error__"]], []
    stem = os.path.splitext(os.path.basename(path))[0]

    # ---- Claude Code namespace ----
    if fm.get("name") != stem:
        E.append(f"name must equal the filename stem '{stem}' (got {fm.get('name')!r})")
    if not isinstance(fm.get("description"), str) or not fm["description"].strip():
        E.append("description is required")
    if "maxTurns" in fm and not (is_int(fm["maxTurns"]) and fm["maxTurns"] > 0):
        E.append(f"maxTurns must be a positive integer (got {fm['maxTurns']!r})")
    if "memory" in fm and fm["memory"] not in MEM:
        E.append(f"memory must be one of {sorted(MEM)} (got {fm['memory']!r})")
    if fm.get("permissionMode") == "bypassPermissions":
        E.append("permissionMode: bypassPermissions is forbidden for agents (spec §7)")
    elif "permissionMode" in fm and fm["permissionMode"] not in PERM:
        E.append(f"permissionMode must be one of {sorted(PERM)} (got {fm['permissionMode']!r})")
    if "isolation" in fm and fm["isolation"] not in ISO:
        E.append(f"isolation must be one of {sorted(ISO)} (got {fm['isolation']!r})")
    model = fm.get("model")
    if model is not None and not (model in MODEL_ALIAS or (isinstance(model, str) and model.startswith("claude-"))):
        E.append(f"model must be sonnet|opus|haiku|inherit or a claude-* id (got {model!r})")
    tools = as_list(fm.get("tools"))
    dis = as_list(fm.get("disallowedTools"))
    if tools is None:
        E.append("tools must be a list or comma-separated string")
    if dis is None:
        E.append("disallowedTools must be a list or comma-separated string")
    can_write = not ({"Write", "Edit"} <= set(dis or []))

    # ---- mows namespace ----
    mows = fm.get("mows")
    if not isinstance(mows, dict):
        E.append("mows: block is required")
        return E, W
    for k in sorted(set(mows) - MOWS_KEYS):
        E.append(f"mows.{k}: unknown key (allowed: {sorted(MOWS_KEYS)})")
    profiles = json.loads(os.environ.get("MOWS_PROFILES_JSON") or "{}")
    prof = mows.get("profile")
    if not prof:
        E.append("mows.profile is required")
    elif prof not in profiles:
        E.append(f"mows.profile '{prof}' is not a known profile (known: {sorted(profiles)})")
    wd = mows.get("workdir")
    if not isinstance(wd, str) or not wd:
        E.append("mows.workdir is required")
    elif not os.path.isdir(os.path.expanduser(wd)):
        E.append(f"mows.workdir does not exist: {wd}")
    if not isinstance(mows.get("task"), str) or not mows["task"].strip():
        E.append("mows.task is required (the default prompt of a run)")
    b = mows.get("budget")
    if not isinstance(b, dict):
        E.append("mows.budget is required")
    else:
        for k in sorted(set(b) - BUDGET_KEYS):
            E.append(f"mows.budget.{k}: unknown key (allowed: {sorted(BUDGET_KEYS)})")
        if not (is_num(b.get("usd_per_run")) and b["usd_per_run"] > 0):
            E.append("mows.budget.usd_per_run must be a number > 0")
        if not (is_int(b.get("max_turns")) and b["max_turns"] > 0):
            E.append("mows.budget.max_turns must be a positive integer")
        if "usd_per_day" in b and not (is_num(b["usd_per_day"]) and b["usd_per_day"] > 0):
            E.append("mows.budget.usd_per_day must be a number > 0")
        if "quota_floor" in b and not (is_int(b["quota_floor"]) and 0 <= b["quota_floor"] <= 100):
            E.append("mows.budget.quota_floor must be an integer 0..100")
    trig = mows.get("triggers", [])
    has_webhook = False
    if not isinstance(trig, list):
        E.append("mows.triggers must be a list")
    else:
        for i, t in enumerate(trig):
            if not isinstance(t, dict) or t.get("type") not in TRIGGER_TYPES:
                E.append(f"mows.triggers[{i}].type must be one of {sorted(TRIGGER_TYPES)}")
                continue
            if t["type"] == "cron":
                spec = t.get("spec")
                if not isinstance(spec, str) or not spec:
                    E.append(f"mows.triggers[{i}].spec is required for cron")
                elif shutil.which("systemd-analyze"):
                    r = subprocess.run(["systemd-analyze", "calendar", spec], capture_output=True, text=True)
                    if r.returncode != 0:
                        E.append(f"mows.triggers[{i}].spec is not valid OnCalendar syntax: {spec!r}")
                else:
                    W.append(f"mows.triggers[{i}]: systemd-analyze not found, cron spec unchecked")
            elif t["type"] == "path":
                pth = t.get("path")
                if not isinstance(pth, str) or not os.path.isabs(os.path.expanduser(pth)):
                    E.append(f"mows.triggers[{i}].path must be an absolute path (~ allowed)")
            else:
                has_webhook = True
                if set(t) - {"type"}:
                    E.append(f"mows.triggers[{i}]: webhook takes no keys besides type (the secret lives in config)")
    mg = mows.get("merge", {})
    if not isinstance(mg, dict):
        E.append("merge: must be a map")
    else:
        pol = mg.get("policy", "none")
        if pol not in {"none", "pr"}:
            E.append(f"merge.policy must be none|pr (got {pol!r})")
        if pol == "pr":
            if not shutil.which("gh"):
                E.append("merge.policy: pr requires gh on PATH")
            elif subprocess.run(["gh", "auth", "status"], capture_output=True).returncode != 0:
                E.append("merge.policy: pr requires `gh auth status` to pass for this user")
            if not can_write:
                E.append("merge.policy: pr but Write and Edit are both disallowed: nothing to merge")
        if "base" in mg and not isinstance(mg["base"], str):
            E.append("merge.base must be a string")
    esc = mows.get("escalate", {})
    if not isinstance(esc, dict) or esc.get("via", "none") not in {"discord", "none"}:
        E.append("mows.escalate.via must be discord|none")
    rd = mows.get("retention_days", 30)
    if not (is_int(rd) and rd > 0):
        E.append("mows.retention_days must be a positive integer")
    if has_webhook and can_write:
        W.append("webhook trigger + write tools on one agent (untrusted trigger with write capability): "
                 "add Write, Edit to disallowedTools unless you mean it")
    return E, W


def main():
    if len(sys.argv) != 3 or sys.argv[1] not in {"json", "lint"}:
        print(__doc__)
        sys.exit(64)
    cmd, path = sys.argv[1], sys.argv[2]
    if not os.path.isfile(path):
        print(f"mows-agent-meta: no such file {path}", file=sys.stderr)
        sys.exit(2)
    if cmd == "json":
        fm = frontmatter(path)
        if fm is None or "__yaml_error__" in fm:
            print(f"mows-agent-meta: no usable frontmatter in {path}", file=sys.stderr)
            sys.exit(2)
        json.dump(fm, sys.stdout, default=str)
        print()
        return
    errors, warns = lint(path)
    for w in warns:
        print("WARN: " + w)
    for e in errors:
        print("ERROR: " + e)
    sys.exit(1 if errors else 0)


if __name__ == "__main__":
    main()
```

`chmod +x agents/bin/mows-agent-meta`.

- [ ] **Step 4: Write the `lint`/discovery half of `agents/bin/mows-agent`**

Create `agents/bin/mows-agent` (the `run` half lands in Task 2; `lint`, `list` skeleton and helpers now):

```bash
#!/usr/bin/env bash
# mows-agent — policy runner for purpose-scoped agents (Layer 6).
# The Claude Code daemon manages processes; this manages POLICY: lint, budget, refusal,
# run records, escalation, triggers. Spec: docs/superpowers/specs/2026-09-15-agents-layer-design.md
#   mows-agent lint <name>|--all · run <name> [task…] · list · last <name> · logs <name> [run_id] [--raw]
#              prune · render <name>|--all · residents [--json]
# Exit (run): 0 done · 3 failed · 4 budget_exceeded · 5 stalled · 6 refused · 64 usage
set -uo pipefail
CFG="$HOME/.config/mows-agents/config"; [ -f "$CFG" ] && . "$CFG"
STATE_ROOT="${MOWS_AGENTS_STATE:-$HOME/.local/state/mows-agents}"
META="${MOWS_AGENT_META:-$(dirname "$(readlink -f "$0")")/mows-agent-meta}"
CLAUDE_BIN="${CLAUDE_BIN:-claude}"
QUOTA_BIN="${QUOTA_BIN:-claude-quota}"
STALL_MIN="${STALL_MIN:-10}"
STALL_SEC="${STALL_SEC:-$((STALL_MIN * 60))}"
MCP_CONFIG="${MCP_CONFIG:-}"
RENDER_DIR="${RENDER_DIR:-$PWD/rendered}"

die(){ echo "mows-agent: $*" >&2; exit 64; }
command -v jq >/dev/null 2>&1 || die "jq required"
[ -x "$META" ] || die "mows-agent-meta not found at $META"

# ---------- discovery: default=~/.claude plus every ~/.claude-<suffix> (same rule as fleet/bin/cc) ----------
profiles_json(){
  local j='{}' d s
  [ -d "$HOME/.claude" ] && j=$(jq -n --arg d "$HOME/.claude" '{default:$d}')
  for d in "$HOME"/.claude-*/; do
    [ -d "$d" ] || continue; d=${d%/}; s=${d##*/.claude-}
    j=$(jq --arg k "$s" --arg v "$d" '.[$k]=$v' <<<"$j")
  done
  echo "$j"
}
MOWS_PROFILES_JSON=$(profiles_json); export MOWS_PROFILES_JSON
cfg_of(){ jq -r --arg p "$1" '.[$p] // empty' <<<"$MOWS_PROFILES_JSON"; }

# an agent = <cfgdir>/agents/<name>.md whose frontmatter has a top-level `mows:` key
has_mows(){ awk 'NR==1&&$0!="---"{bad=1} NR>1&&$0=="---"{done=1} !done&&NR>1&&/^mows:/{f=1} END{exit !(f&&!bad)}' "$1"; }
agent_file(){ # prints the single file for <name>; dies on duplicates; empty if none
  local n=$1 f found=()
  while IFS= read -r d; do f="$d/agents/$n.md"; [ -f "$f" ] && has_mows "$f" && found+=("$f"); done < <(jq -r '.[]' <<<"$MOWS_PROFILES_JSON")
  [ ${#found[@]} -gt 1 ] && die "agent $n defined in more than one profile: ${found[*]}"
  [ ${#found[@]} -eq 1 ] && echo "${found[0]}"; return 0
}
all_agents(){ # name<TAB>file, sorted
  local d f
  while IFS= read -r d; do
    for f in "$d"/agents/*.md; do [ -f "$f" ] && has_mows "$f" && printf '%s\t%s\n' "$(basename "${f%.md}")" "$f"; done
  done < <(jq -r '.[]' <<<"$MOWS_PROFILES_JSON") | sort
}
meta(){ "$META" json "$1"; }
mget(){ jq -r "$2 // empty" <<<"$1"; }
expand_tilde(){ case $1 in "~") echo "$HOME";; "~/"*) echo "$HOME/${1#\~/}";; *) echo "$1";; esac; }
check_version(){ # --permission-prompts / --max-budget-usd need >= 2.1.217
  local v; v=$("$CLAUDE_BIN" --version 2>/dev/null | grep -oE '[0-9]+\.[0-9]+\.[0-9]+' | head -1)
  [ -n "$v" ] || { echo "WARN: cannot read claude version" >&2; return 0; }
  [ "$(printf '%s\n2.1.217\n' "$v" | sort -V | head -1)" = 2.1.217 ] || die "claude $v too old (need >= 2.1.217)"
}

# ---------- events + escalation ----------
event(){ mkdir -p "$STATE_ROOT/$1"; echo "$(date -Is) $2" >> "$STATE_ROOT/$1/events.log"; }
escalate(){ # escalate <name> <via> <msg>: always logs; posts to Discord only when via=discord and a webhook is set
  event "$1" "$3"
  [ "$2" = discord ] && [ -n "${DISCORD_WEBHOOK:-}" ] || return 0
  curl -fsS --max-time 10 -H 'content-type: application/json' \
    --data "$(jq -n --arg c "🤖 $1: $3" '{content:$c}')" "$DISCORD_WEBHOOK" >/dev/null 2>&1 || true
}

# ---------- lint ----------
cmd_lint(){
  local rc=0 n f
  if [ "${1:-}" = --all ]; then
    while IFS=$'\t' read -r n f; do echo "== $n"; "$META" lint "$f" || rc=1; done < <(all_agents)
  else
    [ -n "${1:-}" ] || die "usage: mows-agent lint <name>|--all"
    f=$(agent_file "$1") || exit 64; [ -n "$f" ] || die "no agent named $1"
    "$META" lint "$f" || rc=1
  fi
  return $rc
}

# ---------- dispatch ----------
case "${1:-}" in
  lint) shift; cmd_lint "$@";;
  *) die "usage: mows-agent lint|run|list|last|logs|prune|render|residents …";;
esac
```

`chmod +x agents/bin/mows-agent`.

- [ ] **Step 5: Run the test**

Run: `bash scripts/e2e-agents.sh 2>&1 | grep -E 'FAIL|passed'`
Expected: `e2e-agents: 21 passed, 0 failed`.

- [ ] **Step 6: shellcheck + manifest + commit**

```bash
shellcheck -S error agents/bin/mows-agent scripts/e2e-agents.sh
printf '%s\n' agents/bin/mows-agent agents/bin/mows-agent-meta scripts/e2e-agents.sh >> scripts/manifest.txt   # the spec + plan are already listed
./scripts/preflight.sh | tail -1
git add agents scripts/e2e-agents.sh scripts/manifest.txt docs/superpowers
git commit -m "agents: mows-agent-meta lint + discovery (Layer 6, phase 1a)"
```

### Task 2: `mows-agent run` — the bounded run and its record

**Files:**
- Modify: `agents/bin/mows-agent` (append `run`, `tail_loop`, `run_context`, helpers, dispatch)
- Modify: `scripts/e2e-agents.sh` (append the run-state matrix)

**Interfaces:**
- Produces: `$STATE_ROOT/<name>/runs/<run_id>/{status.json,stream.jsonl,result.json,stderr.log}`, `$STATE_ROOT/<name>/last` symlink, `$STATE_ROOT/<name>/events.log`.
  `status.json` keys: `agent run_id state session_id started_at last_event_at turns tool_calls cost_usd permission_denials pid claude_pid`.
  `state` ∈ `working done failed budget_exceeded stalled`.
- Consumes: Task 1 helpers (`agent_file meta mget cfg_of expand_tilde event escalate check_version`).

- [ ] **Step 1: Append the failing run matrix to `scripts/e2e-agents.sh`** (insert before the final `echo; echo "e2e-agents: …"` line)

```bash
echo "### run: state table"
S="$MOWS_AGENTS_STATE/good"
echo ok > "$CLAUDE_MODE_FILE"
mows-agent run good >/dev/null 2>&1; RC=$?
chk "run ok: exit 0"                          '[ "$RC" = 0 ]'
chk "run ok: status.json state=done"          '[ "$(jq -r .state "$S/last/status.json")" = done ]'
chk "run ok: result.json saved verbatim"      '[ "$(jq -r .result "$S/last/result.json")" = "stub says OK" ]'
chk "run ok: cost copied from result"         '[ "$(jq -r .cost_usd "$S/last/status.json")" = 0.0123 ]'
chk "run ok: turns from result"               '[ "$(jq -r .turns "$S/last/status.json")" = 2 ]'
chk "run ok: tool_calls counted"              '[ "$(jq -r .tool_calls "$S/last/status.json")" = 1 ]'
chk "run ok: session_id captured"             '[ "$(jq -r .session_id "$S/last/status.json")" = 00000000-0000-4000-8000-000000000001 ]'
chk "run ok: run_id shape"                    'jq -r .run_id "$S/last/status.json" | grep -qE "^[0-9]{8}-[0-9]{6}-[0-9]+$"'
chk "run ok: last -> runs/<id>"               '[ "$(readlink "$S/last")" = "runs/$(jq -r .run_id "$S/last/status.json")" ]'
chk "run ok: stream.jsonl kept"               'grep -q "\"type\":\"result\"" "$S/last/stream.jsonl"'
chk "run ok: no event on success"             '[ ! -s "$S/events.log" ]'
chk "run ok: no discord post on success"      '[ ! -s "$CURL_LOG" ]'
chk "args: --agent good"                      'grep -qx -- "--agent" "$CLAUDE_ARGS_FILE" && grep -qx good "$CLAUDE_ARGS_FILE"'
chk "args: --permission-prompts none"         'grep -A1 -x -- "--permission-prompts" "$CLAUDE_ARGS_FILE" | grep -qx none'
chk "args: --max-budget-usd 1.5"              'grep -A1 -x -- "--max-budget-usd" "$CLAUDE_ARGS_FILE" | grep -qx 1.5'
chk "args: --max-turns 40"                    'grep -A1 -x -- "--max-turns" "$CLAUDE_ARGS_FILE" | grep -qx 40'
chk "args: --strict-mcp-config, no mcp file"  'grep -qx -- "--strict-mcp-config" "$CLAUDE_ARGS_FILE" && ! grep -qx -- "--mcp-config" "$CLAUDE_ARGS_FILE"'
chk "args: never --dangerously-skip"          '! grep -q dangerously "$CLAUDE_ARGS_FILE"'
chk "args: task is the manifest task"         'grep -qx "do the thing" "$CLAUDE_ARGS_FILE"'
chk "args: run context appended"              'grep -q "run_id:" "$CLAUDE_ARGS_FILE" && grep -q "never ask questions" "$CLAUDE_ARGS_FILE"'
chk "env: CLAUDE_CONFIG_DIR = profile dir"    'grep -qx "CLAUDE_CONFIG_DIR=$HOME/.claude" "$CLAUDE_ARGS_FILE"'
chk "env: cwd = workdir"                      'grep -qx "PWD=$T/work" "$CLAUDE_ARGS_FILE"'
mows-agent run good "custom task text" >/dev/null 2>&1
chk "args: CLI task overrides manifest"       'grep -qx "custom task text" "$CLAUDE_ARGS_FILE"'
chk "run context names previous run"          'grep -q "previous run:" "$CLAUDE_ARGS_FILE"'

echo budget > "$CLAUDE_MODE_FILE"; mows-agent run good >/dev/null 2>&1; RC=$?
chk "run budget: exit 4"                      '[ "$RC" = 4 ]'
chk "run budget: state budget_exceeded"       '[ "$(jq -r .state "$S/last/status.json")" = budget_exceeded ]'
chk "run budget: event logged"                'grep -q budget_exceeded "$S/events.log"'
chk "run budget: no discord (via unset)"      '[ ! -s "$CURL_LOG" ]'
echo maxturns > "$CLAUDE_MODE_FILE"; mows-agent run good >/dev/null 2>&1; RC=$?
chk "run maxturns: exit 3 failed"             '[ "$RC" = 3 ] && [ "$(jq -r .state "$S/last/status.json")" = failed ]'
echo error > "$CLAUDE_MODE_FILE"; mows-agent run good >/dev/null 2>&1; RC=$?
chk "run api error: exit 3 failed"            '[ "$RC" = 3 ] && [ "$(jq -r .state "$S/last/status.json")" = failed ]'
echo noresult > "$CLAUDE_MODE_FILE"; mows-agent run good >/dev/null 2>&1; RC=$?
chk "run no result record: exit 3 failed"     '[ "$RC" = 3 ] && [ "$(jq -r .state "$S/last/status.json")" = failed ]'
chk "run no result: no result.json"           '[ ! -f "$S/last/result.json" ]'
echo hang > "$CLAUDE_MODE_FILE"; T0=$(date +%s); mows-agent run good >/dev/null 2>&1; RC=$?; T1=$(date +%s)
chk "run hang: exit 5 stalled"                '[ "$RC" = 5 ] && [ "$(jq -r .state "$S/last/status.json")" = stalled ]'
chk "run hang: killed within 15s"             '[ $((T1 - T0)) -lt 15 ]'
chk "run hang: no leftover sleep"             '! pgrep -f "sleep 3600" -u "$(id -u)" >/dev/null || ! pgrep -P "$(jq -r .claude_pid "$S/last/status.json")" >/dev/null'
echo ok > "$CLAUDE_MODE_FILE"

echo "### run: escalation via discord"
mkagent "$A/loud.md" "$(printf '%s\n  escalate: {via: discord}' "$MOWS_BLOCK_OK")"
echo budget > "$CLAUDE_MODE_FILE"; mows-agent run loud >/dev/null 2>&1
chk "discord: exactly one post"               '[ "$(wc -l < "$CURL_LOG")" = 1 ]'
chk "discord: names agent + state"            'grep -q "loud" "$CURL_LOG" && grep -q budget_exceeded "$CURL_LOG"'
echo ok > "$CLAUDE_MODE_FILE"; : > "$CURL_LOG"

echo "### run: refusals"
mkagent "$A/broken.md" "$MOWS_BLOCK_OK"; sed -i 's/^maxTurns: 40/maxTurns: "abc"/' "$A/broken.md"
mows-agent run broken >/dev/null 2>&1; RC=$?
chk "refuse: lint error -> exit 6, no run dir" '[ "$RC" = 6 ] && [ ! -d "$MOWS_AGENTS_STATE/broken/runs" ]'
chk "refuse: no agent named -> 64"             'mows-agent run nosuch >/dev/null 2>&1; [ $? = 64 ]'
```

- [ ] **Step 2: Run to verify it fails**

Run: `bash scripts/e2e-agents.sh 2>&1 | grep -c FAIL`
Expected: all `run` lines FAIL (`run` is not a subcommand yet).

- [ ] **Step 3: Append the run implementation to `agents/bin/mows-agent`** (insert above the `# ---------- dispatch` block; replace the dispatch `case` at the end)

```bash
# ---------- run records ----------
write_status(){ # write_status <state>  (uses the run globals; atomic)
  jq -n --arg a "$AGENT" --arg r "$RUN_ID" --arg s "$1" --arg sid "${SID:-}" --arg st "$STARTED" \
        --argjson turns "${TURNS:-0}" --argjson tools "${TOOLS:-0}" --argjson cost "${COST:-0}" \
        --argjson den "${DENIALS:-0}" --argjson pid "$$" --argjson cpid "${CPID:-0}" \
        '{agent:$a,run_id:$r,state:$s,session_id:$sid,started_at:$st,last_event_at:(now|todate),
          turns:$turns,tool_calls:$tools,cost_usd:$cost,permission_denials:$den,pid:$pid,claude_pid:$cpid}' \
        > "$RUNDIR/status.json.tmp" && mv "$RUNDIR/status.json.tmp" "$RUNDIR/status.json"
}
run_context(){ # appended to the system prompt: who am I, what ran before. Never written into the agent file.
  local prev
  prev=$(ls -1d "$STATE_ROOT/$AGENT/runs"/*/ 2>/dev/null | grep -v "/$RUN_ID/" | tail -1)
  printf 'mows-agent run context\n- agent: %s\n- run_id: %s\n- profile: %s\n- workdir: %s\n- budget: %s USD, %s turns\n' \
    "$AGENT" "$RUN_ID" "$PROFILE" "$WORKDIR" "$USD_RUN" "$MAXT"
  if [ -n "$prev" ] && [ -f "$prev/status.json" ]; then
    printf -- '- previous run: %s state=%s cost=%s\n' "$(basename "$prev")" "$(jq -r .state "$prev/status.json")" "$(jq -r .cost_usd "$prev/status.json")"
    [ -f "$prev/result.json" ] && printf -- '- previous result: %s\n' "$(jq -r '(.result // "") | .[0:600]' "$prev/result.json")"
  fi
  printf 'You have no human available: never ask questions, decide and finish within budget.\n'
}
kill_tree(){ # kill the claude process GROUP. $! is not reliably the pgid leader (setsid execs
  # only when the caller is not already a process-group leader), so read the real pgid.
  local pid=$1 pgid
  pgid=$(ps -o pgid= -p "$pid" 2>/dev/null | tr -d ' ')
  if [ -n "$pgid" ]; then kill -TERM -- "-$pgid" 2>/dev/null; else kill -TERM "$pid" 2>/dev/null; fi
}
tail_loop(){ # stdin = stream-json; $1 = claude pid. Updates status.json; decides the final state.
  local cpid=$1 line final="" stalled=0 rc
  TURNS=0; TOOLS=0; COST=0; DENIALS=0; SID=""
  while true; do
    if IFS= read -r -t "$STALL_SEC" line; then
      [ -n "$line" ] || continue
      case $line in
        *'"type":"system"'*)    SID=$(jq -r '.session_id // empty' <<<"$line"); write_status working;;
        *'"type":"assistant"'*) TURNS=$((TURNS + 1))
                                TOOLS=$((TOOLS + $(jq '[.message.content[]? | select(.type=="tool_use")] | length' <<<"$line")))
                                write_status working;;
        *'"type":"result"'*)    final=$line; break;;
      esac
    else
      rc=$?; [ "$rc" -gt 128 ] || break            # EOF without a result record
      kill_tree "$cpid"; stalled=1; break
    fi
  done
  local st
  if [ -n "$final" ]; then
    printf '%s\n' "$final" > "$RUNDIR/result.json"
    COST=$(jq '.total_cost_usd // 0' <<<"$final"); TURNS=$(jq '.num_turns // 0' <<<"$final")
    DENIALS=$(jq '(.permission_denials // []) | length' <<<"$final"); SID=$(jq -r '.session_id // empty' <<<"$final")
    case "$(jq -r '[.subtype // "", .terminal_reason // "", (.is_error|tostring)] | join("|")' <<<"$final")" in
      success\|*\|false) st=done;;
      *budget*)          st=budget_exceeded;;
      *max_turns*)       st=failed;;
      *)                 st=failed;;
    esac
  elif [ "$stalled" = 1 ]; then st=stalled
  else st=failed; fi
  write_status "$st"
}
today_spend(){ # sum of today's total_cost_usd for <name>
  local d="$STATE_ROOT/$1/runs"; [ -d "$d" ] || { echo 0; return; }
  cat "$d/$(date +%Y%m%d)"-*/result.json 2>/dev/null | jq -s '[.[].total_cost_usd // 0] | add // 0'
}
quota_ok(){ # quota_ok <profile> <floor>: 1 = refuse. Unknown/absent quota never refuses (spec §4).
  local prof=$1 floor=$2 j pct
  [ "$floor" -gt 0 ] 2>/dev/null || return 0
  command -v "$QUOTA_BIN" >/dev/null 2>&1 || { echo "WARN: $QUOTA_BIN not installed, quota_floor skipped" >&2; return 0; }
  j=$("$QUOTA_BIN" --json 2>/dev/null) || return 0
  # claude-quota keys accounts personal|work; profile default -> personal, others by name
  pct=$(jq -r --arg p "$prof" '(.[$p] // (if $p=="default" then .personal else {} end)) as $a
        | [($a.five_hour_pct // 0), ($a.weekly_pct // 0)] | max' <<<"$j" 2>/dev/null) || return 0
  awk -v p="${pct:-0}" -v f="$floor" 'BEGIN{exit !(p > 100 - f)}' && return 1
  return 0
}
running_pid(){ # pid of a live `working` run of <name>, else nothing
  local s="$STATE_ROOT/$1/last/status.json" pid
  [ -f "$s" ] || return 0
  [ "$(jq -r .state "$s")" = working ] || return 0
  pid=$(jq -r '.pid // empty' "$s"); [ -n "$pid" ] && kill -0 "$pid" 2>/dev/null && echo "$pid"; return 0
}
merge_step(){ # merge.policy pr: push the agent's branch and open a PR; never touches base
  local mg base br; mg=$(jq -c '.mows | .merge // {}' <<<"$M")
  [ "$(mget "$mg" .policy)" = pr ] || return 0
  base=$(mget "$mg" .base); base=${base:-main}
  git -C "$WORKDIR" rev-parse --is-inside-work-tree >/dev/null 2>&1 || { event "$AGENT" "merge: $WORKDIR is not a git repo"; return 0; }
  br=$(git -C "$WORKDIR" rev-parse --abbrev-ref HEAD)
  [ "$br" != "$base" ] || { event "$AGENT" "merge: still on $base, nothing to open"; return 0; }
  [ "$(git -C "$WORKDIR" rev-list --count "$base..HEAD" 2>/dev/null || echo 0)" -gt 0 ] || { event "$AGENT" "merge: no commits ahead of $base"; return 0; }
  if (cd "$WORKDIR" && git push -u origin HEAD && gh pr create --fill --base "$base") >> "$RUNDIR/merge.log" 2>&1; then
    event "$AGENT" "merge: PR opened from $br"
  else
    escalate "$AGENT" "$VIA" "merge: PR creation failed for $br (see $RUNDIR/merge.log)"
  fi
}

cmd_run(){
  AGENT=${1:-}; [ -n "$AGENT" ] || die "usage: mows-agent run <name> [task…]"; shift
  local f; f=$(agent_file "$AGENT") || exit 64; [ -n "$f" ] || die "no agent named $AGENT"
  check_version
  if ! "$META" lint "$f" >&2; then event "$AGENT" "refused: lint errors in $f"; exit 6; fi
  M=$(meta "$f")
  PROFILE=$(mget "$M" .mows.profile); CFGDIR=$(cfg_of "$PROFILE")
  WORKDIR=$(expand_tilde "$(mget "$M" .mows.workdir)")
  USD_RUN=$(mget "$M" .mows.budget.usd_per_run); MAXT=$(mget "$M" .mows.budget.max_turns)
  VIA=$(mget "$M" .mows.escalate.via); VIA=${VIA:-none}
  local usd_day floor task pid spent
  usd_day=$(mget "$M" .mows.budget.usd_per_day); floor=$(mget "$M" .mows.budget.quota_floor)
  task=${*:-$(mget "$M" .mows.task)}
  # ---- refusals (spec §3.1 step 2) ----
  pid=$(running_pid "$AGENT")
  if [ -n "$pid" ]; then escalate "$AGENT" "$VIA" "refused: $(readlink "$STATE_ROOT/$AGENT/last") still working (pid $pid)"; exit 6; fi
  if [ -n "$usd_day" ]; then
    spent=$(today_spend "$AGENT")
    if awk -v s="$spent" -v c="$usd_day" 'BEGIN{exit !(s >= c)}'; then
      escalate "$AGENT" "$VIA" "refused: daily cap \$$usd_day reached (spent \$$spent today)"; exit 6; fi
  fi
  if ! quota_ok "$PROFILE" "${floor:-0}"; then escalate "$AGENT" "$VIA" "refused: account quota below ${floor}% headroom (claude-quota)"; exit 6; fi
  # ---- run record ----
  RUN_ID=$(date +%Y%m%d-%H%M%S)-$$; RUNDIR="$STATE_ROOT/$AGENT/runs/$RUN_ID"; mkdir -p "$RUNDIR"
  ln -sfn "runs/$RUN_ID" "$STATE_ROOT/$AGENT/last"
  STARTED=$(date -Is); CPID=0; write_status working
  cd "$WORKDIR" || die "cannot cd $WORKDIR"
  local mcp=(); [ -n "$MCP_CONFIG" ] && mcp=(--mcp-config "$MCP_CONFIG")
  # setsid: claude leads its own process group so a stall kill takes its MCP/tool children too
  # (kill_tree reads the real pgid rather than assuming it equals $!)
  CLAUDE_CONFIG_DIR="$CFGDIR" setsid "$CLAUDE_BIN" -p --agent "$AGENT" \
      --output-format stream-json --verbose --permission-prompts none \
      --max-budget-usd "$USD_RUN" --max-turns "$MAXT" --strict-mcp-config "${mcp[@]}" \
      --append-system-prompt "$(run_context)" "$task" \
      > "$RUNDIR/stream.jsonl" 2> "$RUNDIR/stderr.log" < /dev/null &
  CPID=$!; write_status working
  trap 'kill_tree "$CPID"' TERM INT
  tail -n +1 -f --pid="$CPID" "$RUNDIR/stream.jsonl" | tail_loop "$CPID"
  wait "$CPID" 2>/dev/null
  local st; st=$(jq -r .state "$RUNDIR/status.json")
  case $st in
    done)            merge_step; exit 0;;
    budget_exceeded) escalate "$AGENT" "$VIA" "$RUN_ID budget_exceeded (cap \$$USD_RUN)"; exit 4;;
    stalled)         escalate "$AGENT" "$VIA" "$RUN_ID stalled: no stream event for ${STALL_SEC}s, killed"; exit 5;;
    *)               escalate "$AGENT" "$VIA" "$RUN_ID failed: $(jq -r '(.result // "") | .[0:200]' "$RUNDIR/result.json" 2>/dev/null || echo 'no result record')"; exit 3;;
  esac
}

# ---------- dispatch ----------
case "${1:-}" in
  lint) shift; cmd_lint "$@";;
  run)  shift; cmd_run "$@";;
  *) die "usage: mows-agent lint|run|list|last|logs|prune|render|residents …";;
esac
```

Note on `tail_loop` in a pipeline: it runs in a subshell, so it writes the final state to
`status.json` and the parent re-reads it. `write_status` needs `$RUNDIR $AGENT $RUN_ID $STARTED $CPID` which are set before the pipeline.

- [ ] **Step 4: Run the tests**

Run: `bash scripts/e2e-agents.sh 2>&1 | grep -E 'FAIL|passed'`
Expected: **`0 failed`**. The absolute total is whatever the assertions in this task's own
code block add to Task 1's 21 — count it and report it, do not tune assertions to hit a number.
If `run hang: killed within 15s` fails, check that `setsid` is on PATH and `read -t` received `STALL_SEC=2`.

- [ ] **Step 5: shellcheck + commit**

```bash
shellcheck -S error agents/bin/mows-agent scripts/e2e-agents.sh && ./scripts/preflight.sh | tail -1
git add agents/bin/mows-agent scripts/e2e-agents.sh
git commit -m "agents: mows-agent run — bounded claude -p, run records, stall kill, escalation (phase 1b)"
```

### Task 3: `list`, `last`, `logs`

**Files:**
- Modify: `agents/bin/mows-agent`
- Modify: `scripts/e2e-agents.sh`

**Interfaces:**
- Produces: `mows-agent list` → header + one row per agent: `NAME PROFILE LAST-STATE LAST-RUN NEXT`. `mows-agent last <name>` → `status.json` pretty + result summary. `mows-agent logs <name> [run_id] [--raw]` → assistant text, or the raw stream.

- [ ] **Step 1: Append failing tests** (before the summary line)

```bash
echo "### list / last / logs"
echo ok > "$CLAUDE_MODE_FILE"; mows-agent run good >/dev/null 2>&1
chk "list: header"                            'mows-agent list | head -1 | grep -q "^NAME"'
chk "list: good row with state done"          'mows-agent list | grep -E "^good +default +done"'
chk "list: loud row shows budget_exceeded"    'mows-agent list | grep -E "^loud +default +budget_exceeded"'
chk "list: NEXT from systemctl list-timers"   'mows-agent list | grep -E "^good" | grep -q "2026-09-16"'
chk "last: prints state + cost"               'mows-agent last good | grep -q "\"state\": \"done\"" && mows-agent last good | grep -q "stub says OK"'
chk "logs: assistant text only"               '[ "$(mows-agent logs good)" = "stub says OK" ]'
chk "logs --raw: the stream"                  'mows-agent logs good --raw | grep -q "\"type\":\"system\""'
chk "logs <run_id>: explicit run"             '[ "$(mows-agent logs good "$(jq -r .run_id "$S/last/status.json")")" = "stub says OK" ]'
```

- [ ] **Step 2: Run to verify failure**

Run: `bash scripts/e2e-agents.sh 2>&1 | grep -E '^FAIL: (list|last|logs)' | wc -l`
Expected: 8.

- [ ] **Step 3: Implement** (insert above dispatch; extend dispatch)

```bash
# ---------- list / last / logs ----------
next_fire(){ # NEXT column from the Phase 3 timer; '' when systemd/timer absent
  command -v systemctl >/dev/null 2>&1 || return 0
  local l; l=$(systemctl list-timers --all --no-legend "mows-agent-$1.timer" 2>/dev/null | head -1)
  [ -n "$l" ] || return 0
  case $l in n/a*|-*) echo paused;; *) awk '{print $1" "$2" "$3}' <<<"$l";; esac
}
cmd_list(){
  local n f m prof st last next
  printf '%-22s %-10s %-16s %-19s %s\n' NAME PROFILE LAST-STATE LAST-RUN NEXT
  while IFS=$'\t' read -r n f; do
    m=$(meta "$f") || continue; prof=$(mget "$m" .mows.profile)
    if [ -f "$STATE_ROOT/$n/last/status.json" ]; then
      st=$(jq -r .state "$STATE_ROOT/$n/last/status.json"); last=$(jq -r '.started_at[0:19]' "$STATE_ROOT/$n/last/status.json")
    else st=never; last=-; fi
    next=$(next_fire "$n"); printf '%-22s %-10s %-16s %-19s %s\n' "$n" "$prof" "$st" "$last" "${next:--}"
  done < <(all_agents)
}
cmd_last(){
  local n=${1:-}; [ -n "$n" ] || die "usage: mows-agent last <name>"
  local d="$STATE_ROOT/$n/last"; [ -f "$d/status.json" ] || die "no runs for $n"
  jq . "$d/status.json"
  [ -f "$d/result.json" ] && jq -r '"result: " + ((.result // "") | .[0:2000])' "$d/result.json"
  [ -s "$STATE_ROOT/$n/events.log" ] && { echo "recent events:"; tail -3 "$STATE_ROOT/$n/events.log"; }
  return 0
}
cmd_logs(){
  local n=${1:-} raw=0 rid="" a; [ -n "$n" ] || die "usage: mows-agent logs <name> [run_id] [--raw]"; shift
  for a in "$@"; do [ "$a" = --raw ] && raw=1 || rid=$a; done
  local d; d="$STATE_ROOT/$n/${rid:+runs/$rid}"; [ -n "$rid" ] || d="$STATE_ROOT/$n/last"
  [ -f "$d/stream.jsonl" ] || die "no stream for $n ${rid:-last}"
  if [ "$raw" = 1 ]; then cat "$d/stream.jsonl"
  else jq -r 'select(.type=="assistant") | .message.content[]? | select(.type=="text") | .text' "$d/stream.jsonl"; fi
}
```

Dispatch additions: `list) cmd_list;;  last) shift; cmd_last "$@";;  logs) shift; cmd_logs "$@";;`

- [ ] **Step 4: Run tests — expect `0 failed`; report the actual total; shellcheck; commit**

```bash
git add agents/bin/mows-agent scripts/e2e-agents.sh
git commit -m "agents: list / last / logs (phase 1c)"
```

### Task 4: Example agent, config seed, install layer, live smoke

**Files:**
- Create: `agents/examples/harness-reviewer.md`
- Create: `agents/config.example`
- Create: `scripts/live-agents.sh`
- Modify: `install.sh` (`--agents` flag, `layer_agents()`, `--all`, PATH prompt arithmetic)
- Modify: `scripts/manifest.txt`

**Interfaces:**
- Produces: `install.sh --agents` → `~/.local/bin/{mows-agent,mows-agent-meta}`, `~/.config/mows-agents/config` (seed once), `~/.claude/agents/harness-reviewer.md` (seed once), `~/.local/state/mows-agents/`.

- [ ] **Step 1: Write `agents/examples/harness-reviewer.md`**

```markdown
---
name: harness-reviewer
description: Standing read-only reviewer of the mows-harness repo — shell safety, leaked identifiers, README/architecture drift
model: sonnet
effort: high
tools: [Read, Glob, Grep, Bash]
disallowedTools: [Write, Edit, WebFetch, NotebookEdit]
permissionMode: default
maxTurns: 40
memory: user
mows:
  profile: default
  workdir: ~/Documents/Projects/mows-harness
  task: >-
    Review every commit on main since the newest commit recorded in your memory (all of the
    last 7 days if memory is empty). For each commit check: shell scripts for unquoted
    expansions, missing set -u, tmux calls without an explicit socket; any identifying
    literal that scripts/preflight.sh would flag; README.md and docs/architecture.md claims
    that the diff makes false. Print findings as a list with file:line, then a one-paragraph
    verdict. Finally update your memory with the newest commit hash you reviewed.
  budget:
    usd_per_run: 1.50
    max_turns: 40
    usd_per_day: 6.00
    quota_floor: 30
  triggers:
    - { type: cron, spec: "*-*-* 06:00:00" }
  merge:
    policy: none
  escalate:
    via: discord
  retention_days: 30
---
You are the standing reviewer for the mows-harness repository, a public MIT shell + node
harness that keeps Claude Code sessions alive on a server. You run unattended once a day.

Ground rules:
- You are read-only. Never attempt to write, commit, or push. Use `git log`, `git show`,
  `git diff` and grep to read.
- Prefer precise findings (file:line, the exact expansion) over general advice.
- The repo's own gates are `scripts/preflight.sh` and `scripts/e2e-*.sh`; if a commit changed
  a script, say whether those gates would catch a regression in it.
- Keep your memory short: newest reviewed commit, and at most five open concerns.
```

- [ ] **Step 2: Write `agents/config.example`**

```bash
# mows-agents config — sourced by mows-agent. Installed to ~/.config/mows-agents/config
# (only if absent; your edits are kept). chmod 600: it can hold webhook secrets.
# Discord webhook for escalations (channel settings -> Integrations -> Webhooks). Empty = log only.
DISCORD_WEBHOOK=
# Minutes without a stream event before a run is killed as stalled.
STALL_MIN=10
# MCP config for agent runs. Empty = NO MCP servers (--strict-mcp-config with no file).
# Point at a small file if an agent needs one; never at mcp-interactive.json wholesale.
MCP_CONFIG=
# Webhook trigger secrets (Phase 5): one per agent, name upper-cased, '-' -> '_'.
# WEBHOOK_SECRET_HARNESS_REVIEWER=
```

- [ ] **Step 3: Add `layer_agents()` to `install.sh`**

Edit the flag parser (line 52–54): add `--agents) L_AGENTS=1;;` and add `L_AGENTS=1` to `--all`. Initialise `L_AGENTS=0` where the other `L_*` defaults are set. Add the flag to the usage text near line 39 in the same style as `--agy`. Insert after `layer_agy(){…}`:

```bash
layer_agents(){
  echo "== agents (purpose-scoped agents, Layer 6) =="
  mkdir -p "$HOME/.local/bin" "$HOME/.config/mows-agents" "$HOME/.local/state/mows-agents" "$HOME/.claude/agents"
  install -m755 agents/bin/mows-agent agents/bin/mows-agent-meta "$HOME/.local/bin/"
  if [ ! -f "$HOME/.config/mows-agents/config" ]; then
    install -m600 agents/config.example "$HOME/.config/mows-agents/config"
    echo "seeded ~/.config/mows-agents/config — set DISCORD_WEBHOOK there for escalations"
  fi
  # the example agent is user-owned after first install: seed only if absent, never clobber
  if [ ! -f "$HOME/.claude/agents/harness-reviewer.md" ]; then
    install -m644 agents/examples/harness-reviewer.md "$HOME/.claude/agents/harness-reviewer.md"
    echo "seeded ~/.claude/agents/harness-reviewer.md — edit mows.workdir if this repo lives elsewhere"
  fi
  echo "installed: mows-agent mows-agent-meta -> ~/.local/bin"
  command -v jq >/dev/null 2>&1 || echo "WARN: jq not found — mows-agent requires jq: sudo apt-get install -y jq"
  python3 -c 'import yaml' 2>/dev/null || echo "WARN: python3 yaml missing — mows-agent lint requires it: sudo apt-get install -y python3-yaml"
  echo "next: mows-agent lint --all && mows-agent run harness-reviewer   (one bounded run, ~\$1.50 cap)"
}
```

Add `[ "$L_AGENTS" = 1 ] && layer_agents` after the `layer_agy` call, and include `L_AGENTS` in the PATH-prompt sum: `$((L_CLAUDE + L_WATCH + L_FLEET + L_AGY + L_AGENTS))`.

- [ ] **Step 4: Write `scripts/live-agents.sh`**

```bash
#!/usr/bin/env bash
# live-agents — ONE real `claude -p` run through mows-agent (haiku, $0.05 cap, 1 turn).
# Covers what scripts/e2e-agents.sh cannot: real auth, the real stream-json result record,
# agent-memory creation. Costs ~$0.05 of the default profile's quota. Never run by CI.
set -u
cd "$(dirname "$0")/.."
if [ "${1:-}" != "--yes" ]; then
  echo "live-agents: runs ONE real haiku call via mows-agent (~\$0.05). Run for real: scripts/live-agents.sh --yes"; exit 0
fi
BIN=${BIN_DIR:-$PWD/agents/bin}
export MOWS_AGENTS_STATE; MOWS_AGENTS_STATE=$(mktemp -d)
export MOWS_AGENT_META="$BIN/mows-agent-meta"
A="$HOME/.claude/agents/mows-live-probe.md"
trap 'rm -f "$A"; rm -rf "$MOWS_AGENTS_STATE" "$HOME/.claude/agent-memory/mows-live-probe"' EXIT
cat > "$A" <<EOF
---
name: mows-live-probe
description: throwaway probe for scripts/live-agents.sh
model: haiku
tools: [Read]
disallowedTools: [Write, Edit, Bash, WebFetch]
maxTurns: 1
memory: user
mows:
  profile: default
  workdir: $PWD
  task: Reply with exactly OK
  budget: { usd_per_run: 0.05, max_turns: 1 }
---
You are a probe. Reply with exactly OK and nothing else.
EOF
PASS=0; FAIL=0; ok(){ echo "PASS: $*"; PASS=$((PASS+1)); }; no(){ echo "FAIL: $*"; FAIL=$((FAIL+1)); }
chk(){ if eval "$2" >/dev/null 2>&1; then ok "$1"; else no "$1"; fi; }
chk "lint clean" "$BIN/mows-agent lint mows-live-probe"
"$BIN/mows-agent" run mows-live-probe; RC=$?
S="$MOWS_AGENTS_STATE/mows-live-probe/last"
chk "run exit 0"                 '[ "$RC" = 0 ]'
chk "state done"                 '[ "$(jq -r .state "$S/status.json")" = done ]'
chk "real cost > 0"              'jq -e ".cost_usd > 0" "$S/status.json"'
chk "result says OK"             'jq -r .result "$S/result.json" | grep -q OK'
chk "no permission denials"      '[ "$(jq -r .permission_denials "$S/status.json")" = 0 ]'
chk "agent memory dir created"   '[ -d "$HOME/.claude/agent-memory/mows-live-probe" ]'
echo "live-agents: $PASS passed, $FAIL failed"; [ "$FAIL" -eq 0 ]
```

- [ ] **Step 5: Run everything**

```bash
bash scripts/e2e-agents.sh | tail -1            # 73 passed
./install.sh --agents                            # on the box, real install
mows-agent lint --all && mows-agent list         # harness-reviewer, never
scripts/live-agents.sh --yes | tail -1           # 7 passed (costs ~$0.05)
./scripts/preflight.sh | tail -1                 # ALL CLEAN after manifest update
```

- [ ] **Step 6: Manifest + commit**

```bash
printf '%s\n' agents/examples/harness-reviewer.md agents/config.example scripts/live-agents.sh >> scripts/manifest.txt
git add agents install.sh scripts/live-agents.sh scripts/manifest.txt
git commit -m "agents: install.sh --agents, harness-reviewer example, live smoke (phase 1 complete)"
```

**Phase 1 gate:** run `mows-agent run harness-reviewer` by hand once a day for a week (or until three runs are `done`). Read `mows-agent last harness-reviewer` and the memory file. Only then start Phase 2.

---

# Phase 2 — Budget tiers, prune, merge policy

### Task 5: Daily cap, quota floor, concurrency refusals + `prune`

**Files:**
- Modify: `agents/bin/mows-agent` (`cmd_prune`, dispatch)
- Modify: `scripts/e2e-agents.sh`

(Tier-2/3 and concurrency logic already exist in `cmd_run` from Task 2; this task proves them and adds `prune`.)

- [ ] **Step 1: Append failing tests**

```bash
echo "### budget tiers + concurrency + prune"
mkagent "$A/capped.md" "$(sed 's/budget: .*/budget: { usd_per_run: 1.5, max_turns: 40, usd_per_day: 0.01, quota_floor: 30 }/' <<<"$MOWS_BLOCK_OK")"
echo '{"personal":{"five_hour_pct":10,"weekly_pct":5},"work":{"five_hour_pct":90,"weekly_pct":5}}' > "$QUOTA_FILE"
echo ok > "$CLAUDE_MODE_FILE"
# stub run costs 0.0123; cap 0.01 -> run 1 allowed (spend was 0), run 2 refused (0.0123 >= 0.01)
chk "cap: first run allowed (spend was 0)"    'mows-agent run capped'
chk "cap: second run refused, exit 6"         'mows-agent run capped >/dev/null 2>&1; [ $? = 6 ]'
chk "cap: refusal logged"                     'grep -q "daily cap" "$MOWS_AGENTS_STATE/capped/events.log"'
chk "cap: refusal made no second run dir"     '[ "$(ls "$MOWS_AGENTS_STATE/capped/runs" | wc -l)" = 1 ]'
echo '{"personal":{"five_hour_pct":75,"weekly_pct":5}}' > "$QUOTA_FILE"
mkagent "$A/floored.md" "$(sed 's/budget: .*/budget: { usd_per_run: 1.5, max_turns: 40, quota_floor: 30 }/' <<<"$MOWS_BLOCK_OK")"
mows-agent run floored >/dev/null 2>&1; RC=$?
chk "quota: 75% used > 70% ceiling -> refuse 6" '[ "$RC" = 6 ] && grep -q "quota below 30%" "$MOWS_AGENTS_STATE/floored/events.log"'
echo '{"personal":{"five_hour_pct":60,"weekly_pct":5}}' > "$QUOTA_FILE"
chk "quota: 60% used passes floor 30"         'mows-agent run floored'
echo '{"personal":{"five_hour_pct":null,"weekly_pct":null,"source":"unknown"}}' > "$QUOTA_FILE"
chk "quota: unknown never refuses"            'mows-agent run floored'
mkagent "$HOME/.claude-work/agents/wk.md" "$(sed 's/profile: default/profile: work/; s/budget: .*/budget: { usd_per_run: 1, max_turns: 5, quota_floor: 30 }/' <<<"$MOWS_BLOCK_OK")"
echo '{"personal":{"five_hour_pct":0},"work":{"five_hour_pct":95}}' > "$QUOTA_FILE"
chk "quota: work profile reads .work"         'mows-agent run wk >/dev/null 2>&1; [ $? = 6 ]'
chk "quota: work profile CLAUDE_CONFIG_DIR"   'echo "{}" > "$QUOTA_FILE"; mows-agent run wk && grep -qx "CLAUDE_CONFIG_DIR=$HOME/.claude-work" "$CLAUDE_ARGS_FILE"'
# concurrency: a live `working` record with a real pid refuses a second run
sleep 300 & SP=$!
mkdir -p "$MOWS_AGENTS_STATE/good/runs/fake"; ln -sfn runs/fake "$MOWS_AGENTS_STATE/good/last"
jq -n --argjson p "$SP" '{state:"working",pid:$p}' > "$MOWS_AGENTS_STATE/good/runs/fake/status.json"
mows-agent run good >/dev/null 2>&1; RC=$?
chk "concurrency: live working run refuses"   '[ "$RC" = 6 ] && grep -q "still working" "$MOWS_AGENTS_STATE/good/events.log"'
kill $SP; wait $SP 2>/dev/null
chk "concurrency: dead pid does not block"    'mows-agent run good'
rm -rf "$MOWS_AGENTS_STATE/good/runs/fake"
# prune
mkagent "$A/short.md" "$(printf '%s\n  retention_days: 5' "$MOWS_BLOCK_OK")"
mows-agent run short >/dev/null 2>&1
mkdir -p "$MOWS_AGENTS_STATE/short/runs/20200101-000000-1"; touch -d '40 days ago' "$MOWS_AGENTS_STATE/short/runs/20200101-000000-1"
mkdir -p "$MOWS_AGENTS_STATE/good/runs/20200102-000000-1";  touch -d '20 days ago' "$MOWS_AGENTS_STATE/good/runs/20200102-000000-1"
# Age the `last` target too, so the keep-exemption is the ONLY thing standing between it and
# deletion. Without this the assertion below passes even with the exemption line removed: a
# just-created dir is never an -mtime candidate, so find would not have offered it up at all.
touch -d '40 days ago' "$MOWS_AGENTS_STATE/short/$(readlink "$MOWS_AGENTS_STATE/short/last")"
mows-agent prune >/dev/null 2>&1
chk "prune: 40d-old run gone (retention 5)"   '[ ! -d "$MOWS_AGENTS_STATE/short/runs/20200101-000000-1" ]'
chk "prune: 20d-old run kept (retention 30)"  '[ -d "$MOWS_AGENTS_STATE/good/runs/20200102-000000-1" ]'
chk "prune: last target never pruned"         '[ -d "$MOWS_AGENTS_STATE/short/$(readlink "$MOWS_AGENTS_STATE/short/last")" ]'
rm -rf "$MOWS_AGENTS_STATE/good/runs/20200102-000000-1"
```

- [ ] **Step 2: Run to see the `prune` lines fail** (the refusal lines should already pass from Task 2; if any refusal line fails, fix `cmd_run` before adding `prune`).

- [ ] **Step 3: Implement `cmd_prune`**

```bash
cmd_prune(){ # delete run dirs older than retention_days per agent; never the `last` target
  local n f m days d keep r
  while IFS=$'\t' read -r n f; do
    m=$(meta "$f") || continue; days=$(mget "$m" .mows.retention_days); days=${days:-30}
    d="$STATE_ROOT/$n/runs"; [ -d "$d" ] || continue
    keep=$(readlink "$STATE_ROOT/$n/last" 2>/dev/null); keep=${keep#runs/}
    while IFS= read -r r; do
      [ "$(basename "$r")" = "$keep" ] && continue
      rm -rf "$r" && event "$n" "pruned $(basename "$r") (> ${days}d)"
    done < <(find "$d" -mindepth 1 -maxdepth 1 -type d -mtime "+$days")
  done < <(all_agents)
}
```

Dispatch: `prune) cmd_prune;;`

- [ ] **Step 4: Run tests — expect `0 failed`; report the actual total; shellcheck; commit**

```bash
git commit -am "agents: budget tiers proven, prune (phase 2a)"
```

### Task 6: `merge.policy: pr`

**Files:**
- Modify: `scripts/e2e-agents.sh`
- (`merge_step` already exists from Task 2; this task proves it against a stub `gh` and a real local git repo.)

- [ ] **Step 1: Append failing tests**

```bash
echo "### merge.policy pr"
git init -q "$T/repo" && git -C "$T/repo" -c user.email=t@t -c user.name=t commit -q --allow-empty -m base
git -C "$T/repo" branch -M main; git -C "$T/repo" checkout -q -b agent/fix
git -C "$T/repo" -c user.email=t@t -c user.name=t commit -q --allow-empty -m "agent change"
git init -q --bare "$T/origin.git"; git -C "$T/repo" remote add origin "$T/origin.git"
# mkagent overrides are YAML lines appended after the base block: indent two spaces to land inside mows:
mkagent "$A/prbot.md" "$(sed "s|workdir: .*|workdir: $T/repo|" <<<"$MOWS_BLOCK_OK")" "  merge: { policy: pr, base: main }"
sed -i 's/^disallowedTools: .*/disallowedTools: [WebFetch]/' "$A/prbot.md"
echo ok > "$CLAUDE_MODE_FILE"
chk "pr: lint passes with stub gh"           'mows-agent lint prbot'
chk "pr: run done"                            'mows-agent run prbot'
chk "pr: branch pushed to origin"             'git -C "$T/origin.git" rev-parse --verify agent/fix'
chk "pr: gh pr create --base main called"     'grep -q "pr create --fill --base main" "$GH_LOG"'
chk "pr: event logged"                        'grep -q "PR opened from agent/fix" "$MOWS_AGENTS_STATE/prbot/events.log"'
git -C "$T/repo" checkout -q main
chk "pr: on base branch is a logged no-op"    'mows-agent run prbot && grep -q "still on main" "$MOWS_AGENTS_STATE/prbot/events.log"'
```

- [ ] **Step 2: Run tests — expect `0 failed`; report the actual total; commit**

```bash
git commit -am "agents: merge.policy pr proven against a local origin (phase 2 complete)"
```

**Phase 2 gate:** set `DISCORD_WEBHOOK` in the box config, temporarily set `usd_per_day: 0.01` on `harness-reviewer`, run it twice: the second must refuse and a Discord message must arrive. Restore the cap.

---

# Phase 3 — Triggers: systemd timers and path units

### Task 7: `mows-agent render`

**Files:**
- Modify: `agents/bin/mows-agent` (`cmd_render`, dispatch)
- Modify: `install.sh` (`layer_agents` renders + prints sudo lines)
- Modify: `scripts/e2e-agents.sh`

**Interfaces:**
- Produces in `$RENDER_DIR`: `mows-agent@.service` (once), `mows-agent-<name>.timer` per cron trigger (a second cron trigger on the same agent becomes `mows-agent-<name>-2.timer`), `mows-agent-<name>.path` per path trigger (`-2` likewise). Prints the sudo install/enable lines.

- [ ] **Step 1: Append failing tests**

```bash
echo "### render"
export RENDER_DIR="$T/rendered"
mkagent "$A/timed.md" "$(printf '%s\n  triggers:\n    - {type: cron, spec: "*-*-* 06:00:00"}\n    - {type: cron, spec: "Mon *-*-* 09:00:00"}\n    - {type: path, path: %s/work/.git/refs/heads/main}' "$MOWS_BLOCK_OK" "$T")"
chk "render: exits 0"                          'mows-agent render timed'
chk "render: service template once"            'grep -q "^ExecStart=$HOME/.local/bin/mows-agent run %i" "$RENDER_DIR/mows-agent@.service"'
chk "render: service is oneshot as this user"  'grep -q "^Type=oneshot" "$RENDER_DIR/mows-agent@.service" && grep -q "^User=$(id -un)" "$RENDER_DIR/mows-agent@.service"'
chk "render: service unsets API key"           'grep -q "^UnsetEnvironment=ANTHROPIC_API_KEY" "$RENDER_DIR/mows-agent@.service"'
chk "render: TimeoutStartSec = max_turns*3min" 'grep -q "^TimeoutStartSec=7200" "$RENDER_DIR/mows-agent@.service"'
chk "render: first timer"                      'grep -q "^OnCalendar=\*-\*-\* 06:00:00" "$RENDER_DIR/mows-agent-timed.timer" && grep -q "^Persistent=true" "$RENDER_DIR/mows-agent-timed.timer"'
chk "render: second timer suffixed -2"         'grep -q "^OnCalendar=Mon" "$RENDER_DIR/mows-agent-timed-2.timer"'
chk "render: timer points at the instance"     'grep -q "^Unit=mows-agent@timed.service" "$RENDER_DIR/mows-agent-timed.timer"'
chk "render: path unit"                        'grep -q "^PathChanged=$T/work/.git/refs/heads/main" "$RENDER_DIR/mows-agent-timed.path" && grep -q "^Unit=mows-agent@timed.service" "$RENDER_DIR/mows-agent-timed.path"'
chk "render: prints sudo lines, enables nothing" 'mows-agent render timed | grep -q "sudo install" && ! grep -q "enable" "$SYSTEMCTL_LOG"'
chk "render --all covers timed"                'rm -rf "$RENDER_DIR"; mows-agent render --all >/dev/null && [ -f "$RENDER_DIR/mows-agent-timed.timer" ]'
```

- [ ] **Step 2: Run to verify failure; then implement**

```bash
# ---------- render: systemd units -> $RENDER_DIR (never installed or enabled here; spec D8) ----------
render_service(){ # one shared template; TimeoutStartSec = the largest max_turns * 3 min across agents
  local n f m t maxt=40
  while IFS=$'\t' read -r n f; do m=$(meta "$f") || continue; t=$(mget "$m" .mows.budget.max_turns); [ "${t:-0}" -gt "$maxt" ] && maxt=$t; done < <(all_agents)
  cat > "$RENDER_DIR/mows-agent@.service" <<EOF
[Unit]
Description=mows agent run: %i (Layer 6, one bounded claude -p)
Documentation=file://$HOME/.local/bin/mows-agent
After=network-online.target
Wants=network-online.target

[Service]
Type=oneshot
User=$(id -un)
Environment=HOME=$HOME
UnsetEnvironment=ANTHROPIC_API_KEY
WorkingDirectory=$HOME
# generous: a run is already capped by --max-turns / --max-budget-usd and the stall kill
TimeoutStartSec=$((maxt * 180))
ExecStart=$HOME/.local/bin/mows-agent run %i
# exit 6 (refused) and 4 (budget) are policy outcomes, not unit failures
SuccessExitStatus=4 6
EOF
}
cmd_render(){
  local names=() n f m i=0 ci=0 pi=0 sfx t
  mkdir -p "$RENDER_DIR"
  if [ "${1:-}" = --all ]; then while IFS=$'\t' read -r n f; do names+=("$n"); done < <(all_agents)
  else [ -n "${1:-}" ] || die "usage: mows-agent render <name>|--all"; names=("$1"); fi
  render_service
  for n in "${names[@]}"; do
    f=$(agent_file "$n") || exit 64; [ -n "$f" ] || die "no agent named $n"; m=$(meta "$f")
    ci=0; pi=0
    while IFS= read -r t; do
      case $(jq -r .type <<<"$t") in
        cron) ci=$((ci+1)); sfx=""; [ $ci -gt 1 ] && sfx="-$ci"
              cat > "$RENDER_DIR/mows-agent-$n$sfx.timer" <<EOF
[Unit]
Description=mows agent timer: $n$sfx

[Timer]
OnCalendar=$(jq -r .spec <<<"$t")
Persistent=true
RandomizedDelaySec=2m
Unit=mows-agent@$n.service

[Install]
WantedBy=timers.target
EOF
              ;;
        path) pi=$((pi+1)); sfx=""; [ $pi -gt 1 ] && sfx="-$pi"
              cat > "$RENDER_DIR/mows-agent-$n$sfx.path" <<EOF
[Unit]
Description=mows agent path trigger: $n$sfx

[Path]
PathChanged=$(expand_tilde "$(jq -r .path <<<"$t")")
Unit=mows-agent@$n.service

[Install]
WantedBy=multi-user.target
EOF
              ;;
      esac
    done < <(jq -c '.mows.triggers[]? // empty' <<<"$m")
  done
  echo "rendered into $RENDER_DIR — review, then (nothing below is run for you):"
  echo "  sudo install -m644 $RENDER_DIR/mows-agent@.service $RENDER_DIR/mows-agent-*.timer $RENDER_DIR/mows-agent-*.path /etc/systemd/system/ 2>/dev/null; sudo systemctl daemon-reload"
  for n in "${names[@]}"; do
    for u in "$RENDER_DIR"/mows-agent-"$n"*.timer "$RENDER_DIR"/mows-agent-"$n"*.path; do [ -f "$u" ] && echo "  sudo systemctl enable --now $(basename "$u")"; done
  done
  echo "  systemctl list-timers 'mows-agent-*'    # confirm NEXT; mows-agent list shows it too"
}
```

Dispatch: `render) shift; cmd_render "$@";;`

In `install.sh` `layer_agents()`, after installing bins add:

```bash
  RENDER_DIR="$PWD/rendered" "$HOME/.local/bin/mows-agent" render --all 2>/dev/null || echo "WARN: render skipped (lint errors? run: mows-agent lint --all)"
```

- [ ] **Step 3: Run tests — expect `0 failed`; report the actual total; shellcheck; commit**

```bash
git commit -am "agents: render systemd timer/path units into rendered/ (phase 3)"
```

**Phase 3 gate (on the box):** `mows-agent render --all`, run the printed sudo lines for `mows-agent-harness-reviewer.timer`, then leave it for three days. Pass when `mows-agent list` shows three `done` rows at 06:00 with no human input, and `journalctl -u mows-agent@harness-reviewer` shows clean exits.

---

# Phase 4 — Dashboard `/agents`

### Task 8: Agents index + list/detail/run views + actions

**Files:**
- Modify: `infra/dashboard/lite.mjs`
  - nav: both `pnav` and `tabs` blocks in `page()` (≈ lines 2013–2025) get an Agents entry after System
  - speculation rules (≈ line 2037): add `"/agents","/agents?*","/agents/*"` to `href_matches`, add `a[href^='/agents/'][href*='/2']` is **not** enough to exclude run pages; instead exclude with a selector `a[data-norun]` placed on run links
  - routes in the `createServer` dispatcher (≈ line 2737): `/agents`, `/agents/<name>`, `/agents/<name>/<run_id>`, `/a/agent-run`, `/a/agent-pause`, `/a/agent-resume`, `/a/agent-stop`
- Create: `docs/qa/journeys/agents-tab.md`

**Interfaces:**
- Consumes: run records from Phase 1 (`status.json`, `result.json`, `stream.jsonl`, `events.log`), the Phase 3 unit names.
- Produces: `agentsIndex()` → `[{name,last,recs,cost7d,total}]` cached 3 s; views `agentsView`, `agentDetailView`, `agentRunView`; POST action `agentAction`.

- [ ] **Step 1: Write the journey first** — `docs/qa/journeys/agents-tab.md` (run with `/qa run agents-tab` against the box; it is the browser test for this task)

```markdown
---
mode: headless
target: http://127.0.0.1:3005
---
# Agents tab

1. Open `/`. Expect a nav link with text "Agents" in both the desktop pill nav and the mobile tab bar.
2. Resize to 375×812. Expect the mobile tab bar to show five tabs without horizontal overflow (no tab label clipped; document.scrollingElement.scrollWidth <= 375).
3. Click "Agents". Expect URL `/agents`, an `h1` containing "agents", and a card/row for `harness-reviewer` showing a state pill (one of working/done/failed/budget_exceeded/stalled/never) and "7d $".
4. Click `harness-reviewer`. Expect URL `/agents/harness-reviewer`, a "Runs" list with at least one row (if Phase 3 has run) each linking to `/agents/harness-reviewer/<run_id>`, a "Next" line, and buttons "Run now", "Pause"/"Resume", "Stop".
5. Click the newest run. Expect the assistant text of that run rendered in `<article>` and a status block with `state`, `cost_usd`, `turns`.
6. Go back. Click "Pause" (a POST). Expect a 303 back to the detail page and the button now reading "Resume". Click "Resume" to restore.
7. Do NOT click "Run now" or "Stop" in this journey (they cost money / kill a live run).
```

- [ ] **Step 2: Add the index and views to `lite.mjs`** (insert before `// ---------- server ----------`)

```js
// ---------- /agents: Layer 6 purpose-scoped agents (spec 2026-09-15 §8) ----------
// Data = the run records mows-agent writes; rescanned per request behind a 3s cache, NEVER
// at startup (discoverAccounts() is startup-only and the spec calls that staleness out).
const AGENTS_STATE = TMUX_HOME + '/.local/state/mows-agents';
const AGENT_RE = /^[a-z0-9][a-z0-9-]{0,63}$/;
const RUN_RE = /^\d{8}-\d{6}-\d+$/;
const AGENT_BAD = new Set(['stalled', 'failed', 'budget_exceeded']);
const agentsCache = { t: 0, v: [] };
async function agentsIndex() {
  if (Date.now() - agentsCache.t < 3000) return agentsCache.v;
  const out = [];
  let names = []; try { names = await fsp.readdir(AGENTS_STATE); } catch {}
  for (const name of names) {
    if (!AGENT_RE.test(name)) continue;
    const dir = `${AGENTS_STATE}/${name}`;
    let runs = []; try { runs = (await fsp.readdir(`${dir}/runs`)).filter(r => RUN_RE.test(r)).sort().reverse(); } catch {}
    const recs = [];
    for (const r of runs.slice(0, 20)) {
      try { recs.push({ ...JSON.parse(await fsp.readFile(`${dir}/runs/${r}/status.json`, 'utf8')), run_id: r }); } catch {}
    }
    const last = recs[0] || null;
    // a `working` record whose runner pid is gone is a crash, not a live run
    if (last && last.state === 'working' && last.pid) { try { process.kill(last.pid, 0); } catch { last.state = 'failed'; last.crashed = true; } }
    const week = Date.now() - 7 * 864e5;
    const cost7d = recs.filter(x => Date.parse(x.started_at) > week).reduce((a, x) => a + (+x.cost_usd || 0), 0);
    let events = []; try { events = readFileSync(`${dir}/events.log`, 'utf8').trim().split('\n').slice(-5); } catch {}
    out.push({ name, last, recs, cost7d, total: runs.length, events });
  }
  const rank = s => s === 'working' ? 0 : AGENT_BAD.has(s) ? 1 : 2;
  out.sort((a, b) => rank(a.last?.state) - rank(b.last?.state)
    || Date.parse(b.last?.last_event_at || 0) - Date.parse(a.last?.last_event_at || 0));
  agentsCache.t = Date.now(); agentsCache.v = out; return out;
}
async function agentTimer(name) { // NEXT of the Phase 3 timer: '' (no timer) | 'paused' | 'Tue 2026-09-16 06:00:00 UTC'
  const o = await sh('systemctl', ['list-timers', '--all', '--no-legend', `mows-agent-${name}.timer`]);
  const l = (o || '').trim().split('\n')[0] || '';
  if (!l) return '';
  return /^(n\/a|-)/.test(l) ? 'paused' : l.split(/\s+/).slice(0, 3).join(' ');
}
const agentPill = s => `<span class="pill st-${esc(s || 'never')}">${esc(s || 'never')}</span>`;
const usd = n => '$' + (+n || 0).toFixed(2);
async function agentsView(req, res) {
  const list = await agentsIndex();
  const rows = list.map(a => `<a class="agent card" href="/agents/${esc(a.name)}">
<b>${esc(a.name)}</b> ${agentPill(a.last?.state)}
<span class="muted">${a.last ? rel(Date.parse(a.last.last_event_at)) : 'never ran'} · ${a.total} runs · 7d ${usd(a.cost7d)}</span></a>`).join('');
  const body = `<h1><a href="/">← sessions</a> <span class="muted">· agents</span></h1>
${rows || '<p class="muted">No agents yet. <code>install.sh --agents</code> seeds <code>harness-reviewer</code>; <code>mows-agent run harness-reviewer</code> makes the first record.</p>'}`;
  send(req, res, 200, page('agents · mows control', body, '', '', 'agents', false, null, req.headers.host));
}
async function agentDetailView(req, res, name) {
  if (!AGENT_RE.test(name)) { res.writeHead(404); return res.end(); }
  const a = (await agentsIndex()).find(x => x.name === name);
  if (!a) { res.writeHead(404); return res.end('no such agent'); }
  const next = await agentTimer(name);
  const back = `/agents/${esc(name)}`;
  const btn = (act, label) => `<form method="post" action="/a/agent-${act}"><input type="hidden" name="name" value="${esc(name)}"><input type="hidden" name="back" value="${back}"><button>${label}</button></form>`;
  const runs = a.recs.map(r => `<li><a data-norun href="/agents/${esc(name)}/${esc(r.run_id)}">${esc(r.run_id)}</a> ${agentPill(r.state)} <span class="muted">${usd(r.cost_usd)} · ${r.turns} turns · ${r.tool_calls} tools</span></li>`).join('');
  const body = `<h1><a href="/agents">← agents</a> <span class="muted">· ${esc(name)}</span></h1>
<p>${agentPill(a.last?.state)} <span class="muted">7d ${usd(a.cost7d)} · ${a.total} runs · Next: ${esc(next || 'no timer')}</span></p>
<div class="actions">${btn('run', 'Run now')}${next === 'paused' ? btn('resume', 'Resume') : btn('pause', 'Pause')}${a.last?.state === 'working' ? btn('stop', 'Stop') : ''}</div>
<h2>Runs</h2><ul class="runs">${runs || '<li class="muted">none</li>'}</ul>
<h2>Events</h2><pre class="events">${esc(a.events.join('\n') || 'none')}</pre>`;
  send(req, res, 200, page(`${name} · agents`, body, '', '', 'agents', false, null, req.headers.host));
}
async function agentRunView(req, res, name, run) {
  if (!AGENT_RE.test(name) || !RUN_RE.test(run)) { res.writeHead(404); return res.end(); }
  const dir = `${AGENTS_STATE}/${name}/runs/${run}`;
  let status = null, text = '';
  try { status = JSON.parse(await fsp.readFile(`${dir}/status.json`, 'utf8')); } catch { res.writeHead(404); return res.end('no such run'); }
  try {
    for (const l of (await fsp.readFile(`${dir}/stream.jsonl`, 'utf8')).split('\n')) {
      if (!l.includes('"type":"assistant"')) continue;
      try { for (const c of JSON.parse(l).message?.content || []) if (c.type === 'text') text += c.text + '\n\n'; } catch {}
    }
  } catch {}
  const body = `<h1><a href="/agents/${esc(name)}">← ${esc(name)}</a> <span class="muted">· ${esc(run)}</span></h1>
<pre class="status">${esc(JSON.stringify(status, null, 1))}</pre>
<article class="mdv">${esc(text || '(no assistant text)')}</article>`;
  send(req, res, 200, page(`${run} · ${name}`, body, '', '', 'agents', false, null, req.headers.host));
}
async function agentAction(req, res, act) {
  if (req.method !== 'POST') { res.writeHead(405); return res.end('POST only'); }
  const b = await readBody(req);
  const name = b.name || '';
  const bk = b.back || '/agents';
  const back = bk.startsWith('/') && !bk.startsWith('//') ? bk : '/agents';
  if (!AGENT_RE.test(name)) { res.writeHead(400); return res.end('bad name'); }
  if (act === 'run') await sh('systemctl', ['start', '--no-block', `mows-agent@${name}.service`]);
  else if (act === 'pause') await sh('systemctl', ['mask', '--now', `mows-agent-${name}.timer`]);
  else if (act === 'resume') { await sh('systemctl', ['unmask', `mows-agent-${name}.timer`]); await sh('systemctl', ['start', `mows-agent-${name}.timer`]); }
  else if (act === 'stop') {
    const a = (await agentsIndex()).find(x => x.name === name);
    if (a?.last?.state === 'working' && a.last.pid) { try { process.kill(a.last.pid, 'SIGTERM'); } catch {} } // runner traps TERM -> kills claude's group
  } else { res.writeHead(404); return res.end(); }
  agentsCache.t = 0;
  res.writeHead(303, { location: back }); res.end();
}
```

- [ ] **Step 3: Wire routes, nav, speculation, CSS**

In the dispatcher, next to the `/events` line:

```js
    if (p === '/agents') return await agentsView(req, res);
    if (p.startsWith('/agents/')) {
      const [name, run] = p.slice(8).split('/');
      return run ? await agentRunView(req, res, name, run) : await agentDetailView(req, res, name);
    }
    if (p.startsWith('/a/agent-')) return await agentAction(req, res, p.slice(9));
```

In `page()`: after the System link in `pnav` add
`<a class="${tab === 'agents' ? 'on' : ''}" href="/agents">Agents</a>`
and in `tabs` add
`<a class="tb${tab === 'agents' ? ' on' : ''}" href="/agents"><span class="ti">${ICO.wrench}</span>Agents</a>`.
Update the comment above `termFab` ("exactly 4") to say five content tabs since 2026-09-15 (Agents), terminal still a FAB.

Speculation rules: extend `href_matches` with `"/agents","/agents?*","/agents/*"` and extend the `not.selector_matches` with `,a[data-norun]` (run pages read whole streams; never prerender them).

CSS (append to the main stylesheet string): `.pill{padding:1px 6px;border-radius:9px;font-size:.75em}.st-working{background:#2563eb33}.st-done{background:#16a34a33}.st-failed,.st-stalled,.st-budget_exceeded{background:#dc262633}.st-never{background:#71717a33}.actions{display:flex;gap:8px;margin:8px 0}.actions form{display:inline}.runs li{margin:4px 0}`.

- [ ] **Step 4: Deploy to the box and run the journey**

```bash
node --check infra/dashboard/lite.mjs
sudo install -m644 infra/dashboard/lite.mjs /opt/claude-dashboard/lite.mjs && sudo systemctl restart claude-dash-lite
curl -s -o /dev/null -w '%{http_code}\n' http://127.0.0.1:3005/agents      # 200
curl -s http://127.0.0.1:3005/agents | grep -c harness-reviewer            # >= 1
```

Then invoke the `qa` skill: `/qa run agents-tab`. Fix until green (the 375 px five-tab check is the one most likely to need a CSS tweak: shrink `.tabs .tb` font or hide `.tb` labels under 360 px).

- [ ] **Step 5: e2e-infra assertion + commit**

Append to `scripts/e2e-infra.sh` after the dashboard checks:
`chk "dashboard: /agents renders" 'curl -sf http://127.0.0.1:3005/agents | grep -q "· agents"'`

```bash
printf '%s\n' docs/qa/journeys/agents-tab.md >> scripts/manifest.txt
git add infra/dashboard/lite.mjs scripts/e2e-infra.sh docs/qa scripts/manifest.txt
git commit -m "dashboard: /agents tab — list, detail, run stream, run-now/pause/resume/stop (phase 4)"
```

**Phase 4 gate:** journey green on the box; the tab shows the Phase 3 history.

---

# Phase 5 — Webhook ingress

### Task 9: `POST /wh/<name>` with HMAC + Caddy carve-out

**Files:**
- Modify: `infra/dashboard/lite.mjs` (import `createHmac, timingSafeEqual`; `agentsConfig()`, `webhookView`; route)
- Modify: `infra/caddy/Caddyfile.template` (`handle /wh/*` before `forward_auth`)
- Modify: `scripts/e2e-infra.sh` (accept/reject checks)

**Interfaces:**
- Consumes: `~/.config/mows-agents/config` line `WEBHOOK_SECRET_<NAME>=…`; the Phase 3 `mows-agent@.service`.
- Produces: 202 on a valid signature (`X-Mows-Signature` or `X-Hub-Signature-256`, both `sha256=<hex>`), 401 bad signature, 404 unknown agent/no secret, 405 non-POST, 413 body > 1 MB. Body is never forwarded.

- [ ] **Step 1: Write the failing e2e-infra checks**

`e2e-infra.sh` boots `lite.mjs` with `HOME=$DH` (line 27). Before that line add:

```bash
mkdir -p "$DH/.config/mows-agents"; echo 'WEBHOOK_SECRET_HARNESS_REVIEWER=s3cret' > "$DH/.config/mows-agents/config"
```

After the dashboard checks add:

```bash
SIG="sha256=$(printf '{"ref":"refs/heads/main"}' | openssl dgst -sha256 -hmac s3cret | awk '{print $NF}')"
chk "webhook: good HMAC -> 202"      '[ "$(curl -s -o /dev/null -w "%{http_code}" -X POST -H "X-Mows-Signature: $SIG" --data-binary "{\"ref\":\"refs/heads/main\"}" http://127.0.0.1:3005/wh/harness-reviewer)" = 202 ]'
chk "webhook: GitHub header accepted" '[ "$(curl -s -o /dev/null -w "%{http_code}" -X POST -H "X-Hub-Signature-256: $SIG" --data-binary "{\"ref\":\"refs/heads/main\"}" http://127.0.0.1:3005/wh/harness-reviewer)" = 202 ]'
chk "webhook: bad HMAC -> 401"       '[ "$(curl -s -o /dev/null -w "%{http_code}" -X POST -H "X-Mows-Signature: sha256=00" --data-binary "{}" http://127.0.0.1:3005/wh/harness-reviewer)" = 401 ]'
chk "webhook: no secret -> 404"      '[ "$(curl -s -o /dev/null -w "%{http_code}" -X POST --data-binary "{}" http://127.0.0.1:3005/wh/nobody)" = 404 ]'
chk "webhook: GET -> 405"            '[ "$(curl -s -o /dev/null -w "%{http_code}" http://127.0.0.1:3005/wh/harness-reviewer)" = 405 ]'
chk "caddy: /wh/* bypasses the auth gate" '[ "$(curl -s -o /dev/null -w "%{http_code}" -X POST --data-binary "{}" http://127.0.0.1/wh/nobody)" = 404 ]'
```

(Inside the container `systemctl start` is not available; `webhookView` ignores that error and still answers 202, which is what these checks assert.)

- [ ] **Step 2: Implement in `lite.mjs`**

Change the crypto import to `import { randomBytes, createHmac, timingSafeEqual } from 'node:crypto';`. Add next to the agents block:

```js
// ---------- /wh/<name>: webhook trigger (spec §6). HMAC is the auth; the body is discarded. ----------
const AGENTS_CFG = TMUX_HOME + '/.config/mows-agents/config';
function agentsConfig() { // KEY=value lines only; values may be quoted. Read per request: secrets rotate.
  const out = {};
  try { for (const l of readFileSync(AGENTS_CFG, 'utf8').split('\n')) { const m = l.match(/^([A-Z0-9_]+)=(.*)$/); if (m) out[m[1]] = m[2].trim().replace(/^(["'])(.*)\1$/, '$2'); } } catch {}
  return out;
}
async function webhookView(req, res, name) {
  if (req.method !== 'POST') { res.writeHead(405); return res.end(); }
  if (!AGENT_RE.test(name)) { res.writeHead(404); return res.end(); }
  const secret = agentsConfig()['WEBHOOK_SECRET_' + name.toUpperCase().replace(/-/g, '_')];
  if (!secret) { res.writeHead(404); return res.end(); }
  const chunks = []; let n = 0;
  for await (const c of req) { n += c.length; if (n > 1e6) { res.writeHead(413); return res.end(); } chunks.push(c); }
  const want = Buffer.from('sha256=' + createHmac('sha256', secret).update(Buffer.concat(chunks)).digest('hex'));
  const got = Buffer.from(String(req.headers['x-mows-signature'] || req.headers['x-hub-signature-256'] || ''));
  if (got.length !== want.length || !timingSafeEqual(got, want)) { res.writeHead(401); return res.end('bad signature'); }
  // one in-flight run per agent is enforced by mows-agent itself (refuses with exit 6); the unit's
  // SuccessExitStatus covers that, so a burst of webhooks is safe.
  await sh('systemctl', ['start', '--no-block', `mows-agent@${name}.service`]);
  res.writeHead(202, { 'content-type': 'text/plain' }); res.end('queued');
}
```

Route (before `/agents`): `if (p.startsWith('/wh/')) return await webhookView(req, res, p.slice(4));`

- [ ] **Step 3: Caddy carve-out**

In `infra/caddy/Caddyfile.template`, inside each site block that proxies the dashboard, **before** the `forward_auth` import, add:

```
    # Layer 6 webhook ingress: authenticated by HMAC inside the dashboard, so it must NOT sit
    # behind the Google login (GitHub cannot log in). Everything else on the site stays gated.
    handle /wh/* {
        reverse_proxy 127.0.0.1:3005
    }
```

Re-render (`./install.sh --infra` stages `rendered/Caddyfile`), `caddy validate --config rendered/Caddyfile --adapter caddyfile`, then the printed `sudo install … && sudo systemctl reload caddy`.

- [ ] **Step 4: Run the container matrix, deploy, prove with GitHub**

```bash
bash scripts/e2e-container.sh 2>&1 | grep -E 'webhook|caddy: /wh'      # 6 PASS
sudo install -m644 infra/dashboard/lite.mjs /opt/claude-dashboard/lite.mjs && sudo systemctl restart claude-dash-lite
```

Add `WEBHOOK_SECRET_HARNESS_REVIEWER=<openssl rand -hex 32>` to `~/.config/mows-agents/config`, add `{ type: webhook }` to the agent's triggers, then in the GitHub repo settings add a webhook: payload URL `https://<dashboard-host>/wh/harness-reviewer`, content type `application/json`, the same secret, event `push`. Push a commit; `mows-agent list` must show a new run within a minute and GitHub's delivery log must show 202.

- [ ] **Step 5: Commit**

```bash
git add infra/dashboard/lite.mjs infra/caddy/Caddyfile.template scripts/e2e-infra.sh
git commit -m "agents: HMAC webhook ingress /wh/<name> + Caddy carve-out (phase 5)"
```

---

# Phase 6 — Residents (native background agents, read-only)

### Task 10: `mows-agent residents` + dashboard fold

**Files:**
- Modify: `agents/bin/mows-agent`
- Modify: `scripts/e2e-agents.sh`
- Modify: `infra/dashboard/lite.mjs` (`agentsView` fold)

**Interfaces:**
- Produces: `mows-agent residents [--json]` → per profile, `claude agents --json` records with `kind == "background"`, minus any whose `cwd` starts with `$HOME/.claude-mem/observer-sessions`; text columns `PROFILE ID NAME STATE WAITING CWD`.

- [ ] **Step 1: Failing tests**

```bash
echo "### residents"
export CLAUDE_AGENTS_JSON_FILE="$T/agents.json"
cat > "$CLAUDE_AGENTS_JSON_FILE" <<EOF
[{"id":"a517ab4b","cwd":"$HOME","kind":"background","name":"web harness autocomplete","state":"blocked","waitingFor":"permission prompt","sessionId":"x"},
 {"pid":1,"cwd":"$HOME/.claude-mem/observer-sessions/293","kind":"background","id":"obs1","name":"293-86","state":"working"},
 {"pid":2,"cwd":"$HOME","kind":"interactive","name":"alonso-c0","sessionId":"y"}]
EOF
chk "residents: background record listed"      'mows-agent residents | grep -q "a517ab4b .*blocked .*permission prompt"'
chk "residents: interactive records dropped"   '! mows-agent residents | grep -q alonso-c0'
chk "residents: claude-mem observers dropped"  '! mows-agent residents | grep -q obs1'
chk "residents --json: array per profile"      '[ "$(mows-agent residents --json | jq -r ".[0].profile")" = default ]'
chk "residents: work profile also polled"      '[ "$(mows-agent residents --json | jq length)" = 2 ]'
```

- [ ] **Step 2: Implement**

```bash
# ---------- residents: the native daemon's background sessions, read-only (spec D2, Phase 6) ----------
cmd_residents(){
  local json=0; [ "${1:-}" = --json ] && json=1
  local all='[]' p d recs
  while IFS=$'\t' read -r p d; do
    recs=$(CLAUDE_CONFIG_DIR="$d" timeout 15 "$CLAUDE_BIN" agents --json 2>/dev/null || echo '[]')
    recs=$(jq --arg obs "$HOME/.claude-mem/observer-sessions" '[.[] | select(.kind=="background") | select((.cwd // "") | startswith($obs) | not)]' <<<"$recs" 2>/dev/null || echo '[]')
    all=$(jq --arg p "$p" --argjson r "$recs" '. + [{profile:$p, agents:$r}]' <<<"$all")
  done < <(jq -r 'to_entries[] | "\(.key)\t\(.value)"' <<<"$MOWS_PROFILES_JSON")
  if [ "$json" = 1 ]; then echo "$all"; return; fi
  printf '%-10s %-9s %-32s %-9s %-18s %s\n' PROFILE ID NAME STATE WAITING CWD
  jq -r '.[] | .profile as $p | .agents[] | [$p, (.id // "-"), ((.name // "-")[0:32]), (.state // "-"), (.waitingFor // "-"), (.cwd // "-")] | @tsv' <<<"$all" \
    | while IFS=$'\t' read -r a b c d e f; do printf '%-10s %-9s %-32s %-9s %-18s %s\n' "$a" "$b" "$c" "$d" "$e" "$f"; done
}
```

Dispatch: `residents) shift; cmd_residents "$@";;`

Dashboard: in `agentsView`, after the rows, run `runAs([], 'mows-agent', ['residents', '--json'], 20000)` (the dashboard is root; `runAs` executes as `TMUX_USER`, which is where `~/.claude*` live), parse, and render:

```js
  let res = []; try { res = JSON.parse(await runAs([], 'mows-agent', ['residents', '--json'], 20000)); } catch {}
  const resRows = res.flatMap(p => p.agents.map(a => `<li><b>${esc(a.name || a.id)}</b> ${agentPill(a.state)} <span class="muted">${esc(p.profile)} · ${esc(a.waitingFor || '')} · ${esc(a.cwd || '')}</span></li>`));
  const fold = `<details><summary>Native background sessions (${resRows.length})</summary><ul>${resRows.join('') || '<li class="muted">none</li>'}</ul></details>`;
```

and append `fold` to `body`. Check `runAs`'s return shape at `lite.mjs:894` first (it resolves stdout as a string like `sh`; if it resolves an object, adapt the parse).

- [ ] **Step 3: Tests — expect `0 failed`; report the actual total; deploy; commit**

```bash
git add agents/bin/mows-agent scripts/e2e-agents.sh infra/dashboard/lite.mjs
git commit -m "agents: residents — surface native background sessions read-only (phase 6)"
```

---

# Phase 7 — Test & release

### Task 11: Container matrix, dynamic counts, docs

**Files:**
- Modify: `scripts/e2e-container.sh`
- Modify: `agents/SETUP.md` (create), `README.md`, `docs/architecture.md`
- Modify: `scripts/manifest.txt`

- [ ] **Step 1: `e2e-container.sh`**

Replace lines 33–34:

```bash
chk "skills == repo count"   '[ "$(ls $HOME/.claude/skills | wc -l)" = "$(ls /src/claude/skills | wc -l)" ]'
chk "commands == repo count" '[ "$(ls $HOME/.claude/commands | wc -l)" = "$(ls /src/claude/commands | wc -l)" ]'
```

Add `--agents` to the install line (line 26). After the agy matrix block (≈ line 149) add:

```bash
echo "### agents layer"
chk "mows-agent installed"             "[ -x $HOME/.local/bin/mows-agent ]"
chk "agents config seeded 600"         "[ \"\$(stat -c %a $HOME/.config/mows-agents/config)\" = 600 ]"
chk "harness-reviewer seeded"          "[ -f $HOME/.claude/agents/harness-reviewer.md ]"
mkdir -p "$HOME/Documents/Projects/mows-harness"   # the example's workdir must exist for lint
chk "mows-agent lint --all clean"      "mows-agent lint --all"
chk "mows-agent list shows example"    "mows-agent list | grep -q '^harness-reviewer'"
chk "rendered timer staged, not enabled" "[ -f harness/rendered/mows-agent-harness-reviewer.timer ] && ! systemctl is-enabled mows-agent-harness-reviewer.timer 2>/dev/null"
echo "### agents hermetic matrix (installed copies)"
if BIN_DIR="$HOME/.local/bin" bash scripts/e2e-agents.sh > /tmp/agents-matrix.log 2>&1; then ok "e2e-agents all green"; else no "e2e-agents (see /tmp/agents-matrix.log)"; tail -20 /tmp/agents-matrix.log; fi
```

(Inside the container `/src` is the repo mount and `harness/` the working clone, per the script's own header.)

- [ ] **Step 2: Docs**

`agents/SETUP.md` (≈ 60 lines, same voice as `agy/SETUP.md`): what an agent is, the manifest with every `mows:` field and its default, the run lifecycle and exit codes, the state dir, budget tiers, triggers (render → sudo lines → `systemctl list-timers`), webhook setup (secret, GitHub settings), the dashboard tab, safety posture, troubleshooting (`mows-agent last`, `journalctl -u mows-agent@<name>`, lint is the only validator).

`README.md`: layers list → six layers; add the `agents` bullet: "**agents** — purpose-scoped agents that run unattended: one Claude Code agent file + a `mows:` policy block, budgets per run/day/account, systemd timers and HMAC webhooks as triggers, Discord escalation, an `/agents` dashboard tab". Add `--agents` to the "install any subset" line and a short "Agents" paragraph under "What it looks like" with a capture of `/agents` (`docs/assets/agents.png`, same macOS window chrome as the others).

`docs/architecture.md`: add row `6. agents | --agents | agents/bin/{mows-agent,mows-agent-meta}, agents/examples/, agents/config.example | Purpose-scoped agents…`; add a "Layer 6 contracts" subsection: the agent file is the manifest; `mows-agent` owns policy, the Claude daemon owns processes; run records are files; timers staged only; webhook body never reaches an agent; the `/wh/*` Caddy carve-out is the only unauthenticated path on the site and it is HMAC-gated.

- [ ] **Step 3: Full gate**

```bash
./scripts/preflight.sh | tail -1                  # ALL CLEAN
bash scripts/e2e-agents.sh | tail -1              # must end `0 failed`
bash scripts/e2e-container.sh 2>&1 | tail -3      # 0 FAIL
scripts/live-agents.sh --yes | tail -1            # 7 passed
/qa run agents-tab                                # green
```

- [ ] **Step 4: Commit and tag**

```bash
printf '%s\n' agents/SETUP.md docs/assets/agents.png >> scripts/manifest.txt
git add -A agents docs README.md scripts
git commit -m "agents: Layer 6 release — container matrix, docs, README (phase 7)"
git tag -a v0.6.0 -m "Layer 6: agents"
```

---

## Self-review against the spec

- **§1 manifest rules** → Task 1 (every rule has a lint assertion; `gh auth status` is exercised via the stub `gh` returning 0).
- **§2 layout** → Tasks 1, 4, 7 (no unit template files; heredocs in `render`).
- **§3 CLI** → Tasks 2 (run), 3 (list/last/logs), 5 (prune), 7 (render), 10 (residents). `lint` Task 1.
- **§3.1 run steps 1–7** → Task 2 (steps 1–6) + Task 6 (step 7 merge). Exit codes match Global Constraints.
- **§4 budget tiers** → tier 1 Task 2 args assertions; tiers 2–3 Task 5.
- **§5 escalation** → Task 2 (`escalate`, Discord assertions: exactly one post, silent on `done`, silent when `via` unset).
- **§6 triggers** → Task 7 (cron, path), Task 9 (webhook, both headers, Caddy carve-out).
- **§7 safety** → `--permission-prompts none` / no `dangerously` / `--strict-mcp-config` assertions (Task 2), `bypassPermissions` lint error and trifecta WARN (Task 1), `UnsetEnvironment=ANTHROPIC_API_KEY` in the unit (Task 7), body discarded (Task 9).
- **§8 dashboard** → Task 8 (tab, routes, actions, sort, speculation, 3 s cache), Task 10 (fold + observer filter).
- **§9 install** → Task 4 (+ render in Task 7).
- **§10 tests** → `e2e-agents.sh` grows in Tasks 1–3, 5–7, 10; `live-agents.sh` Task 4; container Task 11; journey Task 8; infra checks Tasks 8–9.
- **§11 gates** → stated after Tasks 4, 6, 7, 8, 9 and in Task 11.
- **Type consistency:** `status.json` keys are identical in `write_status` (Task 2), the test assertions (Tasks 2, 5), `agentsIndex()` (Task 8) and `agentAction` stop (`pid`). Exit codes identical in `cmd_run`, tests, and `SuccessExitStatus=4 6`. Unit names `mows-agent@<name>.service` / `mows-agent-<name>.timer` identical in `render`, `next_fire`, `agentTimer`, `agentAction`, `webhookView`.
- **Placeholders:** none; every code step is complete.
