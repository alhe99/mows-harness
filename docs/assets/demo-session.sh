#!/usr/bin/env bash
# demo-session.sh — the fake Claude Code session that stage-demo.sh puts behind its
# throwaway ttyd, so /term screenshots show a plausible session and never a real one.
# Everything below is invented: the repo, the bug, the file paths, the test output.
# Deliberately ANSI-colored across the whole 16-color palette so a theme change is
# visible in the shot. Laid out for ~92 columns.
W=90                                   # inner width of the header box
c()  { printf '\033[%sm%s\033[0m' "$1" "$2"; }
box(){ # box <plain-text-length> — pad the current row out to the box's right edge
  printf '%*s' $((W - 1 - $1)) ''; c '90' '│'; printf '\n'; }
rule(){ local i s=; for ((i=0;i<W;i++)); do s+='─'; done; c '90' "$1$s$2"; printf '\n'; }
# the dashboard's grid view attaches by name (ttyd --url-arg: attach <session> <tabid>), two or three panes side by side, so
# those two get a narrower session of their own (~68 columns): the working refund fix and the payouts migration waiting on you
hold(){ printf '\033[?25l'; while :; do sleep 3600; done; }
foot(){ W=66; rule '─' '─'; c '32' '>'; printf ' '; c '7' ' '; printf '\n\n'
  c '90' '  ? for shortcuts'; printf '  '; c '90' '·'; printf '  '; c '34' 'opus-5'; printf '  '; c '90' '·'; printf '  '; c '32' '◉'; c '90' ' auto-accept edits'; printf '\n'; }
case "${2-}" in
  cc-demo-ledger-api) clear; printf '\n'
    c '32' '>'; printf ' the settlement job double-counts refunds when a batch\n  retries — find out why\n\n'
    c '35' '⏺'; printf ' '; c '1' 'Grep'; c '90' '(pattern: "refund|reconcile", path: "src/settle")'; printf '\n'
    c '90' '  ⎿  '; c '2' '4 files · 17 matches'; printf '\n\n'
    c '35' '⏺'; printf ' '; c '1' 'Read'; c '90' '(src/settle/batch.ts:88-140)'; printf '\n'
    c '90' '  ⎿  '; c '2' '53 lines'; printf '\n\n'
    printf '  Found it. '; c '33' 'reconcile()'; printf ' appends to '; c '33' 'ledger.refunds'; printf ' before\n'
    printf '  the batch commits, so a retry replays the same rows — the\n'
    printf '  ledger write sits '; c '4' 'outside'; printf ' the transaction that guards it.\n\n'
    c '35' '⏺'; printf ' '; c '1' 'Edit'; c '90' '(src/settle/batch.ts)'; printf '\n'
    c '90' '  ⎿  '; c '31' '-'; c '2' '   await ledger.append(refunds)'; printf '\n'
    c '90' '     '; c '32' '+'; c '2' '   await tx.run(() => ledger.append(refunds))'; printf '\n\n'
    c '35' '⏺'; printf ' '; c '1' 'Bash'; c '90' '(npm test -- settle)'; printf '\n'
    c '90' '  ⎿  '; c '32' 'PASS'; printf ' '; c '2' 'src/settle/batch.test.ts'; c '90' ' (14 tests)'; printf '\n'
    c '90' '     '; c '32' 'PASS'; printf ' '; c '2' 'src/settle/reconcile.test.ts'; c '90' ' (9 tests)'; printf '\n'
    c '90' '     '; c '36' '23 passed'; c '90' ', 0 failed · 4.1s'; printf '\n\n'
    c '1;33' '✻'; printf ' '; c '33' 'Writing the regression test…'; c '90' ' (esc to interrupt)'; printf '\n\n'
    foot; hold ;;
  cc-work-payouts) clear; printf '\n'
    c '32' '>'; printf ' write the migration for the new payouts table, then\n  dry-run it\n\n'
    c '35' '⏺'; printf ' '; c '1' 'Write'; c '90' '(db/migrations/0042_payouts.sql)'; printf '\n'
    c '90' '  ⎿  '; c '2' 'Wrote 38 lines'; printf '\n\n'
    c '35' '⏺'; printf ' '; c '1' 'Bash'; c '90' '(npm run migrate -- --dry-run)'; printf '\n'
    c '90' '  ⎿  '; c '2' 'CREATE TABLE payouts (12 columns)'; printf '\n'
    c '90' '     '; c '2' 'CREATE INDEX payouts_merchant_status_idx'; printf '\n'
    c '90' '     '; c '32' 'dry run ok'; c '90' ' · 0 rows touched'; printf '\n\n'
    c '35' '⏺'; printf ' Migration drafted. I need a confirmation before running it\n  against the dev database.\n\n'
    W=66; rule '╭' '╮'
    c '90' '│ '; c '1' 'Bash command'; box 12
    c '90' '│ '; c '36' '  npm run migrate -- --env dev'; box 30
    c '90' '│ '; box 0
    c '90' '│ '; printf 'Do you want to proceed?'; box 23
    c '90' '│ '; c '36' '❯ 1. Yes'; box 8
    c '90' '│ '; printf '  2. Yes, and don'"'"'t ask again for npm run migrate'; box 49
    c '90' '│ '; printf '  3. No, and tell Claude what to do differently'; box 47
    rule '╰' '╯'
    hold ;;
