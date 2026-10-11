// main.mjs — the shell: router, store boot, active tab. The chrome (header, tab bar, FAB, footer) is server markup; this file
// only renders the routed view into #app, keeps the active tab in step with the path, and owns link interception (K-35).
import { h, render } from 'preact';
import { LocationProvider, Router, useLocation } from 'preact-iso/router';
import lazy from 'preact-iso/lazy';
import { store } from './store.mjs';
import './standalone.mjs';

// '/next' while the current UI still serves '/' (phase 05 swaps them and the server sends '').
const base = document.documentElement.dataset.base || '';
const boot = JSON.parse(String(document.getElementById('boot')?.textContent));
store.start(boot);

// one lazy import() per view, so each view is its own chunk and budget (K-02)
const routes = [
  ['/', lazy(() => import('./views/sessions.mjs'))],
  ['/history', lazy(() => import('./views/history.mjs'))],
  ['/system', lazy(() => import('./views/system.mjs'))],
  ['/device', lazy(() => import('./views/device.mjs'))],
  ['/agents', lazy(() => import('./views/agents.mjs'))],
  ['/agents/:name', lazy(() => import('./views/agent.mjs'))],
  ['/agents/:name/:run', lazy(() => import('./views/run.mjs'))],
  ['/s/:acct/:sid', lazy(() => import('./views/session.mjs'))],
];
const NotFound = () => h('h1', { 'data-view': 'not-found' }, 'not found');

// the path inside the shell, or null when it is outside it
const inShell = p => (!base ? p : p === base || p.startsWith(base + '/') ? p.slice(base.length) || '/' : null);
const tabOf = p => (p === '/' ? 'sessions' : /^\/(history|system|device|agents)(\/|$)/.exec(p)?.[1] ?? '');
function syncTabs() {
  const here = tabOf(inShell(location.pathname) ?? '');
  for (const a of document.querySelectorAll('.tb, .pnav a'))
    a.classList.toggle('on', !!here && tabOf(inShell(/** @type {HTMLAnchorElement} */ (a).pathname) ?? '') === here);
}
syncTabs();

// Prefetch replaces prerender (K-35): hovering or touching a tab link fetches that route's JSON into the store, so the tap that
// follows renders without a request. Same exclusions as the old speculation rules: never /term*, fresh=1, reclaim=1 or data-norun.
// Only these routes have JSON; the others are not prefetched.
const API = { '/history': '/api/history', '/system': '/api/system', '/device': '/api/device', '/agents': '/api/agents' };
function prefetch(e) {
  const a = /** @type {HTMLAnchorElement} */ (e.currentTarget), api = API[inShell(a.pathname) ?? ''];
  if (api && !/[?&](fresh|reclaim)=1\b/.test(a.search) && !a.hasAttribute('data-norun')) store.getJson(api + a.search).catch(() => {});
}
for (const a of document.querySelectorAll('.tb, .pnav a')) for (const ev of ['pointerenter', 'touchstart']) a.addEventListener(ev, prefetch, { passive: true });

// Back/Forward replace bfcache (K-35): the store keeps each route's scroll offset. It is saved when a route is left, by a link click
// or by popstate (the /ui SPA saved it on click navigation only, which lost scroll -> Back -> Forward -> Back), and a pop restores it
// once the route has rendered. `here` is the route on screen: at popstate time `location` is already the next one.
history.scrollRestoration = 'manual';
const routeKey = () => location.pathname + location.search;
let here = routeKey(), pushed = false;
// preact-iso only scrolls and calls onRouteChange when the pathname changes, so a query-only pop restores here
addEventListener('popstate', () => {
  store.scroll.set(here, scrollY); pushed = false;
  const samePath = here.split('?')[0] === location.pathname;
  here = routeKey();
  if (samePath) restore(store.scroll.get(here) ?? 0);
});
function restore(y) { // the view swaps a few frames after popstate and the document collapses (scrollY clamps to 0), so re-apply for ~10 frames
  let n = 0;
  const step = () => { if (Math.abs(scrollY - y) > 1) scrollTo(0, y); if (n++ < 10) requestAnimationFrame(step); };
  requestAnimationFrame(step);
}

// Route changes run inside a view transition when the browser has one; `.tabs` keeps view-transition-name: tabs.
// The transition's callback settles when the Router reports the new route committed (lazy views suspend until loaded).
let navigate = /** @type {(url: string) => void} */ (() => {});
let settle = /** @type {null | (() => void)} */ (null);
function go(url) {
  store.scroll.set(here, scrollY);
  pushed = true;
  if (new URL(url, location.href).pathname === location.pathname) { // query-only: no route change event, land at the top (K-35)
    navigate(url); const u = new URL(url, location.href); here = u.pathname + u.search; pushed = false; scrollTo(0, 0); return;
  }
  if (!document.startViewTransition) return navigate(url);
  document.startViewTransition(() => new Promise(done => {
    const t = setTimeout(done, 1000); // never hold the page behind a transition that cannot settle
    settle = () => { clearTimeout(t); settle = null; done(undefined); };
    navigate(url);
  }));
}

// Our listener is registered before preact-iso's own window click router and stops the event, so only links we accept are routed.
// Skipped, left to the browser: modified or non-primary clicks, targets, downloads, data-nw named windows, fragments, other
// origins, anything outside the shell, and the separate documents /term*, /md, /oauth2/* and the device streams /droidview/* and /vnc/*.
addEventListener('click', e => {
  e.stopImmediatePropagation();
  if (e.defaultPrevented || e.button || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
  const a = /** @type {HTMLAnchorElement | undefined} */ (e.composedPath().find(n => /** @type {Node} */ (n).nodeName === 'A' && /** @type {any} */ (n).href));
  if (!a || (a.target && a.target !== '_self') || a.hasAttribute('download') || a.hasAttribute('data-nw')
    || a.origin !== location.origin || a.getAttribute('href')?.startsWith('#')) return;
  const rel = inShell(a.pathname);
  if (rel == null || /^\/(term|md|oauth2|droidview|vnc)(\/|$)/.test(rel)) return;
  e.preventDefault();
  go(a.pathname + a.search);
});

function App() {
  navigate = useLocation().route;
  store.setGo(go); // views route with the same view-transition and scroll handling a link click gets
  return h(/** @type {any} */ (Router), { onRouteChange: () => {
      syncTabs(); settle?.();
      here = routeKey();
      if (!pushed) restore(store.scroll.get(here) ?? 0);
      pushed = false;
    } },
    ...routes.map(([path, component]) => h(component, { path: base + (path === '/' ? '' : path) || '/' })),
    h(NotFound, { default: true }));
}
render(h(LocationProvider, null, h(App, null)), /** @type {Element} */ (document.getElementById('app')));
