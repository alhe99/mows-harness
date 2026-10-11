// Cockpit phase 03 views probe (specs/cockpit/03-views.md tasks 2, 3, 4, 5, 8). Exit code is the verdict.
// usage: node docs/qa/probes/views-check.mjs <webkit|chromium> <history|system|device|session|all>
// env: DASH (default http://127.0.0.1:3105), PLAYWRIGHT (module path; default: the repo's)
// Every view runs against the /next shell on the dev instance with FIXTURE data: the boot snapshot in the document is rewritten in flight,
// EventSource is replaced by a fake that window.__emit(name, data) drives, and every /api/*, /a/*, /droid/*, /watch/*, /sys/*, /z, /term/*,
// /droidview/* and /vnc/* request is answered here, so nothing the probe does can reach a real session, container or disk and the result does
// not depend on what the box holds. The fixture "server" below filters, pages and mutates its rows the way routes/api.mjs does, so a chip, a
// pager link or a form has an observable effect. `window.__doc` marks the document: a navigation that loads a new one loses it.
// Selectors the probe uses (the legacy markup, kept): details.flt .chip .row .day .lvb .go details.del nav.pg .pgtot | .mbar .mbar-fill.warn
// .envrow .dangerbtn .chip .rf .rrow .qrow .ubd | .segbtn .devcard .ctlbtn .stageempty iframe.vnc iframe#vf .fsbtn | .meta .la .m .note.
const pw = await import(process.env.PLAYWRIGHT || 'playwright').catch(() => { console.error('views-check: playwright is not installed (npm ci --ignore-scripts)'); process.exit(2); });
const engine = process.argv[2] || 'webkit';
const mode = process.argv[3] || 'all';
const MODES = ['history', 'system', 'device', 'session'];
if (mode !== 'all' && !MODES.includes(mode)) { console.error(`views-check: mode is one of ${MODES.join(' ')} all`); process.exit(2); }
const DASH = process.env.DASH || 'http://127.0.0.1:3105';
const browser = await pw[engine].launch();

let bad = 0, cur = '';
const errors = [];
const check = (id, ok, detail) => { if (!ok) bad++; console.log(`${ok ? 'PASS' : 'FAIL'} ${mode === 'all' ? cur + ' ' : ''}${id}${detail === undefined ? '' : ' ' + JSON.stringify(detail)}`); };
const sleep = ms => new Promise(r => setTimeout(r, ms));
const T = Date.now(), DAY = 86400e3;

// ---- the fixture world -----------------------------------------------------------------------------------------------------------------
const SID = n => `${String(n).padStart(8, '0')}-0000-4000-8000-000000000000`;
const ACCTS = [{ id: 'demo', label: 'demo', color: '#58a6ff', term: true }, { id: 'bot', label: 'bot', color: '#bc8cff', term: false }];
const PAGE_ROWS = 5;
const mkRows = () => Array.from({ length: 12 }, (_, i) => ({ a: i % 4 === 3 ? 'bot' : 'demo', sid: SID(i + 1), sid8: String(i + 1).padStart(8, '0'), proj: i % 2 ? '-demo-api' : '-home-demo-web-app',
  mt: T - (i < 6 ? (i + 2) * 3600e3 : (i - 4) * DAY), sz: 2048 * (i + 1), title: i === 2 ? '' : `Session number ${i + 1}`, live: false, canResume: i < 8, acctColor: i % 4 === 3 ? '#bc8cff' : '#58a6ff' }));
const dayLbl = ms => { const d = new Date(ms).toISOString().slice(0, 10), t = new Date().toISOString().slice(0, 10), y = new Date(Date.now() - DAY).toISOString().slice(0, 10);
  return d === t ? 'today' : d === y ? 'yesterday' : new Date(ms).toUTCString().slice(5, 16); };
const fleetOf = (...rows) => rows.map(r => ({ sid8: r.sid8, name: 'cc-' + r.sid8, label: '', proj: 'p', state: 'working', rel: Date.now(), snippet: '' }));

