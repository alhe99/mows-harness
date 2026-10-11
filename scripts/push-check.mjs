#!/usr/bin/env node
// push-check.mjs — the Web Push implementation (infra/dashboard/routes/webpush.mjs; K-37) against an independent one: WebCrypto. No browser, no server.
//   node scripts/push-check.mjs
// A message is encrypted to a freshly generated subscription key (RFC 8291, aes128gcm) and decrypted here with crypto.subtle, which shares no code
// with node:crypto's HKDF/ECDH calls the sender uses; the VAPID header (RFC 8292) is parsed and its ES256 signature verified with crypto.subtle; the key
// pair is generated once and written 0600; the sender posts the headers a push service needs and forgets an endpoint that answers 410.
import { mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { addSub, encryptPush, loadVapid, pushAll, pushDir, subCount, vapidAuth } from '../infra/dashboard/routes/webpush.mjs';

const { subtle } = globalThis.crypto;
let bad = 0;
const ok = (name, c, detail) => { if (!c) bad++; console.log(`${c ? 'PASS' : 'FAIL'} ${name}${c || detail === undefined ? '' : ' ' + JSON.stringify(detail)}`); };
const b64 = b => Buffer.from(b).toString('base64url');
const hkdf = async (ikm, salt, info, bytes) => subtle.deriveBits({ name: 'HKDF', hash: 'SHA-256', salt, info }, await subtle.importKey('raw', ikm, 'HKDF', false, ['deriveBits']), bytes * 8);

// the user agent's side: a subscription key pair and auth secret, then RFC 8291 section 4 decryption
const ua = await subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveBits']);
const uaPub = Buffer.from(await subtle.exportKey('raw', ua.publicKey));
const auth = globalThis.crypto.getRandomValues(new Uint8Array(16));
const sub = { p256dh: b64(uaPub), auth: b64(auth) };
async function decrypt(msg, authSecret = auth) {
  const salt = msg.subarray(0, 16), rs = msg.readUInt32BE(16), idlen = msg[20], as = msg.subarray(21, 21 + idlen), cipher = msg.subarray(21 + idlen);
  const secret = await subtle.deriveBits({ name: 'ECDH', public: await subtle.importKey('raw', as, { name: 'ECDH', namedCurve: 'P-256' }, false, []) }, ua.privateKey, 256);
  const ikm = await hkdf(secret, authSecret, Buffer.concat([Buffer.from('WebPush: info\0'), uaPub, as]), 32);
  const cek = await hkdf(ikm, salt, Buffer.from('Content-Encoding: aes128gcm\0'), 16), nonce = await hkdf(ikm, salt, Buffer.from('Content-Encoding: nonce\0'), 12);
  const key = await subtle.importKey('raw', cek, 'AES-GCM', false, ['decrypt']);
  const plain = Buffer.from(await subtle.decrypt({ name: 'AES-GCM', iv: nonce }, key, cipher));
  return { rs, idlen, plain: plain.subarray(0, plain.lastIndexOf(2)), delim: plain[plain.lastIndexOf(2)] };
}

const payload = { web_push: 8030, notification: { title: 'cc-demo needs you', body: 'Do you want to proceed? — é中', navigate: '/', tag: 'aaaa1111' }, app_badge: 2 };
const msg = encryptPush(sub, Buffer.from(JSON.stringify(payload)));
const d = await decrypt(msg);
ok('1 the message decrypts with WebCrypto to the exact payload', JSON.stringify(JSON.parse(d.plain.toString())) === JSON.stringify(payload) && d.delim === 2);
ok('2 the header is the RFC 8188 one: record size 4096, a 65-byte uncompressed key id', d.rs === 4096 && d.idlen === 65 && msg[21] === 4 && msg.length < 4096);
ok('3 two messages differ (fresh salt and ephemeral key each time)', !encryptPush(sub, Buffer.from('x')).equals(encryptPush(sub, Buffer.from('x'))));
ok('4 a wrong auth secret does not decrypt', await decrypt(msg, globalThis.crypto.getRandomValues(new Uint8Array(16))).then(() => false, () => true));
ok('5 the largest allowed payload fits one 4096-byte message', encryptPush(sub, Buffer.alloc(3993, 97)).length === 4096);
ok('6 an oversize payload is refused', (() => { try { encryptPush(sub, Buffer.alloc(3994)); return false; } catch { return true; } })());
ok('7 malformed keys are refused', (() => { try { encryptPush({ p256dh: 'AAAA', auth: sub.auth }, Buffer.from('x')); return false; } catch { return true; } })());

const tmp = mkdtempSync(join(tmpdir(), 'push-check-'));
try {
  pushDir(tmp);
  const v = await loadVapid(), saved = JSON.parse(readFileSync(join(tmp, 'vapid.json'), 'utf8'));
  ok('8 the VAPID pair is generated once and written 0600 next to the settings', saved.publicKey === v.publicKey && (statSync(join(tmp, 'vapid.json')).mode & 0o777) === 0o600);
  ok('9 the public key is a 65-byte uncompressed point, base64url', Buffer.from(v.publicKey, 'base64url').length === 65 && Buffer.from(v.publicKey, 'base64url')[0] === 4 && !/[=+/]/.test(v.publicKey));

  const now = Date.now(), h = vapidAuth('https://push.example.test/send/abc', v, 'https://dash.example.test', now);
  const m = /^vapid t=([\w-]+)\.([\w-]+)\.([\w-]+), k=([\w-]+)$/.exec(h);
  const claims = m && JSON.parse(Buffer.from(m[2], 'base64url').toString()), head = m && JSON.parse(Buffer.from(m[1], 'base64url').toString());
  ok('10 Authorization is `vapid t=<jwt>, k=<key>` with ES256 and the push service origin as aud', !!m && head.alg === 'ES256' && claims.aud === 'https://push.example.test' && m[4] === v.publicKey && claims.sub === 'https://dash.example.test', h);
  ok('11 exp is in the future and within the 24 h RFC 8292 allows', claims.exp * 1000 > now && claims.exp * 1000 - now <= 24 * 3600e3);
  const pub = await subtle.importKey('raw', Buffer.from(v.publicKey, 'base64url'), { name: 'ECDSA', namedCurve: 'P-256' }, false, ['verify']);
  ok('12 the signature verifies with WebCrypto (raw r||s)', await subtle.verify({ name: 'ECDSA', hash: 'SHA-256' }, pub, Buffer.from(m[3], 'base64url'), Buffer.from(`${m[1]}.${m[2]}`)));
  ok('13 a tampered claim does not verify', !(await subtle.verify({ name: 'ECDSA', hash: 'SHA-256' }, pub, Buffer.from(m[3], 'base64url'), Buffer.from(`${m[1]}.${b64('{"aud":"https://evil.example.test"}')}`))));

  await addSub({ endpoint: 'https://push.example.test/send/abc', keys: sub, host: 'dash.example.test' });
  const calls = [];
  let status = 201;
  const send = async (url, o) => { calls.push({ url, o }); return { ok: status < 300, status }; };
  const n = await pushAll(payload, send), c = calls[0];
  ok('14 pushAll posts to the endpoint with the push headers and a body WebCrypto decrypts', n === 1 && c.url === 'https://push.example.test/send/abc' && c.o.method === 'POST'
    && c.o.headers['content-encoding'] === 'aes128gcm' && c.o.headers.ttl === '3600' && /^vapid t=/.test(c.o.headers.authorization) && JSON.parse((await decrypt(c.o.body)).plain.toString()).app_badge === 2);
  status = 410;
  await pushAll(payload, send);
  ok('15 an endpoint the push service answers 410 for is forgotten', (await subCount()) === 0);
  ok('16 with no subscription nothing is sent', (calls.length = 0, await pushAll(payload, send)) === 0 && calls.length === 0);
} finally { rmSync(tmp, { recursive: true, force: true }); }
console.log(bad ? `push-check: ${bad} FAILED` : 'push-check: all passed');
process.exit(bad ? 1 : 0);
