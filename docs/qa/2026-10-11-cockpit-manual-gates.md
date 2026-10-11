# Cockpit rebuild — manual gates (2026-10-11)

The four gates ARCHITECTURE.md §13 assigns to the owner, signed on the day the rebuild went live (PR #6, main 3cd0aeb; fleet fix PR #7, main 2874b71). Evidence is what the owner saw on the device plus what the server logged; automation covered everything else.

| gate | result | evidence |
|---|---|---|
| phone layout review | **signed off** by alhe99, 2026-10-11 (due 2026-10-14) | all five tabs reviewed on an iPhone at 390×844 in the installed app; readable, tappable, nothing under the tab pill; parity max 0.144 % against `baseline/cockpit/` |
| real-device terminal | **passed on iOS**; Android still open | `/term` on an iPhone over LTE: on-screen keyboard without IME duplication, key bar (picker, camera, copy, paste, refresh, Esc), image upload via `/shot`, resume after a 50-minute and a 3-minute lock with the "Reconnected" overlay and scrollback intact |
| push + badge on iOS | **passed** | installed from the Home Screen, subscribed from System → Notifications (one Apple endpoint in `push-subs.json`); a hand-sent push and the real `needs-you` push both delivered; badge 1 on the icon |
| 10-minute heap | **passed (measured on Chromium)**; phone side = view stayed alive 10 min | `/agents` at 390×844, GC before each sample, 11 samples over 10 min: 9.5 MB flat, delta 0, no page errors |

## Found by the gates, fixed the same day

- Phone-width panes truncate Claude Code's status lines, so a phone-driven session never classified as working or needs-you and no push could fire → `FLEET_RE` reads the spinner and the auto-mode footer; `scripts/fleet-classify-check.mjs` (nine real captures) runs in preflight (PR #7).
- `scripts/deploy-dashboard.sh` ran the term-page installer without sudo (b11685d).

## Follow-ups (not blocking)

- A session started by hand with `ccw` has no transcript link, so the "finished a turn" push only fires for sessions opened from the dashboard.
- Footer reads `no-js` while the shell runs; `/healthz` `sseClients` counts only the legacy `/events` stream; the `/term` title mirrors the tmux window name.
- Android pass of the terminal gate.
