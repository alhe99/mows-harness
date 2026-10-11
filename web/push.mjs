// push.mjs — the System view's Notifications card (MAP 2.3.4; ledger K-37): permission state, subscribe and unsubscribe, the last delivery. Loaded on
// demand by views/system.mjs, so it is not part of that route's budget. The card appears once the service worker is ready: until then (and where
// workers are blocked) there is nothing to subscribe with. The worker shows the notification and records the delivery time (web/sw.mjs).
import { h } from 'preact';
import { useState, useEffect } from 'preact/hooks';
import { relS } from './shared.mjs';

const ID = 'mows-push-id';
const keep = v => { try { v == null ? localStorage.removeItem(ID) : localStorage.setItem(ID, v); } catch { /* private window */ } };
const kept = () => { try { return localStorage.getItem(ID); } catch { return null; } };
const bytes = b64 => Uint8Array.from(atob(b64.replace(/-/g, '+').replace(/_/g, '/')), c => c.charCodeAt(0));
const json = (method, url, body) => fetch(url, { method, headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });

const supported = () => 'PushManager' in window && 'Notification' in window;
async function state() {
  const reg = await navigator.serviceWorker.ready;
  const sub = supported() ? await reg.pushManager.getSubscription() : null;
  const last = await caches.open('mows-meta').then(c => c.match('/last-push')).then(r => r && r.text()).catch(() => null);
  return { reg, on: !!sub, perm: supported() ? Notification.permission : 'unsupported', last: last ? +last : 0 };
}

export default function Notifications() {
  const [s, set] = useState(/** @type {any} */ (null));
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const refresh = () => state().then(set, () => {});
  useEffect(() => { refresh(); }, []);
  if (!s) return null;

  const run = fn => async () => { setBusy(true); setErr(''); try { await fn(); } catch (e) { setErr(String(/** @type {any} */ (e)?.message || e)); } setBusy(false); await refresh(); };
  const enable = run(async () => {
    if (await Notification.requestPermission() !== 'granted') return;
    const { key } = await (await fetch('/api/push/key')).json();
    await (await s.reg.pushManager.getSubscription())?.unsubscribe(); // one made for another key (rotated) cannot be reused
    const sub = await s.reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: bytes(key) });
    const r = await json('POST', '/api/push/subscribe', sub.toJSON());
    if (!r.ok) { await sub.unsubscribe(); throw new Error(`the server refused the subscription (${r.status})`); }
    keep((await r.json()).id);
  });
  const disable = run(async () => {
    const sub = await s.reg.pushManager.getSubscription(), id = kept();
    if (id) await json('DELETE', '/api/push/subscribe', { id }).catch(() => {});
    await sub?.unsubscribe();
    keep(null);
  });

  const row = (k, v) => h('div', { class: 'envrow' }, h('span', { class: 'envkey' }, k), h('span', { class: 'envval' + (k === 'STATUS' && s.on ? ' ok' : '') }, v));
  return h('section', { class: 'sysright-item', 'data-card': 'notifications' },
    h('div', { class: 'sechead' }, h('h2', null, 'Notifications'), h('p', null, 'A push when a session needs you, and the app badge.')),
    h('div', { class: 'termcard set' }, h('div', { class: 'seclabel' }, 'Push'),
      h('div', { class: 'envrows' },
        row('PERMISSION', s.perm), row('STATUS', s.perm === 'unsupported' ? 'not available' : s.on ? 'subscribed' : 'off'),
        row('LAST_DELIVERY', s.last ? relS(s.last) + (relS(s.last) === 'now' ? '' : ' ago') : 'none yet')),
      s.perm === 'unsupported'
        ? h('p', { class: 'dangercap' }, 'This browser cannot receive push here. On an iPhone or iPad, add mows to the Home Screen and open it from there.')
        : s.perm === 'denied'
          ? h('p', { class: 'dangercap' }, 'Notifications are blocked for this site. Allow them in the browser or system settings, then come back.')
          : h('button', { class: 'ab' + (s.on ? '' : ' ok'), disabled: busy, onClick: s.on ? disable : enable }, s.on ? 'Turn off notifications' : 'Turn on notifications'),
      err ? h('p', { class: 'dangercap', role: 'alert' }, err) : null));
}
