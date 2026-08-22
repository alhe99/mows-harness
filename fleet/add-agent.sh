#!/usr/bin/env bash
# add-agent.sh — create a fleet AGENT account: its own Linux user, its own real copy of the
# ~/.claude config tree, and (optionally) its own remote-control systemd unit plus a
# matching, narrowly-scoped sudoers grant.
#
# *** NET-NEW DESIGN — NO LIVE PRECEDENT. ***  Everything else this repo ships under
# fleet/bin/ (cc, claude-rc, claude-status, reset-claude-env) is the "profile" model: ONE
# Linux user (the admin) running N *config-dir* profiles (~/.claude, ~/.claude-<x>, ...) —
# extracted from, and validated against, a real working reference box. This script is the
# "agent" model instead: N separate *Linux user accounts* on the same box, one per agent,
# each with its own home and its own ~/.claude. That model was designed for this repo, not
# extracted from anywhere, and has never run on the reference box — see fleet/SETUP.md's
# "profile vs agent" section before relying on it operationally.
#
# Usage: sudo fleet/add-agent.sh <name> [--remote-control] [--vhost[=<domain>]]
#
#   <name>              Linux username for the agent — MUST be exactly "agent" or
#                       "agent-<label>" (label: [a-z0-9_-]+). This is not this script's own
#                       invention: infra/dashboard/lite.mjs's discoverAccounts() (Task 13,
#                       already shipped) recognizes ONLY logins matching
#                       /^agent(?:-(.+))?$/ as automation identities — anything else is
#                       treated as a human profile-model account, which affects the
#                       dashboard's tmux-owner selection (TMUX_USER: "the first non-agent
#                       login found") and sort/display. Get the name wrong and a fleet agent
#                       can silently end up eligible to become the dashboard's tmux owner in
#                       the admin's place. Enforced below, not just documented.
#   --remote-control    also install claude-remote-<name>@.service (rendered from
#                       infra/systemd/claude-remote@.service) plus a per-agent sudoers grant
#                       scoped to ONLY that unit family (see "FIX A" below). Does NOT
#                       enable/start it — see the printed next-steps; a fresh account has no
#                       Claude Code OAuth session yet, so starting immediately would just
#                       crash-loop.
#   --vhost[=<domain>]  print a Caddy vhost snippet for this agent. Bare --vhost reads
#                       $HARNESS_DOMAIN or $DOMAIN; --vhost=<domain> overrides it inline; with neither
#                       set, prints the same block with a literal {{DOMAIN}} placeholder and
#                       says so plainly (see "FIX B" below). Space-separated "--vhost
#                       <domain>" is deliberately NOT supported: `add-agent.sh --vhost
#                       agent-alpha` would be ambiguous between "no domain, agent
#                       agent-alpha" and "domain agent-alpha, name missing" — requiring `=`
#                       removes the ambiguity instead of guessing.
#
# Idempotent-safe: re-running with the same <name> skips useradd (detects the existing
# account; refuses if it turns out to be a pre-existing SYSTEM account, uid<1000) and
# re-syncs — not merges — ~/.claude/{CLAUDE.md,rules,agents,commands,skills} and
# mcp-interactive.json.template: each item is removed then recopied fresh every run, so a
# file dropped upstream since the last run actually disappears from the agent's copy too,
# instead of silently accumulating stale leftovers the way a bare `cp -r` onto an
# already-populated directory would (cp -r's target-exists behavior merges, never deletes).
#
# Will NOT adopt a pre-existing account (uid>=1000 is not enough proof it's safe to resync —
# see FIX E below and the marker check right before the copy loop). Discovered by testing this
# script for real, not by inspection: a box can already run OTHER per-Linux-user automation
# whose account names happen to fit this same "agent[-label]" shape for reasons that have
# nothing to do with this harness, and clobbering that account's own config (or silently
# re-permissioning its home) would be exactly the cross-subsystem collision fleet/SETUP.md's
# "profile vs agent" section warns about in the abstract. The fix is concrete, not just a
# warning: any account this run did not itself create is refused unless it already carries
# this script's own marker file — checked regardless of whether $H/.claude exists yet.
#
# DRY_RUN=1: every MUTATING step (useradd, mkdir, rm, cp, chown, chmod, the unit/sudoers
# install, daemon-reload) prints "DRY_RUN: <command>" instead of running it — nothing is
# created, copied, chowned, or installed. Read-only checks (id, getent) and the two
# validation steps (systemd-analyze verify on the rendered unit, visudo -cf on the rendered
# sudoers file) still run for real even under DRY_RUN, since neither touches persistent
# system state — that's what lets a dry run prove the rendered content is actually valid,
# not merely describe what it would have installed.
#
# --- FIX A: why a per-agent claude-remote-<name>@ unit + a per-agent sudoers file ----------
# infra/systemd/claude-remote@.service hardcodes `User={{ADMIN_USER}}` — one rendered unit
# file can only ever run as ONE Linux user, and the profile model's admin account already
# owns the canonical `claude-remote@`/`claude-remote-control@` names plus the matching grant
# in infra/os/sudoers.d/claude-harness.template. An agent is a DIFFERENT Linux user, so it
# can reuse neither. This script installs the agent's unit under a name-carrying family
# instead — `claude-remote-<name>@.service` — with a matching PER-AGENT sudoers file
# (rendered from infra/os/sudoers.d/claude-harness-agent.template) that grants <name> (not
# the admin) NOPASSWD rights over ONLY `claude-remote-<name>@*`, in the same anchored-
# POSIX-ERE style as the admin's own template (verb inside the `^...$` anchors; see that
# file and claude-harness.template's headers for the full glob-vs-regex rationale). This is
# deliberately NOT one wildcarded "any agent" pattern — that shape would let one agent
# start/stop/enable/disable every OTHER agent's listener too, a real cross-account
# DoS/interference surface traded for a few characters of regex convenience. Splicing the
# already-validated, literal <name> into the pattern instead costs nothing and closes that
# off: agent "agent-alpha" can only ever touch claude-remote-agent-alpha@*.
#
# --- FIX B: see the --vhost description above; implementation is in the VHOST block below.
#
# --- FIX C: the MCP template is a TEMPLATE, never a rendered secret. This script copies
# claude/mcp.template.json (placeholders only, e.g. {{CONTEXT7_API_KEY}}) to
# ~agent/.claude/mcp-interactive.json.template and stops there — it never writes a real
# mcp-interactive.json, and the printed next-steps say explicitly what the adopter still
# has to do (copy + fill in their own key) before the agent's first session.
#
# --- FIX D: agent-name gate is a true anchored regex, not a case/glob pattern -------------
# A case pattern's `[...]` matches exactly ONE character and a bare `*` matches ANY run of
# characters, with no way to anchor "and nothing else follows" — so an earlier version of
# this gate (`agent|agent-[a-z0-9_-]*`, a case/glob) accepted 'agent-a/etc/passwd',
# 'agent-a;touch-x', 'agent-a.*', and 'agent-a|b' just as happily as 'agent-alpha' (the
# trailing `*` swallows whatever comes after one valid character). That $NAME is spliced
# verbatim into the per-agent sudoers Cmnd pattern FIX A renders below and into every $H path
# this script touches — an unanchored accept here undermines FIX A's own anchoring guarantee
# before it even gets a chance to run. `[[ "$NAME" =~ ^agent(-[a-z0-9_-]+)?$ ]]` anchors the
# WHOLE string at both `^` and `$`, the same anchoring discipline FIX A's sudoers regex
# already uses and for the same reason. See the name-shape check below.
#
# --- FIX E: won't silently adopt a pre-existing account, chmod included -------------------
# The adoption guard (right before the copy loop below) used to key off "does $H/.claude
# exist": a pre-existing account with NO ~/.claude yet sailed straight through with zero
# consent, picked up a script-owned .claude, and had its home chmod 750'd — all silently. The
# guard now keys off whether THIS run actually created the account ($USER_CREATED): any
# account that already existed before this run is refused unless it already carries the
# `.mows-harness-agent` marker, regardless of whether ~/.claude exists — closing that gap.
# `chmod 750` on the home is similarly now conditional on $USER_CREATED: this script only
# ever re-permissions a home it created itself, never one that pre-dated this run.
#
# --- Scope note: no claude-rc for agents (yet) ---------------------------------------------
# This script does NOT copy fleet/bin/{cc,claude-rc,claude-status,reset-claude-env} into the
# agent's home. Even if it did, claude-rc's unit_projects()/unit_control() hardcode the
# CANONICAL `claude-remote@`/`claude-remote-control@` family — they have no idea the
# per-agent `claude-remote-<name>@` family (this script's own invention) exists, so they
# would manage the wrong unit. Today, agent self-service is plain
# `sudo systemctl {start,stop,restart,enable,disable} claude-remote-<name>@default.service`
# (matches the sudoers grant this script installs); a claude-rc-equivalent for the agent
# model is future work, not part of this task.
set -euo pipefail

