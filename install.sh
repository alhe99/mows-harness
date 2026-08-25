#!/usr/bin/env bash
# install.sh — layered installer for mows-harness.
#
# Layers (independent, combine any subset):
#   --claude      claude/global/CLAUDE.md + claude/{rules,agents,commands,skills,scripts} +
#                 settings/mcp templates into ~/.claude, plus plugin marketplace registration,
#                 plus a seeded ~/.claude/secrets/discord-webhook.env (placeholder). (CLAUDE.md
#                 lives one level under global/, not at the plugin root, so `claude plugin
#                 validate claude --strict` doesn't warn that it's dead weight there — see
#                 layer_claude() below; the destination is still plain ~/.claude/CLAUDE.md.)
#   --watchdogs   the 7 cron watchdog scripts (watchdogs/bin/*) into ~/.local/bin + ~/bin.
#   --infra       VPS/systemd/caddy/oauth2-proxy/qa-watch/dashboard templates, rendered into
#                 ./rendered/ for review — NEVER installed, enabled, started, or touched live
#                 by this script. Prints the exact sudo commands to do that yourself.
#   --fleet       the profile-model CLIs (fleet/bin/*) into ~/.local/bin.
#   --agy         antigravity delegation CLIs (agy/bin/*: ag, agy-run, agy-handoff, agy-gate,
#                 claude-quota, agy-notify) into ~/.local/bin; config seeded at ~/.config/mows-agy/config.
#   --all         all five of the above.
#   --non-interactive   never prompt: use env vars for every value, leave the rest as
#                 sanctioned double-brace placeholders in rendered output and warn about it.
#
# No layer flag at all (and no --non-interactive) -> interactive picker.
#
# Sanctioned template variables (env-or-prompt, see render() below): DOMAIN, EXAMPLE_SUB,
# OAUTH_CLIENT_ID, OAUTH_CLIENT_SECRET, COOKIE_SECRET, ADMIN_EMAIL, CONTEXT7_API_KEY,
# VPS_HOST, PROJECTS_ROOT, ADMIN_USER. COOKIE_SECRET and ADMIN_USER get special handling —
# see resolve_cookie_secret()/resolve_admin_user() below.
set -euo pipefail
cd "$(dirname "$0")"

usage(){
  cat <<'EOF'
usage: install.sh [--claude] [--watchdogs] [--infra] [--fleet] [--agy] [--all] [--non-interactive]

  --claude          ~/.claude config (CLAUDE.md, rules, agents, commands, skills, scripts,
                     settings, mcp template) + plugin marketplace registration
  --watchdogs       7 cron watchdog scripts -> ~/.local/bin (+ ~/bin for the limit shield)
  --infra           stage VPS/systemd/caddy/oauth2-proxy/qa-watch/dashboard templates into
                     ./rendered/ for review; never installs/enables/starts anything itself
  --fleet           profile-model CLIs (cc, ccname, ccswap, ccwt, claude-rc, claude-status, reset-claude-env)
                     -> ~/.local/bin
  --agy             antigravity delegation CLIs (ag, agy-run, agy-handoff, agy-gate, claude-quota, agy-notify) -> ~/.local/bin
  --all             all five layers above
  --non-interactive never prompt; unset template vars are left as placeholders (+ warning)

No layer flag and no --non-interactive: interactive picker.
EOF
}

NI=0; L_CLAUDE=0; L_WATCH=0; L_INFRA=0; L_FLEET=0; L_AGY=0
for a in "$@"; do case $a in
  --claude) L_CLAUDE=1;; --watchdogs) L_WATCH=1;; --infra) L_INFRA=1;;
  --fleet) L_FLEET=1;; --agy) L_AGY=1;;
  --all) L_CLAUDE=1 L_WATCH=1 L_INFRA=1 L_FLEET=1 L_AGY=1;;
  --non-interactive) NI=1;;
  -h|--help) usage; exit 0;;
  *) echo "unknown flag $a" >&2; usage >&2; exit 1;;
esac; done

# shellcheck disable=SC2015  # both checks are pure (no side effects); A&&B||C is exhaustive here
command -v apt-get >/dev/null 2>&1 && command -v systemctl >/dev/null 2>&1 \
  || { echo "mows-harness targets Ubuntu/Debian with systemd." >&2; exit 1; }

