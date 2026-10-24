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
const TMUX = '\x1b[42;30m[ccw-dev] 0:claude* "Mobile notification" 22:23\x1b[0m';

class FakeClaude {
  constructor(ws) { Object.assign(this, { ws, rows: 0, cols: 0, log: [...Array.from({ length: 40 }, (_, i) => i % 3 === 2 ? '' : `\x1b[2m  ${i}\x1b[0m \x1b[32m+ an earlier line of the conversation, long enough to wrap on a phone screen #${i}\x1b[0m`), '\x1b[38;5;246m✻ Welcome back\x1b[0m', ''] /* a full screen of history, as on a session that has run a while */, draft: '', last: 'it\'s all merged?', imgs: 0, mode: 0, scene: 'idle', screen: [], bp: false }); }
  feed(m) {
    const s = typeof m === 'string' ? m : Buffer.from(m).toString('utf8');
    if (s[0] === '{') { const j = JSON.parse(s); this.rows = j.rows; this.cols = j.columns; this.redraw(); return; }
    if (s[0] === '1') { const j = JSON.parse(s.slice(1)); this.resize(j.rows, j.columns); return; }
    if (s[0] !== '0') return;
    let d = s.slice(1);
    (this.inputs ||= []).push(d); // every byte the page sent, for the writing checks
    if (this.scene === 'shell') { for (const c of d) { if (c === '\r') { this.log.push('dev@box:~$ ' + this.draft); this.draft = ''; } else if (c >= ' ') this.draft += c; } this.redraw(); return; }
    while (d) {
      let m;
      if ((m = /^\x1b\[200~([\s\S]*?)\x1b\[201~/.exec(d))) { const p = m[1]; this.draft += /\.(png|jpe?g|gif|webp)\s*$/i.test(p) ? `[Image #${++this.imgs}] ` : p.replace(/\r/g, '\n'); d = d.slice(m[0].length); continue; }
      if (d.startsWith('\x1b[Z')) { this.mode = (this.mode + 1) % MODES.length; d = d.slice(3); continue; }
      if (d.startsWith('\x1b[A') || d.startsWith('\x1bOA')) { this.draft = this.last; d = d.slice(3); continue; }
      if (d.startsWith('\x1b')) { // esc: cancels a dialog, clears the input
        if (this.scene === 'dialog') { this.scene = 'idle'; this.log.push('\x1b[2m  ⎿  cancelled\x1b[0m', ''); } else this.draft = '';
        d = d.slice(d.length > 1 && d[1] === '[' ? 3 : 1); continue;
      }
      const c = d[0]; d = d.slice(1);
      if (this.scene === 'dialog') { if (/[1-3]/.test(c)) { this.log.push(`\x1b[2m  ⎿  answered ${c}\x1b[0m`, ''); this.scene = 'idle'; } continue; }
      if (c === '\r') { if (this.draft.trim()) this.submit(); continue; }
      if (c === '\x7f') { this.draft = this.draft.slice(0, -1); continue; }
      if (c >= ' ') this.draft += c;
    }
    this.redraw();
  }
  submit() {
    const p = this.draft.trim(); this.last = p; this.draft = '';
    this.log.push(`\x1b[48;5;237m\x1b[38;5;246m❯ \x1b[38;5;231m${p}\x1b[0m`, '');
    this.scene = 'working'; this.redraw();
    setTimeout(() => { this.log.push('\x1b[32m●\x1b[0m Done: ' + p.slice(0, 60), ''); this.scene = 'idle'; this.redraw(); }, 400);
  }
  frame() {
    const R = '\x1b[38;5;244m' + '─'.repeat(this.cols) + '\x1b[0m';
    const wrap = l => { const plain = l.replace(/\x1b\[[0-9;]*m/g, ''); if (plain.length <= this.cols) return [l]; const out = []; for (let i = 0; i < plain.length; i += this.cols) out.push(plain.slice(i, i + this.cols)); return out; };
    let tail;
    if (this.scene === 'shell') tail = ['dev@box:~$ ' + this.draft, TMUX];
    else if (this.scene === 'dialog') tail = ['\x1b[32m●\x1b[0m Bash(git push origin feat/term-cockpit)', '', ' Do you want to proceed?', ' \x1b[38;5;153m❯ 1. Yes\x1b[0m', '   2. Yes, and don\'t ask again for git push', '   3. No, and tell Claude what to do', '', ' Esc to cancel', TMUX];
    else {
      // the input line: what is typed in the default colour; empty, the last prompt as Claude's dimmed suggestion under its inverse cursor
      // as Claude draws it: wrapped at the box's width, the first row after ❯, the rest indented two
      const w = Math.max(8, this.cols - 2), rowsOf = t => t.split('\n').flatMap(p => { const out = []; for (let i = 0; i < Math.max(1, p.length); i += w) out.push(p.slice(i, i + w)); return out; });
      const input = this.draft ? rowsOf(this.draft).map((r, i) => (i ? '  ' : '\x1b[38;5;246m❯\u00a0\x1b[39m') + r) : ['\x1b[38;5;246m❯\u00a0\x1b[7m' + this.last[0] + '\x1b[27m\x1b[2m' + this.last.slice(1, w) + '\x1b[0m'];
      tail = [...(this.scene === 'working' ? ['\x1b[38;5;173m✻ Simmering…\x1b[0m \x1b[2m(3s · esc to interrupt)\x1b[0m', ''] : []), R, ...input, R,
        '  🤖 Opus 5.5 (high) | 💰 $17.17 session', MODES[this.mode] ? `  \x1b[38;5;114m${MODES[this.mode]}\x1b[0m (shift+tab to cycle) · 3 shells` : '  \x1b[2m? for shortcuts\x1b[0m', TMUX];
    }
    const all = [...this.log.flatMap(wrap), ...tail];
    return [...Array(Math.max(0, this.rows - all.length)).fill(''), ...all].slice(-this.rows);
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
    this.rows = rows; this.cols = cols;
    if (d < 0) cut = [...this.frame().slice(0, rows - 1 - old.length), ...old];
    if (old.length) this.paint([...cut, TMUX]);
    clearTimeout(this.t); this.t = setTimeout(() => this.redraw(), 120);
  }
}

async function phone(w, h) {
  const ctx = await browser.newContext({ viewport: { width: w, height: h }, deviceScaleFactor: 3, isMobile: engine !== 'firefox', hasTouch: true, reducedMotion: 'no-preference', serviceWorkers: 'block' }); // motion on: the phone's default
  await ctx.addInitScript(() => {
    // a stand-in visualViewport (no engine raises an on-screen keyboard), and the sampler
    const vv = Object.assign(new EventTarget(), { height: innerHeight, width: innerWidth, offsetTop: 0, offsetLeft: 0, scale: 1, pageTop: 0, pageLeft: 0 });
    Object.defineProperty(window, 'visualViewport', { value: vv, configurable: true });
    window.__qa = { two: [], flips: 0, samples: 0, rec: null, watch: null };
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
          for (let i = t.rows - 1; i >= 0; i--) { const y = r.top + (i + 1) * cell; const txt = line(i).trim(); if (txt && y <= wb + 1 && !/^─|^❯|Opus|mode on|\[ccw/.test(txt)) { last = { y: Math.round(y), txt: txt.slice(0, 30) }; break; } }
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
    if (p === '/shot') return r.fulfill({ contentType: 'application/json', body: '{"ok":true,"path":"/tmp/shots/IMG_8152.png"}' });
    if (p.startsWith('/assets/')) { const f = join(ROOT, 'dist', p.slice(8)); if (existsSync(f)) return r.fulfill({ body: readFileSync(f), contentType: f.endsWith('.css') ? 'text/css' : f.endsWith('.mjs') ? 'text/javascript' : 'font/woff2' }); }
    if (p === '/settings/term-theme.json') return r.fulfill({ contentType: 'application/json', body: '{"name":""}' });
    return r.fulfill({ status: 204 });
  });
  await ctx.routeWebSocket(/\/term\/ws/, ws => { fake = new FakeClaude(ws); ws.onMessage(m => fake.feed(m)); });
  const page = await ctx.newPage(); const errs = [];
  page.on('pageerror', e => errs.push(String(e)));
  await page.goto('http://mows.test/term/?arg=attach&arg=ccw-dev&arg=ab12cd34&v=3');
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
    topGap: Math.round(sc.top - document.getElementById('terminal-wrap').getBoundingClientRect().top) };
});
const kb = (P, h) => P.page.evaluate(h2 => { const vv = /** @type {any} */ (window.visualViewport); vv.height = h2; vv.dispatchEvent(new Event('resize')); }, h);
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

for (const [w, h, tag] of [[375, 667, 'se'], [393, 852, '15'], [430, 932, 'promax']]) {
  const P = await phone(w, h), F = P.fake();
  // the sampler runs on painted frames, and a headless engine paints when it likes: let it start before the first count
  await P.page.waitForFunction(() => window.__qa.samples >= 5, null, { timeout: 5000 }).catch(() => {});
  let s = await st(P);
  check(`${tag} 1 Claude idle with its suggestion: the field is the input, Claude's box hidden, the mode on the chip`, s.shown && !s.draft && s.chip === '⏵⏵ auto mode' && s.two === 0 && s.flips === 1, s);
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
  // a tap on the terminal (a touch, as on the phone) brings the keyboard up in the field, never in xterm
  await P.page.evaluate(() => document.activeElement?.blur?.());
  const box = await P.page.locator('#terminal-wrap').boundingBox();
  const pt = [{ identifier: 1, clientX: box.x + box.width / 2, clientY: box.y + box.height / 2 }];
  await P.page.dispatchEvent('.xterm-screen', 'touchstart', { touches: pt, changedTouches: pt });
  await P.page.dispatchEvent('.xterm-screen', 'touchend', { touches: [], changedTouches: pt, cancelable: true });
  check(`${tag} 2 a tap on the terminal: the focus is in the field`, await P.page.evaluate(() => document.activeElement?.id === 'ccmsg'), await P.page.evaluate(() => document.activeElement?.className));
  await kb(P, Math.round(h * 0.52)); await sleep(1200);
  s = await st(P);
  check(`${tag} 2 the keyboard up: focus in the field, never two inputs, no flash, still no blank band or strip`, s.focus === 'ccmsg' && s.shown && s.two === 0 && s.flips === 1 && s.band < s.cell + 8 && s.under >= 5 && s.topGap <= 0, [s, await twos(P)]);
  await shot(P, `${tag}-2-keyboard`);
  await P.page.type('#ccmsg', 'check the strip on the phone'); await P.page.press('#ccmsg', 'Enter'); await sleep(900);
  s = await st(P);
  check(`${tag} 3 send: Claude gets it, works, comes back; the field stays`, F.log.some(l => l.includes('check the strip on the phone')) && s.shown && s.two === 0 && s.flips === 1, [s, await twos(P)]);
  // the keyboard down and up again as iOS animates it, every painted frame recorded (the phone, 2026-10-23: "a glitch where in a second I saw
  // old input text")
  for (const [name, a, b] of [['down', Math.round(h * 0.52), h], ['up', h, Math.round(h * 0.52)]]) {
    await P.page.evaluate(() => { window.__qa.rec = []; window.__qa.watch = { gone: 0, box: 0, band: 0 }; });
    await kbAnim(P, a, b); await sleep(1100);
    const [rec, wt] = await P.page.evaluate(() => { const r = [window.__qa.rec, window.__qa.watch]; window.__qa.rec = null; window.__qa.watch = null; return r; });
    const g = glitches(rec);
    // a phone paints every 16 ms: a state that lasts 3 frames is seen
    if (wt.gone > 48) g.push(['the newest line out of view for ms', Math.round(wt.gone)]);
    if (wt.box > 48) g.push(["Claude's input line on screen for ms", Math.round(wt.box)]);
    if (wt.band > 0) g.push(['a band taller than a row, px over', Math.round(wt.band)]);
    check(`${tag} 3 keyboard ${name} (animated): no band, no box, the last line moves once to its place (${rec.length} frames)`, !g.length, [g, rec.filter((f, i) => i % 4 === 0).slice(0, 12)]);
  }
  // attach as on the phone, recorded: the keyboard is up in the field; ⋯ (the keyboard drops), Attach file, the picker takes the window (blur)
  // and gives it back (focus: the page repaints), the upload, Claude's [Image #1]
  await P.page.focus('#ccmsg'); await kbAnim(P, h, Math.round(h * 0.52)); await sleep(900);
  await P.page.evaluate(() => { window.__qa.rec = []; window.__qa.watch = { gone: 0, box: 0, band: 0 }; });
  await P.page.locator('#cckb > button[data-k="Menu"]').click(); await kbAnim(P, Math.round(h * 0.52), h); await sleep(200);
  await P.page.locator('#ccsheet .tile', { hasText: 'Attach file' }).click(); await sleep(100);
  await P.page.evaluate(() => { dispatchEvent(new Event('blur')); });
  await P.page.setInputFiles('input[type=file]', { name: 'IMG_8152.png', mimeType: 'image/png', buffer: Buffer.from('PNG') });
  await P.page.evaluate(() => { dispatchEvent(new Event('focus')); }); await sleep(900);
  {
    const [rec, wt] = await P.page.evaluate(() => { const r = [window.__qa.rec, window.__qa.watch]; window.__qa.rec = null; window.__qa.watch = null; return r; });
    const g = glitches(rec).filter(x => x[0] !== 'the last line changes text mid-transition'); // the upload itself adds a line
    if (wt.gone > 48) g.push(['the newest line out of view for ms', Math.round(wt.gone)]);
    if (wt.box > 48) g.push(["Claude's input line on screen for ms", Math.round(wt.box)]);
    if (wt.band > 0) g.push(['a band taller than a row, px over', Math.round(wt.band)]);
    check(`${tag} 4 attach as on the phone (keyboard down, picker, upload): no band, no box, nothing out of view (${rec.length} frames)`, !g.length, [g, rec.filter((f, i) => i % 4 === 0).slice(0, 10)]);
  }
  s = await st(P);
  check(`${tag} 4 attach an image: Claude holds [Image #1], the field shows it as the draft chip, the box stays hidden`, F.draft.startsWith('[Image #1]') && s.draft === '[Image #1]' && s.shown && s.two === 0 && s.flips === 1, [s, F.draft, await twos(P)]);
  await P.page.type('#ccmsg', 'what is wrong here?'); await shot(P, `${tag}-4-attach`);
  await P.page.press('#ccmsg', 'Enter'); await sleep(900);
  s = await st(P);
  check(`${tag} 5 send with the image: one prompt "[Image #1] what is wrong here?", the chip clears`, F.last === '[Image #1] what is wrong here?' && !s.draft && s.two === 0, [s, F.last]);
  await P.page.setInputFiles('input[type=file]', { name: 'b.png', mimeType: 'image/png', buffer: Buffer.from('PNG') }); await sleep(700);
  await P.page.locator('#ccsend').click(); await sleep(900);
  check(`${tag} 6 an image alone: send with an empty field submits the draft`, F.last === '[Image #2]', F.last);
  await key(P, 'UP'); await sleep(400); s = await st(P);
  check(`${tag} 7 ↑ recalls the last prompt: the chip shows it, the box stays hidden`, s.draft === '[Image #2]' && s.two === 0, s);
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
  for (const way of ['backdrop', 'Copy text', 'Attach file']) {
    await P.page.locator('#cckb > button[data-k="Menu"]').click(); await P.page.waitForSelector('#ccsheet.open .pan');
    if (way === 'backdrop') await P.page.mouse.click(w / 2, 30);
    else if (way === 'Copy text') { await P.page.locator('#ccsheet .tile', { hasText: 'Copy text' }).click(); await sleep(150); await P.page.locator('#ccclip-x').click(); }
    else { await P.page.locator('#ccsheet .tile', { hasText: 'Attach file' }).click(); await P.page.setInputFiles('input[type=file]', { name: 'w3.png', mimeType: 'image/png', buffer: Buffer.from('PNG') }); }
    await sleep(500);
    await tapTerm(); n0 = sent();
    await P.page.keyboard.type('after ' + way, { delay: 5 }); await sleep(250);
    s = await st(P);
    check(`${tag} W3 after the menu (${way}): a tap and typing go into the field, nothing to the terminal, no box`, (await P.page.inputValue('#ccmsg')).endsWith('after ' + way) && sent() === n0 && s.two === two0, [await P.page.inputValue('#ccmsg'), sent() - n0, s.focus, s]);
    await P.page.fill('#ccmsg', '');
  }
  check(`${tag} W3 the attached image is Claude's draft, shown as the chip`, (await st(P)).draft.startsWith('[Image #'), await st(P));
  await key(P, 'Esc'); await sleep(300);
  // W4 Claude's draft grows to several rows (a long recalled prompt): the box grows, the rows under the dock follow, the box never shows
  F.last = 'a recalled prompt long enough to wrap over several rows of Claude Code\'s own input box on a phone, the way a long message does when it is typed straight into the terminal';
  await key(P, 'UP'); await sleep(1000);
  s = await st(P);
  check(`${tag} W4 a draft over several rows: hidden, on the chip, never two inputs`, s.draft.startsWith('a recalled prompt') && s.two === two0 && s.shown, [s, await twos(P)]);
  await key(P, 'Esc'); await sleep(400);
  // W5 typing the next message while Claude works on the last one
  await tapTerm(); await P.page.keyboard.type('first message', { delay: 5 }); await P.page.press('#ccmsg', 'Enter'); await sleep(60);
  await P.page.keyboard.type('second while it works', { delay: 5 }); await sleep(300);
  s = await st(P);
  check(`${tag} W5 typing while Claude works: the next message waits in the field, no box`, (await P.page.inputValue('#ccmsg')) === 'second while it works' && F.last === 'first message' && s.two === two0, [await P.page.inputValue('#ccmsg'), F.last, s]);
  await P.page.fill('#ccmsg', ''); await sleep(700);
  await key(P, 'More'); await sleep(700); await key(P, 'More'); await sleep(700);
  await kb(P, h); await sleep(900); await kb(P, Math.round(h * 0.52)); await sleep(900);
  s = await st(P);
  check(`${tag} 9 the second key row, the keyboard down and up: never two inputs, no flash, no strip at the top`, s.two === 0 && s.flips === 1 && s.shown && s.topGap <= 0, [s, await twos(P)]);
  F.scene = 'dialog'; F.redraw(); await sleep(400); s = await st(P);
  check(`${tag} 10 a permission dialog: nothing hidden, the field asks for 1–3, no mode chip`, s.ph === 'Type 1–3 to choose…' && s.shown && !s.chip && s.two === 0, s);
  await shot(P, `${tag}-10-dialog`);
  await P.page.fill('#ccmsg', '1'); await P.page.press('#ccmsg', 'Enter'); await sleep(500);
  check(`${tag} 11 a digit answers the dialog`, F.scene === 'idle' && F.log.some(l => l.includes('answered 1')), F.log.slice(-3));
  F.scene = 'shell'; F.redraw(); await sleep(300); s = await st(P);
  check(`${tag} 12 Claude gone: the field lingers a moment (a redraw is not an exit)`, s.shown, s);
  await sleep(1700); s = await st(P);
  check(`${tag} 13 a shell: the field goes after the linger, the terminal is the one input`, !s.shown && s.two === 0 && s.flips === 2, s);
  await shot(P, `${tag}-13-shell`);
  check(`${tag} 14 no sideways overflow, no page errors (${s.samples} painted frames sampled)`, s.sw === s.iw && P.errs.length === 0, [s, P.errs]);
  await P.ctx.close();
}
await browser.close();
console.log(bad ? `term-claude-check ${engine}: ${bad} FAILED` : `term-claude-check ${engine}: ALL PASS`);
process.exit(bad ? 1 : 0);
