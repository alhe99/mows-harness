// Cockpit phase 02a sessions probe (specs/cockpit/02a-sessions.md tasks 1-9). Exit code is the verdict.
// usage: node docs/qa/probes/sessions-check.mjs <webkit|chromium> <render|actions|keys|links|standalone|prefetch|history|all>
// env: DASH (default http://127.0.0.1:3105), PLAYWRIGHT (module path; default: the repo's)
// Every mode runs against the shell on the dev instance with a FIXTURE fleet: the boot snapshot in the document is rewritten
// in flight, EventSource is replaced by a fake that window.__emit(name, data) drives, and every /a/*, /z and /api/* request is
// answered here, so nothing the probe does can reach a real session and the result does not depend on what tmux holds.
import http from 'node:http';
const pw = await import(process.env.PLAYWRIGHT || 'playwright').catch(() => { console.error('sessions-check: playwright is not installed (npm ci --ignore-scripts)'); process.exit(2); });
const engine = process.argv[2] || 'webkit';
const mode = process.argv[3] || 'all';
const MODES = ['render', 'actions', 'keys', 'links', 'standalone', 'prefetch', 'history'];
if (mode !== 'all' && !MODES.includes(mode)) { console.error(`sessions-check: mode is one of ${MODES.join(' ')} all`); process.exit(2); }
const base = (process.env.DASH || 'http://127.0.0.1:3105') + '/';
const browser = await pw[engine].launch();

let bad = 0, errors = [];
const check = (id, ok, detail) => { if (!ok) bad++; console.log(`${ok ? 'PASS' : 'FAIL'} ${mode === 'all' ? cur + ' ' : ''}${id}${detail === undefined ? '' : ' ' + JSON.stringify(detail)}`); };
let cur = '';

const T = Date.now();
const fx = (sid8, name, label, proj, state, age, snippet = '') => ({ sid8, name, label, proj, state, rel: T - age * 1000, snippet });
// server order is needs-you < working < paused < idle, then newest first; the fixture is deliberately NOT in that order
const FLEET = [
  fx('dddd4444', 'cc-delta', 'Delta', 'delta', 'idle', 200000, 'last words'),
  fx('aaaa1111', 'cc-alpha', 'Alpha', 'alpha', 'working', 20, 'building the thing'),
  fx('cccc3333', 'cc-gamma', '', '', 'paused', 4000),
  fx('bbbb2222', 'cc-beta', '', 'beta', 'needs-you', 300, 'approve? [y/n]'),
];
const SORTED = ['bbbb2222', 'aaaa1111', 'cccc3333', 'dddd4444'];
const MENU_HREF = /^\/term\/\?arg=menu&arg=&arg=[0-9a-f]{8}&v=3$/;

