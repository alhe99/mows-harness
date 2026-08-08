# mows-harness — fleet CLI demo (scripted, regeneratable)
Output "shots/fleet.gif"

Set Shell bash
Set FontSize 20
Set Width 1200
Set Height 620
Set Padding 22
Set Framerate 30
Set Theme "Catppuccin Mocha"
Set WindowBar Colorful
Set BorderRadius 10

Hide
Type "export PS1='$ ' HOME=/demo PATH=/demo/.local/bin:$PATH; clear" Enter
Sleep 500ms
Show

Type "# one Claude Code identity per profile, on one box" Sleep 400ms Enter
Sleep 900ms

Type "claude-rc status" Sleep 300ms Enter
Sleep 2500ms

Type "clear" Enter Sleep 300ms

Type "# switch the whole fleet to one profile (dry run)" Sleep 400ms Enter
Sleep 700ms
Type "DRY_RUN=1 claude-rc only review" Sleep 300ms Enter
Sleep 3000ms

Type "clear" Enter Sleep 300ms

Type "# launch a session — tmux-backed, survives a dropped SSH" Sleep 400ms Enter
Sleep 700ms
Type "cc --help" Sleep 300ms Enter
Sleep 3500ms