if [ $((L_CLAUDE + L_WATCH + L_INFRA + L_FLEET + L_AGY)) = 0 ]; then
  if [ "$NI" = 1 ]; then
    L_CLAUDE=1
  else
    echo "Layers: 1) claude config  2) watchdogs  3) infra (VPS, staged only)  4) fleet  5) agy"
    read -rp "install which? (e.g. 1 2 4, or 'all'): " ans
    [[ $ans == *all* ]] && L_CLAUDE=1 L_WATCH=1 L_INFRA=1 L_FLEET=1 L_AGY=1
    [[ $ans == *1* ]] && L_CLAUDE=1
    [[ $ans == *2* ]] && L_WATCH=1
    [[ $ans == *3* ]] && L_INFRA=1
    [[ $ans == *4* ]] && L_FLEET=1
    [[ $ans == *5* ]] && L_AGY=1
    if [ $((L_CLAUDE + L_WATCH + L_INFRA + L_FLEET + L_AGY)) = 0 ]; then
      echo "nothing selected, nothing to do." >&2; exit 1
    fi
  fi
fi

TS=$(date +%s)
BK="$HOME/.claude.bak-$TS"

# backup <path>: if <path> exists, copy it (file or dir, as-is) under $BK before it gets
# overwritten. <path> may be $HOME-relative (the common case) or CWD-relative (rendered/
# staging in layer_infra) — either way the copy lands under $BK, never outside it.
backup(){
  [ -e "$1" ] || return 0
  local rel=${1#"$HOME"/}
  mkdir -p "$BK/$(dirname "$rel")"
  cp -a "$1" "$BK/$rel" || true
}

# render <src> <dst>: copy <src> to <dst>, substituting every sanctioned {{ VAR }} found in
# <src> from the environment, or by prompting (interactive mode only). A var left unset in
# --non-interactive mode is NOT substituted — the literal placeholder stays in <dst> and a
# WARN line is printed. Backs up any pre-existing <dst> first (see backup() above).
# Note: [A-Z0-9_] (not [A-Z_]) — several sanctioned names (e.g. CONTEXT7_API_KEY) contain
# digits; a letters-only class would silently never match them at all.
render(){
  local src=$1 dst=$2 out v val
  out=$(cat "$src")
  for v in $(grep -hoE '\{\{[A-Z0-9_]+\}\}' "$src" | tr -d '{}' | sort -u); do
    val=${!v:-}
    if [ -z "$val" ] && [ "$NI" = 0 ]; then
      read -rp "$v = " val
      # Remember a non-empty answer for the rest of this run: several vars (DOMAIN above
      # all) recur across multiple files, and re-prompting for the same value on every one
      # of them would be a real annoyance, not just a cosmetic nit.
      [ -n "$val" ] && export "$v=$val"
    fi
    if [ -z "$val" ]; then
      echo "WARN: $v unset, leaving placeholder in $dst"
      continue
    fi
    out=${out//\{\{$v\}\}/$val}
  done
  backup "$dst"
  mkdir -p "$(dirname "$dst")"
  printf '%s\n' "$out" > "$dst"
}

# resolve_cookie_secret: SPECIAL CASE. oauth2-proxy's cookie_secret is never prompted for —
# generate it if unset, in EITHER mode, so a rendered oauth2-proxy.cfg never ships a
# placeholder here (a missing cookie_secret is a hard startup failure for oauth2-proxy, not
# a soft "fill this in later"). Exported so every render() call in this run reuses the same
# value instead of generating a fresh one per file.
resolve_cookie_secret(){
  [ -n "${COOKIE_SECRET:-}" ] && return 0
  command -v openssl >/dev/null 2>&1 || { echo "WARN: openssl not found, cannot auto-generate COOKIE_SECRET" >&2; return 0; }
  # URL-safe base64, not plain: oauth2-proxy decodes cookie_secret with Go's URL encoding,
  # so a secret containing '+' or '/' fails to decode, gets treated as 44 raw bytes, and the
  # service refuses to start ("must be 16, 24, or 32 bytes ... but is 44 bytes"). Plain
  # `openssl rand -base64 32` hits that roughly 3 runs in 4. The tr is oauth2-proxy's own
  # documented form.
  COOKIE_SECRET=$(openssl rand -base64 32 | tr -- '+/' '-_')
  export COOKIE_SECRET
  echo "COOKIE_SECRET auto-generated (openssl rand -base64 32, URL-safe)"
}

# resolve_admin_user: SPECIAL CASE. Defaults to the invoking $USER; in interactive mode this
# is offered as a confirm-or-override prompt, never a blind "type it yourself" prompt like
# the generic path — the point is that ADMIN_USER should virtually never end up unresolved.
# Exported so it's asked at most once per run, however many infra files reference it.
resolve_admin_user(){
  [ -n "${ADMIN_USER:-}" ] && return 0
  local def ans
  def=${USER:-$(id -un)}
  ans=$def
  if [ "$NI" = 0 ]; then
    read -rp "ADMIN_USER [$def]: " ans
    ans=${ans:-$def}
  fi
  export ADMIN_USER="$ans"
}

# marketplaces_from_settings / plugins_from_settings: the single source of truth for the
# marketplace-add and plugin-install lists is claude/settings.template.json itself — these
# two just read it back out, grep/sed only (no jq/python3 dependency). Each pattern targets
# a JSON shape that appears in this file ONLY under the field we want:
#   marketplaces_from_settings: extraKnownMarketplaces.*.source.repo values, e.g.
#     "repo": "DietrichGebert/ponytail"  ->  DietrichGebert/ponytail
#   plugins_from_settings: enabledPlugins keys (always "<plugin>@<marketplace>": true), e.g.
#     "superpowers@claude-plugins-official": true  ->  superpowers@claude-plugins-official
# If a future edit to settings.template.json ever adds a "repo" field elsewhere, or an
# enabledPlugins-shaped key outside that block, these would need to get fussier — not a
# concern today (verified against the file as shipped: neither pattern matches anything
# else in it).
marketplaces_from_settings(){
  grep -oE '"repo": *"[^"]+"' claude/settings.template.json | grep -oE '"[^"]+"$' | tr -d '"'
}
plugins_from_settings(){
  grep -oE '"[A-Za-z0-9_.-]+@[A-Za-z0-9_.-]+": *true' claude/settings.template.json \
    | sed -E 's/^"//; s/": *true$//'
}

layer_claude(){
  echo "== claude config =="
  mkdir -p "$HOME/.claude"
  # rules, agents, skills carry no template placeholders (verified) — plain re-sync copy.
  # CLAUDE.md likewise, but its source lives at claude/global/CLAUDE.md (not claude/CLAUDE.md)
  # — relocated one level down so it isn't sitting at the plugin root, which is what made
  # `claude plugin validate claude --strict` warn "CLAUDE.md at the plugin root is not
  # loaded as project context" (true and harmless for the plugin loader, since this repo
  # never relies on that mechanism for it — only on this very copy step). The destination is
  # unaffected: still a plain ~/.claude/CLAUDE.md. "re-sync" (backup, wipe, recopy) rather
  # than a bare cp -r merge, so a file dropped from the repo since your last install
  # actually disappears from ~/.claude too, matching this repo's own convention elsewhere
  # (fleet/add-agent.sh's config sync).
  backup "$HOME/.claude/CLAUDE.md"
  rm -f "$HOME/.claude/CLAUDE.md"
  cp "claude/global/CLAUDE.md" "$HOME/.claude/CLAUDE.md"
  local f
  for f in rules agents skills scripts; do
    backup "$HOME/.claude/$f"
    rm -rf "$HOME/.claude/$f"
    cp -r "claude/$f" "$HOME/.claude/"
  done
  # scripts/ are the hook targets settings.template.json wires up (quota-gate on
  # UserPromptSubmit, discord-notify on Notification) plus the discord send/bridge pair.
  # The Discord ones stay inert until a real webhook URL replaces the placeholder below;
  # seed only if absent, never clobber (same rule as agy's config).
  if [ ! -f "$HOME/.claude/secrets/discord-webhook.env" ]; then
    mkdir -p "$HOME/.claude/secrets"
    chmod 700 "$HOME/.claude/secrets"
    printf 'DISCORD_WEBHOOK_URL=PASTE_WEBHOOK_URL_HERE\n' > "$HOME/.claude/secrets/discord-webhook.env"
    chmod 600 "$HOME/.claude/secrets/discord-webhook.env"
    echo "seeded ~/.claude/secrets/discord-webhook.env — paste a Discord webhook URL there to enable notifications (see claude/skills/discord/SKILL.md)"
  fi
  # commands/ DOES carry placeholders in 2 of its 9 files (open.md, work.md: {{PROJECTS_ROOT}}).
  # Route every file through render() uniformly rather than special-casing those two — render()
  # degrades to a plain copy when a file has no {{ VAR }} to substitute, so this is safe for all
  # nine. Wipe-then-recreate first (same re-sync rationale as above) so render()'s own backup()
  # call on each individual destination file is a no-op — the meaningful backup already
  # happened here, once, at the directory level; without the wipe, render() would back up the
  # file THIS loop just wrote a moment ago instead of the user's real prior copy.
  backup "$HOME/.claude/commands"
  rm -rf "$HOME/.claude/commands"
  mkdir -p "$HOME/.claude/commands"
  local cf
  for cf in claude/commands/*.md; do
    render "$cf" "$HOME/.claude/commands/$(basename "$cf")"
  done
  render claude/settings.template.json "$HOME/.claude/settings.json"
  render claude/mcp.template.json      "$HOME/.claude/mcp-interactive.json"

  # Marketplaces/plugins, DERIVED from claude/settings.template.json at runtime (not a
  # second hand-maintained copy) — extraKnownMarketplaces for the `marketplace add` calls,
  # enabledPlugins for the `/plugin install` list. Grep/sed only, no jq/python3 dependency:
  # settings.template.json is flat enough that '"repo": "..."' and '"name@marketplace":
  # true' each occur ONLY where they mean what we want here (verified against the actual
  # file — see marketplaces_from_settings/plugins_from_settings below). This is the fix for
  # a real desync risk: these two lists used to be hardcoded literals that could silently
  # drift from settings.template.json if either was edited without the other.
  # claude-plugins-official is assumed built into the CLI already (settings.template.json
  # itself never lists it under extraKnownMarketplaces) — only the marketplaces it DOES
  # list, plus this repo's own local checkout, need an explicit `marketplace add`.
  if command -v claude >/dev/null 2>&1 && [ "$NI" = 0 ]; then
    echo "registering marketplaces via the claude CLI (each failure is non-fatal)..."
    claude plugin marketplace add "$PWD" || echo "WARN: could not register mows-harness marketplace from $PWD"
    while IFS= read -r mp; do
      claude plugin marketplace add "$mp" || true
    done < <(marketplaces_from_settings)
  else
    echo "claude CLI not on PATH (or --non-interactive) — register these by hand instead:"
    echo "  /plugin marketplace add $PWD"
    while IFS= read -r mp; do
      echo "  /plugin marketplace add $mp"
    done < <(marketplaces_from_settings)
  fi
  echo "then, inside Claude Code, install whichever plugins you want:"
  echo "  /plugin install mows-core@mows-harness"
  while IFS= read -r pl; do
    echo "  /plugin install $pl"
  done < <(plugins_from_settings)
}

layer_watchdogs(){
  echo "== watchdogs =="
  mkdir -p "$HOME/.local/bin" "$HOME/bin" "$HOME/.local/state"
  install -m755 watchdogs/bin/claude-health watchdogs/bin/claude-mem-health \
    watchdogs/bin/reap-idle-claude watchdogs/bin/reap-mcp-orphans watchdogs/bin/log-boot \
    watchdogs/bin/patch-health \
    "$HOME/.local/bin/"
  install -m755 watchdogs/bin/claude-limit-shield.sh "$HOME/bin/"
  echo "installed: claude-health claude-mem-health reap-idle-claude reap-mcp-orphans log-boot patch-health -> ~/.local/bin"
  echo "installed: claude-limit-shield.sh -> ~/bin"
  echo "== add to crontab -e (cron does not expand \$HOME — already expanded below) =="
  sed "s|\$HOME|$HOME|g" watchdogs/crontab.example

  if [ "$NI" = 0 ]; then
    local lr
    read -rp "stage + sudo-install the logrotate config to /etc/logrotate.d/claude-harness now? [y/N] " lr
    if [[ $lr == y* ]]; then
      local tmp
      tmp=$(mktemp)
      sed "s|~|$HOME|g" watchdogs/logrotate.d/claude-harness > "$tmp"
      if sudo install -o root -g root -m644 "$tmp" /etc/logrotate.d/claude-harness; then
        echo "installed /etc/logrotate.d/claude-harness"
      else
        echo "WARN: sudo install failed — run manually, see command below" >&2
      fi
      rm -f "$tmp"
    else
      echo "skipped. Run manually when ready:"
      echo "  sed \"s|~|\$HOME|g\" watchdogs/logrotate.d/claude-harness | sudo tee /etc/logrotate.d/claude-harness"
    fi
  else
    echo "logrotate (skipped, --non-interactive) — run manually when ready:"
    echo "  sed \"s|~|\$HOME|g\" watchdogs/logrotate.d/claude-harness | sudo tee /etc/logrotate.d/claude-harness"
  fi
}

layer_infra(){
  echo "== infra (staged only — nothing is installed, enabled, started, or touched live) =="
  mkdir -p rendered
  resolve_admin_user
  resolve_cookie_secret

  echo "-- OS baseline (infra/os/, full walkthrough: infra/os/SETUP.md) --"
  echo "tmux (no placeholders, plain copy — not staged):  cp infra/os/tmux.conf ~/.tmux.conf"
  echo "firewall — REVIEW infra/os/firewall/rules.v4.template + rules.v6.template first, then:"
  echo "  sudo iptables-apply infra/os/firewall/rules.v4.template"
  echo "  sudo ip6tables-apply infra/os/firewall/rules.v6.template"
  echo "  (persist: sudo apt-get install -y iptables-persistent; sudo install -m0644 infra/os/firewall/rules.v4.template /etc/iptables/rules.v4 (+ v6); sudo systemctl restart netfilter-persistent)"
  echo "docker-user-fence (only if a Docker-published port must stay off the public internet):"
  echo "  edit infra/os/firewall/docker-user-fence.service.template's IFACE= and --dport first (see its header), then:"
  echo "  sudo install -m0644 infra/os/firewall/docker-user-fence.service.template /etc/systemd/system/docker-user-fence.service && sudo systemctl daemon-reload && sudo systemctl enable --now docker-user-fence.service"
  echo "fail2ban:              sudo apt-get install -y fail2ban && sudo systemctl enable --now fail2ban"
  echo "unattended-upgrades:   sudo apt-get install -y unattended-upgrades && sudo dpkg-reconfigure --priority=low unattended-upgrades"
  echo "sshd (only after confirming key auth works, in a SECOND session):"
  echo "  sudo sed -i 's/^#\\?PasswordAuthentication.*/PasswordAuthentication no/' /etc/ssh/sshd_config && sudo systemctl reload ssh"
  echo "ttyd: mask its distro unit IMMEDIATELY after 'sudo apt-get install -y caddy ttyd' (infra/SETUP.md step 2), not later:"
  echo "  sudo systemctl mask --now ttyd.service   # Debian's package auto-enables+starts an unauthenticated unit on :7681; this harness only runs ttyd via claude-web-term.service, behind Caddy+oauth2-proxy"

  render infra/os/sudoers.d/claude-harness.template rendered/claude-harness.sudoers
  echo "sudoers (rendered for ADMIN_USER=$ADMIN_USER):"
  echo "  sudo visudo -cf rendered/claude-harness.sudoers && sudo install -o root -g root -m0440 rendered/claude-harness.sudoers /etc/sudoers.d/claude-harness"
  echo "linger (required for claude-rc's non-sudo systemd-run --user paths):"
  echo "  sudo loginctl enable-linger $ADMIN_USER"

  echo "-- remote-control units + transcript prune (infra/systemd/) --"
  render infra/systemd/claude-remote@.service         rendered/claude-remote@.service
  render infra/systemd/claude-remote-control@.service rendered/claude-remote-control@.service
  echo "  sudo install -m644 rendered/claude-remote@.service rendered/claude-remote-control@.service /etc/systemd/system/ && sudo systemctl daemon-reload"
  echo "  (never auto-enabled/started by this script — see fleet/SETUP.md for claude-rc, the intended way to start/stop these)"
  echo "transcript prune (no SETUP.md for this one — full command here):"
  echo "  sudo install -m755 infra/systemd/claude-transcript-prune.sh /usr/local/sbin/claude-transcript-prune.sh"
  echo "  sudo install -m644 infra/systemd/claude-transcript-prune.service infra/systemd/claude-transcript-prune.timer /etc/systemd/system/"
  echo "  sudo systemctl daemon-reload && sudo systemctl enable --now claude-transcript-prune.timer"

  echo "-- caddy + oauth2-proxy (infra/caddy/, infra/oauth2-proxy/ — no SETUP.md; commands here) --"
  render infra/caddy/Caddyfile.template rendered/Caddyfile
  echo "  review rendered/Caddyfile, then: caddy validate --config rendered/Caddyfile --adapter caddyfile"
  echo "  sudo install -m644 rendered/Caddyfile /etc/caddy/Caddyfile && sudo systemctl reload caddy"
  echo "  (never caddy fmt --overwrite on a template/rendered copy — it mangles the {{ }} placeholders)"
  render infra/oauth2-proxy/oauth2-proxy.cfg.template rendered/oauth2-proxy.cfg
  render infra/oauth2-proxy/emails.txt.template       rendered/emails.txt
  echo "  oauth2-proxy prerequisites (see infra/oauth2-proxy/oauth2-proxy.service header for the binary download):"
  echo "    sudo useradd --system --no-create-home --shell /usr/sbin/nologin oauth2-proxy"
  echo "    sudo install -d -o oauth2-proxy -g oauth2-proxy -m0750 /etc/oauth2-proxy"
  echo "    sudo install -o oauth2-proxy -g oauth2-proxy -m0640 rendered/oauth2-proxy.cfg rendered/emails.txt /etc/oauth2-proxy/"
  echo "    sudo install -m644 infra/oauth2-proxy/oauth2-proxy.service /etc/systemd/system/oauth2-proxy.service && sudo systemctl daemon-reload"

  echo "-- web console /term (infra/webconsole/ — no SETUP.md; commands here) --"
  echo "  sudo mkdir -p /opt/claude-dashboard"
  echo "  sudo install -m644 infra/webconsole/web-term.sh infra/webconsole/clipboard-shim.html /opt/claude-dashboard/"
  echo "  (ttyd's distro unit should already be masked from the OS-baseline step above — nothing left to do for it here)"
  render infra/webconsole/claude-web-term.service.template rendered/claude-web-term.service
  render infra/webconsole/clipboard.conf                   rendered/clipboard.conf
  echo "  install ONE of the next two, not both (see clipboard.conf's own header):"
  echo "    A) sudo install -m644 rendered/claude-web-term.service /etc/systemd/system/claude-web-term.service"
  echo "    B) (drop-in onto an already-deployed unit) sudo mkdir -p /etc/systemd/system/claude-web-term.service.d && sudo install -m644 rendered/clipboard.conf /etc/systemd/system/claude-web-term.service.d/clipboard.conf"
  echo "  sudo systemctl daemon-reload"
  echo "  then produce /term's actual HTML page (mentioned explicitly — do not skip, or /term 404s):"
  echo "    infra/webconsole/make-term-index.sh"
  echo "  (/opt/claude-dashboard is root:root 0755 from the 'sudo mkdir -p' above, so this plain,"
  echo "   non-root run can't write the result directly — it detects that, keeps the spliced page"
  echo "   at a temp path, and prints the exact 'sudo install -D -m644 <tmp> .../term-index.html'"
  echo "   command to finish; idempotent either way, safe to re-run after)"
  echo "  optional, not wired to any keybinding by default: infra/webconsole/tmux-buffer-to-osc52.sh (see its own header)"

  echo "-- dashboard (infra/dashboard/ — no SETUP.md; commands here) --"
  echo "  sudo mkdir -p /opt/claude-dashboard"
  echo "  sudo install -m644 infra/dashboard/lite.mjs /opt/claude-dashboard/lite.mjs"
  echo "  sudo install -m644 infra/dashboard/claude-dash-lite.service.template /etc/systemd/system/claude-dash-lite.service && sudo systemctl daemon-reload"
  echo "  (runs as root by design — see the template's own header comment; restart after provisioning any new profile/agent)"
  echo "  optional, for the dashboard system panel's spend metrics: sudo npm i -g ccusage"
  echo "  (limits come from the agy layer's claude-quota; both degrade gracefully when absent)"

  echo "-- Android web console (infra/droid/ — OPTIONAL; full walkthrough: infra/droid/SETUP.md) --"
  render infra/droid/ws-scrcpy.service.template rendered/ws-scrcpy.service
  echo "  everything else (binder modules, redroid container, ws-scrcpy clone+patch+build,"
  echo "  the Caddyfile's droid.\$DOMAIN vhost) is manual by design — see infra/droid/SETUP.md;"
  echo "  skip the whole layer and nothing else in this harness cares"

  echo "-- QA watch-stack (infra/qa-watch/ — full walkthrough: infra/qa-watch/SETUP.md) --"
  echo "  sudo apt install -y xvfb fluxbox x11vnc websockify novnc xdotool"
  echo "  (amd64: Google Chrome .deb; arm64: sudo apt install -y chromium-browser — see SETUP.md)"
  render infra/qa-watch/claude-qa-watch.service.template rendered/claude-qa-watch.service
  echo "  install -m755 infra/qa-watch/watch-browser.sh \"\$HOME/watch-browser.sh\""
  echo "  sudo install -m644 rendered/claude-qa-watch.service /etc/systemd/system/claude-qa-watch.service && sudo systemctl daemon-reload"
  echo "  ships disabled ON PURPOSE — do NOT systemctl enable it; the qa skill starts/stops it on demand"
  echo "  (sudoers grants exact-match start/stop only, see rendered/claude-harness.sudoers above)"

  echo "rendered/ now holds every template this layer knows how to render — review before installing any of it."
}

layer_fleet(){
  echo "== fleet (profile-model CLIs) =="
  mkdir -p "$HOME/.local/bin"
  install -m755 fleet/bin/cc fleet/bin/ccname fleet/bin/ccswap fleet/bin/ccwt \
    fleet/bin/claude-rc fleet/bin/reset-claude-env fleet/bin/claude-status "$HOME/.local/bin/"
  echo "installed: cc ccname ccswap ccwt claude-rc reset-claude-env claude-status -> ~/.local/bin"
  if ! command -v jq >/dev/null 2>&1; then
    echo "WARN: jq not found — fleet commands (claude-rc set-effort/set-model/resume) require jq: sudo apt-get install -y jq"
  fi
  echo "add-agent.sh stays in-repo (the agent model is a separate, per-account tool):"
  echo "  sudo fleet/add-agent.sh <name> [--remote-control] [--vhost[=<domain>]]"
  echo "see fleet/SETUP.md for the profile-model-vs-agent-model overview and the full add-agent.sh walkthrough."
}

layer_agy(){
  echo "== agy (antigravity delegation) =="
  mkdir -p "$HOME/.local/bin" "$HOME/.config/mows-agy" "$HOME/.local/state/agy-handoffs"
  install -m755 agy/bin/ag agy/bin/agy-run agy/bin/agy-handoff agy/bin/agy-gate \
    agy/bin/claude-quota agy/bin/agy-notify "$HOME/.local/bin/"
  # config is user-owned after first install: seed only if absent, never clobber
  if [ ! -f "$HOME/.config/mows-agy/config" ]; then
    install -m644 agy/config.example "$HOME/.config/mows-agy/config"
    echo "seeded ~/.config/mows-agy/config — set model slugs there after running: agy models"
  fi
  echo "installed: ag agy-run agy-handoff agy-gate claude-quota agy-notify -> ~/.local/bin"
  if ! command -v jq >/dev/null 2>&1; then
    echo "WARN: jq not found — agy delegation requires jq: sudo apt-get install -y jq"
  fi
  if ! command -v agy >/dev/null 2>&1; then
    echo "antigravity CLI (agy) not found — install it yourself when ready (never run by this script):"
    echo "  curl -fsSL https://antigravity.google/cli/install.sh | bash"
    echo "then login once over SSH (agy prints a URL + one-time code) and see agy/SETUP.md"
  fi
}

[ "$L_CLAUDE" = 1 ] && layer_claude
[ "$L_WATCH"  = 1 ] && layer_watchdogs
[ "$L_INFRA"  = 1 ] && layer_infra
[ "$L_FLEET"  = 1 ] && layer_fleet
[ "$L_AGY"    = 1 ] && layer_agy

if [ "$NI" = 0 ] && [ $((L_CLAUDE + L_WATCH + L_FLEET + L_AGY)) -gt 0 ]; then
  read -rp "append ~/.local/bin to PATH in ~/.bashrc? [y/N] " p
  if [[ $p == y* ]]; then
    # shellcheck disable=SC2016  # $HOME must stay literal — it's meant to expand later,
    # each time .bashrc is sourced, not once now at install time.
    printf '\n# mows-harness\nexport PATH="$HOME/.local/bin:$PATH"\n' >> "$HOME/.bashrc"
    echo "appended to $HOME/.bashrc"
  fi
fi

echo "done."
[ -d "$BK" ] && echo "backups (if anything pre-existing got overwritten): $BK"
exit 0
