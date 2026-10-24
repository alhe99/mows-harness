// claudebox.mjs — reads Claude Code's own input area off the screen, so the composer (composer.mjs) can take its place. Pure: rows in, facts out;
// scripts/term-proto-check.mjs runs it on captured screens. Claude draws, bottom up: the tmux status line, background tasks, its mode line
// (`⏵⏵ auto mode on (shift+tab to cycle)`), a status line, then the box: a rule, `❯ ` + what is typed, a rule (older builds: ╭─╮ │ > │ ╰─╯).
// ponytail: a screen heuristic over Claude's TUI. A Claude Code release that redraws the box makes `box` null: the composer then hides nothing and
// the terminal shows as it is (two inputs, never a lost one). Upgrade path: the rules below, re-captured from a live pane.
const RULE = /^\s*(?:─{8,}|╭─{6,}╮|╰─{6,}╯)\s*$/;
const PROMPT = /^\s*(?:│\s?)?[❯>]/;
const MODE = /(⏵⏵|⏸)\s*([a-z][a-z ]*?)\s+on\b/;
const CLS = { 'accept edits': 'ed', 'plan mode': 'pl', 'bypass permissions': 'bad', 'auto mode': 'ok' };
// the model, from a status line under the box that names it (a custom one: `🤖 Opus 5.5 (high) | …`); Claude's own UI does not show it
const MODEL = /\b(Opus|Sonnet|Haiku|Fable)(?: (\d+(?:\.\d+)?))?(?:\s*\((low|medium|high|xhigh|max|auto)\))?/;
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
  if (tail.some(r => DIALOG.test(r)) || under.some(r => ASK.test(r))) return { box: null, mode: null, model: null, choice: choices(tail), picker: claudePicker(rows), edge: -1 };
  // edge: the lowest rule with a prompt row under it, bottom rule or not. Mid-resize tmux shows the pane cut to the new size before Claude
  // redraws, and the cut takes the box's bottom first; the composer uses it only while Claude was just on screen (composer.mjs LINGER)
  let edge = -1;
  for (let r = n - 2; r >= Math.max(1, n - 16) && edge < 0; r--) if (RULE.test(rows[r]) && PROMPT.test(rows[r + 1])) edge = r;
  let mode = null, model = null;
  if (box) {
    for (const r of rows.slice(box.bottom + 1)) { const m = MODEL.exec(r); if (m) { model = { name: m[2] ? `${m[1]} ${m[2]}` : m[1], effort: m[3] || '' }; break; } }
    for (const r of rows.slice(box.bottom + 1)) {
      const m = MODE.exec(r);
      if (m) { mode = { label: `${m[1]} ${m[2]}`, cls: CLS[m[2]] || 'df' }; break; }
    }
    mode ??= { label: 'default mode', cls: 'df' };
  }
  return { box, mode, model, choice: 0, picker: null, edge };
}

// Claude's pickers (/model and the like), as drawn at 46 columns on 2026-10-24: a rule, a title, its prose, the numbered options (❯ the
// highlighted one, ✔ the current one, ↑ / ↓ on the first / last when the list's window hides more, `… +3 models` under it), the
// descriptions in a column of their own, wrapped; a `←/→ to adjust` line; the keys (`Enter to set as default · s to use this session only ·
// Esc to cancel`). null for anything else, a permission question included (its words are shown as Claude draws them), and for a list with
// Claude's box under it: that one is output, not a picker.
const OPT = /^\s*([❯↑↓])?\s*(\d{1,2})\.\s+(\S.*?)(?:\s{2,}(\S.*))?$/, MORE = /^\s*…\s*\+(\d+)\s+(\S.*)$/, ADJ = /^\s*\S?\s*(.+?)\s*←\/→ to adjust/;
/** @param {string[]} rows */
export function claudePicker(rows) {
  const f = rows.map(r => /Esc to cancel/.test(r)).lastIndexOf(true);
  if (f < rows.length - 16 || f < 0) return null;
  const r = rows.map((x, i) => i < f && RULE.test(x)).lastIndexOf(true);
  for (let i = Math.max(0, r); i < rows.length - 1; i++) if (RULE.test(rows[i]) && PROMPT.test(rows[i + 1]) || ASK.test(rows[i])) return null;
  const p = { title: '', text: '', opts: /** @type {any[]} */ ([]), more: '', adjust: '', keys: /** @type {{ key: string, label: string }[]} */ ([]) };
  let col = 0, edge = 0, foot = '', head = 0; // head: 0 the title next, 1 its prose, 2 past it (a blank row ends it)
  for (const row of rows.slice(r + 1, f + 1)) {
    const m = OPT.exec(row), a = ADJ.exec(row), t = row.trim();
    if (m) {
      const o = { n: +m[2], label: m[3].replace(/\s*✔$/, ''), desc: '', on: m[1] === '❯', cur: /✔$/.test(m[3]), up: m[1] === '↑', down: m[1] === '↓', rows: /** @type {string[]} */ ([]) };
      if (m[4]) { col = row.length - m[4].length; o.rows.push(row); }
      p.opts.push(o);
    } else if (!t) { if (head === 1 && p.text) head = 2; }
    else if (MORE.test(row)) p.more = t.replace(/^…\s*/, '');
    else if (a) p.adjust = a[1];
    else if (p.opts.length && !p.adjust && col && row.length - t.length >= col - 1) p.opts.at(-1).rows.push(row); // a description's next row
    else if (p.opts.length) foot += ' ' + t;
    else if (head === 0) { p.title = t; head = 1; }
    else if (head === 1) p.text = (p.text + ' ' + t).trim();
  }
  // a description's rows, joined. Claude wraps at words, and cuts only a word longer than the column (`longest-runni` / `ng tasks`): a row
  // that fills the column and two halves together longer than it were one word
  for (const o of p.opts) for (const row of o.rows) edge = Math.max(edge, row.length);
  for (const o of p.opts) {
    let full = false; // the row before reached the edge
    for (const row of o.rows) { const t = row.slice(col).trim(), cut = full && (/\S+$/.exec(o.desc)?.[0] ?? '').length + (/^\S+/.exec(t)?.[0] ?? '').length > edge - col; o.desc += (o.desc && !cut ? ' ' : '') + t; full = row.length === edge; }
    delete o.rows;
  }
  for (const s of foot.split(' · ')) { const m = /^\s*(\S+) to (.+?)\s*$/.exec(s); if (m && !m[1].includes('/')) p.keys.push({ key: m[1], label: m[2] }); }
  return p.opts.length && p.title && p.keys.length ? p : null;
}
