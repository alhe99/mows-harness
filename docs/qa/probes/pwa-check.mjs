// Cockpit phase 05 PWA probe (specs/cockpit/05-pwa-cutover.md tasks 2, 4, 9). Exit code is the verdict.
// usage: node docs/qa/probes/pwa-check.mjs <chromium|webkit> <badge|push|sw|all>      env: DASH (default http://127.0.0.1:3105), PLAYWRIGHT (module path)
//   badge  a fleet with one needs-you -> navigator.setAppBadge(1) (a stub records it), the count follows the fleet event, clearAppBadge on focus; the Wake
//          Lock is requested while a session is working and the tab is visible, released when none is or the tab hides, and taken again on return.
//   push   the System view's Notifications card: permission and state shown, "Turn on" posts the subscription made with the server's VAPID key
//          (PushManager.subscribe is a stub; /api/push/* are answered here), a `push` event dispatched into the real worker shows the declarative
//          notification, the card shows the delivery, a notificationclick opens its route, "Turn off" deletes the subscription.
//   sw     the real /sw.js installs and precaches; offline, an allowlisted route is answered by the worker from its cache and /term/ and /oauth2/* are not
//          intercepted at all.
// Only `badge` runs on webkit (Playwright's WebKit has no Push API and its worker events cannot be driven); push and sw need Chromium and SKIP elsewhere,
// loudly. Nothing here changes server state: the boot snapshot is rewritten in flight, EventSource is a fake `window.__emit` drives, and the push endpoints
// are the probe's. Selectors: [data-card=notifications] .envrow .envkey .envval button.ab .dangercap.
const pw = await import(process.env.PLAYWRIGHT || 'playwright').catch(() => { console.error('pwa-check: playwright is not installed (npm ci --ignore-scripts)'); process.exit(2); });
const engine = process.argv[2] || 'chromium';
const mode = process.argv[3] || 'all';
const MODES = ['badge', 'push', 'sw'];
if (mode !== 'all' && !MODES.includes(mode)) { console.error(`pwa-check: mode is one of ${MODES.join(' ')} all`); process.exit(2); }
const DASH = process.env.DASH || 'http://127.0.0.1:3105';
// Chromium runs in its new headless mode (channel 'chromium'): the headless shell reports every notification permission as denied and cannot show one
const browser = await pw[engine].launch(engine === 'chromium' ? { channel: 'chromium' } : {});
let bad = 0, cur = '';
const errors = [];
const check = (id, ok, detail) => { if (!ok) bad++; console.log(`${ok ? 'PASS' : 'FAIL'} ${mode === 'all' ? cur + ' ' : ''}${id}${detail === undefined ? '' : ' ' + JSON.stringify(detail)}`); };
const sleep = ms => new Promise(r => setTimeout(r, ms));
const until = async (fn, ms = 5000) => { const t = Date.now(); for (;;) { const v = await Promise.resolve(fn()).catch(() => false); if (v) return v; if (Date.now() - t > ms) return v; await sleep(50); } };
const item = (n, state) => ({ sid8: String(n).padStart(8, '0'), name: 'cc-' + n, label: '', proj: 'demo', state, rel: Date.now(), snippet: '' });
const watch = p => { p.on('console', m => { if (m.type() === 'error' && !/interactive-widget|ERR_INTERNET_DISCONNECTED|Failed to load resource/.test(m.text())) errors.push(m.text()); }); p.on('pageerror', e => errors.push(String(e))); };

// stand-ins the page gets before any of its own script runs
const stubs = () => {
  const log = (window.__badge = []), wl = (window.__wl = []);
  const def = (k, v) => Object.defineProperty(navigator, k, { value: v, configurable: true });
  def('setAppBadge', n => { log.push('set:' + n); return Promise.resolve(); });
  def('clearAppBadge', () => { log.push('clear'); return Promise.resolve(); });
  def('wakeLock', { request: async () => { wl.push('request'); const l = new EventTarget(); l.release = async () => { wl.push('release'); l.dispatchEvent(new Event('release')); }; return l; } });
  const all = (window.__es = []);
  window.EventSource = class {
    constructor(url) { this.url = url; this.readyState = 1; this.l = {}; all.push(this); setTimeout(() => (this.l.open || []).forEach(f => f({})), 0); }
    addEventListener(n, f) { (this.l[n] ||= []).push(f); }
    close() { this.readyState = 2; }
  };
  window.__emit = (name, data) => all.forEach(e => (e.l[name] || []).forEach(f => f({ data: JSON.stringify(data), lastEventId: '' })));
};
// the shell document with its fleet replaced by the fixture's
const fixtureFleet = (ctx, fleet) => ctx.route(u => u.pathname === '/', async route => {
  const r = await route.fetch();
  const html = (await r.text()).replace(/(<script type="application\/json" id="boot"[^>]*>)([\s\S]*?)(<\/script>)/, (_, a, j, c) => {
    const b = JSON.parse(j); b.fleet = fleet; b.live = fleet.length; return a + JSON.stringify(b).replace(/</g, '\\u003c') + c;
  });
  const headers = { ...r.headers() }; delete headers['content-encoding']; delete headers['content-length'];
  await route.fulfill({ status: r.status(), headers, body: html });
});

