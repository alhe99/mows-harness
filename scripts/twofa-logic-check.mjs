#!/usr/bin/env node
// twofa-logic-check.mjs — the second factor's pure logic (infra/dashboard/routes/twofa.mjs): TOTP against the RFC 6238 SHA-1 vectors,
// base32 against RFC 4648, the cookie (mint, tamper, expiry, cross-email), the ±1 step window, replay, lockout, the rd allowlist.
import { b32dec, b32enc, cookieOk, hotp, lockLeft, mint, miss, safeRd, verifyCode } from '../infra/dashboard/routes/twofa.mjs';
let bad = 0;
const ok = (name, cond) => { console.log(`${cond ? 'PASS' : 'FAIL'} ${name}`); if (!cond) bad++; };

// RFC 6238 appendix B, SHA-1 rows: seed "12345678901234567890", 8 digits
const seed = Buffer.from('12345678901234567890');
for (const [t, want] of [[59, '94287082'], [1111111109, '07081804'], [1111111111, '14050471'], [1234567890, '89005924'], [2000000000, '69279037'], [20000000000, '65353130']])
  ok(`rfc6238 T=${t}`, hotp(seed, Math.floor(t / 30), 8) === want);
// RFC 4226 appendix D: 6 digits, counters 0 and 9
ok('rfc4226 count 0', hotp(seed, 0) === '755224');
ok('rfc4226 count 9', hotp(seed, 9) === '520489');

// RFC 4648 section 10 vectors, padding stripped
for (const [plain, enc] of [['f', 'MY'], ['fo', 'MZXQ'], ['foo', 'MZXW6'], ['foob', 'MZXW6YQ'], ['fooba', 'MZXW6YTB'], ['foobar', 'MZXW6YTBOI']]) {
  ok(`base32 ${plain}`, b32enc(Buffer.from(plain)) === enc && b32dec(enc).toString() === plain);
}
const rnd = Buffer.from(Array.from({ length: 20 }, (_, i) => i * 37 & 255));
ok('base32 round-trip 20 bytes, lower case and spaces accepted', b32dec(b32enc(rnd).toLowerCase().replace(/(.{4})/g, '$1 ')).equals(rnd));

// cookie
const key = 'ab'.repeat(32), now = 1_800_000_000_000, exp = now / 1000 + 3600, c = mint(key, 'a.b@x.io', exp);
ok('cookie verifies for its email', cookieOk(key, c, 'a.b@x.io', now));
ok('cookie refused for another email', !cookieOk(key, c, 'evil@x.io', now));
ok('cookie refused once expired', !cookieOk(key, c, 'a.b@x.io', exp * 1000 + 1));
ok('cookie refused under a rotated key', !cookieOk('cd'.repeat(32), c, 'a.b@x.io', now));
ok('cookie refused with the expiry edited', !cookieOk(key, c.replace(`.${exp}.`, `.${exp + 999999}.`), 'a.b@x.io', now));
ok('cookie refused with the email edited', !cookieOk(key, 'evil@x.io' + c.slice('a.b@x.io'.length), 'evil@x.io', now));
ok('cookie refused: empty, garbage, no key', !cookieOk(key, '', 'a.b@x.io', now) && !cookieOk(key, 'x.y', 'a.b@x.io', now) && !cookieOk(undefined, c, 'a.b@x.io', now));

// codes: window, replay, format
const secret = b32enc(rnd), k = b32dec(secret), T = 1_800_000_000_000, step = Math.floor(T / 30000);
ok('code of the current step accepted', verifyCode('w@x', secret, hotp(k, step), T));
ok('the same code refused a second time (replay)', !verifyCode('w@x', secret, hotp(k, step), T));
ok('an older step refused after a newer one was used', !verifyCode('w@x', secret, hotp(k, step - 1), T));
ok('next step (+30 s drift) accepted', verifyCode('d@x', secret, hotp(k, step + 1), T));
ok('previous step (-30 s drift) accepted', verifyCode('e@x', secret, hotp(k, step - 1), T));
ok('two steps off refused', !verifyCode('f@x', secret, hotp(k, step + 2), T) && !verifyCode('f@x', secret, hotp(k, step - 2), T));
ok('non-6-digit input refused', !verifyCode('g@x', secret, '12345', T) && !verifyCode('g@x', secret, 'abcdef', T) && !verifyCode('g@x', secret, hotp(k, step) + '0', T));
ok('replay state is per email', verifyCode('h@x', secret, hotp(k, step), T));
const fresh = b32enc(Buffer.from(rnd).reverse());
ok('a re-enrolled secret starts a fresh replay window', verifyCode('w@x', fresh, hotp(b32dec(fresh), step), T));

// lockout: 5 misses within 5 minutes lock 5 minutes, then clear
for (let i = 0; i < 4; i++) miss('l@x', T + i * 1000);
ok('four misses: not locked', lockLeft('l@x', T + 5000) === 0);
miss('l@x', T + 5000);
ok('fifth miss: locked about 5 min', lockLeft('l@x', T + 6000) > 290_000);
ok('still locked at 4 min', lockLeft('l@x', T + 5000 + 240_000) > 0);
ok('unlocked after 5 min', lockLeft('l@x', T + 5000 + 300_001) === 0);
ok('lockout is per email', lockLeft('m@x', T + 6000) === 0);

// rd: only the request's own domain over https, or a same-origin path
ok('rd subdomain kept', safeRd('https://sandbox.example.com/x?y=1', 'example.com') === 'https://sandbox.example.com/x?y=1');
ok('rd apex kept', safeRd('https://example.com/', 'example.com') === 'https://example.com/');
ok('rd path kept', safeRd('/term/?a=1', 'example.com') === '/term/?a=1');
for (const r of ['https://evil.com/', 'https://example.com.evil.com/', 'https://evilexample.com/', 'http://example.com/', '//evil.com', '/\\evil.com', 'javascript:alert(1)', ''])
  ok(`rd refused: ${JSON.stringify(r)}`, safeRd(r, 'example.com') === '/');
ok('rd refused when the request had no usable host', safeRd('https://example.com/', '') === '/');

process.exit(bad ? 1 : 0);
