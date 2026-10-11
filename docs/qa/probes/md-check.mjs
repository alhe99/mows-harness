// Cockpit phase 04 /md probe (specs/cockpit/04-heavy-pages.md task 10, 11). Exit code is the verdict.
// usage: node docs/qa/probes/md-check.mjs <chromium|webkit> [file.md]
// env: DASH (default http://127.0.0.1:3105: the dev instance, started with --ui=next), PLAYWRIGHT (module path; default: the repo's)
// The document is the real one, from the real server, for a real file: README.md of this repo unless a path is given (it must hold a ```mermaid fence
// below the first screen, which README.md does). The one network dependency is the pinned mermaid file on the CDN: the probe lets that request
// through, so a passing run also proves the integrity= hash matches the bytes the CDN serves (a mismatch blocks the script and nothing renders).
// Asserts: the download link (and the download itself), the rendered file, the shared tokens.css, the CSP (BASE_CSP + the CDN + the hash of the
// one inline loader), no CDN request until a diagram scrolls into view, then one request for the pinned file whose <script> carries integrity=,
// the diagram rendered with mermaid's default layout, and tap-to-toggle full size. A file with no diagram never contacts the CDN.
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';

const pw = await import(process.env.PLAYWRIGHT || 'playwright').catch(() => { console.error('md-check: playwright is not installed (npm ci --ignore-scripts)'); process.exit(2); });
const engine = process.argv[2] || 'chromium';
const DASH = process.env.DASH || 'http://127.0.0.1:3105';
const FILE = process.argv[3] || join(import.meta.dirname, '../../../README.md');
const PIN = 'https://cdn.jsdelivr.net/npm/mermaid@12.1.0/dist/mermaid.min.js';
const browser = await pw[engine].launch();

let bad = 0;
const check = (id, ok, detail) => { if (!ok) bad++; console.log(`${ok ? 'PASS' : 'FAIL'} ${engine}/md ${id}${ok || detail === undefined ? '' : ' ' + JSON.stringify(detail)}`); };
const sleep = ms => new Promise(r => setTimeout(r, ms));
const md = f => `${DASH}/md?f=${encodeURIComponent(f)}`;

async function visit(url, opts = {}) {
  const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true, reducedMotion: 'reduce', serviceWorkers: 'block', ...opts });
  const page = await ctx.newPage();
  const W = { ctx, page, cdn: [], errors: [] };
  page.on('request', r => { if (/jsdelivr|mermaid/i.test(r.url())) W.cdn.push(r.url()); });
  page.on('pageerror', e => W.errors.push(String(e)));
  W.resp = await page.goto(url, { waitUntil: 'load' });
  return W;
}

