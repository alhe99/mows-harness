// push.mjs — GET /api/push/key and POST|DELETE /api/push/subscribe (contract.d.ts push section; K-37). The cryptography, the key pair and the
// subscription store are webpush.mjs's; the sender that watches for a session needing you is sse.mjs's.
import path from 'node:path';
import { SETTINGS_FILE, sameOrigin, sendJson } from '../core.mjs';
import { addSub, dropSub, loadVapid, pushDir, subCount } from './webpush.mjs';

pushDir(path.dirname(SETTINGS_FILE));

const MAX_BODY = 4096, MAX_SUBS = 50;
const decoded = (s, n) => typeof s === 'string' && /^[A-Za-z0-9_-]+$/.test(s) && Buffer.from(s, 'base64url').length === n;

// a JSON body of at most MAX_BODY bytes, or null (the caller answers 413 / 400)
async function jsonBody(req) {
  let n = 0; const parts = [];
  for await (const c of req) { n += c.length; if (n > MAX_BODY) return null; parts.push(c); }
  try { return JSON.parse(Buffer.concat(parts).toString('utf8')); } catch { return null; }
}

// an https endpoint on one of the browsers' push services: the server will POST to whatever is stored here, so the host is an
// allowlist (exact, or a subdomain of a dotted entry), not just "some public hostname" — no loopback, LAN or metadata targets
const PUSH_HOSTS = ['fcm.googleapis.com', 'updates.push.services.mozilla.com', 'web.push.apple.com', '.notify.windows.com', '.push.apple.com', '.push.services.mozilla.com'];
function endpointOk(e) {
  try {
    const u = new URL(e), h = u.hostname.toLowerCase().replace(/\.$/, '');
    return u.protocol === 'https:' && e.length <= 2048 && !u.username && !u.password && !u.port
      && PUSH_HOSTS.some(a => a.startsWith('.') ? h.endsWith(a) : h === a);
  } catch { return false; }
}

export async function pushView(req, res, what) {
  const fail = (code, msg) => { res.writeHead(code, { 'content-type': 'text/plain; charset=utf-8' }); res.end(msg); };
  if (what === 'key') {
    if (req.method !== 'GET') return fail(405, 'GET only');
    return sendJson(req, res, 200, { key: (await loadVapid()).publicKey });
  }
  if (what !== 'subscribe') return fail(404, '');
  if (req.method !== 'POST' && req.method !== 'DELETE') return fail(405, 'POST or DELETE only');
  if (!sameOrigin(req, req.headers.host || '')) return fail(403, 'bad origin');
  if (!/^application\/json\b/i.test(req.headers['content-type'] || '')) return fail(415, 'application/json only');
  const b = await jsonBody(req);
  if (b == null || typeof b !== 'object') return fail(400, 'bad body (JSON, at most 4096 bytes)');
  if (req.method === 'DELETE') {
    if (typeof b.id !== 'string' || !/^[0-9a-f]{16}$/.test(b.id)) return fail(400, 'bad id');
    await dropSub(b.id);
    return sendJson(req, res, 200, { ok: true, id: b.id });
  }
  if (!endpointOk(b.endpoint) || !decoded(b.keys?.p256dh, 65) || !decoded(b.keys?.auth, 16)) return fail(400, 'bad subscription');
  if (await subCount() >= MAX_SUBS) return fail(429, 'too many subscriptions');
  const id = await addSub({ endpoint: b.endpoint, keys: { p256dh: b.keys.p256dh, auth: b.keys.auth }, expirationTime: b.expirationTime ?? null, host: req.headers.host || '', at: Date.now() });
  return sendJson(req, res, 200, { ok: true, id });
}
