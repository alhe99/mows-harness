// Cockpit phase 04 terminal probe (specs/cockpit/04-heavy-pages.md tasks 3-8, 11). Exit code is the verdict.
// usage: node docs/qa/probes/term-check.mjs <webkit|chromium> <proto|keybar|ime|clipboard|sheet|composer|paint|theme|framed|all>
// env: DASH (default http://127.0.0.1:3105; only /assets/ is fetched from it), PLAYWRIGHT (module path; default: the repo's)
// The page under test is dist/term.html, served by the probe in place of /term/ on the DASH origin; /term/token, the /term/ws socket (a fake ttyd:
// every frame the page sends is recorded and the probe answers with '0' output frames), /app/live.json, /a/switch, /shot, /z and
// /settings/term-theme.json are answered here, so nothing the probe does reaches ttyd, tmux or the disk. The MOWS_TEST_HOOKS flag the dev
// instance carries is not needed: the fake ttyd lives in the browser context. `paint` and `theme` run on Playwright's fake clock.
// Selectors: #cckb > button[data-k] #ccstrip #ccback #cctabs .tab[data-s] #ccmenu-btn #ccsheet .pan .tile .ln #ccdock #cccomp #ccmsg #ccmode #ccsend
// #ccmods #ccclip #ccclip-txt #ccthemesel #ccovl #cctoast.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const pw = await import(process.env.PLAYWRIGHT || 'playwright').catch(() => { console.error('term-check: playwright is not installed (npm ci --ignore-scripts)'); process.exit(2); });
const engine = process.argv[2] || 'webkit';
const mode = process.argv[3] || 'all';
const MODES = ['proto', 'keybar', 'ime', 'clipboard', 'sheet', 'composer', 'paint', 'theme', 'framed'];
if (mode !== 'all' && !MODES.includes(mode)) { console.error(`term-check: mode is one of ${MODES.join(' ')} all`); process.exit(2); }
const DASH = process.env.DASH || 'http://127.0.0.1:3105';
const ROOT = join(import.meta.dirname, '../../..');
const PAGE = readFileSync(join(ROOT, 'dist/term.html'), 'utf8');
const THEMES = JSON.parse(readFileSync(join(ROOT, 'infra/webconsole/themes.json'), 'utf8'));
const browser = await pw[engine].launch();

let bad = 0, cur = '';
const check = (id, ok, detail) => { if (!ok) bad++; console.log(`${ok ? 'PASS' : 'FAIL'} ${engine}/${cur} ${id}${ok || detail === undefined ? '' : ' ' + JSON.stringify(detail)}`); };
const note = m => console.log(`NOTE ${engine}/${cur} ${m}`);
const sleep = ms => new Promise(r => setTimeout(r, ms));
const A = 'wt-a', B = 'wt-b', TAB = 'ab12cd34';
const URL_A = `/term/?arg=attach&arg=${A}&arg=${TAB}&v=3`;
const LIVE = [{ name: A, label: '', current: true, state: 'working' }, { name: B, label: 'second', current: false, state: 'needs-you' }];

