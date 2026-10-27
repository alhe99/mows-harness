// claudebox.mjs — reads Claude Code's own input area off the screen, so the composer (composer.mjs) can take its place. Pure: rows in, facts out;
// scripts/term-proto-check.mjs runs it on captured screens. Claude draws, bottom up: the tmux status line, background tasks, its mode line
// (`⏵⏵ auto mode on (shift+tab to cycle)`), a status line, then the box: a rule, `❯ ` + what is typed, a rule (older builds: ╭─╮ │ > │ ╰─╯).
// ponytail: a screen heuristic over Claude's TUI. A Claude Code release that redraws the box makes `box` null: the composer then hides nothing and
// the terminal shows as it is (two inputs, never a lost one). Upgrade path: the rules below, re-captured from a live pane.
const RULE = /^\s*(?:─{8,}|╭─{6,}╮|╰─{6,}╯)\s*$/;
// `!` is the prompt of Claude's shell mode (a `!` typed first: what follows runs in bash; its mode line reads `! for shell mode`, 2026-10-27)
const PROMPT = /^\s*(?:│\s?)?[❯>!]/;
const MODE = /(⏵⏵|⏸)\s*([a-z][a-z ]*?)\s+on\b/, SHELL = /^\s*! for shell mode/;
const CLS = { 'accept edits': 'ed', 'plan mode': 'pl', 'bypass permissions': 'bad', 'auto mode': 'ok' };
// the model, from a status line under the box that names it (a custom one: `🤖 Opus 5.5 (high) | …`); Claude's own UI does not show it
const MODEL = /\b(Opus|Sonnet|Haiku|Fable)(?: (\d+(?:\.\d+)?))?(?:\s*\((low|medium|high|xhigh|max|auto)\))?/;
// a permission dialog: its own furniture (the selected option, the cancel hint) marks it wherever it sits on the bottom rows; its question
// ("Do you want to …") is ordinary prose too, so that one counts only under the box's top rule
const DIALOG = /Esc to\s+cancel|❯[ \t]*\d\.[ \t]/, ASK = /Do you want to /; // on the rows joined: a narrow pane wraps `Esc to` / `cancel`
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
  // Claude on a fresh screen (the folder-trust question at startup) draws from the top: its keys line can sit above the bottom rows
  const fresh = !box && claudePerm(rows);
  if (fresh || DIALOG.test(tail.join('\n')) || under.some(r => ASK.test(r))) {
    const picker = claudePicker(rows) || fresh || claudePerm(rows);
    return { box: null, mode: null, model: null, choice: choices(tail) || (picker?.opts.length ?? 0), picker, edge: -1 };
  }
  // edge: the lowest rule with a prompt row under it, bottom rule or not. Mid-resize tmux shows the pane cut to the new size before Claude
  // redraws, and the cut takes the box's bottom first; the composer uses it only while Claude was just on screen (composer.mjs LINGER)
  let edge = -1;
  for (let r = n - 2; r >= Math.max(1, n - 16) && edge < 0; r--) if (RULE.test(rows[r]) && PROMPT.test(rows[r + 1])) edge = r;
  let mode = null, model = null;
  if (box) {
    for (const r of rows.slice(box.bottom + 1)) { const m = MODEL.exec(r); if (m) { model = { name: m[2] ? `${m[1]} ${m[2]}` : m[1], effort: m[3] || '' }; break; } }
    for (const r of rows.slice(box.bottom + 1)) {
      if (SHELL.test(r)) { mode = { label: '! shell mode', cls: 'sh' }; break; }
      const m = MODE.exec(r);
      if (m) { mode = { label: `${m[1]} ${m[2]}`, cls: CLS[m[2]] || 'df' }; break; }
    }
    mode ??= { label: 'default mode', cls: 'df' };
  }
  return { box, mode, model, choice: 0, picker: null, edge };
}

