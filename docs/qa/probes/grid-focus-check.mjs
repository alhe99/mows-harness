// Grid keyboard probe (the complement of grid-check.mjs, which panes with a stub): /grid on the dev instance with the REAL terminal
// document in every pane (dist/term.html, a fake ttyd socket that records the input frames), asking after each thing the user does where
// typing lands. Opening a row, a split, a pane header button, a tab, a dropped file and a dropped socket each hand the keyboard to the
// pane's xterm (2026-10-12: before, the row or button kept it and typing went nowhere). Exit code is the verdict.
// usage: node docs/qa/probes/grid-focus-check.mjs [chromium|webkit]   env: DASH (default http://127.0.0.1:3105), PLAYWRIGHT
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
const pw = await import(process.env.PLAYWRIGHT || 'playwright').catch(() => { console.error('grid-focus-check: playwright is not installed (npm ci --ignore-scripts)'); process.exit(2); });
const engine = process.argv[2] || 'chromium';
const DASH = process.env.DASH || 'http://127.0.0.1:3105';
const PAGE = readFileSync(join(import.meta.dirname, '../../../dist/term.html'), 'utf8');
const now = Date.now();
const fx = (sid8, name, label, proj, state, rel, snippet = '') => ({ sid8, name, label, proj, state, rel, snippet });
const FLEET = [fx('aaaa1111','cc-a-one','one','alpha','idle',now-20000), fx('bbbb2222','cc-a-two','two','alpha','working',now-7200000), fx('cccc3333','cc-b-three','three','beta','needs-you',now-60000,'approve?')];
const browser = await pw[engine].launch();
const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 }, serviceWorkers: 'block' });
await ctx.addInitScript(() => {
  const all = (window.__es = []);
  window.EventSource = class { constructor(url) { this.url = url; this.readyState = 1; this.l = {}; all.push(this); setTimeout(() => (this.l.open || []).forEach(f => f({})), 0); } addEventListener(n, f) { (this.l[n] ||= []).push(f); } close() { this.readyState = 2; } };
  window.__emit = (name, data) => all.forEach(e => (e.l[name] || []).forEach(f => f({ data: JSON.stringify(data), lastEventId: '' })));
});
await ctx.route(u => u.pathname === '/grid', async route => { const r = await route.fetch(); const html = (await r.text()).replace(/(<script type="application\/json" id="boot"[^>]*>)([\s\S]*?)(<\/script>)/, (_, a, j, c) => { const b = JSON.parse(j); b.fleet = FLEET; b.live = FLEET.length; return a + JSON.stringify(b).replace(/</g, '\\u003c') + c; }); const headers = { ...r.headers() }; delete headers['content-encoding']; delete headers['content-length']; await route.fulfill({ status: r.status(), headers, body: html }); });
await ctx.route(u => ['/term/', '/term'].includes(u.pathname), r => r.fulfill({ contentType: 'text/html; charset=utf-8', body: PAGE }));
await ctx.route('**/term/token', r => r.fulfill({ contentType: 'application/json', body: '{"token":""}' }));
await ctx.route('**/settings/term-theme.json', r => r.fulfill({ contentType: 'application/json', body: '{"name":""}' }));
await ctx.route('**/shot', r => r.fulfill({ contentType: 'application/json', body: '{"ok":true,"path":"/tmp/shot-1.png"}' }));
await ctx.route('**/z?*', r => r.fulfill({ status: 204 }));
await ctx.route('**/api/**', r => r.fulfill({ status: 200, contentType: 'application/json', body: '{}' }));
const socks = []; // per socket: the url and the input frames it received
await ctx.routeWebSocket(/\/term\/ws/, ws => { const s = { url: ws.url(), inputs: [], ws, closed: false }; socks.push(s); ws.onMessage(m => { const b = typeof m === 'string' ? Buffer.from(m) : m; if (b[0] === 0x30) s.inputs.push(b.subarray(1).toString()); }); ws.onClose(() => { s.closed = true; }); });
const page = await ctx.newPage();
const errors = []; page.on('pageerror', e => errors.push(String(e)));
await page.goto(DASH + '/grid', { waitUntil: 'load' });
await page.waitForSelector('#grid');
let bad = 0;
const check = (id, ok, d) => { if (!ok) bad++; console.log(`${ok ? 'PASS' : 'FAIL'} ${id}${d === undefined ? '' : ' ' + JSON.stringify(d)}`); };
const sleep = ms => new Promise(r => setTimeout(r, ms));
// where the keyboard is: the parent's activeElement, and inside the focused pane frame, whether xterm's textarea is the active element
const where = async () => page.evaluate(() => { const a = document.activeElement; const f = a && a.tagName === 'IFRAME' ? a : null; const d = f && f.contentDocument; return { top: a ? a.tagName + (a.className ? '.' + String(a.className).split(' ')[0] : '') + (a.closest?.('.gp') ? '@' + a.closest('.gp').dataset.name : '') : null, inner: d ? (d.activeElement ? d.activeElement.tagName + (d.activeElement.className ? '.' + d.activeElement.className : '') : null) : null, hasFocus: document.hasFocus() }; });
const frameOf = name => page.frames().find(f => f.url().includes(encodeURIComponent(name)));
const typed = name => { const s = socks.filter(s => s.url.includes(encodeURIComponent(name))).at(-1); return s ? s.inputs.join('') : null; };
const typeAndSee = async (id, name) => { const before = (typed(name) || '').length; await page.keyboard.type('ab'); await sleep(200); const got = (typed(name) || '').slice(before); check(id, got === 'ab', { got, where: await where() }); };

