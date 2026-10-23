// claudebox.mjs — reads Claude Code's own input area off the screen, so the composer (composer.mjs) can take its place. Pure: rows in, facts out;
// scripts/term-proto-check.mjs runs it on captured screens. Claude draws, bottom up: the tmux status line, background tasks, its mode line
// (`⏵⏵ auto mode on (shift+tab to cycle)`), a status line, then the box: a rule, `❯ ` + what is typed, a rule (older builds: ╭─╮ │ > │ ╰─╯).
// ponytail: a screen heuristic over Claude's TUI. A Claude Code release that redraws the box makes `box` null: the composer then hides nothing and
// the terminal shows as it is (two inputs, never a lost one). Upgrade path: the rules below, re-captured from a live pane.
const RULE = /^\s*(?:─{8,}|╭─{6,}╮|╰─{6,}╯)\s*$/;
const PROMPT = /^\s*(?:│\s?)?[❯>]/;
const MODE = /(⏵⏵|⏸)\s*([a-z][a-z ]*?)\s+on\b/;
const CLS = { 'accept edits': 'ed', 'plan mode': 'pl', 'bypass permissions': 'bad', 'auto mode': 'ok' };
// a permission dialog: its own furniture (the selected option, the cancel hint) marks it wherever it sits on the bottom rows; its question
// ("Do you want to …") is ordinary prose too, so that one counts only under the box's top rule
const DIALOG = /Esc to cancel|❯\s*\d\.\s/, ASK = /Do you want to /;
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
        // what is typed, as one line for the composer's draft chip: the prompt glyph, the box's sides and the runs of blanks folded away
        const draft = typed.slice(t + 1, b).join(' ').replace(PROMPT, '').replace(/[│❯]/g, ' ').replace(/[\s\u00a0]+/g, ' ').trim();
        box = { top: t, bottom: b, empty: !draft, draft };
      }
      break;
    }
  }
  // fails closed: a dialog on the bottom rows means no box, wherever a box was found. Output can draw a fake empty box (a file Claude prints),
  // and a box found above or below a real dialog would hide it while return answers it (security reviews 2026-10-23). Only the question's
  // words are read from the box down: above it is conversation, where they are only words.
  const tail = rows.slice(Math.max(0, n - 16)), under = box ? rows.slice(box.top) : tail;
  if (tail.some(r => DIALOG.test(r)) || under.some(r => ASK.test(r))) return { box: null, mode: null, choice: choices(tail), edge: -1 };
  // edge: the lowest rule with a prompt row under it, bottom rule or not. Mid-resize tmux shows the pane cut to the new size before Claude
  // redraws, and the cut takes the box's bottom first; the composer uses it only while Claude was just on screen (composer.mjs LINGER)
  let edge = -1;
  for (let r = n - 2; r >= Math.max(1, n - 16) && edge < 0; r--) if (RULE.test(rows[r]) && PROMPT.test(rows[r + 1])) edge = r;
  let mode = null;
  if (box) {
    for (const r of rows.slice(box.bottom + 1)) {
      const m = MODE.exec(r);
      if (m) { mode = { label: `${m[1]} ${m[2]}`, cls: CLS[m[2]] || 'df' }; break; }
    }
    mode ??= { label: 'default mode', cls: 'df' };
  }
  return { box, mode, choice: 0, edge };
}
