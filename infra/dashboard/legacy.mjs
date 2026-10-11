import { promises as fsp } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { randomBytes } from 'node:crypto';
import { ASSET_TYPES } from './static.mjs';
import { DROID_UDID, droidState, watchLive } from './routes/device.mjs';
import { ACCTS, BY_ID, GB, HB, HOST_ACCT, MSG_PAGE, RESUME_DAYS, canResume, claudeVersion, counts, crc32, fleetKey, fleetState, freshen, hostInfo, index, liveSid8, loadSession, mshort, projName, qs, reclaimScan, runAs, send, termHref, tmuxLive, uiCsp, usage, usageCache } from './core.mjs';
import { historyQuery } from './routes/api.mjs';
import { AGENTS_STATE, AGENT_RE, RUN_RE, agentChat, agentTimers, agentsIndex, summarizeTimers } from './routes/agents.mjs';


// ---------- Device tab: lucide-style inline icon set (spec ADDENDUM 36:852) ----------
// Hand-inlined (no icon font/webfont/download): stroke=currentColor, 2px stroke, viewBox
// 0 0 24 24, ~2-3 paths each — per spec, unicode glyphs are not acceptable here. Only
// icons with a REAL control behind them are drawn: camera/video/rotate/volume-±/power/home
// (the mock's android "hardware keys") have no backing dashboard action — ws-scrcpy's own
// in-frame toolbar already covers power/volume/back/home — so per the "don't fabricate
// controls for pixel parity" rule those are intentionally not implemented here.
const ICO = {
  smartphone: `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="6" y="2" width="12" height="20" rx="2"/><path d="M11 18h2"/></svg>`,
  monitor: `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="2" y="4" width="20" height="13" rx="2"/><path d="M8 21h8M12 17v4"/></svg>`,
  refresh: `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M21 12a9 9 0 1 1-3-6.7"/><path d="M21 3v6h-6"/></svg>`,
  arrowLeft: `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M19 12H5"/><path d="M12 19l-7-7 7-7"/></svg>`,
  square: `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="5" y="5" width="14" height="14" rx="2"/></svg>`,
  cast: `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M2 12a9 9 0 0 1 8 8"/><path d="M2 8a13 13 0 0 1 12 12"/><circle cx="2.5" cy="19.5" r="1" fill="currentColor" stroke="none"/></svg>`,
  play: `<svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor" stroke="none" aria-hidden="true"><path d="M6 4l14 8-14 8z"/></svg>`,
  keyboard: `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="2" y="6" width="20" height="12" rx="2"/><path d="M6 14h12M6 10h.01M10 10h.01M14 10h.01M18 10h.01"/></svg>`,
  clipboard: `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="8" y="2" width="8" height="4" rx="1"/><path d="M8 4H6a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V6a2 2 0 0 0-2-2h-2"/></svg>`,
  chevronUp: `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M18 15l-6-6-6 6"/></svg>`,
  chevronDown: `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M6 9l6 6 6-6"/></svg>`,
  chevronLeft: `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M15 18l-6-6 6-6"/></svg>`,
  chevronRight: `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M9 18l6-6-6-6"/></svg>`,
  chevronsLeft: `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M11 17l-5-5 5-5"/><path d="M18 17l-5-5 5-5"/></svg>`,
  chevronsRight: `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M6 17l5-5-5-5"/><path d="M13 17l5-5-5-5"/></svg>`,
  history: `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M3 12a9 9 0 1 0 9-9 9.75 9.75 0 0 0-6.74 2.74L3 8"/><path d="M3 3v5h5"/><path d="M12 7v5l4 2"/></svg>`,
  activity: `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M22 12h-4l-3 9L9 3l-3 9H2"/></svg>`,
  list: `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M8 6h13M8 12h13M8 18h13M3 6h.01M3 12h.01M3 18h.01"/></svg>`,
  monitorSmartphone: `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M18 8V6a2 2 0 0 0-2-2H4a2 2 0 0 0-2 2v7a2 2 0 0 0 2 2h8"/><path d="M7 19h5"/><rect x="16" y="12" width="6" height="10" rx="2"/></svg>`,
  x: `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M18 6 6 18M6 6l12 12"/></svg>`,
  pencil: `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M17 3a2.85 2.83 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5Z"/></svg>`,
  pause: `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="6" y="4" width="4" height="16" rx="1"/><rect x="14" y="4" width="4" height="16" rx="1"/></svg>`,
  ellipsis: `<svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor" stroke="none" aria-hidden="true"><circle cx="5" cy="12" r="1.6"/><circle cx="12" cy="12" r="1.6"/><circle cx="19" cy="12" r="1.6"/></svg>`,
  trash: `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M3 6h18"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6"/><path d="M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/></svg>`,
  terminal: `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m4 17 6-6-6-6"/><path d="M12 19h8"/></svg>`,
  plus: `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 5v14M5 12h14"/></svg>`,
  // The one 44:5 glyph ICO did not already carry. Path data is the Figma export's verbatim, so
  // it keeps its native viewBox 0 0 16 16 and 1.33333 stroke rather than being redrawn on the
  // 24-grid the others use — 1.33333/16 is the same ratio as 2/24, so it renders at identical
  // visual weight beside them. stroke is currentColor (the export baked #18181B); nothing else
  // was touched.
  send: `<svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.33333" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M9.69067 14.4573C9.71599 14.5205 9.76003 14.5743 9.81685 14.6117C9.87367 14.6491 9.94057 14.6682 10.0086 14.6664C10.0766 14.6647 10.1424 14.6422 10.1972 14.602C10.2521 14.5617 10.2933 14.5057 10.3153 14.4413L14.6487 1.77467C14.67 1.7156 14.6741 1.65167 14.6604 1.59037C14.6467 1.52907 14.6159 1.47293 14.5715 1.42852C14.5271 1.38411 14.4709 1.35326 14.4096 1.33959C14.3483 1.32593 14.2844 1.33 14.2253 1.35133L1.55867 5.68467C1.49433 5.70673 1.43828 5.74795 1.39805 5.80278C1.35781 5.85762 1.33531 5.92345 1.33357 5.99144C1.33183 6.05943 1.35093 6.12633 1.38831 6.18315C1.42568 6.23997 1.47954 6.28401 1.54267 6.30933L6.82933 8.42933C6.99646 8.49625 7.1483 8.59631 7.27571 8.72349C7.40312 8.85067 7.50345 9.00233 7.57067 9.16933L9.69067 14.4573Z"/><path d="M14.5693 1.43133L7.276 8.724"/></svg>`,
  wrench: `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M14.7 6.3a1 1 0 0 0 0 1.4l1.6 1.6a1 1 0 0 0 1.4 0l3.77-3.77a6 6 0 0 1-7.94 7.94l-6.91 6.91a2.12 2.12 0 0 1-3-3l6.91-6.91a6 6 0 0 1 7.94-7.94l-3.76 3.76z"/></svg>`,
  search: `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="11" cy="11" r="8"/><path d="m21 21-4.35-4.35"/></svg>`,
  maximize: `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M8 3H5a2 2 0 0 0-2 2v3"/><path d="M21 8V5a2 2 0 0 0-2-2h-3"/><path d="M3 16v3a2 2 0 0 0 2 2h3"/><path d="M16 21h3a2 2 0 0 0 2-2v-3"/></svg>`,
};

// spec empty-state / stage helper (icon box + mono message + dim caption, node 36:651)
function stageEmpty(icon, msg, cap) {
  return `<div class="stageempty"><div class="stageicon">${icon}</div><div class="stagemsg">${esc(msg)}</div><p class="stagecap">${cap}</p></div>`;
}

// ---------- Device tab, Mobile (Android) rail + stage — spec 36:651 ----------
// device info card: real facts only (state, resolution via `adb shell wm size` when
// live, target udid) — a disconnected device shows no LIVE badge (spec's own rule).
function androidInfoCard(st) {
  const live = st.state === 'live';
  const label = live ? 'RUNNING' : st.state === 'booting' ? 'BOOTING' : 'STOPPED';
  const badge = live ? `<span class="lvb2"><i></i>LIVE</span>` : '';
  return `<div class="devcard">
<div class="devhead"><div><div class="devname">Android Emulator</div><div class="devsub">redroid · ${esc(DROID_UDID)}</div></div>${badge}</div>
<div class="devrows">
<div class="devrow"><span>STATE</span><span class="${live ? 'good' : ''}">${label}</span></div>
${st.res ? `<div class="devrow"><span>RESOLUTION</span><span>${esc(st.res)}</span></div>` : ''}
<div class="devrow"><span>TARGET</span><span>${esc(DROID_UDID)}</span></div>
</div></div>`;
}

function androidControlCard(st) {
  const live = st.state === 'live';
  const primary = live
    ? `<form class="af ctlform" method="post" action="/droid/stop"><button class="ctlbtn wide danger" type="submit">${ICO.square}Stop Emulator</button></form>`
    : `<form class="af ctlform" method="post" action="/droid/start"><button class="ctlbtn wide ok" type="submit">${ICO.play}Start Emulator</button></form>`;
  return `<div class="devcard">
<div class="ctlhead">Emulator</div>
<div class="ctlgrid">
${primary}
<a class="ctlbtn" href="/device?dv=mobile">${ICO.refresh}Refresh</a>
<a class="ctlbtn" href="/droidview/" target="_blank" rel="noopener">${ICO.cast}Console</a>
</div>
<p class="dangercap">redroid (native-arch Android 15, no KVM) streams here via ws-scrcpy — interact directly in the frame on the right; its own slim in-frame toolbar has power/volume/back/home. install an apk from the <a href="${termHref('menu', '')}">terminal</a>: <b>adb -s ${esc(DROID_UDID)} install app.apk</b> · run a QA flow: <b>maestro --device ${esc(DROID_UDID)} test flow.yaml</b>.</p>
</div>`;
}

function androidStage(req, st) {
  if (st.state === 'live') {
    // stream via the same-origin /droidview/* proxy (Caddy strip_prefix -> ws-scrcpy :8000):
    // gauth cookie + frame-ancestors 'self' both hold, no cross-site iframe auth. tinyh264 =
    // wasm decoder, phone + desktop alike. ws endpoint rides the same proxy path (wss).
    const ws = encodeURIComponent(`wss://${req.headers.host || ''}/droidview/?action=proxy-adb&remote=${encodeURIComponent('tcp:8886')}&udid=${encodeURIComponent(DROID_UDID)}`);
    const streamUrl = `/droidview/#!action=stream&udid=${encodeURIComponent(DROID_UDID)}&player=tinyh264&fitToScreen=true&ws=${ws}`;
    // iOS/Safari ignores an IFRAME's <meta viewport>: it lays the inner document out at a
    // phantom 980px width and auto-expands the frame, so ws-scrcpy fits its canvas to a
    // viewport that isn't there and taps never line up (verified with Playwright WebKit —
    // 0 touch events in-frame, works top-level). Phones therefore get the stream full-page.
    const mobile = /iPhone|iPad|iPod|Android|Mobile|Silk/i.test(req.headers['user-agent'] || '');
    if (mobile) {
      return { html: `<div class="stageempty"><a class="ctlbtn ok stagecta" href="${streamUrl}">${ICO.play}Open Screen (full page)</a>
<p class="stagecap">opens the device full-screen so touch maps correctly on iOS — use your browser's back to return here.</p></div>`, fill: false };
    }
    return { html: `<iframe class="vnc" title="Android emulator (redroid remote view)" src="${streamUrl}"></iframe>`, fill: true };
  }
  if (st.state === 'booting') {
    return { html: stageEmpty(ICO.smartphone, 'Awaiting stream…', 'android is booting (~15s) — a containerized Android 15 (redroid). this page refreshes itself.'), fill: false };
  }
  return { html: stageEmpty(ICO.smartphone, 'Awaiting stream…', 'press <b>start emulator</b> — a containerized Android 15 (redroid, native-arch, no KVM) boots in ~15s and its screen appears here.'), fill: false };
}


// ---------- Device tab, Web (noVNC) rail + stage — spec 36:651 ----------
function browserInfoCard(up) {
  const badge = up ? `<span class="lvb2"><i></i>LIVE</span>` : '';
  return `<div class="devcard">
<div class="devhead"><div><div class="devname">QA Browser</div><div class="devsub">Xvfb :99 · Chrome (noVNC)</div></div>${badge}</div>
<div class="devrows">
<div class="devrow"><span>STATE</span><span class="${up ? 'good' : ''}">${up ? 'LIVE' : 'IDLE'}</span></div>
<div class="devrow"><span>PORT</span><span>6080</span></div>
</div></div>`;
}

function browserControlCard(up) {
  const primary = up
    ? `<form class="af ctlform" method="post" action="/watch/stop"><button class="ctlbtn wide danger" type="submit">${ICO.square}Stop Browser</button></form>`
    : `<form class="af ctlform" method="post" action="/watch/start"><button class="ctlbtn wide ok" type="submit">${ICO.play}Start Browser</button></form>`;
  return `<div class="devcard">
<div class="ctlhead">Browser</div>
<div class="ctlgrid">
${primary}
<a class="ctlbtn wide" href="/device?dv=web">${ICO.refresh}Refresh</a>
</div>
<p class="dangercap">run a QA journey in <b>watched</b> mode; when the agent needs you (a login/OTP, or an eyeball on a UI change) it pauses and the browser shows up on the right — take over right in the frame, then tell the agent <b>continue</b> in the <a href="${termHref('menu', '')}">terminal</a>.</p>
</div>`;
}

// remote-keys card: the old .wbar toolbar's real key-injection buttons, restyled as an
// icon-only ControlButton grid (spec: "icon-only buttons for hardware keys"). Only
// rendered when the browser is actually live — same gate the old .wbar had, since these
// onclick handlers reach into the live iframe's RFB session.
function remoteKeysCard() {
  return `<div class="devcard">
<div class="ctlhead">Remote keys</div>
<div class="ctlgrid icons4">
<button class="ctlbtn" type="button" onclick="kb()" title="show keyboard" aria-label="show keyboard">${ICO.keyboard}</button>
<button class="ctlbtn" type="button" onclick="pst()" title="paste clipboard" aria-label="paste clipboard">${ICO.clipboard}</button>
<button class="ctlbtn" type="button" onclick="k(0xff55,'PageUp')" title="scroll up" aria-label="scroll up">${ICO.chevronUp}</button>
<button class="ctlbtn" type="button" onclick="k(0xff56,'PageDown')" title="scroll down" aria-label="scroll down">${ICO.chevronDown}</button>
<button class="ctlbtn" type="button" onclick="nav(1)" title="back" aria-label="back">${ICO.arrowLeft}</button>
<button class="ctlbtn icoflip" type="button" onclick="nav(0)" title="forward" aria-label="forward">${ICO.arrowLeft}</button>
<button class="ctlbtn" type="button" onclick="k(0xffc2,'F5')" title="reload" aria-label="reload">${ICO.refresh}</button>
<button class="ctlbtn" type="button" onclick="k(0xff1b,'Escape')" title="escape" aria-label="escape">${ICO.square}</button>
</div>
</div>`;
}

function remoteKeysScript() {
  // path=vnc/websockify: noVNC builds its WS URL as wss://host/<path> (root-relative, NOT
  // relative to /vnc/vnc.html), so the default 'websockify' would miss the /vnc/* route and
  // hit the dashboard. We reach noVNC's live RFB by re-importing ui.js in the same-origin
  // iframe (ES-module singleton → same UI.rfb); the keyboard button pops the phone keyboard.
  return `<script>
function _v(){return document.getElementById('vf')}
function _w(){return _v().contentWindow||{}}
function nb(i){try{_v().contentDocument.getElementById(i).click()}catch(e){}}
function k(s,c){var r=_w().rfb;if(r)r.sendKey(s,c)}
function nav(b){var r=_w().rfb;if(!r)return;var s=b?0xff51:0xff53,c=b?'ArrowLeft':'ArrowRight';r.sendKey(0xffe9,'AltLeft',true);r.sendKey(s,c,true);r.sendKey(s,c,false);r.sendKey(0xffe9,'AltLeft',false)}
function kb(){nb('noVNC_keyboard_button');try{var i=_v().contentDocument.getElementById('noVNC_keyboardinput');if(i)i.focus()}catch(e){}}
// paste device clipboard -> remote clipboard -> Ctrl+V into the focused remote field
function pv(r,t){r.clipboardPasteFrom(t);setTimeout(function(){r.sendKey(0xffe3,'ControlLeft',true);r.sendKey(0x76,'KeyV',true);r.sendKey(0x76,'KeyV',false);r.sendKey(0xffe3,'ControlLeft',false)},90)}
function fbk(r){var m=prompt('Paste text here, then OK — I will type it into the browser:');if(m)pv(r,m)}
function pst(){var r=_w().rfb;if(!r)return;if(navigator.clipboard&&navigator.clipboard.readText){navigator.clipboard.readText().then(function(t){t?pv(r,t):fbk(r)}).catch(function(){fbk(r)})}else fbk(r)}
function _x(){try{if(_w().rfb)return;var d=_v().contentDocument;var s=d.createElement('script');s.type='module';s.textContent="import UI from './app/ui.js';window.rfb=UI.rfb;";d.body.appendChild(s)}catch(e){}}
var _t=setInterval(function(){if(_w().rfb)clearInterval(_t);else _x()},1200);
</script>`;
}

function browserStage(up) {
  if (up) {
    return { html: `<iframe id="vf" class="vnc" title="QA browser (noVNC remote view)" src="/vnc/vnc.html?autoconnect=1&amp;resize=scale&amp;reconnect=1&amp;quality=9&amp;compression=6&amp;path=vnc/websockify" allow="clipboard-read;clipboard-write"></iframe>`, fill: true };
  }
  return { html: stageEmpty(ICO.monitor, 'Awaiting stream…', 'press <b>start browser</b>, then run a QA journey in <b>watched</b> mode — the agent brings this browser up and you share it.'), fill: false };
}


// ---------- /device: consolidated device/terminal-level controls (gap #3) ----------
// One tab instead of three (settings/android/watch): the redroid Android emulator, the
// QA-watch noVNC takeover browser, and terminal theme + bulk restart, laid out per the
// figma-make addendum (node 36:651) — 320px left rail (segmented Mobile|Web toggle +
// device-info card + control cards) + a dashed right stage hosting the real stream.
// bodyClass stays 'watchlive' whenever either remote-video section is actually live
// (hides the floating terminal FAB so it never overlaps the stream).
export async function deviceView(req, res) {
  const url = new URL(req.url, 'http://x');
  const [droidSt, watchUp] = await Promise.all([droidState(), watchLive()]);
  const dvParam = url.searchParams.get('dv');
  // default: whichever device is actually doing something; else Mobile.
  const sel = dvParam === 'web' ? 'web' : dvParam === 'mobile' ? 'mobile'
    : (droidSt.state !== 'stopped' ? 'mobile' : watchUp ? 'web' : 'mobile');
  const toggle = `<div class="segtoggle">
<a class="segbtn${sel === 'mobile' ? ' on' : ''}" href="/device?dv=mobile">${ICO.smartphone}Mobile</a>
<a class="segbtn${sel === 'web' ? ' on' : ''}" href="/device?dv=web">${ICO.monitor}Web</a>
</div>`;
  let infoCard, ctlCards, stageObj, script = '';
  if (sel === 'mobile') {
    infoCard = androidInfoCard(droidSt);
    ctlCards = androidControlCard(droidSt);
    stageObj = androidStage(req, droidSt);
  } else {
    infoCard = browserInfoCard(watchUp);
    ctlCards = browserControlCard(watchUp) + (watchUp ? remoteKeysCard() : '');
    stageObj = browserStage(watchUp);
    if (watchUp) script = remoteKeysScript();
  }
  const rail = `<aside class="devrail">
${toggle}
${infoCard}
${ctlCards}
</aside>`;
  // live streams get a full-screen toggle (asked for on mobile): pure CSS class flip —
  // iOS refuses the real Fullscreen API on iframes, and the manifest has no orientation
  // lock, so overlay + rotate the phone = landscape full screen. Same button exits.
  const fsBtn = stageObj.fill
    ? `<button class="fsbtn" type="button" title="full screen — rotate for landscape" aria-label="toggle full screen" onclick="document.body.classList.toggle('devfs')">${ICO.maximize}</button>`
    : '';
  const stage = `<div class="devstage${stageObj.fill ? ' live' : ''}">${fsBtn}${stageObj.html}</div>`;
  const bodyClass = (droidSt.state === 'live' || watchUp) ? 'watchlive' : '';
  const head = droidSt.state === 'booting' ? '<meta http-equiv="refresh" content="4">' : '';
  const body = `<h1><a href="/">mows</a> <span class="muted">· device</span></h1>
<div class="devlayout">${rail}${stage}</div>
${script}`;
  send(req, res, 200, page('device · mows sessions', body, head, bodyClass, 'device', false, null, req.headers.host));
}

function recForm(rec) {
  const rows = rec.scan.filter(t => t.b > 0 || t.extra);
  const safe = rows.filter(t => !t.g).reduce((s, t) => s + t.b, 0);
  const row = t => `<label class="rrow"><input type="checkbox" name="t" value="${t.id}"${t.g ? '' : ' checked'}>
<span class="rl">${esc(t.label)}</span><b>${HB(t.b)}</b>
<span class="muted">${esc(t.extra ? t.extra + ' · ' + t.note : t.note)}</span></label>`;
  return `<div class="statgrid"><div class="stat wide"><span class="sl">reclaim · measured just now</span>
<form class="rf" method="post" action="/sys/reclaim"><input type="hidden" name="back" value="${esc(rec.back || '')}">
${rows.length ? rows.map(row).join('') : '<div class="mlist muted">nothing to reclaim — every cache here is already empty</div>'}
${rows.length ? `<div class="rrow tot"><span class="rl">checked by default</span><b>${HB(safe)}</b><button class="ab danger">${ICO.trash}Reclaim Selected</button></div>
<div class="mlist muted">runs as root · no undo. memory and cpu are missing on purpose: the mem bar above already
excludes the page cache, so there is nothing there to free, and the load is your own sessions.</div>` : ''}
</form></div></div>`;
}