// ---- badge -----------------------------------------------------------------------------------------------------------------------------
async function badge() {
  const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, serviceWorkers: 'block' });
  await ctx.addInitScript(stubs);
  await fixtureFleet(ctx, [item(1, 'needs-you'), item(2, 'idle')]);
  const page = await ctx.newPage(); watch(page);
  await page.goto(DASH + '/', { waitUntil: 'load' });
  await page.waitForSelector('#app [data-view]', { state: 'attached' });
  const calls = () => page.evaluate(() => window.__badge.slice());
  const wl = () => page.evaluate(() => window.__wl.slice());
  const last = async () => (await calls()).at(-1);
  check('1 a boot fleet with one needs-you sets the badge to 1', await until(async () => (await last()) === 'set:1'), await calls());
  await page.evaluate(() => window.__emit('fleet', [{ sid8: '00000001', name: 'cc-1', label: '', proj: 'p', state: 'needs-you', rel: 1, snippet: '' }, { sid8: '00000002', name: 'cc-2', label: '', proj: 'p', state: 'needs-you', rel: 1, snippet: '' }, { sid8: '00000003', name: 'cc-3', label: '', proj: 'p', state: 'working', rel: 1, snippet: '' }]));
  check('2 a fleet event with two needs-you and one working sets it to 2', await until(async () => (await last()) === 'set:2'), await calls());
  check('3 the Wake Lock is requested while a session is working and the tab is visible', await until(async () => (await wl()).join() === 'request'), await wl());
  await page.evaluate(() => window.dispatchEvent(new Event('focus')));
  check('4 focus clears the badge', await until(async () => (await last()) === 'clear'), await calls());
  await page.evaluate(() => window.__emit('fleet', [{ sid8: '00000001', name: 'cc-1', label: '', proj: 'p', state: 'idle', rel: 1, snippet: '' }]));
  check('5 no session needing you clears it (never setAppBadge(0))', await until(async () => (await last()) === 'clear') && !(await calls()).includes('set:0'), await calls());
  check('6 ...and released when no session is working', await until(async () => (await wl()).join() === 'request,release'), await wl());
  await page.evaluate(() => window.__emit('fleet', [{ sid8: '00000001', name: 'cc-1', label: '', proj: 'p', state: 'working', rel: 1, snippet: '' }]));
  check('7 ...taken again when one starts', await until(async () => (await wl()).join() === 'request,release,request'), await wl());
  await page.evaluate(() => { Object.defineProperty(document, 'visibilityState', { value: 'hidden', configurable: true }); document.dispatchEvent(new Event('visibilitychange')); });
  check('8 ...released when the tab is hidden', await until(async () => (await wl()).join() === 'request,release,request,release'), await wl());
  await page.evaluate(() => { Object.defineProperty(document, 'visibilityState', { value: 'visible', configurable: true }); document.dispatchEvent(new Event('visibilitychange')); });
  check('9 ...and again on return, once', await until(async () => (await wl()).join() === 'request,release,request,release,request'), await wl());
  await ctx.close();
}

