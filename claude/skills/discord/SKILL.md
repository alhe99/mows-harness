---
name: discord
description: Send files or messages from a session to the user's Discord server. Triggers on "send to discord", "ship to discord", or "/discord".
---

Sends to Discord ALWAYS go through the agy bridge: `~/.claude/scripts/discord-via-agy.sh`
hands your intent + files to Antigravity (`agy-run --fast`), which composes the message
text, then delivers via the low-level sender. Do NOT write the Discord summary yourself.

```bash
~/.claude/scripts/discord-via-agy.sh [-k <key>] [-i "intent"] [-n "thread name"] [--dry-run] [file ...]
```

## Rules
- **Always the bridge**: use `discord-via-agy.sh` for every session-initiated send. The
  low-level `~/.claude/scripts/discord-send.sh` is plumbing — reserved for hooks
  (discord-notify.sh) and for the bridge itself.
- **Intent, not prose**: pass `-i` as a short factual note of what this send is about
  (e.g. `-i "refactor finished, report attached, 3 tests fixed"`). agy turns it into the
  message; text >2000 chars goes in a file, not in `-i`.
- **Thread Key**: always pass `-k s-<sid8>` using the first 8 chars of the session ID
  (visible in the scratchpad directory path).
- **Fallback is automatic**: if agy is unavailable (quota/login), the bridge sends
  directly with a ⚠️ prefix — never retry composition yourself.
- **File Types**: prefer `.md`/`.txt` attachments (inline preview on desktop Discord;
  PDF/HTML are download-only chips). Files >10MB auto-fall back to a secret gist link.
- **Secrets**: webhook URL lives in `~/.claude/secrets/discord-webhook.env`. Never print
  or commit it. Sender exit 3 = webhook unconfigured → ask the user to paste it there.

## Examples
```bash
# Ship a report; agy writes the announcement text
~/.claude/scripts/discord-via-agy.sh -k s-a1b2c3d4 -i "nightly audit done, 2 findings" audit.md

# Quick status with no file
~/.claude/scripts/discord-via-agy.sh -k s-a1b2c3d4 -i "build green on staging, deploy ready"
```
