---
branch: feat/cockpit-00-baseline
release: patch
repos:
  - path: .
    stack: frontend
phase: 0
depends_on: null
outward: none
dev_server: MOWS_TEST_HOOKS=1 node infra/dashboard/lite.mjs --port 3105 --host 127.0.0.1 --ui=next
gates:
  size_limit: warn
  lighthouse: warn
budgets:
  shell_js_kb: 30
  view_js_kb: 15
  md_vendor_kb: 25
  css_kb: 12
  fonts_kb: 80
  term_js_kb: 130
  server_js_kb: 140
  lcp_ms: 2500
  tbt_ms: 200
  parity_diff_pct: 0.5
manual_gates: []
---

# Phase 0 — Baseline, tooling and gates in warn mode

Goal: Every number the later phases are judged against exists, every gate that will judge them runs (in warn mode) on the current UI, the parity baseline is frozen and diffable, and the deploy is a script. No user-visible change.

Constraints (from ledger.md, kept):
- K-24 — see ARCHITECTURE.md §14 / ledger.md
- K-25 — see ARCHITECTURE.md §14 / ledger.md
- K-26 — see ARCHITECTURE.md §14 / ledger.md
- K-29 — see ARCHITECTURE.md §14 / ledger.md
- K-33 — see ARCHITECTURE.md §14 / ledger.md
- K-23 — see ARCHITECTURE.md §14 / ledger.md
- K-16 — see ARCHITECTURE.md §14 / ledger.md

Every task has three fixed sub-lines. **Evidence** is where the requirement comes from (a MAP.md row or
section, an ARCHITECTURE.md section, a ledger id). **Verify** is a shell command run from the repo root whose
exit code is the verdict — `scripts/verify-spec.mjs` runs them all and decides `ship` or `fix`. **Owner** is
`builder` (writes code) or `verifier` (runs checks, read-only). A task that cannot be verified by a command is
not a task; it is a `manual_gates` entry with an owner and a date.

`$DASH` is the dev instance (`dev_server` in the front-matter, default `http://127.0.0.1:3105`); `$RUN` is the
`.agent-team/<run-id>` directory. Both are exported by `verify-spec.mjs`.

## Tasks

1. `scripts/verify-spec.mjs <spec>`: parse every task's **Verify** line, run each from the repo root with `DASH` and `RUN` exported, write raw stdout+exit to `.agent-team/$RUN/verify/<task>.log`, print `VERDICT: ship` or `VERDICT: fix:[ids]`; `--dry-run` lists the commands.
   Evidence: ARCHITECTURE.md §12
   Verify: node scripts/verify-spec.mjs --dry-run specs/cockpit/00-baseline.md
   Owner: builder

