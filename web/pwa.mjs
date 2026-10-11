// pwa.mjs — the installed-app layer the shell starts once (ARCHITECTURE section 8; ledger O-4): the service worker, the app badge and the Wake Lock.
//   badge      navigator.setAppBadge(n), n = sessions in `needs-you` in the fleet signal (clearAppBadge at 0); cleared on focus, set again by the next change.
//   wake lock  navigator.wakeLock.request('screen') while any session is `working` and the tab is visible; released otherwise, and taken again on return.
import { effect } from '@preact/signals';

/** @param {{ fleet: { value: import('./contract').FleetItem[] } }} store @param {any} env  globalThis; scripts and probes pass stand-ins. */
export function startPwa(store, env = globalThis) {
  const nav = env.navigator, doc = env.document;
  if (nav.serviceWorker) env.addEventListener('load', () => nav.serviceWorker.register('/sw.js').catch(() => {}));

  if (nav.setAppBadge) {
    const set = n => (n ? nav.setAppBadge(n) : nav.clearAppBadge()).catch(() => {});
    effect(() => set(store.fleet.value.filter(f => f.state === 'needs-you').length));
    env.addEventListener('focus', () => nav.clearAppBadge().catch(() => {}));
  }

  if (nav.wakeLock) {
    let lock = null, asking = false;
    const want = () => doc.visibilityState === 'visible' && store.fleet.value.some(f => f.state === 'working');
    const sync = async () => {
      if (!want()) { lock?.release().catch(() => {}); lock = null; return; }
      if (lock || asking) return;
      asking = true;
      try {
        const l = await nav.wakeLock.request('screen');
        l.addEventListener('release', () => { if (lock === l) lock = null; }); // the browser drops it when the tab hides
        if (want()) lock = l; else l.release().catch(() => {});
      } catch { /* refused (low battery, no permission): the next change asks again */ }
      asking = false;
    };
    effect(() => { sync(); });
    doc.addEventListener('visibilitychange', sync);
  }
}
