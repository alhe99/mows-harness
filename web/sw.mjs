// sw.mjs — the service worker, served as /sw.js (ARCHITECTURE section 8; K-20, K-37; ledger B-10). The installed app is scoped to `/`, so this
// worker sees every navigation on the origin, /term/, /oauth2/* and the device streams included. It therefore answers from cache ONLY an explicit
// allowlist of shell routes, caches nothing that is not a plain 200, and touches everything else not at all: no respondWith, the browser does it.
//   precache   dist/ by name (esbuild names carry the content hash) checked against the manifest's sha256, and the shell document at `/`.
//   navigate   allowlisted routes: network first, the cached copy only when the network fails, the inline offline page when there is none.
//   never      a 3xx (opaque redirect, or a followed one: the login bounce), a non-GET, another origin, /term*, /oauth2/*, /vnc/*, /droidview/*,
//              /api/*, /stream, /events, /a/*, /md: not intercepted at all.
//   push       the declarative payload (RFC 8030 section 8.1.1 shape) shown as a notification, the badge set from it; a click focuses or opens its route.
// `self.PRECACHE` ({ files: { name: sha256 } }) is prepended by static.mjs's swView from dist/manifest.json, so /sw.js changes byte for byte exactly when
// the build does and the browser installs the new worker. Written as one classic script: nothing imports, nothing exports.
/** @type {any} */
const sw = self;
const ASSETS = 'mows-assets', PAGES = 'mows-pages', META = 'mows-meta', MAX_PAGES = 40;
const FILES = (sw.PRECACHE && sw.PRECACHE.files) || {};
const SHELL = /^\/(grid|history|system|device|agents(\/.*)?|s\/.+)?$/;
const OFF = '<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>offline</title><body style="background:#09090b;color:#9f9fa9;font:14px/1.5 ui-monospace,SFMono-Regular,Menlo,monospace;margin:0;display:flex;min-height:100vh;align-items:center;justify-content:center;text-align:center"><div><div style="color:#00d492;font-size:26px;padding-bottom:10px">&gt;_</div>offline — the console needs a connection.<br><br><a style="color:#00d492" href="/">retry</a></div>';

// a response worth keeping: a 200 from this origin that was not reached through a redirect
const keep = r => r.status === 200 && r.type === 'basic' && !r.redirected;
const hex = buf => [...new Uint8Array(buf)].map(b => b.toString(16).padStart(2, '0')).join('');

sw.addEventListener('install', e => e.waitUntil((async () => {
  const assets = await caches.open(ASSETS);
  await Promise.all(Object.entries(FILES).map(async ([name, sha]) => {
    const url = '/assets/' + name;
    if (await assets.match(url)) return;
    const r = await fetch(url, { cache: 'reload' }).catch(() => null); // a miss here is only a later network fetch
    if (r && keep(r) && hex(await crypto.subtle.digest('SHA-256', await r.clone().arrayBuffer())) === sha) await assets.put(url, r);
  }));
  const home = await fetch('/', { cache: 'reload' }).catch(() => null);
  if (home && keep(home)) await (await caches.open(PAGES)).put('/', home);
  await sw.skipWaiting();
})()));

sw.addEventListener('activate', e => e.waitUntil((async () => {
  const assets = await caches.open(ASSETS), pages = await caches.open(PAGES);
  for (const r of await assets.keys()) if (!(r.url.slice(r.url.indexOf('/assets/') + 8) in FILES)) await assets.delete(r);
  for (const r of await pages.keys()) if (new URL(r.url).pathname !== '/') await pages.delete(r); // pages name assets the new build may have dropped
  for (const k of await caches.keys()) if (k !== ASSETS && k !== PAGES && k !== META) await caches.delete(k);
  await sw.clients.claim();
})()));

sw.addEventListener('fetch', e => {
  const r = e.request, u = new URL(r.url);
  if (r.method !== 'GET' || u.origin !== sw.location.origin) return;
  if (u.pathname.startsWith('/assets/')) return e.respondWith(caches.open(ASSETS).then(c => c.match(u.pathname)).then(m => m || fetch(r)));
  if (r.mode !== 'navigate' || !SHELL.test(u.pathname)) return;
  e.respondWith((async () => {
    const pages = await caches.open(PAGES);
    try {
      const net = await fetch(r);
      // only the bare route is kept: a query would grow the cache without bound and a stale ?page=2 must never stand in for ?page=1
      if (keep(net) && !u.search) {
        await pages.put(u.pathname, net.clone());
        const all = await pages.keys();
        for (const old of all.slice(0, Math.max(0, all.length - MAX_PAGES))) if (new URL(old.url).pathname !== '/') await pages.delete(old);
      }
      return net;
    } catch {
      return (await pages.match(u.pathname)) || (await pages.match('/')) || new Response(OFF, { headers: { 'content-type': 'text/html; charset=utf-8' } });
    }
  })());
});

sw.addEventListener('push', e => {
  let d = null;
  try { d = e.data.json(); } catch { /* no payload, or not JSON */ }
  const n = d && d.web_push === 8030 && d.notification;
  if (!n) return;
  e.waitUntil(Promise.all([
    sw.registration.showNotification(n.title, { body: n.body, tag: n.tag, silent: !!n.silent, data: { navigate: n.navigate } }),
    d.app_badge != null && sw.navigator.setAppBadge ? sw.navigator.setAppBadge(d.app_badge).catch(() => {}) : null,
    caches.open(META).then(c => c.put('/last-push', new Response(String(Date.now())))), // the System view's "last delivery"
  ]));
});

sw.addEventListener('notificationclick', e => {
  e.notification.close();
  const to = new URL((e.notification.data && e.notification.data.navigate) || '/', sw.location.origin);
  const dest = to.origin === sw.location.origin ? to.pathname + to.search : '/';
  e.waitUntil(sw.clients.matchAll({ type: 'window', includeUncontrolled: true }).then(ws => {
    const w = ws[0];
    return w ? w.navigate(dest).then(c => c && c.focus()).catch(() => sw.clients.openWindow(dest)) : sw.clients.openWindow(dest);
  }));
});
