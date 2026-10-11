// device.mjs — `/device` (MAP 2.3.5, 5.2, 5.5; ledger D-U4): a left rail (Mobile | Web segments, info card, control cards, remote keys) and a
// stage that hosts the stream as an iframe, exactly as the legacy page did. The page is one `ApiDevice` (boot snapshot, then GET /api/device).
// The iframe is mounted on route enter and removed on route leave or when the tab is hidden; a booting emulator is re-polled every 4 s.
import { h, Fragment } from 'preact';
import { useState, useEffect, useRef } from 'preact/hooks';
import { Icon, act, base, useApi } from '../shared.mjs';
import { termHref } from '../term.mjs';

// the glyphs this view draws (legacy ICO path data)
const iCast = '<path d="M2 12a9 9 0 0 1 8 8"/><path d="M2 8a13 13 0 0 1 12 12"/><circle cx="2.5" cy="19.5" r="1" fill="currentColor" stroke="none"/>';
const iMaximize = '<path d="M8 3H5a2 2 0 0 0-2 2v3"/><path d="M21 8V5a2 2 0 0 0-2-2h-3"/><path d="M3 16v3a2 2 0 0 0 2 2h3"/><path d="M16 21h3a2 2 0 0 0 2-2v-3"/>';
const iMonitor = '<rect x="2" y="4" width="20" height="13" rx="2"/><path d="M8 21h8M12 17v4"/>';
const iPlay = '<path d="M6 4l14 8-14 8z"/>';
const iRefresh = '<path d="M21 12a9 9 0 1 1-3-6.7"/><path d="M21 3v6h-6"/>';
const iSmartphone = '<rect x="6" y="2" width="12" height="20" rx="2"/><path d="M11 18h2"/>';
const iSquare = '<rect x="5" y="5" width="14" height="14" rx="2"/>';

const PHONE = /iPhone|iPad|iPod|Android|Mobile|Silk/i;
const empty = (icon, msg, ...cap) => h('div', { class: 'stageempty' }, h('div', { class: 'stageicon' }, h(Icon, { d: icon, size: 14 })), h('div', { class: 'stagemsg' }, msg), h('p', { class: 'stagecap' }, ...cap));
const form = (action, cls, n, label, done) => h('form', { class: 'af ctlform', method: 'post', action, onSubmit: act(done) }, h('button', { class: 'ctlbtn wide ' + cls, type: 'submit' }, h(Icon, { d: n, solid: n === iPlay }), label));

