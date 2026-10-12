// Grid view probe (docs/superpowers/specs/2026-10-11-grid-view-design.md). Exit code is the verdict.
// usage: node docs/qa/probes/grid-check.mjs <chromium|webkit> <open|groups|persist|ended|phone|drag|keys|tabs|park|leak|all>
// env: DASH (default http://127.0.0.1:3105), PLAYWRIGHT (module path; default: the repo's)
// Runs against the shell on the dev instance with a FIXTURE fleet (boot snapshot rewritten in flight, EventSource faked, every /term/*
// answered with a stub page that speaks the grid-mod / grid-key messages), so nothing here reaches ttyd or a real session.
const pw = await import(process.env.PLAYWRIGHT || 'playwright').catch(() => { console.error('grid-check: playwright is not installed (npm ci --ignore-scripts)'); process.exit(2); });
const engine = process.argv[2] || 'chromium';
const mode = process.argv[3] || 'all';
const MODES = ['open', 'groups', 'persist', 'ended', 'phone', 'drag', 'keys', 'tabs', 'park', 'leak'];
if (mode !== 'all' && !MODES.includes(mode)) { console.error(`grid-check: mode is one of ${MODES.join(' ')} all`); process.exit(2); }
const DASH = process.env.DASH || 'http://127.0.0.1:3105';
const browser = await pw[engine].launch();
let bad = 0, errors = [], cur = '';
const check = (id, ok, detail) => { if (!ok) bad++; console.log(`${ok ? 'PASS' : 'FAIL'} ${mode === 'all' ? cur + ' ' : ''}${id}${detail === undefined ? '' : ' ' + JSON.stringify(detail)}`); };
const T = Date.now();
const fx = (sid8, name, label, proj, state, age, snippet = '') => ({ sid8, name, label, proj, state, rel: T - age * 1000, snippet });
const FLEET = [
  fx('aaaa1111', 'cc-alpha-api', 'api', 'alpha', 'working', 20, 'building'),
  fx('bbbb2222', 'cc-alpha-web', 'web', 'alpha', 'needs-you', 300, 'approve? [y/n]'),
  fx('cccc3333', 'cc-beta-data', '', 'beta', 'idle', 4000),
  fx('dddd4444', 'cc-beta-infra', 'infra', 'beta', 'paused', 900),
  fx('eeee5555', 'cc-gamma-x', 'x', 'gamma', 'idle', 90000),
  fx('ffff6666', 'cc-gamma-y', 'y', 'gamma', 'idle', 90001),
  fx('0000aaaa', 'cc-gamma-z', 'z', 'gamma', 'idle', 90002),
];
// the stub /term/ page: records the mod it was told, can send a chord up, and counts its own loads in sessionStorage so a remount is visible
const TERM = `<!doctype html><title>term</title><body data-stub=1><script>
addEventListener('message', e => { if (e.data && e.data.t === 'grid-mod') { window.__mod = e.data.mod; document.body.dataset.mod = e.data.mod; } });
window.__send = key => parent.postMessage({ t: 'grid-key', key }, location.origin);
</script>term</body>`;
async function open(opts = {}) {
  const { w = 1600, h = 900, fleet = FLEET, touch = false, keep } = opts;
  const ctx = keep || await browser.newContext({ viewport: { width: w, height: h }, hasTouch: touch, serviceWorkers: 'block' });
  if (!keep) {
    await ctx.addInitScript(() => {
      const all = (window.__es = []);
      window.EventSource = class { constructor(url) { this.url = url; this.readyState = 1; this.l = {}; all.push(this); setTimeout(() => (this.l.open || []).forEach(f => f({})), 0); } addEventListener(n, f) { (this.l[n] ||= []).push(f); } close() { this.readyState = 2; } };
      window.__emit = (name, data) => all.forEach(e => (e.l[name] || []).forEach(f => f({ data: JSON.stringify(data), lastEventId: '' })));
      window.__now = 0; const dn = Date.now.bind(Date); Date.now = () => dn() + window.__now; // the probe moves the clock for parking
    });
    await ctx.route(u => u.pathname === '/grid', async route => {
      const r = await route.fetch();
      const html = (await r.text()).replace(/(<script type="application\/json" id="boot"[^>]*>)([\s\S]*?)(<\/script>)/, (_, a, j, c) => { const b = JSON.parse(j); b.fleet = fleet; b.live = fleet.length; return a + JSON.stringify(b).replace(/</g, '\\u003c') + c; });
      const headers = { ...r.headers() }; delete headers['content-encoding']; delete headers['content-length'];
      await route.fulfill({ status: r.status(), headers, body: html });
    });
    await ctx.route('**/term/**', r => r.fulfill({ status: 200, contentType: 'text/html', body: TERM }));
    await ctx.route('**/z?*', r => r.fulfill({ status: 204 }));
    await ctx.route('**/api/**', r => r.fulfill({ status: 200, contentType: 'application/json', body: '{}' }));
  }
  const page = await ctx.newPage();
  page.on('console', m => { if (m.type() === 'error' && !/interactive-widget/.test(m.text())) errors.push(m.text()); });
  page.on('pageerror', e => errors.push(String(e)));
  await page.goto(DASH + '/grid', { waitUntil: 'load' });
  await page.waitForSelector('#grid, [data-view=grid-phone]', { state: 'attached' });
  return { ctx, page };
}
const st = page => page.evaluate(() => window.__grid.state());
const panes = page => page.$$eval('.gw:not([hidden]) .gp', ps => ps.map(p => ({ name: p.dataset.name, on: p.classList.contains('on'), needs: p.classList.contains('needs'), ended: p.classList.contains('ended'), src: p.querySelector('iframe')?.getAttribute('src') || '', shown: p.getClientRects().length > 0 })));
const tabs = page => page.$$eval('#gtabs .gt', ts => ts.map(t => ({ id: t.dataset.id, on: t.classList.contains('on'), text: t.textContent.trim(), state: t.querySelector('.gdot')?.dataset.state })));
const row = (page, name) => page.locator(`#gsb .gr[data-name="${name}"]`);