DRY_RUN="${DRY_RUN:-0}"
run() { if [ "$DRY_RUN" = 1 ]; then echo "DRY_RUN: $*"; else "$@"; fi; }

usage() {
  cat <<'EOF'
usage: add-agent.sh <name> [--remote-control] [--vhost[=<domain>]]

add-agent.sh — create a fleet agent account (NET-NEW model; see fleet/SETUP.md)

  sudo fleet/add-agent.sh <name> [--remote-control] [--vhost[=<domain>]]

  <name>              "agent" or "agent-<label>" only (label: [a-z0-9_-]+) — required so
                      infra/dashboard/lite.mjs recognizes it as a fleet agent, not a human
                      profile-model account.
  --remote-control    also install claude-remote-<name>@.service + its own scoped sudoers
                      grant (not enabled/started — see the printed next-steps)
  --vhost[=<domain>]  print a Caddy vhost snippet ($HARNESS_DOMAIN used if =<domain> is
                      omitted; a literal {{DOMAIN}} placeholder if neither is set)

  DRY_RUN=1 sudo fleet/add-agent.sh <name> ...   preview every mutating step, change nothing

  example: sudo fleet/add-agent.sh agent-alpha --remote-control --vhost=example.com
EOF
}

# -h/--help short-circuits BEFORE the root check on purpose — reading usage shouldn't need sudo.
for a in "$@"; do
  case "$a" in -h|--help) usage; exit 0 ;; esac
