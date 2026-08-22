---
description: Change model/effort for THIS session — same conversation, applies NOW (re-hosts the session; the fix for /model & /effort not working over remote control)
argument-hint: <model|-> [effort]  ·  e.g. fable max · opus[1m] xhigh · - high
---

You are handling `/switch`. The user's argument string (may be empty) is: "$ARGUMENTS"

`/model` and `/effort` do not work over remote control, and model/effort are only read at session start. `claude-rc switch` fixes this: it rewrites the defaults, then re-hosts THIS session in place — same conversation, new model/effort, effective immediately.
Requires `claude-rc` from the fleet layer (`./install.sh --fleet`).

**If "$ARGUMENTS" is EMPTY** — print EXACTLY the menu below, then STOP. Do not call any tools.

Switch THIS session now — same conversation, tap one:

| Tap | Effect |
|---|---|
| `/switch fable max` | Fable 5 · max effort |
| `/switch fable[1m] max` | Fable 5 · 1M context · max |
| `/switch opus[1m] xhigh` | Opus 4.8 · 1M · xhigh |
| `/switch sonnet high` | Sonnet 4.6 · high |
| `/switch haiku low` | Haiku 4.5 · fast & cheap |
| `/switch - max` | keep model, effort → max |
| `/switch - high` | keep model, effort → high |

Models: `opus[1m]` `opus` `sonnet[1m]` `sonnet` `haiku` `fable` `fable[1m]` (or `-` = keep current) · Efforts: `low` `medium` `high` `xhigh` `max` `auto` (optional)

⏳ After tapping: the session blinks offline for ~15s and reconnects on the new settings. Don't send anything until it's back.

**If "$ARGUMENTS" has values** — take the first word as MODEL and the (optional) second word as EFFORT, then run ONLY this one bash command with each as a separate single-quoted argument, and report its output verbatim:

    claude-rc switch 'MODEL' 'EFFORT'

(omit the second argument entirely if no effort was given)

Then STOP IMMEDIATELY — reply with nothing beyond the command output. This session's host process is about to be replaced; anything you do after the command may be lost mid-stream. Do not run other tools, do not verify, do not summarize.

**If the first word is not a valid model (or `-`)** — list the valid values above and stop.
