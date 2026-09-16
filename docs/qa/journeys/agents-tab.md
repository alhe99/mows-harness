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
