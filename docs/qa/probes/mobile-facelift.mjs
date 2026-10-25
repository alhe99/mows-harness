// Journey docs/qa/journeys/mobile-facelift.md as a script. Exit code is the verdict.
// usage: PLAYWRIGHT=~/.cache/mows-qa/node_modules/playwright/index.mjs node docs/qa/probes/mobile-facelift.mjs [webkit|chromium] <outdir> [--base URL]
// --base defaults to 127.0.0.1:3005. The journey runs against the shell: the boot snapshot gets one fixture session so step 3 has a card
// (pass --legacy for a dashboard started with --ui=legacy).
// Journey steps 1-7 of docs/qa/journeys/mobile-facelift.md; the PNGs it writes are the visual-parity baseline for the cockpit rebuild.
import { mkdirSync, writeFileSync } from 'node:fs';
const pw = await import(process.env.PLAYWRIGHT || 'playwright');
const engine = process.argv[2] || 'webkit', out = process.argv[3] || '.';
mkdirSync(out, { recursive: true });
const bi = process.argv.indexOf('--base');
const base = bi > 0 ? process.argv[bi + 1].replace(/\/$/, '') : 'http://127.0.0.1:3005';
const shell = !process.argv.includes('--legacy'); // the shell is the dashboard's default since phase 05; --legacy: a dashboard started with --ui=legacy
const browser = await pw[engine].launch();
const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 3, hasTouch: true, isMobile: true });
// the real stream would replace the fixture with whatever tmux holds on its first tick
if (shell) await ctx.addInitScript(() => { window.EventSource = class { addEventListener() {} close() {} }; });
if (shell) await ctx.route(`${base}/`, async route => { // one fixture session, so the card step does not depend on what tmux holds
  const r = await route.fetch();
  const html = (await r.text()).replace(/(<script type="application\/json" id="boot"[^>]*>)([\s\S]*?)(<\/script>)/, (_, a, j, c) => {
    const b = JSON.parse(j); b.fleet = [{ sid8: 'aaaa1111', name: 'cc-alpha', label: 'Alpha', proj: 'alpha', state: 'working', rel: Date.now() - 20000, snippet: 'building' }]; b.live = 1;
    return a + JSON.stringify(b).replace(/</g, '\\u003c') + c;
  });
  const headers = { ...r.headers() }; delete headers['content-encoding']; delete headers['content-length'];
  await route.fulfill({ status: r.status(), headers, body: html });
});
const page = await ctx.newPage();
const errors = [];
// the shell's strict CSP refuses the <style> WebKit's own page.screenshot injects (style-src-elem, "inline", no source file): a harness artifact, not a page error
const known = shell ? /interactive-widget|Refused to apply a stylesheet because its hash/ : /interactive-widget/; page.on('console', m => { if (m.type() === 'error' && !known.test(m.text())) errors.push(m.text()); });
page.on('pageerror', e => errors.push(String(e)));
const results = [];
const check = (id, ok, detail) => { results.push({ id, ok: !!ok, detail }); console.log(`${ok ? 'PASS' : 'FAIL'} ${id} ${detail ?? ''}`); };

await page.goto(base + '/', { waitUntil: 'load' });
if (shell) await page.waitForSelector('#app h1', { state: 'attached' });
await page.waitForTimeout(shell ? 300 : 0);
check('1 h1 starts with mows', (await page.locator('h1').first().innerText()).trim().toLowerCase().startsWith('mows'), await page.locator('h1').first().innerText());
await page.screenshot({ path: `${out}/home-390.png` });
const tabs = await page.evaluate(() => { const t = document.querySelector('.tabs'); if (!t) return null; const r = t.getBoundingClientRect(); const cs = getComputedStyle(t);
  return { pos: cs.position, left: r.left, right: r.right, bf: cs.backdropFilter || cs.webkitBackdropFilter, n: document.querySelectorAll('.tb').length, sw: document.scrollingElement.scrollWidth }; });
check('2 floating glass pill tab bar', tabs && tabs.pos === 'fixed' && tabs.left >= 10 && tabs.right <= 380 && tabs.bf && tabs.bf !== 'none' && tabs.n === 5 && tabs.sw <= 390, JSON.stringify(tabs));
const card = await page.evaluate(() => { const c = document.querySelector('.fleet-cards .lp'); if (!c) return null; const lb = c.querySelector('.lb');
  return { radius: getComputedStyle(c).borderRadius, state: c.dataset.state, lbFs: lb ? parseFloat(getComputedStyle(lb).fontSize) : 0 }; });
