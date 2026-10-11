#!/usr/bin/env node
// sw-check.mjs — web/sw.mjs (cockpit phase 05; K-20, ledger B-10) loaded in a fake ServiceWorkerGlobalScope. No browser, no server.
//   node scripts/sw-check.mjs
// Asserts: the navigation allowlist (the shell routes are answered, everything the installed app also scopes — /term*, /oauth2/*, /vnc/*, /droidview/*,
// /api/*, /stream, /events, /a/*, /md — is not intercepted at all); that a 3xx, an opaque redirect and a followed redirect are never cached; network
// first with the cached copy only on failure; that /term/ passes through even offline; the offline fallback body; precache by manifest hash;
// activation housekeeping; and the push and notificationclick handlers.
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const ORIGIN = 'https://dash.test';
let bad = 0;
const ok = (name, c, detail) => { if (!c) bad++; console.log(`${c ? 'PASS' : 'FAIL'} ${name}${c || detail === undefined ? '' : ' ' + JSON.stringify(detail)}`); };
const abs = k => new URL(k.url ?? k, ORIGIN).href;

// ---- the fake scope --------------------------------------------------------------------------------------------------------------------
function scope(files = {}) {
  const log = { skip: 0, claim: 0, shown: [], badge: [], opened: [], navigated: [], closed: 0, fetched: [] };
  const stores = new Map(), handlers = {};
  const cache = m => ({
    async match(k) { const e = m.get(abs(k)); return e && new Response(e.body, { status: e.status }); },
    async put(k, r) { m.set(abs(k), { body: await r.clone().text(), status: r.status }); },
    async keys() { return [...m.keys()].map(url => ({ url })); },
    async delete(k) { return m.delete(abs(k)); },
  });
  const net = { handler: async () => { throw new TypeError('offline'); } };
  const g = {
    PRECACHE: { files },
    location: { origin: ORIGIN }, crypto: globalThis.crypto, Response, URL, TypeError, Promise, Object, Date, JSON, Math, String, Number, Array,
    fetch: async (r, o) => { log.fetched.push(typeof r === 'string' ? r : r.url); return net.handler(r, o); },
    caches: { open: async n => cache(stores.get(n) || stores.set(n, new Map()).get(n)), keys: async () => [...stores.keys()], delete: async n => stores.delete(n) },
    skipWaiting: async () => { log.skip++; },
    clients: { claim: async () => { log.claim++; }, matchAll: async () => g.windows, openWindow: async u => { log.opened.push(u); } },
    windows: [],
    registration: { showNotification: async (title, o) => { log.shown.push({ title, ...o }); } },
    navigator: { setAppBadge: async n => { log.badge.push(n); } },
    addEventListener: (t, f) => { (handlers[t] ||= []).push(f); },
  };
  g.self = g;
  vm.runInNewContext(readFileSync('web/sw.mjs', 'utf8'), g, { filename: 'web/sw.mjs' });
  // dispatch an event; every waitUntil / respondWith promise is collected and awaited
  const fire = async (type, ev = {}) => {
    const waits = []; let responded = null, called = false;
    const e = { ...ev, waitUntil: p => waits.push(p), respondWith: p => { called = true; responded = p; } };
    for (const f of handlers[type] || []) f(e);
    await Promise.all(waits);
    return { called, res: responded && (await responded), waits: waits.length };
  };
  return { g, log, stores, net, fire };
}
const nav = (path, over = {}) => ({ request: { url: ORIGIN + path, method: 'GET', mode: 'navigate', ...over } });
const text = r => r.text();
// what a same-origin fetch() returns: a Response of type 'basic' (a bare `new Response` is 'default')
const R = (body, init) => Object.defineProperty(new Response(body, init), 'type', { value: 'basic', configurable: true });

// ---- 1. the allowlist --------------------------------------------------------------------------------------------------------------------
{
  const s = scope();
  s.net.handler = async () => R('<html>shell</html>');
  const must = ['/', '/history', '/history?page=2', '/system', '/device', '/agents', '/agents/harness-reviewer', '/agents/harness-reviewer/20261011-1', '/s/demo/aaaa1111-2222'];
  const never = ['/term/', '/term', '/term/?arg=menu', '/oauth2/sign_in', '/oauth2/start?rd=/', '/vnc/vnc.html', '/droidview/', '/api/history', '/stream', '/events', '/a/kill', '/md?f=x', '/md',
    '/manifest.webmanifest', '/sw.js', '/healthz', '/app', '/next/history', '/ui/agents', '/historyx', '/systems', '/s', '/shot', '/z', '/themes.json', '/_test/chat'];
  const got = [];
  for (const p of must) got.push([p, (await s.fire('fetch', nav(p))).called]);
  ok('1 the shell routes are answered: / /history /system /device /agents* /s/*', got.every(([, c]) => c), got.filter(([, c]) => !c));
  const leaked = [];
  for (const p of never) if ((await s.fire('fetch', nav(p))).called) leaked.push(p);
  ok('2 /term*, /oauth2/*, /vnc/*, /droidview/*, /api/*, /stream, /events, /a/*, /md and everything else are not intercepted', leaked.length === 0, leaked);
  ok('3 /term/ is passed through even offline: no respondWith, so the browser decides', await (async () => { s.net.handler = async () => { throw new TypeError('offline'); }; return !(await s.fire('fetch', nav('/term/'))).called; })());
  const others = [nav('/history', { method: 'POST' }), nav('/history', { mode: 'cors' }), { request: { url: 'https://other.test/history', method: 'GET', mode: 'navigate' } }, nav('/api/history', { mode: 'cors' })];
  const called = []; for (const e of others) called.push((await s.fire('fetch', e)).called);
  ok('4 a non-GET navigation, a sub-resource fetch and another origin are not intercepted', called.every(c => !c), called);
}

