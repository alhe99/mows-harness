#!/usr/bin/env node
// a11y-check.mjs — the legacy page and the shell page carry the same accessibility attributes (MAP 8 M-13, 2.7).
//   node scripts/a11y-check.mjs [--route /] [--engine chromium|webkit]       env: DASH (default http://127.0.0.1:3105), PLAYWRIGHT
// Loads <route> (legacy) and /next<route> (shell) on the dev instance with the same fixture fleet pushed over each page's own event
// stream (a fake EventSource), then compares, as multisets, every aria-label / aria-hidden / aria-live / aria-expanded / aria-current /
// role / title / alt in the live DOM (keyed by tag.classes[attr=value]; template contents are not live) and the :focus-visible rules of the
// stylesheets. Exit 1 on any attribute the shell lacks or adds, or a focus-ring rule it lacks.
const argv = process.argv.slice(2);
const opt = (f, d) => (argv.includes(f) ? argv[argv.indexOf(f) + 1] : d);
const route = opt('--route', '/');
const engine = opt('--engine', 'chromium');
const dash = process.env.DASH || 'http://127.0.0.1:3105';
const pw = await import(process.env.PLAYWRIGHT || 'playwright').catch(() => { console.error('a11y-check: playwright is not installed (npm ci --ignore-scripts)'); process.exit(2); });
if (route !== '/') { console.error('a11y-check: only --route / has a fixture so far'); process.exit(2); }

const T = Date.now();
const FLEET = [
  { sid8: 'bbbb2222', name: 'cc-beta', label: '', proj: 'beta', state: 'needs-you', rel: T - 300e3, snippet: 'approve? [y/n]' },
  { sid8: 'aaaa1111', name: 'cc-alpha', label: 'Alpha', proj: 'alpha', state: 'working', rel: T - 20e3, snippet: 'building' },
  { sid8: 'cccc3333', name: 'cc-gamma', label: '', proj: 'gamma', state: 'paused', rel: T - 4000e3, snippet: '' },
  { sid8: 'dddd4444', name: 'cc-delta', label: 'Delta', proj: 'delta', state: 'idle', rel: T - 200000e3, snippet: 'last words' },
];

const browser = await pw[engine].launch();
const ctx = await browser.newContext({ viewport: { width: 1280, height: 800 }, serviceWorkers: 'block' });
await ctx.addInitScript(fleet => {
  window.EventSource = class {
    constructor() { this.l = {}; setTimeout(() => (this.l.fleet || []).forEach(f => f({ data: JSON.stringify(fleet), lastEventId: '' })), 50); setTimeout(() => (this.l.open || []).forEach(f => f({})), 0); }
    addEventListener(n, f) { (this.l[n] ||= []).push(f); }
    close() {}
  };
}, FLEET);
await ctx.route('**/z?*', r => r.fulfill({ status: 204 }));

const ATTRS = ['aria-label', 'aria-hidden', 'aria-live', 'aria-expanded', 'aria-current', 'role', 'title', 'alt'];
async function collect(url, ready) {
  const page = await ctx.newPage();
  await page.goto(url, { waitUntil: 'load' });
  await page.waitForFunction(() => document.querySelectorAll('#fleet-rows > .li').length === 4);
  await page.waitForTimeout(200);
  const r = await page.evaluate(ATTRS => {
    const attrs = {};
    for (const el of document.querySelectorAll('body *')) {
      if (el.closest('template, script, style')) continue;
      for (const a of ATTRS) if (el.hasAttribute(a)) {
        // the session name is data, not an attribute set: legacy fleet.js leaves the template's "attach x" on a row it inserts from the
        // stream (the shell writes the real name), so "attach <anything>" is one key
        const v = el.getAttribute(a).replace(/^(attach) .+$/, '$1 <name>');
        const k = `${el.tagName.toLowerCase()}${[...el.classList].sort().map(c => '.' + c).join('')}[${a}=${v}]`;
        attrs[k] = (attrs[k] || 0) + 1;
      }
    }
    const focus = new Set();
    const walk = rs => { for (const r of rs) { if (r.selectorText && r.selectorText.includes(':focus-visible')) focus.add(r.selectorText.replace(/\s+/g, ' ') + ' {' + r.style.outline + '}'); if (r.cssRules) walk(r.cssRules); } };
    for (const s of document.styleSheets) { try { walk(s.cssRules); } catch { /* cross-origin sheet */ } }
    return { attrs, focus: [...focus] };
  }, ATTRS);
  await page.close();
  return r;
}
const legacy = await collect(dash + route);
const shell = await collect(dash + '/next' + route);
await browser.close();

let bad = 0;
const fail = m => { bad++; console.log('FAIL ' + m); };
for (const k of new Set([...Object.keys(legacy.attrs), ...Object.keys(shell.attrs)])) {
  const a = legacy.attrs[k] || 0, b = shell.attrs[k] || 0;
  if (a !== b) fail(`${k}: legacy ${a}, shell ${b}`);
}
for (const f of legacy.focus) if (!shell.focus.includes(f)) fail(`focus-ring rule missing from the shell stylesheet: ${f}`);
if (!legacy.focus.length) fail('the legacy page has no :focus-visible rule (the check is looking at the wrong thing)');
const n = Object.values(legacy.attrs).reduce((x, y) => x + y, 0);
console.log(bad ? `a11y-check ${route}: ${bad} difference(s)` : `a11y-check ${route}: PASS ${Object.keys(legacy.attrs).length} attribute keys (${n} occurrences) and ${legacy.focus.length} focus-ring rules identical in legacy and shell`);
process.exit(bad ? 1 : 0);