check('3 22px card with state + >=16px title', card && card.radius === '22px' && card.state !== undefined && card.lbFs >= 16, JSON.stringify(card));
// the card's ⋯ menu: its buttons are menu rows, not the card's round 42px icon buttons (the phone, 2026-10-25: Pause, Save and Kill came out as clipped circles)
await page.locator('.fleet-cards .fcact > .kx > summary').click();
const menu = await page.evaluate(() => { const k = document.querySelector('.fleet-cards .kx[open] > .kc'); if (!k) return null; const kr = k.getBoundingClientRect();
  const own = [...document.querySelectorAll('.fleet-cards .fcact > .ab, .fleet-cards .fcact > .kx > summary')].map(b => getComputedStyle(b).borderRadius);
  const bad = [...k.querySelectorAll('.ab')].filter(b => b.offsetParent).map(b => { const r = b.getBoundingClientRect(), cs = getComputedStyle(b);
    return { t: b.textContent.trim(), round: cs.borderRadius === '50%', over: b.scrollWidth > b.clientWidth + 1, out: r.left < kr.left || r.right > kr.right + 0.5 }; })
    .filter(x => x.round || x.over || x.out);
  return { own, bad, n: k.querySelectorAll('.ab').length }; });
check('3b card menu rows are not round buttons', menu && menu.n >= 3 && !menu.bad.length && menu.own.length === 2 && menu.own.every(r => r === '50%'), JSON.stringify(menu));
await page.screenshot({ path: `${out}/home-menu-390.png` });
await page.locator('.fleet-cards .fcact > .kx > summary').click();

{
await page.goto(base + '/system', { waitUntil: 'load' });
await page.waitForSelector('.mbar-row', { timeout: 10000 }); // the shell renders the tiles after load
const sys = await page.evaluate(() => { const h = document.querySelector('h1')?.innerText.toLowerCase() || ''; const rows = [...document.querySelectorAll('.mbar-row')];
  const tops = rows.map(r => r.offsetTop); const twoCol = rows.length >= 2 && tops[0] === tops[1]; const pct = rows.every(r => r.querySelector('b.mbar-pct'));
  return { h, rows: rows.length, twoCol, pct }; });
check('4 system 2x2 tiles', sys.h.includes('mows') && sys.h.includes('system') && sys.twoCol && sys.pct, JSON.stringify(sys));
await page.screenshot({ path: `${out}/system-390.png` });

const md = await page.goto(base + '/md?f=' + process.env.HOME + '/Documents/Projects/mows-harness/README.md', { waitUntil: 'load' });
const mdv = await page.evaluate(() => ({ dl: !!document.querySelector('a[download], a[href*="raw=1"]'), h1: document.querySelector('h1')?.innerText || '' }));
check('5 /md download control', md.status() === 200 && mdv.dl && mdv.h1.length > 0, JSON.stringify({ status: md.status(), ...mdv }));
await page.screenshot({ path: `${out}/md-390.png` });

}
const desk = await browser.newContext({ viewport: { width: 1280, height: 800 } });
const dp = await desk.newPage(); dp.on('console', m => { if (m.type() === 'error' && !known.test(m.text())) errors.push('desktop: ' + m.text()); });
await dp.goto(base + '/', { waitUntil: 'load' });
if (shell) await dp.waitForSelector('#app h1', { state: 'attached' });
const d = await dp.evaluate(() => { const t = document.querySelector('.tabs'); const r = t?.getBoundingClientRect(); return { pos: t && getComputedStyle(t).position, left: r?.left, h1fs: parseFloat(getComputedStyle(document.querySelector('h1')).fontSize) }; });
check('6 desktop unchanged', d.h1fs < 26 && (d.pos !== 'fixed' || d.left <= 1), JSON.stringify(d));
await dp.screenshot({ path: `${out}/home-1280.png` });
check('7 zero console errors', errors.length === 0, JSON.stringify(errors));

writeFileSync(`${out}/results.json`, JSON.stringify({ engine, when: new Date().toISOString(), results, errors }, null, 2));
await browser.close();
const fails = results.filter(r => !r.ok).map(r => r.id);
console.log(fails.length ? `VERDICT: fix:[${fails.join('; ')}]` : 'VERDICT: ship');
process.exit(fails.length ? 1 : 0);
