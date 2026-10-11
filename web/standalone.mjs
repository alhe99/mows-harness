// standalone.mjs — the base script every legacy page carried (MAP 2.1, 2.4), run once by the shell: the #envout diagnostic and its
// /z beacon, vpfix, and pull-to-refresh. vpfix and pull-to-refresh run in the installed app only; a browser tab has its own.
const standalone = () => matchMedia('(display-mode: standalone)').matches;
const beacon = q => fetch('/z?' + q).catch(() => {});
const REFRESH = '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M21 12a9 9 0 1 1-3-6.7"/><path d="M21 3v6h-6"/></svg>';
const hidden = 'position:fixed;visibility:hidden;pointer-events:none;';

// install mode + safe-area readout in the footer ("app · sat59 sab34"), so device rendering can be diagnosed without guessing
function envout() {
  const o = document.getElementById('envout');
  if (!o) return;
  const p = document.createElement('div');
  p.style.cssText = hidden + 'padding:env(safe-area-inset-top,0px) 0 env(safe-area-inset-bottom,0px)';
  document.body.append(p);
  // measure AFTER layout settles: env() reads 0 too early on iOS cold start
  setTimeout(() => requestAnimationFrame(() => {
    const s = getComputedStyle(p), m = standalone() ? 'app' : 'tab', t = parseFloat(s.paddingTop) | 0, b = parseFloat(s.paddingBottom) | 0;
    o.textContent = `${m} · sat${t} sab${b}`;
    const u = document.createElement('div');
    u.style.cssText = hidden + 'top:0;left:0;width:1px;height:100lvh';
    document.body.append(u);
    const lvh = u.getBoundingClientRect().height | 0;
    u.style.height = '100dvh';
    const dvh = u.getBoundingClientRect().height | 0;
    u.remove(); p.remove();
    const vv = window.visualViewport;
    beacon(`t=dash3&m=${m}&sat=${t}&sab=${b}&ih=${innerHeight}&sh=${screen.height}&oh=${outerHeight}&sy=${screenY | 0}&vh=${vv ? vv.height | 0 : 0}&dh=${document.documentElement.clientHeight}&lvh=${lvh}&dvh=${dvh}`);
  }), 700);
}

// iOS standalone can launch with the layout viewport short by the top safe-area inset, so the tab bar floats above the real bottom.
// A synchronous display:none -> reflow -> restore on the body makes WebKit re-measure (no flash, one frame). At most 6 tries, then
// one reload per 30 s while the page is visible, so a stubborn state cannot loop. Portrait only: screen.height is portrait-fixed.
function vpfix() {
  if (!standalone()) return;
  let n = 0;
  const short = () => matchMedia('(orientation: portrait)').matches && innerHeight + 4 < screen.height;
  const q = ok => `t=vpfix&ok=${ok}&n=${n}&ih=${innerHeight}&p=${encodeURIComponent(location.pathname)}`;
  function heal() {
    if (!short()) return;
    if (n >= 6) {
      try {
        if (Date.now() - (+sessionStorage.vpr || 0) > 30000 && document.visibilityState === 'visible') { sessionStorage.vpr = Date.now(); return location.reload(); }
      } catch { /* no storage: never reload, a loop is worse than a short viewport */ }
      return beacon(q(0) + '&r=1');
    }
    n++;
    const y = scrollY, b = document.body;
    b.style.display = 'none'; void b.offsetHeight; b.style.display = '';
    scrollTo(0, y);
    setTimeout(() => (short() ? heal() : beacon(q(1))), 250);
  }
  const again = () => { n = 0; setTimeout(heal, 80); };
  addEventListener('pageshow', again);
  addEventListener('resize', again);
  document.addEventListener('visibilitychange', () => { if (!document.hidden) again(); });
  setTimeout(heal, 120);
}

// pull-to-refresh: armed at scrollY 0, never preventDefault (passive), the indicator follows half the pull up to 72 px and the
// refresh fires from 56 px.
function pullToRefresh() {
  if (!(standalone() && 'ontouchstart' in window)) return;
  const ptr = document.createElement('div');
  ptr.id = 'ptr'; ptr.innerHTML = REFRESH;
  document.body.append(ptr);
  let y0 = 0, armed = false;
  addEventListener('touchstart', e => { armed = scrollY <= 0; y0 = e.touches[0].clientY; }, { passive: true });
  addEventListener('touchmove', e => {
    if (!armed) return;
    const pull = e.touches[0].clientY - y0;
    if (pull > 8 && scrollY <= 0) {
      const p = Math.min(pull / 2, 72);
      ptr.style.transform = `translate(-50%,${p}px) rotate(${p * 3}deg)`;
      ptr.style.opacity = String(Math.min(p / 56, 1));
      ptr.classList.toggle('go', p >= 56);
    } else { ptr.style.opacity = '0'; ptr.classList.remove('go'); }
  }, { passive: true });
  addEventListener('touchend', () => {
    if (!armed) return;
    armed = false;
    if (ptr.classList.contains('go')) { ptr.classList.add('spin'); location.reload(); }
    else { ptr.style.transform = ''; ptr.style.opacity = '0'; }
  }, { passive: true });
}

envout(); vpfix(); pullToRefresh();
