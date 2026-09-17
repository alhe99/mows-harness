# Agents Section — Figma Redesign

**Source of truth:** Figma `QEQtYyGRLHsS3woP63iDm0`, node `44:5` ("App").

All extracted material lives at **`~/Documents/design-refs/mows-agents-44-5/`** — outside the
repo deliberately, see the warning below:

| File | What it is |
|---|---|
| `design-context.txt` | the full `get_design_context` output (54 KB) — React+Tailwind reference code with every measurement inline |
| `comp-44-5.png` | the rendered comp, for visual diffing |
| `icons/*.svg` | nine icons, 8.6 KB total, UUID-named |

The Figma asset URLs expire ~7 days from 2026-09-17. Use the downloaded bytes; never
re-fetch.

> **`design-context.txt` must not be committed.** The design's header copy contains the live
> host as a literal. The copy at the path above has it replaced with `<RUNTIME_HOST>`, but
> preflight's IPv4 check runs `git grep` over the whole tree and the repo scans its own
> history — so treat this file as reference-only, read in place. The icons are safe to commit.

## Goal

Render the agents section pixel-identical to `44:5` at the design's own width, and reflow
cleanly below it. Both, not one or the other.

## What this is NOT

No backend work. Every field the design shows is already served — this was verified
field-by-field against `apiView()` and `agentCapability()`:

| Design element | Already served by | Location |
|---|---|---|
| Profile | `capability.policy.profile` | `capability.mjs` |
| Target | `policy.workdir` | `capability.mjs` |
| Trigger | `policy.triggerTypes` | `capability.mjs` |
| Budget `$/turns` | `budget.usd_per_run`, `max_turns` | agent frontmatter |
| Daily Cap | `budget.usd_per_day` | agent frontmatter |
| Capability chips + warning | `agentCapability()` | richer than the design shows |
| Per-message cost | `turns[].cost_usd` | already rendered, `chat.mjs:401` |
| Recent Runs | `recs[]` | `apiView()` |

The `System` and `Device` nav tabs in the comp map to `/api/system` and `/api/fleet`, both
listed in the SPA spec's addendum as deliberately not implemented. **Out of scope.** They
render as tabs pointing at their existing server-rendered pages, exactly as today.

## Geometry

The artboard is 1459×994; the **content container is 1024px**, centered, `padding: 32px`,
`gap: 24px`. That is the number that matters — not 1459.

- Left column 678px · right column 320px · gap 24px
- Text: 10 / 12 / 14 / 16 / 18 px
- Spacing: 2 / 4 / 6 / 8 / 12 / 16 / 20 / 24 px
- Radii: 4 / 6 / 8 / 12 / 16 / 24 px, plus `rounded-full`

All of it is on the Tailwind scale, which is why it maps onto the existing CSS without a
rewrite of the spacing system.

## Color: our tokens already ARE the design's palette

Both sides are Tailwind zinc + emerald. Verified value-by-value against `lite.mjs:1381-1390`.
Sixteen of nineteen tokens match exactly. The complete delta:

```
--warn:  #fbbf24  ->  #ffb900
--bad:   #f87171  ->  #ff6467
--ok-bd: rgba(0,212,146,.4)  ->  rgba(0,212,146,.2)
```

Three new tokens the design introduces:

```
--bd3:   #3f3f47              zinc-700, used on control-button borders
--ok-lt: #5ee9b5              emerald-300, the live dot
--ok-dk: #00bc7d              emerald-600, pill borders
```

That is the entire color change. Do not restyle anything else.

## Typography — the one real cost

The design uses **JetBrains Mono** (Regular/Medium/Bold) and **Inter**
(Regular/Medium/SemiBold/Bold). Neither is installed on the box; the current CSS uses system
stacks. `font-src 'self'` forbids Google Fonts.

**Vendor both as variable woff2, latin subset**, into `infra/dashboard/app/vendor/`, added to
`vendor/SHA256SUMS` like every other vendored file. Two files, ~60 KB combined. Variable
fonts cover all weights in one file each — do not ship seven static faces.

Keep the system stack as the `font-family` fallback so a failed font load degrades to what
ships today rather than to Times.

## The two code changes that block everything else

These are not styling. They must land first, in one task.

**1. `loadUiAssets()` (`lite.mjs:3434`) refuses to serve anything but `.mjs` and `.css`:**

```js
if (!/\.(mjs|css)$/.test(e.name)) continue;
```

Fonts cannot be served from `app/` at all today. Replace the regex with a `UI_ASSET_TYPES`
map and add `woff2` (`font/woff2`).

**Built:** no `svg` entry. The comp's glyphs turned out to be lucide icons that `ICO` already
inlines as `currentColor` SVG at the same stroke ratio (2/24 = 1.33333/16), so the redesign
ships no icon files and `app/` gains no new route surface.

**2. The preflight ceiling measures the same two extensions** (`scripts/preflight.sh:124`):

```sh
find infra/dashboard/app -type f \( -name '*.mjs' -o -name '*.css' \)
```

Adding fonts without touching this means ~78 KB of new client assets land **without being
counted**, and the gate keeps reporting a comfortable number. That is form 3 from this
branch's own catalogue of hollow checks — *a check whose label lies about what it tests*.

**Built:** the two lists are no longer independent copies. Preflight parses `UI_ASSET_TYPES`
out of `lite.mjs` and asserts the agreement, so adding an extension to one and not the other
fails the gate by name. Verified able to fail by adding a `png` entry and watching it go red.

