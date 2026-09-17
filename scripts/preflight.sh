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

# 3c. control bytes: a shipped TEXT file must contain no control byte other than tab/newline.
# Not theoretical -- this branch hit the failure mode from both directions in one session: an
# editing tool silently rewrote a \u0001 / $'\x01' escape NAMED IN SOURCE into a raw embedded
# control byte (functionally harmless there -- every gate stayed green -- but invisible and
# confusing on inspection), and separately a reviewing tool refused to run its own command for
# containing that same escape.
#
# HOW "is this a text file" IS DECIDED, and why it changed (Task 7 fix round 1). This used to
# ask `grep -Iq ''`, grep's own binary heuristic -- and that heuristic is precisely "does the
# file contain a NUL". So a shipped .mjs with a stray NUL in it classified as BINARY and the
# gate skipped the single worst case it exists to catch. Not theoretical: an editing tool
# rewrote a backslash-u-0000 escape into a raw NUL in two .mjs files in one round, preflight
# reported ALL CLEAN over both, and it then did it a THIRD time inside the comment being
# written to describe it -- which this gate, once fixed, caught. The test is now "is the file
# valid UTF-8", which does not beg the question: a .mjs with a stray NUL is still valid UTF-8
# and gets scanned, while docs/assets/*.png and *.gif are not and still skip. Same property
# as before (no path or extension allowlist to go stale), without the blind spot.
CTRLBAD=0
while IFS= read -r -d '' f; do
  [ -f "$f" ] || continue
  iconv -f UTF-8 -t UTF-8 <"$f" >/dev/null 2>&1 || continue  # not text at all -- not this check's business
  # -a: grep must not bail out on a file it thinks is binary; deciding that is the line above's job.
  if LC_ALL=C grep -aqP '[\x00-\x08\x0B-\x1F\x7F]' "$f" 2>/dev/null; then
    echo "preflight FAIL: control byte(s) other than tab/newline in $f"
    CTRLBAD=1
  fi
done < <(git ls-files -z)
[ "$CTRLBAD" = 0 ] || bad "shipped file(s) contain raw control bytes (see above)"

# 4. placeholder lint: only the sanctioned {{ VARS }}
ALLOWED='DOMAIN|EXAMPLE_SUB|OAUTH_CLIENT_ID|OAUTH_CLIENT_SECRET|COOKIE_SECRET|ADMIN_EMAIL|CONTEXT7_API_KEY|VPS_HOST|PROJECTS_ROOT|ADMIN_USER'
# exclude this script: it documents the {{VAR}} convention in comments/patterns
if git grep -hoE '\{\{[A-Z0-9_]+\}\}' -- . ':!scripts/preflight.sh' | sort -u | grep -vE "^\{\{($ALLOWED)\}\}$"; then bad "unsanctioned placeholder"; fi

# 4b. commit metadata. Checks 1-4 only ever look at file CONTENT, so identity can still
# ship in the history itself -- GitHub's web editor in particular stamps commits with the
# account's configured name and, unless "keep my email private" is enabled, a real email
# address. No content scan can see that. Author, committer and message are all permanent
# and public the moment the repo is, so they get scanned too. --all covers remote-tracking
# refs, which is deliberate: an unpushed local fix does not clear a leak still on origin.
BADIDENT='@gmail\.|@outlook\.|@yahoo\.|@hotmail\.|@icloud\.|@proton'
if git log --all --format='%an <%ae>%n%cn <%ce>' | sort -u | grep -nE "$BADIDENT"; then
  bad "personal identity in commit author/committer (rewrite before publishing)"
fi
# commit messages get the same forbidden-string treatment the tree gets
if git log --all --format='%s%n%b' | grep -nIE "$PAT" | grep -v 'preflight-allow'; then
  bad "forbidden strings in commit messages"
fi

# 5. shell static checks
mapfile -t SH < <(git ls-files '*.sh' 'watchdogs/bin/*' 'fleet/bin/*' 'agy/bin/*' 'agents/bin/*' 'install.sh' 'scripts/e2e-container' 'scripts/e2e-infra' 2>/dev/null | sort -u)
for f in "${SH[@]}"; do
  head -1 "$f" | grep -q bash || continue
  bash -n "$f" || bad "bash -n: $f"
  if command -v shellcheck >/dev/null; then shellcheck -S error "$f" || bad "shellcheck: $f"; fi
done

