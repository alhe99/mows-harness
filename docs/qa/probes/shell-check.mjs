// Cockpit phase 01 shell probe (specs/cockpit/01-shell.md tasks 6-7). Exit code is the verdict.
// usage: node docs/qa/probes/shell-check.mjs [webkit|chromium]      env: DASH (default http://127.0.0.1:3105), PLAYWRIGHT (module path; default: the repo's)
// 390x844: five .tb tabs inside the safe area, floating, no horizontal overflow; a tab tap changes the route with NO document load
// and runs inside document.startViewTransition when the engine has one; Back works the same way; links the shell must not route
// (/term*, /md, /oauth2/*, data-nw, modified or middle clicks) are left to the browser. 1280x800: the header nav shows, the tab bar is gone.
const pw = await import(process.env.PLAYWRIGHT || 'playwright').catch(() => { console.error('shell-check: playwright is not installed (npm ci --ignore-scripts)'); process.exit(2); });
const engine = process.argv[2] || 'webkit';
const base = (process.env.DASH || 'http://127.0.0.1:3105') + '/next/';
const browser = await pw[engine].launch();
const errors = [];
const watch = p => { p.on('console', m => { if (m.type() === 'error' && !/interactive-widget/.test(m.text())) errors.push(m.text()); }); p.on('pageerror', e => errors.push(String(e))); };
let bad = 0;
const check = (id, ok, detail) => { if (!ok) bad++; console.log(`${ok ? 'PASS' : 'FAIL'} ${id}${detail === undefined ? '' : ' ' + JSON.stringify(detail)}`); };

const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 3, hasTouch: true, isMobile: true });
await ctx.addInitScript(() => {
  const o = Document.prototype.startViewTransition;
  window.__vtSupported = !!o; window.__vt = 0;
  if (o) Document.prototype.startViewTransition = function (...a) { window.__vt++; return o.apply(this, a); };
});
const page = await ctx.newPage(); watch(page);
let loads = 0; page.on('load', () => loads++);
await page.goto(base, { waitUntil: 'load' });
await page.waitForSelector('#app h1[data-view="sessions"]');
await page.evaluate(() => { window.__doc = 'same-document'; });

const m = await page.evaluate(() => {
  const t = document.querySelector('.tabs'), r = t.getBoundingClientRect(), cs = getComputedStyle(t);
  const tbs = [...document.querySelectorAll('.tb')].map(b => b.getBoundingClientRect());
  return { pos: cs.position, left: r.left, right: r.right, top: r.top, bottom: r.bottom, vh: innerHeight, n: tbs.length,
    inside: tbs.every(b => b.width > 0 && b.left >= r.left - 1 && b.right <= r.right + 1 && b.top >= 0 && b.bottom <= innerHeight),
    sw: document.scrollingElement.scrollWidth, vtn: getComputedStyle(t).viewTransitionName };
});
check('1 five .tb tabs inside the viewport, tab bar fixed and floating', m.n === 5 && m.pos === 'fixed' && m.left >= 10 && m.right <= 380 && m.top > 0 && m.bottom <= m.vh && m.inside, m);
check('2 no horizontal overflow at 390', m.sw <= 390, m.sw);
check('3 .tabs keeps view-transition-name: tabs', m.vtn === 'tabs', m.vtn);

const loadsBefore = loads;
await page.tap('.tb[href="/next/history"]');
await page.waitForSelector('#app h1[data-view="history"]');
const t = await page.evaluate(() => ({ path: location.pathname, doc: window.__doc, on: document.querySelector('.tb.on')?.textContent.trim(), vt: window.__vt, sup: window.__vtSupported,
  h1: document.querySelector('#app h1')?.textContent }));
check('4 tapping History changes the route and the active tab', t.path === '/next/history' && t.on === 'History' && t.h1 === 'history', t);
check('5 ...without a document load', t.doc === 'same-document' && loads === loadsBefore, { doc: t.doc, loads: loads - loadsBefore });
check('6 ...inside document.startViewTransition when supported', !t.sup || t.vt >= 1, { supported: t.sup, calls: t.vt });
await page.goBack();
await page.waitForSelector('#app h1[data-view="sessions"]');
const back = await page.evaluate(() => ({ path: location.pathname, doc: window.__doc, on: document.querySelector('.tb.on')?.textContent.trim() }));
check('7 Back returns to Sessions in the same document', back.path === '/next/' && back.doc === 'same-document' && back.on === 'Sessions', back);

// which clicks the shell routes itself (preventDefault) and which it leaves to the browser; the page is reloaded after each
const prevented = (href, { attrs = {}, init = {} } = {}) => page.evaluate(([href, attrs, init]) => {
  const a = document.createElement('a'); a.href = href; for (const [k, v] of Object.entries(attrs)) a.setAttribute(k, v);
  document.body.append(a);
  // The shell's window listener stops the event, so no later listener can observe or cancel it. A window capture listener (runs
  // first) cancels the event for real, so the browser never follows the link, and hands the shell a stand-in: defaultPrevented
  // stays false until the shell itself calls preventDefault, which is recorded as "routed".
  let routed = false;
  window.addEventListener('click', e => {
    Event.prototype.preventDefault.call(e);
    Object.defineProperty(e, 'defaultPrevented', { get: () => routed });
    e.preventDefault = () => { routed = true; };
  }, { capture: true, once: true });
  a.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, composed: true, ...init }));
  return routed;
}, [href, attrs, init]);
page.on('popup', p => p.close());
const cases = [
  ['8 an ordinary shell link is routed', '/next/system', {}, true],
  ['9 /term* is left to the browser', '/term/?arg=menu&arg=&arg=00000000&v=3', {}, false],
  ['10 /md is left to the browser', '/md?f=x', {}, false],
  ['11 /oauth2/* is left to the browser', '/oauth2/sign_out', {}, false],
  ['12 data-nw links are left to the browser', '/next/system', { attrs: { 'data-nw': 't-1' } }, false],
  ['13 a ctrl-click is left to the browser', '/next/system', { init: { ctrlKey: true } }, false],
  ['14 a middle click is left to the browser', '/next/system', { init: { button: 1 } }, false],
];
for (const [id, href, opts, want] of cases) {
  check(id, (await prevented(href, opts)) === want);
  if (want) await page.waitForSelector('#app h1[data-view="system"]'); // let the routed view's lazy import finish before the reload aborts it
  await page.goto(base, { waitUntil: 'load' });
  await page.waitForSelector('#app h1[data-view="sessions"]');
}

const desk = await browser.newContext({ viewport: { width: 1280, height: 800 } });
const dp = await desk.newPage(); watch(dp);
await dp.goto(base, { waitUntil: 'load' });
await dp.waitForSelector('#app h1[data-view="sessions"]');
const d = await dp.evaluate(() => { const n = document.querySelector('.pnav'), r = n.getBoundingClientRect();
  return { nav: getComputedStyle(n).display !== 'none' && r.width > 0 && r.height > 0, tabs: getComputedStyle(document.querySelector('.tabs')).display, links: n.querySelectorAll('a').length }; });
check('15 1280x800: header nav shows, tab bar hidden', d.nav && d.tabs === 'none' && d.links === 5, d);
check('16 zero console errors', errors.length === 0, errors);
await browser.close();
console.log(bad ? `shell-check ${engine}: ${bad} FAILED` : `shell-check ${engine}: all passed`);
process.exit(bad ? 1 : 0);
