// term.mjs — the /term document (ARCHITECTURE section 6; phase 04). xterm.js 6 on the same ttyd socket (ttyd.mjs), the key bar and its
// features as modules of their own, themed from themes.json (theme.mjs). On a phone the page is a column: the terminal, then the dock (the
// composer, composer.mjs, over the key bar, bar.mjs); the menu sheet (menu.mjs), behind the bar's ⋯, holds the rest. window.term stays exposed: mobile-journey.mjs reads
// term._core._renderService.dimensions.css.cell.width. Assets come from /assets/, never /term/ (Caddy sends every /term* path to ttyd).
// Kill switches, as URL params: ?ime=off ?clip=off ?comp=off ?paint=off ?theme=off.
import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import { Unicode11Addon } from '@xterm/addon-unicode11';
import { WebLinksAddon } from '@xterm/addon-web-links';
import '@xterm/xterm/css/xterm.css';
import './term.css';
import 'themes:css'; // after term.css: a theme block and the :root default have the same specificity, so the later one wins
import { baseKeys, detach, fontKeys, modChip, touchScroll, viewportFit } from './bar.mjs';
import { attach } from './attach.mjs';
import { clipboard } from './clip.mjs';
import { diag, paint } from './paint.mjs';
import { ime } from './ime.mjs';
import { composer } from './composer.mjs';
import { menu } from './menu.mjs';
import { flows } from './flows.mjs';
import { themes } from './theme.mjs';
import { ttydClient } from './ttyd.mjs';
import { coarse, el } from './dom.mjs';
import { gridKeys } from './gridkeys.mjs';
// Android, light system theme: a light status bar so its dark icons read — the reasoning is in web/standalone.mjs, next to the same line.
if (/Android/.test(navigator.userAgent) && matchMedia('(prefers-color-scheme: light)').matches) document.querySelector('meta[name=theme-color]')?.setAttribute('content', '#e4e4e7');

const term = new Terminal({ fontSize: 14, fontFamily: 'Consolas,Liberation Mono,Menlo,Courier,monospace', allowProposedApi: true });
/** @type {any} */ (window).term = term;
const fitAddon = new FitAddon();
term.loadAddon(fitAddon);
term.loadAddon(new Unicode11Addon());
term.unicode.activeVersion = '11'; // emoji width 2, to match tmux 3.4
term.loadAddon(new WebLinksAddon());
term.open(/** @type {HTMLElement} */ (document.getElementById('terminal-container')));
// a pane of /grid: the shell focuses the iframe element (a row click, a tab click, a chord); that alone leaves this document's focus on
// its body and typing goes nowhere, so the window's focus event hands it to xterm. Standalone, a click on the terminal does it, as before.
if (window.parent !== window) { addEventListener('focus', () => term.focus()); if (document.hasFocus()) term.focus(); }

// every fit goes through here: bursts (keyboard, safe areas settling) are coalesced 150 ms so the pty sees one resize; fit(true) is immediate
/** @type {any} */ let ft = 0;
// A box with no size is a hidden /grid tab, not a tiny screen: Chromium lays out an iframe under display:none at 0×0 and xterm's fit then
// proposed 9×5, which tmux (window-size latest) gave the whole session, and Claude redrew its conversation away (2026-10-26). Skip it; the
// ResizeObserver below refits when the tab shows again.
const fit = (now = false) => {
  clearTimeout(ft);
  const run = () => { const box = document.getElementById('terminal-wrap'); if (box && !(box.offsetWidth && box.offsetHeight)) return; try { fitAddon.fit(); } catch { /* not laid out yet */ } };
  now ? run() : (ft = setTimeout(run, 150));
};
fit(true);
addEventListener('resize', () => fit());
// the box the terminal lives in changes with the dock (a second key row, a growing composer) and the keyboard: refit on any of them. On a phone
// at once (the keyboard handler already coalesces its events; a refit left for later showed the old grid in the new box for 150 ms); on a
// desktop a window drag is a burst, coalesced as before
const wrap = /** @type {HTMLElement} */ (document.getElementById('terminal-wrap'));
new ResizeObserver(() => fit(coarse())).observe(wrap);
// an engine without overflow:clip can still scroll the box (term.css): put it back at once
wrap.addEventListener('scroll', () => { if (wrap.scrollTop || wrap.scrollLeft) { wrap.scrollTop = 0; wrap.scrollLeft = 0; } });

// the status overlay (ttyd's): connection closed, reconnecting, press Enter
const ovl = document.body.appendChild(el('div', { id: 'ccovl' }));
let titleFixed = false;
const client = ttydClient({
  term, base: location.pathname.replace(/\/$/, ''), search: location.search,
  on: {
    status: s => { ovl.textContent = s; ovl.classList.add('on'); clearTimeout(ovl._t); if (!s.startsWith('Press')) ovl._t = setTimeout(() => ovl.classList.remove('on'), 1500); },
    title: t => { if (!titleFixed) document.title = t + ' | mows terminal'; },
    prefs: p => {
      if (p.fontSize && !fonts.stored()) { term.options.fontSize = p.fontSize; fit(true); }
      if ('titleFixed' in p) titleFixed = !!p.titleFixed;
    },
    socket: (ev, ws, x) => {
      if (ev === 'new') { stat.set(ws, { id: ++socketN, bytes: 0 }); diag('ws-new', `${socketN}:${ws.url.slice(-40)}`); setTimeout(() => diag('ws-5s', `${stat.get(ws).id}:${stat.get(ws).bytes}B rs${ws.readyState}`), 5000); return; }
      const s = stat.get(ws);
      if (ev === 'open') diag('ws-open', s.id);
      else if (ev === 'close') diag('ws-close', `${s.id}:${x}`);
      else if (ev === 'error') diag('ws-err', s.id);
      else if (ev === 'message') { if (!s.bytes) diag('ws-first-msg', `${s.id}:${x}B`); s.bytes += x; }
    },
  },
});
let socketN = 0;
const stat = new WeakMap(); // per socket: its number and the bytes it received, for the /z beacons