// ---- the document ----------------------------------------------------------------------------------------------------------------------------
const W = await visit(md(FILE));
check('the document answers 200', W.resp.status() === 200, W.resp.status());
const html = await W.resp.text();
const policy = W.resp.headers()['content-security-policy'] || '';
const script = /<script>([\s\S]*?)<\/script>/.exec(html);
const hash = script && createHash('sha256').update(script[1]).digest('base64');
check('CSP: BASE_CSP + script-src with the CDN origin and the sha256 of the one inline loader', /base-uri 'none'/.test(policy) && /frame-ancestors 'self'/.test(policy) && /script-src 'self' https:\/\/cdn\.jsdelivr\.net 'sha256-/.test(policy) && !!hash && policy.includes(`'sha256-${hash}'`) && /style-src 'self' 'unsafe-inline'/.test(policy), [policy, hash]);
check('the loader names the pinned file with an integrity hash', !!script && script[1].includes(PIN) && /integrity='sha384-[A-Za-z0-9+/=]{64}'/.test(script[1]) && !/mermaid@12\/|mermaid@12'/.test(script[1]), script && script[1].slice(0, 80));
check('the page shares tokens.css and has its own md.css (no inline <style>)', /<link rel="stylesheet" href="\/assets\/tokens\.[A-Z0-9]+\.css"><link rel="stylesheet" href="\/assets\/md\.[A-Z0-9]+\.css">/.test(html) && !/<style/.test(html));
const head = await W.page.evaluate(() => { const a = document.querySelector('.mdhead a.mddl'); return { name: document.querySelector('.mdhead b').textContent, href: a && a.getAttribute('href'), dl: a && a.hasAttribute('download'), h1: document.querySelector('article.mdv h1') && document.querySelector('article.mdv h1').textContent, code: document.querySelectorAll('article.mdv pre code').length, tbl: document.querySelectorAll('article.mdv .mdtbl table').length }; });
check('.mdhead: the file name and the download link (download attribute, &dl=1)', head.name === FILE.split('/').pop() && head.dl && head.href === `/md?f=${encodeURIComponent(FILE)}&dl=1`, head);
const first = readFileSync(FILE, 'utf8').split('\n').find(l => /^#\s/.test(l)).replace(/^#\s+/, '');
check('the rendered file: its first heading, code blocks and tables are in article.mdv', head.h1 === first && head.code > 3 && head.tbl > 0, head);
const dl = await W.ctx.request.get(`${DASH}/md?f=${encodeURIComponent(FILE)}&dl=1`);
check('the download is the raw file as an attachment', dl.status() === 200 && /attachment; filename\*=UTF-8''README\.md/.test(dl.headers()['content-disposition'] || '') && (await dl.text()) === readFileSync(FILE, 'utf8'), [dl.status(), dl.headers()['content-disposition']]);
const sheet = await W.page.evaluate(() => ({ bg: getComputedStyle(document.body).backgroundColor, h1: getComputedStyle(document.querySelector('.mdv h1')).fontSize, mdhead: getComputedStyle(document.querySelector('.mdhead')).display }));
check('the stylesheets applied: the dark body, h1 23px, .mdhead flex', sheet.bg === 'rgb(9, 9, 11)' && sheet.h1 === '23px' && sheet.mdhead === 'flex', sheet);

// ---- mermaid: absent until a diagram scrolls in ----------------------------------------------------------------------------------------------
await sleep(1500);
const y = await W.page.evaluate(() => scrollY), top = await W.page.evaluate(() => document.querySelector('pre[data-lang="mermaid"]').getBoundingClientRect().top);
check('the first diagram starts below the first screen (the precondition)', y === 0 && top > 844, [y, top]);
check('no request to the CDN, and no mermaid object, while the diagram is off screen', W.cdn.length === 0 && (await W.page.evaluate(() => typeof window.mermaid)) === 'undefined', W.cdn);
await W.page.evaluate(() => document.querySelector('pre[data-lang="mermaid"]').scrollIntoView({ block: 'center' }));
await W.page.waitForSelector('.mdmmd svg', { timeout: 60000 }).catch(() => {});
const svg = await W.page.evaluate(() => ({ n: document.querySelectorAll('.mdmmd svg').length, left: document.querySelectorAll('pre[data-lang="mermaid"]').length, title: [...document.querySelectorAll('pre[data-lang="mermaid"]')].map(p => p.title).join('|') }));
check('one pinned CDN request (the same URL, once)', W.cdn.length === 1 && W.cdn[0] === PIN, W.cdn);
const tag = await W.page.evaluate(() => { const s = [...document.scripts].find(x => x.src.includes('mermaid')); return s && { src: s.src, integrity: s.integrity, cors: s.crossOrigin }; });
check('the injected <script> carries integrity= and crossorigin', !!tag && /^sha384-/.test(tag.integrity) && tag.cors === 'anonymous', tag);
check('the diagram rendered (so the browser verified the hash against the CDN bytes) and replaced its source', svg.n >= 1 && svg.left === 0, svg);
const sz = async () => W.page.evaluate(() => { const d = document.querySelector('.mdmmd'), g = d.querySelector('svg'); return { full: d.classList.contains('full'), mw: g.style.maxWidth, w: g.style.width, box: d.getBoundingClientRect().width, vb: g.viewBox.baseVal.width, inner: innerWidth }; });
const s0 = await sz();
check('the diagram starts fitted to the column (not full size)', !s0.full && s0.box <= s0.inner, s0);
await W.page.locator('.mdmmd').first().tap(); await sleep(150);
const s1 = await sz();
check('a tap toggles natural size (class full, width = the viewBox)', s1.full && s1.mw === 'none' && Math.abs(parseFloat(s1.w) - s1.vb) < 0.01, s1);
await W.page.locator('.mdmmd').first().tap(); await sleep(150);
const s2 = await sz();
check('a second tap fits it to the column again', !s2.full && s2.w === '', s2);
check('no page errors', W.errors.length === 0, W.errors);
await W.ctx.close();

// ---- a file with no diagram never contacts the CDN, and has no loader -----------------------------------------------------------------------
const dir = mkdtempSync(join(homedir(), '.mows-md-check-'));
try {
  mkdirSync(dir, { recursive: true });
  const f = join(dir, 'plain.md');
  writeFileSync(f, '# Plain\n\nNo diagram here, only `code` and a [link](other.md).\n\n```js\nconst a = 1 < 2;\n```\n');
  const P = await visit(md(f));
  const ph = await P.resp.text();
  await sleep(800);
  check('no diagram: no loader script, no CDN request', !/<script/.test(ph) && P.cdn.length === 0, P.cdn);
  check('relative links resolve through /md', ph.includes(`href="/md?f=${encodeURIComponent(join(dir, 'other.md'))}"`));
  await P.ctx.close();
} finally { rmSync(dir, { recursive: true, force: true }); }

// ---- refusals keep the plain document ---------------------------------------------------------------------------------------------------------
const R = await visit(`${DASH}/md?f=/etc/hostname`);
check('a file that is not .md is refused with 400', R.resp.status() === 400, R.resp.status());
await R.ctx.close();

await browser.close();
console.log(bad ? `md-check ${engine}: ${bad} FAILED` : `md-check ${engine}: ALL PASS`);
process.exit(bad ? 1 : 0);
