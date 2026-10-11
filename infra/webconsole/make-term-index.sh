#!/usr/bin/env bash
# make-term-index.sh — install the page Caddy serves at /term and /term/ (cockpit phase 04, ARCHITECTURE section 6; ledger K-32).
#
# infra/caddy/Caddyfile.template's @termhtml route serves one file, by path, for both /term and /term/ (Caddy's own file_server, ahead of the
# reverse_proxy to ttyd): /opt/claude-dashboard/term-index.html. That file is now dist/term.html, the document web/pages/term/ builds (xterm.js 6 on the
# same ttyd socket, the key bar and its features as modules, themes from themes.json). Nothing is generated on the box any more: no ttyd run, no
# splice. `node build.mjs` produces dist/term.html off-server and it is committed with the rest of dist/ (CI: `node build.mjs && git diff --exit-code -- dist/`).
#
# Rollback is a file swap. The page that was installed before the first run of this script (the old generated one, ttyd's bundle with the shim and the
# twelve blocks spliced in) is kept as term-index.legacy.html next to the output, and is never overwritten by a later run:
#     sudo cp /opt/claude-dashboard/term-index.legacy.html /opt/claude-dashboard/term-index.html      # Caddy re-reads it per request, no restart
#
# usage: make-term-index.sh [--dry-run] [output-path]
#   --dry-run     print what would happen; write nothing
#   output-path   default /opt/claude-dashboard/term-index.html — the path the Caddy route hardcodes. Change it only together with that route.
set -euo pipefail

DRY=0
if [ "${1:-}" = "--dry-run" ]; then DRY=1; shift; fi
DEFAULT_OUT="/opt/claude-dashboard/term-index.html"
OUT="${1:-$DEFAULT_OUT}"
LEGACY="$(dirname "$OUT")/term-index.legacy.html"
MARKER='data-term="cockpit"'

HERE=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
SRC="$HERE/../../dist/term.html"
[ -f "$SRC" ] || { echo "make-term-index.sh: $SRC not found — run 'node build.mjs' (dist/ is committed; is this a full checkout?)" >&2; exit 1; }

# --- self-checks: the page must be the new document, with the mobile head set and assets that exist, served from /assets/ (never /term/) ---
fail() { echo "make-term-index.sh: $1 — aborting before writing $OUT" >&2; exit 1; }
grep -qF "$MARKER" "$SRC" || fail "marker $MARKER missing from $SRC"
[ "$(grep -c 'name="viewport"' "$SRC")" = 1 ] || fail "want exactly one viewport meta"
grep -qF 'apple-mobile-web-app-capable' "$SRC" || fail "the <!--cc-pwa--> metas are missing"
grep -qE '(src|href)="/term/' "$SRC" && fail "an asset is named under /term/ (Caddy sends every /term* path to ttyd)"
for a in $(grep -oE '/assets/[A-Za-z0-9._-]+' "$SRC" | sort -u); do
  [ -f "$HERE/../../dist/${a#/assets/}" ] || fail "$a is not in dist/"
done

KEEP=0
# the previous page becomes the legacy one only if it is not the new document already (a second run must not overwrite the real legacy page)
if [ -f "$OUT" ] && ! grep -qF "$MARKER" "$OUT"; then KEEP=1; fi

if [ "$DRY" = 1 ]; then
  # one write, so a reader that stops at the first match (grep -q under pipefail) cannot turn a later write into SIGPIPE
  if [ "$KEEP" = 1 ]; then PLAN="would keep the previous $OUT as $LEGACY"
  else PLAN="no previous legacy page to keep (none installed, or $OUT is already the new document; $LEGACY stays as it is)"; fi
  printf 'make-term-index.sh: %s\nmake-term-index.sh: would copy %s -> %s (%s bytes)\n' "$PLAN" "$SRC" "$OUT" "$(wc -c <"$SRC" | tr -d ' ')"
  exit 0
fi

OUT_DIR=$(dirname "$OUT")
if mkdir -p "$OUT_DIR" 2>/dev/null && { [ "$KEEP" = 0 ] || cp -p "$OUT" "$LEGACY" 2>/dev/null; } && cp "$SRC" "$OUT" 2>/dev/null; then
  [ "$KEEP" = 1 ] && echo "make-term-index.sh: previous page kept as $LEGACY"
  echo "make-term-index.sh: wrote $OUT ($(wc -c <"$OUT" | tr -d ' ') bytes, from $SRC; rollback: cp $LEGACY $OUT)"
else
  echo "make-term-index.sh: cannot write $OUT (permission denied)." >&2
  echo "  install it yourself:" >&2
  [ "$KEEP" = 1 ] && echo "    sudo cp -p \"$OUT\" \"$LEGACY\"" >&2
  echo "    sudo install -D -m644 \"$SRC\" \"$OUT\"" >&2
  exit 1
fi
