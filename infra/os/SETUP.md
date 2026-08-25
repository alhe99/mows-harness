# Infra OS layer — setup

tmux defaults, a generic IPv4/IPv6 firewall baseline, and a scoped sudoers rule for the
fleet layer (`fleet/bin/claude-rc`, `watchdogs/bin/claude-health`). Ubuntu/Debian target;
every step below assumes `apt` + `systemctl`. Do these roughly in order — later steps
(sudoers) assume the account already exists and can `ssh` in with a key.

Throughout, `<your-user>` means the non-root account this harness runs as. This file is
prose, so it spells that out in angle brackets instead of a double-brace placeholder token
— those only appear in the actual template files below, which `install.sh` (or you, by
hand) renders.

## 1. tmux

```bash
cp infra/os/tmux.conf ~/.tmux.conf
```

Prefix remapped to `C-q`, Alt+Arrow pane switching, mouse on, 50000-line history, and
`set-titles` so the attached client's title bar carries `<session> · <dir>` — which is
what names each `/term` browser tab (the web terminal mirrors terminal titles into
`document.title`), keeping many session windows tellable apart. Nothing in it is
account- or host-specific — it's a straight copy, safe to drop in as-is.

Already-running tmux server? Apply without restarting anything:

```bash
tmux source-file ~/.tmux.conf
```

### 1b. The tmux server as its own unit — and off needrestart's list

Every live Claude Code session is a process inside *some* tmux server. Left to itself that
server is forked by whichever client came first — on a harness box that is ttyd, so the
server (and every session) ends up inside `claude-web-term.service`'s cgroup, and **any
restart of ttyd kills them all**: a hand-run `systemctl restart` deploying a `/term` fix, or
`needrestart` after `unattended-upgrades` replaced libcurl (2026-08-25, both, one night).
`claude-tmux.service` starts the server first, in its own cgroup, and `claude-web-term`
`Requires=` it; ttyd can then be restarted at will — clients drop for a second and reconnect
to sessions that never noticed.

```bash
sed "s/{{ADMIN_USER}}/$USER/g" infra/os/claude-tmux.service.template > rendered/claude-tmux.service
sudo install -m644 rendered/claude-tmux.service /etc/systemd/system/
sudo install -m644 infra/os/needrestart-claude.conf /etc/needrestart/conf.d/claude.conf
sudo systemctl daemon-reload && sudo systemctl enable claude-tmux
sudo needrestart -r l          # claude-tmux must NOT be listed
```

On a fresh box just `enable --now` it before `claude-web-term` (infra/SETUP.md §6). On a box
that already runs sessions, do **not** `start` it yet — the old server holds the socket and
`tmux -D` would fail. The switch-over is one deliberate `sudo systemctl restart
claude-web-term` at a quiet moment: that kills the old server for the last time, and the
`Requires=` brings `claude-tmux` up ahead of ttyd. Every restart after that is free.

Session names (`ccname`, dashboard ✎) are also written to `~/.local/state/cc-labels/`, and
the `session-created` hook in `tmux.conf` re-applies them — so a name survives even the
reboot case, and is back the moment that session is reopened.

## 2. Firewall (IPv4 + IPv6)

**Review both files before applying anything.** `infra/os/firewall/rules.v4.template` and
`rules.v6.template` are a generic baseline — established/related traffic, loopback,
ICMP(v6), then 22/80/443 as the only new inbound ports, reject everything else on INPUT and
FORWARD. If this host serves anything besides ssh/http/https, add those ports before you
load either file, not after.

**Never `iptables-restore`/`ip6tables-restore` blind over SSH.** Use `iptables-apply` (ships
in the base `iptables` package) instead — it prompts you to confirm the new rules still let
you in, and auto-reverts to the previous ruleset if you don't confirm inside its timeout
(`-t seconds`, default 10) if the new rules cut your own connection:

```bash
sudo iptables-apply infra/os/firewall/rules.v4.template
sudo ip6tables-apply infra/os/firewall/rules.v6.template
```

**Cloud firewalls are a separate layer.** Opening 80/443 here does nothing if your
provider's network firewall — AWS security group, GCP firewall rule, Oracle Cloud security
list, DigitalOcean cloud firewall, Azure NSG, whatever your provider calls it — still blocks
them at the edge. Open the same ports there too, or every connection dies before it reaches
these rules at all.

**Persist across reboots with `iptables-persistent`** (it pulls in `netfilter-persistent`,
the framework that actually loads `/etc/iptables/rules.v4`/`rules.v6` at boot — installing
`netfilter-persistent` alone does *not* get you iptables save/restore, it needs this plugin):

