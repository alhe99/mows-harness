// claudebox.mjs — reads Claude Code's own input area off the screen, so the composer (composer.mjs) can take its place. Pure: rows in, facts out;
// scripts/term-proto-check.mjs runs it on captured screens. Claude draws, bottom up: the tmux status line, background tasks, its mode line
// (`⏵⏵ auto mode on (shift+tab to cycle)`), a status line, then the box: a rule, `❯ ` + what is typed, a rule (older builds: ╭─╮ │ > │ ╰─╯).
// ponytail: a screen heuristic over Claude's TUI. A Claude Code release that redraws the box makes `box` null: the composer then hides nothing and
// the terminal shows as it is (two inputs, never a lost one). Upgrade path: the rules below, re-captured from a live pane.
const RULE = /^\s*(?:─{8,}|╭─{6,}╮|╰─{6,}╯)\s*$/;
const PROMPT = /^\s*(?:│\s?)?[❯>]/;
const MODE = /(⏵⏵|⏸)\s*([a-z][a-z ]*?)\s+on\b/;
const CLS = { 'accept edits': 'ed', 'plan mode': 'pl', 'bypass permissions': 'bad', 'auto mode': 'ok' };

/** @param {string[]} rows the screen, top to bottom, right-trimmed */
export function claudeScreen(rows) {
  const n = rows.length;
  let box = null, choice = 0;
  // the bottom rule sits in the last 16 rows; above it 1..10 rows of prompt, then the top rule
  for (let b = n - 1; b >= Math.max(1, n - 16) && !box; b--) {
    if (!RULE.test(rows[b])) continue;
    for (let t = b - 1; t >= Math.max(0, b - 11); t--) {
      if (!RULE.test(rows[t])) continue;
      if (t + 1 < b && PROMPT.test(rows[t + 1])) {
        const typed = rows.slice(t + 1, b).join('\n').replace(PROMPT, '').replace(/[│\s ]+/g, '');
        box = { top: t, bottom: b, empty: !typed };
      }
      break;
    }
  }
  let mode = null;
  if (box) {
    for (const r of rows.slice(box.bottom + 1)) {
      const m = MODE.exec(r);
      if (m) { mode = { label: `${m[1]} ${m[2]}`, cls: CLS[m[2]] || 'df' }; break; }
    }
    mode ??= { label: 'default mode', cls: 'df' };
  } else if (rows.some(r => /Do you want to /.test(r))) {
    // a permission dialog replaces the box: its options are numbered, a digit picks one
    for (const r of rows) { const m = /^\s*(?:│\s*)?(?:[❯>]\s*)?(\d)\.\s/.exec(r); if (m) choice = Math.max(choice, +m[1]); }
  }
  return { box, mode, choice };
}
