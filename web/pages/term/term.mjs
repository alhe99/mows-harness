// term.mjs — the /term document (ARCHITECTURE section 6; phase 04). xterm.js 6 on the same ttyd socket (ttyd.mjs), the key bar and its
// features as modules of their own, themed from themes.json (theme.mjs). window.term stays exposed: mobile-journey.mjs reads
// term._core._renderService.dimensions.css.cell.width. Assets come from /assets/, never /term/ (Caddy sends every /term* path to ttyd).
// Kill switches, as URL params: ?ime=off ?clip=off ?rst=off ?paint=off ?theme=off.
import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import { Unicode11Addon } from '@xterm/addon-unicode11';
import { WebLinksAddon } from '@xterm/addon-web-links';
import '@xterm/xterm/css/xterm.css';
import './term.css';
import 'themes:css'; // after term.css: a theme block and the :root default have the same specificity, so the later one wins
import { baseKeys, fontKeys, touchScroll, viewportFit } from './bar.mjs';
import { attach } from './attach.mjs';
import { clipboard } from './clip.mjs';
import { diag, paint } from './paint.mjs';
import { ime } from './ime.mjs';
import { sessions } from './sess.mjs';
import { themes } from './theme.mjs';
import { ttydClient } from './ttyd.mjs';
import { el, key, off } from './dom.mjs';

const term = new Terminal({ fontSize: 14, fontFamily: 'Consolas,Liberation Mono,Menlo,Courier,monospace', allowProposedApi: true });
/** @type {any} */ (window).term = term;
const fitAddon = new FitAddon();
term.loadAddon(fitAddon);
term.loadAddon(new Unicode11Addon());
term.unicode.activeVersion = '11'; // emoji width 2, to match tmux 3.4
term.loadAddon(new WebLinksAddon());
term.open(/** @type {HTMLElement} */ (document.getElementById('terminal-container')));

// every fit goes through here: bursts (keyboard, safe areas settling) are coalesced 150 ms so the pty sees one resize; fit(true) is immediate
/** @type {any} */ let ft = 0;
const fit = (now = false) => { clearTimeout(ft); const run = () => { try { fitAddon.fit(); } catch { /* not laid out yet */ } }; now ? run() : (ft = setTimeout(run, 150)); };
fit(true);
addEventListener('resize', () => fit());

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

// keys, in the final child order of the bar on a phone: back, pill, attach, copy, paste, restart, Esc ... KB, A- size A+, theme select
const fonts = fontKeys(term, fit);
const back = key('‹', () => { location.href = '/'; });
back.setAttribute('aria-label', 'sessions');
back.id = 'ccback';
const restart = off('rst') ? null : key('⟳', () => {
  if (!confirm('Restart this pane? Claude reloads (picks up new MCP/config). Whatever is running right now is killed.')) return;
  // staged: tmux's assume-paste-time treats a burst as a paste and skips its key bindings (prefix is C-q)
  term.input('\x11');
  setTimeout(() => term.input(':'), 120);
  setTimeout(() => term.input('respawn-pane -k'), 260);
  setTimeout(() => term.input('\r'), 420);
}, 'pointerup');
const theme = themes(term);
const clip = clipboard(term);
const bar = el('div', { id: 'cckb' }, back, sessions(), attach(term), ...clip.keys, restart, ...baseKeys(term), fonts.down, fonts.span, fonts.up, theme.select);
document.body.append(bar);
touchScroll();
viewportFit(bar, fit);
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

// WebGL, Chromium only and lazy: iOS and WebKit keep the DOM renderer. A lost context drops back to it.
if (/\b(Chrome|Edg)\//.test(navigator.userAgent) && !/CriOS|FxiOS/.test(navigator.userAgent)) {
  import('@xterm/addon-webgl').then(({ WebglAddon }) => {
    const gl = new WebglAddon();
    gl.onContextLoss(() => gl.dispose());
    term.loadAddon(gl);
  }).catch(() => {});
}