// ---- push ------------------------------------------------------------------------------------------------------------------------------
const KEY = Buffer.concat([Buffer.from([4]), Buffer.alloc(64, 7)]).toString('base64url');
async function push() {
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 800 }, permissions: ['notifications'] });
  await ctx.addInitScript(() => {
    // the browser's push service is not reachable from a probe: a subscription is made up, the rest of the page is real
    // state lives in sessionStorage so it survives a reload, as the browser's own would
    const ss = (k, v) => (v === undefined ? sessionStorage.getItem(k) : v === null ? sessionStorage.removeItem(k) : sessionStorage.setItem(k, v));
    const sub = { endpoint: 'https://push.example.test/fake-endpoint', expirationTime: null, toJSON() { return { endpoint: this.endpoint, expirationTime: null, keys: { p256dh: 'BAcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwc', auth: 'AAAAAAAAAAAAAAAAAAAAAA' } }; },
      unsubscribe: async () => { ss('sub', null); return true; } };
    // the page sees a fresh profile (permission 'default') and the prompt is answered yes; the context's grant is what lets the worker show the notification
    Object.defineProperty(Notification, 'permission', { get: () => ss('perm') || 'default', configurable: true });
    Notification.requestPermission = async () => { ss('perm', 'granted'); return 'granted'; };
    window.__subscribeOpts = [];
    PushManager.prototype.subscribe = async function (o) { window.__subscribeOpts.push({ userVisibleOnly: o.userVisibleOnly, key: btoa(String.fromCharCode(...new Uint8Array(o.applicationServerKey))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '') }); ss('sub', '1'); return sub; };
    PushManager.prototype.getSubscription = async () => (ss('sub') ? sub : null);
  });
  const posts = [];
  await ctx.route('**/api/push/key', r => r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ key: KEY }) }));
  await ctx.route('**/api/push/subscribe', r => { const q = r.request(); posts.push({ method: q.method(), type: q.headers()['content-type'], body: JSON.parse(q.postData() || '{}') }); return r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ ok: true, id: '0123456789abcdef' }) }); });
  const page = await ctx.newPage(); watch(page);
  await page.goto(DASH + '/system', { waitUntil: 'load' });
  const card = '[data-card=notifications]';
  await page.waitForSelector(card, { timeout: 15000 }).catch(() => {});
  const rows = () => page.evaluate(c => Object.fromEntries([...document.querySelectorAll(c + ' .envrow')].map(r => [r.querySelector('.envkey').textContent, r.querySelector('.envval').textContent])), card);
  const btn = () => page.evaluate(c => document.querySelector(c + ' button.ab')?.textContent ?? null, card);
  const r0 = await rows().catch(() => ({}));
  check('1 the card appears on /system once the worker is ready: permission default, status off, no delivery yet', r0.PERMISSION === 'default' && r0.STATUS === 'off' && r0.LAST_DELIVERY === 'none yet' && (await btn()) === 'Turn on notifications', r0);
  await page.click(card + ' button.ab');
  check('2 Turn on posts the subscription (endpoint and both keys) as JSON', await until(() => posts.length === 1) && posts[0].method === 'POST' && /^application\/json/.test(posts[0].type)
    && posts[0].body.endpoint === 'https://push.example.test/fake-endpoint' && !!posts[0].body.keys.p256dh && !!posts[0].body.keys.auth, posts);
  const opts = await page.evaluate(() => window.__subscribeOpts);
  check('3 ...which was made with the VAPID key /api/push/key returned, userVisibleOnly', opts.length === 1 && opts[0].key === KEY && opts[0].userVisibleOnly === true, opts);
  check('4 the card now says granted and subscribed, and offers Turn off', await until(async () => (await rows()).STATUS === 'subscribed') && (await rows()).PERMISSION === 'granted' && (await btn()) === 'Turn off notifications', await rows());

  const sw = await until(() => ctx.serviceWorkers().find(w => /\/sw\.js$/.test(w.url())), 10000);
  check('5 the real /sw.js is the worker', !!sw);
  const decl = { web_push: 8030, notification: { title: 'cc-demo needs you', body: 'Do you want to proceed?', navigate: '/history', tag: 'aaaa1111' }, app_badge: 1 };
  await sw.evaluate(d => { dispatchEvent(new PushEvent('push', { data: JSON.stringify(d) })); }, decl);
  const shown = await until(() => page.evaluate(async () => (await (await navigator.serviceWorker.ready).getNotifications()).map(n => ({ title: n.title, body: n.body, tag: n.tag, navigate: n.data?.navigate }))).then(a => a.length && a));
  check('6 a push event in the worker shows the notification: title, body, tag, the route to open', shown && shown.length === 1 && shown[0].title === 'cc-demo needs you' && shown[0].body === 'Do you want to proceed?' && shown[0].tag === 'aaaa1111' && shown[0].navigate === '/history', shown);
  await page.reload({ waitUntil: 'load' });
  await page.waitForSelector(card, { timeout: 15000 });
  const r1 = await rows();
  check('7 the card shows the delivery', /^(now|\d+[mhd] ago)$/.test(r1.LAST_DELIVERY), r1);
  await sw.evaluate(async () => { const [n] = await registration.getNotifications(); dispatchEvent(new NotificationEvent('notificationclick', { notification: n })); });
  check('8 a notificationclick brings the open window to the notification\'s route', await until(() => page.evaluate(() => location.pathname === '/history')), await page.evaluate(() => location.pathname));
  check('9 ...and closes the notification', await page.evaluate(async () => (await (await navigator.serviceWorker.ready).getNotifications()).length) === 0);

  await page.goto(DASH + '/system', { waitUntil: 'load' });
  await page.waitForSelector(card, { timeout: 15000 });
  check('10 the subscription is still there after a reload', (await rows()).STATUS === 'subscribed' && (await btn()) === 'Turn off notifications', await rows());
  await page.click(card + ' button.ab');
  check('11 Turn off deletes it by the id the server gave', await until(() => posts.length === 2) && posts[1].method === 'DELETE' && posts[1].body.id === '0123456789abcdef', posts[1]);
  check('12 ...and the card says off again', await until(async () => (await rows()).STATUS === 'off'), await rows());
  check('13 /api/push/key and /api/push/subscribe were the only push traffic', posts.length === 2);
  await ctx.close();
}

