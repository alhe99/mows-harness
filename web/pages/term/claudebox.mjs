// claudebox.mjs — reads Claude Code's own input area off the screen, so the composer (composer.mjs) can take its place. Pure: rows in, facts out;
// scripts/term-proto-check.mjs runs it on captured screens. Claude draws, bottom up: the tmux status line, background tasks, its mode line
// (`⏵⏵ auto mode on (shift+tab to cycle)`), a status line, then the box: a rule, `❯ ` + what is typed, a rule (older builds: ╭─╮ │ > │ ╰─╯).
// ponytail: a screen heuristic over Claude's TUI. A Claude Code release that redraws the box makes `box` null: the composer then hides nothing and
// the terminal shows as it is (two inputs, never a lost one). Upgrade path: the rules below, re-captured from a live pane.
const RULE = /^\s*(?:─{8,}|╭─{6,}╮|╰─{6,}╯)\s*$/;
const PROMPT = /^\s*(?:│\s?)?[❯>]/;
const MODE = /(⏵⏵|⏸)\s*([a-z][a-z ]*?)\s+on\b/;
const CLS = { 'accept edits': 'ed', 'plan mode': 'pl', 'bypass permissions': 'bad', 'auto mode': 'ok' };
const DIALOG = /Do you want to |Esc to cancel|❯\s*1\.\s/;
const choices = rows => { let c = 0; for (const r of rows) { const m = /^\s*(?:│\s*)?(?:[❯>]\s*)?(\d)\.\s/.exec(r); if (m) c = Math.max(c, +m[1]); } return c; };

/** @param {string[]} rows the screen, top to bottom, right-trimmed
 *  @param {string[]} typed the same rows holding only what was typed: Claude's hints (the dimmed suggestion of the last prompt, the grey ❯, its
 *  inverse cursor) blanked. The composer builds it from the cell attributes; without it every character counts as typed. */
export function claudeScreen(rows, typed = rows) {
  const n = rows.length;
  let box = null;
  // the bottom rule sits in the last 16 rows; above it 1..10 rows of prompt, then the top rule
  for (let b = n - 1; b >= Math.max(1, n - 16) && !box; b--) {
    if (!RULE.test(rows[b])) continue;
    for (let t = b - 1; t >= Math.max(0, b - 11); t--) {
      if (!RULE.test(rows[t])) continue;
      if (t + 1 < b && PROMPT.test(rows[t + 1])) {
        const draft = typed.slice(t + 1, b).join('\n').replace(PROMPT, '').replace(/[│❯>\s ]+/g, '');
        box = { top: t, bottom: b, empty: !draft };
      }
      break;
    }
  }
  // fails closed: a permission dialog under the box's top rule (or in the last 16 rows when there is no box) means no box. Output can draw a
  // fake empty box (a file Claude prints), and a box found above a real dialog would hide the dialog while return answers it (security review
  // 2026-10-23). Above the box is conversation, where the same words are only words.
  const live = rows.slice(box ? box.top : Math.max(0, n - 16));
  if (live.some(r => DIALOG.test(r))) return { box: null, mode: null, choice: choices(live) };
  let mode = null;
  if (box) {
    for (const r of rows.slice(box.bottom + 1)) {
      const m = MODE.exec(r);
      if (m) { mode = { label: `${m[1]} ${m[2]}`, cls: CLS[m[2]] || 'df' }; break; }
    }
    mode ??= { label: 'default mode', cls: 'df' };
  }
  return { box, mode, choice: 0 };
}