```bash
sudo apt-get install -y iptables-persistent   # first install prompts to save the current
                                               # rules — say yes only AFTER iptables-apply
                                               # above already confirmed they're good
sudo install -o root -g root -m 0644 infra/os/firewall/rules.v4.template /etc/iptables/rules.v4
sudo install -o root -g root -m 0644 infra/os/firewall/rules.v6.template /etc/iptables/rules.v6
sudo systemctl restart netfilter-persistent
```

This also registers `iptables.service`/`ip6tables.service` — on Debian/Ubuntu those are just
symlink aliases to `netfilter-persistent.service` (confirmed on the reference box: both
resolved straight to `/usr/lib/systemd/system/netfilter-persistent.service`, byte-identical,
no local customization), which is why this repo ships no unit files for them: there's
nothing self-built to harvest, `apt` already gives you the real thing.

**Running Docker on this host?** Docker inserts its own NAT rules (the `DOCKER-USER` chain)
*ahead of* the INPUT chain above, so a `-p <port>:<port>` published container port bypasses
rules.v4.template entirely — same blind spot `ufw` has, and for the same reason. If you have
a published port that must NOT be reachable from the internet (a database port, an admin
UI, anything not meant to be public), install
`infra/os/firewall/docker-user-fence.service.template`:

```bash
ip route show default   # find your WAN-facing interface name (the `dev <name>` field)
```

Edit the copy's `Environment=IFACE=eth0` line to match, and its `--dport 1433` to the port
you're fencing (1433/MSSQL is this file's original worked example, not a default worth
keeping) — then:

```bash
sudo install -m 0644 infra/os/firewall/docker-user-fence.service.template \
  /etc/systemd/system/docker-user-fence.service
# (edit /etc/systemd/system/docker-user-fence.service now, per above, before enabling it)
sudo systemctl daemon-reload
sudo systemctl enable --now docker-user-fence.service
```

## 3. fail2ban

```bash
sudo apt-get install -y fail2ban
sudo systemctl enable --now fail2ban
```

Debian/Ubuntu's package ships an sshd jail enabled by default — confirm with
`sudo fail2ban-client status sshd` after install.

## 4. Unattended security upgrades

```bash
sudo apt-get install -y unattended-upgrades
sudo dpkg-reconfigure --priority=low unattended-upgrades   # confirm "Yes" to the prompt
```

This alone does not reboot the host for a kernel update — pair it with
`apt-get install -y update-notifier-common` and check `/var/run/reboot-required`
periodically (or accept manual reboots), it's outside this harness's scope to automate that.

## 5. sshd: disable password auth

Only after you've confirmed key-based SSH login works for `<your-user>` (test it in a
*second* terminal before you touch this — do not close your only working session first):

```bash
sudo sed -i 's/^#\?PasswordAuthentication.*/PasswordAuthentication no/' /etc/ssh/sshd_config
sudo systemctl reload ssh
```

## 6. sudoers

`infra/os/sudoers.d/claude-harness.template` grants `<your-user>` exactly the sudo surface
`fleet/bin/claude-rc` and `watchdogs/bin/claude-health` need — `systemctl
start|stop|restart|enable|disable` on the `claude-remote@*`/`claude-remote-control@*` unit
families, `systemctl start|stop claude-qa-watch`, and `systemctl reload caddy`. Nothing
wider (see the template's own header comment for why there's no `systemd-run` line, and the
exact-match caveat on the last two lines).

```bash
sed "s/{{ADMIN_USER}}/<your-user>/g" infra/os/sudoers.d/claude-harness.template > /tmp/claude-harness
visudo -cf /tmp/claude-harness              # MUST print "parsed OK" before you install it
sudo install -o root -g root -m 0440 /tmp/claude-harness /etc/sudoers.d/claude-harness
rm -f /tmp/claude-harness
```

`install -m 0440` (not 0644): sudoers.d files must not be group/world-writable, and
`visudo`/`sudo` themselves will refuse to honor an incorrectly-permissioned file.

## 7. Linger (required for claude-rc's non-sudo paths)

`claude-rc`'s `open`/`switch` machinery spawns `systemd-run --user` transient units instead
of using sudo (see the sudoers template's header comment). Those units die the moment
`<your-user>`'s last login session ends, unless lingering is enabled — one-time, run once:

```bash
sudo loginctl enable-linger <your-user>
```

Without this, expect `claude-rc: no systemd --user session` errors on `open`/`switch` right
after the SSH session that ran them closes.

## Order recap

tmux -> firewall (+ `iptables-apply`, + cloud firewall, + `iptables-persistent`, +
docker-user-fence if applicable) -> fail2ban -> unattended-upgrades -> sshd
`PasswordAuthentication no` -> sudoers (`visudo -cf` + `install -m 0440`) -> `loginctl
enable-linger`. `watchdogs/SETUP.md` and `infra/systemd`'s own install steps depend on the
sudoers rule and the linger step both being done already.