The ceiling is 158720 B, derived not picked: 76800 (the original CODE budget, unchanged) +
81920 (80 KiB for the two faces, measured at 79709 B). A round number just above the total
would have cut the code budget from 31 KB to 22 KB. **A silent ceiling raise is worse than a
failing gate.**

## Ruling: the chrome changes everywhere

The comp's header — "C" mark, *Mission Control*, host line, nav tabs, `+ New Session` — is
`pageChrome()`, shared by every server-rendered page AND the SPA shell. Three options were
considered:

1. Scope new styles under `.uiapp` — rejected. `/agents` and `/ui/agents` would render
   visibly different headers. Divergence between the two models is a worse outcome than the
   blast radius, and both ship simultaneously by design.
2. Fork `pageChrome` — rejected. Two copies of shared chrome is the bug that fork invites.
3. **Restyle the shared `CSS` constant and `pageChrome`.** Chosen.

This is only affordable *because* the palette already matches: the shared change is three
color values, two font families, and the chrome's own metrics. Every server-rendered page
inherits it. **If a task finds itself changing a shared rule to fix one agents-only element,
that rule belongs in an agents-scoped block instead** — the shared surface takes token and
chrome changes, nothing else.

## Responsive

The 1024px container is the design's own width, so "pixel-perfect" means: at ≥1088px
viewport (1024 + 2×32 padding) the rendering matches `44:5` exactly.

Below that:
- 1088px → 768px: container goes fluid, columns keep their 678/320 ratio.
- <768px: single column, right-hand cards stack **below** the chat, not above — the chat is
  the reason the page exists.
- The pinned tab bar, terminal FAB, `viewport-fit=cover` and
  `interactive-widget=resizes-content` behavior all stay exactly as they are. This design
  does not get to regress the mobile work already shipped and QA'd on this branch.

Note for the implementer: WebKit ignores `interactive-widget=resizes-content` — a known
finding from Task 9. Do not "fix" it.

## Constraints that will bite

- **`style-src 'nonce-…'`, no `'unsafe-inline'`.** No `style=` attributes in the Preact
  views. `grep -rn 'style=' infra/dashboard/app/` is currently empty and must stay empty.
  Dynamic values go through CSS custom properties set via `element.style.setProperty`, which
  CSP does not govern — the existing `--kb` keyboard handler is the pattern to copy.
- **No build step.** Preact + htm, vendored ESM, hand-written CSS. No Tailwind — the
  reference code is Tailwind only because that is what `get_design_context` emits.
- **Never hand-author an `<svg>` path.** In the event no icon file was needed: four glyphs
  came from `ICO`, and `send` — the one it lacked — was added using the Figma export's path
  data verbatim, keeping its native `viewBox 0 0 16 16` rather than being redrawn on the
  24-grid. The three CSS-mask icons use `ICO`'s own path data as `data:` URIs.
- Preflight's forbidden-strings check rejects any IPv4-looking literal in a tracked file, and
  the comp's header copy contains the live host as one. The header's host line comes from
  `req.headers.host` at runtime, as it already does — never from markup.
  (This section previously spelled that address out to warn about it, and preflight failed the
  commit that tracked the file. The check works.)

## Icon inventory

| File (in `~/Documents/design-refs/mows-agents-44-5/icons/`) | Node | Use |
|---|---|---|
| `4160ae80….svg` | 44:40 | `+ New Session` button |
| `baeb329d….svg` | 44:52 | agent title-row icon |
| `25645e4b….svg` | 44:65 | ControlButton 1 — restart |
| `32fb1e83….svg` | 44:69 | ControlButton 2 — **not built** |
| `df3bd632….svg` | 44:73 | ControlButton 3 — **not built** |
| `78d12c80….svg` | 44:100 | message-row icon |
| `6b0b831c….svg` | 44:128, 44:174 | system divider (used twice) |
| `7d7fc77d….svg` | 44:221 | composer `+` — **not built** |
| `0585c163….svg` | 44:227 | send |

Rename to their function on commit. Do not commit UUID filenames, and do not commit the
three icons for controls that are not built.

## New surfaces

Everything else is restyling. These do not exist yet in any form:

1. **Agent Telemetry card** — five labeled rows, all data already served.
2. **System-event divider** — centered, "Agent process exited with code 1", from the
   existing event stream.
3. **Header ControlButton — restart only.** Wired to the existing `agent-run` action.
   **Ruled 2026-09-17:** the comp's other two ControlButtons (settings, expand) and the
   composer `+` have no defined behavior and are **not built**. A control that does nothing
   is worse than an absent one, and the header row lays out correctly with a single button.
   This is a deliberate, documented departure from the comp — the only one.

## Definition of done

- `scripts/preflight.sh` ALL CLEAN, with the new ceiling stated and the asset total under it
- `scripts/e2e-agents.sh`, `./scripts/e2e-infra` green at their current counts or better
- `scripts/chat-view-check.mjs` and `scripts/capability-check.mjs` still green
- `docs/qa/probes/` pass in Chromium AND WebKit
- A QA journey at **both** viewports: ≥1088px against the comp, and 390px for the reflow
- Screenshot diff against `~/Documents/design-refs/mows-agents-44-5/comp-44-5.png` at 1088px,
  attached to the PR
- `grep -rn 'style=' infra/dashboard/app/` still empty
