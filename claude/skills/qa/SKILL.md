---
name: qa
description: Run on-demand agent-driven browser QA journeys defined as markdown in docs/qa/journeys/. Headless by default; supports a noVNC manual handoff for login/OAuth/takeover steps. Use when the user says /qa, "qa run <name>", "qa init", "qa list", "run the QA journey", or asks to QA a web flow end-to-end on this VPS. Also use PROACTIVELY (without being asked) whenever a WIP task changes a webapp's UI, routing, forms, rendering, or a user flow and a runnable URL exists (local dev server, staging, or prod read-only) — verify in a real browser via a journey before reporting the work done, and to reproduce visual/flow bug reports before fixing them.
---

# Browser QA Journeys

On-demand end-to-end web QA. Works in any project. You (the agent) drive a real
browser via the chrome-devtools / playwright MCP servers and write a report. Discipline:
**observe, don't theorize** — back every assertion with a screenshot, a network request, or a
real status read, never a UI checkmark.

## Verbs

- `/qa list` — list `./docs/qa/journeys/*.md`.
- `/qa init` — scaffold into the current project: create `docs/qa/journeys/`, copy this skill's
  `templates/journey.template.md` → `docs/qa/journeys/example.md`, and
  `templates/cookbook.skeleton.md` → `docs/qa/cookbook.md`. Tell the user to fill the
  auth-recipe / selector slots.
- `/qa run <name>` — execute `docs/qa/journeys/<name>.md` (protocol below).

## `/qa run` protocol

1. Read the journey; parse frontmatter `mode` (headless|watched, default headless), `target`,
   optional `driver` (default chrome-devtools).
2. Resolve `target` → URLs + auth from the project: read `docs/qa/qa.env` if present, else use
   the script the journey names (e.g. `infra/qa/get-token.sh`). NEVER write to prod Firestore.
3. **Headroom guard (headless only):** run `~/.claude/skills/qa/qa-precheck.sh 2`. If it exits
   non-zero (BUSY/LOWMEM), tell the user and wait — do not launch.
4. **Select servers by mode:**
   - headless → `mcp__chrome-devtools__*` / `mcp__playwright__*` (self-launching, no display).
   - watched → ensure the watch-stack is up: `curl -s http://127.0.0.1:9222/json/version`; if it
     fails, start it: `sudo systemctl start claude-qa-watch` — exact argv, no `.service`
     suffix, no extra arguments: `infra/os/sudoers.d/claude-harness.template` grants this
     harness account an EXACT-MATCH NOPASSWD rule for this one command (and the matching
     `stop`), not a glob, so any other form falls through to an interactive password prompt
     instead of running. Wait ~4s, then re-check the curl. Still failing? Check
     `journalctl -u claude-qa-watch -n 50` for why (most likely cause: `infra/qa-watch/
     SETUP.md`'s apt dependencies were never installed on this box). Tell the user: "Watched
     run — open your SSH tunnel and http://localhost:6080/vnc.html to watch/act." Use
     `mcp__chrome-devtools-watch__*` / `mcp__playwright-watch__*` (attach over CDP — they do NOT
     launch their own browser). Only ONE watched run at a time (single shared Chrome) — leave
     the stack running for the next watched run rather than stopping it after each one; if it
     ever needs a clean restart (e.g. a wedged Chrome), `sudo systemctl stop claude-qa-watch`
     and let the next run's step 4 start it fresh.
5. Drive the numbered steps with those tools (chrome-devtools for deep DOM/network/console/eval;
   playwright for snapshot-driven happy paths).
6. At each `⏸ HUMAN(...)` line, STOP:
   - `⏸ HUMAN(paste): <ask>` — ask the user; wait for the typed value (e.g. fresh tokens); use it.
   - `⏸ HUMAN(novnc): <ask>` — tell the user to do it in the noVNC window; wait for "continue";
     resume on the SAME browser.
7. Honor `✅ assert ...` lines: prove each with a screenshot / network request / status read.
8. Write `docs/qa/<YYYY-MM-DD>-<name>-report.md` from `templates/report-template.md`. Link
   artifacts auto-saved under `.playwright-mcp/`.

## Files
- `qa-precheck.sh` — headroom guard (cap 2 headless).
- `templates/` — journey.template.md, cookbook.skeleton.md, report-template.md, smoke.md.

## Troubleshooting
- **chrome-devtools tools missing from a session**: the npx cache can drop the exec bit when
  `chrome-devtools-mcp@latest` updates in place. Registrations self-heal (sh -c chmod wrapper),
  but a manual fix is: `chmod +x ~/.npm/_npx/*/node_modules/chrome-devtools-mcp/build/src/bin/*.js`
  then start a new session (or `/mcp` → reconnect).
- **`*-watch` servers show failed at session start**: normal when the watch Chrome (:9222) is
  down — start the watch-stack (step 4), then `/mcp` → reconnect them.