// ---- 2. a 3xx is never cached ------------------------------------------------------------------------------------------------------------
{
  const s = scope(), pages = () => s.stores.get('mows-pages') || new Map();
  const odd = { 'a 302': R(null, { status: 302, headers: { location: '/oauth2/sign_in' } }), 'a 301': R(null, { status: 301, headers: { location: '/x' } }),
    'an opaque redirect': R(null), 'a followed redirect (the sign-in bounce)': R('<html>login</html>'), 'a 500': R('boom', { status: 500 }), 'a 404': R('nope', { status: 404 }) };
  Object.defineProperty(odd['an opaque redirect'], 'type', { value: 'opaqueredirect' }); Object.defineProperty(odd['an opaque redirect'], 'status', { value: 0 });
  Object.defineProperty(odd['a followed redirect (the sign-in bounce)'], 'redirected', { value: true });
  const kept = [];
  for (const [name, r] of Object.entries(odd)) {
    s.net.handler = async () => r;
    const out = await s.fire('fetch', nav('/system'));
    if (out.res !== r || [...pages().keys()].length) kept.push(name);
  }
  ok('5 a 3xx, an opaque redirect, a followed redirect, a 4xx and a 5xx are returned as they are and never cached', kept.length === 0, kept);
  s.net.handler = async () => R('<html>ok</html>');
  await s.fire('fetch', nav('/system'));
  ok('6 a plain 200 is cached under its path', pages().get(ORIGIN + '/system')?.body === '<html>ok</html>');
  await s.fire('fetch', nav('/history?page=2'));
  ok('7 a query string is never a cache key', ![...pages().keys()].some(k => k.includes('?')));
  s.net.handler = async () => R('<html>fresh</html>');
  const live = await s.fire('fetch', nav('/system'));
  ok('8 the network answers first: a reachable server is never answered from the cache', await text(live.res) === '<html>fresh</html>');
  s.net.handler = async () => { throw new TypeError('offline'); };
  ok('9 offline, an allowlisted route is answered from the cache', await text((await s.fire('fetch', nav('/system'))).res) === '<html>fresh</html>');
}

// ---- 3. offline fallbacks ----------------------------------------------------------------------------------------------------------------
{
  const s = scope();
  s.net.handler = async () => { throw new TypeError('offline'); };
  const off = await s.fire('fetch', nav('/history'));
  const body = await text(off.res);
  ok('10 offline with nothing cached: the inline offline page, as the previous worker served it', off.res.status === 200 && /^<!doctype html>/.test(body) && body.includes('offline — the console needs a connection.') && /text\/html/.test(off.res.headers.get('content-type')), body.slice(0, 80));
  s.net.handler = async () => R('<html>home</html>');
  await s.fire('fetch', nav('/'));
  s.net.handler = async () => { throw new TypeError('offline'); };
  ok('11 offline on a route never visited: the cached shell document at /', await text((await s.fire('fetch', nav('/agents/never-seen'))).res) === '<html>home</html>');
}

