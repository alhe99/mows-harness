// The second factor's probe (docs/superpowers/specs/2026-10-13-second-factor-design.md section 5). Exit code is the verdict.
// usage: TWOFA_FILE=<scratch 2fa.json> node docs/qa/probes/twofa-check.mjs <webkit|chromium>
// env: DASH (default http://127.0.0.1:3105), a dev instance started with MOWS_TEST_HOOKS=1 and --2fa-file $TWOFA_FILE (test mode reads the
// email from X-Auth-Request-Email when sent, else dev@localhost: no Caddy in front). SHOT: a directory for the page's screenshot.
// The probe enrols its accounts into the scratch file through the CLI; never point TWOFA_FILE at the live one.
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { b32dec, hotp } from '../../../infra/dashboard/routes/twofa.mjs';

const pw = await import(process.env.PLAYWRIGHT || 'playwright').catch(() => { console.error('twofa-check: playwright is not installed'); process.exit(2); });
const engine = process.argv[2] || 'chromium', DASH = process.env.DASH || 'http://127.0.0.1:3105', FILE = process.env.TWOFA_FILE;
if (!FILE || FILE.startsWith('/opt/')) { console.error('twofa-check: TWOFA_FILE must name a scratch file'); process.exit(2); }
const ROOT = join(import.meta.dirname, '../../..');
let bad = 0;
const check = (id, ok, detail) => { if (!ok) bad++; console.log(`${ok ? 'PASS' : 'FAIL'} ${engine} ${id}${ok || detail === undefined ? '' : ' ' + JSON.stringify(detail)}`); };
const enrol = e => { const r = spawnSync('node', [join(ROOT, 'infra/dashboard/lite.mjs'), '2fa', 'enroll', e, '--2fa-file', FILE], { encoding: 'utf8' }); if (r.status) throw new Error(r.stderr); };
const code = (e, shift = 0) => hotp(b32dec(JSON.parse(readFileSync(FILE, 'utf8')).users[e].secret), Math.floor(Date.now() / 30000) + shift);
// each run enrols afresh: a new secret starts a fresh replay window on the server, so runs back to back do not trip it
// the lockout lives in server memory per email, so each run locks an account of its own
const LOCK = `lock-${engine}-${process.pid}@localhost`;
for (const e of ['dev@localhost', 'other@localhost', LOCK]) enrol(e);

const browser = await pw[engine].launch();
const ctx = await browser.newContext({ viewport: { width: 390, height: 844 } });
const page = await ctx.newPage(), api = ctx.request;
const post = (form, headers = {}) => api.post(DASH + '/2fa', { form, headers: { origin: DASH, ...headers }, maxRedirects: 0 });

check('/2fa/auth without a cookie: 401', (await api.get(DASH + '/2fa/auth')).status() === 401);
check('not enrolled: 403 page, no form', await (async () => { const r = await api.get(DASH + '/2fa', { headers: { 'x-auth-request-email': 'nobody@localhost' } }); return r.status() === 403 && !(await r.text()).includes('<form'); })());

// rd exactly as Caddy writes it: unescaped, its own query running on past the first &
let r = await page.goto(DASH + '/2fa?rd=/healthz?arg=attach&arg=wt-a&v=3');
check('the page renders: 200', r.status() === 200);
const input = page.locator('#code');
check('one numeric one-time-code input, focused', await input.getAttribute('inputmode') === 'numeric' && await input.getAttribute('autocomplete') === 'one-time-code'
  && await page.evaluate(() => document.activeElement?.id === 'code'));
check('rd is carried in the form, every & of it', await page.locator('input[name=rd]').inputValue() === '/healthz?arg=attach&arg=wt-a&v=3');
if (process.env.SHOT) await page.screenshot({ path: join(process.env.SHOT, `twofa-${engine}.png`) });

const wrong = String((+code('dev@localhost') + 500000) % 1000000).padStart(6, '0');
await input.fill(wrong);
r = await Promise.all([page.waitForNavigation(), page.click('button[type=submit]')]).then(([n]) => n);
check('a wrong code: 401 and the error line', r.status() === 401 && /wrong/.test(await page.locator('[role=alert]').textContent()));
if (process.env.SHOT) await page.screenshot({ path: join(process.env.SHOT, `twofa-${engine}-wrong.png`) });

const good = code('dev@localhost');
await page.locator('#code').fill(good);
await Promise.all([page.waitForURL(u => u.pathname === '/healthz'), page.click('button[type=submit]')]);
check('the right code redirects to rd', page.url() === DASH + '/healthz?arg=attach&arg=wt-a&v=3', page.url());
const ck = (await ctx.cookies(DASH)).find(c => c.name === 'mows_2fa');
check('mows_2fa set: HttpOnly, Lax, ~7 days, no Domain on loopback', ck && ck.httpOnly && ck.sameSite === 'Lax' && ck.expires * 1000 - Date.now() > 6.9 * 864e5 && !ck.domain.startsWith('.'), ck);
check('/2fa/auth with the cookie: 200', (await api.get(DASH + '/2fa/auth')).status() === 200);
check('the same cookie under another email: 401', (await api.get(DASH + '/2fa/auth', { headers: { 'x-auth-request-email': 'other@localhost' } })).status() === 401);
check('the same code again (replay): 401', (await post({ code: good, rd: '/' })).status() === 401);

const H = { 'x-auth-request-email': 'other@localhost' };
r = await post({ code: code('other@localhost'), rd: 'https://evil.example/' }, H);
check('an off-site rd lands on /', r.status() === 303 && r.headers().location === '/', r.headers().location);
check('a cross-site POST: 403', (await post({ code: '000000', rd: '/' }, { ...H, origin: 'https://evil.example' })).status() === 403);

const L = { 'x-auth-request-email': LOCK }, bogus = String((+code(LOCK) + 3) % 1000000).padStart(6, '0');
const st = [];
for (let i = 0; i < 6; i++) st.push((await post({ code: bogus, rd: '/' }, L)).status());
check('five misses lock the account: the sixth try is 429', st.join() === '401,401,401,401,401,429', st);
check('locked: even the right code is refused', (await post({ code: code(LOCK), rd: '/' }, L)).status() === 429);

await browser.close();
process.exit(bad ? 1 : 0);