// 1. click a sidebar row: a new pane; type right away
await page.click('#gsb .gr[data-name="cc-a-one"]');
await page.waitForFunction(() => [...document.querySelectorAll('iframe.gfr')].every(f => f.contentWindow?.term));
await sleep(600);
console.log('after row click', await where());
await typeAndSee('1 row click -> typing lands in the pane', 'cc-a-one');
// 2. click into the terminal, then move the mouse around
await page.click('.gw:not([hidden]) .gp.on iframe', { position: { x: 300, y: 300 } });
await sleep(100);
await typeAndSee('2 after a click in the terminal', 'cc-a-one');
for (const [x, y] of [[100, 300], [120, 320], [140, 340], [700, 30], [900, 60], [700, 500], [60, 200], [1400, 20]]) { await page.mouse.move(x, y); await sleep(40); }
await typeAndSee('3 after mouse moves over sidebar, strip, pane header, pane', 'cc-a-one');
// 4. a fleet event (the 2 s stream) re-renders the grid
await page.evaluate(F => window.__emit('fleet', F.map(f => ({ ...f, rel: f.rel + 1000, snippet: 'x' }))), FLEET);
await sleep(300);
await typeAndSee('4 after a fleet event', 'cc-a-one');
// 5. split a second pane: typing should go to the new one
await page.click('#gsb .gr[data-name="cc-a-two"]', { modifiers: ['Shift'] });
await page.waitForFunction(() => [...document.querySelectorAll('iframe.gfr')].every(f => f.contentWindow?.term));
await sleep(600);
console.log('after split', await where());
await typeAndSee('5 split -> typing lands in the new pane', 'cc-a-two');
// 6. zoom button on the pane header
await page.click('.gw:not([hidden]) .gp.on .gzoom');
await sleep(300);
console.log('after zoom click', await where());
await typeAndSee('6 zoom button -> typing still lands in the pane', 'cc-a-two');
await page.click('.gw:not([hidden]) .gp.on .gzoom'); await sleep(200);
// 7. open a second tab via the row, then click the first tab in the strip
await page.click('#gsb .gr[data-name="cc-b-three"]');
await page.waitForFunction(() => [...document.querySelectorAll('iframe.gfr')].every(f => f.contentWindow?.term));
await sleep(600);
await typeAndSee('7 new tab -> typing lands in its pane', 'cc-b-three');
await page.click('#gtabs .gt:first-child');
await sleep(400);
console.log('after strip click', await where());
await typeAndSee('8 strip tab click -> typing lands in the focused pane of that tab', 'cc-a-two');
// 9. a file dropped on the pane: /shot, then the path pasted, then typing goes on
{
  const f = frameOf('cc-a-two');
  await f.evaluate(() => { const dt = new DataTransfer(); dt.items.add(new File(['PNGDATA'], 'shot.png', { type: 'image/png' })); document.body.dispatchEvent(new DragEvent('drop', { dataTransfer: dt, bubbles: true, cancelable: true })); });
  await sleep(500);
  const t = typed('cc-a-two') || '';
  check('9 dropped file: the path is pasted', t.includes('/tmp/shot-1.png'), t.slice(-60));
  await typeAndSee('9b after the drop, typing still lands in the pane', 'cc-a-two');
}
// 10. the socket dies (not a clean 1000): does the pane reconnect by itself, and does typing arrive on the new socket?
{
  const s = socks.filter(s => s.url.includes('cc-a-two')).at(-1); const n = socks.length;
  s.ws.close({ code: 4000, reason: 'dropped' });
  await sleep(1500);
  check('10 a dropped socket reconnects by itself', socks.length > n && !socks.at(-1).closed, { sockets: socks.length, overlay: await frameOf('cc-a-two').evaluate(() => document.getElementById('ccovl')?.textContent) });
  await typeAndSee('10b typing after the reconnect lands on the new socket', 'cc-a-two');
}
// 11. the socket dies with a network error: the browser fires error then close 1006. A route cannot fake 1006; the page's own code path is read instead.
check('errors', errors.length === 0, errors);
console.log(bad ? `${bad} FAILED` : 'ALL PASS');
await ctx.close(); await browser.close();
process.exit(bad ? 1 : 0);
