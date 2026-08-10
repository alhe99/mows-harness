# agy layer — Antigravity delegation + sessions

What ships: `ag` (cc-style tmux launcher), `agy-run` (sync delegation,
fail-loud), `agy-handoff`/`agy-gate` (worktree handoffs with verification →
review → auto-merge policy), `claude-quota` (per-account usage signal; the
70% threshold lives there). Design:
`docs/superpowers/specs/2026-08-10-antigravity-delegation-design.md`.

## One-time setup on a box

1. `./install.sh --agy` (plus `--claude` for the skill/rule/hook).
2. Install the antigravity CLI (the installer never does this for you):
   `curl -fsSL https://antigravity.google/cli/install.sh | bash`
3. Login once: run `agy` in a terminal — over SSH it prints a URL + one-time
   code. **Verify persistence:** open a NEW shell, run
   `agy -p "ping" --output-format json` — if it demands login again, the box
   lacks a freedesktop-secrets keyring (headless-Linux issue
   google-antigravity/antigravity-cli#57): install `gnome-keyring` + `dbus`
   and enable a user-session keyring, then re-login and re-verify.
4. Placeholder — populate baseline permission allow-rules in
   `~/.gemini/antigravity-cli/settings.json` (git commands + common
   build/test commands; no blanket write outside worktrees) once the live
   agy's rule schema is confirmed on this box. Until then, interactive `ag`
   sessions may prompt-block on routine commands; run `agy` interactively,
   note what it stops to ask about, and encode those as allow-rules.
5. `agy models` → copy your preferred slugs into
   `~/.config/mows-agy/config` (`AGY_FAST_MODEL`, `AGY_REVIEW_MODEL`).
   Record the agy version here when you deploy: `agy --version`.
6. Optional notifications: set `AGY_NOTIFY_CMD` in the config to any command
   taking the message as `$1` (e.g. a Discord/openclaw send wrapper).
   Fallback is always `~/.local/state/agy-handoffs/events.log` +
   `agy-handoff list`.

## Live smoke (proves the whole chain)

    t=$(mktemp -d) && git init -qb main "$t/r" && git -C "$t/r" commit -qm init --allow-empty
    agy-handoff start --repo "$t/r" --size small --verify "test -f hello.txt" \
      "Create hello.txt containing the word hello, commit it."
    # watch: tmux attach -t agyh-<id>   or the /term dashboard
    agy-handoff list          # expect: merged
    git -C "$t/r" log --oneline   # expect the merge commit

## Day-2

- Sessions: `ag [dir]` (interactive, reaped when idle+detached like cc);
  handoffs run as `agyh-<id>` (never reaped).
- `agy-handoff list` states: running / gated / parked(reason) / ready
  (green, waiting for a manual merge) / merged. `STALE` marks a dead session
  (e.g. reboot) — `agy-handoff resume <id>` continues it via agy's
  `--conversation`.
- agy quota exhausted mid-run shows up as a park with "no commits" or a
  verification failure — resume after Google's reset.
- `CLAUDE_REVIEW_TIMEOUT` (seconds, default 900) bounds the claude-side review
  on big handoffs; when Claude has no quota left, or the review times out,
  `agy-gate` falls back to agy self-review (`agy-run --effort high`, the
  smartest configured model) instead of blocking forever.
- Additional Claude profiles (e.g. a work profile at `~/.claude-<suffix>`) are
  hand-managed: `install.sh --claude` only ever writes `~/.claude`. If you
  want delegation available in another profile too, mirror the CLAUDE.md
  delegation section, the SessionStart quota hook, and the `agy-delegate`
  skill into that profile's own config dir yourself.

## Trust model

1. Handoff sessions run agy with `--dangerously-skip-permissions` by
   deliberate design: fire-and-forget would otherwise soft-deny every tool.
   The worktree confines *repo state* (blast radius), not the process — agy
   runs with the invoking user's full shell. Handoff prompts/contracts are
   authored by you or your Claude sessions; do not feed less-trusted content
   into handoffs. Hardening path if that ever changes: wrap the agy
   invocation in bubblewrap/rootless-podman with only the worktree mounted
   writable.
2. `AGY_NOTIFY_CMD` must be a bare executable path (no arguments) — the gate
   invokes it as a single token with the message as `$1`; wrap multi-arg
   senders in a tiny script.
3. Residual risk: Gate 2's review prompt embeds the handoff contract
   (`HANDOFF.md`) and the diff verbatim, with no data/instruction delimiter
   between "the contract to judge against" and "the diff being judged" —
   a prompt-injection surface if either ever contains untrusted text.
   Acceptable today because handoff contracts are self-authored (see item 1,
   above); revisit if handoff inputs ever include third-party content (an
   external PR diff, a scraped issue, etc.).