esac
clear
printf '\n'
rule '╭' '╮'
c '90' '│ '; c '1;35' '✻'; printf ' '; c '1' 'Claude Code'; c '90' ' v3.1.0'; box 20
c '90' '│ '; c '90' '~/Projects/ledger-api'; printf '  '; c '90' 'on'; printf ' '; c '36' 'feat/refund-race'; box 42
rule '╰' '╯'
printf '\n'
sleep 0.4
c '32' '>'; printf ' the settlement job double-counts refunds when a batch retries — find out why\n\n'
sleep 0.5
c '35' '⏺'; printf ' '; c '1' 'Grep'; c '90' '(pattern: "refund|reconcile", path: "src/settle", output_mode: "files_with_matches")'; printf '\n'
c '90' '  ⎿  '; c '2' '4 files · 17 matches · batch.ts, reconcile.ts, ledger.ts, retry.ts'; printf '\n\n'
sleep 0.3
c '35' '⏺'; printf ' '; c '1' 'Read'; c '90' '(src/settle/batch.ts:88-140)'; printf '\n'
c '90' '  ⎿  '; c '2' '53 lines'; printf '\n\n'
sleep 0.3
printf '  Found it. '; c '33' 'reconcile()'; printf ' appends to '; c '33' 'ledger.refunds'; printf ' before the batch commits, so a retry\n'
printf '  replays the same rows — the ledger write sits '; c '4' 'outside'; printf ' the transaction that guards it.\n'
printf '  Every retried batch therefore books its refunds twice.\n\n'
sleep 0.4
c '35' '⏺'; printf ' '; c '1' 'Edit'; c '90' '(src/settle/batch.ts)'; printf '\n'
c '90' '  ⎿  '; c '31' '-'; c '2' '   await ledger.append(refunds)                    // fire-and-forget'; printf '\n'
c '90' '     '; c '32' '+'; c '2' '   await tx.run(() => ledger.append(refunds))     // inside the batch tx'; printf '\n\n'
sleep 0.3
c '35' '⏺'; printf ' '; c '1' 'Bash'; c '90' '(npm test -- settle)'; printf '\n'
c '90' '  ⎿  '; c '32' 'PASS'; printf ' '; c '2' 'src/settle/batch.test.ts'; c '90' ' (14 tests)'; printf '\n'
c '90' '     '; c '32' 'PASS'; printf ' '; c '2' 'src/settle/reconcile.test.ts'; c '90' ' (9 tests · +1 regression: retried batch books once)'; printf '\n'
c '90' '     '; c '36' '23 passed'; c '90' ', 0 failed · 4.1s'; printf '\n\n'
sleep 0.3
c '35' '⏺'; printf ' Fixed: refund rows now land inside the batch transaction, so a retry can no longer\n'
printf '  replay them. Added a regression test that retries a batch twice and asserts a single\n'
printf '  ledger entry. Ready to commit on '; c '36' 'feat/refund-race'; printf ' — say the word and I will.\n\n'
rule '─' '─'
c '32' '>'; printf ' '; c '7' ' '; printf '\n\n'
c '90' '  ? for shortcuts'; printf '   '; c '90' '·'; printf '  '; c '34' 'opus-5'; printf '  '; c '90' '·'; printf '  '; c '32' '◉'; c '90' ' auto-accept edits'; printf '\n'
printf '\033[?25l'   # hide the real cursor; the reverse-video block above is the prompt
# hold the frame; the shot is taken against this screen
while :; do sleep 3600; done
