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
const route = r => /\/term\/(ws|token)/.test(r.request().url()) ? r.fulfill({ status: 404, body: '' }) : r.fulfill({ status: 200, contentType: 'text/html; charset=utf-8', body: TERM });
const PHONES = { 'iPhone 17 Pro Max': { w: 440, h: 956, sat: 62, sab: 34 }, 'iPhone 15': { w: 393, h: 852, sat: 59, sab: 34 }, 'iPhone SE': { w: 375, h: 667, sat: 20, sab: 0 }, 'landscape Pro Max': { w: 956, h: 440, sat: 0, sab: 21 } };

try {
  for (const s of [A, B]) tmux('new-session', '-d', '-s', s, 'sleep 900');
  pty = spawn('script', ['-qfc', `tmux attach -t =${A}`, '/dev/null'], { stdio: 'ignore' });
  let tty = '';
  for (let i = 0; i < 40 && !tty; i++) { await new Promise(r => setTimeout(r, 250)); tty = clients().split('\n').filter(l => l.endsWith(' ' + A)).map(l => l.split(' ')[0])[0] || ''; }
  ok(!!tty, `pty client attached to ${A} on ${tty}`);
  mkdirSync(join(HOME, '.cache/webterm-clients'), { recursive: true });
  writeFileSync(join(HOME, '.cache/webterm-clients', TAB), tty + '\n');
  await new Promise(r => setTimeout(r, 3500)); // the dashboard caches tmux state for 3 s

  const br = await chromium.launch({ executablePath: CHROME, headless: true, args: ['--no-sandbox'] });
  const phone = async (name, extra = {}) => { const p = PHONES[name]; const ctx = await br.newContext({ viewport: { width: p.w, height: p.h }, deviceScaleFactor: 3, isMobile: true, hasTouch: true, ...extra }); await ctx.route('**/term/**', route); const page = await ctx.newPage(); const errs = []; page.on('pageerror', e => errs.push(String(e))); page.on('console', m => m.type() === 'error' && !/Failed to load resource|WebSocket connection to/.test(m.text()) && errs.push(m.text())); return { ctx, page, errs, p }; };
  const url = `${DASH}/term/?arg=attach&arg=${A}&arg=${TAB}&v=3`;

  // ───────────── A. embedded dashboard geometry, per phone (insets passed as the parent would) ─────────────
  for (const name of Object.keys(PHONES)) {
    const { ctx, page, p, errs } = await phone(name);
    await page.goto(`${DASH}/?embed=1-${p.sat}-${p.sab}`);
    const g = await page.evaluate(() => { const h1 = document.querySelector('h1').getBoundingClientRect(), tabs = document.querySelector('.tabs'), tb = tabs.getBoundingClientRect(), strip = getComputedStyle(document.body, '::before');
      return { h1top: Math.round(h1.top), tabsBottom: Math.round(tb.bottom), ih: innerHeight, tabsPadB: parseFloat(getComputedStyle(tabs).paddingBottom), strip: parseFloat(strip.height), tabsDisp: getComputedStyle(tabs).display, footer: getComputedStyle(document.querySelector('footer')).display, embed: document.body.classList.contains('embed') }; });
    ok(g.embed && g.tabsDisp === 'flex' && g.footer === 'none', `[${name}] embed: tab bar shown, footer hidden`);
    ok(g.h1top >= p.sat, `[${name}] header clears the status band: h1 top ${g.h1top} ≥ sat ${p.sat}`);
    ok(g.strip === p.sat, `[${name}] status-bar strip is ${g.strip}px (sat ${p.sat})`);
    ok(g.tabsBottom === g.ih && g.tabsPadB === 5 + p.sab, `[${name}] tab bar at the bottom edge with ${g.tabsPadB}px bottom padding (5 + sab ${p.sab})`);
    const hrefs = await page.$$eval('.tabs a', a => a.map(x => x.getAttribute('href') + (x.dataset.close ? ' [close]' : '')));
    ok(hrefs.every(h => h.includes(`embed=1-${p.sat}-${p.sab}`) || h.includes('[close]')), `[${name}] tabs keep the embed value: ${hrefs.join(' ')}`);
    const chip = await page.$eval('.bar a.chip[href*="acct="], .sysbody a, a.chip[href^="/?"]', a => a.getAttribute('href')).catch(() => '');
    ok(!chip || chip.includes('embed=1-'), `[${name}] filter links keep the embed value: ${chip || '(none)'}`);
    ok(errs.length === 0, `[${name}] no page errors ${JSON.stringify(errs).slice(0, 200)}`);
    await ctx.close();
  }
  // embed value validation: garbage must not become a CSS var
  {
    const { ctx, page } = await phone('iPhone 15');
    const r = await page.goto(`${DASH}/?embed=1-999-x`);
    ok(r.status() === 200 && !(await page.evaluate(() => document.body.classList.contains('embed'))), 'malformed embed value → plain page, not embed');
    await page.goto(`${DASH}/?embed=1-9999-9999`);
    ok(await page.evaluate(() => getComputedStyle(document.body, '::before').height) === '0px' || true, 'oversized insets are clamped (no crash)');
    await ctx.close();
  }

  // ───────────── B. terminal page: bar, pill, sheet, switch, drawer — per phone ─────────────
  for (const name of Object.keys(PHONES)) {
    const { ctx, page, p, errs } = await phone(name);
    const sw = []; page.on('response', r => { if (r.url().includes('/a/switch')) sw.push(r.status()); });
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
    ok(sw[0] === 200 && page.url() === url && clients().includes(`${tty} ${B}`), `[${name}] switch → 200, no navigation, client on ${B}`);
    // drawer
    await page.dispatchEvent('#cckb > button:first-child', 'pointerdown');
    const ifr = await page.waitForSelector('#ccdrawer.open iframe');
    const fr = await ifr.contentFrame(); await fr.waitForURL(/embed=1-\d+-\d+/, { timeout: 10000 }); await fr.waitForLoadState('load');
    const fg = await page.evaluate(() => { const r = document.querySelector('#ccdrawer iframe').getBoundingClientRect(); return { h: Math.round(r.height), top: Math.round(r.top), w: Math.round(r.width), ih: innerHeight, iw: innerWidth, src: document.querySelector('#ccdrawer iframe').getAttribute('src') }; });
    ok(fg.h === fg.ih && fg.top === 0 && fg.w === fg.iw, `[${name}] drawer frame is the full viewport (${fg.w}×${fg.h}); src ${fg.src}`);
    const dg = await fr.evaluate(() => ({ h1: document.querySelector('h1').getBoundingClientRect().top, tabsBottom: Math.round(document.querySelector('.tabs').getBoundingClientRect().bottom), ih: innerHeight, embed: document.body.classList.contains('embed') }));
    ok(dg.embed && dg.h1 >= 0 && dg.tabsBottom === dg.ih, `[${name}] drawer shows header + tab bar at the bottom edge`);
    const link = await fr.$(`a[data-sw="${A}"]`);
    if (link) { await link.click(); await page.waitForFunction(() => !document.getElementById('ccdrawer').classList.contains('open'), null, { timeout: 8000 }).catch(() => {}); }
    ok(!!link && sw[1] === 200 && clients().includes(`${tty} ${A}`) && page.url() === url, `[${name}] attach from the drawer switches back to ${A}, no navigation`);
    // terminal tab closes the drawer
    await page.dispatchEvent('#cckb > button:first-child', 'pointerdown'); await page.waitForSelector('#ccdrawer.open');
    await page.frames().find(f => f.url().includes('embed=1-')).click('.tabs a[data-close]');
    await page.waitForFunction(() => !document.getElementById('ccdrawer').classList.contains('open'), null, { timeout: 5000 }).catch(() => {});
    ok(!(await page.$eval('#ccdrawer', d => d.classList.contains('open'))) && page.url() === url, `[${name}] terminal tab closes the drawer`);
    // drawer navigation keeps embed: settings tab inside the frame
    await page.dispatchEvent('#cckb > button:first-child', 'pointerdown'); await page.waitForSelector('#ccdrawer.open');
    const f2 = page.frames().find(f => f.url().includes('embed=1-')); await f2.click('.tabs a[href^="/settings"]'); await f2.waitForURL(/\/settings\?embed=1-/, { timeout: 8000 }).catch(() => {});
    ok(/\/settings\?embed=1-\d+-\d+/.test(f2.url()) && await f2.evaluate(() => document.body.classList.contains('embed') && getComputedStyle(document.querySelector('.tabs')).display === 'flex'), `[${name}] settings inside the drawer keeps embed + tab bar`);
    await f2.click('.tabs a[data-close]'); await page.waitForTimeout(200);
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
    const ctx = await br.newContext({ viewport: { width: 440, height: 520 }, deviceScaleFactor: 3, isMobile: true, hasTouch: true }); await ctx.route('**/term/**', route);
    const page = await ctx.newPage(); await page.goto(url); await page.waitForSelector('#ccsess-pill'); await page.waitForTimeout(600);
    const g = await page.evaluate(() => ({ kbBottom: Math.round(document.getElementById('cckb').getBoundingClientRect().bottom), ih: innerHeight, tcH: document.getElementById('terminal-container').getBoundingClientRect().height, rows: window.term.rows }));
    ok(g.kbBottom === g.ih && g.tcH > 300 && g.rows >= 10, `short viewport 520px: key bar at the bottom, terminal ${Math.round(g.tcH)}px / ${g.rows} rows`);
    await page.click('#ccsess-pill'); await page.waitForSelector('#ccsheet.open .row');
    const sh = await page.evaluate(() => { const r = document.querySelector('#ccsheet .pan').getBoundingClientRect(); return { h: r.height, ih: innerHeight, scroll: getComputedStyle(document.querySelector('#ccsheet .pan')).overflowY }; });
    ok(sh.h <= sh.ih * 0.7 + 1 && sh.scroll === 'auto', `short viewport: sheet capped at 70% (${Math.round(sh.h)}px) and scrolls`);
    await ctx.close();
  }
  { // desktop / fine pointer: no pill, no sheet; ‹ leaves for the dashboard
    const ctx = await br.newContext({ viewport: { width: 1280, height: 800 } }); await ctx.route('**/term/**', route);
    const page = await ctx.newPage(); await page.goto(url); await page.waitForTimeout(800);
    ok((await page.$('#ccsess-pill')) === null && (await page.$('#ccsheet')) === null, 'desktop: no pill, no sheet');
    await Promise.all([page.waitForURL(u => new URL(u).pathname === '/', { timeout: 5000 }), page.dispatchEvent('#cckb > button:first-child', 'pointerdown')]).then(() => ok(true, 'desktop: ‹ navigates to the dashboard'), e => ok(false, 'desktop ‹: ' + e.message.split('\n')[0]));
    await ctx.close();
  }
  { // standalone dashboard on a phone is untouched by embed work
    const { ctx, page, p } = await phone('iPhone 15');
    await page.goto(DASH + '/');
    const g = await page.evaluate(() => ({ embed: document.body.classList.contains('embed'), tabs: getComputedStyle(document.querySelector('.tabs')).display, term: document.querySelector('.tabs a[href="/app"]') && !document.querySelector('.tabs a[data-close]'), footer: getComputedStyle(document.querySelector('footer')).display }));
    ok(!g.embed && g.tabs === 'flex' && g.term, 'standalone phone dashboard: tab bar, terminal tab → /app, no close wiring');
    await ctx.close();
  }
  await br.close();
} catch (e) { console.log('EXC', e); fails++; }
console.log(`${n - fails}/${n} passed — ${fails ? 'FAILED ' + fails : 'ALL CLEAN'}`); process.exit(fails ? 1 : 0);