// ---- 4. assets and the precache ----------------------------------------------------------------------------------------------------------
{
  const body = { 'main.AAAA1111.mjs': 'export{}', 'tokens.BBBB2222.css': 'body{}', 'bad.CCCC3333.mjs': 'tampered' };
  const sha = { 'main.AAAA1111.mjs': createHash('sha256').update(body['main.AAAA1111.mjs']).digest('hex'), 'tokens.BBBB2222.css': createHash('sha256').update(body['tokens.BBBB2222.css']).digest('hex'),
    'bad.CCCC3333.mjs': createHash('sha256').update('what the manifest says').digest('hex') };
  const s = scope(sha);
  s.net.handler = async u => { const p = String(u.url ?? u); return p.startsWith('/assets/') ? R(body[p.slice(8)]) : R('<html>home</html>'); };
  const ins = await s.fire('install');
  const assets = s.stores.get('mows-assets');
  ok('12 install precaches dist files by name and the shell document, then skipWaiting', ins.waits === 1 && s.log.skip === 1 && assets.get(ORIGIN + '/assets/main.AAAA1111.mjs')?.body === body['main.AAAA1111.mjs']
    && assets.has(ORIGIN + '/assets/tokens.BBBB2222.css') && s.stores.get('mows-pages').get(ORIGIN + '/')?.body === '<html>home</html>', [...assets.keys()]);
  ok('13 a file whose bytes do not hash to the manifest entry is not cached', !assets.has(ORIGIN + '/assets/bad.CCCC3333.mjs'));
  s.log.fetched.length = 0;
  const hit = await s.fire('fetch', { request: { url: ORIGIN + '/assets/main.AAAA1111.mjs', method: 'GET', mode: 'cors' } });
  ok('14 a precached asset is answered from the cache without the network', hit.called && await text(hit.res) === body['main.AAAA1111.mjs'] && s.log.fetched.length === 0);
  const miss = await s.fire('fetch', { request: { url: ORIGIN + '/assets/other.mjs', method: 'GET', mode: 'cors' } });
  ok('15 an asset that was not precached goes to the network', miss.called && s.log.fetched.length === 1);
}
{
  const s = scope({ 'main.AAAA1111.mjs': 'x' });
  const r = R('<html>login</html>'); Object.defineProperty(r, 'redirected', { value: true });
  s.net.handler = async () => r;
  await s.fire('install');
  ok('16 install never caches a shell document it reached through a redirect', !(s.stores.get('mows-pages')?.size));
}

// ---- 5. activate -------------------------------------------------------------------------------------------------------------------------
{
  const s = scope({ 'main.AAAA1111.mjs': 'x' });
  const put = async (n, k, b = 'x') => (await s.g.caches.open(n)).put(k, new Response(b));
  await put('mows-assets', '/assets/main.AAAA1111.mjs'); await put('mows-assets', '/assets/old.ZZZZ9999.mjs');
  await put('mows-pages', '/'); await put('mows-pages', '/history'); await put('legacy-cache', '/x');
  const act = await s.fire('activate');
  ok('17 activate drops assets the build no longer has, pages other than /, and caches it does not own, then claims', act.waits === 1 && s.log.claim === 1
    && [...s.stores.get('mows-assets').keys()].join() === ORIGIN + '/assets/main.AAAA1111.mjs' && [...s.stores.get('mows-pages').keys()].join() === ORIGIN + '/' && !s.stores.has('legacy-cache'));
}

// ---- 6. push -----------------------------------------------------------------------------------------------------------------------------
{
  const s = scope();
  const data = o => ({ data: { json: () => { if (o === undefined) throw new Error('no payload'); return o; } } });
  const decl = { web_push: 8030, notification: { title: 'cc-demo needs you', body: 'Do you want to proceed?', navigate: '/s/demo/aaaa1111', tag: 'aaaa1111' }, app_badge: 3 };
  await s.fire('push', data(decl));
  ok('18 a declarative push shows its notification with the tag and the route to open', s.log.shown.length === 1 && s.log.shown[0].title === 'cc-demo needs you' && s.log.shown[0].body === 'Do you want to proceed?'
    && s.log.shown[0].tag === 'aaaa1111' && s.log.shown[0].data.navigate === '/s/demo/aaaa1111', s.log.shown);
  ok('19 ...sets the app badge from it and records the delivery time for the System view', s.log.badge[0] === 3 && /^\d+$/.test(s.stores.get('mows-meta')?.get(ORIGIN + '/last-push')?.body ?? ''));
  await s.fire('push', data({ hello: 1 })); await s.fire('push', data(undefined)); await s.fire('push', {});
  ok('20 a payload that is not the declarative shape, or no payload, shows nothing', s.log.shown.length === 1);
  const n = (navigate, closed = () => { s.log.closed++; }) => ({ notification: { close: closed, data: { navigate } } });
  await s.fire('notificationclick', n('/s/demo/aaaa1111'));
  ok('21 a click closes the notification and opens its route when no window is open', s.log.closed === 1 && s.log.opened.join() === '/s/demo/aaaa1111');
  s.g.windows = [{ navigate: async u => { s.log.navigated.push(u); return { focus: async () => { s.log.navigated.push('focus'); } }; } }];
  await s.fire('notificationclick', n('/system'));
  ok('22 ...and navigates and focuses an open window instead', s.log.navigated.join() === '/system,focus' && s.log.opened.length === 1);
  s.g.windows = [];
  await s.fire('notificationclick', n('https://evil.test/phish'));
  ok('23 a route on another origin is replaced by /', s.log.opened[s.log.opened.length - 1] === '/');
}
console.log(bad ? `sw-check: ${bad} FAILED` : 'sw-check: all passed');
process.exit(bad ? 1 : 0);
