---
mode: headless
target: none
driver: chrome-devtools
---
# Smoke — example.com canary (no auth, no payment)

1. navigate https://example.com
2. take_snapshot, then take_screenshot
✅ assert the page heading/title contains "Example Domain"

