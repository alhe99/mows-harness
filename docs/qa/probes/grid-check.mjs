// Grid view probe (docs/superpowers/specs/2026-10-11-grid-view-design.md). Exit code is the verdict.
// usage: node docs/qa/probes/grid-check.mjs <chromium|webkit> <open|groups|persist|ended|phone|drag|keys|tabs|park|leak|sidebar|deeplink|picker|kill|svc|all>
// env: DASH (default http://127.0.0.1:3105), PLAYWRIGHT (module path; default: the repo's)
// Runs against the shell on the dev instance with a FIXTURE fleet (boot snapshot rewritten in flight, EventSource faked, every /term/*
// answered with a stub page that speaks the grid-mod / grid-key messages), so nothing here reaches ttyd or a real session.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
const pw = await import(process.env.PLAYWRIGHT || 'playwright').catch(() => { console.error('grid-check: playwright is not installed (npm ci --ignore-scripts)'); process.exit(2); });
const engine = process.argv[2] || 'chromium';
const mode = process.argv[3] || 'all';
const MODES = ['open', 'groups', 'persist', 'ended', 'phone', 'drag', 'keys', 'tabs', 'park', 'leak', 'sidebar', 'deeplink', 'picker', 'kill', 'svc'];
if (mode !== 'all' && !MODES.includes(mode)) { console.error(`grid-check: mode is one of ${MODES.join(' ')} all`); process.exit(2); }
const DASH = process.env.DASH || 'http://127.0.0.1:3105';
const browser = await pw[engine].launch();
let bad = 0, errors = [], cur = '', posted = []; // posted: bodies sent to /a/label (rename)
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
// the stub /term/ page: records the mod it was told, can send a chord up, forwards the grid chords typed into it as the real page's
// forwarder does (web/pages/term/gridkeys.mjs, with the shell's own decoder inlined), and counts its own loads in the parent's
// window.__loads (keyed by its query, which names the session and the tab id) so a remount or reload of a pane is visible
const KEYS = readFileSync(join(import.meta.dirname, '../../../web/grid/keys.mjs'), 'utf8').replace(/^export /gm, '');
const TERM = `<!doctype html><title>term</title><body data-stub=1><script>
const L = parent.__loads || (parent.__loads = {}); L[location.search] = (L[location.search] || 0) + 1;
addEventListener('message', e => { if (e.data && e.data.t === 'grid-mod') { window.__mod = e.data.mod; document.body.dataset.mod = e.data.mod; } });
window.__send = key => parent.postMessage({ t: 'grid-key', key }, location.origin);
</script><script type="module">${KEYS}
addEventListener('keydown', e => { const key = chordOf(e, window.__mod || detectMod()); if (key) { e.preventDefault(); window.__send(key); } });
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
    await ctx.route('**/a/label', r => { posted.push(r.request().postData()); r.fulfill({ status: 204 }); }); // the real route answers 303; fetch(redirect: 'manual') ignores it either way, and WebKit's fulfill refuses a 3xx
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
// never-reload guard: wait until every pane iframe has loaded its stub, then tag each contentWindow; kept() is true while every iframe
// still holds its tag (a re-inserted or reloaded iframe gets a fresh window at once) and every stub has loaded exactly once
const mark = async page => {
  await page.waitForFunction(() => [...document.querySelectorAll('iframe.gfr')].every(f => f.contentDocument?.body?.dataset.stub === '1' && window.__loads?.[new URL(f.src).search] >= 1));
  await page.evaluate(() => document.querySelectorAll('iframe.gfr').forEach(f => { f.contentWindow.__mark = 1; }));
};
const kept = async page => { await page.waitForTimeout(300); return page.evaluate(() => [...document.querySelectorAll('iframe.gfr')].map(f => ({ name: f.closest('.gp')?.dataset.name, mark: f.contentWindow?.__mark === 1, loads: window.__loads?.[new URL(f.src).search] || 0 }))); };
const allKept = k => k.length > 0 && k.every(x => x.mark && x.loads === 1);

async function openMode() {
  const { ctx, page } = await open();
  check('1 mounts: body.gridv, sidebar, empty tab strip, 7 rows', await page.evaluate(() => document.body.classList.contains('gridv') && !!document.querySelector('#gsb') && document.querySelectorAll('#gtabs .gt').length === 0 && document.querySelectorAll('#gsb .gr').length === 7));
  await row(page, 'cc-alpha-api').click();
  let p = await panes(page), t = await tabs(page);
  check('2 click a row: one tab, one pane, iframe src attaches that name with a tab id', t.length === 1 && t[0].on && p.length === 1 && /^\/term\/\?arg=attach&arg=cc-alpha-api&arg=[0-9a-f]{8}&v=3$/.test(p[0].src) && p[0].on, p);
  check('3 the row is marked open', await row(page, 'cc-alpha-api').getAttribute('data-open') === '1');
  await row(page, 'cc-alpha-web').click({ modifiers: ['Shift'] });
  p = await panes(page);
  check('4 split: two panes in the same tab, focus on the new one, needs-you class', (await tabs(page)).length === 1 && p.map(x => x.name).join() === 'cc-alpha-api,cc-alpha-web' && p[1].on && p[1].needs, p);
  const src0 = p[0].src;
  await row(page, 'cc-beta-data').click();
  check('5 click another row: a second tab, the first tab hidden but mounted', (await tabs(page)).length === 2 && await page.evaluate(() => document.querySelectorAll('.gw').length === 2 && document.querySelectorAll('.gw[hidden] iframe').length === 2));
  await mark(page);
  await row(page, 'cc-alpha-api').click();
  p = await panes(page);
  let k = await kept(page);
  check('6 click an open row: back to its tab, same iframe (src unchanged -> no second socket), no iframe reloaded', (await tabs(page))[0].on && p[0].src === src0 && await page.evaluate(() => document.querySelectorAll('iframe[src*="cc-alpha-api"]').length === 1) && k.length === 3 && allKept(k), k);
  await row(page, 'cc-beta-data').click({ modifiers: ['Shift'] });
  check('7 split of a session open in another tab goes to that tab instead', (await tabs(page))[1].on && (await panes(page)).length === 1);
  await row(page, 'cc-alpha-api').click();
  for (const n of ['cc-beta-infra', 'cc-gamma-x', 'cc-gamma-y', 'cc-gamma-z']) await row(page, n).click({ modifiers: ['Shift'] });
  p = await panes(page);
  check('8 six panes in 3 columns and 2 rows, each ≥ 160 px wide', p.length === 6 && (await st(page)).tabs[0].cols.length === 3 && await page.evaluate(() => { const r = [...document.querySelectorAll('.gw:not([hidden]) .gp')].map(x => x.getBoundingClientRect()); return r.every(x => x.width >= 160) && new Set(r.map(x => Math.round(x.top))).size === 2; }));
  await page.evaluate(() => window.__emit('fleet', [...window.__grid.fleet(), { sid8: '9999zzzz', name: 'cc-seven', label: '7', proj: 'zeta', state: 'idle', rel: Date.now(), snippet: '' }]));
  await row(page, 'cc-seven').click({ modifiers: ['Shift'] });
  check('9 the 7th split is refused with a notice; still 6 panes', (await panes(page)).length === 6 && /6 panes/.test(await page.locator('#gnotice').textContent()));
  await mark(page);
  await page.locator('.gw:not([hidden]) .gp[data-name="cc-gamma-z"] .gclose').click();
  k = await kept(page);
  check('10 close a pane: 5 left, the others keep their iframes (not reloaded)', (await panes(page)).length === 5 && k.length === 6 && allKept(k), k);
  await page.setViewportSize({ width: 900, height: 900 });
  await page.evaluate(() => window.__emit('fleet', window.__grid.fleet().map(f => ({ ...f, rel: f.rel + 1 }))));
  k = await kept(page);
  const narrow = await page.evaluate(() => !!document.querySelector('#grid') && !document.querySelector('[data-view=grid-phone]'));
  await page.setViewportSize({ width: 1600, height: 900 });
  await page.evaluate(() => window.__emit('fleet', window.__grid.fleet().map(f => ({ ...f, rel: f.rel + 1 }))));
  const k2 = await kept(page);
  check('10b a desktop window narrowed below 1024 px and widened again keeps the grid and every iframe across fleet ticks', narrow && k.length === 6 && allKept(k) && k2.length === 6 && allKept(k2), { narrow, k, k2 });
  await page.locator('#gtabs .gt.on .gx').click();
  check('11 close the active tab: the other becomes active', (await tabs(page)).length === 1 && (await tabs(page))[0].on);
  check('12 no console or page errors', errors.length === 0, errors);
  await ctx.close();
}
async function groupsMode() {
  const { ctx, page } = await open();
  // rename: the pencil turns the label into an input, Enter posts /a/label; the fleet stream brings the new label; Escape cancels without a post
  await row(page, 'cc-alpha-api').locator('.gren').click();
  await page.waitForFunction(() => /** @type {any} */ (document.activeElement)?.name === 'label'); // focus lands on the next frame
  check('0a the pencil opens the rename input with the current label selected, no tab opened', await page.evaluate(() => { const i = document.querySelector('#gsb .gr[data-name="cc-alpha-api"] .grn input[name=label]'); return !!i && document.activeElement === i && i.value === 'api' && i.selectionEnd === 3; }));
  await page.keyboard.type('billing'); await page.keyboard.press('Enter');
  await page.waitForFunction(() => !document.querySelector('#gsb .grn'));
  await page.evaluate(() => window.__emit('fleet', window.__grid.fleet().map(f => (f.name === 'cc-alpha-api' ? { ...f, label: 'billing' } : f))));
  check('0b Enter posts name and label, the input closes, the row shows the label the stream brings', posted.join() === 'name=cc-alpha-api&label=billing' && (await row(page, 'cc-alpha-api').locator('.lb').textContent()) === 'billing' && (await st(page)).tabs.length === 0);
  await row(page, 'cc-alpha-api').locator('.gren').click(); await page.waitForFunction(() => /** @type {any} */ (document.activeElement)?.name === 'label');
  await page.keyboard.type('x'); await page.keyboard.press('Escape');
  check('0c Escape cancels without a post', !(await page.$('#gsb .grn')) && posted.length === 1);
  const groups = () => page.$$eval('#gsb details.gg', ds => ds.map(d => ({ proj: d.dataset.proj, open: d.open, sum: d.querySelector('summary').textContent.trim(), rows: [...d.querySelectorAll('.gr')].map(r => r.dataset.name) })));
  let g = await groups();
  check('1 grouped by proj, most urgent group first, open, needs count in the summary', g.map(x => x.proj).join() === 'alpha,beta,gamma' && g[0].sum === 'alpha · 1' && g[1].sum === 'beta' && g.every(x => x.open), g);
  check('2 rows inside a group follow needs-you < working < paused < idle', g[0].rows.join() === 'cc-alpha-web,cc-alpha-api' && g[1].rows.join() === 'cc-beta-infra,cc-beta-data');
  await page.click('#ggroup');
  check('3 flat: no groups, rows in fleet order, button reads grouped', await page.evaluate(() => document.querySelectorAll('#gsb details.gg').length === 0 && document.querySelectorAll('#gsb .gr').length === 7) && (await page.locator('#ggroup').textContent()) === 'grouped');
  check('4 the sidebar head is the group toggle only: no filter box, no modifier select (that lives on /system)', await page.evaluate(() => !document.querySelector('#gsb input') && !document.querySelector('#gmod') && !!document.querySelector('#ggroup')));
  await ctx.close();
}
async function persistMode() {
  const { ctx, page } = await open();
  await row(page, 'cc-alpha-api').click(); await row(page, 'cc-alpha-web').click({ modifiers: ['Shift'] }); await row(page, 'cc-beta-data').click();
  await page.evaluate(() => window.__grid.dispatch(s => ({ ...s, mod: 'alt' }))); await page.click('#ggroup');
  await page.waitForTimeout(400);
  const stored = await page.evaluate(() => JSON.parse(localStorage.getItem('grid.v1')));
  check('1 stored: two tabs, panes by name, mod alt, grouped false, no notice', stored.tabs.length === 2 && stored.tabs[0].panes.join() === 'cc-alpha-api,cc-alpha-web' && stored.mod === 'alt' && stored.grouped === false && !('notice' in stored), stored);
  await page.reload({ waitUntil: 'load' }); await page.waitForSelector('#grid');
  check('2 reload restores tabs, active tab and the modifier', (await tabs(page)).length === 2 && (await tabs(page))[1].on && (await st(page)).mod === 'alt');
  await page.evaluate(() => { const s = JSON.parse(localStorage.getItem('grid.v1')); s.tabs[0].panes.push('cc-dead'); s.tabs.push({ id: 't9', panes: ['cc-gone'], cols: [1], focus: 0, zoom: null }); localStorage.setItem('grid.v1', JSON.stringify(s)); });
  await page.reload({ waitUntil: 'load' }); await page.waitForSelector('#grid');
  check('3 names not in the fleet are dropped and reported; the empty tab is gone', (await tabs(page)).length === 2 && /dropped 2 ended sessions/.test(await page.locator('#gnotice').textContent()) && await page.evaluate(() => document.querySelectorAll('iframe[src*="cc-dead"], iframe[src*="cc-gone"]').length === 0));
  await ctx.close();
}
async function endedMode() {
  const { ctx, page } = await open();
  await row(page, 'cc-alpha-api').click(); await row(page, 'cc-alpha-web').click({ modifiers: ['Shift'] });
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
  const n = await open({ w: 900, h: 900 });
  const note = await n.page.evaluate(() => !!document.querySelector('[data-view=grid-phone]') && !document.querySelector('#grid'));
  await n.page.setViewportSize({ width: 1600, height: 900 });
  const grid = await n.page.waitForSelector('#grid #gsb', { timeout: 15000 }) /* WebKit on a loaded box: a 5 s wait flaked */.then(() => n.page.evaluate(() => document.body.classList.contains('gridv') && document.querySelectorAll('#gsb .gr').length === 7), () => false);
  check('2 a desktop window opened narrow shows the note, then mounts the grid once widened', note && grid, { note, grid });
  await n.ctx.close();
}
async function dragMode() {
  const { ctx, page } = await open();
  await row(page, 'cc-alpha-api').click(); await row(page, 'cc-alpha-web').click({ modifiers: ['Shift'] });
  const widths = () => page.$$eval('.gw:not([hidden]) .gp', ps => ps.map(p => Math.round(p.getBoundingClientRect().width)));
  const w0 = await widths();
  check('1 two equal columns to start', Math.abs(w0[0] - w0[1]) <= 2, w0);
  const hb = await page.locator('.gw:not([hidden]) .gh').first().boundingBox();
  await page.mouse.move(hb.x + 3, hb.y + 100); await page.mouse.down(); await page.mouse.move(hb.x - 200, hb.y + 100, { steps: 8 });
  check('2 while dragging #grid.drag is set (iframes ignore the pointer)', await page.evaluate(() => document.getElementById('grid').classList.contains('drag')));
  await page.mouse.up();
  const w1 = await widths();
  check('3 the left column shrank by about 200 px, the right grew, drag class cleared', w0[0] - w1[0] > 150 && w1[1] - w0[1] > 150 && !(await page.evaluate(() => document.getElementById('grid').classList.contains('drag'))), [w0, w1]);
  const cols = (await st(page)).tabs[0].cols;
  check('4 state holds normalised fractions', Math.abs(cols[0] + cols[1] - 1) < 1e-6 && cols[0] < 0.4, cols);
  const hb2 = await page.locator('.gw:not([hidden]) .gh').first().boundingBox(); // the handle where the first drag left it
  await page.mouse.move(hb2.x + 3, hb2.y + 100); await page.mouse.down(); await page.mouse.move(hb2.x + 120, hb2.y + 100, { steps: 4 }); await page.mouse.move(hb2.x - 2000, hb2.y + 100, { steps: 6 }); await page.mouse.up();
  check('5 a drag past the edge leaves the column at the 160 px minimum', (await widths())[0] >= 160 && (await widths())[0] < 200, await widths());
  const sb = await page.locator('#gh-sb').boundingBox();
  await page.mouse.move(sb.x + 3, sb.y + 200); await page.mouse.down(); await page.mouse.move(sb.x + 120, sb.y + 200, { steps: 6 }); await page.mouse.up();
  check('6 the sidebar handle resizes the sidebar and the state', Math.abs((await st(page)).sidebar - 380) <= 4 && Math.abs((await page.locator('#gsb').boundingBox()).width - 380) <= 4, (await st(page)).sidebar);
  await page.mouse.move(sb.x + 123, sb.y + 200); await page.mouse.down(); await page.mouse.move(sb.x + 900, sb.y + 200, { steps: 6 }); await page.mouse.up();
  check('7 clamped at 480', (await st(page)).sidebar === 480);
  await page.locator('#gh-sb').dblclick();
  check('8 double-click resets to 256', (await st(page)).sidebar === 256);
  await page.waitForTimeout(400); // the layout is saved 250 ms after the last change
  await page.reload({ waitUntil: 'load' }); await page.waitForSelector('#grid');
  check('9 fractions survive a reload', (await st(page)).tabs[0].cols[0] < 0.4);
  await ctx.close();
}
async function keysMode() {
  const { ctx, page } = await open();
  // once a chord has moved the keyboard into a pane, the next one travels stub -> postMessage -> shell: give it a moment to land
  const press = async k => { await page.keyboard.press(k); await page.waitForTimeout(80); };
  const typesInFocused = () => page.evaluate(() => document.activeElement === document.querySelector('.gw:not([hidden]) .gp.on iframe'));
  // the modifier is set on /system (stored before any tab exists) and read when the grid mounts
  await page.evaluate(() => localStorage.setItem('grid.v1', JSON.stringify({ mod: 'win' })));
  await page.reload({ waitUntil: 'load' }); await page.waitForSelector('#grid');
  for (const n of ['cc-alpha-api', 'cc-beta-data', 'cc-gamma-x']) await row(page, n).click();
  await row(page, 'cc-gamma-y').click({ modifiers: ['Shift'] });
  await page.waitForTimeout(200);
  check('1 every pane was told the modifier', await page.evaluate(() => [...document.querySelectorAll('iframe.gfr')].every(f => f.contentDocument.body.dataset.mod === 'win')));
  await page.click('#gtabs'); // focus outside any terminal
  await press('Control+Shift+Digit1');
  check('2 Mod+1 switches to tab 1 and the keyboard goes to its terminal', (await tabs(page))[0].on && await typesInFocused());
  await press('Control+Shift+ArrowDown'); // from inside tab 1's terminal now
  check('3 Mod+↓ next tab', (await tabs(page))[1].on);
  await press('Control+Shift+Digit3');
  const b4 = (await panes(page)).findIndex(p => p.on);
  await press('Control+Shift+ArrowRight');
  const a4 = (await panes(page)).findIndex(p => p.on);
  check('4 Mod+→ moves focus to the next pane (wrapping), and the keyboard with it', b4 >= 0 && a4 === (b4 + 1) % 2 && await typesInFocused(), [b4, a4]);
  await press('Control+Shift+KeyZ');
  check('5 Mod+Z zooms the focused pane (the other is display:none, still mounted)', (await panes(page)).filter(p => p.shown).length === 1 && (await panes(page)).length === 2);
  await press('Control+Shift+KeyZ');
  check('6 again unzooms', (await panes(page)).filter(p => p.shown).length === 2);
  // arrows while zoomed: the zoom follows the focus, so the pane that is shown is the one that types (and that a Mod+X would close)
  const zoomShown = async () => { const p = await panes(page), sh = p.filter(x => x.shown), s = await st(page), t = s.tabs.find(x => x.id === s.active); return { one: sh.length === 1 && sh[0].on, focus: t.focus, zoom: t.zoom }; };
  await press('Control+Shift+KeyZ');
  const z0 = await zoomShown();
  await page.evaluate(() => /** @type {HTMLElement} */ (document.querySelector('#ggroup')).focus()); // the keyboard back in the shell document, on a button
  const outside = await page.evaluate(() => document.activeElement === document.querySelector('#ggroup'));
  await press('Control+Shift+ArrowRight');
  const z1 = await zoomShown(), in1 = await typesInFocused();
  await press('Control+Shift+ArrowRight'); // now from inside the zoomed terminal
  const z2 = await zoomShown();
  check('6b zoomed, Mod+→ from the shell and then from inside the terminal: the zoom follows the focus, the shown pane is the focused one and has the keyboard', z0.one && outside && z1.one && z1.focus === (z0.focus + 1) % 2 && z1.zoom === z1.focus && in1 && z2.one && z2.focus === z0.focus && z2.zoom === z2.focus && await typesInFocused(), { z0, outside, z1, in1, z2 });
  await press('Control+Shift+KeyZ');
  // a chord sent from inside a terminal (the stub posts what the real page's forwarder posts)
  await page.frames().find(f => f.url().includes('cc-gamma-y')).evaluate(() => window.__send('tab:2'));
  await page.waitForFunction(() => document.querySelector('#gtabs .gt.on')?.dataset.id === window.__grid.state().tabs[1].id);
  check('7 a grid-key message from a pane switches tabs', (await tabs(page))[1].on);
  await page.frames().find(f => f.url().includes('cc-beta-data')).evaluate(() => window.__send('close'));
  await page.waitForFunction(() => document.querySelectorAll('#gtabs .gt').length === 2);
  check('8 close from inside the only pane closes its tab', (await tabs(page)).length === 2);
  const s9 = await st(page);
  await press('Control+Shift+KeyS');
  check('9 Mod+S is not a chord (the filter box is gone): the state is unchanged', JSON.stringify(await st(page)) === JSON.stringify(s9));
  await page.keyboard.press('Escape'); await page.click('#gtabs');
  await page.keyboard.press('Digit2'); // grouped order: alpha · web, api — row 2 is cc-alpha-api, already open in tab 1
  const s11 = await st(page);
  check('11 plain 2 outside a terminal acts on the second sidebar row (as on /): its tab becomes active', s11.tabs.find(t => t.id === s11.active).panes.includes('cc-alpha-api'));
  // dispatched straight at the shell's window: a real cross-origin postMessage to self would be dropped by the browser before onMsg ran
  const other = s11.tabs.findIndex(t => t.id !== s11.active), key = `tab:${other + 1}`;
  const sendAs = (origin, k) => page.evaluate(([o, k]) => dispatchEvent(new MessageEvent('message', { data: { t: 'grid-key', key: k }, origin: o })), [origin, key]);
  await sendAs('https://evil.example', key); await page.waitForTimeout(80);
  const s12 = await st(page);
  await sendAs(await page.evaluate(() => location.origin), key); await page.waitForTimeout(80);
  const c12 = await st(page);
  check('12 a grid-key message from another origin is ignored (state unchanged; the same message from the shell origin does act)', other >= 0 && errors.length === 0 && s12.active === s11.active && s12.tabs.every((t, i) => t.id === s11.tabs[i].id && t.focus === s11.tabs[i].focus) && c12.active === s11.tabs[other].id, { key, before: s11.active, evil: s12.active, control: c12.active });
  await ctx.close();
}
async function tabsMode() {
  const { ctx, page } = await open();
  for (const n of ['cc-alpha-api', 'cc-beta-data', 'cc-gamma-x']) await row(page, n).click();
  const ids0 = (await tabs(page)).map(t => t.id);
  await mark(page);
  const a = await page.locator('#gtabs .gt').nth(2).boundingBox(), b = await page.locator('#gtabs .gt').nth(0).boundingBox();
  await page.mouse.move(a.x + a.width / 2, a.y + a.height / 2); await page.mouse.down(); await page.mouse.move(b.x + 4, b.y + a.height / 2, { steps: 8 }); await page.mouse.up();
  const ids1 = (await tabs(page)).map(t => t.id);
  check('1 dragging the third tab onto the left half of the first puts it first', ids1.join() === [ids0[2], ids0[0], ids0[1]].join(), [ids0, ids1]);
  check('2 pane wrappers did not move: DOM order is still creation order, iframes not reloaded', await page.evaluate(ids => [...document.querySelectorAll('.gw')].map(w => w.dataset.tab).join() === ids.join() && [...document.querySelectorAll('iframe.gfr')].every(f => f.contentDocument?.body?.dataset.stub === '1'), ids0) && allKept(await kept(page)));
  await page.waitForTimeout(400); // the layout is saved 250 ms after the last change
  await page.reload({ waitUntil: 'load' }); await page.waitForSelector('#grid');
  check('3 the order survives a reload', (await tabs(page)).map(t => t.id).join() === ids1.join());
  await page.locator('#gtabs .gt').nth(1).click();
  await page.keyboard.press('Control+Shift+Digit1');
  check('4 a short press without movement is a click (no reorder)', (await tabs(page)).map(t => t.id).join() === ids1.join());
  // merge: a tab dropped onto the panes joins the tab on screen (tab 1 is active after Mod+1)
  const src = await page.locator('#gtabs .gt').nth(1).boundingBox(), gw = await page.locator('.gw:not([hidden])').boundingBox(), srcId = (await tabs(page))[1].id;
  await page.mouse.move(src.x + src.width / 2, src.y + src.height / 2); await page.mouse.down(); await page.mouse.move(gw.x + gw.width / 2, gw.y + gw.height / 2, { steps: 8 });
  check('5 while a tab is dragged the panes show the drop target and iframes ignore the pointer', await page.evaluate(() => document.getElementById('grid').classList.contains('tabdrag') && getComputedStyle(document.querySelector('iframe.gfr')).pointerEvents === 'none'));
  await page.mouse.up();
  const s5 = await st(page), t5 = s5.tabs.find(t => t.id === s5.active);
  check('6 dropped onto the panes: the dragged tab is gone, its pane is the active tab\'s second pane and focused, nothing else moved', s5.tabs.length === 2 && !s5.tabs.some(t => t.id === srcId) && s5.active === ids1[0] && t5.panes.length === 2 && t5.focus === 1 && (await panes(page)).length === 2 && !(await page.evaluate(() => document.getElementById('grid').classList.contains('drag'))), s5);
  // the way back: the pane header's own-tab button, shown only while the tab holds more than one pane
  check('7 a pane in a tab of two shows the own-tab button; a lone pane does not', await page.evaluate(() => document.querySelectorAll('.gw:not([hidden]) .gown').length === 2 && [...document.querySelectorAll('.gw[hidden] .gown')].length === 0));
  await page.locator('.gw:not([hidden]) .gp').nth(1).locator('.gown').click();
  const s7 = await st(page), t7 = s7.tabs.find(t => t.id === s7.active);
  check('8 the pane moves to a new tab right after its old one, active, with the old tab back to one pane and no own-tab button', s7.tabs.length === 3 && s7.tabs[1].id === s7.active && t7.panes.length === 1 && s7.tabs[0].panes.length === 1 && (await panes(page)).length === 1 && await page.evaluate(() => document.querySelectorAll('.gown').length === 0), s7);
  await ctx.close();
}
async function parkMode() {
  const { ctx, page } = await open();
  await row(page, 'cc-alpha-api').click(); await row(page, 'cc-beta-data').click(); // tab 2 active, tab 1 hidden
  const n = () => page.evaluate(() => document.querySelectorAll('iframe.gfr').length);
  check('1 both tabs mounted: two iframes', await n() === 2);
  await page.evaluate(() => { window.__now = 9 * 60 * 1000; window.__grid.sweep(); });
  check('2 at 9 minutes nothing is parked', await n() === 2 && (await page.evaluate(() => window.__grid.parked())).length === 0);
  await page.evaluate(() => { window.__now = 11 * 60 * 1000; window.__grid.sweep(); });
  await page.waitForFunction(() => document.querySelectorAll('iframe.gfr').length === 1);
  check('3 at 11 minutes the hidden tab is parked: one iframe left, the active tab untouched', (await page.evaluate(() => window.__grid.parked())).length === 1 && (await panes(page)).length === 1);
  await page.locator('#gtabs .gt').nth(0).click();
  await page.waitForFunction(() => document.querySelectorAll('iframe.gfr').length === 2);
  check('4 clicking the parked tab remounts its pane (a fresh iframe, same name)', (await panes(page))[0].name === 'cc-alpha-api' && (await page.evaluate(() => window.__grid.parked())).length === 0);
  // the page hidden (a background browser tab, a lid closed with the box awake): visibilitychange is faked, the clock moved by the probe
  const vis = (state, at) => page.evaluate(([v, ms]) => { window.__now = ms; Object.defineProperty(document, 'visibilityState', { value: v, configurable: true }); document.dispatchEvent(new Event('visibilitychange')); }, [state, at]);
  const sweepAt = ms => page.evaluate(m => { window.__now = m; window.__grid.sweep(); }, ms);
  const parkedN = () => page.evaluate(() => window.__grid.parked().length);
  const M = 60 * 1000;
  // a suspended laptop: no sweep runs while hidden, so the tab on screen still has its iframe on return
  await mark(page);
  await vis('hidden', 11 * M); await vis('visible', 22 * M + 1000);
  await page.waitForTimeout(300);
  const k5 = await kept(page);
  check('5 hidden 11 minutes with no sweep meanwhile (suspended): the other tab parked, the tab on screen kept its iframe', await parkedN() === 1 && await n() === 1 && k5.length === 1 && k5[0].name === 'cc-alpha-api' && k5[0].mark, k5);
  // awake but hidden: the sweep keeps running; at 9 minutes nothing changes, at 11 every tab is parked, the one on screen included
  await vis('hidden', 23 * M);
  await sweepAt(32 * M);
  const at9 = { parked: await parkedN(), frames: await n() };
  await sweepAt(34 * M + 1000);
  await page.waitForFunction(() => document.querySelectorAll('iframe.gfr').length === 0);
  const at11 = { parked: await parkedN(), frames: await n(), placeholder: await page.evaluate(() => !!document.querySelector('.gw:not([hidden]) .gpark')) };
  check('6 page hidden with the sweep running: at 9 minutes the tab on screen is still mounted, at 11 every tab is parked and no iframe is left (no socket held)', at9.parked === 1 && at9.frames === 1 && at11.parked === 2 && at11.frames === 0 && at11.placeholder, { at9, at11 });
  await vis('visible', 35 * M);
  await page.waitForFunction(() => document.querySelectorAll('iframe.gfr').length === 1);
  const p7 = await panes(page), s7 = await st(page);
  check('7 back on screen: the active tab remounts at once (same name, a fresh iframe), the other stays parked until clicked', await parkedN() === 1 && p7.length === 1 && p7[0].name === 'cc-alpha-api' && s7.active === s7.tabs[0].id && await page.evaluate(() => !document.querySelector('.gw:not([hidden]) .gpark')), p7);
  await page.locator('#gtabs .gt').nth(1).click();
  await page.waitForFunction(() => document.querySelectorAll('iframe.gfr').length === 2);
  check('8 clicking the parked tab remounts it too; no errors', await parkedN() === 0 && errors.length === 0, errors);
  await ctx.close();
}
async function leakMode() {
  if (engine !== 'chromium') { console.log('SKIP leak (Chromium DevTools counters only)'); return; }
  const { ctx, page } = await open();
  const cdp = await ctx.newCDPSession(page);
  const counters = async () => { await cdp.send('HeapProfiler.collectGarbage'); const c = await cdp.send('Memory.getDOMCounters'); return { nodes: c.nodes, listeners: c.jsEventListeners, frames: await page.evaluate(() => document.querySelectorAll('iframe.gfr').length) }; };
  const empty0 = await counters();                                                                              // the empty grid, before any tab opens
  for (const n of ['cc-alpha-api', 'cc-beta-data']) await row(page, n).click();
  for (const n of ['cc-gamma-x', 'cc-gamma-y', 'cc-gamma-z', 'cc-alpha-web']) await row(page, n).click({ modifiers: ['Shift'] });
  await page.waitForTimeout(500);
  const base = await counters();
  check('1 six panes mounted', base.frames === 6, base);
  for (let i = 0; i < 20; i++) {
    await page.keyboard.press('Control+Shift+ArrowRight'); await page.keyboard.press('Control+Shift+KeyZ'); await page.keyboard.press('Control+Shift+KeyZ');
    await page.keyboard.press('Control+Shift+Digit1'); await page.keyboard.press('Control+Shift+Digit2');
    await page.evaluate(() => { window.__now += 11 * 60 * 1000; window.__grid.sweep(); });                      // parks tab 1
    await page.locator('#gtabs .gt').nth(0).click(); await page.waitForFunction(() => document.querySelectorAll('iframe.gfr').length === 6);
    await page.locator('#gtabs .gt').nth(1).click();
    const a = await page.locator('#gtabs .gt').nth(1).boundingBox(), b = await page.locator('#gtabs .gt').nth(0).boundingBox();
    await page.mouse.move(a.x + a.width / 2, a.y + 10); await page.mouse.down(); await page.mouse.move(b.x + 4, b.y + 10, { steps: 4 }); await page.mouse.up();
    await page.mouse.move(b.x + 10, b.y + 10); await page.mouse.down(); await page.mouse.move(a.x + a.width - 4, a.y + 10, { steps: 4 }); await page.mouse.up();
  }
  await page.waitForTimeout(500);
  const after = await counters();
  check('2 after 20 cycles: same iframes, listeners within +20, DOM nodes within +200', after.frames === 6 && after.listeners - base.listeners <= 20 && after.nodes - base.nodes <= 200, { base, after });
  while ((await tabs(page)).length) { await page.locator('#gtabs .gt').first().locator('.gx').click(); await page.waitForTimeout(50); } // close every tab through the UI
  await page.waitForTimeout(300);
  const empty = await counters();
  check('3 everything closed: no iframes, listeners within +20 and DOM nodes within +60 of the empty grid taken before the first tab', empty.frames === 0 && empty.listeners - empty0.listeners <= 20 && empty.nodes - empty0.nodes <= 60, { empty0, base, empty });
  check('4 no errors', errors.length === 0, errors);
  await ctx.close();
}
// the sidebar toggle (a screen share): the strip's first button, Mod+B from the shell or from inside a pane, persisted
async function sidebarMode() {
  const { ctx, page } = await open();
  await page.evaluate(() => localStorage.setItem('grid.v1', JSON.stringify({ mod: 'win' })));
  await page.reload({ waitUntil: 'load' }); await page.waitForSelector('#grid');
  await row(page, 'cc-alpha-api').click(); await mark(page);
  const shown = () => page.evaluate(() => ({ sb: document.getElementById('gsb').getClientRects().length > 0, state: window.__grid.state().sb, cols: getComputedStyle(document.getElementById('grid')).gridTemplateColumns.split(' ').length, main: document.getElementById('gmain').getBoundingClientRect().left | 0, mainW: document.getElementById('gmain').getBoundingClientRect().width | 0, paneW: document.querySelector('.gw:not([hidden]) .gp')?.getBoundingClientRect().width | 0 }));
  const s0 = await shown();
  check('1 shown by default: the card, three columns', s0.sb && s0.state === true && s0.cols === 3, s0);
  await page.click('#gtabs .gsbt'); await page.waitForTimeout(100);
  const s1 = await shown();
  check('2 the strip button hides it: no card, the panes take the whole width from the left edge, the keyboard goes to the pane', !s1.sb && s1.state === false && s1.cols === 1 && s1.main === 0 && s1.mainW === 1600 && s1.paneW === 1600 && await page.evaluate(() => document.activeElement === document.querySelector('.gw:not([hidden]) .gp.on iframe')), s1);
  check('3 the pane was not reloaded', allKept(await kept(page)));
  await page.waitForTimeout(400); await page.reload({ waitUntil: 'load' }); await page.waitForSelector('#grid'); await page.waitForTimeout(200);
  const s2 = await shown();
  check('4 hidden survives a reload', !s2.sb && s2.state === false && s2.mainW === 1600, s2);
  await page.mouse.click(700, 19); await page.keyboard.press('Control+Shift+KeyB'); await page.waitForTimeout(100); // the strip, outside any terminal
  check('5 Mod+B in the shell shows it again', (await shown()).sb);
  await page.evaluate(() => document.querySelector('.gw:not([hidden]) .gp.on iframe').contentWindow.__send('sidebar')); await page.waitForTimeout(100);
  check('6 Mod+B from inside a pane hides it', !(await shown()).sb);
  await ctx.close();
}
// /grid?open=<name> (the home page's rows): that session as a tab, the keyboard in it, the query gone; an unknown name is ignored
async function deeplinkMode() {
  const { ctx, page } = await open();
  await page.evaluate(() => localStorage.clear());
  await page.goto(DASH + '/grid?open=cc-beta-data', { waitUntil: 'load' }); await page.waitForSelector('.gw:not([hidden]) .gp'); await page.waitForTimeout(400); // past the 250 ms save debounce before the next navigation
  const p = await panes(page), u = new URL(page.url());
  check('1 ?open= opens that session as the active tab and strips the query', p.length === 1 && p[0].name === 'cc-beta-data' && p[0].on && u.pathname === '/grid' && u.search === '', { p, url: page.url() });
  check('2 the keyboard went to its pane', await page.evaluate(() => document.activeElement === document.querySelector('.gw:not([hidden]) .gp.on iframe')));
  await page.goto(DASH + '/grid?open=cc-alpha-api', { waitUntil: 'load' }); await page.waitForSelector('.gw:not([hidden]) .gp'); await page.waitForTimeout(400);
  check('3 a second ?open= adds a tab and keeps the first (persisted)', (await tabs(page)).length === 2 && (await panes(page))[0].name === 'cc-alpha-api');
  await page.goto(DASH + '/grid?open=cc-nope', { waitUntil: 'load' }); await page.waitForSelector('.gw:not([hidden]) .gp'); await page.waitForTimeout(150);
  check('4 an unknown session is ignored', (await tabs(page)).length === 2 && new URL(page.url()).search === '?open=cc-nope');
  check('5 the strip nav carries the view switch (grid on, list -> /) and no Sessions link', await page.evaluate(() => { const n = document.querySelector('.gnav'); return n.querySelector('.vsw a.on')?.dataset.v === 'grid' && n.querySelector('.vsw a[data-v=list]')?.getAttribute('href') === '/' && ![...n.querySelectorAll('a')].some(a => a.textContent === 'Sessions'); }));
  await ctx.close();
}
// the strip's +: the terminal picker as a tab here (never a new browser tab); once /a/tab names a live session the pane becomes it
async function pickerMode() {
  const { ctx, page } = await open();
  let sess = '';
  await ctx.route('**/a/tab?*', r => r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ session: sess }) }));
  await page.evaluate(() => localStorage.clear());
  await page.reload({ waitUntil: 'load' }); await page.waitForSelector('#grid');
  await row(page, 'cc-alpha-api').click(); await mark(page);
  const popups = []; ctx.on('page', p => popups.push(p));
  await page.click('#gtabs .gnew'); await page.waitForTimeout(100);
  const p1 = await panes(page), t1 = await tabs(page);
  check('1 + opens the picker as a new active tab: one pane, the menu url with a tab id, no browser tab', t1.length === 2 && t1[1].on && t1[1].text === 'new session' && p1.length === 1 && p1[0].name === 'new:2' && /^\/term\/\?arg=menu&arg=&arg=[0-9a-f]{8}&v=3$/.test(p1[0].src) && !p1[0].ended && popups.length === 0, { p1, t1, popups: popups.length });
  check('2 its header reads new session · picker, the keyboard is in it', await page.evaluate(() => { const h = document.querySelector('.gw:not([hidden]) .gp header'); return h.querySelector('b').textContent === 'new session' && h.querySelectorAll('span')[0].textContent === 'picker' && document.activeElement === document.querySelector('.gw:not([hidden]) .gp.on iframe'); }));
  check('3 the sidebar does not list it', (await page.$$('#gsb .gr')).length === FLEET.length);
  await page.waitForTimeout(2300);
  check('4 while /a/tab says nothing the pane stays a picker', (await panes(page))[0].name === 'new:2');
  sess = 'cc-nope'; await page.waitForTimeout(2300);
  check('5 a session the fleet does not know is ignored', (await panes(page))[0].name === 'new:2');
  sess = 'cc-beta-data'; await page.waitForFunction(() => document.querySelector('.gw:not([hidden]) .gp')?.dataset.name === 'cc-beta-data', null, { timeout: 5000 }).catch(() => {});
  const p2 = await panes(page);
  check('6 a live session renames the pane: attach url with a tab id, header label, state word', p2.length === 1 && p2[0].name === 'cc-beta-data' && /^\/term\/\?arg=attach&arg=cc-beta-data&arg=[0-9a-f]{8}&v=3$/.test(p2[0].src) && (await tabs(page)).length === 2, p2);
  check('7 the other tab was not reloaded', (await kept(page)).filter(k => k.name === 'cc-alpha-api').every(k => k.mark && k.loads === 1));
  await page.click('#gtabs .gnew'); await page.waitForTimeout(100); sess = 'cc-alpha-api'; await page.waitForTimeout(2300);
  const t3 = await tabs(page), p3 = await panes(page);
  check('8 a picker landing in a session open elsewhere: that pane closes, the picker tab is the session now', t3.length === 2 && p3.length === 1 && p3[0].name === 'cc-alpha-api' && (await st(page)).tabs.map(t => t.panes.join()).join() === 'cc-beta-data,cc-alpha-api', { t3, p3 });
  await page.click('#gtabs .gnew'); await page.waitForTimeout(400); sess = '';
  await page.reload({ waitUntil: 'load' }); await page.waitForSelector('#grid'); await page.waitForTimeout(200);
  check('9 a reload drops an open picker silently', (await tabs(page)).length === 2 && !(await page.$eval('#gtabs', e => e.textContent)).includes('dropped'), await tabs(page));
  await ctx.close();
}
// the row's × asks before it kills (the list view's Kill -> Kill It): cancel and Escape keep it, Kill It posts /a/kill and closes its pane;
// shift+click still splits (the split button gave its place to kill)
async function killMode() {
  const { ctx, page } = await open();
  const kills = []; await ctx.route('**/a/kill', r => { kills.push(r.request().postData()); r.fulfill({ status: 204 }); });
  await row(page, 'cc-alpha-api').click(); await row(page, 'cc-alpha-web').click({ modifiers: ['Shift'] });
  check('1 shift+click splits (two panes in one tab)', (await panes(page)).map(p => p.name).join() === 'cc-alpha-api,cc-alpha-web');
  check('2 no split button left; every row has a kill button', await page.locator('#gsb .gsplit').count() === 0 && await page.locator('#gsb .gr .gkill').count() === FLEET.length);
  const r = row(page, 'cc-alpha-web');
  await r.hover(); await r.locator('.gkill').click();
  check('3 kill asks first: the confirm in the row, focus on Cancel, nothing posted, the pane still open', await r.locator('.gkc').isVisible() && await page.evaluate(() => document.activeElement?.classList.contains('gkno')) && kills.length === 0 && (await panes(page)).length === 2);
  await page.keyboard.press('Enter');
  check('4 Enter on the default (Cancel) keeps it', await r.locator('.gkc').count() === 0 && kills.length === 0);
  await r.hover(); await r.locator('.gkill').click(); await page.keyboard.press('Escape');
  check('5 Escape keeps it', await r.locator('.gkc').count() === 0 && kills.length === 0);
  await r.hover(); await r.locator('.gkill').click(); await r.locator('.gkyes').click(); await page.waitForTimeout(200);
  const body = new URLSearchParams(kills[0] || '');
  check('6 Kill It posts /a/kill with that name and closes its pane, the other stays', kills.length === 1 && body.get('name') === 'cc-alpha-web' && (await panes(page)).map(p => p.name).join() === 'cc-alpha-api', kills);
  const dragTo = async (name, sel) => { const a = await row(page, name).boundingBox(), b = await page.locator(sel).first().boundingBox();
    await page.mouse.move(a.x + 40, a.y + 10); await page.mouse.down(); await page.mouse.move(a.x + 80, a.y + 30, { steps: 4 }); await page.mouse.move(b.x + b.width / 2, b.y + b.height / 2, { steps: 6 }); await page.mouse.up(); await page.waitForTimeout(150); };
  await dragTo('cc-beta-data', '.gw:not([hidden])');
  check('7 dragging a row onto the panes splits it beside them', (await tabs(page)).length === 1 && (await panes(page)).map(p => p.name).join() === 'cc-alpha-api,cc-beta-data');
  await dragTo('cc-gamma-x', '#gtabs .gts');
  check('8 dragging a row onto the strip opens it as a tab', (await tabs(page)).length === 2 && (await panes(page)).map(p => p.name).join() === 'cc-gamma-x');
  await row(page, 'cc-alpha-api').click();
  check('9 a plain click after a drag still opens normally', (await tabs(page))[0].on);
  await ctx.close();
}
async function svcMode() {
  // a tmux session with no claude in it (2026-10-14: links-cec's `cecqa` read as a second links-cec session)
  const SVC = { ...fx('cecqa', 'cecqa', '', 'alpha', 'idle', 5), kind: 'service', wins: ['main', 'adminapi', 'webadmin'] };
  const DB = { ...fx('cecdb', 'cecdb', '', 'alpha', 'idle', 50), kind: 'service', wins: ['mongo'] };
  const { ctx, page } = await open({ fleet: [...FLEET, SVC, DB] });
  const shot = async n => process.env.SHOT && page.locator('#gsb').screenshot({ path: `${process.env.SHOT}/svc-${n}.png` });
  await shot('grouped');
  const g = await page.$$eval('#gsb details.gg', ds => ds.map(d => ({ proj: d.dataset.proj, rows: [...d.querySelectorAll('.gr')].map(r => r.dataset.name) })));
  check('1 services sit in their project group, below the agents', g[0].proj === 'alpha' && g[0].rows.join() === 'cc-alpha-web,cc-alpha-api,cecqa,cecdb', g);
  const r = row(page, 'cecqa');
  check('2 it reads as a service: its tmux name, one tag per window, no state glyph, no state word, no rename',
    (await r.locator('.lb').textContent()) === 'cecqa' && (await r.locator('.gwin').allTextContents()).join() === 'main,adminapi,webadmin' && await r.locator('.fli, .fst, .gren').count() === 0);
  check('2b grouped, it hangs off the agent above by the elbow', await r.evaluate(e => getComputedStyle(e, '::before').display !== 'none' && getComputedStyle(e, '::before').borderLeftStyle === 'solid'));
  await r.click();
  check('3 a click opens it as a tab named after the session', (await st(page)).tabs.length === 1 && (await page.locator('#gtabs').textContent()).includes('cecqa'));
  await page.click('#ggroup');
  const flat = await page.$$eval('#gsb .glist > *', es => es.map(e => e.dataset.name || e.textContent.trim()));
  check('4 flat: the agents first, then a services heading, then the service', flat.slice(-3).join() === 'services,cecqa,cecdb' && flat.length === 10, flat);
  await shot('flat');
  check('5 flat: no elbow, there is no agent row above to hang from', await row(page, 'cecqa').evaluate(e => getComputedStyle(e, '::before').display === 'none'));
  await ctx.close();
}
const RUN = { open: openMode, groups: groupsMode, persist: persistMode, ended: endedMode, phone: phoneMode, drag: dragMode, keys: keysMode, tabs: tabsMode, park: parkMode, leak: leakMode, sidebar: sidebarMode, deeplink: deeplinkMode, picker: pickerMode, kill: killMode, svc: svcMode };
for (const m of mode === 'all' ? Object.keys(RUN) : [mode]) { cur = m; if (RUN[m]) await RUN[m](); else console.log(`SKIP ${m} (added by a later task)`); }
await browser.close();
console.log(bad ? `grid-check: ${bad} FAIL` : 'grid-check: all pass');
process.exit(bad ? 1 : 0);