// Claude's pickers (/model and the like), as drawn at 46 columns on 2026-10-24: a line (▔), a title, its prose, the numbered options (❯ the
// highlighted one, ✔ the current one, ↑ / ↓ on the first / last when the list's window hides more, `… +3 models` under it), the
// descriptions in a column of their own, wrapped; a `←/→ to adjust` line; the keys (`Enter to set as default · s to use this session only ·
// Esc to cancel`). null for anything else, a permission question included (its words are shown as Claude draws them), for a list with
// Claude's box under it (output, not a picker), and for anything not laid out as Claude draws it: the title right under the line, nothing
// under the keys but tmux's status line (a file printed in a shell must not pass for one; composer.mjs also wants Claude on screen first).
// Claude's questions (AskUserQuestion, 2026-10-26, live captures at 53 columns in scripts/term-proto-check.mjs) are pickers too (ask: true):
// a ─ line, the header (`☐ Prod Doppler`, or the tabs of several questions `←  ☒ Env  ☐ Checks  ✔ Submit  →`), the question (`│ ` before
// each row of a single one), the options with their descriptions on the rows under them, `[ ]` / `[✔]` before each of a multi-select one
// and a `Submit` row under them; the last option takes free text (free: `Type something.`, or what was typed into it) and a ─ line parts it
// from `Chat about this`. Its keys line wraps (`· Esc to` / `cancel`); the review page that ends several questions has none.
const TOP = /^\s*(?:─{8,}|▔{8,})\s*$/; // the picker's own top line is ▔ (2026-10-24); ─ as a fallback
const OPT = /^\s*([❯↑↓])?\s*(\d{1,2})\.\s+(\S.*?)(?:\s{2,}(\S.*))?$/, MORE = /^\s*…\s*\+(\d+)\s+(\S.*)$/, ADJ = /^\s*\S?\s*(.+?)\s*←\/→ to adjust/;
const HEAD = /^\s*(?:←\s+)?[☐☒✔]\s+\S/, BOX = /^\[([ ✔])\]\s+(.*)$/, SUBMIT = /^\s*(❯)?\s*Submit$/;
/** @param {string[]} rows */
export function claudePicker(rows) {
  rows = rows.map(r => r.trimEnd()); // the lengths measure the column: a row as xterm reads it keeps the spaces tmux cleared it with
  let f = rows.findLastIndex((x, i) => /Esc to cancel/.test(x) || /^\s*cancel\b/.test(x) && /Esc to$/.test(rows[i - 1] || ''));
  const end = f < 0 ? rows.findLastIndex((x, i) => i < rows.length - 1 && x.trim()) : -1; // a page with no keys: its last row, if a question's
  if (f < 0) f = end;
  if (f < rows.length - 16 || f < 0) return null;
  const r = rows.findLastIndex((x, i) => i < f && TOP.test(x) && !OPT.test(rows[i + 1] || '')); // not the line over `Chat about this`
  if (r < 0 || !rows[r + 1]?.trim() || rows.slice(f + 1, -1).some(x => x.trim())) return null;
  const ask = HEAD.test(rows[r + 1]);
  if (end >= 0 && !ask) return null;
  // a permission question is never a picker, whatever its rows hold: a command shown in one can carry a ─ line and a `☐ …` row (security
  // review 2026-10-26), so its words are looked for on every row from the line down, a question's own words included (one asking "Do you
  // want to …" gets Claude's drawing)
  for (let i = Math.max(0, r); i < rows.length - 1; i++) if (RULE.test(rows[i]) && PROMPT.test(rows[i + 1]) && !OPT.test(rows[i + 1]) || ASK.test(rows[i])) return null;
  const p = { title: '', text: '', opts: /** @type {any[]} */ ([]), more: '', adjust: '', keys: /** @type {{ key: string, label: string }[]} */ ([]), ask, submit: /** @type {{ on: boolean } | null} */ (null) };
  let edge = 0, foot = '', brk = false;
  for (const row of rows.slice(r + 1, f + 1)) {
    const m = OPT.exec(row), a = ADJ.exec(row), t = row.trim().replace(/^│\s?/, ''), o = p.opts.at(-1), sub = ask && SUBMIT.exec(row);
    if (TOP.test(row)) { if (ask && o) o.free = true; continue; } // the line over `Chat about this`: the option above it takes free text
    if (sub) { p.submit = { on: !!sub[1] }; continue; }
    if (m) {
      const b = ask ? BOX.exec(m[3]) : null, label = b ? b[2] : m[3];
      const n = { n: +m[2], label: label.replace(/\s*✔$/, ''), desc: '', on: m[1] === '❯', cur: b ? b[1] === '✔' : /✔$/.test(m[3]), up: m[1] === '↑', down: m[1] === '↓', box: !!b, col: 0, rows: /** @type {string[]} */ ([]) };
      if (m[4]) { n.col = row.length - m[4].length; n.rows.push(row); } else n.col = row.indexOf(label, row.indexOf(m[2] + '.')); // a description under it starts under the label
      p.opts.push(n);
    } else if (!t) brk = !!p.text;
    else if (MORE.test(row)) p.more = t.replace(/^…\s*/, '');
    else if (a) p.adjust = a[1];
    else if (o && !p.adjust && o.col && row.length - row.trimStart().length >= o.col - 1) o.rows.push(row); // a description's next row
    else if (o) foot += ' ' + t;
    else if (!p.title) p.title = ask ? t.replace(/^←\s*|\s*→$/g, '').replace(/\s+✔ Submit$/, '').replace(/^[☐☒✔]\s*(?!.*\s[☐☒✔]\s)/, '') : t;
    else { p.text = p.text ? p.text + (brk || /^[●→]/.test(t) ? '\n' : ' ') + t : t; brk = false; }
  }
  // a description's rows, joined. Claude wraps at words, and cuts only a word longer than the column (`longest-runni` / `ng tasks`): a row
  // that fills the column and two halves together longer than it were one word
  for (const o of p.opts) for (const row of o.rows) edge = Math.max(edge, row.length);
  for (const o of p.opts) {
    let full = false; // the row before reached the edge
    for (const row of o.rows) { const t = row.slice(o.col).trim(), cut = full && (/\S+$/.exec(o.desc)?.[0] ?? '').length + (/^\S+/.exec(t)?.[0] ?? '').length > edge - o.col; o.desc += (o.desc && !cut ? ' ' : '') + t; full = row.length === edge; }
    delete o.rows; delete o.col;
  }
  for (const s of foot.split(' · ')) { const m = /^\s*(\S+) to (.+?)\s*$/.exec(s); if (m && !m[1].includes('/')) p.keys.push({ key: m[1], label: m[2] }); }
  // a question has its own furniture: `Chat about this` last, under its ─ line (free: the option above that line), or it is the review page
  // (Submit answers / Cancel, no keys line)
  if (ask && !(p.opts.at(-1)?.label === 'Chat about this' && p.opts.at(-2)?.free || end >= 0 && p.opts.map(o => o.label).join() === 'Submit answers,Cancel')) return null;
  return p.opts.length && p.title && (p.keys.length || ask) ? p : null;
}

