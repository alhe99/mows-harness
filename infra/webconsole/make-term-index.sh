#!/usr/bin/env bash
# make-term-index.sh — produce the one file infra/webconsole/ has never shipped: the
# actual HTML page Caddy serves at /term and /term/.
#
# Why this exists: ttyd's own index.html is a ~700KB generated bundle (its vendored
# xterm.js + its own client JS, all inlined into one file) — a build/version artifact of
# ttyd itself that this repo deliberately does not vendor (see clipboard-shim.html's own
# header for the full "why"). infra/caddy/Caddyfile.template's @termhtml route serves this
# exact file, by path, for both /term and /term/ (Caddy's own file_server, ahead of the
# reverse_proxy to ttyd — see that template's own comment). Caddy cannot serve a file that
# doesn't exist: skip this step and every fresh adopter's /term 404s. Before this script
# existed, producing the file was a manual splice — still documented, as a fallback, in
# clipboard-shim.html's and claude-web-term.service.template's own header comments — this
# script automates those exact steps: start ttyd once, fetch the page it serves, splice
# this directory's self-authored additions into it, write the result.
#
# What gets spliced in:
#   0. into <head>, right after the opening tag: the mobile head set — the tuned viewport
#      meta (ttyd's stock page ships NO viewport meta at all, so without this iPhones lay
#      the page out at ~980px and the terminal renders desktop-tiny) plus the <!--cc-pwa-->
#      manifest/apple-touch-icon/web-app metas that make /term installable full-screen from
#      the home screen (lite.mjs serves both referenced URLs). This set once lived as a
#      hand patch on the deployed page — which a regen silently wiped, breaking every
#      phone. Anything the page needs MUST be encoded here, never patched on the output.
#   Immediately before </body>, in this order:
#   1. clipboard-shim.html's <script> block (OSC 52 -> browser clipboard; its own header
#      comment is stripped — see the splice step below)
#   2. every blocks/*.html file, verbatim, in filename order (10-cckb.html, 20-ccpwa.html,
#      ...) — /term's own UX: unicode-11 char widths (ccu11), key bar (cckb), PWA geometry
#      (ccpwa), home key (cchome), photo attach (ccimg), font-size keys (ccfont), keyboard
#      suggestions + reconnect (ccime), copy/paste overlay (ccclip), restart-pane key
#      (ccrst), repaint-on-foreground (ccpaint). Each block documents
#      itself in its own top-of-block comment. Runtime kill switches, as /term URL params:
#      ?ime=off ?clip=off ?rst=off for the three that intercept input, ?u11=off for the
#      width shim, ?paint=off for the repaint.
#
# usage: make-term-index.sh [output-path]
#   output-path   default: /opt/claude-dashboard/term-index.html — the exact path
#                 Caddyfile.template's @termhtml route hardcodes. Pass a different path
#                 only if you've also changed that route to match.
#
# Idempotent by construction: the page is REGENERATED from scratch on every run (fresh
# ttyd page + full splice), never patched in place — same inputs, same output, safe to run
# from a provisioning script every time. Re-run it after a repo update and the page picks
# up new or changed blocks. (An earlier version instead exited early when a marker was
# already present in the output file — which also meant it could never add a NEW block to
# an existing page; regeneration is what fixed that.)
#   marker: the literal string "mows clipboard shim v2" — the opening words of
#   clipboard-shim.html's own top-of-<script> comment (see that file) — is verified to be
#   present in the RESULT before anything is written, as a splice sanity check, alongside
#   one id check per block. Keep this constant in sync if that file's version comment ever
#   changes.
set -euo pipefail

DEFAULT_OUT="/opt/claude-dashboard/term-index.html"
OUT="${1:-$DEFAULT_OUT}"
MARKER='mows clipboard shim v2'

HERE=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
SHIM="$HERE/clipboard-shim.html"
BLOCKS_DIR="$HERE/blocks"