# 5b. SPA client assets: pinned vendor hashes, and a hard size ceiling (spec D3).
# Without a gate, "SPA" grows back into the MB-scale bundle lite.mjs was written to replace.
if [ -d infra/dashboard/app ]; then
  ( cd infra/dashboard/app/vendor && sha256sum -c SHA256SUMS --quiet ) || bad "vendored module hash mismatch"
  GZ=0
  while IFS= read -r f; do
    GZ=$((GZ + $(gzip -9 -c "$f" | wc -c)))
  done < <(find infra/dashboard/app -type f \( -name '*.mjs' -o -name '*.css' \))
  [ "$GZ" -le 76800 ] || bad "client assets ${GZ}B gzipped exceeds the 76800B ceiling (spec D3)"
  note "client assets: ${GZ}B gzipped of 76800B"
else
  bad "infra/dashboard/app missing — the client-asset ceiling and vendor-hash checks did not run (spec D3)"
fi

# 5c. The chat view's XSS / rendering regression gate (Task 7, findings C1 and R1).
#
# This is the only route by which that gate reaches CI: ci.yml runs exactly this script, and
# checks 1-4 above compare file LISTS, not behaviour. It sat unwired for two rounds -- 63
# assertions guarding a Critical stored-XSS, executed only when a human typed the command.
#
# It FAILS rather than skips when it cannot run. That is deliberate and is the whole point: a
# security gate that quietly skips itself is worse than one that is absent, because it reports
# green. This session hit that failure mode four separate times, including a control-byte gate
# that was blind to the one byte it most needed to catch. node:module.registerHooks needs Node
# >= 22.15; ci.yml pins setup-node accordingly rather than trusting the runner image.
if [ -f scripts/chat-view-check.mjs ]; then
  if ! command -v node >/dev/null 2>&1; then
    bad "node not found — scripts/chat-view-check.mjs (the chat view's XSS gate) did NOT run"
  elif ! node -e 'const [a,b]=process.versions.node.split(".").map(Number);process.exit(a>22||(a===22&&b>=15)?0:1)'; then
    bad "node $(node -p 'process.versions.node') is too old for scripts/chat-view-check.mjs (needs >= 22.15 for node:module.registerHooks) — the XSS gate did NOT run"
  else
    CVOUT=$(node scripts/chat-view-check.mjs 2>&1) && CVRC=0 || CVRC=$?
    if [ "$CVRC" -ne 0 ]; then
      printf '%s\n' "$CVOUT" | grep '^FAIL' || printf '%s\n' "$CVOUT" | tail -5
      bad "chat-view-check: the chat view's XSS/rendering gate failed (see above)"
    else
      note "chat-view-check: $(printf '%s\n' "$CVOUT" | grep -c '^PASS' || true) assertions pass"
    fi
  fi
else
  bad "scripts/chat-view-check.mjs is missing — the chat view's XSS gate did NOT run"
fi

# 5d. The capability panel's honesty gate (Task 8). Wired here for the same reason 5c is: ci.yml
# runs this script and nothing else, so a gate that is not called from here is a gate that only
# runs when a human remembers to type the command. It FAILS rather than skips when it cannot run —
# a panel that claims an agent is narrower than it is fails silently by construction, which is
# exactly the shape of bug a gate that skips itself will never catch.
#
# It needs node >= 22.15 (checked in 5c, which runs first and has already failed the build if not)
# and python3 with PyYAML, because its last section runs the real mows-agent-meta over the real
# example agent file rather than a fixture of its own.
if [ -f scripts/capability-check.mjs ]; then
  if ! command -v python3 >/dev/null 2>&1 || ! python3 -c 'import yaml' >/dev/null 2>&1; then
    bad "python3 with PyYAML not found — scripts/capability-check.mjs (the capability panel's honesty gate) did NOT run"
  else
    CAPOUT=$(node scripts/capability-check.mjs 2>&1) && CAPRC=0 || CAPRC=$?
    if [ "$CAPRC" -ne 0 ]; then
      printf '%s\n' "$CAPOUT" | grep '^FAIL' || printf '%s\n' "$CAPOUT" | tail -5
      bad "capability-check: the capability panel's honesty gate failed (see above)"
    else
      note "capability-check: $(printf '%s\n' "$CAPOUT" | grep -c '^PASS' || true) assertions pass"
    fi
  fi
else
  bad "scripts/capability-check.mjs is missing — the capability panel's honesty gate did NOT run"
fi

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
