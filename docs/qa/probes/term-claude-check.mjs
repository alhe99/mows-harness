// term-claude-check.mjs — the phone terminal against a fake Claude Code that behaves like the real one, at three iPhone sizes. Exit code is the verdict.
// usage: node docs/qa/probes/term-claude-check.mjs [webkit|chromium] [shots-dir]      (PLAYWRIGHT: module path; default: the repo's playwright)
// No server: dist/term.html and its /assets/ come from disk (run `node build.mjs` first), every route is answered here.
// Why it exists (2026-10-23): the composer passed term-check on hand-drawn screens and then flashed on a phone, because a real session redraws.
// Showing the field resizes the terminal; tmux first cuts the pane (shrinking deletes the lines under the cursor, which sits on Claude's prompt
// row, so the box's bottom goes first; growing pulls history in at the top), then Claude redraws for the new size. The fake does exactly that,
// turns a pasted image path into [Image #N] (as Claude does), recalls with ↑, cycles modes with shift+tab, raises a permission dialog, exits to
// a shell. A sampler in the page reads every painted frame (rAF, then a task after the paint): Claude's own input line (a rule with its ❯ row)
// visible while the field shows is two inputs, and every show/hide of the field is counted, so a flash fails the run.
import { readFileSync, existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';

const pw = await import(process.env.PLAYWRIGHT || 'playwright').catch(() => { console.error('term-claude-check: playwright is not installed (npm ci --ignore-scripts)'); process.exit(2); });
const engine = process.argv[2] || 'webkit', OUT = process.argv[3] || '';
if (OUT) mkdirSync(OUT, { recursive: true });
const ROOT = join(import.meta.dirname, '../../..');
const PAGE = readFileSync(join(ROOT, 'dist/term.html'), 'utf8');
const browser = await pw[engine].launch();
let bad = 0;
const check = (id, ok, d) => { if (!ok) bad++; console.log(`${ok ? 'PASS' : 'FAIL'} ${engine}/${id}${ok ? '' : ' ' + JSON.stringify(d)}`); };
const sleep = ms => new Promise(r => setTimeout(r, ms));
const MODES = ['⏵⏵ auto mode on', '⏵⏵ accept edits on', '⏸ plan mode on', ''];
// a real image to attach (a 48 px square, the shell's green): the preview must be able to show it
import { deflateSync } from 'node:zlib';
const PNG = (() => {
  const crc = b => { let c, k = -1; for (const x of b) { c = (k ^ x) & 255; for (let i = 0; i < 8; i++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; k = (k >>> 8) ^ c; } return (k ^ -1) >>> 0; };
  const chunk = (t, d) => { const len = Buffer.alloc(4), tc = Buffer.concat([Buffer.from(t), d]), cr = Buffer.alloc(4); len.writeUInt32BE(d.length); cr.writeUInt32BE(crc(tc)); return Buffer.concat([len, tc, cr]); };
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(48, 0); ihdr.writeUInt32BE(48, 4); ihdr[8] = 8; ihdr[9] = 2;
  const raw = Buffer.concat(Array.from({ length: 48 }, () => Buffer.concat([Buffer.from([0]), Buffer.from(Array.from({ length: 48 }, () => [0, 212, 146]).flat())])));
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr), chunk('IDAT', deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
})();
const TMUX = '\x1b[42;30m[ccw-dev] 0:claude* "Mobile notification" 22:23\x1b[0m';
// Claude's /model picker, as Claude draws it (2026-10-24): a window of 4 over the list, ❯ the highlight, ✔ the current, ←/→ the effort
const PICK = [['Opus 5.5', 'Most capable'], ['Fable 5.1', 'Hardest work'], ['Sonnet 5.5', 'Fast'], ['Haiku 5.5', 'Fastest'], ['Opus 4.8', 'Everyday'], ['Sonnet 4.6', 'Routine']];
const EFF = ['low', 'medium', 'high', 'xhigh'], WIN = 4;
// Claude's questions (AskUserQuestion), as Claude draws them (live captures, 2026-10-26): one with a free option, and a multi-select one
const ASK1 = { head: 'Prod Doppler', q: 'Every missing Doppler value is in prod. Writing them makes new prod secrets and can restart running prod pods. How far should I go?',
  opts: [['Prepare, you run it (Recommended)', 'I write a ready, tested script: generate the credential pair and CA, upload by pipe, hash-check, shred. You run it for prod when ready.'],
    ['Credentials only, now', 'I generate the proxy username/password and write it to the three prod consumer configs. No CA.'], ['Everything, now', 'Credentials plus a prod CA generated on this VM, key uploaded straight to Doppler and shredded.']] };
const ASKM = { q: 'Which checks should run?', opts: [['Lint', 'Run the linter over the changed code'], ['Tests', 'Run the unit and integration test suites']] };
const words = (t, w) => { const out = []; let l = ''; for (const x of t.split(' ')) { if (l && (l + ' ' + x).length > w) { out.push(l); l = x; } else l = l ? l + ' ' + x : x; } if (l) out.push(l); return out; };
const agReq = []; // the agent-detail requests the sheet made
let FRONT = false; // workflows.json's word: Claude is in front in the pane

class FakeClaude {
  constructor(ws) { Object.assign(this, { ws, rows: 0, cols: 0, log: [...Array.from({ length: 40 }, (_, i) => i % 3 === 2 ? '' : `\x1b[2m  ${i}\x1b[0m \x1b[32m+ an earlier line of the conversation, long enough to wrap on a phone screen #${i}\x1b[0m`), '\x1b[38;5;246m✻ Welcome back\x1b[0m', ''] /* a full screen of history, as on a session that has run a while */, draft: '', last: 'it\'s all merged?', model: 'Opus 5.5 (high)', imgs: 0, mode: 0, scene: 'idle', screen: [], bp: false }); }
  feed(m) {
    const s = typeof m === 'string' ? m : Buffer.from(m).toString('utf8');
    // the attach: tmux's window still has the size of the last client (a desktop, 60 rows); it cuts the pane to this one, Claude redraws after
    if (s[0] === '{') { const j = JSON.parse(s); this.rows = 60; this.cols = j.columns; this.screen = [...this.frame()]; this.resize(j.rows, j.columns); this.sizes = []; return; }
    if (s[0] === '1') { const j = JSON.parse(s.slice(1)); this.resize(j.rows, j.columns); return; }
    if (s[0] !== '0') return;
    let d = s.slice(1);
    (this.inputs ||= []).push(d); // every byte the page sent, for the writing checks
    // tmux's prefix (^Q), then a command line: the ⋯ sheet's restart is `respawn-pane -k`. The pane goes blank, Claude comes back bootMs later
    if (d === '\x11') { this.tcmd = ''; return; }
    if (this.tcmd !== undefined && this.tcmd !== null) { if (d !== '\r') { this.tcmd += d; return; } const c = this.tcmd; this.tcmd = null; if (/^:respawn-pane -k$/.test(c)) this.respawn(); return; }
    if (this.scene === 'shell') { for (const c of d) { if (c === '\r') { this.log.push('dev@box:~$ ' + this.draft); this.draft = ''; } else if (c >= ' ') this.draft += c; } this.redraw(); return; }
    while (d) {
      let m;
      if (/^ask/.test(this.scene) && (m = /^\x1b\[([AB])/.exec(d))) { d = d.slice(3); this.ahl = Math.min(5, Math.max(1, this.ahl + (m[1] === 'B' ? 1 : -1))); continue; }
      if (this.scene === 'model' && (m = /^\x1b\[([ABCD])/.exec(d))) {
        const k = m[1]; d = d.slice(3);
        if (k === 'A' || k === 'B') this.hl = Math.min(PICK.length, Math.max(1, this.hl + (k === 'B' ? 1 : -1))); else this.eff = (this.eff + (k === 'C' ? 1 : EFF.length - 1)) % EFF.length;
        continue;
      }
      if ((m = /^\x1b\[200~([\s\S]*?)\x1b\[201~/.exec(d))) { const p = m[1]; this.draft += /\.(png|jpe?g|gif|webp)\s*$/i.test(p) ? `[Image #${++this.imgs}] ` : p.replace(/\r/g, '\n'); d = d.slice(m[0].length); continue; }
      if (d.startsWith('\x1b[Z')) { this.mode = (this.mode + 1) % MODES.length; d = d.slice(3); continue; }
      if (d.startsWith('\x1b[A') || d.startsWith('\x1bOA')) { this.draft = this.last; d = d.slice(3); continue; }
      if (d.startsWith('\x1b')) { // esc: cancels a dialog, clears the input
        if (this.scene === 'model') this.scene = 'idle';
        else if (/^ask/.test(this.scene)) { this.scene = 'idle'; this.log.push('\x1b[2m  ⎿  question cancelled\x1b[0m', ''); }
        else if (this.scene === 'working') this.interrupt();
        else if (this.scene === 'dialog') { this.scene = 'idle'; this.log.push('\x1b[2m  ⎿  cancelled\x1b[0m', ''); } else this.draft = '';
        d = d.slice(d.length > 1 && d[1] === '[' ? 3 : 1); continue;
      }
      let c = d[0]; d = d.slice(1);
      // Claude's /model picker: a number or Enter sets the default, s this session only; the status line follows
      if (this.scene === 'model') {
        if (/[1-9]/.test(c) && +c <= PICK.length) this.hl = +c;
        if (c === '\r' || c === 's' || /[1-9]/.test(c)) { this.model = `${PICK[this.hl - 1][0]} (${EFF[this.eff]})`; this.how = c === 's' ? 'session' : 'default'; this.log.push(`\x1b[2m  ⎿  Set model to ${PICK[this.hl - 1][0]}${c === 's' ? ' for this session' : ''}\x1b[0m`, ''); this.scene = 'idle'; }
        continue;
      }
      if (c === '\r' && this.draft.trim() === '/model') { this.draft = ''; this.scene = 'model'; this.hl = PICK.findIndex(p => this.model.startsWith(p[0] + ' ')) + 1 || 1; this.win = 0; this.eff = Math.max(0, EFF.indexOf(/\((\w+)\)/.exec(this.model)?.[1])); continue; }
      // a question: a digit answers (on the multi-select one it ticks); on the free option (4; multi 3) what is typed is its text; Enter answers
      // the highlighted row (multi: ticks it, or on Submit sends the ticked ones)
      if (this.scene === 'ask') {
        if (this.ahl === 4 && c >= ' ') { this.atext += c; continue; }
        if (this.ahl === 4 && c === '\x7f') { this.atext = this.atext.slice(0, -1); continue; }
        if (/[1-5]/.test(c)) { if (c === '4') this.ahl = 4; else this.answer(c === '5' ? 'chat' : c); continue; }
        if (c === '\r') { if (this.ahl !== 4) this.answer(this.ahl === 5 ? 'chat' : String(this.ahl)); else if (this.atext) this.answer(': ' + this.atext); }
        continue;
      }
      if (this.scene === 'askm') {
        if (this.ahl === 3 && c >= ' ') { this.atext += c; this.ticks[2] = true; continue; }
        if (this.ahl === 3 && c === '\x7f') { this.atext = this.atext.slice(0, -1); continue; }
        if (/[1-3]/.test(c)) { this.ticks[+c - 1] = !this.ticks[+c - 1]; continue; }
        if (c === '4') { this.answer('chat'); continue; }
        if (c === '\r') { if (this.ahl === 4) this.answer('submitted: ' + ['Lint', 'Tests', this.atext || 'Type something'].filter((_, i) => this.ticks[i]).join(',')); else if (this.ahl === 5) this.answer('chat'); else this.ticks[this.ahl - 1] = !this.ticks[this.ahl - 1]; }
        continue;
      }
      if (this.scene === 'dialog') { if (c === '\r') c = '1'; /* Enter answers the highlighted option, the first */ if (/[1-3]/.test(c)) { this.log.push(`\x1b[2m  ⎿  answered ${c}\x1b[0m`, ''); this.scene = 'idle'; } continue; }
      if (c === '\r') { if (this.draft.trim()) this.submit(); continue; }
      if (c === '\x7f') { this.draft = this.draft.slice(0, -1); continue; }
      if (c === '\x03') { if (this.draft) this.draft = ''; else this.exitWarn = true; continue; } // Claude: ctrl+c clears a non-empty input; on an empty one it warns
      if (c >= ' ') this.draft += c;
    }
    if (!this.sh && this.draft[0] === '!') { this.sh = true; this.draft = this.draft.slice(1); } // a `!` first: shell mode, as Claude does
    this.redraw();
  }
  respawn() {
    clearTimeout(this.job); Object.assign(this, { log: [], scene: 'boot', draft: '', sh: false }); this.redraw();
    setTimeout(() => { this.log.push('\x1b[38;5;174m✻\x1b[0m Welcome back', ''); this.scene = 'idle'; this.redraw(); }, this.bootMs || 1500);
  }
  ask(scene) { Object.assign(this, { scene, ahl: 1, atext: '', ticks: [false, false, false] }); this.redraw(); }
  answer(x) { this.log.push(`\x1b[2m  ⎿  answered ${x}\x1b[0m`, ''); this.scene = 'idle'; }
  submit() {
    const p = this.draft.trim(); this.last = p; this.draft = '';
    if (this.sh) { this.sh = false; this.ran = p; this.log.push(`\x1b[38;5;211m!\x1b[0m ${p}`, `  ⎿  ran ${p}`, ''); this.redraw(); return; }
    this.log.push(`\x1b[48;5;237m\x1b[38;5;246m❯ \x1b[38;5;231m${p}\x1b[0m`, '');
    this.scene = 'working'; this.redraw();
    this.job = setTimeout(() => { this.log.push('\x1b[32m●\x1b[0m Done: ' + p.slice(0, 60), ''); this.scene = 'idle'; this.redraw(); }, this.work || 400);
  }
  // esc while it works, as Claude Code does: before it answered, the prompt goes back into the box and out of the conversation; once it
  // has begun, the box stays empty and the turn ends "Interrupted"
  interrupt() {
    clearTimeout(this.job); this.scene = 'idle';
    if (this.early) { this.log.splice(-2, 2); this.draft = this.last; return; }
    this.log.push('\x1b[32m●\x1b[0m That looks like a p', '  \x1b[2m⎿  Interrupted · What should Claude do instead?\x1b[0m', '');
  }
  frame() {
    const R = '\x1b[38;5;244m' + '─'.repeat(this.cols) + '\x1b[0m';
    const wrap = l => { const plain = l.replace(/\x1b\[[0-9;]*m/g, ''); if (plain.length <= this.cols) return [l]; const out = []; for (let i = 0; i < plain.length; i += this.cols) out.push(plain.slice(i, i + this.cols)); return out; };
    let tail;
    if (this.scene === 'boot') tail = [TMUX]; // respawned: a blank pane until Claude prints
    else if (this.scene === 'shell') tail = ['dev@box:~$ ' + this.draft, TMUX];
    else if (this.scene === 'model') {
      this.win = Math.min(Math.max(this.win, this.hl - WIN), this.hl - 1);
      const w = this.win, rows = PICK.slice(w, w + WIN).map(([name, what], j) => {
        const n = w + j + 1, g = n === this.hl ? '❯' : j === 0 && w > 0 ? '↑' : j === WIN - 1 && w + WIN < PICK.length ? '↓' : ' ';
        const l = `   ${g} ${n}.  ${(name + (this.model.startsWith(name + ' ') ? ' ✔' : '')).padEnd(13)}  ${what}`;
        return n === this.hl ? `\x1b[38;5;153m${l}\x1b[0m` : l;
      });
      // prose: rows of it, so the picker can be taller than the screen; then, as Claude does, its top shows and its keys are cut off
      tail = ['\x1b[38;5;153m' + '▔'.repeat(this.cols) + '\x1b[0m', '   \x1b[1mSelect model\x1b[0m', '   Switch between Claude models.', ...Array(this.prose || 0).fill('   Your pick becomes the default.'), '', ...rows,
        ...(w + WIN < PICK.length ? [`      … +${PICK.length - w - WIN} models`] : []), '', `   ● ${EFF[this.eff]} effort \x1b[2m←/→ to adjust\x1b[0m`, '',
        '   Enter to set as default · s to use this', '   session only · Esc to cancel', TMUX];
      if (tail.length > this.rows) tail = [...tail.slice(0, this.rows - 2), '                              tasks        ↓', TMUX];
    }
    else if (/^ask/.test(this.scene)) {
      const R2 = '─'.repeat(this.cols), w = this.cols, g = r => (r === this.ahl ? '\x1b[38;5;153m❯' : ' '), hd = t => `\x1b[48;5;153m\x1b[38;5;16m ${t} \x1b[0m`;
      if (this.scene === 'ask') {
        tail = [R2, ` ${hd('☐ ' + ASK1.head)}`, '', ...words(ASK1.q, w - 2).map(r => '│ ' + r), '',
          ...ASK1.opts.flatMap(([l, d], i) => [`${g(i + 1)} ${i + 1}. ${l}\x1b[0m`, ...words(d, w - 5).map(r => '     ' + r)]),
          `${g(4)} 4. ${this.atext || 'Type something.'}\x1b[0m`, R2, `${g(5)} 5. Chat about this\x1b[0m`, ''];
      } else {
        const t = this.ticks.map(x => (x ? '✔' : ' '));
        tail = [R2, `←  ${hd('☐ Checks')} ✔ Submit  →`, '', ASKM.q, '',
          ...ASKM.opts.flatMap(([l, d], i) => [`${g(i + 1)} ${i + 1}. [${t[i]}] ${l}\x1b[0m`, ...words(d, w - 9).map(r => '         ' + r)]),
          `${g(3)} 3. [${t[2]}] ${this.atext || 'Type something'}\x1b[0m`, `${g(4)}    Submit\x1b[0m`, R2, `${g(5)} 4. Chat about this\x1b[0m`, ''];
      }
      tail.push(...words('Enter to select · ↑/↓ to navigate · Esc to cancel', w), TMUX);
      this.tall = tail.length > this.rows; // its top cut off, as on a small phone
    }
    else if (this.scene === 'dialog') tail = ['\x1b[32m●\x1b[0m Bash(git push origin feat/term-cockpit)', '', ' Do you want to proceed?', ' \x1b[38;5;153m❯ 1. Yes\x1b[0m', '   2. Yes, and don\'t ask again for git push', '   3. No, and tell Claude what to do', '', ' Esc to cancel', TMUX];
    else {
      // the input line: what is typed in the default colour; empty, the last prompt as Claude's dimmed suggestion under its inverse cursor
      // as Claude draws it: wrapped at the box's width, the first row after ❯, the rest indented two
      const w = Math.max(8, this.cols - 2), rowsOf = t => t.split('\n').flatMap(p => { const out = []; for (let i = 0; i < Math.max(1, p.length); i += w) out.push(p.slice(i, i + w)); return out; });
      const input = this.sh ? ['\x1b[38;5;211m!\u00a0\x1b[39m' + this.draft] : this.draft ? rowsOf(this.draft).map((r, i) => (i ? '  ' : '\x1b[38;5;246m❯\u00a0\x1b[39m') + r) : ['\x1b[38;5;246m❯\u00a0\x1b[7m' + this.last[0] + '\x1b[27m\x1b[2m' + this.last.slice(1, w) + '\x1b[0m'];
      tail = [...(this.scene === 'working' ? ['\x1b[38;5;173m✻ Simmering…\x1b[0m \x1b[2m(3s · esc to interrupt)\x1b[0m', ''] : []), R, ...input, R,
        ...(this.sh ? ['  \x1b[38;5;211m! for shell mode\x1b[0m', TMUX] : [`  🤖 ${this.model} | 💰 $17.17 session`, MODES[this.mode] ? `  \x1b[38;5;114m${MODES[this.mode]}\x1b[0m (shift+tab to cycle) · 3 shells` : '  \x1b[2m? for shortcuts\x1b[0m', TMUX])];
    }
    const all = [...this.log.flatMap(wrap), ...tail];
    // tmux cuts its status line to the width (written whole, a phone's narrow pane wrapped it onto a second row)
    return [...Array(Math.max(0, this.rows - all.length)).fill(''), ...all].slice(-this.rows).map(l => (l === TMUX ? TMUX.slice(0, 8 + this.cols) + '\x1b[0m' : l));
  }
  paint(lines) {
    this.screen = lines;
    const pre = this.bp ? '' : (this.bp = true, '\x1b[?2004h'); // Claude asks for bracketed paste
    this.ws.send(Buffer.concat([Buffer.from('0'), Buffer.from(pre + '\x1b[H\x1b[2J' + lines.map((l, i) => `\x1b[${i + 1};1H` + l).join(''))]));
  }
  redraw() { if (this.rows) this.paint(this.frame()); }
  resize(rows, cols) {
    // tmux first (screen_resize_y), its status line staying the last row; then, 120 ms later, Claude's own redraw for the new size
    const old = this.screen.slice(0, -1), d = old.length - (rows - 1);
    let cut = old;
    if (d > 0) { const cur = old.findLastIndex(l => /^(\x1b\[[0-9;]*m)*❯/.test(l)) /* the cursor: on Claude's input line, the last ❯ row */, below = cur < 0 ? 0 : Math.max(0, old.length - 1 - cur); cut = old.slice(0, old.length - Math.min(d, below)).slice(-(rows - 1)); }
    this.rows = rows; this.cols = cols; (this.sizes ||= []).push(rows);
    if (d < 0) cut = [...this.frame().slice(0, rows - 1 - old.length), ...old];
    if (old.length) this.paint([...cut, TMUX]);
    clearTimeout(this.t); this.t = setTimeout(() => this.redraw(), 120);
  }
}

const cmdReq = [];
async function phone(w, h) {
  const ctx = await browser.newContext({ viewport: { width: w, height: h }, deviceScaleFactor: 3, isMobile: engine !== 'firefox', hasTouch: true, reducedMotion: 'no-preference', serviceWorkers: 'block' }); // motion on: the phone's default
  await ctx.addInitScript(() => {
    // a stand-in visualViewport (no engine raises an on-screen keyboard), and the sampler
    const vv = Object.assign(new EventTarget(), { height: innerHeight, width: innerWidth, offsetTop: 0, offsetLeft: 0, scale: 1, pageTop: 0, pageLeft: 0 });
    Object.defineProperty(window, 'visualViewport', { value: vv, configurable: true });
    // iOS: with the keyboard up the visual viewport is panned (kb() below); a scroll of the window to the top takes the pan back, and says so
    // with a scroll event (the phone, 2026-10-24: the page pinned to the old pan, a keyboard-tall black band at the top, the field under it)
    window.scrollTo = () => { if (vv.offsetTop) { vv.offsetTop = 0; setTimeout(() => vv.dispatchEvent(new Event('scroll')), 0); } };
    window.__qa = { two: [], flips: 0, samples: 0, rec: null, watch: null, entry: [], entryOn: true };
    // the entry (the phone, 2026-10-24: opening a session showed Claude's own box and tmux's line for a moment, then the composer took over):
    // from the first frame, any of Claude's chrome on screen while the terminal is visible is the old UI showing through
    const entry = () => {
      if (!window.__qa.entryOn) return;
      const t = /** @type {any} */ (window).term, sc = document.querySelector('.xterm-screen'), wrap = document.getElementById('terminal-wrap');
      if (t && sc && wrap) {
        // the time from the first output (any row written) to the terminal in sight
        if (!window.__qa.out) for (let i = 0; i < t.rows; i++) if (t.buffer.active.getLine(i)?.translateToString(true)) { window.__qa.out = performance.now(); break; }
        if (window.__qa.out && !document.body.classList.contains('ccboot')) window.__qa.shownAt ??= Math.round(performance.now() - window.__qa.out);
        // the loader: in sight while the terminal is not (the phone, 2026-10-24: a black screen read as stuck)
        const ld = document.getElementById('ccload');
        if (ld && document.body.classList.contains('ccboot') && +getComputedStyle(ld).opacity > 0.9 && ld.getBoundingClientRect().height) (window.__qa.loader ||= []).push(ld.textContent);
        let o = 1; for (let e = sc; e; e = e.parentElement) { const cs = getComputedStyle(e); o *= +cs.opacity; if (cs.visibility === 'hidden' || cs.display === 'none') o = 0; }
        const r = sc.getBoundingClientRect(), wr = wrap.getBoundingClientRect(), b = t.buffer.active, cell = r.height / t.rows, line = i => b.getLine(b.viewportY + i)?.translateToString(true) || '';
        const vis = i => r.top + (i + 1) * cell <= wr.bottom + 1 && r.top + i * cell >= wr.top - 1;
        if (o > 0.05) for (let i = 0; i < t.rows; i++) if (vis(i) && (/^❯/.test(line(i)) && /^─{8,}$/.test(line(i - 1)) || /^\[ccw-dev\]/.test(line(i)))) { window.__qa.entry.push({ at: Math.round(performance.now()), row: i, txt: line(i).slice(0, 24), o: +o.toFixed(2) }); break; }
      }
      setTimeout(entry, 4);
    };
    addEventListener('DOMContentLoaded', entry);
    // the watch: every 4 ms, regardless of painting (a headless engine paints when it likes; a phone paints every 16 ms), the longest stretch
    // the newest conversation line is out of view, the longest stretch Claude's input line shows with the field, the largest band
    addEventListener('load', () => setInterval(() => {
      const w = window.__qa.watch, t = /** @type {any} */ (window).term, sc = document.querySelector('.xterm-screen'), wrap = document.getElementById('terminal-wrap'), comp = document.getElementById('cccomp');
      if (!w || !t || !sc) return;
      const r = sc.getBoundingClientRect(), wr = wrap.getBoundingClientRect(), b = t.buffer.active, line = i => b.getLine(b.viewportY + i)?.translateToString(true) || '', cell = r.height / t.rows, now = performance.now();
      let lastRow = -1; for (let i = t.rows - 1; i >= 0; i--) if (/Done:|Welcome/.test(line(i))) { lastRow = i; break; }
      const y = r.top + (lastRow + 1) * cell, seen = lastRow >= 0 && y <= wr.bottom + 1 && y - cell >= wr.top - 1;
      let box = false; for (let i = 0; i < t.rows - 1; i++) if (/^─{8,}$/.test(line(i)) && /^❯/.test(line(i + 1)) && r.top + (i + 2) * cell <= wr.bottom + 1 && r.top + i * cell >= wr.top - 1 && !comp.hidden) box = true;
      const band = +(/translateY\(([\d.]+)px\)/.exec(getComputedStyle(document.getElementById('terminal-container')).transform.replace(/matrix\(1, 0, 0, 1, 0, ([\d.]+)\)/, 'translateY($1px)'))?.[1] || 0);
      for (const [k, on] of [['gone', !seen], ['box', box]]) { if (on) { w[k + 'At'] ??= now; w[k] = Math.max(w[k], now - w[k + 'At']); } else w[k + 'At'] = null; }
      w.band = Math.max(w.band, band - cell - 8);
      // the page covers exactly what the phone shows (the visual viewport): not lower, not taller
      const bt = document.body.getBoundingClientRect(), v = window.visualViewport, off = Math.abs(bt.top - v.offsetTop) > 2 || Math.abs(bt.bottom - v.offsetTop - v.height) > 2;
      if (off) { w.offAt ??= now; w.off = Math.max(w.off, now - w.offAt); } else w.offAt = null;
    }, 4));
    addEventListener('load', () => setTimeout(function tick() {
      const comp = document.getElementById('cccomp'), sc = document.querySelector('.xterm-screen'), wrap = document.getElementById('terminal-wrap'), t = /** @type {any} */ (window).term;
      if (comp && sc && t) {
        if (comp.dataset.was !== String(comp.hidden)) { if (comp.dataset.was !== undefined) window.__qa.flips++; comp.dataset.was = String(comp.hidden); }
        const r = sc.getBoundingClientRect(), wb = wrap.getBoundingClientRect().bottom, b = t.buffer.active, line = i => b.getLine(b.viewportY + i)?.translateToString(true) || '';
        for (let i = 0; i < t.rows - 1; i++) if (/^─{8,}$/.test(line(i)) && /^❯/.test(line(i + 1)) && r.top + (i + 2) * r.height / t.rows <= wb + 1 && !comp.hidden) { window.__qa.two.push({ at: Math.round(performance.now()), row: i, rows: t.rows, tf: document.getElementById('terminal-container').style.transform }); break; }
        window.__qa.samples++;
        if (window.__qa.rec) { // a recording: per painted frame, the blank band, the last conversation line's place and text, Claude's box
          const tf = +(/translateY\((\d+)px\)/.exec(document.getElementById('terminal-container').style.transform)?.[1] || 0), cell = r.height / t.rows;
          let last = null;
          for (let i = t.rows - 1; i >= 0; i--) { const y = r.top + (i + 1) * cell; const txt = line(i).trim(); if (txt && y <= wb + 1 && !/^─|^❯|Opus|mode on|\[ccw/.test(txt)) { last = { y: Math.round(y - window.visualViewport.offsetTop), txt: txt.slice(0, 30) }; break; } }
          window.__qa.rec.push({ at: Math.round(performance.now()), band: tf, cell: Math.round(cell), last, two: window.__qa.two.length, rows: t.rows, wrapH: Math.round(wb - wrap.getBoundingClientRect().top) });
        }
      }
      requestAnimationFrame(() => setTimeout(tick, 0));
    }, 16));
  });
  let fake;
  await ctx.route(u => new URL(u).hostname === 'mows.test', async r => {
    const p = new URL(r.request().url()).pathname;
    if (p === '/term/') return r.fulfill({ contentType: 'text/html; charset=utf-8', body: PAGE });
    if (p === '/term/token') return r.fulfill({ contentType: 'application/json', body: '{"token":""}' });
    if (p.startsWith('/app/live.json')) return r.fulfill({ contentType: 'application/json', body: JSON.stringify([{ name: 'cc-default-vgs-slayer', label: 'vgs slayer', current: false, state: 'idle' }, { name: 'ccw-dev', label: 'main harness', current: true, state: 'needs-you' }]) });
    if (p.startsWith('/app/commands.json')) { cmdReq.push(r.request().url()); return r.fulfill({ contentType: 'application/json', body: JSON.stringify({ session: 'ccw-dev', cmds: [['compact', '[instructions]', 'Free up context by summarizing the conversation so far', 'built-in'], ['effort', '[level|auto|status]', 'Set the effort level', 'built-in'], ['model', '[model]', 'Switch the AI model', 'built-in'], ['frontend-design', '', 'Guidance for distinctive, intentional visual design', 'skill'], ['superpowers:brainstorming', '', 'Use this before any creative work', 'plugin']] }) }); }
    if (p.startsWith('/app/workflows.json') && new URL(r.request().url()).searchParams.has('agent')) { agReq.push(r.request().url()); return r.fulfill({ contentType: 'application/json', body: JSON.stringify({ agent: { result: '', failed: false,
      steps: [{ t: '2026-10-26T21:00:00Z', k: 'say', s: 'Reviewing the branch.' }, { t: '2026-10-26T21:01:00Z', k: 'tool', n: 'Bash', s: 'Run the suite' }, { t: '2026-10-26T21:01:30Z', k: 'tool', n: 'Bash', s: 'Run the suite' }] } }) }); }
    if (p.startsWith('/app/workflows.json')) return r.fulfill({ contentType: 'application/json', body: JSON.stringify({ session: 'ccw-dev', claude: FRONT, runs: [{ id: 'wf_0123abcd-ef0', name: 'email-engine-build', status: 'running', phase: 'Review', phases: ['Build', 'Review'], last: Date.now(), ms: 0, tokens: 0,
      desc: 'Build the email engine, then review it', start: Date.now() - 6_000_000,
      agents: [{ id: 'w1', label: 'build:lego0', phase: 'Build', state: 'done', model: 'Sonnet 5.5', tok: 156537, t0: '2026-10-26T21:08:37Z', t1: '2026-10-26T21:12:57Z' }, { id: 'w2', label: 'build:web', phase: 'Build', state: 'failed' }, { id: 'w3', label: 'review:branch', phase: 'Review', state: 'running' }] }],
      agents: [{ id: 'a1', label: 'dev-ladder', desc: 'Dev ladder', state: 'running', last: Date.now(), doing: 'Bash: Roll the priority worker' }, { id: 'a2', label: 'Old one', desc: '', state: 'done', last: Date.now() - 600_000, doing: '' }] }) });
    if (p === '/shot') return r.fulfill({ contentType: 'application/json', body: '{"ok":true,"path":"/tmp/shots/IMG_8152.png"}' });
    if (p.startsWith('/assets/')) { const f = join(ROOT, 'dist', p.slice(8)); if (existsSync(f)) return r.fulfill({ body: readFileSync(f), contentType: f.endsWith('.css') ? 'text/css' : f.endsWith('.mjs') ? 'text/javascript' : 'font/woff2' }); }
    if (p === '/settings/term-theme.json') return r.fulfill({ contentType: 'application/json', body: '{"name":""}' });
    return r.fulfill({ status: 204 });
  });
  await ctx.routeWebSocket(/\/term\/ws/, ws => { fake = new FakeClaude(ws); ws.onMessage(m => fake.feed(m)); });
  const page = await ctx.newPage(); const errs = [];
  page.on('pageerror', e => errs.push(String(e)));
  await page.goto('http://mows.test/term/?arg=attach&arg=ccw-dev&arg=ab12cd34&v=3');
  if (OUT) await page.waitForFunction(() => window.__qa.loader?.length, null, { timeout: 3000 }).then(() => page.screenshot({ path: join(OUT, `${w}-0-loader.png`) })).catch(() => {});
  await page.waitForFunction(() => /** @type {any} */ (window).term && document.getElementById('cckb'));
  await sleep(700);
  return { ctx, page, errs, fake: () => fake };
}
const st = P => P.page.evaluate(() => {
  const sc = document.querySelector('.xterm-screen').getBoundingClientRect();
  return { shown: !document.getElementById('cccomp').hidden, draft: document.getElementById('ccdraft').hidden ? '' : document.getElementById('ccdraft').textContent,
    chip: document.getElementById('ccmode').hidden ? '' : document.getElementById('ccmode').textContent, ph: /** @type {any} */ (document.getElementById('ccmsg')).placeholder,
    focus: document.activeElement?.id || document.activeElement?.className, two: window.__qa.two.length, flips: window.__qa.flips, samples: window.__qa.samples,
    sw: document.scrollingElement.scrollWidth, iw: innerWidth, left: Math.round(sc.left), right: Math.round(innerWidth - sc.right),
    // the blank band: the shift left after the rows went under the dock (less than a row), and the rows the pty has beyond what is shown
    band: +(/translateY\((\d+)px\)/.exec(document.getElementById('terminal-container').style.transform)?.[1] || 0), cell: Math.round(sc.height / window.term.rows),
    under: window.term.rows - Math.floor((document.getElementById('terminal-wrap').getBoundingClientRect().height - 6) / (sc.height / window.term.rows)),
    dockRight: Math.round(document.getElementById('ccdock').getBoundingClientRect().right),
    // the top: the screen starts at or above the top edge of the space shown (no blank strip under the status bar, the phone 2026-10-23)
    topGap: Math.round(sc.top - document.getElementById('terminal-wrap').getBoundingClientRect().top),
    // the field's own text area: one line at least whenever the field shows (the phone, 2026-10-24: 0 px after an attach)
    taH: Math.round(document.getElementById('ccmsg').getBoundingClientRect().height) };
});
// the keyboard, as iOS raises it: the visual viewport shorter, and panned so the focused field at the bottom stays above the keyboard
const kb = (P, h) => P.page.evaluate(h2 => { const vv = /** @type {any} */ (window.visualViewport); vv.height = h2; vv.offsetTop = innerHeight - h2; vv.dispatchEvent(new Event('resize')); vv.dispatchEvent(new Event('scroll')); }, h);
// the iOS keyboard: it slides for ~300 ms, the visual viewport shrinking (or growing) in steps, each step a resize event
const kbAnim = async (P, from, to) => { for (let i = 1; i <= 8; i++) { await kb(P, Math.round(from + (to - from) * i / 8)); await sleep(36); } };
// a glitch, from a recording: a band of more than a row, Claude's box on screen, or the last conversation line jumping away and back
const glitches = rec => {
  const out = [];
  for (const f of rec) { if (f.band > f.cell + 8) out.push(['band', f.at, f.band]); }
  if (rec.length && rec.at(-1).two > rec[0].two) out.push(['two inputs', rec.at(-1).two - rec[0].two]);
  const ys = rec.filter(f => f.last).map(f => f.last.y), moves = [];
  for (let i = 1; i < ys.length; i++) if (Math.abs(ys[i] - ys[i - 1]) > 2) moves.push(ys[i] - ys[i - 1]);
  for (let i = 1; i < moves.length; i++) if (Math.sign(moves[i]) !== Math.sign(moves[i - 1])) { out.push(['the last line jumps away and back', moves.join(',')]); break; }
  const texts = [...new Set(rec.filter(f => f.last).map(f => f.last.txt))];
  if (texts.length > 1) out.push(['the last line changes text mid-transition', texts]);
  return out;
};
const key = (P, k) => P.page.locator(`#cckb > button[data-k="${k}"]`).dispatchEvent('pointerdown');
const shot = (P, n) => (OUT ? P.page.screenshot({ path: join(OUT, `${n}.png`) }) : null);
const twos = P => P.page.evaluate(() => window.__qa.two.slice(0, 3));

// PHONES=se,15 runs only those
for (const [w, h, tag] of [[375, 667, 'se'], [393, 852, '15'], [430, 932, 'promax']].filter(p => !process.env.PHONES || process.env.PHONES.split(',').includes(p[2]))) {
  const P = await phone(w, h), F = P.fake();
  // the sampler runs on painted frames, and a headless engine paints when it likes: let it start before the first count
  await P.page.waitForFunction(() => window.__qa.samples >= 5, null, { timeout: 5000 }).catch(() => {});
  let s = await st(P);
  // the first entry (nothing remembered): Claude's box and tmux's line never on screen while the page finds out; the field comes with Claude's
  // box and its rows go under the dock, two resizes, both while the terminal is out of sight. From here on the field must never flip.
  for (let i = 0; i < 20 && !(s.under >= 5); i++) { await sleep(100); s = await st(P); }
  await P.page.waitForFunction(() => !document.body.classList.contains('ccboot'), null, { timeout: 4000 }).catch(() => {});
  const ent = await P.page.evaluate(() => { window.__qa.entryOn = false; const f = window.__qa.flips; window.__qa.flips = 0; return { e: window.__qa.entry, f, boot: document.body.classList.contains('ccboot'), shownAt: window.__qa.shownAt, loader: [...new Set(window.__qa.loader || [])], loaderGone: !document.getElementById('ccload')?.getBoundingClientRect().height }; });
  check(`${tag} 0 first open: the new UI from the first frame, never Claude's own box or tmux's line, at most two resizes (${(F.sizes || []).length}; in sight ${ent.shownAt} ms after the first output), the loader meanwhile`, !ent.e.length && !ent.boot && (F.sizes || []).length <= 2 && ent.loader.some(t => /^ccw-dev(connecting|opening)$/.test(t)) && ent.loaderGone, [ent.e.length, ent.e.slice(0, 3), ent, F.sizes]);
  s = await st(P);
  check(`${tag} 1 Claude idle with its suggestion: the field is the input, Claude's box hidden, the mode on the chip`, s.shown && !s.draft && s.chip === '⏵⏵ auto' && s.two === 0 && s.flips === 0, s);
  check(`${tag} 1 the dashboard's gutter: text 9+ px from both edges, no sideways scroll`, s.left >= 9 && s.right >= 9 && s.sw === s.iw, s);
  // on open the field appears, the terminal refits and settles (SETTLE) before Claude's rows go under the dock: allow that second
  for (let i = 0; i < 20 && !(s.under >= 5 && s.band < s.cell + 8); i++) { await sleep(100); s = await st(P); }
  check(`${tag} 1 no blank band: Claude's rows are under the dock (the pty has them), what is left of the shift is less than a row`, s.under >= 5 && s.band < s.cell + 8, s);
  check(`${tag} 1 no blank strip at the top: the text starts at or above the top edge`, s.topGap <= 0, s);
  await shot(P, `${tag}-1-idle`);
  // no strip: the terminal starts at the top; ⋯, the bar's first key, opens the menu (the keyboard drops for it) and a backdrop tap closes it
  const top = await P.page.evaluate(() => ({ strip: !!document.getElementById('ccstrip'), wrapTop: Math.round(document.getElementById('terminal-wrap').getBoundingClientRect().top), first: document.querySelector('#cckb > button:not(.mr)')?.dataset.k }));
  await P.page.locator('#cckb > button[data-k="Menu"]').click(); await P.page.waitForSelector('#ccsheet.open .pan'); await shot(P, `${tag}-1-menu`);
  await P.page.mouse.click(w / 2, 40); await sleep(300);
  const closed = await P.page.evaluate(() => !document.getElementById('ccsheet').classList.contains('open'));
  check(`${tag} 1 no strip, ⋯ is the bar's first key and opens the menu, a backdrop tap closes it`, !top.strip && top.wrapTop === 0 && top.first === 'Menu' && closed, [top, closed]);
  // the session's Workflow run and agents (2026-10-26): a count on the ⋯ key, off the terminal (a pill over it covered Claude's text), never
  // clipped by the bar; ⋯ opens the sheet with the run's agents on top
  const wf = await P.page.evaluate(() => { const p = document.getElementById('ccwf'), k = p.parentElement, r = p.getBoundingClientRect(), t = document.getElementById('terminal-wrap').getBoundingClientRect();
    const hit = document.elementsFromPoint(r.left + r.width / 2, r.top + 2);
    return { text: p.hidden ? '' : p.textContent, onMenu: k?.dataset.k === 'Menu', label: k?.getAttribute('aria-label'), offTerm: r.top >= t.bottom - 1, inView: r.top >= 0 && r.right <= innerWidth, shown: hit[0] === k || hit.includes(k) };
  });
  await P.page.locator('#cckb > button[data-k="Menu"]').click(); await P.page.waitForSelector("#ccsheet.open .pan"); await sleep(450); await shot(P, `${tag}-1-workflows`); // after the slide-in
  // the Archify diagrams (2026-10-26): a row above "All sessions" that reaches /diagrams, on screen once the sheet scrolls to it (the run is on top).
  // Measured once the slide-in has ended, not after a fixed wait: a busy WebKit was still sliding the sheet up after 450 ms (a flake, not a layout)
  await P.page.waitForFunction(() => /^(none|matrix\(1, 0, 0, 1, 0, 0\))$/.test(getComputedStyle(document.querySelector('#ccsheet .pan')).transform), null, { timeout: 3000 }).catch(() => {});
  const dg = await P.page.evaluate(() => { const ls = [...document.querySelectorAll('#ccsheet .ln')], d = ls.find(x => x.textContent.startsWith('Diagrams'));
    d?.scrollIntoView({ block: 'nearest' }); const r = d?.getBoundingClientRect();
    return { order: ls.slice(-2).map(x => x.firstChild.textContent).join('|'), top: r ? Math.round(r.top) : -1, bottom: r ? Math.round(r.bottom) : 1e9, ih: innerHeight }; });
  check(`${tag} 1 diagrams: the sheet's row before "All sessions", reachable on screen`, dg.order === 'Diagrams|All sessions' && dg.top >= 0 && dg.bottom <= dg.ih, dg);
  const wfs = await P.page.evaluate(() => ({ first: document.querySelector('#ccsheet .hd')?.nextElementSibling?.className, ags: [...document.querySelectorAll('#ccsheet .wf .ags li')].map(l => l.className + ':' + l.querySelector('span').textContent + ':' + l.lastChild.textContent), rows: [...document.querySelectorAll('#ccsheet .wf .run:not(.ags) li')].map(l => l.className + ':' + l.querySelector('span').textContent), head: document.querySelector('#ccsheet .wf small')?.textContent }));
  // a tap on a run: Claude's /workflows view for a phone (2026-10-26) — its description, each phase with its mark and count over its agents
  // (model, tokens, time), a phase still to come with its number; the rest of the sheet steps aside
  await P.page.locator('#ccsheet .wf .run[data-run]').click(); await P.page.waitForSelector('#ccsheet .rv'); await sleep(100);
  const rv = await P.page.evaluate(() => ({ head: document.querySelector('#ccsheet .dh b')?.textContent, sub: document.querySelector('#ccsheet .dh small')?.textContent, desc: document.querySelector('#ccsheet .rv .desc')?.textContent,
    ph: [...document.querySelectorAll('#ccsheet .rv .ph')].map(p => p.className.slice(3) + ':' + p.querySelector('.phh').textContent),
    ag: [...document.querySelectorAll('#ccsheet .rv .ph li')].map(l => l.querySelector('span').textContent + '|' + l.querySelector(':scope > small').textContent) }));
  check(`${tag} 1 run view: the run's phases with their counts over their agents, model, tokens and time`, rv.head === 'email-engine-build' && rv.sub === 'running · 2/3 agents · 1h40m'
    && rv.desc === 'Build the email engine, then review it' && rv.ph.join() === 'failed:✕Build1/2,running:●Review0/1'
    && rv.ag[0] === 'build:lego0Sonnet 5.5 · 156.5k tok|4m20s' && rv.ag.length === 3, rv);
  // a tap on an agent: its detail, newest step first; ‹ goes back a level at a time, and a sheet closed on a detail opens on the list again
  await P.page.locator('#ccsheet .rv li', { hasText: 'review:branch' }).click(); await P.page.waitForSelector('#ccsheet .dt ol'); await sleep(100);
  const dt = await P.page.evaluate(() => ({ head: document.querySelector('#ccsheet .dh b')?.textContent, sub: document.querySelector('#ccsheet .dh small')?.textContent,
    steps: [...document.querySelectorAll('#ccsheet .dt ol li')].map(l => l.className + ':' + l.querySelector('p').textContent),
    rest: [...document.querySelector('#ccsheet .pan').children].filter(c => !c.matches('.wf,.grab') && getComputedStyle(c).display !== 'none').length }));
  const aq = new URL(agReq.at(-1) || 'http://x/');
  check(`${tag} 1 agent detail: a tap shows the agent, what it did newest first (a repeat folded), and nothing else of the sheet`, dt.head === 'review:branch' && dt.sub === 'running · email-engine-build · Review'
    && dt.steps.join() === 'tool:Bash Run the suite ×2,say:Reviewing the branch.' && dt.rest === 0 && aq.searchParams.get('agent') === 'w3' && aq.searchParams.get('run') === 'wf_0123abcd-ef0', [dt, agReq.at(-1)]);
  await P.page.locator('#ccsheet .back').click(); await sleep(100);
  const up1 = await P.page.evaluate(() => !!document.querySelector('#ccsheet .rv'));
  await P.page.locator('#ccsheet .back').click(); await sleep(100);
  const back = (up1 ? 'run:' : '') + await P.page.evaluate(() => document.querySelectorAll('#ccsheet .wf .run li').length + ':' + !!document.querySelector('#ccsheet .dt'));
  await P.page.locator('#ccsheet .wf li', { hasText: 'dev-ladder' }).click(); await sleep(100);
  await P.page.mouse.click(w / 2, 40); await sleep(400);
  await P.page.locator('#cckb > button[data-k="Menu"]').click(); await P.page.waitForSelector('#ccsheet.open .pan'); await sleep(300);
  const reopen = await P.page.evaluate(() => !!document.querySelector('#ccsheet .dt') + ':' + getComputedStyle(document.querySelector('#ccsheet .hd')).display);
  check(`${tag} 1 agent detail: ‹ is the run, then the list; closed on a detail, the sheet opens on the list`, back === 'run:5:false' && reopen === 'false:flex' && new URL(agReq.at(-1)).searchParams.get('run') === null, [back, reopen]);
  await P.page.mouse.click(w / 2, 40); await sleep(300);
  // the sheet follows a finger down, as a native one (2026-10-26): a short drag moves it and springs back, a long one closes it
  const drag = async (dy, wait = 350, id = 'ccsheet') => {
    const G = `#${id} .grab`, g = await P.page.locator(G).boundingBox(), x = g.x + g.width / 2, y = g.y + 2, at = d => [{ identifier: 7, clientX: x, clientY: y + d }];
    await P.page.dispatchEvent(G, 'touchstart', { touches: at(0), changedTouches: at(0) });
    for (const d of [8, dy / 2, dy]) { await P.page.dispatchEvent(G, 'touchmove', { touches: at(d), changedTouches: at(d) }); await sleep(dy < 100 ? 120 : 40); } // short: slow, no flick
    const mid = await P.page.evaluate(i => document.querySelector(`#${i} .pan`).style.transform, id);
    await P.page.dispatchEvent(G, 'touchend', { touches: [], changedTouches: at(dy) }); await sleep(wait);
    return { mid, open: await P.page.evaluate(i => document.getElementById(i).classList.contains('open'), id), after: await P.page.evaluate(i => document.querySelector(`#${i} .pan`).style.transform, id) };
  };
  await P.page.locator('#cckb > button[data-k="Menu"]').click(); await P.page.waitForSelector('#ccsheet.open .pan'); await sleep(450);
  const dShort = await drag(40), dLong = await drag(400);
  check(`${tag} 1 drag: the sheet follows the finger; a short drag springs back, a long one closes it`, dShort.mid === 'translateY(40px)' && dShort.open && dShort.after === ''
    && dLong.mid === 'translateY(400px)' && !dLong.open && dLong.after === '', [dShort, dLong]);
  check(`${tag} 1 workflow: ⋯ counts what runs (the run + 1 agent), off the terminal; ⋯ opens the sheet with the agents on top`, wf.text === '2' && wf.onMenu && wf.label === 'terminal actions, 2 running' && wf.offTerm && wf.inView && wfs.first === 'wf' && wfs.rows.join() === 'done:build:lego0,failed:build:web,running:review:branch' && wfs.head === 'Review (2/2) · 2/3 agents', [wf, wfs]);
  check(`${tag} 1 agents: the background agents under the run, the running one with what it is doing`, wfs.ags.join() === 'running:dev-ladderBash: Roll the priority worker:,done:Old one:10m', wfs);
  // a tap on the terminal (a touch, as on the phone) brings the keyboard up in the field, never in xterm
  await P.page.evaluate(() => document.activeElement?.blur?.());
  const box = await P.page.locator('#terminal-wrap').boundingBox();
  const pt = [{ identifier: 1, clientX: box.x + box.width / 2, clientY: box.y + box.height / 2 }];
  await P.page.dispatchEvent('.xterm-screen', 'touchstart', { touches: pt, changedTouches: pt });
  await P.page.dispatchEvent('.xterm-screen', 'touchend', { touches: [], changedTouches: pt, cancelable: true });
  check(`${tag} 2 a tap on the terminal: the focus is in the field`, await P.page.evaluate(() => document.activeElement?.id === 'ccmsg'), await P.page.evaluate(() => document.activeElement?.className));
  await kb(P, Math.round(h * 0.52)); await sleep(1200);
  s = await st(P);
  check(`${tag} 2 the keyboard up: focus in the field, never two inputs, no flash, still no blank band or strip`, s.focus === 'ccmsg' && s.shown && s.two === 0 && s.flips === 0 && s.band < s.cell + 8 && s.under >= 5 && s.topGap <= 0 && s.taH >= 36, [s, await twos(P)]);
  await shot(P, `${tag}-2-keyboard`);
  await P.page.type('#ccmsg', 'check the strip on the phone'); await P.page.press('#ccmsg', 'Enter'); await sleep(900);
  s = await st(P);
  check(`${tag} 3 send: Claude gets it, works, comes back; the field stays`, F.log.some(l => l.includes('check the strip on the phone')) && s.shown && s.two === 0 && s.flips === 0, [s, await twos(P)]);
  // the keyboard down and up again as iOS animates it, every painted frame recorded (the phone, 2026-10-23: "a glitch where in a second I saw
  // old input text")
  for (const [name, a, b] of [['down', Math.round(h * 0.52), h], ['up', h, Math.round(h * 0.52)]]) {
    await P.page.evaluate(() => { window.__qa.rec = []; window.__qa.watch = { gone: 0, box: 0, band: 0, off: 0 }; });
    await kbAnim(P, a, b); await sleep(1100);
    const [rec, wt] = await P.page.evaluate(() => { const r = [window.__qa.rec, window.__qa.watch]; window.__qa.rec = null; window.__qa.watch = null; return r; });
    const g = glitches(rec);
    // a phone paints every 16 ms: a state that lasts 3 frames is seen
    if (wt.gone > 48) g.push(['the newest line out of view for ms', Math.round(wt.gone)]);
    if (wt.box > 48) g.push(["Claude's input line on screen for ms", Math.round(wt.box)]);
    if (wt.band > 0) g.push(['a band taller than a row, px over', Math.round(wt.band)]);
    if (wt.off > 20) g.push(['the page off the visible area (a black band, the field under the keyboard) for ms', Math.round(wt.off)]);
    check(`${tag} 3 keyboard ${name} (animated): no band, no box, the last line moves once to its place (${rec.length} frames)`, !g.length, [g, rec.filter((f, i) => i % 4 === 0).slice(0, 12)]);
  }
  // attach as on the phone, recorded: the keyboard is up in the field; ⋯ (the keyboard drops), Attach file, the picker takes the window (blur)
  // and gives it back (focus: the page repaints), the upload, Claude's [Image #1]
  await P.page.focus('#ccmsg'); await kbAnim(P, h, Math.round(h * 0.52)); await sleep(900);
  await P.page.evaluate(() => { window.__qa.rec = []; window.__qa.watch = { gone: 0, box: 0, band: 0, off: 0 }; });
  // iOS anchors its Photo Library / Camera / Files menu to the tap that opens it: attach starts from the field's +, in the bottom bar; the ⋯
  // sheet has no Attach tile while the field shows (its tile sat mid-screen, and so did the menu: the phone 2026-10-24)
  await P.page.locator('#cckb > button[data-k="Menu"]').click(); await P.page.waitForSelector('#ccsheet.open .pan');
  const tiles = await P.page.$$eval('#ccsheet .tile', t => t.filter(x => getComputedStyle(x).display !== 'none').map(x => x.textContent));
  await P.page.mouse.click(w / 2, 30); await kbAnim(P, Math.round(h * 0.52), h); await sleep(200);
  const plus = await P.page.evaluate(() => { const a = document.getElementById('ccadd')?.getBoundingClientRect(), d = document.getElementById('ccdock').getBoundingClientRect(); return a ? { top: Math.round(a.top), dockTop: Math.round(d.top), left: Math.round(a.left) } : null; });
  check(`${tag} 4 attach is the field's + in the bottom bar; the ⋯ sheet has no Attach tile while the field shows`, !!plus && plus.top >= plus.dockTop && JSON.stringify(tiles) === '["Copy text","Paste"]', [plus, tiles]);
  const chooser = P.page.waitForEvent('filechooser', { timeout: 3000 });
  await P.page.locator('#ccadd').click(); await sleep(100);
  // the picker covers the page: blur, and the page is not rendered meanwhile, so a text area measures 0 (its scrollHeight, stubbed; the layout
  // itself does not move); the upload and Claude's [Image #1] arrive while it is up; then the page comes back
  await P.page.evaluate(() => { dispatchEvent(new Event('blur')); Object.defineProperty(HTMLTextAreaElement.prototype, 'scrollHeight', { get: () => 0, configurable: true }); });
  await (await chooser).setFiles({ name: 'IMG_8152.png', mimeType: 'image/png', buffer: PNG }); await sleep(600);
  await P.page.evaluate(() => { delete (/** @type {any} */ (HTMLTextAreaElement.prototype)).scrollHeight; dispatchEvent(new Event('focus')); }); await sleep(600);
  {
    const [rec, wt] = await P.page.evaluate(() => { const r = [window.__qa.rec, window.__qa.watch]; window.__qa.rec = null; window.__qa.watch = null; return r; });
    const g = glitches(rec).filter(x => x[0] !== 'the last line changes text mid-transition'); // the upload itself adds a line
    if (wt.gone > 48) g.push(['the newest line out of view for ms', Math.round(wt.gone)]);
    if (wt.box > 48) g.push(["Claude's input line on screen for ms", Math.round(wt.box)]);
    if (wt.band > 0) g.push(['a band taller than a row, px over', Math.round(wt.band)]);
    if (wt.off > 20) g.push(['the page off the visible area (a black band, the field under the keyboard) for ms', Math.round(wt.off)]);
    check(`${tag} 4 attach as on the phone (keyboard down, picker, upload): no band, no box, nothing out of view (${rec.length} frames)`, !g.length, [g, rec.filter((f, i) => i % 4 === 0).slice(0, 10)]);
  }
  s = await st(P);
  check(`${tag} 4 attach an image: Claude holds [Image #1], the field shows it as the draft chip, the box stays hidden`, F.draft.startsWith('[Image #1]') && s.draft === '[Image #1]' && s.shown && s.two === 0 && s.flips === 0, [s, F.draft, await twos(P)]);
  check(`${tag} 4 after the picker the field's text area is a whole line, not collapsed`, s.taH >= 36, s);
  // tap the chip: the preview shows the image itself (this phone's own copy), named by Claude's token
  await P.page.locator('#ccdraft').click(); await sleep(200);
  const pv = await P.page.evaluate(() => ({ on: document.getElementById('ccprev').classList.contains('on'), img: document.querySelector('#ccprev img')?.getAttribute('src') || '', cap: document.querySelector('#ccprev figcaption')?.textContent || '' }));
  await shot(P, `${tag}-4-preview`);
  await P.page.locator('#ccprev .pv-x').click(); await sleep(100);
  check(`${tag} 4 a tap on the chip previews the attached image`, pv.on && pv.img.startsWith('blob:') && pv.cap.startsWith('[Image #1]') && !(await P.page.evaluate(() => document.getElementById('ccprev').classList.contains('on'))), pv);
  await P.page.type('#ccmsg', 'what is wrong here?'); await shot(P, `${tag}-4-attach`);
  await P.page.press('#ccmsg', 'Enter'); await sleep(900);
  s = await st(P);
  check(`${tag} 5 send with the image: one prompt "[Image #1] what is wrong here?", the chip clears`, F.last === '[Image #1] what is wrong here?' && !s.draft && s.two === 0, [s, F.last]);
  // attach, then take it back with the chip's ×: one ctrl+c, Claude's input is empty, the chip goes, Claude is not asked to exit
  await P.page.setInputFiles('input[type=file]', { name: 'oops.png', mimeType: 'image/png', buffer: PNG }); await sleep(700);
  const c0 = (F.inputs || []).length, d0 = (await st(P)).draft;
  await P.page.locator('#ccclear').click(); await sleep(500);
  s = await st(P);
  check(`${tag} 5 × removes the attachment: one ctrl+c, Claude's input empty, no chip, no exit warning`, /^\[Image #\d+\]$/.test(d0) && (F.inputs || []).slice(c0).join('') === '\x03' && F.draft === '' && !s.draft && !F.exitWarn, [d0, (F.inputs || []).slice(c0), F.draft, s.draft, F.exitWarn]);
  await P.page.setInputFiles('input[type=file]', { name: 'b.png', mimeType: 'image/png', buffer: PNG }); await sleep(700);
  await P.page.locator('#ccsend').click(); await sleep(900);
  check(`${tag} 6 an image alone: send with an empty field submits the draft`, /^\[Image #\d+\]$/.test(F.last), F.last);
  await key(P, 'UP'); await sleep(400); s = await st(P);
  check(`${tag} 7 ↑ recalls the last prompt: the chip shows it, the box stays hidden`, s.draft === F.last && s.two === 0, [s, F.last]);
  await key(P, 'Esc'); await sleep(300); s = await st(P);
  check(`${tag} 7 esc clears Claude's input: the chip goes`, !s.draft && F.draft === '', [s, F.draft]);
  // a long draft (the phone, 2026-10-23: the chip pushed the dock past the screen): the chip is cut with an ellipsis, nothing scrolls sideways
  F.last = '[Image #9] what is this empty space at the top of the terminal, and why does the page scroll sideways now?'; await key(P, 'UP'); await sleep(400);
  s = await st(P);
  check(`${tag} 7 a long draft: the chip shows it cut, the dock stays inside the screen`, s.draft.startsWith('[Image #9] what is this') && s.sw === s.iw && s.dockRight <= s.iw && s.two === 0, s);
  await shot(P, `${tag}-7-longdraft`);
  await key(P, 'Esc'); await sleep(300);
  await P.page.locator('#ccmode').click(); await sleep(400); s = await st(P);
  check(`${tag} 8 the mode chip: shift+tab, Claude's next mode on the chip`, s.chip === '⏵⏵ accept edits', s);
  // ---- the "/" menu: Claude's commands and the session's skills, from the field (asked on the phone, 2026-10-24) ----
  {
    await P.page.evaluate(() => { const b = document.querySelector('#cckb > button[data-k="Menu"]').getBoundingClientRect(); window.__dockTop = b.top; });
    const rows0 = await P.page.evaluate(() => window.term.rows);
    await P.page.locator('#ccmsg').focus(); await P.page.keyboard.type('/'); await sleep(500);
    const m1 = await P.page.evaluate(() => ({ open: !document.getElementById('cccmds').hidden, n: document.querySelectorAll('#cccmds .cmd').length, kinds: [...document.querySelectorAll('#cccmds .ck')].map(e => e.textContent), rows: window.term.rows, keyTop: document.querySelector('#cckb > button[data-k="Menu"]').getBoundingClientRect().top, was: window.__dockTop }));
    await shot(P, `${tag}-8-commands`);
    check(`${tag} 8 "/" opens the command menu above the field (built-ins, skills, plugins), and nothing resizes`, m1.open && m1.n === 5 && m1.kinds.includes('skill') && m1.kinds.includes('plugin') && m1.rows === rows0 && m1.keyTop === m1.was && cmdReq.length > 0, m1);
    await P.page.keyboard.type('eff'); await sleep(150);
    const first = await P.page.evaluate(() => document.querySelector('#cccmds .cmd')?.dataset.n);
    check(`${tag} 8 typing filters it: /eff puts /effort first`, first === 'effort', first);
    await P.page.locator('#cccmds .cmd', { hasText: '/effort' }).first().click(); await sleep(100);
    const after = await P.page.evaluate(() => ({ v: document.getElementById('ccmsg').value, open: !document.getElementById('cccmds').hidden, focus: document.activeElement?.id }));
    check(`${tag} 8 a tap puts "/effort " in the field, closes the menu, keeps the keyboard`, after.v === '/effort ' && !after.open && after.focus === 'ccmsg', after);
    await P.page.keyboard.type('status'); await P.page.press('#ccmsg', 'Enter'); await sleep(700);
    check(`${tag} 8 send runs it in Claude: "/effort status"`, F.last === '/effort status', F.last);
  }
  // ---- writing (the phone, 2026-10-24: a message typed after using the ⋯ menu landed in Claude's box, and the box showed) ----
  const sent = () => (F.inputs || []).length;
  const tapTerm = async () => {
    const b = await P.page.locator('#terminal-wrap').boundingBox(), pt = [{ identifier: 1, clientX: b.x + b.width / 2, clientY: b.y + b.height / 3 }];
    await P.page.dispatchEvent('.xterm-screen', 'touchstart', { touches: pt, changedTouches: pt });
    await P.page.dispatchEvent('.xterm-screen', 'touchend', { touches: [], changedTouches: pt, cancelable: true });
  };
  const two0 = (await st(P)).two;
  // W1 a long message in the field: nothing reaches the terminal while typing, then one paste and Enter
  await tapTerm(); let n0 = sent();
  const long = 'all menus I fire from the options should land here, in the field, and never in the box of Claude that sits behind it';
  await P.page.keyboard.type(long, { delay: 5 }); await sleep(200);
  s = await st(P);
  check(`${tag} W1 typing a long message: every key in the field, nothing to the terminal, the field grows, no box`, (await P.page.inputValue('#ccmsg')) === long && sent() === n0 && s.two === two0, [sent() - n0, s]);
  await P.page.press('#ccmsg', 'Enter'); await sleep(900);
  check(`${tag} W1 send: Claude has the whole message`, F.last === long, F.last);
  // W2 xterm's own input is disabled while the field is the input: a focus from anywhere (the iOS keyboard bar's ^/v walks the page's text
  // fields) cannot type into Claude's box
  n0 = sent();
  const x = await P.page.evaluate(async () => {
    const t = /** @type {any} */ (window).term.textarea, wrap = document.getElementById('terminal-wrap');
    t.focus();
    // what iOS does for a focused input: scroll its container to bring it into view; the terminal's box must not move
    wrap.scrollTop = 200; t.scrollIntoView({ block: 'center' }); await new Promise(r => setTimeout(r, 50));
    return { disabled: t.disabled, focused: document.activeElement === t, scrolled: wrap.scrollTop };
  });
  await P.page.keyboard.type('zz'); await sleep(150);
  check(`${tag} W2 xterm's input is disabled: a focus on it does not take, typed keys reach nothing behind the field`, x.disabled && !x.focused && sent() === n0 && !F.draft.includes('zz'), [x, sent() - n0, F.draft]);
  check(`${tag} W2 the terminal's box cannot be scrolled (iOS scrolls a focused input's container into view): Claude's box stays under the dock`, x.scrolled === 0 && (await st(P)).two === two0, [x, await st(P)]);
  // W3 every way out of the ⋯ menu, then a tap on the terminal and typing: the text is in the field
  for (const way of ['backdrop', 'Copy text', 'the + (attach)']) {
    await P.page.locator('#cckb > button[data-k="Menu"]').click(); await P.page.waitForSelector('#ccsheet.open .pan');
    if (way === 'backdrop') await P.page.mouse.click(w / 2, 30);
    else if (way === 'Copy text') { await P.page.locator('#ccsheet .tile', { hasText: 'Copy text' }).click(); await sleep(150); await P.page.locator('#ccclip-x').click(); }
    else { await P.page.mouse.click(w / 2, 30); const fc = P.page.waitForEvent('filechooser', { timeout: 3000 }); await P.page.locator('#ccadd').click(); await (await fc).setFiles({ name: 'w3.png', mimeType: 'image/png', buffer: PNG }); }
    await sleep(500);
    await tapTerm(); n0 = sent();
    await P.page.keyboard.type('after ' + way, { delay: 5 }); await sleep(250);
    s = await st(P);
    check(`${tag} W3 after the menu (${way}): a tap and typing go into the field, nothing to the terminal, no box`, (await P.page.inputValue('#ccmsg')).endsWith('after ' + way) && sent() === n0 && s.two === two0 && s.taH >= 36, [await P.page.inputValue('#ccmsg'), sent() - n0, s.focus, s]);
    await P.page.fill('#ccmsg', '');
  }
  check(`${tag} W3 the attached image is Claude's draft, shown as the chip`, (await st(P)).draft.startsWith('[Image #'), await st(P));
  await key(P, 'Esc'); await sleep(300);
  // W4 Claude's draft grows to several rows (a long recalled prompt): the box grows, the rows under the dock follow, the box never shows
  F.last = 'a recalled prompt long enough to wrap over several rows of Claude Code\'s own input box on a phone, the way a long message does when it is typed straight into the terminal';
  await key(P, 'UP'); await sleep(1000);
  s = await st(P);
  check(`${tag} W4 a draft over several rows: hidden, on the chip, never two inputs`, s.draft.startsWith('a recalled prompt') && s.two === two0 && s.shown && s.taH >= 36, [s, await twos(P)]);
  await key(P, 'Esc'); await sleep(400);
  // W5 typing the next message while Claude works on the last one
  await tapTerm(); await P.page.keyboard.type('first message', { delay: 5 }); await P.page.press('#ccmsg', 'Enter'); await sleep(60);
  await P.page.keyboard.type('second while it works', { delay: 5 }); await sleep(300);
  s = await st(P);
  check(`${tag} W5 typing while Claude works: the next message waits in the field, no box`, (await P.page.inputValue('#ccmsg')) === 'second while it works' && F.last === 'first message' && s.two === two0, [await P.page.inputValue('#ccmsg'), F.last, s]);
  await P.page.fill('#ccmsg', ''); await sleep(700);
  await P.page.evaluate(() => ((window.__qa.marks ||= {})['E'] = Math.round(performance.now())));
  // E esc while Claude works gives the message back in the field, to edit: once it has begun answering (Claude keeps nothing) and before it
  // has (Claude puts it back in its own box: it moves to the field, one ctrl+c out of Claude's box)
  F.work = 3000;
  for (const early of [false, true]) {
    F.early = early;
    await tapTerm(); await P.page.keyboard.type('a message sent by mistake', { delay: 5 }); await P.page.press('#ccmsg', 'Enter'); await sleep(500);
    const busy = F.scene, c0 = (F.inputs || []).length;
    await key(P, 'Esc'); await sleep(700);
    s = await st(P);
    check(`${tag} E esc ${early ? 'before Claude answered' : 'while Claude answers'}: the message is back in the field, Claude's input empty, no chip, no box`,
      busy === 'working' && (await P.page.inputValue('#ccmsg')) === 'a message sent by mistake' && F.draft === '' && !s.draft && s.two === two0 && !F.exitWarn,
      [busy, await P.page.inputValue('#ccmsg'), F.draft, s, (F.inputs || []).slice(c0)]);
    await P.page.fill('#ccmsg', ''); await sleep(300);
  }
  await P.page.evaluate(() => ((window.__qa.marks ||= {})['E2'] = Math.round(performance.now())));
  // a turn that ends by itself gives nothing back
  await tapTerm(); await P.page.keyboard.type('a finished one', { delay: 5 }); await P.page.press('#ccmsg', 'Enter'); await sleep(3600);
  check(`${tag} E a turn that ends by itself: the field stays empty`, (await P.page.inputValue('#ccmsg')) === '' && F.last === 'a finished one', [await P.page.inputValue('#ccmsg'), F.last]);
  F.work = 0; F.early = false;
  await P.page.evaluate(() => ((window.__qa.marks ||= {})['M'] = Math.round(performance.now())));
  // M the model, from Claude's status line, on a chip next to the mode; a tap opens Claude's own /model picker, a number switches
  const chips = () => P.page.evaluate(() => { const m = document.getElementById('ccmodel'), r = m.getBoundingClientRect(), sd = document.getElementById('ccsend').getBoundingClientRect(), md = document.getElementById('ccmode').getBoundingClientRect();
    const sp = m.querySelector('span'); return { shown: getComputedStyle(m).display !== 'none', whole: (() => { const rg = document.createRange(); rg.selectNodeContents(sp); return rg.getBoundingClientRect().width <= sp.getBoundingClientRect().width + 0.5; })(), name: sp.textContent, effort: m.querySelector('small').textContent, right: Math.round(r.right), sendLeft: Math.round(sd.left), modeRight: Math.round(md.right), left: Math.round(r.left), top: Math.round(r.top), modeTop: Math.round(md.top), sw: document.scrollingElement.scrollWidth, iw: innerWidth }; });
  let c = await chips();
  check(`${tag} M1 the model chip: "Opus 5.5" and its effort, next to the mode chip, on one row, nothing overflows`, c.shown && c.name === 'Opus 5.5' && c.effort === 'high' && c.left >= c.modeRight && c.right <= c.sendLeft && c.top === c.modeTop && c.sw === c.iw, c);
  await shot(P, `${tag}-M1-model`);
  // the longest mode, as on the phone: "bypass permissions" and the model share the row, nothing pushed off it
  const m0 = F.mode; MODES.push('⏵⏵ bypass permissions on'); F.mode = MODES.length - 1; F.redraw(); await sleep(400); c = await chips();
  check(`${tag} M1 with "bypass permissions": both chips on the row, the model's name whole, nothing overflows`, c.shown && c.whole && c.left >= c.modeRight && c.right <= c.sendLeft && c.top === c.modeTop && c.sw === c.iw, c);
  await shot(P, `${tag}-M1-bypass`);
  MODES.pop(); F.mode = m0; F.redraw(); await sleep(400);
  await P.page.evaluate(() => ((window.__qa.marks ||= {})['P'] = Math.round(performance.now())));
  // P Claude's /model picker comes up as a sheet in the page's look: its rows, the highlight moved by a tap, the effort, its keys as buttons
  const sheet = () => P.page.evaluate(() => { const w = document.getElementById('ccpick'); if (!w) return { open: false }; const pan = w.querySelector('.pan'), r = pan.getBoundingClientRect(), on = w.querySelector('.opt.on .ol'), cur = w.querySelector('.opt.cur');
    return { open: w.classList.contains('open') && getComputedStyle(w).display !== 'none', title: w.querySelector('.hd b')?.textContent, rows: [...w.querySelectorAll('.opt .ol')].map(x => x.textContent), on: on?.textContent, cur: cur?.querySelector('.ol').textContent, tick: !!cur?.querySelector('svg'),
      more: [...w.querySelectorAll('.more')].map(x => x.textContent), adj: w.querySelector('.adj span')?.textContent, acts: [...w.querySelectorAll('.acts button')].map(x => x.textContent + (x.classList.contains('pri') ? '*' : '')),
      rect: [r.top, r.bottom, innerHeight], inView: r.top >= 0 && r.bottom <= innerHeight + 1 && r.left >= 0 && r.right <= innerWidth + 1, sw: document.scrollingElement.scrollWidth, iw: innerWidth, kb: document.activeElement?.id === 'ccmsg' }; });
  // open: the sheet up and its slide in over (a resize of the pty comes first)
  const opened = () => P.page.waitForFunction(() => { const w = document.getElementById('ccpick'); return w?.classList.contains('open') && getComputedStyle(w.querySelector('.pan')).transform === 'none'; }, null, { timeout: 5000 }).catch(() => {});
  const tapIn = async sel => { await P.page.locator('#ccpick ' + sel).click(); await sleep(450); };
  // a picker never resizes the pty: a resize makes Claude repaint the whole conversation, and on a long one the phone froze (2026-10-24)
  const sz0 = (F.sizes || []).length;
  await P.page.locator('#ccmodel').click(); await opened(); let k = await sheet();
  check(`${tag} P1 a tap on the chip opens the picker as a sheet: its title, the first four models, Opus 5.5 highlighted and ticked, the keyboard down`, F.scene === 'model' && k.open && k.title === 'Select model' && k.rows.join() === 'Opus 5.5,Fable 5.1,Sonnet 5.5,Haiku 5.5' && k.on === 'Opus 5.5' && k.cur === 'Opus 5.5' && k.tick && !k.kb, k);
  check(`${tag} P1 the rest of it: 2 more models, the effort, its keys (Enter the primary), on screen, nothing overflows`, k.more.join() === 'Show 2 more' && k.adj === 'high effort' && k.acts.join() === 'Use this session only,Set as default*' && k.inView && k.sw === k.iw, k);
  await shot(P, `${tag}-P1-picker`);
  let i0 = (F.inputs || []).length;
  await tapIn('.opt:has-text("Sonnet 5.5")'); k = await sheet();
  check(`${tag} P2 a tap on Sonnet 5.5 moves Claude's highlight (two ↓), nothing is chosen yet`, F.scene === 'model' && F.hl === 3 && k.open && k.on === 'Sonnet 5.5' && (F.inputs || []).slice(i0).join('') === '\x1b[B\x1b[B', [F.hl, k, (F.inputs || []).slice(i0)]);
  await tapIn('.more'); k = await sheet();
  check(`${tag} P3 "Show 2 more" moves past the window: Claude scrolls, the sheet follows (Opus 4.8 highlighted, earlier ones behind "Show earlier")`, F.hl === 5 && k.on === 'Opus 4.8' && k.rows.at(-1) === 'Opus 4.8' && k.more[0] === 'Show earlier', k);
  await tapIn('.adj button:last-child'); k = await sheet();
  check(`${tag} P4 › raises the effort`, F.eff === 3 && k.adj === 'xhigh effort', [F.eff, k.adj]);
  await shot(P, `${tag}-P4-scrolled`);
  await tapIn('.acts button:not(.pri)'); k = await sheet(); c = await chips();
  check(`${tag} P5 "Use this session only" is Claude's s: Opus 4.8 at xhigh, the sheet gone, the chip follows`, F.scene === 'idle' && F.how === 'session' && F.model === 'Opus 4.8 (xhigh)' && !k.open && c.name === 'Opus 4.8' && c.effort === 'xhigh', [F.scene, F.how, F.model, k.open, c]);
  await P.page.locator('#ccmodel').click(); await opened(); await tapIn('.hd button'); k = await sheet();
  check(`${tag} P6 Cancel is Claude's esc: nothing changes`, F.scene === 'idle' && F.model === 'Opus 4.8 (xhigh)' && !k.open, [F.scene, F.model, k.open]);
  // swiped down, as a native sheet (2026-10-27): a short drag springs back, a long one is Claude's esc, and the sheet does not come back
  await P.page.locator('#ccmodel').click(); await opened();
  const pShort = await drag(40, 350, 'ccpick'), pLong = await drag(400, 900, 'ccpick');
  check(`${tag} P6 a drag: the picker follows the finger; short springs back, long is Claude's esc and it stays shut`, pShort.mid === 'translateY(40px)' && pShort.open && pShort.after === '' && pLong.mid === 'translateY(400px)' && !pLong.open && F.scene === 'idle' && F.model === 'Opus 4.8 (xhigh)', [pShort, pLong, F.scene]);
  await P.page.locator('#ccmodel').click(); await opened(); await tapIn('.opt:has-text("Sonnet 5.5")'); await tapIn('.adj button:first-child'); await tapIn('.adj button:first-child'); await tapIn('.acts .pri'); k = await sheet(); c = await chips();
  check(`${tag} P7 "Set as default" is Claude's Enter: Sonnet 5.5 at medium, the default, the sheet gone`, F.scene === 'idle' && F.how === 'default' && F.model === 'Sonnet 5.5 (medium)' && !k.open && c.name === 'Sonnet 5.5' && c.effort === 'medium', [F.scene, F.how, F.model, k.open, c]);
  await sleep(800); s = await st(P);
  check(`${tag} P8 opened three times, moved, cancelled, chosen: not one resize of the pty; Claude's box back under the dock, one input`, (F.sizes || []).length === sz0 && s.shown && s.two === 0 && s.topGap <= 0, [(F.sizes || []).slice(sz0), await twos(P), s.two, await P.page.evaluate(() => window.__qa.marks)]);
  // a picker taller than the rows (its keys cut off, as /model on a small phone): Claude's own drawing and the field, as before
  F.prose = 60; await P.page.locator('#ccmodel').click(); await sleep(900); s = await st(P);
  check(`${tag} P9 a picker taller than the screen: no sheet, the field asks for a number`, F.scene === 'model' && !(await sheet()).open && s.shown, [F.scene, s]);
  await key(P, 'Esc'); await sleep(500); F.prose = 0; F.redraw(); await sleep(800);
  await key(P, 'UP'); await sleep(600); c = await chips(); const n1 = (F.inputs || []).join('').split('/model').length;
  check(`${tag} M4 while Claude holds a draft the chip gives its place to the draft chip (a /model typed after it would be text)`, !c.shown && (await st(P)).draft !== '', c);
  await key(P, 'Esc'); await sleep(400);
  check(`${tag} M4 nothing was typed into the draft`, (F.inputs || []).join('').split('/model').length === n1);
  await key(P, 'More'); await sleep(700); await key(P, 'More'); await sleep(700);
  await kb(P, h); await sleep(900); await kb(P, Math.round(h * 0.52)); await sleep(900);
  s = await st(P);
  check(`${tag} 9 the second key row, the keyboard down and up: never two inputs, no flash, no strip at the top`, s.two === 0 && s.flips === 0 && s.shown && s.topGap <= 0 && s.taH >= 36, [s, await twos(P)]);
  // a permission dialog as a sheet too (the phone, 2026-10-27: it still read as the old terminal UI): its question the title, every row above the
  // options as Claude drew them, a tap is Claude's number
  F.scene = 'dialog'; F.redraw(); await sleep(400); s = await st(P);
  k = await sheet();
  const pvt = await P.page.evaluate(() => document.querySelector('#ccpick .pv')?.textContent || '');
  check(`${tag} 10 a permission dialog: a sheet, its question the title, the command above the options, no mode chip`, k.open && k.title === 'Do you want to proceed?' && k.rows.length === 3 && k.rows[1].startsWith("Yes, and don't ask again for git pu") /* the fake cuts it at an SE's width */ && pvt.includes('Bash(git push origin feat/term-cockpit)') && !s.chip && s.two === 0, [k, pvt, s]);
  await shot(P, `${tag}-10-dialog`);
  i0 = (F.inputs || []).length;
  await P.page.locator('#ccpick .opt', { hasText: "don't ask again" }).click(); await sleep(500);
  check(`${tag} 11 a tap answers: Claude gets 2, the sheet goes`, F.scene === 'idle' && F.log.some(l => l.includes('answered 2')) && (F.inputs || []).slice(i0).join('') === '2' && !(await sheet()).open, [F.scene, F.log.slice(-3), (F.inputs || []).slice(i0)]);
  // S a `!` first: Claude's shell mode. The field types it as a terminal does (no autocorrect, no capitals), sends it as typed, and Claude's
  // shell-mode box is still its box: the field stays, a shell chip
  await P.page.focus('#ccmsg'); await P.page.keyboard.type('!'); await sleep(100);
  const sm = await P.page.evaluate(() => { const t = document.getElementById('ccmsg'); return { sh: document.getElementById('cccomp').classList.contains('sh'), ac: t.getAttribute('autocorrect'), cap: t.getAttribute('autocapitalize'), focus: document.activeElement === t }; });
  check(`${tag} S1 a \`!\` first: the field types a command (autocorrect and capitals off), keeps the focus`, sm.sh && sm.ac === 'off' && sm.cap === 'off' && sm.focus, sm);
  await P.page.keyboard.press('Backspace'); await sleep(100);
  const pr = await P.page.evaluate(() => ({ sh: document.getElementById('cccomp').classList.contains('sh'), ac: document.getElementById('ccmsg').getAttribute('autocorrect') }));
  check(`${tag} S2 the \`!\` gone: prose again`, !pr.sh && pr.ac === 'on', pr);
  i0 = (F.inputs || []).length;
  await P.page.fill('#ccmsg', '!ls -la'); await P.page.press('#ccmsg', 'Enter'); await sleep(600); s = await st(P);
  check(`${tag} S3 sent as typed, Claude ran it in its shell mode, the field still the input`, F.ran === 'ls -la' && (F.inputs || []).slice(i0).join('').includes('!ls -la') && s.shown && s.two === 0, [F.ran, (F.inputs || []).slice(i0), s]);
  await P.page.fill('#ccmsg', '!'); await P.page.evaluate(() => document.getElementById('ccmsg').dispatchEvent(new Event('input'))); F.sh = true; F.redraw(); await sleep(500); s = await st(P);
  check(`${tag} S4 Claude's shell-mode box (its \`!\` prompt) is its box: the field stays, the chip says shell`, s.shown && s.chip === '! shell' && s.two === 0, s);
  await P.page.fill('#ccmsg', '!pwd'); await P.page.press('#ccmsg', 'Enter'); await sleep(600);
  check(`${tag} S5 already in shell mode, the field's \`!\` is not typed twice`, F.ran === 'pwd', F.ran);
  // R the ⋯ sheet's restart: the pane goes blank while Claude starts again (seconds, for a long conversation): the loader, not a black terminal
  // and the key bar, until Claude's box is back
  F.bootMs = 2600; await P.page.evaluate(() => document.activeElement?.blur());
  await P.page.locator('#cckb > button[data-k="Menu"]').click(); await P.page.waitForSelector('#ccsheet.open .pan'); await sleep(400);
  const rst = P.page.locator('#ccsheet button', { hasText: 'Restart this pane' }); await rst.click(); await sleep(150); await P.page.locator('#ccsheet button', { hasText: 'Tap again' }).click();
  await sleep(2000);
  const mid = await P.page.evaluate(() => ({ boot: document.body.classList.contains('ccboot'), load: document.querySelector('#ccload .st')?.textContent }));
  check(`${tag} R1 restarting: the loader while the pane is blank, past the linger`, F.scene === 'boot' && mid.boot && mid.load === 'restarting', [F.scene, mid]);
  await sleep(1800); s = await st(P);
  const end = await P.page.evaluate(() => document.body.classList.contains('ccboot'));
  check(`${tag} R2 Claude back: the terminal and the field, Claude's box hidden`, F.scene === 'idle' && !end && s.shown && s.two === 0, [F.scene, end, s]);
  // A Claude's questions (AskUserQuestion) as a sheet, not the old terminal drawing (the phone, 2026-10-26): asked right after Claude's box
  const ask = () => P.page.evaluate(() => { const w = document.getElementById('ccpick'), f = w.querySelector('.free textarea');
    return { q: w.querySelector('.opts .q')?.textContent, ds: [...w.querySelectorAll('.opt .od')].map(x => x.textContent), ticks: [...w.querySelectorAll('.opt.box')].map(x => x.classList.contains('cur')), field: !!f, focused: document.activeElement === f, cancel: w.querySelector('.hd button')?.textContent, stray: [...w.querySelector('.pan').childNodes].filter(n => n.nodeType === 3).map(n => n.textContent) }; });
  // asked while typing (the keyboard up, the rows few): the keyboard goes, the terminal gets its rows back
  await P.page.focus('#ccmsg'); await kb(P, Math.round(h * 0.52)); await sleep(700);
  F.ask('ask'); await sleep(600);
  const dropped = await P.page.evaluate(() => document.activeElement?.id !== 'ccmsg');
  check(`${tag} A0 a question asked with the keyboard up: the keyboard goes`, dropped);
  await kb(P, h); await sleep(900); // as iOS does once the field lets go
  if (F.tall) { // taller than the screen: the header and the question cut off, so Claude's own drawing and the field, as for a tall picker
    await sleep(500); const s1 = await st(P);
    check(`${tag} A0 a question taller than the screen even so: Claude's drawing, the field asks for a number, no sheet`, !(await sheet()).open && s1.shown && s1.ph === 'Pick a number, or ↑ ↓ then send…', s1);
    await key(P, 'Esc'); await sleep(500);
  } else {
  await opened(); k = await sheet(); let a = await ask();
  check(`${tag} A1 a question comes up as a sheet: its header, the question whole, the options with their descriptions, the free one, Chat about this, Cancel`, k.open && k.title === 'Prod Doppler' && a.q === ASK1.q && k.rows.join('|') === 'Prepare, you run it (Recommended)|Credentials only, now|Everything, now|Type something…|Chat about this' && a.ds[1] === ASK1.opts[1][1] && a.cancel === 'Cancel' && !a.stray.length && k.on === 'Prepare, you run it (Recommended)' && k.inView && k.sw === k.iw && !k.kb, [k, a]);
  await shot(P, `${tag}-A1-question`);
  i0 = (F.inputs || []).length; await tapIn('.opt:has-text("Credentials only")'); k = await sheet();
  check(`${tag} A2 a tap answers: Claude gets 2, the sheet goes`, F.scene === 'idle' && F.log.some(l => l.includes('answered 2')) && !k.open && (F.inputs || []).slice(i0).join('') === '2', [F.scene, (F.inputs || []).slice(i0), k.open]);
  await sleep(500); F.ask('ask'); await opened(); await tapIn('.opt.ph'); a = await ask();
  check(`${tag} A3 "Type something…" opens a field in the sheet, focused`, a.field && a.focused, a);
  await P.page.fill('#ccpick .free textarea', 'use staging first'); await shot(P, `${tag}-A3-free`);
  i0 = (F.inputs || []).length; await tapIn('.free button'); k = await sheet();
  check(`${tag} A4 Send: the highlight moved there with arrows (a digit would be typed), the text, Enter: Claude has the answer`, F.log.some(l => l.includes('answered : use staging first')) && !k.open && (F.inputs || []).slice(i0).join('') === '\x1b[B\x1b[B\x1b[Buse staging first\r', [(F.inputs || []).slice(i0), F.log.slice(-3)]);
  await sleep(500); F.ask('askm'); await opened(); await tapIn('.opt:has-text("Lint")'); k = await sheet(); a = await ask();
  check(`${tag} A5 a multi-select question: a tap ticks (Claude's 1), the sheet stays with the tick and a Submit button`, F.scene === 'askm' && k.open && k.title === 'Checks' && a.ticks.join() === 'true,false,false' && k.acts.join() === 'Submit*', [F.scene, k, a]);
  await shot(P, `${tag}-A5-multi`);
  await tapIn('.opt.ph'); await P.page.fill('#ccpick .free textarea', 'docs'); await tapIn('.free button'); k = await sheet(); a = await ask();
  check(`${tag} A6 its free option: the text typed into it, no Enter (that would untick it): ticked, the sheet stays`, F.scene === 'askm' && F.atext === 'docs' && a.ticks.join() === 'true,false,true' && k.rows.includes('docs'), [F.scene, F.atext, a, k.rows]);
  await tapIn('.acts .pri'); k = await sheet();
  check(`${tag} A7 Submit: the highlight to Claude's Submit row, Enter: Claude has Lint and docs`, F.log.some(l => l.includes('answered submitted: Lint,docs')) && !k.open, F.log.slice(-3));
  // a page opened on a question already up (asked while the phone was away): no Claude box seen; the dashboard's word decides
  await sleep(400); F.scene = 'shell'; F.redraw(); await sleep(1800); i0 = (F.inputs || []).length; F.ask('ask'); await sleep(700);
  check(`${tag} A8 a question up with no Claude box seen and no word that Claude is in front: Claude's drawing, no sheet, nothing sent`, !(await sheet()).open && (F.inputs || []).length === i0, await sheet());
  FRONT = true; await P.page.evaluate(() => document.dispatchEvent(new Event('visibilitychange'))); await opened(); k = await sheet();
  check(`${tag} A9 the dashboard says Claude is in front: the question comes up as the sheet`, k.open && k.title === 'Prod Doppler', [k, F.tall, F.rows]);
  await tapIn('.hd button'); FRONT = false; await P.page.evaluate(() => document.dispatchEvent(new Event('visibilitychange'))); await sleep(300);
  check(`${tag} A10 Cancel is Claude's esc`, F.scene === 'idle' && F.log.some(l => l.includes('question cancelled')) && !(await sheet()).open, [F.scene, F.log.slice(-2)]);
  }
  await sleep(400); await P.page.evaluate(() => { window.__qa.flips = 0; }); // the shell of A8 hid the field and brought it back: 12-13 count their own
  F.scene = 'shell'; F.redraw(); await sleep(300); s = await st(P);
  check(`${tag} 12 Claude gone: the field lingers a moment (a redraw is not an exit)`, s.shown, s);
  await sleep(1700); s = await st(P);
  check(`${tag} 13 a shell: the field goes after the linger, the terminal is the one input`, !s.shown && s.two === 0 && s.flips === 1, s);
  await shot(P, `${tag}-13-shell`);
  // a picker drawn with no Claude box just before (a program, a file in the shell, laid out exactly as Claude's): no sheet, nothing sent
  let i1 = (F.inputs || []).length; Object.assign(F, { scene: 'model', hl: 1, win: 0, eff: 2, prose: 0 }); F.redraw(); await sleep(700);
  check(`${tag} 13 a picker drawn long after Claude's box was last seen is not taken for Claude's: no sheet, no keys`, !(await sheet()).open && (F.inputs || []).length === i1, [await sheet(), (F.inputs || []).slice(i1)]);
  F.scene = 'shell'; F.redraw(); await sleep(400);
  check(`${tag} 14 no sideways overflow, no page errors (${s.samples} painted frames sampled)`, s.sw === s.iw && P.errs.length === 0, [s, P.errs]);
  // reopened twice: first after the shell of step 13 (remembered as no Claude, and now Claude is back: its cut box must not show while the
  // page finds out; the field and Claude's rows come as two resizes), then with Claude's rows remembered (the first size the pty gets is the final one: no resize at all after the attach)
  for (const [n, maxSizes] of [['after a shell', 2], ['Claude remembered', 0]]) {
    await P.page.reload(); await P.page.waitForFunction(() => /** @type {any} */ (window).term && document.getElementById('cckb'));
    for (let i = 0; i < 30 && !(await P.page.evaluate(() => !document.body.classList.contains('ccboot'))); i++) await sleep(100);
    await sleep(700);
    const re = await P.page.evaluate(() => { window.__qa.entryOn = false; return { shownAt: window.__qa.shownAt, ent: window.__qa.entry, boot: document.body.classList.contains('ccboot'), shown: !document.getElementById('cccomp').hidden }; });
    const sz = P.fake().sizes || [];
    check(`${tag} 15 reopened ${n}: the new UI from the first frame, at most ${maxSizes} resize after the attach (${sz.length}; in sight ${re.shownAt} ms after the first output)`, !re.ent.length && !re.boot && re.shown && sz.length <= maxSizes, [re.ent.slice(0, 3), re, sz]);
  }
  await P.ctx.close();
}
await browser.close();
console.log(bad ? `term-claude-check ${engine}: ${bad} FAILED` : `term-claude-check ${engine}: ALL PASS`);
process.exit(bad ? 1 : 0);