function sysPanel(fhref, open, rec, flat, extra) {
  const h = hostInfo(), u = usage();
  const pct = (x, t) => t ? Math.min(100, Math.round(x / t * 100)) : 0;
  const meter = (p, hot) => `<span class="meter"><i style="width:${Math.min(100, Math.max(0, p))}%${p >= (hot == null ? 101 : hot) ? ';background:var(--bad)' : p >= 50 ? ';background:var(--warn)' : ''}"></i></span>`;
  const money = n => '$' + (n >= 100 ? Math.round(n).toLocaleString('en-US') : n.toFixed(2));
  const days = Math.floor(h.up / 86400), hrs = Math.floor(h.up % 86400 / 3600);
  const cards = `<div class="statgrid">
<div class="stat"><span class="sl">load</span><b class="sv">${h.load.toFixed(2)}</b> <span class="muted">/ ${h.cores} cores</span>${meter(pct(h.load, h.cores), 90)}</div>
<div class="stat"><span class="sl">memory</span><b class="sv">${GB(h.memUsed)}</b> <span class="muted">/ ${GB(h.memTot)} G</span>${meter(pct(h.memUsed, h.memTot), 90)}</div>
<div class="stat"><span class="sl">swap</span><b class="sv">${GB(h.swapUsed)}</b> <span class="muted">/ ${GB(h.swapTot)} G</span>${meter(pct(h.swapUsed, h.swapTot), 90)}</div>
<div class="stat"><span class="sl">disk /</span><b class="sv">${GB(h.dskUsed)}</b> <span class="muted">/ ${GB(h.dskTot)} G</span>${meter(pct(h.dskUsed, h.dskTot), 90)}</div>
<div class="stat"><span class="sl">uptime</span><b class="sv">${days}d ${hrs}h</b></div></div>`;
  let ubody;
  if (!u) ubody = `<p class="muted" style="padding:4px 0 8px">collecting usage — first pass takes ~15 s, refresh in a moment…</p>`;
  else {
    const acards = Object.values(u.accts).map(a => {
      const q = u.quota[a.qkey] || u.quota[a.label] || {};
      const qrow = (lbl, v) => `<div class="qrow"><span>${lbl}</span>${meter(v == null ? 0 : v, u.thr)}<b>${v == null ? '?' : v + '%'}</b></div>`;
      let spend, breakdown = '';
      if (!a.cc) spend = `<div class="mlist muted">ccusage not installed — sudo npm i -g ccusage</div>`;
      else {
        spend = `<div class="qrow"><span>today</span><b>${money(a.today)}</b><span class="muted">· week ${money(a.week)} · month ${money(a.month)}</span></div>
${a.block ? `<div class="qrow"><span>5h block</span><b>${money(a.block.cost)}</b><span class="muted">· ${money(a.block.rate)}/h burn</span></div>` : ''}
<div class="mlist${a.models.length ? '' : ' muted'}">${a.models.length ? a.models.map(m => `${esc(mshort(m.name))} ${money(m.cost)}`).join(' · ') : 'no usage today'}</div>`;
        breakdown = `<details class="ubd"><summary>full breakdown · 7 days</summary>
<span class="sl" style="padding-top:8px">per day</span>
${a.days.length ? a.days.map(r => `<div class="qrow"><span>${esc(r.d.slice(5))}</span><b>${money(r.cost)}</b><span class="muted mlist" style="padding:0">${r.models.map(esc).join(', ')}</span></div>`).join('') : '<div class="mlist muted">no usage this week</div>'}
<span class="sl" style="padding-top:8px">sessions · lifetime spend</span>
${a.sess.length ? a.sess.map(t => `<div class="qrow"><a class="sid8" href="/s/${a.id}/${esc(t.sid)}">${esc(t.sid.slice(0, 8))}</a><b>${money(t.cost)}</b><span class="muted mlist" style="padding:0">${t.models.map(esc).join(', ')}</span></div>`).join('') : '<div class="mlist muted">none this week</div>'}
</details>`;
      }
      return `<div class="stat"><span class="sl">${esc(a.label)} · limits</span>${qrow('5h', q.h5)}${qrow('week', q.wk)}
<div class="mlist muted">${a.tokExp && a.tokExp < Date.now() && q.h5 == null ? `oauth token expired ${rel(a.tokExp)} ago — open any ${esc(a.label)} session and it refreshes` : `threshold ${u.thr}%`}</div></div>
<div class="stat"><span class="sl">${esc(a.label)} · spend</span>${spend}${breakdown}</div>`;
    }).join('');
    ubody = `<div class="statgrid u">${acards}</div>`;
  }
  const sumToday = u ? Object.values(u.accts).reduce((s, a) => s + a.today, 0) : null;
  const age = usageCache.t ? (rel(usageCache.t) === 'now' ? 'now' : rel(usageCache.t) + ' ago') : '—';
  const rchip = rec ? `<a class="chip" href="${esc(rec.href)}">${rec.scan ? ICO.x + 'Close' : ICO.trash + 'Reclaim'}</a>` : '';
  const rflash = rec && rec.freed != null
    ? `<span class="chip ok">reclaimed <b>${HB(rec.freed)}</b> · ${rec.n} target${rec.n === 1 ? '' : 's'}</span>` : '';
  const urow = `<div class="bar"><span class="chip">usage updated <b>${age}</b>${usageCache.busy ? ' · refreshing…' : ''}</span><a class="chip" href="${fhref || '/?fresh=1'}">${ICO.refresh}Refresh</a>${rchip}${rflash}</div>`;
  const rblk = rec && rec.scan ? recForm(rec) : '';
  // flat: /system's own dedicated page — always expanded, no <details>/summary collapse
  // (the page's h1 already says "system", so no repeated header line here).
  // figma-make System view (node 36:852): two 464px columns (Metrics | Environment +
  // Terminal), pixel spec below; everything the OLD flat panel showed (per-account
  // limits/spend, disk reclaim) survives underneath in .sysextra — the
  // addendum's 3-card anatomy has no slot for it, but the hard rule is "never remove
  // functionality", so it keeps the same cards/classes, just re-headed to read as part
  // of this page instead of a collapsible strip.
  if (flat) {
    const ex = extra || {};
    const loadPct = pct(h.load, h.cores), loadWarn = h.load > h.cores;
    const memPct = pct(h.memUsed, h.memTot), memWarn = memPct > 85;
    const swapPct = h.swapTot ? pct(h.swapUsed, h.swapTot) : 0, swapWarn = swapPct > 85;
    const diskPct = pct(h.dskUsed, h.dskTot), diskWarn = diskPct > 85;
    const bar = (label, val, p, warn) => `<div class="mbar">
<div class="mbar-row"><span class="mbar-label">${esc(label)}</span><b class="mbar-pct">${Math.round(Math.min(100, Math.max(0, p)))}%</b><span class="mbar-val">${esc(val)}</span></div>
<div class="mbar-track"><div class="mbar-fill${warn ? ' warn' : ''}" style="width:${Math.min(100, Math.max(0, p))}%"></div></div>
</div>`;
    const metricsHtml = `<section class="sysleft">
<div class="sechead"><h2>Metrics</h2><p>Live utilization of host resources.</p></div>
<div class="mbars">
${bar('Load average', `${h.load.toFixed(2)} / ${h.cores} cores`, loadPct, loadWarn)}
${bar('Memory', `${GB(h.memUsed)} / ${GB(h.memTot)} G`, memPct, memWarn)}
${bar('Swap', h.swapTot ? `${GB(h.swapUsed)} / ${GB(h.swapTot)} G` : 'not configured', swapPct, swapWarn)}
${bar('Disk /', `${GB(h.dskUsed)} / ${GB(h.dskTot)} G`, diskPct, diskWarn)}
</div></section>`;

    const ver = ex.ver || '?';
    const deployTxt = ex.deployMt ? (rel(ex.deployMt) === 'now' ? 'just now' : `${rel(ex.deployMt)} ago`) : '?';
    const deployTitle = ex.deployMt ? abs(ex.deployMt) : '';
    const erow = (k, v, cls) => `<div class="envrow"><span class="envkey">${esc(k)}</span><span class="envval${cls ? ' ' + cls : ''}">${v}</span></div>`;
    const envHtml = `<section class="sysright-item">
<div class="sechead"><h2>Environment</h2><p>System configuration and status.</p></div>
<div class="envcard"><div class="envrows">
${erow('STATUS', '<span class="edot"></span>ONLINE', 'ok')}
${erow('VERSION', esc(ver))}
<div class="envdiv"></div>
${erow('UPTIME', `${days}d ${hrs}h`)}
${erow('LAST_DEPLOY', `<span title="${esc(deployTitle)}">${esc(deployTxt)}</span>`)}
<div class="envdiv"></div>
${erow('NODE', esc(process.version))}
${erow('OS', esc(`${os.platform()}/${os.arch()}`))}
</div></div></section>`;

    // Terminal card: no 3-option setting exists anywhere in this app (the terminal theme
    // is picked per-browser from the /term key bar; the global default is settings.json,
    // served at /settings/term-theme.json, POST /settings/term-theme — no dashboard UI) —
    // per spec that means the TERMINAL THEME block is omitted rather than faked into a
    // 3-button grid. The danger button maps to the one real host-wide destructive action
    // that already exists with its own confirm: /a/restartall ("restart every live
    // session"), which already lives on /device — reused here verbatim (same endpoint,
    // same confirm copy), not a new endpoint.
    const live = ex.live || [];
    const liveN = live.length;
    const ICO_RESTART = `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M21 12a9 9 0 1 1-3-6.7"/><path d="M21 3v6h-6"/></svg>`;
    const restartCtl = liveN
      ? `<details class="kx"><summary class="dangerbtn">${ICO_RESTART}Restart All Sessions${liveN > 1 ? ` (${liveN})` : ''}</summary><div class="kc"><div>restart all <b>${liveN}</b> live session${liveN > 1 ? 's' : ''}?</div><span class="muted">whatever is running right now is killed — including the session you are reading this from.</span><form class="af" method="post" action="/a/restartall"><input type="hidden" name="back" value="/system"><button class="ab danger">Restart Them</button></form></div></details>`
      : `<div class="dangerbtn off" aria-disabled="true">${ICO_RESTART}restart all sessions</div>`;
    const rsChip = ex.rsN ? `<span class="chip on"><span class="dot" style="background:var(--ok)"></span>restarted ${ex.rsN}</span>` : '';
    const termHtml = `<section class="sysright-item">
<div class="sechead"><h2>Terminal</h2><p>Master process and theming.</p></div>
<div class="termcard set">
<div class="seclabel">Master process</div>
${restartCtl}
<p class="dangercap">${liveN ? 'Restarts every live terminal session on this host — including the one you’re reading this from. Transcripts stay on disk; nothing is deleted.' : 'No live sessions right now — nothing to restart.'}</p>
${rsChip}
</div></section>`;

    const grid = `<div class="sysgrid">${metricsHtml}<div class="sysright">${envHtml}${termHtml}</div></div>`;
    const extraHtml = `<div class="sysextra"><div class="sechead"><h2>Usage &amp; Reclaim</h2><p>Claude account limits, daily spend, and disk reclaim.</p></div>
${urow}${rblk}${ubody}</div>`;
    return `<div class="sysview">${grid}${extraHtml}</div>`;
  }
  return `<details class="sys"${open ? ' open' : ''}><summary><span class="syst">📊 system</span><span class="syss">load <b>${h.load.toFixed(2)}</b> · mem <b>${GB(h.memUsed)}/${GB(h.memTot)}G</b> · disk <b>${GB(h.dskUsed)}/${GB(h.dskTot)}G</b> · up <b>${days}d</b>${sumToday == null ? '' : ` · today <b>${money(sumToday)}</b>`}</span></summary>
<div class="sysbody">${cards}${urow}${rblk}${ubody}</div></details>`;
}


