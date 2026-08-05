#!/usr/bin/env bash
# make-term-index.sh — produce the one file infra/webconsole/ has never shipped: the
# actual HTML page Caddy serves at /term and /term/.
#
# Why this exists: ttyd's own index.html is a ~700KB generated bundle (its vendored
# xterm.js + its own client JS, all inlined into one file) — a build/version artifact of
# ttyd itself that this repo deliberately does not vendor (see clipboard-shim.html's own
# header for the full "why"; this repo ships only the small, self-authored clipboard shim
# in that file). infra/caddy/Caddyfile.template's @termhtml route serves this exact file,
# by path, for both /term and /term/ (Caddy's own file_server, ahead of the reverse_proxy
# to ttyd — see that template's own comment). Caddy cannot serve a file that doesn't
# exist: skip this step and every fresh adopter's /term 404s. Before this script existed,
# producing the file was a manual splice — still documented, as a fallback, in
# clipboard-shim.html's and claude-web-term.service.template's own header comments — this
# script automates those exact steps: start ttyd once, fetch the page it serves, splice
# this directory's clipboard-shim.html into it, write the result.
#
# usage: make-term-index.sh [output-path]
#   output-path   default: /opt/claude-dashboard/term-index.html — the exact path
#                 Caddyfile.template's @termhtml route hardcodes. Pass a different path
#                 only if you've also changed that route to match.
#
# Idempotent: if output-path already contains the marker below, this script says so and
# exits 0 without touching the file — safe to run from a provisioning script every time,
# not just the first time.
#   marker: the literal string "mows clipboard shim v2" — the opening words of
#   clipboard-shim.html's own top-of-<script> comment (see that file). Picked because it
#   lives inside the shim itself, so "marker present" and "shim actually spliced in" can
#   never disagree. Keep this constant in sync if that file's version comment ever changes.
set -euo pipefail

DEFAULT_OUT="/opt/claude-dashboard/term-index.html"
OUT="${1:-$DEFAULT_OUT}"
MARKER='mows clipboard shim v2'

HERE=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
SHIM="$HERE/clipboard-shim.html"

# --- idempotency check, before starting anything else ---
if [ -f "$OUT" ] && grep -qF "$MARKER" "$OUT" 2>/dev/null; then
  echo "make-term-index.sh: $OUT already has the clipboard shim spliced in (marker: \"$MARKER\") — nothing to do."
  exit 0
fi

[ -f "$SHIM" ] || { echo "make-term-index.sh: sibling clipboard-shim.html not found at $SHIM" >&2; exit 1; }

# --- 1. ttyd on PATH? ---
if ! command -v ttyd >/dev/null 2>&1; then
  echo "make-term-index.sh: ttyd not found on PATH." >&2
  echo "  install it first:  sudo apt install -y ttyd" >&2
  exit 1
fi

# --- 2. free loopback port; start ttyd bare, backgrounded, killed on exit ---
PORT=""
for ((p = 7699; p <= 7799; p++)); do
  if ! ss -H -ltn 2>/dev/null | awk '{print $4}' | grep -qE ":${p}\$"; then
    PORT=$p
    break
  fi
done
[ -n "$PORT" ] || { echo "make-term-index.sh: no free loopback port in 7699-7799" >&2; exit 1; }

TTYD_PID=""
TMP_PAGE=""
TMP_SPLICED=""
KEEP_SPLICED=""
cleanup() {
  if [ -n "$TTYD_PID" ]; then
    kill "$TTYD_PID" 2>/dev/null || true
    wait "$TTYD_PID" 2>/dev/null || true
  fi
  [ -n "$TMP_PAGE" ] && rm -f "$TMP_PAGE"
  [ -n "$TMP_SPLICED" ] && [ -z "$KEEP_SPLICED" ] && rm -f "$TMP_SPLICED"
}
trap cleanup EXIT

