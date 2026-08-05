# QA Cookbook — <project>

Reusable evaluate_script snippets for this project's journeys. Fill the slots.

## Auth recipe
- Token/cookie names: <e.g. sg_access_token / sg_refresh_token>
- How to get fresh ones: <e.g. infra/qa/get-token.sh, or lift from a logged-in prod tab>
- Inject snippet:
  ```js
  // (access, refresh) => { document.cookie = `...`; return { ok: true }; }
  ```

## Key selectors
- Pay button: <selector / text match>
- Terms checkbox: <selector / label text>
- Hosted iframe: <src match>

## Probes
- Session valid? <snippet>
- Flow state (overlay / verifying / confirmed)? <snippet>

