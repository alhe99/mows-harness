# Attributions

mows-harness itself is MIT-licensed (see [`LICENSE`](LICENSE), copyright alhe99). This file
catalogues the third-party work it vendors, adapts, or depends on — verified against the
actual files that ship in this repo, not asserted from memory.

## Vendored skills (`claude/skills/`)

### prompt-master

- **Upstream:** <https://github.com/nidhinjs/prompt-master>
- **License:** MIT, preserved in-tree at `claude/skills/prompt-master/LICENSE`
  (copyright Nidhin Joseph Nelson) — confirmed by reading the file: header, copyright
  line, and full permission/warranty text all present, unmodified.
- **Shipped:** verbatim, including `README.md` and `references/` — `SKILL.md`,
  `README.md`, `LICENSE`, `references/patterns.md`, `references/templates.md`.
  `claude/skills/prompt-master/README.md` itself points back at the same upstream
  (`git clone https://github.com/nidhinjs/prompt-master.git`).

### build-with-agent-team

- **Adapted from:** <https://github.com/coleam00/context-engineering-intro>
- **License:** unknown — no `LICENSE` file ships with this skill in `claude/skills/`, and
  `claude/skills/build-with-agent-team/SKILL.md` carries no license header or upstream URL
  of its own (confirmed: `SKILL.md` is the only file in that directory). The upstream
  relationship above reflects this harness's own build history rather than something
  verifiable from the shipped file alone — stated here for completeness, not as a
  license claim.

### graphify

- **Wraps:** the [`graphifyy`](https://pypi.org/project/graphifyy/) PyPI package.
  `claude/skills/graphify/SKILL.md` installs it on first use (`pip install graphifyy`,
  falling back to `--break-system-packages`) and documents an optional video-transcription
  extra (`pip install 'graphifyy[video]'`).
- **License:** **no `LICENSE` file ships in-tree.** `claude/skills/graphify/` contains
  exactly two files — `SKILL.md` and `.graphify_version` — confirmed by directory listing;
  neither carries license text. `graphifyy` itself is a separate, independently-published
  PyPI package with its own license, not covered by this repo's own MIT `LICENSE`. Saying
  so plainly rather than implying coverage that doesn't exist.

## Design references (not vendored — no code ships)

### awesome-claude-agents

- **Relationship:** referenced/inspirational only, for this harness's own sub-agent design
  (`claude/agents/`) — not a source this repo vendors, adapts, or copies from.
- **No code from it ships here.** Confirmed by grepping the full tree for
  `awesome-claude-agents` before writing this entry: zero hits anywhere outside this note.
- **Upstream URL deliberately not cited as a single link:** more than one project on GitHub
  shares this exact name (at least `vijaythecoder/awesome-claude-agents` and
  `rahulvrane/awesome-claude-agents`, both real, both turned up by a plain search while
  writing this entry), and nothing in this repo's own build history pins down which one
  specifically informed the design lineage. Stated plainly rather than guessing a specific
  owner/repo — the same honesty standard `build-with-agent-team`'s and `graphify`'s entries
  above already apply to their own unverifiable details.

## Infra layer — upstream projects (not vendored; installed via apt or a release download)

None of these ship any source in this repo — `infra/` only ships *configuration templates*
and *systemd units* that point at them. Install instructions for each are in the relevant
`infra/*/SETUP.md`.

| Project | Role in this harness | How it's obtained |
|---|---|---|
| [Caddy](https://caddyserver.com/) | Reverse proxy + automatic TLS in front of every other service | `apt install caddy` (`infra/SETUP.md` step 2 — `caddy`/`ttyd` share one apt line there; `infra/os/SETUP.md` covers the OS baseline only and never mentions Caddy) |
| [oauth2-proxy](https://github.com/oauth2-proxy/oauth2-proxy) | Google-gated auth in front of the dashboard, `/term`, and the QA watch view | GitHub release binary (no apt package) — `infra/oauth2-proxy/oauth2-proxy.service`'s own header |
| [ttyd](https://github.com/tsl0922/ttyd) | Web terminal serving `/term` | `apt install ttyd` (`infra/SETUP.md` step 2 — same apt line as Caddy; `claude-web-term.service.template`'s header only mentions the package name in passing, while explaining why the distro unit must be masked) |
| [noVNC](https://github.com/novnc/noVNC) + [websockify](https://github.com/novnc/websockify) | Browser-based VNC viewer for the on-demand QA watch browser | `apt install novnc websockify` (`infra/qa-watch/SETUP.md`) |
| [Xvfb](https://www.x.org/releases/X11R7.7/doc/man/man1/Xvfb.1.xhtml) | Virtual X display the headless/watched QA browser runs inside | `apt install xvfb` (`infra/qa-watch/SETUP.md`) |
| [fluxbox](http://fluxbox.org/) | Minimal window manager inside that virtual display | `apt install fluxbox` (`infra/qa-watch/SETUP.md`) |
| [x11vnc](https://github.com/LibVNC/x11vnc) | VNC server exposing the virtual display, mirrored by noVNC/websockify | `apt install x11vnc` (`infra/qa-watch/SETUP.md`) |

`infra/qa-watch/watch-browser.sh` additionally launches Google Chrome or Chromium (not
installed by any command in this repo — see `infra/qa-watch/SETUP.md`'s own "Chrome /
Chromium" section for the amd64-vs-arm64 split) and, on the agent-tooling side, the
`chrome-devtools-mcp` and `@playwright/mcp` npm packages (`claude/mcp.template.json`,
launched on demand via `npx`, not vendored).