# bare: no -I, no --base-path, no --writable — this is a throwaway instance whose only
# job is answering GET / with ttyd's own default page. The command argument (bash) never
# actually runs: that only happens if a client opens a websocket, which nothing here does.
ttyd --port "$PORT" --interface 127.0.0.1 bash >/dev/null 2>&1 &
TTYD_PID=$!

# --- 3. wait for it to answer, ~10s cap ---
# -s (not -S): this is a plain "is it up yet?" poll during ttyd's own startup window, so
# early connection-refused attempts are the normal, expected case, not an error worth
# printing each time. A real timeout still gets a clear message below, and step 4's fetch
# uses -fsS so an actual fetch failure there is never silent.
UP=""
for ((i = 0; i < 20; i++)); do
  if curl -fs -o /dev/null "http://127.0.0.1:${PORT}/"; then
    UP=1
    break
  fi
  sleep 0.5
done
[ -n "$UP" ] || { echo "make-term-index.sh: ttyd on 127.0.0.1:${PORT} never answered within ~10s" >&2; exit 1; }

# --- 4. fetch its index page ---
TMP_PAGE=$(mktemp)
curl -fsS "http://127.0.0.1:${PORT}/" -o "$TMP_PAGE"

# --- 5. sanity check: does it look like ttyd's page? ---
if ! grep -qi '</body>' "$TMP_PAGE"; then
  echo "make-term-index.sh: fetched page has no </body> — doesn't look like ttyd's index; aborting" >&2
  exit 1
fi

# --- 6. splice: shim's <script>...</script> block goes immediately before </body> ---
# awk, not sed: the shim is HTML+JS full of &, /, and backslashes — sed's `r file` command
# only ever APPENDS after a matched line and can't hold another file's raw bytes in its
# pattern space, and any sed s/// form would need every one of those special characters
# escaped first anyway. awk reads the shim as its own input file (first of the two ARGV
# files below), so none of its bytes are ever interpreted as a sed/regex special char.
# Only from clipboard-shim.html's own <script> tag onward is captured — its ~19-line
# header comment (maintainer-facing: why this file exists, the manual fallback recipe)
# is deliberately left out of the shim variable, matching that header's own documented
# convention ("paste the <script>...</script> block below") instead of leaking repo
# maintenance prose into the page real browsers load. Split point: the header's closing
# "-->" (its own last line) — NOT a search for a literal "<script" substring, because
# the header's prose itself mentions "<script>" twice while explaining what it is and
# how to paste it, which would trip a naive substring match on the very first line.
TMP_SPLICED=$(mktemp)
awk '
  FNR==NR {
    if (!started) {
      if ($0 ~ /-->/) started = 1
      next
    }
    shim = shim $0 ORS
    next
  }
  tolower($0) ~ /<\/body>/ { printf "%s", shim }
  { print }
' "$SHIM" "$TMP_PAGE" > "$TMP_SPLICED"

if ! grep -qF "$MARKER" "$TMP_SPLICED"; then
  echo "make-term-index.sh: splice ran but marker \"$MARKER\" is missing from the result — aborting before writing $OUT" >&2
  exit 1
fi

# --- 7. write to the output path ---
OUT_DIR=$(dirname "$OUT")
if mkdir -p "$OUT_DIR" 2>/dev/null && cp "$TMP_SPLICED" "$OUT" 2>/dev/null; then
  # --- 8. success ---
  BYTES=$(wc -c <"$OUT" | tr -d ' ')
  echo "make-term-index.sh: wrote $OUT (${BYTES} bytes; marker \"$MARKER\" present)"
else
  KEEP_SPLICED=1
  echo "make-term-index.sh: cannot write $OUT (permission denied)." >&2
  echo "  the spliced page is ready at $TMP_SPLICED — install it yourself:" >&2
  echo "    sudo install -D -m644 \"$TMP_SPLICED\" \"$OUT\"" >&2
  exit 1
fi