function world(over = {}) {
  const W = { rows: mkRows(), fleet: [], posts: [], gets: [], keys: [], pollsLeft: 0, ...over };
  W.system = { load: 1.2, cores: 4, memUsed: 3e9, memTot: 8e9, swapUsed: 0, swapTot: 0, dskUsed: 9e10, dskTot: 1e11, up: 108000, version: '2.1.0',
    usage: { quota: { demo: { h5: 12, wk: 61 } }, thr: 70, accts: { demo: { id: 'demo', label: 'demo', qkey: 'demo', tokExp: 0, cc: true, today: 1.5, week: 9.25, month: 40, block: { cost: 0.3, rate: 1.1 },
      models: [{ name: 'claude-sonnet-4', cost: 1.5 }], days: [{ d: '2026-10-11', cost: 1.5, models: ['sonnet-4'] }, { d: '2026-10-10', cost: 2, models: ['opus-4'] }],
      sess: [{ sid: SID(1), cost: 0.5, models: ['sonnet-4'] }] } } }, usageAt: T - 120e3, busy: false, live: 0, deployed: T - 3600e3 * 30, node: 'v22.0.0', platform: 'linux/arm64' };
  W.reclaim = [{ id: 'journal', label: 'systemd journal', note: 'vacuum down to 200M', g: '', b: 3 * 1073741824, extra: '' }, { id: 'tmp', label: 'stale /tmp scratch dirs', note: 'tool litter, 7 days cold', g: '', b: 1048576, extra: '40 entries' },
    { id: 'browsers', label: 'playwright + puppeteer browsers', note: 'next QA journey re-downloads ~1.3 G', g: 'qa', b: 1.3 * 1073741824, extra: '' }, { id: 'npm', label: 'npm cache', note: '.npm/_cacache', g: '', b: 0, extra: '' }];
  W.device = { dv: 'mobile', droid: { state: 'stopped', res: '', udid: '127.0.0.1:6555' }, web: { live: false, port: 6080 } };
  const msgs = [];
  for (let i = 0; i < 31; i++) msgs.push(i % 5 === 1 ? { role: 'tool', ts: '2026-10-11T10:00:00Z', name: 'Bash', text: '{"command":"ls"}' } : i % 5 === 2 ? { role: 'res', ts: '', text: 'a.txt' }
    : { role: i % 2 ? 'claude' : 'user', ts: `2026-10-11T10:${String(i).padStart(2, '0')}:07Z`, text: i === 30 ? 'x'.repeat(3000) : `message ${i}` });
  msgs.splice(10, 0, { role: 'sum', ts: '', text: 'earlier work, compacted' });
  W.msgs = msgs; W.sess = { a: 'demo', sid: SID(1), live: null, mt: T - 2 * 3600e3, truncated: true, term: true };
  return W;
}
const histFor = (W, u) => {
  const sp = u.searchParams, acct = sp.get('acct') || '', q = (sp.get('q') || '').toLowerCase(), d = sp.get('d') || '', s = sp.get('s') || '';
  const live = new Set(W.fleet.map(f => f.sid8));
  let rows = W.rows.map(r => ({ ...r, live: live.has(r.sid8) }));
  if (acct) rows = rows.filter(r => r.a === acct);
  if (q) rows = rows.filter(r => r.proj.toLowerCase().includes(q) || r.sid.startsWith(q));
  if (d === '7d') rows = rows.filter(r => r.mt >= T - 7 * DAY);
  if (d === 'today') rows = rows.filter(r => dayLbl(r.mt) === 'today');
  if (s === 'live') rows = rows.filter(r => r.live);
  const max = Math.max(1, Math.ceil(rows.length / PAGE_ROWS)), cur = Math.min(max, Math.max(1, +(sp.get('page') || 1) || 1));
  return { page: cur, pages: max, total: rows.length, live: live.size, indexed: W.rows.length, acct, label: '', resumeDays: 7,
    rows: rows.slice((cur - 1) * PAGE_ROWS, cur * PAGE_ROWS), accts: ACCTS.map(a => ({ ...a, n: W.rows.filter(r => r.a === a.id).length })) };
};
const sysFor = (W, u) => ({ ...W.system, now: Date.now(), ...(u.searchParams.get('reclaim') ? { reclaim: W.reclaim } : {}) });
const sessFor = (W, u) => {
  const n = W.msgs.length, max = Math.ceil(n / 25), cur = Math.min(max, Math.max(1, +(u.searchParams.get('page') || 1) || 1)), end = n - (cur - 1) * 25;
  return { a: W.sess.a, sid: W.sess.sid, sid8: W.sess.sid.slice(0, 8), acct: { label: 'demo', color: '#58a6ff', term: W.sess.term }, proj: '/demo/api', started: '2026-10-11T09:00:00Z', mt: W.sess.mt,
    sz: 123456, items: n, tools: 6, model: 'claude-sonnet-4', truncated: W.sess.truncated, live: W.sess.live, canResume: !!W.sess.live || Date.now() - W.sess.mt < 7 * DAY, resumeDays: 7,
    page: cur, pages: max, msgs: W.msgs.slice(Math.max(0, end - 25), end) };
};
const json = (route, body, status = 200) => route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) });

// stand a context up on a route; returns the page and the world
async function open(path, over = {}, ctxOpts = {}) {
  const W = world(over);
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 800 }, serviceWorkers: 'block', ...ctxOpts });
  await ctx.addInitScript(() => {
    const all = (window.__es = []);
    window.EventSource = class {
      constructor(url) { this.url = url; this.readyState = 1; this.l = {}; all.push(this); setTimeout(() => (this.l.open || []).forEach(f => f({})), 0); }
      addEventListener(n, f) { (this.l[n] ||= []).push(f); }
      close() { this.readyState = 2; }
    };
    window.__emit = (name, data) => all.forEach(e => (e.l[name] || []).forEach(f => f({ data: JSON.stringify(data), lastEventId: '' })));
  });
  await ctx.route(u => u.pathname === '/next' || (u.pathname.startsWith('/next/') && !u.pathname.includes('.')), async route => {
    const u = new URL(route.request().url());
    const r = await route.fetch();
    const html = (await r.text()).replace(/(<script type="application\/json" id="boot"[^>]*>)([\s\S]*?)(<\/script>)/, (_, a, j, c) => {
      const b = JSON.parse(j), p = u.pathname.replace(/^\/next/, '') || '/';
      delete b.history; delete b.system; delete b.device; delete b.session;
      b.fleet = W.fleet; b.live = W.fleet.length;
      if (p === '/history') b.history = histFor(W, u);
      if (p === '/system') b.system = sysFor(W, u);
      if (p === '/device') { b.device = { ...W.device }; if (u.searchParams.get('dv')) b.device.dv = u.searchParams.get('dv'); }
      if (p.startsWith('/s/')) b.session = sessFor(W, u);
      return a + JSON.stringify(b).replace(/</g, '\\u003c') + c;
    });
    const headers = { ...r.headers() }; delete headers['content-encoding']; delete headers['content-length'];
    await route.fulfill({ status: r.status(), headers, body: html });
  });
  await ctx.route('**/api/**', route => {
    const req = route.request(), u = new URL(req.url());
    if (req.method() === 'POST') {
      W.posts.push({ path: u.pathname, body: req.postData() || '' });
      if (u.pathname === '/api/usage/refresh') { W.system.busy = true; W.pollsLeft = 1; return json(route, { ok: true }, 202); }
      return json(route, {});
    }
    W.gets.push(u.pathname + u.search);
    if (u.pathname === '/api/history') return json(route, histFor(W, u));
    if (u.pathname === '/api/system') {
      if (W.system.busy && W.pollsLeft-- <= 0) { W.system.busy = false; W.system.usageAt = Date.now(); W.system.usage.accts.demo.today = 7.77; }
      return json(route, sysFor(W, u));
    }
    if (u.pathname === '/api/device') {
      if (W.device.droid.state === 'booting' && W.pollsLeft-- <= 0) { W.device.droid = { ...W.device.droid, state: 'live', res: '1080×1920' }; }
      return json(route, { ...W.device, dv: u.searchParams.get('dv') || W.device.dv });
    }
    if (u.pathname.startsWith('/api/session/')) return json(route, sessFor(W, u));
    return json(route, {}, 404);
  });
  // the actions: record, mutate the fixture and answer the 303 the real server would
  await ctx.route(u => /^\/(a|droid|watch|sys)\//.test(u.pathname), route => {
    const req = route.request(), u = new URL(req.url()), body = new URLSearchParams(req.postData() || '');
    W.posts.push({ path: u.pathname, body: Object.fromEntries(body) });
    if (u.pathname === '/a/del') W.rows = W.rows.filter(r => r.sid !== body.get('sid'));
    // restart all and reclaim answer a fetch that asks for JSON with their result, as routes/actions.mjs does
    if (u.pathname === '/a/restartall') return json(route, { rs: W.fleet.length });
    if (u.pathname === '/sys/reclaim') return json(route, { freed: 1073741824, n: body.getAll('t').length });
    if (u.pathname === '/droid/start') { W.device.droid.state = 'booting'; W.pollsLeft = 1; }
    if (u.pathname === '/droid/stop') { W.device.droid = { ...W.device.droid, state: 'stopped', res: '' }; }
    if (u.pathname === '/watch/start') { W.device.web.live = true; }
    if (u.pathname === '/watch/stop') { W.device.web.live = false; }
    if (u.pathname === '/a/pause' && W.sess.live) W.sess.live = { ...W.sess.live, paused: true };
    if (u.pathname === '/a/resume' && W.sess.live) W.sess.live = { ...W.sess.live, paused: false };
    if (u.pathname === '/a/kill') W.sess.live = null;
    if (u.pathname === '/a/label' && W.sess.live) W.sess.live = { ...W.sess.live, label: body.get('label') };
    return route.fulfill({ status: 200, body: '' }); // the real server answers 303 to `loc`; the shell does not follow it
  });
  await ctx.route('**/z?*', r => r.fulfill({ status: 204 }));
  await ctx.route('**/term/**', r => r.fulfill({ status: 200, contentType: 'text/html', body: '<!doctype html><title>term</title>term' }));
  await ctx.route('**/droidview/**', r => r.fulfill({ status: 200, contentType: 'text/html', body: '<!doctype html><title>stream</title>stream' }));
  await ctx.route('**/vnc/**', r => r.fulfill({ status: 200, contentType: 'text/html', body: `<!doctype html><title>vnc</title><button id="noVNC_keyboard_button"></button>
<script>window.rfb={sendKey:function(){(top.__keys=top.__keys||[]).push([].slice.call(arguments))}};document.getElementById('noVNC_keyboard_button').onclick=function(){top.__kb=1}</script>` }));
  const page = await ctx.newPage();
  page.on('console', m => { if (m.type() === 'error' && !/interactive-widget/.test(m.text())) errors.push(m.text()); });
  page.on('pageerror', e => errors.push(String(e)));
  await page.goto(DASH + '/next' + path, { waitUntil: 'load' });
  await page.waitForSelector('#app [data-view]', { state: 'attached' });
  await page.waitForTimeout(100);
  await page.evaluate(() => { window.__doc = 'same-document'; });
  const same = () => page.evaluate(() => window.__doc === 'same-document');
  return { ctx, page, W, same };
}
const txt = (page, sel) => page.evaluate(s => [...document.querySelectorAll(s)].map(n => n.textContent.replace(/\s+/g, ' ').trim()), sel);
const count = (page, sel) => page.evaluate(s => document.querySelectorAll(s).length, sel);
const search = page => page.evaluate(() => location.search);
const sids = page => page.evaluate(() => [...document.querySelectorAll('.hlist .row .sid')].map(n => n.textContent));