// ---------- html helpers ----------
const esc = s => String(s).replace(/[&<>"']/g, c =>
  ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

const fmtSz = n => n < 1024 ? n + 'B' : n < 1048576 ? (n / 1024 | 0) + 'K'
  : (n / 1048576).toFixed(1) + 'M';

const rel = ms => { const s = (Date.now() - ms) / 1000;
  return s < 90 ? 'now' : s < 5400 ? (s / 60 | 0) + 'm' : s < 129600 ? (s / 3600 | 0) + 'h' : (s / 86400 | 0) + 'd'; };

const dayLbl = ms => { const d = new Date(ms).toISOString().slice(0, 10);
  const t = new Date().toISOString().slice(0, 10), y = new Date(Date.now() - 86400e3).toISOString().slice(0, 10);
  return d === t ? 'today' : d === y ? 'yesterday' : new Date(ms).toUTCString().slice(5, 16); };

// pause/resume + kill (with no-JS <details> confirm) for one live tmux session
function actForms(l, back) {
  const f = (act, label, cls) => `<form class="af" method="post" action="/a/${act}"><input type="hidden" name="name" value="${esc(l.name)}"><input type="hidden" name="back" value="${esc(back)}"><button class="ab${cls ? ' ' + cls : ''}">${label}</button></form>`;
  return (l.paused ? f('resume', ICO.play + 'Resume', 'ok') : f('pause', ICO.pause + 'Pause'))
    + `<details class="kx" name="am"><summary class="ab" title="name this session">${ICO.pencil}</summary><div class="kc"><form class="af lf" method="post" action="/a/label"><input type="hidden" name="name" value="${esc(l.name)}"><input type="hidden" name="back" value="${esc(back)}"><span class="klbl">Rename</span><input class="li2" name="label" value="${esc(l.label || '')}" maxlength="60" placeholder="session name" aria-label="session name"><button class="ab ok">Save</button></form></div></details>`
    + `<details class="kx" name="am"><summary class="ab danger">${ICO.x}Kill</summary><div class="kc"><div>stop <b>${esc(l.name)}</b>?</div><span class="muted">the process ends now — the transcript stays on disk, resume anytime.</span>${f('kill', 'Kill It', 'danger')}</div></details>`;
}

const abs = t => t ? new Date(t).toISOString().slice(0, 16).replace('T', ' ') + 'Z' : '—';

// shadcn design system (dark, zinc + emerald), applied 2026-07-13: token layer
// below, component recipes after. Same markup/classes; sans UI + mono data.
const CSS = `
:root{color-scheme:dark;
/* mows-control token layer (figma-make reskin, 2026-08-29): exact spec palette —
   zinc bg/surfaces + emerald accent. Component CSS below reads these vars, so this
   block is the single place the whole app's look shifts from. */
--bg:#09090b;--card:rgba(24,24,27,.3);--card2:#18181b;--pop:#27272a;
--navbg:rgba(24,24,27,.6);--navbd:rgba(39,39,42,.8);
--fg:#f4f4f5;--fg2:#d4d4d8;--title:#e4e4e7;--mut:#9f9fa9;--dim:#71717b;--dimmer:#52525c;
--bd:rgba(39,39,42,.6);--bd2:rgba(39,39,42,.8);--hair:#18181b;
--ring:rgba(161,161,170,.8);
--ok:#00d492;--ok-bg:rgba(0,212,146,.1);--ok-bd:rgba(0,212,146,.2);
--ok-lt:#5ee9b5;--ok-dk:#00bc7d;--bd3:#3f3f47;
--warn:#ffb900;--bad:#ff6467;
--r:10px;--r-lg:16px;
--sans:'Inter',-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,'Helvetica Neue',Arial,sans-serif;
--mono:'JetBrains Mono',ui-monospace,SFMono-Regular,Menlo,Consolas,monospace}
/* Vendored latin-subset variable faces (infra/dashboard/app/vendor/*.woff2, hash-pinned in
   SHA256SUMS like every other vendored file). One file per family covers 400-700 — do not
   add static faces. font-display:swap so a slow font never blanks the page, and the system
   stacks above stay as the fallback, which is exactly what shipped before this change. */
@font-face{font-family:'Inter';font-style:normal;font-weight:400 700;font-display:swap;
src:url(FONT_INTER) format('woff2')}
@font-face{font-family:'JetBrains Mono';font-style:normal;font-weight:400 700;font-display:swap;
src:url(FONT_MONO) format('woff2')}
*{margin:0;padding:0;box-sizing:border-box;-webkit-tap-highlight-color:transparent}
html{background:var(--bg)}
body{background:var(--bg);color:var(--fg);font:14px/1.5 var(--sans);padding:12px;max-width:1100px;margin:0 auto;position:relative}
/* desktop content column (spec: max-width 1024, 48px page padding) — mobile keeps its
   own tighter padding via the max-width:700px block below. */
@media(min-width:701px){body{max-width:1024px;padding:48px}
/* a live device stream deserves the whole monitor, not the 1024px reading column */
body.watchlive{max-width:1720px}
/* the new .hdr replaces the mobile compact <h1> on desktop; every view's body string
   still starts with <h1> for the mobile header, so a plain child selector hides it here
   without touching each view. */
body>h1{display:none}}
a,button,summary,input{touch-action:manipulation}
a{color:inherit;text-decoration:none}
:is(a,button,summary,input):focus-visible{outline:2px solid var(--ring);outline-offset:2px;border-radius:6px}
@media(prefers-reduced-motion:no-preference){a,button,summary{transition:background-color .15s,border-color .15s,color .15s}}
.tabs{display:none}
h1{font-size:16px;font-weight:650;letter-spacing:-.01em;padding:4px 0 12px;display:flex;align-items:center;gap:9px;flex-wrap:wrap}
h1::before{content:'>_';color:var(--ok);font:700 12px/1 var(--mono);background:var(--ok-bg);border:1px solid var(--ok-bd);padding:6px 7px;border-radius:9px}
h1 a{color:var(--fg)}
h1 .muted{font-weight:400;font-size:13px}
.bar{display:flex;flex-wrap:wrap;gap:6px;align-items:center;padding:2px 0 10px}
.chip{display:inline-flex;align-items:center;gap:6px;border:1px solid var(--bd);background:var(--card);border-radius:999px;padding:5px 12px;min-height:30px;color:var(--mut);white-space:nowrap;font-size:13px}
a.chip:hover{background:var(--card2);border-color:var(--bd2);color:var(--fg2)}
.chip.on{border-color:var(--ok-bd);color:var(--fg);background:var(--ok-bg)}
/* .sel is the neutral "this filter pill is selected" state (account/time-range chips in
   /history) — mirrors .pnav a.on. .on stays reserved for a genuinely live/positive state
   (the "live N" chip, browser/emulator status, restart count). */
.chip.sel{background:var(--pop);border-color:var(--bd2);color:var(--fg)}
.chip b{font-weight:600;font-variant-numeric:tabular-nums}
.dot{width:7px;height:7px;border-radius:50%;display:inline-block;flex-shrink:0}
input[type=search]{background:rgba(255,255,255,.04);border:1px solid var(--bd2);border-radius:var(--r);color:var(--fg);padding:6px 12px;font:13px var(--sans);width:190px;min-height:34px}
input[type=search]::placeholder{color:var(--dim)}
button{background:var(--card2);border:1px solid var(--bd);border-radius:var(--r);color:var(--fg2);padding:6px 12px;font:13px var(--sans);min-height:34px;cursor:pointer}
button:hover{background:var(--pop);border-color:var(--bd2)}
.lp{background:var(--card);border:1px solid var(--bd);border-radius:var(--r-lg);padding:10px 12px;margin:4px 0 14px;display:flex;flex-direction:column;gap:10px;min-width:0;max-width:100%}
.lr{display:flex;flex-wrap:wrap;gap:6px 10px;align-items:center;min-height:36px}
/* settings groups: every top-level group gets a .sect label, so a group's own
   sub-parts (the live preview) can't read as a sibling group of their own. */
.sect{font:600 11px var(--sans);color:var(--dim);text-transform:uppercase;letter-spacing:.08em;margin:22px 4px 8px}
.sect:first-of-type{margin-top:6px}
.cardh{font-weight:600;font-size:14px;color:var(--fg)}
.subl{font-size:12px;color:var(--dim);margin:2px 0 -4px}
.ln a,.ln span{color:var(--ok);font:600 13px var(--mono)}
.la{display:flex;gap:6px;align-items:center;margin-left:auto;flex-wrap:wrap}
.lt{flex-basis:100%;margin:-2px 0 0 18px;font-size:12px;color:var(--mut);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.lb{font:600 14px var(--sans);color:var(--fg)}
.af.lf{display:flex;gap:8px;align-items:center}
/* a text FIELD, not a pill: tighter radius than the buttons, visible outline, inset well,
   and the .klbl micro-label above it — the trio is what reads as "type here". */
.li2{background:rgba(9,9,11,.7);border:1px solid #3f3f47;border-radius:6px;color:var(--fg);padding:6px 10px;font:13px var(--sans);flex:1;min-width:0;min-height:32px;box-shadow:inset 0 1px 2px rgba(0,0,0,.4)}
.li2::placeholder{color:var(--dimmer)}
.li2:focus{outline:none;border-color:#71717b;background:rgba(9,9,11,.9)}
.klbl{width:100%;font:700 10px var(--sans);color:var(--dimmer);letter-spacing:.1em;text-transform:uppercase;line-height:1}
.af{display:inline;margin:0}
.ab{display:inline-flex;align-items:center;gap:5px;border:1px solid var(--bd);border-radius:var(--r);padding:5px 12px;min-height:34px;background:var(--card2);color:var(--fg2);font:13px var(--sans);cursor:pointer;list-style:none}
/* inline lucide icons: size per context (ICO svgs default to 16px attrs) */
.ab svg,.chip svg,.dx svg{width:14px;height:14px;flex-shrink:0}
.ti svg{width:20px;height:20px}
.termfab svg{width:22px;height:22px}
.hnew svg{width:16px;height:16px}
.pg a svg,.pg .off svg{width:16px;height:16px}
.syst svg{width:14px;height:14px;vertical-align:-2px;margin-right:6px}
.fico svg{width:14px;height:14px;display:block}
.ab:hover{background:var(--pop);border-color:var(--bd2)}
.ab.danger{color:var(--bad)}
.ab.danger:hover{background:rgba(248,113,113,.1);border-color:rgba(248,113,113,.35)}
.ab.ok{color:var(--ok)}
.ab.ok:hover{background:var(--ok-bg);border-color:var(--ok-bd)}
/* mobile fleet card attach: ghost it (text only, no border/bg) so it reads as a trailing
   action instead of a second boxed control — card's weight stays on title/snippet. Scoped
   to #fleet-cards so settings/live-session .lp .ab.ok buttons keep their normal chrome. */
.fleet-cards .ab.ok{background:transparent;border-color:transparent}
.fleet-cards .ab.ok:hover{background:transparent;border-color:transparent}
.kx{position:relative;margin:0}
.kx summary::-webkit-details-marker{display:none}
.kc{position:absolute;right:0;top:42px;z-index:9;background:var(--pop);border:1px solid var(--bd2);border-radius:var(--r-lg);padding:12px;width:250px;display:flex;flex-direction:column;gap:10px;box-shadow:0 12px 32px rgba(0,0,0,.55);font-size:13px}
/* dropdown menu anatomy (2026-08-29): hairline-divided header and danger zone, full-width
   left-aligned action rows — the panel reads as a menu, not a pile of pills. */
.kc .tname{padding-bottom:10px;border-bottom:1px solid var(--bd)}
.kc form.af{width:100%;display:flex}
.kc .af .ab{width:100%;justify-content:flex-start}
.kc .af.lf{flex-wrap:wrap;gap:6px 8px;align-items:center}
.kc .af.lf .ab{width:auto;flex-shrink:0}
.kc > .kx{width:100%;padding-top:10px;border-top:1px solid var(--bd)}
.kc > .kx .ab{width:100%;justify-content:flex-start}
.day{color:var(--dimmer);font:700 12px/1 var(--sans);padding:0 8px;margin:32px 0 12px;text-transform:uppercase;letter-spacing:.6px}
.day:first-child{margin-top:0}
.li{display:flex;align-items:stretch;border-bottom:1px solid var(--hair)}
.li:hover,.li:active{background:var(--card)}
.row{flex:1;display:flex;flex-wrap:wrap;gap:4px 16px;align-items:center;padding:10px 6px;min-height:46px;min-width:0}
/* mock's history rows are a denser, more table-like list than the 46px default —
   tighten on desktop only; mobile keeps the roomier touch-target height. */
@media(min-width:701px){.row{padding:8px 12px;min-height:36px}}
.t{color:var(--dimmer);width:32px;flex-shrink:0;font:12px var(--mono);font-variant-numeric:tabular-nums}
.acct{font:700 12px var(--sans);flex-shrink:0}
.proj{font:400 14px var(--mono);color:var(--mut);overflow:hidden;text-overflow:ellipsis;white-space:nowrap;max-width:50%}
.ttl{color:var(--title);flex:1;min-width:130px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.sz{color:var(--dimmer);font:12px var(--mono);font-variant-numeric:tabular-nums;flex-shrink:0}
.sid{color:var(--dim);font:12px var(--mono);flex-shrink:0}
.go{display:flex;align-items:center;padding:0 14px;color:var(--ok);border-left:1px solid var(--hair);font:700 13px var(--mono)}
.go:hover{background:var(--ok-bg)}
/* .kc is a right-anchored popover, which works where it hangs off a button at the RIGHT
   edge of a wide session row. A settings card puts its button at the LEFT edge, so right:0
   threw a 250px panel to x=-116 on a phone — off-screen. In cards the confirm opens INLINE
   instead: it's a <details> disclosure, the column is full-width, and it cannot overflow. */
.set .kc{position:static;width:auto;background:var(--card2);box-shadow:none;margin-top:2px}
/* fleet (Fleet Redesign §2): adaptive at the same 700px breakpoint everywhere else in
   this file — dense .li/.row rows on desktop, .lp cards on phones. Same markup always
   renders; the media query below picks which block is visible, same trick .tabs/.navdup
   already use. fleet-rows reuses .li/.row (border+hairline list, like the history rows);
   fleet-cards reuses .lp (the settings/live-session card token). */
.fleet-rows{background:transparent;border:none;display:flex;flex-direction:column;gap:12px;margin:4px 0 18px}
/* spec Sessions card: bg/border/radius16 from the token layer, padding16, title(fr1)
   line + a snippet line 4px below; status word at the right edge of fr1; .fr2 dim mono
   snippet + project bottom-right. .hlist (history) keeps the dense hairline-list look. */
.fleet-rows .li{background:var(--card);border:1px solid var(--bd);border-radius:16px;padding:16px}
.frow{flex:1;display:flex;flex-direction:column;gap:4px;min-width:0}
.fr1{display:flex;align-items:center;gap:10px;min-width:0}
.fr1 .lb{font:400 16px/24px var(--sans);color:var(--fg);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.fst{font:400 12px/16px var(--mono);color:var(--dim);flex-shrink:0;margin-left:2px}
.fact{display:flex;align-items:center;gap:4px;margin-left:auto;flex-shrink:0}
.fact .go{border:1px solid var(--bd);border-radius:8px;padding:5px 10px;min-height:30px}
@media(pointer:fine){.fact{opacity:0;transition:opacity .15s}
.fleet-rows .li:hover .fact,.fleet-rows .li:focus-within .fact,.fact:has(details[open]){opacity:1}}
.fr1 .proj{max-width:28%;margin-top:2px;color:var(--dimmer);font-size:12px}
/* spec: "the state glyph may be dropped or kept tiny-dim — status word now carries the
   color" — shrink it to a quiet marker in the row layout only (cards keep it as-is). */
.fleet-rows .fli{font-size:10px;opacity:.55}
.fleet-cards{display:none}
.fleet-cards .lp{background:var(--card);gap:6px;padding:16px}
.fchd{flex-wrap:nowrap}
.fcact{display:flex;align-items:center;gap:2px;flex-shrink:0;min-width:0}
/* fleet.js empties a container by removing its last child (session ended) or fills it by
   appending one (session appeared) — :empty hides the bordered box with no JS bookkeeping. */
.fleet-rows:empty,.fleet-cards:empty{display:none}
/* mock's dashed "new session" affordance under the fleet — mapped to the existing
   terminal picker, not a new spawn-agent feature (still out of scope). */
.newcard{display:flex;align-items:center;justify-content:center;gap:8px;border:1px dashed var(--bd2);border-radius:var(--r-lg);padding:18px;margin:4px 0 18px;color:var(--mut);font-size:13px}
.newcard:hover{color:var(--fg2);border-color:var(--bd2);background:var(--card)}
.fli{font:14px/1 var(--mono);width:16px;flex-shrink:0;text-align:center}
.fli-needs-you,.fli-paused{color:var(--warn)}
.fli-working{color:var(--ok)}
.fli-idle{color:var(--dim)}
/* keyboard-nav badges (Fleet Redesign §3 phase 3): fleet.js's keydown handler sends
   digit 1-9 to the nth fleet row's attach link; these are the on-screen hint for that.
   Desktop-only affordance — hidden on touch even at a wide viewport (a landscape tablet
   has no keyboard to act on the hint), same pointer:fine reasoning the data-nw window-reuse
   script uses below. fleet-rows is already display:none under 700px so the width half of
   this gate is redundant there, kept explicit for a wide touch device that still renders
   the row layout. */
.fnum{display:none}
@media(min-width:700px) and (pointer:fine){.fnum{display:inline-flex;align-items:center;justify-content:center;width:14px;height:14px;flex-shrink:0;font:10px var(--mono);color:var(--dim);border:1px solid var(--bd);border-radius:3px;margin-right:1px}}
/* card variant (white-space:normal inline override in fleetCardHtml) wraps at spaces by
   default, but a snippet pulled from a transcript tail can contain one long unbreakable
   run (a path, a URL, a command with no spaces) — without overflow-wrap that run forces
   .lp/.fleet-cards wider than the viewport (925px measured at 390px), a horizontal-scroll
   regression. min-width:0 lets the flex item (.lp's column-flex child) actually shrink to
   the card's width instead of sizing to its own min-content. */
.fsnip{color:var(--dim);overflow:hidden;text-overflow:ellipsis;white-space:nowrap;overflow-wrap:anywhere;word-break:break-word;min-width:0;max-width:100%}
.tname{font:12px var(--mono);color:var(--dim);word-break:break-all}
/* the ⋯ menu on a phone card floats like the desktop popover (base .kc: absolute,
   right-anchored off the button) instead of inlining and growing the card (user request
   2026-08-29). The 250px panel fits right-aligned even at 320px (8px page + 16px card
   padding leaves 46px slack); the max-width is a guard for anything narrower. */
.fleet-cards .kc{max-width:calc(100vw - 48px);z-index:30}
/* whole card = tap target on phones (user request 2026-08-29): stretch the attach link's
   hit area over the card (stretched-link ::after); the ⋯ menu stacks above so it stays
   its own tap. :active repaint gives the tap visible feedback. */
.fleet-cards .lp{position:relative}
.fleet-cards [data-f=attach]::after{content:'';position:absolute;inset:0;border-radius:var(--r-lg)}
.fleet-cards .kx{z-index:2}
/* the open menu must paint over the NEXT card's controls too — the .kc's own z-index:30 is
   capped by its .kx stacking context (z:2), which later siblings (also z:2) beat by DOM order */
.fleet-cards .kx[open]{z-index:31}
.fleet-cards .lp:has([data-f=attach]:active){background:var(--card2)}
/* figma-make reskin (2026-08-29): full desktop header (logo+title, centered pill nav,
   "+ new session" button), LIVE pill, hover-revealed row actions, recessed snippets,
   state-colored status words. Mobile keeps its compact <h1> + bottom tab bar — .hdr
   carries .navdup so the <700px rule (below) hides it exactly like the old pill nav did. */
.hdr{display:flex;align-items:center;justify-content:space-between;gap:16px;height:50px;margin:0 0 48px}
.hdl{display:flex;align-items:center;gap:16px;min-width:0}
.hlogo{width:32px;height:32px;flex-shrink:0;border-radius:8px;background:var(--fg);color:var(--bg);display:flex;align-items:center;justify-content:center;font:700 18px/1 var(--mono)}
.hcol{min-width:0}
.htitle{font:500 16px/1.2 var(--sans);color:var(--fg);letter-spacing:-.4px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.hsub{font:12px var(--mono);color:var(--mut);opacity:.6;margin-top:2px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.hnew{display:inline-flex;align-items:center;gap:8px;flex-shrink:0;background:var(--fg);color:var(--bg);padding:10px 20px;border-radius:999px;font:500 14px var(--sans);white-space:nowrap}
.hnew:hover{background:#e4e4e7}
.pnav{display:inline-flex;gap:2px;background:var(--navbg);border:1px solid var(--navbd);border-radius:999px;padding:6px;height:50px;box-sizing:border-box;flex-shrink:0}
.pnav a{padding:8px 20px;border-radius:999px;color:var(--mut);font:500 14px var(--sans);display:inline-flex;align-items:center;gap:6px;white-space:nowrap}
.pnav a:hover{color:var(--fg2);background:var(--card2)}
.pnav a.on{background:var(--pop);color:var(--fg);box-shadow:0 1px 3px rgba(0,0,0,.4)}
.pbdg{background:var(--bg);border-radius:999px;padding:2px 6px;font:500 12px/1 var(--mono);color:#d4d4d8}
/* tablet gap (701-920px, e.g. 768/844/900): .pnav + .hnew hold fixed content width and
   .hdl is the only shrinkable flex child, so it was absorbing the whole deficit and
   ellipsis-truncating both title and subtitle. Reclaim the width instead of shrinking
   text: drop the subtitle and collapse "+ New Session" to an icon-only button — same
   two moves the mobile <700px layout already makes (compact header, icon-first nav). */
@media(max-width:920px){.hsub{display:none}.hnew{padding:10px;gap:0}.hnew-lbl{display:none}}
/* persistent terminal FAB (gap #5): reachable at every width without inflating the 4-tab nav */
.termfab{position:fixed;right:14px;bottom:calc(70px + env(safe-area-inset-bottom,0px));z-index:21;width:46px;height:46px;border-radius:50%;background:var(--ok);color:#052018;display:flex;align-items:center;justify-content:center;font-size:19px;box-shadow:0 6px 18px rgba(0,0,0,.45)}
.termfab:hover{background:#4ade9e}
@media(min-width:701px){.termfab{bottom:14px}}
body.watchlive .termfab{display:none}
/* pull-to-refresh chip — created by the base page script in the installed app only (every
   page, not just fleetJs ones); hidden above the
   viewport until the pull drags it in (transform is JS-driven, so only opacity animates) */
#ptr{position:fixed;left:50%;top:calc(env(safe-area-inset-top,0px) - 44px);z-index:25;width:36px;height:36px;border-radius:50%;background:var(--pop);border:1px solid var(--bd2);box-shadow:0 6px 18px rgba(0,0,0,.45);display:flex;align-items:center;justify-content:center;color:var(--mut);opacity:0;pointer-events:none;transition:opacity .12s}
#ptr.go{color:var(--ok)}
#ptr svg{width:16px;height:16px}
#ptr.spin svg{animation:ptrspin .7s linear infinite}
@keyframes ptrspin{to{transform:rotate(360deg)}}
/* spec LIVE badge: tinted pill (bg = accent @10%), a real 6px dot (reuses the .dot
   token, not a text glyph) + tracked-out label — not a bare colored word. */
.lvb{display:inline-flex;align-items:center;gap:6px;color:var(--ok);background:var(--ok-bg);border:none;border-radius:4px;font:500 12px/1 var(--sans);letter-spacing:.3px;padding:2px 6px;margin-right:2px;vertical-align:1px}
.lvbd{width:6px;height:6px;border-radius:50%;background:var(--ok);opacity:.68;animation:lvpulse 1.6s ease-in-out infinite}
@keyframes lvpulse{0%,100%{opacity:.68}50%{opacity:.3}}
/* history/today rows: actions appear on hover (mock) — pointer:fine only, touch keeps
   them always visible; focus-within + [open] keep keyboard nav and open confirms shown */
@media(pointer:fine){
.hlist .go,.hlist .kx.del{opacity:0;transition:opacity .15s}
.hlist .li:hover :is(.go,.dx),.hlist .li:focus-within :is(.go,.dx),.hlist .li:hover .kx.del,.hlist .li:focus-within .kx.del,.hlist .kx.del[open]{opacity:1}
}
/* spec: history rows carry a hairline only on the FIRST row of each day group (the
   .day header's very next sibling); the rest of a group's rows are borderless. */
.hlist .li{border-bottom:none;border-left:2px solid transparent}
.hlist .day+.li{border-left-color:var(--hair);border-bottom:1px solid var(--hair)}
/* desktop snippet: plain dim mono line, exactly like the mock's card subtitle */
.fleet-rows .fsnip{font:14px/20px var(--mono);color:var(--dim)}
.fleet-cards .fsnip{font:12px var(--mono)}
/* status word takes the state color (glyph already does via .fli-*) */
[data-state=needs-you] .ttl[data-f=meta],[data-state=needs-you] span[data-f=meta]{color:var(--warn)}
[data-state=working] .ttl[data-f=meta],[data-state=working] span[data-f=meta]{color:var(--ok)}
[data-state=paused] .ttl[data-f=meta],[data-state=paused] span[data-f=meta]{color:var(--warn)}
.kx.del{display:flex;align-items:stretch}
.dx{display:flex;align-items:center;padding:0 13px;color:var(--dim);border-left:1px solid var(--hair);cursor:pointer;font-size:13px;min-height:44px}
.dx:hover{background:rgba(248,113,113,.08);color:var(--bad)}
/* spec pagination: four 32×32 icon buttons (no border), a mono "N / max" page readout,
   and a dim@60% trailing total — .pgnum/.pgtot below split what used to be one .cur span. */
.pg{display:flex;gap:16px;align-items:center;justify-content:center;padding:32px 0;flex-wrap:wrap;font:14px var(--mono)}
.pg a,.pg .off{display:inline-flex;align-items:center;justify-content:center;width:32px;height:32px;border-radius:8px;color:var(--mut);font-size:16px}
.pg a:hover{background:var(--card2);color:var(--fg)}
.pg .off{color:#3f3f46}
.pgnum{display:inline-flex;align-items:center;gap:4px}
.pg .cur{color:var(--fg);font-weight:400;font-variant-numeric:tabular-nums}
.pg .muted{color:var(--mut)}
.pgtot{color:var(--dim);opacity:.6}
.muted{color:var(--mut)}
.notitle{font-style:italic;color:var(--dimmer)}
.meta{background:var(--card);border:1px solid var(--bd);border-radius:var(--r-lg);padding:14px;margin:8px 0 14px;display:grid;grid-template-columns:auto 1fr;gap:6px 16px;word-break:break-all;font-size:13px}
.meta div:nth-child(odd){color:var(--dim)}
.meta div:nth-child(even){font:12.5px var(--mono)}
.btn{display:inline-flex;align-items:center;gap:8px;background:var(--ok);color:#052018;border-radius:var(--r);padding:9px 16px;font:650 14px var(--sans);min-height:42px}
.btn:hover{background:#4ade9e}
.m{background:var(--card);border:1px solid var(--bd);border-left-width:3px;border-radius:var(--r-lg);padding:10px 12px;margin:10px 0}
.m.user{border-left-color:#60a5fa}.m.claude{border-left-color:var(--ok)}
.mh{font:600 11px/1 var(--sans);color:var(--dim);padding-bottom:6px;text-transform:uppercase;letter-spacing:.06em}
.m.user .mh b{color:#60a5fa}.m.claude .mh b{color:var(--ok)}
pre{white-space:pre-wrap;word-break:break-word;font:13px/1.55 var(--mono)}
details{margin:8px 0}
summary{cursor:pointer;color:var(--mut);min-height:32px;display:flex;align-items:center;gap:6px;font-size:13px}
summary:hover{color:var(--fg2)}
details pre{background:#050506;border:1px solid var(--bd);border-radius:var(--r);padding:10px;margin-top:6px;font-size:12px;max-height:340px;overflow:auto}
.note{border:1px solid rgba(251,191,36,.35);background:rgba(251,191,36,.06);border-radius:var(--r);color:var(--warn);padding:9px 12px;margin:8px 0;font-size:13px}
/* device stage media (android iframe / noVNC iframe, node 36:651): a fixed-AR remote
   (16:9) that fills the dashed .devstage box at its own width — see the Device view
   CSS block below for .devstage/.stageempty. */
.vnc{width:100%;aspect-ratio:16/9;height:auto;max-height:100%;border:0;background:#000;display:block}
footer{padding:18px 0;color:var(--dim);display:flex;gap:14px;flex-wrap:wrap;font-size:12.5px}
footer a{color:var(--mut)}
footer a:hover{color:var(--fg2)}
/* mobile .row wrap: .sid must never land alone on a wrapped line (order sits it right after
   .t/.acct, both always narrow enough to share a line — .proj is bumped after it so a long
   project name wraps to its OWN line instead of stranding .sid in the gap before .ttl).
   .li2 (rename input) bumped to 16px here too — anything under 16px forces an iOS Safari
   auto-zoom on focus; input[type=search] gets the same treatment in the /system mobile block. */
@media(max-width:700px){body{padding:max(8px,env(safe-area-inset-top,8px)) 8px calc(72px + env(safe-area-inset-bottom,0))}.chip{min-height:40px}.proj{max-width:55%;order:1}.ttl{flex-basis:100%;order:9}.sz{display:none}.sid{margin-left:auto}.pg a,.pg .off{width:40px;height:40px}input[type=search]{width:140px}.li2{font-size:16px}
.fleet-rows{display:none}.fleet-cards{display:flex;flex-direction:column;gap:12px;margin:4px 0 14px}
/* touch targets: .ab covers every button/summary/anchor styled as a pill (⋯ toggle,
   pause/resume/save/kill, the card's >_ attach link) — 34px (desktop mouse density) is
   under the 40px mobile minimum; bump on touch viewports only, desktop stays dense. */
.ab{min-height:40px}
/* app-mode nav: fixed bottom tab bar (the footer links + header chips it
   duplicates hide via .navdup). installed PWA has no browser chrome, so this
   IS the navigation; safe-area padding clears the iPhone home indicator. */
.tabs{position:fixed;bottom:0;left:0;right:0;z-index:20;display:flex;background:rgba(9,9,11,.88);backdrop-filter:blur(14px);-webkit-backdrop-filter:blur(14px);border-top:1px solid var(--bd);padding:5px 0 calc(5px + env(safe-area-inset-bottom,0))}
.tb{flex:1;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:2px;min-height:48px;color:var(--dim);font-size:11px}
.tb .ti{font-size:18px;line-height:1.2}
.tb.on{color:var(--ok)}
.tb:active{color:var(--fg)}
.navdup{display:none}
/* installed app: content scrolls under the translucent status bar — back it
   with a blur strip (tab bar's top counterpart). 0-height in browser tabs. */
body::before{content:'';position:fixed;top:0;left:0;right:0;height:env(safe-area-inset-top,0px);background:rgba(9,9,11,.88);backdrop-filter:blur(14px);-webkit-backdrop-filter:blur(14px);z-index:20;pointer-events:none}}
/* iOS standalone bug (measured via /z dash3 beacons 2026-08-29): after an app-switch /
   keyboard cycle WebKit sometimes relays the layout viewport short by exactly the top
   safe-area inset (ih=894 vs screen 956, sat=62), so fixed bottom:0 floats 62pt above the
   real screen bottom. 100lvh still reads the true screen height in that state, so in the
   installed app anchor the bar and FAB from the TOP off 100lvh instead — identical
   geometry when the viewport is sane. But dash3 also shows vh=894 in that state: nothing
   paints below the short layout viewport, so a bare 100lvh anchor hangs the bar's bottom
   62pt past the paintable area and clips the labels off the launch page (the fleet page
   is the PWA start page, so it's the one always seen in that state). min(100lvh,100%)
   clamps to the layout viewport (100% of a fixed element = its height): sane state
   unchanged, short state degrades to the old visible float instead of clipping.
   Browser tabs keep bottom:0 (Safari's collapsing toolbar makes lvh the wrong anchor
   there). .tabs box height = 1px border + 5px pad + 48px .tb + 5px pad + sab. */
@media(display-mode:standalone) and (max-width:700px){@supports(height:100lvh){
.tabs{bottom:auto;top:calc(min(100lvh,100%) - 59px - env(safe-area-inset-bottom,0px))}
.termfab{bottom:auto;top:calc(min(100lvh,100%) - 116px - env(safe-area-inset-bottom,0px))}
/* the stuck-short state (dash3 ih=894) hits the fleet page — the only page whose
   content doesn't fill the screen; give the document full height so WebKit has no
   short-document excuse to letterbox. border-box so it fills exactly, no dead scroll. */
body{min-height:100lvh;box-sizing:border-box}
}}
/* system + usage panel */
.sys{margin:2px 0 12px;border:1px solid var(--bd);border-radius:var(--r-lg);background:var(--card)}
.sys > summary{position:relative;display:flex;flex-wrap:wrap;gap:4px 10px;align-items:center;padding:9px 34px 9px 12px;cursor:pointer;list-style:none;font-size:13px;color:var(--mut)}
.sys summary::-webkit-details-marker{display:none}
.sys > summary::after{content:'▾';position:absolute;right:13px;top:9px;color:var(--dim)}
.sys[open] > summary::after{content:'▴'}
.sys > summary:hover{color:var(--fg2)}
.syst{color:var(--fg2);font-weight:600}
.syss{overflow-wrap:anywhere;min-width:0}
.syss b{color:var(--fg);font-weight:600;font-variant-numeric:tabular-nums}
.sysbody{padding:0 12px 12px;border-top:1px solid var(--hair)}
.statgrid{display:grid;grid-template-columns:repeat(auto-fit,minmax(140px,1fr));gap:6px;padding-top:10px}
.statgrid.u{grid-template-columns:repeat(auto-fit,minmax(240px,1fr))}
.stat{background:var(--card2);border:1px solid var(--bd);border-radius:var(--r);padding:8px 10px;min-width:0}
.stat.wide{grid-column:1/-1}
.sl{display:block;font-size:10px;letter-spacing:.08em;text-transform:uppercase;color:var(--dim);padding-bottom:4px;white-space:nowrap}
.sv{font-size:16px;font-weight:650;font-variant-numeric:tabular-nums}
.meter{display:block;height:4px;border-radius:2px;background:rgba(255,255,255,.07);margin-top:7px;overflow:hidden}
.meter i{display:block;height:100%;background:var(--ok);border-radius:2px}
.qrow{display:flex;gap:8px;align-items:center;font-size:12px;color:var(--mut);padding:2px 0;min-width:0}
.qrow .meter{flex:1;margin:0}
.rrow{display:flex;flex-wrap:wrap;gap:8px;align-items:center;font-size:12px;color:var(--mut);padding:3px 0;min-width:0;cursor:pointer}
.rrow .rl{color:var(--fg);flex:0 0 auto}
.rrow b{color:var(--fg);font-variant-numeric:tabular-nums;margin-left:auto;flex-shrink:0}
.rrow>.muted{flex:0 0 100%;padding:0 0 0 24px;font-size:11px}
.rrow input{width:16px;height:16px;accent-color:var(--warn);flex-shrink:0}
.rrow.tot{border-top:1px solid var(--hair);margin-top:6px;padding-top:9px;cursor:default}
.rf{margin:0}
.chip.ok{border-color:var(--ok-bd);color:var(--ok)}
.qrow b{color:var(--fg);font-variant-numeric:tabular-nums;flex-shrink:0}
.qrow>span:first-child{width:52px;flex-shrink:0}
.qrow .sid8{font-family:var(--mono);font-size:11px;color:var(--fg2);text-decoration:underline;text-decoration-color:var(--bd2)}
.mlist{font-size:11px;color:var(--mut);padding-top:4px;overflow-wrap:anywhere;min-width:0}
.ubd{margin-top:8px;border-top:1px solid var(--hair);padding-top:6px}
.ubd summary{cursor:pointer;list-style:none;font-size:11px;color:var(--fg2);min-height:26px;display:flex;align-items:center}
.ubd summary::-webkit-details-marker{display:none}
.ubd summary::before{content:'▸';color:var(--dim);margin-right:6px}
.ubd[open] summary::before{content:'▾'}
.flt form{flex:1;min-width:150px;flex-basis:100%}
.flt .fsw{position:relative;width:100%}
.flt .fico{position:absolute;left:12px;top:50%;transform:translateY(-50%);font-size:13px;color:var(--dim);pointer-events:none}
.flt input[type=search]{width:100%;padding:10px 14px 10px 34px;min-height:40px}
/* spec filter bar (closed state): 54px card, mono content — "🔍 filter" in dim, the
   " — all · all time · N sessions" summary in muted, a 16px chevron at the right edge. */
.flt > summary{min-height:54px;padding:0 16px;font-family:var(--mono);font-size:14px}
.flt > summary::after{font-size:16px;right:16px;top:50%;transform:translateY(-50%)}
.flt .syst{color:var(--dim);font-weight:400}
.flt .syss{color:var(--mut)}
.flt .syss::before{content:' — '}
summary:focus-visible{outline:2px solid var(--ok-bd);outline-offset:2px;border-radius:6px}
/* /system page redesign (figma-make addendum, node 36:852): two 464px columns,
   96px gap, at desktop; Metrics (bare bars, no card) | Environment + Terminal
   (both bordered cards). .sysextra below keeps the pre-existing usage/spend/reclaim
   panel (own header, same .statgrid/.stat tokens as before — untouched). */
.sysgrid{display:grid;grid-template-columns:464px 464px;column-gap:96px;align-items:start}
.sysright{display:flex;flex-direction:column;gap:32px}
.sechead{margin:0 0 32px}
.sechead h2{font:500 20px/28px var(--sans);color:var(--fg);letter-spacing:-.5px}
.sechead p{font:14px/20px var(--sans);color:var(--dim);padding-top:4px}
.mbars{display:flex;flex-direction:column;gap:24px}
.mbar{display:flex;flex-direction:column;gap:8px}
.mbar-row{display:flex;justify-content:space-between;align-items:baseline;gap:12px}
.mbar-label{font:500 14px var(--sans);color:var(--fg2)}
.mbar-val{font:14px var(--mono);color:var(--fg);font-variant-numeric:tabular-nums;white-space:nowrap}
.mbar-track{width:100%;height:6px;border-radius:999px;background:var(--hair);overflow:hidden}
.mbar-fill{height:6px;border-radius:999px;background:var(--fg)}
.mbar-fill.warn{background:#fef3c6}
.envcard,.termcard{background:var(--card);border:1px solid var(--bd2);border-radius:var(--r-lg);padding:24px}
.envrows{display:flex;flex-direction:column;gap:16px}
.envrow{display:flex;justify-content:space-between;align-items:baseline;gap:16px;min-width:0}
.envkey{font:14px var(--mono);color:var(--dimmer);white-space:nowrap}
.envval{font:14px var(--mono);color:var(--fg2);text-align:right;overflow:hidden;text-overflow:ellipsis;min-width:0}
.envval.ok{color:var(--ok);display:inline-flex;align-items:center;gap:8px;white-space:nowrap}
.edot{width:6px;height:6px;border-radius:50%;background:var(--ok);display:inline-block;flex-shrink:0}
.envdiv{height:1px;background:rgba(39,39,42,.5)}
.seclabel{font:700 10px var(--sans);color:var(--dim);letter-spacing:.1em;text-transform:uppercase;line-height:15px;margin:0 0 12px}
.dangerbtn{width:100%;display:flex;align-items:center;justify-content:center;gap:8px;height:46px;border-radius:12px;background:rgba(251,44,54,.1);border:1px solid rgba(130,24,26,.5);color:#ff6467;font:500 14px var(--sans);cursor:pointer;list-style:none}
.dangerbtn::-webkit-details-marker{display:none}
.dangerbtn:hover{background:rgba(251,44,54,.16)}
.dangerbtn.off{opacity:.45;cursor:default;pointer-events:none}
.dangercap{font-size:12px;color:var(--dimmer);line-height:19.5px;padding-top:12px}
.sysextra{margin-top:48px}
.sysextra .sechead{margin-bottom:16px}
@media(max-width:700px){.sys > summary{font-size:12px;padding:8px 30px 8px 10px}.sysbody{padding:0 8px 8px}input[type=search]{font-size:16px}
.sysgrid{display:block}.sysleft{margin-bottom:32px}.sysright{gap:24px}
.envcard,.termcard{padding:20px}.sechead{margin-bottom:24px}}
/* Device view (figma-make addendum, node 36:651): 320px left rail (segmented toggle +
   device-info card + uppercase-headed control cards) + flex-1 dashed stage. .devcard
   mirrors .envcard/.termcard's own bg/border/radius tokens above (same card language,
   just 20px padding per the addendum instead of 24). Mobile: rail-stacks-above-stage
   lives in the shared 700px block above (.devlayout/.devrail/.devstage there). */
.devlayout{display:flex;gap:48px;align-items:flex-start}
.devrail{width:320px;flex-shrink:0;display:flex;flex-direction:column;gap:24px;min-width:0}
.devcard{background:var(--card);border:1px solid var(--bd);border-radius:var(--r-lg);padding:20px}
.devhead{display:flex;justify-content:space-between;align-items:flex-start;gap:8px}
.devname{font:500 16px var(--sans);color:var(--fg);letter-spacing:-.4px}
.devsub{font:12px var(--mono);color:var(--dim);padding-top:2px}
.devrows{display:flex;flex-direction:column;gap:12px;padding-top:20px}
.devrow{display:flex;justify-content:space-between;gap:12px;font:12px var(--mono)}
.devrow span:first-child{color:var(--dim)}
.devrow span:last-child{color:var(--fg2);text-align:right;overflow:hidden;text-overflow:ellipsis;min-width:0}
.devrow span.good{color:var(--ok)}
/* LIVE badge: same tinted-pill anatomy as the history .lvb badge (bg=accent@10%, real
   dot not a glyph), just the card-header size from the addendum (px8 py4). */
.lvb2{display:inline-flex;align-items:center;gap:6px;color:var(--ok);background:var(--ok-bg);border-radius:4px;padding:4px 8px;font:500 12px var(--mono);flex-shrink:0}
.lvb2 i{width:6px;height:6px;border-radius:50%;background:var(--ok);display:inline-block;flex-shrink:0}
.segtoggle{display:flex;gap:4px;padding:4px;border-radius:12px;background:rgba(24,24,27,.5);border:1px solid var(--bd)}
.segbtn{flex:1;display:flex;align-items:center;justify-content:center;gap:8px;padding:10px 0;border-radius:8px;font:500 12px var(--sans);color:var(--dim)}
.segbtn.on{background:var(--pop);color:var(--fg);box-shadow:0 1px 3px rgba(0,0,0,.4)}
.segbtn:hover{color:var(--fg2)}
.ctlhead{font:700 10px var(--sans);color:var(--dimmer);letter-spacing:.1em;text-transform:uppercase;line-height:15px;margin:0 0 12px}
.ctlgrid{display:grid;grid-template-columns:1fr 1fr;gap:8px}
.ctlgrid.icons4{grid-template-columns:repeat(4,1fr)}
/* a POST form wrapping a ControlButton needs the BUTTON to be the actual grid item
   (grid-column:1/-1 on .wide has to land on the participating item) — display:contents
   drops the <form> itself out of layout/grid participation, same trick used for the
   icon-flip wrapper below. .af{display:inline} (global) is overridden by source order. */
.ctlform{display:contents}
.ctlbtn{display:flex;align-items:center;justify-content:center;gap:8px;height:38px;width:100%;border-radius:12px;background:rgba(24,24,27,.4);border:1px solid var(--bd2);color:var(--mut);font:500 12px var(--sans);cursor:pointer}
.ctlbtn:hover{background:var(--pop);color:var(--fg2)}
.ctlbtn.wide{grid-column:1/-1}
.ctlbtn.ok{color:var(--ok)}
.ctlbtn.ok:hover{background:var(--ok-bg);border-color:var(--ok-bd)}
.ctlbtn.danger{color:#ff6467}
.ctlbtn.danger:hover{background:rgba(251,44,54,.1);border-color:rgba(130,24,26,.5)}
.ctlbtn.stagecta{width:auto;min-width:220px;padding:0 20px}
.icoflip svg{transform:scaleX(-1)}
.themesel{width:100%;height:34px;background:var(--card2);border:1px solid var(--bd);border-radius:var(--r);color:var(--fg);padding:0 8px;font:13px var(--sans);margin-top:8px}
.themerow{margin-top:10px}
.savemsg{font-size:13px;transition:opacity .2s;opacity:0}
.finemuted{font-size:12.5px;margin-top:2px}
.themeprev{border:1px solid var(--bd);border-radius:var(--r);padding:14px 16px;font:13px/1.5 var(--mono);transition:background .15s,color .15s;margin-top:8px}
.tpline{margin-bottom:6px}
.tpdim{opacity:.9;margin-bottom:8px}
.tpnorm{display:flex;gap:4px;margin-bottom:4px}
.tpbright{display:flex;gap:4px;margin-bottom:10px}
.tpcursor{display:inline-block;width:8px;height:15px;vertical-align:-2px}
.devstage{flex:1;min-width:0;min-height:600px;border-radius:24px;background:rgba(24,24,27,.2);border:1px dashed var(--bd);overflow:hidden;display:flex;align-items:center;justify-content:center;position:relative}
/* full-screen toggle on a live stage: CSS-only (iOS has no Fullscreen API for iframes).
   body.devfs promotes the stage to a fixed overlay; the pinned button (safe-area aware
   for notch/landscape insets) is also the exit. Tab bar/fab hidden while active. */
.fsbtn{position:absolute;top:max(10px,env(safe-area-inset-top,10px));right:max(10px,env(safe-area-inset-right,10px));z-index:3;display:flex;align-items:center;justify-content:center;width:38px;height:38px;border-radius:10px;background:rgba(9,9,11,.7);border:1px solid var(--bd2);color:var(--mut);cursor:pointer}
.fsbtn:hover{color:var(--fg2);background:var(--pop)}
body.devfs{overflow:hidden}
body.devfs .devstage.live{position:fixed;inset:0;z-index:80;height:auto;min-height:0;border:0;border-radius:0;background:#000}
body.devfs .devstage.live .vnc{width:100%;height:100%;max-height:none;aspect-ratio:auto}
body.devfs .tabs,body.devfs .termfab{display:none}
/* live on desktop: stage fills the viewport height and the stream fills the stage
   (noVNC/ws-scrcpy scale the remote framebuffer inside the iframe themselves) */
@media(min-width:701px){
.devstage.live{height:calc(100dvh - 210px);min-height:600px}
.devstage.live .vnc{height:100%;max-height:none;aspect-ratio:auto}
}
.stageempty{display:flex;flex-direction:column;align-items:center;text-align:center;padding:32px}
.stageicon{width:64px;height:64px;border-radius:16px;border:1px solid var(--pop);background:rgba(24,24,27,.8);display:flex;align-items:center;justify-content:center;color:var(--dim);margin-bottom:16px}
.stageicon svg{width:28px;height:28px}
.stagemsg{font:14px var(--mono);color:var(--fg2)}
.stagecap{font:12px var(--sans);color:var(--dimmer);opacity:.6;max-width:256px;line-height:19.5px;margin-top:8px}
/* device rail+stage stacking (node 36:651) — placed AFTER the unconditional rules above
   so it wins the cascade at <700px (media queries don't add specificity: a later plain
   rule otherwise clobbers an earlier @media one at equal specificity — this bit us once
   already, keep new mobile overrides for these classes below their desktop declaration). */
@media(max-width:700px){
.devlayout{flex-direction:column;gap:24px;align-items:stretch}
.devrail{width:100%}
.devstage{min-height:220px}
/* live stream on phones: no desktop-style forced height (that's gated at 701px above),
   so drop the empty-state min-height and let the box hug the 16:9 .vnc iframe exactly —
   otherwise flex-centering strands ~25px of dead padding above/below the video. */
.devstage.live{min-height:0}
}
/* app-shell feel (2026-08-25): cross-document view transitions keep the tab bar pinned and
   crossfade only the content, so a navigation reads as a screen change, not a page reload.
   Chrome 126+/Safari 18.2+; older browsers just navigate. */
@view-transition{navigation:auto}
.tabs{view-transition-name:tabs}
::view-transition-old(root){animation:.12s ease both vt-out}
::view-transition-new(root){animation:.18s cubic-bezier(.2,.7,.3,1) both vt-in}
@keyframes vt-out{to{opacity:0}}
@keyframes vt-in{from{opacity:0;transform:translateY(6px)}}
@media(prefers-reduced-motion:reduce){::view-transition-group(*),::view-transition-old(*),::view-transition-new(*){animation:none!important}}
form.busy{pointer-events:none}form.busy button,form.busy summary{animation:busy 1s ease-in-out infinite}
@keyframes busy{50%{opacity:.35}}
/* motion pass (2026-08-26): press feedback + content entrances. transform/opacity ONLY — nothing
   here can trigger layout — and all of it behind prefers-reduced-motion (view transitions are
   already killed for reduce above). The new screen rises 6px under the pinned tab bar, so a
   navigation reads as content sliding into place, not a repaint. */
@media(prefers-reduced-motion:no-preference){
:is(button,summary,.chip,.tabs a){transition:background-color .15s,border-color .15s,color .15s,transform .1s ease,opacity .1s ease}
:is(button,summary,.chip,.tabs a):active{transform:scale(.96)}
details>*:not(summary){transform-origin:top center}
details[open]>*:not(summary){animation:pop-in .18s ease}
@keyframes pop-in{from{opacity:0;transform:translateY(-4px)}}
}
/* /agents (Layer 6, spec 2026-09-15 §8): state pill + run-now/pause/resume/stop actions.
   .agent.card reuses the .lp list-panel look (var(--card)/var(--r-lg)) as a clickable row. */
.agent.card{display:block;background:var(--card);border:1px solid var(--bd);border-radius:var(--r-lg);padding:10px 12px;margin:4px 0 10px;color:inherit}
.agent.card:hover{background:var(--card2);border-color:var(--bd2)}
.agent.card .muted{display:block;font-size:12px;margin-top:4px}
.pill{padding:1px 6px;border-radius:9px;font-size:.75em}
.st-working{background:#2563eb33}.st-done{background:#16a34a33}
.st-failed,.st-stalled,.st-budget_exceeded{background:#dc262633}
.st-never{background:#71717a33}
.actions{display:flex;gap:8px;margin:8px 0}.actions form{display:inline}
.chatf{display:flex;gap:8px;align-items:flex-end;margin:10px 0}
.chatf textarea{flex:1;background:var(--card2);color:var(--fg);border:1px solid var(--bd);border-radius:var(--r);padding:8px;font:inherit;resize:vertical}
.m.me{opacity:.85}.m.me .mh b{color:var(--fg)}
.runs li{margin:4px 0}
/* Task 7, the SPA's streaming chat view. Three notes on how this differs from the brief's block:
   (1) the sticky composer is scoped ".chat .chatf", NOT bare ".chatf". The same class is on the
   SERVER-rendered /agents/<name> form three rules up, and a bare override would make that page's
   composer float over its own Runs/Events sections for the whole scroll — a visible regression on
   a page this task does not touch. The values are the brief's, verbatim; only the selector is
   narrowed to the SPA wrapper. (2) the brief also restated ".chatf textarea" and ".m.me" with
   byte-for-byte the same declarations as the rules already above; re-declaring them would only
   spend bytes against the size ceiling. (3) --kb is set by the view's visualViewport handler. */
.chat{display:flex;flex-direction:column;gap:8px}
.chatbox{max-height:60vh;overflow-y:auto;overscroll-behavior:contain;display:flex;flex-direction:column;gap:10px}
.chat .chatf{position:sticky;bottom:calc(var(--kb,0px) + env(safe-area-inset-bottom));display:flex;gap:8px;align-items:flex-end;background:var(--bg);padding:6px 0}
.m.streaming .mh .muted{animation:pulse 1.2s ease-in-out infinite}
@keyframes pulse{50%{opacity:.35}}
.mb pre{white-space:pre-wrap;word-break:break-word}
.jump{position:sticky;bottom:70px;align-self:center}

/* ---------- agents section, Figma 44:5 (design doc: docs/superpowers/specs/2026-09-17-*) ----------
   Scoping rules for this whole block, and why:
   - the two-column layout and the message restyle are scoped to .ag2 / .chat, NOT to bare .m,
     because the SERVER-rendered /agents/<name> shares the .m/.mh/.mb markup and emits no avatar
     span. A bare .m override would leave that page with a flex row and nothing to put in it.
   - body.uiapp carries the comp's own metrics (1024 content + 32 gutter = 1088). The other pages
     keep the 1024/48 reading column they already had; matching the comp is an /ui statement, not
     a site-wide one.
   - icons are CSS masks over data: URIs, so they take currentColor and hover with their button.
     The path data is ICO's, already in this file — nothing new was drawn. */
:root{
--ico-restart:url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 24 24' fill='none' stroke='%23000' stroke-width='2' stroke-linecap='round' stroke-linejoin='round'%3E%3Cpath d='M21 12a9 9 0 1 1-3-6.7'/%3E%3Cpath d='M21 3v6h-6'/%3E%3C/svg%3E");
--ico-activity:url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 24 24' fill='none' stroke='%23000' stroke-width='2' stroke-linecap='round' stroke-linejoin='round'%3E%3Cpath d='M22 12h-4l-3 9L9 3l-3 9H2'/%3E%3C/svg%3E");
--ico-send:url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 16 16' fill='none' stroke='%23000' stroke-width='1.33333' stroke-linecap='round' stroke-linejoin='round'%3E%3Cpath d='M9.69 14.46a.5.5 0 0 0 .62-.02L14.65 1.77a.33.33 0 0 0-.42-.42L1.56 5.68a.33.33 0 0 0-.02.63l5.29 2.12a2 2 0 0 1 1.13 1.13z'/%3E%3Cpath d='M14.57 1.43 7.28 8.72'/%3E%3C/svg%3E")}
@media(min-width:701px){body.uiapp{max-width:1088px;padding:32px}}
.agwrap{display:flex;flex-direction:column;gap:12px}
.agback{font:12px var(--mono);color:var(--dim)}
.agback:hover{color:var(--fg2)}
.agback-in{display:none}
.ag2{display:grid;grid-template-columns:minmax(0,1fr) 320px;gap:24px;align-items:start}
.agchat{background:var(--card);border:1px solid var(--bd);border-radius:var(--r-lg);display:flex;flex-direction:column;min-width:0;overflow:hidden}
.agh{display:flex;align-items:center;gap:12px;padding:16px 20px;border-bottom:1px solid var(--bd)}
.agav{width:32px;height:32px;border-radius:8px;background:var(--ok-bg);border:1px solid var(--ok-bd);color:var(--ok);display:flex;align-items:center;justify-content:center;font:700 12px/1 var(--mono);flex-shrink:0}
.agav::before{content:'>_'}
.agti{min-width:0;flex:1}
.agti h1{font:600 16px/1.4 var(--sans);padding:0;display:flex;align-items:center;gap:8px;letter-spacing:-.01em}
.agti h1::before{display:none}
.agdot{width:8px;height:8px;border-radius:50%;background:var(--ok-lt);box-shadow:0 0 0 3px rgba(0,188,125,.2);flex-shrink:0}
.agsub{font:12px/1.25 var(--mono);color:var(--dim);margin-top:2px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.agctl{display:flex;gap:8px;margin:0}
.cbtn{width:32px;height:32px;min-height:32px;padding:0;border-radius:8px;background:var(--card2);border:1px solid var(--bd3);color:var(--mut);display:flex;align-items:center;justify-content:center;cursor:pointer}
.cbtn::before{content:'';width:14px;height:14px;background:currentColor;-webkit-mask:var(--ico-restart) center/14px no-repeat;mask:var(--ico-restart) center/14px no-repeat}
.cbtn:hover{background:var(--pop);border-color:var(--ring);color:var(--fg2)}
/* transcript: SPA only (see scoping note above) */
.chat{gap:0;flex:1;min-height:0}
.agchat{height:min(78vh,812px)}
.chat .chatbox{padding:20px;gap:20px;max-height:none;flex:1;min-height:0}
.chat .chatf{position:static}
.chat .m{background:none;border:0;border-radius:0;padding:0;margin:0;display:flex;gap:12px;align-items:flex-start;opacity:1}
.chat .m.me{flex-direction:row-reverse}
.chat .mav{width:32px;height:32px;border-radius:50%;flex-shrink:0;display:flex;align-items:center;justify-content:center;font:700 11px/1 var(--mono)}
.chat .m.claude .mav{background:var(--ok-bg);border:1px solid var(--ok-bd);color:var(--ok)}
.chat .m.claude .mav::before{content:'>_'}
.chat .m.me .mav{background:var(--pop);border:1px solid var(--bd2);color:var(--mut)}
.chat .m.me .mav::before{content:'U'}
.chat .mc{min-width:0;flex:1;display:flex;flex-direction:column;gap:6px}
.chat .m.me .mc{align-items:flex-end}
.chat .mh{padding:0;font:700 10px/1 var(--mono);letter-spacing:.08em;color:var(--dim);display:flex;align-items:center;gap:8px;flex-wrap:wrap}
.chat .m.me .mh{justify-content:flex-end}
.chat .m.claude .mh b{color:var(--ok)}
.chat .m.me .mb{background:var(--card2);border:1px solid var(--bd);border-radius:12px;padding:12px 14px;max-width:560px}
.chat .m.claude .mb{max-width:100%;color:var(--fg2)}
.chat .mb pre{background:rgba(9,9,11,.6);border:1px solid var(--bd);border-radius:8px;padding:12px 14px;font:12px var(--mono);color:var(--ok);overflow-x:auto}
.chat .mb code{font:12px var(--mono);background:var(--pop);border-radius:4px;padding:1px 5px;color:var(--fg2)}
.chat .mb pre code{background:none;padding:0;color:inherit}
/* The agent's memory write-back as it appears in a reply. It IS a code fence — that is how
   mows-agent extracts it — but an unlabelled green block read as "what is that green text?" the
   first time a person saw one. So the fence whose info string is mows-memory gets a caption and a
   green edge. CSS only: marked emits <pre><code class="language-<info>">. */
.memupd{margin-top:8px}
.memupd summary{display:inline-flex;align-items:center;gap:6px;font:700 10px/1 var(--mono);letter-spacing:.1em;text-transform:uppercase;color:var(--ok);background:var(--ok-bg);border:1px solid var(--ok-bd);border-radius:999px;padding:6px 10px;cursor:pointer;list-style:none}
.memupd summary::-webkit-details-marker{display:none}
.memupd summary::before{content:'▸';font-size:9px}
.memupd[open] summary::before{content:'▾'}
.memupd[open] summary{margin-bottom:8px}
.memupd pre{border-color:var(--ok-bd)}
/* system divider: a run-lifecycle event, interleaved into the transcript */
.sysdiv{display:flex;align-items:center;gap:12px}
.sysl{flex:1;height:1px;background:var(--bd)}
.sysb{display:inline-flex;align-items:center;gap:8px;border:1px solid var(--bd);border-radius:999px;padding:5px 12px;font:11px var(--mono);color:var(--mut);white-space:nowrap;max-width:100%;overflow:hidden;text-overflow:ellipsis}
.sysi{width:14px;height:14px;flex-shrink:0;background:currentColor;-webkit-mask:var(--ico-activity) center/14px no-repeat;mask:var(--ico-activity) center/14px no-repeat}
/* composer: inside the card, not floating under it */
.chat .chatf{border-top:1px solid var(--bd);padding:16px 20px;margin:0;gap:12px;align-items:center;background:var(--card2)}
.chat .chatf textarea{border-radius:12px;padding:12px 14px;min-height:46px;background:var(--bg);border-color:var(--bd3);resize:none;font:13px var(--sans)}
.chat .chatf textarea::placeholder{color:var(--dimmer)}
.sendb{width:40px;height:40px;min-height:40px;padding:0;border-radius:50%;background:var(--fg);color:var(--bg);border:0;display:flex;align-items:center;justify-content:center;flex-shrink:0}
.sendb::before{content:'';width:16px;height:16px;background:currentColor;-webkit-mask:var(--ico-send) center/16px no-repeat;mask:var(--ico-send) center/16px no-repeat}
.sendb:hover{background:var(--fg2)}
.sendb:disabled{background:var(--pop);color:var(--dim);cursor:default}
.sendb:disabled::before{display:none}
.chint{font:11px var(--mono);color:var(--dimmer);text-align:center;padding:0 20px 14px;margin:0}
/* right column */
.agside{display:flex;flex-direction:column;gap:16px;min-width:0}
.agside .card{background:var(--card);border:1px solid var(--bd);border-radius:var(--r-lg);padding:20px;margin:0}
.cl{font:700 10px/1 var(--mono);letter-spacing:.1em;text-transform:uppercase;color:var(--dim);margin:0 0 16px}
.agside .cap h2{display:none}
.cchips{display:flex;flex-wrap:wrap;gap:6px;margin-bottom:12px}
.cchip{font:11px var(--mono);color:var(--fg2);background:var(--card2);border:1px solid var(--bd3);border-radius:6px;padding:4px 8px}
.capsum-warn{font:12px var(--sans);color:var(--warn);margin:0}
.capsum-in{font:12px var(--sans);color:var(--warn);margin:0 0 8px}
.capmore{margin-top:14px;border-top:1px solid var(--bd);padding-top:12px}
.capmore summary{font:700 10px var(--mono);letter-spacing:.1em;text-transform:uppercase;color:var(--dim);cursor:pointer}
.capmore[open] summary{margin-bottom:10px}
.agside .cap{font-size:12px}
.agside .cap p{margin:8px 0}
.tgrid{display:flex;flex-direction:column;gap:12px}
.trow{display:flex;justify-content:space-between;align-items:baseline;gap:12px}
.tk{font:12px var(--mono);color:var(--dim);flex-shrink:0}
.tv{font:12px var(--mono);color:var(--fg2);text-align:right;min-width:0;word-break:break-word}
.rruns{list-style:none;display:flex;flex-direction:column;gap:14px;margin:0;padding:0}
.rruns li{display:flex;align-items:center;gap:10px;margin:0}
.rruns .pill{font:700 9px/1 var(--mono);letter-spacing:.08em;text-transform:uppercase;padding:5px 7px;border-radius:4px;flex-shrink:0}
.rruns a{font:12px var(--mono);color:var(--fg2);flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis}
.rcost{font:12px var(--mono);color:var(--fg2);font-variant-numeric:tabular-nums;flex-shrink:0}
.mem{font:12px/1.5 var(--mono);color:var(--fg2);white-space:pre-wrap;word-break:break-word;margin:0;max-height:320px;overflow:auto}
.agside .agev{padding:14px 20px}
.agev summary{font:700 10px var(--mono);letter-spacing:.1em;text-transform:uppercase;color:var(--dim);cursor:pointer}
.agev .events{margin-top:12px}
/* Reflow. The comp is a 1024 content column; below it the columns narrow, then stack. The cards
   go UNDER the chat and not over it because the chat is why this page exists — a phone opening
   an agent should land on the transcript, not scroll three cards to reach it. Source order
   already puts .agchat first, so the single-column case needs no reordering. */
@media(max-width:1087px){.ag2{grid-template-columns:minmax(0,1fr) 300px;gap:16px}}
@media(max-width:860px){.ag2{grid-template-columns:minmax(0,1fr);gap:12px}
.agwrap{gap:8px}
/* The back link was a bare 12px mono line sitting on the safe-area blur band's edge, half faded
   and not a tap target. A 36px row with a little air below the band. */
/* No separate back row on a phone: it was a ghosted 12px string alone in a ~100px dead zone
   under the notch. The back control moves into the card's header (.agback-in), where iOS puts
   one, and the card starts right under the safe-area band. */
.agback{display:none}
.agback-in{display:inline-flex;align-items:center;justify-content:center;width:32px;height:32px;border-radius:8px;background:var(--card2);border:1px solid var(--bd3);color:var(--fg2);font:600 16px/1 var(--sans);flex-shrink:0;margin-right:-4px}
.agback-in:active{background:var(--pop)}
/* The card fills the space between the safe-area band and the tab bar, insets subtracted by
   name rather than folded into a magic number: body already pads max(8px, safe-top) above and
   72px + safe-bottom below; ~20px of air stays above the bar. */
.agchat{height:calc(100dvh - max(8px,env(safe-area-inset-top,0px)) - env(safe-area-inset-bottom,0px) - 80px)}
.chint-help{display:none}
/* iOS Safari zooms the page when a focused control's font is under 16px. The other inputs got
   this rule long ago (input[type=search], .li2); the chat composer missed it and every tap on it
   zoomed the whole conversation. 16px is the accessible fix — pinch zoom stays available. */
.chat .chatf textarea{font-size:16px}
.chatbox{padding:14px;gap:16px}
.chat .chatf{padding:10px 12px}
.agh{padding:12px 14px}
.agside .card{padding:16px}
/* The terminal FAB is fixed bottom-right, over this card's hint line. Left-align the hint and leave
   the FAB's column empty, rather than hide a global control on one page. */
.chint{text-align:left;padding:0 76px 12px 14px}}
/* Phones (tab bar shown, FAB at bottom:70px+safe): the card ends ABOVE the FAB's band, so nothing
   in it — composer, Send, hint — can ever sit under the FAB, and no per-element reserve is needed.
   FAB top is 116px + safe-bottom from the viewport bottom; 132 leaves 16px of air. */
@media(max-width:700px){.agchat{height:calc(100dvh - max(8px,env(safe-area-inset-top,0px)) - env(safe-area-inset-bottom,0px) - 132px)}
.chint{padding:0 14px 12px}
/* The agent page is a chat screen. On a phone (html.agent-view, set by the view while mounted):
   - the terminal FAB is hidden outright — it has no business over a composer, and iOS lifts any
     position:fixed;bottom:0 element to sit above the keyboard, so it would float mid-page;
   - the tab bar stays, and hides only while the composer is FOCUSED (html.kb-open, set on focus and
     cleared on blur). Focus is the signal because it is the one iOS reports everywhere: in the
     installed PWA the keyboard pans the page instead of resizing the visual viewport, so a
     viewport-based "keyboard is up" never fired there.
   With no FAB the card needs only the tab bar's 54px + safe-bottom below it, plus 16px of air. */
html.agent-view .termfab{display:none}
html.kb-open .tabs{display:none}
html.agent-view .agchat{height:calc(100dvh - max(8px,env(safe-area-inset-top,0px)) - env(safe-area-inset-bottom,0px) - 70px)}}
/* A send that never reached the server, or a transcript refetch that failed. Previously both
   were silent and the composer simply stayed disabled forever (fix round 1). */
.cherr{color:var(--bad);font-size:13px;margin:0}
/* Task 8, the capability panel. .cap-warn is a left rule rather than a filled banner on purpose:
   an agent with Bash is the COMMON case here, and a red box on every agent page teaches the
   operator to ignore it. It reads first because it is placed first — document order is the whole
   mechanism, and it is asserted (warnAt < toolsAt) rather than left to CSS. .auth carries the one
   authority list; it is unbulleted because each item already opens with a bold sentence. */
.cap{margin:10px 0}.cap p{margin:6px 0}
.cap-warn{border-left:3px solid var(--warn);padding-left:10px}
/* Unknown reach is not the same statement as confirmed broad authority and must not look like it.
   "I cannot classify this tool" rendered in .cap-warn carried the same weight as "it can read and
   write any file this account can reach", which is the fastest way to teach an operator to scroll
   past both (re-review, proportionality). Same left rule, muted colour: still a rule, visibly a
   lesser one. */
.cap-unknown{border-left:3px solid var(--dim);padding-left:10px;color:var(--mut)}
.auth{margin:6px 0;padding:0;list-style:none}.auth li{margin:4px 0}
.policy{margin:6px 0 0 18px}.policy li{margin:4px 0}
/* /ui carries the same fixed .tabs bar as every other page (final review, H1), and a STICKY
   element sticks to the scrollport, not to the end of the document — so body's bottom padding,
   which is what keeps ordinary content clear of the bar, does not move these two. They have to
   clear it themselves or the composer sits behind the bar on every phone.
   70px is .termfab's own clearance, this file's one number for "floating thing above the tab
   bar" (.tabs box height is 59px + safe area; see its comment in the standalone block below).
   max() rather than a sum, and this is the part worth reading: when the on-screen keyboard is up,
   --kb already exceeds the bar's height AND the bar is behind the keyboard (WebKit, which ignores
   interactive-widget=resizes-content) or above it (Chrome, where --kb is ~0 and the bar is the
   thing to clear). Adding the clearance on top of --kb would leave a 70px dead gap between the
   composer and the keyboard in the one engine the --kb handler exists for.
   Scoped below 701px only: .tabs is display:none above it, so there is nothing to clear. */
@media(max-width:700px){
.uiapp .chat .chatf{bottom:calc(env(safe-area-inset-bottom,0px) + max(var(--kb,0px),70px))}
.uiapp .jump{bottom:calc(70px + max(var(--kb,0px),70px))}}
/* THE THIRD FIXED ELEMENT. The clearance above moved the composer and the jump button and did not
   consider .termfab, which pageChrome() also puts into the /ui shell and which was not there
   before. Measured in Chromium AND WebKit at 375x812 and 414x896: the FAB covered 46 of the Send
   button's 56 px of width and its full 34 px of height, and document.elementFromPoint() at the
   button's own centre returned the FAB. Tapping Send opened the terminal. It is not phone-only —
   at 1024 the overlap was still 12x26 (re-review, R1).
   The fix is layout, not another offset: the FAB sits at most 60px in from the VIEWPORT's right
   edge (right:14px + 46px wide), and the composer's own right edge is already inset from that edge
   by body padding, so reserving 60px inside the composer clears it at every width by construction
   — no arithmetic per breakpoint, nothing to re-derive if the FAB moves closer to the edge. It is
   deliberately NOT inside the media query above: the desktop overlap is smaller, not absent.
   Not hiding the FAB on /ui instead: the terminal is an ACTION and was never a nav tab (see the
   FAB's own comment), so the tab bar does not replace it, and hiding it would make the terminal
   unreachable from the app. Asserted on GEOMETRY, not markup, by the "layout" mode of
   docs/qa/probes/probes.mjs — eleven greps over the served HTML could not see this and did not. */
/* 2026-09-19, the card redesign: the composer is no longer a page-level sticky bar, it is the
   foot of a fixed-height chat card. That moved the collision: on a phone the card now ENDS above
   the FAB's band (see the max-width:700px block above), and above 860px the composer sits in the
   left column while the FAB hangs over the right one — in neither regime can Send reach the FAB.
   The one band where they still share a column is 701–860px, single-column with no tab bar, so
   the reserve is scoped to it. The layout mode of docs/qa/probes/probes.mjs asserts each regime's own
   geometry rather than the sticky state that no longer exists. */
@media(min-width:701px) and (max-width:860px){.uiapp .chat .chatf{padding-right:60px}}
/* mobile facelift (2026-10-10): same dark zinc+emerald tokens, "modern app" language on
   phones only — floating glass pill tab bar, bigger display title, mono status-pill section
   label, softer 22px cards with a state-tinted edge, round controls. Pure overrides appended
   last so order wins; desktop (>700px) is untouched. Geometry: bar = 60px tall floating
   --tbo above the bottom; FAB sits 14px above the bar. */
@media(max-width:700px){
:root{--tbo:max(10px,calc(env(safe-area-inset-bottom,0px) - 8px))}
body{padding-bottom:calc(96px + env(safe-area-inset-bottom,0px));
background:radial-gradient(120% 50% at 50% -12%,rgba(0,212,146,.10),transparent 60%) no-repeat,var(--bg)}
h1{font:700 26px/1.15 var(--sans);letter-spacing:-.03em;padding:10px 2px 18px;gap:12px}
h1::before{border-radius:12px;padding:9px 9px;font-size:13px;box-shadow:0 0 24px rgba(0,212,146,.18)}
h1 .muted{font-size:15px;font-weight:500;letter-spacing:-.01em}
.sect{display:flex;align-items:center;gap:8px;font:600 10.5px/1 var(--mono);letter-spacing:.18em;color:var(--mut);margin:4px 2px 14px}
.sect b{color:var(--ok);font-weight:600}
.sect input[type=search]{margin-left:auto!important;width:auto!important;flex:1;max-width:190px;min-height:36px!important;padding:6px 14px!important;border-radius:999px;background:rgba(255,255,255,.04);font:15px var(--sans);letter-spacing:0;text-transform:none}
.fleet-cards{gap:12px}
.fleet-cards .lp{margin:0}
.fleet-cards .lp{border-radius:22px;padding:18px 18px 16px;gap:8px;border:1px solid rgba(255,255,255,.06);
background:linear-gradient(180deg,rgba(39,39,42,.55),rgba(24,24,27,.35));box-shadow:inset 0 1px 0 rgba(255,255,255,.04),0 8px 24px rgba(0,0,0,.25)}
.fleet-cards .lp[data-state=working]{border-color:var(--ok-bd);box-shadow:inset 0 1px 0 rgba(255,255,255,.04),0 0 0 1px rgba(0,212,146,.06),0 8px 28px rgba(0,212,146,.08)}
.fleet-cards .lp[data-state=needs-you],.fleet-cards .lp[data-state=paused]{border-color:rgba(255,185,0,.28)}
.fleet-cards .lp > .lb,.fleet-cards .fchd .lb{font:650 17px/1.25 var(--sans);letter-spacing:-.02em;display:flex;align-items:center;gap:8px;min-width:0}
.fleet-cards .fli{font-size:11px}
.fleet-cards .fli-working{text-shadow:0 0 10px var(--ok)}
.fleet-cards .fchd + .muted{font:500 13px var(--sans)!important;color:var(--mut)}
.fleet-cards .fsnip{font:12px/1.5 var(--mono)!important;color:var(--dim);background:rgba(0,0,0,.25);border:1px solid rgba(255,255,255,.04);border-radius:12px;padding:8px 10px;margin-top:4px}
.fleet-cards .fcact{gap:8px}
.fleet-cards .fcact .ab{width:42px;height:42px;min-height:42px;padding:0;justify-content:center;border-radius:50%}
.fleet-cards .ab.ok,.fleet-cards .ab.ok:hover{background:var(--ok-bg);border-color:var(--ok-bd)}
.fleet-cards .fcact summary.ab{background:rgba(255,255,255,.04);border-color:rgba(255,255,255,.07)}
.kc{border-radius:20px;background:rgba(39,39,42,.92);backdrop-filter:blur(18px);-webkit-backdrop-filter:blur(18px)}
.newcard{border-radius:22px;padding:20px;margin-top:8px}
.tabs{left:12px;right:12px;bottom:var(--tbo);padding:5px 6px;border:1px solid rgba(255,255,255,.08);border-radius:30px;
background:rgba(24,24,27,.72);backdrop-filter:blur(20px) saturate(160%);-webkit-backdrop-filter:blur(20px) saturate(160%);box-shadow:0 12px 32px rgba(0,0,0,.55),inset 0 1px 0 rgba(255,255,255,.05)}
.tb{border-radius:24px;gap:3px;font:500 10.5px/1 var(--sans);letter-spacing:.01em}
.tb .ti{display:flex;align-items:center;justify-content:center;width:46px;height:28px;border-radius:999px;transition:background-color .2s}
.tb.on .ti{background:var(--ok-bg);box-shadow:inset 0 0 0 1px var(--ok-bd)}
.tb.on{font-weight:600}
.termfab{right:18px;bottom:calc(var(--tbo) + 74px);width:54px;height:54px;box-shadow:0 0 0 6px rgba(0,212,146,.10),0 10px 28px rgba(0,212,146,.30),0 6px 18px rgba(0,0,0,.5)}
}
/* mobile System facelift (2026-10-10): metrics become a 2x2 tile grid (mono label, big %,
   value, glowing accent bar — .mbar-pct is phone-only), env/terminal/usage cards share the
   fleet card surface, section heads become the same tracked mono label as "FLEET". */
.mbar-pct{display:none}
@media(max-width:700px){
.sechead{margin:0 2px 12px}
.sechead h2{font:600 10.5px/1 var(--mono);letter-spacing:.18em;text-transform:uppercase;color:var(--mut)}
.sechead p{display:none}
.sysleft{margin-bottom:26px}.sysright{gap:26px}.sysextra{margin-top:26px}
.mbars{display:grid;grid-template-columns:1fr 1fr;gap:12px}
.mbar,.envcard,.termcard,.stat{border-radius:22px;border:1px solid rgba(255,255,255,.06);
background:linear-gradient(180deg,rgba(39,39,42,.55),rgba(24,24,27,.35));box-shadow:inset 0 1px 0 rgba(255,255,255,.04),0 8px 24px rgba(0,0,0,.25)}
.mbar{padding:16px;gap:12px;min-width:0}
.mbar-row{flex-direction:column;align-items:flex-start;gap:6px;min-width:0}
.mbar-label{font:600 10px/1 var(--mono);letter-spacing:.12em;text-transform:uppercase;color:var(--dim)}
.mbar-pct{display:block;font:650 30px/1 var(--sans);letter-spacing:-.04em;color:var(--fg);font-variant-numeric:tabular-nums}
.mbar-val{font:11.5px var(--mono);color:var(--mut);white-space:normal}
.mbar-track{height:6px;background:rgba(255,255,255,.06)}
.mbar-fill{background:linear-gradient(90deg,var(--ok-dk),var(--ok-lt));box-shadow:0 0 12px rgba(0,212,146,.45)}
.mbar-fill.warn{background:linear-gradient(90deg,#f59e0b,var(--warn));box-shadow:0 0 12px rgba(255,185,0,.45)}
.mbar:has(.mbar-fill.warn){border-color:rgba(255,185,0,.25)}
.mbar:has(.mbar-fill.warn) .mbar-pct{color:var(--warn)}
.envcard,.termcard{padding:6px 18px}
.termcard{padding:18px}
.envrows{gap:0}
.envrow{padding:13px 0;border-bottom:1px solid rgba(255,255,255,.05);align-items:center}
.envrow:last-child{border-bottom:none}
.envdiv{display:none}
.envkey{font:600 10.5px var(--mono);letter-spacing:.1em;color:var(--dim)}
.envval{font:13px var(--mono);color:var(--fg)}
.envval.ok{color:var(--ok);background:var(--ok-bg);border:1px solid var(--ok-bd);border-radius:999px;padding:3px 10px;font-size:11px;letter-spacing:.08em}
.edot{box-shadow:0 0 8px var(--ok)}
.seclabel{font:600 10px var(--mono);letter-spacing:.12em}
.dangerbtn{border-radius:999px;height:48px}
.statgrid{gap:12px}
.stat{padding:16px}
.sl{font:600 10px var(--mono);letter-spacing:.12em;padding-bottom:10px}
.qrow{padding:4px 0}
.meter{height:6px;border-radius:999px;background:rgba(255,255,255,.06)}
.meter i{border-radius:999px;background:linear-gradient(90deg,var(--ok-dk),var(--ok-lt))}
}
@media(display-mode:standalone) and (max-width:700px){@supports(height:100lvh){
.tabs{top:calc(min(100lvh,100%) - 60px - var(--tbo))}
.termfab{top:calc(min(100lvh,100%) - 128px - var(--tbo))}
}}
`;

// fleetJs: '/' (fleet-first home) and '/history' load the tag — /history needs it too,
// phase 3 on, so its keydown handler can focus the search input (fleet.js's hasFleet
// check means /history never opens an /events connection: no fleet-rows/fleet-cards on
// that page, so it costs nothing beyond the deferred script fetch). Every other page
// still skips the tag outright — nothing there for the handler to do.
// ---------- /md: rendered markdown preview ----------
// Any session (or the user) prints `mdv <file>` → https://<host>/md?f=<abs path>; the URL
// is clickable in /term (ttyd's xterm ships the web-links addon) and opens the doc
// rendered inside the dashboard shell, phone and desktop alike. Server-side
// mini-renderer, GitHub-basics only: headings, fenced code, lists+task boxes, tables,
// quotes, hr, inline marks, autolinks. The whole source is HTML-escaped FIRST and only
// then transformed, so file content can never inject markup.
// ponytail: not CommonMark — swap in a real parser only when real docs visibly break.

const MD_CSS = `.mdhead{display:flex;flex-wrap:wrap;gap:4px 12px;align-items:baseline;margin:6px 0 14px;padding-bottom:10px;border-bottom:1px solid var(--bd2)}
.mdhead b{color:var(--title);font-size:16px}
.mdhead span{color:var(--dim);font:12px var(--mono);word-break:break-all}
.mdhead .mddl{margin-left:auto;color:var(--ok);font-size:13px;text-decoration:none;border:1px solid var(--bd2);border-radius:var(--r);padding:4px 10px;white-space:nowrap}
.mdv{line-height:1.65;color:var(--fg2);padding-bottom:24px}
.mdv h1,.mdv h2,.mdv h3,.mdv h4,.mdv h5,.mdv h6{color:var(--title);margin:1.3em 0 .5em;line-height:1.25}
.mdv h1{font-size:23px;border-bottom:1px solid var(--bd2);padding-bottom:8px}
.mdv h2{font-size:18px;border-bottom:1px solid var(--bd);padding-bottom:6px}
.mdv h3{font-size:15.5px}
.mdv p,.mdv ul,.mdv ol,.mdv blockquote,.mdv pre,.mdtbl{margin:0 0 12px}
.mdv ul,.mdv ol{padding-left:22px}.mdv li{margin:3px 0}
.mdv li.task{list-style:none;margin-left:-18px}
.mdv a{color:var(--ok);text-decoration:none}.mdv a:hover{text-decoration:underline}
.mdv code{font:12.5px var(--mono);background:var(--pop);padding:2px 5px;border-radius:5px}
.mdv pre{background:var(--card2);border:1px solid var(--bd2);border-radius:var(--r);padding:12px 14px;overflow-x:auto;position:relative}
.mdv pre code{background:none;padding:0;display:block;line-height:1.55}
.mdv pre[data-lang]::after{content:attr(data-lang);position:absolute;top:6px;right:10px;color:var(--dimmer);font:11px var(--mono)}
.mdv blockquote{border-left:3px solid var(--ok-bd);padding:2px 14px;color:var(--mut)}
.mdv hr{border:0;border-top:1px solid var(--bd2);margin:20px 0}
.mdtbl{overflow-x:auto}
.mdv table{border-collapse:collapse;font-size:13.5px}
.mdv th,.mdv td{border:1px solid var(--bd2);padding:6px 10px;text-align:left}
.mdv th{background:var(--card2);color:var(--title)}
.mdv img{max-width:100%;border-radius:var(--r)}
.mdmmd{overflow-x:auto;margin:0 0 12px;text-align:center;cursor:zoom-in}
.mdmmd.full{cursor:zoom-out;text-align:left}`;

// ```mermaid fences: the server renderer leaves them as <pre data-lang="mermaid">; this swaps
// each for its SVG in the browser. Emitted ONLY on /md pages that have one. securityLevel
// strict because docs come from anywhere (same reasoning as safeUrl). A block that fails to
// parse keeps its source visible, with the parser error as its tooltip. Wide diagrams
// (real flowcharts/sequences run 1000-2800px) start fitted to the column as an overview;
// a tap toggles natural size, scrolled sideways inside the .mdmmd box.
// ponytail: CDN-loaded (major-pinned) — vendor the file if the box must render offline.
const MD_MERMAID = `<script type="module">
import mermaid from 'https://cdn.jsdelivr.net/npm/mermaid@12/dist/mermaid.esm.min.mjs';
mermaid.initialize({ startOnLoad: false, theme: 'dark', securityLevel: 'strict' });
let n = 0;
for (const pre of document.querySelectorAll('.mdv pre[data-lang="mermaid"]')) {
  const id = 'mmd' + n++;
  try {
    const { svg } = await mermaid.render(id, pre.textContent);
    const d = document.createElement('div'); d.className = 'mdmmd'; d.innerHTML = svg; pre.replaceWith(d);
    const g = d.querySelector('svg'), w = g.viewBox.baseVal.width;
    d.onclick = () => { const on = d.classList.toggle('full');
      g.style.maxWidth = on ? 'none' : w + 'px'; g.style.width = on ? w + 'px' : ''; };
  } catch (e) { pre.title = 'mermaid: ' + ((e && e.message) || e); document.getElementById('d' + id)?.remove(); }
}
</script>`;

function mdInline(s) { // s is already HTML-escaped; stash code spans so marks inside stay literal
  const keep = [];
  s = s.replace(/`([^`]+)`/g, (_, c) => (keep.push(`<code>${c}</code>`), `\x00${keep.length - 1}\x00`));
  // scheme allowlist: markdown files come from anywhere (cloned repos, downloads) — a
  // [link](javascript:…) must not become a live URI. Relative paths stay allowed (the
  // /md?f= rewrite in mdView picks them up).
  const safeUrl = u => /^(https?:|mailto:|#|\.{0,2}\/|[^:]+$)/i.test(u) ? u : '#';
  s = s
    .replace(/!\[([^\]]*)\]\(([^)\s]+)\)/g, (_, a, u) => `<img alt="${a}" src="${safeUrl(u)}">`)
    .replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, (_, t, u) => `<a href="${safeUrl(u)}">${t}</a>`)
    .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
    .replace(/(^|[\s(])\*([^*\s][^*]*)\*/g, '$1<em>$2</em>')
    .replace(/~~([^~]+)~~/g, '<del>$1</del>')
    .replace(/(^|[\s(])(https?:\/\/[^\s<)]+)/g, '$1<a href="$2">$2</a>');
  return s.replace(/\x00(\d+)\x00/g, (_, i) => keep[i]);
}

function mdList(items) { // ponytail: one nesting level (indent >= 2), enough for real docs
  const li = t => { const task = t.match(/^\[( |x|X)\]\s+(.*)/);
    return task ? `<li class="task"><input type="checkbox" disabled${task[1] === ' ' ? '' : ' checked'}> ${mdInline(task[2])}</li>`
                : `<li>${mdInline(t)}</li>`; };
  const base = items[0].ind, ord = items[0].ord;
  let html = '', sub = [], subOrd = false;
  const closeSub = () => { if (sub.length) {
    html = html.replace(/<\/li>$/, `<${subOrd ? 'ol' : 'ul'}>${sub.join('')}</${subOrd ? 'ol' : 'ul'}></li>`); sub = []; } };
  for (const it of items) {
    if (it.ind > base && html) { subOrd = it.ord; sub.push(li(it.text)); }
    else { closeSub(); html += li(it.text); }
  }
  closeSub();
  return `<${ord ? 'ol' : 'ul'}>${html}</${ord ? 'ol' : 'ul'}>`;
}

export function mdHtml(src) {
  const lines = esc(src.replace(/\r\n?/g, '\n')).split('\n');
  const out = []; let para = [], i = 0;
  const flush = () => { if (para.length) { out.push(`<p>${mdInline(para.join(' '))}</p>`); para = []; } };
  while (i < lines.length) {
    const l = lines[i];
    const fence = l.match(/^```(\w*)/);
    if (fence) {
      const buf = []; i++;
      while (i < lines.length && !/^```/.test(lines[i])) buf.push(lines[i++]);
      i++; flush();
      out.push(`<pre${fence[1] ? ` data-lang="${fence[1]}"` : ''}><code>${buf.join('\n')}</code></pre>`);
      continue;
    }
    const h = l.match(/^(#{1,6})\s+(.*)/);
    if (h) { flush(); const n = h[1].length; out.push(`<h${n}>${mdInline(h[2])}</h${n}>`); i++; continue; }
    if (/^ {0,3}(-{3,}|_{3,}|\*{3,})\s*$/.test(l)) { flush(); out.push('<hr>'); i++; continue; }
    if (/^(\s*)([-*+]|\d+[.)])\s+/.test(l)) {
      flush(); const items = [];
      while (i < lines.length) {
        const m = lines[i].match(/^(\s*)([-*+]|\d+[.)])\s+(.*)$/);
        if (m) { items.push({ ind: m[1].length, ord: /\d/.test(m[2]), text: m[3] }); i++; }
        else if (/^\s{2,}\S/.test(lines[i])) { items[items.length - 1].text += ' ' + lines[i++].trim(); }
        else break;
      }
      out.push(mdList(items)); continue;
    }
    if (/^&gt;\s?/.test(l)) { // '>' arrives escaped
      flush(); const buf = [];
      while (i < lines.length && /^&gt;\s?/.test(lines[i])) buf.push(lines[i++].replace(/^&gt;\s?/, ''));
      out.push(`<blockquote>${buf.join('\n').split(/\n{2,}|\n(?=\s*$)/).filter(x => x.trim())
        .map(x => `<p>${mdInline(x.replace(/\n/g, ' '))}</p>`).join('')}</blockquote>`);
      continue;
    }
    if (l.includes('|') && i + 1 < lines.length && /-/.test(lines[i + 1]) && /^\s*\|?[-: |]+\|[-: |]*\s*$/.test(lines[i + 1])) {
      flush();
      const cells = r => r.replace(/^\s*\|/, '').replace(/\|\s*$/, '').split('|').map(c => mdInline(c.trim()));
      const head = cells(l); i += 2; const rows = [];
      while (i < lines.length && lines[i].includes('|')) rows.push(cells(lines[i++]));
      out.push(`<div class="mdtbl"><table><thead><tr>${head.map(c => `<th>${c}</th>`).join('')}</tr></thead><tbody>${
        rows.map(r => `<tr>${r.map(c => `<td>${c}</td>`).join('')}</tr>`).join('')}</tbody></table></div>`);
      continue;
    }
    if (!l.trim()) { flush(); i++; continue; }
    para.push(l.trim()); i++;
  }
  flush();
  return out.join('\n');
}


// the two documents lite.mjs answers with when nothing matched or a route threw
export const notFoundPage = () => page('404', '<p>not found. <a href="/">← sessions</a></p>');
export const errorPage = msg => page('error', `<p>error: ${esc(msg)}</p>`);

// /md's two documents, built from what routes/md.mjs has already checked: the notice for a refused file and the rendered file.
export const mdNotice = m => page('markdown', `<h1><a href="/">mows</a></h1><p style="margin:18px 0">${esc(m)}</p><p><a href="/">← sessions</a></p>`);
// the file's rendered body and title, for both /md documents (the legacy page below and routes/md.mjs's, which links the built stylesheets)
export function mdParts(real, st, src) {
  let art = /\.txt$/i.test(real) ? `<pre>${esc(src)}</pre>` : mdHtml(src);
  // cross-references between docs stay browsable: relative links resolve through /md too
  art = art.replace(/href="(?!https?:|mailto:|#|\/)([^"]+)"/g,
    (_, rl) => `href="/md?f=${encodeURIComponent(path.resolve(path.dirname(real), rl))}"`);
  const kb = st.size < 1024 ? `${st.size} B` : `${(st.size / 1024).toFixed(1)} KB`;
  const when = rel(st.mtimeMs) === 'now' ? 'just now' : `${rel(st.mtimeMs)} ago`;
  const body = `<h1><a href="/">mows</a></h1>
<div class="mdhead"><b>${esc(path.basename(real))}</b><span>${esc(real)}</span><span>${kb} · updated ${when}</span><a class="mddl" href="/md?f=${encodeURIComponent(real)}&amp;dl=1" download>⬇ Download</a></div>
<article class="mdv">${art}</article>`;
  return { title: `${path.basename(real)} · mows`, body, mermaid: art.includes('data-lang="mermaid"') };
}
export function mdDocument(real, st, src, host) {
  const { title, body, mermaid } = mdParts(real, st, src);
  return page(title, body, `<style>${MD_CSS}</style>${mermaid ? MD_MERMAID : ''}`, '', '', false, null, host);
}

// ---------- page chrome, shared by BOTH document shapes ----------
//
// The desktop header, the pinned bottom tab bar and the terminal FAB, built once and used by
// page() below (every server-rendered route) AND by uiShellHtml() (the SPA at /ui).
//
// Extracted rather than copied, and this is the whole point of it: /ui shipped for an entire
// branch with NO tab bar at all. Spec §2 lists the pinned bar under "Kept"; what actually shipped
// was a document containing `<div id="app">` and a `<noscript>`, so with JavaScript on there was
// no link out of the app to /, /history, /system, /device or /agents — the only way back was the
// Back button or typing a URL (final review, H1). A second bar written to fix that is how the two
// disagree six months from now, so there is one bar and one place to change it.
//
// agentsHref is the one thing that legitimately differs. During the §6 migration BOTH /agents and
// /ui/agents are real pages: from a server-rendered page the Agents tab must go to the twin, and
// from inside the SPA it must keep you in the SPA rather than ejecting you to the twin you just
// navigated away from. One parameter, defaulting to the server-rendered answer.
//
// desktop header (mock 2026-08-29): logo+title/subtitle, centered pill nav, "+ new session"
// button; .navdup hides the whole thing <700px where the mobile <h1> + tab bar rule instead (see
// body>h1 in CSS). liveN: live-session count badge — only pages that already computed tmuxLive
// pass it; fleet.js keeps it fresh (id=pnav-live) on pages that carry the island. host: real
// request Host header — SPEC text mapping ("connected · <host>"), never a hardcoded address.
// agentsHref defaults to the APP now (2026-09-19). Until this flip every server-rendered page's
// Agents tab — header and bottom bar — led to the server-rendered /agents, where a chat turn is a
// form POST, a 303 and "Thinking… reload in a few seconds"; only the SPA shell pointed the tab at
// /ui/agents. From the home page a person never reached the streaming view at all, and the first
// real user test read as "the SPA is not working" while three turns streamed fine server-side.
// The SPA design (§6) shipped both models and deferred this flip until the app was proven; it
// is — probes in both engines, live turns, memory. /agents/<name> stays reachable by URL and as
// the <noscript> twin.
export function pageChrome(tab = '', liveN = null, host = '', agentsHref = '/ui/agents', base = '') {
  const pnav = `<nav class="pnav">
<a class="${tab === 'sessions' ? 'on' : ''}" href="${base}/">Sessions${liveN != null ? ` <b class="pbdg" id="pnav-live"${liveN ? '' : ' hidden'}>${liveN}</b>` : ''}</a>
<a class="${tab === 'history' ? 'on' : ''}" href="${base}/history">History</a>
<a class="${tab === 'system' ? 'on' : ''}" href="${base}/system">System</a>
<a class="${tab === 'device' ? 'on' : ''}" href="${base}/device">Device</a>
<a class="${tab === 'agents' ? 'on' : ''}" href="${agentsHref}">Agents</a></nav>`;
  const hdr = `<header class="hdr navdup">
<div class="hdl"><span class="hlogo" aria-hidden="true">&gt;_</span><div class="hcol"><div class="htitle">mows control</div><div class="hsub">Connected · ${esc(host || os.hostname())}</div></div></div>
${pnav}
<a class="hnew" href="${termHref('menu', '')}">${ICO.plus}<span class="hnew-lbl">New Session</span></a></header>`;
  const tabs = `<nav class="tabs">
<a class="tb${tab === 'sessions' ? ' on' : ''}" href="${base}/"><span class="ti">${ICO.list}</span>Sessions</a>
<a class="tb${tab === 'history' ? ' on' : ''}" href="${base}/history"><span class="ti">${ICO.history}</span>History</a>
<a class="tb${tab === 'system' ? ' on' : ''}" href="${base}/system"><span class="ti">${ICO.activity}</span>System</a>
<a class="tb${tab === 'device' ? ' on' : ''}" href="${base}/device"><span class="ti">${ICO.monitorSmartphone}</span>Device</a>
<a class="tb${tab === 'agents' ? ' on' : ''}" href="${agentsHref}"><span class="ti">${ICO.wrench}</span>Agents</a></nav>`;
  // terminal is an ACTION (opens the ttyd session picker), not a content page — kept as a
  // persistent floating utility button (every tab, every width) instead of a nav tab of its
  // own (gap #5: nav read sessions·history·system·device, exactly 4, until the Agents tab
  // (2026-09-15) made it five content tabs — terminal is still a FAB, never a 6th).
  const termFab = `<a class="termfab" href="${termHref('menu', '')}" title="open terminal" aria-label="open terminal">${ICO.terminal}</a>`;
  return { hdr, tabs, termFab };
}


// head metas and footer shared by page() and the /next shell, so the manifest link, icons and PWA metas cannot drift apart (K-20)
export const DOC_META = `<meta name="viewport" content="width=device-width,initial-scale=1,maximum-scale=1,user-scalable=no,viewport-fit=cover,interactive-widget=resizes-content">
<meta name="color-scheme" content="dark"><meta name="theme-color" content="#09090b">
<link rel="manifest" href="/manifest.webmanifest" crossorigin="use-credentials">
<link rel="icon" href="/favicon.png"><link rel="apple-touch-icon" href="/apple-touch-icon.png">
<meta name="mobile-web-app-capable" content="yes"><meta name="apple-mobile-web-app-capable" content="yes">
<meta name="apple-mobile-web-app-status-bar-style" content="black-translucent">`;

export const footerHtml = () => `<footer><a href="/oauth2/sign_out">sign out</a><span>lite · no-js · ${index.length} indexed</span><span id="envout"></span></footer>`;

function page(title, body, head = '', bodyClass = '', tab = '', fleetJs = false, liveN = null, host = '') {
  const { hdr, tabs, termFab } = pageChrome(tab, liveN, host);
  return `<!doctype html><html lang="en"><head><meta charset="utf-8">
${DOC_META}${head}
<script type="speculationrules">{"prerender":[{"where":{"and":[{"href_matches":["/","/?*","/history","/history?*","/system","/device","/s/*","/agents","/agents?*","/agents/*"]},{"not":{"selector_matches":"a[href*='fresh=1'],a[href*='reclaim=1'],a[data-norun],a[href^='/ui']"}}]},"eagerness":"moderate"}]}</script>
<title>${esc(title)}</title><style>${cssText()}</style></head><body class="${bodyClass}">${hdr}${termFab}${body}
${tabs}${footerHtml()}
<script>if('serviceWorker' in navigator)navigator.serviceWorker.register('/sw.js');
/* a POST-redirect-GET action shows its work while it runs (docker prune can take 8 s); bfcache restore clears it */
document.addEventListener('submit',function(e){e.target.classList.add('busy')});
addEventListener('pageshow',function(){document.querySelectorAll('form.busy').forEach(function(f){f.classList.remove('busy')})});
/* attach / >_ open the session in its OWN window on a desktop or tablet BROWSER, so the
   dashboard stays put and pause/kill/the other sessions stay one click away. NOT in the
   installed PWA: there is no second window there, and target=_blank throws the user out to
   the system browser and off the app — same reason phone-width (<700px, the layout
   breakpoint this file uses everywhere) stays in place. The target is named per session
   (data-nw), so clicking one twice reuses its window instead of opening a rival tmux
   client, which would detach the first (attach -d). Deliberately no rel=noopener: with
   it the spec ignores the window name and every click spawns another window, and the page
   opened is our own /term on this origin. JS off => in place, exactly as before. Embed mode
   JS off => in place, exactly as before. */
if(matchMedia('(display-mode: browser)').matches&&innerWidth>=700&&matchMedia('(pointer:fine)').matches)
  document.querySelectorAll('a[data-nw]').forEach(function(a){a.target=a.dataset.nw});
/* pointer:fine is load-bearing, not decoration: a phone in landscape is >=700px wide, and without
   it the attach link there opened a second window instead of navigating, so the session looked
   unreachable (found by mobile-journey.mjs's landscape case, 2026-08-26). Named windows are a
   mouse affordance; a touch device has no second window to put them in. */
/* ccdiag: install-mode + safe-area readout in the footer (e.g. "app · sat59 sab34")
   so device rendering issues can be diagnosed without guessing */
(function(){var o=document.getElementById('envout');if(!o)return;
var p=document.createElement('div');
p.style.cssText='position:fixed;visibility:hidden;pointer-events:none;padding:env(safe-area-inset-top,0px) 0 env(safe-area-inset-bottom,0px)';
document.body.appendChild(p);var s=getComputedStyle(p);
/* measure AFTER layout settles — env() reads 0 too early on iOS cold start */
setTimeout(function(){requestAnimationFrame(function(){
var s2=getComputedStyle(p);
var m=(matchMedia('(display-mode: standalone)').matches?'app':'tab'),t=parseFloat(s2.paddingTop)|0,b=parseFloat(s2.paddingBottom)|0;
o.textContent=m+' · sat'+t+' sab'+b;
var u=document.createElement('div');
u.style.cssText='position:fixed;visibility:hidden;pointer-events:none;top:0;left:0;width:1px;height:100lvh';
document.body.appendChild(u);var lvh=u.getBoundingClientRect().height|0;
u.style.height='100dvh';var dvh=u.getBoundingClientRect().height|0;u.remove();
p.remove();var vv=window.visualViewport;
fetch('/z?t=dash3&m='+m+'&sat='+t+'&sab='+b+'&ih='+innerHeight+'&sh='+screen.height+'&oh='+outerHeight+'&sy='+(window.screenY|0)+'&vh='+(vv?vv.height|0:0)+'&dh='+document.documentElement.clientHeight+'&lvh='+lvh+'&dvh='+dvh).catch(function(){})
})},700)})();
/* vpfix: iOS standalone can launch/resume with the layout viewport short by the top
   safe-area inset (dash3 measured ih=894 vs sh=956, vh=894 — nothing paints below it,
   so the bottom tab bar either clips or floats above the real screen bottom; a
   navigation sometimes snaps it back, which is why other tabs looked fine). Viewport-meta
   rewrites are IGNORED in standalone (tried 2026-08-30: beacons show ok=0 n=6 ih=894);
   the workaround that works (dev.to/cederhook, same bug) is a synchronous display:none →
   reflow → restore on the full-height element — WebKit re-measures the viewport, no
   visible flash since it's all within one frame. Portrait-only: iOS screen.height is
   portrait-fixed, so landscape always reads "short". Beacons the outcome to /z. */
(function(){
if(!matchMedia('(display-mode: standalone)').matches)return;
var n=0;
function short(){return matchMedia('(orientation: portrait)').matches&&innerHeight+4<screen.height}
function heal(){
  if(!short())return;
  if(n>=6){
    /* in-page re-measures exhausted — a real navigation is the one thing measured to
       snap the viewport back (dash3 mixes 894 and 956 loads; tapping another tab fixed
       it). One reload per 30s, visible pages only, so a stubborn state can't loop. */
    var r=+sessionStorage.vpr||0;
    if(Date.now()-r>30000&&document.visibilityState==='visible'){sessionStorage.vpr=Date.now();return location.reload()}
    return fetch('/z?t=vpfix&ok=0&r=1&n='+n+'&ih='+innerHeight+'&p='+encodeURIComponent(location.pathname)).catch(function(){});
  }
  n++;
  var y=scrollY,b=document.body;
  b.style.display='none';void b.offsetHeight;b.style.display='';
  scrollTo(0,y);
  setTimeout(function(){
    if(short())heal();
    else fetch('/z?t=vpfix&ok=1&n='+n+'&ih='+innerHeight+'&p='+encodeURIComponent(location.pathname)).catch(function(){})
  },250);
}
addEventListener('pageshow',function(){n=0;setTimeout(heal,80)});
document.addEventListener('visibilitychange',function(){if(!document.hidden){n=0;setTimeout(heal,80)}});
addEventListener('resize',function(){n=0;setTimeout(heal,80)});
setTimeout(heal,120);
})();
/* pull-to-refresh — installed app only: a browser tab already has it natively, and a
   custom one there would fight the built-in gesture. Lives here in the base page script
   (NOT fleet.js) so it works on EVERY page — session view, /device, /md included.
   Never preventDefault (passive listeners), so scrolling stays untouched; arms at 60px. */
(function(){
if(!(matchMedia('(display-mode: standalone)').matches&&'ontouchstart' in window))return;
var ptr=document.createElement('div');ptr.id='ptr';ptr.innerHTML='${ICO.refresh}';document.body.appendChild(ptr);
var y0=0,armed=false;
addEventListener('touchstart',function(e){armed=scrollY<=0;y0=e.touches[0].clientY},{passive:true});
addEventListener('touchmove',function(e){
  if(!armed)return;
  var pull=e.touches[0].clientY-y0;
  if(pull>8&&scrollY<=0){var p=Math.min(pull/2,72);
    ptr.style.transform='translate(-50%,'+p+'px) rotate('+p*3+'deg)';
    ptr.style.opacity=Math.min(p/56,1);ptr.classList.toggle('go',p>=56)}
  else{ptr.style.opacity=0;ptr.classList.remove('go')}
},{passive:true});
addEventListener('touchend',function(){
  if(!armed)return;armed=false;
  if(ptr.classList.contains('go')){ptr.classList.add('spin');location.reload()}
  else{ptr.style.transform='';ptr.style.opacity=0}
},{passive:true});
})()</script>${fleetJs ? '<script defer src="/fleet.js"></script>' : ''}
</body></html>`;
}

// ---------- /fleet.js: dashboard live-update client island (Fleet Redesign §3) ----------
// One hand-written file, zero deps, ~200 lines. EventSource + reconnect; patches the
// server-rendered rows/cards in place by data-sid (see fleetRowHtml/fleetCardHtml/
// fleetMenu above — every element this file touches carries a data-f hook there, and
// changing one side without the other is the only way this can silently break).
// phase 3 (spec §3 tail): 1-9 attach the nth fleet row, '/' focuses the fleet filter if
// one exists else the /history search — both live in the keydown handler at the bottom,
// which runs on EVERY page fleet.js loads (not gated on hasFleet below), since '/' on
// /history must work with no fleet-rows/cards on the page at all.
export const FLEET_JS = `(function(){
'use strict';
var rowsC=document.getElementById('fleet-rows'),cardsC=document.getElementById('fleet-cards');
// hasFleet, not an early return: this page may still need the keydown handler below
// (e.g. /history, which has neither container) even with nothing here to live-patch.
var hasFleet=!!(rowsC&&cardsC&&typeof EventSource!=='undefined');
var emptyEl=hasFleet&&document.getElementById('fleet-empty');
if(hasFleet){
var GLYPH={'needs-you':'\\u25c9',working:'\\u25cf',paused:'\\u23f8',idle:'\\u25cb'};
var WORD={'needs-you':'waiting',working:'working',paused:'paused',idle:'idle'};
function esc(s){return String(s).replace(/[&<>"']/g,function(c){return{'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]})}
// mirrors the server's rel() exactly (lite.mjs) — same thresholds, same output shape
function relStr(ms){var s=(Date.now()-ms)/1000;return s<90?'now':s<5400?(s/60|0)+'m':s<129600?(s/3600|0)+'h':(s/86400|0)+'d'}
// mirrors fleetMetaHtml() server-side: status word + relative time (snippet is its own
// [data-f=snip] node in both layouts since the mock reskin)
function metaHtml(state,mt){return WORD[state]+' '+relStr(mt)}
function tabid(){var b=crypto.getRandomValues(new Uint8Array(4)),h='';for(var i=0;i<4;i++)h+=b[i].toString(16).padStart(2,'0');return h}
function attachHref(name){return '/term/?arg=attach&arg='+encodeURIComponent(name)+'&arg='+tabid()+'&v=3'}
// every field a live update can touch — glyph class/char, label, proj, meta line (word +
// time + snippet), the attach link, and the ⋯ menu's forms (pause<->resume swap, the
// name shown in it, the rename input's current value). Row order is NOT handled here —
// the caller appendChild()s the returned/patched node into place.
function patch(node,f){
  node.dataset.sid=f.sid8; node.dataset.state=f.state; node.dataset.mt=f.rel;
  var g=node.querySelector('[data-f=glyph]'); if(g){g.className='fli fli-'+f.state;g.textContent=GLYPH[f.state]}
  var lb=node.querySelector('[data-f=label]'); if(lb)lb.textContent=f.label||f.proj||f.name;
  var pj=node.querySelector('[data-f=proj]'); if(pj)pj.textContent=f.proj;
  var mt=node.querySelector('[data-f=meta]'); if(mt)mt.textContent=metaHtml(f.state,f.rel);
  var sn=node.querySelector('[data-f=snip]'); if(sn){sn.textContent=f.snippet;sn.style.display=f.snippet?'':'none'}
  var at=node.querySelector('[data-f=attach]'); if(at){at.href=attachHref(f.name);at.dataset.nw='t-'+f.name}
  var nl=node.querySelectorAll('[data-f=nameinput]'); for(var i=0;i<nl.length;i++)nl[i].value=f.name;
  var tn=node.querySelector('[data-f=tname]'); if(tn)tn.textContent=f.name;
  var kn=node.querySelector('[data-f=killname]'); if(kn)kn.textContent=f.name;
  var li=node.querySelector('[data-f=labelinput]'); if(li)li.value=f.label||'';
  var pf=node.querySelector('[data-f=pauseform]'),pb=node.querySelector('[data-f=pausebtn]');
  if(pf&&pb){
    if(f.state==='paused'){pf.action='/a/resume';pb.className='ab ok';pb.innerHTML='${ICO.play}Resume'}
    else{pf.action='/a/pause';pb.className='ab';pb.innerHTML='${ICO.pause}Pause'}
  }
}
function instantiate(tplId,f){
  var node=document.getElementById(tplId).content.firstElementChild.cloneNode(true);
  patch(node,f); return node;
}
// text filter (spec §3 phase 3, '/' focus target on '/'): matches label/proj/snippet,
// substring, case-insensitive. Toggled via style.display, not the hidden attribute —
// .li/.lp both carry their own display:flex, which an author rule always beats the UA
// default for [hidden]; see sn.style.display above for the same pattern in this file.
var filterEl=document.querySelector('[data-f=filter]');
function rowMatches(node,term){
  if(!term)return true;
  var lb=node.querySelector('[data-f=label]'),pj=node.querySelector('[data-f=proj]'),sn=node.querySelector('[data-f=snip]');
  var text=((lb?lb.textContent:'')+' '+(pj?pj.textContent:'')+' '+(sn?sn.textContent:'')).toLowerCase();
  return text.indexOf(term)!==-1;
}
function applyFilter(){
  var term=filterEl?filterEl.value.trim().toLowerCase():'';
  Array.prototype.forEach.call(rowsC.children,function(el){el.style.display=rowMatches(el,term)?'':'none'});
  Array.prototype.forEach.call(cardsC.children,function(el){el.style.display=rowMatches(el,term)?'':'none'});
}
if(filterEl)filterEl.addEventListener('input',applyFilter);
function render(list){
  var seen={};
  list.forEach(function(f){
    seen[f.sid8]=true;
    var sel='[data-sid="'+CSS.escape(f.sid8)+'"]';
    var r=rowsC.querySelector(sel); if(r)patch(r,f); else r=instantiate('fleet-row-tpl',f);
    rowsC.appendChild(r); // already-attached node: appendChild MOVES it — this is the reorder, no rebuild
    var c=cardsC.querySelector(sel); if(c)patch(c,f); else c=instantiate('fleet-card-tpl',f);
    cardsC.appendChild(c);
  });
  Array.prototype.filter.call(rowsC.children,function(el){return !seen[el.dataset.sid]}).forEach(function(el){el.remove()});
  Array.prototype.filter.call(cardsC.children,function(el){return !seen[el.dataset.sid]}).forEach(function(el){el.remove()});
  if(emptyEl)emptyEl.hidden=list.length>0;
  var cnt=document.getElementById('fleet-count'); if(cnt){cnt.textContent=list.length;cnt.hidden=list.length===0}
  var pb=document.getElementById('pnav-live'); if(pb){pb.textContent=list.length;pb.hidden=list.length===0}
  updateNums();
  applyFilter(); // keep the current filter applied across live patches/inserts/removals
}
// keeps the 1-9 keyboard badges (data-f=num, rows only) matching each row's CURRENT
// position after a reorder — the server only numbers the first render, every later
// number comes from here. Cards never carry a [data-f=num] node so querySelector below
// is just a no-op for them.
function updateNums(){
  var rows=rowsC.children;
  for(var i=0;i<rows.length;i++){
    var n=rows[i].querySelector('[data-f=num]'); if(n)n.textContent=i<9?String(i+1):'';
  }
}
// tick relative times every 30s locally, between snapshots — reads back the mt this node
// was last patched with (dataset.mt); skip nodes never patched yet (server markup carries
// no data-mt, and +undefined is NaN — relStr(NaN) would render "NaNd" if SSE never connects)
function tick(){
  var hosts=document.querySelectorAll('[data-sid]');
  for(var i=0;i<hosts.length;i++){
    var host=hosts[i],m=host.querySelector('[data-f=meta]'); if(!m||!host.dataset.mt)continue;
    m.textContent=metaHtml(host.dataset.state,+host.dataset.mt);
  }
}
setInterval(tick,30000);
var retry=1000;
function connect(){
  var es=new EventSource('/events');
  es.addEventListener('fleet',function(e){retry=1000;try{render(JSON.parse(e.data))}catch(err){}});
  es.onerror=function(){es.close();setTimeout(connect,retry+Math.random()*400);retry=Math.min(retry*2,30000)};
}
connect();
} // end if(hasFleet)
// desktop keys (spec §3 phase 3): 1-9 attach the nth fleet row (rows only — that is
// what the on-screen 1-9 badges number; cards have no keyboard affordance and no
// number), '/' focuses a fleet filter if the page has one, else the /history search
// when this page IS /history. Both branches no-op harmlessly on any other page.
document.addEventListener('keydown',function(e){
  if(e.defaultPrevented||e.altKey||e.ctrlKey||e.metaKey)return;
  var t=e.target,tag=t&&t.tagName;
  if(tag==='INPUT'||tag==='TEXTAREA'||(t&&t.isContentEditable))return; // never hijack typing
  if(e.key>='1'&&e.key<='9'){
    if(!rowsC)return; // this page has no fleet rows to number (e.g. /history)
    var row=rowsC.children[+e.key-1]; if(!row)return;
    var a=row.querySelector('[data-f=attach]'); if(!a)return;
    e.preventDefault(); a.click(); // click, not location=... : respects data-nw window-reuse as-is
    return;
  }
  if(e.key==='/'){
    var ff=document.querySelector('[data-f=filter]');
    if(ff){e.preventDefault();ff.focus();return}
    if(location.pathname==='/history'){
      // the filter lives inside a collapsed <details> (folded by default, see fOn in
      // listView) — a closed <details> refuses to focus its content in every browser,
      // so open it first (QA 2026-08-28: '/' left focus on BODY on first load).
      var det=document.querySelector('details.flt');
      var q=det&&det.querySelector('input[name=q]');
      if(q){det.open=true;e.preventDefault();q.focus();if(q.select)q.select()}
    }
  }
});
/* pull-to-refresh moved to the base page script (page()) 2026-08-30: living here meant
   it only existed on fleetJs pages — session view, /device and /md had no PTR at all. */
})();
`;


// ---------- views ----------
// one transcript row — /history's day-grouped list, and nothing else. It WAS shared with a
// "today" strip on '/', which the 2026-08-29 fleet reskin deleted (homeView's own header: "no
// system stats, no today list"). listView() is the only caller; an assertion that curls '/'
// looking for anything this function emits is looking at the wrong page (see 3b0c26c).
function sessionRowHtml(e, title, liveBySid, back) {
  const a = BY_ID[e.a], sid8 = e.sid.slice(0, 8);
  const isLive = liveBySid.has(sid8);
  const go = a.term && canResume(e.mt, isLive) ? `<a class="go" data-nw="t-${sid8}" href="${esc(isLive ? termHref('attach', liveBySid.get(sid8).name) : termHref('open', sid8))}" title="${isLive ? 'attach (live)' : 'resume in terminal'}" aria-label="${isLive ? 'attach in terminal (live)' : 'resume in terminal'}">&gt;_</a>` : '';
  const del = isLive ? '' : `<details class="kx del"><summary class="dx" title="delete transcript" aria-label="delete transcript ${sid8}">${ICO.x}</summary><div class="kc"><div>delete <b>${sid8}</b>?</div><span class="muted">removes the transcript from disk — no undo.</span><form class="af" method="post" action="/a/del"><input type="hidden" name="a" value="${e.a}"><input type="hidden" name="sid" value="${esc(e.sid)}"><input type="hidden" name="back" value="${esc(back)}"><button class="ab danger">Delete It</button></form></div></details>`;
  return `<div class="li"><a class="row" href="/s/${e.a}/${e.sid}">
<span class="t">${rel(e.mt)}</span>
<span class="acct" style="color:${a.color}">${a.label}</span>
<span class="proj">${esc(projName(e.proj))}</span>
<span class="ttl">${isLive ? '<span class="lvb"><span class="lvbd" aria-hidden="true"></span>LIVE</span> ' : ''}${esc(title) || '<span class="notitle">(no title)</span>'}</span>
<span class="sz">${fmtSz(e.sz)}</span><span class="sid">${sid8}</span></a>${go}${del}</div>`;
}

// ---------- fleet item rendering (Fleet Redesign §2, live-patched by fleet.js §3) ----------
// state glyph + word, per the spec table; colors are CSS classes now (.fli-<state>), not
// inline style — fleet.js flips the class on a live patch instead of touching style.color.
const FLEET_GLYPH = { 'needs-you': '◉', working: '●', paused: '⏸', idle: '○' };

const FLEET_WORD = { 'needs-you': 'waiting', working: 'working', paused: 'paused', idle: 'idle' };

const fleetWhen = mt => { const r = rel(mt); return r === 'now' ? 'now' : r; };

// word + relative time (mock reskin: the snippet is its own [data-f=snip] node in BOTH
// layouts now — rows line 2, cards below the meta line — so meta is just the status).
function fleetMetaHtml(f) {
  return `${FLEET_WORD[f.state]} ${fleetWhen(f.mt)}`;
}

// pause/resume + rename + kill folded behind ONE ⋯ popover (spec §2) — the tmux name
// (mono, copyable) lives in here too, demoted off the primary label. data-f hooks are
// fleet.js's ONLY contract with this markup: it clones this exact HTML from a <template>
// (see fleetTemplates() below) and never re-derives it, so a change here needs no client change.
function fleetMenu(f, back) {
  const l = f.l;
  const hid = (n, v, df = '') => `<input type="hidden" name="${n}" value="${esc(v)}"${df ? ` data-f="${df}"` : ''}>`;
  const pr = l.paused
    ? `<form class="af" method="post" action="/a/resume" data-f="pauseform">${hid('name', l.name, 'nameinput')}${hid('back', back)}<button class="ab ok" data-f="pausebtn">${ICO.play}Resume</button></form>`
    : `<form class="af" method="post" action="/a/pause" data-f="pauseform">${hid('name', l.name, 'nameinput')}${hid('back', back)}<button class="ab" data-f="pausebtn">${ICO.pause}Pause</button></form>`;
  const rn = `<form class="af lf" method="post" action="/a/label">${hid('name', l.name, 'nameinput')}${hid('back', back)}<span class="klbl">Rename</span><input class="li2" name="label" value="${esc(l.label || '')}" maxlength="60" placeholder="session name" aria-label="session name" data-f="labelinput"><button class="ab ok">Save</button></form>`;
  const kl = `<details class="kx"><summary class="ab danger">${ICO.x}Kill</summary><div class="kc"><div>stop <b data-f="killname">${esc(l.name)}</b>?</div><span class="muted">the process ends now — the transcript stays on disk, resume anytime.</span><form class="af" method="post" action="/a/kill">${hid('name', l.name, 'nameinput')}${hid('back', back)}<button class="ab danger">Kill It</button></form></div></details>`;
  return `<details class="kx" name="fm"><summary class="ab" title="more actions">${ICO.ellipsis}</summary><div class="kc">
<div class="tname" data-f="tname">${esc(l.name)}</div>${pr}${rn}${kl}</div></details>`;
}

// mock's Sessions card (2026-08-29): two lines — big title + colored status word at the
// right edge, snippet in dim mono below with the project tucked bottom-right. Actions
// (attach, ⋯, kbd badge) sit before the status word and fade in on hover (pointer:fine),
// like the history rows; opacity-only so nothing shifts when they appear.
function fleetRowHtml(f, back, idx) {
  const label = esc(f.label || f.proj || f.name);
  return `<div class="li" data-sid="${esc(fleetKey(f))}" data-state="${f.state}"><div class="frow">
<div class="fr1">
<span class="fli fli-${f.state}" aria-hidden="true" data-f="glyph">${FLEET_GLYPH[f.state]}</span>
<span class="lb" data-f="label">${label}</span>
<span class="proj" data-f="proj">${esc(f.proj)}</span>
<span class="fact"><span class="fnum" data-f="num" aria-hidden="true">${idx != null && idx < 9 ? idx + 1 : ''}</span><a class="go" data-nw="t-${esc(f.name)}" data-f="attach" href="${esc(termHref('attach', f.name))}" title="attach" aria-label="attach ${esc(f.name)}">&gt;_</a>${fleetMenu(f, back)}</span>
<span class="fst" data-f="meta">${fleetMetaHtml(f)}</span>
</div>
<span class="fsnip" data-f="snip"${f.snippet ? '' : ' style="display:none"'}>${esc(f.snippet)}</span>
</div></div>`;
}

function fleetCardHtml(f, back) {
  const label = esc(f.label || f.proj || f.name);
  return `<div class="lp" data-sid="${esc(fleetKey(f))}" data-state="${f.state}">
<div class="lr fchd" style="justify-content:space-between">
<span class="lb"><span class="fli fli-${f.state}" aria-hidden="true" data-f="glyph">${FLEET_GLYPH[f.state]}</span> <span data-f="label">${label}</span></span>
<span class="fcact"><a class="ab ok" data-nw="t-${esc(f.name)}" data-f="attach" href="${esc(termHref('attach', f.name))}" title="attach" aria-label="attach ${esc(f.name)}" style="font:700 13px var(--mono)">&gt;_</a>${fleetMenu(f, back)}</span>
</div>
<div class="muted" style="font-size:12.5px"><span data-f="proj">${esc(f.proj)}</span> · <span data-f="meta">${FLEET_WORD[f.state]} ${fleetWhen(f.mt)}</span></div>
<div class="fsnip" data-f="snip" style="font-size:12.5px${f.snippet ? '' : ';display:none'}">${esc(f.snippet)}</div>
</div>`;
}

// hidden <template>s fleet.js clones to insert a session that wasn't on the page yet — built
// from the SAME fleetRowHtml/fleetCardHtml/fleetMenu functions real rows use (a placeholder
// object, values irrelevant: every data-f node gets overwritten on instantiation), so the
// template can never drift from what a fresh page load would have rendered for that row.
function fleetTemplates(back) {
  const ph = { name: 'x', sid8: 'x', label: '', proj: '', state: 'idle', mt: Date.now(), snippet: 'x',
               l: { name: 'x', paused: false, label: '' } };
  return `<template id="fleet-row-tpl">${fleetRowHtml(ph, back)}</template><template id="fleet-card-tpl">${fleetCardHtml(ph, back)}</template>`;
}

function renderFleet(fleet, back) {
  // idx feeds fleetRowHtml's 1-9 keyboard-nav badge (§3 phase 3) — cards never show it,
  // so no idx there.
  const rows = fleet.map((f, i) => fleetRowHtml(f, back, i)).join('');
  const cards = fleet.map(f => fleetCardHtml(f, back)).join('');
  // the two list containers always render (even empty) so fleet.js has a stable place to
  // append into without a reload; CSS hides an empty one (.fleet-rows:empty), and the
  // "no live sessions" line toggles via the plain `hidden` attribute, not display juggling
  // that would fight the responsive rows/cards breakpoint rule.
  return `<p class="muted" id="fleet-empty"${fleet.length ? ' hidden' : ''} style="padding:8px 4px 16px">no live sessions.</p>
<div class="fleet-rows" id="fleet-rows">${rows}</div>
<div class="fleet-cards" id="fleet-cards">${cards}</div>
${fleetTemplates(back)}`;
}

// ---------- /: fleet-first home (Fleet Redesign §2, reskin 2026-08-29) ----------
// h1 + fleet only — matches the mock's Sessions tab exactly: no system stats, no today
// list. System metrics now have their own tab (/system) and recent-session browsing lives
// entirely on /history (which already groups by day) — see the server routing block for
// the old-link redirects that keep both moved flows reachable.
export async function homeView(req, res, url) {
  freshen();
  const fleet = await fleetState();
  const body = `<h1><a href="/">mows</a></h1>
<div class="sect">fleet <b id="fleet-count"${fleet.length ? '' : ' hidden'}>${fleet.length}</b><input type="search" data-f="filter" placeholder="filter…" aria-label="filter fleet sessions" autocomplete="off" style="margin-left:8px;width:120px;min-height:0;padding:3px 8px;vertical-align:middle"></div>
${renderFleet(fleet, '/')}
<a class="newcard" href="${termHref('menu', '')}">+ New Session · open terminal picker</a>`;
  send(req, res, 200, page('mows sessions', body, '', '', 'sessions', true, fleet.length, req.headers.host));
}

// ---------- /system: host + usage metrics as their own page (gap #2) ----------
// Same sysPanel the strip used to render on '/', now flat/always-expanded on its own tab.
// ?fresh=1 / reclaim=1 / freed=&rn= keep working exactly as before, just targeting /system.
export async function systemView(req, res, url) {
  const rec = { href: '/system?reclaim=1', back: '/system' };
  if (url.searchParams.get('reclaim')) { rec.scan = await reclaimScan(); rec.href = '/system'; }
  if (url.searchParams.get('freed')) {
    rec.freed = +url.searchParams.get('freed') || 0;
    rec.n = +url.searchParams.get('rn') || 0;
  }
  const [live, ver, deployStat] = await Promise.all([
    tmuxLive(), claudeVersion(), fsp.stat(new URL('./lite.mjs', import.meta.url)).catch(() => null),
  ]);
  const extra = { live, ver, deployMt: deployStat ? deployStat.mtimeMs : null,
    rsN: +url.searchParams.get('rs') || 0 };
  const body = `<h1><a href="/">mows</a> <span class="muted">· system</span></h1>
${sysPanel('/system?fresh=1', true, rec, true, extra)}`;
  send(req, res, 200, page('system · mows sessions', body,
    usageCache.busy ? '<meta http-equiv="refresh" content="4">' : '', '', 'system', false, null, req.headers.host));
}

function pager(base, params, cur, max, extra = '') {
  // spec: four icon-only 32×32 buttons — same first/prev/next/last targets as before,
  // just chevron glyphs instead of "prev"/"next" text; aria-label keeps them a11y-named.
  const link = (p, txt, label) => p >= 1 && p <= max && p !== cur
    ? `<a href="${base}${qs({ ...params, page: p > 1 ? p : '' })}" aria-label="${label}" title="${label}">${txt}</a>`
    : `<span class="off" aria-hidden="true">${txt}</span>`;
  return `<nav class="pg">${link(1, ICO.chevronsLeft, 'first page')}${link(cur - 1, ICO.chevronLeft, 'previous page')}
<span class="pgnum"><span class="cur">${cur}</span><span class="muted">/ ${max}</span></span>${extra}
${link(cur + 1, ICO.chevronRight, 'next page')}${link(max, ICO.chevronsRight, 'last page')}</nav>`;
}

export async function listView(req, res, url) {
  freshen();
  const { sub, acct, q, d, s, live, liveBySid, rows, max, cur, slice, titles } = await historyQuery(url, req.headers.host);
  const P = { acct, q, d, s };
  const back = url.pathname + url.search;

  // .sel is the neutral "this is the selected filter" pill (mirrors .pnav a.on); .on
  // stays reserved for the genuinely-live "live N" chip below, styled green.
  const chip = (over, label, on, cls = 'sel') => `<a class="chip${on ? ' ' + cls : ''}" href="/history${qs({ ...P, ...over })}">${label}</a>`;
  const chips = [chip({ acct: '' }, `all <b>${index.length}</b>`, !acct)]
    .concat(ACCTS.map(a => chip({ acct: a.id },
      `<span class="dot" style="background:${a.color}"></span>${a.label} <b>${counts[a.id] || 0}</b>`, acct === a.id))).join('');
  const dchips = [['', 'all time'], ['today', 'today'], ['7d', '7 days'], ['30d', '30 days']]
    .map(([v, l]) => chip({ d: v }, l, d === v)).join('')
    + chip({ s: s === 'live' ? '' : 'live' },
      `<span class="dot" style="background:var(--ok)"></span>live <b>${liveBySid.size}</b>`, s === 'live', 'on');

  // no live-fleet panel or system strip here anymore (reskin 2026-08-29): the home
  // page owns those; /history is purely the archive — filter + day-grouped list + pager.
  let lastDay = '', items = '';
  slice.forEach((e, i) => {
    const dl = dayLbl(e.mt);
    if (dl !== lastDay) { items += `<div class="day">${dl}</div>`; lastDay = dl; }
    items += sessionRowHtml(e, titles[i].title, liveBySid, back);
  });

  const label = HOST_ACCT[sub] ? sub : '';
  // filters are power-user controls — folded away by default; auto-open (and
  // summarized) whenever the URL carries one so active state is never hidden
  const fOn = !!(url.searchParams.get('acct') || d || s || q);
  const fState = [acct && BY_ID[acct] ? BY_ID[acct].label : 'all',
    ({ today: 'today', '7d': '7 days', '30d': '30 days' })[d] || 'all time']
    .concat(s === 'live' ? ['live'] : [], q ? ['“' + esc(q) + '”'] : []).join(' · ');
  const body = `<h1><a href="/">mows</a> <span class="muted">· history</span>${label ? ` <span class="muted">· ${esc(label)}</span>` : ''}</h1>
<details class="sys flt"${fOn ? ' open' : ''}><summary><span class="syst">${ICO.search}filter</span><span class="syss">${fState} · <b>${rows.length}</b>${fOn ? ` of ${index.length}` : ''} sessions</span></summary>
<div class="sysbody"><div class="bar">${chips}</div>
<div class="bar">${dchips}
<form action="/history" method="get">${['acct', 'd', 's'].map(k => P[k] ? `<input type="hidden" name="${k}" value="${esc(P[k])}">` : '').join('')}
<div class="fsw"><span class="fico" aria-hidden="true">${ICO.search}</span><input type="search" name="q" value="${esc(q)}" placeholder="filter path / id…" aria-label="Filter by project path or session id"></div></form></div></div></details>
${items ? `<div class="hlist">${items}</div>` : '<p class="muted" style="padding:20px 0">no sessions match.</p>'}
${pager('/history', P, cur, max, `<span class="pgtot">${rows.length} total</span>`)}`;
  send(req, res, 200, page('history · mows sessions', body, '', '', 'history', true, live.length, req.headers.host));
}


export async function detailView(req, res, a, sid) {
  freshen();
  const e = index.find(x => x.a === a && x.sid === sid);
  if (!e) return send(req, res, 404, page('not found', '<p>session not found. <a href="/">← back</a></p>'));
  let s;
  try { s = await loadSession(e); }
  catch (err) { return send(req, res, 500, page('error', `<p>could not read transcript: ${esc(err.message)}</p>`)); }
  const acct = BY_ID[a], sid8 = sid.slice(0, 8);
  const url = new URL(req.url, 'http://x');
  const n = s.msgs.length, max = Math.max(1, Math.ceil(n / MSG_PAGE));
  const cur = Math.min(max, Math.max(1, +(url.searchParams.get('page') || 1) || 1));
  // page 1 = newest slice; render chronologically within the page
  const end = n - (cur - 1) * MSG_PAGE, start = Math.max(0, end - MSG_PAGE);
  const lv = (await tmuxLive()).find(l => liveSid8(l) === sid8);
  const live = !!lv;

  const msgs = s.msgs.slice(start, end).map(m => {
    if (m.role === 'tool') return `<details><summary>${ICO.wrench} ${esc(m.name)}</summary><pre>${esc(m.text)}</pre></details>`;
    if (m.role === 'res') return `<details><summary>↳ result</summary><pre>${esc(m.text)}</pre></details>`;
    if (m.role === 'sum') return `<details><summary>⟲ compaction summary</summary><pre>${esc(m.text)}</pre></details>`;
    const who = m.role === 'user' ? 'you' : 'claude';
    const big = m.text.length > 2500;
    const body = big
      ? `<details><summary>${esc(m.text.slice(0, 200))}…</summary><pre>${esc(m.text)}</pre></details>`
      : `<pre>${esc(m.text)}</pre>`;
    return `<div class="m ${m.role}"><div class="mh"><b>${who}</b> · ${m.ts ? esc(m.ts.slice(11, 19)) : ''}</div>${body}</div>`;
  }).join('');

  const term = acct.term
    ? (canResume(e.mt, live)
      ? `<div class="la" style="justify-content:flex-start"><a class="btn" data-nw="t-${sid8}" href="${esc(live ? termHref('attach', lv.name) : termHref('open', sid8))}">&gt;_ ${live ? (lv.paused ? 'attach — paused' : 'attach — live now') : 'open in terminal'}</a>${lv ? actForms(lv, `/s/${a}/${sid}`) : ''}</div>`
      : `<p class="muted" style="margin:8px 0">resume disabled — idle ${rel(e.mt)} (cutoff ${RESUME_DAYS}d). transcript stays readable; resume manually with <span style="font-family:var(--mono)">cc -r</span> if you really need it.</p>`)
    : '';
  const pgr = pager(`/s/${a}/${sid}`, {}, cur, max,
    `<span class="pgtot">${n} items · newest first</span>`);
  const body = `<h1><a href="/">← sessions</a></h1>
<div class="meta">
<div>session</div><div>${esc(sid)} ${live ? '<span class="lvb"><span class="lvbd" aria-hidden="true"></span>LIVE</span>' : ''}</div>
<div>account</div><div style="color:${acct.color}">${acct.label}</div>
<div>project</div><div>${esc(s.meta.cwd || projName(e.proj))}</div>
<div>started</div><div>${abs(s.meta.firstTs)}</div>
<div>last</div><div>${abs(e.mt)} (${rel(e.mt)} ago)</div>
<div>size</div><div>${fmtSz(e.sz)} · ${n} items · ${s.meta.tools} tool calls${s.meta.model ? ' · ' + esc(s.meta.model) : ''}</div>
</div>
${term}
${s.truncated ? '<div class="note">large transcript — showing the most recent 8MB window.</div>' : ''}
${pgr}${msgs || '<p class="muted">no displayable messages.</p>'}${pgr}`;
  send(req, res, 200, page(`${sid8} · ${projName(e.proj)}`, body, '', 'sessions', '', false, null, req.headers.host));
}

const agentPill = s => `<span class="pill st-${esc(s || 'never')}">${esc(s || 'never')}</span>`;

const usd = n => '$' + (+n || 0).toFixed(2);

// Ceiling for the whole `mows-agent residents --json` call. Must stay comfortably ABOVE
// cmd_residents' own internal budget (agents/bin/mows-agent, RESIDENTS_BUDGET_SEC = 16s
// total, adaptively split across however many profiles are discovered) so a normal poll
// always finishes before this fires — if the two ever cross, a slow-but-real poll would
// get killed here and misreport as "poll failed" instead of returning real data.
const RESIDENTS_TIMEOUT_MS = 20000;

export async function agentsView(req, res) {
  const list = await agentsIndex();
  const rows = list.map(a => `<a class="agent card" href="/agents/${esc(a.name)}">
<b>${esc(a.name)}</b> ${agentPill(a.last?.state)}
<span class="muted">${a.last ? rel(Date.parse(a.last.last_event_at)) : 'never ran'} · ${a.total} runs · 7d ${usd(a.cost7d)}</span></a>`).join('');
  // Native background sessions: the daemon's own, not mows-agent's — read-only display,
  // never an action surface (spec D2, Phase 6). mows-agent residents already excludes
  // interactive sessions and claude-mem observer sessions (cwd prefix).
  //
  // runAs resolves '' on ANY error, including a timeout — indistinguishable from a genuine
  // empty response by content alone. JSON.parse('') throws, so we use "did parsing succeed"
  // as the failure signal instead of collapsing both into an empty list: a poll that timed
  // out or hit a missing/broken mows-agent must say so, never render as "0 sessions, none"
  // (byte-identical to a real quiet box otherwise — the bug this comment is guarding against).
  let residentsData = null;
  try { residentsData = JSON.parse(await runAs([], 'mows-agent', ['residents', '--json'], RESIDENTS_TIMEOUT_MS)); } catch {}
  const residentsFailed = residentsData === null;
  const resRows = (residentsData || []).flatMap(p => p.agents.map(a => `<li><b>${esc(a.name || a.id)}</b> ${agentPill(a.state)} <span class="muted">${esc(p.profile)} · ${esc(a.waitingFor || '')} · ${esc(a.cwd || '')}</span></li>`));
  const fold = residentsFailed
    ? `<details><summary>Native background sessions — poll failed</summary><ul><li class="muted">mows-agent residents timed out or errored; not necessarily empty, try reloading</li></ul></details>`
    : `<details><summary>Native background sessions (${resRows.length})</summary><ul>${resRows.join('') || '<li class="muted">none</li>'}</ul></details>`;
  const body = `<h1><a href="/">mows</a> <span class="muted">· agents</span></h1>
${rows || '<p class="muted">No agents yet. <code>install.sh --agents</code> seeds <code>harness-reviewer</code>; <code>mows-agent run harness-reviewer</code> makes the first record.</p>'}
${fold}`;
  send(req, res, 200, page('agents · mows control', body, '', '', 'agents', false, null, req.headers.host));
}

export async function agentDetailView(req, res, name) {
  if (!AGENT_RE.test(name)) { res.writeHead(404); return res.end(); }
  const a = (await agentsIndex()).find(x => x.name === name);
  if (!a) { res.writeHead(404); return res.end('no such agent'); }
  const timers = await agentTimers(name);
  const tsum = summarizeTimers(timers);
  const back = `/agents/${esc(name)}`;
  const btn = (act, label) => `<form method="post" action="/a/agent-${act}"><input type="hidden" name="name" value="${esc(name)}"><input type="hidden" name="back" value="${esc(back)}"><button>${label}</button></form>`;
  // 'mixed' (some of this agent's timers masked, some not) shows BOTH affordances — pause
  // acts on every remaining unpaused timer, resume on every masked one — rather than
  // guessing which single button the honest-but-ambiguous state should offer (review round 1).
  const timerBtns = tsum.state === 'paused' ? btn('resume', 'Resume')
    : tsum.state === 'mixed' ? btn('pause', 'Pause') + btn('resume', 'Resume')
    : btn('pause', 'Pause');
  const runs = a.recs.map(r => `<li><a data-norun href="/agents/${esc(name)}/${esc(r.run_id)}">${esc(r.run_id)}</a> ${agentPill(r.state)} <span class="muted">${usd(r.cost_usd)} · ${r.turns} turns · ${r.tool_calls} tools</span></li>`).join('');
  // No completed-run gate (spec 2026-09-19 §2.4): a chat turn no longer resumes a session, so
  // an agent that has never run can be asked what it would do. The gate that stood here was
  // true until the reason for it left; it did not stay on as "harmless extra strictness".
  const chat = await agentChat(name);
  const pending = chat.length && chat[chat.length - 1].role === 'user';
  const bubbles = chat.map(t => `<div class="m ${t.role === 'user' ? 'me' : 'claude'}"><div class="mh"><b>${t.role === 'user' ? 'you' : esc(name)}</b> <span class="muted">${esc((t.at || '').slice(11, 19))}${t.cost_usd ? ' · ' + usd(t.cost_usd) : ''}</span></div><pre>${esc(t.text || '')}</pre></div>`).join('');
  const chatBox = `${bubbles || '<p class="muted">No messages yet. Ask it anything about its territory.</p>'}
${pending ? '<p class="muted">Thinking… reload in a few seconds.</p>' : ''}
<form method="post" action="/a/agent-chat" class="chatf">
<input type="hidden" name="name" value="${esc(name)}"><input type="hidden" name="back" value="${esc(back)}">
<textarea name="msg" rows="2" placeholder="Ask ${esc(name)} about its last run…" required></textarea>
<button>Send</button></form>`;
  const body = `<h1><a href="/agents">← agents</a> <span class="muted">· ${esc(name)}</span></h1>
<p>${agentPill(a.last?.state)} <span class="muted">7d ${usd(a.cost7d)} · ${a.total} runs · Next: ${esc(tsum.label)}</span></p>
<div class="actions">${btn('run', 'Run now')}${timerBtns}${a.last?.state === 'working' ? btn('stop', 'Stop') : ''}</div>
<h2>Chat</h2>${chatBox}
<h2>Runs</h2><ul class="runs">${runs || '<li class="muted">none</li>'}</ul>
<h2>Events</h2><pre class="events">${esc(a.events.join('\n') || 'none')}</pre>`;
  send(req, res, 200, page(`${name} · agents`, body, '', '', 'agents', false, null, req.headers.host));
}

export async function agentRunView(req, res, name, run) {
  if (!AGENT_RE.test(name) || !RUN_RE.test(run)) { res.writeHead(404); return res.end(); }
  const dir = `${AGENTS_STATE}/${name}/runs/${run}`;
  let status = null, text = '';
  try { status = JSON.parse(await fsp.readFile(`${dir}/status.json`, 'utf8')); } catch { res.writeHead(404); return res.end('no such run'); }
  try {
    for (const l of (await fsp.readFile(`${dir}/stream.jsonl`, 'utf8')).split('\n')) {
      if (!l.includes('"type":"assistant"')) continue;
      try { for (const c of JSON.parse(l).message?.content || []) if (c.type === 'text') text += c.text + '\n\n'; } catch {}
    }
  } catch {}
  // .mdv (the /md route's RENDERED-markdown style) has no whitespace handling of its own —
  // wrapping raw escaped text in it collapsed every paragraph into one run-on block (review
  // round 1). Reuse .m/.mh/pre instead: the exact markup detailView already uses for a
  // transcript's claude messages, whose plain `pre{white-space:pre-wrap}` (global rule)
  // preserves paragraph breaks. Escaped text through pre-wrap, never through mdHtml() — this
  // is raw model output, and running it through a markdown renderer would hand a page whose
  // only job is "show what the agent said" a markdown/HTML injection surface for no reason.
  const body = `<h1><a href="/agents/${esc(name)}">← ${esc(name)}</a> <span class="muted">· ${esc(run)}</span></h1>
<pre class="status">${esc(JSON.stringify(status, null, 1))}</pre>
<div class="m claude"><div class="mh"><b>claude</b></div><pre>${esc(text || '(no assistant text)')}</pre></div>`;
  send(req, res, 200, page(`${run} · ${name}`, body, '', '', 'agents', false, null, req.headers.host));
}


// ---------- /ui: the SPA shell and its assets (spec §1) ----------
// One process, no build step: modules are served straight from disk and wired with an import
// map, which is a platform feature rather than tooling. Asset URLs carry a content hash so a
// deploy busts the cache without a bundler.
// NOTE: this lives at /ui, not /app. /app is already the persistent terminal launcher (below,
// appView) and the installed PWA's start_url (manifest(), above) — do not reclaim it.
const UI_DIR = new URL('./app/', import.meta.url).pathname;

const uiAssets = new Map(); // url-name -> {buf, etag, type}
function uiAssetName(rel, buf) {
  // vendor/preact.mjs -> vendor/preact.1a2b3c4d.mjs   (content hash busts the cache on deploy)
  const dot = rel.lastIndexOf('.');
  return `${rel.slice(0, dot)}.${crc32(buf).toString(16)}${rel.slice(dot)}`;
}

// What app/ is allowed to serve, and the content-type each extension gets. An extension absent
// from this map is not served at all — the default is refusal, so dropping a stray .DS_Store or
// an editor backup into app/ can never become a route.
//
// COUPLED TO scripts/preflight.sh's client-asset ceiling, which greps app/ with its own find(1)
// extension list. The two lists must name the same extensions: anything servable here and not
// measured there ships to browsers without counting against the size budget, and the gate keeps
// reporting a comfortable number while the payload grows. That is form 3 of this branch's
// catalogue of hollow checks — a check whose label lies about what it tests. Change both or
// neither; preflight asserts the agreement (see "asset extension lists agree" there).
// No svg entry, deliberately: the 44:5 icons are lucide glyphs that ICO already inlines as
// currentColor SVG, so nothing needs serving as a file. Adding an extension "for later" makes
// app/ a route surface for anything that lands in it.
const UI_ASSET_TYPES = ASSET_TYPES; // one list for app/ and dist/, owned by static.mjs
export async function loadUiAssets() {
  uiAssets.clear();
  const walk = async d => {
    for (const e of await fsp.readdir(d, { withFileTypes: true })) {
      const full = `${d}/${e.name}`;
      if (e.isDirectory()) { await walk(full); continue; }
      const type = UI_ASSET_TYPES[e.name.slice(e.name.lastIndexOf('.') + 1)];
      if (!type) continue;
      const rel = full.slice(UI_DIR.length);
      const buf = await fsp.readFile(full);
      uiAssets.set(uiAssetName(rel, buf), { buf, rel,
        etag: '"' + crc32(buf).toString(16) + '"', type });
    }
  };
  try { await walk(UI_DIR.replace(/\/$/, '')); } catch {}
}

const uiAssetUrlFor = rel => {
  for (const [k, v] of uiAssets) if (v.rel === rel) return '/ui/assets/' + k;
  return '/ui/assets/' + rel;
};

// CSS is a module-level literal, so it is built long before the content hashes exist — but an
// @font-face src must name the HASHED url or the font 404s (uiAssetView keys on the hashed name).
// Hence two placeholders in CSS, substituted here once assets are loaded, and cached: it is the
// same two replacements on every response, for both the server-rendered pages and the SPA.
//
// Safe because loadUiAssets() now runs at startup, before listen(), so uiAssets is always
// populated by the time any handler renders a page.
let cssCache = null;

// The stylesheet's comments are for the reader of this file, not the browser: 22 KB raw, ~10 KB
// gzipped, shipped inline on every /ui and / document until this strip (CI: 20673 B of the 20480 B
// D3 ceiling). Stripped once, at first use; a comment never crosses a string in this CSS.
const cssText = () => (cssCache ??= CSS
  .replace(/\/\*[\s\S]*?\*\//g, '').replace(/\n[ \t]*\n+/g, '\n')
  .replace('FONT_INTER', uiAssetUrlFor('vendor/inter-var-latin.woff2'))
  .replace('FONT_MONO', uiAssetUrlFor('vendor/jetbrains-mono-var-latin.woff2')));

// The server-rendered twin of a /ui path, for the <noscript> block. Spec §2 asks for a link to
// "the server-rendered equivalent", and the block used to be a constant pointing at `/` — from
// /ui/agents/<name> the equivalent is /agents/<name>, not the fleet page (final review, L3).
//
// Allow-listed rather than computed by string surgery, deliberately: this value is interpolated
// into HTML, and the SPA's router falls through to the agents list for ANY unmatched path
// (/ui/system renders the list today), so a naive '/' + p.slice(4) would both hand an attacker
// the shape of the output and promise twins for routes that do not exist. Anything unrecognised
// gets /agents, which is the twin of what the SPA will actually render. AGENT_RE and RUN_RE are
// the same patterns the API and the server-rendered routes validate with — reused, not restated,
// so a twin link can never name a shape those routes would refuse, and nothing that is not
// [a-z0-9-] or a run id can reach the attribute in the first place.
function uiTwinPath(p) {
  let m;
  if ((m = p.match(/^\/ui\/agents\/([^/]+)\/([^/]+)\/?$/)) && AGENT_RE.test(m[1]) && RUN_RE.test(m[2]))
    return `/agents/${m[1]}/${m[2]}`;
  if ((m = p.match(/^\/ui\/agents\/([^/]+)\/?$/)) && AGENT_RE.test(m[1])) return `/agents/${m[1]}`;
  return '/agents';
}

function uiShellHtml(host, nonce, twin = '/agents') {
  const imports = {
    preact: uiAssetUrlFor('vendor/preact.mjs'),
    'preact/hooks': uiAssetUrlFor('vendor/hooks.mjs'),
    htm: uiAssetUrlFor('vendor/htm.mjs'),
    marked: uiAssetUrlFor('vendor/marked.mjs'),
  };
  // Relative imports between first-party modules resolve against the IMPORTING module's own
  // (hashed) URL, producing a request for the unhashed path — which uiAssetView 404s. Import
  // maps remap a relative specifier only AFTER the browser resolves it to an absolute URL, so
  // a URL-keyed entry per file is what makes `import './ui.mjs'` reach the hashed file.
  // Verified in Chromium against a server where the unhashed file did not exist at all.
  // vendor/* is excluded: those files are only ever reached by bare specifier (already mapped
  // above), never by a relative import, so a URL-keyed entry for them would just bloat the
  // inline map every page load with a redundant route to the same hashed URL.
  for (const [k, v] of uiAssets) {
    if (v.rel.startsWith('vendor/')) continue;
    const unhashed = '/ui/assets/' + v.rel, hashed = '/ui/assets/' + k;
    if (unhashed !== hashed) imports[unhashed] = hashed;
  }
  // Same chrome as every other page, from the same builder (see pageChrome): the header, the
  // pinned tab bar and the terminal FAB. The Agents tab points BACK INTO the app rather than at
  // the server-rendered twin, so tapping the tab you are already on does not eject you from it.
  // Every other tab is an ordinary cross-document navigation — main.mjs's click handler only
  // intercepts a[href^="/ui"] — which is exactly right while both models ship (spec §6).
  const { hdr, tabs, termFab } = pageChrome('agents', null, host, '/ui/agents');
  return `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover,interactive-widget=resizes-content">
<meta name="color-scheme" content="dark"><meta name="theme-color" content="#09090b">
<link rel="manifest" href="/manifest.webmanifest" crossorigin="use-credentials">
<title>mows control</title>
<style nonce="${nonce}">${cssText()}</style>
<script type="importmap" nonce="${nonce}">${JSON.stringify({ imports })}</script>
</head><body class="uiapp">${hdr}${termFab}
<div id="app"></div>
<noscript><p>This view needs JavaScript. The server-rendered version of this page is at <a href="${esc(twin)}">${esc(twin)}</a>.</p></noscript>
${tabs}
<script type="module" nonce="${nonce}" src="${uiAssetUrlFor('main.mjs')}"></script>
</body></html>`;
}

export async function uiView(req, res, p) {
  if (!uiAssets.size) await loadUiAssets();
  // base64url, not hex: a nonce is a CSP base64-value and must survive the header verbatim.
  const nonce = randomBytes(16).toString('base64url');
  send(req, res, 200, uiShellHtml(req.headers.host || '', nonce, uiTwinPath(p)), 'text/html; charset=utf-8',
    { 'content-security-policy': uiCsp(nonce) });
}

export async function uiAssetView(req, res, name) {
  if (!uiAssets.size) await loadUiAssets();
  const a = uiAssets.get(name);
  if (!a) { res.writeHead(404); return res.end(); }
  if (req.headers['if-none-match'] === a.etag) { res.writeHead(304, { etag: a.etag }); return res.end(); }
  res.writeHead(200, { 'content-type': a.type, etag: a.etag,
    'cache-control': 'public, max-age=31536000, immutable', 'content-length': a.buf.length });
  res.end(a.buf);
}