2. `scripts/budget.mjs`: gzip-9 of a route closure (`--route <entry>` = entry + statically imported chunks from `dist/manifest.json` + the esbuild metafile), `--chunk <name>`, `--file <name>`, `--fonts` (identity bytes), `--server` (sum of `infra/dashboard/{lite.mjs,routes/*,sse.mjs,static.mjs}`), `--legacy-app` (today's `infra/dashboard/app`, must reproduce 130 776 B); `--max <kb>` exits 1 over, `--warn` exits 0 and prints the overage.
   Evidence: ARCHITECTURE.md §9; MAP.md §6.2 C-1; ledger K-02, K-06
   Verify: node scripts/budget.mjs --legacy-app --max 160 && node scripts/budget.mjs --self-test
   Owner: builder

3. `scripts/lh-gate.mjs`: Lighthouse 13.5.0 (pinned devDependency), `--form-factor=mobile`, `--only-categories=performance`, `CHROME_PATH` resolved to Playwright's Chromium (never `/opt/google/chrome`, which is x86-64), `--max-wait-for-load=60000`, median of `--runs`, exit 1 if LCP > `--lcp` or TBT > `--tbt`, `--warn` exits 0; writes the JSON next to the log.
   Evidence: MAP.md §7.5; ledger K-29, C-07
   Verify: node scripts/lh-gate.mjs --url http://127.0.0.1:3005/ --lcp 2500 --tbt 200 --runs 1 --warn
   Owner: builder

4. `scripts/parity-capture.mjs`: against `docs/qa/probes/fixture.sh` (fixed fleet, usage, host data), `Date.now` frozen by `addInitScript`, animations and caret off, capture every route (`/`, `/history`, `/system`, `/device`, `/agents`, `/agents/<fixture>`, `/agents/<fixture>/<run>`, `/s/<fixture>`, `/md?f=<fixture>`) at 390×844 DPR 3 and 1280×800 on WebKit and Chromium into `<out>/<engine>/<route>-<w>.png`; `--ui legacy|next` picks the document.
   Evidence: ledger D-03, K-33; MAP.md §8 M-06
   Verify: node scripts/parity-capture.mjs --ui legacy --out docs/qa/baseline/cockpit && test $(ls docs/qa/baseline/cockpit/webkit | wc -l) -ge 18
   Owner: builder

5. `scripts/parity-diff.mjs <baseDir> <newDir> [--route r] --max <pct>`: per-image differing-pixel percentage (pngjs + pixelmatch, devDependencies installed off-server), exit 1 if any image exceeds `--max`, `--warn` prints only; a self-diff is 0.
   Evidence: ARCHITECTURE.md §4; ledger K-33
   Verify: node scripts/parity-diff.mjs docs/qa/baseline/cockpit docs/qa/baseline/cockpit --max 0.5
   Owner: builder

6. Gates take `UI_SRC` (default `infra/dashboard/app` now, `web` from phase 01): `scripts/chat-view-check.mjs`, `scripts/capability-check.mjs`, `scripts/chat-view-coverage.mjs`, `scripts/capability-coverage.mjs`, preflight 5c/5d/5e. Behaviour unchanged at the default.
   Evidence: MAP.md §6 'Gates that would break' 1–5; ledger K-26
   Verify: UI_SRC=infra/dashboard/app node scripts/chat-view-check.mjs && UI_SRC=infra/dashboard/app node scripts/capability-check.mjs
   Owner: builder

7. preflight: `dist/` is one manifest line whose contents are verified against `dist/manifest.json` sha256s (G-13); `PREFLIGHT_NO_LOCAL=1` skips the gitignored local pattern file so the shipped gates can be run as a Verify line; everything else unchanged.
   Evidence: MAP.md §6.4; ledger K-25
   Verify: PREFLIGHT_NO_LOCAL=1 ./scripts/preflight.sh
   Owner: builder

8. `scripts/deploy-dashboard.sh [--dry-run]`: installs `lite.mjs`, `chat-stream.mjs`, `capability.mjs`, `routes/`, `sse.mjs`, `static.mjs`, `legacy.mjs` (those that exist), `dist/`, `themes.json`, `webterm-settle.sh`, the term page; restarts `claude-dash-lite`; smokes `/healthz`; `install.sh --infra` prints it instead of the echoed `install` lines.
   Evidence: ledger C-01, K-24; MAP.md §8 M-03
   Verify: bash -n scripts/deploy-dashboard.sh && scripts/deploy-dashboard.sh --dry-run | grep -q healthz
   Owner: builder

9. Settle the `ccimg` drift: `infra/webconsole/blocks/40-ccimg.html` becomes the deployed v2 (any file type, `x-name` header) and `POST /shot` honours `x-name` for the stored filename (sanitised to `[A-Za-z0-9._-]`).
   Evidence: MAP.md §4.1 'Drift found'; ledger B-13, K-23
   Verify: grep -q 'ccimg-v2' infra/webconsole/blocks/40-ccimg.html && grep -q 'x-name' infra/dashboard/lite.mjs
   Owner: builder

10. Caddy: `/stream` joins `@nosse` and the `(sse)` snippet (`flush_interval -1`) in both site blocks of `infra/caddy/Caddyfile.template`; `e2e-infra.sh` gains a `chk` that the first `/stream` event arrives through Caddy within 3 s (`curl -N --max-time 3`).
   Evidence: MAP.md §1.2 'Caddy handling'; ledger B-05, K-16
   Verify: test $(grep -c '/stream' infra/caddy/Caddyfile.template) -ge 3 && grep -q 'stream.*3 s\|first /stream event' scripts/e2e-infra.sh
   Owner: builder

11. `templates/spec.md` (the three fixed sub-lines, front-matter keys `gates`, `budgets`, `outward`, `manual_gates`, `dev_server`) and a paragraph in `docs/architecture.md` saying when to use `templates/spec.md` and `scripts/verify-spec.mjs`.
   Evidence: plan 'Stage 8' reusable artifacts; ARCHITECTURE.md §12
   Verify: test -f templates/spec.md && grep -q 'verify-spec' docs/architecture.md
   Owner: builder

12. Record the baseline: `budget.mjs --legacy-app`, `lh-gate.mjs` on `/`, `/history`, `/system`, `/ui/agents` (3 runs each, warn), parity self-diff — all logs under `.agent-team/$RUN/verify/`.
   Evidence: MAP.md §7
   Verify: node scripts/lh-gate.mjs --url http://127.0.0.1:3005/ --lcp 2500 --tbt 200 --runs 3 --warn && node scripts/lh-gate.mjs --url http://127.0.0.1:3005/ui/agents --lcp 2500 --tbt 200 --runs 3 --warn
   Owner: verifier

13. Every new script is in `scripts/manifest.txt`, `bash -n`/`shellcheck` clean, and `e2e-agents.sh` still passes.
   Evidence: MAP.md §6.1 G-13, G-14, G-25
   Verify: PREFLIGHT_NO_LOCAL=1 ./scripts/preflight.sh && bash scripts/e2e-agents.sh
   Owner: verifier

## Out of scope

Any change to what `/`, `/ui` or `/term` render. `web/`, `build.mjs`, `dist/` — phase 01.

<!-- Generated by scripts/gen-cockpit-specs.mjs from specs/cockpit/phases.json — do not edit by hand. -->