// ---- history ---------------------------------------------------------------------------------------------------------------------------
async function history() {
  const { ctx, page, W, same } = await open('/history');
  const d0 = await page.evaluate(() => ({ days: [...document.querySelectorAll('.hlist .day')].map(n => n.textContent), n: document.querySelectorAll('.hlist .li').length, t: document.querySelector('.hlist .row .t').textContent,
    acct: document.querySelector('.hlist .row .acct').textContent, proj: document.querySelector('.hlist .row .proj').textContent, ttl: document.querySelector('.hlist .row .ttl').textContent,
    sz: document.querySelector('.hlist .row .sz').textContent, sid: document.querySelector('.hlist .row .sid').textContent, href: document.querySelector('.hlist .row').getAttribute('href'),
    h1: document.querySelector('#app h1').textContent, summary: [...document.querySelector('details.flt summary').children].map(n => n.textContent).join(' '), open: document.querySelector('details.flt').open }));
  check('1 the first page renders from the boot snapshot: 5 rows in day groups, h1 "mows · history"', d0.n === 5 && d0.days[0] === dayLbl(W.rows[0].mt) && d0.h1.includes('· history'), d0);
  check('2 a row: age, account, project, title, size, sid8, link into /next/s/<acct>/<sid>', d0.t === '2h' && d0.acct === 'demo' && d0.proj === 'web/app' && d0.ttl === 'Session number 1' && d0.sz === '2K' && d0.sid === '00000001' && d0.href === `/next/s/demo/${SID(1)}`, d0);
  check('3 the filter summary: "filter all · all time · 12 sessions", folded while no filter is set', /^filter all · all time · 12 sessions$/.test(d0.summary) && !d0.open, d0.summary);
  const r3 = await page.evaluate(() => [...document.querySelectorAll('.hlist .row')].map(r => [r.querySelector('.ttl .notitle')?.textContent ?? null, !!r.parentElement.querySelector('.go'), !!r.parentElement.querySelector('details.del')]));
  check('4 an empty title reads "(no title)"; .go only for a terminal account within the resume window; delete offered on every idle row', r3[2][0] === '(no title)' && r3[0][1] === true && r3[3][1] === false && r3.every(x => x[2]), r3);
  const go = await page.evaluate(() => { const a = document.querySelector('.hlist .go'); return { href: a.getAttribute('href'), nw: a.dataset.nw, title: a.title }; });
  check('5 .go resumes in the terminal with a fresh 8-hex tab id and a named window', /^\/term\/\?arg=open&arg=00000001&arg=[0-9a-f]{8}&v=3$/.test(go.href) && go.nw === 't-00000001' && go.title === 'resume in terminal', go);

  await page.click('details.flt summary');
  await page.click('details.flt .chip:has-text("bot")');
  await page.waitForFunction(() => new URLSearchParams(location.search).get('acct') === 'bot' && document.querySelectorAll('.hlist .li').length === 3);
  const a1 = await page.evaluate(() => ({ n: document.querySelectorAll('.hlist .li').length, sel: [...document.querySelectorAll('.chip.sel')].map(c => c.textContent.trim()), open: document.querySelector('details.flt').open,
    summary: [...document.querySelector('details.flt summary').children].map(n => n.textContent).join(' '), accts: [...document.querySelectorAll('.hlist .acct')].map(n => n.textContent) }));
  check('6 an account chip filters without a document load: URL ?acct=bot, 3 rows, chip selected, filter open, "of 12" in the summary', await same() && a1.n === 3 && a1.accts.every(x => x === 'bot') && a1.sel.includes('bot 3') && a1.open && /filter bot · all time · 3 of 12 sessions/.test(a1.summary), a1);
  check('7 ...and the bot account has no terminal, so no .go', (await count(page, '.hlist .go')) === 0);
  await page.click('details.flt .chip:has-text("7 days")');
  await page.waitForFunction(() => new URLSearchParams(location.search).get('d') === '7d');
  await page.waitForTimeout(200);
  check('8 a range chip adds ?d=7d and keeps the account', await same() && /acct=bot/.test(await search(page)) && /d=7d/.test(await search(page)), await search(page));
  await page.click('details.flt .chip:has-text("all"):not(:has-text("time"))');
  await page.waitForFunction(() => !new URLSearchParams(location.search).get('acct'));
  await page.waitForTimeout(200);
  check('9 the "all" account chip drops ?acct', await same() && (await count(page, '.hlist .li')) === 5, await search(page));

  await page.fill('details.flt input[name=q]', 'WEB');
  await page.press('details.flt input[name=q]', 'Enter');
  await page.waitForFunction(() => new URLSearchParams(location.search).get('q') === 'WEB' && /“web”/.test(document.querySelector('details.flt summary').textContent) && [...document.querySelectorAll('.hlist .proj')].every(n => n.textContent === 'web/app'));
  const q1 = await page.evaluate(() => ({ n: document.querySelectorAll('.hlist .li').length, projs: [...new Set([...document.querySelectorAll('.hlist .proj')].map(n => n.textContent))], summary: [...document.querySelector('details.flt summary').children].map(n => n.textContent).join(' '), v: document.querySelector('input[name=q]').value }));
  check('10 the search form submits without a document load: ?q=WEB, only matching projects, “web” in the summary, the field keeps its (lower-cased) text', await same() && q1.projs.join() === 'web/app' && /“web”/.test(q1.summary) && q1.v === 'web', q1);
  await page.goto(DASH + '/next/history', { waitUntil: 'load' });
  await page.waitForSelector('#app [data-view=history]', { state: 'attached' });
  await page.evaluate(() => { window.__doc = 'same-document'; });

  await page.click('nav.pg a[aria-label="next page"]');
  await page.waitForFunction(() => new URLSearchParams(location.search).get('page') === '2' && document.querySelector('.pgnum .cur').textContent === '2');
  const p2 = await page.evaluate(() => ({ cur: document.querySelector('.pgnum .cur').textContent, max: document.querySelector('.pgnum .muted').textContent, tot: document.querySelector('.pgtot').textContent, off: document.querySelectorAll('nav.pg .off').length, sids: [...document.querySelectorAll('.hlist .sid')].map(n => n.textContent) }));
  check('11 the pager moves without a document load: page 2 of 3, "12 total", rows 6-10', await same() && p2.cur === '2' && p2.max === '/ 3' && p2.tot === '12 total' && p2.off === 0 && p2.sids.join() === '00000006,00000007,00000008,00000009,00000010', p2);
  await page.click('nav.pg a[aria-label="last page"]');
  await page.waitForFunction(() => document.querySelector('.pgnum .cur').textContent === '3');
  check('12 last page: next and last are disabled', (await page.evaluate(() => [...document.querySelectorAll('nav.pg .off')].length)) === 2 && (await sids(page)).length === 2);
  await page.click('nav.pg a[aria-label="first page"]');
  await page.waitForFunction(() => document.querySelector('.pgnum .cur').textContent === '1');
  check('13 first page drops ?page', (await sids(page))[0] === '00000001');

  await page.evaluate(() => document.activeElement && document.activeElement.blur()); // focus off any field
  await page.evaluate(() => { document.querySelector('details.flt').open = false; });
  await page.keyboard.press('/');
  check('14 the / key opens the filter and focuses the search field', await page.evaluate(() => document.querySelector('details.flt').open && document.activeElement === document.querySelector('input[name=q]')));

  // delete: confirm in the row's own popover, post, refetch, the row is gone
  await page.click('.hlist .li:nth-child(2) details.del summary, .hlist .li:has(.sid:text("00000001")) details.del summary');
  const conf = await page.evaluate(() => { const d = document.querySelector('details.del[open]'); return d && d.querySelector('.kc').textContent.replace(/\s+/g, ' ').trim(); });
  check('15 delete asks first: "delete 00000001? removes the transcript from disk — no undo."', conf === 'delete 00000001?removes the transcript from disk — no undo.Delete It' || /delete 00000001\?/.test(conf || ''), conf);
  await page.click('details.del[open] button');
  await page.waitForFunction(() => ![...document.querySelectorAll('.hlist .sid')].some(n => n.textContent === '00000001'));
  const dp = W.posts.find(p => p.path === '/a/del');
  check('16 Delete It posts /a/del {a, sid} and the list updates in place', !!dp && dp.body.a === 'demo' && dp.body.sid === SID(1) && (await same()) && (await count(page, '.hlist .li')) === 5, dp);

  // live topic
  await page.evaluate(() => { document.querySelector('details.flt').open = true; });
  const before = await page.evaluate(() => ({ lvb: document.querySelectorAll('.hlist .lvb').length }));
  await page.evaluate(f => window.__emit('fleet', f), fleetOf(W.rows[1]));
  await page.waitForSelector('.hlist .lvb');
  const l1 = await page.evaluate(() => { const r = document.querySelector('.hlist .lvb').closest('.li'); return { sid: r.querySelector('.sid').textContent, go: r.querySelector('.go')?.getAttribute('href'), goTitle: r.querySelector('.go')?.title, del: !!r.querySelector('details.del'), ttl: r.querySelector('.ttl').textContent, chip: [...document.querySelectorAll('details.flt .chip')].find(c => /^live/.test(c.textContent.trim()))?.textContent.trim() }; });
  check('17 a fleet event makes the row LIVE: pill before the title, attach link to the tmux session, no delete, the live chip counts it', before.lvb === 0 && l1.sid === '00000003' && /^LIVE/.test(l1.ttl) && /arg=attach&arg=cc-00000003&arg=[0-9a-f]{8}/.test(l1.go) && l1.goTitle === 'attach (live)' && !l1.del && l1.chip === 'live 1', l1);
  await page.evaluate(() => window.__emit('fleet', []));
  await page.waitForFunction(() => !document.querySelector('.hlist .lvb'));
  check('18 ...and an empty fleet takes it back: no pill, delete offered again', (await count(page, '.hlist details.del')) === 5 && (await page.evaluate(() => [...document.querySelectorAll('details.flt .chip')].find(c => /^live/.test(c.textContent.trim())).textContent.trim())) === 'live 0');
  await ctx.close();
}