// stub: { standalone, coarse, short } -> display-mode standalone, pointer: coarse, a screen taller than the viewport (vpfix)
async function open(opts = {}) {
  const { w = 1280, h = 800, mobile = false, fleet = FLEET, stub = {}, origin } = opts;
  const ctx = await browser.newContext({ viewport: { width: w, height: h }, deviceScaleFactor: mobile ? 3 : 1, hasTouch: mobile, isMobile: mobile, serviceWorkers: 'block' });
  await ctx.addInitScript(stub => {
    const all = (window.__es = []);
    window.EventSource = class {
      constructor(url) { this.url = url; this.readyState = 1; this.l = {}; all.push(this); setTimeout(() => (this.l.open || []).forEach(f => f({})), 0); }
      addEventListener(n, f) { (this.l[n] ||= []).push(f); }
      close() { this.readyState = 2; }
    };
    window.__emit = (name, data) => all.forEach(e => (e.l[name] || []).forEach(f => f({ data: JSON.stringify(data), lastEventId: '' })));
    // the view's 30 s tick, and a clock the probe can move
    const si = window.setInterval; window.__iv = [];
    window.setInterval = (f, ms, ...a) => { if (ms === 30000) window.__iv.push(f); return si(f, ms, ...a); };
    window.__skew = 0; const dn = Date.now.bind(Date); Date.now = () => dn() + window.__skew;
    const mm = window.matchMedia.bind(window);
    window.matchMedia = q => {
      const r = mm(q);
      const fake = v => new Proxy(r, { get: (t, k) => (k === 'matches' ? v : typeof t[k] === 'function' ? t[k].bind(t) : t[k]) });
      if (stub.standalone && /display-mode:\s*standalone/.test(q)) return fake(true);
      if (stub.standalone && /display-mode:\s*browser/.test(q)) return fake(false);
      if (stub.coarse && /pointer:\s*fine/.test(q)) return fake(false);
      return r;
    };
    if (stub.standalone && !('ontouchstart' in window)) window.ontouchstart = null;
    if (stub.short) Object.defineProperty(screen, 'height', { get: () => 3000 });
    // vpfix evidence: one count per display:none -> '' toggle of the body
    window.__tog = 0;
    document.addEventListener('DOMContentLoaded', () => new MutationObserver(rs => rs.forEach(r => { if (!/display:\s*none/.test(r.oldValue || '')) window.__tog++; }))
      .observe(document.body, { attributes: true, attributeFilter: ['style'], attributeOldValue: true }));
  }, stub);
  await ctx.route(u => u.pathname === '/', async route => {
    const r = await route.fetch();
    const html = (await r.text()).replace(/(<script type="application\/json" id="boot"[^>]*>)([\s\S]*?)(<\/script>)/, (_, a, j, c) => {
      const b = JSON.parse(j); b.fleet = fleet; b.live = fleet.length;
      return a + JSON.stringify(b).replace(/</g, '\\u003c') + c;
    });
    const headers = { ...r.headers() }; delete headers['content-encoding']; delete headers['content-length'];
    await route.fulfill({ status: r.status(), headers, body: html });
  });
  const z = [], api = [];
  await ctx.route('**/z?*', r => { z.push(r.request().url()); return r.fulfill({ status: 204 }); });
  // minimal valid payloads for the views a probe navigates into (system, history); anything else answers {}
  const STUB = { '/api/system': { load: 0, cores: 1, memUsed: 0, memTot: 1, swapUsed: 0, swapTot: 0, dskUsed: 0, dskTot: 1, up: 0, version: 'x', usage: null, now: Date.now(), usageAt: 0, busy: false, live: 0, deployed: null, node: 'x', platform: 'x' },
    '/api/history': { rows: [], page: 1, pages: 1, total: 0, accts: [], resumeDays: 7, live: 0, indexed: 0, acct: '', label: '' } };
  await ctx.route('**/api/**', r => { const u = new URL(r.request().url()); api.push(u.pathname + u.search); return r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(STUB[u.pathname] || {}) }); });
  await ctx.route('**/term/**', r => r.fulfill({ status: 200, contentType: 'text/html', body: '<!doctype html><title>term</title>term' }));
  const page = await ctx.newPage();
  page.on('console', m => { if (m.type() === 'error' && !/interactive-widget/.test(m.text())) errors.push(m.text()); });
  page.on('pageerror', e => errors.push(String(e)));
  let loads = 0; page.on('load', () => loads++);
  await page.goto(origin ? origin + '/' : base, { waitUntil: 'load' });
  await page.waitForSelector('#app h1[data-view="sessions"]', { state: 'attached' }); // the h1 is display:none on a desktop, as in the legacy page
  await page.evaluate(() => { window.__doc = 'same-document'; });
  return { ctx, page, z, api, loads: () => loads };
}
const rows = page => page.evaluate(sel => [...document.querySelectorAll(sel)].map(n => {
  const g = n.querySelector('[data-f=glyph]'), sn = n.querySelector('[data-f=snip]'), num = n.querySelector('[data-f=num]');
  return { sid: n.dataset.sid, state: n.dataset.state, glyph: g.textContent, glyphClass: g.className, label: n.querySelector('[data-f=label]').textContent, proj: n.querySelector('[data-f=proj]').textContent,
    meta: n.querySelector('[data-f=meta]').textContent, num: num ? num.textContent : null, snip: sn.textContent, snipShown: getComputedStyle(sn).display !== 'none', shown: n.getClientRects().length > 0 };
}), '#fleet-rows > .li');
const cards = page => page.evaluate(() => [...document.querySelectorAll('#fleet-cards > .lp')].map(n => ({ sid: n.dataset.sid, state: n.dataset.state, shown: n.getClientRects().length > 0,
  label: n.querySelector('[data-f=label]').textContent, meta: n.querySelector('[data-f=meta]').textContent })));
const chrome = page => page.evaluate(() => { const c = document.getElementById('fleet-count'), b = document.getElementById('pnav-live');
  return { count: [c.textContent, c.hidden], empty: document.getElementById('fleet-empty').hidden, badge: [b.textContent, b.hidden] }; });
const emit = (page, list) => page.evaluate(l => window.__emit('fleet', l), list);
const sids = page => page.evaluate(() => [...document.querySelectorAll('#fleet-rows > .li')].map(n => n.dataset.sid));