// the chrome on a phone: the dock (composer + key bar) under the terminal, the menu sheet; a desktop gets the hidden key bar only
const fonts = fontKeys(term, fit);
// staged: tmux's assume-paste-time treats a burst as a paste and skips its key bindings (prefix is C-q)
const restart = () => {
  term.input('\x11');
  setTimeout(() => term.input(':'), 120);
  setTimeout(() => term.input('respawn-pane -k'), 260);
  setTimeout(() => term.input('\r'), 420);
};
const theme = themes(term);
// text from the menu's Paste: into the composer while it is the input, else into the terminal. An attached file's path always goes to the
// terminal: in Claude's box an image path becomes a real attachment ([Image #1]), which the composer then shows as its draft chip.
const put = t => { if (!comp?.insert(t)) term.paste(t); };
const clip = clipboard(term, put);
const att = attach(term);
const tc = /** @type {HTMLElement} */ (document.getElementById('terminal-container'));
const comp = composer(term, tc, () => fit(true), att.recent, att.pick);
// the session of the URL names the menu's header (?arg=attach&arg=<session>)
const args = new URLSearchParams(location.search).getAll('arg');
const session = args[0] === 'attach' && args[1] ? { name: args[1], label: args[1].replace(/^cc-[^-]+-/, '').replace(/^web-/, '') } : null;
const wf = coarse() ? flows(j => comp?.claude(!!j.claude)) : null; // the session's Workflow runs and agents: a badge on ⋯, a block on top of the sheet
const sheet = coarse() ? menu({ clip, att, fonts, theme, detach: () => detach(term), restart, title: () => session, top: wf?.box }) : null;
const bar = el('div', { id: 'cckb' }, ...baseKeys(term, { typing: () => !!comp?.typing(), type: t => comp?.insert(t), menu: () => sheet?.open() }));
document.body.append(el('div', { id: 'ccdock' }, comp?.el, bar));
fit(true); // now, not from the observer a frame later: the socket may open first, and the size it sends is the pty's (one redraw, not two)
if (coarse()) wrap.append(modChip());
if (wf) bar.querySelector('[data-k=Menu]')?.append(wf.badge);
touchScroll();
viewportFit(fit);
ime(term, client);
paint(term, client);

// a viewport pinned short of the screen in a standalone app is iOS 26's reserved bottom zone: .nozone takes its inset off the bar. The
// geometry goes to the access log once, deferred, because iOS reports env() and innerHeight wrong until layout settles.
setTimeout(() => requestAnimationFrame(() => {
  try {
    const probe = (css, doc = document) => { const d = doc.body.appendChild(el('div', { style: 'position:fixed;visibility:hidden;pointer-events:none;top:0;left:0;width:1px;' + css })); return d; };
    const pr = probe('padding:env(safe-area-inset-top,0px) 0 env(safe-area-inset-bottom,0px)'), cs = getComputedStyle(pr);
    const u = probe('height:100lvh'), h = () => u.getBoundingClientRect().height | 0, lvh = h();
    u.style.height = '100dvh'; const dvh = h();
    u.style.height = '100svh'; const svh = h();
    const vv = window.visualViewport, standalone = matchMedia('(display-mode: standalone)').matches;
    const q = `t=term-v8&m=${standalone ? 'app' : 'tab'}&sat=${parseFloat(cs.paddingTop) | 0}&sab=${parseFloat(cs.paddingBottom) | 0}&ih=${innerHeight}&sh=${screen.height}&oh=${outerHeight}&sy=${screenY | 0}&vh=${vv ? vv.height | 0 : 0}&dh=${document.documentElement.clientHeight}&lvh=${lvh}&dvh=${dvh}&svh=${svh}&kbb=${Math.round(bar.getBoundingClientRect().bottom)}`;
    pr.remove(); u.remove();
    fetch('/z?' + q).catch(() => {});
    if (screen.height - innerHeight > 40 && standalone) { document.body.classList.add('nozone'); fit(true); }
  } catch { /* a beacon is best effort */ }
}), 900);

client.start();
gridKeys(term);

// WebGL, Chromium only and lazy: iOS and WebKit keep the DOM renderer. A lost context drops back to it.
if (/\b(Chrome|Edg)\//.test(navigator.userAgent) && !/CriOS|FxiOS/.test(navigator.userAgent)) {
  import('@xterm/addon-webgl').then(({ WebglAddon }) => {
    const gl = new WebglAddon();
    gl.onContextLoss(() => gl.dispose());
    term.loadAddon(gl);
  }).catch(() => {});
}