// ---- system ----------------------------------------------------------------------------------------------------------------------------
async function system() {
  const { ctx, page, W, same } = await open('/system', { fleet: fleetOf({ sid8: 'aaaa1111' }, { sid8: 'bbbb2222' }) });
  const bars = () => page.evaluate(() => [...document.querySelectorAll('.mbar')].map(b => ({ label: b.querySelector('.mbar-label').textContent, pct: b.querySelector('.mbar-pct').textContent, val: b.querySelector('.mbar-val').textContent,
    w: b.querySelector('.mbar-fill').style.width, warn: b.querySelector('.mbar-fill').classList.contains('warn') })));
  const b0 = await bars();
  check('1 four meters: Load average, Memory, Swap, Disk / with percentage, value and fill width', b0.map(b => b.label).join() === 'Load average,Memory,Swap,Disk /' && b0.map(b => b.pct).join() === '30%,38%,0%,90%' && b0[0].val === '1.20 / 4 cores' && b0[1].val === '2.8 / 7.5 G' && b0[0].w === '30%', b0);
  check('2 swap not configured reads so; only the disk (90 % > 85) is in the warn state', b0[2].val === 'not configured' && b0.map(b => b.warn).join() === 'false,false,false,true', b0.map(b => b.warn));
  const env = await page.evaluate(() => Object.fromEntries([...document.querySelectorAll('.envrow')].map(r => [r.querySelector('.envkey').textContent, r.querySelector('.envval').textContent])));
  check('3 Environment: ONLINE, version, uptime 1d 6h, deployed 30h ago, node, os', env.STATUS === 'ONLINE' && env.VERSION === '2.1.0' && env.UPTIME === '1d 6h' && env.LAST_DEPLOY === '30h ago' && env.NODE === 'v22.0.0' && env.OS === 'linux/arm64', env);
  const rs = await page.evaluate(() => document.querySelector('.dangerbtn').textContent.trim());
  check('4 Terminal card offers "Restart All Sessions (2)" while two sessions are live', rs === 'Restart All Sessions (2)', rs);
  await page.click('details.kx summary.dangerbtn');
  await page.click('details.kx[open] button.danger');
  await page.waitForSelector('.chip.on:has-text("restarted")');
  const rp = W.posts.find(p => p.path === '/a/restartall');
  check('5 confirm -> POST /a/restartall, the shell follows the 303 and shows the "restarted 2" chip, same document', !!rp && (await same()) && (await txt(page, '.chip.on')).includes('restarted 2'), rp);

  const u = await page.evaluate(() => ({ age: document.querySelector('.sysextra .bar .chip').textContent.replace(/\s+/g, ' ').trim(), cards: [...document.querySelectorAll('.statgrid.u > .stat > .sl:first-child')].map(n => n.textContent),
    q: [...document.querySelectorAll('.statgrid.u .stat:first-child .qrow')].map(r => r.textContent.replace(/\s+/g, ' ').trim()), spend: document.querySelector('.statgrid.u .stat:nth-child(2) .qrow').textContent.replace(/\s+/g, ' ').trim() }));
  check('6 usage: "usage updated 2m ago", a limits card and a spend card per account, 5h and week limits, today / week / month spend', u.age === 'usage updated 2m ago' && u.cards.join() === 'demo · limits,demo · spend' && u.q.map(x => x.replace(/\s/g, '')).join() === '5h12%,week61%' && u.spend.replace(/\s/g, '') === 'today$1.50·week$9.25·month$40.00', u);
  await page.click('details.ubd summary');
  const bd = await page.evaluate(() => ({ days: [...document.querySelectorAll('details.ubd .qrow')].map(r => r.innerText.replace(/\s+/g, ' ').trim()), href: document.querySelector('details.ubd a.sid8').getAttribute('href') }));
  check('7 the 7-day breakdown lists days and sessions, each session a shell link', bd.days[0] === '10-11 $1.50 sonnet-4' && bd.days[2] === '00000001 $0.50 sonnet-4' && bd.days.length === 3 && bd.href === `/next/s/demo/${SID(1)}`, bd);

  // live topics patch in place
  await page.evaluate(() => { document.querySelectorAll('.mbar').forEach(n => { n.__keep = 1; }); });
  await page.evaluate(() => window.__emit('system', { load: 5, cores: 4, memUsed: 6e9, memTot: 8e9, swapUsed: 4e9, swapTot: 8e9, dskUsed: 3e10, dskTot: 1e11, up: 200000, version: '2.1.0' }));
  await page.waitForFunction(() => document.querySelector('.mbar-pct').textContent === '100%');
  const b1 = await bars();
  check('8 a `system` event patches the meters in place: load 5 / 4 cores is 100 % and warns, memory 75 %, swap 50 %, disk 30 % leaves the warn state', b1.map(b => b.pct).join() === '100%,75%,50%,30%' && b1.map(b => b.warn).join() === 'true,false,false,false' && (await page.evaluate(() => [...document.querySelectorAll('.mbar')].every(n => n.__keep))), b1);
  check('9 ...and UPTIME follows (2d 7h)', (await txt(page, '.envrow:nth-of-type(2) .envval')).join() === '2d 7h' || (await page.evaluate(() => [...document.querySelectorAll('.envrow')].find(r => r.textContent.startsWith('UPTIME')).textContent)).includes('2d 7h'));
  await page.evaluate(() => window.__emit('usage', { quota: { demo: { h5: 80, wk: 61 } }, thr: 70, accts: { demo: { id: 'demo', label: 'demo', today: 3.25, week: 11, month: 42, block: null, tokExp: null } } }));
  await page.waitForFunction(() => document.querySelector('.statgrid.u .stat:nth-child(2) .qrow b').textContent === '$3.25');
  const u2 = await page.evaluate(() => ({ q: document.querySelector('.statgrid.u .stat:first-child .qrow').innerText.replace(/\s+/g, ' ').trim(), meter: document.querySelector('.statgrid.u .stat:first-child .meter i').getAttribute('style'), spend: document.querySelector('.statgrid.u .stat:nth-child(2) .qrow').innerText.replace(/\s+/g, ' ').trim() }));
  check('10 a `usage` event patches limits and spend: 5h 80 % (past the 70 threshold, red), today $3.25', u2.q.replace(/\s/g, '') === '5h80%' && /background:\s*var\(--bad\)/.test(u2.meter) && u2.spend.replace(/\s/g, '') === 'today$3.25·week$11.00·month$42.00', u2);

  // refresh: POST, then re-poll every 4 s while collecting
  await page.click('.sysextra .bar a.chip:has-text("Refresh")');
  await page.waitForSelector('.sysextra .bar .chip:has-text("refreshing")');
  const rf = W.posts.find(p => p.path === '/api/usage/refresh');
  check('11 Refresh POSTs /api/usage/refresh and the chip says "refreshing…"; no document load', !!rf && (await same()), rf);
  await page.waitForFunction(() => !/refreshing/.test(document.querySelector('.sysextra .bar .chip').textContent), null, { timeout: 12000 });
  check('12 ...the page polls /api/system every 4 s until the collection lands, then shows the new numbers', W.gets.filter(g => g === '/api/system').length >= 2 && (await txt(page, '.statgrid.u .stat:nth-child(2) .qrow b'))[0] === '$7.77', W.gets);

  // reclaim
  await page.click('.sysextra .bar a.chip:has-text("Reclaim")');
  await page.waitForSelector('form.rf');
  const rc = await page.evaluate(() => ({ search: location.search, rows: [...document.querySelectorAll('form.rf .rrow:not(.tot)')].map(r => [r.querySelector('.rl').textContent, r.querySelector('b').textContent, r.querySelector('input').checked, r.querySelector('.muted').textContent]), tot: document.querySelector('form.rf .rrow.tot b').textContent, chip: document.querySelector('.sysextra .bar a.chip:last-of-type').textContent.trim() }));
  check('13 Reclaim opens the measured preview (?reclaim=1): empty targets omitted, "qa" targets unchecked, "checked by default" sums the safe ones', rc.search === '?reclaim=1' && rc.rows.length === 3 && rc.rows[0].join('|') === 'systemd journal|3.0 G|true|vacuum down to 200M' && rc.rows[1][3] === '40 entries · tool litter, 7 days cold' && rc.rows[2][2] === false && rc.tot === '3.0 G' && rc.chip === 'Close', rc);
  await page.uncheck('form.rf input[value=tmp]');
  await page.click('form.rf button.danger');
  await page.waitForSelector('.chip.ok');
  const rp2 = W.posts.find(p => p.path === '/sys/reclaim');
  check('14 Reclaim Selected posts the checked ids only, closes the preview and shows "reclaimed 1.0 G · 1 target"', !!rp2 && rp2.body.t === 'journal' && (await search(page)) === '' && (await txt(page, '.chip.ok'))[0] === 'reclaimed 1.0 G · 1 target' && (await count(page, 'form.rf')) === 0 && (await same()), { rp2, s: await search(page) });
  await ctx.close();
  // no live session: the control is disabled
  const e = await open('/system');
  check('15 with no live session the restart control is disabled and says so', (await e.page.evaluate(() => { const d = document.querySelector('.dangerbtn'); return d.classList.contains('off') && d.getAttribute('aria-disabled') === 'true' && /nothing to restart/.test(document.querySelector('.dangercap').textContent); })));
  await e.ctx.close();
}