done

[ "$(id -u)" = 0 ] || { echo "add-agent.sh: must run as root (sudo fleet/add-agent.sh ...)" >&2; exit 1; }

NAME=""
REMOTE_CONTROL=0
VHOST=0
VHOST_DOMAIN="${HARNESS_DOMAIN:-${DOMAIN:-}}"
while [ $# -gt 0 ]; do
  case "$1" in
    --remote-control) REMOTE_CONTROL=1 ;;
    --vhost)          VHOST=1 ;;
    --vhost=*)        VHOST=1; VHOST_DOMAIN="${1#--vhost=}" ;;
    --*) echo "add-agent.sh: unknown option '$1'" >&2; usage; exit 1 ;;
    *)
      if [ -z "$NAME" ]; then NAME="$1"; else echo "add-agent.sh: unexpected argument '$1'" >&2; exit 1; fi
      ;;
  esac
  shift
done

if [ -z "$NAME" ]; then usage; echo "add-agent.sh: <name> is required" >&2; exit 1; fi

# Name shape: enforced, not just documented — see the header's FIX-A-adjacent note on why
# (dashboard tmux-owner selection depends on this). MUST be a true anchored regex, not a case
# glob (see FIX D above): in a case pattern, [a-z0-9_-] matches exactly ONE character and a
# bare * matches ANY characters with no charset restriction, so a glob shape here cannot
# reject e.g. 'agent-a/etc/passwd' or 'agent-a;touch-x' — `=~` against `^agent(-[a-z0-9_-]+)?$`
# anchors the WHOLE string at both ends, so nothing after a valid prefix can sneak through.
if ! [[ "$NAME" =~ ^agent(-[a-z0-9_-]+)?$ ]]; then
  echo "add-agent.sh: invalid agent name '$NAME' — must be exactly 'agent' or 'agent-<label>' (label: [a-z0-9_-]+) so infra/dashboard/lite.mjs recognizes it as a fleet agent, not a profile-model human account" >&2
  exit 1
fi

REPO_DIR=$(cd "$(dirname "$0")/.." && pwd)

