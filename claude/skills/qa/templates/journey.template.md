---
mode: headless          # headless | watched (watched = needs a human login/OAuth step)
target: staging         # label your journey resolves to URLs+auth (see docs/qa/qa.env)
driver: chrome-devtools # chrome-devtools (deep) | playwright (snapshot happy-path)
---
# <Journey name>

1. navigate {BASE_URL}/...
2. <step> (reuse docs/qa/cookbook.md snippets where useful)
⏸ HUMAN(paste): <thing only you can provide, e.g. fresh auth tokens>   # optional
⏸ HUMAN(novnc): <thing you must do in the watched browser, e.g. log in>  # optional; needs mode: watched
3. <step>
✅ assert <observable truth backed by screenshot/network/status>