async function openMode() {
  const { ctx, page } = await open();
  check('1 mounts: body.gridv, sidebar, empty tab strip, 7 rows', await page.evaluate(() => document.body.classList.contains('gridv') && !!document.querySelector('#gsb') && document.querySelectorAll('#gtabs .gt').length === 0 && document.querySelectorAll('#gsb .gr').length === 7));
  await row(page, 'cc-alpha-api').click();
  let p = await panes(page), t = await tabs(page);
  check('2 click a row: one tab, one pane, iframe src attaches that name with a tab id', t.length === 1 && t[0].on && p.length === 1 && /^\/term\/\?arg=attach&arg=cc-alpha-api&arg=[0-9a-f]{8}&v=3$/.test(p[0].src) && p[0].on, p);
  check('3 the row is marked open', await row(page, 'cc-alpha-api').getAttribute('data-open') === '1');
  await row(page, 'cc-alpha-web').locator('.gsplit').click();
  p = await panes(page);
  check('4 split: two panes in the same tab, focus on the new one, needs-you class', (await tabs(page)).length === 1 && p.map(x => x.name).join() === 'cc-alpha-api,cc-alpha-web' && p[1].on && p[1].needs, p);
  const src0 = p[0].src;
  await row(page, 'cc-beta-data').click();
  check('5 click another row: a second tab, the first tab hidden but mounted', (await tabs(page)).length === 2 && await page.evaluate(() => document.querySelectorAll('.gw').length === 2 && document.querySelectorAll('.gw[hidden] iframe').length === 2));
  await row(page, 'cc-alpha-api').click();
  p = await panes(page);
  check('6 click an open row: back to its tab, same iframe (src unchanged -> no second socket)', (await tabs(page))[0].on && p[0].src === src0 && await page.evaluate(() => document.querySelectorAll('iframe[src*="cc-alpha-api"]').length === 1));
  await row(page, 'cc-beta-data').locator('.gsplit').click();
  check('7 split of a session open in another tab goes to that tab instead', (await tabs(page))[1].on && (await panes(page)).length === 1);
  await row(page, 'cc-alpha-api').click();
  for (const n of ['cc-beta-infra', 'cc-gamma-x', 'cc-gamma-y', 'cc-gamma-z']) await row(page, n).locator('.gsplit').click();
  p = await panes(page);
  check('8 six panes in 3 columns and 2 rows, each ≥ 160 px wide', p.length === 6 && (await st(page)).tabs[0].cols.length === 3 && await page.evaluate(() => { const r = [...document.querySelectorAll('.gw:not([hidden]) .gp')].map(x => x.getBoundingClientRect()); return r.every(x => x.width >= 160) && new Set(r.map(x => Math.round(x.top))).size === 2; }));
  await page.evaluate(() => window.__emit('fleet', [...window.__grid.fleet(), { sid8: '9999zzzz', name: 'cc-seven', label: '7', proj: 'zeta', state: 'idle', rel: Date.now(), snippet: '' }]));
  await row(page, 'cc-seven').locator('.gsplit').click();
  check('9 the 7th split is refused with a notice; still 6 panes', (await panes(page)).length === 6 && /6 panes/.test(await page.locator('#gnotice').textContent()));
  await page.locator('.gw:not([hidden]) .gp[data-name="cc-gamma-z"] .gclose').click();
  check('10 close a pane: 5 left, the others keep their iframes (not reloaded)', (await panes(page)).length === 5 && await page.evaluate(() => [...document.querySelectorAll('.gw:not([hidden]) iframe')].every(f => f.contentDocument?.body?.dataset.stub === '1')));
  await page.locator('#gtabs .gt.on .gx').click();
  check('11 close the active tab: the other becomes active', (await tabs(page)).length === 1 && (await tabs(page))[0].on);
  check('12 no console or page errors', errors.length === 0, errors);
  await ctx.close();
}
async function groupsMode() {
  const { ctx, page } = await open();
  const groups = () => page.$$eval('#gsb details.gg', ds => ds.map(d => ({ proj: d.dataset.proj, open: d.open, sum: d.querySelector('summary').textContent.trim(), rows: [...d.querySelectorAll('.gr')].map(r => r.dataset.name) })));
  let g = await groups();
  check('1 grouped by proj, most urgent group first, open, needs count in the summary', g.map(x => x.proj).join() === 'alpha,beta,gamma' && g[0].sum === 'alpha · 1' && g[1].sum === 'beta' && g.every(x => x.open), g);
  check('2 rows inside a group follow needs-you < working < paused < idle', g[0].rows.join() === 'cc-alpha-web,cc-alpha-api' && g[1].rows.join() === 'cc-beta-infra,cc-beta-data');
  await page.click('#ggroup');
  check('3 flat: no groups, rows in fleet order, button reads grouped', await page.evaluate(() => document.querySelectorAll('#gsb details.gg').length === 0 && document.querySelectorAll('#gsb .gr').length === 7) && (await page.locator('#ggroup').textContent()) === 'grouped');
  await page.fill('#gsb input[data-f=filter]', 'gam');
  check('4 filter narrows rows by label, proj and snippet', await page.$$eval('#gsb .gr', rs => rs.filter(r => r.getClientRects().length).map(r => r.dataset.name).join()) === 'cc-gamma-x,cc-gamma-y,cc-gamma-z');
  check('5 mod select shows the detected modifier and the three labels', await page.$eval('#gmod', s => [...s.options].map(o => o.textContent).join() === '⌘⇧,Ctrl⇧,Alt' && ['mac', 'win', 'alt'].includes(s.value)));
  await ctx.close();
}
async function persistMode() {
  const { ctx, page } = await open();
  await row(page, 'cc-alpha-api').click(); await row(page, 'cc-alpha-web').locator('.gsplit').click(); await row(page, 'cc-beta-data').click();
  await page.selectOption('#gmod', 'alt'); await page.click('#ggroup');
  await page.waitForTimeout(400);
  const stored = await page.evaluate(() => JSON.parse(localStorage.getItem('grid.v1')));
  check('1 stored: two tabs, panes by name, mod alt, grouped false, no notice', stored.tabs.length === 2 && stored.tabs[0].panes.join() === 'cc-alpha-api,cc-alpha-web' && stored.mod === 'alt' && stored.grouped === false && !('notice' in stored), stored);
  await page.reload({ waitUntil: 'load' }); await page.waitForSelector('#grid');
  check('2 reload restores tabs, active tab and the select', (await tabs(page)).length === 2 && (await tabs(page))[1].on && (await page.$eval('#gmod', s => s.value)) === 'alt');
  await page.evaluate(() => { const s = JSON.parse(localStorage.getItem('grid.v1')); s.tabs[0].panes.push('cc-dead'); s.tabs.push({ id: 't9', panes: ['cc-gone'], cols: [1], focus: 0, zoom: null }); localStorage.setItem('grid.v1', JSON.stringify(s)); });
  await page.reload({ waitUntil: 'load' }); await page.waitForSelector('#grid');
  check('3 names not in the fleet are dropped and reported; the empty tab is gone', (await tabs(page)).length === 2 && /dropped 2 ended sessions/.test(await page.locator('#gnotice').textContent()) && await page.evaluate(() => document.querySelectorAll('iframe[src*="cc-dead"], iframe[src*="cc-gone"]').length === 0));
  await ctx.close();
}
async function endedMode() {
  const { ctx, page } = await open();
  await row(page, 'cc-alpha-api').click(); await row(page, 'cc-alpha-web').locator('.gsplit').click();
  await page.evaluate(() => window.__emit('fleet', window.__grid.fleet().filter(f => f.name !== 'cc-alpha-web')));
  await page.waitForFunction(() => document.querySelector('.gp[data-name="cc-alpha-web"]')?.classList.contains('ended'));
  const p = await panes(page);
  check('1 a session gone from the fleet marks its pane ended, header says ended, iframe stays', p[1].ended && /ended/.test(await page.locator('.gp[data-name="cc-alpha-web"] .gph').textContent()) && p[1].src.includes('cc-alpha-web'));
  check('2 the sidebar no longer lists it', await page.locator('#gsb .gr[data-name="cc-alpha-web"]').count() === 0);
  await page.locator('.gp[data-name="cc-alpha-web"] .gclose').click();
  check('3 close removes it', (await panes(page)).length === 1);
  await ctx.close();
}
async function phoneMode() {
  const { ctx, page } = await open({ w: 390, h: 844, touch: true });
  check('1 a touch / narrow device gets the note and a link to /', await page.evaluate(() => !!document.querySelector('[data-view=grid-phone] a[href="/"]') && !document.querySelector('#grid')));
  await ctx.close();
}
const RUN = { open: openMode, groups: groupsMode, persist: persistMode, ended: endedMode, phone: phoneMode };
for (const m of mode === 'all' ? Object.keys(RUN) : [mode]) { cur = m; if (RUN[m]) await RUN[m](); else console.log(`SKIP ${m} (added by a later task)`); }
await browser.close();
console.log(bad ? `grid-check: ${bad} FAIL` : 'grid-check: all pass');
process.exit(bad ? 1 : 0);