# ---- user: create if missing; refuse to "adopt" a pre-existing SYSTEM account ------------
# USER_CREATED tracks whether THIS run is the one that brought the account into existence —
# FIX E's adoption guard and the chmod 750 below both key off this, not off uid or ~/.claude.
USER_CREATED=0
if id "$NAME" >/dev/null 2>&1; then
  EXIST_UID="$(id -u "$NAME")"
  if [ "$EXIST_UID" -lt 1000 ]; then
    echo "add-agent.sh: '$NAME' already exists as a system account (uid $EXIST_UID) — refusing to treat it as a fleet agent" >&2
    exit 1
  fi
  echo "user '$NAME' already exists (uid $EXIST_UID) — skipping useradd"
  H="$(getent passwd "$NAME" | cut -d: -f6)"
else
  run useradd -m -s /bin/bash "$NAME"
  USER_CREATED=1
  if [ "$DRY_RUN" = 1 ]; then
    H="/home/$NAME"   # useradd did not actually run; assuming this box's default HOME base
    echo "  (DRY_RUN: assuming home=$H — this box's real useradd default may differ)"
  else
    H="$(getent passwd "$NAME" | cut -d: -f6)"
  fi
fi
if [ -z "$H" ] || [ "$H" = "/" ]; then
  echo "add-agent.sh: resolved home dir for '$NAME' is empty or '/' — refusing to continue" >&2
  exit 1
fi

# ---- safety (FIX E): refuse to silently adopt an account this run did not itself create --
# Found empirically while testing this script, not hypothetically: on a box that ALSO runs
# other Linux-user-per-identity automation (this repo's own header warns "the agent model
# ... designed here and unvalidated" — but says nothing about what ELSE might already be
# using the exact same "one Linux user per bot identity" shape), a name matching our
# agent/agent-<label> convention can already exist for a reason that has nothing to do with
# this harness. uid>=1000 alone (the check above) does not tell you that — a real, unrelated,
# already-provisioned account clears it easily. The gate is keyed on $USER_CREATED, not on
# whether $H/.claude happens to exist: a pre-existing account with NO ~/.claude at all is just
# as much someone else's account as one with an unmarked ~/.claude, and must be refused the
# same way — checking only "does .claude exist" let a bare pre-existing account get annexed
# (.claude created, home chmod'd) with zero consent. Only a brand-new account (created by
# THIS run, $USER_CREATED=1) or one that already carries OUR marker (proof a previous run of
# THIS script created it, or the operator opted in by hand) proceeds. No --force/override
# flag: on this ambiguity, fail closed and let a human opt in explicitly.
MARKER=".mows-harness-agent"
if [ "$USER_CREATED" != 1 ] && [ ! -e "$H/.claude/$MARKER" ]; then
  echo "add-agent.sh: '$NAME' already existed before this run and has no" >&2
  echo "  $H/.claude/$MARKER marker — refusing to silently adopt it (whether or not" >&2
  echo "  $H/.claude exists yet). If '$NAME' should genuinely become a mows-harness fleet" >&2
  echo "  agent, opt in explicitly yourself first, then re-run:" >&2
  echo "    sudo -u $NAME mkdir -p ~$NAME/.claude && sudo -u $NAME touch ~$NAME/.claude/$MARKER" >&2
  exit 1
fi

# ---- config: REAL COPY (cross-user symlinks don't work), then lock down ownership/perms --
run mkdir -p "$H/.claude" "$H/Projects"
# CLAUDE.md's source lives at claude/global/CLAUDE.md, not claude/CLAUDE.md (relocated one
# level down so it isn't sitting at the plugin root — see install.sh's layer_claude() for
# the full rationale); the destination is unaffected, still a plain ~/.claude/CLAUDE.md.
run rm -f "$H/.claude/CLAUDE.md"
run cp "$REPO_DIR/claude/global/CLAUDE.md" "$H/.claude/CLAUDE.md"
for f in rules agents commands skills; do
  run rm -rf "$H/.claude/$f"
  run cp -r "$REPO_DIR/claude/$f" "$H/.claude/$f"
done
# FIX C: ship the .template only — never a rendered mcp-interactive.json (no secrets seeded).
run rm -f "$H/.claude/mcp-interactive.json.template"
run cp "$REPO_DIR/claude/mcp.template.json" "$H/.claude/mcp-interactive.json.template"
run touch "$H/.claude/$MARKER"
run chown -R "$NAME:$NAME" "$H/.claude" "$H/Projects"
# FIX E: only re-permission the home if THIS run created the account — a pre-existing home
# (even one that just passed the marker check above) had its own permissions before this
# script ever touched it; re-chmod'ing it is a separate consent question from "may we resync
# .claude", and this script only has standing to answer that question for a home it created.
if [ "$USER_CREATED" = 1 ]; then
  run chmod 750 "$H"