// ---- sw --------------------------------------------------------------------------------------------------------------------------------
async function sw() {
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 800 } });
  const page = await ctx.newPage(); watch(page);
  await page.goto(DASH + '/', { waitUntil: 'load' });
  await page.evaluate(() => navigator.serviceWorker.ready);
  const keys = await until(() => page.evaluate(async () => (await (await caches.open('mows-assets')).keys()).length).then(n => n > 5 && n), 10000);
  check('1 the worker installs and precaches dist/ (more than five assets cached by name)', !!keys, keys);
  check('2 the shell document at / is precached', await page.evaluate(async () => !!(await (await caches.open('mows-pages')).match('/'))));
  check('3 the page is controlled by it', await until(() => page.evaluate(() => !!navigator.serviceWorker.controller)));
  await page.goto(DASH + '/history', { waitUntil: 'load' });
  check('4 an allowlisted navigation online is answered by the network and cached', await until(() => page.evaluate(async () => !!(await (await caches.open('mows-pages')).match('/history')))));
  await ctx.setOffline(true);
  const resp = await page.goto(DASH + '/history', { waitUntil: 'load' }).catch(e => e);
  const body = resp.ok ? await page.content() : String(resp);
  check('5 offline, /history is served by the worker from its cache (the shell, not the dino)', resp.ok?.() && resp.fromServiceWorker() && /id="app"/.test(body), String(resp).slice(0, 120));
  const never = await page.goto(DASH + '/agents/never-visited', { waitUntil: 'load' }).catch(e => e);
  check('6 offline, an allowlisted route never visited gets the cached shell document', never.ok?.() && /id="app"/.test(await page.content()));
  const term = await page.goto(DASH + '/term/', { waitUntil: 'load' }).catch(e => e);
  check('7 offline, /term/ is not intercepted: the browser errors, no offline page', typeof term === 'object' && !term.ok && /ERR_INTERNET_DISCONNECTED/.test(String(term)), String(term).slice(0, 120));
  const oa = await page.goto(DASH + '/oauth2/sign_in', { waitUntil: 'load' }).catch(e => e);
  check('8 offline, /oauth2/* is not intercepted either', typeof oa === 'object' && !oa.ok && /ERR_INTERNET_DISCONNECTED/.test(String(oa)), String(oa).slice(0, 120));
  await ctx.setOffline(false);
  const online = await page.goto(DASH + '/term/', { waitUntil: 'commit' }).catch(e => e);
  check('9 back online, /term/ goes to the network and not through the worker', online.ok && !online.fromServiceWorker());
  await ctx.close();
}

const run = { badge, push, sw };
for (const m of mode === 'all' ? MODES : [mode]) {
  cur = m;
  if (m !== 'badge' && engine !== 'chromium') { console.log(`SKIP ${m}: needs Chromium (Playwright's ${engine} has no Push API and no drivable worker events)`); continue; }
  await run[m]();
}
check('zero console errors', errors.length === 0, errors);
await browser.close();
console.log(bad ? `pwa-check ${engine}/${mode}: ${bad} FAILED` : `pwa-check ${engine}/${mode}: all passed`);
process.exit(bad ? 1 : 0);