async function render() {
  const { ctx, page } = await open();
  const r = await rows(page);
  check('1 rows (>= 701 px) render from the boot snapshot, sorted needs-you < working < paused < idle', JSON.stringify(r.map(x => x.sid)) === JSON.stringify(SORTED), r.map(x => x.sid));
  check('2 data-state and glyphs ◉ ● ⏸ ○ with matching .fli-<state>', r.map(x => x.state + x.glyph).join() === 'needs-you◉,working●,paused⏸,idle○' && r.every(x => x.glyphClass === `fli fli-${x.state}`), r.map(x => [x.state, x.glyph, x.glyphClass]));
  check('3 label = label || proj || name', r.map(x => x.label).join() === 'beta,Alpha,cc-gamma,Delta', r.map(x => x.label));
  check('4 meta is "<word> <relative time>": waiting / working / paused / idle', r.map(x => x.meta).join() === 'waiting 5m,working now,paused 66m,idle 2d', r.map(x => x.meta));
  check('5 snippet node hidden when empty', r.map(x => x.snipShown).join() === 'true,true,false,true', r.map(x => x.snipShown));
  check('6 .fnum badges number the rows 1-4', r.map(x => x.num).join() === '1,2,3,4', r.map(x => x.num));
  check('7 desktop: rows shown, cards hidden', r.every(x => x.shown) && (await cards(page)).every(x => !x.shown));
  check('8 #fleet-count 4 visible, #fleet-empty hidden, #pnav-live 4 visible', JSON.stringify(await chrome(page)) === '{"count":["4",false],"empty":true,"badge":["4",false]}', await chrome(page));
  await page.setViewportSize({ width: 390, height: 844 });
  const c = await cards(page);
  check('9 phone (<= 700 px): cards shown in the same order, rows hidden', JSON.stringify(c.map(x => x.sid)) === JSON.stringify(SORTED) && c.every(x => x.shown) && (await rows(page)).every(x => !x.shown), c);
  await page.setViewportSize({ width: 1280, height: 800 });

  // patches and reorders move and edit nodes; none is rebuilt
  await page.evaluate(() => document.querySelectorAll('[data-sid]').forEach(n => { n.__keep = n.dataset.sid; }));
  const next = [
    { ...FLEET[1], state: 'needs-you', label: 'Alpha 2', snippet: 'now waiting', rel: T - 1000 },   // working -> needs-you, newest
    { ...FLEET[0], state: 'working', rel: T - 5000 },                                              // idle -> working
    fx('eeee5555', 'cc-eps', '', 'eps', 'idle', 90000, 'fresh'),                                   // new
    // bbbb2222 and cccc3333 are gone
  ];
  await emit(page, next);
  await page.waitForFunction(() => document.querySelectorAll('#fleet-rows > .li').length === 3);
  const r2 = await rows(page);
  check('10 an injected fleet event reorders: needs-you Alpha 2, working Delta, idle eps', JSON.stringify(r2.map(x => x.sid)) === JSON.stringify(['aaaa1111', 'dddd4444', 'eeee5555']), r2.map(x => x.sid));
  check('11 ...patches state, glyph, label, snippet in place', r2[0].state === 'needs-you' && r2[0].glyph === '◉' && r2[0].label === 'Alpha 2' && r2[0].snip === 'now waiting' && r2[1].state === 'working' && r2[1].glyph === '●', r2.slice(0, 2));
  check('12 ...without a rebuild: surviving nodes are the same elements, moved', await page.evaluate(() => [...document.querySelectorAll('#fleet-rows > .li, #fleet-cards > .lp')].filter(n => n.__keep).length === 4), 'rows+cards kept');
  check('13 ...removed sessions leave, new ones arrive, numbers follow the order', r2.map(x => x.num).join() === '1,2,3' && r2[2].label === 'eps' && !(await page.evaluate(() => [...document.querySelectorAll('[data-sid]')].some(n => n.dataset.sid === 'bbbb2222'))));
  check('14 count and badge follow the list', JSON.stringify(await chrome(page)) === '{"count":["3",false],"empty":true,"badge":["3",false]}', await chrome(page));
  await emit(page, []);
  await page.waitForFunction(() => document.querySelectorAll('#fleet-rows > .li').length === 0);
  const e = await page.evaluate(() => ({ empty: document.getElementById('fleet-empty').hidden, count: document.getElementById('fleet-count').hidden, badge: document.getElementById('pnav-live').hidden,
    rows: document.getElementById('fleet-rows').children.length, rowsShown: getComputedStyle(document.getElementById('fleet-rows')).display, text: document.getElementById('fleet-empty').textContent }));
  check('15 empty fleet: "no live sessions." shown, count and badge hidden, containers :empty and hidden', !e.empty && e.count && e.badge && e.rows === 0 && e.rowsShown === 'none' && e.text === 'no live sessions.', e);
  await emit(page, FLEET);
  await page.waitForFunction(() => document.querySelectorAll('#fleet-rows > .li').length === 4);
  const iv = await page.evaluate(() => window.__iv.length);
  await page.evaluate(() => { window.__skew = 7200e3; window.__iv.forEach(f => f()); });
  await page.waitForFunction(() => document.querySelector('#fleet-rows > .li[data-sid=aaaa1111] [data-f=meta]').textContent === 'working 2h').catch(() => {});
  const meta = await page.evaluate(() => document.querySelector('#fleet-rows > .li[data-sid=aaaa1111] [data-f=meta]').textContent);
  check('16 relative time re-renders on the 30 s tick (registered, and a tick 2 h on reads "working 2h")', iv >= 1 && meta === 'working 2h', { intervals: iv, meta });
  await ctx.close();
}

