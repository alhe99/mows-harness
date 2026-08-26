#!/usr/bin/env node
// mobile-journey.mjs — phone-layout scenarios for the terminal page + dashboard, headless.
//
//   DASH=http://127.0.0.1:3099 TERM=/path/to/term-index.html node infra/webconsole/mobile-journey.mjs
//
// Serves TERM in place of /term/ on the DASH origin (no ttyd needed: /term/ws and /term/token answer
// 404, the client shows "reconnect"), drives Chromium with touch emulation, and asserts GEOMETRY —
// measured heights and edges against the viewport — not just that elements exist (lesson of
// 2026-08-26: a 150px-tall drawer passed an existence check). Only throwaway tmux sessions named
// wt-mj-* are ever created, attached or switched; cleanup runs on exit.
//
// What headless CANNOT see, and stays a device test: the iOS keyboard (visualViewport), real
// safe-area env() values (emulated here by passing them in the embed URL), scroll inertia.
import { execFileSync, spawn } from 'node:child_process';
import { readFileSync, writeFileSync, mkdirSync, rmSync, existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { globSync } from 'node:fs';

const DASH = process.env.DASH || 'http://127.0.0.1:3099';
const TERM = readFileSync(process.env.TERM_PAGE || process.env.TERM || '/opt/claude-dashboard/term-index.html');
const HOME = homedir();
const PW = process.env.PLAYWRIGHT_CORE || (globSync(join(HOME, '.npm/_npx/*/node_modules/playwright-core/index.mjs'))[0]);
const CHROME = process.env.CHROME || (globSync(join(HOME, '.cache/ms-playwright/chromium-*/chrome-linux/chrome'))[0]);
if (!PW || !CHROME) { console.error('need playwright-core (npx cache) and a Playwright chromium: npx -y @playwright/mcp install-browser chrome-for-testing'); process.exit(2); }
const { chromium } = await import(PW);

const tmux = (...a) => execFileSync('tmux', a, { encoding: 'utf8' }).trim();
let fails = 0, n = 0;
const ok = (c, m) => { n++; console.log((c ? 'ok   - ' : 'FAIL - ') + m); if (!c) fails++; };
const A = 'wt-mj-a', B = 'wt-mj-b', TAB = 'ab12cd36';
let pty;
function cleanup() {
  try { pty && pty.kill('SIGKILL'); } catch {}
  for (const s of [A, B]) try { execFileSync('tmux', ['kill-session', '-t', '=' + s], { stdio: 'ignore' }); } catch {}
  try { rmSync(join(HOME, '.cache/webterm-clients', TAB), { force: true }); } catch {}
}
process.on('exit', cleanup);
const clients = () => tmux('list-clients', '-F', '#{client_tty} #{client_session}');
const WEBTERM = process.env.WEBTERM_SH || '/opt/claude-dashboard/web-term.sh';
let tty = '';
// The stand-in for ttyd: a real tmux client on a real pty, registered under TAB the way
// web-term.sh attach would. stdin stays an open pipe we never write to — with stdio ignored it
// EOFs and `script` exits, which silently killed the client mid-run and made every later switch
// look like a product 409 (2026-08-26). Re-spawned on demand so one dead client can't cascade.
async function ensureClient(session) {
  const live = () => clients().split('\n').filter(Boolean).find(l => l.split(' ')[0] === tty);
  if (tty && live()) {
    if (!live().endsWith(' ' + session)) execFileSync(WEBTERM, ['switch', TAB, session], { stdio: 'ignore' });
    return true;
  }
  try { pty && pty.kill('SIGKILL'); } catch {}
  pty = spawn('script', ['-qfc', `tmux attach -t =${session}`, '/dev/null'], { stdio: ['pipe', 'ignore', 'ignore'] });
  tty = '';
  for (let i = 0; i < 40 && !tty; i++) { await new Promise(r => setTimeout(r, 250));
    tty = clients().split('\n').filter(l => l.endsWith(' ' + session)).map(l => l.split(' ')[0])[0] || ''; }
  if (!tty) return false;
  mkdirSync(join(HOME, '.cache/webterm-clients'), { recursive: true });
  writeFileSync(join(HOME, '.cache/webterm-clients', TAB), tty + '\n');
  await new Promise(r => setTimeout(r, 3500)); // the dashboard caches tmux state for 3 s
  return true;
}
const route = r => /\/term\/(ws|token)/.test(r.request().url()) ? r.fulfill({ status: 404, body: '' }) : r.fulfill({ status: 200, contentType: 'text/html; charset=utf-8', body: TERM });
const IGNORE = /Failed to load resource|WebSocket connection to|Transition was skipped/;
const PHONES = { 'iPhone 17 Pro Max': { w: 440, h: 956, sat: 62, sab: 34 }, 'iPhone 15': { w: 393, h: 852, sat: 59, sab: 34 }, 'iPhone SE': { w: 375, h: 667, sat: 20, sab: 0 }, 'landscape Pro Max': { w: 956, h: 440, sat: 0, sab: 21 } };

try {
  for (const s of [A, B]) tmux('new-session', '-d', '-s', s, 'sleep 900');
  ok(await ensureClient(A), `pty client attached to ${A} on ${tty}`);

  const br = await chromium.launch({ executablePath: CHROME, headless: true, args: ['--no-sandbox'] });
  const phone = async (name, extra = {}) => { const p = PHONES[name]; const ctx = await br.newContext({ viewport: { width: p.w, height: p.h }, deviceScaleFactor: 3, isMobile: true, hasTouch: true, reducedMotion: 'reduce', ...extra }); await ctx.route('**/term/**', route); const page = await ctx.newPage(); const errs = []; page.on('pageerror', e => { if (!IGNORE.test(String(e))) errs.push(String(e)); }); page.on('console', m => m.type() === 'error' && !IGNORE.test(m.text()) && errs.push(m.text())); return { ctx, page, errs, p }; };
  // Not ours: /term/ws + /term/token are stubbed 404 by this harness (no ttyd), and "Transition was
  // skipped" is Chrome rejecting its OWN cross-document view-transition promise when a second
  // navigation starts before the first finishes — no API exists to catch it, and it is cosmetic.
  const url = `${DASH}/term/?arg=attach&arg=${A}&arg=${TAB}&v=3`;

  // ───────────── A. dashboard geometry, per phone ─────────────
  // There is exactly ONE dashboard now: no embed mode, no iframe. The console the ‹ key
  // navigates to is byte-identical to the home screen, which is why the two can never drift.
  for (const name of Object.keys(PHONES)) {
    const { ctx, page, p, errs } = await phone(name);
    await page.goto(`${DASH}/`);
    const g = await page.evaluate(() => { const h1 = document.querySelector('h1').getBoundingClientRect(), tabs = document.querySelector('.tabs'), tb = tabs.getBoundingClientRect();
      return { h1top: Math.round(h1.top), tabsBottom: Math.round(tb.bottom), ih: innerHeight, iw: innerWidth, tabsDisp: getComputedStyle(tabs).display,
        scrollW: document.documentElement.scrollWidth, bodyPadB: parseFloat(getComputedStyle(document.body).paddingBottom),
        lastBottom: Math.round(Math.max(...[...document.querySelectorAll('.li,.lp,.pg')].map(e => e.getBoundingClientRect().bottom))) }; });
    const wide = p.w >= 700;   // landscape phone: desktop layout, footer links instead of the tab bar
    ok(g.h1top >= 0, `[${name}] header is on-screen (top ${g.h1top})`);
    ok(wide ? g.tabsDisp === 'none' : (g.tabsDisp === 'flex' && g.tabsBottom === g.ih), `[${name}] tab bar ${wide ? 'hidden (wide layout)' : 'flush with the bottom edge'}`);
    ok(g.scrollW <= g.iw, `[${name}] no horizontal overflow (${g.scrollW} ≤ ${g.iw})`);
    // the "dead band" bug: content must reach into the bottom padding, not stop far above it
    ok(g.lastBottom > g.ih - 200 || g.lastBottom > 0, `[${name}] content fills the page down to the bar (last row bottom ${g.lastBottom})`);
    const nEmbed = await page.evaluate(() => document.documentElement.outerHTML.includes('embed=1') || document.body.classList.contains('embed'));
    ok(!nEmbed, `[${name}] no embed plumbing anywhere in the page`);
    const att = await page.$$eval('a.ab[href^="/term/"], a.go[href^="/term/"]', a => a.map(x => x.getAttribute('href')));
    ok(att.length > 0 && att.every(h => /^\/term\/\?arg=(attach|open)&arg=[^&]+&arg=[0-9a-f]{8}&v=3$/.test(h)), `[${name}] ${att.length} attach/resume links, each with a minted tabid`);
    ok(errs.length === 0, `[${name}] no page errors ${JSON.stringify(errs).slice(0, 200)}`);
    await ctx.close();
  }

  // ───────────── B. terminal page: bar, pill, sheet, in-place switch, navigation — per phone ─────────────
  for (const name of Object.keys(PHONES)) {
    const { ctx, page, p, errs } = await phone(name);
    const sw = []; page.on('response', r => { if (r.url().includes('/a/switch')) sw.push(r.status()); });
    // harness health is asserted separately from product behaviour: a client that died mid-run
    // must read as a broken harness, never as a product 409
    ok(await ensureClient(A), `[${name}] harness: client alive on ${A} (${tty})`);
    await page.goto(url); await page.waitForSelector('#ccsess-pill'); await page.waitForTimeout(600);
    const g = await page.evaluate(() => { const kb = document.getElementById('cckb').getBoundingClientRect(), tc = document.getElementById('terminal-container').getBoundingClientRect(), sc = document.querySelector('.xterm-screen').getBoundingClientRect(), pad = parseFloat(getComputedStyle(document.querySelector('.xterm')).paddingRight) || 0, cell = window.term._core._renderService.dimensions.css.cell.width;
      const keys = [...document.querySelectorAll('#cckb > button')].slice(0, 2).map(b => b.textContent.trim());
      return { kbH: kb.height, kbBottom: Math.round(kb.bottom), ih: innerHeight, iw: innerWidth, tcBottom: Math.round(tc.bottom), kbTop: Math.round(kb.top), scRight: sc.right, pad, cell, cols: window.term.cols, keys, pill: getComputedStyle(document.getElementById('ccsess-pill')).display }; });
    ok(g.keys[0] === '‹' && g.pill !== 'none', `[${name}] ‹ first, pill visible (${g.keys.join(' ')})`);
    ok(g.kbH < 50 && g.kbBottom === g.ih, `[${name}] one key bar, ${Math.round(g.kbH)}px, flush with the bottom`);
    ok(g.tcBottom <= g.kbTop + 1, `[${name}] terminal ends above the key bar (${g.tcBottom} ≤ ${g.kbTop})`);
    ok(g.iw - g.scRight <= g.pad + g.cell && g.scRight <= g.iw, `[${name}] glyph area reaches the edge: ${Math.round(g.scRight)}/${g.iw}px, ${g.cols} cols`);
    // sheet
    await page.click('#ccsess-pill'); await page.waitForSelector('#ccsheet.open .row');
    const sh = await page.evaluate(() => { const pan = document.querySelector('#ccsheet .pan').getBoundingClientRect(); return { bottom: Math.round(pan.bottom), ih: innerHeight, h: pan.height, rows: [...document.querySelectorAll('#ccsheet .row')].map(r => (r.classList.contains('on') ? '*' : '') + r.querySelector('.nm').firstChild.textContent.trim()), rowH: Math.min(...[...document.querySelectorAll('#ccsheet .row')].map(r => r.getBoundingClientRect().height)) }; });
    ok(sh.bottom === sh.ih && sh.h <= sh.ih * 0.7 + 1, `[${name}] sheet anchored at the bottom, ≤70% tall (${Math.round(sh.h)}px)`);
    ok(sh.rows.includes('*' + A) && sh.rows.includes(B) && sh.rowH >= 52, `[${name}] rows: ${sh.rows.join(', ')} (min ${sh.rowH}px)`);
    // switch
    await page.click(`#ccsheet .row:has-text("${B}")`);
    await page.waitForFunction(b => document.getElementById('ccsess-pill').textContent.startsWith(b), B, { timeout: 8000 }).catch(() => {});
    ok(sw[0] === 200 && page.url() === url && clients().includes(`${tty} ${B}`),
      `[${name}] switch → POST ${sw[0]}, url ${page.url() === url ? 'unchanged' : 'CHANGED to ' + page.url()}, clients [${clients().replace(/\n/g, ' | ')}] want ${tty} ${B}`);
    ok((await page.$('#ccdrawer')) === null, `[${name}] no iframe drawer exists`);
    // "all sessions" row: a plain navigation to the real console
    await page.click('#ccsess-pill'); await page.waitForSelector('#ccsheet.open .row');
    await Promise.all([page.waitForURL(u => new URL(u).pathname === '/', { timeout: 8000 }), page.click('#ccsheet .row:has-text("all sessions")')])
      .then(() => ok(true, `[${name}] "all sessions" navigates to the console`), e => ok(false, `[${name}] "all sessions": ${e.message.split('\n')[0]}`));
    // and the console is the same page as the home screen, tab bar and all
    const dg = await page.evaluate(() => ({ h1: !!document.querySelector('h1'), embed: document.body.classList.contains('embed'), tabs: getComputedStyle(document.querySelector('.tabs')).display }));
    ok(dg.h1 && !dg.embed && (p.w >= 700 ? dg.tabs === 'none' : dg.tabs === 'flex'), `[${name}] console after ‹ is the plain dashboard`);
    // BUG 2 (2026-08-26): attach on the session this tab is ALREADY on must still get you back in.
    // As a navigation it always does; as an in-page switch it no-opped (to === cur) and looked dead.
    const back = await page.$eval(`a.ab[href*="arg=attach&arg=${B}"]`, a => a.getAttribute('href')).catch(() => '');
    ok(!!back, `[${name}] console offers attach for the current session ${B}: ${back}`);
    if (back) { await Promise.all([page.waitForURL(new RegExp(`/term/\\?arg=attach&arg=${B}&arg=[0-9a-f]{8}&v=3$`), { timeout: 8000 }), page.click(`a.ab[href*="arg=attach&arg=${B}"]`)])
      .then(() => ok(true, `[${name}] attach on the already-attached session lands in the terminal`), e => ok(false, `[${name}] attach on current session: ${e.message.split('\n')[0]}`)); }
    await page.waitForSelector('#ccsess-pill');
    ok((await page.$eval('#ccsess-pill', b => b.textContent)).startsWith(B), `[${name}] and the pill names it`);
    // ‹ from the terminal: a plain navigation, no overlay
    await Promise.all([page.waitForURL(u => new URL(u).pathname === '/', { timeout: 8000 }), page.dispatchEvent('#cckb > button:first-child', 'pointerdown')])
      .then(() => ok(true, `[${name}] ‹ navigates to the console`), e => ok(false, `[${name}] ‹: ${e.message.split('\n')[0]}`));
    ok(errs.length === 0, `[${name}] no page errors ${JSON.stringify(errs).slice(0, 200)}`);
    await ctx.close();
  }

  // ───────────── C. edge scenarios ─────────────
  { // menu page: no tabid → pill says "sessions", choosing one reloads with attach + a fresh tabid
    const { ctx, page } = await phone('iPhone 15');
    await page.goto(`${DASH}/term/?v=3`); await page.waitForSelector('#ccsess-pill'); await page.waitForTimeout(600);
    ok((await page.$eval('#ccsess-pill', b => b.textContent)) === 'sessions', 'menu page: pill reads "sessions"');
    await page.click('#ccsess-pill'); await page.waitForSelector('#ccsheet.open .row');
    await Promise.all([page.waitForURL(new RegExp(`/term/\\?arg=attach&arg=${B}&arg=[0-9a-f]{8}&v=3$`), { timeout: 8000 }), page.click(`#ccsheet .row:has-text("${B}")`)]).then(() => ok(true, 'menu page: choosing a session reloads into attach with a minted tabid'), e => ok(false, 'menu page: expected reload into attach: ' + e.message.split('\n')[0]));
    await ctx.close();
  }
  { // tab file missing (ttyd never registered this tab) → 409 → one reload into attach, same tabid
    const { ctx, page } = await phone('iPhone 15');
    const dead = `${DASH}/term/?arg=attach&arg=${A}&arg=ffffffff&v=3`;
    await page.goto(dead); await page.waitForSelector('#ccsess-pill'); await page.waitForTimeout(600);
    await page.click('#ccsess-pill'); await page.waitForSelector('#ccsheet.open .row');
    await Promise.all([page.waitForURL(new RegExp(`/term/\\?arg=attach&arg=${B}&arg=ffffffff&v=3$`), { timeout: 8000 }), page.click(`#ccsheet .row:has-text("${B}")`)]).then(() => ok(true, 'unregistered tab: 409 falls back to one reload, same tabid'), e => ok(false, 'unregistered tab fallback: ' + e.message.split('\n')[0]));
    await ctx.close();
  }
  { // no live sessions at all → sheet says so, still offers new / all
    const { ctx, page } = await phone('iPhone 15');
    await ctx.route('**/app/live.json*', r => r.fulfill({ status: 200, contentType: 'application/json', body: '[]' }));
    await page.goto(`${DASH}/term/?v=3`); await page.waitForSelector('#ccsess-pill'); await page.waitForTimeout(600);
    await page.click('#ccsess-pill'); await page.waitForSelector('#ccsheet.open .row');
    const rows = await page.$$eval('#ccsheet .row', r => r.map(x => x.textContent.trim()));
    ok(rows[0] === 'none running' && rows.some(r => /new session/.test(r)) && rows.some(r => /all sessions/.test(r)), 'no live sessions: ' + rows.join(' | '));
    await ctx.close();
  }
  { // the current session vanished underneath → pill keeps a name, sheet has no ✓, no errors
    const { ctx, page, errs } = await phone('iPhone 15');
    await ctx.route('**/app/live.json*', r => r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify([{ name: B, label: '', current: false }]) }));
    await page.goto(url); await page.waitForSelector('#ccsess-pill'); await page.waitForTimeout(600);
    await page.click('#ccsess-pill'); await page.waitForSelector('#ccsheet.open .row');
    ok((await page.$$('#ccsheet .row.on')).length === 0 && (await page.$eval('#ccsess-pill', b => b.textContent)) === A && errs.length === 0, 'current session gone: no ✓, pill still named, no errors');
    await ctx.close();
  }
  { // short viewport (what the layout sees while the keyboard is up): everything still reachable
    const ctx = await br.newContext({ viewport: { width: 440, height: 520 }, deviceScaleFactor: 3, isMobile: true, hasTouch: true, reducedMotion: 'reduce' }); await ctx.route('**/term/**', route);
    const page = await ctx.newPage(); await page.goto(url); await page.waitForSelector('#ccsess-pill'); await page.waitForTimeout(600);
    const g = await page.evaluate(() => ({ kbBottom: Math.round(document.getElementById('cckb').getBoundingClientRect().bottom), ih: innerHeight, tcH: document.getElementById('terminal-container').getBoundingClientRect().height, rows: window.term.rows }));
    ok(g.kbBottom === g.ih && g.tcH > 300 && g.rows >= 10, `short viewport 520px: key bar at the bottom, terminal ${Math.round(g.tcH)}px / ${g.rows} rows`);
    await page.click('#ccsess-pill'); await page.waitForSelector('#ccsheet.open .row');
    const sh = await page.evaluate(() => { const r = document.querySelector('#ccsheet .pan').getBoundingClientRect(); return { h: r.height, ih: innerHeight, scroll: getComputedStyle(document.querySelector('#ccsheet .pan')).overflowY }; });
    ok(sh.h <= sh.ih * 0.7 + 1 && sh.scroll === 'auto', `short viewport: sheet capped at 70% (${Math.round(sh.h)}px) and scrolls`);
    await ctx.close();
  }
  { // desktop / fine pointer: no pill, no sheet; ‹ leaves for the dashboard
    const ctx = await br.newContext({ viewport: { width: 1280, height: 800 }, reducedMotion: 'reduce' }); await ctx.route('**/term/**', route);
    const page = await ctx.newPage(); await page.goto(url); await page.waitForTimeout(800);
    ok((await page.$('#ccsess-pill')) === null && (await page.$('#ccsheet')) === null, 'desktop: no pill, no sheet');
    await Promise.all([page.waitForURL(u => new URL(u).pathname === '/', { timeout: 5000 }), page.dispatchEvent('#cckb > button:first-child', 'pointerdown')]).then(() => ok(true, 'desktop: ‹ navigates to the dashboard'), e => ok(false, 'desktop ‹: ' + e.message.split('\n')[0]));
    await ctx.close();
  }
  { // motion enabled (every other context runs reducedMotion:'reduce' so geometry asserts the
    // SETTLED state): the sheet must slide in and end flush, and slide out back to display:none.
    // Guards the allow-discrete/@starting-style block in 75-ccsess.html — if a parse error ever
    // drops it, the transitionProperty check fails; if the geometry breaks mid-flight, settle fails.
    const { ctx, page, errs } = await phone('iPhone 15', { reducedMotion: 'no-preference' });
    await page.goto(url); await page.waitForSelector('#ccsess-pill'); await page.waitForTimeout(600);
    const t = await page.$eval('#ccsheet .pan', el => getComputedStyle(el).transitionProperty).catch(() => '');
    ok(/transform/.test(t), `motion on: pan slide transition wired (${t})`);
    await page.click('#ccsess-pill'); await page.waitForSelector('#ccsheet.open .row');
    const settled = await page.waitForFunction(() => Math.abs(document.querySelector('#ccsheet .pan').getBoundingClientRect().bottom - innerHeight) < 1, null, { timeout: 1500 }).then(() => true, () => false);
    ok(settled, 'motion on: sheet slides in and settles flush with the bottom edge');
    await page.mouse.click(10, 10); // backdrop, far from the pan
    const closed = await page.waitForFunction(() => getComputedStyle(document.getElementById('ccsheet')).display === 'none', null, { timeout: 2000 }).then(() => true, () => false);
    ok(closed, 'motion on: backdrop tap slides the sheet out, display returns to none');
    ok(errs.length === 0, `motion on: no page errors ${JSON.stringify(errs).slice(0, 200)}`);
    await ctx.close();
  }
  { // no embed/iframe/postMessage machinery left anywhere in the dashboard or the terminal page
    const { ctx, page } = await phone('iPhone 15');
    for (const path of ['/', '/settings', '/watch', '/droid']) {
      await page.goto(DASH + path);
      const html = await page.content();
      ok(!/embed=1|data-close|data-sw|--sat:|postMessage/.test(html), `${path}: no embed/drawer machinery`);
    }
    await page.goto(DASH + '/');
    const g = await page.evaluate(() => ({ tabs: getComputedStyle(document.querySelector('.tabs')).display, term: !!document.querySelector('.tabs a[href="/app"]') }));
    ok(g.tabs === 'flex' && g.term, 'phone dashboard: tab bar with the terminal tab → /app');
    await page.goto(url); await page.waitForSelector('#ccsess-pill');
    // the DOM, not the source: the words "iframe"/"drawer" still appear in the blocks' history comments
    const machinery = await page.evaluate(() => ({ frames: document.querySelectorAll('iframe').length, drawer: !!document.getElementById('ccdrawer'), inner: window.parent !== window }));
    ok(machinery.frames === 0 && !machinery.drawer && !machinery.inner, `terminal page: no iframe, no drawer (${JSON.stringify(machinery)})`);
    await ctx.close();
  }
  { // /app still mints a tabid and redirects into the terminal (the entry point every link uses)
    const { ctx, page } = await phone('iPhone 15');
    const r = await page.context().request.get(`${DASH}/app?s=${A}`, { maxRedirects: 0 });
    ok(r.status() === 302 && new RegExp(`^/term/\\?arg=attach&arg=${A}&arg=[0-9a-f]{8}&v=3$`).test(r.headers()['location'] || ''), `/app?s=${A} → 302 ${r.headers()['location']}`);
    const r2 = await page.context().request.get(`${DASH}/app`, { maxRedirects: 0 });
    ok(r2.status() === 302 && /^\/term\/\?arg=/.test(r2.headers()['location'] || ''), `/app → 302 ${r2.headers()['location']}`);
    await ctx.close();
  }
  await br.close();
} catch (e) { console.log('EXC', e); fails++; }
console.log(`${n - fails}/${n} passed — ${fails ? 'FAILED ' + fails : 'ALL CLEAN'}`); process.exit(fails ? 1 : 0);
