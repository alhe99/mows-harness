#!/usr/bin/env bash
# preflight — blocking publish gate for mows-harness. Run from repo root.
set -euo pipefail
cd "$(git rev-parse --show-toplevel)"
fail=0; note(){ echo "preflight: $*"; }; bad(){ echo "preflight FAIL: $*"; fail=1; }

# 1. manifest completeness (both directions)
TREE=$(mktemp) MANI=$(mktemp)
trap 'rm -f "$TREE" "$MANI"' EXIT
git ls-files | sort > "$TREE"
if ! grep -v '^\s*#' scripts/manifest.txt 2>/dev/null | grep -v '^\s*$' | sort > "$MANI"; then
  bad "manifest.txt missing or empty"
fi
diff -u "$MANI" "$TREE" || bad "tree and manifest.txt differ (see diff above)"

# 2. no nested git repos / junk
[ -z "$(find . -mindepth 2 -name .git)" ] || bad "nested .git found"
[ -z "$(find . \( -name '.DS_Store' -o -name '*.bak*' -o -name '*.pyc' -o -name '*.pyo' -o -name '__pycache__' -o -name '*.so' -o -name '*.sqlite*' \) -not -path './.git/*' | head -1)" ] || bad "junk files present"

# 3. forbidden strings (identity/secrets)
#
# Split in two so this gate ships useful to every clone WITHOUT shipping any of this
# maintainer's own identifying details:
#   PUBLIC (below, tracked) — generic, non-identifying SHAPES only: credential/token
#   prefixes, macOS-migration residue, a generic absolute-home-path shape, a generic
#   dotted-quad IPv4 shape. True of anyone's box, reveals nothing about any one of them.
#   LOCAL (scripts/preflight-local.pat, OPTIONAL, gitignored, never shipped) — THIS
#   deployment's actual site-specific literals: the real reference-box IP, its domain,
#   org names, host/account ids. Sourced in below if the file exists; simply absent, with
#   no loss of function, on a fresh clone.
# Adopters: make your OWN scripts/preflight-local.pat (see that file's own header, once
# you create it) so the gate keeps full strength on your box too — the public half was
# only ever meant to catch shapes common to every deployment, not your specifics.
PAT='ctx7sk-|ntn_|ghp_|github_pat_|sk-ant-|AKIA|mongodb\+srv://|client_secret=|/opt/homebrew|/Users/|/home/[A-Za-z0-9_-]+'
if [ -f scripts/preflight-local.pat ]; then
  LOCAL=$(grep -v '^\s*#' scripts/preflight-local.pat | grep -v '^\s*$' | paste -sd'|')
  [ -n "$LOCAL" ] && PAT="$PAT|$LOCAL"
fi
if git grep -nIE "$PAT" -- . ':!scripts/preflight.sh' | grep -v 'preflight-allow'; then bad "forbidden strings found"; fi

# 3b. generic IPv4-literal shape. Kept separate from PAT above because it needs a
# per-match allowlist -- a plain substring test can't tell 127.0.0.1 from a real leaked
# address, so each individual matched token is checked, not just "does the pattern appear
# on this line" (which would also be true of an already-preflight-allow'd line). Extend
# the exact-match case below, precisely, for any genuine false positive (e.g. a
# version-like string that happens to parse as four dotted octets) — never loosen the
# regex itself, that's the whole check.
IPV4='([0-9]{1,3}\.){3}[0-9]{1,3}'
IPV4_BAD=0
while IFS= read -r hitline; do
  [ -z "$hitline" ] && continue
  for ip in $(grep -oE "$IPV4" <<<"$hitline"); do
    case "$ip" in
      127.0.0.1|0.0.0.0|255.255.255.255) continue ;;  # loopback / unspecified / broadcast
    esac
    echo "preflight FAIL: forbidden IPv4-looking literal ($ip): $hitline"
    IPV4_BAD=1
  done
done < <(git grep -nIE "$IPV4" -- . ':!scripts/preflight.sh' 2>/dev/null | grep -v 'preflight-allow')
[ "$IPV4_BAD" = 0 ] || bad "IPv4-looking literal(s) found (see above)"

# 4. placeholder lint: only the sanctioned {{ VARS }}
ALLOWED='DOMAIN|EXAMPLE_SUB|OAUTH_CLIENT_ID|OAUTH_CLIENT_SECRET|COOKIE_SECRET|ADMIN_EMAIL|CONTEXT7_API_KEY|VPS_HOST|PROJECTS_ROOT|ADMIN_USER'
# exclude this script: it documents the {{VAR}} convention in comments/patterns
if git grep -hoE '\{\{[A-Z0-9_]+\}\}' -- . ':!scripts/preflight.sh' | sort -u | grep -vE "^\{\{($ALLOWED)\}\}$"; then bad "unsanctioned placeholder"; fi

# 5. shell static checks
mapfile -t SH < <(git ls-files '*.sh' 'watchdogs/bin/*' 'fleet/bin/*' 'install.sh' 2>/dev/null | sort -u)
for f in "${SH[@]}"; do
  head -1 "$f" | grep -q bash || continue
  bash -n "$f" || bad "bash -n: $f"
  if command -v shellcheck >/dev/null; then shellcheck -S error "$f" || bad "shellcheck: $f"; fi
done

# 6. gitleaks if available (CI always runs it)
if command -v gitleaks >/dev/null; then gitleaks detect --source . --no-banner || bad "gitleaks"; fi

# 7. install dry-run (layers 1+2 into throwaway HOME)
if [ -x install.sh ]; then
  TH=$(mktemp -d); HOME="$TH" ./install.sh --claude --watchdogs --non-interactive >/dev/null || bad "install dry-run"
  [ -f "$TH/.claude/CLAUDE.md" ] || bad "dry-run: CLAUDE.md missing"
  rm -rf "$TH"
fi

# 8. optional full container test
if [ "${1:-}" = "--container" ]; then
  # systemd is installed only for its /usr/bin/systemctl binary — install.sh's OS guard
  # tests for the binary, not a running PID-1 systemd (which a container has no business
  # providing). Copy the tree in rather than bind-mounting: the run must not touch the repo.
  docker run --rm -v "$PWD":/src:ro ubuntu:24.04 bash -c \
    'apt-get update -qq && apt-get install -y -qq git curl systemd >/dev/null 2>&1 \
     && cp -r /src /r && cd /r && HOME=/root ./install.sh --all --non-interactive' \
    || bad "container install"
fi

[ $fail -eq 0 ] && note "ALL CLEAN" || { note "BLOCKED"; exit 1; }