// the page, on the DASH origin, with a fake ttyd. Returns the world: W.page, W.sockets, W.sent (every frame the page sent), helpers.
async function open(path = URL_A, o = {}) {
  const { phone = true, motion = false, clock = false, perms = false, live = LIVE, switchStatus = 200, shot = '/tmp/shot-1.png', theme = { name: '' }, init } = o;
  const ctx = await browser.newContext({
    ...(phone ? { viewport: { width: 390, height: 844 }, deviceScaleFactor: 3, isMobile: true, hasTouch: true } : { viewport: { width: 1280, height: 800 } }),
    reducedMotion: motion ? 'no-preference' : 'reduce', serviceWorkers: 'block', ...(perms && engine === 'chromium' ? { permissions: ['clipboard-read', 'clipboard-write'] } : {}) });
  const W = { ctx, sockets: [], sent: [], beacons: [], posts: [], tokens: 0, live, theme, switchStatus, errors: [], shot };
  if (init) await ctx.addInitScript(init);
  const page = W.page = await ctx.newPage();
  page.on('pageerror', e => W.errors.push(String(e)));
  if (clock) await page.clock.install({ time: new Date('2026-10-11T12:00:00Z') });
  await ctx.route(u => ['/term/', '/term'].includes(new URL(u).pathname), r => r.fulfill({ contentType: 'text/html; charset=utf-8', body: PAGE }));
  await ctx.route('**/term/token', r => { W.tokens++; return r.fulfill({ contentType: 'application/json', body: '{"token":""}' }); });
  await ctx.route('**/app/live.json*', r => { W.beacons.push(r.request().url()); return r.fulfill({ contentType: 'application/json', body: JSON.stringify(W.live.map(s => ({ ...s, current: s.current && new URL(r.request().url()).searchParams.get('tab') === TAB }))) }); });
  await ctx.route('**/a/switch', r => { W.posts.push({ url: r.request().url(), body: r.request().postData() });
    if (W.switchStatus === 200) { const to = new URLSearchParams(r.request().postData()).get('to'); W.live = W.live.map(s => ({ ...s, current: s.name === to })); }
    return r.fulfill({ status: W.switchStatus, contentType: 'application/json', body: '{}' }); });
  await ctx.route('**/shot', r => { W.posts.push({ url: r.request().url(), body: r.request().postDataBuffer(), headers: r.request().headers() }); return r.fulfill({ contentType: 'application/json', body: JSON.stringify({ ok: true, path: W.shot }) }); });
  await ctx.route('**/z?*', r => { W.beacons.push(r.request().url()); return r.fulfill({ status: 204 }); });
  await ctx.route('**/settings/term-theme.json', r => { W.polls = (W.polls || 0) + 1; return r.fulfill({ contentType: 'application/json', body: JSON.stringify(W.theme) }); });
  await ctx.routeWebSocket(/\/term\/ws/, ws => {
    W.sockets.push(ws);
    ws.onMessage(m => W.sent.push(typeof m === 'string' ? Buffer.from(m) : m));
    ws.onClose(() => {});
  });
  // '0' + text down to the terminal; the last socket is the live one
  W.out = (t, i = W.sockets.length - 1) => W.sockets[i].send(Buffer.concat([Buffer.from('0'), Buffer.from(t)]));
  W.frame = (cmd, body, i = W.sockets.length - 1) => W.sockets[i].send(Buffer.concat([Buffer.from(cmd), Buffer.from(body)]));
  W.inputs = () => W.sent.filter(f => f[0] === 0x30).map(f => f.subarray(1).toString('utf8'));
  W.frames = pre => W.sent.filter(f => f[0] === pre.charCodeAt(0)).map(f => f.subarray(1).toString('utf8'));
  await page.goto(DASH + path);
  await page.waitForFunction(() => /** @type {any} */ (window).term && document.getElementById('cckb'));
  for (let i = 0; i < 100 && !W.sent.length; i++) await sleep(50);
  return W;
}
const shut = W => W.ctx.close();
// Playwright's fake clock ticks with real time until it is paused; from here only runFor() moves it, so a timer budget is exact
const freeze = async W => { const t = await W.page.evaluate(() => Date.now()); await W.page.clock.pauseAt(new Date(t + 10)); };
const bytes = s => JSON.stringify(s);
const tap = (W, sel) => W.page.locator(sel).dispatchEvent('pointerdown');
const keyBtn = (W, k) => `#cckb > button[data-k="${CSS_ESC(k)}"]`;
const CSS_ESC = k => k.replace(/["\\]/g, '\\$&');
const press = async (W, k, wait = 60) => { await W.page.locator(keyBtn(W, k)).dispatchEvent('pointerdown'); await sleep(wait); };
// a row of the menu sheet, by its text (the sheet need not be open: a click is dispatched)
const menuRow = (W, text) => W.page.locator('#ccsheet button', { hasText: text }).first().dispatchEvent('click');

// ---- proto: the bytes on the wire, per key -------------------------------------------------------------------------------------------------
async function proto() {
  const W = await open();
  const first = JSON.parse(W.sent[0].toString('utf8'));
  const dims = await W.page.evaluate(() => ({ cols: window.term.cols, rows: window.term.rows }));
  check('the first frame is JSON {AuthToken, columns, rows} with the terminal size', W.sent[0][0] === 0x7b && first.AuthToken === '' && first.columns === dims.cols && first.rows === dims.rows, [first, dims]);
  check('the socket is /term/ws with the page query and one token was fetched', W.sockets[0].url().endsWith(`/term/ws?arg=attach&arg=${A}&arg=${TAB}&v=3`) && W.tokens === 1, W.sockets[0].url());
  const expect = { Esc: '\x1b', Tab: '\t', 'S-Tab': '\x1b[Z', UP: '\x1b[A', DN: '\x1b[B', RT: '\x1b[C', LT: '\x1b[D', '^C': '\x03', NL: '\r' };
  for (const [k, want] of Object.entries(expect)) {
    const n = W.inputs().length;
    await press(W, k);
    const got = W.inputs().slice(n).join('');
    check(`key ${k} sends ${bytes(want)}`, got === want, bytes(got));
  }
  let n = W.inputs().length;
  await menuRow(W, 'Detach from tmux'); await sleep(250);
  check('the menu\'s Detach sends C-q then d (100 ms apart)', W.inputs().slice(n).join('|') === '\x11|d', W.inputs().slice(n));
  // the latches: one tap = the next key, a second tap within 350 ms = locked, a tap on a set latch clears it
  await press(W, 'Ctrl'); n = W.inputs().length; await press(W, 'LT'); await press(W, 'LT');
  check('ctrl, then \u2190 \u2190: the first is ctrl+left (CSI 1;5D), the second plain', W.inputs().slice(n).join('|') === '\x1b[1;5D|\x1b[D', bytes(W.inputs().slice(n)));
  await press(W, 'Alt'); n = W.inputs().length; await W.page.evaluate(() => window.term.input('b'));
  check('alt, then b typed: ESC b, and the latch is spent', W.inputs().slice(n).join('') === '\x1bb' && (await W.page.getAttribute(keyBtn(W, 'Alt'), 'data-mod')) === 'off', bytes(W.inputs().slice(n)));
  await press(W, 'Ctrl', 20); await press(W, 'Ctrl', 20);
  n = W.inputs().length; await W.page.evaluate(() => { window.term.input('r'); window.term.input('a'); });
  check('ctrl tapped twice locks: r and a go out as ^R ^A, and the chip says so', W.inputs().slice(n).join('|') === '\x12|\x01' && (await W.page.getAttribute(keyBtn(W, 'Ctrl'), 'data-mod')) === 'locked' && /ctrl locked/.test(await W.page.locator('#ccmods').textContent()), [bytes(W.inputs().slice(n)), await W.page.locator('#ccmods').textContent()]);
  await press(W, 'Ctrl'); n = W.inputs().length; await W.page.evaluate(() => window.term.input('r'));
  check('a tap on the locked latch clears it', W.inputs().slice(n).join('') === 'r' && !(await W.page.locator('#ccmods').evaluate(e => e.classList.contains('on'))), bytes(W.inputs().slice(n)));
  W.out('\x1b[?1h'); await sleep(60);
  n = W.inputs().length; await press(W, 'UP');
  check('UP follows application cursor mode (SS3)', W.inputs().slice(n).join('') === '\x1bOA', W.inputs().slice(n));
  W.out('\x1b[?1l\x1b[?2004h'); await sleep(60);
  n = W.inputs().length; await press(W, 'NL');
  check('NL is a bracketed paste while the app asked for it', W.inputs().slice(n).join('') === '\x1b[200~\r\x1b[201~', bytes(W.inputs().slice(n).join('')));
  // PgUp / PgDn: six wheel notches on the screen; with mouse reporting on they reach the pty as SGR wheel reports (64 up, 65 down)
  await W.page.evaluate(() => { const s = document.querySelector('.xterm-screen'); window.__wheel = []; s.addEventListener('wheel', e => window.__wheel.push(e.deltaY)); });
  W.out('\x1b[?1000h\x1b[?1006h'); await sleep(60);
  n = W.inputs().length; await press(W, 'PgUp', 120);
  const up = W.inputs().slice(n), wh = await W.page.evaluate(() => window.__wheel);
  check('PgUp is six wheel notches (deltaY -57), reported as button 64', wh.length === 6 && wh.every(d => d === -57) && up.length >= 6 && up.every(s => s.startsWith('\x1b[<64;')), [wh, up.slice(0, 2)]);
  n = W.inputs().length; await press(W, 'PgDn', 120);
  check('PgDn is wheel the other way, button 65', W.inputs().slice(n).length >= 6 && W.inputs().slice(n).every(s => s.startsWith('\x1b[<65;')), W.inputs().slice(n).slice(0, 2));
  // A- / A+: the size is stored, and the pty is resized to the new grid
  const f0 = await W.page.evaluate(() => window.term.options.fontSize);
  const r0 = W.frames('1').length;
  await W.page.locator('#ccsheet .step button', { hasText: 'A+' }).dispatchEvent('pointerdown'); await sleep(400);
  const f1 = await W.page.evaluate(() => [window.term.options.fontSize, localStorage.ccfontsize, document.querySelector('#ccsheet .step span').textContent]);
  check('A+ raises the font size by one, stores it and shows it', f1[0] === f0 + 1 && f1[1] === String(f0 + 1) && f1[2] === String(f0 + 1), [f0, f1]);
  const rz = W.frames('1');
  const d1 = await W.page.evaluate(() => ({ cols: window.term.cols, rows: window.term.rows }));
  check("the resize goes up as '1' + JSON {columns, rows}", rz.length > r0 && JSON.parse(rz.at(-1)).columns === d1.cols && JSON.parse(rz.at(-1)).rows === d1.rows, [rz.at(-1), d1]);
  // down: title, prefs, output
  W.frame('1', 'vim | host'); await sleep(60);
  check("a '1' frame is the document title", (await W.page.title()) === 'vim | host | mows terminal', await W.page.title());
  W.frame('2', JSON.stringify({ fontSize: 20, rendererType: 'webgl' })); await sleep(60);
  check("a '2' frame: the stored font size outranks the server's preference", (await W.page.evaluate(() => window.term.options.fontSize)) === f0 + 1);
  W.out('hello \u20ac\r\n'); await sleep(100);
  check("a '0' frame is written to the terminal", await W.page.evaluate(() => { const b = window.term.buffer.active; let t = ''; for (let i = 0; i < b.length; i++) t += b.getLine(i).translateToString(true) + '\n'; return t.includes('hello \u20ac'); }));
  // reconnect: close 1000 -> overlay, Enter -> new token, new socket, terminal reset
  await W.page.evaluate(() => window.term.write('stale\r\n'));
  W.sockets[0].close({ code: 1000 }); await sleep(300);
  check('close 1000 shows "Press \u23ce to Reconnect" and stays closed', (await W.page.locator('#ccovl').textContent()) === 'Press \u23ce to Reconnect' && W.sockets.length === 1);
  await W.page.evaluate(() => window.term.textarea.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', keyCode: 13, which: 13, bubbles: true, cancelable: true })));
  for (let i = 0; i < 40 && W.sockets.length < 2; i++) await sleep(50);
  check('Enter fetches a fresh token and opens a second socket with the same query', W.sockets.length === 2 && W.tokens === 2 && W.sockets[1].url() === W.sockets[0].url(), [W.sockets.length, W.tokens]);
  await sleep(100);
  check('the reconnected socket sends its first frame and the terminal was reset', JSON.parse(W.sent.find(f => f[0] === 0x7b && f !== W.sent[0]).toString('utf8')).AuthToken === '' && !(await W.page.evaluate(() => { const b = window.term.buffer.active; let t = ''; for (let i = 0; i < b.length; i++) t += b.getLine(i).translateToString(true); return t.includes('stale'); })));
  check('no page errors', W.errors.length === 0, W.errors);
  await shut(W);
}

// ---- keybar: order, geometry, touch scroll, keyboard fit -----------------------------------------------------------------------------------
async function keybar() {
  const W = await open(URL_A, { init: () => {
    // a stand-in visualViewport, so the iOS keyboard branch can be driven: the engines raise no on-screen keyboard
    const vv = Object.assign(new EventTarget(), { height: innerHeight, width: innerWidth, offsetTop: 0, offsetLeft: 0, scale: 1, pageTop: 0, pageLeft: 0 });
    Object.defineProperty(window, 'visualViewport', { value: vv, configurable: true });
  } });
  const order = await W.page.evaluate(() => [...document.querySelectorAll('#cckb > *')].map(e => e.dataset.k));
  const want = ['^C', 'Alt', 'LT', 'RT', 'PgUp', 'PgDn', 'NL', 'Esc', 'S-Tab', 'Tab', 'Ctrl', 'UP', 'DN', 'More'];
  check('the key bar: the second row, then the main row, seven keys each', JSON.stringify(order) === JSON.stringify(want), order);
  const geo = () => W.page.evaluate(() => { const r = id => document.getElementById(id).getBoundingClientRect(), kb = r('cckb'), dock = r('ccdock'), strip = r('ccstrip'), wrap = r('terminal-wrap'), sc = document.querySelector('.xterm-screen').getBoundingClientRect(), t = /** @type {any} */ (window.term);
    return { kbH: Math.round(kb.height), dockBottom: Math.round(dock.bottom), dockTop: Math.round(dock.top), ih: innerHeight, iw: innerWidth, stripTop: Math.round(strip.top), stripBottom: Math.round(strip.bottom), wrapTop: Math.round(wrap.top), wrapBottom: Math.round(wrap.bottom), scRight: sc.right, cell: t._core._renderService.dimensions.css.cell.width, u: t.unicode.activeVersion, rows: t.rows }; });
  const g = await geo();
  check('one key row (42 px keys), the dock flush with the bottom, the strip at the top', g.kbH < 50 && g.dockBottom === g.ih && g.stripTop === 0, g);
  check('the terminal fills the space between strip and dock and reaches the right edge', g.wrapTop === g.stripBottom && g.wrapBottom === g.dockTop && g.iw - g.scRight <= 20 + g.cell, g);
  await press(W, 'More', 400);
  const g2 = await geo();
  check('the chevron opens the second row: the bar doubles and the terminal is refitted to fewer rows', g2.kbH > 80 && g2.rows < g.rows && g2.wrapBottom === g2.dockTop, [g.rows, g2]);
  await press(W, 'More', 300);
  check('window.term exposes the cell width (mobile-journey reads it) and unicode 11', g.cell > 0 && g.u === '11', [g.cell, g.u]);
  // the keyboard: height shrinks, 120/520 ms debounce, the bar rides above it, the terminal box is refitted
  const before = await W.page.evaluate(() => document.body.style.height);
  await W.page.evaluate(() => { const vv = /** @type {any} */ (window.visualViewport); vv.height = 500; vv.dispatchEvent(new Event('resize')); window.__t0 = performance.now(); });
  await sleep(40);
  const early = await W.page.evaluate(() => document.body.style.height);
  await sleep(400);
  const mid = await W.page.evaluate(() => ({ h: document.body.style.height, kbup: document.body.classList.contains('kbup'), dockBottom: Math.round(document.getElementById('ccdock').getBoundingClientRect().bottom), wrapBottom: Math.round(document.getElementById('terminal-wrap').getBoundingClientRect().bottom), dockTop: Math.round(document.getElementById('ccdock').getBoundingClientRect().top), rows: window.term.rows }));
  check('the viewport handler is debounced (nothing at 40 ms, applied by 200 ms)', before === '' && early === '' && mid.h === '500px' && mid.kbup, [before, early, mid]);
  check('the page is pinned to the visual viewport: the dock ends at its bottom, the terminal refitted above it', mid.dockBottom === 500 && mid.wrapBottom === mid.dockTop && mid.rows < g.rows, mid);
  await W.page.evaluate(() => { const vv = /** @type {any} */ (window.visualViewport); vv.height = innerHeight; vv.dispatchEvent(new Event('resize')); });
  await sleep(700);
  const after = await W.page.evaluate(() => ({ h: document.body.style.height, top: document.body.style.top, kbup: document.body.classList.contains('kbup') }));
  check('when the keyboard goes the inline geometry is released', after.top === '' && after.h === '' && !after.kbup, after);
  // touch scroll -> wheel notches, 14 px each (Playwright builds the TouchEvents: WebKit has no Touch constructor to script)
  await W.page.evaluate(() => { window.__w = []; document.querySelector('.xterm-screen').addEventListener('wheel', e => window.__w.push(e.deltaY)); });
  const pt = y => [{ identifier: 1, clientX: 100, clientY: y }];
  await W.page.dispatchEvent('.xterm-screen', 'touchstart', { touches: pt(400), changedTouches: pt(400) });
  for (let i = 1; i <= 4; i++) await W.page.dispatchEvent('.xterm-screen', 'touchmove', { touches: pt(400 - i * 20), changedTouches: pt(400 - i * 20), cancelable: true });
  await W.page.dispatchEvent('.xterm-screen', 'touchend', { touches: [], changedTouches: pt(320) });
  const wheels = await W.page.evaluate(() => window.__w);
  check('a finger drag becomes wheel notches (80 px = 5 notches of 57)', wheels.length >= 5 && wheels.every(d => d === 57), wheels);
  // standalone geometry: the beacon, and .nozone when the viewport is pinned short in an installed app (not reproducible headless: beacon only)
  await sleep(1000);
  check('the geometry beacon /z?t=term-v8 is sent once', W.beacons.filter(u => u.includes('t=term-v8')).length === 1, W.beacons.filter(u => u.includes('/z?')));
  check('no page errors', W.errors.length === 0, W.errors);
  await shut(W);
  // the chrome does not exist as UI on a desktop pointer: hidden bar, no strip, no composer, no sheet
  const D = await open(URL_A, { phone: false });
  const d = await D.page.evaluate(() => ({ bar: getComputedStyle(document.getElementById('cckb')).display, dock: getComputedStyle(document.getElementById('ccdock')).display, strip: !!document.getElementById('ccstrip'), comp: !!document.getElementById('cccomp'), sheet: !!document.getElementById('ccsheet') }));
  check('desktop: the bar and dock are hidden, no strip, no composer, no sheet', d.bar === 'none' && d.dock === 'none' && !d.strip && !d.comp && !d.sheet, d);
  await shut(D);
}

// ---- ime: the shadow line ------------------------------------------------------------------------------------------------------------------
async function ime() {
  const W = await open();
  const ta = await W.page.evaluate(() => { const t = window.term.textarea; return [t.getAttribute('autocorrect'), t.getAttribute('autocomplete'), t.getAttribute('spellcheck'), t.getAttribute('enterkeyhint')]; });
  check('the textarea is told to autocorrect, autocomplete, spellcheck and show Send', ta.join() === 'on,on,true,send', ta);
  await W.page.evaluate(() => window.term.focus()); await sleep(100);
  const n0 = W.inputs().length;
  await W.page.keyboard.type('ls -l'); await sleep(150);
  // what the pty's line holds after the bytes sent so far (\x7f deletes a character); an engine may rewrite a character it already typed (WebKit swaps
  // a space for a no-break space once a dash follows), which the diff answers with a backspace and the retyped tail
  const line = from => W.inputs().slice(from).join('').split('').reduce((l, c) => (c === '\x7f' ? l.slice(0, -1) : l + c), '');
  const shadow = (await W.page.evaluate(() => window.term.textarea.value)).slice(1); // the field starts with the sentinel space
  check('typing replays the value diff through term.input: the pty line equals the shadow line', line(n0) === shadow.replace(/\u00a0/g, ' ') && shadow.replace(/\u00a0/g, ' ') === 'ls -l', [line(n0), shadow]);
  check('the shadow line keeps the typed line in the textarea (the IME has context)', shadow.length === 5 && (await W.page.evaluate(() => window.term.textarea.value))[0] === ' ', shadow);
  const n1 = W.inputs().length;
  await W.page.keyboard.press('Backspace'); await sleep(100);
  check('a backspace is one \\x7f', W.inputs().slice(n1).join('') === '\x7f', W.inputs().slice(n1));
  const n2 = W.inputs().length;
  await W.page.evaluate(() => { const t = window.term.textarea; t.setSelectionRange(0, t.value.length); }); // a replacement: the IME swaps the word
  await W.page.keyboard.insertText('pwd'); await sleep(100);
  check('replacing the line is \\x7f x old length + the new tail', W.inputs().slice(n2).join('') === '\x7f\x7f\x7f\x7fpwd', bytes(W.inputs().slice(n2).join('')));
  const n3 = W.inputs().length;
  await W.page.keyboard.press('Enter'); await sleep(100);
  check('Enter is a synthetic keydown: one \\r, and the shadow line is cleared to the sentinel', W.inputs().slice(n3).join('') === '\r' && (await W.page.evaluate(() => window.term.textarea.value)) === ' ', W.inputs().slice(n3));
  // Backspace on an empty shadow line at caret 0 deletes into the older terminal text
  const n4 = W.inputs().length;
  await W.page.keyboard.press('Backspace'); await sleep(100);
  check('Backspace on an empty shadow line still deletes (\\x7f)', W.inputs().slice(n4).join('') === '\x7f', W.inputs().slice(n4));
  // a held delete: iOS repeats only while the field has text, so the sentinel is back after every delete and each repeat is one more \x7f
  const n4h = W.inputs().length;
  for (let i = 0; i < 5; i++) await W.page.keyboard.press('Backspace');
  await sleep(100);
  const held = await W.page.evaluate(() => window.term.textarea.value);
  check('a held delete on an empty shadow line: one \\x7f per repeat, the field never empties', W.inputs().slice(n4h).join('') === '\x7f'.repeat(5) && held === ' ', [bytes(W.inputs().slice(n4h).join('')), held]);
  // the caret before the sentinel (iOS can leave it at 0): the first letter lands in front of the space, which must not reach the pty ("s er", 2026-10-16)
  const n4c = W.inputs().length;
  await W.page.evaluate(() => window.term.textarea.setSelectionRange(0, 0));
  await W.page.keyboard.type('ser'); await sleep(100);
  const front = await W.page.evaluate(() => window.term.textarea.value);
  check('typing with the caret before the sentinel sends only the letters', W.inputs().slice(n4c).join('') === 'ser' && front === ' ser', [bytes(W.inputs().slice(n4c).join('')), front]);
  for (let i = 0; i < 3; i++) await W.page.keyboard.press('Backspace');
  await sleep(100);
  if (engine === 'chromium') { // a trusted word delete (iOS speeds a held delete up to whole words), through CDP like the paste below
    const cdp = await W.ctx.newCDPSession(W.page);
    const n4w = W.inputs().length;
    await cdp.send('Input.dispatchKeyEvent', { type: 'rawKeyDown', key: 'Backspace', code: 'Backspace', windowsVirtualKeyCode: 8, commands: ['deleteWordBackward'] }); await sleep(100);
    check('a word delete on an empty shadow line is ^W', W.inputs().slice(n4w).join('') === '\x17' && (await W.page.evaluate(() => window.term.textarea.value)) === ' ', bytes(W.inputs().slice(n4w).join('')));
  } else note('word delete not asserted: this engine cannot raise a trusted deleteWordBackward');
  // leaving the app or hiding the keyboard blurs the textarea and xterm empties it: the shadow line must survive, or the IME's next edit is
  // diffed against '' and the whole typed line is backspaced away in the pty (the "text cleared when I switch apps" bug)
  await W.page.keyboard.type('fix the bug'); await sleep(100);
  await W.page.evaluate(() => window.term.textarea.blur()); await sleep(50);
  const kept = await W.page.evaluate(() => window.term.textarea.value);
  check('a blur keeps the shadow line (xterm\u2019s blur clear is undone)', kept === ' fix the bug', kept);
  const n4b = W.inputs().length;
  await W.page.evaluate(() => window.term.focus()); await sleep(100);
  await W.page.keyboard.type('s'); await sleep(100);
  check('after blur + refocus a keystroke sends only itself, nothing is deleted', W.inputs().slice(n4b).join('') === 's', bytes(W.inputs().slice(n4b).join('')));
  // the bar's \⏎ is term.paste('\n'), and xterm's paste empties the field: the next letter must not backspace the typed line away (2026-10-16)
  const n4n = W.inputs().length;
  await press(W, 'More'); // the line break sits in the second row
  await W.page.click('#cckb > button[data-k="NL"]'); await sleep(100);
  await W.page.keyboard.type('x'); await sleep(100);
  const nl = W.inputs().slice(n4n).join('');
  check('typing after the bar’s line break sends only the letter, no \\x7f', !nl.includes('\x7f') && nl.endsWith('x'), bytes(nl));
  await W.page.keyboard.press('Enter'); await sleep(100);
  const n4s = W.inputs().length; // a hardware keyboard on a tablet: Shift+Enter is a line break, not a submit
  await W.page.keyboard.press('Shift+Enter'); await sleep(100);
  check('phone: Shift+Enter is a line break (\\n), not a submit', W.inputs().slice(n4s).join('') === '\n', bytes(W.inputs().slice(n4s).join('')));
  // a terminal key (Ctrl) falls through to xterm
  const n5 = W.inputs().length;
  await W.page.keyboard.press('Control+C'); await sleep(100);
  check('a Ctrl key falls through to xterm (^C)', W.inputs().slice(n5).join('') === '\x03', bytes(W.inputs().slice(n5).join('')));
  // the swallowed undo
  const undo = await W.page.evaluate(() => { const t = window.term.textarea; const e = new InputEvent('beforeinput', { inputType: 'historyUndo', cancelable: true, bubbles: true }); t.dispatchEvent(e); return e.defaultPrevented; });
  note(`historyUndo is swallowed only for trusted events, which a script cannot raise (untrusted: defaultPrevented=${undo})`);
  // a multiline paste is a bracketed paste (Chromium can raise a trusted one through the clipboard)
  if (engine === 'chromium') {
    await W.ctx.grantPermissions(['clipboard-read', 'clipboard-write']);
    W.out('\x1b[?2004h'); await sleep(60);
    await W.page.evaluate(() => navigator.clipboard.writeText('a\nb'));
    await W.page.evaluate(() => window.term.focus());
    const n6 = W.inputs().length;
    // a trusted insertFromPaste, as a phone's Paste menu raises it: Chromium's editing command, through CDP (the key itself is a plain one)
    const cdp = await W.ctx.newCDPSession(W.page);
    await cdp.send('Input.dispatchKeyEvent', { type: 'rawKeyDown', key: 'a', code: 'KeyA', windowsVirtualKeyCode: 65, commands: ['paste'] }); await sleep(200);
    check('a multiline paste is one bracketed paste, not raw newlines and not twice', W.inputs().slice(n6).join('') === '\x1b[200~a\rb\x1b[201~', bytes(W.inputs().slice(n6).join('')));
    await W.page.evaluate(() => navigator.clipboard.writeText('one line'));
    const n7 = W.inputs().length;
    await cdp.send('Input.dispatchKeyEvent', { type: 'rawKeyDown', key: 'a', code: 'KeyA', windowsVirtualKeyCode: 65, commands: ['paste'] }); await sleep(250);
    check('a single-line paste is sent once (the shadow line does not echo it again)', W.inputs().slice(n7).join('') === '\x1b[200~one line\x1b[201~' && (await W.page.evaluate(() => window.term.textarea.value)) === ' ', [bytes(W.inputs().slice(n7).join('')), await W.page.evaluate(() => window.term.textarea.value)]);
  } else note('multiline paste not asserted: this engine cannot raise a trusted paste event');
  // reconnect kick on return to the foreground (let the focus and repaint timers of the steps above drain first: a resume kicks the reconnect too)
  await sleep(800);
  W.sockets[0].close({ code: 1000 }); await sleep(300);
  check('after close 1000 the socket stays down', W.sockets.length === 1 && (await W.page.locator('#ccovl').textContent()) === 'Press \u23ce to Reconnect', [W.sockets.length, await W.page.locator('#ccovl').textContent()]);
  await W.page.evaluate(() => window.dispatchEvent(new Event('pageshow')));
  for (let i = 0; i < 50 && W.sockets.length < 2; i++) await sleep(50);
  check('pageshow kicks the reconnect (fresh token, new socket)', W.sockets.length === 2 && W.tokens === 2, [W.sockets.length, W.tokens]);
  const w2 = W.sockets.length;
  await W.page.evaluate(() => document.dispatchEvent(new Event('visibilitychange'))); await sleep(2000);
  check('a kick on a live socket does nothing', W.sockets.length === w2);
  check('no page errors', W.errors.length === 0, W.errors);
  await shut(W);
  const O = await open(URL_A + '&ime=off');
  const off = await O.page.evaluate(() => window.term.textarea.getAttribute('autocorrect'));
  await O.page.evaluate(() => window.term.focus());
  const m0 = O.inputs().length;
  await O.page.keyboard.press('Enter'); await sleep(100);
  check('?ime=off: nothing is intercepted, the textarea keeps xterm\u2019s own flags', off === 'off', off);
  void m0;
  await shut(O);
}

// ---- clipboard -----------------------------------------------------------------------------------------------------------------------------
async function clipboard() {
  const W = await open(URL_A, { perms: true });
  const b64 = s => Buffer.from(s).toString('base64');
  const readClip = () => W.page.evaluate(() => navigator.clipboard.readText().catch(e => 'ERR ' + e.name));
  if (engine === 'chromium') {
    W.out(`\x1b]52;c;${b64('copied \u20ac text')}\x07`); await sleep(300);
    check('OSC 52 (BEL-terminated) lands in navigator.clipboard, UTF-8 intact', (await readClip()) === 'copied \u20ac text', await readClip());
    W.out(`\x1b]52;c;${b64('second')}\x1b\\`); await sleep(300);
    check('OSC 52 with the ST terminator works too', (await readClip()) === 'second', await readClip());
    W.out('\x1b]52;c;?\x07'); await sleep(150);
    check('an OSC 52 query changes nothing', (await readClip()) === 'second');
    check('the toast says what was copied', (await W.page.locator('#cctoast').textContent()).startsWith('copied'));
  } else note('OSC 52 to the system clipboard is asserted on chromium only: WebKit does not grant clipboard permissions to a script');
  // pending until a gesture: the browser refuses a write, the next keydown flushes it
  const P = await open(URL_A, { perms: true, init: () => { const w = navigator.clipboard.writeText.bind(navigator.clipboard); window.__refuse = true; window.__w = []; navigator.clipboard.writeText = t => { window.__w.push(t); return window.__refuse ? Promise.reject(new DOMException('no gesture', 'NotAllowedError')) : w(t); }; } });
  P.out(`\x1b]52;c;${b64('held back')}\x07`); await sleep(200);
  const toast = await P.page.locator('#cctoast').textContent();
  await P.page.evaluate(() => { window.__refuse = false; });
  await P.page.keyboard.press('a'); await sleep(200);
  const wrote = await P.page.evaluate(() => window.__w);
  check('a refused write is held and retried on the next keydown', /blocked/.test(toast) && wrote.length === 2 && wrote[1] === 'held back', [toast, wrote]);
  await shut(P);
  // copy-on-select: a drag over text copies it
  if (engine === 'chromium') {
    const D = await open(URL_A, { phone: false, perms: true });
    D.out('SELECTME SELECTME SELECTME\r\n'); await sleep(200);
    const r = await D.page.evaluate(() => { const b = document.querySelector('.xterm-screen').getBoundingClientRect(); return { x: b.left, y: b.top }; });
    await D.page.mouse.move(r.x + 8, r.y + 8); await D.page.mouse.down(); await D.page.mouse.move(r.x + 120, r.y + 8, { steps: 6 }); await D.page.mouse.up(); await sleep(300);
    const c = await D.page.evaluate(() => navigator.clipboard.readText().catch(e => 'ERR ' + e.name));
    check('a drag selection is copied (copy on select)', /ELECT/.test(c), c);
    await shut(D);
  }
  // the overlay: wrapped rows re-joined
  const cols = await W.page.evaluate(() => window.term.cols);
  const long = 'x'.repeat(cols * 2 + 5);
  W.out(`${long}\r\nlast line\r\n`); await sleep(200);
  await menuRow(W, 'Copy text'); await sleep(100);
  const ov = await W.page.evaluate(() => ({ on: document.getElementById('ccclip').classList.contains('on'), text: document.getElementById('ccclip-txt').textContent }));
  check('Copy text opens the overlay with the screen text, wrapped rows re-joined into one line', ov.on && ov.text.split('\n').includes(long) && ov.text.includes('last line'), [ov.on, ov.text.length, cols]);
  await W.page.locator('#ccclip-x').click(); await sleep(50);
  check('close hides the overlay', !(await W.page.evaluate(() => document.getElementById('ccclip').classList.contains('on'))));
  if (engine === 'chromium') {
    await W.page.evaluate(() => navigator.clipboard.writeText('pasted from device'));
    const n = W.inputs().length;
    await menuRow(W, 'Paste'); await sleep(250);
    check('Paste pastes the device clipboard into the terminal', W.inputs().slice(n).join('') === 'pasted from device', W.inputs().slice(n));
  }
  await shut(W);
  const O = await open(URL_A + '&clip=off');
  const keys = await O.page.evaluate(() => [...document.querySelectorAll('#ccsheet .tile')].map(b => b.textContent));
  check('?clip=off removes Copy text and Paste from the menu, Attach file stays', JSON.stringify(keys) === '["Attach file"]' && !(await O.page.evaluate(() => !!document.getElementById('ccclip'))), keys);
  check('no page errors', W.errors.length === 0 && O.errors.length === 0, [...W.errors, ...O.errors]);
  await shut(O);
}

// ---- sheet: the strip (sessions + state), the menu sheet, attach, the back key -------------------------------------------------------------
async function sheet() {
  const W = await open();
  const tabs = P => P.page.$$eval('#cctabs .tab[data-s]', t => t.map(x => ({ s: x.dataset.s, on: x.getAttribute('aria-current') === 'true', cls: x.className, txt: x.textContent })));
  await W.page.waitForFunction(() => document.querySelectorAll('#cctabs .tab[data-s]').length === 2);
  const t0 = await tabs(W);
  check('the strip: one tab per live session, the current one marked, labels win over names', t0.length === 2 && t0[0].on && t0[0].s === A && /\bs-working\b/.test(t0[0].cls) && /second/.test(t0[1].txt), t0);
  check('a session that needs you says so in amber even when not current; the current one says its state', /needs you/.test(t0[1].txt) && /\bs-needs-you\b/.test(t0[1].cls) && /working/.test(t0[0].txt), t0);
  check('the list is fetched with this tab id', W.beacons.some(u => u.includes(`/app/live.json?tab=${TAB}`)), W.beacons);
  await W.page.locator('#cctabs .tab', { hasText: 'second' }).click();
  await W.page.waitForFunction(b => document.querySelector(`#cctabs .tab[data-s="${b}"]`)?.getAttribute('aria-current') === 'true', B);
  check('a tab POSTs /a/switch (tab, to) and the strip changes in place', W.posts.length === 1 && W.posts[0].url.endsWith('/a/switch') && new URLSearchParams(W.posts[0].body).get('tab') === TAB && new URLSearchParams(W.posts[0].body).get('to') === B && W.page.url().endsWith(URL_A), W.posts[0]);
  // a refused switch: one reload into attach, same tab id
  W.switchStatus = 409;
  await Promise.all([W.page.waitForURL(u => u.pathname === '/term/' && u.search === `?arg=attach&arg=${A}&arg=${TAB}&v=3`, { timeout: 8000 }), W.page.locator(`#cctabs .tab[data-s="${A}"]`).click()])
    .then(() => check('a refused switch reloads once into attach with the same tab id', true), e => check('a refused switch reloads once into attach with the same tab id', false, String(e).split('\n')[0]));
  await shut(W);

  const M = await open('/term/?v=3');
  await M.page.waitForSelector('#cctabs .tab[data-s]');
  await Promise.all([M.page.waitForURL(u => /^\?arg=attach&arg=wt-b&arg=[0-9a-f]{8}&v=3$/.test(u.search), { timeout: 8000 }), M.page.locator('#cctabs .tab', { hasText: 'second' }).click()])
    .then(() => check('no tab id: choosing a session reloads into attach with a minted tab id', true), e => check('no tab id: choosing a session reloads into attach with a minted tab id', false, String(e).split('\n')[0]));
  await shut(M);

  const E = await open(URL_A, { live: [] });
  await sleep(300);
  const et = await tabs(E);
  check('no live sessions listed: the strip still shows this session, and the new-session tab', et.length === 1 && et[0].s === A && (await E.page.locator('#cctabs .tab.new').count()) === 1, et);
  await E.page.locator('#ccmenu-btn').click();
  await E.page.waitForSelector('#ccsheet.open .pan');
  const sh = await E.page.evaluate(() => { const pan = document.querySelector('#ccsheet .pan').getBoundingClientRect(); return { bottom: Math.round(pan.bottom), ih: innerHeight, h: pan.height, head: document.querySelector('#ccsheet .hd').textContent, tiles: [...document.querySelectorAll('#ccsheet .tile')].map(t => t.textContent), rows: [...document.querySelectorAll('#ccsheet .ln')].map(r => r.textContent.trim()), rowH: Math.min(...[...document.querySelectorAll('#ccsheet .ln')].map(r => r.getBoundingClientRect().height)) }; });
  check('⋯ opens the menu sheet at the bottom, at most 80 % tall, rows at least 52 px', sh.bottom === sh.ih && sh.h <= sh.ih * 0.8 + 1 && sh.rowH >= 52, sh);
  check('the menu: the session, Copy text / Paste / Attach file, text size, theme, detach, restart, all sessions', sh.head.includes(A) && JSON.stringify(sh.tiles) === '["Copy text","Paste","Attach file"]' && /^Text size/.test(sh.rows[0]) && /^Theme/.test(sh.rows[1]) && /^Detach from tmux/.test(sh.rows[2]) && /^Restart this pane/.test(sh.rows[3]) && /^All sessions/.test(sh.rows[4]), sh);
  // restart takes two taps; the first only arms it
  const n0 = E.inputs().length;
  await E.page.locator('#ccsheet .ln', { hasText: 'Restart this pane' }).click(); await sleep(100);
  check('restart: the first tap arms it and sends nothing', E.inputs().length === n0 && /Tap again/.test(await E.page.locator('#ccsheet .ln.danger').textContent()));
  await E.page.locator('#ccsheet .ln.danger').click(); await sleep(600);
  check('restart: the second tap sends C-q, then :respawn-pane -k and Enter, staged', E.inputs().slice(n0).join('|') === '\x11|:|respawn-pane -k|\r', E.inputs().slice(n0));
  await E.page.locator('#ccmenu-btn').click(); await E.page.waitForSelector('#ccsheet.open .pan');
  await Promise.all([E.page.waitForURL(u => u.pathname === '/', { timeout: 8000 }), E.page.locator('#ccsheet .ln', { hasText: 'All sessions' }).click()])
    .then(() => check('"All sessions" navigates to /', true), e => check('"All sessions" navigates to /', false, String(e).split('\n')[0]));
  await shut(E);

  // motion: the slide is wired (transform + allow-discrete) and the backdrop closes it
  const T = await open(URL_A, { motion: true });
  const tp = await T.page.$eval('#ccsheet .pan', e => getComputedStyle(e).transitionProperty);
  check('motion on: the pan slide transition is wired', /transform/.test(tp), tp);
  await T.page.locator('#ccmenu-btn').click(); await T.page.waitForSelector('#ccsheet.open .pan');
  check('motion on: the sheet settles flush with the bottom edge', await T.page.waitForFunction(() => Math.abs(document.querySelector('#ccsheet .pan').getBoundingClientRect().bottom - innerHeight) < 1, null, { timeout: 1500 }).then(() => true, () => false));
  await T.page.mouse.click(10, 10);
  check('motion on: a backdrop tap closes it, display returns to none', await T.page.waitForFunction(() => getComputedStyle(document.getElementById('ccsheet')).display === 'none', null, { timeout: 2000 }).then(() => true, () => false));
  await shut(T);

  // attach: the menu tile, a pasted file, a dropped file all POST /shot with x-name and paste the returned path
  const F = await open();
  await F.page.setInputFiles('input[type=file]', { name: 'my shot.png', mimeType: 'image/png', buffer: Buffer.from('PNGDATA') }); await sleep(300);
  const p0 = F.posts[0];
  check('Attach file: POST /shot with the file bytes, content-type and x-name', p0 && p0.url.endsWith('/shot') && (p0.body ? p0.body.toString() === 'PNGDATA' : (p0.headers['content-length'] || '7') === '7') && // WebKit hands a route no body (and no length) for a File
     p0.headers['content-type'] === 'image/png' && decodeURIComponent(p0.headers['x-name']) === 'my shot.png', p0 && p0.headers);
  check('the reply path is pasted into the terminal, followed by a space', F.inputs().includes('/tmp/shot-1.png '), F.inputs());
  await F.page.evaluate(() => { const dt = new DataTransfer(); dt.items.add(new File(['x'], 'notes.md', { type: 'text/markdown' })); document.dispatchEvent(new DragEvent('drop', { dataTransfer: dt, bubbles: true, cancelable: true })); }); await sleep(300);
  check('a dropped file of any type goes up with its own name', F.posts.length === 2 && decodeURIComponent(F.posts[1].headers['x-name']) === 'notes.md' && F.posts[1].headers['content-type'] === 'text/markdown', F.posts[1] && F.posts[1].headers);
  const pr = await F.page.evaluate(() => { const dt = new DataTransfer(); dt.items.add(new File(['y'], 'p.png', { type: 'image/png' })); const e = new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true }); document.body.dispatchEvent(e); return e.defaultPrevented; }); await sleep(300);
  check('a pasted file is intercepted and uploaded', pr && F.posts.length === 3 && decodeURIComponent(F.posts[2].headers['x-name']) === 'p.png', [pr, F.posts.length]);
  // the back key: a plain navigation
  await Promise.all([F.page.waitForURL(u => u.pathname === '/', { timeout: 8000 }), F.page.locator('#ccback').dispatchEvent('pointerdown')])
    .then(() => check('‹ navigates to /', true), e => check('‹ navigates to /', false, String(e).split('\n')[0]));
  check('no page errors', W.errors.length === 0 && E.errors.length === 0 && T.errors.length === 0, [...W.errors, ...E.errors, ...T.errors]);
  await shut(F);
}

// ---- composer: Claude's own input box is hidden and the field stands in for it -----------------------------------------------------------
// The screens are the shapes captured from live panes 2026-10-23 (claudebox.mjs; its unit cases are in scripts/term-proto-check.mjs).
async function composer() {
  const W = await open();
  const size = () => W.page.evaluate(() => ({ cols: window.term.cols, rows: window.term.rows }));
  const R = '─'.repeat((await size()).cols);
  // the grid is read at each draw: a growing field or the second key row refits the terminal
  const draw = async tail => { const { rows } = await size(); const body = ['● Done. The watcher skips a session you type in.', '']; const all = [...body, ...tail]; const ls = [...Array(Math.max(0, rows - all.length)).fill(''), ...all].slice(-rows);
    W.out('\x1b[H\x1b[2J' + ls.map((l, i) => `\x1b[${i + 1};1H` + l).join('')); };
  const st = () => W.page.evaluate(() => ({ shown: !document.getElementById('cccomp').hidden, tf: document.getElementById('terminal-container').style.transform, claude: document.body.classList.contains('ccclaude'), ph: document.getElementById('ccmsg').placeholder, mode: document.getElementById('ccmode').hidden ? null : document.getElementById('ccmode').textContent,
    // the top rule of the box must sit at or below the wrap's bottom edge
    ruleY: (() => { const b = window.term.buffer.active; for (let i = 0; i < window.term.rows; i++) if (/^─{8,}$/.test(b.getLine(b.viewportY + i).translateToString(true))) { const sc = document.querySelector('.xterm-screen').getBoundingClientRect(); return Math.round(sc.top + i * sc.height / window.term.rows); } return -1; })(),
    wrapBottom: Math.round(document.getElementById('terminal-wrap').getBoundingClientRect().bottom) }));
  // the screen is read 30 ms after a write and a shown/hidden field refits the terminal: wait for the state, up to a second
  const settle = async f => { let s; for (let i = 0; i < 20; i++) { s = await st(); if (f(s)) return s; await sleep(50); } return s; };
  check('a shell: nothing hidden and no field (the terminal is the one input)', ((s) => !s.tf && !s.claude && !s.shown)(await st()), await st());
  await draw([R, '❯ ', R, '  🤖 Opus 5.5 (high) | $5.26 session', '  ⏵⏵ accept edits on (shift+tab to cycle)', '[wt-a] 0:claude*']);
  const s1 = await settle(x => x.claude && x.ruleY >= x.wrapBottom);
  check('Claude with an empty box: the terminal is shifted so the box sits under the dock', s1.claude && /translateY\(\d+px\)/.test(s1.tf) && s1.ruleY >= s1.wrapBottom, s1);
  check('the field shows, reads "Message Claude…" and the chip shows the mode', s1.shown && s1.ph === 'Message Claude…' && s1.mode === '⏵⏵ accept edits', s1);
  // Claude's suggestion of the last prompt sits in the box, grey, dim, its cursor inverse (the 2026-10-23 phone screen): not a draft, still hidden
  await draw(['  - quotes "Do you want to" in the conversation', '', R, '\x1b[38;5;246m❯ \x1b[7mi\x1b[27m\x1b[2mt\'s all merged?\x1b[0m', R, '  ⏵⏵ auto mode on · 2 shells', '[wt-a] 0:claude*']);
  const sg = await settle(x => x.mode === '⏵⏵ auto mode');
  check('a dimmed suggestion in the box is not a draft, and "Do you want to" above the box is only words: still hidden', sg.claude && /translateY/.test(sg.tf) && sg.mode === '⏵⏵ auto mode', sg);
  await draw([R, '❯ ', R, '  ⏵⏵ accept edits on (shift+tab to cycle)', '[wt-a] 0:claude*']); await sleep(200);
  // send: a bracketed paste (the app asked for it), then \r on its own
  W.out('\x1b[?2004h'); await sleep(50);
  let n = W.inputs().length;
  await W.page.fill('#ccmsg', 'add a probe for the composer');
  await W.page.press('#ccmsg', 'Enter'); await sleep(200);
  check('return sends the text as one bracketed paste, then \\r', W.inputs().slice(n).join('|') === '\x1b[200~add a probe for the composer\x1b[201~|\r' && (await W.page.inputValue('#ccmsg')) === '', bytes(W.inputs().slice(n)));
  n = W.inputs().length;
  await W.page.fill('#ccmsg', 'line one'); await W.page.press('#ccmsg', 'Shift+Enter'); await W.page.type('#ccmsg', 'line two'); await W.page.locator('#ccsend').click(); await sleep(200);
  check('shift+return breaks the line inside the one paste; the send button sends', W.inputs().slice(n).join('|') === '\x1b[200~line one\rline two\x1b[201~|\r', bytes(W.inputs().slice(n)));
  n = W.inputs().length; await W.page.press('#ccmsg', 'Enter'); await sleep(100);
  check('an empty field sends nothing while Claude\'s box is hidden (no Enter into rows the user cannot see)', W.inputs().length === n, bytes(W.inputs().slice(n)));
  n = W.inputs().length; await W.page.locator('#ccmode').click(); await sleep(100);
  check('the mode chip sends shift+tab', W.inputs().slice(n).join('') === '\x1b[Z', bytes(W.inputs().slice(n)));
  // a latched ctrl turns the next character typed in the field into a key
  await press(W, 'Ctrl'); n = W.inputs().length; await W.page.focus('#ccmsg'); await W.page.keyboard.type('o'); await sleep(100);
  check('ctrl, then o typed in the field: ^O goes to the terminal, the field stays empty', W.inputs().slice(n).join('') === '\x0f' && (await W.page.inputValue('#ccmsg')) === '', [bytes(W.inputs().slice(n)), await W.page.inputValue('#ccmsg')]);
  // the keyboard belongs to the field while the box is hidden
  await W.page.evaluate(() => document.activeElement?.blur()); await W.page.evaluate(() => window.term.focus()); await sleep(50);
  check('a tap on the terminal brings the focus to the field', await W.page.evaluate(() => document.activeElement?.id === 'ccmsg'));
  // attach while the box is hidden: the path goes into the field, not into Claude's box (which would bring it back: two inputs)
  let n1 = W.inputs().length;
  await W.page.setInputFiles('input[type=file]', { name: 'IMG_8150.png', mimeType: 'image/png', buffer: Buffer.from('PNG') }); await sleep(300);
  check('attach with the box hidden: the path lands in the field, nothing reaches the terminal', (await W.page.inputValue('#ccmsg')) === '/tmp/shot-1.png ' && W.inputs().length === n1, [await W.page.inputValue('#ccmsg'), W.inputs().slice(n1)]);
  await W.page.fill('#ccmsg', '');
  // a draft in Claude's own box: shown as it is, and the field goes: one input
  await draw([R, '\u276f\u00a0typed straight into the terminal', R, '  \u23f8 plan mode on (shift+tab to cycle)', '[wt-a] 0:claude*']);
  const s2 = await settle(x => !x.shown);
  check('a box holding a draft is not hidden and the field hides (one input)', !s2.tf && !s2.claude && !s2.shown && s2.ruleY < s2.wrapBottom, s2);
  await W.page.evaluate(() => document.activeElement?.blur()); await W.page.evaluate(() => window.term.focus()); await sleep(50);
  check('with the box shown, a tap on the terminal types into the terminal', await W.page.evaluate(() => document.activeElement === window.term.textarea));
  n1 = W.inputs().length;
  await W.page.setInputFiles('input[type=file]', { name: 'b.png', mimeType: 'image/png', buffer: Buffer.from('PNG') }); await sleep(300);
  check('attach with the field hidden: the path goes to the terminal as before (a bracketed paste: the app asked for it)', W.inputs().slice(n1).join('') === '\x1b[200~/tmp/shot-1.png \x1b[201~', W.inputs().slice(n1));
  // output that draws a fake empty box above a real permission dialog: the dialog wins, nothing is hidden
  await draw(['cat notes.md', R, '\u276f\u00a0', R, '', ' Do you want to proceed?', ' \u276f 1. Yes', '   2. No, and tell Claude what to do', '', ' Esc to cancel']); 
  const sf = await settle(x => x.shown);
  check('a box drawn above a real permission dialog hides nothing (fails closed)', !sf.tf && !sf.claude && sf.shown && sf.ph === 'Type 1–2 to choose…', sf);
  // a permission dialog: nothing hidden, a digit picks with no Enter after it
  await draw(['● Bash(git push origin feat/x)', '', ' Do you want to proceed?', ' ❯ 1. Yes', '   2. Yes, and don\'t ask again for git push', '   3. No, and tell Claude what to do', '', ' Esc to cancel', '[wt-a] 0:claude*']); 
  const s3 = await settle(x => x.ph === 'Type 1–3 to choose…');
  check('a permission dialog: nothing hidden, the field asks for 1–3, no chip', s3.shown && !s3.tf && s3.ph === 'Type 1–3 to choose…' && s3.mode === null, s3);
  n = W.inputs().length; await W.page.fill('#ccmsg', '2'); await W.page.press('#ccmsg', 'Enter'); await sleep(200);
  check('a digit is sent alone: no paste, no Enter after it', W.inputs().slice(n).join('|') === '2', bytes(W.inputs().slice(n)));
  check('no page errors', W.errors.length === 0, W.errors);
  await shut(W);
  const O = await open(URL_A + '&comp=off');
  check('?comp=off: no composer, the key bar stays', await O.page.evaluate(() => !document.getElementById('cccomp') && !!document.getElementById('cckb')));
  await shut(O);
}

// ---- paint: repaint on foreground, resize coalescing, the boot ladder, the beacons --------------------------------------------------------
async function paint() {
  const spy = () => { window.__refresh = []; const r = window.term.refresh.bind(window.term); window.term.refresh = (a, b) => { window.__refresh.push([a, b]); return r(a, b); }; };
  const W = await open(URL_A, { clock: true });
  await W.page.evaluate(spy);
  await W.page.clock.runFor(1500); await sleep(200); // let the engine's own load-time focus and visibility events settle
  const rows = await W.page.evaluate(() => window.term.rows);
  for (const [ev, target] of [['visibilitychange', 'document'], ['pageshow', 'window'], ['focus', 'window']]) {
    await W.page.evaluate(() => { window.__refresh = []; });
    await W.page.evaluate(([e, t]) => (t === 'document' ? document : window).dispatchEvent(new Event(e)), [ev, target]);
    await W.page.clock.runFor(500);
    const r = await W.page.evaluate(() => window.__refresh);
    check(`${ev}: term.refresh(0, rows - 1) at once and once more 300 ms later`, r.length === 2 && r.every(x => x[0] === 0 && x[1] === rows - 1), r);
  }
  // first content: the empty -> content transition repaints, and once more a second later
  await W.page.evaluate(() => { window.__refresh = []; });
  W.out('first frame\r\n'); await sleep(300); await W.page.clock.runFor(1100);
  check('the first content repaints at once and again after 1 s', (await W.page.evaluate(() => window.__refresh.length)) === 2, await W.page.evaluate(() => window.__refresh));
  // beacons: boot stages go to /z?t=termdiag
  const ev = new Set(W.beacons.filter(u => u.includes('t=termdiag')).map(u => new URL(u).searchParams.get('e')));
  check('termdiag beacons: ws-new, ws-open, ws-first-msg', ['ws-new', 'ws-open', 'ws-first-msg'].every(e => ev.has(e)), [...ev]);
  check('no page errors', W.errors.length === 0, W.errors);
  await shut(W);

  // resize bursts are one pty resize, 150 ms after the last (a desktop pointer: the phone's keyboard handler has its own debounce)
  const R = await open(URL_A, { clock: true, phone: false });
  await freeze(R);
  const r0 = R.frames('1').length;
  for (const h of [700, 650, 600]) await R.page.setViewportSize({ width: 1280, height: h });
  await sleep(150); // the engine delivers its resize events; the fake clock is paused, so the coalescing timer has not run
  check('a resize burst sends nothing until the 150 ms timer runs', R.frames('1').length === r0, R.frames('1').slice(r0));
  await R.page.clock.runFor(400); await sleep(200);
  const rz = R.frames('1').slice(r0), d = await R.page.evaluate(() => ({ cols: window.term.cols, rows: window.term.rows }));
  check('and then exactly one resize, to the final grid', rz.length === 1 && JSON.parse(rz[0]).rows === d.rows && JSON.parse(rz[0]).columns === d.cols, [rz, d]);
  await shut(R);

  // the boot ladder on an empty screen: 4 s repaint, 8 s kick, 15 s reload (at most 2 per tab)
  const logs = [];
  const L = await open(URL_A + '&paintdbg=1', { clock: true });
  L.page.on('console', m => logs.push(m.text()));
  await freeze(L);
  const at = await L.page.evaluate(() => Math.round(performance.now())); // fake ms since the page started
  await L.page.clock.runFor(Math.max(0, 3000 - at));
  check('boot ladder: nothing before 4 s', !logs.some(l => /buffer empty/.test(l)), [at, logs]);
  await L.page.clock.runFor(1500); await sleep(100);
  check('boot ladder, 4 s: the empty buffer is repainted', logs.some(l => /buffer empty at 4000 ms, rung 0/.test(l)) && logs.some(l => /repaint \d+ settle-empty/.test(l)), logs);
  L.sockets[0].close({ code: 1000 }); await sleep(200);
  await L.page.clock.runFor(3600); await sleep(300);
  for (let i = 0; i < 20 && L.sockets.length < 2; i++) { await sleep(50); await L.page.clock.runFor(50); }
  check('boot ladder, 8 s: the kick reconnects a dead socket', L.sockets.length === 2 && logs.some(l => /rung 1/.test(l)), [L.sockets.length, logs]);
  const nav = L.page.waitForNavigation({ timeout: 8000 }).then(() => true, () => false);
  await L.page.clock.runFor(8000);
  check('boot ladder, 15 s: one reload, counted in sessionStorage', (await nav) && (await L.page.evaluate(() => sessionStorage.getItem('ccpaint-r'))) === '1', await L.page.evaluate(() => sessionStorage.getItem('ccpaint-r')));
  await shut(L);

  const O = await open(URL_A + '&paint=off', { clock: true });
  await O.page.evaluate(spy);
  await O.page.evaluate(() => document.dispatchEvent(new Event('visibilitychange')));
  await O.page.clock.runFor(500);
  check('?paint=off: no repaint on visibilitychange', (await O.page.evaluate(() => window.__refresh.length)) === 0);
  await shut(O);
}

// ---- theme: themes.json -> [data-theme] CSS -> term.options.theme ---------------------------------------------------------------------------
async function theme() {
  const q = (W, f, arg) => W.page.evaluate(f, arg);
  const colours = n => { const t = THEMES[n]; return { background: t.background, foreground: t.foreground, brightMagenta: t.brightMagenta, selectionBackground: t.selectionBackground.length === 7 ? t.selectionBackground + '80' : t.selectionBackground }; };
  const read = W => q(W, () => { const t = window.term.options.theme, m = document.querySelector('meta[name="theme-color"]'); return { background: t.background, foreground: t.foreground, brightMagenta: t.brightMagenta, selectionBackground: t.selectionBackground, body: document.body.style.background, meta: m && m.content, attr: document.documentElement.dataset.theme || '' }; });
  const same = (got, n) => Object.entries(colours(n)).every(([k, v]) => got[k].toLowerCase() === v.toLowerCase());

  const D = await open(URL_A, { phone: false });
  const d = await read(D);
  check('no stored choice and no global theme: the default (no data-theme)', d.attr === '' && d.background.toLowerCase() === '#2b2b2b', d);
  const blocks = await q(D, () => [...document.styleSheets].flatMap(s => [...s.cssRules]).map(r => /** @type {any} */ (r).selectorText).filter(t => t && t.includes('data-theme')));
  check('the page stylesheet carries one [data-theme] block per theme of themes.json', blocks.length === Object.keys(THEMES).length, blocks);
  for (const n of Object.keys(THEMES)) {
    await q(D, name => window.cctheme(name), n);
    const got = await read(D);
    if (!same(got, n) || got.attr !== n) check(`theme ${n} applies its 20 keys`, false, [got, colours(n)]);
    const all = await q(D, () => { const t = window.term.options.theme; return Object.keys(t).length; });
    if (all !== 20) check(`theme ${n} has 20 keys`, false, all);
  }
  check('all 12 themes apply: background, foreground, brightMagenta and the selection (+80 alpha) match themes.json', true);
  await q(D, () => window.cctheme('Nord'));
  const nord = await read(D);
  check('body background and <meta theme-color> follow the theme', nord.body !== '' && nord.meta.toLowerCase() === THEMES.Nord.background.toLowerCase(), nord);
  check('the choice is stored per browser', (await q(D, () => localStorage.cctheme)) === 'Nord');
  await q(D, () => window.cctheme('default'));
  check('an unknown name (default) clears the choice', (await q(D, () => localStorage.cctheme)) == null && (await read(D)).attr === '');
  await shut(D);
  // a phone: the strip and dock are the shell's chrome, so a dark theme takes the shell's black (one canvas); a light theme keeps its paper
  const Ph = await open();
  await q(Ph, () => window.cctheme('Nord'));
  const pn = await read(Ph);
  check('a phone: a dark theme (Nord) paints on the shell black, its other colours intact', pn.background.toLowerCase() === '#09090b' && pn.foreground.toLowerCase() === THEMES.Nord.foreground.toLowerCase() && pn.meta.toLowerCase() === '#09090b', pn);
  const light = Object.keys(THEMES).find(n => { const h = parseInt(THEMES[n].background.slice(1, 7), 16); return (h >> 16 & 255) * .299 + (h >> 8 & 255) * .587 + (h & 255) * .114 >= 128; });
  if (light) { await q(Ph, n => window.cctheme(n), light); check(`a phone: a light theme (${light}) keeps its own background`, (await read(Ph)).background.toLowerCase() === THEMES[light].background.toLowerCase()); }
  await q(Ph, () => window.cctheme(''));
  const D2 = Ph;
  // the picker, in the menu sheet
  await D2.page.locator('#ccmenu-btn').click(); await D2.page.waitForSelector('#ccsheet.open #ccthemesel');
  await D2.page.locator('#ccthemesel').selectOption('Catppuccin Mocha');
  check('the picker in the menu applies and stores a theme', (await read(D2)).foreground.toLowerCase() === THEMES['Catppuccin Mocha'].foreground.toLowerCase() && (await q(D2, () => localStorage.cctheme)) === 'Catppuccin Mocha');
  await D2.page.locator('#ccthemesel').selectOption('Default');
  check('"Auto (global)" in the picker clears the choice', (await q(D2, () => localStorage.cctheme)) == null);
  const opts = await q(D2, () => [...document.querySelectorAll('#ccthemesel option')].map(o => o.textContent));
  check('the picker lists Auto and the 12 themes', opts.length === 13 && opts[0] === 'Auto (global)' && Object.keys(THEMES).every(n => opts.includes(n)), opts);
  await shut(D2);

  // ?theme=<Name> saves it; precedence local > global > default; the global theme is polled every 30 s
  const U = await open(URL_A + '&theme=Nord', { phone: false });
  check('?theme=<Name> saves and applies the theme', same(await read(U), 'Nord') && (await q(U, () => localStorage.cctheme)) === 'Nord');
  await shut(U);
  const G = await open(URL_A + '&paint=off', { phone: false, clock: true, theme: { name: 'GitHub Dark' } }); // paint=off: the boot ladder would reload the empty page at 15 s
  await sleep(300);
  check('a global theme applies when no local choice exists', same(await read(G), 'GitHub Dark'), await read(G));
  await q(G, () => window.cctheme('Material'));
  check('a local choice beats the global one', same(await read(G), 'Material'));
  await q(G, () => window.cctheme(''));
  check('clearing the local choice falls back to the global theme', same(await read(G), 'GitHub Dark'));
  await freeze(G);
  const gat = await G.page.evaluate(() => Math.round(performance.now()));
  G.theme = { name: 'Rose Pine' };
  await G.page.clock.runFor(Math.max(0, 29000 - gat)); await sleep(200);
  check('the global theme is not re-read before 30 s', same(await read(G), 'GitHub Dark'), [gat, G.polls, await read(G)]);
  await G.page.clock.runFor(2500); await sleep(400);
  check('the global theme is polled every 30 s', same(await read(G), 'Rose Pine'), await read(G));
  await shut(G);
  const O = await open(URL_A + '&theme=off');
  check('?theme=off: no picker, no theming', (await q(O, () => !document.getElementById('ccthemesel') && !document.documentElement.dataset.theme && typeof window.cctheme === 'undefined')));
  await shut(O);
  check('no page errors', D.errors.length + D2.errors.length + U.errors.length + G.errors.length + O.errors.length === 0, [...D.errors, ...D2.errors, ...U.errors, ...G.errors, ...O.errors]);
}

// ---- framed: inside an iframe the grid chords go to the parent as grid-key and never reach the pty; unframed, nothing is posted ----------
async function framed() {
  const W = await open(URL_A, { phone: false });
  await W.page.evaluate(() => { window.__got = []; addEventListener('message', e => window.__got.push(e.data)); });
  await W.page.locator('.xterm-helper-textarea').focus();
  await W.page.keyboard.press('Control+Shift+Digit2');
  await sleep(100);
  check('unframed: Ctrl+Shift+2 posts nothing and reaches the pty as before (NUL)', (await W.page.evaluate(() => window.__got.length)) === 0 && W.inputs().at(-1) === '\x00', W.inputs());
  const e0 = W.inputs().length;
  await W.page.keyboard.press('Shift+Enter'); await sleep(100);
  const e1 = W.inputs().length;
  await W.page.keyboard.press('Enter'); await sleep(100);
  check('Shift+Enter is a line break (\\n, as Ctrl+J), only once; Enter is still \\r', W.inputs().slice(e0, e1).join('') === '\n' && W.inputs().slice(e1).join('') === '\r', bytes(W.inputs().slice(e0).join('')));
  await W.ctx.route('**/grid-host', r => r.fulfill({ contentType: 'text/html', body: `<!doctype html><title>host</title><script>window.__got = []; addEventListener('message', e => window.__got.push(e.data));</script><iframe id="f" src="${URL_A}" style="width:900px;height:600px"></iframe>` }));
  const page = await W.ctx.newPage();
  page.on('pageerror', e => W.errors.push(String(e)));
  await page.goto(DASH + '/grid-host');
  const frame = page.frames().find(f => f.url().includes('/term/'));
  await frame.waitForFunction(() => /** @type {any} */ (window).term);
  await frame.locator('.xterm-helper-textarea').focus();
  await frame.evaluate(() => postMessage({ t: 'grid-mod', mod: 'win' }, location.origin)); // what the shell sends to a pane; same origin, so the frame can send it to itself
  const n0 = W.inputs().length;
  await page.keyboard.press('Control+Shift+Digit2');
  await sleep(150);
  const n1 = W.inputs().length;
  await page.keyboard.press('Control+KeyC'); // not a chord: goes to the terminal as before (^C). Ctrl+Shift+<letter> would prove nothing: xterm sends no bytes for it
  await sleep(150);
  const got = await page.evaluate(() => window.__got.filter(m => m && m.t === 'grid-key'));
  check('framed: Ctrl+Shift+2 reaches the parent as { t: grid-key, key: tab:2 }, once', got.length === 1 && got[0].key === 'tab:2', got);
  const after = W.inputs().slice(n0);
  check('framed: the chord did not reach the pty; Ctrl+C (not a chord) still does', n1 === n0 && after.join('') === '\x03', after);
  await frame.evaluate(() => postMessage({ t: 'grid-mod', mod: 'alt' }, location.origin));
  await page.keyboard.press('Alt+Digit3');
  await sleep(100);
  const e2 = W.inputs().length;
  await page.keyboard.press('Shift+Enter'); await sleep(100);
  check('framed: Shift+Enter is a line break too (\\n)', W.inputs().slice(e2).join('') === '\n', bytes(W.inputs().slice(e2).join('')));
  check('framed: after grid-mod alt, Alt+3 is the chord', (await page.evaluate(() => window.__got.filter(m => m && m.t === 'grid-key').map(m => m.key).join())) === 'tab:2,tab:3');
  check('no page errors', W.errors.length === 0, W.errors);
  await shut(W);
}

const ALL = { proto, keybar, ime, clipboard, sheet, composer, paint, theme, framed };
for (const m of mode === 'all' ? MODES : [mode]) {
  cur = m;
  try { await ALL[m](); } catch (e) { bad++; console.log(`FAIL ${engine}/${m} threw ${String(e.stack || e).split('\n').slice(0, 4).join(' | ')}`); }
}
await browser.close();
console.log(bad ? `term-check ${engine}/${mode}: ${bad} FAILED` : `term-check ${engine}/${mode}: ALL PASS`);
process.exit(bad ? 1 : 0);
