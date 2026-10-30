// term-hidden-tab.mjs — a /grid tab hidden and shown again never resizes its session. Exit code is the verdict.
// usage: node docs/qa/probes/term-hidden-tab.mjs [chromium|webkit]      (PLAYWRIGHT: module path; default: the repo's playwright)
// No server: dist/term.html and its /assets/ come from disk (run `node build.mjs` first), inside an iframe whose wrapper is hidden with
// display:none, as /grid does for an inactive tab. Why it exists (2026-10-26): Chromium lays that iframe out at 0×0, xterm's fit proposed
// 9×5, tmux (window-size latest) shrank the session to it, Claude redrew at 9 columns, and the tab came back black above Claude's last reply.
// Asserts: no size is sent while hidden; showing it again sends nothing new (the size never changed); a real window resize still goes through.
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '../../..');
const pw = await import(process.env.PLAYWRIGHT || 'playwright').catch(() => { console.error('term-hidden-tab: playwright is not installed (npm ci --ignore-scripts)'); process.exit(2); });
const type = process.argv[2] || 'chromium';
const PAGE = readFileSync(join(ROOT, 'dist/term.html'), 'utf8');
const PARENT = `<!doctype html><style>html,body{margin:0;height:100%;background:#000}#gw{position:absolute;inset:0}#gw[hidden]{display:none}
iframe{border:0;width:100%;height:100%}</style><div id="gw"><iframe src="/term/?arg=attach&arg=s1&arg=ab12cd34&v=3"></iframe></div>`;
const sleep = ms => new Promise(r => setTimeout(r, ms));

const b = await pw[type].launch(), ctx = await b.newContext({ viewport: { width: 1400, height: 900 } });
await ctx.route(u => new URL(u).hostname === 'mows.test', r => {
  const p = new URL(r.request().url()).pathname;
  if (p === '/grid') return r.fulfill({ contentType: 'text/html', body: PARENT });
  if (p === '/grid-hidden') return r.fulfill({ contentType: 'text/html', body: PARENT.replace('<div id="gw">', '<div id="gw" hidden>') }); // a tab restored hidden
  if (p === '/term/') return r.fulfill({ contentType: 'text/html; charset=utf-8', body: PAGE });
  if (p === '/term/token') return r.fulfill({ contentType: 'application/json', body: '{"token":""}' });
  if (p.startsWith('/assets/')) { const f = join(ROOT, 'dist', p.slice(8)); if (existsSync(f)) return r.fulfill({ body: readFileSync(f), contentType: f.endsWith('.css') ? 'text/css' : 'text/javascript' }); }
  if (p.startsWith('/app/')) return r.fulfill({ contentType: 'application/json', body: '{}' });
  return r.fulfill({ status: 204 });
});
const sizes = []; // every size the page sends: the first message (JSON) and each resize frame ('1' + JSON)
await ctx.routeWebSocket(/\/term\/ws/, ws => ws.onMessage(m => { const s = String(m); if (s[0] === '{' || s[0] === '1') { const j = JSON.parse(s[0] === '1' ? s.slice(1) : s); sizes.push(`${j.columns}x${j.rows}`); } }));
const page = await ctx.newPage(), errs = [];
page.on('pageerror', e => errs.push(String(e)));
await page.goto('http://mows.test/grid'); await sleep(2000);
const first = [...sizes];
await page.evaluate(() => { document.getElementById('gw').hidden = true; }); await sleep(1500);
const hidden = sizes.slice(first.length);
await page.evaluate(() => { document.getElementById('gw').hidden = false; }); await sleep(1500);
const shown = sizes.slice(first.length + hidden.length);
await page.setViewportSize({ width: 1000, height: 700 }); await sleep(1500);
const resized = sizes.slice(first.length + hidden.length + shown.length);
// a tab that LOADS hidden (every tab but the shown one after the app restarts): its first frame used to claim xterm's 80×24 (2026-10-30)
await page.setViewportSize({ width: 1400, height: 900 });
const k = sizes.length;
await page.goto('http://mows.test/grid-hidden'); await sleep(2000);
const loadHidden = sizes.slice(k);
await page.evaluate(() => { document.getElementById('gw').hidden = false; }); await sleep(2000);
const loadShown = sizes.slice(k + loadHidden.length);
await b.close();

let fail = 0;
const check = (name, ok, got) => { console.log(`${ok ? 'PASS' : 'FAIL'} ${type} ${name}${ok ? '' : ' — got ' + JSON.stringify(got)}`); if (!ok) fail++; };
const big = s => +s.split('x')[0] >= 80 && +s.split('x')[1] >= 30;
check('the attach sends the pane its full size', first.length >= 1 && first.every(big), first);
check('hidden: no size sent (no 9×5)', hidden.length === 0, hidden);
check('shown again: nothing to resize', shown.length === 0, shown);
check('a real window resize still reaches the pty, smaller', resized.length >= 1 && +resized.at(-1).split('x')[0] < +first.at(-1).split('x')[0], resized);
check('loaded hidden: no size sent', loadHidden.length === 0, loadHidden);
check('loaded hidden, then shown: its full size', loadShown.length >= 1 && loadShown.every(big), loadShown);
check('no page errors', errs.length === 0, errs);
console.log(`term-hidden-tab ${type}: ${fail ? fail + ' FAIL' : 'ALL PASS'}`);
process.exit(fail ? 1 : 0);