export default function Device() {
  const [d, reload, err] = useApi('/api/device' + location.search);
  const [visible, setVisible] = useState(true);
  const frame = useRef(/** @type {HTMLIFrameElement | null} */ (null));
  const live = !!d && (d.droid.state === 'live' || d.web.live);
  const webLive = !!d && d.dv === 'web' && d.web.live && visible;
  const [Keys, setKeys] = useState(/** @type {any} */ (null));
  useEffect(() => { if (webLive && !Keys) import('../keys.mjs').then(m => setKeys(() => m.default)); }, [webLive]); // the remote keys load only when a browser is live

  useEffect(() => { // the stream is released while the tab is hidden and re-opened on return
    const f = () => setVisible(document.visibilityState !== 'hidden');
    document.addEventListener('visibilitychange', f);
    return () => document.removeEventListener('visibilitychange', f);
  }, []);
  useEffect(() => { // .termfab hides while a stream is on screen; devfs is the full-screen toggle
    document.body.classList.toggle('watchlive', live);
    return () => document.body.classList.remove('watchlive', 'devfs');
  }, [live]);
  useEffect(() => { // an emulator that is booting: ask again in 4 s
    if (d?.droid.state !== 'booting') return;
    const t = setTimeout(() => reload(), 4000);
    return () => clearTimeout(t);
  }, [d]);

  const head = h('h1', { 'data-view': 'device' }, h('a', { href: base() + '/' }, 'mows'), ' ', h('span', { class: 'muted' }, '· device'));
  if (!d) return h(Fragment, null, head, h('p', { class: 'muted' }, err ? `could not load the device page (${err}).` : 'Loading…'));

  const { droid, web, dv } = d, mobile = dv === 'mobile';
  const refresh = e => { e.preventDefault(); reload(); }; // the legacy Refresh was a page load; the same URL asks the server again
  const udid = droid.udid, up = droid.state === 'live';
  const seg = (v, n, label) => h('a', { class: 'segbtn' + (dv === v ? ' on' : ''), href: `${base()}/device?dv=${v}` }, h(Icon, { d: n, size: 14 }), label);
  const row = (k, v, good) => h('div', { class: 'devrow' }, h('span', null, k), h('span', { class: good ? 'good' : '' }, v));
  const badge = h('span', { class: 'lvb2' }, h('i', null), 'LIVE');
  const term = h('a', { href: termHref('menu', '') }, 'terminal');

  let info, ctl, stage, fill = false;
  if (mobile) {
    info = h('div', { class: 'devcard' },
      h('div', { class: 'devhead' }, h('div', null, h('div', { class: 'devname' }, 'Android Emulator'), h('div', { class: 'devsub' }, 'redroid · ' + udid)), up ? badge : null),
      h('div', { class: 'devrows' }, row('STATE', up ? 'RUNNING' : droid.state === 'booting' ? 'BOOTING' : 'STOPPED', up), droid.res ? row('RESOLUTION', droid.res) : null, row('TARGET', udid)));
    ctl = h('div', { class: 'devcard' }, h('div', { class: 'ctlhead' }, 'Emulator'),
      h('div', { class: 'ctlgrid' }, up ? form('/droid/stop', 'danger', iSquare, 'Stop Emulator', () => reload()) : form('/droid/start', 'ok', iPlay, 'Start Emulator', () => reload()),
        h('a', { class: 'ctlbtn', href: base() + '/device?dv=mobile', onClick: refresh }, h(Icon, { d: iRefresh }), 'Refresh'),
        h('a', { class: 'ctlbtn', href: '/droidview/', target: '_blank', rel: 'noopener' }, h(Icon, { d: iCast }), 'Console')),
      h('p', { class: 'dangercap' }, 'redroid (native-arch Android 15, no KVM) streams here via ws-scrcpy — interact directly in the frame on the right; its own slim in-frame toolbar has power/volume/back/home. install an apk from the ',
        term, ': ', h('b', null, `adb -s ${udid} install app.apk`), ' · run a QA flow: ', h('b', null, `maestro --device ${udid} test flow.yaml`), '.'));
    if (up) {
      const ws = encodeURIComponent(`wss://${location.host}/droidview/?action=proxy-adb&remote=${encodeURIComponent('tcp:8886')}&udid=${encodeURIComponent(udid)}`);
      const src = `/droidview/#!action=stream&udid=${encodeURIComponent(udid)}&player=tinyh264&fitToScreen=true&ws=${ws}`;
      // Safari ignores an iframe's viewport meta, so taps never line up in a frame: phones get the stream full-page instead
      if (PHONE.test(navigator.userAgent)) stage = h('div', { class: 'stageempty' }, h('a', { class: 'ctlbtn ok stagecta', href: src }, h(Icon, { d: iPlay, solid: true }), 'Open Screen (full page)'),
        h('p', { class: 'stagecap' }, 'opens the device full-screen so touch maps correctly on iOS — use your browser\'s back to return here.'));
      else if (visible) { fill = true; stage = h('iframe', { class: 'vnc', title: 'Android emulator (redroid remote view)', src }); }
      else fill = true;
    } else stage = empty(iSmartphone, 'Awaiting stream…', droid.state === 'booting' ? 'android is booting (~15s) — a containerized Android 15 (redroid). this page refreshes itself.'
      : ['press ', h('b', null, 'start emulator'), ' — a containerized Android 15 (redroid, native-arch, no KVM) boots in ~15s and its screen appears here.']);
  } else {
    info = h('div', { class: 'devcard' },
      h('div', { class: 'devhead' }, h('div', null, h('div', { class: 'devname' }, 'QA Browser'), h('div', { class: 'devsub' }, 'Xvfb :99 · Chrome (noVNC)')), web.live ? badge : null),
      h('div', { class: 'devrows' }, row('STATE', web.live ? 'LIVE' : 'IDLE', web.live), row('PORT', String(web.port))));
    ctl = h(Fragment, null, h('div', { class: 'devcard' }, h('div', { class: 'ctlhead' }, 'Browser'),
      h('div', { class: 'ctlgrid' }, web.live ? form('/watch/stop', 'danger', iSquare, 'Stop Browser', () => reload()) : form('/watch/start', 'ok', iPlay, 'Start Browser', () => reload()),
        h('a', { class: 'ctlbtn wide', href: base() + '/device?dv=web', onClick: refresh }, h(Icon, { d: iRefresh }), 'Refresh')),
      h('p', { class: 'dangercap' }, 'run a QA journey in ', h('b', null, 'watched'), ' mode; when the agent needs you (a login/OTP, or an eyeball on a UI change) it pauses and the browser shows up on the right — take over right in the frame, then tell the agent ',
        h('b', null, 'continue'), ' in the ', term, '.')),
      web.live && Keys ? h(Keys, { frame, on: webLive }) : null);
    if (web.live) {
      fill = true;
      if (visible) stage = h('iframe', { ref: frame, id: 'vf', class: 'vnc', title: 'QA browser (noVNC remote view)', allow: 'clipboard-read;clipboard-write',
        src: '/vnc/vnc.html?autoconnect=1&resize=scale&reconnect=1&quality=9&compression=6&path=vnc/websockify' });
    } else stage = empty(iMonitor, 'Awaiting stream…', 'press ', h('b', null, 'start browser'), ', then run a QA journey in ', h('b', null, 'watched'), ' mode — the agent brings this browser up and you share it.');
  }

  return h(Fragment, null, head, h('div', { class: 'devlayout' },
    h('aside', { class: 'devrail' }, h('div', { class: 'segtoggle' }, seg('mobile', iSmartphone, 'Mobile'), seg('web', iMonitor, 'Web')), info, ctl),
    h('div', { class: 'devstage' + (fill ? ' live' : '') },
      fill ? h('button', { class: 'fsbtn', type: 'button', title: 'full screen — rotate for landscape', 'aria-label': 'toggle full screen', onClick: () => document.body.classList.toggle('devfs') }, h(Icon, { d: iMaximize })) : null,
      stage)));
}
