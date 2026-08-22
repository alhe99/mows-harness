---
description: Pick/set your default model from mobile (rewrites settings.json — the native /model doesn't work over remote control)
argument-hint: "[fable[1m]|fable|opus[1m]|opus|sonnet[1m]|sonnet|haiku|opusplan|default]   (for THIS session use /switch)"
---

You are handling `/models`. The user's argument (may be empty) is: "$ARGUMENTS"

The native `/model` command does NOT work over remote control. This command is the working substitute: it rewrites the DEFAULT model in `settings.json` via the `claude-rc set-model` helper.
Requires `claude-rc` from the fleet layer (`./install.sh --fleet`).

**If "$ARGUMENTS" is EMPTY** — print EXACTLY the menu below, then STOP. Do not call any tools.

Pick a model — tap one to set it as your default:

| Tap to set | Model |
|---|---|
| `/models fable[1m]` | Fable 5 · 1M |
| `/models fable` | Fable 5 |
| `/models opus[1m]` | Opus 4.8 · 1M |
| `/models opus` | Opus 4.8 |
| `/models sonnet[1m]` | Sonnet 4.6 · 1M |
| `/models sonnet` | Sonnet 4.6 — lighter on Opus quota |
| `/models haiku` | Haiku 4.5 — fastest / cheapest |
| `/models opusplan` | plan on Opus, execute on a cheaper model |
| `/models default` | reset to account default |

⚠️ This sets the default for your **next** session. To change **this** session right now (same conversation), use `/switch <model> [effort]` instead.

**If "$ARGUMENTS" is one of the values above** — run ONLY this one bash command, then report its output verbatim. Do not read files, verify, or run anything else.

    claude-rc set-model '$ARGUMENTS'

**If "$ARGUMENTS" is anything else** — list the valid values: fable[1m], fable, opus[1m], opus, sonnet[1m], sonnet, haiku, opusplan, default — and mention `/switch` for changing the current session.