// ---- device ----------------------------------------------------------------------------------------------------------------------------
async function device() {
  const { ctx, page, W, same } = await open('/device');
  const info = () => page.evaluate(() => ({ on: document.querySelector('.segbtn.on').textContent.trim(), rows: [...document.querySelectorAll('.devrow')].map(r => [...r.children].map(c => c.textContent).join(' ')), btn: document.querySelector('.ctlform button').textContent.trim(),
    stage: document.querySelector('.devstage').textContent.replace(/\s+/g, ' ').trim(), frame: !!document.querySelector('iframe.vnc'), wl: document.body.classList.contains('watchlive') }));
  const i0 = await info();
  check('1 Mobile, stopped: STATE STOPPED, TARGET, "Start Emulator", "Awaiting stream…", no frame, the FAB stays', i0.on === 'Mobile' && i0.rows.join() === 'STATE STOPPED,TARGET 127.0.0.1:6555' && i0.btn === 'Start Emulator' && /^Awaiting stream…/.test(i0.stage) && !i0.frame && !i0.wl, i0);
  await page.click('.ctlform button');
  await page.waitForFunction(() => /BOOTING/.test(document.querySelector('.devrows').textContent));
  const sp = W.posts.find(p => p.path === '/droid/start');
  const i1 = await info();
  check('2 Start Emulator posts /droid/start; the card follows to BOOTING and the stage says it boots itself', !!sp && /android is booting/.test(i1.stage) && (await same()), i1);
  await page.waitForFunction(() => document.querySelector('iframe.vnc') && document.body.classList.contains('watchlive'), null, { timeout: 12000 });
  const i2 = await info();
  const src = await page.evaluate(() => document.querySelector('iframe.vnc').getAttribute('src'));
  check('3 while booting the page asks again every 4 s; when live: RUNNING + RESOLUTION, a LIVE badge, "Stop Emulator" and the scrcpy stream in the frame, the FAB hides', i2.rows.join() === 'STATE RUNNING,RESOLUTION 1080×1920,TARGET 127.0.0.1:6555' && i2.btn === 'Stop Emulator' && i2.frame && i2.wl && (await count(page, '.lvb2')) === 1 && /^\/droidview\/#!action=stream&udid=127\.0\.0\.1%3A6555&player=tinyh264&fitToScreen=true&ws=/.test(src), { i2, src });
  await page.click('.fsbtn');
  const fs1 = await page.evaluate(() => document.body.classList.contains('devfs'));
  await page.click('.fsbtn');
  check('4 the full-screen button toggles body.devfs', fs1 && !(await page.evaluate(() => document.body.classList.contains('devfs'))));

  // the stream is released while the tab is hidden and re-opened on return
  const vis = async v => { await page.evaluate(v => { Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => v }); document.dispatchEvent(new Event('visibilitychange')); }, v); await page.waitForTimeout(80); };
  await vis('hidden');
  const hid = await count(page, 'iframe.vnc');
  await vis('visible');
  check('5 visibilitychange: hidden unmounts the iframe, visible mounts it again', hid === 0 && (await count(page, 'iframe.vnc')) === 1);

  // Web
  await page.click('.segbtn:has-text("Web")');
  await page.waitForFunction(() => document.querySelector('.segbtn.on').textContent.trim() === 'Web');
  const w0 = await info();
  check('6 the Web segment switches without a document load: IDLE, PORT 6080, "Start Browser", the emulator frame is gone', (await same()) && w0.rows.join() === 'STATE IDLE,PORT 6080' && w0.btn === 'Start Browser' && !w0.frame && (await search(page)) === '?dv=web', w0);
  await page.click('.ctlform button');
  await page.waitForSelector('iframe#vf');
  await page.waitForFunction(() => document.querySelectorAll('.icons4 .ctlbtn').length === 8);
  const vf = await page.evaluate(() => ({ src: document.querySelector('iframe#vf').getAttribute('src'), allow: document.querySelector('iframe#vf').getAttribute('allow'), keys: [...document.querySelectorAll('.icons4 .ctlbtn')].map(b => b.title), btn: document.querySelector('.ctlform button').textContent.trim(), wl: document.body.classList.contains('watchlive') }));
  check('7 Start Browser posts /watch/start; live: noVNC in #vf with clipboard rights, 8 remote keys, "Stop Browser"', W.posts.some(p => p.path === '/watch/start') && /^\/vnc\/vnc\.html\?autoconnect=1&resize=scale&reconnect=1&quality=9&compression=6&path=vnc\/websockify$/.test(vf.src) && vf.allow === 'clipboard-read;clipboard-write'
    && vf.keys.join() === 'show keyboard,paste clipboard,scroll up,scroll down,back,forward,reload,escape' && vf.btn === 'Stop Browser' && vf.wl, vf);
  await page.waitForFunction(() => document.querySelectorAll('.icons4 .ctlbtn').length === 8); // the keys card is its own lazily loaded chunk
  await page.waitForFunction(() => document.querySelector('iframe#vf').contentWindow.rfb);
  await page.click('.icons4 .ctlbtn[title="scroll up"]');
  await page.click('.icons4 .ctlbtn[title="reload"]');
  await page.click('.icons4 .ctlbtn[title="back"]');
  await page.click('.icons4 .ctlbtn[title="show keyboard"]');
  const keys = await page.evaluate(() => ({ k: (window.__keys || []).map(a => a.join(':')), kb: window.__kb }));
  check('8 remote keys drive window.rfb in the frame: PageUp, F5, Alt+Left, and the keyboard button is clicked', keys.k.includes(`${0xff55}:PageUp`) && keys.k.includes(`${0xffc2}:F5`) && keys.k.includes(`${0xffe9}:AltLeft:true`) && keys.k.includes(`${0xff51}:ArrowLeft:true`) && keys.kb === 1, keys);

  // leaving the route unmounts the stream and gives the FAB back
  await page.click('nav.tabs a:has-text("History"), .pnav a:has-text("History")');
  await page.waitForSelector('#app [data-view=history]', { state: 'attached' });
  check('9 leaving the route removes the frame, body.watchlive and body.devfs', (await count(page, 'iframe')) === 0 && !(await page.evaluate(() => document.body.classList.contains('watchlive') || document.body.classList.contains('devfs'))) && (await same()));
  await ctx.close();

  // a phone gets the stream as a full page, not a frame (iOS ignores an iframe's viewport)
  const ph = await open('/device', { }, { userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 Mobile/15E148', viewport: { width: 390, height: 844 }, hasTouch: true });
  ph.W.device.droid = { state: 'live', res: '1080×1920', udid: '127.0.0.1:6555' };
  await ph.page.reload({ waitUntil: 'load' });
  await ph.page.waitForSelector('.stagecta');
  const cta = await ph.page.evaluate(() => ({ t: document.querySelector('.stagecta').textContent.trim(), href: document.querySelector('.stagecta').getAttribute('href'), frames: document.querySelectorAll('iframe').length, fs: !!document.querySelector('.fsbtn') }));
  check('10 phone UA: "Open Screen (full page)" links to /droidview/ and there is no frame and no full-screen button', cta.t === 'Open Screen (full page)' && cta.href.startsWith('/droidview/#!action=stream') && cta.frames === 0 && !cta.fs, cta);
  await ph.ctx.close();
}

// ---- session ---------------------------------------------------------------------------------------------------------------------------
async function session() {
  const path = `/s/demo/${SID(1)}`;
  const { ctx, page, W, same } = await open(path);
  const s0 = await page.evaluate(() => ({ h1: document.querySelector('#app h1').textContent, meta: [...document.querySelectorAll('.meta > div')].map(n => n.textContent.replace(/\s+/g, ' ').trim()), la: document.querySelector('.la')?.textContent.replace(/\s+/g, ' ').trim() ?? null,
    note: document.querySelector('.note')?.textContent, cls: [...document.querySelectorAll('#app > .m, #app > details')].map(n => n.tagName === 'DIV' ? n.className : 'details'), pgs: document.querySelectorAll('nav.pg').length, tot: document.querySelector('.pgtot').textContent,
    cur: document.querySelector('.pgnum').textContent.replace(/\s+/g, ' ') }));
  check('1 meta grid: session, account, project, started, last, size; h1 "← sessions"', s0.h1 === '← sessions' && s0.meta.join('|') === `session|${SID(1)}|account|demo|project|/demo/api|started|2026-10-11 09:00Z|last|${new Date(W.sess.mt).toISOString().slice(0, 16).replace('T', ' ')}Z (2h ago)|size|120K · 32 items · 6 tool calls · claude-sonnet-4`, s0.meta);
  check('2 not live: "open in terminal" and no forms; the 8MB window note; two pagers "newest first"', s0.la === '>_ open in terminal' && s0.note === 'large transcript — showing the most recent 8MB window.' && s0.pgs === 2 && s0.tot === '32 items · newest first' && /1\s*\/ 2/.test(s0.cur), s0);
  const m = await page.evaluate(() => ({ n: document.querySelectorAll('#app > .m').length, tools: document.querySelectorAll('#app > details').length, last: document.querySelector('#app > .m:last-of-type .mh').textContent, long: (() => { const d = [...document.querySelectorAll('#app > .m details summary')].map(n => n.textContent.length); return d; })(),
    first: document.querySelector('#app > .m .mh').textContent, user: document.querySelector('#app > .m.user .mh b')?.textContent, claude: document.querySelector('#app > .m.claude .mh b')?.textContent, summ: [...document.querySelectorAll('#app > details summary')].map(n => n.textContent.trim()).slice(0, 3) }));
  check('3 the newest page: items chronological inside it; user = "you", claude = "claude"; tools, results and the compaction summary are disclosures', m.user === 'you' && m.claude === 'claude' && m.summ.includes('↳ result') && m.summ.some(x => /Bash/.test(x)) && m.n + m.tools === 25, m);
  check('4 a message over 2500 characters folds into a disclosure of its first 200 characters + "…"', m.long.length === 1 && m.long[0] === 201, m.long);
  await page.click('nav.pg a[aria-label="next page"]');
  await page.waitForFunction(() => new URLSearchParams(location.search).get('page') === '2' && document.querySelector('.pgnum .cur').textContent === '2');
  const p2 = await page.evaluate(() => ({ cur: document.querySelector('.pgnum .cur').textContent, items: document.querySelectorAll('#app > .m, #app > details').length, first: document.querySelector('#app > .m .mh').textContent }));
  check('5 the older page loads without a document load: 2 / 2, the remaining 7 items', (await same()) && p2.cur === '2' && p2.items === 7, p2);
  await page.goto(DASH + '/next' + path, { waitUntil: 'load' });
  await page.waitForSelector('#app [data-view=session]', { state: 'attached' });
  await page.evaluate(() => { window.__doc = 'same-document'; });

  // live: forms
  await page.evaluate(f => window.__emit('fleet', f), fleetOf({ sid8: SID(1).slice(0, 8) }));
  await page.waitForSelector('.la .kx');
  const lv = await page.evaluate(() => ({ la: document.querySelector('.la a.btn').textContent.trim(), href: document.querySelector('.la a.btn').getAttribute('href'), forms: [...document.querySelectorAll('.la form')].map(f => f.getAttribute('action')), pill: !!document.querySelector('.meta .lvb') }));
  check('6 a fleet event makes the session live: LIVE pill, "attach — live now", pause / rename / kill', lv.la === '>_ attach — live now' && /arg=attach&arg=cc-00000001/.test(lv.href) && lv.forms.join() === '/a/pause,/a/label,/a/kill' && lv.pill, lv);
  await page.evaluate(() => window.__emit('fleet', []));
  await page.waitForFunction(() => !document.querySelector('.la .kx'));
  check('7 ...and an empty fleet takes the controls away', (await txt(page, '.la'))[0] === '>_ open in terminal');
  await ctx.close();

  // a live session at load: pause posts, the view reloads and flips
  const L = await open(path, { fleet: fleetOf({ sid8: SID(1).slice(0, 8) }) });
  L.W.sess.live = { name: 'cc-00000001', paused: false, label: '' };
  await L.page.reload({ waitUntil: 'load' });
  await L.page.waitForSelector('.la form');
  await L.page.click('.la form[action="/a/pause"] button');
  await L.page.waitForFunction(() => document.querySelector('.la a.btn').textContent.includes('paused') || document.querySelector('.la form[action="/a/resume"]'));
  const pp = L.W.posts.find(p => p.path === '/a/pause');
  check('8 Pause posts /a/pause {name}; the page reloads and offers Resume', !!pp && pp.body.name === 'cc-00000001' && (await L.page.evaluate(() => !!document.querySelector('.la form[action="/a/resume"]'))), pp);
  await L.page.click('.la details.kx:has(.klbl) summary');
  await L.page.fill('.la input[name=label]', 'renamed');
  await L.page.click('.la details.kx[open] button.ok');
  await L.page.waitForTimeout(150);
  check('9 Rename posts /a/label {name, label}', L.W.posts.some(p => p.path === '/a/label' && p.body.label === 'renamed' && p.body.name === 'cc-00000001'));
  await L.page.click('.la details.kx:has(button.danger) summary');
  check('10 Kill asks first ("stop cc-00000001?")', /stop cc-00000001\?/.test((await txt(L.page, '.la details.kx[open] .kc'))[0] || ''));
  await L.page.click('.la details.kx[open] button.danger');
  await L.page.waitForFunction(() => !document.querySelector('.la .kx'));
  check('11 Kill It posts /a/kill and the controls go', L.W.posts.some(p => p.path === '/a/kill'));
  await L.ctx.close();

  // an account without a terminal, and one idle beyond the resume window
  const N = await open(path); N.W.sess.term = false; await N.page.reload({ waitUntil: 'load' }); await N.page.waitForSelector('#app [data-view=session]', { state: 'attached' });
  check('12 an account without a terminal shows no attach row at all', (await count(N.page, '.la')) === 0 && !(await txt(N.page, '#app > p.muted')).some(t => /resume disabled/.test(t)));
  N.W.sess.term = true; N.W.sess.mt = T - 10 * DAY; await N.page.reload({ waitUntil: 'load' }); await N.page.waitForSelector('#app [data-view=session]', { state: 'attached' });
  check('13 idle past the 7-day window: "resume disabled — idle 10d (cutoff 7d)…" and no button', /resume disabled — idle 10d \(cutoff 7d\)/.test((await txt(N.page, '#app > p.muted'))[0] || '') && (await count(N.page, '.la')) === 0);
  await N.ctx.close();
}

const table = { history, system, device, session };
for (const m of mode === 'all' ? MODES : [mode]) {
  cur = m;
  try { await table[m](); } catch (e) { bad++; console.log(`FAIL ${m} threw ${String(e.stack || e).split('\n').slice(0, 3).join(' | ')}`); }
}
cur = 'all';
check('zero console errors', errors.length === 0, errors);
await browser.close();
console.log(bad ? `views-check ${engine} ${mode}: ${bad} FAILED` : `views-check ${engine} ${mode}: all passed`);
process.exit(bad ? 1 : 0);
