---
description: Pick/set your default effort level from mobile (rewrites settings.json — the native /effort doesn't work over remote control)
argument-hint: "[low|medium|high|xhigh|max|auto]   (for THIS session use /switch - <effort>)"
---

You are handling `/efforts`. The user's argument (may be empty) is: "$ARGUMENTS"

The native `/effort` command does NOT work over remote control. This command is the working substitute: it rewrites the DEFAULT effort in `settings.json` via the `claude-rc set-effort` helper.
Requires `claude-rc` from the fleet layer (`./install.sh --fleet`).

**If "$ARGUMENTS" is EMPTY** — print EXACTLY the menu below, then STOP. Do not call any tools.

Pick an effort level — tap one to set it as your default:

| Tap to set | Level |
|---|---|
| `/efforts low` | fastest, minimal reasoning |
| `/efforts medium` | light reasoning |
| `/efforts high` | balanced |
| `/efforts xhigh` | deep |
| `/efforts max` | deepest |
| `/efforts auto` | reset to the model default |

⚠️ This sets the default for your **next** session. To change **this** session right now (same conversation), use `/switch - <effort>` instead.

**If "$ARGUMENTS" is one of low / medium / high / xhigh / max / auto** — run ONLY this one bash command, then report its output verbatim. Do not read files, verify, or run anything else.

    claude-rc set-effort '$ARGUMENTS'

**If "$ARGUMENTS" is anything else** — tell the user the valid values are: low, medium, high, xhigh, max, auto.