fi

# ---- optional: remote-control unit + its own scoped sudoers grant (FIX A) ----------------
if [ "$REMOTE_CONTROL" = 1 ]; then
  command -v visudo >/dev/null 2>&1 || { echo "add-agent.sh: visudo not found — cannot safely validate the sudoers file, aborting --remote-control" >&2; exit 1; }

  UNIT_TMP="$(mktemp)"
  sed "s/{{ADMIN_USER}}/$NAME/g" "$REPO_DIR/infra/systemd/claude-remote@.service" > "$UNIT_TMP"
  if command -v systemd-analyze >/dev/null 2>&1; then
    VERIFY_DIR="$(mktemp -d)"
    cp "$UNIT_TMP" "$VERIFY_DIR/claude-remote-$NAME@default.service"
    if ! systemd-analyze verify "$VERIFY_DIR/claude-remote-$NAME@default.service"; then
      echo "add-agent.sh: rendered unit failed systemd-analyze verify — aborting, nothing installed" >&2
      rm -rf "$UNIT_TMP" "$VERIFY_DIR"
      exit 1
    fi
    rm -rf "$VERIFY_DIR"
  else
    echo "add-agent.sh: systemd-analyze not found — skipping unit verification" >&2
  fi
  run install -o root -g root -m 0644 "$UNIT_TMP" "/etc/systemd/system/claude-remote-$NAME@.service"
  rm -f "$UNIT_TMP"

  SUDO_TMP="$(mktemp)"
  sed "s/{{ADMIN_USER}}/$NAME/g" "$REPO_DIR/infra/os/sudoers.d/claude-harness-agent.template" > "$SUDO_TMP"
  if ! visudo -cf "$SUDO_TMP"; then
    echo "add-agent.sh: rendered sudoers file failed visudo -cf — aborting, nothing installed" >&2
    rm -f "$SUDO_TMP"
    exit 1
  fi
  run install -o root -g root -m 0440 "$SUDO_TMP" "/etc/sudoers.d/claude-harness-$NAME"
  rm -f "$SUDO_TMP"

  run systemctl daemon-reload
  echo "installed: /etc/systemd/system/claude-remote-$NAME@.service + /etc/sudoers.d/claude-harness-$NAME"
  echo "next (only once '$NAME' has a real Claude Code OAuth login under $H/.claude):"
  echo "  sudo systemctl enable --now claude-remote-$NAME@default.service"
fi

# ---- optional: Caddy vhost snippet (FIX B) ------------------------------------------------
if [ "$VHOST" = 1 ]; then
  SUBLABEL="${NAME#agent-}"   # drop the "agent-" prefix for a cleaner public subdomain
  if [ -n "$VHOST_DOMAIN" ]; then
    DPART="$VHOST_DOMAIN"; VNOTE="ready to paste"
  else
    DPART='{{DOMAIN}}'
    VNOTE="placeholder left as-is — pass --vhost=<domain>, or export HARNESS_DOMAIN=<domain> (or DOMAIN=<domain>) before running this, for a ready-to-paste block; replace {{DOMAIN}} yourself otherwise"
  fi
  cat <<EOF

# Caddy vhost for '$NAME' ($VNOTE) — append to infra/caddy/Caddyfile (or your rendered
# copy), validate with: caddy validate --config <file> --adapter caddyfile
# then apply with:       sudo systemctl reload caddy
$SUBLABEL.$DPART {
    log
    encode zstd gzip
    route {
        import pwa
        import gauth
        import vncproxy
        reverse_proxy 127.0.0.1:3005
    }
}
EOF
fi

echo
echo "agent '$NAME' ready ($H)."
echo "next: cp $H/.claude/mcp-interactive.json.template $H/.claude/mcp-interactive.json"
echo "      then fill in your own {{CONTEXT7_API_KEY}} etc. before '$NAME's first session —"
echo "      the .template ships with placeholders only, never a real key."
