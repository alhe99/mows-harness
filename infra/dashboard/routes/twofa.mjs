// twofa.mjs — the second factor after Google sign-in (docs/superpowers/specs/2026-10-13-second-factor-design.md). Caddy's (gauth) asks
// GET /2fa/auth on every request after oauth2-proxy passed it: 200 with a valid mows_2fa cookie for the signed-in email, else 401 and a
// redirect to /2fa, where a TOTP code (RFC 6238, SHA-1, 30 s, 6 digits) mints the cookie. Secrets live in 2fa.json (0600), written only by
// the CLI: `node lite.mjs 2fa enroll|revoke|list [email]`. Stdlib only.
import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { BASE_CSP, SETTINGS_FILE, flag, readBody, sameOrigin, send } from '../core.mjs';

export const FILE = flag('--2fa-file', path.join(path.dirname(SETTINGS_FILE), '2fa.json'));
const TEST = process.env.MOWS_TEST_HOOKS === '1';
const STEP = 30_000, WIN = 300_000, TTL = 604_800; // TOTP step, lockout window, cookie lifetime (s)

// ---- RFC 4648 base32, no padding: what an authenticator app reads from an otpauth:// URI
const B32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
export function b32enc(buf) {
  let v = 0, bits = 0, out = '';
  for (const b of buf) { v = (v << 8 | b) & 4095; bits += 8; while (bits >= 5) { out += B32[v >>> (bits - 5) & 31]; bits -= 5; } }
  return bits ? out + B32[v << (5 - bits) & 31] : out;
}
export function b32dec(s) {
  let v = 0, bits = 0; const out = [];
  for (const c of s.replace(/[\s=]+/g, '').toUpperCase()) {
    const i = B32.indexOf(c); if (i < 0) throw new Error('not base32');
    v = (v << 5 | i) & 4095; bits += 5; if (bits >= 8) { out.push(v >>> (bits - 8) & 255); bits -= 8; }
  }
  return Buffer.from(out);
}

// ---- RFC 4226 HOTP; TOTP is hotp(key, floor(now / 30 s))
export function hotp(key, counter, digits = 6) {
  const c = Buffer.alloc(8); c.writeBigUInt64BE(BigInt(counter));
  const h = createHmac('sha1', key).update(c).digest(), o = h[h.length - 1] & 15;
  return String((h.readUInt32BE(o) & 0x7fffffff) % 10 ** digits).padStart(digits, '0');
}

// replay guard (last accepted step per email and secret: a re-enrolled app's first code is not refused) and lockout (5 misses in 5 min lock 5 min): in memory, a restart clears both
// ponytail: one process, one Map each; a second dashboard instance would need them in the secrets file
const lastStep = new Map(), misses = new Map();
export function verifyCode(email, secret, code, now = Date.now()) {
  if (!/^\d{6}$/.test(code)) return false;
  const key = b32dec(secret), t = Math.floor(now / STEP), id = `${email} ${secret}`, last = lastStep.get(id) ?? -Infinity;
  for (const s of [t - 1, t, t + 1]) {
    if (s > last && timingSafeEqual(Buffer.from(hotp(key, s)), Buffer.from(code))) { lastStep.set(id, s); misses.delete(email); return true; }
  }
  return false;
}
export function lockLeft(email, now = Date.now()) {
  const m = (misses.get(email) || []).filter(t => now - t < WIN);
  misses.set(email, m);
  return m.length >= 5 ? m[m.length - 1] + WIN - now : 0;
}
export const miss = (email, now = Date.now()) => misses.set(email, [...(misses.get(email) || []), now].slice(-5));

// ---- the cookie: <email>.<expiry unix>.<hmac-sha256 hex of "email.expiry">, keyed by the file's `key`. Parsed from the right: emails have dots.
const mac = (key, v) => createHmac('sha256', Buffer.from(key, 'hex')).update(v).digest('hex');
export const mint = (key, email, exp) => `${email}.${exp}.${mac(key, `${email}.${exp}`)}`;
export function cookieOk(key, value, email, now = Date.now()) {
  const i = value.lastIndexOf('.'), j = value.lastIndexOf('.', i - 1);
  if (!key || j < 1) return false;
  const want = Buffer.from(mac(key, value.slice(0, i))), got = Buffer.from(value.slice(i + 1));
  return got.length === want.length && timingSafeEqual(got, want) && +value.slice(j + 1, i) * 1000 > now && value.slice(0, j) === email;
}

