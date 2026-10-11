# Cockpit rebuild — manual gates (2026-10-11)

The four gates ARCHITECTURE.md §13 assigns to the owner, signed on the day the rebuild went live (PR #6, main 3cd0aeb; fleet fix PR #7, main 2874b71). Evidence is what the owner saw on the device plus what the server logged; automation covered everything else.

| gate | result | evidence |
|---|---|---|
| phone layout review | **signed off** by alhe99, 2026-10-11 (due 2026-10-14) | all five tabs reviewed on an iPhone at 390×844 in the installed app; readable, tappable, nothing under the tab pill; parity max 0.144 % against `baseline/cockpit/` |
| real-device terminal | **passed on iOS and Android** | `/term` on an iPhone over LTE: on-screen keyboard without IME duplication, key bar (picker, camera, copy, paste, refresh, Esc), image upload via `/shot`, resume after a 50-minute and a 3-minute lock with the "Reconnected" overlay and scrollback intact. Android (Chrome 154, installed app): keyboard with the key bar above it, gesture navigation, rotation, lock-and-resume, all checked by the owner the same day |
| push + badge on iOS | **passed**; push also **passed on Android** | installed from the Home Screen, subscribed from System → Notifications (one Apple endpoint in `push-subs.json`); a hand-sent push and the real `needs-you` push both delivered; badge 1 on the icon. Android: subscribed through Firebase (second endpoint in `push-subs.json`), the same two pushes delivered; the first subscribe attempts failed inside Chrome ("push service error", no request reached the server) until the owner fixed Chrome's own permissions on the phone |
| 10-minute heap | **passed (measured on Chromium)**; phone side = view stayed alive 10 min | `/agents` at 390×844, GC before each sample, 11 samples over 10 min: 9.5 MB flat, delta 0, no page errors |

## Found by the gates, fixed the same day

- Phone-width panes truncate Claude Code's status lines, so a phone-driven session never classified as working or needs-you and no push could fire → `FLEET_RE` reads the spinner and the auto-mode footer; `scripts/fleet-classify-check.mjs` (nine real captures) runs in preflight (PR #7).
- `scripts/deploy-dashboard.sh` ran the term-page installer without sudo (b11685d).
- The installed app opened the terminal, not the dashboard: owner decision O-5, a bare `/app` now answers the cockpit home (PR #9).
- Android 15 forces the installed app edge-to-edge and Chrome 154 colours the status bar icons from the system theme, so a light-theme phone could not read the clock; the pages now set a light `theme-color` there (PR #10). Three other approaches were ruled out on the phone first.

## Follow-ups (not blocking)

- A session started by hand with `ccw` has no transcript link, so the "finished a turn" push only fires for sessions opened from the dashboard.
- Footer reads `no-js` while the shell runs; `/healthz` `sseClients` counts only the legacy `/events` stream; the `/term` title mirrors the tmux window name.
- Re-check the Android status bar after Chrome 156 and drop the light-bar override if Chrome handles it.