// Claude's permission dialogs (Bash, Edit, a plan to approve; live captures at 50 columns, 2026-10-27) and its folder-trust question (unnumbered
// options) as a sheet too (the phone, 2026-10-27: they still read as the old terminal UI). Its options are the rows right over the keys line
// (`Esc to cancel · Tab to amend`), numbered from 1, a question (`Do you want to proceed?`) right over them. Everything above the options is
// shown as Claude drew it, every row of the screen from the top: never a part picked out of them, since a command shown in the dialog can draw
// anything, a rule and a title included (security review 2026-10-26), so nothing in it may decide where the dialog starts or what it is called.
const NUM = /^\s{0,3}(❯)?\s*(\d)\.\s+(\S.*)$/, ITEM = /^\s{0,3}(❯)?\s+(\S.*)$/;
/** @param {string[]} rows */
export function claudePerm(rows) {
  rows = rows.map(r => r.trimEnd());
  let f = rows.findLastIndex((x, i) => /Esc to cancel/.test(x) || /^\s*cancel\b/.test(x) && /Esc to$/.test(rows[i - 1] || ''));
  if (f < 0 || rows.slice(f + 1, -1).some(x => x.trim())) return null; // nothing under the keys but tmux's line
  const foot = /^\s*cancel\b/.test(rows[f]) ? rows[f - 1] + ' ' + rows[f].trim() : rows[f];
  if (/^\s*cancel\b/.test(rows[f])) f--;
  let e = f - 1;
  while (e >= 0 && !rows[e].trim()) e--;
  const opts = [];
  // the last `1.` over the keys: what follows it is Claude's (a command shown above can hold a `1.` of its own), each option a number one up
  // from the last, its wrapped rest indented deeper
  let s = -1;
  for (let i = e; i >= Math.max(0, e - 20) && s < 0; i--) if (NUM.exec(rows[i])?.[2] === '1') s = i;
  const numbered = s >= 0;
  if (numbered) {
    for (const r of rows.slice(s, e + 1)) {
      const m = NUM.exec(r);
      if (m && +m[2] === opts.length + 1) opts.push({ n: +m[2], on: !!m[1], text: m[3] });
      else if (!m && opts.length && /^\s{4,}\S/.test(r)) opts.at(-1).text += ' ' + r.trim();
      else return null;
    }
  } else { // unnumbered (the folder-trust question): a short block of rows after a blank one, one of them ❯
    s = e;
    while (s > 0 && rows[s - 1].trim()) s--;
    if (s < 1 || e - s > 8) return null;
    for (const r of rows.slice(s, e + 1)) { const m = ITEM.exec(r); if (!m || NUM.test(r)) return null; opts.push({ n: opts.length + 1, on: !!m[1], text: m[2] }); }
  }
  if (opts.length < 2 || opts.filter(o => o.on).length !== 1) return null;
  const q = s > 0 && /\?$/.test(rows[s - 1].trim()) ? rows[s - 1].trim() : '';
  const body = rows.slice(0, q ? s - 1 : s);
  while (body.length && !body[0].trim()) body.shift();
  while (body.length && !body.at(-1).trim()) body.pop();
  const keys = [];
  for (const k of foot.split(' · ')) { const m = /^\s*(\S+) to (.+?)\s*$/.exec(k); if (m) keys.push({ key: m[1], label: m[2] }); }
  return {
    title: q || 'Claude asks', text: '', body, perm: true, arrows: !numbered, more: '', adjust: '', ask: false, submit: null,
    // `Yes, and switch to auto mode · auto mode handles these prompts for you`: the label, and its note
    opts: opts.map(o => { const [label, ...d] = o.text.split(' · '); return { n: o.n, label, desc: d.join(' · '), on: o.on, cur: false, up: false, down: false, box: false }; }),
    keys: keys.filter(k => k.key === 'Esc'), // Tab (amend) opens a field inside Claude's dialog: it stays Claude's
  };
}