// ---- the secrets file. Read on every check (a few hundred bytes; the CLI's writes apply without a restart). ENOENT is "nobody enrolled";
// anything else unreadable throws, and every caller turns a throw into a refusal (fail closed).
export function load(file = FILE) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch (e) { if (e.code === 'ENOENT') return { users: {} }; throw e; }
}
export function save(o, file = FILE) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(o, null, 1) + '\n', { mode: 0o600 });
  fs.chmodSync(file, 0o600);
}
let warned = 0;
const loadOrNull = () => { try { return load(); } catch (e) { if (Date.now() - warned > 60_000) { warned = Date.now(); console.error(`2fa: ${FILE} unreadable, refusing everyone (${e.message})`); } return null; } };

// ---- CLI, over SSH as root. Returns the exit code.
export function cli([cmd, who]) {
  const email = (who || '').toLowerCase(), o = load();
  o.users ||= {};
  if (cmd === 'list') { for (const [e, u] of Object.entries(o.users)) console.log(`${e}\tenrolled ${u.enrolledAt}`); return 0; }
  if (!/^[^\s@]+@[^\s@]+$/.test(email) || !['enroll', 'revoke'].includes(cmd)) { console.error('usage: lite.mjs 2fa enroll|revoke <email> | 2fa list [--2fa-file f]'); return 2; }
  if (cmd === 'revoke') {
    if (!o.users[email]) { console.error(`2fa: ${email} is not enrolled`); return 1; }
    delete o.users[email];
    o.key = randomBytes(32).toString('hex'); // every browser's second-factor cookie dies with the old key
    save(o);
    console.log(`2fa: ${email} revoked; every browser must pass the second factor again`);
    return 0;
  }
  o.key ||= randomBytes(32).toString('hex');
  const secret = b32enc(randomBytes(20));
  o.users[email] = { secret, enrolledAt: new Date().toISOString() };
  save(o);
  console.log(`secret: ${secret}\nuri:    otpauth://totp/mows:${encodeURIComponent(email)}?secret=${secret}&issuer=mows&algorithm=SHA1&digits=6&period=30`);
  return 0;
}

