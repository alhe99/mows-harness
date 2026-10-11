// webpush.mjs — Web Push on node:crypto and nothing else (K-37; ledger O-4): RFC 8291 message encryption (aes128gcm, RFC 8188 framing) and
// RFC 8292 VAPID, plus the key pair and the subscription store, both kept next to settings.json. No npm package reaches the box. Imports node: only,
// so scripts/push-check.mjs can load it without booting the dashboard.
import { createECDH, createHash, createPrivateKey, hkdfSync, randomBytes, createCipheriv, sign } from 'node:crypto';
import { promises as fsp } from 'node:fs';
import path from 'node:path';

const b64u = b => Buffer.from(b).toString('base64url');
const u32 = n => { const b = Buffer.alloc(4); b.writeUInt32BE(n); return b; };

/** RFC 8291 section 3: the body of a push message for one subscription ({ p256dh, auth }, both base64url). `plain` is a Buffer of at most 3993 bytes. */
export function encryptPush({ p256dh, auth }, plain) {
  const ua = Buffer.from(p256dh, 'base64url'), authSecret = Buffer.from(auth, 'base64url');
  if (ua.length !== 65 || ua[0] !== 4 || authSecret.length !== 16) throw new Error('bad subscription keys');
  if (plain.length > 3993) throw new Error('payload too large'); // one record of 4096 - 86 header bytes - 1 delimiter - 16 tag
  const eph = createECDH('prime256v1'), salt = randomBytes(16);
  const as = eph.generateKeys();
  // IKM = HKDF(auth_secret, ecdh_secret, "WebPush: info" 0 ua as, 32); then CEK and NONCE from HKDF(salt, IKM, ...) (node's hkdfSync = extract + expand)
  const ikm = hkdfSync('sha256', eph.computeSecret(ua), authSecret, Buffer.concat([Buffer.from('WebPush: info\0'), ua, as]), 32);
  const cek = Buffer.from(hkdfSync('sha256', ikm, salt, 'Content-Encoding: aes128gcm\0', 16));
  const nonce = Buffer.from(hkdfSync('sha256', ikm, salt, 'Content-Encoding: nonce\0', 12));
  const c = createCipheriv('aes-128-gcm', cek, nonce);
  const body = Buffer.concat([c.update(Buffer.concat([plain, Buffer.from([2])])), c.final(), c.getAuthTag()]); // 0x02: the last record's delimiter
  return Buffer.concat([salt, u32(4096), Buffer.from([as.length]), as, body]);
}

/** RFC 8292: the Authorization header for a push service endpoint. `vapid` is { privateJwk, publicKey } from loadVapid(). */
export function vapidAuth(endpoint, vapid, subject, now = Date.now()) {
  const seg = o => b64u(JSON.stringify(o));
  const data = `${seg({ typ: 'JWT', alg: 'ES256' })}.${seg({ aud: new URL(endpoint).origin, exp: Math.floor(now / 1000) + 12 * 3600, sub: subject })}`;
  const sig = sign('sha256', Buffer.from(data), { key: createPrivateKey({ key: vapid.privateJwk, format: 'jwk' }), dsaEncoding: 'ieee-p1363' });
  return `vapid t=${data}.${b64u(sig)}, k=${vapid.publicKey}`;
}

// ---- the settings directory: vapid.json (the key pair, generated once) and push-subs.json ------------------------------------------------
// Persisting is best effort (a dev instance may not own the directory): the state then lives for the process, which is all a dev instance needs.
let dir = '', vapid = null, subs = null;
export const pushDir = d => { dir = d; };
const read = f => fsp.readFile(path.join(dir, f), 'utf8').then(JSON.parse, () => null);
const write = async (f, o) => { try { await fsp.mkdir(dir, { recursive: true }); await fsp.writeFile(path.join(dir, f), JSON.stringify(o) + '\n', { mode: 0o600 }); } catch (e) { console.warn(`push: ${f} not saved (${e.code || e.message})`); } };

export function loadVapid() {
  return vapid ||= (async () => {
    const saved = await read('vapid.json');
    if (saved?.privateJwk && saved.publicKey) return saved;
    const e = createECDH('prime256v1'); e.generateKeys();
    const v = { publicKey: b64u(e.getPublicKey()), privateJwk: { kty: 'EC', crv: 'P-256', d: b64u(e.getPrivateKey()), x: b64u(e.getPublicKey().subarray(1, 33)), y: b64u(e.getPublicKey().subarray(33)) } };
    await write('vapid.json', v);
    return v;
  })();
}

const loadSubs = () => subs ||= read('push-subs.json').then(o => new Map(Object.entries(o || {})));
export const subId = endpoint => createHash('sha256').update(endpoint).digest('hex').slice(0, 16);
export async function addSub(sub) { const m = await loadSubs(), id = subId(sub.endpoint); m.set(id, sub); await write('push-subs.json', Object.fromEntries(m)); return id; }
export async function dropSub(id) { const m = await loadSubs(); if (m.delete(id)) await write('push-subs.json', Object.fromEntries(m)); return m.size; }
export const subCount = async () => (await loadSubs()).size;

/** Send one declarative payload ({ web_push: 8030, notification, app_badge }) to every subscription; an endpoint the push service has forgotten
 *  (404, 410) is dropped. Resolves with how many were accepted. */
export async function pushAll(payload, send = fetch) {
  const m = await loadSubs();
  if (!m.size) return 0;
  const v = await loadVapid(), body = encryptPushFor(payload);
  let ok = 0;
  await Promise.all([...m].map(async ([id, s]) => {
    try {
      const r = await send(s.endpoint, { method: 'POST', body: body(s.keys), signal: AbortSignal.timeout(10000), headers: {
        authorization: vapidAuth(s.endpoint, v, process.env.VAPID_SUBJECT || `https://${s.host || 'localhost'}`), 'content-encoding': 'aes128gcm',
        'content-type': 'application/octet-stream', ttl: '3600', urgency: 'high' } });
      if (r.status === 404 || r.status === 410) await dropSub(id); else if (r.ok) ok++;
    } catch { /* an unreachable push service is retried at the next transition */ }
  }));
  return ok;
}
const encryptPushFor = payload => { const plain = Buffer.from(JSON.stringify(payload)); return keys => encryptPush(keys, plain); };