[ -f "$SHIM" ] || { echo "make-term-index.sh: sibling clipboard-shim.html not found at $SHIM" >&2; exit 1; }
[ -d "$BLOCKS_DIR" ] || { echo "make-term-index.sh: sibling blocks/ directory not found at $BLOCKS_DIR" >&2; exit 1; }

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
TMP_INSERT=""
TMP_HEAD=""
TMP_SPLICED=""
KEEP_SPLICED=""
cleanup() {
  if [ -n "$TTYD_PID" ]; then
    kill "$TTYD_PID" 2>/dev/null || true
    wait "$TTYD_PID" 2>/dev/null || true
  fi
  [ -n "$TMP_PAGE" ] && rm -f "$TMP_PAGE"
  [ -n "$TMP_INSERT" ] && rm -f "$TMP_INSERT"
  [ -n "$TMP_HEAD" ] && rm -f "$TMP_HEAD" "$TMP_HEAD.out"
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

# --- 6. build the insert: shim's <script> block first, then every blocks/*.html ---
# The shim's ~19-line header comment (maintainer-facing: why the file exists, the manual
# fallback recipe) is stripped — matching that header's own documented convention ("paste
# the <script>...</script> block below") instead of leaking repo maintenance prose into
# the page real browsers load. Split point: the header's closing "-->" (its own last
# line) — NOT a search for a literal "<script" substring, because the header's prose
# itself mentions "<script>" twice, which would trip a naive substring match on line 1.
# Block files carry no such wrapper — they splice in verbatim, in filename order (the
# order matters: every later block finds the #cckb key bar that 10-cckb.html creates).
TMP_INSERT=$(mktemp)
awk '!s { if (/-->/) s = 1; next } { print }' "$SHIM" > "$TMP_INSERT"
cat "$BLOCKS_DIR"/*.html >> "$TMP_INSERT"

# --- 7. splice: the whole insert goes immediately before </body> ---
# awk, not sed: the insert is HTML+JS full of &, /, and backslashes — sed's `r file`
# command only ever APPENDS after a matched line and can't hold another file's raw bytes
# in its pattern space, and any sed s/// form would need every one of those special
# characters escaped first anyway. awk reads the insert as its own input file (first of
# the two ARGV files below), so none of its bytes are ever interpreted as a regex special.
# index()/substr(), not a line-level match: ttyd's page arrives as ONE giant line, so an
# earlier "print the insert before the line that contains </body>" rule dropped the whole
# insert before the doctype — quirks mode, and step 0's head set never applied. Splitting
# the matched line AT the tag is what "immediately before </body>" actually requires.
TMP_SPLICED=$(mktemp)
awk '
  FNR==NR { ins = ins $0 ORS; next }
  !done { i = index($0, "</body>");
    if (i) { printf "%s%s", substr($0, 1, i - 1), ins; print substr($0, i); done = 1; next } }
  { print }
' "$TMP_INSERT" "$TMP_PAGE" > "$TMP_SPLICED"

# --- 7b. head splice: mobile viewport + cc-pwa metas, right after <head> (see step 0) ---
TMP_HEAD=$(mktemp)
cat > "$TMP_HEAD" <<'EOF'
<meta name="viewport" content="width=device-width,initial-scale=1,maximum-scale=1,user-scalable=no,viewport-fit=cover,interactive-widget=resizes-content">
<!--cc-pwa--><link rel="manifest" href="/manifest.webmanifest" crossorigin="use-credentials"><meta name="theme-color" content="#161b22"><link rel="apple-touch-icon" href="/apple-touch-icon.png"><meta name="mobile-web-app-capable" content="yes"><meta name="apple-mobile-web-app-capable" content="yes"><meta name="apple-mobile-web-app-status-bar-style" content="black-translucent"><!--/cc-pwa-->
EOF
awk '
  FNR==NR { ins = ins $0 ORS; next }
  !done { i = index($0, "<head>");
    if (i) { printf "%s%s", substr($0, 1, i + 5), ins; print substr($0, i + 6); done = 1; next } }
  { print }
' "$TMP_HEAD" "$TMP_SPLICED" > "$TMP_HEAD.out" && mv "$TMP_HEAD.out" "$TMP_SPLICED"

if ! grep -qF "$MARKER" "$TMP_SPLICED"; then
  echo "make-term-index.sh: splice ran but marker \"$MARKER\" is missing from the result — aborting before writing $OUT" >&2
  exit 1
fi
# Order proof: the shim must sit inside the body, i.e. AFTER <head> — catches the
# insert-landed-before-the-doctype failure that a bare "is the marker present" check let
# through. Byte offsets via grep -b: cheap and immune to the single-line layout.
MARKER_AT=$(grep -abom1 -F "$MARKER" "$TMP_SPLICED" | cut -d: -f1)
HEAD_AT=$(grep -abom1 -F '<head>' "$TMP_SPLICED" | cut -d: -f1)
if [ -z "$MARKER_AT" ] || [ -z "$HEAD_AT" ] || [ "$MARKER_AT" -le "$HEAD_AT" ]; then
  echo "make-term-index.sh: splice landed outside <body> (marker@${MARKER_AT:-?} <head>@${HEAD_AT:-?}) — aborting before writing $OUT" >&2
  exit 1
fi
# Head-set proof: exactly one viewport meta (a second one means ttyd started shipping its
# own — revisit step 7b before trusting the result) and the PWA metas made it in.
NVIEW=$(grep -c 'name="viewport"' "$TMP_SPLICED")
if [ "$NVIEW" != 1 ] || ! grep -qF 'apple-mobile-web-app-capable' "$TMP_SPLICED"; then
  echo "make-term-index.sh: head splice failed (viewport metas: $NVIEW, want exactly 1) — aborting before writing $OUT" >&2
  exit 1
fi
for b in "$BLOCKS_DIR"/*.html; do
  id=$(grep -oE 'id="cc[a-z0-9-]+"' "$b" | head -1)
  [ -n "$id" ] || continue
  if ! grep -qF "$id" "$TMP_SPLICED"; then
    echo "make-term-index.sh: block $(basename "$b") ($id) missing from the result — aborting before writing $OUT" >&2
    exit 1
  fi
done

# --- 8. write to the output path ---
OUT_DIR=$(dirname "$OUT")
if mkdir -p "$OUT_DIR" 2>/dev/null && cp "$TMP_SPLICED" "$OUT" 2>/dev/null; then
  # --- 9. success ---
  BYTES=$(wc -c <"$OUT" | tr -d ' ')
  NBLOCKS=$(ls "$BLOCKS_DIR"/*.html 2>/dev/null | wc -l | tr -d ' ')
  echo "make-term-index.sh: wrote $OUT (${BYTES} bytes; mobile head + shim + ${NBLOCKS} blocks spliced, marker \"$MARKER\" present)"
else
  KEEP_SPLICED=1
  echo "make-term-index.sh: cannot write $OUT (permission denied)." >&2
  echo "  the spliced page is ready at $TMP_SPLICED — install it yourself:" >&2
  echo "    sudo install -D -m644 \"$TMP_SPLICED\" \"$OUT\"" >&2
  exit 1
fi
