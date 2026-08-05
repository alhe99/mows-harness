---
description: Mobile-friendly background-tasks view — reports running workflows & background jobs as text (the web "Background tasks" panel can't render on mobile)
---

The rich "Background tasks" side panel is web/desktop only and does not render on the mobile app / remote control. Reconstruct it as **text** so it shows on mobile.

Do this now:

1. Call the **TaskList** tool to enumerate all background tasks and workflows in this session (running AND recently finished).
2. For any workflow, also pull its detail (phases, current phase, agent count, token usage, elapsed) via **TaskGet** if needed.
3. Report concisely as a compact Markdown table — one row per task/workflow — with columns: **Name · Type · Status · Phase · Agents · Tokens · Elapsed** (omit a column if no item has data for it).
4. After the table, add one short line: the single most useful takeaway (e.g. "ledger audit is in Verify, 4/6 agents done" or "nothing running").
5. If nothing is running or recently finished, just say so in one line. Do **not** start, stop, or modify anything — this is read-only. Do **not** add analysis beyond the table + one takeaway line.

If the user wants to act on something (stop a workflow, see a task's output), they'll ask in plain language next — then use TaskStop / TaskOutput accordingly.