async function actions() {
  // A reverse proxy in front of the dev instance that answers every POST /a/* itself with a real 303 (after 300 ms, long enough to observe
  // the busy state) and records it, so nothing reaches a session. Playwright cannot fulfil a redirect status, hence a server.
  const posts = [], dash = new URL(base);
  let nextGets = 0;
  const srv = http.createServer((q, r) => {
    if (q.method === 'POST' && q.url.startsWith('/a/')) {
      let body = ''; q.on('data', c => { body += c; });
      q.on('end', () => { posts.push({ path: q.url, method: 'POST', body, type: /text\/html/.test(q.headers.accept || '') ? 'document' : 'fetch' }); setTimeout(() => { r.writeHead(303, { location: '/' }); r.end(); }, 300); });
      return;
    }
    if (q.url === '/') nextGets++;
    const u = http.request({ host: dash.hostname, port: dash.port, path: q.url, method: q.method, headers: q.headers }, p => { r.writeHead(p.statusCode, p.headers); p.pipe(r); });
    u.on('error', () => r.destroy());
    q.pipe(u);
  });
  await new Promise(res => srv.listen(0, '127.0.0.1', res));
  const { ctx, page, loads } = await open({ origin: `http://127.0.0.1:${srv.address().port}` });
  const sum = n => page.locator(`#fleet-rows > .li[data-sid=${n}] summary[title="more actions"]`);
  // a menu opens downward over the rows below it, so the lower row is opened first
  await page.hover('#fleet-rows > .li[data-sid=cccc3333]');
  await sum('cccc3333').click();
  const open0 = await page.evaluate(() => [...document.querySelectorAll('#fleet-rows details[name=fm][open]')].map(d => d.closest('[data-sid]').dataset.sid));
  await page.hover('#fleet-rows > .li[data-sid=aaaa1111]');
  await sum('aaaa1111').click();
  const open1 = await page.evaluate(() => [...document.querySelectorAll('#fleet-rows details[name=fm][open]')].map(d => d.closest('[data-sid]').dataset.sid));
  check('1 <details name=fm> menus are exclusive: opening a second closes the first', JSON.stringify(open0) === '["cccc3333"]' && JSON.stringify(open1) === '["aaaa1111"]', { open0, open1 });
  const forms = await page.evaluate(() => [...document.querySelectorAll('#fleet-rows > .li[data-sid=cccc3333] form')].map(f => ({ method: f.method, action: new URL(f.action).pathname, cls: f.className,
    hidden: Object.fromEntries([...f.querySelectorAll('input[type=hidden]')].map(i => [i.name, i.value])), btn: f.querySelector('button').textContent.trim() })));
  check('2 each menu action is a <form method=post> with name + back: paused session offers /a/resume, rename /a/label, kill /a/kill',
    forms.length === 3 && forms.every(f => f.method === 'post' && f.hidden.name === 'cc-gamma' && f.hidden.back === '/')
    && forms.map(f => f.action).join() === '/a/resume,/a/label,/a/kill' && forms[0].btn === 'Resume' && forms[1].cls === 'af lf', forms);
  const al = await page.evaluate(() => { const f = document.querySelector('#fleet-rows > .li[data-sid=aaaa1111] form[data-f=pauseform]'); return [new URL(f.action).pathname, f.querySelector('button').textContent.trim(), f.querySelector('button').className]; });
  check('3 a working session offers /a/pause (the pause/resume swap follows state)', al.join() === '/a/pause,Pause,ab', al);

  // pause: busy while in flight, 303 not followed, no document load, cleared on response, menu closed
  const before = loads();
  const pf = page.locator('#fleet-rows > .li[data-sid=aaaa1111] form[data-f=pauseform]');
  await pf.locator('button').click();
  const busy = await page.evaluate(() => document.querySelector('#fleet-rows > .li[data-sid=aaaa1111] form[data-f=pauseform]').classList.contains('busy'));
  check('4 form.busy while the request is in flight', busy);
  await page.waitForFunction(() => !document.querySelector('#fleet-rows > .li[data-sid=aaaa1111] form[data-f=pauseform]').classList.contains('busy'));
  await page.waitForTimeout(150);
  const after = await page.evaluate(() => ({ doc: window.__doc, open: document.querySelectorAll('details[name=fm][open]').length }));
  check('5 POST /a/pause with name and back, answered 303, cleared on response, menu closed, same document', posts.length === 1 && posts[0].method === 'POST' && posts[0].path === '/a/pause'
    && /(^|&)name=cc-alpha(&|$)/.test(posts[0].body) && /(^|&)back=%2F(&|$)/.test(posts[0].body) && after.doc === 'same-document' && loads() === before && after.open === 0, { posts, after });
  check('6 the 303 target is not fetched (one GET of / in all: the page load; the fleet arrives over the stream)', nextGets === 1, nextGets);

  // rename
  await sum('bbbb2222').click();
  const rn = page.locator('#fleet-rows > .li[data-sid=bbbb2222] form.lf');
  await rn.locator('input[name=label]').fill('renamed');
  const lim = await rn.locator('input[name=label]').getAttribute('maxlength');
  await rn.locator('button').click();
  await page.waitForFunction(() => !document.querySelector('form.busy'));
  const p2 = posts[1];
  check('7 rename posts /a/label with label and name (maxlength 60)', p2 && p2.path === '/a/label' && /(^|&)label=renamed(&|$)/.test(p2.body) && /name=cc-beta/.test(p2.body) && lim === '60', p2);
  // kill confirm is a nested details, then the form
  await sum('bbbb2222').click();
  const kd = page.locator('#fleet-rows > .li[data-sid=bbbb2222] .kc details.kx');
  await kd.locator('summary').click();
  const kt = await kd.locator('.kc').innerText();
  await kd.locator('button.danger').click();
  await page.waitForFunction(() => !document.querySelector('form.busy'));
  check('8 kill asks first ("stop cc-beta?"), then posts /a/kill', /stop cc-beta\?/.test(kt) && posts[2] && posts[2].path === '/a/kill' && /name=cc-beta/.test(posts[2].body), { kt, p: posts[2] });
  // pageshow clears a stuck busy
  const cleared = await page.evaluate(() => { const f = document.querySelector('form'); f.classList.add('busy'); const had = f.classList.contains('busy'); window.dispatchEvent(new Event('pageshow')); return had && !f.classList.contains('busy'); });
  check('9 form.busy is cleared on pageshow (bfcache restore)', cleared);
  // the same form submits natively (no script involved): bypass the submit event
  await sum('aaaa1111').click();
  const nav = page.waitForNavigation({ waitUntil: 'load' });
  await page.evaluate(() => HTMLFormElement.prototype.submit.call(document.querySelector('#fleet-rows > .li[data-sid=aaaa1111] form[data-f=pauseform]')));
  await nav;
  const nat = posts[3];
  check('10 ...and submits natively without the view\'s handler: a document POST, 303 followed to /', nat && nat.type === 'document' && nat.path === '/a/pause' && /name=cc-alpha/.test(nat.body) && new URL(page.url()).pathname === '/', { nat, url: page.url() });
  await ctx.close();
  srv.close();
}