// ---- routes
// the email is the one Caddy copied from oauth2-proxy (the client's own copy is stripped in (gauth)); no header means no Caddy, which only a test instance may be
const emailOf = req => (req.headers['x-auth-request-email'] || (TEST ? 'dev@localhost' : '')).toLowerCase();
const cookieOf = req => (/(?:^|;\s*)mows_2fa=([^;]+)/.exec(req.headers.cookie || '') || [])[1] || '';
// The domain is the request's own host, with no config: Caddy sends every challenge to https://<apex>/2fa, so the page and its POST run on the
// apex, the cookie lands on .<apex>, and rd may return to any subdomain of it. A /2fa opened on a subdomain just scopes all three to that one.
const hostOf = req => /^[a-z0-9.-]+(?=:\d+$|$)/i.exec(req.headers.host || '')?.[0].toLowerCase() || '';
const under = (h, base) => h === base || h.endsWith('.' + base);
// rd: back to where the user started, only under `base` over https (or a same-origin path); anything else lands on /
export function safeRd(rd, base) {
  if (/^\/(?![/\\])/.test(rd)) return rd;
  try { const u = new URL(rd); return u.protocol === 'https:' && base && under(u.hostname, base) ? u.href : '/'; } catch { return '/'; }
}
const esc = s => String(s).replace(/[&<>"']/g, c => `&#${c.charCodeAt(0)};`);
// the redirect after the POST may cross to another subdomain, and Chrome holds that redirect to form-action
const csp = base => base ? BASE_CSP.replace("form-action 'self'", `form-action 'self' https://${base} https://*.${base}`) : BASE_CSP;

function page(req, res, status, { email, rd = '', err = '', form = true }) {
  send(req, res, status, `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="theme-color" content="#09090b"><title>Verify | mows</title><style>
:root{color-scheme:dark}*{box-sizing:border-box}
body{margin:0;min-height:100vh;display:grid;place-items:center;padding:16px;background:#09090b;color:#f4f4f5;font:15px/1.5 -apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif}
main{width:100%;max-width:340px;background:#18181b;border:1px solid rgba(39,39,42,.8);border-radius:10px;padding:24px}
h1{margin:0 0 4px;font-size:18px;font-weight:600;color:#e4e4e7}p{margin:0 0 16px;color:#9f9fa9;font-size:13px}
label{display:block;margin-bottom:6px;color:#d4d4d8;font-size:13px}
input{width:100%;height:48px;padding:0 12px;background:#09090b;color:#f4f4f5;border:1px solid #3f3f47;border-radius:10px;font:600 24px ui-monospace,monospace;letter-spacing:.3em;text-align:center}
input:focus{outline:2px solid rgba(161,161,170,.8);outline-offset:1px}
button{width:100%;height:44px;margin-top:12px;background:#00d492;color:#09090b;border:0;border-radius:10px;font-weight:600;font-size:15px;font-family:inherit;cursor:pointer}
button:focus-visible{outline:2px solid #f4f4f5;outline-offset:2px}
.err{margin:12px 0 0;color:#ff6467;font-size:13px}code{color:#d4d4d8}
</style></head><body><main><h1>Two-step verification</h1><p>${esc(email || 'no signed-in account')}</p>
${form ? `<form method="post" action="/2fa"><label for="code">Code from your authenticator app</label>
<input id="code" name="code" inputmode="numeric" autocomplete="one-time-code" pattern="[0-9]{6}" maxlength="6" required autofocus>
<input type="hidden" name="rd" value="${esc(rd)}"><button type="submit">Verify</button></form>` : ''}
${err ? `<p class="err" role="alert">${err}</p>` : ''}</main></body></html>`, undefined, { 'content-security-policy': csp(hostOf(req)), 'cache-control': 'no-store' });
}

export async function twofaView(req, res, url) {
  const email = emailOf(req), o = loadOrNull();
  if (url.pathname === '/2fa/auth') {
    const ok = !!(email && o?.users?.[email] && cookieOk(o.key, cookieOf(req), email));
    res.writeHead(ok ? 200 : 401, { 'cache-control': 'no-store' });
    return res.end();
  }
  if (url.pathname !== '/2fa') return page(req, res, 404, { email, form: false, err: 'Not found.' });
  if (!email) return page(req, res, 401, { email, form: false, err: 'Sign in with Google first.' });
  if (!o) return page(req, res, 503, { email, form: false, err: 'The second factor is unavailable. Check the dashboard log on the box.' });
  const user = o.users?.[email];
  if (!user) return page(req, res, 403, { email, form: false, err: 'Not enrolled. On the box, run <code>2fa enroll</code> for this account.' });
  // Caddy writes rd={scheme}://{host}{uri} unescaped, so a /term/?arg=..&arg=.. target spans every & after it: take the query raw
  if (req.method !== 'POST') return page(req, res, 200, { email, rd: url.search.startsWith('?rd=') ? url.search.slice(4) : '' });
  if (!sameOrigin(req, req.headers.host)) return page(req, res, 403, { email, form: false, err: 'Cross-site request refused.' });
  const b = await readBody(req), rd = b.rd || '', left = lockLeft(email);
  if (left) return page(req, res, 429, { email, rd, err: `Too many wrong codes. Try again in ${Math.ceil(left / 60_000)} min.` });
  if (!verifyCode(email, user.secret, (b.code || '').trim())) { miss(email); return page(req, res, 401, { email, rd, err: 'That code is wrong or already used.' }); }
  const base = hostOf(req), tls = req.headers['x-forwarded-proto'] === 'https'; // Caddy sets the header; a loopback test instance is plain http
  res.writeHead(303, {
    location: safeRd(rd, base), 'cache-control': 'no-store',
    // Domain only behind Caddy over https: a test instance on 127.0.0.1 gets a host-only cookie without Secure
    'set-cookie': `mows_2fa=${mint(o.key, email, Math.floor(Date.now() / 1000) + TTL)}; Path=/; Max-Age=${TTL}; HttpOnly; SameSite=Lax${tls ? `; Secure; Domain=.${base}` : ''}`,
  });
  res.end();
}