async function keys() {
  const { ctx, page } = await open();
  await page.evaluate(() => { window.__clicked = []; window.addEventListener('click', e => { const a = e.target.closest && e.target.closest('a'); if (a) { window.__clicked.push(a.getAttribute('href')); e.preventDefault(); } }, true); });
  const hrefs = await page.evaluate(() => [...document.querySelectorAll('#fleet-rows > .li [data-f=attach]')].map(a => a.getAttribute('href')));
  const num = await page.evaluate(() => [getComputedStyle(document.querySelector('.fnum')).display, document.querySelector('.fnum').getBoundingClientRect().width]);
  check('1 .fnum badges are shown on a wide pointer:fine screen', num[0] !== 'none' && num[1] > 0, num);
  await page.keyboard.press('2');
  await page.keyboard.press('1');
  await page.keyboard.press('9');
  const ck = await page.evaluate(() => window.__clicked);
  check('2 digit keys click the nth attach link (2 -> row 2, 1 -> row 1; 9 with 4 rows does nothing)', ck.length === 2 && ck[0].includes('cc-alpha') && ck[1].includes('cc-beta') && hrefs.length === 4, ck);
  await page.evaluate(() => { window.__clicked.length = 0; });
  for (const k of ['Control+1', 'Alt+1', 'Meta+1']) await page.keyboard.press(k);
  check('3 ...ignored with Ctrl, Alt or Meta', (await page.evaluate(() => window.__clicked)).length === 0);
  await page.keyboard.press('/');
  const foc = await page.evaluate(() => ({ f: document.activeElement.dataset.f, v: document.activeElement.value }));
  check('4 / focuses the filter and does not type into it', foc.f === 'filter' && foc.v === '', foc);
  await page.keyboard.press('1');
  const typed = await page.evaluate(() => ({ v: document.activeElement.value, clicked: window.__clicked.length }));
  check('5 digits typed inside the filter are text, not clicks', typed.v === '1' && typed.clicked === 0, typed);
  const vis = async () => (await rows(page)).filter(x => x.shown).map(x => x.sid).join();
  const set = async v => { await page.fill('[data-f=filter]', v); };
  await set('alp');
  const f1 = await vis();
  await set('APPROVE');
  const f2 = await vis();
  await set('last words');
  const f3 = await vis();
  await set('zzz');
  const f4 = await vis();
  const cardsHidden = (await cards(page)).every(x => !x.shown);
  check('6 filter = substring over label + proj + snippet, case-insensitive (alp -> Alpha; APPROVE -> beta snippet; "last words" -> Delta; zzz -> none), on rows and cards',
    f1 === 'aaaa1111' && f2 === 'bbbb2222' && f3 === 'dddd4444' && f4 === '' && cardsHidden, { f1, f2, f3, f4 });
  check('7 filtering changes neither #fleet-count nor #fleet-empty', JSON.stringify(await chrome(page)) === '{"count":["4",false],"empty":true,"badge":["4",false]}');
  await set('eps');
  await emit(page, [...FLEET, fx('eeee5555', 'cc-eps', '', 'eps', 'idle', 10, 'x'), fx('ffff6666', 'cc-zed', '', 'zed', 'idle', 10, 'x')]);
  await page.waitForFunction(() => document.querySelectorAll('#fleet-rows > .li').length === 6);
  check('8 the filter stays applied across a live fleet event', (await vis()) === 'eeee5555', await vis());
  await set('');
  await ctx.close();
  const m = await open({ w: 390, h: 844, mobile: true });
  const nm = await m.page.evaluate(() => getComputedStyle(document.querySelector('.fnum')).display);
  check('9 .fnum badges are hidden on a touch phone', nm === 'none', nm);
  await m.ctx.close();
}

async function links() {
  const names = ['cc-beta', 'cc-alpha', 'cc-gamma', 'cc-delta'];
  const grab = page => page.evaluate(() => [...document.querySelectorAll('#fleet-rows > .li [data-f=attach]')].map(a => ({ href: a.getAttribute('href'), nw: a.dataset.nw, target: a.getAttribute('target') })));
  // the grid's desktop (a mouse, >= 1024 px): a row routes into /grid in this tab, that session as a pane; the query is gone afterwards
  {
    const d = await open();
    const g = await grab(d.page);
    check('0a on the grid\'s desktop the attach href is /grid?open=<name>, no data-nw, no target', g.every((x, i) => x.href === `/grid?open=${names[i]}` && x.nw === undefined && x.target === null), g);
    await d.ctx.route('**/term/**', r => r.fulfill({ status: 200, contentType: 'text/html', body: '<!doctype html><title>t</title>stub' }));
    await d.page.click('#fleet-rows > .li[data-sid=aaaa1111] [data-f=attach]');
    await d.page.waitForSelector('#grid .gp[data-name=cc-alpha]');
    const u = new URL(d.page.url());
    check('0b the click routes in place to /grid with that session as a pane, the query stripped', u.pathname === '/grid' && u.search === '' && (await d.page.evaluate(() => window.__doc)) === 'same-document' && (await d.page.evaluate(() => window.__grid.state().tabs.map(t => t.panes.join()).join('|'))) === 'cc-alpha', { url: d.page.url() });
    await d.ctx.close();
  }
  const { ctx, page } = await open({ w: 1000 }); // a fine pointer below 1024 px: the terminal document in a named window, as before
  const a = await grab(page);
  check('1 below 1024 px: attach href = /term/?arg=attach&arg=<name>&arg=<8 hex>&v=3', a.every((x, i) => x.href.startsWith(`/term/?arg=attach&arg=${names[i]}&arg=`) && /^\/term\/\?arg=attach&arg=[^&]+&arg=[0-9a-f]{8}&v=3$/.test(x.href)), a.map(x => x.href));
  check('2 data-nw = t-<name>', a.every((x, i) => x.nw === 't-' + names[i]), a.map(x => x.nw));
  check('3 browser display-mode, >= 700 px, fine pointer: data-nw becomes target', a.every((x, i) => x.target === 't-' + names[i]), a.map(x => x.target));
  await emit(page, FLEET.map(f => ({ ...f })));
  await page.waitForTimeout(150);
  const b = await grab(page);
  const tab = h => /arg=([0-9a-f]{8})&v=3/.exec(h)[1];
  check('4 a fresh tab id is minted on every render', a.every((x, i) => tab(x.href) !== tab(b[i].href)), { first: a.map(x => tab(x.href)), again: b.map(x => tab(x.href)) });
  const menus = await page.evaluate(() => ({ card: document.querySelector('a.newcard').getAttribute('href'), fab: document.querySelector('a.termfab').getAttribute('href'), hnew: document.querySelector('a.hnew').getAttribute('href'),
    label: document.querySelector('a.newcard').textContent }));
  check('5 + New Session card and the FAB use termHref(menu, "")', MENU_HREF.test(menus.card) && MENU_HREF.test(menus.fab) && MENU_HREF.test(menus.hnew) && /New Session/.test(menus.label), menus);
  // click: a data-nw link is the browser's, not the router's: it opens the NAMED window, once, and the shell page stays where it is
  const popups = []; ctx.on('page', p => popups.push(p));
  await page.click('#fleet-rows > .li[data-sid=aaaa1111] [data-f=attach]');
  await page.waitForTimeout(400);
  await page.click('#fleet-rows > .li[data-sid=aaaa1111] [data-f=attach]');
  await page.waitForTimeout(400);
  check('6 clicking attach opens the named window t-<name> (reused on a second click) and leaves the shell page in place', popups.length === 1 && /\/term\//.test(popups[0].url()) && new URL(page.url()).pathname === '/' && (await page.evaluate(() => window.__doc)) === 'same-document', { popups: popups.map(p => p.url()), page: page.url() });
  await ctx.close();

  for (const [id, o, why] of [
    ['7 a 390 px phone: no target', { w: 390, h: 844, mobile: true }, 'width < 700'],
    ['9 a landscape phone (>= 700 px, coarse pointer): no target', { w: 812, h: 375, stub: { coarse: true } }, 'coarse'],
  ]) {
    const x = await open(o);
    const t = await grab(x.page);
    check(id, t.length === 4 && t.every(y => y.target === null && y.nw.startsWith('t-')), { why, targets: t.map(y => y.target) });
    if (id.startsWith('7')) {
      const href = await x.page.evaluate(() => document.querySelector('#fleet-cards > .lp[data-sid=aaaa1111] [data-f=attach]').getAttribute('href'));
      await x.page.click('#fleet-cards > .lp[data-sid=aaaa1111] [data-f=attach]');
      await x.page.waitForURL(/\/term\//);
      check('10 on a phone the attach link navigates in place', /^\/term\/\?arg=attach&arg=cc-alpha&arg=[0-9a-f]{8}&v=3$/.test(href) && new URL(x.page.url()).pathname === '/term/', x.page.url());
    }
    await x.ctx.close();
  }
  { // the installed app on a desktop (standalone, a mouse, 1280 px) is the grid's desktop too: the row routes into the grid
    const x = await open({ stub: { standalone: true } });
    const t = await grab(x.page);
    check('8 the installed app on a desktop: the grid link, no target', t.length === 4 && t.every(y => y.target === null && y.href.startsWith('/grid?open=')), t.map(y => y.href));
    await x.ctx.close();
  }
}

async function standalone() {
  // the plain browser tab: none of the installed-app machinery
  const tab = await open({ w: 390, h: 844, mobile: true, stub: { short: true } });
  await tab.page.waitForTimeout(1100);
  const t = await tab.page.evaluate(() => ({ ptr: !!document.getElementById('ptr'), tog: window.__tog, env: document.getElementById('envout').textContent }));
  check('1 browser tab: no #ptr, no vpfix toggles, #envout reads "tab · sat0 sab0"', !t.ptr && t.tog === 0 && /^tab · sat\d+ sab\d+$/.test(t.env), t);
  check('2 ...and the dash3 beacon is sent once with m=tab', tab.z.filter(u => /t=dash3&m=tab&/.test(u)).length === 1, tab.z);
  await tab.ctx.close();

  // pull-to-refresh
  const app = await open({ w: 390, h: 844, mobile: true, stub: { standalone: true } });
  const p = app.page;
  const touch = (type, y) => p.evaluate(([type, y]) => { const e = new Event(type, { bubbles: true, cancelable: true }); Object.defineProperty(e, 'touches', { value: type === 'touchend' ? [] : [{ clientY: y }] }); window.dispatchEvent(e); }, [type, y]);
  const ptr = () => p.evaluate(() => { const e = document.getElementById('ptr'); return e && { go: e.classList.contains('go'), op: e.style.opacity, tf: e.style.transform, svg: !!e.querySelector('svg'), pos: getComputedStyle(e).position }; });
  check('3 installed app: #ptr exists (fixed, with the refresh icon)', JSON.stringify(await ptr()) === JSON.stringify({ go: false, op: '', tf: '', svg: true, pos: 'fixed' }), await ptr());
  await touch('touchstart', 100); await touch('touchmove', 100 + 110);
  const s55 = await ptr();
  await touch('touchend');
  await p.waitForTimeout(300);
  const small = await p.evaluate(() => ({ doc: window.__doc, ptr: !!document.getElementById('ptr') }));
  check('4 a 110 px pull (indicator at 55 px) is below the 56 px threshold: no .go, no reload', !s55.go && small.doc === 'same-document' && small.ptr, { s55, small });
  await touch('touchstart', 100); await touch('touchmove', 100 + 112);
  const s56 = await ptr();
  const rl = p.waitForEvent('load', { timeout: 5000 }).then(() => true, () => false);
  await touch('touchend');
  check('5 a 112 px pull (indicator at 56 px) sets .go, and releasing it calls location.reload()', s56.go && s56.op === '1' && /rotate\(168deg\)/.test(s56.tf) && (await rl) && (await p.evaluate(() => window.__doc)) !== 'same-document', s56);
  await p.waitForSelector('#app h1[data-view="sessions"]', { state: 'attached' });
  await p.evaluate(() => window.scrollTo(0, 200)); await p.waitForTimeout(100);
  await touch('touchstart', 100); await touch('touchmove', 300);
  check('6 not armed when the page is scrolled (scrollY > 0)', !(await ptr()).go);
  await app.ctx.close();

  // vpfix + envout + beacons: a screen taller than the viewport makes the viewport read "short"
  const vp = await open({ w: 390, h: 844, mobile: true, stub: { standalone: true, short: true } });
  const q = vp.page;
  await q.waitForFunction(() => window.__tog >= 6, null, { timeout: 8000 }).catch(() => {});
  const t1 = await q.evaluate(() => window.__tog);
  await q.waitForTimeout(4500); // the reload, then a second page that must not reload again
  await q.waitForSelector('#app h1[data-view="sessions"]', { state: 'attached' });
  const t2 = await q.evaluate(() => ({ tog: window.__tog, vpr: sessionStorage.vpr, env: document.getElementById('envout').textContent }));
  const beaconsOff = vp.z.filter(u => /t=vpfix/.test(u) && /ok=0/.test(u) && /r=1/.test(u));
  check('7 vpfix: at most 6 display:none toggles of the body per page, then ONE reload', t1 === 6 && vp.loads() === 2 && t2.tog === 6, { toggles: t1, loads: vp.loads(), after: t2.tog });
  check('8 ...the reload is rate-limited to one per 30 s (sessionStorage.vpr); the next exhaustion beacons /z?t=vpfix&ok=0&r=1 instead', /^\d+$/.test(t2.vpr || '') && beaconsOff.length >= 1, { vpr: t2.vpr, beacons: beaconsOff.length });
  check('9 #envout reads "app · sat<n> sab<n>" and /z?t=dash3&m=app is sent', /^app · sat\d+ sab\d+$/.test(t2.env) && vp.z.some(u => /t=dash3&m=app&/.test(u)), { env: t2.env });
  await vp.ctx.close();

  // top-anchored chrome: the stylesheet carries the standalone rules (a display-mode media query cannot be emulated)
  const st = await open({ w: 390, h: 844, mobile: true });
  const rules = await st.page.evaluate(() => {
    const out = [];
    const walk = rs => { for (const r of rs) { if (r.media && /display-mode:\s*standalone/.test(r.media.mediaText)) out.push(r.cssText); if (r.cssRules) walk(r.cssRules); } };
    for (const s of document.styleSheets) { try { walk(s.cssRules); } catch {} }
    return out.join('\n');
  });
  check('10 tokens.css holds the display-mode: standalone rules that anchor .tabs and .termfab from the top', /\.tabs\s*\{[^}]*top:/.test(rules) && /\.termfab\s*\{[^}]*top:/.test(rules), rules.slice(0, 300));
  await st.ctx.close();
}

async function prefetch() {
  const { ctx, page, api } = await open();
  const reqs = () => api.filter(u => !u.startsWith('/api/agents/'));
  check('1 nothing is fetched before a hover', reqs().length === 0, reqs());
  await page.hover('.pnav a[href="/history"]');
  await page.waitForFunction(() => true); await page.waitForTimeout(250);
  check('2 pointerenter on History fetches /api/history into the store', reqs().join() === '/api/history', reqs());
  await page.hover('.pnav a[href="/system"]');
  await page.hover('.pnav a[href="/agents"]');
  await page.waitForTimeout(250);
  check('3 ...System fetches /api/system, Agents /api/agents', reqs().join() === '/api/history,/api/system,/api/agents', reqs());
  await page.hover('.pnav a[href="/history"]'); await page.hover('.pnav a[href="/system"]');
  await page.waitForTimeout(250);
  check('4 a second hover does not refetch (one GET per url)', reqs().length === 3, reqs());
  await page.evaluate(() => {
    const l = document.querySelectorAll('.pnav a');
    l[1].setAttribute('href', '/history?fresh=1');
    l[2].setAttribute('href', '/system?reclaim=1');
    l[3].setAttribute('href', '/term/?arg=menu&arg=&arg=00000000&v=3');
    l[4].setAttribute('href', '/agents'); l[4].setAttribute('data-norun', '');
  });
  for (const i of [2, 3, 4, 5]) await page.hover(`.pnav a:nth-child(${i})`);
  await page.waitForTimeout(250);
  check('5 never for fresh=1, reclaim=1, /term* or data-norun links', reqs().length === 3, reqs());
  await ctx.close();

  // touch, and a tap after the prefetch renders with no request
  const m = await open({ w: 390, h: 844, mobile: true });
  await m.page.dispatchEvent('.tb[href="/system"]', 'touchstart');
  await m.page.waitForTimeout(250);
  check('6 touchstart on a tab link prefetches it', m.api.join() === '/api/system', m.api);
  await m.page.tap('.tb[href="/system"]');
  await m.page.waitForSelector('#app h1[data-view="system"]');
  await m.page.waitForTimeout(250);
  check('7 the tap that follows renders the route without another request', m.api.join() === '/api/system' && (await m.page.evaluate(() => window.__doc)) === 'same-document', m.api);
  await m.ctx.close();
}

async function history() {
  const many = Array.from({ length: 30 }, (_, i) => fx(`s${String(i).padStart(7, '0')}`, `cc-${i}`, `Session ${i}`, `proj${i}`, i % 2 ? 'idle' : 'working', 60 + i * 120, 'line of output '.repeat(4)));
  const { ctx, page } = await open({ w: 390, h: 844, mobile: true, fleet: many });
  const net = []; page.on('request', r => { if (!/\/z\?/.test(r.url())) net.push(r.url()); }); // the shell's own /z diagnostic beacon is not a data request
  const y = () => page.evaluate(() => Math.round(scrollY));
  const settle = async want => { await page.waitForFunction(w => Math.abs(scrollY - w) <= 2, want, { timeout: 3000 }).catch(() => {}); return y(); };
  const to = async v => { await page.evaluate(v => window.scrollTo(0, v), v); await page.waitForTimeout(120); };
  const tall = await page.evaluate(() => document.documentElement.scrollHeight);
  check('0 the fixture is taller than the screen, and the shell took over scroll restoration', tall > 2000 && (await page.evaluate(() => history.scrollRestoration)) === 'manual', { tall });
  await to(300);
  await page.click('.tb[href="/history"]');
  await page.waitForSelector('#app h1[data-view="history"]');
  await page.waitForTimeout(150);
  const h0 = await y();
  net.length = 0;
  await page.goBack();
  await page.waitForSelector('#app h1[data-view="sessions"]');
  const back1 = await settle(300);
  check('1 Back re-renders Sessions from the store and restores the offset (300)', h0 === 0 && back1 === 300, { history: h0, back: back1 });
  check('2 ...with no request at all', net.length === 0, net);
  await to(700);
  await page.goForward();
  await page.waitForSelector('#app h1[data-view="history"]');
  await page.waitForTimeout(150);
  await page.goBack();
  await page.waitForSelector('#app h1[data-view="sessions"]');
  const back2 = await settle(700);
  check('3 scroll -> Back -> Forward -> Back lands on the offset just set (700), the case the /ui SPA left open', back2 === 700, { back2 });
  check('4 ...still no request and still the same document', net.length === 0 && (await page.evaluate(() => window.__doc)) === 'same-document', net);
  check('5 the last list survives the round trip (30 cards)', (await page.evaluate(() => document.querySelectorAll('#fleet-cards > .lp').length)) === 30);
  await ctx.close();
}

const table = { render, actions, keys, links, standalone, prefetch, history };
for (const m of mode === 'all' ? MODES : [mode]) {
  cur = m;
  try { await table[m](); } catch (e) { bad++; console.log(`FAIL ${m} threw ${String(e.stack || e).split('\n').slice(0, 3).join(' | ')}`); }
}
cur = 'all';
check('zero console errors', errors.length === 0, errors);
await browser.close();
console.log(bad ? `sessions-check ${engine} ${mode}: ${bad} FAILED` : `sessions-check ${engine} ${mode}: all passed`);
process.exit(bad ? 1 : 0);
